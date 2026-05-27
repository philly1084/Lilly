'use strict';

const { config } = require('../config');
const settingsController = require('../routes/admin/settings.controller');
const { parseLenientJson } = require('../utils/lenient-json');

const DEFAULT_REMOTE_CODE_MODEL = '';
const DEFAULT_AGENT_RUN_TIMEOUT_MS = 180000;
const DEFAULT_MAX_STATUS_POLLS = 90;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function sleep(ms = 0) {
  const delay = Number(ms) || 0;
  return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

class RemoteCliAgentRunTimeoutError extends Error {
  constructor(timeoutMs = DEFAULT_AGENT_RUN_TIMEOUT_MS) {
    super(`remote-cli-agent inner model run timed out after ${timeoutMs}ms.`);
    this.name = 'RemoteCliAgentRunTimeoutError';
    this.code = 'REMOTE_CLI_AGENT_RUN_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function isRemoteCliAgentRunTimeoutError(error = null) {
  return error?.name === 'RemoteCliAgentRunTimeoutError'
    || error?.code === 'REMOTE_CLI_AGENT_RUN_TIMEOUT';
}

async function withTimeout(promise, timeoutMs = DEFAULT_AGENT_RUN_TIMEOUT_MS) {
  const normalizedTimeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_AGENT_RUN_TIMEOUT_MS, {
    min: 1,
    max: 900000,
  });
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new RemoteCliAgentRunTimeoutError(normalizedTimeoutMs)), normalizedTimeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function normalizeKey(value = '') {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function normalizeToolName(value = '') {
  const key = normalizeKey(value);
  if (key === 'remotecoderun') {
    return 'remote_code_run';
  }
  if (key === 'remotecodestatus') {
    return 'remote_code_status';
  }
  return normalizeText(value);
}

function normalizeLeakedPath(value = '') {
  const normalized = normalizeText(value);
  if (!normalized || !/[\\/]/.test(normalized)) {
    return normalized;
  }

  return normalized
    .replace(/\s*([\\/])\s*/g, '$1')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '');
}

function buildLooseJsonKeyPattern(key = '') {
  const token = normalizeKey(key);
  return token
    .split('')
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_]*');
}

function decodeLooseJsonString(value = '') {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(["'\\/bfnrt])/g, '$1')
    .replace(/\\u([0-9a-f]{4})/gi, (_all, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function extractLooseJsonStringField(source = '', keys = []) {
  const text = String(source || '');
  for (const key of keys) {
    const pattern = buildLooseJsonKeyPattern(key);
    if (!pattern) {
      continue;
    }
    const match = text.match(new RegExp(`["']\\s*${pattern}\\s*["']\\s*:\\s*["']([\\s\\S]*?)["']`, 'i'));
    if (match?.[1] !== undefined) {
      return decodeLooseJsonString(match[1]);
    }
  }
  return undefined;
}

function extractLooseJsonNumberField(source = '', keys = []) {
  const text = String(source || '');
  for (const key of keys) {
    const pattern = buildLooseJsonKeyPattern(key);
    if (!pattern) {
      continue;
    }
    const match = text.match(new RegExp(`["']\\s*${pattern}\\s*["']\\s*:\\s*([0-9][0-9\\s_]*)`, 'i'));
    if (match?.[1]) {
      return match[1].replace(/[^0-9]/g, '');
    }
  }
  return undefined;
}

function getValueByNormalizedKey(source = {}, keys = []) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }

  const wanted = new Set(keys.map((key) => normalizeKey(key)));
  for (const [key, value] of Object.entries(source)) {
    if (wanted.has(normalizeKey(key))) {
      return value;
    }
  }
  return undefined;
}

function maskSecretValue(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length <= 8) {
    return '[set]';
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function trimTrailingSlash(value = '') {
  return normalizeText(value).replace(/\/+$/, '');
}

function cleanMarkerValue(value = '') {
  return normalizeText(value)
    .replace(/^`+|`+$/g, '')
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '');
}

function isPublicGitProviderHost(value = '') {
  const normalized = normalizeText(value).toLowerCase();
  return [
    'github.com',
    'ssh.github.com',
    'gist.github.com',
    'gitlab.com',
    'bitbucket.org',
  ].includes(normalized);
}

function isUnsafeRemoteCliTargetId(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  if (/^https?:\/\//i.test(normalized) || /^ssh:\/\//i.test(normalized) || /\.git(?:[#?].*)?$/i.test(normalized)) {
    return true;
  }

  const sshStyleMatch = normalized.match(/^(?:[^@\s]+@)?(?<host>[a-z0-9.-]+\.[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5})?$/i);
  if (sshStyleMatch?.groups?.host) {
    return normalized.includes('@')
      || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(sshStyleMatch.groups.host)
      || isPublicGitProviderHost(sshStyleMatch.groups.host);
  }

  return false;
}

function resolveRemoteCliTargetId(value = '', fallback = 'prod') {
  const normalized = normalizeText(value);
  const fallbackCandidate = normalizeText(fallback);
  const safeFallback = fallbackCandidate && !isUnsafeRemoteCliTargetId(fallbackCandidate)
    ? fallbackCandidate
    : 'prod';
  if (!normalized || isUnsafeRemoteCliTargetId(normalized)) {
    return safeFallback;
  }

  return normalized;
}

function readMarkerLine(text = '', keys = []) {
  const keyPattern = keys
    .map((key) => String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (!keyPattern) {
    return '';
  }

  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:${keyPattern})\\s*[:=]\\s*(.+?)\\s*$`, 'i'));
    if (match?.[1]) {
      return cleanMarkerValue(match[1]);
    }
  }

  return '';
}

function readMarkerLines(text = '', keys = []) {
  const keyPattern = keys
    .map((key) => String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (!keyPattern) {
    return [];
  }

  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:${keyPattern})\\s*[:=]\\s*(.+?)\\s*$`, 'i'))?.[1] || '')
    .map((value) => cleanMarkerValue(value))
    .filter(Boolean);
}

function normalizeOptionalProofValue(value = '') {
  const normalized = cleanMarkerValue(value);
  if (/^(?:none|n\/a|na|not[_\s-]?available|not[_\s-]?applicable|unknown)$/i.test(normalized)) {
    return '';
  }
  return normalized;
}

function resolveCompletionStatus({ blocker = '', whatChanged = '', verifyResults = [], publicUrl = '', publicHost = '', uiCheckReport = '', gitCommit = '' } = {}) {
  if (normalizeOptionalProofValue(blocker)) {
    return 'blocked';
  }

  const hasVerification = verifyResults.length > 0 || Boolean(publicUrl || publicHost || uiCheckReport);
  const hasChangeEvidence = Boolean(whatChanged || gitCommit);
  if (hasChangeEvidence && hasVerification) {
    return 'complete';
  }
  if (hasChangeEvidence || hasVerification) {
    return 'partially_verified';
  }

  return 'unknown';
}

function extractRemoteCliRunMetadata(finalOutput = '') {
  const text = String(finalOutput || '');
  const sessionId = readMarkerLine(text, ['REMOTE_CLI_SESSION_ID', 'REMOTE_CODE_SESSION_ID'])
    || cleanMarkerValue(text.match(/remote\s+session\s*:\s*`?([^`\s]+)/i)?.[1] || '');
  const jobId = readMarkerLine(text, ['REMOTE_CLI_JOB_ID', 'REMOTE_CODE_JOB_ID', 'JOB_ID'])
    || cleanMarkerValue(text.match(/(?:job\s*id|jobId|job_id|runId|run_id)\s*[:=]\s*`?([a-z0-9_.:-]{3,128})/i)?.[1] || '');
  const workspace = readMarkerLine(text, ['WORKSPACE', 'REMOTE_WORKSPACE', 'CWD'])
    || cleanMarkerValue(text.match(/workspace\s*:\s*`?([^`\n]+)/i)?.[1] || '');
  const gitRepo = readMarkerLine(text, ['GIT_REPO', 'GIT_REMOTE', 'REPOSITORY'])
    || cleanMarkerValue(text.match(/(?:git\s+repo|repository)\s*:\s*`?([^`\n]+)/i)?.[1] || '');
  const gitCommit = readMarkerLine(text, ['GIT_COMMIT', 'COMMIT'])
    || cleanMarkerValue(text.match(/(?:git\s+commit|commit)\s*:\s*`?([a-f0-9]{7,40})/i)?.[1] || '');
  const deployment = readMarkerLine(text, ['DEPLOYMENT', 'K8S_DEPLOYMENT']);
  const publicHost = readMarkerLine(text, ['PUBLIC_HOST', 'HOST', 'URL'])
    || cleanMarkerValue(text.match(/https?:\/\/([^/\s`]+)/i)?.[1] || '');
  const publicUrl = normalizeOptionalProofValue(readMarkerLine(text, ['PUBLIC_URL', 'LIVE_URL']));
  const uiCheckReport = readMarkerLine(text, ['UI_CHECK_REPORT']);
  const uiScreenshots = Array.from(new Set(
    readMarkerLines(text, ['UI_SCREENSHOTS', 'UI_SCREENSHOT'])
      .flatMap((value) => value.split(','))
      .map((value) => cleanMarkerValue(value))
      .filter(Boolean),
  ));
  const whatChanged = normalizeOptionalProofValue(readMarkerLine(text, ['WHAT_CHANGED']));
  const verifyCommands = readMarkerLines(text, ['VERIFY_COMMANDS', 'VERIFY_COMMAND'])
    .map((value) => normalizeOptionalProofValue(value))
    .filter(Boolean);
  const verifyResults = readMarkerLines(text, ['VERIFY_RESULTS', 'VERIFY_RESULT'])
    .map((value) => normalizeOptionalProofValue(value))
    .filter(Boolean);
  const blocker = normalizeOptionalProofValue(
    readMarkerLine(text, ['BLOCKER', 'BLOCKED_BY'])
      || readMarkerLine(text, ['USER_INPUT_REQUIRED']),
  );
  const completionStatus = resolveCompletionStatus({
    blocker,
    whatChanged,
    verifyResults,
    publicUrl,
    publicHost,
    uiCheckReport,
    gitCommit,
  });

  return {
    ...(sessionId ? { sessionId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(workspace ? { workspace } : {}),
    ...(gitRepo ? { gitRepo } : {}),
    ...(gitCommit ? { gitCommit } : {}),
    ...(deployment ? { deployment } : {}),
    ...(publicHost ? { publicHost } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(uiCheckReport ? { uiCheckReport } : {}),
    ...(uiScreenshots.length > 0 ? { uiScreenshots } : {}),
    ...(whatChanged ? { whatChanged } : {}),
    ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
    ...(verifyResults.length > 0 ? { verifyResults } : {}),
    ...(blocker ? { blocker } : {}),
    completionStatus,
  };
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function normalizeMcpContentText(result = {}) {
  if (!result) {
    return '';
  }
  if (typeof result === 'string') {
    return result;
  }

  const contentEntries = Array.isArray(result)
    ? result
    : (Array.isArray(result.content) ? result.content : null);
  if (contentEntries) {
    return contentEntries
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (typeof entry?.text === 'string') {
          return entry.text;
        }
        return JSON.stringify(entry);
      })
      .filter(Boolean)
      .join('\n');
  }

  if (typeof result.text === 'string') {
    return result.text;
  }
  if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  }
  return JSON.stringify(result, null, 2);
}

function collectRemoteCodeStateCandidates(result = {}, text = '') {
  const candidates = [];
  const add = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      candidates.push(value);
    }
  };
  const addContentEntries = (value) => {
    const entries = Array.isArray(value)
      ? value
      : (Array.isArray(value?.content) ? value.content : []);
    for (const entry of entries) {
      add(entry);
      add(entry?.structuredContent);
      add(entry?.data);
      const entryText = typeof entry === 'string' ? entry : entry?.text;
      const parsedEntryText = typeof entryText === 'string' ? parseLenientJson(entryText) : null;
      add(parsedEntryText);
      add(parsedEntryText?.structuredContent);
      add(parsedEntryText?.data);
      add(parsedEntryText?.result);
    }
  };

  add(result);
  add(result?.structuredContent);
  add(result?.data);
  add(result?.result);
  addContentEntries(result);
  const parsedText = parseLenientJson(text);
  add(parsedText);
  add(parsedText?.structuredContent);
  add(parsedText?.data);
  add(parsedText?.result);
  addContentEntries(parsedText);

  return candidates;
}

function findNestedNormalizedValue(source = {}, keys = [], depth = 0) {
  if (!source || typeof source !== 'object' || depth > 4) {
    return undefined;
  }
  const direct = getValueByNormalizedKey(source, keys);
  if (direct !== undefined) {
    return direct;
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      const nested = findNestedNormalizedValue(value, keys, depth + 1);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

function collectRemoteCodeTextFragments(result = {}, text = '') {
  const fragments = [];
  const addText = (value) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      fragments.push(normalized);
    }
  };
  addText(text);
  for (const candidate of collectRemoteCodeStateCandidates(result, text)) {
    [
      'finalOutput',
      'final_output',
      'outputText',
      'output_text',
      'output',
      'stdout',
      'stderr',
      'text',
      'message',
      'result',
    ].forEach((key) => addText(candidate?.[key]));
  }
  return Array.from(new Set(fragments));
}

function extractRemoteCodeJobState(result = {}, textOverride = '') {
  const text = textOverride || normalizeMcpContentText(result);
  const candidates = collectRemoteCodeStateCandidates(result, text);
  const state = {};

  for (const candidate of candidates) {
    state.status = state.status || normalizeText(findNestedNormalizedValue(candidate, ['status', 'state', 'phase']));
    state.jobId = state.jobId || normalizeText(findNestedNormalizedValue(candidate, ['jobId', 'job_id', 'runId', 'run_id', 'id']));
    state.sessionId = state.sessionId || normalizeText(findNestedNormalizedValue(candidate, ['sessionId', 'session_id', 'remoteSessionId', 'remote_session_id']));
  }

  if (!state.status) {
    state.status = normalizeText(
      text.match(/(?:^|[\s,{])["']?(?:status|state|phase)["']?\s*[:=]\s*["']?([a-z_ -]{3,32})["']?/i)?.[1] || '',
    );
  }
  if (!state.jobId) {
    state.jobId = normalizeText(
      text.match(/(?:^|[\s,{])["']?(?:jobId|job_id|runId|run_id|id)["']?\s*[:=]\s*["']?([a-z0-9_.:-]{3,128})["']?/i)?.[1] || '',
    );
  }
  if (!state.sessionId) {
    state.sessionId = normalizeText(
      text.match(/(?:^|[\s,{])["']?(?:sessionId|session_id|remoteSessionId|remote_session_id)["']?\s*[:=]\s*["']?([a-z0-9_.:-]{3,128})["']?/i)?.[1] || '',
    );
  }

  return {
    status: normalizeText(state.status).toLowerCase().replace(/\s+/g, '_'),
    jobId: cleanMarkerValue(state.jobId),
    sessionId: cleanMarkerValue(state.sessionId),
  };
}

function attachRemoteCodeCallTracker(remoteCli = null) {
  const state = {
    sawRemoteCodeRun: false,
    sawRemoteCodeStatus: false,
    jobId: '',
    sessionId: '',
    status: '',
  };
  if (!remoteCli || typeof remoteCli.callTool !== 'function') {
    return state;
  }

  const originalCallTool = remoteCli.callTool.bind(remoteCli);
  remoteCli.callTool = async (name, args) => {
    const result = await originalCallTool(name, args);
    const toolName = normalizeToolName(name);
    if (toolName === 'remote_code_run' || toolName === 'remote_code_status') {
      state.sawRemoteCodeRun = state.sawRemoteCodeRun || toolName === 'remote_code_run';
      state.sawRemoteCodeStatus = state.sawRemoteCodeStatus || toolName === 'remote_code_status';
      const text = normalizeMcpContentText(result);
      const remoteState = extractRemoteCodeJobState(result, text);
      state.jobId = remoteState.jobId || state.jobId;
      state.sessionId = remoteState.sessionId || state.sessionId;
      state.status = remoteState.status || state.status;
    }
    return result;
  };

  return state;
}

function isRunningRemoteCodeStatus(status = '') {
  return /^(?:running|queued|pending|active|started|in_progress|in-progress|processing|working)$/.test(
    normalizeText(status).toLowerCase().replace(/\s+/g, '_'),
  );
}

function isFailedRemoteCodeStatus(status = '') {
  return /^(?:failed|failure|error|errored|blocked|cancelled|canceled|timeout|timed_out)$/.test(
    normalizeText(status).toLowerCase().replace(/\s+/g, '_'),
  );
}

function extractRawMcpToolCallsFromLooseText(finalOutput = '') {
  const text = String(finalOutput || '');
  const normalizedText = normalizeKey(text);
  const extractedName = normalizeToolName(extractLooseJsonStringField(text, ['name', 'toolName']) || '');
  const hasToolCallEnvelope = normalizedText.includes('toolcall')
    || normalizedText.includes('functioncall')
    || Boolean(extractedName);
  if (!hasToolCallEnvelope) {
    return [];
  }

  const name = extractedName === 'remote_code_run' || normalizedText.includes('remotecoderun')
    ? 'remote_code_run'
    : (extractedName === 'remote_code_status' || normalizedText.includes('remotecodestatus')
      ? 'remote_code_status'
      : '');
  if (!name) {
    return [];
  }

  const args = {};
  const targetId = extractLooseJsonStringField(text, ['targetId', 'target_id', 'target']);
  const cwd = extractLooseJsonStringField(text, ['cwd', 'workingDirectory', 'working_directory']);
  const waitMs = extractLooseJsonNumberField(text, ['waitMs', 'wait_ms']);
  const sessionId = extractLooseJsonStringField(text, ['sessionId', 'session_id', 'remoteSessionId', 'remote_session_id']);
  const jobId = extractLooseJsonStringField(text, ['jobId', 'job_id', 'runId', 'run_id', 'id']);
  const model = extractLooseJsonStringField(text, ['model']);

  if (targetId) {
    args.targetId = targetId;
  }
  if (cwd) {
    args.cwd = normalizeLeakedPath(cwd);
  }
  if (waitMs) {
    args.waitMs = waitMs;
  }
  if (sessionId) {
    args.sessionId = sessionId;
  }
  if (jobId) {
    args.jobId = jobId;
  }
  if (model) {
    args.model = model;
  }

  return [{ name, arguments: args }];
}

function normalizeRemoteCodeArguments(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }

  const normalized = {};
  const targetId = getValueByNormalizedKey(args, ['targetId', 'target_id', 'target']);
  const cwd = getValueByNormalizedKey(args, ['cwd', 'workingDirectory', 'working_directory']);
  const waitMs = getValueByNormalizedKey(args, ['waitMs', 'wait_ms']);
  const sessionId = getValueByNormalizedKey(args, ['sessionId', 'session_id', 'remoteSessionId', 'remote_session_id']);
  const jobId = getValueByNormalizedKey(args, ['jobId', 'job_id', 'runId', 'run_id', 'id']);
  const model = getValueByNormalizedKey(args, ['model']);

  if (targetId !== undefined) {
    normalized.targetId = normalizeText(targetId);
  }
  if (cwd !== undefined) {
    normalized.cwd = normalizeLeakedPath(cwd);
  }
  if (waitMs !== undefined) {
    normalized.waitMs = waitMs;
  }
  if (sessionId !== undefined) {
    normalized.sessionId = normalizeText(sessionId);
  }
  if (jobId !== undefined) {
    normalized.jobId = normalizeText(jobId);
  }
  if (model !== undefined) {
    normalized.model = normalizeText(model);
  }

  return normalized;
}

function extractRawMcpToolCalls(finalOutput = '') {
  const parsed = parseLenientJson(finalOutput);
  const calls = Array.isArray(parsed)
    ? parsed
    : (getValueByNormalizedKey(parsed, ['tool_calls', 'toolCalls', 'calls']) || []);
  const parsedCalls = (Array.isArray(calls) ? calls : [])
    .map((call) => {
      const functionShape = call?.function || {};
      const name = normalizeToolName(
        getValueByNormalizedKey(call, ['name'])
        || getValueByNormalizedKey(functionShape, ['name'])
        || '',
      );
      const rawArguments = getValueByNormalizedKey(call, ['arguments', 'args'])
        || getValueByNormalizedKey(functionShape, ['arguments', 'args'])
        || {};
      const args = typeof rawArguments === 'string'
        ? (parseLenientJson(rawArguments) || {})
        : rawArguments;
      return {
        name,
        arguments: normalizeRemoteCodeArguments(args),
      };
    })
    .filter((call) => call.name === 'remote_code_run' || call.name === 'remote_code_status');
  return parsedCalls.length > 0
    ? parsedCalls
    : extractRawMcpToolCallsFromLooseText(finalOutput);
}

function buildRemoteCodeFinalText({
  fragments = [],
  targetId = '',
  cwd = '',
  sessionId = '',
  jobId = '',
  status = '',
  fallbackWhatChanged = '',
  fallbackVerifyCommand = '',
  fallbackVerifyResult = '',
  blocker = '',
} = {}) {
  const source = fragments.map((value) => normalizeText(value)).filter(Boolean).join('\n\n').trim();
  const metadata = extractRemoteCliRunMetadata(source);
  const lines = [source || fallbackVerifyResult || 'remote_code_run completed without text output.'];

  if (!metadata.sessionId && sessionId) {
    lines.push(`REMOTE_CLI_SESSION_ID=${sessionId}`);
  }
  if (!metadata.jobId && jobId) {
    lines.push(`REMOTE_CLI_JOB_ID=${jobId}`);
  }
  if (!metadata.workspace && cwd) {
    lines.push(`WORKSPACE=${cwd}`);
  }
  if (!metadata.whatChanged) {
    lines.push(`WHAT_CHANGED=${fallbackWhatChanged || 'Executed remote_code_run through the MCP gateway.'}`);
  }
  if (!Array.isArray(metadata.verifyCommands) || metadata.verifyCommands.length === 0) {
    lines.push(`VERIFY_COMMANDS=${fallbackVerifyCommand || 'remote_code_run'}`);
  }
  if (!Array.isArray(metadata.verifyResults) || metadata.verifyResults.length === 0) {
    lines.push(`VERIFY_RESULTS=${fallbackVerifyResult || `remote_code_run status: ${status || 'unknown'}.`}`);
  }
  if (!metadata.publicUrl) {
    lines.push('PUBLIC_URL=not_available');
  }
  if (!metadata.blocker) {
    lines.push(`BLOCKER=${blocker || (isFailedRemoteCodeStatus(status) ? `remote_code_run ${status}` : 'none')}`);
  }
  if (targetId) {
    lines.push(`REMOTE_CLI_TARGET=${targetId}`);
  }
  return lines.join('\n');
}

function isOfficialOpenAIBaseURL(baseURL = '') {
  try {
    const parsed = new URL(baseURL);
    return parsed.hostname === 'api.openai.com' || parsed.hostname.endsWith('.api.openai.com');
  } catch (_error) {
    return false;
  }
}

function resolveAgentsApiMode({ requestedMode = '', baseURL = '' } = {}) {
  const normalized = normalizeText(requestedMode).toLowerCase();
  if (normalized === 'responses' || normalized === 'chat') {
    return normalized;
  }
  return isOfficialOpenAIBaseURL(baseURL) ? 'responses' : 'chat';
}

function summarizeUrl(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (_error) {
    return normalized.replace(/([?&](?:token|key|api_key|apikey|bearer|password|secret)=)[^&]+/gi, '$1[redacted]');
  }
}

function summarizeRemoteCliError(error = null) {
  const statusCode = Number(error?.statusCode || error?.status || error?.response?.status) || null;
  const code = normalizeText(error?.code || error?.type || error?.name);
  const causeMessage = normalizeText(error?.cause?.message || error?.cause);
  const responseError = error?.response?.data?.error || error?.response?.error || error?.error;
  const responseMessage = normalizeText(
    typeof responseError === 'string'
      ? responseError
      : (responseError?.message || error?.body?.error?.message || error?.body?.message),
  );
  const message = normalizeText(error?.message || responseMessage || causeMessage || 'Connection error.');

  return {
    message,
    ...(code ? { code } : {}),
    ...(statusCode ? { statusCode } : {}),
    ...(causeMessage && causeMessage !== message ? { causeMessage } : {}),
    ...(responseMessage && responseMessage !== message ? { responseMessage } : {}),
  };
}

function buildRemoteCliDiagnostics({
  stage,
  error,
  model,
  apiMode,
  targetId,
  cwd,
  config: runnerConfig = {},
  mcpSessionId = '',
} = {}) {
  const errorSummary = summarizeRemoteCliError(error);
  const agentBaseURL = normalizeText(runnerConfig.agentBaseURL);
  const mcpURL = normalizeText(runnerConfig.url);
  const hintParts = [];

  if (/^connection error\.?$/i.test(errorSummary.message)) {
    hintParts.push('The upstream SDK only reported a connection error; check the remote-cli MCP URL, gateway reachability, and the model gateway route from the backend pod.');
  }
  if (apiMode === 'chat') {
    hintParts.push('REMOTE_CLI_AGENT_OPENAI_API_MODE is chat, so the configured base URL must implement /v1/chat/completions for the selected model.');
  }
  if (model) {
    hintParts.push(`Verify REMOTE_CLI_AGENT_MODEL or OPENAI_MODEL is accepted by that gateway: ${model}.`);
  }

  return {
    remoteCliAgent: {
      stage,
      model: model || null,
      apiMode: apiMode || null,
      targetId: targetId || null,
      cwd: cwd || null,
      mcpSessionId: mcpSessionId || null,
      mcpURL: summarizeUrl(mcpURL) || null,
      agentBaseURL: summarizeUrl(agentBaseURL) || null,
      hasMcpToken: Boolean(normalizeText(runnerConfig.apiKey)),
      mcpTokenFingerprint: maskSecretValue(runnerConfig.apiKey),
      hasAgentApiKey: Boolean(normalizeText(runnerConfig.agentApiKey)),
      agentApiKeyFingerprint: maskSecretValue(runnerConfig.agentApiKey),
      error: errorSummary,
      hint: hintParts.join(' '),
    },
  };
}

function createRemoteCliAgentError(message, diagnostics = {}, cause = null) {
  const error = new Error(message || 'remote-cli-agent failed.');
  error.name = 'RemoteCliAgentError';
  error.code = 'REMOTE_CLI_AGENT_FAILED';
  error.diagnostics = diagnostics;
  if (cause) {
    error.cause = cause;
    error.status = cause.status || cause.statusCode || cause.response?.status || undefined;
    error.statusCode = cause.statusCode || cause.status || cause.response?.status || undefined;
  }
  return error;
}

function resolveConfiguredGitProviderContext() {
  const gitProvider = typeof settingsController.getEffectiveGitProviderConfig === 'function'
    ? settingsController.getEffectiveGitProviderConfig()
    : (typeof settingsController.getEffectiveGitLabConfig === 'function'
      ? settingsController.getEffectiveGitLabConfig()
      : (config.gitlab || config.gitea || {}));

  const provider = normalizeText(gitProvider.provider || 'gitlab') || 'gitlab';
  const baseURL = normalizeText(gitProvider.baseURL);
  const org = normalizeText(gitProvider.org) || 'agent-apps';
  return {
    provider,
    configured: Boolean(gitProvider.enabled !== false && baseURL),
    baseURL,
    org,
    registryHost: normalizeText(gitProvider.registryHost),
    hasToken: Boolean(normalizeText(gitProvider.token || process.env.GITLAB_TOKEN || process.env.GITEA_TOKEN)),
  };
}

const resolveConfiguredGiteaContext = resolveConfiguredGitProviderContext;

function hasRemoteSoftwareDeploymentIntent(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const softwareTarget = /\b(app|application|site|website|web app|web page|webpage|frontend|dashboard|visualization|visualisation|viewer|map|globe|world|service|game|software)\b/.test(normalized);
  const remoteTarget = /\b(remote|server|host|runner|cli runner|k3s|k8s|kubernetes|cluster|dns|domain|ingress|traefik|tls|deploy|deployment|live|online|gitlab|gitea)\b/.test(normalized)
    || /\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/.test(normalized);
  const authoringIntent = /\b(create|make|build|generate|implement|develop|write|update|fix|finish|continue|resume|complete|deploy|redeploy|publish|launch|ship|route|rollout)\b/.test(normalized);
  const deploymentIntent = /\b(deploy|redeploy|publish|launch|ship|go live|get (?:it|the app|the site|the website) (?:live|online|deployed)|bring (?:it|the app|the site|the website) (?:live|online)|route|ingress|tls|dns|domain|rollout)\b/.test(normalized);
  const infraOnly = /\b(kubectl get|kubectl describe|logs?|status|health|uptime|journalctl|systemctl status|inspect|diagnose|debug)\b/.test(normalized)
    && !/\b(create|make|build|implement|develop|write|update|fix|deploy|redeploy|publish|launch|ship)\b/.test(normalized);

  return softwareTarget && remoteTarget && authoringIntent && deploymentIntent && !infraOnly;
}

function resolveAdminMode(input = {}, task = '') {
  const explicit = input.adminMode ?? input.admin_mode ?? input.runnerAdmin ?? input.runner_admin ?? input.adminControl ?? input.admin_control;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    return /^(?:1|true|yes|on|approved|admin)$/i.test(String(explicit).trim());
  }

  return hasRemoteSoftwareDeploymentIntent(task);
}

function loadAgentsSdk() {
  return require('@openai/agents');
}

function buildRemoteCliInstructions({
  targetId,
  cwd,
  sessionId = '',
  waitMs = 30000,
  adminMode = false,
  extraInstructions = '',
  gitea = resolveConfiguredGitProviderContext(),
} = {}) {
  return [
    'You can modify the remote server using the remote-cli MCP tools.',
    '',
    'You are already inside KimiBuilt `remote-cli-agent`. Do not try to call outer KimiBuilt tools such as `remote-command`, `k3s-deploy`, or `tool-doc-read` from here.',
    'Your remote execution boundary is the MCP gateway: use `remote_code_run` to start coding/build/deploy work and `remote_code_status` to poll any returned job id.',
    '',
    'Use remote_code_run for coding tasks.',
    'Tool shape: call remote_code_run with {"targetId":"<gateway target id>","cwd":"<workspace path>","task":"<clear task>","model":"<optional supported model>","sessionId":"<optional prior sessionId>","waitMs":30000}. Omit model unless a supported gateway model was explicitly configured.',
    'Then poll with remote_code_status using only {"jobId":"<job id from remote_code_run>"}. Do not send command, args, executable, shell, targetId, cwd, sessionId, or waitMs to remote_code_status.',
    'Do not send raw command execution fields to remote_code_run. The allowed execution fields are targetId, cwd, task, model, sessionId, and waitMs.',
    `Default targetId: ${targetId}`,
    cwd ? `Default cwd: ${cwd}` : 'Default cwd: use the gateway target default.',
    '',
    'The targetId is the remote-cli gateway target identifier, not a Git remote, URL, or raw user@host SSH string. Use the configured default targetId unless the user explicitly names another configured gateway target.',
    'Public Git hosts such as github.com, gitlab.com, and bitbucket.org are repository endpoints, never deployment SSH targets. If a transcript mentions a root@github.com permission failure, treat that as the previous mistake and retarget to the real server/gateway target described by the user.',
    'Treat the target as a persistent private workbench for the user: create project files, inspect state, build, test, deploy, and verify from the remote workspace when the task calls for it.',
    'Keep autonomy bounded by the task and existing safety rules. Do not mutate secrets, perform destructive deletes, force-push, install privileged packages, or leave the approved workspace without a clear user request.',
    'Start with compact discovery before edits: repo-map, changed-files, k8s-manifest-summary, and targeted-grep style commands are preferred over reading the whole codebase.',
    'For maintenance work, inspect only changed files, package scripts, manifests, rollout state, logs, and targeted symbols relevant to the task.',
    'For k3s delivery, use an inspect -> focused edit -> focused test/build -> image/deploy -> deploy-verify loop.',
    'For any k3s website/app create or edit, use a git-backed workspace as the source of truth before touching the live cluster.',
    gitea?.configured ? `Configured Git provider: ${gitea.provider || 'gitlab'} at ${gitea.baseURL} (group/org: ${gitea.org}).` : '',
    'GitLab-backed source-control skill: first discover whether the workspace already has an origin, then compare that host with the configured Git provider host. If it matches, keep using that remote as the editable source of truth.',
    'When GitLab is configured but no matching origin exists, check whether non-interactive credentials are available in the remote environment before assuming the user must program anything. Prefer token/askpass-based HTTPS remotes over SSH prompts.',
    'For new apps without a remote, create or use a repository under the configured GitLab group when the configured provider token is available to the backend or remote workbench. Push the deployable commit to GitLab before building or deploying so the GitLab project page, commits, and pipeline/build-event trail become the source of truth.',
    'If the request needs GitLab observability and GitLab is configured, do not silently use the direct BuildKit/kubectl runner as the main path. Stop with USER_INPUT_REQUIRED and name the missing credential/API/runner capability when you cannot create, attach, push, or observe the GitLab repo non-interactively.',
    'If GitLab is not configured or not reachable and the user did not require GitLab observability, deliberately fall back to a local git repo plus the direct BuildKit/kubectl runner path. Say the fallback is source-controlled locally and name what is missing for GitLab automation.',
    'Before committing in a fresh remote workspace, set repo-local git user.name and user.email if they are missing.',
    'For follow-up edits, inspect git status, git remote -v, git log, and the current source files first. Patch the existing source, preserve prior content/assets unless explicitly replacing them, commit the change, then rebuild/redeploy.',
    'Use live Kubernetes resources, mounted files, or ConfigMaps as diagnostics or recovery input only; do not leave them as the only editable source of truth for a deployed site.',
    adminMode ? 'Admin runner mode is enabled for this task because the user asked for real remote software change/deployment. You may use the configured admin-capable CLI runner or remote target for repository edits, builds, image pushes, Kubernetes apply/rollout, ingress, TLS, and verification that are directly required by the task.' : '',
    adminMode ? 'Keep admin use narrow: stay inside the owning workspace, namespace, domain, and deployment path; do not mutate Kubernetes Secrets, wipe data, force-push, perform broad package upgrades, or change unrelated host services unless the user explicitly approved that exact action.' : '',
    adminMode ? 'If a command is blocked by runner policy, sudo policy, missing credentials, or missing admin capability, do not retry the same blocked command. Switch to a non-privileged supported path when one exists; otherwise stop and report the exact approval, capability, credential, or sudoers change needed.' : '',
    'Track repeated errors. If the same command shape or root error fails twice without a materially different fix, stop that loop, summarize the blocker, and name the next distinct recovery option instead of wasting time retrying.',
    'If you need a user decision to finish the work, emit a concise marker line USER_INPUT_REQUIRED=<question/options> and stop; the KimiBuilt-side agent will forward that request and can steer a follow-up remote-cli-agent run with the user choice.',
    'For website, dashboard, or frontend work, include visual QA in the build package: run Playwright/Chromium screenshots for desktop and mobile states when the target exposes a local preview or public URL.',
    'For website, dashboard, app, landing-page, and frontend mockup work, apply the Impressive Frontend Websites standard: infer a compact brief, make the first viewport specific to the product or workflow, build the usable experience instead of a generic placeholder, include real controls/states/interactions, and use assets that reveal the actual product, place, audience, workflow, or state.',
    'Design with restraint and specificity: avoid one-note palettes, oversized rounded/nested cards, decorative blobs, clipped text, horizontal overflow, broken image paths, and unreadable dropdown/menu/popover/dialog/tooltip states.',
    'After the first working screenshot, make at least one refinement pass for non-trivial frontend builds; fix layout, contrast, asset, interaction, and responsive issues before deploying or calling the UI ready.',
    'If the KimiBuilt runner helper is present, prefer `node /app/bin/kimibuilt-ui-check.js <url> --out ui-checks` and inspect its JSON report before claiming the UI is ready.',
    'Report screenshot and report paths with marker lines when known: UI_CHECK_REPORT=<path> and UI_SCREENSHOTS=<comma-separated paths>.',
    `For long tasks, call remote_code_run with waitMs: ${waitMs}.`,
    'If it returns status "running", call remote_code_status with the returned jobId only.',
    'If continuing prior work, reuse the returned sessionId.',
    sessionId ? `Current prior remote CLI sessionId: ${sessionId}` : '',
    'When the task includes an "Original task" and a "Current user follow-up", preserve the original task as the governing objective. Treat the follow-up as steering or continuation, not as a replacement status request.',
    'Do not let progress callbacks, foreground plan labels, or status-card text become the task. Finish the requested work and only stop for USER_INPUT_REQUIRED when a real user decision is needed.',
    'Do not try to pass raw shell commands; only use the exposed tool schema.',
    'Finish every run with completion proof marker lines: WHAT_CHANGED=<short summary>, VERIFY_COMMANDS=<commands run or not_available>, VERIFY_RESULTS=<pass/fail/blocked results>, PUBLIC_URL=<https URL or not_available>, and BLOCKER=<none or exact blocker>. Use one VERIFY_COMMANDS or VERIFY_RESULTS line per distinct command/result when useful.',
    'Also finish with marker lines for continuity when known: REMOTE_CLI_SESSION_ID=<remote_code_run sessionId>, WORKSPACE=<path>, GIT_REPO=<origin or local repo>, GIT_COMMIT=<sha>, DEPLOYMENT=<namespace/name>, PUBLIC_HOST=<host>, UI_CHECK_REPORT=<path>, UI_SCREENSHOTS=<comma-separated paths>.',
    extraInstructions,
  ].filter(Boolean).join('\n');
}

function buildRemoteCliPrompt({
  task,
  targetId,
  cwd,
  sessionId = '',
  waitMs = 30000,
  adminMode = false,
} = {}) {
  return [
    `Task: ${task}`,
    '',
    'Execution defaults:',
    `- targetId: ${targetId}`,
    cwd ? `- cwd: ${cwd}` : '',
    sessionId ? `- continue remote CLI sessionId: ${sessionId}` : '',
    `- waitMs: ${waitMs}`,
    adminMode ? '- admin runner mode: enabled for real remote change/deploy work; keep privilege use scoped to the task and stop on repeated blocked commands.' : '',
  ].filter(Boolean).join('\n');
}

class RemoteCliAgentsSdkRunner {
  constructor(options = {}) {
    this.sdkLoader = options.sdkLoader || loadAgentsSdk;
    this.config = options.config || config.remoteCliMcp || {};
  }

  getPublicConfig() {
    return {
      enabled: this.config.enabled !== false,
      configured: Boolean(normalizeText(this.config.url) && normalizeText(this.config.apiKey)),
      url: normalizeText(this.config.url),
      name: normalizeText(this.config.name) || 'remote-cli',
      defaultTargetId: resolveRemoteCliTargetId('', this.config.defaultTargetId || 'prod'),
      defaultCwd: normalizeText(this.config.defaultCwd),
      agentModel: normalizeText(this.config.agentModel),
      remoteCodeModel: normalizeText(this.config.remoteCodeModel) || DEFAULT_REMOTE_CODE_MODEL,
      timeoutMs: normalizePositiveInteger(this.config.timeoutMs, 60000, { min: 1000 }),
      maxTurns: normalizePositiveInteger(this.config.maxTurns, 20, { min: 1, max: 80 }),
      agentRunTimeoutMs: normalizePositiveInteger(this.config.agentRunTimeoutMs, DEFAULT_AGENT_RUN_TIMEOUT_MS, { min: 1, max: 900000 }),
      maxStatusPolls: normalizePositiveInteger(this.config.maxStatusPolls, DEFAULT_MAX_STATUS_POLLS, { min: 1, max: 300 }),
      statusPollIntervalMs: normalizePositiveInteger(this.config.statusPollIntervalMs, DEFAULT_STATUS_POLL_INTERVAL_MS, { min: 0, max: 30000 }),
    };
  }

  assertConfigured() {
    if (this.config.enabled === false) {
      throw new Error('Remote CLI MCP integration is disabled.');
    }
    if (!normalizeText(this.config.url)) {
      throw new Error('REMOTE_CLI_MCP_URL or GATEWAY_URL is required for remote-cli-agent.');
    }
    if (!normalizeText(this.config.apiKey)) {
      throw new Error('REMOTE_CLI_MCP_BEARER_TOKEN or N8N_API_KEY is required for remote-cli-agent.');
    }
    if (!normalizeText(this.config.agentApiKey)) {
      throw new Error('REMOTE_CLI_AGENT_OPENAI_API_KEY or OPENAI_API_KEY is required for remote-cli-agent.');
    }
  }

  createMcpServer(MCPServerStreamableHttp, params = {}) {
    const url = normalizeText(params.url || this.config.url);
    const token = normalizeText(params.apiKey || this.config.apiKey);
    const name = normalizeText(params.name || this.config.name) || 'remote-cli';
    const timeoutMs = normalizePositiveInteger(params.timeoutMs || this.config.timeoutMs, 60000, { min: 1000 });

    return new MCPServerStreamableHttp({
      url,
      name,
      cacheToolsList: true,
      timeout: timeoutMs,
      ...(params.mcpSessionId ? { sessionId: normalizeText(params.mcpSessionId) } : {}),
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });
  }

  createModelProvider(OpenAIProvider) {
    return new OpenAIProvider({
      apiKey: normalizeText(this.config.agentApiKey),
      baseURL: normalizeText(this.config.agentBaseURL) || undefined,
    });
  }

  async executeRemoteCodeRun(remoteCli, {
    targetId = 'prod',
    cwd = '',
    task = '',
    model = '',
    sessionId = '',
    waitMs = 30000,
    jobId = '',
    maxStatusPolls = DEFAULT_MAX_STATUS_POLLS,
    statusPollIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS,
    onProgress = null,
  } = {}) {
    const emitProgress = (detail, extra = {}) => {
      if (typeof onProgress !== 'function' || !detail) {
        return;
      }
      try {
        onProgress({
          phase: 'executing',
          reasoningSummary: detail,
          detail,
          percent: extra.percent || 45,
          toolEvents: [{
            toolId: 'remote-cli-agent',
            stage: extra.stage || 'in_progress',
            detail,
          }],
        });
      } catch (error) {
        console.warn('[RemoteCliAgentsSdkRunner] Failed to emit remote code progress:', error?.message || error);
      }
    };

    let remoteJobId = normalizeText(jobId);
    let remoteSessionId = normalizeText(sessionId);
    let latestStatus = '';
    const fragments = [];
    let statusPolls = 0;

    if (!remoteJobId) {
      const runArgs = {
        targetId,
        ...(cwd ? { cwd } : {}),
        task,
        ...(model ? { model } : {}),
        ...(remoteSessionId ? { sessionId: remoteSessionId } : {}),
        waitMs,
      };
      emitProgress('Calling remote_code_run through the MCP gateway.', { percent: 48 });
      const runResult = await remoteCli.callTool('remote_code_run', runArgs);
      const runText = normalizeMcpContentText(runResult);
      fragments.push(...collectRemoteCodeTextFragments(runResult, runText));
      const runState = extractRemoteCodeJobState(runResult, runText);
      remoteJobId = runState.jobId || remoteJobId;
      remoteSessionId = runState.sessionId || remoteSessionId;
      latestStatus = runState.status || latestStatus;
    }

    if (!remoteJobId && isRunningRemoteCodeStatus(latestStatus)) {
      return buildRemoteCodeFinalText({
        fragments,
        targetId,
        cwd,
        sessionId: remoteSessionId,
        status: latestStatus,
        fallbackWhatChanged: 'Started remote_code_run through the MCP gateway, but the gateway did not return a jobId.',
        fallbackVerifyCommand: 'remote_code_run',
        fallbackVerifyResult: `remote_code_run returned status ${latestStatus} without a jobId; remote_code_status could not be polled.`,
        blocker: 'remote_code_run returned running without a jobId',
      });
    }

    const pollLimit = normalizePositiveInteger(maxStatusPolls, DEFAULT_MAX_STATUS_POLLS, { min: 1, max: 300 });
    const pollDelay = normalizePositiveInteger(statusPollIntervalMs, DEFAULT_STATUS_POLL_INTERVAL_MS, { min: 0, max: 30000 });

    while (remoteJobId && (isRunningRemoteCodeStatus(latestStatus) || !latestStatus) && statusPolls < pollLimit) {
      if (statusPolls > 0 || latestStatus) {
        await sleep(pollDelay);
      }
      emitProgress(`Polling remote_code_status for job ${remoteJobId}.`, { percent: Math.min(85, 52 + statusPolls) });
      const statusResult = await remoteCli.callTool('remote_code_status', { jobId: remoteJobId });
      const statusText = normalizeMcpContentText(statusResult);
      fragments.push(...collectRemoteCodeTextFragments(statusResult, statusText));
      const statusState = extractRemoteCodeJobState(statusResult, statusText);
      latestStatus = statusState.status || latestStatus || 'unknown';
      remoteSessionId = statusState.sessionId || remoteSessionId;
      remoteJobId = statusState.jobId || remoteJobId;
      statusPolls += 1;

      const metadata = extractRemoteCliRunMetadata(fragments.join('\n\n'));
      if (metadata.completionStatus && metadata.completionStatus !== 'unknown') {
        latestStatus = metadata.completionStatus === 'blocked' ? 'blocked' : 'completed';
        break;
      }
      if (!isRunningRemoteCodeStatus(latestStatus)) {
        break;
      }
    }

    const stillRunning = remoteJobId && isRunningRemoteCodeStatus(latestStatus);
    return buildRemoteCodeFinalText({
      fragments,
      targetId,
      cwd,
      sessionId: remoteSessionId,
      jobId: remoteJobId,
      status: latestStatus,
      fallbackWhatChanged: stillRunning
        ? 'Started remote_code_run through the MCP gateway and polled remote_code_status, but the remote job is still running.'
        : 'Executed remote_code_run through the MCP gateway and checked remote_code_status.',
      fallbackVerifyCommand: remoteJobId ? 'remote_code_run, remote_code_status' : 'remote_code_run',
      fallbackVerifyResult: stillRunning
        ? `remote_code_status remained ${latestStatus || 'running'} after ${statusPolls} poll attempt(s).`
        : `remote_code_run reached status ${latestStatus || 'unknown'}.`,
      blocker: stillRunning
        ? 'remote_code_run still running; continue with the returned remote job id'
        : '',
    });
  }

  async run(input = {}) {
    const task = normalizeText(input.task || input.prompt || input.message);
    if (!task) {
      throw new Error('remote-cli-agent requires a task.');
    }
    this.assertConfigured();

    const sdk = this.sdkLoader();
    const {
      Agent,
      MCPServerStreamableHttp,
      OpenAIProvider,
      Runner,
      setOpenAIAPI,
    } = sdk;

    if (!Agent || !MCPServerStreamableHttp || !OpenAIProvider || !Runner) {
      throw new Error('@openai/agents is installed but did not expose the expected Agents SDK classes.');
    }

    const targetId = resolveRemoteCliTargetId(
      input.targetId || input.target_id,
      this.config.defaultTargetId || 'prod',
    );
    const cwd = normalizeText(input.cwd || input.workingDirectory || input.working_directory || this.config.defaultCwd);
    const sessionId = normalizeText(input.sessionId || input.session_id || input.remoteSessionId || input.remote_session_id);
    const jobId = normalizeText(input.jobId || input.job_id || input.remoteCodeJobId || input.remote_code_job_id);
    const waitMs = normalizePositiveInteger(input.waitMs || input.wait_ms, 30000, { min: 1000, max: 300000 });
    const maxTurns = normalizePositiveInteger(input.maxTurns || input.max_turns || this.config.maxTurns, 20, { min: 1, max: 80 });
    const agentRunTimeoutMs = normalizePositiveInteger(input.agentRunTimeoutMs || input.agent_run_timeout_ms || this.config.agentRunTimeoutMs, DEFAULT_AGENT_RUN_TIMEOUT_MS, { min: 1, max: 900000 });
    const model = normalizeText(input.model || this.config.agentModel) || 'gpt-4o';
    const remoteCodeModel = normalizeText(input.remoteCodeModel || input.remote_code_model || this.config.remoteCodeModel) || DEFAULT_REMOTE_CODE_MODEL;
    const maxStatusPolls = normalizePositiveInteger(input.maxStatusPolls || input.max_status_polls || this.config.maxStatusPolls, DEFAULT_MAX_STATUS_POLLS, { min: 1, max: 300 });
    const statusPollIntervalMs = normalizePositiveInteger(input.statusPollIntervalMs || input.status_poll_interval_ms || this.config.statusPollIntervalMs, DEFAULT_STATUS_POLL_INTERVAL_MS, { min: 0, max: 30000 });
    const adminMode = resolveAdminMode(input, task);
    const apiMode = resolveAgentsApiMode({
      requestedMode: this.config.agentApiMode,
      baseURL: this.config.agentBaseURL,
    });

    if (typeof setOpenAIAPI === 'function') {
      setOpenAIAPI(apiMode);
    }

    const remoteCli = this.createMcpServer(MCPServerStreamableHttp, input);
    const remoteCodeCallState = attachRemoteCodeCallTracker(remoteCli);
    const emitContractProgress = (detail, extra = {}) => {
      if (typeof input.onProgress !== 'function' || !detail) {
        return;
      }
      try {
        input.onProgress({
          phase: 'executing',
          reasoningSummary: detail,
          detail,
          percent: extra.percent || 47,
          toolEvents: [{
            toolId: 'remote-cli-agent',
            stage: extra.stage || 'fallback',
            detail,
          }],
        });
      } catch (error) {
        console.warn('[RemoteCliAgentsSdkRunner] Failed to emit remote-cli contract progress:', error?.message || error);
      }
    };
    const instructions = buildRemoteCliInstructions({
      targetId,
      cwd,
      sessionId,
      waitMs,
      adminMode,
      extraInstructions: input.instructions || input.extraInstructions || '',
    });
    const agent = new Agent({
      name: normalizeText(input.agentName || input.agent_name) || 'Remote coding agent',
      model,
      instructions,
      mcpServers: [remoteCli],
    });
    const runner = new Runner({
      model,
      modelProvider: this.createModelProvider(OpenAIProvider),
      tracingDisabled: true,
      workflowName: 'Remote CLI MCP coding task',
    });

    try {
      try {
        await remoteCli.connect();
      } catch (error) {
        const diagnostics = buildRemoteCliDiagnostics({
          stage: 'mcp_connect',
          error,
          model,
          apiMode,
          targetId,
          cwd,
          config: this.config,
          mcpSessionId: input.mcpSessionId,
        });
        throw createRemoteCliAgentError(
          `remote-cli-agent could not connect to the MCP gateway: ${summarizeRemoteCliError(error).message}`,
          diagnostics,
          error,
        );
      }

      let finalOutput = '';
      if (jobId) {
        finalOutput = await this.executeRemoteCodeRun(remoteCli, {
          targetId,
          cwd,
          task,
          model: remoteCodeModel,
          sessionId,
          waitMs,
          jobId,
          maxStatusPolls,
          statusPollIntervalMs,
          onProgress: input.onProgress,
        });
      } else {
        let result = null;
        try {
          result = await withTimeout(runner.run(agent, buildRemoteCliPrompt({
            task,
            targetId,
            cwd,
            sessionId,
            waitMs,
            adminMode,
          }), {
            maxTurns,
          }), agentRunTimeoutMs);
        } catch (error) {
          if (!isRemoteCliAgentRunTimeoutError(error)) {
            throw error;
          }

          if (typeof input.onProgress === 'function') {
            const pollExistingJob = Boolean(remoteCodeCallState.jobId);
            input.onProgress({
              phase: 'executing',
              reasoningSummary: pollExistingJob
                ? 'Remote CLI agent model run timed out; polling the remote_code_run job it already started.'
                : 'Remote CLI agent model run timed out; falling back to direct remote_code_run.',
              detail: pollExistingJob
                ? 'Inner agent timeout reached; continuing with remote_code_status.'
                : 'Inner agent timeout reached; starting remote_code_run directly.',
              percent: 46,
              toolEvents: [{
                toolId: 'remote-cli-agent',
                stage: 'fallback',
                detail: pollExistingJob
                  ? 'Polling the existing remote_code_run job after inner model timeout.'
                  : 'Starting direct remote_code_run after inner model timeout.',
              }],
            });
          }

          finalOutput = await this.executeRemoteCodeRun(remoteCli, {
            targetId,
            cwd,
            task,
            model: remoteCodeModel,
            sessionId: remoteCodeCallState.sessionId || sessionId,
            waitMs,
            jobId: remoteCodeCallState.jobId || '',
            maxStatusPolls,
            statusPollIntervalMs,
            onProgress: input.onProgress,
          });
        }

        if (!finalOutput) {
          finalOutput = result?.finalOutput || '';
        }
        const leakedMcpToolCalls = extractRawMcpToolCalls(finalOutput);
        if (leakedMcpToolCalls.length > 0) {
          const call = leakedMcpToolCalls.find((entry) => entry.name === 'remote_code_run')
            || leakedMcpToolCalls.find((entry) => entry.name === 'remote_code_status');
          const leakedArgs = call?.arguments || {};
          finalOutput = await this.executeRemoteCodeRun(remoteCli, {
            targetId: resolveRemoteCliTargetId(leakedArgs.targetId || targetId, targetId),
            cwd: normalizeLeakedPath(leakedArgs.cwd || cwd),
            task,
            model: normalizeText(leakedArgs.model || remoteCodeModel),
            sessionId: normalizeText(leakedArgs.sessionId || sessionId),
            waitMs: normalizePositiveInteger(leakedArgs.waitMs || waitMs, waitMs, { min: 1000, max: 300000 }),
            jobId: call?.name === 'remote_code_status' ? normalizeText(leakedArgs.jobId || jobId) : '',
            maxStatusPolls,
            statusPollIntervalMs,
            onProgress: input.onProgress,
          });
        }
      }
      let runMetadata = extractRemoteCliRunMetadata(finalOutput);
      if (runMetadata.completionStatus === 'unknown') {
        if (remoteCodeCallState.jobId) {
          emitContractProgress(
            `Remote CLI agent returned without proof markers; polling remote_code_status for job ${remoteCodeCallState.jobId}.`,
            { percent: 50 },
          );
          finalOutput = await this.executeRemoteCodeRun(remoteCli, {
            targetId,
            cwd,
            task,
            model: remoteCodeModel,
            sessionId: remoteCodeCallState.sessionId || sessionId,
            waitMs,
            jobId: remoteCodeCallState.jobId,
            maxStatusPolls,
            statusPollIntervalMs,
            onProgress: input.onProgress,
          });
          runMetadata = extractRemoteCliRunMetadata(finalOutput);
        } else if (!remoteCodeCallState.sawRemoteCodeRun) {
          emitContractProgress(
            'Remote CLI agent returned without calling remote_code_run or producing proof markers; starting direct remote_code_run.',
            { percent: 50 },
          );
          finalOutput = await this.executeRemoteCodeRun(remoteCli, {
            targetId,
            cwd,
            task,
            model: remoteCodeModel,
            sessionId: remoteCodeCallState.sessionId || sessionId,
            waitMs,
            maxStatusPolls,
            statusPollIntervalMs,
            onProgress: input.onProgress,
          });
          runMetadata = extractRemoteCliRunMetadata(finalOutput);
        } else {
          finalOutput = buildRemoteCodeFinalText({
            fragments: [finalOutput],
            targetId,
            cwd,
            sessionId: remoteCodeCallState.sessionId || sessionId,
            status: remoteCodeCallState.status || 'unknown',
            fallbackWhatChanged: 'The inner agent called remote_code_run, but the gateway response did not include proof markers or a jobId to poll.',
            fallbackVerifyCommand: 'remote_code_run',
            fallbackVerifyResult: 'remote_code_run did not expose a resumable jobId or final proof markers.',
            blocker: 'remote_code_run returned without a jobId or proof markers',
          });
          runMetadata = extractRemoteCliRunMetadata(finalOutput);
        }
      }

      return {
        finalOutput,
        mcpSessionId: remoteCli.sessionId || input.mcpSessionId || null,
        targetId,
        cwd: runMetadata.workspace || cwd,
        sessionId: runMetadata.sessionId || sessionId || null,
        remoteCodeSessionId: runMetadata.sessionId || sessionId || null,
        remoteCodeJobId: runMetadata.jobId || jobId || null,
        gitRepo: runMetadata.gitRepo || null,
        gitCommit: runMetadata.gitCommit || null,
        deployment: runMetadata.deployment || null,
        publicHost: runMetadata.publicHost || null,
        publicUrl: runMetadata.publicUrl || null,
        uiCheckReport: runMetadata.uiCheckReport || null,
        uiScreenshots: runMetadata.uiScreenshots || [],
        whatChanged: runMetadata.whatChanged || null,
        verifyCommands: runMetadata.verifyCommands || [],
        verifyResults: runMetadata.verifyResults || [],
        blocker: runMetadata.blocker || null,
        completionStatus: runMetadata.completionStatus || 'unknown',
        model,
        apiMode,
      };
    } catch (error) {
      if (error?.name === 'RemoteCliAgentError') {
        throw error;
      }

      const diagnostics = buildRemoteCliDiagnostics({
        stage: 'agent_run',
        error,
        model,
        apiMode,
        targetId,
        cwd,
        config: this.config,
        mcpSessionId: remoteCli.sessionId || input.mcpSessionId,
      });
      throw createRemoteCliAgentError(
        `remote-cli-agent model run failed (${model}): ${summarizeRemoteCliError(error).message}`,
        diagnostics,
        error,
      );
    } finally {
      await remoteCli.close().catch((error) => {
        console.warn('[RemoteCliAgentsSdkRunner] Failed to close MCP connection:', error.message);
      });
    }
  }
}

const remoteCliAgentsSdkRunner = new RemoteCliAgentsSdkRunner();

module.exports = {
  RemoteCliAgentsSdkRunner,
  buildRemoteCliInstructions,
  buildRemoteCliPrompt,
  extractRemoteCliRunMetadata,
  remoteCliAgentsSdkRunner,
  resolveRemoteCliTargetId,
  resolveConfiguredGiteaContext,
  resolveConfiguredGitProviderContext,
  resolveAgentsApiMode,
  buildRemoteCliDiagnostics,
  summarizeRemoteCliError,
  hasRemoteSoftwareDeploymentIntent,
  resolveAdminMode,
  trimTrailingSlash,
};

'use strict';

const { config } = require('../config');
const settingsController = require('../routes/admin/settings.controller');
const { parseLenientJson } = require('../utils/lenient-json');
const {
  assessAgentQuality,
  buildAgentQualityContractText,
} = require('../agent-quality-contract');
const { normalizeEvidenceAttestation, redactSecrets } = require('../agent-evidence');
const {
  buildRemoteAgentHandoffPrompt,
  normalizeRelativeWorkspacePath,
} = require('./agent-handoff');

const REMOTE_CLI_RESULT_VERSION = 'RemoteCliResult/v2';

const DEFAULT_REMOTE_CODE_MODEL = 'gpt-5.4';
const DEFAULT_AGENT_RUN_TIMEOUT_MS = 180000;
const DEFAULT_MAX_STATUS_POLLS = 20;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_CODEX_AGENT_STALL_TIMEOUT_MS = 300000;

const CODEX_AGENT_TERMINAL_EVENTS = new Set([
  'turn_completed',
  'turn_failed',
  'turn_cancelled',
  'turn_input_required',
]);

const PROVIDER_AGENT_RESULT_PATTERN = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*|__)?REMOTE_AGENT_RESULT(?:(?:\*\*|__)\s*)?[:=]\s*(success|failed)\b/i;

function normalizeBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return /^(?:1|true|yes|on|enabled)$/i.test(String(value).trim());
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function sleep(ms = 0) {
  const delay = Number(ms) || 0;
  return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

class RemoteCliAgentRunTimeoutError extends Error {
  constructor(timeoutMs = DEFAULT_AGENT_RUN_TIMEOUT_MS) {
    super(`remote-cli-agent inner model wait became stale after ${timeoutMs}ms; continuing with direct remote_code_run fallback.`);
    this.name = 'RemoteCliAgentRunTimeoutError';
    this.code = 'REMOTE_CLI_AGENT_RUN_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function isRemoteCliAgentRunTimeoutError(error = null) {
  return error?.name === 'RemoteCliAgentRunTimeoutError'
    || error?.code === 'REMOTE_CLI_AGENT_RUN_TIMEOUT';
}

function isUnknownRemoteCliJobError(error = null) {
  const message = [
    error?.message,
    error?.cause?.message,
    error?.response?.data?.error?.message,
    error?.response?.data?.message,
    error?.body?.error?.message,
    error?.body?.message,
  ].map((value) => normalizeText(value)).filter(Boolean).join('\n');
  return /\bUnknown remote CLI job\b/i.test(message);
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

function pushUniqueLine(lines = [], line = '') {
  const normalized = normalizeText(line);
  if (normalized && !lines.includes(normalized)) {
    lines.push(normalized);
  }
}

function collectCodexJsonlTextFragments(value = '', depth = 0) {
  if (depth > 3) {
    return [];
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return [];
  }

  const fragments = [];
  const addString = (candidate = '') => {
    const normalized = typeof candidate === 'string' ? candidate.trim() : '';
    if (normalized) {
      fragments.push(normalized);
      fragments.push(...collectCodexJsonlTextFragments(normalized, depth + 1));
    }
  };
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }

    [
      candidate.text,
      candidate.stdout,
      candidate.stderr,
      candidate.aggregated_output,
      candidate.output_text,
      candidate.finalOutput,
      candidate.final_output,
      candidate.message,
    ].forEach(addString);
    visit(candidate.item);
    visit(candidate.result);
    visit(candidate.data);
    visit(candidate.structuredContent);
    visit(candidate.content);
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) {
      continue;
    }
    const parsed = parseLenientJson(trimmed);
    if (parsed) {
      visit(parsed);
    }
  }

  const parsedWhole = parseLenientJson(text);
  if (parsedWhole) {
    visit(parsedWhole);
  }

  return fragments;
}

function expandRemoteCliProofText(text = '') {
  const source = String(text || '');
  const fragments = [source, ...collectCodexJsonlTextFragments(source)];
  return Array.from(new Set(fragments.map((value) => String(value || '').trim()).filter(Boolean))).join('\n\n');
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

  if (/[\\/]/.test(normalized)) {
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
    const match = line.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*|__)?(?:${keyPattern})(?:(?:\\*\\*|__)\\s*)?[:=]\\s*(.+?)\\s*(?:\\*\\*|__)?\\s*$`, 'i'));
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
    .map((line) => line.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*|__)?(?:${keyPattern})(?:(?:\\*\\*|__)\\s*)?[:=]\\s*(.+?)\\s*(?:\\*\\*|__)?\\s*$`, 'i'))?.[1] || '')
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

function normalizeFailureMessage(value = '') {
  return normalizeText(value)
    .replace(/\s+/g, ' ')
    .slice(0, 800);
}

function extractFailureMessageFromValue(value, depth = 0) {
  if (value === undefined || value === null || depth > 6) {
    return '';
  }

  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (!text) {
      return '';
    }
    const parsed = parseLenientJson(text);
    if (parsed && typeof parsed === 'object') {
      return extractFailureMessageFromValue(parsed, depth + 1) || normalizeFailureMessage(text);
    }
    return normalizeFailureMessage(text);
  }

  if (typeof value !== 'object') {
    return normalizeFailureMessage(value);
  }

  const error = value.error && typeof value.error === 'object' ? value.error : null;
  const direct = [
    error?.message,
    value.message,
    value.errorMessage,
    value.error_message,
    typeof value.error === 'string' ? value.error : '',
  ].map((candidate) => extractFailureMessageFromValue(candidate, depth + 1)).find(Boolean);
  if (direct) {
    return direct;
  }

  return '';
}

function collectRemoteCliFailureMessages(value, messages = [], depth = 0) {
  if (value === undefined || value === null || depth > 6) {
    return messages;
  }

  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (!text) {
      return messages;
    }
    const jsonlLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'));
    if (jsonlLines.length > 1) {
      jsonlLines.forEach((line) => collectRemoteCliFailureMessages(line, messages, depth + 1));
      return messages;
    }
    const parsed = parseLenientJson(text);
    if (parsed && typeof parsed === 'object') {
      collectRemoteCliFailureMessages(parsed, messages, depth + 1);
      return messages;
    }
    if (/\b(?:invalid_request_error|turn[._-]?failed|error|failed|unsupported)\b/i.test(text)) {
      messages.push(normalizeFailureMessage(text));
    }
    return messages;
  }

  if (typeof value !== 'object') {
    return messages;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectRemoteCliFailureMessages(entry, messages, depth + 1));
    return messages;
  }

  const type = normalizeText(value.type || value.event || value.status || value.phase);
  const numericStatus = Number(value.status);
  const looksFailed = /\b(?:error|failed|failure|cancelled|input_required)\b/i.test(type)
    || (Number.isFinite(numericStatus) && numericStatus >= 400);
  if (looksFailed) {
    const message = extractFailureMessageFromValue(value, depth + 1);
    if (message) {
      messages.push(message);
    }
  }

  for (const child of Object.values(value)) {
    if (child && (typeof child === 'object' || typeof child === 'string')) {
      collectRemoteCliFailureMessages(child, messages, depth + 1);
    }
  }
  return messages;
}

function detectRemoteCliExecutionBlocker(source = '') {
  const text = expandRemoteCliProofText(source);
  const messages = collectRemoteCliFailureMessages(text)
    .map((message) => normalizeFailureMessage(message))
    .filter(Boolean)
    .filter((message) => !/^(?:error|failed|turn[._-]?failed)$/i.test(message));

  return Array.from(new Set(messages)).find(Boolean) || '';
}

function resolveCompletionStatus({ remoteAgentResult = '', blocker = '', blockerMarker = '', whatChanged = '', verifyResults = [], publicUrl = '', publicHost = '', uiCheckReport = '', gitCommit = '' } = {}) {
  const normalizedResult = normalizeOptionalProofValue(remoteAgentResult).toLowerCase().replace(/\s+/g, '_');
  const combinedVerification = (Array.isArray(verifyResults) ? verifyResults : [])
    .map((value) => normalizeText(value).toLowerCase())
    .join('\n');
  if (isRunningRemoteCodeStatus(normalizedResult)
    || /\bremote_code_status\s+remained\s+(?:running|queued|pending|active|started|in[_ -]?progress|processing|working)\b/.test(combinedVerification)) {
    return 'running';
  }

  if (normalizeOptionalProofValue(blocker)) {
    return 'blocked';
  }

  const hasVerification = verifyResults.length > 0 || Boolean(publicUrl || publicHost || uiCheckReport);
  const hasChangeEvidence = Boolean(whatChanged || gitCommit);
  const explicitlyUnblocked = Boolean(blockerMarker)
    && !normalizeOptionalProofValue(blockerMarker);
  if (hasChangeEvidence && hasVerification) {
    return 'complete';
  }
  if (explicitlyUnblocked && hasVerification) {
    return 'complete';
  }
  if (hasChangeEvidence || hasVerification) {
    return 'partially_verified';
  }

  return 'unknown';
}

function hasUiProofRequiredIntent(text = '') {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /\b(web[-\s]?chat|managed[-\s]?app(?:\s+preview)?|html artifact|generated html|tts|text[-\s]?to[-\s]?speech|document rendering|website|dashboard|frontend|front[-\s]?end|ui|user interface)\b/.test(normalized);
}

function hasUiProofEvidence(metadata = {}) {
  const evidenceText = [
    metadata.uiCheckReport,
    ...(Array.isArray(metadata.uiScreenshots) ? metadata.uiScreenshots : []),
    ...(Array.isArray(metadata.verifyCommands) ? metadata.verifyCommands : []),
    ...(Array.isArray(metadata.verifyResults) ? metadata.verifyResults : []),
  ].map((value) => normalizeText(value)).filter(Boolean).join('\n');

  return Boolean(metadata.uiCheckReport)
    || (Array.isArray(metadata.uiScreenshots) && metadata.uiScreenshots.length > 0)
    || /\b(?:kimibuilt-ui-check|playwright|chromium|browser|screenshot|captureScreenshot|ui check|visual qa|visual verification)\b/i.test(evidenceText);
}

function applyUiProofRequirement(metadata = {}, task = '') {
  const completionStatus = normalizeText(metadata.completionStatus);
  if (!hasUiProofRequiredIntent(task)
    || hasUiProofEvidence(metadata)
    || completionStatus === 'blocked'
    || completionStatus === 'running') {
    return metadata;
  }

  const blocker = 'Missing browser/Playwright or kimibuilt-ui-check evidence for a UI-affecting remote task.';
  const verifyResults = Array.isArray(metadata.verifyResults) ? metadata.verifyResults : [];
  return {
    ...metadata,
    verifyResults: verifyResults.some((value) => /missing browser\/playwright|missing .*ui.*proof|kimibuilt-ui-check evidence/i.test(String(value || '')))
      ? verifyResults
      : [...verifyResults, blocker],
    blocker: metadata.blocker || blocker,
    completionStatus: 'blocked',
  };
}

function assessRemoteCliQuality(task = '', metadata = {}) {
  return assessAgentQuality({
    task,
    metadata,
  });
}

function buildRemoteCliStructuredResult({ task = '', metadata = {}, agentQuality = null } = {}) {
  const evidenceAttestations = (Array.isArray(metadata.evidenceAttestations)
    ? metadata.evidenceAttestations
    : [])
    .map(normalizeEvidenceAttestation)
    .filter(Boolean);
  const summary = normalizeText(metadata.whatChanged)
    || (metadata.completionStatus === 'blocked'
      ? normalizeText(metadata.blocker) || 'Remote work is blocked.'
      : 'Remote CLI run completed without a change summary.');

  return redactSecrets({
    version: REMOTE_CLI_RESULT_VERSION,
    status: normalizeText(metadata.completionStatus) || 'unknown',
    humanSummary: summary,
    objective: normalizeText(task) || null,
    continuity: {
      sessionId: normalizeText(metadata.sessionId) || null,
      jobId: normalizeText(metadata.jobId) || null,
      workspace: normalizeText(metadata.workspace) || null,
    },
    sourceControl: {
      repository: normalizeText(metadata.gitRepo) || null,
      branch: normalizeText(metadata.gitBranch) || null,
      baseCommit: normalizeText(metadata.gitBaseCommit) || null,
      commit: normalizeText(metadata.gitCommit) || null,
      changedFiles: Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [],
    },
    verification: {
      commands: Array.isArray(metadata.verifyCommands) ? metadata.verifyCommands : [],
      results: Array.isArray(metadata.verifyResults) ? metadata.verifyResults : [],
      uiCheckReport: normalizeText(metadata.uiCheckReport) || null,
      screenshots: Array.isArray(metadata.uiScreenshots) ? metadata.uiScreenshots : [],
      evidenceAttestations,
      source: evidenceAttestations.length > 0 ? 'structured-attestations' : 'legacy-marker-adapter',
    },
    deployment: {
      resource: normalizeText(metadata.deployment) || null,
      publicHost: normalizeText(metadata.publicHost) || null,
      publicUrl: normalizeText(metadata.publicUrl) || null,
    },
    artifacts: {
      resultFilesManifest: normalizeText(metadata.resultFilesManifest) || null,
    },
    blocker: normalizeText(metadata.blocker) || null,
    agentQuality,
  });
}

function hasTerminalRemoteCliProof(metadata = {}) {
  return metadata?.completionStatus === 'complete' || metadata?.completionStatus === 'blocked';
}

function extractRemoteCliRunMetadata(finalOutput = '') {
  const text = expandRemoteCliProofText(finalOutput);
  const remoteAgentResult = normalizeOptionalProofValue(readMarkerLine(text, ['REMOTE_AGENT_RESULT', 'REMOTE_CLI_STATUS', 'RUN_STATUS']));
  const sessionId = normalizeOptionalProofValue(readMarkerLine(text, ['REMOTE_CLI_SESSION_ID', 'REMOTE_CODE_SESSION_ID']))
    || normalizeOptionalProofValue(text.match(/remote\s+session\s*:\s*`?([^`\s]+)/i)?.[1] || '');
  const jobId = normalizeOptionalProofValue(readMarkerLine(text, ['REMOTE_CLI_JOB_ID', 'REMOTE_CODE_JOB_ID', 'JOB_ID']))
    || normalizeOptionalProofValue(text.match(/(?:job\s*id|jobId|job_id|runId|run_id)\s*[:=]\s*`?([a-z0-9_.:-]{3,128})/i)?.[1] || '');
  const workspace = readMarkerLine(text, ['WORKSPACE', 'REMOTE_WORKSPACE', 'CWD'])
    || cleanMarkerValue(text.match(/workspace\s*:\s*`?([^`\n]+)/i)?.[1] || '');
  const gitRepo = readMarkerLine(text, ['GIT_REPO', 'GIT_REMOTE', 'REPOSITORY'])
    || cleanMarkerValue(text.match(/(?:git\s+repo|repository)\s*:\s*`?([^`\n]+)/i)?.[1] || '');
  const gitBranch = readMarkerLine(text, ['GIT_BRANCH', 'BRANCH'])
    || cleanMarkerValue(text.match(/(?:git\s+branch|branch)\s*:\s*`?([^`\n]+)/i)?.[1] || '');
  const gitBaseCommit = readMarkerLine(text, ['GIT_BASE_COMMIT', 'BASE_COMMIT', 'BASE'])
    || cleanMarkerValue(text.match(/(?:git\s+base\s+commit|base\s+commit|base)\s*:\s*`?([a-f0-9]{7,40})/i)?.[1] || '');
  const gitCommit = readMarkerLine(text, ['GIT_COMMIT', 'COMMIT'])
    || cleanMarkerValue(text.match(/(?:git\s+commit|commit)\s*:\s*`?([a-f0-9]{7,40})/i)?.[1] || '');
  const changedFiles = Array.from(new Set(
    readMarkerLines(text, ['CHANGED_FILES', 'CHANGED_FILE'])
      .flatMap((value) => value.split(','))
      .map((value) => normalizeOptionalProofValue(value))
      .filter(Boolean),
  ));
  const deployment = readMarkerLine(text, ['DEPLOYMENT', 'K8S_DEPLOYMENT']);
  const publicHost = readMarkerLine(text, ['PUBLIC_HOST', 'HOST', 'URL'])
    || cleanMarkerValue(text.match(/https?:\/\/([^/\s`]+)/i)?.[1] || '');
  const publicUrl = normalizeOptionalProofValue(readMarkerLine(text, ['PUBLIC_URL', 'LIVE_URL']));
  const uiCheckReport = readMarkerLine(text, ['UI_CHECK_REPORT']);
  let resultFilesManifest = '';
  const resultFilesManifestMarker = normalizeOptionalProofValue(readMarkerLine(text, [
    'RESULT_FILES_MANIFEST',
    'REMOTE_AGENT_RESULT_FILES_MANIFEST',
  ]));
  if (resultFilesManifestMarker) {
    try {
      resultFilesManifest = normalizeRelativeWorkspacePath(resultFilesManifestMarker);
    } catch (_error) {
      resultFilesManifest = '';
    }
  }
  const uiScreenshots = Array.from(new Set(
    readMarkerLines(text, ['UI_SCREENSHOTS', 'UI_SCREENSHOT'])
      .flatMap((value) => value.split(','))
      .map((value) => cleanMarkerValue(value))
      .filter(Boolean),
  ));
  const whatChanged = normalizeOptionalProofValue(readMarkerLine(text, ['WHAT_CHANGED']));
  const supportAgentRequest = normalizeOptionalProofValue(readMarkerLine(text, [
    'SUPPORT_AGENT_REQUIRED',
    'SUPPORT_AGENT_REQUEST',
    'SUPPORT_NEEDED',
  ]));
  const supportAgentContext = normalizeOptionalProofValue(readMarkerLine(text, [
    'SUPPORT_AGENT_CONTEXT',
    'SUPPORT_CONTEXT',
  ]));
  const verifyCommands = readMarkerLines(text, ['VERIFY_COMMANDS', 'VERIFY_COMMAND'])
    .map((value) => normalizeOptionalProofValue(value))
    .filter(Boolean);
  const verifyResults = readMarkerLines(text, ['VERIFY_RESULTS', 'VERIFY_RESULT'])
    .map((value) => normalizeOptionalProofValue(value))
    .filter(Boolean);
  const blockerMarker = readMarkerLine(text, ['BLOCKER', 'BLOCKED_BY'])
    || readMarkerLine(text, ['USER_INPUT_REQUIRED'])
    || supportAgentRequest
    || detectRemoteCliExecutionBlocker(text);
  const blocker = normalizeOptionalProofValue(blockerMarker);
  const completionStatus = resolveCompletionStatus({
    remoteAgentResult,
    blocker,
    blockerMarker,
    whatChanged,
    verifyResults,
    publicUrl,
    publicHost,
    uiCheckReport,
    gitCommit,
  });

  return {
    ...(remoteAgentResult ? { remoteAgentResult } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(workspace ? { workspace } : {}),
    ...(gitRepo ? { gitRepo } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(gitBaseCommit ? { gitBaseCommit } : {}),
    ...(gitCommit ? { gitCommit } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(deployment ? { deployment } : {}),
    ...(publicHost ? { publicHost } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(uiCheckReport ? { uiCheckReport } : {}),
    ...(resultFilesManifest ? { resultFilesManifest } : {}),
    ...(uiScreenshots.length > 0 ? { uiScreenshots } : {}),
    ...(whatChanged ? { whatChanged } : {}),
    ...(supportAgentRequest ? { supportAgentRequest } : {}),
    ...(supportAgentContext ? { supportAgentContext } : {}),
    ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
    ...(verifyResults.length > 0 ? { verifyResults } : {}),
    ...(blocker ? { blocker } : {}),
    completionStatus,
  };
}

function buildRemoteCliProofDisplay(source = '', metadata = {}) {
  const text = expandRemoteCliProofText(source);
  const lines = [];

  readMarkerLines(text, ['STALE_REMOTE_CLI_JOB_ID'])
    .forEach((value) => pushUniqueLine(lines, `STALE_REMOTE_CLI_JOB_ID=${value}`));

  const remoteAgentResult = metadata.remoteAgentResult || normalizeOptionalProofValue(readMarkerLine(text, ['REMOTE_AGENT_RESULT']));
  if (remoteAgentResult) {
    pushUniqueLine(lines, `REMOTE_AGENT_RESULT=${remoteAgentResult}`);
  }

  if (metadata.sessionId) {
    pushUniqueLine(lines, `REMOTE_CLI_SESSION_ID=${metadata.sessionId}`);
  }
  if (metadata.workspace) {
    pushUniqueLine(lines, `WORKSPACE=${metadata.workspace}`);
  }
  if (metadata.jobId) {
    pushUniqueLine(lines, `REMOTE_CLI_JOB_ID=${metadata.jobId}`);
  }
  if (metadata.gitRepo) {
    pushUniqueLine(lines, `GIT_REPO=${metadata.gitRepo}`);
  }
  if (metadata.gitBranch) {
    pushUniqueLine(lines, `GIT_BRANCH=${metadata.gitBranch}`);
  }
  if (metadata.gitBaseCommit) {
    pushUniqueLine(lines, `GIT_BASE_COMMIT=${metadata.gitBaseCommit}`);
  }
  if (metadata.gitCommit) {
    pushUniqueLine(lines, `GIT_COMMIT=${metadata.gitCommit}`);
  }
  (metadata.changedFiles || []).forEach((value) => {
    pushUniqueLine(lines, `CHANGED_FILES=${value}`);
  });
  if (metadata.deployment) {
    pushUniqueLine(lines, `DEPLOYMENT=${metadata.deployment}`);
  }
  if (metadata.publicHost) {
    pushUniqueLine(lines, `PUBLIC_HOST=${metadata.publicHost}`);
  }
  if (metadata.publicUrl) {
    pushUniqueLine(lines, `PUBLIC_URL=${metadata.publicUrl}`);
  }
  if (metadata.uiCheckReport) {
    pushUniqueLine(lines, `UI_CHECK_REPORT=${metadata.uiCheckReport}`);
  }
  if (metadata.resultFilesManifest) {
    pushUniqueLine(lines, `RESULT_FILES_MANIFEST=${metadata.resultFilesManifest}`);
  }
  if (metadata.whatChanged) {
    pushUniqueLine(lines, `WHAT_CHANGED=${metadata.whatChanged}`);
  }
  if (metadata.supportAgentRequest) {
    pushUniqueLine(lines, `SUPPORT_AGENT_REQUIRED=${metadata.supportAgentRequest}`);
  }
  if (metadata.supportAgentContext) {
    pushUniqueLine(lines, `SUPPORT_AGENT_CONTEXT=${metadata.supportAgentContext}`);
  }
  (metadata.verifyCommands || []).forEach((value) => {
    pushUniqueLine(lines, `VERIFY_COMMANDS=${value}`);
  });
  (metadata.verifyResults || []).forEach((value) => {
    pushUniqueLine(lines, `VERIFY_RESULTS=${value}`);
  });
  if (metadata.blocker) {
    pushUniqueLine(lines, `BLOCKER=${metadata.blocker}`);
  }

  return lines.join('\n');
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

function attachRemoteCodeCallTracker(remoteCli = null, existingState = null) {
  const state = existingState || {
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
  const adminMode = getValueByNormalizedKey(args, ['adminMode', 'admin_mode', 'runnerAdmin', 'runner_admin']);

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
  if (adminMode !== undefined) {
    normalized.adminMode = normalizeBooleanFlag(adminMode, false);
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
  transportLabel = 'remote_code_run',
  transportDescription = 'remote_code_run through the MCP gateway',
} = {}) {
  const source = fragments.map((value) => normalizeText(value)).filter(Boolean).join('\n\n').trim();
  const metadata = extractRemoteCliRunMetadata(source);
  const hasTerminalProof = hasTerminalRemoteCliProof(metadata);
  const isStillRunning = isRunningRemoteCodeStatus(status);
  const runningWithoutTerminalProof = isStillRunning && !hasTerminalProof;
  const explicitBlocker = runningWithoutTerminalProof
    ? normalizeOptionalProofValue(metadata.blocker)
    : normalizeOptionalProofValue(blocker || metadata.blocker);
  const missingProofBlocker = hasTerminalProof
    ? ''
    : `${transportLabel} completed without task proof markers; inspect the agent output and continue with the returned continuity id`;
  const resolvedBlocker = runningWithoutTerminalProof
    ? ''
    : explicitBlocker
    || (isFailedRemoteCodeStatus(status) ? `remote_code_run ${status}` : '')
    || missingProofBlocker;
  const displaySource = runningWithoutTerminalProof ? '' : buildRemoteCliProofDisplay(source, metadata);
  const lines = [displaySource || fallbackVerifyResult || 'remote_code_run completed without text output.'];

  if (runningWithoutTerminalProof && !metadata.remoteAgentResult) {
    lines.push('REMOTE_AGENT_RESULT=running');
  }
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
    lines.push(`WHAT_CHANGED=${runningWithoutTerminalProof
      ? `${transportLabel} is still running; task-level changes have not been proven yet.`
      : hasTerminalProof
      ? (fallbackWhatChanged || `Executed ${transportDescription}.`)
      : `${transportLabel} transport finished, but task-level changes were not proven.`}`);
  }
  if (!Array.isArray(metadata.verifyCommands) || metadata.verifyCommands.length === 0) {
    lines.push(`VERIFY_COMMANDS=${fallbackVerifyCommand || transportLabel}`);
  }
  if (!Array.isArray(metadata.verifyResults) || metadata.verifyResults.length === 0) {
    lines.push(`VERIFY_RESULTS=${fallbackVerifyResult || `${transportLabel} status: ${status || 'unknown'}.`}`);
  }
  if (!metadata.publicUrl) {
    lines.push('PUBLIC_URL=not_available');
  }
  if (!metadata.blocker) {
    lines.push(`BLOCKER=${resolvedBlocker || 'none'}`);
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

function normalizeRemoteCliTransport(value = '') {
  const normalized = normalizeText(value).toLowerCase().replace(/[_\s]+/g, '-');
  if (['codex-agent', 'codexagent', 'codex', 'api', 'sse', 'run-events'].includes(normalized)) {
    return 'codex-agent';
  }
  if (['mcp', 'remote-code', 'remote-code-run', 'remote-code-mcp'].includes(normalized)) {
    return 'mcp';
  }
  if (['provider-agent', 'provideragent', 'provider-cli', 'model-cli'].includes(normalized)) {
    return 'provider-agent';
  }
  if (normalized === 'auto') {
    return 'auto';
  }
  return normalized || 'mcp';
}

function resolveRemoteCliTransport(input = {}, runnerConfig = {}) {
  const inputTransport = normalizeText(
    input.transport
    || input.runnerTransport
    || input.remoteCliTransport
    || input.remote_cli_transport,
  );
  const requested = normalizeRemoteCliTransport(
    inputTransport
    || runnerConfig.transport
    || 'auto',
  );
  const selectedProvider = resolveProviderAgentSelection(
    input.requestedModel
    || input.requested_model
    || input.model,
  );
  if (!inputTransport && selectedProvider
    && (selectedProvider.providerId !== 'codex-cli' || requested === 'provider-agent')) {
    return 'provider-agent';
  }
  if (requested === 'auto') {
    return normalizeText(input.codexAgentBaseUrl || runnerConfig.codexAgentBaseUrl)
      && normalizeText(input.codexAgentApiKey || runnerConfig.codexAgentApiKey)
      ? 'codex-agent'
      : 'mcp';
  }
  if (requested === 'provider-agent') {
    return 'provider-agent';
  }
  return requested === 'codex-agent' ? 'codex-agent' : 'mcp';
}

function resolveProviderAgentSelection(model = '') {
  const requestedModel = normalizeText(model);
  const normalized = requestedModel.toLowerCase();
  if (!normalized || normalized === 'auto') {
    return null;
  }
  if (/(?:^|[\/_-])grok(?:[\/_-]|$)|\bxai\b/.test(normalized)) {
    return {
      providerId: 'grok-build-cli',
      providerLabel: 'Grok Build',
      requestedModel,
      providerModel: 'grok-build',
    };
  }
  const hasKimiMarker = /(?:^|[\s\/_-])kimi(?:[\s\/_-]|$)|moonshot/.test(normalized);
  const isKimiK3 = /^k3(?:[\s\/_-]|$)/.test(normalized)
    || (hasKimiMarker && /(?:^|[\s\/_-])k?3(?:[\s\/_-]|$)/.test(normalized));
  if (hasKimiMarker || isKimiK3) {
    return {
      providerId: 'kimi-code-cli',
      providerLabel: 'Kimi CLI',
      requestedModel,
      providerModel: isKimiK3 ? 'k3' : 'kimi-for-coding',
    };
  }
  if (/^(?:gpt|o[134])(?:[\s\/_-]|$)|(?:^|[\s\/_-])(?:openai|codex)(?:[\s\/_-]|$)/.test(normalized)) {
    return {
      providerId: 'codex-cli',
      providerLabel: 'Codex',
      requestedModel,
      providerModel: requestedModel,
    };
  }
  return null;
}

function resolveProviderAgentContinuationSessionId(selection = null, sessionId = '') {
  if (!['codex-cli', 'grok-build-cli'].includes(selection?.providerId)) {
    return '';
  }
  const normalized = normalizeText(sessionId);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : '';
}

function buildProviderAgentTask({
  task = '',
  providerLabel = 'CLI provider',
  requestedModel = '',
  continuitySummary = '',
  handoff = null,
} = {}) {
  const handoffPrompt = buildRemoteAgentHandoffPrompt(handoff);
  return [
    `Use ${providerLabel} for this remote coding task.`,
    requestedModel ? `The model selected in the KimiBuilt header is ${requestedModel}.` : '',
    '',
    'User task:',
    task,
    '',
    'Completion contract:',
    '- Baseline the active target and workspace before any mutation.',
    '- Keep changes scoped, preserve unrelated git work, and verify the actual deployed surface when deployment is requested.',
    '- For UI work, run browser/Playwright or kimibuilt-ui-check proof before claiming success.',
    '- Finish with marker lines: WHAT_CHANGED=<summary>, VERIFY_COMMANDS=<commands>, VERIFY_RESULTS=<results>, PUBLIC_URL=<url or not_available>, BLOCKER=<none or exact blocker>.',
    '- Include Git and deployment continuity markers when known.',
    '- The final marker must be REMOTE_AGENT_RESULT: success <summary> or REMOTE_AGENT_RESULT: failed <reason>.',
    handoffPrompt,
    continuitySummary ? 'Prior verified continuity context:' : '',
    continuitySummary,
  ].filter(Boolean).join('\n');
}

function normalizeProviderAgentOutput(value = '') {
  return String(value || '')
    .replace(
      /(^|\n)(\s*(?:[-*]\s*)?)(?:\*\*|__)?REMOTE_AGENT_RESULT(?:(?:\*\*|__)\s*)?[:=]\s*(success|failed)\b/gi,
      '$1$2REMOTE_AGENT_RESULT=$3',
    );
}

function readProviderAgentResultStatus(value = '') {
  const terminalText = String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
  return terminalText.match(PROVIDER_AGENT_RESULT_PATTERN)?.[1]?.toLowerCase() || '';
}

function resolveCodexAgentBaseUrl(input = {}, runnerConfig = {}) {
  const direct = normalizeText(
    input.codexAgentBaseUrl
    || input.codex_agent_base_url
    || runnerConfig.codexAgentBaseUrl,
  );
  if (direct) {
    return direct.replace(/\/+$/, '');
  }

  const mcpUrl = normalizeText(input.url || runnerConfig.url);
  if (mcpUrl) {
    return mcpUrl.replace(/\/mcp\/?$/i, '').replace(/\/+$/, '');
  }

  return '';
}

function resolveCodexAgentApiKey(input = {}, runnerConfig = {}) {
  return normalizeText(
    input.codexAgentApiKey
    || input.codex_agent_api_key
    || input.codexAgentBearerToken
    || input.codex_agent_bearer_token
    || runnerConfig.codexAgentApiKey
    || runnerConfig.apiKey,
  );
}

function buildCodexAgentUrl(baseUrl = '', path = '') {
  const base = normalizeText(baseUrl).replace(/\/+$/, '');
  const suffix = `/${normalizeText(path).replace(/^\/+/, '')}`;
  return `${base}${suffix}`;
}

function resolveRemoteAgentHandoffAcknowledgement(startBody = {}, handoff = null) {
  if (!handoff) {
    return null;
  }
  const acknowledgement = startBody?.handoff
    || startBody?.task?.handoff
    || startBody?.handoffAcknowledgement
    || null;
  const version = normalizeText(acknowledgement?.version);
  const operationId = normalizeText(acknowledgement?.operationId);
  const inputManifestPath = normalizeText(
    acknowledgement?.inputManifestPath || acknowledgement?.manifestPath,
  );
  const resultManifestPath = normalizeText(acknowledgement?.resultManifestPath);
  if (acknowledgement?.accepted !== true
    || version !== handoff.version
    || operationId !== handoff.operationId
    || inputManifestPath !== handoff.manifestPath
    || (handoff.output?.enabled && resultManifestPath !== handoff.output.manifestPath)) {
    const error = new Error('The remote gateway did not acknowledge the requested artifact handoff contract and isolated paths.');
    error.code = 'REMOTE_AGENT_HANDOFF_NOT_ACKNOWLEDGED';
    throw error;
  }

  const resultFilesUrl = normalizeText(
    startBody?.resultFilesUrl
    || startBody?.task?.resultFilesUrl
    || acknowledgement?.resultFilesUrl,
  );
  if (handoff.output?.enabled && !resultFilesUrl) {
    const error = new Error('The remote gateway acknowledged the handoff but did not return a result-files endpoint.');
    error.code = 'REMOTE_AGENT_RESULT_FILES_URL_MISSING';
    throw error;
  }
  return {
    version,
    operationId,
    inputManifestPath,
    resultManifestPath: resultManifestPath || null,
    resultFilesUrl: resultFilesUrl || null,
  };
}

function buildSameOriginGatewayUrl(baseUrl = '', value = '') {
  const absoluteUrl = new URL(value, `${trimTrailingSlash(baseUrl)}/`).toString();
  if (new URL(absoluteUrl).origin !== new URL(baseUrl).origin) {
    const error = new Error('Remote agent result-files URL must use the configured gateway origin.');
    error.code = 'REMOTE_AGENT_RESULT_FILES_CROSS_ORIGIN';
    throw error;
  }
  return absoluteUrl;
}

function applyRemoteAgentResultFilesOutcome(metadata = {}, handoff = null, resultFiles = null, error = null) {
  if (!handoff?.output?.enabled) {
    return metadata;
  }
  const resultFilesError = error
    ? `Remote agent result files were not returned safely: ${error.message}`
    : !Array.isArray(resultFiles?.files) || resultFiles.files.length === 0
      ? 'Remote agent result files were requested, but the verified result contained no files.'
      : '';
  if (!resultFilesError) {
    return {
      ...metadata,
      resultFilesManifest: normalizeText(resultFiles.manifestPath) || handoff.output.manifestPath,
    };
  }
  const verifyResults = Array.isArray(metadata.verifyResults) ? metadata.verifyResults : [];
  return {
    ...metadata,
    resultFilesManifest: normalizeText(resultFiles?.manifestPath) || handoff.output.manifestPath,
    resultFilesError,
    verifyResults: [...verifyResults, resultFilesError],
    blocker: metadata.blocker || resultFilesError,
    completionStatus: 'blocked',
  };
}

function parseSseEventFrames(buffer = '', onEvent = () => {}) {
  const normalizedBuffer = String(buffer || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const frames = normalizedBuffer.split('\n\n');
  const remainder = frames.pop() || '';

  for (const frame of frames) {
    let eventName = '';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^\s/, ''));
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    const rawData = dataLines.join('\n');
    let payload = {};
    try {
      payload = JSON.parse(rawData);
    } catch (_error) {
      payload = { message: rawData };
    }
    onEvent({
      ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { data: payload }),
      event: normalizeText(payload?.event || eventName || 'message'),
    });
  }

  return remainder;
}

function extractCodexAgentEventText(event = {}) {
  return normalizeText(
    event.text
    || event.message
    || event.result?.output_text
    || event.result?.outputText
    || event.result?.text
    || event.result?.message
    || event.error,
  );
}

function summarizeCodexAgentEvent(event = {}) {
  const eventName = normalizeText(event.event || 'event');
  const text = extractCodexAgentEventText(event);
  if (text) {
    return `${eventName}: ${text.slice(0, 1200)}`;
  }
  if (eventName === 'session_started') {
    return `session_started: ${normalizeText(event.session_id || event.sessionId || event.thread_id || event.threadId)}`;
  }
  return eventName;
}

function isCodexAgentTerminalEvent(event = {}) {
  return CODEX_AGENT_TERMINAL_EVENTS.has(normalizeText(event.event));
}

function codexAgentStatusToTerminalEvent(status = '') {
  switch (normalizeText(status)) {
    case 'completed':
      return 'turn_completed';
    case 'failed':
      return 'turn_failed';
    case 'cancelled':
      return 'turn_cancelled';
    case 'input_required':
      return 'turn_input_required';
    default:
      return '';
  }
}

function buildCodexAgentPrompt({
  task = '',
  workspacePath = '',
  priorThreadId = '',
  adminMode = false,
  continuitySummary = '',
  supportAgentResponse = '',
  handoff = null,
  gitProvider = resolveConfiguredGitProviderContext(),
} = {}) {
  const gitProviderLines = gitProvider?.configured ? [
    `- Configured Git provider: ${gitProvider.provider} at ${gitProvider.baseURL} (group/org: ${gitProvider.org}).`,
    gitProvider.hasToken
      ? '- A server-side Git provider token is configured for this workflow. Prefer non-interactive HTTPS auth using existing environment variables, an installed credential helper, or a repo-local askpass helper; do not ask the user for a GitLab token before checking those paths.'
      : '- No server-side Git provider token is visible to this workflow. If GitLab push/repo creation is required, commit locally and report the exact missing Git credential/API capability.',
    '- When GitLab is the configured provider, prefer HTTPS remotes on that host over SSH prompts for automated saves and pushes.',
  ] : [
    '- No configured Git provider is visible to this workflow. Keep source changes committed locally and report the missing Git provider configuration if a push is required.',
  ];

  return [
    'Codex-agent execution contract:',
    '- You are running through the KimiBuilt /api/codex-agent/run gateway contract, which mirrors the router-side Codex app-server bridge: POST /api/codex-agent/run starts a turn and GET /api/codex-agent/runs/:runId/events streams progress.',
    '- Treat this as the primary stateful remote-agent lane. Do not use MCP, remote_code_run, or remote_code_status inside this Codex-agent run.',
    workspacePath ? `- Your process cwd is the checked-out workspace "${workspacePath}".` : '',
    priorThreadId ? `- Continue prior Codex thread "${priorThreadId}" when relevant.` : '',
    priorThreadId ? '- Keep that thread id as the durable continuation handle and report it as REMOTE_CLI_SESSION_ID when the run finishes.' : '- If a thread id is available during the run, treat it as the durable continuation handle and report it as REMOTE_CLI_SESSION_ID when the run finishes.',
    adminMode ? '- Admin runner mode was requested. Keep privilege use scoped to the task and stop on repeated blocked commands.' : '',
    '- Work in the current workspace. Do not ask for SSH details unless the task explicitly needs a separate server not represented by this workspace.',
    '- Remote Ops baseline-first rule: before mutating files, cluster resources, services, deploys, or public routes, run a read-only baseline for the active target or workspace. Capture host/workspace identity, user, architecture, OS release, uptime, git status, and k3s/kubectl readiness when relevant.',
    '- Keep primary and secondary servers separate. Label which target, workspace, namespace, deployment, and public host you are using, re-baseline when switching targets, and never use proof from one server as proof for the other.',
    '- You are executing inside the remote Codex-agent gateway/container, not on the user desktop. Treat localhost and 127.0.0.1 as this runner container only; they are not the public app, the user local server, or proof of the live remote site.',
    '- For live remote verification, prefer the explicit public URL, Kubernetes service DNS, kubectl in the target namespace, or a clearly identified KimiBuilt tunnel endpoint. Use localhost only when the user explicitly asks for a local dev-server check or when you clearly label it as runner-local diagnostics.',
    'Git provider/source-control contract:',
    ...gitProviderLines,
    '- Inspect before editing, keep changes scoped, and verify the exact requested path.',
    '- For long work, emit concise milestone messages as normal assistant output before or after major phases such as inspect, edit, build/test, deploy, and verify. These messages are streamed through /events for the outer agent; do not wait silently until the final answer.',
    '- If the work touches web-chat, managed-app previews, generated HTML artifacts, TTS, document rendering, websites, dashboards, or frontend UI, do not claim success from code or pod health alone. Run browser/Playwright evidence or `node /app/bin/kimibuilt-ui-check.js <url> --out ui-checks` when available, and report UI_CHECK_REPORT/UI_SCREENSHOTS. If UI proof cannot run, BLOCKER must say exactly why.',
    '- Do not call outer KimiBuilt tools from inside this run. Do not invent remote_code_run, remote_code_status, command, shell, executable, or args payloads here; use the workspace tools available to this Codex process.',
    '- If you need a second opinion, research/check help, or decomposition help from a support agent to finish the task, stop with marker lines SUPPORT_AGENT_REQUIRED=<precise question or help request>, SUPPORT_AGENT_CONTEXT=<workspace facts, files, commands, and blocker>, REMOTE_CLI_SESSION_ID=<thread id if known>, WORKSPACE=<path>, WHAT_CHANGED=<current progress>, VERIFY_COMMANDS=not_available, VERIFY_RESULTS=support agent needed, PUBLIC_URL=not_available, BLOCKER=support agent needed.',
    '- Do not use SUPPORT_AGENT_REQUIRED for decisions only the user can make; use USER_INPUT_REQUIRED for user choices, credentials, approvals, or product direction.',
    supportAgentResponse ? 'Support agent response for this continuation:' : '',
    supportAgentResponse,
    '- Finish with proof marker lines: WHAT_CHANGED=<short summary>, VERIFY_COMMANDS=<commands run or not_available>, VERIFY_RESULTS=<pass/fail/blocked results>, PUBLIC_URL=<https URL or not_available>, BLOCKER=<none or exact blocker>.',
    '- Include continuity markers when known: REMOTE_CLI_SESSION_ID=<thread/session id>, WORKSPACE=<path>, GIT_REPO=<origin>, GIT_BRANCH=<branch>, GIT_BASE_COMMIT=<sha>, GIT_COMMIT=<sha>, CHANGED_FILES=<comma-separated files>, DEPLOYMENT=<namespace/name>, PUBLIC_HOST=<host>, UI_CHECK_REPORT=<path>, UI_SCREENSHOTS=<comma-separated paths>, RESULT_FILES_MANIFEST=<workspace-relative path>, SUPPORT_AGENT_REQUIRED=<help request or none>, SUPPORT_AGENT_CONTEXT=<context or none>.',
    buildRemoteAgentHandoffPrompt(handoff),
    continuitySummary ? 'Remote project continuity context:' : '',
    continuitySummary,
    '',
    'User task:',
    task,
  ].filter(Boolean).join('\n');
}

function summarizeUrl(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
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

function isStaleMcpSessionError(error) {
  const summary = summarizeRemoteCliError(error);
  const parts = [
    summary.message,
    summary.responseMessage,
    summary.causeMessage,
    error?.message,
    error?.body?.error?.message,
    error?.body?.message,
  ];
  return parts.some((part) => /\bsession\s+not\s+found\b|\binvalid\s+session\b|\bunknown\s+session\b/i.test(String(part || '')));
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
  const codexAgentBaseURL = normalizeText(runnerConfig.codexAgentBaseUrl);
  const codexAgentApiKey = resolveCodexAgentApiKey({}, runnerConfig);
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
  if (errorSummary.statusCode === 401 || errorSummary.statusCode === 403 || /\bunauthori[sz]ed\b|\bforbidden\b/i.test(errorSummary.message)) {
    hintParts.push('The gateway rejected the bearer token; verify REMOTE_CLI_MCP_BEARER_TOKEN/N8N_API_KEY for MCP transport or REMOTE_CLI_CODEX_AGENT_BEARER_TOKEN/FRONTEND_API_KEY for codex-agent transport.');
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
      codexAgentBaseURL: summarizeUrl(codexAgentBaseURL) || null,
      agentBaseURL: summarizeUrl(agentBaseURL) || null,
      hasMcpToken: Boolean(normalizeText(runnerConfig.apiKey)),
      mcpTokenFingerprint: maskSecretValue(runnerConfig.apiKey),
      hasCodexAgentApiKey: Boolean(codexAgentApiKey),
      codexAgentApiKeyFingerprint: maskSecretValue(codexAgentApiKey),
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

function resolveConfiguredGitProviderContext(runnerConfig = {}) {
  const explicitGitProvider = runnerConfig.gitProvider
    || runnerConfig.gitlab
    || runnerConfig.gitea
    || null;
  const gitProvider = explicitGitProvider || (typeof settingsController.getEffectiveGitProviderConfig === 'function'
    ? settingsController.getEffectiveGitProviderConfig()
    : (typeof settingsController.getEffectiveGitLabConfig === 'function'
      ? settingsController.getEffectiveGitLabConfig()
      : (config.gitlab || config.gitea || {})));

  const provider = normalizeText(gitProvider.provider || (explicitGitProvider === runnerConfig.gitea ? 'gitea' : 'gitlab')) || 'gitlab';
  const baseURL = normalizeText(gitProvider.baseURL || gitProvider.baseUrl);
  const org = normalizeText(gitProvider.org || gitProvider.group) || 'agent-apps';
  return {
    provider,
    configured: Boolean(gitProvider.enabled !== false && baseURL),
    baseURL,
    org,
    registryHost: normalizeText(gitProvider.registryHost),
    hasToken: Boolean(normalizeText(gitProvider.token || gitProvider.apiKey || process.env.GITLAB_TOKEN || process.env.GITEA_TOKEN)),
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
  remoteCodeModel = DEFAULT_REMOTE_CODE_MODEL,
  extraInstructions = '',
  gitea = resolveConfiguredGitProviderContext(),
  continuitySummary = '',
} = {}) {
  return [
    'You can modify the remote server using the remote-cli MCP tools.',
    '',
    'You are already inside KimiBuilt `remote-cli-agent`. Do not try to call outer KimiBuilt tools such as `remote-command`, `k3s-deploy`, or `tool-doc-read` from here.',
    'If the task text mentions `remote-cli-agent`, treat that as the already-selected outer KimiBuilt tool, not as a command, binary, package, or script to run on the target host.',
    'Your remote execution boundary is the MCP gateway: use `remote_code_run` to start coding/build/deploy work and `remote_code_status` to poll any returned job id.',
    '',
    'Use remote_code_run for coding tasks.',
    'Tool shape: call remote_code_run with {"targetId":"<gateway target id>","cwd":"<workspace path>","task":"<clear task>","model":"<supported model>","sessionId":"<optional prior sessionId>","waitMs":30000}. Include the configured model when provided.',
    'Then poll with remote_code_status using only {"jobId":"<job id from remote_code_run>"}. Do not send command, args, executable, shell, targetId, cwd, sessionId, or waitMs to remote_code_status.',
    'Do not send raw command execution fields to remote_code_run. The allowed execution fields are targetId, cwd, task, model, sessionId, and waitMs.',
    `Default targetId: ${targetId}`,
    cwd ? `Default cwd: ${cwd}` : 'Default cwd: use the gateway target default.',
    remoteCodeModel ? `Configured remote_code_run model: ${remoteCodeModel}. Use this exact model for remote_code_run calls.` : '',
    '',
    'The targetId is the remote-cli gateway target identifier, not a Git remote, URL, or raw user@host SSH string. Use the configured default targetId unless the user explicitly names another configured gateway target.',
    'Public Git hosts such as github.com, gitlab.com, and bitbucket.org are repository endpoints, never deployment SSH targets. If a transcript mentions a root@github.com permission failure, treat that as the previous mistake and retarget to the real server/gateway target described by the user.',
    'Treat the target as a persistent private workbench for the user: create project files, inspect state, build, test, deploy, and verify from the remote workspace when the task calls for it.',
    'Keep autonomy bounded by the task and existing safety rules. Do not mutate secrets, perform destructive deletes, force-push, install privileged packages, or leave the approved workspace without a clear user request.',
    'Start with compact discovery before edits: repo-map, changed-files, k8s-manifest-summary, and targeted-grep style commands are preferred over reading the whole codebase.',
    'Baseline-first remote ops rule: before mutating files, cluster resources, services, deploys, or public routes, run a read-only baseline for the active target/workspace. Capture host/workspace identity, user, architecture, OS release, uptime, git status, and k3s/kubectl readiness when relevant.',
    'Keep primary and secondary remote targets separate. Label which target, workspace, namespace, deployment, and public host you are using, re-baseline when switching targets, and never use proof from one server as proof for the other.',
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
    'For web-chat, managed-app previews, generated HTML artifacts, TTS, document rendering, website, dashboard, or frontend work, include visual QA in the build package: run Playwright/Chromium screenshots or `node /app/bin/kimibuilt-ui-check.js <url> --out ui-checks` for desktop and mobile states when the target exposes a local preview, public URL, or KimiBuilt tunnel endpoint.',
    'For website, dashboard, app, landing-page, and frontend mockup work, apply the Impressive Frontend Websites standard: infer a compact brief, make the first viewport specific to the product or workflow, build the usable experience instead of a generic placeholder, include real controls/states/interactions, and use assets that reveal the actual product, place, audience, workflow, or state.',
    'Design with restraint and specificity: avoid one-note palettes, oversized rounded/nested cards, decorative blobs, clipped text, horizontal overflow, broken image paths, and unreadable dropdown/menu/popover/dialog/tooltip states.',
    'After the first working screenshot, make at least one refinement pass for non-trivial frontend builds; fix layout, contrast, asset, interaction, and responsive issues before deploying or calling the UI ready.',
    'If the KimiBuilt runner helper is present, prefer `node /app/bin/kimibuilt-ui-check.js <url> --out ui-checks` and inspect its JSON report before claiming the UI is ready.',
    buildAgentQualityContractText(['website-experience', 'remote-deployment', 'document-artifact']),
    'Report screenshot and report paths with marker lines when known: UI_CHECK_REPORT=<path> and UI_SCREENSHOTS=<comma-separated paths>.',
    `For long tasks, call remote_code_run with waitMs: ${waitMs}.`,
    'If it returns status "running", call remote_code_status with the returned jobId only.',
    'If continuing prior work, reuse the returned sessionId.',
    sessionId ? `Current prior remote CLI sessionId: ${sessionId}` : '',
    continuitySummary ? 'Remote project continuity context from previous verified KimiBuilt work:' : '',
    continuitySummary,
    'When the task includes an "Original task" and a "Current user follow-up", preserve the original task as the governing objective. Treat the follow-up as steering or continuation, not as a replacement status request.',
    'Do not let progress callbacks, foreground plan labels, or status-card text become the task. Finish the requested work and only stop for USER_INPUT_REQUIRED when a real user decision is needed.',
    'Do not try to pass raw shell commands; only use the exposed tool schema.',
    'Finish every run with completion proof marker lines: WHAT_CHANGED=<short summary>, VERIFY_COMMANDS=<commands run or not_available>, VERIFY_RESULTS=<pass/fail/blocked results>, PUBLIC_URL=<https URL or not_available>, and BLOCKER=<none or exact blocker>. Use one VERIFY_COMMANDS or VERIFY_RESULTS line per distinct command/result when useful.',
    'Also finish with marker lines for continuity when known: REMOTE_CLI_SESSION_ID=<remote_code_run sessionId>, WORKSPACE=<path>, GIT_REPO=<origin or local repo>, GIT_BRANCH=<branch>, GIT_BASE_COMMIT=<sha>, GIT_COMMIT=<sha>, CHANGED_FILES=<comma-separated files>, DEPLOYMENT=<namespace/name>, PUBLIC_HOST=<host>, UI_CHECK_REPORT=<path>, UI_SCREENSHOTS=<comma-separated paths>.',
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
  continuitySummary = '',
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
    continuitySummary ? 'Remote project continuity context:' : '',
    continuitySummary,
  ].filter(Boolean).join('\n');
}

function buildDirectRemoteCodeTask({
  task,
  targetId,
  cwd,
  sessionId = '',
  adminMode = false,
  continuitySummary = '',
} = {}) {
  return [
    'Direct remote execution contract:',
    `- You are already executing through the KimiBuilt remote_code_run gateway target "${targetId}".`,
    cwd ? `- The gateway has placed you in the remote workspace "${cwd}".` : '- Use the gateway target default workspace.',
    sessionId ? `- Continue the prior remote CLI session "${sessionId}" when relevant.` : '',
    adminMode ? '- Admin runner mode is enabled for this task. Live deployment, HTTP, and Kubernetes verification are allowed when scoped to the requested app/workspace.' : '',
    '- Treat references to "remote", "server", "site", or "remote into the server" as instructions to work inside this current gateway target and workspace.',
    '- Do not say that you cannot access the remote server. Do not ask the user for SSH details. Do not provide SSH instructions as the answer.',
    '- Use the local shell/tools available in this remote execution environment to inspect, edit, build, deploy, and verify as the task requires.',
    '- Baseline first: before mutating files, cluster resources, services, deploys, or public routes, run a read-only baseline for the active target/workspace. Capture host/workspace identity, user, architecture, OS release, uptime, git status, and k3s/kubectl readiness when relevant.',
    '- Keep primary and secondary targets separate. Re-baseline when switching targets and never use proof from one server as proof for the other.',
    '- Keep changes scoped to the requested workspace and task. Avoid destructive operations and secret changes unless explicitly requested.',
    '- If the work touches web-chat, managed-app previews, generated HTML artifacts, TTS, document rendering, websites, dashboards, or frontend UI, require browser/Playwright or `kimibuilt-ui-check` evidence before claiming success; otherwise report the missing UI proof as BLOCKER.',
    buildAgentQualityContractText(['website-experience', 'remote-deployment', 'document-artifact']),
    '- Finish with proof marker lines: WHAT_CHANGED=<short summary>, VERIFY_COMMANDS=<commands run or not_available>, VERIFY_RESULTS=<pass/fail/blocked results>, PUBLIC_URL=<https URL or not_available>, BLOCKER=<none or exact blocker>.',
    '- Include continuity markers when known: REMOTE_CLI_SESSION_ID=<session id>, WORKSPACE=<path>, REMOTE_CLI_JOB_ID=<job id if known>, GIT_REPO=<origin>, GIT_BRANCH=<branch>, GIT_BASE_COMMIT=<sha>, GIT_COMMIT=<sha>, CHANGED_FILES=<comma-separated files>, DEPLOYMENT=<namespace/name>, PUBLIC_HOST=<host>, UI_CHECK_REPORT=<path>, UI_SCREENSHOTS=<comma-separated paths>, and any requested REMOTE_AGENT_RESULT=<value>.',
    continuitySummary ? 'Remote project continuity context:' : '',
    continuitySummary,
    '',
    'User task:',
    task,
  ].filter(Boolean).join('\n');
}

class RemoteCliAgentsSdkRunner {
  constructor(options = {}) {
    this.sdkLoader = options.sdkLoader || loadAgentsSdk;
    this.config = options.config || config.remoteCliMcp || {};
    this.fetch = options.fetchImpl || global.fetch;
  }

  getPublicConfig() {
    const requestedTransport = normalizeRemoteCliTransport(this.config.transport || 'auto');
    const transport = resolveRemoteCliTransport({}, this.config);
    const codexAgentBaseUrl = resolveCodexAgentBaseUrl({}, this.config);
    const codexAgentApiKey = resolveCodexAgentApiKey({}, this.config);
    return {
      enabled: this.config.enabled !== false,
      configured: transport === 'codex-agent'
        ? Boolean(codexAgentBaseUrl && codexAgentApiKey)
        : Boolean(normalizeText(this.config.url) && normalizeText(this.config.apiKey)),
      transport,
      requestedTransport,
      url: normalizeText(this.config.url),
      codexAgentBaseUrl,
      codexAgentConfigured: Boolean(codexAgentBaseUrl && codexAgentApiKey),
      name: normalizeText(this.config.name) || 'remote-cli',
      defaultTargetId: resolveRemoteCliTargetId('', this.config.defaultTargetId || 'prod'),
      defaultCwd: normalizeText(this.config.defaultCwd),
      codexAgentWorkspacePath: normalizeText(this.config.codexAgentWorkspacePath),
      codexAgentModel: normalizeText(this.config.codexAgentModel),
      agentModel: normalizeText(this.config.agentModel),
      remoteCodeModel: normalizeText(this.config.remoteCodeModel) || DEFAULT_REMOTE_CODE_MODEL,
      directRun: this.config.directRun !== false,
      timeoutMs: normalizePositiveInteger(this.config.timeoutMs, 60000, { min: 1000 }),
      maxTurns: normalizePositiveInteger(this.config.maxTurns, 20, { min: 1, max: 80 }),
      agentRunTimeoutMs: normalizePositiveInteger(this.config.agentRunTimeoutMs, DEFAULT_AGENT_RUN_TIMEOUT_MS, { min: 1, max: 900000 }),
      maxStatusPolls: normalizePositiveInteger(this.config.maxStatusPolls, DEFAULT_MAX_STATUS_POLLS, { min: 1, max: 240 }),
      statusPollIntervalMs: normalizePositiveInteger(this.config.statusPollIntervalMs, DEFAULT_STATUS_POLL_INTERVAL_MS, { min: 0, max: 30000 }),
    };
  }

  assertConfigured({ transport = 'mcp', input = {} } = {}) {
    if (this.config.enabled === false) {
      throw new Error('Remote CLI MCP integration is disabled.');
    }
    if (transport === 'codex-agent' || transport === 'provider-agent') {
      if (typeof this.fetch !== 'function') {
        throw new Error(`Fetch is required for remote-cli-agent ${transport} transport.`);
      }
      if (!resolveCodexAgentBaseUrl(input, this.config)) {
        throw new Error(`REMOTE_CLI_CODEX_AGENT_BASE_URL, CODEX_AGENT_BASE_URL, or GATEWAY_URL is required for remote-cli-agent ${transport} transport.`);
      }
      if (!resolveCodexAgentApiKey(input, this.config)) {
        throw new Error(`REMOTE_CLI_CODEX_AGENT_BEARER_TOKEN, CODEX_AGENT_API_KEY, FRONTEND_API_KEY, or REMOTE_CLI_MCP_BEARER_TOKEN is required for remote-cli-agent ${transport} transport.`);
      }
      return;
    }
    if (!normalizeText(this.config.url)) {
      throw new Error('REMOTE_CLI_MCP_URL or GATEWAY_URL is required for remote-cli-agent.');
    }
    if (!normalizeText(this.config.apiKey)) {
      throw new Error('REMOTE_CLI_MCP_BEARER_TOKEN or N8N_API_KEY is required for remote-cli-agent.');
    }
    if (this.config.directRun === false && !normalizeText(this.config.agentApiKey)) {
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

  async readJsonResponse(response) {
    const text = typeof response?.text === 'function' ? await response.text() : '';
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (_error) {
      return { message: text };
    }
  }

  async fetchRemoteAgentResultFiles({
    baseUrl = '',
    apiKey = '',
    acknowledgement = null,
    signal = null,
  } = {}) {
    if (!acknowledgement?.resultFilesUrl) {
      return null;
    }
    const resultFilesUrl = buildSameOriginGatewayUrl(baseUrl, acknowledgement.resultFilesUrl);
    const response = await this.fetch(resultFilesUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      ...(signal ? { signal } : {}),
    });
    const body = await this.readJsonResponse(response);
    if (!response?.ok) {
      const error = new Error(
        normalizeText(body?.error || body?.message)
        || `remote agent result-files request failed with status ${response?.status || 'unknown'}`,
      );
      error.code = 'REMOTE_AGENT_RESULT_FILES_FETCH_FAILED';
      error.status = response?.status;
      throw error;
    }
    return body;
  }

  async consumeCodexAgentEvents(response, {
    onEvent = () => {},
    signal = null,
  } = {}) {
    if (response?.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          if (signal?.aborted) {
            throw new Error('codex-agent run aborted.');
          }
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          buffer = parseSseEventFrames(buffer, onEvent);
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          parseSseEventFrames(`${buffer}\n\n`, onEvent);
        }
      } finally {
        reader.releaseLock?.();
      }
      return;
    }

    if (typeof response.text === 'function') {
      parseSseEventFrames(await response.text(), onEvent);
      return;
    }

    if (!response?.body) {
      throw new Error('codex-agent events response did not include a readable body.');
    }

    throw new Error('codex-agent events response body is unreadable.');
  }

  async executeCodexAgentRun({
    input = {},
    targetId = 'prod',
    cwd = '',
    task = '',
    model = '',
    sessionId = '',
    agentRunTimeoutMs = DEFAULT_AGENT_RUN_TIMEOUT_MS,
    maxStatusPolls = DEFAULT_MAX_STATUS_POLLS,
    statusPollIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS,
    adminMode = false,
    continuitySummary = '',
    onProgress = null,
  } = {}) {
    const baseUrl = resolveCodexAgentBaseUrl(input, this.config);
    const apiKey = resolveCodexAgentApiKey(input, this.config);
    const workspacePath = normalizeText(
      input.workspacePath
      || input.workspace_path
      || input.codexAgentWorkspacePath
      || input.codex_agent_workspace_path
      || cwd
      || this.config.codexAgentWorkspacePath
      || this.config.defaultCwd,
    );
    const priorThreadId = normalizeText(
      input.threadId
      || input.thread_id
      || input.codexThreadId
      || input.codex_thread_id
      || '',
    );
    const handoff = input.handoff || null;
    if (!workspacePath) {
      throw new Error('remote-cli-agent codex-agent transport requires cwd, workspacePath, or REMOTE_CLI_CODEX_AGENT_WORKSPACE_PATH.');
    }

    const timeoutMs = normalizePositiveInteger(agentRunTimeoutMs, DEFAULT_AGENT_RUN_TIMEOUT_MS, { min: 1, max: 900000 });
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }

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
          codexAgentEvent: extra.event || null,
          toolEvents: [{
            toolId: 'remote-cli-agent',
            stage: extra.stage || 'in_progress',
            detail,
            transport: 'codex-agent',
            ...(extra.event ? { event: extra.event.event || null, cursor: extra.event.cursor || null } : {}),
          }],
        });
      } catch (error) {
        console.warn('[RemoteCliAgentsSdkRunner] Failed to emit codex-agent progress:', error?.message || error);
      }
    };

    const runBody = {
      workspacePath,
      prompt: buildCodexAgentPrompt({
        task,
        workspacePath,
        priorThreadId,
        adminMode,
        gitProvider: resolveConfiguredGitProviderContext(this.config),
        continuitySummary: continuitySummary || normalizeText(input.continuitySummary || input.remoteProjectContext || input.remote_project_context),
        supportAgentResponse: normalizeText(input.supportAgentResponse || input.support_agent_response || input.supportAgentNotes || input.support_agent_notes),
        handoff,
      }),
      continuation: Boolean(priorThreadId),
      ...(priorThreadId ? { threadId: priorThreadId } : {}),
      config: {
        approvalPolicy: normalizeText(input.approvalPolicy || this.config.codexAgentApprovalPolicy) || 'never',
        threadSandbox: adminMode
          ? (normalizeText(input.threadSandbox || this.config.codexAgentAdminThreadSandbox) || 'workspace-write')
          : (normalizeText(input.threadSandbox || this.config.codexAgentThreadSandbox) || 'workspace-write'),
        turnTimeoutMs: timeoutMs,
        stallTimeoutMs: normalizePositiveInteger(
          input.stallTimeoutMs || input.stall_timeout_ms || this.config.codexAgentStallTimeoutMs,
          DEFAULT_CODEX_AGENT_STALL_TIMEOUT_MS,
          { min: 1000, max: 3600000 },
        ),
        ...(model ? { model } : {}),
        ...(normalizeText(input.reasoningEffort || input.reasoning_effort || this.config.codexAgentReasoningEffort)
          ? { reasoningEffort: normalizeText(input.reasoningEffort || input.reasoning_effort || this.config.codexAgentReasoningEffort) }
          : {}),
      },
      ...(handoff ? { handoff } : {}),
    };

    let runId = '';
    let terminalReached = false;
    try {
      emitProgress('Starting Codex agent through /api/codex-agent/run.', { percent: 35, stage: 'starting' });
      const startResponse = await this.fetch(buildCodexAgentUrl(baseUrl, '/api/codex-agent/run'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(runBody),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const startBody = await this.readJsonResponse(startResponse);
      if (!startResponse?.ok || startBody?.ok === false) {
        const error = new Error(startBody?.error || startBody?.message || `codex-agent run failed with status ${startResponse?.status || 'unknown'}`);
        error.status = startResponse?.status;
        error.body = startBody;
        throw error;
      }
      runId = normalizeText(startBody?.runId || startBody?.id);
      if (!runId) {
        throw new Error('codex-agent run response did not include runId.');
      }
      const handoffAcknowledgement = resolveRemoteAgentHandoffAcknowledgement(startBody, handoff);

      emitProgress(`Codex agent run ${runId} started; streaming /events.`, {
        percent: 42,
        stage: 'started',
        event: {
          event: 'session_started',
          runId,
          threadId: startBody?.threadId || null,
          turnId: startBody?.turnId || null,
          sessionId: startBody?.sessionId || null,
        },
      });

      const outputParts = [];
      const eventFragments = [];
      let terminalEvent = null;
      let latestEvent = null;
      const handleCodexAgentEvent = (event) => {
        latestEvent = event;
        const detail = summarizeCodexAgentEvent(event);
        if (detail) {
          emitProgress(detail, {
            percent: isCodexAgentTerminalEvent(event) ? 92 : 55,
            stage: isCodexAgentTerminalEvent(event) ? 'completed' : 'in_progress',
            event,
          });
        }
        const text = extractCodexAgentEventText(event);
        if (text && event.event === 'output') {
          outputParts.push(text);
        }
        if (text) {
          eventFragments.push(text);
        }
        if (isCodexAgentTerminalEvent(event)) {
          terminalEvent = event;
        }
      };
      const eventsResponse = await this.fetch(buildCodexAgentUrl(baseUrl, `/api/codex-agent/runs/${encodeURIComponent(runId)}/events`), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!eventsResponse?.ok) {
        throw new Error(`codex-agent events failed with status ${eventsResponse?.status || 'unknown'}.`);
      }

      await this.consumeCodexAgentEvents(eventsResponse, {
        signal: controller?.signal || null,
        onEvent: handleCodexAgentEvent,
      });

      if (!terminalEvent) {
        emitProgress('Codex agent events stream closed before a terminal event; checking the run snapshot.', {
          percent: 74,
          stage: 'reconnecting',
          event: latestEvent || null,
        });
        const snapshotPolls = Math.min(maxStatusPolls, 3);
        for (let attempt = 1; attempt <= snapshotPolls && !terminalEvent; attempt += 1) {
          if (attempt > 1) {
            await sleep(Math.min(statusPollIntervalMs * attempt, 3000));
          }
          const after = normalizePositiveInteger(latestEvent?.cursor, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
          const snapshotUrl = `${buildCodexAgentUrl(baseUrl, `/api/codex-agent/runs/${encodeURIComponent(runId)}/events`)}?follow=false&after=${after}`;
          const snapshotResponse = await this.fetch(snapshotUrl, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: 'text/event-stream',
            },
            ...(controller ? { signal: controller.signal } : {}),
          });
          if (snapshotResponse?.ok) {
            await this.consumeCodexAgentEvents(snapshotResponse, {
              signal: controller?.signal || null,
              onEvent: handleCodexAgentEvent,
            });
          }
          if (terminalEvent) {
            break;
          }

          const statusResponse = await this.fetch(buildCodexAgentUrl(baseUrl, `/api/codex-agent/runs/${encodeURIComponent(runId)}`), {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: 'application/json',
            },
            ...(controller ? { signal: controller.signal } : {}),
          });
          const statusBody = statusResponse?.ok ? await this.readJsonResponse(statusResponse) : null;
          const terminalName = codexAgentStatusToTerminalEvent(statusBody?.status);
          if (terminalName) {
            terminalEvent = {
              event: terminalName,
              message: normalizeText(statusBody?.error || statusBody?.message),
              thread_id: statusBody?.threadId || startBody?.threadId || null,
              turn_id: statusBody?.turnId || startBody?.turnId || null,
              result: {
                output_text: outputParts.join('\n').trim(),
              },
            };
          }
        }
      }

      if (!terminalEvent) {
        throw new Error(`codex-agent events stream ended without a terminal event${latestEvent?.event ? ` after ${latestEvent.event}` : ''}.`);
      }
      terminalReached = true;

      const terminalName = normalizeText(terminalEvent.event);
      const terminalOutput = normalizeText(
        terminalEvent.result?.output_text
        || terminalEvent.result?.outputText
        || terminalEvent.output_text
        || terminalEvent.outputText
        || '',
      );
      const finalOutputSource = terminalOutput || outputParts.join('\n').trim() || eventFragments.join('\n').trim();
      const failed = terminalName !== 'turn_completed';
      const finalOutput = buildRemoteCodeFinalText({
        fragments: [finalOutputSource],
        targetId,
        cwd: workspacePath,
        sessionId: normalizeText(terminalEvent.thread_id || terminalEvent.threadId || startBody?.threadId || startBody?.sessionId || sessionId),
        status: failed ? 'failed' : 'completed',
        fallbackWhatChanged: failed
          ? 'Started the Codex agent through /api/codex-agent/run, but it did not complete successfully.'
          : 'Executed the Codex agent through /api/codex-agent/run and streamed /events to completion.',
        fallbackVerifyCommand: 'POST /api/codex-agent/run; GET /api/codex-agent/runs/:runId/events',
        fallbackVerifyResult: failed
          ? `codex-agent terminal event ${terminalName}: ${extractCodexAgentEventText(terminalEvent) || 'no message'}`
          : `codex-agent terminal event ${terminalName} received for run ${runId}.`,
        blocker: failed ? (extractCodexAgentEventText(terminalEvent) || terminalName) : '',
        transportLabel: 'codex-agent',
        transportDescription: '/api/codex-agent run/events contract',
      });
      let resultFiles = null;
      let resultFilesError = null;
      if (handoff?.output?.enabled) {
        try {
          resultFiles = await this.fetchRemoteAgentResultFiles({
            baseUrl,
            apiKey,
            acknowledgement: handoffAcknowledgement,
            signal: controller?.signal || null,
          });
        } catch (error) {
          resultFilesError = error;
        }
      }
      let runMetadata = applyUiProofRequirement(extractRemoteCliRunMetadata(finalOutput), task);
      runMetadata = applyRemoteAgentResultFilesOutcome(
        runMetadata,
        handoff,
        resultFiles,
        resultFilesError,
      );
      const agentQuality = assessRemoteCliQuality(task, runMetadata);
      const structuredResult = buildRemoteCliStructuredResult({ task, metadata: runMetadata, agentQuality });
      return {
        finalOutput,
        humanSummary: structuredResult.humanSummary,
        structuredResult,
        transport: 'codex-agent',
        handoffVersion: handoffAcknowledgement?.version || null,
        codexAgentRunId: runId,
        codexThreadId: normalizeText(terminalEvent.thread_id || terminalEvent.threadId || startBody?.threadId) || null,
        codexTurnId: normalizeText(terminalEvent.turn_id || terminalEvent.turnId || startBody?.turnId) || null,
        targetId,
        cwd: runMetadata.workspace || workspacePath,
        sessionId: runMetadata.sessionId || startBody?.threadId || startBody?.sessionId || sessionId || null,
        remoteCodeSessionId: runMetadata.sessionId || startBody?.threadId || startBody?.sessionId || sessionId || null,
        remoteCodeJobId: null,
        gitRepo: runMetadata.gitRepo || null,
        gitBranch: runMetadata.gitBranch || null,
        gitBaseCommit: runMetadata.gitBaseCommit || null,
        gitCommit: runMetadata.gitCommit || null,
        changedFiles: runMetadata.changedFiles || [],
        deployment: runMetadata.deployment || null,
        publicHost: runMetadata.publicHost || null,
        publicUrl: runMetadata.publicUrl || null,
        uiCheckReport: runMetadata.uiCheckReport || null,
        resultFilesManifest: runMetadata.resultFilesManifest || null,
        resultFiles: resultFiles || null,
        resultFilesError: runMetadata.resultFilesError || null,
        uiScreenshots: runMetadata.uiScreenshots || [],
        whatChanged: runMetadata.whatChanged || null,
        supportAgentRequest: runMetadata.supportAgentRequest || null,
        supportAgentContext: runMetadata.supportAgentContext || null,
        verifyCommands: runMetadata.verifyCommands || [],
        verifyResults: runMetadata.verifyResults || [],
        blocker: runMetadata.blocker || null,
        completionStatus: runMetadata.completionStatus || 'unknown',
        agentQuality,
        model,
        apiMode: 'codex-agent',
      };
    } catch (error) {
      if (runId && !terminalReached) {
        await this.fetch(buildCodexAgentUrl(baseUrl, `/api/codex-agent/runs/${encodeURIComponent(runId)}/cancel`), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
        }).catch(() => null);
      }
      if (error?.name === 'AbortError') {
        const timeoutError = new RemoteCliAgentRunTimeoutError(timeoutMs);
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async executeProviderAgentRun({
    input = {},
    targetId = 'prod',
    cwd = '',
    task = '',
    selection = null,
    agentRunTimeoutMs = DEFAULT_AGENT_RUN_TIMEOUT_MS,
    sessionId = '',
    continuitySummary = '',
    onProgress = null,
  } = {}) {
    if (!selection) {
      throw new Error('provider-agent transport requires a Kimi or Grok model selection.');
    }
    const baseUrl = resolveCodexAgentBaseUrl(input, this.config);
    const apiKey = resolveCodexAgentApiKey(input, this.config);
    const timeoutMs = normalizePositiveInteger(agentRunTimeoutMs, DEFAULT_AGENT_RUN_TIMEOUT_MS, { min: 1, max: 900000 });
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    timer?.unref?.();
    const continuationSessionId = resolveProviderAgentContinuationSessionId(selection, sessionId);
    const outputParts = [];
    let taskId = '';
    let providerSessionId = '';
    let markerComplete = false;
    let markerStatus = '';
    let terminalEvent = null;
    const handoff = input.handoff || null;

    const emitProgress = (detail, extra = {}) => {
      if (typeof onProgress !== 'function' || !detail) {
        return;
      }
      onProgress({
        phase: 'executing',
        reasoningSummary: detail,
        detail,
        percent: extra.percent || 45,
        toolEvents: [{
          toolId: 'remote-cli-agent',
          stage: extra.stage || 'in_progress',
          detail,
          transport: 'provider-agent',
          providerId: selection.providerId,
          providerLabel: selection.providerLabel,
        }],
      });
    };

    try {
      emitProgress(`Starting ${selection.providerLabel} for ${selection.requestedModel}.`, { percent: 20, stage: 'starting' });
      const startResponse = await this.fetch(buildCodexAgentUrl(baseUrl, '/admin/remote-agent-tasks'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          providerId: selection.providerId,
          targetId,
          cwd,
          task: buildProviderAgentTask({
            task,
            providerLabel: selection.providerLabel,
            requestedModel: selection.requestedModel,
            continuitySummary,
            handoff,
          }),
          ...(selection.providerModel ? { model: selection.providerModel } : {}),
          ...(continuationSessionId ? { sessionId: continuationSessionId } : {}),
          ...(handoff ? { handoff } : {}),
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const startBody = await this.readJsonResponse(startResponse);
      if (!startResponse?.ok) {
        throw new Error(normalizeText(startBody?.error || startBody?.message) || `${selection.providerLabel} remote-agent start failed with status ${startResponse?.status || 'unknown'}.`);
      }
      taskId = normalizeText(startBody?.task?.id);
      providerSessionId = normalizeText(startBody?.task?.sessionId);
      const streamUrl = normalizeText(startBody?.streamUrl);
      if (!taskId || !streamUrl) {
        throw new Error(`${selection.providerLabel} remote-agent response did not include task id and stream URL.`);
      }
      const handoffAcknowledgement = resolveRemoteAgentHandoffAcknowledgement(startBody, handoff);

      emitProgress(`${selection.providerLabel} remote task ${taskId} started.`, { percent: 35, stage: 'streaming' });
      const absoluteStreamUrl = new URL(streamUrl, `${trimTrailingSlash(baseUrl)}/`).toString();
      if (new URL(absoluteStreamUrl).origin !== new URL(baseUrl).origin) {
        throw new Error(`${selection.providerLabel} remote-agent stream URL must use the configured gateway origin.`);
      }
      const eventsResponse = await this.fetch(absoluteStreamUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!eventsResponse?.ok) {
        throw new Error(`${selection.providerLabel} remote-agent stream failed with status ${eventsResponse?.status || 'unknown'}.`);
      }

      try {
        await this.consumeCodexAgentEvents(eventsResponse, {
          signal: controller?.signal || null,
          onEvent: (event) => {
            const eventType = normalizeText(event?.type || event?.event);
            if (eventType === 'output') {
              const text = String(event?.data || event?.text || '');
              if (text) {
                outputParts.push(text);
                emitProgress(`${selection.providerLabel} is working.`, { percent: 60, stage: 'output' });
                markerStatus = readProviderAgentResultStatus(outputParts.join(''));
                if (markerStatus) {
                  markerComplete = true;
                }
              }
            } else if (eventType === 'reasoning') {
              emitProgress(normalizeText(event?.summary) || `${selection.providerLabel} planned the remote task.`, { percent: 45, stage: 'reasoning' });
            } else if (eventType === 'exit') {
              terminalEvent = event;
            }
          },
        });
      } catch (error) {
        if (!markerComplete) {
          throw error;
        }
      }

      const output = normalizeProviderAgentOutput(outputParts.join('').trim());
      const failed = markerStatus === 'failed'
        || (!markerComplete && Number(terminalEvent?.exitCode) !== 0);
      const finalOutput = buildRemoteCodeFinalText({
        fragments: [output],
        targetId,
        cwd,
        sessionId: providerSessionId,
        status: failed ? 'failed' : 'completed',
        fallbackWhatChanged: failed
          ? `${selection.providerLabel} exited before reporting successful completion.`
          : `${selection.providerLabel} completed the remote task selected by ${selection.requestedModel}.`,
        fallbackVerifyCommand: `POST /admin/remote-agent-tasks (${selection.providerId})`,
        fallbackVerifyResult: markerComplete
          ? `${selection.providerLabel} emitted REMOTE_AGENT_RESULT.`
          : `${selection.providerLabel} session exited with code ${terminalEvent?.exitCode ?? 'unknown'}.`,
        blocker: failed ? `${selection.providerLabel} remote-agent task failed.` : '',
        transportLabel: 'provider-agent',
        transportDescription: `${selection.providerLabel} via /admin/remote-agent-tasks`,
      });
      let resultFiles = null;
      let resultFilesError = null;
      if (handoff?.output?.enabled) {
        try {
          resultFiles = await this.fetchRemoteAgentResultFiles({
            baseUrl,
            apiKey,
            acknowledgement: handoffAcknowledgement,
            signal: controller?.signal || null,
          });
        } catch (error) {
          resultFilesError = error;
        }
      }
      let runMetadata = applyUiProofRequirement(extractRemoteCliRunMetadata(finalOutput), task);
      runMetadata = applyRemoteAgentResultFilesOutcome(
        runMetadata,
        handoff,
        resultFiles,
        resultFilesError,
      );
      const agentQuality = assessRemoteCliQuality(task, runMetadata);
      const structuredResult = buildRemoteCliStructuredResult({ task, metadata: runMetadata, agentQuality });
      return {
        finalOutput,
        humanSummary: structuredResult.humanSummary,
        structuredResult,
        transport: 'provider-agent',
        handoffVersion: handoffAcknowledgement?.version || null,
        providerId: selection.providerId,
        providerModel: selection.providerModel,
        targetId,
        cwd: runMetadata.workspace || cwd,
        sessionId: runMetadata.sessionId || providerSessionId || null,
        remoteCodeSessionId: runMetadata.sessionId || providerSessionId || null,
        remoteCodeJobId: taskId || null,
        gitRepo: runMetadata.gitRepo || null,
        gitBranch: runMetadata.gitBranch || null,
        gitBaseCommit: runMetadata.gitBaseCommit || null,
        gitCommit: runMetadata.gitCommit || null,
        changedFiles: runMetadata.changedFiles || [],
        deployment: runMetadata.deployment || null,
        publicHost: runMetadata.publicHost || null,
        publicUrl: runMetadata.publicUrl || null,
        uiCheckReport: runMetadata.uiCheckReport || null,
        resultFilesManifest: runMetadata.resultFilesManifest || null,
        resultFiles: resultFiles || null,
        resultFilesError: runMetadata.resultFilesError || null,
        uiScreenshots: runMetadata.uiScreenshots || [],
        whatChanged: runMetadata.whatChanged || null,
        verifyCommands: runMetadata.verifyCommands || [],
        verifyResults: runMetadata.verifyResults || [],
        blocker: runMetadata.blocker || null,
        completionStatus: runMetadata.completionStatus || 'unknown',
        agentQuality,
        model: selection.requestedModel,
        apiMode: 'provider-agent',
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new RemoteCliAgentRunTimeoutError(timeoutMs);
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (taskId) {
        await this.fetch(buildCodexAgentUrl(baseUrl, `/admin/remote-agent-tasks/${encodeURIComponent(taskId)}/cancel`), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
        }).catch(() => null);
      }
      if (timer) {
        clearTimeout(timer);
      }
    }
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
    adminMode = false,
    continuitySummary = '',
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

    const startRemoteCodeRun = async () => {
      const runArgs = {
        targetId,
        ...(cwd ? { cwd } : {}),
        task: buildDirectRemoteCodeTask({
          task,
          targetId,
          cwd,
          sessionId: remoteSessionId,
          adminMode,
          continuitySummary,
        }),
        ...(model ? { model } : {}),
        ...(remoteSessionId ? { sessionId: remoteSessionId } : {}),
        ...(adminMode ? { adminMode: true } : {}),
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
    };

    if (!remoteJobId) {
      await startRemoteCodeRun();
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

    const pollLimit = normalizePositiveInteger(maxStatusPolls, DEFAULT_MAX_STATUS_POLLS, { min: 1, max: 240 });
    const pollDelay = normalizePositiveInteger(statusPollIntervalMs, DEFAULT_STATUS_POLL_INTERVAL_MS, { min: 0, max: 30000 });

    while (remoteJobId && (isRunningRemoteCodeStatus(latestStatus) || !latestStatus) && statusPolls < pollLimit) {
      if (statusPolls > 0 || latestStatus) {
        await sleep(pollDelay);
      }
      emitProgress(`Polling remote_code_status for job ${remoteJobId}.`, { percent: Math.min(85, 52 + statusPolls) });
      let statusResult = null;
      try {
        statusResult = await remoteCli.callTool('remote_code_status', { jobId: remoteJobId });
      } catch (error) {
        if (!isUnknownRemoteCliJobError(error) || !normalizeText(task)) {
          throw error;
        }
        const staleJobId = remoteJobId;
        fragments.push([
          `STALE_REMOTE_CLI_JOB_ID=${staleJobId}`,
          `VERIFY_RESULTS=remote_code_status reported unknown job ${staleJobId}; starting a fresh remote_code_run.`,
        ].join('\n'));
        remoteJobId = '';
        latestStatus = '';
        statusPolls += 1;
        await startRemoteCodeRun();
        continue;
      }
      const statusText = normalizeMcpContentText(statusResult);
      fragments.push(...collectRemoteCodeTextFragments(statusResult, statusText));
      const statusState = extractRemoteCodeJobState(statusResult, statusText);
      latestStatus = statusState.status || latestStatus || 'unknown';
      remoteSessionId = statusState.sessionId || remoteSessionId;
      remoteJobId = statusState.jobId || remoteJobId;
      statusPolls += 1;

      const metadata = extractRemoteCliRunMetadata(fragments.join('\n\n'));
      if (hasTerminalRemoteCliProof(metadata)) {
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
    const transport = resolveRemoteCliTransport(input, this.config);
    this.assertConfigured({ transport, input });
    let providerSelection = resolveProviderAgentSelection(
      input.requestedModel
      || input.requested_model
      || input.model,
    );
    if (transport === 'provider-agent' && !providerSelection) {
      const configuredCodexModel = normalizeText(
        input.codexAgentModel
        || input.codex_agent_model
        || this.config.codexAgentModel,
      );
      providerSelection = {
        providerId: 'codex-cli',
        providerLabel: 'Codex',
        requestedModel: configuredCodexModel || 'configured default',
        providerModel: configuredCodexModel,
      };
    }

    const targetId = resolveRemoteCliTargetId(
      input.targetId || input.target_id,
      this.config.defaultTargetId || 'prod',
    );
    const cwd = normalizeText(
      input.cwd
      || input.workingDirectory
      || input.working_directory
      || input.workspacePath
      || input.workspace_path
      || this.config.defaultCwd,
    );
    const sessionId = normalizeText(input.sessionId || input.session_id || input.remoteSessionId || input.remote_session_id);
    const jobId = normalizeText(input.jobId || input.job_id || input.remoteCodeJobId || input.remote_code_job_id);
    const waitMs = normalizePositiveInteger(input.waitMs ?? input.wait_ms, 30000, { min: 1000, max: 300000 });
    const maxTurns = normalizePositiveInteger(input.maxTurns ?? input.max_turns ?? this.config.maxTurns, 20, { min: 1, max: 80 });
    const agentRunTimeoutMs = normalizePositiveInteger(input.agentRunTimeoutMs ?? input.agent_run_timeout_ms ?? this.config.agentRunTimeoutMs, DEFAULT_AGENT_RUN_TIMEOUT_MS, { min: 1, max: 900000 });
    const model = transport === 'provider-agent'
      ? normalizeText(providerSelection?.requestedModel)
      : transport === 'codex-agent'
      ? normalizeText(input.codexAgentModel || input.codex_agent_model || input.model || this.config.codexAgentModel)
      : (normalizeText(input.model || this.config.agentModel) || 'gpt-4o');
    const remoteCodeModel = normalizeText(input.remoteCodeModel || input.remote_code_model || this.config.remoteCodeModel) || DEFAULT_REMOTE_CODE_MODEL;
    const maxStatusPolls = normalizePositiveInteger(input.maxStatusPolls ?? input.max_status_polls ?? this.config.maxStatusPolls, DEFAULT_MAX_STATUS_POLLS, { min: 1, max: 240 });
    const statusPollIntervalMs = normalizePositiveInteger(input.statusPollIntervalMs ?? input.status_poll_interval_ms ?? this.config.statusPollIntervalMs, DEFAULT_STATUS_POLL_INTERVAL_MS, { min: 0, max: 30000 });
    const adminMode = resolveAdminMode(input, task);
    const continuitySummary = normalizeText(input.continuitySummary || input.remoteProjectContext || input.remote_project_context);
    const handoff = input.handoff || null;

    if (transport === 'provider-agent') {
      return this.executeProviderAgentRun({
        input,
        targetId,
        cwd,
        task,
        selection: providerSelection,
        agentRunTimeoutMs,
        sessionId,
        continuitySummary,
        onProgress: input.onProgress,
      });
    }

    if (transport === 'codex-agent') {
      try {
        return await this.executeCodexAgentRun({
          input,
          targetId,
          cwd,
          task,
          model,
          sessionId,
          agentRunTimeoutMs,
          maxStatusPolls,
          statusPollIntervalMs,
          adminMode,
          continuitySummary,
          onProgress: input.onProgress,
        });
      } catch (error) {
        const diagnostics = buildRemoteCliDiagnostics({
          stage: 'codex_agent_run',
          error,
          model,
          apiMode: 'codex-agent',
          targetId,
          cwd,
          config: this.config,
          mcpSessionId: input.mcpSessionId,
        });
        throw createRemoteCliAgentError(
          `remote-cli-agent codex-agent transport failed: ${summarizeRemoteCliError(error).message}`,
          diagnostics,
          error,
        );
      }
    }

    if (handoff) {
      const error = new Error('remote-cli-agent file handoffs require the codex-agent or provider-agent transport; MCP does not preserve staged files.');
      error.code = 'REMOTE_AGENT_HANDOFF_UNSUPPORTED_TRANSPORT';
      throw error;
    }

    const sdk = this.sdkLoader();
    const {
      Agent,
      MCPServerStreamableHttp,
      OpenAIProvider,
      Runner,
      setOpenAIAPI,
    } = sdk;
    const directRun = normalizeBooleanFlag(input.directRun ?? input.direct_run, this.config.directRun !== false);

    if (!MCPServerStreamableHttp) {
      throw new Error('@openai/agents is installed but did not expose MCPServerStreamableHttp.');
    }
    if (!directRun && (!Agent || !OpenAIProvider || !Runner)) {
      throw new Error('@openai/agents is installed but did not expose the expected Agents SDK classes.');
    }

    const apiMode = resolveAgentsApiMode({
      requestedMode: this.config.agentApiMode,
      baseURL: this.config.agentBaseURL,
    });

    if (typeof setOpenAIAPI === 'function') {
      setOpenAIAPI(apiMode);
    }

    let remoteCli = this.createMcpServer(MCPServerStreamableHttp, input);
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
    const instructions = directRun
      ? ''
      : buildRemoteCliInstructions({
        targetId,
        cwd,
        sessionId,
        waitMs,
        adminMode,
        remoteCodeModel,
        continuitySummary,
        extraInstructions: input.instructions || input.extraInstructions || '',
      });
    let agent = null;
    let runner = null;

    try {
      try {
        await remoteCli.connect();
      } catch (error) {
        if (input.mcpSessionId && isStaleMcpSessionError(error)) {
          await remoteCli.close().catch(() => {});
          remoteCli = this.createMcpServer(MCPServerStreamableHttp, {
            ...input,
            mcpSessionId: '',
          });
          attachRemoteCodeCallTracker(remoteCli, remoteCodeCallState);
          await remoteCli.connect();
        } else {
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
      }

      agent = directRun
        ? null
        : new Agent({
          name: normalizeText(input.agentName || input.agent_name) || 'Remote coding agent',
          model,
          instructions,
          mcpServers: [remoteCli],
        });
      runner = directRun
        ? null
        : new Runner({
          model,
          modelProvider: this.createModelProvider(OpenAIProvider),
          tracingDisabled: true,
          workflowName: 'Remote CLI MCP coding task',
        });

      let finalOutput = '';
      let usedDirectRemoteCodeRun = directRun || Boolean(jobId);
      if (usedDirectRemoteCodeRun) {
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
          adminMode,
          continuitySummary,
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
            continuitySummary,
          }), {
            maxTurns,
          }), agentRunTimeoutMs);
        } catch (error) {
          if (!isRemoteCliAgentRunTimeoutError(error) && !isUnknownRemoteCliJobError(error)) {
            throw error;
          }

          if (typeof input.onProgress === 'function') {
            const pollExistingJob = Boolean(remoteCodeCallState.jobId);
            const staleExistingJob = isUnknownRemoteCliJobError(error);
            input.onProgress({
              phase: 'executing',
              reasoningSummary: staleExistingJob
                ? 'Remote CLI agent tried to poll a stale remote_code_run job; starting a fresh remote_code_run.'
                : pollExistingJob
                ? 'Remote CLI agent stale wait budget was exceeded; polling the remote_code_run job it already started.'
                : 'Remote CLI agent stale wait budget was exceeded; continuing with direct remote_code_run.',
              detail: staleExistingJob
                ? 'Gateway no longer knows the prior remote job id, likely after a gateway restart.'
                : pollExistingJob
                ? 'Inner agent wait budget expired; continuing with remote_code_status.'
                : 'Inner agent wait budget expired; starting remote_code_run directly.',
              percent: 46,
              toolEvents: [{
                toolId: 'remote-cli-agent',
                stage: 'fallback',
                detail: staleExistingJob
                  ? 'Starting a new remote_code_run because the prior job id is stale.'
                  : pollExistingJob
                  ? 'Polling the existing remote_code_run job after stale wait budget expiry.'
                  : 'Starting direct remote_code_run after stale wait budget expiry.',
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
            jobId: isUnknownRemoteCliJobError(error) ? '' : (remoteCodeCallState.jobId || ''),
            maxStatusPolls,
            statusPollIntervalMs,
            adminMode,
            continuitySummary,
            onProgress: input.onProgress,
          });
          usedDirectRemoteCodeRun = true;
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
            adminMode: normalizeBooleanFlag(leakedArgs.adminMode, adminMode),
            continuitySummary,
            onProgress: input.onProgress,
          });
          usedDirectRemoteCodeRun = true;
        }
      }
      let runMetadata = extractRemoteCliRunMetadata(finalOutput);
      const hasTerminalRemoteProof = hasTerminalRemoteCliProof(runMetadata);
      if (!hasTerminalRemoteProof && !usedDirectRemoteCodeRun) {
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
            adminMode,
            continuitySummary,
            onProgress: input.onProgress,
          });
          runMetadata = extractRemoteCliRunMetadata(finalOutput);
        } else if (!remoteCodeCallState.sawRemoteCodeRun) {
          emitContractProgress(
            'Remote CLI agent returned without calling remote_code_run or producing terminal proof markers; starting direct remote_code_run.',
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
            adminMode,
            continuitySummary,
            onProgress: input.onProgress,
          });
          runMetadata = extractRemoteCliRunMetadata(finalOutput);
        } else if (runMetadata.completionStatus !== 'complete' && runMetadata.completionStatus !== 'blocked') {
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

      runMetadata = applyUiProofRequirement(runMetadata, task);

      const expandedFinalOutput = expandRemoteCliProofText(finalOutput);
      const staleRemoteJobIds = readMarkerLines(expandedFinalOutput, ['STALE_REMOTE_CLI_JOB_ID']);
      const metadataRemoteJobId = staleRemoteJobIds.includes(runMetadata.jobId) ? '' : runMetadata.jobId;
      const fallbackRemoteJobId = staleRemoteJobIds.includes(jobId) ? null : jobId;

      const agentQuality = assessRemoteCliQuality(task, runMetadata);
      const structuredResult = buildRemoteCliStructuredResult({ task, metadata: runMetadata, agentQuality });
      return {
        finalOutput,
        humanSummary: structuredResult.humanSummary,
        structuredResult,
        mcpSessionId: remoteCli.sessionId || input.mcpSessionId || null,
        targetId,
        cwd: runMetadata.workspace || cwd,
        sessionId: runMetadata.sessionId || sessionId || null,
        remoteCodeSessionId: runMetadata.sessionId || sessionId || null,
        remoteCodeJobId: metadataRemoteJobId || fallbackRemoteJobId || null,
        gitRepo: runMetadata.gitRepo || null,
        gitBranch: runMetadata.gitBranch || null,
        gitBaseCommit: runMetadata.gitBaseCommit || null,
        gitCommit: runMetadata.gitCommit || null,
        changedFiles: runMetadata.changedFiles || [],
        deployment: runMetadata.deployment || null,
        publicHost: runMetadata.publicHost || null,
        publicUrl: runMetadata.publicUrl || null,
        uiCheckReport: runMetadata.uiCheckReport || null,
        resultFilesManifest: runMetadata.resultFilesManifest || null,
        uiScreenshots: runMetadata.uiScreenshots || [],
        whatChanged: runMetadata.whatChanged || null,
        supportAgentRequest: runMetadata.supportAgentRequest || null,
        supportAgentContext: runMetadata.supportAgentContext || null,
        verifyCommands: runMetadata.verifyCommands || [],
        verifyResults: runMetadata.verifyResults || [],
        blocker: runMetadata.blocker || null,
        completionStatus: runMetadata.completionStatus || 'unknown',
        agentQuality,
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
  REMOTE_CLI_RESULT_VERSION,
  RemoteCliAgentsSdkRunner,
  buildRemoteCliInstructions,
  buildRemoteCliStructuredResult,
  applyRemoteAgentResultFilesOutcome,
  buildRemoteCliPrompt,
  extractRemoteCliRunMetadata,
  remoteCliAgentsSdkRunner,
  resolveRemoteCliTargetId,
  resolveConfiguredGiteaContext,
  resolveConfiguredGitProviderContext,
  resolveAgentsApiMode,
  buildRemoteCliDiagnostics,
  summarizeRemoteCliError,
  isStaleMcpSessionError,
  hasRemoteSoftwareDeploymentIntent,
  resolveAdminMode,
  resolveProviderAgentContinuationSessionId,
  resolveProviderAgentSelection,
  resolveRemoteAgentHandoffAcknowledgement,
  trimTrailingSlash,
};

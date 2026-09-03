'use strict';

const { ToolBase } = require('../../ToolBase');
const {
  buildRemoteCliStructuredResult,
  remoteCliAgentsSdkRunner,
} = require('../../../../remote-cli/agents-sdk-runner');
const { createRemoteAgentHandoff, normalizeRemoteAgentHandoffContinuation } = require('../../../../remote-cli/agent-handoff');
const { persistRemoteAgentResultArtifacts } = require('../../../../remote-cli/agent-result-artifacts');
const { artifactService } = require('../../../../artifacts/artifact-service');
const { clusterStateRegistry } = require('../../../../cluster-state-registry');
const { getSessionControlState } = require('../../../../runtime-control-state');
const { normalizeInheritedRemoteWorkspace } = require('../../../../remote-cli/workspace-contract');
const { config } = require('../../../../config');

function parseObjectLike(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  return /^(?:1|true|yes|on|approved|admin)$/i.test(String(value).trim());
}

function normalizeInteger(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : undefined;
}

function extractDomains(text = '') {
  return Array.from(new Set(
    String(text || '').match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/ig) || [],
  ));
}

function extractUnixPaths(text = '') {
  return Array.from(new Set(
    (String(text || '').match(/(?:^|[\s"'`(])((?:\/(?:app|etc|opt|srv|var|home|root|usr|tmp)(?:\/[A-Za-z0-9._:-]+)+)\/?)/g) || [])
      .map((entry) => entry.replace(/^[\s"'`(]+/, '').replace(/[),.;:]+$/, '')),
  ));
}

function getHostFromUrl(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  try {
    return new URL(normalized).host;
  } catch (_error) {
    return '';
  }
}

function normalizeLower(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getRemoteCliAgentStateFromContext(context = {}) {
  const sessionState = getSessionControlState(context.session || {});
  const explicitState = getSessionControlState({
    controlState: context.controlState || {},
    metadata: context.metadata || {},
  });
  return {
    ...(explicitState.remoteCliAgent || {}),
    ...(sessionState.remoteCliAgent || {}),
  };
}

function hasContinuationLanguage(task = '') {
  return /\b(?:continue|resume|finish|keep going|retry|rerun|re-run|again|same|that|this|it|follow[-\s]?up|still|fix the deployed|check the deployed|poll|status)\b/i.test(task);
}

function hasMatchingProjectAnchor(task = '', prior = {}) {
  const normalizedTask = normalizeLower(task);
  const priorHost = normalizeLower(prior.publicHost || getHostFromUrl(prior.publicUrl));
  const priorCwd = normalizeLower(prior.cwd);
  const priorRepo = normalizeLower(prior.gitRepo);
  const priorDeployment = normalizeLower(prior.deployment);

  if (priorHost && extractDomains(task).some((domain) => normalizeLower(domain) === priorHost)) {
    return true;
  }
  if (priorCwd && extractUnixPaths(task).some((path) => {
    const normalizedPath = normalizeLower(path);
    return normalizedPath === priorCwd
      || normalizedPath.startsWith(`${priorCwd}/`)
      || priorCwd.startsWith(`${normalizedPath}/`);
  })) {
    return true;
  }
  if (priorRepo && normalizedTask.includes(priorRepo)) {
    return true;
  }
  if (priorDeployment && normalizedTask.includes(priorDeployment)) {
    return true;
  }

  return false;
}

function hasDifferentExplicitProjectAnchor(task = '', prior = {}) {
  if (hasMatchingProjectAnchor(task, prior)) {
    return false;
  }

  const priorHost = normalizeLower(prior.publicHost || getHostFromUrl(prior.publicUrl));
  const domains = extractDomains(task).map(normalizeLower);
  if (domains.length > 0 && (!priorHost || !domains.includes(priorHost))) {
    return true;
  }

  const priorCwd = normalizeLower(prior.cwd);
  const paths = extractUnixPaths(task).map(normalizeLower);
  if (paths.length > 0 && priorCwd && !paths.some((path) => (
    path === priorCwd
    || path.startsWith(`${priorCwd}/`)
    || priorCwd.startsWith(`${path}/`)
  ))) {
    return true;
  }

  const repoMatches = String(task || '').match(/https?:\/\/[^\s"'`]+\.git\b/ig) || [];
  const priorRepo = normalizeLower(prior.gitRepo);
  if (repoMatches.length > 0 && (!priorRepo || !repoMatches.map(normalizeLower).includes(priorRepo))) {
    return true;
  }

  return false;
}

function shouldReusePriorRemoteCliAgentState(task = '', prior = {}, params = {}) {
  if (!prior || typeof prior !== 'object') {
    return false;
  }
  if (!prior.sessionId
    && !prior.mcpSessionId
    && !prior.remoteCodeSessionId
    && !prior.remoteCodeJobId
    && !prior.cwd
    && !prior.targetId) {
    return false;
  }
  const requestedTargetId = normalizeLower(params.targetId);
  const priorTargetId = normalizeLower(prior.targetId);
  if (requestedTargetId && requestedTargetId !== priorTargetId) {
    return false;
  }
  if (hasDifferentExplicitProjectAnchor(task, prior)) {
    return false;
  }
  return hasContinuationLanguage(task) || hasMatchingProjectAnchor(task, prior);
}

function applyPriorRemoteCliAgentDefaults(params = {}, context = {}) {
  const prior = getRemoteCliAgentStateFromContext(context);
  const task = firstNonEmptyText(params.task, params.prompt, params.message);
  if (!shouldReusePriorRemoteCliAgentState(task, prior, params)) {
    return { state: prior, reused: false };
  }

  applyAlias(params, 'sessionId', prior.sessionId, prior.remoteCodeSessionId);
  applyAlias(params, 'mcpSessionId', prior.mcpSessionId);
  applyAlias(params, 'cwd', normalizeInheritedRemoteWorkspace(prior.cwd, params.targetId || prior.targetId, config.remoteCliMcp));
  applyAlias(params, 'targetId', prior.targetId);

  if (!params.jobId && prior.remoteCodeJobId && /(?:continue|resume|poll|status|running|same|that|again|retry)/i.test(task)) {
    params.jobId = prior.remoteCodeJobId;
  }

  return { state: prior, reused: true };
}

function buildSessionRemoteCliContinuity(prior = {}) {
  if (!prior || typeof prior !== 'object' || Object.keys(prior).length === 0) {
    return '';
  }
  const fragments = [
    prior.sessionId ? `remote session ${prior.sessionId}` : '',
    prior.remoteCodeJobId ? `job ${prior.remoteCodeJobId}` : '',
    prior.targetId ? `target ${prior.targetId}` : '',
    prior.cwd ? `workspace ${prior.cwd}` : '',
    prior.gitRepo ? `repo ${prior.gitRepo}` : '',
    prior.gitBranch ? `branch ${prior.gitBranch}` : '',
    prior.gitBaseCommit ? `base ${prior.gitBaseCommit}` : '',
    prior.gitCommit ? `commit ${prior.gitCommit}` : '',
    Array.isArray(prior.changedFiles) && prior.changedFiles.length > 0 ? `changed files ${prior.changedFiles.slice(0, 8).join(', ')}` : '',
    prior.deployment ? `deployment ${prior.deployment}` : '',
    prior.publicHost ? `public host ${prior.publicHost}` : '',
    prior.publicUrl ? `public URL ${prior.publicUrl}` : '',
    prior.uiCheckReport ? `UI check report ${prior.uiCheckReport}` : '',
    Array.isArray(prior.uiScreenshots) && prior.uiScreenshots.length > 0 ? `UI screenshots ${prior.uiScreenshots.slice(0, 4).join(', ')}` : '',
    Array.isArray(prior.verifyCommands) && prior.verifyCommands.length > 0 ? `verify commands ${prior.verifyCommands.slice(0, 4).join('; ')}` : '',
    Array.isArray(prior.verifyResults) && prior.verifyResults.length > 0 ? `verify results ${prior.verifyResults.slice(0, 4).join('; ')}` : '',
    prior.whatChanged ? `last change ${prior.whatChanged}` : '',
    prior.completionStatus ? `status ${prior.completionStatus}` : '',
    prior.blocker ? `blocker ${prior.blocker}` : '',
  ].filter(Boolean);
  if (fragments.length === 0) {
    return '';
  }
  return [
    '[Current conversation remote-cli-agent state]',
    'Reuse only when this task is a continuation of the same repo, workspace, deployment, or domain.',
    `- ${fragments.join('; ')}`,
  ].join('\n');
}

function buildRemoteCliContinuitySummary(params = {}, context = {}, prior = {}) {
  const parts = [
    buildSessionRemoteCliContinuity(prior),
    clusterStateRegistry.buildRemoteCliAgentContext(),
  ].filter(Boolean);

  return parts.join('\n\n');
}

function applyAlias(params, targetKey, ...values) {
  if (params[targetKey] !== undefined && params[targetKey] !== null && String(params[targetKey]).trim() !== '') {
    return;
  }
  const value = firstDefined(...values);
  if (value !== undefined) {
    params[targetKey] = value;
  }
}

function sanitizeOuterRemoteCliToolReferences(task = '') {
  let text = String(task || '').trim();
  if (!text) {
    return '';
  }

  text = text
    .replace(/\buse\s+(?:the\s+)?remote[-_\s]+cli[-_\s]+agent\s+(?:once\s+)?(?:to|for)\s+/ig, '')
    .replace(/\b(?:through|via|with|using|inside)\s+(?:the\s+)?remote[-_\s]+cli[-_\s]+agent\b/ig, '')
    .replace(/\bcall\s+(?:the\s+)?remote[-_\s]+cli[-_\s]+agent\s+(?:once\s+)?(?:to|for)\s+/ig, '')
    .replace(/\brun\s+(?:the\s+)?remote[-_\s]+cli[-_\s]+agent\s+(?:once\s+)?(?:to|for)\s+/ig, '')
    // Preserve relative paths ("only .kimibuilt/..."), code indentation and
    // newlines. Whitespace is part of the requested task, not cosmetic noise.
    .trim();

  if (!text) {
    return String(task || '').trim();
  }
  if (/^(?:a|an|the)\s+/i.test(text)) {
    return `Run ${text}`;
  }

  return text;
}

function normalizeRemoteCliAgentParams(params = {}, context = {}) {
  const argumentObject = parseObjectLike(params.arguments);
  const inputObject = parseObjectLike(params.input);
  const nestedParams = parseObjectLike(params.params);
  const remoteCodeRun = parseObjectLike(params.remoteCodeRun)
    || parseObjectLike(params.remote_code_run)
    || parseObjectLike(params.remoteCodeRunArgs)
    || parseObjectLike(params.remote_code_run_args)
    || (argumentObject?.name === 'remote_code_run' ? parseObjectLike(argumentObject.arguments) : null)
    || {};

  const task = firstNonEmptyText(
    params.task,
    params.prompt,
    params.objective,
    params.request,
    params.message,
    argumentObject?.task,
    argumentObject?.prompt,
    argumentObject?.objective,
    inputObject?.task,
    inputObject?.prompt,
    nestedParams?.task,
    nestedParams?.prompt,
    remoteCodeRun?.task,
    remoteCodeRun?.prompt,
  );
  if (!params.task && task) {
    params.task = task;
  }
  if (params.task) {
    params.task = sanitizeOuterRemoteCliToolReferences(params.task);
  }

  if (!params.task && firstNonEmptyText(params.command, argumentObject?.command, nestedParams?.command)) {
    const error = new Error('remote-cli-agent expects params.task for a remote coding/deploy objective. Use remote-command when you need to run one raw command.');
    error.code = 'REMOTE_CLI_AGENT_TASK_REQUIRED';
    throw error;
  }

  applyAlias(params, 'targetId', params.target_id, argumentObject?.targetId, argumentObject?.target_id, remoteCodeRun?.targetId, remoteCodeRun?.target_id);
  applyAlias(params, 'cwd', params.workingDirectory, params.working_directory, argumentObject?.cwd, argumentObject?.workingDirectory, remoteCodeRun?.cwd);
  applyAlias(params, 'workspacePath', params.workspace_path, params.codexAgentWorkspacePath, params.codex_agent_workspace_path, argumentObject?.workspacePath, argumentObject?.workspace_path);
  applyAlias(params, 'sessionId', params.session_id, params.remoteSessionId, params.remote_session_id, argumentObject?.sessionId, argumentObject?.session_id, remoteCodeRun?.sessionId, remoteCodeRun?.session_id);
  applyAlias(params, 'threadId', params.thread_id, params.codexThreadId, params.codex_thread_id, argumentObject?.threadId, argumentObject?.thread_id);
  applyAlias(params, 'jobId', params.job_id, params.remoteCodeJobId, params.remote_code_job_id, argumentObject?.jobId, argumentObject?.job_id);
  applyAlias(params, 'mcpSessionId', params.mcp_session_id, argumentObject?.mcpSessionId, argumentObject?.mcp_session_id);
  applyAlias(params, 'remoteCodeModel', params.remote_code_model, argumentObject?.remoteCodeModel, argumentObject?.remote_code_model, remoteCodeRun?.model);
  applyAlias(params, 'transport', params.remoteCliTransport, params.remote_cli_transport, argumentObject?.transport, argumentObject?.remoteCliTransport, argumentObject?.remote_cli_transport);
  applyAlias(params, 'reasoningEffort', params.reasoning_effort, context?.reasoningEffort, context?.metadata?.reasoningEffort);
  const selectedHeaderModel = firstNonEmptyText(
    context?.model,
    context?.requestedModel,
    context?.metadata?.requestedModel,
    context?.metadata?.model,
  );
  const supportedHeaderModel = /(?:^|[\/_-])(?:gpt|codex|openai|kimi)(?:[\/_-]|$)|^o[134](?:[\/_-]|$)|^k3(?:[\/_-]|$)|moonshot/i.test(selectedHeaderModel)
    ? selectedHeaderModel
    : '';
  applyAlias(
    params,
    'model',
    params.requestedModel,
    params.requested_model,
    argumentObject?.model,
    argumentObject?.requestedModel,
    supportedHeaderModel,
  );
  applyAlias(params, 'supportAgentResponse', params.support_agent_response, params.supportAgentNotes, params.support_agent_notes, argumentObject?.supportAgentResponse, argumentObject?.support_agent_response, argumentObject?.supportAgentNotes, argumentObject?.support_agent_notes);
  applyAlias(params, 'contextFiles', params.context_files, argumentObject?.contextFiles, argumentObject?.context_files);
  applyAlias(params, 'resultFileGlobs', params.result_file_globs, argumentObject?.resultFileGlobs, argumentObject?.result_file_globs);
  applyAlias(params, 'collectResultFiles', params.collect_result_files, argumentObject?.collectResultFiles, argumentObject?.collect_result_files);
  if (!Array.isArray(params.artifactIds)) {
    const artifactIds = [
      ...(Array.isArray(params.artifact_ids) ? params.artifact_ids : []),
      ...(Array.isArray(argumentObject?.artifactIds) ? argumentObject.artifactIds : []),
      ...(Array.isArray(argumentObject?.artifact_ids) ? argumentObject.artifact_ids : []),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    if (artifactIds.length > 0) {
      params.artifactIds = Array.from(new Set(artifactIds));
    }
  }

  const priorRemoteCliAgent = applyPriorRemoteCliAgentDefaults(params, context);
  applyAlias(params, 'continuitySummary', params.remoteProjectContext, params.remote_project_context, buildRemoteCliContinuitySummary(
    params,
    context,
    priorRemoteCliAgent.reused ? priorRemoteCliAgent.state : {},
  ));

  const waitMs = normalizeInteger(firstDefined(params.waitMs, params.wait_ms, argumentObject?.waitMs, argumentObject?.wait_ms, remoteCodeRun?.waitMs, remoteCodeRun?.wait_ms));
  if (waitMs !== undefined) {
    params.waitMs = waitMs;
  }

  const maxTurns = normalizeInteger(firstDefined(params.maxTurns, params.max_turns, argumentObject?.maxTurns, argumentObject?.max_turns));
  if (maxTurns !== undefined) {
    params.maxTurns = maxTurns;
  }

  const maxStatusPolls = normalizeInteger(firstDefined(
    params.maxStatusPolls,
    params.max_status_polls,
    argumentObject?.maxStatusPolls,
    argumentObject?.max_status_polls,
    remoteCodeRun?.maxStatusPolls,
    remoteCodeRun?.max_status_polls,
  ));
  if (maxStatusPolls !== undefined) {
    params.maxStatusPolls = maxStatusPolls;
  }

  const statusPollIntervalMs = normalizeInteger(firstDefined(
    params.statusPollIntervalMs,
    params.status_poll_interval_ms,
    argumentObject?.statusPollIntervalMs,
    argumentObject?.status_poll_interval_ms,
    remoteCodeRun?.statusPollIntervalMs,
    remoteCodeRun?.status_poll_interval_ms,
  ));
  if (statusPollIntervalMs !== undefined) {
    params.statusPollIntervalMs = statusPollIntervalMs;
  }

  const adminMode = normalizeBoolean(firstDefined(params.adminMode, params.admin_mode, params.runnerAdmin, params.runner_admin, argumentObject?.adminMode, argumentObject?.admin_mode));
  if (adminMode !== undefined) {
    params.adminMode = adminMode;
  }
}

function omitNullishRemoteCliResultFields(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== null && value !== undefined),
  );
}

class RemoteCliAgentTool extends ToolBase {
  constructor(options = {}) {
    super({
      id: options.id || 'remote-cli-agent',
      name: options.name || 'Remote CLI Agent',
      description: options.description || [
        'Run one of the two active server-side coding CLIs: Kimi CLI for Kimi models and Codex for OpenAI models, with the legacy remote-cli MCP lane available for compatibility.',
        'Use for remote/server coding/build/deploy tasks that should stream progress through the trusted backend runner, with adminMode for scoped live software changes.',
        'Remote deployments must preserve Git visibility: inspect status/remotes, create or reuse a git-backed workspace, commit before deploy, return GIT_BRANCH, GIT_BASE_COMMIT, GIT_COMMIT, CHANGED_FILES, verification markers, and use git revert plus redeploy for rollback.',
      ].join(' '),
      category: 'ssh',
      version: '1.0.0',
      backend: {
        sideEffects: ['network', 'execute', 'write'],
        sandbox: { network: true },
        timeout: 900000,
      },
      inputSchema: {
        type: 'object',
        required: ['task'],
        properties: {
          task: {
            type: 'string',
            description: 'Coding or deployment task for the remote CLI agent.',
          },
          targetId: {
            type: 'string',
            description: 'Gateway remoteCliTargets targetId. Defaults to REMOTE_CLI_DEFAULT_TARGET_ID or prod.',
          },
          cwd: {
            type: 'string',
            description: 'Verified absolute Linux workspace on the selected target. Omit to use that target default; never reuse paths across targets or copy terminal output into cwd.',
          },
          reasoningEffort: {
            type: 'string',
            description: 'Reasoning effort for the selected CLI model; preserve the workload setting (normally high for company agents).',
          },
          workspacePath: {
            type: 'string',
            description: 'Workspace path for the /api/codex-agent/run contract. Defaults to cwd or configured workspace path.',
          },
          sessionId: {
            type: 'string',
            description: 'Remote coding session ID or Codex session marker returned by a prior run.',
          },
          threadId: {
            type: 'string',
            description: 'Codex thread id for continuing a prior /api/codex-agent/run conversation.',
          },
          jobId: {
            type: 'string',
            description: 'Remote coding job ID returned by remote_code_run for checking an in-progress offshoot with remote_code_status.',
          },
          mcpSessionId: {
            type: 'string',
            description: 'Streamable HTTP MCP session ID returned by a prior remote-cli-agent call.',
          },
          waitMs: {
            type: 'integer',
            default: 30000,
            description: 'Initial wait time for long remote_code_run jobs before polling remote_code_status.',
          },
          maxTurns: {
            type: 'integer',
            default: 20,
            description: 'Maximum inner Agents SDK turns for this remote task.',
          },
          agentRunTimeoutMs: {
            type: 'integer',
            default: 1800000,
            description: 'Maximum time to wait for the selected provider or Codex agent. Provider-agent tasks return resumable running state when the gateway keeps the task active; only the legacy MCP inner-agent lane uses direct remote_code_run fallback.',
          },
          remoteCodeModel: {
            type: 'string',
            default: '',
            description: 'Optional model passed to the gateway remote_code_run worker. Leave blank to use the gateway target default.',
          },
          maxStatusPolls: {
            type: 'integer',
            default: 20,
            description: 'Maximum compatibility-fallback remote_code_status polls after remote_code_run returns a jobId. Defaults high enough for normal remote coding jobs to finish before returning resumable job/session markers.',
          },
          statusPollIntervalMs: {
            type: 'integer',
            default: 2000,
            description: 'Delay between remote_code_status polls.',
          },
          adminMode: {
            type: 'boolean',
            default: false,
            description: 'Allow the remote CLI agent to use the configured admin-capable runner lane for real remote change/deploy work. Privileged use remains scoped by runner policy and task instructions.',
          },
          transport: {
            type: 'string',
            enum: ['provider-agent', 'codex-agent', 'mcp', 'auto'],
            description: 'Transport contract override. provider-agent uses the gateway CLI provider selected from the model family; codex-agent uses POST /api/codex-agent/run plus /events SSE; mcp uses legacy remote_code_run/status.',
          },
          model: {
            type: 'string',
            description: 'Selected chat model. Kimi and OpenAI families choose their matching gateway CLI provider on the shared task lane.',
          },
          instructions: {
            type: 'string',
            description: 'Optional additional server-side instructions for the remote coding agent.',
          },
          supportAgentResponse: {
            type: 'string',
            description: 'Answer or analysis from a support agent to feed into a resumed Codex-agent thread after SUPPORT_AGENT_REQUIRED.',
          },
          artifactIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Session-owned artifact IDs to stage as files for the selected Codex or Kimi CLI agent.',
          },
          contextFiles: {
            type: 'array',
            items: { type: 'object' },
            description: 'Bounded inline files to stage for the remote agent. Each item supports filename, content or contentBase64, mimeType, sha256, and description.',
          },
          resultFileGlobs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional workspace-relative output patterns the gateway may collect after the CLI agent finishes.',
          },
          collectResultFiles: {
            type: 'boolean',
            description: 'Create an isolated return-files area and collect gateway-verified outputs. Automatically enabled when artifactIds, contextFiles, or resultFileGlobs are supplied.',
          },
          continuitySummary: {
            type: 'string',
            description: 'Bounded project continuity context assembled by KimiBuilt from prior verified remote work. Usually populated automatically.',
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          finalOutput: { type: 'string' },
          mcpSessionId: { type: 'string' },
          transport: { type: 'string' },
          codexAgentRunId: { type: 'string' },
          codexThreadId: { type: 'string' },
          codexTurnId: { type: 'string' },
          targetId: { type: 'string' },
          cwd: { type: 'string' },
          sessionId: { type: 'string' },
          remoteCodeSessionId: { type: 'string' },
          remoteCodeJobId: { type: 'string' },
          gitRepo: { type: 'string' },
          gitBranch: { type: 'string' },
          gitBaseCommit: { type: 'string' },
          gitCommit: { type: 'string' },
          changedFiles: { type: 'array' },
          deployment: { type: 'string' },
          publicHost: { type: 'string' },
          publicUrl: { type: 'string' },
          uiCheckReport: { type: 'string' },
          uiScreenshots: { type: 'array' },
          whatChanged: { type: 'string' },
          supportAgentRequest: { type: 'string' },
          supportAgentContext: { type: 'string' },
          verifyCommands: { type: 'array' },
          verifyResults: { type: 'array' },
          blocker: { type: 'string' },
          completionStatus: { type: 'string' },
          agentQuality: { type: 'object' },
          artifactQuality: { type: 'object' },
          model: { type: 'string' },
          providerModel: { type: 'string' },
          apiMode: { type: 'string' },
          providerId: { type: 'string' },
          handoffVersion: { type: 'string' },
          requestedHandoffVersion: { type: 'string' },
          inputArtifactIds: { type: 'array' },
          resultFilesManifest: { type: 'string' },
          resultFiles: { type: 'array' },
          resultFilesError: { type: 'string' },
          artifacts: { type: 'array' },
          artifactIds: { type: 'array' },
          siteBundleArtifact: { type: 'object' },
          siteBundleArtifactId: { type: 'string' },
        },
      },
      hooks: {
        beforeExecute: normalizeRemoteCliAgentParams,
      },
    });

    this.runner = options.runner || remoteCliAgentsSdkRunner;
    this.artifactService = options.artifactService || artifactService;
  }

  async handler(params, _context, tracker) {
    tracker.recordNetworkCall('remote-cli-mcp', 'CONNECT', {
      targetId: params.targetId || null,
      cwd: params.cwd || null,
    });
    tracker.recordExecution('remote-cli-agent', {
      task: String(params.task || '').slice(0, 200),
    });

    const prior = getRemoteCliAgentStateFromContext(_context);
    const isOwnedJobPoll = Boolean(params.jobId && params.jobId === prior.remoteCodeJobId
      && (!params.targetId || params.targetId === prior.targetId));
    const priorHandoff = isOwnedJobPoll
      ? normalizeRemoteAgentHandoffContinuation(prior.remoteAgentHandoff) : null;
    const handoff = priorHandoff || await createRemoteAgentHandoff(params, _context, {
      artifactService: this.artifactService,
    });
    const runParams = {
      ...params,
      handoff,
      ...(priorHandoff ? { resumeOnly: true } : {}),
      ...(typeof _context?.onProgress === 'function' ? { onProgress: _context.onProgress } : {}),
    };

    const result = await this.runner.run(runParams);
    const { resultFiles: rawResultFiles, ...safeResult } = result || {};
    const effectiveHandoff = normalizeRemoteAgentHandoffContinuation(result?.remoteAgentHandoff) || handoff;
    if (safeResult.remoteCodeJobId && effectiveHandoff) {
      safeResult.remoteAgentHandoff = normalizeRemoteAgentHandoffContinuation(effectiveHandoff);
    }
    let persistedResultArtifacts = {};
    if (rawResultFiles) {
      try {
        persistedResultArtifacts = await persistRemoteAgentResultArtifacts({
          resultFiles: rawResultFiles,
          handoff: effectiveHandoff,
          artifactService: this.artifactService,
          context: _context,
          runResult: result,
        });
      } catch (error) {
        const resultFilesError = `Remote agent output files could not be persisted: ${error.message}`;
        safeResult.resultFilesError = resultFilesError;
        if (error?.artifactQuality) {
          safeResult.artifactQuality = error.artifactQuality;
        }
        safeResult.blocker = safeResult.blocker || resultFilesError;
        safeResult.completionStatus = 'blocked';
        safeResult.verifyResults = [
          ...(Array.isArray(safeResult.verifyResults) ? safeResult.verifyResults : []),
          resultFilesError,
        ];
        safeResult.structuredResult = buildRemoteCliStructuredResult({
          task: params.task,
          metadata: safeResult,
          agentQuality: safeResult.agentQuality || null,
        });
        safeResult.humanSummary = safeResult.structuredResult.humanSummary;
      }
    }

    return omitNullishRemoteCliResultFields({
      ...safeResult,
      ...persistedResultArtifacts,
      ...(effectiveHandoff ? {
        requestedHandoffVersion: effectiveHandoff.version,
        inputArtifactIds: effectiveHandoff.sourceArtifactIds,
      } : {}),
    });
  }
}

module.exports = {
  RemoteCliAgentTool,
};

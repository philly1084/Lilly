'use strict';

const { ToolBase } = require('../../ToolBase');
const { remoteCliAgentsSdkRunner } = require('../../../../remote-cli/agents-sdk-runner');

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

function applyAlias(params, targetKey, ...values) {
  if (params[targetKey] !== undefined && params[targetKey] !== null && String(params[targetKey]).trim() !== '') {
    return;
  }
  const value = firstDefined(...values);
  if (value !== undefined) {
    params[targetKey] = value;
  }
}

function normalizeRemoteCliAgentParams(params = {}) {
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

  if (!params.task && firstNonEmptyText(params.command, argumentObject?.command, nestedParams?.command)) {
    const error = new Error('remote-cli-agent expects params.task for a remote coding/deploy objective. Use remote-command when you need to run one raw command.');
    error.code = 'REMOTE_CLI_AGENT_TASK_REQUIRED';
    throw error;
  }

  applyAlias(params, 'targetId', params.target_id, argumentObject?.targetId, argumentObject?.target_id, remoteCodeRun?.targetId, remoteCodeRun?.target_id);
  applyAlias(params, 'cwd', params.workingDirectory, params.working_directory, argumentObject?.cwd, argumentObject?.workingDirectory, remoteCodeRun?.cwd);
  applyAlias(params, 'sessionId', params.session_id, params.remoteSessionId, params.remote_session_id, argumentObject?.sessionId, argumentObject?.session_id, remoteCodeRun?.sessionId, remoteCodeRun?.session_id);
  applyAlias(params, 'jobId', params.job_id, params.remoteCodeJobId, params.remote_code_job_id, argumentObject?.jobId, argumentObject?.job_id);
  applyAlias(params, 'mcpSessionId', params.mcp_session_id, argumentObject?.mcpSessionId, argumentObject?.mcp_session_id);
  applyAlias(params, 'remoteCodeModel', params.remote_code_model, argumentObject?.remoteCodeModel, argumentObject?.remote_code_model, remoteCodeRun?.model);

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

class RemoteCliAgentTool extends ToolBase {
  constructor(options = {}) {
    super({
      id: options.id || 'remote-cli-agent',
      name: options.name || 'Remote CLI Agent',
      description: options.description || [
        'Run a server-side OpenAI Agents SDK coding agent with the remote-cli Streamable HTTP MCP gateway attached.',
        'Use for remote server coding/build/deploy tasks that should go through remote_code_run and remote_code_status, with adminMode for scoped live software changes.',
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
            description: 'Allowed working directory on the target. Defaults to REMOTE_CLI_DEFAULT_CWD or the gateway target default.',
          },
          sessionId: {
            type: 'string',
            description: 'Remote coding session ID returned by remote_code_run for continuing prior work.',
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
            default: 180000,
            description: 'Maximum time to let the inner agent model run before falling back to direct remote_code_run.',
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
          model: {
            type: 'string',
            description: 'Optional model override for the inner OpenAI Agents SDK agent.',
          },
          instructions: {
            type: 'string',
            description: 'Optional additional server-side instructions for the remote coding agent.',
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          finalOutput: { type: 'string' },
          mcpSessionId: { type: 'string' },
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
          verifyCommands: { type: 'array' },
          verifyResults: { type: 'array' },
          blocker: { type: 'string' },
          completionStatus: { type: 'string' },
          model: { type: 'string' },
          apiMode: { type: 'string' },
        },
      },
      hooks: {
        beforeExecute: normalizeRemoteCliAgentParams,
      },
    });

    this.runner = options.runner || remoteCliAgentsSdkRunner;
  }

  async handler(params, _context, tracker) {
    tracker.recordNetworkCall('remote-cli-mcp', 'CONNECT', {
      targetId: params.targetId || null,
      cwd: params.cwd || null,
    });
    tracker.recordExecution('remote-cli-agent', {
      task: String(params.task || '').slice(0, 200),
    });

    const runParams = typeof _context?.onProgress === 'function'
      ? { ...params, onProgress: _context.onProgress }
      : params;

    return this.runner.run(runParams);
  }
}

module.exports = {
  RemoteCliAgentTool,
};

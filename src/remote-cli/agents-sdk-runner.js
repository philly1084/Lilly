'use strict';

const { config } = require('../config');
const settingsController = require('../routes/admin/settings.controller');

function normalizeText(value = '') {
  return String(value || '').trim();
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
    'Use remote_code_run for coding tasks.',
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
    'If it returns status "running", call remote_code_status with the returned jobId.',
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
      timeoutMs: normalizePositiveInteger(this.config.timeoutMs, 60000, { min: 1000 }),
      maxTurns: normalizePositiveInteger(this.config.maxTurns, 20, { min: 1, max: 80 }),
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
    const waitMs = normalizePositiveInteger(input.waitMs || input.wait_ms, 30000, { min: 1000, max: 300000 });
    const maxTurns = normalizePositiveInteger(input.maxTurns || input.max_turns || this.config.maxTurns, 20, { min: 1, max: 80 });
    const model = normalizeText(input.model || this.config.agentModel) || 'gpt-4o';
    const adminMode = resolveAdminMode(input, task);
    const apiMode = resolveAgentsApiMode({
      requestedMode: this.config.agentApiMode,
      baseURL: this.config.agentBaseURL,
    });

    if (typeof setOpenAIAPI === 'function') {
      setOpenAIAPI(apiMode);
    }

    const remoteCli = this.createMcpServer(MCPServerStreamableHttp, input);
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

      const result = await runner.run(agent, buildRemoteCliPrompt({
        task,
        targetId,
        cwd,
        sessionId,
        waitMs,
        adminMode,
      }), {
        maxTurns,
      });

      const finalOutput = result.finalOutput || '';
      const runMetadata = extractRemoteCliRunMetadata(finalOutput);

      return {
        finalOutput,
        mcpSessionId: remoteCli.sessionId || input.mcpSessionId || null,
        targetId,
        cwd: runMetadata.workspace || cwd,
        sessionId: runMetadata.sessionId || sessionId || null,
        remoteCodeSessionId: runMetadata.sessionId || sessionId || null,
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

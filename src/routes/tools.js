/**
 * Tools API - For Frontend Tool Discovery
 * Allows frontends to query and invoke available tools
 */

const express = require('express');
const router = express.Router();
const { getUnifiedRegistry } = require('../agent-sdk/registry/UnifiedRegistry');
const { getToolManager } = require('../agent-sdk/tools');
const { readToolDoc, getToolDocMetadata, REMOTE_CLI_COMMAND_CATALOG } = require('../agent-sdk/tool-docs');
const settingsController = require('./admin/settings.controller');
const { config } = require('../config');
const { ttsService } = require('../tts/tts-service');
const { audioProcessingService } = require('../audio/audio-processing-service');
const { podcastVideoService } = require('../video/podcast-video-service');
const { sessionStore } = require('../session-store');
const { inferExecutionProfile } = require('../runtime-execution');
const { canonicalizeRemoteToolId, isRemoteCommandToolId, isSuspiciousSshTargetHost } = require('../ai-route-utils');
const { getSessionControlState } = require('../runtime-control-state');
const {
  buildScopedSessionMetadata,
  isSessionIsolationEnabled,
  resolveClientSurface,
} = require('../session-scope');
const { clusterStateRegistry } = require('../cluster-state-registry');
const { remoteRunnerService } = require('../remote-runner/service');
const { remoteCliAgentsSdkRunner } = require('../remote-cli/agents-sdk-runner');
const {
  DEFAULT_EXECUTION_PROFILE,
  NOTES_EXECUTION_PROFILE,
  REMOTE_BUILD_EXECUTION_PROFILE,
  PODCAST_EXECUTION_PROFILE,
  PODCAST_VIDEO_EXECUTION_PROFILE,
  HIDDEN_FRONTEND_TOOL_IDS,
  getAllowedToolIdsForProfile,
} = require('../tool-execution-profiles');

const registry = getUnifiedRegistry();
const DISABLED_TOOL_IDS = new Set([]);
const DISABLED_TOOL_MESSAGE = 'Tool is disabled.';
const REMOTE_SERVICE_TOOL_IDS = new Set([
  'managed-app',
  'remote-command',
  'remote-workbench',
  'remote-cli-agent',
  'k3s-deploy',
]);

function getRequestOwnerId(req) {
  return String(req.user?.username || '').trim() || null;
}

async function ensureToolManagerInitialized() {
  const toolManager = getToolManager();
  await toolManager.initialize();
  return toolManager;
}

function isInternalClusterBaseURL(baseURL = '') {
  const normalized = String(baseURL || '').trim();
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    return parsed.hostname.includes('.svc.cluster.local')
      || parsed.hostname === 'ollama'
      || parsed.hostname === 'qdrant'
      || parsed.hostname === 'postgres';
  } catch (_error) {
    return normalized.includes('.svc.cluster.local');
  }
}

function buildRuntimeSummary(toolManager, options = {}) {
  const ssh = settingsController.getEffectiveSshConfig();
  const deploy = typeof settingsController.getEffectiveDeployConfig === 'function'
    ? settingsController.getEffectiveDeployConfig()
    : {};
  const gitProvider = typeof settingsController.getEffectiveGitProviderConfig === 'function'
    ? settingsController.getEffectiveGitProviderConfig()
    : {};
  const gitea = Object.keys(gitProvider).length > 0
    ? gitProvider
    : (typeof settingsController.getEffectiveGiteaConfig === 'function'
      ? settingsController.getEffectiveGiteaConfig()
      : {});
  const healthyRunner = remoteRunnerService.getHealthyRunner();
  const runnerCliTools = buildRunnerCliTools(healthyRunner);
  return {
    source: 'backend',
    toolManagerInitialized: Boolean(toolManager?.initialized),
    totalRegisteredTools: toolManager?.registry?.getAllTools?.().length || 0,
    modelGateway: {
      baseURL: config.openai.baseURL,
      internalCluster: isInternalClusterBaseURL(config.openai.baseURL),
    },
    sshDefaults: {
      enabled: Boolean(ssh.enabled),
      configured: Boolean(ssh.enabled && ssh.host && ssh.username && (ssh.password || ssh.privateKeyPath)),
      source: ssh.source || 'dashboard',
      host: ssh.host || '',
      port: ssh.port || 22,
      username: ssh.username || '',
      hasPassword: Boolean(ssh.password),
      hasPrivateKey: Boolean(ssh.privateKeyPath),
    },
    deployDefaults: {
      repositoryUrl: deploy.repositoryUrl || '',
      targetDirectory: deploy.targetDirectory || '',
      manifestsPath: deploy.manifestsPath || '',
      namespace: deploy.namespace || '',
      deployment: deploy.deployment || '',
      container: deploy.container || '',
      branch: deploy.branch || '',
      publicDomain: deploy.publicDomain || '',
      ingressClassName: deploy.ingressClassName || '',
      tlsClusterIssuer: deploy.tlsClusterIssuer || '',
    },
    gitProvider: {
      provider: gitea.provider || 'gitlab',
      enabled: gitea.enabled !== false,
      configured: Boolean(gitea.enabled !== false && gitea.baseURL && gitea.token),
      baseURL: gitea.baseURL || '',
      org: gitea.org || '',
      registryHost: gitea.registryHost || '',
      hasWebhookSecret: Boolean(gitea.webhookSecret),
    },
    managedApps: options.managedAppService
      ? {
        configured: Boolean(gitea.enabled !== false && gitea.baseURL && gitea.token),
        persistenceAvailable: typeof options.managedAppService.isAvailable === 'function'
          ? options.managedAppService.isAvailable()
          : null,
        gitlab: {
          baseURL: gitea.baseURL || '',
          org: gitea.org || '',
          registryHost: gitea.registryHost || '',
        },
      }
      : null,
    clusterRegistry: clusterStateRegistry.getRuntimeSummary(),
    remoteRunner: {
      enabled: config.remoteRunner.enabled !== false,
      configured: Boolean(config.remoteRunner.token),
      preferred: config.remoteRunner.preferred !== false,
      runners: remoteRunnerService.listRunners(),
      healthy: Boolean(healthyRunner),
      defaultRunnerId: healthyRunner?.runnerId || '',
      defaultWorkspace: healthyRunner?.metadata?.defaultCwd || healthyRunner?.metadata?.workspace || '',
      shell: healthyRunner?.metadata?.shell || '',
      capabilities: healthyRunner?.capabilities || [],
      allowedRoots: healthyRunner?.allowedRoots || [],
      browserAutomation: healthyRunner?.metadata?.browserAutomation || null,
      cliTools: runnerCliTools,
      availableCliTools: runnerCliTools.filter((tool) => tool.available).map((tool) => tool.name),
    },
  };
}

function buildRunnerCliTools(runner = null) {
  const metadata = runner?.metadata || {};
  const cliTools = Array.isArray(metadata.cliTools) ? metadata.cliTools : [];
  const availableNames = new Set(
    (Array.isArray(metadata.availableCliTools) ? metadata.availableCliTools : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean),
  );

  if (cliTools.length > 0) {
    return cliTools
      .map((tool) => ({
        name: String(tool?.name || '').trim(),
        available: tool?.available !== false,
        path: String(tool?.path || '').trim(),
      }))
      .filter((tool) => tool.name);
  }

  return Array.from(availableNames).map((name) => ({
    name,
    available: true,
    path: '',
  }));
}

function buildRunnerRuntimeDetails(runner = null) {
  if (!runner) {
    return null;
  }

  const cliTools = buildRunnerCliTools(runner);
  return {
    runnerId: runner.runnerId,
    displayName: runner.displayName || runner.runnerId,
    capabilities: runner.capabilities || [],
    allowedRoots: runner.allowedRoots || [],
    defaultWorkspace: runner.metadata?.defaultCwd || runner.metadata?.workspace || '',
    workspace: runner.metadata?.workspace || '',
    shell: runner.metadata?.shell || '',
    buildkitHostConfigured: Boolean(runner.metadata?.buildkitHostConfigured),
    kubernetesConfigured: Boolean(runner.metadata?.kubernetesConfigured),
    imagePrefix: runner.metadata?.imagePrefix || '',
    browserAutomation: runner.metadata?.browserAutomation || null,
    hostIdentity: runner.hostIdentity || {},
    cliTools,
    availableCliTools: cliTools.filter((tool) => tool.available).map((tool) => tool.name),
  };
}

function buildK3sFeedbackReadiness(runner = null) {
  const runnerDetails = buildRunnerRuntimeDetails(runner);
  const availableCliTools = new Set((runnerDetails?.availableCliTools || []).map((tool) => tool.toLowerCase()));
  const hasKubectl = availableCliTools.has('kubectl');
  const hasBuildctl = availableCliTools.has('buildctl');
  const hasGit = availableCliTools.has('git');
  const buildkitReady = Boolean(runnerDetails?.buildkitHostConfigured && hasBuildctl);
  const kubernetesReady = Boolean(runnerDetails?.kubernetesConfigured && hasKubectl);
  const imagePushReady = Boolean(buildkitReady && runnerDetails?.imagePrefix);
  const deployReady = Boolean(runnerDetails && kubernetesReady);
  const buildToK3sReady = Boolean(runnerDetails && buildkitReady && kubernetesReady && hasGit && imagePushReady);
  const blockers = [
    !runnerDetails ? 'No online deploy-capable remote runner is registered.' : '',
    runnerDetails && !hasGit ? 'Runner did not report git.' : '',
    runnerDetails && !hasBuildctl ? 'Runner did not report buildctl.' : '',
    runnerDetails && !runnerDetails?.buildkitHostConfigured ? 'Runner did not report BUILDKIT_HOST.' : '',
    runnerDetails && !hasKubectl ? 'Runner did not report kubectl.' : '',
    runnerDetails && !runnerDetails?.kubernetesConfigured ? 'Runner did not report Kubernetes configuration.' : '',
    runnerDetails && !runnerDetails?.imagePrefix ? 'Runner did not report DIRECT_CLI_IMAGE_PREFIX.' : '',
  ].filter(Boolean);

  return {
    runnerReady: Boolean(runnerDetails),
    deployReady,
    buildkitReady,
    kubernetesReady,
    imagePushReady,
    buildToK3sReady,
    requiredCliTools: ['git', 'buildctl', 'kubectl'],
    availableCliTools: runnerDetails?.availableCliTools || [],
    imagePrefix: runnerDetails?.imagePrefix || '',
    blockers,
  };
}

function buildToolRuntime(toolId, options = {}) {
  if (toolId === 'remote-cli-agent') {
    const publicConfig = remoteCliAgentsSdkRunner.getPublicConfig();
    const runner = remoteRunnerService.getHealthyRunner('', { requiredProfile: 'deploy' });
    const runnerDetails = buildRunnerRuntimeDetails(runner);
    return {
      configured: publicConfig.configured,
      provider: 'openai-agents-sdk-streamable-http-mcp',
      serverName: publicConfig.name,
      url: publicConfig.url,
      defaultTargetId: publicConfig.defaultTargetId,
      defaultCwd: publicConfig.defaultCwd,
      agentModel: publicConfig.agentModel,
      timeoutMs: publicConfig.timeoutMs,
      maxTurns: publicConfig.maxTurns,
      adminModeSupported: true,
      serverSideOnly: true,
      runnerAvailable: Boolean(runner),
      runner: runnerDetails,
      defaultWorkspace: runnerDetails?.defaultWorkspace || '',
      shell: runnerDetails?.shell || '',
      cliTools: runnerDetails?.cliTools || [],
      availableCliTools: runnerDetails?.availableCliTools || [],
      k3sFeedback: buildK3sFeedbackReadiness(runner),
    };
  }

  if (toolId === 'managed-app') {
    const gitProvider = typeof settingsController.getEffectiveGitProviderConfig === 'function'
      ? settingsController.getEffectiveGitProviderConfig()
      : {};
    const managedApps = typeof settingsController.getEffectiveManagedAppsConfig === 'function'
      ? settingsController.getEffectiveManagedAppsConfig()
      : {};
    return {
      configured: Boolean(gitProvider.enabled !== false && gitProvider.baseURL && gitProvider.token),
      provider: gitProvider.provider || 'gitlab',
      baseURL: gitProvider.baseURL || '',
      org: gitProvider.org || '',
      registryHost: gitProvider.registryHost || '',
      hasToken: Boolean(gitProvider.token),
      hasWebhookSecret: Boolean(gitProvider.webhookSecret),
      persistenceAvailable: typeof options.managedAppService?.isAvailable === 'function'
        ? options.managedAppService.isAvailable()
        : null,
      deployTarget: managedApps.deployTarget || '',
      platformNamespace: managedApps.platformNamespace || '',
      appBaseDomain: managedApps.appBaseDomain || '',
      webhookEndpointPath: managedApps.webhookEndpointPath || '',
      observability: 'gitlab-repo-pipeline-build-events',
    };
  }

  if (toolId === 'remote-workbench') {
    const ssh = settingsController.getEffectiveSshConfig();
    const runner = remoteRunnerService.getHealthyRunner();
    const runnerDetails = buildRunnerRuntimeDetails(runner);
    return {
      configured: Boolean(runner || (ssh.enabled && ssh.host && ssh.username && (ssh.password || ssh.privateKeyPath))),
      source: runner ? 'remote-runner' : (ssh.source || 'dashboard'),
      defaultTarget: runner ? `runner:${runner.runnerId}` : (ssh.host ? `${ssh.username || 'unknown'}@${ssh.host}:${ssh.port || 22}` : null),
      auth: ssh.privateKeyPath ? 'private-key' : (ssh.password ? 'password' : 'unset'),
      runnerAvailable: Boolean(runner),
      runner: runnerDetails,
      defaultWorkspace: runnerDetails?.defaultWorkspace || '',
      shell: runnerDetails?.shell || '',
      cliTools: runnerDetails?.cliTools || [],
      availableCliTools: runnerDetails?.availableCliTools || [],
      transportPreference: runner ? 'runner-first' : 'ssh',
      structuredActions: [
        'baseline',
        'repo-inspect',
        'repo-map',
        'changed-files',
        'git-prepare',
        'git-snapshot',
        'git-commit',
        'git-revert',
        'file-search',
        'dependency-check',
        'grep',
        'read-file',
        'write-file',
        'apply-patch',
        'build',
        'test',
        'focused-test',
        'buildkit',
        'direct-image-build',
        'ui-visual-check',
        'kubectl-inspect',
        'k8s-app-inventory',
        'logs',
        'pod-debug',
        'rollout',
        'deploy-verify',
      ],
      commandCatalog: REMOTE_CLI_COMMAND_CATALOG,
    };
  }

  if (isRemoteCommandToolId(toolId)) {
    const ssh = settingsController.getEffectiveSshConfig();
    const runner = remoteRunnerService.getHealthyRunner();
    const runnerDetails = buildRunnerRuntimeDetails(runner);
    return {
      configured: Boolean(runner || (ssh.enabled && ssh.host && ssh.username && (ssh.password || ssh.privateKeyPath))),
      source: runner ? 'remote-runner' : (ssh.source || 'dashboard'),
      defaultTarget: runner ? `runner:${runner.runnerId}` : (ssh.host ? `${ssh.username || 'unknown'}@${ssh.host}:${ssh.port || 22}` : null),
      auth: ssh.privateKeyPath ? 'private-key' : (ssh.password ? 'password' : 'unset'),
      runnerAvailable: Boolean(runner),
      runner: runnerDetails,
      defaultWorkspace: runnerDetails?.defaultWorkspace || '',
      shell: runnerDetails?.shell || '',
      cliTools: runnerDetails?.cliTools || [],
      availableCliTools: runnerDetails?.availableCliTools || [],
      transportPreference: runner ? 'runner-first' : 'ssh',
      commandCatalog: REMOTE_CLI_COMMAND_CATALOG,
    };
  }

  if (toolId === 'k3s-deploy') {
    const ssh = settingsController.getEffectiveSshConfig();
    const deploy = typeof settingsController.getEffectiveDeployConfig === 'function'
      ? settingsController.getEffectiveDeployConfig()
      : {};
    const runner = remoteRunnerService.getHealthyRunner('', { requiredProfile: 'deploy' });
    const runnerDetails = buildRunnerRuntimeDetails(runner);
    return {
      configured: Boolean(runner || (ssh.enabled && ssh.host && ssh.username && (ssh.password || ssh.privateKeyPath))),
      source: runner ? 'remote-runner' : (ssh.source || 'dashboard'),
      defaultTarget: runner ? `runner:${runner.runnerId}` : (ssh.host ? `${ssh.username || 'unknown'}@${ssh.host}:${ssh.port || 22}` : null),
      defaultRepositoryUrl: deploy.repositoryUrl || '',
      defaultTargetDirectory: deploy.targetDirectory || '',
      defaultManifestsPath: deploy.manifestsPath || '',
      defaultNamespace: deploy.namespace || '',
      defaultDeployment: deploy.deployment || '',
      defaultContainer: deploy.container || '',
      defaultBranch: deploy.branch || '',
      defaultPublicDomain: deploy.publicDomain || '',
      defaultIngressClassName: deploy.ingressClassName || '',
      defaultTlsClusterIssuer: deploy.tlsClusterIssuer || '',
      runnerAvailable: Boolean(runner),
      runner: runnerDetails,
      defaultWorkspace: runnerDetails?.defaultWorkspace || '',
      shell: runnerDetails?.shell || '',
      cliTools: runnerDetails?.cliTools || [],
      availableCliTools: runnerDetails?.availableCliTools || [],
      transportPreference: runner ? 'runner-first' : 'ssh',
      k3sFeedback: buildK3sFeedbackReadiness(runner),
      commandCatalog: REMOTE_CLI_COMMAND_CATALOG.filter((entry) => [
        'k8s-manifest-summary',
        'kubectl-inspect',
        'k8s-app-inventory',
        'logs',
        'pod-debug',
        'rollout',
        'https-verify',
        'deploy-verify',
        'ingress-plan',
        'ingress-apply',
        'ingress-verify',
      ].includes(entry.id)),
    };
  }

  if (toolId === 'git-safe') {
    return {
      configured: true,
      provider: 'local',
      defaultRepositoryPath: config.deploy.defaultRepositoryPath || '',
    };
  }

  if (toolId === 'docker-exec') {
    return {
      configured: Boolean(process.env.DOCKER_HOST),
      provider: 'docker',
      dockerHost: process.env.DOCKER_HOST || '',
    };
  }

  if (toolId === 'code-sandbox') {
    return {
      configured: true,
      provider: 'docker-or-project-artifact',
      dockerConfigured: Boolean(process.env.DOCKER_HOST),
      projectModeAvailable: true,
      dockerHost: process.env.DOCKER_HOST || '',
    };
  }

  if (toolId === 'web-search') {
    return {
      configured: Boolean(process.env.PERPLEXITY_API_KEY),
      provider: process.env.PERPLEXITY_API_KEY ? 'perplexity' : 'unconfigured',
      callerContract: [
        'Use raw search for URL discovery, scraping prep, and candidate page hotlists.',
        'Use pro-search for researched synthesis, news roundups, source-backed briefings, and gathered research data.',
        'When no timeframe is supplied, make searches freshness-aware with modern/recent phrasing or a month-level range for news and technology.',
        'Verify selected result URLs with web-fetch before composing reports, documents, slides, or researched HTML.',
      ],
    };
  }

  if (toolId === 'image-generate') {
    const hasGatewayImageProvider = Boolean(config.openai.apiKey);
    const hasOfficialMediaProvider = Boolean(config.media.apiKey);
    return {
      configured: Boolean(hasGatewayImageProvider || hasOfficialMediaProvider),
      provider: hasGatewayImageProvider ? 'gateway' : (hasOfficialMediaProvider ? 'official-openai' : 'unconfigured'),
      model: config.openai.imageModel || config.media.imageModel || '',
      requestTimeoutMs: config.openai.toolRequestTimeoutMs || config.openai.requestTimeoutMs || null,
      callerContract: [
        'Call before composing websites, HTML, documents, PDFs, or presentations that need generated visuals.',
        'Wait for the tool result; image generation can take several minutes.',
        'Continue only after usableCount, artifacts/artifactIds, or markdownImages confirms a reusable image.',
      ],
    };
  }

  if (toolId === 'image-search-unsplash') {
    return {
      configured: Boolean(process.env.UNSPLASH_ACCESS_KEY),
      provider: process.env.UNSPLASH_ACCESS_KEY ? 'unsplash' : 'unconfigured',
    };
  }

  if (toolId === 'web-fetch') {
    return {
      configured: true,
      provider: 'local',
      callerContract: [
        'Use after web-search to verify selected URLs before citing or composing source-backed outputs.',
        'Prefer for direct page/PDF fetches, lightweight source checks, and non-JavaScript pages.',
        'Escalate to web-scrape when the page needs browser rendering, screenshots, or structured extraction.',
      ],
    };
  }

  if (toolId === 'web-scrape') {
    return {
      configured: true,
      provider: 'browser-runtime',
      callerContract: [
        'Use for JS-rendered pages, screenshots, visual QA, or explicit structured field extraction.',
        'Prefer web-fetch first for simple URL verification so routine research stays fast.',
        'Capture screenshots for frontend or generated-HTML proof when a rendered surface matters.',
      ],
    };
  }

  if (toolId === 'document-workflow') {
    return {
      configured: true,
      provider: 'local-document-service',
      supportedFormats: ['html', 'pdf', 'pptx', 'xlsx', 'md'],
      normalizedFormats: {
        docx: 'html',
        doc: 'html',
        word: 'html',
      },
      callerContract: [
        'Use plan before generate for broad, design-sensitive, or multi-surface document requests.',
        'Do not present DOCX/Word as a native finished runtime format; it currently normalizes to HTML unless an external conversion path is named and verified.',
        'For PDFs, preserve explicit @page geometry and verify rendered page breaks, contrast, tables, captions, and images.',
        'For PPTX/XLSX, inspect or render the generated artifact with available office or spreadsheet tooling before delivery.',
        'Handoff must include source files, artifact IDs or URLs, checks run, fixed issues, and remaining assumptions.',
      ],
    };
  }

  if (toolId === 'image-from-url') {
    return {
      configured: true,
      provider: 'direct-url',
    };
  }

  if (toolId === 'speech-generate') {
    return ttsService.getPublicConfig();
  }

  if (toolId === 'podcast') {
    return {
      tts: ttsService.getPublicConfig(),
      audioProcessing: audioProcessingService.getPublicConfig(),
      video: podcastVideoService.getPublicConfig(),
      researchConfigured: Boolean(process.env.PERPLEXITY_API_KEY),
      modelConfigured: Boolean(config.openai.apiKey),
    };
  }

  if ([
    'asset-search',
    'research-bucket-list',
    'research-bucket-search',
    'research-bucket-read',
    'research-bucket-write',
    'research-bucket-mkdir',
    'news-scraper',
    'file-read',
    'file-write',
    'file-search',
    'file-mkdir',
    'git-safe',
    'tool-doc-read',
    'security-scan',
    'architecture-design',
    'uml-generate',
    'api-design',
    'graph-diagram',
    'schema-generate',
    'migration-create',
  ].includes(toolId)) {
    return {
      configured: true,
      provider: 'local',
    };
  }

  return null;
}

function reconcileRuntimeWithSupport(toolId, runtime = null, support = null) {
  if (!runtime || !support?.runtime) {
    return runtime;
  }

  if (['docker-exec', 'code-sandbox'].includes(toolId)) {
    return {
      ...runtime,
      configured: Boolean(runtime.configured || support.runtime.ready),
      runtimeReady: support.runtime.ready ?? null,
    };
  }

  return runtime;
}

function resolveRequiresSetup(toolId, fallback = false, runtime = null, support = null) {
  if (!REMOTE_SERVICE_TOOL_IDS.has(toolId)) {
    return Boolean(fallback);
  }

  if (runtime?.configured || support?.runtime?.ready) {
    return false;
  }

  if (support?.status) {
    return support.status === 'requires_setup';
  }

  return true;
}

function reconcileSupportWithRuntime(toolId, support = null, runtime = null) {
  if (!REMOTE_SERVICE_TOOL_IDS.has(toolId) || !support || !runtime?.configured) {
    return support;
  }

  if (support.status !== 'requires_setup') {
    return support;
  }

  return {
    ...support,
    status: 'stable',
    notes: (Array.isArray(support.notes) ? support.notes : [])
      .filter((note) => !/^\s*(requires|needs|missing|no online|ssh client is unavailable|remote runner or ssh configuration)\b/i.test(String(note || ''))),
  };
}

function isToolVisibleByRuntime(toolId, runtime = null, support = null) {
  if (HIDDEN_FRONTEND_TOOL_IDS.includes(toolId)) {
    return false;
  }

  if (['docker-exec', 'code-sandbox'].includes(toolId)) {
    return Boolean(support?.runtime?.ready || runtime?.configured);
  }

  if (toolId === 'k3s-deploy') {
    return Boolean(support?.runtime?.ready || runtime?.configured);
  }

  if (['web-search', 'image-generate', 'image-search-unsplash'].includes(toolId)) {
    return Boolean(runtime?.configured);
  }

  return true;
}

async function buildFrontendToolCatalog({ req, category = null, sessionId = null, includeAllTools = false }) {
  const toolManager = await ensureToolManagerInitialized();
  const managedAppService = req.app?.locals?.managedAppService || null;
  const { executionProfile } = await resolveToolExecutionProfile(req, sessionId);
  const allowedToolIds = getAllowedToolIdsForProfile(executionProfile);

  const manifestTools = (includeAllTools ? registry.getAllManifests() : registry.getFrontendTools())
    .filter((tool) => !HIDDEN_FRONTEND_TOOL_IDS.includes(tool.id))
    .filter((tool) => tool.id !== 'ssh-execute');

  const enrichedTools = await Promise.all(manifestTools.map(async (tool) => {
    const docMetadata = await getToolDocMetadata(tool.id);
    const runtime = reconcileRuntimeWithSupport(
      tool.id,
      buildToolRuntime(tool.id, { managedAppService }),
      docMetadata.support,
    );
    const support = reconcileSupportWithRuntime(tool.id, docMetadata.support, runtime);
    const availableInExecutionProfile = allowedToolIds.includes(tool.id);
    const runtimeVisible = isToolVisibleByRuntime(tool.id, runtime, support);

    return {
      ...tool,
      requiresSetup: resolveRequiresSetup(tool.id, tool.requiresSetup, runtime, support),
      runtime,
      availableInExecutionProfile,
      runtimeVisible,
      ...docMetadata,
      support,
    };
  }));

  const filteredTools = enrichedTools.filter((tool) => {
    if (category && category !== 'all' && tool.category !== category) {
      return false;
    }

    if (includeAllTools) {
      return true;
    }

    return tool.availableInExecutionProfile && tool.runtimeVisible;
  });

  return {
    toolManager,
    executionProfile,
    includeAllTools,
    tools: filteredTools,
  };
}

function buildToolExecutionContext(toolManager, req, sessionId = null, session = null) {
  const body = req.body || {};
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const timezone = String(
    metadata.timezone
    || metadata.timeZone
    || req.get('x-timezone')
    || '',
  ).trim() || null;
  const rawClientNow = String(
    metadata.clientNow
    || metadata.client_now
    || req.get('x-client-now')
    || '',
  ).trim();
  const parsedClientNow = rawClientNow ? new Date(rawClientNow) : null;
  const now = parsedClientNow && !Number.isNaN(parsedClientNow.getTime())
    ? parsedClientNow.toISOString()
    : null;
  return {
    sessionId,
    session,
    sessionIsolation: isSessionIsolationEnabled({
      sessionIsolation: body.sessionIsolation || body.session_isolation,
      metadata,
    }),
    userId: req.user?.id || req.user?.username,
    timestamp: new Date().toISOString(),
    route: req.originalUrl || req.path || '/api/tools/invoke',
    transport: 'http',
    executionProfile: body.executionProfile || body.execution_profile || body.clientSurface || body.client_surface || 'tool-invoke',
    model: String(
      body.model
      || metadata.requestedModel
      || session?.metadata?.model
      || ''
    ).trim() || null,
    timezone,
    now,
    toolManager,
    managedAppService: req.app?.locals?.managedAppService || null,
    tools: {
      get: (toolId) => toolManager.getTool(toolId),
    },
  };
}

async function resolveToolSession(sessionId = null, ownerId = null) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return null;
  }

  return ownerId
    ? sessionStore.getOwned(normalizedSessionId, ownerId)
    : sessionStore.get(normalizedSessionId);
}

async function persistToolSessionModel(sessionId = null, ownerId = null, model = null) {
  const normalizedModel = String(model || '').trim();
  const session = await resolveToolSession(sessionId, ownerId);

  if (!session || !normalizedModel || session?.metadata?.model === normalizedModel) {
    return session;
  }

  const updated = await sessionStore.update(sessionId, {
    metadata: {
      model: normalizedModel,
    },
  });

  return updated || session;
}

function looksLikeNotesSurface(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return [
    'notes',
    'notes-app',
    'notes_app',
    'notes-editor',
    'notes_editor',
  ].includes(normalized);
}

function looksLikePodcastSurface(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return [
    'podcast',
    'podcast-audio',
    'podcast_audio',
  ].includes(normalized);
}

function looksLikePodcastVideoSurface(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return [
    'podcast-video',
    'podcast_video',
    'video-podcast',
    'video_podcast',
  ].includes(normalized);
}

function hasStickyRemoteSession(session = null) {
  const controlState = getSessionControlState(session);
  return isRemoteCommandToolId(controlState.lastToolIntent)
    || Boolean(controlState.lastSshTarget?.host);
}

async function resolveToolExecutionProfile(req, requestedSessionId = null) {
  const normalizedSessionId = typeof requestedSessionId === 'string' ? requestedSessionId.trim() : '';
  const ownerId = getRequestOwnerId(req);
  const session = normalizedSessionId && !normalizedSessionId.startsWith('local_')
    ? (ownerId ? await sessionStore.getOwned(normalizedSessionId, ownerId) : await sessionStore.get(normalizedSessionId))
    : null;
  const surfaceHint = req.query?.taskType
    || req.query?.task_type
    || req.query?.clientSurface
    || req.query?.client_surface
    || req.body?.taskType
    || req.body?.task_type
    || req.body?.clientSurface
    || req.body?.client_surface
    || session?.mode
    || session?.metadata?.taskType
    || session?.metadata?.clientSurface;
  const taskType = looksLikeNotesSurface(surfaceHint)
    ? NOTES_EXECUTION_PROFILE
    : looksLikePodcastVideoSurface(surfaceHint)
      ? PODCAST_VIDEO_EXECUTION_PROFILE
      : looksLikePodcastSurface(surfaceHint)
        ? PODCAST_EXECUTION_PROFILE
        : DEFAULT_EXECUTION_PROFILE;

  let executionProfile = inferExecutionProfile({
    executionProfile: req.query?.executionProfile
      || req.query?.execution_profile
      || req.body?.executionProfile
      || req.body?.execution_profile
      || null,
    taskType,
    session,
  });

  if (
    executionProfile !== REMOTE_BUILD_EXECUTION_PROFILE
    && executionProfile !== PODCAST_EXECUTION_PROFILE
    && executionProfile !== PODCAST_VIDEO_EXECUTION_PROFILE
    && hasStickyRemoteSession(session)
  ) {
    executionProfile = REMOTE_BUILD_EXECUTION_PROFILE;
  }

  return {
    session,
    executionProfile,
  };
}

async function resolveToolSessionId(requestedSessionId = null, ownerId = null, scopeMetadata = {}) {
  const normalized = typeof requestedSessionId === 'string' ? requestedSessionId.trim() : '';
  const sessionMetadata = buildScopedSessionMetadata({
    mode: scopeMetadata?.taskType || scopeMetadata?.mode || 'chat',
    taskType: scopeMetadata?.taskType || scopeMetadata?.mode || 'chat',
    clientSurface: resolveClientSurface(scopeMetadata || {}, null, scopeMetadata?.taskType || scopeMetadata?.mode || 'chat'),
    memoryScope: scopeMetadata?.memoryScope || scopeMetadata?.memory_scope || '',
  });

  if (ownerId) {
    const session = await sessionStore.resolveOwnedSession(
      normalized && !normalized.startsWith('local_') ? normalized : null,
      sessionMetadata,
      ownerId,
    );
    return session?.id || null;
  }

  if (normalized && !normalized.startsWith('local_')) {
    const session = await sessionStore.getOrCreate(normalized, sessionMetadata);
    return session?.id || normalized;
  }

  const session = await sessionStore.create(sessionMetadata);
  return session.id;
}

function unwrapToolResultPayload(result = {}) {
  const envelope = result && typeof result === 'object' ? result : {};
  return envelope.data || envelope.result || envelope;
}

function normalizeToolText(value = '') {
  return String(value || '').trim();
}

function normalizeToolHost(value = '') {
  const normalized = normalizeToolText(value);
  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    return parsed.host.replace(/\/+$/g, '');
  } catch (_error) {
    return normalized
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/g, '')
      .replace(/\/+$/g, '');
  }
}

function normalizeToolPublicUrl(value = '', fallbackHost = '') {
  const normalized = normalizeToolText(value);
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  const host = normalizeToolHost(fallbackHost || normalized);
  return host ? `https://${host}` : '';
}

function buildRemoteCliActiveProjectPatch(session = null, payload = {}, params = {}) {
  const explicitPublicUrl = normalizeToolPublicUrl(payload?.publicUrl || payload?.livePublicUrl || payload?.deployedUrl || '');
  const publicHost = normalizeToolHost(explicitPublicUrl || payload?.publicHost || payload?.livePublicHost || payload?.deployedHost || '');
  const publicUrl = explicitPublicUrl || normalizeToolPublicUrl('', publicHost);
  if (!publicUrl && !publicHost) {
    return null;
  }

  const currentMetadata = session?.metadata && typeof session.metadata === 'object'
    ? session.metadata
    : {};
  const existingProject = currentMetadata.activeProject && typeof currentMetadata.activeProject === 'object' && !Array.isArray(currentMetadata.activeProject)
    ? currentMetadata.activeProject
    : {};
  const existingType = normalizeToolText(existingProject.type).toLowerCase();
  const title = normalizeToolText(
    existingProject.title
    || existingProject.appName
    || existingProject.appSlug
    || payload?.deployment
    || publicHost
    || params?.task
    || 'Live project',
  );
  const now = new Date().toISOString();

  return {
    ...existingProject,
    type: existingType || 'remote-project',
    title,
    publicHost,
    publicUrl,
    targetPublicHost: publicHost,
    targetPublicUrl: publicUrl,
    livePublicHost: publicHost,
    livePublicUrl: publicUrl,
    deployedHost: publicHost,
    deployedUrl: publicUrl,
    publicVerificationObserved: true,
    verificationStatus: 'live',
    phase: normalizeToolText(existingProject.phase || existingProject.status || 'live'),
    status: normalizeToolText(existingProject.status || 'live'),
    summary: normalizeToolText(payload?.whatChanged || existingProject.summary || ''),
    remoteCliAgent: {
      ...(existingProject.remoteCliAgent && typeof existingProject.remoteCliAgent === 'object' ? existingProject.remoteCliAgent : {}),
      ...(payload?.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload?.mcpSessionId ? { mcpSessionId: payload.mcpSessionId } : {}),
      ...(payload?.targetId ? { targetId: payload.targetId } : {}),
      ...(payload?.cwd || params?.cwd ? { cwd: payload?.cwd || params.cwd } : {}),
      ...(payload?.gitRepo ? { gitRepo: payload.gitRepo } : {}),
      ...(payload?.gitCommit ? { gitCommit: payload.gitCommit } : {}),
      ...(payload?.deployment ? { deployment: payload.deployment } : {}),
      ...(payload?.uiCheckReport ? { uiCheckReport: payload.uiCheckReport } : {}),
      updatedAt: now,
    },
    updatedAt: now,
  };
}

async function recordRemoteToolRegistryEvent(sessionId, session = null, toolId = '', params = {}, result = {}) {
  if (!REMOTE_SERVICE_TOOL_IDS.has(toolId)) {
    return;
  }

  const objective = String(params.task || params.prompt || params.message || params.command || params.workflowAction || params.action || '').trim();
  try {
    clusterStateRegistry.recordToolEvents({
      sessionId,
      objective,
      toolEvents: [{
        toolCall: {
          function: {
            name: toolId,
            arguments: JSON.stringify(params || {}),
          },
        },
        result,
        reason: objective,
      }],
      controlState: getSessionControlState(session),
    });
  } catch (error) {
    console.warn('[Tools API] Failed to update remote continuity registry:', error?.message || error);
  }
}

async function updateSessionToolMetadata(sessionId, toolId, params = {}, result = {}) {
  const isRemoteWorkbenchTool = toolId === 'remote-workbench';
  if (!sessionId || (!isRemoteCommandToolId(toolId) && !isRemoteWorkbenchTool)) {
    return;
  }

  if (toolId === 'remote-cli-agent') {
    const payload = unwrapToolResultPayload(result);
    const session = typeof sessionStore.get === 'function'
      ? await sessionStore.get(sessionId).catch(() => null)
      : null;
    const activeProject = buildRemoteCliActiveProjectPatch(session, payload, params);
    const task = String(params.task || params.prompt || params.message || '').trim();
    const remoteCliPatch = {
      lastTask: task || null,
      lastTaskAt: new Date().toISOString(),
      ...(payload?.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload?.mcpSessionId ? { mcpSessionId: payload.mcpSessionId } : {}),
      ...(payload?.targetId ? { targetId: payload.targetId } : {}),
      ...(payload?.cwd || params.cwd ? { cwd: payload?.cwd || params.cwd } : {}),
      ...(payload?.remoteCodeSessionId ? { remoteCodeSessionId: payload.remoteCodeSessionId } : {}),
      ...(payload?.gitRepo ? { gitRepo: payload.gitRepo } : {}),
      ...(payload?.gitBranch ? { gitBranch: payload.gitBranch } : {}),
      ...(payload?.gitBaseCommit ? { gitBaseCommit: payload.gitBaseCommit } : {}),
      ...(payload?.gitCommit ? { gitCommit: payload.gitCommit } : {}),
      ...(Array.isArray(payload?.changedFiles) && payload.changedFiles.length > 0 ? { changedFiles: payload.changedFiles } : {}),
      ...(payload?.deployment ? { deployment: payload.deployment } : {}),
      ...(payload?.publicHost ? { publicHost: payload.publicHost } : {}),
      ...(payload?.publicUrl ? { publicUrl: payload.publicUrl } : {}),
      ...(payload?.uiCheckReport ? { uiCheckReport: payload.uiCheckReport } : {}),
      ...(Array.isArray(payload?.uiScreenshots) && payload.uiScreenshots.length > 0 ? { uiScreenshots: payload.uiScreenshots } : {}),
      ...(payload?.whatChanged ? { whatChanged: payload.whatChanged } : {}),
      ...(payload?.supportAgentRequest ? { supportAgentRequest: payload.supportAgentRequest } : {}),
      ...(payload?.supportAgentContext ? { supportAgentContext: payload.supportAgentContext } : {}),
      ...(Array.isArray(payload?.verifyCommands) && payload.verifyCommands.length > 0 ? { verifyCommands: payload.verifyCommands } : {}),
      ...(Array.isArray(payload?.verifyResults) && payload.verifyResults.length > 0 ? { verifyResults: payload.verifyResults } : {}),
      ...(payload?.blocker ? { blocker: payload.blocker } : {}),
      ...(payload?.completionStatus ? { completionStatus: payload.completionStatus } : {}),
      ...(payload?.model ? { model: payload.model } : {}),
    };
    const controlPatch = {
      lastToolIntent: 'remote-cli-agent',
      remoteCliAgent: remoteCliPatch,
    };

    if (sessionStore.updateControlState) {
      await sessionStore.updateControlState(sessionId, controlPatch);
    }

    await sessionStore.update(sessionId, {
      metadata: {
        ...controlPatch,
        ...(activeProject ? { activeProject } : {}),
      },
    });
    return;
  }

  const host = String(params.host || '').trim();
  const safeHost = host && !isSuspiciousSshTargetHost(host) ? host : '';

  const payload = unwrapToolResultPayload(result);
  const command = String(params.command || payload.command || '').trim();
  const workflowAction = String(params.workflowAction || params.workflow_action || (isRemoteWorkbenchTool ? params.action : '') || '').trim();
  const remoteCliPatch = {
    lastCommand: command || null,
    lastCommandAt: new Date().toISOString(),
    ...(workflowAction ? { currentPlan: workflowAction } : {}),
    ...(/\b(verify|rollout|curl|ingress|tls|certificate|kubectl get)\b/i.test(`${workflowAction}\n${command}`)
      ? {
        lastVerifiedState: {
          command,
          workflowAction: workflowAction || null,
          verifiedAt: new Date().toISOString(),
        },
      }
      : {}),
  };
  const controlPatch = {
    lastToolIntent: isRemoteWorkbenchTool ? 'remote-workbench' : canonicalizeRemoteToolId(toolId),
    remoteCli: remoteCliPatch,
    ...(safeHost ? {
      lastSshTarget: {
        host: safeHost,
        username: params.username || '',
        port: params.port || 22,
      },
    } : {}),
  };

  if (sessionStore.updateControlState) {
    await sessionStore.updateControlState(sessionId, controlPatch);
  }

  await sessionStore.update(sessionId, {
    metadata: {
      ...controlPatch,
    },
  });
}

async function updateSessionToolFailureMetadata(sessionId, toolId, params = {}, error = null) {
  const isRemoteWorkbenchTool = toolId === 'remote-workbench';
  if (!sessionId || (!isRemoteCommandToolId(toolId) && !isRemoteWorkbenchTool)) {
    return;
  }

  const workflowAction = String(params.workflowAction || params.workflow_action || (isRemoteWorkbenchTool ? params.action : '') || '').trim();
  const message = String(error?.message || error || 'Tool invocation failed').trim();

  if (toolId === 'remote-cli-agent') {
    const task = String(params.task || params.prompt || params.message || '').trim();
    const remoteCliPatch = {
      lastTask: task || null,
      lastTaskAt: new Date().toISOString(),
      lastFailure: {
        task,
        reason: message,
        failedAt: new Date().toISOString(),
      },
    };
    const controlPatch = {
      lastToolIntent: 'remote-cli-agent',
      remoteCliAgent: remoteCliPatch,
    };

    if (sessionStore.updateControlState) {
      await sessionStore.updateControlState(sessionId, controlPatch);
    }

    await sessionStore.update(sessionId, {
      metadata: {
        ...controlPatch,
      },
    });
    return;
  }

  const command = String(params.command || '').trim();
  const remoteCliPatch = {
    lastCommand: command || null,
    lastCommandAt: new Date().toISOString(),
    ...(workflowAction ? { currentPlan: workflowAction } : {}),
    lastFailure: {
      command,
      workflowAction: workflowAction || null,
      reason: message,
      failedAt: new Date().toISOString(),
    },
  };
  const controlPatch = {
    lastToolIntent: isRemoteWorkbenchTool ? 'remote-workbench' : canonicalizeRemoteToolId(toolId),
    remoteCli: remoteCliPatch,
  };

  if (sessionStore.updateControlState) {
    await sessionStore.updateControlState(sessionId, controlPatch);
  }

  await sessionStore.update(sessionId, {
    metadata: {
      ...controlPatch,
    },
  });
}

/**
 * GET /api/tools/available
 * Get all tools available to frontends
 */
router.get('/available', async (req, res) => {
  try {
    const { category, sessionId } = req.query;
    const includeAllTools = ['1', 'true', 'yes'].includes(String(req.query?.includeAll || '').trim().toLowerCase());
    const {
      toolManager,
      executionProfile,
      tools,
    } = await buildFrontendToolCatalog({
      req,
      category,
      sessionId,
      includeAllTools,
    });

    res.json({
      success: true,
      data: tools,
      meta: {
        total: tools.length,
        categories: [...new Set(tools.map(t => t.category))],
        executionProfile,
        includeAllTools,
        runtime: buildRuntimeSummary(toolManager, {
          managedAppService: req.app?.locals?.managedAppService || null,
          ownerId: getRequestOwnerId(req),
        }),
      }
    });
  } catch (error) {
    console.error('Error getting available tools:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tools/categories
 * Get tool categories with counts
 */
router.get('/categories', async (req, res) => {
  try {
    const { sessionId } = req.query;
    const includeAllTools = ['1', 'true', 'yes'].includes(String(req.query?.includeAll || '').trim().toLowerCase());
    const { executionProfile, tools } = await buildFrontendToolCatalog({
      req,
      sessionId,
      includeAllTools,
    });
    const categories = [...new Set(tools.map((tool) => tool.category))];

    const result = categories.map(cat => ({
      id: cat,
      name: cat.charAt(0).toUpperCase() + cat.slice(1),
      count: tools.filter(t => t.category === cat).length,
      icon: getCategoryIcon(cat)
    }));
    
    res.json({
      success: true,
      data: result,
      meta: {
        executionProfile,
        includeAllTools,
      },
    });
  } catch (error) {
    console.error('Error getting categories:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tools/stats
 * Get tool usage statistics
 */
router.get('/stats', async (req, res) => {
  try {
    await ensureToolManagerInitialized();
    const stats = registry.getAllSkills().map(skill => ({
      id: skill.id,
      name: skill.name,
      category: skill.category,
      invocations: skill.stats?.invocations || skill.stats?.usageCount || 0,
      successRate: skill.stats?.successRate || 100,
      avgDuration: skill.stats?.avgDuration || 0,
      lastUsed: skill.stats?.lastUsed,
      recentUsage: skill.stats?.recentUsage || [],
    }));
    
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error getting tool stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tools/docs/:id
 * Load detailed tool documentation on demand
 */
router.get('/docs/:id', async (req, res) => {
  try {
    await ensureToolManagerInitialized();
    const { id } = req.params;

    if (DISABLED_TOOL_IDS.has(id)) {
      return res.status(404).json({ success: false, error: DISABLED_TOOL_MESSAGE });
    }

    const metadata = await getToolDocMetadata(id);

    if (!metadata.docAvailable) {
      return res.status(404).json({ success: false, error: 'Tool documentation not found' });
    }

    const doc = await readToolDoc(id);
    res.json({
      success: true,
      data: {
        toolId: id,
        content: doc.content,
        support: metadata.support,
      },
    });
  } catch (error) {
    console.error('Error getting tool documentation:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tools/:id
 * Get tool details
 */
router.get('/:id', async (req, res) => {
  try {
    const toolManager = await ensureToolManagerInitialized();
    const { id } = req.params;

    if (DISABLED_TOOL_IDS.has(id)) {
      return res.status(404).json({ success: false, error: DISABLED_TOOL_MESSAGE });
    }
    
    const tool = registry.getTool(id);
    const manifest = registry.getManifest(id);
    const skill = registry.getSkill(id);
    
    if (!tool) {
      return res.status(404).json({ success: false, error: 'Tool not found' });
    }
    
    const docMetadata = await getToolDocMetadata(id);
    const runtime = reconcileRuntimeWithSupport(
      id,
      buildToolRuntime(id, {
        managedAppService: req.app?.locals?.managedAppService || null,
      }),
      docMetadata.support,
    );
    const support = reconcileSupportWithRuntime(id, docMetadata.support, runtime);
    const effectiveManifest = manifest
      ? {
          ...manifest,
          requiresSetup: resolveRequiresSetup(id, manifest.requiresSetup, runtime, support),
        }
      : manifest;

    res.json({
      success: true,
      data: {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        version: tool.version,
        manifest: effectiveManifest,
        requiresSetup: resolveRequiresSetup(id, manifest?.requiresSetup, runtime, support),
        runtime,
        skill: skill ? {
          enabled: skill.enabled,
          triggerPatterns: skill.triggerPatterns,
          requiresConfirmation: skill.requiresConfirmation,
          stats: skill.stats || null,
        } : null,
        parameters: manifest?.parameters || [],
        ...docMetadata,
        support,
      },
      meta: {
        runtime: buildRuntimeSummary(toolManager, {
          managedAppService: req.app?.locals?.managedAppService || null,
          ownerId: getRequestOwnerId(req),
        }),
      },
    });
  } catch (error) {
    console.error('Error getting tool:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tools/invoke
 * Invoke a tool
 */
router.post('/invoke', async (req, res) => {
  let resolvedSessionId = null;
  let toolId = null;
  let params = {};
  try {
    ({ tool: toolId, params = {} } = req.body);
    const { sessionId } = req.body;
    const ownerId = getRequestOwnerId(req);
    
    if (!toolId) {
      return res.status(400).json({ success: false, error: 'Tool ID is required' });
    }

    if (DISABLED_TOOL_IDS.has(toolId)) {
      return res.status(400).json({ success: false, error: DISABLED_TOOL_MESSAGE });
    }
    
    const toolManager = await ensureToolManagerInitialized();
    resolvedSessionId = await resolveToolSessionId(sessionId, ownerId, req.body || {});
    const resolvedSession = await persistToolSessionModel(
      resolvedSessionId,
      ownerId,
      req.body?.model || req.body?.metadata?.requestedModel || null,
    );
    
    const result = await toolManager.executeTool(
      toolId,
      params,
      buildToolExecutionContext(toolManager, req, resolvedSessionId, resolvedSession),
    );
    await recordRemoteToolRegistryEvent(resolvedSessionId, resolvedSession, toolId, params, result);
    await updateSessionToolMetadata(resolvedSessionId, toolId, params, result);
    
    res.json({ success: true, data: result, sessionId: resolvedSessionId });
  } catch (error) {
    console.error('Error invoking tool:', error);
    await updateSessionToolFailureMetadata(resolvedSessionId || req.body?.sessionId, toolId, params, error)
      .catch((metadataError) => console.warn('[Tools API] Failed to record tool failure metadata:', metadataError?.message || metadataError));
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tools/invoke/:id
 * Invoke a specific tool
 */
router.post('/invoke/:id', async (req, res) => {
  let resolvedSessionId = null;
  let params = {};
  try {
    const { id } = req.params;
    params = req.body;
    const ownerId = getRequestOwnerId(req);

    if (DISABLED_TOOL_IDS.has(id)) {
      return res.status(400).json({ success: false, error: DISABLED_TOOL_MESSAGE });
    }
    
    const toolManager = await ensureToolManagerInitialized();
    resolvedSessionId = await resolveToolSessionId(req.body.sessionId, ownerId, req.body || {});
    const resolvedSession = await persistToolSessionModel(
      resolvedSessionId,
      ownerId,
      req.body?.model || req.body?.metadata?.requestedModel || null,
    );
    
    const result = await toolManager.executeTool(
      id,
      params,
      buildToolExecutionContext(toolManager, req, resolvedSessionId, resolvedSession),
    );
    await recordRemoteToolRegistryEvent(resolvedSessionId, resolvedSession, id, params, result);
    await updateSessionToolMetadata(resolvedSessionId, id, params, result);
    
    res.json({ success: true, data: result, sessionId: resolvedSessionId });
  } catch (error) {
    console.error('Error invoking tool:', error);
    await updateSessionToolFailureMetadata(resolvedSessionId || req.body?.sessionId, req.params?.id, params, error)
      .catch((metadataError) => console.warn('[Tools API] Failed to record tool failure metadata:', metadataError?.message || metadataError));
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper functions

function getCategoryIcon(category) {
  const icons = {
    web: 'globe',
    ssh: 'terminal',
    design: 'pen-tool',
    sandbox: 'shield',
    database: 'database',
    system: 'settings'
  };
  return icons[category] || 'tool';
}

module.exports = router;

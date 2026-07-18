'use strict';

const { createHash } = require('crypto');
const { config } = require('../config');
const settingsController = require('../routes/admin/settings.controller');
const { clusterStateRegistry } = require('../cluster-state-registry');
const { broadcastToAdmins, broadcastToSession } = require('../realtime-hub');
const { createResponse } = require('../openai-client');
const { extractResponseText } = require('../artifacts/artifact-service');
const { parseLenientJson } = require('../utils/lenient-json');
const { buildProjectMemoryUpdate, mergeProjectMemory } = require('../project-memory');
const { sessionStore } = require('../session-store');
const { managedAppStore } = require('./store');
const { GitLabClient } = require('./gitlab-client');
const {
    KubernetesClient,
    extractOciSha256DigestFromImageRef,
    normalizeOciSha256Digest,
} = require('./kubernetes-client');
const { remoteCliAgentsSdkRunner } = require('../remote-cli/agents-sdk-runner');
const {
    buildDefaultScaffoldFiles,
    buildManagedAppAuthoringPrompt,
    normalizeGeneratedManagedAppSourceFiles,
} = require('./scaffold');

function normalizeText(value = '') {
    return String(value || '').trim();
}

function normalizeManagedAppWebhookBaseUrl(value = '') {
    const normalized = normalizeText(value).replace(/\/+$/, '');
    if (!normalized) {
        return '';
    }

    try {
        const parsed = new URL(normalized);
        const pathnameSegments = String(parsed.pathname || '')
            .split('/')
            .filter(Boolean);

        while (pathnameSegments.length > 0) {
            const tail = String(pathnameSegments[pathnameSegments.length - 1] || '').trim().toLowerCase();
            if (tail === 'v1' || tail === 'api') {
                pathnameSegments.pop();
                continue;
            }
            break;
        }

        parsed.pathname = pathnameSegments.length > 0
            ? `/${pathnameSegments.join('/')}`
            : '';
        parsed.search = '';
        parsed.hash = '';

        return parsed.toString().replace(/\/+$/, '');
    } catch (_error) {
        return normalized;
    }
}

const MAX_MANAGED_APP_SLUG_LENGTH = 63;
const MAX_KUBERNETES_NAME_LENGTH = 63;
const DEFAULT_GITLAB_RUNNER_TAGS = 'kimibuilt,buildkit';
const DEFAULT_MANAGED_APP_SLUG_PREFIX = 'managed-app';
const GIT_COMMIT_SHA_PATTERN = /^[a-f0-9]{7,64}$/i;
const KIMIBUILT_BUILD_RUN_SOURCES = new Set(['managed-app-service', 'remote-cli-agent']);
const MANAGED_APP_VIEWPORT_STATE_KEYS = [
    'viewportSize',
    'projectViewportSize',
    'previousViewportSize',
    'previousProjectViewportSize',
];
const MANAGED_APP_ITERATION_ACTIONS = new Set(['edit', 'build', 'deploy', 'verify']);
const PROMPT_NAME_STOPWORDS = new Set([
    'a', 'an', 'and', 'app', 'application', 'build', 'built', 'called', 'can', 'could', 'create', 'deploy',
    'deployment', 'for', 'from', 'generate', 'help', 'host', 'hosting', 'i', 'in', 'into', 'it', 'just',
    'like', 'make', 'managed', 'me', 'my', 'named', 'need', 'on', 'our', 'ours', 'page', 'please', 'project',
    'put', 'really', 'remote', 'repo', 'repository', 'server', 'servers', 'service', 'should', 'simple',
    'site', 'something', 'stuff', 'that', 'the', 'this', 'to', 'tool', 'too', 'use', 'using', 'us', 'want',
    'we', 'website', 'will', 'with', 'would', 'you', 'your', 'another', 'brand', 'current', 'different',
    'existing', 'fresh', 'instead', 'new', 'old', 'same', 'scratch',
]);

function baseSlugify(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function truncateSlug(value = '', maxLength = 0) {
    const normalized = baseSlugify(value);
    if (!normalized || !Number.isFinite(Number(maxLength)) || Number(maxLength) <= 0 || normalized.length <= Number(maxLength)) {
        return normalized;
    }

    const limit = Number(maxLength);
    if (limit <= 8) {
        return normalized.slice(0, limit).replace(/-+$/g, '');
    }

    const suffix = createHash('sha1').update(normalized).digest('hex').slice(0, 6);
    const prefixLimit = Math.max(1, limit - suffix.length - 1);
    const prefix = normalized.slice(0, prefixLimit).replace(/-+$/g, '') || normalized.slice(0, prefixLimit);
    return `${prefix}-${suffix}`.replace(/^-+|-+$/g, '');
}

function slugify(value = '', options = {}) {
    const maxLength = Number(options.maxLength) || 0;
    return maxLength > 0
        ? truncateSlug(value, maxLength)
        : baseSlugify(value);
}

function extractExplicitAppName(value = '') {
    const normalized = normalizeText(value);
    if (!normalized) {
        return '';
    }

    const patterns = [
        /\b(?:managed\s+app|application|app|site|website|project|game|repo(?:sitory)?)\s+(?:called|named)\s+["'`]?([^"'`\n.,!?;:]+)["'`]?/i,
        /\b(?:called|named)\s+["'`]?([^"'`\n.,!?;:]+)["'`]?/i,
    ];

    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (!match?.[1]) {
            continue;
        }

        const candidate = normalizeText(match[1])
            .replace(/\s+(?:that|which|with|for)\b.*$/i, '')
            .replace(/["'`]+$/g, '');
        if (candidate) {
            return candidate;
        }
    }

    return '';
}

function extractImplicitSubjectAppName(value = '') {
    const normalized = normalizeText(value);
    if (!normalized) {
        return '';
    }

    const patterns = [
        /\b(?:build|create|deploy|launch|make|ship|start)\s+(?:me\s+|us\s+|a\s+|an\s+|the\s+)?([^.,!?;:\n]{1,80}?)\s+(?:app|application|site|website|service|game)\b/i,
        /\b(?:an?|the)\s+([^.,!?;:\n]{1,80}?)\s+(?:app|application|site|website|service|game)\b/i,
    ];

    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        const candidate = summarizePromptName(match?.[1] || '');
        if (candidate) {
            return candidate;
        }
    }

    return '';
}

function hasExplicitPromptAppName(value = '') {
    return Boolean(extractExplicitAppName(value));
}

function hasExplicitManagedAppIdentityInput(input = {}) {
    const prompt = input.prompt || input.sourcePrompt || '';
    return Boolean(
        normalizeText(input.appRef || input.app || input.id || input.ref || '')
        || normalizeText(input.slug)
        || normalizeText(input.repoOwner)
        || normalizeText(input.repoName)
        || normalizeText(input.publicHost)
        || normalizeText(input.appName || input.name || input.title)
        || hasExplicitPromptAppName(prompt)
    );
}

function hasExplicitNewManagedAppIntent(input = {}) {
    const prompt = normalizeText(input.prompt || input.sourcePrompt || '').toLowerCase();
    if (!prompt) {
        return false;
    }

    return [
        /\b(?:brand new|from scratch|fresh|different|another)\b[\s\S]{0,30}\b(?:app|application|site|website|service|game)\b/,
        /\bnew\b[\s\S]{0,20}\b(?:managed app|app|application|site|website|service|game)\b/,
        /\b(?:create|build|make|start)\b[\s\S]{0,20}\banother\b/,
    ].some((pattern) => pattern.test(prompt));
}

function summarizePromptName(value = '') {
    const normalized = normalizeText(value);
    if (!normalized) {
        return '';
    }

    const tokens = normalized
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    if (tokens.length === 0) {
        return '';
    }

    const meaningful = tokens.filter((token) => !PROMPT_NAME_STOPWORDS.has(token));
    if (meaningful.length === 0) {
        return '';
    }

    const selected = meaningful.slice(0, 6);
    return selected.join(' ');
}

function deriveRequestedAppName(input = {}) {
    return normalizeText(
        input.appName
        || input.name
        || input.title
        || input.slug
        || input.repoName
        || extractExplicitAppName(input.prompt || input.sourcePrompt || '')
        || extractImplicitSubjectAppName(input.prompt || input.sourcePrompt || '')
        || summarizePromptName(input.prompt || input.sourcePrompt || ''),
    );
}

function buildFallbackRequestedAppName() {
    return `${DEFAULT_MANAGED_APP_SLUG_PREFIX}-${Date.now()}`;
}

function titleizeSlug(value = '') {
    return normalizeText(value)
        .split('-')
        .filter(Boolean)
        .map((entry) => entry.charAt(0).toUpperCase() + entry.slice(1))
        .join(' ');
}

function normalizeAppStatus(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    return normalized || 'draft';
}

function normalizeBuildStatus(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    return normalized || 'queued';
}

function isPendingBuildStatus(value = '') {
    const normalized = normalizeBuildStatus(value);
    return ['queued', 'pending', 'requested', 'running', 'in_progress', 'in-progress'].includes(normalized);
}

function isSuccessfulBuildStatus(value = '') {
    return normalizeBuildStatus(value) === 'success';
}

function isFailedBuildStatus(value = '') {
    return ['failed', 'failure', 'cancelled', 'canceled', 'timed_out', 'timed-out', 'skipped'].includes(normalizeBuildStatus(value));
}

function normalizeWorkflowRunBuildStatus(run = {}) {
    const status = normalizeText(run?.status || run?.state).toLowerCase();
    const conclusion = normalizeText(run?.conclusion || run?.result).toLowerCase();

    if (['success', 'successful'].includes(status) || ['success', 'successful'].includes(conclusion)) {
        return 'success';
    }

    if (['failure', 'failed', 'cancelled', 'canceled', 'timed_out', 'timed-out', 'skipped', 'neutral', 'action_required'].includes(status)
        || ['failure', 'failed', 'cancelled', 'canceled', 'timed_out', 'timed-out', 'skipped', 'neutral', 'action_required'].includes(conclusion)) {
        return 'failed';
    }

    if (['completed', 'done'].includes(status)) {
        return conclusion === 'success' ? 'success' : 'failed';
    }

    if (['in_progress', 'in-progress', 'running'].includes(status)) {
        return 'running';
    }

    return 'queued';
}

function buildManagedAppWorkflowRunUrl(run = {}, { repoOwner = '', repoName = '', baseURL = '' } = {}) {
    const explicit = normalizeText(run?.html_url || run?.run_url || run?.url);
    if (explicit) {
        return explicit;
    }

    const normalizedBase = normalizeText(baseURL).replace(/\/+$/, '');
    const normalizedOwner = normalizeText(repoOwner);
    const normalizedRepo = normalizeText(repoName);
    const runId = normalizeText(run?.id || run?.run_id);
    if (!normalizedBase || !normalizedOwner || !normalizedRepo || !runId) {
        return '';
    }

    return `${normalizedBase}/${normalizedOwner}/${normalizedRepo}/actions/runs/${runId}`;
}

function buildManagedAppRunSortValue(run = {}) {
    const candidate = normalizeText(
        run?.updated_at
        || run?.completed_at
        || run?.started_at
        || run?.run_started_at
        || run?.created_at,
    );
    if (candidate) {
        const timestamp = Date.parse(candidate);
        if (Number.isFinite(timestamp)) {
            return timestamp;
        }
    }

    const numericId = Number(run?.id || run?.run_id);
    return Number.isFinite(numericId) ? numericId : 0;
}

function selectMostRelevantManagedAppWorkflowRun(runs = [], buildRun = {}) {
    const candidates = Array.isArray(runs) ? [...runs] : [];
    if (candidates.length === 0) {
        return null;
    }

    const externalRunId = normalizeText(buildRun?.externalRunId);
    if (externalRunId) {
        const matchedById = candidates.find((entry) => normalizeText(entry?.id || entry?.run_id) === externalRunId);
        if (matchedById) {
            return matchedById;
        }
    }

    const commitSha = normalizeText(buildRun?.commitSha).toLowerCase();
    const matchedBySha = commitSha
        ? candidates.filter((entry) => normalizeText(entry?.head_sha).toLowerCase() === commitSha)
        : candidates;
    if (matchedBySha.length === 0) {
        return null;
    }

    matchedBySha.sort((left, right) => buildManagedAppRunSortValue(right) - buildManagedAppRunSortValue(left));
    return matchedBySha[0];
}

function normalizeRequestedAction(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    return normalized || 'build';
}

function normalizeIterationAction(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) {
        return 'edit';
    }
    if (['update', 'change', 'patch'].includes(normalized)) {
        return 'edit';
    }
    if (['publish', 'release', 'live', 'launch'].includes(normalized)) {
        return 'deploy';
    }
    if (['check', 'status', 'inspect'].includes(normalized)) {
        return 'verify';
    }
    return MANAGED_APP_ITERATION_ACTIONS.has(normalized) ? normalized : '';
}

function inferDeployRequested(value = '', fallback = false) {
    const normalized = normalizeRequestedAction(value);
    if (!normalized) {
        return fallback;
    }

    return ['deploy', 'publish', 'live', 'launch', 'release'].includes(normalized);
}

function isKimiBuiltInitiatedBuildRun(buildRun = null) {
    return Boolean(buildRun && KIMIBUILT_BUILD_RUN_SOURCES.has(normalizeText(buildRun.source).toLowerCase()));
}

function normalizeFilesInput(files = []) {
    return (Array.isArray(files) ? files : [])
        .filter((entry) => entry && typeof entry === 'object' && normalizeText(entry.path))
        .map((entry) => ({
            path: normalizeText(entry.path),
            content: String(entry.content || ''),
        }));
}

function createManagedAppLlmClient() {
    return {
        complete: async (prompt, options = {}) => {
            const response = await createResponse({
                input: prompt,
                stream: false,
                model: options.model || null,
                reasoningEffort: options.reasoningEffort || null,
            });
            return extractResponseText(response);
        },
    };
}

function mergeRepositoryFiles(baseFiles = [], overrideFiles = []) {
    const merged = new Map();

    (Array.isArray(baseFiles) ? baseFiles : []).forEach((entry) => {
        if (!entry || typeof entry !== 'object' || !normalizeText(entry.path)) {
            return;
        }
        merged.set(normalizeText(entry.path), {
            path: normalizeText(entry.path),
            content: String(entry.content || ''),
        });
    });

    (Array.isArray(overrideFiles) ? overrideFiles : []).forEach((entry) => {
        if (!entry || typeof entry !== 'object' || !normalizeText(entry.path)) {
            return;
        }
        merged.set(normalizeText(entry.path), {
            path: normalizeText(entry.path),
            content: String(entry.content || ''),
        });
    });

    return Array.from(merged.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function buildImageTagFromCommit(commitSha = '') {
    const normalized = normalizeText(commitSha);
    return normalized ? `sha-${normalized.slice(0, 12)}` : '';
}

function isValidGitCommitSha(value = '') {
    return GIT_COMMIT_SHA_PATTERN.test(normalizeText(value));
}

function extractHostFromUrl(value = '') {
    const normalized = normalizeText(value);
    if (!normalized) {
        return '';
    }

    try {
        return normalizeText(new URL(normalized).host);
    } catch (_error) {
        return '';
    }
}

function normalizePublicHost(value = '') {
    const normalized = normalizeText(value)
        .replace(/^https?:\/\//i, '')
        .split(/[/?#]/, 1)[0]
        .replace(/:\d+$/g, '')
        .replace(/\.+$/g, '')
        .toLowerCase();

    if (!normalized || normalized === 'localhost' || /^[0-9.]+$/.test(normalized)) {
        return '';
    }

    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)
        ? normalized
        : '';
}

function isControlPlaneHost(value = '') {
    const host = normalizePublicHost(value);
    return Boolean(host && /^(?:gitlab|gitea|registry|repo|repos|github|api|admin)\./i.test(host));
}

function extractPublicHostFromText(value = '', options = {}) {
    const text = normalizeText(value);
    if (!text) {
        return '';
    }

    const allowedDomains = normalizeStringArray(options.allowedDomains || [], 6)
        .map((entry) => normalizePublicHost(entry))
        .filter(Boolean);
    const matches = [
        ...Array.from(text.matchAll(/\bhttps?:\/\/([a-z0-9][a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#][^\s"'`]*)?/gi), (match) => match[1]),
        ...Array.from(text.matchAll(/\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/gi), (match) => match[1]),
    ];

    for (const match of matches) {
        const host = normalizePublicHost(match);
        if (!host || isControlPlaneHost(host)) {
            continue;
        }
        if (allowedDomains.length > 0 && !allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
            continue;
        }
        return host;
    }

    return '';
}

function resolveInputPublicHost(input = {}, managedAppsConfig = {}, deployConfig = {}) {
    const explicit = normalizePublicHost(input.publicHost || input.targetPublicHost);
    if (explicit) {
        return explicit;
    }

    const allowedDomains = normalizeStringArray([
        managedAppsConfig.appBaseDomain,
        config.deploy.defaultPublicDomain,
        deployConfig.defaultPublicDomain,
    ], 6);

    return extractPublicHostFromText([
        input.prompt,
        input.sourcePrompt,
        input.request,
        input.description,
    ].map((entry) => normalizeText(entry)).filter(Boolean).join('\n'), {
        allowedDomains,
    });
}

function normalizeImageRepo(value = '') {
    return normalizeText(value)
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
}

function isUsableImageRepo(value = '') {
    const normalized = normalizeImageRepo(value);
    if (!normalized) {
        return false;
    }

    const segments = normalized.split('/').filter(Boolean);
    if (segments.length < 3) {
        return false;
    }

    return segments.every((segment) => normalizeText(segment).toLowerCase() !== 'undefined');
}

function resolveManagedAppRegistryHost(giteaConfig = {}, app = {}) {
    return normalizeText(giteaConfig.registryHost)
        || extractHostFromUrl(giteaConfig.baseURL)
        || extractHostFromUrl(app.repoUrl)
        || extractHostFromUrl(app.repoCloneUrl)
        || '';
}

function resolveManagedAppImageRepo(input = {}, giteaConfig = {}) {
    const explicitCandidates = [
        input.imageRepo,
        input.metadata?.desiredDeploy?.imageRepo,
        input.metadata?.lastSuccessfulBuild?.imageRepo,
    ];
    for (const candidate of explicitCandidates) {
        const explicit = normalizeImageRepo(candidate);
        if (isUsableImageRepo(explicit)) {
            return explicit;
        }
    }

    const repoOwner = normalizeText(input.repoOwner || giteaConfig.org);
    const repoName = normalizeText(input.repoName || input.slug);
    const registryHost = resolveManagedAppRegistryHost(giteaConfig, input);
    if (!registryHost || !repoOwner || !repoName) {
        return '';
    }

    const derived = normalizeImageRepo(`${registryHost}/${repoOwner}/${repoName}`);
    return isUsableImageRepo(derived) ? derived : '';
}

function buildManagedAppImageReference(imageRepo = '', imageTag = '') {
    const normalizedRepo = normalizeImageRepo(imageRepo);
    const normalizedTag = normalizeText(imageTag);
    const digest = normalizeOciSha256Digest(normalizedTag);
    if (!normalizedRepo || !normalizedTag) {
        return '';
    }

    return digest
        ? `${normalizedRepo}@${digest}`
        : `${normalizedRepo}:${normalizedTag}`;
}

function buildManagedAppDeployBuildStateError(buildRun = null) {
    const status = normalizeBuildStatus(buildRun?.buildStatus);
    let message = 'Managed app deployment requires a successful image build before deployment can continue.';
    if (isPendingBuildStatus(status)) {
        message = 'Managed app deployment requires a successful image build. The latest build is still running or queued; wait for the remote GitLab pipeline to finish before deploying.';
    } else if (isFailedBuildStatus(status)) {
        message = 'Managed app deployment requires a successful image build. The latest build failed, so deployment will not continue until a new image build succeeds with canonical digest evidence.';
    }

    const error = new Error(message);
    error.statusCode = 409;
    error.buildStatus = status || 'unknown';
    return error;
}

function hasPersistedAppId(app = null) {
    return Boolean(normalizeText(app?.id));
}

function parseManagedAppRepoReference(value = '') {
    const normalized = normalizeText(value);
    if (!normalized || !normalized.includes('/')) {
        return null;
    }

    const [repoOwner, repoName, ...rest] = normalized.split('/').map((entry) => normalizeText(entry));
    if (rest.length > 0 || !repoOwner || !repoName) {
        return null;
    }

    return {
        repoOwner,
        repoName,
    };
}

function normalizeDeployTarget(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    if (['runner', 'remote-runner', 'remote_runner', 'agent-runner', 'agent_runner'].includes(normalized)) {
        return 'runner';
    }
    if (['ssh', 'remote', 'remote-ssh', 'remote_ssh'].includes(normalized)) {
        return 'ssh';
    }
    if (['in-cluster', 'in_cluster', 'cluster', 'local-cluster', 'local_cluster'].includes(normalized)) {
        return 'ssh';
    }
    return '';
}

function normalizeNamespacePrefix(value = 'app-') {
    const stem = baseSlugify(String(value || '').replace(/-+$/g, ''));
    return stem ? `${stem}-` : 'app-';
}

function normalizeManagedAppNamespace(value = '', { slug = '', namespacePrefix = 'app-' } = {}) {
    const prefix = normalizeNamespacePrefix(namespacePrefix);
    const normalizedValue = slugify(value || '', {
        maxLength: MAX_KUBERNETES_NAME_LENGTH,
    });
    if (normalizedValue && normalizedValue.startsWith(prefix)) {
        return normalizedValue;
    }

    const normalizedSlug = slugify(slug || '', {
        maxLength: Math.max(1, MAX_KUBERNETES_NAME_LENGTH - prefix.length),
    });
    const shouldUseSlug = normalizedSlug && (
        !normalizedValue
        || normalizedValue === 'managed-app'
        || normalizedValue === 'managed-apps'
        || normalizedValue === 'default'
    );
    const base = shouldUseSlug
        ? normalizedSlug
        : (normalizedValue || normalizedSlug || 'managed-app');
    return slugify(`${prefix}${base}`, {
        maxLength: MAX_KUBERNETES_NAME_LENGTH,
    });
}

function getDeploymentStatus(report = {}, name = '') {
    const deployment = report?.deployments?.[name];
    if (deployment && typeof deployment === 'object') {
        return deployment;
    }

    return {
        name,
        present: false,
        desiredReplicas: 0,
        readyReplicas: 0,
        availableReplicas: 0,
        updatedReplicas: 0,
        ready: false,
    };
}

function isDeploymentReady(deployment = {}) {
    return Boolean(
        deployment.present
        && Number(deployment.readyReplicas || 0) >= Math.max(1, Number(deployment.desiredReplicas || 0)),
    );
}

function formatDeploymentSummary(deployment = {}, fallbackName = '') {
    const name = normalizeText(deployment.name || fallbackName || 'deployment');
    if (!deployment.present) {
        return `${name} missing`;
    }

    return `${name} ${Number(deployment.readyReplicas || 0)}/${Number(deployment.desiredReplicas || 0)} ready`;
}

function buildPlatformDoctorSuggestions(report = {}) {
    const suggestions = [];
    const platformNamespace = normalizeText(report.platformNamespace || 'agent-platform');
    const gitlab = getDeploymentStatus(report, 'gitlab');
    const buildkitd = getDeploymentStatus(report, 'buildkitd');
    const gitlabRunner = getDeploymentStatus(report, 'gitlab-runner');
    const runnerTokenState = normalizeText(report.runnerTokenState || 'unknown').toLowerCase();
    const runnerLabels = normalizeText(report.runnerLabels);
    const runnerLogText = (Array.isArray(report.runnerLogExcerpt) ? report.runnerLogExcerpt : []).join('\n').toLowerCase();

    if (!report.namespaceExists) {
        suggestions.push(`Remote platform namespace \`${platformNamespace}\` is missing on the SSH target. Apply the agent-platform manifest there or correct the managed-app platform namespace setting.`);
        return suggestions;
    }

    if (!isDeploymentReady(gitlab)) {
        suggestions.push(`GitLab is not ready in \`${platformNamespace}\` (${formatDeploymentSummary(gitlab, 'gitlab')}).`);
    }

    if (!isDeploymentReady(buildkitd)) {
        suggestions.push(`BuildKit is not ready in \`${platformNamespace}\` (${formatDeploymentSummary(buildkitd, 'buildkitd')}).`);
    }

    if (!gitlabRunner.present) {
        suggestions.push(`The \`gitlab-runner\` deployment is missing from \`${platformNamespace}\`. The remote GitLab runner stack is incomplete, so pipelines will stay pending.`);
    } else if (Number(gitlabRunner.desiredReplicas || 0) === 0) {
        suggestions.push('`gitlab-runner` is scaled to `0`. Set `GITLAB_RUNNER_TOKEN`, then scale `gitlab-runner` to `1`.');
    } else if (!isDeploymentReady(gitlabRunner)) {
        suggestions.push(`\`gitlab-runner\` exists but is not ready (${formatDeploymentSummary(gitlabRunner, 'gitlab-runner')}). Check the runner pod logs on the remote cluster.`);
    }

    if (runnerTokenState === 'missing-secret') {
        suggestions.push(`Secret \`gitlab-runner\` is missing from \`${platformNamespace}\`. The runner cannot register without \`runner-token\`.`);
    } else if (runnerTokenState === 'missing') {
        suggestions.push('Secret `gitlab-runner` exists, but `runner-token` is empty or unreadable.');
    } else if (runnerTokenState === 'placeholder') {
        suggestions.push('`runner-token` still has a placeholder value. Replace it with a real GitLab runner authentication token.');
    }

    if (gitlabRunner.present && isDeploymentReady(gitlabRunner) && runnerLabels) {
        suggestions.push(`If pipelines are still pending, confirm the runner is attached in GitLab and advertises the tags \`${runnerLabels}\`.`);
    }

    if (/\bunauthorized\b|\bforbidden\b|\binvalid\b|\btoken\b/.test(runnerLogText)) {
        suggestions.push('The runner log excerpt points at a registration or token problem. Reissue the GitLab runner token and update `gitlab-runner`.');
    }

    if (runnerLabels && !/\bkimibuilt\b/i.test(runnerLabels)) {
        suggestions.push(`The runner tags are currently \`${runnerLabels}\`. The managed-app pipeline expects a \`kimibuilt\` compatible runner tag.`);
    }

    return Array.from(new Set(suggestions.filter(Boolean)));
}

function buildPlatformDoctorMessage(report = {}, healthy = false) {
    const host = normalizeText(report.executionHost || 'remote ssh target');
    const platformNamespace = normalizeText(report.platformNamespace || 'agent-platform');
    const gitlab = getDeploymentStatus(report, 'gitlab');
    const buildkitd = getDeploymentStatus(report, 'buildkitd');
    const gitlabRunner = getDeploymentStatus(report, 'gitlab-runner');
    const runnerTokenState = normalizeText(report.runnerTokenState || 'unknown');
    const labels = normalizeText(report.runnerLabels);

    return [
        `Managed app platform on ${host}:`,
        `namespace ${platformNamespace} ${report.namespaceExists ? 'present' : 'missing'}`,
        formatDeploymentSummary(gitlab, 'gitlab'),
        formatDeploymentSummary(buildkitd, 'buildkitd'),
        formatDeploymentSummary(gitlabRunner, 'gitlab-runner'),
        `runner token ${runnerTokenState || 'unknown'}`,
        labels ? `runner labels ${labels}` : '',
        healthy ? 'platform healthy' : 'platform needs attention',
    ].filter(Boolean).join('; ');
}

function isPlatformHealthy(report = {}) {
    return Boolean(
        report.namespaceExists
        && isDeploymentReady(getDeploymentStatus(report, 'gitlab'))
        && isDeploymentReady(getDeploymentStatus(report, 'buildkitd'))
        && isDeploymentReady(getDeploymentStatus(report, 'gitlab-runner'))
        && normalizeText(report.runnerTokenState).toLowerCase() === 'present',
    );
}

function normalizeRunnerRecords(payload = {}) {
    const runners = Array.isArray(payload?.runners) ? payload.runners : [];
    return runners.map((runner) => ({
        id: runner?.id,
        name: normalizeText(runner?.name),
        status: normalizeText(runner?.status).toLowerCase(),
        disabled: runner?.disabled === true,
        busy: runner?.busy === true,
        labels: (Array.isArray(runner?.labels) ? runner.labels : [])
            .map((label) => normalizeText(label?.name || label))
            .filter(Boolean),
    }));
}

function buildLifecycleMessageKey(app = null, buildRun = null, phase = '') {
    const appId = normalizeText(app?.id || app?.slug || 'managed-app');
    const buildRunId = normalizeText(buildRun?.id);
    const normalizedPhase = normalizeText(phase).toLowerCase();

    if (['created', 'updated'].includes(normalizedPhase)) {
        return `managed-app:${appId}:provisioning`;
    }

    return `managed-app:${appId}:${buildRunId || 'lifecycle'}`;
}

function getManagedAppDeployDiagnostics(app = null, deployment = null) {
    const deployResult = deployment && typeof deployment === 'object'
        ? deployment
        : (app?.metadata?.liveDeploy?.lastDeployResult || null);
    const diagnostics = deployResult?.diagnostics && typeof deployResult.diagnostics === 'object'
        ? deployResult.diagnostics
        : {};
    const verification = deployResult?.verification && typeof deployResult.verification === 'object'
        ? deployResult.verification
        : {};
    const https = deployResult?.https && typeof deployResult.https === 'object'
        ? deployResult.https
        : {};
    const expectedHost = normalizeText(
        diagnostics.expectedHost
        || app?.publicHost
        || app?.metadata?.desiredDeploy?.publicHost,
    );
    const expectedService = normalizeText(diagnostics.expectedService || app?.slug);
    const expectedServicePort = Number(diagnostics.expectedServicePort || 80) || 80;
    const expectedContainerPort = Number(
        diagnostics.expectedContainerPort
        || app?.metadata?.desiredDeploy?.containerPort
        || app?.metadata?.requestedContainerPort
        || 80
    ) || 80;
    const httpsStatusCode = Number(https.status || diagnostics.httpsStatus || 0) || 0;
    const httpsError = normalizeText(https.error || diagnostics.httpsError);
    const httpsLocation = normalizeText(https.location || diagnostics.httpsLocation);
    const certificateName = normalizeText(diagnostics.certificateName);
    const certificateMessage = normalizeText(diagnostics.certificateMessage);
    const challengeSummary = normalizeStringArray(diagnostics.challengeSummary, 4);
    const ingressEvents = normalizeStringArray(diagnostics.ingressEvents, 4);
    const traefikLogExcerpt = normalizeStringArray(diagnostics.traefikLogExcerpt, 4);
    const appProbeAttempted = diagnostics?.appProbe?.attempted === true;
    const appProbeOk = diagnostics?.appProbe?.ok === true;
    const appProbeStatus = Number(diagnostics?.appProbe?.status || 0) || 0;
    const appProbeError = normalizeText(diagnostics?.appProbe?.error);
    const appProbeBody = normalizeText(diagnostics?.appProbe?.bodyPreview);
    const podStatus = diagnostics?.podStatus && typeof diagnostics.podStatus === 'object'
        ? diagnostics.podStatus
        : {};
    const podName = normalizeText(podStatus.name);
    const podPhase = normalizeText(podStatus.phase);
    const podWaitingReason = normalizeText(podStatus.waitingReason);
    const podWaitingMessage = normalizeText(podStatus.waitingMessage);
    const podTerminatedReason = normalizeText(podStatus.terminatedReason);
    const podTerminatedMessage = normalizeText(podStatus.terminatedMessage);
    const rolloutError = normalizeText(deployResult?.rollout?.error);
    const imageDigest = normalizeOciSha256Digest(
        deployResult?.observedImageDigest
        || diagnostics.observedImageDigest
        || diagnostics.imageDigest
        || diagnostics.imageEvidence?.observedDigest
        || podStatus.imageID,
    );
    const imageDigestError = normalizeText(
        diagnostics.imageDigestError
        || diagnostics.imageEvidence?.error
        || deployResult?.imageEvidence?.error,
    );
    const publicHttpsVerified = verification.publicHttps === true || https.ok === true;

    let ingressIssue = '';
    if (deployResult) {
        if (diagnostics.deploymentPresent === false) {
            ingressIssue = 'Deployment was not found in the target namespace after rollout.';
        } else if (diagnostics.servicePresent === false) {
            ingressIssue = 'Service was not found in the target namespace after rollout.';
        } else if (diagnostics.ingressPresent === false) {
            ingressIssue = 'Ingress was not found in the target namespace after rollout.';
        } else if (diagnostics.ingressHostMatches === false) {
            ingressIssue = `Ingress host is ${normalizeText(diagnostics.ingressHost) || 'missing'}, expected ${expectedHost || 'the public host'}.`;
        } else if (diagnostics.ingressBackendMatches === false) {
            const actualService = normalizeText(diagnostics.ingressBackendService) || 'missing';
            const actualPort = Number(diagnostics.ingressBackendPort || 0) || 0;
            ingressIssue = `Ingress routes to ${actualService}:${actualPort || '?'}, expected ${expectedService || 'service'}:${expectedServicePort}.`;
        } else if (diagnostics.serviceTargetMatches === false) {
            const actualTarget = Number(diagnostics.serviceTargetPort || 0) || 0;
            ingressIssue = `Service target port is ${actualTarget || 'missing'}, expected container port ${expectedContainerPort}.`;
        } else if (diagnostics.traefikReady === false) {
            ingressIssue = 'Traefik is not ready on the remote cluster.';
        }
    }

    const ingressStatus = !deployResult
        ? ''
        : (verification.ingress === true
            ? `Ingress is routing ${expectedHost || 'the public host'} to ${expectedService || 'the managed app service'}:${expectedServicePort}.`
            : (ingressIssue
                || 'Ingress routing has not been verified successfully yet.'));

    let tlsIssue = '';
    if (deployResult && verification.tls !== true) {
        if (diagnostics.tlsSecretPresent === false) {
            const certificateHint = certificateMessage || challengeSummary[0] || ingressEvents[0] || '';
            tlsIssue = `TLS secret ${normalizeText(deployResult?.tlsSecretName) || 'for this host'} has not been issued yet${certificateHint ? `: ${certificateHint}` : '.'}`;
        } else if (diagnostics.certificateReady === false) {
            tlsIssue = `Certificate ${certificateName || 'for this host'} is not ready${certificateMessage ? `: ${certificateMessage}` : '.'}`;
        } else if (diagnostics.certificateReadyValue === 'unknown') {
            tlsIssue = 'Certificate readiness is still unknown.';
        }
    }

    const tlsStatus = !deployResult
        ? ''
        : (verification.tls === true
            ? `TLS is ready${certificateName ? ` with certificate ${certificateName}` : ''}.`
            : (tlsIssue || 'TLS verification has not succeeded yet.'));

    let httpsIssue = '';
    if (deployResult && verification.https !== true) {
        if (httpsStatusCode === 404) {
            if (appProbeAttempted && appProbeOk) {
                httpsIssue = 'Public HTTPS returned 404 while the internal service probe succeeded.';
            } else if (appProbeAttempted && appProbeStatus === 404) {
                httpsIssue = 'Public HTTPS returned 404 and the internal service probe also returned 404.';
            } else {
                httpsIssue = 'Public HTTPS returned 404.';
            }
        } else if (httpsStatusCode > 0) {
            httpsIssue = `Public HTTPS returned ${httpsStatusCode}.`;
        } else if (httpsError) {
            httpsIssue = `Public HTTPS probe failed: ${httpsError}`;
        } else {
            httpsIssue = 'Public HTTPS is not responding successfully yet.';
        }
    }

    const httpsStatus = !deployResult
        ? ''
        : (publicHttpsVerified || verification.https === true
            ? `HTTPS returned ${httpsStatusCode || 200}${httpsLocation ? ` and redirected to ${httpsLocation}` : ''}.`
            : httpsIssue);

    const imageDigestStatus = !deployResult
        ? ''
        : (verification.imageDigest === true && imageDigest
            ? `Kubernetes observed runtime image digest ${imageDigest}.`
            : (imageDigestError || 'Kubernetes did not prove an OCI sha256 digest from the running pod imageID.'));

    const appProbeStatusSummary = !deployResult || appProbeAttempted !== true
        ? ''
        : (appProbeOk
            ? `Internal service probe returned ${appProbeStatus || 200}.`
            : (appProbeStatus > 0
                ? `Internal service probe returned ${appProbeStatus}.`
                : (appProbeError
                    ? `Internal service probe failed: ${appProbeError}`
                    : (appProbeBody ? `Internal service probe response: ${appProbeBody}` : 'Internal service probe did not confirm a healthy response.'))));

    let failureCategory = '';
    let failureReason = '';
    if (rolloutError || verification.rollout === false) {
        if (/\bErrImagePull\b|\bImagePullBackOff\b/i.test(podWaitingReason)
            || /\bunauthorized\b|\b401\b|\boauth token\b/i.test(podWaitingMessage)) {
            failureCategory = 'image_pull';
            failureReason = `Pod ${podName || 'for this deployment'} cannot pull the image${podWaitingReason ? ` (${podWaitingReason})` : ''}${podWaitingMessage ? `: ${podWaitingMessage}` : '.'}`;
        } else if (podTerminatedReason || podTerminatedMessage) {
            failureCategory = 'rollout';
            failureReason = `Deployment rollout failed${podName ? ` on pod ${podName}` : ''}${podTerminatedReason ? ` (${podTerminatedReason})` : ''}${podTerminatedMessage ? `: ${podTerminatedMessage}` : '.'}`;
        } else {
            failureCategory = 'rollout';
            failureReason = rolloutError || `Deployment rollout failed on the remote cluster${podPhase ? ` while pod phase was ${podPhase}` : '.'}`;
        }
    } else if (verification.imageDigest !== true || !imageDigest) {
        failureCategory = 'image_digest';
        failureReason = imageDigestStatus;
    } else if (ingressIssue) {
        failureCategory = 'ingress';
        failureReason = ingressIssue;
    } else if (tlsIssue) {
        failureCategory = 'tls';
        failureReason = tlsIssue;
    } else if (httpsIssue) {
        failureCategory = httpsStatusCode === 404 && appProbeOk
            ? 'ingress'
            : (httpsStatusCode === 404 && appProbeAttempted && appProbeStatus === 404
                ? 'app'
                : 'https');
        failureReason = httpsIssue;
    }

    const shouldFailClosed = ['rollout', 'image_pull', 'image_digest', 'ingress', 'tls', 'https', 'app'].includes(failureCategory)
        && (httpsStatusCode > 0 || ['rollout', 'image_pull', 'image_digest', 'ingress', 'tls', 'app'].includes(failureCategory));
    const nextStep = (() => {
        switch (failureCategory) {
            case 'rollout':
                return 'Inspect the remote rollout error, fix the cluster state, and redeploy the managed app.';
            case 'image_pull':
                return 'Inspect the registry pull secret and GitLab registry credentials on the remote cluster, then redeploy once the image can be pulled.';
            case 'image_digest':
                return 'Inspect the Deployment image, pod image, and runtime imageID, then redeploy until Kubernetes proves the expected OCI sha256 digest.';
            case 'ingress':
                if (httpsStatusCode === 404 && appProbeOk) {
                    return 'Inspect Traefik ingress routing for this host because the service is reachable but the public endpoint returns 404.';
                }
                return 'Inspect the managed-app Ingress and Service wiring on the remote cluster, then redeploy.';
            case 'tls':
                return 'Inspect cert-manager certificate issuance for this host and wait for or repair the TLS secret before retrying verification.';
            case 'app':
                return 'Inspect the application root route or published static content because both the public endpoint and the internal service probe returned 404.';
            case 'https':
                return 'Inspect public DNS and ingress reachability until HTTPS returns a success or redirect.';
            default:
                return '';
        }
    })();

    return {
        expectedHost,
        ingressStatus,
        tlsStatus,
        httpsStatus,
        imageDigest,
        imageDigestStatus,
        appProbeStatus: appProbeStatusSummary,
        failureCategory,
        failureReason,
        shouldFailClosed,
        nextStep,
        openItems: normalizeStringArray([
            failureReason,
            ingressStatus && verification.ingress !== true ? ingressStatus : '',
            tlsStatus && verification.tls !== true ? tlsStatus : '',
            httpsStatus && verification.https !== true ? httpsStatus : '',
            imageDigestStatus && verification.imageDigest !== true ? imageDigestStatus : '',
            appProbeStatusSummary && !appProbeOk ? appProbeStatusSummary : '',
            challengeSummary[0] || '',
            ingressEvents[0] || '',
            traefikLogExcerpt[0] || '',
        ], 4),
    };
}

function buildManagedAppStatusSummary(app = null, buildRun = null, phase = '', deployment = null) {
    const appName = normalizeText(app?.appName || app?.slug || 'Managed app');
    const publicUrl = normalizeText(app?.publicHost) ? `https://${normalizeText(app.publicHost)}` : '';
    const repoRef = normalizeText(app?.repoOwner) && normalizeText(app?.repoName)
        ? `${normalizeText(app.repoOwner)}/${normalizeText(app.repoName)}`
        : '';
    const pipelineObserved = Boolean(
        normalizeText(buildRun?.externalRunUrl)
        || normalizeText(buildRun?.externalRunId)
        || buildRun?.metadata?.gitlabPipeline,
    );
    const commitSha = normalizeText(buildRun?.commitSha || app?.metadata?.repoState?.lastCommitSha);
    const sourceStatus = commitSha
        ? `Source changes were committed${repoRef ? ` in ${repoRef}` : ''}.`
        : `${appName} ${normalizeText(phase).toLowerCase() === 'created' ? 'was created' : 'was updated'}${repoRef ? ` in ${repoRef}` : ''}.`;
    const queuedStatus = buildRun
        ? (pipelineObserved
            ? `GitLab pipeline is queued or running${buildRun.externalRunUrl ? `: ${buildRun.externalRunUrl}` : ''}.`
            : 'GitLab pipeline has not been observed yet.')
        : 'No build run has been recorded yet.';
    const imageRef = normalizeText(app?.metadata?.liveDeploy?.lastImage || app?.metadata?.lastImage || deployment?.image || '');
    const buildError = normalizeText(
        buildRun?.error?.message
        || buildRun?.metadata?.payload?.error
        || buildRun?.metadata?.payload?.message
        || app?.metadata?.liveDeploy?.lastError
        || deployment?.rollout?.error
        || deployment?.https?.error,
    );
    const deployDiagnostics = getManagedAppDeployDiagnostics(app, deployment);
    const failureReason = normalizeText(deployDiagnostics.failureReason || buildError);

    switch (normalizeText(phase).toLowerCase()) {
        case 'created':
        case 'updated':
            return `${sourceStatus} ${queuedStatus}`;
        case 'built':
            return `${appName} finished building${imageRef ? ` as \`${imageRef}\`` : ''}.`;
        case 'build_failed':
            return `${appName} build failed${buildError ? `: ${buildError}` : '.'}`;
        case 'deploying':
            return `${appName} is deploying${publicUrl ? ` to ${publicUrl}` : ''}. Waiting for rollout, ingress, TLS, and HTTPS verification.`;
        case 'live':
            return `${appName} is live${publicUrl ? ` at ${publicUrl}` : ''}. HTTPS is responding.`;
        case 'tls_ready':
            return `${appName} is deployed${publicUrl ? ` at ${publicUrl}` : ''}. ${deployDiagnostics.httpsStatus || 'TLS is ready; waiting for public HTTPS to respond.'}`;
        case 'pending_https':
            return `${appName} rollout succeeded${publicUrl ? ` at ${publicUrl}` : ''}, but verification is still incomplete${failureReason ? `: ${failureReason}` : '.'}`;
        case 'deploy_failed':
            return `${appName} deployment failed${failureReason ? `: ${failureReason}` : '.'}`;
        case 'deployed':
            return `${appName} was deployed${publicUrl ? ` to ${publicUrl}` : ''}.`;
        default:
            return `${appName} status changed to ${normalizeText(phase) || 'updated'}.`;
    }
}

function buildManagedAppPhaseLabel(phase = '') {
    switch (normalizeText(phase).toLowerCase()) {
        case 'created':
        case 'updated':
            return 'Build queued';
        case 'built':
            return 'Build complete';
        case 'deploying':
            return 'Deploying';
        case 'tls_ready':
        case 'pending_https':
            return 'Verifying public HTTPS';
        case 'live':
            return 'Live';
        case 'build_failed':
            return 'Build failed';
        case 'deploy_failed':
            return 'Deploy failed';
        default:
            return 'Updated';
    }
}

function normalizeIterationStepStatus(value = '') {
    const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');
    if (['completed', 'done', 'success', 'succeeded'].includes(normalized)) {
        return 'completed';
    }
    if (['in_progress', 'running', 'queued', 'pending'].includes(normalized)) {
        return normalized === 'pending' ? 'pending' : 'in_progress';
    }
    if (['failed', 'failure', 'error'].includes(normalized)) {
        return 'failed';
    }
    if (normalized === 'skipped') {
        return 'skipped';
    }
    return 'pending';
}

function normalizeIterationExecutor(input = {}) {
    const explicit = normalizeText(
        input.executor
        || input.executionMode
        || input.iterationExecutor
        || input.agentExecutor,
    ).toLowerCase();
    if (['remote-cli-agent', 'remote_cli_agent', 'backend-cli-agent', 'backend_cli_agent', 'remote-cli', 'backend-cli'].includes(explicit)) {
        return 'remote-cli-agent';
    }
    if (input.useRemoteCliAgent === true || input.backendCliAgent === true || input.remoteCliAgent === true) {
        return 'remote-cli-agent';
    }
    return 'managed-app-backend';
}

function extractRemoteCliChangedPaths(finalOutput = '') {
    const lines = String(finalOutput || '').split(/\r?\n/);
    const values = [];
    for (const line of lines) {
        const match = line.match(/^\s*(?:[-*]\s*)?(?:CHANGED_FILES|CHANGED_FILE|COMMITTED_PATHS|COMMITTED_PATH)\s*[:=]\s*(.+?)\s*$/i);
        if (match?.[1]) {
            values.push(...String(match[1]).split(','));
        }
    }
    return normalizeStringArray(values.map((value) => value.replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')), 20);
}

function buildManagedAppIterationEvidence(app = null, buildRun = null, details = {}) {
    const normalizedApp = app && typeof app === 'object' ? app : {};
    const run = buildRun && typeof buildRun === 'object' ? buildRun : {};
    const metadata = run.metadata && typeof run.metadata === 'object' ? run.metadata : {};
    const iteration = metadata.iteration && typeof metadata.iteration === 'object' ? metadata.iteration : {};
    const committedPaths = normalizeStringArray(
        details.committedPaths
        || iteration.committedPaths
        || metadata.committedPaths,
        20,
    );
    const commitSha = normalizeText(
        details.commitSha
        || iteration.commitSha
        || run.commitSha
        || normalizedApp.metadata?.repoState?.lastCommitSha,
    );
    const pipelineUrl = normalizeText(
        details.pipelineUrl
        || iteration.pipelineUrl
        || run.externalRunUrl
        || metadata.gitlabPipeline?.htmlUrl
        || metadata.gitlabPipeline?.runUrl,
    );
    const imageTag = normalizeText(
        details.imageTag
        || iteration.imageTag
        || run.imageTag
        || buildImageTagFromCommit(commitSha),
    );
    const publicHost = normalizeText(normalizedApp.publicHost);
    const liveDeploy = normalizedApp.metadata?.liveDeploy && typeof normalizedApp.metadata.liveDeploy === 'object'
        ? normalizedApp.metadata.liveDeploy
        : {};
    const deployment = details.deployment && typeof details.deployment === 'object'
        ? details.deployment
        : (metadata.deployment && typeof metadata.deployment === 'object'
            ? metadata.deployment
            : (liveDeploy.lastDeployResult && typeof liveDeploy.lastDeployResult === 'object'
                ? liveDeploy.lastDeployResult
                : {}));
    const imageEvidence = deployment.imageEvidence && typeof deployment.imageEvidence === 'object'
        ? deployment.imageEvidence
        : {};
    const imageDigest = normalizeOciSha256Digest(
        details.imageDigest
        || run.imageDigest
        || liveDeploy.buildImageDigest
        || imageEvidence.buildDigest,
    );
    const requestedImage = normalizeText(
        details.requestedImage
        || liveDeploy.requestedImage
        || liveDeploy.lastImage
        || deployment.requestedImage
        || imageEvidence.requestedImage,
    );
    const observedDeploymentImage = normalizeText(
        liveDeploy.observedDeploymentImage
        || deployment.deploymentImage
        || imageEvidence.observedDeploymentImage
        || imageEvidence.deploymentImage,
    );
    const observedPodImage = normalizeText(
        liveDeploy.observedPodImage
        || deployment.podImage
        || imageEvidence.observedPodImage
        || imageEvidence.podImage,
    );
    const observedImageID = normalizeText(
        liveDeploy.observedImageID
        || deployment.podImageID
        || imageEvidence.observedImageID
        || imageEvidence.podImageID,
    );
    const observedImageDigest = normalizeOciSha256Digest(
        details.observedImageDigest
        || liveDeploy.observedImageDigest
        || deployment.observedImageDigest
        || deployment.diagnostics?.observedImageDigest
        || deployment.diagnostics?.imageDigest
        || imageEvidence.observedImageDigest
        || imageEvidence.observedDigest,
    );
    const remoteCli = details.remoteCli && typeof details.remoteCli === 'object'
        ? details.remoteCli
        : (iteration.remoteCli && typeof iteration.remoteCli === 'object' ? iteration.remoteCli : {});
    const phase = normalizeText(details.phase || iteration.phase || normalizedApp.status).toLowerCase();
    const publicVerificationObserved = hasManagedAppPublicVerification(normalizedApp, run, phase, details);
    const targetPublicUrl = buildHttpsUrlFromHost(publicHost);
    const livePublicUrl = publicVerificationObserved ? targetPublicUrl : '';

    return {
        repository: normalizeText(normalizedApp.repoOwner) && normalizeText(normalizedApp.repoName)
            ? `${normalizeText(normalizedApp.repoOwner)}/${normalizeText(normalizedApp.repoName)}`
            : '',
        repoUrl: normalizeText(normalizedApp.repoUrl),
        commitSha,
        committedPaths,
        pipelineUrl,
        pipelineStatus: normalizeText(run.buildStatus || metadata.gitlabPipeline?.status),
        imageTag,
        imageDigest,
        requestedImage,
        deployedImage: normalizeText(liveDeploy.deployedImage || deployment.deployedImage || imageEvidence.deployedImage),
        observedDeploymentImage,
        observedPodImage,
        observedImageID,
        observedImageDigest,
        deployStatus: normalizeText(run.deployStatus || liveDeploy.lastStatus),
        verificationStatus: normalizeText(run.verificationStatus || liveDeploy.lastVerificationStatus),
        publicUrl: livePublicUrl,
        targetPublicHost: publicHost,
        targetPublicUrl,
        livePublicHost: livePublicUrl ? publicHost : '',
        livePublicUrl,
        verifiedAt: normalizeText(liveDeploy.lastVerifiedAt || liveDeploy.lastDeployAt),
        remoteCli: {
            sessionId: normalizeText(remoteCli.sessionId || remoteCli.remoteCodeSessionId),
            mcpSessionId: normalizeText(remoteCli.mcpSessionId),
            targetId: normalizeText(remoteCli.targetId),
            cwd: normalizeText(remoteCli.cwd),
            gitRepo: normalizeText(remoteCli.gitRepo),
            deployment: normalizeText(remoteCli.deployment),
            publicHost: normalizeText(remoteCli.publicHost),
            uiCheckReport: normalizeText(remoteCli.uiCheckReport),
            uiScreenshots: normalizeStringArray(remoteCli.uiScreenshots || [], 10),
        },
        requiredProof: {
            sourceChanged: Boolean(commitSha && committedPaths.length > 0),
            gitlabPipelineObserved: Boolean(pipelineUrl || run.externalRunId || metadata.gitlabPipeline),
            imageAvailable: Boolean(imageDigest),
            deploymentObserved: Boolean(run.deployStatus && run.deployStatus !== 'not_requested'),
            publicVerificationObserved,
        },
    };
}

function buildManagedAppIterationStages({ action = 'edit', app = null, buildRun = null, phase = '', details = {} } = {}) {
    const evidence = buildManagedAppIterationEvidence(app, buildRun, {
        ...details,
        phase,
    });
    const normalizedAction = normalizeIterationAction(action) || 'edit';
    const buildStatus = normalizeBuildStatus(buildRun?.buildStatus);
    const deployStatus = normalizeText(buildRun?.deployStatus).toLowerCase();
    const verificationStatus = normalizeText(buildRun?.verificationStatus).toLowerCase();
    const appStatus = normalizeText(app?.status).toLowerCase();
    const committed = Boolean(evidence.commitSha);
    const hasPatch = evidence.committedPaths.length > 0;
    const pipelineObserved = Boolean(evidence.pipelineUrl || buildRun?.externalRunId || buildRun?.metadata?.gitlabPipeline);
    const buildSucceeded = isSuccessfulBuildStatus(buildStatus);
    const buildFailed = isFailedBuildStatus(buildStatus);
    const deployRequested = buildRun?.deployRequested === true || ['deploy', 'verify'].includes(normalizedAction);
    const deploySucceeded = ['success', 'succeeded', 'deployed', 'live'].includes(deployStatus) || ['live', 'deployed'].includes(appStatus);
    const deployFailed = ['failed', 'failure'].includes(deployStatus);
    const verified = verificationStatus === 'success' || appStatus === 'live';
    const verificationFailed = ['failed', 'failure'].includes(verificationStatus);

    const stages = [
        { id: 'understand', title: 'Understand request', status: 'completed' },
        {
            id: 'patch',
            title: 'Patch source',
            status: ['deploy', 'verify'].includes(normalizedAction)
                ? 'skipped'
                : (hasPatch ? 'completed' : (committed ? 'completed' : 'in_progress')),
        },
        {
            id: 'test',
            title: 'Run focused checks',
            status: normalizeIterationStepStatus(details.testStatus || buildRun?.metadata?.iteration?.testStatus || 'skipped'),
        },
        {
            id: 'commit',
            title: 'Commit to GitLab',
            status: committed
                ? 'completed'
                : (['deploy', 'verify'].includes(normalizedAction) ? 'skipped' : 'in_progress'),
        },
        {
            id: 'pipeline',
            title: 'Observe GitLab pipeline',
            status: buildSucceeded || pipelineObserved
                ? (buildFailed ? 'failed' : (buildSucceeded ? 'completed' : 'in_progress'))
                : (committed ? 'in_progress' : 'pending'),
        },
        {
            id: 'deploy',
            title: 'Deploy to k3s',
            status: deploySucceeded
                ? 'completed'
                : (deployFailed ? 'failed' : (deployRequested ? 'in_progress' : 'pending')),
        },
        {
            id: 'verify',
            title: 'Verify public endpoint',
            status: verified
                ? 'completed'
                : (verificationFailed ? 'failed' : (deployRequested || normalizedAction === 'verify' ? 'in_progress' : 'pending')),
        },
    ];

    if (['build_failed'].includes(normalizeText(phase).toLowerCase()) || buildFailed) {
        stages.find((stage) => stage.id === 'pipeline').status = 'failed';
        stages.find((stage) => stage.id === 'deploy').status = 'skipped';
        stages.find((stage) => stage.id === 'verify').status = 'skipped';
    }

    return stages;
}

function buildManagedAppIterationNextActions({ action = 'edit', app = null, buildRun = null } = {}) {
    const normalizedAction = normalizeIterationAction(action) || 'edit';
    const appStatus = normalizeText(app?.status).toLowerCase();
    const buildStatus = normalizeBuildStatus(buildRun?.buildStatus);
    const deployStatus = normalizeText(buildRun?.deployStatus).toLowerCase();
    const verificationStatus = normalizeText(buildRun?.verificationStatus).toLowerCase();
    const actions = [];

    if (!buildRun || ['edit', 'build'].includes(normalizedAction)) {
        actions.push('edit');
    }
    if (isSuccessfulBuildStatus(buildStatus) && !['succeeded', 'success', 'deployed'].includes(deployStatus)) {
        actions.push('deploy');
    }
    if (['succeeded', 'success', 'deployed'].includes(deployStatus) || ['deployed', 'live'].includes(appStatus)) {
        actions.push('verify');
    }
    if (isPendingBuildStatus(buildStatus)) {
        actions.push('verify');
    }
    if (verificationStatus === 'success' || appStatus === 'live') {
        actions.unshift('edit');
    }

    return Array.from(new Set(actions.filter(Boolean)));
}

function buildManagedAppProgressState(app = null, buildRun = null, phase = '', details = {}) {
    const normalizedPhase = normalizeText(phase).toLowerCase()
        || normalizeText(app?.status).toLowerCase()
        || 'updated';
    const summary = normalizeText(
        details.summary
        || buildManagedAppStatusSummary(app, buildRun, normalizedPhase, details.deployment || null),
    ) || 'Managed app status updated.';
    const deployRequested = details.deployRequested !== false;
    const healthy = typeof details.healthy === 'boolean' ? details.healthy : null;
    const deployDiagnostics = getManagedAppDeployDiagnostics(app, details.deployment || null);
    const buildError = normalizeText(
        buildRun?.error?.message
        || buildRun?.metadata?.payload?.error
        || buildRun?.metadata?.payload?.message
        || app?.metadata?.liveDeploy?.lastError
        || deployDiagnostics.failureReason
        || details?.deployment?.rollout?.error
        || details?.deployment?.https?.error
        || '',
    );
    const iterationMetadata = buildRun?.metadata?.iteration && typeof buildRun.metadata.iteration === 'object'
        ? buildRun.metadata.iteration
        : null;
    const pipelineObserved = Boolean(
        normalizeText(buildRun?.externalRunUrl)
        || normalizeText(buildRun?.externalRunId)
        || buildRun?.metadata?.gitlabPipeline,
    );
    const iterationStages = Array.isArray(details.iterationStages)
        ? details.iterationStages
        : (Array.isArray(iterationMetadata?.stages) ? iterationMetadata.stages : []);
    const steps = iterationStages.length > 0
        ? iterationStages.map((stage) => ({
            id: normalizeText(stage?.id),
            title: normalizeText(stage?.title || stage?.label),
            status: normalizeIterationStepStatus(stage?.status),
        })).filter((stage) => stage.id && stage.title)
        : [
        { id: 'prepare', title: 'Prepare app record', status: 'pending' },
        { id: 'build', title: 'Build and publish image', status: 'pending' },
        { id: 'deploy', title: 'Roll out deployment', status: 'pending' },
        { id: 'verify', title: 'Verify public endpoint', status: 'pending' },
    ];
    const mark = (stepId, status) => {
        const step = steps.find((entry) => entry.id === stepId);
        if (step) {
            step.status = status;
        }
    };

    let detail = normalizeText(iterationMetadata?.summary);
    if (iterationStages.length === 0) {
        switch (normalizedPhase) {
        case 'created':
        case 'updated':
            mark('prepare', 'completed');
            mark('build', pipelineObserved ? 'in_progress' : 'pending');
            detail = pipelineObserved
                ? 'Waiting for the remote GitLab build to publish the image.'
                : 'Source changes were committed, but no GitLab pipeline has been observed yet.';
            break;
        case 'built':
            mark('prepare', 'completed');
            mark('build', 'completed');
            mark('deploy', 'pending');
            detail = 'The image is ready. Deployment is the next server-side step.';
            break;
        case 'deploying':
            mark('prepare', 'completed');
            mark('build', 'completed');
            mark('deploy', 'in_progress');
            detail = 'Applying rollout, ingress, and TLS changes on the remote cluster.';
            break;
        case 'tls_ready':
        case 'pending_https':
            mark('prepare', 'completed');
            mark('build', 'completed');
            mark('deploy', 'completed');
            mark('verify', 'in_progress');
            detail = deployDiagnostics.failureReason
                || deployDiagnostics.httpsStatus
                || 'TLS is ready. Waiting for public HTTPS to respond successfully.';
            break;
        case 'live':
            steps.forEach((step) => {
                step.status = 'completed';
            });
            detail = 'Public HTTPS verification succeeded.';
            break;
        case 'build_failed':
            mark('prepare', 'completed');
            mark('build', 'failed');
            detail = buildError || 'The remote build failed before an image was published.';
            break;
        case 'deploy_failed':
            mark('prepare', 'completed');
            mark('build', 'completed');
            mark('deploy', 'failed');
            detail = deployDiagnostics.failureReason || buildError || 'The deployment failed before the public endpoint went live.';
            break;
        default:
            mark('prepare', 'in_progress');
            detail = summary;
            break;
        }
    }

    const terminal = ['live', 'build_failed', 'deploy_failed'].includes(normalizedPhase);
    const completedSteps = steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
    const nextStep = normalizeText(
        details.nextStep
        || deriveNextStepForLifecycle(normalizedPhase, {
            deployRequested,
            healthy,
            diagnostics: deployDiagnostics,
        }),
    );
    const openItems = normalizeStringArray(
        hasOwnInput(details, 'openItems')
            ? details.openItems
            : deriveOpenItemsForLifecycle(normalizedPhase, {
                deployRequested,
                summary,
                error: buildError,
                healthy,
                diagnostics: deployDiagnostics,
            }),
        4,
    );

    return {
        phase: normalizedPhase,
        phaseLabel: buildManagedAppPhaseLabel(normalizedPhase),
        summary,
        detail: normalizeText(details.detail || detail),
        nextStep,
        openItems,
        expectedHost: normalizeText(deployDiagnostics.expectedHost),
        ingressStatus: normalizeText(deployDiagnostics.ingressStatus),
        tlsStatus: normalizeText(deployDiagnostics.tlsStatus),
        httpsStatus: normalizeText(deployDiagnostics.httpsStatus),
        appProbeStatus: normalizeText(deployDiagnostics.appProbeStatus),
        evidence: buildManagedAppIterationEvidence(app, buildRun, {
            ...details,
            phase: normalizedPhase,
        }),
        nextActions: buildManagedAppIterationNextActions({
            action: iterationMetadata?.action || details.action || '',
            app,
            buildRun,
        }),
        live: terminal !== true,
        terminal,
        totalSteps: steps.length,
        completedSteps,
        currentStepId: steps.find((step) => step.status === 'in_progress')?.id || '',
        steps,
    };
}

function buildManagedProjectKey(app = null) {
    const appId = normalizeText(app?.id || app?.slug || 'managed-app');
    return `managed-app:${appId}`;
}

function buildHttpsUrlFromHost(host = '') {
    const normalizedHost = normalizeText(host).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return normalizedHost ? `https://${normalizedHost}` : '';
}

function hasManagedAppPublicVerification(app = null, buildRun = null, phase = '', details = {}) {
    const normalizedPhase = normalizeText(phase).toLowerCase();
    const appStatus = normalizeText(app?.status).toLowerCase();
    const verificationStatus = normalizeText(buildRun?.verificationStatus).toLowerCase();
    const liveDeploy = app?.metadata?.liveDeploy && typeof app.metadata.liveDeploy === 'object'
        ? app.metadata.liveDeploy
        : {};
    const deployment = details?.deployment && typeof details.deployment === 'object'
        ? details.deployment
        : {};

    return ['live', 'success', 'succeeded'].includes(verificationStatus)
        || liveDeploy.https === true
        || deployment?.verification?.https === true;
}

function shouldPromoteManagedProjectTitle(currentTitle = '', previousProjectTitle = '') {
    const normalizedCurrentTitle = normalizeText(currentTitle);
    const normalizedPreviousProjectTitle = normalizeText(previousProjectTitle);

    return !normalizedCurrentTitle
        || /^new chat$/i.test(normalizedCurrentTitle)
        || (normalizedPreviousProjectTitle && normalizedCurrentTitle === normalizedPreviousProjectTitle);
}

function preserveManagedProjectViewportState(project = {}, previousProject = {}) {
    const nextProject = project && typeof project === 'object' && !Array.isArray(project)
        ? { ...project }
        : {};
    const sourceProject = previousProject && typeof previousProject === 'object' && !Array.isArray(previousProject)
        ? previousProject
        : {};

    MANAGED_APP_VIEWPORT_STATE_KEYS.forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(nextProject, key)
            && Object.prototype.hasOwnProperty.call(sourceProject, key)) {
            nextProject[key] = sourceProject[key];
        }
    });
    return nextProject;
}

function buildManagedProjectState(app = null, buildRun = null, phase = '', details = {}) {
    const normalizedApp = app && typeof app === 'object' ? app : {};
    const normalizedPhase = normalizeText(phase).toLowerCase()
        || normalizeText(normalizedApp?.status).toLowerCase()
        || 'updated';
    const metadata = normalizedApp?.metadata && typeof normalizedApp.metadata === 'object'
        ? normalizedApp.metadata
        : {};
    const project = metadata.project && typeof metadata.project === 'object'
        ? metadata.project
        : {};
    const desiredDeploy = metadata.desiredDeploy && typeof metadata.desiredDeploy === 'object'
        ? metadata.desiredDeploy
        : {};
    const liveDeploy = metadata.liveDeploy && typeof metadata.liveDeploy === 'object'
        ? metadata.liveDeploy
        : {};
    const targetPublicHost = normalizeText(normalizedApp.publicHost || desiredDeploy.publicHost);
    const publicVerificationObserved = hasManagedAppPublicVerification(normalizedApp, buildRun, normalizedPhase, details);
    const livePublicHost = publicVerificationObserved ? targetPublicHost : '';
    const targetPublicUrl = buildHttpsUrlFromHost(targetPublicHost);
    const livePublicUrl = buildHttpsUrlFromHost(livePublicHost);
    const title = normalizeText(
        normalizedApp.appName
        || titleizeSlug(normalizedApp.slug)
        || 'Managed App',
    );
    const summary = normalizeText(
        details.summary
        || buildManagedAppStatusSummary(normalizedApp, buildRun, normalizedPhase, details.deployment || null),
    );
    const progress = buildManagedAppProgressState(normalizedApp, buildRun, normalizedPhase, details);

    return {
        type: 'managed-app',
        key: buildManagedProjectKey(normalizedApp),
        title,
        summary,
        progress,
        phase: normalizedPhase,
        status: normalizeText(normalizedApp.status || normalizedPhase).toLowerCase() || normalizedPhase,
        appId: normalizeText(normalizedApp.id),
        appSlug: normalizeText(normalizedApp.slug),
        sessionId: normalizeText(normalizedApp.sessionId),
        ownerId: normalizeText(normalizedApp.ownerId),
        repoOwner: normalizeText(normalizedApp.repoOwner),
        repoName: normalizeText(normalizedApp.repoName),
        repoUrl: normalizeText(normalizedApp.repoUrl || normalizedApp.repoCloneUrl),
        repoCloneUrl: normalizeText(normalizedApp.repoCloneUrl),
        repoSshUrl: normalizeText(normalizedApp.repoSshUrl),
        defaultBranch: normalizeText(normalizedApp.defaultBranch || desiredDeploy.defaultBranch || 'main'),
        namespace: normalizeText(normalizedApp.namespace || desiredDeploy.namespace),
        publicHost: targetPublicHost,
        publicUrl: livePublicUrl,
        targetPublicHost,
        targetPublicUrl,
        livePublicHost,
        livePublicUrl,
        publicVerificationObserved,
        deploymentTarget: normalizeText(metadata.deploymentTarget || desiredDeploy.deploymentTarget || 'ssh') || 'ssh',
        buildRunId: normalizeText(buildRun?.id),
        buildStatus: normalizeText(buildRun?.buildStatus).toLowerCase(),
        deployStatus: normalizeText(buildRun?.deployStatus).toLowerCase(),
        verificationStatus: normalizeText(buildRun?.verificationStatus).toLowerCase(),
        nextStep: normalizeText(project.nextStep || progress.nextStep),
        openItems: normalizeStringArray(project.openItems?.length ? project.openItems : progress.openItems, 8),
        decisions: normalizeStringArray(project.decisions, 8),
        lastUserIntent: normalizeText(project.lastUserIntent || normalizedApp.sourcePrompt),
        lastActivityAt: normalizeText(
            project.lastActivityAt
            || liveDeploy.lastVerifiedAt
            || normalizedApp.updatedAt
            || normalizedApp.createdAt
            || new Date().toISOString(),
        ),
        updatedAt: new Date().toISOString(),
    };
}

function resolveManagedAppLifecyclePhase(app = null, buildRun = null, explicitPhase = '') {
    const preferred = normalizeText(explicitPhase).toLowerCase();
    if (preferred) {
        return preferred;
    }

    const appStatus = normalizeText(app?.status).toLowerCase();
    if (appStatus !== 'building') {
        return appStatus || 'updated';
    }

    if (isSuccessfulBuildStatus(buildRun?.buildStatus)) {
        return 'built';
    }
    if (isFailedBuildStatus(buildRun?.buildStatus)) {
        return 'build_failed';
    }
    return 'updated';
}

function hasOwnInput(input = {}, key = '') {
    return Boolean(input && Object.prototype.hasOwnProperty.call(input, key));
}

function hasAnyOwnInput(input = {}, keys = []) {
    return (Array.isArray(keys) ? keys : []).some((key) => hasOwnInput(input, key));
}

function normalizeStringArray(values = [], limit = 8) {
    const seen = new Set();
    return (Array.isArray(values) ? values : [])
        .map((value) => normalizeText(typeof value === 'string' ? value : value?.summary || value?.value || value?.text || ''))
        .filter((value) => {
            if (!value || seen.has(value.toLowerCase())) {
                return false;
            }
            seen.add(value.toLowerCase());
            return true;
        })
        .slice(0, Math.max(1, Number(limit) || 8));
}

function normalizeComparableName(value = '') {
    return baseSlugify(value || '').replace(/-/g, '');
}

function valuesLooselyMatch(left = '', right = '') {
    const normalizedLeft = normalizeComparableName(left);
    const normalizedRight = normalizeComparableName(right);
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    return normalizedLeft === normalizedRight
        || normalizedLeft.includes(normalizedRight)
        || normalizedRight.includes(normalizedLeft);
}

function mergeMetadataSection(base = {}, updates = {}) {
    return {
        ...(base && typeof base === 'object' ? base : {}),
        ...(updates && typeof updates === 'object' ? updates : {}),
    };
}

function normalizeManagedAppMetadata(metadata = {}, app = {}, options = {}) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const deployConfig = options.deployConfig && typeof options.deployConfig === 'object'
        ? options.deployConfig
        : {};
    const managedAppsConfig = options.managedAppsConfig && typeof options.managedAppsConfig === 'object'
        ? options.managedAppsConfig
        : {};
    const project = source.project && typeof source.project === 'object' ? source.project : {};
    const repoState = source.repoState && typeof source.repoState === 'object' ? source.repoState : {};
    const desiredDeploy = source.desiredDeploy && typeof source.desiredDeploy === 'object' ? source.desiredDeploy : {};
    const liveDeploy = source.liveDeploy && typeof source.liveDeploy === 'object' ? source.liveDeploy : {};
    const liveImageEvidence = liveDeploy.lastDeployResult?.imageEvidence && typeof liveDeploy.lastDeployResult.imageEvidence === 'object'
        ? liveDeploy.lastDeployResult.imageEvidence
        : {};
    const liveBuildImageDigest = normalizeOciSha256Digest(
        liveDeploy.buildImageDigest
        || liveImageEvidence.buildDigest,
    );
    const containerPort = Number(
        desiredDeploy.containerPort
        || source.requestedContainerPort
        || managedAppsConfig.defaultContainerPort
        || 80
    );
    const normalizedContainerPort = Number.isFinite(containerPort) && containerPort > 0 ? containerPort : 80;

    return {
        ...source,
        project: {
            summary: normalizeText(project.summary),
            currentObjective: normalizeText(project.currentObjective || app?.sourcePrompt),
            nextStep: normalizeText(project.nextStep),
            openItems: normalizeStringArray(project.openItems, 8),
            decisions: normalizeStringArray(project.decisions, 8),
            lastUserIntent: normalizeText(project.lastUserIntent || app?.sourcePrompt),
            lastActivityAt: normalizeText(project.lastActivityAt || app?.updatedAt || app?.createdAt),
        },
        repoState: {
            initialized: repoState.initialized === true
                || Boolean(normalizeText(app?.repoUrl || app?.repoCloneUrl || app?.repoSshUrl || ''))
                || normalizeStringArray(repoState.lastSeededPaths || source.lastSeededPaths, 24).length > 0,
            lastSeededPaths: normalizeStringArray(repoState.lastSeededPaths || source.lastSeededPaths, 24),
            lastCommitSha: normalizeText(repoState.lastCommitSha),
            lastCommitAt: normalizeText(repoState.lastCommitAt),
            lastBuildRunId: normalizeText(repoState.lastBuildRunId),
        },
        desiredDeploy: {
            deploymentTarget: normalizeDeployTarget(desiredDeploy.deploymentTarget || managedAppsConfig.deployTarget) || 'ssh',
            namespace: normalizeText(desiredDeploy.namespace || app?.namespace),
            publicHost: normalizeText(desiredDeploy.publicHost || app?.publicHost),
            imageRepo: normalizeText(desiredDeploy.imageRepo || app?.imageRepo),
            defaultBranch: normalizeText(desiredDeploy.defaultBranch || app?.defaultBranch || managedAppsConfig.defaultBranch || 'main'),
            containerPort: normalizedContainerPort,
            ingressClassName: normalizeText(desiredDeploy.ingressClassName || deployConfig.ingressClassName),
            tlsClusterIssuer: normalizeText(desiredDeploy.tlsClusterIssuer || deployConfig.tlsClusterIssuer),
            registryPullSecretName: normalizeText(desiredDeploy.registryPullSecretName || managedAppsConfig.registryPullSecretName),
        },
        liveDeploy: {
            lastImage: normalizeText(liveDeploy.lastImage || source.lastImage),
            requestedImage: normalizeText(liveDeploy.requestedImage || liveDeploy.lastImage || liveImageEvidence.requestedImage || source.lastImage),
            deployedImage: normalizeText(liveDeploy.deployedImage || liveImageEvidence.deployedImage),
            buildImageDigest: liveBuildImageDigest,
            observedDeploymentImage: normalizeText(liveDeploy.observedDeploymentImage || liveImageEvidence.observedDeploymentImage || liveImageEvidence.deploymentImage),
            observedPodImage: normalizeText(liveDeploy.observedPodImage || liveImageEvidence.observedPodImage || liveImageEvidence.podImage),
            observedImageID: normalizeText(liveDeploy.observedImageID || liveImageEvidence.observedImageID || liveImageEvidence.podImageID),
            observedImageDigest: normalizeOciSha256Digest(liveDeploy.observedImageDigest || liveImageEvidence.observedImageDigest || liveImageEvidence.observedDigest),
            imageDigest: liveBuildImageDigest,
            rollout: liveDeploy.rollout === true,
            ingress: liveDeploy.ingress === true,
            tls: liveDeploy.tls === true,
            https: liveDeploy.https === true,
            lastVerifiedAt: normalizeText(liveDeploy.lastVerifiedAt),
            lastError: normalizeText(liveDeploy.lastError),
            lastDeployResult: liveDeploy.lastDeployResult || source.lastDeployResult || null,
        },
        deploymentTarget: normalizeDeployTarget(source.deploymentTarget || desiredDeploy.deploymentTarget || managedAppsConfig.deployTarget) || 'ssh',
        requestedContainerPort: normalizedContainerPort,
        lastSeededPaths: normalizeStringArray(repoState.lastSeededPaths || source.lastSeededPaths, 24),
        lastImage: normalizeText(liveDeploy.lastImage || source.lastImage),
        lastDeployResult: liveDeploy.lastDeployResult || source.lastDeployResult || null,
    };
}

function buildManagedAppMetadata(existingMetadata = {}, app = {}, options = {}) {
    const normalized = normalizeManagedAppMetadata(existingMetadata, app, options);
    const projectPatch = options.project && typeof options.project === 'object' ? options.project : {};
    const repoStatePatch = options.repoState && typeof options.repoState === 'object' ? options.repoState : {};
    const desiredDeployPatch = options.desiredDeploy && typeof options.desiredDeploy === 'object' ? options.desiredDeploy : {};
    const liveDeployPatch = options.liveDeploy && typeof options.liveDeploy === 'object' ? options.liveDeploy : {};

    const merged = {
        ...normalized,
        project: {
            ...normalized.project,
            ...projectPatch,
            openItems: normalizeStringArray(
                hasOwnInput(projectPatch, 'openItems') ? projectPatch.openItems : normalized.project.openItems,
                8,
            ),
            decisions: normalizeStringArray(
                hasOwnInput(projectPatch, 'decisions') ? projectPatch.decisions : normalized.project.decisions,
                8,
            ),
        },
        repoState: {
            ...normalized.repoState,
            ...repoStatePatch,
            initialized: repoStatePatch.initialized === true || normalized.repoState.initialized === true,
            lastSeededPaths: normalizeStringArray(
                hasOwnInput(repoStatePatch, 'lastSeededPaths') ? repoStatePatch.lastSeededPaths : normalized.repoState.lastSeededPaths,
                24,
            ),
        },
        desiredDeploy: {
            ...normalized.desiredDeploy,
            ...desiredDeployPatch,
            deploymentTarget: normalizeDeployTarget(desiredDeployPatch.deploymentTarget || normalized.desiredDeploy.deploymentTarget) || 'ssh',
        },
        liveDeploy: {
            ...normalized.liveDeploy,
            ...liveDeployPatch,
        },
    };

    merged.project.summary = normalizeText(merged.project.summary);
    merged.project.currentObjective = normalizeText(merged.project.currentObjective);
    merged.project.nextStep = normalizeText(merged.project.nextStep);
    merged.project.lastUserIntent = normalizeText(merged.project.lastUserIntent);
    merged.project.lastActivityAt = normalizeText(merged.project.lastActivityAt);
    merged.repoState.lastCommitSha = normalizeText(merged.repoState.lastCommitSha);
    merged.repoState.lastCommitAt = normalizeText(merged.repoState.lastCommitAt);
    merged.repoState.lastBuildRunId = normalizeText(merged.repoState.lastBuildRunId);
    merged.desiredDeploy.namespace = normalizeText(merged.desiredDeploy.namespace);
    merged.desiredDeploy.publicHost = normalizeText(merged.desiredDeploy.publicHost);
    merged.desiredDeploy.imageRepo = normalizeText(merged.desiredDeploy.imageRepo);
    merged.desiredDeploy.defaultBranch = normalizeText(merged.desiredDeploy.defaultBranch || 'main') || 'main';
    merged.desiredDeploy.ingressClassName = normalizeText(merged.desiredDeploy.ingressClassName);
    merged.desiredDeploy.tlsClusterIssuer = normalizeText(merged.desiredDeploy.tlsClusterIssuer);
    merged.desiredDeploy.registryPullSecretName = normalizeText(merged.desiredDeploy.registryPullSecretName);
    merged.liveDeploy.lastImage = normalizeText(merged.liveDeploy.lastImage);
    merged.liveDeploy.requestedImage = normalizeText(merged.liveDeploy.requestedImage || merged.liveDeploy.lastImage);
    merged.liveDeploy.deployedImage = normalizeText(merged.liveDeploy.deployedImage);
    merged.liveDeploy.buildImageDigest = normalizeOciSha256Digest(merged.liveDeploy.buildImageDigest);
    merged.liveDeploy.observedDeploymentImage = normalizeText(merged.liveDeploy.observedDeploymentImage);
    merged.liveDeploy.observedPodImage = normalizeText(merged.liveDeploy.observedPodImage);
    merged.liveDeploy.observedImageID = normalizeText(merged.liveDeploy.observedImageID);
    merged.liveDeploy.observedImageDigest = normalizeOciSha256Digest(merged.liveDeploy.observedImageDigest);
    merged.liveDeploy.imageDigest = merged.liveDeploy.buildImageDigest;
    merged.liveDeploy.lastVerifiedAt = normalizeText(merged.liveDeploy.lastVerifiedAt);
    merged.liveDeploy.lastError = normalizeText(merged.liveDeploy.lastError);

    merged.deploymentTarget = normalizeDeployTarget(merged.desiredDeploy.deploymentTarget || merged.deploymentTarget) || 'ssh';
    merged.requestedContainerPort = Number(merged.desiredDeploy.containerPort || merged.requestedContainerPort || 80) || 80;
    merged.lastSeededPaths = [...merged.repoState.lastSeededPaths];
    merged.lastImage = merged.liveDeploy.lastImage;
    merged.lastDeployResult = merged.liveDeploy.lastDeployResult || null;

    return merged;
}

function deriveNextStepForLifecycle(phase = '', { deployRequested = false, healthy = null, diagnostics = null } = {}) {
    switch (normalizeText(phase).toLowerCase()) {
        case 'created':
        case 'updated':
            return deployRequested
                ? 'Observe the GitLab pipeline for this commit, then continue deployment through the managed-app control plane.'
                : 'Observe the GitLab pipeline for this commit before claiming build progress or deploying the managed app.';
        case 'built':
            return 'Deploy the latest built image when you are ready to publish the changes.';
        case 'build_failed':
            return 'Investigate the failed GitLab pipeline, fix the repository state, and queue another build.';
        case 'deploying':
            return 'Wait for rollout, ingress, TLS, and HTTPS verification to finish on the remote cluster.';
        case 'tls_ready':
        case 'pending_https':
            return normalizeText(diagnostics?.nextStep) || 'Monitor public HTTPS until the ingress responds successfully.';
        case 'deploy_failed':
            return normalizeText(diagnostics?.nextStep) || 'Investigate the remote deployment failure and retry the managed-app deploy once the cluster issue is fixed.';
        case 'live':
            return '';
        case 'doctor':
        case 'reconcile':
            return healthy === true
                ? ''
                : 'Review the managed app platform diagnostics and repair the remote runner or cluster state before queueing more builds.';
        default:
            return '';
    }
}

function deriveOpenItemsForLifecycle(phase = '', {
    deployRequested = false,
    summary = '',
    error = '',
    healthy = null,
    diagnostics = null,
} = {}) {
    const normalizedPhase = normalizeText(phase).toLowerCase();
    if (normalizedPhase === 'build_failed' || normalizedPhase === 'deploy_failed') {
        return normalizeStringArray(diagnostics?.openItems?.length ? diagnostics.openItems : [error || summary], 4);
    }
    if (normalizedPhase === 'tls_ready' || normalizedPhase === 'pending_https') {
        return normalizeStringArray(
            diagnostics?.openItems?.length ? diagnostics.openItems : ['Public HTTPS is not responding yet.'],
            4,
        );
    }
    if (normalizedPhase === 'created' || normalizedPhase === 'updated') {
        return deployRequested
            ? ['GitLab pipeline evidence is not observed yet.', 'Deployment must wait for a successful build webhook or reconciled pipeline.']
            : ['GitLab pipeline evidence is not observed yet.'];
    }
    if ((normalizedPhase === 'doctor' || normalizedPhase === 'reconcile') && healthy === false) {
        return normalizeStringArray([summary], 4);
    }
    return [];
}

class ManagedAppService {
    constructor(options = {}) {
        this.store = options.store || managedAppStore;
        this.giteaClient = options.gitProviderClient
            || options.gitlabClient
            || options.giteaClient
            || new GitLabClient();
        this.gitlabClient = this.giteaClient;
        this.kubernetesClient = options.kubernetesClient || new KubernetesClient();
        this.llmClient = options.llmClient || createManagedAppLlmClient();
        this.sessionStore = options.sessionStore || sessionStore;
        this.remoteCliAgentRunner = options.remoteCliAgentRunner || remoteCliAgentsSdkRunner;
    }

    isAvailable() {
        return this.store.isAvailable();
    }

    getEffectiveGiteaConfig() {
        if (typeof settingsController.getEffectiveGitProviderConfig === 'function') {
            return settingsController.getEffectiveGitProviderConfig();
        }
        if (typeof settingsController.getEffectiveGitLabConfig === 'function') {
            return settingsController.getEffectiveGitLabConfig();
        }
        return typeof settingsController.getEffectiveGiteaConfig === 'function'
            ? settingsController.getEffectiveGiteaConfig()
            : {};
    }

    getEffectiveManagedAppsConfig() {
        return typeof settingsController.getEffectiveManagedAppsConfig === 'function'
            ? settingsController.getEffectiveManagedAppsConfig()
            : {};
    }

    getEffectiveDeployConfig() {
        return typeof settingsController.getEffectiveDeployConfig === 'function'
            ? settingsController.getEffectiveDeployConfig()
            : {};
    }

    async resolveRegistryCredentials(app = null) {
        const giteaConfig = this.getEffectiveGiteaConfig();
        let registryUsername = normalizeText(giteaConfig.registryUsername);
        const registryPassword = normalizeText(giteaConfig.registryPassword || giteaConfig.token);

        if (!registryUsername
            && registryPassword
            && this.giteaClient
            && typeof this.giteaClient.getCurrentUser === 'function'
            && typeof this.giteaClient.isConfigured === 'function'
            && this.giteaClient.isConfigured() === true) {
            try {
                const currentUser = await this.giteaClient.getCurrentUser();
                registryUsername = normalizeText(currentUser?.login || currentUser?.username || currentUser?.name);
            } catch (_error) {
                registryUsername = '';
            }
        }

        return {
            registryHost: resolveManagedAppRegistryHost(giteaConfig, app || {}),
            registryUsername,
            registryPassword,
        };
    }

    recordRemoteServerContext(platform = null, { objective = '' } = {}) {
        if (!platform || typeof platform !== 'object') {
            return;
        }

        const target = clusterStateRegistry.resolveRemoteTarget({
            result: {
                host: normalizeText(platform.executionHost || ''),
            },
        });
        if (!target) {
            return;
        }

        const serverContext = platform.serverContext && typeof platform.serverContext === 'object'
            ? platform.serverContext
            : {};
        const state = clusterStateRegistry.getState();
        clusterStateRegistry.recordTargetContext(state, {
            target,
            objective,
            context: {
                ...serverContext,
                platformNamespaces: [
                    normalizeText(platform.platformNamespace),
                    ...(Array.isArray(serverContext.platformNamespaces) ? serverContext.platformNamespaces : []),
                ].filter(Boolean),
            },
        });
        clusterStateRegistry.saveState();
    }

    resolveDeploymentTarget(input = {}, context = {}, app = null) {
        const explicit = normalizeDeployTarget(input.deployTarget || input.deploymentTarget || input.target);
        if (explicit) {
            return explicit;
        }

        if (normalizeText(context.executionProfile) === 'remote-build') {
            const managedAppsConfig = this.getEffectiveManagedAppsConfig();
            return normalizeDeployTarget(managedAppsConfig.deployTarget) || 'ssh';
        }

        const metadataTarget = normalizeDeployTarget(
            app?.metadata?.desiredDeploy?.deploymentTarget
            || app?.metadata?.deploymentTarget,
        );
        if (metadataTarget) {
            return metadataTarget;
        }

        const managedAppsConfig = this.getEffectiveManagedAppsConfig();
        return normalizeDeployTarget(managedAppsConfig.deployTarget) || 'ssh';
    }

    getPublicApiBaseUrl() {
        return normalizeManagedAppWebhookBaseUrl(settingsController.settings?.api?.baseURL || process.env.API_BASE_URL || '');
    }

    buildBuildEventsUrl() {
        const baseUrl = this.getPublicApiBaseUrl();
        const managedAppsConfig = this.getEffectiveManagedAppsConfig();
        if (!baseUrl) {
            return '';
        }
        const endpointPath = normalizeText(managedAppsConfig.webhookEndpointPath || config.managedApps.webhookEndpointPath || '/api/integrations/gitlab/build-events');
        return `${baseUrl}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;
    }

    normalizeAppRecord(app = null) {
        if (!app || typeof app !== 'object') {
            return app;
        }

        return {
            ...app,
            metadata: normalizeManagedAppMetadata(app.metadata || {}, app, {
                deployConfig: this.getEffectiveDeployConfig(),
                managedAppsConfig: this.getEffectiveManagedAppsConfig(),
            }),
        };
    }

    normalizeAppList(apps = []) {
        return (Array.isArray(apps) ? apps : []).map((app) => this.normalizeAppRecord(app));
    }

    buildAppProjectView(app = null, buildRun = null, details = {}) {
        const normalizedApp = this.normalizeAppRecord(app);
        if (!normalizedApp || typeof normalizedApp !== 'object') {
            return null;
        }

        const phase = resolveManagedAppLifecyclePhase(normalizedApp, buildRun, details.phase);
        const summary = normalizeText(
            details.summary
            || normalizedApp.metadata?.project?.summary
            || buildManagedAppStatusSummary(normalizedApp, buildRun, phase, details.deployment || null),
        );

        return buildManagedProjectState(normalizedApp, buildRun, phase, {
            ...details,
            summary,
            nextStep: normalizeText(details.nextStep || normalizedApp.metadata?.project?.nextStep || ''),
            openItems: hasOwnInput(details, 'openItems')
                ? details.openItems
                : (normalizedApp.metadata?.project?.openItems || []),
        });
    }

    async reconcilePendingBuildForApp(app = null, ownerId = null, latestBuildRun = null) {
        const normalizedApp = this.normalizeAppRecord(app);
        if (!normalizedApp?.id) {
            return {
                app: normalizedApp,
                latestBuildRun,
                handledResult: null,
            };
        }

        const buildRun = latestBuildRun || (this.store?.listBuildRunsForApp
            ? (await this.store.listBuildRunsForApp(normalizedApp.id, ownerId, 1))[0] || null
            : null);
        if (!buildRun || !isPendingBuildStatus(buildRun.buildStatus) || !normalizeText(buildRun.commitSha)) {
            return {
                app: normalizedApp,
                latestBuildRun: buildRun,
                handledResult: null,
            };
        }

        if (!this.giteaClient
            || typeof this.giteaClient.isConfigured !== 'function'
            || this.giteaClient.isConfigured() !== true
            || typeof this.giteaClient.listRepositoryWorkflowRuns !== 'function') {
            return {
                app: normalizedApp,
                latestBuildRun: buildRun,
                handledResult: null,
            };
        }

        const giteaConfig = this.getEffectiveGiteaConfig();
        const repoOwner = normalizeText(normalizedApp.repoOwner || giteaConfig.org);
        const repoName = normalizeText(normalizedApp.repoName || normalizedApp.slug);
        if (!repoOwner || !repoName) {
            return {
                app: normalizedApp,
                latestBuildRun: buildRun,
                handledResult: null,
            };
        }

        let catalog;
        try {
            catalog = await this.giteaClient.listRepositoryWorkflowRuns({
                owner: repoOwner,
                repo: repoName,
                headSha: buildRun.commitSha,
                limit: 10,
            });
        } catch (_error) {
            return {
                app: normalizedApp,
                latestBuildRun: buildRun,
                handledResult: null,
            };
        }

        const workflowRun = selectMostRelevantManagedAppWorkflowRun(catalog?.workflowRuns || [], buildRun);
        if (!workflowRun) {
            return {
                app: normalizedApp,
                latestBuildRun: buildRun,
                handledResult: null,
            };
        }

        const externalRunId = normalizeText(workflowRun.id || workflowRun.run_id);
        const externalRunUrl = buildManagedAppWorkflowRunUrl(workflowRun, {
            repoOwner,
            repoName,
            baseURL: giteaConfig.baseURL,
        });
        const reconciledBuildStatus = normalizeWorkflowRunBuildStatus(workflowRun);
        const reconciledImageDigest = normalizeOciSha256Digest(buildRun.imageDigest);

        if ((isSuccessfulBuildStatus(reconciledBuildStatus) && reconciledImageDigest) || isFailedBuildStatus(reconciledBuildStatus)) {
            const handledResult = await this.handleBuildEvent({
                repoOwner,
                repoName,
                slug: normalizedApp.slug,
                imageRepo: resolveManagedAppImageRepo(normalizedApp, giteaConfig),
                commitSha: buildRun.commitSha,
                imageTag: normalizeText(buildRun.imageTag || buildImageTagFromCommit(buildRun.commitSha)),
                imageDigest: reconciledImageDigest,
                buildStatus: reconciledBuildStatus,
                runId: externalRunId,
                runUrl: externalRunUrl,
                startedAt: workflowRun.run_started_at || workflowRun.started_at || buildRun.startedAt || null,
                finishedAt: workflowRun.completed_at || workflowRun.updated_at || new Date().toISOString(),
                deployRequested: buildRun.deployRequested === true,
                requestedAction: buildRun.requestedAction || (buildRun.deployRequested === true ? 'deploy' : 'build'),
                message: isFailedBuildStatus(reconciledBuildStatus)
                    ? `GitLab pipeline concluded with ${normalizeText(workflowRun.conclusion || workflowRun.status || 'a failure state')}.`
                    : '',
            });

            return {
                app: this.normalizeAppRecord(handledResult?.app || normalizedApp),
                latestBuildRun: handledResult?.buildRun || buildRun,
                handledResult,
            };
        }

        const workflowMetadata = {
            ...(buildRun.metadata || {}),
            gitlabPipeline: {
                id: externalRunId,
                status: normalizeText(workflowRun.status),
                conclusion: normalizeText(workflowRun.conclusion),
                htmlUrl: externalRunUrl,
                awaitingDigestWebhook: isSuccessfulBuildStatus(reconciledBuildStatus) && !reconciledImageDigest,
                updatedAt: normalizeText(
                    workflowRun.updated_at
                    || workflowRun.completed_at
                    || workflowRun.started_at
                    || workflowRun.run_started_at,
                ),
            },
        };
        const persistedBuildStatus = isSuccessfulBuildStatus(reconciledBuildStatus) && !reconciledImageDigest
            ? normalizeBuildStatus(buildRun.buildStatus)
            : reconciledBuildStatus;
        const shouldPersistBuildRun = externalRunId !== normalizeText(buildRun.externalRunId)
            || externalRunUrl !== normalizeText(buildRun.externalRunUrl)
            || normalizeText(buildRun.buildStatus).toLowerCase() !== persistedBuildStatus
            || (isSuccessfulBuildStatus(reconciledBuildStatus)
                && !reconciledImageDigest
                && buildRun.metadata?.gitlabPipeline?.awaitingDigestWebhook !== true);
        const nextBuildRun = shouldPersistBuildRun
            ? await this.store.updateBuildRun(buildRun.id, {
                buildStatus: persistedBuildStatus,
                externalRunId: externalRunId || buildRun.externalRunId,
                externalRunUrl: externalRunUrl || buildRun.externalRunUrl,
                metadata: workflowMetadata,
                startedAt: workflowRun.run_started_at || workflowRun.started_at || buildRun.startedAt,
            })
            : buildRun;

        return {
            app: normalizedApp,
            latestBuildRun: nextBuildRun,
            handledResult: null,
        };
    }

    async getAppProgress(appRef = '', ownerId = null) {
        const app = await this.resolveApp(appRef, ownerId);
        if (!app) {
            return null;
        }

        let normalizedApp = this.normalizeAppRecord(app);
        let latestBuildRun = this.store?.listBuildRunsForApp
            ? (await this.store.listBuildRunsForApp(normalizedApp.id, ownerId, 1))[0] || null
            : null;
        const reconciled = await this.reconcilePendingBuildForApp(normalizedApp, ownerId, latestBuildRun);
        normalizedApp = this.normalizeAppRecord(reconciled.app || normalizedApp);
        latestBuildRun = reconciled.latestBuildRun || latestBuildRun;
        const project = this.buildAppProjectView(normalizedApp, latestBuildRun);

        return {
            app: normalizedApp,
            latestBuildRun,
            project,
            progress: project?.progress || null,
            summary: normalizeText(project?.summary || ''),
        };
    }

    async listOwnerApps(ownerId = null, limit = 50) {
        if (!ownerId || !this.store?.listApps) {
            return [];
        }

        try {
            return this.normalizeAppList(await this.store.listApps(ownerId, limit));
        } catch (_error) {
            return [];
        }
    }

    findAppByPublicHost(apps = [], publicHost = '') {
        const targetHost = normalizeText(publicHost).toLowerCase();
        if (!targetHost) {
            return null;
        }
        return (Array.isArray(apps) ? apps : []).find((app) => normalizeText(app?.publicHost).toLowerCase() === targetHost) || null;
    }

    findAppByExactName(apps = [], appName = '') {
        const targetName = normalizeText(appName).toLowerCase();
        if (!targetName) {
            return null;
        }
        return (Array.isArray(apps) ? apps : []).find((app) => normalizeText(app?.appName).toLowerCase() === targetName) || null;
    }

    findAppByFuzzyMatch(apps = [], blueprint = {}) {
        const targetSlug = normalizeText(blueprint.slug);
        const targetName = normalizeText(blueprint.appName);
        const targetHost = normalizeText(blueprint.publicHost);
        if (!targetSlug && !targetName && !targetHost) {
            return null;
        }

        return (Array.isArray(apps) ? apps : []).find((app) => (
            valuesLooselyMatch(app?.slug, targetSlug)
            || valuesLooselyMatch(app?.repoName, targetSlug)
            || valuesLooselyMatch(app?.appName, targetName)
            || valuesLooselyMatch(app?.publicHost, targetHost)
        )) || null;
    }

    async resolveRecentSessionManagedApp(sessionId = null, ownerId = null) {
        const normalizedSessionId = normalizeText(sessionId);
        if (!normalizedSessionId) {
            return null;
        }

        try {
            if (this.sessionStore?.getOwned || this.sessionStore?.get) {
                const session = ownerId && this.sessionStore.getOwned
                    ? await this.sessionStore.getOwned(normalizedSessionId, ownerId)
                    : await this.sessionStore.get(normalizedSessionId);
                const activeProject = session?.metadata?.activeProject;
                const activeProjectType = normalizeText(activeProject?.type).toLowerCase();
                const activeProjectAppId = normalizeText(activeProject?.appId);
                const activeProjectAppSlug = normalizeText(activeProject?.appSlug);

                if (activeProjectType === 'managed-app' && (activeProjectAppId || activeProjectAppSlug)) {
                    const app = await this.resolveApp(activeProjectAppId || activeProjectAppSlug, ownerId);
                    if (app) {
                        return this.normalizeAppRecord(app);
                    }
                }
            }

            if (!this.sessionStore?.listMessages) {
                return null;
            }

            const messages = await this.sessionStore.listMessages(normalizedSessionId, 100, ownerId);
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                const metadata = messages[index]?.metadata || {};
                const managedAppId = normalizeText(metadata.managedAppId);
                const managedAppSlug = normalizeText(metadata.managedAppSlug);
                if (managedAppId) {
                    const app = await this.resolveApp(managedAppId, ownerId);
                    if (app) {
                        return this.normalizeAppRecord(app);
                    }
                }
                if (managedAppSlug) {
                    const app = await this.resolveApp(managedAppSlug, ownerId);
                    if (app) {
                        return this.normalizeAppRecord(app);
                    }
                }
            }
        } catch (_error) {
            return null;
        }

        return null;
    }

    async resolveAppForMutation(input = {}, blueprint = {}, ownerId = null) {
        const explicitRef = normalizeText(input.appRef || input.app || input.id || input.ref || '');
        const prompt = input.prompt || input.sourcePrompt || '';
        const explicitPromptName = extractExplicitAppName(prompt);
        const hasExplicitIdentity = hasExplicitManagedAppIdentityInput(input);
        const explicitNewAppIntent = hasExplicitNewManagedAppIntent(input);
        const requestedPublicHost = normalizePublicHost(input.publicHost || input.targetPublicHost || blueprint.publicHost);
        if (explicitRef) {
            const resolved = await this.resolveApp(explicitRef, ownerId);
            if (resolved) {
                return {
                    app: resolved,
                    reason: 'explicit-ref',
                };
            }
        }

        const explicitRepoOwner = normalizeText(input.repoOwner);
        const explicitRepoName = normalizeText(input.repoName);
        if (explicitRepoOwner && explicitRepoName && this.store?.getAppByRepo) {
            const byRepo = this.normalizeAppRecord(await this.store.getAppByRepo(explicitRepoOwner, explicitRepoName));
            if (byRepo) {
                return {
                    app: byRepo,
                    reason: 'explicit-repo',
                };
            }
        }

        if (!hasExplicitIdentity && !explicitNewAppIntent) {
            const sessionLinkedApp = await this.resolveRecentSessionManagedApp(input.sessionId, ownerId);
            if (sessionLinkedApp) {
                return {
                    app: sessionLinkedApp,
                    reason: 'session-linked',
                };
            }
        }

        const ownerApps = await this.listOwnerApps(ownerId, 50);
        const byHost = requestedPublicHost
            ? this.findAppByPublicHost(ownerApps, requestedPublicHost)
            : null;
        if (byHost) {
            return {
                app: byHost,
                reason: 'public-host',
            };
        }

        const explicitSlug = normalizeText(input.slug);
        if (explicitSlug) {
            const resolved = await this.resolveApp(explicitSlug, ownerId);
            if (resolved) {
                return {
                    app: resolved,
                    reason: 'explicit-slug',
                };
            }
        }

        if ((normalizeText(input.slug) || explicitPromptName) && blueprint?.slug && this.store?.getAppBySlug) {
            const byBlueprintSlug = this.normalizeAppRecord(await this.store.getAppBySlug(blueprint.slug, ownerId));
            if (byBlueprintSlug) {
                return {
                    app: byBlueprintSlug,
                    reason: 'derived-slug',
                };
            }
        }

        const byExactName = hasExplicitIdentity
            ? this.findAppByExactName(ownerApps, input.appName || input.name || input.title || explicitPromptName || blueprint.appName)
            : null;
        if (byExactName) {
            return {
                app: byExactName,
                reason: 'app-name',
            };
        }

        const byFuzzyMatch = (normalizeText(input.slug) || explicitPromptName)
            ? this.findAppByFuzzyMatch(ownerApps, blueprint)
            : null;
        if (byFuzzyMatch) {
            return {
                app: byFuzzyMatch,
                reason: 'fuzzy',
            };
        }

        return {
            app: null,
            reason: 'new',
        };
    }

    mergeBlueprintWithExisting(existing = {}, blueprint = {}, input = {}, sessionId = null) {
        const normalizedExisting = this.normalizeAppRecord(existing);
        const mergedMetadata = mergeMetadataSection(normalizedExisting?.metadata || {}, blueprint.metadata || {});
        const derivedRepoOwner = normalizeText(normalizedExisting?.repoOwner || blueprint.repoOwner);
        const derivedRepoName = normalizeText(normalizedExisting?.repoName || blueprint.repoName || normalizedExisting?.slug || blueprint.slug);
        const defaultRepoBase = normalizeText(this.getEffectiveGiteaConfig().baseURL).replace(/\/+$/, '');

        return {
            sessionId: sessionId || normalizedExisting?.sessionId || blueprint.sessionId || null,
            appName: hasAnyOwnInput(input, ['appName', 'name', 'title'])
                ? blueprint.appName
                : normalizeText(normalizedExisting?.appName || blueprint.appName),
            repoOwner: hasOwnInput(input, 'repoOwner')
                ? blueprint.repoOwner
                : derivedRepoOwner,
            repoName: hasAnyOwnInput(input, ['repoName', 'slug'])
                ? blueprint.repoName
                : derivedRepoName,
            repoUrl: hasOwnInput(input, 'repoUrl')
                ? blueprint.repoUrl
                : normalizeText(
                    normalizedExisting?.repoUrl
                    || (defaultRepoBase && derivedRepoOwner && derivedRepoName
                        ? `${defaultRepoBase}/${derivedRepoOwner}/${derivedRepoName}.git`
                        : blueprint.repoUrl),
                ),
            repoCloneUrl: hasOwnInput(input, 'repoCloneUrl')
                ? blueprint.repoCloneUrl
                : normalizeText(
                    normalizedExisting?.repoCloneUrl
                    || (defaultRepoBase && derivedRepoOwner && derivedRepoName
                        ? `${defaultRepoBase}/${derivedRepoOwner}/${derivedRepoName}.git`
                        : blueprint.repoCloneUrl),
                ),
            repoSshUrl: hasOwnInput(input, 'repoSshUrl')
                ? blueprint.repoSshUrl
                : normalizeText(normalizedExisting?.repoSshUrl || blueprint.repoSshUrl),
            defaultBranch: hasOwnInput(input, 'defaultBranch')
                ? blueprint.defaultBranch
                : normalizeText(normalizedExisting?.defaultBranch || blueprint.defaultBranch || 'main'),
            imageRepo: hasOwnInput(input, 'imageRepo')
                ? blueprint.imageRepo
                : normalizeText(normalizedExisting?.imageRepo || blueprint.imageRepo),
            namespace: hasOwnInput(input, 'namespace')
                ? blueprint.namespace
                : normalizeText(normalizedExisting?.namespace || blueprint.namespace),
            publicHost: hasOwnInput(input, 'publicHost')
                ? blueprint.publicHost
                : normalizeText(normalizedExisting?.publicHost || blueprint.publicHost),
            sourcePrompt: normalizeText(blueprint.sourcePrompt || normalizedExisting?.sourcePrompt),
            metadata: mergedMetadata,
        };
    }

    shouldSeedRepository(existing = null, input = {}, mergedApp = {}) {
        const explicitFiles = normalizeFilesInput(input.files);
        if (explicitFiles.length > 0) {
            return true;
        }

        if (!existing) {
            return true;
        }

        const nextPrompt = normalizeText(input.sourcePrompt || input.prompt || '');
        const previousPrompt = normalizeText(existing.sourcePrompt || mergedApp.sourcePrompt || '');
        return Boolean(nextPrompt && nextPrompt !== previousPrompt);
    }

    buildLifecycleMetadata(existingApp = null, {
        input = {},
        buildRun = null,
        phase = '',
        summary = '',
        desiredDeploy = {},
        liveDeploy = {},
        repoState = {},
        project = {},
        deployRequested = false,
        healthy = null,
    } = {}) {
        const app = this.normalizeAppRecord(existingApp || {});
        const computedSummary = normalizeText(summary || buildManagedAppStatusSummary(app, buildRun, phase, liveDeploy.lastDeployResult || null));
        const buildError = normalizeText(
            buildRun?.error?.message
            || liveDeploy?.lastError
            || app?.metadata?.liveDeploy?.lastError
            || '',
        );

        return buildManagedAppMetadata(app.metadata || {}, app, {
            deployConfig: this.getEffectiveDeployConfig(),
            managedAppsConfig: this.getEffectiveManagedAppsConfig(),
            project: {
                ...project,
                summary: computedSummary,
                currentObjective: normalizeText(project.currentObjective || input.sourcePrompt || input.prompt || app.sourcePrompt || app.metadata?.project?.currentObjective),
                nextStep: normalizeText(project.nextStep || deriveNextStepForLifecycle(phase, { deployRequested, healthy })),
                openItems: hasOwnInput(project, 'openItems')
                    ? project.openItems
                    : deriveOpenItemsForLifecycle(phase, {
                        deployRequested,
                        summary: computedSummary,
                        error: buildError,
                        healthy,
                    }),
                lastUserIntent: normalizeText(project.lastUserIntent || input.sourcePrompt || input.prompt || input.requestedAction || input.action || app.sourcePrompt || ''),
                lastActivityAt: new Date().toISOString(),
            },
            repoState,
            desiredDeploy,
            liveDeploy,
        });
    }

    async resolveApp(ref = '', ownerId = null) {
        const reference = normalizeText(ref);
        if (!reference) {
            return null;
        }

        const repoReference = parseManagedAppRepoReference(reference);
        if (repoReference && this.store?.getAppByRepo) {
            const byRepo = await this.store.getAppByRepo(repoReference.repoOwner, repoReference.repoName);
            if (byRepo) {
                return this.normalizeAppRecord(byRepo);
            }
        }

        const byId = this.store?.getAppById
            ? await this.store.getAppById(reference, ownerId)
            : null;
        if (hasPersistedAppId(byId)) {
            return this.normalizeAppRecord(byId);
        }

        const bySlug = this.store?.getAppBySlug
            ? await this.store.getAppBySlug(reference, ownerId)
            : null;
        if (hasPersistedAppId(bySlug)) {
            return this.normalizeAppRecord(bySlug);
        }

        if (repoReference && this.store?.getAppBySlug) {
            const byRepoSlug = await this.store.getAppBySlug(repoReference.repoName, ownerId);
            return hasPersistedAppId(byRepoSlug) ? this.normalizeAppRecord(byRepoSlug) : null;
        }

        return null;
    }

    async listApps(ownerId, limit = 50) {
        await this.store.ensureAvailable();
        const apps = this.normalizeAppList(await this.store.listApps(ownerId, limit));
        return apps.map((app) => {
            const project = this.buildAppProjectView(app, null);
            return {
                ...app,
                project,
                progress: project?.progress || null,
                summary: normalizeText(project?.summary || app.metadata?.project?.summary || ''),
                nextStep: normalizeText(project?.nextStep || ''),
                openItems: normalizeStringArray(project?.openItems || [], 8),
            };
        });
    }

    async listBuildRuns(appRef = '', ownerId = null, limit = 20) {
        const app = await this.resolveApp(appRef, ownerId);
        if (!app) {
            return [];
        }
        return this.store.listBuildRunsForApp(app.id, ownerId, limit);
    }

    async inspectApp(appRef = '', ownerId = null) {
        const app = await this.resolveApp(appRef, ownerId);
        if (!app) {
            return null;
        }

        let normalizedApp = this.normalizeAppRecord(app);
        let buildRuns = await this.store.listBuildRunsForApp(normalizedApp.id, ownerId, 10);
        let latestBuildRun = buildRuns[0] || null;
        const reconciled = await this.reconcilePendingBuildForApp(normalizedApp, ownerId, latestBuildRun);
        normalizedApp = this.normalizeAppRecord(reconciled.app || normalizedApp);
        if (reconciled.handledResult) {
            buildRuns = await this.store.listBuildRunsForApp(normalizedApp.id, ownerId, 10);
            latestBuildRun = buildRuns[0] || null;
        } else {
            latestBuildRun = reconciled.latestBuildRun || latestBuildRun;
            if (latestBuildRun && buildRuns.length > 0) {
                buildRuns = [latestBuildRun, ...buildRuns.slice(1)];
            }
        }
        const project = this.buildAppProjectView(normalizedApp, latestBuildRun);
        return {
            app: normalizedApp,
            buildRuns,
            project,
            progress: project?.progress || null,
            summary: normalizeText(project?.summary || normalizedApp.metadata?.project?.summary || buildManagedAppStatusSummary(normalizedApp, latestBuildRun, normalizedApp.status || 'updated')),
        };
    }

    async resolveExistingAppForAction(appRef = '', input = {}, ownerId = null, context = {}) {
        const explicitRef = normalizeText(appRef || input.appRef || input.app || input.id || input.ref || '');
        if (explicitRef) {
            return this.resolveApp(explicitRef, ownerId);
        }

        const sessionId = normalizeText(context.sessionId || input.sessionId || '') || null;
        const blueprint = this.buildAppBlueprint(input, ownerId, sessionId, context);
        const resolved = await this.resolveAppForMutation({
            ...input,
            sessionId,
        }, blueprint, ownerId);
        return resolved.app || null;
    }

    async persistIterationState(app = null, buildRun = null, {
        input = {},
        action = 'edit',
        phase = '',
        committedPaths = [],
        deployment = null,
        summary = '',
        failureCategory = '',
        executor = 'managed-app-backend',
        remoteCli = null,
        pipelineUrl = '',
    } = {}) {
        const normalizedApp = this.normalizeAppRecord(app);
        if (!normalizedApp || !buildRun?.id || !this.store?.updateBuildRun) {
            return buildRun;
        }

        const evidence = buildManagedAppIterationEvidence(normalizedApp, buildRun, {
            committedPaths,
            pipelineUrl: pipelineUrl || buildRun.externalRunUrl,
            remoteCli,
            phase,
        });
        const stages = buildManagedAppIterationStages({
            action,
            app: normalizedApp,
            buildRun,
            phase,
            details: {
                committedPaths,
                remoteCli,
            },
        });
        const iterationSummary = normalizeText(summary)
            || buildManagedAppStatusSummary(normalizedApp, buildRun, phase, deployment);
        const previousMetadata = buildRun.metadata && typeof buildRun.metadata === 'object'
            ? buildRun.metadata
            : {};

        return this.store.updateBuildRun(buildRun.id, {
            metadata: {
                ...previousMetadata,
                iteration: {
                    ...(previousMetadata.iteration || {}),
                    action,
                    prompt: normalizeText(input.prompt || input.sourcePrompt),
                    deployRequested: buildRun.deployRequested === true,
                    summary: iterationSummary,
                    phase: normalizeText(phase),
                    stages,
                    evidence,
                    committedPaths: evidence.committedPaths,
                    commitSha: evidence.commitSha,
                    pipelineUrl: evidence.pipelineUrl,
                    imageTag: evidence.imageTag,
                    failureCategory: normalizeText(failureCategory),
                    remoteCli: evidence.remoteCli,
                    productSignals: {
                        failedIteration: stages.some((stage) => stage.status === 'failed'),
                        missingGitLabMovement: Boolean(evidence.commitSha && !evidence.requiredProof.gitlabPipelineObserved),
                        staleDeployProof: Boolean(evidence.deployStatus && !evidence.requiredProof.publicVerificationObserved),
                        repeatedCorrection: /(?:again|still|didn'?t|nothing changed|not what i asked|same problem)/i.test(normalizeText(input.prompt || input.sourcePrompt)),
                    },
                    sourceOfTruth: 'gitlab',
                    executor: normalizeText(executor) || 'managed-app-backend',
                    updatedAt: new Date().toISOString(),
                },
            },
        });
    }

    buildIterationResponse(app = null, buildRun = null, {
        action = 'edit',
        phase = '',
        summary = '',
        committedPaths = [],
        deployment = null,
        message = '',
        executor = 'managed-app-backend',
        remoteCli = null,
        pipelineUrl = '',
    } = {}) {
        const normalizedApp = this.normalizeAppRecord(app);
        const evidence = buildManagedAppIterationEvidence(normalizedApp, buildRun, {
            committedPaths,
            pipelineUrl: pipelineUrl || buildRun?.externalRunUrl,
            remoteCli,
            phase,
        });
        const stages = buildManagedAppIterationStages({
            action,
            app: normalizedApp,
            buildRun,
            phase,
            details: {
                committedPaths,
                remoteCli,
            },
        });
        const project = this.buildAppProjectView(normalizedApp, buildRun, {
            phase,
            summary,
            deployment,
            action,
            iterationStages: stages,
        });

        return {
            app: normalizedApp,
            buildRun,
            iteration: {
                action,
                stage: normalizeText(phase),
                stages,
                evidence,
                nextActions: buildManagedAppIterationNextActions({ action, app: normalizedApp, buildRun }),
                previewUrl: evidence.publicUrl,
                summary: normalizeText(summary || project?.summary || message),
                executor: normalizeText(executor) || 'managed-app-backend',
            },
            project,
            progress: project?.progress || null,
            publicUrl: evidence.publicUrl,
            repository: {
                owner: normalizeText(normalizedApp?.repoOwner),
                name: normalizeText(normalizedApp?.repoName),
                url: normalizeText(normalizedApp?.repoUrl),
                cloneUrl: normalizeText(normalizedApp?.repoCloneUrl),
            },
            message: normalizeText(message || summary || project?.summary),
        };
    }

    buildRemoteCliIterationTask(app = {}, input = {}, action = 'edit') {
        const prompt = normalizeText(input.prompt || input.sourcePrompt || app.sourcePrompt);
        const desiredDeploy = app.metadata?.desiredDeploy && typeof app.metadata.desiredDeploy === 'object'
            ? app.metadata.desiredDeploy
            : {};
        const publicHost = normalizeText(input.publicHost || app.publicHost || desiredDeploy.publicHost);
        const namespace = normalizeText(input.namespace || app.namespace || desiredDeploy.namespace);
        const repoUrl = normalizeText(app.repoCloneUrl || app.repoUrl || app.repoSshUrl);
        const deployRequested = input.deployRequested === true;

        return [
            'Managed-app backend CLI iteration.',
            '',
            `Action: ${action}`,
            `App: ${normalizeText(app.appName || app.slug)}`,
            `Managed app id: ${normalizeText(app.id)}`,
            `Repository: ${normalizeText(app.repoOwner)}/${normalizeText(app.repoName)}`,
            repoUrl ? `Git remote: ${repoUrl}` : '',
            `Default branch: ${normalizeText(app.defaultBranch || desiredDeploy.defaultBranch || 'main')}`,
            namespace ? `Namespace: ${namespace}` : '',
            publicHost ? `Public host: ${publicHost}` : '',
            `Deploy requested: ${deployRequested ? 'yes' : 'no'}`,
            '',
            'User iteration prompt:',
            prompt,
            '',
            'Use the backend CLI/remote workbench tools to inspect the repo tree, patch source, run focused checks, commit, and push to the configured GitLab source of truth.',
            'Prefer GitLab CI, the managed-app build event path, and repo-managed manifests for build/deploy. Do not deploy by ad hoc ConfigMap or kubectl shell mutation unless you are explicitly repairing an existing failed rollout and then persist the fix back to GitLab.',
            'Do not treat a successful shell command or a healthy pod as completion by itself. Completion evidence must come back as source-to-public proof: changed files, commit, GitLab pipeline/build, image tag or digest, rollout, and public verification where available.',
            'If this is an edit or build action, finish with a pushed commit. Include final proof marker lines: WHAT_CHANGED=<short summary>, VERIFY_COMMANDS=<commands/checks run>, VERIFY_RESULTS=<pass/fail/blocked results>, PUBLIC_URL=<https URL or not_available>, BLOCKER=<none or exact blocker>, GIT_REPO=<origin>, GIT_COMMIT=<sha>, CHANGED_FILES=<comma-separated paths>, PIPELINE_URL=<url if known>, IMAGE_TAG=<tag if known>, and any known DEPLOYMENT/PUBLIC_HOST/UI_CHECK_REPORT/UI_SCREENSHOTS markers.',
            'If credentials, runner access, destructive replacement, or an ambiguous target blocks the work, emit USER_INPUT_REQUIRED=<concise decision needed> instead of guessing.',
        ].filter(Boolean).join('\n');
    }

    async runRemoteCliIteration(app = {}, input = {}, ownerId = null, context = {}, action = 'edit') {
        if (!this.remoteCliAgentRunner || typeof this.remoteCliAgentRunner.run !== 'function') {
            const error = new Error('Managed app remote CLI iterations require a configured remote-cli-agent runner.');
            error.statusCode = 503;
            throw error;
        }

        const runnerConfig = typeof this.remoteCliAgentRunner.getPublicConfig === 'function'
            ? this.remoteCliAgentRunner.getPublicConfig()
            : {};
        if (runnerConfig && runnerConfig.configured === false) {
            const error = new Error('Managed app remote CLI iterations require configured remote-cli-agent transport and credentials.');
            error.statusCode = 503;
            throw error;
        }

        const task = this.buildRemoteCliIterationTask(app, input, action);
        const remoteResult = await this.remoteCliAgentRunner.run({
            task,
            targetId: input.remoteCliTargetId || input.targetId || runnerConfig.defaultTargetId || 'prod',
            cwd: input.remoteCliCwd || input.cwd || runnerConfig.defaultCwd || '',
            sessionId: input.remoteCliSessionId || input.remoteSessionId || input.sessionId || context.remoteCliSessionId || '',
            waitMs: input.waitMs || input.remoteCliWaitMs || 120000,
            maxTurns: input.maxTurns || input.remoteCliMaxTurns || 30,
            adminMode: true,
            agentName: 'Managed app backend CLI worker',
            instructions: [
                'This run is controlled by the KimiBuilt managed-app iteration loop.',
                'Do not ask for routine names, hosts, branches, namespaces, or deployment shape; use the managed-app facts in the task.',
                'Use the GitLab repository tree as the editable source of truth. Prefer GitLab-backed source, commit, pipeline/build event, image/deploy evidence, and public verification markers over conversational status.',
                'Avoid direct live-cluster artifact deployment as the normal path; if a live repair is unavoidable, make the same change durable in the repo before reporting completion.',
            ].join('\n'),
        });

        const commitSha = normalizeText(remoteResult.gitCommit || remoteResult.commitSha);
        const changedPaths = normalizeStringArray(
            input.committedPaths?.length
                ? input.committedPaths
                : extractRemoteCliChangedPaths(remoteResult.finalOutput),
            20,
        );
        const userInputRequired = normalizeText(String(remoteResult.finalOutput || '').match(/^\s*USER_INPUT_REQUIRED\s*[:=]\s*(.+?)\s*$/im)?.[1] || '');
        if (userInputRequired) {
            const error = new Error(userInputRequired);
            error.statusCode = 409;
            error.code = 'MANAGED_APP_ITERATION_USER_INPUT_REQUIRED';
            error.remoteCli = remoteResult;
            throw error;
        }
        if (!commitSha) {
            const error = new Error('remote-cli-agent finished without a GIT_COMMIT marker, so the managed-app loop cannot record GitLab-backed source evidence.');
            error.statusCode = 502;
            error.code = 'MANAGED_APP_ITERATION_MISSING_COMMIT';
            error.remoteCli = remoteResult;
            throw error;
        }

        const metadata = buildManagedAppMetadata(app.metadata || {}, app, {
            deployConfig: this.getEffectiveDeployConfig(),
            managedAppsConfig: this.getEffectiveManagedAppsConfig(),
            project: {
                summary: `Remote backend CLI iteration pushed ${commitSha.slice(0, 12)} for ${app.appName || app.slug}.`,
                currentObjective: normalizeText(input.prompt || input.sourcePrompt || app.sourcePrompt),
                nextStep: input.deployRequested === true
                    ? 'Observe the GitLab pipeline and continue deployment through managed-app verification.'
                    : 'Observe the GitLab pipeline, then deploy or verify through the managed-app workbench.',
                lastUserIntent: normalizeText(input.prompt || input.sourcePrompt || app.sourcePrompt),
                lastActivityAt: new Date().toISOString(),
            },
            repoState: {
                initialized: true,
                lastSeededPaths: changedPaths.length > 0 ? changedPaths : app.metadata?.repoState?.lastSeededPaths,
                lastCommitSha: commitSha,
                lastCommitAt: new Date().toISOString(),
            },
        });
        const updatedApp = this.store?.updateApp
            ? this.normalizeAppRecord(await this.store.updateApp(app.id, app.ownerId || ownerId, {
                status: 'building',
                sourcePrompt: normalizeText(input.prompt || input.sourcePrompt || app.sourcePrompt),
                metadata,
            }))
            : app;
        const buildRun = await this.store.createBuildRun({
            appId: updatedApp.id,
            ownerId: updatedApp.ownerId || ownerId,
            sessionId: input.sessionId || context.sessionId || updatedApp.sessionId || null,
            source: 'remote-cli-agent',
            requestedAction: input.deployRequested === true ? 'deploy' : 'build',
            commitSha,
            imageTag: buildImageTagFromCommit(commitSha),
            buildStatus: 'queued',
            deployRequested: input.deployRequested === true,
            deployStatus: input.deployRequested === true ? 'pending' : 'not_requested',
            verificationStatus: 'pending',
            externalRunId: normalizeText(remoteResult.pipelineId || ''),
            externalRunUrl: normalizeText(input.pipelineUrl || remoteResult.pipelineUrl || ''),
            metadata: {
                remoteCli: remoteResult,
                committedPaths: changedPaths,
            },
        });
        const persistedBuildRun = await this.persistIterationState(updatedApp, buildRun, {
            input,
            action,
            phase: updatedApp.status || 'building',
            committedPaths: changedPaths,
            summary: `remote-cli-agent pushed ${commitSha.slice(0, 12)} and queued GitLab evidence tracking.`,
            executor: 'remote-cli-agent',
            remoteCli: remoteResult,
        });

        return this.buildIterationResponse(updatedApp, persistedBuildRun || buildRun, {
            action,
            phase: updatedApp.status || 'building',
            committedPaths: changedPaths,
            summary: `remote-cli-agent pushed ${commitSha.slice(0, 12)} and queued GitLab evidence tracking.`,
            message: `remote-cli-agent pushed ${commitSha.slice(0, 12)} and queued GitLab evidence tracking.`,
            executor: 'remote-cli-agent',
            remoteCli: remoteResult,
        });
    }

    async iterateApp(appRef = '', input = {}, ownerId = null, context = {}) {
        await this.store.ensureAvailable();
        const action = normalizeIterationAction(input.action || input.requestedAction || 'edit');
        if (!action) {
            const error = new Error('Managed app iterations support action values: edit, build, deploy, or verify.');
            error.statusCode = 400;
            throw error;
        }

        const app = await this.resolveExistingAppForAction(appRef, input, ownerId, context);
        if (!app) {
            return null;
        }

        const normalizedInput = {
            ...input,
            sessionId: input.sessionId || context.sessionId || app.sessionId || null,
        };

        if (action === 'deploy') {
            const deployed = await this.deployApp(app.id, {
                ...normalizedInput,
                requestedAction: 'deploy',
                deployRequested: true,
            }, ownerId, context);
            if (!deployed) {
                return null;
            }
            const buildRun = deployed.buildRun
                ? await this.persistIterationState(deployed.app, deployed.buildRun, {
                    input: normalizedInput,
                    action,
                    phase: deployed.app?.status || 'deployed',
                    deployment: deployed.deployment || null,
                    summary: deployed.message,
                })
                : deployed.buildRun;
            return this.buildIterationResponse(deployed.app, buildRun || deployed.buildRun, {
                action,
                phase: deployed.app?.status || 'deployed',
                deployment: deployed.deployment || null,
                summary: deployed.message,
                message: deployed.message,
            });
        }

        if (action === 'verify') {
            const inspected = await this.inspectApp(app.id, ownerId);
            if (!inspected) {
                return null;
            }
            const latestBuildRun = inspected.buildRuns?.[0] || inspected.latestBuildRun || null;
            const phase = inspected.app?.status || latestBuildRun?.verificationStatus || 'verify';
            const buildRun = latestBuildRun
                ? await this.persistIterationState(inspected.app, latestBuildRun, {
                    input: normalizedInput,
                    action,
                    phase,
                    summary: inspected.summary,
                })
                : latestBuildRun;
            return this.buildIterationResponse(inspected.app, buildRun || latestBuildRun, {
                action,
                phase,
                summary: inspected.summary,
                message: inspected.summary,
            });
        }

        if (action === 'edit' && !normalizeText(normalizedInput.prompt || normalizedInput.sourcePrompt) && normalizeFilesInput(normalizedInput.files).length === 0) {
            const error = new Error('Managed app edit iterations require a prompt or explicit files.');
            error.statusCode = 400;
            throw error;
        }

        if (normalizeIterationExecutor(normalizedInput) === 'remote-cli-agent') {
            return this.runRemoteCliIteration(app, normalizedInput, ownerId, context, action);
        }

        const deployRequested = normalizedInput.deployRequested === true
            || (action !== 'build' && inferDeployRequested(normalizedInput.requestedAction || normalizedInput.action, false));
        const updated = await this.updateApp(app.id, {
            ...normalizedInput,
            action: deployRequested ? 'deploy' : 'build',
            requestedAction: deployRequested ? 'deploy' : 'build',
            deployRequested,
            sourcePrompt: normalizeText(normalizedInput.sourcePrompt || normalizedInput.prompt || app.sourcePrompt),
        }, ownerId, context);
        if (!updated) {
            return null;
        }

        const phase = updated.app?.status || 'updated';
        const buildRun = updated.buildRun
            ? await this.persistIterationState(updated.app, updated.buildRun, {
                input: normalizedInput,
                action,
                phase,
                committedPaths: updated.committedPaths || [],
                summary: updated.message,
            })
            : updated.buildRun;
        return this.buildIterationResponse(updated.app, buildRun || updated.buildRun, {
            action,
            phase,
            committedPaths: updated.committedPaths || [],
            summary: updated.message,
            message: updated.message,
        });
    }

    async doctorPlatform(input = {}, ownerId = null, context = {}) {
        const deploymentTarget = this.resolveDeploymentTarget(input, context, null);
        if (!this.kubernetesClient.isConfigured(deploymentTarget)) {
            const error = new Error('Managed app platform inspection requires configured SSH access to the remote deploy host.');
            error.statusCode = 503;
            throw error;
        }

        const giteaConfig = this.getEffectiveGiteaConfig();
        const managedAppsConfig = this.getEffectiveManagedAppsConfig();
        const platform = await this.kubernetesClient.inspectManagedAppPlatform({
            platformNamespace: input.platformNamespace || managedAppsConfig.platformNamespace,
            deploymentTarget,
        });
        const healthy = platform.namespaceExists
            && isDeploymentReady(getDeploymentStatus(platform, 'gitlab'))
            && isDeploymentReady(getDeploymentStatus(platform, 'buildkitd'))
            && isDeploymentReady(getDeploymentStatus(platform, 'gitlab-runner'))
            && normalizeText(platform.runnerTokenState).toLowerCase() === 'present';
        const suggestions = buildPlatformDoctorSuggestions(platform);
        const message = buildPlatformDoctorMessage(platform, healthy);
        this.recordRemoteServerContext(platform, {
            objective: normalizeText(input.prompt || input.sourcePrompt || 'Inspect the managed app platform on the remote k3s host.'),
        });
        const app = normalizeText(input.appRef || input.app || input.id || input.slug)
            ? await this.resolveApp(normalizeText(input.appRef || input.app || input.id || input.slug), ownerId)
            : null;

        if (app) {
            await this.store.updateApp(app.id, app.ownerId, {
                metadata: this.buildLifecycleMetadata(app, {
                    input,
                    phase: 'doctor',
                    summary: message,
                    healthy,
                    project: {
                        openItems: suggestions,
                    },
                }),
            });
        }

        return {
            platform: {
                ...platform,
                expected: {
                    deploymentTarget,
                    platformNamespace: managedAppsConfig.platformNamespace,
                    gitlabBaseURL: giteaConfig.baseURL,
                    registryHost: giteaConfig.registryHost,
                },
            },
            healthy,
            suggestions,
            message,
        };
    }

    async reconcilePlatform(input = {}, ownerId = null, context = {}) {
        const deploymentTarget = this.resolveDeploymentTarget(input, context, null);
        if (!this.giteaClient.isConfigured()) {
            const error = new Error('Managed app platform reconciliation requires a configured external GitLab control plane.');
            error.statusCode = 503;
            throw error;
        }
        if (!this.kubernetesClient.isConfigured(deploymentTarget)) {
            const error = new Error('Managed app platform reconciliation requires configured SSH access to the remote deploy host.');
            error.statusCode = 503;
            throw error;
        }

        const giteaConfig = this.getEffectiveGiteaConfig();
        const managedAppsConfig = this.getEffectiveManagedAppsConfig();
        const platformNamespace = normalizeText(input.platformNamespace || managedAppsConfig.platformNamespace || 'agent-platform');
        const before = await this.kubernetesClient.inspectManagedAppPlatform({
            platformNamespace,
            deploymentTarget,
        });
        const runnerScope = normalizeText(input.runnerScope || 'instance').toLowerCase() || 'instance';
        const shouldRotateRunnerToken = input.rotateRunnerToken === true
            || ['missing', 'missing-secret', 'placeholder'].includes(normalizeText(before.runnerTokenState).toLowerCase())
            || (Array.isArray(before.runnerLogExcerpt)
                && before.runnerLogExcerpt.some((line) => /\bunauthorized\b|\bforbidden\b|\binvalid\b|\btoken\b/i.test(String(line || ''))));
        let runnerToken = {
            scope: runnerScope,
            token: normalizeText(input.runnerToken || giteaConfig.runnerToken),
            rotated: false,
        };
        if (!runnerToken.token && typeof this.giteaClient.getRunnerRegistrationToken === 'function') {
            runnerToken = await this.giteaClient.getRunnerRegistrationToken({
                scope: runnerScope,
                org: giteaConfig.org,
                owner: input.repoOwner,
                repo: input.repoName,
                rotate: shouldRotateRunnerToken,
            });
        }
        if (!runnerToken.token) {
            const error = new Error('Managed app platform reconciliation requires GITLAB_RUNNER_TOKEN or input.runnerToken.');
            error.statusCode = 503;
            throw error;
        }
        const desiredRunnerReplicas = Number.isFinite(Number(input.runnerReplicas))
            ? Math.max(0, Number(input.runnerReplicas))
            : 1;
        const runnerLabels = normalizeText(input.runnerLabels || input.runnerTags || before.runnerLabels || DEFAULT_GITLAB_RUNNER_TAGS);
        const gitlabInstanceUrl = normalizeText(input.gitlabInstanceUrl || input.giteaInstanceUrl || giteaConfig.baseURL || before.gitlabInstanceUrl || before.giteaInstanceUrl);
        const reconciliation = await this.kubernetesClient.reconcileManagedAppPlatform({
            platformNamespace,
            deploymentTarget,
            desiredRunnerReplicas,
            runnerRegistrationToken: runnerToken.token,
            runnerLabels,
            gitlabInstanceUrl,
            giteaInstanceUrl: gitlabInstanceUrl,
        });
        const platform = await this.kubernetesClient.inspectManagedAppPlatform({
            platformNamespace,
            deploymentTarget,
        });

        let runnerCatalog = {
            scope: runnerScope,
            runners: [],
            totalCount: 0,
            error: '',
        };
        try {
            const listed = await this.giteaClient.listActionsRunners({
                scope: runnerScope,
                org: giteaConfig.org,
                owner: input.repoOwner,
                repo: input.repoName,
            });
            runnerCatalog = {
                ...listed,
                error: '',
            };
        } catch (error) {
            runnerCatalog.error = error.message;
        }

        const runners = normalizeRunnerRecords(runnerCatalog);
        const onlineRunnerCount = runners.filter((runner) => !runner.disabled && runner.status && runner.status !== 'offline').length;
        const healthy = isPlatformHealthy(platform) && (giteaConfig.provider !== 'gitea' || onlineRunnerCount > 0);
        const suggestions = buildPlatformDoctorSuggestions(platform);
        if (giteaConfig.provider === 'gitea' && !runnerCatalog.error && onlineRunnerCount === 0) {
            suggestions.push(`Gitea reports no online ${runnerScope}-level runners yet. The runner may still be registering, or the deployment labels may not match the workflow.`);
        }
        if (runnerCatalog.error) {
            suggestions.push(`Runner verification through the GitLab API failed after reconciliation: ${runnerCatalog.error}`);
        }
        const message = `Managed app platform reconciliation on ${normalizeText(platform.executionHost || reconciliation.executionHost || 'remote ssh target')}: ${reconciliation.actions.join(', ') || 'no changes reported'}; ${healthy ? 'platform healthy' : 'platform still needs attention'}.`;
        this.recordRemoteServerContext(platform, {
            objective: normalizeText(input.prompt || input.sourcePrompt || 'Reconcile the managed app platform on the remote k3s host.'),
        });
        const app = normalizeText(input.appRef || input.app || input.id || input.slug)
            ? await this.resolveApp(normalizeText(input.appRef || input.app || input.id || input.slug), ownerId)
            : null;

        if (app) {
            await this.store.updateApp(app.id, app.ownerId, {
                metadata: this.buildLifecycleMetadata(app, {
                    input,
                    phase: 'reconcile',
                    summary: message,
                    healthy,
                    project: {
                        openItems: suggestions,
                    },
                }),
            });
        }

        return {
            before: {
                ...before,
                expected: {
                    deploymentTarget,
                    platformNamespace,
                    gitlabBaseURL: giteaConfig.baseURL,
                    registryHost: giteaConfig.registryHost,
                },
            },
            platform: {
                ...platform,
                expected: {
                    deploymentTarget,
                    platformNamespace,
                    gitlabBaseURL: giteaConfig.baseURL,
                    registryHost: giteaConfig.registryHost,
                    runnerLabels,
                    runnerReplicas: desiredRunnerReplicas,
                },
            },
            reconciliation,
            runnerToken: {
                scope: runnerToken.scope,
                rotated: runnerToken.rotated,
                source: giteaConfig.provider === 'gitea' ? 'gitea-api' : 'gitlab-config',
            },
            gitlabRunners: {
                scope: runnerCatalog.scope,
                totalCount: Number(runnerCatalog.totalCount || runners.length || 0),
                onlineCount: onlineRunnerCount,
                runners,
                ...(runnerCatalog.error ? { error: runnerCatalog.error } : {}),
            },
            healthy,
            suggestions: Array.from(new Set(suggestions.filter(Boolean))),
            message,
        };
    }

    buildAppBlueprint(input = {}, ownerId = null, sessionId = null, context = {}) {
        const giteaConfig = this.getEffectiveGiteaConfig();
        const managedAppsConfig = this.getEffectiveManagedAppsConfig();
        const deployConfig = this.getEffectiveDeployConfig();
        const explicitPromptName = extractExplicitAppName(input.prompt || input.sourcePrompt || '');
        const rawName = deriveRequestedAppName(input) || buildFallbackRequestedAppName();
        const deploymentTarget = this.resolveDeploymentTarget(input, context, null);
        const slug = slugify(input.slug || rawName || buildFallbackRequestedAppName(), {
            maxLength: MAX_MANAGED_APP_SLUG_LENGTH,
        });
        const appName = normalizeText(
            input.appName
            || input.name
            || input.title
            || (explicitPromptName ? titleizeSlug(slugify(explicitPromptName)) : '')
            || titleizeSlug(slug),
        );
        const repoOwner = normalizeText(input.repoOwner || giteaConfig.org || 'agent-apps');
        const repoName = slug;
        const imageRepo = resolveManagedAppImageRepo({
            ...input,
            slug,
            repoOwner,
            repoName,
        }, giteaConfig);
        if (!imageRepo) {
            const error = new Error('Managed app image publishing requires a configured GitLab registry host or a derivable GitLab base URL host.');
            error.statusCode = 503;
            throw error;
        }
        const namespace = normalizeManagedAppNamespace(
            input.namespace,
            {
                slug,
                namespacePrefix: managedAppsConfig.namespacePrefix || 'app-',
            },
        );
        const publicHost = resolveInputPublicHost(input, managedAppsConfig, deployConfig)
            || normalizeText(`${slug}.${managedAppsConfig.appBaseDomain || 'demoserver2.buzz'}`);
        const defaultBranch = normalizeText(input.defaultBranch || managedAppsConfig.defaultBranch || 'main');
        const requestedContainerPort = Number(input.containerPort || managedAppsConfig.defaultContainerPort || 80);

        const blueprint = {
            ownerId,
            sessionId,
            slug,
            appName,
            repoOwner,
            repoName,
            repoUrl: normalizeText(input.repoUrl || `${normalizeText(giteaConfig.baseURL).replace(/\/+$/, '')}/${repoOwner}/${repoName}.git`),
            repoCloneUrl: normalizeText(input.repoCloneUrl || `${normalizeText(giteaConfig.baseURL).replace(/\/+$/, '')}/${repoOwner}/${repoName}.git`),
            repoSshUrl: normalizeText(input.repoSshUrl || ''),
            defaultBranch,
            imageRepo,
            namespace,
            publicHost,
            sourcePrompt: normalizeText(input.sourcePrompt || input.prompt || ''),
            status: normalizeAppStatus(input.status || 'draft'),
        };

        blueprint.metadata = buildManagedAppMetadata(input.metadata || {}, blueprint, {
            deployConfig,
            managedAppsConfig,
            desiredDeploy: {
                deploymentTarget,
                namespace,
                publicHost,
                imageRepo,
                defaultBranch,
                containerPort: Number.isFinite(requestedContainerPort) && requestedContainerPort > 0 ? requestedContainerPort : 80,
                ingressClassName: deployConfig.ingressClassName,
                tlsClusterIssuer: deployConfig.tlsClusterIssuer,
                registryPullSecretName: managedAppsConfig.registryPullSecretName,
            },
            project: {
                currentObjective: normalizeText(input.sourcePrompt || input.prompt || ''),
                lastUserIntent: normalizeText(input.sourcePrompt || input.prompt || ''),
            },
        });

        return blueprint;
    }

    async buildRepositoryFiles(app = {}, input = {}, context = {}) {
        const baseFiles = buildDefaultScaffoldFiles({
            appName: app.appName,
            slug: app.slug,
            publicHost: app.publicHost,
            namespace: app.namespace,
            sourcePrompt: app.sourcePrompt,
            gitProviderOrg: app.repoOwner,
            imageRepo: app.imageRepo,
            registryHost: this.getEffectiveGiteaConfig().registryHost,
            buildEventsUrl: this.buildBuildEventsUrl(),
        });
        const explicitFiles = normalizeFilesInput(input.files);
        if (explicitFiles.length > 0) {
            return mergeRepositoryFiles(baseFiles, explicitFiles);
        }

        const sourcePrompt = normalizeText(input.sourcePrompt || input.prompt || app.sourcePrompt);
        if (!sourcePrompt || !this.llmClient || typeof this.llmClient.complete !== 'function') {
            return baseFiles;
        }

        try {
            const completion = await this.llmClient.complete(
                buildManagedAppAuthoringPrompt({
                    appName: app.appName,
                    slug: app.slug,
                    publicHost: app.publicHost,
                    namespace: app.namespace,
                    sourcePrompt,
                }),
                {
                    model: context.model || '',
                    reasoningEffort: 'medium',
                },
            );
            const parsed = parseLenientJson(String(completion || '').trim());
            const generatedFiles = normalizeGeneratedManagedAppSourceFiles(parsed?.files || parsed);
            if (generatedFiles.length === 0) {
                return baseFiles;
            }

            return mergeRepositoryFiles(baseFiles, generatedFiles);
        } catch (error) {
            console.warn(`[ManagedApp] Falling back to the default scaffold for ${app.slug || 'managed-app'}: ${error.message}`);
            return baseFiles;
        }
    }

    async ensurePersistedApp(app = null, blueprint = {}, ownerId = null) {
        if (hasPersistedAppId(app)) {
            return app;
        }

        let persisted = await this.store.getAppBySlug(blueprint.slug, ownerId)
            || await this.store.getAppByRepo(blueprint.repoOwner, blueprint.repoName);
        if (hasPersistedAppId(persisted)) {
            return persisted;
        }

        try {
            persisted = await this.store.createApp({
                ...blueprint,
                status: blueprint.status || 'provisioning',
            });
        } catch (error) {
            const recovered = await this.store.getAppBySlug(blueprint.slug, ownerId)
                || await this.store.getAppByRepo(blueprint.repoOwner, blueprint.repoName);
            if (hasPersistedAppId(recovered)) {
                return recovered;
            }
            throw error;
        }

        return persisted;
    }

    async createApp(input = {}, ownerId = null, context = {}) {
        await this.store.ensureAvailable();
        const normalizedOwnerId = normalizeText(ownerId);
        if (!normalizedOwnerId) {
            const error = new Error('Managed app creation requires an authenticated owner context.');
            error.statusCode = 401;
            throw error;
        }
        if (!this.giteaClient.isConfigured()) {
            const error = new Error('Managed app creation requires integrations.gitlab to be configured.');
            error.statusCode = 503;
            throw error;
        }
        const sessionId = normalizeText(context.sessionId || input.sessionId || '') || null;
        const requestedAction = normalizeRequestedAction(input.requestedAction || input.action || 'build');
        const deployRequested = inferDeployRequested(requestedAction, input.deployRequested === true);
        const blueprint = this.buildAppBlueprint(input, normalizedOwnerId, sessionId, context);
        const resolved = await this.resolveAppForMutation(input, blueprint, normalizedOwnerId);
        const existing = resolved.app ? this.normalizeAppRecord(resolved.app) : null;
        const mergedState = existing
            ? this.mergeBlueprintWithExisting(existing, blueprint, input, sessionId)
            : {
                ...blueprint,
                sessionId,
            };
        const provisioningMetadata = this.buildLifecycleMetadata(existing || {
            ...blueprint,
            ...mergedState,
        }, {
            input,
            phase: existing ? 'updated' : 'created',
            deployRequested,
            desiredDeploy: {
                namespace: mergedState.namespace,
                publicHost: mergedState.publicHost,
                imageRepo: mergedState.imageRepo,
                defaultBranch: mergedState.defaultBranch,
                containerPort: Number(mergedState.metadata?.requestedContainerPort || blueprint.metadata?.requestedContainerPort || 80) || 80,
            },
            project: {
                currentObjective: normalizeText(input.sourcePrompt || input.prompt || blueprint.sourcePrompt),
                lastUserIntent: normalizeText(input.sourcePrompt || input.prompt || blueprint.sourcePrompt),
            },
        });

        const app = existing
            ? await this.store.updateApp(existing.id, normalizedOwnerId, {
                ...mergedState,
                metadata: provisioningMetadata,
                status: 'provisioning',
                sessionId,
            })
            : await this.store.createApp({
                ...blueprint,
                ...mergedState,
                metadata: provisioningMetadata,
                status: 'provisioning',
            });
        const persistedApp = await this.ensurePersistedApp(app, {
            ...blueprint,
            ...mergedState,
            metadata: provisioningMetadata,
            status: 'provisioning',
        }, normalizedOwnerId);
        const normalizedPersistedApp = this.normalizeAppRecord(persistedApp);

        let repository = {
            html_url: normalizedPersistedApp.repoUrl,
            clone_url: normalizedPersistedApp.repoCloneUrl,
            ssh_url: normalizedPersistedApp.repoSshUrl,
        };
        let commitSha = '';
        let committedPaths = [];
        const effectiveRepoOwner = normalizeText(normalizedPersistedApp.repoOwner || blueprint.repoOwner);
        const effectiveRepoName = normalizeText(normalizedPersistedApp.repoName || blueprint.repoName);
        const shouldSeedRepository = this.shouldSeedRepository(existing, input, normalizedPersistedApp);

        if (this.giteaClient.isConfigured()) {
            await this.giteaClient.ensureOrganization({
                name: effectiveRepoOwner,
                fullName: 'KimiBuilt Managed Apps',
                description: 'Application repositories provisioned by KimiBuilt.',
            });
            const ensuredRepo = await this.giteaClient.ensureRepository({
                owner: effectiveRepoOwner,
                name: effectiveRepoName,
                description: `Managed app for ${normalizedPersistedApp.appName}`,
                defaultBranch: normalizedPersistedApp.defaultBranch,
            });
            repository = ensuredRepo.repository || repository;

            if (shouldSeedRepository) {
                const seedResult = await this.giteaClient.upsertFiles({
                    owner: effectiveRepoOwner,
                    repo: effectiveRepoName,
                    branch: normalizedPersistedApp.defaultBranch,
                    files: await this.buildRepositoryFiles(normalizedPersistedApp, input, context),
                    commitMessagePrefix: existing ? 'Update managed app' : 'Seed managed app',
                });
                commitSha = seedResult.commitSha;
                committedPaths = seedResult.committedPaths;
            }
        }

        const nextStatus = commitSha
            ? 'building'
            : (existing
                ? ((normalizeText(existing.status) === 'draft' || normalizeText(existing.status) === 'provisioning') ? 'repo_ready' : existing.status)
                : 'repo_ready');
        const updatedApp = await this.store.updateApp(persistedApp.id, normalizedOwnerId, {
            repoOwner: effectiveRepoOwner,
            repoName: effectiveRepoName,
            repoUrl: normalizeText(repository.clone_url || repository.html_url || normalizedPersistedApp.repoUrl),
            repoCloneUrl: normalizeText(repository.clone_url || normalizedPersistedApp.repoCloneUrl),
            repoSshUrl: normalizeText(repository.ssh_url || normalizedPersistedApp.repoSshUrl),
            status: nextStatus,
            metadata: this.buildLifecycleMetadata({
                ...normalizedPersistedApp,
                repoOwner: effectiveRepoOwner,
                repoName: effectiveRepoName,
                repoUrl: normalizeText(repository.clone_url || repository.html_url || normalizedPersistedApp.repoUrl),
                repoCloneUrl: normalizeText(repository.clone_url || normalizedPersistedApp.repoCloneUrl),
                repoSshUrl: normalizeText(repository.ssh_url || normalizedPersistedApp.repoSshUrl),
                status: nextStatus,
            }, {
                input,
                phase: existing ? 'updated' : 'created',
                deployRequested,
                summary: commitSha
                    ? ''
                    : (existing
                        ? `${normalizedPersistedApp.appName} was resumed without repository changes.`
                        : `${normalizedPersistedApp.appName} was created without repository changes.`),
                repoState: {
                    initialized: true,
                    lastSeededPaths: committedPaths.length > 0
                        ? committedPaths
                        : normalizedPersistedApp.metadata?.repoState?.lastSeededPaths,
                    lastCommitSha: commitSha || normalizedPersistedApp.metadata?.repoState?.lastCommitSha,
                    lastCommitAt: commitSha ? new Date().toISOString() : normalizedPersistedApp.metadata?.repoState?.lastCommitAt,
                },
                desiredDeploy: {
                    namespace: mergedState.namespace,
                    publicHost: mergedState.publicHost,
                    imageRepo: normalizeText(normalizedPersistedApp.imageRepo || blueprint.imageRepo),
                    defaultBranch: mergedState.defaultBranch,
                },
                project: {
                    nextStep: commitSha
                        ? deriveNextStepForLifecycle(existing ? 'updated' : 'created', { deployRequested })
                        : '',
                },
            }),
        });
        const finalPersistedApp = (hasPersistedAppId(updatedApp) ? updatedApp : null)
            || (hasPersistedAppId(persistedApp) ? persistedApp : null)
            || await this.store.getAppByRepo(effectiveRepoOwner, effectiveRepoName)
            || await this.store.getAppBySlug(blueprint.slug, normalizedOwnerId);
        const persistedAppId = normalizeText(finalPersistedApp?.id);
        if (commitSha && !persistedAppId) {
            const error = new Error(`Managed app build run creation requires a persisted app id for ${effectiveRepoOwner}/${effectiveRepoName || blueprint.slug}.`);
            error.statusCode = 500;
            throw error;
        }

        const buildRun = commitSha
            ? await this.store.createBuildRun({
                appId: persistedAppId,
                ownerId: finalPersistedApp?.ownerId || updatedApp?.ownerId || persistedApp.ownerId || normalizedOwnerId,
                sessionId: finalPersistedApp?.sessionId || updatedApp?.sessionId || persistedApp.sessionId || sessionId,
                source: 'managed-app-service',
                requestedAction,
                commitSha,
                imageTag: buildImageTagFromCommit(commitSha),
                buildStatus: 'queued',
                deployRequested,
                deployStatus: deployRequested ? 'pending' : 'not_requested',
                verificationStatus: 'pending',
                metadata: {
                    trigger: existing ? 'resume' : 'create',
                    committedPaths,
                },
            })
            : null;

        let finalApp = this.normalizeAppRecord(finalPersistedApp || updatedApp || persistedApp);
        if (buildRun) {
            const lifecycleUpdatedApp = await this.store.updateApp(finalApp.id, normalizedOwnerId, {
                metadata: this.buildLifecycleMetadata(finalApp, {
                    input,
                    buildRun,
                    phase: existing ? 'updated' : 'created',
                    deployRequested,
                    repoState: {
                        lastBuildRunId: buildRun.id,
                    },
                }),
            });
            finalApp = this.normalizeAppRecord(lifecycleUpdatedApp
                ? {
                    ...finalApp,
                    ...lifecycleUpdatedApp,
                    metadata: lifecycleUpdatedApp.metadata || finalApp.metadata,
                }
                : finalApp);
        }
        await this.broadcastLifecycleEvent(finalApp, buildRun, existing ? 'updated' : 'created');

        return {
            app: finalApp,
            buildRun,
            repository: {
                owner: finalApp.repoOwner,
                name: finalApp.repoName,
                url: finalApp.repoUrl,
                cloneUrl: finalApp.repoCloneUrl,
                sshUrl: finalApp.repoSshUrl,
            },
            committedPaths,
            reusedExistingApp: Boolean(existing),
            message: existing
                ? (commitSha
                    ? `Resumed ${finalApp.appName} and queued an image build from ${finalApp.repoOwner}/${finalApp.repoName}.`
                    : `Resumed ${finalApp.appName} without repository changes.`)
                : (commitSha
                    ? `Created ${finalApp.appName} and queued an image build from ${finalApp.repoOwner}/${finalApp.repoName}.`
                    : `Created ${finalApp.appName} without repository changes.`),
        };
    }

    async updateApp(appRef = '', input = {}, ownerId = null, context = {}) {
        const app = await this.resolveExistingAppForAction(appRef, input, ownerId, context);
        if (!app) {
            return null;
        }

        return this.createApp({
            ...input,
            appRef: app.id,
            slug: app.slug,
            appName: input.appName || app.appName,
            sourcePrompt: input.sourcePrompt || input.prompt || app.sourcePrompt,
        }, ownerId, {
            ...context,
            sessionId: context.sessionId || app.sessionId,
        });
    }

    async deployApp(appRef = '', input = {}, ownerId = null, context = {}) {
        const app = this.normalizeAppRecord(await this.resolveExistingAppForAction(appRef, input, ownerId, context));
        if (!app) {
            return null;
        }
        const deploymentTarget = this.resolveDeploymentTarget(input, context, app);

        const requestedBuildRunId = normalizeText(input.buildRunId);
        let latestBuildRun = requestedBuildRunId
            ? await this.store.getBuildRunById?.(requestedBuildRunId)
            : (await this.store.listBuildRunsForApp(app.id, ownerId, 1))[0] || null;
        if (requestedBuildRunId && !latestBuildRun) {
            const error = new Error(`Managed app build run ${requestedBuildRunId} was not found.`);
            error.statusCode = 404;
            error.code = 'MANAGED_APP_BUILD_RUN_NOT_FOUND';
            throw error;
        }
        const reconciled = await this.reconcilePendingBuildForApp(app, ownerId, latestBuildRun);
        latestBuildRun = reconciled.latestBuildRun || latestBuildRun;
        if (requestedBuildRunId) {
            const requestedCommitSha = normalizeText(input.commitSha);
            const requestedImageDigest = normalizeOciSha256Digest(input.imageDigest);
            const identityMismatch = !isValidGitCommitSha(requestedCommitSha)
                || !requestedImageDigest
                || normalizeText(latestBuildRun?.id) !== requestedBuildRunId
                || normalizeText(latestBuildRun?.appId) !== normalizeText(app.id)
                || normalizeText(latestBuildRun?.ownerId) !== normalizeText(app.ownerId)
                || normalizeText(latestBuildRun?.commitSha) !== requestedCommitSha
                || normalizeOciSha256Digest(latestBuildRun?.imageDigest) !== requestedImageDigest;
            if (identityMismatch) {
                const error = new Error('Managed app deployment build identity did not match the requested app, owner, commit, and canonical image digest.');
                error.statusCode = 409;
                error.code = 'MANAGED_APP_BUILD_IDENTITY_MISMATCH';
                throw error;
            }
        }
        const giteaConfig = this.getEffectiveGiteaConfig();
        const managedAppsConfig = this.getEffectiveManagedAppsConfig();
        const deployConfig = this.getEffectiveDeployConfig();
        const explicitImageTag = normalizeText(input.imageTag);
        let deployableApp = this.normalizeAppRecord(reconciled.app || app);
        const latestSuccessfulImageTag = isSuccessfulBuildStatus(latestBuildRun?.buildStatus)
            ? normalizeText(latestBuildRun?.imageTag || buildImageTagFromCommit(latestBuildRun?.commitSha))
            : '';
        const latestSuccessfulImageDigest = isSuccessfulBuildStatus(latestBuildRun?.buildStatus)
            ? normalizeOciSha256Digest(latestBuildRun?.imageDigest)
            : '';
        if (!latestBuildRun || !isSuccessfulBuildStatus(latestBuildRun.buildStatus)) {
            throw buildManagedAppDeployBuildStateError(latestBuildRun);
        }
        if (!isKimiBuiltInitiatedBuildRun(latestBuildRun)) {
            const error = new Error('Managed-app deployment requires a successful build run initiated by the KimiBuilt control plane.');
            error.statusCode = 409;
            error.code = 'MANAGED_APP_DEPLOY_BUILD_RUN_UNTRUSTED';
            throw error;
        }

        if (!this.kubernetesClient.isConfigured(deploymentTarget)) {
            const error = new Error('Managed app deployment requires a healthy remote runner or configured SSH access to the remote deploy host.');
            error.statusCode = 503;
            throw error;
        }

        const attestedImageTag = latestSuccessfulImageTag;
        if (explicitImageTag && explicitImageTag !== attestedImageTag) {
            const error = new Error(`Requested image tag ${explicitImageTag} does not match the selected successful build tag ${attestedImageTag || '(missing)'}.`);
            error.statusCode = 409;
            error.code = 'MANAGED_APP_BUILD_TAG_MISMATCH';
            throw error;
        }
        const imageTag = attestedImageTag;
        if (!imageTag) {
            throw buildManagedAppDeployBuildStateError(latestBuildRun);
        }
        const buildImageDigest = latestSuccessfulImageDigest;
        if (!buildImageDigest) {
            const error = new Error('Managed app deployment requires a canonical OCI sha256 digest attested by the successful build webhook. Mutable image tags are metadata only and cannot authorize deployment.');
            error.statusCode = 409;
            error.code = 'MANAGED_APP_BUILD_DIGEST_REQUIRED';
            throw error;
        }
        const normalizedNamespace = normalizeManagedAppNamespace(
            input.namespace || deployableApp.metadata?.desiredDeploy?.namespace || deployableApp.namespace,
            {
                slug: deployableApp.slug,
                namespacePrefix: managedAppsConfig.namespacePrefix || 'app-',
            },
        );

        if (normalizedNamespace !== normalizeText(deployableApp.namespace)) {
            deployableApp = this.normalizeAppRecord(await this.store.updateApp(app.id, app.ownerId, {
                namespace: normalizedNamespace,
                metadata: this.buildLifecycleMetadata(deployableApp, {
                    input,
                    phase: 'deploying',
                    desiredDeploy: {
                        namespace: normalizedNamespace,
                    },
                }),
            }) || {
                ...deployableApp,
                namespace: normalizedNamespace,
                metadata: this.buildLifecycleMetadata(deployableApp, {
                    input,
                    phase: 'deploying',
                    desiredDeploy: {
                        namespace: normalizedNamespace,
                    },
                }),
            });
        }

        const resolvedImageRepo = resolveManagedAppImageRepo(deployableApp, giteaConfig);
        if (!resolvedImageRepo) {
            const error = new Error('Managed app deployment requires a valid image repository from the configured GitLab registry host.');
            error.statusCode = 503;
            throw error;
        }

        if (resolvedImageRepo !== normalizeText(deployableApp.imageRepo)) {
            deployableApp = this.normalizeAppRecord(await this.store.updateApp(app.id, app.ownerId, {
                imageRepo: resolvedImageRepo,
                metadata: this.buildLifecycleMetadata(deployableApp, {
                    input,
                    phase: 'deploying',
                    desiredDeploy: {
                        imageRepo: resolvedImageRepo,
                    },
                }),
            }) || {
                ...deployableApp,
                imageRepo: resolvedImageRepo,
                metadata: this.buildLifecycleMetadata(deployableApp, {
                    input,
                    phase: 'deploying',
                    desiredDeploy: {
                        imageRepo: resolvedImageRepo,
                    },
                }),
            });
        }

        const requestedImage = buildManagedAppImageReference(resolvedImageRepo, imageTag);
        const image = `${resolvedImageRepo}@${buildImageDigest}`;
        await this.broadcastLifecycleEvent(deployableApp, latestBuildRun, 'deploying', {
            requestedImage,
            imageDigest: buildImageDigest,
            summary: buildManagedAppStatusSummary(deployableApp, latestBuildRun, 'deploying'),
            deployment: {
                image,
                requestedImage,
            },
        });

        let platformPreflight = null;
        if (typeof this.kubernetesClient.inspectManagedAppPlatform === 'function') {
            try {
                platformPreflight = await this.kubernetesClient.inspectManagedAppPlatform({
                    platformNamespace: managedAppsConfig.platformNamespace,
                    deploymentTarget,
                });
                this.recordRemoteServerContext(platformPreflight, {
                    objective: normalizeText(
                        input.sourcePrompt
                        || input.prompt
                        || deployableApp.metadata?.project?.currentObjective
                        || `Deploy managed app ${deployableApp.slug}`,
                    ),
                });
            } catch (error) {
                const preflightError = new Error(`Managed app deployment preflight failed before manifest apply: ${error.message}`);
                preflightError.statusCode = error.statusCode || 503;
                throw preflightError;
            }
        }

        const registryCredentials = await this.resolveRegistryCredentials(deployableApp);
        const rawDeployResult = await this.kubernetesClient.deployManagedApp({
            slug: deployableApp.slug,
            namespace: deployableApp.namespace,
            publicHost: deployableApp.metadata?.desiredDeploy?.publicHost || deployableApp.publicHost,
            image,
            containerPort: Number(input.containerPort || deployableApp.metadata?.desiredDeploy?.containerPort || deployableApp.metadata?.requestedContainerPort || managedAppsConfig.defaultContainerPort || 80),
            registryPullSecretName: deployableApp.metadata?.desiredDeploy?.registryPullSecretName || managedAppsConfig.registryPullSecretName,
            registryHost: registryCredentials.registryHost || giteaConfig.registryHost,
            registryUsername: registryCredentials.registryUsername,
            registryPassword: registryCredentials.registryPassword,
            platformNamespace: managedAppsConfig.platformNamespace,
            platformRuntimeSecretName: managedAppsConfig.platformRuntimeSecretName,
            deploymentTarget,
        });
        const deployResultWithPreflight = platformPreflight
            ? {
                ...rawDeployResult,
                preflight: {
                    platformNamespace: platformPreflight.platformNamespace,
                    executionHost: platformPreflight.executionHost,
                    healthy: isPlatformHealthy(platformPreflight),
                    runnerTokenState: normalizeText(platformPreflight.runnerTokenState),
                    serverContext: platformPreflight.serverContext || null,
                },
            }
            : rawDeployResult;
        const observedImageDigest = normalizeOciSha256Digest(
            deployResultWithPreflight.imageDigest
            || deployResultWithPreflight.imageEvidence?.observedDigest
            || deployResultWithPreflight.diagnostics?.imageDigest
            || deployResultWithPreflight.diagnostics?.podStatus?.imageID,
        );
        const observedDeploymentImage = normalizeText(
            deployResultWithPreflight.deploymentImage
            || deployResultWithPreflight.imageEvidence?.observedDeploymentImage
            || deployResultWithPreflight.imageEvidence?.deploymentImage
            || deployResultWithPreflight.diagnostics?.deploymentImage,
        );
        const observedPodImage = normalizeText(
            deployResultWithPreflight.podImage
            || deployResultWithPreflight.imageEvidence?.observedPodImage
            || deployResultWithPreflight.imageEvidence?.podImage
            || deployResultWithPreflight.diagnostics?.podStatus?.image,
        );
        const observedImageID = normalizeText(
            deployResultWithPreflight.podImageID
            || deployResultWithPreflight.imageEvidence?.observedImageID
            || deployResultWithPreflight.imageEvidence?.podImageID
            || deployResultWithPreflight.diagnostics?.podStatus?.imageID,
        );
        const pinnedImageDigest = extractOciSha256DigestFromImageRef(image);
        const expectedImageDigest = buildImageDigest;
        const publicHttpsVerified = deployResultWithPreflight.verification?.publicHttps === true
            || deployResultWithPreflight.https?.ok === true
            || deployResultWithPreflight.verification?.https === true;
        const expectedImageDigestMatches = !expectedImageDigest || observedImageDigest === expectedImageDigest;
        const imageDigestVerified = Boolean(
            deployResultWithPreflight.verification?.imageDigest === true
            && observedImageDigest
            && expectedImageDigestMatches,
        );
        let imageDigestError = normalizeText(
            deployResultWithPreflight.diagnostics?.imageDigestError
            || deployResultWithPreflight.imageEvidence?.error,
        );
        if (!observedImageDigest) {
            imageDigestError = imageDigestError || 'Kubernetes pod imageID did not contain an OCI sha256 digest.';
        } else if (!expectedImageDigestMatches) {
            imageDigestError = `Observed pod image digest ${observedImageDigest} does not match build-attested digest ${expectedImageDigest}.`;
        } else if (!imageDigestVerified) {
            imageDigestError = imageDigestError || 'Kubernetes did not verify the observed pod image digest.';
        }
        const imageEvidence = {
            ...(deployResultWithPreflight.imageEvidence || {}),
            requestedImage,
            deployedImage: image,
            deploymentImage: observedDeploymentImage,
            podImage: observedPodImage,
            podImageID: observedImageID,
            observedDeploymentImage,
            observedPodImage,
            observedImageID,
            expectedDigest: expectedImageDigest,
            expectedDigestSource: 'build_run',
            buildDigest: buildImageDigest,
            observedDigest: observedImageDigest,
            observedImageDigest,
            digestPinnedRequest: Boolean(extractOciSha256DigestFromImageRef(requestedImage)),
            digestPinnedDeployment: Boolean(pinnedImageDigest),
            matchesBuildDigest: buildImageDigest ? observedImageDigest === buildImageDigest : null,
            matchesExpectedDigest: expectedImageDigest ? expectedImageDigestMatches : null,
            verified: imageDigestVerified,
            error: imageDigestError,
        };
        const deployResult = {
            ...deployResultWithPreflight,
            imageDigest: buildImageDigest,
            buildImageDigest,
            observedImageDigest,
            requestedImage,
            deployedImage: image,
            deploymentImage: observedDeploymentImage,
            podImage: observedPodImage,
            podImageID: observedImageID,
            imageEvidence,
            verification: {
                ...(deployResultWithPreflight.verification || {}),
                imageDigest: imageDigestVerified,
                publicHttps: publicHttpsVerified,
                https: publicHttpsVerified && imageDigestVerified,
            },
            diagnostics: {
                ...(deployResultWithPreflight.diagnostics || {}),
                imageDigest: observedImageDigest,
                buildImageDigest,
                observedImageDigest,
                imageDigestError,
                imageEvidence,
            },
        };

        const deployDiagnostics = getManagedAppDeployDiagnostics(deployableApp, deployResult);
        const lifecyclePhase = deployResult.verification.https
            ? 'live'
            : (deployDiagnostics.shouldFailClosed
                ? 'deploy_failed'
                : (deployResult.verification.tls ? 'tls_ready' : (deployResult.rollout.ok ? 'pending_https' : 'deploy_failed')));
        const verificationStatus = deployResult.verification.https
            ? 'live'
            : (lifecyclePhase === 'deploy_failed'
                ? 'failed'
                : (deployResult.verification.tls ? 'tls_ready' : 'pending_https'));
        const appStatus = deployResult.verification.https
            ? 'live'
            : (lifecyclePhase === 'deploy_failed'
                ? 'deploy_failed'
                : (deployResult.verification.rollout ? 'deployed' : 'deploy_failed'));
        const lastError = normalizeText(
            deployDiagnostics.failureReason
            || deployResult.rollout?.error
            || deployResult.https?.error
            || '',
        );
        const projectNextStep = lifecyclePhase === 'live'
            ? ''
            : normalizeText(
                deployDiagnostics.nextStep
                || deriveNextStepForLifecycle(lifecyclePhase, {
                    deployRequested: true,
                    diagnostics: deployDiagnostics,
                }),
            );
        const projectOpenItems = lifecyclePhase === 'live'
            ? []
            : normalizeStringArray(
                deployDiagnostics.openItems?.length
                    ? deployDiagnostics.openItems
                    : deriveOpenItemsForLifecycle(lifecyclePhase, {
                        deployRequested: true,
                        error: lastError,
                        diagnostics: deployDiagnostics,
                    }),
                8,
            );

        const updatedApp = this.normalizeAppRecord(await this.store.updateApp(app.id, app.ownerId, {
            namespace: normalizedNamespace,
            status: appStatus,
            metadata: this.buildLifecycleMetadata(deployableApp, {
                input,
                buildRun: latestBuildRun,
                phase: lifecyclePhase,
                desiredDeploy: {
                    deploymentTarget,
                    namespace: normalizedNamespace,
                    publicHost: deployableApp.publicHost,
                    imageRepo: resolvedImageRepo,
                    defaultBranch: deployableApp.defaultBranch,
                    containerPort: Number(input.containerPort || deployableApp.metadata?.desiredDeploy?.containerPort || managedAppsConfig.defaultContainerPort || 80),
                    ingressClassName: deployConfig.ingressClassName,
                    tlsClusterIssuer: deployConfig.tlsClusterIssuer,
                    registryPullSecretName: managedAppsConfig.registryPullSecretName,
                },
                liveDeploy: {
                    lastImage: requestedImage,
                    requestedImage,
                    deployedImage: image,
                    buildImageDigest,
                    observedDeploymentImage,
                    observedPodImage,
                    observedImageID,
                    observedImageDigest,
                    imageDigest: buildImageDigest,
                    rollout: deployResult.verification?.rollout === true,
                    ingress: deployResult.verification?.ingress === true,
                    tls: deployResult.verification?.tls === true,
                    https: deployResult.verification?.https === true,
                    lastVerifiedAt: new Date().toISOString(),
                    lastError,
                    lastDeployResult: deployResult,
                },
                project: {
                    nextStep: projectNextStep,
                    openItems: projectOpenItems,
                },
            }),
        }));

        let buildRun = latestBuildRun;
        if (buildRun) {
            buildRun = await this.store.updateBuildRun(buildRun.id, {
                buildStatus: buildRun.buildStatus || 'success',
                deployRequested: true,
                deployStatus: lifecyclePhase === 'live'
                    ? 'succeeded'
                    : (lifecyclePhase === 'deploy_failed'
                        ? 'failed'
                        : 'pending_verification'),
                verificationStatus,
                metadata: {
                    ...(buildRun.metadata || {}),
                    deployment: deployResult,
                },
                error: lifecyclePhase === 'deploy_failed'
                    ? { message: lastError || 'Deployment failed.' }
                    : {},
                finishedAt: new Date().toISOString(),
            });
        }

        this.recordClusterDeployment(updatedApp, {
            image,
            requestedImage,
            imageDigest: buildImageDigest,
            observedImageDigest,
            deployStatus: buildRun?.deployStatus || 'succeeded',
            verificationStatus,
            deployment: deployResult,
            error: lastError ? { message: lastError } : null,
        });
        await this.broadcastLifecycleEvent(updatedApp, buildRun, lifecyclePhase, {
            requestedImage,
            imageDigest: buildImageDigest,
            observedImageDigest,
            deployment: {
                ...deployResult,
                image,
                requestedImage,
            },
            nextStep: projectNextStep,
            openItems: projectOpenItems,
            summary: buildManagedAppStatusSummary(updatedApp, buildRun, lifecyclePhase, {
                ...deployResult,
                image,
            }),
        });

        return {
            app: updatedApp,
            buildRun,
            deployment: deployResult,
            desiredDeploy: updatedApp.metadata?.desiredDeploy || null,
            liveDeploy: updatedApp.metadata?.liveDeploy || null,
            message: buildManagedAppStatusSummary(updatedApp, buildRun, lifecyclePhase, {
                ...deployResult,
                image,
            }),
        };
    }

    async handleBuildEvent(payload = {}) {
        await this.store.ensureAvailable();
        const suppliedRepoOwner = normalizeText(payload.repoOwner || payload.owner);
        const suppliedRepoName = normalizeText(payload.repoName || payload.repository);
        const repositoryCoordinatesSupplied = Boolean(suppliedRepoOwner || suppliedRepoName);
        let repoOwner = normalizeText(suppliedRepoOwner || this.getEffectiveGiteaConfig().org);
        let repoName = normalizeText(suppliedRepoName || payload.slug);
        const slug = normalizeText(payload.slug || repoName);
        const commitSha = normalizeText(payload.commitSha || payload.sha);
        const imageTag = normalizeText(payload.imageTag || buildImageTagFromCommit(commitSha));
        const imageDigest = normalizeOciSha256Digest(payload.imageDigest || payload.image_digest || payload.digest)
            || extractOciSha256DigestFromImageRef(payload.imageDigest || payload.image_digest || payload.digest);
        const buildStatus = normalizeBuildStatus(payload.buildStatus || payload.status);
        const payloadDeployRequested = payload.deployRequested === true
            || inferDeployRequested(payload.requestedAction || payload.action);
        const giteaConfig = this.getEffectiveGiteaConfig();
        let app = null;
        if (repositoryCoordinatesSupplied && repoOwner && repoName) {
            app = this.normalizeAppRecord(await this.store.getAppByRepo(repoOwner, repoName));
        }
        if (!repositoryCoordinatesSupplied && slug) {
            app = this.normalizeAppRecord(await this.store.getAppBySlug(slug));
        }
        if (!app) {
            const error = new Error(`Managed app not found for ${repoOwner || '(unknown-owner)'}/${repoName || slug}.`);
            error.statusCode = 404;
            throw error;
        }
        if (repositoryCoordinatesSupplied
            && (normalizeText(app.repoOwner) !== repoOwner || normalizeText(app.repoName) !== repoName)) {
            const error = new Error('Managed app build webhook repository identity does not match the persisted app repository.');
            error.statusCode = 409;
            error.code = 'MANAGED_APP_REPOSITORY_IDENTITY_MISMATCH';
            throw error;
        }
        if (!repositoryCoordinatesSupplied) {
            repoOwner = normalizeText(app.repoOwner || repoOwner);
            repoName = normalizeText(app.repoName || repoName || slug);
        }
        if (buildStatus === 'success' && !isValidGitCommitSha(commitSha)) {
            const error = new Error('Successful managed-app build events must include a valid hexadecimal commitSha built by the pipeline.');
            error.statusCode = 400;
            error.code = 'MANAGED_APP_BUILD_COMMIT_REQUIRED';
            throw error;
        }
        if (buildStatus === 'success' && !imageDigest) {
            const error = new Error('Successful managed-app build events must include a canonical OCI sha256 imageDigest from the pipeline metadata.');
            error.statusCode = 400;
            error.code = 'MANAGED_APP_BUILD_DIGEST_REQUIRED';
            throw error;
        }
        const imageRepo = resolveManagedAppImageRepo({
            ...app,
            imageRepo: app.imageRepo,
            repoOwner: app.repoOwner || repoOwner,
            repoName: app.repoName || repoName,
            slug: slug || app.slug,
        }, giteaConfig);
        const reportedImageRepo = normalizeImageRepo(payload.imageRepo);
        if (reportedImageRepo && reportedImageRepo !== imageRepo) {
            const error = new Error(`Managed app build webhook image repository ${reportedImageRepo} does not match canonical repository ${imageRepo || '(missing)'}.`);
            error.statusCode = 409;
            error.code = 'MANAGED_APP_IMAGE_REPOSITORY_MISMATCH';
            throw error;
        }

        const reportedRunId = normalizeText(payload.runId);
        let buildRun = reportedRunId
            ? await this.store.getBuildRunByExternalRunId(reportedRunId)
            : null;
        if (!buildRun && commitSha) {
            buildRun = await this.store.getBuildRunByCommitSha(app.id, commitSha);
        }
        if (buildRun) {
            const existingDigest = normalizeOciSha256Digest(buildRun.imageDigest);
            const buildIdentityMismatch = normalizeText(buildRun.appId) !== normalizeText(app.id)
                || normalizeText(buildRun.ownerId) !== normalizeText(app.ownerId)
                || normalizeText(buildRun.commitSha) !== commitSha
                || (reportedRunId && normalizeText(buildRun.externalRunId)
                    && normalizeText(buildRun.externalRunId) !== reportedRunId)
                || (existingDigest && imageDigest && existingDigest !== imageDigest);
            if (buildIdentityMismatch) {
                const error = new Error('Managed-app build webhook identity conflicts with the persisted app, owner, commit, or image digest.');
                error.statusCode = 409;
                error.code = 'MANAGED_APP_BUILD_IDENTITY_MISMATCH';
                throw error;
            }
        }
        if (buildStatus === 'success' && payloadDeployRequested && !buildRun) {
            const error = new Error('Deploying a successful managed-app build requires a pre-existing app-owned KimiBuilt build run with the exact commit identity.');
            error.statusCode = 409;
            error.code = 'MANAGED_APP_DEPLOY_BUILD_RUN_REQUIRED';
            throw error;
        }
        if (buildStatus === 'success' && buildRun && (payloadDeployRequested || buildRun.deployRequested === true)) {
            if (!isKimiBuiltInitiatedBuildRun(buildRun)) {
                const error = new Error('Managed-app deployment requires a build run initiated by the KimiBuilt control plane.');
                error.statusCode = 409;
                error.code = 'MANAGED_APP_DEPLOY_BUILD_RUN_UNTRUSTED';
                throw error;
            }
            if (payloadDeployRequested && buildRun.deployRequested !== true) {
                const error = new Error('The persisted KimiBuilt build run was not authorized for deployment.');
                error.statusCode = 409;
                error.code = 'MANAGED_APP_DEPLOY_NOT_REQUESTED';
                throw error;
            }
        }
        if (!buildRun) {
            buildRun = await this.store.createBuildRun({
                appId: app.id,
                ownerId: app.ownerId,
                sessionId: app.sessionId,
                source: 'gitlab-webhook',
                requestedAction: payloadDeployRequested ? 'deploy' : 'build',
                commitSha,
                imageTag,
                imageDigest,
                buildStatus,
                deployRequested: false,
                deployStatus: 'not_requested',
                verificationStatus: 'pending',
                externalRunId: normalizeText(payload.runId) || null,
                externalRunUrl: normalizeText(payload.runUrl || ''),
                startedAt: payload.startedAt || null,
                finishedAt: payload.finishedAt || new Date().toISOString(),
                metadata: {
                    payload,
                },
            });
        } else {
            buildRun = await this.store.updateBuildRun(buildRun.id, {
                buildStatus,
                imageTag: imageTag || buildRun.imageTag,
                imageDigest: imageDigest || buildRun.imageDigest,
                externalRunId: normalizeText(payload.runId) || buildRun.externalRunId,
                externalRunUrl: normalizeText(payload.runUrl || buildRun.externalRunUrl),
                metadata: {
                    ...(buildRun.metadata || {}),
                    payload,
                },
                finishedAt: payload.finishedAt || new Date().toISOString(),
                error: buildStatus === 'success' ? {} : { message: normalizeText(payload.error || payload.message || 'Build failed.') },
            });
        }

        const repoIdentityPatch = {
            ...(repoOwner ? { repoOwner } : {}),
            ...(repoName ? { repoName } : {}),
        };

        if (buildStatus !== 'success') {
            const updatedApp = this.normalizeAppRecord(await this.store.updateApp(app.id, app.ownerId, {
                ...repoIdentityPatch,
                status: 'build_failed',
                metadata: {
                    ...this.buildLifecycleMetadata(app, {
                        input: payload,
                        buildRun,
                        phase: 'build_failed',
                        repoState: {
                            lastCommitSha: commitSha || app.metadata?.repoState?.lastCommitSha,
                            lastBuildRunId: buildRun.id,
                        },
                        liveDeploy: {
                            lastError: normalizeText(payload.error || payload.message || buildRun.error?.message || 'Build failed.'),
                        },
                    }),
                    lastFailedBuild: buildRun,
                },
            }));
            await this.broadcastLifecycleEvent(updatedApp, buildRun, 'build_failed');
            return {
                app: updatedApp,
                buildRun,
                deployed: false,
            };
        }

        const updatedApp = this.normalizeAppRecord(await this.store.updateApp(app.id, app.ownerId, {
            ...repoIdentityPatch,
            ...(imageRepo ? { imageRepo } : {}),
            status: buildRun.deployRequested ? 'deploying' : 'built',
            metadata: {
                ...this.buildLifecycleMetadata(app, {
                    input: payload,
                    buildRun,
                    phase: 'built',
                    repoState: {
                        initialized: true,
                        lastCommitSha: commitSha || app.metadata?.repoState?.lastCommitSha,
                        lastCommitAt: new Date().toISOString(),
                        lastBuildRunId: buildRun.id,
                    },
                    desiredDeploy: {
                        imageRepo: imageRepo || app.metadata?.desiredDeploy?.imageRepo,
                    },
                    liveDeploy: {
                        lastError: '',
                    },
                    project: {
                        nextStep: buildRun.deployRequested
                            ? 'Wait for deployment rollout and HTTPS verification to finish.'
                            : deriveNextStepForLifecycle('built'),
                    },
                }),
                lastSuccessfulBuild: {
                    commitSha,
                    imageTag,
                    ...(normalizeOciSha256Digest(buildRun.imageDigest) ? { imageDigest: normalizeOciSha256Digest(buildRun.imageDigest) } : {}),
                    ...(imageRepo ? { imageRepo } : {}),
                    ...(normalizeText(payload.platforms) ? { platforms: normalizeText(payload.platforms) } : {}),
                },
            },
        }));

        if (buildRun.deployRequested) {
            const deployed = await this.deployApp(updatedApp.id, {
                buildRunId: buildRun.id,
                commitSha: buildRun.commitSha,
                imageDigest: buildRun.imageDigest,
            }, updatedApp.ownerId, {
                sessionId: updatedApp.sessionId,
            });
            return {
                app: deployed.app,
                buildRun: deployed.buildRun,
                deployed: true,
                deployment: deployed.deployment,
            };
        }

        await this.broadcastLifecycleEvent(updatedApp, buildRun, 'built');
        return {
            app: updatedApp,
            buildRun,
            deployed: false,
        };
    }

    recordClusterDeployment(app = {}, details = {}) {
        const normalizedApp = this.normalizeAppRecord(app);
        const state = clusterStateRegistry.getState();
        const desiredDeploy = normalizedApp?.metadata?.desiredDeploy || {};
        const deploymentDetails = details.deployment && typeof details.deployment === 'object'
            ? details.deployment
            : {};
        const entry = clusterStateRegistry.ensureDeploymentEntry(state, {
            namespace: normalizedApp.namespace,
            deployment: normalizedApp.slug,
            publicDomain: normalizedApp.publicHost,
            repositoryUrl: normalizedApp.repoUrl,
            ref: normalizedApp.defaultBranch,
            ingressClassName: desiredDeploy.ingressClassName,
            tlsClusterIssuer: desiredDeploy.tlsClusterIssuer,
        });

        if (!entry) {
            return;
        }

        entry.lastTool = 'managed-app';
        entry.lastAction = 'deploy';
        entry.lastActionAt = new Date().toISOString();
        entry.lastStatus = normalizeText(details.deployStatus || 'succeeded').toLowerCase();
        entry.lastSuccessAt = new Date().toISOString();
        entry.lastError = normalizeText(details.error?.message || '');
        entry.lastStdout = normalizeText(details.image || '');
        entry.lastObjective = normalizeText(normalizedApp.metadata?.project?.currentObjective || normalizedApp.sourcePrompt || `Managed app ${normalizedApp.slug}`);
        entry.verification.rollout = deploymentDetails?.verification?.rollout === true;
        entry.verification.ingress = deploymentDetails?.verification?.ingress === true;
        entry.verification.tls = deploymentDetails?.verification?.tls === true;
        entry.verification.https = deploymentDetails?.verification?.https === true;
        entry.verification.lastVerifiedAt = new Date().toISOString();
        if (entry.verification.rollout) {
            entry.verification.lastRolloutAt = new Date().toISOString();
        }
        this.recordRemoteServerContext({
            executionHost: normalizeText(deploymentDetails.executionHost || deploymentDetails.preflight?.executionHost || ''),
            platformNamespace: normalizeText(deploymentDetails.preflight?.platformNamespace || ''),
            serverContext: deploymentDetails.preflight?.serverContext || null,
        }, {
            objective: entry.lastObjective,
        });

        clusterStateRegistry.recordActivity(state, {
            toolId: 'managed-app',
            action: 'deploy',
            status: entry.lastStatus,
            namespace: normalizedApp.namespace,
            deployment: normalizedApp.slug,
            publicDomain: normalizedApp.publicHost,
            summary: `managed-app deploy ${entry.lastStatus} for ${normalizedApp.namespace}/${normalizedApp.slug}${normalizedApp.publicHost ? ` on ${normalizedApp.publicHost}` : ''}.`,
            error: entry.lastError,
        });
        clusterStateRegistry.saveState();
    }

    async persistLifecycleProjectMemory(app = null, buildRun = null, phase = '', details = {}) {
        if (!app?.sessionId || !this.sessionStore?.update || (!this.sessionStore?.get && !this.sessionStore?.getOwned)) {
            return null;
        }

        const normalizedApp = this.normalizeAppRecord(app);
        const summary = normalizeText(details.summary || buildManagedAppStatusSummary(normalizedApp, buildRun, phase, details.deployment || null));
        if (!summary) {
            return null;
        }

        try {
            const session = normalizedApp.ownerId && this.sessionStore.getOwned
                ? await this.sessionStore.getOwned(normalizedApp.sessionId, normalizedApp.ownerId)
                : await this.sessionStore.get(normalizedApp.sessionId);
            if (!session) {
                return null;
            }

            const assistantText = [
                summary,
                normalizeText(normalizedApp.repoUrl),
                normalizedApp.publicHost ? `https://${normalizedApp.publicHost}` : '',
                normalizeText(buildRun?.externalRunUrl || ''),
            ].filter(Boolean).join('\n');
            const projectMemory = mergeProjectMemory(
                session?.metadata?.projectMemory || {},
                buildProjectMemoryUpdate({
                    userText: normalizeText(normalizedApp.metadata?.project?.lastUserIntent || normalizedApp.sourcePrompt || ''),
                    assistantText,
                    toolEvents: [],
                    artifacts: [],
                }),
            );

            return this.sessionStore.update(normalizedApp.sessionId, {
                metadata: {
                    projectMemory,
                },
            });
        } catch (error) {
            console.warn(`[ManagedApp] Failed to persist lifecycle project memory for ${normalizedApp.slug || normalizedApp.id || 'managed-app'}: ${error.message}`);
            return null;
        }
    }

    async persistLifecycleSessionProject(app = null, buildRun = null, phase = '', details = {}) {
        if (!app?.sessionId || !this.sessionStore?.update || (!this.sessionStore?.get && !this.sessionStore?.getOwned)) {
            return null;
        }

        const normalizedApp = this.normalizeAppRecord(app);
        const summary = normalizeText(details.summary || buildManagedAppStatusSummary(normalizedApp, buildRun, phase, details.deployment || null));
        if (!summary) {
            return null;
        }

        try {
            const session = normalizedApp.ownerId && this.sessionStore.getOwned
                ? await this.sessionStore.getOwned(normalizedApp.sessionId, normalizedApp.ownerId)
                : await this.sessionStore.get(normalizedApp.sessionId);
            if (!session) {
                return null;
            }

            const currentMetadata = session?.metadata && typeof session.metadata === 'object'
                ? session.metadata
                : {};
            const previousProjectTitle = normalizeText(currentMetadata?.activeProject?.title);
            const activeProject = preserveManagedProjectViewportState(
                buildManagedProjectState(normalizedApp, buildRun, phase, {
                    ...details,
                    summary,
                }),
                currentMetadata?.activeProject,
            );
            const metadataPatch = {
                activeProject,
            };

            if (shouldPromoteManagedProjectTitle(currentMetadata?.title, previousProjectTitle)) {
                metadataPatch.title = activeProject.title;
            }

            return this.sessionStore.update(normalizedApp.sessionId, {
                metadata: metadataPatch,
            });
        } catch (error) {
            console.warn(`[ManagedApp] Failed to persist lifecycle session project for ${normalizedApp.slug || normalizedApp.id || 'managed-app'}: ${error.message}`);
            return null;
        }
    }

    async persistLifecycleMessage(app = null, buildRun = null, phase = '', details = {}) {
        if (!app?.sessionId || !this.sessionStore?.upsertMessage) {
            return null;
        }

        const summary = normalizeText(details.summary || buildManagedAppStatusSummary(app, buildRun, phase, details.deployment || null));
        if (!summary) {
            return null;
        }
        const progressState = buildManagedAppProgressState(app, buildRun, phase, {
            ...details,
            summary,
        });

        try {
            return await this.sessionStore.upsertMessage(app.sessionId, {
                id: buildLifecycleMessageKey(app, buildRun, phase),
                role: 'assistant',
                content: summary,
                timestamp: new Date().toISOString(),
                metadata: {
                    managedAppLifecycle: true,
                    managedAppPhase: normalizeText(phase).toLowerCase() || 'updated',
                    managedAppId: normalizeText(app?.id),
                    managedAppSlug: normalizeText(app?.slug),
                    buildRunId: normalizeText(buildRun?.id),
                    publicHost: normalizeText(app?.publicHost),
                    managedAppProgressState: progressState,
                    ...(details.deployment ? { deployment: details.deployment } : {}),
                },
            });
        } catch (error) {
            console.warn(`[ManagedApp] Failed to persist lifecycle message for ${app.slug || app.id || 'managed-app'}: ${error.message}`);
            return null;
        }
    }

    async broadcastLifecycleEvent(app = null, buildRun = null, phase = '', details = {}) {
        const summary = normalizeText(details.summary || buildManagedAppStatusSummary(app, buildRun, phase, details.deployment || null));
        const progressState = buildManagedAppProgressState(app, buildRun, phase, {
            ...details,
            summary,
        });
        await this.persistLifecycleMessage(app, buildRun, phase, {
            ...details,
            summary,
        });
        await this.persistLifecycleSessionProject(app, buildRun, phase, {
            ...details,
            summary,
        });
        await this.persistLifecycleProjectMemory(app, buildRun, phase, {
            ...details,
            summary,
        });
        const payload = {
            type: 'managed-app',
            phase,
            app,
            buildRun,
            summary,
            progressState,
            ...(details.deployment ? { deployment: details.deployment } : {}),
        };
        broadcastToAdmins(payload);
        if (app?.sessionId) {
            broadcastToSession(app.sessionId, payload);
        }
    }

    buildPromptSummary({ ownerId = null, maxApps = 4 } = {}) {
        if (!this.isAvailable() || !ownerId) {
            return '';
        }

        const lines = [];
        return Promise.resolve(this.store.listApps(ownerId, maxApps))
            .then((apps) => {
                const normalizedApps = this.normalizeAppList(apps);
                if (!Array.isArray(normalizedApps) || normalizedApps.length === 0) {
                    return 'Managed app catalog: no managed apps exist yet for this user. If they ask to create, build, or deploy a new managed app, create the first one directly instead of asking them to choose an existing app.';
                }
                normalizedApps.slice(0, Math.max(1, maxApps)).forEach((app) => {
                    const summary = normalizeText(app.metadata?.project?.summary);
                    const nextStep = normalizeText(app.metadata?.project?.nextStep);
                    lines.push(`Managed app ${app.slug}: status ${app.status}, target ${normalizeDeployTarget(app.metadata?.desiredDeploy?.deploymentTarget) || 'ssh'}, repo ${app.repoOwner}/${app.repoName}, host ${app.publicHost}, namespace ${app.namespace}.${summary ? ` Summary: ${summary}` : ''}${nextStep ? ` Next: ${nextStep}` : ''}`);
                });
                return lines.join('\n');
            })
            .catch(() => '');
    }

    async getRuntimeSummary(ownerId = null) {
        const giteaConfig = this.getEffectiveGiteaConfig();
        const managedAppsConfig = this.getEffectiveManagedAppsConfig();
        const apps = ownerId && this.isAvailable()
            ? this.normalizeAppList(await this.store.listApps(ownerId, 10))
            : [];
        return {
            configured: this.giteaClient.isConfigured(),
            persistenceAvailable: this.isAvailable(),
            kubernetesConfigured: this.kubernetesClient.isConfigured(),
            gitlab: {
                baseURL: giteaConfig.baseURL,
                org: giteaConfig.org,
                registryHost: giteaConfig.registryHost,
            },
            defaults: {
                appBaseDomain: managedAppsConfig.appBaseDomain,
                namespacePrefix: managedAppsConfig.namespacePrefix,
                platformNamespace: managedAppsConfig.platformNamespace,
                defaultBranch: managedAppsConfig.defaultBranch,
            },
            appCount: apps.length,
            apps,
        };
    }
}

module.exports = {
    ManagedAppService,
};

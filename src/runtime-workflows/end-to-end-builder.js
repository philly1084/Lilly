const { config } = require('../config');
const { getSessionControlState } = require('../runtime-control-state');

const END_TO_END_WORKFLOW_KIND = 'end-to-end-builder';
const ACTIVE_WORKFLOW_STATUS = 'active';
const COMPLETED_WORKFLOW_STATUS = 'completed';
const BLOCKED_WORKFLOW_STATUS = 'blocked';
const VALID_LANES = new Set([
    'repo-only',
    'deploy-only',
    'repo-then-deploy',
    'inspect-only',
]);
const VALID_DELIVERY_MODES = new Set([
    'gitops',
    'remote-workspace',
]);
const VALID_STAGES = new Set([
    'planned',
    'implementing',
    'saving',
    'deploying',
    'verifying',
    'completed',
    'blocked',
]);
const VALID_TASK_STATUSES = new Set([
    'planned',
    'in_progress',
    'blocked',
    'completed',
    'skipped',
]);
const REMOTE_WORKSPACE_DEPLOY_TIMEOUT_MS = 600000;
const REMOTE_VERIFICATION_TIMEOUT_MS = 240000;

function normalizeText(value = '') {
    return String(value || '').trim();
}

function normalizeLowerText(value = '') {
    return normalizeText(value).toLowerCase();
}

function truncateText(value = '', limit = 96) {
    const normalized = normalizeText(value);
    if (!normalized || normalized.length <= limit) {
        return normalized;
    }

    return `${normalized.slice(0, limit - 1).trim()}…`;
}

function extractRepositoryNameFromUrl(url = '') {
    const normalized = normalizeText(url);
    if (!normalized) {
        return '';
    }

    const match = normalized.match(/[:/]([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i);
    return match?.[2] ? normalizeLowerText(match[2]) : '';
}

function isEndToEndBuilderWorkflow(value = null) {
    return Boolean(value)
        && typeof value === 'object'
        && value.kind === END_TO_END_WORKFLOW_KIND
        && VALID_LANES.has(String(value.lane || '').trim());
}

function hasContinuationIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /^(continue|keep going|go ahead|next step|next steps|finish|resume|proceed)\b/,
        /^(do it|do that|ship it|deploy it|verify it|push it)\b/,
        /\b(obvious next step|obvious next steps|from there|from this point)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasStructuredCheckpointResponse(text = '') {
    const normalized = normalizeText(text);
    if (!normalized) {
        return false;
    }

    return /^Survey response \([^)]+\):\s*[\s\S]+$/i.test(normalized);
}

function hasLikelyDecisionReplyIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /^(yes|yeah|yep|no|nope|not yet|skip|continue|resume|go ahead|proceed)\b/,
        /^\d{4}-\d{2}-\d{2}\b/,
        /^(today|tomorrow|tonight|later|later today|this (?:morning|afternoon|evening)|next (?:week|month|sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/,
        /^(?:in|after)\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)(?:\s+from\s+now)?\b/,
        /^(?:1[0-2]|0?\d)(?::[0-5]\d)?\s*(?:am|pm)\b/,
        /^(?:[01]?\d|2[0-3]):[0-5]\d\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasDiscoveryPlanningIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(questionnaire|questionnaires|survey|surveys|intake|discovery questions?|discovery session)\b/,
        /\b(ask me (?:a few|some|a couple of)? questions?|provide (?:some|a couple of)? questions?|start with (?:questions?|a questionnaire|questionnaires))\b/,
        /\b(figure out|work out|narrow down|brainstorm|explore|talk through|discuss|decide|choose|direction|options?)\b[\s\S]{0,40}\b(what to work on|what we should work on|what to build|what we should build|what to make|scope|approach)\b/,
        /\b(before|first)\b[\s\S]{0,30}\b(questionnaire|questions?|research|planning|brainstorm|options?)\b/,
        /\blet'?s start with\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasRepoImplementationIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized || hasDiscoveryPlanningIntent(normalized)) {
        return false;
    }

    if (hasExplicitRemoteCliAgentIntent(normalized)) {
        return false;
    }

    const repoContext = /\b(repo|repository|code|codebase|workspace|project|app|application|frontend|backend|service|component|site|website|web app|web page|webpage|dashboard|visualization|visualisation|viewer|map|globe|world|ui)\b/.test(normalized)
        || /\b(remote|server|host)\b[\s\S]{0,40}\b(cli tool|remote cli|assisted cli|coding agent|code agent)\b/.test(normalized)
        || /\b(cli tool|remote cli|assisted cli|coding agent|code agent)\b[\s\S]{0,40}\b(remote|server|host)\b/.test(normalized);
    const changeIntent = /\b(fix|implement|build|create|generate|make|update|change|refactor|add|remove|edit|patch|write|test|compile|ship)\b/.test(normalized);

    return repoContext && changeIntent;
}

function hasExplicitRemoteCliAgentIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(remote cli agent|remote coding agent|remote code run|remote_code_run|agents sdk remote cli)\b/.test(normalized);
}

function hasGitSaveIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(git|github)\b[\s\S]{0,80}\b(commit|push|save and push|save-and-push|stage)\b/.test(normalized)
        || /\b(commit|push|save and push|save-and-push)\b[\s\S]{0,40}\b(github|git)\b/.test(normalized);
}

function hasDeployIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    const documentationIntent = /\b(docs?|documentation|tool help|how to use)\b/.test(normalized);
    const inspectionOnlyVerb = /\b(inspect|check|show|status|health|verify|logs?|diagnose|debug|look at)\b/.test(normalized);
    const deployAction = /\b(deploy|redeploy|rollout|release|publish|ship live|put live|push live|apply|sync)\b/.test(normalized)
        || /\b(sync and apply|sync-and-apply|apply manifests|rollout status)\b/.test(normalized)
        || /\b(add|install|put)\b[\s\S]{0,40}\b(to|on|into|in)\b[\s\S]{0,20}\b(k3s|k8s|kubernetes|cluster)\b/.test(normalized);
    const deployArtifact = /\b(git|github|branch|image|manifest|manifests|helm|repo|repository|tag|release|latest|k3s|k8s|kubernetes|cluster|ingress|route|routing|dns|domain|traefik|tls)\b/.test(normalized);
    const infrastructureDeployIntent = /\b(traefik|ingress|acme|let'?s encrypt|cert-manager|tls|certificate)\b/.test(normalized)
        && (
            /\b(k3s|k8s|kubernetes|cluster|server|host|deploy|live|production)\b/.test(normalized)
            || /\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/.test(normalized)
        );
    if (documentationIntent) {
        return false;
    }

    return [
        deployAction && deployArtifact,
        /\b(sync and apply|sync-and-apply|apply manifests|rollout status)\b/.test(normalized),
        /\b(add|install|put)\b[\s\S]{0,40}\b(to|on|into|in)\b[\s\S]{0,20}\b(k3s|k8s|kubernetes|cluster)\b/.test(normalized),
        infrastructureDeployIntent && !inspectionOnlyVerb,
    ].some(Boolean);
}

function hasInspectOnlyIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    const remoteContext = /\b(remote|server|host|cluster|k3s|k8s|kubernetes|kubectl|deployment|service|ingress|pod|logs?)\b/.test(normalized);
    const inspectIntent = /\b(check|inspect|look at|show|status|health|verify|logs?|diagnose|debug)\b/.test(normalized);
    return remoteContext && inspectIntent && !hasRepoImplementationIntent(normalized) && !hasDeployIntent(normalized);
}

function inferWorkflowLane(objective = '') {
    const normalized = normalizeText(objective);
    if (!normalized) {
        return null;
    }

    if (hasDiscoveryPlanningIntent(normalized)) {
        return null;
    }

    if (hasExplicitRemoteCliAgentIntent(normalized)) {
        return null;
    }

    const repoImplementationIntent = hasRepoImplementationIntent(normalized);
    const deployIntent = hasDeployIntent(normalized);
    const inspectOnlyIntent = hasInspectOnlyIntent(normalized);

    if (repoImplementationIntent && deployIntent) {
        return 'repo-then-deploy';
    }

    if (repoImplementationIntent) {
        return 'repo-only';
    }

    if (deployIntent || hasGitSaveIntent(normalized)) {
        return 'deploy-only';
    }

    return null;
}

function buildWorkflowTaskTemplates({ lane = '', deliveryMode = 'gitops', requiresVerification = true } = {}) {
    switch (lane) {
    case 'repo-only':
        return [
            {
                id: 'implement-repository',
                title: 'Implement repository changes',
            },
        ];
    case 'deploy-only':
        return [
            {
                id: 'deploy-release',
                title: 'Deploy requested release',
            },
            ...(requiresVerification
                ? [{
                    id: 'verify-release',
                    title: 'Verify deployed result',
                }]
                : []),
        ];
    case 'repo-then-deploy':
        if (deliveryMode === 'remote-workspace') {
            return [
                {
                    id: 'implement-repository',
                    title: 'Implement repository changes',
                },
                {
                    id: 'build-and-deploy-remote-workspace',
                    title: 'Build and deploy remote workspace',
                },
                ...(requiresVerification
                    ? [{
                        id: 'verify-release',
                        title: 'Verify deployed result',
                    }]
                    : []),
            ];
        }

        return [
            {
                id: 'implement-repository',
                title: 'Implement repository changes',
            },
            {
                id: 'save-and-push-repository',
                title: 'Inspect, save, and push repository changes',
            },
        ];
    case 'inspect-only':
        return [
            {
                id: 'inspect-remote-state',
                title: 'Inspect remote state',
            },
        ];
    default:
        return [];
    }
}

function resolveTaskStatus({ completed = false, active = false, blocked = false, skipped = false } = {}) {
    if (completed) {
        return 'completed';
    }

    if (skipped) {
        return 'skipped';
    }

    if (blocked) {
        return 'blocked';
    }

    return active ? 'in_progress' : 'planned';
}

function buildWorkflowTaskList(workflow = null) {
    const currentWorkflow = workflow && typeof workflow === 'object' ? workflow : {};
    const blocked = currentWorkflow.status === BLOCKED_WORKFLOW_STATUS;
    const stage = normalizeText(currentWorkflow.stage).toLowerCase();
    const templates = buildWorkflowTaskTemplates({
        lane: currentWorkflow.lane,
        deliveryMode: currentWorkflow.deliveryMode,
        requiresVerification: currentWorkflow.requiresVerification !== false,
    });
    const existingTasks = Array.isArray(currentWorkflow.taskList)
        ? currentWorkflow.taskList
        : [];

    return templates.map((template, index) => {
        const existing = existingTasks.find((entry) => normalizeText(entry?.id) === template.id) || {};
        let status = 'planned';

        if (template.id === 'implement-repository') {
            status = resolveTaskStatus({
                completed: currentWorkflow.progress?.implemented === true,
                active: ['implementing'].includes(stage),
                blocked: blocked && currentWorkflow.progress?.implemented !== true,
            });
        } else if (template.id === 'save-and-push-repository') {
            status = resolveTaskStatus({
                completed: currentWorkflow.progress?.saved === true,
                active: ['saving', 'deploying', 'verifying', 'completed'].includes(stage)
                    && currentWorkflow.progress?.implemented === true
                    && currentWorkflow.progress?.saved !== true,
                blocked: blocked
                    && currentWorkflow.progress?.implemented === true
                    && currentWorkflow.progress?.saved !== true,
            });
        } else if (template.id === 'build-and-deploy-remote-workspace') {
            status = resolveTaskStatus({
                completed: currentWorkflow.progress?.deployed === true,
                active: ['saving', 'deploying', 'verifying', 'completed'].includes(stage)
                    && currentWorkflow.progress?.implemented === true
                    && currentWorkflow.progress?.deployed !== true,
                blocked: blocked
                    && currentWorkflow.progress?.implemented === true
                    && currentWorkflow.progress?.deployed !== true,
            });
        } else if (template.id === 'deploy-release') {
            status = resolveTaskStatus({
                completed: currentWorkflow.progress?.deployed === true,
                active: ['deploying', 'verifying', 'completed'].includes(stage)
                    && currentWorkflow.progress?.deployed !== true
                    && (
                        currentWorkflow.lane === 'deploy-only'
                        || currentWorkflow.deliveryMode === 'remote-workspace'
                        || currentWorkflow.progress?.saved === true
                    ),
                blocked: blocked
                    && currentWorkflow.progress?.deployed !== true
                    && (
                        currentWorkflow.lane === 'deploy-only'
                        || currentWorkflow.deliveryMode === 'remote-workspace'
                        || currentWorkflow.progress?.saved === true
                    ),
            });
        } else if (template.id === 'verify-release') {
            status = resolveTaskStatus({
                completed: currentWorkflow.progress?.verified === true,
                active: ['verifying', 'completed'].includes(stage)
                    && currentWorkflow.progress?.verified !== true,
                blocked: blocked
                    && currentWorkflow.progress?.verified !== true
                    && currentWorkflow.requiresVerification !== false,
                skipped: currentWorkflow.requiresVerification === false,
            });
        } else if (template.id === 'inspect-remote-state') {
            status = resolveTaskStatus({
                completed: currentWorkflow.progress?.verified === true,
                active: ['verifying', 'completed'].includes(stage)
                    && currentWorkflow.progress?.verified !== true,
                blocked: blocked && currentWorkflow.progress?.verified !== true,
            });
        }

        return {
            id: normalizeText(existing.id || template.id) || template.id,
            title: normalizeText(existing.title || template.title) || template.title,
            status,
            notes: normalizeText(existing.notes || ''),
            order: Number.isFinite(Number(existing.order))
                ? Number(existing.order)
                : index + 1,
        };
    });
}

function shouldResumeStoredWorkflow({
    objective = '',
    storedWorkflow = null,
} = {}) {
    const normalized = normalizeText(objective);
    if (!storedWorkflow || storedWorkflow.status === COMPLETED_WORKFLOW_STATUS || !normalized) {
        return false;
    }

    if (hasContinuationIntent(normalized) || hasStructuredCheckpointResponse(normalized)) {
        return true;
    }

    if (hasDiscoveryPlanningIntent(normalized)) {
        return false;
    }

    return hasLikelyDecisionReplyIntent(normalized);
}

function resolveDeployDefaults(defaults = null) {
    const source = defaults && typeof defaults === 'object' ? defaults : {};
    return {
        repositoryUrl: normalizeText(source.repositoryUrl || config.deploy.defaultRepositoryUrl) || null,
        ref: normalizeText(source.ref || source.branch || config.deploy.defaultBranch) || 'master',
        targetDirectory: normalizeText(source.targetDirectory || config.deploy.defaultTargetDirectory) || null,
        manifestsPath: normalizeText(source.manifestsPath || config.deploy.defaultManifestsPath) || 'k8s',
        namespace: normalizeText(source.namespace || config.deploy.defaultNamespace) || 'kimibuilt',
        deployment: normalizeText(source.deployment || config.deploy.defaultDeployment) || 'backend',
        container: normalizeText(source.container || config.deploy.defaultContainer) || 'backend',
        publicDomain: normalizeText(source.publicDomain || config.deploy.defaultPublicDomain) || 'demoserver2.buzz',
        ingressClassName: normalizeText(source.ingressClassName || config.deploy.defaultIngressClassName) || 'traefik',
        tlsClusterIssuer: normalizeText(source.tlsClusterIssuer || config.deploy.defaultTlsClusterIssuer) || 'letsencrypt-prod',
    };
}

function objectiveMentionsConfiguredDeployLane(objective = '', defaults = null) {
    const normalizedObjective = normalizeLowerText(objective);
    if (!normalizedObjective) {
        return false;
    }

    const deployDefaults = resolveDeployDefaults(defaults);
    const repoName = extractRepositoryNameFromUrl(deployDefaults.repositoryUrl);
    const publicDomain = normalizeLowerText(deployDefaults.publicDomain);
    const requestedHost = extractRequestedHost(objective);

    if (repoName && new RegExp(`\\b${repoName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(normalizedObjective)) {
        return true;
    }

    if (publicDomain && requestedHost && requestedHost === publicDomain) {
        return true;
    }

    return false;
}

function extractRequestedNamespace(text = '') {
    const normalized = normalizeText(text);
    if (!normalized) {
        return '';
    }

    const patterns = [
        /\bnamespace\s+([a-z0-9]([-.a-z0-9]*[a-z0-9])?)\b/i,
        /\bin\s+the\s+([a-z0-9]([-.a-z0-9]*[a-z0-9])?)\s+namespace\b/i,
    ];

    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (match?.[1]) {
            return normalizeLowerText(match[1]);
        }
    }

    return '';
}

function buildDeployState(seed = {}, defaults = null, options = {}) {
    const deployDefaults = resolveDeployDefaults(defaults);
    const seedTargetSource = normalizeLowerText(seed.targetSource);
    const seedUsesConfiguredDefaults = seedTargetSource === 'configured-default';
    const seedRepositoryUrl = normalizeText(seed.repositoryUrl);
    const seedRef = normalizeText(seed.ref);
    const seedTargetDirectory = normalizeText(seed.targetDirectory);
    const seedManifestsPath = normalizeText(seed.manifestsPath);
    const seedDeployment = normalizeText(seed.deployment);
    const seedContainer = normalizeText(seed.container);
    const explicitPublicDomain = normalizeText(seed.publicDomain || extractRequestedHost(options.objective || ''));
    const explicitNamespace = normalizeText(seed.namespace || extractRequestedNamespace(options.objective || ''));
    const hasExplicitDeployCoordinates = seedUsesConfiguredDefaults
        ? [
            seedRepositoryUrl && seedRepositoryUrl !== normalizeText(deployDefaults.repositoryUrl),
            seedTargetDirectory && seedTargetDirectory !== normalizeText(deployDefaults.targetDirectory),
            seedManifestsPath && seedManifestsPath !== normalizeText(deployDefaults.manifestsPath),
            explicitNamespace && explicitNamespace !== normalizeText(deployDefaults.namespace),
            seedDeployment && seedDeployment !== normalizeText(deployDefaults.deployment),
            seedContainer && seedContainer !== normalizeText(deployDefaults.container),
        ].some(Boolean)
        : [
            seedRepositoryUrl,
            seedTargetDirectory,
            seedManifestsPath,
            explicitNamespace,
            seedDeployment,
            seedContainer,
        ].some(Boolean);
    const hasSoftExplicitSeed = seedUsesConfiguredDefaults
        ? [
            seedRef && seedRef !== normalizeText(deployDefaults.ref),
            explicitPublicDomain && explicitPublicDomain !== normalizeText(deployDefaults.publicDomain),
        ].some(Boolean)
        : [
            seedRef,
            explicitPublicDomain,
        ].some(Boolean);
    const useConfiguredDefaults = options.assumeConfiguredDefaults === true && !hasExplicitDeployCoordinates;
    const targetSource = hasExplicitDeployCoordinates || (hasSoftExplicitSeed && !useConfiguredDefaults)
        ? 'explicit'
        : (useConfiguredDefaults ? 'configured-default' : 'unspecified');

    return {
        repositoryUrl: seedRepositoryUrl || normalizeText(useConfiguredDefaults ? deployDefaults.repositoryUrl : '') || null,
        ref: seedRef || normalizeText(useConfiguredDefaults ? deployDefaults.ref : '') || null,
        targetDirectory: seedTargetDirectory || normalizeText(useConfiguredDefaults ? deployDefaults.targetDirectory : '') || null,
        manifestsPath: seedManifestsPath || normalizeText(useConfiguredDefaults ? deployDefaults.manifestsPath : '') || null,
        namespace: explicitNamespace || normalizeText(useConfiguredDefaults ? deployDefaults.namespace : '') || null,
        deployment: seedDeployment || normalizeText(useConfiguredDefaults ? deployDefaults.deployment : '') || null,
        container: seedContainer || normalizeText(useConfiguredDefaults ? deployDefaults.container : '') || null,
        publicDomain: explicitPublicDomain || normalizeText(useConfiguredDefaults ? deployDefaults.publicDomain : '') || null,
        ingressClassName: normalizeText(seed.ingressClassName || deployDefaults.ingressClassName) || null,
        tlsClusterIssuer: normalizeText(seed.tlsClusterIssuer || deployDefaults.tlsClusterIssuer) || null,
        targetSource,
    };
}

function hasResolvedDeployTarget(workflow = null) {
    const deploy = workflow?.deploy || {};
    return Boolean(
        normalizeText(deploy.repositoryUrl)
        || normalizeText(deploy.targetDirectory)
        || normalizeText(deploy.manifestsPath)
        || normalizeText(deploy.deployment)
        || normalizeText(deploy.publicDomain)
        || normalizeText(deploy.namespace),
    ) && normalizeText(deploy.targetSource) !== 'unspecified';
}

function buildInitialStage(lane = '') {
    if (lane === 'repo-only' || lane === 'repo-then-deploy') {
        return 'implementing';
    }
    if (lane === 'deploy-only') {
        return 'deploying';
    }
    if (lane === 'inspect-only') {
        return 'verifying';
    }
    return 'planned';
}

function inferDeliveryMode({ lane = '', workspacePath = '', remoteTarget = null } = {}) {
    if (lane === 'repo-then-deploy' && (normalizeText(workspacePath) || remoteTarget)) {
        return 'remote-workspace';
    }

    return 'gitops';
}

function isRemoteWorkspaceDeployWorkflow(workflow = null) {
    return Boolean(workflow)
        && workflow.lane === 'repo-then-deploy'
        && inferDeliveryMode({
            lane: workflow.lane,
            workspacePath: workflow.workspacePath,
            remoteTarget: workflow.remoteTarget,
        }) === 'remote-workspace';
}

function resolveWorkflowRequiresVerification({
    lane = '',
    deliveryMode = 'gitops',
    explicitValue,
} = {}) {
    if (lane === 'inspect-only' || lane === 'deploy-only') {
        return explicitValue !== false;
    }

    if (lane === 'repo-then-deploy' && deliveryMode === 'remote-workspace') {
        return explicitValue !== false;
    }

    return false;
}

function buildCompletionCriteria({ lane = '', deliveryMode = 'gitops' } = {}) {
    switch (lane) {
    case 'repo-only':
        return ['Repository implementation completed'];
    case 'deploy-only':
        return ['Deployment applied', 'Deployment verified'];
    case 'repo-then-deploy':
        if (deliveryMode === 'remote-workspace') {
            return ['Repository implementation completed', 'Remote workspace built and deployed', 'Deployment verified'];
        }
        return ['Repository implementation completed', 'Changes pushed'];
    case 'inspect-only':
        return ['Inspection completed'];
    default:
        return [];
    }
}

function buildVerificationCriteria({ lane = '', deliveryMode = 'gitops' } = {}) {
    if (lane === 'repo-only') {
        return [];
    }

    if (lane === 'inspect-only') {
        return ['Captured a verified remote inspection result'];
    }

    if (lane === 'repo-then-deploy' && deliveryMode === 'remote-workspace') {
        return ['Remote workspace build completed', 'Kubernetes apply completed', 'Post-deploy remote verification captured'];
    }

    if (lane === 'repo-then-deploy') {
        return [];
    }

    return ['Rollout status confirmed', 'Post-deploy remote verification captured'];
}

function normalizeProgress(progress = {}) {
    const source = progress && typeof progress === 'object' ? progress : {};
    return {
        implemented: source.implemented === true,
        repoStatusChecked: source.repoStatusChecked === true,
        saved: source.saved === true,
        deployed: source.deployed === true,
        verified: source.verified === true,
    };
}

function normalizeWorkflowState(workflow = null, options = {}) {
    if (!isEndToEndBuilderWorkflow(workflow)) {
        return null;
    }

    const stage = VALID_STAGES.has(String(workflow.stage || '').trim())
        ? String(workflow.stage).trim()
        : buildInitialStage(workflow.lane);
    const status = [ACTIVE_WORKFLOW_STATUS, COMPLETED_WORKFLOW_STATUS, BLOCKED_WORKFLOW_STATUS].includes(String(workflow.status || '').trim())
        ? String(workflow.status).trim()
        : ACTIVE_WORKFLOW_STATUS;
    const deploy = buildDeployState(workflow.deploy || {}, options.deployDefaults, {
        objective: workflow.objective,
        assumeConfiguredDefaults: workflow?.deploy?.targetSource === 'configured-default'
            || objectiveMentionsConfiguredDeployLane(workflow.objective, options.deployDefaults),
    });
    const progress = normalizeProgress(workflow.progress);
    const deliveryMode = VALID_DELIVERY_MODES.has(String(workflow.deliveryMode || '').trim())
        ? String(workflow.deliveryMode).trim()
        : inferDeliveryMode({
            lane: workflow.lane,
            workspacePath: workflow.workspacePath,
            remoteTarget: workflow.remoteTarget,
        });
    const requiresVerification = resolveWorkflowRequiresVerification({
        lane: workflow.lane,
        deliveryMode,
        explicitValue: workflow.requiresVerification,
    });

    const normalized = {
        kind: END_TO_END_WORKFLOW_KIND,
        version: Number(workflow.version) || 1,
        objective: normalizeText(workflow.objective),
        lane: workflow.lane,
        stage,
        status,
        workspacePath: normalizeText(workflow.workspacePath) || null,
        repositoryPath: normalizeText(workflow.repositoryPath) || null,
        deliveryMode,
        remoteTarget: workflow.remoteTarget && typeof workflow.remoteTarget === 'object'
            ? {
                ...(normalizeText(workflow.remoteTarget.host) ? { host: normalizeText(workflow.remoteTarget.host) } : {}),
                ...(normalizeText(workflow.remoteTarget.username) ? { username: normalizeText(workflow.remoteTarget.username) } : {}),
                ...(Number.isFinite(Number(workflow.remoteTarget.port)) ? { port: Number(workflow.remoteTarget.port) } : {}),
            }
            : null,
        deploy,
        progress,
        requiresVerification,
        completionCriteria: Array.isArray(workflow.completionCriteria)
            ? workflow.completionCriteria.map((entry) => normalizeText(entry)).filter(Boolean)
            : buildCompletionCriteria({
                lane: workflow.lane,
                deliveryMode,
            }),
        verificationCriteria: Array.isArray(workflow.verificationCriteria)
            ? workflow.verificationCriteria.map((entry) => normalizeText(entry)).filter(Boolean)
            : buildVerificationCriteria({
                lane: workflow.lane,
                deliveryMode,
            }),
        lastMeaningfulProgressAt: normalizeText(workflow.lastMeaningfulProgressAt) || null,
        lastError: normalizeText(workflow.lastError) || null,
        source: normalizeText(workflow.source) || null,
    };

    normalized.taskList = buildWorkflowTaskList(normalized);
    return normalized;
}

function inferEndToEndBuilderWorkflow({
    objective = '',
    session = null,
    workspacePath = '',
    repositoryPath = '',
    remoteTarget = null,
    deployDefaults = null,
} = {}) {
    const storedWorkflow = normalizeWorkflowState(getSessionControlState(session).workflow, {
        deployDefaults,
    });
    if (storedWorkflow && shouldResumeStoredWorkflow({
        objective,
        storedWorkflow,
    })) {
        return normalizeWorkflowState({
            ...storedWorkflow,
            objective: storedWorkflow.objective || normalizeText(objective),
            workspacePath: normalizeText(workspacePath) || storedWorkflow.workspacePath,
            repositoryPath: normalizeText(repositoryPath) || storedWorkflow.repositoryPath,
            remoteTarget: remoteTarget || storedWorkflow.remoteTarget,
            source: 'stored',
        }, {
            deployDefaults,
        });
    }

    const lane = inferWorkflowLane(objective);
    if (!lane) {
        return null;
    }

    const workflow = normalizeWorkflowState({
        kind: END_TO_END_WORKFLOW_KIND,
        version: 1,
        objective: normalizeText(objective),
        lane,
        stage: buildInitialStage(lane),
        status: ACTIVE_WORKFLOW_STATUS,
        workspacePath: normalizeText(workspacePath) || null,
        repositoryPath: normalizeText(repositoryPath) || null,
        remoteTarget,
        deploy: buildDeployState({}, deployDefaults, {
            objective,
            assumeConfiguredDefaults: objectiveMentionsConfiguredDeployLane(objective, deployDefaults),
        }),
        progress: normalizeProgress(),
        requiresVerification: resolveWorkflowRequiresVerification({
            lane,
            deliveryMode: inferDeliveryMode({ lane, workspacePath, remoteTarget }),
        }),
        completionCriteria: buildCompletionCriteria({
            lane,
            deliveryMode: inferDeliveryMode({ lane, workspacePath, remoteTarget }),
        }),
        verificationCriteria: buildVerificationCriteria({
            lane,
            deliveryMode: inferDeliveryMode({ lane, workspacePath, remoteTarget }),
        }),
        lastMeaningfulProgressAt: null,
        lastError: null,
        source: 'objective',
    }, {
        deployDefaults,
    });

    if (workflow?.lane === 'deploy-only' && !hasResolvedDeployTarget(workflow)) {
        return buildBlockedWorkflowState(
            workflow,
            'This deploy request does not identify a specific remote workload or the configured KimiBuilt deploy lane. Refusing to assume `kimibuilt/backend` for an unrelated app.',
        );
    }

    return workflow;
}

function parseToolArguments(rawArguments = '{}') {
    try {
        return JSON.parse(rawArguments || '{}') || {};
    } catch (_error) {
        return {};
    }
}

function getToolEventToolId(event = {}) {
    return normalizeText(event?.toolCall?.function?.name || event?.result?.toolId).toLowerCase();
}

function getToolEventAction(event = {}) {
    const args = parseToolArguments(event?.toolCall?.function?.arguments || '{}');
    return normalizeText(event?.result?.data?.action || args.action).toLowerCase();
}

function getToolEventWorkflowAction(event = {}) {
    const args = parseToolArguments(event?.toolCall?.function?.arguments || '{}');
    return normalizeText(args.workflowAction || args.workflow_action).toLowerCase();
}

function buildImplementationPrompt(workflow = null) {
    const objective = normalizeText(workflow?.objective);
    return [
        'Implement the requested repository changes in the workspace.',
        workflow?.lane === 'repo-then-deploy'
            ? (isRemoteWorkspaceDeployWorkflow(workflow)
                ? 'Keep the changes ready for a later remote build and k3s deployment step on the same server. Do not perform kubectl or deployment actions from inside this authoring step.'
                : 'Keep the changes ready for a later git-safe save/push step. Deployment will happen in a separate follow-up. Do not perform git pushes or remote deployment from inside this authoring step.')
            : 'Focus on the code or content changes and summarize any relevant build or test results.',
        '',
        'User objective:',
        objective || '(empty)',
    ].join('\n');
}

function buildRemoteCliImplementationCommand(workflow = null) {
    const workspacePath = normalizeText(workflow?.workspacePath);
    const objective = normalizeText(workflow?.objective);
    return [
        'set -e',
        'echo "--- remote baseline ---"',
        'hostname && whoami && uname -m && (test -f /etc/os-release && sed -n "1,6p" /etc/os-release || true) && uptime',
        workspacePath ? `cd -- ${quoteShellArg(workspacePath)}` : '',
        'echo "--- workspace ---"',
        'pwd && find . -maxdepth 2 -type f | sort | head -n 120',
        'if [ -d .git ]; then git status --short --branch; fi',
        'if [ -f package.json ]; then',
        '  echo "--- package scripts ---"',
        '  node -e "const p=require(\'./package.json\'); console.log(JSON.stringify(p.scripts || {}, null, 2))" 2>/dev/null || sed -n "1,120p" package.json',
        'fi',
        'echo "--- planned objective ---"',
        `printf "%s\\n" ${quoteShellArg(objective || 'Inspect and prepare the remote workspace for implementation.')}`,
    ].filter(Boolean).join('\n');
}

function buildGitCommitMessage(workflow = null) {
    const objective = truncateText(workflow?.objective || 'update deployment workflow', 72);
    return `KimiBuilt: ${objective || 'update deployment workflow'}`;
}

function extractRequestedHost(text = '') {
    const normalized = normalizeText(text);
    if (!normalized) {
        return '';
    }

    const match = normalized.match(/\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?\b/i);
    return match?.[1] ? String(match[1]).toLowerCase() : '';
}

function requiresPublicDeploymentVerification(workflow = null) {
    const objective = normalizeText(workflow?.objective).toLowerCase();
    if (!objective) {
        return false;
    }

    if (extractRequestedHost(objective)) {
        return true;
    }

    const hasWebsiteTarget = /\b(site|website|web ?site|web ?page|webpage|homepage|landing page|domain|dns)\b/.test(objective);
    const hasPublicIngressSignals = /\b(ingress|traefik|tls|https|certificate|cert-manager|let'?s encrypt|acme)\b/.test(objective);
    return hasWebsiteTarget && hasPublicIngressSignals;
}

function resolveRequestedPublicHost(workflow = null, deployDefaults = null) {
    return extractRequestedHost(workflow?.objective || '')
        || normalizeText(workflow?.deploy?.publicDomain)
        || resolveDeployDefaults(deployDefaults).publicDomain
        || '';
}

function buildVerificationCommand(workflow = null, deployDefaults = null) {
    const deploy = workflow?.deploy || {};
    const namespace = normalizeText(deploy.namespace);
    const deployment = normalizeText(deploy.deployment);
    const expectedHost = resolveRequestedPublicHost(workflow, deployDefaults);

    const command = ['set -e'];
    if (deployment && namespace) {
        command.push(
            `kubectl rollout status deployment/${deployment} -n '${namespace}' --timeout=180s`,
            `kubectl get deployment/${deployment} -n '${namespace}' -o wide`,
        );
    } else if (namespace) {
        command.push(`kubectl get deploy -n '${namespace}' -o wide`);
    } else {
        command.push('kubectl get deploy -A -o wide');
    }

    command.push(
        namespace
            ? `kubectl get pods -n '${namespace}' -o wide`
            : 'kubectl get pods -A -o wide',
        namespace
            ? `kubectl get svc,ingress -n '${namespace}'`
            : 'kubectl get svc,ingress -A -o wide',
    );

    if (!requiresPublicDeploymentVerification(workflow)) {
        return command.join('\n');
    }

    if (namespace) {
        return command.concat([
            `expected_host=${quoteShellArg(expectedHost)}`,
            `ingress_hosts=$(kubectl get ingress -n '${namespace}' -o jsonpath='{range .items[*].spec.rules[*]}{.host}{"\\n"}{end}' | grep -v '^$' || true)`,
            'if [ -n "$ingress_hosts" ]; then echo "--- ingress hosts ---"; printf "%s\\n" "$ingress_hosts"; fi',
            'if [ -n "$expected_host" ] && ! printf "%s\\n" "$ingress_hosts" | grep -Fx "$expected_host" >/dev/null; then',
            '  echo "Expected ingress host not found: $expected_host" >&2',
            '  exit 1',
            'fi',
            'host="$expected_host"',
            'if [ -z "$host" ]; then host=$(printf "%s\\n" "$ingress_hosts" | head -n 1 || true); fi',
            'if [ -z "$host" ]; then',
            `  echo "No ingress host found in namespace ${namespace}" >&2`,
            '  exit 1',
            'fi',
            `tls_secret=$(kubectl get ingress -n '${namespace}' -o jsonpath='{range .items[*].spec.tls[*]}{.secretName}{"\\n"}{end}' | grep -v '^$' | head -n 1 || true)`,
            'if [ -z "$tls_secret" ]; then',
            `  echo "No TLS secret configured on ingress in namespace ${namespace}" >&2`,
            '  exit 1',
            'fi',
            `kubectl get secret "$tls_secret" -n '${namespace}' >/dev/null`,
            'echo "--- https headers ---"',
            'curl -fsSIL --max-time 20 "https://$host"',
            'echo "--- https body preview ---"',
            'curl -fsS --max-time 20 "https://$host" | sed -n "1,20p"',
            'echo "--- ui visual check ---"',
            'if [ -f /app/bin/kimibuilt-ui-check.js ] && command -v node >/dev/null 2>&1; then',
            '  node /app/bin/kimibuilt-ui-check.js "https://$host" --out "ui-checks/$host" || echo "UI visual check failed; use web-scrape screenshot fallback."',
            'else',
            '  echo "UI visual check skipped: kimibuilt-ui-check helper or node is unavailable."',
            'fi',
        ]).join('\n');
    }

    return command.concat([
        `expected_host=${quoteShellArg(expectedHost)}`,
        'ingress_pairs=$(kubectl get ingress -A -o jsonpath=\'{range .items[*]}{.metadata.namespace}{"\\t"}{range .spec.rules[*]}{.host}{"\\n"}{end}{end}\' | grep -v \'^$\' || true)',
        'if [ -n "$ingress_pairs" ]; then echo "--- ingress hosts ---"; printf "%s\\n" "$ingress_pairs"; fi',
        'if [ -n "$expected_host" ] && ! printf "%s\\n" "$ingress_pairs" | awk -v expected="$expected_host" \'$2 == expected { found=1 } END { exit(found ? 0 : 1) }\'; then',
        '  echo "Expected ingress host not found: $expected_host" >&2',
        '  exit 1',
        'fi',
        'host_namespace=$(printf "%s\\n" "$ingress_pairs" | awk -v expected="$expected_host" \'$2 == expected { print $1; exit }\')',
        'host="$expected_host"',
        'if [ -z "$host" ]; then host=$(printf "%s\\n" "$ingress_pairs" | awk \'NF >= 2 { print $2; exit }\'); fi',
        'if [ -z "$host_namespace" ]; then host_namespace=$(printf "%s\\n" "$ingress_pairs" | awk -v host="$host" \'$2 == host { print $1; exit }\'); fi',
        'if [ -z "$host" ] || [ -z "$host_namespace" ]; then',
        '  echo "No ingress host found in any namespace" >&2',
        '  exit 1',
        'fi',
        'tls_secret=$(kubectl get ingress -n "$host_namespace" -o jsonpath=\'{range .items[*].spec.tls[*]}{.secretName}{"\\n"}{end}\' | grep -v \'^$\' | head -n 1 || true)',
        'if [ -z "$tls_secret" ]; then',
        '  echo "No TLS secret configured on ingress in namespace $host_namespace" >&2',
        '  exit 1',
        'fi',
        'kubectl get secret "$tls_secret" -n "$host_namespace" >/dev/null',
        'echo "--- https headers ---"',
        'curl -fsSIL --max-time 20 "https://$host"',
        'echo "--- https body preview ---"',
        'curl -fsS --max-time 20 "https://$host" | sed -n "1,20p"',
        'echo "--- ui visual check ---"',
        'if [ -f /app/bin/kimibuilt-ui-check.js ] && command -v node >/dev/null 2>&1; then',
        '  node /app/bin/kimibuilt-ui-check.js "https://$host" --out "ui-checks/$host" || echo "UI visual check failed; use web-scrape screenshot fallback."',
        'else',
        '  echo "UI visual check skipped: kimibuilt-ui-check helper or node is unavailable."',
        'fi',
    ]).join('\n');
}

function buildInspectCommand(workflow = null) {
    const deploy = workflow?.deploy || {};
    const namespace = normalizeText(deploy.namespace);
    const deployment = normalizeText(deploy.deployment);

    return [
        'set -e',
        deployment && namespace
            ? `kubectl get deployment/${deployment} -n '${namespace}' -o wide`
            : (namespace
                ? `kubectl get deploy -n '${namespace}' -o wide`
                : 'kubectl get deploy -A -o wide'),
        namespace
            ? `kubectl get pods -n '${namespace}' -o wide`
            : 'kubectl get pods -A -o wide',
        namespace
            ? `kubectl get svc,ingress -n '${namespace}'`
            : 'kubectl get svc,ingress -A -o wide',
    ].join('\n');
}

function quoteShellArg(value = '') {
    return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
}

function resolveRemoteWorkspaceManifestsPath(workflow = null) {
    const workspacePath = normalizeText(workflow?.workspacePath);
    const manifestsPath = normalizeText(workflow?.deploy?.manifestsPath || config.deploy.defaultManifestsPath);
    if (!manifestsPath) {
        return workspacePath || null;
    }

    if (manifestsPath.startsWith('/')) {
        return manifestsPath;
    }

    if (!workspacePath) {
        return manifestsPath;
    }

    return `${workspacePath.replace(/\/+$/, '')}/${manifestsPath.replace(/^\/+/, '')}`;
}

function buildRemoteWorkspaceDeployCommand(workflow = null) {
    const workspacePath = normalizeText(workflow?.workspacePath);
    const manifestsPath = resolveRemoteWorkspaceManifestsPath(workflow);
    const namespace = normalizeText(workflow?.deploy?.namespace);
    const deployment = normalizeText(workflow?.deploy?.deployment);
    const manifestTarget = manifestsPath || workspacePath;

    return [
        'set -e',
        'workspace_dir="$(pwd)"',
        'app_dir="$workspace_dir"',
        'if [ ! -f "$app_dir/package.json" ] && [ -f "$workspace_dir/app/package.json" ]; then',
        '  app_dir="$workspace_dir/app"',
        'fi',
        'if [ -f "$app_dir/package.json" ]; then',
        '  cd -- "$app_dir"',
        '  if ! command -v node >/dev/null 2>&1; then echo "node is required to build the remote workspace" >&2; exit 1; fi',
        '  if [ -f pnpm-lock.yaml ]; then',
        '    if ! command -v pnpm >/dev/null 2>&1; then echo "pnpm is required to build this workspace" >&2; exit 1; fi',
        '    pnpm install --frozen-lockfile || pnpm install',
        '    if node -e "const p=require(\'./package.json\'); process.exit(p.scripts && p.scripts.build ? 0 : 1)"; then pnpm run build; fi',
        '  elif [ -f yarn.lock ]; then',
        '    if ! command -v yarn >/dev/null 2>&1; then echo "yarn is required to build this workspace" >&2; exit 1; fi',
        '    yarn install --frozen-lockfile || yarn install',
        '    if node -e "const p=require(\'./package.json\'); process.exit(p.scripts && p.scripts.build ? 0 : 1)"; then yarn build; fi',
        '  else',
        '    if ! command -v npm >/dev/null 2>&1; then echo "npm is required to build this workspace" >&2; exit 1; fi',
        '    if [ -f package-lock.json ]; then npm ci || npm install; else npm install; fi',
        '    if node -e "const p=require(\'./package.json\'); process.exit(p.scripts && p.scripts.build ? 0 : 1)"; then npm run build; fi',
        '  fi',
        '  cd -- "$workspace_dir"',
        'fi',
        'if ! command -v kubectl >/dev/null 2>&1; then echo "kubectl is required on the remote host" >&2; exit 1; fi',
        `if [ ! -e ${quoteShellArg(manifestTarget)} ]; then echo "manifests path not found: ${manifestTarget}" >&2; exit 1; fi`,
        `manifest_target=${quoteShellArg(manifestTarget)}`,
        'if [ -d "$manifest_target" ]; then',
        '  manifest_dir="$manifest_target"',
        '  if [ -f "$manifest_dir/namespace.yaml" ]; then kubectl apply -f "$manifest_dir/namespace.yaml"; fi',
        '  if [ -f "$manifest_dir/cluster-issuer.yaml" ]; then kubectl apply -f "$manifest_dir/cluster-issuer.yaml"; fi',
        '  for manifest_file in $(find "$manifest_dir" -maxdepth 1 -type f \\( -name "*.yaml" -o -name "*.yml" \\) | sort); do',
        '    manifest_name=$(basename "$manifest_file")',
        '    case "$manifest_name" in',
        '      namespace.yaml|cluster-issuer.yaml|secret.yaml|rancher-simple.yaml|rancher-stack-update.yaml)',
        '        continue',
        '        ;;',
        '      ingress-https.yaml)',
        '        if [ -f "$manifest_dir/ingress.yaml" ]; then continue; fi',
        '        ;;',
        '    esac',
        '    kubectl apply -f "$manifest_file"',
        '  done',
        'else',
        '  kubectl apply -f "$manifest_target"',
        'fi',
        deployment && namespace
            ? `kubectl rollout status deployment/${deployment} -n ${quoteShellArg(namespace)} --timeout=180s`
            : (namespace
                ? `kubectl get deploy,svc,ingress -n ${quoteShellArg(namespace)} -o wide`
                : 'kubectl get deploy,svc,ingress -A -o wide'),
        deployment && namespace
            ? `kubectl get deployment/${deployment} -n ${quoteShellArg(namespace)} -o wide`
            : '',
    ].filter(Boolean).join('\n');
}

function buildBlockedWorkflowState(workflow = null, error = '') {
    return normalizeWorkflowState({
        ...workflow,
        status: BLOCKED_WORKFLOW_STATUS,
        stage: 'blocked',
        lastError: normalizeText(error) || 'The end-to-end builder workflow is blocked.',
    });
}

function evaluateEndToEndBuilderWorkflow({
    workflow = null,
    toolPolicy = {},
    remoteToolId = 'remote-command',
    deployDefaults = null,
} = {}) {
    const currentWorkflow = normalizeWorkflowState(workflow, {
        deployDefaults,
    });
    if (!currentWorkflow || currentWorkflow.status !== ACTIVE_WORKFLOW_STATUS) {
        return currentWorkflow;
    }

    const candidateToolIds = new Set(Array.isArray(toolPolicy?.candidateToolIds) ? toolPolicy.candidateToolIds : []);
    const remoteTool = normalizeText(remoteToolId || toolPolicy?.preferredRemoteToolId || 'remote-command') || 'remote-command';
    const usesRemoteWorkspaceDeploy = isRemoteWorkspaceDeployWorkflow(currentWorkflow);

    if ((currentWorkflow.lane === 'repo-only' || currentWorkflow.lane === 'repo-then-deploy')
        && !currentWorkflow.progress.implemented
        && !candidateToolIds.has(remoteTool)) {
        return buildBlockedWorkflowState(
            currentWorkflow,
            `Repository implementation is required before this workflow can continue. \`${remoteTool}\` is not ready for the selected remote CLI target.`,
        );
    }

    if (currentWorkflow.lane === 'repo-then-deploy'
        && usesRemoteWorkspaceDeploy
        && currentWorkflow.progress.implemented
        && !currentWorkflow.progress.deployed
        && !candidateToolIds.has(remoteTool)) {
        return buildBlockedWorkflowState(
            currentWorkflow,
            `The workflow needs \`${remoteTool}\` to build and deploy the remote workspace on the target server.`,
        );
    }

    if (currentWorkflow.lane === 'repo-then-deploy'
        && !usesRemoteWorkspaceDeploy
        && currentWorkflow.progress.implemented
        && (!currentWorkflow.progress.repoStatusChecked || !currentWorkflow.progress.saved)
        && !candidateToolIds.has('git-safe')) {
        return buildBlockedWorkflowState(
            currentWorkflow,
            'The workflow needs `git-safe` to inspect, save, and push the repository changes before the workflow can complete.',
        );
    }

    if (currentWorkflow.lane === 'deploy-only'
        && !currentWorkflow.progress.deployed
        && !candidateToolIds.has('k3s-deploy')) {
        return buildBlockedWorkflowState(
            currentWorkflow,
            'The workflow needs `k3s-deploy` to perform the requested deployment step.',
        );
    }

    if (currentWorkflow.lane === 'deploy-only'
        && !currentWorkflow.progress.deployed
        && !hasResolvedDeployTarget(currentWorkflow)) {
        return buildBlockedWorkflowState(
            currentWorkflow,
            'This deploy request does not identify a specific remote workload or the configured KimiBuilt deploy lane. Refusing to assume `kimibuilt/backend` for an unrelated app.',
        );
    }

    if (currentWorkflow.requiresVerification && !currentWorkflow.progress.verified) {
        if (requiresPublicDeploymentVerification(currentWorkflow) && !candidateToolIds.has(remoteTool)) {
            return buildBlockedWorkflowState(
                currentWorkflow,
                `The workflow needs \`${remoteTool}\` to verify ingress, TLS, and public site reachability before it can claim the deployment is live.`,
            );
        }

        if (!requiresPublicDeploymentVerification(currentWorkflow)
            && !candidateToolIds.has(remoteTool)
            && !(candidateToolIds.has('k3s-deploy') && currentWorkflow.deploy.deployment)) {
            return buildBlockedWorkflowState(
                currentWorkflow,
                `The workflow needs \`${remoteTool}\` or rollout-status access to verify the remote result.`,
            );
        }
    }

    return currentWorkflow;
}

function buildEndToEndWorkflowPlan({
    workflow = null,
    toolPolicy = {},
    remoteToolId = 'remote-command',
    deployDefaults = null,
} = {}) {
    const currentWorkflow = normalizeWorkflowState(workflow, {
        deployDefaults,
    });
    if (!currentWorkflow || currentWorkflow.status === COMPLETED_WORKFLOW_STATUS || currentWorkflow.status === BLOCKED_WORKFLOW_STATUS) {
        return [];
    }

    const candidateToolIds = new Set(Array.isArray(toolPolicy?.candidateToolIds) ? toolPolicy.candidateToolIds : []);
    const remoteTool = normalizeText(remoteToolId || toolPolicy?.preferredRemoteToolId || 'remote-command') || 'remote-command';
    const repositoryPath = currentWorkflow.repositoryPath || config.deploy.defaultRepositoryPath || '';
    const usesRemoteWorkspaceDeploy = isRemoteWorkspaceDeployWorkflow(currentWorkflow);

    if ((currentWorkflow.lane === 'repo-only' || currentWorkflow.lane === 'repo-then-deploy')
        && !currentWorkflow.progress.implemented
        && candidateToolIds.has(remoteTool)) {
        return [{
            tool: remoteTool,
            reason: currentWorkflow.lane === 'repo-then-deploy'
                ? 'Inspect and prepare the remote workspace before build, deploy, and verification steps.'
                : 'Inspect and prepare the remote workspace for the requested repository changes.',
            params: {
                command: buildRemoteCliImplementationCommand(currentWorkflow),
                workflowAction: 'implement-remote-workspace',
                preferRunner: true,
                timeout: REMOTE_VERIFICATION_TIMEOUT_MS,
                ...(currentWorkflow.workspacePath ? { workingDirectory: currentWorkflow.workspacePath } : {}),
            },
        }];
    }

    if (currentWorkflow.lane === 'repo-only') {
        return [];
    }

    if (currentWorkflow.lane === 'repo-then-deploy'
        && usesRemoteWorkspaceDeploy
        && !currentWorkflow.progress.deployed
        && candidateToolIds.has(remoteTool)) {
        return [{
            tool: remoteTool,
            reason: 'Build the remote workspace on the target server and apply the k3s manifests. Verification runs as a separate step.',
            params: {
                ...(currentWorkflow.remoteTarget?.host ? { host: currentWorkflow.remoteTarget.host } : {}),
                ...(currentWorkflow.remoteTarget?.username ? { username: currentWorkflow.remoteTarget.username } : {}),
                ...(currentWorkflow.remoteTarget?.port ? { port: currentWorkflow.remoteTarget.port } : {}),
                ...(currentWorkflow.workspacePath ? { workingDirectory: currentWorkflow.workspacePath } : {}),
                timeout: REMOTE_WORKSPACE_DEPLOY_TIMEOUT_MS,
                workflowAction: 'build-and-deploy-remote-workspace',
                preferRunner: true,
                command: buildRemoteWorkspaceDeployCommand(currentWorkflow),
            },
        }];
    }

    if (currentWorkflow.lane === 'repo-then-deploy'
        && !usesRemoteWorkspaceDeploy
        && !currentWorkflow.progress.repoStatusChecked
        && candidateToolIds.has('git-safe')) {
        return [{
            tool: 'git-safe',
            reason: 'Inspect the local repository branch and upstream before saving and pushing the deployable change.',
            params: {
                action: 'remote-info',
                ...(repositoryPath ? { repositoryPath } : {}),
            },
        }];
    }

    if (currentWorkflow.lane === 'repo-then-deploy'
        && !usesRemoteWorkspaceDeploy
        && !currentWorkflow.progress.saved
        && candidateToolIds.has('git-safe')) {
        return [{
            tool: 'git-safe',
            reason: 'Save and push the verified repository changes so deployment can happen in a separate follow-up.',
            params: {
                action: 'save-and-push',
                ...(repositoryPath ? { repositoryPath } : {}),
                message: buildGitCommitMessage(currentWorkflow),
            },
        }];
    }

    if (currentWorkflow.lane === 'deploy-only'
        && !currentWorkflow.progress.deployed
        && candidateToolIds.has('k3s-deploy')) {
        return [{
            tool: 'k3s-deploy',
            reason: 'Run the standard k3s deployment flow for this request.',
            params: {
                action: 'sync-and-apply',
                ...(currentWorkflow.deploy.repositoryUrl ? { repositoryUrl: currentWorkflow.deploy.repositoryUrl } : {}),
                ...(currentWorkflow.deploy.ref ? { ref: currentWorkflow.deploy.ref } : {}),
                ...(currentWorkflow.deploy.targetDirectory ? { targetDirectory: currentWorkflow.deploy.targetDirectory } : {}),
                ...(currentWorkflow.deploy.manifestsPath ? { manifestsPath: currentWorkflow.deploy.manifestsPath } : {}),
                ...(currentWorkflow.deploy.namespace ? { namespace: currentWorkflow.deploy.namespace } : {}),
                ...(currentWorkflow.deploy.deployment ? { deployment: currentWorkflow.deploy.deployment } : {}),
            },
        }];
    }

    if (currentWorkflow.requiresVerification && !currentWorkflow.progress.verified) {
        if (candidateToolIds.has(remoteTool)) {
            return [{
                tool: remoteTool,
                reason: currentWorkflow.lane === 'inspect-only'
                    ? 'Inspect the remote deployment and capture a verification snapshot.'
                    : (requiresPublicDeploymentVerification(currentWorkflow)
                        ? 'Verify the rollout, ingress, TLS, and public site reachability.'
                        : 'Verify the rollout and post-deploy runtime health.'),
                params: {
                    ...(currentWorkflow.remoteTarget?.host ? { host: currentWorkflow.remoteTarget.host } : {}),
                    ...(currentWorkflow.remoteTarget?.username ? { username: currentWorkflow.remoteTarget.username } : {}),
                    ...(currentWorkflow.remoteTarget?.port ? { port: currentWorkflow.remoteTarget.port } : {}),
                    timeout: REMOTE_VERIFICATION_TIMEOUT_MS,
                    workflowAction: currentWorkflow.lane === 'inspect-only'
                        ? 'inspect-remote-state'
                        : 'verify-deployment',
                    command: currentWorkflow.lane === 'inspect-only'
                        ? buildInspectCommand(currentWorkflow)
                        : buildVerificationCommand(currentWorkflow, deployDefaults),
                },
            }];
        }

        if (!requiresPublicDeploymentVerification(currentWorkflow)
            && candidateToolIds.has('k3s-deploy')
            && currentWorkflow.deploy.deployment) {
            return [{
                tool: 'k3s-deploy',
                reason: 'Verify the deployment rollout status.',
                params: {
                    action: 'rollout-status',
                    deployment: currentWorkflow.deploy.deployment,
                    ...(currentWorkflow.deploy.namespace ? { namespace: currentWorkflow.deploy.namespace } : {}),
                },
            }];
        }
    }

    return [];
}

function markMeaningfulProgress(workflow = null) {
    return normalizeWorkflowState({
        ...workflow,
        lastMeaningfulProgressAt: new Date().toISOString(),
        lastError: null,
    });
}

function advanceEndToEndBuilderWorkflow({
    workflow = null,
    toolEvents = [],
} = {}) {
    let currentWorkflow = normalizeWorkflowState(workflow);
    if (!currentWorkflow) {
        return null;
    }

    const events = Array.isArray(toolEvents) ? toolEvents : [];
    for (const event of events) {
        const toolId = getToolEventToolId(event);
        const success = event?.result?.success !== false;
        const action = getToolEventAction(event);
        const workflowAction = getToolEventWorkflowAction(event);

        if (!success) {
            currentWorkflow = normalizeWorkflowState({
                ...currentWorkflow,
                status: BLOCKED_WORKFLOW_STATUS,
                stage: 'blocked',
                lastError: normalizeText(event?.result?.error) || `Workflow step failed via ${toolId}.`,
            });
            return currentWorkflow;
        }

        if ((toolId === 'remote-command' || toolId === 'ssh-execute') && workflowAction === 'implement-remote-workspace') {
            currentWorkflow = markMeaningfulProgress({
                ...currentWorkflow,
                progress: {
                    ...currentWorkflow.progress,
                    implemented: true,
                },
                workspacePath: normalizeText(event?.result?.data?.workspacePath)
                    || normalizeText(event?.result?.data?.cwd)
                    || currentWorkflow.workspacePath,
                stage: currentWorkflow.lane === 'repo-only' ? 'completed' : 'saving',
                status: currentWorkflow.lane === 'repo-only' ? COMPLETED_WORKFLOW_STATUS : ACTIVE_WORKFLOW_STATUS,
            });
            continue;
        }

        if (toolId === 'managed-app') {
            const deployRequested = event?.result?.data?.buildRun?.deployRequested === true
                || action === 'deploy';
            const deployed = action === 'deploy';
            const completed = currentWorkflow.lane === 'repo-only' || (currentWorkflow.lane === 'repo-then-deploy' && !deployRequested);
            currentWorkflow = markMeaningfulProgress({
                ...currentWorkflow,
                progress: {
                    ...currentWorkflow.progress,
                    implemented: ['create', 'update', 'deploy'].includes(action) || currentWorkflow.progress.implemented,
                    deployed: deployed || currentWorkflow.progress.deployed,
                },
                stage: completed
                    ? 'completed'
                    : (deployRequested ? 'deploying' : 'saving'),
                status: completed
                    ? COMPLETED_WORKFLOW_STATUS
                    : ACTIVE_WORKFLOW_STATUS,
            });
            continue;
        }

        if (toolId === 'git-safe') {
            if (action === 'remote-info') {
                currentWorkflow = markMeaningfulProgress({
                    ...currentWorkflow,
                    progress: {
                        ...currentWorkflow.progress,
                        repoStatusChecked: true,
                    },
                    stage: 'saving',
                });
                continue;
            }

            if (action === 'save-and-push' || action === 'push') {
                currentWorkflow = markMeaningfulProgress({
                    ...currentWorkflow,
                    progress: {
                        ...currentWorkflow.progress,
                        repoStatusChecked: true,
                        saved: true,
                    },
                    stage: 'completed',
                    status: COMPLETED_WORKFLOW_STATUS,
                });
                continue;
            }
        }

        if (toolId === 'k3s-deploy') {
            const verificationSatisfied = action === 'rollout-status'
                && !requiresPublicDeploymentVerification(currentWorkflow);
            currentWorkflow = markMeaningfulProgress({
                ...currentWorkflow,
                progress: {
                    ...currentWorkflow.progress,
                    deployed: true,
                    ...(verificationSatisfied ? { verified: true } : {}),
                },
                stage: verificationSatisfied
                    ? 'completed'
                    : (currentWorkflow.requiresVerification ? 'verifying' : 'completed'),
                status: verificationSatisfied || !currentWorkflow.requiresVerification
                    ? COMPLETED_WORKFLOW_STATUS
                    : ACTIVE_WORKFLOW_STATUS,
            });
            continue;
        }

        if (toolId === 'remote-command' || toolId === 'ssh-execute') {
            if (workflowAction === 'build-and-deploy-remote-workspace') {
                const verificationSatisfied = currentWorkflow.requiresVerification !== true;
                currentWorkflow = markMeaningfulProgress({
                    ...currentWorkflow,
                    progress: {
                        ...currentWorkflow.progress,
                        deployed: true,
                        ...(verificationSatisfied ? { verified: true } : {}),
                    },
                    stage: verificationSatisfied ? 'completed' : 'verifying',
                    status: verificationSatisfied ? COMPLETED_WORKFLOW_STATUS : ACTIVE_WORKFLOW_STATUS,
                });
                continue;
            }

            if (workflowAction === 'verify-deployment'
                || (currentWorkflow.lane === 'inspect-only' && workflowAction === 'inspect-remote-state')) {
                currentWorkflow = markMeaningfulProgress({
                    ...currentWorkflow,
                    progress: {
                        ...currentWorkflow.progress,
                        verified: true,
                    },
                    stage: 'completed',
                    status: COMPLETED_WORKFLOW_STATUS,
                });
                continue;
            }

            const stillVerifying = currentWorkflow.requiresVerification === true
                && currentWorkflow.progress.verified !== true;
            currentWorkflow = markMeaningfulProgress({
                ...currentWorkflow,
                stage: stillVerifying ? 'verifying' : currentWorkflow.stage,
                status: stillVerifying ? ACTIVE_WORKFLOW_STATUS : currentWorkflow.status,
            });
        }
    }

    return currentWorkflow;
}

module.exports = {
    END_TO_END_WORKFLOW_KIND,
    advanceEndToEndBuilderWorkflow,
    buildEndToEndWorkflowPlan,
    evaluateEndToEndBuilderWorkflow,
    inferEndToEndBuilderWorkflow,
    inferWorkflowLane,
    isEndToEndBuilderWorkflow,
};

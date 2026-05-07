const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { createResponse } = require('./openai-client');
const { config } = require('./config');
const { extractResponseText } = require('./artifacts/artifact-service');
const settingsController = require('./routes/admin/settings.controller');
const { inferExecutionProfile: inferRuntimeExecutionProfile } = require('./runtime-execution');
const {
    buildImagePromptFromArtifactRequest,
    extractRequestedImageCount,
    hasExplicitImageGenerationIntent,
    resolveSshRequestContext,
    extractSshSessionMetadataFromToolEvents,
    canonicalizeRemoteToolId,
    isRemoteCommandToolId,
    isSuspiciousSshTargetHost,
} = require('./ai-route-utils');
const {
    buildProjectMemoryUpdate,
    mergeProjectMemory,
} = require('./project-memory');
const {
    buildLegacyControlMetadata,
    getSessionControlState,
    mergeControlState,
} = require('./runtime-control-state');
const { clusterStateRegistry } = require('./cluster-state-registry');
const {
    buildWebChatSessionMessages,
} = require('./web-chat-message-state');
const {
    extractArtifactsFromToolEvents,
    mergeRuntimeArtifacts,
} = require('./runtime-artifacts');
const {
    buildForegroundTurnMessageOptions,
    persistForegroundTurnMessages,
    resolveForegroundTurn,
} = require('./foreground-turn-state');
const { remoteRunnerService } = require('./remote-runner/service');
const {
    buildScopedMemoryMetadata,
    buildScopedSessionMetadata,
    isSessionIsolationEnabled,
    resolveProjectKey,
    resolveClientSurface,
    resolveSessionScope,
    SESSION_LOCAL_MEMORY_NAMESPACE,
    SURFACE_LOCAL_MEMORY_NAMESPACE,
    USER_GLOBAL_MEMORY_NAMESPACE,
} = require('./session-scope');
const {
    createEstimatedUsageMetadata,
    createZeroUsageMetadata,
    extractResponseUsageMetadata,
    extractUsageMetadataFromTrace,
    hasMeasuredTokenCounts,
} = require('./utils/token-usage');
const {
    hasExplicitPodcastIntent,
    extractExplicitPodcastTopic,
    hasExplicitPodcastVideoIntent,
    inferPodcastVideoOptions,
    inferPodcastAudioAssetOptions,
} = require('./podcast/podcast-intent');
const {
    USER_CHECKPOINT_TOOL_ID,
    buildUserCheckpointMessage,
    normalizeCheckpointRequest,
    parseUserCheckpointResponseMessage,
} = require('./user-checkpoints');
const {
    isLikelyTranscriptDependentTurn,
    resolveTranscriptObjectiveFromSession,
} = require('./conversation-continuity');
const { parseLenientJson } = require('./utils/lenient-json');
const { stripNullCharacters } = require('./utils/text');
const {
    buildNaturalContext,
    buildNaturalContextInstructions,
    buildRegisteredSkillsInstructions,
    buildSkillsTreeInstructions,
    buildNaturalContextUpdate,
} = require('./natural-context');
const { formatImageDiagnosticsSummary } = require('./image-generation-diagnostics');
const {
    DEFAULT_EXECUTION_PROFILE,
    NOTES_EXECUTION_PROFILE,
    REMOTE_BUILD_EXECUTION_PROFILE,
    PODCAST_EXECUTION_PROFILE,
    PODCAST_VIDEO_EXECUTION_PROFILE,
    PROFILE_TOOL_ALLOWLISTS,
} = require('./tool-execution-profiles');
const {
    advanceEndToEndBuilderWorkflow,
    buildEndToEndWorkflowPlan,
    evaluateEndToEndBuilderWorkflow,
    inferEndToEndBuilderWorkflow,
} = require('./runtime-workflows/end-to-end-builder');
const {
    advanceForegroundProjectPlan,
    inferForegroundProjectPlan,
} = require('./runtime-workflows/foreground-project-plan');
const { formatProjectExecutionContext } = require('./workloads/project-plans');
const { hasWorkloadIntent } = require('./workloads/natural-language');
const { buildCanonicalWorkloadAction } = require('./workloads/request-builder');
const {
    applyRewritePolicyOverlay,
    isOrchestrationRewriteEnabled,
} = require('./orchestration/tool-policy');
const { buildAgencyProfile: buildRewriteAgencyProfile, inferTaskIntent } = require('./orchestration/intent-classifier');
const { buildDeterministicRoute } = require('./orchestration/plan-router');
const { validatePlan } = require('./orchestration/plan-validator');
const {
    ROLE_IDS,
    formatAgentRolePipelineForPrompt,
    hasRole,
    hasWebsiteBuildIntent,
    inferAgentRolePipeline,
} = require('./orchestration/agent-roles');
const { normalizeBrowserReachableUrl } = require('./agent-sdk/tools/categories/web/internal-url');
const {
    inferSurfaceFinisher,
    scorePerceivedIntelligence,
} = require('./perceived-intelligence-harness');
const SYNTHETIC_STREAM_CHUNK_SIZE = 120;
const MAX_PLAN_STEPS = 4;
const MAX_TOOL_RESULT_CHARS = config.memory.toolResultCharLimit;
const RECENT_TRANSCRIPT_LIMIT = config.memory.recentTranscriptLimit;
const MAX_STEP_SIGNATURE_REPEATS = 3;
const HARNESS_VERSION = 'planner-recovery-v2';
const HARNESS_REVIEW_ACTIONS = new Set(['continue', 'replan', 'synthesize', 'checkpoint', 'blocked']);
const NORMAL_PROFILE_MAX_REPLANS = 1;
const REMOTE_BUILD_MAX_REPLANS = 3;
const DOCUMENT_WORKFLOW_TOOL_ID = 'document-workflow';
const DEEP_RESEARCH_PRESENTATION_TOOL_ID = 'deep-research-presentation';
const DISABLED_AUTONOMOUS_TOOL_IDS = new Set([]);
const AUTONOMY_CONTINUATION_CHECKPOINT_ID_PREFIX = 'checkpoint-autonomy-continue';
const REMOTE_COMMAND_DOC_PATH = path.join(__dirname, 'agent-sdk', 'tool-docs', 'remote-command.md');
const K3S_PLAYBOOK_DOC_PATH = path.join(__dirname, '..', 'k8s', 'K3S_RANCHER_PLAYBOOK.md');
const REMOTE_BLOCKING_ERROR_PATTERNS = [
    /no ssh host configured/i,
    /no ssh username configured/i,
    /no ssh password or private key configured/i,
    /permission denied/i,
    /all configured authentication methods failed/i,
    /could not resolve hostname/i,
    /name or service not known/i,
    /temporary failure in name resolution/i,
    /no route to host/i,
    /network is unreachable/i,
    /connection refused/i,
    /connection timed out/i,
    /operation timed out/i,
    /connection closed by remote host/i,
];
const MANAGED_APP_RECOVERABLE_ERROR_PATTERNS = [
    /managed app not found/i,
    /managed app catalog entry was not found/i,
];

function readLocalGuidanceFile(filePath = '') {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (_error) {
        return '';
    }
}

function getMarkdownHeadingLevel(line = '') {
    const match = String(line || '').match(/^(#{2,6})\s+/);
    return match ? match[1].length : 0;
}

function normalizeMarkdownHeading(line = '') {
    return String(line || '').replace(/^#{2,6}\s+/, '').trim().toLowerCase();
}

function extractMarkdownSection(content = '', heading = '') {
    const normalizedHeading = String(heading || '').trim().toLowerCase();
    if (!content || !normalizedHeading) {
        return '';
    }

    const lines = String(content || '').split(/\r?\n/);
    const startIndex = lines.findIndex((line) => normalizeMarkdownHeading(line) === normalizedHeading);
    if (startIndex < 0) {
        return '';
    }

    const level = getMarkdownHeadingLevel(lines[startIndex]);
    if (!level) {
        return '';
    }

    const sectionLines = [lines[startIndex]];
    for (let index = startIndex + 1; index < lines.length; index += 1) {
        const nextLevel = getMarkdownHeadingLevel(lines[index]);
        if (nextLevel && nextLevel <= level) {
            break;
        }
        sectionLines.push(lines[index]);
    }

    return sectionLines.join('\n').trim();
}

function buildHydratedRemoteOpsGuidanceText() {
    const remoteCommandDoc = readLocalGuidanceFile(REMOTE_COMMAND_DOC_PATH);
    const playbookDoc = readLocalGuidanceFile(K3S_PLAYBOOK_DOC_PATH);

    const remoteCommandSections = [
        'Baseline',
        'K3s and kubectl access',
        '1. Cluster survey',
        '2. Workload drill-down',
        '3. Logs',
        '4. Rollout and restart',
        '5. Service and ingress checks',
        '6. Deploy a simple web workload with kubectl',
        '7. TLS, cert-manager, and DNS checks',
        '8. k3s service health',
        '10. Host files, repo, and search',
        '11. Networking and ports',
        '12. Package install on Ubuntu',
        'Preferred structure for a remote-command call',
    ]
        .map((heading) => extractMarkdownSection(remoteCommandDoc, heading))
        .filter(Boolean)
        .join('\n\n');

    const playbookSections = [
        'Default assumptions',
        'Baseline remote commands',
        'Standard deployment lanes',
        'Common kubectl checks',
        'DNS and HTTPS verification',
        'Rancher UI map',
        'Containerization rule',
    ]
        .map((heading) => extractMarkdownSection(playbookDoc, heading))
        .filter(Boolean)
        .join('\n\n');

    return [
        remoteCommandSections
            ? [
                '[Hydrated from src/agent-sdk/tool-docs/remote-command.md]',
                remoteCommandSections,
            ].join('\n')
            : '',
        playbookSections
            ? [
                '[Hydrated from k8s/K3S_RANCHER_PLAYBOOK.md]',
                playbookSections,
            ].join('\n')
            : '',
    ].filter(Boolean).join('\n\n').trim();
}

const HYDRATED_REMOTE_OPS_GUIDANCE_TEXT = buildHydratedRemoteOpsGuidanceText();

function shouldHydrateRemoteOpsGuidance({
    objective = '',
    instructions = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    allowedToolIds = [],
    toolPolicy = {},
} = {}) {
    if (!HYDRATED_REMOTE_OPS_GUIDANCE_TEXT) {
        return false;
    }

    if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE) {
        return true;
    }

    const prompt = `${objective || ''}\n${instructions || ''}`.toLowerCase();
    if (!prompt.trim()) {
        return false;
    }

    if (/\b(kubectl|kubernetes|k8s|k3s|rancher)\b/.test(prompt)) {
        return true;
    }

    const remoteToolId = getPreferredRemoteToolId(toolPolicy);
    const hasRemoteCapability = Boolean(
        remoteToolId
        || (Array.isArray(allowedToolIds) && (
            allowedToolIds.includes('remote-command')
            || allowedToolIds.includes('remote-workbench')
            || allowedToolIds.includes('k3s-deploy')
            || allowedToolIds.includes('ssh-execute')
        ))
    );
    if (!hasRemoteCapability) {
        return false;
    }

    return false
        || /\b(remote cluster debugging|remote cluster debug|cluster debugging|cluster troubleshooting|cluster triage)\b/.test(prompt)
        || /\b(crashloopbackoff|ingress|rollout|deployment|pod|traefik|cert-manager|journalctl|systemctl|tls|dns)\b/.test(prompt);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExplicitForegroundResumeIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /^(?:yes|yeah|yep)[.!]?\s+(?:we can\s+)?(?:continue|resume|go ahead|proceed)\b/,
        /^(continue|keep going|go ahead|next step|next steps|finish|resume|proceed)\b/,
        /^(do it|do that|ship it|deploy it|verify it|push it)\b/,
        /\b(obvious next step|obvious next steps|from there|from this point)\b/,
        /\bcontinue now\b/,
        /\bkeep working\b/,
    ].some((pattern) => pattern.test(normalized));
}

function normalizeForegroundContinuationGate(value = null) {
    if (!isPlainObject(value) || value.paused !== true) {
        return null;
    }

    return {
        paused: true,
        source: String(value.source || '').trim() || null,
        updatedAt: String(value.updatedAt || value.updated_at || '').trim() || null,
    };
}

function parseAutonomyContinuationDecision(text = '') {
    const response = parseUserCheckpointResponseMessage(text);
    if (!response?.checkpointId || !response.summary) {
        return null;
    }

    if (!response.checkpointId.startsWith(AUTONOMY_CONTINUATION_CHECKPOINT_ID_PREFIX)) {
        return null;
    }

    const summary = String(response.summary || '').trim().toLowerCase();
    if (!summary) {
        return null;
    }

    if (
        /\[(?:continue|continue-now|yes)\]/.test(summary)
        || /\b(?:yes|continue|resume|keep going|go ahead|continue now)\b/.test(summary)
    ) {
        return 'continue';
    }

    if (
        /\[(?:stop|stop-here|no)\]/.test(summary)
        || /\b(?:no|stop here|pause here|not now|later|stop)\b/.test(summary)
    ) {
        return 'stop';
    }

    return null;
}

function findLatestExecutionTraceEntry(executionTrace = [], name = '') {
    const entries = Array.isArray(executionTrace) ? executionTrace : [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.name === name) {
            return entries[index];
        }
    }

    return null;
}

function getActiveProjectMilestoneTitle(projectPlan = null) {
    if (!projectPlan || !Array.isArray(projectPlan.milestones)) {
        return '';
    }

    const activeMilestone = projectPlan.milestones.find((entry) => entry.id === projectPlan.activeMilestoneId)
        || projectPlan.milestones.find((entry) => !['completed', 'skipped'].includes(entry.status))
        || null;

    return normalizeInlineText(activeMilestone?.title || '');
}

function getNextWorkflowTaskTitle(workflow = null) {
    const taskList = Array.isArray(workflow?.taskList) ? workflow.taskList : [];
    const nextTask = taskList.find((entry) => !['completed', 'skipped'].includes(String(entry?.status || '').trim().toLowerCase()));
    return normalizeInlineText(nextTask?.title || '');
}

function buildForegroundStatusSummary({ workflow = null, projectPlan = null, completedEvents = [] } = {}) {
    if (projectPlan && Array.isArray(projectPlan.milestones) && projectPlan.milestones.length > 0) {
        const milestones = projectPlan.milestones;
        const resolvedCount = milestones.filter((entry) => ['completed', 'skipped'].includes(String(entry?.status || '').trim().toLowerCase())).length;
        const nextFocus = getActiveProjectMilestoneTitle(projectPlan);
        return truncateText(
            `Status: ${resolvedCount}/${milestones.length} milestones complete.${nextFocus ? ` Current: ${nextFocus}.` : ''}`,
            180,
        );
    }

    if (workflow && Array.isArray(workflow.taskList) && workflow.taskList.length > 0) {
        const taskList = workflow.taskList;
        const resolvedCount = taskList.filter((entry) => ['completed', 'skipped'].includes(String(entry?.status || '').trim().toLowerCase())).length;
        const nextFocus = getNextWorkflowTaskTitle(workflow);
        return truncateText(
            `Status: ${resolvedCount}/${taskList.length} tasks complete.${nextFocus ? ` Current: ${nextFocus}.` : ''}`,
            180,
        );
    }

    if (completedEvents.length > 0) {
        return `Status: ${completedEvents.length} step${completedEvents.length === 1 ? '' : 's'} completed in this run.`;
    }

    return 'Status: Paused before the next step.';
}

function normalizeProgressStepStatus(status = '') {
    const normalized = normalizeInlineText(status).toLowerCase();
    switch (normalized) {
    case 'completed':
    case 'done':
        return 'completed';
    case 'in_progress':
    case 'running':
    case 'active':
        return 'in_progress';
    case 'blocked':
    case 'failed':
    case 'error':
        return 'failed';
    case 'skipped':
        return 'skipped';
    default:
        return 'pending';
    }
}

function buildProgressTitleFromPlannedStep(step = {}, index = 0) {
    const reason = truncateProgressStepTitle(step?.reason || '', 160);
    if (reason) {
        return reason;
    }

    const toolLabel = normalizeInlineText(step?.tool || '').replace(/[_-]+/g, ' ');
    if (toolLabel) {
        return `Use ${toolLabel}`;
    }

    return `Step ${index + 1}`;
}

function buildProgressStepsFromProjectPlan(projectPlan = null) {
    const milestones = Array.isArray(projectPlan?.milestones) ? projectPlan.milestones : [];
    if (milestones.length === 0) {
        return [];
    }

    return milestones.map((milestone, index) => ({
        id: normalizeInlineText(milestone?.id || '') || `project-step-${index + 1}`,
        title: truncateProgressStepTitle(milestone?.title || `Step ${index + 1}`, 160),
        status: normalizeProgressStepStatus(milestone?.status),
    }));
}

function buildProgressStepsFromWorkflow(workflow = null) {
    const taskList = Array.isArray(workflow?.taskList) ? workflow.taskList : [];
    if (taskList.length === 0) {
        return [];
    }

    return taskList.map((task, index) => ({
        id: normalizeInlineText(task?.id || '') || `workflow-step-${index + 1}`,
        title: truncateProgressStepTitle(task?.title || `Task ${index + 1}`, 160),
        status: normalizeProgressStepStatus(task?.status),
    }));
}

function buildProgressStepsFromPlan(plan = [], {
    activePlanIndex = -1,
    completedPlanSteps = 0,
    failedPlanStepIndex = -1,
} = {}) {
    const normalizedPlan = Array.isArray(plan) ? plan : [];
    if (normalizedPlan.length === 0) {
        return [];
    }

    return normalizedPlan.map((step, index) => ({
        id: `plan-step-${index + 1}`,
        title: buildProgressTitleFromPlannedStep(step, index),
        status: failedPlanStepIndex === index
            ? 'failed'
            : (index < completedPlanSteps
                ? 'completed'
                : (index === activePlanIndex ? 'in_progress' : 'pending')),
    }));
}

function buildConversationProgressSnapshot({
    phase = 'thinking',
    detail = '',
    projectPlan = null,
    workflow = null,
    plan = [],
    activePlanIndex = -1,
    completedPlanSteps = 0,
    failedPlanStepIndex = -1,
    estimated = true,
    source = '',
} = {}) {
    const hasPlanSteps = Array.isArray(plan) && plan.length > 0;
    const preferPlanSteps = normalizeInlineText(source).toLowerCase() === 'tool-plan' && hasPlanSteps;
    let steps = preferPlanSteps
        ? buildProgressStepsFromPlan(plan, {
            activePlanIndex,
            completedPlanSteps,
            failedPlanStepIndex,
        })
        : buildProgressStepsFromProjectPlan(projectPlan);
    let resolvedSource = preferPlanSteps ? 'tool-plan' : 'project-plan';

    if (steps.length === 0) {
        steps = buildProgressStepsFromWorkflow(workflow);
        resolvedSource = 'workflow';
    }

    if (steps.length === 0) {
        steps = buildProgressStepsFromPlan(plan, {
            activePlanIndex,
            completedPlanSteps,
            failedPlanStepIndex,
        });
        resolvedSource = 'tool-plan';
    }

    if (steps.length < 2) {
        return null;
    }

    const completedSteps = steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
    let activeStepIndex = steps.findIndex((step) => step.status === 'in_progress');
    if (activeStepIndex < 0 && completedSteps < steps.length) {
        activeStepIndex = steps.findIndex((step) => step.status === 'pending');
    }
    const activeStep = activeStepIndex >= 0 ? steps[activeStepIndex] : null;

    return {
        phase: normalizeInlineText(phase || 'thinking').toLowerCase() || 'thinking',
        detail: normalizeInlineText(detail || ''),
        summary: `${completedSteps}/${steps.length} steps complete`,
        estimated: estimated !== false,
        source: normalizeInlineText(source || resolvedSource) || resolvedSource,
        totalSteps: steps.length,
        completedSteps,
        activeStepId: activeStep?.id || null,
        activeStepIndex,
        steps,
        updatedAt: new Date().toISOString(),
    };
}

function emitConversationProgress(onProgress = null, snapshot = null) {
    if (typeof onProgress !== 'function' || !snapshot) {
        return;
    }

    try {
        onProgress(snapshot);
    } catch (error) {
        console.warn(`[ConversationOrchestrator] Failed to emit progress update: ${error.message}`);
    }
}

function buildConversationProgressFingerprint(snapshot = null) {
    if (!snapshot || typeof snapshot !== 'object') {
        return '';
    }

    return JSON.stringify({
        phase: snapshot.phase || '',
        detail: snapshot.detail || '',
        source: snapshot.source || '',
        completedSteps: snapshot.completedSteps || 0,
        totalSteps: snapshot.totalSteps || 0,
        steps: (Array.isArray(snapshot.steps) ? snapshot.steps : []).map((step) => ({
            id: step.id,
            title: step.title,
            status: step.status,
        })),
    });
}

function buildAutonomyBudgetPauseUpdate({ toolEvents = [], workflow = null, projectPlan = null } = {}) {
    const completedEvents = (Array.isArray(toolEvents) ? toolEvents : [])
        .filter((event) => (event?.result?.success !== false) && ((event?.toolCall?.function?.name || event?.result?.toolId || '') !== USER_CHECKPOINT_TOOL_ID));
    const latestCompleted = completedEvents[completedEvents.length - 1] || null;
    const latestReason = normalizeInlineText(latestCompleted?.reason || '');
    const statusSummary = buildForegroundStatusSummary({
        workflow,
        projectPlan,
        completedEvents,
    });
    const pauseReason = 'Paused because this autonomous remote run hit its current runtime budget.';

    if (latestReason) {
        return truncateText(`${pauseReason} ${statusSummary} Last completed: ${latestReason}.`, 220);
    }

    return truncateText(`${pauseReason} ${statusSummary}`, 220);
}

function buildAutonomyContinuationReason({ toolEvents = [], workflow = null, projectPlan = null } = {}) {
    const completedEvents = (Array.isArray(toolEvents) ? toolEvents : [])
        .filter((event) => (event?.result?.success !== false) && ((event?.toolCall?.function?.name || event?.result?.toolId || '') !== USER_CHECKPOINT_TOOL_ID));
    const latestCompleted = completedEvents[completedEvents.length - 1] || null;
    const latestReason = normalizeInlineText(latestCompleted?.reason || '');
    const currentFocus = getActiveProjectMilestoneTitle(projectPlan) || getNextWorkflowTaskTitle(workflow);
    const blocker = normalizeInlineText(workflow?.lastError || '');
    const parts = [];

    if (currentFocus) {
        parts.push(`Continuing will resume at: ${truncateText(currentFocus, 96)}.`);
    } else if (latestReason) {
        parts.push(`Continuing will pick up after: ${truncateText(latestReason, 96)}.`);
    }

    if (blocker) {
        parts.push(`Current blocker: ${truncateText(blocker, 96)}.`);
    }

    parts.push('This is a runtime-budget pause, not a restart or a lost draft.');
    parts.push('It will keep the current progress instead of starting over.');
    return truncateText(parts.join(' '), 220);
}

function buildAutonomyContinuationCheckpoint({ toolEvents = [], workflow = null, projectPlan = null } = {}) {
    const update = buildAutonomyBudgetPauseUpdate({
        toolEvents,
        workflow,
        projectPlan,
    });
    const checkpoint = normalizeCheckpointRequest({
        id: `${AUTONOMY_CONTINUATION_CHECKPOINT_ID_PREFIX}-${Date.now().toString(36)}`,
        title: 'Continue from here?',
        preamble: update,
        whyThisMatters: buildAutonomyContinuationReason({
            toolEvents,
            workflow,
            projectPlan,
        }),
        question: 'Do you want me to continue from the current state?',
        options: [{
            id: 'continue-now',
            label: 'Yes, continue here',
            description: 'Resume from the current step without restarting.',
        }, {
            id: 'stop-here',
            label: 'No, stop here',
            description: 'Pause here and leave the current progress as-is.',
        }],
    });

    return {
        checkpoint,
        output: `${update} Use the quick prompt below if you want me to keep going now.`,
        toolEvent: {
            toolCall: {
                function: {
                    name: USER_CHECKPOINT_TOOL_ID,
                    arguments: JSON.stringify(checkpoint),
                },
            },
            reason: 'Pause for a quick continue-or-stop decision after the current autonomous run.',
            result: {
                success: true,
                toolId: USER_CHECKPOINT_TOOL_ID,
                data: {
                    checkpoint,
                    message: buildUserCheckpointMessage(checkpoint),
                },
            },
        },
    };
}

function isAgentNotesAutoWriteEnabled() {
    return settingsController.settings?.agentNotes?.enabled !== false;
}

function getDefaultWorkloadTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function hasMultiWorkloadSchedulingIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const hasSchedulingLanguage = /\b(cron|job|jobs|schedule|scheduled|recurring|automation|task|tasks|workload|workloads)\b/.test(normalized);
    const hasMultiLanguage = /\b(couple|few|multiple|several|two|three)\b/.test(normalized)
        || /\bupdates?\b[\s\S]{0,20}\band\b[\s\S]{0,20}\bchecks?\b/.test(normalized);

    return hasSchedulingLanguage && hasMultiLanguage;
}

function hasLongRunningAgencyIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(work|run|keep going|continue|iterate|improve|investigate|research|debug|build)\b[\s\S]{0,60}\b(longer|for a while|over time|until (?:done|complete|finished)|as long as needed)\b/,
        /\b(multiple|several|many|repeated|iterative)\b[\s\S]{0,40}\b(steps|passes|rounds|iterations|checks|runs)\b/,
        /\b(ramp up|ramp down|scale up|scale down)\b/,
        /\b(end[- ]to[- ]end|multi[- ]step|several steps|through completion|until the goal is reached)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasMultiAgentIntentText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    return [
        /\bsub[- ]agent(?:s)?\b/i,
        /\bmultiple\s+(?:agents|workers|sub[- ]agents)\b/i,
        /\bseveral\s+(?:agents|workers|sub[- ]agents)\b/i,
        /\bmore than one\s+(?:agent|worker|sub[- ]agent)\b/i,
        /\bdelegate\b[\s\S]{0,40}\b(task|tasks|worker|workers|agent|agents|job|jobs)\b/i,
        /\bparallel\b[\s\S]{0,30}\b(task|tasks|worker|workers|agent|agents|workstreams?|streams?)\b/i,
        /\bspawn\b[\s\S]{0,30}\b(worker|workers|agent|agents|sub[- ]agent)\b/i,
    ].some((pattern) => pattern.test(normalized));
}

function inferAgencyProfile({
    objective = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    classification = null,
} = {}) {
    const normalized = String(objective || '').trim().toLowerCase();
    const workloadIntent = hasWorkloadIntent(normalized);
    const multiWorkloadIntent = hasMultiWorkloadSchedulingIntent(normalized);
    const multiAgentIntent = hasMultiAgentIntentText(normalized);
    const longRunningIntent = hasLongRunningAgencyIntentText(normalized);
    const substantialWorkIntent = hasSubstantialWorkIntentText(normalized);
    const checkpointIntent = hasExplicitCheckpointRequestText(normalized)
        || (!multiAgentIntent && hasDiscoveryPlanningIntentText(normalized))
        || classification?.checkpointNeed === 'required';

    let level = 'respond';
    if (checkpointIntent && !multiAgentIntent) {
        level = 'ask';
    } else if (workloadIntent || multiWorkloadIntent) {
        level = multiWorkloadIntent ? 'schedule-multiple' : 'schedule';
    } else if (multiAgentIntent) {
        level = 'delegate';
    } else if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE || longRunningIntent) {
        level = 'sustained';
    } else if (substantialWorkIntent || ['plan-first', 'workflow'].includes(classification?.preferredExecutionPath)) {
        level = 'multi-step';
    }

    const canUseLongerGuardedLoop = ['sustained', 'delegate', 'schedule-multiple'].includes(level)
        || (level === 'multi-step' && longRunningIntent);

    return {
        level,
        askPolicy: checkpointIntent && !multiAgentIntent ? 'ask-first' : 'assume-and-proceed',
        contextPolicy: canUseLongerGuardedLoop ? 'actively-gather-context' : 'use-available-context',
        delegation: multiAgentIntent ? 'explicit' : 'none',
        scheduling: workloadIntent || multiWorkloadIntent
            ? (multiWorkloadIntent ? 'multi-workload' : 'single-workload')
            : 'none',
        longRunning: longRunningIntent || executionProfile === REMOTE_BUILD_EXECUTION_PROFILE,
        maxRoundsHint: canUseLongerGuardedLoop ? 4 : (level === 'multi-step' ? 2 : 1),
        maxToolCallsHint: canUseLongerGuardedLoop ? 8 : (level === 'multi-step' ? 5 : MAX_PLAN_STEPS),
        reasons: [
            ...(longRunningIntent ? ['The request asks the agent to keep working across multiple steps or passes.'] : []),
            ...(multiAgentIntent ? ['The request explicitly mentions multiple agents, workers, delegation, or parallel work.'] : []),
            ...(workloadIntent || multiWorkloadIntent ? ['The request includes future, recurring, cron, or workload language.'] : []),
            ...(checkpointIntent && !multiAgentIntent ? ['The request asks for a decision gate or discovery before execution.'] : []),
        ],
    };
}

function normalizeExecutionProfile(value = '') {
    const normalized = String(value || '').trim().toLowerCase();

    if ([
        'notes',
        'notes-app',
        'notes_app',
        'notes-editor',
        'notes_editor',
    ].includes(normalized)) {
        return NOTES_EXECUTION_PROFILE;
    }

    if ([
        'remote-build',
        'remote_builder',
        'remote-builder',
        'server-build',
        'server-builder',
        'software-builder',
    ].includes(normalized)) {
        return REMOTE_BUILD_EXECUTION_PROFILE;
    }

    if ([
        'podcast',
        'podcast-audio',
        'podcast_audio',
    ].includes(normalized)) {
        return PODCAST_EXECUTION_PROFILE;
    }

    if ([
        'podcast-video',
        'podcast_video',
        'video-podcast',
        'video_podcast',
    ].includes(normalized)) {
        return PODCAST_VIDEO_EXECUTION_PROFILE;
    }

    return DEFAULT_EXECUTION_PROFILE;
}

function normalizeMessageText(content = '') {
    if (typeof content === 'string') {
        return stripNullCharacters(content);
    }

    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === 'string') {
                    return item;
                }

                if (item?.type === 'text' || item?.type === 'input_text' || item?.type === 'output_text') {
                    return stripNullCharacters(item.text || '');
                }

                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    return '';
}

function hasExplicitWebResearchIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(web research|research|look up|search for|search the web|browse the web|search online|browse online)\b/.test(normalized);
}

function hasCurrentInfoIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(latest|current|today|news|headlines?|weather|forecast|temperature)\b/.test(normalized);
}

function hasExplicitPodcastIntentText(text = '') {
    return hasExplicitPodcastIntent(text);
}

function extractRequestedPodcastDurationMinutes(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    const match = normalized.match(/\b(\d{1,2})\s*(?:-|–|—)?\s*minutes?\b/);
    const numeric = Number(match?.[1] || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }

    return Math.max(3, Math.min(30, Math.round(numeric)));
}

function hasDocumentWorkflowIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return (
        /\b(document|doc|report|brief|proposal|guide|summary|one-pager|whitepaper|slides|presentation|deck|pptx|docx|pdf|html page|html document|web page|webpage|website|web site|site|landing page|microsite|product page|dashboard|frontend|front end|web app)\b/.test(normalized)
        && /\b(create|make|generate|build|prepare|draft|write|assemble|compile|organize|inject|turn|convert|export)\b/.test(normalized)
    ) || (
        /\b(slides|presentation|deck|pptx|docx|pdf|html document|research brief)\b/.test(normalized)
        && /\b(research|look up|search|browse|scrape|extract|pricing|comparison|current|latest)\b/.test(normalized)
    );
}

function hasDeepResearchPresentationIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return hasExplicitWebResearchIntentText(normalized)
        && /\b(slides|presentation|slide deck|deck|pptx|website slides)\b/.test(normalized);
}

function hasIndexedAssetIntentText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    return [
        /\b(previous|earlier|prior|old|older|past|existing|last|latest|same|that|those|these|uploaded|attached|generated|saved|worked on|working with)\b[\s\S]{0,50}\b(image|images|photo|photos|picture|pictures|document|documents|doc|docs|pdf|deck|slide deck|pptx|file|files|artifact|artifacts|attachment|attachments)\b/i,
        /\b(image|images|photo|photos|picture|pictures|document|documents|doc|docs|pdf|deck|slide deck|pptx|file|files|artifact|artifacts|attachment|attachments)\b[\s\S]{0,70}\b(from earlier|from before|from last time|from a prior run|from past work|we worked on|we were working with|you generated|you made|you created|uploaded|attached|saved|old|older|existing)\b/i,
        /\b(find|search|locate|list|show|open|use|reuse|reference|pull up|look for|review|improve|iterate on|edit|update|build on)\b[\s\S]{0,50}\b(previous|earlier|prior|old|older|past|existing|uploaded|attached|generated|saved|artifact|image|document|pdf|file|attachment)\b/i,
        /\b(context|reference|source material|source files?|old files?|existing files?)\b[\s\S]{0,60}\b(change|edit|update|improve|rewrite|build|revise)\b/i,
        /\b(asset|assets)\b[\s\S]{0,20}\b(search|index|indexed|catalog|catalogue|manager)\b/i,
    ].some((pattern) => pattern.test(normalized));
}

function hasPodcastSourceArtifactReferenceText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    return [
        /\b(previous|earlier|prior|last|latest|same|that|those|these|uploaded|attached|saved|worked on|working with)\b[\s\S]{0,60}\b(document|documents|doc|docs|pdf|docx|xlsx|csv|file|files|artifact|artifacts|attachment|attachments)\b/i,
        /\b(document|documents|doc|docs|pdf|docx|xlsx|csv|file|files|artifact|artifacts|attachment|attachments)\b[\s\S]{0,80}\b(from earlier|from before|from last time|we worked on|we were working with|uploaded|attached|saved|selected)\b/i,
        /\b(use|reuse|reference|pull from|base it on|make it from|turn)\b[\s\S]{0,60}\b(uploaded|attached|selected|previous|earlier)\b[\s\S]{0,60}\b(document|documents|doc|docs|pdf|docx|xlsx|csv|file|files|artifact|artifacts|attachment|attachments)\b/i,
    ].some((pattern) => pattern.test(normalized));
}

function hasResearchBucketIntentText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    return [
        /\bresearch bucket\b/i,
        /\breference bucket\b/i,
        /\bsource library\b/i,
        /\bsaved research\b/i,
        /\bproject references?\b/i,
        /\blong[- ]term bucket\b/i,
        /\bbucket\b[\s\S]{0,60}\b(images?|data|graphs?|code|audio|wave|wav|docs?|references?|assets?)\b/i,
        /\b(images?|data|graphs?|code|audio|wave|wav|docs?|references?|assets?)\b[\s\S]{0,60}\bbucket\b/i,
    ].some((pattern) => pattern.test(normalized));
}

function hasPublicSourceIndexIntentText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    return [
        /\bpublic source index\b/i,
        /\bpublic api index\b/i,
        /\bpublic api catalog(?:ue)?\b/i,
        /\bapi source library\b/i,
        /\bdashboard source catalog(?:ue)?\b/i,
        /\b(news|rss|data|public)\s+feed\s+(index|catalog|catalogue|source|sources)\b/i,
        /\b(find|search|list|show|add|save|store|index|verify|refresh)\b[\s\S]{0,60}\b(public api|public endpoint|public feed|news feed|rss feed|dashboard source|data portal|open data source)\b/i,
        /\b(public api|public endpoint|public feed|news feed|rss feed|dashboard source|data portal|open data source)\b[\s\S]{0,60}\b(find|search|list|show|add|save|store|index|verify|refresh)\b/i,
    ].some((pattern) => pattern.test(normalized));
}

function hasExplicitCheckpointRequestText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(ask me first|check with me|run it by me|before you start|before doing|before making|before major work|before major changes?|before implementation|which direction|which approach|choose a direction|help me choose|decision|trade-?off|options?|questionnaire|questionnaires|ask me (?:some|a few|a couple of)? questions?|start with (?:questions?|a questionnaire|questionnaires))\b/.test(normalized);
}

function hasHighImpactDecisionGateText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(design choice|product choice|product decision|architecture decision|architectural decision)\b/,
        /\b(which|choose|pick|decide|select)\b[\s\S]{0,40}\b(approach|architecture|design|direction|stack|framework|provider|strategy)\b/,
        /\b(trade-?off|tradeoffs?|pros and cons)\b[\s\S]{0,50}\b(approach|architecture|design|direction|stack|framework|provider|strategy)\b/,
        /\b(ask me first|check with me|run it by me)\b/,
        /\bbefore\b[\s\S]{0,30}\b(major work|major changes?|implementation|architecture|deploy(?:ment)?)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasDiscoveryPlanningIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
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

function hasSubstantialWorkIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(plan|planning|refactor|implement|implementation|build|create|generate|draft|design|deploy|migration|migrate|rewrite|organize|set up|setup|fix|debug|investigate|audit|review)\b/.test(normalized);
}

function isJudgmentV2Enabled() {
    return config.runtime?.judgmentV2Enabled === true;
}

function getEffectiveOrchestrationConfig() {
    if (typeof settingsController?.getEffectiveOrchestrationConfig === 'function') {
        return settingsController.getEffectiveOrchestrationConfig();
    }

    return settingsController?.settings?.orchestration || {};
}

function normalizeConfidence(value = null, fallback = 0.5) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }

    return Math.max(0, Math.min(1, numeric));
}

function pushReason(reasons = [], reason = '') {
    const normalized = String(reason || '').trim();
    if (!normalized || reasons.includes(normalized)) {
        return reasons;
    }

    reasons.push(normalized);
    return reasons;
}

function hasNotesPageEditIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(put|add|insert|place|append|prepend|move|drop|apply|write|turn|convert|use|set)\b[\s\S]{0,40}\b(on|into|to|in)\b[\s\S]{0,20}\b(page|note|document|doc)\b/,
        /\b(edit|update|rewrite|reformat|reorganize|restyle|clean up|fix)\b[\s\S]{0,40}\b(page|note|document|doc)\b/,
        /\b(current page|this page|the page|this note|the note)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasNotesPageBuildIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const explicitDeliveryIntent = /\b(export|download|save|artifact|file|link|attachment|standalone html|shareable html)\b/.test(normalized);
    const explicitExternalSurface = /\b(site|website|web\s*page|landing\s*page|homepage|route|component|repo file|server page)\b/.test(normalized);
    const pageWritingVerb = /\b(create|make|build|draft|write|expand|fill out|flesh out|continue|finish|polish|rewrite|turn|convert|organize|restructure|rework|improve|work on)\b/.test(normalized);
    const pageTarget = /\b(page|notes|note|document|doc|brief|report|spec|plan|guide|proposal|outline|section|content|dashboard|playbook|summary|research brief)\b/.test(normalized);

    return !explicitDeliveryIntent
        && !explicitExternalSurface
        && pageWritingVerb
        && pageTarget;
}

function classifyRequestIntent({
    objective = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    taskType = 'chat',
    clientSurface = '',
    recentMessages = [],
    session = null,
} = {}) {
    const text = String(objective || '').trim();
    const normalized = text.toLowerCase();
    const reasons = [];
    const normalizedSurface = String(clientSurface || taskType || '').trim().toLowerCase();
    const activeProjectPlan = session?.controlState?.projectPlan
        || session?.metadata?.controlState?.projectPlan
        || null;
    const hasProjectContinuation = Array.isArray(recentMessages) && recentMessages.length > 0 && (
        /^(continue|again|same|that|those|from there|next step|next steps|do it|do that)\b/.test(normalized)
        || Boolean(activeProjectPlan?.status === 'active')
    );

    let taskFamily = 'general';
    let groundingRequirement = 'not-needed';
    let preferredExecutionPath = 'plain-response';
    let checkpointNeed = 'none';
    let confidence = 0.48;

    const surfaceMode = executionProfile === NOTES_EXECUTION_PROFILE
        || ['notes', 'notes-app', 'notes_app', 'notes-editor', 'notes_editor'].includes(normalizedSurface)
        ? 'notes-page'
        : (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
            ? 'remote-build'
            : (normalizedSurface.includes('canvas')
                ? 'canvas'
                : (normalizedSurface.includes('notation')
                    ? 'notation'
                    : (normalizedSurface.includes('web-chat') ? 'web-chat' : 'chat'))));

    if (hasDiscoveryPlanningIntentText(normalized) || hasExplicitCheckpointRequestText(normalized)) {
        taskFamily = 'planning';
        preferredExecutionPath = 'checkpoint';
        checkpointNeed = 'required';
        confidence = 0.88;
        pushReason(reasons, 'The request explicitly asks for discovery, options, or a decision gate before major work.');
    } else if (hasWorkloadIntent(normalized)) {
        taskFamily = 'scheduling';
        preferredExecutionPath = 'direct-tool';
        confidence = 0.9;
        pushReason(reasons, 'The request is about later or recurring work, so workload creation is the primary path.');
    } else if (surfaceMode === 'notes-page' && (hasNotesPageEditIntentText(normalized) || hasNotesPageBuildIntentText(normalized))) {
        taskFamily = 'notes-edit';
        preferredExecutionPath = 'plan-first';
        confidence = 0.9;
        pushReason(reasons, 'The request targets the current notes page rather than a standalone file or website.');
    } else if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE || /\b(ssh|server|cluster|k3s|k8s|kubernetes|kubectl|deployment|docker|remote)\b/.test(normalized)) {
        taskFamily = 'remote-ops';
        preferredExecutionPath = hasProjectContinuation ? 'workflow' : 'plan-first';
        confidence = hasProjectContinuation ? 0.88 : 0.81;
        pushReason(reasons, 'The request is about remote infrastructure, deployment, or server operations.');
    } else if (hasExplicitPodcastIntentText(normalized)) {
        taskFamily = 'podcast';
        groundingRequirement = 'required';
        preferredExecutionPath = 'direct-tool';
        confidence = 0.93;
        pushReason(reasons, 'The request explicitly asks for a podcast workflow, so the runtime should use the dedicated podcast tool rather than freeform scripting.');
    } else if (hasExplicitWebResearchIntentText(normalized) || hasCurrentInfoIntentText(normalized)) {
        taskFamily = hasDocumentWorkflowIntentText(normalized) ? 'research-deliverable' : 'research';
        groundingRequirement = 'required';
        preferredExecutionPath = 'direct-tool';
        confidence = hasCurrentInfoIntentText(normalized) ? 0.86 : 0.91;
        pushReason(reasons, 'The request needs current or researched information, so grounded web evidence is required.');
    } else if (hasDocumentWorkflowIntentText(normalized)) {
        taskFamily = 'document';
        groundingRequirement = /\b(research|compare|latest|current|pricing|search|browse)\b/.test(normalized)
            ? 'preferred'
            : 'not-needed';
        preferredExecutionPath = 'plan-first';
        confidence = 0.74;
        pushReason(reasons, 'The request is primarily about generating a document or presentation deliverable.');
    } else if (hasExplicitSubAgentIntentText(normalized)) {
        taskFamily = 'delegation';
        preferredExecutionPath = 'plan-first';
        confidence = 0.82;
        pushReason(reasons, 'The user explicitly asked for delegated or parallel agent work.');
    } else if (hasIndexedAssetIntentText(normalized) || /\b(previous|earlier|prior|old|older|existing|latest|generated|artifact|attachment|file)\b/.test(normalized)) {
        taskFamily = 'artifact-followup';
        preferredExecutionPath = 'plan-first';
        confidence = 0.72;
        pushReason(reasons, 'The request refers to prior outputs or stored artifacts.');
    } else if (hasRepositoryImplementationIntent(normalized)) {
        taskFamily = 'repo-work';
        preferredExecutionPath = executionProfile === REMOTE_BUILD_EXECUTION_PROFILE ? 'workflow' : 'plan-first';
        confidence = 0.82;
        pushReason(reasons, 'The request is about repository implementation work rather than plain chat.');
    }

    if (hasProjectContinuation && preferredExecutionPath === 'plain-response') {
        preferredExecutionPath = 'plan-first';
        confidence = Math.max(confidence, 0.62);
        pushReason(reasons, 'The request appears to continue the active session workflow or project plan.');
    }

    const ambiguousSignals = [
        hasExplicitPodcastIntentText(normalized),
        hasDocumentWorkflowIntentText(normalized),
        hasExplicitWebResearchIntentText(normalized) || hasCurrentInfoIntentText(normalized),
        hasRepositoryImplementationIntent(normalized),
        hasExplicitSubAgentIntentText(normalized),
    ].filter(Boolean).length;
    if (ambiguousSignals >= 2) {
        confidence = Math.max(0.45, confidence - 0.14);
        if (checkpointNeed === 'none' && hasSubstantialWorkIntentText(normalized)) {
            checkpointNeed = 'optional';
        }
        pushReason(reasons, 'The request mixes multiple high-impact intents, so tool selection should stay conservative.');
    }

    return {
        taskFamily,
        groundingRequirement,
        surfaceMode,
        preferredExecutionPath,
        checkpointNeed,
        confidence: normalizeConfidence(confidence),
        ambiguous: normalizeConfidence(confidence) < 0.72,
        reasons,
    };
}

function adjustCandidateToolScore(scoreMap = {}, toolId = '', delta = 0, reason = '') {
    if (!toolId || !Object.prototype.hasOwnProperty.call(scoreMap, toolId)) {
        return;
    }

    scoreMap[toolId].score = Number(scoreMap[toolId].score || 0) + Number(delta || 0);
    if (reason) {
        pushReason(scoreMap[toolId].reasons, reason);
    }
}

function hasGroundedResearchToolResult(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).some((event) => {
        const toolId = String(event?.result?.toolId || event?.toolCall?.function?.name || '').trim();
        return event?.result?.success !== false && ['web-search', 'web-fetch', 'web-scrape'].includes(toolId);
    });
}

function buildScoredCandidateToolMap({
    allowedToolIds = [],
    classification = null,
    prompt = '',
    objective = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    remoteToolId = '',
    canUseSubAgents = false,
    canUseUserCheckpoint = false,
    allowDeferredWorkloadShortcut = false,
    hasExplicitWebResearchIntent = false,
    hasExplicitScrapeIntent = false,
    hasUrl = false,
    hasImageIntent = false,
    hasUnsplashIntent = false,
    hasImageUrlIntent = false,
    hasDirectImageUrl = false,
    hasAssetCatalogIntent = false,
    hasResearchBucketIntent = false,
    hasPublicSourceIndexIntent = false,
    hasPodcastIntent = false,
    hasDocumentWorkflowIntent = false,
    hasSubAgentIntent = false,
    hasManagedAppIntent = false,
    hasRemoteCliAgentAuthoringRequest = false,
    explicitGitIntent = false,
    explicitK3sDeployIntent = false,
    hasWorkloadSetupIntent = false,
    isDeferredWorkloadRun = false,
    shouldPreferRemoteWebsiteSource = false,
    workflowNeedsRepoLane = false,
    workflowNeedsDeployLane = false,
    sessionIsolation = false,
    toolEvents = [],
    hasArchitectureIntent = false,
    hasUmlIntent = false,
    hasApiIntent = false,
    hasSchemaIntent = false,
    hasMigrationChangeIntent = false,
    hasSecurityIntent = false,
    agencyProfile = null,
    rolePipeline = null,
} = {}) {
    const scoreMap = Object.fromEntries(
        allowedToolIds.map((toolId) => [toolId, { score: 0, reasons: [] }]),
    );
    const normalizedPrompt = String(prompt || '').toLowerCase();
    const hasStructuredRemoteWorkbenchIntent = /\b(remote workbench|repo-map|repo map|changed files?|grep|read file|write file|apply patch|focused test|remote build|remote test|deployment logs?|rollout|deploy verify|deployment verification)\b/.test(normalizedPrompt);
    const groundedResearch = hasGroundedResearchToolResult(toolEvents);
    const classificationConfidence = Number(classification?.confidence || 0);
    const failedToolIds = Array.from(new Set((Array.isArray(toolEvents) ? toolEvents : [])
        .filter((event) => event?.result?.success === false)
        .map((event) => String(event?.result?.toolId || event?.toolCall?.function?.name || '').trim())
        .filter(Boolean)));

    if (classification) {
        const hasHighImpactDecisionGate = hasHighImpactDecisionGateText(normalizedPrompt);
        adjustCandidateToolScore(scoreMap, USER_CHECKPOINT_TOOL_ID, classification.checkpointNeed === 'required' && canUseUserCheckpoint ? 1.6 : 0, 'The classifier requires a user decision before major work.');
        if (classification.checkpointNeed === 'optional' && canUseUserCheckpoint && hasHighImpactDecisionGate) {
            adjustCandidateToolScore(scoreMap, USER_CHECKPOINT_TOOL_ID, 0.18, 'The classifier found ambiguity, but execution should continue with reasonable assumptions unless a real decision gate appears.');
        }

        if (classification.groundingRequirement === 'required') {
            adjustCandidateToolScore(scoreMap, 'web-search', 1.5, 'Grounding is required, so web search should lead.');
            adjustCandidateToolScore(scoreMap, 'web-fetch', hasUrl ? 1.15 : 0.8, 'Grounded research should verify result pages directly before considering scraping.');
            adjustCandidateToolScore(scoreMap, 'web-scrape', hasExplicitScrapeIntent ? 1.15 : (hasUrl ? 0.45 : 0.2), 'Grounded research only needs scraping when rendered or structured extraction is necessary.');
            adjustCandidateToolScore(scoreMap, DOCUMENT_WORKFLOW_TOOL_ID, groundedResearch ? 0.95 : 0.2, groundedResearch
                ? 'Verified research sources are ready for a grounded deliverable.'
                : 'Document generation should wait for verified sources.');
        }

        switch (classification.taskFamily) {
        case 'remote-ops':
            adjustCandidateToolScore(scoreMap, remoteToolId, 1.25, 'Remote operations should start with the trusted remote tool.');
            adjustCandidateToolScore(scoreMap, 'remote-workbench', hasStructuredRemoteWorkbenchIntent ? 0.9 : 0, 'Structured remote workbench actions fit routine remote inspection, file, build, test, log, and rollout work.');
            adjustCandidateToolScore(scoreMap, 'k3s-deploy', workflowNeedsDeployLane || explicitK3sDeployIntent ? 0.95 : 0, 'The active remote workflow includes deployment work.');
            adjustCandidateToolScore(scoreMap, 'git-safe', explicitGitIntent || workflowNeedsDeployLane ? 0.55 : 0, 'Git save/publish flow is relevant to the remote task.');
            break;
        case 'repo-work':
            adjustCandidateToolScore(scoreMap, remoteToolId, executionProfile === REMOTE_BUILD_EXECUTION_PROFILE ? 1.25 : 0, 'Remote CLI repository work should use the trusted remote command lane.');
            adjustCandidateToolScore(scoreMap, 'remote-workbench', executionProfile === REMOTE_BUILD_EXECUTION_PROFILE && hasStructuredRemoteWorkbenchIntent ? 0.95 : 0, 'Structured remote repository work can use remote-workbench actions.');
            adjustCandidateToolScore(scoreMap, 'git-safe', explicitGitIntent ? 0.75 : 0.3, 'Repository work may end with a save/push step.');
            break;
        case 'research':
        case 'research-deliverable':
            adjustCandidateToolScore(scoreMap, 'web-search', 1.25, 'Research intent favors search-first grounding.');
            adjustCandidateToolScore(scoreMap, 'web-fetch', hasUrl ? 0.95 : 0.55, 'Research intent benefits from direct source-page verification.');
            adjustCandidateToolScore(scoreMap, 'web-scrape', hasExplicitScrapeIntent ? 1.0 : 0.15, 'Research intent should only escalate to scraping when extraction is necessary.');
            break;
        case 'podcast':
            adjustCandidateToolScore(scoreMap, 'podcast', 1.75, 'Podcast requests should use the dedicated podcast workflow tool for research, scripting, voices, and audio output.');
            adjustCandidateToolScore(scoreMap, 'web-search', 0.2, 'Podcast work may still need research fallback if the dedicated workflow is unavailable.');
            break;
        case 'document':
            adjustCandidateToolScore(scoreMap, DOCUMENT_WORKFLOW_TOOL_ID, 0.95, 'A document deliverable is the primary outcome.');
            break;
        case 'artifact-followup':
            adjustCandidateToolScore(scoreMap, 'asset-search', 1.15, 'Artifact follow-ups should start from prior outputs.');
            adjustCandidateToolScore(scoreMap, 'file-read', /\bfile\b/.test(normalizedPrompt) ? 0.55 : 0, 'The request may need local file context.');
            break;
        case 'scheduling':
            adjustCandidateToolScore(scoreMap, 'agent-workload', !isDeferredWorkloadRun && allowDeferredWorkloadShortcut ? 1.4 : 0, 'Scheduling requests should use persisted workloads.');
            break;
        case 'delegation':
            adjustCandidateToolScore(scoreMap, 'agent-delegate', canUseSubAgents && hasSubAgentIntent ? 1.3 : 0, 'The user explicitly asked for delegation.');
            break;
        case 'notes-edit':
            adjustCandidateToolScore(scoreMap, 'web-search', hasExplicitWebResearchIntent ? 0.95 : 0.15, 'Notes editing may need supporting research.');
            adjustCandidateToolScore(scoreMap, 'web-fetch', hasUrl ? 0.95 : 0.25, 'Notes editing may need verified page content.');
            adjustCandidateToolScore(scoreMap, 'web-scrape', hasExplicitScrapeIntent ? 1.05 : 0.25, 'Notes editing may need structured source extraction.');
            break;
        default:
            break;
        }
    }

    if (agencyProfile && typeof agencyProfile === 'object') {
        if (agencyProfile.scheduling === 'multi-workload') {
            adjustCandidateToolScore(scoreMap, 'agent-workload', !isDeferredWorkloadRun && allowDeferredWorkloadShortcut ? 1.65 : 0, 'The agency profile identified multiple scheduled workloads or cron jobs.');
        } else if (agencyProfile.scheduling === 'single-workload') {
            adjustCandidateToolScore(scoreMap, 'agent-workload', !isDeferredWorkloadRun && allowDeferredWorkloadShortcut ? 1.15 : 0, 'The agency profile identified a deferred or recurring workload.');
        }

        if (agencyProfile.delegation === 'explicit') {
            adjustCandidateToolScore(scoreMap, 'agent-delegate', canUseSubAgents ? 1.55 : 0, 'The agency profile identified explicit multi-agent or delegated work.');
        }

        if (agencyProfile.level === 'sustained' || agencyProfile.longRunning) {
            adjustCandidateToolScore(scoreMap, 'web-search', hasExplicitWebResearchIntent || classification?.groundingRequirement === 'required' ? 0.35 : 0, 'Longer-running work can gather context before synthesis.');
            adjustCandidateToolScore(scoreMap, 'file-search', /\b(repo|repository|workspace|codebase|files?)\b/.test(normalizedPrompt) ? 0.5 : 0, 'Longer-running repository work should inspect local context.');
            adjustCandidateToolScore(scoreMap, remoteToolId, executionProfile === REMOTE_BUILD_EXECUTION_PROFILE ? 0.45 : 0, 'Sustained remote-build work should keep the remote execution lane available.');
        }
    }

    if (canUseSubAgents && hasSubAgentIntent) {
        adjustCandidateToolScore(scoreMap, 'agent-delegate', 1.2, 'The user explicitly requested delegated or parallel agent work.');
    }
    if (!isDeferredWorkloadRun && allowDeferredWorkloadShortcut && hasWorkloadSetupIntent) {
        adjustCandidateToolScore(scoreMap, 'agent-workload', 1.2, 'The request describes future or recurring work.');
    }
    if (remoteToolId && executionProfile === REMOTE_BUILD_EXECUTION_PROFILE) {
        adjustCandidateToolScore(scoreMap, remoteToolId, 0.55, 'Remote-build profile keeps the remote tool available.');
    }
    if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE && hasStructuredRemoteWorkbenchIntent) {
        adjustCandidateToolScore(scoreMap, 'remote-workbench', 0.65, 'The request names a structured remote repo, file, build, test, log, rollout, or verification action.');
    }
    if (hasRemoteCliAgentAuthoringRequest) {
        adjustCandidateToolScore(scoreMap, 'remote-cli-agent', 1.35, 'The request explicitly asks an assisted remote CLI agent to own a coding/build/deploy task.');
        adjustCandidateToolScore(scoreMap, remoteToolId, -0.2, 'The assisted remote CLI agent is a better fit than one-shot remote commands for this authoring loop.');
    }
    if (hasManagedAppIntent) {
        adjustCandidateToolScore(scoreMap, 'managed-app', 1.45, 'GitLab-backed managed apps provide repository, pipeline, registry, and build-event observability.');
        adjustCandidateToolScore(scoreMap, 'remote-cli-agent', -0.25, 'Use direct remote CLI as a fallback after the GitLab control plane is unavailable or blocked.');
    }
    if (hasExplicitWebResearchIntent) {
        adjustCandidateToolScore(scoreMap, 'web-search', 1.0, 'Explicit research language favors search.');
    }
    if (hasExplicitScrapeIntent) {
        adjustCandidateToolScore(scoreMap, 'web-scrape', 1.0, 'Explicit scrape language favors web scraping.');
        adjustCandidateToolScore(scoreMap, 'web-search', 0.4, 'Scrape requests often still need discovery.');
    }
    if (hasUrl) {
        adjustCandidateToolScore(scoreMap, hasExplicitScrapeIntent ? 'web-scrape' : 'web-fetch', 0.9, 'The request includes a direct URL.');
    }
    if (hasImageIntent) {
        adjustCandidateToolScore(scoreMap, 'image-generate', /\b(generate|create|make|design)\b/.test(normalizedPrompt) ? 1.0 : 0.25, 'Image intent is present.');
        adjustCandidateToolScore(scoreMap, 'image-search-unsplash', hasUnsplashIntent ? 1.0 : 0.35, 'Reference-image search may help.');
    }
    if (hasImageUrlIntent || hasDirectImageUrl) {
        adjustCandidateToolScore(scoreMap, 'image-from-url', 1.0, 'The request points at a direct image URL.');
    }
    if (hasAssetCatalogIntent) {
        adjustCandidateToolScore(scoreMap, 'asset-search', 0.95, 'The request refers to a prior or indexed asset.');
        adjustCandidateToolScore(scoreMap, 'file-read', /\b(file|files|context|reference|source material|review|improve|edit|update|change|revise)\b/.test(normalizedPrompt) ? 0.65 : 0, 'Prior files may need to be read as reference context before changing or improving them.');
        adjustCandidateToolScore(scoreMap, 'file-write', /\b(improve|edit|update|change|revise|rewrite|build on|iterate on)\b/.test(normalizedPrompt) ? 0.35 : 0, 'The request may turn old file context into an improved local file.');
    }
    if (hasResearchBucketIntent) {
        adjustCandidateToolScore(scoreMap, 'research-bucket-list', 0.9, 'The request refers to the shared research bucket.');
        adjustCandidateToolScore(scoreMap, 'research-bucket-search', 0.95, 'The request may need lookup in the shared research bucket.');
        adjustCandidateToolScore(scoreMap, 'research-bucket-read', 0.7, 'The request may need selected bucket file contents.');
        adjustCandidateToolScore(scoreMap, 'research-bucket-write', /\b(write|save|add|store|capture|create|update|append)\b/.test(normalizedPrompt) ? 0.85 : 0, 'The request may add material to the shared research bucket.');
        adjustCandidateToolScore(scoreMap, 'research-bucket-mkdir', /\b(mkdir|folder|directory)\b/.test(normalizedPrompt) ? 0.65 : 0, 'The request may create a bucket folder.');
    }
    if (hasPublicSourceIndexIntent) {
        adjustCandidateToolScore(scoreMap, 'public-source-list', 0.85, 'The request refers to the public source index.');
        adjustCandidateToolScore(scoreMap, 'public-source-search', 0.95, 'The request may need lookup in indexed public APIs, dashboards, or feeds.');
        adjustCandidateToolScore(scoreMap, 'public-source-get', 0.65, 'The request may need details for a selected public source.');
        adjustCandidateToolScore(scoreMap, 'public-source-add', /\b(add|save|store|index|catalog|catalogue|create|update)\b/.test(normalizedPrompt) ? 0.85 : 0, 'The request may add a reusable public source.');
        adjustCandidateToolScore(scoreMap, 'public-source-refresh', /\b(refresh|verify|check|validate|probe)\b/.test(normalizedPrompt) ? 0.8 : 0, 'The request may verify a public source endpoint.');
    }
    if (hasPodcastIntent) {
        adjustCandidateToolScore(scoreMap, 'podcast', 1.4, 'Explicit podcast wording should keep the podcast workflow tool in the candidate set.');
        adjustCandidateToolScore(scoreMap, 'web-search', 0.25, 'Podcast production may still need a research fallback when the podcast tool is unavailable.');
    }
    if (rolePipeline?.requiresDesign || hasRole(rolePipeline, ROLE_IDS.DESIGN)) {
        adjustCandidateToolScore(scoreMap, 'design-resource-search', 1.1, 'The active role pipeline includes a design agent that needs curated design references and assets.');
    }
    if (rolePipeline?.requiresSandbox || hasRole(rolePipeline, ROLE_IDS.QA)) {
        adjustCandidateToolScore(scoreMap, 'code-sandbox', 0.95, 'The active role pipeline requires a previewable sandbox project for website, dashboard, app, or game output.');
        adjustCandidateToolScore(scoreMap, DOCUMENT_WORKFLOW_TOOL_ID, 1.05, 'The active role pipeline should build the deliverable through the document workflow with sandbox output.');
        adjustCandidateToolScore(scoreMap, 'web-scrape', 0.45, 'The QA role can use Playwright browser screenshots for desktop and mobile UI self-checks.');
    }
    if (workflowNeedsRepoLane && remoteToolId) {
        adjustCandidateToolScore(scoreMap, remoteToolId, 1.05, 'Repository work in remote-build mode should use the remote CLI lane.');
    }
    if (explicitGitIntent || workflowNeedsDeployLane) {
        adjustCandidateToolScore(scoreMap, 'git-safe', 0.75, 'Git state or save flow is relevant.');
    }
    if (explicitK3sDeployIntent || workflowNeedsDeployLane) {
        adjustCandidateToolScore(scoreMap, 'k3s-deploy', 0.95, 'Deployment tooling is relevant.');
    }
    if (!shouldPreferRemoteWebsiteSource && /\b(write|save|create|update|edit)\b/.test(normalizedPrompt)) {
        adjustCandidateToolScore(scoreMap, 'file-write', 0.45, 'Local file editing is explicitly requested.');
    }
    if (!shouldPreferRemoteWebsiteSource && /\b(create|make|mkdir)\b/.test(normalizedPrompt)) {
        adjustCandidateToolScore(scoreMap, 'file-mkdir', 0.35, 'Directory creation is explicitly requested.');
    }
    if (!sessionIsolation) {
        adjustCandidateToolScore(scoreMap, 'agent-notes-write', /\b(preference|remember|note for later|carryover|future sessions?|between sessions?|personal agent|know me|understand me|work with me)\b/.test(normalizedPrompt) ? 0.7 : 0, 'Durable carryover notes may help later sessions.');
    }
    if (hasArchitectureIntent) {
        adjustCandidateToolScore(scoreMap, 'architecture-design', 1.0, 'Architecture intent is explicit.');
    }
    if (hasUmlIntent) {
        adjustCandidateToolScore(scoreMap, 'uml-generate', 1.0, 'Diagram intent is explicit.');
    }
    if (hasApiIntent) {
        adjustCandidateToolScore(scoreMap, 'api-design', 1.0, 'API design intent is explicit.');
    }
    if (hasSchemaIntent) {
        adjustCandidateToolScore(scoreMap, 'schema-generate', 1.0, 'Schema design intent is explicit.');
    }
    if (hasMigrationChangeIntent) {
        adjustCandidateToolScore(scoreMap, 'migration-create', 1.0, 'Migration intent is explicit.');
    }
    if (hasSecurityIntent) {
        adjustCandidateToolScore(scoreMap, 'security-scan', 1.0, 'Security review intent is explicit.');
    }

    if (classificationConfidence < 0.72 && hasHighImpactDecisionGateText(normalizedPrompt)) {
        adjustCandidateToolScore(scoreMap, USER_CHECKPOINT_TOOL_ID, canUseUserCheckpoint ? 0.12 : 0, 'Lower classifier confidence can justify a checkpoint only when the decision is high-impact.');
    }

    failedToolIds.forEach((toolId) => {
        adjustCandidateToolScore(scoreMap, toolId, -0.35, 'Recent tool failures reduce immediate reuse confidence.');
    });

    return scoreMap;
}

function selectCandidateToolIdsFromScores(allowedToolIds = [], scoreMap = {}) {
    const scored = allowedToolIds
        .map((toolId) => ({
            toolId,
            score: Number(scoreMap?.[toolId]?.score || 0),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);

    const selected = scored
        .filter((entry, index) => entry.score >= 0.72 || index < 4)
        .map((entry) => entry.toolId);

    return Array.from(new Set(selected));
}

function shouldAllowDirectAction(action = null, { toolPolicy = {}, toolEvents = [] } = {}) {
    if (!action || !isJudgmentV2Enabled()) {
        return Boolean(action);
    }

    const classification = toolPolicy?.classification || null;
    if (!classification) {
        return true;
    }

    if (classification.checkpointNeed === 'required') {
        return false;
    }

    if (classification.confidence < 0.76) {
        return false;
    }

    if (classification.groundingRequirement === 'required') {
        if (['web-search', 'web-fetch', 'web-scrape'].includes(action.tool)) {
            return true;
        }

        if (action.tool === 'podcast') {
            return true;
        }

        if (action.tool === DOCUMENT_WORKFLOW_TOOL_ID) {
            return hasGroundedResearchToolResult(toolEvents);
        }

        return false;
    }

    if (classification.preferredExecutionPath === 'plan-first') {
        return ['web-search', 'web-fetch', 'web-scrape', 'agent-workload'].includes(action.tool);
    }

    return true;
}

function reviewExecutionRound({
    round = 0,
    nextPlan = [],
    roundToolEvents = [],
    roundFailureSummary = null,
    autonomyApproved = false,
    budgetExceeded = false,
    toolPolicy = {},
    endToEndWorkflow = null,
} = {}) {
    if (!isJudgmentV2Enabled()) {
        return null;
    }

    const classification = toolPolicy?.classification || {};
    const progress = summarizeAutonomyProgress(roundToolEvents, roundFailureSummary);

    if (budgetExceeded) {
        return {
            decision: 'stop',
            reason: 'The round exhausted the available execution budget.',
        };
    }

    if (endToEndWorkflow?.status === 'completed') {
        return {
            decision: 'stop',
            reason: 'The active workflow completed during this round.',
        };
    }

    if (roundFailureSummary?.blockingFailures?.length > 0) {
        return {
            decision: 'stop',
            reason: 'The round hit a blocking failure that requires a different input or external fix.',
        };
    }

    if (roundFailureSummary?.recoverableFailures?.length > 0 && progress.productive === false) {
        return {
            decision: 'replan',
            reason: 'The round encountered recoverable failures without enough progress, so a replan is safer than synthesis.',
        };
    }

    if (classification.groundingRequirement === 'required'
        && hasGroundedResearchToolResult(roundToolEvents)
        && classification.taskFamily !== 'research-deliverable') {
        return {
            decision: 'synthesize',
            reason: 'Grounded evidence was gathered, so the runtime can answer without another speculative round.',
        };
    }

    if (!autonomyApproved && progress.productive) {
        return {
            decision: 'synthesize',
            reason: 'The round made useful progress and the runtime is not in multi-round autonomous mode.',
        };
    }

    if (autonomyApproved && progress.productive && !planSignalsFurtherAutonomousWork(nextPlan)) {
        return {
            decision: 'continue',
            reason: `Round ${round} made productive progress and the autonomous runtime can continue from the updated state.`,
        };
    }

    if (roundToolEvents.length === 0) {
        return {
            decision: 'stop',
            reason: 'The round produced no tool progress.',
        };
    }

    return {
        decision: autonomyApproved ? 'continue' : 'stop',
        reason: autonomyApproved
            ? 'Keep iterating while the active autonomous run is still making progress.'
            : 'No stronger post-round action was identified.',
    };
}

function summarizeRecallTrace(memoryTrace = null) {
    if (!memoryTrace || typeof memoryTrace !== 'object') {
        return null;
    }

    return {
        query: memoryTrace.query || '',
        matchedKeywords: Array.isArray(memoryTrace.matchedKeywords) ? memoryTrace.matchedKeywords.slice(0, 8) : [],
        counts: memoryTrace.counts || {},
        bundles: memoryTrace.bundles || {},
        routing: memoryTrace.routing || null,
    };
}

function inferFinalizationMode({ runtimeMode = '', toolEvents = [], assistantMetadata = null } = {}) {
    if (assistantMetadata?.finalizationMode) {
        return assistantMetadata.finalizationMode;
    }

    if (assistantMetadata?.workflowBlocked) {
        return 'workflow-blocked';
    }

    if (assistantMetadata?.terminalWorkloadCreation) {
        return 'terminal-workload';
    }

    if (runtimeMode === 'repaired-final') {
        return 'repair';
    }

    if (runtimeMode === 'checkpoint-stop' || runtimeMode === 'budget-checkpoint') {
        return 'checkpoint';
    }

    return Array.isArray(toolEvents) && toolEvents.length > 0
        ? 'tool-synthesis'
        : 'direct-response';
}

function extractLatestReplanReason(executionTrace = []) {
    const entries = Array.isArray(executionTrace) ? executionTrace : [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        const reason = String(
            entry?.details?.replanReason
            || entry?.details?.reason
            || '',
        ).trim();
        if (reason && ['replan', 'review'].includes(String(entry?.type || '').trim().toLowerCase())) {
            return reason;
        }
    }

    return null;
}

function resolveRoleExecutionOptions({
    role = 'direct',
    model = null,
    reasoningEffort = null,
    toolPolicy = {},
    toolEvents = [],
} = {}) {
    const orchestrationConfig = getEffectiveOrchestrationConfig();
    const useOrchestrationConfig = isJudgmentV2Enabled() && orchestrationConfig?.enabled !== false;
    if (!useOrchestrationConfig) {
        return {
            model,
            reasoningEffort,
        };
    }

    const classification = toolPolicy?.classification || {};
    const explicitReasoning = String(reasoningEffort || '').trim();
    const roleModelKey = role === 'planner'
        ? 'plannerModel'
        : (role === 'repair' ? 'repairModel' : 'synthesisModel');
    const roleReasoningKey = role === 'planner'
        ? 'plannerReasoningEffort'
        : (role === 'repair' ? 'repairReasoningEffort' : 'synthesisReasoningEffort');
    const configuredModel = String(
        config.runtime?.[roleModelKey]
        || orchestrationConfig?.[roleModelKey]
        || orchestrationConfig?.defaultModel
        || '',
    ).trim() || model || null;
    const configuredReasoning = String(
        config.runtime?.[roleReasoningKey]
        || orchestrationConfig?.[roleReasoningKey]
        || '',
    ).trim();
    const ambiguous = classification?.ambiguous === true || Number(classification?.confidence || 0) < 0.72;
    const toolHeavy = Array.isArray(toolEvents) && toolEvents.length >= 3;
    const defaultReasoning = role === 'planner'
        ? 'high'
        : (role === 'repair'
            ? (ambiguous || toolHeavy ? 'high' : 'medium')
            : (ambiguous || toolHeavy ? 'medium' : 'low'));

    return {
        model: configuredModel,
        reasoningEffort: explicitReasoning || configuredReasoning || defaultReasoning,
        fallbackModels: Array.isArray(orchestrationConfig?.fallbackModels)
            ? orchestrationConfig.fallbackModels
            : [],
    };
}

function normalizeUserCheckpointPlanOption(option = {}) {
    if (typeof option === 'string') {
        const label = option.trim();
        return label ? { label } : null;
    }

    if (!option || typeof option !== 'object') {
        return null;
    }

    const label = typeof option.label === 'string'
        ? option.label.trim()
        : (typeof option.title === 'string'
            ? option.title.trim()
            : (typeof option.text === 'string' ? option.text.trim() : ''));
    if (!label) {
        return null;
    }

    const description = typeof option.description === 'string'
        ? option.description.trim()
        : (typeof option.details === 'string' ? option.details.trim() : '');
    const id = typeof option.id === 'string' ? option.id.trim() : '';

    return {
        ...(id ? { id } : {}),
        label,
        ...(description ? { description } : {}),
    };
}

function normalizeUserCheckpointPlanStep(step = {}) {
    if (!step || typeof step !== 'object') {
        return null;
    }

    const question = typeof step.question === 'string'
        ? step.question.trim()
        : (typeof step.prompt === 'string'
            ? step.prompt.trim()
            : (typeof step.ask === 'string' ? step.ask.trim() : ''));
    if (!question) {
        return null;
    }

    const rawOptions = Array.isArray(step.options)
        ? step.options
        : (Array.isArray(step.choices) ? step.choices : []);
    const options = rawOptions
        .map((option) => normalizeUserCheckpointPlanOption(option))
        .filter(Boolean)
        .slice(0, 4);
    const inputType = typeof step.inputType === 'string'
        ? step.inputType.trim()
        : (typeof step.type === 'string'
            ? step.type.trim()
            : (typeof step.kind === 'string' ? step.kind.trim() : ''));
    const title = typeof step.title === 'string' ? step.title.trim() : '';
    const placeholder = typeof step.placeholder === 'string'
        ? step.placeholder.trim()
        : (typeof step.inputPlaceholder === 'string'
            ? step.inputPlaceholder.trim()
            : '');
    const freeTextLabel = typeof step.freeTextLabel === 'string'
        ? step.freeTextLabel.trim()
        : (typeof step.freeTextPrompt === 'string'
            ? step.freeTextPrompt.trim()
            : '');
    const id = typeof step.id === 'string' ? step.id.trim() : '';

    return {
        ...(id ? { id } : {}),
        ...(title ? { title } : {}),
        question,
        ...(inputType ? { inputType } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(typeof step.required === 'boolean' ? { required: step.required } : {}),
        ...(typeof step.allowMultiple === 'boolean' ? { allowMultiple: step.allowMultiple } : {}),
        ...(typeof step.multiple === 'boolean' ? { allowMultiple: step.multiple } : {}),
        ...(Number.isFinite(Number(step.maxSelections)) ? { maxSelections: Number(step.maxSelections) } : {}),
        ...(typeof step.allowFreeText === 'boolean' ? { allowFreeText: step.allowFreeText } : {}),
        ...(typeof step.allowText === 'boolean' ? { allowFreeText: step.allowText } : {}),
        ...(freeTextLabel ? { freeTextLabel } : {}),
        ...(options.length > 0 ? { options } : {}),
    };
}

function normalizeUserCheckpointPlanParams(step = {}) {
    const rawParams = step?.params && typeof step.params === 'object'
        ? { ...step.params }
        : {};
    const normalizedSteps = (Array.isArray(rawParams.steps) ? rawParams.steps : [])
        .map((entry) => normalizeUserCheckpointPlanStep(entry))
        .filter(Boolean)
        .slice(0, 6);
    const legacyStep = normalizeUserCheckpointPlanStep(rawParams);
    const baseParams = {
        ...rawParams,
        ...(typeof rawParams.title === 'string' && rawParams.title.trim()
            ? { title: rawParams.title.trim() }
            : {}),
        ...(typeof rawParams.preamble === 'string' && rawParams.preamble.trim()
            ? { preamble: rawParams.preamble.trim() }
            : {}),
        ...(typeof rawParams.whyThisMatters === 'string' && rawParams.whyThisMatters.trim()
            ? { whyThisMatters: rawParams.whyThisMatters.trim() }
            : {}),
        ...(normalizedSteps.length > 0
            ? { steps: normalizedSteps }
            : (legacyStep || {})),
    };

    try {
        const normalized = normalizeCheckpointRequest(baseParams);
        const { id: _unusedId, ...normalizedParams } = normalized;
        return normalizedParams;
    } catch (_error) {
        return baseParams;
    }
}

function normalizeArchitectureDesignPlanParams(step = {}, { objective = '' } = {}) {
    const params = step?.params && typeof step.params === 'object'
        ? { ...step.params }
        : {};
    const requirements = [
        params.requirements,
        params.request,
        params.prompt,
        params.description,
        params.brief,
        objective,
    ].find((value) => typeof value === 'string' && value.trim());

    if (requirements) {
        params.requirements = requirements.trim();
    }

    return params;
}

function inferRecallProfileFromText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return 'default';
    }

    return /\b(web research|research|look up|search for|search the web|browse the web|search online|browse online|latest|current|today|news|headlines?|weather|forecast|temperature)\b/.test(normalized)
        ? 'research'
        : 'default';
}

function normalizeResearchFollowupPageCount() {
    return Math.max(2, Math.min(config.memory.researchFollowupPages, 8));
}

function normalizeResearchSearchResultCount() {
    return Math.max(8, Math.min(config.memory.researchSearchLimit, config.search.maxLimit));
}

function inferResearchTimeRangeFromText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return 'all';
    }

    if (/\b(today|latest|current|breaking|news|headlines?|weather|forecast|temperature)\b/.test(normalized)) {
        return 'day';
    }

    if (/\b(this week|weekly|past week|last week)\b/.test(normalized)) {
        return 'week';
    }

    if (/\b(this month|monthly|past month|last month)\b/.test(normalized)) {
        return 'month';
    }

    return 'all';
}

function inferPerplexityResearchModeFromText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return 'search';
    }

    if (/\b(advanced deep research|institutional(?:-|\s)grade research|maximum depth research|maximum-depth research)\b/.test(normalized)) {
        return 'advanced-deep-research';
    }

    if (/\b(deep research|in-depth research|comprehensive research|exhaustive research|thorough research)\b/.test(normalized)) {
        return 'sonar-deep-research';
    }

    if (/\b(pro search|agentic research|autonomous research|multi-tool research|plan\s*\+\s*search\s*\+\s*fetch|one-call research|one call research)\b/.test(normalized)) {
        return 'pro-search';
    }

    if (/\b(grounded answer|answer with citations|one-shot answer|one shot answer|with citations)\b/.test(normalized)) {
        return 'sonar-pro';
    }

    return 'search';
}

function inferWebSearchLocaleParamsFromText(text = '', query = '') {
    const source = `${text || ''} ${query || ''}`.toLowerCase();
    if (!source.trim()) {
        return {};
    }

    const isWeatherRequest = /\b(weather|forecast|temperature|conditions|warnings?)\b/.test(source);
    const mentionsNovaScotia = /\b(nova scotia|ns|halifax|dartmouth|bedford|sackville|truro|sydney|cape breton|yarmouth)\b/.test(source);
    const mentionsCanada = /\b(canada|canadian|environment canada|eccc|environment and climate change canada)\b/.test(source);

    if (!isWeatherRequest || (!mentionsNovaScotia && !mentionsCanada)) {
        return {};
    }

    const city = /\bhalifax\b/.test(source)
        ? 'Halifax'
        : /\bdartmouth\b/.test(source)
            ? 'Dartmouth'
            : '';
    const rawQuery = String(query || text || '').trim();
    const needsCanadaQualifier = rawQuery && !/\b(canada|canadian|nova scotia|environment canada|eccc|environment and climate change canada)\b/i.test(rawQuery);

    return {
        ...(rawQuery
            ? { query: needsCanadaQualifier ? `${rawQuery} Nova Scotia Environment Canada weather` : rawQuery }
            : {}),
        region: 'ca-en',
        domains: ['weather.gc.ca'],
        userLocation: {
            country: 'CA',
            region: mentionsNovaScotia ? 'NS' : '',
            city,
        },
    };
}

function extractExplicitWebResearchQuery(text = '') {
    const prompt = String(text || '').trim();
    if (!prompt) {
        return null;
    }

    const patterns = [
        /\b(?:do|perform|run)\s+research\s+(?:on|about|into)?\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\bweb research\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\bresearch\s+(?:on|about|into)?\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\blook up\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\bsearch for\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\bsearch the web for\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
    ];

    for (const pattern of patterns) {
        const match = prompt.match(pattern);
        if (match?.[1]) {
            return match[1].trim().replace(/[.?!]+$/g, '').trim();
        }
    }

    if (!hasExplicitWebResearchIntentText(prompt)) {
        return null;
    }

    return prompt
        .replace(/^(please|can you|could you|would you|help me|i need you to)\s+/i, '')
        .replace(/[.?!]+$/g, '')
        .trim();
}

function extractImplicitCurrentInfoQuery(text = '') {
    const prompt = String(text || '').trim();
    if (!prompt || !hasCurrentInfoIntentText(prompt)) {
        return null;
    }

    return prompt
        .replace(/^(please|can you|could you|would you|help me|i need you to|tell me|show me|find me|get me)\s+/i, '')
        .replace(/[.?!]+$/g, '')
        .trim();
}

function extractObjective(input = null, fallback = '') {
    if (typeof fallback === 'string' && fallback.trim()) {
        return fallback.trim();
    }

    if (typeof input === 'string') {
        return input.trim();
    }

    if (!Array.isArray(input)) {
        return '';
    }

    const lastUserMessage = input.filter((message) => message?.role === 'user').pop();
    return normalizeMessageText(lastUserMessage?.content || '').trim();
}

function unwrapCodeFence(text = '') {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : trimmed;
}

function safeJsonParse(text = '') {
    return parseLenientJson(unwrapCodeFence(text));
}

function truncateText(value = '', limit = MAX_TOOL_RESULT_CHARS) {
    const text = String(value || '');
    if (text.length <= limit) {
        return text;
    }

    return `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
}

function truncateProgressStepTitle(value = '', limit = 160) {
    const text = normalizeInlineText(value);
    const maxLength = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Number(limit)
        : 160;
    if (!text || text.length <= maxLength) {
        return text;
    }

    const clipped = text.slice(0, maxLength).trimEnd();
    const minSentenceLength = Math.min(
        Math.max(18, Math.floor(maxLength * 0.22)),
        Math.max(1, maxLength - 1),
    );
    const sentenceMatches = [...clipped.matchAll(/[.!?](?=\s|$)/g)];
    const sentenceBoundary = sentenceMatches
        .map((match) => match.index + 1)
        .filter((index) => index >= minSentenceLength)
        .pop();
    if (sentenceBoundary) {
        return clipped.slice(0, sentenceBoundary).trim();
    }

    const minBreakLength = Math.min(
        Math.max(24, Math.floor(maxLength * 0.68)),
        Math.max(1, maxLength - 1),
    );
    const breakMatches = [...clipped.matchAll(/[\s,;:-]/g)];
    const readableBoundary = breakMatches
        .map((match) => match.index)
        .filter((index) => index >= minBreakLength)
        .pop();
    const readableClip = readableBoundary
        ? clipped.slice(0, readableBoundary)
        : clipped;
    return readableClip.replace(/[\s,;:.-]+$/g, '').trim()
        || clipped.trim();
}

function stripHtmlToText(html = '') {
    return String(html || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractFetchBodyText(result = {}) {
    const body = String(result?.data?.body || '').trim();
    if (!body) {
        return '';
    }

    return /<html\b|<body\b|<article\b|<main\b|<section\b/i.test(body)
        ? stripHtmlToText(body)
        : body.replace(/\s+/g, ' ').trim();
}

function removeLeadingHtmlTitle(text = '', title = '') {
    const normalizedText = normalizeInlineText(text);
    const normalizedTitle = normalizeInlineText(title);
    if (!normalizedText || !normalizedTitle) {
        return normalizedText;
    }

    const escapedTitle = normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return normalizedText
        .replace(new RegExp(`^${escapedTitle}(?:\\s*[\\-:|]\\s*|\\s+)`, 'i'), '')
        .trim();
}

function extractFetchSummaryText(data = {}) {
    const body = String(data?.body || '').trim();
    if (!body) {
        return '';
    }

    const title = normalizeInlineText(data?.title || extractHtmlTitle(body));
    const rawText = /<html\b|<body\b|<article\b|<main\b|<section\b/i.test(body)
        ? stripHtmlToText(body)
        : body.replace(/\s+/g, ' ').trim();
    const cleaned = removeLeadingHtmlTitle(rawText, title);

    return normalizeInlineText(cleaned || rawText);
}

function normalizeInlineText(value = '', seen = null) {
    if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value
            .map((entry) => normalizeInlineText(entry, seen))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    if (!value || typeof value !== 'object') {
        return '';
    }

    const visited = seen || new WeakSet();
    if (visited.has(value)) {
        return '';
    }
    visited.add(value);

    for (const key of ['summary', 'detail', 'message', 'text', 'content', 'title', 'label', 'reason', 'description', 'name', 'value']) {
        const extracted = normalizeInlineText(value[key], visited);
        if (extracted) {
            return extracted;
        }
    }

    try {
        const serialized = JSON.stringify(value);
        return serialized && serialized !== '{}' ? serialized.replace(/\s+/g, ' ').trim() : '';
    } catch (_error) {
        return '';
    }
}

function deriveSourceLabel(url = '', fallback = '') {
    if (fallback) {
        return String(fallback).trim();
    }

    try {
        return new URL(String(url || '')).hostname.replace(/^www\./i, '');
    } catch (_error) {
        return '';
    }
}

function extractHtmlTitle(html = '') {
    const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return normalizeInlineText(match?.[1] || '');
}

function summarizeSearchResults(results = []) {
    if (!Array.isArray(results) || results.length === 0) {
        return '';
    }

    return results
        .slice(0, 3)
        .map((entry, index) => {
            const title = truncateText(normalizeInlineText(entry?.title || 'Untitled result'), 100);
            const url = String(entry?.url || '').trim();
            const source = deriveSourceLabel(url, entry?.source);
            const snippet = truncateText(normalizeInlineText(entry?.snippet || ''), 160);

            return [
                `${index + 1}. ${title}`,
                source ? `(${source})` : '',
                snippet ? `- ${snippet}` : '',
                url ? `[${url}]` : '',
            ].filter(Boolean).join(' ');
        })
        .join(' ');
}

function summarizeFetchedContent(data = {}) {
    const url = String(data?.url || '').trim();
    const status = Number.isFinite(Number(data?.status)) ? Number(data.status) : null;
    const statusText = normalizeInlineText(data?.statusText || '');
    const body = typeof data?.body === 'string' ? data.body : '';
    const contentType = String(data?.headers?.['content-type'] || data?.headers?.['Content-Type'] || '').trim().toLowerCase();
    const title = normalizeInlineText(data?.title || extractHtmlTitle(body));
    const rawSummary = contentType.includes('html')
        ? extractFetchSummaryText(data)
        : body.replace(/\s+/g, ' ').trim();
    const bodyPreview = truncateText(normalizeInlineText(rawSummary), 220);

    return [
        status != null ? `${status}${statusText ? ` ${statusText}` : ''}.` : '',
        title ? `Title: ${truncateText(title, 120)}.` : '',
        bodyPreview ? `Summary: ${bodyPreview}.` : '',
        url ? `Source: ${url}.` : '',
    ].filter(Boolean).join(' ');
}

function summarizeObjectData(data = {}) {
    if (!data || typeof data !== 'object') {
        return '';
    }

    const preferredKeys = ['title', 'url', 'status', 'statusText', 'message', 'summary', 'text', 'content'];
    const pairs = preferredKeys
        .filter((key) => data[key] != null && typeof data[key] !== 'object')
        .slice(0, 4)
        .map((key) => `${key}: ${truncateText(normalizeInlineText(data[key]), 120)}`);

    if (pairs.length > 0) {
        return pairs.join('; ');
    }

    return truncateText(normalizeInlineText(JSON.stringify(data)), 220);
}

function summarizeAssetSearchResults(data = {}) {
    const results = Array.isArray(data?.results) ? data.results : [];
    const count = Number.isFinite(Number(data?.count)) ? Number(data.count) : results.length;
    if (count <= 0) {
        return '';
    }

    const preview = results
        .slice(0, 3)
        .map((entry) => {
            const title = normalizeInlineText(entry?.title || entry?.filename || entry?.relativePath || entry?.absolutePath || entry?.id || '');
            const kind = normalizeInlineText(entry?.kind || entry?.sourceType || '');
            return [title, kind ? `(${kind})` : ''].filter(Boolean).join(' ');
        })
        .filter(Boolean)
        .join('; ');

    return [
        `${count} match${count === 1 ? '' : 'es'}`,
        preview ? `top results: ${preview}` : '',
    ].filter(Boolean).join('; ');
}

function summarizeDocumentWorkflowOutput(data = {}) {
    const document = data?.document && typeof data.document === 'object'
        ? data.document
        : data;
    if (!document || typeof document !== 'object') {
        return '';
    }

    const filename = normalizeInlineText(document?.filename || '');
    const mimeType = normalizeInlineText(document?.mimeType || '');
    const downloadUrl = normalizeInlineText(document?.downloadUrl || '');
    const preview = truncateText(normalizeInlineText(
        document?.contentPreview
        || document?.preview?.content
        || document?.preview?.summary
        || data?.message
        || '',
    ), 220);

    return [
        filename ? `created ${filename}` : '',
        mimeType ? `type: ${mimeType}` : '',
        downloadUrl ? `download: ${downloadUrl}` : '',
        preview ? `preview: ${preview}` : '',
    ].filter(Boolean).join('; ');
}

function deriveResearchSourceLabel(url = '', fallback = '') {
    const normalizedFallback = normalizeInlineText(fallback || '');
    if (normalizedFallback) {
        return normalizedFallback;
    }

    try {
        return new URL(String(url || '')).hostname.replace(/^www\./i, '');
    } catch (_error) {
        return '';
    }
}

function findSearchResultByUrl(searchResults = [], url = '') {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl || !Array.isArray(searchResults)) {
        return null;
    }

    return searchResults.find((entry) => String(entry?.url || '').trim() === normalizedUrl) || null;
}

function extractResearchSourceExcerpt(event = {}) {
    const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
    const data = event?.result?.data || {};
    const excerptLimit = config.memory.researchSourceExcerptChars;

    if (toolId === 'web-fetch') {
        return truncateText(normalizeInlineText(extractFetchSummaryText(data)), excerptLimit);
    }

    if (toolId === 'web-scrape') {
        const direct = [
            data?.summary,
            data?.text,
            data?.content,
            data?.markdown,
        ].find((value) => typeof value === 'string' && value.trim());

        if (direct) {
            return truncateText(normalizeInlineText(direct), excerptLimit);
        }

        return truncateText(normalizeInlineText(stripHtmlToText(JSON.stringify(data?.data || {}))), excerptLimit);
    }

    return truncateText(normalizeInlineText(extractFetchBodyText(event?.result || {})), excerptLimit);
}

function shouldIncludeDocumentWorkflowContent(text = '') {
    return /\b(html|markdown|md)\b/i.test(String(text || ''))
        && /\b(file|page|write|save|inject|local)\b/i.test(String(text || ''));
}

function normalizeDocumentRequestFormat(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return '';
    }

    if (['powerpoint', 'ppt', 'pptx', 'slides', 'slide deck', 'deck'].includes(normalized)) {
        return 'pptx';
    }
    if (['pdf'].includes(normalized)) {
        return 'pdf';
    }
    if (['html', 'web page', 'webpage', 'website', 'landing page'].includes(normalized)) {
        return 'html';
    }
    if (['markdown', 'md'].includes(normalized)) {
        return 'md';
    }
    if (['excel', 'xlsx', 'spreadsheet', 'workbook'].includes(normalized)) {
        return 'xlsx';
    }
    if (['doc', 'docx', 'word', 'word document'].includes(normalized)) {
        return 'html';
    }

    return normalized;
}

function inferDocumentWorkflowFormatsFromText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return [];
    }

    const formats = new Set();
    if (/\bpdf\b|\.pdf\b/.test(normalized)) {
        formats.add('pdf');
    }
    if (/\b(?:powerpoint|pptx?|slide deck|slides?|deck)\b/.test(normalized)) {
        formats.add('pptx');
    }
    if (/\b(?:html|web page|webpage|landing page|site page)\b/.test(normalized)) {
        formats.add('html');
    }
    if (/\b(?:markdown|md)\b/.test(normalized)) {
        formats.add('md');
    }
    if (/\b(?:excel|xlsx|spreadsheet|workbook)\b/.test(normalized)) {
        formats.add('xlsx');
    }
    if (/\b(?:docx|word document)\b/.test(normalized)) {
        formats.add('html');
    }

    const explicitFormatList = normalized.match(/\b(?:formats?|outputs?|exports?)\s*[:=]?\s*([a-z0-9,\/+\s-]{3,80})/i);
    if (explicitFormatList?.[1]) {
        explicitFormatList[1]
            .split(/[,/+&]|\band\b|\bplus\b/gi)
            .map((entry) => normalizeDocumentRequestFormat(entry))
            .filter(Boolean)
            .forEach((format) => formats.add(format));
    }

    return Array.from(formats);
}

function hasDocumentSuiteIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(package|suite|bundle|multi[-\s]?format|multiple formats?|all formats?|export package|deliverables?|kit)\b/.test(normalized)
        || /\b(?:pdf|pptx?|powerpoint|slides?|deck|html|markdown|md|xlsx|spreadsheet)\b[\s\S]{0,80}\b(?:and|plus|with|alongside|together with)\b[\s\S]{0,80}\b(?:pdf|pptx?|powerpoint|slides?|deck|html|markdown|md|xlsx|spreadsheet)\b/.test(normalized);
}

function shouldAddWebChatHtmlPreview({ clientSurface = '', formats = [], objective = '' } = {}) {
    const normalizedSurface = String(clientSurface || '').trim().toLowerCase();
    if (normalizedSurface !== 'web-chat') {
        return false;
    }

    const requested = new Set(Array.isArray(formats) ? formats : []);
    if (requested.has('html')) {
        return false;
    }

    return requested.has('pdf')
        || requested.has('pptx')
        || requested.has('xlsx')
        || /\b(pdf|pptx?|powerpoint|slide deck|slides?|deck|spreadsheet|xlsx|workbook)\b/i.test(String(objective || ''));
}

function buildDocumentWorkflowFormatPlan({ objective = '', clientSurface = '' } = {}) {
    const websiteBuild = hasWebsiteBuildIntent(objective);
    const explicitFormats = websiteBuild
        ? ['html']
        : inferDocumentWorkflowFormatsFromText(objective);
    const formats = Array.from(new Set(explicitFormats.filter(Boolean)));

    if (shouldAddWebChatHtmlPreview({ clientSurface, formats, objective })) {
        formats.push('html');
    }

    const suiteIntent = websiteBuild
        || hasDocumentSuiteIntent(objective)
        || formats.length > 1
        || (String(clientSurface || '').trim().toLowerCase() === 'web-chat' && formats.includes('html') && formats.some((format) => format !== 'html'));
    const useSandbox = formats.includes('html') && (
        websiteBuild
        || hasDocumentSuiteIntent(objective)
        || shouldAddWebChatHtmlPreview({ clientSurface, formats: explicitFormats, objective })
    );

    return {
        websiteBuild,
        formats,
        suiteIntent,
        useSandbox,
    };
}

function buildDesignResourceSearchParams({ objective = '', rolePipeline = null } = {}) {
    const websiteBuild = hasWebsiteBuildIntent(objective) || rolePipeline?.requiresSandbox === true;
    const surface = websiteBuild
        ? 'website'
        : (hasDocumentWorkflowIntentText(objective) ? 'document' : undefined);
    return {
        action: 'search',
        query: normalizeInlineText(objective) || 'design resources',
        ...(surface ? { surface } : {}),
        limit: 6,
    };
}

function buildDesignResourceSourceContent(resource = {}) {
    const bestFor = Array.isArray(resource.bestFor) ? resource.bestFor.filter(Boolean).join(', ') : '';
    const formats = Array.isArray(resource.formats) ? resource.formats.filter(Boolean).join(', ') : '';
    const domains = Array.isArray(resource.domains) ? resource.domains.filter(Boolean).join(', ') : '';
    const safetyNotes = Array.isArray(resource.safetyNotes) ? resource.safetyNotes.filter(Boolean).join('; ') : '';
    return [
        resource.description ? `Description: ${normalizeInlineText(resource.description)}` : '',
        bestFor ? `Best for: ${normalizeInlineText(bestFor)}` : '',
        formats ? `Formats: ${normalizeInlineText(formats)}` : '',
        domains ? `Approved domains: ${normalizeInlineText(domains)}` : '',
        resource.attribution ? `Attribution: ${normalizeInlineText(resource.attribution)}` : '',
        resource.license ? `License: ${normalizeInlineText(resource.license)}` : '',
        safetyNotes ? `Safety notes: ${normalizeInlineText(safetyNotes)}` : '',
    ].filter(Boolean).join('\n');
}

function buildDocumentWorkflowSourcesFromToolEvents(toolEvents = []) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const lastSearchEvent = getLastSuccessfulToolEvent(events, 'web-search');
    const searchResults = Array.isArray(lastSearchEvent?.result?.data?.results)
        ? lastSearchEvent.result.data.results
        : [];
    const sources = [];
    const seen = new Set();

    for (const event of events) {
        const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
        if (!['web-fetch', 'web-scrape'].includes(toolId) || event?.result?.success === false) {
            continue;
        }

        const data = event?.result?.data || {};
        const args = parseToolCallArguments(event?.toolCall?.function?.arguments || '{}');
        const url = String(data?.url || args?.url || '').trim();
        const searchResult = findSearchResultByUrl(searchResults, url);
        const title = normalizeInlineText(data?.title || searchResult?.title || url || `${toolId} source`);
        const sourceLabel = deriveResearchSourceLabel(url, searchResult?.source || data?.source || '');
        const excerpt = extractResearchSourceExcerpt(event);
        const snippet = truncateText(normalizeInlineText(searchResult?.snippet || data?.summary || ''), 260);
        const content = [
            snippet ? `Search snippet: ${snippet}` : '',
            excerpt ? `Verified content: ${excerpt}` : '',
        ].filter(Boolean).join('\n\n').trim();
        const dedupeKey = url || `${title}:${content}`;

        if (!content || seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);
        sources.push({
            id: `verified-source-${sources.length + 1}`,
            title: title || `Verified source ${sources.length + 1}`,
            sourceLabel,
            sourceUrl: url,
            kind: toolId,
            content,
        });

        if (sources.length >= 6) {
            break;
        }
    }

    for (const event of events) {
        const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
        if (toolId !== 'design-resource-search' || event?.result?.success === false) {
            continue;
        }

        const results = Array.isArray(event?.result?.data?.results)
            ? event.result.data.results
            : [];

        for (const resource of results.slice(0, 4)) {
            const id = String(resource?.id || '').trim();
            const title = normalizeInlineText(resource?.name || resource?.title || id || 'Design resource');
            const fetchUrl = String(resource?.fetchPlan?.params?.url || resource?.docsUrl || resource?.apiUrl || '').trim();
            const content = buildDesignResourceSourceContent(resource);
            const dedupeKey = id || fetchUrl || `${title}:${content}`;

            if (!content || seen.has(dedupeKey)) {
                continue;
            }

            seen.add(dedupeKey);
            sources.push({
                id: `design-resource-${sources.length + 1}`,
                title,
                sourceLabel: resource?.provider
                    ? `Design resource: ${resource.provider}`
                    : 'Design resource index',
                sourceUrl: fetchUrl,
                kind: 'design-resource-search',
                content,
            });

            if (sources.length >= 8) {
                break;
            }
        }

        if (sources.length >= 8) {
            break;
        }
    }

    return sources;
}

function buildDocumentWorkflowGenerateParams({ objective = '', toolEvents = [], clientSurface = '' } = {}) {
    const formatPlan = buildDocumentWorkflowFormatPlan({
        objective,
        clientSurface,
    });
    const params = {
        action: formatPlan.suiteIntent ? 'generate-suite' : 'generate',
        prompt: objective,
        includeContent: formatPlan.formats.includes('html') || shouldIncludeDocumentWorkflowContent(objective),
        ...(formatPlan.suiteIntent
            ? {
                formats: formatPlan.formats.length > 0 ? formatPlan.formats : ['html'],
                ...(formatPlan.useSandbox ? { buildMode: 'sandbox', useSandbox: true } : {}),
            }
            : (formatPlan.formats.length === 1 ? { format: formatPlan.formats[0] } : {})),
        ...(formatPlan.websiteBuild ? { documentType: 'website' } : {}),
    };
    const sources = buildDocumentWorkflowSourcesFromToolEvents(toolEvents);

    if (sources.length > 0) {
        params.sources = sources;
    }

    return params;
}

function buildResearchDossierFromToolEvents({ objective = '', toolEvents = [] } = {}) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const lastSearchEvent = getLastSuccessfulToolEvent(events, 'web-search');
    const searchResults = Array.isArray(lastSearchEvent?.result?.data?.results)
        ? lastSearchEvent.result.data.results
        : [];
    const query = normalizeInlineText(
        lastSearchEvent?.result?.data?.query
        || parseToolCallArguments(lastSearchEvent?.toolCall?.function?.arguments || '{}').query
        || objective,
    );

    const sourceEntries = events
        .filter((event) => {
            const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
            return (toolId === 'web-fetch' || toolId === 'web-scrape') && event?.result?.success !== false;
        })
        .map((event) => {
            const data = event?.result?.data || {};
            const args = parseToolCallArguments(event?.toolCall?.function?.arguments || '{}');
            const url = String(data?.url || args?.url || '').trim();
            const searchResult = findSearchResultByUrl(searchResults, url);
            const title = normalizeInlineText(data?.title || searchResult?.title || extractHtmlTitle(data?.body || '') || url);
            const snippet = truncateText(normalizeInlineText(searchResult?.snippet || ''), 260);
            const excerpt = extractResearchSourceExcerpt(event);
            const source = deriveResearchSourceLabel(url, searchResult?.source || data?.source || '');
            const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';

            if (!url || (!title && !snippet && !excerpt)) {
                return null;
            }

            return {
                url,
                title,
                snippet,
                excerpt,
                source,
                toolId,
            };
        })
        .filter(Boolean)
        .slice(0, 6);

    if (!query && searchResults.length === 0 && sourceEntries.length === 0) {
        return '';
    }

    const lines = [];
    if (query) {
        lines.push(`Research query: ${query}`);
    }

    if (searchResults.length > 0) {
        lines.push('Top search results:');
        searchResults.slice(0, 6).forEach((entry, index) => {
            const title = truncateText(normalizeInlineText(entry?.title || 'Untitled result'), 120);
            const url = String(entry?.url || '').trim();
            const source = deriveResearchSourceLabel(url, entry?.source || '');
            const snippet = truncateText(normalizeInlineText(entry?.snippet || ''), 220);
            lines.push([
                `${index + 1}. ${title}`,
                source ? `(${source})` : '',
                url ? `[${url}]` : '',
            ].filter(Boolean).join(' '));
            if (snippet) {
                lines.push(`   Snippet: ${snippet}`);
            }
        });
    }

    if (sourceEntries.length > 0) {
        lines.push('Verified source extracts:');
        sourceEntries.forEach((entry, index) => {
            lines.push([
                `${index + 1}. ${truncateText(entry.title || entry.url, 140)}`,
                entry.source ? `(${entry.source})` : '',
                `[${entry.url}]`,
                entry.toolId ? `via ${entry.toolId}` : '',
            ].filter(Boolean).join(' '));
            if (entry.snippet) {
                lines.push(`   Search snippet: ${entry.snippet}`);
            }
            if (entry.excerpt) {
                lines.push(`   Verified extract: ${entry.excerpt}`);
            }
        });
    }

    return lines.join('\n');
}

function hasUsableSshDefaults() {
    const sshConfig = settingsController.getEffectiveSshConfig();

    return Boolean(
        sshConfig.enabled
        && sshConfig.host
        && sshConfig.username
        && (sshConfig.password || sshConfig.privateKeyPath)
    );
}

function formatSshRuntimeTarget(target = null) {
    if (!target?.host) {
        return null;
    }

    const username = target.username ? `${target.username}@` : '';
    const port = target.port && Number(target.port) !== 22 ? `:${target.port}` : '';
    return `${username}${target.host}${port}`;
}

function hasAutonomousRemoteApproval(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(do what you need|take it from here|handle it|run with it|finish it|finish setup|finish the setup|complete the setup)\b/,
        /\b(keep going|continue|proceed|go ahead|next steps|do the next steps|obvious next steps)\b/,
        /\b(start the build|continue the build|continue on the server|keep working on the server)\b/,
        /\b(solve|fix|resolve|repair)\b[\s\S]{0,24}\b(issue|problem|it|this)\b/,
        /\b(you have|use)\s+root access\b/,
    ].some((pattern) => pattern.test(normalized));
}

function isRemoteApprovalOnlyTurn(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const grantsPermission = [
        /\b(i give you permission|you have permission|permission granted|i approve|approved|you are approved)\b/,
        /\b(go ahead and use|you can use|use)\b[\s\S]{0,20}\b(remote command|ssh|server access|remote access)\b/,
        /\b(can use|allowed to use)\b[\s\S]{0,20}\b(remote command|ssh|server access|remote access)\b/,
    ].some((pattern) => pattern.test(normalized));

    if (!grantsPermission) {
        return false;
    }

    return !/\b(health|report|summary|status|state|check|inspect|diagnose|debug|deploy|restart|install|fix|repair|update|change|configure|build|logs?|kubectl|pod|service|ingress)\b/.test(normalized);
}

function resolveRemoteObjectiveFromSession(rawObjective = '', session = null, recentMessages = []) {
    if (!isRemoteApprovalOnlyTurn(rawObjective)) {
        return rawObjective;
    }

    const controlState = getSessionControlState(session);
    const storedObjective = String(controlState.lastRemoteObjective || '').trim();
    if (storedObjective) {
        return storedObjective;
    }

    const transcript = Array.isArray(recentMessages) ? [...recentMessages] : [];
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
        const message = transcript[index];
        if (message?.role !== 'user') {
            continue;
        }

        const candidate = normalizeMessageText(message.content || '').trim();
        if (candidate && !isRemoteApprovalOnlyTurn(candidate)) {
            return candidate;
        }
    }

    return rawObjective;
}

function normalizeActiveTaskFrame(frame = null) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
        return null;
    }

    const objective = String(frame.objective || '').trim();
    if (!objective) {
        return null;
    }

    const normalizeList = (value = [], limit = 6) => (Array.isArray(value) ? value : [])
        .map((entry) => normalizeInlineText(entry))
        .filter(Boolean)
        .slice(0, limit);

    return {
        objective,
        ...(String(frame.projectKey || '').trim() ? { projectKey: String(frame.projectKey).trim() } : {}),
        ...(String(frame.clientSurface || frame.surface || '').trim()
            ? { clientSurface: String(frame.clientSurface || frame.surface).trim() }
            : {}),
        ...(String(frame.executionProfile || '').trim() ? { executionProfile: String(frame.executionProfile).trim() } : {}),
        ...(String(frame.lastVerifiedStep || '').trim() ? { lastVerifiedStep: String(frame.lastVerifiedStep).trim() } : {}),
        ...(String(frame.nextSensibleStep || '').trim() ? { nextSensibleStep: String(frame.nextSensibleStep).trim() } : {}),
        ...(normalizeList(frame.unresolvedBlockers).length > 0 ? { unresolvedBlockers: normalizeList(frame.unresolvedBlockers) } : {}),
        ...(normalizeList(frame.recentVerifiedFacts).length > 0 ? { recentVerifiedFacts: normalizeList(frame.recentVerifiedFacts) } : {}),
        ...(normalizeList(frame.referencedArtifacts).length > 0 ? { referencedArtifacts: normalizeList(frame.referencedArtifacts) } : {}),
        updatedAt: String(frame.updatedAt || frame.updated_at || '').trim() || new Date().toISOString(),
    };
}

function resolveObjectiveFromActiveTaskFrame(rawObjective = '', session = null, clientSurface = '') {
    const objective = String(rawObjective || '').trim();
    const activeTaskFrame = normalizeActiveTaskFrame(getSessionControlState(session).activeTaskFrame);
    if (!activeTaskFrame || !objective) {
        return {
            objective,
            usedTaskFrameContext: false,
            activeTaskFrame,
        };
    }

    if (!(isLikelyTranscriptDependentTurn(objective) || isRemoteApprovalOnlyTurn(objective) || hasExplicitForegroundResumeIntent(objective))) {
        return {
            objective,
            usedTaskFrameContext: false,
            activeTaskFrame,
        };
    }

    const normalizedSurface = String(clientSurface || '').trim().toLowerCase();
    const frameSurface = String(activeTaskFrame.clientSurface || '').trim().toLowerCase();
    if (normalizedSurface && frameSurface && normalizedSurface !== frameSurface) {
        return {
            objective,
            usedTaskFrameContext: false,
            activeTaskFrame,
        };
    }

    return {
        objective: `${activeTaskFrame.objective}. ${objective}`.trim(),
        usedTaskFrameContext: true,
        activeTaskFrame,
    };
}

function buildActiveTaskFrame({
    objective = '',
    projectKey = '',
    clientSurface = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    toolEvents = [],
    projectPlan = null,
    workflow = null,
    memoryTrace = null,
} = {}) {
    const normalizedObjective = String(objective || '').trim();
    if (!normalizedObjective) {
        return null;
    }

    const relevantToolEvents = (Array.isArray(toolEvents) ? toolEvents : []);
    const successfulEvents = relevantToolEvents.filter((event) => event?.result?.success !== false);
    const failingEvents = relevantToolEvents.filter((event) => event?.result?.success === false);
    const lastSuccessful = successfulEvents[successfulEvents.length - 1] || null;
    const nextPlanFocus = getActiveProjectMilestoneTitle(projectPlan)
        || getNextWorkflowTaskTitle(workflow)
        || '';
    const recentVerifiedFacts = Array.isArray(memoryTrace?.selected)
        ? memoryTrace.selected
            .map((entry) => normalizeInlineText(entry?.summary || entry?.artifactId || ''))
            .filter(Boolean)
            .slice(0, 3)
        : [];
    const referencedArtifacts = Array.isArray(memoryTrace?.selected)
        ? memoryTrace.selected
            .map((entry) => normalizeInlineText(entry?.artifactId || entry?.summary || ''))
            .filter(Boolean)
            .slice(0, 4)
        : [];

    return normalizeActiveTaskFrame({
        objective: normalizedObjective,
        projectKey,
        clientSurface,
        executionProfile,
        lastVerifiedStep: lastSuccessful
            ? normalizeInlineText(lastSuccessful.reason || lastSuccessful?.toolCall?.function?.name || lastSuccessful?.result?.toolId || '')
            : '',
        nextSensibleStep: nextPlanFocus || (failingEvents.length > 0 ? 'Resolve the active blocker.' : 'Continue the active objective.'),
        unresolvedBlockers: failingEvents
            .map((event) => normalizeInlineText(event?.result?.error || event?.error || ''))
            .filter(Boolean)
            .slice(0, 3),
        recentVerifiedFacts,
        referencedArtifacts,
        updatedAt: new Date().toISOString(),
    });
}

function extractRemoteCliAgentControlStateFromToolEvents(toolEvents = []) {
    const event = [...(Array.isArray(toolEvents) ? toolEvents : [])]
        .reverse()
        .find((entry) => {
            const toolId = String(entry?.toolCall?.function?.name || entry?.result?.toolId || '').trim();
            return toolId === 'remote-cli-agent';
        });
    if (!event) {
        return null;
    }

    const params = parseToolCallArguments(event?.toolCall?.function?.arguments || '{}');
    const data = event?.result?.data && typeof event.result.data === 'object' ? event.result.data : {};
    const task = String(params.task || '').trim();
    const remoteCliAgent = {
        ...(task ? { lastTask: task } : {}),
        lastTaskAt: new Date().toISOString(),
        ...(event?.result?.success === false
            ? {
                lastFailure: {
                    task,
                    reason: String(event?.result?.error || 'remote-cli-agent failed').trim(),
                    failedAt: new Date().toISOString(),
                },
            }
            : {}),
        ...(data.sessionId ? { sessionId: data.sessionId } : {}),
        ...(data.mcpSessionId ? { mcpSessionId: data.mcpSessionId } : {}),
        ...(data.targetId ? { targetId: data.targetId } : {}),
        ...(data.cwd || params.cwd ? { cwd: data.cwd || params.cwd } : {}),
        ...(data.remoteCodeSessionId ? { remoteCodeSessionId: data.remoteCodeSessionId } : {}),
        ...(data.gitRepo ? { gitRepo: data.gitRepo } : {}),
        ...(data.gitCommit ? { gitCommit: data.gitCommit } : {}),
        ...(data.deployment ? { deployment: data.deployment } : {}),
        ...(data.publicHost ? { publicHost: data.publicHost } : {}),
        ...(data.uiCheckReport ? { uiCheckReport: data.uiCheckReport } : {}),
        ...(Array.isArray(data.uiScreenshots) && data.uiScreenshots.length > 0 ? { uiScreenshots: data.uiScreenshots } : {}),
        ...(data.model ? { model: data.model } : {}),
    };

    return {
        lastToolIntent: 'remote-cli-agent',
        remoteCliAgent,
    };
}

function buildNotesSynthesisInstructions() {
    return [
        'You are editing a Lilly-style block-based notes document.',
        'In this notes interface, "page" means the current notes document unless the user explicitly says web page, site page, route, repo file, or server page.',
        'Your default job here is to edit the current page itself through block updates, not to create standalone HTML, artifact links, or workspace files.',
        'While notes mode is active, the only tools available for supporting work are `web-search`, `web-fetch`, and `web-scrape`.',
        'Do not attempt document generation, artifact creation, filesystem work, image generation, Git, deployments, remote/server commands, or any other tool category from this surface.',
        'Use web results only to improve the current page blocks or to answer the user in chat when they are planning instead of editing.',
        'If the user is asking to add, place, insert, rewrite, reorganize, or polish content on the page, answer as a notes-page edit, not as a workspace/file task.',
        'When the user asks for page changes, the final content should land on the page blocks, not in a separate artifact description.',
        'Only stay in planning/chat mode when the user is explicitly brainstorming, outlining, asking for options, or says not to edit the page yet.',
        'Prefer returning `notes-actions` or page-ready notes content over raw standalone HTML, local file paths, workspace write steps, or filesystem commentary.',
        'Do not use `file-write` or `file-mkdir` to satisfy a notes-page edit. Apply the content to the current page instead.',
        'When you return `notes-actions`, use this exact payload shape: `{ "assistant_reply": "...", "actions": [{ "op": "append_to_page", "blocks": [...] }] }`.',
        'Do not use a top-level `"notes-actions"` property. Do not use `"action"` in place of `"op"`.',
        'Do not use legacy ops like `replace-content`, `append-content`, or `prepend-content`. Use `rebuild_page`, `append_to_page`, `prepend_to_page`, `replace_block`, `insert_after`, or `update_block`.',
        'Available block palette includes `text`, `heading_1`, `heading_2`, `heading_3`, `bulleted_list`, `numbered_list`, `todo`, `toggle`, `quote`, `divider`, `callout`, `code`, `image`, `ai_image`, `bookmark`, `database`, `math`, `mermaid`, and `ai`.',
        'Use richer blocks intentionally: `callout` for takeaways or warnings, `bookmark` for sources, `database` for comparisons or trackers, `toggle` for optional detail, `mermaid` for process/structure, `image` or `ai_image` for visuals, `todo` for next steps, and `quote` for emphasized excerpts.',
        'Use native note blocks instead of raw markdown punctuation: headings for headings, list blocks for bullets, todo blocks for checkboxes, callouts for highlighted notes, and text formatting instead of literal `**bold**` markers.',
        'Do not leave markdown markers like `##`, `-`, `--`, `[ ]`, or `**...**` inside block content when the page block system already has a native representation.',
        'Use `heading_3` for compact section labels or mini-subheads when a phrase deserves its own line but should not become a major section heading.',
        'Think in page roles, not just paragraphs: title/icon, focal summary, themed sections, supporting evidence, interactive detail, sources, and next steps.',
        'Treat design quality as part of correctness in notes mode: the page should feel intentionally composed, not like raw Markdown pasted into blocks.',
        'Use the frontend metadata surface when it improves the page: `update_page` can set title, icon, cover URL, properties, and default model.',
        'Blocks can also use `color`, `textColor`, `children`, and text `formatting` to create hierarchy and interaction instead of a flat stack of plain paragraphs.',
        'Avoid a long heading-then-paragraph ladder for the whole page. Break the rhythm with callouts, visuals, bookmarks, databases, toggles, quotes, and dividers where they add clarity.',
        'Give the first screenful a designed opening cluster: title or icon, a focal callout, and a hero image, ai_image, or clear source cue when the topic supports it.',
        'On substantial pages, avoid more than two plain text blocks in a row without breaking the cadence with a richer block type.',
        'Research pages should read like compact knowledge hubs: lead with a summary callout, group findings by theme, and surface real sources as bookmarks instead of burying them in prose.',
        'Topic and educational pages should usually follow an editorial-explainer pattern: big-idea callout, hero visual, quick-facts cluster, then themed sections and sources.',
        'For polished or Notion-like pages, make the design visible in the blocks: page icon, focal callout, hero image or ai_image when the topic supports it, colored section labels, and muted supporting notes.',
        'Choose one dominant design scheme and keep it coherent across headers, callouts, visuals, and supporting notes instead of mixing unrelated accents.',
        'When editing an existing page, preserve the strongest current icon, cover, focal block, and accent-color language unless the user explicitly asks for a new look.',
        'If a substantial notes page only uses headings, plain text, and list blocks, do a palette audit before finalizing and check whether a richer block type would improve readability or interaction.',
        'Do not ship research, dashboard, documentation, or polished briefing pages as only plain headings and paragraphs unless the user explicitly asked for a minimal layout.',
        'Do not mention the local CLI environment, local startup or health state, `/app`, local command execution, file-write, sandbox limits, or workspace access unless a verified tool result is directly about that and the user explicitly asked about it.',
        'Unless the user explicitly asked to export, download, save, or create a file/link, do not turn the answer into a standalone artifact or HTML file.',
    ].join('\n\n');
}

function isNotesSurfaceTask({ taskType = '', executionProfile = '' } = {}) {
    return taskType === NOTES_EXECUTION_PROFILE || executionProfile === NOTES_EXECUTION_PROFILE;
}

function hasAutonomyRevocation(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(ask me first|wait for me|hold on|stop here|pause here|don'?t continue|do not continue)\b/.test(normalized);
}

function extractFirstUrl(text = '') {
    const match = String(text || '').match(/https?:\/\/\S+/i);
    return match ? match[0].replace(/[),.;!?]+$/g, '') : null;
}

function shellQuote(value = '') {
    return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function extractInternalArtifactUrl(text = '') {
    const source = String(text || '');
    if (!source.trim()) {
        return null;
    }

    const match = source.match(
        /https?:\/\/(?:api|[^\s"'`()]+)\/api\/artifacts\/[a-f0-9-]+\/download(?:\?inline=1)?|\/?api\/artifacts\/[a-f0-9-]+\/download(?:\?inline=1)?/i,
    );
    if (!match?.[0]) {
        return null;
    }

    return match[0].replace(/[),.;!?]+$/g, '');
}

function normalizeInlineFileContent(value) {
    if (value == null) {
        return undefined;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    if (Array.isArray(value) || typeof value === 'object') {
        try {
            return JSON.stringify(value, null, 2);
        } catch (_error) {
            return String(value);
        }
    }

    return String(value);
}

function extractFencedCodeBlocks(text = '') {
    const source = String(text || '');
    const blocks = [];
    const pattern = /```([a-z0-9_-]*)\s*\n([\s\S]*?)```/gi;
    let match = pattern.exec(source);

    while (match) {
        blocks.push({
            language: String(match[1] || '').trim().toLowerCase(),
            content: String(match[2] || '').trim(),
        });
        match = pattern.exec(source);
    }

    return blocks;
}

function looksLikeStandaloneHtml(text = '') {
    return /<!doctype html>|<html\b|<body\b|<main\b|<article\b|<section\b|<header\b|<figure\b|<img\b|<h1\b/i.test(String(text || ''));
}

function inferFileWriteHint({ path = '', objective = '', reason = '' } = {}) {
    const extension = require('path').extname(String(path || '').trim().toLowerCase());
    const context = `${path}\n${objective}\n${reason}`.toLowerCase();

    const byExtension = {
        '.html': { kind: 'html', fenceLabels: ['html'] },
        '.htm': { kind: 'html', fenceLabels: ['html'] },
        '.json': { kind: 'json', fenceLabels: ['json'] },
        '.md': { kind: 'markdown', fenceLabels: ['md', 'markdown'] },
        '.markdown': { kind: 'markdown', fenceLabels: ['md', 'markdown'] },
        '.js': { kind: 'javascript', fenceLabels: ['js', 'javascript'] },
        '.mjs': { kind: 'javascript', fenceLabels: ['js', 'javascript'] },
        '.cjs': { kind: 'javascript', fenceLabels: ['js', 'javascript'] },
        '.ts': { kind: 'typescript', fenceLabels: ['ts', 'typescript'] },
        '.tsx': { kind: 'typescript', fenceLabels: ['tsx', 'typescript'] },
        '.css': { kind: 'css', fenceLabels: ['css'] },
        '.xml': { kind: 'xml', fenceLabels: ['xml'] },
        '.py': { kind: 'python', fenceLabels: ['py', 'python'] },
        '.sh': { kind: 'shell', fenceLabels: ['sh', 'bash', 'shell'] },
    };

    if (byExtension[extension]) {
        return byExtension[extension];
    }

    if (/\bhtml\b/.test(context)) {
        return { kind: 'html', fenceLabels: ['html'] };
    }

    if (/\bjson\b/.test(context)) {
        return { kind: 'json', fenceLabels: ['json'] };
    }

    return {
        kind: null,
        fenceLabels: [],
    };
}

function inferFileWriteContentFromRecentMessages({
    path = '',
    objective = '',
    reason = '',
    recentMessages = [],
} = {}) {
    const hint = inferFileWriteHint({ path, objective, reason });
    const preferredLabels = new Set(hint.fenceLabels);

    for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
        const message = recentMessages[index];
        const messageText = normalizeMessageText(message?.content || '').trim();
        if (!messageText) {
            continue;
        }

        const blocks = extractFencedCodeBlocks(messageText).filter((block) => block.content);
        if (hint.kind === 'html') {
            const htmlBlock = blocks.find((block) => preferredLabels.has(block.language) || looksLikeStandaloneHtml(block.content));
            if (htmlBlock) {
                return htmlBlock.content;
            }

            if (looksLikeStandaloneHtml(messageText)) {
                return messageText;
            }
            continue;
        }

        if (hint.kind === 'json') {
            const jsonBlock = blocks.find((block) => preferredLabels.has(block.language) || /^[\[{]/.test(block.content.trim()));
            if (jsonBlock) {
                return jsonBlock.content;
            }

            if (/^[\[{]/.test(messageText)) {
                return messageText;
            }
            continue;
        }

        if (preferredLabels.size > 0) {
            const labeledBlock = blocks.find((block) => preferredLabels.has(block.language));
            if (labeledBlock) {
                return labeledBlock.content;
            }
            continue;
        }

        if (blocks.length === 1) {
            return blocks[0].content;
        }
    }

    return undefined;
}

function normalizeFileWritePlanParams(step = {}, { objective = '', recentMessages = [] } = {}) {
    const rawParams = step?.params && typeof step.params === 'object'
        ? { ...step.params }
        : {};
    const pathCandidates = [
        rawParams.path,
        rawParams.filePath,
        rawParams.filepath,
        rawParams.filename,
        rawParams.targetPath,
        rawParams.destination,
        step?.path,
        step?.filePath,
        step?.filename,
        step?.targetPath,
    ];
    const resolvedPath = pathCandidates.find((value) => typeof value === 'string' && value.trim());
    if (resolvedPath) {
        rawParams.path = resolvedPath.trim();
    }

    const directContent = [
        rawParams.content,
        rawParams.contents,
        rawParams.text,
        rawParams.body,
        rawParams.data,
        rawParams.html,
        rawParams.source,
        rawParams.code,
        rawParams.markdown,
        rawParams.fileContent,
        step?.content,
        step?.text,
        step?.body,
        step?.data,
        step?.html,
        step?.code,
    ]
        .map((value) => normalizeInlineFileContent(value))
        .find((value) => typeof value === 'string');

    if (typeof directContent === 'string') {
        rawParams.content = directContent;
        return rawParams;
    }

    const inferredContent = inferFileWriteContentFromRecentMessages({
        path: rawParams.path || '',
        objective,
        reason: typeof step?.reason === 'string' ? step.reason.trim() : '',
        recentMessages,
    });
    if (typeof inferredContent === 'string') {
        rawParams.content = inferredContent;
    }

    return rawParams;
}

function normalizeAgentWorkloadPlanParams(step = {}, { objective = '', session = null, recentMessages = [], toolContext = {} } = {}) {
    const params = step?.params && typeof step.params === 'object'
        ? { ...step.params }
        : {};
    const scenarioRequest = String(
        params.request
        || params.scenario
        || params.description
        || objective
        || step?.reason
        || '',
    ).trim();

    if (!scenarioRequest) {
        return {
            action: 'list',
        };
    }

    const normalizedCreate = buildCanonicalWorkloadAction({
        ...params,
        request: scenarioRequest,
    }, {
        session,
        recentMessages,
        timezone: params.timezone
            || toolContext?.timezone
            || session?.metadata?.timezone
            || session?.metadata?.timeZone
            || getDefaultWorkloadTimezone(),
        now: toolContext?.now || null,
    });
    if (normalizedCreate) {
        return normalizedCreate;
    }

    return {
        action: 'create_from_scenario',
        request: scenarioRequest,
        timezone: params.timezone
            || toolContext?.timezone
            || session?.metadata?.timezone
            || session?.metadata?.timeZone
            || getDefaultWorkloadTimezone(),
    };
}

function hasExplicitSubAgentIntentText(text = '') {
    return hasMultiAgentIntentText(text);
}

function normalizeAgentDelegateTaskPlan(task = {}, index = 0) {
    const source = task && typeof task === 'object' && !Array.isArray(task)
        ? task
        : {};
    const prompt = normalizeInlineText(
        source.prompt
        || source.objective
        || source.request
        || '',
    );
    const normalized = {
        title: normalizeInlineText(source.title || source.name || `Sub-agent ${index + 1}`) || `Sub-agent ${index + 1}`,
    };

    if (prompt) {
        normalized.prompt = prompt;
    }
    if (source.execution && typeof source.execution === 'object' && !Array.isArray(source.execution)) {
        normalized.execution = source.execution;
    }
    if (normalizeInlineText(source.mode || '')) {
        normalized.mode = normalizeInlineText(source.mode);
    }
    if (Array.isArray(source.toolIds)) {
        normalized.toolIds = source.toolIds.map((toolId) => normalizeInlineText(toolId)).filter(Boolean);
    }
    if (normalizeInlineText(source.executionProfile || source.execution_profile || '')) {
        normalized.executionProfile = normalizeInlineText(source.executionProfile || source.execution_profile);
    }
    if (source.allowSideEffects === true) {
        normalized.allowSideEffects = true;
    }
    ['maxRounds', 'maxToolCalls', 'maxDurationMs', 'maxRetries'].forEach((key) => {
        if (Number.isFinite(Number(source[key]))) {
            normalized[key] = Number(source[key]);
        }
    });
    if (normalizeInlineText(source.lockKey || source.lock_key || '')) {
        normalized.lockKey = normalizeInlineText(source.lockKey || source.lock_key);
    }
    if (Array.isArray(source.writeTargets) || Array.isArray(source.write_targets)) {
        const writeTargets = [
            ...(Array.isArray(source.writeTargets) ? source.writeTargets : []),
            ...(Array.isArray(source.write_targets) ? source.write_targets : []),
        ].map((entry) => normalizeInlineText(entry)).filter(Boolean);
        if (writeTargets.length > 0) {
            normalized.writeTargets = writeTargets;
        }
    }
    ['outputPath', 'output_path', 'targetPath', 'target_path', 'path'].forEach((key) => {
        if (normalizeInlineText(source[key] || '')) {
            normalized[key] = normalizeInlineText(source[key]);
        }
    });
    if (source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)) {
        normalized.metadata = source.metadata;
    }

    return normalized;
}

function normalizeAgentDelegatePlanParams(step = {}, { objective = '' } = {}) {
    const params = step?.params && typeof step.params === 'object'
        ? { ...step.params }
        : {};
    const action = normalizeInlineText(params.action || 'spawn').toLowerCase() || 'spawn';

    if (action === 'status') {
        return {
            action: 'status',
            orchestrationId: normalizeInlineText(
                params.orchestrationId
                || params.orchestration_id
                || params.id
                || '',
            ),
        };
    }

    if (action === 'list') {
        return {
            action: 'list',
        };
    }

    const rawTasks = Array.isArray(params.tasks)
        ? params.tasks
        : (params.task && typeof params.task === 'object' && !Array.isArray(params.task) ? [params.task] : []);
    const originalObjective = normalizeInlineText(objective);
    const normalizedTasks = rawTasks
        .map((task, index) => normalizeAgentDelegateTaskPlan(task, index))
        .filter((task) => task.prompt || task.execution)
        .filter((task) => !task.prompt || normalizeInlineText(task.prompt).toLowerCase() !== originalObjective.toLowerCase());

    if (normalizedTasks.length === 0) {
        const fallbackPrompt = normalizeInlineText(
            params.prompt
            || params.request
            || step?.reason
            || '',
        );
        if (fallbackPrompt && fallbackPrompt.toLowerCase() !== originalObjective.toLowerCase()) {
            normalizedTasks.push({
                title: normalizeInlineText(params.title || params.name || 'Delegated task') || 'Delegated task',
                prompt: fallbackPrompt,
            });
        }
    }

    return {
        action: 'spawn',
        ...(normalizeInlineText(params.title || params.name || '')
            ? { title: normalizeInlineText(params.title || params.name) }
            : {}),
        ...(Number.isFinite(Number(params.maxRetries))
            ? { maxRetries: Number(params.maxRetries) }
            : {}),
        tasks: normalizedTasks.slice(0, 3),
    };
}

function buildUbuntuMasterRemoteCommand() {
    return "hostname && uname -m && (test -f /etc/os-release && sed -n '1,3p' /etc/os-release || true) && uptime";
}

function inferFallbackUnsplashQuery(text = '') {
    return String(text || '')
        .replace(/\b(please|can you|could you|would you|find|search|look up|browse|show|get|use|an|a|the|for|with|from|on|about|into|unsplash|image|images|photo|photos|hero|background|cover|visual|visuals)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function inferBlindScrapeParams(text = '', firstUrl = '') {
    const prompt = String(text || '');
    const normalized = prompt.toLowerCase();
    const hasImageIntent = /\b(image|images|photo|photos|thumbnail|thumbnails|gallery|galleries|poster|posters|pics?)\b/i.test(prompt);
    const hasBlindIntent = /\b(blind|opaque|without exposing|without showing|without viewing|without looking at|do not show|don't show)\b/i.test(prompt);
    const hasSensitiveIntent = /\b(adult|explicit|nsfw|porn)\b/i.test(prompt);
    const captureImages = hasImageIntent || hasBlindIntent || hasSensitiveIntent;

    return {
        url: firstUrl,
        browser: true,
        ...(captureImages ? { captureImages: true, imageLimit: 12 } : {}),
        ...((captureImages && (hasBlindIntent || hasSensitiveIntent)) ? { blindImageCapture: true } : {}),
        ...(normalized.includes('javascript') ? { javascript: true } : {}),
    };
}

function inferFallbackSshCommand(text = '', executionProfile = DEFAULT_EXECUTION_PROFILE) {
    const source = String(text || '').trim();
    const normalized = source.toLowerCase();
    if (!normalized) {
        return null;
    }
    const hasInspectionIntent = /\b(check|inspect|verify|diagnose|debug|troubleshoot|status|state|health|healthy|look at|show|list|what'?s running|see what'?s wrong)\b/.test(normalized);

    const firstUrl = extractFirstUrl(source);
    if (firstUrl && /\b(curl|reach|reachable|endpoint|url|auth|login|gitlab|gitea)\b/.test(normalized)) {
        return `hostname && uname -m && curl -IkfsS --max-time 20 ${shellQuote(firstUrl)}`;
    }

    if (/\b(health|status|healthy|uptime)\b/.test(normalized)) {
        return 'hostname && uptime && (df -h / || true) && (free -m || true)';
    }

    if (hasInspectionIntent && /\b(k3s|k8s|kubernetes|cluster|kubectl|nodes?)\b/.test(normalized)) {
        return 'kubectl get nodes -o wide && kubectl get pods -A';
    }

    if (hasInspectionIntent && /\b(pods?)\b/.test(normalized)) {
        return 'kubectl get pods -A';
    }

    if (hasInspectionIntent && /\b(namespaces?)\b/.test(normalized)) {
        return 'kubectl get namespaces';
    }

    if (/\b(docker|containers?)\b/.test(normalized)) {
        return 'docker ps';
    }

    if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE) {
        return buildUbuntuMasterRemoteCommand();
    }

    return null;
}

function hasExplicitLocalArtifactReference(text = '') {
    const source = String(text || '').trim();
    if (!source) {
        return false;
    }

    const normalized = source.toLowerCase();
    return /\b(attached artifact|uploaded artifact|local artifact|local file|local html|workspace|repo|repository|on the drive|from the drive|on disk|from disk|readable path|file path)\b/.test(normalized)
        || /[a-z]:\\[^"'`\s]+/i.test(source);
}

function hasRemoteWebsiteUpdateIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const hasWebsiteTarget = /\b(website|web site|webpage|web page|landing page|homepage|home page|site|index\.html)\b/.test(normalized)
        || (
            /\bhtml\b/.test(normalized)
            && /\b(current|existing|deployed|live|website|web ?page|site|homepage|landing page|index\.html)\b/.test(normalized)
        );
    const hasRemoteTarget = /\b(remote|server|cluster|k3s|k8s|kubernetes|kubectl|pod|deployment|deployed|workload|rollout|restart|redeploy|configmap|container|ingress)\b/.test(normalized)
        || /\b(live|online|public|hosted|production)\b[\s\S]{0,20}\b(site|website|web ?page|webpage|homepage|landing page|app|service|index\.html)\b/.test(normalized)
        || /\b(site|website|web ?page|webpage|homepage|landing page|app|service|index\.html)\b[\s\S]{0,20}\b(live|online|public|hosted|production)\b/.test(normalized);
    const hasWriteIntent = /\b(write|replace|overwrite|update|edit|change|deploy|redeploy|restart|publish|push|apply|rollout|create|generate|make)\b/.test(normalized);

    return hasWebsiteTarget && hasRemoteTarget && hasWriteIntent;
}

function hasInternalArtifactReference(text = '') {
    const source = String(text || '').trim();
    if (!source) {
        return false;
    }

    return /(?:^|[\s(])\/api\/artifacts\/[a-f0-9-]+\/download\b/i.test(source)
        || /(?:^|[\s(])api\/artifacts\/[a-f0-9-]+\/download\b/i.test(source)
        || /https?:\/\/api\/artifacts\/[a-f0-9-]+\/download\b/i.test(source)
        || /https?:\/\/[^/\s]+\/api\/artifacts\/[a-f0-9-]+\/download\b/i.test(source);
}

function buildRemoteWebsiteSourceInspectionCommand() {
    const configuredTargetDirectory = String(config.deploy.defaultTargetDirectory || '').trim().replace(/\\/g, '/');
    const targetDirectory = configuredTargetDirectory || '/opt/kimibuilt';

    return [
        'set -e',
        'hostname && uname -m',
        `echo "--- configured target directory: ${targetDirectory} ---"`,
        `if [ -d ${shellQuote(targetDirectory)} ]; then`,
        `  find ${shellQuote(targetDirectory)} -maxdepth 3 -type f \\( -name 'index.html' -o -name '*.html' -o -name '*.yaml' -o -name '*.yml' \\) 2>/dev/null | head -n 40`,
        `  if [ -d ${shellQuote(`${targetDirectory}/.git`)} ]; then cd -- ${shellQuote(targetDirectory)} && git status --short --branch && git remote -v && git log --oneline -n 5; fi`,
        'else',
        `  echo "configured target directory not found: ${targetDirectory}"`,
        'fi',
        "(find /srv /opt /home -maxdepth 4 -type d -name .git 2>/dev/null | sed 's#/.git$##' | head -n 20 || true)",
        "(test -f /root/website.html && echo /root/website.html || true)",
        "(find /root /srv /var/www -maxdepth 3 -type f \\( -name 'website.html' -o -name 'index.html' -o -name '*.html' -o -name '*.yaml' -o -name '*.yml' \\) 2>/dev/null | head -n 40 || true)",
        "(kubectl get configmap -A -o name 2>/dev/null | grep -Ei 'web|site|html|page|nginx|frontend' | head -n 20 || true)",
    ].join(' && ');
}

function buildRemoteWebsiteWorkloadInspectionCommand() {
    return [
        'hostname && uname -m',
        "(kubectl get deployment,svc,ingress -A 2>/dev/null | grep -Ei 'website|web|site|html|ingress' | head -n 40 || true)",
        "(kubectl get configmap -A 2>/dev/null | grep -Ei 'website|web|site|html|page' | head -n 40 || true)",
        "(kubectl get pods -A -o wide 2>/dev/null | grep -Ei 'website|web|site|html|nginx' | head -n 40 || true)",
    ].join(' && ');
}

function buildRemoteWebsiteBodyVerificationCommand() {
    return [
        'set -e',
        'ns=$(kubectl get deployment,svc,ingress -A -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name --no-headers 2>/dev/null | awk \'$2 ~ /website|web|site|ingress/ { print $1; exit }\')',
        'if [ -z "$ns" ]; then ns=default; fi',
        'pod=$(kubectl get pods -n "$ns" -o custom-columns=NAME:.metadata.name --no-headers 2>/dev/null | grep -Ei \'website|web|site|nginx\' | head -n 1 || true)',
        'if [ -n "$pod" ]; then kubectl exec -n "$ns" "$pod" -- sh -lc \'for f in /usr/share/nginx/html/index.html /usr/share/nginx/html/*.html /usr/share/nginx/html/*; do if [ -f "$f" ]; then echo "--- pod file: $f ---"; wc -c "$f"; sed -n "1,40p" "$f"; break; fi; done\'; fi',
        'host=$(kubectl get ingress -A -o jsonpath=\'{range .items[*]}{.spec.rules[0].host}{"\\n"}{end}\' 2>/dev/null | grep -v \'^$\' | head -n 1 || true)',
        'if [ -n "$host" ]; then echo "--- public response ---"; curl -ksS -D - --max-time 20 "https://$host" | sed -n "1,40p" || true; fi',
    ].join('\n');
}

function isMissingLocalHtmlArtifactEvent(event = null) {
    const toolId = canonicalizeRemoteToolId(event?.toolCall?.function?.name || event?.result?.toolId || '');
    const error = String(event?.result?.error || '').trim();
    const args = parseToolCallArguments(event?.toolCall?.function?.arguments || '{}');
    const path = String(args?.path || '').trim();

    return toolId === 'file-read'
        && event?.result?.success === false
        && /\b(enoent|no such file or directory)\b/i.test(error)
        && (!path || /\.(html?|css|js)$/i.test(path));
}

function normalizeShellCommand(command = '') {
    return String(command || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isGenericRemoteBaselineCommand(command = '') {
    return normalizeShellCommand(command) === normalizeShellCommand(buildUbuntuMasterRemoteCommand());
}

function hasRemoteWebsiteInspectionSignal(output = '') {
    const normalized = String(output || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        '<!doctype html',
        '<html',
        'index.html',
        'website.html',
        '/var/www/',
        '/srv/',
        'configmap/',
    ].some((fragment) => normalized.includes(fragment));
}

function isInternalArtifactRemoteFetchFailure(error = '') {
    const normalized = String(error || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /could not resolve host:\s*api/i.test(normalized)
        || /failed to connect to (?:localhost|127\.0\.0\.1) port 3000/i.test(normalized)
        || /connection refused/i.test(normalized) && /\b(?:localhost|127\.0\.0\.1)\b/.test(normalized);
}

function isWebsiteResourceTypeAsDeploymentFailure(error = '') {
    const normalized = String(error || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /deployments\.apps\s+"svc"\s+not found/i.test(normalized)
        || /deployments\.apps\s+"ingress"\s+not found/i.test(normalized);
}

function isWebsiteTitleOnlyVerificationFailure(error = '') {
    const normalized = String(error || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return normalized.includes('--- pod title ---')
        || normalized.includes('--- public title ---');
}

function shouldPreferRemoteFollowupPlan(toolEvents = []) {
    const latestEvent = Array.isArray(toolEvents) && toolEvents.length > 0
        ? toolEvents[toolEvents.length - 1]
        : null;
    if (!latestEvent) {
        return false;
    }

    if (isMissingLocalHtmlArtifactEvent(latestEvent)) {
        return true;
    }

    const toolId = canonicalizeRemoteToolId(latestEvent?.toolCall?.function?.name || latestEvent?.result?.toolId || '');
    if (toolId === 'web-fetch' && latestEvent?.result?.success === true) {
        const args = parseToolCallArguments(latestEvent?.toolCall?.function?.arguments || '{}');
        const internalArtifactUrl = extractInternalArtifactUrl(args?.url || '');
        const body = typeof latestEvent?.result?.data?.body === 'string'
            ? latestEvent.result.data.body.trim()
            : '';

        return Boolean(internalArtifactUrl && body);
    }

    if (!isRemoteCommandToolId(toolId) || latestEvent?.result?.success !== false) {
        return false;
    }

    const error = latestEvent?.result?.error || '';
    return isInternalArtifactRemoteFetchFailure(error)
        || isWebsiteResourceTypeAsDeploymentFailure(error)
        || isWebsiteTitleOnlyVerificationFailure(error);
}

function getLastRemoteToolEvent(toolEvents = []) {
    for (let index = (Array.isArray(toolEvents) ? toolEvents.length : 0) - 1; index >= 0; index -= 1) {
        const event = toolEvents[index];
        if (isRemoteCommandToolId(event?.toolCall?.function?.name || event?.result?.toolId || '')) {
            return event;
        }
    }

    return null;
}

function getLastSuccessfulToolEvent(toolEvents = [], toolId = '') {
    const normalizedToolId = String(toolId || '').trim().toLowerCase();
    for (let index = (Array.isArray(toolEvents) ? toolEvents.length : 0) - 1; index >= 0; index -= 1) {
        const event = toolEvents[index];
        const eventToolId = String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim().toLowerCase();
        if ((!normalizedToolId || eventToolId === normalizedToolId) && event?.result?.success !== false) {
            return event;
        }
    }

    return null;
}

function parseToolCallArguments(rawArguments = '{}') {
    if (!rawArguments) {
        return {};
    }

    return parseLenientJson(rawArguments) || {};
}

function extractRemoteWebsiteConfigMapName(toolEvents = []) {
    const patterns = [
        /`([a-z0-9.-]+)`\s+configmap/i,
        /\bconfigmap\/([a-z0-9.-]+)\b/i,
        /\b([a-z0-9.-]+)\s+configmap\b/i,
    ];

    for (let index = (Array.isArray(toolEvents) ? toolEvents.length : 0) - 1; index >= 0; index -= 1) {
        const event = toolEvents[index];
        const sources = [
            event?.reason || '',
            event?.toolCall?.function?.arguments || '',
            event?.result?.data?.stdout || '',
            event?.result?.data?.stderr || '',
            event?.result?.error || '',
        ];

        for (const source of sources) {
            const text = String(source || '');
            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match?.[1]) {
                    return match[1];
                }
            }
        }
    }

    return 'website-html';
}

function buildRemoteConfigMapApplyCommand(htmlBody = '', configMapName = 'website-html') {
    const body = String(htmlBody || '').trim();
    if (!body) {
        return buildRemoteWebsiteSourceInspectionCommand();
    }

    const encoded = Buffer.from(body, 'utf8').toString('base64');
    const preview = body
        .replace(/\s+/g, ' ')
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 160)
        .trim();
    const safeConfigMapName = String(configMapName || 'website-html').trim() || 'website-html';
    const awkConfigMapName = safeConfigMapName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    return [
        'set -e',
        ...(preview ? [`# HTML preview: ${preview}`] : []),
        `cm=${shellQuote(safeConfigMapName)}`,
        `ns=$(kubectl get configmap -A -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name --no-headers 2>/dev/null | awk '$2 == "${awkConfigMapName}" { print $1; exit }')`,
        'if [ -z "$ns" ]; then echo "ConfigMap not found: $cm" >&2; exit 1; fi',
        'tmp_html=$(mktemp)',
        "cat <<'__KIMI_ARTIFACT_HTML_B64__' | base64 -d > \"$tmp_html\"",
        encoded,
        '__KIMI_ARTIFACT_HTML_B64__',
        'key=$(kubectl get configmap -n "$ns" "$cm" -o go-template=\'{{range $k,$v := .data}}{{printf "%s\\n" $k}}{{end}}\' 2>/dev/null | grep -Ei \'(^|/)(index\\.html?|website\\.html?|.*\\.html?)$\' | head -n 1 || true)',
        'if [ -z "$key" ]; then key=index.html; fi',
        'kubectl create configmap "$cm" -n "$ns" --from-file="$key=$tmp_html" -o yaml --dry-run=client | kubectl apply -f -',
        'rm -f "$tmp_html"',
        'kubectl get configmap -n "$ns" "$cm" -o jsonpath=\'{.metadata.name}{"\\n"}{range $k,$v := .data}{printf "%s\\n" $k}{end}\'',
    ].join('\n');
}

function normalizeKubernetesResourceName(value = '', fallback = 'site') {
    const normalized = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);

    return normalized || fallback;
}

function inferStaticSiteAppName(objective = '', command = '') {
    const source = `${objective || ''}\n${command || ''}`.toLowerCase();
    const namedMatch = source.match(/\b(live-[a-z0-9-]+|[a-z0-9-]+-(?:calendar|site|web|app)|(?:calendar|site|web)-[a-z0-9-]+)\b/i);
    if (namedMatch?.[1]) {
        return normalizeKubernetesResourceName(namedMatch[1], 'live-site');
    }

    if (/\bcalendar\b/.test(source)) {
        return 'live-calendar';
    }

    if (/\bgame\b/.test(source)) {
        return 'game-site';
    }

    return 'live-site';
}

function extractLikelyPublicHost(text = '', fallbackHost = '') {
    const candidates = String(text || '').match(/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/ig) || [];
    const ignoredSuffixes = /\.(?:ya?ml|json|html?|js|css|svc|local)$/i;
    const match = candidates.find((candidate) => !ignoredSuffixes.test(candidate)
        && !candidate.includes('cluster.local')
        && !candidate.startsWith('api.'));
    return match || fallbackHost;
}

function extractKubernetesNamespaceFromText(text = '', fallbackNamespace = 'web') {
    const source = String(text || '');
    const flagMatch = source.match(/(?:^|\s)-n\s+['"]?([a-z0-9-]+)['"]?/i)
        || source.match(/(?:^|\s)--namespace(?:=|\s+)['"]?([a-z0-9-]+)['"]?/i);
    if (flagMatch?.[1]) {
        return normalizeKubernetesResourceName(flagMatch[1], fallbackNamespace);
    }

    const yamlMatch = source.match(/namespace:\s*['"]?([a-z0-9-]+)['"]?/i);
    if (yamlMatch?.[1]) {
        return normalizeKubernetesResourceName(yamlMatch[1], fallbackNamespace);
    }

    return fallbackNamespace;
}

function isKubernetesManifestAuthoringFailure(error = '') {
    const normalized = String(error || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\bstrict decoding error:\s*unknown field\b/.test(normalized)
        || /\berror converting yaml to json\b/.test(normalized)
        || /\byaml:\s*line\s+\d+:/i.test(normalized)
        || /\bdeployment in version "v1" cannot be handled as a deployment\b/i.test(normalized)
        || /\bservice in version "v1" cannot be handled as a service\b/i.test(normalized)
        || /\bingress in version "v1" cannot be handled as an ingress\b/i.test(normalized);
}

function isKubectlInvalidMutationSyntaxFailure(error = '') {
    const normalized = String(error || '').trim().toLowerCase();
    return /\berror:\s*unknown flag:\s*--add\b/.test(normalized)
        || /\bsee 'kubectl set --help' for usage\b/.test(normalized);
}

function buildStaticSiteHtmlForRecovery({ appName = 'live-site', title = 'Live Site' } = {}) {
    const safeTitle = String(title || 'Live Site').replace(/[<>&]/g, '');
    const safeAppName = String(appName || 'live-site').replace(/[<>&]/g, '');
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="utf-8">',
        '  <meta name="viewport" content="width=device-width,initial-scale=1">',
        `  <title>${safeTitle}</title>`,
        '  <style>',
        '    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#101418;color:#f6f2e8;}',
        '    main{min-height:100vh;display:grid;place-items:center;padding:32px;}',
        '    section{width:min(760px,100%);border:1px solid #37505c;background:#17212b;padding:28px;}',
        '    h1{margin:0 0 12px;font-size:clamp(2rem,8vw,4.5rem);letter-spacing:0;}',
        '    time{display:block;color:#8be9d2;font-size:1.2rem;margin-top:18px;}',
        '    .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-top:24px;}',
        '    .grid span{aspect-ratio:1;border:1px solid #37505c;display:grid;place-items:center;background:#111923;}',
        '  </style>',
        '</head>',
        '<body>',
        '  <main>',
        '    <section>',
        `      <h1>${safeTitle}</h1>`,
        `      <p>${safeAppName} is running from the k3s cluster.</p>`,
        '      <time id="now"></time>',
        '      <div class="grid" aria-label="calendar preview">',
        '        <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span>',
        '        <span>8</span><span>9</span><span>10</span><span>11</span><span>12</span><span>13</span><span>14</span>',
        '        <span>15</span><span>16</span><span>17</span><span>18</span><span>19</span><span>20</span><span>21</span>',
        '        <span>22</span><span>23</span><span>24</span><span>25</span><span>26</span><span>27</span><span>28</span>',
        '      </div>',
        '    </section>',
        '  </main>',
        '  <script>setInterval(()=>{document.getElementById("now").textContent=new Date().toLocaleString();},1000);</script>',
        '</body>',
        '</html>',
    ].join('\n');
}

function buildKubectlStaticSiteRecoveryCommand({ objective = '', failedCommand = '', errorText = '' } = {}) {
    const source = [objective, failedCommand, errorText].join('\n');
    const app = inferStaticSiteAppName(objective, failedCommand);
    const namespace = extractKubernetesNamespaceFromText(source, 'web');
    const domain = String(config.deploy.defaultPublicDomain || 'demoserver2.buzz').trim() || 'demoserver2.buzz';
    const host = extractLikelyPublicHost(source, `${app}.${domain}`);
    const ingressClass = String(config.deploy.defaultIngressClassName || 'traefik').trim() || 'traefik';
    const issuer = String(config.deploy.defaultTlsClusterIssuer || 'letsencrypt-prod').trim() || 'letsencrypt-prod';
    const title = app === 'live-calendar' ? 'Live Calendar' : app.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
    const configMapName = `${app}-html`;
    const tlsSecretName = `${app}-tls`;
    const htmlEncoded = Buffer.from(buildStaticSiteHtmlForRecovery({ appName: app, title }), 'utf8').toString('base64');
    const patch = JSON.stringify({
        spec: {
            template: {
                spec: {
                    volumes: [
                        {
                            name: 'html',
                            configMap: {
                                name: configMapName,
                            },
                        },
                    ],
                    containers: [
                        {
                            name: app,
                            volumeMounts: [
                                {
                                    name: 'html',
                                    mountPath: '/usr/share/nginx/html/index.html',
                                    subPath: 'index.html',
                                },
                            ],
                        },
                    ],
                },
            },
        },
    });

    return [
        'set -e',
        'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml',
        `ns=${shellQuote(namespace)}`,
        `app=${shellQuote(app)}`,
        `cm=${shellQuote(configMapName)}`,
        `host=${shellQuote(host)}`,
        `ingress_class=${shellQuote(ingressClass)}`,
        `issuer=${shellQuote(issuer)}`,
        `tls_secret=${shellQuote(tlsSecretName)}`,
        'tmp_html=$(mktemp)',
        "cat <<'__KIMI_STATIC_SITE_HTML_B64__' | base64 -d > \"$tmp_html\"",
        htmlEncoded,
        '__KIMI_STATIC_SITE_HTML_B64__',
        'kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -',
        'kubectl create configmap "$cm" -n "$ns" --from-file=index.html="$tmp_html" --dry-run=client -o yaml | kubectl apply -f -',
        'kubectl create deployment "$app" --image=nginx:1.27-alpine --replicas=1 -n "$ns" --dry-run=client -o yaml | kubectl apply -f -',
        `kubectl patch deployment "$app" -n "$ns" --type=strategic -p ${shellQuote(patch)}`,
        'kubectl expose deployment "$app" --name "$app" --port=80 --target-port=80 -n "$ns" --dry-run=client -o yaml | kubectl apply -f -',
        'kubectl create ingress "$app" --class="$ingress_class" --rule="$host/*=$app:80,tls=$tls_secret" --annotation="cert-manager.io/cluster-issuer=$issuer" -n "$ns" --dry-run=client -o yaml | kubectl apply -f -',
        'rm -f "$tmp_html"',
        'kubectl rollout status deployment/"$app" -n "$ns" --timeout=180s',
        'kubectl get deployment,svc,ingress -n "$ns" -o wide',
        'kubectl exec -n "$ns" deployment/"$app" -- sed -n "1,24p" /usr/share/nginx/html/index.html',
    ].join('\n');
}

function getRunnerCliTools(runner = null) {
    const metadata = runner?.metadata || {};
    const cliTools = Array.isArray(metadata.cliTools) ? metadata.cliTools : [];
    if (cliTools.length > 0) {
        return cliTools
            .map((tool) => ({
                name: String(tool?.name || '').trim(),
                available: tool?.available !== false,
                path: String(tool?.path || '').trim(),
            }))
            .filter((tool) => tool.name);
    }

    return (Array.isArray(metadata.availableCliTools) ? metadata.availableCliTools : [])
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .map((name) => ({
            name,
            available: true,
            path: '',
        }));
}

function summarizeRemoteRunnerCliTools(runner = null) {
    if (!runner) {
        return '';
    }

    const cliTools = getRunnerCliTools(runner);
    const available = cliTools
        .filter((tool) => tool.available)
        .map((tool) => tool.path ? `${tool.name}=${tool.path}` : tool.name)
        .slice(0, 24);
    const missing = cliTools
        .filter((tool) => tool.available === false)
        .map((tool) => tool.name)
        .slice(0, 12);
    const workspace = runner.metadata?.defaultCwd || runner.metadata?.workspace || '';
    const shell = runner.metadata?.shell || '';
    const browserAutomation = runner.metadata?.browserAutomation || {};
    const parts = [
        `Runner ${runner.runnerId || 'unknown'} is online.`,
        workspace ? `Workspace: ${workspace}.` : '',
        shell ? `Shell: ${shell}.` : '',
        available.length > 0 ? `Available CLI tools: ${available.join(', ')}.` : '',
        missing.length > 0 ? `Missing or unavailable common tools: ${missing.join(', ')}.` : '',
        browserAutomation.screenshotReady
            ? `Browser visual QA: Playwright ${browserAutomation.playwrightVersion || ''} with ${browserAutomation.browserExecutablePath}; UI screenshot command: ${browserAutomation.uiCheckCommand}.`
            : '',
    ].filter(Boolean);

    return parts.join(' ');
}

function parseKubernetesInitContainerFailure(output = '') {
    const text = String(output || '');
    if (!text || !/Init Containers:/.test(text) || !/(CrashLoopBackOff|Exit Code:\s*[1-9])/.test(text)) {
        return null;
    }

    const lines = text.split(/\r?\n/);
    let podName = null;
    let namespace = null;
    let inInitContainers = false;
    let currentInit = null;
    const initContainers = [];

    for (const rawLine of lines) {
        const line = String(rawLine || '');

        const podMatch = line.match(/^Name:\s+(\S+)/);
        if (podMatch) {
            podName = podMatch[1];
        }

        const namespaceMatch = line.match(/^Namespace:\s+(\S+)/);
        if (namespaceMatch) {
            namespace = namespaceMatch[1];
        }

        if (/^Init Containers:\s*$/.test(line)) {
            inInitContainers = true;
            currentInit = null;
            continue;
        }

        if (inInitContainers && /^[A-Z][A-Za-z ]+:\s*$/.test(line) && !/^Init Containers:\s*$/.test(line)) {
            inInitContainers = false;
            currentInit = null;
        }

        if (!inInitContainers) {
            continue;
        }

        const initMatch = line.match(/^\s{2}([A-Za-z0-9._-]+):\s*$/);
        if (initMatch) {
            currentInit = {
                name: initMatch[1],
                crashLoop: false,
                lastStateError: false,
                exitCode: 0,
            };
            initContainers.push(currentInit);
            continue;
        }

        if (!currentInit) {
            continue;
        }

        if (/Reason:\s+CrashLoopBackOff/.test(line)) {
            currentInit.crashLoop = true;
        }
        if (/Reason:\s+Error/.test(line)) {
            currentInit.lastStateError = true;
        }
        const exitCodeMatch = line.match(/Exit Code:\s+(\d+)/);
        if (exitCodeMatch) {
            currentInit.exitCode = Number(exitCodeMatch[1]) || 0;
        }
    }

    const failingInit = initContainers.find((container) => container.crashLoop || container.lastStateError || container.exitCode > 0);
    if (!podName || !namespace || !failingInit?.name) {
        return null;
    }

    return {
        podName,
        namespace,
        containerName: failingInit.name,
    };
}

function buildRemoteFollowupPlanFromToolEvents({ objective = '', instructions = '', executionProfile = DEFAULT_EXECUTION_PROFILE, toolPolicy = {}, toolEvents = [] } = {}) {
    const remoteToolId = getPreferredRemoteToolId(toolPolicy);
    if (executionProfile !== REMOTE_BUILD_EXECUTION_PROFILE || !remoteToolId) {
        return [];
    }

    const combinedContext = [objective, instructions].filter(Boolean).join('\n');
    const internalArtifactUrl = extractInternalArtifactUrl(combinedContext);
    const latestEvent = Array.isArray(toolEvents) && toolEvents.length > 0
        ? toolEvents[toolEvents.length - 1]
        : null;

    if (hasRemoteWebsiteUpdateIntent(objective) && !hasExplicitLocalArtifactReference(objective)) {
        const missingLocalHtmlArtifact = [...(Array.isArray(toolEvents) ? toolEvents : [])]
            .reverse()
            .find((event) => isMissingLocalHtmlArtifactEvent(event));

        if (missingLocalHtmlArtifact) {
            return [{
                tool: remoteToolId,
                reason: 'A local HTML artifact could not be read. Inspect the remote git workspace and deployed source recovery points instead of blocking on the missing local file.',
                params: {
                    command: buildRemoteWebsiteSourceInspectionCommand(),
                },
            }];
        }

        const lastArtifactFetch = getLastSuccessfulToolEvent(toolEvents, 'web-fetch');
        const lastArtifactFetchArgs = parseToolCallArguments(lastArtifactFetch?.toolCall?.function?.arguments || '{}');
        const fetchedArtifactUrl = extractInternalArtifactUrl(lastArtifactFetchArgs?.url || '');
        const fetchedHtmlBody = typeof lastArtifactFetch?.result?.data?.body === 'string'
            ? lastArtifactFetch.result.data.body.trim()
            : '';

        if (internalArtifactUrl
            && fetchedArtifactUrl
            && normalizeShellCommand(fetchedArtifactUrl) === normalizeShellCommand(internalArtifactUrl)
            && fetchedHtmlBody
            && canonicalizeRemoteToolId(latestEvent?.toolCall?.function?.name || latestEvent?.result?.toolId || '') === 'web-fetch') {
            return [{
                tool: remoteToolId,
                reason: 'Use the artifact content fetched locally by this runtime to update the remote website ConfigMap instead of asking the target server to curl the backend artifact URL.',
                params: {
                    command: buildRemoteConfigMapApplyCommand(
                        fetchedHtmlBody,
                        extractRemoteWebsiteConfigMapName(toolEvents),
                    ),
                },
            }];
        }

        const lastRemoteEvent = getLastRemoteToolEvent(toolEvents);
        if (internalArtifactUrl
            && toolPolicy.allowedToolIds?.includes('web-fetch')
            && lastRemoteEvent?.result?.success === false
            && isInternalArtifactRemoteFetchFailure(lastRemoteEvent?.result?.error || '')) {
            return [{
                tool: 'web-fetch',
                reason: 'The remote server cannot reach the app-local artifact endpoint. Fetch the artifact content locally in this runtime before sending it to the remote target.',
                params: {
                    url: internalArtifactUrl,
                },
            }];
        }

        if (lastRemoteEvent?.result?.success === false
            && isWebsiteResourceTypeAsDeploymentFailure(lastRemoteEvent?.result?.error || '')) {
            return [{
                tool: remoteToolId,
                reason: 'The previous command treated service or ingress resource types as deployment names. Re-inspect deployments, services, ingresses, pods, and ConfigMaps separately before changing the live website again.',
                params: {
                    command: buildRemoteWebsiteWorkloadInspectionCommand(),
                },
            }];
        }

        if (lastRemoteEvent?.result?.success === false
            && isWebsiteTitleOnlyVerificationFailure(lastRemoteEvent?.result?.error || '')) {
            return [{
                tool: remoteToolId,
                reason: 'The previous verification relied on page titles, which may be empty. Verify the mounted HTML body and public response content directly instead.',
                params: {
                    command: buildRemoteWebsiteBodyVerificationCommand(),
                },
            }];
        }
    }

    const lastRemoteEvent = getLastRemoteToolEvent(toolEvents);
    if (!lastRemoteEvent || lastRemoteEvent?.result?.success === false) {
        return [];
    }

    const lastArgs = parseToolCallArguments(lastRemoteEvent?.toolCall?.function?.arguments || '{}');

    const combinedOutput = [
        objective,
        lastArgs.command || '',
        lastRemoteEvent?.result?.data?.stdout || '',
        lastRemoteEvent?.result?.data?.stderr || '',
    ].join('\n');

    if (hasRemoteWebsiteUpdateIntent(objective) && !hasExplicitLocalArtifactReference(objective)) {
        const lastCommand = String(lastArgs.command || '').trim();
        const lastRemoteOutput = [
            lastRemoteEvent?.result?.data?.stdout || '',
            lastRemoteEvent?.result?.data?.stderr || '',
        ].join('\n');
        const alreadyInspectingRemoteSource = normalizeShellCommand(lastCommand) === normalizeShellCommand(buildRemoteWebsiteSourceInspectionCommand())
            || hasRemoteWebsiteInspectionSignal(lastRemoteOutput);

        if (!alreadyInspectingRemoteSource && isGenericRemoteBaselineCommand(lastCommand)) {
            return [{
                tool: remoteToolId,
                reason: 'The generic server baseline completed. Inspect the remote git workspace and deployed source recovery points next so the page can be updated in version control.',
                params: {
                    command: buildRemoteWebsiteSourceInspectionCommand(),
                },
            }];
        }
    }

    const initFailure = parseKubernetesInitContainerFailure(combinedOutput);
    if (initFailure) {
        return [{
            tool: remoteToolId,
            reason: `Fetch failing init container logs for ${initFailure.namespace}/${initFailure.podName} after detecting an init container crash.`,
            params: {
                command: `kubectl logs -n ${shellQuote(initFailure.namespace)} ${shellQuote(initFailure.podName)} -c ${shellQuote(initFailure.containerName)} --previous || kubectl logs -n ${shellQuote(initFailure.namespace)} ${shellQuote(initFailure.podName)} -c ${shellQuote(initFailure.containerName)}`,
            },
        }];
    }

    return [];
}

function getLastFailedToolEvent(toolEvents = []) {
    return [...(Array.isArray(toolEvents) ? toolEvents : [])]
        .reverse()
        .find((event) => event?.result?.success === false) || null;
}

function buildDeterministicRecoveryPlanFromFailure({
    objective = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    toolPolicy = {},
    toolEvents = [],
    recentMessages = [],
    session = null,
} = {}) {
    const failedEvent = getLastFailedToolEvent(toolEvents);
    if (!failedEvent) {
        return [];
    }

    const toolId = canonicalizeRemoteToolId(failedEvent?.toolCall?.function?.name || failedEvent?.result?.toolId || '');
    const errorText = [
        failedEvent?.result?.error || '',
        failedEvent?.result?.data?.stdout || '',
        failedEvent?.result?.data?.stderr || '',
    ].join('\n');

    const remoteToolId = getPreferredRemoteToolId(toolPolicy);
    if (executionProfile !== REMOTE_BUILD_EXECUTION_PROFILE || !remoteToolId || !isRemoteCommandToolId(toolId)) {
        return [];
    }

    const args = parseToolCallArguments(failedEvent?.toolCall?.function?.arguments || '{}');
    const command = String(args.command || '').trim();
    const combined = [objective, command, errorText].join('\n');

    if ((isKubernetesManifestAuthoringFailure(errorText) || isKubectlInvalidMutationSyntaxFailure(errorText))
        && /\b(kubectl|deployment|service|ingress|configmap|calendar|website|site)\b/i.test(combined)) {
        return [{
            tool: remoteToolId,
            reason: 'Recover from malformed Kubernetes YAML or invalid kubectl mutation syntax by using known-good kubectl generators, ConfigMap mounting, rollout status, and body verification.',
            params: {
                command: buildKubectlStaticSiteRecoveryCommand({
                    objective,
                    failedCommand: command,
                    errorText,
                }),
            },
        }];
    }

    const initFailure = parseKubernetesInitContainerFailure(combined);
    if (initFailure) {
        return [{
            tool: remoteToolId,
            reason: `Fetch failing init container logs for ${initFailure.namespace}/${initFailure.podName} before asking for help.`,
            params: {
                command: `kubectl logs -n ${shellQuote(initFailure.namespace)} ${shellQuote(initFailure.podName)} -c ${shellQuote(initFailure.containerName)} --previous || kubectl logs -n ${shellQuote(initFailure.namespace)} ${shellQuote(initFailure.podName)} -c ${shellQuote(initFailure.containerName)}`,
            },
        }];
    }

    if (/\bkubectl\b/i.test(command) && /\b(crashloopbackoff|init:|exit code|imagepullbackoff|errimagepull|containercreating|pending)\b/i.test(combined)) {
        return [{
            tool: remoteToolId,
            reason: 'Follow the failed Kubernetes command with a broader pod diagnostic pass before pausing.',
            params: {
                command: 'kubectl get pods -A -o wide && kubectl get events -A --sort-by=.lastTimestamp | tail -n 80',
            },
        }];
    }

    if (isTransientToolFailure(failedEvent?.result || {})) {
        const retryParams = {
            ...args,
            ...(Number(args.timeoutMs || 0) > 0
                ? { timeoutMs: Math.max(Number(args.timeoutMs), 60000) }
                : { timeoutMs: 60000 }),
        };
        return [{
            tool: remoteToolId,
            reason: 'Retry the transient remote failure once with a longer timeout before replanning.',
            params: retryParams,
        }];
    }

    return [];
}

function buildResearchFollowupPlanFromToolEvents({ objective = '', toolPolicy = {}, toolEvents = [] } = {}) {
    if (!hasExplicitWebResearchIntentText(objective) && !hasCurrentInfoIntentText(objective)) {
        return [];
    }

    const lastSearchEvent = getLastSuccessfulToolEvent(toolEvents, 'web-search');
    const searchResults = Array.isArray(lastSearchEvent?.result?.data?.results)
        ? lastSearchEvent.result.data.results
        : [];
    if (searchResults.length === 0) {
        return [];
    }

    const maxPages = hasDocumentWorkflowIntentText(objective)
        ? Math.min(2, normalizeResearchFollowupPageCount())
        : normalizeResearchFollowupPageCount();
    const followupCandidates = [];
    const seen = new Set();

    for (const entry of searchResults) {
        const url = String(entry?.url || '').trim();
        if (!url || seen.has(url)) {
            continue;
        }

        seen.add(url);
        followupCandidates.push(url);
        if (followupCandidates.length >= maxPages) {
            break;
        }
    }

    if (followupCandidates.length === 0) {
        return [];
    }

    const preferRenderedFollowups = hasCurrentInfoIntentText(objective);
    if (preferRenderedFollowups && toolPolicy.candidateToolIds.includes('web-scrape')) {
        return followupCandidates.map((url) => ({
            tool: 'web-scrape',
            reason: 'Current-information research follow-up should verify top search results with rendered page scraping.',
            params: {
                url,
                browser: true,
                timeout: 20000,
            },
        }));
    }

    if (toolPolicy.candidateToolIds.includes('web-fetch')) {
        return followupCandidates.map((url) => ({
            tool: 'web-fetch',
            reason: 'Deterministic research follow-up should verify top search results with page fetches.',
            params: {
                url,
                timeout: 20000,
                cache: true,
            },
        }));
    }

    if (toolPolicy.candidateToolIds.includes('web-scrape')) {
        return followupCandidates.map((url) => ({
            tool: 'web-scrape',
            reason: 'Deterministic research follow-up should verify top search results with rendered page scraping.',
            params: {
                url,
                browser: true,
                timeout: 20000,
            },
        }));
    }

    return [];
}

function buildDocumentWorkflowFollowupPlanFromToolEvents({ objective = '', toolPolicy = {}, toolEvents = [], clientSurface = '' } = {}) {
    if (!hasDocumentWorkflowIntentText(objective)
        || !toolPolicy.candidateToolIds.includes(DOCUMENT_WORKFLOW_TOOL_ID)) {
        return [];
    }

    const params = buildDocumentWorkflowGenerateParams({
        objective,
        toolEvents,
        clientSurface,
    });

    if (!Array.isArray(params.sources) || params.sources.length === 0) {
        return [];
    }

    return [{
        tool: DOCUMENT_WORKFLOW_TOOL_ID,
        reason: 'Verified research results are ready to be compiled into the requested document or slide deck.',
        params,
    }];
}

function buildDesignResourceFollowupPlanFromToolEvents({ objective = '', toolPolicy = {}, toolEvents = [] } = {}) {
    if (!toolPolicy?.rolePipeline?.requiresDesign
        || !toolPolicy.candidateToolIds.includes('design-resource-search')
        || getLastSuccessfulToolEvent(toolEvents, 'design-resource-search')) {
        return [];
    }

    if (toolPolicy.rolePipeline.requiresResearch
        && !hasGroundedResearchToolResult(toolEvents)
        && !getLastSuccessfulToolEvent(toolEvents, 'web-search')) {
        return [];
    }

    return [{
        tool: 'design-resource-search',
        reason: 'The design role needs curated resource guidance before building the requested website or document artifact.',
        params: buildDesignResourceSearchParams({
            objective,
            rolePipeline: toolPolicy.rolePipeline,
        }),
    }];
}

function shouldAllowGuardedCompletionContinuation({
    objective = '',
    toolPolicy = {},
    completionReview = null,
    autonomyApproved = false,
    blocking = false,
    budgetExceeded = false,
    round = 0,
    budgetState = null,
} = {}) {
    if (autonomyApproved || blocking || budgetExceeded) {
        return false;
    }

    if (!Array.isArray(completionReview?.unmetCriteria) || completionReview.unmetCriteria.length === 0) {
        return false;
    }

    if (!budgetState
        || round >= Number(budgetState.maxRounds || 0)
        || Number(budgetState.maxToolCalls || 0) <= 0) {
        return false;
    }

    const objectiveNeedsDeterministicFollowup = hasExplicitWebResearchIntentText(objective)
        || hasCurrentInfoIntentText(objective)
        || hasDocumentWorkflowIntentText(objective)
        || toolPolicy?.rolePipeline?.requiresDesign === true
        || toolPolicy?.rolePipeline?.requiresBuild === true
        || toolPolicy?.projectPlan?.status === 'active'
        || toolPolicy?.workflow?.status === 'active';

    return objectiveNeedsDeterministicFollowup;
}

function isSerializedToolCallWrapperText(text = '') {
    const trimmed = String(text || '').trim();
    if (!trimmed || !/tool_calls|finish_reason|output_text/i.test(trimmed)) {
        return false;
    }

    const parsed = safeJsonParse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return false;
    }

    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    if (toolCalls.length === 0) {
        return false;
    }

    const finishReason = String(parsed.finish_reason || parsed.finishReason || '').trim().toLowerCase();
    const outputText = String(parsed.output_text || parsed.outputText || '').trim();
    const displayText = [
        parsed.assistant_reply,
        parsed.assistantReply,
        parsed.message,
        parsed.content,
        parsed.text,
        parsed.answer,
    ].find((entry) => typeof entry === 'string' && entry.trim());

    return !displayText && (!outputText || finishReason === 'tool_calls');
}

function collectJsonCandidatesFromText(text = '') {
    const source = String(text || '').trim();
    if (!source) {
        return [];
    }

    const candidates = [];
    const whole = safeJsonParse(source);
    if (whole && typeof whole === 'object') {
        candidates.push(whole);
    }

    const fencePattern = /```(?:json|javascript|js|text)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = fencePattern.exec(source)) !== null) {
        const parsed = safeJsonParse(match[1] || '');
        if (parsed && typeof parsed === 'object') {
            candidates.push(parsed);
        }
    }

    return candidates;
}

function collectDsmlToolCallCandidatesFromText(text = '') {
    const source = String(text || '').trim();
    if (!source || !/<\s*[|｜]\s*(?:DSML\s*[|｜]\s*)?(?:tool_calls|invoke|parameter)\b/i.test(source)) {
        return [];
    }

    const normalized = source.replace(/｜/g, '|');
    const candidates = [];
    const invokePattern = /<\s*\|\s*(?:DSML\s*\|\s*)?invoke\b([^>]*)>([\s\S]*?)<\s*\/\s*\|\s*(?:DSML\s*\|\s*)?invoke\s*>/gi;
    let invokeMatch;

    while ((invokeMatch = invokePattern.exec(normalized)) !== null) {
        const attrs = invokeMatch[1] || '';
        const body = invokeMatch[2] || '';
        const name = (attrs.match(/\bname\s*=\s*"([^"]+)"/i)?.[1] || '').trim();
        if (!name) {
            continue;
        }

        const params = {};
        const parameterPattern = /<\s*\|\s*(?:DSML\s*\|\s*)?parameter\b([^>]*)>([\s\S]*?)<\s*\/\s*\|\s*(?:DSML\s*\|\s*)?parameter\s*>/gi;
        let parameterMatch;
        while ((parameterMatch = parameterPattern.exec(body)) !== null) {
            const parameterAttrs = parameterMatch[1] || '';
            const parameterName = (parameterAttrs.match(/\bname\s*=\s*"([^"]+)"/i)?.[1] || '').trim();
            if (!parameterName) {
                continue;
            }
            params[parameterName] = String(parameterMatch[2] || '').trim();
        }

        candidates.push({
            tool: name,
            params,
        });
    }

    return candidates;
}

function decodeXmlEntityText(value = '') {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
}

function collectHarmonyToolCallCandidatesFromText(text = '') {
    const source = String(text || '').trim();
    if (!source || !/<\s*tool_call\b/i.test(source)) {
        return [];
    }

    const candidates = [];
    const toolCallPattern = /<\s*tool_call\b[^>]*>([\s\S]*?)<\s*\/\s*tool_call\s*>/gi;
    let match;

    while ((match = toolCallPattern.exec(source)) !== null) {
        const body = String(match[1] || '').trim();
        const toolName = decodeXmlEntityText(
            body.match(/^\s*([a-z0-9_.:-]+)\b/i)?.[1]
                || body.match(/<\s*tool_name\s*>([\s\S]*?)<\s*\/\s*tool_name\s*>/i)?.[1]
                || '',
        );
        if (!toolName) {
            continue;
        }

        const params = {};
        const argPairPattern = /<\s*arg_key\s*>([\s\S]*?)<\s*\/\s*arg_key\s*>\s*<\s*arg_value\s*>([\s\S]*?)<\s*\/\s*arg_value\s*>/gi;
        let argMatch;
        while ((argMatch = argPairPattern.exec(body)) !== null) {
            const key = decodeXmlEntityText(argMatch[1] || '');
            if (!key) {
                continue;
            }
            params[key] = decodeXmlEntityText(argMatch[2] || '');
        }

        candidates.push({
            tool: toolName,
            params,
        });
    }

    return candidates;
}

function parsePayloadObject(value = null) {
    if (!value) {
        return null;
    }

    if (typeof value === 'object') {
        return value;
    }

    if (typeof value === 'string') {
        return parseLenientJson(value);
    }

    return null;
}

function findRemoteCommandPayload(value = null, seen = null) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const visited = seen || new WeakSet();
    if (visited.has(value)) {
        return null;
    }
    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            const match = findRemoteCommandPayload(item, visited);
            if (match) {
                return match;
            }
        }
        return null;
    }

    const toolId = canonicalizeRemoteToolId(
        value.tool
        || value.toolId
        || value.name
        || value.function?.name
        || value.toolCall?.function?.name
        || '',
    );
    const args = parsePayloadObject(value.arguments || value.function?.arguments || value.toolCall?.function?.arguments) || {};
    const params = parsePayloadObject(value.params || value.parameters) || {};
    const merged = {
        ...args,
        ...params,
        ...value,
    };
    const command = typeof merged.command === 'string' ? merged.command.trim() : '';
    const hasRemoteTarget = Boolean(
        merged.host
        || merged.hostname
        || merged.username
        || merged.port
        || merged.profile
        || merged.workflowAction
        || merged.workflow_action
    );

    const recoveredParams = {
        ...(command ? { command } : {}),
        ...(merged.host || merged.hostname ? { host: String(merged.host || merged.hostname).trim() } : {}),
        ...(merged.username ? { username: String(merged.username).trim() } : {}),
        ...(merged.port ? { port: merged.port } : {}),
        ...(merged.profile ? { profile: merged.profile } : {}),
        ...(merged.workflowAction ? { workflowAction: merged.workflowAction } : {}),
        ...(merged.workflow_action ? { workflowAction: merged.workflow_action } : {}),
        ...(merged.timeout ? { timeout: merged.timeout } : {}),
    };

    if (command && (isRemoteCommandToolId(toolId) || hasRemoteTarget)) {
        return {
            toolId: isRemoteCommandToolId(toolId) ? toolId : 'remote-command',
            command,
            params: recoveredParams,
        };
    }

    if (isRemoteCommandToolId(toolId) && (Object.keys(args).length > 0 || Object.keys(params).length > 0)) {
        return {
            toolId,
            command,
            params: recoveredParams,
        };
    }

    for (const key of ['tool_calls', 'toolCalls', 'calls', 'items', 'output']) {
        const match = findRemoteCommandPayload(value[key], visited);
        if (match) {
            return match;
        }
    }

    return null;
}

function isLeakedRemoteCommandPayloadText(text = '') {
    const source = String(text || '').trim();
    if (!source || !/(command|hostname|username|tool_calls|remote-command|ssh-execute|k3s-deploy)/i.test(source)) {
        return false;
    }

    return collectJsonCandidatesFromText(source).some((candidate) => Boolean(findRemoteCommandPayload(candidate)))
        || collectDsmlToolCallCandidatesFromText(source).some((candidate) => Boolean(findRemoteCommandPayload(candidate)))
        || collectHarmonyToolCallCandidatesFromText(source).some((candidate) => Boolean(findRemoteCommandPayload(candidate)));
}

function buildRecoveryPlanFromLeakedRemoteCommandPayload(text = '', toolPolicy = {}) {
    const remoteToolId = getPreferredRemoteToolId(toolPolicy) || 'remote-command';
    const candidateToolIds = Array.isArray(toolPolicy?.candidateToolIds) ? toolPolicy.candidateToolIds : [];
    if (candidateToolIds.length === 0) {
        return [];
    }

    if (candidateToolIds.includes(remoteToolId)) {
        for (const candidate of collectJsonCandidatesFromText(text)) {
            const payload = findRemoteCommandPayload(candidate);
            if (!payload?.params?.command) {
                continue;
            }

            return [{
                tool: remoteToolId,
                reason: 'Recover leaked remote-command JSON by executing it as a verified tool call.',
                params: payload.params,
            }];
        }

        for (const candidate of collectDsmlToolCallCandidatesFromText(text)) {
            const payload = findRemoteCommandPayload(candidate);
            if (!payload?.params?.command) {
                continue;
            }

            return [{
                tool: remoteToolId,
                reason: 'Recover leaked remote-command DSML by executing it as a verified tool call.',
                params: payload.params,
            }];
        }

        for (const candidate of collectHarmonyToolCallCandidatesFromText(text)) {
            const payload = findRemoteCommandPayload(candidate);
            if (!payload?.params?.command) {
                continue;
            }

            return [{
                tool: remoteToolId,
                reason: 'Recover leaked remote-command Harmony tool call by executing it as a verified tool call.',
                params: payload.params,
            }];
        }
    }

    for (const candidate of collectHarmonyToolCallCandidatesFromText(text)) {
        const tool = canonicalizeRemoteToolId(candidate.tool || '');
        const params = candidate.params && typeof candidate.params === 'object' ? { ...candidate.params } : {};
        if (!tool || !candidateToolIds.includes(tool) || Object.keys(params).length === 0) {
            continue;
        }
        if (tool === 'tool-doc-read' && !params.toolId && params.title) {
            params.toolId = params.title;
            delete params.title;
        }
        return [{
            tool,
            reason: 'Recover leaked Harmony tool call by executing it as a verified tool call.',
            params,
        }];
    }

    return [];
}

function isInvalidRuntimeResponseText(text = '') {
    if (isSerializedToolCallWrapperText(text)) {
        return true;
    }
    if (isLeakedRemoteCommandPayloadText(text)) {
        return true;
    }
    if (collectHarmonyToolCallCandidatesFromText(text).length > 0) {
        return true;
    }
    const normalized = String(text || '').trim().toLowerCase().replace(/[â€™]/g, '\'');
    if (!normalized) {
        return false;
    }

    return [
        'cli_help sub-agent',
        'generalist agent',
        'provided file-system tools',
        'current environment\'s available toolset',
        'current workspace in /app',
        'i do not have access to an ssh-execute tool',
        'i do not have a usable remote-build or ssh execution tool',
        'i can\'t access the remote server from this environment',
        'i cannot access the remote server from this environment',
        'this session is restricted from network/ssh access',
        'this session is restricted from network access',
        'no ssh/network path to the remote server',
        'no ssh path to the remote server',
        'i can\'t run remote-build',
        'i cannot run remote-build',
        'i can\'t connect via ssh',
        'i cannot connect via ssh',
        'i can\'t execute ssh from this session',
        'i cannot execute ssh from this session',
        'bwrap: no permissions to create a new namespace',
        'bwrap: no permissions to create a new na',
        'bwrap: no permissions',
        'basic local commands fail before any ssh attempt',
        'testing command execution first',
        'fails before any remote connection starts',
        'fails before any network connection starts',
        'workspace can execute anything locally',
        'launch a remote check from /app',
        'can\'t inspect config or launch a remote check from /app',
        'what i can do from this session',
        'what i cannot do in this session',
        'runtime exposes a writable file tool',
        'github/canva connector tools',
        'create a new local git repo in /app',
        'i cannot create a new repo from this exact turn',
        'run git init, builds, or normal shell commands',
        'modify the local filesystem',
        'the exact blocker is the runtime sandbox',
        'kernel does not allow non-privileged user namespaces',
        'i don\'t have any remote execution tools available',
        'i do not have any remote execution tools available',
        'remote execution tools available in this turn',
        'i don\'t have tool access in this session',
        'i do not have tool access in this session',
        'unfortunately i don\'t have tool access in this session',
    ].some((pattern) => normalized.includes(pattern));
}

function hasExplicitLocalSandboxIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(run|execute|test)\b[\s\S]{0,40}\b(code|script|snippet)\b/.test(normalized)
        || /\b(code sandbox|sandbox|locally|local code)\b/.test(normalized);
}

function hasRemoteInfraToolUsageIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const requestsDocsOrCommands = [
        /\b(command|commands|syntax|usage|docs?|documentation|example|examples|playbook|reference|references)\b/,
        // Treat `.help` domains like `example.help` as hostnames, not doc requests.
        /\b(give|show|list|need|want|open|read|pull|fetch)\b[\s\S]{0,24}(?<!\.)\bhelp\b/,
        /(?<!\.)\bhelp\b[\s\S]{0,24}\b(with|for|on|about)\b/,
        /\bhow\b[\s\S]{0,24}\b(use|run|invoke|call)\b/,
        /\bgive\b[\s\S]{0,24}\b(command|commands|example|examples|playbook|reference)\b/,
    ].some((pattern) => pattern.test(normalized));
    const mentionsRemoteInfra = /\b(k3s-deploy|remote-command|ssh-execute|kubectl|k3s|kubernetes|rancher|ingress|traefik|cert-manager|tls|dns)\b/.test(normalized);

    return requestsDocsOrCommands && mentionsRemoteInfra;
}

function resolveToolDocTargetToolId(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return '';
    }

    if (!hasRemoteInfraToolUsageIntent(normalized)) {
        return '';
    }

    if (/\b(k3s-deploy|sync-and-apply|apply manifests|set image|rollout status)\b/.test(normalized)) {
        return 'k3s-deploy';
    }

    return 'remote-command';
}

function hasRepositoryImplementationIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized || hasDiscoveryPlanningIntentText(normalized)) {
        return false;
    }

    const repoContext = /\b(this repo|the repo|repository|workspace|codebase|project|app|service|package|module|remote workspace|server workspace|remote repo|server repo)\b/.test(normalized);
    const codeWorkIntent = /\b(implement|implementation|fix|refactor|rewrite|update|modify|edit|patch|add|create|build|compile|test|run tests?|debug)\b/.test(normalized);
    const remoteWorkspaceCue = /\b(remote|server|ssh|host|\/var\/www\/|\/srv\/|\/opt\/|\/home\/[a-z0-9._-]+\/)\b/.test(normalized);
    const infraOnlyIntent = /\b(kubectl|kubernetes|k8s|deployment|deploy|rollout|restart|systemctl|journalctl|ingress|pod|cluster|node|server health|uptime|hostname|dns|tls|certificate|logs?)\b/.test(normalized)
        && !repoContext;

    return repoContext && codeWorkIntent && !infraOnlyIntent && remoteWorkspaceCue;
}

function hasRemoteCliAgentAuthoringIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized || hasDiscoveryPlanningIntentText(normalized)) {
        return false;
    }

    const explicitAssistedCli = /\b(remote cli agent|remote clie agent|remote coding agent|remote code run|remote_code_run|agents sdk remote cli|assisted cli|cli tool)\b/.test(normalized);
    const authoringIntent = /\b(create|make|build|generate|implement|develop|write|update|fix|finish|continue|resume|complete|deploy|publish|launch|ship)\b/.test(normalized);
    const softwareTarget = /\b(app|application|site|website|web app|web page|webpage|frontend|dashboard|visualization|visualisation|viewer|map|globe|world|service)\b/.test(normalized);
    const continuationTarget = /\b(it|that|same|work|project|task)\b/.test(normalized);
    const remoteTarget = /\b(remote|server|host|k3s|k8s|kubernetes|cluster|dns|domain|ingress|traefik|tls|deploy|deployment|live)\b/.test(normalized)
        || /\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/.test(normalized);
    const deploymentIntent = /\b(deploy|redeploy|publish|launch|ship|go live|get (?:it|the app|the site|the website) (?:live|online|deployed)|bring (?:it|the app|the site|the website) (?:live|online)|route|ingress|tls|dns|domain|rollout)\b/.test(normalized);
    const infraOnly = /\b(kubectl get|kubectl describe|logs?|status|health|uptime|journalctl|systemctl status|inspect|diagnose|debug)\b/.test(normalized)
        && !/\b(create|make|build|implement|develop|write|update|fix|deploy|redeploy|publish|launch|ship)\b/.test(normalized);

    if (explicitAssistedCli) {
        return authoringIntent && (softwareTarget || continuationTarget) && (remoteTarget || explicitAssistedCli);
    }

    return authoringIntent && softwareTarget && remoteTarget && deploymentIntent && !infraOnly;
}

function hasRemoteCliAgentContinuationIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /^(?:yes|yeah|yep|ok|okay)?\s*(?:continue|resume|finish|complete|keep going|keep working|go ahead|proceed)\b/,
        /\b(?:continue|resume|finish|complete|keep going|keep working)\b[\s\S]{0,80}\b(?:it|that|same|app|site|project|work|task)\b/,
        /\b(?:go ahead|proceed)\b[\s\S]{0,80}\b(?:remote cli agent|remote clie agent|remote coding agent|that app|the app|it)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function buildRemoteCliAgentTaskForPrompt({ objective = '', priorAgentState = {} } = {}) {
    const currentRequest = String(objective || '').trim();
    const priorTask = String(priorAgentState?.lastTask || '').trim();
    if (!currentRequest || !priorTask || !hasRemoteCliAgentContinuationIntent(currentRequest)) {
        return currentRequest;
    }

    return [
        'Continue the prior remote-cli-agent task to completion.',
        '',
        'Original task:',
        priorTask,
        '',
        'Current user follow-up:',
        currentRequest,
        '',
        'Continuity requirement: keep the same remote session/workspace when available, do not replace the task with a progress callback or status-card text, and keep working through authoring, build, deploy, and live verification unless a real blocker requires user input.',
    ].join('\n');
}

function hasManagedAppIntentText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    return [
        /\bmanaged app\b/i,
        /\bmanaged[- ]app\b/i,
        /\bmanaged\b[\s\S]{0,20}\b(app|apps|catalog|control plane|platform)\b/i,
        /\b(app|apps)\b[\s\S]{0,20}\b(managed catalog|managed-app|control plane)\b/i,
        /\b(gitlab|gitlab[-_ ]runner|gitlab ci|gitea|act[-_ ]runner|gitea actions?|managed app catalog|managed-app catalog|build events webhook)\b/i,
        /\b(managed-app|managed app)\b[\s\S]{0,40}\b(create|build|deploy|publish|launch|ship|update|redeploy|inspect|check|verify|diagnose|debug|troubleshoot|status|show|list|doctor|reconcile|repair)\b/i,
    ].some((pattern) => pattern.test(normalized));
}

function hasManagedAppAuthoringIntent(text = '', options = {}) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized || hasDiscoveryPlanningIntentText(normalized)) {
        return false;
    }

    const executionProfile = String(options.executionProfile || '').trim();
    const explicitManagedAppContext = hasManagedAppIntentText(normalized);
    const appContext = explicitManagedAppContext
        || /\b(app|website|site|frontend|service|game|landing page|web app|web site)\b/.test(normalized);
    const changeIntent = /\b(create|build|deploy|publish|launch|ship|update|fix|edit|modify|rewrite|refactor|patch|develop|make)\b/.test(normalized);
    const remoteContext = executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
        || hasRemoteManagedAppTargetIntent(normalized)
        || /\b(gitlab|gitea|k3s|k8s|kubernetes|cluster|dns|domain|tls|traefik|cert-manager)\b/.test(normalized);

    return explicitManagedAppContext && appContext && changeIntent && remoteContext;
}

function normalizeManagedAppDeployTarget(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
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

function hasRemoteManagedAppTargetIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\bssh\b/,
        /\bremote build\b/,
        /\bremote-build\b/,
        /\b(remote|server|host)\b[\s\S]{0,40}\b(gitlab|gitea|k3s|k8s|kubernetes|cluster)\b/,
        /\b(gitlab|gitea|k3s|k8s|kubernetes|cluster)\b[\s\S]{0,40}\b(remote|server|host|ssh)\b/,
        /\b(build|deploy|run)\b[\s\S]{0,30}\b(on the server|on server|remotely|via ssh)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function applyManagedAppDeploymentTargetDefaults(params = {}, { objective = '', executionProfile = DEFAULT_EXECUTION_PROFILE } = {}) {
    const normalizedParams = params && typeof params === 'object' ? { ...params } : {};
    const explicitTarget = normalizeManagedAppDeployTarget(
        normalizedParams.deployTarget
        || normalizedParams.deploymentTarget
        || normalizedParams.target,
    );
    if (explicitTarget) {
        return {
            ...normalizedParams,
            deployTarget: explicitTarget,
        };
    }

    if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE || hasRemoteManagedAppTargetIntent(objective)) {
        return {
            ...normalizedParams,
            deployTarget: 'runner',
        };
    }

    return normalizedParams;
}

function cleanManagedAppReference(candidate = '') {
    let normalized = String(candidate || '')
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/[.,!?;:]+$/g, '')
        .trim();

    if (!normalized) {
        return '';
    }

    normalized = normalized.split(/\b(?:make|that|which|with|using|and|on|via|for)\b/i)[0].trim();
    if (!normalized) {
        return '';
    }

    const genericReference = normalized.toLowerCase();
    if ([
        'those steps',
        'these steps',
        'that step',
        'this step',
        'that app',
        'this app',
        'the app',
        'that site',
        'this site',
        'the site',
        'that website',
        'this website',
        'the website',
        'the managed app',
        'managed app',
    ].includes(genericReference)) {
        return '';
    }

    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (wordCount > 5) {
        return '';
    }

    return normalized;
}

function extractManagedAppReference(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return '';
    }

    const patterns = [
        /\b(?:fix|update|modify|change|edit|refresh|rebuild|deploy|redeploy|publish|inspect|show|check|verify|diagnose|debug|troubleshoot|status|describe|review|build|create|make)\s+([a-z0-9][a-z0-9-]{1,63})\s+(?:app|website|site|frontend|service|game)\b/i,
        /\bmanaged app\s+([a-z0-9]+-[a-z0-9-]{1,63})\b/i,
        /\b(?:for|on|with)\s+(?:the\s+)?([^"',.\n]+?)(?=\s+(?:to\s+(?:get|bring|take)\s+it\s+(?:online|live)|online|live|deployed|published)\b)/i,
        /\b(?:managed app|app|website|site|frontend|service|game)\s+(?:called|named)\s+["'`]?([^"',.\n]+?)["'`]?(?=$|[,.!?]|\s+(?:make|that|which|with|using)\b)/i,
        /\b(?:called|named)\s+["'`]?([^"',.\n]+?)["'`]?(?=$|[,.!?]|\s+(?:make|that|which|with|using)\b)/i,
        /\b(?:managed app|app|website|site|frontend|service|game)\s+["'`]([^"'`\n]{1,64})["'`]/i,
    ];

    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        const candidate = cleanManagedAppReference(match?.[1] || '');
        if (candidate) {
            return candidate;
        }
    }

    return '';
}

function titleizeManagedAppReference(reference = '') {
    return String(reference || '')
        .trim()
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}

function extractManagedAppReferenceFromRecentMessages(recentMessages = []) {
    const messages = Array.isArray(recentMessages) ? recentMessages : [];
    const patterns = [
        /\binspected\s+([^"',.\n]+?)\s+in the managed app system\b/i,
        /\b(?:repo to work on is|work on is|target(?: app| repo)? is)\s+([^"',.\n]+?)(?=$|[,.!?]|\s+(?:and|so|to)\b)/i,
        /\bmanaged app\s+([^"',.\n]+?)\s*:/i,
    ];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const text = normalizeMessageText(messages[index]?.content || '');
        if (!text) {
            continue;
        }

        const extracted = extractManagedAppReference(text);
        if (extracted) {
            return extracted;
        }

        for (const pattern of patterns) {
            const candidate = cleanManagedAppReference(text.match(pattern)?.[1] || '');
            if (candidate) {
                return candidate;
            }
        }
    }

    return '';
}

function extractManagedAppPromptFromRecentMessages(recentMessages = []) {
    const messages = Array.isArray(recentMessages) ? recentMessages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (String(message?.role || '').trim().toLowerCase() !== 'user') {
            continue;
        }

        const text = normalizeMessageText(message?.content || '').trim();
        if (!text) {
            continue;
        }

        if (hasManagedAppIntentText(text) || /\b(?:repo to work on is|work on is|target(?: app| repo)? is)\b/i.test(text)) {
            return text;
        }
    }

    return '';
}

function inferManagedAppRecoveryActionFromRecentMessages(recentMessages = []) {
    const messages = Array.isArray(recentMessages) ? recentMessages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const text = normalizeMessageText(messages[index]?.content || '');
        if (!text) {
            continue;
        }

        if (/\b(?:next move is to|should)\s+create(?: or reinitialize)?\b/i.test(text)
            || /\bcreate or reinitialize the managed app\b/i.test(text)
            || /\breinitialize the managed app\b/i.test(text)) {
            return 'create';
        }

        if ((/\b(?:status|state)\s+is\s+draft\b/i.test(text) || /\bcurrent state is draft\b/i.test(text))
            && /\b(?:no repo clone url|no ssh url|no creation\/update timestamps|no latest build run|no latest build run attached|no usable managed-app repo\/build record)\b/i.test(text)) {
            return 'create';
        }

        if (MANAGED_APP_RECOVERABLE_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
            return 'create';
        }
    }

    return '';
}

function inferManagedAppRequestedAction(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (/\b(deploy|redeploy|publish|launch|ship|go live|live|online)\b/.test(normalized)) {
        return 'deploy';
    }

    return 'build';
}

function buildManagedAppDirectAction(objective = '', options = {}) {
    const normalized = String(objective || '').trim();
    const executionProfile = String(options.executionProfile || '').trim() || DEFAULT_EXECUTION_PROFILE;
    const workflowLane = String(options.workflow?.lane || '').trim();
    const recentMessages = Array.isArray(options.recentMessages) ? options.recentMessages : [];
    const continuationIntent = isLikelyTranscriptDependentTurn(normalized)
        || /\b(?:go ahead|continue|proceed|from there|those steps|next step|next steps|get it online|get it live|get it deployed)\b/i.test(normalized);
    const reference = extractManagedAppReference(normalized)
        || (continuationIntent ? extractManagedAppReferenceFromRecentMessages(recentMessages) : '');
    const recoveryAction = continuationIntent ? inferManagedAppRecoveryActionFromRecentMessages(recentMessages) : '';
    const recoveryCreate = recoveryAction === 'create';
    const continuationPrompt = recoveryCreate ? extractManagedAppPromptFromRecentMessages(recentMessages) : '';
    const effectivePrompt = [normalized, continuationPrompt]
        .filter((entry, index, array) => entry && array.indexOf(entry) === index)
        .join('\n\n')
        .trim() || normalized;
    const requestedAction = inferManagedAppRequestedAction(normalized);
    const hasCreateIntent = /\b(create|build|make|generate|new)\b/i.test(normalized);
    const hasUpdateIntent = /\b(update|modify|change|edit|refresh|rebuild)\b/i.test(normalized);
    const hasInspectIntent = /\b(inspect|show|status|details?|check|verify|diagnose|debug|troubleshoot|health|healthy|state)\b/i.test(normalized);
    const hasListIntent = /\blist\b/i.test(normalized);
    const hasDeployIntent = /\b(deploy|redeploy|publish|launch|ship|go live|live)\b/i.test(normalized);
    const hasPlatformCue = /\b(gitlab|gitea|runner|runners|actions?|buildkit|platform|control plane|queued|queue|waiting|k3s|cluster|deploy host|remote server)\b/i.test(normalized);
    const hasDoctorIntent = hasPlatformCue && /\b(doctor|diagnose|diagnostic|diagnostics|check|verify|debug|troubleshoot|health|healthy|state|status)\b/i.test(normalized);
    const hasReconcileIntent = hasPlatformCue && /\b(reconcile|repair|fix|unstick|restart|recover|heal)\b/i.test(normalized);
    const hasAuthoringWorkflow = workflowLane === 'repo-only' || workflowLane === 'repo-then-deploy';
    const workflowRequestedAction = workflowLane === 'repo-then-deploy'
        ? 'deploy'
        : (workflowLane === 'repo-only' ? 'build' : requestedAction);
    const isSlugLikeReference = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(reference);

    if (hasListIntent && !hasCreateIntent && !hasUpdateIntent && !hasDeployIntent) {
        return {
            tool: 'managed-app',
            reason: 'Managed app catalog requests should use the dedicated control-plane tool.',
            params: {
                action: 'list',
                limit: 20,
            },
        };
    }

    if (hasReconcileIntent && !hasCreateIntent && !hasUpdateIntent && !hasDeployIntent) {
        return {
            tool: 'managed-app',
            reason: 'Managed app platform repair requests should use the dedicated control-plane tool.',
            params: {
                action: 'reconcile',
            },
        };
    }

    if (hasDoctorIntent && !hasCreateIntent && !hasUpdateIntent && !hasDeployIntent) {
        return {
            tool: 'managed-app',
            reason: 'Managed app platform inspection requests should use the dedicated control-plane tool.',
            params: {
                action: 'doctor',
            },
        };
    }

    if (hasInspectIntent && reference && !recoveryCreate) {
        return {
            tool: 'managed-app',
            reason: 'Managed app inspection requests should use the dedicated control-plane tool.',
            params: {
                action: 'inspect',
                appRef: reference,
            },
        };
    }

    if (hasDeployIntent && !hasCreateIntent && !hasUpdateIntent && reference && !recoveryCreate) {
        return {
            tool: 'managed-app',
            reason: 'Managed app deployment follow-ups should use the backend-owned iteration loop with GitLab and deployment evidence.',
            params: applyManagedAppDeploymentTargetDefaults({
                action: 'iterate',
                requestedAction: 'deploy',
                iterationAction: 'deploy',
                appRef: reference,
                prompt: effectivePrompt,
            }, {
                objective: normalized,
                executionProfile,
            }),
        };
    }

    if (((hasUpdateIntent && reference) || (hasAuthoringWorkflow && reference && !hasCreateIntent)) && !recoveryCreate) {
        return {
            tool: 'managed-app',
            reason: 'Managed app update requests should use the backend-owned iteration loop instead of remote-cli handoff.',
            params: applyManagedAppDeploymentTargetDefaults({
                action: 'iterate',
                requestedAction: workflowRequestedAction,
                iterationAction: hasDeployIntent ? 'deploy' : 'edit',
                appRef: reference,
                prompt: effectivePrompt,
                sourcePrompt: effectivePrompt,
            }, {
                objective: normalized,
                executionProfile,
            }),
        };
    }

    return {
        tool: 'managed-app',
        reason: recoveryCreate
            ? 'Managed app recovery should reinitialize the catalog record and repo/build lane before deployment continues.'
            : 'Managed app creation and deployment requests should use the dedicated control-plane tool.',
        params: applyManagedAppDeploymentTargetDefaults({
            action: 'create',
            prompt: effectivePrompt,
            sourcePrompt: effectivePrompt,
            requestedAction: workflowRequestedAction,
            ...(reference
                ? (isSlugLikeReference
                    ? { slug: reference.toLowerCase() }
                    : { name: reference })
                : {}),
        }, {
            objective: normalized,
            executionProfile,
        }),
    };
}

function resolvePreferredRemoteCliWorkspacePath({ session = null, toolContext = {} } = {}) {
    return String(
        toolContext?.remoteWorkspacePath
        || toolContext?.workspacePath
        || session?.metadata?.remoteWorkingState?.workspacePath
        || session?.metadata?.lastRemoteWorkspacePath
        || config.deploy.defaultTargetDirectory
        || config.deploy.defaultRepositoryPath
        || '',
    ).trim();
}

function hasArchitectureDesignIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(architecture|system design|service diagram|deployment diagram|architecture diagram|design the system)\b/.test(normalized);
}

function hasUmlDiagramIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(uml|class diagram|sequence diagram|activity diagram|use ?case diagram|state diagram|component diagram)\b/.test(normalized);
}

function hasApiDesignIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(api design|design api|openapi|swagger|graphql schema|rest api|grpc)\b/.test(normalized);
}

function hasSchemaDesignIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(database schema|design database|generate ddl|ddl\b|er diagram|entity relationship|orm schema)\b/.test(normalized);
}

function hasMigrationIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(create migration|generate migration|schema migration|database change|schema diff|migration)\b/.test(normalized);
}

function hasSecurityScanIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(security|vulnerab|audit|scan|secret)\b/.test(normalized);
}

function canRecoverFromInvalidRuntimeResponse({ output = '', toolEvents = [], toolPolicy = {} } = {}) {
    if (!isInvalidRuntimeResponseText(output) || !Array.isArray(toolPolicy?.candidateToolIds) || toolPolicy.candidateToolIds.length === 0) {
        return false;
    }

    if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
        return true;
    }

    return !toolEvents.some((event) => {
        const toolName = String(event?.toolCall?.function?.name || '').trim().toLowerCase();
        const succeeded = event?.result?.success !== false;
        return succeeded && toolName !== 'code-sandbox';
    });
}

function isTerminalWorkloadCreationEvent(event = {}) {
    const toolName = String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim().toLowerCase();
    const succeeded = event?.result?.success !== false;
    const action = String(event?.result?.data?.action || '').trim().toLowerCase();
    return succeeded
        && toolName === 'agent-workload'
        && (action === 'create' || action === 'create_from_scenario')
        && Boolean(event?.result?.data?.workload || event?.result?.data?.message);
}

function buildTerminalWorkloadCreationOutput(toolEvents = []) {
    const terminalEvent = [...(Array.isArray(toolEvents) ? toolEvents : [])]
        .reverse()
        .find((event) => isTerminalWorkloadCreationEvent(event));
    if (!terminalEvent) {
        return '';
    }

    const message = String(terminalEvent?.result?.data?.message || '').trim();
    if (message) {
        return message;
    }

    const title = String(terminalEvent?.result?.data?.workload?.title || '').trim();
    return title ? `${title} created.` : 'Deferred workload created.';
}

function buildEndToEndWorkflowBlockedOutput(workflow = null) {
    if (!workflow || typeof workflow !== 'object') {
        return 'The end-to-end builder workflow is blocked.';
    }

    const objective = truncateText(normalizeInlineText(workflow.objective || ''), 240);
    const completionCriteria = Array.isArray(workflow.completionCriteria)
        ? workflow.completionCriteria.map((entry) => normalizeInlineText(entry)).filter(Boolean)
        : [];

    return [
        objective
            ? `End-to-end builder blocked for: ${objective}`
            : 'End-to-end builder blocked.',
        `Lane: ${workflow.lane || 'unknown'}.`,
        workflow.lastError || 'The workflow cannot continue with the current runtime capabilities.',
        completionCriteria.length > 0
            ? `Pending criteria: ${completionCriteria.join('; ')}.`
            : '',
    ].filter(Boolean).join('\n');
}

function shouldRepairInvalidRuntimeResponse({ output = '', toolEvents = [], toolPolicy = {} } = {}) {
    return isInvalidRuntimeResponseText(output)
        && Array.isArray(toolPolicy?.candidateToolIds)
        && toolPolicy.candidateToolIds.length > 0
        && Array.isArray(toolEvents)
        && toolEvents.length > 0;
}

function canonicalizeSignatureValue(value) {
    if (value == null || typeof value !== 'object') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((entry) => canonicalizeSignatureValue(entry));
    }

    return Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .reduce((accumulator, key) => {
            accumulator[key] = canonicalizeSignatureValue(value[key]);
            return accumulator;
        }, {});
}

function normalizeStepSignature(step = {}) {
    return JSON.stringify({
        tool: canonicalizeRemoteToolId(String(step?.tool || '').trim()),
        params: step?.params && typeof step.params === 'object'
            ? canonicalizeSignatureValue(step.params)
            : {},
    });
}

function extractExecutedStepSignature(toolEvent = {}) {
    const toolName = toolEvent?.toolCall?.function?.name || toolEvent?.result?.toolId || '';
    const params = parseToolCallArguments(toolEvent?.toolCall?.function?.arguments || '{}');

    return normalizeStepSignature({
        tool: toolName,
        params,
    });
}

function shouldSkipStepSignature(signature = '', signatureHistory = [], signatureCounts = new Map()) {
    if (!signature) {
        return false;
    }

    if (signatureHistory[signatureHistory.length - 1] === signature) {
        return true;
    }

    return (signatureCounts.get(signature) || 0) >= MAX_STEP_SIGNATURE_REPEATS;
}

function filterRepeatedPlanSteps(steps = [], signatureHistory = [], signatureCounts = new Map()) {
    const accepted = [];
    const plannedHistory = [...signatureHistory];
    const plannedCounts = new Map(signatureCounts);

    for (const step of Array.isArray(steps) ? steps : []) {
        const signature = normalizeStepSignature(step);
        if (shouldSkipStepSignature(signature, plannedHistory, plannedCounts)) {
            continue;
        }

        accepted.push(step);
        plannedHistory.push(signature);
        plannedCounts.set(signature, (plannedCounts.get(signature) || 0) + 1);
    }

    return accepted;
}

function filterRepeatedPlanStepsWithReport(steps = [], signatureHistory = [], signatureCounts = new Map()) {
    const accepted = [];
    const rejected = [];
    const plannedHistory = [...signatureHistory];
    const plannedCounts = new Map(signatureCounts);

    for (const step of Array.isArray(steps) ? steps : []) {
        const signature = normalizeStepSignature(step);
        if (shouldSkipStepSignature(signature, plannedHistory, plannedCounts)) {
            rejected.push({
                step,
                signature,
                count: plannedCounts.get(signature) || 0,
                repeatedImmediately: plannedHistory[plannedHistory.length - 1] === signature,
            });
            continue;
        }

        accepted.push(step);
        plannedHistory.push(signature);
        plannedCounts.set(signature, (plannedCounts.get(signature) || 0) + 1);
    }

    return { accepted, rejected };
}

function recordExecutedStepSignatures(toolEvents = [], signatureHistory = [], signatureCounts = new Map()) {
    for (const event of Array.isArray(toolEvents) ? toolEvents : []) {
        const signature = extractExecutedStepSignature(event);
        if (!signature) {
            continue;
        }

        signatureHistory.push(signature);
        signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);
    }
}

function classifyToolFailure(event = {}, executionProfile = DEFAULT_EXECUTION_PROFILE) {
    if (!event || event?.result?.success !== false) {
        return null;
    }

    const rawToolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
    const toolId = canonicalizeRemoteToolId(rawToolId);
    const error = String(event?.result?.error || '').trim();
    const isRemoteFailure = isRemoteCommandToolId(toolId);

    if (!isRemoteFailure) {
        if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
            && toolId === 'file-read'
            && /\b(enoent|no such file or directory)\b/i.test(error)) {
            return {
                toolId,
                error,
                blocking: false,
                category: 'missing-local-file-recoverable',
            };
        }

        return {
            toolId,
            error,
            blocking: true,
            category: 'non-remote-tool-failure',
        };
    }

    const blocking = REMOTE_BLOCKING_ERROR_PATTERNS.some((pattern) => pattern.test(error));
    return {
        toolId,
        error,
        blocking,
        category: blocking ? 'remote-blocking' : 'remote-recoverable',
    };
}

function isTransientToolFailure(result = {}) {
    const text = `${result?.error || ''}\n${result?.data?.stderr || ''}\n${result?.data?.stdout || ''}`;
    return /\b(timeout|timed out|temporar(?:y|ily)|try again|rate limit|429|502|503|504|econnreset|etimedout|socket hang up)\b/i.test(text);
}

function classifyToolExecutionResult(event = {}, {
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    budgetExceeded = false,
} = {}) {
    if (budgetExceeded) {
        return 'blocked_failure';
    }

    if (isTerminalWorkloadCreationEvent(event)) {
        return 'terminal_success';
    }

    if (event?.result?.success !== false) {
        return 'success';
    }

    const failure = classifyToolFailure(event, executionProfile);
    if (failure && !failure.blocking) {
        return 'retryable_failure';
    }

    if (isTransientToolFailure(event?.result || {})) {
        return 'retryable_failure';
    }

    return 'blocked_failure';
}

function doesToolEventChangeState(event = {}) {
    if (event?.result?.success === false) {
        return false;
    }

    const toolId = canonicalizeRemoteToolId(event?.toolCall?.function?.name || event?.result?.toolId || '');
    const args = parseToolCallArguments(event?.toolCall?.function?.arguments || '{}');
    const command = String(args.command || '').trim().toLowerCase();
    const action = String(args.action || '').trim().toLowerCase();

    if (['file-write', 'git-safe', 'k3s-deploy'].includes(toolId)) {
        return true;
    }

    if (toolId === 'managed-app') {
        return ['create', 'update', 'deploy', 'reconcile'].includes(action);
    }

    if (isRemoteCommandToolId(toolId)) {
        return /\b(kubectl\s+(apply|create|delete|patch|scale|rollout\s+restart)|helm\s+(install|upgrade|rollback)|docker\s+(compose\s+)?(up|restart|run|build)|systemctl\s+(restart|start|enable)|npm\s+(install|run\s+build)|git\s+(pull|clone|checkout|merge|commit|push))\b/i.test(command);
    }

    return false;
}

function inferCompletionEvidenceFromToolEvent(event = {}, { round = null } = {}) {
    if (!event || event?.result?.success === false) {
        return [];
    }

    const toolId = canonicalizeRemoteToolId(event?.toolCall?.function?.name || event?.result?.toolId || '');
    const args = parseToolCallArguments(event?.toolCall?.function?.arguments || '{}');
    const command = String(args.command || '').trim();
    const action = String(args.action || '').trim().toLowerCase();
    const data = event?.result?.data || {};
    const output = [
        command,
        data.stdout || '',
        data.stderr || '',
        data.body || '',
        data.title || '',
        data.status || '',
        data.buildStatus || '',
        JSON.stringify(data).slice(0, 1200),
    ].join('\n');
    if (toolId === 'web-scrape'
        && /\bAuthentication required\b/i.test(output)
        && /\bmissing_token\b/i.test(output)) {
        return [];
    }
    const stateChanged = doesToolEventChangeState(event);
    const base = {
        tool: toolId,
        round,
        stateChanged,
        confidence: 'medium',
    };
    const evidence = [];
    const push = (type, summary, extra = {}) => {
        evidence.push({
            ...base,
            type,
            summary,
            ...extra,
        });
    };

    if (isRemoteCommandToolId(toolId)) {
        if (/\bkubectl\b/i.test(command) || /\b(pod|deployment|service|ingress|namespace)\b/i.test(output)) {
            push('k8s-inspection', 'Kubernetes or remote cluster inspection returned a successful result.');
        }
        if (/\b(successfully rolled out|rollout status|deployment\s+.+\s+successfully)\b/i.test(output)) {
            push('rollout', 'Rollout status confirmed a successful deployment.', { confidence: 'high' });
            push('deployment-verified', 'Deployment verification evidence was captured from rollout status.', { confidence: 'high' });
        }
        if (/\b(running|ready|available)\b/i.test(output) && /\b(pod|pods|deployment|deployments)\b/i.test(output)) {
            push('pod-readiness', 'Pod or deployment readiness was observed in verified remote output.');
        }
        if (/\b(service|svc|ingress|traefik|loadbalancer|clusterip)\b/i.test(output)) {
            push('service-ingress', 'Service or ingress state was inspected successfully.');
        }
        if (/\b(curl|http|https|tls|certificate|dns)\b/i.test(command)
            && /\b(200|301|302|http\/|<html|server:|certificate|issuer|subject)\b/i.test(output)) {
            push('public-verification', 'Public HTTP/TLS reachability or response evidence was captured.', { confidence: 'high' });
            push('deployment-verified', 'Deployment verification evidence was captured from public reachability.', { confidence: 'high' });
        }
        if (stateChanged && /\b(kubectl\s+apply|helm\s+upgrade|rollout\s+restart|docker\s+compose\s+up|systemctl\s+restart)\b/i.test(command)) {
            push('deployment-applied', 'A remote deployment or service-changing command completed successfully.', { confidence: 'high' });
        }
        if (stateChanged && /\b(npm\s+run\s+build|docker\s+(compose\s+)?build|successfully built|build completed)\b/i.test(output)) {
            push('build-complete', 'A remote build command completed successfully.');
        }
        return evidence;
    }

    if (toolId === 'managed-app') {
        if (['create', 'update'].includes(action)) {
            push('managed-app-authoring', 'Managed app create/update completed and produced app metadata.', { confidence: 'high' });
        }
        if (action === 'deploy' || data.deployment || data.deployRun || /\b(deploy|deployed|deployment)\b/i.test(output)) {
            push('managed-app-deploy', 'Managed app deployment was triggered or completed.', { confidence: 'high' });
            push('deployment-applied', 'Managed app deployment evidence was captured.', { confidence: 'high' });
        }
        if (data.buildRun || /\b(buildStatus|queued|running|succeeded|success|build)\b/i.test(output)) {
            push('managed-app-build', 'Managed app build state was attached to the tool result.');
        }
        if (['inspect', 'doctor', 'reconcile'].includes(action)) {
            push('remote-inspection', 'Managed app inspection or control-plane diagnostic completed.');
        }
        return evidence;
    }

    if (toolId === 'web-search') {
        push('research-search', 'Research search returned verified candidate sources.');
    }
    if (toolId === 'web-fetch' || toolId === 'web-scrape') {
        push('research-fetch', 'A source page was fetched or scraped successfully.');
    }
    if (toolId === DOCUMENT_WORKFLOW_TOOL_ID || toolId === DEEP_RESEARCH_PRESENTATION_TOOL_ID) {
        push('document-generated', 'A document or presentation workflow produced an artifact.', { confidence: 'high', stateChanged: true });
    }
    if (Array.isArray(data.artifacts) || data.artifact || data.downloadUrl || data.markdownImage) {
        push('artifact-created', 'A runtime artifact was created by a tool result.', { confidence: 'high', stateChanged: true });
    }

    return evidence;
}

function summarizeRoundFailures(toolEvents = [], executionProfile = DEFAULT_EXECUTION_PROFILE) {
    const failures = (Array.isArray(toolEvents) ? toolEvents : [])
        .map((event) => classifyToolFailure(event, executionProfile))
        .filter(Boolean);

    return {
        failures,
        anyFailed: failures.length > 0,
        blockingFailures: failures.filter((entry) => entry.blocking),
        recoverableFailures: failures.filter((entry) => !entry.blocking),
    };
}

function summarizeToolEventsForPlanner(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : [])
        .slice(-6)
        .map((event) => ({
            tool: event?.toolCall?.function?.name || '',
            reason: event?.reason || '',
            success: event?.result?.success !== false,
            error: event?.result?.error || '',
            data: event?.result?.data || null,
        }));
}

const PLAN_TEMPLATE_PATTERN = /\{\{([^{}]+)\}\}/g;
const PLAN_URL_PARAM_NAMES = new Set([
    'url',
    'previewUrl',
    'preview_url',
    'sandboxUrl',
    'sandbox_url',
    'workspacePreviewUrl',
    'workspace_preview_url',
    'workspaceSandboxUrl',
    'workspace_sandbox_url',
    'publicUrl',
    'public_url',
]);
const PLAN_PREVIEW_URL_KEYS = [
    'previewUrl',
    'preview_url',
    'sandboxUrl',
    'sandbox_url',
    'workspaceSandboxUrl',
    'workspace_sandbox_url',
    'workspacePreviewUrl',
    'workspace_preview_url',
    'publicUrl',
    'public_url',
];

function parsePlanTemplatePath(pathValue = '') {
    const pathText = String(pathValue || '').trim();
    if (!pathText) {
        return [];
    }

    const tokens = [];
    const tokenPattern = /([^[.\]]+)|\[(?:"([^"]+)"|'([^']+)'|(\d+))\]/g;
    let match;
    while ((match = tokenPattern.exec(pathText)) !== null) {
        const rawToken = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (rawToken === undefined || rawToken === '') {
            continue;
        }
        tokens.push(/^\d+$/.test(rawToken) ? Number(rawToken) : rawToken);
    }

    return tokens;
}

function readPlanPath(root, tokens = []) {
    let value = root;
    for (const token of tokens) {
        if (value == null) {
            return undefined;
        }
        value = value[token];
    }
    return value;
}

function readPlanPathWithStepIndexFallback(root, tokens = []) {
    const direct = readPlanPath(root, tokens);
    if (direct !== undefined) {
        return direct;
    }

    if (tokens[0] === 'steps' && Number.isInteger(tokens[1]) && tokens[1] > 0) {
        const oneBasedTokens = [...tokens];
        oneBasedTokens[1] = oneBasedTokens[1] - 1;
        return readPlanPath(root, oneBasedTokens);
    }

    return undefined;
}

function isPreviewUrlPath(pathValue = '') {
    return /(?:^|[.[_])(preview|sandbox|public)?_?url(?:\]|$)/i.test(String(pathValue || ''));
}

function isPlanUrlParamKey(keyPath = []) {
    const key = String(keyPath[keyPath.length - 1] || '').trim();
    return PLAN_URL_PARAM_NAMES.has(key);
}

function isLikelyPlanUrlCandidate(value = '') {
    const normalized = String(value || '').trim();
    return /^https?:\/\//i.test(normalized)
        || /^\/?api\/.+/i.test(normalized)
        || /^\/?artifacts\/.+/i.test(normalized)
        || /^(localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?(?:\/|$)/i.test(normalized)
        || /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(normalized);
}

function normalizePlanUrlCandidate(value = '') {
    const normalized = String(value || '').trim();
    PLAN_TEMPLATE_PATTERN.lastIndex = 0;
    const hasTemplate = PLAN_TEMPLATE_PATTERN.test(normalized);
    PLAN_TEMPLATE_PATTERN.lastIndex = 0;
    if (!normalized || hasTemplate || !isLikelyPlanUrlCandidate(normalized)) {
        return '';
    }
    return normalizeBrowserReachableUrl(normalized);
}

function extractPreviewUrlFromValue(value = null, depth = 0) {
    if (depth > 5 || value == null) {
        return '';
    }

    if (typeof value === 'string') {
        return normalizePlanUrlCandidate(value);
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = extractPreviewUrlFromValue(entry, depth + 1);
            if (found) {
                return found;
            }
        }
        return '';
    }

    if (typeof value !== 'object') {
        return '';
    }

    for (const key of PLAN_PREVIEW_URL_KEYS) {
        const found = normalizePlanUrlCandidate(value[key]);
        if (found) {
            return found;
        }
    }

    for (const [key, entry] of Object.entries(value)) {
        if (key === 'screenshot' || key === 'imageCapture') {
            continue;
        }
        const found = extractPreviewUrlFromValue(entry, depth + 1);
        if (found) {
            return found;
        }
    }

    return '';
}

function extractPreviewUrlFromToolEvent(event = {}) {
    const data = event?.result?.data || {};
    const artifactCandidates = extractArtifactsFromToolEvents([event]);
    const candidates = [
        data?.sandboxBuild,
        data,
        data?.artifact,
        ...(Array.isArray(data?.artifacts) ? data.artifacts : []),
        ...artifactCandidates,
    ];

    for (const candidate of candidates) {
        const found = extractPreviewUrlFromValue(candidate);
        if (found) {
            return found;
        }
    }

    return '';
}

function buildPlanTemplateStepRecords(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).map((event, index) => {
        const params = parseToolCallArguments(event?.toolCall?.function?.arguments || '{}');
        const data = event?.result?.data || null;
        const previewUrl = extractPreviewUrlFromToolEvent(event);

        return {
            index,
            tool: event?.toolCall?.function?.name || event?.result?.toolId || '',
            reason: event?.reason || '',
            success: event?.result?.success !== false,
            error: event?.result?.error || '',
            params,
            result: event?.result || null,
            data,
            output: data,
            ...(previewUrl ? { previewUrl, url: previewUrl } : {}),
        };
    });
}

function buildPlanTemplateContext(toolEvents = []) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const steps = buildPlanTemplateStepRecords(events);
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
    const latestPreviewStep = [...steps].reverse().find((step) => step.previewUrl);
    const latestPreviewUrl = latestPreviewStep?.previewUrl || '';

    return {
        toolEvents: events,
        steps,
        stepResults: steps,
        results: {
            lastStep,
            lastPreviewUrl: latestPreviewUrl,
            previewUrl: latestPreviewUrl,
        },
        lastStep,
        lastPreviewUrl: latestPreviewUrl,
        previewUrl: latestPreviewUrl,
        latestPreviewUrl,
        artifacts: extractArtifactsFromToolEvents(events),
    };
}

function stringifyPlanTemplateValue(value) {
    if (value == null) {
        return '';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function resolvePlanTemplatePath(pathValue = '', templateContext = {}) {
    const tokens = parsePlanTemplatePath(pathValue);
    const value = readPlanPathWithStepIndexFallback(templateContext, tokens);
    if (value !== undefined && value !== null && value !== '') {
        return value;
    }

    if (isPreviewUrlPath(pathValue) && templateContext.latestPreviewUrl) {
        return templateContext.latestPreviewUrl;
    }

    return value;
}

function resolvePlanTemplateString(template = '', templateContext = {}) {
    const source = String(template || '');
    const exactMatch = source.match(/^\{\{([^{}]+)\}\}$/);
    if (exactMatch) {
        const resolved = resolvePlanTemplatePath(exactMatch[1].trim(), templateContext);
        return resolved === undefined || resolved === null ? source : resolved;
    }

    return source.replace(PLAN_TEMPLATE_PATTERN, (_match, pathValue) => {
        const resolved = resolvePlanTemplatePath(String(pathValue || '').trim(), templateContext);
        return stringifyPlanTemplateValue(resolved);
    });
}

function resolvePlanParamTemplates(value, templateContext = {}, keyPath = [], options = {}) {
    if (typeof value === 'string') {
        const resolved = resolvePlanTemplateString(value, templateContext);
        return options.browserReachableUrls === true && isPlanUrlParamKey(keyPath) && typeof resolved === 'string'
            ? normalizeBrowserReachableUrl(resolved)
            : resolved;
    }

    if (Array.isArray(value)) {
        return value.map((entry, index) => resolvePlanParamTemplates(entry, templateContext, [...keyPath, index], options));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                resolvePlanParamTemplates(entry, templateContext, [...keyPath, key], options),
            ]),
        );
    }

    return value;
}

function findUnresolvedUrlTemplates(value, keyPath = [], found = []) {
    if (typeof value === 'string') {
        if (isPlanUrlParamKey(keyPath) && /\{\{[^{}]+\}\}/.test(value)) {
            found.push({
                path: keyPath.join('.'),
                value,
            });
        }
        return found;
    }

    if (Array.isArray(value)) {
        value.forEach((entry, index) => findUnresolvedUrlTemplates(entry, [...keyPath, index], found));
        return found;
    }

    if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, entry]) => findUnresolvedUrlTemplates(entry, [...keyPath, key], found));
    }

    return found;
}

function hasBlankPlanUrlParam(params = {}) {
    if (!params || typeof params !== 'object' || !Object.prototype.hasOwnProperty.call(params, 'url')) {
        return true;
    }
    return typeof params.url === 'string'
        ? params.url.trim() === ''
        : params.url === undefined || params.url === null;
}

function toIsoTimestamp(value, fallback = null) {
    if (!value) {
        return fallback;
    }

    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (Number.isNaN(timestamp)) {
        return fallback;
    }

    return new Date(timestamp).toISOString();
}

function createExecutionTraceEntry({
    type = 'info',
    name = 'Runtime step',
    status = 'completed',
    details = {},
    startedAt = null,
    endedAt = null,
} = {}) {
    const startTime = startedAt || new Date().toISOString();
    const endTime = endedAt || startTime;

    return {
        type,
        name,
        status,
        startTime,
        endTime,
        duration: Math.max(0, new Date(endTime).getTime() - new Date(startTime).getTime()),
        details,
    };
}

function normalizeHarnessReviewAction(action = '') {
    const normalized = String(action || '').trim().toLowerCase();
    if (normalized === 'stop') {
        return 'synthesize';
    }
    return HARNESS_REVIEW_ACTIONS.has(normalized) ? normalized : 'synthesize';
}

function buildHarnessRunId() {
    return `harness_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeHarnessToolEvent(event = {}, classification = '') {
    return {
        tool: event?.toolCall?.function?.name || event?.result?.toolId || '',
        success: event?.result?.success !== false,
        error: event?.result?.error || null,
        classification: classification || null,
        reason: event?.reason || '',
    };
}

function normalizeHarnessCriterionText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildHarnessCriterionId(text = '', index = 0) {
    const slug = normalizeHarnessCriterionText(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || `criterion-${index + 1}`;
}

function normalizeHarnessCriterion(value = '', index = 0, source = 'objective') {
    const raw = typeof value === 'string' ? { text: value } : (value && typeof value === 'object' ? value : {});
    const text = normalizeHarnessCriterionText(raw.text || raw.title || raw.objective || raw.label || '');
    if (!text) {
        return null;
    }

    const status = String(raw.status || '').trim().toLowerCase() === 'satisfied' ? 'satisfied' : 'pending';
    return {
        id: String(raw.id || buildHarnessCriterionId(text, index)).trim(),
        text,
        source: String(raw.source || source || 'objective').trim() || 'objective',
        required: raw.required !== false,
        status,
        evidenceIds: Array.isArray(raw.evidenceIds) ? raw.evidenceIds.filter(Boolean) : [],
    };
}

function normalizeHarnessEvidence(value = {}, index = 0) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const summary = normalizeHarnessCriterionText(value.summary || value.text || '');
    if (!summary) {
        return null;
    }

    return {
        id: String(value.id || `evidence-${Date.now()}-${index + 1}`).trim(),
        summary,
        type: String(value.type || 'verified-result').trim() || 'verified-result',
        tool: value.tool || null,
        criterionIds: Array.isArray(value.criterionIds) ? value.criterionIds.filter(Boolean) : [],
        confidence: ['low', 'medium', 'high'].includes(String(value.confidence || '').trim())
            ? String(value.confidence).trim()
            : 'medium',
        stateChanged: value.stateChanged === true,
        round: Number.isFinite(Number(value.round)) ? Number(value.round) : null,
        createdAt: value.createdAt || new Date().toISOString(),
    };
}

function evidenceMatchesHarnessCriterion(evidence = {}, criterion = {}) {
    const type = String(evidence.type || '').trim().toLowerCase();
    const summary = String(evidence.summary || '').trim().toLowerCase();
    const text = String(criterion.text || '').trim().toLowerCase();
    const haystack = `${type} ${summary}`;

    if (!text) {
        return false;
    }

    if (text.includes('inspection')) {
        return /\b(remote-inspection|k8s-inspection|pod-readiness|service-ingress|public-verification|research-search|research-fetch)\b/.test(haystack);
    }
    if (text.includes('inspect') || text.includes('current state')) {
        return /\b(remote-inspection|k8s-inspection|pod-readiness|service-ingress|public-verification|research-search|research-fetch|verified-result)\b/.test(haystack);
    }
    if (text.includes('deployment applied') || (text.includes('deploy') && !text.includes('verified'))) {
        return /\b(deployment-applied|managed-app-deploy|k3s-deploy|rollout)\b/.test(haystack);
    }
    if (text.includes('verified') || text.includes('verification')) {
        return /\b(deployment-verified|public-verification|rollout|pod-readiness|service-ingress)\b/.test(haystack);
    }
    if (text.includes('repository implementation') || text.includes('implement')) {
        return /\b(repository-implemented|managed-app-authoring|code-change)\b/.test(haystack);
    }
    if (text.includes('workspace built') || text.includes('build')) {
        return /\b(build-complete|managed-app-build|remote-workspace-build)\b/.test(haystack);
    }
    if (text.includes('research')) {
        return /\b(research-search|research-fetch|document-generated)\b/.test(haystack);
    }
    if (text.includes('produce') || text.includes('deliverable') || text.includes('deliver requested')) {
        return /\b(document-generated|artifact-created|managed-app-authoring|code-change)\b/.test(haystack);
    }
    if (text.includes('validate') || text.includes('review the result')) {
        return /\b(document-generated|artifact-created|build-complete|public-verification|deployment-verified|research-fetch)\b/.test(haystack);
    }
    if (text.includes('document') || text.includes('artifact')) {
        return /\b(document-generated|artifact-created)\b/.test(haystack);
    }

    return text.split(/\s+/).filter((word) => word.length >= 5).some((word) => haystack.includes(word));
}

function buildInitialHarnessCriteria({
    objective = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    workflow = null,
    projectPlan = null,
    restoredCompletion = null,
    explicitCriteria = [],
} = {}) {
    const criteria = [];
    const hasExplicitCriteria = Array.isArray(explicitCriteria) && explicitCriteria.some(Boolean);
    const pushCriterion = (text, source = 'objective') => {
        const normalized = normalizeHarnessCriterion(text, criteria.length, source);
        if (!normalized) {
            return;
        }
        if (criteria.some((entry) => entry.text.toLowerCase() === normalized.text.toLowerCase())) {
            return;
        }
        criteria.push(normalized);
    };

    if (Array.isArray(restoredCompletion?.criteria)) {
        restoredCompletion.criteria.forEach((criterion, index) => {
            const normalized = normalizeHarnessCriterion(criterion, index, criterion?.source || 'restored');
            if (normalized) {
                criteria.push(normalized);
            }
        });
    }

    if (Array.isArray(workflow?.completionCriteria)) {
        workflow.completionCriteria.forEach((entry) => pushCriterion(entry, 'workflow'));
    }
    if (Array.isArray(workflow?.verificationCriteria)) {
        workflow.verificationCriteria.forEach((entry) => pushCriterion(entry, 'workflow-verification'));
    }

    if (Array.isArray(projectPlan?.successDefinition)) {
        projectPlan.successDefinition.forEach((entry) => pushCriterion(entry, 'project-plan'));
    }
    if (Array.isArray(projectPlan?.milestones)) {
        projectPlan.milestones
            .filter((milestone) => !['completed', 'skipped'].includes(String(milestone?.status || '').trim().toLowerCase()))
            .forEach((milestone) => pushCriterion(milestone.title || milestone.objective || '', 'project-plan'));
    }

    const normalizedObjective = normalizeHarnessCriterionText(objective).toLowerCase();
    if (!hasExplicitCriteria && criteria.length === 0 && executionProfile === REMOTE_BUILD_EXECUTION_PROFILE) {
        if (/\b(deploy|redeploy|publish|launch|ship|live|online|rollout|apply)\b/.test(normalizedObjective)) {
            pushCriterion('Deployment applied', 'objective');
            pushCriterion('Deployment verified', 'objective');
        } else if (/\b(inspect|check|status|health|diagnose|debug|logs?|verify)\b/.test(normalizedObjective)) {
            pushCriterion('Inspection completed', 'objective');
        }
    }

    if (!hasExplicitCriteria && criteria.length === 0 && /\b(research|compare|source|sources|latest|current)\b/i.test(objective)) {
        pushCriterion('Research gathered', 'objective');
    }

    return criteria;
}

function isHarnessResumeTurn(rawObjective = '', objective = '') {
    const raw = normalizeHarnessCriterionText(rawObjective).toLowerCase();
    const normalized = normalizeHarnessCriterionText(objective).toLowerCase();
    return isLikelyTranscriptDependentTurn(raw)
        || hasExplicitForegroundResumeIntent(raw)
        || /^(continue|resume|keep going|go ahead|proceed|finish|next step|next steps)\b/.test(raw)
        || /^(continue|resume|keep going|go ahead|proceed|finish|next step|next steps)\b/.test(normalized);
}

function isHarnessSnapshotResumeable(snapshot = null) {
    return Boolean(snapshot && typeof snapshot === 'object'
        && snapshot.version === HARNESS_VERSION
        && snapshot.currentObjective
        && snapshot.completion
        && Array.isArray(snapshot.completion.unmetCriteria)
        && snapshot.completion.unmetCriteria.length > 0);
}

function buildHarnessControlStateFromSummary(summary = null) {
    if (!summary || typeof summary !== 'object') {
        return undefined;
    }

    if (!summary.resumeAvailable) {
        return null;
    }

    return {
        version: summary.version || HARNESS_VERSION,
        runId: summary.runId || '',
        currentObjective: summary.currentObjective || '',
        executionProfile: summary.executionProfile || DEFAULT_EXECUTION_PROFILE,
        autonomyLevel: summary.autonomyLevel || 'guarded',
        completion: summary.completion || null,
        blockers: Array.isArray(summary.blockers) ? summary.blockers.slice(-8) : [],
        recoveryAttempts: Array.isArray(summary.recoveryAttempts) ? summary.recoveryAttempts.slice(-8) : [],
        decision: summary.decision || 'continue',
        lastStateChangeAt: summary.lastStateChangeAt || null,
        updatedAt: new Date().toISOString(),
    };
}

class HarnessRunState {
    constructor({
        runId = '',
        objective = '',
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        autonomyApproved = false,
        autonomyLevel = '',
        maxToolCalls = MAX_PLAN_STEPS,
        maxRounds = 1,
        maxReplans = null,
        completionCriteria = [],
        completion = null,
        workflow = null,
        projectPlan = null,
        resumeAvailable = false,
        lastStateChangeAt = null,
    } = {}) {
        this.version = HARNESS_VERSION;
        this.runId = runId || buildHarnessRunId();
        this.executionProfile = executionProfile || DEFAULT_EXECUTION_PROFILE;
        this.autonomyLevel = autonomyLevel || (autonomyApproved ? 'guarded-remote' : 'guarded');
        this.autonomyApproved = Boolean(autonomyApproved);
        this.rounds = [];
        this.currentObjective = String(objective || '').trim();
        this.completionCriteria = Array.isArray(completionCriteria) ? completionCriteria.filter(Boolean) : [];
        this.blockers = [];
        this.recoveryAttempts = [];
        this.decision = 'continue';
        this.criteria = buildInitialHarnessCriteria({
            objective,
            executionProfile: this.executionProfile,
            workflow,
            projectPlan,
            restoredCompletion: completion,
            explicitCriteria: completionCriteria,
        });
        for (const criterion of completionCriteria) {
            const normalized = normalizeHarnessCriterion(criterion, this.criteria.length, 'explicit');
            if (normalized && !this.criteria.some((entry) => entry.text.toLowerCase() === normalized.text.toLowerCase())) {
                this.criteria.push(normalized);
            }
        }
        this.completionCriteria = this.criteria.map((criterion) => criterion.text);
        this.evidence = Array.isArray(completion?.evidence)
            ? completion.evidence.map((entry, index) => normalizeHarnessEvidence(entry, index)).filter(Boolean)
            : [];
        this.finishConfidence = ['low', 'medium', 'high'].includes(String(completion?.finishConfidence || '').trim())
            ? String(completion.finishConfidence).trim()
            : 'low';
        this.finishReason = String(completion?.finishReason || '').trim() || 'completion_not_reviewed';
        this.resumeAvailable = Boolean(resumeAvailable);
        this.lastStateChangeAt = lastStateChangeAt || null;
        this.maxRounds = Math.max(1, Number(maxRounds) || 1);
        this.maxToolCalls = Math.max(1, Number(maxToolCalls) || MAX_PLAN_STEPS);
        this.toolCalls = 0;
        this.replans = 0;
        this.maxReplans = Math.max(0, Number.isFinite(Number(maxReplans))
            ? Number(maxReplans)
            : (this.executionProfile === REMOTE_BUILD_EXECUTION_PROFILE && this.autonomyApproved
                ? REMOTE_BUILD_MAX_REPLANS
                : NORMAL_PROFILE_MAX_REPLANS));
    }

    static fromControlState(snapshot = null, defaults = {}) {
        if (!isHarnessSnapshotResumeable(snapshot)) {
            return new HarnessRunState(defaults);
        }

        const harness = new HarnessRunState({
            ...defaults,
            runId: snapshot.runId || defaults.runId,
            objective: snapshot.currentObjective || defaults.objective,
            executionProfile: snapshot.executionProfile || defaults.executionProfile,
            autonomyLevel: snapshot.autonomyLevel || defaults.autonomyLevel,
            autonomyApproved: Boolean(defaults.autonomyApproved || snapshot.autonomyLevel === 'guarded-remote'),
            completion: snapshot.completion,
            resumeAvailable: true,
            lastStateChangeAt: snapshot.lastStateChangeAt || null,
        });
        harness.blockers = Array.isArray(snapshot.blockers) ? snapshot.blockers.slice(-8) : [];
        harness.recoveryAttempts = Array.isArray(snapshot.recoveryAttempts) ? snapshot.recoveryAttempts.slice(-8) : [];
        harness.decision = normalizeHarnessReviewAction(snapshot.decision || harness.decision);
        return harness;
    }

    setBudget({ maxRounds = this.maxRounds, maxToolCalls = this.maxToolCalls } = {}) {
        this.maxRounds = Math.max(1, Number(maxRounds) || this.maxRounds);
        this.maxToolCalls = Math.max(1, Number(maxToolCalls) || this.maxToolCalls);
    }

    setDecision(decision = 'synthesize', reason = '') {
        this.decision = normalizeHarnessReviewAction(decision);
        if (reason) {
            this.decisionReason = reason;
        }
        return this.decision;
    }

    get remainingToolCalls() {
        return Math.max(0, this.maxToolCalls - this.toolCalls);
    }

    get remainingReplans() {
        return Math.max(0, this.maxReplans - this.replans);
    }

    recordCriterion(criterion = '', source = 'objective') {
        const normalized = normalizeHarnessCriterion(criterion, this.criteria.length, source);
        if (!normalized) {
            return null;
        }

        const existing = this.criteria.find((entry) => entry.id === normalized.id
            || entry.text.toLowerCase() === normalized.text.toLowerCase());
        if (existing) {
            return existing;
        }

        this.criteria.push(normalized);
        this.completionCriteria = this.criteria.map((entry) => entry.text);
        return normalized;
    }

    markCriterionSatisfied(criterionIdOrText = '', evidenceId = '') {
        const normalized = normalizeHarnessCriterionText(criterionIdOrText).toLowerCase();
        const criterion = this.criteria.find((entry) => entry.id === criterionIdOrText
            || entry.text.toLowerCase() === normalized);
        if (!criterion) {
            return false;
        }

        criterion.status = 'satisfied';
        if (evidenceId && !criterion.evidenceIds.includes(evidenceId)) {
            criterion.evidenceIds.push(evidenceId);
        }
        return true;
    }

    getUnmetCriteria() {
        return this.criteria.filter((criterion) => criterion.required !== false && criterion.status !== 'satisfied');
    }

    recordEvidence(evidence = {}) {
        const normalized = normalizeHarnessEvidence(evidence, this.evidence.length);
        if (!normalized) {
            return null;
        }

        const duplicate = this.evidence.find((entry) => entry.summary === normalized.summary && entry.tool === normalized.tool);
        if (duplicate) {
            return duplicate;
        }

        const matchedCriteria = this.criteria.filter((criterion) => evidenceMatchesHarnessCriterion(normalized, criterion));
        normalized.criterionIds = Array.from(new Set([
            ...normalized.criterionIds,
            ...matchedCriteria.map((criterion) => criterion.id),
        ]));
        this.evidence.push(normalized);

        for (const criterionId of normalized.criterionIds) {
            this.markCriterionSatisfied(criterionId, normalized.id);
        }

        if (normalized.stateChanged) {
            this.lastStateChangeAt = normalized.createdAt;
        }

        return normalized;
    }

    reviewCompletion({
        budgetExceeded = false,
        blocking = false,
        stateChanged = false,
        progressMade = false,
        canContinue = false,
        noToolPath = false,
    } = {}) {
        const unmetCriteria = this.getUnmetCriteria();
        let decision = this.decision;
        let finishConfidence = unmetCriteria.length === 0 && this.criteria.length > 0 ? 'high' : 'low';
        let finishReason = unmetCriteria.length === 0 && this.criteria.length > 0
            ? 'all_required_criteria_satisfied'
            : 'criteria_unmet';

        if (budgetExceeded) {
            decision = 'checkpoint';
            finishConfidence = 'low';
            finishReason = 'budget_exhausted_with_unmet_criteria';
        } else if (blocking) {
            decision = 'blocked';
            finishConfidence = 'low';
            finishReason = 'blocking_failure';
        } else if (unmetCriteria.length > 0 && canContinue && (stateChanged || progressMade)) {
            decision = 'continue';
            finishConfidence = 'low';
            finishReason = 'unmet_criteria_with_progress';
        } else if (unmetCriteria.length > 0 && noToolPath) {
            decision = 'synthesize';
            finishConfidence = 'medium';
            finishReason = 'no_tool_path_for_unmet_criteria';
        } else if (unmetCriteria.length > 0) {
            decision = canContinue ? 'continue' : 'synthesize';
            finishConfidence = canContinue ? 'low' : 'medium';
            finishReason = canContinue ? 'unmet_criteria_can_continue' : 'unmet_criteria_budget_or_policy_limited';
        } else if (this.criteria.length === 0) {
            finishConfidence = 'medium';
            finishReason = 'no_explicit_completion_criteria';
        } else {
            decision = 'synthesize';
        }

        this.finishConfidence = finishConfidence;
        this.finishReason = finishReason;
        this.resumeAvailable = ['continue', 'checkpoint', 'blocked'].includes(decision) && unmetCriteria.length > 0;
        this.setDecision(decision, finishReason);
        return {
            decision,
            completionStatus: unmetCriteria.length === 0 ? 'complete' : 'incomplete',
            finishConfidence,
            finishReason,
            unmetCriteria: unmetCriteria.map((criterion) => criterion.text),
        };
    }

    recordPlan({ round = 0, steps = [], source = 'none' } = {}) {
        const existing = this.rounds.find((entry) => entry.round === round);
        const roundState = existing || {
            round,
            planSource: source,
            plannedSteps: [],
            executedSteps: [],
            decision: null,
            productive: null,
        };
        roundState.planSource = source;
        roundState.plannedSteps = (Array.isArray(steps) ? steps : []).map((step) => ({
            tool: step?.tool || '',
            reason: step?.reason || '',
            paramKeys: Object.keys(step?.params || {}).sort(),
        }));
        if (!existing) {
            this.rounds.push(roundState);
        }
    }

    recordToolEvent(event = {}, { round = 0, classification = '' } = {}) {
        this.toolCalls += 1;
        const existing = this.rounds.find((entry) => entry.round === round);
        const roundState = existing || {
            round,
            planSource: 'unknown',
            plannedSteps: [],
            executedSteps: [],
            decision: null,
            productive: null,
        };
        roundState.executedSteps.push(summarizeHarnessToolEvent(event, classification));
        if (!existing) {
            this.rounds.push(roundState);
        }
    }

    recordBlocker(blocker = {}) {
        const normalized = {
            type: String(blocker.type || 'unknown').trim() || 'unknown',
            reason: String(blocker.reason || blocker.error || '').trim(),
            round: Number.isFinite(Number(blocker.round)) ? Number(blocker.round) : null,
            tool: blocker.tool || null,
            signature: blocker.signature || null,
        };
        this.blockers.push(normalized);
        return normalized;
    }

    recordRecoveryAttempt(attempt = {}) {
        const normalized = {
            type: String(attempt.type || 'replan').trim() || 'replan',
            round: Number.isFinite(Number(attempt.round)) ? Number(attempt.round) : null,
            tool: attempt.tool || null,
            reason: String(attempt.reason || '').trim(),
            signature: attempt.signature || null,
            outcome: attempt.outcome || 'planned',
        };
        this.recoveryAttempts.push(normalized);
        return normalized;
    }

    reviewRound({
        round = 0,
        roundToolEvents = [],
        roundFailureSummary = null,
        budgetExceeded = false,
        suggestedDecision = null,
        suggestedReason = '',
        productive = null,
        terminalSuccess = false,
        hasDeterministicRecovery = false,
    } = {}) {
        let decision = normalizeHarnessReviewAction(suggestedDecision);
        let reason = suggestedReason || 'The planner review selected the next guarded action.';

        if (budgetExceeded) {
            decision = 'checkpoint';
            reason = 'The guarded autonomy budget is exhausted.';
            this.recordBlocker({ type: 'autonomy_budget_exhausted', reason, round });
        } else if (roundFailureSummary?.blockingFailures?.length > 0) {
            decision = 'blocked';
            reason = 'A blocking tool failure requires external input or a different capability.';
            const failure = roundFailureSummary.blockingFailures[0];
            this.recordBlocker({
                type: failure.category || 'blocking_failure',
                reason: failure.error || reason,
                round,
                tool: failure.toolId,
            });
        } else if (terminalSuccess) {
            decision = 'synthesize';
            reason = 'A terminal tool result completed the requested work.';
        } else if (roundFailureSummary?.recoverableFailures?.length > 0) {
            if (hasDeterministicRecovery) {
                decision = 'continue';
                reason = 'A deterministic recovery step is ready, so no model replan is needed yet.';
            } else if (this.remainingReplans > 0) {
                decision = 'replan';
                reason = 'A recoverable tool failure needs a changed next step.';
                this.replans += 1;
                this.recordRecoveryAttempt({
                    type: 'model-replan',
                    round,
                    reason,
                    outcome: 'requested',
                });
            } else {
                decision = 'blocked';
                reason = 'Recoverable failures repeated after the replan budget was exhausted.';
                this.recordBlocker({ type: 'replan_budget_exhausted', reason, round });
            }
        } else if (!Array.isArray(roundToolEvents) || roundToolEvents.length === 0) {
            decision = 'synthesize';
            reason = 'No additional tool progress was available.';
        }

        const roundState = this.rounds.find((entry) => entry.round === round);
        if (roundState) {
            roundState.decision = decision;
            roundState.decisionReason = reason;
            roundState.productive = productive;
        }
        this.setDecision(decision, reason);
        return { decision, reason };
    }

    toPlannerContext() {
        return {
            version: this.version,
            runId: this.runId,
            executionProfile: this.executionProfile,
            autonomyLevel: this.autonomyLevel,
            currentObjective: this.currentObjective,
            completionCriteria: this.completionCriteria,
            remainingAutonomyBudget: {
                rounds: Math.max(0, this.maxRounds - this.rounds.length),
                toolCalls: this.remainingToolCalls,
                replans: this.remainingReplans,
            },
            priorFailedSignatures: this.blockers
                .filter((blocker) => blocker.signature)
                .map((blocker) => blocker.signature)
                .slice(-6),
            blockers: this.blockers.slice(-6),
            recoveryAttempts: this.recoveryAttempts.slice(-6),
            completion: {
                unmetCriteria: this.getUnmetCriteria().map((criterion) => criterion.text),
                evidence: this.evidence.slice(-8),
                finishConfidence: this.finishConfidence,
                finishReason: this.finishReason,
            },
            decision: this.decision,
        };
    }

    getCompletionSummary() {
        const unmetCriteria = this.getUnmetCriteria();
        return {
            criteria: this.criteria,
            evidence: this.evidence,
            unmetCriteria: unmetCriteria.map((criterion) => ({
                id: criterion.id,
                text: criterion.text,
                source: criterion.source,
                required: criterion.required !== false,
            })),
            finishConfidence: this.finishConfidence,
            finishReason: this.finishReason,
        };
    }

    toControlState() {
        return {
            version: this.version,
            runId: this.runId,
            currentObjective: this.currentObjective,
            executionProfile: this.executionProfile,
            autonomyLevel: this.autonomyLevel,
            completion: this.getCompletionSummary(),
            blockers: this.blockers.slice(-8),
            recoveryAttempts: this.recoveryAttempts.slice(-8),
            decision: this.decision,
            lastStateChangeAt: this.lastStateChangeAt,
            updatedAt: new Date().toISOString(),
        };
    }

    toJSON() {
        return {
            version: this.version,
            runId: this.runId,
            executionProfile: this.executionProfile,
            autonomyLevel: this.autonomyLevel,
            rounds: this.rounds,
            currentObjective: this.currentObjective,
            completionCriteria: this.completionCriteria,
            completion: this.getCompletionSummary(),
            blockers: this.blockers,
            recoveryAttempts: this.recoveryAttempts,
            decision: this.decision,
            resumeAvailable: this.resumeAvailable,
            lastStateChangeAt: this.lastStateChangeAt,
            ...(this.decisionReason ? { decisionReason: this.decisionReason } : {}),
            budget: {
                maxRounds: this.maxRounds,
                maxToolCalls: this.maxToolCalls,
                maxReplans: this.maxReplans,
                toolCalls: this.toolCalls,
                replans: this.replans,
                remainingToolCalls: this.remainingToolCalls,
                remainingReplans: this.remainingReplans,
            },
        };
    }
}

function appendModelResponseTrace(executionTrace = [], response = null, {
    startedAt = null,
    phase = 'final-response',
    toolEvents = [],
    inputText = '',
} = {}) {
    if (!Array.isArray(executionTrace) || !response) {
        return;
    }

    const endedAt = new Date().toISOString();
    const outputText = extractResponseText(response);
    const providerUsage = extractResponseUsageMetadata(response);
    const usage = hasMeasuredTokenCounts(providerUsage)
        ? providerUsage
        : createEstimatedUsageMetadata({
            input: inputText,
            output: outputText,
            modelCalls: providerUsage?.modelCalls || 1,
        }) || providerUsage;
    const imageDiagnostics = extractImageDiagnosticsFromToolEvents(toolEvents);
    executionTrace.push(createExecutionTraceEntry({
        type: 'model_call',
        name: `Model response (${response.model || 'unknown'})`,
        startedAt,
        endedAt,
        details: {
            phase,
            responseId: response.id || null,
            outputPreview: truncateText(outputText, 200),
            ...(imageDiagnostics ? { diagnostics: imageDiagnostics.diagnostics } : {}),
            ...(imageDiagnostics ? { diagnosticSummary: imageDiagnostics.summary } : {}),
            ...(imageDiagnostics ? { diagnosticSourceTool: imageDiagnostics.toolId } : {}),
            ...(usage ? { usage } : {}),
        },
    }));
}

function extractImageDiagnosticsFromToolEvents(toolEvents = []) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index] || {};
        const toolId = String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim();
        const imageGeneration = event?.result?.diagnostics?.imageGeneration
            || event?.diagnostics?.imageGeneration
            || event?.result?.data?.diagnostics?.imageGeneration
            || null;

        if (!imageGeneration) {
            continue;
        }

        return {
            toolId: toolId || 'image-generate',
            diagnostics: {
                imageGeneration,
            },
            summary: formatImageDiagnosticsSummary(imageGeneration),
        };
    }

    return null;
}

function getImageDiagnosticsFromToolEvent(event = {}) {
    return event?.result?.diagnostics?.imageGeneration
        || event?.diagnostics?.imageGeneration
        || event?.result?.data?.diagnostics?.imageGeneration
        || null;
}

function isUnpersistedImageGenerationEvent(event = {}) {
    const toolId = String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim();
    if (toolId !== 'image-generate') {
        return false;
    }

    const diagnostics = getImageDiagnosticsFromToolEvent(event);
    const counts = diagnostics?.counts || {};
    const flags = diagnostics?.flags || {};
    return flags.likelyArtifactPersistenceIssue === true
        || (Number(counts.usableReturnedImageRecords || 0) > 0 && Number(counts.artifacts || 0) === 0);
}

function hasUnpersistedImageGeneration(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).some((event) => isUnpersistedImageGenerationEvent(event));
}

function summarizeImageGenerateToolEvent(event = {}) {
    const result = event?.result || {};
    const data = result?.data || {};
    const success = result?.success !== false;
    const diagnostics = getImageDiagnosticsFromToolEvent(event);
    const diagnosticSummary = diagnostics ? formatImageDiagnosticsSummary(diagnostics) : '';
    const counts = diagnostics?.counts || {};
    const artifactIds = [
        ...(Array.isArray(data.artifactIds) ? data.artifactIds : []),
        ...(Array.isArray(data.artifacts) ? data.artifacts.map((artifact) => artifact?.id) : []),
    ].map((id) => String(id || '').trim()).filter(Boolean);
    const uniqueArtifactIds = Array.from(new Set(artifactIds));
    const usableCount = Number(data.usableCount || counts.usableReturnedImageRecords || 0);

    if (!success) {
        return [
            '- image-generate: failed.',
            result.error ? `Error: ${truncateText(normalizeInlineText(result.error), 220)}.` : '',
            diagnosticSummary ? `Diagnostics: ${diagnosticSummary}.` : '',
        ].filter(Boolean).join(' ');
    }

    if (uniqueArtifactIds.length > 0) {
        return [
            '- image-generate: succeeded.',
            `Persisted ${uniqueArtifactIds.length} reusable image artifact${uniqueArtifactIds.length === 1 ? '' : 's'}.`,
            `Artifact ID${uniqueArtifactIds.length === 1 ? '' : 's'}: ${uniqueArtifactIds.slice(0, 5).join(', ')}.`,
        ].filter(Boolean).join(' ');
    }

    if (usableCount > 0) {
        return [
            '- image-generate: completed but no reusable image artifact was persisted.',
            diagnosticSummary ? `Diagnostics: ${diagnosticSummary}.` : '',
        ].filter(Boolean).join(' ');
    }

    return [
        '- image-generate: completed without usable image data.',
        diagnosticSummary ? `Diagnostics: ${diagnosticSummary}.` : '',
    ].filter(Boolean).join(' ');
}

function summarizeToolEventForUser(event = {}) {
    const tool = String(event?.toolCall?.function?.name || event?.result?.toolId || 'tool').trim();
    const reason = String(event?.reason || '').trim();
    const result = event?.result || {};
    const success = result?.success !== false;
    const data = result?.data || {};
    const stdout = String(data?.stdout || '').trim();
    const stderr = String(data?.stderr || '').trim();
    const error = String(result?.error || '').trim();
    const exitCode = Number.isFinite(Number(data?.exitCode)) ? Number(data.exitCode) : null;
    let preview = '';

    if (tool === 'image-generate') {
        return summarizeImageGenerateToolEvent(event);
    }

    if (tool === 'remote-cli-agent') {
        const finalOutput = String(data?.finalOutput || '').trim();
        const continuity = [
            data?.sessionId ? `remote session: ${data.sessionId}` : '',
            data?.cwd ? `workspace: ${data.cwd}` : '',
            data?.gitCommit ? `commit: ${data.gitCommit}` : '',
            data?.deployment ? `deployment: ${data.deployment}` : '',
            data?.publicHost ? `public host: ${data.publicHost}` : '',
        ].filter(Boolean).join('; ');
        preview = [
            finalOutput ? truncateText(normalizeInlineText(finalOutput), 1200) : '',
            continuity,
        ].filter(Boolean).join(' ');
    } else if (tool === 'web-search') {
        preview = summarizeSearchResults(data?.results || []);
    } else if (tool === 'asset-search') {
        preview = summarizeAssetSearchResults(data);
    } else if (tool === 'document-workflow') {
        preview = summarizeDocumentWorkflowOutput(data);
    } else if (tool === 'web-fetch') {
        preview = summarizeFetchedContent(data);
    } else if (stdout || stderr || error) {
        preview = truncateText(normalizeInlineText(stdout || stderr || error), 320);
    } else if (typeof data === 'string') {
        preview = truncateText(normalizeInlineText(data), 320);
    } else if (data && typeof data === 'object') {
        preview = summarizeObjectData(data);
    }

    if (!success) {
        const shouldIncludeReason = !error && !stdout && !stderr;
        return [
            `- ${tool}: failed`,
            shouldIncludeReason && reason ? `Reason: ${reason}.` : '',
            error ? `Error: ${error}.` : '',
            stderr && !error ? `Details: ${truncateText(normalizeInlineText(stderr), 220)}.` : '',
        ].filter(Boolean).join(' ');
    }

    return [
        `- ${tool}: succeeded`,
        reason ? `Reason: ${reason}.` : '',
        exitCode != null ? `Exit code: ${exitCode}.` : '',
        preview ? `Output: ${preview}.` : '',
    ].filter(Boolean).join(' ');
}

function buildRemoteCommandFallbackSynthesisText({ objective = '', toolEvents = [] } = {}) {
    const events = (Array.isArray(toolEvents) ? toolEvents : [])
        .filter((event) => isRemoteCommandToolId(event?.toolCall?.function?.name || event?.result?.toolId || ''));
    if (events.length === 0) {
        return '';
    }

    const sections = [
        objective ? `Remote execution summary for: ${truncateText(normalizeInlineText(objective), 240)}` : 'Remote execution summary',
    ];

    events.slice(0, 6).forEach((event, index) => {
        const reason = String(event?.reason || '').trim() || `Remote command ${index + 1}`;
        const result = event?.result || {};
        const stdout = stripNullCharacters(String(result?.data?.stdout || '')).trim();
        const stderr = stripNullCharacters(String(result?.data?.stderr || '')).trim();
        const error = stripNullCharacters(String(result?.error || '')).trim();

        if (result?.success === false) {
            sections.push(`${reason}\n\nError: ${error || 'Unknown remote command failure.'}`);
            return;
        }

        if (stdout) {
            sections.push(`${reason}\n\n\`\`\`text\n${truncateText(stdout, 2000)}\n\`\`\``);
        } else if (stderr) {
            sections.push(`${reason}\n\n\`\`\`text\n${truncateText(stderr, 800)}\n\`\`\``);
        } else {
            sections.push(`${reason}\n\nCommand completed successfully.`);
        }
    });

    const failures = events.filter((event) => event?.result?.success === false).length;
    sections.push(
        failures > 0
            ? `Summary: ${failures} remote command step${failures === 1 ? '' : 's'} failed.`
            : 'Summary: Remote commands completed successfully.',
    );

    return sections.join('\n\n');
}

function buildFallbackSynthesisText({ objective = '', toolEvents = [] } = {}) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    if (events.length === 0) {
        return 'I completed the request, but the final answer could not be synthesized from the model response.';
    }

    const remoteOnlySummary = buildRemoteCommandFallbackSynthesisText({ objective, toolEvents: events });
    if (remoteOnlySummary) {
        return remoteOnlySummary;
    }

    const successes = events.filter((event) => event?.result?.success !== false).length;
    const failures = events.length - successes;
    const normalizedObjective = truncateText(normalizeInlineText(objective), 280);
    const researchDossier = buildResearchDossierFromToolEvents({ objective, toolEvents: events });
    const lastSearchEvent = getLastSuccessfulToolEvent(events, 'web-search');
    const successfulFetches = events.filter((event) => {
        const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
        return toolId === 'web-fetch' && event?.result?.success !== false;
    });
    const onlyResearchToolEvents = events.every((event) => ['web-search', 'web-fetch', 'web-scrape'].includes(event?.toolCall?.function?.name || event?.result?.toolId || ''));
    if (!lastSearchEvent && onlyResearchToolEvents && successfulFetches.length === 1) {
        const fetchSummary = summarizeFetchedContent(successfulFetches[0]?.result?.data || {});
        return [
            'Based on the verified tool results, here is the best available answer.',
            normalizedObjective ? `Request: ${normalizedObjective}` : '',
            `Tool calls completed: ${events.length}. Successful: ${successes}. Failed: ${failures}.`,
            '',
            'Verified page summary:',
            fetchSummary || summarizeToolEventForUser(successfulFetches[0]),
        ].filter(Boolean).join('\n');
    }

    const lines = [
        'Based on the verified tool results, here is the best available answer.',
        normalizedObjective ? `Request: ${normalizedObjective}` : '',
        `Tool calls completed: ${events.length}. Successful: ${successes}. Failed: ${failures}.`,
        '',
        researchDossier ? 'Research dossier:' : 'Verified findings:',
        researchDossier || '',
        ...events
            .filter((event) => !['web-search', 'web-fetch', 'web-scrape'].includes(event?.toolCall?.function?.name || event?.result?.toolId || ''))
            .slice(0, 8)
            .map((event) => summarizeToolEventForUser(event)),
    ];

    const omittedEvents = events
        .filter((event) => !['web-search', 'web-fetch', 'web-scrape'].includes(event?.toolCall?.function?.name || event?.result?.toolId || ''))
        .length - 8;
    if (omittedEvents > 0) {
        lines.push(`- Additional tool results omitted: ${omittedEvents}.`);
    }

    return lines.filter(Boolean).join('\n');
}

function buildVerifiedToolFindingsText(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : [])
        .slice(-12)
        .map((event) => summarizeToolEventForUser(event))
        .filter(Boolean)
        .join('\n');
}

function buildCompactToolSynthesisPrompt({
    objective = '',
    taskType = 'chat',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    toolEvents = [],
} = {}) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const researchDossier = buildResearchDossierFromToolEvents({ objective, toolEvents: events });
    const conciseFindings = buildVerifiedToolFindingsText(events);
    const notesSurfaceTask = isNotesSurfaceTask({ taskType, executionProfile });

    return [
        notesSurfaceTask
            ? 'Write the final notes-page answer using only these verified tool results.'
            : 'Write the final user-facing answer using only these verified tool results.',
        ...(notesSurfaceTask
            ? [
                'If the user is editing the page, return only a valid `notes-actions` payload or page-ready notes content.',
                'Do not return standalone HTML, artifact/download language, workspace/file instructions, or shell commentary.',
                'If verified research is incomplete, still build the page structure and any safe stable content you can support. Only include source bookmarks or citations that are actually present in the verified tool results.',
            ]
            : [
                'Return plain text only.',
            ]),
        'If a tool failed, state the exact failure plainly.',
        'Do not claim a deployment is live, publicly reachable, or TLS-ready unless the verified tool results show that evidence directly.',
        'A successful rollout status or Ready pod alone is not enough to prove ingress, DNS, HTTPS, or website availability.',
        `Task type: ${taskType}`,
        '',
        'User request:',
        objective || '(empty)',
        '',
        ...(researchDossier
            ? [
                'Research dossier:',
                researchDossier,
                '',
            ]
            : []),
        ...(hasUnpersistedImageGeneration(events)
            ? [
                'Image generation warning: the tool returned usable image data but no reusable artifact was persisted. Do not invent image URLs; state the diagnostic summary instead.',
                '',
            ]
            : []),
        'Verified findings:',
        conciseFindings || '(none)',
    ].filter(Boolean).join('\n');
}

function isRemoteHealthWorkflowIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const mentionsRemoteTarget = /\b(remote|server|host|machine|ssh)\b/.test(normalized);
    const looksLikeClusterHealth = /\b(k3s|k8s|kubernetes|kubectl|cluster|pod|deployment|namespace|ingress|service)\b/.test(normalized);
    const asksForHealthReport = /\bhealth report\b/.test(normalized)
        || /\bhealth summary\b/.test(normalized)
        || /\bstatus report\b/.test(normalized)
        || /\bserver state\b/.test(normalized)
        || (/\b(health|status|state)\b/.test(normalized) && /\b(report|summary|overview)\b/.test(normalized));

    return mentionsRemoteTarget && asksForHealthReport && !looksLikeClusterHealth;
}

function isRemoteRetryWorkflowIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(try again|retry|rerun|re-run|recheck)\b/.test(normalized)
        && /\b(remote|server|host|ssh|command)\b/.test(normalized);
}

function buildRemoteHealthWorkflowSteps(target = {}, toolId = 'remote-command') {
    const sharedParams = {
        host: target.host,
        ...(target.username ? { username: target.username } : {}),
        ...(target.port ? { port: target.port } : {}),
    };

    return [
        {
            tool: toolId,
            reason: 'Collect system information for the remote server.',
            params: {
                ...sharedParams,
                command: "hostname && uname -m && (test -f /etc/os-release && sed -n '1,6p' /etc/os-release || true) && uptime",
            },
        },
        {
            tool: toolId,
            reason: 'Collect disk and memory information for the remote server.',
            params: {
                ...sharedParams,
                command: 'df -h / && free -m',
            },
        },
    ];
}

function buildDeterministicRemoteWorkflow({ objective = '', session = null, toolPolicy = {} } = {}) {
    const remoteToolId = getPreferredRemoteToolId(toolPolicy);
    if (!remoteToolId) {
        return null;
    }

    if (hasWorkloadIntent(objective)) {
        return null;
    }

    const sshContext = resolveSshRequestContext(objective, session);
    const target = sshContext.target;
    if (!target?.host) {
        return null;
    }

    const storedWorkflow = getSessionControlState(session).workflow;
    if (isRemoteRetryWorkflowIntent(objective)
        && storedWorkflow?.type === 'remote-health-report'
        && Array.isArray(storedWorkflow.steps)
        && storedWorkflow.steps.length > 0) {
        return {
            type: 'remote-health-report',
            runtimeMode: 'deterministic-remote-health',
            source: 'stored-retry',
            steps: storedWorkflow.steps.map((step) => ({
                tool: canonicalizeRemoteToolId(step?.tool || remoteToolId),
                reason: String(step?.reason || '').trim(),
                params: step?.params && typeof step.params === 'object' ? { ...step.params } : {},
            })),
        };
    }

    if (!isRemoteHealthWorkflowIntent(objective)) {
        return null;
    }

    return {
        type: 'remote-health-report',
        runtimeMode: 'deterministic-remote-health',
        source: 'direct-intent',
        steps: buildRemoteHealthWorkflowSteps(target, remoteToolId),
    };
}

function getDeterministicWorkflowStepTitle(step = {}, index = 0) {
    const reason = String(step?.reason || '').toLowerCase();
    if (reason.includes('system information')) {
        return 'System Information';
    }
    if (reason.includes('disk and memory')) {
        return 'Disk And Memory';
    }
    return `Remote Command ${index + 1}`;
}

function buildDeterministicRemoteWorkflowOutput({ workflow = null, toolEvents = [] } = {}) {
    if (!workflow || workflow.type !== 'remote-health-report') {
        return buildFallbackSynthesisText({ toolEvents });
    }

    const sections = ['Server Health Report'];
    let failures = 0;

    toolEvents.forEach((event, index) => {
        const title = getDeterministicWorkflowStepTitle(workflow.steps?.[index] || event, index);
        const result = event?.result || {};
        const stdout = stripNullCharacters(String(result?.data?.stdout || '')).trim();
        const stderr = stripNullCharacters(String(result?.data?.stderr || '')).trim();
        const error = stripNullCharacters(String(result?.error || '')).trim();

        if (result?.success === false) {
            failures += 1;
            sections.push(`${title}\n\nError: ${error || 'Unknown remote command failure.'}`);
            return;
        }

        if (stdout) {
            sections.push(`${title}\n\n\`\`\`text\n${stdout}\n\`\`\``);
        }

        if (stderr) {
            sections.push(`${title} Warnings\n\n\`\`\`text\n${stderr}\n\`\`\``);
        }
    });

    sections.push(
        failures > 0
            ? `Summary: ${failures} remote health step${failures === 1 ? '' : 's'} failed.`
            : 'Summary: Remote health inspection completed successfully.',
    );

    return sections.filter(Boolean).join('\n\n');
}

function buildDeterministicWorkflowControlState(workflow = null, toolEvents = []) {
    return {
        workflow: {
            type: workflow?.type || 'unknown',
            version: 1,
            status: (Array.isArray(toolEvents) ? toolEvents : []).some((event) => event?.result?.success === false)
                ? 'partial'
                : 'completed',
            retryable: true,
            updatedAt: new Date().toISOString(),
            steps: Array.isArray(workflow?.steps)
                ? workflow.steps.map((step) => ({
                    tool: canonicalizeRemoteToolId(step?.tool || ''),
                    reason: String(step?.reason || '').trim(),
                    params: step?.params && typeof step.params === 'object' ? { ...step.params } : {},
                }))
                : [],
        },
    };
}

function isGenericRemoteFallbackStep(step = {}) {
    return isRemoteCommandToolId(step?.tool || '')
        && String(step?.reason || '').trim() === 'Fallback for explicit server or remote-build intent.';
}

function recoverEmptyModelResponse(response = null, {
    objective = '',
    toolEvents = [],
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    runtimeMode = 'plain',
    phase = 'final-response',
} = {}) {
    const output = extractResponseText(response);
    if (output.trim()) {
        return response;
    }

    const shape = {
        responseKeys: response && typeof response === 'object' ? Object.keys(response).slice(0, 20) : [],
        choiceKeys: response?.choices?.[0] && typeof response.choices[0] === 'object' ? Object.keys(response.choices[0]).slice(0, 20) : [],
        messageKeys: response?.choices?.[0]?.message && typeof response.choices[0].message === 'object' ? Object.keys(response.choices[0].message).slice(0, 20) : [],
        outputItemCount: Array.isArray(response?.output) ? response.output.length : 0,
    };
    console.warn(`[ConversationOrchestrator] Empty model output during ${phase}. Falling back to verified tool summary. Shape=${JSON.stringify(shape)}`);

    return buildSyntheticResponse({
        output: buildFallbackSynthesisText({ objective, toolEvents }),
        responseId: response?.id || null,
        model: response?.model || null,
        metadata: {
            ...(response?.metadata && typeof response.metadata === 'object' ? response.metadata : {}),
            executionProfile,
            runtimeMode,
            toolEvents,
            emptyModelOutputRecovered: true,
            emptyModelOutputPhase: phase,
            rawResponseShape: shape,
        },
    });
}

function getRemoteBuildAutonomyBudget() {
    return {
        maxRounds: Math.max(1, Number(config.runtime?.remoteBuildMaxAutonomousRounds) || 20),
        maxToolCalls: Math.max(1, Number(config.runtime?.remoteBuildMaxAutonomousToolCalls) || 80),
        maxDurationMs: Math.max(1000, Number(config.runtime?.remoteBuildMaxAutonomousMs) || 600000),
    };
}

function getRemoteBuildAutonomyExtensionBudget() {
    return {
        maxUses: Math.max(0, Number(config.runtime?.remoteBuildBudgetExtensionMaxUses) || 6),
        rounds: Math.max(0, Number(config.runtime?.remoteBuildBudgetExtensionRounds) || 8),
        toolCalls: Math.max(0, Number(config.runtime?.remoteBuildBudgetExtensionToolCalls) || 32),
        durationMs: Math.max(0, Number(config.runtime?.remoteBuildBudgetExtensionMs) || 180000),
    };
}

function normalizePositiveBudget(value, fallback) {
    const normalized = Number(value);
    if (Number.isFinite(normalized) && normalized > 0) {
        return normalized;
    }

    return fallback;
}

function countUniqueExecutedStepSignatures(toolEvents = []) {
    const signatures = new Set();

    for (const event of Array.isArray(toolEvents) ? toolEvents : []) {
        const signature = extractExecutedStepSignature(event);
        if (signature) {
            signatures.add(signature);
        }
    }

    return signatures.size;
}

function summarizeAutonomyProgress(toolEvents = [], failureSummary = null) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const summary = failureSummary || summarizeRoundFailures(events);
    const successfulToolCalls = events.filter((event) => event?.result?.success !== false).length;
    const failedToolCalls = events.length - successfulToolCalls;
    const uniqueStepSignatures = countUniqueExecutedStepSignatures(events);

    return {
        toolCalls: events.length,
        successfulToolCalls,
        failedToolCalls,
        uniqueStepSignatures,
        blockingFailures: summary?.blockingFailures?.length || 0,
        recoverableFailures: summary?.recoverableFailures?.length || 0,
        productive: events.length > 0
            && successfulToolCalls > 0
            && uniqueStepSignatures > 0
            && (summary?.blockingFailures?.length || 0) === 0,
    };
}

function planSignalsFurtherAutonomousWork(steps = []) {
    return (Array.isArray(steps) ? steps : []).some((step) => /\b(first|next|then|after|before|follow(?:ed)? by|continue|retry|again|remaining|start|begin)\b/i.test(String(step?.reason || '').trim()));
}

function maybeExtendAutonomyBudget({
    autonomyApproved = false,
    reason = 'progress',
    startedAt = Date.now(),
    round = 0,
    toolEvents = [],
    lastProgress = null,
    budgetState = {},
    extensionBudget = {},
    executionTrace = [],
} = {}) {
    if (!autonomyApproved) {
        return false;
    }

    if ((budgetState.extensionsUsed || 0) >= (extensionBudget.maxUses || 0)) {
        return false;
    }

    if ((extensionBudget.rounds || 0) <= 0
        && (extensionBudget.toolCalls || 0) <= 0
        && (extensionBudget.durationMs || 0) <= 0) {
        return false;
    }

    if (!lastProgress?.productive) {
        return false;
    }

    budgetState.extensionsUsed = (budgetState.extensionsUsed || 0) + 1;
    budgetState.maxRounds += extensionBudget.rounds || 0;
    budgetState.maxToolCalls += extensionBudget.toolCalls || 0;
    budgetState.autonomyDeadline += extensionBudget.durationMs || 0;

    executionTrace.push(createExecutionTraceEntry({
        type: 'budget',
        name: 'Autonomous execution budget extended',
        details: {
            reason,
            round,
            toolCalls: toolEvents.length,
            elapsedMs: Date.now() - startedAt,
            extensionsUsed: budgetState.extensionsUsed,
            maxExtensions: extensionBudget.maxUses || 0,
            addedRounds: extensionBudget.rounds || 0,
            addedToolCalls: extensionBudget.toolCalls || 0,
            addedDurationMs: extensionBudget.durationMs || 0,
            lastProgress: {
                toolCalls: lastProgress.toolCalls || 0,
                successfulToolCalls: lastProgress.successfulToolCalls || 0,
                failedToolCalls: lastProgress.failedToolCalls || 0,
                uniqueStepSignatures: lastProgress.uniqueStepSignatures || 0,
                blockingFailures: lastProgress.blockingFailures || 0,
                recoverableFailures: lastProgress.recoverableFailures || 0,
            },
            updatedBudget: {
                maxRounds: budgetState.maxRounds,
                maxToolCalls: budgetState.maxToolCalls,
                maxDurationMs: Math.max(0, budgetState.autonomyDeadline - startedAt),
            },
        },
    }));

    return true;
}

function getPreferredRemoteToolId(toolPolicy = {}) {
    const availableToolIds = Array.isArray(toolPolicy?.candidateToolIds) && toolPolicy.candidateToolIds.length > 0
        ? toolPolicy.candidateToolIds
        : Array.isArray(toolPolicy?.allowedToolIds)
            ? toolPolicy.allowedToolIds
            : [];

    if (availableToolIds.includes('remote-command')) {
        return 'remote-command';
    }

    if (availableToolIds.includes('ssh-execute')) {
        return 'ssh-execute';
    }

    return null;
}

function sanitizeValue(value, depth = 0) {
    if (value == null) {
        return value;
    }

    if (typeof value === 'string') {
        return truncateText(value, MAX_TOOL_RESULT_CHARS);
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (depth >= 4) {
        return '[truncated]';
    }

    if (Array.isArray(value)) {
        return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1));
    }

    return Object.fromEntries(
        Object.entries(value)
            .slice(0, 30)
            .map(([key, entry]) => [key, sanitizeValue(entry, depth + 1)]),
    );
}

function normalizeToolResult(result, fallbackToolId, timing = {}) {
    const endTime = toIsoTimestamp(timing?.endedAt || result?.endedAt || result?.timestamp, new Date().toISOString());
    const explicitStartTime = toIsoTimestamp(timing?.startedAt || result?.startedAt, null);
    const fallbackStartTime = explicitStartTime
        || toIsoTimestamp(new Date(new Date(endTime).getTime() - Math.max(0, Number(result?.duration || 0))), endTime);
    const durationFromTimestamps = Math.max(0, new Date(endTime).getTime() - new Date(fallbackStartTime).getTime());

    return {
        success: result?.success !== false,
        toolId: result?.toolId || fallbackToolId,
        duration: Number(result?.duration || durationFromTimestamps || 0),
        data: sanitizeValue(result?.data),
        error: result?.error || null,
        diagnostics: sanitizeValue(result?.diagnostics),
        timestamp: endTime,
        startedAt: fallbackStartTime,
        endedAt: endTime,
    };
}

function extractVerifiedImageEmbeds(toolEvents = []) {
    return toolEvents.flatMap((event) => {
        const toolId = String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim();
        const data = event?.result?.data || {};
        const embeds = [];

        if (toolId === 'image-generate') {
            const diagnostics = getImageDiagnosticsFromToolEvent(event);
            const artifactCount = Number(diagnostics?.counts?.artifacts || 0)
                || (Array.isArray(data.artifacts) ? data.artifacts.length : 0)
                || (Array.isArray(data.artifactIds) ? data.artifactIds.length : 0);
            if (artifactCount <= 0) {
                return [];
            }
        }

        if (typeof data.markdownImage === 'string' && data.markdownImage.trim()) {
            embeds.push(data.markdownImage.trim());
        }

        if (Array.isArray(data.markdownImages)) {
            embeds.push(...data.markdownImages
                .filter((entry) => typeof entry === 'string' && entry.trim())
                .map((entry) => entry.trim()));
        }

        return embeds;
    });
}

function buildResearchMemoryNotesFromToolEvents({ objective = '', toolEvents = [] } = {}) {
    if (!hasExplicitWebResearchIntentText(objective)) {
        return [];
    }

    const searchResults = Array.isArray(getLastSuccessfulToolEvent(toolEvents, 'web-search')?.result?.data?.results)
        ? getLastSuccessfulToolEvent(toolEvents, 'web-search').result.data.results
        : [];
    const searchResultByUrl = new Map(
        searchResults
            .filter((entry) => String(entry?.url || '').trim())
            .map((entry) => [String(entry.url).trim(), entry]),
    );
    const seen = new Set();

    return toolEvents
        .filter((event) => event?.result?.success && ['web-fetch', 'web-scrape'].includes(event?.result?.toolId || event?.toolCall?.function?.name))
        .map((event) => {
            const result = event.result || {};
            const url = String(result?.data?.url || '').trim();
            if (!url || seen.has(url)) {
                return null;
            }

            seen.add(url);
            const searchMeta = searchResultByUrl.get(url) || {};
            const title = String(searchMeta.title || result?.data?.title || '').trim();
            const snippet = String(searchMeta.snippet || '').replace(/\s+/g, ' ').trim();
            const sourceNotes = (result.toolId === 'web-fetch'
                ? stripHtmlToText(String(result?.data?.body || ''))
                : (
                    String(result?.data?.content || result?.data?.text || '').trim()
                    || stripHtmlToText(JSON.stringify(result?.data?.data || {}))
                ))
                .slice(0, config.memory.researchSourceExcerptChars)
                .trim();

            if (!title && !snippet && !sourceNotes) {
                return null;
            }

            return [
                '[Research note]',
                `Query: ${objective}`,
                title ? `Title: ${title}` : null,
                `URL: ${url}`,
                snippet ? `Search snippet: ${snippet}` : null,
                sourceNotes ? `Source notes: ${sourceNotes}` : null,
            ].filter(Boolean).join('\n');
        })
        .filter(Boolean)
        .slice(0, normalizeResearchFollowupPageCount());
}

function buildSyntheticResponse({ output, responseId, model, metadata = {} }) {
    return {
        id: responseId || `resp_orch_${Date.now()}`,
        object: 'response',
        created: Math.floor(Date.now() / 1000),
        model: model || null,
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text: output || '',
                    },
                ],
            },
        ],
        metadata,
    };
}

function normalizeModelResponseShape(response = null) {
    if (!response || typeof response !== 'object') {
        return response;
    }

    if (Array.isArray(response.output) && response.output.length > 0) {
        return response;
    }

    const text = extractResponseText(response);
    if (!text) {
        return response;
    }

    const normalized = buildSyntheticResponse({
        output: text,
        responseId: response.id,
        model: response.model,
        metadata: response?.metadata && typeof response.metadata === 'object'
            ? response.metadata
            : {},
    });

    return {
        ...response,
        ...normalized,
        metadata: {
            ...(response?.metadata && typeof response.metadata === 'object' ? response.metadata : {}),
            ...(normalized.metadata || {}),
        },
    };
}

function attachEstimatedUsageMetadata(response = null, inputText = '') {
    if (!response || typeof response !== 'object') {
        return response;
    }

    const existingUsage = extractResponseUsageMetadata(response);
    if (hasMeasuredTokenCounts(existingUsage)) {
        return response;
    }

    const estimatedUsage = createEstimatedUsageMetadata({
        input: inputText,
        output: extractResponseText(response),
        modelCalls: existingUsage?.modelCalls || 1,
    });
    if (!estimatedUsage) {
        return response;
    }

    const existingMetadata = response.metadata && typeof response.metadata === 'object'
        ? response.metadata
        : {};
    return {
        ...response,
        metadata: {
            ...existingMetadata,
            ...(existingUsage ? { providerUsage: existingUsage } : {}),
            usage: estimatedUsage,
            tokenUsage: estimatedUsage,
        },
    };
}

async function* createSyntheticStream(response = {}) {
    const text = extractResponseText(response);
    if (text) {
        for (let index = 0; index < text.length; index += SYNTHETIC_STREAM_CHUNK_SIZE) {
            yield {
                type: 'response.output_text.delta',
                delta: text.slice(index, index + SYNTHETIC_STREAM_CHUNK_SIZE),
            };
        }
    }

    yield {
        type: 'response.completed',
        response,
    };
}

class ConversationOrchestrator extends EventEmitter {
    constructor({
        llmClient,
        toolManager = null,
        sessionStore = null,
        memoryService = null,
        embedder = null,
        vectorStore = null,
    } = {}) {
        super();
        this.llmClient = llmClient || {
            createResponse: (params) => createResponse(params),
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
        this.toolManager = toolManager;
        this.sessionStore = sessionStore;
        this.memoryService = memoryService;
        this.embedder = embedder;
        this.vectorStore = vectorStore;
    }

    async execute(taskConfig = {}) {
        const startedAt = Date.now();
        const sessionId = taskConfig.sessionId || `sdk-${Date.now()}`;
        const result = await this.executeConversation({
            input: taskConfig.input || taskConfig.prompt || '',
            sessionId,
            model: taskConfig.model || null,
            reasoningEffort: taskConfig.reasoningEffort || taskConfig.options?.reasoningEffort || null,
            instructions: taskConfig.instructions || null,
            executionProfile: taskConfig.options?.executionProfile || taskConfig.executionProfile || DEFAULT_EXECUTION_PROFILE,
            metadata: taskConfig.options || {},
            stream: false,
        });

        return {
            output: result.output,
            trace: result.trace,
            duration: Date.now() - startedAt,
            sessionId,
            response: result.response,
        };
    }

    async executeConversation({
        input,
        instructions = null,
        contextMessages = [],
        recentMessages = [],
        stream = false,
        model = null,
        reasoningEffort = null,
        signal = null,
        toolManager = null,
        toolContext = {},
        loadContextMessages = true,
        loadRecentMessages = true,
        sessionId = 'default',
        ownerId = null,
        taskType = 'chat',
        metadata = {},
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        memoryInput = '',
        requestedToolIds = [],
        toolBudget = null,
        onProgress = null,
    } = {}) {
        const startedAt = Date.now();
        const setupStartedAt = new Date().toISOString();
        const requestedProfile = normalizeExecutionProfile(executionProfile);
        const rawObjective = extractObjective(input, memoryInput);
        const foregroundTurn = metadata?.foregroundTurn || metadata?.foreground_turn || null;
        const runtimeToolManager = toolManager || this.toolManager;
        const clientSurface = resolveClientSurface({
            taskType,
            clientSurface: toolContext?.clientSurface || metadata?.clientSurface || metadata?.client_surface || '',
            metadata,
        }, null, taskType);
        const scopedSessionMetadata = buildScopedSessionMetadata({
            mode: taskType,
            taskType,
            clientSurface,
            memoryScope: toolContext?.memoryScope || metadata?.memoryScope || metadata?.memory_scope || '',
            transport: toolContext?.transport || metadata?.transport || '',
            metadata,
        });
        let executionTrace = [];
        const session = ownerId && this.sessionStore?.getOrCreateOwned
            ? await this.sessionStore.getOrCreateOwned(sessionId, scopedSessionMetadata, ownerId)
            : this.sessionStore?.getOrCreate
                ? await this.sessionStore.getOrCreate(sessionId, scopedSessionMetadata)
                : ownerId && this.sessionStore?.getOwned
                    ? await this.sessionStore.getOwned(sessionId, ownerId)
                    : (this.sessionStore?.get ? await this.sessionStore.get(sessionId) : null);
        const resolvedProfile = inferRuntimeExecutionProfile({
            executionProfile: requestedProfile,
            taskType,
            input: rawObjective,
            memoryInput: memoryInput || rawObjective,
            metadata,
            session,
            clientSurface,
        });
        const memoryScope = resolveSessionScope({
            ...scopedSessionMetadata,
            memoryScope: toolContext?.memoryScope || metadata?.memoryScope || metadata?.memory_scope || '',
        }, session || null);
        const sessionIsolation = isSessionIsolationEnabled({
            sessionIsolation: toolContext?.sessionIsolation,
            metadata,
        }, session || null);
        const projectKey = resolveProjectKey({
            ...scopedSessionMetadata,
            ...(metadata || {}),
            ...(toolContext || {}),
            memoryScope,
            clientSurface,
        }, session || null);
        toolContext = {
            ...toolContext,
            ...(signal ? { signal } : {}),
            ...(clientSurface ? { clientSurface } : {}),
            ...(memoryScope ? { memoryScope } : {}),
            ...(projectKey ? { projectKey } : {}),
            ...(sessionIsolation ? { sessionIsolation: true } : {}),
            ...(Array.isArray(toolContext?.memoryKeywords) ? { memoryKeywords: toolContext.memoryKeywords } : {}),
        };
        const resolvedRecentMessages = recentMessages.length > 0
            ? recentMessages
            : loadRecentMessages !== false && this.sessionStore?.getRecentMessages
                ? await this.sessionStore.getRecentMessages(sessionId, RECENT_TRANSCRIPT_LIMIT)
                : [];
        const taskFrameObjective = resolveObjectiveFromActiveTaskFrame(rawObjective, session, clientSurface);
        const preRecallObjectiveSeed = taskFrameObjective.usedTaskFrameContext
            ? taskFrameObjective.objective
            : rawObjective;
        const remoteResolvedObjective = resolvedProfile === REMOTE_BUILD_EXECUTION_PROFILE
            ? resolveRemoteObjectiveFromSession(preRecallObjectiveSeed, session, resolvedRecentMessages)
            : preRecallObjectiveSeed;
        const transcriptObjective = resolveTranscriptObjectiveFromSession(remoteResolvedObjective, resolvedRecentMessages);
        const objective = transcriptObjective.objective;
        const memoryKeywords = Array.isArray(toolContext?.memoryKeywords)
            ? toolContext.memoryKeywords
            : (Array.isArray(metadata?.memoryKeywords) ? metadata.memoryKeywords : []);
        const memoryRecall = contextMessages.length > 0
            ? { contextMessages, trace: null }
            : loadContextMessages !== false && this.memoryService?.process
                ? await this.memoryService.process(sessionId, memoryInput || rawObjective, {
                    profile: inferRecallProfileFromText(objective),
                    ownerId,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    sourceSurface: clientSurface || memoryScope || null,
                    projectKey: projectKey || null,
                    recallQuery: objective,
                    objective,
                    session,
                    recentMessages: resolvedRecentMessages,
                    returnDetails: true,
                })
                : { contextMessages: [], trace: null };
        const resolvedContextMessages = Array.isArray(memoryRecall)
            ? memoryRecall
            : Array.isArray(memoryRecall?.contextMessages)
                ? memoryRecall.contextMessages
            : [];
        const memoryTrace = Array.isArray(memoryRecall) ? null : (memoryRecall?.trace || null);
        const naturalContext = buildNaturalContext({
            session,
            metadata,
            clientSurface,
            taskType,
            userText: rawObjective,
        });
        const incomingInstructions = String(instructions || '');
        const hasNaturalInstructions = /<natural_context>|<skills_tree>/i.test(incomingInstructions);
        const naturalContextInstructions = hasNaturalInstructions
            ? ''
            : [
                buildSkillsTreeInstructions({ clientSurface, taskType }),
                buildNaturalContextInstructions(naturalContext),
                buildRegisteredSkillsInstructions({
                    userText: rawObjective,
                    metadata,
                }),
            ].filter(Boolean).join('\n\n');
        const effectiveInstructionsBase = [
            incomingInstructions,
            naturalContextInstructions,
        ].filter(Boolean).join('\n\n');
        const effectiveInstructions = (taskFrameObjective.usedTaskFrameContext || transcriptObjective.usedTranscriptContext)
            ? [
                effectiveInstructionsBase,
                ...(taskFrameObjective.usedTaskFrameContext
                    ? ['An active task frame already exists for this session. Prefer continuing that same project-local objective before asking the user to restate context.']
                    : []),
                'The current user turn may be abbreviated or cut off. Use the recent transcript to resolve the intended task and continue without asking the user to restate prior context unless the transcript is genuinely insufficient.',
            ].filter(Boolean).join('\n\n')
            : effectiveInstructionsBase;
        const requestClassification = isJudgmentV2Enabled()
            ? classifyRequestIntent({
                objective,
                executionProfile: resolvedProfile,
                taskType,
                clientSurface,
                recentMessages: resolvedRecentMessages,
                session,
            })
            : null;
        const rewriteIntent = inferTaskIntent({
            objective,
            instructions: effectiveInstructions,
            executionProfile: resolvedProfile,
            classification: requestClassification,
        });
        const agencyProfile = isOrchestrationRewriteEnabled()
            ? buildRewriteAgencyProfile({
                intent: rewriteIntent,
                objective,
                executionProfile: resolvedProfile,
            })
            : inferAgencyProfile({
                objective,
                executionProfile: resolvedProfile,
                classification: requestClassification,
            });
        const sessionControlState = getSessionControlState(session);
        const storedForegroundContinuationGate = normalizeForegroundContinuationGate(
            sessionControlState.foregroundContinuationGate,
        );
        const autonomyContinuationDecision = parseAutonomyContinuationDecision(objective);
        const shouldClearForegroundContinuationGate = autonomyContinuationDecision === 'continue'
            || (storedForegroundContinuationGate?.paused && hasExplicitForegroundResumeIntent(objective));
        const foregroundContinuationGatePatch = autonomyContinuationDecision === 'stop'
            ? {
                foregroundContinuationGate: {
                    paused: true,
                    source: 'autonomy-time-budget',
                    updatedAt: new Date().toISOString(),
                },
            }
            : (shouldClearForegroundContinuationGate
                ? { foregroundContinuationGate: null }
                : {});

        const toolPolicy = this.buildToolPolicy({
            objective,
            instructions: effectiveInstructions,
            session,
            metadata,
            executionProfile: resolvedProfile,
            toolManager: runtimeToolManager,
            requestedToolIds,
            recentMessages: resolvedRecentMessages,
            toolContext,
            classification: requestClassification,
            agencyProfile,
            toolEvents: [],
        });
        if (resolvedProfile === REMOTE_BUILD_EXECUTION_PROFILE && !toolPolicy.workflow) {
            const deployDefaults = typeof settingsController.getEffectiveDeployConfig === 'function'
                ? settingsController.getEffectiveDeployConfig()
                : {};
            const fallbackSshContext = resolveSshRequestContext(objective, session);
            const fallbackWorkflow = inferEndToEndBuilderWorkflow({
                objective,
                session,
                workspacePath: resolvePreferredRemoteCliWorkspacePath({
                    session,
                    toolContext,
                }),
                repositoryPath: config.deploy.defaultRepositoryPath || '',
                remoteTarget: fallbackSshContext.target || null,
                deployDefaults,
            });
            if (fallbackWorkflow?.status === 'blocked') {
                toolPolicy.workflow = fallbackWorkflow;
            }
        }
        let endToEndWorkflow = resolvedProfile === REMOTE_BUILD_EXECUTION_PROFILE
            ? toolPolicy.workflow || null
            : null;
        let activeProjectPlan = toolPolicy.projectPlan || null;
        if (endToEndWorkflow) {
            endToEndWorkflow = evaluateEndToEndBuilderWorkflow({
                workflow: endToEndWorkflow,
                toolPolicy,
                remoteToolId: toolPolicy.preferredRemoteToolId,
                deployDefaults: typeof settingsController.getEffectiveDeployConfig === 'function'
                    ? settingsController.getEffectiveDeployConfig()
                    : {},
            });
            toolPolicy.workflow = endToEndWorkflow;
            activeProjectPlan = advanceForegroundProjectPlan({
                projectPlan: activeProjectPlan,
                workflow: endToEndWorkflow,
            });
            toolPolicy.projectPlan = activeProjectPlan;
        }

        this.emit('task:start', {
            task: { type: taskType, objective },
            sessionId,
            timestamp: Date.now(),
            metadata: {
                ...metadata,
                executionProfile: resolvedProfile,
                tools: toolPolicy.candidateToolIds,
            },
        });

        let finalResponse;
        let output;
        let toolEvents = [];
        let plan = [];
        let runtimeMode = 'plain';
        let lastProgressFingerprint = '';
        const traceModelResponse = (response, phase = 'final-response', startedAtOverride = null) => {
            appendModelResponseTrace(executionTrace, response, {
                phase,
                startedAt: startedAtOverride,
                toolEvents,
            });
        };
        const publishProgress = ({
            phase = 'thinking',
            detail = '',
            planOverride = null,
            activePlanIndex = -1,
            completedPlanSteps = 0,
            failedPlanStepIndex = -1,
            estimated = true,
            source = '',
        } = {}) => {
            const snapshot = buildConversationProgressSnapshot({
                phase,
                detail,
                projectPlan: activeProjectPlan,
                workflow: endToEndWorkflow,
                plan: Array.isArray(planOverride) ? planOverride : plan,
                activePlanIndex,
                completedPlanSteps,
                failedPlanStepIndex,
                estimated,
                source,
            });
            if (!snapshot) {
                return;
            }

            const fingerprint = buildConversationProgressFingerprint(snapshot);
            if (fingerprint === lastProgressFingerprint) {
                return;
            }

            lastProgressFingerprint = fingerprint;
            emitConversationProgress(onProgress, snapshot);
        };
        const requestedAutonomyApproval = Boolean(
            metadata?.remoteBuildAutonomyApproved
            || metadata?.remote_build_autonomy_approved
            || metadata?.frontendRemoteBuildAutonomyApproved
            || metadata?.frontend_remote_build_autonomy_approved,
        );
        const autonomyApprovalSource = requestedAutonomyApproval
            ? 'frontend'
            : hasAutonomousRemoteApproval(objective)
                ? 'user'
                : session?.metadata?.remoteBuildAutonomyApproved
                    ? 'session'
                    : config.runtime.remoteBuildAutonomyDefault
                        ? 'config'
                    : null;
        const autonomyApproved = resolvedProfile === REMOTE_BUILD_EXECUTION_PROFILE
            && !hasAutonomyRevocation(objective)
            && (
                requestedAutonomyApproval
                || hasAutonomousRemoteApproval(objective)
                || Boolean(session?.metadata?.remoteBuildAutonomyApproved)
                || Boolean(config.runtime.remoteBuildAutonomyDefault)
            );
        const autonomyBudget = getRemoteBuildAutonomyBudget();
        const autonomyExtensionBudget = getRemoteBuildAutonomyExtensionBudget();
        const allowsDeterministicResearchFollowup = !autonomyApproved
            && (hasExplicitWebResearchIntentText(objective) || hasCurrentInfoIntentText(objective));
        const deterministicFollowupRounds = allowsDeterministicResearchFollowup
            ? (hasDocumentWorkflowIntentText(objective) ? 3 : 2)
            : 1;
        const guardedAgencyRounds = Math.max(
            deterministicFollowupRounds,
            Number(agencyProfile?.maxRoundsHint || 1),
            Number(toolPolicy?.rolePipeline?.maxRoundsHint || 1),
        );
        const guardedAgencyToolCalls = Math.max(
            MAX_PLAN_STEPS,
            Number(agencyProfile?.maxToolCallsHint || MAX_PLAN_STEPS),
            Number(toolPolicy?.rolePipeline?.maxToolCallsHint || MAX_PLAN_STEPS),
        );
        const hasCustomToolBudget = Number.isFinite(Number(toolBudget?.maxDurationMs)) && Number(toolBudget.maxDurationMs) > 0;
        const budgetState = {
            maxRounds: normalizePositiveBudget(
                toolBudget?.maxRounds,
                autonomyApproved ? autonomyBudget.maxRounds : guardedAgencyRounds,
            ),
            maxToolCalls: normalizePositiveBudget(
                toolBudget?.maxToolCalls,
                autonomyApproved ? autonomyBudget.maxToolCalls : guardedAgencyToolCalls,
            ),
            autonomyDeadline: startedAt + normalizePositiveBudget(
                toolBudget?.maxDurationMs,
                autonomyApproved ? autonomyBudget.maxDurationMs : 1000,
            ),
            extensionsUsed: 0,
        };
        const restoredHarnessSnapshot = isHarnessResumeTurn(rawObjective, objective)
            ? sessionControlState.harness
            : null;
        const shouldUseRolePipelineCriteria = toolPolicy?.rolePipeline?.requiresDesign === true
            || toolPolicy?.rolePipeline?.requiresBuild === true;
        const rolePipelineCriteria = shouldUseRolePipelineCriteria && Array.isArray(toolPolicy?.rolePipeline?.roles)
            ? toolPolicy.rolePipeline.roles
                .filter((role) => ![ROLE_IDS.ORCHESTRATOR, ROLE_IDS.INTEGRATOR].includes(role?.id))
                .map((role) => role?.outputContract?.format || role?.label || '')
                .filter(Boolean)
            : [];
        const harnessRunDefaults = {
            objective,
            executionProfile: resolvedProfile,
            autonomyApproved,
            maxRounds: budgetState.maxRounds,
            maxToolCalls: budgetState.maxToolCalls,
            maxReplans: resolvedProfile === REMOTE_BUILD_EXECUTION_PROFILE && autonomyApproved
                ? REMOTE_BUILD_MAX_REPLANS
                : NORMAL_PROFILE_MAX_REPLANS,
            completionCriteria: Array.isArray(activeProjectPlan?.milestones)
                ? activeProjectPlan.milestones
                    .filter((milestone) => milestone?.status !== 'completed')
                    .map((milestone) => milestone.title || milestone.objective || '')
                    .filter(Boolean)
                : rolePipelineCriteria,
            workflow: endToEndWorkflow,
            projectPlan: activeProjectPlan,
        };
        const harnessRun = isHarnessSnapshotResumeable(restoredHarnessSnapshot)
            ? HarnessRunState.fromControlState(restoredHarnessSnapshot, harnessRunDefaults)
            : new HarnessRunState(harnessRunDefaults);
        const refreshHarnessMetadata = (decision = null, reason = '') => {
            harnessRun.setBudget({
                maxRounds: budgetState.maxRounds,
                maxToolCalls: budgetState.maxToolCalls,
            });
            if (decision) {
                harnessRun.setDecision(decision, reason);
            }
            toolPolicy.harness = harnessRun.toJSON();
            return toolPolicy.harness;
        };
        refreshHarnessMetadata();
        publishProgress({
            phase: 'planning',
            detail: 'Estimating the work and lining up the steps.',
        });

        try {
            executionTrace.push(createExecutionTraceEntry({
                type: 'setup',
                name: 'Conversation setup',
                startedAt: setupStartedAt,
                endedAt: new Date().toISOString(),
                details: {
                    executionProfile: resolvedProfile,
                    contextMessages: resolvedContextMessages.length,
                    recentMessages: resolvedRecentMessages.length,
                    toolCandidates: toolPolicy.candidateToolIds.length,
                    harness: toolPolicy.harness,
                },
            }));

            if (requestClassification) {
                executionTrace.push(createExecutionTraceEntry({
                    type: 'classification',
                    name: 'Request classification',
                    details: {
                        taskFamily: requestClassification.taskFamily,
                        groundingRequirement: requestClassification.groundingRequirement,
                        surfaceMode: requestClassification.surfaceMode,
                        preferredExecutionPath: requestClassification.preferredExecutionPath,
                        checkpointNeed: requestClassification.checkpointNeed,
                        confidence: requestClassification.confidence,
                        ambiguous: requestClassification.ambiguous,
                        agencyProfile,
                        reasons: requestClassification.reasons || [],
                    },
                }));
            }

            if (requestClassification && toolPolicy?.candidateToolScores) {
                executionTrace.push(createExecutionTraceEntry({
                    type: 'planning',
                    name: 'Candidate tool scoring',
                    details: {
                        scores: toolPolicy.candidateToolScores,
                    },
                }));
            }

            if (endToEndWorkflow) {
                executionTrace.push(createExecutionTraceEntry({
                    type: 'workflow',
                    name: 'End-to-end builder workflow',
                    details: {
                        lane: endToEndWorkflow.lane,
                        stage: endToEndWorkflow.stage,
                        status: endToEndWorkflow.status,
                    },
                }));
            }

            if (resolvedProfile === REMOTE_BUILD_EXECUTION_PROFILE) {
                executionTrace.push(createExecutionTraceEntry({
                    type: 'approval',
                    name: autonomyApproved
                        ? 'Remote-build autonomy approved'
                        : 'Remote-build autonomy not approved',
                    details: {
                        approved: autonomyApproved,
                        source: autonomyApprovalSource || 'none',
                        maxAutonomousRounds: budgetState.maxRounds,
                        maxAutonomousToolCalls: budgetState.maxToolCalls,
                        maxAutonomousDurationMs: autonomyApproved ? autonomyBudget.maxDurationMs : 0,
                        maxAutonomousExtensions: autonomyExtensionBudget.maxUses || 0,
                    },
                }));
            }

            if (endToEndWorkflow?.status === 'blocked') {
                runtimeMode = 'workflow-blocked';
                refreshHarnessMetadata('blocked', endToEndWorkflow.lastError || 'The active workflow is blocked.');
                executionTrace.push(createExecutionTraceEntry({
                    type: 'workflow',
                    name: 'End-to-end builder workflow blocked',
                    status: 'error',
                    details: {
                        lane: endToEndWorkflow.lane,
                        stage: endToEndWorkflow.stage,
                        error: endToEndWorkflow.lastError || null,
                    },
                }));
                finalResponse = this.withResponseMetadata(buildSyntheticResponse({
                    output: buildEndToEndWorkflowBlockedOutput(endToEndWorkflow),
                    responseId: `resp_workflow_blocked_${Date.now()}`,
                    model: model || null,
                    metadata: {
                        workflowBlocked: true,
                        toolEvents,
                    },
                }), {
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolEvents,
                    toolPolicy,
                    autonomyApproved,
                    executionTrace,
                });
                output = extractResponseText(finalResponse);

                return this.completeConversationRun({
                    sessionId,
                    ownerId,
                    userText: rawObjective,
                    objective,
                    taskType,
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolPolicy,
                    toolEvents,
                    output,
                    finalResponse,
                    startedAt,
                    metadata,
                    foregroundTurn,
                    clientSurface,
                    memoryKeywords,
                    memoryTrace,
                    autonomyApproved,
                    executionTrace,
                    stream,
                controlStatePatch: {
                    workflow: endToEndWorkflow,
                    ...foregroundContinuationGatePatch,
                    ...(activeProjectPlan ? { projectPlan: activeProjectPlan } : {}),
                },
            });
        }

            const deterministicWorkflow = buildDeterministicRemoteWorkflow({
                objective,
                session,
                toolPolicy,
            });

            if (deterministicWorkflow) {
                runtimeMode = deterministicWorkflow.runtimeMode;
                executionTrace.push(createExecutionTraceEntry({
                    type: 'planning',
                    name: 'Deterministic workflow selection',
                    details: {
                        workflow: deterministicWorkflow.type,
                        source: deterministicWorkflow.source,
                        stepCount: deterministicWorkflow.steps.length,
                    },
                }));
                publishProgress({
                    phase: 'planning',
                    detail: 'A multi-step workflow is ready. Starting the first step.',
                    planOverride: deterministicWorkflow.steps,
                    activePlanIndex: 0,
                    completedPlanSteps: 0,
                    estimated: false,
                    source: 'tool-plan',
                });

                const deterministicExecutionStartedAt = new Date().toISOString();
                harnessRun.recordPlan({ round: 1, steps: deterministicWorkflow.steps, source: 'deterministic-workflow' });
                refreshHarnessMetadata();
                const {
                    toolEvents: deterministicToolEvents,
                } = await this.executePlan({
                    plan: deterministicWorkflow.steps,
                    toolManager: runtimeToolManager,
                    sessionId,
                    executionProfile: resolvedProfile,
                    toolPolicy,
                    toolContext,
                    objective,
                    session,
                    recentMessages: resolvedRecentMessages,
                    executionTrace,
                    round: 1,
                    harnessRun,
                    onProgress: (progress) => publishProgress({
                        ...progress,
                        planOverride: progress.plan,
                        estimated: false,
                        source: 'tool-plan',
                    }),
                });

                toolEvents = deterministicToolEvents;
                refreshHarnessMetadata(
                    deterministicToolEvents.some((event) => event?.result?.success === false) ? 'blocked' : 'synthesize',
                    deterministicToolEvents.some((event) => event?.result?.success === false)
                        ? 'Deterministic workflow stopped on a tool failure.'
                        : 'Deterministic workflow finished and can be synthesized.',
                );
                executionTrace.push(createExecutionTraceEntry({
                    type: 'execution',
                    name: 'Deterministic workflow execution',
                    startedAt: deterministicExecutionStartedAt,
                    endedAt: new Date().toISOString(),
                    status: deterministicToolEvents.some((event) => event?.result?.success === false) ? 'error' : 'completed',
                    details: {
                        workflow: deterministicWorkflow.type,
                        stepCount: deterministicToolEvents.length,
                    },
                }));
                publishProgress({
                    phase: 'finalizing',
                    detail: 'Preparing the final summary from the completed steps.',
                    planOverride: deterministicWorkflow.steps,
                    activePlanIndex: -1,
                    completedPlanSteps: deterministicToolEvents.filter((event) => event?.result?.success !== false).length,
                    failedPlanStepIndex: deterministicToolEvents.findIndex((event) => event?.result?.success === false),
                    estimated: false,
                    source: 'tool-plan',
                });

                finalResponse = this.withResponseMetadata(buildSyntheticResponse({
                    output: buildDeterministicRemoteWorkflowOutput({
                        workflow: deterministicWorkflow,
                        toolEvents,
                    }),
                    responseId: `resp_workflow_${Date.now()}`,
                    model: model || null,
                    metadata: {
                        deterministicWorkflow: true,
                        workflowType: deterministicWorkflow.type,
                        toolEvents,
                    },
                }), {
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolEvents,
                    toolPolicy,
                    autonomyApproved,
                    executionTrace,
                });

                traceModelResponse(finalResponse, 'deterministic-workflow', deterministicExecutionStartedAt);
                output = extractResponseText(finalResponse);

                return this.completeConversationRun({
                    sessionId,
                    ownerId,
                    userText: rawObjective,
                    objective,
                    taskType,
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolPolicy,
                    toolEvents,
                    output,
                    finalResponse,
                    startedAt,
                    metadata,
                    foregroundTurn,
                    clientSurface,
                    memoryKeywords,
                    memoryTrace,
                    autonomyApproved,
                    executionTrace,
                    stream,
                    controlStatePatch: mergeControlState(
                        buildDeterministicWorkflowControlState(deterministicWorkflow, toolEvents),
                        mergeControlState(
                            foregroundContinuationGatePatch,
                            activeProjectPlan ? { projectPlan: activeProjectPlan } : {},
                        ),
                    ),
                });
            }

            const executedStepSignatures = [];
            const executedStepSignatureCounts = new Map();
            let round = 0;
            let lastAutonomyProgress = null;
            let forcedRecoveryPlan = [];

            while (true) {
                if (round >= budgetState.maxRounds) {
                    const extended = maybeExtendAutonomyBudget({
                        autonomyApproved,
                        reason: 'round-limit',
                        startedAt,
                        round,
                        toolEvents,
                        lastProgress: lastAutonomyProgress,
                        budgetState,
                        extensionBudget: autonomyExtensionBudget,
                        executionTrace,
                    });

                    if (!extended) {
                        executionTrace.push(createExecutionTraceEntry({
                            type: 'budget',
                            name: 'Autonomous execution round budget reached',
                            details: {
                                round,
                                maxRounds: budgetState.maxRounds,
                                toolCalls: toolEvents.length,
                                maxToolCalls: budgetState.maxToolCalls,
                                elapsedMs: Date.now() - startedAt,
                                maxDurationMs: (autonomyApproved || hasCustomToolBudget) ? Math.max(0, budgetState.autonomyDeadline - startedAt) : 0,
                                extensionsUsed: budgetState.extensionsUsed,
                                maxExtensions: autonomyExtensionBudget.maxUses || 0,
                            },
                        }));
                        break;
                    }
                }

                if ((autonomyApproved || hasCustomToolBudget) && Date.now() >= budgetState.autonomyDeadline) {
                    const extended = maybeExtendAutonomyBudget({
                        autonomyApproved,
                        reason: 'time-limit-before-round',
                        startedAt,
                        round,
                        toolEvents,
                        lastProgress: lastAutonomyProgress,
                        budgetState,
                        extensionBudget: autonomyExtensionBudget,
                        executionTrace,
                    });

                    if (extended) {
                        continue;
                    }

                    executionTrace.push(createExecutionTraceEntry({
                        type: 'budget',
                        name: 'Autonomous execution time budget reached',
                        details: {
                            round,
                            phase: 'before-round',
                            maxRounds: budgetState.maxRounds,
                            toolCalls: toolEvents.length,
                            maxToolCalls: budgetState.maxToolCalls,
                            elapsedMs: Date.now() - startedAt,
                            maxDurationMs: Math.max(0, budgetState.autonomyDeadline - startedAt),
                            extensionsUsed: budgetState.extensionsUsed,
                            maxExtensions: autonomyExtensionBudget.maxUses || 0,
                        },
                    }));
                    break;
                }

                if (toolEvents.length >= budgetState.maxToolCalls) {
                    const extended = maybeExtendAutonomyBudget({
                        autonomyApproved,
                        reason: 'tool-limit',
                        startedAt,
                        round,
                        toolEvents,
                        lastProgress: lastAutonomyProgress,
                        budgetState,
                        extensionBudget: autonomyExtensionBudget,
                        executionTrace,
                    });

                    if (extended) {
                        continue;
                    }

                    executionTrace.push(createExecutionTraceEntry({
                        type: 'budget',
                        name: 'Autonomous execution tool budget reached',
                        details: {
                            round,
                            maxRounds: budgetState.maxRounds,
                            toolCalls: toolEvents.length,
                            maxToolCalls: budgetState.maxToolCalls,
                            elapsedMs: Date.now() - startedAt,
                            maxDurationMs: (autonomyApproved || hasCustomToolBudget) ? Math.max(0, budgetState.autonomyDeadline - startedAt) : 0,
                            extensionsUsed: budgetState.extensionsUsed,
                            maxExtensions: autonomyExtensionBudget.maxUses || 0,
                        },
                    }));
                    break;
                }

                round += 1;
                let nextPlan = [];
                let planSource = 'none';
                const planningStartedAt = new Date().toISOString();

                if (endToEndWorkflow) {
                    endToEndWorkflow = evaluateEndToEndBuilderWorkflow({
                        workflow: endToEndWorkflow,
                        toolPolicy,
                        remoteToolId: toolPolicy.preferredRemoteToolId,
                        deployDefaults: typeof settingsController.getEffectiveDeployConfig === 'function'
                            ? settingsController.getEffectiveDeployConfig()
                            : {},
                    });
                    toolPolicy.workflow = endToEndWorkflow;
                    activeProjectPlan = advanceForegroundProjectPlan({
                        projectPlan: activeProjectPlan,
                        workflow: endToEndWorkflow,
                    });
                    toolPolicy.projectPlan = activeProjectPlan;

                    if (endToEndWorkflow?.status === 'blocked') {
                        executionTrace.push(createExecutionTraceEntry({
                            type: 'workflow',
                            name: `Workflow blocked before round ${round}`,
                            status: 'error',
                            details: {
                                lane: endToEndWorkflow.lane,
                                stage: endToEndWorkflow.stage,
                                error: endToEndWorkflow.lastError || null,
                            },
                        }));
                        break;
                    }
                }

                if (forcedRecoveryPlan.length > 0) {
                    nextPlan = forcedRecoveryPlan;
                    forcedRecoveryPlan = [];
                    runtimeMode = 'recovered-tools';
                    planSource = 'deterministic-recovery';
                }

                if (nextPlan.length === 0 && round === 1) {
                    const directAction = this.buildDirectAction({
                        objective,
                        session,
                        recentMessages: resolvedRecentMessages,
                        toolPolicy,
                        toolContext,
                        toolEvents,
                    });

                    if (directAction) {
                        runtimeMode = 'direct-tool';
                        nextPlan = [directAction];
                        planSource = 'direct';
                    }
                }

                if (nextPlan.length === 0 && endToEndWorkflow) {
                    nextPlan = buildEndToEndWorkflowPlan({
                        workflow: endToEndWorkflow,
                        toolPolicy,
                        remoteToolId: toolPolicy.preferredRemoteToolId,
                        deployDefaults: typeof settingsController.getEffectiveDeployConfig === 'function'
                            ? settingsController.getEffectiveDeployConfig()
                            : {},
                    });
                    if (nextPlan.length > 0) {
                        runtimeMode = 'workflow-tools';
                        planSource = 'workflow';
                    }
                }

                if (nextPlan.length === 0 && toolPolicy.candidateToolIds.length > 0) {
                    nextPlan = await this.planToolUse({
                        objective,
                        instructions: effectiveInstructions,
                        contextMessages: resolvedContextMessages,
                        recentMessages: resolvedRecentMessages,
                        session,
                        toolContext,
                        executionProfile: resolvedProfile,
                        toolPolicy,
                        model,
                        reasoningEffort,
                        taskType,
                        toolEvents,
                        autonomyApproved,
                    });
                    if (nextPlan.length > 0 && runtimeMode === 'plain') {
                        runtimeMode = 'planned-tools';
                    }
                    if (nextPlan.length > 0) {
                        planSource = 'planned';
                    }
                }

                const repeatedPlanReport = filterRepeatedPlanStepsWithReport(nextPlan, executedStepSignatures, executedStepSignatureCounts);
                nextPlan = repeatedPlanReport.accepted;
                for (const rejectedStep of repeatedPlanReport.rejected) {
                    harnessRun.recordBlocker({
                        type: 'repeated_tool_signature',
                        reason: 'A planned tool call repeated a prior signature without intervening state change.',
                        round,
                        tool: rejectedStep.step?.tool || null,
                        signature: rejectedStep.signature,
                    });
                }
                if (repeatedPlanReport.rejected.length > 0) {
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'harness',
                        name: `Repeated plan steps blocked in round ${round}`,
                        status: 'error',
                        details: {
                            round,
                            harnessDecision: 'blocked',
                            completionStatus: harnessRun.getUnmetCriteria().length > 0 ? 'incomplete' : 'unknown',
                            recoveryType: null,
                            stateChanged: false,
                            blocked: repeatedPlanReport.rejected.map((entry) => ({
                                tool: entry.step?.tool || '',
                                reason: entry.step?.reason || '',
                                signature: entry.signature,
                            })),
                        },
                    }));
                }

                if (autonomyApproved) {
                    const guidedRemotePlan = filterRepeatedPlanSteps(
                        buildRemoteFollowupPlanFromToolEvents({
                            objective,
                            instructions,
                            executionProfile: resolvedProfile,
                            toolPolicy,
                            toolEvents,
                        }),
                        executedStepSignatures,
                        executedStepSignatureCounts,
                    );

                    if (guidedRemotePlan.length > 0
                        && (nextPlan.length === 0 || shouldPreferRemoteFollowupPlan(toolEvents))) {
                        nextPlan = guidedRemotePlan;
                        runtimeMode = 'guided-tools';
                        planSource = 'guided-remote';
                    }
                }

                if (!autonomyApproved && nextPlan.length === 0) {
                    const guidedResearchPlan = filterRepeatedPlanSteps(
                        buildResearchFollowupPlanFromToolEvents({
                            objective,
                            toolPolicy,
                            toolEvents,
                        }),
                        executedStepSignatures,
                        executedStepSignatureCounts,
                    );

                    if (guidedResearchPlan.length > 0) {
                        nextPlan = guidedResearchPlan;
                        runtimeMode = 'guided-tools';
                        planSource = 'guided-research';
                    }
                }

                if (nextPlan.length === 0) {
                    const guidedDesignPlan = filterRepeatedPlanSteps(
                        buildDesignResourceFollowupPlanFromToolEvents({
                            objective,
                            toolPolicy,
                            toolEvents,
                        }),
                        executedStepSignatures,
                        executedStepSignatureCounts,
                    );

                    if (guidedDesignPlan.length > 0) {
                        nextPlan = guidedDesignPlan;
                        runtimeMode = 'guided-tools';
                        planSource = 'guided-design';
                    }
                }

                if (nextPlan.length === 0) {
                    const guidedDocumentPlan = filterRepeatedPlanSteps(
                        buildDocumentWorkflowFollowupPlanFromToolEvents({
                            objective,
                            toolPolicy,
                            toolEvents,
                            clientSurface,
                        }),
                        executedStepSignatures,
                        executedStepSignatureCounts,
                    );

                    if (guidedDocumentPlan.length > 0) {
                        nextPlan = guidedDocumentPlan;
                        runtimeMode = 'guided-tools';
                        planSource = 'guided-document';
                    }
                }

                if (autonomyApproved && nextPlan.length > 0) {
                    const remainingToolBudget = Math.max(0, budgetState.maxToolCalls - toolEvents.length);
                    nextPlan = nextPlan.slice(0, remainingToolBudget);
                }

                if (config.runtime?.remoteBuildGenericFallbackSingleUseStop !== false
                    && autonomyApproved
                    && nextPlan.length > 0
                    && nextPlan.every((step) => isGenericRemoteFallbackStep(step))
                    && toolEvents.some((event) => isGenericRemoteFallbackStep({
                        tool: event?.toolCall?.function?.name || event?.result?.toolId || '',
                        reason: event?.reason || '',
                    }))) {
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'planning',
                        name: `Stop repeated generic fallback after round ${round}`,
                        details: {
                            round,
                            reason: 'A generic remote fallback step already succeeded earlier in this run.',
                        },
                    }));
                    nextPlan = [];
                }

                if (nextPlan.length > 0) {
                    const remainingToolBudget = Math.max(0, budgetState.maxToolCalls - toolEvents.length);
                    nextPlan = nextPlan.slice(0, remainingToolBudget);
                }

                executionTrace.push(createExecutionTraceEntry({
                    type: 'planning',
                    name: `Plan round ${round}`,
                    startedAt: planningStartedAt,
                    endedAt: new Date().toISOString(),
                    details: {
                        round,
                        autonomyApproved,
                        stepCount: nextPlan.length,
                        steps: nextPlan.map((step) => ({
                            tool: step.tool,
                            reason: step.reason,
                        })),
                    },
                }));
                harnessRun.recordPlan({ round, steps: nextPlan, source: planSource });
                refreshHarnessMetadata();

                if (nextPlan.length === 0) {
                    const noToolCompletionReview = harnessRun.reviewCompletion({
                        noToolPath: true,
                        canContinue: false,
                    });
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'review',
                        name: `Completion review ${round}`,
                        details: {
                            round,
                            harnessDecision: noToolCompletionReview.decision,
                            completionStatus: noToolCompletionReview.completionStatus,
                            finishConfidence: noToolCompletionReview.finishConfidence,
                            finishReason: noToolCompletionReview.finishReason,
                            unmetCriteria: noToolCompletionReview.unmetCriteria,
                            stateChanged: false,
                        },
                    }));
                    refreshHarnessMetadata(noToolCompletionReview.decision, noToolCompletionReview.finishReason);
                    break;
                }

                if ((autonomyApproved || hasCustomToolBudget) && Date.now() >= budgetState.autonomyDeadline) {
                    const extended = maybeExtendAutonomyBudget({
                        autonomyApproved,
                        reason: 'time-limit-after-planning',
                        startedAt,
                        round,
                        toolEvents,
                        lastProgress: lastAutonomyProgress,
                        budgetState,
                        extensionBudget: autonomyExtensionBudget,
                        executionTrace,
                    });

                    if (extended) {
                        round -= 1;
                        continue;
                    }

                    executionTrace.push(createExecutionTraceEntry({
                        type: 'budget',
                        name: 'Autonomous execution time budget reached',
                        details: {
                            round,
                            phase: 'after-planning',
                            pendingPlanSteps: nextPlan.length,
                            maxRounds: budgetState.maxRounds,
                            toolCalls: toolEvents.length,
                            maxToolCalls: budgetState.maxToolCalls,
                            elapsedMs: Date.now() - startedAt,
                            maxDurationMs: Math.max(0, budgetState.autonomyDeadline - startedAt),
                            extensionsUsed: budgetState.extensionsUsed,
                            maxExtensions: autonomyExtensionBudget.maxUses || 0,
                        },
                    }));
                    break;
                }

                publishProgress({
                    phase: 'planning',
                    detail: nextPlan.length === 1
                        ? 'A next step is ready. Starting it now.'
                        : `A ${nextPlan.length}-step pass is ready. Starting it now.`,
                    planOverride: nextPlan,
                    activePlanIndex: 0,
                    completedPlanSteps: 0,
                    estimated: !activeProjectPlan && !endToEndWorkflow,
                    source: 'tool-plan',
                });
                plan.push(...nextPlan);
                const executionStartedAt = new Date().toISOString();

                const {
                    toolEvents: roundToolEvents,
                    budgetExceeded,
                } = await this.executePlan({
                    plan: nextPlan,
                    toolManager: runtimeToolManager,
                    sessionId,
                    executionProfile: resolvedProfile,
                    toolPolicy,
                    toolContext,
                    objective,
                    session,
                    recentMessages: resolvedRecentMessages,
                    previousToolEvents: toolEvents,
                    autonomyDeadline: (autonomyApproved || hasCustomToolBudget) ? budgetState.autonomyDeadline : null,
                    executionTrace,
                    round,
                    harnessRun,
                    onProgress: (progress) => publishProgress({
                        ...progress,
                        planOverride: progress.plan,
                        estimated: !activeProjectPlan && !endToEndWorkflow,
                        source: 'tool-plan',
                    }),
                });

                toolEvents.push(...roundToolEvents);
                recordExecutedStepSignatures(roundToolEvents, executedStepSignatures, executedStepSignatureCounts);

                const roundFailureSummary = summarizeRoundFailures(roundToolEvents, resolvedProfile);
                const roundFailed = roundFailureSummary.anyFailed;
                const blockingRoundFailure = roundFailureSummary.blockingFailures.length > 0;
                const roundStateChanged = roundToolEvents.some((event) => doesToolEventChangeState(event));
                const roundProgressMade = roundToolEvents.some((event) => event?.result?.success !== false);
                lastAutonomyProgress = summarizeAutonomyProgress(roundToolEvents, roundFailureSummary);
                executionTrace.push(createExecutionTraceEntry({
                    type: 'execution',
                    name: `Execution round ${round}`,
                    startedAt: executionStartedAt,
                    endedAt: new Date().toISOString(),
                    status: roundFailed ? 'error' : 'completed',
                    details: {
                        round,
                        plannedToolCalls: nextPlan.length,
                        toolCalls: roundToolEvents.length,
                        skippedPlannedSteps: Math.max(0, nextPlan.length - roundToolEvents.length),
                        failed: roundFailed,
                        budgetExceeded,
                        blockingFailure: blockingRoundFailure,
                        stateChanged: roundStateChanged,
                        tools: roundToolEvents.map((event) => ({
                            tool: event?.toolCall?.function?.name || '',
                            success: event?.result?.success !== false,
                            reason: event?.reason || '',
                            error: event?.result?.error || null,
                        })),
                        failures: roundFailureSummary.failures.map((failure) => ({
                            tool: failure.toolId,
                            error: failure.error || null,
                            blocking: failure.blocking,
                            category: failure.category,
                        })),
                    },
                }));

                if (endToEndWorkflow && roundToolEvents.length > 0) {
                    endToEndWorkflow = advanceEndToEndBuilderWorkflow({
                        workflow: endToEndWorkflow,
                        toolEvents: roundToolEvents,
                    });
                    activeProjectPlan = advanceForegroundProjectPlan({
                        projectPlan: activeProjectPlan,
                        workflow: endToEndWorkflow,
                    });
                    toolPolicy.projectPlan = activeProjectPlan;

                    if (endToEndWorkflow) {
                        executionTrace.push(createExecutionTraceEntry({
                            type: 'workflow',
                            name: `Workflow state after round ${round}`,
                            details: {
                                lane: endToEndWorkflow.lane,
                                stage: endToEndWorkflow.stage,
                                status: endToEndWorkflow.status,
                                progress: endToEndWorkflow.progress,
                            },
                        }));
                    }

                    if (endToEndWorkflow?.status === 'completed') {
                        executionTrace.push(createExecutionTraceEntry({
                            type: 'workflow',
                            name: `Workflow completed after round ${round}`,
                            details: {
                                lane: endToEndWorkflow.lane,
                                stage: endToEndWorkflow.stage,
                            },
                        }));
                        break;
                    }

                    if (endToEndWorkflow?.status === 'blocked') {
                        executionTrace.push(createExecutionTraceEntry({
                            type: 'workflow',
                            name: `Workflow blocked after round ${round}`,
                            details: {
                                lane: endToEndWorkflow.lane,
                                stage: endToEndWorkflow.stage,
                                error: endToEndWorkflow.lastError || null,
                            },
                        }));
                        break;
                    }
                }

                if (!endToEndWorkflow && roundToolEvents.length > 0) {
                    activeProjectPlan = advanceForegroundProjectPlan({
                        projectPlan: activeProjectPlan,
                        toolEvents: roundToolEvents,
                    });
                    toolPolicy.projectPlan = activeProjectPlan;
                }
                publishProgress({
                    phase: blockingRoundFailure
                        ? 'blocked'
                        : (roundFailed ? 'planning' : 'executing'),
                    detail: blockingRoundFailure
                        ? (roundFailureSummary.blockingFailures[0]?.error || 'A blocking step failed. Adjusting the plan may be required.')
                        : (lastAutonomyProgress || (roundFailed
                            ? 'Some steps failed, so the next pass may change.'
                            : `Completed round ${round}.`)),
                });

                if (autonomyApproved && budgetExceeded) {
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'budget',
                        name: 'Autonomous execution time budget reached',
                        details: {
                            round,
                            phase: 'during-round',
                            maxRounds: budgetState.maxRounds,
                            toolCalls: toolEvents.length,
                            maxToolCalls: budgetState.maxToolCalls,
                            elapsedMs: Date.now() - startedAt,
                            maxDurationMs: Math.max(0, budgetState.autonomyDeadline - startedAt),
                            skippedPlannedSteps: Math.max(0, nextPlan.length - roundToolEvents.length),
                            extensionsUsed: budgetState.extensionsUsed,
                            maxExtensions: autonomyExtensionBudget.maxUses || 0,
                        },
                    }));
                    break;
                }

                if (autonomyApproved && roundFailed && !blockingRoundFailure) {
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'replan',
                        name: `Recoverable remote failure after round ${round}`,
                        details: {
                            round,
                            failures: roundFailureSummary.recoverableFailures.map((failure) => ({
                                tool: failure.toolId,
                                error: failure.error || null,
                            })),
                            recoveryType: 'model-or-deterministic',
                        },
                    }));
                    const deterministicRecoveryPlan = filterRepeatedPlanSteps(
                        buildDeterministicRecoveryPlanFromFailure({
                            objective,
                            executionProfile: resolvedProfile,
                            toolPolicy,
                            toolEvents,
                            recentMessages: resolvedRecentMessages,
                            session,
                        }),
                        executedStepSignatures,
                        executedStepSignatureCounts,
                    );
                    if (deterministicRecoveryPlan.length > 0) {
                        forcedRecoveryPlan = deterministicRecoveryPlan;
                        harnessRun.recordRecoveryAttempt({
                            type: 'deterministic-recovery',
                            round,
                            tool: deterministicRecoveryPlan[0]?.tool || null,
                            reason: deterministicRecoveryPlan[0]?.reason || 'Deterministic recovery plan selected.',
                            signature: normalizeStepSignature(deterministicRecoveryPlan[0]),
                            outcome: 'planned',
                        });
                        executionTrace.push(createExecutionTraceEntry({
                            type: 'harness',
                            name: `Deterministic recovery selected after round ${round}`,
                            details: {
                                round,
                                harnessDecision: 'continue',
                                completionStatus: harnessRun.getUnmetCriteria().length > 0 ? 'incomplete' : 'unknown',
                                recoveryType: 'deterministic',
                                stateChanged: false,
                                stepCount: deterministicRecoveryPlan.length,
                                steps: deterministicRecoveryPlan.map((step) => ({
                                    tool: step.tool,
                                    reason: step.reason,
                                })),
                            },
                        }));
                    }
                }

                if (roundToolEvents.some((event) => isTerminalWorkloadCreationEvent(event))) {
                    runtimeMode = runtimeMode || 'direct-tool';
                    refreshHarnessMetadata('synthesize', 'A terminal tool result completed the requested work.');
                    const terminalOutput = buildTerminalWorkloadCreationOutput(roundToolEvents);
                    finalResponse = this.withResponseMetadata(buildSyntheticResponse({
                        output: terminalOutput,
                        responseId: `resp_workload_${Date.now()}`,
                        model: model || null,
                        metadata: {
                            terminalWorkloadCreation: true,
                            toolEvents,
                        },
                    }), {
                        executionProfile: resolvedProfile,
                        runtimeMode,
                        toolEvents,
                        toolPolicy,
                        autonomyApproved,
                        executionTrace,
                    });
                    output = extractResponseText(finalResponse);
                    return this.completeConversationRun({
                        sessionId,
                        ownerId,
                        userText: rawObjective,
                        objective,
                        taskType,
                        executionProfile: resolvedProfile,
                        runtimeMode,
                        toolPolicy,
                        toolEvents,
                        output,
                        finalResponse,
                        startedAt,
                        metadata,
                        foregroundTurn,
                        clientSurface,
                        memoryKeywords,
                        memoryTrace,
                        autonomyApproved,
                        executionTrace,
                        stream,
                        controlStatePatch: {
                            ...foregroundContinuationGatePatch,
                            ...(activeProjectPlan ? { projectPlan: activeProjectPlan } : {}),
                        },
                    });
                }

                const legacyRoundReview = reviewExecutionRound({
                    round,
                    nextPlan,
                    roundToolEvents,
                    roundFailureSummary,
                    autonomyApproved,
                    budgetExceeded,
                    toolPolicy,
                    endToEndWorkflow,
                });
                const hasGuardedCompletionBudget = !autonomyApproved
                    && toolEvents.length < budgetState.maxToolCalls
                    && round < budgetState.maxRounds
                    && (
                        hasExplicitWebResearchIntentText(objective)
                        || hasCurrentInfoIntentText(objective)
                        || hasDocumentWorkflowIntentText(objective)
                        || toolPolicy?.projectPlan?.status === 'active'
                        || toolPolicy?.workflow?.status === 'active'
                    );
                const completionReview = harnessRun.reviewCompletion({
                    budgetExceeded,
                    blocking: blockingRoundFailure,
                    stateChanged: roundStateChanged,
                    progressMade: roundProgressMade,
                    canContinue: (autonomyApproved || hasGuardedCompletionBudget)
                        && toolEvents.length < budgetState.maxToolCalls
                        && round < budgetState.maxRounds,
                });
                const shouldContinueGuardedCompletion = shouldAllowGuardedCompletionContinuation({
                    objective,
                    toolPolicy,
                    completionReview,
                    autonomyApproved,
                    blocking: blockingRoundFailure,
                    budgetExceeded,
                    round,
                    budgetState,
                });
                const suggestedRoundDecision = forcedRecoveryPlan.length > 0
                    ? 'continue'
                    : (['blocked', 'checkpoint'].includes(completionReview.decision)
                        ? completionReview.decision
                        : (completionReview.decision === 'continue'
                            ? 'continue'
                            : null)
                        || legacyRoundReview?.decision
                        || (planSource === 'deterministic-recovery' && !roundFailed
                            ? 'synthesize'
                            : null)
                        || (autonomyApproved && !blockingRoundFailure && roundToolEvents.length > 0
                            ? 'continue'
                            : 'synthesize'));
                const suggestedRoundReason = forcedRecoveryPlan.length > 0
                    ? 'A deterministic recovery step is ready for the next pass.'
                    : (['blocked', 'checkpoint', 'continue'].includes(completionReview.decision)
                        ? completionReview.finishReason
                        : null)
                        || legacyRoundReview?.reason
                        || (planSource === 'deterministic-recovery' && !roundFailed
                            ? 'Deterministic recovery succeeded; synthesize the result.'
                            : null)
                        || (autonomyApproved && !blockingRoundFailure && roundToolEvents.length > 0
                            ? 'Continue guarded autonomous work while tool progress is available.'
                            : 'Synthesize after the completed round.');
                const roundReview = harnessRun.reviewRound({
                    round,
                    roundToolEvents,
                    roundFailureSummary,
                    budgetExceeded,
                    suggestedDecision: suggestedRoundDecision,
                    suggestedReason: suggestedRoundReason,
                    productive: lastAutonomyProgress?.productive === true,
                    terminalSuccess: roundToolEvents.some((event) => isTerminalWorkloadCreationEvent(event)),
                    hasDeterministicRecovery: forcedRecoveryPlan.length > 0,
                });
                refreshHarnessMetadata(roundReview.decision, roundReview.reason);
                if (roundReview) {
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'review',
                        name: `Round review ${round}`,
                        details: {
                            round,
                            decision: roundReview.decision,
                            harnessDecision: roundReview.decision,
                            reason: roundReview.reason,
                            replanReason: roundReview.decision === 'replan' ? roundReview.reason : null,
                            completionStatus: completionReview.completionStatus,
                            finishConfidence: completionReview.finishConfidence,
                            finishReason: completionReview.finishReason,
                            unmetCriteria: completionReview.unmetCriteria,
                            recoveryType: forcedRecoveryPlan.length > 0
                                ? 'deterministic'
                                : (roundReview.decision === 'replan' ? 'model-replan' : null),
                            stateChanged: roundStateChanged,
                            productive: lastAutonomyProgress?.productive === true,
                            toolCalls: roundToolEvents.length,
                        },
                    }));

                    const harnessControlsRound = isJudgmentV2Enabled()
                        || forcedRecoveryPlan.length > 0
                        || roundFailed
                        || budgetExceeded
                        || roundToolEvents.length === 0
                        || planSource === 'deterministic-recovery';

                    if (harnessControlsRound) {
                        if (roundReview.decision === 'replan') {
                            continue;
                        }

                        if (roundReview.decision === 'continue') {
                            continue;
                        }

                        if (['synthesize', 'checkpoint', 'blocked'].includes(roundReview.decision)) {
                            break;
                        }
                    }
                }

                if (!isJudgmentV2Enabled()) {
                    if (shouldContinueGuardedCompletion) {
                        continue;
                    }

                    if (autonomyApproved
                        && planSource === 'guided-remote'
                        && !roundFailed
                        && !blockingRoundFailure) {
                        const pendingGuidedRemotePlan = filterRepeatedPlanSteps(
                            buildRemoteFollowupPlanFromToolEvents({
                                objective,
                                instructions,
                                executionProfile: resolvedProfile,
                                toolPolicy,
                                toolEvents,
                            }),
                            executedStepSignatures,
                            executedStepSignatureCounts,
                        );

                        if (pendingGuidedRemotePlan.length === 0
                            && !planSignalsFurtherAutonomousWork(nextPlan)) {
                            executionTrace.push(createExecutionTraceEntry({
                                type: 'planning',
                                name: `Stop after guided remote round ${round}`,
                                details: {
                                    round,
                                    reason: 'A deterministic remote follow-up succeeded and no further guided remote step remains.',
                                },
                            }));
                            break;
                        }
                    }

                    if (autonomyApproved
                        && autonomyApprovalSource === 'config'
                        && config.runtime?.remoteBuildConfigDefaultSingleRoundStop === true
                        && !roundFailed
                        && !blockingRoundFailure
                        && roundToolEvents.length > 0
                        && !planSignalsFurtherAutonomousWork(nextPlan)) {
                        executionTrace.push(createExecutionTraceEntry({
                            type: 'planning',
                            name: `Stop after round ${round}`,
                            details: {
                                round,
                                reason: 'Config-default autonomy should not keep looping after a successful round unless the plan itself signals more follow-up work.',
                            },
                            }));
                        break;
                    }

                    if (!autonomyApproved || blockingRoundFailure || roundToolEvents.length === 0) {
                        break;
                    }
                }
            }

            const latestBudgetTrace = [...executionTrace].reverse()
                .find((entry) => entry?.type === 'budget' && /budget reached/i.test(String(entry?.name || '')));
            if (latestBudgetTrace && !['blocked', 'checkpoint', 'synthesize'].includes(toolPolicy?.harness?.decision)) {
                const budgetCompletionReview = harnessRun.reviewCompletion({
                    budgetExceeded: true,
                    canContinue: false,
                });
                executionTrace.push(createExecutionTraceEntry({
                    type: 'review',
                    name: 'Completion review after budget stop',
                    details: {
                        harnessDecision: budgetCompletionReview.decision,
                        completionStatus: budgetCompletionReview.completionStatus,
                        finishConfidence: budgetCompletionReview.finishConfidence,
                        finishReason: budgetCompletionReview.finishReason,
                        unmetCriteria: budgetCompletionReview.unmetCriteria,
                        stateChanged: false,
                    },
                }));
                refreshHarnessMetadata('checkpoint', latestBudgetTrace.name || 'Guarded autonomy budget reached.');
            } else {
                refreshHarnessMetadata(
                    toolPolicy?.harness?.decision === 'blocked' || toolPolicy?.harness?.decision === 'checkpoint'
                        ? toolPolicy.harness.decision
                        : 'synthesize',
                    toolPolicy?.harness?.decisionReason || 'Final response synthesis is the next harness action.',
                );
            }

            if (endToEndWorkflow?.status === 'blocked') {
                runtimeMode = 'workflow-blocked';
                refreshHarnessMetadata('blocked', endToEndWorkflow.lastError || 'The active workflow is blocked.');
                const blockedOutput = [
                    buildEndToEndWorkflowBlockedOutput(endToEndWorkflow),
                    toolEvents.length > 0
                        ? buildFallbackSynthesisText({ objective, toolEvents })
                        : '',
                ].filter(Boolean).join('\n\n');
                finalResponse = this.withResponseMetadata(buildSyntheticResponse({
                    output: blockedOutput,
                    responseId: `resp_workflow_blocked_${Date.now()}`,
                    model: model || null,
                    metadata: {
                        workflowBlocked: true,
                        toolEvents,
                    },
                }), {
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolEvents,
                    toolPolicy,
                    autonomyApproved,
                    executionTrace,
                });
                output = extractResponseText(finalResponse);

                return this.completeConversationRun({
                    sessionId,
                    ownerId,
                    userText: rawObjective,
                    objective,
                    taskType,
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolPolicy,
                    toolEvents,
                    output,
                    finalResponse,
                    startedAt,
                    metadata,
                    foregroundTurn,
                    clientSurface,
                    memoryKeywords,
                    memoryTrace,
                    autonomyApproved,
                    executionTrace,
                    stream,
                    controlStatePatch: {
                        workflow: endToEndWorkflow,
                        ...foregroundContinuationGatePatch,
                        ...(activeProjectPlan ? { projectPlan: activeProjectPlan } : {}),
                    },
                });
            }

            if (autonomyContinuationDecision === 'stop') {
                runtimeMode = 'checkpoint-stop';
                executionTrace.push(createExecutionTraceEntry({
                    type: 'checkpoint',
                    name: 'Autonomy continuation declined',
                    details: {
                        source: 'user-checkpoint',
                    },
                }));
                finalResponse = this.withResponseMetadata(buildSyntheticResponse({
                    output: 'Paused here. Say continue when you want me to keep going.',
                    responseId: `resp_pause_${Date.now()}`,
                    model: model || null,
                    metadata: {
                        autonomyContinuationDeclined: true,
                        toolEvents,
                    },
                }), {
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolEvents,
                    toolPolicy,
                    autonomyApproved,
                    executionTrace,
                });
                output = extractResponseText(finalResponse);

                return this.completeConversationRun({
                    sessionId,
                    ownerId,
                    userText: rawObjective,
                    objective,
                    taskType,
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolPolicy,
                    toolEvents,
                    output,
                    finalResponse,
                    startedAt,
                    metadata,
                    foregroundTurn,
                    clientSurface,
                    memoryKeywords,
                    memoryTrace,
                    autonomyApproved,
                    executionTrace,
                    stream,
                    controlStatePatch: foregroundContinuationGatePatch,
                });
            }

            const canOfferAutonomyContinuationCheckpoint = resolvedProfile === REMOTE_BUILD_EXECUTION_PROFILE
                && config.runtime?.remoteBuildContinuationCheckpointEnabled === true
                && findLatestExecutionTraceEntry(executionTrace, 'Autonomous execution time budget reached')
                && toolPolicy.allowedToolIds.includes(USER_CHECKPOINT_TOOL_ID)
                && toolPolicy.userCheckpointPolicy?.enabled === true
                && Number(toolPolicy.userCheckpointPolicy?.remaining || 0) > 0
                && !toolPolicy.userCheckpointPolicy?.pending;

            if (canOfferAutonomyContinuationCheckpoint) {
                runtimeMode = 'budget-checkpoint';
                const continuationCheckpoint = buildAutonomyContinuationCheckpoint({
                    toolEvents,
                    workflow: endToEndWorkflow,
                    projectPlan: activeProjectPlan,
                });
                const responseToolEvents = [
                    ...toolEvents,
                    continuationCheckpoint.toolEvent,
                ];
                executionTrace.push(createExecutionTraceEntry({
                    type: 'checkpoint',
                    name: 'Autonomy continuation checkpoint created',
                    details: {
                        checkpointId: continuationCheckpoint.checkpoint.id,
                    },
                }));
                finalResponse = this.withResponseMetadata(buildSyntheticResponse({
                    output: continuationCheckpoint.output,
                    responseId: `resp_budget_checkpoint_${Date.now()}`,
                    model: model || null,
                    metadata: {
                        autonomyContinuationCheckpoint: true,
                        toolEvents: responseToolEvents,
                    },
                }), {
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolEvents: responseToolEvents,
                    toolPolicy,
                    autonomyApproved,
                    executionTrace,
                });
                output = extractResponseText(finalResponse);

                return this.completeConversationRun({
                    sessionId,
                    ownerId,
                    userText: rawObjective,
                    objective,
                    taskType,
                    executionProfile: resolvedProfile,
                    runtimeMode,
                    toolPolicy,
                    toolEvents: responseToolEvents,
                    output,
                    finalResponse,
                    startedAt,
                    metadata,
                    foregroundTurn,
                    clientSurface,
                    memoryKeywords,
                    memoryTrace,
                    autonomyApproved,
                    executionTrace,
                    stream,
                    controlStatePatch: {
                        ...(endToEndWorkflow ? { workflow: endToEndWorkflow } : {}),
                        ...foregroundContinuationGatePatch,
                        ...(activeProjectPlan ? { projectPlan: activeProjectPlan } : {}),
                    },
                });
            }

            publishProgress({
                phase: 'finalizing',
                detail: toolEvents.length > 0
                    ? 'Writing the final response from the completed work.'
                    : 'Writing the response.',
            });
            const finalResponseStartedAt = new Date().toISOString();
            finalResponse = await this.buildFinalResponse({
                input: transcriptObjective.usedTranscriptContext ? objective : input,
                objective,
                instructions: effectiveInstructions,
                contextMessages: resolvedContextMessages,
                recentMessages: resolvedRecentMessages,
                model,
                reasoningEffort,
                signal,
                taskType,
                executionProfile: resolvedProfile,
                toolPolicy,
                toolEvents,
                runtimeMode,
                autonomyApproved,
                executionTrace,
                clientSurface,
            });
            traceModelResponse(finalResponse, toolEvents.length > 0 ? 'tool-synthesis' : 'direct-response', finalResponseStartedAt);

            output = extractResponseText(finalResponse);
            if (canRecoverFromInvalidRuntimeResponse({ output, toolEvents, toolPolicy })) {
                const previousInvalidOutput = output;
                const leakedPayloadRecoveryPlan = buildRecoveryPlanFromLeakedRemoteCommandPayload(previousInvalidOutput, toolPolicy);
                const recoveryPlan = leakedPayloadRecoveryPlan.length > 0
                    ? leakedPayloadRecoveryPlan
                    : this.buildFallbackPlan({
                        objective,
                        session,
                        toolContext,
                        executionProfile: resolvedProfile,
                        toolPolicy,
                        toolEvents,
                        model,
                    });
                const filteredRecoveryPlan = filterRepeatedPlanSteps(
                    recoveryPlan,
                    executedStepSignatures,
                    executedStepSignatureCounts,
                );

                if (filteredRecoveryPlan.length > 0) {
                    runtimeMode = 'recovered-tools';
                    const recoveryPlanningStartedAt = new Date().toISOString();
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'planning',
                        name: 'Recovery plan',
                        startedAt: recoveryPlanningStartedAt,
                        endedAt: new Date().toISOString(),
                        details: {
                            invalidModelResponse: true,
                            stepCount: filteredRecoveryPlan.length,
                            steps: filteredRecoveryPlan.map((step) => ({
                                tool: step.tool,
                                reason: step.reason,
                            })),
                        },
                    }));
                    publishProgress({
                        phase: 'planning',
                        detail: 'Repairing the workflow after an invalid draft.',
                        planOverride: filteredRecoveryPlan,
                        activePlanIndex: 0,
                        completedPlanSteps: 0,
                        estimated: false,
                        source: 'tool-plan',
                    });

                    const recoveryExecutionStartedAt = new Date().toISOString();
                    const {
                        toolEvents: recoveryToolEvents,
                    } = await this.executePlan({
                        plan: filteredRecoveryPlan,
                        toolManager: runtimeToolManager,
                        sessionId,
                        executionProfile: resolvedProfile,
                        toolPolicy,
                        toolContext,
                        objective,
                        session,
                        recentMessages: resolvedRecentMessages,
                        executionTrace,
                        harnessRun,
                        onProgress: (progress) => publishProgress({
                            ...progress,
                            planOverride: progress.plan,
                            estimated: false,
                            source: 'tool-plan',
                        }),
                    });
                    toolEvents.push(...recoveryToolEvents);
                    recordExecutedStepSignatures(recoveryToolEvents, executedStepSignatures, executedStepSignatureCounts);
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'execution',
                        name: 'Recovery execution',
                        startedAt: recoveryExecutionStartedAt,
                        endedAt: new Date().toISOString(),
                        status: recoveryToolEvents.some((event) => event?.result?.success === false) ? 'error' : 'completed',
                        details: {
                            toolCalls: recoveryToolEvents.length,
                            tools: recoveryToolEvents.map((event) => ({
                                tool: event?.toolCall?.function?.name || '',
                                success: event?.result?.success !== false,
                                error: event?.result?.error || null,
                            })),
                        },
                    }));

                    const recoveredResponseStartedAt = new Date().toISOString();
                    runtimeMode = 'repaired-final';
                    finalResponse = await this.repairInvalidFinalResponse({
                        invalidOutput: previousInvalidOutput,
                        objective,
                        instructions,
                        contextMessages: resolvedContextMessages,
                        recentMessages: resolvedRecentMessages,
                        model,
                        reasoningEffort,
                        signal,
                        taskType,
                        executionProfile: resolvedProfile,
                        toolPolicy,
                        toolEvents,
                        runtimeMode,
                        autonomyApproved,
                        executionTrace,
                        clientSurface,
                    });
                    traceModelResponse(finalResponse, 'recovery-repair', recoveredResponseStartedAt);
                    output = extractResponseText(finalResponse);
                    executionTrace.push(createExecutionTraceEntry({
                        type: 'repair',
                        name: 'Response repair',
                        startedAt: recoveredResponseStartedAt,
                        endedAt: new Date().toISOString(),
                        details: {
                            reason: 'Recovered from an invalid runtime answer by executing deterministic tools and repairing the final response.',
                            previousOutput: truncateText(previousInvalidOutput, 800),
                        },
                    }));
                }
            }

            if (shouldRepairInvalidRuntimeResponse({ output, toolEvents, toolPolicy })) {
                runtimeMode = 'repaired-final';
                const repairStartedAt = new Date().toISOString();
                const previousInvalidOutput = output;

                finalResponse = await this.repairInvalidFinalResponse({
                    invalidOutput: previousInvalidOutput,
                    objective,
                    instructions,
                    contextMessages: resolvedContextMessages,
                    recentMessages: resolvedRecentMessages,
                    model,
                    reasoningEffort,
                    signal,
                    taskType,
                    executionProfile: resolvedProfile,
                    toolPolicy,
                    toolEvents,
                    runtimeMode,
                    autonomyApproved,
                    executionTrace,
                    clientSurface,
                });
                traceModelResponse(finalResponse, 'repair', repairStartedAt);
                output = extractResponseText(finalResponse);
                executionTrace.push(createExecutionTraceEntry({
                    type: 'repair',
                    name: 'Response repair',
                    startedAt: repairStartedAt,
                    endedAt: new Date().toISOString(),
                    details: {
                        reason: 'Invalid tool-availability claim after verified tool execution',
                        previousOutput: truncateText(previousInvalidOutput, 800),
                    },
                }));
            }

            return this.completeConversationRun({
                sessionId,
                ownerId,
                userText: rawObjective,
                objective,
                taskType,
                executionProfile: resolvedProfile,
                runtimeMode,
                toolPolicy,
                toolEvents,
                output,
                finalResponse,
                startedAt,
                metadata,
                foregroundTurn,
                clientSurface,
                memoryKeywords,
                memoryTrace,
                autonomyApproved,
                executionTrace,
                stream,
                controlStatePatch: {
                    ...(endToEndWorkflow ? { workflow: endToEndWorkflow } : {}),
                    ...foregroundContinuationGatePatch,
                    ...(activeProjectPlan ? { projectPlan: activeProjectPlan } : {}),
                },
                naturalContext,
            });
        } catch (error) {
            this.emit('task:error', {
                task: { type: taskType, objective },
                sessionId,
                timestamp: Date.now(),
                error: error.message,
                stack: error.stack,
                metadata: {
                    ...metadata,
                    executionProfile: resolvedProfile,
                },
            });
            throw error;
        }
    }

    buildToolPolicy({
        objective = '',
        instructions = '',
        session = null,
        metadata = {},
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        toolManager = null,
        requestedToolIds = [],
        recentMessages = [],
        toolContext = {},
        classification = null,
        agencyProfile = null,
        toolEvents = [],
    }) {
        const baseAllowedToolIds = (PROFILE_TOOL_ALLOWLISTS[executionProfile] || PROFILE_TOOL_ALLOWLISTS[DEFAULT_EXECUTION_PROFILE])
            .filter((toolId) => !DISABLED_AUTONOMOUS_TOOL_IDS.has(toolId))
            .filter((toolId) => toolManager?.getTool?.(toolId));
        const requested = Array.isArray(requestedToolIds)
            ? requestedToolIds.map((toolId) => String(toolId || '').trim()).filter(Boolean)
            : [];
        const allowedToolIds = requested.length > 0
            ? baseAllowedToolIds.filter((toolId) => requested.includes(toolId))
            : baseAllowedToolIds;
        const prompt = `${objective || ''}\n${instructions || ''}`.toLowerCase();
        const hasStructuredRemoteWorkbenchIntent = /\b(remote workbench|repo-map|repo map|changed files?|grep|read file|write file|apply patch|focused test|remote build|remote test|deployment logs?|rollout|deploy verify|deployment verification)\b/.test(prompt);
        const effectiveAgencyProfile = agencyProfile || inferAgencyProfile({
            objective,
            executionProfile,
            classification,
        });
        const candidates = new Set();
        const remoteToolId = getPreferredRemoteToolId({ allowedToolIds });
        const sessionIsolation = isSessionIsolationEnabled({
            sessionIsolation: toolContext?.sessionIsolation,
            metadata,
        }, session || null);
        const projectKey = resolveProjectKey({
            ...metadata,
            ...toolContext,
            clientSurface: toolContext?.clientSurface || metadata?.clientSurface || metadata?.client_surface || '',
            memoryScope: toolContext?.memoryScope || metadata?.memoryScope || metadata?.memory_scope || '',
        }, session || null);
        const activeTaskFrame = normalizeActiveTaskFrame(getSessionControlState(session).activeTaskFrame);
        const userCheckpointPolicy = toolContext?.userCheckpointPolicy && typeof toolContext.userCheckpointPolicy === 'object'
            ? toolContext.userCheckpointPolicy
            : {};
        const subAgentDepth = Number(toolContext?.subAgentDepth || metadata?.subAgentDepth || 0);
        const canUseSubAgents = subAgentDepth < 1;
        const isSurveyResponseTurn = Boolean(parseUserCheckpointResponseMessage(objective));
        const canUseUserCheckpoint = allowedToolIds.includes(USER_CHECKPOINT_TOOL_ID)
            && userCheckpointPolicy.enabled === true
            && Number(userCheckpointPolicy.remaining || 0) > 0
            && !userCheckpointPolicy.pending
            && !isSurveyResponseTurn;
        const hasUrl = /https?:\/\//i.test(prompt);
        const hasExplicitWebResearchIntent = hasExplicitWebResearchIntentText(prompt);
        const hasExplicitScrapeIntent = /\b(scrape|extract|selector|structured|parse)\b/.test(prompt);
        const hasImageIntent = /\b(image|images|visual|visuals|illustration|illustrations|photo|photos|hero image|background image|cover image)\b/.test(prompt);
        const hasUnsplashIntent = /\bunsplash\b/.test(prompt);
        const hasImageUrlIntent = hasImageIntent && /\b(url|link)\b/.test(prompt);
        const hasDirectImageUrl = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?/i.test(prompt);
        const hasPodcastIntent = hasExplicitPodcastIntentText(prompt);
        const hasArchitectureIntent = hasArchitectureDesignIntent(prompt);
        const hasUmlIntent = hasUmlDiagramIntent(prompt);
        const hasApiIntent = hasApiDesignIntent(prompt);
        const hasSchemaIntent = hasSchemaDesignIntent(prompt);
        const hasMigrationChangeIntent = hasMigrationIntent(prompt);
        const hasSecurityIntent = hasSecurityScanIntent(prompt);
        const hasDocumentWorkflowIntent = hasDocumentWorkflowIntentText(prompt);
        const hasAssetCatalogIntent = hasIndexedAssetIntentText(prompt);
        const hasResearchBucketIntent = hasResearchBucketIntentText(prompt);
        const hasPublicSourceIndexIntent = hasPublicSourceIndexIntentText(prompt);
        const hasSubAgentIntent = hasExplicitSubAgentIntentText(prompt);
        const hasManagedAppIntent = hasManagedAppIntentText(prompt);
        const hasManagedAppAuthoringRequest = hasManagedAppAuthoringIntent(prompt, { executionProfile });
        const hasRemoteCliAgentAuthoringRequest = hasRemoteCliAgentAuthoringIntent(prompt);
        const hasManagedAppContinuationRecovery = (
            isLikelyTranscriptDependentTurn(objective)
            || /\b(?:go ahead|continue|proceed|from there|those steps|next step|next steps|get it online|get it live|get it deployed)\b/i.test(objective)
        )
            && inferManagedAppRecoveryActionFromRecentMessages(recentMessages) === 'create';
        const explicitGitIntent = /\b(git|github)\b[\s\S]{0,80}\b(status|diff|branch|stage|add|commit|push|save and push|save-and-push)\b/.test(prompt);
        const explicitK3sDeployIntent = /\b(deploy|rollout|apply|set image|update image|sync)\b[\s\S]{0,60}\b(k3s|k8s|kubernetes|kubectl|manifest|deployment|helm)\b/.test(prompt)
            || /\b(add|install|put)\b[\s\S]{0,40}\b(to|on|into|in)\b[\s\S]{0,20}\b(k3s|k8s|kubernetes|cluster)\b/.test(prompt);
        const inferredWorkload = buildCanonicalWorkloadAction({
            request: objective,
        }, {
            session,
            recentMessages,
            timezone: toolContext?.timezone
                || session?.metadata?.timezone
                || session?.metadata?.timeZone
                || getDefaultWorkloadTimezone(),
            now: toolContext?.now || null,
        });
        const hasWorkloadSetupIntent = hasWorkloadIntent(objective || '')
            || inferredWorkload?.trigger?.type === 'cron'
            || inferredWorkload?.trigger?.type === 'once';
        const isDeferredWorkloadRun = metadata?.workloadRun === true || metadata?.clientSurface === 'workload';
        const hasExplicitLocalArtifacts = hasExplicitLocalArtifactReference(objective);
        const remoteWebsiteUpdateIntent = hasRemoteWebsiteUpdateIntent(prompt);
        const hasInternalArtifactUrl = hasInternalArtifactReference(`${objective || ''}\n${instructions || ''}`);
        const shouldPreferRemoteWebsiteSource = executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
            && remoteWebsiteUpdateIntent
            && !hasExplicitLocalArtifacts;
        const sshContext = resolveSshRequestContext(objective, session);
        const hasSshDefaults = hasUsableSshDefaults();
        const hasReachableSshTarget = Boolean(hasSshDefaults || sshContext.target?.host);
        const deployDefaults = typeof settingsController.getEffectiveDeployConfig === 'function'
            ? settingsController.getEffectiveDeployConfig()
            : {};
        const shouldIncludeClusterRegistry = executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
            || hasReachableSshTarget
            || explicitK3sDeployIntent
            || /\b(ssh|server|host|cluster|k3s|k8s|kubernetes|kubectl|deployment|rollout|ingress|traefik|tls|dns)\b/.test(prompt);
        const clusterRegistrySummary = shouldIncludeClusterRegistry
            ? clusterStateRegistry.buildPromptSummary({ maxDeployments: 3, maxRecentActivity: 3 })
            : '';
        const shouldIncludeRemoteCliInventory = executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
            || hasReachableSshTarget
            || explicitK3sDeployIntent
            || hasRemoteInfraToolUsageIntent(prompt)
            || /\b(remote cli|direct cli|remote command|ssh|server|host|cluster|k3s|k8s|kubernetes|kubectl)\b/.test(prompt);
        const healthyRemoteRunner = shouldIncludeRemoteCliInventory
            ? remoteRunnerService.getHealthyRunner()
            : null;
        const remoteCliInventorySummary = shouldIncludeRemoteCliInventory
            ? summarizeRemoteRunnerCliTools(healthyRemoteRunner)
            : '';
        const managedAppsSummary = normalizeInlineText(toolContext?.managedAppsSummary || '');
        const repositoryPath = String(
            toolContext?.repositoryPath
            || config.deploy.defaultRepositoryPath
            || '',
        ).trim();
        const shouldBypassEndToEndWorkflow = shouldPreferRemoteWebsiteSource;
        const shouldUseRemoteCliAgentAuthoring = allowedToolIds.includes('remote-cli-agent')
            && hasRemoteCliAgentAuthoringRequest;
        const inferredWorkflowSeed = executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
            && !shouldBypassEndToEndWorkflow
            && !shouldUseRemoteCliAgentAuthoring
            ? inferEndToEndBuilderWorkflow({
                objective,
                session,
                workspacePath: resolvePreferredRemoteCliWorkspacePath({
                    session,
                    toolContext,
                }),
                repositoryPath,
                remoteTarget: sshContext.target || null,
                deployDefaults,
            })
            : null;
        const workflowSeed = inferredWorkflowSeed
            && (
                !['repo-only', 'repo-then-deploy'].includes(String(inferredWorkflowSeed.lane || '').trim())
                || allowedToolIds.includes(remoteToolId)
            )
            ? inferredWorkflowSeed
            : null;
        const projectPlanSeed = inferForegroundProjectPlan({
            objective,
            session,
            workflow: workflowSeed,
        });
        const rolePipelineSeed = inferAgentRolePipeline({
            objective,
            classification,
            executionProfile,
        });
        const continuationGate = normalizeForegroundContinuationGate(getSessionControlState(session).foregroundContinuationGate);
        const autonomyContinuationDecision = parseAutonomyContinuationDecision(objective);
        const shouldClearContinuationPause = autonomyContinuationDecision === 'continue'
            || (continuationGate?.paused && hasExplicitForegroundResumeIntent(objective));
        const shouldHoldForegroundWork = autonomyContinuationDecision === 'stop'
            || (continuationGate?.paused && !shouldClearContinuationPause);
        const effectiveWorkflowSeed = shouldHoldForegroundWork ? null : workflowSeed;
        const effectiveProjectPlanSeed = shouldHoldForegroundWork ? null : projectPlanSeed;
        const effectiveRolePipelineSeed = shouldHoldForegroundWork ? null : rolePipelineSeed;
        const workflowNeedsRepoLane = effectiveWorkflowSeed?.lane === 'repo-only' || effectiveWorkflowSeed?.lane === 'repo-then-deploy';
        const workflowNeedsDeployLane = effectiveWorkflowSeed?.lane === 'deploy-only' || effectiveWorkflowSeed?.lane === 'repo-then-deploy';
        const hasActiveForegroundWorkflow = effectiveWorkflowSeed?.status === 'active';
        const hasActiveForegroundProjectPlan = effectiveProjectPlanSeed?.status === 'active';
        const hasExplicitDeferredWorkloadIntent = hasWorkloadIntent(objective);
        const allowDeferredWorkloadShortcut = (
            !hasActiveForegroundWorkflow
            && !hasActiveForegroundProjectPlan
        ) || hasExplicitDeferredWorkloadIntent;
        const scoreMap = isJudgmentV2Enabled()
            ? buildScoredCandidateToolMap({
                allowedToolIds,
                classification,
                prompt,
                objective,
                executionProfile,
                remoteToolId,
                canUseSubAgents,
                canUseUserCheckpoint,
                allowDeferredWorkloadShortcut,
                hasExplicitWebResearchIntent,
                hasExplicitScrapeIntent,
                hasUrl,
                hasImageIntent,
                hasUnsplashIntent,
                hasImageUrlIntent,
                hasDirectImageUrl,
                hasAssetCatalogIntent,
                hasResearchBucketIntent,
                hasPublicSourceIndexIntent,
                hasPodcastIntent,
                hasDocumentWorkflowIntent,
                hasSubAgentIntent,
                hasManagedAppIntent: hasManagedAppIntent || hasManagedAppAuthoringRequest,
                hasRemoteCliAgentAuthoringRequest,
                explicitGitIntent,
                explicitK3sDeployIntent,
                hasWorkloadSetupIntent,
                isDeferredWorkloadRun,
                shouldPreferRemoteWebsiteSource,
                workflowNeedsRepoLane,
                workflowNeedsDeployLane,
                sessionIsolation,
                toolEvents,
                hasArchitectureIntent,
                hasUmlIntent,
                hasApiIntent,
                hasSchemaIntent,
                hasMigrationChangeIntent,
                hasSecurityIntent,
                agencyProfile: effectiveAgencyProfile,
                rolePipeline: effectiveRolePipelineSeed,
            })
            : null;

        if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE) {
            if (canUseSubAgents && hasSubAgentIntent && allowedToolIds.includes('agent-delegate')) {
                candidates.add('agent-delegate');
            }
            if (!isDeferredWorkloadRun
                && allowDeferredWorkloadShortcut
                && hasWorkloadSetupIntent
                && allowedToolIds.includes('agent-workload')) {
                candidates.add('agent-workload');
            }
            [
                'web-search',
                'tool-doc-read',
            ].forEach((toolId) => allowedToolIds.includes(toolId) && candidates.add(toolId));

            if (allowedToolIds.includes('web-fetch')
                && (hasInternalArtifactUrl
                    || !shouldPreferRemoteWebsiteSource
                    || (!hasInternalArtifactUrl && (hasUrl || hasExplicitWebResearchIntent)))) {
                candidates.add('web-fetch');
            }

            if (!shouldPreferRemoteWebsiteSource) {
                ['file-read', 'file-search'].forEach((toolId) => allowedToolIds.includes(toolId) && candidates.add(toolId));
            }

            if (remoteToolId && (sshContext.shouldTreatAsSsh || executionProfile === REMOTE_BUILD_EXECUTION_PROFILE)) {
                candidates.add(remoteToolId);
            }
            if (hasStructuredRemoteWorkbenchIntent && allowedToolIds.includes('remote-workbench')) {
                candidates.add('remote-workbench');
            }
            if ((explicitGitIntent || workflowNeedsDeployLane) && allowedToolIds.includes('git-safe')) {
                candidates.add('git-safe');
            }
            if (hasRemoteCliAgentAuthoringRequest && allowedToolIds.includes('remote-cli-agent')) {
                candidates.add('remote-cli-agent');
            }
            if ((hasManagedAppIntent || hasManagedAppAuthoringRequest || hasManagedAppContinuationRecovery)
                && allowedToolIds.includes('managed-app')) {
                candidates.add('managed-app');
            }
            if ((explicitK3sDeployIntent || workflowNeedsDeployLane) && allowedToolIds.includes('k3s-deploy')) {
                candidates.add('k3s-deploy');
            }
            if (allowedToolIds.includes('docker-exec') && /\b(docker|container)\b/i.test(planningPrompt || '')) {
                candidates.add('docker-exec');
            }
            if (allowedToolIds.includes('code-sandbox') && hasExplicitLocalSandboxIntent(prompt)) {
                candidates.add('code-sandbox');
            }
            if (effectiveRolePipelineSeed?.requiresDesign && allowedToolIds.includes('design-resource-search')) {
                candidates.add('design-resource-search');
            }
            if ((effectiveRolePipelineSeed?.requiresSandbox || hasExplicitLocalSandboxIntent(prompt))
                && allowedToolIds.includes('code-sandbox')) {
                candidates.add('code-sandbox');
            }
            if (effectiveRolePipelineSeed?.requiresSandbox && allowedToolIds.includes('web-scrape')) {
                candidates.add('web-scrape');
            }
            if (hasArchitectureIntent && allowedToolIds.includes('architecture-design')) {
                candidates.add('architecture-design');
            }
            if (hasUmlIntent && allowedToolIds.includes('uml-generate')) {
                candidates.add('uml-generate');
            }
            if (hasApiIntent && allowedToolIds.includes('api-design')) {
                candidates.add('api-design');
            }
            if (hasSchemaIntent && allowedToolIds.includes('schema-generate')) {
                candidates.add('schema-generate');
            }
            if (hasMigrationChangeIntent && allowedToolIds.includes('migration-create')) {
                candidates.add('migration-create');
            }
            if (hasSecurityIntent && allowedToolIds.includes('security-scan')) {
                candidates.add('security-scan');
            }
            if (hasDocumentWorkflowIntent && allowedToolIds.includes(DOCUMENT_WORKFLOW_TOOL_ID)) {
                candidates.add(DOCUMENT_WORKFLOW_TOOL_ID);
            }
            if (hasImageIntent && allowedToolIds.includes('image-generate')) {
                candidates.add('image-generate');
            }
            if (hasUnsplashIntent && allowedToolIds.includes('image-search-unsplash')) {
                candidates.add('image-search-unsplash');
            }
            if ((hasImageUrlIntent || hasDirectImageUrl) && allowedToolIds.includes('image-from-url')) {
                candidates.add('image-from-url');
            }
            if (hasPodcastIntent && allowedToolIds.includes('podcast')) {
                candidates.add('podcast');
            }
            if (hasAssetCatalogIntent && allowedToolIds.includes('asset-search')) {
                candidates.add('asset-search');
                if (allowedToolIds.includes('file-read')
                    && /\b(file|files|context|reference|source material|review|improve|edit|update|change|revise)\b/.test(prompt)) {
                    candidates.add('file-read');
                }
                if (allowedToolIds.includes('file-write')
                    && /\b(improve|edit|update|change|revise|rewrite|build on|iterate on)\b/.test(prompt)) {
                    candidates.add('file-write');
                }
            }
            if (hasResearchBucketIntent) {
                ['research-bucket-list', 'research-bucket-search', 'research-bucket-read'].forEach((toolId) => allowedToolIds.includes(toolId) && candidates.add(toolId));
                if (/\b(write|save|add|store|capture|create|update|append)\b/.test(prompt) && allowedToolIds.includes('research-bucket-write')) {
                    candidates.add('research-bucket-write');
                }
                if (/\b(mkdir|folder|directory)\b/.test(prompt) && allowedToolIds.includes('research-bucket-mkdir')) {
                    candidates.add('research-bucket-mkdir');
                }
            }
            if (hasPublicSourceIndexIntent) {
                ['public-source-list', 'public-source-search', 'public-source-get'].forEach((toolId) => allowedToolIds.includes(toolId) && candidates.add(toolId));
                if (/\b(add|save|store|index|catalog|catalogue|create|update)\b/.test(prompt) && allowedToolIds.includes('public-source-add')) {
                    candidates.add('public-source-add');
                }
                if (/\b(refresh|verify|check|validate|probe)\b/.test(prompt) && allowedToolIds.includes('public-source-refresh')) {
                    candidates.add('public-source-refresh');
                }
            }
            if (!shouldPreferRemoteWebsiteSource
                && allowedToolIds.includes('file-write')
                && /\b(write|create|update|edit|save|patch|fix)\b/.test(prompt)) {
                candidates.add('file-write');
            }
            if (!shouldPreferRemoteWebsiteSource
                && allowedToolIds.includes('file-mkdir')
                && /\b(create|make|mkdir)\b/.test(prompt)) {
                candidates.add('file-mkdir');
            }
            if (!sessionIsolation && allowedToolIds.includes('agent-notes-write') && isAgentNotesAutoWriteEnabled()) {
                candidates.add('agent-notes-write');
            }
        } else {
            if (canUseSubAgents && hasSubAgentIntent && allowedToolIds.includes('agent-delegate')) {
                candidates.add('agent-delegate');
            }
            if (!isDeferredWorkloadRun
                && allowDeferredWorkloadShortcut
                && hasWorkloadSetupIntent
                && allowedToolIds.includes('agent-workload')) {
                candidates.add('agent-workload');
            }
            if (remoteToolId && (sshContext.shouldTreatAsSsh || /\b(remote server|remote host|remote machine)\b/.test(prompt))) {
                candidates.add(remoteToolId);
            }
            if ((hasExplicitWebResearchIntent || /\b(latest|current|today|news|headlines?|weather|forecast|temperature|research|look up|search|browse)\b/.test(prompt)) && allowedToolIds.includes('web-search')) {
                candidates.add('web-search');
            }
            if ((hasExplicitWebResearchIntent || hasCurrentInfoIntentText(prompt))
                && allowedToolIds.includes('web-fetch')) {
                candidates.add('web-fetch');
            }
            if (hasExplicitScrapeIntent) {
                if (allowedToolIds.includes('web-search')) {
                    candidates.add('web-search');
                }
                if (allowedToolIds.includes('web-scrape')) {
                    candidates.add('web-scrape');
                }
            }
            if (hasExplicitWebResearchIntent && hasUrl && allowedToolIds.includes('web-fetch')) {
                candidates.add('web-fetch');
            }
            if (hasUrl && allowedToolIds.includes('web-fetch')) {
                candidates.add(hasExplicitScrapeIntent && allowedToolIds.includes('web-scrape')
                    ? 'web-scrape'
                    : 'web-fetch');
            }
            if (hasImageIntent && /\b(generate|create|make|design)\b/.test(prompt) && allowedToolIds.includes('image-generate')) {
                candidates.add('image-generate');
            }
            if ((hasUnsplashIntent || (hasImageIntent && /\b(search|find|browse|reference|stock)\b/.test(prompt))) && allowedToolIds.includes('image-search-unsplash')) {
                candidates.add('image-search-unsplash');
            }
            if ((hasImageUrlIntent || hasDirectImageUrl) && allowedToolIds.includes('image-from-url')) {
                candidates.add('image-from-url');
            }
            if (hasPodcastIntent && allowedToolIds.includes('podcast')) {
                candidates.add('podcast');
            }
            if (hasAssetCatalogIntent && allowedToolIds.includes('asset-search')) {
                candidates.add('asset-search');
                if (allowedToolIds.includes('file-read')
                    && /\b(file|files|context|reference|source material|review|improve|edit|update|change|revise)\b/.test(prompt)) {
                    candidates.add('file-read');
                }
                if (allowedToolIds.includes('file-write')
                    && /\b(improve|edit|update|change|revise|rewrite|build on|iterate on)\b/.test(prompt)) {
                    candidates.add('file-write');
                }
            }
            if (hasResearchBucketIntent) {
                ['research-bucket-list', 'research-bucket-search', 'research-bucket-read'].forEach((toolId) => allowedToolIds.includes(toolId) && candidates.add(toolId));
                if (/\b(write|save|add|store|capture|create|update|append)\b/.test(prompt) && allowedToolIds.includes('research-bucket-write')) {
                    candidates.add('research-bucket-write');
                }
                if (/\b(mkdir|folder|directory)\b/.test(prompt) && allowedToolIds.includes('research-bucket-mkdir')) {
                    candidates.add('research-bucket-mkdir');
                }
            }
            if (hasPublicSourceIndexIntent) {
                ['public-source-list', 'public-source-search', 'public-source-get'].forEach((toolId) => allowedToolIds.includes(toolId) && candidates.add(toolId));
                if (/\b(add|save|store|index|catalog|catalogue|create|update)\b/.test(prompt) && allowedToolIds.includes('public-source-add')) {
                    candidates.add('public-source-add');
                }
                if (/\b(refresh|verify|check|validate|probe)\b/.test(prompt) && allowedToolIds.includes('public-source-refresh')) {
                    candidates.add('public-source-refresh');
                }
            }
            if (/\b(read|open|show|print|cat)\b[\s\S]{0,40}\bfile\b/.test(prompt) && allowedToolIds.includes('file-read')) {
                candidates.add('file-read');
            }
            if (/\b(find|search|locate|list)\b[\s\S]{0,40}\bfiles?\b/.test(prompt) && allowedToolIds.includes('file-search')) {
                candidates.add('file-search');
            }
            if (/\b(write|save|create|update|edit|change|improve|revise|rewrite)\b[\s\S]{0,40}\bfile\b/.test(prompt) && allowedToolIds.includes('file-write')) {
                candidates.add('file-write');
            }
            if (/\b(create|make|mkdir)\b[\s\S]{0,40}\b(folder|directory)\b/.test(prompt) && allowedToolIds.includes('file-mkdir')) {
                candidates.add('file-mkdir');
            }
            if (!sessionIsolation && allowedToolIds.includes('agent-notes-write') && isAgentNotesAutoWriteEnabled()) {
                candidates.add('agent-notes-write');
            }
            if (hasRemoteCliAgentAuthoringRequest && allowedToolIds.includes('remote-cli-agent')) {
                candidates.add('remote-cli-agent');
            }
            if (effectiveRolePipelineSeed?.requiresDesign && allowedToolIds.includes('design-resource-search')) {
                candidates.add('design-resource-search');
            }
            if ((effectiveRolePipelineSeed?.requiresSandbox || hasExplicitLocalSandboxIntent(prompt))
                && allowedToolIds.includes('code-sandbox')) {
                candidates.add('code-sandbox');
            }
            if (effectiveRolePipelineSeed?.requiresSandbox && allowedToolIds.includes('web-scrape')) {
                candidates.add('web-scrape');
            }
            if (/\b(git|github)\b[\s\S]{0,80}\b(status|diff|branch|stage|add|commit|push|save and push|save-and-push)\b/.test(prompt)
                && allowedToolIds.includes('git-safe')) {
                candidates.add('git-safe');
            }
            if (/\b(deploy|rollout|apply|set image|update image|sync)\b[\s\S]{0,60}\b(k3s|k8s|kubernetes|kubectl|manifest|deployment|helm)\b/.test(prompt)
                && allowedToolIds.includes('k3s-deploy')) {
                candidates.add('k3s-deploy');
            }
            if ((/\btool\b[\s\S]{0,40}\b(help|doc|docs|documentation|how)\b/.test(prompt)
                || hasRemoteInfraToolUsageIntent(prompt))
                && allowedToolIds.includes('tool-doc-read')) {
                candidates.add('tool-doc-read');
            }
            if (hasArchitectureIntent && allowedToolIds.includes('architecture-design')) {
                candidates.add('architecture-design');
            }
            if (hasUmlIntent && allowedToolIds.includes('uml-generate')) {
                candidates.add('uml-generate');
            }
            if (hasApiIntent && allowedToolIds.includes('api-design')) {
                candidates.add('api-design');
            }
            if (hasSchemaIntent && allowedToolIds.includes('schema-generate')) {
                candidates.add('schema-generate');
            }
            if (hasMigrationChangeIntent && allowedToolIds.includes('migration-create')) {
                candidates.add('migration-create');
            }
            if (hasSecurityIntent && allowedToolIds.includes('security-scan')) {
                candidates.add('security-scan');
            }
            if (hasDeepResearchPresentationIntentText(prompt) && allowedToolIds.includes(DEEP_RESEARCH_PRESENTATION_TOOL_ID)) {
                candidates.add(DEEP_RESEARCH_PRESENTATION_TOOL_ID);
            }
            if (hasDocumentWorkflowIntent && allowedToolIds.includes(DOCUMENT_WORKFLOW_TOOL_ID)) {
                candidates.add(DOCUMENT_WORKFLOW_TOOL_ID);
            }
        }

        if (canUseUserCheckpoint && (
            hasExplicitCheckpointRequestText(prompt)
            || hasHighImpactDecisionGateText(prompt)
            || classification?.checkpointNeed === 'required'
        )) {
            candidates.add(USER_CHECKPOINT_TOOL_ID);
        }

        const candidateToolIds = isJudgmentV2Enabled()
            ? selectCandidateToolIdsFromScores(allowedToolIds, scoreMap)
            : allowedToolIds.filter((toolId) => candidates.has(toolId));

        const needsGitLabManagedAppObservability = hasManagedAppIntent
            || hasManagedAppAuthoringRequest
            || hasManagedAppContinuationRecovery
            || /\b(gitlab|gitlab ci|gitlab runner|build events webhook)\b/i.test(prompt);

        if (needsGitLabManagedAppObservability
            && allowedToolIds.includes('managed-app')
            && !candidateToolIds.includes('managed-app')) {
            candidateToolIds.unshift('managed-app');
        }

        if (isJudgmentV2Enabled()
            && classification?.checkpointNeed === 'required'
            && canUseUserCheckpoint
            && allowedToolIds.includes(USER_CHECKPOINT_TOOL_ID)
            && !candidateToolIds.includes(USER_CHECKPOINT_TOOL_ID)) {
            candidateToolIds.unshift(USER_CHECKPOINT_TOOL_ID);
        }

        const legacyPolicy = {
            executionProfile,
            allowedToolIds,
            candidateToolIds,
            candidateToolScores: scoreMap,
            hasSshDefaults,
            hasReachableSshTarget,
            sshRuntimeTarget: formatSshRuntimeTarget(sshContext.target),
            userCheckpointPolicy: {
                enabled: userCheckpointPolicy.enabled === true,
                remaining: Math.max(0, Number(userCheckpointPolicy.remaining) || 0),
                pending: userCheckpointPolicy.pending || null,
                surveyResponseTurn: isSurveyResponseTurn,
            },
            preferredRemoteToolId: remoteToolId,
            sessionIsolation,
            projectKey,
            activeTaskFrame,
            classification,
            agencyProfile: effectiveAgencyProfile,
            rolePipeline: effectiveRolePipelineSeed,
            workflow: effectiveWorkflowSeed,
            projectPlan: effectiveProjectPlanSeed,
            clusterRegistrySummary,
            remoteCliInventorySummary,
            managedAppsSummary,
            toolDescriptions: Object.fromEntries(
                allowedToolIds.map((toolId) => [
                    toolId,
                    toolManager?.getTool?.(toolId)?.description
                        || toolManager?.getTool?.(toolId)?.name
                        || toolId,
                ]),
            ),
        };

        return applyRewritePolicyOverlay({
            legacyPolicy,
            objective,
            instructions,
            executionProfile,
            classification,
            agencyProfile: effectiveAgencyProfile,
            toolManager,
        });
    }

    buildDirectAction({ objective = '', session = null, recentMessages = [], toolPolicy = {}, toolContext = {}, toolEvents = [] }) {
        if (isOrchestrationRewriteEnabled()) {
            const rewriteRoute = buildDeterministicRoute({
                objective,
                agencyProfile: toolPolicy?.orchestrationRewrite?.agencyProfile || toolPolicy?.agencyProfile,
                toolPolicy,
                timezone: toolContext?.timezone
                    || session?.metadata?.timezone
                    || session?.metadata?.timeZone
                    || getDefaultWorkloadTimezone(),
            });
            if (rewriteRoute && shouldAllowDirectAction(rewriteRoute, { toolPolicy, toolEvents })) {
                return rewriteRoute;
            }
        }

        const researchQuery = extractExplicitWebResearchQuery(objective);
        const currentInfoQuery = !researchQuery ? extractImplicitCurrentInfoQuery(objective) : null;
        const searchQuery = researchQuery || currentInfoQuery;
        const firstUrl = extractFirstUrl(objective);
        const remoteToolId = getPreferredRemoteToolId(toolPolicy);
        const finalizeAction = (action) => (
            shouldAllowDirectAction(action, { toolPolicy, toolEvents })
                ? action
                : null
        );
        const documentWorkflowParams = buildDocumentWorkflowGenerateParams({
            objective,
            toolEvents,
            clientSurface: toolContext?.clientSurface || '',
        });
        const hasGroundedDocumentSources = Array.isArray(documentWorkflowParams.sources)
            && documentWorkflowParams.sources.length > 0;
        const podcastTopic = toolPolicy.candidateToolIds.includes('podcast') && hasExplicitPodcastIntentText(objective)
            ? extractExplicitPodcastTopic(objective)
            : null;
        const podcastDurationMinutes = podcastTopic
            ? extractRequestedPodcastDurationMinutes(objective)
            : null;
        const podcastVideoOptions = podcastTopic && hasExplicitPodcastVideoIntent(objective)
            ? inferPodcastVideoOptions(objective)
            : {};
        const podcastAudioAssetOptions = podcastTopic
            ? inferPodcastAudioAssetOptions(objective)
            : {};
        const selectedArtifactIds = Array.isArray(toolContext?.artifactIds)
            ? toolContext.artifactIds.map((artifactId) => String(artifactId || '').trim()).filter(Boolean)
            : [];
        const podcastNeedsAssetLookup = Boolean(
            podcastTopic
            && hasPodcastSourceArtifactReferenceText(objective)
            && selectedArtifactIds.length === 0
            && !getLastSuccessfulToolEvent(toolEvents, 'asset-search')
        );
        const shouldForcePlannerForMultiWorkload = toolPolicy.candidateToolIds.includes('agent-workload')
            && hasMultiWorkloadSchedulingIntent(objective);
        const hasActiveForegroundWorkflow = toolPolicy?.workflow?.status === 'active';
        const hasActiveForegroundProjectPlan = toolPolicy?.projectPlan?.status === 'active';
        const hasExplicitDeferredWorkloadIntent = hasWorkloadIntent(objective);
        const normalizedCreate = toolPolicy.candidateToolIds.includes('agent-workload')
            ? buildCanonicalWorkloadAction({
                request: objective,
            }, {
                session,
                recentMessages,
                timezone: toolContext?.timezone
                    || session?.metadata?.timezone
                    || session?.metadata?.timeZone
                    || getDefaultWorkloadTimezone(),
                now: toolContext?.now || null,
            })
            : null;
        if (toolPolicy.candidateToolIds.includes('agent-workload')
            && !shouldForcePlannerForMultiWorkload
            && (
                (
                    !hasActiveForegroundWorkflow
                    && !hasActiveForegroundProjectPlan
                ) || hasExplicitDeferredWorkloadIntent
            )
            && (
                hasExplicitDeferredWorkloadIntent
                || (
                    !hasActiveForegroundWorkflow
                    && !hasActiveForegroundProjectPlan
                    && (
                        normalizedCreate?.trigger?.type === 'cron'
                        || normalizedCreate?.trigger?.type === 'once'
                    )
                )
            )) {
            if (normalizedCreate) {
                return finalizeAction({
                    tool: 'agent-workload',
                    reason: 'Explicit later or recurring-agent request should be converted into a persisted workload.',
                    params: normalizedCreate,
                });
            }

            return finalizeAction({
                tool: 'agent-workload',
                reason: 'Explicit later or recurring-agent request should be converted into a persisted workload.',
                params: {
                    action: 'create_from_scenario',
                    request: objective,
                    ...(toolContext?.now ? { now: toolContext.now } : {}),
                    timezone: toolContext?.timezone
                        || session?.metadata?.timezone
                        || session?.metadata?.timeZone
                        || getDefaultWorkloadTimezone(),
                },
            });
        }
        if (toolPolicy.candidateToolIds.includes(DEEP_RESEARCH_PRESENTATION_TOOL_ID)
            && hasDeepResearchPresentationIntentText(objective)
            && !hasGroundedDocumentSources) {
            return finalizeAction({
                tool: DEEP_RESEARCH_PRESENTATION_TOOL_ID,
                reason: 'Deep research presentation requests should follow the ordered plan, research, image, and deck-generation workflow.',
                params: {
                    prompt: objective,
                    documentType: 'presentation',
                    format: 'pptx',
                },
            });
        }
        if (toolPolicy.candidateToolIds.includes(DOCUMENT_WORKFLOW_TOOL_ID)
            && hasDocumentWorkflowIntentText(objective)
            && hasGroundedDocumentSources) {
            return finalizeAction({
                tool: DOCUMENT_WORKFLOW_TOOL_ID,
                reason: 'Verified research results are already available, so the document workflow can generate the requested deliverable now.',
                params: documentWorkflowParams,
            });
        }

        const toolDocTargetToolId = resolveToolDocTargetToolId(objective);
        if (toolPolicy.candidateToolIds.includes('tool-doc-read')
            && toolDocTargetToolId) {
            return finalizeAction({
                tool: 'tool-doc-read',
                reason: 'Remote k3s, kubectl, and deployment command requests should load the relevant tool documentation before execution.',
                params: {
                    toolId: toolDocTargetToolId,
                },
            });
        }

        if (podcastTopic && !podcastNeedsAssetLookup) {
            return finalizeAction({
                tool: 'podcast',
                reason: podcastVideoOptions.includeVideo
                    ? 'Explicit video podcast request should use the podcast workflow with MP4 rendering.'
                    : 'Explicit podcast request should start with the podcast workflow tool.',
                params: {
                    topic: podcastTopic,
                    ...(selectedArtifactIds.length > 0 ? { artifactIds: selectedArtifactIds } : {}),
                    ...(podcastDurationMinutes ? { durationMinutes: podcastDurationMinutes } : {}),
                    ...podcastAudioAssetOptions,
                    ...podcastVideoOptions,
                },
            });
        }

        if (toolPolicy.candidateToolIds.includes('managed-app')
            && (hasManagedAppIntentText(objective)
                || hasManagedAppAuthoringIntent(objective, { executionProfile: toolPolicy.executionProfile })
                || /\b(gitlab|gitlab ci|gitlab runner|build events webhook)\b/i.test(objective)
                || inferManagedAppRecoveryActionFromRecentMessages(recentMessages) === 'create')) {
            return finalizeAction(buildManagedAppDirectAction(objective, {
                executionProfile: toolPolicy.executionProfile,
                workflow: toolPolicy.workflow,
                recentMessages,
            }));
        }

        if (toolPolicy.candidateToolIds.includes('remote-cli-agent')
            && hasRemoteCliAgentAuthoringIntent(objective)) {
            const priorAgentState = getSessionControlState(session).remoteCliAgent || {};
            const cwd = String(priorAgentState.cwd || '').trim()
                || resolvePreferredRemoteCliWorkspacePath({
                    session,
                    toolContext,
                });
            const task = buildRemoteCliAgentTaskForPrompt({
                objective,
                priorAgentState,
            });
            return finalizeAction({
                tool: 'remote-cli-agent',
                reason: 'The request asks an assisted remote CLI agent to own the coding, build, deploy, and verification loop.',
                params: {
                    task,
                    waitMs: 30000,
                    adminMode: true,
                    ...(cwd ? { cwd } : {}),
                    ...(priorAgentState.sessionId ? { sessionId: priorAgentState.sessionId } : {}),
                    ...(priorAgentState.mcpSessionId ? { mcpSessionId: priorAgentState.mcpSessionId } : {}),
                },
            });
        }

        const workflowDeploy = toolPolicy.workflow?.deploy || {};
        const isUnresolvedDeployOnlyWorkflow = toolPolicy.workflow?.lane === 'deploy-only'
            && !workflowDeploy.repositoryUrl
            && !workflowDeploy.targetDirectory
            && !workflowDeploy.manifestsPath
            && !workflowDeploy.namespace
            && !workflowDeploy.deployment
            && !workflowDeploy.publicDomain;
        if (toolPolicy.workflow && !isUnresolvedDeployOnlyWorkflow) {
            const workflowPlan = buildEndToEndWorkflowPlan({
                workflow: toolPolicy.workflow,
                toolPolicy,
                remoteToolId,
                deployDefaults: typeof settingsController.getEffectiveDeployConfig === 'function'
                    ? settingsController.getEffectiveDeployConfig()
                    : {},
            });
            if (workflowPlan.length === 1) {
                return finalizeAction(workflowPlan[0]);
            }
        }

        if (toolPolicy.executionProfile !== REMOTE_BUILD_EXECUTION_PROFILE
            && toolPolicy.candidateToolIds.includes('web-search')
            && searchQuery) {
            const localeParams = inferWebSearchLocaleParamsFromText(objective, searchQuery);
            return finalizeAction({
                tool: 'web-search',
                reason: researchQuery
                    ? 'Explicit research request should start with Perplexity-backed web search.'
                    : 'Current-information request should start with Perplexity-backed web search.',
                params: {
                    query: localeParams.query || searchQuery,
                    engine: 'perplexity',
                    researchMode: inferPerplexityResearchModeFromText(objective),
                    limit: normalizeResearchSearchResultCount(),
                    region: localeParams.region || 'us-en',
                    timeRange: inferResearchTimeRangeFromText(objective),
                    includeSnippets: true,
                    includeUrls: true,
                    ...(localeParams.domains ? { domains: localeParams.domains } : {}),
                    ...(localeParams.userLocation ? { userLocation: localeParams.userLocation } : {}),
                },
            });
        }

        if (firstUrl
            && toolPolicy.candidateToolIds.includes('web-scrape')
            && /\b(scrape|extract|selector|structured|parse)\b/i.test(objective)) {
            return finalizeAction({
                tool: 'web-scrape',
                reason: 'Explicit scrape request with a direct URL should start with deterministic web scraping.',
                params: inferBlindScrapeParams(objective, firstUrl),
            });
        }

        if (toolPolicy?.rolePipeline?.requiresDesign
            && toolPolicy.candidateToolIds.includes('design-resource-search')
            && !getLastSuccessfulToolEvent(toolEvents, 'design-resource-search')) {
            return finalizeAction({
                tool: 'design-resource-search',
                reason: 'The design role should gather curated design resources before the requested artifact is generated.',
                params: buildDesignResourceSearchParams({
                    objective,
                    rolePipeline: toolPolicy.rolePipeline,
                }),
            });
        }

        if (toolPolicy.candidateToolIds.includes(DOCUMENT_WORKFLOW_TOOL_ID)
            && hasDocumentWorkflowIntentText(objective)
            && !searchQuery
            && !(firstUrl && /\b(scrape|extract|selector|structured|parse)\b/i.test(objective))) {
            return finalizeAction({
                tool: DOCUMENT_WORKFLOW_TOOL_ID,
                reason: 'Explicit document or slide deliverable should start with the document workflow.',
                params: documentWorkflowParams,
            });
        }

        if (toolPolicy.candidateToolIds.includes('image-generate') && hasExplicitImageGenerationIntent(objective)) {
            const requestedImageCount = extractRequestedImageCount(objective, 1);
            return finalizeAction({
                tool: 'image-generate',
                reason: 'Explicit image-generation request should start by materializing reusable image artifacts.',
                params: {
                    prompt: buildImagePromptFromArtifactRequest(objective),
                    ...(requestedImageCount > 1 ? { n: requestedImageCount } : {}),
                },
            });
        }

        if (!remoteToolId) {
            return null;
        }

        const sshContext = resolveSshRequestContext(objective, session);
        if (!sshContext.directParams) {
            return null;
        }

        return finalizeAction({
            tool: remoteToolId,
            reason: 'Direct SSH command inferred from the user request.',
            params: sshContext.directParams,
        });
    }

    normalizePlannedStep(step = {}, { objective = '', session = null, executionProfile = DEFAULT_EXECUTION_PROFILE, recentMessages = [], toolContext = {} } = {}) {
        const rawTool = typeof step?.tool === 'string' ? step.tool.trim() : '';
        const normalizedStep = {
            tool: rawTool === 'remote-cli-agent' ? rawTool : canonicalizeRemoteToolId(rawTool),
            reason: typeof step?.reason === 'string' ? step.reason.trim() : '',
            params: step?.params && typeof step.params === 'object' ? { ...step.params } : {},
        };

        if (normalizedStep.tool === 'agent-workload') {
            normalizedStep.params = normalizeAgentWorkloadPlanParams(step, {
                objective,
                session,
                recentMessages,
                toolContext,
            });
            return normalizedStep;
        }

        if (normalizedStep.tool === 'agent-delegate') {
            normalizedStep.params = normalizeAgentDelegatePlanParams(step, {
                objective,
            });
            return normalizedStep;
        }

        if (normalizedStep.tool === 'file-write') {
            normalizedStep.params = normalizeFileWritePlanParams(step, {
                objective,
                recentMessages,
            });
            return normalizedStep;
        }

        if (normalizedStep.tool === USER_CHECKPOINT_TOOL_ID) {
            normalizedStep.params = normalizeUserCheckpointPlanParams(step);
            return normalizedStep;
        }

        if (normalizedStep.tool === 'architecture-design') {
            normalizedStep.params = normalizeArchitectureDesignPlanParams(step, { objective });
            return normalizedStep;
        }

        if (normalizedStep.tool === 'remote-cli-agent') {
            const priorAgentState = getSessionControlState(session).remoteCliAgent || {};
            const cwd = String(
                normalizedStep.params.cwd
                || priorAgentState.cwd
                || resolvePreferredRemoteCliWorkspacePath({
                    session,
                    toolContext,
                })
                || '',
            ).trim();
            const rawTask = String(normalizedStep.params.task || objective || '').trim();
            normalizedStep.params = {
                ...normalizedStep.params,
                task: buildRemoteCliAgentTaskForPrompt({
                    objective: rawTask,
                    priorAgentState,
                }),
                waitMs: Number(normalizedStep.params.waitMs || normalizedStep.params.wait_ms || 30000) || 30000,
                ...(cwd ? { cwd } : {}),
                ...(normalizedStep.params.sessionId || priorAgentState.sessionId ? { sessionId: normalizedStep.params.sessionId || priorAgentState.sessionId } : {}),
                ...(normalizedStep.params.mcpSessionId || priorAgentState.mcpSessionId ? { mcpSessionId: normalizedStep.params.mcpSessionId || priorAgentState.mcpSessionId } : {}),
            };
            delete normalizedStep.params.wait_ms;
            return normalizedStep;
        }

        if (!isRemoteCommandToolId(normalizedStep.tool)) {
            return normalizedStep;
        }

        const sshContext = resolveSshRequestContext(objective, session);
        const trustedTarget = sshContext.target?.host ? sshContext.target : null;
        const plannedHost = typeof normalizedStep.params.host === 'string'
            ? normalizedStep.params.host.trim()
            : '';
        const shouldPinRemoteTarget = executionProfile === REMOTE_BUILD_EXECUTION_PROFILE && trustedTarget?.host;
        const shouldRepairSuspiciousHost = trustedTarget?.host
            && plannedHost
            && isSuspiciousSshTargetHost(plannedHost);

        if ((shouldPinRemoteTarget || !plannedHost || shouldRepairSuspiciousHost) && trustedTarget?.host) {
            normalizedStep.params.host = trustedTarget.host;
        }
        if ((shouldPinRemoteTarget || !normalizedStep.params.username || shouldRepairSuspiciousHost) && trustedTarget?.username) {
            normalizedStep.params.username = trustedTarget.username;
        }
        if ((shouldPinRemoteTarget || !normalizedStep.params.port || shouldRepairSuspiciousHost) && trustedTarget?.port) {
            normalizedStep.params.port = trustedTarget.port;
        }

        const existingCommand = typeof normalizedStep.params.command === 'string'
            ? normalizedStep.params.command.trim()
            : '';
        if (existingCommand) {
            normalizedStep.params.command = existingCommand;
            return normalizedStep;
        }

        const inferenceSource = [normalizedStep.reason, objective].filter(Boolean).join('\n');
        normalizedStep.params.command = sshContext.directParams?.command
            || inferFallbackSshCommand(inferenceSource, executionProfile)
            || (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
                ? buildUbuntuMasterRemoteCommand()
                : 'hostname && uptime && (df -h / || true) && (free -m || true)');

        return normalizedStep;
    }

    isPlannerStepAllowed(step = {}, { toolPolicy = {}, toolEvents = [] } = {}) {
        if (!step?.tool) {
            return Boolean(step?.tool);
        }

        if (step.tool === 'web-scrape' && hasBlankPlanUrlParam(step.params)) {
            return false;
        }

        if (!isJudgmentV2Enabled()) {
            return true;
        }

        const classification = toolPolicy?.classification || {};
        if (classification.checkpointNeed === 'required' && step.tool !== USER_CHECKPOINT_TOOL_ID) {
            return false;
        }

        if (classification.surfaceMode === 'notes-page'
            && !['web-search', 'web-fetch', 'web-scrape', USER_CHECKPOINT_TOOL_ID].includes(step.tool)) {
            return false;
        }

        if (classification.groundingRequirement === 'required') {
            if (![USER_CHECKPOINT_TOOL_ID, 'web-search', 'web-fetch', 'web-scrape', DOCUMENT_WORKFLOW_TOOL_ID, 'podcast'].includes(step.tool)) {
                return false;
            }

            if (step.tool === DOCUMENT_WORKFLOW_TOOL_ID && !hasGroundedResearchToolResult(toolEvents)) {
                return false;
            }
        }

        if (step.tool === 'file-write'
            && (!String(step?.params?.path || '').trim() || !String(step?.params?.content || '').trim())) {
            return false;
        }

        if (step.tool === 'agent-delegate'
            && (!Array.isArray(step?.params?.tasks) || step.params.tasks.length === 0)) {
            return false;
        }

        if (toolEvents.length > 0) {
            const priorSignatures = new Set((Array.isArray(toolEvents) ? toolEvents : [])
                .map((event) => extractExecutedStepSignature(event))
                .filter(Boolean));
            const nextSignature = extractExecutedStepSignature({
                toolCall: {
                    function: {
                        name: step.tool,
                        arguments: JSON.stringify(step.params || {}),
                    },
                },
            });
            if (nextSignature && priorSignatures.has(nextSignature)) {
                return false;
            }
        }

        return true;
    }

    buildFallbackPlan({ objective = '', session = null, recentMessages = [], toolContext = {}, executionProfile = DEFAULT_EXECUTION_PROFILE, toolPolicy = {}, toolEvents = [] }) {
        if (!toolPolicy?.candidateToolIds?.length) {
            return [];
        }

        const prompt = String(objective || '').trim();
        const firstUrl = extractFirstUrl(prompt);
        const remoteToolId = getPreferredRemoteToolId(toolPolicy);
        const directAction = this.buildDirectAction({
            objective,
            session,
            recentMessages,
            toolPolicy,
            toolContext,
            toolEvents,
        });

        if (directAction) {
            return [directAction];
        }

        if (toolPolicy.candidateToolIds.includes('web-search') && hasExplicitWebResearchIntentText(prompt)) {
            const query = extractExplicitWebResearchQuery(prompt) || prompt;
            const localeParams = inferWebSearchLocaleParamsFromText(prompt, query);
            return [{
                tool: 'web-search',
                reason: 'Fallback for explicit research intent.',
                params: {
                    query: localeParams.query || query,
                    engine: 'perplexity',
                    researchMode: inferPerplexityResearchModeFromText(prompt),
                    limit: normalizeResearchSearchResultCount(),
                    region: localeParams.region || 'us-en',
                    timeRange: 'all',
                    includeSnippets: true,
                    includeUrls: true,
                    ...(localeParams.domains ? { domains: localeParams.domains } : {}),
                    ...(localeParams.userLocation ? { userLocation: localeParams.userLocation } : {}),
                },
            }];
        }

        if (firstUrl && /\b(scrape|extract|selector|structured|parse)\b/i.test(prompt) && toolPolicy.candidateToolIds.includes('web-scrape')) {
            return [{
                tool: 'web-scrape',
                reason: 'Deterministic fallback for explicit scrape intent.',
                params: inferBlindScrapeParams(prompt, firstUrl),
            }];
        }

        if (firstUrl && toolPolicy.candidateToolIds.includes('web-fetch')) {
            return [{
                tool: 'web-fetch',
                reason: 'Deterministic fallback for explicit URL retrieval.',
                params: {
                    url: firstUrl,
                },
            }];
        }

        if (toolPolicy.candidateToolIds.includes('image-from-url') && firstUrl && /\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(firstUrl)) {
            return [{
                tool: 'image-from-url',
                reason: 'Deterministic fallback for explicit image URL usage.',
                params: {
                    url: firstUrl,
                },
            }];
        }

        if (toolPolicy.candidateToolIds.includes('image-search-unsplash') && /\bunsplash\b/i.test(prompt)) {
            const query = inferFallbackUnsplashQuery(prompt);
            if (query) {
                return [{
                    tool: 'image-search-unsplash',
                    reason: 'Deterministic fallback for explicit Unsplash request.',
                    params: {
                        query,
                        perPage: 6,
                    },
                }];
            }
        }

        if (toolPolicy.candidateToolIds.includes('image-generate') && hasExplicitImageGenerationIntent(prompt)) {
            const requestedImageCount = extractRequestedImageCount(prompt, 1);
            return [{
                tool: 'image-generate',
                reason: 'Deterministic fallback for explicit image-generation intent.',
                params: {
                    prompt: buildImagePromptFromArtifactRequest(prompt),
                    ...(requestedImageCount > 1 ? { n: requestedImageCount } : {}),
                },
            }];
        }

        if (toolPolicy.candidateToolIds.includes(DOCUMENT_WORKFLOW_TOOL_ID)
            && (hasDocumentWorkflowIntentText(prompt) || hasWebsiteBuildIntent(prompt))) {
            return [{
                tool: DOCUMENT_WORKFLOW_TOOL_ID,
                reason: hasWebsiteBuildIntent(prompt)
                    ? 'Deterministic fallback for previewable sandbox website, app, or game generation.'
                    : 'Deterministic fallback for explicit document or slide generation.',
                params: buildDocumentWorkflowGenerateParams({
                    objective: prompt,
                    toolEvents,
                    clientSurface: toolContext?.clientSurface || '',
                }),
            }];
        }

        if (remoteToolId
            && (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
                || toolPolicy.hasReachableSshTarget
                || /\b(ssh|server|host|cluster|k3s|k8s|kubernetes|kubectl|deploy|deployment|docker)\b/i.test(prompt))) {
            const sshContext = resolveSshRequestContext(objective, session);
            const command = sshContext.directParams?.command || inferFallbackSshCommand(prompt, executionProfile);

            if (command) {
                return [{
                    tool: remoteToolId,
                    reason: 'Fallback for explicit server or remote-build intent.',
                    params: sshContext.target?.host
                        ? {
                            host: sshContext.target.host,
                            ...(sshContext.target.username ? { username: sshContext.target.username } : {}),
                            ...(sshContext.target.port ? { port: sshContext.target.port } : {}),
                            command,
                        }
                        : {
                            command,
                        },
                }];
            }
        }

        return [];
    }

    async planToolUse({
        objective = '',
        instructions = '',
        contextMessages = [],
        recentMessages = [],
        session = null,
        toolContext = {},
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        toolPolicy = {},
        model = null,
        reasoningEffort = null,
        taskType = 'chat',
        toolEvents = [],
        autonomyApproved = false,
        executionTrace = [],
    }) {
        if (!toolPolicy.candidateToolIds.length) {
            return [];
        }

        const roleOptions = resolveRoleExecutionOptions({
            role: 'planner',
            model,
            reasoningEffort,
            toolPolicy,
            toolEvents,
        });
        const remoteToolId = getPreferredRemoteToolId(toolPolicy);
        const toolCatalog = toolPolicy.candidateToolIds
            .map((toolId) => {
                const score = Number(toolPolicy?.candidateToolScores?.[toolId]?.score || 0);
                const reasons = Array.isArray(toolPolicy?.candidateToolScores?.[toolId]?.reasons)
                    ? toolPolicy.candidateToolScores[toolId].reasons.slice(0, 2).join('; ')
                    : '';
                return `- ${toolId}: ${toolPolicy.toolDescriptions?.[toolId] || toolId}${Number.isFinite(score) && score > 0 ? ` (score ${score.toFixed(2)})` : ''}${reasons ? ` [${reasons}]` : ''}`;
            })
            .join('\n');
        const planningPrompt = String(objective || '');
        const registeredSkillsInstructions = buildRegisteredSkillsInstructions({
            userText: planningPrompt,
            metadata: {
                ...(toolContext?.metadata || {}),
                ...(session?.metadata || {}),
                plannedTools: toolPolicy.candidateToolIds,
            },
            toolIds: toolPolicy.candidateToolIds,
        });
        const prompt = [
            'You are planning tool usage for an application-owned agent runtime.',
            'Classify first, then choose the smallest safe tool sequence that follows the classification and verified evidence.',
            'Return JSON only.',
            'If tools are unnecessary, return {"steps":[]}.',
            `Execution profile: ${executionProfile}`,
            `Task type: ${taskType}`,
            ...(registeredSkillsInstructions
                ? [
                    'Registered skills available for this request:',
                    registeredSkillsInstructions,
                    'Use registered skills to understand reusable workflow shape. Still return only concrete tool steps from the candidate tool list.',
                ]
                : []),
            ...(toolPolicy?.classification
                ? [
                    `Request classification: ${JSON.stringify(toolPolicy.classification)}`,
                    'Treat the classification as a strong prior. Only deviate from it when the verified tool results or active workflow clearly justify a different tool sequence.',
                    toolPolicy.classification.groundingRequirement === 'required'
                        ? 'Grounding is required. Start with web-search, web-fetch, or web-scrape before any final document generation or synthesis step.'
                        : 'Grounding is optional unless the verified evidence shows the request is current-information sensitive.',
                ]
                : []),
            ...(toolPolicy?.agencyProfile
                ? [
                    `Agency profile: ${JSON.stringify(toolPolicy.agencyProfile)}`,
                    'Use the agency profile to scale effort: respond directly for respond, execute one safe workload for schedule, split distinct jobs for schedule-multiple, use agent-delegate only for explicit delegation, and keep gathering context across steps for sustained work until completion, blocker, or budget.',
                    'Prefer proceeding with reasonable assumptions for routine context gathering, implementation, testing, and verification; ask only when missing input materially changes scope, credentials, destructive actions, or product/architecture direction.',
                ]
                : []),
            ...(toolPolicy?.rolePipeline
                ? [
                    'Active agent role contracts:',
                    formatAgentRolePipelineForPrompt(toolPolicy.rolePipeline),
                    'Follow role order through handoff artifacts: research evidence first when required, design brief before build, sandbox/project build for websites, then QA/integration.',
                    'Use `design-resource-search` for the design role before generating design-sensitive websites, dashboards, documents, or page artifacts unless it has already succeeded in this run.',
                    'For website, dashboard, landing-page, app workspace, frontend demo, HTML prototype, UI mockup, browser game, and interactive sandbox builds, apply the Impressive Frontend Websites quality bar from the active role contract: specific first viewport, real controls/states/interactions, relevant assets, responsive layout, opened-state contrast, browser screenshots, nonblank canvas/WebGL when relevant, and at least one refinement pass for non-trivial work.',
                    'For website, dashboard, landing-page, frontend, game, and multi-step Vite builds, prefer the Symphony-style sequence: design/resource context, `document-workflow generate-suite` with `formats:["html"]`, `buildMode:"sandbox"`, and `useSandbox:true`, then browser QA. Direct `code-sandbox` calls must use `mode:"project"` rather than execute mode.',
                    'For slides, slide decks, presentations, and PowerPoint requests, default the final deliverable to PPTX unless the user explicitly asks for interactive or HTML output. On web-chat, include an HTML sandbox companion preview only as a design/review stage, not as a replacement for the PPTX.',
                    'For explicit PDF/PPTX/HTML/XLSX packages or multi-format document requests, use `document-workflow generate-suite` with the requested `formats`. On web-chat, include an HTML companion preview when the main deliverable is PDF, PPTX, or XLSX.',
                ]
                : []),
            'Candidate tools:',
            toolCatalog,
            '',
            'User request:',
            objective || '(empty)',
            '',
            'Runtime instructions:',
            instructions || '(none)',
            ...(shouldHydrateRemoteOpsGuidance({
                objective,
                instructions,
                executionProfile,
                allowedToolIds: toolPolicy.allowedToolIds,
                toolPolicy,
            })
                ? [
                    '',
                    'Hydrated remote ops guidance from local project docs:',
                    HYDRATED_REMOTE_OPS_GUIDANCE_TEXT,
                ]
                : []),
            '',
            'Active project plan:',
            toolPolicy.projectPlan
                ? formatProjectExecutionContext(toolPolicy.projectPlan)
                : '(none)',
            '',
            'Cluster registry memory:',
            toolPolicy.clusterRegistrySummary || '(none)',
            '',
            'Remote CLI runtime inventory:',
            toolPolicy.remoteCliInventorySummary || '(no remote runner CLI inventory reported)',
            '',
            'Supplemental recalled context:',
            'The recalled context below is historical retrieved memory, not the active transcript. Do not plan tool calls as if uploads, artifacts, tasks, or tool results mentioned there are present in this request unless the current user request or recent transcript explicitly asks to reuse them.',
            Array.isArray(contextMessages) && contextMessages.length > 0 ? contextMessages.join('\n') : '(none)',
            '',
            'Recent transcript:',
            Array.isArray(recentMessages) && recentMessages.length > 0
                ? recentMessages.map((message) => `${message.role}: ${normalizeMessageText(message.content || '')}`).join('\n')
                : '(none)',
            '',
            'Verified tool results from this run so far:',
            toolEvents.length > 0
                ? JSON.stringify(summarizeToolEventsForPlanner(toolEvents), null, 2)
                : '(none)',
            '',
            'Harness run state for this planning pass:',
            toolPolicy?.harness
                ? JSON.stringify(toolPolicy.harness, null, 2)
                : '(none)',
            '',
            'Evidence-first planning rules:',
            'Reject steps that repeat a no-op command from this run, mismatch the active surface, skip required grounding, or omit required parameters.',
            'Use the harness state to avoid prior failed signatures, respect current blockers, and stay inside the remaining autonomy and replan budget.',
            'If a step is missing required parameters, return a changed plan with those parameters filled instead of executing a malformed call.',
            'Do not create `agent-workload` steps for immediate requests, "now" requests, vague later language, or because runtime/project instructions mention scheduling. Use `agent-workload` only when the latest user request explicitly asks for future, recurring, reminder, follow-up, cron, or scheduled work.',
            'If the active surface is notes page editing, stay inside notes-safe research tools rather than switching to file, deploy, or document workflows.',
            'If grounding is required, do not jump straight to `document-workflow generate` unless verified web evidence already exists in this run.',
            '',
            'Return exactly this shape:',
            '{"steps":[{"tool":"tool-id","reason":"why","params":{}}]}',
            `Use at most ${MAX_PLAN_STEPS} steps.`,
            'Only use tools listed above.',
            'Do not invent SSH hosts, usernames, file paths, or credentials.',
            'Every `remote-command` step must include a non-empty `params.command` string.',
            'Every `remote-workbench` step must include `params.action`; use action names such as `repo-map`, `changed-files`, `grep`, `read-file`, `write-file`, `apply-patch`, `build`, `test`, `logs`, `rollout`, or `deploy-verify`.',
            'Treat "remote CLI", "direct CLI", and "remote command" as aliases for `remote-command`; do not route those phrases to a local shell or code sandbox.',
            'For most remote software creation, update, and deployment requests where an app, website, service, dashboard, or frontend must be changed and put live, prefer `remote-cli-agent` with `params.adminMode:true` so the remote coding agent owns authoring, build, deploy, and verification through the configured admin-capable CLI runner lane.',
            'For remote website, dashboard, landing-page, app workspace, frontend demo, HTML prototype, or UI mockup work, include the Impressive Frontend Websites standard in the remote agent objective: infer a compact brief, build the usable first screen, include relevant assets and real interactions/states, verify desktop/mobile and opened UI surfaces, then refine before deploy/final.',
            'Use `remote-command` for quick non-interactive host inspection, kubectl/log checks, one-off admin repairs, and post-deploy verification. Do not choose legacy raw SSH tooling when `remote-command` is available.',
            'If `remote-cli-agent` asks for user input or emits `USER_INPUT_REQUIRED`, forward that concise decision to the user; after the user answers, continue the same remote CLI session with their choice.',
            'If `remote-cli-agent` hits the same blocked command or root error twice without a materially changed strategy, stop that retry loop and report the blocker plus the next distinct recovery option.',
            'When a remote task matches a `remote-workbench` action, prefer that structured action over hand-writing equivalent shell in `remote-command`.',
            'When remote CLI runtime inventory is present, prefer commands and fallbacks that match the actual CLI tools reported by the online remote runner.',
            'Keep `remote-command` for kubectl, host inspection, package installs, logs, restarts, deployments, DNS, TLS, and other infrastructure operations.',
            'For Kubernetes deployment creation from `remote-command`, prefer repo manifests or `kubectl create ... --dry-run=client -o yaml | kubectl apply -f -` generators over hand-authored manifest heredocs inside a shell command.',
            'Before applying hand-authored Kubernetes YAML from a remote shell, run `kubectl apply --dry-run=server -f <file>` or `kubectl apply --dry-run=client -f <file>` and fix decoding or YAML parse errors before a live apply.',
            'If Kubernetes reports `strict decoding error: unknown field`, `error converting YAML to JSON`, or `unknown flag: --add`, do not retry the same manifest style. Switch to validated manifests, `kubectl create` generators, or the documented remote-command web workload pattern.',
            'Do not use `kubectl set --add`; when adding volumes use `kubectl set volume --add` with the subcommand or use `kubectl patch` with a valid strategic merge patch.',
            'Every `agent-workload` step must use the deferred workload schema only: `{"tool":"agent-workload","reason":"why","params":{"action":"create_from_scenario","request":"the full original user request","timezone":"IANA/Zone"}}`.',
            'Do not parse the schedule, cron, or remote command yourself for `agent-workload`; pass the full original request and let the runtime canonicalize it.',
            'Do not use `command`, `name`, `schedule`, or remote-command style fields inside `agent-workload` params.',
            'Before planning `agent-workload`, classify the latest user turn as one-time future run, recurring workload, reminder/follow-up, host crontab management, or no scheduled work. Timing words such as "tomorrow" are not enough by themselves.',
            'If that classification shows the user actually asks for a cron job, recurring schedule, reminder, or future run, prefer `agent-workload` instead of `remote-command` even when an SSH target is already available.',
            'If the user asks for multiple jobs or automations, split them into one `agent-workload` step per distinct task instead of combining everything into one workload.',
            'Every `agent-delegate` step must use `params.action` set to `spawn`, `status`, or `list`.',
            'For `agent-delegate spawn`, pass `params.tasks` as an array of 1 to 3 task objects. Each task needs a clear `title` and either a `prompt` or structured `execution` object.',
            'Use `agent-delegate` only when the user explicitly wants sub-agents, delegated workers, or parallel background tasks.',
            'For `agent-delegate`, spawn immediate helper tasks only. Each task prompt must be a bounded subtask that helps the current foreground work; do not pass the identical full user request as a child task.',
            'Do not plan more than 3 sub-agent tasks in one `agent-delegate` step, and do not use `agent-delegate` from inside a sub-agent task.',
            'When delegated tasks may write files, set distinct `writeTargets` or `lockKey` values so overlapping document edits are rejected.',
            ...(toolPolicy?.workflow?.status === 'active'
                ? [
                    'A foreground end-to-end workflow is already active for this session. Treat it as the current project task list and continue that work unless the user explicitly changes scope, asks to defer it, or asks to schedule a separate workload.',
                    'Do not convert the active foreground project into `agent-workload` just because the user answered with timing, checkpoint feedback, or a short decision reply.',
                ]
                : []),
            ...(toolPolicy?.projectPlan?.status === 'active'
                ? [
                    'A foreground session project plan is already active. Advance the active milestone before creating new scope or treating the conversation like a fresh task.',
                    'When the user gives feedback, a choice, or a brief correction, treat it as an update to the active project plan and continue from the next incomplete milestone.',
                ]
                : []),
            'Every `user-checkpoint` step must include either a non-empty `params.question` with concise choice `params.options`, or a short `params.steps` questionnaire.',
            'Use `user-checkpoint` when one high-impact user decision would materially change the plan, implementation scope, architecture, or final output before major work.',
            'Do not use `user-checkpoint` for routine autonomous build steps such as inspecting files, reading logs, applying edits, running tests, redeploying, restarting, or verifying output.',
            'For implementation, remote-build, deployment, and debugging work, proceed with the next obvious tool step unless the next step is a design/product/architecture choice, requires missing secrets, is destructive, or follows repeated hard failures without a recovery path.',
            'Use `user-checkpoint` only when the active runtime exposes it and one concise decision or direction check would help.',
            'Prefer one short checkpoint over stopping for a long plain-text intake.',
            'Do not mention checkpoint quotas, budgets, remaining counts, or internal runtime policy to the user.',
            'Keep `user-checkpoint` to one card with one visible step at a time. Prefer 1 question by default, or a short 2 to 4 step questionnaire when the user explicitly wants structured intake.',
            'Supported step types are choice, multi-choice, text, date, time, and datetime. For choice steps, use mutually exclusive, actionable options and leave the free-text field enabled when helpful.',
            'Do not turn `user-checkpoint` into a long questionnaire, a page of questions, or more than 6 steps.',
            'When the latest user turn starts with `Survey response (`, treat that as the resolved answer to the prior checkpoint and continue the work instead of planning another survey.',
            'For research, web-search, web-fetch, or web-scrape work, avoid long scrape surveys and example-heavy intake. If clarification is truly needed, use one short choice hotlist with 2 to 4 concrete options, then continue after the answer.',
            'For routine public research and research-backed slides or documents, do not stop to ask which websites to scrape. Use Perplexity-backed `web-search` to discover candidate URLs, choose the strongest public sources yourself, verify them with `web-fetch` first, and use `web-scrape` only when a page needs rendered or structured extraction unless the user explicitly wants a constrained source list.',
            'Every `document-workflow` step must include `params.action` set to `recommend`, `plan`, `generate`, `assemble`, or `generate-suite`.',
            'Use `document-workflow generate` for final briefs, reports, documents, HTML pages, and slide decks. For slides, slide decks, presentations, and PowerPoint requests, default the final deliverable to PPTX unless the user explicitly asks for interactive or HTML output.',
            'Do not ask the user to supply generic design-prompt quality wording for documents; document-workflow already applies built-in strategy, background design, evidence, accessibility, and final polish passes.',
            'Use `document-workflow generate-suite` with `buildMode:"sandbox"` or `useSandbox:true` for previewable website/dashboard/front-end/game/multi-step app artifacts so the builder produces a sandbox project instead of only a template. Treat this as a Symphony build-review-iterate loop, not a one-shot template export.',
            'For sandbox website/dashboard/front-end/game artifacts, require the builder to follow the Impressive Frontend Websites and Sandbox Vite Games standards: request-matched visual direction, relevant imagery/assets, real controls and states, game loop or workflow state machine when needed, pause/restart/reset, stable responsive layout, readable opened dropdown/menu/popover/dialog states, and a refinement pass after initial screenshot for non-trivial pages.',
            'For natural software-development journeys that start as an idea or concept, keep the flow conversational but concrete: shape a compact build brief, create a local sandbox prototype first when the user asks to try/build it, then use `remote-cli-agent`/deploy/git lanes only when the next turn asks to promote, deploy, publish, or save the work.',
            'Use `document-workflow generate-suite` for requested output packages such as PDF + PPTX + HTML, or when web-chat needs an HTML preview companion for PDF/PPTX/XLSX deliverables.',
            'Every direct `code-sandbox` website/game/Vite build step must use `params.mode:"project"` plus previewable files. Use `params.language:"vite"` for multi-file apps, games, simulations, and richer interactive previews. Do not use `code-sandbox` execute mode unless a separate confirmation policy explicitly allows executable code.',
            'For screenshot QA after a sandbox build, set `web-scrape.params.url` to the verified preview/public URL. Do not plan a `web-scrape` QA step with an empty, placeholder-only, or guessed URL; if the sandbox has not been built yet, build it first. Use `browser:true` and `captureScreenshot:true`, omit `selectors` unless extracting fields, and never send `selectors` as an array. If the URL is produced earlier in the same plan, use `{{lastPreviewUrl}}`; the runtime also resolves legacy `{{steps[n].previewUrl}}` placeholders before browser execution. Authentication walls, missing-token pages, empty bodies, low contrast, horizontal overflow, or page errors are blockers that require another build/repair pass instead of a final caveat.',
            'When the user wants a research-backed deliverable, prefer `web-search` and `web-fetch` first, then use `web-scrape` only when a page needs rendered or structured extraction before `document-workflow` with grounded `sources` derived from the verified tool results.',
            'Set `document-workflow.params.includeContent` to `true` only when a later step needs the full textual body for `file-write`; otherwise prefer the stored document download URL.',
            'Use `deep-research-presentation` when the user wants a research-backed deck handled as one ordered plan -> research -> images -> presentation workflow.',
            ...(toolPolicy?.userCheckpointPolicy?.enabled
                ? [
                    Number(toolPolicy.userCheckpointPolicy.remaining || 0) > 0
                        ? 'A `user-checkpoint` card is available in this session if a major decision truly needs it.'
                        : 'No additional `user-checkpoint` cards are currently available in this session. Do not mention that internal limit to the user.',
                    toolPolicy.userCheckpointPolicy.pending
                        ? 'A `user-checkpoint` is already pending. Do not plan another checkpoint until the user answers it.'
                        : (Number(toolPolicy.userCheckpointPolicy.remaining || 0) > 0
                            ? 'If a checkpoint would unblock a major decision, you may use `user-checkpoint` instead of stopping with a prose question.'
                            : 'If more input is truly required, ask at most one concise plain-text question; otherwise proceed with a reasonable assumption.'),
                    'On web-chat, treat `user-checkpoint` as the primary quick way to involve the user when one concise choice or direction check would help.',
                    'On web-chat, `user-checkpoint` renders as an inline survey card with clickable options, so prefer it over a plain-text multiple-choice question.',
                ]
                : []),
            'If a multi-job cron request omits exact times, you may pass one derived sub-request per job with conservative defaults in local time, such as daily at 9:00 AM for checks and every Monday at 2:00 AM for updates.',
            'Use `remote-command` for host cron only when the user explicitly asks to inspect or modify the server\'s own crontab.',
            'Every `file-write` step must include both `params.path` and the full file body as `params.content` in the same step.',
            '`file-write` is for local runtime files only. For remote hosts or deployed servers, use `remote-cli-agent` for remote software author/build/deploy loops, and use `remote-command` or `k3s-deploy` for narrower inspection or standard deploy actions. Do not use `docker-exec` for the host unless the user explicitly says Docker is available there.',
            'Do not return a `file-write` step that only points at a previous artifact or earlier file. If the full content is not already available in the prompt or recent transcript, choose a different tool or return no `file-write` step.',
            ...(toolPolicy.sessionIsolation
                ? [
                    'This session is isolated. Use `asset-search` only for assets from the current session unless the user explicitly asks to cross session boundaries.',
                    'Do not rely on durable carryover notes or earlier-session artifact lookup in this isolated session.',
                ]
                : [
                    'Use `asset-search` when the user refers to a previous, earlier, old, existing, uploaded, attached, generated, or saved image, document, PDF, file, or artifact.',
                    'Prefer `asset-search` before asking the user to resend a file that should already exist in prior artifacts or the local workspace.',
                ]),
            'Use `asset-search.params.kind = "image"` for visuals and `asset-search.params.kind = "document"` for PDFs, docs, HTML, markdown, and similar files.',
            'Set `asset-search.params.includeContent = true` when the stored text preview would help choose the right document.',
            'When the user wants old files or artifacts used as context/reference for a change, plan `asset-search` first, then read the selected editable file or fetched artifact content before writing the improved result.',
            'Treat non-code artifacts as product source material too. For review or product-building requests, compare prior files/artifacts against the stated goal or instructions, then improve the product artifact instead of only changing software plumbing.',
            'Use `research-bucket-*` tools when the user mentions a research bucket, reference bucket, source library, saved research, project references, or reusable web-project assets.',
            'For research bucket work, list or search first, then read only the specific files required. Use `research-bucket-write` or `research-bucket-mkdir` only when the user wants bucket contents created or updated.',
            'Use `public-source-*` tools when the user asks about the public source index, public API catalog, dashboard sources, RSS/news feeds, data portals, or reusable public endpoints.',
            'For public source index work, list or search first, then read selected entries. Add sources only after discovery/verification, and refresh only when live status or content type matters.',
            ...(toolPolicy.sessionIsolation
                ? ['Do not use `agent-notes-write` in this isolated session.']
                : [
                    'Use `agent-notes-write` only for concise, durable carryover notes that should help future sessions.',
                    'When a turn reveals a stable tone preference, collaboration style, or long-lived way Phil likes to work, proactively update `agent-notes-write` before finishing.',
                    'Good `agent-notes-write` candidates include Phil-specific collaboration preferences, stable tone or partner-style expectations, long-lived defaults, and durable user-wide workflow preferences.',
                    'Every `agent-notes-write` step must include the full replacement notes file as `params.content`.',
                    'Keep project-specific facts, current task state, and frontend-specific continuity in project/session memory instead of `agent-notes-write`.',
                    'Do not store secrets, code dumps, verbose logs, or temporary scratch notes in `agent-notes-write`.',
                ]),
            ...(executionProfile === REMOTE_BUILD_EXECUTION_PROFILE && hasRemoteWebsiteUpdateIntent(planningPrompt)
                ? [
                    'For remote website/page/HTML updates on a server or cluster, do not require a local artifact or local file read unless the user explicitly named one.',
                    'First locate the remote git workspace or repository that owns the deployed site; inspect `git status`, recent commits, and current source before editing.',
                    'When the user asks to replace the page with a new file, you may generate the full replacement HTML remotely, but commit it in the remote git workspace before rollout; set repo-local git user.name/user.email first if needed.',
                    'If a local HTML artifact or local file read fails, use the remote file, ConfigMap, or deployed content as recovery input, then persist the edit back to git rather than leaving the live cluster as the only source of truth.',
                    'Do not infer an arbitrary live website path such as `/var/www/...` as the target. Prefer the configured deploy target directory, a git workspace, or a path the user explicitly named.',
                    'If the configured deploy target directory is not a git repo, initialize one or clone the configured origin before making deployable edits; prefer configured GitLab origins when available.',
                    'Internal artifact links like `/api/artifacts/...` are backend-local references, not public hosts. Do not turn them into `https://api/...`.',
                    'Do not treat `svc` or `ingress` as deployment names. Inspect deployments, services, ingresses, pods, and ConfigMaps separately.',
                    'When verifying the deployed site, do not rely on the HTML `<title>` alone. Compare body content, mounted file content, response snippets, or content length when titles may be empty.',
                    ...(hasInternalArtifactReference(`${objective || ''}\n${instructions || ''}`)
                        ? [
                            'If the runtime instructions or project memory include an internal artifact link and you need its contents, use local `web-fetch` from this runtime first, then send the fetched content to the remote target with `remote-command`.',
                            'Do not use `remote-command` to `curl` `api`, `localhost:3000`, `127.0.0.1:3000`, or `/api/artifacts/...` from the target server unless a verified tool result proves that endpoint is reachable from the target host.',
                        ]
                        : []),
                ]
                : []),
            ...(autonomyApproved && executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
                ? [
                    'The user has already approved continuing through obvious next remote-build steps.',
                    'Treat the original user request as the active objective; intermediate failures discovered during troubleshooting are part of the same task, not separate tasks that require user approval.',
                    'Do not stop after a single inspection if the next server action is routine and clearly implied by the verified results.',
                    'Do not stop just to report an intermediate issue when you can inspect, test, or apply the next routine fix yourself.',
                    'Keep moving through setup, inspection, verification, and routine fixes without asking for confirmation between each step.',
                    'Prefer the next distinct action that most directly advances the original ask, not the safest-sounding minimal action.',
                    'Keep going until the goal is reached, a real blocker appears, or the autonomous runtime budget is exhausted.',
                    'Stop only when blocked by missing secrets, DNS/domain values, explicit design/product/architecture choices, destructive resets/wipes, repeated hard tool failures with no credible recovery path, or an exhausted autonomy budget.',
                    'When verified remote tool results already exist, do not repeat the same command back-to-back without an intervening fix or new reason, and do not return {"steps":[]} unless the task is truly complete or genuinely blocked.',
                    'If the last remote step was only an initial inspection, return the next distinct remote step instead of ending the plan.',
                ]
                : []),
            ...(remoteToolId && toolPolicy.hasReachableSshTarget
                ? [
                    `For ${remoteToolId}, host, username, and port may be omitted when the runtime already has a configured default target or sticky session target.`,
                    `For server work, prefer trying ${remoteToolId} before asking the user for host details again.`,
                    'do not repeat the same command back-to-back without an intervening fix or new reason.',
                    'Assume a Linux server and prefer Ubuntu-friendly commands unless tool results prove otherwise.',
                    'For remote-build work, verify architecture with uname -m before installing binaries and prefer arm64/aarch64 assets when applicable.',
                    'For Kubernetes troubleshooting, if a pod describe or status result shows CrashLoopBackOff, an init container failure, or Exit Code > 0, the next step is usually kubectl logs for the failing container or init container rather than asking the user what to run next.',
                    'Prefer common built-ins and standard utilities. If a nonstandard tool may be missing, use a fallback such as find/grep instead of rg, ss instead of netstat, and ip addr instead of ifconfig. Prefer kubectl or k3s kubectl for host workloads; do not assume Docker exists on the host.',
                ]
                : remoteToolId
                    ? [
                        `${remoteToolId} is still available for this request even if the runtime target is not yet verified in this prompt.`,
                        `Do not claim ${remoteToolId} is unavailable; call it when SSH or remote-build work is requested and let the tool return the actual missing-target or credential error if configuration is incomplete.`,
                        'do not repeat the same command back-to-back without an intervening fix or new reason.',
                        'For Kubernetes pod failures, follow describe/status output with kubectl logs for the failing container before handing work back to the user.',
                        'When planning server commands, prefer Ubuntu-friendly standard utilities and avoid assuming rg, Docker, ifconfig, netstat, or docker-compose are installed.',
                      ]
                    : []),
        ].join('\n');

        const plannerStartedAt = new Date().toISOString();
        const plannerOutput = await this.completeText(prompt, {
            ...roleOptions,
            onModelResponse: (response) => appendModelResponseTrace(executionTrace, response, {
                phase: 'planner',
                startedAt: plannerStartedAt,
            }),
        });
        const parsed = safeJsonParse(plannerOutput);
        const plannerReturnedSteps = Array.isArray(parsed?.steps);
        const requestedSteps = (Array.isArray(parsed?.steps) ? parsed.steps : [])
            .slice(0, MAX_PLAN_STEPS)
            .map((step) => this.normalizePlannedStep(step, {
                objective,
                session,
                executionProfile,
                recentMessages,
                toolContext,
            }))
            .filter((step) => step.tool && toolPolicy.candidateToolIds.includes(step.tool))
            .filter((step) => this.isPlannerStepAllowed(step, {
                toolPolicy,
                toolEvents,
            }));

        if (requestedSteps.length > 0) {
            const validated = validatePlan(requestedSteps, {
                candidateToolIds: toolPolicy.candidateToolIds,
                contracts: toolPolicy.toolContracts || {},
            });
            if (validated.rejected.length > 0 && toolPolicy.orchestrationRewrite?.enabled) {
                console.warn('[ConversationOrchestrator] Planner returned rejected tool steps:', validated.rejected.map((entry) => ({
                    tool: entry.step?.tool,
                    rejections: entry.rejections,
                })));
            }
            if (validated.steps.length > 0) {
                return validated.steps;
            }
        }

        if (plannerReturnedSteps && Array.isArray(parsed?.steps) && parsed.steps.length === 0) {
            return [];
        }

        const fallbackPlan = this.buildFallbackPlan({
            objective,
            session,
            recentMessages,
            toolContext,
            executionProfile,
            toolPolicy,
            toolEvents,
        }).slice(0, MAX_PLAN_STEPS);
        return validatePlan(fallbackPlan, {
            candidateToolIds: toolPolicy.candidateToolIds,
            contracts: toolPolicy.toolContracts || {},
        }).steps;
    }

    async executePlan({
        plan = [],
        toolManager = null,
        sessionId = 'default',
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        toolPolicy = {},
        toolContext = {},
        objective = '',
        session = null,
        recentMessages = [],
        previousToolEvents = [],
        autonomyDeadline = null,
        executionTrace = [],
        round = null,
        harnessRun = null,
        onProgress = null,
    }) {
        const toolEvents = [];
        let budgetExceeded = false;
        if (!toolManager) {
            return {
                toolEvents,
                budgetExceeded,
            };
        }

        for (let index = 0; index < plan.length; index += 1) {
            if (Number.isFinite(autonomyDeadline) && Date.now() >= autonomyDeadline) {
                budgetExceeded = true;
                break;
            }

            const step = this.normalizePlannedStep(plan[index], {
                objective,
                session,
                executionProfile,
                recentMessages,
                toolContext,
            });
            const templateContext = buildPlanTemplateContext([
                ...(Array.isArray(previousToolEvents) ? previousToolEvents : []),
                ...toolEvents,
            ]);
            step.params = resolvePlanParamTemplates(step.params || {}, templateContext, [], {
                browserReachableUrls: step.tool === 'web-scrape',
            });
            const unresolvedUrlTemplates = findUnresolvedUrlTemplates(step.params || {});
            if (unresolvedUrlTemplates.length > 0) {
                const unresolvedText = unresolvedUrlTemplates
                    .map((entry) => `${entry.path || 'params'}=${entry.value}`)
                    .join(', ');
                const error = new Error(`Unresolved plan URL template(s): ${unresolvedText}`);
                const toolEndedAt = new Date().toISOString();
                const normalizedResult = normalizeToolResult({
                    success: false,
                    toolId: step.tool,
                    error: error.message,
                    startedAt: toolEndedAt,
                    endedAt: toolEndedAt,
                }, step.tool);
                const toolCall = {
                    id: `tool_call_${index + 1}`,
                    type: 'function',
                    function: {
                        name: step.tool,
                        arguments: JSON.stringify(step.params || {}),
                    },
                };
                const toolEvent = {
                    toolCall,
                    result: normalizedResult,
                    reason: step.reason,
                };
                const classification = classifyToolExecutionResult(toolEvent, {
                    executionProfile,
                    budgetExceeded: false,
                });
                toolEvents.push(toolEvent);
                harnessRun?.recordToolEvent?.(toolEvent, { round, classification });
                executionTrace.push(createExecutionTraceEntry({
                    type: 'tool_call',
                    name: `Tool call (${step.tool})`,
                    startedAt: normalizedResult.startedAt,
                    endedAt: normalizedResult.endedAt,
                    status: 'error',
                    details: {
                        round,
                        reason: step.reason,
                        paramKeys: Object.keys(step.params || {}).sort(),
                        error: normalizedResult.error,
                        diagnostics: normalizedResult.diagnostics || null,
                        classification,
                        stateChanged: false,
                    },
                }));
                emitConversationProgress(onProgress, {
                    phase: 'blocked',
                    detail: normalizedResult.error,
                    plan,
                    activePlanIndex: -1,
                    completedPlanSteps: index,
                    failedPlanStepIndex: index,
                });
                break;
            }
            const toolCall = {
                id: `tool_call_${index + 1}`,
                type: 'function',
                function: {
                    name: step.tool,
                    arguments: JSON.stringify(step.params || {}),
                },
            };
            const toolStartedAt = new Date().toISOString();
            emitConversationProgress(onProgress, {
                phase: 'executing',
                detail: step.reason || `Running ${normalizeInlineText(step.tool).replace(/[_-]+/g, ' ')}`,
                plan,
                activePlanIndex: index,
                completedPlanSteps: index,
                failedPlanStepIndex: -1,
            });

            try {
                const effectiveRecentMessages = Array.isArray(toolContext?.recentMessages)
                    ? toolContext.recentMessages
                    : recentMessages;
                const result = await toolManager.executeTool(step.tool, step.params || {}, {
                    sessionId,
                    executionProfile,
                    toolManager,
                    validateToolPlan: toolPolicy?.orchestrationRewrite?.enabled === true,
                    tools: {
                        get: (toolId) => toolManager.getTool(toolId),
                    },
                    timestamp: new Date().toISOString(),
                    ...toolContext,
                    recentMessages: effectiveRecentMessages,
                });
                const toolEndedAt = new Date().toISOString();
                const normalizedResult = normalizeToolResult(result, step.tool, {
                    startedAt: toolStartedAt,
                    endedAt: toolEndedAt,
                });
                const toolEvent = {
                    toolCall,
                    result: normalizedResult,
                    reason: step.reason,
                };
                const classification = classifyToolExecutionResult(toolEvent, {
                    executionProfile,
                    budgetExceeded: false,
                });
                const stateChanged = doesToolEventChangeState(toolEvent);
                toolEvents.push(toolEvent);
                harnessRun?.recordToolEvent?.(toolEvent, { round, classification });
                for (const evidence of inferCompletionEvidenceFromToolEvent(toolEvent, { round })) {
                    harnessRun?.recordEvidence?.(evidence);
                }
                executionTrace.push(createExecutionTraceEntry({
                    type: 'tool_call',
                    name: `Tool call (${step.tool})`,
                    startedAt: normalizedResult.startedAt,
                    endedAt: normalizedResult.endedAt,
                    status: normalizedResult.success ? 'completed' : 'error',
                    details: {
                        round,
                        reason: step.reason,
                        paramKeys: Object.keys(step.params || {}).sort(),
                        error: normalizedResult.error || null,
                        diagnostics: normalizedResult.diagnostics || null,
                        classification,
                        stateChanged,
                    },
                }));
                emitConversationProgress(onProgress, {
                    phase: normalizedResult.success ? 'executing' : 'blocked',
                    detail: normalizedResult.success
                        ? `Completed ${normalizeInlineText(step.tool).replace(/[_-]+/g, ' ')}`
                        : (normalizedResult.error || `The ${normalizeInlineText(step.tool).replace(/[_-]+/g, ' ')} step failed.`),
                    plan,
                    activePlanIndex: normalizedResult.success && index + 1 < plan.length ? index + 1 : -1,
                    completedPlanSteps: normalizedResult.success ? (index + 1) : index,
                    failedPlanStepIndex: normalizedResult.success ? -1 : index,
                });
                budgetExceeded = budgetExceeded || (Number.isFinite(autonomyDeadline) && Date.now() >= autonomyDeadline);

                if (result?.success === false || budgetExceeded) {
                    break;
                }
            } catch (error) {
                const toolEndedAt = new Date().toISOString();
                const normalizedResult = normalizeToolResult({
                    success: false,
                    toolId: step.tool,
                    error: error.message,
                    startedAt: toolStartedAt,
                    endedAt: toolEndedAt,
                }, step.tool);
                const toolEvent = {
                    toolCall,
                    result: normalizedResult,
                    reason: step.reason,
                };
                const classification = classifyToolExecutionResult(toolEvent, {
                    executionProfile,
                    budgetExceeded: false,
                });
                const stateChanged = doesToolEventChangeState(toolEvent);
                toolEvents.push(toolEvent);
                harnessRun?.recordToolEvent?.(toolEvent, { round, classification });
                executionTrace.push(createExecutionTraceEntry({
                    type: 'tool_call',
                    name: `Tool call (${step.tool})`,
                    startedAt: normalizedResult.startedAt,
                    endedAt: normalizedResult.endedAt,
                    status: 'error',
                    details: {
                        round,
                        reason: step.reason,
                        paramKeys: Object.keys(step.params || {}).sort(),
                        error: normalizedResult.error || null,
                        diagnostics: normalizedResult.diagnostics || null,
                        classification,
                        stateChanged,
                    },
                }));
                emitConversationProgress(onProgress, {
                    phase: 'blocked',
                    detail: normalizedResult.error || `The ${normalizeInlineText(step.tool).replace(/[_-]+/g, ' ')} step failed.`,
                    plan,
                    activePlanIndex: -1,
                    completedPlanSteps: index,
                    failedPlanStepIndex: index,
                });
                budgetExceeded = budgetExceeded || (Number.isFinite(autonomyDeadline) && Date.now() >= autonomyDeadline);
                break;
            }
        }

        return {
            toolEvents,
            budgetExceeded,
        };
    }

    async repairInvalidFinalResponse({
        invalidOutput = '',
        objective = '',
        instructions = '',
        contextMessages = [],
        recentMessages = [],
        model = null,
        reasoningEffort = null,
        signal = null,
        taskType = 'chat',
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        toolPolicy = {},
        toolEvents = [],
        runtimeMode = 'plain',
        autonomyApproved = false,
        executionTrace = [],
        clientSurface = '',
    }) {
        const runtimeInstructions = this.buildRuntimeInstructions({
            baseInstructions: instructions,
            objective,
            executionProfile,
            allowedToolIds: toolPolicy.allowedToolIds,
            toolEvents,
            toolPolicy,
            clientSurface,
        });
        const roleOptions = resolveRoleExecutionOptions({
            role: 'repair',
            model,
            reasoningEffort,
            toolPolicy,
            toolEvents,
        });

        const repairPrompt = [
            'The previous draft was invalid after verified tool execution.',
            'It may have denied runtime tool access, returned a tool-call wrapper object, leaked a remote-command JSON payload, or surfaced execution metadata instead of a user-facing answer.',
            'Rewrite the answer using only the verified tool results below.',
            'Do not mention turn-level tool availability, missing tools, sandbox limits, inability to execute commands, raw remote-command JSON payloads, or raw tool-call wrapper fields.',
            'If additional work may still be needed, explain what remains based on the verified results and the user request without claiming the tool is unavailable.',
            'If a tool failed, state the exact tool failure plainly.',
            'Do not mention the local CLI environment, local workspace state, startup health, or shell behavior unless a verified tool result is directly about that.',
            ...(toolPolicy?.classification?.groundingRequirement === 'required'
                ? [
                    'Do not answer with unverified current information. If the verified results are insufficient, say you were not able to verify it yet.',
                    'Treat any recalled memory as supplemental only, not as proof of a current fact.',
                ]
                : []),
            'When the request is research-heavy, synthesize across the verified sources and keep concrete facts, comparisons, and caveats instead of collapsing everything into a shallow summary.',
            `Task type: ${taskType}`,
            ...(taskType === NOTES_EXECUTION_PROFILE
                ? [
                    'This is a notes-surface request.',
                    'If the user is editing the page, return `notes-actions` or page-ready notes content, not raw standalone HTML or workspace/file instructions.',
                    'Do not mention local workspace writes, `/app`, or shell failures in the repaired answer.',
                ]
                : []),
            '',
            'User request:',
            objective || '(empty)',
            '',
            'Previous invalid draft:',
            invalidOutput || '(empty)',
            '',
            ...(extractVerifiedImageEmbeds(toolEvents).length > 0
                ? [
                    'Verified embeddable images:',
                    ...extractVerifiedImageEmbeds(toolEvents),
                    '',
                    'Reuse those image embeds directly when they satisfy the request.',
                    '',
                ]
                : []),
            ...(buildResearchDossierFromToolEvents({ objective, toolEvents })
                ? [
                    'Research dossier:',
                    buildResearchDossierFromToolEvents({ objective, toolEvents }),
                    '',
                ]
                : []),
            'Verified tool results:',
            buildVerifiedToolFindingsText(toolEvents) || '(none)',
        ].join('\n');

        const response = recoverEmptyModelResponse(await this.requestResponse({
            input: repairPrompt,
            instructions: runtimeInstructions,
            contextMessages,
            recentMessages,
            stream: false,
            model: roleOptions.model,
            reasoningEffort: roleOptions.reasoningEffort,
            signal,
            enableAutomaticToolCalls: false,
        }), {
            objective,
            toolEvents,
            executionProfile,
            runtimeMode,
            phase: 'repair',
        });

        return this.withResponseMetadata(response, {
            executionProfile,
            runtimeMode,
            finalizationMode: 'repair',
            toolEvents,
            toolPolicy,
            autonomyApproved,
            executionTrace,
        });
    }

    async buildFinalResponse({
        input,
        objective = '',
        instructions = '',
        contextMessages = [],
        recentMessages = [],
        model = null,
        reasoningEffort = null,
        signal = null,
        taskType = 'chat',
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        toolPolicy = {},
        toolEvents = [],
        runtimeMode = 'plain',
        autonomyApproved = false,
        executionTrace = [],
        clientSurface = '',
    }) {
        const runtimeInstructions = this.buildRuntimeInstructions({
            baseInstructions: instructions,
            objective,
            executionProfile,
            allowedToolIds: toolPolicy.allowedToolIds,
            toolEvents,
            toolPolicy,
            clientSurface,
        });
        const roleOptions = resolveRoleExecutionOptions({
            role: toolEvents.length === 0 ? 'direct' : 'synthesis',
            model,
            reasoningEffort,
            toolPolicy,
            toolEvents,
        });
        const notesSurfaceTask = isNotesSurfaceTask({ taskType, executionProfile });

        if (toolEvents.length === 0) {
            const response = recoverEmptyModelResponse(await this.requestResponse({
                input,
                instructions: runtimeInstructions,
                contextMessages,
                recentMessages,
                stream: false,
                model: roleOptions.model,
                reasoningEffort: roleOptions.reasoningEffort,
                signal,
                enableAutomaticToolCalls: false,
            }), {
                objective,
                toolEvents,
                executionProfile,
                runtimeMode,
                phase: 'direct-response',
            });

            return this.withResponseMetadata(response, {
                executionProfile,
                runtimeMode,
                finalizationMode: 'direct-response',
                toolEvents: [],
                toolPolicy,
                autonomyApproved,
                executionTrace,
            });
        }

        const verifiedToolFindings = buildVerifiedToolFindingsText(toolEvents) || '(none)';
        const synthesisPrompt = [
            'Use the verified tool results below to answer the user.',
            'If a tool failed, state the exact failure plainly.',
            ...(notesSurfaceTask
                ? [
                    'This is a notes-surface request.',
                    'If the user is editing the page, you may return a valid `notes-actions` JSON payload or a fenced ```notes-actions payload instead of plain prose.',
                    'If you return `notes-actions`, return only the payload with no assistant wrapper fields.',
                    'Do not stop to ask the user for raw search output or a manual source dump when verified tool results are partial.',
                    'If verified research is incomplete, still build the page structure and any safe stable content you can support. Only include source bookmarks, citations, or image URLs that are actually present in the verified tool results.',
                    'For current or time-sensitive claims, omit unsupported details rather than guessing.',
                    'Do not return standalone HTML, artifact/download language, workspace/file instructions, or shell commentary.',
                ]
                : [
                    'Return plain user-facing text only.',
                    'Do not return JSON, assistant wrapper objects, tool call objects, remote-command payloads, or fields like `role`, `content`, `type`, `name`, `parameters`, `output_text`, or `finish_reason`.',
                    'Do not wrap the final answer in code fences.',
                ]),
            'Do not generate SVG placeholders, HTML overlays, or fake image mockups when verified image URLs are available.',
            'Do not mention the local CLI environment, local workspace state, startup health, or shell behavior unless a verified tool result is directly about that.',
            'Do not claim a deployment is live, publicly reachable, or TLS-ready unless the verified tool results show that evidence directly.',
            'A successful rollout status or Ready pod alone is not enough to prove ingress, DNS, HTTPS, or website availability.',
            ...(toolEvents.some((event) => String(event?.toolCall?.function?.name || event?.result?.toolId || '').trim() === 'remote-cli-agent')
                ? [
                    'For remote-cli-agent results, treat the remote agent final output and returned continuity markers as the authoritative work report.',
                    'Do not answer from progress-card labels, callback envelopes, or generic foreground plan text when the remote-cli-agent result contains a final output.',
                ]
                : []),
            ...(toolPolicy?.classification?.groundingRequirement === 'required'
                ? [
                    'This request requires grounded evidence.',
                    'Do not present current facts unless they are supported by the verified tool results below.',
                    'If the verified tool results are insufficient, say what remains unverified instead of guessing.',
                ]
                : []),
            'If the request is research-heavy, synthesize across the verified sources with concrete detail, cross-source comparison, and caveats instead of flattening the findings into one thin paragraph.',
            ...(notesSurfaceTask
                ? [
                    'If the user is editing the page, return `notes-actions` or page-ready notes content, not raw standalone HTML or workspace/file instructions.',
                    'Do not mention local workspace writes, `/app`, shell startup problems, or generic sandbox limitations unless a verified tool result is directly about that.',
                ]
                : []),
            ...(autonomyApproved && executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
                ? [
                    'The user has already approved continuing through obvious remote-build steps.',
                    'Summarize the work completed in this run and only ask for input if you hit a real blocker or need an external decision.',
                    'Do not turn routine next troubleshooting steps into homework for the user when the runtime could have executed them in this run.',
                ]
                : []),
            `Task type: ${taskType}`,
            '',
            'User request:',
            objective || '(empty)',
            '',
            ...(extractVerifiedImageEmbeds(toolEvents).length > 0
                ? [
                    'Verified embeddable images:',
                    ...extractVerifiedImageEmbeds(toolEvents),
                    '',
                    'Reuse those image embeds directly when they satisfy the request.',
                    '',
                ]
                : []),
            ...(buildResearchDossierFromToolEvents({ objective, toolEvents })
                ? [
                    'Research dossier:',
                    buildResearchDossierFromToolEvents({ objective, toolEvents }),
                    '',
                ]
                : []),
            ...(hasUnpersistedImageGeneration(toolEvents)
                ? [
                    'Image generation warning: the tool returned usable image data but no reusable artifact was persisted. Do not invent image URLs; state the diagnostic summary instead.',
                    '',
                ]
                : []),
            'Verified tool results:',
            verifiedToolFindings,
        ].join('\n');

        console.log(`[ConversationOrchestrator] Tool synthesis request: toolEvents=${toolEvents.length}, autonomyApproved=${autonomyApproved}, findingsChars=${verifiedToolFindings.length}, contextMessages=${contextMessages.length}, recentMessages=${recentMessages.length}`);

        const synthesisStartedAt = new Date().toISOString();
        let response = await this.requestResponse({
            input: synthesisPrompt,
            instructions: runtimeInstructions,
            contextMessages,
            recentMessages,
            stream: false,
            model: roleOptions.model,
            reasoningEffort: roleOptions.reasoningEffort,
            signal,
            enableAutomaticToolCalls: false,
        });

        if (!extractResponseText(response).trim()) {
            console.warn(`[ConversationOrchestrator] Tool synthesis returned empty output; retrying with compact prompt. toolEvents=${toolEvents.length}, autonomyApproved=${autonomyApproved}`);
            appendModelResponseTrace(executionTrace, response, {
                phase: 'tool-synthesis-empty',
                startedAt: synthesisStartedAt,
                toolEvents,
            });
            response = await this.requestResponse({
                input: buildCompactToolSynthesisPrompt({
                    objective,
                    taskType,
                    executionProfile,
                    toolEvents,
                }),
                instructions: notesSurfaceTask
                    ? 'Return only a valid `notes-actions` payload or page-ready notes content for the current notes page.'
                    : 'Return plain user-facing text only.',
                contextMessages: [],
                recentMessages: [],
                stream: false,
                model: roleOptions.model,
                reasoningEffort: roleOptions.reasoningEffort,
                signal,
                enableAutomaticToolCalls: false,
            });
        }

        response = recoverEmptyModelResponse(response, {
            objective,
            toolEvents,
            executionProfile,
            runtimeMode,
            phase: 'tool-synthesis',
        });

        return this.withResponseMetadata(response, {
            executionProfile,
            runtimeMode,
            finalizationMode: 'tool-synthesis',
            toolEvents,
            toolPolicy,
            autonomyApproved,
            executionTrace,
        });
    }

    buildRuntimeInstructions({
        baseInstructions = '',
        objective = '',
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        allowedToolIds = [],
        toolEvents = [],
        toolPolicy = {},
        clientSurface = '',
    }) {
        const remoteToolId = getPreferredRemoteToolId(toolPolicy);
        const userCheckpointPolicy = toolPolicy?.userCheckpointPolicy || {};
        const isSurveyResponseTurn = userCheckpointPolicy.surveyResponseTurn === true;
        const canUseUserCheckpoint = allowedToolIds.includes(USER_CHECKPOINT_TOOL_ID)
            && userCheckpointPolicy.enabled === true
            && Number(userCheckpointPolicy.remaining || 0) > 0
            && !userCheckpointPolicy.pending
            && !isSurveyResponseTurn;
        const normalizedClientSurface = String(clientSurface || '').trim().toLowerCase();
        const parts = [
            String(baseInstructions || '').trim(),
            `Execution profile: ${executionProfile}.`,
        ];

        if (executionProfile === NOTES_EXECUTION_PROFILE) {
            parts.push(buildNotesSynthesisInstructions());
        }

        if (normalizedClientSurface === 'web-chat') {
            parts.push('On web-chat, fenced `html` code blocks render as live sandboxed previews inside the message.');
            parts.push('On web-chat, generated HTML artifacts render inline and remain downloadable.');
            parts.push('When the user asks to create, build, generate, or produce HTML, prefer an HTML artifact instead of pasting the full page into chat prose.');
            parts.push('For web-chat website, web page, sandbox preview, or full-site requests, create a previewable HTML/site artifact first. Do not use remote-command or SSH just to create the web-chat sandbox preview.');
            parts.push('If the user later asks to publish a generated site artifact, use the managed-app/export path when available; do not invent an ad hoc SSH deployment from the chat answer.');
            parts.push('Use inline ```html``` only for short snippets, examples, or when the user explicitly wants the markup directly in the conversation.');
        }

        if (allowedToolIds.length > 0) {
            parts.push(`Runtime-available tools for this request: ${allowedToolIds.join(', ')}.`);
            parts.push('Do not claim tools are unavailable if they are listed as runtime-available tools.');
        }

        if (toolPolicy?.classification) {
            parts.push(`Request classification: task family ${toolPolicy.classification.taskFamily}, surface ${toolPolicy.classification.surfaceMode}, preferred path ${toolPolicy.classification.preferredExecutionPath}, confidence ${Number(toolPolicy.classification.confidence || 0).toFixed(2)}.`);
            if (toolPolicy.classification.groundingRequirement === 'required') {
                parts.push('This request requires grounding. Treat recalled memory as supplemental only and base any current-information answer on verified web or tool results.');
            }
            if (toolPolicy.classification.checkpointNeed === 'required') {
                parts.push('This request has a required decision gate before major work. Prefer `user-checkpoint` over guessing or overcommitting to one implementation path.');
            }
        }

        if (toolPolicy?.rolePipeline) {
            parts.push(`Active agent role contracts:\n${formatAgentRolePipelineForPrompt(toolPolicy.rolePipeline)}`);
            parts.push('Use the role contracts as bounded autonomy: orchestrate the sequence, gather research/design handoff artifacts where required, build from those specs, verify, and then integrate the final response.');
            if (toolPolicy.rolePipeline.requiresDesign && allowedToolIds.includes('design-resource-search')) {
                parts.push('Use `design-resource-search` as the design agent resource lane for curated fonts, styling, icons, safe visual sources, and website/document design references.');
            }
            if (toolPolicy.rolePipeline.requiresSandbox && allowedToolIds.includes('code-sandbox')) {
                parts.push('For website/dashboard/front-end/game/Vite outputs, produce a previewable sandbox project. Prefer `document-workflow generate-suite` with `buildMode:"sandbox"`/`useSandbox:true`, or use `code-sandbox` only in `mode:"project"` with files.');
                parts.push('Apply the Impressive Frontend Websites and Sandbox Vite Games standards for sandbox frontend builds: infer the brief, make the first viewport specific, include relevant assets and real controls/states/interactions, use a game loop or workflow state machine when needed, verify nonblank canvas/WebGL, avoid generic placeholders and one-note palettes, inspect opened UI states, and refine after the first render when the work is non-trivial.');
            }
            if (toolPolicy.rolePipeline.requiresSandbox && allowedToolIds.includes('web-scrape')) {
                parts.push('For website/dashboard/front-end QA, use Playwright-backed `web-scrape` with `browser:true`, `captureScreenshot:true`, and desktop plus mobile `viewport` values once a preview or public URL exists. Omit `selectors` for screenshot-only QA.');
                parts.push('When a QA screenshot step follows a sandbox build, use the actual preview/public URL from the tool result, or `{{lastPreviewUrl}}` only for a URL produced earlier in the same runtime plan.');
            }
            parts.push('For slides, slide decks, presentations, and PowerPoint requests, default the final deliverable to PPTX unless the user explicitly asks for interactive or HTML output; an HTML sandbox preview can be a companion design stage, but not the final replacement.');
            parts.push('For PDF, PPTX, HTML, XLSX, or multi-format document packages, let the builder role produce concrete `document-workflow` artifacts. Use `generate-suite` when multiple formats or an HTML preview companion are needed.');
        }

        if (canUseUserCheckpoint) {
            parts.push('Use `user-checkpoint` when one high-impact decision would materially change the plan before major implementation, refactoring, or other long multi-step work.');
            parts.push('On web-chat, treat `user-checkpoint` as the primary quick way to involve the user when one concise choice or direction check would help.');
            parts.push('On web-chat, `user-checkpoint` renders as an inline popup-style survey card with clickable choices, so prefer it over a plain-text multiple-choice question.');
            parts.push('Keep checkpoint surveys concise: one card with one visible step at a time. Prefer 1 question by default, or a short 2 to 4 step questionnaire when the user explicitly wants structured intake.');
            parts.push('Supported step types are choice, multi-choice, text, date, time, and datetime. For choice steps, use 2 to 4 strong options and leave the free-text field available when helpful.');
            parts.push('Do not turn checkpoints into long questionnaires, pages of questions, or more than 6 steps.');
            parts.push('When the latest user turn starts with `Survey response (`, treat that as a resolved checkpoint answer and continue the work instead of asking another survey.');
            parts.push('For research, web-search, web-fetch, or web-scrape work, avoid long scrape surveys and example-heavy intake. If clarification is truly needed, use one short choice hotlist with 2 to 4 concrete options, then continue after the answer.');
        } else if (userCheckpointPolicy.enabled === true && userCheckpointPolicy.pending) {
            parts.push('A `user-checkpoint` is already pending for this session. Do not ask another survey question until the user answers it.');
        } else if (isSurveyResponseTurn) {
            parts.push('The latest user turn is a checkpoint answer. Continue execution from that decision instead of opening a new checkpoint.');
        }

        if (toolPolicy?.workflow?.status === 'active') {
            parts.push(`Active foreground workflow: ${toolPolicy.workflow.lane || 'unknown'} lane, ${toolPolicy.workflow.stage || 'planned'} stage.`);
            if (Array.isArray(toolPolicy.workflow.taskList) && toolPolicy.workflow.taskList.length > 0) {
                parts.push('Current workflow task list:');
                toolPolicy.workflow.taskList.forEach((task) => {
                    parts.push(`- [${task.status || 'planned'}] ${task.title}`);
                });
            }
            parts.push('Treat the active workflow as the current project plan. Continue from the next incomplete task unless the user explicitly changes scope, tells you to stop, or asks to defer the work into a later scheduled workload.');
            parts.push('If the user reply is just feedback, timing, or a checkpoint answer, use it to update your understanding and keep moving through the current workflow instead of switching to a different agent lane.');
        }

        if (toolPolicy?.projectPlan) {
            parts.push(formatProjectExecutionContext(toolPolicy.projectPlan));
            if (toolPolicy.projectPlan.status === 'active') {
                parts.push('Use the foreground session project plan as the default task list for this conversation.');
                parts.push('Advance the active milestone before starting unrelated new scope.');
                parts.push('If the user changes a detail, skips a step, or answers a checkpoint, update your execution against the same project plan instead of treating the turn like a brand-new project.');
                parts.push('For concept-to-build projects, keep continuity across turns: idea brief -> local sandbox prototype -> remote CLI promotion/deploy -> page update/Git save -> follow-up repo work. Do not collapse that journey into a one-shot answer unless the user explicitly asks for only advice.');
            } else if (toolPolicy.projectPlan.status === 'blocked') {
                parts.push('The foreground session project plan is blocked. Focus on resolving the active blocker or asking the user for the one decision that can unblock it.');
            }
        }
        if (toolPolicy?.activeTaskFrame?.objective) {
            parts.push(`Active task frame: ${toolPolicy.activeTaskFrame.objective}`);
            if (toolPolicy.activeTaskFrame.nextSensibleStep) {
                parts.push(`Next sensible step: ${toolPolicy.activeTaskFrame.nextSensibleStep}`);
            }
            if (Array.isArray(toolPolicy.activeTaskFrame.unresolvedBlockers) && toolPolicy.activeTaskFrame.unresolvedBlockers.length > 0) {
                parts.push(`Known blockers: ${toolPolicy.activeTaskFrame.unresolvedBlockers.join('; ')}`);
            }
        }

        if (toolPolicy?.clusterRegistrySummary) {
            parts.push(`Cluster registry memory:\n${toolPolicy.clusterRegistrySummary}`);
            parts.push('Treat the cluster registry as durable context from earlier verified remote tool runs. Use it to avoid starting from scratch, but still re-verify rollout, ingress, TLS, and public reachability before claiming a deployment is live.');
            parts.push('For k3s Ingress or TLS route changes, use `node bin/kimibuilt-ingress.js` through remote-command so Traefik, cert-manager, Let\'s Encrypt, and registry updates stay consistent; do not switch this cluster to nginx ingress by assumption.');
        }

        if (toolPolicy?.remoteCliInventorySummary) {
            parts.push(`Remote CLI runtime inventory:\n${toolPolicy.remoteCliInventorySummary}`);
            parts.push('Use `remote-command` to run commands through the online remote runner and prefer commands that match the reported remote CLI inventory.');
            if (allowedToolIds.includes('remote-cli-agent')) {
                parts.push('For remote app, website, service, dashboard, or frontend work that needs changes deployed, prefer `remote-cli-agent` with `adminMode:true` so the remote coding agent can use the configured admin-capable CLI runner lane for the scoped deployment.');
                parts.push('For remote website/dashboard/front-end builds, pass the Impressive Frontend Websites standard into the remote agent objective and hold deploy readiness on desktop/mobile visual QA plus a refinement pass for non-trivial UI.');
                parts.push('If a remote CLI agent run requests a user choice, forward the concise question and continue the same session with the answer. If it repeats the same blocked command or root error twice without a changed strategy, stop that loop and surface the blocker.');
            }
            if (/Browser visual QA:/i.test(toolPolicy.remoteCliInventorySummary)) {
                parts.push('For remote website builds, the runner can execute Playwright visual QA. Use the reported UI screenshot command against the local preview or public URL and inspect the JSON report before finalizing.');
            }
        }

        if (allowedToolIds.includes('remote-workbench')) {
            parts.push('Use `remote-workbench` for structured remote repo and file actions (`repo-map`, `changed-files`, `grep`, `read-file`, `write-file`, `apply-patch`), build/test actions, logs, rollout, and deploy verification. Use `remote-command` for one-off expert shell that does not fit those actions.');
        }

        if (shouldHydrateRemoteOpsGuidance({
            objective,
            instructions: baseInstructions,
            executionProfile,
            allowedToolIds,
            toolPolicy,
        })) {
            parts.push(`Hydrated remote ops guidance from local project docs:\n${HYDRATED_REMOTE_OPS_GUIDANCE_TEXT}`);
        }

        parts.push('Treat the local CLI environment, workspace state, filesystem contents, and shell behavior as unknown unless explicit user input, the active transcript, or verified tool results establish them.');
        parts.push('Do not comment on local environment health, startup state, writable paths, repository cleanliness, or command availability unless a verified tool result is directly about that.');

        if (allowedToolIds.includes('architecture-design')) {
            parts.push('Use `architecture-design` when the user asks for architecture recommendations, system design, or deployment/component overviews.');
        }

        if (allowedToolIds.includes('uml-generate')) {
            parts.push('Use `uml-generate` for class, sequence, activity, component, or state diagrams instead of hand-writing ad hoc diagram syntax.');
        }

        if (allowedToolIds.includes('api-design')) {
            parts.push('Use `api-design` for REST, OpenAPI, GraphQL, or gRPC contract design work.');
        }

        if (allowedToolIds.includes('schema-generate')) {
            parts.push('Use `schema-generate` for DDL, ORM schema generation, or ER-style database design output.');
        }

        if (allowedToolIds.includes('migration-create')) {
            parts.push('Use `migration-create` when the user asks for schema diffs or migration up/down scripts.');
        }

        if (allowedToolIds.includes('security-scan')) {
            parts.push('Use `security-scan` for code audits, secret detection, and vulnerability checks when code is available in the request.');
        }

        if (allowedToolIds.includes('git-safe')) {
            parts.push('Use `git-safe` for restricted local repository save flows: status, add, commit, push, and save-and-push.');
            parts.push('Use `git-safe remote-info` when you need to verify the current branch, HEAD revision, upstream tracking, or configured remotes before pushing.');
            parts.push('Treat the local workspace repository as the source of truth for authoring and GitHub pushes unless the user explicitly says the canonical repo lives on the server.');
            parts.push('Treat that local repository rule as a default authoring target, not proof of the repository\'s current health, cleanliness, or contents. Verify those facts with tools before stating them.');
            parts.push('Do not claim generic local shell or sandbox limits for Git work when `git-safe` is available. Continue through the constrained Git tool path instead.');
        }

        if (allowedToolIds.includes('web-scrape')) {
            parts.push('Use `web-scrape` for structured extraction from URLs. Prefer `browser: true` for JS-heavy pages or certificate/TLS problems.');
            parts.push('For search-follow-up research, treat the selected search-result host as approved by default and use `researchSafe: true` plus `approvedDomains` so bot-blocked pages are skipped automatically instead of turning source selection back into a user task.');
            parts.push('When browser rendering is enabled, `web-scrape` can execute `actions` such as click, fill, type, press, wait_for_selector, wait_for_timeout, hover, scroll, and select_option before extracting the final page state.');
            parts.push('Use `captureScreenshot: true` in browser mode when a visual snapshot of the rendered page would help later review or UI verification.');
            parts.push('For `web-scrape`, omit `selectors` when only capturing screenshots. If selectors are needed, send an object keyed by field name, not an array.');
            parts.push('For responsive UI/UX self-checks, call `web-scrape` separately with desktop `viewport:{width:1440,height:960}` and mobile `viewport:{width:390,height:844}` so both screenshot artifacts are available for review.');
            parts.push('When the user wants page images from sensitive or adult sites without exposing the model to the content, use `web-scrape` with `captureImages: true` and `blindImageCapture: true` so the backend stores opaque binary artifacts and only returns safe metadata.');
        }

        if (allowedToolIds.includes(DOCUMENT_WORKFLOW_TOOL_ID)) {
            parts.push('Use `document-workflow` to recommend, plan, and generate reports, briefs, HTML documents, and slide decks.');
            parts.push('For routine public research behind those deliverables, discover candidate source URLs through Perplexity-backed `web-search`, choose the strongest sites yourself, verify them with `web-fetch` first, and use `web-scrape` only when deeper extraction is needed instead of asking the user which websites to scrape.');
            parts.push('For research-backed deliverables, gather verified facts with `web-search` and `web-fetch` first, then use `web-scrape` only when a page needs rendered or structured extraction before calling `document-workflow generate` with grounded `sources` built from those verified results.');
            parts.push('For previewable website/dashboard/front-end/game/Vite artifacts, use `document-workflow generate-suite` with `formats:["html"]`, `buildMode:"sandbox"`, and `useSandbox:true` so the workflow can create a sandbox bundle.');
            parts.push('For explicit document packages or web-chat PDF/PPTX/XLSX deliverables, prefer `document-workflow generate-suite` with all requested formats and include `html` as a preview companion when useful.');
            parts.push('Use `document-workflow assemble` when the goal is to compile source material into a straightforward document without heavy rewriting.');
            parts.push('Set `document-workflow includeContent: true` only when a later `file-write` step needs the full HTML or markdown body.');
        }

        if (allowedToolIds.includes('podcast')) {
            parts.push('Use `podcast` when the user wants a researched podcast episode, two-host script, voice synthesis, or final stitched podcast audio.');
            parts.push('When the user asks for a video podcast or podcast video, call `podcast` with `includeVideo: true`, `videoRenderMode: "storyboard"`, `videoImageMode: "mixed"`, and `videoGenerateImages: true` unless the user explicitly asks for waveform-only or no generated imagery. Use waveform-card for plain MP4/audio-visualizer requests.');
            parts.push('Podcast audio is speaker-only by default. If the user asks to use admin, uploaded, saved, or configured podcast audio sources, set `voiceOnlyAudio:false` and include the requested `includeIntro`, `includeOutro`, and/or `includeMusicBed` flags so the admin Podcast Audio assets are mixed before video rendering.');
            parts.push('When the user asks for a proper, full, longer, detailed, or non-short podcast script, preserve that in the podcast tool parameters with a longer `durationMinutes` and, when appropriate, a `scriptDesign` or `scriptDesignExample`; do not answer with a short single exchange in chat.');
            parts.push('Podcast hosts should not repeatedly explain their own presentation method. Avoid self-referential lines about dissecting, unpacking, cadence, human rhythm, or why they are talking a certain way unless the user explicitly asks for meta commentary.');
            parts.push('Do not treat podcast generation as plain chat writing. Prefer the `podcast` tool over separate `web-search` plus ad hoc scripting when the user is asking for the actual podcast deliverable.');
        }

        if (allowedToolIds.includes(DEEP_RESEARCH_PRESENTATION_TOOL_ID)) {
            parts.push('Use `deep-research-presentation` when the user explicitly wants a research-backed slide deck built through one ordered workflow: planning, multiple research passes, image sourcing, then final presentation generation.');
            parts.push('During that workflow, do not stop to ask for a routine public source list. Discover source URLs through Perplexity search passes, choose the strongest candidates yourself, verify them with `web-fetch` first, and only scrape when a page needs rendered or structured extraction.');
        }

        if (allowedToolIds.includes('asset-search')) {
            parts.push('Use `asset-search` to find earlier, old, existing, uploaded, generated, and saved images, documents, artifacts, and workspace files before asking the user to resend them.');
            parts.push('Use `asset-search kind:"image"` for prior visuals and `asset-search kind:"document"` for PDFs, docs, HTML, markdown, and similar files.');
            parts.push('Set `asset-search includeContent:true` when you need the stored text preview from a document match, and use `refresh:true` if a very recent local file is missing from the index.');
            parts.push('When old files are useful context for a requested change, search for them, read the best matching editable file or artifact content, and use that reference to make the requested update.');
            parts.push('For product-review or product-building requests, treat prior artifacts and documents as part of the product surface. Review them against the user goal and improve the artifact/document itself when editing tools are available, not only the code that produced it.');
        }
        if (allowedToolIds.some((toolId) => String(toolId || '').startsWith('research-bucket-'))) {
            parts.push('Use `research-bucket-*` tools for shared durable bucket references. Treat bucket contents as callable storage, not memory: list/search first, then read only selected files.');
            parts.push('Use `research-bucket-write` or `research-bucket-mkdir` only when the user wants to add or organize bucket material.');
        }
        if (allowedToolIds.some((toolId) => String(toolId || '').startsWith('public-source-'))) {
            parts.push('Use `public-source-*` tools for the durable public API/dashboard/feed/source index. Search or list before fresh discovery when the user asks about reusable public data sources.');
            parts.push('Use `public-source-add` for reusable public endpoints discovered through research, and `public-source-refresh` only when live verification matters.');
        }

        if (toolEvents.length > 0) {
            parts.push('Use the verified tool results as the source of truth over guesses.');
            parts.push('When a verified tool result includes image URLs or markdown image snippets, you may embed them with standard markdown image syntax.');
            parts.push('Do not fabricate SVG overlays, inline HTML image placeholders, or other visual stand-ins when verified image URLs are available.');
            if (toolEvents.some((event) => {
                const toolId = String(event?.result?.toolId || event?.toolCall?.function?.name || '').trim();
                return toolId === 'podcast' && event?.result?.success !== false;
            })) {
                parts.push('If the `podcast` tool already succeeded, do not draft a brand-new podcast script in chat. Confirm completion, summarize the generated episode, and point the user to the produced audio, script, and video artifacts returned by the tool.');
            }
        }

        if (remoteToolId && toolPolicy.hasReachableSshTarget) {
            parts.push(`SSH runtime target is already available${toolPolicy.sshRuntimeTarget ? ` (${toolPolicy.sshRuntimeTarget})` : ''}.`);
            parts.push(`For server work, try ${remoteToolId} against the configured default or sticky session target before asking for host details again.`);
            parts.push('Only ask for SSH connection details after an actual tool failure shows the target is missing or incorrect.');
            parts.push(`When calling ${remoteToolId}, always include a concrete command string. Omitting host/username/port is allowed when the runtime target is already configured, but omitting command is never allowed.`);
            parts.push('do not repeat the same command back-to-back without an intervening fix or new reason.');
            parts.push('Prefer Ubuntu/Linux standard commands and verify architecture with `uname -m` before installing binaries or choosing downloads.');
            parts.push('For Kubernetes pod failures, follow describe/status output with `kubectl logs` for the failing container or init container instead of asking the user to run that next step.');
            parts.push('For remote website or HTML updates, prefer the git-backed remote workspace as the source of truth. Use live files, ConfigMaps, or deployed content only to recover context, then commit the edit before redeploying.');
            parts.push('If the user asks for a fresh replacement page, generate the full HTML remotely, save it in the owning git workspace, set repo-local git identity if needed, commit it, and then roll out the change instead of blocking on a missing local artifact.');
            parts.push('Use fallbacks when common extras are missing: `find`/`grep -R` for `rg`, `ss -tulpn` for `netstat`, and `ip addr` for `ifconfig`. Prefer `kubectl` or `k3s kubectl` for host workloads and do not assume Docker exists on the host.');
        } else if (remoteToolId) {
            parts.push(`${remoteToolId} is available for this request even if the target is not currently verified in the prompt context.`);
            parts.push(`Do not claim the SSH tool is unavailable. Try ${remoteToolId} for explicit SSH or remote-build work and report the concrete tool error if the runtime lacks a configured target.`);
            parts.push(`When calling ${remoteToolId}, always include a concrete command string.`);
            parts.push('do not repeat the same command back-to-back without an intervening fix or new reason.');
            parts.push('When constructing remote commands, assume Ubuntu/Linux defaults first and avoid depending on nonstandard utilities unless you have verified they exist.');
        }

        if (allowedToolIds.includes('k3s-deploy')) {
            parts.push('Use `k3s-deploy` for standard remote deployment flows over SSH: sync a GitHub repo on the server, apply manifests, set deployment images, and check rollout status.');
            parts.push('Do not treat a missing project checkout on the remote host as a blocker for deployment work. `sync-repo` or `sync-and-apply` can clone the configured GitHub repo into the target directory.');
            parts.push('Treat the configured deploy defaults as the KimiBuilt backend self-deploy lane only. Do not assume `kimibuilt/backend` for an unrelated app unless the user explicitly targets that repo, domain, or workload.');
            parts.push('Keep raw SSH available for one-off server configuration and troubleshooting, but use `git-safe` plus `k3s-deploy` when the user wants code pushed to GitHub and then deployed.');
            parts.push('Prefer immutable delivery: local authoring and Git push, then CI or GitHub Actions, then k3s rollout. Avoid treating the live server as the place where software is created unless the user explicitly asks for that workflow.');
            parts.push('Never initialize a new Git repository on the remote host or adopt an arbitrary web root as the canonical project unless the user explicitly asked for that server-local workflow.');
        }

        return parts.filter(Boolean).join('\n\n');
    }

    withResponseMetadata(response = {}, metadata = {}) {
        const existing = response?.metadata && typeof response.metadata === 'object'
            ? response.metadata
            : {};

        return {
            ...response,
            metadata: {
                ...existing,
                ...metadata,
            },
        };
    }

    async completeConversationRun({
        sessionId,
        ownerId = null,
        userText = '',
        objective = '',
        taskType = 'chat',
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        runtimeMode = 'plain',
        toolPolicy = {},
        toolEvents = [],
        output = '',
        finalResponse = {},
        startedAt = Date.now(),
        metadata = {},
        foregroundTurn = null,
        clientSurface = '',
        memoryScope = null,
        memoryKeywords = [],
        memoryTrace = null,
        autonomyApproved = false,
        executionTrace = [],
        stream = false,
        controlStatePatch = {},
        naturalContext = null,
    } = {}) {
        const responseArtifacts = mergeRuntimeArtifacts(
            finalResponse?.metadata?.artifacts || [],
            extractArtifactsFromToolEvents(toolEvents),
        );
        const nextNaturalContext = buildNaturalContextUpdate({
            previous: naturalContext || metadata?.naturalContext || {},
            metadata,
            clientSurface,
            taskType,
            userText,
            assistantText: output,
            artifacts: responseArtifacts,
        });
        const activeTaskFrame = normalizeActiveTaskFrame(controlStatePatch?.activeTaskFrame) || buildActiveTaskFrame({
            objective,
            projectKey: toolPolicy?.projectKey || '',
            clientSurface,
            executionProfile,
            toolEvents,
            projectPlan: toolPolicy?.projectPlan || null,
            workflow: toolPolicy?.workflow || null,
            memoryTrace,
        });
        const harnessSummary = toolPolicy?.harness && typeof toolPolicy.harness === 'object'
            ? toolPolicy.harness
            : (metadata?.harness && typeof metadata.harness === 'object' ? metadata.harness : null);
        const intelligenceSummary = scorePerceivedIntelligence({
            objective,
            memoryTrace,
            executionTrace,
            toolEvents,
            projectKey: toolPolicy?.projectKey || '',
            clientSurface,
            harness: harnessSummary,
        });
        const tracedUsage = extractUsageMetadataFromTrace(executionTrace);
        const hasModelCall = (Array.isArray(executionTrace) ? executionTrace : [])
            .some((step) => step?.type === 'model_call');
        const aggregatedUsage = tracedUsage
            || extractResponseUsageMetadata(finalResponse)
            || (!hasModelCall ? createZeroUsageMetadata() : null);
        const surfaceFinisher = inferSurfaceFinisher({
            taskType,
            clientSurface,
            executionProfile,
        });
        const memoryWriteTargets = {
            conversation: buildScopedMemoryMetadata({
                ...(ownerId ? { ownerId } : {}),
                ...(memoryScope ? { memoryScope } : {}),
                ...(toolPolicy?.projectKey ? { projectKey: toolPolicy.projectKey } : {}),
                sourceSurface: clientSurface || memoryScope || taskType || null,
                memoryClass: 'conversation',
            }),
            projectMemory: toolPolicy?.projectKey
                ? { projectKey: toolPolicy.projectKey, sourceSurface: clientSurface || null }
                : { sessionId },
        };
        let tracedResponse = this.withResponseMetadata(finalResponse, {
            ...(responseArtifacts.length > 0 ? { artifacts: responseArtifacts } : {}),
            projectKey: toolPolicy?.projectKey || null,
            memoryNamespace: memoryTrace?.routing?.memoryNamespace || memoryWriteTargets.conversation?.memoryNamespace || null,
            memoryReadSetSummary: intelligenceSummary.memoryReadSetSummary,
            memoryWriteTargets,
            crossScopeReuse: intelligenceSummary.crossScopeReuse,
            initiativeReview: intelligenceSummary.initiativeReview,
            activeTaskFrame,
            surfaceFinisher,
            agencyProfile: toolPolicy?.agencyProfile || null,
            rolePipeline: toolPolicy?.rolePipeline || null,
            ...(harnessSummary ? { harness: harnessSummary } : {}),
            naturalContext: nextNaturalContext,
            perceivedIntelligenceScores: intelligenceSummary.perceivedIntelligenceScores,
            failureTags: intelligenceSummary.failureTags,
            ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
        });
        if (memoryTrace && config.memory.debugTrace) {
            tracedResponse = this.withResponseMetadata(tracedResponse, {
                memoryTrace,
                runtimeDiagnostics: this.memoryService?.getDiagnostics?.() || null,
            });
        }
        const harnessControlState = buildHarnessControlStateFromSummary(harnessSummary);
        const remoteCliAgentControlState = extractRemoteCliAgentControlStateFromToolEvents(toolEvents);
        const finalControlStatePatch = mergeControlState(
            controlStatePatch,
            mergeControlState(
                mergeControlState(
                    activeTaskFrame ? { activeTaskFrame } : {},
                    remoteCliAgentControlState || {},
                ),
                harnessControlState !== undefined ? { harness: harnessControlState } : {},
            ),
        );
        await this.persistConversationState({
            sessionId,
            ownerId,
            userText: userText || objective,
            objective,
            assistantText: output,
            responseId: tracedResponse.id,
            promptState: tracedResponse?.metadata?.promptState || null,
            toolEvents,
            executionProfile,
            foregroundTurn,
            clientSurface,
            memoryScope,
            memoryKeywords,
            autonomyApproved,
            controlStatePatch: finalControlStatePatch,
            artifacts: responseArtifacts,
            assistantMetadata: tracedResponse?.metadata || null,
            naturalContext: nextNaturalContext,
        });

        const trace = {
            sessionId,
            taskType,
            executionProfile,
            runtimeMode,
            classification: toolPolicy?.classification || null,
            agencyProfile: toolPolicy?.agencyProfile || null,
            projectKey: toolPolicy?.projectKey || null,
            candidateToolScores: toolPolicy?.candidateToolScores || null,
            replanReason: extractLatestReplanReason(executionTrace),
            recallSummary: summarizeRecallTrace(memoryTrace),
            finalizationMode: inferFinalizationMode({
                runtimeMode,
                toolEvents,
                assistantMetadata: tracedResponse?.metadata || null,
            }),
            activeTaskFrame,
            harness: harnessSummary,
            memoryNamespace: tracedResponse?.metadata?.memoryNamespace || null,
            memoryReadSetSummary: intelligenceSummary.memoryReadSetSummary,
            memoryWriteTargets,
            crossScopeReuse: intelligenceSummary.crossScopeReuse,
            initiativeReview: intelligenceSummary.initiativeReview,
            surfaceFinisher,
            perceivedIntelligenceScores: intelligenceSummary.perceivedIntelligenceScores,
            failureTags: intelligenceSummary.failureTags,
            toolCount: toolEvents.length,
            tools: toolPolicy.candidateToolIds,
            duration: Date.now() - startedAt,
            timestamp: new Date().toISOString(),
            autonomyApproved,
            executionTrace,
            ...(memoryTrace && config.memory.debugTrace
                ? {
                    memoryTrace,
                    runtimeDiagnostics: this.memoryService?.getDiagnostics?.() || null,
                }
                : {}),
        };

        this.emit('task:complete', {
            task: { type: taskType, objective },
            sessionId,
            timestamp: Date.now(),
            result: {
                success: true,
                output,
                responseId: tracedResponse.id,
                trace,
                duration: trace.duration,
            },
        });

        if (stream) {
            const syntheticStream = createSyntheticStream(tracedResponse);
            syntheticStream.kimibuiltStreamMode = 'synthetic-orchestrator';
            console.warn(`[ConversationOrchestrator] Stream mode=synthetic-orchestrator sessionId=${sessionId} taskType=${taskType} executionProfile=${executionProfile}`);
            return {
                success: true,
                sessionId,
                response: syntheticStream,
                output,
                trace,
            };
        }

        return {
            success: true,
            sessionId,
            output,
            response: tracedResponse,
            trace,
        };
    }

    async persistConversationState({
        sessionId,
        ownerId = null,
        memoryScope = null,
        userText,
        objective = '',
        assistantText,
        responseId,
        promptState = null,
        toolEvents = [],
        executionProfile = DEFAULT_EXECUTION_PROFILE,
        clientSurface = '',
        memoryKeywords = [],
        autonomyApproved = false,
        controlStatePatch = {},
        artifacts = [],
        assistantMetadata = null,
        foregroundTurn = null,
        naturalContext = null,
    }) {
        const currentSession = ownerId && this.sessionStore?.getOwned
            ? await this.sessionStore.getOwned(sessionId, ownerId)
            : this.sessionStore?.get
                ? await this.sessionStore.get(sessionId)
                : null;
        const resolvedForegroundTurn = resolveForegroundTurn(
            currentSession,
            { foregroundTurn },
            clientSurface,
        );
        const resolvedMemoryScope = resolveSessionScope({
            mode: currentSession?.metadata?.taskType || currentSession?.metadata?.mode || '',
            taskType: currentSession?.metadata?.taskType || '',
            clientSurface: currentSession?.metadata?.clientSurface || currentSession?.metadata?.client_surface || '',
            memoryScope,
        }, currentSession || null);
        const scopedMemoryMetadata = buildScopedMemoryMetadata({
            ...(ownerId ? { ownerId } : {}),
            ...(resolvedMemoryScope ? { memoryScope: resolvedMemoryScope } : {}),
            ...(clientSurface ? { sourceSurface: clientSurface } : {}),
            ...(Array.isArray(memoryKeywords) && memoryKeywords.length > 0 ? { memoryKeywords } : {}),
        }, currentSession || null);
        const persistedArtifacts = mergeRuntimeArtifacts(
            artifacts,
            assistantMetadata?.artifacts || [],
            extractArtifactsFromToolEvents(toolEvents),
        );

        if (this.sessionStore?.recordResponse) {
            if (promptState) {
                await this.sessionStore.recordResponse(
                    sessionId,
                    responseId,
                    { promptState },
                );
            } else {
                await this.sessionStore.recordResponse(sessionId, responseId);
            }
        }

        if (this.memoryService?.rememberResponse) {
            this.memoryService.rememberResponse(sessionId, assistantText, scopedMemoryMetadata);
        }

        if (this.memoryService?.rememberResearchNote) {
            const researchNotes = buildResearchMemoryNotesFromToolEvents({
                objective: userText,
                toolEvents,
            });
            await Promise.all(researchNotes.map((note) => this.memoryService.rememberResearchNote(
                sessionId,
                note,
                scopedMemoryMetadata,
            )));
        }

        if (this.memoryService?.rememberLearnedSkill) {
            await this.memoryService.rememberLearnedSkill(sessionId, {
                objective,
                assistantText,
                toolEvents,
                metadata: scopedMemoryMetadata,
            });
        }

        if (this.sessionStore?.appendMessages) {
            const persistedMessages = String(clientSurface || '').trim().toLowerCase() === 'web-chat'
                ? buildWebChatSessionMessages({
                    userText,
                    assistantText,
                    toolEvents,
                    artifacts: persistedArtifacts,
                    assistantMetadata,
                    ...buildForegroundTurnMessageOptions(resolvedForegroundTurn),
                })
                : [
                    { role: 'user', content: userText },
                    { role: 'assistant', content: assistantText },
                ];
            await persistForegroundTurnMessages(
                this.sessionStore,
                sessionId,
                persistedMessages,
                resolvedForegroundTurn,
            );
        }

        const sshMetadata = extractSshSessionMetadataFromToolEvents(toolEvents);
        const nextControlState = mergeControlState(
            {
                ...(sshMetadata || {}),
                ...(executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
                    && objective
                    && !isRemoteApprovalOnlyTurn(userText)
                    ? { lastRemoteObjective: objective }
                    : {}),
                ...(executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
                    ? { autonomyApproved }
                    : {}),
            },
            controlStatePatch,
        );
        try {
            clusterStateRegistry.recordToolEvents({
                sessionId,
                objective,
                toolEvents,
                controlState: mergeControlState(
                    getSessionControlState(currentSession),
                    nextControlState,
                ),
            });
        } catch (error) {
            console.warn(`[ConversationOrchestrator] Failed to update cluster registry: ${error.message}`);
        }
        const legacyControlMetadata = buildLegacyControlMetadata(nextControlState);

        if (this.sessionStore?.updateControlState && Object.keys(nextControlState).length > 0) {
            await this.sessionStore.updateControlState(sessionId, nextControlState);
        }

        const projectMemory = mergeProjectMemory(
            currentSession?.metadata?.projectMemory || {},
            buildProjectMemoryUpdate({
                userText,
                assistantText,
                toolEvents,
                artifacts: persistedArtifacts,
            }),
        );

        if (this.sessionStore?.update) {
            await this.sessionStore.update(sessionId, {
                metadata: {
                    ...legacyControlMetadata,
                    ...(executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
                        ? { remoteBuildAutonomyApproved: autonomyApproved }
                        : {}),
                    ...(naturalContext ? { naturalContext } : {}),
                    projectMemory,
                },
            });
        }

        if (this.sessionStore?.maybeCompactSession) {
            const effectiveControlState = mergeControlState(
                getSessionControlState(currentSession),
                nextControlState,
            );

            await this.sessionStore.maybeCompactSession(sessionId, {
                ownerId,
                workflow: effectiveControlState.workflow || null,
                projectMemory,
            });
        }
    }

    async completeText(prompt, options = {}) {
        const {
            onModelResponse = null,
            fallbackModels = [],
            ...completionOptions
        } = options || {};
        const modelCandidates = [
            completionOptions.model || null,
            ...(Array.isArray(fallbackModels) ? fallbackModels : []),
        ].filter((entry, index, list) => {
            const normalized = String(entry || '').trim();
            return normalized && list.findIndex((candidate) => String(candidate || '').trim() === normalized) === index;
        });
        if (modelCandidates.length === 0) {
            modelCandidates.push(null);
        }

        let lastError = null;
        for (let index = 0; index < modelCandidates.length; index += 1) {
            const candidateModel = modelCandidates[index];
            const attemptOptions = {
                ...completionOptions,
                model: candidateModel,
            };

            try {
                if (typeof this.llmClient?.complete === 'function') {
                    const completion = await this.llmClient.complete(prompt, attemptOptions);
                    const normalizedResponse = attachEstimatedUsageMetadata(
                        completion && typeof completion === 'object' && !Array.isArray(completion)
                            ? normalizeModelResponseShape(completion)
                            : buildSyntheticResponse({
                            output: String(completion || ''),
                            model: attemptOptions.model || null,
                            }),
                        prompt,
                    );

                    if (typeof onModelResponse === 'function') {
                        onModelResponse(normalizedResponse);
                    }

                    return typeof completion === 'string'
                        ? completion
                        : extractResponseText(normalizedResponse);
                }

                const response = await this.requestResponse({
                    input: prompt,
                    stream: false,
                    model: attemptOptions.model || null,
                    reasoningEffort: attemptOptions.reasoningEffort || null,
                    enableAutomaticToolCalls: false,
                    onModelResponse,
                });

                return extractResponseText(response);
            } catch (error) {
                lastError = error;
                if (index >= modelCandidates.length - 1) {
                    break;
                }
                console.warn(`[ConversationOrchestrator] Orchestration model ${candidateModel || 'default'} failed; trying fallback ${modelCandidates[index + 1]}: ${error.message}`);
            }
        }

        throw lastError || new Error('Orchestration model request failed');
    }

    async requestResponse(params = {}) {
        const {
            onModelResponse = null,
            ...requestParams
        } = params || {};
        let response;
        if (typeof this.llmClient?.createResponse === 'function') {
            response = attachEstimatedUsageMetadata(
                normalizeModelResponseShape(await this.llmClient.createResponse(requestParams)),
                requestParams.input,
            );
        } else {
            console.warn('[ConversationOrchestrator] llmClient.createResponse is unavailable; falling back to openai-client.createResponse');
            response = attachEstimatedUsageMetadata(
                normalizeModelResponseShape(await createResponse(requestParams)),
                requestParams.input,
            );
        }

        if (typeof onModelResponse === 'function') {
            onModelResponse(response);
        }

        return response;
    }
}

module.exports = {
    ConversationOrchestrator,
    HarnessRunState,
    buildDeterministicRecoveryPlanFromFailure,
    classifyToolExecutionResult,
    filterRepeatedPlanStepsWithReport,
    inferAgencyProfile,
    normalizeExecutionProfile,
    DEFAULT_EXECUTION_PROFILE,
    REMOTE_BUILD_EXECUTION_PROFILE,
};

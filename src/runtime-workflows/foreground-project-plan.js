'use strict';

const { getSessionControlState } = require('../runtime-control-state');
const {
    applyProjectPlanPatch,
    normalizeProjectPlan,
    recordProjectReview,
} = require('../workloads/project-plans');
const { hasWorkloadIntent } = require('../workloads/natural-language');

const FOREGROUND_PROJECT_PLAN_KIND = 'foreground-project-plan';
const ACTIVE_PROJECT_PLAN_STATUS = 'active';
const COMPLETED_PROJECT_PLAN_STATUS = 'completed';
const BLOCKED_PROJECT_PLAN_STATUS = 'blocked';
const VALID_PROJECT_PLAN_STATUSES = new Set([
    ACTIVE_PROJECT_PLAN_STATUS,
    COMPLETED_PROJECT_PLAN_STATUS,
    BLOCKED_PROJECT_PLAN_STATUS,
]);
const REMOTE_CLI_CONTEXT_STOP_WORDS = new Set([
    'about',
    'agent',
    'all',
    'and',
    'any',
    'application',
    'build',
    'but',
    'can',
    'change',
    'cli',
    'complete',
    'continue',
    'could',
    'create',
    'current',
    'deploy',
    'finish',
    'fix',
    'for',
    'from',
    'have',
    'into',
    'just',
    'less',
    'make',
    'more',
    'not',
    'only',
    'our',
    'out',
    'please',
    'project',
    'remote',
    'resume',
    'same',
    'some',
    'task',
    'test',
    'that',
    'the',
    'their',
    'there',
    'these',
    'this',
    'those',
    'update',
    'would',
    'with',
    'work',
    'you',
    'your',
]);
const REMOTE_CLI_TOPIC_PATTERNS = Object.freeze({
    frontend: /\b(?:accent|button|card|color|colour|dashboard|footer|frontend|header|hero|homepage|layout|mobile|navigation|page|responsive|sidebar|spacing|style|theme|typography|ui|ux|website)\b/,
    deployment: /\b(?:certificate|cluster|deploy|deployment|dns|domain|https|ingress|k3s|kubernetes|live|pod|publish|release|rollout|route|server|tls)\b/,
    backend: /\b(?:api|backend|database|endpoint|middleware|parser|queue|route|service|worker)\b/,
    document: /\b(?:article|deck|document|docx|manual|markdown|pdf|presentation|proposal|report|slides|spreadsheet|workbook)\b/,
    game: /\b(?:character|game|level|player|score|sprite)\b/,
    data: /\b(?:chart|data|dataset|graph|map|table|visualization)\b/,
});

function normalizeText(value = '') {
    return String(value || '').trim();
}

function truncateText(value = '', limit = 120) {
    const normalized = normalizeText(value);
    if (!normalized || normalized.length <= limit) {
        return normalized;
    }

    return `${normalized.slice(0, limit - 3).trim()}...`;
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
    return /^Survey response \([^)]+\):\s*[\s\S]+$/i.test(normalizeText(text));
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

function hasExplicitProjectResetIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(start over|restart|new project|different project|different task|switch to|switch gears|instead|forget that|drop that|change the plan|rewrite the plan|replace the plan|new direction|unrelated)\b/,
        /^(?:let'?s|lets)\s+(?:do|build|make|create|work on|switch to)\s+(?:something else|another|a different)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function normalizeContextToken(value = '') {
    const token = normalizeText(value).toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
    if (token.length > 5 && token.endsWith('ies')) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.length > 5 && token.endsWith('ing')) {
        return token.slice(0, -3);
    }
    if (token.length > 4 && token.endsWith('ed')) {
        return token.slice(0, -2);
    }
    if (token.length > 4 && token.endsWith('s')) {
        return token.slice(0, -1);
    }
    return token;
}

function collectRemoteCliContextTokens(text = '') {
    return new Set(
        normalizeText(text)
            .toLowerCase()
            .match(/[a-z0-9][a-z0-9._-]{2,}/g)
            ?.map(normalizeContextToken)
            .filter((token) => token.length >= 3 && !REMOTE_CLI_CONTEXT_STOP_WORDS.has(token))
        || [],
    );
}

function collectRemoteCliContextTopics(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    return new Set(
        Object.entries(REMOTE_CLI_TOPIC_PATTERNS)
            .filter(([, pattern]) => pattern.test(normalized))
            .map(([topic]) => topic),
    );
}

function buildRemoteCliContextText({
    storedPlan = null,
    priorAgentState = null,
    priorObjective = '',
} = {}) {
    const normalizedPlan = normalizeForegroundProjectPlan(storedPlan);
    const milestones = Array.isArray(normalizedPlan?.milestones) ? normalizedPlan.milestones : [];
    return [
        priorObjective,
        priorAgentState?.lastTask,
        priorAgentState?.whatChanged,
        priorAgentState?.publicHost,
        priorAgentState?.publicUrl,
        priorAgentState?.gitRepo,
        priorAgentState?.cwd,
        normalizedPlan?.title,
        normalizedPlan?.objective,
        ...milestones.flatMap((milestone) => [milestone?.title, milestone?.notes]),
    ].map(normalizeText).filter(Boolean).join('\n');
}

function hasDistinctNewRequestIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    return hasExplicitProjectResetIntent(normalized)
        || /\b(?:new|another|different|fresh|unrelated)\b[\s\S]{0,50}\b(?:app|article|document|game|page|poem|project|report|site|story|task|website)\b/.test(normalized)
        || /\b(?:app|article|document|game|page|poem|report|site|story|website)\b[\s\S]{0,24}\babout\b/.test(normalized)
        || /^(?:please\s+)?(?:can|could|would)\s+you\s+(?:explain|research|summarize|tell me)\b/.test(normalized)
        || /^(?:please\s+)?(?:explain|research|summarize|tell me)\b/.test(normalized)
        || /^(?:please\s+)?make me\b/.test(normalized);
}

function hasRemoteCliFollowupAction(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    return /\b(?:add|adjust|change|check|continue|deploy|edit|finish|fix|keep|make|polish|publish|redo|remove|replace|resume|retry|revise|ship|status|test|tighten|try again|update|verify|write)\b/.test(normalized)
        || /\b(?:is|are|did|does|has|have)\b[\s\S]{0,30}\b(?:broken|complete|deployed|done|failing|fixed|live|ready|running|working)\b/.test(normalized);
}

function hasRemoteCliFollowupReference(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    return /\b(?:it|its|that|those|these|same|existing|current|previous|prior)\b/.test(normalized)
        || /\b(?:the|those|these)\s+(?:accent|app|button|buttons|card|cards|color|colour|dashboard|deployment|game|layout|page|project|site|style|theme|website)\b/.test(normalized);
}

function shouldResumeRemoteCliProject(objective = '', {
    storedPlan = null,
    priorAgentState = null,
    priorObjective = '',
} = {}) {
    const normalizedObjective = normalizeText(objective);
    if (!normalizedObjective || hasWorkloadIntent(normalizedObjective) || hasDistinctNewRequestIntent(normalizedObjective)) {
        return false;
    }

    const contextText = buildRemoteCliContextText({
        storedPlan,
        priorAgentState,
        priorObjective,
    });
    if (!contextText) {
        return false;
    }

    if (
        hasContinuationIntent(normalizedObjective)
        || hasStructuredCheckpointResponse(normalizedObjective)
        || /^(?:yes|yeah|yep|ok|okay|no|nope|not yet|skip)\b/i.test(normalizedObjective)
    ) {
        return true;
    }

    if (!hasRemoteCliFollowupAction(normalizedObjective)) {
        return false;
    }

    const objectiveTokens = collectRemoteCliContextTokens(normalizedObjective);
    const contextTokens = collectRemoteCliContextTokens(contextText);
    if ([...objectiveTokens].some((token) => contextTokens.has(token))) {
        return true;
    }

    const objectiveTopics = collectRemoteCliContextTopics(normalizedObjective);
    const contextTopics = collectRemoteCliContextTopics(contextText);
    return hasRemoteCliFollowupReference(normalizedObjective)
        && [...objectiveTopics].some((topic) => contextTopics.has(topic));
}

function hasSkipInstruction(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\bskip\b/,
        /\bno need to\b/,
        /\bdon'?t\b[\s\S]{0,24}\b(do|run|include|continue|start)\b/,
        /\bwithout\b[\s\S]{0,24}\b(deploy|deployment|verify|verification|test|testing|review|research|inspection|inspect|commit|push|git)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasSubstantialProjectIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(plan|planning|refactor|implement|implementation|build|builds|create|generate|draft|design|deploy|migration|migrate|rewrite|organize|set up|setup|fix|debug|investigate|audit|review|research|compare|write|update|change|supercharge)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function isPlanningOnlyObjective(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    const planningIntent = /\b(plan|planning|research|review|audit|investigate|analyze|analyse|compare|explore|discuss|brainstorm|scope|understand)\b/.test(normalized);
    const implementationIntent = /\b(build|create|make|implement|fix|write|generate|deploy|update|change|refactor|rewrite|draft)\b/.test(normalized);
    return planningIntent && !implementationIntent;
}

function hasConceptToBuildLifecycleIntent(text = '') {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    const conceptCue = /\b(idea|concept|product idea|app idea|mvp|prototype|proof of concept|poc|normal|natural)\b/.test(normalized);
    const softwareCue = /\b(software|development|app|application|site|website|websites|webpage|webpages|web app|dashboard|frontend|tool|product|feature|page|repo|repository)\b/.test(normalized);
    const journeyCue = /\b(sandbox|local|locally|remote cli|remote-cli|deploy|publish|ship|git|github|gitlab|repo work|repository work|many sessions|over many sessions|next round|flow|flows)\b/.test(normalized);
    const localToLiveCue = /\b(local builds?|local sandbox|sandbox designs?|sandboxed builds?)\b[\s\S]{0,140}\b(remote builds?|remote cli|remote-cli|live|deploy|publish|promotion|move local to live|local to live)\b/.test(normalized)
        || /\b(remote builds?|remote cli|remote-cli)\b[\s\S]{0,140}\b(local builds?|local sandbox|sandbox designs?|sandboxed builds?|move local to live|local to live)\b/.test(normalized);

    return (conceptCue && softwareCue && journeyCue) || (softwareCue && localToLiveCue);
}

function deriveProjectTitle(objective = '') {
    const normalized = normalizeText(objective)
        .replace(/\s+/g, ' ');
    if (!normalized) {
        return 'Active project';
    }

    const sentence = normalized.split(/[.?!]/)[0].trim();
    return truncateText(sentence || normalized, 72);
}

function inferProjectStatus(project = {}) {
    const milestones = Array.isArray(project.milestones) ? project.milestones : [];
    if (milestones.length === 0) {
        return ACTIVE_PROJECT_PLAN_STATUS;
    }

    if (milestones.every((entry) => ['completed', 'skipped'].includes(entry.status))) {
        return COMPLETED_PROJECT_PLAN_STATUS;
    }

    const activeMilestone = milestones.find((entry) => entry.id === project.activeMilestoneId) || null;
    if (activeMilestone?.status === 'blocked') {
        return BLOCKED_PROJECT_PLAN_STATUS;
    }

    return ACTIVE_PROJECT_PLAN_STATUS;
}

function normalizeForegroundProjectPlan(plan = null) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return null;
    }

    const normalizedProject = normalizeProjectPlan(plan, {
        title: plan.title || 'Active project',
        prompt: plan.objective || '',
    });
    const status = VALID_PROJECT_PLAN_STATUSES.has(normalizeText(plan.status).toLowerCase())
        ? normalizeText(plan.status).toLowerCase()
        : inferProjectStatus(normalizedProject);

    return {
        kind: FOREGROUND_PROJECT_PLAN_KIND,
        status,
        source: normalizeText(plan.source) || 'stored',
        updatedAt: normalizeText(plan.updatedAt || plan.updated_at || '') || new Date().toISOString(),
        ...normalizedProject,
    };
}

function createMilestone(id, title, status = 'planned', extras = {}) {
    return {
        id,
        title,
        status,
        ...extras,
    };
}

function buildMilestonesFromObjective(objective = '') {
    const normalized = normalizeText(objective).toLowerCase();
    if (!normalized) {
        return [
            createMilestone('gather-context', 'Gather context and constraints', 'in_progress'),
            createMilestone('deliver-work', 'Deliver the requested work'),
            createMilestone('validate-result', 'Validate the result'),
        ];
    }

    if (hasConceptToBuildLifecycleIntent(normalized)) {
        return [
            createMilestone('shape-build-idea', 'Shape the idea or goal into a compact build brief', 'in_progress'),
            createMilestone('sandbox-local-prototype', 'Build and review a local sandbox prototype'),
            createMilestone('promote-remote-cli', 'Promote the local prototype to a remote build candidate'),
            createMilestone('deploy-and-verify', 'Deploy live and verify the remote result'),
            createMilestone('save-git-and-continue-repo', 'Save Git state and continue repo work'),
        ];
    }

    if (isPlanningOnlyObjective(normalized)) {
        return [
            createMilestone('gather-context', 'Gather context and constraints', 'in_progress'),
            createMilestone('propose-plan', 'Propose the working plan'),
            createMilestone('confirm-blockers', 'Confirm decisions and blockers'),
        ];
    }

    const milestones = [];
    const shouldInspect = /\b(existing|current|repo|repository|codebase|workspace|project|app|application|server|cluster|k3s|k8s|deployment|document|page|site|notes|report|brief|draft|content)\b/.test(normalized)
        || /\b(research|inspect|review|audit|analyze|analyse|understand|explore|debug|investigate|compare|discover)\b/.test(normalized);
    const shouldImplement = /\b(build|create|make|implement|fix|update|change|refactor|rewrite|add|remove|draft|write|generate|design|organize|polish)\b/.test(normalized);
    const shouldDeploy = /\b(deploy|publish|release|rollout|ship live|go live|push live|commit|push)\b/.test(normalized);
    const deliverableWork = /\b(document|doc|report|brief|proposal|guide|summary|slides|presentation|deck|page|site|html|content|copy|spec)\b/.test(normalized);

    if (shouldInspect) {
        milestones.push(createMilestone('inspect-current-state', 'Inspect the current state', 'in_progress'));
    }

    milestones.push(createMilestone(
        shouldImplement ? 'deliver-requested-work' : 'advance-requested-work',
        shouldImplement
            ? (deliverableWork ? 'Produce the requested deliverable' : 'Implement the requested changes')
            : 'Advance the requested work',
        milestones.length === 0 ? 'in_progress' : 'planned',
    ));

    if (shouldDeploy) {
        milestones.push(createMilestone(
            /\b(commit|push)\b/.test(normalized) && !/\bdeploy|publish|release|rollout\b/.test(normalized)
                ? 'save-or-publish-result'
                : 'deploy-or-publish-result',
            /\b(commit|push)\b/.test(normalized) && !/\bdeploy|publish|release|rollout\b/.test(normalized)
                ? 'Save or publish the result'
                : 'Deploy or publish the result',
        ));
    }

    milestones.push(createMilestone('validate-result', 'Validate and review the result'));

    return milestones;
}

function buildForegroundProjectPlanFromObjective(objective = '', options = {}) {
    const base = normalizeProjectPlan({
        title: deriveProjectTitle(objective),
        objective: normalizeText(objective),
        summary: 'Session-scoped foreground project plan inferred from the active conversation objective.',
        governance: {
            lockedPlan: false,
            modificationPolicy: 'flexible',
        },
        milestones: buildMilestonesFromObjective(objective),
    });

    const next = {
        ...(options.existingPlan || {}),
        ...base,
        kind: FOREGROUND_PROJECT_PLAN_KIND,
        status: ACTIVE_PROJECT_PLAN_STATUS,
        source: options.source || 'objective',
        updatedAt: new Date().toISOString(),
    };

    if (Array.isArray(options.changeLog) && options.changeLog.length > 0) {
        next.changeLog = options.changeLog;
    }

    return normalizeForegroundProjectPlan(next);
}

function buildForegroundProjectPlanFromWorkflow(workflow = null, existingPlan = null) {
    if (!workflow || typeof workflow !== 'object') {
        return normalizeForegroundProjectPlan(existingPlan);
    }

    const taskList = Array.isArray(workflow.taskList) ? workflow.taskList : [];
    const milestones = taskList.map((task, index) => createMilestone(
        normalizeText(task.id) || `task-${index + 1}`,
        normalizeText(task.title) || `Task ${index + 1}`,
        normalizeText(task.status).toLowerCase() || 'planned',
        {
            notes: normalizeText(task.notes || ''),
        },
    ));
    const base = normalizeProjectPlan({
        ...(existingPlan || {}),
        title: deriveProjectTitle(workflow.objective || existingPlan?.title || 'Active project'),
        objective: normalizeText(workflow.objective || existingPlan?.objective || ''),
        summary: 'Session-scoped foreground project plan synced from the active end-to-end workflow.',
        governance: {
            lockedPlan: false,
            modificationPolicy: 'flexible',
        },
        successDefinition: Array.isArray(workflow.completionCriteria) ? workflow.completionCriteria : [],
        milestones: milestones.length > 0 ? milestones : (existingPlan?.milestones || []),
    });

    return normalizeForegroundProjectPlan({
        ...(existingPlan || {}),
        ...base,
        kind: FOREGROUND_PROJECT_PLAN_KIND,
        status: normalizeText(workflow.status).toLowerCase() === 'completed'
            ? COMPLETED_PROJECT_PLAN_STATUS
            : (normalizeText(workflow.status).toLowerCase() === 'blocked'
                ? BLOCKED_PROJECT_PLAN_STATUS
                : ACTIVE_PROJECT_PLAN_STATUS),
        source: 'workflow',
        updatedAt: new Date().toISOString(),
    });
}

function findSkippableMilestoneIds(projectPlan = {}, objective = '') {
    const normalized = normalizeText(objective).toLowerCase();
    const milestones = Array.isArray(projectPlan.milestones) ? projectPlan.milestones : [];
    if (!normalized || milestones.length === 0 || !hasSkipInstruction(normalized)) {
        return [];
    }

    const keepValidationActive = /\b(?:just|only)\s+(?:validate|verification|verify|test|testing|review)\b/.test(normalized);

    const matchers = [
        {
            intent: /\b(deploy|deployment|publish|release|rollout)\b/,
            title: /\b(deploy|publish|release|rollout)\b/,
        },
        {
            intent: /\b(push|commit|git|save)\b/,
            title: /\b(push|commit|git|save|publish)\b/,
        },
        {
            intent: /\b(test|tests|testing|verify|verification|validate|validation|qa|review|smoke)\b/,
            title: /\b(test|verify|validate|review|qa|smoke)\b/,
            skipWhen: () => !keepValidationActive,
        },
        {
            intent: /\b(research|inspect|inspection|audit|review|discovery|plan|planning)\b/,
            title: /\b(research|inspect|audit|plan|context|review)\b/,
        },
    ];

    const matching = matchers
        .filter((matcher) => matcher.intent.test(normalized) && (typeof matcher.skipWhen !== 'function' || matcher.skipWhen()))
        .flatMap((matcher) => milestones
            .filter((milestone) => matcher.title.test(`${milestone.title} ${milestone.objective || ''}`.toLowerCase()))
            .map((milestone) => milestone.id));

    if (matching.length > 0) {
        return [...new Set(matching)];
    }

    return projectPlan.activeMilestoneId ? [projectPlan.activeMilestoneId] : [];
}

function applyInteractionUpdates(projectPlan = null, objective = '') {
    const current = normalizeForegroundProjectPlan(projectPlan);
    const normalizedObjective = normalizeText(objective);
    if (!current || !normalizedObjective) {
        return current;
    }

    const skippableMilestoneIds = findSkippableMilestoneIds(current, normalizedObjective);
    if (skippableMilestoneIds.length === 0) {
        return current;
    }

    const updated = applyProjectPlanPatch(current, {
        milestones: current.milestones.map((milestone) => (
            skippableMilestoneIds.includes(milestone.id)
                ? {
                    ...milestone,
                    status: ['completed', 'skipped'].includes(milestone.status)
                        ? milestone.status
                        : 'skipped',
                    notes: normalizeText(
                        [milestone.notes, `Skipped because: ${truncateText(normalizedObjective, 160)}`]
                            .filter(Boolean)
                            .join(' '),
                    ),
                }
                : milestone
        )),
    }, {
        changeReason: {
            type: 'operator_override',
            summary: truncateText(`User adjusted the foreground plan: ${normalizedObjective}`, 220),
            requestedBy: 'user',
        },
    });

    return normalizeForegroundProjectPlan({
        ...updated,
        kind: FOREGROUND_PROJECT_PLAN_KIND,
        status: inferProjectStatus(updated),
        source: 'interaction',
        updatedAt: new Date().toISOString(),
    });
}

function shouldResumeStoredProjectPlan(objective = '', storedPlan = null) {
    const normalizedObjective = normalizeText(objective);
    if (!storedPlan || storedPlan.status === COMPLETED_PROJECT_PLAN_STATUS) {
        return false;
    }

    if (!normalizedObjective) {
        return true;
    }

    if (hasExplicitProjectResetIntent(normalizedObjective) || hasWorkloadIntent(normalizedObjective)) {
        return false;
    }

    return (
        hasContinuationIntent(normalizedObjective)
        || hasStructuredCheckpointResponse(normalizedObjective)
        || hasLikelyDecisionReplyIntent(normalizedObjective)
        || storedPlan.status === ACTIVE_PROJECT_PLAN_STATUS
    );
}

function shouldCreateForegroundProjectPlan(objective = '', storedPlan = null) {
    const normalizedObjective = normalizeText(objective);
    if (!normalizedObjective || hasWorkloadIntent(normalizedObjective)) {
        return false;
    }

    if (storedPlan?.status === ACTIVE_PROJECT_PLAN_STATUS && !hasExplicitProjectResetIntent(normalizedObjective)) {
        return false;
    }

    return hasSubstantialProjectIntent(normalizedObjective);
}

function inferForegroundProjectPlan({
    objective = '',
    session = null,
    workflow = null,
} = {}) {
    const storedPlan = normalizeForegroundProjectPlan(getSessionControlState(session).projectPlan);

    if (workflow) {
        return buildForegroundProjectPlanFromWorkflow(workflow, storedPlan);
    }

    if (storedPlan && shouldResumeStoredProjectPlan(objective, storedPlan)) {
        return applyInteractionUpdates(storedPlan, objective);
    }

    if (shouldCreateForegroundProjectPlan(objective, storedPlan)) {
        const basePlan = buildForegroundProjectPlanFromObjective(objective, {
            existingPlan: storedPlan && hasExplicitProjectResetIntent(objective) ? {
                ...storedPlan,
                changeLog: [
                    ...(storedPlan.changeLog || []),
                    {
                        type: 'operator_override',
                        summary: truncateText(`User reset the foreground plan: ${objective}`, 220),
                        requestedBy: 'user',
                    },
                ],
            } : storedPlan,
            source: storedPlan ? 'interaction' : 'objective',
        });
        return applyInteractionUpdates(basePlan, objective);
    }

    return storedPlan;
}

function findActiveMilestone(projectPlan = null) {
    const current = normalizeForegroundProjectPlan(projectPlan);
    if (!current) {
        return null;
    }

    return current.milestones.find((entry) => entry.id === current.activeMilestoneId)
        || current.milestones.find((entry) => !['completed', 'skipped'].includes(entry.status))
        || null;
}

function advanceForegroundProjectPlan({
    projectPlan = null,
    workflow = null,
    toolEvents = [],
} = {}) {
    if (workflow) {
        return buildForegroundProjectPlanFromWorkflow(workflow, projectPlan);
    }

    const current = normalizeForegroundProjectPlan(projectPlan);
    if (!current) {
        return null;
    }

    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const failures = events.filter((event) => event?.result?.success === false);
    const successes = events.filter((event) => event?.result?.success !== false);

    if (failures.length > 0) {
        const activeMilestone = findActiveMilestone(current);
        const failureText = normalizeText(failures[0]?.result?.error || 'The active project plan is blocked.');
        return normalizeForegroundProjectPlan({
            ...current,
            milestones: current.milestones.map((milestone) => (
                activeMilestone && milestone.id === activeMilestone.id
                    ? {
                        ...milestone,
                        status: 'blocked',
                        notes: normalizeText([milestone.notes, failureText].filter(Boolean).join(' ')),
                    }
                    : milestone
            )),
            status: BLOCKED_PROJECT_PLAN_STATUS,
            source: current.source,
            updatedAt: new Date().toISOString(),
        });
    }

    if (successes.length === 0) {
        return normalizeForegroundProjectPlan({
            ...current,
            updatedAt: new Date().toISOString(),
        });
    }

    const activeMilestone = findActiveMilestone(current);
    if (!activeMilestone) {
        return normalizeForegroundProjectPlan({
            ...current,
            status: COMPLETED_PROJECT_PLAN_STATUS,
            updatedAt: new Date().toISOString(),
        });
    }

    const updatedMilestones = current.milestones.map((milestone) => (
        milestone.id === activeMilestone.id
            ? {
                ...milestone,
                status: ['completed', 'skipped'].includes(milestone.status)
                    ? milestone.status
                    : 'completed',
            }
            : milestone
    ));
    const nextMilestone = updatedMilestones.find((milestone) => !['completed', 'skipped'].includes(milestone.status) && milestone.id !== activeMilestone.id);
    const promotedMilestones = updatedMilestones.map((milestone) => (
        nextMilestone && milestone.id === nextMilestone.id && milestone.status === 'planned'
            ? {
                ...milestone,
                status: 'in_progress',
            }
            : milestone
    ));
    const progressed = recordProjectReview({
        ...current,
        milestones: promotedMilestones,
    }, {
        milestoneId: activeMilestone.id,
        status: 'completed',
        summary: truncateText(
            `Advanced the foreground plan after: ${successes
                .map((event) => normalizeText(event?.toolCall?.function?.name || event?.result?.toolId || 'tool'))
                .filter(Boolean)
                .join(', ')}`,
            220,
        ),
    });

    return normalizeForegroundProjectPlan({
        ...progressed,
        kind: FOREGROUND_PROJECT_PLAN_KIND,
        status: inferProjectStatus(progressed),
        source: current.source,
        updatedAt: new Date().toISOString(),
    });
}

module.exports = {
    ACTIVE_PROJECT_PLAN_STATUS,
    BLOCKED_PROJECT_PLAN_STATUS,
    COMPLETED_PROJECT_PLAN_STATUS,
    FOREGROUND_PROJECT_PLAN_KIND,
    advanceForegroundProjectPlan,
    inferForegroundProjectPlan,
    normalizeForegroundProjectPlan,
    shouldResumeRemoteCliProject,
    shouldResumeStoredProjectPlan,
};

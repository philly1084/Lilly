const { v4: uuidv4 } = require('uuid');
const { createResponse } = require('../openai-client');
const { extractResponseText } = require('../artifacts/artifact-service');
const { parseLenientJson } = require('../utils/lenient-json');
const settingsController = require('../routes/admin/settings.controller');
const {
    SELF_REFLECTION_MODEL_CARD_NOTE_LIMIT,
    SELF_REFLECTION_UPDATE_ACTION_LIMIT,
    SELF_REFLECTION_UPDATE_TOOL_ID,
    assertNoBlockedDurableContent,
} = require('../self-reflection-updater');

const VALID_DECISIONS = new Set(['aligned', 'needs_review', 'misaligned']);
const VALID_REQUEST_TYPES = new Set([
    'research',
    'coding',
    'document',
    'deployment',
    'frontend',
    'conversation',
    'planning',
    'unknown',
]);
const VALID_ROUTE_DECISIONS = new Set(['correct_route', 'route_unclear', 'wrong_route']);
const VALID_FAILURE_CATEGORIES = new Set([
    'wrong_route',
    'too_shallow',
    'answered_instead_of_acted',
    'missing_research',
    'missing_visual_verification',
    'bad_artifact_format',
    'ignored_context',
    'over_scheduled',
    'wrong_model_lane',
    'bad_tone_or_format',
    'incomplete_followthrough',
    'unsupported_claim',
    'other',
]);
const VALID_TOOL_USE_DECISIONS = new Set(['correct_tools', 'tool_gap', 'tool_misuse', 'tool_unclear']);
const VALID_TOOL_MISUSE_CATEGORIES = new Set([
    'missing_required_tool',
    'wrong_tool_for_task',
    'unnecessary_tool',
    'repeated_failed_tool',
    'bad_tool_params',
    'skipped_verification_tool',
    'unsafe_tool_choice',
    'tool_result_ignored',
    'tool_output_leaked',
    'other',
]);
const SELF_REFLECTION_SUGGESTION_ACTION_LIMIT = Math.min(2, SELF_REFLECTION_UPDATE_ACTION_LIMIT);
const VALID_SELF_REFLECTION_SUGGESTION_ACTIONS = new Set([
    'model_card_note',
    'skill_patch',
]);
const DURABLE_LEARNING_CUE_PATTERNS = [
    /\bdurable\s+(?:lesson|learning|improvement|memory|note|guidance)\b/i,
    /\breusable\s+(?:lesson|guidance|pattern|rule|skill|routing)\b/i,
    /\bfor\s+similar\s+future\b/i,
    /\bfuture\s+(?:routing|requests|turns|workflows|evaluations)\b/i,
    /\bmodel[-\s]?card\s+(?:note|finding|lesson|evidence)\b/i,
    /\bself[-\s]?reflection(?:\s+update)?\b/i,
    /\bcarryover\s+notes?\b/i,
    /\bregistered\s+skill\b/i,
    /\bshould\s+be\s+remembered\b/i,
];
const BLOCKED_SELF_REFLECTION_SUGGESTION_PATTERNS = [
    /```/,
    /<script\b/i,
    /\b(?:raw|full|verbatim)\s+(?:logs?|transcripts?|stack\s+traces?|code\s+dumps?)\b/i,
    /^\s*(?:const|let|var|function|class|import|export)\s+\S+/m,
    /\bat\s+\S.*\(\S+:\d+:\d+\)/,
];

function normalizeRouteDecision(value = '', fallback = 'route_unclear') {
    const normalized = String(value || '').trim();
    return VALID_ROUTE_DECISIONS.has(normalized) ? normalized : fallback;
}

function normalizeFailureCategories(value = [], fallback = []) {
    const source = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    const normalized = source
        .map((entry) => String(entry || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
        .filter((entry) => VALID_FAILURE_CATEGORIES.has(entry));
    const fallbackValues = Array.isArray(fallback) ? fallback : [];
    return Array.from(new Set([...normalized, ...fallbackValues])).slice(0, 6);
}

function normalizeToolUseDecision(value = '', fallback = 'tool_unclear') {
    const normalized = String(value || '').trim();
    return VALID_TOOL_USE_DECISIONS.has(normalized) ? normalized : fallback;
}

function normalizeToolNames(value = [], limit = 8) {
    const source = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    return Array.from(new Set(source
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean)))
        .slice(0, limit);
}

function normalizeToolMisuseCategories(value = [], fallback = []) {
    const source = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    const normalized = source
        .map((entry) => String(entry || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
        .filter((entry) => VALID_TOOL_MISUSE_CATEGORIES.has(entry));
    const fallbackValues = Array.isArray(fallback) ? fallback : [];
    return Array.from(new Set([...normalized, ...fallbackValues])).slice(0, 6);
}

function trimText(value = '', limit = 4000) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, limit - 18)).trim()} ...[truncated]`;
}

function normalizeStringArray(value = [], limit = 5, itemLimit = 240) {
    const source = Array.isArray(value) ? value : [];
    return source
        .map((entry) => trimText(entry, itemLimit))
        .filter(Boolean)
        .slice(0, limit);
}

function normalizeActionType(value = '') {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function hasDurableLearningCue(value = '') {
    const source = String(value || '');
    return DURABLE_LEARNING_CUE_PATTERNS.some((pattern) => pattern.test(source));
}

function isSafeSelfReflectionSuggestionText(value = '') {
    const source = String(value || '');
    if (!source.trim()) {
        return true;
    }

    try {
        assertNoBlockedDurableContent(source, 'self-reflection suggestion');
    } catch (error) {
        return false;
    }

    return !BLOCKED_SELF_REFLECTION_SUGGESTION_PATTERNS.some((pattern) => pattern.test(source));
}

function collectSelfReflectionSuggestionActions(value = {}) {
    if (Array.isArray(value)) {
        return value.flatMap((entry) => collectSelfReflectionSuggestionActions(entry));
    }
    if (!value || typeof value !== 'object') {
        return [];
    }
    if (value.input && typeof value.input === 'object') {
        return collectSelfReflectionSuggestionActions(value.input);
    }
    if (Array.isArray(value.actions)) {
        return value.actions;
    }
    if (value.action && typeof value.action === 'object' && !Array.isArray(value.action)) {
        return [value.action];
    }
    if (value.type || value.kind) {
        return [value];
    }
    return [];
}

function normalizeSelfReflectionSuggestionAction(action = {}, wrapper = {}) {
    const source = action && typeof action === 'object' && !Array.isArray(action) ? action : {};
    const type = normalizeActionType(source.type || source.action || source.kind);
    if (!VALID_SELF_REFLECTION_SUGGESTION_ACTIONS.has(type)) {
        return null;
    }

    const reason = trimText(source.reason || source.rationale || wrapper.reason || wrapper.reflection || '', 260);
    const cueProbe = [
        wrapper.trigger,
        wrapper.reflection,
        wrapper.reason,
        reason,
        source.content,
        source.note,
        source.body,
        source.description,
        source.oldText || source.old_string,
        source.newText || source.new_string,
    ].filter(Boolean).join(' ');
    if (!hasDurableLearningCue(cueProbe) || !isSafeSelfReflectionSuggestionText(JSON.stringify(source))) {
        return null;
    }

    if (type === 'model_card_note') {
        const content = trimText(source.content || source.note || source.body || source.lesson || '', Math.min(900, SELF_REFLECTION_MODEL_CARD_NOTE_LIMIT));
        if (!content || !isSafeSelfReflectionSuggestionText(content)) {
            return null;
        }
        return {
            type,
            content,
            reason: reason || 'Durable model-card learning suggested by alignment evaluation.',
        };
    }

    const skillId = trimText(source.skillId || source.id || wrapper.targetSkillId || '', 140);
    const oldText = String(source.oldText || source.old_string || source.find || '').trim();
    const newText = String(source.newText || source.new_string || source.replace || '').trim();
    if (!skillId || !oldText || !newText || oldText.length > 500 || newText.length > 700) {
        return null;
    }
    if (!isSafeSelfReflectionSuggestionText(`${skillId}\n${oldText}\n${newText}`)) {
        return null;
    }

    return {
        type,
        skillId,
        oldText,
        newText,
        reason: reason || 'Durable skill patch suggested by alignment evaluation.',
    };
}

function normalizeSelfReflectionUpdateSuggestions(value = {}) {
    const wrapper = value && typeof value === 'object' && !Array.isArray(value)
        ? (value.input && typeof value.input === 'object' ? value.input : value)
        : {};
    const actions = collectSelfReflectionSuggestionActions(value)
        .map((action) => normalizeSelfReflectionSuggestionAction(action, wrapper))
        .filter(Boolean)
        .slice(0, SELF_REFLECTION_SUGGESTION_ACTION_LIMIT);
    if (actions.length === 0) {
        return [];
    }

    const reflection = trimText(wrapper.reflection || wrapper.summary || actions.map((action) => action.reason).filter(Boolean).join(' '), 500);
    const trigger = trimText(wrapper.trigger || 'alignment evaluator durable-learning suggestion', 180);
    if (!hasDurableLearningCue([trigger, reflection, ...actions.map((action) => `${action.reason} ${action.content || ''}`)].join(' '))) {
        return [];
    }

    return [{
        toolId: SELF_REFLECTION_UPDATE_TOOL_ID,
        status: 'suggested',
        appliesAutomatically: false,
        input: {
            source: 'alignment-evaluator',
            trigger,
            reflection,
            dryRun: true,
            apply: false,
            actions,
        },
    }];
}

function normalizeConfidence(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return 0;
    }
    return Math.max(0, Math.min(1, parsed));
}

function normalizeEvaluation(value = {}, fallback = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const selfReflectionUpdateSuggestions = normalizeSelfReflectionUpdateSuggestions(
        source.selfReflectionUpdateSuggestions
        || source.selfReflectionActionSuggestions
        || source.suggestedSelfReflectionActions
        || source.selfReflectionActions
        || source.selfReflectionUpdate
        || fallback.selfReflectionUpdateSuggestions
        || [],
    );
    const decision = VALID_DECISIONS.has(String(source.decision || '').trim())
        ? String(source.decision || '').trim()
        : fallback.decision || 'needs_review';
    const requestType = VALID_REQUEST_TYPES.has(String(source.requestType || '').trim())
        ? String(source.requestType || '').trim()
        : fallback.requestType || 'unknown';

    return {
        decision,
        requestType,
        confidence: normalizeConfidence(source.confidence),
        summary: trimText(source.summary || fallback.summary || '', 600),
        evidence: normalizeStringArray(source.evidence, 6, 260),
        recommendedChanges: normalizeStringArray(source.recommendedChanges, 6, 260),
        decisionGuidance: normalizeStringArray(source.decisionGuidance, 6, 260),
        routeDecision: normalizeRouteDecision(source.routeDecision, fallback.routeDecision || 'route_unclear'),
        expectedRoute: trimText(source.expectedRoute || fallback.expectedRoute || '', 500),
        actualRoute: trimText(source.actualRoute || fallback.actualRoute || '', 500),
        failureCategories: normalizeFailureCategories(source.failureCategories, fallback.failureCategories || []),
        fixStrategy: normalizeStringArray(source.fixStrategy, 6, 260),
        repairPlan: normalizeStringArray(source.repairPlan, 6, 260),
        successPattern: trimText(source.successPattern || fallback.successPattern || '', 500),
        lesson: trimText(source.lesson || fallback.lesson || '', 700),
        toolUseDecision: normalizeToolUseDecision(source.toolUseDecision, fallback.toolUseDecision || 'tool_unclear'),
        toolMisuseCategories: normalizeToolMisuseCategories(source.toolMisuseCategories, fallback.toolMisuseCategories || []),
        expectedTools: normalizeToolNames(source.expectedTools || fallback.expectedTools || []),
        actualTools: normalizeToolNames(source.actualTools || fallback.actualTools || []),
        missingTools: normalizeToolNames(source.missingTools || fallback.missingTools || []),
        misusedTools: normalizeToolNames(source.misusedTools || fallback.misusedTools || []),
        toolFixes: normalizeStringArray(source.toolFixes, 6, 260),
        toolLesson: trimText(source.toolLesson || fallback.toolLesson || '', 700),
        memoryCandidate: source.memoryCandidate === true || fallback.memoryCandidate === true,
        promoteRegressionFixture: source.promoteRegressionFixture === true || fallback.promoteRegressionFixture === true,
        selfReflectionUpdateSuggestions,
    };
}

function getToolIdsFromMetadata(metadata = {}) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const toolEvents = Array.isArray(source.toolEvents || source.tool_events) ? (source.toolEvents || source.tool_events) : [];
    return Array.from(new Set(toolEvents
        .map((event) => String(event?.toolCall?.function?.name || event?.result?.toolId || event?.tool || '').trim())
        .filter(Boolean)));
}

function summarizeToolUse(metadata = {}) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const toolEvents = Array.isArray(source.toolEvents || source.tool_events) ? (source.toolEvents || source.tool_events) : [];
    if (toolEvents.length === 0) {
        return {
            actualTools: [],
            failedTools: [],
            repeatedTools: [],
            summary: 'No tools were used.',
        };
    }

    const counts = new Map();
    const failedTools = [];
    toolEvents.forEach((event) => {
        const toolId = String(event?.toolCall?.function?.name || event?.result?.toolId || event?.tool || '').trim();
        if (!toolId) {
            return;
        }
        counts.set(toolId, (counts.get(toolId) || 0) + 1);
        if (event?.result?.success === false) {
            failedTools.push(toolId);
        }
    });
    const actualTools = Array.from(counts.keys());
    const repeatedTools = Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([toolId]) => toolId);

    return {
        actualTools,
        failedTools: Array.from(new Set(failedTools)),
        repeatedTools,
        summary: [
            actualTools.length > 0 ? `tools=${actualTools.join(',')}` : 'tools=none',
            failedTools.length > 0 ? `failed=${Array.from(new Set(failedTools)).join(',')}` : '',
            repeatedTools.length > 0 ? `repeated=${repeatedTools.join(',')}` : '',
        ].filter(Boolean).join('; '),
    };
}

function inferFallbackFailureCategories({ rating = 'down', userText = '', assistantText = '', assistantMetadata = {} } = {}) {
    if (rating !== 'down') {
        return [];
    }

    const normalizedUser = String(userText || '').toLowerCase();
    const normalizedAssistant = String(assistantText || '').toLowerCase();
    const metadata = assistantMetadata && typeof assistantMetadata === 'object' ? assistantMetadata : {};
    const toolEvents = Array.isArray(metadata.toolEvents || metadata.tool_events) ? (metadata.toolEvents || metadata.tool_events) : [];
    const categories = [];
    const wantsAction = /\b(fix|implement|change|update|add|remove|build|create|make|deploy|run|test|verify)\b/.test(normalizedUser);
    const proseOnly = toolEvents.length === 0 && /\b(could|should|would|you can|here'?s how|plan|approach)\b/.test(normalizedAssistant);

    if (wantsAction && proseOnly) categories.push('answered_instead_of_acted');
    if (/\b(current|latest|today|research|source|sources|cite|verify|look up|search)\b/.test(normalizedUser) && toolEvents.length === 0) categories.push('missing_research');
    if (/\b(frontend|ui|web-chat|browser|preview|screenshot|responsive|layout|html|website|dashboard)\b/.test(normalizedUser)
        && !toolEvents.some((event) => /ui-check|playwright|browser|web-scrape/i.test(String(event?.toolCall?.function?.name || event?.result?.toolId || '')))) {
        categories.push('missing_visual_verification');
    }
    if (/\b(pdf|html|docx|pptx|xlsx|artifact|file|download)\b/.test(normalizedUser)
        && !metadata.outputFormat
        && !metadata.lastOutputFormat
        && !Array.isArray(metadata.artifacts)) {
        categories.push('bad_artifact_format');
    }

    return categories.length > 0 ? categories : ['other'];
}

function inferExpectedToolsForRequest(text = '') {
    const normalized = String(text || '').toLowerCase();
    const tools = [];
    if (/\b(current|latest|today|research|source|sources|cite|verify|look up|search|browse)\b/.test(normalized)) {
        tools.push('web-search', 'web-fetch');
    }
    if (/\b(frontend|ui|web-chat|browser|preview|screenshot|responsive|layout|html|website|dashboard)\b/.test(normalized)) {
        tools.push('web-scrape');
    }
    if (/\b(pdf|document|docx|deck|pptx|xlsx|html artifact|report|brief)\b/.test(normalized)) {
        tools.push('document-workflow');
    }
    if (/\b(image|photo|poster|thumbnail|illustration)\b/.test(normalized)) {
        tools.push('image-generate');
    }
    if (/\b(deploy|k3s|kubectl|server|remote|production|live)\b/.test(normalized)) {
        tools.push('remote-command');
    }
    return Array.from(new Set(tools));
}

function inferFallbackToolFeedback({ rating = 'down', userText = '', assistantMetadata = {} } = {}) {
    const expectedTools = inferExpectedToolsForRequest(userText);
    const toolUse = summarizeToolUse(assistantMetadata);
    const actualTools = toolUse.actualTools;
    const missingTools = expectedTools.filter((toolId) => !actualTools.includes(toolId));
    const categories = [];

    if (rating === 'down' && missingTools.length > 0) categories.push('missing_required_tool');
    if (rating === 'down' && missingTools.some((toolId) => ['web-scrape', 'web-fetch'].includes(toolId))) categories.push('skipped_verification_tool');
    if (rating === 'down' && toolUse.failedTools.length > 0 && toolUse.repeatedTools.some((toolId) => toolUse.failedTools.includes(toolId))) categories.push('repeated_failed_tool');

    const toolUseDecision = rating === 'up'
        ? 'correct_tools'
        : (categories.length > 0 ? 'tool_gap' : (actualTools.length > 0 ? 'tool_unclear' : 'tool_gap'));
    const toolLesson = rating === 'up'
        ? `Positive feedback confirms this tool pattern can work: ${toolUse.summary}`
        : (missingTools.length > 0
            ? `For similar requests, include required tools before finalizing: ${missingTools.join(', ')}.`
            : 'For similar negative feedback, compare intended tool evidence with actual tool calls before answering.');

    return {
        toolUseDecision,
        toolMisuseCategories: categories.length > 0 ? categories : (rating === 'down' ? ['other'] : []),
        expectedTools,
        actualTools,
        missingTools,
        misusedTools: toolUse.failedTools,
        toolFixes: missingTools.length > 0 ? [`Use ${missingTools.join(', ')} before final synthesis when the prompt requires that evidence.`] : [],
        toolLesson,
    };
}

function buildFallbackEvaluation({ rating = 'down', reason = '', userText = '', assistantText = '', assistantMetadata = {} } = {}) {
    const negative = rating === 'down';
    const requestType = inferRequestType(userText);
    const actualRoute = summarizeActualRoute(assistantMetadata);
    const failureCategories = inferFallbackFailureCategories({ rating, userText, assistantText, assistantMetadata });
    const toolFeedback = inferFallbackToolFeedback({ rating, userText, assistantMetadata });
    const successPattern = !negative
        ? `Positive ${requestType} feedback for route: ${actualRoute}`
        : '';
    return normalizeEvaluation({
        decision: negative ? 'needs_review' : 'aligned',
        requestType,
        confidence: negative ? 0.35 : 0.8,
        summary: negative
            ? trimText(reason || 'The user marked this response for alignment review.', 300)
            : 'The user marked this response as aligned.',
        evidence: [
            userText ? `User request: ${trimText(userText, 220)}` : '',
            assistantText ? `Assistant response: ${trimText(assistantText, 220)}` : '',
        ].filter(Boolean),
        recommendedChanges: negative ? ['Review whether the response matched the request type and follow-through expected by the user.'] : [],
        decisionGuidance: negative ? ['For similar future requests, explicitly classify the request type before deciding whether to answer, research, edit files, or verify UI.'] : [],
        routeDecision: negative ? 'route_unclear' : 'correct_route',
        expectedRoute: negative ? `Expected route should satisfy a ${requestType} request with the needed tools, artifacts, or verification.` : '',
        actualRoute,
        failureCategories,
        fixStrategy: negative ? ['Compare the expected route with the recorded model, tool, artifact, and verification metadata before the next reply.'] : [],
        repairPlan: negative ? ['Reclassify the prompt, choose the expected route, then produce or refine the next answer using that route.'] : [],
        successPattern,
        lesson: negative
            ? 'Negative feedback should become a routing check for the next turn: classify the task type, choose the needed tool path, and verify follow-through before answering.'
            : `Positive feedback confirms this ${requestType} route can be reused for similar prompts when the context matches.`,
        ...toolFeedback,
        memoryCandidate: !negative,
        promoteRegressionFixture: negative && failureCategories.some((category) => category !== 'other'),
    });
}

function inferRequestType(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (/\b(frontend|ui|web-chat|button|icon|css|html|layout|responsive|browser)\b/.test(normalized)) return 'frontend';
    if (/\b(code|implement|fix|bug|test|refactor|route|api|function|file)\b/.test(normalized)) return 'coding';
    if (/\b(research|sources?|data|latest|verify|web-search|web fetch)\b/.test(normalized)) return 'research';
    if (/\b(document|pdf|docx|deck|pptx|report|spreadsheet)\b/.test(normalized)) return 'document';
    if (/\b(deploy|server|k3s|kubectl|remote|live|production|gitlab|runner)\b/.test(normalized)) return 'deployment';
    if (/\b(plan|spec|proposal|architecture)\b/.test(normalized)) return 'planning';
    return 'conversation';
}

function resolveEvaluatorConfig(overrides = {}) {
    const orchestration = typeof settingsController.getEffectiveOrchestrationConfig === 'function'
        ? settingsController.getEffectiveOrchestrationConfig()
        : {};

    return {
        enabled: orchestration.enableAlignmentEvaluator !== false,
        applyGuidance: orchestration.applyAlignmentGuidance !== false,
        model: String(
            overrides.model
            || orchestration.evaluatorModel
            || orchestration.defaultModel
            || 'gpt-5.5',
        ).trim() || 'gpt-5.5',
        reasoningEffort: String(
            overrides.reasoningEffort
            || orchestration.evaluatorReasoningEffort
            || 'medium',
        ).trim() || 'medium',
    };
}

function summarizeActualRoute(metadata = {}) {
    const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const toolEvents = Array.isArray(source.toolEvents || source.tool_events) ? (source.toolEvents || source.tool_events) : [];
    const toolIds = toolEvents
        .map((event) => String(event?.toolCall?.function?.name || event?.result?.toolId || event?.tool || '').trim())
        .filter(Boolean);
    const uniqueToolIds = Array.from(new Set(toolIds)).slice(0, 8);
    const artifacts = Array.isArray(source.artifacts) ? source.artifacts : [];
    const failures = toolEvents.filter((event) => event?.result?.success === false).length;
    const decisionTrace = source.decisionTrace && typeof source.decisionTrace === 'object'
        ? source.decisionTrace
        : null;
    const routeParts = [
        source.taskType ? `taskType=${source.taskType}` : '',
        source.clientSurface ? `surface=${source.clientSurface}` : '',
        source.executionProfile ? `executionProfile=${source.executionProfile}` : '',
        source.surfaceFinisher ? `finisher=${source.surfaceFinisher}` : '',
        source.model ? `model=${source.model}` : '',
        source.outputFormat || source.lastOutputFormat ? `outputFormat=${source.outputFormat || source.lastOutputFormat}` : '',
        uniqueToolIds.length > 0 ? `tools=${uniqueToolIds.join(',')}` : 'tools=none',
        artifacts.length > 0 ? `artifacts=${artifacts.length}` : '',
        failures > 0 ? `failedTools=${failures}` : '',
        decisionTrace?.route ? `route=${decisionTrace.route}` : '',
        decisionTrace?.reason ? `routeReason=${trimText(decisionTrace.reason, 180)}` : '',
    ].filter(Boolean);

    return routeParts.join('; ') || 'No route metadata was recorded.';
}

function buildRegressionFixtureCandidate({
    feedbackId = '',
    sessionId = '',
    messageId = '',
    rating = 'down',
    reason = '',
    userText = '',
    assistantText = '',
    evaluation = {},
    assistantMetadata = {},
} = {}) {
    if (rating !== 'down') {
        return null;
    }

    const routeDecision = String(evaluation?.routeDecision || '').trim();
    const categories = normalizeFailureCategories(evaluation?.failureCategories || []);
    const shouldPromote = evaluation?.promoteRegressionFixture === true
        || routeDecision === 'wrong_route'
        || categories.some((category) => category !== 'other');
    if (!shouldPromote) {
        return null;
    }

    return {
        id: feedbackId ? `alignment-${feedbackId}` : `alignment-${uuidv4()}`,
        source: 'alignment-feedback',
        sessionId,
        messageId,
        capturedAt: new Date().toISOString(),
        prompt: trimText(userText, 1500),
        rejectedResponsePreview: trimText(assistantText, 700),
        userReason: trimText(reason, 400),
        expected: {
            requestType: evaluation?.requestType || inferRequestType(userText),
            routeDecision: 'correct_route',
            expectedRoute: evaluation?.expectedRoute || '',
            forbiddenRoute: evaluation?.actualRoute || summarizeActualRoute(assistantMetadata),
            failureCategories: categories,
            expectedTools: normalizeToolNames(evaluation?.expectedTools || []),
            missingTools: normalizeToolNames(evaluation?.missingTools || []),
            misusedTools: normalizeToolNames(evaluation?.misusedTools || []),
            toolMisuseCategories: normalizeToolMisuseCategories(evaluation?.toolMisuseCategories || []),
            requiredEvidence: normalizeStringArray([
                ...(Array.isArray(evaluation?.repairPlan) ? evaluation.repairPlan : []),
                ...(Array.isArray(evaluation?.fixStrategy) ? evaluation.fixStrategy : []),
                ...(Array.isArray(evaluation?.toolFixes) ? evaluation.toolFixes : []),
            ], 8, 180),
        },
    };
}

function buildEvaluatorPrompt({
    sessionId = '',
    messageId = '',
    rating = 'down',
    reason = '',
    userText = '',
    assistantText = '',
    recentMessages = [],
    assistantMetadata = {},
} = {}) {
    const transcript = (Array.isArray(recentMessages) ? recentMessages : [])
        .slice(-8)
        .map((entry) => `${entry.role || 'unknown'}: ${trimText(entry.content || '', 700)}`)
        .join('\n');

    return [
        'Evaluate whether the assistant response fit the user request and product alignment expectations.',
        'Return only JSON with keys: decision, requestType, confidence, summary, evidence, recommendedChanges, decisionGuidance, memoryCandidate, selfReflectionUpdateSuggestions.',
        'Valid decision values: aligned, needs_review, misaligned.',
        'Valid requestType values: research, coding, document, deployment, frontend, conversation, planning, unknown.',
        'Also include routeDecision, expectedRoute, actualRoute, failureCategories, fixStrategy, repairPlan, successPattern, lesson, and promoteRegressionFixture.',
        'Also include toolUseDecision, toolMisuseCategories, expectedTools, actualTools, missingTools, misusedTools, toolFixes, and toolLesson.',
        'Valid routeDecision values: correct_route, route_unclear, wrong_route.',
        'Valid failureCategories values: wrong_route, too_shallow, answered_instead_of_acted, missing_research, missing_visual_verification, bad_artifact_format, ignored_context, over_scheduled, wrong_model_lane, bad_tone_or_format, incomplete_followthrough, unsupported_claim, other.',
        'Valid toolUseDecision values: correct_tools, tool_gap, tool_misuse, tool_unclear.',
        'Valid toolMisuseCategories values: missing_required_tool, wrong_tool_for_task, unnecessary_tool, repeated_failed_tool, bad_tool_params, skipped_verification_tool, unsafe_tool_choice, tool_result_ignored, tool_output_leaked, other.',
        'Focus on whether the prompt was routed correctly: right request type, right model/tool lane, right artifact path, right verification depth, and right follow-through.',
        'For tool reinforcement, identify required tools that were skipped, wrong tools that were used, repeated failed tools, bad parameters, verification tools that should have run, and cases where tool results were ignored or leaked to the user.',
        'selfReflectionUpdateSuggestions must be suggestion metadata only: at most one dry-run self-reflection-update payload with apply false, and never a tool call or write.',
        'Only include selfReflectionUpdateSuggestions when the feedback explicitly describes a durable reusable lesson for future behavior, model-card evidence, carryover notes, or registered skill guidance; leave it empty for one-off failures.',
        'Suggested actions may use model_card_note or a precise skill_patch. Do not suggest broad skill rewrites, agent notes replacements, automatic writes, deployments, or current task-state updates.',
        'Never include secrets, raw logs, transcripts, stack traces, code dumps, prompt text, or long source excerpts in selfReflectionUpdateSuggestions.',
        'Treat a response as routed incorrectly when it planned instead of executing, answered from memory when current research was needed, generated prose when an artifact/frontend path was needed, skipped browser/visual verification for UI output, or used a scheduled/deferred/workload lane when the user wanted immediate work.',
        'Do not suggest automatic code edits or deployments merely because feedback is negative.',
        'The lesson must be short, reusable, and framed as future routing guidance, not a transcript summary.',
        '',
        `Session: ${sessionId}`,
        `Message: ${messageId}`,
        `User feedback rating: ${rating}`,
        reason ? `User feedback reason: ${trimText(reason, 500)}` : '',
        '',
        `[Original user request]\n${trimText(userText, 2500)}`,
        '',
        `[Assistant response]\n${trimText(assistantText, 4000)}`,
        '',
        transcript ? `[Recent transcript]\n${transcript}` : '',
        '',
        `[Assistant metadata]\n${JSON.stringify({
            model: assistantMetadata.model || null,
            taskType: assistantMetadata.taskType || null,
            clientSurface: assistantMetadata.clientSurface || null,
            executionProfile: assistantMetadata.executionProfile || null,
            surfaceFinisher: assistantMetadata.surfaceFinisher || null,
            outputFormat: assistantMetadata.outputFormat || assistantMetadata.lastOutputFormat || null,
            decisionTrace: assistantMetadata.decisionTrace || null,
            actualRoute: summarizeActualRoute(assistantMetadata),
            toolUse: summarizeToolUse(assistantMetadata),
            reasoningSummary: trimText(assistantMetadata.reasoningSummary || '', 900),
            toolEventCount: Array.isArray(assistantMetadata.toolEvents) ? assistantMetadata.toolEvents.length : 0,
            artifactCount: Array.isArray(assistantMetadata.artifacts) ? assistantMetadata.artifacts.length : 0,
        })}`,
    ].filter(Boolean).join('\n');
}

async function evaluateAlignment(input = {}, options = {}) {
    const config = resolveEvaluatorConfig(options);
    const feedbackId = input.feedbackId || `align_${uuidv4()}`;

    if (input.rating !== 'down' || config.enabled === false) {
        return {
            feedbackId,
            status: 'recorded',
            evaluation: buildFallbackEvaluation(input),
            model: null,
        };
    }

    const prompt = buildEvaluatorPrompt(input);
    const response = await (options.createResponse || createResponse)({
        input: prompt,
        instructions: 'You are a strict but practical alignment evaluator for KimiBuilt web-chat response feedback. Respond only with compact JSON.',
        stream: false,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
    });
    const parsed = parseLenientJson(extractResponseText(response));
    const evaluation = normalizeEvaluation(parsed, buildFallbackEvaluation(input));

    return {
        feedbackId,
        status: 'completed',
        evaluation,
        model: response?.model || config.model,
    };
}

function buildAlignmentGuidanceContext(session = null, { maxEntries = 5 } = {}) {
    const orchestration = typeof settingsController.getEffectiveOrchestrationConfig === 'function'
        ? settingsController.getEffectiveOrchestrationConfig()
        : {};
    if (orchestration.applyAlignmentGuidance === false) {
        return '';
    }

    const entries = Array.isArray(session?.metadata?.alignmentFeedbackHistory)
        ? session.metadata.alignmentFeedbackHistory
        : [];
    const routePatterns = Array.isArray(session?.metadata?.alignmentRoutePatterns)
        ? session.metadata.alignmentRoutePatterns
        : [];
    const regressionFixtures = Array.isArray(session?.metadata?.alignmentRegressionFixtures)
        ? session.metadata.alignmentRegressionFixtures
        : [];
    const toolReinforcement = Array.isArray(session?.metadata?.alignmentToolReinforcement)
        ? session.metadata.alignmentToolReinforcement
        : [];
    const useful = entries
        .filter((entry) => entry && typeof entry === 'object')
        .filter((entry) => entry.rating === 'down' || entry.rating === 'up')
        .slice(-Math.max(1, Number(maxEntries) || 5));

    if (useful.length === 0 && routePatterns.length === 0 && regressionFixtures.length === 0 && toolReinforcement.length === 0) {
        return '';
    }

    const lines = useful.map((entry) => {
        const evaluation = entry.evaluation || {};
        const label = entry.rating === 'up' ? 'positive' : 'negative';
        const type = evaluation.requestType || 'unknown';
        const summary = trimText(evaluation.summary || (entry.rating === 'up' ? 'Response was aligned.' : 'Response needed review.'), 260);
        const guidance = normalizeStringArray(evaluation.decisionGuidance, 2, 220).join(' ');
        const route = evaluation.routeDecision && evaluation.routeDecision !== 'correct_route'
            ? ` Route: ${evaluation.routeDecision}${evaluation.expectedRoute ? `; expected ${trimText(evaluation.expectedRoute, 160)}` : ''}.`
            : '';
        const failures = Array.isArray(evaluation.failureCategories) && evaluation.failureCategories.length > 0
            ? ` Failure categories: ${evaluation.failureCategories.slice(0, 4).join(', ')}.`
            : '';
        const tools = evaluation.toolUseDecision && evaluation.toolUseDecision !== 'correct_tools'
            ? ` Tool feedback: ${evaluation.toolUseDecision}${Array.isArray(evaluation.missingTools) && evaluation.missingTools.length > 0 ? `; missing ${evaluation.missingTools.slice(0, 4).join(', ')}` : ''}${Array.isArray(evaluation.misusedTools) && evaluation.misusedTools.length > 0 ? `; misused ${evaluation.misusedTools.slice(0, 4).join(', ')}` : ''}.`
            : '';
        const lesson = evaluation.lesson ? ` Lesson: ${trimText(evaluation.lesson, 200)}` : '';
        const toolLesson = evaluation.toolLesson ? ` Tool lesson: ${trimText(evaluation.toolLesson, 200)}` : '';
        return `- ${label} ${type} feedback: ${summary}${route}${failures}${tools}${guidance ? ` Guidance: ${guidance}` : ''}${lesson}${toolLesson}`;
    });
    const patternLines = routePatterns.slice(-3).map((entry) => {
        const type = String(entry?.requestType || 'unknown').trim();
        const pattern = trimText(entry?.successPattern || entry?.lesson || '', 220);
        const route = trimText(entry?.actualRoute || '', 180);
        return `- successful ${type} route pattern: ${pattern}${route ? ` Route: ${route}` : ''}`;
    }).filter(Boolean);
    const fixtureLines = regressionFixtures.slice(-3).map((fixture) => {
        const expected = fixture?.expected || {};
        const type = String(expected.requestType || 'unknown').trim();
        const forbidden = trimText(expected.forbiddenRoute || '', 160);
        const required = normalizeStringArray(expected.requiredEvidence || [], 2, 160).join(' ');
        return `- avoid prior ${type} regression: expected ${trimText(expected.expectedRoute || 'correct route', 180)}${forbidden ? `; avoid ${forbidden}` : ''}${required ? `; required evidence ${required}` : ''}`;
    }).filter(Boolean);
    const toolLines = toolReinforcement.slice(-5).map((entry) => {
        const requestType = String(entry?.requestType || 'unknown').trim();
        const decision = String(entry?.toolUseDecision || 'tool_unclear').trim();
        const expected = normalizeToolNames(entry?.expectedTools || []).join(', ');
        const missing = normalizeToolNames(entry?.missingTools || []).join(', ');
        const misused = normalizeToolNames(entry?.misusedTools || []).join(', ');
        const lesson = trimText(entry?.toolLesson || entry?.lesson || '', 220);
        return `- ${requestType} tool reinforcement: ${decision}${expected ? `; expected ${expected}` : ''}${missing ? `; missing ${missing}` : ''}${misused ? `; misused ${misused}` : ''}${lesson ? `; lesson ${lesson}` : ''}`;
    }).filter(Boolean);

    return [
        '[Alignment feedback context]',
        'Use this session-local feedback to choose the right request type, research depth, tool path, and follow-through for future replies. Do not rewrite prior answers or take side effects only because feedback exists.',
        patternLines.length > 0 ? 'Reinforce successful patterns:' : '',
        ...patternLines,
        fixtureLines.length > 0 ? 'Avoid known regressions:' : '',
        ...fixtureLines,
        toolLines.length > 0 ? 'Tool-use reinforcement:' : '',
        ...toolLines,
        ...lines,
    ].filter(Boolean).join('\n');
}

module.exports = {
    buildAlignmentGuidanceContext,
    buildEvaluatorPrompt,
    buildFallbackEvaluation,
    buildRegressionFixtureCandidate,
    evaluateAlignment,
    inferExpectedToolsForRequest,
    inferRequestType,
    normalizeFailureCategories,
    normalizeSelfReflectionUpdateSuggestions,
    normalizeToolMisuseCategories,
    normalizeToolNames,
    normalizeEvaluation,
    resolveEvaluatorConfig,
    summarizeActualRoute,
    summarizeToolUse,
};

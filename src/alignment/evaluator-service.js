const { v4: uuidv4 } = require('uuid');
const { createResponse } = require('../openai-client');
const { extractResponseText } = require('../artifacts/artifact-service');
const { parseLenientJson } = require('../utils/lenient-json');
const settingsController = require('../routes/admin/settings.controller');

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

function normalizeConfidence(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return 0;
    }
    return Math.max(0, Math.min(1, parsed));
}

function normalizeEvaluation(value = {}, fallback = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
        memoryCandidate: source.memoryCandidate === true || fallback.memoryCandidate === true,
        promoteRegressionFixture: source.promoteRegressionFixture === true || fallback.promoteRegressionFixture === true,
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

function buildFallbackEvaluation({ rating = 'down', reason = '', userText = '', assistantText = '', assistantMetadata = {} } = {}) {
    const negative = rating === 'down';
    const requestType = inferRequestType(userText);
    const actualRoute = summarizeActualRoute(assistantMetadata);
    const failureCategories = inferFallbackFailureCategories({ rating, userText, assistantText, assistantMetadata });
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
            requiredEvidence: normalizeStringArray(evaluation?.repairPlan || evaluation?.fixStrategy || [], 6, 180),
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
        'Return only JSON with keys: decision, requestType, confidence, summary, evidence, recommendedChanges, decisionGuidance, memoryCandidate.',
        'Valid decision values: aligned, needs_review, misaligned.',
        'Valid requestType values: research, coding, document, deployment, frontend, conversation, planning, unknown.',
        'Also include routeDecision, expectedRoute, actualRoute, failureCategories, fixStrategy, repairPlan, successPattern, lesson, and promoteRegressionFixture.',
        'Valid routeDecision values: correct_route, route_unclear, wrong_route.',
        'Valid failureCategories values: wrong_route, too_shallow, answered_instead_of_acted, missing_research, missing_visual_verification, bad_artifact_format, ignored_context, over_scheduled, wrong_model_lane, bad_tone_or_format, incomplete_followthrough, unsupported_claim, other.',
        'Focus on whether the prompt was routed correctly: right request type, right model/tool lane, right artifact path, right verification depth, and right follow-through.',
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
    const useful = entries
        .filter((entry) => entry && typeof entry === 'object')
        .filter((entry) => entry.rating === 'down' || entry.rating === 'up')
        .slice(-Math.max(1, Number(maxEntries) || 5));

    if (useful.length === 0 && routePatterns.length === 0 && regressionFixtures.length === 0) {
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
        const lesson = evaluation.lesson ? ` Lesson: ${trimText(evaluation.lesson, 200)}` : '';
        return `- ${label} ${type} feedback: ${summary}${route}${failures}${guidance ? ` Guidance: ${guidance}` : ''}${lesson}`;
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

    return [
        '[Alignment feedback context]',
        'Use this session-local feedback to choose the right request type, research depth, tool path, and follow-through for future replies. Do not rewrite prior answers or take side effects only because feedback exists.',
        patternLines.length > 0 ? 'Reinforce successful patterns:' : '',
        ...patternLines,
        fixtureLines.length > 0 ? 'Avoid known regressions:' : '',
        ...fixtureLines,
        ...lines,
    ].filter(Boolean).join('\n');
}

module.exports = {
    buildAlignmentGuidanceContext,
    buildEvaluatorPrompt,
    buildFallbackEvaluation,
    buildRegressionFixtureCandidate,
    evaluateAlignment,
    inferRequestType,
    normalizeFailureCategories,
    normalizeEvaluation,
    resolveEvaluatorConfig,
    summarizeActualRoute,
};

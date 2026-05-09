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
        memoryCandidate: source.memoryCandidate === true,
    };
}

function buildFallbackEvaluation({ rating = 'down', reason = '', userText = '', assistantText = '' } = {}) {
    const negative = rating === 'down';
    return normalizeEvaluation({
        decision: negative ? 'needs_review' : 'aligned',
        requestType: inferRequestType(userText),
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
        memoryCandidate: false,
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
        'Focus on request type, missing research/data support, unsupported claims, wrong execution mode, incomplete follow-through, UI/format mismatch, and operational risk.',
        'Do not suggest automatic code edits or deployments merely because feedback is negative.',
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
    const useful = entries
        .filter((entry) => entry && typeof entry === 'object')
        .filter((entry) => entry.rating === 'down' || entry.rating === 'up')
        .slice(-Math.max(1, Number(maxEntries) || 5));

    if (useful.length === 0) {
        return '';
    }

    const lines = useful.map((entry) => {
        const evaluation = entry.evaluation || {};
        const label = entry.rating === 'up' ? 'positive' : 'negative';
        const type = evaluation.requestType || 'unknown';
        const summary = trimText(evaluation.summary || (entry.rating === 'up' ? 'Response was aligned.' : 'Response needed review.'), 260);
        const guidance = normalizeStringArray(evaluation.decisionGuidance, 2, 220).join(' ');
        return `- ${label} ${type} feedback: ${summary}${guidance ? ` Guidance: ${guidance}` : ''}`;
    });

    return [
        '[Alignment feedback context]',
        'Use this session-local feedback to choose the right request type, research depth, tool path, and follow-through for future replies. Do not rewrite prior answers or take side effects only because feedback exists.',
        ...lines,
    ].join('\n');
}

module.exports = {
    buildAlignmentGuidanceContext,
    buildEvaluatorPrompt,
    buildFallbackEvaluation,
    evaluateAlignment,
    inferRequestType,
    normalizeEvaluation,
    resolveEvaluatorConfig,
};

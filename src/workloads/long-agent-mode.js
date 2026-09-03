'use strict';

const DEFAULT_SCRATCH_FILE = '.kimibuilt/long-agent-scratch.md';
const DEFAULT_MAX_AUTO_STEPS = 4;
const MAX_AUTO_STEPS = 12;
const DEFAULT_RETAIN_CHARS = 6000;
const DEFAULT_TRIGGER_CHARS = 12000;

function sanitizeText(value = '') {
    return String(value || '').trim();
}

function normalizeInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }

    return Math.max(min, Math.min(Math.trunc(numeric), max));
}

function truncateText(value = '', limit = 1200) {
    const normalized = sanitizeText(value);
    if (normalized.length <= limit) {
        return normalized;
    }

    const headLength = Math.max(200, Math.floor(limit * 0.58));
    const tailLength = Math.max(120, limit - headLength - 26);
    return `${normalized.slice(0, headLength).trim()}\n...[compacted]...\n${normalized.slice(-tailLength).trim()}`;
}

function normalizeLongAgentMetadata(metadata = {}, defaults = {}) {
    const raw = metadata?.longAgent && typeof metadata.longAgent === 'object' && !Array.isArray(metadata.longAgent)
        ? metadata.longAgent
        : {};
    const enabled = raw.enabled === true
        || metadata?.recursiveLongAgent === true
        || metadata?.longAgentEnabled === true;

    if (!enabled) {
        return null;
    }

    const goal = sanitizeText(raw.goal || raw.objective || defaults.goal || defaults.prompt || '');
    const scratchFile = sanitizeText(raw.scratchFile || raw.scratch_file || raw.scratchPath || raw.scratch_path || DEFAULT_SCRATCH_FILE)
        || DEFAULT_SCRATCH_FILE;
    const maxAutoSteps = normalizeInteger(raw.maxAutoSteps || raw.max_auto_steps || raw.stageBudget || raw.stage_budget, DEFAULT_MAX_AUTO_STEPS, {
        min: 1,
        max: MAX_AUTO_STEPS,
    });
    const compaction = raw.compaction && typeof raw.compaction === 'object' && !Array.isArray(raw.compaction)
        ? raw.compaction
        : {};

    return {
        enabled: true,
        goal,
        scratchFile,
        maxAutoSteps,
        reviewPolicy: sanitizeText(raw.reviewPolicy || raw.review_policy || 'auto') || 'auto',
        compaction: {
            enabled: compaction.enabled !== false,
            triggerCharCount: normalizeInteger(compaction.triggerCharCount || compaction.trigger_char_count, DEFAULT_TRIGGER_CHARS, {
                min: 1000,
                max: 80000,
            }),
            retainChars: normalizeInteger(compaction.retainChars || compaction.retain_chars, DEFAULT_RETAIN_CHARS, {
                min: 800,
                max: 30000,
            }),
            codeCaptureLimit: normalizeInteger(compaction.codeCaptureLimit || compaction.code_capture_limit, 4, {
                min: 0,
                max: 20,
            }),
        },
        lastScratchSummary: sanitizeText(raw.lastScratchSummary || raw.last_scratch_summary || ''),
        lastDecision: raw.lastDecision && typeof raw.lastDecision === 'object' && !Array.isArray(raw.lastDecision)
            ? raw.lastDecision
            : null,
    };
}

function isLongAgentWorkload(workload = {}) {
    return Boolean(normalizeLongAgentMetadata(workload?.metadata || {}, {
        goal: workload?.prompt,
    }));
}

function getLongAgentStep(run = {}) {
    return normalizeInteger(run?.metadata?.longAgentStep || run?.metadata?.long_agent_step, 1, {
        min: 1,
        max: MAX_AUTO_STEPS,
    });
}

function buildLongAgentExecutionContext(workload = {}, run = {}) {
    const longAgent = normalizeLongAgentMetadata(workload?.metadata || {}, {
        goal: workload?.prompt,
    });
    if (!longAgent) {
        return '';
    }

    const step = getLongAgentStep(run);
    const lines = [
        '<long_agent_mode>',
        'Mode: long-form recursive agent work',
        longAgent.goal ? `Goal: ${longAgent.goal}` : null,
        `Stage: ${step} of at most ${longAgent.maxAutoSteps}`,
        `Scratch file: ${longAgent.scratchFile}`,
        'Stage rules:',
        '- Work on one clear, useful step toward the goal.',
        '- Keep a compact scratch summary at the end of the response under "Stage scratch summary".',
        '- The scratch summary must include: done, changed files or artifacts, verification, blockers, next obvious step, and any key code details that must survive compaction.',
        '- If file-write is available and appropriate, update the scratch file with the same compact stage summary instead of dumping logs.',
        '- Prefer compact evidence and file/function names over full transcripts or long code dumps.',
        '- If context is getting large, compact prior details into decisions, file paths, tests, commands, and only the code snippets needed to continue safely.',
        longAgent.lastScratchSummary ? `Prior scratch summary:\n${truncateText(longAgent.lastScratchSummary, longAgent.compaction.retainChars)}` : null,
        '</long_agent_mode>',
    ].filter(Boolean);

    return lines.join('\n');
}

function extractScratchSummary(text = '', retainChars = DEFAULT_RETAIN_CHARS) {
    const source = sanitizeText(text);
    if (!source) {
        return '';
    }

    const headingMatch = source.match(/(?:^|\n)#{0,4}\s*(?:stage\s+scratch\s+summary|scratch\s+summary|stage\s+complete|stage\s+completion)\s*:?\s*\n([\s\S]+)$/i);
    if (headingMatch?.[1]) {
        return truncateText(headingMatch[1], retainChars);
    }

    const signalLines = source
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /(?:done|changed|file|artifact|verify|test|block|next|todo|risk|decision|function|class|route|endpoint|commit|diff)/i.test(line))
        .slice(-24)
        .join('\n');

    return truncateText(signalLines || source, retainChars);
}

function removeNegatedProblemSignals(text = '') {
    return sanitizeText(text)
        .replace(/\b(?:no|zero|0)\s+(?:unresolved\s+)?(?:blockers?|errors?|failures?|regressions?)\b/gi, '')
        .replace(/\bwithout\s+(?:any\s+)?(?:blockers?|errors?|failures?|regressions?)\b/gi, '')
        .replace(/\b(?:is|are|was|were)\s+not\s+blocked\b/gi, '');
}

function evaluateLongAgentStop({ workload = {}, run = {}, result = {}, succeeded = true, error = null } = {}) {
    const longAgent = normalizeLongAgentMetadata(workload?.metadata || {}, {
        goal: workload?.prompt,
    });
    if (!longAgent) {
        return null;
    }

    const step = getLongAgentStep(run);
    const outputText = sanitizeText(result?.outputText || result?.artifactMessage || error?.message || '');
    const scratchSummary = extractScratchSummary(outputText, longAgent.compaction.retainChars);
    const lowerOutput = outputText.toLowerCase();
    const problemSignalText = removeNegatedProblemSignals(outputText);
    const blocked = !succeeded
        || /\b(blocked|cannot continue|need user|needs user|missing credential|permission denied|auth required|failed|error)\b/i.test(problemSignalText);
    const needsReview = blocked
        || /\b(incomplete|needs repair|needs review|not verified|tests? failing|still broken|regression)\b/i.test(problemSignalText);
    const goalComplete = succeeded && !needsReview
        && /\b(overall goal complete|project complete|all acceptance criteria (?:met|passed)|nothing remains|ready for final handoff)\b/i.test(lowerOutput);
    const maxStepsReached = step >= longAgent.maxAutoSteps;
    const decision = goalComplete
        ? 'complete'
        : needsReview
            ? 'review'
            : maxStepsReached
                ? 'stop_max_steps'
                : 'next_step';

    return {
        enabled: true,
        step,
        maxAutoSteps: longAgent.maxAutoSteps,
        scratchFile: longAgent.scratchFile,
        scratchSummary,
        succeeded: Boolean(succeeded),
        needsReview,
        blocked,
        goalComplete,
        maxStepsReached,
        decision,
        reason: needsReview
            ? 'Evaluator found a blocker, incomplete work, or failed verification.'
            : goalComplete
                ? 'Evaluator found a completion signal.'
                : maxStepsReached
                    ? 'Automatic stage budget reached.'
                    : 'Evaluator found no blocker and selected the next obvious step.',
    };
}

function buildReviewPrompt(longAgent = {}, evaluation = {}, priorOutput = '') {
    return [
        '[Long agent review stage]',
        longAgent.goal ? `Goal: ${longAgent.goal}` : null,
        `Scratch file: ${longAgent.scratchFile || DEFAULT_SCRATCH_FILE}`,
        'The previous agent stage stopped with a review-needed signal.',
        'Review the scratch summary and prior output, repair the smallest necessary issue, and update the scratch summary.',
        'If the issue is truly blocked by missing user-owned input or credentials, state that clearly and do not invent a workaround.',
        '',
        evaluation.scratchSummary ? `Scratch summary:\n${evaluation.scratchSummary}` : null,
        priorOutput ? `Prior output excerpt:\n${truncateText(priorOutput, 1800)}` : null,
    ].filter(Boolean).join('\n\n');
}

function buildNextStepPrompt(longAgent = {}, evaluation = {}) {
    return [
        '[Long agent next stage]',
        longAgent.goal ? `Goal: ${longAgent.goal}` : null,
        `Scratch file: ${longAgent.scratchFile || DEFAULT_SCRATCH_FILE}`,
        'Based on the scratch summary, choose the next obvious useful step and do it.',
        'Keep the step scoped. Prefer implementation plus verification over broad planning.',
        'End with a fresh "Stage scratch summary" that is compact enough to carry into the next event.',
        '',
        evaluation.scratchSummary ? `Scratch summary:\n${evaluation.scratchSummary}` : null,
    ].filter(Boolean).join('\n\n');
}

module.exports = {
    DEFAULT_SCRATCH_FILE,
    buildLongAgentExecutionContext,
    buildNextStepPrompt,
    buildReviewPrompt,
    evaluateLongAgentStop,
    extractScratchSummary,
    getLongAgentStep,
    isLongAgentWorkload,
    normalizeLongAgentMetadata,
};

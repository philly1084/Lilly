const { stripNullCharacters } = require('./utils/text');

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

function truncateText(value = '', limit = 600) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return '';
    }

    return normalized.length > limit
        ? `${normalized.slice(0, Math.max(0, limit - 3))}...`
        : normalized;
}

function isLikelyTranscriptDependentTurn(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const retryPrefixRemainder = normalized
        .replace(/^(?:please\s+)?(?:try again|retry|rerun|re-run|run it again|do it again|again)[\s,.:;!?-]*/i, '')
        .trim();
    if (retryPrefixRemainder
        && retryPrefixRemainder !== normalized
        && retryPrefixRemainder.split(/\s+/).filter(Boolean).length >= 4
        && /\b(can you|could you|can we|please|make|create|build|fix|generate|produce|write|research|deploy|update|render|convert|turn)\b/.test(retryPrefixRemainder)
        && !/^(?:it|that|this|them|those|same|same thing)\b/.test(retryPrefixRemainder)) {
        return false;
    }

    const hasCurrentTurnAnchor = [
        /\b(?:uploaded|attached|sent|included|provided)\b[\s\S]{0,80}\b(?:image|file|document|screenshot|photo|picture|pdf|attachment)\b/,
        /^(?:please\s+)?(?:can you|could you|would you|help me|i need you to)?\s*(?:write|create|build|generate|produce|research|fix|update|deploy|render|convert)\b(?!\s+(?:it|that|this|them|those|same|same thing)\b)[\s\S]{8,}/,
    ].some((pattern) => pattern.test(normalized));
    if (hasCurrentTurnAnchor && !/^\s*(?:yes|yeah|yep|ok|okay|sure|again|continue|same)\b/.test(normalized)) {
        return false;
    }

    const shortTurn = normalized.length <= 120;
    const referentialCue = [
        /^(?:it|that|this|them|those)\b/,
        /^(?:what about|how about|and|also)\b[\s\S]*\b(?:it|that|this|them|those|same)\b/,
        /\b(the commands|what you listed|the one you listed|the ones you listed|what i asked|same task|same thing|that one)\b/,
        /^(?:did you|can you|could you|would you|please)?\s*(?:see|use|reuse|fix|update|change|make|do|run|check|open|get|fetch|show|try|retry|continue)\s+(?:it|that|this|them|those|same|same thing)\b/,
        /^(?:go ahead|proceed|keep going|continue|resume|move on|next)\s*(?:with|on|to)?\s*(?:it|that|this|them|those|same|the same|the task|the work)?\b/,
        /^(?:do|run|take|start|execute|handle|move to)\s+(?:the\s+)?(?:next|following)\s+(?:step|thing|task|item|action|move)\b/,
        /^(?:do|run|schedule|set up|queue|create|make|get|fetch|check)\s+(?:it|that|this|them|those)\b/,
        /^(?:in|after|at|tomorrow|later|once|one[- ]time|daily|hourly|every)\b/,
        /^(?:yes|yeah|yep|ok|okay|sure)\b/,
        /\bfrom now\b/,
    ].some((pattern) => pattern.test(normalized));
    const openEndedCue = /\b(?:in|at|for|to|on|from|with|about|into|around|using|and|then)\s*$/.test(normalized);
    const weakStandaloneCue = shortTurn
        && (
            /^(?:continue|retry|try again|again|later|tomorrow|same|next|then|proceed|resume|go ahead|keep going)\b/.test(normalized)
            || /^(?:do|run|make|schedule|set up|queue|create|get|fetch|check|use)\s*$/.test(normalized)
        );

    return (shortTurn && referentialCue) || openEndedCue || weakStandaloneCue;
}

function resolveTranscriptObjectiveFromSession(rawObjective = '', recentMessages = []) {
    const objective = String(rawObjective || '').trim();
    if (!isLikelyTranscriptDependentTurn(objective)) {
        return {
            objective,
            usedTranscriptContext: false,
        };
    }

    const transcript = Array.isArray(recentMessages) ? [...recentMessages] : [];
    let priorUserObjective = '';
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
        const message = transcript[index];
        if (message?.role !== 'user') {
            continue;
        }

        const candidate = normalizeMessageText(message.content || '').trim();
        if (!candidate || candidate.toLowerCase() === objective.toLowerCase()) {
            continue;
        }
        if (isLikelyTranscriptDependentTurn(candidate)) {
            continue;
        }

        priorUserObjective = truncateText(candidate, 600);
        break;
    }

    if (!priorUserObjective) {
        return {
            objective,
            usedTranscriptContext: false,
        };
    }

    const separator = /[.!?]["')\]]*$/.test(priorUserObjective) ? ' ' : '. ';

    return {
        objective: `${priorUserObjective}${separator}${objective}`.trim(),
        usedTranscriptContext: true,
        priorUserObjective,
    };
}

function buildRecentTranscriptAnchor({
    currentInput = '',
    recentMessages = [],
    maxMessages = 4,
} = {}) {
    const normalizedInput = String(currentInput || '').trim();
    if (!isLikelyTranscriptDependentTurn(normalizedInput)) {
        return '';
    }

    const transcript = (Array.isArray(recentMessages) ? recentMessages : [])
        .filter((entry) => ['user', 'assistant'].includes(entry?.role))
        .slice(-Math.max(1, maxMessages))
        .map((entry) => `${entry.role}: ${normalizeMessageText(entry.content || '').trim()}`)
        .filter((line) => line && !line.endsWith(':'));

    if (transcript.length === 0) {
        return '';
    }

    return [
        '[Recent transcript anchor]',
        'The current user turn is referential or abbreviated.',
        'Before continuing, review the recent user/assistant turns, any active task or plan state shown elsewhere in the prompt, and any verified tool/artifact context.',
        'Identify the last completed action, unresolved blocker, and next incomplete step; then continue from that point instead of restarting or asking the user to restate context unless the transcript is genuinely insufficient or conflicting.',
        'Resolve "that", "it", "yes", "same", "continue", "next", "do that", or similar references against this recent transcript before using older recalled memory.',
        ...transcript,
    ].join('\n');
}

module.exports = {
    buildRecentTranscriptAnchor,
    isLikelyTranscriptDependentTurn,
    normalizeMessageText,
    resolveTranscriptObjectiveFromSession,
};

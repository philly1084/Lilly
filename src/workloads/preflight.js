'use strict';

const {
    hasImmediateOrNoDeferCue,
    hasWorkloadIntent,
    parseWorkloadScenario,
} = require('./natural-language');

function sanitizeText(value = '') {
    return String(value || '').trim();
}

function normalizeMessageText(value) {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => {
                if (typeof entry === 'string') {
                    return entry.trim();
                }

                if (entry && typeof entry === 'object') {
                    return sanitizeText(entry.text || entry.content || '');
                }

                return '';
            })
            .filter(Boolean)
            .join(' ')
            .trim();
    }

    if (value && typeof value === 'object') {
        return sanitizeText(value.text || value.content || '');
    }

    return '';
}

function collectRecentUserMessages(recentMessages = [], limit = 6) {
    if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
        return [];
    }

    return recentMessages
        .filter((message) => message?.role === 'user')
        .map((message) => normalizeMessageText(message?.content))
        .filter(Boolean)
        .slice(-Math.max(0, limit));
}

function isLikelyDeferredFollowup(text = '') {
    const normalized = sanitizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /^(?:in|after|at|tomorrow|later today|once|one[- ]time|daily|hourly|every)\b/,
        /\bfrom now\b/,
        /^(?:do|run|schedule|set up|queue|create|make|get|fetch|check)\s+(?:it|that|this|them|those)\b/,
        /\b(the commands|what you listed|the one you listed|the ones you listed|what i asked|same task|same thing|that one)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function stripReferentialScheduleWrapper(value = '') {
    return sanitizeText(value)
        .replace(/^(?:can|could|would)\s+you\s+/i, '')
        .replace(/^(?:please\s+)?(?:run|do|schedule|set up|make|create)\s+(?:it|that|this|them|those)\s+/i, '')
        .replace(/^(?:please\s+)?(?:run|do)\s+the commands(?:\s+you\s+listed(?:\s+there)?)?\s+/i, '')
        .trim();
}

function hasExplicitDeferredTimingCue(text = '') {
    const normalized = sanitizeText(text).toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        hasWorkloadIntent(normalized),
        /^(?:in|after|at|tomorrow|later today|once|one[- ]time|daily|hourly|every)\b/.test(normalized),
        /\bfrom now\b/.test(normalized),
        /\b(?:every day|everyday|each day|every weekday|weekdays|every workday|each workday|every hour|hourly|nightly)\b/.test(normalized),
        /\b(?:every|each)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/.test(normalized),
        /\b(?:in|after)\s+(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?\s*(?:minutes?|mins?|hours?|hrs?)\b/.test(normalized),
    ].some(Boolean);
}

function buildScenarioCandidates(request = '', recentMessages = []) {
    const source = sanitizeText(request);
    const candidates = [];
    const seen = new Set();
    const addCandidate = (value) => {
        const normalized = sanitizeText(value);
        if (!normalized) {
            return;
        }

        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        candidates.push(normalized);
    };

    addCandidate(source);

    const recentUserMessages = collectRecentUserMessages(recentMessages);
    if (recentUserMessages.length === 0 || !source || !isLikelyDeferredFollowup(source)) {
        return candidates;
    }

    const strippedSource = stripReferentialScheduleWrapper(source);
    for (let index = recentUserMessages.length - 1; index >= 0; index -= 1) {
        const prior = recentUserMessages[index];
        if (!prior || prior.toLowerCase() === source.toLowerCase()) {
            continue;
        }

        addCandidate(`${prior}. ${source}`);

        if (isLikelyDeferredFollowup(source) && strippedSource && strippedSource.toLowerCase() !== source.toLowerCase()) {
            addCandidate(`${prior}. ${strippedSource}`);
            addCandidate(`${prior} ${strippedSource}`);
        }
    }

    return candidates;
}

function scoreScenarioCandidate(candidate = {}) {
    const scenario = candidate?.scenario || null;
    if (!scenario?.prompt || !scenario?.title) {
        return Number.NEGATIVE_INFINITY;
    }

    if (!['once', 'cron'].includes(String(scenario?.trigger?.type || '').trim().toLowerCase())) {
        return Number.NEGATIVE_INFINITY;
    }

    let score = 100;
    if (!isLikelyDeferredFollowup(scenario.prompt)) {
        score += 15;
    }
    score += Math.min(scenario.prompt.length, 120) / 10;
    return score;
}

function resolveDeferredWorkloadPreflight({
    text = '',
    recentMessages = [],
    timezone = null,
    now = null,
} = {}) {
    const request = sanitizeText(text);
    if (!request) {
        return {
            timing: 'now',
            shouldSchedule: false,
            request,
            scenario: null,
        };
    }

    if (hasImmediateOrNoDeferCue(request)) {
        return {
            timing: 'now',
            shouldSchedule: false,
            request,
            scenario: null,
        };
    }

    const candidates = buildScenarioCandidates(request, recentMessages);
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    candidates.forEach((candidate) => {
        if (!hasExplicitDeferredTimingCue(candidate) || !hasWorkloadIntent(candidate)) {
            return;
        }

        try {
            const scenario = parseWorkloadScenario(candidate, {
                ...(timezone ? { timezone } : {}),
                ...(now ? { now } : {}),
            });
            const scored = scoreScenarioCandidate({ source: candidate, scenario });
            if (scored > bestScore) {
                best = {
                    request: candidate,
                    scenario,
                };
                bestScore = scored;
            }
        } catch (_error) {
            // Ignore invalid candidates and keep searching.
        }
    });

    if (!best) {
        return {
            timing: 'now',
            shouldSchedule: false,
            request,
            scenario: null,
        };
    }

    return {
        timing: 'future',
        shouldSchedule: true,
        request: best.request,
        scenario: best.scenario,
    };
}

module.exports = {
    resolveDeferredWorkloadPreflight,
};

'use strict';

const { normalizeTimezone } = require('./cron-utils');
const { normalizePolicy } = require('./schema');

const DEFAULT_TIME_INFO = Object.freeze({
    hour: 9,
    minute: 0,
});

const WEEKDAY_TO_CRON = Object.freeze({
    sunday: '0',
    monday: '1',
    tuesday: '2',
    wednesday: '3',
    thursday: '4',
    friday: '5',
    saturday: '6',
});

const NUMBER_WORD_VALUES = Object.freeze({
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
});

const TENS_WORD_VALUES = Object.freeze({
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
});

const ONES_NUMBER_WORD_FRAGMENT = 'one|two|three|four|five|six|seven|eight|nine';
const SIMPLE_NUMBER_WORD_FRAGMENT = 'a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TENS_NUMBER_WORD_FRAGMENT = 'twenty|thirty|forty|fifty|sixty';
const RELATIVE_DELAY_AMOUNT_FRAGMENT = `(?:\\d+|${SIMPLE_NUMBER_WORD_FRAGMENT}|${TENS_NUMBER_WORD_FRAGMENT}(?:[-\\s](?:${ONES_NUMBER_WORD_FRAGMENT}))?)`;
const TODAY_SCHEDULE_FRAGMENT = 'today\\b(?![\'’]s)';

const SCHEDULE_TASK_VERB_FRAGMENT = '(?:run|do|check|review|research|summarize|follow\\s+up|watch|remind|collect|gather|create|make|generate|build|write|prepare|send|report|monitor|audit|scan|call|ping)';
const SCHEDULING_SETUP_VERB_FRAGMENT = '(?:set\\s+up|setup|schedule|queue|save|remind)';
const WEEKLY_CADENCE_FRAGMENT = '(?:every\\s+week\\b|each\\s+week\\b|weekly\\s+(?:to\\b|basis\\b|automation\\b|workloads?\\b|follow-?ups?\\b|tasks?\\b|jobs?\\b|runs?\\b|checks?\\b|reminders?\\b|occurrences?\\b|recurrences?\\b))';

function hasImmediateOrNoDeferCue(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    const nowCueText = normalized.replace(/\bfrom\s+now\b/g, '');

    if (/\b(?:right\s+)?now\b/.test(nowCueText)) {
        return true;
    }

    return [
        /\bimmediately\b/,
        /\basap\b/,
        /\bdo\s+not\s+(?:defer|schedule|queue)\b/,
        /\bdon't\s+(?:defer|schedule|queue)\b/,
        /\bwithout\s+(?:deferring|scheduling|queueing)\b/,
        /\bnot\s+(?:deferred|scheduled|queued|later)\b/,
        /\bno\s+(?:deferred|scheduled|queued)\s+(?:work|agent|call|task|job)s?\b/,
    ].some((pattern) => pattern.test(normalized));
}

function getDefaultTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function buildRelativeDelayPattern(flags = 'i') {
    return new RegExp(
        `\\b(?:(?:in|after)\\s+(${RELATIVE_DELAY_AMOUNT_FRAGMENT})\\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\\b(?:\\s+from\\s+now)?|(${RELATIVE_DELAY_AMOUNT_FRAGMENT})\\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\\b\\s+from\\s+now)`,
        flags,
    );
}

function convertAmountAndUnitToMs(amount = null, unit = '') {
    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    const normalizedUnit = String(unit || '').trim().toLowerCase();
    if (normalizedUnit.startsWith('h')) {
        return amount * 60 * 60 * 1000;
    }
    if (normalizedUnit.startsWith('m')) {
        return amount * 60 * 1000;
    }

    return null;
}

function parseRelativeAmountToken(value = '') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ');
    if (!normalized) {
        return null;
    }

    if (/^\d+$/.test(normalized)) {
        const amount = Number(normalized);
        return Number.isFinite(amount) ? amount : null;
    }

    if (Object.prototype.hasOwnProperty.call(NUMBER_WORD_VALUES, normalized)) {
        return NUMBER_WORD_VALUES[normalized];
    }

    if (Object.prototype.hasOwnProperty.call(TENS_WORD_VALUES, normalized)) {
        return TENS_WORD_VALUES[normalized];
    }

    const parts = normalized.split(' ');
    if (parts.length === 2
        && Object.prototype.hasOwnProperty.call(TENS_WORD_VALUES, parts[0])
        && Object.prototype.hasOwnProperty.call(NUMBER_WORD_VALUES, parts[1])
        && NUMBER_WORD_VALUES[parts[1]] < 10) {
        return TENS_WORD_VALUES[parts[0]] + NUMBER_WORD_VALUES[parts[1]];
    }

    return null;
}

function extractRelativeDelayMs(input = '') {
    const text = String(input || '').trim();
    const match = text.match(buildRelativeDelayPattern());
    if (!match) {
        return null;
    }

    const amount = parseRelativeAmountToken(match[1] || match[3]);
    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    return convertAmountAndUnitToMs(amount, match[2] || match[4] || '');
}

function extractScenarioTime(input = '') {
    const text = String(input || '').trim();
    const twelveHourMatch = text.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s*(am|pm)\b/i);
    if (twelveHourMatch) {
        const rawHour = Number(twelveHourMatch[1]);
        const minute = Number(twelveHourMatch[2] || 0);
        const meridiem = twelveHourMatch[3].toLowerCase();
        let hour = rawHour % 12;
        if (meridiem === 'pm') {
            hour += 12;
        }

        return { hour, minute };
    }

    const twentyFourHourMatch = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (twentyFourHourMatch) {
        return {
            hour: Number(twentyFourHourMatch[1]),
            minute: Number(twentyFourHourMatch[2]),
        };
    }

    if (/\bmorning\b/i.test(text)) {
        return { hour: 9, minute: 0 };
    }
    if (/\bafternoon\b/i.test(text)) {
        return { hour: 14, minute: 0 };
    }
    if (/\bevening\b/i.test(text)) {
        return { hour: 18, minute: 0 };
    }
    if (/\bnight\b|\bnightly\b/i.test(text)) {
        return { hour: 23, minute: 0 };
    }

    return { ...DEFAULT_TIME_INFO };
}

function hasTodayScheduleCue(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized || !new RegExp(`\\b${TODAY_SCHEDULE_FRAGMENT}`, 'i').test(normalized)) {
        return false;
    }

    if (/\blater today\b/i.test(normalized)) {
        return true;
    }

    const timeFragment = '(?:1[0-2]|0?\\d)(?::[0-5]\\d)?\\s*(?:am|pm)|(?:[01]?\\d|2[0-3]):[0-5]\\d';
    if (/\bfor today\b/i.test(normalized)
        && !new RegExp(`\\b${SCHEDULING_SETUP_VERB_FRAGMENT}\\b[\\s\\S]{0,48}\\bfor\\s+today\\b`, 'i').test(normalized)
        && !new RegExp(`\\bat\\s+${timeFragment}\\s+today\\b`, 'i').test(normalized)) {
        return false;
    }

    const patterns = [
        new RegExp(`\\btoday\\s+(?:at\\s+)?${timeFragment}\\b`, 'i'),
        new RegExp(`\\bat\\s+${timeFragment}\\s+today\\b`, 'i'),
        new RegExp(`\\b${SCHEDULE_TASK_VERB_FRAGMENT}\\b[\\s\\S]{0,48}\\btoday\\b`, 'i'),
        new RegExp(`\\btoday\\b[\\s\\S]{0,48}\\b${SCHEDULE_TASK_VERB_FRAGMENT}\\b`, 'i'),
        new RegExp(`\\b${SCHEDULING_SETUP_VERB_FRAGMENT}\\b[\\s\\S]{0,48}\\btoday\\b`, 'i'),
    ];

    return patterns.some((pattern) => pattern.test(normalized));
}

function getZonedDateParts(date = new Date(), timezone = 'UTC') {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: normalizeTimezone(timezone || getDefaultTimezone()),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const readPart = (type) => Number(parts.find((entry) => entry.type === type)?.value || 0);

    return {
        year: readPart('year'),
        month: readPart('month'),
        day: readPart('day'),
        hour: readPart('hour'),
        minute: readPart('minute'),
        second: readPart('second'),
    };
}

function buildUtcDateFromZonedParts(parts = {}, timezone = 'UTC') {
    const utcGuess = Date.UTC(
        Number(parts.year) || 0,
        Math.max(0, (Number(parts.month) || 1) - 1),
        Number(parts.day) || 1,
        Number(parts.hour) || 0,
        Number(parts.minute) || 0,
        Number(parts.second) || 0,
        0,
    );
    const guessDate = new Date(utcGuess);
    const guessParts = getZonedDateParts(guessDate, timezone);
    const targetAsUtc = Date.UTC(
        Number(parts.year) || 0,
        Math.max(0, (Number(parts.month) || 1) - 1),
        Number(parts.day) || 1,
        Number(parts.hour) || 0,
        Number(parts.minute) || 0,
        Number(parts.second) || 0,
        0,
    );
    const guessAsUtc = Date.UTC(
        guessParts.year || 0,
        Math.max(0, (guessParts.month || 1) - 1),
        guessParts.day || 1,
        guessParts.hour || 0,
        guessParts.minute || 0,
        guessParts.second || 0,
        0,
    );

    return new Date(utcGuess + (targetAsUtc - guessAsUtc));
}

function addDaysToZonedDateParts(parts = {}, dayCount = 0) {
    const day = new Date(Date.UTC(
        Number(parts.year) || 0,
        Math.max(0, (Number(parts.month) || 1) - 1),
        Number(parts.day) || 1,
        0,
        0,
        0,
        0,
    ));
    day.setUTCDate(day.getUTCDate() + dayCount);

    return {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
    };
}

function buildOneTimeRunAt(lowerScenario = '', timeInfo = DEFAULT_TIME_INFO, now = new Date(), timezone = 'UTC') {
    const baseNow = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    const relativeDelayMs = extractRelativeDelayMs(lowerScenario);
    if (relativeDelayMs != null) {
        return new Date(baseNow.getTime() + relativeDelayMs);
    }

    const resolvedTimezone = normalizeTimezone(timezone || getDefaultTimezone());
    const zonedNow = getZonedDateParts(baseNow, resolvedTimezone);
    const buildRunAt = (dateParts, hour, minute) => buildUtcDateFromZonedParts({
        ...dateParts,
        hour,
        minute,
        second: 0,
    }, resolvedTimezone);
    const nextLocalHour = buildRunAt(
        addDaysToZonedDateParts(zonedNow, Math.floor((zonedNow.hour + 1) / 24)),
        (zonedNow.hour + 1) % 24,
        0,
    );
    const sameDay = {
        year: zonedNow.year,
        month: zonedNow.month,
        day: zonedNow.day,
    };
    let runAt = buildRunAt(sameDay, timeInfo.hour, timeInfo.minute);

    if (/\btomorrow\b/i.test(lowerScenario)) {
        return buildRunAt(addDaysToZonedDateParts(zonedNow, 1), timeInfo.hour, timeInfo.minute);
    }

    if (/\blater today\b/i.test(lowerScenario)) {
        return runAt <= baseNow ? nextLocalHour : runAt;
    }

    if (hasTodayScheduleCue(lowerScenario)) {
        if (runAt <= baseNow) {
            runAt = buildRunAt(addDaysToZonedDateParts(zonedNow, 1), timeInfo.hour, timeInfo.minute);
        }
        return runAt;
    }

    if (runAt <= baseNow) {
        runAt = nextLocalHour;
    }

    return runAt;
}

function createCronExpression(timeInfo = DEFAULT_TIME_INFO, cadence = 'daily') {
    const minute = Number(timeInfo.minute || 0);
    const hour = Number(timeInfo.hour || 0);

    if (cadence === 'hourly') {
        return `${minute} * * * *`;
    }

    if (cadence === 'weekdays') {
        return `${minute} ${hour} * * 1-5`;
    }

    if (cadence === 'weekly') {
        return `${minute} ${hour} * * 1`;
    }

    if (WEEKDAY_TO_CRON[cadence]) {
        return `${minute} ${hour} * * ${WEEKDAY_TO_CRON[cadence]}`;
    }

    return `${minute} ${hour} * * *`;
}

function hasDocumentBuildIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return (
        /\b(document|doc|docs|report|brief|proposal|guide|summary|one-pager|whitepaper|slides|presentation|deck|pptx|docx|pdf|html(?:\s+document|\s+page)?|web\s+page|spec|plan)\b/.test(normalized)
        && /\b(create|make|generate|build|prepare|draft|write|assemble|compile|organize|turn|convert|export)\b/.test(normalized)
    ) || /\bmultiple documents\b/.test(normalized);
}

function isBrutalBuilderMetaDiscussion(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(i want a feature|feature called|can be asked for|goal being|that means|should mean|if i say)\b/.test(normalized);
}

function extractRunCount(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    const match = normalized.match(new RegExp(`\\b(${RELATIVE_DELAY_AMOUNT_FRAGMENT}|couple|few|several|multiple)\\s+(?:runs?|passes?|reviews?|times?)\\b`, 'i'))
        || normalized.match(new RegExp(`\\bdo\\s+it\\s+(${RELATIVE_DELAY_AMOUNT_FRAGMENT}|couple|few|several|multiple)\\s+times?\\b`, 'i'));
    if (!match) {
        return null;
    }

    const token = String(match[1] || '').trim().toLowerCase();
    if (token === 'couple') {
        return 4;
    }
    if (token === 'few' || token === 'several') {
        return 4;
    }
    if (token === 'multiple') {
        return 4;
    }

    return parseRelativeAmountToken(token);
}

function extractDurationWindowMs(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    const directApartMatch = normalized.match(new RegExp(`\\b(${RELATIVE_DELAY_AMOUNT_FRAGMENT})\\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\\s+apart\\b`, 'i'));
    if (directApartMatch) {
        const amount = parseRelativeAmountToken(directApartMatch[1]);
        return convertAmountAndUnitToMs(amount, directApartMatch[2]);
    }

    const windowMatch = normalized.match(new RegExp(`\\b(?:take|over|across|within|in)\\s+(${RELATIVE_DELAY_AMOUNT_FRAGMENT})\\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\\b`, 'i'))
        || normalized.match(new RegExp(`\\b(${RELATIVE_DELAY_AMOUNT_FRAGMENT})\\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\\s+(?:total|window)\\b`, 'i'));
    if (!windowMatch) {
        return null;
    }

    const amount = parseRelativeAmountToken(windowMatch[1]);
    return convertAmountAndUnitToMs(amount, windowMatch[2]);
}

function extractBrutalBuilderPlan(input = '') {
    const text = String(input || '').trim();
    const normalized = text.toLowerCase();
    if (!text || isBrutalBuilderMetaDiscussion(normalized)) {
        return null;
    }

    const hasBuilderCue = /\bbrutal builder\b/.test(normalized);
    const hasPassCue = /\b(?:pass|passes|run|runs|review|reviews)\b/.test(normalized)
        || /\bdo it\b[\s\S]{0,20}\btimes?\b/.test(normalized);
    const hasFastCue = /\b(quick|quickly|fast)\b/.test(normalized);
    const hasSlowCue = /\b(take your time|improve this|improve it|polish this|polish it)\b/.test(normalized);

    if (!hasBuilderCue && !hasPassCue && !hasSlowCue) {
        return null;
    }
    if (!hasDocumentBuildIntent(normalized)) {
        return null;
    }

    const explicitRunCount = extractRunCount(normalized);
    const explicitWindowMs = extractDurationWindowMs(normalized);
    const explicitApartMatch = normalized.match(/\b(?:runs?|passes?|reviews?)\b[\s\S]{0,40}\bapart\b/)
        || normalized.match(/\bapart\b/);

    if (explicitRunCount && explicitWindowMs && !explicitApartMatch) {
        const intervalMs = Math.max(5 * 60 * 1000, Math.round(explicitWindowMs / explicitRunCount));
        return {
            enabled: true,
            totalRuns: Math.max(1, explicitRunCount),
            intervalMs,
            windowMs: explicitWindowMs,
            requestedStyle: 'windowed',
        };
    }

    if (explicitRunCount && explicitWindowMs && explicitApartMatch) {
        return {
            enabled: true,
            totalRuns: Math.max(1, explicitRunCount),
            intervalMs: explicitWindowMs,
            windowMs: explicitWindowMs * Math.max(1, explicitRunCount),
            requestedStyle: 'fixed-interval',
        };
    }

    if (hasFastCue && /\bcouple\b/.test(normalized) && hasPassCue) {
        return {
            enabled: true,
            totalRuns: 4,
            intervalMs: 10 * 60 * 1000,
            windowMs: 40 * 60 * 1000,
            requestedStyle: 'quick',
        };
    }

    if (hasSlowCue) {
        const totalRuns = explicitRunCount || 8;
        const windowMs = explicitWindowMs || (4 * 60 * 60 * 1000);
        return {
            enabled: true,
            totalRuns,
            intervalMs: Math.max(5 * 60 * 1000, Math.round(windowMs / totalRuns)),
            windowMs,
            requestedStyle: 'slow',
        };
    }

    if (hasBuilderCue && explicitRunCount && explicitWindowMs) {
        return {
            enabled: true,
            totalRuns: Math.max(1, explicitRunCount),
            intervalMs: Math.max(5 * 60 * 1000, Math.round(explicitWindowMs / explicitRunCount)),
            windowMs: explicitWindowMs,
            requestedStyle: 'windowed',
        };
    }

    if (hasBuilderCue && explicitRunCount && explicitApartMatch && explicitWindowMs) {
        return {
            enabled: true,
            totalRuns: Math.max(1, explicitRunCount),
            intervalMs: explicitWindowMs,
            windowMs: explicitWindowMs * Math.max(1, explicitRunCount),
            requestedStyle: 'fixed-interval',
        };
    }

    return null;
}

function stripBrutalBuilderDirectiveText(text = '') {
    let result = String(text || '').trim();
    if (!result) {
        return result;
    }

    result = result.replace(/\b(?:use\s+)?brutal builder\b[:,-]?\s*/gi, '');
    result = result.replace(/\b(?:and\s+)?take a couple passes(?: at this)? quickly\b/gi, '');
    result = result.replace(/\b(?:and\s+)?take your time(?: and)? improve (?:this|it)\b/gi, '');
    result = result.replace(new RegExp(`\\b(?:and\\s+)?take\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)\\s+and\\s+do\\s+it\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s+times?(?:\\s+in\\s+that\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?))?\\b`, 'gi'), '');
    result = result.replace(new RegExp(`\\b(?:and\\s+)?do\\s+it\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s+times?\\s+in\\s+(?:that\\s+)?${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)\\b`, 'gi'), '');
    result = result.replace(new RegExp(`\\b(?:and\\s+)?(?:take|do)\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s+(?:runs?|passes?|reviews?)\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)\\s+apart\\b`, 'gi'), '');

    return result
        .replace(/^\s*to\s+/i, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([,.!?])/g, '$1')
        .replace(/[,\s-]+$/, '')
        .trim();
}

function extractTaskPromptFromScenario(scenario = '') {
    const timeFragment = '(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|morning|afternoon|evening|night)';
    const relativeDelayFragment = `(?:(?:in|after)\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)(?:\\s+from\\s+now)?|${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)\\s+from\\s+now)`;
    const explicitDayFragment = hasTodayScheduleCue(scenario)
        ? `(?:tomorrow|later today|${TODAY_SCHEDULE_FRAGMENT})`
        : '(?:tomorrow|later today)';
    const leadingPatterns = [
        new RegExp(`^(?:every hour|hourly)(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        new RegExp(`^(?:${WEEKLY_CADENCE_FRAGMENT})(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        new RegExp(`^(?:every|each)\\s+weekdays?(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        new RegExp(`^(?:every|each)\\s+workdays?(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        new RegExp(`^(?:daily|nightly)(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        new RegExp(`^(?:every\\s+day|everyday|each\\s+day)(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        new RegExp(`^(?:every|each)\\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        new RegExp(`^(?:${relativeDelayFragment})[\\s,:-]*`, 'i'),
        new RegExp(`^(?:once|one[- ]time)(?:\\s+(?:${explicitDayFragment}))?(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
        new RegExp(`^(?:${explicitDayFragment})(?:\\s+at\\s+${timeFragment})?[\\s,:-]*`, 'i'),
    ];
    const embeddedPatterns = [
        new RegExp(`\\b(?:every hour|hourly)(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        new RegExp(`\\b(?:${WEEKLY_CADENCE_FRAGMENT})(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        new RegExp(`\\b(?:every|each)\\s+weekdays?(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        new RegExp(`\\b(?:every|each)\\s+workdays?(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        new RegExp(`\\b(?:daily|nightly)(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        new RegExp(`\\b(?:every\\s+day|everyday|each\\s+day)(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        new RegExp(`\\b(?:every|each)\\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        new RegExp(`\\b(?:${relativeDelayFragment})\\b`, 'gi'),
        new RegExp(`\\b(?:once|one[- ]time)(?:\\s+(?:${explicitDayFragment}))?(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
        new RegExp(`\\b(?:${explicitDayFragment})(?:\\s+at\\s+${timeFragment})?\\b`, 'gi'),
    ];

    let taskPrompt = String(scenario || '').trim();
    leadingPatterns.forEach((pattern) => {
        taskPrompt = taskPrompt.replace(pattern, '');
    });
    embeddedPatterns.forEach((pattern) => {
        taskPrompt = taskPrompt.replace(pattern, '');
    });
    taskPrompt = taskPrompt.replace(
        /^(?:please\s+)?(?:set(?:\s+(?:this|it))?\s+up|schedule(?:\s+(?:this|it))?|create|make|add|queue|save)\s+(?:(?:a|an)\s+)?(?:(?:daily|weekly|hourly|nightly|recurring|one[- ]time)\s+)?(?:(?:agent|assistant)\s+)?(?:workloads?|automations?|follow-?ups?|tasks?|jobs?)\s*(?:to\s+|for\s+)?/i,
        '',
    );
    taskPrompt = taskPrompt.replace(/^(?:can|could|would)\s+you\s+/i, '');
    taskPrompt = taskPrompt.replace(/^(?:please\s+)?(?:set\s+(?:this|it)\s+up|schedule\s+(?:this|it))\s+(?:to\s+)?/i, '');
    taskPrompt = taskPrompt.replace(
        /^(?:please\s+)?(?:run|set(?:\s+(?:this|it))?\s+up|schedule(?:\s+(?:this|it))?|create|make|add|queue|save)\s+(?:(?:a|an)\s+)?cron(?:\s+jobs?)?\s*(?:later\s*)?(?:to\s+|for\s+)?/i,
        '',
    );
    taskPrompt = taskPrompt.replace(
        /^(?:please\s+)?(?:run|set(?:\s+(?:this|it))?\s+up|schedule(?:\s+(?:this|it))?|create|make|add|queue|save)\s+(?:(?:a|an)\s+)?(?:(?:cron|scheduled?|deferred)\s+)?(?:(?:daily|weekly|hourly|nightly|recurring|one[- ]time)\s+)?(?:(?:agent|assistant)\s+)?(?:workloads?|automations?|follow-?ups?|tasks?|jobs?|checks?)\s*(?:later\s*)?(?:to\s+|for\s+)?/i,
        '',
    );
    taskPrompt = taskPrompt.replace(
        /^(?:please\s+)?(?:run|set(?:\s+(?:this|it))?\s+up|schedule(?:\s+(?:this|it))?|create|make|add|queue|save)\s+(?:(?:a|an)\s+)?to\s+/i,
        '',
    );
    taskPrompt = taskPrompt.replace(/^(?:have|let)\s+(?:the\s+)?(?:agent|assistant)\s+/i, '');
    taskPrompt = taskPrompt.replace(/\bcron\b/gi, ' ');
    taskPrompt = stripBrutalBuilderDirectiveText(taskPrompt);

    return taskPrompt
        .trim()
        .replace(/^[,\s-]+/, '')
        .replace(/[,\s-]+$/, '')
        .replace(/\s{2,}/g, ' ')
        || String(scenario || '').trim();
}

function deriveWorkloadTitle(prompt = '') {
    const words = String(prompt || '')
        .trim()
        .replace(/[^\w\s-]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5);

    if (words.length === 0) {
        return 'New workload';
    }

    return words
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function slugifyWorkloadValue(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

function hasSchedulingCue(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (extractBrutalBuilderPlan(normalized)) {
        return true;
    }

    return hasTodayScheduleCue(normalized) || [
        /\bevery hour\b/,
        /\bhourly\b/,
        /\bweekday\b/,
        /\bweekdays\b/,
        /\bevery workday\b/,
        /\beach workday\b/,
        /\bdaily\b/,
        /\bevery day\b/,
        /\beveryday\b/,
        /\beach day\b/,
        /\bnightly\b/,
        /\bevery night\b/,
        /\bevery morning\b/,
        /\bevery evening\b/,
        new RegExp(`\\b${WEEKLY_CADENCE_FRAGMENT}\\b`),
        /\b(?:every|each)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/,
        /\btomorrow\b/,
        /\blater today\b/,
        buildRelativeDelayPattern(),
        /\bone[- ]time\b/,
        /\bonce\b/,
        /\bcron\b/,
        /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/,
        /\b([01]?\d|2[0-3]):([0-5]\d)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasWorkloadIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (extractBrutalBuilderPlan(normalized)) {
        return true;
    }

    if (hasImmediateOrNoDeferCue(normalized)) {
        return false;
    }

    const scheduleIntentFragment = `(?:${WEEKLY_CADENCE_FRAGMENT}|every|daily|hourly|weekdays?|tomorrow|later today|once|at\\s+(?:1[0-2]|0?\\d)(?::[0-5]\\d)?\\s*(?:am|pm)|at\\s+(?:[01]?\\d|2[0-3]):[0-5]\\d|(?:(?:in|after)\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)(?:\\s+from\\s+now)?|${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)\\s+from\\s+now))`;
    const timedTaskScheduleIntentFragment = `(?:${WEEKLY_CADENCE_FRAGMENT}|every\\s+(?:day|weekday|workday|hour)|each\\s+(?:day|weekday|workday)|hourly|weekdays?|tomorrow|later today|once|at\\s+(?:1[0-2]|0?\\d)(?::[0-5]\\d)?\\s*(?:am|pm)|at\\s+(?:[01]?\\d|2[0-3]):[0-5]\\d|(?:(?:in|after)\\s+${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)(?:\\s+from\\s+now)?|${RELATIVE_DELAY_AMOUNT_FRAGMENT}\\s*(?:minutes?|mins?|hours?|hrs?)\\s+from\\s+now))`;

    const hasExplicitWorkloadSetup = [
        /\b(set up|setup|schedule|create|make|add|queue|save)\b[\s\S]{0,24}\b(?:an?\s+|the\s+)?(?:automation|workloads?|follow-?ups?|reminders?|cron(?:\s+jobs?)?|scheduled\s+jobs?|scheduled\s+tasks?|recurring\s+jobs?|recurring\s+tasks?)\b/,
        new RegExp(`\\b(set up|setup|schedule|queue|save)\\b[\\s\\S]{0,60}\\b${scheduleIntentFragment}\\b`),
    ].some((pattern) => pattern.test(normalized));

    const taskVerbFragment = '(?:run|do|check|review|research|summarize|follow up|watch|remind|collect|gather|create|make|generate|build|write|prepare|send|report|monitor|audit|scan|give(?:\\s+me)?|break\\s*down|breakdown)';
    const hasTimedTaskRequest = [
        new RegExp(`\\b${taskVerbFragment}\\b[\\s\\S]{0,40}\\b${timedTaskScheduleIntentFragment}\\b`),
        new RegExp(`\\b${timedTaskScheduleIntentFragment}\\b[\\s\\S]{0,60}\\b${taskVerbFragment}\\b`),
    ].some((pattern) => pattern.test(normalized));

    return hasSchedulingCue(normalized) && (hasExplicitWorkloadSetup || hasTimedTaskRequest);
}

function inferWorkloadPolicy(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
        return normalizePolicy({});
    }

    const hasRemoteTarget = /\b(remote|server|cluster|k3s|k8s|kubernetes|ssh|deployment|deploy|rollout|container|docker|pod|service|ingress|production|environment|gitlab|gitea|sandbox)\b/.test(normalized);
    const hasBuildVerb = /\b(build|create|develop|make|install|set up|configure|repair|fix|restart|publish|push|update|deploy|rollout|ship|launch|scaffold)\b/.test(normalized);
    const hasRemoteEnvironmentIntent = hasRemoteTarget && hasBuildVerb;

    if (hasRemoteEnvironmentIntent) {
        return normalizePolicy({
            executionProfile: 'remote-build',
            allowSideEffects: true,
        });
    }

    return normalizePolicy({});
}

function hasImplicitRecurringJobIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(set up|setup|schedule|create|make|add|queue|save)\b[\s\S]{0,24}\b(?:an?\s+|the\s+)?(?:automation|workloads?|follow-?ups?|reminders?|cron(?:\s+jobs?)?|scheduled\s+jobs?|scheduled\s+tasks?|recurring\s+jobs?|recurring\s+tasks?)\b/.test(normalized);
}

function inferDefaultRecurringTrigger(scenario = '', timezone = 'UTC') {
    const normalized = String(scenario || '').trim().toLowerCase();
    const hasConcreteTimingCue = hasTodayScheduleCue(normalized) || [
        /\bevery hour\b/,
        /\bhourly\b/,
        /\bweekday\b/,
        /\bweekdays\b/,
        /\bevery workday\b/,
        /\beach workday\b/,
        /\bdaily\b/,
        /\bevery day\b/,
        /\beveryday\b/,
        /\beach day\b/,
        /\bnightly\b/,
        /\bevery night\b/,
        /\bevery morning\b/,
        /\bevery evening\b/,
        new RegExp(`\\b${WEEKLY_CADENCE_FRAGMENT}\\b`),
        /\b(?:every|each)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/,
        /\btomorrow\b/,
        /\blater today\b/,
        buildRelativeDelayPattern(),
        /\bone[- ]time\b/,
        /\bonce\b/,
        /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/,
        /\b([01]?\d|2[0-3]):([0-5]\d)\b/,
    ].some((pattern) => pattern.test(normalized));

    if (!normalized || !hasImplicitRecurringJobIntent(normalized) || hasConcreteTimingCue) {
        return null;
    }

    if (/\b(update|updates|upgrade|upgrades|patch|patches)\b/.test(normalized)) {
        return {
            type: 'cron',
            expression: '0 2 * * 1',
            timezone,
        };
    }

    if (/\b(check|checks|monitor|monitoring|audit|audits|scan|scans|health|verify|verification|security)\b/.test(normalized)) {
        return {
            type: 'cron',
            expression: '0 9 * * *',
            timezone,
        };
    }

    return {
        type: 'cron',
        expression: '0 9 * * *',
        timezone,
    };
}

function translateCronExpression(expression = '', timezone = 'UTC') {
    const normalized = String(expression || '').trim();
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length !== 5) {
        return normalized ? `Custom schedule (${normalized})` : 'Custom schedule';
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const hourValue = Number(hour);
    const minuteValue = Number(minute);
    const hasFixedTime = Number.isInteger(hourValue) && Number.isInteger(minuteValue);
    const formattedTime = hasFixedTime
        ? new Date(Date.UTC(2026, 0, 1, hourValue, minuteValue)).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: 'UTC',
        })
        : '';
    const dayNameMap = {
        0: 'Sunday',
        1: 'Monday',
        2: 'Tuesday',
        3: 'Wednesday',
        4: 'Thursday',
        5: 'Friday',
        6: 'Saturday',
        7: 'Sunday',
    };

    if (hasFixedTime && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
        return `Every day at ${formattedTime}`;
    }

    if (hasFixedTime && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
        return `Every weekday at ${formattedTime}`;
    }

    if (hasFixedTime && dayOfMonth === '*' && month === '*' && /^\d$/.test(dayOfWeek)) {
        return `Every ${dayNameMap[Number(dayOfWeek)] || 'week'} at ${formattedTime}`;
    }

    if (hour === '*' && /^\d+$/.test(minute) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
        return `Every hour at ${String(minute).padStart(2, '0')} minutes past`;
    }

    return `Custom cron ${normalized}${timezone ? ` (${timezone})` : ''}`;
}

function summarizeTrigger(trigger = {}) {
    if (!trigger || trigger.type === 'manual') {
        return 'Manual workload';
    }

    if (trigger.type === 'once') {
        return `Runs once at ${trigger.runAt}`;
    }

    return translateCronExpression(trigger.expression || '', trigger.timezone || 'UTC');
}

function parseWorkloadScenario(scenario = '', options = {}) {
    const normalizedScenario = String(scenario || '').trim();
    if (!normalizedScenario) {
        throw new Error('Describe the task and when it should run.');
    }

    const lowerScenario = normalizedScenario.toLowerCase();
    const resolvedTimezone = normalizeTimezone(options.timezone || getDefaultTimezone());
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const brutalBuilder = extractBrutalBuilderPlan(normalizedScenario);
    const timeInfo = extractScenarioTime(normalizedScenario);
    const prompt = extractTaskPromptFromScenario(normalizedScenario) || normalizedScenario;
    const title = deriveWorkloadTitle(prompt);
    const hasWeeklyCadence = new RegExp(`\\b${WEEKLY_CADENCE_FRAGMENT}\\b`, 'i').test(lowerScenario);
    const hasRecurringCadence = hasWeeklyCadence
        || /(every hour|hourly|weekday|weekdays|every workday|each workday|daily|every day|everyday|each day|nightly|every night|every evening|every morning)/i.test(lowerScenario)
        || /\b(?:every|each)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/i.test(lowerScenario);

    let trigger = { type: 'manual' };

    const hasExplicitClockTime = /\b(?:at\s+)?(?:1[0-2]|0?\d)(?::[0-5]\d)?\s*(?:am|pm)\b/i.test(lowerScenario)
        || /\bat\s+(?:[01]?\d|2[0-3]):[0-5]\d\b/i.test(lowerScenario);

    if (!hasRecurringCadence && (
        extractRelativeDelayMs(lowerScenario) != null
        || hasExplicitClockTime
        || /\b(?:tomorrow|later today)\b/i.test(lowerScenario)
        || hasTodayScheduleCue(lowerScenario)
    )) {
        trigger = {
            type: 'once',
            runAt: buildOneTimeRunAt(lowerScenario, timeInfo, now, resolvedTimezone).toISOString(),
        };
    } else if (/(every hour|hourly)/i.test(lowerScenario)) {
        trigger = {
            type: 'cron',
            expression: createCronExpression(timeInfo, 'hourly'),
            timezone: resolvedTimezone,
        };
    } else if (hasWeeklyCadence) {
        trigger = {
            type: 'cron',
            expression: createCronExpression(timeInfo, 'weekly'),
            timezone: resolvedTimezone,
        };
    } else if (/(weekday|weekdays|every workday|each workday)/i.test(lowerScenario)) {
        trigger = {
            type: 'cron',
            expression: createCronExpression(timeInfo, 'weekdays'),
            timezone: resolvedTimezone,
        };
    } else {
        const weekdayMatch = lowerScenario.match(/\b(?:every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/i);
        if (weekdayMatch) {
            trigger = {
                type: 'cron',
                expression: createCronExpression(timeInfo, weekdayMatch[1].toLowerCase()),
                timezone: resolvedTimezone,
            };
        } else if (/(daily|every day|everyday|each day|nightly|every night|every evening|every morning)/i.test(lowerScenario)) {
            trigger = {
                type: 'cron',
                expression: createCronExpression(timeInfo, 'daily'),
                timezone: resolvedTimezone,
            };
        } else {
            trigger = inferDefaultRecurringTrigger(normalizedScenario, resolvedTimezone) || trigger;
        }
    }

    if (trigger.type === 'manual' && brutalBuilder) {
        trigger = {
            type: 'once',
            runAt: now.toISOString(),
        };
    }

    return {
        title,
        prompt,
        callableSlug: slugifyWorkloadValue(title) || null,
        trigger,
        brutalBuilder,
        policy: inferWorkloadPolicy(prompt),
        summary: summarizeTrigger(trigger),
        scheduleDetected: trigger.type !== 'manual',
    };
}

module.exports = {
    buildOneTimeRunAt,
    createCronExpression,
    deriveWorkloadTitle,
    extractBrutalBuilderPlan,
    extractRelativeDelayMs,
    extractScenarioTime,
    extractTaskPromptFromScenario,
    hasSchedulingCue,
    hasWorkloadIntent,
    hasImmediateOrNoDeferCue,
    inferDefaultRecurringTrigger,
    inferWorkloadPolicy,
    parseWorkloadScenario,
    slugifyWorkloadValue,
    stripBrutalBuilderDirectiveText,
    summarizeTrigger,
    translateCronExpression,
};

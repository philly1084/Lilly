const {
    isLikelyTranscriptDependentTurn,
    normalizeMessageText,
} = require('./conversation-continuity');

const COMPACTION_TRIGGER_MESSAGE_COUNT = 28;
const COMPACTION_TRIGGER_CHAR_COUNT = 60000;
const COMPACTION_COMPLETION_MIN_MESSAGES = 12;
const COMPACTION_MIN_NEW_MESSAGES = 10;
const COMPACTION_RETAIN_RECENT_MESSAGES = 8;
const COMPACTION_UNRULY_ACTIVE_MESSAGE_COUNT = 80;
const COMPACTION_UNRULY_ACTIVE_MIN_NEW_MESSAGES = 24;
const MAX_COMPLETION_REPORT_CHARS = 1400;
const MAX_OBJECTIVES = 8;
const MAX_OUTCOMES = 8;
const MAX_OPEN_ITEMS = 4;

function normalizeLine(value = '', limit = 220) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }

    return normalized.length > limit
        ? `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`
        : normalized;
}

function normalizeBlock(value = '', limit = 1400) {
    const normalized = String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!normalized) {
        return '';
    }

    return normalized.length > limit
        ? `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`
        : normalized;
}

function normalizeCompactionList(values = [], limit = 8, lineLimit = 220) {
    const items = Array.isArray(values) ? values : [];
    const unique = new Map();

    items.forEach((entry) => {
        const normalized = normalizeLine(entry, lineLimit);
        if (!normalized) {
            return;
        }

        unique.set(normalized.toLowerCase(), normalized);
    });

    return Array.from(unique.values()).slice(-limit);
}

function mergeCompactionLists(existing = [], incoming = [], limit = 8, lineLimit = 220) {
    return normalizeCompactionList([...(existing || []), ...(incoming || [])], limit, lineLimit);
}

function normalizeTranscriptMessages(messages = []) {
    return (Array.isArray(messages) ? messages : [])
        .filter((entry) => entry?.metadata?.excludeFromTranscript !== true && entry?.excludeFromTranscript !== true)
        .map((entry) => ({
            role: entry?.role,
            content: normalizeMessageText(entry?.content || ''),
            timestamp: entry?.timestamp || entry?.createdAt || entry?.created_at || new Date().toISOString(),
        }))
        .filter((entry) => ['user', 'assistant', 'system', 'tool'].includes(entry.role) && entry.content.trim());
}

function summarizeMessageContent(content = '', limit = 220) {
    const normalized = normalizeLine(
        String(content || '')
            .replace(/```[\s\S]*?```/g, '[code omitted]')
            .replace(/\n+/g, ' '),
        Math.max(limit * 2, 320),
    );
    if (!normalized) {
        return '';
    }

    const stripped = normalized
        .replace(/^Based on the verified tool results, here is the best available answer\.?\s*/i, '')
        .replace(/^Remote execution summary for:\s*/i, '')
        .replace(/^SSH command completed on [^.]+\.\s*/i, '');

    const sentence = stripped.match(/^(.{1,260}?[.!?])(?:\s|$)/);
    return normalizeLine(sentence?.[1] || stripped, limit);
}

function isMeaningfulUserObjective(text = '') {
    const normalized = normalizeLine(text, 260);
    if (!normalized || normalized.length < 24) {
        return false;
    }

    if (isLikelyTranscriptDependentTurn(normalized.toLowerCase())) {
        return false;
    }

    return !/^(thanks|thank you|ok|okay|yes|no|continue|again|retry|same|sounds good)\b/i.test(normalized);
}

function isMeaningfulAssistantOutcome(text = '') {
    const normalized = summarizeMessageContent(text, 240);
    if (!normalized || normalized.length < 24) {
        return false;
    }

    return !/^(sure|okay|alright|done|i completed the request)\b/i.test(normalized.toLowerCase());
}

function extractLatestAssistantReport(messages = []) {
    const latestAssistant = [...(Array.isArray(messages) ? messages : [])]
        .reverse()
        .find((entry) => entry?.role === 'assistant' && normalizeBlock(entry.content || '', MAX_COMPLETION_REPORT_CHARS));

    return normalizeBlock(latestAssistant?.content || '', MAX_COMPLETION_REPORT_CHARS);
}

function extractObjectiveHighlights(messages = []) {
    return normalizeCompactionList(
        (Array.isArray(messages) ? messages : [])
            .filter((entry) => entry?.role === 'user')
            .map((entry) => summarizeMessageContent(entry.content || '', 200))
            .filter((entry) => isMeaningfulUserObjective(entry)),
        MAX_OBJECTIVES,
        200,
    );
}

function extractOutcomeHighlights(messages = []) {
    return normalizeCompactionList(
        (Array.isArray(messages) ? messages : [])
            .filter((entry) => entry?.role === 'assistant')
            .map((entry) => summarizeMessageContent(entry.content || '', 220))
            .filter((entry) => isMeaningfulAssistantOutcome(entry)),
        MAX_OUTCOMES,
        220,
    );
}

function extractOpenItems({ workflow = null, projectMemory = null } = {}) {
    const items = [];

    if (workflow?.status === 'blocked') {
        items.push(`Blocked workflow: ${normalizeLine(workflow.lastError || `${workflow.lane || 'workflow'} is blocked.`, 220)}`);
    } else if (workflow?.status === 'active') {
        items.push(`Active workflow: ${normalizeLine(`${workflow.lane || 'workflow'} at stage ${workflow.stage || 'planned'}`, 180)}`);
    }

    const partialTask = Array.isArray(projectMemory?.tasks)
        ? [...projectMemory.tasks].reverse().find((task) => String(task?.status || '').trim().toLowerCase() === 'partial')
        : null;
    if (partialTask?.summary) {
        items.push(`Latest partial task: ${normalizeLine(partialTask.summary, 220)}`);
    }

    return normalizeCompactionList(items, MAX_OPEN_ITEMS, 220);
}

function buildCompactionSummaryText(compaction = {}) {
    const objectives = normalizeCompactionList(compaction?.objectives || [], MAX_OBJECTIVES, 200);
    const outcomes = normalizeCompactionList(compaction?.outcomes || [], MAX_OUTCOMES, 220);
    const openItems = normalizeCompactionList(compaction?.openItems || [], MAX_OPEN_ITEMS, 220);
    const completionReport = normalizeBlock(compaction?.completionReport || '', MAX_COMPLETION_REPORT_CHARS);
    const compactedMessageCount = Math.max(0, Number(compaction?.compactedMessageCount || 0));
    const lines = [];

    if (objectives.length > 0) {
        lines.push('Key user requests from earlier turns:');
        objectives.forEach((entry) => lines.push(`- ${entry}`));
    }

    if (outcomes.length > 0) {
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push('Key outcomes already established:');
        outcomes.forEach((entry) => lines.push(`- ${entry}`));
    }

    if (openItems.length > 0) {
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push('Open state to preserve:');
        openItems.forEach((entry) => lines.push(`- ${entry}`));
    }

    if (completionReport) {
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push('Final user-visible completion report:');
        lines.push(completionReport);
    }

    if (compactedMessageCount > 0) {
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push(`Compacted through ${compactedMessageCount} transcript messages in this session.`);
    }

    return lines.join('\n').trim();
}

function normalizeSessionCompaction(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const normalized = {
        compactedMessageCount: Math.max(0, Number(source.compactedMessageCount || 0)),
        objectives: normalizeCompactionList(source.objectives || [], MAX_OBJECTIVES, 200),
        outcomes: normalizeCompactionList(source.outcomes || [], MAX_OUTCOMES, 220),
        openItems: normalizeCompactionList(source.openItems || [], MAX_OPEN_ITEMS, 220),
        completionReport: normalizeBlock(source.completionReport || '', MAX_COMPLETION_REPORT_CHARS) || null,
        updatedAt: normalizeLine(source.updatedAt || '', 80) || null,
        trigger: normalizeLine(source.trigger || '', 64) || null,
    };
    const summary = normalizeLine(source.summary || '', 2400) || buildCompactionSummaryText(normalized);

    return {
        ...normalized,
        summary,
    };
}

function inferCompactionTrigger(workflow = null) {
    if (workflow?.status === 'completed') {
        return 'workflow-completed';
    }

    if (workflow?.status === 'blocked') {
        return 'workflow-blocked';
    }

    if (workflow?.status === 'active') {
        return 'active-workflow-transcript-unruly';
    }

    return 'transcript-growth';
}

function shouldCompactSession({
    messages = [],
    existingCompaction = null,
    workflow = null,
} = {}) {
    const transcriptMessages = normalizeTranscriptMessages(messages);
    const existing = normalizeSessionCompaction(existingCompaction || {});
    const workflowStatus = String(workflow?.status || '').trim().toLowerCase();
    const completionPoint = ['completed', 'blocked'].includes(workflowStatus);
    const activeWorkflow = workflowStatus === 'active';
    const nextCompactedMessageCount = Math.max(0, transcriptMessages.length - COMPACTION_RETAIN_RECENT_MESSAGES);
    const newlyCompactedMessages = nextCompactedMessageCount - existing.compactedMessageCount;
    const transcriptChars = transcriptMessages.reduce((sum, entry) => sum + String(entry.content || '').length, 0);

    if (nextCompactedMessageCount <= existing.compactedMessageCount) {
        return false;
    }

    if (completionPoint && transcriptMessages.length >= COMPACTION_COMPLETION_MIN_MESSAGES) {
        return newlyCompactedMessages > 0;
    }

    if (activeWorkflow) {
        return transcriptMessages.length >= COMPACTION_UNRULY_ACTIVE_MESSAGE_COUNT
            && newlyCompactedMessages >= COMPACTION_UNRULY_ACTIVE_MIN_NEW_MESSAGES;
    }

    if (transcriptChars >= COMPACTION_TRIGGER_CHAR_COUNT) {
        return newlyCompactedMessages > 0;
    }

    return transcriptMessages.length >= COMPACTION_TRIGGER_MESSAGE_COUNT
        && newlyCompactedMessages >= COMPACTION_MIN_NEW_MESSAGES;
}

function buildSessionCompaction({
    messages = [],
    existingCompaction = null,
    workflow = null,
    projectMemory = null,
} = {}) {
    const transcriptMessages = normalizeTranscriptMessages(messages);
    const existing = normalizeSessionCompaction(existingCompaction || {});
    const nextCompactedMessageCount = Math.max(0, transcriptMessages.length - COMPACTION_RETAIN_RECENT_MESSAGES);
    if (nextCompactedMessageCount <= existing.compactedMessageCount) {
        return null;
    }

    const newSegment = transcriptMessages.slice(existing.compactedMessageCount, nextCompactedMessageCount);
    if (newSegment.length === 0) {
        return null;
    }

    const nextCompaction = {
        compactedMessageCount: nextCompactedMessageCount,
        objectives: mergeCompactionLists(
            existing.objectives,
            extractObjectiveHighlights(newSegment),
            MAX_OBJECTIVES,
            200,
        ),
        outcomes: mergeCompactionLists(
            existing.outcomes,
            extractOutcomeHighlights(newSegment),
            MAX_OUTCOMES,
            220,
        ),
        openItems: extractOpenItems({ workflow, projectMemory }),
        completionReport: String(workflow?.status || '').trim().toLowerCase() === 'completed'
            ? extractLatestAssistantReport(transcriptMessages)
            : existing.completionReport,
        updatedAt: new Date().toISOString(),
        trigger: inferCompactionTrigger(workflow),
    };

    return {
        ...nextCompaction,
        summary: buildCompactionSummaryText(nextCompaction),
    };
}

function buildSessionCompactionInstructions(session = null) {
    const compaction = normalizeSessionCompaction(session?.metadata?.sessionCompaction || {});
    if (!compaction.summary) {
        return '';
    }

    return [
        '[Session compaction]',
        'Earlier turns in this same session were compacted intentionally to keep the next request smaller.',
        'Use this as carryover context for the compacted portion of the transcript, then prefer newer transcript messages for exact wording.',
        '',
        compaction.summary,
    ].join('\n');
}

module.exports = {
    buildSessionCompaction,
    buildSessionCompactionInstructions,
    normalizeSessionCompaction,
    normalizeTranscriptMessages,
    shouldCompactSession,
};

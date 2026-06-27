const JOURNAL_NAMESPACE = 'agentJournal';
const JOURNAL_PREFERENCE_KEY = 'entries';
const MAX_AGENT_JOURNAL_ENTRIES = 10;
const MAX_ENTRY_TEXT_LENGTH = 180;
const MAX_PROMPT_CHARS = 2200;

const JOURNAL_BLOCK_PATTERN = /<kimi-agent-journal\b[^>]*>[\s\S]*?<\/kimi-agent-journal>/gi;

function normalizeText(value = '', limit = MAX_ENTRY_TEXT_LENGTH) {
    const normalized = String(value || '')
        .replace(JOURNAL_BLOCK_PATTERN, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) {
        return '';
    }

    return normalized.length > limit ? `${normalized.slice(0, limit - 3).trimEnd()}...` : normalized;
}

function stripAgentJournalBlocks(value = '') {
    return String(value || '').replace(JOURNAL_BLOCK_PATTERN, '').trim();
}

function parseEntries(value = null) {
    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value !== 'string' || !value.trim()) {
        return [];
    }

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
        return [];
    }
}

function normalizeEntry(entry = {}) {
    const task = normalizeText(entry.task || entry.userText || entry.prompt);
    const note = normalizeText(entry.note || entry.assistantNote || entry.result);
    if (!task && !note) {
        return null;
    }

    return {
        id: normalizeText(entry.id || `${Date.now()}`, 80),
        updatedAt: normalizeText(entry.updatedAt || new Date().toISOString(), 40),
        sessionId: normalizeText(entry.sessionId, 80),
        responseId: normalizeText(entry.responseId, 80),
        task,
        note,
        tools: Array.isArray(entry.tools)
            ? entry.tools.map((tool) => normalizeText(tool, 40)).filter(Boolean).slice(0, 5)
            : [],
        artifacts: Array.isArray(entry.artifacts)
            ? entry.artifacts.map((artifact) => normalizeText(artifact, 80)).filter(Boolean).slice(0, 3)
            : [],
    };
}

function normalizeEntries(entries = []) {
    return (Array.isArray(entries) ? entries : [])
        .map(normalizeEntry)
        .filter(Boolean)
        .slice(-MAX_AGENT_JOURNAL_ENTRIES);
}

function extractToolNames(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : [])
        .map((event) => (
            event?.toolCall?.function?.name
            || event?.toolCall?.name
            || event?.tool_call?.function?.name
            || event?.tool_call?.name
            || event?.tool_name
            || event?.tool_id
            || event?.tool
            || event?.name
        ))
        .map((name) => normalizeText(name, 40))
        .filter(Boolean)
        .filter((name, index, names) => names.indexOf(name) === index)
        .slice(0, 5);
}

function extractArtifactLabels(artifacts = []) {
    return (Array.isArray(artifacts) ? artifacts : [])
        .map((artifact) => (
            artifact?.filename
            || artifact?.title
            || artifact?.id
            || artifact?.artifactId
            || artifact?.artifact_id
            || artifact?.name
            || artifact?.format
            || artifact?.mimeType
            || artifact?.mime_type
        ))
        .map((label) => normalizeText(label, 80))
        .filter(Boolean)
        .slice(0, 3);
}

function buildJournalEntry({
    sessionId = '',
    responseId = '',
    userText = '',
    assistantText = '',
    toolEvents = [],
    artifacts = [],
} = {}) {
    const tools = extractToolNames(toolEvents);
    const artifactLabels = extractArtifactLabels(artifacts);
    const noteParts = [
        normalizeText(assistantText, 150),
        tools.length > 0 ? `Tools: ${tools.join(', ')}` : '',
        artifactLabels.length > 0 ? `Artifacts: ${artifactLabels.join(', ')}` : '',
    ].filter(Boolean);

    return normalizeEntry({
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        updatedAt: new Date().toISOString(),
        sessionId,
        responseId,
        task: userText,
        note: noteParts.join(' | '),
        tools,
        artifacts: artifactLabels,
    });
}

function mergeJournalEntry(entries = [], entry = null) {
    const normalizedEntry = normalizeEntry(entry);
    if (!normalizedEntry) {
        return normalizeEntries(entries);
    }

    return normalizeEntries([
        ...normalizeEntries(entries),
        normalizedEntry,
    ]);
}

async function loadAgentJournalEntries(sessionStore, session = null, ownerId = null) {
    if (!sessionStore) {
        return [];
    }

    const normalizedOwnerId = String(ownerId || '').trim();
    if (normalizedOwnerId && typeof sessionStore.getUserPreferences === 'function') {
        const preferences = await sessionStore.getUserPreferences(normalizedOwnerId, JOURNAL_NAMESPACE);
        const entries = parseEntries(preferences?.[JOURNAL_PREFERENCE_KEY]);
        if (entries.length > 0) {
            return normalizeEntries(entries);
        }
    }

    return normalizeEntries(session?.metadata?.agentJournal || []);
}

async function saveAgentJournalEntries(sessionStore, sessionId = '', ownerId = null, entries = []) {
    if (!sessionStore) {
        return [];
    }

    const normalizedEntries = normalizeEntries(entries);
    const normalizedOwnerId = String(ownerId || '').trim();
    if (normalizedOwnerId && typeof sessionStore.patchUserPreferences === 'function') {
        await sessionStore.patchUserPreferences(normalizedOwnerId, JOURNAL_NAMESPACE, {
            [JOURNAL_PREFERENCE_KEY]: JSON.stringify(normalizedEntries),
        });
        return normalizedEntries;
    }

    if (sessionId && typeof sessionStore.update === 'function') {
        await sessionStore.update(sessionId, {
            metadata: {
                agentJournal: normalizedEntries,
            },
        });
    }

    return normalizedEntries;
}

async function recordAgentJournalTurn(sessionStore, session, {
    ownerId = null,
    responseId = '',
    userText = '',
    assistantText = '',
    toolEvents = [],
    artifacts = [],
} = {}) {
    const sessionId = session?.id || '';
    if (!sessionStore || !sessionId) {
        return [];
    }

    const entries = await loadAgentJournalEntries(sessionStore, session, ownerId);
    const entry = buildJournalEntry({
        sessionId,
        responseId,
        userText,
        assistantText,
        toolEvents,
        artifacts,
    });
    const nextEntries = mergeJournalEntry(entries, entry);
    return saveAgentJournalEntries(sessionStore, sessionId, ownerId, nextEntries);
}

function buildAgentJournalInstructions(entries = []) {
    const normalizedEntries = normalizeEntries(entries);
    if (normalizedEntries.length === 0) {
        return [
            '<kimi-agent-journal>',
            '[Working journal]',
            'No prior working journal entries yet.',
            '</kimi-agent-journal>',
        ].join('\n');
    }

    const lines = [
        '<kimi-agent-journal>',
        '[Working journal]',
        'This is a compact rolling journal of the last things the assistant worked on for this user/project. Use it only to orient yourself, notice plan changes, and decide whether to look up deeper session memory. Do not quote, summarize, or expose this block to the user.',
    ];

    normalizedEntries.forEach((entry, index) => {
        const parts = [
            `${index + 1}. ${entry.task || '(no task recorded)'}`,
            entry.note ? `note: ${entry.note}` : '',
            entry.sessionId ? `session: ${entry.sessionId}` : '',
        ].filter(Boolean);
        lines.push(parts.join(' | '));
    });

    lines.push('</kimi-agent-journal>');
    const block = lines.join('\n');
    if (block.length <= MAX_PROMPT_CHARS) {
        return block;
    }

    return `${block.slice(0, MAX_PROMPT_CHARS - 32).trimEnd()}\n...[journal trimmed]\n</kimi-agent-journal>`;
}

module.exports = {
    JOURNAL_BLOCK_PATTERN,
    MAX_AGENT_JOURNAL_ENTRIES,
    buildAgentJournalInstructions,
    buildJournalEntry,
    loadAgentJournalEntries,
    mergeJournalEntry,
    normalizeEntries,
    recordAgentJournalTurn,
    stripAgentJournalBlocks,
};

const { randomUUID } = require('crypto');
const { getSessionControlState } = require('./runtime-control-state');

const DEFAULT_FOREGROUND_PLACEHOLDER = 'Working in background...';
const DEFAULT_CANCELLED_PLACEHOLDER = 'Stopped.';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value = '') {
    return String(value || '').trim();
}

function normalizeIsoTimestamp(value = '', fallback = null) {
    const normalized = normalizeString(value);
    if (!normalized) {
        return fallback;
    }

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function offsetTimestamp(value = '', offsetMs = 0) {
    const base = normalizeIsoTimestamp(value, new Date().toISOString()) || new Date().toISOString();
    const parsed = new Date(base);
    return new Date(parsed.getTime() + Math.max(0, Number(offsetMs) || 0)).toISOString();
}

function normalizeForegroundTurn(value = null) {
    if (!isPlainObject(value)) {
        return null;
    }

    const requestId = normalizeString(value.requestId || value.request_id);
    const userMessageId = normalizeString(value.userMessageId || value.user_message_id);
    const assistantMessageId = normalizeString(value.assistantMessageId || value.assistant_message_id);

    if (!requestId || !userMessageId || !assistantMessageId) {
        return null;
    }

    return {
        requestId,
        userMessageId,
        assistantMessageId,
        clientSurface: normalizeString(value.clientSurface || value.client_surface),
        taskType: normalizeString(value.taskType || value.task_type) || 'chat',
        status: normalizeString(value.status) || 'running',
        placeholderText: normalizeString(value.placeholderText || value.placeholder_text) || DEFAULT_FOREGROUND_PLACEHOLDER,
        startedAt: normalizeIsoTimestamp(value.startedAt || value.started_at, new Date().toISOString()),
        userTimestamp: normalizeIsoTimestamp(value.userTimestamp || value.user_timestamp, new Date().toISOString()),
        assistantTimestamp: normalizeIsoTimestamp(
            value.assistantTimestamp || value.assistant_timestamp,
            offsetTimestamp(value.userTimestamp || value.user_timestamp, 1),
        ),
    };
}

function shouldPersistForegroundTurn(clientSurface = '', metadata = {}) {
    const normalizedSurface = normalizeString(
        clientSurface
        || metadata?.clientSurface
        || metadata?.client_surface,
    ).toLowerCase();

    return normalizedSurface === 'web-chat'
        || metadata?.durableForeground === true
        || metadata?.durable_foreground === true;
}

function buildForegroundTurn(metadata = {}, clientSurface = '', taskType = 'chat') {
    const normalizedMetadata = isPlainObject(metadata) ? metadata : {};
    const requestId = normalizeString(
        normalizedMetadata.foregroundRequestId
        || normalizedMetadata.foreground_request_id,
    ) || randomUUID();
    const userTimestamp = normalizeIsoTimestamp(
        normalizedMetadata.userMessageTimestamp
        || normalizedMetadata.user_message_timestamp
        || normalizedMetadata.clientNow
        || normalizedMetadata.client_now,
        new Date().toISOString(),
    );

    return normalizeForegroundTurn({
        requestId,
        userMessageId: normalizeString(
            normalizedMetadata.userMessageId
            || normalizedMetadata.user_message_id
            || normalizedMetadata.messageId
            || normalizedMetadata.message_id,
        ) || randomUUID(),
        assistantMessageId: normalizeString(
            normalizedMetadata.assistantMessageId
            || normalizedMetadata.assistant_message_id,
        ) || randomUUID(),
        clientSurface,
        taskType,
        status: 'running',
        placeholderText: normalizeString(
            normalizedMetadata.assistantPlaceholder
            || normalizedMetadata.assistant_placeholder,
        ) || DEFAULT_FOREGROUND_PLACEHOLDER,
        startedAt: normalizeIsoTimestamp(
            normalizedMetadata.clientNow
            || normalizedMetadata.client_now,
            new Date().toISOString(),
        ),
        userTimestamp,
        assistantTimestamp: normalizeIsoTimestamp(
            normalizedMetadata.assistantMessageTimestamp
            || normalizedMetadata.assistant_message_timestamp,
            offsetTimestamp(userTimestamp, 1),
        ),
    });
}

async function beginForegroundTurn({
    sessionStore,
    sessionId,
    userText = '',
    metadata = {},
    clientSurface = '',
    taskType = 'chat',
} = {}) {
    if (!sessionStore || !sessionId || !normalizeString(userText) || !shouldPersistForegroundTurn(clientSurface, metadata)) {
        return null;
    }

    const turn = buildForegroundTurn(metadata, clientSurface, taskType);
    const turnMetadata = {
        foregroundRequestId: turn.requestId,
        taskType,
        clientSurface,
    };

    await sessionStore.upsertMessage(sessionId, {
        id: turn.userMessageId,
        role: 'user',
        content: normalizeString(userText),
        timestamp: turn.userTimestamp,
        metadata: turnMetadata,
    });
    await sessionStore.upsertMessage(sessionId, {
        id: turn.assistantMessageId,
        role: 'assistant',
        content: turn.placeholderText,
        timestamp: turn.assistantTimestamp,
        metadata: {
            ...turnMetadata,
            isStreaming: true,
            pendingForeground: true,
            liveState: {
                phase: 'thinking',
                detail: 'Working in background. You can leave and come back.',
                reasoningSummary: '',
            },
        },
    });
    await sessionStore.updateControlState(sessionId, {
        foregroundTurn: turn,
    });

    return turn;
}

function resolveForegroundTurn(session = null, metadata = {}, clientSurface = '') {
    const controlState = getSessionControlState(session);
    const persistedTurn = normalizeForegroundTurn(controlState?.foregroundTurn);
    const requestedTurn = normalizeForegroundTurn(
        metadata?.foregroundTurn
        || metadata?.foreground_turn,
    );

    if (requestedTurn) {
        return requestedTurn;
    }

    if (!persistedTurn) {
        return null;
    }

    const normalizedSurface = normalizeString(clientSurface).toLowerCase();
    if (normalizedSurface && normalizeString(persistedTurn.clientSurface).toLowerCase() !== normalizedSurface) {
        return null;
    }

    return persistedTurn.status === 'running'
        ? persistedTurn
        : null;
}

function buildForegroundTurnMessageOptions(turn = null) {
    const normalized = normalizeForegroundTurn(turn);
    if (!normalized) {
        return {};
    }

    return {
        userMessageId: normalized.userMessageId,
        assistantMessageId: normalized.assistantMessageId,
        userTimestamp: normalized.userTimestamp,
        assistantTimestamp: normalized.assistantTimestamp,
    };
}

async function persistForegroundTurnMessages(sessionStore, sessionId, messages = [], turn = null) {
    if (!sessionStore || !sessionId || !Array.isArray(messages) || messages.length === 0) {
        return null;
    }

    const normalizedTurn = normalizeForegroundTurn(turn);
    if (!normalizedTurn || typeof sessionStore.upsertMessage !== 'function') {
        return sessionStore.appendMessages(sessionId, messages);
    }

    for (const message of messages) {
        const isFinalAssistantMessage = message?.id === normalizedTurn.assistantMessageId
            && message?.role === 'assistant';
        const nextMessage = isFinalAssistantMessage
            ? {
                ...message,
                metadata: {
                    ...(isPlainObject(message.metadata) ? message.metadata : {}),
                    foregroundRequestId: normalizedTurn.requestId,
                    isStreaming: false,
                    pendingForeground: false,
                    liveState: null,
                    progressState: null,
                },
            }
            : message;
        await sessionStore.upsertMessage(sessionId, nextMessage);
    }
    await sessionStore.updateControlState(sessionId, {
        foregroundTurn: null,
    });

    return sessionStore.get(sessionId);
}

async function failForegroundTurn(sessionStore, sessionId, turn = null, message = 'The request failed.') {
    const normalizedTurn = normalizeForegroundTurn(turn);
    if (!sessionStore || !sessionId || !normalizedTurn || typeof sessionStore.upsertMessage !== 'function') {
        return null;
    }

    await sessionStore.upsertMessage(sessionId, {
        id: normalizedTurn.assistantMessageId,
        role: 'assistant',
        content: normalizeString(message) || 'The request failed.',
        timestamp: normalizedTurn.assistantTimestamp,
        metadata: {
            foregroundRequestId: normalizedTurn.requestId,
            isStreaming: false,
            pendingForeground: false,
            error: true,
            liveState: null,
        },
    });
    await sessionStore.updateControlState(sessionId, {
        foregroundTurn: null,
    });

    return sessionStore.get(sessionId);
}

async function cancelForegroundTurn(sessionStore, sessionId, turn = null, options = {}) {
    const normalizedTurn = normalizeForegroundTurn(turn);
    if (!sessionStore || !sessionId || !normalizedTurn || typeof sessionStore.upsertMessage !== 'function') {
        return null;
    }

    const cancelledMessage = normalizeString(options.message || options.content);
    const finalContent = cancelledMessage || DEFAULT_CANCELLED_PLACEHOLDER;
    const excludeFromTranscript = options.excludeFromTranscript === true || !cancelledMessage;
    const cancelledBy = normalizeString(options.cancelledBy || options.cancelled_by || 'user');
    const reason = normalizeString(options.reason || 'user_cancelled') || 'user_cancelled';

    await sessionStore.upsertMessage(sessionId, {
        id: normalizedTurn.assistantMessageId,
        role: 'assistant',
        content: finalContent,
        timestamp: normalizedTurn.assistantTimestamp,
        metadata: {
            foregroundRequestId: normalizedTurn.requestId,
            isStreaming: false,
            pendingForeground: false,
            cancelled: true,
            cancelledBy,
            stopReason: reason,
            excludeFromTranscript,
            liveState: null,
        },
    });
    await sessionStore.updateControlState(sessionId, {
        foregroundTurn: null,
    });

    return sessionStore.get(sessionId);
}

module.exports = {
    beginForegroundTurn,
    buildForegroundTurnMessageOptions,
    cancelForegroundTurn,
    failForegroundTurn,
    persistForegroundTurnMessages,
    resolveForegroundTurn,
    shouldPersistForegroundTurn,
};

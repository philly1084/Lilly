'use strict';

const FUNCTION_CALL_ITEM_TYPES = new Set(['function_call', 'custom_tool_call']);
const ARGUMENT_EVENT_TYPES = new Set([
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
]);

function isResponsesFunctionCallItem(item = {}) {
    return FUNCTION_CALL_ITEM_TYPES.has(String(item?.type || '').trim());
}

function isResponsesToolCallEvent(event = {}) {
    return ARGUMENT_EVENT_TYPES.has(String(event?.type || '').trim())
        || ((event?.type === 'response.output_item.added' || event?.type === 'response.output_item.done')
            && isResponsesFunctionCallItem(event.item));
}

function normalizeArguments(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined || value === null) {
        return '';
    }
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return '';
    }
}

function integerOrNull(value) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

function createResponsesToolCallMapper() {
    return {
        nextIndex: 0,
        byItemId: new Map(),
        byCallId: new Map(),
    };
}

function resolveItemKey(event = {}) {
    return String(
        event.item_id
        || event.item?.id
        || event.call_id
        || event.item?.call_id
        || '',
    ).trim();
}

function resolveCallId(event = {}) {
    return String(event.call_id || event.item?.call_id || '').trim();
}

function resolveName(event = {}) {
    return String(
        event.name
        || event.item?.name
        || event.item?.function?.name
        || '',
    ).trim();
}

function resolveArgumentsFromItem(item = {}) {
    return normalizeArguments(item.arguments ?? item.function?.arguments);
}

function ensureEntry(event, state) {
    const itemKey = resolveItemKey(event);
    const callId = resolveCallId(event);
    let entry = (itemKey && state.byItemId.get(itemKey)) || (callId && state.byCallId.get(callId));

    if (!entry) {
        const outputIndex = integerOrNull(event.output_index ?? event.item?.output_index);
        entry = {
            itemId: itemKey || null,
            callId: callId || null,
            name: resolveName(event),
            index: outputIndex === null ? state.nextIndex : outputIndex,
            argumentsText: '',
            emittedArguments: '',
            started: false,
            completed: false,
        };
        state.nextIndex = Math.max(state.nextIndex, entry.index + 1);
    }

    if (itemKey) {
        entry.itemId = itemKey;
        state.byItemId.set(itemKey, entry);
    }
    if (callId) {
        entry.callId = callId;
        state.byCallId.set(callId, entry);
    }
    const name = resolveName(event);
    if (name) {
        entry.name = name;
    }
    const outputIndex = integerOrNull(event.output_index ?? event.item?.output_index);
    if (outputIndex !== null) {
        entry.index = outputIndex;
        state.nextIndex = Math.max(state.nextIndex, outputIndex + 1);
    }

    return entry;
}

function reconcileArguments(entry, value) {
    const normalized = normalizeArguments(value);
    if (!normalized) {
        return entry.argumentsText;
    }
    if (!entry.argumentsText || normalized.startsWith(entry.argumentsText)) {
        entry.argumentsText = normalized;
    }
    return entry.argumentsText;
}

function appendDelta(entry, delta) {
    const normalized = normalizeArguments(delta);
    if (normalized) {
        entry.argumentsText += normalized;
    }
}

function getUnemittedSuffix(entry) {
    if (!entry.argumentsText) {
        return '';
    }
    if (!entry.emittedArguments) {
        return entry.argumentsText;
    }
    if (entry.argumentsText === entry.emittedArguments) {
        return '';
    }
    if (entry.argumentsText.startsWith(entry.emittedArguments)) {
        return entry.argumentsText.slice(entry.emittedArguments.length);
    }
    // Never resend an already emitted JSON fragment when a provider sends a
    // non-prefix completion envelope.
    return '';
}

function buildToolCall(entry, argumentsValue = '') {
    if (!entry.callId || !entry.name) {
        return null;
    }
    return {
        index: entry.index,
        id: entry.callId,
        type: 'function',
        function: {
            name: entry.name,
            arguments: argumentsValue,
        },
    };
}

function mapResponsesToolCallEvent(event = {}, state = createResponsesToolCallMapper()) {
    if (!isResponsesToolCallEvent(event)) {
        return null;
    }

    const entry = ensureEntry(event, state);
    const type = String(event.type || '').trim();
    if (type === 'response.function_call_arguments.delta') {
        appendDelta(entry, event.delta);
        const argumentsDelta = getUnemittedSuffix(entry);
        const toolCall = buildToolCall(entry, argumentsDelta);
        if (toolCall) {
            entry.emittedArguments += argumentsDelta;
        }
        return toolCall ? { toolCall, stage: 'delta' } : null;
    }

    if (type === 'response.function_call_arguments.done') {
        reconcileArguments(entry, event.arguments ?? event.delta);
        entry.completed = true;
        const argumentsDelta = getUnemittedSuffix(entry);
        const toolCall = buildToolCall(entry, argumentsDelta);
        if (toolCall) {
            entry.emittedArguments += argumentsDelta;
        }
        return toolCall ? { toolCall, stage: 'done' } : null;
    }

    const itemArguments = resolveArgumentsFromItem(event.item);
    if (itemArguments) {
        reconcileArguments(entry, itemArguments);
    }
    const argumentsDelta = getUnemittedSuffix(entry);
    const toolCall = buildToolCall(entry, argumentsDelta);
    if (!toolCall) {
        return null;
    }
    if (type === 'response.output_item.added') {
        if (entry.started) {
            return null;
        }
        entry.started = true;
        entry.emittedArguments += argumentsDelta;
        return { toolCall, stage: 'started' };
    }

    entry.completed = true;
    if (!argumentsDelta && entry.emittedArguments) {
        return null;
    }
    entry.emittedArguments += argumentsDelta;
    return { toolCall, stage: 'done' };
}

module.exports = {
    ARGUMENT_EVENT_TYPES,
    createResponsesToolCallMapper,
    isResponsesFunctionCallItem,
    isResponsesToolCallEvent,
    mapResponsesToolCallEvent,
};

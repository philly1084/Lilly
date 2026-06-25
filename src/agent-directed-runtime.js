const { getAllowedToolIdsForProfile } = require('./tool-execution-profiles');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'agent-directed', 'agent_directed', 'direct-agent']);
const RUNTIME_MODE_VALUES = new Set(['agent-directed', 'agent_directed', 'direct-agent', 'direct_agent']);
const MAX_CARD_DETAIL_CHARS = 260;
const MAX_TOOL_DESCRIPTION_CHARS = 180;
const MAX_REGISTRY_TOOLS = 6;

function normalizeText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactText(value = '', limit = MAX_CARD_DETAIL_CHARS) {
    const normalized = normalizeText(value);
    if (!normalized || normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function readBooleanLike(value) {
    if (value === true) {
        return true;
    }
    if (value === false || value == null) {
        return false;
    }
    return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function readModeLike(value) {
    return RUNTIME_MODE_VALUES.has(String(value || '').trim().toLowerCase());
}

function resolveAgentDirectedRuntimeFlag(payload = {}, settings = {}) {
    if (readBooleanLike(process.env.KIMIBUILT_AGENT_DIRECTED_RUNTIME)) {
        return true;
    }

    if ([
        settings?.agentDirectedRuntime,
        settings?.agent_directed_runtime,
        settings?.useAgentDirectedRuntime,
        settings?.use_agent_directed_runtime,
        settings?.bypassConversationOrchestrator,
        settings?.bypass_conversation_orchestrator,
    ].some(readBooleanLike)) {
        return true;
    }

    return [
        payload?.useAgentDirectedRuntime,
        payload?.use_agent_directed_runtime,
        payload?.agentDirectedRuntime,
        payload?.agent_directed_runtime,
        payload?.bypassConversationOrchestrator,
        payload?.bypass_conversation_orchestrator,
        payload?.metadata?.useAgentDirectedRuntime,
        payload?.metadata?.use_agent_directed_runtime,
        payload?.metadata?.agentDirectedRuntime,
        payload?.metadata?.agent_directed_runtime,
        payload?.metadata?.bypassConversationOrchestrator,
        payload?.metadata?.bypass_conversation_orchestrator,
    ].some(readBooleanLike) || [
        payload?.runtimeMode,
        payload?.runtime_mode,
        payload?.agentRuntimeMode,
        payload?.agent_runtime_mode,
        payload?.metadata?.runtimeMode,
        payload?.metadata?.runtime_mode,
        payload?.metadata?.agentRuntimeMode,
        payload?.metadata?.agent_runtime_mode,
    ].some(readModeLike);
}

function normalizeDecisionCards(metadata = {}) {
    const frameCards = Array.isArray(metadata?.requestFrame?.cards)
        ? metadata.requestFrame.cards
        : [];
    const traceCards = Array.isArray(metadata?.decisionTrace)
        ? metadata.decisionTrace
        : [];
    const cards = frameCards.length > 0 ? frameCards : traceCards;

    return cards
        .map((card) => ({
            title: compactText(card?.title || card?.label || 'Card', 60),
            detail: compactText(card?.detail || card?.text || card?.summary || '', MAX_CARD_DETAIL_CHARS),
        }))
        .filter((card) => card.title || card.detail)
        .slice(0, 5);
}

function normalizeToolIds(values = []) {
    const seen = new Set();
    return (Array.isArray(values) ? values : [values])
        .map((value) => String(
            typeof value === 'string'
                ? value
                : (value?.id || value?.toolId || value?.tool || ''),
        ).trim())
        .filter(Boolean)
        .filter((toolId) => {
            const key = toolId.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

function asToolHintList(value = []) {
    if (Array.isArray(value)) {
        return value;
    }
    return value ? [value] : [];
}

function collectCandidateToolIds({ metadata = {}, executionProfile = 'default' } = {}) {
    const requestFrame = metadata?.requestFrame || {};
    const routingDecision = metadata?.routingDecision || {};
    const orchestrationHints = requestFrame?.orchestrationHints || {};
    const preferredTool = requestFrame?.preferredTool
        || routingDecision?.preferredTool
        || metadata?.preferredTool
        || null;
    const hintedToolIds = normalizeToolIds([
        preferredTool,
        metadata?.directToolId,
        requestFrame?.directToolId,
        routingDecision?.directToolId,
        orchestrationHints?.selectedToolLane,
        orchestrationHints?.preferredTool,
        ...asToolHintList(requestFrame?.plannedTools),
        ...asToolHintList(routingDecision?.plannedTools),
        ...asToolHintList(metadata?.plannedTools),
        ...asToolHintList(requestFrame?.toolIds),
        ...asToolHintList(routingDecision?.toolIds),
        ...asToolHintList(metadata?.toolIds),
        ...asToolHintList(requestFrame?.userSelectedToolIds),
        ...asToolHintList(routingDecision?.userSelectedToolIds),
        ...asToolHintList(metadata?.userSelectedToolIds),
        ...asToolHintList(metadata?.tools),
    ]);
    const allowed = new Set(getAllowedToolIdsForProfile(executionProfile));

    return hintedToolIds
        .filter((toolId) => allowed.has(toolId))
        .slice(0, MAX_REGISTRY_TOOLS);
}

function buildCompactToolRegistryContext({
    toolManager = null,
    metadata = {},
    executionProfile = 'default',
} = {}) {
    const candidateToolIds = collectCandidateToolIds({ metadata, executionProfile })
        .filter((toolId) => !toolManager?.getTool || toolManager.getTool(toolId));

    if (candidateToolIds.length === 0) {
        return [
            'Compact tool registry:',
            '- No fixed tool list is forced at startup. Let the automatic tool loop expose only matched registry tools when the next action truly needs one.',
        ].join('\n');
    }

    const lines = candidateToolIds.map((toolId) => {
        const tool = toolManager?.getTool?.(toolId) || {};
        const skill = toolManager?.registry?.getSkill?.(toolId) || {};
        const description = compactText(
            tool.description || skill.description || tool.name || skill.name || toolId,
            MAX_TOOL_DESCRIPTION_CHARS,
        );
        const readiness = toolManager?.getToolReadinessSummary
            ? toolManager.getToolReadinessSummary([toolId])?.[0]
            : null;
        const readinessText = readiness?.status ? ` readiness=${readiness.status}` : '';
        return `- ${toolId}: ${description}${readinessText}`;
    });

    return [
        'Compact tool registry candidates:',
        ...lines,
        'Use these as hints, not a script. If the user goal clearly needs a different matched registry tool, choose it.',
    ].join('\n');
}

function buildDecisionCardsBlock(metadata = {}) {
    const cards = normalizeDecisionCards(metadata);
    if (cards.length === 0) {
        return '';
    }

    return [
        'Decision cards from request frame:',
        ...cards.map((card) => `- ${card.title}: ${card.detail}`),
    ].join('\n');
}

function buildAgentDirectedRuntimeInstructions({
    instructions = '',
    metadata = {},
    toolManager = null,
    executionProfile = 'default',
    clientSurface = '',
    taskType = '',
} = {}) {
    const cardsBlock = buildDecisionCardsBlock(metadata);
    const registryBlock = buildCompactToolRegistryContext({
        toolManager,
        metadata,
        executionProfile,
    });
    const routing = metadata?.routingDecision || {};
    const proofExpectations = Array.isArray(routing.proofExpectations)
        ? routing.proofExpectations
        : (Array.isArray(metadata?.requestFrame?.proofExpectations) ? metadata.requestFrame.proofExpectations : []);
    const blockedActions = Array.isArray(routing.blockedActions)
        ? routing.blockedActions
        : (Array.isArray(metadata?.requestFrame?.blockedActions) ? metadata.requestFrame.blockedActions : []);

    const overlay = [
        '<agent_directed_runtime version="1">',
        'Experimental path: bypass the fixed conversation orchestrator and let the model decide how to progress.',
        'Treat the cards as compact context, not a mandatory step plan. Start with the user goal and move directly to the smallest useful next action.',
        'Choose tools only when they materially advance the task. Ask a concise question only when missing input changes scope, credentials, destructive action, or product direction.',
        `Surface: ${clientSurface || metadata?.clientSurface || '(unknown)'}. Task type: ${taskType || metadata?.taskType || '(unknown)'}. Execution profile: ${executionProfile}.`,
        cardsBlock,
        registryBlock,
        proofExpectations.length > 0 ? `Proof expectations to satisfy before finalizing: ${proofExpectations.join('; ')}` : '',
        blockedActions.length > 0 ? `Avoid these failure modes: ${blockedActions.join('; ')}` : '',
        '</agent_directed_runtime>',
    ].filter(Boolean).join('\n');

    return [overlay, instructions].filter(Boolean).join('\n\n');
}

module.exports = {
    buildAgentDirectedRuntimeInstructions,
    buildCompactToolRegistryContext,
    collectCandidateToolIds,
    resolveAgentDirectedRuntimeFlag,
    _private: {
        normalizeDecisionCards,
        readBooleanLike,
        readModeLike,
    },
};

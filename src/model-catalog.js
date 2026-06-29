function normalizeModelId(modelId = '') {
    return String(modelId || '').trim();
}

const NON_CHAT_MODEL_TOKENS = [
    'embed',
    'embedding',
    'text-embedding',
    'image-gen',
    'image_generation',
    'image-generation',
    'image-edit',
    'image_edit',
    'image-model',
    'image_model',
    'image-router',
    'image_router',
    'image-generator',
    'image_generator',
    'text-to-image',
    'gpt-image',
    'dall-e',
    'dalle',
    'recraft',
    'ideogram',
    'imagen',
    'flux',
    'sdxl',
    'stable-diffusion',
    'diffusion',
    'tts',
    'speech',
    'audio',
    'transcribe',
    'whisper',
    'realtime',
    'moderation',
    'omni-moderation',
];

const NON_CHAT_CAPABILITIES = new Set([
    'image',
    'image_generation',
    'image-generation',
    'images',
    'embedding',
    'embeddings',
    'text-embedding',
    'tts',
    'speech',
    'audio',
    'transcription',
    'transcribe',
    'moderation',
    'realtime',
]);

function normalizeCapabilities(model = {}) {
    return getCapabilityEntries(model)
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean);
}

function parseCapabilityEntries(value = null) {
    if (Array.isArray(value)) {
        return value.flatMap((entry) => parseCapabilityEntries(entry));
    }

    if (typeof value === 'string') {
        return value.split(/[,\s;|]+/).map((entry) => entry.trim()).filter(Boolean);
    }

    if (value && typeof value === 'object') {
        return Object.entries(value)
            .filter(([, enabled]) => isCapabilityEnabled(enabled))
            .map(([name]) => name);
    }

    return [];
}

function isCapabilityEnabled(value) {
    if (value === true || value === 1) {
        return true;
    }
    if (typeof value === 'string') {
        return /^(true|yes|supported|enabled|available|1)$/i.test(value.trim());
    }
    if (value && typeof value === 'object') {
        return isCapabilityEnabled(value.enabled)
            || isCapabilityEnabled(value.supported)
            || isCapabilityEnabled(value.available);
    }
    return false;
}

function getCapabilityEntries(model = {}) {
    return [
        ...parseCapabilityEntries(model?.capabilities),
        ...parseCapabilityEntries(model?.supports),
        ...parseCapabilityEntries(model?.metadata?.capabilities),
        ...parseCapabilityEntries(model?.metadata?.supports),
        ...parseCapabilityEntries(model?.contract?.capabilities),
        ...parseCapabilityEntries(model?.contract?.supports),
    ];
}

function isPublicChatModel(modelOrId = '') {
    const model = modelOrId && typeof modelOrId === 'object'
        ? modelOrId
        : { id: modelOrId };
    const normalizedId = normalizeModelId(model.id).toLowerCase();
    if (!normalizedId) {
        return false;
    }

    const capabilities = normalizeCapabilities(model);
    if (capabilities.includes('chat')) {
        return true;
    }
    if (capabilities.some((entry) => NON_CHAT_CAPABILITIES.has(entry))) {
        return false;
    }

    return !NON_CHAT_MODEL_TOKENS.some((token) => normalizedId.includes(token));
}

function inferModelCapabilities(model = {}) {
    const providedCapabilities = getCapabilityEntries(model);
    if (providedCapabilities.length > 0) {
        const capabilities = [...new Set(providedCapabilities.map((entry) => String(entry || '').trim()).filter(Boolean))];
        const normalizedCapabilities = new Set(capabilities.map((entry) => entry.toLowerCase()));
        const hasNonChatCapability = [...normalizedCapabilities].some((entry) => NON_CHAT_CAPABILITIES.has(entry));
        const shouldAddChat = !normalizedCapabilities.has('chat')
            && !hasNonChatCapability
            && isPublicChatModel(model);

        if (shouldAddChat) {
            capabilities.unshift('chat');
            normalizedCapabilities.add('chat');
        }
        if (normalizedCapabilities.has('chat')) {
            if (!normalizedCapabilities.has('streaming')) {
                capabilities.push('streaming');
                normalizedCapabilities.add('streaming');
            }
        }

        return capabilities;
    }

    const normalizedId = normalizeModelId(model.id).toLowerCase();
    const capabilities = [];

    if (!isPublicChatModel(normalizedId)) {
        if (/\b(gpt-image|dall-e|dalle|imagen|flux|sdxl|stable-diffusion|diffusion|recraft|ideogram)\b/i.test(normalizedId)
            || normalizedId.includes('image')) {
            capabilities.push('image_generation');
        }
        if (normalizedId.includes('embed')) {
            capabilities.push('embeddings');
        }
        if (normalizedId.includes('tts') || normalizedId.includes('speech')) {
            capabilities.push('speech');
        }
        if (normalizedId.includes('whisper') || normalizedId.includes('transcribe')) {
            capabilities.push('transcription');
        }
    } else {
        capabilities.push('chat', 'responses', 'streaming');
        if (/(tool|function|4o|o\d|gpt-5|claude|gemini|grok|mistral|qwen|llama)/i.test(normalizedId)) {
            capabilities.push('tools');
        }
        if (/(^|[-_/])(o\d|reason|gpt-5|grok-4)/i.test(normalizedId)) {
            capabilities.push('reasoning');
        }
        if (/(json|structured|4o|o\d|gpt-5|claude|gemini|grok)/i.test(normalizedId)) {
            capabilities.push('structured_outputs');
        }
        if (/(vision|image[_-]?input|4o|omni|gpt-5|gemini|claude-3|claude-4|llava)/i.test(normalizedId)) {
            capabilities.push('vision', 'image_input');
        }
    }

    return capabilities;
}

function inferProviderFamily(model = {}) {
    const id = normalizeModelId(typeof model === 'string' ? model : model.id).toLowerCase();
    const owner = String(model?.owned_by || model?.provider || '').toLowerCase();
    const text = `${id} ${owner}`;
    if (text.includes('openai') || /^gpt-|^o\d|^chatgpt/.test(id)) return 'openai';
    if (text.includes('xai') || text.includes('grok')) return 'xai';
    if (text.includes('groq')) return 'groq';
    if (text.includes('gemma')) return 'google';
    if (text.includes('gemini') || text.includes('google')) return 'gemini';
    if (text.includes('anthropic') || text.includes('claude')) return 'anthropic';
    if (text.includes('mistral') || text.includes('mixtral')) return 'mistral';
    if (text.includes('qwen') || text.includes('alibaba')) return 'qwen';
    if (text.includes('deepseek')) return 'deepseek';
    if (text.includes('kimi') || text.includes('moonshot')) return 'kimi';
    if (text.includes('llama') || text.includes('meta')) return 'meta';
    if (text.includes('cohere') || /^command(?:[-_/]|$)/.test(id)) return 'cohere';
    return owner || 'unknown';
}

function inferContextWindow(model = {}) {
    const id = normalizeModelId(typeof model === 'string' ? model : model.id).toLowerCase();
    if (/grok-4(?:\.3|\.20)?/.test(id)) return 1000000;
    if (/grok-build/.test(id)) return 256000;
    if (/gpt-5|gpt-4\.1|claude|gemini-1\.5|gemini-2|qwen|deepseek|kimi/.test(id)) return 128000;
    if (/grok/.test(id)) return 128000;
    if (/gpt-4o|o3|o4|llama-3\.1|llama-3\.3/.test(id)) return 128000;
    if (/gpt-4|mixtral|mistral-large/.test(id)) return 32000;
    return 16000;
}

function buildModelContract(model = {}, options = {}) {
    const id = normalizeModelId(typeof model === 'string' ? model : model.id);
    const capabilities = inferModelCapabilities(typeof model === 'string' ? { id } : model);
    const capabilitySet = new Set(capabilities);
    const provider = options.provider || inferProviderFamily(model);
    const officialOpenAI = provider === 'openai' || options.officialOpenAI === true;

    return {
        id,
        provider,
        capabilities,
        supports: {
            chat: capabilitySet.has('chat'),
            responses: officialOpenAI && capabilitySet.has('responses'),
            tools: capabilitySet.has('tools'),
            vision: capabilitySet.has('vision') || capabilitySet.has('image_input'),
            reasoning: capabilitySet.has('reasoning'),
            structured_outputs: capabilitySet.has('structured_outputs'),
            image_generation: capabilitySet.has('image_generation'),
            streaming: capabilitySet.has('streaming'),
        },
        contextWindow: Number(model?.context_window || model?.contextWindow || 0) || inferContextWindow(model),
        costTier: model?.costTier || (/mini|small|flash|haiku|8b|7b/i.test(id) ? 'low' : (/gpt-5|opus|large|pro/i.test(id) ? 'high' : 'medium')),
        latencyTier: model?.latencyTier || (/mini|flash|groq|8b|7b/i.test(id) ? 'low' : 'medium'),
        reliabilityTier: model?.reliabilityTier || (officialOpenAI ? 'high' : 'unknown'),
        openaiFirst: officialOpenAI,
    };
}

function requiredCapabilitiesForRequest({
    needsTools = false,
    needsVision = false,
    needsReasoning = false,
    needsStructuredOutputs = false,
    needsImageGeneration = false,
    apiMode = 'chat',
} = {}) {
    const required = [];
    if (needsImageGeneration) {
        required.push('image_generation');
        return required;
    }
    required.push(apiMode === 'responses' ? 'responses' : 'chat');
    if (needsTools) required.push('tools');
    if (needsVision) required.push('vision');
    if (needsReasoning) required.push('reasoning');
    if (needsStructuredOutputs) required.push('structured_outputs');
    return required;
}

function modelSatisfiesCapabilities(contract = {}, required = []) {
    const supports = contract.supports || {};
    return required.every((capability) => supports[capability] === true || (contract.capabilities || []).includes(capability));
}

function selectAutoModel(models = [], request = {}, options = {}) {
    const required = requiredCapabilitiesForRequest(request);
    const candidates = (Array.isArray(models) ? models : [])
        .map((model) => buildModelContract(model, options))
        .filter((contract) => contract.id && modelSatisfiesCapabilities(contract, required));

    if (candidates.length === 0) {
        return null;
    }

    const score = (contract) => {
        let value = 0;
        if (contract.openaiFirst) value += 3;
        if (contract.supports.reasoning && request.needsReasoning) value += 2;
        if (contract.supports.tools && request.needsTools) value += 2;
        if (contract.reliabilityTier === 'high') value += 2;
        if (contract.costTier === 'low') value += 1;
        if (contract.latencyTier === 'low') value += 1;
        value += Math.min(contract.contextWindow || 0, 128000) / 128000;
        return value;
    };

    return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

function toPublicModelRecord(model = {}) {
    const contract = buildModelContract(model);
    return {
        id: model.id,
        object: model.object || 'model',
        created: model.created || Math.floor(Date.now() / 1000),
        owned_by: model.owned_by || 'unknown',
        capabilities: contract.capabilities,
        contract,
    };
}

function uniquePublicModelList(models = []) {
    const seen = new Set();

    return models
        .filter((model) => {
            const normalizedId = normalizeModelId(model?.id);
            if (!normalizedId || seen.has(normalizedId)) {
                return false;
            }

            seen.add(normalizedId);
            return true;
        })
        .map((model) => toPublicModelRecord(model));
}

function toPublicModelList(models = []) {
    return uniquePublicModelList(models);
}

function toPublicChatModelList(models = []) {
    return uniquePublicModelList(models.filter((model) => isPublicChatModel(model)));
}

module.exports = {
    NON_CHAT_MODEL_TOKENS,
    buildModelContract,
    inferModelCapabilities,
    modelSatisfiesCapabilities,
    requiredCapabilitiesForRequest,
    selectAutoModel,
    isPublicChatModel,
    toPublicChatModelList,
    toPublicModelList,
    toPublicModelRecord,
};

function normalizeModelId(modelId = '') {
    return String(modelId || '').trim();
}

const NON_CHAT_MODEL_TOKENS = [
    'embed',
    'embedding',
    'text-embedding',
    'image',
    'image-gen',
    'image_generation',
    'image-generation',
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
    'vision-preview',
];

function isPublicChatModel(modelId = '') {
    const normalizedId = normalizeModelId(modelId).toLowerCase();
    if (!normalizedId) {
        return false;
    }

    return !NON_CHAT_MODEL_TOKENS.some((token) => normalizedId.includes(token));
}

function inferModelCapabilities(model = {}) {
    if (Array.isArray(model.capabilities)) {
        return [...new Set(model.capabilities.map((entry) => String(entry || '').trim()).filter(Boolean))];
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
        if (/(tool|function|4o|o\d|gpt-5|claude|gemini|mistral|qwen|llama)/i.test(normalizedId)) {
            capabilities.push('tools');
        }
        if (/(^|[-_/])(o\d|reason|gpt-5)/i.test(normalizedId)) {
            capabilities.push('reasoning');
        }
        if (/(json|structured|4o|o\d|gpt-5|claude|gemini)/i.test(normalizedId)) {
            capabilities.push('structured_outputs');
        }
        if (/(vision|image[_-]?input|4o|omni|gpt-5|gemini|claude-3|claude-4|llava)/i.test(normalizedId)) {
            capabilities.push('vision', 'image_input');
        }
    }

    return capabilities;
}

function toPublicModelRecord(model = {}) {
    return {
        id: model.id,
        object: model.object || 'model',
        created: model.created || Math.floor(Date.now() / 1000),
        owned_by: model.owned_by || 'unknown',
        capabilities: inferModelCapabilities(model),
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
    return uniquePublicModelList(models.filter((model) => isPublicChatModel(model?.id)));
}

module.exports = {
    NON_CHAT_MODEL_TOKENS,
    inferModelCapabilities,
    isPublicChatModel,
    toPublicChatModelList,
    toPublicModelList,
    toPublicModelRecord,
};

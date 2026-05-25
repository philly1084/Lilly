const crypto = require('crypto');
const OpenAI = require('openai');
const { toFile } = OpenAI;
const { config } = require('./config');
const { runtimeDiagnostics } = require('./runtime-diagnostics');
const { AGENT_NOTES_CHAR_LIMIT } = require('./agent-notes');
const { SELF_REFLECTION_UPDATE_TOOL_ID } = require('./self-reflection-updater');
const { hasSelfReflectionUpdateIntentText } = require('./self-reflection-intent');
const { stripAgentJournalBlocks } = require('./agent-journal');
const settingsController = require('./routes/admin/settings.controller');
const {
    hasExplicitImageGenerationIntent,
    normalizeReasoningEffort,
} = require('./ai-route-utils');
const {
    buildRemoteContinuityInstructions,
} = require('./runtime-prompts');
const { buildRecentTranscriptAnchor } = require('./conversation-continuity');
const { isDashboardRequest } = require('./dashboard-template-catalog');
const { isSessionIsolationEnabled } = require('./session-scope');
const {
    hasWorkloadIntent,
    summarizeTrigger,
} = require('./workloads/natural-language');
const { buildCanonicalWorkloadAction } = require('./workloads/request-builder');
const {
    DEFAULT_EXECUTION_PROFILE,
    NOTES_EXECUTION_PROFILE,
    REMOTE_BUILD_EXECUTION_PROFILE,
    PROMOTED_LOCAL_TOOL_IDS,
    getAllowedToolIdsForProfile,
} = require('./tool-execution-profiles');
const {
    USER_CHECKPOINT_TOOL_ID,
    buildUserCheckpointMessage,
    normalizeCheckpointRequest,
    parseUserCheckpointResponseMessage,
} = require('./user-checkpoints');
const { parseLenientJson } = require('./utils/lenient-json');
const {
    createZeroUsageMetadata,
    extractResponseUsageMetadata,
    mergeUsageMetadata,
} = require('./utils/token-usage');
const { buildModelContract } = require('./model-catalog');
const {
    buildImageGenerationDiagnostics,
    formatImageDiagnosticsSummary,
} = require('./image-generation-diagnostics');
const {
    hasExplicitPodcastIntent,
    extractExplicitPodcastTopic,
    hasExplicitPodcastVideoIntent,
    inferPodcastVideoOptions,
} = require('./podcast/podcast-intent');
const { extractArtifactsFromToolEvents } = require('./runtime-artifacts');
const { RELATIONSHIP_CALCULATION_TOOL_ID } = require('./pii');
const DOCUMENT_WORKFLOW_TOOL_ID = 'document-workflow';
const DEEP_RESEARCH_PRESENTATION_TOOL_ID = 'deep-research-presentation';
const MODEL_TOOL_RESULT_CHAR_LIMIT = Math.max(
    12000,
    Number(config.memory?.toolResultCharLimit) || 120000,
);
const DIRECT_REMOTE_STDOUT_CHARS = Math.max(
    12000,
    Math.min(MODEL_TOOL_RESULT_CHAR_LIMIT, parseInt(process.env.DIRECT_REMOTE_STDOUT_CHARS, 10) || 24000),
);
const DIRECT_REMOTE_STDERR_CHARS = Math.max(
    6000,
    Math.min(MODEL_TOOL_RESULT_CHAR_LIMIT, parseInt(process.env.DIRECT_REMOTE_STDERR_CHARS, 10) || 12000),
);

let chatClient = null;

const IMAGE_MODEL_KEYWORDS = [
    'gemini',
    'image-generation',
    'gpt-image',
    'dall-e',
    'flux',
    'sdxl',
    'stable-diffusion',
    'diffusion',
    'recraft',
    'ideogram',
    'midjourney',
    'imagen',
    'image-gen',
    'text-to-image',
];

const OFFICIAL_OPENAI_IMAGE_MODELS = [
    'gpt-image-2',
    'gpt-image-1.5',
    'gpt-image-1',
    'gpt-image-1-mini',
];

const GPT_IMAGE_STANDARD_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];
const GPT_IMAGE_2_POPULAR_SIZES = [
    ...GPT_IMAGE_STANDARD_SIZES,
    '2048x2048',
    '2048x1152',
    '3840x2160',
    '2160x3840',
];
const GPT_IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'];

function getClient() {
    if (!chatClient) {
        chatClient = new OpenAI({
            apiKey: config.openai.apiKey,
            baseURL: config.openai.baseURL,
        });
    }
    return chatClient;
}

function normalizeModelId(modelId = '') {
    return String(modelId || '').trim();
}

function isGptImageModelId(modelId = '') {
    return /^gpt-image(?:$|-)/i.test(normalizeModelId(modelId));
}

function isGptImage2ModelId(modelId = '') {
    return /^gpt-image-2(?:$|-)/i.test(normalizeModelId(modelId));
}

function isDallE2ModelId(modelId = '') {
    return /^dall-e-2$/i.test(normalizeModelId(modelId));
}

function isDallE3ModelId(modelId = '') {
    return /^dall-e-3$/i.test(normalizeModelId(modelId));
}

function isValidGptImage2Size(size = '') {
    const normalized = String(size || '').trim().toLowerCase();
    if (normalized === 'auto') {
        return true;
    }

    const match = normalized.match(/^(\d+)x(\d+)$/);
    if (!match) {
        return false;
    }

    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return false;
    }

    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    const totalPixels = width * height;

    return longEdge <= 3840
        && width % 16 === 0
        && height % 16 === 0
        && longEdge / shortEdge <= 3
        && totalPixels >= 655360
        && totalPixels <= 8294400;
}

function normalizeOpenAIApiMode(mode = '') {
    const normalized = String(mode || '').trim().toLowerCase();

    if ([
        'chat',
        'chat-completions',
        'chat_completions',
        'chatcompletions',
        'completions',
    ].includes(normalized)) {
        return 'chat';
    }

    if (normalized === 'responses') {
        return 'responses';
    }

    return 'auto';
}

function inferProviderFamily({
    baseURL = config.openai.baseURL,
    model = '',
} = {}) {
    const normalizedModel = String(model || '').trim().toLowerCase();

    try {
        const parsed = new URL(String(baseURL || 'https://api.openai.com/v1'));
        const hostname = String(parsed.hostname || '').toLowerCase();

        if (/(^|\.)openai\.com$/.test(hostname)) {
            return 'openai';
        }

        if (hostname.includes('groq')) {
            return 'groq';
        }

        if (hostname.includes('googleapis.com')
            || hostname.includes('generativelanguage')
            || hostname.includes('vertex')) {
            return 'gemini';
        }
    } catch (_error) {
        // Fall through to model-based inference.
    }

    if (normalizedModel.includes('gemini')) {
        return 'gemini';
    }

    if (normalizedModel.includes('groq')) {
        return 'groq';
    }

    return 'generic';
}

function isOpenAIBaseURL(baseURL = '') {
    try {
        const parsed = new URL(String(baseURL || 'https://api.openai.com/v1'));
        return /(^|\.)openai\.com$/i.test(parsed.hostname);
    } catch (_error) {
        return false;
    }
}

function resolveOpenAIApiMode({
    baseURL = config.openai.baseURL,
    requestedMode = config.openai.apiMode,
} = {}) {
    const normalizedMode = normalizeOpenAIApiMode(requestedMode);

    if (normalizedMode !== 'auto') {
        return normalizedMode;
    }

    try {
        const parsed = new URL(String(baseURL || 'https://api.openai.com/v1'));
        return /(^|\.)openai\.com$/i.test(parsed.hostname) ? 'responses' : 'chat';
    } catch (_error) {
        return 'chat';
    }
}

function shouldUseResponsesAPI(options = {}) {
    return resolveOpenAIApiMode(options) === 'responses';
}

function resolveRuntimeModelId(model = null, {
    baseURL = config.openai.baseURL,
    fallback = config.openai.model,
} = {}) {
    const requested = normalizeModelId(model || fallback);
    if (requested.toLowerCase() === 'auto' && isOpenAIBaseURL(baseURL)) {
        const configured = normalizeModelId(fallback);
        return configured && configured.toLowerCase() !== 'auto' && !isGptImageModelId(configured)
            ? configured
            : 'gpt-5.5';
    }
    return requested || fallback;
}

function shouldSendReasoningEffort({
    baseURL = config.openai.baseURL,
    model = '',
    api = 'chat',
} = {}) {
    const provider = inferProviderFamily({ baseURL, model });

    if (api === 'chat' && ['gemini', 'groq'].includes(provider)) {
        return false;
    }

    return true;
}

const AUTO_TOOL_ALLOWLIST = new Set([
    'web-fetch',
    'web-search',
    'web-scrape',
    'podcast',
    'image-generate',
    'image-search-unsplash',
    'image-from-url',
    'asset-search',
    'research-bucket-list',
    'research-bucket-search',
    'research-bucket-read',
    'research-bucket-write',
    'research-bucket-mkdir',
    'public-source-list',
    'public-source-search',
    'public-source-get',
    'public-source-add',
    'public-source-refresh',
    'file-read',
    'file-write',
    'file-search',
    'file-mkdir',
    'agent-notes-write',
    SELF_REFLECTION_UPDATE_TOOL_ID,
    'agent-delegate',
    'agent-workload',
    DOCUMENT_WORKFLOW_TOOL_ID,
    DEEP_RESEARCH_PRESENTATION_TOOL_ID,
    RELATIONSHIP_CALCULATION_TOOL_ID,
    'git-safe',
    USER_CHECKPOINT_TOOL_ID,
    'ssh-execute',
    'remote-command',
    'remote-cli-agent',
    'k3s-deploy',
    'managed-app',
    'code-sandbox',
    'security-scan',
    ...PROMOTED_LOCAL_TOOL_IDS,
    'tool-doc-read',
]);

const AUTO_TOOL_MAX_ROUNDS = 6;
const SYNTHETIC_STREAM_CHUNK_SIZE = 120;
const TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);
const IMAGE_PROVIDER_METADATA = Symbol('kimibuilt.imageProviderMetadata');
const PROVIDER_WARMUP_RETRY_ATTEMPTS = 2;
const PROVIDER_WARMUP_RETRY_DELAY_MS = 1500;

class ToolOrchestrationError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'ToolOrchestrationError';
        this.code = 'tool_orchestration_failed';
        this.status = 502;
        this.statusCode = 502;
        this.model = options.model || null;
        this.cause = options.cause || null;
    }
}

function hasDedicatedMediaConfig() {
    return Boolean(normalizeModelId(config.media.apiKey));
}

function hasGatewayImageConfig() {
    const apiKey = String(config.openai.apiKey || '').trim();
    const baseURL = String(config.openai.baseURL || '').trim();
    const imageModel = normalizeModelId(config.openai.imageModel);
    const isCustomBaseURL = Boolean(baseURL) && baseURL !== 'https://api.openai.com/v1';

    return Boolean(apiKey) && (
        Boolean(imageModel)
        || isCustomBaseURL
        || !hasDedicatedMediaConfig()
    );
}

function isAgentNotesAutoWriteEnabled() {
    return settingsController.settings?.agentNotes?.enabled !== false;
}

function getImageProviderConfig() {
    if (hasGatewayImageConfig()) {
        return {
            apiKey: config.openai.apiKey,
            baseURL: config.openai.baseURL,
            imageModel: config.openai.imageModel || config.media.imageModel,
            source: 'gateway',
        };
    }

    if (hasDedicatedMediaConfig()) {
        return {
            apiKey: config.media.apiKey,
            baseURL: config.media.baseURL,
            imageModel: config.media.imageModel,
            source: 'official-openai',
        };
    }

    return {
        apiKey: config.openai.apiKey,
        baseURL: config.openai.baseURL,
        imageModel: config.openai.imageModel || config.media.imageModel,
        source: 'gateway',
    };
}

function isSameImageProvider(left = {}, right = {}) {
    return String(left.apiKey || '').trim() === String(right.apiKey || '').trim()
        && String(left.baseURL || '').trim().replace(/\/$/, '') === String(right.baseURL || '').trim().replace(/\/$/, '')
        && normalizeModelId(left.imageModel) === normalizeModelId(right.imageModel);
}

function getImageProviderCandidates() {
    const primaryProvider = getImageProviderConfig();
    const candidates = [primaryProvider];

    if (
        hasDedicatedMediaConfig()
        && (config.openai.imageAllowOfficialFallback || primaryProvider.source !== 'gateway')
    ) {
        const mediaProvider = {
            apiKey: config.media.apiKey,
            baseURL: config.media.baseURL,
            imageModel: config.media.imageModel,
            source: 'official-openai',
        };

        if (!candidates.some((candidate) => isSameImageProvider(candidate, mediaProvider))) {
            candidates.push(mediaProvider);
        }
    }

    return candidates.filter((candidate) => String(candidate.apiKey || '').trim());
}

function isLikelyImageModel(model = {}) {
    const id = normalizeModelId(typeof model === 'string' ? model : model.id).toLowerCase();
    const owner = String(model.owned_by || '').toLowerCase();
    if (!id) return false;

    if (IMAGE_MODEL_KEYWORDS.some((keyword) => id.includes(keyword))) {
        return true;
    }

    return owner.includes('image');
}

function uniqueById(models = []) {
    const seen = new Set();
    return models.filter((model) => {
        const id = normalizeModelId(model.id);
        if (!id || seen.has(id)) {
            return false;
        }
        seen.add(id);
        return true;
    });
}

function sanitizeUploadFilename(filename = '', fallbackExtension = 'webm') {
    const normalized = String(filename || '').trim();
    const cleaned = normalized.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
    if (cleaned) {
        return cleaned;
    }

    return `recording.${fallbackExtension}`;
}

function sortImageModels(models = []) {
    const configured = normalizeModelId(getImageProviderConfig().imageModel);

    return [...models].sort((a, b) => {
        const aId = normalizeModelId(a.id);
        const bId = normalizeModelId(b.id);
        const aConfigured = configured && aId === configured ? 1 : 0;
        const bConfigured = configured && bId === configured ? 1 : 0;
        if (aConfigured !== bConfigured) {
            return bConfigured - aConfigured;
        }

        const aPriority = getImageModelSortPriority(aId);
        const bPriority = getImageModelSortPriority(bId);
        if (aPriority !== bPriority) {
            return bPriority - aPriority;
        }

        const aNb = /-nb$/i.test(aId) ? 1 : 0;
        const bNb = /-nb$/i.test(bId) ? 1 : 0;
        if (aNb !== bNb) {
            return bNb - aNb;
        }

        return aId.localeCompare(bId);
    });
}

function getImageModelSortPriority(modelId = '') {
    const lower = normalizeModelId(modelId).toLowerCase();

    const explicitPriorityIndex = OFFICIAL_OPENAI_IMAGE_MODELS.indexOf(lower);
    if (explicitPriorityIndex >= 0) {
        return 1000 - explicitPriorityIndex;
    }

    if (lower === 'chatgpt-image-latest') {
        return 995;
    }

    const gptImageMatch = lower.match(/^gpt-image-(\d+(?:\.\d+)?)(?:-(mini))?/i);
    if (gptImageMatch) {
        const version = Number.parseFloat(gptImageMatch[1] || '0') || 0;
        const miniPenalty = gptImageMatch[2] ? 0.1 : 0;
        return 900 + Math.round((version - miniPenalty) * 100);
    }

    if (lower.includes('dall-e-3')) {
        return 200;
    }

    if (lower.includes('dall-e-2')) {
        return 190;
    }

    if (lower.includes('gemini')) {
        return 180;
    }

    return 0;
}

function getImageModelMetadata(modelId, ownedBy = 'openai') {
    const normalized = normalizeModelId(modelId);
    const lower = normalized.toLowerCase();

    if (lower.includes('gemini')) {
        return {
            id: normalized,
            name: normalized,
            description: 'Gemini image generation via OpenAI-compatible gateway',
            owned_by: ownedBy,
            sizes: ['1024x1024'],
            qualities: [],
            styles: [],
            maxImages: 1,
        };
    }

    if (lower.includes('dall-e-3')) {
        return {
            id: normalized,
            name: normalized,
            description: 'High quality image generation',
            owned_by: ownedBy,
            sizes: ['1024x1024', '1024x1792', '1792x1024'],
            qualities: ['standard', 'hd'],
            styles: ['vivid', 'natural'],
            maxImages: 1,
        };
    }

    if (lower.includes('dall-e-2')) {
        return {
            id: normalized,
            name: normalized,
            description: 'Fast image generation',
            owned_by: ownedBy,
            sizes: ['256x256', '512x512', '1024x1024'],
            qualities: ['standard'],
            styles: [],
            maxImages: 5,
        };
    }

    if (isGptImageModelId(normalized)) {
        const isImage2 = isGptImage2ModelId(normalized);
        return {
            id: normalized,
            name: normalized,
            description: 'Official OpenAI GPT Image generation',
            owned_by: ownedBy,
            sizes: isImage2 ? GPT_IMAGE_2_POPULAR_SIZES : GPT_IMAGE_STANDARD_SIZES,
            qualities: ['auto', 'low', 'medium', 'high'],
            backgrounds: isImage2 ? ['auto', 'opaque'] : ['auto', 'transparent', 'opaque'],
            outputFormats: GPT_IMAGE_OUTPUT_FORMATS,
            moderations: ['auto', 'low'],
            styles: [],
            maxImages: 10,
        };
    }

    return {
        id: normalized,
        name: normalized,
        description: 'Image generation model',
        owned_by: ownedBy,
        sizes: ['1024x1024'],
        qualities: [],
        backgrounds: [],
        styles: [],
        maxImages: 5,
    };
}

function toImageUrl(image = {}) {
    if (image.url) {
        return image.url;
    }
    if (typeof image.image_url === 'string') {
        return image.image_url;
    }
    if (typeof image.imageUrl === 'string') {
        return image.imageUrl;
    }
    if (typeof image.image_url?.url === 'string') {
        return image.image_url.url;
    }
    if (typeof image.file_uri === 'string') {
        return image.file_uri;
    }
    if (typeof image.fileUri === 'string') {
        return image.fileUri;
    }
    const mimeType = String(
        image.mimeType
        || image.mime_type
        || image.inline_data?.mime_type
        || image.inlineData?.mimeType
        || 'image/png',
    ).trim() || 'image/png';
    if (image.b64_json) {
        return `data:${mimeType};base64,${image.b64_json}`;
    }
    if (image.b64) {
        return `data:${mimeType};base64,${image.b64}`;
    }
    if (image.base64) {
        return `data:${mimeType};base64,${image.base64}`;
    }
    if (image.image_base64) {
        return `data:${mimeType};base64,${image.image_base64}`;
    }
    return null;
}

function isImageGenerationResponseRecord(value = {}) {
    const type = String(value?.type || value?.object || value?.kind || '').trim().toLowerCase();
    if (!type) {
        return false;
    }

    return type === 'image_generation_call'
        || type === 'image_generation'
        || type === 'image_generation.partial_image'
        || type === 'output_image'
        || type === 'generated_image'
        || type.includes('image_generation')
        || type.includes('generated_image');
}

function isDirectImageReference(value = '') {
    return /^(?:https?:\/\/|data:image\/|file:|sandbox:)/i.test(String(value || '').trim());
}

function normalizeImageGenerationResultPayload(value = {}) {
    if (!isImageGenerationResponseRecord(value)) {
        return {};
    }

    const result = value.result;
    if (typeof result === 'string' && result.trim()) {
        const trimmed = result.trim();
        return isDirectImageReference(trimmed)
            ? { url: trimmed }
            : { b64_json: trimmed };
    }

    if (result && typeof result === 'object') {
        return result;
    }

    return {};
}

function hasImageGenerationResultPayload(value = {}) {
    const payload = normalizeImageGenerationResultPayload(value);
    return Boolean(
        payload.url
        || payload.image_url
        || payload.imageUrl
        || payload.file_uri
        || payload.fileUri
        || payload.b64_json
        || payload.b64
        || payload.base64
        || payload.image_base64
        || payload.imageBase64
        || payload.data
        || payload.inline_data?.data
        || payload.inlineData?.data,
    );
}

function normalizeProviderImageRecord(image = {}) {
    const imageGenerationResult = normalizeImageGenerationResultPayload(image);
    const inlineData = image.inline_data
        || image.inlineData
        || imageGenerationResult.inline_data
        || imageGenerationResult.inlineData
        || null;
    const imageUrl = image.image_url && typeof image.image_url === 'object'
        ? image.image_url.url
        : (image.image_url || imageGenerationResult.image_url || imageGenerationResult.imageUrl);
    const b64Json = image.b64_json
        || image.b64
        || image.base64
        || image.image_base64
        || image.imageBase64
        || imageGenerationResult.b64_json
        || imageGenerationResult.b64
        || imageGenerationResult.base64
        || imageGenerationResult.image_base64
        || imageGenerationResult.imageBase64
        || imageGenerationResult.data
        || inlineData?.data
        || null;
    const url = toImageUrl({
        ...imageGenerationResult,
        ...image,
        image_url: imageUrl,
        b64_json: b64Json,
    });

    return {
        url,
        b64_json: b64Json || undefined,
        revised_prompt: image.revised_prompt
            || image.revisedPrompt
            || imageGenerationResult.revised_prompt
            || imageGenerationResult.revisedPrompt
            || image.prompt
            || undefined,
        output_format: image.output_format
            || image.outputFormat
            || imageGenerationResult.output_format
            || imageGenerationResult.outputFormat
            || undefined,
        quality: image.quality || imageGenerationResult.quality || undefined,
        size: image.size || imageGenerationResult.size || undefined,
        usage: image.usage || imageGenerationResult.usage || undefined,
        mimeType: image.mimeType
            || image.mime_type
            || imageGenerationResult.mimeType
            || imageGenerationResult.mime_type
            || inlineData?.mime_type
            || inlineData?.mimeType
            || undefined,
    };
}

function extractImagePromptText(value, depth = 0) {
    if (depth > 8 || value == null) {
        return '';
    }

    if (typeof value === 'string') {
        return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value).trim();
    }

    if (Array.isArray(value)) {
        return value.map((entry) => extractImagePromptText(entry, depth + 1)).filter(Boolean).join(' ').trim();
    }

    if (typeof value !== 'object') {
        return '';
    }

    const promptKeys = ['text', 'input_text', 'output_text', 'content', 'value'];
    return promptKeys
        .map((key) => extractImagePromptText(value[key], depth + 1))
        .filter(Boolean)
        .join(' ')
        .trim();
}

function extractProviderImageRecords(value, depth = 0) {
    if (depth > 5 || value == null) {
        return [];
    }

    if (Array.isArray(value)) {
        return value.flatMap((entry) => extractProviderImageRecords(entry, depth + 1));
    }

    if (typeof value !== 'object') {
        return [];
    }

    const hasDirectImage = Boolean(
        value.url
        || value.image_url
        || value.imageUrl
        || value.file_uri
        || value.fileUri
        || value.b64_json
        || value.b64
        || value.base64
        || value.image_base64
        || value.imageBase64
        || value.inline_data?.data
        || value.inlineData?.data
        || hasImageGenerationResultPayload(value),
    );
    if (hasDirectImage) {
        return [normalizeProviderImageRecord(value)];
    }

    const nestedKeys = [
        'data',
        'images',
        'generated_images',
        'generatedImages',
        'output',
        'result',
        'raw',
        'payload',
        'body',
        'response',
        'content',
        'parts',
        'candidates',
    ];
    return nestedKeys.flatMap((key) => extractProviderImageRecords(value[key], depth + 1));
}

function parseErrorMessage(errorBody, status) {
    try {
        const parsed = JSON.parse(errorBody);
        return parsed.error?.message || parsed.message || errorBody || `Image generation failed with HTTP ${status}`;
    } catch (_error) {
        return errorBody || `Image generation failed with HTTP ${status}`;
    }
}

function parseErrorPayload(errorBody) {
    try {
        const parsed = JSON.parse(errorBody);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
        return null;
    }
}

function isUnsupportedImageResponseFormatError(errorBody = '', status = 0) {
    if (![400, 422].includes(Number(status))) {
        return false;
    }

    const normalized = String(errorBody || '').toLowerCase();
    if (!normalized) {
        return false;
    }

    return (
        /response[_ -]?format/.test(normalized)
        || /\bb64_json\b/.test(normalized)
    ) && (
        /\b(unsupported|not supported|unknown|invalid|unexpected|additional properties are not allowed|not allowed|not permitted|unrecognized)\b/.test(normalized)
    );
}

function normalizeOfficialOpenAIImageParams(params = {}) {
    const modelId = normalizeModelId(params.model);

    if (isGptImageModelId(modelId)) {
        delete params.response_format;
        delete params.style;

        if (isGptImage2ModelId(modelId)
            && String(params.background || '').trim().toLowerCase() === 'transparent') {
            console.warn('[OpenAI] gpt-image-2 does not support transparent backgrounds; using background=auto.');
            params.background = 'auto';
        }

        const outputFormat = String(params.output_format || '').trim().toLowerCase();
        if (outputFormat && !GPT_IMAGE_OUTPUT_FORMATS.includes(outputFormat)) {
            delete params.output_format;
        } else if (outputFormat && params.output_format !== outputFormat) {
            params.output_format = outputFormat;
        }

        if (params.output_compression != null
            && !['jpeg', 'webp'].includes(String(params.output_format || '').trim().toLowerCase())) {
            delete params.output_compression;
        }

        const moderation = String(params.moderation || '').trim().toLowerCase();
        if (moderation && !['auto', 'low'].includes(moderation)) {
            delete params.moderation;
        } else if (moderation && params.moderation !== moderation) {
            params.moderation = moderation;
        }

        return params;
    }

    if (isDallE2ModelId(modelId) || isDallE3ModelId(modelId)) {
        delete params.background;
        delete params.output_format;
        delete params.output_compression;
        delete params.moderation;

        if (!isDallE3ModelId(modelId)) {
            delete params.style;
        }
    }

    return params;
}

function buildImageGenerationParamsForProvider(params = {}, imageProvider = getImageProviderConfig()) {
    const nextParams = { ...params };
    const providerFamily = inferProviderFamily({
        baseURL: imageProvider.baseURL,
        model: imageProvider.imageModel || params.model,
    });
    const gatewayUsesOfficialOpenAICatalog = shouldUseOfficialOpenAIImageCatalogForGateway(imageProvider);
    const isOpenAIStyleProvider = providerFamily === 'openai' || gatewayUsesOfficialOpenAICatalog;
    const explicitResponseFormat = Object.prototype.hasOwnProperty.call(nextParams, 'response_format')
        ? nextParams.response_format
        : undefined;

    if (isOpenAIStyleProvider) {
        const officialModel = getOfficialOpenAIConfiguredImageModel(
            nextParams.model,
            imageProvider.imageModel || config.media.imageModel,
        );

        if (!officialModel) {
            const error = new Error(`Image model "${nextParams.model || ''}" is not supported by the official OpenAI image API.`);
            error.status = 400;
            error.provider = imageProvider.source;
            throw error;
        }

        nextParams.model = officialModel;
        normalizeOfficialOpenAIImageParams(nextParams);
        const isExternalGateway = gatewayUsesOfficialOpenAICatalog
            && imageProvider.source === 'gateway'
            && !isOpenAIBaseURL(imageProvider.baseURL);
        if (isExternalGateway
            && explicitResponseFormat != null
            && !Object.prototype.hasOwnProperty.call(nextParams, 'response_format')) {
            nextParams.response_format = explicitResponseFormat;
        }
    }

    return nextParams;
}

function buildImageRequestVariants(params = {}, imageProvider = getImageProviderConfig()) {
    const providerFamily = inferProviderFamily({
        baseURL: imageProvider.baseURL,
        model: imageProvider.imageModel || params.model,
    });
    const bareParams = { ...params };
    const responseFormatParams = {
        ...params,
        response_format: 'b64_json',
    };
    const isOpenAIStyleProvider = providerFamily === 'openai'
        || shouldUseOfficialOpenAIImageCatalogForGateway(imageProvider);

    if (Object.prototype.hasOwnProperty.call(params, 'response_format')) {
        return [bareParams];
    }

    if (isOpenAIStyleProvider && isGptImageModelId(params.model || imageProvider.imageModel)) {
        return [bareParams];
    }

    if (providerFamily === 'openai') {
        return [bareParams, responseFormatParams];
    }

    return [responseFormatParams, bareParams];
}

function attachImageProviderMetadata(response, metadata = {}) {
    if (!response || typeof response !== 'object') {
        return response;
    }

    try {
        Object.defineProperty(response, IMAGE_PROVIDER_METADATA, {
            value: metadata,
            enumerable: false,
            configurable: true,
        });
    } catch (_error) {
        // Non-extensible provider objects still flow through without metadata.
    }

    return response;
}

function getImageProviderMetadata(response = null) {
    if (!response || typeof response !== 'object') {
        return {};
    }

    return response[IMAGE_PROVIDER_METADATA] || {};
}

async function postImageGenerationToProvider(params, imageProvider) {
    const configuredBaseURL = String(imageProvider.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const candidateBaseURLs = [configuredBaseURL];
    const providerParams = buildImageGenerationParamsForProvider(params, imageProvider);
    const providerFamily = inferProviderFamily({
        baseURL: imageProvider.baseURL,
        model: imageProvider.imageModel || params.model,
    });

    if (/\/v1$/i.test(configuredBaseURL) && imageProvider.source !== 'official-openai') {
        candidateBaseURLs.push(configuredBaseURL.replace(/\/v1$/i, ''));
    }

    let lastError = null;

    for (const baseURL of candidateBaseURLs) {
        const requestVariants = buildImageRequestVariants(providerParams, imageProvider);

        for (let index = 0; index < requestVariants.length; index += 1) {
            const requestBody = requestVariants[index];
            const headers = {
                Authorization: `Bearer ${imageProvider.apiKey}`,
                'Content-Type': 'application/json',
            };
            if (imageProvider.source === 'gateway') {
                headers['x-api-key'] = imageProvider.apiKey;
            }
            const endpoint = `${baseURL}/images/generations`;
            let response;
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(requestBody),
                });
            } catch (error) {
                error.baseURL = error.baseURL || baseURL;
                error.provider = error.provider || imageProvider.source;
                error.providerFamily = error.providerFamily || providerFamily;
                error.endpoint = error.endpoint || endpoint;
                error.requestVariant = error.requestVariant ?? index;
                error.requestHadResponseFormat = error.requestHadResponseFormat
                    || Object.prototype.hasOwnProperty.call(requestBody, 'response_format');
                error.model = error.model || requestBody.model || params.model || imageProvider.imageModel || '';
                lastError = error;
                throw error;
            }

            if (response.ok) {
                const responseBody = await response.json();
                const requestId = response.headers?.get?.('x-request-id')
                    || response.headers?.get?.('openai-request-id')
                    || response.headers?.get?.('x-openai-request-id')
                    || response.headers?.get?.('cf-ray')
                    || '';
                return attachImageProviderMetadata(responseBody, {
                    providerSource: imageProvider.source,
                    providerFamily,
                    baseURL,
                    endpoint,
                    status: response.status,
                    requestId,
                    requestVariant: index,
                    requestHadResponseFormat: Object.prototype.hasOwnProperty.call(requestBody, 'response_format'),
                    model: requestBody.model || params.model || imageProvider.imageModel || '',
                });
            }

            const errorBody = await response.text();
            const parsedErrorBody = parseErrorPayload(errorBody);
            const error = new Error(parseErrorMessage(errorBody, response.status));
            error.status = response.status;
            error.baseURL = baseURL;
            error.endpoint = endpoint;
            error.provider = imageProvider.source;
            error.providerFamily = providerFamily;
            error.requestVariant = index;
            error.requestHadResponseFormat = Object.prototype.hasOwnProperty.call(requestBody, 'response_format');
            error.model = requestBody.model || params.model || imageProvider.imageModel || '';
            error.requestId = response.headers?.get?.('x-request-id')
                || response.headers?.get?.('openai-request-id')
                || response.headers?.get?.('x-openai-request-id')
                || response.headers?.get?.('cf-ray')
                || '';
            error.providerResponse = parsedErrorBody;
            error.responseBodyPreview = String(errorBody || '').slice(0, 2000);
            if (parsedErrorBody?.diagnostics && typeof parsedErrorBody.diagnostics === 'object') {
                error.diagnostics = parsedErrorBody.diagnostics;
            }
            lastError = error;

            const responseFormatFallbackAllowed = index === 0
                && response.status !== 404
                && isUnsupportedImageResponseFormatError(errorBody, response.status);
            if (responseFormatFallbackAllowed) {
                continue;
            }

            if (response.status !== 404) {
                throw error;
            }

            break;
        }
    }

    throw lastError || new Error('Image generation failed.');
}

async function postImageGeneration(params) {
    const providers = getImageProviderCandidates();
    let lastError = null;

    for (let index = 0; index < providers.length; index += 1) {
        const imageProvider = providers[index];

        try {
            return await postImageGenerationToProvider(params, imageProvider);
        } catch (error) {
            lastError = error;
            if (index >= providers.length - 1) {
                throw error;
            }

            console.warn(`[OpenAI] Image generation failed via ${imageProvider.source}; trying next configured image provider: ${error.message}`);
        }
    }

    throw lastError || new Error('Image generation failed.');
}

async function listModels() {
    const openai = getClient();
    console.log(`[OpenAI] Fetching models from: ${config.openai.baseURL}`);

    try {
        const response = await openai.models.list();
        const models = response.data || [];
        console.log(`[OpenAI] Successfully fetched ${models.length} models`);

        if (models.length > 0) {
            console.log(`[OpenAI] Available models: ${models.map((model) => model.id).join(', ')}`);
        }

        return models;
    } catch (err) {
        console.error('[OpenAI] Failed to list models:', err.message);
        console.error('[OpenAI] Error details:', err.code, err.type);
        return [];
    }
}

function listOfficialImageModels(configuredModel = config.media.imageModel) {
    const configured = getOfficialOpenAIConfiguredImageModel(configuredModel, config.media.imageModel);
    const modelIds = uniqueById(
        [configured, ...OFFICIAL_OPENAI_IMAGE_MODELS]
            .filter(Boolean)
            .map((modelId) => ({ id: modelId })),
    ).map((model) => getImageModelMetadata(model.id, 'openai'));

    return sortImageModels(modelIds);
}

function isOfficialOpenAIImageModelId(modelId = '') {
    const normalized = normalizeModelId(modelId).toLowerCase();
    if (!normalized) {
        return false;
    }

    return isGptImageModelId(normalized) || /^dall-e-\d+$/i.test(normalized);
}

function getOfficialOpenAIConfiguredImageModel(modelId = '', fallbackModel = config.media.imageModel) {
    const normalized = normalizeModelId(modelId);
    if (isOfficialOpenAIImageModelId(normalized)) {
        return normalized;
    }

    const fallback = normalizeModelId(fallbackModel);
    return isOfficialOpenAIImageModelId(fallback) ? fallback : '';
}

function shouldUseOfficialOpenAIImageCatalogForGateway(imageProvider = getImageProviderConfig()) {
    if (!imageProvider || imageProvider.source !== 'gateway') {
        return false;
    }

    return Boolean(getOfficialOpenAIConfiguredImageModel(imageProvider.imageModel, ''));
}

async function listImageModels() {
    const imageProvider = getImageProviderConfig();
    const providerFamily = inferProviderFamily({
        baseURL: imageProvider.baseURL,
        model: imageProvider.imageModel,
    });

    if (providerFamily === 'openai') {
        return listOfficialImageModels(
            imageProvider.imageModel || config.media.imageModel || config.openai.imageModel,
        );
    }

    if (imageProvider.source === 'gateway') {
        const discovered = uniqueById(
            (await listModels())
                .filter((model) => isLikelyImageModel(model))
                .map((model) => getImageModelMetadata(model.id, model.owned_by || 'openai')),
        );
        const configuredModel = normalizeModelId(imageProvider.imageModel);
        const gatewayUsesOfficialOpenAICatalog = shouldUseOfficialOpenAIImageCatalogForGateway(imageProvider);

        if (gatewayUsesOfficialOpenAICatalog) {
            const discoveredOfficialOpenAIModels = uniqueById(
                discovered.filter((model) => isOfficialOpenAIImageModelId(model.id)),
            );

            if (discoveredOfficialOpenAIModels.length > 0) {
                return sortImageModels(uniqueById([
                    ...[configuredModel]
                        .filter(Boolean)
                        .map((modelId) => getImageModelMetadata(modelId, 'openai')),
                    ...discoveredOfficialOpenAIModels,
                ]));
            }

            return listOfficialImageModels(configuredModel || config.media.imageModel);
        }

        if (discovered.length > 0) {
            return sortImageModels(uniqueById([
                ...[configuredModel]
                    .filter(Boolean)
                    .map((modelId) => getImageModelMetadata(modelId, 'openai')),
                ...discovered,
            ]));
        }

        return sortImageModels(uniqueById(
            [imageProvider.imageModel]
                .filter(Boolean)
                .map((modelId) => getImageModelMetadata(modelId, 'openai')),
        ));
    }

    if (hasDedicatedMediaConfig()) {
        return listOfficialImageModels(config.media.imageModel);
    }

    return [];
}

async function resolveImageModel(requestedModel = null) {
    const imageProvider = getImageProviderConfig();
    const availableModels = await listImageModels();
    const requested = normalizeModelId(requestedModel);
    const providerFamily = inferProviderFamily({
        baseURL: imageProvider.baseURL,
        model: imageProvider.imageModel || requested,
    });
    const restrictToOfficialOpenAIModels = providerFamily === 'openai'
        || shouldUseOfficialOpenAIImageCatalogForGateway(imageProvider);
    const configured = restrictToOfficialOpenAIModels
        ? getOfficialOpenAIConfiguredImageModel(imageProvider.imageModel, config.media.imageModel)
        : normalizeModelId(imageProvider.imageModel);

    if (requested) {
        const exactMatch = availableModels.find((model) => model.id === requested);
        if (exactMatch) {
            return { modelId: exactMatch.id, availableModels };
        }

        if (restrictToOfficialOpenAIModels && !isOfficialOpenAIImageModelId(requested)) {
            console.warn(`[OpenAI] Ignoring unsupported requested image model "${requested}" for OpenAI-style image generation.`);
        } else {
            return { modelId: requested, availableModels };
        }

    }

    if (configured) {
        const configuredMatch = availableModels.find((model) => model.id === configured);
        if (configuredMatch) {
            return { modelId: configuredMatch.id, availableModels };
        }

        return { modelId: configured, availableModels };
    }

    if (availableModels.length > 0) {
        return { modelId: availableModels[0].id, availableModels };
    }

    const message = imageProvider.source === 'official-openai'
        ? 'No media image model is configured. Set OPENAI_MEDIA_IMAGE_MODEL.'
        : 'No image generation model is configured. Set OPENAI_IMAGE_MODEL or expose image models from the gateway.';
    const error = new Error(message);
    error.status = 503;
    throw error;
}

function normalizeMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((item) => normalizeMessageContent(item))
            .join('');
    }

    if (content && typeof content === 'object') {
        if (typeof content.text === 'string') {
            return content.text;
        }

        if (typeof content.output_text === 'string') {
            return content.output_text;
        }

        if (typeof content.value === 'string') {
            return content.value;
        }

        if (typeof content.content === 'string') {
            return content.content;
        }

        if (typeof content.message === 'string') {
            return content.message;
        }

        if (typeof content.reasoning_content === 'string') {
            return content.reasoning_content;
        }

        if (typeof content.reasoning === 'string') {
            return content.reasoning;
        }

        if (typeof content.refusal === 'string') {
            return content.refusal;
        }

        if (Array.isArray(content.content)) {
            return normalizeMessageContent(content.content);
        }

        if (Array.isArray(content.parts)) {
            return normalizeMessageContent(content.parts);
        }

        if (Array.isArray(content.items)) {
            return normalizeMessageContent(content.items);
        }

        if (Array.isArray(content.output)) {
            return normalizeMessageContent(content.output);
        }

        if (Array.isArray(content.data)) {
            return normalizeMessageContent(content.data);
        }
    }

    return '';
}

function normalizeResponsesMessageContent(content) {
    if (!Array.isArray(content)) {
        return content;
    }

    return content
        .map((part) => {
            if (typeof part === 'string') {
                return { type: 'input_text', text: part };
            }
            if (!part || typeof part !== 'object') {
                return null;
            }

            const type = String(part.type || '').trim();
            if (type === 'input_text' || type === 'text' || type === 'output_text') {
                return {
                    type: 'input_text',
                    text: part.text || part.content || part.value || '',
                };
            }
            if (type === 'input_image') {
                return {
                    type: 'input_image',
                    ...(part.file_id ? { file_id: part.file_id } : {}),
                    ...(part.image_url ? { image_url: typeof part.image_url === 'object' ? part.image_url.url : part.image_url } : {}),
                    detail: part.detail || 'auto',
                };
            }
            if (type === 'image_url' || part.image_url || part.imageUrl || part.url) {
                const imageUrl = typeof part.image_url === 'object'
                    ? part.image_url.url
                    : (part.image_url || part.imageUrl || part.url);
                return imageUrl
                    ? {
                        type: 'input_image',
                        image_url: imageUrl,
                        detail: part.detail || 'auto',
                    }
                    : null;
            }

            return null;
        })
        .filter((part) => part && (part.type !== 'input_text' || String(part.text || '').trim()));
}

function normalizeChatMessageContent(content) {
    if (!Array.isArray(content)) {
        return content;
    }

    return content
        .map((part) => {
            if (typeof part === 'string') {
                return { type: 'text', text: part };
            }
            if (!part || typeof part !== 'object') {
                return null;
            }

            const type = String(part.type || '').trim();
            if (type === 'text' || type === 'input_text' || type === 'output_text') {
                return {
                    type: 'text',
                    text: part.text || part.content || part.value || '',
                };
            }
            if (type === 'image_url' || type === 'input_image' || part.image_url || part.imageUrl || part.url) {
                const imageUrl = typeof part.image_url === 'object'
                    ? part.image_url.url
                    : (part.image_url || part.imageUrl || part.url);
                return imageUrl
                    ? {
                        type: 'image_url',
                        image_url: { url: imageUrl },
                        ...(part.detail ? { detail: part.detail } : {}),
                    }
                    : null;
            }

            return null;
        })
        .filter((part) => part && (part.type !== 'text' || String(part.text || '').trim()));
}

function collectInputSystemMessages(input = null) {
    const inputMessages = Array.isArray(input) ? input : null;
    if (!inputMessages) {
        return [];
    }

    return inputMessages
        .filter((entry) => entry?.role === 'system')
        .map((entry) => normalizeMessageContent(entry.content))
        .filter(Boolean);
}

function mergeInstructions(instructions = null, inputSystemMessages = []) {
    return [instructions, ...inputSystemMessages]
        .filter(Boolean)
        .join('\n\n');
}

function hashPromptText(text = '') {
    const normalized = String(text || '');
    if (!normalized) {
        return null;
    }

    return crypto
        .createHash('sha256')
        .update(normalized, 'utf8')
        .digest('hex');
}

function buildPromptState({
    instructions = null,
    input = null,
    previousPromptState = null,
    previousResponseId = null,
    apiMode = 'chat',
} = {}) {
    const inputSystemMessages = collectInputSystemMessages(input);
    const mergedInstructions = mergeInstructions(instructions, inputSystemMessages);
    const instructionsFingerprint = hashPromptText(mergedInstructions);
    const previousInstructionsFingerprint = typeof previousPromptState === 'string'
        ? previousPromptState
        : previousPromptState?.instructionsFingerprint || null;
    const canReuseThreadedPrompt = Boolean(
        apiMode === 'responses'
        && previousResponseId
        && instructionsFingerprint
        && previousInstructionsFingerprint
        && previousInstructionsFingerprint === instructionsFingerprint,
    );

    return {
        instructionsFingerprint,
        previousInstructionsFingerprint,
        canReuseThreadedPrompt,
        mergedInstructions,
    };
}

function attachKimibuiltMetadata(response = {}, metadata = {}) {
    if (!response || typeof response !== 'object' || !metadata || typeof metadata !== 'object') {
        return response;
    }

    response._kimibuilt = {
        ...(response._kimibuilt && typeof response._kimibuilt === 'object' ? response._kimibuilt : {}),
        ...metadata,
    };

    return response;
}

function buildMessages({
    input,
    instructions = null,
    contextMessages = [],
    recentMessages = [],
    recentTranscriptAnchor = '',
}) {
    const messages = [];
    const inputMessages = Array.isArray(input) ? input : null;
    const mergedInstructions = mergeInstructions(instructions, collectInputSystemMessages(input));

    if (mergedInstructions) {
        messages.push({
            role: 'system',
            content: mergedInstructions,
        });
    }

    if (recentTranscriptAnchor) {
        messages.push({
            role: 'system',
            content: recentTranscriptAnchor,
        });
    }

    if (contextMessages.length > 0) {
        messages.push({
            role: 'system',
            content: `[Historical recalled memory - not current transcript]\nThese snippets are older retrieved context, not messages or uploads from the active turn.\nUse them only as supporting context when they help resolve an explicit follow-up or recover older details.\nDo not treat artifacts, uploads, tool results, plans, or requests mentioned here as current unless the current user request or recent transcript clearly asks to reuse them.\nIf this conflicts with the recent transcript or the user's current request, ignore it and follow the recent transcript/current request.\n${contextMessages.map(stripAgentJournalBlocks).join('\n---\n')}`,
        });
    }

    const promptRecentMessages = filterRecentMessagesForPrompt(recentMessages, input);
    if (promptRecentMessages.length > 0) {
        messages.push(...promptRecentMessages
            .filter((entry) => ['user', 'assistant', 'system', 'tool'].includes(entry?.role))
            .map((entry) => ({
                role: entry.role,
                content: stripAgentJournalBlocks(normalizeMessageContent(entry.content)),
            }))
            .filter((entry) => entry.content));
    }

    if (typeof input === 'string') {
        messages.push({
            role: 'user',
            content: stripAgentJournalBlocks(input),
        });
    } else if (inputMessages) {
        messages.push(...inputMessages
            .filter((entry) => entry?.role !== 'system')
            .map((entry) => ({
                ...entry,
                content: stripAgentJournalFromStructuredContent(entry.content),
            }))
            .filter((entry) => entry.content));
    } else {
        messages.push(input && typeof input === 'object'
            ? {
                ...input,
                content: stripAgentJournalFromStructuredContent(input.content),
            }
            : input);
    }

    return messages;
}

function stripAgentJournalFromStructuredContent(content) {
    if (typeof content === 'string') {
        return stripAgentJournalBlocks(content);
    }

    if (Array.isArray(content)) {
        return content
            .map((entry) => stripAgentJournalFromStructuredContent(entry))
            .filter((entry) => {
                if (typeof entry === 'string') {
                    return Boolean(entry.trim());
                }
                if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
                    return Boolean(entry.text.trim()) || String(entry.type || '').includes('image');
                }
                return entry != null;
            });
    }

    if (!content || typeof content !== 'object') {
        return content;
    }

    const next = { ...content };
    ['text', 'content', 'value', 'message'].forEach((key) => {
        if (typeof next[key] === 'string') {
            next[key] = stripAgentJournalBlocks(next[key]);
        }
    });
    if (Array.isArray(next.content)) {
        next.content = stripAgentJournalFromStructuredContent(next.content);
    }
    if (Array.isArray(next.parts)) {
        next.parts = stripAgentJournalFromStructuredContent(next.parts);
    }
    return next;
}

function normalizePromptText(value = '') {
    return stripAgentJournalBlocks(normalizeMessageContent(value))
        .replace(/\s+/g, ' ')
        .trim();
}

function getInputUserTexts(input) {
    if (typeof input === 'string') {
        return [normalizePromptText(input)].filter(Boolean);
    }

    if (Array.isArray(input)) {
        return input
            .filter((entry) => entry?.role === 'user')
            .map((entry) => normalizePromptText(entry.content))
            .filter(Boolean);
    }

    if (input?.role === 'user') {
        return [normalizePromptText(input.content)].filter(Boolean);
    }

    return [];
}

function filterRecentMessagesForPrompt(recentMessages = [], input = '') {
    const normalizedRecentMessages = Array.isArray(recentMessages) ? recentMessages : [];
    const inputUserTexts = new Set(getInputUserTexts(input));
    if (inputUserTexts.size === 0) {
        return normalizedRecentMessages;
    }

    return normalizedRecentMessages.filter((entry, index) => {
        if (entry?.role !== 'user') {
            return true;
        }

        const content = normalizePromptText(entry.content);
        if (!content || !inputUserTexts.has(content)) {
            return true;
        }

        const hasLaterNonCurrentUserMessage = normalizedRecentMessages
            .slice(index + 1)
            .some((candidate) => (
                candidate?.role === 'user'
                && !inputUserTexts.has(normalizePromptText(candidate.content))
            ));

        return hasLaterNonCurrentUserMessage;
    });
}

function getLastUserText(messages = []) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
            return normalizeMessageContent(messages[index].content);
        }
    }

    return '';
}

function normalizeTriggerPattern(pattern = '') {
    return String(pattern || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function promptMentionsPattern(prompt, pattern) {
    const normalizedPrompt = normalizeTriggerPattern(prompt);
    const normalizedPattern = normalizeTriggerPattern(pattern);
    if (!normalizedPrompt || !normalizedPattern) {
        return false;
    }

    return normalizedPrompt.includes(normalizedPattern);
}

function hasUsableSshDefaults() {
    const sshConfig = settingsController.getEffectiveSshConfig();

    return Boolean(
        sshConfig.enabled
        && sshConfig.host
        && sshConfig.username
        && (sshConfig.password || sshConfig.privateKeyPath)
    );
}

function normalizeExecutionProfile(value = '') {
    const normalized = String(value || '').trim().toLowerCase();

    if (!normalized) {
        return DEFAULT_EXECUTION_PROFILE;
    }

    if ([
        'remote-build',
        'remote_builder',
        'remote-builder',
        'server-build',
        'server-builder',
        'software-builder',
    ].includes(normalized)) {
        return REMOTE_BUILD_EXECUTION_PROFILE;
    }

    if ([
        'notes',
        'notes-app',
        'notes_app',
        'notes-editor',
        'notes_editor',
    ].includes(normalized)) {
        return NOTES_EXECUTION_PROFILE;
    }

    return DEFAULT_EXECUTION_PROFILE;
}

function promptHasExplicitSshIntent(prompt = '') {
    const normalizedPrompt = String(prompt || '').toLowerCase();

    if (!normalizedPrompt) {
        return false;
    }

    return /\bssh\b/i.test(normalizedPrompt)
        || /\b(remote host|remote server|remote machine)\b/i.test(normalizedPrompt)
        || /\b(remote command|run remotely|execute remotely)\b/i.test(normalizedPrompt)
        || /\b(login to|log into|ssh into|ssh to|connect to)\b/i.test(normalizedPrompt)
        || (/\b(run|execute|deploy|inspect|troubleshoot|check)\b/i.test(normalizedPrompt)
            && /\b(over ssh|via ssh)\b/i.test(normalizedPrompt));
}

function hasExplicitSshTargetCue(prompt = '') {
    const normalizedPrompt = String(prompt || '').toLowerCase();
    if (!normalizedPrompt) {
        return false;
    }

    return promptHasExplicitSshIntent(normalizedPrompt)
        || /\b(host|server|machine|node|target)\b/i.test(normalizedPrompt);
}

function extractExplicitSshTarget(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return null;
    }

    if (!hasExplicitSshTargetCue(text)) {
        return null;
    }

    const loginMatch = text.match(/\b([a-z_][a-z0-9._-]*)@((?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z]{2,}|[a-z0-9.-]+)(?::(\d+))?/i);
    if (loginMatch) {
        return {
            username: loginMatch[1],
            host: loginMatch[2],
            port: loginMatch[3] ? Number(loginMatch[3]) : undefined,
        };
    }

    const hostMatch = text.match(/\b(?:(?:host|server|machine)\s+)?((?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z]{2,})\b(?::(\d+))?/i);
    if (hostMatch) {
        return {
            host: hostMatch[1],
            port: hostMatch[2] ? Number(hostMatch[2]) : undefined,
        };
    }

    return null;
}

function extractRequestedSshCommand(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return null;
    }
    const normalized = text.toLowerCase();
    const hasInspectionIntent = /\b(check|inspect|verify|diagnose|debug|troubleshoot|status|state|health|healthy|look at|show|list|see what'?s wrong)\b/.test(normalized);
    const hasReportIntent = /\b(report|summary|overview)\b/.test(normalized);

    const quotedCommandPatterns = [
        /\b(?:run|execute)\s+`([^`]+)`/i,
        /\b(?:run|execute)\s+"([^"]+)"/i,
        /\b(?:run|execute)\s+'([^']+)'/i,
    ];

    for (const pattern of quotedCommandPatterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            return match[1].trim();
        }
    }

    if (/\b(?:check|inspect|verify|look at)\b[\s\S]{0,40}\b(?:health|status)\b/i.test(text)
        || /\bhealth check\b/i.test(text)) {
        return 'hostname && uptime && (df -h / || true) && (free -m || true)';
    }

    if ((hasInspectionIntent && hasReportIntent)
        || /\bhealth report\b/i.test(text)
        || /\bserver state\b/i.test(text)
        || /\bstate report\b/i.test(text)
        || /\bhealth summary\b/i.test(text)) {
        return 'hostname && uptime && (df -h / || true) && (free -m || true)';
    }

    if (hasInspectionIntent && /\b(?:namespace|namespaces)\b/i.test(text) && /\b(kubernetes|k8s|cluster|kubectl)\b/i.test(text)) {
        return 'kubectl get namespaces';
    }

    if (hasInspectionIntent && /\b(?:pod|pods)\b/i.test(text) && /\b(kubernetes|k8s|cluster|kubectl)\b/i.test(text)) {
        return 'kubectl get pods -A';
    }

    return null;
}

function hasExplicitLocalArtifactReference(prompt = '') {
    const source = String(prompt || '').trim();
    if (!source) {
        return false;
    }

    const normalized = source.toLowerCase();
    return /\b(attached artifact|uploaded artifact|local artifact|local file|local html|workspace|repo|repository|on the drive|from the drive|on disk|from disk|readable path|file path)\b/.test(normalized)
        || /[a-z]:\\[^"'`\s]+/i.test(source);
}

function hasRemoteWebsiteUpdateIntent(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const hasWebsiteTarget = /\b(website|web site|webpage|web page|landing page|homepage|home page|site|index\.html)\b/.test(normalized)
        || (
            /\bhtml\b/.test(normalized)
            && /\b(current|existing|deployed|live|website|web ?page|site|homepage|landing page|index\.html)\b/.test(normalized)
        );
    const hasRemoteTarget = /\b(remote|server|cluster|k3s|k8s|kubernetes|kubectl|pod|deployment|deployed|workload|rollout|restart|redeploy|configmap|container|ingress)\b/.test(normalized)
        || /\b(live|online|public|hosted|production)\b[\s\S]{0,20}\b(site|website|web ?page|webpage|homepage|landing page|app|service|index\.html)\b/.test(normalized)
        || /\b(site|website|web ?page|webpage|homepage|landing page|app|service|index\.html)\b[\s\S]{0,20}\b(live|online|public|hosted|production)\b/.test(normalized);
    const hasWriteIntent = /\b(write|replace|overwrite|update|edit|change|deploy|redeploy|restart|publish|push|apply|rollout|create|generate|make)\b/.test(normalized);

    return hasWebsiteTarget && hasRemoteTarget && hasWriteIntent;
}

function hasRemoteSoftwareCreationIntent(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(create|develop|build|make|ship|launch|publish|scaffold|prototype)\b[\s\S]{0,60}\b(app|application|website|site|frontend|service|game|software|web app)\b[\s\S]{0,80}\b(server|remote|ssh|gitlab|gitea|cluster|k3s|kubernetes|environment|sandbox)\b/,
        /\b(server|remote|ssh|gitlab|gitea|cluster|k3s|kubernetes|environment|sandbox)\b[\s\S]{0,80}\b(create|develop|build|make|ship|launch|publish|scaffold|prototype)\b[\s\S]{0,60}\b(app|application|website|site|frontend|service|game|software|web app)\b/,
        /\b(this (?:server|cluster|environment|sandbox))\b[\s\S]{0,60}\b(create|develop|build|make|ship|launch|publish)\b[\s\S]{0,60}\b(app|application|website|site|frontend|service|game|software|web app)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasRemoteSoftwareDeploymentIntent(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const softwareTarget = /\b(app|application|site|website|web app|web page|webpage|frontend|dashboard|service|game|software)\b/.test(normalized);
    const remoteTarget = /\b(remote|server|host|runner|cli runner|gitlab|gitea|cluster|k3s|k8s|kubernetes|domain|dns|ingress|traefik|tls|deploy|deployment|live|online)\b/.test(normalized)
        || /\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/.test(normalized);
    const deploymentIntent = /\b(deploy|redeploy|publish|launch|ship|go live|get (?:it|the app|the site|the website) (?:live|online|deployed)|bring (?:it|the app|the site|the website) (?:live|online)|route|ingress|tls|dns|domain|rollout)\b/.test(normalized);
    const authoringIntent = /\b(create|develop|build|make|ship|launch|publish|scaffold|prototype|implement|update|fix|edit|change|deploy|redeploy)\b/.test(normalized);
    const infraOnly = /\b(kubectl get|kubectl describe|logs?|status|health|uptime|journalctl|systemctl status|inspect|diagnose|debug)\b/.test(normalized)
        && !/\b(create|make|build|implement|develop|write|update|fix|deploy|redeploy|publish|launch|ship)\b/.test(normalized);

    return softwareTarget && remoteTarget && deploymentIntent && authoringIntent && !infraOnly;
}

function hasRemoteBuildAuthoringContinuationIntent(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const authoringIntent = /\b(make|patch|apply|change|update|fix|edit|implement|build|deploy|redeploy|publish|launch|ship|push|commit)\b/.test(normalized);
    const infraOnly = /\b(kubectl get|kubectl describe|logs?|status|health|uptime|journalctl|systemctl status|inspect|diagnose|debug|check)\b/.test(normalized)
        && !/\b(make|patch|apply|change|update|fix|edit|implement|build|deploy|redeploy|publish|launch|ship|push|commit)\b/.test(normalized);

    return authoringIntent && !infraOnly;
}

function hasExplicitLocalSandboxIntent(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(run|execute|test)\b[\s\S]{0,40}\b(code|script|snippet)\b/.test(normalized)
        || /\b(code sandbox|sandbox|locally|local code)\b/.test(normalized);
}

function hasInternalArtifactReference(prompt = '') {
    const source = String(prompt || '').trim();
    if (!source) {
        return false;
    }

    return /(?:^|[\s(])\/api\/artifacts\/[a-f0-9-]+\/download\b/i.test(source)
        || /(?:^|[\s(])api\/artifacts\/[a-f0-9-]+\/download\b/i.test(source)
        || /https?:\/\/api\/artifacts\/[a-f0-9-]+\/download\b/i.test(source)
        || /https?:\/\/[^/\s]+\/api\/artifacts\/[a-f0-9-]+\/download\b/i.test(source);
}

function hasIndexedAssetIntent(prompt = '') {
    const source = String(prompt || '').trim();
    if (!source) {
        return false;
    }

    return [
        /\b(previous|earlier|prior|last|latest|same|that|those|these|uploaded|attached|generated|saved|worked on|working with)\b[\s\S]{0,50}\b(image|images|photo|photos|picture|pictures|document|documents|doc|docs|pdf|deck|slide deck|pptx|file|files|artifact|artifacts|attachment|attachments)\b/i,
        /\b(image|images|photo|photos|picture|pictures|document|documents|doc|docs|pdf|deck|slide deck|pptx|file|files|artifact|artifacts|attachment|attachments)\b[\s\S]{0,70}\b(from earlier|from before|from last time|we worked on|we were working with|you generated|you made|you created|uploaded|attached|saved)\b/i,
        /\b(find|search|locate|list|show|open|use|reuse|reference|pull up|look for)\b[\s\S]{0,40}\b(previous|earlier|uploaded|attached|generated|saved|artifact|image|document|pdf|file|attachment)\b/i,
        /\b(asset|assets)\b[\s\S]{0,20}\b(search|index|indexed|catalog|catalogue|manager)\b/i,
    ].some((pattern) => pattern.test(source));
}

function hasResearchBucketIntent(prompt = '') {
    const source = String(prompt || '').trim();
    if (!source) {
        return false;
    }

    return [
        /\bresearch bucket\b/i,
        /\breference bucket\b/i,
        /\bsource library\b/i,
        /\bsaved research\b/i,
        /\bproject references?\b/i,
        /\blong[- ]term bucket\b/i,
        /\bbucket\b[\s\S]{0,60}\b(images?|data|graphs?|code|audio|wave|wav|docs?|references?|assets?)\b/i,
        /\b(images?|data|graphs?|code|audio|wave|wav|docs?|references?|assets?)\b[\s\S]{0,60}\bbucket\b/i,
    ].some((pattern) => pattern.test(source));
}

function hasPublicSourceIndexIntent(prompt = '') {
    const source = String(prompt || '').trim();
    if (!source) {
        return false;
    }

    return [
        /\bpublic source index\b/i,
        /\bpublic api index\b/i,
        /\bpublic api catalog(?:ue)?\b/i,
        /\bapi source library\b/i,
        /\bdashboard source catalog(?:ue)?\b/i,
        /\b(news|rss|data|public)\s+feed\s+(index|catalog|catalogue|source|sources)\b/i,
        /\b(find|search|list|show|add|save|store|index|verify|refresh)\b[\s\S]{0,60}\b(public api|public endpoint|public feed|news feed|rss feed|dashboard source|data portal|open data source)\b/i,
        /\b(public api|public endpoint|public feed|news feed|rss feed|dashboard source|data portal|open data source)\b[\s\S]{0,60}\b(find|search|list|show|add|save|store|index|verify|refresh)\b/i,
    ].some((pattern) => pattern.test(source));
}

function shouldAutoUseTool(toolId, prompt = '', skill = null, options = {}) {
    const executionProfile = normalizeExecutionProfile(
        options?.executionProfile
        || options?.toolContext?.executionProfile,
    );
    const subAgentDepth = Number(
        options?.subAgentDepth
        || options?.toolContext?.subAgentDepth
        || 0,
    );
    const workloadService = options?.workloadService || options?.toolContext?.workloadService;
    const isDeferredWorkloadRun = options?.workloadRun === true
        || options?.clientSurface === 'workload'
        || options?.toolContext?.workloadRun === true
        || options?.toolContext?.clientSurface === 'workload';

    if (toolId === 'k3s-deploy') {
        return hasUsableSshDefaults()
            && (executionProfile === 'remote-build' || /\b(k3s|kubernetes|kubectl|deployment|rollout|manifest|helm)\b/i.test(prompt));
    }

    if (toolId === 'managed-app') {
        return shouldPreferManagedAppForRemoteBuild(prompt, options);
    }

    if (toolId === 'agent-workload') {
        const canonicalWorkload = buildCanonicalWorkloadAction({
            request: prompt,
        }, {
            recentMessages: options?.recentMessages || options?.toolContext?.recentMessages || [],
            timezone: options?.timezone || options?.toolContext?.timezone || null,
            now: options?.now || options?.toolContext?.now || null,
        });
        return !isDeferredWorkloadRun
            && Boolean(workloadService?.isAvailable?.())
            && (
                hasWorkloadIntent(prompt)
                || canonicalWorkload?.trigger?.type === 'cron'
                || canonicalWorkload?.trigger?.type === 'once'
            );
    }

    if (toolId === 'ssh-execute') {
        return promptHasExplicitSshIntent(prompt)
            || (executionProfile === 'remote-build' && hasUsableSshDefaults());
    }

    if (toolId === 'remote-command') {
        return promptHasExplicitSshIntent(prompt)
            || (executionProfile === 'remote-build' && hasUsableSshDefaults());
    }

    if (toolId === DOCUMENT_WORKFLOW_TOOL_ID) {
        if (extractPiiRelationshipFormulaPlanRequest(prompt)) {
            return false;
        }
        return Boolean(options?.documentService || options?.toolContext?.documentService);
    }

    if (toolId === DEEP_RESEARCH_PRESENTATION_TOOL_ID) {
        return Boolean(options?.documentService || options?.toolContext?.documentService);
    }

    if (toolId === RELATIONSHIP_CALCULATION_TOOL_ID) {
        return Boolean(getPiiWorkbookRelationshipRequest(options))
            || hasPiiRelationshipCalculationIntent(prompt, options);
    }

    if (toolId === USER_CHECKPOINT_TOOL_ID) {
        const checkpointPolicy = options?.userCheckpointPolicy || options?.toolContext?.userCheckpointPolicy || {};
        if (parseUserCheckpointResponseMessage(prompt)) {
            return false;
        }
        return checkpointPolicy.enabled === true
            && Number(checkpointPolicy.remaining || 0) > 0
            && !checkpointPolicy.pending;
    }

    if (toolId === 'agent-notes-write') {
        return isAgentNotesAutoWriteEnabled();
    }

    if (toolId === SELF_REFLECTION_UPDATE_TOOL_ID) {
        return hasSelfReflectionUpdateIntentText(prompt);
    }

    if (toolId === 'agent-delegate') {
        return subAgentDepth < 1 && Boolean(workloadService?.isAvailable?.());
    }

    return true;
}

function hasExplicitGitIntent(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    return /\b(git|github)\b[\s\S]{0,80}\b(status|diff|branch|stage|add|commit|push|save and push|save-and-push)\b/i.test(text)
        || /\b(status|diff|branch|stage|add|commit|push)\b[\s\S]{0,40}\bgit\b/i.test(text)
        || /\b(commit|push|save)\b[\s\S]{0,40}\b(files?|changes?|work|design|project)\b[\s\S]{0,40}\b(to|into)\b[\s\S]{0,20}\bgithub\b/i.test(text);
}

function hasExplicitK3sDeployIntent(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    return /\b(deploy|rollout|apply|set image|update image|sync)\b[\s\S]{0,60}\b(k3s|k8s|kubernetes|kubectl|manifest|deployment|helm)\b/i.test(text)
        || /\b(k3s|k8s|kubernetes|kubectl)\b[\s\S]{0,60}\b(deploy|rollout|apply|set image|manifest|deployment|sync)\b/i.test(text);
}

function shouldIncludeRemoteContinuityInstructions({
    prompt = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    toolContext = {},
} = {}) {
    if (normalizeExecutionProfile(executionProfile) === REMOTE_BUILD_EXECUTION_PROFILE) {
        return true;
    }

    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    if (promptHasExplicitSshIntent(text) || hasExplicitK3sDeployIntent(text)) {
        return true;
    }

    const allowedToolIds = new Set([
        ...(Array.isArray(toolContext?.allowedToolIds) ? toolContext.allowedToolIds : []),
        ...(Array.isArray(toolContext?.candidateToolIds) ? toolContext.candidateToolIds : []),
        ...(Array.isArray(toolContext?.availableToolIds) ? toolContext.availableToolIds : []),
    ].map((entry) => String(entry || '').trim()).filter(Boolean));

    if (allowedToolIds.size === 0) {
        return false;
    }

    const hasRemoteTool = ['remote-command', 'ssh-execute', 'remote-cli-agent', 'k3s-deploy', 'managed-app']
        .some((toolId) => allowedToolIds.has(toolId));
    if (!hasRemoteTool) {
        return false;
    }

    return /\b(remote|server|cluster|deploy|deployment|rollout|ingress|tls|dns|gitlab|kubectl|k3s|k8s|kubernetes)\b/i.test(text);
}

function buildEffectiveContinuityInstructions({
    instructions = null,
    prompt = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    toolContext = {},
} = {}) {
    if (!shouldIncludeRemoteContinuityInstructions({ prompt, executionProfile, toolContext })) {
        return instructions;
    }

    return mergeInstructions(instructions, [buildRemoteContinuityInstructions()]);
}

function hasManagedAppIntent(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    return [
        /\bmanaged app\b/i,
        /\bmanaged[- ]app\b/i,
        /\bmanaged\b[\s\S]{0,20}\b(app|apps|catalog|control plane|platform)\b/i,
        /\b(app|apps)\b[\s\S]{0,20}\b(managed catalog|managed-app|control plane)\b/i,
        /\b(gitlab|gitlab[-_ ]runner|gitlab ci|gitea|act[-_ ]runner|gitea actions?|managed app catalog|managed-app catalog|build events webhook)\b/i,
        /\b(managed-app|managed app)\b[\s\S]{0,40}\b(create|build|deploy|publish|launch|ship|update|redeploy|inspect|list|doctor|reconcile|repair)\b/i,
    ].some((pattern) => pattern.test(text));
}

function getToolContextMetadata(options = {}) {
    if (options?.metadata && typeof options.metadata === 'object') {
        return options.metadata;
    }
    if (options?.toolContext?.metadata && typeof options.toolContext.metadata === 'object') {
        return options.toolContext.metadata;
    }
    return {};
}

function getPiiRelationshipCalculationState(options = {}) {
    const metadata = getToolContextMetadata(options);
    return metadata?.piiCleansing?.relationshipCalculations
        || options?.piiCleansing?.relationshipCalculations
        || options?.toolContext?.piiCleansing?.relationshipCalculations
        || options?.toolContext?.metadata?.piiCleansing?.relationshipCalculations
        || null;
}

function getPiiWorkbookRelationshipRequest(options = {}) {
    const request = options?.toolContext?.piiWorkbookRelationship?.request
        || options?.piiWorkbookRelationship?.request
        || options?.toolContext?.piiRelationshipCalculationRequest
        || options?.piiRelationshipCalculationRequest
        || null;
    return request && typeof request === 'object' && !Array.isArray(request) ? request : null;
}

function hasPiiRelationshipCalculationIntent(prompt = '', options = {}) {
    const relationshipState = getPiiRelationshipCalculationState(options);
    if (relationshipState?.active === true) {
        return true;
    }
    const normalized = String(prompt || '').toLowerCase();
    return /\b(pii|private|redacted|placeholder|\[\[pii:)/i.test(prompt)
        && /\b(xlsx|excel|spreadsheet|workbook|sheet|table|rows?|columns?)\b/.test(normalized)
        && /\b(sum|total|add up|count|average|rank|top|bottom|largest|smallest|highest|lowest|group|join|compare)\b/.test(normalized);
}

function hasExplicitDirectRemoteCliIntent(prompt = '') {
    const text = String(prompt || '').trim().toLowerCase();
    if (!text) {
        return false;
    }

    return [
        /\bdirect\s+(?:remote\s+)?(?:ssh|cli|ssh\/cli|command|runner)\b/,
        /\b(?:ssh\/cli|remote ssh\/cli)\s+path\b/,
        /\b(?:ad hoc|manual)\s+(?:ssh|kubectl|k3s|remote command)\b/,
        /\b(?:without|bypass|skip|do not use|don't use)\s+(?:gitlab|managed[- ]app|managed app)\b/,
        /\buse\s+(?:only\s+)?(?:ssh|kubectl|remote-command|remote command)\b/,
    ].some((pattern) => pattern.test(text));
}

function shouldPreferManagedAppForRemoteBuild(prompt = '', options = {}) {
    const executionProfile = normalizeExecutionProfile(
        options?.executionProfile
        || options?.toolContext?.executionProfile,
    );
    if (executionProfile !== 'remote-build' || hasExplicitDirectRemoteCliIntent(prompt)) {
        return false;
    }

    const metadata = getToolContextMetadata(options);
    const frontendPreference = metadata.preferManagedApp === true
        || metadata.remoteBuildIntent === true
        || metadata.frontendRemoteBuildAutonomyApproved === true;

    return hasManagedAppIntent(prompt)
        || (frontendPreference && (
            hasRemoteSoftwareCreationIntent(prompt)
            || hasRemoteSoftwareDeploymentIntent(prompt)
        ));
}

function hasExplicitWebResearchIntent(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    return [
        /\bweb research\b/i,
        /\bresearch\b/i,
        /\blook up\b/i,
        /\bsearch for\b/i,
        /\bsearch the web\b/i,
        /\bbrowse (?:the )?web\b/i,
        /\bsearch online\b/i,
        /\bbrowse online\b/i,
        /\b(news|headlines?|current events?)\b/i,
    ].some((pattern) => pattern.test(text));
}

function hasDeepResearchPresentationIntent(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    return hasExplicitWebResearchIntent(text)
        && /\b(slides|presentation|slide deck|deck|pptx|website slides)\b/i.test(text);
}

function hasExplicitSubAgentIntent(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    return [
        /\bsub[- ]agent(?:s)?\b/i,
        /\bdelegate\b[\s\S]{0,40}\b(task|tasks|worker|workers|agent|agents|job|jobs)\b/i,
        /\bparallel\b[\s\S]{0,30}\b(task|tasks|worker|workers|agent|agents)\b/i,
        /\bspawn\b[\s\S]{0,30}\b(worker|workers|agent|agents|sub[- ]agent)\b/i,
    ].some((pattern) => pattern.test(text));
}

function hasExplicitQuestionnaireToolTestIntent(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    const mentionsQuestionnaire = /\b(questionnaire|survey|multiple[- ]choice|multiple choice)\b/i.test(text);
    const mentionsTesting = /\b(test|try|exercise|demo)\b/i.test(text);
    const asksToBeAsked = /\bask me\b/i.test(text) || /\bask that as\b/i.test(text);
    const mentionsTool = /\btool\b/i.test(text);

    return mentionsQuestionnaire && (mentionsTesting || asksToBeAsked || mentionsTool);
}

function hasExplicitUserCheckpointInteractionIntent(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }

    const mentionsQuestionnaire = /\b(questionnaire|questionaire|survey|multiple[- ]choice|multiple choice|user[- ]checkpoint|checkpoint)\b/i.test(text);
    const asksToBeAsked = /\bask me\b/i.test(text)
        || /\bask that as\b/i.test(text)
        || /\bcan you ask\b/i.test(text)
        || /\bask (?:this|that|those)\b[\s\S]{0,20}\bas\b/i.test(text)
        || /\bdo (?:the |a )?survey\b/i.test(text)
        || /\bsurvey directly\b/i.test(text);
    const mentionsInlineUi = /\b(inline|popup|card|clickable|choice|choices|option|options)\b/i.test(text)
        && /\b(survey|questionnaire|questionaire|checkpoint)\b/i.test(text);
    const mentionsToolOrSurface = /\b(tool|ui|web[- ]chat)\b/i.test(text) && mentionsQuestionnaire;
    const asksForCheckpointCard = /\b(turn|make|convert|open|use|show|render)\b[\s\S]{0,40}\b(user[- ]checkpoint|checkpoint card|survey card|inline survey|inline questionnaire)\b/i.test(text);
    const asksForStructuredSurvey = /\b(?:give|make|create|build|do)\b[\s\S]{0,30}\b(?:a|an|some)?\s*survey\b/i.test(text)
        || /\b(?:in|as)\s+a?\s*survey\b/i.test(text)
        || /\bsurvey of\b/i.test(text);
    const rejectsWorkloadForSurvey = /\bno workload\b/i.test(text) && mentionsQuestionnaire;

    return mentionsQuestionnaire && (
        asksToBeAsked
        || mentionsInlineUi
        || mentionsToolOrSurface
        || asksForCheckpointCard
        || asksForStructuredSurvey
        || rejectsWorkloadForSurvey
    );
}

function extractExplicitWebResearchQuery(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
        return null;
    }

    const patterns = [
        /\b(?:do|perform|run)\s+research\s+(?:on|about|into)?\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\bweb research\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\bresearch\s+(?:on|about|into)?\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\blook up\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\bsearch for\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
        /\bsearch the web for\s+(.+?)(?:[.?!]\s|[\r\n]|$)/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            return match[1].trim().replace(/[.?!]+$/g, '').trim();
        }
    }

    if (!hasExplicitWebResearchIntent(text)) {
        return null;
    }

    return text
        .replace(/^(please|can you|could you|would you|help me|i need you to)\s+/i, '')
        .replace(/[.?!]+$/g, '')
        .trim();
}

function inferPerplexityResearchModeForPreflight(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return 'search';
    }

    if (/\b(advanced deep research|institutional(?:-|\s)grade research|maximum depth research|maximum-depth research)\b/.test(normalized)) {
        return 'advanced-deep-research';
    }

    if (/\b(deep research|in-depth research|comprehensive research|exhaustive research|thorough research)\b/.test(normalized)) {
        return 'sonar-deep-research';
    }

    if (/\b(pro search|agentic research|autonomous research|multi-tool research|plan\s*\+\s*search\s*\+\s*fetch|one-call research|one call research|daily news|news roundup|news digest|briefing|newsletter|article roundup|articles?|coverage|current events?|gather(?:ed|ing)? sources?|collect(?:ed|ing)? sources?|research data|source-backed)\b/.test(normalized)) {
        return 'pro-search';
    }

    if (/\b(grounded answer|answer with citations|one-shot answer|one shot answer|with citations)\b/.test(normalized)) {
        return 'sonar-pro';
    }

    return 'search';
}

function inferExpandedResearchParamsForPreflight(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    const base = {
        maxTokens: Math.max(10000, Number(config.search?.defaultMaxTokens || 50000)),
        maxTokensPerPage: Math.max(1024, Number(config.search?.defaultMaxTokensPerPage || 4096)),
    };
    const needsGatheredResearch = /\b(daily news|news roundup|news digest|briefing|newsletter|articles?|coverage|current events?|gather(?:ed|ing)?|collect(?:ed|ing)?|source-backed|citations?|sources?|research data)\b/.test(normalized);
    const needsDeepResearch = /\b(deep research|in-depth research|comprehensive research|exhaustive research|thorough research|advanced deep research|institutional(?:-|\s)grade research)\b/.test(normalized);

    return {
        ...base,
        ...(needsGatheredResearch || needsDeepResearch
            ? {
                searchContextSize: needsDeepResearch ? 'high' : 'medium',
                maxOutputTokens: needsDeepResearch
                    ? 7000
                    : Math.max(3200, Number(config.search?.defaultMaxOutputTokens || 3200)),
                maxSteps: needsDeepResearch ? 8 : 4,
                instructions: [
                    'Prefer authoritative primary sources, reputable publishers, and pages with dates or bylines.',
                    'Gather enough page-level evidence to support synthesis; avoid relying on headlines or snippets alone.',
                    'Call out uncertainty, conflicting coverage, or blocked pages instead of smoothing over gaps.',
                ].join(' '),
            }
            : {}),
    };
}

function cleanExtractedPathLikeValue(value = '') {
    return String(value || '')
        .trim()
        .replace(/[.?!,;:]+$/g, '')
        .trim();
}

function extractFirstUrl(prompt = '') {
    const text = String(prompt || '');
    if (!text.trim()) {
        return null;
    }

    const match = text.match(/https?:\/\/[^\s<>"')]+/i);
    return match ? match[0].replace(/[),.;!?]+$/, '') : null;
}

function inferScrapeParams(prompt = '', firstUrl = '') {
    const text = String(prompt || '');
    const normalized = text.toLowerCase();
    const hasImageIntent = /\b(image|images|photo|photos|thumbnail|thumbnails|gallery|galleries|poster|posters|pics?)\b/i.test(text);
    const hasBlindIntent = /\b(blind|opaque|without exposing|without showing|without viewing|without looking at|do not show|don't show)\b/i.test(text);
    const hasSensitiveIntent = /\b(adult|explicit|nsfw|porn)\b/i.test(text);
    const captureImages = hasImageIntent || hasBlindIntent || hasSensitiveIntent;

    return {
        url: firstUrl,
        browser: true,
        ...(captureImages ? { captureImages: true, imageLimit: 12 } : {}),
        ...((captureImages && (hasBlindIntent || hasSensitiveIntent)) ? { blindImageCapture: true } : {}),
        ...(normalized.includes('javascript') ? { javascript: true } : {}),
    };
}

function extractRequestedDirectoryPath(prompt = '') {
    const text = String(prompt || '');
    if (!text.trim()) {
        return null;
    }

    const creationIntent = /\b(create|make|mkdir)\b[\s\S]{0,80}\b(folder|directory)\b/i.test(text)
        || /\b(folder|directory)\b[\s\S]{0,40}\b(called|named|name it)\b/i.test(text);

    if (!creationIntent) {
        return null;
    }

    const quotedMatch = text.match(/\b(?:folder|directory)\b[\s\S]{0,40}["'`]+([^"'`\r\n]+)["'`]+/i);
    if (quotedMatch?.[1]) {
        return quotedMatch[1].trim();
    }

    const namedMatch = text.match(/\b(?:called|named|name it)\s+([a-zA-Z0-9._/-]+)/i);
    if (namedMatch?.[1]) {
        return cleanExtractedPathLikeValue(namedMatch[1]);
    }

    const directMatch = text.match(/\b(?:create|make|mkdir)\s+(?:a\s+)?(?:folder|directory)\s+(?:called\s+|named\s+)?([a-zA-Z0-9._/-]+)/i);
    if (directMatch?.[1]) {
        return cleanExtractedPathLikeValue(directMatch[1]);
    }

    return null;
}

function hasExplicitArtifactGenerationIntentForPreflight(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(export|download|save|convert|turn\b[\s\S]{0,20}\binto|turn\b[\s\S]{0,20}\bas|format\b[\s\S]{0,20}\bas)\b/i.test(normalized)
        || /\b(create|make|generate|build|produce|render|prepare|draft)\b[\s\S]{0,60}\b(file|artifact|document|page|report|brief|pdf|html|docx|xml|spreadsheet|excel|workbook|mermaid|diagram|flowchart|sequence diagram|erd|class diagram|state diagram)\b/i.test(normalized)
        || /\b(as|into|in)\s+(?:an?\s+)?(?:pdf|html|docx|xml|spreadsheet|excel workbook|workbook|mermaid|mmd)\b/i.test(normalized)
        || /\b(pdf|html|docx|xml|spreadsheet|excel|workbook)\s+(?:file|document|artifact|export)\b/i.test(normalized);
}

function hasExplicitStandaloneHtmlIntentForPreflight(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(standalone html|html file|downloadable html|shareable html|html artifact|html export)\b/i.test(normalized);
}

function hasExplicitMermaidArtifactIntentForPreflight(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (/\b(mermaid|\.mmd\b)\b/i.test(normalized)) {
        return hasExplicitArtifactGenerationIntentForPreflight(normalized)
            || /\b(mermaid|mmd)\s+(?:file|artifact|diagram|chart|export)\b/i.test(normalized);
    }

    return /\b(create|make|generate|build|produce|render|export|draw)\b[\s\S]{0,60}\b(diagram|flowchart|sequence diagram|erd|entity relationship|class diagram|state diagram)\b/i.test(normalized)
        || /\b(diagram|flowchart|sequence diagram|erd|entity relationship|class diagram|state diagram)\s+(?:file|artifact|export)\b/i.test(normalized);
}

function isWebsiteDesignExampleRequestForPreflight(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const hasWebsiteImplementationCue = /\b(web page|webpage|website|site|frontend|ui|vite|react|nextjs|microsite|landing page)\b/.test(normalized);
    const hasDesignPrototypeCue = /\b(template|prototype|mockup|example|demo|starter|boilerplate|layout|wireframe|design system|component)\b/.test(normalized);
    const hasPresentationOrDocumentCue = /\b(slides|slide deck|deck|presentation|storyboard|report|brief|document|doc)\b/.test(normalized);
    const hasSlideDeckCue = /\b(powerpoint|pptx?|slide deck|slides?|presentation|deck)\b/.test(normalized);
    const hasWebsiteDesignCue = /\b(website design|web design|site design|product design|ui design|design reference|design example|design template)\b/.test(normalized);

    return (hasWebsiteImplementationCue && hasDesignPrototypeCue)
        || (hasPresentationOrDocumentCue && !hasSlideDeckCue && (hasWebsiteImplementationCue || hasWebsiteDesignCue));
}

function inferRequestedOutputFormatForPreflight(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (!normalized) {
        return null;
    }

    const hasArtifactIntent = hasExplicitArtifactGenerationIntentForPreflight(normalized);
    const hasBuildIntent = /\b(create|make|generate|build|produce|render|prepare|draft)\b/.test(normalized);
    const hasExplicitHtmlCue = /\bhtml\b/.test(normalized);
    const hasExplicitPptxCue = /\b(powerpoint|pptx?|\.(pptx|ppt)\b)\b/.test(normalized);
    const hasSlideDeckSubject = /\b(slide deck|slides?|presentation|deck)\b/.test(normalized);
    const hasInteractiveCue = /\b(interactive|clickable|animated|browser-native|web-native)\b/.test(normalized);
    const hasFrontendTemplateCue = /\b(vite|react|nextjs|frontend template|front-end template)\b/.test(normalized);

    if ((/\b(power\s*query|\.(pq|m)\b)/.test(normalized) && hasArtifactIntent)
        || /\b(power\s*query)\s+(?:file|script|artifact|export)\b/.test(normalized)) {
        return 'power-query';
    }

    if ((/\b(xlsx|spreadsheet|excel|workbook)\b/.test(normalized) && hasArtifactIntent)
        || /\b(excel|spreadsheet|workbook)\s+(?:file|artifact|export)\b/.test(normalized)) {
        return 'xlsx';
    }

    if (/\bpdf\b/.test(normalized) && hasArtifactIntent) {
        return 'pdf';
    }

    if (/\b(docx|word document)\b/.test(normalized) && hasArtifactIntent) {
        return 'html';
    }

    if (/\bxml\b/.test(normalized) && hasArtifactIntent) {
        return 'xml';
    }

    if (hasExplicitMermaidArtifactIntentForPreflight(normalized)) {
        return 'mermaid';
    }

    if ((hasArtifactIntent || hasBuildIntent || hasExplicitPptxCue) && (hasSlideDeckSubject || hasExplicitPptxCue)) {
        if (hasExplicitHtmlCue || hasInteractiveCue || hasFrontendTemplateCue || hasExplicitStandaloneHtmlIntentForPreflight(normalized)) {
            return 'html';
        }

        return 'pptx';
    }

    if ((hasArtifactIntent || hasBuildIntent)
        && (
            /\b(website|web page|webpage|landing page|homepage|microsite|marketing site|frontend demo|front-end demo|site mockup|site prototype)\b/.test(normalized)
            || isDashboardRequest(normalized)
        )) {
        return 'html';
    }

    if ((hasArtifactIntent || hasBuildIntent) && isWebsiteDesignExampleRequestForPreflight(normalized)) {
        return 'html';
    }

    if (hasExplicitHtmlCue && hasArtifactIntent) {
        return 'html';
    }

    return null;
}

function hasImplicitImageArtifactFollowupReferenceForPreflight(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(last|generated|previous|prior|same|those|these|this|earlier|above)\b[\s\S]{0,40}\b(images?|photos?|pictures?|illustrations?|renders?)\b/i.test(normalized)
        || /\b(images?|photos?|pictures?|illustrations?|renders?)\b[\s\S]{0,60}\b(from earlier|from before|from above|you made|you generated|we generated|from the last turn)\b/i.test(normalized)
        || /\b(use|put|place|include|embed|make|turn|convert|compile)\b[\s\S]{0,40}\b(those|these|the generated|the previous|the earlier)\b[\s\S]{0,20}\b(images?|photos?|pictures?)\b/i.test(normalized);
}

function hasExplicitImageGenerationIntentForPreflight(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (hasImplicitImageArtifactFollowupReferenceForPreflight(normalized)
        && !/\b(generate|create|make|render|design|draw|illustrate|produce|craft)\b/i.test(normalized)) {
        return false;
    }

    return /\b(generate|create|make|render|design|draw|illustrate|produce|craft)\b[\s\S]{0,50}\b(image|images|photo|photos|picture|pictures|illustration|illustrations|render|renders|artwork|cover image|cover art|poster)\b/i.test(normalized)
        || /\b(text[-\s]?to[-\s]?image|image generation)\b/i.test(normalized)
        || /\b(image|photo|picture|illustration|render|artwork|poster)\b[\s\S]{0,20}\b(of|showing|depicting|featuring)\b/i.test(normalized);
}

function shouldPreGenerateImagesForArtifactRequestForPreflight({
    text = '',
    outputFormat = null,
} = {}) {
    if (!['pdf', 'html'].includes(String(outputFormat || '').trim().toLowerCase())) {
        return false;
    }

    return hasExplicitImageGenerationIntentForPreflight(text);
}

function buildImagePromptFromArtifactRequestForPreflight(text = '') {
    const prompt = String(text || '').trim();
    if (!prompt) {
        return '';
    }

    let cleaned = prompt
        .replace(/\b(?:and then|then|and)?\s*(?:put|place|embed|include|insert|compile|turn|convert)\b[\s\S]*$/i, '')
        .replace(/\b(?:for|into|in|as)\s+(?:an?\s+)?(?:pdf|docx|html|document|page|file|artifact|brochure|booklet|report|brief)\b[\s\S]*$/i, '')
        .replace(/\b(?:make|create|generate|build|produce|prepare)\b[\s\S]{0,20}\b(?:a|an)\s+(?:pdf|docx|html|document|page|file|artifact)\b[\s\S]*$/i, '')
        .trim();

    if (!cleaned || cleaned.length < 12) {
        cleaned = prompt;
    }

    return cleaned;
}

function normalizeFormulaPlanColumnId(value = '') {
    return String(value || '')
        .trim()
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/[^\w.-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function extractFormulaPlanSection(text = '', heading = '') {
    const source = String(text || '');
    const match = source.match(new RegExp(`${heading}\\s*:\\s*([\\s\\S]*?)(?:\\n\\s*(?:Table id|Columns|Rows|Formula intent|Target result cell|Helper slots begin|The model|Do not|$)\\s*:|$)`, 'i'));
    return match ? String(match[1] || '').trim() : '';
}

function extractPiiRelationshipFormulaPlanRequest(prompt = '') {
    const source = String(prompt || '').trim();
    if (!source || !/\bxlsx_formula_plan\b/i.test(source)) {
        return null;
    }
    if (!/\bTable id\s*:/i.test(source) || !/\bColumns\s*:/i.test(source) || !/\bRows\s*:/i.test(source)) {
        return null;
    }

    const tableId = normalizeFormulaPlanColumnId(source.match(/\bTable id\s*:\s*([^\r\n]+)/i)?.[1] || 'table');
    const columnsLine = source.match(/\bColumns\s*:\s*([^\r\n]+)/i)?.[1] || '';
    const columns = columnsLine
        .split(',')
        .map((entry) => normalizeFormulaPlanColumnId(entry))
        .filter(Boolean);
    if (!tableId || columns.length === 0) {
        return null;
    }

    const rowsSection = extractFormulaPlanSection(source, 'Rows');
    const rows = rowsSection
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && line.includes('|'))
        .map((line) => {
            const parts = line.split('|').map((part) => part.trim());
            const id = normalizeFormulaPlanColumnId(parts.shift() || '');
            const cells = {};
            columns.forEach((columnId, index) => {
                cells[columnId] = parts[index] ?? '';
            });
            return id ? { id, cells } : null;
        })
        .filter(Boolean);
    if (rows.length === 0) {
        return null;
    }

    const groupBy = columns.includes('person')
        ? 'person'
        : columns.find((columnId) => rows.some((row) => /^\[\[PII:[^\]]+\]\]$/.test(String(row.cells?.[columnId] || '').trim())))
            || columns[0];
    const formulaIntent = String(source.match(/\bFormula intent\s*:\s*([^\r\n]+)/i)?.[1] || '').trim();
    const signedMeasures = formulaIntent
        ? Array.from(formulaIntent.matchAll(/([+-]?)\s*([A-Za-z_][\w.-]*)/g))
            .map((match) => ({
                sign: match[1] === '-' ? '-' : '+',
                column: normalizeFormulaPlanColumnId(match[2]),
            }))
            .filter((entry) => columns.includes(entry.column) && entry.column !== groupBy)
        : [];
    const measures = Array.from(new Set(
        signedMeasures
            .filter((entry) => entry.sign !== '-')
            .map((entry) => entry.column),
    ));
    const subtractMeasures = Array.from(new Set(
        signedMeasures
            .filter((entry) => entry.sign === '-')
            .map((entry) => entry.column),
    ));
    const fallbackNumericColumns = columns.filter((columnId) => {
        if (columnId === groupBy || /^(row_?id|id|period|date|month)$/i.test(columnId)) {
            return false;
        }
        return rows.some((row) => String(row.cells?.[columnId] || '').trim() !== ''
            && Number.isFinite(Number(String(row.cells[columnId]).replace(/[$,%\s,]/g, ''))));
    });
    const additiveMeasures = measures.length > 0
        ? measures
        : fallbackNumericColumns.filter((columnId) => !/^credits?$/i.test(columnId));
    const subtractiveMeasures = subtractMeasures.length > 0
        ? subtractMeasures
        : fallbackNumericColumns.filter((columnId) => /^credits?$/i.test(columnId));
    if (additiveMeasures.length === 0) {
        return null;
    }

    const resultCell = String(source.match(/\bTarget result cell\s+([A-Za-z0-9_ -]+!\$?[A-Z]{1,3}\$?\d+)/i)?.[1]
        || source.match(/\bresult cell\s+([A-Za-z0-9_ -]+!\$?[A-Z]{1,3}\$?\d+)/i)?.[1]
        || 'Presentation_Result!B5').trim();
    const helperStartCell = String(source.match(/\bHelper slots begin at\s+([A-Za-z0-9_ -]+!\$?[A-Z]{1,3}\$?\d+)/i)?.[1]
        || source.match(/\bhelper.*?\b([A-Za-z0-9_ -]+!\$?[A-Z]{1,3}\$?\d+)/i)?.[1]
        || 'Presentation_Result!A12').trim();
    const sheetName = resultCell.includes('!')
        ? resultCell.split('!')[0].replace(/^'+|'+$/g, '')
        : undefined;
    return {
        operationId: 'prompt-xlsx-formula-plan',
        operation: 'xlsx_formula_plan',
        tableId,
        groupBy,
        measures: additiveMeasures,
        subtractMeasures: subtractiveMeasures,
        target: {
            resultCell,
            helperStartCell,
            ...(sheetName ? { sheetName } : {}),
        },
        limit: Math.max(1, Math.min(100, rows.length)),
        tables: [
            {
                id: tableId,
                columns: columns.map((columnId) => ({
                    id: columnId,
                    header: columnId,
                    role: columnId === groupBy ? 'group_key' : 'value',
                })),
                rows,
            },
        ],
    };
}

function buildDeterministicPreflightActions(automaticTools = [], prompt = '', toolContext = {}) {
    const availableToolIds = new Set(automaticTools.map((entry) => entry.id));
    if (availableToolIds.has(USER_CHECKPOINT_TOOL_ID) && hasExplicitUserCheckpointInteractionIntent(prompt)) {
        return [];
    }

    const remoteToolId = availableToolIds.has('remote-command')
        ? 'remote-command'
        : (availableToolIds.has('ssh-execute') ? 'ssh-execute' : null);
    const actions = [];
    const firstUrl = extractFirstUrl(prompt);
    const webQuery = availableToolIds.has('web-search')
        ? extractExplicitWebResearchQuery(prompt)
        : null;
    const scrapeUrl = availableToolIds.has('web-scrape')
        && firstUrl
        && /\b(scrape|extract|selector|structured|parse)\b/i.test(prompt)
        ? firstUrl
        : null;
    const directoryPath = availableToolIds.has('file-mkdir')
        ? extractRequestedDirectoryPath(prompt)
        : null;
    const inferredOutputFormat = inferRequestedOutputFormatForPreflight(prompt);
    const imagePrompt = availableToolIds.has('image-generate')
        && shouldPreGenerateImagesForArtifactRequestForPreflight({ text: prompt, outputFormat: inferredOutputFormat })
        ? buildImagePromptFromArtifactRequestForPreflight(prompt)
        : null;
    const sshCommand = remoteToolId
        ? extractRequestedSshCommand(prompt)
        : null;
    const sshTarget = remoteToolId
        ? extractExplicitSshTarget(prompt)
        : null;
    const podcastTopic = availableToolIds.has('podcast') && hasExplicitPodcastIntent(prompt)
        ? extractExplicitPodcastTopic(prompt)
        : null;
    const relationshipFormulaPlan = availableToolIds.has(RELATIONSHIP_CALCULATION_TOOL_ID)
        ? extractPiiRelationshipFormulaPlanRequest(prompt)
        : null;
    const relationshipWorkbookRequest = availableToolIds.has(RELATIONSHIP_CALCULATION_TOOL_ID)
        ? getPiiWorkbookRelationshipRequest({ toolContext })
        : null;

    if (podcastTopic) {
        actions.push({
            toolId: 'podcast',
            params: {
                topic: podcastTopic,
                ...(hasExplicitPodcastVideoIntent(prompt) ? inferPodcastVideoOptions(prompt) : {}),
            },
        });
    }

    if (relationshipWorkbookRequest) {
        actions.push({
            toolId: RELATIONSHIP_CALCULATION_TOOL_ID,
            params: relationshipWorkbookRequest,
        });
    } else if (relationshipFormulaPlan) {
        actions.push({
            toolId: RELATIONSHIP_CALCULATION_TOOL_ID,
            params: relationshipFormulaPlan,
        });
    }

    if (webQuery) {
        actions.push({
            toolId: 'web-search',
            params: {
                query: webQuery,
                engine: 'perplexity',
                researchMode: inferPerplexityResearchModeForPreflight(prompt),
                limit: normalizeResearchSearchResultCount(),
                region: 'ca-en',
                userLocation: {
                    country: 'CA',
                },
                timeRange: 'all',
                includeSnippets: true,
                includeUrls: true,
                ...inferExpandedResearchParamsForPreflight(prompt),
            },
        });
    }

    if (scrapeUrl) {
        actions.push({
            toolId: 'web-scrape',
            params: inferScrapeParams(prompt, scrapeUrl),
        });
    }

    if (directoryPath) {
        actions.push({
            toolId: 'file-mkdir',
            params: {
                path: directoryPath,
                recursive: true,
            },
        });
    }

    if (imagePrompt) {
        actions.push({
            toolId: 'image-generate',
            params: {
                prompt: imagePrompt,
            },
        });
    }

    if (sshCommand && promptHasExplicitSshIntent(prompt)) {
        actions.push({
            toolId: remoteToolId,
            params: {
                ...(sshTarget?.host ? { host: sshTarget.host } : {}),
                ...(sshTarget?.username ? { username: sshTarget.username } : {}),
                ...(sshTarget?.port ? { port: sshTarget.port } : {}),
                command: sshCommand,
            },
        });
    }

    return actions;
}

function normalizeResearchFollowupPageCount() {
    return Math.max(2, Math.min(config.memory.researchFollowupPages, 8));
}

function normalizeResearchSearchResultCount() {
    return Math.max(8, Math.min(config.memory.researchSearchLimit, config.search.maxLimit));
}

function stripHtmlToText(html = '') {
    return String(html || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractFetchBodyText(result = {}) {
    const body = String(result?.data?.body || '').trim();
    if (!body) {
        return '';
    }

    return /<html\b|<body\b|<article\b|<main\b|<section\b/i.test(body)
        ? stripHtmlToText(body)
        : body.replace(/\s+/g, ' ').trim();
}

function extractResearchFollowupCandidates(searchResult = {}, maxPages = normalizeResearchFollowupPageCount()) {
    const results = Array.isArray(searchResult?.data?.results) ? searchResult.data.results : [];
    const seen = new Set();

    return results
        .filter((entry) => {
            const url = String(entry?.url || '').trim();
            if (!url || seen.has(url)) {
                return false;
            }

            seen.add(url);
            return true;
        })
        .slice(0, maxPages);
}

function buildResearchMemoryNote({ query = '', candidate = {}, result = {} } = {}) {
    const sourceUrl = String(candidate?.url || result?.data?.url || '').trim();
    const title = String(candidate?.title || result?.data?.title || '').trim();
    const snippet = String(candidate?.snippet || '').replace(/\s+/g, ' ').trim();
    const textBody = result?.toolId === 'web-scrape'
        ? (
            String(result?.data?.content || result?.data?.text || '').trim()
            || stripHtmlToText(JSON.stringify(result?.data?.data || {}))
        )
        : extractFetchBodyText(result);
    const excerpt = textBody.slice(0, config.memory.researchSourceExcerptChars).trim();

    if (!sourceUrl || (!title && !snippet && !excerpt)) {
        return null;
    }

    return [
        '[Research note]',
        query ? `Query: ${query}` : null,
        title ? `Title: ${title}` : null,
        `URL: ${sourceUrl}`,
        snippet ? `Search snippet: ${snippet}` : null,
        excerpt ? `Source notes: ${excerpt}` : null,
    ].filter(Boolean).join('\n');
}

function deriveResearchSourceLabel(url = '', fallback = '') {
    const normalizedFallback = String(fallback || '').trim();
    if (normalizedFallback) {
        return normalizedFallback;
    }

    try {
        return new URL(String(url || '')).hostname.replace(/^www\./i, '');
    } catch (_error) {
        return '';
    }
}

function extractResearchSourceText(result = {}) {
    if (result?.toolId === 'web-scrape') {
        const directText = [
            result?.data?.summary,
            result?.data?.text,
            result?.data?.content,
            result?.data?.markdown,
        ].find((entry) => typeof entry === 'string' && entry.trim());

        if (directText) {
            return String(directText).replace(/\s+/g, ' ').trim();
        }

        return stripHtmlToText(JSON.stringify(result?.data?.data || {}));
    }

    return extractFetchBodyText(result);
}

function findSearchMetadataForUrl(searchResults = [], url = '') {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl || !Array.isArray(searchResults)) {
        return null;
    }

    return searchResults.find((entry) => String(entry?.url || '').trim() === normalizedUrl) || null;
}

function buildResearchDossier(toolEvents = [], {
    maxSearchResults = 12,
    maxSources = 8,
    excerptChars = config.memory.researchSourceExcerptChars,
} = {}) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const searchEvent = [...events].reverse().find((event) => (
        (event?.toolCall?.function?.name || event?.result?.toolId || '') === 'web-search'
        && event?.result?.success !== false
    ));
    const searchResults = Array.isArray(searchEvent?.result?.data?.results)
        ? searchEvent.result.data.results
        : [];
    const query = String(
        searchEvent?.result?.data?.query
        || parseToolArguments(searchEvent?.toolCall?.function?.arguments || '{}').query
        || '',
    ).trim();

    const sourceEntries = events
        .filter((event) => {
            const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
            return (toolId === 'web-fetch' || toolId === 'web-scrape') && event?.result?.success !== false;
        })
        .map((event) => {
            const result = event?.result || {};
            const data = result?.data || {};
            const url = String(data?.url || parseToolArguments(event?.toolCall?.function?.arguments || '{}').url || '').trim();
            const searchMeta = findSearchMetadataForUrl(searchResults, url);
            const sourceText = trimString(extractResearchSourceText(result), excerptChars);
            const title = String(data?.title || searchMeta?.title || '').trim();
            const snippet = String(searchMeta?.snippet || '').replace(/\s+/g, ' ').trim();
            const source = deriveResearchSourceLabel(url, searchMeta?.source || data?.source || '');

            if (!url || (!title && !snippet && !sourceText)) {
                return null;
            }

            return {
                url,
                title,
                snippet,
                source,
                sourceText,
                toolId: event?.toolCall?.function?.name || result?.toolId || '',
            };
        })
        .filter(Boolean)
        .slice(0, maxSources);

    if (!query && searchResults.length === 0 && sourceEntries.length === 0) {
        return '';
    }

    const lines = ['[Research dossier]'];
    if (query) {
        lines.push(`Query: ${query}`);
    }

    if (searchResults.length > 0) {
        lines.push('Top search results:');
        searchResults.slice(0, maxSearchResults).forEach((entry, index) => {
            const title = trimString(String(entry?.title || 'Untitled result').replace(/\s+/g, ' ').trim(), 120);
            const url = String(entry?.url || '').trim();
            const snippet = trimString(String(entry?.snippet || '').replace(/\s+/g, ' ').trim(), 240);
            const source = deriveResearchSourceLabel(url, entry?.source || '');
            lines.push([
                `${index + 1}. ${title}`,
                source ? `(${source})` : '',
                url ? `[${url}]` : '',
            ].filter(Boolean).join(' '));
            if (snippet) {
                lines.push(`   Snippet: ${snippet}`);
            }
        });
    }

    if (sourceEntries.length > 0) {
        lines.push('Verified source extracts:');
        sourceEntries.forEach((entry, index) => {
            lines.push([
                `${index + 1}. ${trimString(entry.title || entry.url, 140)}`,
                entry.source ? `(${entry.source})` : '',
                `[${entry.url}]`,
                entry.toolId ? `via ${entry.toolId}` : '',
            ].filter(Boolean).join(' '));
            if (entry.snippet) {
                lines.push(`   Search snippet: ${trimString(entry.snippet, 240)}`);
            }
            if (entry.sourceText) {
                lines.push(`   Verified extract: ${entry.sourceText}`);
            }
        });
    }

    return lines.join('\n');
}

function buildAutomaticToolSummaryMessage(toolEvents = []) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    const researchDossier = buildResearchDossier(events);

    return {
        role: 'system',
        content: [
            '[Automatic tool results]',
            'Use these verified tool results when answering. If any tool result contains an error, explain that exact error plainly instead of claiming the tool is unavailable.',
            researchDossier || '',
            '[Raw tool events]',
            JSON.stringify(events, null, 2),
        ].filter(Boolean).join('\n\n'),
    };
}

async function maybeStoreResearchMemoryNote({ toolContext = {}, query = '', candidate = {}, result = {} } = {}) {
    if (!toolContext?.memoryService?.rememberResearchNote || !toolContext?.sessionId) {
        return;
    }

    const note = buildResearchMemoryNote({ query, candidate, result });
    if (!note) {
        return;
    }

    await toolContext.memoryService.rememberResearchNote(toolContext.sessionId, note, {
        sourceUrl: String(candidate?.url || result?.data?.url || '').trim(),
        sourceTitle: String(candidate?.title || result?.data?.title || '').trim(),
        query,
        ...(toolContext.ownerId ? { ownerId: toolContext.ownerId } : {}),
        ...(toolContext.memoryScope ? { memoryScope: toolContext.memoryScope } : {}),
    });
}

async function runResearchFollowupPreflight({
    toolManager,
    searchEvent = null,
    automaticTools = [],
    toolContext = {},
}) {
    const availableToolIds = new Set((automaticTools || []).map((entry) => entry.id));
    const canFetch = availableToolIds.has('web-fetch');
    const canScrape = availableToolIds.has('web-scrape');
    const searchResult = searchEvent?.result || {};
    const query = String(searchEvent?.toolCall?.function?.arguments ? (parseToolArguments(searchEvent.toolCall.function.arguments).query || '') : '').trim();

    if ((!canFetch && !canScrape) || !searchResult?.success) {
        return [];
    }

    const followupCandidates = extractResearchFollowupCandidates(searchResult);
    const followupEvents = [];

    for (const candidate of followupCandidates) {
        let result = null;
        let toolId = null;
        let params = null;

        if (canFetch) {
            toolId = 'web-fetch';
            params = {
                url: candidate.url,
                timeout: 30000,
                cache: true,
            };
            result = await executeAutomaticToolCall(toolManager, {
                id: `research_fetch_${followupEvents.length + 1}`,
                type: 'function',
                function: {
                    name: toolId,
                    arguments: JSON.stringify(params),
                },
            }, toolContext);
        }

        if ((!result || result.success === false) && canScrape) {
            const approvedHost = deriveResearchSourceLabel(candidate.url, candidate.source || '');
            toolId = 'web-scrape';
            params = {
                url: candidate.url,
                browser: true,
                timeout: 30000,
                researchSafe: true,
                approvedDomains: approvedHost ? [approvedHost] : [],
                respectRobotsTxt: true,
            };
            result = await executeAutomaticToolCall(toolManager, {
                id: `research_scrape_${followupEvents.length + 1}`,
                type: 'function',
                function: {
                    name: toolId,
                    arguments: JSON.stringify(params),
                },
            }, toolContext);
        }

        if (!result || !toolId || !params) {
            continue;
        }

        const event = {
            toolCall: normalizeToolCall({
                id: `${toolId}_${followupEvents.length + 1}`,
                type: 'function',
                function: {
                    name: toolId,
                    arguments: JSON.stringify(params),
                },
            }),
            reason: 'Deterministic research follow-up on a top search result.',
            result,
        };
        followupEvents.push(event);

        if (result.success) {
            await maybeStoreResearchMemoryNote({
                toolContext,
                query,
                candidate,
                result,
            });
        }
    }

    return followupEvents;
}

function sanitizeToolSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }

    if (Array.isArray(schema)) {
        return schema.map((entry) => sanitizeToolSchema(entry));
    }

    const sanitized = {};
    const allowedKeys = [
        'type',
        'description',
        'enum',
        'default',
        'format',
        'pattern',
        'required',
        'properties',
        'items',
        'additionalProperties',
        'maximum',
        'minimum',
        'maxLength',
        'minLength',
    ];

    for (const key of allowedKeys) {
        if (schema[key] === undefined) {
            continue;
        }

        if (key === 'type' && Array.isArray(schema.type)) {
            sanitized.type = schema.type.find((entry) => entry !== 'null') || schema.type[0];
            continue;
        }

        if (key === 'properties' && schema.properties && typeof schema.properties === 'object') {
            sanitized.properties = Object.fromEntries(
                Object.entries(schema.properties).map(([propertyName, propertySchema]) => [
                    propertyName,
                    sanitizeToolSchema(propertySchema),
                ]),
            );
            continue;
        }

        if (key === 'items') {
            sanitized.items = sanitizeToolSchema(schema.items);
            continue;
        }

        if (key === 'additionalProperties' && typeof schema.additionalProperties === 'object') {
            sanitized.additionalProperties = sanitizeToolSchema(schema.additionalProperties);
            continue;
        }

        sanitized[key] = schema[key];
    }

    if (!sanitized.type && sanitized.properties) {
        sanitized.type = 'object';
    }

    if (sanitized.type === 'object'
        && sanitized.properties
        && sanitized.additionalProperties === undefined) {
        sanitized.additionalProperties = false;
    }

    return sanitized;
}

function normalizeToolTriggerPattern(pattern = '') {
    return String(pattern || '')
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ');
}

function buildAutomaticToolDescription(toolId, tool = {}, skill = null) {
    const baseDescription = String(tool?.description || tool?.name || toolId || '')
        .replace(/\s+/g, ' ')
        .trim();
    const triggerPatterns = Array.from(new Set(
        (Array.isArray(skill?.triggerPatterns) ? skill.triggerPatterns : [])
            .map((pattern) => normalizeToolTriggerPattern(pattern))
            .filter(Boolean),
    )).slice(0, 4);
    const guidance = [];

    if (triggerPatterns.length) {
        guidance.push(`Use when the request mentions ${triggerPatterns.map((pattern) => `"${pattern}"`).join(', ')}.`);
    }

    if (skill?.requiresConfirmation === true) {
        guidance.push('Confirm before destructive or state-changing use unless the user already explicitly requested that exact action.');
    }

    return [baseDescription, ...guidance].filter(Boolean).join(' ').trim() || toolId;
}

function buildAutomaticToolDefinitions(toolManager, prompt = '', options = {}) {
    if (!toolManager?.registry) {
        return [];
    }

    const executionProfile = normalizeExecutionProfile(
        options?.executionProfile
        || options?.toolContext?.executionProfile,
    );
    const allowedToolIds = new Set(getAllowedToolIdsForProfile(executionProfile));
    const hasRemoteCommandAlias = Boolean(toolManager.getTool('remote-command'));
    const shouldPreferRemoteCommandAlias = hasRemoteCommandAlias && hasUsableSshDefaults();

    return Array.from(AUTO_TOOL_ALLOWLIST)
        .filter((toolId) => allowedToolIds.has(toolId))
        .filter((toolId) => !(toolId === 'ssh-execute' && shouldPreferRemoteCommandAlias))
        .map((toolId) => {
            const tool = toolManager.getTool(toolId);
            const skill = toolManager.registry.getSkill(toolId);
            const available = tool && (!skill || skill.enabled !== false);

            if (!available || !shouldAutoUseTool(toolId, prompt, skill, options)) {
                return null;
            }

            const description = buildAutomaticToolDescription(toolId, tool, skill);
            const parameters = sanitizeToolSchema(tool.inputSchema);

            return {
                id: toolId,
                skill,
                description,
                parameters,
                definition: {
                    type: 'function',
                    function: {
                        name: toolId,
                        description,
                        parameters,
                    },
                },
                chatDefinition: {
                    type: 'function',
                    function: {
                        name: toolId,
                        description,
                        parameters,
                    },
                },
                responseDefinition: {
                    type: 'function',
                    name: toolId,
                    description,
                    parameters,
                    strict: true,
                },
            };
        })
        .filter(Boolean);
}

function selectAutomaticToolDefinitions(automaticTools = [], prompt = '', options = {}) {
    if (!automaticTools.length) {
        return [];
    }

    const executionProfile = normalizeExecutionProfile(
        options?.executionProfile
        || options?.toolContext?.executionProfile,
    );
    const sessionIsolation = isSessionIsolationEnabled({
        sessionIsolation: options?.toolContext?.sessionIsolation,
    });
    const availableToolIds = new Set(automaticTools.map((entry) => entry.id));
    const selectedIds = new Set();
    const hasPiiFormulaPlanIntent = Boolean(extractPiiRelationshipFormulaPlanRequest(prompt))
        || Boolean(getPiiWorkbookRelationshipRequest(options));
    const normalizedPrompt = String(prompt || '').toLowerCase();
    const hasUrl = /https?:\/\//i.test(normalizedPrompt);
    const hasExplicitScrapeIntent = /\b(scrape|extract|selector|structured|parse)\b/i.test(normalizedPrompt);
    const hasWebResearchIntent = Boolean(
        hasExplicitWebResearchIntent(prompt)
        || /\b(latest|current|today|news|look up|search for|search the web|browse)\b/i.test(normalizedPrompt)
    );
    const hasExplicitImageGenerationRequest = hasExplicitImageGenerationIntent(prompt);
    const hasImageIntent = /\b(image|images|visual|visuals|illustration|illustrations|photo|photos|hero image|background image|cover image)\b/i.test(normalizedPrompt);
    const hasUnsplashIntent = /\bunsplash\b/i.test(normalizedPrompt);
    const hasDirectImageUrl = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?/i.test(normalizedPrompt);
    const hasVerifiedImagePreference = hasUnsplashIntent
        || hasDirectImageUrl
        || /\b(real images?|real photos?|stock|reference)\b/i.test(normalizedPrompt);
    const hasArchitectureIntent = /\b(architecture|system design|service diagram|deployment diagram|architecture diagram|design the system)\b/i.test(normalizedPrompt);
    const hasUmlIntent = /\b(uml|class diagram|sequence diagram|activity diagram|use ?case diagram|state diagram|component diagram)\b/i.test(normalizedPrompt);
    const hasApiDesignIntent = /\b(api design|design api|openapi|swagger|graphql schema|rest api|grpc)\b/i.test(normalizedPrompt);
    const hasSchemaIntent = /\b(database schema|design database|generate ddl|ddl\b|er diagram|entity relationship|orm schema)\b/i.test(normalizedPrompt);
    const hasMigrationIntent = /\b(create migration|generate migration|schema migration|database change|schema diff|migration)\b/i.test(normalizedPrompt);
    const hasPodcastIntent = hasExplicitPodcastIntent(prompt);
    const hasDocumentWorkflowIntent = (
        /\b(document|doc|report|brief|proposal|guide|manual|training|workbook|curriculum|lesson plan|job aid|summary|one-pager|whitepaper|slides|presentation|deck|pptx|docx|pdf|xlsx|html page|html document|web page)\b/i.test(normalizedPrompt)
        && /\b(create|make|generate|build|prepare|draft|write|assemble|compile|organize|inject|turn|convert|export)\b/i.test(normalizedPrompt)
    ) || (
        /\b(slides|presentation|deck|pptx|docx|pdf|xlsx|html document|research brief|training manual|learner guide|workbook)\b/i.test(normalizedPrompt)
        && (hasWebResearchIntent || hasExplicitScrapeIntent || hasUrl)
    );
    const hasDeepResearchDeckIntent = hasDeepResearchPresentationIntent(prompt);
    const hasResearchDocumentIntent = hasDocumentWorkflowIntent
        && (
            hasWebResearchIntent
            || /\b(news|headline|headlines|article|articles|coverage|timeline|analysis|newsletter|current events?)\b/i.test(normalizedPrompt)
        );
    const hasSubAgentIntent = hasExplicitSubAgentIntent(prompt);
    const canonicalWorkload = buildCanonicalWorkloadAction({
        request: prompt,
    }, {
        recentMessages: options?.recentMessages || options?.toolContext?.recentMessages || [],
        timezone: options?.timezone || options?.toolContext?.timezone || null,
        now: options?.now || options?.toolContext?.now || null,
    });
    const hasWorkloadSetupIntent = hasWorkloadIntent(prompt)
        || canonicalWorkload?.trigger?.type === 'cron'
        || canonicalWorkload?.trigger?.type === 'once';
    const hasAssetCatalogIntent = hasIndexedAssetIntent(prompt);
    const hasResearchBucketCatalogIntent = hasResearchBucketIntent(prompt);
    const hasPublicSourceCatalogIntent = hasPublicSourceIndexIntent(prompt);
    const remoteToolId = availableToolIds.has('remote-command')
        ? 'remote-command'
        : (availableToolIds.has('ssh-execute') ? 'ssh-execute' : null);
    const remoteCliAgentToolId = availableToolIds.has('remote-cli-agent') ? 'remote-cli-agent' : null;
    const explicitLocalArtifact = hasExplicitLocalArtifactReference(prompt);
    const remoteWebsiteUpdateIntent = hasRemoteWebsiteUpdateIntent(prompt);
    const remoteSoftwareCreationIntent = executionProfile === 'remote-build'
        && hasRemoteSoftwareCreationIntent(prompt);
    const remoteSoftwareDeploymentIntent = executionProfile === 'remote-build'
        && hasRemoteSoftwareDeploymentIntent(prompt);
    const metadata = getToolContextMetadata(options);
    const stickyRemoteBuildContinuationIntent = executionProfile === 'remote-build'
        && (
            metadata.stickyRemoteContext === true
            || metadata.remoteBuildContinuation === true
            || Boolean(metadata.lastRemoteObjective)
        )
        && hasRemoteBuildAuthoringContinuationIntent(prompt);
    const managedAppIntent = shouldPreferManagedAppForRemoteBuild(prompt, options);
    const shouldSuppressDocumentWorkflowForRemoteDeploy = remoteSoftwareCreationIntent
        || remoteSoftwareDeploymentIntent
        || managedAppIntent;
    const internalArtifactReference = hasInternalArtifactReference(prompt);
    const shouldPreferRemoteWorkspaceSource = Boolean(
        remoteToolId
        && !explicitLocalArtifact
        && (remoteWebsiteUpdateIntent || remoteSoftwareCreationIntent),
    );
    const shouldSuppressWebFetchForRemoteWebsite = shouldPreferRemoteWorkspaceSource
        && remoteWebsiteUpdateIntent
        && internalArtifactReference;
    const checkpointPolicy = options?.userCheckpointPolicy || options?.toolContext?.userCheckpointPolicy || {};
    const isSurveyResponseTurn = Boolean(parseUserCheckpointResponseMessage(prompt));
    const shouldOfferUserCheckpoint = availableToolIds.has(USER_CHECKPOINT_TOOL_ID)
        && checkpointPolicy.enabled === true
        && Number(checkpointPolicy.remaining || 0) > 0
        && !checkpointPolicy.pending
        && !isSurveyResponseTurn;

    if (hasWorkloadSetupIntent && availableToolIds.has('agent-workload')) {
        selectedIds.add('agent-workload');
    }

    if (hasSubAgentIntent && availableToolIds.has('agent-delegate')) {
        selectedIds.add('agent-delegate');
    }

    if (hasPodcastIntent && availableToolIds.has('podcast')) {
        selectedIds.add('podcast');
    }

    if (hasDeepResearchDeckIntent && availableToolIds.has(DEEP_RESEARCH_PRESENTATION_TOOL_ID)) {
        selectedIds.add(DEEP_RESEARCH_PRESENTATION_TOOL_ID);
    }

    if (hasDocumentWorkflowIntent
        && !hasPiiFormulaPlanIntent
        && !shouldSuppressDocumentWorkflowForRemoteDeploy
        && availableToolIds.has(DOCUMENT_WORKFLOW_TOOL_ID)) {
        selectedIds.add(DOCUMENT_WORKFLOW_TOOL_ID);
    }

    if (availableToolIds.has(RELATIONSHIP_CALCULATION_TOOL_ID)
        && (hasPiiFormulaPlanIntent || hasPiiRelationshipCalculationIntent(prompt, options))) {
        selectedIds.add(RELATIONSHIP_CALCULATION_TOOL_ID);
    }

    if (shouldOfferUserCheckpoint) {
        selectedIds.add(USER_CHECKPOINT_TOOL_ID);
    }

    if (hasWebResearchIntent) {
        selectedIds.add('web-search');
    }

    if (hasResearchDocumentIntent) {
        selectedIds.add('web-fetch');
    }

    if (hasExplicitScrapeIntent) {
        selectedIds.add('web-search');
        selectedIds.add('web-scrape');
    }

    if (hasUrl) {
        if (shouldSuppressWebFetchForRemoteWebsite) {
            // Keep website replacement flows on the remote SSH path instead of fetching
            // backend-local artifact links as if they were public internet URLs.
        } else if (hasExplicitScrapeIntent) {
            selectedIds.add('web-scrape');
        } else {
            selectedIds.add('web-fetch');
        }
    }

    if (hasExplicitImageGenerationRequest && !hasVerifiedImagePreference) {
        selectedIds.add('image-generate');
    }

    if (hasUnsplashIntent || (hasImageIntent && /\b(search|find|browse|reference|stock)\b/i.test(normalizedPrompt))) {
        selectedIds.add('image-search-unsplash');
    }

    if (hasResearchDocumentIntent && availableToolIds.has('image-search-unsplash')) {
        selectedIds.add('image-search-unsplash');
    }

    if ((hasImageIntent && /\b(url|link|embed|use this)\b/i.test(normalizedPrompt)) || hasDirectImageUrl) {
        selectedIds.add('image-from-url');
    }

    if (hasAssetCatalogIntent && availableToolIds.has('asset-search')) {
        selectedIds.add('asset-search');
    }

    if (hasResearchBucketCatalogIntent) {
        if (availableToolIds.has('research-bucket-list')) {
            selectedIds.add('research-bucket-list');
        }
        if (availableToolIds.has('research-bucket-search')) {
            selectedIds.add('research-bucket-search');
        }
        if (availableToolIds.has('research-bucket-read')) {
            selectedIds.add('research-bucket-read');
        }
        if (/\b(write|save|add|store|capture|create|update|append)\b/i.test(normalizedPrompt)
            && availableToolIds.has('research-bucket-write')) {
            selectedIds.add('research-bucket-write');
        }
        if (/\b(mkdir|folder|directory)\b/i.test(normalizedPrompt)
            && availableToolIds.has('research-bucket-mkdir')) {
            selectedIds.add('research-bucket-mkdir');
        }
    }

    if (hasPublicSourceCatalogIntent) {
        ['public-source-list', 'public-source-search', 'public-source-get'].forEach((toolId) => {
            if (availableToolIds.has(toolId)) {
                selectedIds.add(toolId);
            }
        });
        if (/\b(add|save|store|index|catalog|catalogue|create|update)\b/i.test(normalizedPrompt)
            && availableToolIds.has('public-source-add')) {
            selectedIds.add('public-source-add');
        }
        if (/\b(refresh|verify|check|validate|probe)\b/i.test(normalizedPrompt)
            && availableToolIds.has('public-source-refresh')) {
            selectedIds.add('public-source-refresh');
        }
    }

    if (!shouldPreferRemoteWorkspaceSource && extractRequestedDirectoryPath(prompt)) {
        selectedIds.add('file-mkdir');
    }

    if (!shouldPreferRemoteWorkspaceSource && /\b(read|open|show|print|cat)\b[\s\S]{0,40}\bfile\b/i.test(normalizedPrompt)) {
        selectedIds.add('file-read');
    }

    if (!shouldPreferRemoteWorkspaceSource && /\b(write|save|create|update|edit)\b[\s\S]{0,40}\bfile\b/i.test(normalizedPrompt)) {
        selectedIds.add('file-write');
    }

    if (!shouldPreferRemoteWorkspaceSource && /\b(find|search|locate|list)\b[\s\S]{0,40}\bfiles?\b/i.test(normalizedPrompt)) {
        selectedIds.add('file-search');
    }

    if (!sessionIsolation && availableToolIds.has('agent-notes-write') && isAgentNotesAutoWriteEnabled()) {
        selectedIds.add('agent-notes-write');
    }

    if (availableToolIds.has(SELF_REFLECTION_UPDATE_TOOL_ID) && hasSelfReflectionUpdateIntentText(prompt)) {
        selectedIds.add(SELF_REFLECTION_UPDATE_TOOL_ID);
    }

    if (availableToolIds.has('managed-app') && managedAppIntent) {
        selectedIds.add('managed-app');
    }

    if (remoteCliAgentToolId && (remoteSoftwareDeploymentIntent || stickyRemoteBuildContinuationIntent) && !managedAppIntent) {
        selectedIds.add(remoteCliAgentToolId);
    }

    if (remoteToolId && (promptHasExplicitSshIntent(prompt) || (shouldPreferRemoteWorkspaceSource && !remoteSoftwareDeploymentIntent))) {
        selectedIds.add(remoteToolId);
    }

    if (hasExplicitK3sDeployIntent(prompt) && !remoteSoftwareDeploymentIntent) {
        selectedIds.add('k3s-deploy');
    }

    if (hasExplicitGitIntent(prompt)) {
        selectedIds.add('git-safe');
    }

    if (availableToolIds.has('docker-exec') && /\b(docker|container)\b/i.test(normalizedPrompt)) {
        selectedIds.add('docker-exec');
    }

    if (!shouldPreferRemoteWorkspaceSource && hasExplicitLocalSandboxIntent(normalizedPrompt)) {
        selectedIds.add('code-sandbox');
    }

    if (/\b(security|vulnerab|audit|scan|secret)\b/i.test(normalizedPrompt)) {
        selectedIds.add('security-scan');
    }

    if (hasArchitectureIntent) {
        selectedIds.add('architecture-design');
    }

    if (hasUmlIntent) {
        selectedIds.add('uml-generate');
    }

    if (hasApiDesignIntent) {
        selectedIds.add('api-design');
    }

    if (hasSchemaIntent) {
        selectedIds.add('schema-generate');
    }

    if (hasMigrationIntent) {
        selectedIds.add('migration-create');
    }

    if (/\btool\b[\s\S]{0,40}\b(help|doc|docs|documentation|how)\b/i.test(normalizedPrompt)
        || /\bhow do i use\b[\s\S]{0,40}\btool\b/i.test(normalizedPrompt)) {
        selectedIds.add('tool-doc-read');
    }

    if (selectedIds.size === 0) {
        automaticTools.forEach((entry) => {
            const triggerPatterns = entry.skill?.triggerPatterns || [];
            if (triggerPatterns.some((pattern) => promptMentionsPattern(prompt, pattern))) {
                selectedIds.add(entry.id);
            }
        });
    }

    return automaticTools.filter((entry) => selectedIds.has(entry.id));
}

function inferRequiredAutomaticToolId(prompt = '', availableToolIdsInput = [], options = {}) {
    const availableToolIds = new Set(Array.isArray(availableToolIdsInput) ? availableToolIdsInput : []);
    const remoteToolId = availableToolIds.has('remote-command')
        ? 'remote-command'
        : (availableToolIds.has('ssh-execute') ? 'ssh-execute' : null);
    const remoteCliAgentToolId = availableToolIds.has('remote-cli-agent') ? 'remote-cli-agent' : null;
    const explicitK3sDeployIntent = hasExplicitK3sDeployIntent(prompt);
    const explicitGitIntent = hasExplicitGitIntent(prompt);
    const explicitSubAgentIntent = hasExplicitSubAgentIntent(prompt);
    const isDeferredWorkloadRun = options?.workloadRun === true
        || options?.clientSurface === 'workload'
        || options?.toolContext?.workloadRun === true
        || options?.toolContext?.clientSurface === 'workload';
    const subAgentDepth = Number(
        options?.subAgentDepth
        || options?.toolContext?.subAgentDepth
        || 0,
    );
    const canonicalWorkload = buildCanonicalWorkloadAction({
        request: prompt,
    }, {
        recentMessages: options?.recentMessages || options?.toolContext?.recentMessages || [],
        timezone: options?.timezone || options?.toolContext?.timezone || null,
        now: options?.now || options?.toolContext?.now || null,
    });

    if (explicitK3sDeployIntent && explicitGitIntent) {
        return null;
    }

    if (availableToolIds.has(RELATIONSHIP_CALCULATION_TOOL_ID)
        && extractPiiRelationshipFormulaPlanRequest(prompt)) {
        return RELATIONSHIP_CALCULATION_TOOL_ID;
    }

    const checkpointPolicy = options?.userCheckpointPolicy || options?.toolContext?.userCheckpointPolicy || {};
    if (availableToolIds.has(USER_CHECKPOINT_TOOL_ID)
        && checkpointPolicy.enabled === true
        && Number(checkpointPolicy.remaining || 0) > 0
        && !checkpointPolicy.pending
        && (
            hasExplicitQuestionnaireToolTestIntent(prompt)
            || hasExplicitUserCheckpointInteractionIntent(prompt)
        )) {
        return USER_CHECKPOINT_TOOL_ID;
    }

    if (subAgentDepth < 1
        && availableToolIds.has('agent-delegate')
        && explicitSubAgentIntent) {
        return 'agent-delegate';
    }

    if (!isDeferredWorkloadRun
        && availableToolIds.has('agent-workload')
        && (
            hasWorkloadIntent(prompt)
            || canonicalWorkload?.trigger?.type === 'cron'
            || canonicalWorkload?.trigger?.type === 'once'
        )) {
        return 'agent-workload';
    }

    if (remoteCliAgentToolId
        && (
            hasRemoteSoftwareDeploymentIntent(prompt)
            || (
                normalizeExecutionProfile(options?.executionProfile || options?.toolContext?.executionProfile) === 'remote-build'
                && (
                    getToolContextMetadata(options).stickyRemoteContext === true
                    || getToolContextMetadata(options).remoteBuildContinuation === true
                    || Boolean(getToolContextMetadata(options).lastRemoteObjective)
                )
                && hasRemoteBuildAuthoringContinuationIntent(prompt)
            )
        )
        && !(availableToolIds.has('managed-app') && shouldPreferManagedAppForRemoteBuild(prompt, options))) {
        return remoteCliAgentToolId;
    }

    if (explicitK3sDeployIntent && availableToolIds.has('k3s-deploy')) {
        return 'k3s-deploy';
    }

    if (explicitGitIntent && availableToolIds.has('git-safe')) {
        return 'git-safe';
    }

    if (remoteToolId
        && hasRemoteWebsiteUpdateIntent(prompt)
        && !hasExplicitLocalArtifactReference(prompt)) {
        return remoteToolId;
    }

    if (remoteToolId && promptHasExplicitSshIntent(prompt)) {
        return remoteToolId;
    }

    if (availableToolIds.has(DEEP_RESEARCH_PRESENTATION_TOOL_ID)
        && hasDeepResearchPresentationIntent(prompt)) {
        return DEEP_RESEARCH_PRESENTATION_TOOL_ID;
    }

    if (availableToolIds.has('podcast') && hasExplicitPodcastIntent(prompt)) {
        return 'podcast';
    }

    if (availableToolIds.has('image-generate')
        && hasStandaloneImageGenerationRequest(prompt)) {
        return 'image-generate';
    }

    if (hasExplicitWebResearchIntent(prompt)) {
        return 'web-search';
    }

    if (extractFirstUrl(prompt) && /\b(scrape|extract|selector|structured|parse)\b/i.test(prompt)) {
        return 'web-scrape';
    }

    if (extractRequestedDirectoryPath(prompt)) {
        return 'file-mkdir';
    }

    return null;
}

function hasStandaloneImageGenerationRequest(prompt = '') {
    const normalized = String(prompt || '').toLowerCase();
    if (!hasExplicitImageGenerationIntent(prompt)) {
        return false;
    }

    return !/\b(website|web site|webpage|web page|landing page|homepage|home page|site|html|pdf|docx|word document|document|report|brief|deck|slide deck|presentation|pptx|app|dashboard|article|brochure|artifact|file|sandbox|page)\b/.test(normalized);
}

function buildForcedToolChoice(toolId, api = 'responses') {
    return api === 'chat'
        ? {
            type: 'function',
            function: {
                name: toolId,
            },
        }
        : {
            type: 'function',
            name: toolId,
        };
}

function buildAutomaticToolChoice(selectedTools = [], api = 'responses', options = {}) {
    if (!selectedTools.length) {
        return 'none';
    }

    const prompt = String(options.prompt || '');
    const requiredToolId = inferRequiredAutomaticToolId(prompt, selectedTools.map((tool) => tool.id), options);
    if (requiredToolId && selectedTools.some((tool) => tool.id === requiredToolId)) {
        return buildForcedToolChoice(requiredToolId, api);
    }

    if (selectedTools.length === 1) {
        return buildForcedToolChoice(selectedTools[0].id, api);
    }

    return 'auto';
}

function buildAutomaticToolGuidance(automaticTools = [], options = {}) {
    if (!automaticTools.length) {
        return null;
    }

    const executionProfile = normalizeExecutionProfile(
        options?.executionProfile
        || options?.toolContext?.executionProfile,
    );
    const sessionIsolation = isSessionIsolationEnabled({
        sessionIsolation: options?.toolContext?.sessionIsolation,
    });
    const guidance = [
        'You can use the provided tools whenever they will improve accuracy or gather missing data.',
        'Treat the tool definitions attached to this request as the source of truth for tool availability.',
        'Do not claim tools are unavailable because of absent meta variables or guessed config names when the tool definitions are attached to the request.',
        'Treat the local CLI environment, workspace state, filesystem contents, and shell behavior as unknown until a relevant tool verifies them.',
        'Do not comment on local environment health, startup state, writable paths, repository cleanliness, or command availability unless a tool result directly supports it.',
    ];

    if (sessionIsolation) {
        guidance.push('- This session is isolated. Prefer the current session transcript, memories, and artifacts, and do not cross into other chats unless the user explicitly asks.');
    }

    if (automaticTools.some((entry) => entry.skill?.requiresConfirmation === true)) {
        guidance.push('For tools that change remote state, local files, deployments, or other persistent state, confirm the action first unless the user already requested that exact change.');
    }

    if (automaticTools.some((entry) => entry.id === 'web-search')) {
        guidance.push('- Use `web-search` for finding current or relevant pages before answering.');
        guidance.push('- When the user explicitly asks for research, call `web-search` first. This backend routes it through the configured Perplexity provider.');
        guidance.push('- Treat strong `web-search` results as approved candidate sources for routine research, best-practice lookups, and news gathering. Do not stop to ask the user to pre-approve normal public domains unless they explicitly want a specific source list.');
        guidance.push('- For URL discovery, scraping prep, Playwright candidate pages, and routine public research, use `web-search` with `researchMode: "search"` first. It uses Perplexity raw Search without an LLM pass.');
        guidance.push('- For a one-shot grounded answer with citations, use `web-search` with `researchMode: "sonar"` or `"sonar-pro"`; use `"sonar-pro"` for complex comparisons.');
        guidance.push('- For image URL hotlisting, use `web-search` with `researchMode: "sonar"`, `returnImages: true`, and optional `imageDomains` / `imageFormats` filters. Use `returnVideos: true` only when videos materially help.');
        guidance.push('- For autonomous one-call research that should plan, search, and fetch itself, use `researchMode: "pro-search"`; prefer this middle tier for daily news, article roundups, source-backed briefings, and gathered research data where snippets/headlines are too thin but full deep research is not justified.');
        guidance.push('- For explicit long-form deep research use `researchMode: "sonar-deep-research"` and keep it reserved for requests that justify the extra cost.');
        guidance.push('- For research-backed slides, reports, and deep-research work, use Perplexity-backed `web-search` to discover candidate source URLs yourself. Choose the strongest sites yourself, verify them with `web-fetch` first, and only use `web-scrape` when a page needs rendered or structured extraction instead of asking the user which websites to scrape.');
        guidance.push('- Use `domains` on `web-search` when the user wants official docs, a known publisher family, or a tighter authoritative source set.');
        guidance.push('- For explicit research requests, do not stop at search snippets. Verify the strongest search results with `web-fetch` first and only escalate to `web-scrape` when simple retrieval is insufficient.');
        guidance.push('- For deep research, prefer the dedicated Perplexity deep-research mode over manually chaining many small search/fetch passes, but do not use it for short factual lookups.');
    }

    if (automaticTools.some((entry) => entry.id === 'web-fetch')) {
        guidance.push('- Use `web-fetch` for simple static page retrieval when you only need raw content from a URL.');
    }

    if (automaticTools.some((entry) => entry.id === 'web-scrape')) {
        guidance.push('- Use `web-scrape` when the user asks to extract fields from a page. Set `browser: true` or `javascript: true` for dynamic sites, certificate/TLS issues, or rendered DOM content. Use `selectors` to pull structured fields and `waitForSelector` when a page must finish rendering. For screenshot-only QA, omit `selectors`; when needed, `selectors` must be an object keyed by field name, not an array.');
        guidance.push('- Do not default to `web-scrape` for ordinary research verification when `web-fetch` can read the page directly.');
        guidance.push('- For search-follow-up research, use `researchSafe: true` and set `approvedDomains` from the chosen result host so the backend can skip pages that are outside the approved set or explicitly disallow bots.');
        guidance.push('- When the user wants page images from sensitive or adult sites without exposing the model to the content, use `web-scrape` with `captureImages: true` and `blindImageCapture: true` so the backend stores binary artifacts and returns only safe metadata.');
    }

    if (automaticTools.some((entry) => entry.id === 'image-generate')) {
        guidance.push('- Use `image-generate` only when the user explicitly wants new generated artwork or synthetic visuals that direct URLs, prior artifacts, or Unsplash cannot satisfy. It is available for website builds, HTML artifacts, PDF/PPTX/document visuals, and custom hero/product/illustration assets.');
        guidance.push('- Treat `image-generate` as a slower build step: call it before composing the website/document that needs the visual, wait for the tool result, and check `success`, `usableCount`, `artifacts`/`artifactIds`, or `markdownImages` before continuing. If no reusable image artifact is returned, surface the diagnostic summary instead of embedding placeholders or stale links.');
        guidance.push('- Default `image-generate` to one image. When the user asks for image options, website/document design variants, or a research-paper-style visual set, request multiple selectable outputs and keep image batches to 5 or fewer.');
        guidance.push('- For multiple versions of the same image, use `n` with `batchMode: "auto"` so the router can use one OpenAI-compatible image request. For distinct prompt variants, pass `prompts[]` with `batchMode: "parallel"` so the router can run bounded parallel calls.');
        guidance.push('- Use GPT Image defaults with `size: "auto"`, `quality: "auto"`, and `background: "auto"` unless the user or target layout requires a specific format. Write each prompt for one image, not a collage, contact sheet, storyboard, or multi-panel layout unless the user explicitly wants that composition.');
    }

    if (automaticTools.some((entry) => entry.id === 'image-search-unsplash')) {
        guidance.push('- Use `image-search-unsplash` to find reference or stock images with attribution when the user asks for visuals, photography, or inspiration. For document creation, gather up to 20 relevant Unsplash images when the user wants real-image coverage.');
    }

    if (automaticTools.some((entry) => entry.id === 'image-from-url')) {
        guidance.push('- Use `image-from-url` when the user provides or requests a direct image URL to embed in the answer. It can verify and normalize batches of up to 20 direct image URLs so the session can reuse them later.');
    }

    if (automaticTools.some((entry) => ['image-generate', 'image-search-unsplash', 'image-from-url'].includes(entry.id))) {
        guidance.push('- When verified image URLs are available from tools, embed those directly with markdown image syntax instead of fabricating SVG placeholders, overlays, or HTML mockups.');
        guidance.push('- For HTML and PDF document requests that call for real images, prefer `image-search-unsplash` and `image-from-url` over `image-generate`, save the verified references, and reuse them throughout the document when the user asks for visuals.');
        guidance.push('- For HTML, website, or document requests that call for generated imagery, materialize the `image-generate` artifacts first and feed the saved image URLs into the artifact/document build rather than asking the document builder to imagine images later.');
        guidance.push('- For research-backed reports, news pages, and current-events documents, gather grounded sources with `web-search` and `web-fetch`, then source real visuals with `image-search-unsplash` or `image-from-url` before composing the document.');
    }

    if (automaticTools.some((entry) => entry.id === DEEP_RESEARCH_PRESENTATION_TOOL_ID)) {
        guidance.push('- Use `deep-research-presentation` when the user wants a research-backed slide deck or presentation built in one ordered workflow.');
        guidance.push('- `deep-research-presentation` should handle the sequence itself: plan first, then multiple research passes, then verified image sourcing, then final deck generation.');
        guidance.push('- `deep-research-presentation` should not stop to ask the user for a public source list during normal research. It should discover source URLs through Perplexity search passes, choose the strongest candidates itself, verify them with `web-fetch` first, and only scrape when a page needs rendered or structured extraction.');
        guidance.push('- Prefer `deep-research-presentation` over manually chaining `web-search`, `image-search-unsplash`, and `document-workflow` when the user explicitly asks for deep research plus a presentation deliverable.');
    }

    if (automaticTools.some((entry) => entry.id === DOCUMENT_WORKFLOW_TOOL_ID)) {
        guidance.push('- Use `document-workflow` for training/manual deliverables such as manuals, learner guides, facilitator guides, job aids, workbooks, HTML training pages, and multi-format PDF/HTML/XLSX packages.');
        guidance.push('- Do not ask the user for generic "make it high quality" document prompt wording; `document-workflow` automatically applies strategy, background design, evidence, accessibility, and final polish quality passes.');
        guidance.push('- For training/manual packages, prefer documentType `training-manual`, action `plan` before generation when the request is broad, and action `generate-suite` when the user asks for multiple outputs such as PDF, XLSX, and HTML together.');
        guidance.push('- Training/manual work should ask for high-impact design choices when audience, delivery mode, format mix, duration, visual style, assessment depth, or research scope is unclear. Keep intake concise and then proceed.');
        guidance.push('- When the training subject depends on facts, procedures, standards, or current guidance, ground the package in vector memory and verified research before generating final materials.');
        guidance.push('- When the user explicitly asks for parallel workers or multiple agents on a training package, split work by output surface or package part: manual, workbook, HTML, podcast script, video-podcast storyboard, source research, and QA.');
    }

    if (automaticTools.some((entry) => entry.id === RELATIONSHIP_CALCULATION_TOOL_ID)) {
        guidance.push('- Privacy-aware spreadsheet calculation mode is active. For grouping, joining, summing, ranking, or comparing PII-bearing table rows, call `pii-relationship-calculate` instead of correlating placeholders yourself.');
        guidance.push('- Build the relationship calculation request with table ids, row ids, column ids, placeholder cells, numeric measure columns, filters, and supported operations only. Do not include raw private values.');
        guidance.push('- When the user asks for multiple spreadsheet calculations, request operation `batch` with an `operations` array so one trusted table payload can produce multiple safe numeric/formula results.');
        guidance.push('- If the user wants an XLSX/workbook to compute a private winner without exposing the winner to the model, request operation `xlsx_formula_plan`; return the formula plan, not a winner placeholder or ranked result.');
        guidance.push('- Treat placeholder identity as unknowable. The trusted PII vault layer handles private grouping and trusted-view restoration; your answer should preserve returned placeholders exactly where private labels belong.');
    }

    if (automaticTools.some((entry) => entry.id === 'asset-search')) {
        guidance.push(sessionIsolation
            ? '- Use `asset-search` only for current-session assets unless the user explicitly asks to search across sessions.'
            : '- Use `asset-search` to find earlier images, PDFs, documents, uploaded artifacts, and workspace files before asking the user to resend them.');
        guidance.push('- Prefer `asset-search kind:"image"` for prior visuals and `asset-search kind:"document"` for PDFs, docs, HTML, markdown, and similar files.');
        guidance.push('- Set `includeContent: true` when you need the stored text preview from a document match, and use `refresh: true` when a very recent local file is missing from the index.');
    }

    if (automaticTools.some((entry) => String(entry.id || '').startsWith('research-bucket-'))) {
        guidance.push('- Use the `research-bucket-*` tools for the shared durable research bucket when the user mentions a research bucket, reference bucket, source library, saved research, project references, or reusable web-project assets.');
        guidance.push('- Treat the research bucket as callable storage, not memory. List or search first, then read only the specific files needed for the current turn.');
        guidance.push('- Use `research-bucket-list` for metadata, `research-bucket-search` for grep-style lookup, `research-bucket-read` for selected files, and `research-bucket-write` or `research-bucket-mkdir` only when the user wants bucket contents created or updated.');
        guidance.push('- Prefer bucket paths and metadata over copying large bucket contents into the conversation. Normal compaction still applies.');
    }

    if (automaticTools.some((entry) => String(entry.id || '').startsWith('public-source-'))) {
        guidance.push('- Use the `public-source-*` tools for durable public API, dashboard, RSS, news-feed, open-data, and public endpoint catalogs.');
        guidance.push('- Search or list the public source index before doing fresh discovery when the user asks about known public data/API/feed sources.');
        guidance.push('- Use `public-source-add` to save reusable public sources discovered through `web-search` and verified pages; mark unverified discoveries as `candidate`.');
        guidance.push('- Use `public-source-refresh` only when live status, content type, or source freshness matters for the current task.');
    }

    if (automaticTools.some((entry) => entry.id === 'file-read')) {
        guidance.push('- Use `file-read` to inspect files from the local workspace when the user asks to read or review them.');
        guidance.push('- Do not describe the current local files or their contents unless `file-read`, `asset-search`, or another verified tool result showed them.');
    }

    if (automaticTools.some((entry) => entry.id === 'file-search')) {
        guidance.push('- Use `file-search` to locate files in the workspace before answering filesystem questions.');
        guidance.push('- Do not guess that a local file or folder exists, is missing, or is in a certain state before a search or read result confirms it.');
    }

    if (automaticTools.some((entry) => entry.id === 'file-write')) {
        guidance.push('- Use `file-write` to create or update local runtime files when the user asks for filesystem changes.');
        guidance.push('- Every `file-write` call must include both a `path` and the full file body as `content` in the same call. Do not call `file-write` with only a path.');
        guidance.push('- For remote hosts or deployed servers, use `remote-cli-agent` for remote software creation/update/deployment loops and `remote-command` or `k3s-deploy` for narrower inspection or standard deploy actions instead of `file-write` to container-only paths. Do not use `docker-exec` for the host unless the user explicitly says Docker is available there.');
    }

    if (!sessionIsolation && automaticTools.some((entry) => entry.id === 'agent-notes-write')) {
        guidance.push(`- Use \`agent-notes-write\` to maintain the durable user-wide carryover notes file for Phil-specific collaboration facts, stable tone preferences, and long-lived workflow defaults. Keep it under ${AGENT_NOTES_CHAR_LIMIT} characters.`);
        guidance.push('- When a turn reveals a stable tone preference, collaboration pattern, or personal-agent expectation, consider an `agent-notes-write` update before finishing the turn.');
        guidance.push('- Rewrite the full notes file in each `agent-notes-write` call, keeping only concise, durable notes rather than project-specific task state or long prose.');
        guidance.push('- Keep project-scoped continuity, artifacts, and working context out of the global carryover notes file.');
        guidance.push('- Do not store secrets, credentials, logs, or code snippets in the carryover notes.');
    }

    if (automaticTools.some((entry) => entry.id === SELF_REFLECTION_UPDATE_TOOL_ID)) {
        guidance.push('- Use `self-reflection-update` when a user correction, model-card finding, or completed multi-step workflow should update Hermes-style `soul.md`/`user.md`, durable carryover notes, or the registered skill/procedure that governs future work.');
        guidance.push('- If the user says the soul card or user card is not growing, map those cards to bounded `soul.md` and `user.md` updates through `self-reflection-update`.');
        guidance.push('- When the user explicitly asks the agent to grow, learn, evolve, or adapt from your interactions, capture only stable durable lessons; prefer `user_profile_append` for user/relationship facts and `soul_append` only for lasting assistant voice or behavior changes.');
        guidance.push('- Prefer append actions such as `user_profile_append`, `soul_append`, or `agent_notes_append` for ordinary growth so existing durable content is preserved; use exact patch actions for one sentence or bullet.');
        guidance.push('- If an append would exceed a durable-file limit, retry with `compactedContent`: the complete compacted file body that preserves essential existing guidance and includes the new lesson.');
        guidance.push('- Prefer `self-reflection-update` over separate notes and skill writes when one reflection needs to apply multiple bounded updates. Include a short `reflection`, a trigger, and at most a few structured actions.');
        guidance.push('- Use `soul_replace` only for the complete bounded personality/voice file, `user_profile_replace` only for the complete bounded `user.md` profile, and `agent_notes_replace` only for the complete carryover notes file when compaction or cleanup is truly needed.');
        guidance.push('- Applied durable-file writes keep a snapshot in the self-reflection history directory before changing `soul.md`, `user.md`, or `agent-notes.md`.');
        guidance.push('- Do not use `self-reflection-update` for prompt-surface rewrites outside the Hermes files, current task state, logs, secrets, or its own reflection result. Nested reflection calls are rejected.');
    }

    if (automaticTools.some((entry) => entry.id === 'file-mkdir')) {
        guidance.push('- Use `file-mkdir` to create folders or directories when the user asks for them.');
    }

    if (automaticTools.some((entry) => entry.id === 'agent-delegate')) {
        guidance.push('- Use `agent-delegate` when the user explicitly wants sub-agents, delegated workers, or parallel background tasks.');
        guidance.push('- `agent-delegate` can spawn at most 3 sub-agents at a time. Give each task a clear title and either a prompt or structured execution.');
        guidance.push('- Sub-agents inherit the caller model automatically and cannot spawn more sub-agents.');
        guidance.push('- When sub-agents may write files, assign distinct `writeTargets` or a `lockKey` so overlapping document edits are rejected.');
    }

    if (automaticTools.some((entry) => entry.id === 'agent-workload')) {
        guidance.push('- Before using `agent-workload`, classify the latest user turn as one-time future run, recurring workload, reminder/follow-up, host crontab management, or no scheduled work. Timing words such as "tomorrow" are not enough by themselves.');
        guidance.push('- Use `agent-workload` only for later, recurring, or deferred tasks tied to the current conversation.');
        guidance.push('- For `agent-workload`, pass the full original user request instead of inventing separate `command`, `schedule`, or cron fields. The runtime will canonicalize the task.');
        guidance.push('- If that classification shows the user actually asks to set up a cron job, recurring schedule, reminder, follow-up, or future run, prefer `agent-workload` even when the task will later execute remote commands on a server.');
        guidance.push('- If the user asks for multiple scheduled jobs, split them into separate `agent-workload` creations instead of one combined workload.');
        guidance.push('- Do not create or edit host crontabs with `remote-command` unless the user explicitly asks to inspect or modify the server\'s own cron configuration.');
    }

    if (automaticTools.some((entry) => entry.id === 'podcast')) {
        guidance.push('- Use `podcast` when the user asks for a podcast deliverable. It can research, script, synthesize the episode, persist audio/script artifacts, and render an MP4 when requested.');
        guidance.push('- For video podcast or podcast video requests, call `podcast` with `includeVideo: true`, `videoRenderMode: "storyboard"`, `videoImageMode: "generated"`, and `videoGenerateImages: true` unless the user explicitly asks for waveform-only, no generated imagery, stock photos, or web images. Reserve mixed/web/Unsplash imagery for explicit requests for those source types. Reserve the default waveform-card MP4 for plain MP4/audio-visualizer requests. Favor content-matched infographic slide variety: hook card, timeline, comparison board, process flow, risk/impact map, evidence dashboard, myth-vs-fact panel, and takeaway card.');
        guidance.push('- For training or manual podcast requests, treat the episode as instructional: clarify or infer learner audience, learning objectives, segment pacing, practice prompts, and assessment/checkpoint moments; use sources and vector context when the topic requires grounding.');
        guidance.push('- Do not answer that encoded video files cannot be generated when the `podcast` tool is attached; use the tool and report the returned audio, script, and video artifacts.');
    }

    if (automaticTools.some((entry) => entry.id === USER_CHECKPOINT_TOOL_ID)) {
        guidance.push('- Use `user-checkpoint` for a high-impact decision before major work instead of asking a plain-text multiple-choice question.');
        guidance.push('- In this runtime, do not call or mention `request_user_input`. `user-checkpoint` is the correct questionnaire tool for web chat.');
        guidance.push('- On web-chat, treat `user-checkpoint` as the primary quick way to involve the user when one concise decision would materially help.');
        guidance.push('- Do not mention checkpoint quotas, budgets, remaining counts, or internal runtime policy to the user.');
        guidance.push('- Do not tell the user that a questionnaire tool failed or expose internal mode/tool errors. If `user-checkpoint` is attached, use it directly.');
        guidance.push('- Do not claim that the inline survey card rendered, popped up, was dismissed, or was answered unless the transcript explicitly shows the user response.');
        guidance.push('- Prefer `user-checkpoint` over a prose "which option do you want?" message when one short choice would unblock progress or keep the user involved.');
        guidance.push('- If the user asks you to ask them a survey, questionnaire, inline survey card, or checkpoint card, call `user-checkpoint` directly instead of replying with sample survey text, markdown checkboxes, or an offer to turn it into a card later.');
        guidance.push('- Keep `user-checkpoint` to one card with one visible step at a time. Prefer a single question by default, or a short 2 to 4 step questionnaire when the user explicitly wants structured intake or back-and-forth.');
        guidance.push('- Supported step types are choice, multi-choice, text, date, time, and datetime. For choice steps, use 2 to 4 strong options and keep the built-in free-text path available when helpful.');
        guidance.push('- Do not turn `user-checkpoint` into long forms, sprawling questionnaires, or more than 6 steps.');
        guidance.push('- When the latest user turn starts with `Survey response (`, treat that as a resolved checkpoint answer and continue the work instead of asking another survey.');
        guidance.push('- For research, web-search, web-fetch, or web-scrape work, avoid long scrape questionnaires and example-heavy intake. If clarification is truly needed, use one short choice hotlist with 2 to 4 concrete options, then continue after the answer.');
        guidance.push('- If the user explicitly asks to test the questionnaire or survey tool, use exactly one `user-checkpoint` question. Do not write a multi-question quiz or personality test as assistant text.');
        guidance.push('- If no checkpoint cards remain, do not say the quota is exhausted. Ask at most one concise plain-text question or proceed with a reasonable assumption.');
    }

    if (automaticTools.some((entry) => entry.id === 'git-safe')) {
        guidance.push('- Use `git-safe` for local repository save flows: inspect git status, stage files, commit, and push.');
        guidance.push('- Use `git-safe remote-info` before pushing when you need to verify the current branch, HEAD revision, upstream tracking, or configured remotes.');
        guidance.push('- Prefer `save-and-push` when the user clearly wants the latest local changes committed and pushed to GitHub.');
        guidance.push('- Treat the local workspace repository as the source of truth for authoring and GitHub pushes unless the user explicitly says the canonical repo lives on the server.');
        guidance.push('- Treat that local repository rule as a default target selection, not proof of the repository\'s current health, cleanliness, or contents. Verify those facts with tools before stating them.');
        guidance.push('- Do not claim generic local shell or sandbox limits for Git work when `git-safe` is attached. Continue through the constrained Git tool path instead.');
    }

    const remoteGuidanceToolId = automaticTools.some((entry) => entry.id === 'remote-command')
        ? 'remote-command'
        : (automaticTools.some((entry) => entry.id === 'ssh-execute') ? 'ssh-execute' : null);

    if (remoteGuidanceToolId) {
        if (automaticTools.some((entry) => entry.id === 'remote-cli-agent')) {
            guidance.push('- For most remote software deployment work that needs an app, website, service, dashboard, frontend, or game changed and put live, use `remote-cli-agent` with `adminMode:true` so the remote coding agent owns authoring, build, deploy, and verification through the configured admin-capable CLI runner lane.');
            guidance.push('- If `remote-cli-agent` returns `USER_INPUT_REQUIRED`, forward that concise choice to the user and continue the same remote CLI session after the answer. If it repeats the same blocked command or root error twice without a changed strategy, stop that loop and surface the blocker.');
        }
        guidance.push(`- Use \`${remoteGuidanceToolId}\` for remote server commands over SSH when the user asks you to inspect, deploy, configure, or troubleshoot a remote host.`);
        guidance.push(`- Do not use \`${remoteGuidanceToolId}\` as a substitute scheduler. If the user wants future, recurring, cron-like, or follow-up work, create it with \`agent-workload\` instead of writing host crontabs unless they explicitly asked for server-side cron management.`);
        guidance.push(`- Do not refer to internal tool names like \`run_shell_command\` or claim you lack generic shell access when \`${remoteGuidanceToolId}\` is attached.`);
        guidance.push(`- Every \`${remoteGuidanceToolId}\` call must include a non-empty \`command\` string. Host, username, and port may be omitted only when runtime defaults already exist.`);
        guidance.push(`- Keep ownership of the original remote troubleshooting request. Treat intermediate failures as part of the same task and continue with the next reasonable command instead of asking the user to choose each step.`);
        guidance.push(`- If \`${remoteGuidanceToolId}\` fails, explain the actual SSH error from the tool result and ask only for the missing host or credentials if needed.`);
        guidance.push('- Ask for user input only when a tool result shows missing credentials or host details, a destructive action needs approval, or the next move depends on a real external decision.');
        guidance.push('- For reconnect or baseline remote checks, assume Ubuntu/Linux first and use a concrete command such as `hostname && uname -m && (test -f /etc/os-release && sed -n \'1,3p\' /etc/os-release || true) && uptime`.');
        guidance.push('- For Kubernetes troubleshooting, if `kubectl describe` or pod status output shows CrashLoopBackOff, an init container failure, or Exit Code > 0, follow it with `kubectl logs` for the failing container or init container instead of handing that next command back to the user.');
        guidance.push('- For remote website or HTML updates, prefer the git-backed remote workspace as the source of truth. Use live files, ConfigMaps, or deployed content only to recover context, then commit the edit before redeploying.');
        guidance.push('- If the user asks for a fresh replacement page, generate the full HTML remotely, save it in the owning git workspace, set repo-local git identity if needed, commit it, and then roll out the change instead of blocking on a missing local artifact.');
        guidance.push('- Do not infer an arbitrary live website path such as `/var/www/...` as the target. Prefer the configured deploy target directory, a git workspace, or a path the user explicitly named.');
        guidance.push('- If the configured deploy target directory is not a git repo, initialize one or clone the configured origin before making deployable edits; prefer configured GitLab origins when available.');
        guidance.push('- Internal artifact references like `/api/artifacts/...` are backend-local links. Do not invent `https://api/...` from them.');
        const sshConfig = settingsController.getEffectiveSshConfig();

        if (hasUsableSshDefaults()) {
            guidance.push(`- SSH defaults are configured for \`${sshConfig.username}@${sshConfig.host}:${sshConfig.port || 22}\`. Use these defaults unless the user asks for a different target.`);
        } else {
            guidance.push('- No SSH defaults are configured, so use the host/username provided by the user when available.');
        }
    }

    if (automaticTools.some((entry) => entry.id === 'docker-exec')) {
        guidance.push('- Use `docker-exec` only for commands that must run inside an existing Docker container and only when Docker access is explicitly configured.');
    }

    if (automaticTools.some((entry) => entry.id === 'k3s-deploy')) {
        guidance.push('- Use `k3s-deploy` for restricted deployment work over SSH: sync a GitHub repo on the server, apply manifests, set deployment images, and check rollout status.');
        guidance.push('- Prefer `k3s-deploy` over raw SSH when the task is a standard k3s deploy/update flow.');
        guidance.push('- Do not treat a missing project checkout on the remote host as a blocker for deployment work. `sync-repo` or `sync-and-apply` can clone the configured GitHub repo into the target directory.');
        guidance.push('- The configured deploy defaults describe the KimiBuilt backend self-deploy lane. Do not assume `kimibuilt/backend` for an unrelated app unless the user explicitly targets that repo, domain, or workload.');
        guidance.push('- Keep `remote-command` available for one-off server configuration and troubleshooting, but use `git-safe` plus `k3s-deploy` when the user wants code pushed to GitHub and then deployed.');
        guidance.push('- Prefer immutable deploys: push code, let CI build artifacts or images, then deploy those results into k3s instead of hand-editing the live server.');
        guidance.push('- Never initialize a new Git repository on the remote host or adopt an arbitrary web root as the canonical project unless the user explicitly asked for that server-local workflow.');
    }

    if (automaticTools.some((entry) => entry.id === 'code-sandbox')) {
        guidance.push('- Use `code-sandbox` only for explicitly local isolated execution when you need to verify behavior without modifying the main system.');
        if (executionProfile === 'remote-build') {
            guidance.push('- In `remote-build` sessions, do not treat the remote server or cluster as a request for the local `code-sandbox`; keep server-side build and app work on the remote lane unless the user explicitly asks for local isolated execution.');
        }
    }

    if (automaticTools.some((entry) => entry.id === 'security-scan')) {
        guidance.push('- Use `security-scan` for code audits, secret detection, and vulnerability checks when code is present.');
    }

    if (automaticTools.some((entry) => entry.id === 'architecture-design')) {
        guidance.push('- Use `architecture-design` for architecture recommendations, deployment/component overviews, and system design documentation.');
    }

    if (automaticTools.some((entry) => entry.id === 'uml-generate')) {
        guidance.push('- Use `uml-generate` for UML, Mermaid, or PlantUML class/sequence/activity/component/state diagrams from code or descriptions.');
    }

    if (automaticTools.some((entry) => entry.id === 'api-design')) {
        guidance.push('- Use `api-design` for REST, OpenAPI, GraphQL, or gRPC contract design work.');
    }

    if (automaticTools.some((entry) => entry.id === 'schema-generate')) {
        guidance.push('- Use `schema-generate` for DDL, ORM schema generation, and ER-diagram style database design output.');
    }

    if (automaticTools.some((entry) => entry.id === 'migration-create')) {
        guidance.push('- Use `migration-create` when the user asks for migration up/down scripts or schema diff output.');
    }

    if (automaticTools.some((entry) => entry.id === 'tool-doc-read')) {
        guidance.push('- Use `tool-doc-read` when the user asks how a tool works, what parameters it takes, or what its setup/limitations are. Pass the target `toolId`.');
    }

    guidance.push('Prefer tools over guessing when the user asks for live web data, extraction, or verification.');

    return guidance.join('\n');
}

function trimString(value, maxLength = MODEL_TOOL_RESULT_CHAR_LIMIT) {
    if (typeof value !== 'string') {
        return value;
    }

    const safeLimit = Math.max(1, Number(maxLength) || MODEL_TOOL_RESULT_CHAR_LIMIT);
    if (value.length <= safeLimit) {
        return value;
    }

    if (safeLimit < 1000) {
        return `${value.slice(0, safeLimit).trimEnd()}\n...[omitted ${value.length - safeLimit} chars]`;
    }

    const marker = `\n...[omitted middle output]...\n`;
    const available = Math.max(1, safeLimit - marker.length);
    const headLength = Math.max(1, Math.floor(available * 0.68));
    const tailLength = Math.max(1, available - headLength);
    const omitted = Math.max(0, value.length - headLength - tailLength);
    const adjustedMarker = `\n...[omitted ${omitted} middle chars]...\n`;

    return [
        value.slice(0, headLength).trimEnd(),
        adjustedMarker,
        value.slice(-tailLength).trimStart(),
    ].join('');
}

function sanitizeToolResultPayload(value, depth = 0) {
    if (value == null) {
        return value;
    }

    if (typeof value === 'string') {
        return trimString(value);
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (depth >= 6) {
        return '[omitted nested data]';
    }

    if (Array.isArray(value)) {
        const limit = 60;
        const entries = value.slice(0, limit).map((entry) => sanitizeToolResultPayload(entry, depth + 1));
        if (value.length > limit) {
            entries.push(`[omitted ${value.length - limit} additional items]`);
        }
        return entries;
    }

    const output = {};
    const entries = Object.entries(value);
    const limit = 100;
    for (const [key, entry] of entries.slice(0, limit)) {
        output[key] = sanitizeToolResultPayload(entry, depth + 1);
    }
    if (entries.length > limit) {
        output.__omittedKeys = entries.length - limit;
    }

    return output;
}

function normalizeToolResultForModel(result, fallbackToolId) {
    return {
        success: result?.success !== false,
        toolId: result?.toolId || fallbackToolId,
        duration: result?.duration || 0,
        data: sanitizeToolResultPayload(result?.data),
        error: result?.error || null,
        diagnostics: sanitizeToolResultPayload(result?.diagnostics),
        sideEffects: sanitizeToolResultPayload(result?.sideEffects || {}),
        timestamp: result?.timestamp || new Date().toISOString(),
    };
}

function buildToolExecutionContext(toolManager, context = {}) {
    return {
        ...context,
        toolManager,
        tools: {
            get: (toolId) => toolManager.getTool(toolId),
        },
    };
}

function throwIfAborted(signal = null) {
    if (!signal?.aborted) {
        return;
    }

    const reason = signal.reason;
    if (reason instanceof Error) {
        if (!reason.name || reason.name === 'Error') {
            reason.name = 'AbortError';
        }
        throw reason;
    }

    const error = new Error(
        typeof reason === 'string' && reason.trim()
            ? reason.trim()
            : 'Request aborted',
    );
    error.name = 'AbortError';
    throw error;
}

function waitForRetryDelay(ms = 0, signal = null) {
    const delayMs = Math.max(0, Number(ms) || 0);
    if (delayMs === 0) {
        throwIfAborted(signal);
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            signal?.removeEventListener?.('abort', handleAbort);
            resolve();
        }, delayMs);

        const handleAbort = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener?.('abort', handleAbort);
            try {
                throwIfAborted(signal);
            } catch (error) {
                reject(error);
            }
        };

        signal?.addEventListener?.('abort', handleAbort, { once: true });
        throwIfAborted(signal);
    });
}

function stringifyErrorDetail(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (value == null) {
        return '';
    }

    try {
        return JSON.stringify(value);
    } catch (_error) {
        return String(value);
    }
}

function extractModelRequestErrorText(error = null) {
    return [
        error?.message,
        error?.error,
        error?.cause?.message,
        error?.cause,
        error?.response?.data,
        error?.response?.error,
        error?.body,
    ]
        .map((value) => stringifyErrorDetail(value).trim())
        .filter(Boolean)
        .join('\n');
}

function isRetryableProviderWarmupError(error = null) {
    const text = extractModelRequestErrorText(error).toLowerCase();
    if (!text) {
        return false;
    }

    return /\bdatabase system\b[\s\S]{0,48}\b(?:not yet accepting connections|starting up)\b/.test(text);
}

function normalizeProviderWarmupError(error = null) {
    if (!error || !isRetryableProviderWarmupError(error)) {
        return error;
    }

    const currentStatus = Number(error?.statusCode || error?.status || 0);
    if (!Number.isFinite(currentStatus) || currentStatus === 500) {
        error.status = 503;
        error.statusCode = 503;
    }

    if (!String(error?.code || '').trim()) {
        error.code = 'provider_starting_up';
    }

    return error;
}

function normalizeProviderTransportError(error = null) {
    if (!error) {
        return error;
    }

    const message = String(error.message || '').trim();
    const lowerMessage = message.toLowerCase();
    if (!message) {
        return error;
    }

    if (lowerMessage === 'connection error.' || lowerMessage === 'connection error') {
        error.message = 'Model gateway connection failed while contacting the provider. Please retry the request.';
        error.code = error.code || 'provider_connection_error';
        error.statusCode = Number.isFinite(error.statusCode) ? error.statusCode : 502;
        error.status = Number.isFinite(error.status) ? error.status : error.statusCode;
        return error;
    }

    if (lowerMessage === 'request timed out.' || lowerMessage === 'request timed out' || /\brequest\b[\s\S]{0,24}\btimed out\b/.test(lowerMessage)) {
        error.message = 'Model gateway request timed out while waiting for the provider. Please retry or use a smaller prompt.';
        error.code = error.code || 'provider_gateway_timeout';
        error.statusCode = Number.isFinite(error.statusCode) ? error.statusCode : 504;
        error.status = Number.isFinite(error.status) ? error.status : error.statusCode;
    }

    return error;
}

async function retryProviderWarmupRequest(operation, {
    model = null,
    label = 'model request',
    signal = null,
    baseURL = config.openai.baseURL,
    retries = PROVIDER_WARMUP_RETRY_ATTEMPTS,
    retryDelayMs = PROVIDER_WARMUP_RETRY_DELAY_MS,
} = {}) {
    const providerFamily = inferProviderFamily({ baseURL, model });
    if (providerFamily !== 'generic' || !Number.isFinite(Number(retries)) || Number(retries) <= 0) {
        return operation();
    }

    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        throwIfAborted(signal);

        try {
            return await operation();
        } catch (error) {
            lastError = normalizeProviderWarmupError(error);
            if (!isRetryableProviderWarmupError(lastError) || attempt >= retries) {
                throw lastError;
            }

            console.warn(`[OpenAI] Retrying ${label} for ${model || 'default-model'} after provider warmup error: ${lastError.message}`);
            await waitForRetryDelay(retryDelayMs * (attempt + 1), signal);
        }
    }

    throw lastError;
}

async function createResponsesRequest(openai, params, requestOptions = undefined, options = {}) {
    return retryProviderWarmupRequest(
        () => openai.responses.create(params, requestOptions),
        {
            ...options,
            label: options.label || 'responses request',
        },
    );
}

async function createChatCompletionsRequest(openai, params, requestOptions = undefined, options = {}) {
    return retryProviderWarmupRequest(
        () => openai.chat.completions.create(params, requestOptions),
        {
            ...options,
            label: options.label || 'chat completions request',
        },
    );
}

function normalizeToolCall(toolCall = {}) {
    const rawArguments = toolCall.function?.arguments ?? toolCall.arguments;
    const rawName = toolCall.function?.name ?? toolCall.name;
    const rawId = toolCall.id || toolCall.call_id;

    return {
        id: rawId,
        type: toolCall.type === 'function_call' || toolCall.type === 'custom_tool_call'
            ? 'function'
            : (toolCall.type || 'function'),
        function: {
            name: rawName,
            arguments: typeof rawArguments === 'string'
                ? rawArguments
                : JSON.stringify(rawArguments || {}),
        },
    };
}

function isTerminalFinishReason(finishReason = null) {
    if (!finishReason) {
        return false;
    }

    return TERMINAL_FINISH_REASONS.has(String(finishReason).toLowerCase());
}

function parseToolArguments(rawArguments = '{}') {
    if (!rawArguments) {
        return {};
    }

    if (typeof rawArguments === 'object') {
        return rawArguments;
    }

    if (typeof rawArguments !== 'string') {
        return {
            __parseError: `Invalid tool arguments type: ${typeof rawArguments}`,
            raw: String(rawArguments),
        };
    }

    const parsed = parseLenientJson(rawArguments);
    if (parsed !== null) {
        return parsed;
    }

    {
        return {
            __parseError: 'Invalid tool arguments: unable to parse as JSON-like structured data.',
            raw: rawArguments,
        };
    }
}

function normalizeQuestionnaireLine(value = '') {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeQuestionnaireSource(text = '') {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/\s+(Question\s+\d+\s*:)/gi, '\n$1')
        .replace(/\s+([A-E](?:[.)]|:)\s+)/g, '\n$1')
        .replace(/\s+(Reply\s+(?:with|like)\b[\s\S]*$)/i, '\n$1')
        .replace(/\s+(If you(?:[’']|â€™)d like\b[\s\S]*$)/i, '\n$1')
        .trim();
}

function extractQuestionnaireQuestion(line = '') {
    const normalized = normalizeQuestionnaireLine(line);
    if (!normalized || /^reply (?:like|with)\b/i.test(normalized)) {
        return null;
    }

    const labeledMatch = normalized.match(/^question\s+\d+\s*:\s*(.+?\?)$/i);
    if (labeledMatch?.[1]) {
        return labeledMatch[1].trim();
    }

    const numberedMatch = normalized.match(/^\d+[.)]\s+(.+?\?)$/);
    if (numberedMatch?.[1]) {
        return numberedMatch[1].trim();
    }

    const explicitMatch = normalized.match(/^(?:sample\s+survey\s+question:\s*)?(.+?\?)$/i);
    if (explicitMatch?.[1]) {
        return explicitMatch[1].trim();
    }

    return null;
}

function extractQuestionnaireOption(line = '') {
    const normalized = normalizeQuestionnaireLine(line);
    if (!normalized) {
        return null;
    }

    const checkboxMatch = normalized.match(/^(?:[-*]\s*)?\[\s?\]\s*(.+)$/);
    if (checkboxMatch?.[1]) {
        return {
            label: checkboxMatch[1].trim(),
        };
    }

    const letteredMatch = normalized.match(/^(?:[-*]\s*)?([A-Z])(?:[.)]|:)\s+(.+)$/);
    if (letteredMatch?.[2]) {
        return {
            id: letteredMatch[1].toLowerCase(),
            label: letteredMatch[2].trim(),
        };
    }

    const bulletedMatch = normalized.match(/^[-*]\s+(.+)$/);
    if (bulletedMatch?.[1] && !extractQuestionnaireQuestion(bulletedMatch[1])) {
        return {
            label: bulletedMatch[1].trim(),
        };
    }

    return null;
}

function extractQuestionnaireCheckpointFromText(text = '') {
    const source = normalizeQuestionnaireSource(text);
    if (!source) {
        return null;
    }

    const lines = source
        .split('\n')
        .map((line) => normalizeQuestionnaireLine(line))
        .filter(Boolean);

    if (lines.length === 0) {
        return null;
    }

    for (let index = 0; index < lines.length; index += 1) {
        const question = extractQuestionnaireQuestion(lines[index]);
        if (!question) {
            continue;
        }

        const options = [];
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            const line = lines[cursor];

            if (/^reply with\b/i.test(line)) {
                break;
            }

            if (/^reply like:/i.test(line) || /^if you[’']d like/i.test(line) || /^---+$/.test(line)) {
                break;
            }

            if (extractQuestionnaireQuestion(line) && options.length > 0) {
                break;
            }

            const option = extractQuestionnaireOption(line);
            if (option) {
                options.push(option);
                continue;
            }

            if (options.length > 0) {
                break;
            }
        }

        if (options.length >= 2) {
            const hasLaterQuestion = lines.slice(index + 1).some((line) => Boolean(extractQuestionnaireQuestion(line)));
            return normalizeCheckpointRequest({
                title: hasLaterQuestion ? 'Quick choice' : 'Decision checkpoint',
                preamble: hasLaterQuestion
                    ? 'Pick the closest fit below and I will continue from there.'
                    : 'Choose an option below.',
                question,
                options: options.slice(0, 4),
                allowFreeText: true,
            });
        }
    }

    return null;
}

function extractQuestionnaireCheckpointFromJson(text = '') {
    const parsed = parseLenientJson(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    const type = String(parsed.type || parsed.kind || '')
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, '-');
    const hasCheckpointShape = Array.isArray(parsed.steps)
        || Array.isArray(parsed.questions)
        || Boolean(parsed.question || parsed.prompt || parsed.ask);
    const looksLikeCheckpoint = !type
        || ['survey', 'questionnaire', 'checkpoint', 'user-checkpoint'].includes(type);

    if (!hasCheckpointShape || !looksLikeCheckpoint) {
        return null;
    }

    try {
        return normalizeCheckpointRequest(parsed);
    } catch (_error) {
        return null;
    }
}

function maybeRecoverUserCheckpointResponse({
    response = null,
    selectedTools = [],
    toolEvents = [],
    toolContext = {},
    model = null,
} = {}) {
    if (!selectedTools.some((entry) => entry.id === USER_CHECKPOINT_TOOL_ID)) {
        return null;
    }

    if ((Array.isArray(toolEvents) ? toolEvents : []).some((event) => (
        (event?.toolCall?.function?.name || event?.result?.toolId || '') === USER_CHECKPOINT_TOOL_ID
    ))) {
        return null;
    }

    const checkpointPolicy = toolContext?.userCheckpointPolicy || {};
    if (checkpointPolicy.enabled !== true
        || Number(checkpointPolicy.remaining || 0) <= 0
        || checkpointPolicy.pending) {
        return null;
    }

    const responseText = getModelResponseText(response);
    const checkpoint = extractQuestionnaireCheckpointFromJson(responseText)
        || extractQuestionnaireCheckpointFromText(responseText);
    if (!checkpoint) {
        return null;
    }

    const toolCall = {
        id: 'recovered_user_checkpoint_1',
        type: 'function',
        function: {
            name: USER_CHECKPOINT_TOOL_ID,
            arguments: JSON.stringify(checkpoint),
        },
    };
    const toolEvent = {
        toolCall: normalizeToolCall(toolCall),
        reason: 'Recovered a single inline checkpoint from plain-text questionnaire output.',
        result: {
            success: true,
            toolId: USER_CHECKPOINT_TOOL_ID,
            data: {
                checkpoint,
                message: buildUserCheckpointMessage(checkpoint),
                recovered: true,
            },
        },
    };

    return buildDirectToolResponse(
        toolEvent,
        model,
        [...(Array.isArray(toolEvents) ? toolEvents : []), toolEvent],
        {
            usage: extractResponseUsageMetadata(response),
            tokenUsage: extractResponseUsageMetadata(response),
        },
    );
}

async function executeAutomaticToolCall(toolManager, toolCall, context = {}) {
    const toolId = toolCall.function?.name;
    throwIfAborted(context?.signal);

    if (!toolId || !AUTO_TOOL_ALLOWLIST.has(toolId)) {
        return {
            success: false,
            toolId: toolId || 'unknown',
            error: `Automatic execution is not allowed for tool '${toolId || 'unknown'}'`,
        };
    }

    const params = parseToolArguments(toolCall.function?.arguments || '{}');
    if (params.__parseError) {
        return {
            success: false,
            toolId,
            error: params.__parseError,
            rawArguments: trimString(params.raw || ''),
        };
    }

    try {
        const result = await toolManager.executeTool(
            toolId,
            params,
            buildToolExecutionContext(toolManager, context),
        );
        throwIfAborted(context?.signal);
        return normalizeToolResultForModel(result, toolId);
    } catch (error) {
        return {
            success: false,
            toolId,
            error: error.message,
        };
    }
}

async function runDeterministicToolPreflight({
    toolManager,
    automaticTools,
    prompt,
    toolContext = {},
}) {
    throwIfAborted(toolContext?.signal);
    const actions = buildDeterministicPreflightActions(automaticTools, prompt, toolContext);

    if (!actions.length) {
        return {
            toolEvents: [],
            summaryMessage: null,
        };
    }

    const toolEvents = [];
    console.log(`[OpenAI] Deterministic tool preflight: ${actions.map((action) => action.toolId).join(', ')}`);

    for (let index = 0; index < actions.length; index += 1) {
        throwIfAborted(toolContext?.signal);
        const action = actions[index];
        const toolCall = {
            id: `preflight_${index + 1}`,
            type: 'function',
            function: {
                name: action.toolId,
                arguments: JSON.stringify(action.params),
            },
        };

        const result = await executeAutomaticToolCall(toolManager, toolCall, toolContext);
        const event = {
            toolCall: normalizeToolCall(toolCall),
            reason: action.toolId === 'web-search'
                ? 'Deterministic research preflight.'
                : 'Deterministic preflight action.',
            result,
        };
        toolEvents.push(event);

        if (action.toolId === 'web-search' && result.success) {
            const followupEvents = await runResearchFollowupPreflight({
                toolManager,
                searchEvent: event,
                automaticTools,
                toolContext,
            });
            if (followupEvents.length > 0) {
                toolEvents.push(...followupEvents);
            }
        }
    }

    return {
        toolEvents,
        summaryMessage: buildAutomaticToolSummaryMessage(toolEvents),
    };
}

function isPreviewableDirectArtifact(artifact = {}) {
    const format = String(artifact?.format || '').toLowerCase();
    const filename = String(artifact?.filename || '').toLowerCase();

    if (artifact?.previewUrl || artifact?.bundleDownloadUrl) {
        return true;
    }

    return ['html', 'mermaid'].includes(format)
        || ['.html', '.htm', '.mmd', '.mermaid'].some((ext) => filename.endsWith(ext));
}

function buildDirectArtifactSummary(toolEvent = {}) {
    const artifacts = extractArtifactsFromToolEvents([toolEvent]);
    if (artifacts.length === 0) {
        return '';
    }

    const hasPreview = artifacts.some((artifact) => isPreviewableDirectArtifact(artifact));
    const actionLabel = hasPreview ? 'Preview and Download below.' : 'Use Download below.';

    if (artifacts.length === 1) {
        return `Created ${artifacts[0].filename || 'the requested file'}. ${actionLabel}`;
    }

    return `Created ${artifacts.length} files. ${actionLabel}`;
}

function buildDirectImageToolSummary(result = {}) {
    const data = result?.data || {};
    const images = Array.isArray(data.images) ? data.images.filter((image) => image && typeof image === 'object') : [];
    const artifactCount = Array.isArray(data.artifacts)
        ? data.artifacts.length
        : (Array.isArray(data.artifactIds) ? data.artifactIds.length : 0);
    const diagnostics = result?.diagnostics?.imageGeneration
        || data?.diagnostics?.imageGeneration
        || null;
    const diagnosticSummary = diagnostics ? formatImageDiagnosticsSummary(diagnostics) : '';
    const count = Math.max(
        Number(data.count) || 0,
        Number(data.requestedCount) || 0,
        images.length,
        data.image ? 1 : 0,
    );

    if (!count) {
        return '';
    }

    if (artifactCount <= 0 && diagnosticSummary) {
        return `Image generation completed, but no reusable image artifact was persisted. Diagnostics: ${diagnosticSummary}`;
    }

    if (count === 1) {
        return 'Generated 1 image. Open or download it below.';
    }

    return `Generated ${count} image options. Select one below.`;
}

function formatDirectToolResultMessage(toolEvent = {}) {
    const toolId = toolEvent?.toolCall?.function?.name || toolEvent?.result?.toolId || 'tool';
    const result = toolEvent?.result || {};

    if (toolId === 'ssh-execute' || toolId === 'remote-command') {
        if (!result.success) {
            return `SSH request failed: ${result.error || 'Unknown SSH error'}`;
        }

        const stdout = trimString(String(result?.data?.stdout || '').trim(), DIRECT_REMOTE_STDOUT_CHARS);
        const stderr = trimString(String(result?.data?.stderr || '').trim(), DIRECT_REMOTE_STDERR_CHARS);
        const host = result?.data?.host || 'remote host';
        const sections = [
            `SSH command completed on ${host}.`,
        ];

        if (stdout) {
            sections.push(`STDOUT:\n${stdout}`);
        }

        if (stderr) {
            sections.push(`STDERR:\n${stderr}`);
        }

        return sections.join('\n\n');
    }

    if (toolId === 'remote-cli-agent') {
        if (!result.success) {
            const diagnostics = result?.diagnostics?.remoteCliAgent || {};
            const sections = [
                `remote-cli-agent failed: ${result.error || 'Unknown error'}`,
            ];

            if (diagnostics.stage || diagnostics.model || diagnostics.apiMode) {
                sections.push([
                    `Stage: ${diagnostics.stage || 'unknown'}.`,
                    diagnostics.model ? `Model: ${diagnostics.model}.` : '',
                    diagnostics.apiMode ? `API mode: ${diagnostics.apiMode}.` : '',
                ].filter(Boolean).join(' '));
            }

            if (diagnostics.agentBaseURL || diagnostics.mcpURL) {
                sections.push([
                    diagnostics.agentBaseURL ? `Model gateway: ${diagnostics.agentBaseURL}.` : '',
                    diagnostics.mcpURL ? `MCP gateway: ${diagnostics.mcpURL}.` : '',
                ].filter(Boolean).join(' '));
            }

            if (diagnostics.hint) {
                sections.push(`Next check: ${diagnostics.hint}`);
            }

            return sections.join('\n\n');
        }

        const data = result?.data || {};
        return String(data.finalOutput || '').trim()
            || `remote-cli-agent completed for target ${data.targetId || 'default target'}.`;
    }

    if (!result.success) {
        const diagnosticSummary = toolId === 'image-generate'
            ? formatImageDiagnosticsSummary(result.diagnostics)
            : '';
        return `${toolId} failed: ${result.error || 'Unknown error'}${diagnosticSummary ? `\nDiagnostics: ${diagnosticSummary}` : ''}`;
    }

    if (toolId === 'web-scrape') {
        const scraped = result?.data || {};
        const sections = [
            `Web scrape completed for ${scraped.url || 'the requested page'}.`,
        ];

        if (scraped.title) {
            sections.push(`Title: ${scraped.title}`);
        }

        if (scraped.method) {
            sections.push(`Method: ${scraped.method}`);
        }

        if (scraped.data && Object.keys(scraped.data).length > 0) {
            sections.push(`Extracted data:\n${JSON.stringify(scraped.data, null, 2)}`);
        } else {
            sections.push(`Scrape result:\n${JSON.stringify(scraped, null, 2)}`);
        }

        return sections.join('\n\n');
    }

    if (toolId === 'podcast') {
        const data = result?.data || {};
        const sections = [
            `Podcast generated for ${data.title || data.topic || 'the requested topic'}.`,
        ];

        if (data.audio?.artifactId) {
            sections.push(`Primary audio artifact: ${data.audio.artifactId}`);
        }

        if (Array.isArray(data.audioVariants) && data.audioVariants.length > 0) {
            sections.push(`Available audio variants: ${data.audioVariants.map((variant) => variant.label || variant.format || variant.artifactId).filter(Boolean).join(', ')}`);
        }

        if (data.script?.artifactId) {
            sections.push(`Script artifact: ${data.script.artifactId}`);
        }

        const videoArtifactId = data.video?.artifactId
            || data.videoArtifact?.id
            || data.videoArtifact?.artifactId
            || (String(data.artifact?.mimeType || data.artifact?.format || '').toLowerCase().includes('video')
                ? data.artifact?.id
                : '')
            || '';
        if (videoArtifactId) {
            sections.push(`Video artifact: ${videoArtifactId}`);
        }

        const sceneCount = Array.isArray(data.storyboard?.scenes) ? data.storyboard.scenes.length : 0;
        if (sceneCount > 0) {
            sections.push(`Storyboard scenes: ${sceneCount}`);
        }

        return sections.join('\n\n');
    }

    if (toolId === 'image-generate') {
        return buildDirectImageToolSummary(result) || 'Generated image output.';
    }

    if (toolId === 'agent-workload') {
        if (!result.success) {
            return `Workload request failed: ${result.error || 'Unknown error'}`;
        }

        const data = result?.data || {};
        if (typeof data.message === 'string' && data.message.trim()) {
            return data.message;
        }

        if (data.action === 'list') {
            return `Found ${Number(data.count || 0)} deferred workloads for this session.`;
        }

        if (data.workload?.title) {
            return `${data.workload.title} created. ${summarizeTrigger(data.workload.trigger || {})}.`;
        }

        return JSON.stringify(data, null, 2);
    }

    const artifactSummary = buildDirectArtifactSummary(toolEvent);
    if (artifactSummary) {
        return artifactSummary;
    }

    if (toolId === USER_CHECKPOINT_TOOL_ID) {
        if (!result.success) {
            return `Checkpoint request failed: ${result.error || 'Unknown error'}`;
        }

        if (typeof result?.data?.message === 'string' && result.data.message.trim()) {
            return result.data.message;
        }

        if (result?.data?.checkpoint) {
            return buildUserCheckpointMessage(result.data.checkpoint);
        }
    }

    return JSON.stringify(result?.data || {}, null, 2);
}

function hasRemoteCliAgentContinuationIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /^(?:yes|yeah|yep|ok|okay)?\s*(?:continue|resume|finish|complete|keep going|keep working|go ahead|proceed)\b/,
        /\b(?:continue|resume|finish|complete|keep going|keep working)\b[\s\S]{0,80}\b(?:it|that|same|app|site|project|work|task)\b/,
        /\b(?:go ahead|proceed)\b[\s\S]{0,80}\b(?:remote cli agent|remote clie agent|remote coding agent|that app|the app|it)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function buildRemoteCliAgentTaskForDirectMode(prompt = '', priorAgentState = {}) {
    const currentRequest = String(prompt || '').trim();
    const priorTask = String(priorAgentState?.lastTask || '').trim();
    if (!currentRequest || !priorTask || !hasRemoteCliAgentContinuationIntent(currentRequest)) {
        return currentRequest;
    }

    return [
        'Continue the prior remote-cli-agent task to completion.',
        '',
        'Original task:',
        priorTask,
        '',
        'Current user follow-up:',
        currentRequest,
        '',
        'Continuity requirement: keep the same remote session/workspace when available, do not replace the task with a progress callback or status-card text, and keep working through authoring, build, deploy, and live verification unless a real blocker requires user input.',
    ].join('\n');
}

function getRemoteCliAgentStateFromToolContext(toolContext = {}) {
    const metadata = getToolContextMetadata(toolContext);
    const candidates = [
        toolContext?.remoteCliAgent,
        toolContext?.controlState?.remoteCliAgent,
        metadata?.remoteCliAgent,
        metadata?.controlState?.remoteCliAgent,
    ];

    return candidates.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) || {};
}

function buildDirectToolResponse(toolEvent, model = null, toolEvents = [], metadata = {}) {
    const normalizedToolEvents = Array.isArray(toolEvents) && toolEvents.length > 0
        ? toolEvents
        : [toolEvent];
    const responseMetadata = {
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        toolEvents: normalizedToolEvents,
    };

    return {
        id: `resp_tool_${Date.now()}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model,
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text: formatDirectToolResultMessage(toolEvent),
                    },
                ],
            },
        ],
        _kimibuilt: {
            ...responseMetadata,
        },
    };
}

function buildDirectRemoteCliProgress(toolId = 'tool', stage = 'started', startedAt = Date.now(), detail = '') {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const isRemoteCliAgent = toolId === 'remote-cli-agent';
    const toolLabel = isRemoteCliAgent ? 'Remote CLI agent' : toolId;
    const runningDetail = elapsedSeconds > 0
        ? `${toolLabel} is still working (${elapsedSeconds}s elapsed).`
        : `${toolLabel} is starting.`;
    const summary = detail || (
        stage === 'completed'
            ? `${toolLabel} finished; preparing the result.`
            : stage === 'failed'
                ? `${toolLabel} hit a blocker.`
                : runningDetail
    );
    const runningStatus = stage === 'completed'
        ? 'completed'
        : stage === 'failed'
            ? 'failed'
            : 'in_progress';

    return {
        phase: stage === 'failed' ? 'blocked' : (stage === 'completed' ? 'finalizing' : 'executing'),
        reasoningSummary: summary,
        percent: stage === 'completed'
            ? 92
            : stage === 'failed'
                ? 100
                : Math.min(85, 18 + Math.floor(elapsedSeconds / 30) * 8),
        steps: [
            { title: 'Choose remote agent lane', status: 'completed' },
            { title: `${toolLabel} run`, status: runningStatus },
            { title: 'Return proof markers', status: stage === 'completed' ? 'in_progress' : 'pending' },
        ],
        toolEvents: [{
            toolId,
            stage: runningStatus,
            detail: summary,
        }],
    };
}

function startDirectRemoteCliProgress(toolContext = {}, toolId = 'tool') {
    const onProgress = typeof toolContext?.onProgress === 'function' ? toolContext.onProgress : null;
    if (!onProgress || toolId !== 'remote-cli-agent') {
        return null;
    }

    const startedAt = Date.now();
    let stopped = false;
    const emit = (stage = 'started', detail = '') => {
        if (stopped && stage !== 'completed' && stage !== 'failed') {
            return;
        }
        try {
            onProgress(buildDirectRemoteCliProgress(toolId, stage, startedAt, detail));
        } catch (error) {
            console.warn('[OpenAI] Failed to emit direct remote-cli-agent progress:', error?.message || error);
        }
    };
    const interval = setInterval(() => {
        emit('heartbeat');
    }, 15000);
    if (typeof interval.unref === 'function') {
        interval.unref();
    }

    emit('started', 'Remote CLI agent started; waiting for remote_code_run/status proof markers.');

    return {
        complete() {
            if (stopped) {
                return;
            }
            stopped = true;
            clearInterval(interval);
            emit('completed');
        },
        fail(error = null) {
            if (stopped) {
                return;
            }
            stopped = true;
            clearInterval(interval);
            emit('failed', `Remote CLI agent failed: ${error?.message || 'unknown error'}`);
        },
    };
}

async function runDirectRequiredToolAction({
    toolManager,
    requiredToolId,
    selectedTools = [],
    prompt = '',
    toolContext = {},
    model = null,
}) {
    if (!['ssh-execute', 'remote-command', 'remote-cli-agent', 'web-scrape', 'agent-workload', 'podcast', 'image-generate'].includes(requiredToolId)) {
        return null;
    }

    if (requiredToolId === 'agent-workload') {
        let session = null;
        const workloadService = toolContext?.workloadService || null;
        if (workloadService?.sessionStore?.getOwned && toolContext?.sessionId && toolContext?.ownerId) {
            try {
                session = await workloadService.sessionStore.getOwned(toolContext.sessionId, toolContext.ownerId);
            } catch (_error) {
                session = null;
            }
        }

        const canonicalCreate = buildCanonicalWorkloadAction({
            request: prompt,
        }, {
            session,
            recentMessages: toolContext?.recentMessages || [],
            timezone: toolContext?.timezone || null,
            now: toolContext?.now || null,
        });
        const toolCall = {
            id: 'direct_required_tool_1',
            type: 'function',
            function: {
                name: requiredToolId,
                arguments: JSON.stringify(canonicalCreate || {
                    action: 'create_from_scenario',
                    request: prompt,
                    ...(toolContext?.timezone ? { timezone: toolContext.timezone } : {}),
                    ...(toolContext?.now ? { now: toolContext.now } : {}),
                }),
            },
        };

        const result = await executeAutomaticToolCall(toolManager, toolCall, toolContext);
        const toolEvent = {
            toolCall: normalizeToolCall(toolCall),
            result,
        };

        return buildDirectToolResponse(toolEvent, model, [toolEvent], {
            usage: createZeroUsageMetadata(),
            tokenUsage: createZeroUsageMetadata(),
        });
    }

    const actions = buildDeterministicPreflightActions(selectedTools, prompt, toolContext)
        .filter((action) => action.toolId === requiredToolId);

    if (!actions.length && !['remote-cli-agent', 'image-generate'].includes(requiredToolId)) {
        return null;
    }

    const priorRemoteCliAgentState = requiredToolId === 'remote-cli-agent'
        ? getRemoteCliAgentStateFromToolContext(toolContext)
        : {};
    const params = requiredToolId === 'remote-cli-agent'
        ? {
            task: buildRemoteCliAgentTaskForDirectMode(prompt, priorRemoteCliAgentState),
            waitMs: 30000,
            adminMode: hasRemoteSoftwareDeploymentIntent(prompt)
                || normalizeExecutionProfile(toolContext?.executionProfile) === REMOTE_BUILD_EXECUTION_PROFILE,
            ...(priorRemoteCliAgentState.targetId ? { targetId: priorRemoteCliAgentState.targetId } : {}),
            ...(priorRemoteCliAgentState.cwd ? { cwd: priorRemoteCliAgentState.cwd } : {}),
            ...(priorRemoteCliAgentState.sessionId || priorRemoteCliAgentState.remoteCodeSessionId
                ? { sessionId: priorRemoteCliAgentState.sessionId || priorRemoteCliAgentState.remoteCodeSessionId }
                : {}),
            ...(priorRemoteCliAgentState.mcpSessionId ? { mcpSessionId: priorRemoteCliAgentState.mcpSessionId } : {}),
            ...(priorRemoteCliAgentState.remoteCodeJobId ? { jobId: priorRemoteCliAgentState.remoteCodeJobId } : {}),
        }
        : requiredToolId === 'image-generate'
            ? (actions[0]?.params || { prompt })
        : actions[0].params;
    const toolCall = {
        id: 'direct_required_tool_1',
        type: 'function',
        function: {
            name: requiredToolId,
            arguments: JSON.stringify(params),
        },
    };

    console.log(`[OpenAI] Direct required tool execution starting for '${requiredToolId}'`);
    const progress = startDirectRemoteCliProgress(toolContext, requiredToolId);
    let result;
    try {
        result = await executeAutomaticToolCall(toolManager, toolCall, toolContext);
        progress?.complete();
    } catch (error) {
        progress?.fail(error);
        throw error;
    }
    const toolEvent = {
        toolCall: normalizeToolCall(toolCall),
        result,
    };

    return buildDirectToolResponse(toolEvent, model, [toolEvent], {
        usage: createZeroUsageMetadata(),
        tokenUsage: createZeroUsageMetadata(),
    });
}

function buildResponsesInput(messages = []) {
    return messages.map((message) => ({
        type: 'message',
        role: message.role,
        content: normalizeResponsesMessageContent(message.content),
    }));
}

function buildResponsesToolOutputItems(toolCalls = [], toolResults = []) {
    return toolCalls.map((toolCall, index) => ({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify(toolResults[index] || {
            success: false,
            toolId: toolCall.name || 'unknown',
            error: 'Tool output missing',
        }),
    }));
}

function getResponseApiText(response) {
    if (typeof response?.output_text === 'string') {
        return response.output_text;
    }

    if (!Array.isArray(response?.output)) {
        return '';
    }

    return response.output
        .filter((item) => item?.type === 'message' && item?.role === 'assistant')
        .flatMap((item) => item.content || [])
        .map((content) => {
            if (typeof content === 'string') {
                return content;
            }

            if (content?.type === 'output_text' || content?.type === 'text') {
                return content.text || '';
            }

            return content?.text || content?.output_text || '';
        })
        .filter(Boolean)
        .join('');
}

function extractResponseReasoningSummary(response) {
    const outputItems = Array.isArray(response?.output) ? response.output : [];

    return outputItems
        .filter((item) => item?.type === 'reasoning')
        .flatMap((item) => Array.isArray(item.summary) ? item.summary : [])
        .map((entry) => normalizeMessageContent(
            entry?.text
            ?? entry?.summary_text
            ?? entry?.content
            ?? entry,
        ))
        .filter(Boolean)
        .join('')
        .trim();
}

function getResponseFunctionCalls(response) {
    if (!Array.isArray(response?.output)) {
        return [];
    }

    return response.output.filter((item) => item?.type === 'function_call');
}

function isResponsesApiResponse(response) {
    return Boolean(response && (response.object === 'response' || Object.prototype.hasOwnProperty.call(response, 'output_text')));
}

function buildNormalizedResponseMetadata(response = null, metadata = {}) {
    const normalizedUsage = extractResponseUsageMetadata({
        ...(response && typeof response === 'object' ? response : {}),
        _kimibuilt: metadata,
    });

    return normalizedUsage
        ? {
            ...metadata,
            usage: normalizedUsage,
            tokenUsage: normalizedUsage,
        }
        : metadata;
}

function normalizeResponsesApiResponse(response) {
    const outputText = getResponseApiText(response);
    const responseMetadata = response?._kimibuilt && typeof response._kimibuilt === 'object'
        ? response._kimibuilt
        : {};
    const reasoningSummary = extractResponseReasoningSummary(response);
    const normalizedMetadata = {
        ...responseMetadata,
        ...(reasoningSummary && !responseMetadata.reasoningSummary
            ? {
                reasoningSummary,
                reasoningAvailable: true,
            }
            : {}),
    };
    const metadata = buildNormalizedResponseMetadata(response, normalizedMetadata);

    return {
        id: response.id,
        object: 'response',
        created: response.created_at,
        model: response.model,
        output_text: outputText,
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: outputText,
                    },
                ],
            },
        ],
        session_id: response.session_id,
        metadata,
    };
}

function isResponsesApiUnsupportedError(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const message = String(error?.message || '').toLowerCase();

    return status === 404
        || status === 405
        || message.includes('/responses')
        || message.includes('unknown url')
        || message.includes('not found')
        || message.includes('unsupported');
}

async function runAutomaticToolLoopWithResponses(openai, {
    model,
    messages,
    selectedTools,
    reasoningEffort = null,
    toolContext = {},
}) {
    const requestOptions = toolContext?.signal ? { signal: toolContext.signal } : undefined;
    const prompt = getLastUserText(messages);
    const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort || config.openai.reasoningEffort);
    if (selectedTools.length === 0) {
        return null;
    }

    const workingMessages = [...messages];
    let finalResponse = null;
    const toolGuidance = buildAutomaticToolGuidance(selectedTools, { model });
    const toolEvents = [];
    let aggregatedUsage = null;

    if (toolGuidance) {
        workingMessages.push({
            role: 'system',
            content: toolGuidance,
        });
    }

    const preflight = await runDeterministicToolPreflight({
        toolManager: toolContext.toolManager || null,
        automaticTools: selectedTools,
        prompt,
        toolContext,
    });
    if (preflight.summaryMessage) {
        workingMessages.push(preflight.summaryMessage);
    }
    if (preflight.toolEvents.length > 0) {
        toolEvents.push(...preflight.toolEvents);
    }

    const remainingTools = selectedTools.filter((entry) => !preflight.toolEvents.some(
        (event) => event.toolCall?.function?.name === entry.id,
    ));

    if (remainingTools.length === 0) {
        throwIfAborted(toolContext?.signal);
        finalResponse = await createResponsesRequest(openai, {
            model,
            input: buildResponsesInput(workingMessages),
            tool_choice: 'none',
            ...(normalizedReasoningEffort ? { reasoning: { effort: normalizedReasoningEffort } } : {}),
        }, requestOptions, {
            model,
            signal: toolContext?.signal,
            label: 'automatic responses follow-up',
        });
        aggregatedUsage = mergeUsageMetadata(aggregatedUsage, extractResponseUsageMetadata(finalResponse));

        const recoveredCheckpointResponse = maybeRecoverUserCheckpointResponse({
            response: finalResponse,
            selectedTools,
            toolEvents,
            toolContext,
            model,
        });
        if (recoveredCheckpointResponse) {
            return recoveredCheckpointResponse;
        }

        if (toolEvents.length > 0) {
            finalResponse._kimibuilt = {
                toolEvents,
                ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
            };
        }

        return finalResponse;
    }

    const seenToolCalls = new Set();
    let nextInput = buildResponsesInput(workingMessages);
    let previousResponseId = null;

    console.log(`[OpenAI] Automatic tools enabled for prompt. Candidates: ${remainingTools.map((entry) => entry.id).join(', ')}`);

    for (let round = 0; round < AUTO_TOOL_MAX_ROUNDS; round += 1) {
        throwIfAborted(toolContext?.signal);
        finalResponse = await createResponsesRequest(openai, {
            model,
            input: nextInput,
            previous_response_id: previousResponseId,
            tools: remainingTools.map((entry) => entry.responseDefinition),
            tool_choice: round === 0 ? buildAutomaticToolChoice(remainingTools, 'responses', { model, prompt, toolContext }) : 'auto',
            parallel_tool_calls: false,
            ...(normalizedReasoningEffort ? { reasoning: { effort: normalizedReasoningEffort } } : {}),
        }, requestOptions, {
            model,
            signal: toolContext?.signal,
            label: `automatic responses round ${round + 1}`,
        });
        aggregatedUsage = mergeUsageMetadata(aggregatedUsage, extractResponseUsageMetadata(finalResponse));

        const toolCalls = getResponseFunctionCalls(finalResponse);

        if (toolCalls.length === 0) {
            const recoveredCheckpointResponse = maybeRecoverUserCheckpointResponse({
                response: finalResponse,
                selectedTools,
                toolEvents,
                toolContext,
                model,
            });
            if (recoveredCheckpointResponse) {
                return recoveredCheckpointResponse;
            }

            if (toolEvents.length > 0) {
                finalResponse._kimibuilt = {
                    toolEvents,
                    ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
                };
            }
            return finalResponse;
        }

        const signature = JSON.stringify(toolCalls.map((toolCall) => ({
            name: toolCall.name,
            args: toolCall.arguments,
        })));
        if (seenToolCalls.has(signature)) {
            console.warn('[OpenAI] Endless tool loop detected (duplicate calls), breaking early.');
            const recoveredCheckpointResponse = maybeRecoverUserCheckpointResponse({
                response: finalResponse,
                selectedTools,
                toolEvents,
                toolContext,
                model,
            });
            if (recoveredCheckpointResponse) {
                return recoveredCheckpointResponse;
            }

            if (toolEvents.length > 0) {
                finalResponse._kimibuilt = {
                    toolEvents,
                    ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
                };
            }
            return finalResponse;
        }
        seenToolCalls.add(signature);

        const toolResults = [];
        for (const toolCall of toolCalls) {
            throwIfAborted(toolContext?.signal);
            const result = await executeAutomaticToolCall(toolContext.toolManager, {
                id: toolCall.id || toolCall.call_id,
                type: 'function',
                function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                },
            }, toolContext);
            toolResults.push(result);
            const toolEvent = {
                toolCall: normalizeToolCall({
                    id: toolCall.id || toolCall.call_id,
                    type: 'function',
                    function: {
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                    },
                }),
                result,
            };
            toolEvents.push(toolEvent);

            if (toolCall.name === USER_CHECKPOINT_TOOL_ID && result.success !== false) {
                return buildDirectToolResponse(toolEvent, model, toolEvents, {
                    usage: aggregatedUsage,
                    tokenUsage: aggregatedUsage,
                });
            }
        }

        previousResponseId = finalResponse.id;
        nextInput = buildResponsesToolOutputItems(toolCalls, toolResults);
    }

    throwIfAborted(toolContext?.signal);
    finalResponse = await createResponsesRequest(openai, {
        model,
        input: nextInput,
        previous_response_id: previousResponseId,
        tools: remainingTools.map((entry) => entry.responseDefinition),
        tool_choice: 'none',
        ...(normalizedReasoningEffort ? { reasoning: { effort: normalizedReasoningEffort } } : {}),
    }, requestOptions, {
        model,
        signal: toolContext?.signal,
        label: 'automatic responses finalization',
    });
    aggregatedUsage = mergeUsageMetadata(aggregatedUsage, extractResponseUsageMetadata(finalResponse));

    const recoveredCheckpointResponse = maybeRecoverUserCheckpointResponse({
        response: finalResponse,
        selectedTools,
        toolEvents,
        toolContext,
        model,
    });
    if (recoveredCheckpointResponse) {
        return recoveredCheckpointResponse;
    }

    if (toolEvents.length > 0) {
        finalResponse._kimibuilt = {
            toolEvents,
            ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
        };
    }

    return finalResponse;
}

async function runAutomaticToolLoopWithChatCompletions(openai, {
    model,
    messages,
    selectedTools,
    reasoningEffort = null,
    toolContext = {},
}) {
    const requestOptions = {};
    const effectiveToolRequestTimeoutMs = Number(config.openai.toolRequestTimeoutMs || config.openai.requestTimeoutMs);
    if (Number.isFinite(effectiveToolRequestTimeoutMs) && effectiveToolRequestTimeoutMs > 0) {
        requestOptions.timeout = effectiveToolRequestTimeoutMs;
    }
    if (toolContext?.signal) {
        requestOptions.signal = toolContext.signal;
    }
    if (selectedTools.length === 0) {
        return null;
    }

    const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort || config.openai.reasoningEffort);
    const chatReasoningParams = normalizedReasoningEffort
        && shouldSendReasoningEffort({ model, api: 'chat' })
        ? { reasoning_effort: normalizedReasoningEffort }
        : {};
    const prompt = getLastUserText(messages);
    const workingMessages = [...messages];
    let finalResponse = null;
    const toolGuidance = buildAutomaticToolGuidance(selectedTools, { model });
    const toolEvents = [];
    let aggregatedUsage = null;

    if (toolGuidance) {
        workingMessages.push({
            role: 'system',
            content: toolGuidance,
        });
    }

    const preflight = await runDeterministicToolPreflight({
        toolManager: toolContext.toolManager || null,
        automaticTools: selectedTools,
        prompt,
        toolContext,
    });
    if (preflight.summaryMessage) {
        workingMessages.push(preflight.summaryMessage);
    }
    if (preflight.toolEvents.length > 0) {
        toolEvents.push(...preflight.toolEvents);
    }

    const remainingTools = selectedTools.filter((entry) => !preflight.toolEvents.some(
        (event) => event.toolCall?.function?.name === entry.id,
    ));

    if (remainingTools.length === 0) {
        throwIfAborted(toolContext?.signal);
        finalResponse = await createChatCompletionsRequest(openai, {
            model,
            messages: workingMessages,
            stream: false,
            ...chatReasoningParams,
        }, requestOptions, {
            model,
            signal: toolContext?.signal,
            label: 'automatic chat follow-up',
        });
        aggregatedUsage = mergeUsageMetadata(aggregatedUsage, extractResponseUsageMetadata(finalResponse));

        const recoveredCheckpointResponse = maybeRecoverUserCheckpointResponse({
            response: finalResponse,
            selectedTools,
            toolEvents,
            toolContext,
            model,
        });
        if (recoveredCheckpointResponse) {
            return recoveredCheckpointResponse;
        }

        if (toolEvents.length > 0) {
            finalResponse._kimibuilt = {
                toolEvents,
                ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
            };
        }

        return finalResponse;
    }

    const seenToolCalls = new Set();

    console.log(`[OpenAI] Automatic tools enabled for prompt. Candidates: ${remainingTools.map((entry) => entry.id).join(', ')}`);

    for (let round = 0; round < AUTO_TOOL_MAX_ROUNDS; round += 1) {
        throwIfAborted(toolContext?.signal);
        finalResponse = await createChatCompletionsRequest(openai, {
            model,
            messages: workingMessages,
            tools: remainingTools.map((entry) => entry.chatDefinition),
            tool_choice: round === 0 ? buildAutomaticToolChoice(remainingTools, 'chat', { model, prompt, toolContext }) : 'auto',
            stream: false,
            ...chatReasoningParams,
        }, requestOptions, {
            model,
            signal: toolContext?.signal,
            label: `automatic chat round ${round + 1}`,
        });
        aggregatedUsage = mergeUsageMetadata(aggregatedUsage, extractResponseUsageMetadata(finalResponse));

        const assistantMessage = finalResponse.choices[0]?.message || {};
        const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];

        if (toolCalls.length === 0) {
            const recoveredCheckpointResponse = maybeRecoverUserCheckpointResponse({
                response: finalResponse,
                selectedTools,
                toolEvents,
                toolContext,
                model,
            });
            if (recoveredCheckpointResponse) {
                return recoveredCheckpointResponse;
            }

            if (toolEvents.length > 0) {
                finalResponse._kimibuilt = {
                    toolEvents,
                    ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
                };
            }
            return finalResponse;
        }

        const signature = JSON.stringify(toolCalls.map((tc) => ({ name: tc.function?.name, args: tc.function?.arguments })));
        if (seenToolCalls.has(signature)) {
            console.warn('[OpenAI] Endless tool loop detected (duplicate calls), breaking early.');
            const recoveredCheckpointResponse = maybeRecoverUserCheckpointResponse({
                response: finalResponse,
                selectedTools,
                toolEvents,
                toolContext,
                model,
            });
            if (recoveredCheckpointResponse) {
                return recoveredCheckpointResponse;
            }

            if (toolEvents.length > 0) {
                finalResponse._kimibuilt = {
                    toolEvents,
                    ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
                };
            }
            return finalResponse;
        }
        seenToolCalls.add(signature);

        workingMessages.push({
            role: 'assistant',
            content: assistantMessage.content || '',
            tool_calls: toolCalls.map((toolCall) => normalizeToolCall(toolCall)),
        });

        for (const toolCall of toolCalls) {
            throwIfAborted(toolContext?.signal);
            const result = await executeAutomaticToolCall(toolContext.toolManager, toolCall, toolContext);
            const toolEvent = {
                toolCall: normalizeToolCall(toolCall),
                result,
            };
            toolEvents.push(toolEvent);
            workingMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(result),
            });

            if (toolCall.function?.name === USER_CHECKPOINT_TOOL_ID && result.success !== false) {
                return buildDirectToolResponse(toolEvent, model, toolEvents, {
                    usage: aggregatedUsage,
                    tokenUsage: aggregatedUsage,
                });
            }
        }
    }

    throwIfAborted(toolContext?.signal);
    finalResponse = await createChatCompletionsRequest(openai, {
        model,
        messages: workingMessages,
        stream: false,
        ...chatReasoningParams,
    }, requestOptions, {
        model,
        signal: toolContext?.signal,
        label: 'automatic chat finalization',
    });
    aggregatedUsage = mergeUsageMetadata(aggregatedUsage, extractResponseUsageMetadata(finalResponse));

    const recoveredCheckpointResponse = maybeRecoverUserCheckpointResponse({
        response: finalResponse,
        selectedTools,
        toolEvents,
        toolContext,
        model,
    });
    if (recoveredCheckpointResponse) {
        return recoveredCheckpointResponse;
    }

    if (toolEvents.length > 0) {
        finalResponse._kimibuilt = {
            toolEvents,
            ...(aggregatedUsage ? { usage: aggregatedUsage, tokenUsage: aggregatedUsage } : {}),
        };
    }

    return finalResponse;
}

async function runAutomaticToolLoop(openai, {
    model,
    messages,
    reasoningEffort = null,
    toolManager,
    toolContext = {},
}) {
    throwIfAborted(toolContext?.signal);
    const prompt = getLastUserText(messages);
    const automaticTools = buildAutomaticToolDefinitions(toolManager, prompt, toolContext);
    const selectedTools = selectAutomaticToolDefinitions(automaticTools, prompt, { toolContext });

    if (selectedTools.length === 0) {
        return null;
    }

    const context = {
        ...toolContext,
        toolManager,
    };

    if (!shouldUseResponsesAPI()) {
        return runAutomaticToolLoopWithChatCompletions(openai, {
            model,
            messages,
            selectedTools,
            reasoningEffort,
            toolContext: context,
        });
    }

    try {
        return await runAutomaticToolLoopWithResponses(openai, {
            model,
            messages,
            selectedTools,
            reasoningEffort,
            toolContext: context,
        });
    } catch (error) {
        if (!isResponsesApiUnsupportedError(error)) {
            throw error;
        }

        console.warn(`[OpenAI] Responses API tool loop unavailable, falling back to chat completions: ${error.message}`);
        return runAutomaticToolLoopWithChatCompletions(openai, {
            model,
            messages,
            selectedTools,
            reasoningEffort,
            toolContext: context,
        });
    }
}

function getChatCompletionText(response) {
    const message = response?.choices?.[0]?.message || {};
    const firstCandidate = response?.candidates?.[0] || {};
    const candidates = [
        normalizeMessageContent(message.content),
        normalizeMessageContent(message.parts),
        normalizeMessageContent(message.items),
        normalizeMessageContent(message.text),
        normalizeMessageContent(message.output_text),
        normalizeMessageContent(message.reasoning_content),
        normalizeMessageContent(message.reasoning),
        normalizeMessageContent(message.refusal),
        normalizeMessageContent(response?.choices?.[0]?.text),
        normalizeMessageContent(firstCandidate?.content),
        normalizeMessageContent(firstCandidate?.content?.parts),
        normalizeMessageContent(firstCandidate?.parts),
        normalizeMessageContent(firstCandidate?.text),
        normalizeMessageContent(response?.output_text),
    ];

    return candidates.find((value) => typeof value === 'string' && value.trim()) || '';
}

function getModelResponseText(response) {
    return isResponsesApiResponse(response)
        ? getResponseApiText(response)
        : getChatCompletionText(response);
}

function normalizeChatResponse(response) {
    const outputText = getChatCompletionText(response);
    const finishReason = String(response?.choices?.[0]?.finish_reason || '').toLowerCase();

    if (!String(outputText || '').trim()
        && finishReason !== 'tool_calls'
        && (response?.choices?.length || response?.candidates?.length)) {
        console.warn(`[OpenAI] Empty chat completion text after normalization. Shape=${JSON.stringify({
            responseKeys: response && typeof response === 'object' ? Object.keys(response).slice(0, 20) : [],
            choiceKeys: response?.choices?.[0] && typeof response.choices[0] === 'object' ? Object.keys(response.choices[0]).slice(0, 20) : [],
            messageKeys: response?.choices?.[0]?.message && typeof response.choices[0].message === 'object' ? Object.keys(response.choices[0].message).slice(0, 20) : [],
            candidateKeys: response?.candidates?.[0] && typeof response.candidates[0] === 'object' ? Object.keys(response.candidates[0]).slice(0, 20) : [],
        })}`);
    }

    const metadata = buildNormalizedResponseMetadata(response, response?._kimibuilt || {});

    return {
        id: response.id,
        object: 'response',
        created: response.created,
        model: response.model,
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: outputText,
                    },
                ],
            },
        ],
        session_id: response.session_id,
        metadata,
    };
}

function normalizeModelResponse(response) {
    return isResponsesApiResponse(response)
        ? normalizeResponsesApiResponse(response)
        : normalizeChatResponse(response);
}

async function* normalizeChatCompletionsStream(stream, metadata = {}) {
    let responseId = null;
    let model = null;
    let created = null;
    let outputText = '';
    let usageMetadata = null;
    let sawCompletion = false;
    let sawToolCalls = false;
    let terminalFinishReason = null;

    for await (const chunk of stream) {
        if (!responseId && chunk.id) {
            responseId = chunk.id;
        }
        if (!model && chunk.model) {
            model = chunk.model;
        }
        if (!created && chunk.created) {
            created = chunk.created;
        }
        if (chunk?.usage) {
            usageMetadata = mergeUsageMetadata(usageMetadata, chunk.usage);
        }

        const choice = chunk.choices?.[0] || {};
        const deltaPayload = choice.delta || {};
        const delta = deltaPayload.content || '';
        const reasoning = normalizeMessageContent(
            deltaPayload.reasoning
            || deltaPayload.reasoning_text
            || deltaPayload.reasoning_content
            || deltaPayload.reasoning_details,
        );
        const finishReason = choice.finish_reason;

        if (delta) {
            outputText += delta;
            yield {
                type: 'response.output_text.delta',
                delta,
            };
        }

        if (reasoning) {
            yield {
                type: 'response.reasoning_summary_text.delta',
                delta: reasoning,
                summary: reasoning,
            };
        }

        if (Array.isArray(deltaPayload.tool_calls) && deltaPayload.tool_calls.length > 0) {
            sawToolCalls = true;
            yield {
                type: 'chat.completion.tool_calls.delta',
                tool_calls: deltaPayload.tool_calls.map((toolCall, index) => ({
                    ...toolCall,
                    index: Number.isInteger(Number(toolCall?.index)) && Number(toolCall.index) >= 0
                        ? Number(toolCall.index)
                        : index,
                })),
            };
        }

        if (isTerminalFinishReason(finishReason)) {
            sawCompletion = true;
            terminalFinishReason = finishReason;
        }
    }

    if (sawCompletion || outputText || sawToolCalls) {
        const finalMetadata = usageMetadata
            ? {
                ...metadata,
                usage: usageMetadata,
                tokenUsage: usageMetadata,
            }
            : metadata;
        yield {
            type: 'response.completed',
            response: normalizeChatResponse(attachKimibuiltMetadata({
                id: responseId,
                created,
                model,
                choices: [{
                    message: {
                        role: 'assistant',
                        content: outputText,
                    },
                    finish_reason: terminalFinishReason || (sawToolCalls ? 'tool_calls' : 'stop'),
                }],
            }, finalMetadata)),
        };
    }
}

async function* normalizeStreamResponse(stream, metadata = {}) {
    let reasoningSummary = '';

    const isToolOutputItem = (item = {}) => ['function_call', 'custom_tool_call'].includes(String(item?.type || '').trim());

    for await (const chunk of stream) {
        if (chunk.type === 'response.output_text.delta' && chunk.delta) {
            yield {
                type: 'response.output_text.delta',
                delta: chunk.delta,
            };
        }

        if ((chunk.type === 'response.reasoning_summary_text.delta'
            || chunk.type === 'response.reasoning_summary.delta')
            && chunk.delta) {
            reasoningSummary += chunk.delta;
            yield {
                type: 'response.reasoning_summary_text.delta',
                delta: chunk.delta,
                summary: reasoningSummary,
            };
        }

        if (chunk.type === 'response.reasoning_summary_text.done'
            || chunk.type === 'response.reasoning_summary.done') {
            const completedReasoningSummary = [
                chunk.text,
                chunk.summary_text,
                chunk.summaryText,
            ].find((value) => typeof value === 'string' && value.trim());
            if (completedReasoningSummary) {
                reasoningSummary = completedReasoningSummary.trim();
            }
        }

        if ((chunk.type === 'response.output_item.added' || chunk.type === 'response.output_item.done')
            && isToolOutputItem(chunk.item)) {
            yield {
                type: chunk.type,
                item: chunk.item,
            };
        }

        if (chunk.type === 'response.completed' && chunk.response) {
            const responseMetadata = reasoningSummary
                ? {
                    ...metadata,
                    reasoningSummary,
                    reasoningAvailable: true,
                }
                : metadata;
            yield {
                type: 'response.completed',
                response: normalizeResponsesApiResponse(attachKimibuiltMetadata(chunk.response, responseMetadata)),
            };
        }

        if (chunk.type === 'response.failed') {
            throw new Error(chunk.response?.error?.message || 'Response generation failed');
        }
    }
}

async function* synthesizeStreamResponse(response, metadata = {}, streamMode = 'synthetic') {
    attachKimibuiltMetadata(response, metadata);
    const responseId = response?.id || `resp_${Date.now()}`;
    const model = response?.model || null;
    const text = getModelResponseText(response);
    console.warn(`[OpenAI] Stream mode=${streamMode}`);

    if (text) {
        for (let index = 0; index < text.length; index += SYNTHETIC_STREAM_CHUNK_SIZE) {
            yield {
                type: 'response.output_text.delta',
                delta: text.slice(index, index + SYNTHETIC_STREAM_CHUNK_SIZE),
            };
        }
    }

    yield {
        type: 'response.completed',
        response: {
            ...normalizeModelResponse({
                ...response,
                id: responseId,
                model,
            }),
        },
    };
}

function estimateOpenAIRequestTextChars(value, seen = null) {
    if (typeof value === 'string') {
        return value.length;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
        return 0;
    }
    if (typeof value !== 'object') {
        return 0;
    }

    const visited = seen || new WeakSet();
    if (visited.has(value)) {
        return 0;
    }
    visited.add(value);

    if (Array.isArray(value)) {
        return value.reduce((sum, entry) => sum + estimateOpenAIRequestTextChars(entry, visited), 0);
    }

    return Object.values(value).reduce((sum, entry) => sum + estimateOpenAIRequestTextChars(entry, visited), 0);
}

function summarizeResponsesInputShape(input = []) {
    const items = Array.isArray(input) ? input : [input];
    return items.slice(0, 8).map((item) => {
        if (!item || typeof item !== 'object') {
            return typeof item;
        }
        return [item.type, item.role].filter(Boolean).join(':') || 'object';
    });
}

function summarizeOpenAIRequestParamsForLog(params = {}) {
    const inputItems = Array.isArray(params.input) ? params.input.length : (params.input == null ? 0 : 1);
    return {
        model: params.model || null,
        stream: params.stream === true,
        inputItems,
        inputChars: estimateOpenAIRequestTextChars(params.input),
        inputShape: summarizeResponsesInputShape(params.input),
        reasoning: params.reasoning ? { effort: params.reasoning.effort || null } : null,
        previousResponseId: Boolean(params.previous_response_id),
    };
}

async function createResponse({
    input,
    previousResponseId = null,
    previousPromptState = null,
    contextMessages = [],
    recentMessages = [],
    instructions = null,
    stream = false,
    model = null,
    reasoningEffort = null,
    toolManager = null,
    toolContext = {},
    enableAutomaticToolCalls = false,
    executionProfile = 'default',
    requestTimeoutMs = null,
    requestMaxRetries = null,
    signal = null,
}) {
    const openai = getClient();
    const apiMode = resolveOpenAIApiMode();
    const inputMessages = Array.isArray(input) ? input : [{ role: 'user', content: input }];
    const effectiveInstructions = buildEffectiveContinuityInstructions({
        instructions,
        prompt: getLastUserText(inputMessages),
        executionProfile,
        toolContext,
    });
    const promptState = buildPromptState({
        instructions: effectiveInstructions,
        input,
        previousPromptState,
        previousResponseId,
        apiMode,
    });
    const recentTranscriptAnchor = promptState.canReuseThreadedPrompt
        ? buildRecentTranscriptAnchor({
            currentInput: getLastUserText(inputMessages),
            recentMessages,
        })
        : '';
    const messages = buildMessages({
        input,
        instructions: promptState.canReuseThreadedPrompt ? null : effectiveInstructions,
        contextMessages,
        recentMessages: promptState.canReuseThreadedPrompt ? [] : recentMessages,
        recentTranscriptAnchor,
    });

    const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort || config.openai.reasoningEffort);
    const requestedModel = normalizeModelId(model || config.openai.model);
    const resolvedModel = resolveRuntimeModelId(model, {
        baseURL: config.openai.baseURL,
        fallback: config.openai.model,
    });
    const params = {
        model: resolvedModel,
        input: buildResponsesInput(messages),
        stream,
    };
    if (promptState.canReuseThreadedPrompt) {
        params.previous_response_id = previousResponseId;
        runtimeDiagnostics.incrementResponseThreadChains();
    }
    const effectiveToolContext = {
        ...(toolContext || {}),
        recentMessages: Array.isArray(toolContext?.recentMessages)
            ? toolContext.recentMessages
            : recentMessages,
        model: toolContext?.model || model || null,
        ...(signal ? { signal } : {}),
    };
    if (normalizedReasoningEffort) {
        params.reasoning = { effort: normalizedReasoningEffort };
    }
    const prompt = getLastUserText(messages);

    console.log(`[OpenAI] Creating response: model=${params.model}, stream=${stream}, messages=${messages.length}, reasoning=${normalizedReasoningEffort || 'default'}, apiMode=${apiMode}, promptReuse=${promptState.canReuseThreadedPrompt}`);
    console.log('[OpenAI] Request params summary:', JSON.stringify(summarizeOpenAIRequestParamsForLog(params)));
    const kimibuiltMetadata = {
        requestedModel,
        resolvedModel: params.model,
        resolved_model: params.model,
        modelContract: buildModelContract({
            id: params.model,
            owned_by: inferProviderFamily({ baseURL: config.openai.baseURL, model: params.model }),
        }, {
            officialOpenAI: isOpenAIBaseURL(config.openai.baseURL),
        }),
        promptState: {
            instructionsFingerprint: promptState.instructionsFingerprint,
            previousInstructionsFingerprint: promptState.previousInstructionsFingerprint,
            reusedThreadedPrompt: promptState.canReuseThreadedPrompt,
        },
    };
    const requestOptions = {};
    const effectiveRequestTimeoutMs = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0
        ? Number(requestTimeoutMs)
        : Number(config.openai.requestTimeoutMs);
    if (Number.isFinite(effectiveRequestTimeoutMs) && effectiveRequestTimeoutMs > 0) {
        requestOptions.timeout = effectiveRequestTimeoutMs;
    }
    if (Number.isFinite(Number(requestMaxRetries)) && Number(requestMaxRetries) >= 0) {
        requestOptions.maxRetries = Number(requestMaxRetries);
    }
    if (signal) {
        requestOptions.signal = signal;
    }

    try {
        throwIfAborted(signal);
        if (enableAutomaticToolCalls) {
            const requiredToolId = inferRequiredAutomaticToolId(prompt, [], effectiveToolContext);

            if (requiredToolId && !toolManager) {
                throw new ToolOrchestrationError(
                    `Required tool '${requiredToolId}' is unavailable because the runtime tool manager is not initialized.`,
                    { model: params.model },
                );
            }
        }

        if (enableAutomaticToolCalls && toolManager) {
            let automaticTools = [];
            try {
                const toolExecutionContext = {
                    executionProfile,
                    previousResponseId,
                    ...effectiveToolContext,
                };
                automaticTools = buildAutomaticToolDefinitions(toolManager, prompt, toolExecutionContext);
                const selectedTools = selectAutomaticToolDefinitions(automaticTools, prompt, { toolContext: toolExecutionContext });
                const requiredToolId = inferRequiredAutomaticToolId(prompt, automaticTools.map((tool) => tool.id), toolExecutionContext);

                if (requiredToolId && !selectedTools.some((tool) => tool.id === requiredToolId)) {
                    throw new ToolOrchestrationError(`Required tool '${requiredToolId}' is unavailable for this request. Check tool setup and runtime registration.`, {
                        model: params.model,
                    });
                }

                const directToolResponse = await runDirectRequiredToolAction({
                    toolManager,
                    requiredToolId,
                    selectedTools,
                    prompt,
                    toolContext: toolExecutionContext,
                    model: params.model,
                });

                if (directToolResponse) {
                    console.log(`[OpenAI] Direct required tool execution completed for '${requiredToolId}'`);
                    attachKimibuiltMetadata(directToolResponse, kimibuiltMetadata);
                    if (stream) {
                        const syntheticStream = synthesizeStreamResponse(
                            directToolResponse,
                            kimibuiltMetadata,
                            `synthetic-direct-tool:${requiredToolId}`,
                        );
                        syntheticStream.kimibuiltStreamMode = 'synthetic-direct-tool';
                        return syntheticStream;
                    }
                    return normalizeModelResponse(directToolResponse);
                }

                const toolResponse = await runAutomaticToolLoop(openai, {
                    model: params.model,
                    messages,
                    reasoningEffort: normalizedReasoningEffort,
                    toolManager,
                    toolContext: toolExecutionContext,
                });
                throwIfAborted(signal);

                if (toolResponse) {
                    console.log('[OpenAI] Automatic tool orchestration completed');
                    attachKimibuiltMetadata(toolResponse, kimibuiltMetadata);
                    if (stream) {
                        const syntheticStream = synthesizeStreamResponse(
                            toolResponse,
                            kimibuiltMetadata,
                            'synthetic-automatic-tool-loop',
                        );
                        syntheticStream.kimibuiltStreamMode = 'synthetic-automatic-tool-loop';
                        return syntheticStream;
                    }
                    return normalizeModelResponse(toolResponse);
                }
            } catch (toolError) {
                console.error('[OpenAI] Automatic tool orchestration failed:', toolError.message);
                const requiredToolId = inferRequiredAutomaticToolId(prompt, automaticTools.map((tool) => tool.id), effectiveToolContext);
                if (requiredToolId) {
                    throw toolError instanceof ToolOrchestrationError
                        ? toolError
                        : new ToolOrchestrationError(toolError.message, {
                            model: params.model,
                            cause: toolError,
                        });
                }
                console.warn(`[OpenAI] Falling back to a plain model response for '${params.model}'`);
            }
        }

        if (apiMode === 'responses') {
            throwIfAborted(signal);
            const response = await createResponsesRequest(openai, params, requestOptions, {
                model: params.model,
                signal,
                label: 'direct responses request',
            });
            attachKimibuiltMetadata(response, kimibuiltMetadata);
            if (stream) {
                console.log('[OpenAI] Stream mode=native-responses');
                const normalizedStream = normalizeStreamResponse(response, kimibuiltMetadata);
                normalizedStream.kimibuiltStreamMode = 'native-responses';
                return normalizedStream;
            }
            return normalizeModelResponse(response);
        }

        const chatParams = {
            model: params.model,
            messages: messages.map((message) => ({
                ...message,
                content: normalizeChatMessageContent(message.content),
            })),
            stream,
        };
        if (stream) {
            chatParams.stream_options = { include_usage: true };
        }
        if (normalizedReasoningEffort && shouldSendReasoningEffort({
            model: params.model,
            api: 'chat',
        })) {
            chatParams.reasoning_effort = normalizedReasoningEffort;
        }
        throwIfAborted(signal);
        const response = await createChatCompletionsRequest(openai, chatParams, requestOptions, {
            model: params.model,
            signal,
            label: 'direct chat completions request',
        });
        attachKimibuiltMetadata(response, kimibuiltMetadata);
        if (stream) {
            console.log('[OpenAI] Stream mode=native-chat-completions');
            const normalizedStream = normalizeChatCompletionsStream(response, kimibuiltMetadata);
            normalizedStream.kimibuiltStreamMode = 'native-chat-completions';
            return normalizedStream;
        }
        return normalizeChatResponse(response);
    } catch (error) {
        const normalizedError = normalizeProviderTransportError(error);
        console.error('[OpenAI] Error creating response:', normalizedError.message);
        console.error('[OpenAI] Error type:', normalizedError.type);
        console.error('[OpenAI] Error code:', normalizedError.code);
        throw normalizedError;
    }
}

async function transcribeAudio({
    audioBuffer,
    filename = 'recording.webm',
    mimeType = 'audio/webm',
    language = '',
    prompt = '',
    model = null,
} = {}) {
    if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        const error = new Error('An audio buffer is required for transcription.');
        error.statusCode = 400;
        error.code = 'audio_buffer_required';
        throw error;
    }

    const effectiveModel = normalizeModelId(model) || config.audio.transcriptionModel;
    const effectiveMimeType = String(mimeType || 'audio/webm').trim() || 'audio/webm';
    const extension = effectiveMimeType.includes('/')
        ? effectiveMimeType.split('/')[1].split(';')[0].trim() || 'webm'
        : 'webm';
    const upload = await toFile(
        audioBuffer,
        sanitizeUploadFilename(filename, extension),
        { type: effectiveMimeType },
    );
    const response = await getClient().audio.transcriptions.create({
        file: upload,
        model: effectiveModel,
        response_format: 'json',
        ...(String(language || '').trim() ? { language: String(language).trim() } : {}),
        ...(String(prompt || '').trim() ? { prompt: String(prompt).trim() } : {}),
    });

    const text = String(response?.text || '').trim();

    return {
        text,
        model: effectiveModel,
        language: String(response?.language || language || '').trim(),
        duration: Number.isFinite(response?.duration) ? response.duration : null,
        provider: 'openai',
    };
}

async function mapWithConcurrency(items = [], concurrency = 1, worker = async () => null) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(Number(concurrency) || 1, 1), Math.max(items.length, 1));

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }));

    return results;
}

function normalizeImagePromptList({ prompt = '', prompts = [], n = 1 } = {}) {
    const normalizedPrompts = Array.isArray(prompts)
        ? prompts.filter((entry) => extractImagePromptText(entry))
        : [];
    if (normalizedPrompts.length > 0) {
        return normalizedPrompts.slice(0, 10);
    }

    const normalizedPrompt = extractImagePromptText(prompt) ? prompt : '';
    const count = Math.min(Math.max(Number(n) || 1, 1), 10);
    return Array.from({ length: count }, () => normalizedPrompt).filter(Boolean);
}

function isLikelyMultiImageCountError(error = {}) {
    const status = Number(error.status || error.statusCode || 0);
    if (status && ![400, 422].includes(status)) {
        return false;
    }

    const message = String(error.message || '').toLowerCase();
    return /\bn\b/.test(message)
        || /\bcount\b/.test(message)
        || /\bmultiple\b/.test(message)
        || /\bmore than one\b/.test(message)
        || /\bonly\b[\s\S]{0,24}\bone\b/.test(message)
        || /\bsingle\b[\s\S]{0,24}\bimage\b/.test(message)
        || /\bmax(?:imum)?\b[\s\S]{0,16}\b1\b/.test(message)
        || /\bmust be 1\b/.test(message);
}

function buildImageParamsFromSelection({
    prompt,
    modelId,
    selectedModel = {},
    size = 'auto',
    quality = 'auto',
    style = null,
    background = 'auto',
    responseFormat = null,
    outputFormat = null,
    outputCompression = null,
    moderation = null,
    user = null,
    n = 1,
} = {}) {
    const supportedSizes = Array.isArray(selectedModel.sizes) ? selectedModel.sizes : [];
    const supportedQualities = Array.isArray(selectedModel.qualities) ? selectedModel.qualities : [];
    const supportedStyles = Array.isArray(selectedModel.styles) ? selectedModel.styles : [];
    const supportedBackgrounds = Array.isArray(selectedModel.backgrounds) ? selectedModel.backgrounds : [];
    const supportedOutputFormats = Array.isArray(selectedModel.outputFormats) ? selectedModel.outputFormats : [];
    const supportedModerations = Array.isArray(selectedModel.moderations) ? selectedModel.moderations : [];
    const normalizedSize = String(size || '').trim();
    const normalizedQuality = String(quality || '').trim().toLowerCase();
    const normalizedStyle = String(style || '').trim().toLowerCase();
    const normalizedBackground = String(background || '').trim().toLowerCase();
    const effectiveBackground = isGptImage2ModelId(modelId) && normalizedBackground === 'transparent'
        ? 'auto'
        : (normalizedBackground || background);
    const maxImages = Math.min(Math.max(Number(selectedModel.maxImages) || 5, 1), 10);

    const params = {
        prompt,
        n: Math.min(Math.max(Number(n) || 1, 1), maxImages),
        size: isGptImage2ModelId(modelId) && isValidGptImage2Size(normalizedSize)
            ? normalizedSize.toLowerCase()
            : (supportedSizes.includes(size) ? size : (supportedSizes[0] || size || '1024x1024')),
    };

    if (modelId) {
        params.model = modelId;
    }

    if (normalizedQuality && (supportedQualities.length === 0 || supportedQualities.includes(normalizedQuality))) {
        params.quality = normalizedQuality;
    }

    if (normalizedStyle && (supportedStyles.length === 0 || supportedStyles.includes(normalizedStyle))) {
        params.style = normalizedStyle;
    }

    if (effectiveBackground && (supportedBackgrounds.length === 0 || supportedBackgrounds.includes(effectiveBackground))) {
        params.background = effectiveBackground;
    }

    if (responseFormat) {
        params.response_format = responseFormat;
    }

    const normalizedOutputFormat = String(outputFormat || '').trim().toLowerCase();
    if (normalizedOutputFormat
        && (supportedOutputFormats.length === 0 || supportedOutputFormats.includes(normalizedOutputFormat))) {
        params.output_format = normalizedOutputFormat;
    }

    const parsedOutputCompression = Number.parseInt(outputCompression, 10);
    if (Number.isFinite(parsedOutputCompression)
        && ['jpeg', 'webp'].includes(String(params.output_format || '').trim().toLowerCase())) {
        params.output_compression = Math.min(Math.max(parsedOutputCompression, 0), 100);
    }

    const normalizedModeration = String(moderation || '').trim().toLowerCase();
    if (normalizedModeration
        && (supportedModerations.length === 0 || supportedModerations.includes(normalizedModeration))) {
        params.moderation = normalizedModeration;
    }

    if (user) {
        params.user = user;
    }

    return params;
}

async function resolveImageGenerationSelection(model = null) {
    const { modelId, availableModels } = await resolveImageModel(model);
    const selectedModel = availableModels.find((entry) => entry.id === modelId) || getImageModelMetadata(modelId);

    return {
        modelId,
        selectedModel,
    };
}

async function generateImageWithSelection({
    prompt,
    modelId,
    requestedModel = null,
    selectedModel,
    size = 'auto',
    quality = 'auto',
    style = null,
    background = 'auto',
    responseFormat = null,
    outputFormat = null,
    outputCompression = null,
    moderation = null,
    user = null,
    n = 1,
} = {}) {
    const params = buildImageParamsFromSelection({
        prompt,
        modelId,
        selectedModel,
        size,
        quality,
        style,
        background,
        responseFormat,
        outputFormat,
        outputCompression,
        moderation,
        user,
        n,
    });

    console.log(`[OpenAI] Generating image with provider=${getImageProviderConfig().source}, model=${params.model}, size=${params.size}, n=${params.n}`);

    const response = await postImageGeneration(params);

    const images = extractProviderImageRecords(response);
    const providerMetadata = getImageProviderMetadata(response);
    const usage = mergeUsageMetadata(
        response?.usage,
        response?.usage_metadata,
        response?.usageMetadata,
        response?.token_usage,
        response?.tokenUsage,
        response?.total_token_usage,
        response?.totalTokenUsage,
        images.map((image) => image.usage).filter(Boolean),
    );
    const providerCallCount = Math.max(1, Number(providerMetadata.requestVariant || 0) + 1);
    const diagnostics = buildImageGenerationDiagnostics({
        route: 'openai-client',
        stage: images.length > 0 ? 'provider_response_parsed' : 'provider_response_parse',
        source: 'backend',
        providerSource: providerMetadata.providerSource || getImageProviderConfig().source,
        providerBaseUrl: providerMetadata.baseURL || getImageProviderConfig().baseURL,
        providerMetadata,
        response,
        parsedImages: images,
        returnedImages: images,
        requestedCount: params.n,
        model: params.model,
        size: params.size,
        quality: params.quality,
        prompt: extractImagePromptText(prompt),
    });

    return {
        created: response.created,
        model: params.model,
        requested_model: normalizeModelId(requestedModel) || null,
        provider_call_count: providerCallCount,
        parsed_count: images.length,
        size: params.size,
        quality: params.quality || null,
        style: params.style || null,
        background: params.background || null,
        output_format: params.output_format || null,
        output_compression: params.output_compression ?? null,
        moderation: params.moderation || null,
        data: images,
        ...(usage ? { usage } : {}),
        diagnostics: {
            imageGeneration: diagnostics,
        },
    };
}

async function generateImage({
    prompt,
    model = null,
    size = 'auto',
    quality = 'auto',
    style = null,
    background = 'auto',
    response_format = null,
    responseFormat = response_format,
    output_format = null,
    outputFormat = output_format,
    output_compression = null,
    outputCompression = output_compression,
    moderation = null,
    user = null,
    n = 1,
}) {
    const { modelId, selectedModel } = await resolveImageGenerationSelection(model);
    return generateImageWithSelection({
        prompt,
        modelId,
        requestedModel: model,
        selectedModel,
        size,
        quality,
        style,
        background,
        responseFormat,
        outputFormat,
        outputCompression,
        moderation,
        user,
        n,
    });
}

async function generateImageBatch({
    prompt,
    prompts = [],
    model = null,
    size = 'auto',
    quality = 'auto',
    style = null,
    background = 'auto',
    response_format = null,
    responseFormat = response_format,
    output_format = null,
    outputFormat = output_format,
    output_compression = null,
    outputCompression = output_compression,
    moderation = null,
    user = null,
    n = 1,
    batchMode = 'auto',
    concurrency = config.openai.imageBatchConcurrency,
} = {}) {
    const promptList = normalizeImagePromptList({ prompt, prompts, n });
    const requestedCount = promptList.length;
    if (requestedCount === 0) {
        const error = new Error('Image generation requires at least one prompt.');
        error.status = 400;
        throw error;
    }
    const normalizedBatchMode = String(batchMode || 'auto').trim().toLowerCase();
    const useSingleRequest = normalizedBatchMode !== 'parallel'
        && promptList.length > 0
        && promptList.every((entry) => entry === promptList[0]);
    const { modelId, selectedModel } = await resolveImageGenerationSelection(model);

    const generateParallelResponses = (promptsToGenerate) => mapWithConcurrency(
        promptsToGenerate,
        concurrency,
        (entry) => generateImageWithSelection({
            prompt: entry,
            modelId,
            requestedModel: model,
            selectedModel,
            size,
            quality,
            style,
            background,
            responseFormat,
            outputFormat,
            outputCompression,
            moderation,
            user,
            n: 1,
        }),
    );

    const buildParallelResult = (responses, promptsForResponses, mode = 'parallel') => {
        const data = responses.flatMap((response, responseIndex) => (
            (response.data || []).map((image) => ({
                ...image,
                prompt: promptsForResponses[responseIndex],
                option_index: responseIndex,
            }))
        ));
        const firstResponse = responses[0] || {};
        const usage = mergeUsageMetadata(responses.map((response) => response?.usage).filter(Boolean));
        const providerCallCount = responses.reduce((sum, response) => (
            sum + Math.max(1, Number(response?.provider_call_count || 1))
        ), 0);
        const responseCreatedTimes = responses.map((response) => Number(response.created) || 0).filter(Boolean);
        const diagnostics = buildImageGenerationDiagnostics({
            route: 'openai-client-batch',
            stage: data.length > 0 ? 'batch_response_assembled' : 'provider_response_parse',
            source: 'backend',
            upstreamDiagnostics: responses.map((response) => response?.diagnostics?.imageGeneration).filter(Boolean),
            response: {
                batchMode: mode,
                responses: responses.map((response) => ({
                    created: response?.created,
                    model: response?.model,
                    dataCount: Array.isArray(response?.data) ? response.data.length : 0,
                    diagnosticCode: response?.diagnostics?.imageGeneration?.code || null,
                })),
            },
            parsedImages: data,
            returnedImages: data,
            requestedCount,
            model: firstResponse.model || modelId,
            size: firstResponse.size || size,
            quality: firstResponse.quality || quality,
            prompt: promptsForResponses.join(' | '),
        });

        return {
            created: responseCreatedTimes.length > 0 ? Math.max(...responseCreatedTimes) : firstResponse.created,
            model: firstResponse.model || modelId,
            requested_model: normalizeModelId(model) || null,
            provider_call_count: providerCallCount,
            parsed_count: data.length,
            size: firstResponse.size || size,
            quality: firstResponse.quality || null,
            style: firstResponse.style || null,
            background: firstResponse.background || null,
            output_format: firstResponse.output_format || null,
            output_compression: firstResponse.output_compression ?? null,
            moderation: firstResponse.moderation || null,
            data,
            ...(usage ? { usage } : {}),
            batch: {
                mode,
                concurrency: Math.min(Math.max(Number(concurrency) || 1, 1), Math.max(promptsForResponses.length, 1)),
                requestedCount,
                prompts: promptList,
            },
            diagnostics: {
                imageGeneration: diagnostics,
            },
        };
    };

    if (useSingleRequest) {
        try {
            const response = await generateImageWithSelection({
                prompt: promptList[0],
                modelId,
                requestedModel: model,
                selectedModel,
                size,
                quality,
                style,
                background,
                responseFormat,
                outputFormat,
                outputCompression,
                moderation,
                user,
                n: requestedCount,
            });

            const responseData = Array.isArray(response.data) ? response.data : [];
            if (requestedCount <= 1 || responseData.length >= requestedCount) {
                return {
                    ...response,
                    batch: {
                        mode: 'single-request',
                        requestedCount,
                        prompts: [promptList[0]],
                    },
                };
            }

            console.warn(`[OpenAI] Image provider returned ${responseData.length} of ${requestedCount} requested images; generating the remaining options in parallel.`);
            const remainingPrompts = promptList.slice(responseData.length);
            const remainingResponses = await generateParallelResponses(remainingPrompts);
            const remainingResult = buildParallelResult(remainingResponses, remainingPrompts, 'auto-fill-parallel');
            const responseCreatedTimes = [response, ...remainingResponses].map((entry) => Number(entry.created) || 0).filter(Boolean);
            const usage = mergeUsageMetadata(response?.usage, remainingResult?.usage);
            const combinedData = [
                ...responseData.map((image, index) => ({
                    ...image,
                    prompt: promptList[index],
                    option_index: index,
                })),
                ...remainingResult.data.map((image, index) => ({
                    ...image,
                    option_index: responseData.length + index,
                })),
            ];
            const diagnostics = buildImageGenerationDiagnostics({
                route: 'openai-client-batch',
                stage: combinedData.length > 0 ? 'batch_response_assembled' : 'provider_response_parse',
                source: 'backend',
                upstreamDiagnostics: [
                    response?.diagnostics?.imageGeneration,
                    remainingResult?.diagnostics?.imageGeneration,
                ].filter(Boolean),
                response: {
                    batchMode: 'auto-fill-parallel',
                    initialCount: responseData.length,
                    remainingCount: remainingResult.data.length,
                },
                parsedImages: combinedData,
                returnedImages: combinedData,
                requestedCount,
                model: response.model || modelId,
                size: response.size || size,
                quality: response.quality || quality,
                prompt: promptList.join(' | '),
            });

            return {
                ...response,
                created: responseCreatedTimes.length > 0 ? Math.max(...responseCreatedTimes) : response.created,
                data: combinedData,
                requested_model: normalizeModelId(model) || response.requested_model || null,
                provider_call_count: Math.max(1, Number(response.provider_call_count || 1))
                    + Math.max(0, Number(remainingResult.provider_call_count || 0)),
                parsed_count: combinedData.length,
                ...(usage ? { usage } : {}),
                batch: {
                    mode: 'auto-fill-parallel',
                    requestedCount,
                    prompts: promptList,
                    initialCount: responseData.length,
                    concurrency: remainingResult.batch.concurrency,
                },
                diagnostics: {
                    imageGeneration: diagnostics,
                },
            };
        } catch (error) {
            if (requestedCount <= 1 || !isLikelyMultiImageCountError(error)) {
                throw error;
            }

            console.warn(`[OpenAI] Multi-image request failed; retrying as ${requestedCount} single-image requests: ${error.message}`);
        }
    }

    const responses = await generateParallelResponses(promptList);
    return buildParallelResult(
        responses,
        promptList,
    );
}

module.exports = {
    getClient,
    listModels,
    listImageModels,
    createResponse,
    transcribeAudio,
    generateImage,
    generateImageBatch,
    __testUtils: {
        buildMessages,
        buildAutomaticToolDefinitions,
        buildAutomaticToolGuidance,
        buildAutomaticToolChoice,
        buildPromptState,
        buildDeterministicPreflightActions,
        buildResponsesInput,
        collectInputSystemMessages,
        extractExplicitWebResearchQuery,
        extractPiiRelationshipFormulaPlanRequest,
        extractRequestedDirectoryPath,
        formatDirectToolResultMessage,
        getResponseApiText,
        getChatCompletionText,
        hashPromptText,
        mergeInstructions,
        mergeUsageMetadata,
        normalizeOpenAIApiMode,
        extractResponseUsageMetadata,
        normalizeMessageContent,
        normalizeResponsesMessageContent,
        normalizeChatMessageContent,
        normalizeChatCompletionsStream,
        normalizeModelResponse,
        normalizeStreamResponse,
        normalizeToolResultForModel,
        filterRecentMessagesForPrompt,
        inferProviderFamily,
        parseToolArguments,
        resolveRuntimeModelId,
        resolveOpenAIApiMode,
        runDeterministicToolPreflight,
        runDirectRequiredToolAction,
        runAutomaticToolLoopWithResponses,
        sanitizeToolSchema,
        selectAutomaticToolDefinitions,
        buildRemoteCliAgentTaskForDirectMode,
        summarizeOpenAIRequestParamsForLog,
        inferRequiredAutomaticToolId,
        shouldSendReasoningEffort,
        shouldAutoUseTool,
        shouldUseResponsesAPI,
        isRetryableProviderWarmupError,
        normalizeProviderWarmupError,
        normalizeProviderTransportError,
        retryProviderWarmupRequest,
        promptHasExplicitSshIntent,
        shouldIncludeRemoteContinuityInstructions,
        buildEffectiveContinuityInstructions,
        hasExplicitPodcastIntent,
        hasExplicitPodcastVideoIntent,
        extractExplicitPodcastTopic,
        inferPodcastVideoOptions,
        hasExplicitUserCheckpointInteractionIntent,
        extractQuestionnaireCheckpointFromText,
        maybeRecoverUserCheckpointResponse,
        hasUsableSshDefaults,
        isTerminalFinishReason,
        parseLenientJson,
        ToolOrchestrationError,
    },
};

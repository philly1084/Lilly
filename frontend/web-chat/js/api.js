/**
 * API client for LillyBuilt AI Chat.
 * Uses fetch-based POST streaming against the gateway's SSE endpoints.
 */

// Configuration
const CURRENT_ORIGIN = `${window.location.protocol}//${window.location.host}`;

const API_BASE_URL = window.location.protocol === 'file:'
    ? 'http://localhost:3000/v1'
    : `${CURRENT_ORIGIN}/v1`;
const API_KEY = 'any-key'; // Required by SDK but not validated by LillyBuilt
const BASE_URL_WITHOUT_API = API_BASE_URL.replace('/v1', '');
const WEB_CHAT_API_TASK_TYPE = 'chat';
const WEB_CHAT_API_CLIENT_SURFACE = 'web-chat';
const USER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const REMOTE_BUILD_AUTONOMY_STORAGE_KEY = 'kimibuilt_remote_build_autonomy';
const DEFAULT_TTS_SYNTHESIS_CLIENT_TIMEOUT_MS = 15000;
const TTS_SYNTHESIS_CLIENT_TIMEOUT_PADDING_MS = 3500;
const gatewayStreamHelpers = window.KimiBuiltGatewaySSE || {};
const workspaceApiHelpers = window.KimiBuiltWebChatWorkspace || null;
const DEFAULT_CHAT_MODEL = gatewayStreamHelpers.DEFAULT_CODEX_MODEL_ID || 'auto';
const buildGatewayHeaders = gatewayStreamHelpers.buildGatewayHeaders || ((headers = {}) => ({
    ...headers,
    Authorization: 'Bearer any-key',
}));
const buildGatewayRealtimeUrl = gatewayStreamHelpers.buildGatewayRealtimeUrl
    || ((baseUrl, pathname = '/ws') => {
        const normalizedPath = `/${String(pathname || '/ws').replace(/^\/+/, '')}`;

        try {
            const parsedBaseUrl = new URL(String(baseUrl || '').trim());
            parsedBaseUrl.protocol = parsedBaseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
            parsedBaseUrl.pathname = normalizedPath;
            parsedBaseUrl.search = '';
            parsedBaseUrl.hash = '';
            return parsedBaseUrl.toString();
        } catch (_error) {
            return normalizedPath;
        }
    });
const filterChatModelsForWebChat = gatewayStreamHelpers.filterChatModels
    || ((models = []) => {
        const seen = new Set();
        const nonChatTokens = [
            'embed',
            'embedding',
            'gpt-image',
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
            'dall-e',
            'dalle',
            'imagen',
            'flux',
            'diffusion',
            'tts',
            'speech',
            'audio',
            'transcribe',
            'whisper',
            'realtime',
            'moderation',
        ];
        const nonChatCapabilities = new Set([
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
        const parseCapabilityEntries = (value = null) => {
            if (Array.isArray(value)) {
                return value.flatMap((entry) => parseCapabilityEntries(entry));
            }
            if (typeof value === 'string') {
                return value.split(/[,\s;|]+/).map((entry) => entry.trim()).filter(Boolean);
            }
            if (value && typeof value === 'object') {
                return Object.entries(value)
                    .filter(([, enabled]) => isCapabilityEnabled(enabled))
                    .map(([capability]) => capability);
            }
            return [];
        };
        const isCapabilityEnabled = (value) => {
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
        };

        return (Array.isArray(models) ? models : []).filter((model) => {
            const id = String(model?.id || '').trim();
            const lower = id.toLowerCase();
            const capabilities = [
                ...parseCapabilityEntries(model?.capabilities),
                ...parseCapabilityEntries(model?.metadata?.capabilities),
                ...parseCapabilityEntries(model?.contract?.capabilities),
            ].map((capability) => String(capability || '').trim().toLowerCase()).filter(Boolean);
            const chatCapable = capabilities.includes('chat')
                || (!capabilities.some((capability) => nonChatCapabilities.has(capability))
                    && !nonChatTokens.some((token) => lower.includes(token)));

            if (!id || seen.has(id) || !chatCapable) {
                return false;
            }

            seen.add(id);
            return true;
        });
    });
const resolvePreferredChatModelForWebChat = gatewayStreamHelpers.resolvePreferredChatModel
    || ((models, preferredModel = '', fallbackModel = DEFAULT_CHAT_MODEL) => {
        const availableModels = filterChatModelsForWebChat(models);
        const availableIds = new Set(
            availableModels
                .map((entry) => String(entry?.id || '').trim())
                .filter(Boolean),
        );
        const preferredId = String(preferredModel || '').trim();
        const fallbackId = String(fallbackModel || '').trim() || DEFAULT_CHAT_MODEL;
        const preferredIsChat = preferredId && filterChatModelsForWebChat([{ id: preferredId }]).length > 0;

        if (preferredId === DEFAULT_CHAT_MODEL) {
            return DEFAULT_CHAT_MODEL;
        }

        if (preferredIsChat && (availableIds.size === 0 || availableIds.has(preferredId))) {
            return preferredId;
        }

        if (fallbackId === DEFAULT_CHAT_MODEL) {
            return DEFAULT_CHAT_MODEL;
        }

        if (fallbackId && availableIds.has(fallbackId)) {
            return fallbackId;
        }

        return String(availableModels[0]?.id || fallbackId).trim() || fallbackId;
    });
const streamGatewayResponse = gatewayStreamHelpers.streamGatewayResponse || null;
const WEB_CHAT_WORKSPACE_CONTEXT = typeof workspaceApiHelpers?.getWorkspaceContext === 'function'
    ? workspaceApiHelpers.getWorkspaceContext()
    : {
        key: 'workspace-1',
        label: 'Workspace 1',
        scopeKey: WEB_CHAT_API_CLIENT_SURFACE,
        embedded: false,
    };

function buildWorkspaceAwareMetadata(metadata = {}) {
    if (typeof workspaceApiHelpers?.buildWorkspaceScopeMetadata === 'function') {
        return workspaceApiHelpers.buildWorkspaceScopeMetadata(metadata, WEB_CHAT_WORKSPACE_CONTEXT);
    }

    return {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    };
}

function getClientNowIso() {
    return new Date().toISOString();
}

function buildClientClockMetadata() {
    return {
        timezone: USER_TIMEZONE,
        clientNow: getClientNowIso(),
    };
}

function resolveTtsSynthesisClientTimeoutMs(options = {}) {
    const explicitTimeout = Number(options.fetchTimeoutMs);
    if (Number.isFinite(explicitTimeout) && explicitTimeout > 0) {
        return Math.max(1000, explicitTimeout);
    }

    const synthesisTimeout = Number(options.timeoutMs);
    if (Number.isFinite(synthesisTimeout) && synthesisTimeout > 0) {
        return Math.max(1000, synthesisTimeout + TTS_SYNTHESIS_CLIENT_TIMEOUT_PADDING_MS);
    }

    return DEFAULT_TTS_SYNTHESIS_CLIENT_TIMEOUT_MS;
}

async function fetchTtsWithTimeout(url, options = {}, timeoutMs = DEFAULT_TTS_SYNTHESIS_CLIENT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = Math.max(1000, Number(timeoutMs) || DEFAULT_TTS_SYNTHESIS_CLIENT_TIMEOUT_MS);
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(`TTS synthesis timed out after ${timeout}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function truncateNaturalContextText(value = '', limit = 1200) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length <= limit) {
        return text;
    }
    return `${text.slice(0, Math.max(0, limit - 24)).trim()}...[truncated]`;
}

function buildNaturalInteractionContext(messages = [], extras = {}) {
    const recentMessages = Array.isArray(messages) ? messages.slice(-6) : [];
    const recentTargets = [];
    recentMessages.forEach((message) => {
        const content = String(message?.content || '').trim();
        const headingMatches = content.match(/^#{1,6}\s+.+$/gm) || [];
        headingMatches.slice(-4).forEach((heading) => recentTargets.push(heading.replace(/^#{1,6}\s+/, '').trim()));
    });

    return {
        activeSurface: WEB_CHAT_API_CLIENT_SURFACE,
        activeMode: WEB_CHAT_API_TASK_TYPE,
        recentTargets: [...new Set(recentTargets.map((entry) => truncateNaturalContextText(entry, 90)).filter(Boolean))].slice(-8),
        lastVisibleMessages: recentMessages.map((message) => ({
            role: message?.role || '',
            content: truncateNaturalContextText(message?.content || '', 500),
        })),
        ...(extras && typeof extras === 'object' && !Array.isArray(extras) ? extras : {}),
    };
}

function getLastUserMessageText(messages = []) {
    const recentMessages = Array.isArray(messages) ? messages.slice().reverse() : [];
    const message = recentMessages.find((entry) => String(entry?.role || '').trim().toLowerCase() === 'user');
    return String(message?.content || '').trim();
}

function hasRemoteBuildIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized || normalized.startsWith('/')) {
        return false;
    }

    const softwareTarget = /\b(app|application|site|website|web app|web page|webpage|frontend|dashboard|service|software)\b/.test(normalized);
    const remoteTarget = /\b(remote|server|runner|gitlab|gitlab ci|pipeline|registry|image|cluster|k3s|k8s|kubernetes|ingress|traefik|tls|domain|dns|live|public|hosted|production)\b/.test(normalized);
    const action = /\b(create|build|make|develop|implement|update|fix|deploy|redeploy|publish|launch|ship|go live|rollout|verify)\b/.test(normalized);
    const explicitManagedApp = /\bmanaged[- ]app\b|\bmanaged app\b/.test(normalized);

    return action && remoteTarget && (softwareTarget || explicitManagedApp);
}

function hasExplicitRemoteCliAgentIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(remote[-_\s]+cli[-_\s]+agent|remote coding agent|remote[-_\s]+code[-_\s]+run|remote_code_run|assisted cli|cli tool)\b/.test(normalized);
}

function hasManagedAppPreferenceText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const managedAppCue = /\b(managed[- ]app|managed app|managed app catalog|managed-app catalog|managed control plane)\b/.test(normalized);
    const negativeManagedAppCue = /\b(?:without|bypass|skip|do not use|don't use|not)\s+(?:the\s+)?(?:managed[- ]app|managed app|gitlab)\b/.test(normalized);

    return managedAppCue && !negativeManagedAppCue && !hasExplicitRemoteCliAgentIntentText(normalized);
}

function mergeUniqueStringList(existing = [], additions = []) {
    return Array.from(new Set([
        ...(Array.isArray(existing) ? existing : []),
        ...(Array.isArray(additions) ? additions : []),
    ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function applyRequestExecutionProfile(params, requestOptions = {}) {
    const executionProfile = String(
        requestOptions?.executionProfile
        || requestOptions?.metadata?.executionProfile
        || '',
    ).trim();
    if (executionProfile) {
        params.executionProfile = executionProfile;
    }
}

function applyRemoteBuildMetadata(params, messages = []) {
    const lastUserText = getLastUserMessageText(messages);
    if (!hasRemoteBuildIntentText(lastUserText)) {
        return;
    }

    params.executionProfile = 'remote-build';
    params.metadata.remoteBuildAutonomyApproved = true;
    params.metadata.frontendRemoteBuildAutonomyApproved = true;
    params.metadata.remoteBuildIntent = true;

    if (hasManagedAppPreferenceText(lastUserText)) {
        params.metadata.preferManagedApp = true;
    } else if (hasExplicitRemoteCliAgentIntentText(lastUserText)) {
        params.metadata.preferredTool = 'remote-cli-agent';
        params.metadata.plannedTools = mergeUniqueStringList(params.metadata.plannedTools, ['remote-cli-agent']);
    } else {
        params.metadata.preferredTool = params.metadata.preferredTool || 'remote-cli-agent';
        params.metadata.plannedTools = mergeUniqueStringList(params.metadata.plannedTools, ['remote-cli-agent']);
    }
}

// Retry configuration
const RETRY_CONFIG = {
    maxRetries: 3,
    retryDelay: 1000, // Initial delay in ms
    retryMultiplier: 2,
    maxDelay: 10000
};

const TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);

function stripNullCharacters(value = '') {
    return String(value || '').replace(/\u0000/g, '');
}

function extractStreamText(value = null) {
    if (typeof value === 'string') {
        return stripNullCharacters(value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => extractStreamText(entry)).join('');
    }
    return extractAssistantText(value);
}

function extractDisplayText(value = null) {
    if (typeof value === 'string') {
        return stripNullCharacters(value).replace(/\s+/g, ' ').trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value
            .map((entry) => extractDisplayText(entry))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    if (!value || typeof value !== 'object') {
        return '';
    }

    const assistantText = extractAssistantText(value);
    if (assistantText) {
        return assistantText.replace(/\s+/g, ' ').trim();
    }

    for (const key of ['summary', 'detail', 'message', 'text', 'content', 'title', 'label', 'reason', 'description']) {
        const extracted = extractDisplayText(value[key]);
        if (extracted) {
            return extracted;
        }
    }

    try {
        const serialized = JSON.stringify(value);
        return serialized && serialized !== '{}' ? serialized : '';
    } catch (_error) {
        return '';
    }
}

function isReasoningLikeBlock(value = {}) {
    const blockType = String(value?.type || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return new Set([
        'analysis',
        'analysis_delta',
        'reasoning',
        'reasoning_delta',
        'reasoning_summary',
        'reasoning_summary_text',
        'reasoning_text',
        'redacted_thinking',
        'thinking',
        'thinking_delta',
        'thinking_summary',
        'thought',
        'thought_delta',
    ]).has(blockType);
}

function extractAssistantText(value) {
    if (typeof value === 'string') {
        const trimmed = stripNullCharacters(value).trim();
        if (!trimmed) {
            return '';
        }

        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                const parsed = JSON.parse(trimmed);
                const extracted = extractAssistantText(parsed);
                if (extracted) {
                    return extracted;
                }
            } catch (_error) {
                // Ignore parse failures and fall back to the raw string.
            }
        }

        return trimmed;
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => extractAssistantText(entry))
            .filter(Boolean)
            .join('');
    }

    if (!value || typeof value !== 'object') {
        return '';
    }

    if (isReasoningLikeBlock(value)) {
        return '';
    }

    const functionPayloadSources = [
        value.parameters,
        value.arguments,
        value.function?.arguments,
        value.function?.parameters,
    ];
    for (const source of functionPayloadSources) {
        const parsed = typeof source === 'string'
            ? (() => {
                try {
                    return JSON.parse(stripNullCharacters(source));
                } catch (_error) {
                    return null;
                }
            })()
            : source;
        if (!parsed || typeof parsed !== 'object') {
            continue;
        }

        const functionText = [
            parsed.notes_page_update,
            parsed.assistant_reply,
            parsed.assistantReply,
            parsed.message,
            parsed.content,
            parsed.text,
            parsed.result,
            parsed.response,
            parsed.output_text,
            parsed.outputText,
        ].find((entry) => typeof entry === 'string' && entry.trim());

        if (functionText) {
            return stripNullCharacters(functionText).trim();
        }
    }

    const directKeys = ['output_text', 'text', 'content', 'message', 'response', 'output'];
    for (const key of directKeys) {
        const extracted = extractAssistantText(value[key]);
        if (extracted) {
            return extracted;
        }
    }

    if (value.role === 'assistant' && Array.isArray(value.content)) {
        const extracted = extractAssistantText(value.content);
        if (extracted) {
            return extracted;
        }
    }

    const nestedKeys = ['content', 'output', 'payload', 'data', 'item', 'items', 'value', 'result'];
    for (const key of nestedKeys) {
        const extracted = extractAssistantText(value[key]);
        if (extracted) {
            return extracted;
        }
    }

    return '';
}

function normalizeAssistantMetadata(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const nextMetadata = {};

    if (Array.isArray(value)) {
        const reasoningSummary = extractReasoningSummary(value);
        if (reasoningSummary) {
            nextMetadata.reasoningSummary = reasoningSummary;
            nextMetadata.reasoningAvailable = true;
        }

        return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
    }

    if (value.agentExecutor === true) {
        nextMetadata.agentExecutor = true;
    }

    if (typeof value.taskType === 'string' && value.taskType.trim()) {
        nextMetadata.taskType = value.taskType.trim();
    }

    if (value.requestFrame && typeof value.requestFrame === 'object' && !Array.isArray(value.requestFrame)) {
        nextMetadata.requestFrame = value.requestFrame;
    }

    if (Array.isArray(value.decisionTrace)) {
        nextMetadata.decisionTrace = value.decisionTrace;
    }

    if (value.routingDecision && typeof value.routingDecision === 'object' && !Array.isArray(value.routingDecision)) {
        nextMetadata.routingDecision = value.routingDecision;
    }

    const artifacts = (Array.isArray(value.artifacts) ? value.artifacts : [])
        .map(normalizeArtifactMetadata)
        .filter(Boolean)
        .filter((artifact) => artifact.id && artifact.downloadUrl);
    if (artifacts.length > 0) {
        nextMetadata.artifacts = artifacts;
    }

    const reasoningSummary = extractReasoningSummary(value);
    if (reasoningSummary) {
        nextMetadata.reasoningSummary = reasoningSummary;
        nextMetadata.reasoningAvailable = true;
    } else if (value.reasoningAvailable === true || value.reasoning_available === true) {
        nextMetadata.reasoningAvailable = true;
    }

    const normalizeSurveyDisplayContent = (rawValue = '') => {
        const normalized = String(rawValue || '').trim();
        if (!normalized) {
            return '';
        }

        if (/```(?:survey|kb-survey)\s*[\s\S]*?```/i.test(normalized)) {
            return normalized;
        }

        try {
            const parsed = JSON.parse(normalized);
            const optionItems = Array.isArray(parsed?.options)
                ? parsed.options
                : (Array.isArray(parsed?.choices) ? parsed.choices : []);
            const hasChoicePrompt = typeof parsed?.question === 'string'
                && parsed.question.trim()
                && optionItems.length >= 2;
            const hasStructuredSteps = Array.isArray(parsed?.steps) || Array.isArray(parsed?.questions);
            const hasCheckpointIdentity = typeof parsed?.id === 'string'
                || typeof parsed?.title === 'string'
                || typeof parsed?.preamble === 'string';
            const looksLikeSurvey = parsed
                && typeof parsed === 'object'
                && (
                    hasStructuredSteps
                    || (hasChoicePrompt && hasCheckpointIdentity)
                );

            if (looksLikeSurvey) {
                return `\`\`\`survey\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
            }
        } catch (_error) {
            // Keep the original value when it is not valid JSON.
        }

        return normalized;
    };

    const displayContent = typeof value.displayContent === 'string' && value.displayContent.trim()
        ? normalizeSurveyDisplayContent(value.displayContent.trim())
        : (typeof value.display_content === 'string' && value.display_content.trim()
            ? normalizeSurveyDisplayContent(value.display_content.trim())
            : '');
    if (displayContent) {
        nextMetadata.displayContent = displayContent;
    }

    return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

function normalizeArtifactMetadata(artifact) {
    if (!artifact || typeof artifact !== 'object') {
        return null;
    }

    return {
        ...artifact,
        id: String(artifact.id || '').trim(),
        filename: String(artifact.filename || '').trim(),
        format: String(artifact.format || '').trim(),
        downloadUrl: String(artifact.downloadUrl || artifact.download_url || '').trim(),
        previewUrl: String(artifact.previewUrl || artifact.preview_url || '').trim(),
        sandboxUrl: String(artifact.sandboxUrl || artifact.sandbox_url || '').trim(),
        bundleDownloadUrl: String(
            artifact.bundleDownloadUrl
            || artifact.bundle_download_url
            || artifact.bundle_download
            || '',
        ).trim(),
    };
}

function extractReasoningSummary(value) {
    if (typeof value === 'string') {
        return stripNullCharacters(value).trim();
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => extractReasoningSummary(entry))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    if (!value || typeof value !== 'object') {
        return '';
    }

    if (isReasoningLikeBlock(value)) {
        const segments = [
            value.summary,
            value.summary_text,
            value.reasoning_content,
            value.reasoning,
            value.text,
            value.content,
            value.output_text,
            value.value,
        ]
            .map((candidate) => extractReasoningSummary(candidate))
            .filter(Boolean);

        return [...new Set(segments)].join(' ').replace(/\s+/g, ' ').trim();
    }

    const leafTextCandidates = [
        value.text,
        value.output_text,
        value.summary_text,
        value.value,
    ];
    for (const candidate of leafTextCandidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return stripNullCharacters(candidate).trim();
        }
    }

    const directCandidates = [
        value.reasoningSummary,
        value.reasoning_summary,
        value.reasoningText,
        value.reasoning_text,
        value.reasoning_content,
        value.reasoningContent,
        value.reasoning,
        value.reasoning_delta,
        value.reasoningDelta,
        value.reasoning_details,
        value.reasoningDetails,
        value.thinkingSummary,
        value.thinking_summary,
        value.thinkingText,
        value.thinking_text,
        value.thinking_content,
        value.thinkingContent,
        value.thinking,
        value.thinking_delta,
        value.thinkingDelta,
        value.thoughtSummary,
        value.thought_summary,
        value.thoughtText,
        value.thought_text,
        value.thought_content,
        value.thoughtContent,
        value.thought,
        value.thought_delta,
        value.thoughtDelta,
        value.summary_text,
        value.summaryText,
    ];
    for (const candidate of directCandidates) {
        const normalized = extractReasoningSummary(candidate);
        if (normalized) {
            return normalized;
        }
    }

    const nestedCandidates = [
        value.choices?.[0]?.message?.reasoning,
        value.choices?.[0]?.message?.reasoning_text,
        value.choices?.[0]?.message?.reasoning_content,
        value.choices?.[0]?.message?.reasoning_details,
        value.choices?.[0]?.message?.thinking,
        value.choices?.[0]?.message?.thinking_text,
        value.choices?.[0]?.message?.thinking_content,
        value.choices?.[0]?.message?.thought,
        value.choices?.[0]?.message?.thought_text,
        value.choices?.[0]?.message?.thought_content,
        value.choices?.[0]?.delta?.reasoning,
        value.choices?.[0]?.delta?.reasoning_text,
        value.choices?.[0]?.delta?.reasoning_content,
        value.choices?.[0]?.delta?.reasoning_details,
        value.choices?.[0]?.delta?.thinking,
        value.choices?.[0]?.delta?.thinking_text,
        value.choices?.[0]?.delta?.thinking_content,
        value.choices?.[0]?.delta?.thought,
        value.choices?.[0]?.delta?.thought_text,
        value.choices?.[0]?.delta?.thought_content,
        value.message?.reasoning,
        value.message?.reasoning_text,
        value.message?.reasoning_content,
        value.message?.reasoning_details,
        value.message?.thinking,
        value.message?.thinking_text,
        value.message?.thinking_content,
        value.message?.thought,
        value.message?.thought_text,
        value.message?.thought_content,
        value.response?.choices?.[0]?.message?.reasoning,
        value.response?.choices?.[0]?.message?.reasoning_text,
        value.response?.choices?.[0]?.message?.reasoning_content,
        value.response?.choices?.[0]?.message?.reasoning_details,
        value.response?.choices?.[0]?.message?.thinking,
        value.response?.choices?.[0]?.message?.thinking_text,
        value.response?.choices?.[0]?.message?.thinking_content,
        value.response?.choices?.[0]?.message?.thought,
        value.response?.choices?.[0]?.message?.thought_text,
        value.response?.choices?.[0]?.message?.thought_content,
        value.response?.choices?.[0]?.delta?.reasoning,
        value.response?.choices?.[0]?.delta?.reasoning_text,
        value.response?.choices?.[0]?.delta?.reasoning_content,
        value.response?.choices?.[0]?.delta?.reasoning_details,
        value.response?.choices?.[0]?.delta?.thinking,
        value.response?.choices?.[0]?.delta?.thinking_text,
        value.response?.choices?.[0]?.delta?.thinking_content,
        value.response?.choices?.[0]?.delta?.thought,
        value.response?.choices?.[0]?.delta?.thought_text,
        value.response?.choices?.[0]?.delta?.thought_content,
        value.response?.message?.reasoning,
        value.response?.message?.reasoning_text,
        value.response?.message?.reasoning_content,
        value.response?.message?.reasoning_details,
        value.response?.message?.thinking,
        value.response?.message?.thinking_text,
        value.response?.message?.thinking_content,
        value.response?.message?.thought,
        value.response?.message?.thought_text,
        value.response?.message?.thought_content,
    ];
    for (const candidate of nestedCandidates) {
        const normalized = extractReasoningSummary(candidate);
        if (normalized) {
            return normalized;
        }
    }

    return '';
}

function mergeAssistantMetadata(currentValue, nextValue) {
    const currentMetadata = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
        ? currentValue
        : {};
    const patchMetadata = nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue)
        ? nextValue
        : {};

    const mergedMetadata = {
        ...currentMetadata,
        ...patchMetadata,
    };

    return normalizeAssistantMetadata(mergedMetadata) || null;
}

function extractAssistantMetadata(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const sources = [
        value.assistantMetadata,
        value.assistant_metadata,
        value.output,
        value.response?.assistantMetadata,
        value.response?.assistant_metadata,
        value.response?.output,
        value.choices?.[0]?.message,
        value.response?.choices?.[0]?.message,
        value.response?.metadata,
        value.metadata,
    ];

    for (const source of sources) {
        const normalized = normalizeAssistantMetadata(source);
        if (normalized) {
            return normalized;
        }
    }

    return null;
}

function isRemoteBuildAutonomyApproved() {
    try {
        const stored = window.sessionManager?.safeStorageGet?.(REMOTE_BUILD_AUTONOMY_STORAGE_KEY) ?? '';
        const normalized = String(stored || '').trim().toLowerCase();
        if (!normalized) {
            return true;
        }
        if (['0', 'false', 'no', 'off'].includes(normalized)) {
            return false;
        }
        return ['1', 'true', 'yes', 'on'].includes(normalized);
    } catch (_error) {
        return true;
    }
}

class OpenAIAPIClient extends EventTarget {
    constructor() {
        super();
        this.client = null;
        this.currentSessionId = null;
        this.modelsCache = null;
        this.modelsCacheExpiry = null;
        this.modelsCacheDuration = 5 * 60 * 1000; // 5 minutes
        this.retryCount = 0;
        this.abortControllers = new Map(); // Track abort controllers for cancellation
        this.storageAvailable = this.checkStorageAvailability();
        
        // Initialize OpenAI client
        this.initClient();
    }

    checkStorageAvailability() {
        if (typeof window !== 'undefined' && window.sessionManager?.storageAvailable != null) {
            return window.sessionManager.storageAvailable === true;
        }
        return false;
    }

    safeStorageGet(key) {
        if (typeof window !== 'undefined' && window.sessionManager?.safeStorageGet) {
            return window.sessionManager.safeStorageGet(key);
        }
        if (!this.storageAvailable) {
            return null;
        }

        try {
            return localStorage.getItem(key);
        } catch (_error) {
            this.storageAvailable = false;
            return null;
        }
    }

    safeStorageSet(key, value) {
        if (typeof window !== 'undefined' && window.sessionManager?.safeStorageSet) {
            return window.sessionManager.safeStorageSet(key, value);
        }
        if (!this.storageAvailable) {
            return false;
        }

        try {
            localStorage.setItem(key, value);
            return true;
        } catch (_error) {
            this.storageAvailable = false;
            return false;
        }
    }

    safeStorageRemove(key) {
        if (typeof window !== 'undefined' && window.sessionManager?.safeStorageRemove) {
            return window.sessionManager.safeStorageRemove(key);
        }
        if (!this.storageAvailable) {
            return false;
        }

        try {
            localStorage.removeItem(key);
            return true;
        } catch (_error) {
            this.storageAvailable = false;
            return false;
        }
    }

    async parseErrorPayload(response) {
        if (!response) {
            return null;
        }

        try {
            const contentType = response.headers?.get?.('content-type') || '';
            if (contentType.includes('application/json')) {
                return await response.json();
            }

            const text = await response.text();
            return text ? { error: { message: text } } : null;
        } catch (_error) {
            return null;
        }
    }
    
    initClient() {
        // Use fetch-only in the browser to avoid third-party SDK/CORS/tracking issues.
        this.client = null;
    }

    /**
     * Sleep utility for retry delays
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Calculate retry delay with exponential backoff
     */
    getRetryDelay(attempt) {
        const delay = RETRY_CONFIG.retryDelay * Math.pow(RETRY_CONFIG.retryMultiplier, attempt);
        return Math.min(delay, RETRY_CONFIG.maxDelay);
    }

    /**
     * Determine if an error is retryable
     */
    isRetryableError(error) {
        // Network errors are retryable
        if (error.name === 'TypeError' || error.name === 'NetworkError' || error.message?.includes('fetch')) {
            return true;
        }
        // 5xx server errors are retryable
        if (error.status >= 500 || error.status === 429) {
            return true;
        }
        // 4xx errors (except 429) are not retryable
        if (error.status >= 400 && error.status < 500) {
            return false;
        }
        return true;
    }

    isTerminalFinishReason(finishReason) {
        if (!finishReason) {
            return false;
        }

        return TERMINAL_FINISH_REASONS.has(String(finishReason).toLowerCase());
    }

    extractToolEvents(payload = {}) {
        if (!payload || typeof payload !== 'object') {
            return [];
        }

        if (Array.isArray(payload.toolEvents)) {
            return payload.toolEvents;
        }

        if (Array.isArray(payload.tool_events)) {
            return payload.tool_events;
        }

        const message = payload.choices?.[0]?.message || {};
        if (Array.isArray(message.toolEvents)) {
            return message.toolEvents;
        }

        if (Array.isArray(message.tool_events)) {
            return message.tool_events;
        }

        if (Array.isArray(payload.response?.metadata?.toolEvents)) {
            return payload.response.metadata.toolEvents;
        }

        if (Array.isArray(payload.response?.metadata?.tool_events)) {
            return payload.response.metadata.tool_events;
        }

        if (Array.isArray(payload.choices?.[0]?.delta?.tool_calls)) {
            return payload.choices[0].delta.tool_calls.map((toolCall, index) => this.buildToolEventDetail({
                ...toolCall,
                index: Number.isInteger(Number(toolCall?.index)) && Number(toolCall.index) >= 0
                    ? Number(toolCall.index)
                    : index,
            }, 'response.output_item.added'));
        }

        return [];
    }

    buildDonePayload(pendingDone = {}) {
        return {
            type: 'done',
            sessionId: pendingDone.sessionId || this.currentSessionId,
            artifacts: Array.isArray(pendingDone.artifacts)
                ? pendingDone.artifacts.map(normalizeArtifactMetadata).filter(Boolean)
                : [],
            toolEvents: Array.isArray(pendingDone.toolEvents) ? pendingDone.toolEvents : [],
            assistantMetadata: pendingDone.assistantMetadata || null,
        };
    }

    buildStatusEvent(phase = 'thinking', detail = '') {
        return {
            type: 'status',
            phase: extractDisplayText(phase) || 'thinking',
            detail: extractDisplayText(detail),
        };
    }

    isToolOutputItem(item = {}) {
        const itemType = String(item?.type || '').trim();
        return itemType === 'function_call' || itemType === 'custom_tool_call';
    }

    getTextDeltaFromStreamPayload(parsed = {}) {
        if (parsed?.type === 'response.output_text.delta') {
            return extractStreamText(parsed.delta ?? parsed.output_text_delta ?? '');
        }

        return extractStreamText(parsed?.choices?.[0]?.delta?.content || parsed?.output_text_delta || '');
    }

    buildToolEventDetail(item = {}, eventType = '') {
        const rawToolName = String(
            item?.name
            || item?.tool_name
            || item?.function?.name
            || item?.call_id
            || 'tool',
        ).trim();
        const toolName = rawToolName.replace(/[_-]+/g, ' ').trim() || 'tool';
        const stage = eventType.endsWith('.done') ? 'completed' : 'started';
        const detail = stage === 'completed'
            ? `Finished ${toolName}`
            : `Running ${toolName}`;

        return {
            stage,
            toolName: rawToolName,
            detail,
        };
    }

    normalizeStreamPayload(parsed = {}, pendingDone = {}) {
        if (parsed.session_id || parsed.sessionId) {
            this.currentSessionId = parsed.session_id || parsed.sessionId;
            pendingDone.sessionId = this.currentSessionId;
        }

        if (Array.isArray(parsed.artifacts)) {
            pendingDone.artifacts = parsed.artifacts;
        }

        const toolEvents = this.extractToolEvents(parsed);
        if (toolEvents.length > 0) {
            pendingDone.toolEvents = toolEvents;
        }

        const assistantMetadata = extractAssistantMetadata(parsed);
        if (assistantMetadata) {
            pendingDone.assistantMetadata = mergeAssistantMetadata(
                pendingDone.assistantMetadata,
                assistantMetadata,
            );
        }

        const events = [];

        if (parsed.type === 'done') {
            events.push(this.buildStatusEvent('ready', 'Reply complete'));
            events.push(this.buildDonePayload(pendingDone));
            return events;
        }

        if (parsed.type === 'progress') {
            const progress = parsed.progress && typeof parsed.progress === 'object'
                ? parsed.progress
                : {};
            const phase = extractDisplayText(progress.phase || parsed.phase || 'thinking') || 'thinking';
            const detail = extractDisplayText(progress.detail || parsed.detail || '');
            events.push(this.buildStatusEvent(phase, detail));
            events.push({
                type: 'progress',
                progress: {
                    ...progress,
                    phase,
                    detail,
                },
            });
            return events;
        }

        const isReasoningDelta = parsed.type === 'response.reasoning_summary_text.delta';
        const streamedReasoning = extractReasoningSummary(
            (isReasoningDelta ? (parsed.delta ?? parsed.reasoning_delta) : '')
            || parsed?.choices?.[0]?.delta?.reasoning
            || parsed?.choices?.[0]?.delta?.reasoning_text
            || parsed?.choices?.[0]?.delta?.reasoning_content
            || parsed?.choices?.[0]?.delta?.reasoning_details
            || parsed?.reasoning_delta
            || parsed?.output
            || '',
        );
        if ((isReasoningDelta && (parsed.delta || parsed.reasoning_delta)) || streamedReasoning) {
            const summary = extractReasoningSummary(parsed.summary || parsed.reasoningSummary || parsed.reasoning_summary || '')
                || streamedReasoning.trim();
            pendingDone.assistantMetadata = mergeAssistantMetadata(
                pendingDone.assistantMetadata,
                {
                    reasoningSummary: summary,
                    reasoningAvailable: true,
                },
            );
            events.push(this.buildStatusEvent('reasoning', 'Working through the answer'));
            events.push({
                type: 'reasoning_summary_delta',
                content: streamedReasoning,
                summary,
            });
        }

        if ((parsed.type === 'response.output_item.added' || parsed.type === 'response.output_item.done')
            && this.isToolOutputItem(parsed.item)) {
            const toolEvent = this.buildToolEventDetail(parsed.item, parsed.type);
            events.push(this.buildStatusEvent('checking-tools', toolEvent.detail));
            events.push({
                type: 'tool_event',
                stage: toolEvent.stage,
                toolName: toolEvent.toolName,
                detail: toolEvent.detail,
                item: parsed.item,
            });
        }

        const choiceToolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
        if (Array.isArray(choiceToolCalls) && choiceToolCalls.length > 0) {
            choiceToolCalls.forEach((toolCall, index) => {
                const indexedToolCall = {
                    ...toolCall,
                    index: Number.isInteger(Number(toolCall?.index)) && Number(toolCall.index) >= 0
                        ? Number(toolCall.index)
                        : index,
                };
                const toolEvent = this.buildToolEventDetail(indexedToolCall, 'response.output_item.added');
                events.push(this.buildStatusEvent('checking-tools', toolEvent.detail));
                events.push({
                    type: 'tool_event',
                    stage: toolEvent.stage,
                    toolName: toolEvent.toolName,
                    detail: toolEvent.detail,
                    item: indexedToolCall,
                });
            });
        }

        const content = this.getTextDeltaFromStreamPayload(parsed);
        if (content) {
            events.push(this.buildStatusEvent('writing', 'Writing the reply'));
            events.push({
                type: 'text_delta',
                content,
            });
        }

        if (parsed.type === 'response.completed' || this.isTerminalFinishReason(parsed.choices?.[0]?.finish_reason)) {
            events.push(this.buildStatusEvent('ready', 'Reply complete'));
            events.push(this.buildDonePayload(pendingDone));
        }

        return events;
    }

    /**
     * Parse error response to get user-friendly message
     */
    parseErrorMessage(error, response) {
        const detailedMessage = error?.details?.error?.message
            || error?.details?.message
            || error?.response?.error?.message
            || error?.response?.message;

        if (detailedMessage) {
            return detailedMessage;
        }

        const asString = (value) => {
            if (typeof value === 'string') {
                return value.trim();
            }
            if (value && typeof value === 'object' && typeof value.message === 'string') {
                return value.message.trim();
            }
            return '';
        };

        const rawErrorMessage = asString(error?.message)
            || asString(error?.cause?.message)
            || '';
        const responseErrorMessage = asString(error?.details?.error)
            || asString(error?.response?.error)
            || asString(error?.response?.error?.message)
            || asString(error?.details?.message)
            || asString(error?.error)
            || asString(error?.response?.message)
            || rawErrorMessage;
        const knownConnectionFailure = [
            'ECONNREFUSED',
            'ECONNRESET',
            'EPIPE',
            'ETIMEDOUT',
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'ENOTFOUND',
        ].some((token) => rawErrorMessage.toUpperCase().includes(token) || responseErrorMessage.toUpperCase().includes(token));

        if (responseErrorMessage) {
            return responseErrorMessage;
        }

        if (knownConnectionFailure) {
            return rawErrorMessage;
        }

        // Handle specific HTTP status codes
        if (response?.status === 400) {
            return 'Invalid request. Please check your message format and try again.';
        }
        if (response?.status === 401) {
            return 'Your login session is missing or expired. Sign in again.';
        }
        if (response?.status === 403) {
            return 'Access denied. You may not have permission to use this feature.';
        }
        if (response?.status === 404) {
            return 'The requested resource was not found.';
        }
        if (response?.status === 429) {
            return 'Rate limit exceeded. Please wait a moment and try again.';
        }
        if (response?.status >= 500) {
            return 'Server error. Please try again later.';
        }
        
        // Network errors
        if (error.name === 'AbortError') {
            return 'Request was cancelled.';
        }
        if (error.name === 'TypeError' || error.message?.includes('fetch')) {
            return rawErrorMessage || 'Network error. Please check your connection and try again.';
        }

        if (rawErrorMessage) {
            return rawErrorMessage;
        }
        
        return 'An unexpected error occurred';
    }

    // ============================================
    // Chat Methods
    // ============================================

    /**
     * Stream chat with the AI using OpenAI SDK or fetch fallback
     * @param {Array} messages - Array of messages in OpenAI format [{role, content}, ...]
     * @param {string} model - Model ID to use
     * @param {AbortSignal} signal - Optional abort signal for cancellation
     * @returns {AsyncGenerator} - Yields delta content
     */
    async *streamChat(messages, model = DEFAULT_CHAT_MODEL, signal = null, reasoningEffort = '', requestOptions = {}) {
        const selectedModel = resolvePreferredChatModelForWebChat(
            filterChatModelsForWebChat(this.modelsCache?.data || []),
            model,
            DEFAULT_CHAT_MODEL,
        );
        const params = {
            model: selectedModel,
            messages,
            stream: true,
            enableConversationExecutor: true,
            taskType: WEB_CHAT_API_TASK_TYPE,
            clientSurface: WEB_CHAT_API_CLIENT_SURFACE,
            metadata: buildWorkspaceAwareMetadata({
                clientSurface: WEB_CHAT_API_CLIENT_SURFACE,
                sessionIsolation: true,
                enableConversationExecutor: true,
                naturalContext: buildNaturalInteractionContext(messages, requestOptions?.naturalContext || {}),
                ...buildClientClockMetadata(),
                ...(requestOptions?.metadata && typeof requestOptions.metadata === 'object'
                    ? requestOptions.metadata
                    : {}),
            }),
        };

        if (isRemoteBuildAutonomyApproved()) {
            params.metadata.remoteBuildAutonomyApproved = true;
        }

        applyRequestExecutionProfile(params, requestOptions);
        applyRemoteBuildMetadata(params, messages);

        if (reasoningEffort) {
            params.reasoning_effort = reasoningEffort;
        }

        if (Array.isArray(requestOptions?.artifactIds) && requestOptions.artifactIds.length > 0) {
            params.artifact_ids = requestOptions.artifactIds;
        }

        if (requestOptions?.outputFormat) {
            params.output_format = requestOptions.outputFormat;
        }
        
        const requestSessionId = String(requestOptions?.sessionId || this.currentSessionId || '').trim();
        if (requestSessionId && !requestSessionId.startsWith('local_')) {
            params.session_id = requestSessionId;
        }

        // Create abort controller for this request
        const controller = new AbortController();
        const requestId = Date.now().toString();
        this.abortControllers.set(requestId, controller);
        
        // Link external signal if provided
        if (signal) {
            signal.addEventListener('abort', () => controller.abort());
        }

        try {
            yield* this.streamChatWithFetch(params, controller.signal, requestId, requestOptions);
        } finally {
            this.abortControllers.delete(requestId);
        }
    }

    /**
     * Stream chat using fetch fallback with retry logic
     */
    async *streamChatWithFetch(params, signal, requestId, requestOptions = {}) {
        let lastError = null;
        let requestSessionId = String(requestOptions?.sessionId || params.session_id || this.currentSessionId || '').trim();
        const bindClientSession = requestOptions?.bindClientSession !== false;
        
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = this.getRetryDelay(attempt - 1);
                    console.log(`Retrying stream chat (attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries + 1}) after ${delay}ms`);
                    yield { type: 'retry', attempt: attempt + 1, maxAttempts: RETRY_CONFIG.maxRetries + 1 };
                    await this.sleep(delay);
                }

                const response = await fetch(`${API_BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: buildGatewayHeaders({ 
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream',
                    }),
                    credentials: 'same-origin',
                    body: JSON.stringify(params),
                    signal: signal,
                });
                
                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}`);
                    error.status = response.status;
                    error.response = response;
                    
                    // Try to get error details from response
                    error.details = await this.parseErrorPayload(response);
                    
                    throw error;
                }

                const responseSessionId = response.headers.get('X-Session-Id');
                if (responseSessionId) {
                    requestSessionId = responseSessionId;
                    if (bindClientSession) {
                        this.currentSessionId = responseSessionId;
                    }
                }
                
                let pendingDone = {
                    sessionId: requestSessionId || this.currentSessionId,
                    artifacts: [],
                    toolEvents: [],
                    assistantMetadata: null,
                };
                let doneEmitted = false;

                yield this.buildStatusEvent('thinking', 'Preparing the reply');
                
                if (!streamGatewayResponse) {
                    throw new Error('Gateway SSE helpers are unavailable');
                }

                for await (const event of streamGatewayResponse(response, { emitImplicitDone: false })) {
                    if (event.type === 'error') {
                        const errorMessage = event.error?.message || event.error?.error?.message || 'Stream error';
                        throw new Error(errorMessage);
                    }

                    if (event.type === 'stream_open') {
                        console.debug('[WebChatAPI] Received stream_open from gateway SSE.');
                        yield {
                            type: 'stream_open',
                            source: 'gateway-sse',
                        };
                        continue;
                    }

                    if (event.sessionId) {
                        requestSessionId = event.sessionId;
                        if (bindClientSession) {
                            this.currentSessionId = event.sessionId;
                        }
                        pendingDone.sessionId = event.sessionId;
                    }

                    if (Array.isArray(event.artifacts) && event.artifacts.length > 0) {
                        pendingDone.artifacts = event.artifacts;
                    }

                    if (Array.isArray(event.toolEvents) && event.toolEvents.length > 0) {
                        pendingDone.toolEvents = event.toolEvents;
                    }

                    if (event.assistantMetadata) {
                        pendingDone.assistantMetadata = mergeAssistantMetadata(
                            pendingDone.assistantMetadata,
                            event.assistantMetadata,
                        );
                    }

                    switch (event.type) {
                        case 'text_delta':
                            if (event.content) {
                                yield this.buildStatusEvent('writing', 'Writing the reply');
                                yield {
                                    type: 'text_delta',
                                    content: event.content,
                                };
                            }
                            break;
                        case 'reasoning_delta': {
                            const summary = extractReasoningSummary(event.summary || event.content || '');
                            pendingDone.assistantMetadata = mergeAssistantMetadata(
                                pendingDone.assistantMetadata,
                                {
                                    reasoningSummary: summary,
                                    reasoningAvailable: true,
                                },
                            );
                            if (event.content) {
                                yield this.buildStatusEvent('reasoning', 'Working through the answer');
                                yield {
                                    type: 'reasoning_summary_delta',
                                    content: extractReasoningSummary(event.content || ''),
                                    summary,
                                };
                            }
                            break;
                        }
                        case 'tool_calls':
                            for (const toolCall of (Array.isArray(event.toolCalls) ? event.toolCalls : [])) {
                                const toolEvent = this.buildToolEventDetail(
                                    toolCall,
                                    event.stage === 'done' ? 'response.output_item.done' : 'response.output_item.added',
                                );
                                yield this.buildStatusEvent('checking-tools', toolEvent.detail);
                                yield {
                                    type: 'tool_event',
                                    stage: toolEvent.stage,
                                    toolName: toolEvent.toolName,
                                    detail: toolEvent.detail,
                                    item: toolCall,
                                };
                            }
                            break;
                        case 'progress': {
                            const progress = event.progress && typeof event.progress === 'object'
                                ? event.progress
                                : {};
                            const phase = extractDisplayText(progress.phase || event.phase || 'thinking') || 'thinking';
                            const detail = extractDisplayText(progress.detail || event.detail || '');
                            yield this.buildStatusEvent(phase, detail);
                            yield {
                                type: 'progress',
                                progress: {
                                    ...progress,
                                    phase,
                                    detail,
                                },
                                sessionId: event.sessionId || pendingDone.sessionId || requestSessionId,
                            };
                            break;
                        }
                        case 'done':
                            doneEmitted = true;
                            yield this.buildStatusEvent('ready', 'Reply complete');
                            yield this.buildDonePayload(pendingDone);
                            return;
                        case 'finish':
                            if (this.isTerminalFinishReason(event.finishReason)) {
                                doneEmitted = true;
                                yield this.buildStatusEvent('ready', 'Reply complete');
                                yield this.buildDonePayload(pendingDone);
                                return;
                            }
                            break;
                        default:
                            break;
                    }
                }
                
                // Success - reset retry count
                this.retryCount = 0;
                if (!doneEmitted) {
                    const error = new Error('Stream ended before completion.');
                    error.code = 'stream_incomplete';
                    throw error;
                }
                return;
                
            } catch (error) {
                lastError = error;
                
                // Don't retry if aborted
                if (error.name === 'AbortError') {
                    yield { type: 'error', error: 'Request cancelled', cancelled: true };
                    return;
                }
                
                // Don't retry non-retryable errors
                if (!this.isRetryableError(error)) {
                    const message = this.parseErrorMessage(error, error.response);
                    yield { type: 'error', error: message, status: error.status, details: error.details };
                    yield { type: 'done', sessionId: requestSessionId || this.currentSessionId };
                    return;
                }

                if (typeof requestOptions?.shouldResyncAfterDisconnect === 'function') {
                    const shouldResync = requestOptions.shouldResyncAfterDisconnect(error, {
                        attempt: attempt + 1,
                        maxAttempts: RETRY_CONFIG.maxRetries + 1,
                        hidden: typeof document !== 'undefined' ? document.hidden === true : false,
                        online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
                    });
                    if (shouldResync) {
                        yield {
                            type: 'resync_required',
                            reason: 'connection_interrupted',
                            attempt: attempt + 1,
                            maxAttempts: RETRY_CONFIG.maxRetries + 1,
                            sessionId: requestSessionId || this.currentSessionId,
                        };
                        return;
                    }
                }
                
                // Last attempt failed
                if (attempt === RETRY_CONFIG.maxRetries) {
                    const message = this.parseErrorMessage(error, error.response);
                    yield { type: 'error', error: message, status: error.status, details: error.details, retriesExhausted: true };
                    yield { type: 'done', sessionId: requestSessionId || this.currentSessionId };
                    return;
                }
            }
        }
    }

    async submitAlignmentFeedback(sessionId, messageId, feedback = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedSessionId || !normalizedMessageId) {
            throw new Error('A session and assistant message are required for alignment feedback.');
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/chat/${encodeURIComponent(normalizedSessionId)}/messages/${encodeURIComponent(normalizedMessageId)}/alignment-feedback`, {
            method: 'POST',
            headers: buildGatewayHeaders({
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            }),
            credentials: 'same-origin',
            body: JSON.stringify({
                rating: feedback.rating,
                reason: feedback.reason || '',
                clientSurface: WEB_CHAT_API_CLIENT_SURFACE,
            }),
        });

        if (!response.ok) {
            const payload = await this.parseErrorPayload(response);
            throw new Error(payload?.error || payload?.message || `Alignment feedback failed with HTTP ${response.status}`);
        }

        return response.json();
    }

    /**
     * Stream chat using OpenAI SDK
     */
    async *streamChatWithSDK(params, signal, requestId) {
        try {
            const stream = await this.client.chat.completions.create(params, {
                signal: signal
            });

            let pendingAssistantMetadata = null;
            yield this.buildStatusEvent('thinking', 'Preparing the reply');
             
            for await (const chunk of stream) {
                // Check if aborted
                if (signal?.aborted) {
                    yield { type: 'error', error: 'Request cancelled', cancelled: true };
                    yield this.buildDonePayload({
                        sessionId: this.currentSessionId,
                        toolEvents: [],
                        assistantMetadata: pendingAssistantMetadata,
                    });
                    return;
                }
                
                const reasoning = extractReasoningSummary(
                    chunk.choices[0]?.delta?.reasoning
                    || chunk.choices[0]?.delta?.reasoning_text
                    || chunk.choices[0]?.delta?.reasoning_content
                    || chunk.choices[0]?.delta?.reasoning_details
                    || '',
                );
                if (reasoning) {
                    const currentSummary = String(pendingAssistantMetadata?.reasoningSummary || '').trim();
                    const nextSummary = `${currentSummary}${reasoning}`.trim();
                    pendingAssistantMetadata = mergeAssistantMetadata(
                        pendingAssistantMetadata,
                        {
                            reasoningSummary: nextSummary,
                            reasoningAvailable: true,
                        },
                    );
                    yield this.buildStatusEvent('reasoning', 'Working through the answer');
                    yield {
                        type: 'reasoning_summary_delta',
                        content: reasoning,
                        summary: nextSummary,
                    };
                }

                const content = stripNullCharacters(chunk.choices[0]?.delta?.content || '');
                if (content) {
                    yield this.buildStatusEvent('writing', 'Writing the reply');
                    yield {
                        type: 'text_delta',
                        content,
                    };
                }
                
                if (chunk.session_id) {
                    this.currentSessionId = chunk.session_id;
                }

                const assistantMetadata = extractAssistantMetadata(chunk);
                if (assistantMetadata) {
                    pendingAssistantMetadata = mergeAssistantMetadata(pendingAssistantMetadata, assistantMetadata);
                }
                
                if (this.isTerminalFinishReason(chunk.choices[0]?.finish_reason)) {
                    yield this.buildStatusEvent('ready', 'Reply complete');
                    yield this.buildDonePayload({
                        sessionId: this.currentSessionId,
                        toolEvents: this.extractToolEvents(chunk),
                        assistantMetadata: pendingAssistantMetadata,
                    });
                    return;
                }
            }
             
            // Ensure we always send done
            yield this.buildDonePayload({
                sessionId: this.currentSessionId,
                toolEvents: [],
                assistantMetadata: pendingAssistantMetadata,
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                yield { type: 'error', error: 'Request cancelled', cancelled: true };
            } else {
                const message = this.parseErrorMessage(error);
                yield { type: 'error', error: message };
            }
            yield this.buildDonePayload({ sessionId: this.currentSessionId, toolEvents: [] });
        }
    }

    /**
     * Cancel an ongoing request
     */
    cancelRequest(requestId) {
        const controller = this.abortControllers.get(requestId);
        if (controller) {
            controller.abort();
            this.abortControllers.delete(requestId);
            return true;
        }
        return false;
    }

    /**
     * Cancel all ongoing requests
     */
    cancelAllRequests() {
        for (const [requestId, controller] of this.abortControllers) {
            controller.abort();
        }
        this.abortControllers.clear();
    }

    async cancelForegroundTurn(sessionId, requestId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            throw new Error('A session ID is required to cancel the active reply.');
        }

        const payload = {};
        const normalizedRequestId = String(requestId || '').trim();
        if (normalizedRequestId) {
            payload.requestId = normalizedRequestId;
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/sessions/${encodeURIComponent(normalizedSessionId)}/foreground/cancel`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.response = await this.parseErrorPayload(response);
            throw error;
        }

        return response.json();
    }

    /**
     * Non-streaming chat with the AI
     * @param {Array} messages - Array of messages in OpenAI format
     * @param {string} model - Model ID to use
     * @returns {Object} - Response with content and sessionId
     */
    async chat(messages, model = DEFAULT_CHAT_MODEL, reasoningEffort = '', requestOptions = {}) {
        const selectedModel = resolvePreferredChatModelForWebChat(
            filterChatModelsForWebChat(this.modelsCache?.data || []),
            model,
            DEFAULT_CHAT_MODEL,
        );
        const params = {
            model: selectedModel,
            messages,
            stream: false,
            enableConversationExecutor: true,
            taskType: WEB_CHAT_API_TASK_TYPE,
            clientSurface: WEB_CHAT_API_CLIENT_SURFACE,
            metadata: {
                clientSurface: WEB_CHAT_API_CLIENT_SURFACE,
                sessionIsolation: true,
                enableConversationExecutor: true,
                ...buildClientClockMetadata(),
                ...(requestOptions?.metadata && typeof requestOptions.metadata === 'object'
                    ? requestOptions.metadata
                    : {}),
            },
        };

        if (isRemoteBuildAutonomyApproved()) {
            params.metadata.remoteBuildAutonomyApproved = true;
        }

        applyRequestExecutionProfile(params, requestOptions);
        applyRemoteBuildMetadata(params, messages);

        if (reasoningEffort) {
            params.reasoning_effort = reasoningEffort;
        }

        if (Array.isArray(requestOptions?.artifactIds) && requestOptions.artifactIds.length > 0) {
            params.artifact_ids = requestOptions.artifactIds;
        }

        if (requestOptions?.outputFormat) {
            params.output_format = requestOptions.outputFormat;
        }
        
        if (this.currentSessionId && !String(this.currentSessionId).startsWith('local_')) {
            params.session_id = this.currentSessionId;
        }

        // Use fetch if SDK not available
        if (!this.client) {
            return this.chatWithFetch(params);
        }

        try {
            const response = await this.client.chat.completions.create(params);
            
            if (response.session_id) {
                this.currentSessionId = response.session_id;
            }
            
            return {
                content: extractAssistantText(
                    response?.choices?.[0]?.message?.content
                    ?? response?.choices?.[0]?.message
                    ?? response?.output_text
                    ?? response
                ),
                sessionId: this.currentSessionId,
                toolEvents: this.extractToolEvents(response),
                assistantMetadata: extractAssistantMetadata(response),
            };
        } catch (error) {
            console.error('Chat error:', error);
            return {
                content: `[Error: ${this.parseErrorMessage(error)}]`,
                sessionId: this.currentSessionId,
                toolEvents: [],
                error: true
            };
        }
    }

    /**
     * Non-streaming chat with fetch fallback and retry
     */
    async chatWithFetch(params) {
        let lastError = null;
        
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = this.getRetryDelay(attempt - 1);
                    await this.sleep(delay);
                }

                const response = await fetch(`${API_BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: buildGatewayHeaders({
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    }),
                    credentials: 'same-origin',
                    body: JSON.stringify(params),
                });
                
                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}`);
                    error.status = response.status;
                    error.details = await this.parseErrorPayload(response);
                    error.response = response;
                    throw error;
                }
                
                const data = await response.json();
                
                if (data.session_id || data.sessionId) {
                    this.currentSessionId = data.session_id || data.sessionId;
                }
                
                return {
                    content: extractAssistantText(
                        data?.choices?.[0]?.message?.content
                        ?? data?.choices?.[0]?.message
                        ?? data?.output_text
                        ?? data
                    ),
                    sessionId: this.currentSessionId,
                    toolEvents: this.extractToolEvents(data),
                    assistantMetadata: extractAssistantMetadata(data),
                };
            } catch (error) {
                lastError = error;
                
                if (!this.isRetryableError(error) || attempt === RETRY_CONFIG.maxRetries) {
                    return {
                        content: `[Error: ${this.parseErrorMessage(error)}]`,
                        sessionId: this.currentSessionId,
                        error: true
                    };
                }
            }
        }
    }

    // ============================================
    // Model API
    // ============================================

    async getModels(forceRefresh = false) {
        // Check cache first
        if (!forceRefresh && this.modelsCache && this.modelsCacheExpiry > Date.now()) {
            return this.modelsCache;
        }

        // Check localStorage cache (wrapped for Tracking Prevention compatibility)
        if (!forceRefresh) {
            const cached = this.safeStorageGet('kimibuilt_models_cache');
            const cachedExpiry = this.safeStorageGet('kimibuilt_models_cache_expiry');
            if (cached && cachedExpiry && parseInt(cachedExpiry) > Date.now()) {
                try {
                    this.modelsCache = JSON.parse(cached);
                    this.modelsCacheExpiry = parseInt(cachedExpiry);
                    return this.modelsCache;
                } catch (e) {
                    console.warn('Failed to parse cached models');
                }
            }
        }

        // Try fetch first if SDK not available
        if (!this.client) {
            try {
                const response = await fetch(`${API_BASE_URL}/models`, {
                    headers: buildGatewayHeaders({
                        'Accept': 'application/json',
                    }),
                    credentials: 'same-origin',
                });
                if (response.ok) {
                    const data = await response.json();
                    this.modelsCache = data;
                    this.modelsCacheExpiry = Date.now() + this.modelsCacheDuration;
                    return data;
                }
            } catch (e) {
                console.warn('Fetch fallback failed:', e);
            }
            return this.getDefaultModels();
        }

        try {
            const response = await this.client.models.list();
            
            // Format response to match OpenAI API structure
            const data = {
                object: 'list',
                data: response.data || [],
            };
            
            // Update cache
            this.modelsCache = data;
            this.modelsCacheExpiry = Date.now() + this.modelsCacheDuration;
            
            this.safeStorageSet('kimibuilt_models_cache', JSON.stringify(data));
            this.safeStorageSet('kimibuilt_models_cache_expiry', String(this.modelsCacheExpiry));
            
            return data;
        } catch (error) {
            console.error('Failed to fetch models:', error);
            
            // Return cached models if available
            if (this.modelsCache) {
                return this.modelsCache;
            }
            
            return this.getDefaultModels();
        }
    }

    getDefaultModels() {
        return {
            object: 'list',
            data: [
                { id: DEFAULT_CHAT_MODEL, object: 'model', created: Date.now(), owned_by: 'router' },
                { id: 'gpt-5.4', object: 'model', created: Date.now(), owned_by: 'openai' },
                { id: 'gpt-5.3-instant', object: 'model', created: Date.now(), owned_by: 'openai' },
                { id: 'gpt-5.3', object: 'model', created: Date.now(), owned_by: 'openai' },
            ],
        };
    }

    filterChatModels(models = []) {
        return filterChatModelsForWebChat(models);
    }

    getDefaultImageModels() {
        const created = Date.now();
        const models = [
            {
                id: 'gpt-image-2',
                name: 'GPT Image 2',
                description: 'State-of-the-art OpenAI image generation',
                sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
                qualities: ['auto', 'low', 'medium', 'high'],
                styles: [],
                maxImages: 5,
            },
            {
                id: 'gpt-image-1.5',
                name: 'GPT Image 1.5',
                description: 'Previous OpenAI GPT Image release',
                sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
                qualities: ['auto', 'low', 'medium', 'high'],
                styles: [],
                maxImages: 5,
            },
        ];

        return {
            object: 'list',
            data: models.map((model) => ({
                id: model.id,
                object: 'model',
                created,
                owned_by: 'openai',
                metadata: model,
            })),
        };
    }

    normalizeImageModelRecord(model = {}) {
        const id = String(model?.id || '').trim();
        const metadata = model?.metadata && typeof model.metadata === 'object' ? model.metadata : {};
        const lower = id.toLowerCase();

        return {
            id,
            object: model.object || 'model',
            created: model.created || Date.now(),
            owned_by: model.owned_by || metadata.owned_by || 'openai',
            metadata: {
                ...metadata,
                id,
                name: metadata.name || id,
                sizes: Array.isArray(metadata.sizes) && metadata.sizes.length > 0
                    ? metadata.sizes
                    : (lower.includes('gpt-image')
                        ? ['auto', '1024x1024', '1536x1024', '1024x1536']
                        : ['1024x1024']),
                qualities: Array.isArray(metadata.qualities) && metadata.qualities.length > 0
                    ? metadata.qualities
                    : (lower.includes('gpt-image') ? ['auto', 'low', 'medium', 'high'] : []),
                styles: Array.isArray(metadata.styles) ? metadata.styles : [],
                maxImages: metadata.maxImages || 5,
            },
        };
    }

    async getImageModels() {
        const baseUrl = API_BASE_URL.replace('/v1', '');

        try {
            const response = await fetch(`${API_BASE_URL}/models`, {
                headers: buildGatewayHeaders({
                    'Accept': 'application/json',
                }),
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            const imageModels = (Array.isArray(data.data) ? data.data : [])
                .filter((model) => Array.isArray(model.capabilities) && model.capabilities.includes('image_generation'))
                .map((model) => this.normalizeImageModelRecord(model))
                .filter((model) => model.id);

            if (imageModels.length > 0) {
                return { object: 'list', data: imageModels };
            }

            const legacyResponse = await fetch(`${baseUrl}/api/images/models`, {
                headers: buildGatewayHeaders({
                    'Accept': 'application/json',
                }),
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!legacyResponse.ok) {
                throw new Error(`HTTP ${legacyResponse.status}`);
            }

            const legacyData = await legacyResponse.json();
            return {
                object: 'list',
                data: (legacyData.models || []).map((model) => this.normalizeImageModelRecord({
                    ...model,
                    metadata: model,
                })),
            };
        } catch (error) {
            console.warn('[API] Failed to fetch image models:', error.message);
            return this.getDefaultImageModels();
        }
    }

    // ============================================
    // Image Generation API
    // ============================================

    /**
     * Generate images using the OpenAI-compatible backend API
     * POST /v1/images/generations
     * @param {Object} options - Image generation options
     * @param {string} options.prompt - Image prompt (required)
     * @param {string} options.model - Model to use (optional, defaults to the backend image model)
     * @param {string} options.size - Image size (optional, default: 'auto')
     * @param {string|null} options.quality - Image quality (optional)
     * @param {string|null} options.style - Image style (optional)
     * @param {number} options.n - Number of images (optional, default: 1)
     * @param {string} options.sessionId - Session ID (optional)
     * @returns {Promise<Object>} - { sessionId, created, data: [{ url, revised_prompt }], model, size, quality, style }
     */
    async generateImage(options = {}) {
        const {
            prompt,
            model = 'gpt-image-2',
            size = 'auto',
            quality = null,
            style = null,
            n = 1,
            batchMode = null,
            response_format = null,
            sessionId = null
        } = options;

        const params = {
            prompt,
            model: model || 'gpt-image-2',
            size,
            n: n || 1,
            taskType: 'image',
            clientSurface: WEB_CHAT_API_CLIENT_SURFACE,
        };

        if (response_format != null) {
            params.response_format = response_format;
        }
        if (quality != null) {
            params.quality = quality;
        }
        if (style != null) {
            params.style = style;
        }
        if (batchMode != null) {
            params.batchMode = batchMode;
        }

        if (sessionId || this.currentSessionId) {
            params.sessionId = sessionId || this.currentSessionId;
        }

        let lastError = null;
        
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    await this.sleep(this.getRetryDelay(attempt - 1));
                }

                const response = await fetch(`${API_BASE_URL}/images/generations`, {
                    method: 'POST',
                    headers: buildGatewayHeaders({
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    }),
                    credentials: 'same-origin',
                    body: JSON.stringify(params),
                });
                
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const error = new Error(errorData.error?.message || `HTTP ${response.status}`);
                    error.status = response.status;
                    error.response = errorData;
                    throw error;
                }
                
                const data = await response.json();
                
                // Update current session ID if returned
                if (data.sessionId || data.session_id) {
                    this.currentSessionId = data.sessionId || data.session_id;
                }
                
                return {
                    ...data,
                    sessionId: data.sessionId || data.session_id || this.currentSessionId,
                };
                
            } catch (error) {
                lastError = error;
                
                if (!this.isRetryableError(error) || attempt === RETRY_CONFIG.maxRetries) {
                    throw new Error(this.parseErrorMessage(error, error.response));
                }
            }
        }
        
        throw new Error(this.parseErrorMessage(lastError, lastError?.response));
    }

    /**
     * Search for images on Unsplash
     * GET /api/unsplash/search
     * @param {string} query - Search query
     * @param {Object} options - Search options
     * @param {number} options.page - Page number (default: 1)
     * @param {number} options.perPage - Results per page (default: 10, max: 30)
     * @param {string} options.orderBy - Sort order: 'relevant' or 'latest'
     * @param {string} options.orientation - Filter: 'landscape', 'portrait', or 'squarish'
     * @returns {Promise<Object>} - { source, query, total, total_pages, results: [...] }
     */
    async searchUnsplash(query, options = {}) {
        const {
            page = 1,
            perPage = 10,
            orderBy = 'relevant',
            orientation = null
        } = options;

        if (!query || query.trim() === '') {
            throw new Error('Search query is required');
        }

        // Extract base URL without /v1
        const baseUrl = API_BASE_URL.replace('/v1', '');
        
        const params = new URLSearchParams({
            q: query.trim(),
            page: String(page),
            per_page: String(Math.min(perPage, 30)),
            order_by: orderBy,
        });

        if (orientation) {
            params.append('orientation', orientation);
        }

        let lastError = null;
        
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    await this.sleep(this.getRetryDelay(attempt - 1));
                }

                const response = await fetch(`${baseUrl}/api/unsplash/search?${params.toString()}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                });
                
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const error = new Error(errorData.error?.message || `HTTP ${response.status}`);
                    error.status = response.status;
                    error.response = errorData;
                    throw error;
                }
                
                return await response.json();
                
            } catch (error) {
                lastError = error;
                
                if (!this.isRetryableError(error) || attempt === RETRY_CONFIG.maxRetries) {
                    throw new Error(this.parseErrorMessage(error, error.response));
                }
            }
        }
        
        throw new Error(this.parseErrorMessage(lastError, lastError?.response));
    }

    /**
     * Get available image generation models
     * GET /v1/models, filtered to image_generation capabilities
     * @returns {Promise<Object>} - { models: [...] }
     */
    async getImageModelsFromAPI() {
        const response = await this.getImageModels();
        return response.data.map((model) => model.metadata || { id: model.id, name: model.id || 'Gateway Default' });
    }

    async getTtsVoices() {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/tts/voices`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
        });

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.response = await this.parseErrorPayload(response);
            throw error;
        }

        return response.json();
    }

    async synthesizeSpeech(text, options = {}) {
        const payload = {
            text: String(text || ''),
        };

        if (options.voiceId) {
            payload.voiceId = options.voiceId;
        }
        if (options.provider) {
            payload.provider = String(options.provider || '');
        }
        if (Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0) {
            payload.timeoutMs = Number(options.timeoutMs);
        }
        if (typeof options.allowProviderFallback === 'boolean') {
            payload.allowProviderFallback = options.allowProviderFallback;
        }

        const response = await fetchTtsWithTimeout(`${BASE_URL_WITHOUT_API}/api/tts/synthesize`, {
            method: 'POST',
            headers: {
                'Accept': 'audio/wav, application/json',
                'Content-Type': 'application/json',
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload),
        }, resolveTtsSynthesisClientTimeoutMs(options));

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.response = await this.parseErrorPayload(response);
            throw new Error(this.parseErrorMessage(error, error.response));
        }

        return {
            blob: await response.blob(),
            contentType: response.headers.get('content-type') || 'audio/wav',
            voiceId: response.headers.get('x-tts-voice-id') || '',
            voiceLabel: response.headers.get('x-tts-voice-label') || '',
            provider: response.headers.get('x-tts-provider') || 'unknown',
            fallbackProvider: response.headers.get('x-tts-fallback-provider') || '',
            fallbackReason: response.headers.get('x-tts-fallback-reason') || '',
        };
    }

    async transcribeAudio(audioBlob, options = {}) {
        if (!(audioBlob instanceof Blob)) {
            throw new Error('An audio recording is required for transcription.');
        }

        const formData = new FormData();
        const mimeType = String(audioBlob.type || 'audio/webm').trim() || 'audio/webm';
        const fallbackExtension = mimeType.includes('/')
            ? (mimeType.split('/')[1].split(';')[0].trim() || 'webm')
            : 'webm';
        formData.append('file', audioBlob, options.filename || `voice-note.${fallbackExtension}`);

        if (options.language) {
            formData.append('language', String(options.language));
        }

        if (options.prompt) {
            formData.append('prompt', String(options.prompt));
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/audio/transcribe`, {
            method: 'POST',
            credentials: 'same-origin',
            body: formData,
        });

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.response = await this.parseErrorPayload(response);
            throw new Error(this.parseErrorMessage(error, error.response));
        }

        return response.json();
    }

    async getAvailableTools(category = null, options = {}) {
        const params = new URLSearchParams();
        if (category) {
            params.set('category', category);
        }
        params.set('taskType', WEB_CHAT_API_TASK_TYPE);
        params.set('clientSurface', WEB_CHAT_API_CLIENT_SURFACE);
        if (options.executionProfile) {
            params.set('executionProfile', String(options.executionProfile));
        }
        if (options.includeAll === true) {
            params.set('includeAll', 'true');
        }
        if (this.currentSessionId && !String(this.currentSessionId).startsWith('local_')) {
            params.set('sessionId', this.currentSessionId);
        }

        const url = `${BASE_URL_WITHOUT_API}/api/tools/available${params.toString() ? `?${params.toString()}` : ''}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Failed to load tools: HTTP ${response.status}`);
        }

        const data = await response.json();
        return {
            tools: data.data || [],
            meta: data.meta || {},
        };
    }

    async listSkills(options = {}) {
        const params = new URLSearchParams();
        if (options.search) {
            params.set('search', String(options.search));
        }
        if (options.includeBody === true) {
            params.set('includeBody', 'true');
        }
        if (options.includeDisabled === true) {
            params.set('includeDisabled', 'true');
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/skills${params.toString() ? `?${params.toString()}` : ''}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Failed to load skills: HTTP ${response.status}`);
        }

        const data = await response.json();
        return {
            skills: data.data || [],
            meta: data.meta || {},
        };
    }

    async getSkill(skillId, options = {}) {
        const params = new URLSearchParams();
        if (options.includeBody !== false) {
            params.set('includeBody', 'true');
        }
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/skills/${encodeURIComponent(skillId)}${params.toString() ? `?${params.toString()}` : ''}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Failed to load skill: HTTP ${response.status}`);
        }

        const data = await response.json();
        return data.data || null;
    }

    async createSkill(payload = {}) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/skills`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const data = await this.parseErrorPayload(response);
            throw new Error(data?.error?.message || data?.error || data?.message || `Skill create failed: HTTP ${response.status}`);
        }

        return response.json();
    }

    async updateSkill(skillId, payload = {}) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/skills/${encodeURIComponent(skillId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const data = await this.parseErrorPayload(response);
            throw new Error(data?.error?.message || data?.error || data?.message || `Skill update failed: HTTP ${response.status}`);
        }

        return response.json();
    }

    async draftSkill(payload = {}) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/skills/draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const data = await this.parseErrorPayload(response);
            throw new Error(data?.error?.message || data?.error || data?.message || `Skill draft failed: HTTP ${response.status}`);
        }

        const data = await response.json();
        return data.data || data;
    }

    async getRemoteToolCatalog() {
        const response = await this.getAvailableTools('ssh', {
            executionProfile: 'remote-build',
        });
        const tools = Array.isArray(response?.tools) ? response.tools : [];
        const remoteAgent = tools.find((tool) => tool.id === 'remote-cli-agent') || null;
        const remoteTool = tools.find((tool) => tool.id === 'remote-command') || null;
        const remoteWorkbench = tools.find((tool) => tool.id === 'remote-workbench') || null;

        return {
            tools,
            runtime: response?.meta?.runtime || null,
            remoteAgent,
            remoteTool,
            remoteWorkbench,
            catalog: remoteTool?.runtime?.commandCatalog || [],
            meta: response?.meta || {},
        };
    }

    async getToolDoc(toolId) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/tools/docs/${encodeURIComponent(toolId)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Failed to load tool documentation: HTTP ${response.status}`);
        }

        const data = await response.json();
        return data.data || null;
    }

    async invokeTool(toolId, params = {}, options = {}) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/tools/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tool: toolId,
                params,
                sessionId: this.currentSessionId,
                model: this.currentModel || null,
                taskType: WEB_CHAT_API_TASK_TYPE,
                clientSurface: WEB_CHAT_API_CLIENT_SURFACE,
                ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
                metadata: buildWorkspaceAwareMetadata({
                    clientSurface: WEB_CHAT_API_CLIENT_SURFACE,
                    sessionIsolation: true,
                    ...buildClientClockMetadata(),
                    ...(options.metadata && typeof options.metadata === 'object'
                        ? options.metadata
                        : {}),
                }),
            }),
        });

        if (!response.ok) {
            const payload = await this.parseErrorPayload(response);
            throw new Error(payload?.error?.message || payload?.error || payload?.message || `Tool invocation failed: HTTP ${response.status}`);
        }

        const data = await response.json();
        if (data.sessionId) {
            this.currentSessionId = data.sessionId;
        }
        return {
            result: data.data,
            sessionId: data.sessionId || this.currentSessionId || null,
        };
    }

    async createAsyncRun(payload = {}) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/async-lab/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
        });

        if (!response.ok) {
            const error = await this.parseErrorPayload(response);
            throw new Error(error?.error?.message || error?.message || `Async run failed: HTTP ${response.status}`);
        }

        return response.json();
    }

    async getAsyncRun(runId = '', options = {}) {
        const normalizedRunId = String(runId || '').trim();
        if (!normalizedRunId) {
            throw new Error('Async run id is required.');
        }
        const after = Number(options.after || 0) || 0;
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/async-lab/runs/${encodeURIComponent(normalizedRunId)}?after=${encodeURIComponent(after)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            const error = await this.parseErrorPayload(response);
            throw new Error(error?.error?.message || error?.message || `Async run lookup failed: HTTP ${response.status}`);
        }

        return response.json();
    }

    async invokeRemoteCommand(command, options = {}) {
        const normalizedCommand = String(command || '').trim();
        if (!normalizedCommand) {
            throw new Error('Remote command is required.');
        }

        return this.invokeTool('remote-command', {
            command: normalizedCommand,
            profile: options.profile || 'build',
            workflowAction: options.workflowAction || 'web-chat-remote-manual-run',
            timeout: options.timeout || 120000,
        }, {
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
                remoteCommandSource: 'web-chat',
            },
        });
    }

    async invokeRemoteCliAgent(task, options = {}) {
        const normalizedTask = String(task || '').trim();
        const normalizedModel = String(options.model || '').trim();
        if (!normalizedTask) {
            throw new Error('Remote agent task is required.');
        }

        return this.invokeTool('remote-cli-agent', {
            task: normalizedTask,
            waitMs: options.waitMs || 30000,
            maxTurns: options.maxTurns || 30,
            ...(normalizedModel ? { model: normalizedModel } : {}),
              ...(options.cwd ? { cwd: options.cwd } : {}),
              ...(options.targetId ? { targetId: options.targetId } : {}),
              ...(options.sessionId ? { sessionId: options.sessionId } : {}),
              ...(options.mcpSessionId ? { mcpSessionId: options.mcpSessionId } : {}),
              ...(options.adminMode !== undefined ? { adminMode: options.adminMode === true } : {}),
          }, {
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
                remoteCommandSource: 'web-chat',
            },
        });
    }

    async getSessionWorkloads(sessionId) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/sessions/${encodeURIComponent(sessionId)}/workloads`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin',
        });

        if (response.status === 404 || response.status === 503) {
            return { available: false, workloads: [] };
        }
        if (!response.ok) {
            throw new Error(`Failed to load workloads: HTTP ${response.status}`);
        }

        const data = await response.json();
        return {
            available: data.available !== false,
            workloads: data.workloads || [],
        };
    }

    async getManagedAppProgress(appRef) {
        const normalizedAppRef = String(appRef || '').trim();
        if (!normalizedAppRef) {
            return null;
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/managed-apps/${encodeURIComponent(normalizedAppRef)}/progress`, {
            method: 'GET',
            headers: buildGatewayHeaders({ 'Accept': 'application/json' }),
            credentials: 'same-origin',
            cache: 'no-store',
        });

        if (response.status === 404 || response.status === 503) {
            return null;
        }
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error?.message || `Failed to load managed app progress: HTTP ${response.status}`);
        }

        return response.json();
    }

    async iterateManagedApp(appRef, payload = {}) {
        const normalizedAppRef = String(appRef || '').trim();
        if (!normalizedAppRef) {
            throw new Error('Managed app reference is required.');
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/managed-apps/${encodeURIComponent(normalizedAppRef)}/iterations`, {
            method: 'POST',
            headers: buildGatewayHeaders({
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            }),
            credentials: 'same-origin',
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = await this.parseErrorPayload(response);
            throw new Error(error?.error?.message || `Failed to start managed app iteration: HTTP ${response.status}`);
        }

        return response.json();
    }

    async createSessionWorkload(sessionId, payload = {}) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/sessions/${encodeURIComponent(sessionId)}/workloads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = await this.parseErrorPayload(response);
            throw new Error(error?.error?.message || `Failed to create workload: HTTP ${response.status}`);
        }

        return response.json();
    }

    async updateWorkload(workloadId, payload = {}) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/workloads/${encodeURIComponent(workloadId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error?.message || `Failed to update workload: HTTP ${response.status}`);
        }

        return response.json();
    }

    async deleteWorkload(workloadId) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/workloads/${encodeURIComponent(workloadId)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });

        if (!response.ok && response.status !== 204) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error?.message || `Failed to delete workload: HTTP ${response.status}`);
        }
    }

    async runWorkload(workloadId) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/workloads/${encodeURIComponent(workloadId)}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error?.message || `Failed to run workload: HTTP ${response.status}`);
        }

        return response.json();
    }

    async pauseWorkload(workloadId) {
        return this.postWorkloadAction(workloadId, 'pause');
    }

    async resumeWorkload(workloadId) {
        return this.postWorkloadAction(workloadId, 'resume');
    }

    async getWorkloadRuns(workloadId, limit = 10) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/workloads/${encodeURIComponent(workloadId)}/runs?limit=${encodeURIComponent(limit)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin',
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error?.message || `Failed to load workload runs: HTTP ${response.status}`);
        }

        const data = await response.json();
        return data.runs || [];
    }

    async postWorkloadAction(workloadId, action) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/workloads/${encodeURIComponent(workloadId)}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error?.message || `Failed to ${action} workload: HTTP ${response.status}`);
        }

        return response.json();
    }

    // ============================================
    // Utility Methods
    // ============================================

    async checkHealth() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            const baseUrl = API_BASE_URL.replace('/v1', '');
            const response = await fetch(`${baseUrl}/live`, {
                signal: controller.signal,
                credentials: 'same-origin',
                cache: 'no-store',
            });

            clearTimeout(timeoutId);

            let data = null;
            try {
                data = await response.json();
            } catch (_error) {
                data = null;
            }

            // Treat any HTTP response from the lightweight liveness endpoint as
            // "connected". Reserve the disconnected state for transport failures.
            return {
                connected: true,
                ok: response.ok,
                status: response.status,
                data,
            };
        } catch (error) {
            clearTimeout(timeoutId);
            return { connected: false, error: error.message };
        }
    }

    clearModelsCache() {
        this.modelsCache = null;
        this.modelsCacheExpiry = null;
        this.safeStorageRemove('kimibuilt_models_cache');
        this.safeStorageRemove('kimibuilt_models_cache_expiry');
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    getSessionId() {
        return this.currentSessionId;
    }

    appendRealtimeSocketToken(socketUrl, token = API_KEY) {
        const accessToken = String(token || API_KEY || '').trim();
        if (!accessToken) {
            return socketUrl;
        }

        try {
            const parsedUrl = new URL(socketUrl, window.location.href);
            if (!parsedUrl.searchParams.has('access_token')) {
                parsedUrl.searchParams.set('access_token', accessToken);
            }
            return parsedUrl.toString();
        } catch (_error) {
            const separator = String(socketUrl || '').includes('?') ? '&' : '?';
            return `${socketUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;
        }
    }

    getRealtimeSocketUrl(pathname = '/ws') {
        return this.appendRealtimeSocketToken(buildGatewayRealtimeUrl(BASE_URL_WITHOUT_API, pathname), API_KEY);
    }

    async getAuthenticatedRealtimeSocketUrl(pathname = '/ws') {
        const socketUrl = buildGatewayRealtimeUrl(BASE_URL_WITHOUT_API, pathname);

        try {
            const response = await fetch(`${BASE_URL_WITHOUT_API}/api/auth/ws-token`, {
                method: 'GET',
                headers: buildGatewayHeaders({ 'Accept': 'application/json' }),
                credentials: 'same-origin',
                cache: 'no-store',
            });

            if (response.ok) {
                const data = await response.json().catch(() => ({}));
                if (data?.token) {
                    return this.appendRealtimeSocketToken(socketUrl, data.token);
                }
            }
        } catch (_error) {
            // Fall back to the static gateway token below.
        }

        return this.appendRealtimeSocketToken(socketUrl, API_KEY);
    }
}

// Create global API client instance
const apiClient = new OpenAIAPIClient();
window.apiClient = apiClient;


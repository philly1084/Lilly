/**
 * API Client for LillyBuilt Notes
 * Mirrors web-chat API client for making AI calls to the backend
 * Supports streaming chat, model fetching, and health checks
 */

// ============================================
// Configuration
// ============================================

const CURRENT_ORIGIN = `${window.location.protocol}//${window.location.host}`;
const FILE_PREVIEW_BACKEND_ORIGIN = 'http://localhost:3000';
const API_ORIGIN = window.location.protocol === 'file:'
    ? FILE_PREVIEW_BACKEND_ORIGIN
    : CURRENT_ORIGIN;

const API_BASE_URL = `${API_ORIGIN}/v1`;

const BASE_URL_WITHOUT_API = API_ORIGIN;
const NOTES_TASK_TYPE = 'notes';
const NOTES_CLIENT_SURFACE = 'notes';
const NOTES_REMOTE_BUILD_AUTONOMY_APPROVED = true;
// Retry configuration
const RETRY_CONFIG = {
    maxRetries: 3,
    retryDelay: 1000, // Initial delay in ms
    retryMultiplier: 2,
    maxDelay: 10000
};

const TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);

// ============================================
// Utility Functions
// ============================================

/**
 * Sleep utility for retry delays
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate retry delay with exponential backoff
 */
function getRetryDelay(attempt) {
    const delay = RETRY_CONFIG.retryDelay * Math.pow(RETRY_CONFIG.retryMultiplier, attempt);
    return Math.min(delay, RETRY_CONFIG.maxDelay);
}

function isToolRuntimeError(error) {
    const message = `${extractErrorDetailsMessage(error?.details)} ${String(error?.message || '')}`.trim().toLowerCase();
    if (!message) {
        return false;
    }

    return [
        /\bssh\b/,
        /\bssh-execute\b/,
        /\bremote-build\b/,
        /\bremote command\b/,
        /\btool invocation failed\b/,
        /\btool execution failed\b/,
        /\bkubectl\b/,
        /\bk3s\b/,
        /\bcluster\b/,
        /\bpermission denied\b/,
        /\bconnection refused\b/,
        /\btimed out\b/,
        /\bhost\b/,
        /\bcredential\b/,
    ].some((pattern) => pattern.test(message));
}

/**
 * Determine if an error is retryable
 */
function isRetryableError(error) {
    // Network errors are retryable
    if (error.name === 'TypeError' || error.name === 'NetworkError' || error.message?.includes('fetch')) {
        return true;
    }
    if (isToolRuntimeError(error)) {
        return false;
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

function isTerminalFinishReason(finishReason) {
    if (!finishReason) {
        return false;
    }

    return TERMINAL_FINISH_REASONS.has(String(finishReason).toLowerCase());
}

function stripNullCharacters(value = '') {
    return String(value || '').replace(/\u0000/g, '');
}

function extractStreamSessionId(payload = {}) {
    return payload?.session_id
        || payload?.sessionId
        || payload?.response?.session_id
        || payload?.response?.sessionId
        || null;
}

function extractStreamTextDelta(payload = {}) {
    if (payload?.type === 'response.output_text.delta') {
        return stripNullCharacters(payload.delta || '');
    }

    if (payload?.type === 'delta') {
        return stripNullCharacters(payload.content || payload.delta || '');
    }

    return stripNullCharacters(
        payload?.choices?.[0]?.delta?.content
        || payload?.output_text_delta
        || '',
    );
}

function extractReasoningSummary(value) {
    if (typeof value === 'string') {
        return stripNullCharacters(value).trim();
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => extractReasoningSummary(entry))
            .filter(Boolean)
            .join('')
            .trim();
    }

    if (!value || typeof value !== 'object') {
        return '';
    }

    if (value.type === 'reasoning') {
        return extractReasoningSummary(
            value.summary
            || value.summary_text
            || value.reasoning
            || value.reasoning_text
            || value.reasoning_content
            || value.text
            || value.content
            || '',
        );
    }

    const directCandidates = [
        value.reasoningSummary,
        value.reasoning_summary,
        value.reasoning,
        value.reasoning_text,
        value.reasoningText,
        value.reasoning_content,
        value.reasoningContent,
        value.reasoning_details,
        value.reasoningDetails,
        value.summary,
        value.summary_text,
    ];

    for (const candidate of directCandidates) {
        const summary = extractReasoningSummary(candidate);
        if (summary) {
            return summary;
        }
    }

    return '';
}

function extractAssistantMetadata(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const metadata = payload.assistantMetadata
        || payload.assistant_metadata
        || payload.metadata
        || payload.response?.metadata
        || payload.choices?.[0]?.message
        || payload.choices?.[0]?.delta
        || null;
    const reasoningSummary = extractReasoningSummary(metadata || payload);

    return reasoningSummary
        ? { reasoningSummary, reasoningAvailable: true }
        : null;
}

function isTerminalStreamPayload(payload = {}) {
    return payload?.type === 'done'
        || payload?.type === 'response.completed'
        || isTerminalFinishReason(payload?.choices?.[0]?.finish_reason);
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

function extractToolEvents(payload = {}) {
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

    return [];
}

function extractErrorDetailsMessage(details) {
    if (!details) {
        return '';
    }

    if (typeof details === 'string') {
        return details;
    }

    if (typeof details?.error === 'string') {
        return details.error;
    }

    if (typeof details?.message === 'string') {
        return details.message;
    }

    if (typeof details?.error?.message === 'string') {
        return details.error.message;
    }

    return '';
}

function isSessionNotFoundError(error) {
    const message = extractErrorDetailsMessage(error?.details) || String(error?.message || '');
    return error?.status === 404 && /session not found/i.test(message);
}

/**
 * Parse error response to get user-friendly message
 */
function parseErrorMessage(error, response) {
    const detailedMessage = extractErrorDetailsMessage(error?.details);

    // Handle specific HTTP status codes
    if (response?.status === 400) {
        return detailedMessage || 'Invalid request. Please check your message format and try again.';
    }
    if (response?.status === 401) {
        return 'Your login session is missing or expired. Sign in again.';
    }
    if (response?.status === 403) {
        return 'Access denied. You may not have permission to use this feature.';
    }
    if (response?.status === 404) {
        return detailedMessage || 'The requested resource was not found.';
    }
    if (response?.status === 429) {
        return 'Rate limit exceeded. Please wait a moment and try again.';
    }
    if (response?.status >= 500) {
        return detailedMessage || 'Server error. Please try again later.';
    }
    
    // Network errors
    if (error.name === 'AbortError') {
        return 'Request was cancelled.';
    }
    if (error.name === 'TypeError' || error.message?.includes('fetch')) {
        return 'Network error. Please check your connection and try again.';
    }
    
    return detailedMessage || error.message || 'An unexpected error occurred';
}

// ============================================
// NotesAPIClient Class
// ============================================

class NotesAPIClient {
    constructor() {
        this.currentSessionId = null;
        this.modelsCache = null;
        this.modelsCacheExpiry = null;
        this.modelsCacheDuration = 5 * 60 * 1000; // 5 minutes
        this.retryCount = 0;
        this.abortControllers = new Map(); // Track abort controllers for cancellation
    }

    async buildRequestError(response) {
        let details = null;
        try {
            details = await response.clone().json();
        } catch (_jsonError) {
            try {
                details = await response.text();
            } catch (_textError) {
                details = null;
            }
        }

        const error = new Error(parseErrorMessage({ details }, response));
        error.status = response.status;
        error.details = details;
        return error;
    }

    // ============================================
    // Chat Methods
    // ============================================

    /**
     * Stream chat completions using Server-Sent Events (SSE)
     * @param {Array} messages - Array of messages in OpenAI format [{role, content}, ...]
     * @param {string} model - Model ID to use (default: 'gpt-4o')
     * @param {AbortSignal} signal - Optional abort signal for cancellation
     * @returns {AsyncGenerator} - Yields { type: 'delta', content }, { type: 'done' }, or { type: 'error', error }
     * 
     * @example
     * const client = new NotesAPIClient();
     * for await (const chunk of client.streamChat(messages, 'gpt-4o')) {
     *     if (chunk.type === 'delta') console.log(chunk.content);
     * }
     */
    async *streamChat(messages, model = 'gpt-4o', signal = null, requestOptions = {}) {
        const params = {
            model,
            messages,
            stream: true,
            taskType: NOTES_TASK_TYPE,
            clientSurface: NOTES_CLIENT_SURFACE,
            enableConversationExecutor: true,
            metadata: {
                remoteBuildAutonomyApproved: NOTES_REMOTE_BUILD_AUTONOMY_APPROVED,
                enableConversationExecutor: true,
                clientSurface: NOTES_CLIENT_SURFACE,
                ...(requestOptions.metadata && typeof requestOptions.metadata === 'object'
                    ? requestOptions.metadata
                    : {}),
            },
        };

        if (requestOptions.outputFormat) {
            params.output_format = requestOptions.outputFormat;
        }

        if (requestOptions.reasoningEffort || requestOptions.reasoning_effort) {
            params.reasoningEffort = requestOptions.reasoningEffort || requestOptions.reasoning_effort;
        }

        if (Array.isArray(requestOptions.artifactIds) && requestOptions.artifactIds.length > 0) {
            params.artifact_ids = requestOptions.artifactIds;
        }
        
        // Include session ID if available and not a local session
        if (this.currentSessionId && !String(this.currentSessionId).startsWith('local_')) {
            params.session_id = this.currentSessionId;
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
            yield* this._streamWithFetch(params, controller.signal, requestId);
        } finally {
            this.abortControllers.delete(requestId);
        }
    }

    /**
     * Internal method to stream chat using fetch with retry logic
     * @private
     */
    async *_streamWithFetch(params, signal, requestId) {
        let lastError = null;
        
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            try {
                // Retry delay (except for first attempt)
                if (attempt > 0) {
                    const delay = getRetryDelay(attempt - 1);
                    console.log(`Retrying stream chat (attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries + 1}) after ${delay}ms`);
                    yield { type: 'retry', attempt: attempt + 1, maxAttempts: RETRY_CONFIG.maxRetries + 1 };
                    await sleep(delay);
                }

                const response = await fetch(`${API_BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream'
                    },
                    body: JSON.stringify(params),
                    signal: signal
                });
                
                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}`);
                    error.status = response.status;
                    error.response = response;
                    
                    // Try to get error details from response
                    try {
                        const errorData = await response.json();
                        error.details = errorData;
                    } catch (e) {
                        // Ignore parsing errors
                    }

                    if (isSessionNotFoundError(error) && params.session_id) {
                        this.currentSessionId = null;
                        delete params.session_id;
                        continue;
                    }
                    
                    throw error;
                }

                // Track session ID from response headers
                const responseSessionId = response.headers.get('X-Session-Id');
                if (responseSessionId) {
                    this.currentSessionId = responseSessionId;
                }
                
                // Set up SSE reading
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                
                let pendingDone = {
                    sessionId: this.currentSessionId,
                    artifacts: [],
                    toolEvents: [],
                    assistantMetadata: null,
                };

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || ''; // Keep incomplete line in buffer
                        
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                
                                // Check for stream termination
                                if (data === '[DONE]') {
                                    yield {
                                        type: 'done',
                                        sessionId: pendingDone.sessionId || this.currentSessionId,
                                        artifacts: pendingDone.artifacts || [],
                                        toolEvents: pendingDone.toolEvents || [],
                                        assistantMetadata: pendingDone.assistantMetadata,
                                    };
                                    return;
                                }
                                
                                try {
                                    const parsed = JSON.parse(data);
                                    
                                    // Check for error in stream
                                    if (parsed.error) {
                                        throw new Error(parsed.error.message || 'Stream error');
                                    }

                                    const streamSessionId = extractStreamSessionId(parsed);
                                    if (streamSessionId) {
                                        this.currentSessionId = streamSessionId;
                                        pendingDone.sessionId = this.currentSessionId;
                                    }
                                    
                                    // Extract content from delta
                                    const content = extractStreamTextDelta(parsed);
                                    if (content) {
                                        yield { type: 'delta', content };
                                    }

                                    const isReasoningDelta = parsed.type === 'response.reasoning_summary_text.delta';
                                    const reasoning = extractReasoningSummary(
                                        (isReasoningDelta ? (parsed.delta ?? parsed.reasoning_delta) : '')
                                        || parsed?.choices?.[0]?.delta?.reasoning
                                        || parsed?.choices?.[0]?.delta?.reasoning_text
                                        || parsed?.choices?.[0]?.delta?.reasoning_content
                                        || parsed?.reasoning_delta
                                        || '',
                                    );
                                    if (reasoning) {
                                        const currentSummary = String(pendingDone.assistantMetadata?.reasoningSummary || '').trim();
                                        const summary = String(parsed.summary || parsed.reasoningSummary || parsed.reasoning_summary || '').trim()
                                            || `${currentSummary}${reasoning}`.trim();
                                        pendingDone.assistantMetadata = {
                                            ...(pendingDone.assistantMetadata || {}),
                                            reasoningSummary: summary,
                                            reasoningAvailable: true,
                                        };
                                        yield { type: 'reasoning', content: reasoning, summary };
                                    }
                                    
                                    if (Array.isArray(parsed.artifacts)) {
                                        pendingDone.artifacts = parsed.artifacts;
                                    }

                                    const assistantMetadata = extractAssistantMetadata(parsed);
                                    if (assistantMetadata) {
                                        pendingDone.assistantMetadata = {
                                            ...(pendingDone.assistantMetadata || {}),
                                            ...assistantMetadata,
                                        };
                                    }

                                    const toolEvents = extractToolEvents(parsed);
                                    if (toolEvents.length > 0) {
                                        pendingDone.toolEvents = toolEvents;
                                    }

                                    if (isTerminalStreamPayload(parsed)) {
                                        yield {
                                            type: 'done',
                                            sessionId: pendingDone.sessionId || this.currentSessionId,
                                            artifacts: pendingDone.artifacts || [],
                                            toolEvents: pendingDone.toolEvents || [],
                                            assistantMetadata: pendingDone.assistantMetadata,
                                        };
                                        return;
                                    }
                                } catch (e) {
                                    if (e.message !== 'Stream error') {
                                        // Ignore JSON parse errors for malformed chunks
                                        console.warn('Failed to parse stream chunk:', e);
                                    } else {
                                        throw e;
                                    }
                                }
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
                
                // Success - reset retry count
                this.retryCount = 0;
                yield {
                    type: 'done',
                    sessionId: pendingDone.sessionId || this.currentSessionId,
                    artifacts: pendingDone.artifacts || [],
                    toolEvents: pendingDone.toolEvents || [],
                    assistantMetadata: pendingDone.assistantMetadata,
                };
                return;
                
            } catch (error) {
                lastError = error;
                
                // Don't retry if aborted
                if (error.name === 'AbortError') {
                    yield { type: 'error', error: 'Request cancelled', cancelled: true };
                    return;
                }
                
                // Don't retry non-retryable errors
                if (!isRetryableError(error)) {
                    const message = parseErrorMessage(error, error.response);
                    yield { type: 'error', error: message, status: error.status, details: error.details };
                    yield { type: 'done', sessionId: this.currentSessionId, artifacts: [], toolEvents: [] };
                    return;
                }
                
                // Last attempt failed
                if (attempt === RETRY_CONFIG.maxRetries) {
                    const message = parseErrorMessage(error, error.response);
                    yield { type: 'error', error: message, status: error.status, details: error.details, retriesExhausted: true };
                    yield { type: 'done', sessionId: this.currentSessionId, artifacts: [], toolEvents: [] };
                    return;
                }
            }
        }
    }

    /**
     * Non-streaming chat completion
     * @param {Array} messages - Array of messages in OpenAI format
     * @param {string} model - Model ID to use (default: 'gpt-4o')
     * @returns {Promise<Object>} - Response with { content, sessionId, error? }
     * 
     * @example
     * const client = new NotesAPIClient();
     * const response = await client.chat(messages, 'gpt-4o');
     * console.log(response.content);
     */
    async chat(messages, model = 'gpt-4o', requestOptions = {}) {
        const params = {
            model,
            messages,
            stream: false,
            taskType: NOTES_TASK_TYPE,
            clientSurface: NOTES_CLIENT_SURFACE,
            enableConversationExecutor: true,
            metadata: {
                remoteBuildAutonomyApproved: NOTES_REMOTE_BUILD_AUTONOMY_APPROVED,
                enableConversationExecutor: true,
                clientSurface: NOTES_CLIENT_SURFACE,
                ...(requestOptions.metadata && typeof requestOptions.metadata === 'object'
                    ? requestOptions.metadata
                    : {}),
            },
        };

        if (requestOptions.outputFormat) {
            params.output_format = requestOptions.outputFormat;
        }

        if (requestOptions.reasoningEffort || requestOptions.reasoning_effort) {
            params.reasoningEffort = requestOptions.reasoningEffort || requestOptions.reasoning_effort;
        }

        if (Array.isArray(requestOptions.artifactIds) && requestOptions.artifactIds.length > 0) {
            params.artifact_ids = requestOptions.artifactIds;
        }
        
        // Include session ID if available and not a local session
        if (this.currentSessionId && !String(this.currentSessionId).startsWith('local_')) {
            params.session_id = this.currentSessionId;
        }

        let lastError = null;
        
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            try {
                // Retry delay (except for first attempt)
                if (attempt > 0) {
                    const delay = getRetryDelay(attempt - 1);
                    await sleep(delay);
                }

                const response = await fetch(`${API_BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(params),
                });
                
                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}`);
                    error.status = response.status;
                    error.response = response;

                    try {
                        error.details = await response.json();
                    } catch (e) {
                        // Ignore parsing errors
                    }

                    if (isSessionNotFoundError(error) && params.session_id) {
                        this.currentSessionId = null;
                        delete params.session_id;
                        continue;
                    }

                    throw error;
                }
                
                const data = await response.json();
                
                // Track session ID from response
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
                    artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
                    toolEvents: extractToolEvents(data),
                    assistantMetadata: extractAssistantMetadata(data),
                };
                
            } catch (error) {
                lastError = error;
                
                // Don't retry non-retryable errors or if exhausted
                if (!isRetryableError(error) || attempt === RETRY_CONFIG.maxRetries) {
                    return {
                        content: `[Error: ${parseErrorMessage(error)}]`,
                        sessionId: this.currentSessionId,
                        artifacts: [],
                        toolEvents: [],
                        error: true
                    };
                }
            }
        }
    }

    // ============================================
    // Model API
    // ============================================

    /**
     * Fetch available models with caching
     * @param {boolean} forceRefresh - Force refresh the cache
     * @returns {Promise<Object>} - List of available models
     * 
     * @example
     * const client = new NotesAPIClient();
     * const models = await client.getModels();
     * console.log(models.data);
     */
    async getModels(forceRefresh = false) {
        // Check in-memory cache first
        if (!forceRefresh && this.modelsCache && this.modelsCacheExpiry > Date.now()) {
            return this.modelsCache;
        }

        // Check localStorage cache (wrapped for Tracking Prevention compatibility)
        if (!forceRefresh) {
            let cached, cachedExpiry;
            try {
                cached = localStorage.getItem('notes_api_models_cache');
                cachedExpiry = localStorage.getItem('notes_api_models_cache_expiry');
            } catch (e) {
                // localStorage blocked by Tracking Prevention
                cached = null;
                cachedExpiry = null;
            }
            
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

        // Fetch from API
        try {
            const response = await fetch(`${API_BASE_URL}/models`);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            // Format response to match OpenAI API structure
            const formattedData = {
                object: 'list',
                data: data.data || [],
            };
            
            // Update cache
            this.modelsCache = formattedData;
            this.modelsCacheExpiry = Date.now() + this.modelsCacheDuration;
            
            // Save to localStorage (wrapped for Tracking Prevention compatibility)
            try {
                localStorage.setItem('notes_api_models_cache', JSON.stringify(formattedData));
                localStorage.setItem('notes_api_models_cache_expiry', String(this.modelsCacheExpiry));
            } catch (e) {
                // localStorage blocked by Tracking Prevention - continue without caching
            }
            
            return formattedData;
            
        } catch (error) {
            console.error('Failed to fetch models:', error);
            
            // Return cached models if available
            if (this.modelsCache) {
                return this.modelsCache;
            }
            
            // Return default models as fallback
            return this.getDefaultModels();
        }
    }

    /**
     * Get default models as fallback
     * @private
     */
    getDefaultModels() {
        return {
            object: 'list',
            data: [
                { id: 'gpt-4o', object: 'model', created: Date.now(), owned_by: 'openai' },
                { id: 'gpt-4o-mini', object: 'model', created: Date.now(), owned_by: 'openai' },
                { id: 'claude-3-opus', object: 'model', created: Date.now(), owned_by: 'anthropic' },
                { id: 'claude-3-sonnet', object: 'model', created: Date.now(), owned_by: 'anthropic' }
            ]
        };
    }

    // ============================================
    // Utility Methods
    // ============================================

    /**
     * Check backend health
     * @returns {Promise<Object>} - { connected: boolean, data?, error? }
     * 
     * @example
     * const client = new NotesAPIClient();
     * const health = await client.checkHealth();
     * if (health.connected) console.log('Backend is healthy');
     */
    async checkHealth() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`${BASE_URL_WITHOUT_API}/health`, {
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();
                return { connected: true, data };
            }
            return { connected: false, error: 'Health check failed' };
        } catch (error) {
            return { connected: false, error: error.message };
        }
    }

    /**
     * Cancel an ongoing request
     * @param {string} requestId - The request ID to cancel
     * @returns {boolean} - True if cancelled, false if not found
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

    /**
     * Clear the models cache
     */
    clearModelsCache() {
        this.modelsCache = null;
        this.modelsCacheExpiry = null;
        try {
            localStorage.removeItem('notes_api_models_cache');
            localStorage.removeItem('notes_api_models_cache_expiry');
        } catch (e) {
            // localStorage blocked - nothing to clear
        }
    }

    /**
     * Set the current session ID
     * @param {string} sessionId - The session ID to set
     */
    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    /**
     * Get the current session ID
     * @returns {string|null} - The current session ID
     */
    getSessionId() {
        return this.currentSessionId;
    }

    async getSessionState() {
        const params = new URLSearchParams({
            taskType: NOTES_TASK_TYPE,
            clientSurface: NOTES_CLIENT_SURFACE,
        });
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/sessions?${params.toString()}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw await this.buildRequestError(response);
        }

        return response.json();
    }

    async setActiveSession(sessionId = null) {
        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/sessions/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                activeSessionId: sessionId || null,
                taskType: NOTES_TASK_TYPE,
                clientSurface: NOTES_CLIENT_SURFACE,
            }),
        });

        if (!response.ok) {
            throw await this.buildRequestError(response);
        }

        const data = await response.json();
        this.currentSessionId = data.activeSessionId || null;
        return data;
    }

    async getSessionMessages(sessionId = this.currentSessionId, limit = 100) {
        if (!sessionId) {
            return [];
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${encodeURIComponent(limit)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw await this.buildRequestError(response);
        }

        const data = await response.json();
        return Array.isArray(data.messages) ? data.messages : [];
    }

    async getSessionArtifacts(sessionId = this.currentSessionId) {
        if (!sessionId) {
            return [];
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw await this.buildRequestError(response);
        }

        const data = await response.json();
        return Array.isArray(data.artifacts) ? data.artifacts : [];
    }

    /**
     * Filter models to only include chat models
     * @param {Array} models - Array of model objects
     * @returns {Array} - Filtered models
     */
    filterChatModels(models = []) {
        return models.filter((model) => {
            const id = String(model.id || '').toLowerCase();
            if (!id) return false;

            const looksLikeChatModel = [
                'gpt',
                'claude',
                'gemini',
                'kimi',
                'llama',
                'mistral',
                'qwen',
                'phi',
                'ollama',
                'antigravity',
                'deepseek',
                'deepseak',
            ].some((token) => id.includes(token));

            const looksUnsupportedForNotes = [
                'image',
                'embedding',
                'tts',
                'transcribe',
                'audio',
                'realtime',
                'vision-preview',
                'preview-tools',
                '-tools',
                'codex',
                'computer-use',
                'computer_use',
            ].some((token) => id.includes(token));

            return looksLikeChatModel && !looksUnsupportedForNotes;
        });
    }

    async getAvailableTools(category = null) {
        const params = new URLSearchParams();
        if (category) {
            params.set('category', category);
        }
        params.set('taskType', NOTES_TASK_TYPE);
        params.set('clientSurface', NOTES_CLIENT_SURFACE);
        if (this.currentSessionId && !String(this.currentSessionId).startsWith('local_')) {
            params.set('sessionId', this.currentSessionId);
        }

        const response = await fetch(`${BASE_URL_WITHOUT_API}/api/tools/available${params.toString() ? `?${params.toString()}` : ''}`, {
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

    async invokeTool(toolId, params = {}) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await fetch(`${BASE_URL_WITHOUT_API}/api/tools/invoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tool: toolId,
                    params,
                    sessionId: this.currentSessionId,
                    model: window.Agent?.getSelectedModel?.() || null,
                    taskType: NOTES_TASK_TYPE,
                    clientSurface: NOTES_CLIENT_SURFACE,
                }),
            });

            if (!response.ok) {
                let details = null;
                try {
                    details = await response.json();
                } catch (e) {
                    details = null;
                }

                const error = new Error(`Tool invocation failed: HTTP ${response.status}`);
                error.status = response.status;
                error.details = details;

                if (isSessionNotFoundError(error) && this.currentSessionId) {
                    this.currentSessionId = null;
                    continue;
                }

                throw error;
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

        throw new Error('Tool invocation failed after resetting the session.');
    }
}

// ============================================
// Export
// ============================================

// Export for ES modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NotesAPIClient };
}

// Make available globally for browser
if (typeof window !== 'undefined') {
    window.NotesAPIClient = NotesAPIClient;
}

/**
 * API Module - OpenAI SDK integration for LillyBuilt AI
 * Handles SDK loading gracefully with fallbacks
 */

const API = (function() {
    const NOTES_TASK_TYPE = 'notes';
    const NOTES_CLIENT_SURFACE = 'notes';

    // Auto-detect backend URL
    const currentOrigin = `${window.location.protocol}//${window.location.host}`;
    const filePreviewBackendOrigin = 'http://localhost:3000';
    const apiOrigin = window.location.protocol === 'file:'
        ? filePreviewBackendOrigin
        : currentOrigin;
    const BASE_URL = `${apiOrigin}/v1`;
    const notesGatewayHelpers = window.KimiBuiltGatewaySSE || {};
    const buildGatewayHeaders = notesGatewayHelpers.buildGatewayHeaders || ((headers = {}) => ({
        ...headers,
        Authorization: 'Bearer any-key',
    }));
    
    // Lazy-loaded OpenAI client
    let client = null;
    let clientInitialized = false;
    
    // Current session/page ID for context
    let currentSessionId = null;
    
    /**
     * Initialize OpenAI client (lazy loading)
     */
    function getClient() {
        if (clientInitialized) return client;
        
        // Check if OpenAI SDK loaded
        if (typeof OpenAI === 'undefined') {
            console.warn('OpenAI SDK not loaded. Using fetch fallback.');
            return null;
        }
        
        try {
            client = new OpenAI({
                baseURL: BASE_URL,
                apiKey: 'any-key',
                dangerouslyAllowBrowser: true,
            });
            clientInitialized = true;
            console.log('OpenAI client initialized');
        } catch (error) {
            console.error('Failed to initialize OpenAI client:', error);
            client = null;
        }
        
        return client;
    }
    
    /**
     * Fetch wrapper for when OpenAI SDK is not available
     */
    async function fetchAPI(endpoint, options = {}) {
        const url = `${BASE_URL}${endpoint}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        
        return response.json();
    }

    function filterModels(models = []) {
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

            return looksLikeChatModel && !id.includes('image');
        });
    }

    function getDefaultImageModels() {
        return [
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
    }

    function buildArtifactDisplayUrl(path = '', { inline = false } = {}) {
        const normalizedPath = String(path || '').trim();
        if (!normalizedPath) {
            return '';
        }
        if (/^data:image\//i.test(normalizedPath)) {
            return normalizedPath;
        }

        try {
            const backendOrigin = BASE_URL.replace(/\/v1\/?$/i, '') || window.location.origin;
            const url = new URL(normalizedPath, backendOrigin);
            if (inline) {
                url.searchParams.set('inline', '1');
            }
            return url.toString();
        } catch (_error) {
            return '';
        }
    }

    function normalizeImageOption(value, fallback = null) {
        const normalized = String(value ?? '').trim();
        return normalized || fallback;
    }

    function normalizeGeneratedImage(image = {}) {
        if (!image || typeof image !== 'object') {
            return null;
        }

        const artifactId = image.artifactId || image.artifact_id || null;
        const fallbackDownloadPath = artifactId ? `/api/artifacts/${encodeURIComponent(artifactId)}/download` : '';
        const rawDownloadUrl = image.downloadPath
            || image.downloadUrl
            || image.absoluteUrl
            || fallbackDownloadPath
            || '';
        const rawInlineUrl = image.inlinePath
            || image.inlineUrl
            || image.absoluteInlineUrl
            || image.downloadPath
            || image.downloadUrl
            || image.absoluteUrl
            || fallbackDownloadPath
            || '';
        const downloadUrl = buildArtifactDisplayUrl(rawDownloadUrl);
        const inlineUrl = buildArtifactDisplayUrl(rawInlineUrl, { inline: true });

        const base64Image = typeof image.b64_json === 'string'
            && image.b64_json.trim()
            && !/\[truncated \d+ chars\]/.test(image.b64_json)
            ? (image.b64_json.startsWith('data:')
                ? image.b64_json
                : `data:image/png;base64,${image.b64_json}`)
            : '';
        const directUrl = buildArtifactDisplayUrl(
            image.url || image.imageUrl || image.image_url || image.absoluteUrl || '',
        ) || image.url || image.imageUrl || image.image_url || image.absoluteUrl || '';
        let imageUrl = inlineUrl || base64Image || directUrl;

        if (!imageUrl) {
            return null;
        }

        return {
            ...image,
            imageUrl,
            inlineUrl: inlineUrl || imageUrl,
            downloadUrl: downloadUrl || directUrl || '',
            artifactId,
            filename: image.filename || null,
        };
    }

    function getImageModelPreferenceRank(model = {}) {
        const normalizedId = String(model?.id || '').trim().toLowerCase();
        const preferredOrder = [
            'gpt-image-2',
            'gpt-image-1.5',
            'gpt-image-1',
            'gpt-image-1-mini',
            'dall-e-3',
            'dall-e-2',
        ];
        const preferredIndex = preferredOrder.indexOf(normalizedId);
        if (preferredIndex !== -1) {
            return preferredIndex;
        }

        if (/^(gpt-image|dall-e-)/i.test(normalizedId)) {
            return preferredOrder.length;
        }

        return preferredOrder.length + 100;
    }

    function sortImageModelsForDisplay(models = []) {
        const list = Array.isArray(models) ? [...models] : [];
        return list.sort((left, right) => {
            const rankDelta = getImageModelPreferenceRank(left) - getImageModelPreferenceRank(right);
            if (rankDelta !== 0) {
                return rankDelta;
            }

            return String(left?.name || left?.id || '').localeCompare(String(right?.name || right?.id || ''));
        });
    }

    function normalizeImageModelRecord(model = {}) {
        const id = String(model?.id || '').trim();
        const metadata = model?.metadata && typeof model.metadata === 'object' ? model.metadata : {};
        const lower = id.toLowerCase();

        return {
            ...metadata,
            id,
            name: metadata.name || id,
            owned_by: model.owned_by || metadata.owned_by || 'openai',
            description: metadata.description || 'OpenAI-compatible image generation',
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
        };
    }

    function buildMessages(message, context = []) {
        if (Array.isArray(context) && context.length > 0) {
            return [...context, { role: 'user', content: message }];
        }

        return [{ role: 'user', content: message }];
    }

    function extractTextFromValue(value) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) {
                return '';
            }

            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    const parsed = JSON.parse(trimmed);
                    const extracted = extractTextFromValue(parsed);
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
                .map((item) => extractTextFromValue(item))
                .filter(Boolean)
                .join('');
        }

        if (!value || typeof value !== 'object') {
            return '';
        }

        if (typeof value.output_text === 'string' && value.output_text.trim()) {
            return value.output_text.trim();
        }

        if (typeof value.text === 'string' && value.text.trim()) {
            return extractTextFromValue(value.text);
        }

        if (typeof value.content === 'string' && value.content.trim()) {
            return extractTextFromValue(value.content);
        }

        if (typeof value.message === 'string' && value.message.trim()) {
            return extractTextFromValue(value.message);
        }

        if (typeof value.response === 'string' && value.response.trim()) {
            return extractTextFromValue(value.response);
        }

        if (typeof value.output === 'string' && value.output.trim()) {
            return extractTextFromValue(value.output);
        }

        if (value.role === 'assistant' && Array.isArray(value.content)) {
            return extractTextFromValue(value.content);
        }

        const nestedKeys = ['content', 'output', 'message', 'response', 'data', 'item', 'items', 'value'];
        for (const key of nestedKeys) {
            const extracted = extractTextFromValue(value[key]);
            if (extracted) {
                return extracted;
            }
        }

        return '';
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
            return String(payload.delta || '');
        }

        if (payload?.type === 'delta') {
            return String(payload.content || payload.delta || '');
        }

        return String(
            payload?.choices?.[0]?.delta?.content
            || payload?.output_text_delta
            || '',
        );
    }

    function isTerminalStreamPayload(payload = {}) {
        const finishReason = String(payload?.choices?.[0]?.finish_reason || '').toLowerCase();
        return payload?.type === 'done'
            || payload?.type === 'response.completed'
            || ['stop', 'length', 'content_filter'].includes(finishReason);
    }

    function extractChatContent(response) {
        return extractTextFromValue(
            response?.choices?.[0]?.message?.content
            ?? response?.choices?.[0]?.message
            ?? response?.output_text
            ?? response
        );
    }

    function parseImageErrorBody(errorText = '') {
        const text = String(errorText || '').trim();
        if (!text) {
            return {
                message: '',
                diagnosticSummary: '',
            };
        }

        try {
            const parsed = JSON.parse(text);
            const diagnosticSummary = String(parsed?.diagnosticSummary || '').trim();
            const errorValue = parsed?.error;
            const errorMessage = typeof errorValue === 'string'
                ? errorValue
                : (typeof errorValue?.message === 'string' ? errorValue.message : '');
            const message = String(
                errorMessage
                || parsed?.message
                || diagnosticSummary
                || ''
            ).trim();
            return {
                message,
                diagnosticSummary,
            };
        } catch (_error) {
            return {
                message: text,
                diagnosticSummary: '',
            };
        }
    }

    function buildImageErrorMessage(status, errorText = '') {
        const parsed = parseImageErrorBody(errorText);
        const truncate = (value = '', limit = 480) => {
            const normalized = String(value || '').replace(/\s+/g, ' ').trim();
            return normalized.length > limit
                ? `${normalized.slice(0, Math.max(0, limit - 1)).trim()}...`
                : normalized;
        };
        const compactMessage = truncate(parsed.message);
        const compactSummary = truncate(parsed.diagnosticSummary);
        const base = compactMessage || `HTTP ${status}`;

        if (compactSummary && compactSummary !== compactMessage) {
            const separator = /[.!?]$/.test(base) ? ' ' : '. ';
            return `HTTP ${status}: ${base}${separator}${compactSummary}`;
        }

        return `HTTP ${status}: ${base}`;
    }

    function setSessionId(id) {
        currentSessionId = id;
    }

    // Health check (custom endpoint)
    async function checkHealth() {
        try {
            const baseUrl = BASE_URL.replace('/v1', '');
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) {
                const data = await response.json();
                return { connected: true, data };
            }
            return { connected: false, error: 'Health check failed' };
        } catch (error) {
            return { connected: false, error: error.message };
        }
    }
    
    // Get models - fallback to fetch if SDK not available
    async function getModels() {
        const openai = getClient();
        
        if (!openai) {
            // Fallback: fetch directly
            try {
                const data = await fetchAPI('/models');
                return filterModels(data.data || []).map(m => ({
                    id: m.id,
                    name: m.id,
                    provider: m.owned_by || 'unknown'
                }));
            } catch (error) {
                console.warn('Failed to fetch models:', error);
                return [];
            }
        }
        
        try {
            const response = await openai.models.list();
            return filterModels(response.data || []).map(m => ({
                id: m.id,
                name: m.id,
                provider: m.owned_by || 'unknown'
            }));
        } catch (error) {
            console.warn('Failed to fetch models:', error.message);
            return [];
        }
    }
    
    // Get image models
    async function getImageModels() {
        try {
            const baseUrl = BASE_URL.replace('/v1', '');
            const response = await fetch(`${BASE_URL}/models`, {
                headers: buildGatewayHeaders({ 'Accept': 'application/json' }),
                credentials: 'same-origin',
                cache: 'no-store',
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const data = await response.json();
            const imageModels = (Array.isArray(data.data) ? data.data : [])
                .filter((model) => Array.isArray(model.capabilities) && model.capabilities.includes('image_generation'))
                .map((model) => normalizeImageModelRecord(model))
                .filter((model) => model.id);

            if (imageModels.length > 0) {
                return sortImageModelsForDisplay(imageModels);
            }

            const legacyResponse = await fetch(`${baseUrl}/api/images/models`, {
                headers: buildGatewayHeaders({ 'Accept': 'application/json' }),
                credentials: 'same-origin',
                cache: 'no-store',
            });

            if (!legacyResponse.ok) {
                throw new Error(`HTTP ${legacyResponse.status}: ${await legacyResponse.text()}`);
            }

            const legacyData = await legacyResponse.json();
            return sortImageModelsForDisplay(legacyData.models || []);
        } catch (error) {
            console.warn('Failed to fetch image models:', error.message);
            return sortImageModelsForDisplay(getDefaultImageModels());
        }
    }
    
    // Streaming chat - uses fetch fallback
    async function* streamChat(message, sessionId = null, context = [], model = null) {
        const params = {
            model: model || 'gpt-4o',
            messages: buildMessages(message, context),
            stream: true,
            taskType: NOTES_TASK_TYPE,
            clientSurface: NOTES_CLIENT_SURFACE,
            metadata: {
                taskType: NOTES_TASK_TYPE,
                clientSurface: NOTES_CLIENT_SURFACE,
            },
        };

        if (sessionId || currentSessionId) {
            params.session_id = sessionId || currentSessionId;
        }
        
        // Use fetch for streaming (works without SDK)
        try {
            const response = await fetch(`${BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const responseSessionId = response.headers.get('X-Session-Id');
            if (responseSessionId) {
                currentSessionId = responseSessionId;
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            yield { type: 'done', sessionId: currentSessionId };
                            return;
                        }
                        
                        try {
                            const parsed = JSON.parse(data);
                            const content = extractStreamTextDelta(parsed);
                            currentSessionId = extractStreamSessionId(parsed) || currentSessionId;
                            if (content) {
                                yield { type: 'delta', content };
                            }

                            if (isTerminalStreamPayload(parsed)) {
                                yield { type: 'done', sessionId: currentSessionId };
                                return;
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Stream error:', error);
            yield { type: 'delta', content: `[Error: ${error.message}]` };
            yield { type: 'done', sessionId: currentSessionId };
        }
    }
    
    // Non-streaming chat
    async function chat(message, sessionId = null, context = [], model = null) {
        const openai = getClient();
        
        const params = {
            model: model || 'gpt-4o',
            messages: buildMessages(message, context),
            stream: false,
            taskType: NOTES_TASK_TYPE,
            clientSurface: NOTES_CLIENT_SURFACE,
            metadata: {
                taskType: NOTES_TASK_TYPE,
                clientSurface: NOTES_CLIENT_SURFACE,
            },
        };

        if (sessionId || currentSessionId) {
            params.session_id = sessionId || currentSessionId;
        }
        
        try {
            let response;
            
            if (openai) {
                response = await openai.chat.completions.create(params);
            } else {
                response = await fetchAPI('/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify(params),
                });
            }
            
            if (response.session_id) {
                currentSessionId = response.session_id;
            }
            
            return {
                response: extractChatContent(response),
                sessionId: currentSessionId,
            };
        } catch (error) {
            console.warn('Chat failed:', error.message);
            return {
                response: `[Error: ${error.message}]`,
                sessionId: currentSessionId || 'local-' + Date.now()
            };
        }
    }
    
    // Generate content (for AI blocks)
    async function generate(prompt, model = null) {
        const result = await chat(prompt, null, [], model);
        return result;
    }
    
    // Generate image using the OpenAI-compatible backend API
    async function generateImage(promptOrOptions, options = {}) {
        const request = (promptOrOptions && typeof promptOrOptions === 'object' && !Array.isArray(promptOrOptions))
            ? promptOrOptions
            : { prompt: promptOrOptions, ...options };

        const {
            prompt,
            model = 'gpt-image-2',
            size = 'auto',
            quality,
            style,
            n,
            response_format = null,
            sessionId = currentSessionId,
        } = request;

        const normalizedSize = normalizeImageOption(size, 'auto');
        const normalizedQuality = normalizeImageOption(quality);
        const normalizedStyle = normalizeImageOption(style);
        const normalizedResponseFormat = normalizeImageOption(response_format);
        const params = {
            prompt,
            model: model || 'gpt-image-2',
            size: normalizedSize,
            taskType: 'image',
            clientSurface: NOTES_CLIENT_SURFACE,
        };

        if (normalizedResponseFormat) params.response_format = normalizedResponseFormat;
        if (normalizedQuality) params.quality = normalizedQuality;
        if (normalizedStyle) params.style = normalizedStyle;
        if (n) params.n = n;
        if (sessionId) params.session_id = sessionId;
        
        try {
            const response = await fetch(`${BASE_URL}/images/generations`, {
                method: 'POST',
                headers: buildGatewayHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                }),
                credentials: 'same-origin',
                body: JSON.stringify(params),
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(buildImageErrorMessage(response.status, errorText));
            }
            
            const data = await response.json();
            if (data.sessionId || data.session_id) {
                currentSessionId = data.sessionId || data.session_id;
            }
            const images = Array.isArray(data.data) && data.data.length > 0
                ? data.data
                : (Array.isArray(data.artifacts) ? data.artifacts : []);
            const normalizedImages = images
                .map((image) => normalizeGeneratedImage(image))
                .filter(Boolean);
            const firstImage = normalizedImages[0] || null;
            
            return {
                data: normalizedImages,
                images: normalizedImages,
                artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
                count: normalizedImages.length,
                url: firstImage?.imageUrl || null,
                imageUrl: firstImage?.imageUrl || null,
                downloadUrl: firstImage?.downloadUrl || null,
                artifactId: firstImage?.artifactId || null,
                filename: firstImage?.filename || null,
                revised_prompt: firstImage?.revisedPrompt || firstImage?.revised_prompt || null,
                created: data.created,
                model: data.model || params.model,
                size: data.size || params.size,
                quality: data.quality || params.quality || null,
                style: data.style || params.style || null,
                sessionId: data.sessionId || data.session_id || sessionId,
            };
        } catch (error) {
            console.warn('Image generation failed:', error.message);
            throw error;
        }
    }
    
    // Search Unsplash for images
    async function searchUnsplash(query, options = {}) {
        const { perPage = 12, page = 1 } = options;
        
        try {
            const baseUrl = BASE_URL.replace('/v1', '');
            const params = new URLSearchParams({
                q: query,
                per_page: String(perPage),
                page: String(page),
            });
            
            const response = await fetch(`${baseUrl}/api/unsplash/search?${params}`);
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            
            const data = await response.json();
            
            return {
                results: data.results || [],
                total: data.total || 0,
                total_pages: data.total_pages || 0,
            };
        } catch (error) {
            console.warn('Unsplash search failed:', error.message);
            throw error;
        }
    }
    
    // Clear model cache
    function clearModelCache() {
        // No-op for this implementation
    }
    
    // Fetch bookmark metadata from URL
    async function fetchBookmarkData(url) {
        // Fallback: extract domain and create basic info
        try {
            const urlObj = new URL(url);
            return {
                url: url,
                title: urlObj.hostname,
                description: '',
                favicon: `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`,
                image: ''
            };
        } catch {
            console.warn('Bookmark metadata fallback failed for URL:', url);
            return {
                url: url,
                title: url,
                description: '',
                favicon: '',
                image: ''
            };
        }
    }
    
    // Legacy session functions (no backend)
    async function createSession(title = 'New Page') {
        return { id: 'local-' + Date.now(), title };
    }
    
    async function getSession(sessionId) {
        return null;
    }
    
    async function deleteSession(sessionId) {
        return true;
    }
    
    return {
        checkHealth,
        getModels,
        getImageModels,
        chat,
        streamChat,
        generate,
        generateImage,
        searchUnsplash,
        setSessionId,
        clearModelCache,
        createSession,
        getSession,
        deleteSession,
        fetchBookmarkData,
        BASE_URL,
    };
})();


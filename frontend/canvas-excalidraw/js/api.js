/**
 * API Module - Backend integration using OpenAI SDK
 * Updated: Uses OpenAI SDK to connect to LillyBuilt backend at /v1
 */

const CANVAS_EXCALIDRAW_TASK_TYPE = 'canvas';
const CANVAS_EXCALIDRAW_CLIENT_SURFACE = 'canvas-excalidraw';
const CANVAS_DEFAULT_IMAGE_MODEL = 'gpt-image-2';
const CANVAS_EXCALIDRAW_ACTION_CONTRACT = [
    'Return JSON only: {"content":"{\\"message\\":\\"short\\",\\"actions\\":[...],\\"elements\\":[]}","metadata":{"type":"diagram","surface":"canvas-excalidraw"},"suggestions":[]}.',
    'Actions: add, add_many, update, update_many, delete, select.',
    'Use existing selected ids for updates. Prefer editable rectangle/diamond/ellipse/arrow/line/text/sticky/frame/storyboardFrame/animationBeat/audioCue/mermaidDiagram objects.',
    'For storyboardFrame include title,text,startTime,durationSeconds. For animationBeat include title,text,startTime,durationSeconds. For audioCue include title,text,audioName,startTime,durationSeconds. For mermaidDiagram include title,mermaidSource.',
    'No raster/image elements unless explicitly requested.',
].join(' ');
const canvasGatewayHelpers = window.KimiBuiltGatewaySSE || {};
const buildCanvasGatewayHeaders = canvasGatewayHelpers.buildGatewayHeaders || ((headers = {}) => ({
    ...headers,
    Authorization: 'Bearer any-key',
}));

class OpenAICanvasAPI {
    constructor(baseUrl = null) {
        this.baseURL = baseUrl || `${window.location.origin}/v1`;
        this.client = null;
        this.sessionId = null;
        this.sdkAvailable = false;
        try {
            this.selectedModel = localStorage.getItem('kimi-canvas-model') || 'gpt-4o';
        } catch {
            this.selectedModel = 'gpt-4o';
        }

        // Check if OpenAI SDK is available and working
        this.initSDK();
    }
    
    initSDK() {
        // Try to initialize OpenAI SDK with proper error handling
        if (typeof window.OpenAI !== 'undefined') {
            try {
                this.client = new window.OpenAI({
                    baseURL: this.baseURL,
                    apiKey: 'any-key',
                    dangerouslyAllowBrowser: true,
                });
                this.sdkAvailable = true;
                console.log('OpenAI SDK initialized successfully');
            } catch (error) {
                console.warn('Failed to initialize OpenAI SDK, will use fetch fallback:', error);
                this.client = null;
                this.sdkAvailable = false;
            }
        } else {
            console.log('OpenAI SDK not available, using fetch fallback');
            this.sdkAvailable = false;
        }
    }

    setSelectedModel(model) {
        this.selectedModel = model;
        try {
            localStorage.setItem('kimi-canvas-model', model);
        } catch {}
    }

    getSelectedModel() {
        return this.selectedModel;
    }

    getBackendBaseURL() {
        return this.baseURL.replace(/\/v1\/?$/, '');
    }

    formatCanvasGrounding(canvasContext = null, fallback = '') {
        if (fallback) {
            return String(fallback).slice(0, 900);
        }
        if (!canvasContext || typeof canvasContext !== 'object') {
            return '';
        }
        const board = canvasContext.board || {};
        const selection = canvasContext.selection || {};
        const elements = Array.isArray(canvasContext.elements) ? canvasContext.elements : [];
        const elementLines = elements.slice(0, 4).map((element) => {
            const label = String(element.name || element.text || element.canvasRole || '').replace(/\s+/g, ' ').trim();
            return `${element.id || 'new'} ${element.type || 'object'} @${element.x || 0},${element.y || 0}${label ? ` "${label.slice(0, 64)}"` : ''}`;
        });
        return [
            `surface=${canvasContext.surface || 'canvas-excalidraw'} scope=${canvasContext.scope || 'board'}`,
            `board=${board.elementCount || 0}; types=${board.typeCounts || 'none'}`,
            `selection=${selection.count || 0}; ids=${(selection.ids || []).slice(0, 8).join(', ') || 'none'}`,
            elementLines.length ? `objects:\n- ${elementLines.join('\n- ')}` : '',
        ].filter(Boolean).join('\n').slice(0, 900);
    }

    compactCanvasContext(canvasContext = null) {
        if (!canvasContext || typeof canvasContext !== 'object') {
            return null;
        }
        const selection = canvasContext.selection || {};
        return {
            surface: canvasContext.surface || 'canvas-excalidraw',
            compact: true,
            scope: canvasContext.scope || 'board',
            board: canvasContext.board || {},
            selection: {
                count: selection.count || 0,
                ids: Array.isArray(selection.ids) ? selection.ids.slice(0, 8) : [],
                typeCounts: selection.typeCounts || '',
                elements: Array.isArray(selection.elements) ? selection.elements.slice(0, 4) : [],
            },
            viewport: canvasContext.viewport || null,
            elements: Array.isArray(canvasContext.elements) ? canvasContext.elements.slice(0, 4) : [],
            relationships: Array.isArray(canvasContext.relationships) ? canvasContext.relationships.slice(0, 4) : [],
            toolPlan: this.summarizeToolPlan(canvasContext.toolPlan),
            allowedActions: Array.isArray(canvasContext.allowedActions)
                ? canvasContext.allowedActions.slice(0, 8)
                : ['add', 'add_many', 'update', 'update_many', 'delete', 'select'],
        };
    }

    summarizeToolPlan(toolPlan = null) {
        if (!toolPlan || typeof toolPlan !== 'object') {
            return null;
        }
        const plannedTools = Array.isArray(toolPlan.plannedTools)
            ? toolPlan.plannedTools.slice(0, 3)
            : [];
        return {
            mode: toolPlan.mode || 'chat',
            executionProfile: toolPlan.executionProfile || 'lean-canvas',
            plannedTools,
            preferredTool: toolPlan.preferredTool || plannedTools[0] || null,
            preferEditableObjects: toolPlan.preferEditableObjects !== false,
            avoidRasterSnapshots: toolPlan.avoidRasterSnapshots !== false,
        };
    }

    async requestCanvasAgent({
        message,
        canvasContext = null,
        mode = 'chat',
        existingContent = '',
        toolPlan = null,
    }) {
        const compactContext = this.compactCanvasContext(canvasContext);
        const plannedTools = Array.isArray(toolPlan?.plannedTools) ? toolPlan.plannedTools.slice(0, 3) : [];
        const compactToolPlan = this.summarizeToolPlan(toolPlan);
        const compactExistingContent = this.formatCanvasGrounding(compactContext, existingContent);
        const prompt = [
            message,
            '',
            CANVAS_EXCALIDRAW_ACTION_CONTRACT,
            mode === 'diagram'
                ? 'Draw or modify editable board objects.'
                : 'Use plain text for discussion-only answers.',
        ].filter(Boolean).join('\n');

        const response = await fetch(`${this.getBackendBaseURL()}/api/canvas`, {
            method: 'POST',
            headers: buildCanvasGatewayHeaders({
                'Content-Type': 'application/json',
                Accept: 'application/json',
            }),
            credentials: 'same-origin',
            body: JSON.stringify({
                message: prompt,
                sessionId: this.sessionId,
                canvasType: 'diagram',
                existingContent: compactExistingContent,
                model: this.selectedModel,
                executionProfile: toolPlan?.executionProfile || 'lean-canvas',
                enableConversationExecutor: false,
                metadata: {
                    taskType: CANVAS_EXCALIDRAW_TASK_TYPE,
                    clientSurface: CANVAS_EXCALIDRAW_CLIENT_SURFACE,
                    enableConversationExecutor: false,
                    surfaceMode: mode,
                    canvasContext: compactContext,
                    canvasToolPlan: compactToolPlan,
                    plannedTools,
                    preferredTool: compactToolPlan?.preferredTool || plannedTools[0] || null,
                    userSelectedToolIds: plannedTools,
                    toolIds: plannedTools,
                    actionContract: 'excalidraw-actions-v1',
                    artifactPolicy: {
                        preferEditableObjects: compactToolPlan?.preferEditableObjects !== false,
                        avoidRasterSnapshots: compactToolPlan?.avoidRasterSnapshots !== false,
                        explicitImageMode: mode === 'image',
                    },
                },
            }),
        });

        if (!response.ok) {
            throw await this.buildRequestError(response);
        }

        const data = await response.json();
        if (data.sessionId) {
            this.sessionId = data.sessionId;
        }

        return {
            content: data.content || '',
            suggestions: data.suggestions || [],
            metadata: data.metadata || {},
            sessionId: this.sessionId,
            responseId: data.responseId,
            raw: data,
        };
    }

    async chat(messages, canvasContext = null, toolPlan = null) {
        const plannedTools = Array.isArray(toolPlan?.plannedTools) ? toolPlan.plannedTools : [];
        const compactContext = this.compactCanvasContext(canvasContext);
        const compactToolPlan = this.summarizeToolPlan(toolPlan);
        const params = {
            model: this.selectedModel,
            messages,
            stream: false,
            enableConversationExecutor: false,
            executionProfile: toolPlan?.executionProfile || 'lean-canvas',
            taskType: CANVAS_EXCALIDRAW_TASK_TYPE,
            clientSurface: CANVAS_EXCALIDRAW_CLIENT_SURFACE,
            metadata: {
                taskType: CANVAS_EXCALIDRAW_TASK_TYPE,
                clientSurface: CANVAS_EXCALIDRAW_CLIENT_SURFACE,
                enableConversationExecutor: false,
                canvasContext: compactContext,
                canvasToolPlan: compactToolPlan,
                plannedTools: plannedTools.slice(0, 3),
                preferredTool: compactToolPlan?.preferredTool || plannedTools[0] || null,
                userSelectedToolIds: plannedTools.slice(0, 3),
                toolIds: plannedTools.slice(0, 3),
            },
        };

        if (this.sessionId) {
            params.session_id = this.sessionId;
        }

        if (!this.client) {
            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });

            if (!response.ok) {
                throw await this.buildRequestError(response);
            }

            const data = await response.json();
            if (data.session_id) {
                this.sessionId = data.session_id;
            }

            return {
                content: data.choices?.[0]?.message?.content || '',
                sessionId: this.sessionId,
                responseId: data.id,
            };
        }

        const response = await this.client.chat.completions.create(params);
        if (response.session_id) {
            this.sessionId = response.session_id;
        }

        return {
            content: response.choices?.[0]?.message?.content || '',
            sessionId: this.sessionId,
            responseId: response.id,
        };
    }

    // Generate diagram (uses chat completions with special prompt)
    async generateDiagram(message, existingContent = null, canvasContext = null, toolPlan = null) {
        const groundingText = this.formatCanvasGrounding(canvasContext, existingContent || '');
        const messages = [
            {
                role: 'system',
                content: [
                    'You are an AI visual canvas assistant for an Excalidraw-style whiteboard.',
                    'Respond with strict JSON only.',
                    'Use this shape: {"message":"short human summary","actions":[{"type":"add","element":{...}},{"type":"add_many","elements":[...]},{"type":"update","id":"element-id","patch":{...}},{"type":"update_many","patches":[{"id":"element-id","patch":{...}}]},{"type":"delete","id":"element-id"},{"type":"select","ids":["element-id"]}],"elements":[...]}',
                    'Prefer actions when changing existing selected objects. Use elements for newly generated diagrams.',
                    'Element types: rectangle, diamond, ellipse, arrow, line, freedraw, text, sticky, frame, storyboardFrame, animationBeat, audioCue, mermaidDiagram.',
                    'For storyboardFrame include title,text,startTime,durationSeconds. For animationBeat include title,text,startTime,durationSeconds. For audioCue include title,text,audioName,startTime,durationSeconds. For mermaidDiagram include title,mermaidSource.',
                    'Do not return image elements, screenshots, or raster snapshots unless the user explicitly asks for an image asset.',
                ].join(' ')
            },
            {
                role: 'user',
                content: [
                    message,
                    groundingText ? `\nCanvas grounding:\n${groundingText}` : '',
                ].filter(Boolean).join('\n')
            }
        ];

        const plannedTools = Array.isArray(toolPlan?.plannedTools) ? toolPlan.plannedTools : [];
        const compactContext = this.compactCanvasContext(canvasContext);
        const compactToolPlan = this.summarizeToolPlan(toolPlan);
        const params = {
            model: this.selectedModel,
            messages,
            stream: false,
            enableConversationExecutor: false,
            executionProfile: toolPlan?.executionProfile || 'lean-canvas',
            taskType: CANVAS_EXCALIDRAW_TASK_TYPE,
            clientSurface: CANVAS_EXCALIDRAW_CLIENT_SURFACE,
            metadata: {
                taskType: CANVAS_EXCALIDRAW_TASK_TYPE,
                clientSurface: CANVAS_EXCALIDRAW_CLIENT_SURFACE,
                enableConversationExecutor: false,
                canvasContext: compactContext,
                canvasToolPlan: compactToolPlan,
                plannedTools: plannedTools.slice(0, 3),
                preferredTool: compactToolPlan?.preferredTool || plannedTools[0] || null,
                userSelectedToolIds: plannedTools.slice(0, 3),
                toolIds: plannedTools.slice(0, 3),
            },
        };

        if (this.sessionId) {
            params.session_id = this.sessionId;
        }

        // Use fetch if SDK not available
        if (!this.client) {
            try {
                const response = await fetch(`${this.baseURL}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(params),
                });
                
                if (!response.ok) {
                    throw await this.buildRequestError(response);
                }
                
                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '';
                
                if (data.session_id) {
                    this.sessionId = data.session_id;
                }
                
                return {
                    content,
                    sessionId: this.sessionId,
                    responseId: data.id,
                };
            } catch (error) {
                console.error('Diagram generation error:', error);
                throw error;
            }
        }

        const response = await this.client.chat.completions.create(params);
        
        // Parse the response content as JSON
        const content = response.choices[0]?.message?.content || '';
        
        // Update session ID if returned
        if (response.session_id) {
            this.sessionId = response.session_id;
        }

        return {
            content,
            sessionId: this.sessionId,
            responseId: response.id,
        };
    }

    // Generate image
    async generateImage(options) {
        const {
            prompt,
            model = CANVAS_DEFAULT_IMAGE_MODEL,
            size,
            quality,
            style,
            n,
            response_format = 'b64_json',
        } = options;

        const params = {
            prompt,
            n: n || 1,
            size: size || '1024x1024',
            model: model || CANVAS_DEFAULT_IMAGE_MODEL,
            response_format,
            taskType: 'image',
            clientSurface: CANVAS_EXCALIDRAW_CLIENT_SURFACE,
        };

        if (quality) params.quality = quality;
        if (style) params.style = style;
        if (this.sessionId) params.session_id = this.sessionId;

        try {
            const response = await fetch(`${this.baseURL}/images/generations`, {
                method: 'POST',
                headers: buildCanvasGatewayHeaders({
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                }),
                credentials: 'same-origin',
                body: JSON.stringify(params),
            });

            if (!response.ok) {
                throw await this.buildRequestError(response);
            }

            const data = await response.json();

            if (data.sessionId || data.session_id) {
                this.sessionId = data.sessionId || data.session_id;
            }

            return data;
        } catch (error) {
            console.error('Image generation error:', error);
            throw error;
        }
    }

    // Get models
    async getModels() {
        // Use fetch if SDK not available
        if (!this.client) {
            try {
                const response = await fetch(`${this.baseURL}/models`);
                if (response.ok) {
                    const data = await response.json();
                    return this.filterModels(data.data || []).map(m => ({
                        id: m.id,
                        name: m.id,
                        provider: m.owned_by || 'unknown'
                    }));
                }
            } catch (error) {
                console.warn('Failed to fetch models:', error);
            }
            return this.getDefaultModels();
        }
        
        try {
            const response = await this.client.models.list();
            return this.filterModels(response.data || []).map(m => ({
                id: m.id,
                name: m.id,
                provider: m.owned_by || 'unknown'
            }));
        } catch (error) {
            console.error('Error fetching models:', error);
            return this.getDefaultModels();
        }
    }

    // Get image models from backend
    async getImageModels() {
        const baseUrl = this.baseURL.replace(/\/v1$/, '');
        try {
            const response = await fetch(`${this.baseURL}/models`, {
                headers: buildCanvasGatewayHeaders({ 'Accept': 'application/json' }),
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw await this.buildRequestError(response);
            }

            const data = await response.json();
            const imageModels = (Array.isArray(data.data) ? data.data : [])
                .filter((model) => Array.isArray(model.capabilities) && model.capabilities.includes('image_generation'))
                .map((model) => this.normalizeImageModelRecord(model))
                .filter((model) => model.id);

            if (imageModels.length > 0) {
                return imageModels;
            }

            const legacyResponse = await fetch(`${baseUrl}/api/images/models`, {
                headers: buildCanvasGatewayHeaders({ 'Accept': 'application/json' }),
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!legacyResponse.ok) {
                throw await this.buildRequestError(legacyResponse);
            }

            const legacyData = await legacyResponse.json();
            return legacyData.models || [];
        } catch (error) {
            console.warn('Failed to fetch image models:', error.message);
            return [this.normalizeImageModelRecord({ id: CANVAS_DEFAULT_IMAGE_MODEL })];
        }
    }

    normalizeImageModelRecord(model = {}) {
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

    async getSessionState() {
        const baseUrl = this.baseURL.replace(/\/v1$/, '');
        const params = new URLSearchParams({
            taskType: CANVAS_EXCALIDRAW_TASK_TYPE,
            clientSurface: CANVAS_EXCALIDRAW_CLIENT_SURFACE,
        });
        const response = await fetch(`${baseUrl}/api/sessions?${params.toString()}`);
        if (!response.ok) {
            throw await this.buildRequestError(response);
        }
        return response.json();
    }

    async setActiveSession(sessionId = null) {
        const baseUrl = this.baseURL.replace(/\/v1$/, '');
        const response = await fetch(`${baseUrl}/api/sessions/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                activeSessionId: sessionId || null,
                taskType: CANVAS_EXCALIDRAW_TASK_TYPE,
                clientSurface: CANVAS_EXCALIDRAW_CLIENT_SURFACE,
            }),
        });

        if (!response.ok) {
            throw await this.buildRequestError(response);
        }

        const data = await response.json();
        this.sessionId = data.activeSessionId || null;
        return data;
    }

    async getSessionMessages(sessionId = this.sessionId, limit = 100) {
        if (!sessionId) {
            return [];
        }

        const baseUrl = this.baseURL.replace(/\/v1$/, '');
        const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${encodeURIComponent(limit)}`);
        if (!response.ok) {
            throw await this.buildRequestError(response);
        }

        const data = await response.json();
        return Array.isArray(data.messages) ? data.messages : [];
    }

    async getSessionArtifacts(sessionId = this.sessionId) {
        if (!sessionId) {
            return [];
        }

        const baseUrl = this.baseURL.replace(/\/v1$/, '');
        const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/artifacts`);
        if (!response.ok) {
            throw await this.buildRequestError(response);
        }

        const data = await response.json();
        return this.normalizeArtifacts(data.artifacts);
    }

    normalizeArtifactMetadata(artifact = null) {
        if (!artifact || typeof artifact !== 'object') {
            return null;
        }

        const sizeValue = artifact.sizeBytes ?? artifact.size_bytes ?? artifact.size;
        const sizeBytes = Number.isFinite(Number(sizeValue)) ? Number(sizeValue) : 0;
        const id = String(artifact.id || artifact.artifactId || artifact.artifact_id || '').trim();

        return {
            ...artifact,
            id,
            artifactId: id,
            filename: String(artifact.filename || artifact.name || artifact.title || '').trim(),
            mimeType: String(artifact.mimeType || artifact.mime_type || '').trim(),
            size: sizeBytes,
            sizeBytes,
            downloadUrl: String(artifact.downloadUrl || artifact.download_url || '').trim(),
            previewUrl: String(artifact.previewUrl || artifact.preview_url || '').trim(),
            sandboxUrl: String(artifact.sandboxUrl || artifact.sandbox_url || '').trim(),
            bundleDownloadUrl: String(
                artifact.bundleDownloadUrl
                || artifact.bundle_download_url
                || artifact.bundleUrl
                || artifact.bundle_url
                || ''
            ).trim(),
        };
    }

    normalizeArtifacts(artifacts = []) {
        return (Array.isArray(artifacts) ? artifacts : [])
            .map((artifact) => this.normalizeArtifactMetadata(artifact))
            .filter((artifact) => artifact && artifact.id);
    }

    // Health check (custom)
    async checkHealth() {
        try {
            const baseUrl = this.baseURL.replace('/v1', '');
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
    
    // WebSocket Methods (kept for compatibility)
    connectWebSocket() {
        // WebSocket not needed with OpenAI SDK - using HTTP requests
        console.log('WebSocket not used with OpenAI SDK mode');
    }
    
    disconnect() {
        // No-op for OpenAI SDK mode
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId || null;
    }

    getDefaultModels() {
        return [
            { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
            { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
            { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'anthropic' }
        ];
    }

    filterModels(models = []) {
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

    async buildRequestError(response) {
        let message = `HTTP ${response.status}`;

        try {
            const data = await response.json();
            message = data?.error?.message || data?.message || message;
        } catch {}

        return new Error(message);
    }
}

// Create global instance
// Auto-detect backend URL
const currentOrigin = `${window.location.protocol}//${window.location.host}`;
const autoBaseUrl = `${currentOrigin}/v1`;

window.apiManager = new OpenAICanvasAPI(autoBaseUrl);


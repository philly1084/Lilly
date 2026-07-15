/**
 * Notation Helper - API Module
 * Handles HTTP and WebSocket communication with the backend
 */

function resolveNotationBaseUrl() {
    if (typeof window === 'undefined' || !window.location) {
        return 'http://localhost:3000';
    }

    const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
    const origin = `${window.location.protocol}//${window.location.host}`;
    return localHostnames.has(window.location.hostname)
        ? 'http://localhost:3000'
        : origin;
}

function resolveNotationWsUrl(baseUrl) {
    const normalizedBase = String(baseUrl || resolveNotationBaseUrl()).replace(/\/$/, '');
    return `${normalizedBase.replace(/^http/i, 'ws')}/ws`;
}

const NotationAPI = {
    // Configuration
    config: {
        baseUrl: resolveNotationBaseUrl(),
        wsUrl: resolveNotationWsUrl(resolveNotationBaseUrl()),
        timeout: 30000,
        retries: 3,
        retryDelay: 1000,
        reasoningEffort: ''
    },

    // State
    ws: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 3000,
    isConnected: false,
    sessionId: null,

    // Callbacks
    callbacks: {
        onConnect: null,
        onDisconnect: null,
        onError: null,
        onMessage: null,
        onStatusChange: null,
        onReconnecting: null
    },

    /**
     * Initialize the API client
     * @param {Object} options - Configuration options
     * @param {string} options.baseUrl - API base URL
     * @param {string} options.wsUrl - WebSocket URL
     * @param {Object} callbacks - Event callbacks
     */
    init(options = {}, callbacks = {}) {
        const nextConfig = { ...this.config, ...options };
        if (options.baseUrl && !options.wsUrl) {
            nextConfig.wsUrl = resolveNotationWsUrl(options.baseUrl);
        }

        this.config = nextConfig;
        this.callbacks = { ...this.callbacks, ...callbacks };

        this.connectWebSocket();

        return this;
    },

    setReasoningEffort(reasoningEffort) {
        const normalized = String(reasoningEffort || '').trim().toLowerCase();
        this.config.reasoningEffort = ['low', 'medium', 'high', 'xhigh'].includes(normalized) ? normalized : '';
    },

    getReasoningEffort() {
        return this.config.reasoningEffort || '';
    },

    /**
     * Send notation for processing via HTTP
     * @param {Object} data - Request data
     * @param {string} data.notation - The notation to process
     * @param {string} data.helperMode - Mode (expand, explain, validate)
     * @param {string} data.context - Optional context
     * @param {string} data.sessionId - Optional session ID
     * @returns {Promise<Object>} API response
     */
    async process(data) {
        const payload = {
            notation: data.notation || '',
            sessionId: data.sessionId || this.sessionId,
            context: data.context || '',
            helperMode: data.helperMode || 'expand'
        };
        const artifactIds = Array.isArray(data.artifactIds)
            ? data.artifactIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [];
        const outputFormat = String(data.outputFormat || '').trim();
        if (artifactIds.length > 0) {
            payload.artifactIds = artifactIds;
        }
        if (outputFormat) {
            payload.outputFormat = outputFormat;
        }

        const reasoningEffort = String(data.reasoningEffort || this.config.reasoningEffort || '').trim().toLowerCase();
        if (['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
            payload.reasoning_effort = reasoningEffort;
        }

        try {
            this._notifyStatus('processing');
            
            const response = await this._fetchWithRetry('/api/notation', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            // Update session ID if returned
            if (response.sessionId) {
                this.sessionId = response.sessionId;
            }

            this._notifyStatus('idle');
            return response;
        } catch (error) {
            this._notifyStatus('error');
            throw error;
        }
    },

    /**
     * Send notation via WebSocket
     * @param {Object} data - Request data
     * @returns {boolean} Success status
     */
    processWS(data) {
        if (!this.isConnected || !this.ws) {
            console.warn('WebSocket not connected, falling back to HTTP');
            return false;
        }

        const message = {
            type: 'notation',
            sessionId: data.sessionId || this.sessionId,
            payload: {
                notation: data.notation || '',
                helperMode: data.helperMode || 'expand',
                context: data.context || ''
            }
        };
        const artifactIds = Array.isArray(data.artifactIds)
            ? data.artifactIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [];
        const outputFormat = String(data.outputFormat || '').trim();
        if (artifactIds.length > 0) {
            message.payload.artifactIds = artifactIds;
        }
        if (outputFormat) {
            message.payload.outputFormat = outputFormat;
        }

        const reasoningEffort = String(data.reasoningEffort || this.config.reasoningEffort || '').trim().toLowerCase();
        if (['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
            message.payload.reasoning_effort = reasoningEffort;
        }

        try {
            this.ws.send(JSON.stringify(message));
            this._notifyStatus('processing');
            return true;
        } catch (error) {
            console.error('WebSocket send error:', error);
            return false;
        }
    },

    /**
     * Connect WebSocket
     */
    connectWebSocket() {
        if (this.ws) {
            this.ws.close();
        }

        try {
            this.ws = new WebSocket(this.config.wsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this._notifyStatus('connected');
                
                if (this.callbacks.onConnect) {
                    this.callbacks.onConnect();
                }
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this._handleWebSocketMessage(data);
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                }
            };

            this.ws.onclose = () => {
                console.log('WebSocket closed');
                this.isConnected = false;
                this._notifyStatus('disconnected');
                
                if (this.callbacks.onDisconnect) {
                    this.callbacks.onDisconnect();
                }

                // Attempt reconnection
                this._attemptReconnect();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this._notifyStatus('error');
                
                if (this.callbacks.onError) {
                    this.callbacks.onError(error);
                }
            };
        } catch (error) {
            console.error('Error creating WebSocket:', error);
            this._notifyStatus('error');
        }
    },

    /**
     * Disconnect WebSocket
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    },

    /**
     * Get connection status
     * @returns {Object} Status information
     */
    getStatus() {
        return {
            connected: this.isConnected,
            sessionId: this.sessionId,
            wsState: this.ws ? this.ws.readyState : 'closed'
        };
    },

    /**
     * Clear current session
     */
    clearSession() {
        this.sessionId = null;
    },

    /**
     * Check if backend is available
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            const response = await fetch(`${this.config.baseUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(10000)
            });
            return response.ok;
        } catch {
            return false;
        }
    },

    // Private methods

    /**
     * Fetch with retry logic
     * @param {string} endpoint - API endpoint
     * @param {Object} options - Fetch options
     * @returns {Promise<Object>} Response data
     * @private
     */
    async _fetchWithRetry(endpoint, options) {
        let lastError;
        
        for (let i = 0; i < this.config.retries; i++) {
            try {
                const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
                    ...options,
                    signal: AbortSignal.timeout(this.config.timeout)
                });

                if (!response.ok) {
                    const errorPayload = await response.json().catch(() => ({}));
                    const errorMessage = errorPayload?.error?.message
                        || errorPayload?.message
                        || (typeof errorPayload?.error === 'string' ? errorPayload.error : '')
                        || `HTTP ${response.status}: ${response.statusText}`;
                    const requestError = new Error(errorMessage);
                    requestError.status = response.status;
                    throw requestError;
                }

                return await response.json();
            } catch (error) {
                lastError = error;

                const status = Number(error?.status);
                const hasHttpStatus = Number.isFinite(status);
                const retryable = !hasHttpStatus
                    || status === 408
                    || status === 429
                    || status >= 500;
                if (!retryable || i >= this.config.retries - 1) {
                    break;
                }

                await this._delay(this.config.retryDelay * (i + 1));
            }
        }

        throw lastError;
    },

    /**
     * Handle WebSocket messages
     * @param {Object} data - Parsed message data
     * @private
     */
    _handleWebSocketMessage(data) {
        switch (data.type) {
            case 'done':
                this._notifyStatus('idle');
                
                // Update session ID
                if (data.sessionId) {
                    this.sessionId = data.sessionId;
                }

                // Parse content if it's a JSON string
                let content = data.content;
                try {
                    if (typeof content === 'string') {
                        content = JSON.parse(content);
                    }
                } catch {
                    // Keep as string if not valid JSON
                }

                const assistantMetadata = this._normalizeAssistantMetadata(data, content);
                const artifacts = this._extractArtifacts(data, content, assistantMetadata);
                const toolEvents = this._extractToolEvents(data, content, assistantMetadata);

                if (this.callbacks.onMessage) {
                    this.callbacks.onMessage({
                        type: 'done',
                        sessionId: data.sessionId,
                        responseId: data.responseId,
                        helperMode: data.helperMode,
                        content: content,
                        annotations: data.annotations || [],
                        suggestions: data.suggestions || [],
                        artifacts,
                        toolEvents,
                        assistantMetadata
                    });
                }
                break;

            case 'error':
                this._notifyStatus('error');
                
                if (this.callbacks.onError) {
                    this.callbacks.onError(new Error(data.message || 'WebSocket error'));
                }
                break;

            case 'ping':
                // Send pong to keep connection alive
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'pong' }));
                }
                break;

            default:
                console.log('Unknown WebSocket message type:', data.type);
        }
    },

    /**
     * Attempt WebSocket reconnection
     * @private
     */
    _attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn('Max reconnection attempts reached');
            this._notifyStatus('failed');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;
        
        console.log(`Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts})`);
        this._notifyStatus('reconnecting');

        // Notify UI about reconnection attempt
        if (this.callbacks.onReconnecting) {
            this.callbacks.onReconnecting(this.reconnectAttempts);
        }

        setTimeout(() => {
            this.connectWebSocket();
        }, delay);
    },

    _normalizeAssistantMetadata(data = {}, content = null) {
        const contentObject = content && typeof content === 'object' ? content : null;
        const source = data.assistantMetadata
            || data.assistant_metadata
            || data.metadata?.assistantMetadata
            || data.metadata?.assistant_metadata
            || contentObject?.assistantMetadata
            || contentObject?.assistant_metadata
            || contentObject?.metadata?.assistantMetadata
            || contentObject?.metadata?.assistant_metadata
            || {};
        const metadata = source && typeof source === 'object' ? { ...source } : {};
        const reasoningSummary = this._pickReasoningSummary(
            metadata,
            data,
            contentObject,
        );
        const artifacts = this._extractArtifacts(data, contentObject, metadata);
        const toolEvents = this._extractToolEvents(data, contentObject, metadata);

        if (reasoningSummary && !metadata.reasoningSummary) {
            metadata.reasoningSummary = reasoningSummary;
        }
        if (artifacts.length > 0) {
            metadata.artifacts = artifacts;
        }
        if (toolEvents.length > 0) {
            metadata.toolEvents = toolEvents;
        }

        return Object.keys(metadata).length > 0 ? metadata : null;
    },

    _extractArtifacts(...sources) {
        const artifactSources = [];
        sources.forEach((source) => {
            if (!source || typeof source !== 'object') {
                return;
            }
            artifactSources.push(
                source.artifacts,
                source.metadata?.artifacts,
                source.assistantMetadata?.artifacts,
                source.assistant_metadata?.artifacts,
                source.response?.artifacts,
                source.response?.metadata?.artifacts,
                source.response?.assistantMetadata?.artifacts,
                source.response?.assistant_metadata?.artifacts,
            );
        });

        for (const artifacts of artifactSources) {
            const normalized = this._normalizeArtifacts(artifacts);
            if (normalized.length > 0) {
                return normalized;
            }
        }
        return [];
    },

    _normalizeArtifacts(artifacts = []) {
        return (Array.isArray(artifacts) ? artifacts : [])
            .map((artifact) => this._normalizeArtifactMetadata(artifact))
            .filter(Boolean);
    },

    _normalizeArtifactMetadata(artifact) {
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
            return null;
        }

        const artifactId = String(artifact.id || artifact.artifactId || artifact.artifact_id || '').trim();
        const documentId = String(artifact.documentId || artifact.document_id || '').trim();
        const id = artifactId || documentId;
        const downloadUrl = String(
            artifact.downloadUrl
            || artifact.download_url
            || this._buildFallbackDownloadUrl(id, artifactId ? 'artifact' : 'document')
            || ''
        ).trim();
        if (!id && !downloadUrl) {
            return null;
        }

        const normalized = {
            ...artifact,
            id,
            downloadUrl,
        };
        const fields = {
            filename: artifact.filename || artifact.name,
            format: artifact.format || artifact.extension || artifact.type,
            mimeType: artifact.mimeType || artifact.mime_type,
            previewUrl: artifact.previewUrl || artifact.preview_url,
            sandboxUrl: artifact.sandboxUrl || artifact.sandbox_url,
            bundleDownloadUrl: artifact.bundleDownloadUrl || artifact.bundle_download_url || artifact.bundle_download,
        };

        Object.entries(fields).forEach(([key, value]) => {
            const text = String(value || '').trim();
            if (text) {
                normalized[key] = text;
            }
        });

        const sizeValue = artifact.sizeBytes ?? artifact.size_bytes ?? artifact.size;
        if (Number.isFinite(Number(sizeValue))) {
            normalized.sizeBytes = Number(sizeValue);
        }

        return normalized;
    },

    _buildFallbackDownloadUrl(id = '', type = 'artifact') {
        const normalizedId = String(id || '').trim();
        if (!normalizedId) {
            return '';
        }
        const route = type === 'document' ? 'documents' : 'artifacts';
        return `/api/${route}/${encodeURIComponent(normalizedId)}/download`;
    },

    _extractToolEvents(...sources) {
        const eventSources = [];
        sources.forEach((source) => {
            if (!source || typeof source !== 'object') {
                return;
            }
            eventSources.push(
                source.toolEvents,
                source.tool_events,
                source.metadata?.toolEvents,
                source.metadata?.tool_events,
                source.assistantMetadata?.toolEvents,
                source.assistantMetadata?.tool_events,
                source.assistant_metadata?.toolEvents,
                source.assistant_metadata?.tool_events,
                source.response?.metadata?.toolEvents,
                source.response?.metadata?.tool_events,
            );
        });

        for (const events of eventSources) {
            if (Array.isArray(events) && events.length > 0) {
                return events;
            }
        }
        return [];
    },

    _pickReasoningSummary(...sources) {
        for (const source of sources) {
            if (!source || typeof source !== 'object') {
                continue;
            }
            const summary = String(
                source.reasoningSummary
                || source.reasoning_summary
                || source.reasoningText
                || source.reasoning_text
                || ''
            ).trim();
            if (summary) {
                return summary;
            }
        }
        return '';
    },

    /**
     * Notify status change
     * @param {string} status - New status
     * @private
     */
    _notifyStatus(status) {
        if (this.callbacks.onStatusChange) {
            this.callbacks.onStatusChange(status);
        }
    },

    /**
     * Delay helper
     * @param {number} ms - Milliseconds to delay
     * @returns {Promise<void>}
     * @private
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};

// Export for module systems or make available globally
window.NotationAPI = NotationAPI;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = NotationAPI;
}

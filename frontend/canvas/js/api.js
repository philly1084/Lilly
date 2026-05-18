/**
 * API Client - Canvas API (HTTP + WebSocket)
 */

function resolveCanvasApiBaseURL() {
    if (typeof window === 'undefined' || !window.location) {
        return 'http://localhost:3000';
    }

    const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
    const origin = `${window.location.protocol}//${window.location.host}`;
    return localHostnames.has(window.location.hostname)
        ? 'http://localhost:3000'
        : origin;
}

function resolveCanvasWsURL(baseURL) {
    const normalizedBase = String(baseURL || resolveCanvasApiBaseURL()).replace(/\/$/, '');
    return `${normalizedBase.replace(/^http/i, 'ws')}/ws`;
}

class CanvasAPI {
    constructor(baseURL = resolveCanvasApiBaseURL()) {
        this.baseURL = baseURL;
        this.wsURL = resolveCanvasWsURL(baseURL);
        this.ws = null;
        this.wsCallbacks = {};
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.sessionId = null;
    }

    _getURL(path) {
        return `${this.baseURL}${path}`;
    }

    async sendCanvasRequest({
        message,
        sessionId,
        canvasType = 'code',
        existingContent,
        model,
        reasoningEffort,
        metadata = {},
        artifactIds,
        outputFormat,
        executionProfile,
    }) {
        const payload = {
            message,
            sessionId: sessionId || this.sessionId,
            canvasType,
            existingContent,
            metadata,
        };

        if (Array.isArray(artifactIds) && artifactIds.length > 0) {
            payload.artifactIds = artifactIds;
        }

        if (outputFormat) {
            payload.outputFormat = outputFormat;
        }

        if (executionProfile) {
            payload.executionProfile = executionProfile;
        }

        if (model) {
            payload.model = model;
        }

        if (reasoningEffort) {
            payload.reasoning_effort = reasoningEffort;
        }

        try {
            const response = await fetch(this._getURL('/api/canvas'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || errorData.error || `HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            if (data.sessionId) {
                this.sessionId = data.sessionId;
            }

            return data;
        } catch (error) {
            console.error('Canvas API Error:', error);
            throw error;
        }
    }

    connectWebSocket() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.wsURL);

                this.ws.onopen = () => {
                    console.log('WebSocket connected');
                    this.reconnectAttempts = 0;
                    this._triggerCallback('open');
                    resolve(this.ws);
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this._handleWebSocketMessage(data);
                    } catch (error) {
                        console.error('WebSocket message parse error:', error);
                    }
                };

                this.ws.onclose = (event) => {
                    console.log('WebSocket closed:', event.code, event.reason);
                    this._triggerCallback('close', event);
                    this._attemptReconnect();
                };

                this.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                    this._triggerCallback('error', error);
                    reject(error);
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    _handleWebSocketMessage(data) {
        if (data.sessionId) {
            this.sessionId = data.sessionId;
        }

        if (data.type && this.wsCallbacks[data.type]) {
            this.wsCallbacks[data.type].forEach((callback) => {
                try {
                    callback(data);
                } catch (error) {
                    console.error('WebSocket callback error:', error);
                }
            });
        }

        this._triggerCallback('message', data);
    }

    _attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts += 1;
            console.log(`WebSocket reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

            setTimeout(() => {
                this.connectWebSocket().catch((error) => {
                    console.error('WebSocket reconnect failed:', error);
                });
            }, this.reconnectDelay * this.reconnectAttempts);
        }
    }

    sendWebSocketMessage({
        message,
        sessionId,
        canvasType = 'code',
        existingContent,
        model,
        reasoningEffort,
        metadata = {},
        artifactIds,
        outputFormat,
        executionProfile,
    }) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('WebSocket is not connected');
            return false;
        }

        const payload = {
            type: 'canvas',
            sessionId: sessionId || this.sessionId,
            payload: {
                message,
                canvasType,
                existingContent,
                ...(model ? { model } : {}),
                ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
                ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
                ...(Array.isArray(artifactIds) && artifactIds.length > 0 ? { artifactIds } : {}),
                ...(outputFormat ? { outputFormat } : {}),
                ...(executionProfile ? { executionProfile } : {}),
            },
        };

        try {
            this.ws.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            console.error('WebSocket send error:', error);
            return false;
        }
    }

    on(event, callback) {
        if (!this.wsCallbacks[event]) {
            this.wsCallbacks[event] = [];
        }
        this.wsCallbacks[event].push(callback);

        return () => {
            const index = this.wsCallbacks[event].indexOf(callback);
            if (index > -1) {
                this.wsCallbacks[event].splice(index, 1);
            }
        };
    }

    _triggerCallback(event, data) {
        if (this.wsCallbacks[event]) {
            this.wsCallbacks[event].forEach((callback) => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`WebSocket ${event} callback error:`, error);
                }
            });
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    getSessionId() {
        return this.sessionId;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    clearSession() {
        this.sessionId = null;
    }

    async healthCheck() {
        try {
            const response = await fetch(this._getURL('/health'), {
                method: 'GET',
                headers: { Accept: 'application/json' },
            });
            return response.ok;
        } catch (error) {
            console.error('Health check failed:', error);
            return false;
        }
    }

    async streamCanvasRequest(params, onChunk, onComplete, onError) {
        try {
            const payload = {
                ...params,
                sessionId: params.sessionId || this.sessionId,
            };

            if (payload.reasoningEffort && !payload.reasoning_effort) {
                payload.reasoning_effort = payload.reasoningEffort;
                delete payload.reasoningEffort;
            }

            const response = await fetch(this._getURL('/api/canvas/stream'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    onComplete?.();
                    break;
                }

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            onChunk?.(data);
                        } catch {
                            onChunk?.({ type: 'content', data: line.slice(6) });
                        }
                    }
                }
            }
        } catch (error) {
            onError?.(error);
        }
    }
}

window.CanvasAPI = CanvasAPI;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CanvasAPI;
}

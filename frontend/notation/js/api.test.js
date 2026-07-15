const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadNotationApi(fetchMock = jest.fn()) {
    const sourcePath = path.join(__dirname, 'api.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const window = {
        location: {
            hostname: 'localhost',
            protocol: 'http:',
            host: 'localhost:3000',
        },
    };
    class WebSocketMock {
        static instances = [];
        static OPEN = 1;

        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.send = jest.fn();
            WebSocketMock.instances.push(this);
        }

        close() {
            this.onclose?.();
        }
    }
    const setTimeoutMock = jest.fn(() => ({ timer: true }));
    const clearTimeoutMock = jest.fn();
    const context = {
        module: { exports: {} },
        exports: {},
        window,
        WebSocket: WebSocketMock,
        fetch: fetchMock,
        AbortSignal: {
            timeout: jest.fn((ms) => ({ timeoutMs: ms })),
        },
        setTimeout: setTimeoutMock,
        clearTimeout: clearTimeoutMock,
        console,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: sourcePath });

    return {
        NotationAPI: context.module.exports,
        abortSignal: context.AbortSignal,
        clearTimeoutMock,
        fetchMock,
        setTimeoutMock,
        WebSocketMock,
    };
}

describe('notation API health check', () => {
    test('allows the backend health report to finish before reporting an error', async () => {
        const fetchMock = jest.fn(async () => ({ ok: true }));
        const { NotationAPI, abortSignal } = loadNotationApi(fetchMock);

        await expect(NotationAPI.healthCheck()).resolves.toBe(true);

        expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/health', {
            method: 'GET',
            signal: { timeoutMs: 10000 },
        });
        expect(abortSignal.timeout).toHaveBeenCalledWith(10000);
    });
});

describe('notation API WebSocket lifecycle', () => {
    test('intentional disconnect closes without scheduling a reconnect', () => {
        const { NotationAPI, setTimeoutMock, WebSocketMock } = loadNotationApi();
        const onDisconnect = jest.fn();
        NotationAPI.callbacks = { ...NotationAPI.callbacks, onDisconnect };

        NotationAPI.connectWebSocket();
        const socket = WebSocketMock.instances[0];
        socket.readyState = WebSocketMock.OPEN;
        socket.onopen();

        NotationAPI.disconnect();

        expect(NotationAPI.isConnected).toBe(false);
        expect(NotationAPI.ws).toBeNull();
        expect(setTimeoutMock).not.toHaveBeenCalled();
        expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    test('replaces an active socket without treating its close as a disconnect', () => {
        const { NotationAPI, setTimeoutMock, WebSocketMock } = loadNotationApi();
        const onDisconnect = jest.fn();
        NotationAPI.callbacks = { ...NotationAPI.callbacks, onDisconnect };

        NotationAPI.connectWebSocket();
        const firstSocket = WebSocketMock.instances[0];
        firstSocket.readyState = WebSocketMock.OPEN;
        firstSocket.onopen();

        NotationAPI.connectWebSocket();

        expect(WebSocketMock.instances).toHaveLength(2);
        expect(NotationAPI.ws).toBe(WebSocketMock.instances[1]);
        expect(setTimeoutMock).not.toHaveBeenCalled();
        expect(onDisconnect).not.toHaveBeenCalled();
    });

    test('disconnect cancels a pending reconnect before it can open another socket', () => {
        const {
            NotationAPI,
            clearTimeoutMock,
            setTimeoutMock,
            WebSocketMock,
        } = loadNotationApi();

        NotationAPI.connectWebSocket();
        WebSocketMock.instances[0].onclose();
        const [reconnect] = setTimeoutMock.mock.calls[0];
        const reconnectTimer = setTimeoutMock.mock.results[0].value;

        NotationAPI.disconnect();
        reconnect();

        expect(clearTimeoutMock).toHaveBeenCalledWith(reconnectTimer);
        expect(WebSocketMock.instances).toHaveLength(1);
    });

    test('serves the socket lifecycle fix with a cache-busted API script', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(html).toContain('<script src="js/api.js?v=20260715-socket-lifecycle"></script>');
    });
});

describe('notation API artifact handoff payloads', () => {
    test('preserves artifact ids and requested output format in HTTP requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({ sessionId: 'session-2', result: 'Expanded notation' }),
        }));
        const { NotationAPI } = loadNotationApi(fetchMock);

        await NotationAPI.process({
            notation: 'user -> report',
            helperMode: 'expand',
            artifactIds: [' artifact-1 ', '', 'artifact-2'],
            outputFormat: ' pdf ',
        });

        const [, options] = fetchMock.mock.calls[0];
        expect(JSON.parse(options.body)).toEqual(expect.objectContaining({
            notation: 'user -> report',
            helperMode: 'expand',
            artifactIds: ['artifact-1', 'artifact-2'],
            outputFormat: 'pdf',
        }));
    });

    test('preserves artifact ids and requested output format in WebSocket requests', () => {
        const { NotationAPI } = loadNotationApi();
        const send = jest.fn();
        NotationAPI.isConnected = true;
        NotationAPI.sessionId = 'session-3';
        NotationAPI.ws = { send };

        expect(NotationAPI.processWS({
            notation: 'order -> invoice',
            helperMode: 'validate',
            artifactIds: ['artifact-a'],
            outputFormat: 'html',
        })).toBe(true);

        expect(JSON.parse(send.mock.calls[0][0])).toEqual({
            type: 'notation',
            sessionId: 'session-3',
            payload: {
                notation: 'order -> invoice',
                helperMode: 'validate',
                context: '',
                artifactIds: ['artifact-a'],
                outputFormat: 'html',
            },
        });
    });
});

describe('notation API retry policy', () => {
    test('returns nested validation errors without retrying deterministic client failures', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({
                error: { message: 'Notation is required' },
            }),
        }));
        const { NotationAPI } = loadNotationApi(fetchMock);
        NotationAPI._delay = jest.fn().mockResolvedValue(undefined);

        await expect(NotationAPI.process({ notation: '' }))
            .rejects.toThrow('Notation is required');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(NotationAPI._delay).not.toHaveBeenCalled();
    });

    test('still retries transient server failures', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
                json: async () => ({ message: 'Provider is restarting' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ result: 'Expanded notation' }),
            });
        const { NotationAPI } = loadNotationApi(fetchMock);
        NotationAPI._delay = jest.fn().mockResolvedValue(undefined);

        await expect(NotationAPI.process({ notation: 'user -> report' }))
            .resolves.toEqual({ result: 'Expanded notation' });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(NotationAPI._delay).toHaveBeenCalledTimes(1);
    });
});

describe('notation API WebSocket metadata normalization', () => {
    test('promotes top-level reasoning summary aliases into assistant metadata', () => {
        const { NotationAPI } = loadNotationApi();
        const onMessage = jest.fn();
        NotationAPI.callbacks = { ...NotationAPI.callbacks, onMessage };

        NotationAPI._handleWebSocketMessage({
            type: 'done',
            sessionId: 'session-1',
            responseId: 'response-1',
            helperMode: 'explain',
            content: { result: 'Expanded flow' },
            reasoning_summary: 'Checked the shorthand before expanding it.',
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'done',
            sessionId: 'session-1',
            responseId: 'response-1',
            helperMode: 'explain',
            assistantMetadata: {
                reasoningSummary: 'Checked the shorthand before expanding it.',
            },
        }));
    });

    test('promotes reasoning summary aliases from parsed JSON content', () => {
        const { NotationAPI } = loadNotationApi();
        const onMessage = jest.fn();
        NotationAPI.callbacks = { ...NotationAPI.callbacks, onMessage };

        NotationAPI._handleWebSocketMessage({
            type: 'done',
            content: JSON.stringify({
                result: 'Validated flow',
                reasoningText: 'Found one ambiguous transition.',
            }),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            content: {
                result: 'Validated flow',
                reasoningText: 'Found one ambiguous transition.',
            },
            assistantMetadata: {
                reasoningSummary: 'Found one ambiguous transition.',
            },
        }));
    });

    test('normalizes assistant metadata artifacts and tool events from WebSocket payloads', () => {
        const { NotationAPI } = loadNotationApi();
        const onMessage = jest.fn();
        NotationAPI.callbacks = { ...NotationAPI.callbacks, onMessage };

        NotationAPI._handleWebSocketMessage({
            type: 'done',
            content: {
                result: 'Created export',
                assistant_metadata: {
                    artifacts: [{
                        document_id: 'doc-notation-1',
                        filename: 'notation-export.pdf',
                        mime_type: 'application/pdf',
                    }],
                    tool_events: [{
                        toolId: 'document-generator',
                        stage: 'completed',
                    }],
                },
            },
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            artifacts: [
                expect.objectContaining({
                    id: 'doc-notation-1',
                    filename: 'notation-export.pdf',
                    mimeType: 'application/pdf',
                    downloadUrl: '/api/documents/doc-notation-1/download',
                }),
            ],
            toolEvents: [
                expect.objectContaining({
                    toolId: 'document-generator',
                    stage: 'completed',
                }),
            ],
            assistantMetadata: expect.objectContaining({
                artifacts: [
                    expect.objectContaining({
                        id: 'doc-notation-1',
                        downloadUrl: '/api/documents/doc-notation-1/download',
                    }),
                ],
                toolEvents: [
                    expect.objectContaining({
                        toolId: 'document-generator',
                    }),
                ],
            }),
        }));
    });
});

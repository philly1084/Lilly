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
    const context = {
        module: { exports: {} },
        exports: {},
        window,
        WebSocket: class WebSocket {},
        fetch: fetchMock,
        AbortSignal: {
            timeout: jest.fn((ms) => ({ timeoutMs: ms })),
        },
        setTimeout: jest.fn(),
        console,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: sourcePath });

    return {
        NotationAPI: context.module.exports,
        abortSignal: context.AbortSignal,
        fetchMock,
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
});

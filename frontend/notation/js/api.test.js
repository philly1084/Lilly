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

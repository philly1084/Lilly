const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWebCliApi(fetchMock = jest.fn()) {
    const source = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
    const localStorage = {
        getItem: jest.fn(() => null),
        setItem: jest.fn(),
        removeItem: jest.fn(),
    };
    const window = {
        location: {
            protocol: 'http:',
            origin: 'http://localhost:3000',
            host: 'localhost:3000',
            href: 'http://localhost:3000/web-cli/',
        },
        KimiBuiltGatewaySSE: null,
    };
    const context = {
        window,
        localStorage,
        fetch: fetchMock,
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        TextDecoder,
        URL,
        URLSearchParams,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'api.js' });

    return {
        api: context.window.webCliApiClient,
        fetchMock,
        localStorage,
    };
}

function createJsonResponse(data = {}, options = {}) {
    return {
        ok: options.ok !== false,
        status: options.status || 200,
        json: async () => data,
        text: async () => JSON.stringify(data),
        headers: {
            get: jest.fn(() => null),
        },
    };
}

function createSseResponse(events = [], options = {}) {
    const payload = events
        .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
        .join('');
    const chunks = [Buffer.from(payload, 'utf8')];

    return {
        ok: true,
        status: 200,
        headers: {
            get: jest.fn((name) => (
                String(name || '').toLowerCase() === 'x-session-id'
                    ? (options.sessionId || null)
                    : null
            )),
        },
        body: {
            getReader: () => ({
                read: jest.fn(async () => {
                    if (chunks.length === 0) {
                        return { done: true };
                    }
                    return { done: false, value: chunks.shift() };
                }),
            }),
        },
    };
}

describe('web-cli API artifact metadata normalization', () => {
    test('normalizes snake_case artifact metadata from stream payloads', () => {
        const { api } = loadWebCliApi();

        const artifacts = api.extractArtifacts({
            artifacts: [{
                artifact_id: 'artifact-1',
                name: 'brief.html',
                mime_type: 'text/html',
                size_bytes: 2048,
                download_url: '/api/artifacts/artifact-1/download',
                preview_url: '/api/artifacts/artifact-1/preview',
                sandbox_url: '/sandbox/artifact-1/',
                bundle_download_url: '/api/artifacts/artifact-1/bundle',
            }],
        });

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-1',
                filename: 'brief.html',
                mimeType: 'text/html',
                sizeBytes: 2048,
                downloadUrl: '/api/artifacts/artifact-1/download',
                previewUrl: '/api/artifacts/artifact-1/preview',
                sandboxUrl: '/sandbox/artifact-1/',
                bundleDownloadUrl: '/api/artifacts/artifact-1/bundle',
            }),
        ]);
    });

    test('normalizes gateway assistant artifact metadata before storing pending done state', () => {
        const { api } = loadWebCliApi();
        const pendingDone = {};

        api.applyNormalizedStreamMetadata({
            artifacts: [{
                id: 'artifact-2',
                filename: 'report.pdf',
                download_url: '/api/artifacts/artifact-2/download',
                size_bytes: 4096,
            }],
            assistantMetadata: {
                artifacts: [{
                    id: 'artifact-2',
                    filename: 'report.pdf',
                    preview_url: '/api/artifacts/artifact-2/preview',
                    download_url: '/api/artifacts/artifact-2/download',
                    size_bytes: 4096,
                }],
            },
        }, pendingDone);

        expect(pendingDone.artifacts[0]).toEqual(expect.objectContaining({
            downloadUrl: '/api/artifacts/artifact-2/download',
            sizeBytes: 4096,
        }));
        expect(pendingDone.assistantMetadata.artifacts[0]).toEqual(expect.objectContaining({
            previewUrl: '/api/artifacts/artifact-2/preview',
            downloadUrl: '/api/artifacts/artifact-2/download',
            sizeBytes: 4096,
        }));
    });

    test('normalizes persisted session artifacts returned by the backend', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                artifacts: [{
                    artifact_id: 'artifact-3',
                    filename: 'slides.pdf',
                    download_url: '/api/artifacts/artifact-3/download',
                    size_bytes: 512,
                }],
            }),
        }));
        const { api } = loadWebCliApi(fetchMock);

        const artifacts = await api.getSessionArtifacts('session-1');

        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/api/sessions/session-1/artifacts');
        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-3',
                downloadUrl: '/api/artifacts/artifact-3/download',
                sizeBytes: 512,
            }),
        ]);
    });
});

describe('web-cli API reasoning metadata normalization', () => {
    test('preserves provider reasoning aliases when streaming without the shared gateway helper', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/api/sessions')) {
                return createJsonResponse({ id: 'session-1' });
            }

            return createSseResponse([
                {
                    choices: [{
                        delta: {
                            content: 'Done.',
                            thought_text: 'Checked the command shape before answering.',
                        },
                    }],
                },
                '[DONE]',
            ], { sessionId: 'session-1' });
        });
        const { api } = loadWebCliApi(fetchMock);

        const chunks = [];
        for await (const chunk of api.streamChat('status please')) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'reasoning_summary_delta',
                content: 'Checked the command shape before answering.',
            }),
            expect.objectContaining({ type: 'delta', content: 'Done.' }),
        ]));
        expect(chunks[chunks.length - 1]).toEqual(expect.objectContaining({
            type: 'done',
            assistantMetadata: expect.objectContaining({
                reasoningSummary: 'Checked the command shape before answering.',
                reasoningAvailable: true,
            }),
        }));
    });
});

describe('web-cli API image model lookup', () => {
    test('accepts image generation capabilities from metadata and contract maps', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [
                    {
                        id: 'gateway-image-model',
                        metadata: {
                            name: 'Gateway Image',
                            capabilities: { image_generation: { supported: true } },
                            sizes: ['auto'],
                        },
                    },
                    {
                        id: 'contract-image-model',
                        contract: {
                            capability_map: { image_generation: 'available' },
                        },
                    },
                    {
                        id: 'chat-only-model',
                        metadata: {
                            capabilities: { chat: true },
                        },
                    },
                ],
            }),
        }));
        const { api } = loadWebCliApi(fetchMock);

        const models = await api.getImageModels();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(models.map((model) => model.id)).toEqual([
            'gateway-image-model',
            'contract-image-model',
        ]);
        expect(models[0]).toEqual(expect.objectContaining({
            name: 'Gateway Image',
            sizes: ['auto'],
        }));
    });
});

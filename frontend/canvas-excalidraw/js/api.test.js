const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCanvasApi(fetchMock = jest.fn(), search = '') {
    const sourcePath = path.join(__dirname, 'api.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global instance[\s\S]*$/,
            'module.exports = { OpenAICanvasAPI };'
        );
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
            href: 'http://localhost:3000/canvas/',
            search,
        },
        KimiBuiltGatewaySSE: null,
    };
    const context = {
        module: { exports: {} },
        exports: {},
        window,
        localStorage,
        fetch: fetchMock,
        console,
        URLSearchParams,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: sourcePath });

    return {
        OpenAICanvasAPI: context.module.exports.OpenAICanvasAPI,
        fetchMock,
    };
}

describe('canvas API artifact metadata normalization', () => {
    test('propagates mission and revision lineage into exact-object edits', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                content: '{"actions":[]}',
                artifactLineage: {
                    missionId: 'mission-1',
                    parentArtifactId: 'artifact-1',
                    revision: 3,
                },
            }),
        }));
        const { OpenAICanvasAPI } = loadCanvasApi(
            fetchMock,
            '?artifactId=artifact-1&missionId=mission-1&parentArtifactId=artifact-1&revision=2',
        );
        const api = new OpenAICanvasAPI('http://localhost:3000/v1');

        const result = await api.requestCanvasAgent({ message: 'Change the selected label.' });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);

        expect(body.metadata).toEqual(expect.objectContaining({
            missionId: 'mission-1',
            parentArtifactId: 'artifact-1',
            revision: 2,
            artifactLineage: expect.objectContaining({ artifactId: 'artifact-1' }),
        }));
        expect(result.artifactLineage.revision).toBe(3);
    });

    test('normalizes persisted session artifacts returned by the backend', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                artifacts: [{
                    artifact_id: 'canvas-artifact-1',
                    filename: 'board-export.html',
                    mime_type: 'text/html',
                    size_bytes: 2048,
                    download_url: '/api/artifacts/canvas-artifact-1/download',
                    preview_url: '/api/artifacts/canvas-artifact-1/preview',
                    sandbox_url: '/sandbox/canvas-artifact-1/',
                    bundle_download_url: '/api/artifacts/canvas-artifact-1/bundle',
                }],
            }),
        }));
        const { OpenAICanvasAPI } = loadCanvasApi(fetchMock);
        const api = new OpenAICanvasAPI('http://localhost:3000/v1');

        const artifacts = await api.getSessionArtifacts('session-1');

        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/api/sessions/session-1/artifacts');
        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'canvas-artifact-1',
                artifactId: 'canvas-artifact-1',
                filename: 'board-export.html',
                mimeType: 'text/html',
                size: 2048,
                sizeBytes: 2048,
                downloadUrl: '/api/artifacts/canvas-artifact-1/download',
                previewUrl: '/api/artifacts/canvas-artifact-1/preview',
                sandboxUrl: '/sandbox/canvas-artifact-1/',
                bundleDownloadUrl: '/api/artifacts/canvas-artifact-1/bundle',
            }),
        ]);
    });

    test('drops malformed artifact records without a usable id', () => {
        const { OpenAICanvasAPI } = loadCanvasApi();
        const api = new OpenAICanvasAPI('http://localhost:3000/v1');

        expect(api.normalizeArtifacts([{ filename: 'missing-id.html' }, null])).toEqual([]);
    });
});

describe('canvas API image model lookup', () => {
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
                            capabilityMap: { image_generation: 'available' },
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
        const { OpenAICanvasAPI } = loadCanvasApi(fetchMock);
        const api = new OpenAICanvasAPI('http://localhost:3000/v1');

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

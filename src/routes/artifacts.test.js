const express = require('express');
const request = require('supertest');
const { createFrontendBundleArchive } = require('../frontend-bundles');

jest.mock('../session-store', () => ({
    sessionStore: {
        resolveOwnedSession: jest.fn(),
        getOrCreateOwned: jest.fn(),
        getOwned: jest.fn(),
    },
}));

jest.mock('../artifacts/artifact-service', () => ({
    artifactService: {
        uploadArtifact: jest.fn(),
        generateArtifact: jest.fn(),
        getArtifact: jest.fn(),
        deleteArtifact: jest.fn(),
    },
}));

jest.mock('../utils/multipart', () => ({
    parseMultipartRequest: jest.fn(),
}));

jest.mock('../middleware/validate', () => ({
    validate: () => (_req, _res, next) => next(),
}));

jest.mock('../runtime-tool-manager', () => ({
    ensureRuntimeToolManager: jest.fn(),
}));

jest.mock('../generated-audio-artifacts', () => ({
    getLocalGeneratedAudioArtifact: jest.fn(),
    isLocalGeneratedAudioArtifactId: jest.fn(() => false),
}));

const { sessionStore } = require('../session-store');
const { artifactService } = require('../artifacts/artifact-service');
const {
    getLocalGeneratedAudioArtifact,
    isLocalGeneratedAudioArtifactId,
} = require('../generated-audio-artifacts');
const artifactsRouter = require('./artifacts');

describe('/api/artifacts route', () => {
    function buildApp(options = {}) {
        const app = express();
        app.use(express.json());
        app.locals.managedAppService = {
            isAvailable: jest.fn(() => true),
            createApp: jest.fn(async (input) => ({
                app: {
                    id: 'managed-app-1',
                    appName: input.appName,
                    slug: 'newsroom',
                },
                buildRun: {
                    id: 'build-1',
                    buildStatus: 'queued',
                },
                committedPaths: input.files.map((file) => file.path),
            })),
        };
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        if (options.frameOptions) {
            app.use((_req, res, next) => {
                res.setHeader('X-Frame-Options', options.frameOptions);
                next();
            });
        }
        app.use('/api/artifacts', artifactsRouter);
        return app;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        isLocalGeneratedAudioArtifactId.mockReturnValue(false);
        getLocalGeneratedAudioArtifact.mockResolvedValue(null);
    });

    test('blocks artifact fetch when the artifact session is not owned by the user', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-other',
        });
        sessionStore.getOwned.mockResolvedValue(null);

        const response = await request(buildApp()).get('/api/artifacts/artifact-1');

        expect(response.status).toBe(404);
        expect(sessionStore.getOwned).toHaveBeenCalledWith('session-other', 'phill');
    });

    test('allows artifact download when the artifact session is owned by the user', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-1',
            filename: 'report.txt',
            mimeType: 'text/plain',
            contentBuffer: Buffer.from('hello'),
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-1/download');

        expect(response.status).toBe(200);
        expect(response.text).toBe('hello');
    });

    test('serves local generated audio fallback downloads without Postgres artifacts', async () => {
        isLocalGeneratedAudioArtifactId.mockReturnValue(true);
        getLocalGeneratedAudioArtifact.mockResolvedValue({
            id: 'audio-local-test',
            sessionId: 'session-1',
            filename: 'podcast.wav',
            mimeType: 'audio/wav',
            contentBuffer: Buffer.from('wav-bytes'),
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/audio-local-test/download');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('audio/wav');
        expect(response.headers['content-disposition']).toContain('podcast.wav');
        expect(response.body).toEqual(Buffer.from('wav-bytes'));
        expect(artifactService.getArtifact).not.toHaveBeenCalled();
    });

    test('applies preview-safe headers to inline artifact downloads', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-1',
            filename: 'report.png',
            mimeType: 'image/png',
            contentBuffer: Buffer.from('png-bytes'),
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-1/download?inline=1');

        expect(response.status).toBe(200);
        expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(response.headers['origin-agent-cluster']).toBe('?0');
        expect(response.headers['content-disposition']).toContain('inline;');
    });

    test('serves stored preview html for non-html artifacts', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-text-1',
            sessionId: 'session-1',
            filename: 'notes.txt',
            extension: 'txt',
            mimeType: 'text/plain',
            previewHtml: '<pre>Preview me</pre>',
            contentBuffer: Buffer.from('raw-content'),
            metadata: {},
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-text-1/preview');

        expect(response.status).toBe(200);
        expect(response.text).toContain('<pre>Preview me</pre>');
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });

    test('serves sandbox shells for generated previews', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-1',
            sessionId: 'session-1',
            filename: 'interactive.html',
            extension: 'html',
            previewHtml: '<!DOCTYPE html><html><body><script>window.ready=true</script></body></html>',
            metadata: {},
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-site-1/sandbox');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['content-security-policy']).toContain("default-src 'none'");
        expect(response.text).toContain('sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"');
        expect(response.text).toContain('src="/api/artifacts/artifact-site-1/preview"');
    });

    test('serves tokenized sandbox shells for isolated web-chat previews', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-1',
            sessionId: 'session-1',
            filename: 'interactive.html',
            extension: 'html',
            previewHtml: '<!DOCTYPE html><html><body><script>window.ready=true</script></body></html>',
            metadata: {},
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-site-1/sandbox-access/preview-token');

        expect(response.status).toBe(200);
        expect(response.text).toContain('src="/api/artifacts/artifact-site-1/preview-access/preview-token"');
        expect(response.text).toContain('sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"');
    });

    test('removes frame-blocking headers from sandbox and preview responses', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-1',
            sessionId: 'session-1',
            filename: 'interactive.html',
            extension: 'html',
            previewHtml: '<!DOCTYPE html><html><body><h1>Preview</h1></body></html>',
            contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Preview</h1></body></html>'),
            metadata: {},
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const app = buildApp({ frameOptions: 'SAMEORIGIN' });
        const sandboxResponse = await request(app).get('/api/artifacts/artifact-site-1/sandbox-access/preview-token');
        const previewResponse = await request(app).get('/api/artifacts/artifact-site-1/preview-access/preview-token');

        expect(sandboxResponse.status).toBe(200);
        expect(previewResponse.status).toBe(200);
        expect(sandboxResponse.headers['x-frame-options']).toBeUndefined();
        expect(previewResponse.headers['x-frame-options']).toBeUndefined();
    });

    test('serves bundled html artifact previews from the server', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-1',
            sessionId: 'session-1',
            filename: 'newsroom.html',
            extension: 'html',
            previewHtml: '<!DOCTYPE html><html><body><h1>Front Page</h1></body></html>',
            contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Front Page</h1></body></html>'),
            metadata: {
                type: 'frontend',
                bundle: {
                    entry: 'index.html',
                    files: [
                        {
                            path: 'index.html',
                            language: 'html',
                            purpose: 'Home',
                            content: '<!DOCTYPE html><html><body><a href="world.html">World</a><h1>Front Page</h1></body></html>',
                        },
                        {
                            path: 'world.html',
                            language: 'html',
                            purpose: 'World',
                            content: '<!DOCTYPE html><html><body><h1>World Desk</h1></body></html>',
                        },
                        {
                            path: 'styles.css',
                            language: 'css',
                            purpose: 'Styles',
                            content: 'body { color: #111; }',
                        },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const previewResponse = await request(buildApp()).get('/api/artifacts/artifact-site-1/preview');
        const assetResponse = await request(buildApp()).get('/api/artifacts/artifact-site-1/preview/styles.css');

        expect(previewResponse.status).toBe(200);
        expect(previewResponse.text).toContain('Front Page');
        expect(previewResponse.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(previewResponse.headers['origin-agent-cluster']).toBe('?0');
        expect(assetResponse.status).toBe(200);
        expect(assetResponse.text).toContain('color: #111');
        expect(assetResponse.headers['content-type']).toContain('text/css');
        expect(assetResponse.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });

    test('downloads a bundled html artifact as a zip archive', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-1',
            sessionId: 'session-1',
            filename: 'newsroom.html',
            extension: 'html',
            previewHtml: '<!DOCTYPE html><html><body><h1>Front Page</h1></body></html>',
            contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Front Page</h1></body></html>'),
            metadata: {
                type: 'frontend',
                bundle: {
                    entry: 'index.html',
                    files: [
                        {
                            path: 'index.html',
                            language: 'html',
                            purpose: 'Home',
                            content: '<!DOCTYPE html><html><body><h1>Front Page</h1></body></html>',
                        },
                        {
                            path: 'world.html',
                            language: 'html',
                            purpose: 'World',
                            content: '<!DOCTYPE html><html><body><h1>World Desk</h1></body></html>',
                        },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-site-1/bundle');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/zip');
        expect(response.headers['content-disposition']).toContain('newsroom.zip');
    });

    test('serves preview pages from stored zip site artifacts', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-zip-1',
            sessionId: 'session-1',
            filename: 'newsroom-preview.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    {
                        path: 'index.html',
                        language: 'html',
                        purpose: 'Home',
                        content: '<!DOCTYPE html><html><body><nav><a href="./world/index.html">World</a></nav><main><h1>Front Page</h1></main></body></html>',
                    },
                    {
                        path: 'world/index.html',
                        language: 'html',
                        purpose: 'World',
                        content: '<!DOCTYPE html><html><body><main><h1>World Desk</h1></main></body></html>',
                    },
                ],
            }),
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 2,
                    pageCount: 2,
                    files: [
                        { path: 'index.html' },
                        { path: 'world/index.html' },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-site-zip-1/site/world/');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.text).toContain('World Desk');
    });

    test('blocks artifact delete when the artifact session is not owned by the user', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-other',
        });
        sessionStore.getOwned.mockResolvedValue(null);

        const response = await request(buildApp()).delete('/api/artifacts/artifact-1');

        expect(response.status).toBe(404);
        expect(artifactService.deleteArtifact).not.toHaveBeenCalled();
    });

    test('serves bundled html previews with a preview base and rewritten asset paths', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-1',
            filename: 'newsroom.html',
            extension: 'html',
            mimeType: 'text/html',
            contentBuffer: Buffer.from('<!DOCTYPE html><html><body>fallback</body></html>'),
            metadata: {
                type: 'frontend',
                title: 'Newsroom',
                bundle: {
                    entry: 'index.html',
                    files: [
                        {
                            path: 'index.html',
                            language: 'html',
                            purpose: 'Front page',
                            content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="/styles/site.css"></head><body><nav><a href="world.html">World</a></nav><main><h1>Front Page</h1></main></body></html>',
                        },
                        {
                            path: 'world.html',
                            language: 'html',
                            purpose: 'World page',
                            content: '<!DOCTYPE html><html><body><main><h1>World Desk</h1></main></body></html>',
                        },
                        {
                            path: 'styles/site.css',
                            language: 'css',
                            purpose: 'Shared styles',
                            content: 'body { background-image: url(/images/paper.png); }',
                        },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const previewResponse = await request(buildApp()).get('/api/artifacts/artifact-1/preview');
        expect(previewResponse.status).toBe(200);
        expect(previewResponse.text).toContain('<base href="/api/artifacts/artifact-1/preview/">');
        expect(previewResponse.text).toContain('href="/api/artifacts/artifact-1/preview/styles/site.css"');
        expect(previewResponse.text).toContain('href="world.html"');
        expect(previewResponse.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(previewResponse.headers['origin-agent-cluster']).toBe('?0');

        const cssResponse = await request(buildApp()).get('/api/artifacts/artifact-1/preview/styles/site.css');
        expect(cssResponse.status).toBe(200);
        expect(cssResponse.text).toContain('url(/api/artifacts/artifact-1/preview/images/paper.png)');
        expect(cssResponse.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });

    test('serves tokenized bundled html previews with tokenized assets and inline artifact images', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-1',
            filename: 'newsroom.html',
            extension: 'html',
            mimeType: 'text/html',
            contentBuffer: Buffer.from('<!DOCTYPE html><html><body>fallback</body></html>'),
            metadata: {
                type: 'frontend',
                title: 'Newsroom',
                bundle: {
                    entry: 'index.html',
                    files: [
                        {
                            path: 'index.html',
                            language: 'html',
                            purpose: 'Front page',
                            content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="/styles/site.css"></head><body><img src="/api/artifacts/image-1/download?inline=1" alt="Generated"><main><h1>Front Page</h1></main></body></html>',
                        },
                        {
                            path: 'styles/site.css',
                            language: 'css',
                            purpose: 'Shared styles',
                            content: 'body { background-image: url(/images/paper.png); }',
                        },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const previewResponse = await request(buildApp()).get('/api/artifacts/artifact-1/preview-access/preview-token');
        expect(previewResponse.status).toBe(200);
        expect(previewResponse.text).toContain('<base href="/api/artifacts/artifact-1/preview-access/preview-token/">');
        expect(previewResponse.text).toContain('href="/api/artifacts/artifact-1/preview-access/preview-token/styles/site.css"');
        expect(previewResponse.text).toContain('src="/api/artifacts/image-1/download?inline=1&access_token=preview-token"');

        const cssResponse = await request(buildApp()).get('/api/artifacts/artifact-1/preview-access/preview-token/styles/site.css');
        expect(cssResponse.status).toBe(200);
        expect(cssResponse.text).toContain('url(/api/artifacts/artifact-1/preview-access/preview-token/images/paper.png)');
    });

    test('downloads a generated site bundle as zip', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-1',
            filename: 'newsroom.html',
            extension: 'html',
            mimeType: 'text/html',
            contentBuffer: Buffer.from('<!DOCTYPE html><html><body>fallback</body></html>'),
            metadata: {
                type: 'frontend',
                title: 'Newsroom',
                bundle: {
                    entry: 'index.html',
                    files: [
                        {
                            path: 'index.html',
                            language: 'html',
                            purpose: 'Front page',
                            content: '<!DOCTYPE html><html><body><h1>Front Page</h1></body></html>',
                        },
                        {
                            path: 'world.html',
                            language: 'html',
                            purpose: 'World page',
                            content: '<!DOCTYPE html><html><body><h1>World Desk</h1></body></html>',
                        },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-1/bundle');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/application\/zip/);
        expect(response.headers['content-disposition']).toContain('newsroom.zip');
        expect(Number(response.headers['content-length'] || 0)).toBeGreaterThan(0);
    });

    test('exports a site bundle artifact to the managed app build lane', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-zip-1',
            sessionId: 'session-1',
            filename: 'newsroom-preview.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    {
                        path: 'index.html',
                        language: 'html',
                        purpose: 'Home',
                        content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="./styles.css"></head><body><h1>Front Page</h1></body></html>',
                    },
                    {
                        path: 'styles.css',
                        language: 'css',
                        purpose: 'Styles',
                        content: 'body { color: #111; }',
                    },
                    {
                        path: 'src/main.jsx',
                        language: 'javascript',
                        purpose: 'Vite handoff',
                        content: 'console.log("handoff");',
                    },
                ],
            }),
            metadata: {
                title: 'Newsroom Preview',
                sourcePrompt: 'Build a newsroom website.',
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 3,
                    files: [
                        { path: 'index.html' },
                        { path: 'styles.css' },
                        { path: 'src/main.jsx' },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const app = buildApp();
        const response = await request(app)
            .post('/api/artifacts/artifact-site-zip-1/managed-app')
            .send({ requestedAction: 'deploy', deployRequested: true });

        expect(response.status).toBe(202);
        expect(response.body.fileCount).toBe(3);
        expect(response.body.files).toEqual(['public/index.html', 'public/styles.css', 'src/main.jsx']);
        expect(app.locals.managedAppService.createApp).toHaveBeenCalledWith(
            expect.objectContaining({
                appName: 'Newsroom Preview',
                requestedAction: 'deploy',
                deployRequested: true,
                files: expect.arrayContaining([
                    expect.objectContaining({ path: 'public/index.html' }),
                    expect.objectContaining({ path: 'public/styles.css' }),
                    expect.objectContaining({ path: 'src/main.jsx' }),
                ]),
            }),
            'phill',
            expect.objectContaining({ sessionId: 'session-1' }),
        );
    });
});

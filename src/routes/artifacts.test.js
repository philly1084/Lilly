const express = require('express');
const { createHash } = require('crypto');
const request = require('supertest');
const { createFrontendBundleArchive } = require('../frontend-bundles');

jest.mock('../session-store', () => ({
    sessionStore: {
        resolveOwnedSession: jest.fn(),
        getOrCreateOwned: jest.fn(),
        getOwned: jest.fn(),
        get: jest.fn(),
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

jest.mock('../pii', () => ({
    rehydrateHtml: jest.fn(async (html) => ({
        html: String(html || ''),
        restorations: [],
        enabled: false,
    })),
    rehydrateText: jest.fn(async (text) => ({
        text: String(text || ''),
        restorations: [],
        enabled: false,
    })),
    resolvePiiPolicy: jest.fn(() => ({ enabled: false })),
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
const { rehydrateHtml, rehydrateText, resolvePiiPolicy } = require('../pii');
const artifactsRouter = require('./artifacts');

describe('/api/artifacts route', () => {
    function buildApp(options = {}) {
        const app = express();
        app.use(express.json());
        app.locals.managedAppService = options.managedAppService || {
            isAvailable: jest.fn(() => true),
            createApp: jest.fn(async (input) => ({
                app: {
                    id: 'managed-app-1',
                    appName: input.appName,
                    slug: 'newsroom',
                    publicHost: input.publicHost || '',
                },
                buildRun: {
                    id: 'build-1',
                    buildStatus: 'queued',
                },
                committedPaths: input.files.map((file) => file.path),
            })),
        };
        app.locals.asyncLabService = options.asyncLabService || null;
        app.use((req, _res, next) => {
            req.user = options.user || { username: 'phill' };
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
        rehydrateHtml.mockImplementation(async (html) => ({
            html: String(html || ''),
            restorations: [],
            enabled: false,
        }));
        rehydrateText.mockImplementation(async (text) => ({
            text: String(text || ''),
            restorations: [],
            enabled: false,
        }));
        resolvePiiPolicy.mockReturnValue({ enabled: false });
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

    test('allows open-mode artifact downloads without anonymous owner scoping', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-company-1',
            sessionId: 'agent-company',
            filename: 'company.md',
            mimeType: 'text/markdown',
            contentBuffer: Buffer.from('company artifact'),
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'agent-company',
            metadata: { ownerId: 'system' },
        });

        const response = await request(buildApp({
            user: { username: 'anonymous', role: 'open' },
        })).get('/api/artifacts/artifact-company-1/download');

        expect(response.status).toBe(200);
        expect(response.text).toBe('company artifact');
        expect(sessionStore.getOwned).toHaveBeenCalledWith('agent-company', null);
    });

    test('allows admins to download system-owned Agent Company artifacts surfaced in Admin', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-company-1',
            sessionId: 'agent-company',
            filename: 'company.md',
            mimeType: 'text/markdown',
            contentBuffer: Buffer.from('company artifact'),
        });
        sessionStore.getOwned.mockResolvedValue(null);
        sessionStore.get.mockResolvedValue({
            id: 'agent-company',
            metadata: { ownerId: 'system', clientSurface: 'agent-company' },
        });

        const response = await request(buildApp({
            user: { username: 'phill', role: 'admin' },
        })).get('/api/artifacts/artifact-company-1/download');

        expect(response.status).toBe(200);
        expect(response.text).toBe('company artifact');
        expect(sessionStore.get).toHaveBeenCalledWith('agent-company');
    });

    test('does not grant non-admin users access to a system-owned Agent Company artifact', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-company-1',
            sessionId: 'agent-company',
        });
        sessionStore.getOwned.mockResolvedValue(null);
        sessionStore.get.mockResolvedValue({
            id: 'agent-company',
            metadata: { ownerId: 'system', clientSurface: 'agent-company' },
        });

        const response = await request(buildApp({
            user: { username: 'member', role: 'member' },
        })).get('/api/artifacts/artifact-company-1/download');

        expect(response.status).toBe(404);
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
        expect(rehydrateHtml).toHaveBeenCalledWith(
            '<pre>Preview me</pre>',
            expect.objectContaining({
                clientSurface: 'artifact-preview',
                route: '/api/artifacts/:id/preview',
                highlight: true,
            }),
        );
    });

    test('hides uploaded-file previews when PII protection is enabled', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-upload-1',
            sessionId: 'session-1',
            direction: 'uploaded',
            filename: 'patients.csv',
            extension: 'csv',
            mimeType: 'text/csv',
            previewHtml: '<pre>Jane Patient,123-45-6789</pre>',
            contentBuffer: Buffer.from('Jane Patient,123-45-6789'),
            metadata: {
                piiCleansing: {
                    enabled: true,
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-upload-1/preview');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.text).toContain('Preview hidden');
        expect(response.text).not.toContain('Jane Patient');
        expect(response.text).not.toContain('123-45-6789');
    });

    test('serves PDF previews as inline PDF bytes instead of stored text fallback html', async () => {
        const pdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\nendobj\n%%EOF', 'latin1');
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-pdf-1',
            sessionId: 'session-1',
            filename: 'resume.pdf',
            extension: 'pdf',
            mimeType: 'application/pdf',
            previewHtml: '<pre>%PDF-1.4 raw object fallback</pre>',
            contentBuffer: pdfBuffer,
            metadata: {},
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const response = await request(buildApp()).get('/api/artifacts/artifact-pdf-1/preview');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/pdf');
        expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(response.body).toEqual(pdfBuffer);
        expect(response.text || '').not.toContain('raw object fallback');
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

    test('queues long-running artifact generation through the async runtime when requested', async () => {
        sessionStore.resolveOwnedSession.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const createRun = jest.fn(async () => ({
            run: {
                id: 'async-artifact-1',
                adapter: 'document-workflow',
                targetKey: 'artifact:session-1:html',
                status: 'queued',
            },
            events: [{ type: 'queued', cursor: 1 }],
            duplicate: false,
        }));

        const response = await request(buildApp({
            asyncLabService: {
                isEnabled: jest.fn(() => true),
                createRun,
            },
        }))
            .post('/api/artifacts/generate')
            .send({
                sessionId: 'session-1',
                mode: 'document',
                prompt: 'Create a deployment report.',
                format: 'html',
                asyncRuntimePreferred: true,
                model: 'gpt-5.4-mini',
                reasoningEffort: 'medium',
                parentArtifactId: 'artifact-parent',
                missionId: 'mission-1',
                revision: 3,
                provenance: { runId: 'run-1' },
            });

        expect(response.status).toBe(202);
        expect(response.body.asyncRuntime.run.id).toBe('async-artifact-1');
        expect(createRun).toHaveBeenCalledWith(
            expect.objectContaining({
                adapter: 'document-workflow',
                task: 'Create a deployment report.',
                targetKey: 'artifact:session-1:html',
                sessionId: 'session-1',
                requireGeneratedIdempotency: true,
                metadata: expect.objectContaining({
                    source: 'artifact-generate',
                    outputFormat: 'html',
                    toolParams: expect.objectContaining({
                        action: 'generate',
                        prompt: 'Create a deployment report.',
                        format: 'html',
                        model: 'gpt-5.4-mini',
                        reasoningEffort: 'medium',
                        parentArtifactId: 'artifact-parent',
                        missionId: 'mission-1',
                        revision: 3,
                        provenance: { runId: 'run-1' },
                    }),
                }),
            }),
            'phill',
        );
        expect(artifactService.generateArtifact).not.toHaveBeenCalled();
    });

    test('forwards mission and revision lineage into synchronous artifact generation', async () => {
        sessionStore.resolveOwnedSession.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        artifactService.generateArtifact.mockResolvedValue({
            responseId: null,
            artifact: { id: 'artifact-child', missionId: 'mission-1', revision: 2 },
        });

        const response = await request(buildApp())
            .post('/api/artifacts/generate')
            .send({
                sessionId: 'session-1',
                mode: 'document',
                prompt: 'Revise the selected sentence only.',
                format: 'html',
                parentArtifactId: 'artifact-parent',
                missionId: 'mission-1',
                revision: 2,
                provenance: { sourceSurface: 'notes', runId: 'run-1' },
                runId: 'run-1',
            });

        expect(response.status).toBe(201);
        expect(artifactService.generateArtifact).toHaveBeenCalledWith(expect.objectContaining({
            parentArtifactId: 'artifact-parent',
            missionId: 'mission-1',
            revision: 2,
            provenance: { sourceSurface: 'notes', runId: 'run-1' },
            toolContext: expect.objectContaining({
                clientSurface: 'document',
                runId: 'run-1',
            }),
        }));
    });

    test('preflights the exact final managed-app paths, byte sizes, and hashes without creating an app', async () => {
        const indexHtml = '<!doctype html><html><body><h1>Crème launch 🚀</h1></body></html>';
        const styles = 'body { color: #123; }\n';
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-preflight-parity',
            sessionId: 'session-1',
            filename: 'launch-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    { path: 'index.html', content: indexHtml },
                    { path: 'styles.css', content: styles },
                ],
            }),
            metadata: {
                title: 'Launch Site',
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 2,
                    files: [
                        { path: 'index.html', mimeType: 'text/html' },
                        { path: 'styles.css', mimeType: 'text/css' },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const app = buildApp();
        const preflight = await request(app)
            .post('/api/artifacts/artifact-site-preflight-parity/managed-app/preflight')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body).toEqual(expect.objectContaining({
            artifactId: 'artifact-site-preflight-parity',
            contentEligible: true,
            controlPlaneAvailable: true,
            pushToWebEligible: true,
            sourceType: 'native-site-archive',
            targetPaths: ['public/index.html', 'public/styles.css'],
            fileCount: 2,
            sizeBytes: Buffer.byteLength(indexHtml, 'utf8') + Buffer.byteLength(styles, 'utf8'),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            blockers: [],
        }));
        expect(preflight.body.files).toEqual([
            {
                path: 'public/index.html',
                sizeBytes: Buffer.byteLength(indexHtml, 'utf8'),
                sha256: createHash('sha256').update(Buffer.from(indexHtml, 'utf8')).digest('hex'),
            },
            {
                path: 'public/styles.css',
                sizeBytes: Buffer.byteLength(styles, 'utf8'),
                sha256: createHash('sha256').update(Buffer.from(styles, 'utf8')).digest('hex'),
            },
        ]);
        expect(preflight.body.files.every((file) => !Object.prototype.hasOwnProperty.call(file, 'content'))).toBe(true);
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();

        const mutation = await request(app)
            .post('/api/artifacts/artifact-site-preflight-parity/managed-app')
            .send({
                requestedAction: 'build',
                expectedSourceSha256: preflight.body.sha256,
            });

        expect(mutation.status).toBe(202);
        expect(mutation.body).toEqual(expect.objectContaining({
            sourceSha256: preflight.body.sha256,
            sourceSizeBytes: preflight.body.sizeBytes,
        }));
        const createdFiles = app.locals.managedAppService.createApp.mock.calls[0][0].files;
        expect(createdFiles.map((file) => ({
            path: file.path,
            sizeBytes: Buffer.byteLength(file.content, 'utf8'),
            sha256: createHash('sha256').update(Buffer.from(file.content, 'utf8')).digest('hex'),
        }))).toEqual(preflight.body.files);
        expect(app.locals.managedAppService.createApp.mock.calls[0][0].metadata.sourceArtifact).toEqual(
            expect.objectContaining({
                id: 'artifact-site-preflight-parity',
                sha256: preflight.body.sha256,
                sizeBytes: preflight.body.sizeBytes,
                fileCount: preflight.body.fileCount,
            }),
        );
    });

    test('blocks preflight and mutation when exact prepared HTML fails artifact quality validation', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-quality-html',
            sessionId: 'session-1',
            filename: 'broken-preview.html',
            extension: 'html',
            mimeType: 'text/html',
            contentBuffer: Buffer.from('{"not":"html"}', 'utf8'),
            previewHtml: '{"not":"html"}',
            metadata: {},
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-site-quality-html/managed-app/preflight')
            .send({});
        const mutation = await request(app)
            .post('/api/artifacts/artifact-site-quality-html/managed-app')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body).toEqual(expect.objectContaining({
            contentEligible: false,
            pushToWebEligible: false,
            targetPaths: [],
            fileCount: 0,
            sizeBytes: 0,
            sha256: null,
            blockers: [expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_QUALITY_BLOCKED',
                blocker: 'artifact_quality_blocked',
                details: expect.objectContaining({
                    status: 'blocked',
                    blockers: expect.arrayContaining([
                        expect.objectContaining({ code: 'REMOTE_AGENT_ARTIFACT_HTML_INVALID' }),
                    ]),
                }),
            })],
        }));
        expect(mutation.status).toBe(422);
        expect(mutation.body).toEqual({
            error: expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_QUALITY_BLOCKED',
                blocker: 'artifact_quality_blocked',
            }),
        });
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('blocks exact prepared XML, SVG, and unresolved local site references before deployment', async () => {
        const indexHtml = `<!doctype html><html><body><main>
            <link rel="stylesheet" href="./missing.css">
            <a href="./design/design.xml">Design contract</a>
            <img src="./design/design.svg" alt="Design diagram">
        </main></body></html>`;
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-quality-members',
            sessionId: 'session-1',
            filename: 'broken-members.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    { path: 'index.html', content: indexHtml },
                    { path: 'design/design.xml', content: '<design><open></design>' },
                    { path: 'design/design.svg', content: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
                ],
            }),
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 3,
                    files: [
                        { path: 'index.html', mimeType: 'text/html' },
                        { path: 'design/design.xml', mimeType: 'application/xml' },
                        { path: 'design/design.svg', mimeType: 'image/svg+xml' },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-site-quality-members/managed-app/preflight')
            .send({});
        const mutation = await request(app)
            .post('/api/artifacts/artifact-site-quality-members/managed-app')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body.pushToWebEligible).toBe(false);
        const blocker = preflight.body.blockers[0];
        expect(blocker).toEqual(expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_QUALITY_BLOCKED',
            blocker: 'artifact_quality_blocked',
        }));
        expect(blocker.details.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
            'REMOTE_AGENT_ARTIFACT_XML_INVALID',
            'REMOTE_AGENT_ARTIFACT_SVG_ROOT_INVALID',
            'REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_MISSING',
        ]));
        expect(blocker.details.site).toEqual(expect.objectContaining({
            enabled: true,
            entries: ['index.html'],
        }));
        expect(mutation.status).toBe(422);
        expect(mutation.body.error.code).toBe('ARTIFACT_MANAGED_APP_QUALITY_BLOCKED');
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('restores protected HTML as escaped text without preview markup or executable injection', async () => {
        const placeholder = '[[PII:NAME:canary]]';
        const restoredName = '<img src=x onerror="alert(1)">';
        const escapedRestoredName = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';
        const sourceFiles = [
            {
                path: 'index.html',
                content: `<!doctype html><html><body><h1>${placeholder}</h1></body></html>`,
            },
            {
                path: 'styles.css',
                content: ':root { --owner: "canary"; }\n',
            },
            {
                path: 'data.xml',
                content: '<site><owner>canary</owner></site>',
            },
        ];
        rehydrateHtml.mockImplementation(async (html, options) => ({
            html: String(html || '').replaceAll(
                placeholder,
                options.escapeValues ? escapedRestoredName : restoredName,
            ),
            restorations: [{ placeholder }],
            enabled: true,
            options,
        }));
        rehydrateText.mockImplementation(async (text, options) => ({
            text: String(text || ''),
            restorations: [],
            enabled: true,
            options,
        }));
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-pii-final-bytes',
            sessionId: 'session-1',
            filename: 'protected-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: sourceFiles,
            }),
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: sourceFiles.length,
                    files: [
                        { path: 'index.html', mimeType: 'text/html' },
                        { path: 'styles.css', mimeType: 'text/css' },
                        { path: 'data.xml', mimeType: 'application/xml' },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-site-pii-final-bytes/managed-app/preflight')
            .send({});
        const mutation = await request(app)
            .post('/api/artifacts/artifact-site-pii-final-bytes/managed-app')
            .send({ expectedSourceSha256: preflight.body.sha256 });

        expect(preflight.status).toBe(200);
        expect(preflight.body.pushToWebEligible).toBe(true);
        expect(mutation.status).toBe(202);
        expect(mutation.body.sourceSha256).toBe(preflight.body.sha256);
        const createdFiles = app.locals.managedAppService.createApp.mock.calls[0][0].files;
        expect(createdFiles.map((file) => file.path)).toEqual([
            'public/data.xml',
            'public/index.html',
            'public/styles.css',
        ]);
        const createdIndex = createdFiles.find((file) => file.path === 'public/index.html');
        expect(createdIndex.content).toContain(escapedRestoredName);
        expect(createdIndex.content).not.toContain(restoredName);
        expect(createdIndex.content).not.toContain('<img');
        expect(createdFiles.every((file) => (
            !file.content.includes(placeholder)
            && !file.content.includes('<mark')
            && !file.content.includes('kb-pii-restored')
        ))).toBe(true);
        expect(createdFiles.map((file) => ({
            path: file.path,
            sizeBytes: Buffer.byteLength(file.content, 'utf8'),
            sha256: createHash('sha256').update(Buffer.from(file.content, 'utf8')).digest('hex'),
        }))).toEqual(preflight.body.files);
        expect(rehydrateHtml.mock.calls).toHaveLength(2);
        expect(rehydrateText.mock.calls).toHaveLength(4);
        expect([...rehydrateHtml.mock.calls, ...rehydrateText.mock.calls]
            .every(([, options]) => options.highlight === false)).toBe(true);
        expect(rehydrateHtml.mock.calls.every(([, options]) => options.escapeValues === true)).toBe(true);
    });

    test('fails closed when protected values would be restored into a non-HTML deployment file', async () => {
        const placeholder = '[[PII:NAME:structured]]';
        rehydrateText.mockImplementation(async (text) => ({
            text: String(text || '').replaceAll(placeholder, '"; background: url(javascript:alert(1)); /*'),
            restorations: String(text || '').includes(placeholder) ? [{ placeholder }] : [],
            enabled: true,
        }));
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-pii-structured-restoration',
            sessionId: 'session-1',
            filename: 'protected-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    { path: 'index.html', content: '<!doctype html><html><body>Safe</body></html>' },
                    { path: 'styles.css', content: `:root { --owner: "${placeholder}"; }` },
                ],
            }),
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 2,
                    files: [
                        { path: 'index.html', mimeType: 'text/html' },
                        { path: 'styles.css', mimeType: 'text/css' },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-pii-structured-restoration/managed-app/preflight')
            .send({});
        const mutation = await request(app)
            .post('/api/artifacts/artifact-pii-structured-restoration/managed-app')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body.pushToWebEligible).toBe(false);
        expect(preflight.body.blockers).toEqual([expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_PII_RESTORATION_FAILED',
            blocker: 'pii_restoration_failed',
        })]);
        expect(mutation.status).toBe(503);
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
        expect(JSON.stringify(preflight.body)).not.toContain('javascript:alert');
        warn.mockRestore();
    });

    test('blocks a site bundle whose persisted component was already raw-restored before deployment context was known', async () => {
        const siteArtifact = {
            id: 'artifact-pre-restored-site',
            sessionId: 'session-1',
            filename: 'pre-restored-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [{ path: 'index.html', content: '<!doctype html><html><body><script>alert(1)</script></body></html>' }],
            }),
            metadata: {
                generationStrategy: 'remote-agent-result-site-bundle',
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 1,
                    files: [{
                        path: 'index.html',
                        mimeType: 'text/html',
                        artifactId: 'artifact-pre-restored-component',
                    }],
                },
            },
        };
        const componentArtifact = {
            id: 'artifact-pre-restored-component',
            sessionId: 'session-1',
            filename: 'index.html',
            metadata: {
                piiCleansing: {
                    enabled: true,
                    restoredCount: 1,
                    restoredInGeneratedArtifact: true,
                },
            },
        };
        artifactService.getArtifact.mockImplementation(async (artifactId) => (
            artifactId === siteArtifact.id ? siteArtifact : componentArtifact
        ));
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-pre-restored-site/managed-app/preflight')
            .send({});
        const mutation = await request(app)
            .post('/api/artifacts/artifact-pre-restored-site/managed-app')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body).toEqual(expect.objectContaining({
            contentEligible: false,
            pushToWebEligible: false,
            files: [],
            sha256: null,
            blockers: [expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_PRE_RESTORED_PII_UNSAFE',
                blocker: 'pre_restored_pii_context_unsafe',
                details: expect.objectContaining({ affectedPaths: ['index.html'] }),
            })],
        }));
        expect(mutation.status).toBe(422);
        expect(mutation.body.error).toEqual(expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_PRE_RESTORED_PII_UNSAFE',
            blocker: 'pre_restored_pii_context_unsafe',
        }));
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test.each([true, false])('fails preflight and mutation closed when reserved placeholders remain with PII enabled=%s', async (enabled) => {
        rehydrateHtml.mockImplementation(async (html) => ({
            html,
            restorations: [],
            enabled,
        }));
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-pii-restoration-failure',
            sessionId: 'session-1',
            filename: 'protected.html',
            extension: 'html',
            mimeType: 'text/html',
            previewHtml: '<!doctype html><html><body>[[PII:NAME:failure]]</body></html>',
            contentBuffer: Buffer.from('<!doctype html><html><body>redacted</body></html>', 'utf8'),
            metadata: {},
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-pii-restoration-failure/managed-app/preflight')
            .send({});
        const mutation = await request(app)
            .post('/api/artifacts/artifact-pii-restoration-failure/managed-app')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body).toEqual(expect.objectContaining({
            contentEligible: false,
            pushToWebEligible: false,
            targetPaths: [],
            fileCount: 0,
            sha256: null,
            blockers: [expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_PII_RESTORATION_FAILED',
                blocker: 'pii_restoration_failed',
            })],
        }));
        expect(mutation.status).toBe(503);
        expect(mutation.body.error).toEqual(expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_PII_RESTORATION_FAILED',
            blocker: 'pii_restoration_failed',
        }));
        expect(JSON.stringify(preflight.body)).not.toContain('Protected placeholders remain');
        expect(JSON.stringify(mutation.body)).not.toContain('Protected placeholders remain');
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('rejects a stale preflight fingerprint before creating or changing a managed app', async () => {
        const buildArtifact = (content) => ({
            id: 'artifact-site-source-changed',
            sessionId: 'session-1',
            filename: 'source.html',
            extension: 'html',
            mimeType: 'text/html',
            previewHtml: content,
            contentBuffer: Buffer.from(content, 'utf8'),
            metadata: {},
        });
        artifactService.getArtifact
            .mockResolvedValueOnce(buildArtifact('<!doctype html><html><body>Version one</body></html>'))
            .mockResolvedValueOnce(buildArtifact('<!doctype html><html><body>Version two</body></html>'));
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-site-source-changed/managed-app/preflight')
            .send({});
        const mutation = await request(app)
            .post('/api/artifacts/artifact-site-source-changed/managed-app')
            .send({ expectedSourceSha256: preflight.body.sha256 });

        expect(preflight.status).toBe(200);
        expect(mutation.status).toBe(412);
        expect(mutation.body.error).toEqual(expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_SOURCE_CHANGED',
            blocker: 'managed_app_source_changed',
            details: expect.objectContaining({
                expectedSha256: preflight.body.sha256,
                actualSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
        }));
        expect(mutation.body.error.details.actualSha256).not.toBe(preflight.body.sha256);
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('uses typed blockers with control-plane-first priority for an empty source', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-empty-source',
            sessionId: 'session-1',
            filename: 'empty.txt',
            extension: 'txt',
            mimeType: 'text/plain',
            contentBuffer: Buffer.alloc(0),
            metadata: {},
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const managedAppService = {
            isAvailable: jest.fn(() => false),
            createApp: jest.fn(),
        };
        const app = buildApp({ managedAppService });

        const preflight = await request(app)
            .post('/api/artifacts/artifact-site-empty-source/managed-app/preflight')
            .send({});
        const unavailableMutation = await request(app)
            .post('/api/artifacts/artifact-site-empty-source/managed-app')
            .send({});
        managedAppService.isAvailable.mockReturnValue(true);
        const emptyMutation = await request(app)
            .post('/api/artifacts/artifact-site-empty-source/managed-app')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body.blockers.map((blocker) => blocker.code)).toEqual([
            'ARTIFACT_MANAGED_APP_CONTROL_PLANE_UNAVAILABLE',
            'ARTIFACT_MANAGED_APP_NO_DEPLOYABLE_FILES',
        ]);
        expect(unavailableMutation.status).toBe(503);
        expect(unavailableMutation.body.error).toEqual(expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_CONTROL_PLANE_UNAVAILABLE',
            blocker: 'managed_app_control_plane_unavailable',
        }));
        expect(emptyMutation.status).toBe(400);
        expect(emptyMutation.body.error).toEqual(expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_NO_DEPLOYABLE_FILES',
            blocker: 'no_deployable_website_files',
        }));
        expect(managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('applies the same session-ownership boundary to managed-app preflight', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-preflight-not-owned',
            sessionId: 'session-other',
            filename: 'private.html',
            previewHtml: '<!doctype html><html><body>Private</body></html>',
        });
        sessionStore.getOwned.mockResolvedValue(null);
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-preflight-not-owned/managed-app/preflight')
            .send({});

        expect(preflight.status).toBe(404);
        expect(preflight.body).toEqual({ error: { message: 'Artifact not found' } });
        expect(sessionStore.getOwned).toHaveBeenCalledWith('session-other', 'phill');
        expect(app.locals.managedAppService.isAvailable).not.toHaveBeenCalled();
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('reports a valid source but blocks Push to Web when the managed-app control plane is unavailable', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-preflight-control-plane',
            sessionId: 'session-1',
            filename: 'landing.html',
            extension: 'html',
            mimeType: 'text/html',
            previewHtml: '<!doctype html><html><body>Ready</body></html>',
            contentBuffer: Buffer.from('<!doctype html><html><body>Raw</body></html>', 'utf8'),
            metadata: { title: 'Ready Landing' },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const managedAppService = {
            isAvailable: jest.fn(() => false),
            createApp: jest.fn(),
        };
        const app = buildApp({ managedAppService });

        const preflight = await request(app)
            .post('/api/artifacts/artifact-preflight-control-plane/managed-app/preflight')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body).toEqual(expect.objectContaining({
            contentEligible: true,
            controlPlaneAvailable: false,
            pushToWebEligible: false,
            sourceType: 'preview-html',
            targetPaths: ['public/index.html'],
            sizeBytes: Buffer.byteLength('<!doctype html><html><body>Ready</body></html>', 'utf8'),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            blockers: [expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_CONTROL_PLANE_UNAVAILABLE',
                blocker: 'managed_app_control_plane_unavailable',
            })],
        }));
        expect(managedAppService.createApp).not.toHaveBeenCalled();

        const mutation = await request(app)
            .post('/api/artifacts/artifact-preflight-control-plane/managed-app')
            .send({});

        expect(mutation.status).toBe(503);
        expect(mutation.body).toEqual({
            error: {
                code: 'ARTIFACT_MANAGED_APP_CONTROL_PLANE_UNAVAILABLE',
                message: 'Managed app export requires the managed app control plane to be available.',
                blocker: 'managed_app_control_plane_unavailable',
            },
        });
        expect(managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('fails preflight closed with a typed blocker for an invalid native site archive', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-preflight-invalid-site',
            sessionId: 'session-1',
            filename: 'invalid-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: Buffer.from('not a zip archive', 'utf8'),
            previewHtml: '<!doctype html><html><body>Unsafe fallback</body></html>',
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 1,
                    files: [{ path: 'index.html' }],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-preflight-invalid-site/managed-app/preflight')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body).toEqual(expect.objectContaining({
            contentEligible: false,
            controlPlaneAvailable: true,
            pushToWebEligible: false,
            sourceType: 'native-site-archive',
            targetPaths: [],
            fileCount: 0,
            sizeBytes: 0,
            sha256: null,
            files: [],
            blockers: [expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_INVALID_SITE_BUNDLE',
                blocker: 'invalid_site_bundle',
                details: expect.objectContaining({ reason: 'archive_parse_failed' }),
            })],
        }));
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('fails preflight closed with a typed blocker for unsupported binary site members', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-preflight-binary-site',
            sessionId: 'session-1',
            filename: 'binary-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    { path: 'index.html', content: '<!doctype html><html><body>Binary</body></html>' },
                    { path: 'assets/logo.png', language: 'binary', contentBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
                ],
            }),
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 2,
                    files: [
                        { path: 'index.html', mimeType: 'text/html' },
                        { path: 'assets/logo.png', language: 'binary', mimeType: 'image/png' },
                    ],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const app = buildApp();

        const preflight = await request(app)
            .post('/api/artifacts/artifact-preflight-binary-site/managed-app/preflight')
            .send({});

        expect(preflight.status).toBe(200);
        expect(preflight.body).toEqual(expect.objectContaining({
            contentEligible: false,
            controlPlaneAvailable: true,
            pushToWebEligible: false,
            sourceType: 'native-site-archive',
            targetPaths: [],
            sizeBytes: 0,
            sha256: null,
            files: [],
            blockers: [expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_UNSUPPORTED_BINARY_ASSETS',
                blocker: 'unsupported_binary_assets',
                details: expect.objectContaining({ unsupportedAssets: ['assets/logo.png'] }),
            })],
        }));
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
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
                    {
                        path: 'assets/logo.svg',
                        language: 'svg',
                        purpose: 'Portable logo',
                        content: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h8v8z"/></svg>',
                    },
                    {
                        path: 'data/config.xml',
                        language: 'xml',
                        purpose: 'Site configuration',
                        content: '<config><theme>newsroom</theme></config>',
                    },
                ],
            }),
            metadata: {
                title: 'Newsroom Preview',
                sourcePrompt: 'Build a newsroom website.',
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 5,
                    files: [
                        { path: 'index.html' },
                        { path: 'styles.css' },
                        { path: 'src/main.jsx' },
                        { path: 'assets/logo.svg', mimeType: 'image/svg+xml' },
                        { path: 'data/config.xml', mimeType: 'application/xml' },
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
        expect(response.body.fileCount).toBe(5);
        expect(response.body.files).toEqual([
            'public/assets/logo.svg',
            'public/data/config.xml',
            'public/index.html',
            'public/styles.css',
            'src/main.jsx',
        ]);
        expect(app.locals.managedAppService.createApp).toHaveBeenCalledWith(
            expect.objectContaining({
                appName: 'Newsroom Preview',
                requestedAction: 'deploy',
                deployRequested: true,
                files: expect.arrayContaining([
                    expect.objectContaining({ path: 'public/index.html' }),
                    expect.objectContaining({ path: 'public/styles.css' }),
                    expect.objectContaining({ path: 'public/assets/logo.svg' }),
                    expect.objectContaining({ path: 'public/data/config.xml' }),
                    expect.objectContaining({ path: 'src/main.jsx' }),
                ]),
            }),
            'phill',
            expect.objectContaining({ sessionId: 'session-1' }),
        );
    });

    test('preserves every safe UTF-8 native archive member regardless of file extension', async () => {
        const archiveIndex = '<!doctype html><html><body><h1>Archive source</h1></body></html>';
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-text-extensions-1',
            sessionId: 'session-1',
            filename: 'portable-text-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            previewHtml: '<!doctype html><html><body><h1>Stale preview fallback</h1></body></html>',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    { path: 'index.html', content: archiveIndex },
                    { path: 'config/site.yaml', content: 'theme: midnight\nlocale: en-CA\n' },
                    { path: 'shaders/hero.glsl', content: 'void main() { gl_FragColor = vec4(1.0); }\n' },
                    { path: 'manifest.webmanifest', content: '{"name":"Portable Site"}\n' },
                    { path: 'CNAME', content: 'portable.example.test\n' },
                ],
            }),
            metadata: {
                title: 'Portable Text Site',
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 5,
                    files: [
                        { path: 'index.html' },
                        { path: 'config/site.yaml' },
                        { path: 'shaders/hero.glsl' },
                        { path: 'manifest.webmanifest', mimeType: 'application/manifest+json' },
                        { path: 'CNAME' },
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
            .post('/api/artifacts/artifact-site-text-extensions-1/managed-app')
            .send({ requestedAction: 'build' });

        expect(response.status).toBe(202);
        expect(response.body.files).toEqual([
            'public/CNAME',
            'public/config/site.yaml',
            'public/index.html',
            'public/manifest.webmanifest',
            'public/shaders/hero.glsl',
        ]);
        const createInput = app.locals.managedAppService.createApp.mock.calls[0][0];
        expect(createInput.files).toEqual(expect.arrayContaining([
            { path: 'public/CNAME', content: 'portable.example.test\n' },
            { path: 'public/config/site.yaml', content: 'theme: midnight\nlocale: en-CA\n' },
            { path: 'public/index.html', content: archiveIndex },
            { path: 'public/manifest.webmanifest', content: '{"name":"Portable Site"}\n' },
            { path: 'public/shaders/hero.glsl', content: 'void main() { gl_FragColor = vec4(1.0); }\n' },
        ]));
        expect(createInput.files.find((file) => file.path === 'public/index.html').content)
            .not.toContain('Stale preview fallback');
    });

    test('typed-blocks a malformed explicit native site ZIP instead of deploying preview HTML', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-malformed-1',
            sessionId: 'session-1',
            filename: 'malformed-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: Buffer.from('this is not a ZIP archive', 'utf8'),
            previewHtml: '<!doctype html><html><body><h1>Must not deploy</h1></body></html>',
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 1,
                    files: [{ path: 'index.html' }],
                },
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const app = buildApp();
        const response = await request(app)
            .post('/api/artifacts/artifact-site-malformed-1/managed-app')
            .send({ requestedAction: 'deploy', deployRequested: true });

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
            error: expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_INVALID_SITE_BUNDLE',
                blocker: 'invalid_site_bundle',
                details: expect.objectContaining({
                    reason: 'archive_parse_failed',
                    remediation: expect.stringContaining('Regenerate the site ZIP'),
                }),
            }),
        });
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('typed-blocks a native site ZIP that omits a declared member', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-incomplete-1',
            sessionId: 'session-1',
            filename: 'incomplete-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    { path: 'index.html', content: '<!doctype html><html><body>Incomplete</body></html>' },
                ],
            }),
            previewHtml: '<!doctype html><html><body>Fallback must not deploy</body></html>',
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 2,
                    files: [
                        { path: 'index.html' },
                        { path: 'config/site.yaml' },
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
            .post('/api/artifacts/artifact-site-incomplete-1/managed-app')
            .send({ requestedAction: 'deploy', deployRequested: true });

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
            error: expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_INVALID_SITE_BUNDLE',
                blocker: 'invalid_site_bundle',
                details: expect.objectContaining({
                    reason: 'declared_members_missing_from_archive',
                    affectedMembers: ['config/site.yaml'],
                }),
            }),
        });
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('rejects Push to Web when a native site bundle contains unsupported binary assets', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const opaqueBinary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x10]);
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-site-binary-1',
            sessionId: 'session-1',
            filename: 'binary-site.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            contentBuffer: createFrontendBundleArchive({
                entry: 'index.html',
                files: [
                    {
                        path: 'index.html',
                        language: 'html',
                        content: '<!doctype html><html><body><img src="assets/hero.png"></body></html>',
                    },
                    {
                        path: 'assets/hero.png',
                        language: 'binary',
                        contentBuffer: png,
                    },
                    {
                        path: 'assets/texture.asset',
                        contentBuffer: opaqueBinary,
                    },
                ],
            }),
            metadata: {
                title: 'Binary Site',
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 3,
                    files: [
                        { path: 'index.html', language: 'html', mimeType: 'text/html' },
                        { path: 'assets/hero.png', language: 'binary', mimeType: 'image/png' },
                        { path: 'assets/texture.asset' },
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
            .post('/api/artifacts/artifact-site-binary-1/managed-app')
            .send({ requestedAction: 'deploy', deployRequested: true });

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
            error: expect.objectContaining({
                code: 'ARTIFACT_MANAGED_APP_UNSUPPORTED_BINARY_ASSETS',
                blocker: 'unsupported_binary_assets',
                details: expect.objectContaining({
                    unsupportedAssets: ['assets/hero.png', 'assets/texture.asset'],
                    remediation: expect.stringContaining('SVG/XML/text'),
                }),
            }),
        });
        expect(app.locals.managedAppService.createApp).not.toHaveBeenCalled();
    });

    test('exports a previewable single HTML artifact with requested DNS host', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-html-1',
            sessionId: 'session-1',
            filename: 'landing-page.html',
            extension: 'html',
            mimeType: 'text/html',
            previewHtml: '<!DOCTYPE html><html><body><img src="https://example.com/hero.jpg"><h1>Landing</h1></body></html>',
            contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Raw</h1></body></html>'),
            metadata: {
                title: 'Landing Page',
                sourcePrompt: 'Build a landing page with images.',
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const app = buildApp();
        const response = await request(app)
            .post('/api/artifacts/artifact-html-1/managed-app')
            .send({
                requestedAction: 'deploy',
                deployRequested: true,
                dnsName: 'demo',
                publicBaseDomain: 'demoserver2.buzz',
            });

        expect(response.status).toBe(202);
        expect(response.body.fileCount).toBe(1);
        expect(response.body.files).toEqual(['public/index.html']);
        expect(response.body.publicHost).toBe('demo.demoserver2.buzz');
        expect(app.locals.managedAppService.createApp).toHaveBeenCalledWith(
            expect.objectContaining({
                appName: 'Landing Page',
                publicHost: 'demo.demoserver2.buzz',
                requestedAction: 'deploy',
                deployRequested: true,
                files: [
                    expect.objectContaining({
                        path: 'public/index.html',
                        content: expect.stringContaining('hero.jpg'),
                    }),
                ],
                metadata: expect.objectContaining({
                    requestedPublicHost: 'demo.demoserver2.buzz',
                    acmeRequestHost: 'demo.demoserver2.buzz',
                }),
            }),
            'phill',
            expect.objectContaining({ sessionId: 'session-1' }),
        );
    });

    test('queues requested managed-app deploys through the async runtime when enabled', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'artifact-html-async',
            sessionId: 'session-1',
            filename: 'landing-page.html',
            extension: 'html',
            mimeType: 'text/html',
            previewHtml: '<!DOCTYPE html><html><body><h1>Async</h1></body></html>',
            contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Raw</h1></body></html>'),
            metadata: {
                title: 'Async Landing',
                sourcePrompt: 'Build an async landing page.',
            },
        });
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        const createRun = jest.fn(async () => ({
            run: {
                id: 'async-run-1',
                adapter: 'managed-app',
                targetKey: 'managed-app:async-demo.demoserver2.buzz',
                status: 'queued',
            },
            events: [{ type: 'queued', cursor: 1 }],
            duplicate: false,
        }));

        const app = buildApp({
            asyncLabService: {
                isEnabled: jest.fn(() => true),
                createRun,
            },
        });
        const response = await request(app)
            .post('/api/artifacts/artifact-html-async/managed-app')
            .send({
                requestedAction: 'deploy',
                deployRequested: true,
                dnsName: 'async-demo',
                publicBaseDomain: 'demoserver2.buzz',
            });

        expect(response.status).toBe(202);
        expect(response.body.asyncRuntime.run.id).toBe('async-run-1');
        expect(createRun).toHaveBeenCalledWith(
            expect.objectContaining({
                adapter: 'managed-app',
                targetKey: 'managed-app:async-demo.demoserver2.buzz',
                liveRemote: true,
                idempotencyKey: 'managed-app-deploy:managed-app-1:build-1',
                metadata: expect.objectContaining({
                    appRef: 'managed-app-1',
                    publicHost: 'async-demo.demoserver2.buzz',
                    toolParams: expect.objectContaining({
                        action: 'deploy',
                        appRef: 'managed-app-1',
                        deployRequested: true,
                        publicHost: 'async-demo.demoserver2.buzz',
                    }),
                }),
            }),
            'phill',
        );
    });
});

'use strict';

const request = require('supertest');

jest.setTimeout(20000);

describe('server readiness', () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    test('keeps /ready degraded when boot initialization fails', async () => {
        process.env = {
            ...originalEnv,
            NODE_ENV: 'test',
        };

        jest.doMock('./session-store', () => ({
            sessionStore: {
                initialize: jest.fn(async () => {
                    throw new Error('boom');
                }),
                isPersistent: jest.fn(() => false),
                healthCheck: jest.fn(async () => true),
            },
        }));

        const { app, start, startupState } = require('./server');
        await start({ listen: false });

        const response = await request(app).get('/ready');

        expect(response.status).toBe(503);
        expect(response.body).toEqual(expect.objectContaining({
            status: 'degraded',
            error: 'boom',
        }));
        expect(startupState.ready).toBe(false);
        expect(startupState.status).toBe('degraded');
    });

    test('keeps frontend HTML uncached while caching versioned assets immutably', () => {
        process.env = {
            ...originalEnv,
            NODE_ENV: 'test',
            OPENAI_API_KEY: originalEnv.OPENAI_API_KEY || 'test-key',
        };

        const { buildFrontendStaticOptions } = require('./server');
        const options = buildFrontendStaticOptions();
        const htmlResponse = {
            req: { originalUrl: '/web-chat/app.html' },
            setHeader: jest.fn(),
        };
        const versionedAssetResponse = {
            req: { originalUrl: '/web-chat/js/app.js?v=20260531a' },
            setHeader: jest.fn(),
        };

        options.setHeaders(htmlResponse, 'C:\\app\\frontend\\web-chat\\app.html');
        options.setHeaders(versionedAssetResponse, 'C:\\app\\frontend\\web-chat\\js\\app.js');

        expect(htmlResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
        expect(versionedAssetResponse.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            'public, max-age=31536000, immutable',
        );
    });

    test('gives unversioned frontend assets a short browser cache', () => {
        process.env = {
            ...originalEnv,
            NODE_ENV: 'test',
            OPENAI_API_KEY: originalEnv.OPENAI_API_KEY || 'test-key',
        };

        const { buildFrontendStaticOptions } = require('./server');
        const response = {
            req: { originalUrl: '/notes/js/app.js' },
            setHeader: jest.fn(),
        };

        buildFrontendStaticOptions().setHeaders(response, 'C:\\app\\frontend\\notes-notion\\js\\app.js');

        expect(response.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            'public, max-age=300, stale-while-revalidate=86400',
        );
    });

    test('splits frontend entry HTML after the fast shell marker', () => {
        process.env = {
            ...originalEnv,
            NODE_ENV: 'test',
            OPENAI_API_KEY: originalEnv.OPENAI_API_KEY || 'test-key',
        };

        const { splitFrontendHtmlForEarlyShell } = require('./server');
        const [shell, rest] = splitFrontendHtmlForEarlyShell('<body>shell<!-- kb-fast-shell-end --><main>app</main>');

        expect(shell).toBe('<body>shell<!-- kb-fast-shell-end -->');
        expect(rest).toBe('<main>app</main>');
    });

    test('serves active frontend entry HTML as a tiny bootstrap shell', async () => {
        process.env = {
            ...originalEnv,
            KIMIBUILT_AUTH_REQUIRED: 'false',
            NODE_ENV: 'test',
            OPENAI_API_KEY: originalEnv.OPENAI_API_KEY || 'test-key',
        };

        const { app } = require('./server');
        const response = await request(app).get('/web-chat/');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.text).toContain('loadFullFrontend');
        expect(response.text).toContain('KimiBuiltFrontendLoadMetrics');
        expect(response.text).toContain('kimibuilt-critical-shell-ready');
        expect(response.text).toContain('/web-chat/app.html?__kb_full=1');
        expect(response.text).toContain('/shared/frontend-entry-loader.js?v=20260621a');
        expect(response.text).toContain('Lilly Workspace');
        expect(response.text.length).toBeLessThan(2500);
    });

    test('keeps the six-interface chooser at the product root', async () => {
        process.env = {
            ...originalEnv,
            KIMIBUILT_AUTH_REQUIRED: 'false',
            NODE_ENV: 'test',
            OPENAI_API_KEY: originalEnv.OPENAI_API_KEY || 'test-key',
        };

        const { app } = require('./server');
        const response = await request(app).get('/');

        expect(response.status).toBe(200);
        expect(response.text).toContain('name="viewport"');
        expect(response.text).toContain('Choose your interface:');
        expect(response.text).toContain('Web Chat');
        expect(response.text).toContain('Web CLI');
        expect(response.text).toContain('Notes');
        expect(response.text).toContain('Canvas');
        expect(response.text).toContain('Podcast Wave');
        expect(response.text).toContain('Admin Dashboard');
        expect(response.text).not.toContain('What should Lilly accomplish?');
    });

    test('serves full frontend entry HTML through the bootstrap full query', async () => {
        process.env = {
            ...originalEnv,
            KIMIBUILT_AUTH_REQUIRED: 'false',
            NODE_ENV: 'test',
            OPENAI_API_KEY: originalEnv.OPENAI_API_KEY || 'test-key',
        };

        const { app } = require('./server');
        const response = await request(app).get('/notes/index.html?__kb_full=1');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.text).toContain('kb-fast-shell-end');
        expect(response.text).toContain('LillyBuilt');
    });
});

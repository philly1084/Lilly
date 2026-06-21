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
});

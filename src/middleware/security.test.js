'use strict';

const express = require('express');
const cors = require('cors');
const request = require('supertest');

const { buildCorsOptions, createRateLimit } = require('./security');

describe('security middleware', () => {
    test('identifies the throttling layer and provides a retry window and correlation ID', async () => {
        const app = express();
        app.use(createRateLimit({ max: 1, windowMs: 60000, name: 'api' }));
        app.get('/ok', (_req, res) => res.json({ ok: true }));
        await request(app).get('/ok').expect(200);
        const response = await request(app).get('/ok').expect(429);
        expect(response.body.error).toMatchObject({ code: 'rate_limited', scope: 'api', requestId: response.headers['x-request-id'], retryAfterSeconds: Number(response.headers['retry-after']) });
        expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
        expect(response.body.error.retryAfterSeconds).toBeGreaterThan(0);
    });
    test('allows configured CORS origins and same-origin requests', async () => {
        const app = express();
        app.use(cors(buildCorsOptions({
            allowedOrigins: ['https://kimibuilt.example'],
        })));
        app.get('/ok', (_req, res) => res.json({ ok: true }));

        const allowed = await request(app)
            .get('/ok')
            .set('Origin', 'https://kimibuilt.example')
            .expect(200);
        expect(allowed.headers['access-control-allow-origin']).toBe('https://kimibuilt.example');

        await request(app)
            .get('/ok')
            .expect(200);
    });

    test('rejects unlisted CORS origins', async () => {
        const app = express();
        app.use(cors(buildCorsOptions({
            allowedOrigins: ['https://kimibuilt.example'],
        })));
        app.get('/ok', (_req, res) => res.json({ ok: true }));
        app.use((err, _req, res, _next) => {
            res.status(err.statusCode || 500).json({ code: err.code });
        });

        const response = await request(app)
            .get('/ok')
            .set('Origin', 'https://evil.example')
            .expect(403);

        expect(response.body.code).toBe('cors_origin_denied');
    });

    test('normalizes configured origins before matching browser Origin headers', async () => {
        const app = express();
        app.use(cors(buildCorsOptions({
            allowedOrigins: ['https://KIMIBUILT.example:443/'],
        })));
        app.get('/ok', (_req, res) => res.json({ ok: true }));

        const response = await request(app)
            .get('/ok')
            .set('Origin', 'https://kimibuilt.example')
            .expect(200);

        expect(response.headers['access-control-allow-origin']).toBe('https://kimibuilt.example');
    });

    test('allows same-origin browser requests even when the configured allowlist is stale', async () => {
        const app = express();
        app.use((req, res, next) => cors(buildCorsOptions({
            allowedOrigins: ['https://old.example'],
        }, req))(req, res, next));
        app.post('/api/auth/login', (_req, res) => res.json({ ok: true }));

        const response = await request(app)
            .post('/api/auth/login')
            .set('Host', 'kimibuilt.secdevsolutions.help')
            .set('X-Forwarded-Proto', 'https')
            .set('Origin', 'https://kimibuilt.secdevsolutions.help')
            .send({ username: 'admin', password: 'secret' })
            .expect(200);

        expect(response.headers['access-control-allow-origin']).toBe('https://kimibuilt.secdevsolutions.help');
    });

    test('allows opaque-origin reads only for isolated sandbox preview assets', async () => {
        const app = express();
        app.use((req, res, next) => cors(buildCorsOptions({ allowedOrigins: [] }, req))(req, res, next));
        app.get('/api/sandbox-workspaces/game-r1/preview/player.js', (_req, res) => res.type('js').send('export {};'));
        app.get('/api/sandbox-libraries/three/three.module.js', (_req, res) => res.type('js').send('export {};'));
        app.post('/api/chat', (_req, res) => res.json({ ok: true }));
        app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ code: err.code }));

        const preview = await request(app)
            .get('/api/sandbox-workspaces/game-r1/preview/player.js')
            .set('Origin', 'null')
            .expect(200);
        expect(preview.headers['access-control-allow-origin']).toBe('null');

        const library = await request(app)
            .get('/api/sandbox-libraries/three/three.module.js')
            .set('Origin', 'null')
            .expect(200);
        expect(library.headers['access-control-allow-origin']).toBe('null');

        const api = await request(app)
            .post('/api/chat')
            .set('Origin', 'null')
            .expect(403);
        expect(api.body.code).toBe('cors_origin_denied');
    });

    test('rate limits repeated login attempts', async () => {
        const app = express();
        app.post('/api/auth/login', createRateLimit({
            name: 'login-test',
            max: 1,
            windowMs: 60000,
        }), (_req, res) => res.json({ ok: true }));

        await request(app).post('/api/auth/login').expect(200);
        const response = await request(app).post('/api/auth/login').expect(429);
        expect(response.body.error.code).toBe('rate_limited');
    });

    test('rate limits tool invocation paths independently', async () => {
        const app = express();
        app.post('/api/tools/invoke/:id?', createRateLimit({
            name: 'tool-test',
            max: 1,
            windowMs: 60000,
        }), (_req, res) => res.json({ ok: true }));

        await request(app).post('/api/tools/invoke/web-fetch').expect(200);
        const response = await request(app).post('/api/tools/invoke/web-fetch').expect(429);
        expect(response.body.error.code).toBe('rate_limited');
    });
});

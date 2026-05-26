'use strict';

const express = require('express');
const request = require('supertest');

const { config } = require('../config');
const authRouter = require('./auth');

describe('/api/auth routes', () => {
    const originalAuth = { ...config.auth };

    beforeEach(() => {
        config.auth.username = 'admin';
        config.auth.password = 'secret';
        config.auth.jwtSecret = 'jwt-secret';
        config.auth.cookieName = 'kimibuilt_auth';
        config.auth.tokenTtlSeconds = 3600;
    });

    afterEach(() => {
        Object.assign(config.auth, originalAuth);
    });

    function buildApp() {
        const app = express();
        app.use(express.json());
        app.use('/api/auth', authRouter);
        return app;
    }

    test('issues a WebSocket token after cookie login', async () => {
        const app = buildApp();
        const login = await request(app)
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'secret' })
            .expect(200);

        const cookie = login.headers['set-cookie'];
        const response = await request(app)
            .get('/api/auth/ws-token')
            .set('Cookie', cookie)
            .expect(200);

        expect(response.body).toEqual(expect.objectContaining({
            authRequired: true,
            token: expect.any(String),
            expiresAt: expect.any(Number),
        }));
    });

    test('rejects unauthenticated WebSocket token requests with JSON', async () => {
        const app = buildApp();
        const response = await request(app)
            .get('/api/auth/ws-token')
            .expect(401);

        expect(response.type).toBe('application/json');
        expect(response.body).toEqual({
            error: {
                message: 'Authentication required',
                code: 'missing_token',
            },
        });
    });

    test('marks auth responses as non-cacheable', async () => {
        const app = buildApp();
        const response = await request(app)
            .get('/api/auth/session')
            .expect(200);

        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers.pragma).toBe('no-cache');
    });
});

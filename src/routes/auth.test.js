'use strict';

const express = require('express');
const request = require('supertest');

const mockSettings = new Map();
jest.mock('../postgres', () => ({
    postgres: {
        query: jest.fn(async (sql, params) => {
            if (/^\s*SELECT/i.test(sql)) {
                return { rows: mockSettings.has(params[0]) ? [{ value: mockSettings.get(params[0]) }] : [] };
            }
            if (/^\s*INSERT/i.test(sql)) {
                mockSettings.set(params[0], JSON.parse(params[1]));
                return { rows: [] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }),
    },
}));

const { config } = require('../config');
const authRouter = require('./auth');
const { generateTotp } = require('../auth/service');

describe('/api/auth routes', () => {
    const originalAuth = { ...config.auth };

    beforeEach(() => {
        config.auth.username = 'admin';
        config.auth.password = 'secret';
        config.auth.jwtSecret = 'jwt-secret';
        config.auth.cookieName = 'kimibuilt_auth';
        config.auth.tokenTtlSeconds = 3600;
        config.auth.totpEnabled = false;
        config.auth.totpIssuer = 'KimiBuilt Test';
        mockSettings.clear();
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

    test('enrolls and requires a valid authenticator code before issuing a session', async () => {
        config.auth.totpEnabled = true;
        const app = buildApp();
        const login = await request(app)
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'secret', returnTo: '/notes/' })
            .expect(200);

        expect(login.headers['set-cookie']).toBeUndefined();
        expect(login.body).toEqual(expect.objectContaining({
            mfaRequired: true,
            enrollmentRequired: true,
            challengeId: expect.any(String),
            qrCodeDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
            manualKey: expect.any(String),
        }));

        const verified = await request(app)
            .post('/api/auth/mfa/verify')
            .send({
                challengeId: login.body.challengeId,
                code: generateTotp(login.body.manualKey),
                returnTo: '/notes/',
            })
            .expect(200);

        expect(verified.headers['set-cookie']).toBeDefined();
        expect(verified.body.returnTo).toBe('/notes/');
        expect(mockSettings.get('auth.mfa.admin').enrolled).toBe(true);
    });
});

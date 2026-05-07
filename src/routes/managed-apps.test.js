'use strict';

const express = require('express');
const request = require('supertest');

const managedAppsRouter = require('./managed-apps');

describe('/api managed app routes', () => {
    function buildApp(service) {
        const app = express();
        app.use(express.json());
        app.locals.managedAppService = service;
        app.use('/api', managedAppsRouter);
        app.use((err, _req, res, _next) => {
            res.status(err.statusCode || 500).json({
                error: { message: err.message },
            });
        });
        return app;
    }

    test('lists managed apps', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            listApps: jest.fn(async () => ([{ id: 'app-1', slug: 'arcade-demo' }])),
        };
        const app = buildApp(service);

        const response = await request(app).get('/api/managed-apps');

        expect(response.status).toBe(200);
        expect(service.listApps).toHaveBeenCalledWith(null, 50);
        expect(response.body.count).toBe(1);
    });

    test('creates a managed app', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            createApp: jest.fn(async () => ({
                app: { id: 'app-1', slug: 'arcade-demo' },
                message: 'Queued build.',
            })),
        };
        const app = buildApp(service);

        const response = await request(app)
            .post('/api/managed-apps')
            .send({
                action: 'create',
                appName: 'Arcade Demo',
            });

        expect(response.status).toBe(201);
        expect(service.createApp).toHaveBeenCalledWith(expect.objectContaining({
            appName: 'Arcade Demo',
        }), null, expect.objectContaining({
            sessionId: null,
        }));
        expect(response.body.app.slug).toBe('arcade-demo');
    });

    test('deploys a managed app', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            deployApp: jest.fn(async () => ({
                app: { id: 'app-1', slug: 'arcade-demo' },
                deployment: { namespace: 'app-arcade-demo' },
            })),
        };
        const app = buildApp(service);

        const response = await request(app)
            .post('/api/managed-apps/arcade-demo/deploy')
            .send({
                imageTag: 'sha-abcdef123456',
            });

        expect(response.status).toBe(202);
        expect(service.deployApp).toHaveBeenCalledWith(
            'arcade-demo',
            expect.objectContaining({ imageTag: 'sha-abcdef123456' }),
            null,
            expect.objectContaining({ sessionId: null }),
        );
    });

    test('starts a managed app iteration', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            iterateApp: jest.fn(async () => ({
                app: { id: 'app-1', slug: 'arcade-demo' },
                iteration: {
                    action: 'edit',
                    stages: [
                        { id: 'understand', title: 'Understand request', status: 'completed' },
                    ],
                    evidence: {
                        commitSha: 'abcdef1234567890',
                    },
                },
            })),
        };
        const app = buildApp(service);

        const response = await request(app)
            .post('/api/managed-apps/arcade-demo/iterations')
            .send({
                action: 'edit',
                prompt: 'Make the hero clearer.',
                sessionId: 'session-1',
            });

        expect(response.status).toBe(202);
        expect(service.iterateApp).toHaveBeenCalledWith(
            'arcade-demo',
            expect.objectContaining({
                action: 'edit',
                prompt: 'Make the hero clearer.',
            }),
            null,
            expect.objectContaining({ sessionId: 'session-1' }),
        );
        expect(response.body.iteration.evidence.commitSha).toBe('abcdef1234567890');
    });

    test('returns canonical managed app progress', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            getAppProgress: jest.fn(async () => ({
                app: { id: 'app-1', slug: 'arcade-demo' },
                latestBuildRun: { id: 'build-1' },
                project: {
                    key: 'managed-app:app-1',
                    summary: 'Arcade Demo is deploying.',
                    progress: {
                        phase: 'deploying',
                        phaseLabel: 'Deploying',
                    },
                },
                progress: {
                    phase: 'deploying',
                    phaseLabel: 'Deploying',
                },
                summary: 'Arcade Demo is deploying.',
            })),
        };
        const app = buildApp(service);

        const response = await request(app).get('/api/managed-apps/arcade-demo/progress');

        expect(response.status).toBe(200);
        expect(service.getAppProgress).toHaveBeenCalledWith('arcade-demo', null);
        expect(response.body.progress).toEqual(expect.objectContaining({
            phase: 'deploying',
            phaseLabel: 'Deploying',
        }));
        expect(response.body.project).toEqual(expect.objectContaining({
            key: 'managed-app:app-1',
        }));
    });
});

'use strict';

const express = require('express');
const request = require('supertest');
const asyncLabRouter = require('./async-lab');
const asyncLabWebhooksRouter = require('./async-lab-webhooks');
const { AsyncLabService } = require('../async-lab/service');
const { AsyncLabStore } = require('../async-lab/store');
const { ValkeyLiveBus } = require('../async-lab/valkey-live-bus');

function createService(overrides = {}) {
    return new AsyncLabService({
        config: {
            enabled: true,
            mode: 'lab',
            namespace: 'kimibuilt-async-lab',
            surface: 'async-lab',
            workerEnabled: false,
            simulationDelayMs: 0,
            lockRetryMs: 5,
            maxLockWaitMs: 40,
            leaseTtlMs: 1000,
            allowLiveRemote: false,
            webhookSecret: 'lab-secret',
            persistToPostgres: false,
            ...overrides,
        },
        store: new AsyncLabStore({ persistToPostgres: false }),
        bus: new ValkeyLiveBus({}),
        instanceId: 'route-test-async-lab',
    });
}

function buildApp(service) {
    const app = express();
    app.use(express.json());
    app.locals.asyncLabService = service;
    app.use((req, _res, next) => {
        req.user = { username: 'tester' };
        next();
    });
    app.use('/api/async-lab', asyncLabRouter);
    app.use((err, _req, res, _next) => {
        res.status(err.statusCode || 500).json({
            error: {
                message: err.message,
            },
        });
    });
    return app;
}

function buildWebhookApp(service) {
    const app = express();
    app.use(express.json());
    app.locals.asyncLabService = service;
    app.use('/api/async-lab/webhooks', asyncLabWebhooksRouter);
    app.use((err, _req, res, _next) => {
        res.status(err.statusCode || 500).json({
            error: {
                message: err.message,
            },
        });
    });
    return app;
}

describe('/api/async-lab routes', () => {
    test('hides the lab API when the feature flag is disabled', async () => {
        const app = buildApp(createService({ enabled: false }));

        const response = await request(app)
            .post('/api/async-lab/runs')
            .send({ task: 'hidden' });

        expect(response.status).toBe(404);
        expect(response.body.error.message).toMatch(/disabled/i);
    });

    test('creates a run and returns replayable events as JSON', async () => {
        const service = createService();
        const app = buildApp(service);

        const created = await request(app)
            .post('/api/async-lab/runs')
            .set('x-idempotency-key', 'route-command')
            .send({
                task: 'route run',
                adapter: 'remote-command',
                targetKey: 'host/one',
            });

        expect(created.status).toBe(202);
        expect(created.body.run.runtimeSurface).toBe('async-lab');
        expect(created.body.run.metadata.dryRun).toBe(true);

        await service.drainQueue();
        const events = await request(app)
            .get(`/api/async-lab/runs/${created.body.run.id}/events?after=1`);

        expect(events.status).toBe(200);
        expect(events.body.events[0].cursor).toBeGreaterThan(1);
        expect(events.body.events.map((event) => event.type)).toContain('safety');

        const listed = await request(app)
            .get('/api/async-lab/runs?limit=10');

        expect(listed.status).toBe(200);
        expect(listed.body.runs.map((run) => run.id)).toContain(created.body.run.id);
    });

    test('cancels an owned run', async () => {
        const service = createService();
        const app = buildApp(service);
        const created = await request(app)
            .post('/api/async-lab/runs')
            .send({ task: 'cancel route', adapter: 'dry-run' });

        const cancelled = await request(app)
            .post(`/api/async-lab/runs/${created.body.run.id}/cancel`)
            .send({});

        expect(cancelled.status).toBe(200);
        expect(cancelled.body.run.status).toBe('cancelled');
    });
});

describe('/api/async-lab/webhooks routes', () => {
    test('rejects build events with the wrong lab secret', async () => {
        const app = buildWebhookApp(createService());

        const response = await request(app)
            .post('/api/async-lab/webhooks/build-events')
            .set('x-kimibuilt-async-lab-secret', 'wrong')
            .send({ build_status: 'success' });

        expect(response.status).toBe(401);
    });

    test('accepts copied build events on the lab-only webhook', async () => {
        const service = createService();
        const app = buildWebhookApp(service);

        const response = await request(app)
            .post('/api/async-lab/webhooks/build-events')
            .set('x-kimibuilt-async-lab-secret', 'lab-secret')
            .send({
                project: { path_with_namespace: 'agent-apps/demo' },
                object_attributes: {
                    id: 42,
                    status: 'success',
                    sha: 'abc123',
                },
            });

        expect(response.status).toBe(202);
        expect(response.body.data.run.adapter).toBe('build-webhook-copy');
        expect(response.body.data.run.runtimeSurface).toBe('async-lab');
        expect(response.body.data.run.metadata.dryRun).toBe(true);
    });
});

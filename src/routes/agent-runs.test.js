'use strict';

const express = require('express');
const request = require('supertest');
const agentRunsRouter = require('./agent-runs');
const { AsyncLabStore } = require('../async-lab/store');
const { AgentRunService } = require('../agent-runs');

function createService() {
  return new AgentRunService({
    store: new AsyncLabStore({ persistToPostgres: false }),
  });
}

function buildApp(service, username = 'tester') {
  const app = express();
  app.use(express.json());
  app.locals.agentRunService = service;
  app.use((req, _res, next) => {
    req.user = username ? { username } : null;
    next();
  });
  app.use('/api/agent-runs', agentRunsRouter);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || error.status || 500).json({
      error: {
        type: error.code || 'internal_error',
        message: error.message,
      },
    });
  });
  return app;
}

describe('/api/agent-runs routes', () => {
  test('creates and reads a canonical run with header idempotency', async () => {
    const service = createService();
    const app = buildApp(service);
    const body = {
      objective: 'Build a launch demo',
      sessionId: 'session-route',
      surface: 'launchpad',
      mode: 'agent',
    };

    const created = await request(app)
      .post('/api/agent-runs')
      .set('x-idempotency-key', 'launch-demo-route')
      .send(body);
    const duplicate = await request(app)
      .post('/api/agent-runs')
      .set('x-idempotency-key', 'launch-demo-route')
      .send(body);
    const fetched = await request(app)
      .get(`/api/agent-runs/${created.body.run.id}`);

    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({
      duplicate: false,
      run: expect.objectContaining({
        version: 'AgentRun/v1',
        objective: body.objective,
        ownerId: 'tester',
        state: 'created',
      }),
      events: [expect.objectContaining({ type: 'run.created', cursor: 1 })],
    }));
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.run.id).toBe(created.body.run.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.run.id).toBe(created.body.run.id);
  });

  test('returns reconnect-safe event pages in cursor order', async () => {
    const service = createService();
    const app = buildApp(service);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ objective: 'Replay route events' });
    const runId = created.body.run.id;

    await request(app)
      .post(`/api/agent-runs/${runId}/actions`)
      .send({ action: 'pause', idempotencyKey: 'route-pause' });
    await request(app)
      .post(`/api/agent-runs/${runId}/actions`)
      .send({ action: 'resume', idempotencyKey: 'route-resume' });
    await service.recordStep(runId, { id: 'route-step', status: 'ok' }, {
      ownerId: 'tester',
      idempotencyKey: 'route-step',
    });

    const replay = await request(app)
      .get(`/api/agent-runs/${runId}/events?after=1`);

    expect(replay.status).toBe(200);
    expect(replay.body.runId).toBe(runId);
    expect(replay.body.after).toBe(1);
    expect(replay.body.events.length).toBe(3);
    expect(replay.body.events.every((event) => event.cursor > 1)).toBe(true);
    expect(replay.body.events.map((event) => event.cursor)).toEqual([2, 3, 4]);
    expect(replay.body.eventCursor).toBe(4);
  });

  test('SSE reconnect resumes after Last-Event-ID without duplicates', async () => {
    const service = createService();
    const app = buildApp(service);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ objective: 'Reconnect an event stream' });
    const runId = created.body.run.id;

    await service.transitionRun(runId, 'planning', { ownerId: 'tester' });
    await service.transitionRun(runId, 'executing', { ownerId: 'tester' });
    await service.recordStep(runId, { id: 'step-1', status: 'ok' }, {
      ownerId: 'tester',
      idempotencyKey: 'sse-step-1',
    });

    const first = await request(app)
      .get(`/api/agent-runs/${runId}/events?after=0`)
      .set('Accept', 'text/event-stream');
    const reconnected = await request(app)
      .get(`/api/agent-runs/${runId}/events`)
      .set('Accept', 'text/event-stream')
      .set('Last-Event-ID', '2');

    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('text/event-stream');
    expect(first.text.match(/^id: \d+$/gm)).toEqual(['id: 1', 'id: 2', 'id: 3', 'id: 4']);
    expect(reconnected.text.match(/^id: \d+$/gm)).toEqual(['id: 3', 'id: 4']);
    expect(reconnected.headers['x-agent-run-event-cursor']).toBe('4');
  });

  test('persists action responses and returns the same child for an idempotent fork', async () => {
    const service = createService();
    const app = buildApp(service);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ objective: 'Fork route source', snapshot: { option: 'a' } });
    const runId = created.body.run.id;
    const forkBody = {
      action: 'fork',
      idempotencyKey: 'route-fork-b',
      objective: 'Fork route option B',
      snapshot: { option: 'b' },
    };

    const first = await request(app)
      .post(`/api/agent-runs/${runId}/actions`)
      .send(forkBody);
    const second = await request(app)
      .post(`/api/agent-runs/${runId}/actions`)
      .send(forkBody);

    expect(first.status).toBe(200);
    expect(first.body.forkedRun).toEqual(expect.objectContaining({
      parentRunId: runId,
      objective: 'Fork route option B',
      state: 'created',
    }));
    expect(second.body.duplicate).toBe(true);
    expect(second.body.forkedRun.id).toBe(first.body.forkedRun.id);
  });

  test('rejects illegal actions and hides another owner\'s run', async () => {
    const service = createService();
    const ownerApp = buildApp(service, 'owner-a');
    const intruderApp = buildApp(service, 'owner-b');
    const created = await request(ownerApp)
      .post('/api/agent-runs')
      .send({ objective: 'Private run' });

    const illegal = await request(ownerApp)
      .post(`/api/agent-runs/${created.body.run.id}/actions`)
      .send({ action: 'resume' });
    const hidden = await request(intruderApp)
      .get(`/api/agent-runs/${created.body.run.id}`);

    expect(illegal.status).toBe(409);
    expect(illegal.body.error.type).toBe('AGENT_RUN_NOT_RESUMABLE');
    expect(hidden.status).toBe(404);
  });

  test('reports the runtime as unavailable when no service is wired', async () => {
    const app = buildApp(null);
    const response = await request(app)
      .post('/api/agent-runs')
      .send({ objective: 'Unavailable' });

    expect(response.status).toBe(503);
    expect(response.body.error.type).toBe('agent_run_unavailable');
  });
});

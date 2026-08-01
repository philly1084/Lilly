'use strict';

const express = require('express');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { GameStudioService } = require('../game-studio/service');
const gameStudioRouter = require('./game-studio');

describe('Game Studio API', () => {
  let tempRoot;
  let app;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-game-studio-route-'));
    const gameStudioService = new GameStudioService({
      root: path.join(tempRoot, 'data'),
      buildRoot: path.join(tempRoot, 'sandboxes'),
      postgres: { enabled: false },
    });
    await gameStudioService.initialize();
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => { req.user = { username: 'phil' }; next(); });
    app.locals.gameStudioService = gameStudioService;
    app.use('/api/game-studio', gameStudioRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: { code: error.code, message: error.message, currentRevision: error.currentRevision } }));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('creates, reads, and edits a project through authenticated contracts', async () => {
    const created = await request(app).post('/api/game-studio/projects').send({ name: 'Route Arena' }).expect(201);
    const id = created.body.project.id;
    await request(app).get('/api/game-studio/projects').expect(200).expect((response) => expect(response.body.count).toBe(1));
    const updated = await request(app).post(`/api/game-studio/projects/${id}/commands`).send({
      baseRevision: 1,
      commands: [{ operation: 'entity.rename', target: { sceneId: 'arena', entityId: 'player' }, payload: { name: 'API Player' } }],
    }).expect(200);
    expect(updated.body.project.revision).toBe(2);
    expect(updated.body.commandBatch.schema).toBe('LillyCommandBatch/v1');
  });

  test('returns 409 for stale mutation instead of overwriting', async () => {
    const created = await request(app).post('/api/game-studio/projects').send({ name: 'Conflict' }).expect(201);
    const id = created.body.project.id;
    const payload = { baseRevision: 1, commands: [{ operation: 'entity.rename', target: { sceneId: 'arena', entityId: 'player' }, payload: { name: 'First' } }] };
    await request(app).post(`/api/game-studio/projects/${id}/commands`).send(payload).expect(200);
    const conflict = await request(app).post(`/api/game-studio/projects/${id}/commands`).send(payload).expect(409);
    expect(conflict.body.error.code).toBe('REVISION_CONFLICT');
    expect(conflict.body.error.currentRevision).toBe(2);
  });

  test('runs AI review, playtest, and build endpoints', async () => {
    const created = await request(app).post('/api/game-studio/projects').send({ name: 'Pipeline' }).expect(201);
    const id = created.body.project.id;
    await request(app).post(`/api/game-studio/projects/${id}/ai-runs`).send({ prompt: 'Make the pickups brighter' }).expect(201).expect((response) => expect(response.body.status).toBe('proposed'));
    await request(app).post(`/api/game-studio/projects/${id}/playtests`).send({}).expect(201).expect((response) => expect(response.body.status).toBe('passed'));
    await request(app).post(`/api/game-studio/projects/${id}/builds`).send({ projectRevision: 1 }).expect(201).expect((response) => expect(response.body.status).toBe('success'));
  });
});

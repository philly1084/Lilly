'use strict';

const express = require('express');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { GameStudioService } = require('../game-studio/service');
const { dashModuleFiles } = require('../game-studio/test-fixtures/agent-module');
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

  test('exposes versioned contracts and revision-safe agent source APIs', async () => {
    const contracts = await request(app).get('/api/game-studio/contracts').expect(200);
    expect(contracts.body).toMatchObject({
      schema: 'LillyGameStudioContracts/v1',
      engineVersion: '0.4.0',
      contracts: { sourceFile: 'LillySourceFile/v1', module: 'LillyGameModule/v1', mechanic: 'LillyMechanic/v1', prefab: 'LillyPrefab/v1', mechanicTest: 'LillyMechanicTest/v1' },
      sandbox: { network: 'denied', dom: 'denied' },
    });
    expect(contracts.body.runtimeTypeDeclarations).toContain("declare module '@lilly/engine-runtime'");

    const created = await request(app).post('/api/game-studio/projects').send({ name: 'External Agent Project', template: 'blank' }).expect(201);
    const id = created.body.project.id;
    expect(created.body.project.files).toEqual([]);
    const written = await request(app).put(`/api/game-studio/projects/${id}/files`).send({ baseRevision: 1, files: dashModuleFiles() }).expect(200);
    expect(written.body.project.revision).toBe(2);
    expect(written.body.moduleSummary.modules).toEqual([expect.objectContaining({ id: 'player-dash' })]);

    const tree = await request(app).get(`/api/game-studio/projects/${id}/files`).expect(200);
    expect(tree.body.files).toHaveLength(5);
    expect(tree.body.files[0]).not.toHaveProperty('content');
    const sourceFile = await request(app).get(`/api/game-studio/projects/${id}/files/content`).query({ path: 'modules/traversal/dash.system.ts' }).expect(200);
    expect(sourceFile.body.file.content).toContain('defineSystem');

    const compile = await request(app).post(`/api/game-studio/projects/${id}/compile`).send({ revision: 2 }).expect(200);
    expect(compile.body).toMatchObject({ valid: true, loadOrder: ['player-dash'] });
    const tests = await request(app).post(`/api/game-studio/projects/${id}/mechanic-tests`).send({ revision: 2 }).expect(201);
    expect(tests.body).toMatchObject({ status: 'passed', passed: 1, failed: 0 });
    const instance = await request(app).post(`/api/game-studio/projects/${id}/prefab-instances`).send({ baseRevision: 2, sceneId: 'main', path: 'modules/traversal/dash-trail.prefab.json', prefabId: 'dash-trail', instanceId: 'api-trail', parentId: 'world' }).expect(201);
    expect(instance.body.project.revision).toBe(3);
    expect(instance.body.project.scenes[0].entities).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'api-trail:trail' })]));

    const conflict = await request(app).put(`/api/game-studio/projects/${id}/files`).send({ baseRevision: 2, files: [{ path: 'data/config.json', content: '{}' }] }).expect(409);
    expect(conflict.body.error).toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 3 });
  });

  test('runs AI review, playtest, and build endpoints', async () => {
    const created = await request(app).post('/api/game-studio/projects').send({ name: 'Pipeline' }).expect(201);
    const id = created.body.project.id;
    await request(app).post(`/api/game-studio/projects/${id}/ai-runs`).send({ prompt: 'Make the pickups brighter' }).expect(201).expect((response) => expect(response.body.status).toBe('proposed'));
    await request(app).post(`/api/game-studio/projects/${id}/editor-preview`).send({ projectRevision: 1 }).expect(201).expect((response) => {
      expect(response.body).toMatchObject({ schema: 'LillyEditorPreview/v1', projectRevision: 1 });
      expect(response.body.previewUrl).toMatch(/\/preview\/$/);
    });
    await request(app).post(`/api/game-studio/projects/${id}/playtests`).send({}).expect(201).expect((response) => expect(response.body.status).toBe('passed'));
    await request(app).post(`/api/game-studio/projects/${id}/builds`).send({ projectRevision: 1 }).expect(201).expect((response) => expect(response.body.status).toBe('success'));
  });
});

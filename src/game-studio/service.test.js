'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { COMMAND_SCHEMA } = require('../../packages/lilly-engine/dist/core/src');
const { GameStudioService } = require('./service');

describe('GameStudioService', () => {
  let tempRoot;
  let service;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-game-studio-'));
    service = new GameStudioService({
      root: path.join(tempRoot, 'data'),
      buildRoot: path.join(tempRoot, 'sandboxes'),
      postgres: { enabled: false },
    });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('creates a durable versioned canary project', async () => {
    const result = await service.createProject({ name: 'Canary Arena', prompt: 'A frozen vault with seven rooms and three relics', seed: 'canary-seed' }, 'phil');
    expect(result.project.schema).toBe('LillyProject/v1');
    expect(result.project.revision).toBe(1);
    expect(result.project.engineVersion).toBe('0.3.0');
    expect(result.project.blueprints).toHaveLength(2);
    expect(result.project.levelRecipes).toEqual([expect.objectContaining({ schema: 'LillyLevelRecipe/v1', seed: 'canary-seed', theme: 'frost-vault' })]);
    expect(result.project.generatedLevels).toEqual([expect.objectContaining({ schema: 'LillyGeneratedLevel/v1', metrics: expect.objectContaining({ roomCount: 7 }) })]);
    expect(result.metadata.source).toBe('template:ai-procedural-expedition');
    expect(result.validation.valid).toBe(true);
    await expect(fs.access(service.revisionPath(result.project.id, 1))).resolves.toBeUndefined();
  });

  test('imports a compatible web bundle explicitly without silently converting it', async () => {
    const result = await service.createProject({
      name: 'Imported Three Game',
      importBundle: {
        entry: 'index.html',
        files: [
          { path: 'index.html', content: '<!doctype html><canvas id="game"></canvas><script type="module" src="./game.js"></script>' },
          { path: 'game.js', content: "import * as THREE from 'three'; console.log(THREE);" },
        ],
      },
    }, 'phil');

    expect(result.metadata.source).toBe('import:compatible-web-bundle');
    expect(result.metadata.importedBundle).toMatchObject({ status: 'archived-needs-mapping', fileCount: 2 });
    expect(result.project.settings.legacyImport).toMatchObject({ manualMappingRequired: true });
    expect(result.project.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'legacy-source-bundle' })]));
    await expect(fs.readFile(path.join(service.projectDirectory(result.project.id), 'imports', 'original', 'game.js'), 'utf8')).resolves.toContain('THREE');
  });

  test('applies audited commands and refuses a stale batch', async () => {
    const created = await service.createProject({ name: 'Commands' }, 'phil');
    const projectId = created.project.id;
    const command = {
      schema: COMMAND_SCHEMA,
      commandId: 'rename-player',
      projectId,
      baseRevision: 1,
      operation: 'entity.rename',
      target: { sceneId: 'arena', entityId: 'player' },
      payload: { name: 'Runner' },
    };
    const updated = await service.applyCommands(projectId, { baseRevision: 1, commands: [command] }, 'phil');
    expect(updated.project.revision).toBe(2);
    expect(updated.project.scenes[0].entities.find((entity) => entity.id === 'player').name).toBe('Runner');
    await expect(service.applyCommands(projectId, { baseRevision: 1, commands: [command] }, 'phil')).rejects.toMatchObject({ code: 'REVISION_CONFLICT', statusCode: 409 });
  });

  test('proposes validated AI commands without mutating the saved revision', async () => {
    const created = await service.createProject({ name: 'AI Review' }, 'phil');
    const run = await service.createAiRun(created.project.id, { prompt: 'Make the shards glow and add a violet rim light' }, 'phil');
    expect(run.schema).toBe('LillyAiRun/v1');
    expect(run.commands.length).toBeGreaterThan(1);
    expect(run.preview.validation.projectIssues).toEqual([]);
    const reloaded = await service.getProject(created.project.id, 'phil');
    expect(reloaded.project.revision).toBe(1);
  });

  test('proposes and atomically applies a seeded AI level without mutating during review', async () => {
    const created = await service.createProject({ name: 'Level Director', seed: 'original-seed' }, 'phil');
    const originalChecksum = created.project.generatedLevels[0].checksum;
    const run = await service.createAiRun(created.project.id, {
      mode: 'level',
      prompt: 'A hard ember foundry with 9 rooms, 5 cores, and 7 traps',
      seed: 'reviewed-level-seed',
    }, 'phil');

    expect(run.mode).toBe('level');
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]).toMatchObject({ operation: 'level.generate', target: { sceneId: 'arena' } });
    expect(run.preview.level).toMatchObject({ theme: 'ember-foundry', seed: 'reviewed-level-seed', difficulty: 4, metrics: { roomCount: 9, pickupCount: 5, hazardCount: 7 } });
    expect(run.preview.level.checksum).not.toBe(originalChecksum);
    expect((await service.getProject(created.project.id, 'phil')).project.revision).toBe(1);

    const applied = await service.applyCommands(created.project.id, { baseRevision: 1, source: 'ai', aiRunId: run.id, commands: run.commands }, 'phil');
    expect(applied.project.revision).toBe(2);
    expect(applied.project.generatedLevels[0].checksum).toBe(run.preview.level.checksum);
    expect(applied.commandBatch.inverses[0].operation).toBe('level.restore');
  });

  test('falls back to the deterministic architect when a model returns a malformed recipe', async () => {
    service.complete = jest.fn(async () => JSON.stringify({ recipe: { schema: 'Wrong/v1', layout: { roomCount: 999 } } }));
    const created = await service.createProject({ name: 'Safe AI Fallback' }, 'phil');
    const run = await service.createAiRun(created.project.id, {
      mode: 'level',
      prompt: 'A calm frost vault with 6 rooms and 3 cores',
      seed: 'fallback-seed',
    }, 'phil');

    expect(service.complete).toHaveBeenCalledTimes(1);
    expect(run.commands).toHaveLength(1);
    expect(run.preview.validation.projectIssues).toEqual([]);
    expect(run.preview.level).toMatchObject({ theme: 'frost-vault', seed: 'fallback-seed', metrics: { roomCount: 6, pickupCount: 3 } });
  });

  test('playtests and creates an immutable runnable build', async () => {
    const created = await service.createProject({ name: 'Build Arena' }, 'phil');
    const playtest = await service.runPlaytest(created.project.id, { fixedSteps: 180 }, 'phil');
    expect(playtest.status).toBe('passed');
    expect(playtest.tests.every((test) => test.status === 'passed')).toBe(true);
    const uploaded = await service.saveAsset(created.project.id, {
      filename: 'canary.glb',
      name: 'Canary GLB',
      mimeType: 'model/gltf-binary',
      contentBase64: Buffer.from('glTF-canary').toString('base64'),
    }, 'phil');
    const build = await service.createBuild(created.project.id, { projectRevision: uploaded.project.revision }, 'phil');
    expect(build.schema).toBe('LillyBuild/v1');
    expect(build.status).toBe('success');
    expect(build.previewUrl).toContain('/api/sandbox-workspaces/');
    expect(build.files.map((file) => file.path)).toEqual(expect.arrayContaining(['index.html', 'player.js', 'gameplay.js', 'vendor/three.module.js', 'vendor/three.core.js', 'vendor/addons/loaders/GLTFLoader.js', uploaded.asset.uri, 'project.json', 'blueprints.json']));
    const playerSource = await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'player.js'), 'utf8');
    expect(playerSource).toContain("from './vendor/three.module.js'");
    expect(playerSource).toContain("from './gameplay.js'");
    expect(playerSource).toContain("from 'three/addons/loaders/GLTFLoader.js'");
    expect(playerSource).toContain('let fixedStep = 1 / 60');
    expect(playerSource).toContain('__LILLY_GAME__');
    const playerHtml = await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'index.html'), 'utf8');
    expect(playerHtml).toContain('class="touch-controls"');
    expect(playerHtml).toContain('id="level-name"');
    const manifest = JSON.parse(await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'build-manifest.json'), 'utf8'));
    expect(manifest.levelChecksum).toBe(uploaded.project.generatedLevels[0].checksum);
    await expect(fs.readFile(path.join(service.buildRoot, build.workspaceId, uploaded.asset.uri), 'utf8')).resolves.toBe('glTF-canary');
    expect(playtest.tests.map((test) => test.name)).toEqual(expect.arrayContaining(['Procedural level topology', 'Deterministic level replay', 'Combat encounter grammar', 'Deterministic combat, gates, checkpoint, and save replay', 'Phone creation and touch input contract']));
    const threeModuleStat = await fs.stat(path.join(service.buildRoot, build.workspaceId, 'vendor', 'three.module.js'));
    expect(threeModuleStat.size).toBeGreaterThan(500000);
    const threeCoreStat = await fs.stat(path.join(service.buildRoot, build.workspaceId, 'vendor', 'three.core.js'));
    expect(threeCoreStat.size).toBeGreaterThan(1000000);
    await expect(fs.writeFile(path.join(service.buildRoot, build.workspaceId, 'index.html'), 'overwrite', { flag: 'wx' })).rejects.toMatchObject({ code: 'EEXIST' });
  });

  test('publishes immutable player files under the managed-app public root', async () => {
    const created = await service.createProject({ name: 'Published Arena', slug: 'published-arena' }, 'phil');
    const build = await service.createBuild(created.project.id, { projectRevision: 1 }, 'phil');
    const createApp = jest.fn(async () => ({
      app: { id: 'managed-app-1', slug: 'published-arena', status: 'building' },
      buildRun: { id: 'build-run-1' },
    }));
    const managedAppService = { isAvailable: () => true, createApp };

    const published = await service.publishBuild(build.id, {
      publicHost: 'published-arena.demoserver2.buzz',
    }, 'phil', managedAppService);

    const input = createApp.mock.calls[0][0];
    expect(input.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'public/index.html',
      'public/player.js',
      'public/vendor/three.module.js',
      'public/vendor/three.core.js',
      'public/project.json',
      'public/blueprints.json',
      'public/build-manifest.json',
    ]));
    expect(input.files).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'index.html' })]));
    expect(input.files.find((file) => file.path === 'public/index.html').content).toContain('id="game-canvas"');
    expect(published).toMatchObject({
      build: { status: 'published', publicUrl: 'https://published-arena.demoserver2.buzz' },
      previewPreservedUntilHttpsVerified: true,
    });
  });

  test('rolls an earlier snapshot forward as a new revision', async () => {
    const created = await service.createProject({ name: 'Rollback' }, 'phil');
    await service.applyCommands(created.project.id, {
      baseRevision: 1,
      commands: [{ operation: 'entity.rename', target: { sceneId: 'arena', entityId: 'player' }, payload: { name: 'Changed' } }],
    }, 'phil');
    const rolledBack = await service.rollback(created.project.id, { revision: 1 }, 'phil');
    expect(rolledBack.project.revision).toBe(3);
    expect(rolledBack.project.scenes[0].entities.find((entity) => entity.id === 'player').name).toBe('Player');
  });
});

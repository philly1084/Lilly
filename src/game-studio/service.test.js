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
    const result = await service.createProject({ name: 'Canary Arena' }, 'phil');
    expect(result.project.schema).toBe('LillyProject/v1');
    expect(result.project.revision).toBe(1);
    expect(result.project.blueprints).toHaveLength(2);
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

  test('playtests and creates an immutable runnable build', async () => {
    const created = await service.createProject({ name: 'Build Arena' }, 'phil');
    const playtest = await service.runPlaytest(created.project.id, { fixedSteps: 180 }, 'phil');
    expect(playtest.status).toBe('passed');
    expect(playtest.tests.every((test) => test.status === 'passed')).toBe(true);
    const build = await service.createBuild(created.project.id, { projectRevision: 1 }, 'phil');
    expect(build.schema).toBe('LillyBuild/v1');
    expect(build.status).toBe('success');
    expect(build.previewUrl).toContain('/api/sandbox-workspaces/');
    expect(build.files.map((file) => file.path)).toEqual(expect.arrayContaining(['index.html', 'player.js', 'project.json', 'blueprints.json']));
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

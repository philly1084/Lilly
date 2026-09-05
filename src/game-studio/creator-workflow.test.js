'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { GameStudioService } = require('./service');

const recipe = { schema: 'LillyModelRecipe/v1', name: 'Test ship', parts: [
  { name: 'Hull', shape: 'cone', rotation: [90, 0, 0], color: '#d14455' },
  { name: 'Cockpit', shape: 'sphere', position: [0, 0.3, 0], scale: [0.4, 0.3, 0.5], color: '#2277cc' },
] };
let root;
let service;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-creator-'));
  service = new GameStudioService({ root: path.join(root, 'data'), buildRoot: path.join(root, 'builds'), postgres: { enabled: false }, complete: jest.fn().mockResolvedValue(JSON.stringify(recipe)) });
  await service.initialize();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('selected model -> proposal -> real GLB read-back -> scene -> tested immutable build', async () => {
  const created = await service.createProject({ name: 'Creator proof', template: 'third-person-explorer' }, 'owner');
  const id = created.project.id;
  const run = await service.createAiRun(id, { mode: 'asset', model: 'connected-astra', baseRevision: 1, prompt: 'A red ship' }, 'owner');
  expect(service.complete).toHaveBeenCalledWith(expect.stringContaining('A red ship'), { model: 'connected-astra', reasoningEffort: 'high' });
  expect((await service.getProject(id, 'owner')).project.assets).toHaveLength(0);
  expect(await service.readModelPreview(id, run.id, 'someone-else')).toBeNull();
  const preview = await service.readModelPreview(id, run.id, 'owner');
  const applied = await service.applyAiRun(id, run.id, 'owner');
  expect(applied.project.revision).toBe(2);
  expect(applied.validation.valid).toBe(true);
  const asset = applied.project.assets[0];
  const bytes = await service.readAssetContent(id, asset.id, 'owner');
  expect(bytes.content.equals(preview.buffer)).toBe(true);
  expect(applied.project.files.some((file) => file.path === asset.metadata.sourcePath && JSON.parse(file.content).name === 'Test ship')).toBe(true);
  expect(applied.project.scenes[0].entities.some((entity) => entity.components.some((component) => component.type === 'MeshRenderer' && component.data.assetId === asset.id))).toBe(true);
  expect((await service.applyAiRun(id, run.id, 'owner')).project.revision).toBe(2);
  const playtest = await service.runPlaytest(id, {}, 'owner');
  expect(playtest.status).toBe('passed');
  const build = await service.createBuild(id, { projectRevision: 2 }, 'owner');
  expect(build.status).toBe('success');
  expect(build.files.some((file) => file.path.endsWith(asset.uri))).toBe(true);
});

test('never overwrites concurrent edits or invents a fallback asset', async () => {
  const created = await service.createProject({ name: 'Conflict', template: 'blank' }, 'owner');
  const id = created.project.id;
  const run = await service.createAiRun(id, { mode: 'asset', prompt: 'A ship' }, 'owner');
  await service.applyCommands(id, { baseRevision: 1, commands: [{ operation: 'scene.rename', target: { sceneId: created.project.entryScene }, payload: { name: 'My edit' } }] }, 'owner');
  await expect(service.applyAiRun(id, run.id, 'owner')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await service.getProject(id, 'owner')).project.assets).toHaveLength(0);
  service.complete.mockRejectedValue(new Error('offline'));
  await expect(service.createAiRun(id, { mode: 'asset', prompt: 'A ship' }, 'owner')).rejects.toMatchObject({ code: 'AI_GENERATION_FAILED' });
  await expect(service.createAiRun(id, { mode: 'level', requireAi: true, prompt: 'A dungeon' }, 'owner')).rejects.toMatchObject({ code: 'AI_GENERATION_FAILED' });
});

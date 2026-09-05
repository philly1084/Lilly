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

test('refines an existing asset from saved source, updates instances, and undoes without losing either GLB or recipe', async () => {
  const created = await service.createProject({ name: 'Refinement', template: 'third-person-explorer' }, 'owner');
  const id = created.project.id;
  const firstRun = await service.createAiRun(id, { mode: 'asset', recipe }, 'owner');
  const first = await service.applyAiRun(id, firstRun.id, 'owner');
  const originalAsset = first.project.assets[0];
  const originalBytes = (await service.readAssetContent(id, originalAsset.id, 'owner')).content;
  const entity = first.project.scenes[0].entities.find((entry) => entry.components.some((component) => component.data.assetId === originalAsset.id));
  const changedRecipe = { ...recipe, parts: recipe.parts.map((part) => ({ ...part, color: '#eebb22' })) };
  service.complete.mockResolvedValue(JSON.stringify(changedRecipe));
  const nextRun = await service.createAiRun(id, { mode: 'asset', assetId: originalAsset.id, prompt: 'Make it yellow', model: 'connected-astra' }, 'owner');
  expect(service.complete).toHaveBeenLastCalledWith(expect.stringContaining('Existing recipe:'), { model: 'connected-astra', reasoningEffort: 'high' });
  expect(service.complete.mock.calls.at(-1)[0]).toContain('Cockpit');
  expect(nextRun.refinement).toMatchObject({ assetId: originalAsset.id, instances: 1 });
  expect((await service.getProject(id, 'owner')).project.revision).toBe(2);
  const second = await service.applyAiRun(id, nextRun.id, 'owner');
  const refinedAsset = second.project.assets[1];
  expect(refinedAsset.metadata.refinedFrom).toBe(originalAsset.id);
  expect(second.project.scenes[0].entities).toHaveLength(first.project.scenes[0].entities.length);
  const revisedEntity = second.project.scenes[0].entities.find((entry) => entry.id === entity.id);
  expect(revisedEntity.components.find((component) => component.type === 'MeshRenderer').data.assetId).toBe(refinedAsset.id);
  expect(revisedEntity.components.find((component) => component.type === 'Transform')).toEqual(entity.components.find((component) => component.type === 'Transform'));
  expect((await service.readAssetContent(id, originalAsset.id, 'owner')).content.equals(originalBytes)).toBe(true);
  expect((await service.readAssetContent(id, refinedAsset.id, 'owner')).content.equals(originalBytes)).toBe(false);
  const undone = await service.applyCommands(id, { baseRevision: 3, commands: second.commandBatch.inverses }, 'owner');
  expect(undone.project.scenes[0].entities.find((entry) => entry.id === entity.id).components.find((component) => component.type === 'MeshRenderer').data.assetId).toBe(originalAsset.id);
  expect(undone.project.assets).toHaveLength(2);
  expect(undone.project.files.some((file) => file.path === refinedAsset.metadata.sourcePath)).toBe(true);
  const redone = await service.applyCommands(id, { baseRevision: 4, commands: second.commandBatch.commands }, 'owner');
  expect(redone.project.scenes[0].entities.find((entry) => entry.id === entity.id).components.find((component) => component.type === 'MeshRenderer').data.assetId).toBe(refinedAsset.id);
  expect((await service.runPlaytest(id, {}, 'owner')).status).toBe('passed');
});

test('refinement cannot read another project asset or silently replace a model with missing source', async () => {
  const first = await service.createProject({ name: 'Source', template: 'blank' }, 'owner');
  const second = await service.createProject({ name: 'Other', template: 'blank' }, 'owner');
  const run = await service.createAiRun(first.project.id, { mode: 'asset', recipe }, 'owner');
  const applied = await service.applyAiRun(first.project.id, run.id, 'owner');
  const asset = applied.project.assets[0];
  await expect(service.createAiRun(second.project.id, { mode: 'asset', assetId: asset.id, prompt: 'Change it' }, 'owner')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  await service.deleteSourceFiles(first.project.id, { baseRevision: 2, paths: [asset.metadata.sourcePath] }, 'owner');
  await expect(service.createAiRun(first.project.id, { mode: 'asset', assetId: asset.id, prompt: 'Change it' }, 'owner')).rejects.toMatchObject({ code: 'MODEL_SOURCE_UNAVAILABLE' });
  expect(service.complete).not.toHaveBeenCalled();
});

'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { compileEnvironmentRecipe, terrainHeight, sceneryContext, TAG } = require('./environment-creator');
const { GameStudioService } = require('./service');
const { sampleTerrainHeight, sampleSceneGroundHeight } = require('../../packages/lilly-engine/dist/gameplay/src');

const recipe = {
  schema: 'LillyEnvironmentRecipe/v1', name: 'Morning woodland', seed: 'woodland-42',
  terrain: { size: [64, 64], height: 5, color: '#52734b', hills: [{ center: [0.6, -0.6], radius: 0.5, height: 1 }] },
  sky: { color: '#c5e0e2', ambient: 0.9, sunColor: '#fff0ce', sunIntensity: 2.5, fog: { color: '#c5e0e2', near: 35, far: 95 } },
  models: [{ id: 'pine', recipe: { schema: 'LillyModelRecipe/v1', name: 'Layered pine', parts: [
    { name: 'Trunk', shape: 'cylinder', position: [0, 1, 0], scale: [0.5, 2, 0.5], color: '#714d35' },
    { name: 'Lower needles', shape: 'cone', position: [0, 2.6, 0], scale: [3.5, 3, 3.5], color: '#285a45' },
    { name: 'Upper needles', shape: 'cone', position: [0, 4.1, 0], scale: [2.5, 2.8, 2.5], color: '#42805d' },
  ] } }, { id: 'rock', recipe: { schema: 'LillyModelRecipe/v1', name: 'Moss boulder', parts: [
    { name: 'Stone', shape: 'icosahedron', scale: [2, 1.4, 1.8], color: '#707875' },
    { name: 'Moss', shape: 'icosahedron', position: [0.1, 0.6, 0], scale: [1.6, 0.25, 1.4], color: '#638440' },
  ] } }],
  scatter: [{ modelId: 'pine', count: 22, radius: 0.94, scale: [0.7, 1.2] }, { modelId: 'rock', count: 12, radius: 0.9, scale: [0.6, 1.2] }],
  placements: [{ modelId: 'pine', point: [0.6, -0.6], scale: 1.3, yaw: 20 }],
};

test('deterministic real geometry with shared mesh data, clear spawn and correctly grounded props', () => {
  const compiled = compileEnvironmentRecipe(recipe);
  expect(compiled.buffer.equals(compileEnvironmentRecipe(recipe).buffer)).toBe(true);
  expect(compiled.summary.instances).toBe(35);
  expect(compiled.terrain.heights.some(h => h > 0.8)).toBe(true);
  expect(terrainHeight(compiled.terrain, 0, 0)).toBe(0);
  for (const instance of compiled.instances) {
    expect(Math.hypot(instance.position[0], instance.position[2])).toBeGreaterThan(5);
    expect(instance.position[1]).toBeCloseTo(terrainHeight(compiled.terrain, instance.position[0], instance.position[2]), 3);
    expect(sampleTerrainHeight(compiled.terrain, {}, instance.position[0], instance.position[2])).toBeCloseTo(instance.position[1], 3);
  }
  expect(compiled.buffer.toString('ascii', 0, 4)).toBe('glTF');
  expect(compiled.buffer.readUInt32LE(8)).toBe(compiled.buffer.length);
  const jsonLength = compiled.buffer.readUInt32LE(12);
  const gltf = JSON.parse(compiled.buffer.toString('utf8', 20, 20 + jsonLength));
  expect(gltf.scenes[0].nodes).toHaveLength(36);
  expect(gltf.meshes).toHaveLength(6); // terrain + 5 source parts, reused across 35 props
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    if ('indices' in primitive) expect(gltf.accessors[primitive.indices]?.type).toBe('SCALAR');
    for (const index of Object.values(primitive.attributes)) expect(gltf.accessors[index]).toBeDefined();
  }
  for (const view of gltf.bufferViews) expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(gltf.buffers[0].byteLength);
  expect(gltf.buffers[0].byteLength).toBe(compiled.buffer.length - 28 - jsonLength);
});

test('rejects unknown models, oversized scenes and malformed recipes with actionable errors', () => {
  expect(() => compileEnvironmentRecipe({ ...recipe, scatter: [{ modelId: 'missing', count: 3 }] })).toThrow('unknown model');
  expect(() => compileEnvironmentRecipe({ ...recipe, terrain: { ...recipe.terrain, size: [500, 64] } })).toThrow('Terrain size');
  expect(() => compileEnvironmentRecipe({ ...recipe, models: [] })).toThrow('uniquely named');
  expect(() => compileEnvironmentRecipe({ ...recipe, scatter: [], placements: [{ modelId: 'pine', point: [0, 0] }] })).toThrow('No scenery fits');
});

test('height sampling respects rendered triangles, translation, yaw, scale and disabled surfaces', () => {
  const terrain = { id: 'hill', resolution: 2, heights: [0, 0, 0, 1], heightScale: 4, size: { x: 2, y: 2 } };
  expect(sampleTerrainHeight(terrain, {}, 0, 0)).toBe(0); // bilinear interpolation would incorrectly return 1
  expect(sampleTerrainHeight(terrain, {}, 0.5, 0.5)).toBe(2);
  expect(sampleTerrainHeight(terrain, {}, 3, 0)).toBeNull();
  const transform = { position: { x: 10, y: 3, z: 5 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 } };
  expect(sampleTerrainHeight(terrain, transform, 11, 4)).toBeCloseTo(7);
  const scene = { id: 's', entities: [{ id: 't', enabled: true, tags: [], components: [{ type: 'Transform', data: transform }, { type: 'Terrain', data: { terrainId: 'hill' } }] }] };
  expect(sampleSceneGroundHeight(scene, [terrain], 11, 4)).toBeCloseTo(7);
  scene.entities[0].enabled = false;
  expect(sampleSceneGroundHeight(scene, [terrain], 11, 4)).toBeNull();
});

let root, service;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-scenery-'));
  service = new GameStudioService({ root: path.join(root, 'data'), buildRoot: path.join(root, 'builds'), postgres: { enabled: false }, complete: jest.fn().mockResolvedValue(JSON.stringify(recipe)) });
  await service.initialize();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('AI scenery -> saved GLBs and native terrain -> replace -> undo/redo -> playable build', async () => {
  const created = await service.createProject({ name: 'Scenery proof', template: 'third-person-explorer' }, 'owner');
  const id = created.project.id;
  const run = await service.createAiRun(id, { mode: 'environment', prompt: 'Morning woodland', model: 'connected-astra' }, 'owner');
  expect(service.complete).toHaveBeenCalledWith(expect.stringContaining('Morning woodland'), { model: 'connected-astra', reasoningEffort: 'high' });
  expect((await service.getProject(id, 'owner')).project).toEqual(created.project);
  expect(await service.readModelPreview(id, run.id, 'other')).toBeNull();
  expect(await service.applyAiRun(id, run.id, 'other')).toBeNull();
  const preview = await service.readModelPreview(id, run.id, 'owner');
  const first = await service.applyAiRun(id, run.id, 'owner');
  expect(first.validation.valid).toBe(true);
  expect(first.moduleSummary.terrains).toHaveLength(1);
  expect(first.project.assets).toHaveLength(2);
  for (const asset of first.project.assets) {
    const content = (await service.readAssetContent(id, asset.id, 'owner')).content;
    expect(content.equals(preview.models.find(m => m.recipe.name === asset.name).buffer)).toBe(true);
    expect(first.project.files.find(f => f.path === asset.metadata.sourcePath)).toBeDefined();
  }
  for (const original of created.project.scenes[0].entities) {
    if (original.components.some(c => c.type === 'Light')) continue;
    expect(first.project.scenes[0].entities.find(e => e.id === original.id)).toEqual(original);
  }
  expect((await service.applyAiRun(id, run.id, 'owner')).project.revision).toBe(2);
  service.complete.mockResolvedValue(JSON.stringify({ ...recipe, name: 'Winter grove', seed: 'winter', sky: { ...recipe.sky, color: '#daeafa' } }));
  const secondRun = await service.createAiRun(id, { mode: 'environment', prompt: 'Make it winter' }, 'owner');
  expect(service.complete.mock.calls.at(-1)[0]).toContain('Previous scenery recipe');
  const second = await service.applyAiRun(id, secondRun.id, 'owner');
  expect(second.moduleSummary.terrains).toHaveLength(1);
  expect(second.project.scenes[0].entities.filter(e => e.tags.includes(TAG))).toHaveLength(secondRun.preview.environment.instances + 1);
  const undone = await service.applyCommands(id, { baseRevision: 3, commands: second.commandBatch.inverses }, 'owner');
  expect(undone.project.scenes).toEqual(first.project.scenes);
  expect(undone.moduleSummary.terrains).toEqual(first.moduleSummary.terrains);
  expect(undone.project.assets).toHaveLength(4);
  const redone = await service.applyCommands(id, { baseRevision: 4, commands: second.commandBatch.commands }, 'owner');
  expect(redone.project.scenes).toEqual(second.project.scenes);
  expect((await service.runPlaytest(id, {}, 'owner')).status).toBe('passed');
  const build = await service.createBuild(id, { projectRevision: 5 }, 'owner');
  expect(build.status).toBe('success');
  expect(build.files.filter(file => /assets\/.*\.glb$/.test(file.path))).toHaveLength(4);
});

test('protects existing floors and rejects stale or unavailable AI without a preset', async () => {
  const created = await service.createProject({ name: 'Protection', template: 'third-person-explorer' }, 'owner');
  const context = sceneryContext(created.project);
  expect(context.clearings.some(zone => zone.halfX > 5)).toBe(true);
  const run = await service.createAiRun(created.project.id, { mode: 'environment', recipe }, 'owner');
  await service.applyCommands(created.project.id, { baseRevision: 1, commands: [{ operation: 'scene.rename', target: { sceneId: created.project.entryScene }, payload: { name: 'Keep my edit' } }] }, 'owner');
  await expect(service.applyAiRun(created.project.id, run.id, 'owner')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await service.getProject(created.project.id, 'owner')).project.assets).toHaveLength(0);
  service.complete.mockRejectedValue(new Error('offline'));
  await expect(service.createAiRun(created.project.id, { mode: 'environment', prompt: 'Forest' }, 'owner')).rejects.toMatchObject({ code: 'AI_GENERATION_FAILED' });
});

test('automatically asks the selected author to correct one invalid recipe, with a strict retry bound', async () => {
  const created = await service.createProject({ name: 'Repair', template: 'blank' }, 'owner');
  const invalid = { ...recipe, terrain: { ...recipe.terrain, hills: [{ center: [0, 0], radius: 0.5, height: 2 }] } };
  service.complete.mockResolvedValueOnce(JSON.stringify(invalid)).mockResolvedValueOnce(JSON.stringify(recipe));
  const run = await service.createAiRun(created.project.id, { mode: 'environment', model: 'connected-astra', prompt: 'Woodland' }, 'owner');
  expect(run.generation.corrected).toBe(true);
  expect(service.complete).toHaveBeenCalledTimes(2);
  expect(service.complete).toHaveBeenLastCalledWith(expect.stringContaining('Hill height must be between 0 and 1'), { model: 'connected-astra', reasoningEffort: 'high' });
  const applied = await service.applyAiRun(created.project.id, run.id, 'owner');
  const undone = await service.applyCommands(created.project.id, { baseRevision: 2, commands: applied.commandBatch.inverses }, 'owner');
  expect(undone.project.scenes).toEqual(created.project.scenes);
  expect(undone.moduleSummary.terrains).toHaveLength(0);
  expect(undone.project.assets).toHaveLength(2);
  service.complete.mockClear().mockResolvedValue(JSON.stringify(invalid));
  await expect(service.createAiRun(created.project.id, { mode: 'environment', prompt: 'Woodland' }, 'owner')).rejects.toMatchObject({ code: 'ENVIRONMENT_RECIPE_INVALID' });
  expect(service.complete).toHaveBeenCalledTimes(2);
  service.complete.mockClear();
  await expect(service.createAiRun(created.project.id, { mode: 'environment', recipe: invalid }, 'owner')).rejects.toMatchObject({ code: 'ENVIRONMENT_RECIPE_INVALID' });
  expect(service.complete).not.toHaveBeenCalled();
});

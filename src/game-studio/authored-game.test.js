'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { GameStudioService } = require('./service');
const { validatePlan, routing } = require('./game-plan');
const { plan, response, scene, gameplay } = require('./test-fixtures/authored-game');
jest.setTimeout(60000);
let root, studio;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-authored-'));
  studio = new GameStudioService({ root: path.join(root, 'data'), buildRoot: path.join(root, 'builds'), postgres: { enabled: false }, complete: jest.fn(async prompt => response(prompt)) });
  await studio.initialize();
});
afterEach(async () => { await Promise.allSettled(studio.productions.jobs.values()); await fs.rm(root, { recursive: true, force: true }); });
async function build(input = {}) {
  const draft = await studio.productions.create({ brief: 'An original color sequence puzzle', plan, ...input }, 'owner');
  await studio.productions.control(draft.id, 'start', { revision: draft.revision }, 'owner');
  await studio.productions.jobs.get(draft.id);
  return studio.productions.get(draft.id, 'owner');
}

test('blank project becomes an original game with its own world, rules, targeted GLB and four passing specs', async () => {
  const create = jest.spyOn(studio, 'createProject');
  const result = await build({ models: { level: 'world-model', asset: 'default-artist' }, taskModels: { 'asset-beacon': 'specialist-artist', gameplay: 'rules-model' } });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe('ready');
  expect(create.mock.calls[0][0].template).toBe('blank');
  expect(result.tasks.some(t => t.id === 'environment')).toBe(false);
  expect(result.tasks.find(t => t.id === 'gameplay')).toMatchObject({ model: 'rules-model', testResults: { passed: 4, failed: 0 }, coverage: { win: 'prism-win', loss: 'prism-loss', reset: 'prism-reset' } });
  const project = (await studio.getProject(result.projectId, 'owner')).project;
  expect(project.settings.runtimeProfile).toBe('module-driven');
  expect(project.levelRecipes).toHaveLength(0);
  expect(project.blueprints).toHaveLength(0);
  expect(project.files.filter(f => f.path.endsWith('.system.ts'))).toHaveLength(1);
  const beacon = project.scenes[0].entities.find(e => e.id === 'beacon');
  const asset = project.assets.find(a => a.id === beacon.components.find(c => c.type === 'MeshRenderer').data.assetId);
  expect(asset.name).toBe('Prism');
  expect((await studio.readAssetContent(project.id, asset.id, 'owner')).content.toString('ascii', 0, 4)).toBe('glTF');
  expect(result.build).toMatchObject({ status: 'success', projectRevision: project.revision });
  expect(studio.complete.mock.calls.map(([, options]) => options.model)).toEqual(['world-model', 'specialist-artist', 'rules-model']);
});

test.each(['camera', 'player', 'beacon'])('invalid scene missing %s gets one repair, then stops without applying the invalid scene', async missing => {
  studio.complete.mockImplementation(async prompt => {
    if (!prompt.includes("original scene builder")) return response(prompt);
    const output = scene();
    output.commands = output.commands.filter(command => command.payload.entity?.id !== missing);
    return JSON.stringify(output);
  });
  const result = await build();
  expect(result.status).toBe('failed');
  expect(studio.complete).toHaveBeenCalledTimes(2);
  expect(result.tasks.find(t => t.id === 'assembly').attempts).toBe(0);
  expect((await studio.getProject(result.projectId, 'owner')).project.revision).toBe(1);
});

test('a gameplay worker cannot report ready without distinct win, loss and restart specs', async () => {
  studio.complete.mockImplementation(async prompt => {
    if (!prompt.includes('Author the original gameplay feature')) return response(prompt);
    const output = gameplay(); output.coverage.reset = output.coverage.win;
    return JSON.stringify(output);
  });
  const result = await build();
  expect(result.status).toBe('failed');
  expect(result.error.message).toContain('three distinct');
  expect(result.tasks.find(t => t.id === 'verify').attempts).toBe(0);
  expect(result.build).toBeUndefined();
});

test('gameplay cannot erase the scene builder keyboard movement bindings', async () => {
  studio.complete.mockImplementation(async prompt => {
    if (!prompt.includes('Author the original gameplay feature')) return response(prompt);
    const output = gameplay();
    output.commands.push({ operation: 'input.replace', target: {}, payload: { inputMap: [{ action: 'Reset', kind: 'button', keys: ['KeyR'] }] } });
    return JSON.stringify(output);
  });
  const result = await build();
  expect(result.status).toBe('failed');
  expect(result.error.message).toContain('four distinct keyboard keys');
  expect(result.tasks.find(t => t.id === 'verify').attempts).toBe(0);
  expect((await studio.getProject(result.projectId, 'owner')).project.inputMap.some(binding => binding.action === 'Move')).toBe(true);
});

test('plans and task routing remain compatible with future model ids and explicit default overrides', () => {
  expect(validatePlan(plan)).toMatchObject({ foundation: 'authored', environmentPrompt: null });
  expect(() => validatePlan({ ...plan, foundation: 'imaginary-engine' })).toThrow('foundation');
  expect(routing({ models: { asset: 'future-model' }, taskModels: { 'asset-beacon': '' } }).taskModels).toEqual({ 'asset-beacon': '' });
  expect(() => routing({ taskModels: { 'unknown-task': 'model' } })).toThrow('Task models');
});

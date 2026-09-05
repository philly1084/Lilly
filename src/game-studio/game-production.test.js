'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { GameStudioService } = require('./service');
const { validatePlan, routing } = require('./game-plan');
const { plan, response } = require('./test-fixtures/game-production');
jest.setTimeout(60000);
let root, studio;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-production-'));
  studio = new GameStudioService({ root: path.join(root, 'data'), buildRoot: path.join(root, 'builds'), postgres: { enabled: false }, complete: jest.fn(async prompt => response(prompt)) });
  await studio.initialize();
});
afterEach(async () => { await Promise.allSettled(studio.productions.jobs.values()); await fs.rm(root, { recursive: true, force: true }); });
async function finished(id) { await studio.productions.jobs.get(id); return studio.productions.get(id, 'owner'); }
async function start(input = {}) {
  const draft = await studio.productions.create({ brief: 'A woodland game', plan, ...input }, 'owner');
  await studio.productions.control(draft.id, 'start', { revision: draft.revision }, 'owner');
  return draft;
}

test('reviewed designs and team choices persist without launching workers or creating projects', async () => {
  const draft = await studio.productions.create({ brief: 'Save a design for later', plan }, 'owner');
  const edited = { ...plan, name: 'Saved woodland game', winCondition: 'Reach the beacon with every seed.' };
  const saved = await studio.executeToolAction('save-game-design', { productionId: draft.id, revision: draft.revision, plan: edited, models: { asset: 'future-asset-model' }, concurrency: 4 }, { userId: 'owner' });
  expect(saved.status).toBe('review');
  expect(saved.revision).toBe(draft.revision + 1);
  expect(saved.projectId).toBeNull();
  expect(studio.complete).not.toHaveBeenCalled();
  expect(studio.productions.jobs.size).toBe(0);
  const reopened = await studio.productions.get(draft.id, 'owner');
  expect(reopened.plan.name).toBe(edited.name);
  expect(reopened.plan.winCondition).toBe(edited.winCondition);
  expect(reopened.models.asset).toBe('future-asset-model');
  expect(reopened.concurrency).toBe(4);
  expect(await studio.listProjects('owner')).toHaveLength(0);
  expect(await studio.productions.get(draft.id, 'another-owner')).toBeNull();
});

test('stale saves and a start racing a saved revision cannot overwrite reviewed work', async () => {
  const draft = await studio.productions.create({ brief: 'Concurrent review', plan }, 'owner');
  const stale = await studio.productions.read(draft.id, 'owner');
  await studio.productions.control(draft.id, 'save', { revision: draft.revision, plan: { ...plan, name: 'Latest design' } }, 'owner');
  await expect(studio.productions.control(draft.id, 'save', { revision: draft.revision, plan }, 'owner')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(studio.productions.launch(stale)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await studio.productions.get(draft.id, 'owner')).plan.name).toBe('Latest design');
  expect(studio.complete).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(studio.productions.directory(draft.id), 'lease'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('invalid design saves leave the previous plan and revision intact and release ownership', async () => {
  const draft = await studio.productions.create({ brief: 'Validate before save', plan }, 'owner');
  await expect(studio.productions.control(draft.id, 'save', { revision: draft.revision, plan: { ...plan, coreLoop: [] } }, 'owner')).rejects.toMatchObject({ code: 'GAME_PLAN_INVALID' });
  expect(await studio.productions.get(draft.id, 'owner')).toEqual(draft);
  const saved = await studio.productions.control(draft.id, 'save', { revision: draft.revision, plan }, 'owner');
  expect(saved.status).toBe('review');
});

test('brief -> reviewed design -> independent models -> saved game, executable mechanics and immutable player', async () => {
  const draft = await studio.productions.create({ brief: 'Make a treasure hunt', models: { director: 'future-director', asset: 'future-model-builder', gameplay: 'codex-worker' }, concurrency: 3 }, 'owner');
  const designed = await finished(draft.id);
  expect(designed.status).toBe('review');
  expect(designed.projectId).toBeNull();
  expect(await studio.listProjects('owner')).toHaveLength(0);
  await studio.productions.control(draft.id, 'start', { revision: designed.revision }, 'owner');
  const result = await finished(draft.id);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe('ready');
  expect(result.tasks.every(t => t.status === 'done')).toBe(true);
  expect(result.tasks.find(t => t.id === 'gameplay').testResults.passed).toBeGreaterThan(0);
  const project = (await studio.getProject(result.projectId, 'owner')).project;
  expect(project.files.some(f => f.path === 'design/game-plan.json')).toBe(true);
  expect(project.files.some(f => f.path.endsWith('.system.ts'))).toBe(true);
  const scene = project.scenes.find(s => s.id === project.entryScene);
  expect(scene.entities.some(e => e.id === 'ground' || e.id === 'monument-a')).toBe(false);
  const seed = project.assets.find(asset => asset.name === 'Sunseed');
  expect(scene.entities.filter(e => e.tags.includes('pickup')).every(e => e.components.some(c => c.type === 'MeshRenderer' && c.data.assetId === seed.id))).toBe(true);
  expect(project.inputMap.some(binding => binding.action === 'Sprint' && binding.keys.includes('ShiftLeft'))).toBe(true);
  for (const asset of project.assets) expect((await studio.readAssetContent(project.id, asset.id, 'owner')).content.toString('ascii', 0, 4)).toBe('glTF');
  expect(result.build.status).toBe('success');
  expect(result.build.projectRevision).toBe(project.revision);
  expect(studio.complete.mock.calls.some(([, options]) => options.model === 'future-model-builder')).toBe(true);
  expect(studio.complete.mock.calls.some(([, options]) => options.model === 'codex-worker')).toBe(true);
  expect(result.tasks.every(t => !t.output)).toBe(true);
});

test('bounded parallel authors start together while scene writes remain sequential', async () => {
  let inFlight = 0, maximum = 0;
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  studio.complete.mockImplementation(async prompt => {
    if (prompt.includes('LillyModelRecipe/v1') || prompt.includes('LillyEnvironmentRecipe/v1')) {
      inFlight++; maximum = Math.max(maximum, inFlight);
      if (inFlight === 2) release();
      await bothStarted;
      inFlight--;
    }
    return response(prompt);
  });
  const draft = await start({ concurrency: 2 });
  const result = await finished(draft.id);
  expect(result.error).toBeUndefined();
  expect(maximum).toBe(2);
  const revisions = result.tasks.filter(t => t.appliedRevision).map(t => t.appliedRevision);
  expect(new Set(revisions).size).toBe(revisions.length);
});

test('director repairs an oversized game brief once before presenting a reviewable plan', async () => {
  studio.complete.mockResolvedValueOnce(JSON.stringify({ ...plan, gameplayPrompt: 'x'.repeat(2001) })).mockResolvedValueOnce(JSON.stringify(plan));
  const draft = await studio.productions.create({ brief: 'Keep the original puzzle', models: { director: 'future-director' } }, 'owner');
  const result = await finished(draft.id);
  expect(result.status).toBe('review');
  expect(result.plan.gameplayPrompt).toBe(plan.gameplayPrompt);
  expect(result.events.some(event => event.message.includes('correcting the game design'))).toBe(true);
  expect(studio.complete).toHaveBeenCalledTimes(2);
  expect(studio.complete.mock.calls[1][0]).toContain('Original gameplay brief needs');
  expect(studio.complete.mock.calls[1][1].model).toBe('future-director');
  expect(await studio.listProjects('owner')).toHaveLength(0);
});

test('invalid director output stops after one correction and remains resumable', async () => {
  studio.complete.mockResolvedValue('not valid JSON');
  const draft = await studio.productions.create({ brief: 'A puzzle' }, 'owner');
  const result = await finished(draft.id);
  expect(result.status).toBe('failed');
  expect(result.plan).toBeNull();
  expect(studio.complete).toHaveBeenCalledTimes(2);
  studio.complete.mockResolvedValue(JSON.stringify(plan));
  await studio.productions.control(draft.id, 'resume', { revision: result.revision }, 'owner');
  expect((await finished(draft.id)).status).toBe('review');
});

test('director transport failures and cancellation do not launch correction requests', async () => {
  studio.complete.mockRejectedValueOnce(new Error('provider offline'));
  const failed = await studio.productions.create({ brief: 'A puzzle' }, 'owner');
  expect((await finished(failed.id)).status).toBe('failed');
  expect(studio.complete).toHaveBeenCalledTimes(1);
  let release;
  studio.complete.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const stopped = await studio.productions.create({ brief: 'Another puzzle' }, 'owner');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await studio.productions.control(stopped.id, 'stop', {}, 'owner');
  release('invalid JSON');
  expect((await finished(stopped.id)).status).toBe('stopped');
  expect(studio.complete).toHaveBeenCalledTimes(2);
});

test('failure retains completed outputs, new service resumes without regenerating successful assets', async () => {
  let failedOnce = false;
  studio.complete.mockImplementation(async prompt => {
    if (prompt.includes('temple arch') && !prompt.includes('Author the original') && !failedOnce) { failedOnce = true; throw new Error('offline'); }
    return response(prompt);
  });
  const draft = await start({ concurrency: 1 });
  const failed = await finished(draft.id);
  expect(failed.status).toBe('failed');
  expect(failed.tasks.find(t => t.id === 'asset-seed').status).toBe('done');
  const author = jest.fn(async prompt => response(prompt));
  studio = new GameStudioService({ root: studio.root, buildRoot: studio.buildRoot, postgres: { enabled: false }, complete: author });
  await studio.initialize();
  await studio.productions.control(draft.id, 'resume', { revision: failed.revision, models: { asset: 'replacement-model' } }, 'owner');
  const result = await finished(draft.id);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe('ready');
  expect(author.mock.calls.filter(([prompt]) => prompt.includes('small golden seed crystal') && !prompt.includes('Author the original'))).toHaveLength(0);
});

test('ownership, stale plan and limits reject before invoking providers or creating projects', async () => {
  expect(() => validatePlan({ ...plan, assets: [plan.assets[0], plan.assets[0]] })).toThrow('unique');
  expect(() => routing({ concurrency: 5 })).toThrow('1–4');
  const draft = await studio.productions.create({ brief: 'A game', plan }, 'owner');
  expect(await studio.productions.get(draft.id, 'other')).toBeNull();
  expect(await studio.productions.control(draft.id, 'start', { revision: draft.revision }, 'other')).toBeNull();
  await expect(studio.productions.control(draft.id, 'start', { revision: 0 }, 'owner')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await studio.listProjects('owner')).toHaveLength(0);
  expect(studio.complete).not.toHaveBeenCalled();
});

test('a crash after an applied revision resumes the same proposal without duplicate geometry', async () => {
  const apply = studio.applyAiRun.bind(studio);
  let interrupted = false;
  studio.applyAiRun = async (...args) => {
    const result = await apply(...args);
    if (!interrupted && result.project.assets.length === 2) {
      interrupted = true;
      throw Object.assign(new Error('Simulated worker exit after durable apply'), { code: 'WORKER_EXIT' });
    }
    return result;
  };
  const draft = await start({ concurrency: 1 });
  const failed = await finished(draft.id);
  expect(failed.status).toBe('failed');
  studio.applyAiRun = apply;
  await studio.productions.control(draft.id, 'resume', { revision: failed.revision }, 'owner');
  const result = await finished(draft.id);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe('ready');
  expect((await studio.getProject(result.projectId, 'owner')).project.assets).toHaveLength(3);
});

test('a second service cannot claim a live production lease', async () => {
  const draft = await studio.productions.create({ brief: 'Lease proof', plan }, 'owner');
  const lease = await studio.productions.lease(draft.id);
  const other = new GameStudioService({ root: studio.root, buildRoot: studio.buildRoot, postgres: { enabled: false } });
  try { await expect(other.productions.lease(draft.id)).rejects.toMatchObject({ code: 'PRODUCTION_BUSY' }); }
  finally { await lease.close(); }
});

test('outside edits prevent further integration and remain untouched', async () => {
  let changed = false;
  studio.complete.mockImplementation(async prompt => {
    if (prompt.includes('LillyEnvironmentRecipe/v1') && !changed) {
      changed = true;
      const [metadata] = await studio.listProjects('owner');
      const { project } = await studio.getProject(metadata.id, 'owner');
      await studio.applyCommands(project.id, { baseRevision: project.revision, commands: [{ operation: 'scene.rename', target: { sceneId: project.entryScene }, payload: { name: 'My hand edit' } }] }, 'owner');
    }
    return response(prompt);
  });
  const draft = await start({ concurrency: 1 });
  const result = await finished(draft.id);
  expect(result.status).toBe('failed');
  expect(result.error.code).toBe('REVISION_CONFLICT');
  expect((await studio.getProject(result.projectId, 'owner')).project.scenes[0].name).toBe('My hand edit');
});

test('stop waits for active authors, discards no saved work and launches no dependent stages', async () => {
  let stop;
  const gate = new Promise(resolve => { stop = resolve; });
  let started;
  const began = new Promise(resolve => { started = resolve; });
  studio.complete.mockImplementation(async prompt => {
    if (prompt.includes('LillyEnvironmentRecipe/v1')) { started(); await gate; }
    return response(prompt);
  });
  const draft = await start({ concurrency: 1 });
  await began;
  await studio.productions.control(draft.id, 'stop', {}, 'owner');
  stop();
  const result = await finished(draft.id);
  expect(result.status).toBe('stopped');
  expect(result.tasks.find(t => t.id === 'level').appliedRevision).toBe(2);
  expect(result.tasks.find(t => t.id === 'gameplay').attempts).toBe(0);
});

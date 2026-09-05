'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { parseLenientJson } = require('../utils/lenient-json');
const { applyCommandBatch } = require('../../packages/lilly-engine/dist/core/src');
const { compileModuleBundle, assertModuleBundleValid, LILLY_RUNTIME_TYPE_DECLARATIONS } = require('../../packages/lilly-engine/dist/modules/src');
const { runMechanicTests } = require('./module-runner');
const { CAPABILITIES, validatePlan, routing, designPrompt, invalid } = require('./game-plan');
const { sceneAuthorPrompt, validateSceneCommands, validatePlayableScene } = require('./scene-author');

const now = () => new Date().toISOString();
const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const active = status => ['planning', 'building', 'stopping'].includes(status);
const task = (id, role, name) => ({ id, role, name, status: 'queued', attempts: 0 });

class GameProductionService {
  constructor(studio) {
    this.studio = studio;
    this.root = path.join(studio.root, 'productions');
    this.jobs = new Map();
    this.leases = new Map();
  }
  directory(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw error('PRODUCTION_NOT_FOUND', 'Game build not found.', 404);
    return path.join(this.root, id);
  }
  async read(id, owner) {
    let value;
    try { value = JSON.parse(await fs.readFile(path.join(this.directory(id), 'production.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    return value.ownerId === owner ? value : null;
  }
  view(value) {
    if (!value) return null;
    const { ownerId, ...result } = value;
    result.tasks = value.tasks.map(({ output, ...entry }) => entry);
    return result;
  }
  async get(id, owner) {
    const value = await this.read(id, owner);
    if (value && active(value.status) && !this.jobs.has(id)) {
      let stat;
      try { stat = await fs.stat(path.join(this.directory(id), 'lease')); } catch (_) {}
      if (!stat || Date.now() - stat.mtimeMs > 90000) value.status = 'interrupted';
    }
    if (value && active(value.status) && await fs.stat(path.join(this.directory(id), 'stop')).then(() => true, () => false)) value.status = 'stopping';
    return this.view(value);
  }
  async list(owner) {
    await fs.mkdir(this.root, { recursive: true });
    const names = await fs.readdir(this.root);
    const values = await Promise.all(names.filter(id => /^[a-f0-9-]{36}$/.test(id)).map(id => this.get(id, owner)));
    return values.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  }
  async save(value, message, taskId) {
    return this.studio.withProjectLock(`production:${value.id}`, async () => {
      await this.leases.get(value.id)?.check();
      value.updatedAt = now();
      value.revision += 1;
      if (message) value.events.push({ sequence: value.revision, at: now(), taskId: taskId || null, message });
      value.events = value.events.slice(-160);
      await this.studio.writeJsonAtomic(path.join(this.directory(value.id), 'production.json'), value);
    });
  }
  async create(input, owner) {
    if (!owner) throw error('OWNER_REQUIRED', 'Sign in to build a game.', 401);
    const brief = String(input.brief || '').trim();
    if (!brief || brief.length > 6000) throw invalid('Describe the game in 1–6000 characters.');
    if (!input.plan && !this.studio.complete) throw error('AI_UNAVAILABLE', 'Connect an AI model to design a game.', 503);
    const value = { schema: 'LillyGameProduction/v1', id: randomUUID(), ownerId: owner, brief, ...routing(input), status: input.plan ? 'review' : 'planning', revision: 0, createdAt: now(), tasks: [], events: [], plan: input.plan ? validatePlan(input.plan) : null, projectId: null };
    await this.save(value, input.plan ? 'Authored game design ready for review.' : 'Director is designing the game.');
    if (!input.plan) await this.launch(value, true);
    return this.view(value);
  }
  async lease(id) {
    const file = path.join(this.directory(id), 'lease');
    let handle;
    try { handle = await fs.open(file, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs <= 90000) throw error('PRODUCTION_BUSY', 'This game build already has an active worker.');
      // Only explicit resume can take over an expired lease. A replaced worker is fenced out.
      await fs.rename(file, `${file}.${randomUUID()}.expired`);
      handle = await fs.open(file, 'wx');
    }
    const token = randomUUID();
    await handle.writeFile(token);
    const heartbeat = setInterval(() => handle.utimes(new Date(), new Date()).catch(() => {}), 10000);
    heartbeat.unref();
    return {
      check: async () => {
        if ((await fs.readFile(file, 'utf8')) !== token) throw error('PRODUCTION_INTERRUPTED', 'Worker ownership changed. Resume from the saved checkpoints.');
      },
      close: async () => {
        clearInterval(heartbeat);
        await handle.close();
        if (await fs.readFile(file, 'utf8').catch(() => '') === token) await fs.unlink(file);
      },
    };
  }
  async launch(value, planning = false) {
    if (this.jobs.has(value.id)) throw error('PRODUCTION_BUSY', 'This game build is already running.');
    const lease = await this.lease(value.id);
    this.leases.set(value.id, lease);
    const job = (async () => {
      try {
        value.status = planning ? 'planning' : 'building';
        delete value.error;
        await this.save(value, planning ? 'Design stream started.' : 'Build streams started.');
        if (planning) {
          let correction = '';
          for (let attempt = 0; attempt < 2; attempt++) {
            const response = await this.studio.complete(designPrompt(value.brief) + correction, { model: value.models.director || null, reasoningEffort: 'high' });
            await this.check(value, lease);
            try {
              value.plan = validatePlan(parseLenientJson(String(response)));
              break;
            } catch (e) {
              if (attempt) throw e;
              correction = `\nRepair the previous JSON design while preserving the user's game. Validation failed: ${String(e.message).slice(0, 1000)}. Every individual scene, level, environment, gameplay and asset prompt must be at most 2000 characters. Return the complete corrected plan, JSON only. Previous response (possibly shortened): ${String(response).slice(0, 32000)}`;
              await this.save(value, 'Director is correcting the game design to fit the supported format.');
            }
          }
          value.status = 'review';
          await this.save(value, 'Review the game design and model assignments before building.');
        } else await this.execute(value, lease);
      } catch (e) {
        // The replacement worker owns persisted state if this lease expired.
        try {
          await lease.check();
          value.status = e.code === 'PRODUCTION_CANCELLED' ? 'stopped' : 'failed';
          value.error = { code: e.code || 'PRODUCTION_FAILED', message: this.safeError(e) };
          for (const entry of value.tasks) if (entry.status === 'running') entry.status = 'queued';
          await this.save(value, value.error.message);
        } catch (_) {}
      } finally { await lease.close(); this.leases.delete(value.id); }
    })();
    this.jobs.set(value.id, job);
    job.finally(() => this.jobs.delete(value.id)).catch(() => {});
  }
  safeError(e) {
    if (e.statusCode && e.statusCode < 500) return String(e.message).slice(0, 1000);
    return 'A builder could not finish. Saved work is retained; retry with the same or another connected model.';
  }
  async check(value, lease) {
    await lease.check();
    if (await fs.stat(path.join(this.directory(value.id), 'stop')).then(() => true, () => false)) throw error('PRODUCTION_CANCELLED', 'Stopped. Completed work and generated assets are retained.');
  }
  async control(id, action, input, owner) {
    const current = await this.get(id, owner);
    if (!current) return null;
    const value = await this.read(id, owner);
    if (action === 'stop') {
      await fs.writeFile(path.join(this.directory(id), 'stop'), 'stop');
      return { ...current, status: active(current.status) ? 'stopping' : current.status };
    }
    if (!['start', 'resume'].includes(action)) throw invalid('Use start, resume or stop.');
    if (active(current.status)) throw error('PRODUCTION_BUSY', 'This game build is already running.');
    if (current.status === 'ready') return current;
    if (input.revision !== current.revision) throw error('REVISION_CONFLICT', 'The game design changed. Refresh before continuing.');
    Object.assign(value, routing({ models: { ...value.models, ...input.models }, taskModels: input.taskModels ?? value.taskModels, concurrency: input.concurrency ?? value.concurrency }));
    if (input.plan) {
      if (value.projectId) throw invalid('The design is locked once building starts. Continue editing the generated project instead.');
      value.plan = validatePlan(input.plan);
    }
    await fs.unlink(path.join(this.directory(id), 'stop')).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await this.launch(value, !value.plan);
    return this.view(value);
  }
  async project(value) {
    const result = await this.studio.getProject(value.projectId, value.ownerId);
    if (!result) throw error('PRODUCTION_PROJECT_MISSING', 'The generated project is unavailable.', 404);
    if (value.expectedRevision !== result.project.revision) throw error('REVISION_CONFLICT', 'The generated project was edited outside this build. Your changes are safe. Continue in the editor or start a new game design.');
    return result;
  }
  async worker(value, entry, lease, operation) {
    if (entry.status === 'done') return;
    await this.check(value, lease);
    entry.status = 'running'; entry.attempts += 1; entry.model = (value.taskModels?.[entry.id] ?? value.models[entry.role]) || null; delete entry.error;
    await this.save(value, `${entry.name} started.`, entry.id);
    try {
      await operation();
      await this.check(value, lease);
      entry.status = 'done';
      await this.save(value, `${entry.name} finished.`, entry.id);
    } catch (e) {
      entry.status = 'failed'; entry.error = this.safeError(e);
      await lease.check();
      await this.save(value, `${entry.name}: ${entry.error}`, entry.id);
      throw e;
    }
  }
  brief(value, prompt) {
    return `${prompt}\nShared art direction: ${value.plan.artDirection}\nGame: ${value.plan.name}. ${value.plan.fantasy}`.slice(0, 3900);
  }
  async generate(value, entry, mode, prompt, extra = {}) {
    if (entry.output) return;
    const project = await this.project(value);
    let correction = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        entry.output = await this.studio.createAiRun(value.projectId, { mode, prompt: this.brief(value, prompt + correction), model: entry.model, requireAi: true, baseRevision: project.project.revision, ...extra }, value.ownerId);
        break;
      } catch (e) {
        // Environment already has its own bounded correction pass; transport failures need manual retry.
        if (attempt || mode === 'environment' || !['MODEL_RECIPE_INVALID', 'GAME_PLAN_INVALID'].includes(e.code)) throw e;
        correction = `\nThe previous design was invalid: ${String(e.message).slice(0, 700)}. Use simpler geometry that satisfies every documented bound.`;
        await this.save(value, 'Model worker is correcting invalid geometry.', entry.id);
      }
    }
    entry.proposalId = entry.output.id;
    entry.preview = entry.output.preview;
    await this.save(value, 'Validated output saved for assembly.', entry.id);
  }
  async integrate(value, entry, lease) {
    await this.check(value, lease);
    if (!entry.applyId) {
      await this.project(value);
      const output = entry.output;
      // Recompile saved data against the latest project, without another model call.
      const input = { mode: output.mode, prompt: output.prompt, baseRevision: value.expectedRevision, ...(output.assetRecipe ? { recipe: output.assetRecipe } : output.environmentRecipe ? { recipe: output.environmentRecipe } : { commands: output.commands }) };
      const prepared = output.baseRevision === value.expectedRevision ? output : await this.studio.createAiRun(value.projectId, input, value.ownerId);
      entry.applyId = prepared.id;
      await this.save(value, 'Saving validated output into the project.', entry.id);
    }
    // Idempotent after a restart between application and the checkpoint write.
    const { index } = await this.studio.getMetadata(value.projectId, value.ownerId);
    const saved = index.aiRuns.find(run => run.id === entry.applyId);
    if (saved?.status === 'applied') {
      const current = await this.studio.getProject(value.projectId, value.ownerId);
      if (current.project.revision !== saved.appliedRevision) throw error('REVISION_CONFLICT', 'The generated project changed after this saved step. Continue in the editor to preserve your changes.');
    }
    const applied = await this.studio.applyAiRun(value.projectId, entry.applyId, value.ownerId);
    value.expectedRevision = applied.project.revision;
    entry.appliedRevision = applied.project.revision;
    if (entry.role === 'asset') {
      const latest = await this.studio.readIndex();
      entry.assetId = latest.aiRuns.find(run => run.id === entry.applyId)?.assetId;
    }
    await this.save(value);
  }
  async gameplay(value, entry) {
    if (entry.output) return;
    const { project } = await this.project(value);
    const guide = await fs.readFile(path.join(__dirname, '../../docs/game-studio/agent-programming-architecture.md'), 'utf8');
    const runtime = LILLY_RUNTIME_TYPE_DECLARATIONS;
    const rules = value.plan.foundation === 'authored'
      ? 'Implement the complete core loop, win/loss, reset, progression and HUD described in the plan. There are NO preset objectives or hidden expedition rules. Native controllers handle movement; your systems own game rules. Include THREE distinct executable tests for win, loss and restart and display controls in a HUD hint. Return coverage:{win:testId,loss:testId,reset:testId} alongside commands, linking these three tests to the implemented rules.'
      : 'Preserve the existing expedition win/loss while adding the planned original mechanics.';
    const instruction = `Author the original gameplay feature for ${value.plan.name}: ${value.plan.gameplayPrompt}. ${rules} Shared design: ${JSON.stringify(value.plan)}. Return JSON only {commands:[...]}. Use ONLY file.upsert and input.replace. All files must be under modules/game/; include a .module.json manifest, at least one .system.ts and .spec.json files with actual capability-action or state assertions, testing success AND reset/cooldown/failure. You may compose multiple systems, mechanics, prefabs, materials and animation controllers in this module. No prose-only feature. Keep existing input actions and bindings when extending them. JSON file contents are strings. file.upsert shape: {operation:'file.upsert',target:{},payload:{file:{path:'modules/game/game.module.json',content:'...'}}}. input.replace shape: {operation:'input.replace',target:{},payload:{inputMap:...}}. Current input, assets and scene: ${JSON.stringify({ inputMap: project.inputMap, assets: project.assets.map(a => ({ id: a.id, name: a.name })), scene: project.scenes.find(s => s.id === project.entryScene) })}. Exact programming guide:\n${guide}\nExact runtime API:\n${runtime}`;
    let feedback = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.studio.complete(instruction + feedback, { model: entry.model, reasoningEffort: 'high' });
      await this.studio.writeJsonAtomic(path.join(this.directory(value.id), 'gameplay-response.json'), { model: entry.model, attempt: attempt + 1, at: now(), response: String(response).slice(0, 256000) });
      try {
        const parsed = parseLenientJson(String(response));
        const commands = parsed?.commands;
        if (!Array.isArray(commands)) throw invalid('Return a JSON object with commands:[{operation,target,payload}] and coverage:{win,loss,reset}. JSON file contents must be escaped strings.');
        if (!commands.length || commands.length > 20) throw invalid(`Gameplay returned ${commands.length} commands; use 1–20 source/input commands.`);
        for (const command of commands) {
          if (!['file.upsert', 'input.replace'].includes(command?.operation)) throw invalid(`Unsupported gameplay operation ${JSON.stringify(String(command?.operation || '(missing)').slice(0, 100))}; use operation: file.upsert or input.replace.`);
          if (command.operation === 'file.upsert' && !/^modules\/game\/[a-z0-9-]+\.(module\.json|system\.ts|spec\.json|mechanic\.json|prefab\.json|material\.json|animation\.json|asset\.json|terrain\.json)$/.test(command.payload?.file?.path || '')) throw invalid(`Unsupported gameplay file ${JSON.stringify(String(command.payload?.file?.path || '(missing)').slice(0, 200))}. Use modules/game/<lowercase-slug>.system.ts for code, .module.json for manifests, .spec.json for tests, or .mechanic/.prefab/.material/.animation/.asset/.terrain.json for data.`);
          if (command.operation === 'file.upsert' && command.target?.path !== undefined && command.target.path !== command.payload.file.path) throw invalid(`File target ${JSON.stringify(String(command.target.path).slice(0, 200))} differs from payload.file.path. Use target:{} and put the destination only in payload.file.path under modules/game/.`);
        }
        const normalized = this.studio.normalizeCommands(project, commands, project.revision);
        const candidate = applyCommandBatch(project, normalized, project.revision).project;
        if (value.plan.foundation === 'authored') validatePlayableScene(candidate, value.plan);
        const bundle = compileModuleBundle(candidate.files);
        assertModuleBundleValid(bundle);
        const ownTests = bundle.tests.filter(test => test.sourcePath.startsWith('modules/game/'));
        if (!bundle.systems.some(system => system.path.startsWith('modules/game/')) || !ownTests.length || ownTests.some(test => !test.assertions?.length)) throw invalid('Include an executable system and meaningful mechanic tests.');
        if (value.plan.foundation === 'authored') {
          const ids = ['win', 'loss', 'reset'].map(key => parsed.coverage?.[key]);
          if (new Set(ids).size !== 3 || ids.some(id => !ownTests.some(test => test.id === id))) throw invalid('Map coverage.win, coverage.loss and coverage.reset to three distinct executable test ids from your game module.');
          entry.coverage = parsed.coverage;
        }
        const actions = new Set(candidate.inputMap.map(binding => binding.action));
        for (const test of ownTests) for (const step of test.steps || []) {
          for (const action of [...Object.keys(step.input?.buttons || {}), ...Object.keys(step.input?.axes || {})]) {
            if (!actions.has(action)) throw invalid(`Test action ${action} has no real input binding. Include input.replace preserving existing controls and adding this action.`);
          }
        }
        const tests = runMechanicTests(bundle);
        if (tests.status !== 'passed') throw invalid(`Mechanic tests failed: ${JSON.stringify(tests.tests.filter(test => test.status !== 'passed')).slice(0, 3500)}`);
        entry.output = await this.studio.createAiRun(value.projectId, { mode: 'edit', baseRevision: project.revision, commands }, value.ownerId);
        entry.proposalId = entry.output.id;
        entry.testResults = { passed: tests.passed, failed: tests.failed, sourceHash: tests.sourceHash };
        await this.save(value, 'Gameplay compiled and deterministic tests passed.', entry.id);
        return;
      } catch (e) {
        if (attempt === 1) throw e;
        feedback = `\nYour last output failed validation: ${String(e.message).slice(0, 4000)}. Correct it and return the complete commands. Previous response: ${String(response).slice(0, 18000)}`;
        await this.save(value, `Gameplay worker is repairing validation errors: ${String(e.message).slice(0, 700)}`, entry.id);
      }
    }
  }
  async authorScene(value, entry) {
    if (entry.output) return;
    const { project } = await this.project(value);
    const instruction = sceneAuthorPrompt(value.plan, project);
    let feedback = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.studio.complete(instruction + feedback, { model: entry.model, reasoningEffort: 'high' });
      await this.studio.writeJsonAtomic(path.join(this.directory(value.id), 'scene-response.json'), { model: entry.model, attempt: attempt + 1, at: now(), response: String(response).slice(0, 256000) });
      try {
        const { commands } = parseLenientJson(String(response)) || {};
        validateSceneCommands(this.studio, project, commands, value.plan);
        entry.output = await this.studio.createAiRun(value.projectId, { mode: 'edit', baseRevision: project.revision, commands }, value.ownerId);
        entry.proposalId = entry.output.id;
        await this.save(value, 'Original scene and controls validated.', entry.id);
        return;
      } catch (e) {
        if (attempt) throw e;
        feedback = `\nThe previous scene failed validation: ${String(e.message).slice(0, 2000)}. Return corrected complete commands. Previous response: ${String(response).slice(0, 24000)}`;
        await this.save(value, `Scene builder is repairing validation errors: ${String(e.message).slice(0, 700)}`, entry.id);
      }
    }
  }
  async execute(value, lease) {
    if (!value.tasks.length) value.tasks = [task('level', 'level', value.plan.foundation === 'authored' ? 'Original world and controls' : 'Level and objectives'), ...(value.plan.environmentPrompt ? [task('environment', 'environment', 'Scenery and terrain')] : []), ...value.plan.assets.map(asset => task(`asset-${asset.id}`, 'asset', asset.name)), task('assembly', 'director', 'Scene assembly'), task('gameplay', 'gameplay', 'Original gameplay and tests'), task('verify', 'director', 'Playtest and build')];
    if (!value.projectId) {
      await this.check(value, lease);
      // Reconcile a crash just after project creation using a production-specific slug.
      const slug = `game-${value.id}`;
      const existing = (await this.studio.listProjects(value.ownerId)).find(project => project.slug === slug);
      // Authored games start empty; expedition designs retain their native objective scaffold.
      const created = existing ? await this.studio.getProject(existing.id, value.ownerId) : await this.studio.createProject({ name: value.plan.name, slug, template: value.plan.foundation === 'authored' ? 'blank' : 'expedition' }, value.ownerId);
      value.projectId = created.project.id; value.expectedRevision = created.project.revision;
      await this.save(value, 'New editable game project created.');
    }
    const level = value.tasks.find(t => t.id === 'level');
    await this.worker(value, level, lease, async () => {
      if (value.plan.foundation === 'authored') await this.authorScene(value, level);
      else await this.generate(value, level, 'level', value.plan.levelPrompt);
      await this.integrate(value, level, lease);
    });
    const art = value.tasks.filter(t => ['asset', 'environment'].includes(t.role));
    // Producers never mutate the project. Each has an independent saved output and model.
    let cursor = 0;
    const failures = [];
    await Promise.all(Array.from({ length: Math.min(value.concurrency, art.length) }, async () => {
      while (cursor < art.length && !failures.length) {
        const entry = art[cursor++];
        try {
          await this.worker(value, entry, lease, () => this.generate(value, entry, entry.role, entry.role === 'environment' ? value.plan.environmentPrompt : value.plan.assets.find(asset => `asset-${asset.id}` === entry.id).prompt));
        } catch (e) { failures.push(e); }
      }
    }));
    if (failures.length) throw failures[0];
    await this.worker(value, value.tasks.find(t => t.id === 'assembly'), lease, async () => {
      for (const entry of art) if (!entry.appliedRevision) await this.integrate(value, entry, lease);
      await this.saveDesignAndPlacement(value, lease);
    });
    const gameplay = value.tasks.find(t => t.id === 'gameplay');
    await this.worker(value, gameplay, lease, async () => {
      await this.gameplay(value, gameplay);
      await this.integrate(value, gameplay, lease);
    });
    await this.worker(value, value.tasks.find(t => t.id === 'verify'), lease, async () => {
      await this.project(value);
      value.playtest = await this.studio.runPlaytest(value.projectId, {}, value.ownerId);
      if (value.playtest.status !== 'passed') throw error('PRODUCTION_PLAYTEST_FAILED', 'Playtest found problems. Open the project test results before continuing.', 422);
      await this.check(value, lease);
      const current = await this.project(value);
      value.build = current.builds.find(build => build.projectRevision === value.expectedRevision && build.status === 'success') || await this.studio.createBuild(value.projectId, { projectRevision: value.expectedRevision }, value.ownerId);
      await this.save(value, 'Immutable playable build saved.');
    });
    value.status = 'ready';
    await this.save(value, 'Game build ready. Play it and review the design acceptance checklist.');
  }
  async saveDesignAndPlacement(value, lease) {
    const entry = value.tasks.find(t => t.id === 'assembly');
    if (!entry.output) {
      const { project } = await this.project(value);
      const scene = project.scenes.find(s => s.id === project.entryScene);
      const commands = [{ operation: 'file.upsert', target: {}, payload: { file: { path: 'design/game-plan.json', content: JSON.stringify(value.plan, null, 2) } } }];
      let landmark = 0;
      for (const asset of value.plan.assets) {
        const source = value.tasks.find(t => t.id === `asset-${asset.id}`);
        const assetRecord = project.assets.find(a => a.id === source.assetId);
        const modelEntity = assetRecord && scene.entities.find(e => e.components.some(c => c.type === 'MeshRenderer' && c.data.assetId === assetRecord.id));
        if (!modelEntity) throw invalid(`The saved model ${asset.name} could not be located for assembly.`);
        const targets = scene.entities.filter(e => e.id !== modelEntity.id && (asset.targetEntityId ? e.id === asset.targetEntityId : asset.placement === 'player' ? e.tags.includes('player') : asset.placement === 'pickup' ? e.tags.includes('pickup') : false));
        if (asset.targetEntityId && !targets.length) throw invalid(`The planned target ${asset.targetEntityId} for ${asset.name} no longer exists.`);
        if (targets.length) {
          for (const target of targets) {
            const mesh = target.components.find(c => c.type === 'MeshRenderer');
            commands.push({ operation: 'component.set', target: { sceneId: scene.id, entityId: target.id, componentType: 'MeshRenderer' }, payload: { data: { ...mesh?.data, assetId: assetRecord.id, castShadow: true }, enabled: true } });
          }
          commands.push({ operation: 'entity.delete', target: { sceneId: scene.id, entityId: modelEntity.id }, payload: {} });
        } else {
          const transform = modelEntity.components.find(c => c.type === 'Transform');
          commands.push({ operation: 'component.set', target: { sceneId: scene.id, entityId: modelEntity.id, componentType: 'Transform' }, payload: { data: { ...transform.data, position: { ...transform.data.position, x: transform.data.position.x + landmark * 3, z: transform.data.position.z - 3 } }, enabled: true } });
          landmark++;
        }
      }
      entry.output = await this.studio.createAiRun(value.projectId, { mode: 'edit', baseRevision: value.expectedRevision, commands }, value.ownerId);
      await this.save(value);
    }
    await this.integrate(value, entry, lease);
  }
}

module.exports = { GameProductionService, CAPABILITIES };

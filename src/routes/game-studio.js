'use strict';

const { Router } = require('express');

const router = Router();

function ownerId(req) {
  return String(req.user?.username || req.user?.id || '').trim();
}

function service(req) {
  return req.app.locals.gameStudioService;
}

function ensureAvailable(req, res) {
  const gameStudio = service(req);
  if (!gameStudio?.isEnabled?.()) {
    res.status(404).json({ error: { code: 'GAME_STUDIO_DISABLED', message: 'Lilly Game Studio is disabled. Set GAME_STUDIO_ENABLED=true to enable it.' } });
    return null;
  }
  return gameStudio;
}

function notFound(res, kind = 'Project') {
  return res.status(404).json({ error: { code: `${kind.toUpperCase()}_NOT_FOUND`, message: `${kind} not found` } });
}

router.get('/blueprints/registry', async (req, res, next) => {
  try {
    if (!ensureAvailable(req, res)) return;
    const { NODE_REGISTRY } = require('../../packages/lilly-engine/dist/blueprints/src');
    res.json({ schema: 'LillyBlueprintNodeRegistry/v1', nodes: Object.values(NODE_REGISTRY) });
  } catch (error) { next(error); }
});

router.get('/contracts', async (req, res, next) => {
  try {
    if (!ensureAvailable(req, res)) return;
    const core = require('../../packages/lilly-engine/dist/core/src');
    const modules = require('../../packages/lilly-engine/dist/modules/src');
    res.json({
      schema: 'LillyGameStudioContracts/v1',
      engineVersion: core.ENGINE_VERSION,
      contracts: {
        project: core.PROJECT_SCHEMA,
        scene: core.SCENE_SCHEMA,
        entity: core.ENTITY_SCHEMA,
        blueprint: core.BLUEPRINT_SCHEMA,
        command: core.COMMAND_SCHEMA,
        sourceFile: core.SOURCE_FILE_SCHEMA,
        module: core.GAME_MODULE_SCHEMA,
        mechanic: core.MECHANIC_SCHEMA,
        prefab: core.PREFAB_SCHEMA,
        mechanicTest: core.MECHANIC_TEST_SCHEMA,
        moduleBundle: modules.MODULE_BUNDLE_SCHEMA,
      },
      sourceFileTypes: [
        { extension: '.module.json', kind: 'module-manifest', purpose: 'Package metadata, dependencies, capabilities, and exported files' },
        { extension: '.mechanic.json', kind: 'mechanic', purpose: 'Player verbs, inputs, events, state schemas, and composing systems' },
        { extension: '.system.ts', kind: 'system', purpose: 'Typed lifecycle code executed inside the capability sandbox' },
        { extension: '.prefab.json', kind: 'prefab', purpose: 'Reusable versioned entity hierarchies' },
        { extension: '.spec.json', kind: 'test', purpose: 'Deterministic mechanic events and assertions' },
        { extension: '.blueprint.json', kind: 'blueprint', purpose: 'Typed visual graph source' },
        { extension: '.scene.json', kind: 'scene', purpose: 'Scene source and import/export interchange' },
      ],
      capabilities: modules.SCRIPT_CAPABILITIES,
      runtimeTypeDeclarations: modules.LILLY_RUNTIME_TYPE_DECLARATIONS,
      sandbox: {
        schema: 'LillyModuleSandboxPolicy/v1',
        execution: 'opaque-origin iframe plus disposable worker',
        network: 'denied',
        dom: 'denied',
        storage: 'capability bridge only',
        deterministicApis: ['ctx.delta', 'ctx.frame', 'ctx.elapsed', 'ctx.random()', 'ctx.input'],
      },
    });
  } catch (error) { next(error); }
});

router.get('/projects', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const projects = await gameStudio.listProjects(ownerId(req));
    res.json({ projects, count: projects.length });
  } catch (error) { next(error); }
});

router.post('/projects', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    res.status(201).json(await gameStudio.createProject(req.body || {}, ownerId(req)));
  } catch (error) { next(error); }
});

router.get('/projects/:id', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.getProject(req.params.id, ownerId(req));
    if (!result) return notFound(res);
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/projects/:id/files', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.listSourceFiles(req.params.id, ownerId(req));
    if (!result) return notFound(res);
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/projects/:id/files/content', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.readSourceFile(req.params.id, req.query.path, ownerId(req));
    if (!result) return notFound(res);
    res.json(result);
  } catch (error) { next(error); }
});

router.put('/projects/:id/files', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.writeSourceFiles(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.json(result);
  } catch (error) { next(error); }
});

router.delete('/projects/:id/files', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.deleteSourceFiles(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/compile', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.compileProjectModules(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/mechanic-tests', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.runMechanicTestSuite(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/prefab-instances', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.instantiatePrefab(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/commands', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.applyCommands(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/ai-runs', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.createAiRun(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.get('/projects/:id/events', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.getProject(req.params.id, ownerId(req));
    if (!result) return notFound(res);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: ready\ndata: ${JSON.stringify({ projectId: req.params.id, revision: result.project.revision })}\n\n`);
    const unsubscribe = gameStudio.subscribe(req.params.id, (event) => {
      if (!res.writableEnded) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 20000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  } catch (error) { next(error); }
});

router.post('/projects/:id/assets', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.saveAsset(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/playtests', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.runPlaytest(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/editor-preview', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.createEditorPreview(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/builds', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.createBuild(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.post('/builds/:id/publish', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.publishBuild(req.params.id, req.body || {}, ownerId(req), req.app.locals.managedAppService);
    if (!result) return notFound(res, 'Build');
    res.status(202).json(result);
  } catch (error) { next(error); }
});

router.post('/projects/:id/rollback', async (req, res, next) => {
  try {
    const gameStudio = ensureAvailable(req, res);
    if (!gameStudio) return;
    const result = await gameStudio.rollback(req.params.id, req.body || {}, ownerId(req));
    if (!result) return notFound(res);
    res.json(result);
  } catch (error) { next(error); }
});

module.exports = router;

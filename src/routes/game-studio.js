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

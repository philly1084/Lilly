'use strict';

const { Router } = require('express');
const { TeamService } = require('../agent-teams/service');
const { workroomSnapshot, ownerMemorySnapshot } = require('../agent-teams/presentation');

function createTeamRouter({ service = null } = {}) {
  const router = Router();
  const fallback = new TeamService();
  const resolve = (req) => service || req.app.locals.agentTeamRuntime?.service || fallback;
  router.use((req, res, next) => {
    if (!req.user?.username) return res.status(401).json({ error: { code: 'team_auth_required', message: 'Authentication required.' } });
    return next();
  });
  const handle = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (error) {
      if (error.code?.startsWith('team_')) return res.status(error.statusCode || 400).json({ error: { code: error.code, message: error.message } });
      return next(error);
    }
  };
  router.get('/runtime', handle(async (req, res) => res.json(req.app.locals.agentTeamRuntime?.status() || { enabled: false, visionEnabled: false, grokEnabled: false })));
  router.get('/', handle(async (req, res) => res.json({ teams: await resolve(req).list(req.user.username) })));
  router.post('/', handle(async (req, res) => res.status(201).json(await resolve(req).create(req.user.username, req.body, req.get('Idempotency-Key')))));
  router.get('/:teamId/workroom', handle(async (req, res) => {
    const team = await resolve(req).get(req.params.teamId, req.user.username);
    res.set('Cache-Control', 'no-store');
    return res.json(workroomSnapshot(team));
  }));
  router.get('/:teamId/memories', handle(async (req, res) => {
    const team = await resolve(req).get(req.params.teamId, req.user.username);
    res.set('Cache-Control', 'no-store');
    return res.json(ownerMemorySnapshot(team));
  }));
  router.get('/:teamId', handle(async (req, res) => res.json(await resolve(req).get(req.params.teamId, req.user.username))));
  router.post('/:teamId/commands', handle(async (req, res) => {
    const result = await resolve(req).ownerCommand(req.params.teamId, req.user.username,
      req.body?.action, req.body?.input || {}, req.get('Idempotency-Key'));
    return res.json({ result });
  }));
  return router;
}

module.exports = { createTeamRouter };

'use strict';

const { Router } = require('express');
const { artifactStore } = require('../artifacts/artifact-store');
const { AgentOpsService } = require('../agent-ops/service');

function getActor(req = {}) {
  return String(req.user?.username || req.user?.id || '').trim();
}

function requireAdminContext(req, res, next) {
  const role = String(req.user?.role || '').trim().toLowerCase();
  if (!role) {
    return res.status(401).json({
      error: {
        type: 'authentication_required',
        message: 'Authentication required.',
      },
    });
  }
  if (!['admin', 'open'].includes(role)) {
    return res.status(403).json({
      error: {
        type: 'admin_access_required',
        message: 'Admin access required.',
      },
    });
  }
  return next();
}

function buildRequestService(req) {
  if (req.app.locals.agentOpsService) {
    return req.app.locals.agentOpsService;
  }
  return new AgentOpsService({
    agentCompanyService: req.app.locals.agentCompanyService,
    workloadService: req.app.locals.agentWorkloadService,
    agentRunService: req.app.locals.agentRunService,
    artifactStore: req.app.locals.artifactStore || artifactStore,
  });
}

function respondAgentOpsError(res, error) {
  if (!String(error?.code || '').startsWith('agent_')
    && !String(error?.code || '').startsWith('approval_')
    && error?.code !== 'invalid_approval_decision') {
    return false;
  }
  res.status(error.statusCode || error.status || 400).json({
    error: {
      type: 'agent_ops_error',
      code: error.code,
      message: error.message,
    },
  });
  return true;
}

function createAgentOpsRouter({ service = null } = {}) {
  const router = Router();
  router.use(requireAdminContext);

  const resolveService = (req) => service || buildRequestService(req);

  router.get('/overview', async (req, res, next) => {
    try {
      const overview = await resolveService(req).getOverview();
      return res.json(overview);
    } catch (error) {
      return respondAgentOpsError(res, error) ? undefined : next(error);
    }
  });

  router.get('/agents/:agentId/activity', async (req, res, next) => {
    try {
      const activity = await resolveService(req).getAgentActivity(req.params.agentId);
      return res.json(activity);
    } catch (error) {
      return respondAgentOpsError(res, error) ? undefined : next(error);
    }
  });

  router.get('/agents/:agentId/workspace', async (req, res, next) => {
    try {
      const workspace = await resolveService(req).getAgentWorkspace(req.params.agentId);
      return res.json(workspace);
    } catch (error) {
      return respondAgentOpsError(res, error) ? undefined : next(error);
    }
  });

  router.post('/goals', async (req, res, next) => {
    try {
      const result = await resolveService(req).createGoal(req.body || {}, getActor(req));
      return res.status(201).json(result);
    } catch (error) {
      return respondAgentOpsError(res, error) ? undefined : next(error);
    }
  });

  router.post('/approvals/:approvalId/resolve', async (req, res, next) => {
    try {
      const decision = String(req.body?.decision || '').trim().toLowerCase();
      const result = await resolveService(req).resolveApproval(
        req.params.approvalId,
        decision,
        getActor(req),
      );
      return res.json(result);
    } catch (error) {
      return respondAgentOpsError(res, error) ? undefined : next(error);
    }
  });

  return router;
}

module.exports = createAgentOpsRouter();
module.exports.createAgentOpsRouter = createAgentOpsRouter;
module.exports.requireAdminContext = requireAdminContext;

/**
 * Admin Dashboard API Routes
 * RESTful API for the Agent SDK Dashboard
 */

const express = require('express');
const router = express.Router();

// Controllers
const promptsController = require('./prompts.controller');
const modelsController = require('./models.controller');
const logsController = require('./logs.controller');
const skillsController = require('./skills.controller');
const tracesController = require('./traces.controller');
const settingsController = require('./settings.controller');
const podcastAudioController = require('./podcast-audio.controller');
const storageController = require('./storage.controller');
const DashboardController = require('./dashboard.controller');
const { setDashboardController } = require('../../admin/runtime-monitor');
const { buildLillyHistory } = require('../../admin/lilly-history');

// Dashboard controller is initialized with orchestrator in server.js
const getDashboardController = (req) => {
  if (!req.app.locals.dashboardController) {
    const controller = new DashboardController(req.app.locals.conversationOrchestrator || null);
    req.app.locals.dashboardController = controller;
    setDashboardController(controller);
  }

  return req.app.locals.dashboardController;
};
const callController = (controller, method) => (req, res, next) =>
  controller[method](req, res, next);

// API Routes

// Dashboard Overview
router.get('/stats', (req, res) => getDashboardController(req).getStats(req, res));
router.get('/health', (req, res) => getDashboardController(req).getHealth(req, res));
router.get('/activity', (req, res) => getDashboardController(req).getRecentActivity(req, res));
router.get('/lilly-history', async (_req, res, next) => {
  try {
    const history = await buildLillyHistory({
      cwd: process.cwd(),
      maxCount: 5000,
    });
    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
});

// Prompts Management
router.get('/prompts', callController(promptsController, 'getAll'));
router.get('/prompts/:id', callController(promptsController, 'getById'));
router.get('/prompts/:id/history', callController(promptsController, 'getHistory'));
router.post('/prompts', callController(promptsController, 'create'));
router.put('/prompts/:id', callController(promptsController, 'update'));
router.delete('/prompts/:id', callController(promptsController, 'remove'));
router.post('/prompts/:id/test', callController(promptsController, 'test'));

// Models Configuration
router.get('/models', callController(modelsController, 'getAll'));
router.get('/models/:id', callController(modelsController, 'getById'));
router.put('/models/:id', callController(modelsController, 'update'));
router.post('/models/:id/activate', callController(modelsController, 'activate'));
router.get('/models/usage/stats', callController(modelsController, 'getUsageStats'));

// Logs
router.get('/logs', callController(logsController, 'getAll'));
router.get('/logs/stream', callController(logsController, 'stream'));
router.get('/logs/:id', callController(logsController, 'getById'));
router.post('/logs/clear', callController(logsController, 'clear'));
router.get('/logs/export/:format', callController(logsController, 'export'));

// Skills
router.get('/skills', callController(skillsController, 'getAll'));
router.get('/skills/categories/list', callController(skillsController, 'getCategories'));
router.get('/skills/stats/overview', callController(skillsController, 'getStats'));
router.get('/skills/:id', callController(skillsController, 'getById'));
router.put('/skills/:id', callController(skillsController, 'update'));
router.post('/skills/:id/enable', callController(skillsController, 'enable'));
router.post('/skills/:id/disable', callController(skillsController, 'disable'));
router.post('/skills/:id/execute', callController(skillsController, 'execute'));
router.delete('/skills/:id', callController(skillsController, 'remove'));
router.get('/skills/search/query', callController(skillsController, 'search'));

// Traces
router.get('/traces', callController(tracesController, 'getAll'));
router.get('/traces/:id', callController(tracesController, 'getById'));
router.get('/traces/:id/timeline', callController(tracesController, 'getTimeline'));
router.delete('/traces/:id', callController(tracesController, 'remove'));
router.get('/traces/export/:format', callController(tracesController, 'export'));

// Settings
router.get('/settings', callController(settingsController, 'getAll'));
router.put('/settings', callController(settingsController, 'update'));
router.post('/settings/reset', callController(settingsController, 'reset'));
router.post('/settings/clear-cache', callController(settingsController, 'clearCache'));
router.post('/settings/privacy-pii/preview', callController(settingsController, 'previewPrivacyPii'));

// Podcast audio assets
router.get('/podcast-audio', callController(podcastAudioController, 'list'));
router.post('/podcast-audio/:track', callController(podcastAudioController, 'upload'));
router.delete('/podcast-audio/:track', callController(podcastAudioController, 'remove'));

// Managed artifact storage
router.get('/storage', callController(storageController, 'list'));
router.post('/storage/cleanup', callController(storageController, 'cleanup'));
router.post('/storage/bulk-delete', callController(storageController, 'bulkRemove'));
router.delete('/storage/:category/:id', callController(storageController, 'remove'));

// SDK Control
router.post('/sdk/execute', (req, res) => getDashboardController(req).executeTask(req, res));
router.post('/sdk/cancel/:taskId', (req, res) => getDashboardController(req).cancelTask(req, res));
router.get('/sdk/sessions', (req, res) => getDashboardController(req).getActiveSessions(req, res));
router.get('/sdk/session/:id', (req, res) => getDashboardController(req).getSessionDetails(req, res));
router.post('/sdk/session/:id/clear', (req, res) => getDashboardController(req).clearSession(req, res));

router.get('/workloads', async (req, res, next) => {
  try {
    const service = req.app.locals.agentWorkloadService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Deferred workloads require Postgres persistence' });
    }

    const workloads = await service.listAdminWorkloads(
      Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(Number(req.query.limit), 200)) : 100,
    );
    res.json({ success: true, data: workloads });
  } catch (error) {
    next(error);
  }
});

router.patch('/workloads/:id', async (req, res, next) => {
  try {
    const service = req.app.locals.agentWorkloadService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Deferred workloads require Postgres persistence' });
    }

    const workload = await service.updateAdminWorkload(req.params.id, req.body || {});
    if (!workload) {
      return res.status(404).json({ success: false, error: 'Workload not found' });
    }

    res.json({ success: true, data: workload });
  } catch (error) {
    next(error);
  }
});

router.post('/workloads/:id/pause', async (req, res, next) => {
  try {
    const service = req.app.locals.agentWorkloadService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Deferred workloads require Postgres persistence' });
    }

    const workload = await service.pauseAdminWorkload(req.params.id);
    if (!workload) {
      return res.status(404).json({ success: false, error: 'Workload not found' });
    }

    res.json({ success: true, data: workload });
  } catch (error) {
    next(error);
  }
});

router.post('/workloads/:id/resume', async (req, res, next) => {
  try {
    const service = req.app.locals.agentWorkloadService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Deferred workloads require Postgres persistence' });
    }

    const workload = await service.resumeAdminWorkload(req.params.id);
    if (!workload) {
      return res.status(404).json({ success: false, error: 'Workload not found' });
    }

    res.json({ success: true, data: workload });
  } catch (error) {
    next(error);
  }
});

router.delete('/workloads/:id', async (req, res, next) => {
  try {
    const service = req.app.locals.agentWorkloadService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Deferred workloads require Postgres persistence' });
    }

    const deleted = await service.deleteAdminWorkload(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Workload not found' });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.get('/managed-apps', async (req, res, next) => {
  try {
    const service = req.app.locals.managedAppService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Managed apps require Postgres persistence' });
    }

    const apps = await service.listApps(
      String(req.user?.username || '').trim() || null,
      Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(Number(req.query.limit), 200)) : 100,
    );
    res.json({ success: true, data: apps });
  } catch (error) {
    next(error);
  }
});

router.get('/managed-apps/:id', async (req, res, next) => {
  try {
    const service = req.app.locals.managedAppService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Managed apps require Postgres persistence' });
    }

    const result = await service.inspectApp(req.params.id, String(req.user?.username || '').trim() || null);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Managed app not found' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/managed-apps/:id/progress', async (req, res, next) => {
  try {
    const service = req.app.locals.managedAppService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Managed apps require Postgres persistence' });
    }

    const result = await service.getAppProgress(req.params.id, String(req.user?.username || '').trim() || null);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Managed app not found' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/runs', async (req, res, next) => {
  try {
    const service = req.app.locals.agentWorkloadService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Deferred workloads require Postgres persistence' });
    }

    const runs = await service.listAdminRuns(
      Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(Number(req.query.limit), 200)) : 100,
    );
    res.json({ success: true, data: runs });
  } catch (error) {
    next(error);
  }
});

router.get('/runs/:id', async (req, res, next) => {
  try {
    const service = req.app.locals.agentWorkloadService;
    if (!service?.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Deferred workloads require Postgres persistence' });
    }

    const run = await service.getRun(req.params.id);
    if (!run) {
      return res.status(404).json({ success: false, error: 'Run not found' });
    }

    res.json({ success: true, data: run });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

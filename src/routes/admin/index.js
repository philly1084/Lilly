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
const selfReflectionUpdatesController = require('./self-reflection-updates.controller');
const afterProcessAuditsController = require('./after-process-audits.controller');
const DashboardController = require('./dashboard.controller');
const { setDashboardController } = require('../../admin/runtime-monitor');
const { buildLillyHistory } = require('../../admin/lilly-history');
const { artifactService } = require('../../artifacts/artifact-service');
const { artifactStore } = require('../../artifacts/artifact-store');
const { assetManager } = require('../../asset-manager');

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

function getAgentCompanyMetadata(entry = {}) {
  return entry?.metadata?.agentCompany
    || entry?.workload?.metadata?.agentCompany
    || {};
}

function isAgentCompanyEntry(entry = {}, status = {}) {
  const metadata = getAgentCompanyMetadata(entry);
  const companyHash = status?.state?.companyGoalHash || status?.config?.companyGoalHash || '';
  return metadata.enabled === true
    || metadata.heartbeatManaged === true
    || Boolean(metadata.planItemId)
    || (companyHash && metadata.companyGoalHash === companyHash)
    || entry.sessionId === (status?.config?.sessionId || 'agent-company');
}

function extractRunOutputArtifacts(run = {}) {
  const output = run?.metadata?.output || {};
  const directArtifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  const outputArtifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
  return [...directArtifacts, ...outputArtifacts]
    .filter((artifact) => artifact && (artifact.id || artifact.filename || artifact.downloadUrl))
    .map((artifact) => ({
      id: artifact.id || null,
      filename: artifact.filename || artifact.name || artifact.id || 'business-output',
      mimeType: artifact.mimeType || artifact.mime_type || null,
      downloadUrl: artifact.downloadUrl || artifact.download_url || (artifact.id ? `/api/artifacts/${encodeURIComponent(artifact.id)}/download` : null),
      previewUrl: artifact.previewUrl || artifact.preview_url || null,
      sandboxUrl: artifact.sandboxUrl || artifact.sandbox_url || null,
      bundleDownloadUrl: artifact.bundleDownloadUrl || artifact.bundle_download_url || null,
      metadata: artifact.metadata || {},
    }));
}

function normalizeBusinessDeliverable(artifact = {}, context = {}) {
  const id = String(artifact.id || `${context.runId || 'run'}:${artifact.filename || 'output'}`).trim();
  const filename = String(artifact.filename || artifact.name || id).trim();
  const previewUrl = artifact.previewUrl || artifact.sandboxUrl || null;

  return {
    id,
    filename,
    title: String(artifact.metadata?.title || artifact.title || filename).trim(),
    mimeType: artifact.mimeType || null,
    format: artifact.format || artifact.extension || '',
    sizeBytes: Number(artifact.sizeBytes || 0),
    roleName: context.roleName || artifact.metadata?.agentCompany?.roleName || artifact.metadata?.roleName || '',
    workloadId: context.workloadId || artifact.workloadId || '',
    workloadTitle: context.workloadTitle || artifact.workloadTitle || '',
    runId: context.runId || artifact.runId || '',
    runStatus: context.runStatus || '',
    createdAt: artifact.createdAt || context.createdAt || null,
    updatedAt: artifact.updatedAt || artifact.createdAt || context.updatedAt || null,
    downloadUrl: artifact.downloadUrl || (artifact.id ? `/api/artifacts/${encodeURIComponent(artifact.id)}/download` : null),
    previewUrl,
    sandboxUrl: artifact.sandboxUrl || null,
    bundleDownloadUrl: artifact.bundleDownloadUrl || null,
    source: context.source || artifact.sourceMode || 'run-output',
  };
}

function dedupeBusinessDeliverables(deliverables = []) {
  const seen = new Set();
  return deliverables.filter((deliverable) => {
    const key = String(deliverable.id || deliverable.downloadUrl || deliverable.filename || '').trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function listAgentCompanyStoredArtifacts(sessionId = '') {
  if (!sessionId || !artifactService.isEnabled()) {
    return [];
  }

  try {
    const artifacts = await artifactStore.listBySession(sessionId);
    return artifacts
      .map((artifact) => artifactService.serializeArtifact(artifact))
      .filter(Boolean)
      .map((artifact) => normalizeBusinessDeliverable(artifact, {
        source: 'session-artifact',
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt || artifact.createdAt,
      }));
  } catch (error) {
    console.warn('[AdminAgentCompany] Failed to list company artifacts:', error.message);
    return [];
  }
}

function buildCompanyRunDeliverables(runs = [], workloads = []) {
  const workloadsById = new Map(workloads.map((workload) => [workload.id, workload]));
  return runs.flatMap((run) => {
    const workload = run.workload || workloadsById.get(run.workloadId) || {};
    const runMetadata = getAgentCompanyMetadata(run);
    const workloadMetadata = getAgentCompanyMetadata(workload);
    const metadata = Object.keys(runMetadata).length > 0 ? runMetadata : workloadMetadata;
    return extractRunOutputArtifacts(run).map((artifact) => normalizeBusinessDeliverable(artifact, {
      source: 'run-output',
      runId: run.id,
      runStatus: run.status,
      workloadId: run.workloadId || workload.id || '',
      workloadTitle: workload.title || run.workloadTitle || '',
      roleName: metadata.roleName || metadata.roleId || '',
      createdAt: run.finishedAt || run.updatedAt || run.createdAt,
      updatedAt: run.updatedAt || run.finishedAt || run.createdAt,
    }));
  });
}

function buildCeoActionQueue(status = {}, workloads = [], runs = [], deliverables = []) {
  const state = status?.state || {};
  const config = status?.config || {};
  const heartbeat = state.heartbeat || {};
  const dailyAlignment = state.dailyAlignment || {};
  const actions = [];
  const completedRunsWithoutDeliverables = runs.filter((run) => (
    run?.status === 'completed'
    && extractRunOutputArtifacts(run).length === 0
    && String(run?.metadata?.output?.text || run?.output || '').trim()
  ));

  if (!config.enabled || !String(config.companyGoal || state.companyGoal || '').trim()) {
    actions.push({
      id: 'configure-goal',
      label: 'Set the company goal',
      detail: 'Define what this autonomous business should create and maintain.',
      target: 'settings',
      priority: 'high',
    });
  }
  if (status?.available === true && workloads.length === 0 && config.enabled) {
    actions.push({
      id: 'run-heartbeat',
      label: 'Start the first work cycle',
      detail: 'Use Heartbeat Now to schedule role-based work from the company goal.',
      target: 'heartbeat',
      priority: 'high',
    });
  }
  if (runs.some((run) => run.status === 'failed') || Number(heartbeat.failedWorkloads || 0) > 0) {
    actions.push({
      id: 'review-failures',
      label: 'Review failed work',
      detail: 'Inspect failed runs before asking the company to continue.',
      target: 'runs',
      priority: 'medium',
    });
  }
  if (deliverables.length > 0) {
    actions.push({
      id: 'review-deliverables',
      label: 'Review business outputs',
      detail: `${deliverables.length} deliverable${deliverables.length === 1 ? '' : 's'} ready for preview or download.`,
      target: 'deliverables',
      priority: 'medium',
    });
  }
  if (deliverables.length === 0 && completedRunsWithoutDeliverables.length > 0) {
    actions.push({
      id: 'review-completed-output',
      label: 'Review completed work',
      detail: `${completedRunsWithoutDeliverables.length} completed run${completedRunsWithoutDeliverables.length === 1 ? '' : 's'} produced text output but no packaged file yet.`,
      target: 'runs',
      priority: 'medium',
    });
  }
  if (dailyAlignment.status && dailyAlignment.status !== 'steady' && dailyAlignment.status !== 'idle') {
    actions.push({
      id: 'read-alignment',
      label: 'Read alignment notes',
      detail: `Latest alignment state: ${dailyAlignment.status}.`,
      target: 'alignment',
      priority: 'low',
    });
  }

  return actions.slice(0, 6);
}

function buildRecursiveImprovementLoop(status = {}, workloads = [], runs = [], deliverables = []) {
  const state = status?.state || {};
  const config = status?.config || {};
  const heartbeat = state.heartbeat || {};
  const dailyAlignment = state.dailyAlignment || {};
  const schedule = Array.isArray(state.shortTermSchedule) ? state.shortTermSchedule : [];
  const running = runs.filter((run) => run.status === 'running').length;
  const queued = runs.filter((run) => run.status === 'queued').length;
  const failed = runs.filter((run) => run.status === 'failed').length + Number(heartbeat.failedWorkloads || 0);
  const completed = runs.filter((run) => run.status === 'completed').length;
  const appliedLearning = Array.isArray(dailyAlignment.applied) ? dailyAlignment.applied.length : 0;
  const goalReady = Boolean(config.enabled && String(config.companyGoal || state.companyGoal || '').trim());
  const workloadReady = status?.available === true;

  const phase = (id, label, ready, detail, blocked = false) => ({
    id,
    label,
    status: blocked ? 'blocked' : (ready ? 'ready' : 'waiting'),
    detail,
  });

  const phases = [
    phase(
      'sense',
      'Sense',
      deliverables.length > 0 || runs.length > 0 || workloads.length > 0,
      deliverables.length > 0
        ? `${deliverables.length} company file${deliverables.length === 1 ? '' : 's'} available for review.`
        : 'Waiting for company files, runs, or workload evidence.',
      !goalReady,
    ),
    phase(
      'plan',
      'Plan',
      schedule.length > 0,
      schedule.length > 0
        ? `${schedule.length} planned work item${schedule.length === 1 ? '' : 's'} in the current horizon.`
        : 'Run a heartbeat after setting the CEO goal to create a plan.',
      !goalReady,
    ),
    phase(
      'act',
      'Act',
      running + queued > 0 || completed > 0,
      running + queued > 0
        ? `${running} running and ${queued} queued company run${running + queued === 1 ? '' : 's'}.`
        : 'No active company runs are moving right now.',
      goalReady && !workloadReady,
    ),
    phase(
      'verify',
      'Verify',
      deliverables.length > 0 || completed > 0,
      failed > 0
        ? `${failed} failure${failed === 1 ? '' : 's'} need review before the next loop.`
        : `${completed} completed run${completed === 1 ? '' : 's'} and ${deliverables.length} deliverable${deliverables.length === 1 ? '' : 's'} ready for review.`,
      failed > 0,
    ),
    phase(
      'learn',
      'Learn',
      appliedLearning > 0 || dailyAlignment.status === 'steady',
      appliedLearning > 0
        ? `${appliedLearning} alignment update${appliedLearning === 1 ? '' : 's'} applied from recent evidence.`
        : `Alignment state is ${dailyAlignment.status || 'idle'}.`,
      false,
    ),
  ];

  return {
    goal: config.companyGoal || state.companyGoal || '',
    cadence: {
      heartbeatMinutes: Number(config.heartbeatMinutes || 0),
      dailyAlignment: dailyAlignment.nextAt || null,
      nextHeartbeat: heartbeat.nextAt || null,
    },
    metrics: {
      workloads: workloads.length,
      runs: runs.length,
      running,
      queued,
      failed,
      deliverables: deliverables.length,
      appliedLearning,
    },
    phases,
    health: phases.some((item) => item.status === 'blocked')
      ? 'blocked'
      : (phases.every((item) => item.status === 'ready') ? 'looping' : 'forming'),
  };
}

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

// Self-reflection update audit log
router.get('/self-reflection-updates/suggestions', callController(selfReflectionUpdatesController, 'listSuggestions'));
router.post('/self-reflection-updates/suggestions/:id/apply', callController(selfReflectionUpdatesController, 'applySuggestion'));
router.get('/self-reflection-updates', callController(selfReflectionUpdatesController, 'list'));

// After-process audit review
router.get('/after-process-audits', callController(afterProcessAuditsController, 'list'));
router.post('/after-process-audits/:id/clear', callController(afterProcessAuditsController, 'clearAudit'));
router.post('/after-process-audits/recommendations/:id/apply', callController(afterProcessAuditsController, 'applyFlagRecommendation'));

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

router.get('/agent-company', async (req, res, next) => {
  try {
    const service = req.app.locals.agentCompanyService;
    if (!service?.getStatus) {
      return res.status(503).json({ success: false, error: 'Agent company service is not initialized' });
    }

    const status = await service.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
});

router.get('/agent-company/workspace', async (req, res, next) => {
  try {
    const companyService = req.app.locals.agentCompanyService;
    if (!companyService?.getStatus) {
      return res.status(503).json({ success: false, error: 'Agent company service is not initialized' });
    }

    const status = await companyService.getStatus();
    const workloadService = req.app.locals.agentWorkloadService;
    const workloadAvailable = Boolean(workloadService?.isAvailable?.());
    let workloads = [];
    let runs = [];

    if (workloadAvailable) {
      const [allWorkloads, allRuns] = await Promise.all([
        workloadService.listAdminWorkloads(200),
        workloadService.listAdminRuns(200),
      ]);
      workloads = (Array.isArray(allWorkloads) ? allWorkloads : [])
        .filter((workload) => isAgentCompanyEntry(workload, status));
      const workloadIds = new Set(workloads.map((workload) => workload.id).filter(Boolean));
      runs = (Array.isArray(allRuns) ? allRuns : [])
        .filter((run) => workloadIds.has(run.workloadId) || isAgentCompanyEntry(run, status));
    }

    const sessionId = status?.config?.sessionId || 'agent-company';
    const deliverables = dedupeBusinessDeliverables([
      ...buildCompanyRunDeliverables(runs, workloads),
      ...await listAgentCompanyStoredArtifacts(sessionId),
    ]).sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''));
    const actionQueue = buildCeoActionQueue(status, workloads, runs, deliverables);
    const improvementLoop = buildRecursiveImprovementLoop(status, workloads, runs, deliverables);

    res.json({
      success: true,
      data: {
        status,
        workloads,
        runs,
        deliverables,
        actionQueue,
        improvementLoop,
        workspace: {
          sessionId,
          workloadAvailable,
          deliverableCount: deliverables.length,
          runCount: runs.length,
          workloadCount: workloads.length,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/agent-company/files', async (req, res, next) => {
  try {
    const companyService = req.app.locals.agentCompanyService;
    const status = companyService?.getStatus ? await companyService.getStatus() : null;
    const sessionId = status?.config?.sessionId || 'agent-company';
    const sourceType = ['artifact', 'workspace', 'research-bucket'].includes(String(req.query.sourceType || '').trim())
      ? String(req.query.sourceType).trim()
      : 'any';
    const limit = Number.isFinite(Number(req.query.limit))
      ? Math.max(1, Math.min(Number(req.query.limit), 50))
      : 25;
    const results = await assetManager.searchAssets({
      query: String(req.query.query || '').trim(),
      kind: 'document',
      sourceType,
      sessionId,
      includeContent: req.query.includeContent !== 'false',
      refresh: req.query.refresh === 'true',
      limit,
    }, {
      sessionId,
      ownerId: String(req.user?.username || req.user?.id || '').trim() || null,
      sessionIsolation: false,
    });
    const sourceCounts = results.results.reduce((counts, item) => {
      const key = item.sourceType || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});

    res.json({
      success: true,
      data: {
        ...results,
        sessionId,
        sourceCounts,
        fileManager: {
          status: 'ready',
          grepExamples: [
            'asset-search kind=document query="<words>" includeContent=true',
            'file-search pattern="**/*.{md,pdf,html,docx,txt}" cwd="."',
            'research-bucket-search query="<words>"',
          ],
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/agent-company/heartbeat', async (req, res, next) => {
  try {
    const service = req.app.locals.agentCompanyService;
    if (!service?.tick) {
      return res.status(503).json({ success: false, error: 'Agent company service is not initialized' });
    }

    const status = await service.tick({
      force: true,
      reason: String(req.body?.reason || 'admin').trim() || 'admin',
    });
    res.json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
});

router.post('/agent-company/daily-alignment', async (req, res, next) => {
  try {
    const service = req.app.locals.agentCompanyService;
    if (!service?.tick) {
      return res.status(503).json({ success: false, error: 'Agent company service is not initialized' });
    }

    const status = await service.tick({
      force: true,
      reason: String(req.body?.reason || 'daily-alignment-admin').trim() || 'daily-alignment-admin',
    });
    res.json({
      success: true,
      data: {
        dailyAlignment: status?.state?.dailyAlignment || null,
        status,
      },
    });
  } catch (error) {
    next(error);
  }
});

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

/**
 * Admin Dashboard API Routes
 * RESTful API for the Agent SDK Dashboard
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
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
const { getConfiguredStateDirectoryValue, getStateDirectory } = require('../../runtime-state-paths');
const { summarizeAgentQualityAssessments } = require('../../agent-quality-contract');

const CEO_ACTION_HISTORY_LIMIT = 24;

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

function getRequestOwnerId(req) {
  if (String(req.user?.role || '').trim().toLowerCase() === 'open') {
    return null;
  }
  return String(req.user?.username || req.user?.id || '').trim() || null;
}

function sanitizeProjectId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function getAgentCompanyProjects(config = {}) {
  const configured = Array.isArray(config.projects) ? config.projects.filter((project) => !project.archived) : [];
  if (configured.length > 0 || config.projectsInitialized === true) {
    return configured;
  }
  return [{
    id: 'main',
    name: 'Main project',
    sessionId: config.sessionId || 'agent-company',
    companyGoal: config.companyGoal || '',
    enabled: config.enabled === true,
    archived: false,
    createdAt: null,
    updatedAt: null,
  }];
}

function snapshotActiveAgentCompanyProject(config = {}, projects = [], now = new Date().toISOString()) {
  const activeId = config.activeProjectId
    || projects.find((project) => project.sessionId === config.sessionId)?.id
    || projects[0]?.id;
  return projects.map((project) => project.id === activeId ? {
    ...project,
    companyGoal: config.companyGoal || '',
    enabled: config.enabled === true,
    updatedAt: now,
  } : project);
}

async function saveAgentCompanyProjectConfig(config = {}) {
  if (typeof settingsController.updateAgentCompanySettings !== 'function') {
    throw new Error('Agent company project settings are unavailable');
  }
  return settingsController.updateAgentCompanySettings(config);
}

function getAgentCompanyMetadata(entry = {}) {
  return entry?.metadata?.agentCompany
    || entry?.workload?.metadata?.agentCompany
    || {};
}

function isAgentCompanyEntry(entry = {}, status = {}) {
  const metadata = getAgentCompanyMetadata(entry);
  const companyHash = status?.state?.companyGoalHash || status?.config?.companyGoalHash || '';
  const sessionId = status?.config?.sessionId || 'agent-company';
  if (entry.sessionId) {
    return entry.sessionId === sessionId;
  }
  return metadata.enabled === true
    || metadata.heartbeatManaged === true
    || Boolean(metadata.planItemId)
    || (companyHash && metadata.companyGoalHash === companyHash)
    || entry.sessionId === sessionId;
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
      preview: artifact.preview || null,
      metadata: artifact.metadata || {},
    }));
}

function stripHtmlForPreview(value = '') {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDeliverableFormat(artifact = {}) {
  const source = [
    artifact.format,
    artifact.extension,
    artifact.mimeType,
    artifact.filename,
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  if (/\b(html|text\/html)\b/.test(source) || /\.html?\b/.test(source)) return 'html';
  if (/\b(markdown|text\/markdown|md)\b/.test(source) || /\.md\b/.test(source)) return 'md';
  if (/\bpdf\b/.test(source) || /\.pdf\b/.test(source)) return 'pdf';
  if (/\bpptx|presentation\b/.test(source) || /\.pptx\b/.test(source)) return 'pptx';
  if (/\bxlsx|spreadsheet|excel\b/.test(source) || /\.xlsx\b/.test(source)) return 'xlsx';
  if (/\bjson\b/.test(source) || /\.json\b/.test(source)) return 'json';
  if (/\btext\/plain|txt\b/.test(source) || /\.txt\b/.test(source)) return 'txt';
  return String(artifact.format || artifact.extension || '').trim().toLowerCase();
}

function buildDeliverablePreview(artifact = {}) {
  const preview = artifact.preview && typeof artifact.preview === 'object' ? artifact.preview : null;
  const previewKind = String(preview?.type || '').trim().toLowerCase();
  const previewText = preview?.content
    ? stripHtmlForPreview(preview.content)
    : stripHtmlForPreview(artifact.previewText || artifact.contentPreview || artifact.extractedText || artifact.summary || '');

  return {
    previewKind: previewKind || (previewText ? 'text' : ''),
    previewText: previewText.length > 520 ? `${previewText.slice(0, 519).trimEnd()}...` : previewText,
  };
}

function normalizeBusinessDeliverable(artifact = {}, context = {}) {
  const id = String(artifact.id || `${context.runId || 'run'}:${artifact.filename || 'output'}`).trim();
  const filename = String(artifact.filename || artifact.name || id).trim();
  const previewUrl = artifact.previewUrl || artifact.sandboxUrl || null;
  const format = normalizeDeliverableFormat(artifact);
  const readableFormats = new Set(['md', 'html', 'pdf', 'txt']);
  const formatLabel = format
    ? (format === 'md' ? 'Markdown' : format.toUpperCase())
    : 'Document';
  const preview = buildDeliverablePreview(artifact);

  return {
    id,
    filename,
    title: String(artifact.metadata?.title || artifact.title || filename).trim(),
    mimeType: artifact.mimeType || null,
    format,
    formatLabel,
    isTextHeavy: readableFormats.has(format) || Boolean(preview.previewText),
    previewKind: preview.previewKind,
    previewText: preview.previewText,
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

function normalizeRunOutputPreview(run = {}, maxLength = 220) {
  const raw = String(run?.metadata?.output?.text || run?.output || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return '';
  }

  return raw.length > maxLength ? `${raw.slice(0, maxLength - 1).trimEnd()}...` : raw;
}

function getAgentCompanyActionHistoryPath(sessionId = 'agent-company') {
  const normalizedSessionId = String(sessionId || 'agent-company').trim() || 'agent-company';
  if (normalizedSessionId === 'agent-company') {
    return path.join(getStateDirectory(), 'agent-company', 'ceo-action-history.json');
  }
  return path.join(
    getStateDirectory(),
    'agent-company',
    'projects',
    sanitizeProjectId(normalizedSessionId) || 'agent-company',
    'ceo-action-history.json',
  );
}

function getActionLookupKey(action = {}) {
  return String(action.actionKey || action.id || '').trim();
}

function normalizeCeoActionSnapshot(action = {}, snapshotAt = new Date().toISOString()) {
  const actionKey = getActionLookupKey(action);
  if (!actionKey) {
    return null;
  }

  return {
    id: String(action.id || actionKey),
    actionKey,
    label: String(action.label || 'Company action'),
    detail: String(action.detail || ''),
    target: String(action.target || ''),
    priority: String(action.priority || 'low'),
    ...(action.runId ? { runId: action.runId } : {}),
    ...(action.outputPreview ? { outputPreview: action.outputPreview } : {}),
    ...(action.workloadReason ? { workloadReason: action.workloadReason } : {}),
    ...(action.workloadFocus ? { workloadFocus: action.workloadFocus } : {}),
    ...(action.refreshStatus ? { refreshStatus: action.refreshStatus } : {}),
    ...(action.qualitySummary ? { qualitySummary: action.qualitySummary } : {}),
    snapshotAt,
  };
}

async function readCeoActionHistory(sessionId = 'agent-company') {
  try {
    const raw = await fs.readFile(getAgentCompanyActionHistoryPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.actions) ? parsed.actions : [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[Admin] Failed to read Agent Company action history:', error.message);
    }
    return [];
  }
}

async function writeCeoActionHistory(actions = [], sessionId = 'agent-company') {
  const historyPath = getAgentCompanyActionHistoryPath(sessionId);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  const tempPath = `${historyPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify({ actions }, null, 2), 'utf8');
  await fs.rename(tempPath, historyPath);
}

async function snapshotCeoActions(actions = [], sessionId = 'agent-company') {
  if (process.env.NODE_ENV === 'test' && !getConfiguredStateDirectoryValue()) {
    return;
  }

  const now = new Date().toISOString();
  const snapshots = (Array.isArray(actions) ? actions : [])
    .map((action) => normalizeCeoActionSnapshot(action, now))
    .filter(Boolean);

  if (!snapshots.length) {
    return;
  }

  try {
    const byKey = new Map();
    snapshots.forEach((action) => byKey.set(action.actionKey, action));
    const existing = await readCeoActionHistory(sessionId);
    existing.forEach((action) => {
      const actionKey = getActionLookupKey(action);
      if (actionKey && !byKey.has(actionKey)) {
        byKey.set(actionKey, action);
      }
    });
    await writeCeoActionHistory(Array.from(byKey.values()).slice(0, CEO_ACTION_HISTORY_LIMIT), sessionId);
  } catch (error) {
    console.warn('[Admin] Failed to snapshot Agent Company action history:', error.message);
  }
}

async function listRecentCeoActionHistory(limit = 6, sessionId = 'agent-company') {
  const seen = new Set();
  return (await readCeoActionHistory(sessionId))
    .filter((action) => {
      const actionKey = getActionLookupKey(action);
      if (!actionKey || seen.has(actionKey)) {
        return false;
      }
      seen.add(actionKey);
      return true;
    })
    .slice(0, limit);
}

function summarizeCeoActionHistory(actions = []) {
  const summary = {
    total: 0,
    reviewable: 0,
    referenceOnly: 0,
    newestSnapshotAt: null,
    oldestSnapshotAt: null,
  };

  (Array.isArray(actions) ? actions : []).forEach((action) => {
    summary.total += 1;
    if (action?.runId || action?.refreshStatus?.runId) {
      summary.reviewable += 1;
    } else {
      summary.referenceOnly += 1;
    }

    const snapshotAt = String(action?.snapshotAt || '').trim();
    const timestamp = Date.parse(snapshotAt);
    if (!Number.isFinite(timestamp)) {
      return;
    }

    if (!summary.newestSnapshotAt || timestamp > Date.parse(summary.newestSnapshotAt)) {
      summary.newestSnapshotAt = snapshotAt;
    }
    if (!summary.oldestSnapshotAt || timestamp < Date.parse(summary.oldestSnapshotAt)) {
      summary.oldestSnapshotAt = snapshotAt;
    }
  });

  return summary;
}

function normalizeCeoActionHistoryLimit(value, defaultLimit = 12) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultLimit;
  }
  return Math.min(parsed, CEO_ACTION_HISTORY_LIMIT);
}

function findCeoAction(actions = [], actionKey = '') {
  const targetKey = String(actionKey || '').trim();
  if (!targetKey) {
    return null;
  }

  return (Array.isArray(actions) ? actions : []).find((candidate) => {
    const key = getActionLookupKey(candidate);
    const id = String(candidate.id || '').trim();
    return key === targetKey || id === targetKey;
  }) || null;
}

function hasCompletedTextOutputWithoutDeliverables(run = {}) {
  return run?.status === 'completed'
    && extractRunOutputArtifacts(run).length === 0
    && String(run?.metadata?.output?.text || run?.output || '').trim();
}

function extractRunAgentQuality(run = {}) {
  const candidates = [
    run.agentQuality,
    run.metadata?.agentQuality,
    run.metadata?.remoteCliAgent?.agentQuality,
    run.metadata?.activeProject?.remoteCliAgent?.agentQuality,
    run.result?.agentQuality,
    run.result?.data?.agentQuality,
    run.trace?.agentQuality,
    run.trace?.metadata?.agentQuality,
    run.trace?.result?.agentQuality,
    run.trace?.result?.data?.agentQuality,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)) || null;
}

function buildAgentQualityRepairAction(runs = []) {
  const qualitySummary = summarizeAgentQualityAssessments(
    (Array.isArray(runs) ? runs : []).map(extractRunAgentQuality).filter(Boolean),
  );
  if (!qualitySummary.total) {
    return null;
  }

  const statusCounts = qualitySummary.statusCounts || {};
  const weakCount = Number(statusCounts.partial || 0)
    + Number(statusCounts.blocked || 0)
    + Number(statusCounts.needs_work || 0);
  if (weakCount <= 0) {
    return null;
  }

  const score = Number(qualitySummary.averageScore);
  const scoreLabel = Number.isFinite(score) ? `${Math.round(score * 100)}%` : 'unscored';
  const missing = (qualitySummary.topMissingGates || [])
    .slice(0, 3)
    .map((entry) => `${entry.id} (${entry.count})`)
    .join(', ');
  const blockedOrNeedsWork = Number(statusCounts.blocked || 0) + Number(statusCounts.needs_work || 0);

  return {
    id: 'repair-agent-quality-gates',
    actionKey: 'repair-agent-quality-gates',
    label: 'Repair agent quality gates',
    detail: `${weakCount} scored agent run${weakCount === 1 ? '' : 's'} need better proof. Average quality is ${scoreLabel}${missing ? `; top missing gates: ${missing}` : ''}. Review Traces before scheduling more document, website, or deployment work.`,
    target: 'traces',
    priority: blockedOrNeedsWork > 0 ? 'high' : 'medium',
    qualitySummary,
  };
}

function buildCeoActionQueue(status = {}, workloads = [], runs = [], deliverables = []) {
  const state = status?.state || {};
  const config = status?.config || {};
  const heartbeat = state.heartbeat || {};
  const dailyAlignment = state.dailyAlignment || {};
  const actions = [];
  const completedRunsWithoutDeliverables = runs.filter(hasCompletedTextOutputWithoutDeliverables);
  const failedRuns = runs.filter((run) => run.status === 'failed');
  const latestFailedRun = failedRuns
    .filter((run) => String(run?.id || '').trim())
    .sort((a, b) => getEntryTimestamp(b) - getEntryTimestamp(a))[0] || null;
  const latestFailedRunId = String(latestFailedRun?.id || '').trim();

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
  if (failedRuns.length > 0 || Number(heartbeat.failedWorkloads || 0) > 0) {
    actions.push({
      id: 'review-failures',
      actionKey: latestFailedRunId ? `review-failures:${latestFailedRunId}` : 'review-failures',
      label: 'Review failed work',
      detail: 'Inspect failed runs before asking the company to continue.',
      target: 'runs',
      priority: 'medium',
      ...(latestFailedRunId ? { runId: latestFailedRunId } : {}),
    });
  }
  const qualityRepairAction = buildAgentQualityRepairAction(runs);
  if (qualityRepairAction) {
    actions.push(qualityRepairAction);
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
    const previewRun = completedRunsWithoutDeliverables[0];
    actions.push({
      id: 'review-completed-output',
      actionKey: `review-completed-output:${previewRun.id || 'latest'}`,
      label: 'Review completed work',
      detail: `${completedRunsWithoutDeliverables.length} completed run${completedRunsWithoutDeliverables.length === 1 ? '' : 's'} produced text output but no packaged file yet.`,
      target: 'runs',
      priority: 'medium',
      runId: previewRun.id || null,
      outputPreview: normalizeRunOutputPreview(previewRun),
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

function getEntryTimestamp(entry = {}) {
  return Date.parse(entry.updatedAt || entry.finishedAt || entry.startedAt || entry.createdAt || '') || 0;
}

function buildSharedWhiteboardRefreshStatus(workloads = [], runs = [], workloadFocus = '') {
  const focusPath = normalizeWorkspaceRelativePath(workloadFocus);
  const refreshWorkloads = (Array.isArray(workloads) ? workloads : [])
    .filter((workload) => {
      const metadata = getAgentCompanyMetadata(workload);
      const reason = String(metadata.workloadReason || '').trim();
      const focus = normalizeWorkspaceRelativePath(metadata.workloadFocus || workload?.metadata?.longAgent?.sharedWhiteboardFile || '');
      return reason === 'shared-whiteboard-refresh'
        && (!focusPath || !focus || focus === focusPath);
    })
    .sort((a, b) => getEntryTimestamp(b) - getEntryTimestamp(a));

  const workload = refreshWorkloads[0] || null;
  if (!workload) {
    return null;
  }

  const run = (Array.isArray(runs) ? runs : [])
    .filter((candidate) => candidate.workloadId === workload.id)
    .sort((a, b) => getEntryTimestamp(b) - getEntryTimestamp(a))[0] || null;

  return {
    workloadId: workload.id || null,
    title: workload.title || 'Shared whiteboard refresh',
    status: workload.status || workload.workloadSummary?.status || 'scheduled',
    runId: run?.id || null,
    runStatus: run?.status || null,
    updatedAt: run?.updatedAt || run?.finishedAt || workload.updatedAt || workload.createdAt || null,
  };
}

function appendSharedWhiteboardAction(actions = [], sharedWhiteboard = {}, workloads = [], runs = []) {
  const nextActions = Array.isArray(actions) ? [...actions] : [];
  const current = sharedWhiteboard?.current || null;
  const planned = sharedWhiteboard?.planned || null;
  const previewStatus = String(current?.filePreview?.status || '').trim();
  const needsRefresh = !current || ['missing', 'empty', 'unavailable'].includes(previewStatus);

  if (!needsRefresh) {
    return nextActions.slice(0, 6);
  }

  const workloadFocus = current?.path || planned?.path || '.kimibuilt/agent-company/current-whiteboard.md';
  const refreshStatus = buildSharedWhiteboardRefreshStatus(workloads, runs, workloadFocus);

  nextActions.push({
    id: 'refresh-shared-whiteboard',
    actionKey: `refresh-shared-whiteboard:${workloadFocus}`,
    label: 'Refresh shared whiteboard',
    detail: current
      ? `${current.path} needs current coordination notes before scheduling more company work.`
      : `${workloadFocus} needs to be attached with current coordination notes before scheduling more company work.`,
    target: 'whiteboard-refresh',
    workloadReason: 'shared-whiteboard-refresh',
    workloadFocus,
    ...(refreshStatus ? { refreshStatus } : {}),
    priority: current ? 'medium' : 'high',
  });

  return nextActions.slice(0, 6);
}

async function buildAgentCompanyWorkspacePayload(req) {
  const companyService = req.app.locals.agentCompanyService;
  if (!companyService?.getStatus) {
    const error = new Error('Agent company service is not initialized');
    error.status = 503;
    throw error;
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
  const improvementLoop = buildRecursiveImprovementLoop(status, workloads, runs, deliverables);
  const sharedWhiteboard = await attachSharedWhiteboardPreview(
    buildSharedWhiteboardStatus(status, workloads),
    {
      assetManager,
      sessionId,
      ownerId: getRequestOwnerId(req),
    },
  );
  const actionQueue = appendSharedWhiteboardAction(
    buildCeoActionQueue(status, workloads, runs, deliverables),
    sharedWhiteboard,
    workloads,
    runs,
  );
  await snapshotCeoActions(actionQueue, sessionId);
  const actionHistory = await listRecentCeoActionHistory(6, sessionId);

  return {
    status,
    workloads,
    runs,
    deliverables,
    actionQueue,
    actionHistory,
    improvementLoop,
    sharedWhiteboard,
    workspace: {
      sessionId,
      workloadAvailable,
      deliverableCount: deliverables.length,
      runCount: runs.length,
      workloadCount: workloads.length,
    },
  };
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
  const completedTextOutputs = runs.filter(hasCompletedTextOutputWithoutDeliverables).length;
  const appliedLearning = Array.isArray(dailyAlignment.applied) ? dailyAlignment.applied.length : 0;
  const goalReady = Boolean(config.enabled && String(config.companyGoal || state.companyGoal || '').trim());
  const workloadReady = status?.available === true;
  let senseDetail = 'Waiting for company files, runs, or workload evidence.';
  if (deliverables.length > 0) {
    senseDetail = `${deliverables.length} company file${deliverables.length === 1 ? '' : 's'} available for review.`;
  } else if (completedTextOutputs > 0) {
    senseDetail = `${completedTextOutputs} completed text output${completedTextOutputs === 1 ? '' : 's'} available for CEO review before packaging.`;
  } else if (runs.length > 0 || workloads.length > 0) {
    senseDetail = `${runs.length} run${runs.length === 1 ? '' : 's'} and ${workloads.length} workload${workloads.length === 1 ? '' : 's'} available for inspection.`;
  }

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
      senseDetail,
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

function buildSharedWhiteboardStatus(status = {}, workloads = []) {
  const state = status?.state || {};
  const schedule = Array.isArray(state.shortTermSchedule) ? state.shortTermSchedule : [];
  const whiteboards = new Map();

  (Array.isArray(workloads) ? workloads : []).forEach((workload) => {
    const metadata = getAgentCompanyMetadata(workload);
    const whiteboard = metadata.sharedWhiteboard || {};
    const path = String(whiteboard.path || workload?.metadata?.longAgent?.sharedWhiteboardFile || '').trim();
    if (!path) {
      return;
    }
    const existing = whiteboards.get(path) || {
      path,
      purpose: String(whiteboard.purpose || 'agent-to-agent weekly coordination'),
      sections: Array.isArray(whiteboard.sections) ? whiteboard.sections.filter(Boolean).slice(0, 12) : [],
      workloadCount: 0,
      roleNames: [],
      weekKey: metadata.weekKey || '',
    };
    existing.workloadCount += 1;
    const roleName = String(metadata.roleName || metadata.roleId || '').trim();
    if (roleName && !existing.roleNames.includes(roleName)) {
      existing.roleNames.push(roleName);
    }
    if (!existing.weekKey && metadata.weekKey) {
      existing.weekKey = metadata.weekKey;
    }
    whiteboards.set(path, existing);
  });

  const items = Array.from(whiteboards.values())
    .sort((a, b) => String(b.weekKey || '').localeCompare(String(a.weekKey || '')));
  const current = items[0] || null;
  const planned = current ? null : getPlannedWhiteboard(status);

  return {
    status: current ? 'ready' : 'missing',
    detail: current
      ? `${current.workloadCount} workload${current.workloadCount === 1 ? '' : 's'} carrying the shared whiteboard contract.`
      : 'No shared whiteboard metadata is attached to current company workloads yet.',
    current,
    planned,
    count: items.length,
    plannedWorkCount: schedule.length,
  };
}

function getWeekKeyFromDate(value = new Date()) {
  const current = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(current.getTime())) {
    return '';
  }
  const day = current.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  current.setUTCDate(current.getUTCDate() + diff);
  current.setUTCHours(0, 0, 0, 0);
  return current.toISOString().slice(0, 10);
}

function getPlannedWhiteboard(status = {}) {
  const state = status?.state || {};
  const schedule = Array.isArray(state.shortTermSchedule) ? state.shortTermSchedule : [];
  const scheduledWeek = schedule
    .map((item) => String(item?.weekKey || '').trim())
    .find(Boolean);
  const referenceDate = state.heartbeat?.lastAt
    || state.updatedAt
    || state.heartbeat?.nextAt
    || new Date();
  const weekKey = scheduledWeek || getWeekKeyFromDate(referenceDate) || 'current';

  return {
    path: `.kimibuilt/agent-company/${weekKey}-whiteboard.md`,
    purpose: 'agent-to-agent weekly coordination',
    sections: [
      'Claims checked',
      'Decisions made',
      'Files/artifacts changed',
      'Deployment/DNS state',
      'Blockers',
      'Next agent task',
    ],
    workloadCount: 0,
    roleNames: [],
    weekKey,
  };
}

function normalizeWorkspaceRelativePath(value = '') {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

async function attachSharedWhiteboardPreview(whiteboard = {}, options = {}) {
  const current = whiteboard?.current || null;
  const whiteboardPath = String(current?.path || '').trim();
  if (!whiteboardPath || !options.assetManager?.searchAssets) {
    return whiteboard;
  }

  const expectedPath = normalizeWorkspaceRelativePath(whiteboardPath);
  const query = path.basename(whiteboardPath) || whiteboardPath;
  let results;
  try {
    results = await options.assetManager.searchAssets({
      query,
      kind: 'document',
      sourceType: 'workspace',
      includeContent: true,
      refresh: false,
      limit: 10,
    }, {
      sessionId: options.sessionId || null,
      ownerId: options.ownerId || null,
      sessionIsolation: false,
    });
  } catch (error) {
    return {
      ...whiteboard,
      current: {
        ...current,
        filePreview: {
          status: 'unavailable',
          detail: `Whiteboard file index unavailable: ${error.message || 'unknown error'}`,
        },
      },
    };
  }
  const match = (Array.isArray(results?.results) ? results.results : [])
    .find((item) => normalizeWorkspaceRelativePath(item.relativePath || item.filename || '') === expectedPath);

  if (!match) {
    return {
      ...whiteboard,
      current: {
        ...current,
        filePreview: {
          status: 'missing',
          detail: 'Whiteboard file is not in the indexed company file room yet.',
        },
      },
    };
  }

  const preview = normalizeRunOutputPreview({ metadata: { output: { text: match.contentPreview || '' } } }, 420);
  return {
    ...whiteboard,
    current: {
      ...current,
      filePreview: {
        status: preview ? 'ready' : 'empty',
        detail: preview ? 'Indexed whiteboard preview is available.' : 'Whiteboard file is indexed but has no text preview yet.',
        sourceType: match.sourceType || 'workspace',
        relativePath: match.relativePath || whiteboardPath,
        updatedAt: match.updatedAt || null,
        sizeBytes: Number(match.sizeBytes || 0),
        preview,
      },
    },
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
    const payload = await buildAgentCompanyWorkspacePayload(req);
    res.json({ success: true, data: payload });
  } catch (error) {
    if (error.status === 503) {
      return res.status(503).json({ success: false, error: error.message });
    }
    next(error);
  }
});

router.get('/agent-company/projects', async (req, res, next) => {
  try {
    const config = settingsController.getEffectiveAgentCompanyConfig();
    const projects = getAgentCompanyProjects(config);
    const activeProjectId = config.activeProjectId
      || projects.find((project) => project.sessionId === config.sessionId)?.id
      || projects[0]?.id;
    const workloadService = req.app.locals.agentWorkloadService;
    let workloads = [];
    let runs = [];
    let sessionSummaries = {};
    if (workloadService?.isAvailable?.()) {
      [workloads, runs, sessionSummaries] = await Promise.all([
        workloadService.listAdminWorkloads(500),
        workloadService.listAdminRuns(500),
        typeof workloadService.getSessionSummaries === 'function'
          ? workloadService.getSessionSummaries(projects.map((project) => project.sessionId))
          : {},
      ]);
    }
    res.json({
      success: true,
      data: {
        activeProjectId,
        projects: projects.map((project) => {
          const summary = sessionSummaries?.[project.sessionId];
          const activeRunCount = summary
            ? Number(summary.queued || 0) + Number(summary.running || 0)
            : runs.filter((run) => (
              run.sessionId === project.sessionId
              && ['queued', 'running'].includes(String(run.status || '').trim().toLowerCase())
            )).length;
          return {
            ...project,
            workloadCount: workloads.filter((workload) => workload.sessionId === project.sessionId).length,
            runCount: runs.filter((run) => run.sessionId === project.sessionId).length,
            activeRunCount,
          };
        }),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/agent-company/projects', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) {
      return res.status(400).json({ success: false, error: 'Project name is required' });
    }
    const now = new Date().toISOString();
    const config = settingsController.getEffectiveAgentCompanyConfig();
    const projects = snapshotActiveAgentCompanyProject(config, getAgentCompanyProjects(config), now);
    const baseId = sanitizeProjectId(name) || 'project';
    let id = baseId;
    let suffix = 2;
    while (projects.some((project) => project.id === id)) {
      id = `${baseId}-${suffix++}`.slice(0, 80);
    }
    const sessionId = `agent-company-${id}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 120);
    const project = {
      id,
      name,
      sessionId,
      companyGoal: String(req.body?.companyGoal || '').trim().slice(0, 4000),
      enabled: req.body?.enabled === true,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    const nextConfig = await saveAgentCompanyProjectConfig({
      ...config,
      activeProjectId: id,
      projects: [...projects, project],
      sessionId,
      companyGoal: project.companyGoal,
      enabled: project.enabled,
    });
    res.status(201).json({ success: true, data: { project, config: nextConfig } });
  } catch (error) {
    next(error);
  }
});

router.post('/agent-company/projects/:id/activate', async (req, res, next) => {
  try {
    const targetId = sanitizeProjectId(req.params.id);
    const now = new Date().toISOString();
    const config = settingsController.getEffectiveAgentCompanyConfig();
    const projects = snapshotActiveAgentCompanyProject(config, getAgentCompanyProjects(config), now);
    const project = projects.find((candidate) => candidate.id === targetId && !candidate.archived);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Agent company project was not found' });
    }
    const nextConfig = await saveAgentCompanyProjectConfig({
      ...config,
      activeProjectId: project.id,
      projects,
      sessionId: project.sessionId,
      companyGoal: project.companyGoal || '',
      enabled: project.enabled === true,
    });
    res.json({ success: true, data: { project, config: nextConfig } });
  } catch (error) {
    next(error);
  }
});

router.delete('/agent-company/projects/:id', async (req, res, next) => {
  try {
    const targetId = sanitizeProjectId(req.params.id);
    const now = new Date().toISOString();
    const config = settingsController.getEffectiveAgentCompanyConfig();
    const projects = snapshotActiveAgentCompanyProject(config, getAgentCompanyProjects(config), now);
    const activeProjectId = config.activeProjectId
      || projects.find((project) => project.sessionId === config.sessionId)?.id
      || projects[0]?.id;
    const project = projects.find((candidate) => candidate.id === targetId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Agent company project was not found' });
    }
    const fallbackProject = projects.find((candidate) => candidate.id !== targetId);
    if (!fallbackProject) {
      return res.status(409).json({ success: false, error: 'Keep at least one Agent Company project' });
    }
    const workloadService = req.app.locals.agentWorkloadService;
    if (!workloadService?.isAvailable?.() || typeof workloadService.getSessionSummaries !== 'function') {
      return res.status(503).json({
        success: false,
        error: 'Agent Company run state is unavailable; project archival was not attempted',
      });
    }
    let activeRunCount = 0;
    if (typeof workloadService?.getSessionSummaries === 'function') {
      const summaries = await workloadService.getSessionSummaries([project.sessionId]);
      const summary = summaries?.[project.sessionId] || {};
      activeRunCount = Number(summary.queued || 0) + Number(summary.running || 0);
    }
    if (activeRunCount > 0) {
      return res.status(409).json({
        success: false,
        error: `Finish or cancel ${activeRunCount} active run${activeRunCount === 1 ? '' : 's'} before archiving ${project.name}`,
        data: {
          projectId: project.id,
          activeRunCount,
        },
      });
    }
    const nextProjects = projects.map((project) => project.id === targetId
      ? { ...project, archived: true, updatedAt: now }
      : project);
    const nextActiveProject = activeProjectId === targetId
      ? fallbackProject
      : projects.find((candidate) => candidate.id === activeProjectId) || fallbackProject;
    await saveAgentCompanyProjectConfig({
      ...config,
      projects: nextProjects,
      activeProjectId: nextActiveProject.id,
      sessionId: nextActiveProject.sessionId,
      companyGoal: nextActiveProject.companyGoal || '',
      enabled: nextActiveProject.enabled === true,
    });
    res.json({
      success: true,
      data: {
        archivedProjectId: targetId,
        activeProjectId: nextActiveProject.id,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/agent-company/action-history', async (req, res, next) => {
  try {
    const limit = normalizeCeoActionHistoryLimit(req.query.limit);
    const status = await req.app.locals.agentCompanyService?.getStatus?.();
    const sessionId = status?.config?.sessionId || 'agent-company';
    const actions = await listRecentCeoActionHistory(limit, sessionId);
    res.json({
      success: true,
      data: {
        actions,
        summary: summarizeCeoActionHistory(actions),
        limit,
        maxLimit: CEO_ACTION_HISTORY_LIMIT,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/agent-company/action-history', async (req, res, next) => {
  try {
    const status = await req.app.locals.agentCompanyService?.getStatus?.();
    const sessionId = status?.config?.sessionId || 'agent-company';
    await writeCeoActionHistory([], sessionId);
    res.json({ success: true, data: { cleared: true, sessionId } });
  } catch (error) {
    next(error);
  }
});

router.get('/agent-company/action', async (req, res, next) => {
  try {
    const actionKey = String(req.query.actionKey || req.query.key || '').trim();
    if (!actionKey) {
      return res.status(400).json({ success: false, error: 'actionKey is required' });
    }

    const payload = await buildAgentCompanyWorkspacePayload(req);
    const action = findCeoAction(payload.actionQueue, actionKey);

    if (!action) {
      const sessionId = payload?.workspace?.sessionId || 'agent-company';
      const historicalAction = findCeoAction(await readCeoActionHistory(sessionId), actionKey);
      if (!historicalAction) {
        return res.status(404).json({ success: false, error: 'Agent company action was not found' });
      }
      return res.json({ success: true, data: { action: historicalAction, historical: true } });
    }

    res.json({ success: true, data: { action, historical: false } });
  } catch (error) {
    if (error.status === 503) {
      return res.status(503).json({ success: false, error: error.message });
    }
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
      ownerId: getRequestOwnerId(req),
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

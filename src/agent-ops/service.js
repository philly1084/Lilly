'use strict';

const crypto = require('crypto');
const { buildAgentMessages } = require('./messages');
const { isRemoteExecutionPending } = require('../workloads/long-agent-mode');
const { AGENT_RUN_SURFACE } = require('../agent-runs/constants');

const ACTIVE_RUN_STATES = new Set([
  'created',
  'planning',
  'executing',
  'verifying',
  'queued',
  'running',
]);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);

function createAgentOpsError(message, statusCode = 400, code = 'agent_ops_error') {
  const error = new Error(message);
  error.status = statusCode;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value = '', maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sanitizeProjectId(value = '') {
  return cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function listProjects(config = {}, { includeArchived = false, includeLegacy = true } = {}) {
  const configured = asArray(config.projects)
    .filter((project) => includeArchived || project.archived !== true);
  if (configured.length > 0 || config.projectsInitialized === true || !includeLegacy) {
    return configured;
  }
  return [{
    id: 'main',
    name: 'Main project',
    sessionId: cleanText(config.sessionId, 120) || 'agent-company',
    companyGoal: cleanText(config.companyGoal, 4000),
    enabled: config.enabled === true,
    archived: false,
    createdAt: null,
    updatedAt: null,
  }];
}

function findActiveProject(config = {}, projects = listProjects(config)) {
  const activeProjectId = cleanText(config.activeProjectId, 160);
  const sessionId = cleanText(config.sessionId, 160);
  return projects.find((project) => project.id === activeProjectId)
    || projects.find((project) => project.sessionId === sessionId)
    || projects[0]
    || null;
}

function snapshotActiveProject(config = {}, projects = listProjects(config), now = new Date().toISOString()) {
  const activeProject = findActiveProject(config, projects);
  return projects.map((project) => project.id === activeProject?.id ? {
    ...project,
    companyGoal: cleanText(config.companyGoal, 4000),
    enabled: config.enabled === true,
    updatedAt: now,
  } : project);
}

function timestampValue(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function secondsSince(value, now) {
  const timestamp = timestampValue(value);
  return timestamp ? Math.max(0, Math.floor((now.getTime() - timestamp) / 1000)) : null;
}

function durationSeconds(start, end, now) {
  const startValue = timestampValue(start);
  if (!startValue) return null;
  const endValue = timestampValue(end) || now.getTime();
  return Math.max(0, Math.floor((endValue - startValue) / 1000));
}

function getCompanyMetadata(value = {}) {
  return asObject(value?.metadata?.agentCompany || value?.workload?.metadata?.agentCompany);
}

function getCanonicalWorkloadRunId(run = {}) {
  const snapshot = asObject(run.snapshot);
  const details = asObject(snapshot.legacyDetails);
  return cleanText(
    details.workloadRunId
      || details.runId
      || snapshot.sourceId
      || snapshot.legacySourceId,
    160,
  );
}

function getCanonicalWorkloadId(run = {}) {
  return cleanText(asObject(run.snapshot)?.legacyDetails?.workloadId, 160);
}

function normalizeRunStatus(value = '') {
  const status = cleanText(value, 80).toLowerCase().replace(/[\s-]+/g, '_');
  return status || 'idle';
}

function normalizeEvidence(value = {}, fallbackType = 'evidence') {
  const source = asObject(value);
  const id = cleanText(source.id || source.digest || source.artifactId || source.filename, 240);
  const label = cleanText(
    source.title || source.label || source.filename || source.name || source.kind || source.type || id,
    300,
  );
  const url = cleanText(
    source.previewUrl || source.preview_url || source.downloadUrl || source.download_url || source.url,
    1000,
  );
  if (!id && !label && !url) return null;
  return {
    type: cleanText(source.type || source.kind || fallbackType, 80) || fallbackType,
    id: id || null,
    label: label || 'Recorded evidence',
    status: cleanText(source.status, 80) || null,
    url: url || null,
  };
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

function inferLanguage(filename = '', mimeType = '') {
  const extension = String(filename).toLowerCase().split('.').pop();
  const languages = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', html: 'html', htm: 'html',
    css: 'css', md: 'markdown', markdown: 'markdown', yaml: 'yaml', yml: 'yaml',
    xml: 'xml', csv: 'csv', sh: 'shell', bash: 'shell', ps1: 'powershell',
    py: 'python', txt: 'text', log: 'text',
  };
  if (languages[extension]) return languages[extension];
  if (String(mimeType).startsWith('text/')) return 'text';
  return null;
}

function normalizeStoredArtifact(artifact = {}, { includeContent = false } = {}) {
  const source = asObject(artifact);
  const metadata = asObject(source.metadata);
  const id = cleanText(source.id, 240);
  const name = cleanText(source.filename || metadata.filename || metadata.title || id, 300) || 'Artifact';
  const mimeType = cleanText(source.mimeType || metadata.mimeType, 160) || null;
  const language = inferLanguage(name, mimeType);
  const previewUrl = cleanText(source.previewUrl || metadata.previewUrl, 1000)
    || (id ? `/api/artifacts/${encodeURIComponent(id)}/preview` : null);
  const downloadUrl = cleanText(source.downloadUrl || metadata.downloadUrl, 1000)
    || (id ? `/api/artifacts/${encodeURIComponent(id)}/download` : null);
  const content = includeContent && language
    ? cleanText(source.extractedText || metadata.extractedText || source.previewHtml, 12000)
    : null;
  return {
    id: id || null,
    name,
    path: cleanText(metadata.path || metadata.workspacePath || metadata.sourcePath || name, 1000) || name,
    detail: [language, formatBytes(source.sizeBytes), cleanText(source.status, 80)].filter(Boolean).join(' · ') || 'Recorded artifact',
    mimeType,
    language,
    sizeBytes: Number.isFinite(Number(source.sizeBytes)) ? Number(source.sizeBytes) : null,
    previewUrl,
    downloadUrl,
    url: previewUrl || downloadUrl,
    deletable: Boolean(id),
    content: content || null,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || source.createdAt || null,
  };
}

function isPrivateAgentBrowserArtifact(artifact = {}) {
  const metadata = asObject(artifact?.metadata);
  return metadata.privateAgentWorkspace === true
    || (metadata.browserCapture === true && Boolean(metadata.browserWorkspaceId));
}

function safeHostname(value = '') {
  try {
    return new URL(String(value || '')).hostname || null;
  } catch (_error) {
    return null;
  }
}

function normalizeWhiteboardNote(message = {}) {
  const source = asObject(message);
  const metadata = asObject(source.metadata);
  if (metadata.kind !== 'agent-whiteboard-note') return null;
  const column = ['now', 'waiting', 'done'].includes(cleanText(metadata.column, 20))
    ? cleanText(metadata.column, 20)
    : 'now';
  const content = cleanText(source.content || source.message, 1200)
    .replace(/^\[Shared whiteboard note[^\]]*\]\s*/i, '')
    .trim();
  if (!content) return null;
  return {
    id: cleanText(source.id, 240) || `whiteboard-${crypto.createHash('sha256').update(`${source.timestamp || ''}:${content}`).digest('hex').slice(0, 16)}`,
    column,
    content,
    author: cleanText(metadata.actor || metadata.author, 160) || 'Operator',
    targetAgentId: cleanText(metadata.targetAgentId, 160) || null,
    createdAt: source.timestamp || source.createdAt || null,
  };
}

function findSharedWhiteboardPath(workloads = []) {
  for (const workload of workloads) {
    const metadata = asObject(workload?.metadata);
    const agentCompany = asObject(metadata.agentCompany);
    const longAgent = asObject(metadata.longAgent);
    const sharedWhiteboard = asObject(agentCompany.sharedWhiteboard);
    const candidate = cleanText(
      sharedWhiteboard.path || longAgent.sharedWhiteboardFile,
      1000,
    );
    if (candidate) return candidate;
  }
  return null;
}

function normalizeUsage(run = {}) {
  const usage = asObject(run.usage);
  const input = Number(
    usage.inputTokens
      ?? usage.input_tokens
      ?? usage.promptTokens
      ?? usage.prompt_tokens
      ?? 0,
  );
  const output = Number(
    usage.outputTokens
      ?? usage.output_tokens
      ?? usage.completionTokens
      ?? usage.completion_tokens
      ?? 0,
  );
  const directTotal = Number(usage.totalTokens ?? usage.total_tokens);
  return {
    inputTokens: Number.isFinite(input) && input > 0 ? input : 0,
    outputTokens: Number.isFinite(output) && output > 0 ? output : 0,
    totalTokens: Number.isFinite(directTotal) && directTotal >= 0
      ? directTotal
      : Math.max(0, input) + Math.max(0, output),
  };
}

function getRunTokenLimit(run = {}) {
  const budget = asObject(run.budget);
  const limit = Number(
    budget.maxTokens
      ?? budget.max_tokens
      ?? budget.tokenLimit
      ?? budget.token_limit,
  );
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

function pickLatest(values = []) {
  return [...values].sort((left, right) => (
    timestampValue(right.updatedAt || right.finishedAt || right.createdAt)
      - timestampValue(left.updatedAt || left.finishedAt || left.createdAt)
  ))[0] || null;
}

class AgentOpsService {
  constructor({
    agentCompanyService = null,
    workloadService = null,
    agentRunService = null,
    sessionStore = null,
    artifactStore = null,
    artifactService = null,
    now = () => new Date(),
  } = {}) {
    this.agentCompanyService = agentCompanyService;
    this.workloadService = workloadService;
    this.agentRunService = agentRunService;
    this.sessionStore = sessionStore;
    this.artifactStore = artifactStore;
    this.artifactService = artifactService;
    this.now = now;
  }

  async listCanonicalRuns(limit = 100) {
    const service = this.agentRunService;
    if (!service) return [];
    if (typeof service.listRuns === 'function') {
      return asArray(await service.listRuns('', limit));
    }
    if (typeof service.store?.listRuns !== 'function') return [];

    const rawRuns = asArray(await service.store.listRuns(AGENT_RUN_SURFACE, '', limit));
    if (typeof service.getRun !== 'function') return rawRuns;
    const runs = await Promise.all(rawRuns.map(async (run) => {
      try {
        return await service.getRun(run.id, run.ownerId || '');
      } catch (_error) {
        return null;
      }
    }));
    return runs.filter(Boolean);
  }

  async loadSources() {
    const companyStatus = typeof this.agentCompanyService?.getStatus === 'function'
      ? await this.agentCompanyService.getStatus()
      : { available: false, config: {}, state: {} };
    const workloadAvailable = this.workloadService?.isAvailable?.() === true;
    const workloads = workloadAvailable && typeof this.workloadService?.listAdminWorkloads === 'function'
      ? asArray(await this.workloadService.listAdminWorkloads(200))
      : [];
    const workloadRuns = workloadAvailable && typeof this.workloadService?.listAdminRuns === 'function'
      ? asArray(await this.workloadService.listAdminRuns(300))
      : [];
    const canonicalRuns = await this.listCanonicalRuns(100);
    const companyConfig = asObject(companyStatus?.config);
    const hasActiveProject = !(companyConfig.projectsInitialized === true
      && listProjects(companyConfig).length === 0);
    const sessionId = hasActiveProject ? cleanText(companyConfig.sessionId, 160) : '';
    const artifacts = sessionId && typeof this.artifactStore?.listBySession === 'function'
      ? asArray(await this.artifactStore.listBySession(sessionId))
      : [];
    let sessionMessages = [];
    if (sessionId && typeof this.sessionStore?.getRecentMessages === 'function') {
      try {
        sessionMessages = asArray(await this.sessionStore.getRecentMessages(sessionId, 120));
      } catch (error) {
        console.warn('[AgentOps] Session message read failed:', error.message);
      }
    }

    return {
      companyStatus: asObject(companyStatus),
      workloads,
      workloadRuns,
      canonicalRuns,
      artifacts,
      sessionMessages,
      workloadAvailable,
    };
  }

  isCompanyWorkload(workload = {}, config = {}, state = {}) {
    const metadata = getCompanyMetadata(workload);
    const sessionId = cleanText(config.sessionId, 160);
    const goalHash = cleanText(state.companyGoalHash || config.companyGoalHash, 160);
    if (config.projectsInitialized === true) {
      const activeProject = findActiveProject(config, listProjects(config));
      return Boolean(activeProject?.sessionId && workload.sessionId === activeProject.sessionId);
    }
    return metadata.enabled === true
      || metadata.heartbeatManaged === true
      || Boolean(metadata.planItemId)
      || (sessionId && workload.sessionId === sessionId)
      || (goalHash && metadata.companyGoalHash === goalHash);
  }

  buildRunIndexes(workloads = [], workloadRuns = [], canonicalRuns = []) {
    const workloadIds = new Set(workloads.map((workload) => workload.id).filter(Boolean));
    const companyWorkloadRuns = workloadRuns.filter((run) => workloadIds.has(run.workloadId));
    const runsByWorkload = new Map();
    companyWorkloadRuns.forEach((run) => {
      const entries = runsByWorkload.get(run.workloadId) || [];
      entries.push(run);
      runsByWorkload.set(run.workloadId, entries);
    });

    const workloadRunIds = new Set(companyWorkloadRuns.map((run) => run.id).filter(Boolean));
    const companyCanonicalRuns = canonicalRuns.filter((run) => (
      workloadRunIds.has(getCanonicalWorkloadRunId(run))
      || workloadIds.has(getCanonicalWorkloadId(run))
      || (run.surface === 'workload' && workloads.some((workload) => workload.sessionId && workload.sessionId === run.sessionId))
    ));
    const canonicalByWorkloadRun = new Map();
    companyCanonicalRuns.forEach((run) => {
      const workloadRunId = getCanonicalWorkloadRunId(run);
      if (workloadRunId) canonicalByWorkloadRun.set(workloadRunId, run);
    });

    return {
      companyWorkloadRuns,
      companyCanonicalRuns,
      runsByWorkload,
      canonicalByWorkloadRun,
    };
  }

  getPendingApproval(run = null) {
    return asArray(run?.approvals).find((approval) => (
      cleanText(approval?.status, 40).toLowerCase() === 'pending'
    )) || null;
  }

  resolveWorkloadExecutionStatus(workload = null, workloadRun = null, canonicalRun = null, fallback = 'idle') {
    const canonicalState = normalizeRunStatus(canonicalRun?.state);
    const workloadState = normalizeRunStatus(workloadRun?.status);
    if (this.getPendingApproval(canonicalRun) || canonicalState === 'waiting_for_approval') return 'waiting_for_approval';
    if (canonicalState === 'blocked') return 'blocked';
    if (['failed', 'cancelled'].includes(workloadState)) return workloadState;
    if (ACTIVE_RUN_STATES.has(workloadState) || ACTIVE_RUN_STATES.has(canonicalState)) {
      return ACTIVE_RUN_STATES.has(workloadState) ? workloadState : canonicalState;
    }
    const remote = workloadRun?.metadata?.output?.remoteExecution;
    const lastDecision = workload?.metadata?.longAgent?.lastDecision;
    const decision = workloadRun?.id && lastDecision?.runId === workloadRun.id ? lastDecision.decision : null;
    if (decision === 'stop_max_steps') return 'paused';
    if (isRemoteExecutionPending(remote)) return 'running';
    if (remote && ['failed', 'blocked', 'cancelled', 'canceled', 'error', 'rejected', 'waiting_for_input'].includes(remote.completionStatus)) return 'blocked';
    if (decision === 'review') return 'blocked';
    if (decision === 'next_step') return 'planning';
    return normalizeRunStatus(canonicalRun?.state || workloadRun?.status || fallback);
  }

  deriveAgentStatus(workloadRun = null, canonicalRun = null, workload = null) {
    const state = this.resolveWorkloadExecutionStatus(workload, workloadRun, canonicalRun);
    if (this.getPendingApproval(canonicalRun)
      || ['waiting_for_approval', 'blocked', 'paused'].includes(state)) {
      return 'needs_input';
    }
    if (ACTIVE_RUN_STATES.has(state)) {
      return 'working';
    }
    return 'idle';
  }

  buildAgentSummary({ role = {}, workload = null, run = null, canonicalRun = null, heartbeat = {} } = {}) {
    const now = this.now();
    const companyMetadata = getCompanyMetadata(workload || {});
    const roleId = cleanText(role.id || companyMetadata.roleId || workload?.id, 160);
    const roleName = cleanText(role.name || companyMetadata.roleName || workload?.title || roleId, 200);
    const status = this.deriveAgentStatus(run, canonicalRun, workload);
    const runState = this.resolveWorkloadExecutionStatus(workload, run, canonicalRun);
    const pendingApproval = this.getPendingApproval(canonicalRun);
    const task = cleanText(workload?.title || role.mission, 500) || null;
    let currentAction = 'Awaiting assignment';
    if (task && status === 'needs_input') currentAction = `${pendingApproval || runState === 'waiting_for_approval' ? 'Approval needed' : runState === 'paused' ? 'Continuation needed' : 'Needs attention'}: ${task}`;
    else if (task && status === 'working') currentAction = `Working on ${task}`;
    else if (task && runState === 'completed') currentAction = `Completed ${task}`;
    else if (task && runState === 'failed') currentAction = `Run failed: ${task}`;
    else if (task) currentAction = task;
    const heartbeatAt = run?.updatedAt
      || canonicalRun?.updatedAt
      || workload?.updatedAt
      || heartbeat.lastAt
      || null;

    return {
      id: roleId,
      name: roleName,
      role: roleName,
      task,
      currentAction,
      elapsedSeconds: durationSeconds(
        run?.startedAt || canonicalRun?.createdAt || run?.createdAt,
        TERMINAL_RUN_STATES.has(runState) ? (run?.finishedAt || canonicalRun?.updatedAt) : null,
        now,
      ),
      model: cleanText(
        workload?.metadata?.requestedModel
          || companyMetadata?.modelPolicy?.selectedModel
          || canonicalRun?.snapshot?.model,
        160,
      ) || null,
      cpuPercent: null,
      memoryLabel: 'Not reported',
      lastHeartbeatSeconds: secondsSince(heartbeatAt, now),
      status,
      runId: canonicalRun?.id || run?.id || null,
      workloadId: workload?.id || null,
      sessionId: cleanText(workload?.sessionId, 160) || null,
      canReceiveInput: Boolean(workload?.id && workload?.sessionId),
      ...(run?.metadata?.output?.remoteExecution ? { remoteExecution: run.metadata.output.remoteExecution } : {}),
      needsApproval: Boolean(pendingApproval),
      approval: pendingApproval ? {
        id: cleanText(pendingApproval.id, 240),
        title: cleanText(pendingApproval.title || pendingApproval.reason, 300) || 'Approval required',
        reason: cleanText(pendingApproval.reason, 500) || null,
      } : null,
    };
  }

  buildWorkflows(workloads = [], indexes = {}) {
    return workloads.map((workload) => {
      const runs = indexes.runsByWorkload.get(workload.id) || [];
      const run = pickLatest(runs);
      const canonicalRun = run ? indexes.canonicalByWorkloadRun.get(run.id) || null : null;
      const metadata = getCompanyMetadata(workload);
      const status = this.resolveWorkloadExecutionStatus(workload, run, canonicalRun);
      return {
        id: workload.id,
        title: cleanText(workload.title, 500) || 'Untitled workflow',
        agentId: cleanText(metadata.roleId, 160) || null,
        agentName: cleanText(metadata.roleName, 200) || null,
        status,
        enabled: workload.enabled !== false,
        runId: canonicalRun?.id || run?.id || null,
        updatedAt: run?.updatedAt || canonicalRun?.updatedAt || workload.updatedAt || workload.createdAt || null,
        evidence: [
          ...asArray(canonicalRun?.evidence).map((entry) => normalizeEvidence(entry)),
          ...asArray(canonicalRun?.outputs).map((entry) => normalizeEvidence(entry, 'artifact')),
          ...asArray(run?.metadata?.output?.artifacts).map((entry) => normalizeEvidence(entry, 'artifact')),
        ].filter(Boolean),
      };
    }).sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
  }

  buildAgents(config = {}, state = {}, workloads = [], indexes = {}) {
    const heartbeat = asObject(state.heartbeat);
    const roleMap = new Map(
      [...asArray(config.roles), ...asArray(state.roles)]
        .filter((role) => role?.id || role?.name)
        .map((role) => [cleanText(role.id || role.name, 160), role]),
    );
    const candidates = [];
    workloads.forEach((workload) => {
      const metadata = getCompanyMetadata(workload);
      const roleId = cleanText(metadata.roleId || workload.id, 160);
      const runs = indexes.runsByWorkload.get(workload.id) || [];
      const run = pickLatest(runs);
      const canonicalRun = run ? indexes.canonicalByWorkloadRun.get(run.id) || null : null;
      candidates.push(this.buildAgentSummary({
        role: roleMap.get(roleId) || { id: roleId, name: metadata.roleName },
        workload,
        run,
        canonicalRun,
        heartbeat,
      }));
    });

    const rank = { needs_input: 3, working: 2, idle: 1 };
    const byAgent = new Map();
    candidates.forEach((candidate) => {
      const current = byAgent.get(candidate.id);
      if (!current
        || rank[candidate.status] > rank[current.status]
        || (rank[candidate.status] === rank[current.status]
          && (candidate.lastHeartbeatSeconds ?? Number.MAX_SAFE_INTEGER)
            < (current.lastHeartbeatSeconds ?? Number.MAX_SAFE_INTEGER))) {
        byAgent.set(candidate.id, candidate);
      }
    });
    return Array.from(byAgent.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  buildGoalItems(state = {}, workloads = [], indexes = {}) {
    const workloadByPlanId = new Map();
    workloads.forEach((workload) => {
      const planItemId = cleanText(getCompanyMetadata(workload).planItemId, 240);
      if (planItemId) workloadByPlanId.set(planItemId, workload);
    });
    const scheduledItems = asArray(state.shortTermSchedule);
    const sourceItems = scheduledItems.length > 0 ? scheduledItems : asArray(state.longTermGoals);

    return sourceItems.map((item, index) => {
      const itemId = cleanText(item.id, 240) || `goal-${index + 1}`;
      const workload = workloadByPlanId.get(itemId) || null;
      const run = workload ? pickLatest(indexes.runsByWorkload.get(workload.id) || []) : null;
      const canonicalRun = run ? indexes.canonicalByWorkloadRun.get(run.id) || null : null;
      const approval = this.getPendingApproval(canonicalRun);
      const rawStatus = this.resolveWorkloadExecutionStatus(workload, run, canonicalRun, item.status || 'planned');
      let status = rawStatus;
      if (approval || rawStatus === 'waiting_for_approval' || rawStatus === 'paused') status = 'needs_input';
      else if (ACTIVE_RUN_STATES.has(rawStatus)) status = 'working';
      else if (rawStatus === 'failed' || rawStatus === 'blocked' || rawStatus === 'cancelled') status = 'blocked';
      else if (rawStatus !== 'completed') status = 'planned';

      const evidence = [
        ...asArray(canonicalRun?.evidence).map((entry) => normalizeEvidence(entry)),
        ...asArray(canonicalRun?.outputs).map((entry) => normalizeEvidence(entry, 'artifact')),
        ...asArray(run?.metadata?.output?.artifacts).map((entry) => normalizeEvidence(entry, 'artifact')),
      ].filter(Boolean);
      const error = asObject(run?.error);
      return {
        id: itemId,
        title: cleanText(item.title || item.objective, 500) || 'Untitled goal',
        agentName: cleanText(
          getCompanyMetadata(workload || {}).roleName || item.roleName,
          200,
        ) || null,
        status,
        blockedBy: status === 'blocked'
          ? cleanText(error.message || run?.reason || canonicalRun?.completion?.reason, 500) || 'Run did not complete.'
          : (approval ? cleanText(approval.reason || approval.title, 500) || 'Approval required.'
            : rawStatus === 'paused' ? 'Automatic stage limit reached. Resume the goal to continue; the remote job cursor is preserved.' : null),
        evidence,
      };
    });
  }

  buildBudget(canonicalRuns = []) {
    const usage = canonicalRuns.reduce((total, run) => {
      const normalized = normalizeUsage(run);
      total.inputTokens += normalized.inputTokens;
      total.outputTokens += normalized.outputTokens;
      total.usedTokens += normalized.totalTokens;
      return total;
    }, { inputTokens: 0, outputTokens: 0, usedTokens: 0 });
    const limits = canonicalRuns.map(getRunTokenLimit).filter((value) => value !== null);
    const limitTokens = limits.length > 0 ? limits.reduce((sum, value) => sum + value, 0) : null;
    return {
      unit: 'tokens',
      ...usage,
      limitTokens,
      remainingTokens: limitTokens === null ? null : Math.max(0, limitTokens - usage.usedTokens),
      utilizationPercent: limitTokens
        ? Math.min(100, Math.round((usage.usedTokens / limitTokens) * 1000) / 10)
        : null,
      source: canonicalRuns.length > 0 ? 'agent-runs' : 'unavailable',
    };
  }

  buildProject(config = {}, state = {}, agents = [], goalItems = []) {
    const projects = listProjects(config);
    const activeProject = findActiveProject(config, projects);
    if (!activeProject && config.projectsInitialized === true) {
      return {
        id: null,
        name: null,
        goal: null,
        progress: 0,
        target: null,
        status: 'empty',
      };
    }
    const completed = goalItems.filter((item) => item.status === 'completed').length;
    const progress = goalItems.length > 0 ? Math.round((completed / goalItems.length) * 100) : 0;
    const target = asArray(state.shortTermSchedule)
      .map((item) => item.plannedFor)
      .filter(Boolean)
      .sort()
      .at(-1)
      || state.heartbeat?.nextAt
      || null;
    let status = config.enabled === true ? 'idle' : 'disabled';
    if (agents.some((agent) => agent.status === 'needs_input')) status = 'needs_input';
    else if (agents.some((agent) => agent.status === 'working')) status = 'active';
    else if (cleanText(state.heartbeat?.status).includes('fail')) status = 'degraded';

    return {
      id: cleanText(activeProject?.id || config.activeProjectId || config.sessionId, 160) || null,
      name: cleanText(activeProject?.name || config.sessionId, 200) || null,
      goal: cleanText(state.companyGoal || activeProject?.companyGoal || config.companyGoal, 4000) || null,
      progress,
      target,
      status,
    };
  }

  buildHeartbeat(state = {}, config = {}) {
    const heartbeat = asObject(state.heartbeat);
    const now = this.now();
    return {
      status: cleanText(heartbeat.status, 80) || 'unavailable',
      lastAt: heartbeat.lastAt || null,
      nextAt: heartbeat.nextAt || null,
      intervalSeconds: Number(config.heartbeatMinutes) > 0
        ? Number(config.heartbeatMinutes) * 60
        : null,
      ageSeconds: secondsSince(heartbeat.lastAt, now),
      reason: cleanText(heartbeat.reason, 240) || null,
      createdWorkloads: Number(heartbeat.createdWorkloads || 0),
      failedWorkloads: Number(heartbeat.failedWorkloads || 0),
    };
  }

  buildWhiteboard(workloads = [], sessionMessages = []) {
    const notes = asArray(sessionMessages)
      .map(normalizeWhiteboardNote)
      .filter(Boolean)
      .sort((left, right) => timestampValue(left.createdAt) - timestampValue(right.createdAt))
      .slice(-60);
    return {
      path: findSharedWhiteboardPath(workloads),
      sections: ['Claims checked', 'Decisions made', 'Files/artifacts changed', 'Deployment/DNS state', 'Blockers', 'Next agent task'],
      notes,
    };
  }

  async buildSnapshot() {
    const sources = await this.loadSources();
    const config = asObject(sources.companyStatus.config);
    const state = asObject(sources.companyStatus.state);
    const projects = listProjects(config);
    const activeProject = findActiveProject(config, projects);
    const companyWorkloads = activeProject
      ? sources.workloads.filter((workload) => this.isCompanyWorkload(workload, config, state))
      : [];
    const indexes = this.buildRunIndexes(companyWorkloads, sources.workloadRuns, sources.canonicalRuns);
    const agents = this.buildAgents(config, state, companyWorkloads, indexes);
    const goalItems = activeProject ? this.buildGoalItems(state, companyWorkloads, indexes) : [];
    const workflows = this.buildWorkflows(companyWorkloads, indexes);
    const heartbeat = activeProject ? this.buildHeartbeat(state, config) : {
      status: 'idle',
      lastAt: null,
      nextAt: null,
      intervalSeconds: null,
      ageSeconds: null,
      reason: 'no_active_project',
      createdWorkloads: 0,
      failedWorkloads: 0,
    };
    const groups = {
      needsInput: agents.filter((agent) => agent.status === 'needs_input'),
      working: agents.filter((agent) => agent.status === 'working'),
      idle: agents.filter((agent) => agent.status === 'idle'),
    };
    const selectedAgentId = groups.needsInput[0]?.id || groups.working[0]?.id || groups.idle[0]?.id || null;
    const canListApprovals = typeof this.agentRunService?.performAction === 'function'
      && (typeof this.agentRunService?.listRuns === 'function'
        || typeof this.agentRunService?.store?.listRuns === 'function');
    const settingsController = this.agentCompanyService?.settingsController;
    const canCreateGoals = typeof settingsController?.updateAgentCompanySettings === 'function'
      && typeof this.agentCompanyService?.tick === 'function';
    const canManageProjects = typeof settingsController?.updateAgentCompanySettings === 'function';
    const canDeleteArtifacts = typeof this.artifactStore?.get === 'function'
      && typeof this.artifactService?.deleteArtifact === 'function';
    const projectArtifacts = sources.artifacts
      .filter((artifact) => !isPrivateAgentBrowserArtifact(artifact))
      .map((artifact) => normalizeStoredArtifact(artifact));

    return {
      public: {
        generatedAt: this.now().toISOString(),
        project: this.buildProject(config, state, agents, goalItems),
        heartbeat,
        budget: this.buildBudget(indexes.companyCanonicalRuns),
        groups,
        selectedAgentId,
        goalItems,
        projects: projects.map((project) => ({
          id: cleanText(project.id, 160),
          name: cleanText(project.name, 200) || 'Untitled project',
          sessionId: cleanText(project.sessionId, 160),
          goal: cleanText(project.companyGoal, 4000) || null,
          enabled: project.enabled === true,
          active: project.id === activeProject?.id,
          createdAt: project.createdAt || null,
          updatedAt: project.updatedAt || null,
          artifactCount: project.id === activeProject?.id ? projectArtifacts.length : null,
        })),
        workflows,
        whiteboard: this.buildWhiteboard(companyWorkloads, sources.sessionMessages),
        messages: buildAgentMessages(companyWorkloads, indexes.companyWorkloadRuns),
        artifacts: projectArtifacts,
        approvals: groups.needsInput
          .filter((agent) => agent.approval)
          .map((agent) => ({
            ...agent.approval,
            agentId: agent.id,
            agentName: agent.name,
            task: agent.task,
          })),
        capabilities: {
          activity: true,
          approvals: canListApprovals,
          approvalDecisions: canListApprovals ? ['approve'] : [],
          artifacts: typeof this.artifactStore?.listBySession === 'function',
          artifactDeletion: canDeleteArtifacts
            ? { enabled: true, endpointTemplate: '/artifacts/{artifactId}' }
            : { enabled: false },
          heartbeat: typeof this.agentCompanyService?.getStatus === 'function',
          resourceMetrics: false,
          goalCreation: canCreateGoals ? { enabled: true, endpoint: '/goals' } : { enabled: false },
          projects: canManageProjects ? {
            enabled: true,
            collectionEndpoint: '/projects',
            activateEndpointTemplate: '/projects/{projectId}/activate',
            deleteEndpointTemplate: '/projects/{projectId}',
          } : { enabled: false },
          workspace: {
            enabled: true,
            endpointTemplate: '/agents/{agentId}/workspace',
            panels: ['activity', 'files', 'editor', 'terminal', 'browser-signals', 'artifacts', 'messages'],
          },
          operatorInput: typeof this.workloadService?.runWorkloadNow === 'function'
            && typeof this.sessionStore?.appendMessages === 'function'
            ? { enabled: true, endpointTemplate: '/agents/{agentId}/input' }
            : { enabled: false },
          whiteboard: typeof this.sessionStore?.appendMessages === 'function'
            ? { enabled: true, endpoint: '/whiteboard/notes' }
            : { enabled: false },
          stream: false,
        },
      },
      context: {
        ...sources,
        config,
        state,
        companyWorkloads,
        indexes,
        agents,
      },
    };
  }

  async getOverview() {
    const snapshot = await this.buildSnapshot();
    return snapshot.public;
  }

  getProjectSettingsRuntime() {
    const settingsController = this.agentCompanyService?.settingsController;
    if (typeof settingsController?.updateAgentCompanySettings !== 'function') {
      throw createAgentOpsError(
        'Project management is unavailable because the company settings runtime is not connected.',
        503,
        'agent_project_management_unavailable',
      );
    }
    return settingsController;
  }

  async getActiveRunCountForSession(sessionId = '') {
    const normalizedSessionId = cleanText(sessionId, 160);
    const service = this.workloadService;
    if (!normalizedSessionId) return 0;
    if (service?.isAvailable?.() !== true) {
      throw createAgentOpsError(
        'Project run state is unavailable; project deletion was not attempted.',
        503,
        'agent_project_run_state_unavailable',
      );
    }
    if (typeof service.getSessionSummaries === 'function') {
      const summaries = asObject(await service.getSessionSummaries([normalizedSessionId]));
      const summary = asObject(summaries[normalizedSessionId]);
      return Math.max(0, Number(summary.queued || 0) + Number(summary.running || 0));
    }
    if (typeof service.listAdminWorkloads !== 'function' || typeof service.listAdminRuns !== 'function') {
      throw createAgentOpsError(
        'Project run state is unavailable; project deletion was not attempted.',
        503,
        'agent_project_run_state_unavailable',
      );
    }
    const workloads = asArray(await service.listAdminWorkloads(500))
      .filter((workload) => workload.sessionId === normalizedSessionId);
    const workloadIds = new Set(workloads.map((workload) => workload.id).filter(Boolean));
    const runs = asArray(await service.listAdminRuns(500));
    return runs.filter((run) => workloadIds.has(run.workloadId)
      && ACTIVE_RUN_STATES.has(normalizeRunStatus(run.status))).length;
  }

  async createProject(input = {}, actor = '') {
    const name = cleanText(input.name, 120);
    const companyGoal = cleanText(input.companyGoal || input.goal, 4000);
    if (!name) {
      throw createAgentOpsError('Project name is required.', 400, 'agent_project_name_required');
    }
    const settingsController = this.getProjectSettingsRuntime();
    const current = asObject(settingsController.getEffectiveAgentCompanyConfig?.());
    const now = this.now().toISOString();
    const configuredProjects = asArray(current.projects);
    const projects = snapshotActiveProject(
      current,
      configuredProjects.length > 0 ? configuredProjects : listProjects(current),
      now,
    );
    const baseId = sanitizeProjectId(name) || 'project';
    let id = baseId;
    let suffix = 2;
    while (projects.some((project) => project.id === id)) {
      id = `${baseId}-${suffix++}`.slice(0, 80);
    }
    const project = {
      id,
      name,
      sessionId: `agent-company-${id}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 120),
      companyGoal,
      enabled: Boolean(companyGoal),
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    const config = await settingsController.updateAgentCompanySettings({
      ...current,
      projectsInitialized: true,
      projects: [...projects, project],
      activeProjectId: project.id,
      sessionId: project.sessionId,
      companyGoal,
      enabled: project.enabled,
    });
    let heartbeat = null;
    if (companyGoal && typeof this.agentCompanyService?.tick === 'function') {
      const status = await this.agentCompanyService.tick({
        force: true,
        reason: cleanText(`agent-ops-project:${actor || 'admin'}`, 120),
      });
      heartbeat = status?.state?.heartbeat || null;
    }
    return { project, config, heartbeat };
  }

  async activateProject(projectId = '') {
    const targetId = sanitizeProjectId(projectId);
    const settingsController = this.getProjectSettingsRuntime();
    const current = asObject(settingsController.getEffectiveAgentCompanyConfig?.());
    const now = this.now().toISOString();
    const configuredProjects = asArray(current.projects);
    const projects = snapshotActiveProject(
      current,
      configuredProjects.length > 0 ? configuredProjects : listProjects(current),
      now,
    );
    const project = projects.find((candidate) => candidate.id === targetId && candidate.archived !== true);
    if (!project) {
      throw createAgentOpsError('Project not found.', 404, 'agent_project_not_found');
    }
    const config = await settingsController.updateAgentCompanySettings({
      ...current,
      projectsInitialized: true,
      projects,
      activeProjectId: project.id,
      sessionId: project.sessionId,
      companyGoal: project.companyGoal || '',
      enabled: project.enabled === true,
    });
    return { project, config };
  }

  async deleteProject(projectId = '') {
    const targetId = sanitizeProjectId(projectId);
    const settingsController = this.getProjectSettingsRuntime();
    if (typeof this.artifactService?.deleteArtifactsForSession !== 'function') {
      throw createAgentOpsError(
        'Project file cleanup is unavailable; project deletion was not attempted.',
        503,
        'agent_project_cleanup_unavailable',
      );
    }
    const current = asObject(settingsController.getEffectiveAgentCompanyConfig?.());
    const now = this.now().toISOString();
    const configuredProjects = asArray(current.projects);
    const allProjects = snapshotActiveProject(
      current,
      configuredProjects.length > 0 ? configuredProjects : listProjects(current),
      now,
    );
    const project = allProjects.find((candidate) => candidate.id === targetId && candidate.archived !== true);
    if (!project) {
      throw createAgentOpsError('Project not found.', 404, 'agent_project_not_found');
    }
    const activeRunCount = await this.getActiveRunCountForSession(project.sessionId);
    if (activeRunCount > 0) {
      throw createAgentOpsError(
        `Finish or cancel ${activeRunCount} active run${activeRunCount === 1 ? '' : 's'} before deleting ${project.name}.`,
        409,
        'agent_project_has_active_runs',
      );
    }
    await this.artifactService.deleteArtifactsForSession(project.sessionId);
    const nextProjects = allProjects.filter((candidate) => candidate.id !== targetId);
    const visibleProjects = nextProjects.filter((candidate) => candidate.archived !== true);
    const currentActive = findActiveProject(current, allProjects);
    const nextActive = currentActive?.id === targetId
      ? visibleProjects[0] || null
      : visibleProjects.find((candidate) => candidate.id === currentActive?.id) || visibleProjects[0] || null;
    const config = await settingsController.updateAgentCompanySettings({
      ...current,
      projectsInitialized: true,
      projects: nextProjects,
      activeProjectId: nextActive?.id || '',
      sessionId: nextActive?.sessionId || `agent-company-empty-${crypto.randomUUID().slice(0, 8)}`,
      companyGoal: nextActive?.companyGoal || '',
      enabled: nextActive?.enabled === true,
    });
    return {
      deletedProjectId: project.id,
      deletedProjectName: project.name,
      deletedSessionId: project.sessionId,
      activeProjectId: nextActive?.id || null,
      remainingProjectCount: visibleProjects.length,
      config,
    };
  }

  async deleteArtifact(artifactId = '') {
    const normalizedId = cleanText(artifactId, 240);
    const settingsController = this.getProjectSettingsRuntime();
    const current = asObject(settingsController.getEffectiveAgentCompanyConfig?.());
    const activeProject = findActiveProject(current, listProjects(current));
    if (!activeProject) {
      throw createAgentOpsError('No active project is available.', 409, 'agent_project_required');
    }
    if (typeof this.artifactStore?.get !== 'function'
      || typeof this.artifactService?.deleteArtifact !== 'function') {
      throw createAgentOpsError('File deletion is unavailable.', 503, 'agent_artifact_deletion_unavailable');
    }
    const artifact = await this.artifactStore.get(normalizedId);
    if (!artifact || cleanText(artifact.sessionId, 160) !== cleanText(activeProject.sessionId, 160)) {
      throw createAgentOpsError('File not found in the active project.', 404, 'agent_artifact_not_found');
    }
    const deleted = await this.artifactService.deleteArtifact(normalizedId);
    if (!deleted) {
      throw createAgentOpsError('File could not be deleted.', 409, 'agent_artifact_delete_failed');
    }
    return {
      deletedArtifactId: normalizedId,
      filename: cleanText(artifact.filename, 300) || normalizedId,
      projectId: activeProject.id,
    };
  }

  async createGoal(input = {}, actor = '') {
    const title = cleanText(input.title, 120);
    const successCriteria = cleanText(input.successCriteria, 3000);
    if (!title) {
      throw createAgentOpsError('Goal title is required.', 400, 'agent_goal_title_required');
    }
    const settingsController = this.agentCompanyService?.settingsController;
    if (typeof settingsController?.updateAgentCompanySettings !== 'function'
      || typeof this.agentCompanyService?.tick !== 'function') {
      throw createAgentOpsError(
        'Goal creation is unavailable because the company settings runtime is not connected.',
        503,
        'agent_goal_creation_unavailable',
      );
    }

    const current = asObject(settingsController.getEffectiveAgentCompanyConfig?.());
    const activeProject = findActiveProject(current, listProjects(current));
    if (!activeProject) {
      throw createAgentOpsError(
        'Create a project before starting a goal.',
        409,
        'agent_project_required',
      );
    }
    const goal = cleanText(
      successCriteria ? `${title}\n\nSuccess criteria:\n${successCriteria}` : title,
      4000,
    );
    const activeProjectId = cleanText(activeProject.id, 160);
    const sessionId = cleanText(activeProject.sessionId, 160);
    const now = this.now().toISOString();
    const configuredProjects = asArray(current.projects);
    const projects = (configuredProjects.length > 0 ? configuredProjects : listProjects(current)).map((project) => {
      const isActive = (activeProjectId && project.id === activeProjectId)
        || (!activeProjectId && sessionId && project.sessionId === sessionId);
      return isActive ? { ...project, companyGoal: goal, enabled: true, updatedAt: now } : project;
    });
    const config = await settingsController.updateAgentCompanySettings({
      ...current,
      projectsInitialized: true,
      companyGoal: goal,
      enabled: true,
      projects,
    });
    const status = await this.agentCompanyService.tick({
      force: true,
      reason: cleanText(`agent-ops-goal:${actor || 'admin'}`, 120),
    });
    return {
      title,
      successCriteria: successCriteria || null,
      goal,
      projectId: config?.activeProjectId || null,
      sessionId: config?.sessionId || null,
      heartbeat: status?.state?.heartbeat || null,
      createdAt: now,
    };
  }

  makeTimelineEvent(input = {}) {
    return {
      id: cleanText(input.id, 300),
      type: cleanText(input.type, 100) || 'activity',
      status: cleanText(input.status, 80) || null,
      title: cleanText(input.title, 300) || 'Agent activity',
      detail: cleanText(input.detail, 1000) || null,
      timestamp: input.timestamp || null,
      runId: input.runId || null,
      workloadId: input.workloadId || null,
      evidence: asArray(input.evidence).filter(Boolean),
    };
  }

  async getAgentActivity(agentId = '') {
    const normalizedId = cleanText(agentId, 160);
    const snapshot = await this.buildSnapshot();
    const agent = snapshot.context.agents.find((candidate) => candidate.id === normalizedId);
    if (!agent) {
      throw createAgentOpsError('Agent not found.', 404, 'agent_not_found');
    }

    const roleWorkloads = snapshot.context.companyWorkloads.filter((workload) => {
      const metadata = getCompanyMetadata(workload);
      return cleanText(metadata.roleId || workload.id, 160) === normalizedId;
    });
    const roleWorkloadIds = new Set(roleWorkloads.map((workload) => workload.id));
    const roleRuns = snapshot.context.indexes.companyWorkloadRuns.filter((run) => roleWorkloadIds.has(run.workloadId));
    const roleRunIds = new Set(roleRuns.map((run) => run.id));
    const roleCanonicalRuns = snapshot.context.indexes.companyCanonicalRuns.filter((run) => (
      roleRunIds.has(getCanonicalWorkloadRunId(run)) || roleWorkloadIds.has(getCanonicalWorkloadId(run))
    ));
    const events = [];

    roleWorkloads.forEach((workload) => {
      events.push(this.makeTimelineEvent({
        id: `workload:${workload.id}:created`,
        type: 'workload.created',
        status: workload.enabled === false ? 'paused' : 'ready',
        title: workload.title || 'Workload created',
        detail: getCompanyMetadata(workload).plannedFor
          ? `Planned for ${getCompanyMetadata(workload).plannedFor}`
          : null,
        timestamp: workload.createdAt || null,
        workloadId: workload.id,
      }));
    });
    roleRuns.forEach((run) => {
      events.push(this.makeTimelineEvent({
        id: `workload-run:${run.id}:queued`,
        type: 'run.queued',
        status: 'queued',
        title: 'Run queued',
        detail: run.reason || null,
        timestamp: run.createdAt || run.scheduledFor || null,
        runId: run.id,
        workloadId: run.workloadId,
      }));
      if (run.startedAt) {
        events.push(this.makeTimelineEvent({
          id: `workload-run:${run.id}:started`,
          type: 'run.started',
          status: 'running',
          title: 'Run started',
          timestamp: run.startedAt,
          runId: run.id,
          workloadId: run.workloadId,
        }));
      }
      if (run.finishedAt || TERMINAL_RUN_STATES.has(normalizeRunStatus(run.status))) {
        const evidence = asArray(run?.metadata?.output?.artifacts)
          .map((entry) => normalizeEvidence(entry, 'artifact'))
          .filter(Boolean);
        events.push(this.makeTimelineEvent({
          id: `workload-run:${run.id}:${normalizeRunStatus(run.status)}`,
          type: `run.${normalizeRunStatus(run.status)}`,
          status: normalizeRunStatus(run.status),
          title: `Run ${normalizeRunStatus(run.status)}`,
          detail: cleanText(run?.error?.message || run?.metadata?.output?.artifactMessage, 1000) || null,
          timestamp: run.finishedAt || run.updatedAt || null,
          runId: run.id,
          workloadId: run.workloadId,
          evidence,
        }));
      }
    });

    for (const run of roleCanonicalRuns) {
      const canonicalEvents = typeof this.agentRunService?.listEvents === 'function'
        ? asArray(await this.agentRunService.listEvents(run.id, 0, run.ownerId || ''))
        : [];
      canonicalEvents.forEach((event) => {
        const payload = asObject(event.payload);
        events.push(this.makeTimelineEvent({
          id: event.eventId || `agent-run:${run.id}:${event.cursor}`,
          type: event.type || 'agent_run.event',
          status: event.status || payload.toState || run.state,
          title: cleanText(payload.message || payload.reason || event.type, 300),
          detail: cleanText(payload.details?.message || payload.details?.reason, 1000) || null,
          timestamp: event.timestamp || run.updatedAt || null,
          runId: run.id,
          workloadId: getCanonicalWorkloadId(run) || roleRuns.find((entry) => entry.id === getCanonicalWorkloadRunId(run))?.workloadId || null,
        }));
      });
      const recordedEvidence = [
        ...asArray(run.evidence).map((entry) => normalizeEvidence(entry)),
        ...asArray(run.outputs).map((entry) => normalizeEvidence(entry, 'artifact')),
      ].filter(Boolean);
      if (recordedEvidence.length > 0) {
        events.push(this.makeTimelineEvent({
          id: `agent-run:${run.id}:evidence`,
          type: 'run.evidence_recorded',
          status: run.state,
          title: 'Evidence recorded',
          timestamp: run.updatedAt || run.createdAt || null,
          runId: run.id,
          workloadId: getCanonicalWorkloadId(run) || null,
          evidence: recordedEvidence,
        }));
      }
    }

    if (typeof this.artifactStore?.listBySession === 'function' && snapshot.context.config.sessionId) {
      const artifacts = asArray(await this.artifactStore.listBySession(snapshot.context.config.sessionId));
      artifacts.filter((artifact) => {
        const metadata = asObject(artifact.metadata);
        return roleWorkloadIds.has(metadata.workloadId)
          || roleRunIds.has(metadata.runId)
          || cleanText(metadata?.agentCompany?.roleId, 160) === normalizedId;
      }).forEach((artifact) => {
        events.push(this.makeTimelineEvent({
          id: `artifact:${artifact.id}`,
          type: 'artifact.created',
          status: 'recorded',
          title: artifact.filename || 'Artifact created',
          timestamp: artifact.createdAt || artifact.updatedAt || null,
          runId: artifact.metadata?.runId || null,
          workloadId: artifact.metadata?.workloadId || null,
          evidence: [normalizeEvidence(artifact, 'artifact')].filter(Boolean),
        }));
      });
    }

    const timeline = Array.from(new Map(events.filter((event) => event.id).map((event) => [event.id, event])).values())
      .sort((left, right) => (
        timestampValue(left.timestamp) - timestampValue(right.timestamp)
        || left.id.localeCompare(right.id)
      ));
    return {
      agentId: normalizedId,
      generatedAt: this.now().toISOString(),
      timeline,
    };
  }

  async getAgentWorkspace(agentId = '') {
    const normalizedId = cleanText(agentId, 160);
    const snapshot = await this.buildSnapshot();
    const agent = snapshot.context.agents.find((candidate) => candidate.id === normalizedId);
    if (!agent) {
      throw createAgentOpsError('Agent not found.', 404, 'agent_not_found');
    }
    const roleWorkloads = snapshot.context.companyWorkloads.filter((workload) => (
      cleanText(getCompanyMetadata(workload).roleId, 160) === normalizedId
    ));
    const workloadIds = new Set(roleWorkloads.map((workload) => workload.id).filter(Boolean));
    const workloadRuns = snapshot.context.indexes.companyWorkloadRuns.filter((run) => workloadIds.has(run.workloadId));
    const workloadRunIds = new Set(workloadRuns.map((run) => run.id).filter(Boolean));
    const canonicalRuns = snapshot.context.indexes.companyCanonicalRuns.filter((run) => (
      workloadRunIds.has(getCanonicalWorkloadRunId(run)) || workloadIds.has(getCanonicalWorkloadId(run))
    ));
    const referencedArtifactIds = new Set([
      ...workloadRuns.flatMap((run) => asArray(run?.metadata?.output?.artifacts).map((entry) => entry?.id || entry?.artifactId)),
      ...canonicalRuns.flatMap((run) => [...asArray(run.evidence), ...asArray(run.outputs)].map((entry) => entry?.id || entry?.artifactId)),
    ].filter(Boolean));
    const privateBrowserCaptures = snapshot.context.artifacts.filter((artifact) => {
      if (!isPrivateAgentBrowserArtifact(artifact)) return false;
      const metadata = asObject(artifact.metadata);
      return workloadIds.has(metadata.workloadId)
        || workloadRunIds.has(metadata.runId)
        || asObject(metadata.agentCompany).roleId === normalizedId;
    });
    const storedArtifacts = snapshot.context.artifacts.filter((artifact) => {
      if (isPrivateAgentBrowserArtifact(artifact)) return false;
      const metadata = asObject(artifact.metadata);
      const companyMetadata = asObject(metadata.agentCompany);
      return referencedArtifactIds.has(artifact.id)
        || workloadIds.has(metadata.workloadId)
        || workloadRunIds.has(metadata.runId)
        || companyMetadata.roleId === normalizedId;
    });
    const artifacts = storedArtifacts.map((artifact) => normalizeStoredArtifact(artifact, { includeContent: true }));
    const knownArtifactIds = new Set(artifacts.map((artifact) => artifact.id).filter(Boolean));
    const recordedOutputs = canonicalRuns
      .flatMap((run) => [...asArray(run.evidence), ...asArray(run.outputs)])
      .map((entry) => normalizeEvidence(entry, 'artifact'))
      .filter((entry) => entry && !knownArtifactIds.has(entry.id))
      .map((entry) => ({
        ...entry,
        name: entry.label,
        detail: [entry.type, entry.status].filter(Boolean).join(' · ') || 'Recorded output',
        previewUrl: entry.url,
        downloadUrl: entry.url,
        deletable: false,
      }));
    const activity = await this.getAgentActivity(normalizedId);
    const timeline = asArray(activity.timeline);
    const terminal = timeline.map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      status: event.status,
      command: event.type,
      output: [event.title, event.detail].filter(Boolean).join(' — '),
    }));
    const agentMessages = buildAgentMessages(roleWorkloads, workloadRuns);
    const operatorMessages = asArray(snapshot.context.sessionMessages)
      .filter((message) => {
        const metadata = asObject(message?.metadata);
        return metadata.kind === 'agent-operator-input'
          && cleanText(metadata.targetAgentId, 160) === normalizedId;
      })
      .map((message) => ({
        id: cleanText(message.id, 240) || null,
        from: cleanText(message?.metadata?.actor, 160) || 'Operator',
        task: 'Operator instruction',
        timestamp: message.timestamp || message.createdAt || null,
        message: cleanText(message.content, 4000).replace(/^\[Operator instruction[^\]]*\]\s*/i, '').trim(),
        links: [],
        attachments: [],
      }));
    const messages = [...agentMessages, ...operatorMessages]
      .sort((left, right) => timestampValue(left.timestamp) - timestampValue(right.timestamp));
    const allArtifacts = [...artifacts, ...recordedOutputs];
    const publicLinks = [...new Map(messages.flatMap((message) => message.links).map((link) => [link.url, {
      id: link.url, name: link.label, detail: 'Link reported by agent', url: link.url,
    }])).values()];
    const browser = [...publicLinks, ...allArtifacts
      .filter((artifact) => artifact.previewUrl || artifact.url)
      .map((artifact) => ({
        id: artifact.id,
        name: artifact.name || artifact.label,
        detail: artifact.detail || 'Recorded preview',
        url: artifact.previewUrl || artifact.url,
      }))];
    const recentPrivateBrowserSignals = privateBrowserCaptures
      .map((artifact) => {
        const metadata = asObject(artifact.metadata);
        return {
          id: cleanText(artifact.id, 240) || null,
          title: cleanText(metadata.pageTitle, 240) || 'Rendered page',
          host: safeHostname(metadata.sourceUrl),
          viewport: asObject(metadata.viewport),
          timestamp: artifact.updatedAt || artifact.createdAt || null,
        };
      })
      .sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp))
      .slice(0, 8);

    return {
      agentId: normalizedId,
      generatedAt: this.now().toISOString(),
      activity: timeline,
      files: artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        path: artifact.path,
        detail: artifact.detail,
        url: artifact.downloadUrl || artifact.previewUrl,
        deletable: artifact.deletable === true,
      })),
      editor: artifacts.filter((artifact) => artifact.language && artifact.content),
      terminal,
      browser,
      privateBrowser: {
        private: true,
        renderedFor: 'agent',
        exposedToOperator: false,
        persistent: true,
        status: privateBrowserCaptures.length > 0 ? 'active' : 'ready',
        captureCount: privateBrowserCaptures.length,
        lastActivityAt: recentPrivateBrowserSignals[0]?.timestamp || null,
        signals: recentPrivateBrowserSignals,
      },
      artifacts: allArtifacts,
      messages,
      whiteboard: this.buildWhiteboard(roleWorkloads, snapshot.context.sessionMessages),
      controls: {
        canReceiveInput: Boolean(roleWorkloads.length > 0
          && typeof this.workloadService?.runWorkloadNow === 'function'
          && typeof this.sessionStore?.appendMessages === 'function'),
      },
    };
  }

  async sendAgentInput(agentId = '', input = {}, actor = '') {
    const normalizedId = cleanText(agentId, 160);
    const instruction = cleanText(input.message || input.instruction, 4000);
    if (!instruction) {
      throw createAgentOpsError('Agent instruction is required.', 400, 'agent_input_required');
    }
    if (typeof this.workloadService?.runWorkloadNow !== 'function'
      || typeof this.sessionStore?.appendMessages !== 'function') {
      throw createAgentOpsError('Agent input is unavailable in this runtime.', 503, 'agent_input_unavailable');
    }

    const snapshot = await this.buildSnapshot();
    const agent = snapshot.context.agents.find((candidate) => candidate.id === normalizedId);
    if (!agent) {
      throw createAgentOpsError('Agent not found.', 404, 'agent_not_found');
    }
    const roleWorkloads = snapshot.context.companyWorkloads.filter((workload) => (
      cleanText(getCompanyMetadata(workload).roleId, 160) === normalizedId
    ));
    const workload = pickLatest(roleWorkloads);
    if (!workload?.id || !workload?.sessionId) {
      throw createAgentOpsError('This agent has no resumable workload session.', 409, 'agent_workload_unavailable');
    }
    const workloadRuns = snapshot.context.indexes.companyWorkloadRuns
      .filter((run) => run.workloadId === workload.id);
    const workloadRunIds = new Set(workloadRuns.map((run) => run.id));
    const pendingApproval = snapshot.context.indexes.companyCanonicalRuns
      .filter((run) => workloadRunIds.has(getCanonicalWorkloadRunId(run)) || getCanonicalWorkloadId(run) === workload.id)
      .map((run) => this.getPendingApproval(run))
      .find(Boolean);
    if (pendingApproval) {
      throw createAgentOpsError(
        'Resolve the pending approval before sending a continuation instruction.',
        409,
        'agent_input_requires_approval',
      );
    }

    const acceptedAt = this.now().toISOString();
    const normalizedActor = cleanText(actor, 160) || 'admin';
    const messageId = crypto.randomUUID();
    await this.sessionStore.appendMessages(workload.sessionId, [{
      id: messageId,
      role: 'user',
      content: `[Operator instruction for ${agent.name}]\n${instruction}`,
      timestamp: acceptedAt,
      metadata: {
        source: 'agent-ops',
        kind: 'agent-operator-input',
        actor: normalizedActor,
        targetAgentId: normalizedId,
        targetWorkloadId: workload.id,
      },
    }]);

    if (workload.enabled === false && typeof this.workloadService.resumeAdminWorkload === 'function') {
      await this.workloadService.resumeAdminWorkload(workload.id);
    }
    const whiteboardPath = findSharedWhiteboardPath([workload]);
    const run = await this.workloadService.runWorkloadNow(workload.id, workload.ownerId, {
      reason: 'agent-ops-input',
      prompt: [
        workload.prompt,
        '',
        '[Operator continuation]',
        `Operator: ${normalizedActor}`,
        `Instruction: ${instruction}`,
        whiteboardPath ? `Read and update the shared whiteboard at ${whiteboardPath} before final handoff.` : null,
        'Continue the existing owned work. Reuse its files, remote job cursor, evidence, and verified state; do not start a duplicate project.',
      ].filter(Boolean).join('\n'),
      idempotencyKey: `agent-ops-input:${messageId}`,
    });
    if (!run?.id) {
      throw createAgentOpsError('The instruction was recorded, but no workload run was queued.', 502, 'agent_input_queue_failed');
    }
    return {
      accepted: true,
      acceptedAt,
      messageId,
      agentId: normalizedId,
      workloadId: workload.id,
      sessionId: workload.sessionId,
      runId: run.id,
      status: run.status || 'queued',
    };
  }

  async createWhiteboardNote(input = {}, actor = '') {
    const content = cleanText(input.content || input.note, 1200);
    const column = cleanText(input.column, 20).toLowerCase() || 'now';
    if (!content) {
      throw createAgentOpsError('Whiteboard note content is required.', 400, 'agent_whiteboard_note_required');
    }
    if (!['now', 'waiting', 'done'].includes(column)) {
      throw createAgentOpsError('Whiteboard column must be now, waiting, or done.', 400, 'agent_whiteboard_column_invalid');
    }
    if (typeof this.sessionStore?.appendMessages !== 'function') {
      throw createAgentOpsError('Shared whiteboard persistence is unavailable.', 503, 'agent_whiteboard_unavailable');
    }
    const snapshot = await this.buildSnapshot();
    const sessionId = cleanText(snapshot.context.config.sessionId, 160);
    if (!sessionId || !snapshot.public.project?.id) {
      throw createAgentOpsError('Create or activate a project before adding a whiteboard note.', 409, 'agent_whiteboard_project_required');
    }
    const createdAt = this.now().toISOString();
    const id = crypto.randomUUID();
    const normalizedActor = cleanText(actor, 160) || 'admin';
    const targetAgentId = cleanText(input.targetAgentId, 160) || null;
    await this.sessionStore.appendMessages(sessionId, [{
      id,
      role: 'user',
      content: `[Shared whiteboard note | ${column}]\n${content}`,
      timestamp: createdAt,
      metadata: {
        source: 'agent-ops',
        kind: 'agent-whiteboard-note',
        column,
        actor: normalizedActor,
        targetAgentId,
      },
    }]);

    let heartbeat = null;
    let heartbeatWarning = null;
    if (input.wakeCrew !== false && typeof this.agentCompanyService?.tick === 'function') {
      try {
        const status = await this.agentCompanyService.tick({
          force: true,
          reason: 'shared-whiteboard-refresh',
        });
        heartbeat = status?.state?.heartbeat || null;
      } catch (error) {
        heartbeatWarning = cleanText(error?.message, 300) || 'The note was saved, but the crew heartbeat could not be nudged.';
      }
    }
    return {
      note: normalizeWhiteboardNote({
        id,
        content: `[Shared whiteboard note | ${column}]\n${content}`,
        timestamp: createdAt,
        metadata: { kind: 'agent-whiteboard-note', column, actor: normalizedActor, targetAgentId },
      }),
      sessionId,
      heartbeat,
      heartbeatWarning,
    };
  }

  async resolveApproval(approvalId = '', decision = '', actor = '') {
    const normalizedId = cleanText(approvalId, 240);
    const normalizedDecision = cleanText(decision, 40).toLowerCase();
    if (!['approve', 'reject'].includes(normalizedDecision)) {
      throw createAgentOpsError(
        'Decision must be approve or reject.',
        400,
        'invalid_approval_decision',
      );
    }
    if (!this.agentRunService?.performAction) {
      throw createAgentOpsError(
        'No safe AgentRun approval resolver is available.',
        503,
        'approval_resolver_unavailable',
      );
    }
    const runs = await this.listCanonicalRuns(100);
    let resolvedApproval = null;
    let matchedRun = null;
    runs.some((run) => {
      const approval = asArray(run.approvals).find((entry) => entry?.id === normalizedId);
      if (!approval) return false;
      resolvedApproval = approval;
      matchedRun = run;
      return true;
    });
    if (!matchedRun) {
      throw createAgentOpsError('Approval not found.', 404, 'approval_not_found');
    }
    if (cleanText(resolvedApproval.status, 40).toLowerCase() !== 'pending') {
      throw createAgentOpsError('Approval is no longer pending.', 409, 'approval_already_resolved');
    }
    if (normalizedDecision === 'reject') {
      throw createAgentOpsError(
        'Reject is not supported because AgentRun has no rejection transition. The approval remains pending.',
        501,
        'approval_rejection_unsupported',
      );
    }

    const pending = asArray(matchedRun.approvals).filter((approval) => approval?.status === 'pending');
    const pauseApprovalId = cleanText(matchedRun?.snapshot?.pause?.approvalId, 240);
    if (pending.length > 1 && pauseApprovalId && pauseApprovalId !== normalizedId) {
      throw createAgentOpsError(
        'Approval cannot be resolved safely because another approval owns the run pause.',
        409,
        'approval_scope_ambiguous',
      );
    }
    const result = await this.agentRunService.performAction(matchedRun.id, {
      action: 'resume',
      reason: 'Approved from Agent Command Center.',
      approval: {
        id: normalizedId,
        status: 'approved',
      },
      details: {
        approvalId: normalizedId,
        actor: cleanText(actor, 160) || null,
        source: 'agent-ops',
      },
      idempotencyKey: `agent-ops:${normalizedId}:approve`,
    }, matchedRun.ownerId || '');
    if (!result?.run) {
      throw createAgentOpsError('AgentRun approval resolver returned no run.', 502, 'approval_resolution_failed');
    }
    return {
      approvalId: normalizedId,
      decision: normalizedDecision,
      status: 'approved',
      run: result.run,
    };
  }
}

module.exports = {
  AgentOpsService,
  createAgentOpsError,
  normalizeEvidence,
};

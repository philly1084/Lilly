'use strict';

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
    content: content || null,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || source.createdAt || null,
  };
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
    artifactStore = null,
    now = () => new Date(),
  } = {}) {
    this.agentCompanyService = agentCompanyService;
    this.workloadService = workloadService;
    this.agentRunService = agentRunService;
    this.artifactStore = artifactStore;
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
    const sessionId = cleanText(companyStatus?.config?.sessionId, 160);
    const artifacts = sessionId && typeof this.artifactStore?.listBySession === 'function'
      ? asArray(await this.artifactStore.listBySession(sessionId))
      : [];

    return {
      companyStatus: asObject(companyStatus),
      workloads,
      workloadRuns,
      canonicalRuns,
      artifacts,
      workloadAvailable,
    };
  }

  isCompanyWorkload(workload = {}, config = {}, state = {}) {
    const metadata = getCompanyMetadata(workload);
    const sessionId = cleanText(config.sessionId, 160);
    const goalHash = cleanText(state.companyGoalHash || config.companyGoalHash, 160);
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

  deriveAgentStatus(workloadRun = null, canonicalRun = null) {
    if (this.getPendingApproval(canonicalRun)
      || normalizeRunStatus(canonicalRun?.state) === 'waiting_for_approval'
      || normalizeRunStatus(canonicalRun?.state) === 'blocked') {
      return 'needs_input';
    }
    const canonicalState = normalizeRunStatus(canonicalRun?.state);
    const workloadState = normalizeRunStatus(workloadRun?.status);
    if (ACTIVE_RUN_STATES.has(canonicalState) || ACTIVE_RUN_STATES.has(workloadState)) {
      return 'working';
    }
    return 'idle';
  }

  buildAgentSummary({ role = {}, workload = null, run = null, canonicalRun = null, heartbeat = {} } = {}) {
    const now = this.now();
    const companyMetadata = getCompanyMetadata(workload || {});
    const roleId = cleanText(role.id || companyMetadata.roleId || workload?.id, 160);
    const roleName = cleanText(role.name || companyMetadata.roleName || workload?.title || roleId, 200);
    const status = this.deriveAgentStatus(run, canonicalRun);
    const runState = normalizeRunStatus(canonicalRun?.state || run?.status);
    const pendingApproval = this.getPendingApproval(canonicalRun);
    const task = cleanText(workload?.title || role.mission, 500) || null;
    let currentAction = 'Awaiting assignment';
    if (task && status === 'needs_input') currentAction = `Approval needed: ${task}`;
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
      const status = normalizeRunStatus(canonicalRun?.state || run?.status || 'idle');
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

    roleMap.forEach((role, roleId) => {
      if (!candidates.some((candidate) => candidate.id === roleId)) {
        candidates.push(this.buildAgentSummary({ role, heartbeat }));
      }
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
      const rawStatus = normalizeRunStatus(canonicalRun?.state || run?.status || item.status || 'planned');
      let status = rawStatus;
      if (approval || rawStatus === 'waiting_for_approval') status = 'needs_input';
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
          : (approval ? cleanText(approval.reason || approval.title, 500) || 'Approval required.' : null),
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
    const activeProject = asArray(config.projects).find((project) => (
      project.id === config.activeProjectId || project.sessionId === config.sessionId
    )) || null;
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

  async buildSnapshot() {
    const sources = await this.loadSources();
    const config = asObject(sources.companyStatus.config);
    const state = asObject(sources.companyStatus.state);
    const companyWorkloads = sources.workloads.filter((workload) => this.isCompanyWorkload(workload, config, state));
    const indexes = this.buildRunIndexes(companyWorkloads, sources.workloadRuns, sources.canonicalRuns);
    const agents = this.buildAgents(config, state, companyWorkloads, indexes);
    const goalItems = this.buildGoalItems(state, companyWorkloads, indexes);
    const workflows = this.buildWorkflows(companyWorkloads, indexes);
    const heartbeat = this.buildHeartbeat(state, config);
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
    const projectArtifacts = sources.artifacts.map((artifact) => normalizeStoredArtifact(artifact));

    return {
      public: {
        generatedAt: this.now().toISOString(),
        project: this.buildProject(config, state, agents, goalItems),
        heartbeat,
        budget: this.buildBudget(indexes.companyCanonicalRuns),
        groups,
        selectedAgentId,
        goalItems,
        workflows,
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
          heartbeat: typeof this.agentCompanyService?.getStatus === 'function',
          resourceMetrics: false,
          goalCreation: canCreateGoals ? { enabled: true, endpoint: '/goals' } : { enabled: false },
          workspace: {
            enabled: true,
            endpointTemplate: '/agents/{agentId}/workspace',
            panels: ['activity', 'files', 'editor', 'terminal', 'browser', 'artifacts', 'messages'],
          },
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
    const goal = cleanText(
      successCriteria ? `${title}\n\nSuccess criteria:\n${successCriteria}` : title,
      4000,
    );
    const activeProjectId = cleanText(current.activeProjectId, 160);
    const sessionId = cleanText(current.sessionId, 160);
    const now = this.now().toISOString();
    const projects = asArray(current.projects).map((project) => {
      const isActive = (activeProjectId && project.id === activeProjectId)
        || (!activeProjectId && sessionId && project.sessionId === sessionId);
      return isActive ? { ...project, companyGoal: goal, enabled: true, updatedAt: now } : project;
    });
    const config = await settingsController.updateAgentCompanySettings({
      ...current,
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
    const storedArtifacts = snapshot.context.artifacts.filter((artifact) => {
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
    const messages = timeline
      .filter((event) => event.title || event.detail)
      .map((event) => ({
        id: event.id,
        timestamp: event.timestamp,
        from: /handoff/i.test(event.type) ? 'Agent handoff' : agent.name,
        message: [event.title, event.detail].filter(Boolean).join(': '),
        status: event.status,
      }));
    const allArtifacts = [...artifacts, ...recordedOutputs];
    const browser = allArtifacts
      .filter((artifact) => artifact.previewUrl || artifact.url)
      .map((artifact) => ({
        id: artifact.id,
        name: artifact.name || artifact.label,
        detail: artifact.detail || 'Recorded preview',
        url: artifact.previewUrl || artifact.url,
      }));

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
      })),
      editor: artifacts.filter((artifact) => artifact.language && artifact.content),
      terminal,
      browser,
      artifacts: allArtifacts,
      messages,
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

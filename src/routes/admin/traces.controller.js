/**
 * Traces Controller
 * Manages execution traces and timelines
 */

const path = require('path');
const { PROJECT_ROOT, resolvePreferredWritableFile } = require('../../runtime-state-paths');
const {
  appendJsonlRecordSync,
  readJsonlRecordsSync,
  writeJsonlRecordsSync,
} = require('../../observability/jsonl-persistence');
const { summarizeAgentQualityAssessments } = require('../../agent-quality-contract');
const { summarizeEvalRuns } = require('../../agent-evals/runner');
const { readEvalRuns } = require('../../agent-evals/store');

const DEFAULT_AGENT_COMPANY_SESSION_ID = 'agent-company';

function getTracesStoragePath() {
  return resolvePreferredWritableFile(
    path.join(PROJECT_ROOT, 'data', 'observability', 'traces.jsonl'),
    ['observability', 'traces.jsonl'],
  );
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hasContent(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isObject(value)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

function normalizeAgentQuality(value) {
  if (!isObject(value)) {
    return null;
  }

  const status = String(value.status || '').trim();
  const score = Number(value.score);
  const requiredMissing = Array.isArray(value.requiredMissing)
    ? value.requiredMissing.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const surfaces = Array.isArray(value.surfaces)
    ? value.surfaces
        .filter(isObject)
        .map((surface) => ({
          id: String(surface.id || '').trim(),
          label: String(surface.label || surface.id || '').trim(),
          score: Number.isFinite(Number(surface.score)) ? Number(surface.score) : null,
          requiredMissing: Array.isArray(surface.requiredMissing)
            ? surface.requiredMissing.map((entry) => String(entry || '').trim()).filter(Boolean)
            : [],
        }))
    : [];

  return {
    ...value,
    ...(status ? { status } : {}),
    ...(Number.isFinite(score) ? { score } : {}),
    requiredMissing,
    surfaces,
  };
}

function extractAgentQuality(...candidates) {
  for (const candidate of candidates) {
    const quality = normalizeAgentQuality(candidate);
    if (quality) {
      return quality;
    }
  }
  return null;
}

function extractTraceAgentQuality(trace = {}) {
  return extractAgentQuality(
    trace.agentQuality,
    trace.metadata?.agentQuality,
    trace.metadata?.remoteCliAgent?.agentQuality,
    trace.metadata?.activeProject?.remoteCliAgent?.agentQuality,
    trace.result?.agentQuality,
    trace.result?.data?.agentQuality,
  );
}

function extractAgentEval(...candidates) {
  return candidates.find((candidate) => (
    isObject(candidate)
      && (candidate.schemaVersion === 'EvalRun/v1' || Array.isArray(candidate.caseResults))
      && Number(candidate.total || 0) > 0
  )) || null;
}

function extractTraceAgentEval(trace = {}) {
  return extractAgentEval(
    trace.agentEval,
    trace.metadata?.agentEval,
    trace.result?.agentEval,
    trace.result?.data?.agentEval,
  );
}

function toIsoString(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function calculateDuration(startTime, endTime, fallback = 0) {
  const started = startTime ? new Date(startTime).getTime() : NaN;
  const ended = endTime ? new Date(endTime).getTime() : NaN;
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    return ended - started;
  }
  return Math.max(0, Number(fallback || 0));
}

function extractAgentCompanyMetadata(entry = {}) {
  return entry?.metadata?.agentCompany
    || entry?.workload?.metadata?.agentCompany
    || {};
}

function isAgentCompanyRun(run = {}, workload = {}, status = null) {
  const metadata = extractAgentCompanyMetadata(run);
  const workloadMetadata = extractAgentCompanyMetadata(workload);
  const configuredSessionId = status?.config?.sessionId || DEFAULT_AGENT_COMPANY_SESSION_ID;
  return Boolean(
    Object.keys(metadata).length > 0
      || Object.keys(workloadMetadata).length > 0
      || run.sessionId === configuredSessionId
      || workload.sessionId === configuredSessionId,
  );
}

function normalizeTimelineStep(step = {}, index = 0, defaults = {}) {
  const startTime = toIsoString(step.startTime || step.start_time || step.startedAt || step.started_at);
  const endTime = toIsoString(step.endTime || step.end_time || step.endedAt || step.ended_at);
  const duration = calculateDuration(startTime, endTime, step.duration || step.duration_ms || step.offset || 0);

  return {
    step: Number(step.step || index + 1),
    name: step.name || step.type || defaults.name || `Step ${index + 1}`,
    type: step.type || defaults.type || 'execution',
    status: step.status || defaults.status || 'completed',
    startTime: startTime || defaults.startTime || null,
    endTime: endTime || defaults.endTime || null,
    duration,
    details: isObject(step.details) ? step.details : {
      ...(hasContent(step) ? { trace: step } : {}),
    },
  };
}

function extractTimelineFromRunTrace(trace = {}, run = {}, workload = {}) {
  if (Array.isArray(trace)) {
    return trace.map((step, index) => normalizeTimelineStep(step, index));
  }

  const traceSteps = Array.isArray(trace?.timeline)
    ? trace.timeline
    : Array.isArray(trace?.steps)
      ? trace.steps
      : Array.isArray(trace?.executionTrace)
        ? trace.executionTrace
        : [];

  if (traceSteps.length > 0) {
    return traceSteps.map((step, index) => normalizeTimelineStep(step, index));
  }

  if (hasContent(trace)) {
    return [normalizeTimelineStep({
      name: trace.structuredExecution
        ? `Structured execution (${trace.toolId || 'tool'})`
        : trace.artifactOnly
          ? `Artifact generation (${trace.outputFormat || 'artifact'})`
          : 'Workload execution trace',
      type: trace.structuredExecution ? 'structured_execution' : 'execution',
      status: run.status === 'failed' ? 'failed' : 'completed',
      details: trace,
    }, 0)];
  }

  return [{
    step: 1,
    name: workload?.title ? `Workload run (${workload.title})` : 'Workload run',
    type: 'workload_run',
    status: run.status || 'queued',
    startTime: toIsoString(run.startedAt || run.createdAt || run.scheduledFor),
    endTime: toIsoString(run.finishedAt || run.updatedAt),
    duration: calculateDuration(run.startedAt || run.createdAt || run.scheduledFor, run.finishedAt || run.updatedAt),
    details: {
      workloadId: run.workloadId || workload?.id || null,
      runId: run.id,
      reason: run.reason || null,
    },
  }];
}

function getTraceStatusForAgentQuality(quality = {}) {
  const status = String(quality.status || '').trim().toLowerCase();
  if (status === 'passed') {
    return 'completed';
  }
  if (status === 'blocked' || status === 'needs_work') {
    return 'error';
  }
  return 'info';
}

function buildAgentQualityTimelineStep(agentQuality = {}, index = 0) {
  if (!agentQuality) {
    return null;
  }
  const score = Number(agentQuality.score);
  const scoreLabel = Number.isFinite(score) ? `${Math.round(score * 100)}%` : 'unscored';
  const missing = Array.isArray(agentQuality.requiredMissing) ? agentQuality.requiredMissing : [];

  return normalizeTimelineStep({
    step: index + 1,
    name: 'Agent quality gates',
    type: 'quality_gate',
    status: getTraceStatusForAgentQuality(agentQuality),
    details: {
      agentQuality,
      qualityStatus: agentQuality.status || 'unknown',
      qualityScore: scoreLabel,
      requiredMissing: missing,
    },
  }, index);
}

function buildTraceName(title = '', roleName = '') {
  const normalizedTitle = String(title || 'Agent company work').trim() || 'Agent company work';
  const normalizedRole = String(roleName || '').trim();
  if (!normalizedRole) {
    return normalizedTitle;
  }
  return normalizedTitle.toLowerCase().startsWith(`${normalizedRole.toLowerCase()}:`)
    ? normalizedTitle
    : `${normalizedRole}: ${normalizedTitle}`;
}

function buildAgentCompanyRunTrace(run = {}, workload = {}) {
  const metadata = extractAgentCompanyMetadata(run);
  const workloadMetadata = extractAgentCompanyMetadata(workload);
  const agentCompany = Object.keys(metadata).length > 0 ? metadata : workloadMetadata;
  const roleName = agentCompany.roleName || agentCompany.roleId || '';
  const title = workload?.title || run.workloadTitle || 'Agent company work';
  const startedAt = toIsoString(run.startedAt || run.createdAt || run.scheduledFor);
  const endedAt = toIsoString(run.finishedAt || run.updatedAt);
  const agentQuality = extractAgentQuality(
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
    workload.agentQuality,
    workload.metadata?.agentQuality,
    workload.metadata?.remoteCliAgent?.agentQuality,
  );
  const agentEval = extractAgentEval(
    run.agentEval,
    run.metadata?.agentEval,
    run.result?.agentEval,
    run.result?.data?.agentEval,
    run.trace?.agentEval,
    workload.agentEval,
    workload.metadata?.agentEval,
  );
  const baseTimeline = extractTimelineFromRunTrace(run.trace || {}, run, workload);
  const agentQualityStep = buildAgentQualityTimelineStep(agentQuality, baseTimeline.length);
  const timeline = agentQualityStep ? [...baseTimeline, agentQualityStep] : baseTimeline;
  const output = String(run.metadata?.output?.text || run.metadata?.output?.artifactMessage || '').slice(0, 4000);

  return {
    id: `trace-workload-run-${run.id}`,
    taskId: run.id,
    workloadId: run.workloadId || workload?.id || null,
    runId: run.id,
    sessionId: run.sessionId || workload?.sessionId || DEFAULT_AGENT_COMPANY_SESSION_ID,
    name: buildTraceName(title, roleName),
    source: 'agent-company-workload',
    status: run.status || 'queued',
    startTime: startedAt || endedAt || new Date().toISOString(),
    endTime: endedAt || startedAt || new Date().toISOString(),
    duration: calculateDuration(startedAt, endedAt, run.trace?.duration || run.trace?.durationMs || 0),
    model: run.metadata?.requestedModel || workload?.metadata?.requestedModel || 'agent-workload',
    input: run.prompt || workload?.prompt || '',
    output,
    timeline,
    metrics: {
      attempts: Number(run.attempt || 0),
      artifacts: Array.isArray(run.metadata?.output?.artifacts) ? run.metadata.output.artifacts.length : 0,
      steps: timeline.length,
      ...(agentQuality ? {
        agentQualityScore: agentQuality.score,
        agentQualityStatus: agentQuality.status || 'unknown',
        agentQualityRequiredMissing: agentQuality.requiredMissing || [],
      } : {}),
    },
    metadata: {
      agentCompany,
      ...(agentQuality ? { agentQuality } : {}),
      ...(agentEval ? { agentEval } : {}),
      workloadId: run.workloadId || workload?.id || null,
      workloadTitle: title,
      runId: run.id,
      runStatus: run.status || 'queued',
      reason: run.reason || null,
      output: run.metadata?.output || null,
    },
    createdAt: run.createdAt || startedAt || endedAt || new Date().toISOString(),
  };
}

function filterTraces(traces = [], { status, model, from, to } = {}) {
  let filtered = traces;

  if (status && status !== 'all') {
    filtered = filtered.filter(t => t.status === status);
  }

  if (model && model !== 'all') {
    filtered = filtered.filter(t => t.model === model);
  }

  if (from) {
    const fromDate = new Date(from);
    filtered = filtered.filter(t => new Date(t.startTime) >= fromDate);
  }

  if (to) {
    const toDate = new Date(to);
    filtered = filtered.filter(t => new Date(t.endTime) <= toDate);
  }

  return filtered;
}

class TracesController {
  constructor(options = {}) {
    this.storagePath = path.resolve(options.storagePath || getTracesStoragePath());
    this.traces = new Map(
      readJsonlRecordsSync(this.storagePath)
        .filter((trace) => trace?.id)
        .map((trace) => [trace.id, trace]),
    );
  }

  async listAgentCompanyRunTraces(req, limit = 200) {
    const workloadService = req?.app?.locals?.agentWorkloadService;
    if (!workloadService?.isAvailable?.() || !workloadService?.listAdminRuns || !workloadService?.listAdminWorkloads) {
      return [];
    }

    let status = null;
    try {
      status = await req?.app?.locals?.agentCompanyService?.getStatus?.();
    } catch (error) {
      console.warn('[Traces] Failed to read agent company status for traces:', error.message);
    }

    try {
      const [workloads, runs] = await Promise.all([
        workloadService.listAdminWorkloads(limit),
        workloadService.listAdminRuns(limit),
      ]);
      const workloadById = new Map((Array.isArray(workloads) ? workloads : [])
        .filter((workload) => workload?.id)
        .map((workload) => [workload.id, workload]));

      return (Array.isArray(runs) ? runs : [])
        .filter((run) => run?.id)
        .map((run) => ({
          run,
          workload: run.workload || workloadById.get(run.workloadId) || {},
        }))
        .filter(({ run, workload }) => isAgentCompanyRun(run, workload, status))
        .map(({ run, workload }) => buildAgentCompanyRunTrace(run, workload));
    } catch (error) {
      console.warn('[Traces] Failed to include agent company workload traces:', error.message);
      return [];
    }
  }

  async buildTraceList(req, { workloadLimit = 200 } = {}) {
    const traces = [
      ...Array.from(this.traces.values()),
      ...await this.listAgentCompanyRunTraces(req, workloadLimit),
    ];
    const byId = new Map();
    traces.forEach((trace) => {
      if (trace?.id) {
        byId.set(trace.id, trace);
      }
    });
    return Array.from(byId.values());
  }

  /**
   * Get all traces
   */
  async getAll(req, res) {
    try {
      const { status, model, from, to, page = 1, limit = 20 } = req.query;
      const pageNumber = Math.max(1, parseInt(page, 10) || 1);
      const pageLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 200));

      let traces = filterTraces(await this.buildTraceList(req), {
        status,
        model,
        from,
        to,
      });

      // Sort by start time descending
      traces.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

      // Pagination
      const total = traces.length;
      const agentQualitySummary = summarizeAgentQualityAssessments(traces.map(extractTraceAgentQuality));
      const traceEvalRuns = traces.map(extractTraceAgentEval).filter(Boolean);
      const recordedEvalRuns = readEvalRuns({ limit: 100 });
      const evalRunByKey = new Map();
      [...traceEvalRuns, ...recordedEvalRuns].forEach((run) => {
        const key = String(run.id || `${run.label || 'eval'}:${run.createdAt || ''}:${run.total || 0}`);
        evalRunByKey.set(key, run);
      });
      const agentEvalSummary = summarizeEvalRuns(Array.from(evalRunByKey.values()));
      const offset = (pageNumber - 1) * pageLimit;
      const paginated = traces.slice(offset, offset + pageLimit);

      res.json({
        success: true,
        data: paginated,
        meta: {
          agentQualitySummary,
          agentEvalSummary,
        },
        pagination: {
          total,
          page: pageNumber,
          limit: pageLimit,
          totalPages: Math.ceil(total / pageLimit)
        }
      });
    } catch (error) {
      console.error('Error getting traces:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get trace by ID
   */
  async getById(req, res) {
    try {
      const { id } = req.params;
      const trace = this.traces.get(id)
        || (await this.buildTraceList(req)).find((entry) => entry.id === id);

      if (!trace) {
        return res.status(404).json({ success: false, error: 'Trace not found' });
      }

      res.json({ success: true, data: trace });
    } catch (error) {
      console.error('Error getting trace:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get trace timeline
   */
  async getTimeline(req, res) {
    try {
      const { id } = req.params;
      const trace = this.traces.get(id)
        || (await this.buildTraceList(req)).find((entry) => entry.id === id);

      if (!trace) {
        return res.status(404).json({ success: false, error: 'Trace not found' });
      }
      const timeline = Array.isArray(trace.timeline) ? trace.timeline : [];

      res.json({
        success: true,
        data: {
          traceId: id,
          timeline,
          totalSteps: timeline.length,
          duration: trace.duration
        }
      });
    } catch (error) {
      console.error('Error getting timeline:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Delete trace
   */
  async remove(req, res) {
    try {
      const { id } = req.params;

      if (!this.traces.has(id)) {
        return res.status(404).json({ success: false, error: 'Trace not found' });
      }

      this.traces.delete(id);
      writeJsonlRecordsSync(this.storagePath, Array.from(this.traces.values()));

      res.json({ success: true, data: { id, deleted: true } });
    } catch (error) {
      console.error('Error deleting trace:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Export traces
   */
  async export(req, res) {
    try {
      const { format } = req.params;
      const { status, from, to } = req.query;

      let traces = filterTraces(await this.buildTraceList(req), { status, from, to });

      switch (format) {
        case 'json':
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', 'attachment; filename="traces.json"');
          res.json(traces);
          break;

        case 'markdown':
          res.setHeader('Content-Type', 'text/markdown');
          res.setHeader('Content-Disposition', 'attachment; filename="traces.md"');
          
          let md = '# Agent SDK Traces\n\n';
          traces.forEach(trace => {
            md += `## Trace ${trace.id}\n\n`;
            md += `- **Status:** ${trace.status}\n`;
            md += `- **Model:** ${trace.model}\n`;
            md += `- **Duration:** ${trace.duration}ms\n`;
          const agentQuality = extractTraceAgentQuality(trace);
            if (agentQuality) {
              const score = Number(agentQuality.score);
              const scoreLabel = Number.isFinite(score) ? `${Math.round(score * 100)}%` : 'unscored';
              md += `- **Agent Quality:** ${agentQuality.status || 'unknown'} (${scoreLabel})\n`;
              if (agentQuality.requiredMissing?.length) {
                md += `- **Missing Quality Gates:** ${agentQuality.requiredMissing.join(', ')}\n`;
              }
            }
            md += `- **Start:** ${trace.startTime}\n\n`;
            md += '### Timeline\n\n';
            (trace.timeline || []).forEach(step => {
              md += `#### ${step.step}. ${step.name}\n`;
              md += `- Type: ${step.type}\n`;
              md += `- Status: ${step.status}\n`;
              md += `- Duration: ${step.duration}ms\n\n`;
            });
            md += '---\n\n';
          });
          
          res.send(md);
          break;

        default:
          res.status(400).json({ success: false, error: 'Unsupported format' });
      }
    } catch (error) {
      console.error('Error exporting traces:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Add trace (called by other controllers)
   */
  addTrace(trace) {
    this.traces.set(trace.id, trace);
    appendJsonlRecordSync(this.storagePath, trace);
  }
}

module.exports = new TracesController();
module.exports.TracesController = TracesController;
module.exports.getTracesStoragePath = getTracesStoragePath;

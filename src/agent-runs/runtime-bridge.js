'use strict';

const { createHash } = require('crypto');
const {
  AGENT_RUN_VERSION,
  LEGAL_AGENT_RUN_TRANSITIONS,
  TERMINAL_AGENT_RUN_STATES,
  normalizeAgentRunState,
} = require('./constants');
const { captureLegacyAgentRun } = require('./compatibility');
const { AgentRunService, buildAgentRunControlState } = require('./service');
const { boundString, redactAndBound } = require('./redaction');
const { normalizeEvidenceAttestation } = require('../agent-evidence');
const { validateToolInvocation } = require('../tool-invocation');

const AGENT_RUN_EVENT_VERSION = 'AgentRunEvent/v1';
const DEFAULT_SURFACE = 'legacy-runtime';
let defaultAgentRunService = null;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function compactObjective(value = '') {
  return boundString(normalizeText(value) || 'Agent run', 12000);
}

function payloadSignalsAgentRunFailure(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const candidates = [payload, payload.data, payload.response]
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  return candidates.some((entry) => {
    const type = normalizeText(entry.type || entry.event).toLowerCase();
    const status = normalizeText(entry.status || entry.state).toLowerCase();
    const statusCode = Number(
      entry.statusCode
      ?? entry.status_code
      ?? entry.httpStatus
      ?? entry.http_status
      ?? (/^\d{3}$/.test(String(entry.status || '')) ? entry.status : NaN),
    );
    const error = entry.error;
    const hasError = error !== undefined
      && error !== null
      && error !== false
      && (typeof error !== 'string' || error.trim() !== '');
    return hasError
      || Boolean(normalizeText(entry.errorCode || entry.error_code))
      || Number.isFinite(statusCode) && statusCode >= 400
      || ['error', 'failed', 'failure'].includes(status)
      || type === 'error'
      || type.endsWith('.error')
      || type.endsWith('.failed');
  });
}

function setDefaultAgentRunService(service = null) {
  if (service?.createRun && service?.transitionRun) {
    defaultAgentRunService = service;
  }
  return defaultAgentRunService;
}

function createSharedFallbackService() {
  if (defaultAgentRunService) {
    return defaultAgentRunService;
  }

  // The fallback deliberately reuses Async Lab's existing store. This keeps
  // context-free runtimes (notably the remote runner singleton) on the same
  // persistence kernel instead of introducing another run database.
  const { asyncLabService } = require('../async-lab/service');
  defaultAgentRunService = new AgentRunService({ store: asyncLabService.store });
  return defaultAgentRunService;
}

function resolveAgentRunService(options = {}) {
  const candidate = options.agentRunService
    || options.service
    || options.app?.locals?.agentRunService
    || options.req?.app?.locals?.agentRunService
    || options.conversationRunService?.app?.locals?.agentRunService
    || (options.allowSharedFallback === false ? null : defaultAgentRunService);
  if (candidate?.createRun && candidate?.transitionRun) {
    return setDefaultAgentRunService(candidate);
  }
  return options.allowSharedFallback === false ? null : createSharedFallbackService();
}

function firstIdentifier(...values) {
  return values.map(normalizeText).find(Boolean) || '';
}

function deriveSurfaceSourceId(input = {}) {
  const direct = firstIdentifier(
    input.sourceId,
    input.responseId,
    input.jobId,
    input.requestId,
    input.messageId,
    input.runId,
  );
  if (direct) {
    return direct;
  }

  const sessionId = firstIdentifier(input.sessionId, input.session_id);
  const operation = firstIdentifier(input.operation, input.type, input.mode, input.surface, 'request');
  const nonce = firstIdentifier(input.nonce, input.startedAt, input.createdAt);
  if (sessionId && nonce) {
    return `${sessionId}:${operation}:${nonce}`;
  }
  if (sessionId) {
    const objectiveDigest = createHash('sha256')
      .update(compactObjective(input.objective || input.task || input.prompt || input.message))
      .digest('hex')
      .slice(0, 20);
    return `${sessionId}:${operation}:${objectiveDigest}`;
  }
  return '';
}

function buildShadowIdempotencyKey(surface = DEFAULT_SURFACE, sourceId = '') {
  const normalizedSurface = normalizeText(surface) || DEFAULT_SURFACE;
  const normalizedSource = normalizeText(sourceId);
  if (!normalizedSource) {
    return '';
  }
  const digest = createHash('sha256')
    .update(`${normalizedSurface}:${normalizedSource}`)
    .digest('hex');
  return `shadow:${normalizedSurface}:${digest}`;
}

function warnCaptureFailure(logger = console, surface = DEFAULT_SURFACE, error = null) {
  const warning = logger?.warn;
  if (typeof warning === 'function') {
    warning.call(
      logger,
      `[AgentRunShadow] ${surface} capture failed without affecting the legacy request: ${error?.message || error}`,
    );
  }
}

function findTransitionPath(fromState = 'created', targetState = 'created') {
  const from = normalizeAgentRunState(fromState, 'created');
  const target = normalizeAgentRunState(targetState, 'created');
  if (from === target) {
    return [];
  }

  const lifecycle = ['created', 'planning', 'executing', 'verifying', 'completed'];
  const fromIndex = lifecycle.indexOf(from);
  const targetIndex = lifecycle.indexOf(target);
  if (fromIndex >= 0 && targetIndex > fromIndex) {
    return lifecycle.slice(fromIndex + 1, targetIndex + 1);
  }

  const queue = [[from, []]];
  const visited = new Set([from]);
  while (queue.length > 0) {
    const [state, path] = queue.shift();
    const nextStates = Array.from(LEGAL_AGENT_RUN_TRANSITIONS[state] || []);
    for (const nextState of nextStates) {
      if (nextState === target) {
        return [...path, nextState];
      }
      if (!visited.has(nextState) && !TERMINAL_AGENT_RUN_STATES.has(nextState)) {
        visited.add(nextState);
        queue.push([nextState, [...path, nextState]]);
      }
    }
  }
  return [];
}

function buildAgentRunEnvelope(handle = null, options = {}) {
  const run = handle?.run || handle;
  const runId = normalizeText(run?.id || handle?.runId);
  if (!runId) {
    return null;
  }
  const state = normalizeAgentRunState(options.state || run?.state, 'created');
  const control = handle?.controlState
    || run?.control
    || buildAgentRunControlState({ status: state }, { approvals: run?.approvals || [] }, state);
  return redactAndBound({
    version: AGENT_RUN_VERSION,
    id: runId,
    state,
    surface: normalizeText(options.surface || handle?.surface || run?.surface) || DEFAULT_SURFACE,
    eventCursor: Number(run?.eventCursor || run?.snapshot?.eventCursor || 0),
    control,
    shadow: true,
    canonical: true,
  });
}

function buildAgentRunEvent(handle = null, options = {}) {
  const agentRun = buildAgentRunEnvelope(handle, options);
  if (!agentRun) {
    return null;
  }
  return {
    version: AGENT_RUN_EVENT_VERSION,
    runId: agentRun.id,
    type: normalizeText(options.eventType) || 'surface.event',
    state: agentRun.state,
    surface: agentRun.surface,
    sequence: agentRun.eventCursor || null,
  };
}

function attachAgentRunMetadata(payload, handle = null, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const agentRun = buildAgentRunEnvelope(handle, options);
  if (!agentRun) {
    return payload;
  }
  recordSurfaceAgentRunPayload(handle, payload);
  const agentRunEvent = buildAgentRunEvent(handle, options);
  const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
    ? payload.metadata
    : {};
  return {
    ...payload,
    ...(payload.runId ? { agentRunId: agentRun.id } : { runId: agentRun.id }),
    agentRun,
    agentRunEvent,
    metadata: {
      ...metadata,
      agentRun,
      agentRunEvent,
    },
  };
}

function normalizeSurfaceOutput(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = firstIdentifier(value.id, value.artifactId, value.artifact_id);
  const url = firstIdentifier(value.previewUrl, value.preview_url, value.downloadUrl, value.download_url, value.url);
  const filename = firstIdentifier(value.filename, value.name, value.title);
  if (!id && !url && !filename) return null;
  return redactAndBound({
    type: normalizeText(value.type || value.format) || 'artifact',
    id: id || null,
    title: filename || 'Artifact',
    filename: normalizeText(value.filename) || null,
    format: normalizeText(value.format) || null,
    previewUrl: url || null,
    missionId: normalizeText(value.missionId || value.mission_id) || null,
    parentArtifactId: normalizeText(value.parentArtifactId || value.parent_artifact_id) || null,
    revision: value.revision ?? null,
  });
}

function extractAgentRunCompletionData(payload = {}, options = {}) {
  const evidence = [];
  const invocations = [];
  const artifacts = [];
  const runId = normalizeText(options.runId || options.agentRunId);
  const seen = new WeakSet();
  const visit = (value, depth = 0, key = '') => {
    if (!value || depth > 10) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1, key));
      return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (value.version === 'ToolInvocation/v2' && validateToolInvocation(value).valid) {
      if (!runId || value.runId !== runId) {
        return;
      }
      const boundEvidence = value.evidence.map((entry) => normalizeEvidenceAttestation(entry));
      if (boundEvidence.some((entry) => entry?.sourceInvocationId !== value.id)) {
        return;
      }
      invocations.push(value);
      evidence.push(...boundEvidence);
      return;
    }
    if (['artifact', 'artifacts', 'outputs'].includes(key)) {
      const artifact = normalizeSurfaceOutput(value);
      if (artifact) artifacts.push(artifact);
    }
    Object.entries(value).forEach(([entryKey, entry]) => visit(entry, depth + 1, entryKey));
  };
  visit(payload);
  const uniqueBy = (items, keyBuilder) => {
    const keys = new Set();
    return items.filter((item) => {
      const key = keyBuilder(item);
      if (!key || keys.has(key)) return false;
      keys.add(key);
      return true;
    });
  };
  const usage = payload?.usage
    || payload?.metadata?.usage
    || payload?.assistantMetadata?.usage
    || payload?.assistant_metadata?.usage
    || null;
  return {
    evidence: uniqueBy(evidence, (entry) => entry.digest),
    invocations: uniqueBy(invocations, (entry) => entry.id),
    outputs: uniqueBy(artifacts, (entry) => entry.id || entry.previewUrl || entry.filename),
    usage: usage && typeof usage === 'object' ? redactAndBound(usage) : null,
  };
}

function recordSurfaceAgentRunPayload(handle = null, payload = {}) {
  if (!handle?.run?.id || !payload || typeof payload !== 'object') return handle;
  const incoming = extractAgentRunCompletionData(payload, { runId: handle.run.id });
  const current = handle.completionData || { evidence: [], invocations: [], outputs: [], usage: null };
  const mergeUnique = (left, right, keyBuilder) => {
    const merged = [...left];
    const keys = new Set(left.map(keyBuilder));
    right.forEach((entry) => {
      const key = keyBuilder(entry);
      if (key && !keys.has(key)) {
        keys.add(key);
        merged.push(entry);
      }
    });
    return merged;
  };
  handle.completionData = {
    evidence: mergeUnique(current.evidence || [], incoming.evidence, (entry) => entry.digest),
    invocations: mergeUnique(current.invocations || [], incoming.invocations, (entry) => entry.id),
    outputs: mergeUnique(current.outputs || [], incoming.outputs, (entry) => entry.id || entry.previewUrl || entry.filename),
    usage: incoming.usage || current.usage || null,
  };
  return handle;
}

async function beginSurfaceAgentRun(options = {}) {
  const surface = normalizeText(options.surface) || DEFAULT_SURFACE;
  const logger = options.logger || console;
  try {
    const service = resolveAgentRunService(options);
    if (!service) {
      return null;
    }
    const sourceId = deriveSurfaceSourceId(options);
    const idempotencyKey = normalizeText(options.idempotencyKey)
      || buildShadowIdempotencyKey(surface, sourceId);
    const requestedState = normalizeAgentRunState(options.state, 'executing');
    const existingRunId = firstIdentifier(
      options.existingRunId,
      options.agentRunId,
      options.agent_run_id,
    );
    if (existingRunId && typeof service.getRun === 'function') {
      const existingRun = await service.getRun(existingRunId, normalizeText(options.ownerId));
      if (existingRun) {
        const handle = {
          service,
          surface: normalizeText(existingRun.surface) || surface,
          sourceId: sourceId || existingRunId,
          ownerId: normalizeText(options.ownerId || existingRun.ownerId),
          idempotencyKey: idempotencyKey || `adopt:${existingRunId}`,
          run: existingRun,
          controlState: existingRun.control || null,
          duplicate: true,
          adopted: true,
          logger,
        };
        return existingRun.state === requestedState
          ? handle
          : advanceSurfaceAgentRun(handle, requestedState, {
              reason: `Adopted existing AgentRun for ${surface}.`,
              details: { adopted: true, sourceId: sourceId || null },
            });
      }
    }
    const result = await captureLegacyAgentRun(service, {
      id: sourceId || undefined,
      sessionId: options.sessionId || null,
      ownerId: options.ownerId || null,
      objective: compactObjective(options.objective || options.task || options.prompt || options.message),
      surface,
      mode: options.mode || 'agent',
      status: requestedState,
      metadata: options.metadata || {},
    }, {
      legacySourceId: sourceId || undefined,
      sessionId: options.sessionId || null,
      ownerId: options.ownerId || null,
      objective: compactObjective(options.objective || options.task || options.prompt || options.message),
      surface,
      mode: options.mode || 'agent',
      state: requestedState,
      idempotencyKey,
      snapshot: {
        shadow: true,
        sourceId: sourceId || null,
        ...(options.snapshot && typeof options.snapshot === 'object' ? options.snapshot : {}),
      },
    });
    const handle = {
      service,
      surface,
      sourceId,
      ownerId: normalizeText(options.ownerId),
      idempotencyKey,
      run: result.run,
      controlState: result.run?.control || null,
      duplicate: result.duplicate === true,
      logger,
    };

    if (handle.run?.state !== requestedState) {
      return advanceSurfaceAgentRun(handle, requestedState, {
        reason: 'Aligned canonical shadow state with the legacy runtime.',
      });
    }
    return handle;
  } catch (error) {
    warnCaptureFailure(logger, surface, error);
    return null;
  }
}

async function advanceSurfaceAgentRun(handle = null, targetState = '', options = {}) {
  if (!handle?.service || !handle?.run?.id) {
    return handle || null;
  }
  const logger = options.logger || handle.logger || console;
  const surface = normalizeText(options.surface || handle.surface) || DEFAULT_SURFACE;
  const completionData = handle.completionData || {};
  try {
    const latest = await handle.service.getRun(handle.run.id, handle.ownerId || '');
    if (!latest) {
      return handle;
    }
    const target = normalizeAgentRunState(targetState, latest.state);
    const controlState = latest.control
      || (typeof handle.service.getControlState === 'function'
        ? await handle.service.getControlState(latest.id, handle.ownerId || '')
        : buildAgentRunControlState({ status: latest.state }, { approvals: latest.approvals || [] }, latest.state));
    handle.controlState = controlState;
    if (latest.state === target || TERMINAL_AGENT_RUN_STATES.has(latest.state)) {
      handle.run = latest;
      return handle;
    }
    if (controlState?.canAdvance === false && target !== 'cancelled') {
      handle.run = latest;
      return handle;
    }
    const authoritativeCompletion = extractAgentRunCompletionData({
      invocations: [
        ...(Array.isArray(completionData.invocations) ? completionData.invocations : []),
        ...(Array.isArray(options.invocations) ? options.invocations : []),
      ],
    }, { runId: latest.id });
    const path = findTransitionPath(latest.state, target);
    if (path.length === 0) {
      return handle;
    }

    let run = latest;
    for (const state of path) {
      const transition = await handle.service.transitionRun(run.id, state, {
        ownerId: handle.ownerId || '',
        eventType: 'run.shadow_state',
        reason: boundString(options.reason || `Legacy ${surface} runtime reached ${state}.`, 1000),
        idempotencyKey: `${handle.idempotencyKey}:${state}`,
        details: redactAndBound({
          shadow: true,
          surface,
          sourceId: handle.sourceId || null,
          ...(options.details && typeof options.details === 'object' ? options.details : {}),
        }),
        ...(state === 'completed' || state === 'failed' || state === 'cancelled'
          ? {
              completion: {
                status: state,
                reason: boundString(options.reason || '', 1000),
                at: new Date().toISOString(),
              },
            }
          : {}),
        ...(options.usage || completionData.usage ? { usage: options.usage || completionData.usage } : {}),
        ...(options.outputs || completionData.outputs?.length > 0
          ? { outputs: options.outputs || completionData.outputs }
          : {}),
        evidence: authoritativeCompletion.evidence,
        invocations: authoritativeCompletion.invocations,
        snapshot: {
          shadow: true,
          sourceId: handle.sourceId || null,
          legacyDetails: redactAndBound(options.details || {}),
        },
      });
      if (!transition?.run) {
        break;
      }
      run = transition.run;
      handle.controlState = run.control || handle.controlState;
    }
    handle.run = run;
    return handle;
  } catch (error) {
    warnCaptureFailure(logger, surface, error);
    return handle;
  }
}

function attachSseAgentRunMetadata(chunk, handle = null, options = {}) {
  if (!handle?.run?.id || chunk == null) {
    return chunk;
  }
  const wasBuffer = Buffer.isBuffer(chunk);
  const source = wasBuffer ? chunk.toString('utf8') : String(chunk);
  if (!source.includes('data:')) {
    return chunk;
  }
  const transformed = source.split(/(\r?\n)/).map((line) => {
    if (!line.startsWith('data:')) {
      return line;
    }
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') {
      return line;
    }
    try {
      const payload = JSON.parse(raw);
      if (typeof options.onPayload === 'function') {
        options.onPayload(payload);
      }
      recordSurfaceAgentRunPayload(handle, payload);
      return `data: ${JSON.stringify(attachAgentRunMetadata(payload, handle, options))}`;
    } catch (_error) {
      return line;
    }
  }).join('');
  return wasBuffer ? Buffer.from(transformed, 'utf8') : transformed;
}

function installHttpAgentRunResponseBridge(req, res, handle = null, options = {}) {
  if (!handle?.run?.id || !res) {
    return handle;
  }
  let ended = false;
  let terminalScheduled = false;
  let payloadFailureObserved = false;
  const eventType = normalizeText(options.eventType) || 'surface.response';
  const originalJson = typeof res.json === 'function' ? res.json.bind(res) : null;
  const originalWrite = typeof res.write === 'function' ? res.write.bind(res) : null;
  const originalEnd = typeof res.end === 'function' ? res.end.bind(res) : null;
  const observePayload = (payload = {}) => {
    if (payloadSignalsAgentRunFailure(payload)) {
      payloadFailureObserved = true;
    }
  };

  const scheduleTerminal = (state = '') => {
    if (terminalScheduled) {
      return;
    }
    terminalScheduled = true;
    const target = state || (payloadFailureObserved || Number(res.statusCode || 200) >= 400
      ? 'failed'
      : 'completed');
    void advanceSurfaceAgentRun(handle, target, {
      reason: `HTTP ${normalizeText(req?.method) || 'request'} completed with status ${res.statusCode || 200}.`,
      details: {
        method: req?.method || '',
        path: req?.originalUrl || req?.url || req?.path || '',
        statusCode: Number(res.statusCode || 200),
      },
    });
  };

  if (originalJson) {
    res.json = (payload) => {
      observePayload(payload);
      recordSurfaceAgentRunPayload(handle, payload);
      scheduleTerminal();
      return originalJson(attachAgentRunMetadata(payload, handle, { eventType }));
    };
  }
  if (originalWrite) {
    res.write = (chunk, ...args) => originalWrite(
      attachSseAgentRunMetadata(chunk, handle, {
        eventType: 'surface.stream_event',
        onPayload: observePayload,
      }),
      ...args,
    );
  }
  if (originalEnd) {
    res.end = (chunk, ...args) => {
      ended = true;
      scheduleTerminal();
      const nextChunk = chunk == null
        ? chunk
        : attachSseAgentRunMetadata(chunk, handle, {
            eventType: 'surface.stream_event',
            onPayload: observePayload,
          });
      return originalEnd(nextChunk, ...args);
    };
  }
  if (typeof res.once === 'function') {
    res.once('close', () => {
      if (!ended && !terminalScheduled) {
        scheduleTerminal('cancelled');
      }
    });
  }
  res.locals = res.locals || {};
  res.locals.agentRunShadow = handle;
  return handle;
}

async function startHttpAgentRunShadow(req, res, options = {}) {
  const handle = await beginSurfaceAgentRun({
    ...options,
    req,
    app: options.app || req?.app,
    ownerId: options.ownerId || req?.user?.username || null,
    existingRunId: options.existingRunId
      || req?.body?.agentRunId
      || req?.body?.agent_run_id
      || req?.body?.metadata?.agentRunId
      || req?.body?.metadata?.agent_run_id
      || null,
  });
  return installHttpAgentRunResponseBridge(req, res, handle, options);
}

module.exports = {
  AGENT_RUN_EVENT_VERSION,
  advanceSurfaceAgentRun,
  attachAgentRunMetadata,
  attachSseAgentRunMetadata,
  beginSurfaceAgentRun,
  buildAgentRunEnvelope,
  buildAgentRunEvent,
  buildShadowIdempotencyKey,
  deriveSurfaceSourceId,
  extractAgentRunCompletionData,
  findTransitionPath,
  installHttpAgentRunResponseBridge,
  payloadSignalsAgentRunFailure,
  recordSurfaceAgentRunPayload,
  resolveAgentRunService,
  setDefaultAgentRunService,
  startHttpAgentRunShadow,
};

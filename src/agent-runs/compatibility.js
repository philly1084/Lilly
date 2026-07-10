'use strict';

const {
  AGENT_RUN_VERSION,
  normalizeAgentRunState,
} = require('./constants');
const { boundString, redactAndBound } = require('./redaction');

const LEGACY_STATE_ALIASES = Object.freeze({
  queued: 'created',
  pending: 'created',
  initialized: 'created',
  running: 'executing',
  in_progress: 'executing',
  active: 'executing',
  awaiting_approval: 'waiting_for_approval',
  paused: 'waiting_for_approval',
  waiting: 'waiting_for_approval',
  success: 'completed',
  complete: 'completed',
  succeeded: 'completed',
  error: 'failed',
  errored: 'failed',
  canceled: 'cancelled',
});

function normalizeLegacyState(value = '', fallback = 'created') {
  const candidate = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return normalizeAgentRunState(LEGACY_STATE_ALIASES[candidate] || candidate, fallback);
}

function firstText(...values) {
  const value = values.find((entry) => typeof entry === 'string' && entry.trim());
  return value ? value.trim() : '';
}

function legacySourceId(legacy = {}, overrides = {}) {
  return firstText(
    overrides.legacySourceId,
    overrides.traceId,
    legacy.traceId,
    legacy.trace_id,
    legacy.responseId,
    legacy.response_id,
    legacy.runId,
    legacy.run_id,
    legacy.id,
  );
}

function buildLegacyAgentRunInput(legacy = {}, overrides = {}) {
  const source = redactAndBound(legacy || {});
  const additions = redactAndBound(overrides || {});
  const sourceId = legacySourceId(source, additions);
  const requestedState = normalizeLegacyState(
    additions.state || source.state || source.status,
    'created',
  );
  const idempotencyKey = firstText(
    additions.idempotencyKey,
    additions.idempotency_key,
    source.agentRunIdempotencyKey,
    source.agent_run_idempotency_key,
  ) || (sourceId ? `legacy:${sourceId}` : '');

  return redactAndBound({
    version: AGENT_RUN_VERSION,
    parentRunId: additions.parentRunId || source.parentRunId || source.parent_run_id || null,
    sessionId: additions.sessionId || source.sessionId || source.session_id || source.conversationId || null,
    ownerId: additions.ownerId || source.ownerId || source.owner_id || source.userId || null,
    objective: boundString(firstText(
      additions.objective,
      source.objective,
      source.task,
      source.prompt,
      source.message,
      'Legacy agent run',
    ), 12000),
    surface: firstText(additions.surface, source.surface, source.runtimeSurface, 'legacy'),
    mode: firstText(additions.mode, source.mode, source.adapter, 'agent'),
    budget: additions.budget || source.budget || {},
    plan: additions.plan || source.plan || [],
    approvals: additions.approvals || source.approvals || [],
    evidence: additions.evidence || source.evidence || [],
    outputs: additions.outputs || source.outputs || (source.output !== undefined
      ? [{ type: 'legacy-output', value: source.output }]
      : []),
    usage: additions.usage || source.usage || {},
    completion: additions.completion || source.completion || null,
    continuationToken: additions.continuationToken || source.continuationToken || null,
    snapshot: {
      ...(source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : {}),
      ...(additions.snapshot && typeof additions.snapshot === 'object' ? additions.snapshot : {}),
      legacySourceId: sourceId || null,
      legacyState: requestedState,
    },
    idempotencyKey,
    requestedState,
  });
}

function attachLegacyAgentRunEnvelope(target = {}, envelope = {}) {
  const source = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
  const agentRun = redactAndBound(envelope || {});
  return {
    ...source,
    agentRun,
    metadata: {
      ...(source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
        ? source.metadata
        : {}),
      agentRun,
    },
  };
}

function transitionPathForState(state = 'created') {
  if (state === 'planning') return ['planning'];
  if (state === 'executing') return ['planning', 'executing'];
  if (state === 'verifying') return ['planning', 'executing', 'verifying'];
  if (state === 'completed') return ['planning', 'executing', 'verifying', 'completed'];
  if (['waiting_for_approval', 'blocked', 'failed', 'cancelled'].includes(state)) return [state];
  return [];
}

async function captureLegacyAgentRun(service, legacy = {}, overrides = {}) {
  if (!service || typeof service.createRun !== 'function' || typeof service.transitionRun !== 'function') {
    throw new TypeError('captureLegacyAgentRun requires an AgentRunService-compatible service.');
  }

  const input = buildLegacyAgentRunInput(legacy, overrides);
  const ownerId = firstText(input.ownerId, overrides.ownerId);
  const created = await service.createRun(input, ownerId);
  let run = created.run;
  const events = Array.isArray(created.events) ? [...created.events] : [];

  if (!created.duplicate) {
    for (const state of transitionPathForState(input.requestedState)) {
      const transitioned = await service.transitionRun(run.id, state, {
        ownerId,
        eventType: 'run.legacy_state',
        reason: 'Captured from a legacy runtime envelope.',
        completion: (state === 'completed' || state === 'failed' || state === 'cancelled')
          && input.completion
          ? input.completion
          : undefined,
        snapshot: input.snapshot,
        details: {
          legacySourceId: input.snapshot?.legacySourceId || null,
        },
      });
      run = transitioned.run;
      if (transitioned.event) {
        events.push(transitioned.event);
      }
    }
  }

  return {
    run,
    duplicate: created.duplicate,
    events,
  };
}

module.exports = {
  attachLegacyAgentRunEnvelope,
  buildLegacyAgentRunInput,
  captureLegacyAgentRun,
  normalizeLegacyState,
};

'use strict';

const { createHash, randomUUID } = require('crypto');
const { AsyncLabStore } = require('../async-lab/store');
const { normalizeCursor, normalizeText } = require('../async-lab/valkey-live-bus');
const {
  AGENT_RUN_SURFACE,
  AGENT_RUN_VERSION,
  TERMINAL_AGENT_RUN_STATES,
  canTransitionAgentRun,
  normalizeAgentRunState,
} = require('./constants');
const { boundString, redactAndBound } = require('./redaction');
const { buildProofPack } = require('../proof-pack');
const { normalizeEvidenceAttestation } = require('../agent-evidence');
const {
  TOOL_INVOCATION_RISKS,
  issueApprovalReceipt,
  validateToolInvocation,
} = require('../tool-invocation');

const ACTIONS = new Set(['pause', 'resume', 'cancel', 'retry-step', 'fork']);
const DEFAULT_MODE = 'agent';
const DEFAULT_SURFACE = 'api';
const MAX_INVOCATIONS = 50;
const MAX_INVOCATION_BYTES = 65536;
const TOOL_APPROVAL_TTL_MS = 5 * 60 * 1000;

function createAgentRunError(message, statusCode = 400, code = 'AGENT_RUN_ERROR') {
  const error = new Error(message);
  error.status = statusCode;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cloneObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }
  return redactAndBound(value);
}

function cloneArray(value) {
  return Array.isArray(value) ? redactAndBound(value) : [];
}

function normalizeAction(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  return ACTIONS.has(normalized) ? normalized : '';
}

function normalizeIdempotencyKey(value = '') {
  return boundString(String(value || '').trim(), 300);
}

function scopeCreationIdempotencyKey(value = '', scope = '') {
  const key = normalizeIdempotencyKey(value);
  if (!key) {
    return '';
  }
  const digest = createHash('sha256')
    .update(`${normalizeText(scope) || 'public'}:${key}`)
    .digest('hex');
  return `agent-create-${digest}`;
}

function makeRunId() {
  return `agent-run-${randomUUID()}`;
}

function makeContinuationToken() {
  return `agent-cont-${randomUUID()}`;
}

function deterministicEventId(runId = '', key = '', action = '') {
  if (!key) {
    return `agent-event-${randomUUID()}`;
  }
  const digest = createHash('sha256')
    .update(`${runId}:${action}:${key}`)
    .digest('hex')
    .slice(0, 32);
  return `agent-event-${digest}`;
}

function cloneValidInvocations(value, runId = '') {
  const expectedRunId = normalizeText(runId);
  if (!expectedRunId || !Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_INVOCATIONS).flatMap((invocation) => {
    const evidenceIsBound = Array.isArray(invocation?.evidence)
      && invocation.evidence.every((entry) => (
        normalizeEvidenceAttestation(entry)?.sourceInvocationId === invocation.id
      ));
    if (invocation?.runId !== expectedRunId
      || !validateToolInvocation(invocation).valid
      || !evidenceIsBound) {
      return [];
    }
    try {
      const serialized = JSON.stringify(invocation);
      if (serialized.length > MAX_INVOCATION_BYTES) {
        return [];
      }
      return [JSON.parse(serialized)];
    } catch (_error) {
      return [];
    }
  });
}

function getAgentRunMetadata(rawRun = {}) {
  const metadata = rawRun?.metadata?.agentRun;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return {
    ...redactAndBound(metadata),
    invocations: cloneValidInvocations(metadata.invocations, rawRun.id),
  };
}

function getLastCursor(events = [], fallback = 0) {
  return (Array.isArray(events) ? events : []).reduce(
    (max, event) => Math.max(max, normalizeCursor(event?.cursor)),
    normalizeCursor(fallback),
  );
}

function buildAgentRunControlState(rawRun = {}, metadata = {}, stateOverride = '') {
  const state = normalizeAgentRunState(stateOverride || rawRun.status || metadata.state, 'created');
  const approvals = Array.isArray(metadata.approvals) ? metadata.approvals : [];
  const pendingApprovalCount = approvals.filter((approval) => (
    String(approval?.status || '').trim().toLowerCase() === 'pending'
  )).length;
  const paused = state === 'waiting_for_approval';
  const blocked = state === 'blocked';
  const cancelRequested = rawRun.cancelRequested === true || state === 'cancelled';
  const terminal = TERMINAL_AGENT_RUN_STATES.has(state);

  return {
    state,
    canAdvance: !paused && !blocked && !cancelRequested && !terminal,
    paused,
    blocked,
    cancelRequested,
    terminal,
    pendingApprovalCount,
  };
}

function serializeAgentRun(rawRun = {}, events = []) {
  const metadata = getAgentRunMetadata(rawRun);
  const snapshot = cloneObject(metadata.snapshot);
  const eventCursor = getLastCursor(events, metadata.eventCursor || snapshot.eventCursor || 0);
  const state = normalizeAgentRunState(rawRun.status || metadata.state, 'created');

  const run = {
    version: AGENT_RUN_VERSION,
    id: normalizeText(rawRun.id),
    parentRunId: normalizeText(metadata.parentRunId) || null,
    sessionId: normalizeText(rawRun.sessionId) || null,
    ownerId: normalizeText(rawRun.ownerId) || null,
    objective: boundString(rawRun.task || metadata.objective || '', 12000),
    surface: normalizeText(metadata.surface) || DEFAULT_SURFACE,
    mode: normalizeText(rawRun.mode || metadata.mode) || DEFAULT_MODE,
    state,
    budget: cloneObject(metadata.budget),
    plan: cloneArray(metadata.plan),
    approvals: cloneArray(metadata.approvals),
    evidence: cloneArray(metadata.evidence),
    invocations: cloneValidInvocations(metadata.invocations, rawRun.id),
    outputs: cloneArray(metadata.outputs),
    usage: cloneObject(metadata.usage),
    completion: metadata.completion && typeof metadata.completion === 'object'
      ? cloneObject(metadata.completion)
      : null,
    continuationToken: normalizeText(metadata.continuationToken) || null,
    control: buildAgentRunControlState(rawRun, metadata, state),
    snapshot: {
      ...snapshot,
      version: AGENT_RUN_VERSION,
      state,
      eventCursor,
    },
    eventCursor,
    createdAt: normalizeText(rawRun.createdAt) || null,
    updatedAt: normalizeText(rawRun.updatedAt) || null,
  };
  return {
    ...run,
    proofPack: buildProofPack({ run }),
  };
}

function buildStoredMetadata(input = {}, state = 'created', eventCursor = 0) {
  const now = new Date().toISOString();
  const snapshot = {
    ...cloneObject(input.snapshot),
    version: AGENT_RUN_VERSION,
    state,
    eventCursor: normalizeCursor(eventCursor),
    updatedAt: now,
  };

  return {
    version: AGENT_RUN_VERSION,
    parentRunId: normalizeText(input.parentRunId || input.parent_run_id),
    objective: boundString(input.objective || input.task || input.prompt || '', 12000),
    surface: normalizeText(input.surface || input.clientSurface || input.client_surface) || DEFAULT_SURFACE,
    mode: normalizeText(input.mode) || DEFAULT_MODE,
    state,
    budget: cloneObject(input.budget),
    plan: cloneArray(input.plan),
    approvals: cloneArray(input.approvals),
    evidence: cloneArray(input.evidence),
    invocations: cloneValidInvocations(input.invocations, input.runId || input.id),
    outputs: cloneArray(input.outputs),
    usage: cloneObject(input.usage),
    completion: input.completion && typeof input.completion === 'object'
      ? cloneObject(input.completion)
      : null,
    continuationToken: normalizeText(input.continuationToken || input.continuation_token) || makeContinuationToken(),
    snapshot,
    eventCursor: normalizeCursor(eventCursor),
  };
}

function mergeAgentRunMetadata(current = {}, patch = {}, runId = '') {
  const merged = {
    ...current,
    ...patch,
  };
  merged.snapshot = {
    ...cloneObject(current.snapshot),
    ...cloneObject(patch.snapshot),
  };
  return {
    ...redactAndBound(merged),
    invocations: cloneValidInvocations(merged.invocations, runId),
  };
}

function isActionEventMatch(event = {}, action = '', idempotencyKey = '') {
  if (!idempotencyKey) {
    return false;
  }
  return event?.type === 'run.action'
    && event?.payload?.action === action
    && event?.payload?.actionIdempotencyKey === idempotencyKey;
}

function isTransitionEventMatch(event = {}, action = '', idempotencyKey = '', targetState = '') {
  if (!idempotencyKey || event?.payload?.actionIdempotencyKey !== idempotencyKey) {
    return false;
  }
  const eventTarget = normalizeAgentRunState(event?.payload?.toState || event?.status, '');
  if (!eventTarget || eventTarget !== targetState) {
    return false;
  }
  return action
    ? event?.type === 'run.action' && event?.payload?.action === action
    : !event?.payload?.action;
}

function isToolInvocationApprovalRequest(approval = {}) {
  return String(approval?.kind || approval?.type || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_') === 'tool_invocation';
}

function normalizePendingApprovalRequest(approval = {}, rawRun = {}) {
  const normalized = cloneObject(approval);
  if (!isToolInvocationApprovalRequest(normalized)) {
    return normalized;
  }
  const runId = normalizeText(normalized.runId || normalized.run_id);
  const toolId = normalizeText(normalized.toolId || normalized.tool_id);
  const risk = normalizeText(normalized.risk).toLowerCase();
  const inputHash = normalizeText(normalized.inputHash || normalized.input_hash).toLowerCase();
  const expectedScope = `${toolId}:${risk}`;
  const suppliedScope = normalizeText(normalized.scope);
  if (runId !== rawRun.id || !toolId || !TOOL_INVOCATION_RISKS.includes(risk)
    || !/^[a-f0-9]{64}$/.test(inputHash)
    || (suppliedScope && suppliedScope !== expectedScope)) {
    throw createAgentRunError(
      'Tool approval request is not exactly scoped to this run, tool, risk, and input hash.',
      409,
      'INVALID_TOOL_APPROVAL_SCOPE',
    );
  }
  return {
    ...normalized,
    kind: 'tool_invocation',
    runId,
    toolId,
    risk,
    inputHash,
    scope: expectedScope,
  };
}

function issueScopedToolApprovalReceipt(approval = {}, rawRun = {}, grantedBy = '') {
  const exactRequest = normalizePendingApprovalRequest(approval, rawRun);
  const runId = exactRequest.runId;
  const toolId = exactRequest.toolId;
  const risk = exactRequest.risk;
  const inputHash = exactRequest.inputHash;
  const expectedScope = exactRequest.scope;
  const owner = normalizeText(grantedBy || rawRun.ownerId);
  if (!owner) {
    throw createAgentRunError(
      'Tool approval request is not exactly scoped to this run, tool, risk, input hash, and owner.',
      409,
      'INVALID_TOOL_APPROVAL_SCOPE',
    );
  }
  try {
    return issueApprovalReceipt({
      id: approval.id,
      scope: expectedScope,
      runId,
      toolId,
      risk,
      inputHash,
      grantedBy: owner,
      expiresAt: new Date(Date.now() + TOOL_APPROVAL_TTL_MS).toISOString(),
    });
  } catch (error) {
    throw createAgentRunError(
      error.message,
      409,
      'INVALID_TOOL_APPROVAL_SCOPE',
    );
  }
}

class AgentRunService {
  constructor(options = {}) {
    this.store = options.store || new AsyncLabStore({
      persistToPostgres: options.persistToPostgres !== false,
    });
    this.runLocks = new Map();
  }

  async initialize() {
    await this.store.initialize();
    return true;
  }

  async withRunLock(key = '', operation = async () => null) {
    const lockKey = normalizeText(key) || 'agent-run-global';
    const previous = this.runLocks.get(lockKey) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => null).then(() => gate);
    this.runLocks.set(lockKey, chain);
    await previous.catch(() => null);

    try {
      return await operation();
    } finally {
      release();
      if (this.runLocks.get(lockKey) === chain) {
        this.runLocks.delete(lockKey);
      }
    }
  }

  async createRun(input = {}, ownerId = '') {
    await this.initialize();
    const sanitized = redactAndBound(input || {});
    const normalizedOwnerId = normalizeText(ownerId || sanitized.ownerId || sanitized.owner_id);
    const normalizedSessionId = normalizeText(sanitized.sessionId || sanitized.session_id);
    const idempotencyKey = scopeCreationIdempotencyKey(
      sanitized.idempotencyKey || sanitized.idempotency_key,
      normalizedOwnerId || normalizedSessionId,
    );
    const lockKey = idempotencyKey ? `create:${idempotencyKey}` : `create:${randomUUID()}`;

    return this.withRunLock(lockKey, async () => {
      if (idempotencyKey) {
        const existing = await this.store.getRunByIdempotency(AGENT_RUN_SURFACE, idempotencyKey);
        if (existing) {
          const events = await this.store.listEvents(existing.id, 0);
          return {
            run: serializeAgentRun(existing, events),
            duplicate: true,
            events,
          };
        }
      }

      const runId = makeRunId();
      const objective = boundString(
        sanitized.objective || sanitized.task || sanitized.prompt || 'Agent run',
        12000,
      );
      const metadata = buildStoredMetadata({
        ...sanitized,
        objective,
        runId,
      });

      try {
        let rawRun = await this.store.createRun({
          id: runId,
          ownerId: normalizedOwnerId,
          sessionId: normalizedSessionId,
          runtimeSurface: AGENT_RUN_SURFACE,
          mode: metadata.mode,
          adapter: 'agent-run-v1',
          status: 'created',
          targetKey: normalizeText(sanitized.targetKey || sanitized.target_key)
            || `agent-run:${normalizeText(sanitized.sessionId || sanitized.session_id) || runId}`,
          idempotencyKey,
          task: objective,
          metadata: {
            runtimeSurface: AGENT_RUN_SURFACE,
            agentRun: metadata,
          },
        });

        const event = await this.store.appendEvent(rawRun.id, {
          type: 'run.created',
          source: AGENT_RUN_SURFACE,
          status: 'created',
          payload: redactAndBound({
            version: AGENT_RUN_VERSION,
            parentRunId: metadata.parentRunId || null,
            surface: metadata.surface,
            mode: metadata.mode,
          }),
        });
        const eventCursor = normalizeCursor(event?.cursor);
        const nextMetadata = mergeAgentRunMetadata(metadata, {
          eventCursor,
          snapshot: {
            ...metadata.snapshot,
            eventCursor,
            lastEvent: {
              cursor: eventCursor,
              type: event?.type || 'run.created',
              at: event?.timestamp || new Date().toISOString(),
            },
          },
        }, rawRun.id);
        rawRun = await this.store.updateRun(rawRun.id, {
          metadata: {
            agentRun: nextMetadata,
          },
        });
        const events = [event];

        return {
          run: serializeAgentRun(rawRun, events),
          duplicate: false,
          events,
        };
      } catch (error) {
        if (error?.code === '23505' && idempotencyKey) {
          const existing = await this.store.getRunByIdempotency(AGENT_RUN_SURFACE, idempotencyKey);
          if (existing) {
            const events = await this.store.listEvents(existing.id, 0);
            return {
              run: serializeAgentRun(existing, events),
              duplicate: true,
              events,
            };
          }
        }
        throw error;
      }
    });
  }

  async getRawRun(runId = '', ownerId = '') {
    await this.initialize();
    const rawRun = await this.store.getRun(runId);
    if (!rawRun || rawRun.runtimeSurface !== AGENT_RUN_SURFACE) {
      return null;
    }
    const normalizedOwner = normalizeText(ownerId);
    if (normalizedOwner && rawRun.ownerId && rawRun.ownerId !== normalizedOwner) {
      return null;
    }
    return rawRun;
  }

  async getRun(runId = '', ownerId = '') {
    const rawRun = await this.getRawRun(runId, ownerId);
    if (!rawRun) {
      return null;
    }
    const events = await this.store.listEvents(rawRun.id, 0);
    return serializeAgentRun(rawRun, events);
  }

  async getControlState(runId = '', ownerId = '') {
    const rawRun = await this.getRawRun(runId, ownerId);
    if (!rawRun) {
      return null;
    }
    return buildAgentRunControlState(rawRun, getAgentRunMetadata(rawRun));
  }

  async listEvents(runId = '', afterCursor = 0, ownerId = '') {
    const rawRun = await this.getRawRun(runId, ownerId);
    if (!rawRun) {
      return null;
    }
    return this.store.listEvents(rawRun.id, normalizeCursor(afterCursor));
  }

  async replayRun(runId = '', afterCursor = 0, ownerId = '') {
    const rawRun = await this.getRawRun(runId, ownerId);
    if (!rawRun) {
      return null;
    }
    const events = await this.store.listEvents(rawRun.id, normalizeCursor(afterCursor));
    const allEvents = normalizeCursor(afterCursor) > 0
      ? await this.store.listEvents(rawRun.id, 0)
      : events;
    return {
      run: serializeAgentRun(rawRun, allEvents),
      after: normalizeCursor(afterCursor),
      events,
      eventCursor: getLastCursor(allEvents),
    };
  }

  async transitionRun(runId = '', nextState = '', options = {}) {
    return this.withRunLock(`run:${runId}`, async () => {
      const rawRun = await this.getRawRun(runId, options.ownerId || '');
      if (!rawRun) {
        return null;
      }
      const events = await this.store.listEvents(rawRun.id, 0);
      return this.transitionLocked(rawRun, events, nextState, options);
    });
  }

  async transitionLocked(rawRun, events, nextState, options = {}) {
    const currentState = normalizeAgentRunState(rawRun.status, 'created');
    const targetState = normalizeAgentRunState(nextState, '');
    if (!targetState) {
      throw createAgentRunError(`Unknown AgentRun state: ${nextState}`, 400, 'INVALID_AGENT_RUN_STATE');
    }
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const action = normalizeAction(options.action);
    const duplicateEvent = events.find((event) => (
      isTransitionEventMatch(event, action, idempotencyKey, targetState)
    ));
    if (duplicateEvent) {
      const hasLaterTransition = events.some((event) => (
        normalizeCursor(event?.cursor) > normalizeCursor(duplicateEvent.cursor)
        && normalizeAgentRunState(event?.payload?.toState || event?.status, '')
      ));
      if (currentState === targetState || hasLaterTransition) {
        return {
          run: serializeAgentRun(rawRun, events),
          duplicate: true,
          event: duplicateEvent,
        };
      }
    }
    if (!canTransitionAgentRun(currentState, targetState)) {
      throw createAgentRunError(
        duplicateEvent
          ? `Cannot reconcile AgentRun transition: ${currentState} -> ${targetState}`
          : `Illegal AgentRun transition: ${currentState} -> ${targetState}`,
        409,
        duplicateEvent ? 'AGENT_RUN_RECONCILE_CONFLICT' : 'ILLEGAL_AGENT_RUN_TRANSITION',
      );
    }

    const now = duplicateEvent?.timestamp || new Date().toISOString();
    const currentMetadata = getAgentRunMetadata(rawRun);
    const completion = options.completion !== undefined
      ? (options.completion ? cloneObject(options.completion) : null)
      : (TERMINAL_AGENT_RUN_STATES.has(targetState)
        ? {
            status: targetState,
            reason: boundString(options.reason || '', 1000),
            at: now,
          }
        : (TERMINAL_AGENT_RUN_STATES.has(currentState)
          ? null
          : currentMetadata.completion || null));
    const snapshotPatch = cloneObject(options.snapshot);
    const nextSnapshot = {
      ...cloneObject(currentMetadata.snapshot),
      ...snapshotPatch,
      version: AGENT_RUN_VERSION,
      state: targetState,
      updatedAt: now,
      lastTransition: {
        from: currentState,
        to: targetState,
        reason: boundString(options.reason || '', 1000),
        at: now,
      },
      ...(action ? {
        lastAction: {
          action,
          idempotencyKey: idempotencyKey || null,
          at: now,
        },
      } : {}),
    };
    const event = duplicateEvent || await this.store.appendEvent(rawRun.id, {
        eventId: deterministicEventId(rawRun.id, idempotencyKey, action || targetState),
        type: options.eventType || (action ? 'run.action' : 'run.transition'),
        source: AGENT_RUN_SURFACE,
        status: targetState,
        payload: redactAndBound({
          ...(action ? { action } : {}),
          ...(idempotencyKey ? { actionIdempotencyKey: idempotencyKey } : {}),
          ...(options.eventType === 'run.step' && idempotencyKey
            ? { stepIdempotencyKey: idempotencyKey }
            : {}),
          fromState: currentState,
          toState: targetState,
          reason: options.reason || '',
          details: options.details || {},
        }),
      });
    const eventCursor = normalizeCursor(event?.cursor);
    const nextMetadata = mergeAgentRunMetadata(currentMetadata, {
      state: targetState,
      budget: options.budget !== undefined ? cloneObject(options.budget) : currentMetadata.budget,
      plan: options.plan !== undefined ? cloneArray(options.plan) : currentMetadata.plan,
      approvals: options.approvals !== undefined ? cloneArray(options.approvals) : currentMetadata.approvals,
      evidence: options.evidence !== undefined ? cloneArray(options.evidence) : currentMetadata.evidence,
      invocations: options.invocations !== undefined
        ? cloneValidInvocations(options.invocations, rawRun.id)
        : currentMetadata.invocations,
      outputs: options.outputs !== undefined ? cloneArray(options.outputs) : currentMetadata.outputs,
      usage: options.usage !== undefined ? cloneObject(options.usage) : currentMetadata.usage,
      completion,
      eventCursor,
      snapshot: {
        ...nextSnapshot,
        eventCursor,
        lastEvent: {
          cursor: eventCursor,
          type: event?.type || 'run.transition',
          at: event?.timestamp || now,
        },
      },
    }, rawRun.id);
    const patch = {
      status: targetState,
      metadata: { agentRun: nextMetadata },
      ...(targetState === 'cancelled' ? { cancelRequested: true, cancelledAt: now } : {}),
      ...(targetState === 'completed' || targetState === 'failed' ? { completedAt: now } : {}),
      ...(currentState === 'created' ? { startedAt: now } : {}),
    };
    const updatedRaw = await this.store.updateRun(rawRun.id, patch);
    const nextEvents = (duplicateEvent ? [...events] : [...events, event])
      .sort((left, right) => left.cursor - right.cursor);

    return {
      run: serializeAgentRun(updatedRaw, nextEvents),
      duplicate: Boolean(duplicateEvent),
      event,
    };
  }

  async recordStep(runId = '', step = {}, options = {}) {
    return this.withRunLock(`run:${runId}`, async () => {
      const rawRun = await this.getRawRun(runId, options.ownerId || '');
      if (!rawRun) {
        return null;
      }
      const events = await this.store.listEvents(rawRun.id, 0);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey || step.idempotencyKey);
      const duplicate = idempotencyKey
        ? events.find((event) => event?.type === 'run.step'
          && event?.payload?.stepIdempotencyKey === idempotencyKey)
        : null;
      const requestedStepState = normalizeAgentRunState(step.state, '');
      if (duplicate && (!requestedStepState || requestedStepState === rawRun.status)) {
        return {
          run: serializeAgentRun(rawRun, events),
          duplicate: true,
          event: duplicate,
        };
      }

      if (step.state && requestedStepState !== rawRun.status) {
        return this.transitionLocked(rawRun, events, step.state, {
          ...options,
          eventType: 'run.step',
          idempotencyKey,
          reason: step.reason || options.reason || '',
          details: step,
          ...(step.evidence !== undefined ? { evidence: step.evidence } : {}),
          ...(step.invocations !== undefined ? { invocations: step.invocations } : {}),
          ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
          ...(step.usage !== undefined ? { usage: step.usage } : {}),
          ...(step.completion !== undefined ? { completion: step.completion } : {}),
          snapshot: {
            ...cloneObject(options.snapshot),
            lastStep: redactAndBound(step),
          },
        });
      }

      const now = new Date().toISOString();
      const currentMetadata = getAgentRunMetadata(rawRun);
      const event = await this.store.appendEvent(rawRun.id, {
        eventId: deterministicEventId(rawRun.id, idempotencyKey, 'step'),
        type: 'run.step',
        source: AGENT_RUN_SURFACE,
        status: rawRun.status,
        payload: redactAndBound({
          stepIdempotencyKey: idempotencyKey || null,
          step,
        }),
      });
      const eventCursor = normalizeCursor(event?.cursor);
      const nextMetadata = mergeAgentRunMetadata(currentMetadata, {
        ...(step.evidence ? { evidence: cloneArray(step.evidence) } : {}),
        ...(step.invocations ? { invocations: cloneValidInvocations(step.invocations, rawRun.id) } : {}),
        ...(step.outputs ? { outputs: cloneArray(step.outputs) } : {}),
        ...(step.usage ? { usage: cloneObject(step.usage) } : {}),
        eventCursor,
        snapshot: {
          ...cloneObject(currentMetadata.snapshot),
          ...cloneObject(options.snapshot),
          state: rawRun.status,
          eventCursor,
          updatedAt: now,
          lastStep: redactAndBound(step),
          lastEvent: {
            cursor: eventCursor,
            type: 'run.step',
            at: event?.timestamp || now,
          },
        },
      }, rawRun.id);
      const updatedRaw = await this.store.updateRun(rawRun.id, {
        metadata: { agentRun: nextMetadata },
      });
      const nextEvents = [...events, event].sort((left, right) => left.cursor - right.cursor);
      return {
        run: serializeAgentRun(updatedRaw, nextEvents),
        duplicate: false,
        event,
      };
    });
  }

  async recordActionLocked(rawRun, events, action, input = {}) {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const duplicateEvent = events.find((event) => isActionEventMatch(event, action, idempotencyKey));
    if (duplicateEvent) {
      return {
        run: serializeAgentRun(rawRun, events),
        duplicate: true,
        event: duplicateEvent,
      };
    }

    const now = new Date().toISOString();
    const currentMetadata = getAgentRunMetadata(rawRun);
    const event = await this.store.appendEvent(rawRun.id, {
      eventId: deterministicEventId(rawRun.id, idempotencyKey, action),
      type: 'run.action',
      source: AGENT_RUN_SURFACE,
      status: rawRun.status,
      payload: redactAndBound({
        action,
        ...(idempotencyKey ? { actionIdempotencyKey: idempotencyKey } : {}),
        reason: input.reason || '',
        details: input.details || {},
      }),
    });
    const eventCursor = normalizeCursor(event?.cursor);
    const nextMetadata = mergeAgentRunMetadata(currentMetadata, {
      eventCursor,
      snapshot: {
        ...cloneObject(currentMetadata.snapshot),
        ...cloneObject(input.snapshot),
        state: rawRun.status,
        eventCursor,
        updatedAt: now,
        lastAction: {
          action,
          idempotencyKey: idempotencyKey || null,
          at: now,
        },
        lastEvent: {
          cursor: eventCursor,
          type: 'run.action',
          at: event?.timestamp || now,
        },
      },
    }, rawRun.id);
    const updatedRaw = await this.store.updateRun(rawRun.id, {
      metadata: { agentRun: nextMetadata },
    });
    const nextEvents = [...events, event].sort((left, right) => left.cursor - right.cursor);
    return {
      run: serializeAgentRun(updatedRaw, nextEvents),
      duplicate: false,
      event,
    };
  }

  async performAction(runId = '', input = {}, ownerId = '') {
    const sanitized = redactAndBound(input || {});
    const action = normalizeAction(sanitized.action || sanitized.type);
    if (!action) {
      throw createAgentRunError(
        'AgentRun action must be one of pause, resume, cancel, retry-step, or fork.',
        400,
        'INVALID_AGENT_RUN_ACTION',
      );
    }

    return this.withRunLock(`run:${runId}`, async () => {
      const rawRun = await this.getRawRun(runId, ownerId);
      if (!rawRun) {
        return null;
      }
      const events = await this.store.listEvents(rawRun.id, 0);
      const state = normalizeAgentRunState(rawRun.status, 'created');
      const idempotencyKey = normalizeIdempotencyKey(
        sanitized.idempotencyKey || sanitized.idempotency_key,
      );
      const common = {
        action,
        idempotencyKey,
        reason: sanitized.reason || '',
        details: sanitized.details || {},
      };

      const priorEvent = events.find((event) => isActionEventMatch(event, action, idempotencyKey));
      if (priorEvent) {
        if (action === 'fork') {
          const priorForkedRunId = normalizeText(priorEvent?.payload?.details?.forkedRunId);
          const priorForkedRun = priorForkedRunId
            ? await this.getRun(priorForkedRunId, ownerId)
            : null;
          return {
            action,
            run: serializeAgentRun(rawRun, events),
            duplicate: true,
            event: priorEvent,
            ...(priorForkedRun ? { forkedRun: priorForkedRun } : {}),
          };
        }
        const priorTarget = normalizeAgentRunState(
          priorEvent?.payload?.toState || priorEvent?.status,
          '',
        );
        const hasLaterTransition = events.some((event) => (
          normalizeCursor(event?.cursor) > normalizeCursor(priorEvent.cursor)
          && normalizeAgentRunState(event?.payload?.toState || event?.status, '')
        ));
        if (priorTarget === state || hasLaterTransition) {
          return {
            action,
            run: serializeAgentRun(rawRun, events),
            duplicate: true,
            event: priorEvent,
          };
        }
      }

      if (action === 'pause') {
        if (state === 'waiting_for_approval') {
          return { action, run: serializeAgentRun(rawRun, events), duplicate: true, event: priorEvent || null };
        }
        const approvalRequest = normalizePendingApprovalRequest(
          priorEvent?.payload?.details?.approvalRequest || sanitized.approval || {},
          rawRun,
        );
        const approvalId = normalizeText(
          priorEvent?.payload?.details?.approvalId || approvalRequest.id,
        ) || `approval-${randomUUID()}`;
        const requestedAt = priorEvent?.timestamp || new Date().toISOString();
        const currentMetadata = getAgentRunMetadata(rawRun);
        const approvals = [
          ...cloneArray(currentMetadata.approvals),
          redactAndBound({
            ...approvalRequest,
            id: approvalId,
            status: 'pending',
            reason: sanitized.reason || 'Run paused for approval.',
            requestedAt,
          }),
        ];
        const result = await this.transitionLocked(rawRun, events, 'waiting_for_approval', {
          ...common,
          details: {
            ...cloneObject(common.details),
            approvalId,
            approvalRequest: {
              ...approvalRequest,
              id: approvalId,
              status: 'pending',
            },
          },
          approvals,
          snapshot: {
            ...cloneObject(sanitized.snapshot),
            pause: {
              pausedFrom: state,
              reason: sanitized.reason || '',
              approvalId,
              pausedAt: requestedAt,
            },
          },
        });
        return { action, ...result };
      }

      if (action === 'resume') {
        if (!['waiting_for_approval', 'blocked'].includes(state)) {
          if (getAgentRunMetadata(rawRun)?.snapshot?.lastAction?.action === 'resume') {
            return { action, run: serializeAgentRun(rawRun, events), duplicate: true, event: priorEvent || null };
          }
          throw createAgentRunError(
            `Cannot resume AgentRun from ${state}.`,
            409,
            'AGENT_RUN_NOT_RESUMABLE',
          );
        }
        const currentMetadata = getAgentRunMetadata(rawRun);
        const resolvedAt = new Date().toISOString();
        const currentApprovals = cloneArray(currentMetadata.approvals);
        const pendingApprovals = currentApprovals.filter((approval) => approval?.status === 'pending');
        const approvalId = normalizeText(
          currentMetadata?.snapshot?.pause?.approvalId
          || sanitized.approval?.id
          || (pendingApprovals.length === 1 ? pendingApprovals[0]?.id : ''),
        );
        let approvalReceiptId = null;
        const approvals = currentApprovals.map((approval) => {
          if (!approvalId || approval?.id !== approvalId || approval?.status !== 'pending') {
            return approval;
          }
          if (isToolInvocationApprovalRequest(approval)) {
            const receipt = issueScopedToolApprovalReceipt(
              approval,
              rawRun,
              ownerId || rawRun.ownerId,
            );
            approvalReceiptId = receipt.id;
            return receipt;
          }
          return redactAndBound({
            ...approval,
            ...(sanitized.approval && typeof sanitized.approval === 'object'
              ? sanitized.approval
              : {}),
            id: approval.id,
            status: 'approved',
            resolvedAt,
          });
        });
        const pausedFrom = normalizeAgentRunState(currentMetadata?.snapshot?.pause?.pausedFrom, 'executing');
        const resumeState = state === 'blocked' || pausedFrom === 'blocked'
          ? 'executing'
          : (pausedFrom === 'created'
            ? 'planning'
            : (canTransitionAgentRun(state, pausedFrom) ? pausedFrom : 'executing'));
        const result = await this.transitionLocked(rawRun, events, resumeState, {
          ...common,
          details: {
            ...cloneObject(common.details),
            approvalId: approvalId || null,
            approvalReceiptId,
          },
          approvals,
          snapshot: {
            ...cloneObject(sanitized.snapshot),
            pause: {
              ...cloneObject(currentMetadata?.snapshot?.pause),
              resolvedAt,
              resolution: 'resumed',
              ...(approvalReceiptId ? { approvalReceiptId } : {}),
            },
          },
        });
        return { action, ...result };
      }

      if (action === 'cancel') {
        if (state === 'cancelled') {
          return { action, run: serializeAgentRun(rawRun, events), duplicate: true, event: priorEvent || null };
        }
        const result = await this.transitionLocked(rawRun, events, 'cancelled', common);
        return { action, ...result };
      }

      if (action === 'retry-step') {
        if (!['failed', 'blocked'].includes(state)) {
          throw createAgentRunError(
            `Cannot retry a step from AgentRun state ${state}.`,
            409,
            'AGENT_RUN_STEP_NOT_RETRYABLE',
          );
        }
        const currentMetadata = getAgentRunMetadata(rawRun);
        const retryCount = Math.max(0, Number(currentMetadata?.snapshot?.retryCount) || 0) + 1;
        const result = await this.transitionLocked(rawRun, events, 'executing', {
          ...common,
          completion: null,
          snapshot: {
            ...cloneObject(sanitized.snapshot),
            retryCount,
            retryStepId: normalizeText(sanitized.stepId || sanitized.step_id) || null,
          },
        });
        return { action, ...result };
      }

      const sourceRun = serializeAgentRun(rawRun, events);
      const forkIdempotencyKey = idempotencyKey
        ? `fork:${sourceRun.id}:${idempotencyKey}`
        : '';
      const forkInstruction = boundString(sanitized.instruction || '', 4000).trim();
      const forkInstructionSuffix = forkInstruction ? `\n\nFork instruction: ${forkInstruction}` : '';
      const forkObjective = sanitized.objective
        || (forkInstruction
          ? `${sourceRun.objective.slice(0, Math.max(0, 12000 - forkInstructionSuffix.length))}${forkInstructionSuffix}`
          : sourceRun.objective);
      const forkResult = await this.createRun({
        parentRunId: sourceRun.id,
        sessionId: sourceRun.sessionId,
        ownerId: sourceRun.ownerId,
        objective: forkObjective,
        surface: sanitized.surface || sourceRun.surface,
        mode: sanitized.mode || sourceRun.mode,
        budget: sourceRun.budget,
        plan: [],
        approvals: [],
        evidence: [],
        invocations: [],
        outputs: [],
        usage: {},
        completion: null,
        snapshot: {
          ...cloneObject(sanitized.snapshot),
          state: 'created',
          forkedFrom: sourceRun.id,
          forkedAt: new Date().toISOString(),
          ...(forkInstruction ? { forkInstruction } : {}),
          lineage: {
            parentRunId: sourceRun.id,
            parentEventCursor: sourceRun.eventCursor,
            parentSnapshotVersion: sourceRun.snapshot?.version || AGENT_RUN_VERSION,
          },
        },
        idempotencyKey: forkIdempotencyKey,
      }, sourceRun.ownerId || ownerId);
      let forkedRun = forkResult.run;
      const forkApprovals = sourceRun.approvals
        .filter((approval) => approval?.status === 'pending' && isToolInvocationApprovalRequest(approval))
        .map((approval) => ({
          ...approval,
          runId: forkedRun.id,
          scope: `${normalizeText(approval.toolId || approval.tool_id)}:${normalizeText(approval.risk).toLowerCase()}`,
        }));
      const pendingApprovals = forkApprovals.filter((approval) => (
        String(approval?.status || '').trim().toLowerCase() === 'pending'
      ));
      if (pendingApprovals.length > 0 && forkedRun.state === 'created') {
        const forkGateIdempotencyKey = `fork-gate-${createHash('sha256')
          .update(forkedRun.id)
          .digest('hex')}`;
        const gatedFork = await this.transitionRun(forkedRun.id, 'waiting_for_approval', {
          ownerId: sourceRun.ownerId || ownerId,
          eventType: 'run.fork_gate',
          idempotencyKey: forkGateIdempotencyKey,
          approvals: forkApprovals,
          reason: 'Fork inherited pending approval requirements.',
          details: {
            parentRunId: sourceRun.id,
            pendingApprovalIds: pendingApprovals.map((approval) => approval.id).filter(Boolean),
          },
          snapshot: {
            inheritedApprovalGate: {
              parentRunId: sourceRun.id,
              pendingApprovalIds: pendingApprovals.map((approval) => approval.id).filter(Boolean),
            },
          },
        });
        if (gatedFork?.run) {
          forkedRun = gatedFork.run;
        }
      }
      const parentResult = await this.recordActionLocked(rawRun, events, action, {
        ...common,
        details: {
          ...cloneObject(common.details),
          forkedRunId: forkedRun.id,
        },
        snapshot: sanitized.snapshot,
      });
      return {
        action,
        ...parentResult,
        forkedRun,
      };
    });
  }
}

module.exports = {
  AgentRunService,
  buildAgentRunControlState,
  buildStoredMetadata,
  createAgentRunError,
  getAgentRunMetadata,
  serializeAgentRun,
};

'use strict';

const { normalizeEvidenceAttestation, redactSecrets, stableSha256 } = require('../agent-evidence');
const { validateToolInvocation } = require('../tool-invocation');
const { redactAndBound } = require('./redaction');

const AGENT_REPLAY_ARCHIVE_VERSION = 'AgentReplayArchive/v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitize(value, limits = {}) {
  return redactAndBound(redactSecrets(value), {
    maxStringLength: 2000,
    maxArrayLength: 100,
    maxObjectKeys: 120,
    ...limits,
  });
}

function normalizeReplayEvent(event = {}) {
  const cursor = Number(event.cursor);
  if (!Number.isInteger(cursor) || cursor < 1) {
    throw new Error('Replay events require a positive integer cursor.');
  }
  return sanitize({
    eventId: event.eventId || event.id || null,
    cursor,
    type: String(event.type || 'run.event'),
    source: String(event.source || 'agent-run'),
    status: String(event.status || ''),
    timestamp: event.timestamp || event.createdAt || null,
    payload: event.payload || {},
  });
}

function normalizeRecordedInvocation(invocation = {}) {
  const validation = validateToolInvocation(invocation);
  if (!validation.valid) {
    throw new Error(`Cannot archive invalid ToolInvocation/v2: ${validation.errors.join(', ')}`);
  }
  const evidence = asArray(invocation.evidence).map(normalizeEvidenceAttestation).filter(Boolean);
  const recordedOutput = sanitize(invocation.result, {
    maxStringLength: 1000,
    maxArrayLength: 50,
    maxObjectKeys: 80,
  });
  return {
    id: invocation.id,
    runId: invocation.runId,
    toolId: invocation.toolId,
    toolVersion: invocation.toolVersion,
    inputHash: invocation.inputHash,
    risk: invocation.risk,
    approvalReceiptId: invocation.approvalReceiptId,
    idempotencyKey: invocation.idempotencyKey,
    retrySafe: invocation.retrySafe,
    status: invocation.status,
    recordedOutput,
    outputDigest: stableSha256(recordedOutput),
    evidenceDigests: evidence.map((entry) => entry.digest),
    evidence,
    sideEffects: asArray(invocation.sideEffects).map((effect) => sanitize({
      type: effect?.type || effect?.category || null,
      resource: effect?.resource || effect?.path || effect?.destination || null,
      timestamp: effect?.timestamp || null,
    })),
  };
}

function createReplayArchive({ run = {}, events = [], toolInvocations = [] } = {}) {
  const normalizedEvents = asArray(events).map(normalizeReplayEvent);
  const cursors = normalizedEvents.map((event) => event.cursor);
  if (new Set(cursors).size !== cursors.length) {
    throw new Error('Replay event cursors must be unique.');
  }
  for (let index = 1; index < cursors.length; index += 1) {
    if (cursors[index] <= cursors[index - 1]) {
      throw new Error('Replay events must be supplied in cursor order.');
    }
  }
  const invocations = asArray(toolInvocations).map(normalizeRecordedInvocation);
  return sanitize({
    version: AGENT_REPLAY_ARCHIVE_VERSION,
    mode: 'read-only-recording',
    createdAt: new Date().toISOString(),
    run: {
      version: run.version || 'AgentRun/v1',
      id: run.id || null,
      parentRunId: run.parentRunId || null,
      objective: run.objective || '',
      state: run.state || 'created',
      snapshot: run.snapshot || {},
      eventCursor: run.eventCursor || cursors[cursors.length - 1] || 0,
    },
    events: normalizedEvents,
    toolInvocations: invocations,
    digest: stableSha256({
      runId: run.id || null,
      events: normalizedEvents,
      invocations,
    }),
  });
}

function replayArchive(archive = {}, options = {}) {
  if (archive?.version !== AGENT_REPLAY_ARCHIVE_VERSION || archive?.mode !== 'read-only-recording') {
    throw new Error(`Offline replay requires ${AGENT_REPLAY_ARCHIVE_VERSION}.`);
  }
  for (const invocation of asArray(archive.toolInvocations)) {
    if (stableSha256(invocation.recordedOutput) !== invocation.outputDigest) {
      throw new Error(`Replay archive output digest mismatch for invocation ${invocation.id || 'unknown'}.`);
    }
  }
  const expectedArchiveDigest = stableSha256({
    runId: archive.run?.id || null,
    events: asArray(archive.events),
    invocations: asArray(archive.toolInvocations),
  });
  if (expectedArchiveDigest !== archive.digest) {
    throw new Error('Replay archive digest mismatch.');
  }
  const after = Math.max(0, Number(options.after) || 0);
  const outputs = new Map(asArray(archive.toolInvocations).map((invocation) => [
    invocation.id,
    sanitize(invocation.recordedOutput),
  ]));
  return {
    version: 'AgentReplay/v1',
    mode: 'read-only',
    replay: true,
    run: sanitize(archive.run),
    events: asArray(archive.events).filter((event) => Number(event.cursor) > after),
    eventCursor: Number(archive.run?.eventCursor || 0),
    getRecordedToolOutput(invocationId = '') {
      return outputs.has(invocationId) ? sanitize(outputs.get(invocationId)) : null;
    },
  };
}

module.exports = {
  AGENT_REPLAY_ARCHIVE_VERSION,
  createReplayArchive,
  replayArchive,
};

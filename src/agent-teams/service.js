'use strict';

const { createHash, randomUUID } = require('crypto');
const { createTeam, command, agentContext, claimTasks, tickRoutines, fail } = require('./domain');
const { TeamStore } = require('./store');
const { normalizeExecutionOwner } = require('./execution-owner');
const { reserveComputer, advanceComputer, requireClosedComputer } = require('./computer-lease');
const { normalizeBrowserStopEvidence } = require('../agent-computer/stop-evidence');
const { normalizeProfileRecoveryEvidence } = require('../agent-computer/profile-recovery-evidence');
const { isDeepStrictEqual } = require('node:util');
const { reserveRecoveryHelper, advanceRecoveryHelper } = require('../agent-computer/recovery-helper');
const { reserveRecoveryWrite } = require('../agent-computer/recovery-write');
const { beginRecoveryHelperLaunch } = require('../agent-computer/recovery-launch');

const OPERATION_KINDS = new Set(['artifact_write', 'lilly_tool', 'computer_open', 'computer_act']);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const plainRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)));

function operationTask(team, claim, cleanup = false) {
  const task = team.tasks.find((entry) => entry.id === claim?.taskId);
  if (!task || !claim?.workerId || !claim?.claimId
    || !['running', ...(cleanup ? ['reconciling'] : [])].includes(task.status)
    || task.worker?.id !== claim.workerId || task.worker?.claimId !== claim.claimId
    || (!cleanup && (task.cancelRequestedAt || team.execution?.enabled !== true
      || !team.agents.find((agent) => agent.id === task.agentId)?.enabled))) {
    fail('Active worker claim required.', 'team_claim_required', 403);
  }
  return task;
}

function operations(task) {
  if (task.operations === undefined) return [];
  if (!Array.isArray(task.operations) || task.operations.length > 100) {
    fail('Operation journal requires reconciliation.', 'team_operations_unsettled', 409);
  }
  return task.operations;
}

function requireSettledOperations(task) {
  if (operations(task).some((operation) => !operation || operation.status !== 'settled')) {
    fail('Worker operations remain unsettled.', 'team_operations_unsettled', 409);
  }
}

function recoveryArtifacts(task) {
  const artifacts = new Map();
  for (const op of operations(task)) {
    if (op?.kind !== 'artifact_write' || !op.artifact) continue;
    const { id, sha256 } = op.artifact;
    if (typeof id !== 'string' || !SAFE_ID.test(id) || typeof sha256 !== 'string' || !SHA256.test(sha256)
      || (artifacts.has(id) && artifacts.get(id).sha256 !== sha256)) {
      fail('Recovery artifact journal is inconsistent.', 'team_evidence_required', 409);
    }
    artifacts.set(id, { id, sha256 });
  }
  return [...artifacts.values()];
}

function recoveryLease(task, leaseId, now) {
  const lease = task.worker?.reconciliation;
  if (!lease || lease.id !== leaseId || lease.claimId !== task.worker.claimId
    || lease.ownerBootId !== task.worker.executionOwner?.bootId || lease.status !== 'investigating'
    || !Number.isFinite(Date.parse(lease.expiresAt)) || !Number.isFinite(Date.parse(now))
    || Date.parse(lease.expiresAt) <= Date.parse(now)) fail('Recovery lease is stale.', 'team_recovery_stale', 409);
  return lease;
}

class TeamService {
  constructor({ store = new TeamStore(), now = () => new Date().toISOString(), verifyArtifact = null } = {}) {
    this.store = store;
    this.now = now;
    this.verifyArtifact = verifyArtifact;
  }

  owner(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId.trim()) fail('Authentication required.', 'team_auth_required', 401);
    return ownerId;
  }

  async create(ownerId, input, idempotencyKey) {
    const team = createTeam(this.owner(ownerId), input, this.now());
    if (idempotencyKey === undefined) return this.store.create(team);
    if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(idempotencyKey)) {
      fail('A bounded idempotency key is required.');
    }
    const digest = createHash('sha256').update(JSON.stringify(['lilly-team-create-v1', ownerId, idempotencyKey])).digest('hex');
    // UUID-shaped stable key. Owner namespace is included and never taken from
    // the request body. This is identity, not a credential or a capability.
    team.id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    team.creation = { fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
    const stored = await this.store.createOnce(team);
    if (stored.creation?.fingerprint !== team.creation.fingerprint) {
      fail('Idempotency key already used for a different team.', 'team_idempotency_conflict', 409);
    }
    return stored;
  }

  async list(ownerId) { return this.store.list(this.owner(ownerId)); }

  async get(teamId, ownerId) { return this.store.get(teamId, this.owner(ownerId)); }

  async context(teamId, ownerId, agentId) {
    return agentContext(await this.get(teamId, ownerId), agentId);
  }

  engineTask(team, identity, { cleanup = false } = {}) {
    const task = team.tasks.find((entry) => entry.id === identity.taskId && entry.agentId === identity.agentId);
    if (!task || !['running', ...(cleanup ? ['reconciling'] : [])].includes(task.status)
      || identity.claim?.taskId !== task.id || identity.claim?.workerId !== task.worker?.id
      || identity.claim?.claimId !== task.worker?.claimId
      || (!cleanup && (task.cancelRequestedAt || !team.execution?.enabled || !team.agents.find((agent) => agent.id === identity.agentId)?.enabled))) {
      fail('Active engine claim required.', 'team_claim_required', 403);
    }
    return task;
  }

  async getEngineSession(identity) {
    const team = await this.get(identity.teamId, identity.ownerId);
    this.engineTask(team, identity);
    return team.agents.find((agent) => agent.id === identity.agentId).engineSession || null;
  }

  async saveEngineSession(identity, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || /[\x00-\x1f]/.test(sessionId)) fail('Invalid engine session.');
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), (team) => {
      this.engineTask(team, identity);
      const agent = team.agents.find((entry) => entry.id === identity.agentId);
      // Restart must load the same session. A new id is not continuity.
      if (agent.engineSession?.sessionId && agent.engineSession.sessionId !== sessionId) fail('Engine session changed unexpectedly.', 'team_session_conflict', 409);
      agent.engineSession = { runtime: 'grok-build', sessionId, updatedAt: this.now() };
      return agent.engineSession;
    });
  }

  async recordWorkerLease(identity, record) {
    const allowed = ['leaseId', 'namespace', 'podName', 'secretName', 'pvcName', 'podUid', 'secretUid', 'pvcUid', 'phase', 'reason'];
    if (!record || Object.keys(record).some((key) => !allowed.includes(key)) || !record.leaseId || !record.phase
      || Object.values(record).some((value) => typeof value !== 'string' || value.length > 256 || /[\x00-\x1f]/.test(value))) fail('Invalid worker lease record.');
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), (team) => {
      const task = this.engineTask(team, identity, { cleanup: true });
      if (task.engineLease && task.engineLease.leaseId !== record.leaseId) fail('Existing worker lease must be reconciled.', 'team_lease_conflict', 409);
      task.engineLease = { ...task.engineLease, ...record, updatedAt: this.now() };
      return task.engineLease;
    });
  }

  // Deployment/supervisor API only; not reachable through team_command or an
  // owner HTTP command. Row-lock transactions fence competing browser owners.
  async reserveComputerLease(identity, input) {
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), (team, clock) => {
      const task = this.engineTask(team, identity);
      return reserveComputer(team, task, identity, input, clock.now);
    }, { databaseTime: true });
  }

  async recordComputerLease(identity, update) {
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), (team, clock) => {
      const task = this.engineTask(team, identity, { cleanup: true });
      return advanceComputer(team, task, update, clock.now);
    }, { databaseTime: true });
  }

  // Trusted recovery controller only. A helper is durable before any Pod POST;
  // it stays attached to this exact stopped browser lease through restarts.
  async reserveComputerRecoveryHelper(identity, input) {
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), (team, clock) => {
      const task = this.engineTask(team, identity, { cleanup: true });
      if (task.computerLease?.claimId !== task.worker.claimId || task.computerLease?.ownerBootId !== task.worker.executionOwner?.bootId) {
        fail('Exact browser ownership required.', 'team_recovery_helper_conflict', 409);
      }
      return reserveRecoveryHelper(task.computerLease, input, clock.now);
    }, { databaseTime: true });
  }

  async recordComputerRecoveryHelper(identity, update) {
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), (team, clock) => {
      const task = this.engineTask(team, identity, { cleanup: true });
      if (task.computerLease?.claimId !== task.worker.claimId || task.computerLease?.ownerBootId !== task.worker.executionOwner?.bootId) {
        fail('Exact browser ownership required.', 'team_recovery_helper_conflict', 409);
      }
      return advanceRecoveryHelper(task.computerLease, update, clock.now);
    }, { databaseTime: true });
  }

  async beginComputerRecoveryHelperLaunch(identity, input) {
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), (team, clock) => {
      const task = this.engineTask(team, identity, { cleanup: true });
      if (task.computerLease?.claimId !== task.worker.claimId || task.computerLease?.ownerBootId !== task.worker.executionOwner?.bootId) {
        fail('Exact browser ownership required.', 'team_recovery_launch_conflict', 409);
      }
      return beginRecoveryHelperLaunch(task.computerLease, input, clock.now);
    }, { databaseTime: true });
  }

  async reserveComputerRecoveryWrite(identity, input) {
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), (team, clock) => {
      const task = this.engineTask(team, identity, { cleanup: true });
      if (task.computerLease?.claimId !== task.worker.claimId || task.computerLease?.ownerBootId !== task.worker.executionOwner?.bootId) {
        fail('Exact browser ownership required.', 'team_recovery_write_conflict', 409);
      }
      return reserveRecoveryWrite(task.computerLease, input, clock.now);
    }, { databaseTime: true });
  }

  // Trusted observer only. Preserve the first positive stop receipt under the
  // same row lock as ownership. Never upsert, change phase or release capacity.
  async recordComputerStop(identity, evidence) {
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), team => {
      const task = this.engineTask(team, identity, { cleanup: true });
      const lease = task.computerLease;
      let validated;
      try { validated = normalizeBrowserStopEvidence(lease, evidence); }
      catch { fail('Exact browser stop evidence required.', 'team_computer_lease_conflict', 409); }
      if (lease.stopEvidence !== undefined) {
        try { return normalizeBrowserStopEvidence(lease, lease.stopEvidence); }
        catch { fail('Stored browser stop evidence is invalid.', 'team_computer_lease_conflict', 409); }
      }
      if (lease.phase === 'closed') fail('Closed browser evidence cannot be changed.', 'team_computer_lease_conflict', 409);
      lease.stopEvidence = validated;
      return validated;
    }, { databaseTime: true });
  }

  // Private recovery observer API. Archive the exact verified mount/retirement
  // receipt before terminal lease acknowledgment; never release capacity here.
  async recordComputerRecovery(identity, evidence) {
    return this.store.mutate(identity.teamId, this.owner(identity.ownerId), team => {
      const task = this.engineTask(team, identity, { cleanup: true });
      const lease = task.computerLease;
      let validated;
      try { validated = normalizeProfileRecoveryEvidence(lease, evidence); }
      catch { fail('Exact profile recovery evidence required.', 'team_computer_lease_conflict', 409); }
      if (lease.profileRecovery !== undefined) {
        let saved;
        try { saved = normalizeProfileRecoveryEvidence(lease, lease.profileRecovery); }
        catch { fail('Stored profile recovery evidence is invalid.', 'team_computer_lease_conflict', 409); }
        if (!isDeepStrictEqual(saved.volume, validated.volume) || !isDeepStrictEqual(saved.filesystem, validated.filesystem)) {
          fail('Profile recovery evidence changed.', 'team_computer_lease_conflict', 409);
        }
        return saved;
      }
      if (!['closing', 'reconciliation'].includes(lease.phase)) fail('Profile recovery requires closing ownership.', 'team_computer_lease_conflict', 409);
      lease.profileRecovery = validated;
      return validated;
    }, { databaseTime: true });
  }

  async execute(teamId, ownerId, actor, action, input, idempotencyKey, evidence = null) {
    this.owner(ownerId);
    if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(idempotencyKey)) {
      fail('A bounded idempotency key is required.');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ actor, action, input })).digest('hex');
    return this.store.mutate(teamId, ownerId, (team) => {
      const previous = team.receipts.find((receipt) => receipt.key === idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('Idempotency key already used for a different command.', 'team_idempotency_conflict', 409);
        return previous.result;
      }
      // Never discard a receipt and accidentally turn an old retry into new work.
      if (team.receipts.length >= 4000) fail('Team command budget reached.', 'team_command_limit', 409);
      const result = command(team, evidence ? { ...actor, ...evidence } : actor, action, input, this.now());
      team.receipts.push({ key: idempotencyKey, fingerprint, result: structuredClone(result) });
      return result;
    });
  }

  // Public callers cannot choose a sender. Worker commands require a current
  // claim, resolved server-side against the same team's task and agent.
  async ownerCommand(teamId, ownerId, action, input = {}, key) {
    if (action === 'review_task' && input.approved === true) {
      const before = await this.get(teamId, ownerId);
      // A successful receipt remains replayable even if external storage later
      // goes offline. execute still validates its exact command fingerprint.
      if (before.receipts.some((receipt) => receipt.key === key)) return this.execute(teamId, ownerId, {}, action, input, key);
      const task = before.tasks.find((entry) => entry.id === input.taskId);
      if (!task || task.status !== 'needs_review' || !task.result?.artifacts?.length || !this.verifyArtifact) {
        fail('Verified artifact read-back is required before completion.', 'team_evidence_required', 409);
      }
      const readArtifactHashes = {};
      for (const artifact of task.result.artifacts) {
        const verified = await this.verifyArtifact({ teamId, ownerId, agentId: task.agentId, taskId: task.id, artifactId: artifact.id });
        if (verified?.id !== artifact.id || verified?.sha256 !== artifact.sha256) {
          fail('Artifact bytes changed or could not be verified.', 'team_evidence_required', 409);
        }
        readArtifactHashes[artifact.id] = artifact.sha256;
      }
      // The locked domain transition compares these hashes to CURRENT result
      // references, preventing a changed result during asynchronous read-back.
      return this.execute(teamId, ownerId, {}, action, input, key, { readArtifactHashes });
    }
    return this.execute(teamId, ownerId, {}, action, input, key);
  }

  async workerCommand(teamId, ownerId, claim, action, input = {}, key) {
    this.owner(ownerId);
    // Validation and mutation must share the row lock; no TOCTOU claim check.
    return this.store.mutate(teamId, ownerId, (team) => {
      const task = team.tasks.find((entry) => entry.id === claim?.taskId);
      if (!task || task.status !== 'running' || task.cancelRequestedAt
        || team.execution?.enabled !== true || !team.agents.find((agent) => agent.id === task.agentId)?.enabled
        || task.worker?.id !== claim.workerId || task.worker?.claimId !== claim.claimId) {
        fail('Active worker claim required.', 'team_claim_required', 403);
      }
      if (typeof key !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(key)) fail('A bounded idempotency key is required.');
      const receiptKey = `worker:${task.id}:${key}`;
      const fingerprint = createHash('sha256').update(JSON.stringify({ action, input })).digest('hex');
      const previous = team.receipts.find((entry) => entry.key === receiptKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('Idempotency conflict.', 'team_idempotency_conflict', 409);
        return previous.result;
      }
      if (team.receipts.length >= 4000) fail('Team command budget reached.', 'team_command_limit', 409);
      const result = command(team, { agentId: task.agentId, reviewOf: task.reviewOf,
        readArtifactHashes: Object.fromEntries(Object.entries(task.artifactReads || {}).filter(([, read]) => read.complete).map(([id, read]) => [id, read.sha256])),
      }, action, input, this.now());
      team.receipts.push({ key: receiptKey, fingerprint, result: structuredClone(result) });
      return result;
    });
  }

  async claim(teamId, ownerId, workerId) {
    return this.store.mutate(teamId, this.owner(ownerId), (team) => {
      const now = this.now();
      tickRoutines(team, now);
      return claimTasks(team, workerId, now);
    });
  }

  async claimEnabled(teamId, ownerId, workerId, limit = 8, executionOwner) {
    const owner = executionOwner === undefined ? null : normalizeExecutionOwner(executionOwner);
    return this.store.mutate(teamId, this.owner(ownerId), (team) => {
      if (team.execution?.enabled !== true) return [];
      const now = this.now();
      tickRoutines(team, now);
      const tasks = claimTasks(team, workerId, now, limit);
      // Ownership and claim commit together, before the runner can dispatch.
      // Legacy/internal fixture claims without ownership are not recoverable
      // by inference; absence is never evidence of a terminated executor.
      if (owner) for (const task of tasks) task.worker.executionOwner = structuredClone(owner);
      return tasks;
    });
  }

  async heartbeat(teamId, ownerId, claim, safeEvent = null) {
    return this.store.mutate(teamId, this.owner(ownerId), (team) => {
      const task = team.tasks.find((entry) => entry.id === claim.taskId);
      if (task?.status !== 'running' || task.worker?.id !== claim.workerId || task.worker?.claimId !== claim.claimId) {
        fail('Active worker claim required.', 'team_claim_required', 403);
      }
      task.worker.heartbeatAt = this.now();
      if (safeEvent) {
        // Never persist raw tool arguments, outputs, page metadata or image data.
        const safe = { type: String(safeEvent.type || 'worker.activity').slice(0, 80),
          tool: String(safeEvent.tool || '').slice(0, 100), callId: String(safeEvent.callId || '').slice(0, 160) };
        if (safe.type === 'tool_started' && /^[A-Za-z0-9_-]{1,100}$/.test(safe.tool) && SAFE_ID.test(safe.callId)) {
          task.worker.activity = { kind: safe.tool === 'team_wait' ? 'waiting_for_team' : 'using_tool',
            tool: safe.tool, callId: safe.callId, since: this.now() };
        } else if (['tool_finished', 'tool_failed'].includes(safe.type) && safe.callId === task.worker.activity?.callId) {
          delete task.worker.activity;
        } else if (safe.type === 'model_started') {
          task.worker.activity = { kind: 'working', since: this.now() };
        } else if (['model_finished', 'bridge_closed'].includes(safe.type)) {
          delete task.worker.activity;
        }
        team.events.push({ ...safe, id: require('crypto').randomUUID(), taskId: task.id, agentId: task.agentId, at: this.now() });
        team.events = team.events.slice(-2000);
      }
      return { cancelled: Boolean(task.cancelRequestedAt || !team.agents.find((agent) => agent.id === task.agentId)?.enabled || team.execution?.enabled !== true) };
    });
  }

  async unobserved(teamId, ownerId, claim, diagnostic = null) {
    return this.store.mutate(teamId, this.owner(ownerId), (team) => {
      const task = team.tasks.find((entry) => entry.id === claim.taskId);
      if (task?.status !== 'running' || task.worker?.claimId !== claim.claimId || task.worker?.id !== claim.workerId) return false;
      // Keep occupying the slot. Observation loss cannot prove a tool stopped.
      task.status = 'reconciling';
      task.observationIssue = 'Worker outcome unavailable; inspect the existing execution before retrying.';
      if (diagnostic && ['provider_authentication', 'provider_endpoint_or_model', 'provider_rate_limit',
        'provider_http_error', 'provider_timeout', 'provider_connection', 'execution_aborted', 'execution_error'].includes(diagnostic.category)) {
        task.executionError = { category: diagnostic.category,
          ...(Number.isInteger(diagnostic.status) && diagnostic.status >= 400 && diagnostic.status <= 599 ? { status: diagnostic.status } : {}) };
      }
      return true;
    });
  }

  // Trusted recovery controller only. A lease authorizes investigation, not a
  // replacement executor. No public command exposes this transition.
  async beginReconciliation(teamId, ownerId, claim, { investigatorId, leaseMs = 30000 } = {}) {
    if (typeof investigatorId !== 'string' || !SAFE_ID.test(investigatorId)
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60000) fail('Invalid recovery lease.');
    return this.store.mutate(teamId, this.owner(ownerId), (team, clock) => {
      const task = operationTask(team, claim, true);
      const owner = normalizeExecutionOwner(task.worker.executionOwner);
      const previous = task.worker.reconciliation;
      if (previous?.status === 'investigating' && Date.parse(previous.expiresAt) > Date.parse(clock.now)) return null;
      task.status = 'reconciling';
      task.observationIssue = 'Recovery is inspecting the existing execution; no replacement was started.';
      task.worker.reconciliation = { id: randomUUID(), investigatorId, claimId: claim.claimId, ownerBootId: owner.bootId,
        status: 'investigating', startedAt: clock.now, expiresAt: new Date(Date.parse(clock.now) + leaseMs).toISOString() };
      return structuredClone(task.worker.reconciliation);
    }, { databaseTime: true });
  }

  // evidence must come from the configured authoritative observer, never from
  // model text or an owner request. A positive artifact read alone is not enough.
  async finishReconciliation(teamId, ownerId, claim, leaseId, evidence) {
    const keys = ['receiptId', 'claimId', 'ownerBootId', 'ownerStopped', 'workerStopped', 'browserStopped'];
    if (!plainRecord(evidence) || Object.keys(evidence).length !== keys.length || !keys.every(key => Object.hasOwn(evidence, key))
      || typeof evidence.receiptId !== 'string' || !SAFE_ID.test(evidence.receiptId) || evidence.claimId !== claim?.claimId
      || !['ownerStopped', 'workerStopped', 'browserStopped'].every(key => evidence[key] === true)) fail('Authoritative quiescence evidence required.', 'team_recovery_evidence_required', 409);
    const receipt = Object.fromEntries(keys.map(key => [key, evidence[key]]));
    const before = await this.get(teamId, ownerId);
    const task = before.tasks.find(entry => entry.id === claim?.taskId);
    const matching = entry => entry?.worker?.id === claim?.workerId && entry.worker.claimId === claim?.claimId;
    if (!matching(task) || task.worker.executionOwner?.bootId !== receipt.ownerBootId) fail('Recovery owner changed.', 'team_recovery_stale', 409);
    const replay = entry => matching(entry) && ['failed', 'cancelled'].includes(entry.status)
      && entry.worker.executionOwner?.bootId === receipt.ownerBootId
      && entry.worker.reconciliation?.id === leaseId && entry.worker.reconciliation.status === 'complete'
      // PostgreSQL JSONB canonicalizes key order; receipt equality is semantic.
      && Object.keys(entry.worker.reconciliation.receipt || {}).length === keys.length
      && keys.every(key => entry.worker.reconciliation.receipt[key] === receipt[key]);
    if (replay(task)) return task;
    operationTask(before, claim, true); requireSettledOperations(task); requireClosedComputer(task);
    const artifacts = recoveryArtifacts(task);
    for (const artifact of artifacts) {
      if (!this.verifyArtifact) fail('Recovered artifacts require read-back.', 'team_evidence_required', 409);
      const read = await this.verifyArtifact({ teamId, ownerId, taskId: task.id, agentId: task.agentId, artifactId: artifact.id });
      if (read?.id !== artifact.id || read?.sha256 !== artifact.sha256) fail('Recovered artifact changed.', 'team_evidence_required', 409);
    }
    return this.store.mutate(teamId, this.owner(ownerId), (team, clock) => {
      const saved = team.tasks.find(entry => entry.id === claim.taskId);
      // A competing completion may have committed while artifact reads ran.
      if (replay(saved)) return saved;
      const current = operationTask(team, claim, true);
      const lease = recoveryLease(current, leaseId, clock.now);
      if (lease.ownerBootId !== receipt.ownerBootId) fail('Recovery owner changed.', 'team_recovery_stale', 409);
      requireSettledOperations(current);
      requireClosedComputer(current);
      if (JSON.stringify(recoveryArtifacts(current)) !== JSON.stringify(artifacts)) fail('Recovery evidence changed during read-back.', 'team_recovery_stale', 409);
      // Release once, preserve identities/outputs, never claim task success or
      // enqueue a retry. Continuation is a separate explicit assignment.
      current.status = current.cancelRequestedAt ? 'cancelled' : 'failed';
      current.result = { summary: 'Interrupted execution was reconciled. Saved artifacts were retained; the assignment was not marked successful.',
        artifacts, finishedAt: clock.now };
      delete current.observationIssue;
      lease.status = 'complete'; lease.finishedAt = clock.now; lease.receipt = receipt;
      return current;
    }, { databaseTime: true });
  }

  async recordArtifactRead(teamId, ownerId, claim, { artifactId, sha256, offset, length, total }) {
    return this.store.mutate(teamId, this.owner(ownerId), (team) => {
      const task = team.tasks.find((entry) => entry.id === claim.taskId);
      if (task?.status !== 'running' || task.cancelRequestedAt || task.worker?.id !== claim.workerId || task.worker?.claimId !== claim.claimId) fail('Active worker claim required.', 'team_claim_required', 403);
      task.artifactReads ||= {};
      if (!task.artifactReads[artifactId] && Object.keys(task.artifactReads).length >= 40) fail('Artifact read tracking limit reached.');
      const read = task.artifactReads[artifactId]?.sha256 === sha256 ? task.artifactReads[artifactId] : { sha256, ranges: [] };
      read.ranges.push([offset, Math.min(total, offset + length)]);
      read.ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const range of read.ranges) {
        const last = merged.at(-1);
        if (last && last[1] >= range[0]) last[1] = Math.max(last[1], range[1]);
        else merged.push(range);
      }
      read.ranges = merged;
      read.complete = Boolean(merged[0]?.[0] === 0 && merged[0][1] >= total);
      task.artifactReads[artifactId] = read;
      return { complete: read.complete };
    });
  }

  // Trusted adapter only: reserve before dispatch. A retry is never permission
  // to run an effect again, even when an earlier adapter observed settlement.
  async beginOperation(teamId, ownerId, claim, input) {
    this.owner(ownerId);
    if (!plainRecord(input) || Object.keys(input).some((key) => !['callId', 'kind', 'fingerprint', 'toolId'].includes(key))
      || typeof input.callId !== 'string' || !SAFE_ID.test(input.callId)
      || !OPERATION_KINDS.has(input.kind) || typeof input.fingerprint !== 'string' || !SHA256.test(input.fingerprint)
      || (Object.hasOwn(input, 'toolId') && (input.kind !== 'lilly_tool'
        || typeof input.toolId !== 'string' || !/^[a-z0-9-]{1,100}$/.test(input.toolId)))) {
      fail('Invalid operation reservation.');
    }
    const { callId, kind, fingerprint, toolId } = input;
    return this.store.mutate(teamId, ownerId, (team) => {
      const task = operationTask(team, claim);
      const journal = operations(task);
      const previous = journal.find((entry) => entry?.callId === callId);
      if (previous) {
        if (previous.kind !== kind || previous.fingerprint !== fingerprint || previous.toolId !== toolId) {
          fail('Operation call ID already used for a different request.', 'team_idempotency_conflict', 409);
        }
        fail('Operation already reserved; do not dispatch again.', 'team_operation_replayed', 409);
      }
      // A changed call ID is not proof that an unknown effect stopped. Distinct
      // in-flight effects remain parallel, but identical pending work is fenced.
      if (journal.some((entry) => !entry || !['started', 'settled'].includes(entry.status)
        || (entry.status === 'started' && entry.kind === kind && entry.fingerprint === fingerprint && entry.toolId === toolId))) {
        fail('Worker operations require settlement before this dispatch.', 'team_operations_unsettled', 409);
      }
      if (journal.length >= 100) fail('Task operation budget reached.', 'team_operation_limit', 409);
      const operation = { id: randomUUID(), callId, kind, fingerprint, status: 'started', startedAt: this.now() };
      if (toolId !== undefined) operation.toolId = toolId;
      task.operations = [...journal, operation];
      return operation;
    });
  }

  // Cancellation and lost observation do not invalidate trusted late evidence.
  // No public team command can invoke this method or assert effect completion.
  async settleOperation(teamId, ownerId, claim, operationId, input) {
    this.owner(ownerId);
    if (typeof operationId !== 'string' || !SAFE_ID.test(operationId)
      || !plainRecord(input) || Object.keys(input).some((key) => !['status', 'artifact'].includes(key))
      || !['settled', 'unknown'].includes(input.status)) fail('Invalid operation settlement.');
    let artifact;
    if (Object.hasOwn(input, 'artifact')) {
      const value = input.artifact;
      if (!plainRecord(value) || Object.keys(value).some((key) => !['id', 'sha256'].includes(key))
        || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 160 || /[\x00-\x1f\x7f]/.test(value.id)
        || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) fail('Invalid operation artifact evidence.');
      artifact = { id: value.id, sha256: value.sha256 };
    }
    const status = input.status;
    return this.store.mutate(teamId, ownerId, (team) => {
      const task = operationTask(team, claim, true);
      const operation = operations(task).find((entry) => entry.id === operationId);
      if (!operation) fail('Operation reservation not found.', 'team_operation_not_found', 404);
      const sameArtifact = operation.artifact?.id === artifact?.id && operation.artifact?.sha256 === artifact?.sha256;
      if (operation.status === status && sameArtifact) return operation;
      const lateSettlement = operation.status === 'unknown' && status === 'settled'
        && (!operation.artifact || sameArtifact);
      if (operation.status !== 'started' && !lateSettlement) {
        fail('Operation settlement contradicts existing evidence.', 'team_operation_conflict', 409);
      }
      operation.status = status;
      operation[status === 'settled' ? 'settledAt' : 'unknownAt'] = this.now();
      if (artifact) operation.artifact = artifact;
      return operation;
    });
  }

  // Only the execution adapter calls this after its authoritative terminal
  // observation. Model-provided artifact IDs alone never prove a saved output.
  async recordResult(teamId, ownerId, claim, result = {}) {
    this.owner(ownerId);
    const before = await this.get(teamId, ownerId);
    const task = before.tasks.find((entry) => entry.id === claim?.taskId);
    const validClaim = (entry) => entry?.status === 'running' && entry.worker?.id === claim?.workerId
      && entry.worker?.claimId === claim?.claimId;
    if (!validClaim(task)) fail('Active worker claim required.', 'team_claim_required', 403);
    requireSettledOperations(task);
    requireClosedComputer(task);
    if (!['succeeded', 'failed', 'cancelled'].includes(result.status)) fail('Terminal worker status required.');
    if (typeof result.summary !== 'string' || result.summary.length > 12000) fail('Bounded result summary required.');
    const ids = result.artifactIds || [];
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== 'string' || id.length > 160)) fail('Invalid artifact IDs.');
    const artifacts = [];
    const verifiedFilenames = new Set();
    if (result.status === 'succeeded' && this.verifyArtifact) {
      for (const id of [...new Set(ids)]) {
        const evidence = await this.verifyArtifact({ teamId, ownerId, agentId: task.agentId, taskId: task.id, artifactId: id });
        if (evidence?.id !== id || typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256)) {
          fail('Artifact read-back could not be verified.', 'team_evidence_required', 409);
        }
        artifacts.push({ id, sha256: evidence.sha256 });
        verifiedFilenames.add(evidence.filename);
      }
    }
    if (result.status === 'succeeded' && (task.requiredArtifacts || []).some(name => !verifiedFilenames.has(name))) {
      fail('Required deliverables were not verified.', 'team_completion_evidence_missing', 409);
    }
    return this.store.mutate(teamId, ownerId, (team) => {
      const current = team.tasks.find((entry) => entry.id === claim.taskId);
      if (!validClaim(current)) fail('Worker claim changed during result verification.', 'team_claim_required', 403);
      requireSettledOperations(current);
      requireClosedComputer(current);
      // A stop request does not falsify a worker's observed outcome. It remains
      // visible alongside the result for operator review.
      current.status = result.status === 'succeeded' ? 'needs_review' : result.status;
      current.result = { summary: result.summary, artifacts, finishedAt: this.now() };
      if (current.status === 'needs_review' && current.reviewerId && artifacts.length && team.tasks.length < team.limits.maxTasks) {
        const review = command(team, {}, 'assign_task', {
          agentId: current.reviewerId, reviewOf: current.id,
          title: `Review: ${current.title}`.slice(0, 200),
          instruction: `Independently review task ${current.id}. Use team_task with taskId ${current.id} to read the full assignment and pinned skill. Read every artifact with artifact_read: ${artifacts.map((artifact) => artifact.id).join(', ')}. Requested outcome excerpt: ${current.instruction.slice(0, 3500)}.\n${current.skill?.acceptance ? `Pinned skill revision ${current.skill.revision} acceptance checks:\n${current.skill.acceptance}\n` : ''}Use team_command review_task with taskId, approved, and an evidence-based note. Save a review artifact. Do not approve based on the author's completion claim.`,
        }, this.now());
        current.reviewTaskId = review.id;
      } else if (current.status === 'needs_review' && current.reviewerId && artifacts.length) {
        current.reviewQueueIssue = 'Team task budget reached; result retained for owner review.';
      }
      const agent = team.agents.find((entry) => entry.id === current.agentId);
      agent.restUntil = new Date(Date.parse(this.now()) + team.limits.restSeconds * 1000).toISOString();
      return current;
    });
  }
}

module.exports = { TeamService };

'use strict';

const { observeBrowserContainerStop } = require('./node-binding');
const { createBrowserStopEvidence, normalizeBrowserStopEvidence } = require('./stop-evidence');
const fail = () => Object.assign(new Error('Private browser stop archive is unavailable.'), { code: 'computer_stop_archive_unknown' });

function scope(input) {
  const result = {};
  for (const key of ['ownerId', 'teamId', 'agentId', 'taskId']) {
    if (typeof input?.[key] !== 'string' || !input[key] || input[key].length > 256) throw fail();
    result[key] = input[key];
  }
  result.claim = {};
  for (const key of ['taskId', 'workerId', 'claimId']) {
    if (typeof input.claim?.[key] !== 'string' || !input.claim[key] || input.claim[key].length > 256) throw fail();
    result.claim[key] = input.claim[key];
  }
  if (result.taskId !== result.claim.taskId) throw fail();
  return result;
}

// Runs only in a trusted node observer. Uses Lilly's existing task row as an
// immutable receipt archive; it neither provisions resources nor releases a
// profile. No owner/model command is added. An absent runtime record is unknown
// unless this exact bound container already has positively observed evidence.
class BrowserStopArchive {
  constructor({ service, reader, now = () => new Date().toISOString(), maxPending = 16 } = {}) {
    if (!['get', 'recordComputerStop'].every(key => typeof service?.[key] === 'function')
      || !['inspectContainer', 'readCgroup'].every(key => typeof reader?.[key] === 'function')
      || typeof now !== 'function' || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) throw fail();
    Object.assign(this, { service, reader, now, maxPending });
    this.pending = new Map(); this.stopped = false;
  }

  stop() { this.stopped = true; }

  async ownedLease(input) {
    const identity = scope(input);
    const team = await this.service.get(identity.teamId, identity.ownerId);
    const task = team.tasks?.find(value => value.id === identity.taskId && value.agentId === identity.agentId);
    if (team.id !== identity.teamId || team.ownerId !== identity.ownerId || !task?.computerLease
      || task.worker?.id !== identity.claim.workerId || task.worker.claimId !== identity.claim.claimId
      || task.computerLease.claimId !== identity.claim.claimId || task.computerLease.ownerBootId !== task.worker.executionOwner?.bootId) throw fail();
    return task.computerLease;
  }

  async read(input) {
    try {
      const lease = await this.ownedLease(input);
      return lease.stopEvidence === undefined ? null : normalizeBrowserStopEvidence(lease, lease.stopEvidence);
    } catch { throw fail(); }
  }

  capture(input, { signal } = {}) {
    let identity;
    try { identity = scope(input); } catch { return Promise.reject(fail()); }
    const key = JSON.stringify(identity);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.stopped || signal?.aborted) return Promise.resolve(null);
    if (this.pending.size >= this.maxPending) return Promise.reject(fail());
    const work = this.captureOnce(identity, signal).catch(() => { throw fail(); }).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  async captureOnce(identity, signal) {
    const lease = await this.ownedLease(identity);
    if (this.stopped || signal?.aborted) return null;
    if (lease.stopEvidence !== undefined) return normalizeBrowserStopEvidence(lease, lease.stopEvidence);
    const observation = await observeBrowserContainerStop({ lease, reader: this.reader, signal, now: this.now });
    if (!observation || this.stopped || signal?.aborted) return null;
    const receipt = createBrowserStopEvidence(lease, observation);
    // Once dispatched, retain the write obligation through cancellation or a
    // lost reply. A subsequent read recovers a committed record, never fabricates
    // success or replaces the first receipt with a newer timestamp.
    await this.service.recordComputerStop(identity, receipt);
    const saved = await this.read(identity);
    if (!saved) throw fail();
    return saved;
  }
}

module.exports = { BrowserStopArchive };

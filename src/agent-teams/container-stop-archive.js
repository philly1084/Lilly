'use strict';

const { createHash } = require('node:crypto');
const { normalizeExecutionOwner } = require('./execution-owner');
const { observeContainerStop } = require('./container-stop');
const fail = () => Object.assign(new Error('Container stop archive unavailable or invalid.'), { code: 'team_stop_archive_unavailable' });

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function ownerIdentity(input) {
  const owner = normalizeExecutionOwner(input);
  if (owner.containerBinding?.version !== 2) throw fail();
  return { owner, fingerprint: createHash('sha256').update(canonical(owner)).digest('hex') };
}

function receiptShape(value) {
  const keys = ['version', 'ownerFingerprint', 'ownerBootId', 'containerId', 'stopped', 'source', 'observedAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key)) || value.version !== 1
    || typeof value.ownerFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.ownerFingerprint)
    || typeof value.ownerBootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.ownerBootId)
    || typeof value.containerId !== 'string' || !/^containerd:\/\/[a-f0-9]{64}$/.test(value.containerId)
    || value.stopped !== true || value.source !== 'cri-exited-and-cgroup-v2-empty'
    || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))
    || new Date(value.observedAt).toISOString() !== value.observedAt) throw fail();
}

function receiptFor(owner, fingerprint, observation) {
  const expected = ['ownerBootId', 'containerId', 'stopped', 'source', 'observedAt'];
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)
    || Object.keys(observation).length !== expected.length || !expected.every(key => Object.hasOwn(observation, key))
    || observation.stopped !== true || observation.source !== 'cri-exited-and-cgroup-v2-empty'
    || observation.ownerBootId !== owner.bootId || observation.containerId !== owner.containerBinding.containerId
    || typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt))
    || new Date(observation.observedAt).toISOString() !== observation.observedAt
    || Date.parse(observation.observedAt) < Date.parse(owner.containerBinding.observedAt)) throw fail();
  return { version: 1, ownerFingerprint: fingerprint, ...Object.fromEntries(expected.map(key => [key, observation[key]])) };
}

function validateReceipt(value, owner, fingerprint) {
  receiptShape(value);
  if (value.ownerFingerprint !== fingerprint) throw fail();
  const { version, ownerFingerprint, ...observation } = value;
  return receiptFor(owner, fingerprint, observation);
}

// Internal persistence only. It has no owner/model HTTP route. Deployment must
// grant writes solely to the trusted observer and protect its DB credentials.
// No upsert, expiry, overwrite, timestamp-based retry or implicit production DB.
class ContainerStopStore {
  constructor({ database } = {}) {
    if (!database || typeof database.query !== 'function') throw fail();
    this.database = database; this.ready = null;
  }

  async initialize() {
    if (!this.ready) this.ready = this.database.query(`CREATE TABLE IF NOT EXISTS lilly_container_stop_receipts (
      owner_fingerprint TEXT PRIMARY KEY, receipt JSONB NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`).catch(error => { this.ready = null; throw error; });
    await this.ready;
  }

  async get(fingerprint) {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw fail();
    await this.initialize();
    const result = await this.database.query('SELECT receipt FROM lilly_container_stop_receipts WHERE owner_fingerprint = $1', [fingerprint]);
    return result.rows[0]?.receipt || null;
  }

  async insertOnce(receipt) {
    receiptShape(receipt);
    if (Buffer.byteLength(JSON.stringify(receipt)) > 2048) throw fail();
    await this.initialize();
    const result = await this.database.query(`INSERT INTO lilly_container_stop_receipts (owner_fingerprint, receipt)
      VALUES ($1, $2::jsonb) ON CONFLICT (owner_fingerprint) DO NOTHING RETURNING receipt`,
    [receipt.ownerFingerprint, JSON.stringify(receipt)]);
    return result.rows[0]?.receipt || this.get(receipt.ownerFingerprint);
  }
}

class ContainerStopArchive {
  constructor({ store, inspectContainer, readCgroup, now = () => new Date().toISOString(), maxPending = 16 } = {}) {
    if (!store || !['get', 'insertOnce'].every(key => typeof store[key] === 'function')
      || ![inspectContainer, readCgroup, now].every(fn => typeof fn === 'function')
      || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) throw fail();
    Object.assign(this, { store, inspectContainer, readCgroup, now, maxPending });
    this.pending = new Map(); this.stopped = false;
  }

  stop() { this.stopped = true; }

  async read(input) {
    try {
      const { owner, fingerprint } = ownerIdentity(input);
      const saved = await this.store.get(fingerprint);
      return saved === null ? null : validateReceipt(saved, owner, fingerprint);
    } catch { throw fail(); }
  }

  capture(input) {
    let owner; let fingerprint;
    try { ({ owner, fingerprint } = ownerIdentity(input)); } catch { return Promise.reject(fail()); }
    if (this.pending.has(fingerprint)) return this.pending.get(fingerprint);
    if (this.stopped) return Promise.resolve(null);
    if (this.pending.size >= this.maxPending) return Promise.reject(fail());
    const work = this.captureOnce(owner, fingerprint).catch(() => { throw fail(); }).finally(() => this.pending.delete(fingerprint));
    this.pending.set(fingerprint, work);
    return work;
  }

  async captureOnce(owner, fingerprint) {
    // Returning a retained receipt is a historical observation, not a new live
    // probe. Consumers must still enforce lifecycle fencing and reconcile every
    // separate worker/browser/effect before authorizing a replacement.
    const existing = await this.read(owner);
    if (existing || this.stopped) return existing;
    const observation = await observeContainerStop({ owner, inspectContainer: this.inspectContainer, readCgroup: this.readCgroup, now: this.now });
    if (!observation || this.stopped) return null;
    const receipt = receiptFor(owner, fingerprint, observation);
    // A DB write may commit after stop or after its reply is lost. Retain the
    // original pending promise; read the immutable record on recovery. Never
    // replace missing acknowledgement with fabricated stop evidence.
    await this.store.insertOnce(receipt);
    const saved = await this.read(owner);
    if (!saved) throw fail();
    return saved;
  }
}

module.exports = { ContainerStopStore, ContainerStopArchive, ownerIdentity };

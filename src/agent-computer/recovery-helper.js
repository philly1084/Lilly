'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { normalizeBrowserStopEvidence } = require('./stop-evidence');
const { normalizeCgroup } = require('../agent-teams/cgroup-reader');
const fail = () => Object.assign(new Error('Private recovery helper ownership requires reconciliation.'), { code: 'team_recovery_helper_conflict', statusCode: 409 });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const image = value => typeof value === 'string' && /^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(value);

function helperIdentity(lease, helper) {
  const stop = normalizeBrowserStopEvidence(lease, lease?.stopEvidence);
  if (!helper || helper.version !== 1 || !uuid(helper.helperId) || helper.helperId === lease.leaseId || !image(helper.image)
    || helper.leaseId !== lease.leaseId || helper.claimId !== lease.claimId || helper.ownerBootId !== lease.ownerBootId
    || helper.namespace !== lease.namespace || helper.pvcName !== lease.pvcName || helper.pvcUid !== lease.pvcUid
    || !/^[a-f0-9]{64}$/.test(lease.profileKey || '') || helper.profileKey !== lease.profileKey || helper.stopFingerprint !== stop.fingerprint
    || helper.podName !== `profile-recovery-${hash([lease.leaseId, helper.helperId]).slice(0, 32)}`) throw fail();
  return { helperId: helper.helperId, leaseId: helper.leaseId, claimId: helper.claimId, ownerBootId: helper.ownerBootId,
    namespace: helper.namespace, podName: helper.podName, pvcName: helper.pvcName, pvcUid: helper.pvcUid,
    profileKey: helper.profileKey, stopFingerprint: helper.stopFingerprint, image: helper.image };
}

function normalizeRecoveryHelperBinding(lease, helper, value) {
  helperIdentity(lease, helper);
  const fields = ['version', 'podUid', 'containerId', 'nodeName', 'hostBootId', 'initPid', 'initStartTicks', 'pidNamespace', 'mountNamespace', 'cgroup', 'observedAt'];
  if (!exact(value, fields) || value.version !== 1 || !uuid(helper.podUid) || value.podUid !== helper.podUid
    || !/^containerd:\/\/[a-f0-9]{64}$/.test(helper.containerId || '') || value.containerId !== helper.containerId
    || value.nodeName !== lease.nodeBinding.nodeName || value.hostBootId !== lease.nodeBinding.hostBootId
    || !Number.isSafeInteger(value.initPid) || value.initPid < 2 || value.initPid > 2147483647
    || !['initStartTicks', 'pidNamespace', 'mountNamespace'].every(key => decimal(value[key]))
    || !time(value.observedAt) || Date.parse(value.observedAt) < Date.parse(lease.stopEvidence.observedAt)) throw fail();
  return { version: 1, podUid: helper.podUid, containerId: helper.containerId, nodeName: value.nodeName,
    hostBootId: value.hostBootId, initPid: value.initPid, initStartTicks: value.initStartTicks,
    pidNamespace: value.pidNamespace, mountNamespace: value.mountNamespace,
    cgroup: normalizeCgroup(value.cgroup, helper.containerId, helper.podUid), observedAt: value.observedAt };
}

function recoveryHelperFingerprint(lease, helper) {
  return hash({ ...helperIdentity(lease, helper), nodeBinding: normalizeRecoveryHelperBinding(lease, helper, helper.nodeBinding) });
}

function normalizeRecoveryHelperStop(lease, helper, value) {
  if (!exact(value, ['version', 'fingerprint', 'source', 'observedAt']) || value.version !== 1
    || value.fingerprint !== recoveryHelperFingerprint(lease, helper)
    || !['cri-exited-and-cgroup-v2-empty', 'cri-exited-and-kernel-owner-retired'].includes(value.source)
    || !time(value.observedAt) || Date.parse(value.observedAt) < Date.parse(helper.nodeBinding.observedAt)) throw fail();
  return { version: 1, fingerprint: value.fingerprint, source: value.source, observedAt: value.observedAt };
}

function isRecoveryHelperClosed(lease) {
  if (!lease) return false;
  if (lease.recoveryHelper === undefined) return true;
  try {
    const helper = lease.recoveryHelper; helperIdentity(lease, helper);
    if (helper.phase !== 'closed') return false;
    if (helper.closure === 'never_created') return !helper.launchStartedAt && !helper.podUid && !helper.containerId && !helper.nodeBinding && !helper.stopEvidence;
    if (helper.closure !== 'observed_stopped' || !time(helper.launchStartedAt)) return false;
    normalizeRecoveryHelperStop(lease, helper, helper.stopEvidence); return true;
  } catch { return false; }
}

function reserveRecoveryHelper(lease, input, now) {
  try {
    if (!exact(input, ['helperId', 'image']) || !uuid(input.helperId) || input.helperId === lease?.leaseId || !image(input.image) || !time(now)) throw fail();
    if (!['closing', 'reconciliation'].includes(lease?.phase)) throw fail();
    const stop = normalizeBrowserStopEvidence(lease, lease.stopEvidence);
    if (lease.recoveryHelper) {
      helperIdentity(lease, lease.recoveryHelper);
      if (lease.recoveryHelper.helperId !== input.helperId || lease.recoveryHelper.image !== input.image) throw fail();
      return lease.recoveryHelper; // Lost reservation reply is a read-back, not another helper.
    }
    if (lease.profileRecovery !== undefined) throw fail();
    lease.recoveryHelper = { version: 1, helperId: input.helperId, image: input.image,
      leaseId: lease.leaseId, claimId: lease.claimId, ownerBootId: lease.ownerBootId, namespace: lease.namespace,
      pvcName: lease.pvcName, pvcUid: lease.pvcUid, profileKey: lease.profileKey, stopFingerprint: stop.fingerprint,
      podName: `profile-recovery-${hash([lease.leaseId, input.helperId]).slice(0, 32)}`,
      phase: 'reserved', createdAt: now, updatedAt: now };
    return lease.recoveryHelper;
  } catch { throw fail(); }
}

function advanceRecoveryHelper(lease, update, now) {
  try {
    const transitions = { reserved: ['provisioning', 'closed', 'reconciliation'], provisioning: ['ready', 'closing', 'reconciliation'],
      ready: ['closing', 'reconciliation'], closing: ['closed', 'reconciliation'], reconciliation: ['closing'], closed: [] };
    const allowed = ['helperId', 'phase', 'podUid', 'containerId', 'nodeBinding', 'stopEvidence', 'reason'];
    if (!update || typeof update !== 'object' || Array.isArray(update) || Object.keys(update).some(key => !allowed.includes(key))
      || !uuid(update.helperId) || !Object.hasOwn(transitions, update.phase) || !time(now)) throw fail();
    const current = lease.recoveryHelper; helperIdentity(lease, current);
    if (current.helperId !== update.helperId || !['closing', 'reconciliation', ...(current.phase === 'closed' ? ['closed'] : [])].includes(lease.phase)
      || !Object.hasOwn(transitions, current.phase) || (current.phase !== update.phase && !transitions[current.phase].includes(update.phase))) throw fail();
    if (current.phase === 'closed') {
      if (!isRecoveryHelperClosed(lease) || Object.keys(update).some(key => !isDeepStrictEqual(update[key], current[key]))) throw fail();
      return current;
    }
    const next = { ...current, phase: update.phase, updatedAt: now };
    if (update.phase === 'provisioning' && !next.launchStartedAt) next.launchStartedAt = now;
    for (const key of ['podUid', 'containerId']) if (Object.hasOwn(update, key)) {
      if (!next.launchStartedAt || (key === 'podUid' ? !uuid(update[key]) : !/^containerd:\/\/[a-f0-9]{64}$/.test(update[key] || ''))
        || (current[key] && current[key] !== update[key])) throw fail();
      next[key] = update[key];
    }
    if (Object.hasOwn(update, 'nodeBinding')) {
      next.nodeBinding = normalizeRecoveryHelperBinding(lease, next, update.nodeBinding);
      if (current.nodeBinding && !isDeepStrictEqual(current.nodeBinding, next.nodeBinding)) throw fail();
    }
    if (Object.hasOwn(update, 'stopEvidence')) {
      const stop = normalizeRecoveryHelperStop(lease, next, update.stopEvidence);
      if (current.stopEvidence) normalizeRecoveryHelperStop(lease, next, current.stopEvidence);
      next.stopEvidence = current.stopEvidence || stop;
    }
    if (Object.hasOwn(update, 'reason')) {
      if (typeof update.reason !== 'string' || !/^[a-z_]{1,100}$/.test(update.reason)) throw fail();
      next.reason = update.reason;
    }
    if (next.phase === 'ready' && !next.nodeBinding) throw fail();
    if (next.phase === 'closed') {
      if (current.phase === 'reserved' && !next.launchStartedAt && !next.podUid && !next.containerId && !next.nodeBinding) next.closure = 'never_created';
      else { normalizeRecoveryHelperStop(lease, next, next.stopEvidence); next.closure = 'observed_stopped'; }
    }
    lease.recoveryHelper = next; return next;
  } catch { throw fail(); }
}

module.exports = { reserveRecoveryHelper, advanceRecoveryHelper, isRecoveryHelperClosed,
  normalizeRecoveryHelperIdentity: helperIdentity, normalizeRecoveryHelperBinding, recoveryHelperFingerprint, normalizeRecoveryHelperStop };

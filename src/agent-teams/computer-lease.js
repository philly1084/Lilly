'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { fail } = require('./domain');
const { normalizeBrowserBinding } = require('../agent-computer/node-binding');
const { normalizeProfileRecoveryEvidence } = require('../agent-computer/profile-recovery-evidence');
const { isBrowserLeaseClosed: closed } = require('../agent-computer/lease-state');
const { identityKey } = require('../agent-computer/runtime');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = () => fail('Private computer ownership requires reconciliation.', 'team_computer_lease_conflict', 409);
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function reserveComputer(team, task, identity, input, now) {
  if (!record(input) || Object.keys(input).some(key => !['leaseId', 'image'].includes(key))) {
    fail('Invalid computer reservation.', 'team_computer_lease_invalid', 400);
  }
  const { leaseId, image } = input;
  if (!uuid(leaseId) || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image || '')
    || !uuid(task.worker?.executionOwner?.bootId)) fail('Verified computer lease identity and immutable image required.', 'team_computer_lease_invalid', 400);
  const identityHash = hash([identity.ownerId, identity.teamId, identity.agentId]);
  const previous = task.computerLease;
  if (previous) {
    if (previous.leaseId !== leaseId || previous.image !== image || previous.claimId !== task.worker.claimId
      || previous.ownerBootId !== task.worker.executionOwner.bootId || previous.identityHash !== identityHash
      || previous.profileKey !== identityKey(identity)) conflict();
    return previous; // An intent retry is a read-back, never another provision.
  }
  if (team.tasks.some(other => other.agentId === task.agentId && other.computerLease && !closed(other.computerLease))) conflict();
  const profile = (team.computerProfiles || []).find(entry => entry.agentId === task.agentId);
  const pvcName = `browser-profile-${identityHash.slice(0, 32)}`;
  if (profile && (!uuid(profile.pvcUid) || profile.identityHash !== identityHash || profile.pvcName !== pvcName || profile.namespace !== 'lilly-team-workers')) conflict();
  task.computerLease = { version: 1, leaseId, image, identityHash, profileKey: identityKey(identity), ownerBootId: task.worker.executionOwner.bootId,
    claimId: task.worker.claimId, namespace: 'lilly-team-workers',
    podName: `browser-${hash([task.id, leaseId]).slice(0, 32)}`, pvcName,
    ...(profile ? { pvcUid: profile.pvcUid } : {}), phase: 'reserved', createdAt: now, updatedAt: now };
  return task.computerLease;
}

function advanceComputer(team, task, update, now) {
  const keys = ['leaseId', 'phase', 'podUid', 'pvcUid', 'containerId', 'nodeBinding', 'reason', 'podStopped', 'profileReleased'];
  const transitions = { reserved: ['provisioning', 'closing', 'reconciliation'], provisioning: ['ready', 'closing', 'reconciliation'],
    ready: ['closing', 'reconciliation'], closing: ['closed', 'reconciliation'], reconciliation: ['closing'], closed: [] };
  if (!record(update) || Object.keys(update).some(key => !keys.includes(key)) || !uuid(update.leaseId)
    || !Object.hasOwn(transitions, update.phase)) fail('Invalid computer lease update.', 'team_computer_lease_invalid', 400);
  const current = task.computerLease;
  if (!current || current.leaseId !== update.leaseId || current.claimId !== task.worker.claimId
    || current.ownerBootId !== task.worker.executionOwner?.bootId || !Object.hasOwn(transitions, current.phase)) conflict();
  if (current.phase !== update.phase && !transitions[current.phase].includes(update.phase)) conflict();
  if (current.phase === 'closed') {
    // A repeated acknowledgement may read the same terminal record, but cannot
    // attach resources or alter the evidence after ownership has been released.
    if (!closed(current) || update.podStopped !== true || update.profileReleased !== true
      || Object.keys(update).some(key => !isDeepStrictEqual(update[key], current[key]))) conflict();
    return current;
  }
  const next = { ...current, phase: update.phase, updatedAt: now };
  for (const key of ['podUid', 'pvcUid', 'containerId']) if (Object.hasOwn(update, key)) {
    const valid = key === 'containerId' ? /^containerd:\/\/[a-f0-9]{64}$/.test(update[key] || '') : uuid(update[key]);
    if (!valid || (current[key] && current[key] !== update[key])) conflict();
    next[key] = update[key];
  }
  if (Object.hasOwn(update, 'nodeBinding')) {
    try { next.nodeBinding = normalizeBrowserBinding(update.nodeBinding, next); } catch { conflict(); }
    if (current.nodeBinding && !isDeepStrictEqual(current.nodeBinding, next.nodeBinding)) conflict();
  }
  if (Object.hasOwn(update, 'reason')) {
    if (typeof update.reason !== 'string' || !/^[a-z_]{1,100}$/.test(update.reason)) fail('Invalid computer lease reason.', 'team_computer_lease_invalid', 400);
    next.reason = update.reason;
  }
  if (next.phase === 'ready' && (!next.podUid || !next.pvcUid || !next.containerId)) conflict();
  if (next.phase === 'closed') {
    // Trusted supervisor only. It must prove both exact process termination and
    // profile-lock release; a deleted Pod or missing heartbeat alone is not this.
    if (update.podStopped !== true || update.profileReleased !== true) conflict();
    if (next.nodeBinding) {
      try { normalizeProfileRecoveryEvidence(next, next.profileRecovery); } catch { conflict(); }
    }
    next.podStopped = true; next.profileReleased = true;
    if (!closed(next)) conflict();
  } else if (Object.hasOwn(update, 'podStopped') || Object.hasOwn(update, 'profileReleased')) conflict();
  if (next.pvcUid) {
    team.computerProfiles ||= [];
    const profile = team.computerProfiles.find(entry => entry.agentId === task.agentId);
    if (profile && (profile.pvcUid !== next.pvcUid || profile.pvcName !== next.pvcName || profile.identityHash !== next.identityHash)) conflict();
    if (!profile) team.computerProfiles.push({ agentId: task.agentId, identityHash: next.identityHash,
      namespace: next.namespace, pvcName: next.pvcName, pvcUid: next.pvcUid });
  }
  task.computerLease = next;
  return next;
}

function requireClosedComputer(task) {
  if (task.computerLease && !closed(task.computerLease)) {
    fail('Private computer cleanup remains unresolved.', 'team_computer_unsettled', 409);
  }
}

module.exports = { reserveComputer, advanceComputer, requireClosedComputer };

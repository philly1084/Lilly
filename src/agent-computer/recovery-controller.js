'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const { bindLocalProfileVolume } = require('./local-profile-volume');
const { bindRecoveryHelperContainer } = require('./recovery-helper-observer');
const { normalizeRecoveryWrite } = require('./recovery-write');
const { normalizeProfileRecoveryEvidence } = require('./profile-recovery-evidence');
const { createRecoveryExec } = require('./recovery-exec');
const { normalizeIdentity } = require('./runtime');
const fail = () => Object.assign(new Error('Private mounted profile recovery is unconfirmed.'), { code: 'computer_mounted_recovery_unknown' });
const stableVolume = ({ observedAt, ...value }) => value;

// Trusted controller component, not an owner/model endpoint. The launcher must
// first persist a ready helper with node identity. This controller composes
// verified PVC/PV + opened mount identity, a single-dispatch SQL intent, private
// helper execution/read-back, post-write verification and durable acknowledgment.
// It deliberately does not release the browser lease or claim helper termination.
function createProfileRecoveryController({ service, reader, readPod, readPVC, readPV, volumeReader, storageRoot,
  execute, cluster, now = () => new Date().toISOString(), maxPending = 16 } = {}) {
  if (!['get', 'reserveComputerRecoveryWrite', 'recordComputerRecovery'].every(key => typeof service?.[key] === 'function')
    || typeof reader?.observeProfileMount !== 'function' || ![readPod, readPVC, readPV, now].every(value => typeof value === 'function')
    || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) throw fail();
  const run = execute || createRecoveryExec({ cluster });
  if (typeof run !== 'function') throw fail();
  const pending = new Map();
  const guard = signal => { if (signal?.aborted) throw fail(); };
  const owned = async identity => {
    const team = await service.get(identity.teamId, identity.ownerId);
    const task = team.tasks?.find(value => value.id === identity.taskId && value.agentId === identity.agentId);
    const lease = task?.computerLease;
    if (team.id !== identity.teamId || team.ownerId !== identity.ownerId || !lease || identity.taskId !== identity.claim?.taskId
      || task.worker?.id !== identity.claim?.workerId || task.worker.claimId !== identity.claim.claimId
      || lease.claimId !== identity.claim.claimId || lease.ownerBootId !== task.worker.executionOwner?.bootId) throw fail();
    return lease;
  };
  const observe = async (lease, signal) => {
    guard(signal);
    const volumeOptions = { lease, readPVC, readPV, reader: volumeReader, storageRoot, signal, now };
    const volume = await bindLocalProfileVolume(volumeOptions);
    const binding = await bindRecoveryHelperContainer({ lease, readPod, reader, signal, now });
    if (!same(binding, lease.recoveryHelper.nodeBinding)) throw fail();
    const mount = await reader.observeProfileMount({ ...binding, root: volume.root }, { signal }); guard(signal);
    if (mount?.version !== 1 || !same(mount.root, volume.root)
      || !['nodeName', 'hostBootId', 'initPid', 'initStartTicks', 'pidNamespace', 'mountNamespace'].every(key => mount[key] === binding[key])
      || !/^[1-9][0-9]{0,19}$/.test(mount.mountId || '')) throw fail();
    const confirmed = await bindLocalProfileVolume(volumeOptions); guard(signal);
    if (!same(stableVolume(volume), stableVolume(confirmed))) throw fail();
    return { volume, mount };
  };
  const once = async (identity, signal) => {
    let lease = await owned(identity); guard(signal);
    if (lease.profileRecovery !== undefined) return normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
    if (lease.recoveryHelper?.phase !== 'ready' || lease.recoveryHelper.stopEvidence) throw fail();
    const before = await observe(lease, signal);
    let reservation;
    try {
      guard(signal);
      reservation = await service.reserveComputerRecoveryWrite(identity, { helperId: lease.recoveryHelper.helperId, operationId: randomUUID(),
        root: before.volume.root, mountId: before.mount.mountId, pvUid: before.volume.pv.uid });
    } catch {
      // The insert may have committed. Inspect its immutable intent; never
      // assume a lost response means the command is safe to dispatch again.
      lease = await owned(identity);
      reservation = { dispatch: false, intent: normalizeRecoveryWrite(lease, lease.recoveryHelper?.writeIntent) };
    }
    lease = await owned(identity); guard(signal);
    if (lease.recoveryHelper?.phase !== 'ready' || lease.recoveryHelper.stopEvidence) throw fail();
    const intent = normalizeRecoveryWrite(lease, lease.recoveryHelper.writeIntent);
    if (!same(intent, reservation.intent) || !same(intent.root, before.volume.root)
      || intent.mountId !== before.mount.mountId || intent.pvUid !== before.volume.pv.uid) throw fail();
    const current = await observe(lease, signal);
    if (!same(stableVolume(current.volume), stableVolume(before.volume)) || !same(current.mount, before.mount)) throw fail();
    guard(signal);
    const output = await run({ mode: reservation.dispatch === true ? 'recover' : 'inspect',
      request: { version: 1, identity, lease, root: intent.root }, signal });
    guard(signal);
    if (output?.version !== 1 || output.helperId !== lease.recoveryHelper.helperId || Object.keys(output).length !== 3) throw fail();
    const after = await observe(lease, signal);
    if (!same(stableVolume(after.volume), stableVolume(before.volume)) || !same(after.mount, before.mount)
      || !same(output.filesystem?.root, intent.root)) throw fail();
    const receipt = normalizeProfileRecoveryEvidence(lease, { version: 1, source: 'verified-pvc-profile-retirement',
      observedAt: now(), volume: after.volume.volume, filesystem: output.filesystem });
    guard(signal);
    try { await service.recordComputerRecovery(identity, receipt); } catch { /* Read back a possibly committed acknowledgment below. */ }
    const savedLease = await owned(identity);
    const saved = normalizeProfileRecoveryEvidence(savedLease, savedLease.profileRecovery);
    if (!same(saved.volume, receipt.volume) || !same(saved.filesystem, receipt.filesystem)) throw fail();
    return saved;
  };
  return {
    recover(identity, { signal } = {}) {
      let key; let scoped;
      try {
        if (!identity || !['ownerId', 'teamId', 'agentId', 'taskId'].every(field => typeof identity[field] === 'string'
          && identity[field].length > 0 && identity[field].length <= 256) || !identity.claim) throw fail();
        const claim = {};
        for (const field of ['taskId', 'workerId', 'claimId']) {
          if (typeof identity.claim[field] !== 'string' || !identity.claim[field] || identity.claim[field].length > 256) throw fail();
          claim[field] = identity.claim[field];
        }
        scoped = { ...normalizeIdentity(identity), taskId: identity.taskId, claim };
        key = JSON.stringify(scoped);
        if (signal?.aborted) throw fail();
        if (pending.has(key)) return pending.get(key);
        if (pending.size >= maxPending) throw fail();
      } catch { return Promise.reject(fail()); }
      const operation = once(scoped, signal).catch(() => { throw fail(); }).finally(() => pending.delete(key));
      pending.set(key, operation); return operation;
    },
  };
}

module.exports = { createProfileRecoveryController };

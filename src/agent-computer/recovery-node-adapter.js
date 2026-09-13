'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify, isDeepStrictEqual: same } = require('node:util');
const { bindRecoveryHelperContainer, observeRecoveryHelperStop } = require('./recovery-helper-observer');
const { normalizeRecoveryHelperIdentity, normalizeRecoveryHelperBinding, normalizeRecoveryHelperStop, recoveryHelperFingerprint, isRecoveryHelperClosed } = require('./recovery-helper');
const { normalizeProfileRecoveryEvidence } = require('./profile-recovery-evidence');
const fail = () => Object.assign(new Error('Private recovery node operation is unconfirmed.'), { code: 'computer_recovery_node_unknown' });
const guard = signal => { if (signal?.aborted) throw fail(); };

function scope(input) {
  const identity = {}; const claim = {};
  for (const key of ['ownerId', 'teamId', 'agentId', 'taskId']) {
    if (typeof input?.[key] !== 'string' || !input[key] || input[key].length > 256) throw fail();
    identity[key] = input[key];
  }
  for (const key of ['taskId', 'workerId', 'claimId']) {
    if (typeof input.claim?.[key] !== 'string' || !input.claim[key] || input.claim[key].length > 256) throw fail();
    claim[key] = input.claim[key];
  }
  if (identity.taskId !== claim.taskId) throw fail();
  return { ...identity, claim };
}

// Trusted HOST service only, never a worker/model tool. No listener, timer or
// process is started by construction. All targets come from authoritative task
// ownership, not caller-provided leases, shell strings or container prefixes.
function createRecoveryNodeAdapter({ service, reader, readPod, execute = promisify(execFile), readFile = fs.readFile,
  hostname = os.hostname(), platform = process.platform, now = () => new Date().toISOString() } = {}) {
  if (!['get', 'recordComputerRecoveryHelper'].every(key => typeof service?.[key] === 'function')
    || !['inspectContainer', 'observeProcess', 'observeCgroup', 'readCgroup'].every(key => typeof reader?.[key] === 'function')
    || ![readPod, execute, readFile, now].every(value => typeof value === 'function')) throw fail();
  const pending = new Map();
  const owned = async identity => {
    const team = await service.get(identity.teamId, identity.ownerId);
    const task = team.tasks?.find(value => value.id === identity.taskId && value.agentId === identity.agentId);
    const lease = task?.computerLease;
    if (team.id !== identity.teamId || team.ownerId !== identity.ownerId || !lease
      || task.worker?.id !== identity.claim.workerId || task.worker.claimId !== identity.claim.claimId
      || lease.claimId !== identity.claim.claimId || lease.ownerBootId !== task.worker.executionOwner?.bootId
      || lease.namespace !== 'lilly-team-workers' || !['closing', 'reconciliation'].includes(lease.phase)) throw fail();
    const helper = lease.recoveryHelper;
    normalizeRecoveryHelperIdentity(lease, helper);
    normalizeRecoveryHelperBinding(lease, helper, helper.nodeBinding);
    if (!['closing', 'reconciliation', 'closed'].includes(helper.phase) || !helper.launchStartedAt) throw fail();
    if (helper.phase === 'closed' && !isRecoveryHelperClosed(lease)) throw fail();
    normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
    return lease;
  };
  const current = async (identity, fingerprint, signal) => {
    const lease = await owned(identity); guard(signal);
    if (recoveryHelperFingerprint(lease, lease.recoveryHelper) !== fingerprint) throw fail();
    return lease;
  };
  const host = async (binding, signal) => {
    guard(signal);
    if (platform !== 'linux' || hostname !== binding.nodeName
      || (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== binding.hostBootId) throw fail();
    guard(signal);
  };
  const serialize = (kind, input, signal, action) => {
    let identity; let key;
    try {
      guard(signal); identity = scope(input); key = JSON.stringify([kind, identity]);
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 16) throw fail();
    } catch { return Promise.reject(fail()); }
    const work = Promise.resolve().then(() => action(identity)).catch(() => { throw fail(); }).finally(() => pending.delete(key));
    pending.set(key, work); return work;
  };
  return {
    requestStop({ identity: input, signal } = {}) {
      return serialize('stop', input, signal, async identity => {
        const lease = await owned(identity); guard(signal);
        const helper = lease.recoveryHelper; const binding = normalizeRecoveryHelperBinding(lease, helper, helper.nodeBinding);
        const fingerprint = recoveryHelperFingerprint(lease, helper);
        if (helper.stopEvidence) { normalizeRecoveryHelperStop(lease, helper, helper.stopEvidence); return { requested: false }; }
        await host(binding, signal);
        const runtime = await reader.inspectContainer(helper.containerId, binding.nodeName); guard(signal);
        if (runtime?.status?.id !== helper.containerId.slice(13)
          || !Object.entries({ 'io.kubernetes.pod.uid': helper.podUid, 'io.kubernetes.pod.namespace': helper.namespace,
            'io.kubernetes.pod.name': helper.podName, 'io.kubernetes.container.name': 'worker' })
            .every(([key, value]) => runtime.status.labels?.[key] === value)) throw fail();
        // Already EXITED is not itself a stop receipt. Let captureStop poll the
        // independent kernel observer; do not delete runtime metadata here.
        if (runtime.status.state === 'CONTAINER_EXITED') return { requested: false };
        if (runtime.status.state !== 'CONTAINER_RUNNING') throw fail();
        const confirmed = await bindRecoveryHelperContainer({ lease, reader, readPod, signal, now });
        if (!same(confirmed, binding)) throw fail();
        const latest = await current(identity, fingerprint, signal);
        if (latest.recoveryHelper.stopEvidence) {
          normalizeRecoveryHelperStop(latest, latest.recoveryHelper, latest.recoveryHelper.stopEvidence);
          return { requested: false };
        }
        await host(binding, signal);
        await execute('/usr/local/bin/crictl', [
          '--runtime-endpoint=unix:///run/k3s/containerd/containerd.sock', '--timeout=15s',
          'stop', '--timeout=10', helper.containerId.slice(13),
        ], { timeout: 20000, maxBuffer: 16384, encoding: 'utf8', shell: false, signal,
          cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' }, windowsHide: true });
        guard(signal);
        return { requested: true }; // Never exposes stdout, stderr or termination claims.
      });
    },
    captureStop({ identity: input, signal } = {}) {
      return serialize('capture', input, signal, async identity => {
        let lease = await owned(identity); guard(signal);
        let helper = lease.recoveryHelper;
        if (helper.stopEvidence) return normalizeRecoveryHelperStop(lease, helper, helper.stopEvidence);
        const fingerprint = recoveryHelperFingerprint(lease, helper);
        const receipt = await observeRecoveryHelperStop({ lease, reader, signal, now }); guard(signal);
        if (!receipt) return null;
        lease = await current(identity, fingerprint, signal); helper = lease.recoveryHelper;
        if (helper.stopEvidence) return normalizeRecoveryHelperStop(lease, helper, helper.stopEvidence);
        // Recover lost write acknowledgments with a fresh authoritative read.
        // Cancellation after dispatch does not erase a committed observation.
        try { await service.recordComputerRecoveryHelper(identity, { helperId: helper.helperId, phase: 'closing', stopEvidence: receipt }); }
        catch { /* A successful read-back below is the only accepted result. */ }
        lease = await owned(identity); helper = lease.recoveryHelper;
        if (recoveryHelperFingerprint(lease, helper) !== fingerprint) throw fail();
        return normalizeRecoveryHelperStop(lease, helper, helper.stopEvidence);
      });
    },
  };
}

module.exports = { createRecoveryNodeAdapter };

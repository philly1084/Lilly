'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { bindBrowserContainer, normalizeBrowserBinding } = require('./node-binding');
const { BrowserStopArchive } = require('./stop-archive');
const { browserFingerprint, normalizeBrowserStopEvidence } = require('./stop-evidence');
const { normalizeProfileRecoveryEvidence } = require('./profile-recovery-evidence');
const { isRecoveryHelperClosed } = require('./recovery-helper');
const fail = () => Object.assign(new Error('Private browser node operation is unconfirmed.'), { code: 'computer_browser_node_unknown' });
const guard = signal => { if (signal?.aborted) throw fail(); };

// Private host deployment adapter; not a model tool or a network listener.
// The recovery runtime must mount/retire the original profile and close its
// helper before this adapter can acknowledge profile release to the supervisor.
function createBrowserNodeAdapter({ service, reader, readPod, recovery, execute = promisify(execFile), readFile = fs.readFile,
  hostname = os.hostname(), platform = process.platform, now = () => new Date().toISOString() } = {}) {
  if (!['get', 'recordComputerStop'].every(key => typeof service?.[key] === 'function')
    || !['inspectContainer', 'observeProcess', 'observeCgroup', 'readCgroup'].every(key => typeof reader?.[key] === 'function')
    || typeof recovery?.recover !== 'function' || ![readPod, execute, readFile, now].every(value => typeof value === 'function')) throw fail();
  const archive = new BrowserStopArchive({ service, reader, now }); const pending = new Map();
  const owned = async input => {
    const lease = await archive.ownedLease(input);
    if (!['closing', 'reconciliation'].includes(lease.phase)) throw fail();
    normalizeBrowserBinding(lease.nodeBinding, lease); return lease;
  };
  const host = async (binding, signal) => {
    guard(signal);
    if (platform !== 'linux' || binding.nodeName !== hostname
      || (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== binding.hostBootId) throw fail();
    guard(signal);
  };
  const scope = input => {
    const identity = {}; const claim = {};
    for (const key of ['ownerId', 'teamId', 'agentId', 'taskId']) {
      if (typeof input?.[key] !== 'string' || !input[key] || input[key].length > 256) throw fail();
      identity[key] = input[key];
    }
    for (const key of ['taskId', 'workerId', 'claimId']) {
      if (typeof input.claim?.[key] !== 'string' || !input.claim[key] || input.claim[key].length > 256) throw fail();
      claim[key] = input.claim[key];
    }
    if (identity.taskId !== claim.taskId) throw fail(); return { ...identity, claim };
  };
  const serialize = (kind, input, signal, action) => {
    let identity; let key;
    try {
      guard(signal); identity = scope(input); key = JSON.stringify([kind, identity]);
      if (pending.has(key)) return pending.get(key); if (pending.size >= 16) throw fail();
    } catch { return Promise.reject(fail()); }
    const work = Promise.resolve().then(() => action(identity)).catch(() => { throw fail(); }).finally(() => pending.delete(key));
    pending.set(key, work); return work;
  };
  return {
    bindContainer: ({ lease, signal }) => bindBrowserContainer({ lease, reader, readPod, signal, now }),
    requestStop({ identity: input, signal } = {}) {
      return serialize('stop', input, signal, async identity => {
        const lease = await owned(identity); guard(signal);
        if (lease.stopEvidence) { normalizeBrowserStopEvidence(lease, lease.stopEvidence); return { requested: false }; }
        const binding = normalizeBrowserBinding(lease.nodeBinding, lease); await host(binding, signal);
        const runtime = await reader.inspectContainer(lease.containerId, binding.nodeName); guard(signal);
        if (runtime?.status?.id !== lease.containerId.slice(13)
          || !Object.entries({ 'io.kubernetes.pod.uid': lease.podUid, 'io.kubernetes.pod.namespace': lease.namespace,
            'io.kubernetes.pod.name': lease.podName, 'io.kubernetes.container.name': 'worker' })
            .every(([key, value]) => runtime.status.labels?.[key] === value)) throw fail();
        if (runtime.status.state === 'CONTAINER_EXITED') return { requested: false };
        if (runtime.status.state !== 'CONTAINER_RUNNING') throw fail();
        const currentBinding = await bindBrowserContainer({ lease, reader, readPod, signal, now }); guard(signal);
        // Observation time changes; every actual owner identity must remain fixed.
        if (browserFingerprint({ ...lease, nodeBinding: { ...currentBinding, observedAt: binding.observedAt } }) !== browserFingerprint(lease)) throw fail();
        const fresh = await owned(identity); guard(signal);
        if (browserFingerprint(fresh) !== browserFingerprint(lease)) throw fail();
        if (fresh.stopEvidence) { normalizeBrowserStopEvidence(fresh, fresh.stopEvidence); return { requested: false }; }
        await host(binding, signal);
        await execute('/usr/local/bin/crictl', [
          '--runtime-endpoint=unix:///run/k3s/containerd/containerd.sock', '--timeout=15s', 'stop', '--timeout=10', lease.containerId.slice(13),
        ], { timeout: 20000, maxBuffer: 16384, encoding: 'utf8', shell: false, signal,
          cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' }, windowsHide: true });
        guard(signal); return { requested: true };
      });
    },
    captureStop({ identity: input, signal } = {}) {
      return serialize('capture', input, signal, async identity => {
        await owned(identity); guard(signal);
        return archive.capture(identity, { signal });
      });
    },
    observeTermination({ identity: input, signal } = {}) {
      return serialize('recover', input, signal, async identity => {
        const before = await owned(identity); guard(signal);
        const stop = normalizeBrowserStopEvidence(before, before.stopEvidence);
        // Stop archival is mandatory BEFORE invoking a writable recovery helper.
        await recovery.recover(identity, { signal }); guard(signal);
        const lease = await owned(identity); guard(signal);
        if (browserFingerprint(lease) !== stop.fingerprint || !isRecoveryHelperClosed(lease)) throw fail();
        const stopEvidence = normalizeBrowserStopEvidence(lease, lease.stopEvidence);
        const profileRecovery = normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
        return { ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
          podStopped: true, profileReleased: true, stopEvidence, profileRecovery };
      });
    },
  };
}

module.exports = { createBrowserNodeAdapter };

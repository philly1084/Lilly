'use strict';

const { isDeepStrictEqual: same } = require('node:util');
const { normalizeCgroup } = require('../agent-teams/cgroup-reader');
const { normalizeRecoveryHelperIdentity, normalizeRecoveryHelperBinding,
  recoveryHelperFingerprint, normalizeRecoveryHelperStop } = require('./recovery-helper');
const fail = () => Object.assign(new Error('Private recovery helper node ownership is unconfirmed.'), { code: 'computer_recovery_helper_unknown' });
const guard = signal => { if (signal?.aborted) throw fail(); };

function scope(lease) {
  const helper = lease?.recoveryHelper;
  normalizeRecoveryHelperIdentity(lease, helper);
  if (!helper.launchStartedAt || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(helper.podUid || '')
    || !/^containerd:\/\/[a-f0-9]{64}$/.test(helper.containerId || '')
    || !['provisioning', 'ready', 'closing', 'reconciliation'].includes(helper.phase)) throw fail();
  return helper;
}

function runtimeIdentity(runtime, helper, state) {
  if (runtime?.status?.id !== helper.containerId?.slice(13) || runtime.status.state !== state
    || runtime.status.labels?.['io.kubernetes.pod.uid'] !== helper.podUid
    || runtime.status.labels?.['io.kubernetes.pod.namespace'] !== helper.namespace
    || runtime.status.labels?.['io.kubernetes.pod.name'] !== helper.podName
    || runtime.status.labels?.['io.kubernetes.container.name'] !== 'worker') throw fail();
}

function podIdentity(pod, lease, helper) {
  const spec = pod?.spec; const worker = spec?.containers?.[0]; const status = pod?.status?.containerStatuses;
  const annotations = { 'lilly.ai/lease-id': helper.leaseId, 'lilly.ai/recovery-id': helper.helperId,
    'lilly.ai/owner-boot': helper.ownerBootId, 'lilly.ai/profile-key': helper.profileKey };
  if (pod?.metadata?.namespace !== helper.namespace || pod.metadata.name !== helper.podName || pod.metadata.uid !== helper.podUid
    || pod.metadata.deletionTimestamp || !Object.entries(annotations).every(([key, value]) => pod.metadata.annotations?.[key] === value)
    || spec?.nodeName !== lease.nodeBinding.nodeName || spec.hostPID || spec.hostIPC || spec.hostNetwork || spec.shareProcessNamespace
    || spec.automountServiceAccountToken !== false || spec.restartPolicy !== 'Never' || spec.containers?.length !== 1
    || worker.name !== 'worker' || worker.image !== helper.image || spec.initContainers?.length || spec.ephemeralContainers?.length
    || status?.length !== 1 || status[0].name !== 'worker' || status[0].containerID !== helper.containerId
    || !status[0].state?.running || status[0].restartCount !== 0) throw fail();
  const volume = spec.volumes?.filter(value => value.name === 'profiles');
  const mounts = worker.volumeMounts?.filter(value => value.mountPath === '/profiles');
  if (volume?.length !== 1 || volume[0].persistentVolumeClaim?.claimName !== helper.pvcName || volume[0].persistentVolumeClaim.readOnly
    || mounts?.length !== 1 || mounts[0].name !== 'profiles' || mounts[0].readOnly || mounts[0].subPath || mounts[0].subPathExpr
    || worker.volumeMounts.some(value => value.mountPath?.startsWith('/profiles/'))
    || spec.volumes.some(value => value.hostPath || (value.name !== 'profiles' && value.persistentVolumeClaim))) throw fail();
}

// Trusted node-side observation only. It neither creates a Pod nor dispatches
// recovery writes. Before writing, independently bind PVC/PV identity and the
// helper's opened /profiles mount with local-profile-volume + profile-mount.
async function bindRecoveryHelperContainer({ lease, readPod, reader, signal, now = () => new Date().toISOString() } = {}) {
  try {
    const helper = scope(lease); const observedAt = now();
    if (typeof readPod !== 'function' || !['inspectContainer', 'observeProcess', 'observeCgroup'].every(key => typeof reader?.[key] === 'function')) throw fail();
    const sample = async () => {
      guard(signal);
      const pod = await readPod({ namespace: helper.namespace, name: helper.podName, signal }); guard(signal);
      podIdentity(pod, lease, helper);
      const nodeName = lease.nodeBinding.nodeName;
      const runtime = await reader.inspectContainer(helper.containerId, nodeName); guard(signal);
      runtimeIdentity(runtime, helper, 'CONTAINER_RUNNING');
      const initPid = runtime.info?.pid;
      if (!Number.isSafeInteger(initPid) || initPid < 2 || initPid > 2147483647) throw fail();
      const kernel = await reader.observeProcess({ nodeName, initPid, ownerPid: 1 }); guard(signal);
      if (kernel?.init?.pid !== initPid || kernel.init.namespacePid !== 1
        || !['pid', 'namespacePid', 'startTicks', 'pidNamespace', 'mountNamespace'].every(key => kernel.init[key] === kernel.process?.[key])) throw fail();
      const group = await reader.observeCgroup({ nodeName, containerId: helper.containerId, podUid: helper.podUid, initPid, hostPid: initPid }); guard(signal);
      if (group?.populated !== true) throw fail();
      return normalizeRecoveryHelperBinding(lease, helper, { version: 1, podUid: helper.podUid, containerId: helper.containerId,
        nodeName, hostBootId: kernel.hostBootId, initPid, initStartTicks: kernel.init.startTicks,
        pidNamespace: kernel.init.pidNamespace, mountNamespace: kernel.init.mountNamespace, cgroup: group.identity, observedAt });
    };
    const first = await sample(); const second = await sample();
    if (!same(first, second)) throw fail();
    // A resumed observer may confirm but cannot silently replace a saved PID.
    if (helper.nodeBinding && !same({ ...helper.nodeBinding, observedAt }, first)) throw fail();
    return helper.nodeBinding ? normalizeRecoveryHelperBinding(lease, helper, helper.nodeBinding) : first;
  } catch { throw fail(); }
}

// Missing CRI records remain unknown. A removed cgroup additionally requires the
// independently verified retired-owner witness. Archive before CRI garbage collection.
async function observeRecoveryHelperStop({ lease, reader, signal, now = () => new Date().toISOString() } = {}) {
  try {
    const helper = scope(lease); const binding = normalizeRecoveryHelperBinding(lease, helper, helper.nodeBinding);
    let source = 'cri-exited-and-cgroup-v2-empty';
    for (let i = 0; i < 2; i += 1) {
      guard(signal);
      const runtime = await reader.inspectContainer(helper.containerId, binding.nodeName); guard(signal);
      runtimeIdentity(runtime, helper, 'CONTAINER_EXITED');
      let group; let retiredConfirmed = false;
      try { group = await reader.readCgroup(binding); }
      catch {
        const retired = await reader.readRetiredOwner(binding, { signal }); guard(signal);
        if (retired?.version !== 1 || retired.retired !== true || retired.hostBootId !== binding.hostBootId
          || retired.initPid !== binding.initPid || retired.initStartTicks !== binding.initStartTicks
          || !same(normalizeCgroup(retired.cgroup, helper.containerId, helper.podUid), binding.cgroup)) return null;
        source = 'cri-exited-and-kernel-owner-retired';
        retiredConfirmed = true;
      }
      guard(signal);
      if (group && (group.populated !== false || group.hostBootId !== binding.hostBootId
        || !same(normalizeCgroup(group.identity, helper.containerId, helper.podUid), binding.cgroup))) return null;
      if (!group && !retiredConfirmed) return null;
    }
    return normalizeRecoveryHelperStop(lease, helper, { version: 1, fingerprint: recoveryHelperFingerprint(lease, helper),
      source, observedAt: now() });
  } catch { return null; }
}

module.exports = { bindRecoveryHelperContainer, observeRecoveryHelperStop };

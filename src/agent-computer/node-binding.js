'use strict';

const { normalizeCgroup } = require('../agent-teams/cgroup-reader');
const fail = () => Object.assign(new Error('Private browser node ownership is unconfirmed.'), { code: 'computer_node_binding_unknown' });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
// Only compare canonical, allowlisted binding/group records with this helper.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const FIELDS = ['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'];
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const guard = signal => { if (signal?.aborted) throw fail(); };

function checkedLease(lease) {
  if (!lease || lease.namespace !== 'lilly-team-workers' || !/^browser-[a-f0-9]{32}$/.test(lease.podName || '')
    || !FIELDS.slice(0, -1).every(key => typeof lease[key] === 'string' && UUID.test(lease[key]))
    || !/^containerd:\/\/[a-f0-9]{64}$/.test(lease.containerId || '')) throw fail();
  return Object.fromEntries(FIELDS.map(key => [key, lease[key]]));
}

function normalizeBrowserBinding(value, lease) {
  const scope = checkedLease(lease);
  const keys = ['version', ...FIELDS, 'nodeName', 'hostBootId', 'initPid', 'initStartTicks', 'pidNamespace', 'mountNamespace', 'cgroup', 'observedAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key)) || value.version !== 1 || !FIELDS.every(key => value[key] === scope[key])
    || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value.nodeName || '')
    || typeof value.hostBootId !== 'string' || !UUID.test(value.hostBootId) || !pid(value.initPid)
    || !['initStartTicks', 'pidNamespace', 'mountNamespace'].every(key => decimal(value[key])) || !timestamp(value.observedAt)) throw fail();
  return { version: 1, ...scope, nodeName: value.nodeName, hostBootId: value.hostBootId, initPid: value.initPid,
    initStartTicks: value.initStartTicks, pidNamespace: value.pidNamespace, mountNamespace: value.mountNamespace,
    cgroup: normalizeCgroup(value.cgroup, lease.containerId, lease.podUid), observedAt: value.observedAt };
}

function checkRuntime(value, lease, state) {
  if (value?.status?.id !== lease.containerId.slice(13) || value.status.state !== state
    || value.status.labels?.['io.kubernetes.pod.uid'] !== lease.podUid
    || value.status.labels?.['io.kubernetes.pod.namespace'] !== lease.namespace
    || value.status.labels?.['io.kubernetes.pod.name'] !== lease.podName
    || value.status.labels?.['io.kubernetes.container.name'] !== 'worker') throw fail();
}

// Runs on the owning node through trusted readers. The browser never receives
// CRI credentials. Bind the container init and entire cgroup BEFORE private exec;
// its exec-launched browser descendants share this container's process boundary.
async function bindBrowserContainer({ lease, readPod, reader, signal, now = () => new Date().toISOString() } = {}) {
  try {
    checkedLease(lease);
    if (typeof readPod !== 'function' || !['inspectContainer', 'observeProcess', 'observeCgroup'].every(key => typeof reader?.[key] === 'function')) throw fail();
    const sample = async () => {
      guard(signal);
      const pod = await readPod({ namespace: lease.namespace, name: lease.podName, signal }); guard(signal);
      const status = pod?.status?.containerStatuses;
      if (pod?.metadata?.namespace !== lease.namespace || pod.metadata.name !== lease.podName || pod.metadata.uid !== lease.podUid
        || pod.metadata.deletionTimestamp || pod.spec?.hostPID || pod.spec?.shareProcessNamespace
        || pod.spec?.containers?.length !== 1 || pod.spec.containers[0].name !== 'worker' || pod.spec.initContainers?.length
        || pod.spec.ephemeralContainers?.length || status?.length !== 1 || status[0].name !== 'worker'
        || !status[0].state?.running || status[0].containerID !== lease.containerId || status[0].restartCount !== 0) throw fail();
      const nodeName = pod.spec.nodeName;
      const runtime = await reader.inspectContainer(lease.containerId, nodeName); guard(signal);
      checkRuntime(runtime, lease, 'CONTAINER_RUNNING');
      const initPid = runtime.info?.pid; if (!pid(initPid)) throw fail();
      const kernel = await reader.observeProcess({ nodeName, initPid, ownerPid: 1 }); guard(signal);
      if (kernel?.init?.pid !== initPid || kernel.init.namespacePid !== 1
        || !['pid', 'namespacePid', 'startTicks', 'pidNamespace', 'mountNamespace'].every(key => kernel.init[key] === kernel.process?.[key])) throw fail();
      const group = await reader.observeCgroup({ nodeName, containerId: lease.containerId, podUid: lease.podUid, initPid, hostPid: initPid }); guard(signal);
      if (group?.populated !== true) throw fail();
      return normalizeBrowserBinding({ version: 1, ...checkedLease(lease), nodeName, hostBootId: kernel.hostBootId, initPid,
        initStartTicks: kernel.init.startTicks, pidNamespace: kernel.init.pidNamespace, mountNamespace: kernel.init.mountNamespace,
        cgroup: group.identity, observedAt: '1970-01-01T00:00:00.000Z' }, lease);
    };
    const first = await sample(); const second = await sample();
    if (!same(first, second)) throw fail();
    return normalizeBrowserBinding({ ...first, observedAt: now() }, lease);
  } catch { throw fail(); }
}

// Read-only termination evidence. Pod absence, missing CRI metadata or a vanished
// cgroup alone never proves death. Removed groups require the retired-owner witness.
// This does NOT release the persistent profile or emit profileReleased=true.
async function observeBrowserContainerStop({ lease, reader, signal, now = () => new Date().toISOString() } = {}) {
  try {
    const binding = normalizeBrowserBinding(lease?.nodeBinding, lease);
    let source = 'cri-exited-and-cgroup-v2-empty';
    for (let index = 0; index < 2; index += 1) {
      guard(signal);
      const runtime = await reader.inspectContainer(binding.containerId, binding.nodeName); guard(signal);
      checkRuntime(runtime, lease, 'CONTAINER_EXITED');
      let group; let retiredConfirmed = false;
      try { group = await reader.readCgroup(binding); }
      catch {
        const retired = await reader.readRetiredOwner(binding, { signal }); guard(signal);
        if (retired?.version !== 1 || retired.retired !== true || retired.hostBootId !== binding.hostBootId
          || retired.initPid !== binding.initPid || retired.initStartTicks !== binding.initStartTicks
          || !same(normalizeCgroup(retired.cgroup, lease.containerId, lease.podUid), binding.cgroup)) return null;
        source = 'cri-exited-and-kernel-owner-retired';
        retiredConfirmed = true;
      }
      guard(signal);
      if (group && (group.populated !== false || group.hostBootId !== binding.hostBootId
        || !same(normalizeCgroup(group.identity, lease.containerId, lease.podUid), binding.cgroup))) return null;
      if (!group && !retiredConfirmed) return null;
    }
    const observedAt = now();
    if (!timestamp(observedAt) || Date.parse(observedAt) < Date.parse(binding.observedAt)) return null;
    return { ...checkedLease(lease), podStopped: true, source, observedAt };
  } catch { return null; }
}

module.exports = { normalizeBrowserBinding, bindBrowserContainer, observeBrowserContainerStop };

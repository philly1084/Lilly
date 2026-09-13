'use strict';

const { normalizeExecutionOwner } = require('./execution-owner');

const ID = /^containerd:\/\/[a-f0-9]{64}$/;
const DECIMAL = /^[1-9][0-9]{0,19}$/;
const fail = () => Object.assign(new Error('Execution container binding unavailable.'), { code: 'team_container_binding_unavailable' });
const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const name = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value);

function podContainer(pod, owner) {
  if (pod?.metadata?.namespace !== owner.pod.namespace || pod.metadata.name !== owner.pod.name
    || pod.metadata.uid !== owner.pod.uid || pod.metadata.deletionTimestamp
    || pod.spec?.hostPID || pod.spec?.shareProcessNamespace || !name(pod.spec?.nodeName)) throw fail();
  const entries = pod.status?.containerStatuses?.filter(entry => entry.name === owner.pod.containerName);
  if (entries?.length !== 1 || !entries[0].state?.running || !ID.test(entries[0].containerID || '')) throw fail();
  return { containerId: entries[0].containerID, nodeName: pod.spec.nodeName };
}

function checkRuntime(value, containerId, owner) {
  if (value?.status?.id !== containerId.slice('containerd://'.length)
    || value.status.state !== 'CONTAINER_RUNNING' || !pid(value.info?.pid)
    || value.status.labels?.['io.kubernetes.pod.uid'] !== owner.pod.uid
    || value.status.labels?.['io.kubernetes.pod.namespace'] !== owner.pod.namespace
    || value.status.labels?.['io.kubernetes.pod.name'] !== owner.pod.name
    || value.status.labels?.['io.kubernetes.container.name'] !== owner.pod.containerName) throw fail();
  return value.info.pid;
}

function checkKernel(value, initPid, owner) {
  if (value?.hostBootId !== owner.kernel.bootId || value.init?.pid !== initPid
    || !pid(value.process?.pid) || value.process.namespacePid !== owner.pid) throw fail();
  for (const entry of [value.init, value.process]) {
    if (!['startTicks', 'pidNamespace', 'mountNamespace'].every(key => typeof entry[key] === 'string' && DECIMAL.test(entry[key]))
      || entry.pidNamespace !== owner.kernel.pidNamespace || entry.mountNamespace !== owner.kernel.mountNamespace) throw fail();
  }
  if (value.process.startTicks !== owner.kernel.startTicks) throw fail();
  return { hostBootId: value.hostBootId, initPid, initStartTicks: value.init.startTicks,
    hostPid: value.process.pid, processStartTicks: value.process.startTicks,
    pidNamespace: value.process.pidNamespace, mountNamespace: value.process.mountNamespace };
}

// Privileged deployment adapter boundary, NOT a model or owner tool. The three
// injected readers must query the owning node's authenticated API/CRI and kernel.
// No mutation, process termination, retry or quiescence conclusion is performed.
async function bindExecutionContainer({ owner: input, readPod, inspectContainer, observeProcess, observeCgroup = null, now = () => new Date().toISOString() }) {
  try {
    const owner = normalizeExecutionOwner(input);
    if (owner.version !== 1 || owner.platform !== 'linux' || !owner.pod
      || ![readPod, inspectContainer, observeProcess].every(reader => typeof reader === 'function')
      || (observeCgroup !== null && typeof observeCgroup !== 'function')) throw fail();
    const before = podContainer(await readPod(owner.pod), owner);
    const initPid = checkRuntime(await inspectContainer(before.containerId, before.nodeName), before.containerId, owner);
    const kernel = checkKernel(await observeProcess({ nodeName: before.nodeName, initPid, ownerPid: owner.pid }), initPid, owner);
    const groupScope = { ...before, podUid: owner.pod.uid, initPid, hostPid: kernel.hostPid };
    const group = observeCgroup ? await observeCgroup(groupScope) : null;
    if (observeCgroup && group?.populated !== true) throw fail();
    // Re-read all three sources. Restart, PID reuse or node/Pod replacement
    // during acquisition cannot produce a mixed-generation owner record.
    const after = podContainer(await readPod(owner.pod), owner);
    if (after.containerId !== before.containerId || after.nodeName !== before.nodeName
      || checkRuntime(await inspectContainer(after.containerId, after.nodeName), after.containerId, owner) !== initPid) throw fail();
    const confirmed = checkKernel(await observeProcess({ nodeName: after.nodeName, initPid, ownerPid: owner.pid }), initPid, owner);
    if (Object.keys(kernel).some(key => kernel[key] !== confirmed[key])) throw fail();
    if (observeCgroup) {
      const groupAgain = await observeCgroup(groupScope);
      if (groupAgain?.populated !== true || !group?.identity || !groupAgain.identity
        || ['path', 'device', 'inode'].some(key => group.identity[key] !== groupAgain.identity[key])) throw fail();
    }
    const observedAt = now();
    if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) throw fail();
    return normalizeExecutionOwner({ ...owner, version: 2, containerBinding: {
      version: observeCgroup ? 2 : 1, containerId: before.containerId, nodeName: before.nodeName, podUid: owner.pod.uid, ...kernel, observedAt,
      ...(observeCgroup ? { cgroup: group.identity } : {}),
    } }).containerBinding;
  } catch { throw fail(); }
}

module.exports = { bindExecutionContainer };

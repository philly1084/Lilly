'use strict';

const { normalizeExecutionOwner } = require('./execution-owner');

// Proves only this bound container's process tree. It deliberately does not
// produce TeamReconciler's owner/worker/browser receipt: other containers and
// remote effects must be reconciled separately. No stop or retry is dispatched.
async function observeContainerStop({ owner: input, inspectContainer, readCgroup, now = () => new Date().toISOString() }) {
  try {
    const owner = normalizeExecutionOwner(input);
    const binding = owner.containerBinding;
    if (binding?.version !== 2 || !binding.cgroup || ![inspectContainer, readCgroup].every(fn => typeof fn === 'function')) return null;
    for (let sample = 0; sample < 2; sample += 1) {
      const runtime = await inspectContainer(binding.containerId, binding.nodeName);
      if (runtime?.status?.id !== binding.containerId.slice(13) || runtime.status.state !== 'CONTAINER_EXITED'
        || runtime.status.labels?.['io.kubernetes.pod.uid'] !== owner.pod.uid
        || runtime.status.labels?.['io.kubernetes.pod.namespace'] !== owner.pod.namespace
        || runtime.status.labels?.['io.kubernetes.pod.name'] !== owner.pod.name
        || runtime.status.labels?.['io.kubernetes.container.name'] !== owner.pod.containerName) return null;
      const group = await readCgroup(binding);
      if (group?.populated !== false || group.hostBootId !== binding.hostBootId || !group.identity
        || ['path', 'device', 'inode'].some(key => group.identity[key] !== binding.cgroup[key])) return null;
    }
    const observedAt = now();
    if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))
      || new Date(observedAt).toISOString() !== observedAt || Date.parse(observedAt) < Date.parse(binding.observedAt)) return null;
    return { ownerBootId: owner.bootId, containerId: binding.containerId, stopped: true,
      source: 'cri-exited-and-cgroup-v2-empty', observedAt };
  } catch {
    // Inaccessible, deleted, garbage-collected or malformed is unknown. Never
    // treat a missing Pod, CRI record, directory or heartbeat as an empty tree.
    return null;
  }
}

module.exports = { observeContainerStop };

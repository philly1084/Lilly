'use strict';

// Synthetic API/CRI/kernel observations for unit and local TLS integration only.
const id = '01234567-89ab-4cde-8fab-0123456789ab';
function ownerFixture() {
  const owner = { version: 1, bootId: id, platform: 'linux', pid: 7, startedAt: '2026-09-07T00:00:00.000Z',
    kernel: { bootId: id, startTicks: '400', pidNamespace: '1001', mountNamespace: '1002' },
    pod: { namespace: 'kimibuilt', name: 'backend-a', uid: id, containerName: 'backend' } };
  const pod = { metadata: { ...owner.pod }, spec: { nodeName: 'fixture-node' },
    status: { containerStatuses: [{ name: 'backend', containerID: `containerd://${'a'.repeat(64)}`, state: { running: {} } }] } };
  const runtime = { status: { id: 'a'.repeat(64), state: 'CONTAINER_RUNNING', labels: {
    'io.kubernetes.pod.uid': id, 'io.kubernetes.pod.namespace': 'kimibuilt', 'io.kubernetes.pod.name': 'backend-a',
    'io.kubernetes.container.name': 'backend' } }, info: { pid: 500 } };
  const observation = { hostBootId: id,
    init: { pid: 500, startTicks: '300', pidNamespace: '1001', mountNamespace: '1002' },
    process: { pid: 510, namespacePid: 7, startTicks: '400', pidNamespace: '1001', mountNamespace: '1002' } };
  const group = { populated: true, identity: { path: `/kubepods/pod${id}/${'a'.repeat(64)}`, device: '0', inode: '1000' } };
  const cluster = { request: jest.fn(async () => structuredClone(pod)) };
  const reader = { inspectContainer: jest.fn(async () => structuredClone(runtime)),
    observeProcess: jest.fn(async () => structuredClone(observation)), observeCgroup: jest.fn(async () => structuredClone(group)) };
  return { owner, pod, runtime, observation, group, cluster, reader };
}
module.exports = { ownerFixture };

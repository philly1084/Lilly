'use strict';

const { randomUUID } = require('node:crypto');
const { bindBrowserContainer, normalizeBrowserBinding, observeBrowserContainerStop } = require('./node-binding');

function fixture() {
  const lease = { namespace: 'lilly-team-workers', podName: `browser-${'a'.repeat(32)}`, leaseId: randomUUID(), claimId: randomUUID(),
    ownerBootId: randomUUID(), podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}` };
  const pod = { metadata: { namespace: lease.namespace, name: lease.podName, uid: lease.podUid },
    spec: { containers: [{ name: 'worker' }], nodeName: 'fixture-node' },
    status: { containerStatuses: [{ name: 'worker', state: { running: {} }, restartCount: 0, containerID: lease.containerId }] } };
  const runtime = { status: { id: lease.containerId.slice(13), state: 'CONTAINER_RUNNING', labels: {
    'io.kubernetes.pod.uid': lease.podUid, 'io.kubernetes.pod.namespace': lease.namespace,
    'io.kubernetes.pod.name': lease.podName, 'io.kubernetes.container.name': 'worker',
  } }, info: { pid: 321 } };
  const init = { pid: 321, namespacePid: 1, startTicks: '456', pidNamespace: '700', mountNamespace: '701' };
  const kernel = { hostBootId: randomUUID(), init, process: { ...init } };
  const group = { populated: true, identity: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '987' } };
  const readPod = jest.fn(async () => structuredClone(pod));
  const reader = { inspectContainer: jest.fn(async () => structuredClone(runtime)), observeProcess: jest.fn(async () => structuredClone(kernel)),
    observeCgroup: jest.fn(async () => structuredClone(group)), readCgroup: jest.fn(async () => ({ ...structuredClone(group), hostBootId: kernel.hostBootId })) };
  const now = () => '2026-09-07T01:00:00.000Z';
  return { lease, pod, runtime, kernel, group, readPod, reader, now };
}

test('two independent API/CRI/kernel/cgroup samples bind the private browser container', async () => {
  const f = fixture(); const binding = await bindBrowserContainer(f);
  expect(binding).toMatchObject({ leaseId: f.lease.leaseId, podUid: f.lease.podUid, initPid: 321, hostBootId: f.kernel.hostBootId, cgroup: f.group.identity });
  expect(f.readPod).toHaveBeenCalledTimes(2); expect(f.reader.inspectContainer).toHaveBeenCalledTimes(2);
  expect(f.reader.observeProcess).toHaveBeenCalledWith({ nodeName: 'fixture-node', initPid: 321, ownerPid: 1 });
  expect(f.reader.observeCgroup).toHaveBeenCalledTimes(2);
  expect(binding).toEqual(normalizeBrowserBinding(structuredClone(binding), f.lease));
});

test.each(['pod_uid', 'node', 'container', 'host_boot', 'pid_reuse', 'cgroup'])('changed %s between samples cannot create a mixed owner', async mode => {
  const f = fixture();
  const first = f.readPod.getMockImplementation();
  f.readPod.mockImplementation(async () => {
    if (f.readPod.mock.calls.length === 2) {
      if (mode === 'pod_uid') f.pod.metadata.uid = randomUUID();
      if (mode === 'node') f.pod.spec.nodeName = 'different-node';
      if (mode === 'container') f.pod.status.containerStatuses[0].containerID = `containerd://${'c'.repeat(64)}`;
      if (mode === 'host_boot') f.kernel.hostBootId = randomUUID();
      if (mode === 'pid_reuse') f.kernel.init.startTicks = f.kernel.process.startTicks = '457';
      if (mode === 'cgroup') f.group.identity.inode = '988';
    }
    return first();
  });
  await expect(bindBrowserContainer(f)).rejects.toMatchObject({ code: 'computer_node_binding_unknown' });
});

test('scope, process-tree isolation and CRI container labels must match', async () => {
  for (const mutation of [f => { f.pod.spec.hostPID = true; }, f => { f.pod.spec.containers.push({ name: 'sidecar' }); },
    f => { f.runtime.status.labels['io.kubernetes.pod.namespace'] = 'kimibuilt'; }, f => { f.group.populated = false; }]) {
    const f = fixture(); mutation(f);
    await expect(bindBrowserContainer(f)).rejects.toMatchObject({ code: 'computer_node_binding_unknown' });
  }
});

test('positive stop evidence requires matching exited CRI and empty descendant cgroup twice', async () => {
  const f = fixture(); f.lease.nodeBinding = await bindBrowserContainer(f);
  f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false; f.reader.inspectContainer.mockClear();
  const stopped = await observeBrowserContainerStop(f);
  expect(stopped).toMatchObject({ leaseId: f.lease.leaseId, podStopped: true, source: 'cri-exited-and-cgroup-v2-empty' });
  expect(stopped.profileReleased).toBeUndefined();
  expect(f.reader.inspectContainer).toHaveBeenCalledTimes(2); expect(f.reader.readCgroup).toHaveBeenCalledTimes(2);
});

test.each(['running', 'populated', 'missing_cri', 'missing_cgroup', 'reboot', 'replaced_cgroup', 'old_clock', 'foreign_lease'])('%s cannot prove termination', async mode => {
  const f = fixture(); f.lease.nodeBinding = await bindBrowserContainer(f);
  f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false;
  if (mode === 'running') f.runtime.status.state = 'CONTAINER_RUNNING';
  if (mode === 'populated') f.group.populated = true;
  if (mode === 'missing_cri') f.reader.inspectContainer.mockRejectedValue(new Error('missing'));
  if (mode === 'missing_cgroup') f.reader.readCgroup.mockRejectedValue(new Error('missing'));
  if (mode === 'reboot') f.kernel.hostBootId = randomUUID();
  if (mode === 'replaced_cgroup') f.group.identity.inode = '988';
  if (mode === 'old_clock') f.now = () => '2026-09-07T00:59:59.000Z';
  if (mode === 'foreign_lease') f.lease.leaseId = randomUUID();
  expect(await observeBrowserContainerStop(f)).toBeNull();
});

test('abort during a node read cannot persist an owner or emit stop evidence', async () => {
  const f = fixture(); const controller = new AbortController(); f.signal = controller.signal;
  f.reader.observeProcess.mockImplementation(async () => { controller.abort(); return f.kernel; });
  await expect(bindBrowserContainer(f)).rejects.toMatchObject({ code: 'computer_node_binding_unknown' });
  expect(f.reader.observeCgroup).not.toHaveBeenCalled();
});

test('retired kernel owner can prove stop after cgroup GC, but not after missing CRI metadata', async () => {
  const f = fixture(); f.lease.nodeBinding = await bindBrowserContainer(f); f.runtime.status.state = 'CONTAINER_EXITED';
  f.reader.readCgroup.mockRejectedValue(new Error('group collected'));
  const binding = f.lease.nodeBinding;
  f.reader.readRetiredOwner = jest.fn(async () => ({ version: 1, retired: true, hostBootId: binding.hostBootId,
    initPid: binding.initPid, initStartTicks: binding.initStartTicks, cgroup: binding.cgroup }));
  expect((await observeBrowserContainerStop(f)).source).toBe('cri-exited-and-kernel-owner-retired');
  expect(f.reader.readRetiredOwner).toHaveBeenCalledTimes(2);
  f.reader.inspectContainer.mockRejectedValue(new Error('CRI collected'));
  expect(await observeBrowserContainerStop(f)).toBeNull();
});

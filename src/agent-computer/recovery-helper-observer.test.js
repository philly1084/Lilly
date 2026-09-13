'use strict';

const { randomUUID } = require('node:crypto');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { reserveRecoveryHelper, advanceRecoveryHelper, isRecoveryHelperClosed } = require('./recovery-helper');
const { bindRecoveryHelperContainer, observeRecoveryHelperStop } = require('./recovery-helper-observer');
const copy = value => structuredClone(value);

function fixture() {
  const lease = { namespace: 'lilly-team-workers', podName: `browser-${'a'.repeat(32)}`, leaseId: randomUUID(), claimId: randomUUID(),
    ownerBootId: randomUUID(), podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`,
    phase: 'closing', profileKey: 'e'.repeat(64), pvcName: `browser-profile-${'a'.repeat(32)}` };
  lease.nodeBinding = { version: 1,
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 111, initStartTicks: '112', pidNamespace: '113', mountNamespace: '114',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '115' }, observedAt: '2026-09-07T01:00:00.000Z' };
  lease.stopEvidence = createBrowserStopEvidence(lease, {
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:30:00.000Z' });
  const image = `registry.example/recovery@sha256:${'c'.repeat(64)}`;
  const helperId = randomUUID(); const now = () => '2026-09-07T02:00:00.000Z';
  reserveRecoveryHelper(lease, { helperId, image }, now());
  const helper = advanceRecoveryHelper(lease, { helperId, phase: 'provisioning', podUid: randomUUID(), containerId: `containerd://${'d'.repeat(64)}` }, now());
  const annotations = { 'lilly.ai/lease-id': lease.leaseId, 'lilly.ai/recovery-id': helperId,
    'lilly.ai/owner-boot': lease.ownerBootId, 'lilly.ai/profile-key': lease.profileKey };
  const pod = { metadata: { namespace: helper.namespace, name: helper.podName, uid: helper.podUid, annotations },
    spec: { nodeName: 'fixture-node', restartPolicy: 'Never', automountServiceAccountToken: false,
      containers: [{ name: 'worker', image, volumeMounts: [{ name: 'profiles', mountPath: '/profiles' }] }],
      volumes: [{ name: 'profiles', persistentVolumeClaim: { claimName: lease.pvcName } }] },
    status: { containerStatuses: [{ name: 'worker', state: { running: {} }, restartCount: 0, containerID: helper.containerId }] } };
  const runtime = { status: { id: helper.containerId.slice(13), state: 'CONTAINER_RUNNING', labels: {
    'io.kubernetes.pod.uid': helper.podUid, 'io.kubernetes.pod.namespace': helper.namespace,
    'io.kubernetes.pod.name': helper.podName, 'io.kubernetes.container.name': 'worker',
  } }, info: { pid: 321 } };
  const init = { pid: 321, namespacePid: 1, startTicks: '456', pidNamespace: '700', mountNamespace: '701' };
  const kernel = { hostBootId: lease.nodeBinding.hostBootId, init, process: { ...init } };
  const group = { populated: true, identity: { path: `/kubepods/pod${helper.podUid}/${helper.containerId.slice(13)}`, device: '0', inode: '987' } };
  const readPod = jest.fn(async () => copy(pod));
  const reader = { inspectContainer: jest.fn(async () => copy(runtime)), observeProcess: jest.fn(async () => copy(kernel)),
    observeCgroup: jest.fn(async () => copy(group)), readCgroup: jest.fn(async () => ({ ...copy(group), hostBootId: kernel.hostBootId })) };
  return { lease, helper, pod, runtime, kernel, group, readPod, reader, now };
}

test('binds helper PID from two independent API/CRI/kernel samples, separately from the browser', async () => {
  const f = fixture(); const nodeBinding = await bindRecoveryHelperContainer(f);
  expect(nodeBinding).toMatchObject({ podUid: f.helper.podUid, containerId: f.helper.containerId, initPid: 321, cgroup: f.group.identity });
  expect(nodeBinding.containerId).not.toBe(f.lease.containerId);
  expect(f.readPod).toHaveBeenCalledTimes(2); expect(f.reader.inspectContainer).toHaveBeenCalledTimes(2);
  expect(f.reader.observeProcess).toHaveBeenCalledWith({ nodeName: 'fixture-node', initPid: 321, ownerPid: 1 });
  expect(f.reader.observeCgroup).toHaveBeenCalledTimes(2);
  advanceRecoveryHelper(f.lease, { helperId: f.helper.helperId, phase: 'ready', nodeBinding }, f.now());
  expect(await bindRecoveryHelperContainer({ ...f, now: () => '2026-09-07T02:01:00.000Z' })).toEqual(nodeBinding);
});

test.each(['pod', 'node', 'container', 'annotation', 'image', 'pvc', 'readonly', 'subpath', 'overlay', 'host', 'token', 'sidecar', 'restart', 'label', 'boot', 'pid', 'cgroup'])
  ('rejects mismatched %s before returning a helper binding', async mode => {
    const f = fixture();
    if (mode === 'pod') f.pod.metadata.uid = randomUUID();
    if (mode === 'node') f.pod.spec.nodeName = 'foreign-node';
    if (mode === 'container') f.pod.status.containerStatuses[0].containerID = f.lease.containerId;
    if (mode === 'annotation') f.pod.metadata.annotations['lilly.ai/recovery-id'] = randomUUID();
    if (mode === 'image') f.pod.spec.containers[0].image = 'untrusted:latest';
    if (mode === 'pvc') f.pod.spec.volumes[0].persistentVolumeClaim.claimName = 'foreign-profile';
    if (mode === 'readonly') f.pod.spec.containers[0].volumeMounts[0].readOnly = true;
    if (mode === 'subpath') f.pod.spec.containers[0].volumeMounts[0].subPath = 'elsewhere';
    if (mode === 'overlay') f.pod.spec.containers[0].volumeMounts.push({ name: 'extra', mountPath: '/profiles/hidden' });
    if (mode === 'host') f.pod.spec.hostPID = true;
    if (mode === 'token') f.pod.spec.automountServiceAccountToken = true;
    if (mode === 'sidecar') f.pod.spec.containers.push({ name: 'sidecar' });
    if (mode === 'restart') f.pod.status.containerStatuses[0].restartCount = 1;
    if (mode === 'label') f.runtime.status.labels['io.kubernetes.pod.uid'] = f.lease.podUid;
    if (mode === 'boot') f.kernel.hostBootId = randomUUID();
    if (mode === 'pid') f.kernel.process.startTicks = '457';
    if (mode === 'cgroup') f.group.populated = false;
    await expect(bindRecoveryHelperContainer(f)).rejects.toMatchObject({ code: 'computer_recovery_helper_unknown' });
    expect(f.lease.recoveryHelper.nodeBinding).toBeUndefined();
  });

test('rejects PID reuse both between samples and after a persisted binding', async () => {
  for (const persisted of [false, true]) {
    const f = fixture();
    if (persisted) f.lease.recoveryHelper.nodeBinding = await bindRecoveryHelperContainer(f);
    f.readPod.mockImplementation(async () => {
      if (persisted || f.readPod.mock.calls.length === 2) f.kernel.init.startTicks = f.kernel.process.startTicks = '999';
      return copy(f.pod);
    });
    await expect(bindRecoveryHelperContainer(f)).rejects.toMatchObject({ code: 'computer_recovery_helper_unknown' });
  }
});

test('positive helper stop observation is accepted by the durable lifecycle without releasing the profile', async () => {
  const f = fixture(); const nodeBinding = await bindRecoveryHelperContainer(f);
  advanceRecoveryHelper(f.lease, { helperId: f.helper.helperId, phase: 'ready', nodeBinding }, f.now());
  advanceRecoveryHelper(f.lease, { helperId: f.helper.helperId, phase: 'closing' }, f.now());
  f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false;
  const receipt = await observeRecoveryHelperStop(f);
  expect(receipt.source).toBe('cri-exited-and-cgroup-v2-empty'); expect(receipt.profileReleased).toBeUndefined();
  expect(f.reader.readCgroup).toHaveBeenCalledTimes(2);
  advanceRecoveryHelper(f.lease, { helperId: f.helper.helperId, phase: 'closed', stopEvidence: receipt }, f.now());
  expect(isRecoveryHelperClosed(f.lease)).toBe(true); expect(f.lease.phase).toBe('closing');
});

test.each(['running', 'populated', 'missing_cri', 'missing_group', 'boot', 'generation', 'label', 'clock'])('%s is unknown, never helper-stop evidence', async mode => {
  const f = fixture(); f.lease.recoveryHelper.nodeBinding = await bindRecoveryHelperContainer(f);
  f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false;
  if (mode === 'running') f.runtime.status.state = 'CONTAINER_RUNNING';
  if (mode === 'populated') f.group.populated = true;
  if (mode === 'missing_cri') f.reader.inspectContainer.mockRejectedValue(new Error('PRIVATE RUNTIME DETAILS'));
  if (mode === 'missing_group') f.reader.readCgroup.mockRejectedValue(new Error('PRIVATE GROUP DETAILS'));
  if (mode === 'boot') f.kernel.hostBootId = randomUUID();
  if (mode === 'generation') f.group.identity.inode = '988';
  if (mode === 'label') f.runtime.status.labels['io.kubernetes.pod.name'] = f.lease.podName;
  if (mode === 'clock') f.now = () => '2026-09-07T01:59:59.000Z';
  expect(await observeRecoveryHelperStop(f)).toBeNull();
});

test('abort after a pending node read prevents binding or stop receipt', async () => {
  const f = fixture(); const binding = await bindRecoveryHelperContainer(f);
  const controller = new AbortController();
  f.reader.observeProcess.mockImplementation(async () => { controller.abort(); return f.kernel; });
  await expect(bindRecoveryHelperContainer({ ...f, signal: controller.signal })).rejects.toMatchObject({ code: 'computer_recovery_helper_unknown' });
  f.lease.recoveryHelper.nodeBinding = binding; f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false;
  const stopController = new AbortController();
  f.reader.readCgroup.mockImplementation(async () => { stopController.abort(); return { ...f.group, hostBootId: f.kernel.hostBootId }; });
  expect(await observeRecoveryHelperStop({ ...f, signal: stopController.signal })).toBeNull();
});

test('retired-owner evidence survives cgroup GC but every sample still needs a positive witness', async () => {
  const f = fixture(); const binding = await bindRecoveryHelperContainer(f); f.lease.recoveryHelper.nodeBinding = binding;
  f.runtime.status.state = 'CONTAINER_EXITED'; f.reader.readCgroup.mockRejectedValue(new Error('collected'));
  f.reader.readRetiredOwner = jest.fn(async () => ({ version: 1, retired: true, hostBootId: binding.hostBootId,
    initPid: binding.initPid, initStartTicks: binding.initStartTicks, cgroup: binding.cgroup }));
  const receipt = await observeRecoveryHelperStop(f);
  expect(receipt.source).toBe('cri-exited-and-kernel-owner-retired');
  advanceRecoveryHelper(f.lease, { helperId: f.helper.helperId, phase: 'closing', stopEvidence: receipt }, f.now());
  f.reader.readCgroup.mockRejectedValueOnce(new Error('collected')).mockResolvedValueOnce(null);
  expect(await observeRecoveryHelperStop(f)).toBeNull();
});

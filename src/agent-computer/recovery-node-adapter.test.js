'use strict';

const { randomUUID } = require('node:crypto');
const { createRecoveryNodeAdapter } = require('./recovery-node-adapter');
const { reserveRecoveryHelper, advanceRecoveryHelper } = require('./recovery-helper');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { syntheticProfileRecovery } = require('./profile-recovery-fixture');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const now = () => '2026-09-07T03:00:00.000Z';
  const identity = { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task', claim: { taskId: 'task', workerId: 'worker', claimId: randomUUID() } };
  const lease = { namespace: 'lilly-team-workers', podName: `browser-${'a'.repeat(32)}`, leaseId: randomUUID(), claimId: identity.claim.claimId,
    ownerBootId: randomUUID(), podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`, phase: 'closing',
    profileKey: 'e'.repeat(64), pvcName: `browser-profile-${'a'.repeat(32)}` };
  const fields = Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]]));
  lease.nodeBinding = { version: 1, ...fields, nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 111, initStartTicks: '112', pidNamespace: '113', mountNamespace: '114',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '115' }, observedAt: '2026-09-07T01:00:00.000Z' };
  lease.stopEvidence = createBrowserStopEvidence(lease, { ...fields, podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:30:00.000Z' });
  const helperId = randomUUID(); const image = `registry.example/recovery@sha256:${'c'.repeat(64)}`;
  reserveRecoveryHelper(lease, { helperId, image }, now());
  advanceRecoveryHelper(lease, { helperId, phase: 'provisioning', podUid: randomUUID(), containerId: `containerd://${'d'.repeat(64)}` }, now());
  let helper = lease.recoveryHelper;
  const nodeBinding = { version: 1, podUid: helper.podUid, containerId: helper.containerId, nodeName: lease.nodeBinding.nodeName,
    hostBootId: lease.nodeBinding.hostBootId, initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
    cgroup: { path: `/kubepods/pod${helper.podUid}/${helper.containerId.slice(13)}`, device: '0', inode: '987' }, observedAt: now() };
  advanceRecoveryHelper(lease, { helperId, phase: 'ready', nodeBinding }, now());
  advanceRecoveryHelper(lease, { helperId, phase: 'closing' }, now()); helper = lease.recoveryHelper;
  lease.profileRecovery = syntheticProfileRecovery(lease);
  const team = { id: identity.teamId, ownerId: identity.ownerId, tasks: [{ id: identity.taskId, agentId: identity.agentId,
    worker: { id: identity.claim.workerId, claimId: identity.claim.claimId, executionOwner: { bootId: lease.ownerBootId } }, computerLease: lease }] };
  const service = { get: jest.fn(async () => copy(team)),
    recordComputerRecoveryHelper: jest.fn(async (_identity, input) => copy(advanceRecoveryHelper(lease, input, now()))) };
  const pod = { metadata: { namespace: helper.namespace, name: helper.podName, uid: helper.podUid,
    annotations: { 'lilly.ai/lease-id': helper.leaseId, 'lilly.ai/recovery-id': helperId,
      'lilly.ai/owner-boot': helper.ownerBootId, 'lilly.ai/profile-key': helper.profileKey } },
    spec: { nodeName: nodeBinding.nodeName, restartPolicy: 'Never', automountServiceAccountToken: false,
      containers: [{ name: 'worker', image, volumeMounts: [{ name: 'profiles', mountPath: '/profiles' }] }],
      volumes: [{ name: 'profiles', persistentVolumeClaim: { claimName: helper.pvcName } }] },
    status: { containerStatuses: [{ name: 'worker', state: { running: {} }, restartCount: 0, containerID: helper.containerId }] } };
  const runtime = { status: { id: helper.containerId.slice(13), state: 'CONTAINER_RUNNING', labels: {
    'io.kubernetes.pod.uid': helper.podUid, 'io.kubernetes.pod.namespace': helper.namespace,
    'io.kubernetes.pod.name': helper.podName, 'io.kubernetes.container.name': 'worker',
  } }, info: { pid: 321 } };
  const init = { pid: 321, namespacePid: 1, startTicks: '456', pidNamespace: '700', mountNamespace: '701' };
  const kernel = { hostBootId: nodeBinding.hostBootId, init, process: copy(init) };
  const group = { populated: true, identity: nodeBinding.cgroup, hostBootId: nodeBinding.hostBootId };
  const reader = { inspectContainer: jest.fn(async () => copy(runtime)), observeProcess: jest.fn(async () => copy(kernel)),
    observeCgroup: jest.fn(async () => copy(group)), readCgroup: jest.fn(async () => copy(group)) };
  const execute = jest.fn(async () => ({ stdout: 'PRIVATE', stderr: 'PRIVATE' }));
  const options = { service, reader, readPod: jest.fn(async () => copy(pod)), execute,
    readFile: jest.fn(async () => nodeBinding.hostBootId), hostname: 'fixture-node', platform: 'linux', now };
  return { identity, lease, helper, team, service, pod, runtime, kernel, group, reader, execute, options, adapter: createRecoveryNodeAdapter(options) };
}

test('fixed exact-CID stop follows fresh SQL/API/CRI/kernel binding and never archives signal success', async () => {
  const f = fixture(); expect(f.execute).not.toHaveBeenCalled();
  const result = await f.adapter.requestStop({ identity: f.identity, lease: { containerId: 'attacker' } });
  expect(result).toEqual({ requested: true });
  expect(f.options.readPod).toHaveBeenCalledTimes(2); expect(f.reader.observeProcess).toHaveBeenCalledTimes(2);
  expect(f.execute).toHaveBeenCalledWith('/usr/local/bin/crictl', [
    '--runtime-endpoint=unix:///run/k3s/containerd/containerd.sock', '--timeout=15s', 'stop', '--timeout=10', f.helper.containerId.slice(13),
  ], expect.objectContaining({ shell: false, timeout: 20000, maxBuffer: 16384, cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' } }));
  expect(f.service.recordComputerRecoveryHelper).not.toHaveBeenCalled(); expect(f.lease.recoveryHelper.stopEvidence).toBeUndefined();
  expect(await f.adapter.captureStop({ identity: f.identity })).toBeNull();
});

test('already exited allows independent capture; durable read-back survives runtime garbage collection', async () => {
  const f = fixture(); f.runtime.status.state = 'CONTAINER_EXITED';
  expect(await f.adapter.requestStop({ identity: f.identity })).toEqual({ requested: false });
  expect(await f.adapter.captureStop({ identity: f.identity })).toBeNull(); // still populated
  f.group.populated = false;
  const receipt = await f.adapter.captureStop({ identity: f.identity });
  expect(receipt).toEqual(f.lease.recoveryHelper.stopEvidence); expect(f.execute).not.toHaveBeenCalled();
  f.reader.inspectContainer.mockRejectedValue(new Error('metadata garbage collected'));
  const rebuilt = createRecoveryNodeAdapter(f.options);
  expect(await rebuilt.captureStop({ identity: f.identity })).toEqual(receipt);
  expect(await rebuilt.requestStop({ identity: f.identity })).toEqual({ requested: false });
  expect(f.service.recordComputerRecoveryHelper).toHaveBeenCalledTimes(1);
});

test.each(['owner', 'claim', 'worker', 'boot_owner', 'phase', 'profile', 'host', 'platform', 'host_boot', 'label', 'pod', 'pid', 'group', 'unknown_cri'])
  ('rejects %s mismatch before any stop command', async mode => {
    const f = fixture();
    if (mode === 'owner') f.team.ownerId = 'foreign';
    if (mode === 'claim') f.identity.claim.claimId = randomUUID();
    if (mode === 'worker') f.team.tasks[0].worker.id = 'foreign';
    if (mode === 'boot_owner') f.team.tasks[0].worker.executionOwner.bootId = randomUUID();
    if (mode === 'phase') f.lease.recoveryHelper.phase = 'ready';
    if (mode === 'profile') delete f.lease.profileRecovery;
    if (mode === 'host') f.options.hostname = 'foreign';
    if (mode === 'platform') f.options.platform = 'win32';
    if (mode === 'host_boot') f.options.readFile.mockResolvedValue(randomUUID());
    if (mode === 'label') f.runtime.status.labels['io.kubernetes.pod.uid'] = randomUUID();
    if (mode === 'pod') f.pod.metadata.uid = randomUUID();
    if (mode === 'pid') f.kernel.init.startTicks = f.kernel.process.startTicks = '999';
    if (mode === 'group') f.group.populated = false;
    if (mode === 'unknown_cri') f.reader.inspectContainer.mockRejectedValue(new Error('PRIVATE'));
    await expect(createRecoveryNodeAdapter(f.options).requestStop({ identity: f.identity })).rejects.toMatchObject({ code: 'computer_recovery_node_unknown' });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.service.recordComputerRecoveryHelper).not.toHaveBeenCalled();
  });

test('lost SQL stop receipt acknowledgment is recovered by fresh read, not another write', async () => {
  const f = fixture(); f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false;
  const save = f.service.recordComputerRecoveryHelper.getMockImplementation();
  f.service.recordComputerRecoveryHelper.mockImplementation(async (...args) => { await save(...args); throw new Error('reply lost'); });
  const receipt = await f.adapter.captureStop({ identity: f.identity });
  expect(receipt).toEqual(f.lease.recoveryHelper.stopEvidence);
  expect(await createRecoveryNodeAdapter(f.options).captureStop({ identity: f.identity })).toEqual(receipt);
  expect(f.service.recordComputerRecoveryHelper).toHaveBeenCalledTimes(1);
});

test('uncommitted archival failure cannot report successful capture', async () => {
  const f = fixture(); f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false;
  f.service.recordComputerRecoveryHelper.mockRejectedValue(new Error('PRIVATE'));
  await expect(f.adapter.captureStop({ identity: f.identity })).rejects.toMatchObject({ code: 'computer_recovery_node_unknown' });
  expect(f.lease.recoveryHelper.stopEvidence).toBeUndefined();
});

test('concurrent requests coalesce exact owned operations', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 20 }, () => f.adapter.requestStop({ identity: f.identity })));
  expect(f.execute).toHaveBeenCalledTimes(1);
  f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false;
  const results = await Promise.all(Array.from({ length: 20 }, () => f.adapter.captureStop({ identity: f.identity })));
  expect(results.every(value => sameReceipt(value, results[0]))).toBe(true);
  expect(f.service.recordComputerRecoveryHelper).toHaveBeenCalledTimes(1);
});
function sameReceipt(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

test('ownership change after binding prevents late signal dispatch', async () => {
  const f = fixture(); const read = f.options.readPod.getMockImplementation();
  f.options.readPod.mockImplementation(async () => { const value = await read(); f.team.tasks[0].worker.claimId = randomUUID(); return value; });
  await expect(f.adapter.requestStop({ identity: f.identity })).rejects.toBeDefined();
  expect(f.execute).not.toHaveBeenCalled();
});

test('aborted binding cannot later dispatch; command failure exposes no private output', async () => {
  const f = fixture(); const abort = new AbortController();
  f.options.readPod.mockImplementation(async () => { abort.abort(); return copy(f.pod); });
  await expect(f.adapter.requestStop({ identity: f.identity, signal: abort.signal })).rejects.toBeDefined();
  expect(f.execute).not.toHaveBeenCalled();
  const other = fixture(); other.execute.mockRejectedValue(new Error('PRIVATE STDOUT STDERR'));
  await expect(other.adapter.requestStop({ identity: other.identity })).rejects.toThrow('Private recovery node operation is unconfirmed.');
  expect(other.lease.recoveryHelper.stopEvidence).toBeUndefined();
});

test('cancellation before archival dispatch prevents writes; committed receipt survives later cancellation', async () => {
  for (const duringWrite of [false, true]) {
    const f = fixture(); const abort = new AbortController(); f.runtime.status.state = 'CONTAINER_EXITED'; f.group.populated = false;
    if (duringWrite) {
      const save = f.service.recordComputerRecoveryHelper.getMockImplementation();
      f.service.recordComputerRecoveryHelper.mockImplementation(async (...args) => { await save(...args); abort.abort(); throw new Error('reply lost'); });
      expect(await f.adapter.captureStop({ identity: f.identity, signal: abort.signal })).toEqual(f.lease.recoveryHelper.stopEvidence);
    } else {
      f.reader.readCgroup.mockImplementation(async () => { abort.abort(); return copy(f.group); });
      await expect(f.adapter.captureStop({ identity: f.identity, signal: abort.signal })).rejects.toBeDefined();
      expect(f.service.recordComputerRecoveryHelper).not.toHaveBeenCalled();
    }
  }
});

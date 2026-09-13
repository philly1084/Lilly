'use strict';

jest.mock('./local-profile-volume', () => ({ bindLocalProfileVolume: jest.fn() }));
jest.mock('./recovery-helper-observer', () => ({ bindRecoveryHelperContainer: jest.fn() }));
const { randomUUID } = require('node:crypto');
const { reserveRecoveryHelper, advanceRecoveryHelper } = require('./recovery-helper');
const { reserveRecoveryWrite } = require('./recovery-write');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { syntheticProfileRecovery } = require('./profile-recovery-fixture');
const { bindLocalProfileVolume } = require('./local-profile-volume');
const { bindRecoveryHelperContainer } = require('./recovery-helper-observer');
const { createProfileRecoveryController } = require('./recovery-controller');
const copy = value => JSON.parse(JSON.stringify(value));
afterEach(() => jest.resetAllMocks());

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
  const helperId = randomUUID(); reserveRecoveryHelper(lease, { helperId, image: `registry.example/recovery@sha256:${'c'.repeat(64)}` }, now());
  const helper = advanceRecoveryHelper(lease, { helperId, phase: 'provisioning', podUid: randomUUID(), containerId: `containerd://${'d'.repeat(64)}` }, now());
  advanceRecoveryHelper(lease, { helperId, phase: 'ready', nodeBinding: { version: 1, podUid: helper.podUid, containerId: helper.containerId,
    nodeName: lease.nodeBinding.nodeName, hostBootId: lease.nodeBinding.hostBootId, initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
    cgroup: { path: `/kubepods/pod${helper.podUid}/${helper.containerId.slice(13)}`, device: '0', inode: '999' }, observedAt: now() } }, now());
  const receipt = syntheticProfileRecovery(lease);
  const volume = { version: 1, volume: receipt.volume, root: receipt.filesystem.root, pv: { name: `pvc-${lease.pvcUid}`, uid: randomUUID() },
    rootDir: '/fixture-only', observedAt: now() };
  const mount = { version: 1, ...Object.fromEntries(['nodeName', 'hostBootId', 'initPid', 'initStartTicks', 'pidNamespace', 'mountNamespace']
    .map(key => [key, lease.recoveryHelper.nodeBinding[key]])), root: volume.root, mountId: '123' };
  const team = { id: identity.teamId, ownerId: identity.ownerId, tasks: [{ id: identity.taskId, agentId: identity.agentId,
    worker: { id: identity.claim.workerId, claimId: identity.claim.claimId, executionOwner: { bootId: lease.ownerBootId } }, computerLease: lease }] };
  const service = { get: jest.fn(async () => copy(team)), reserveComputerRecoveryWrite: jest.fn(async (_identity, input) => copy(reserveRecoveryWrite(lease, input, now()))),
    recordComputerRecovery: jest.fn(async (_identity, value) => { lease.profileRecovery ||= copy(value); return copy(lease.profileRecovery); }) };
  bindLocalProfileVolume.mockImplementation(async () => copy(volume));
  bindRecoveryHelperContainer.mockImplementation(async () => copy(lease.recoveryHelper.nodeBinding));
  const reader = { observeProfileMount: jest.fn(async () => copy(mount)) };
  const execute = jest.fn(async () => ({ version: 1, helperId, filesystem: copy(receipt.filesystem) }));
  const options = { service, reader, readPod: jest.fn(), readPVC: jest.fn(), readPV: jest.fn(), execute, now };
  return { identity, lease, team, receipt, volume, mount, service, reader, execute, options, controller: createProfileRecoveryController(options) };
}

test('verifies mounts around a single dispatch and confirms the durable receipt without releasing ownership', async () => {
  const f = fixture(); const result = await f.controller.recover(f.identity);
  expect(result.filesystem).toEqual(f.receipt.filesystem); expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.execute.mock.calls[0][0].mode).toBe('recover'); expect(bindLocalProfileVolume).toHaveBeenCalledTimes(6);
  expect(f.reader.observeProfileMount).toHaveBeenCalledTimes(3); expect(f.lease.phase).toBe('closing');
  expect(f.lease.recoveryHelper.phase).toBe('ready');
  expect(await createProfileRecoveryController(f.options).recover(f.identity)).toEqual(result);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test('two controllers share one durable dispatch and the other can only inspect', async () => {
  const f = fixture();
  await Promise.all([f.controller.recover(f.identity), createProfileRecoveryController(f.options).recover(f.identity)]);
  expect(f.execute.mock.calls.map(([value]) => value.mode).sort()).toEqual(['inspect', 'recover']);
});

test('lost intent acknowledgment can never authorize a recovery write', async () => {
  const f = fixture(); const reserve = f.service.reserveComputerRecoveryWrite.getMockImplementation();
  f.service.reserveComputerRecoveryWrite.mockImplementationOnce(async (...args) => { await reserve(...args); throw new Error('lost commit reply'); });
  await f.controller.recover(f.identity);
  expect(f.execute.mock.calls[0][0].mode).toBe('inspect');
});

test('lost command reply is reconciled by fresh inspection, not a repeated write', async () => {
  const f = fixture(); f.execute.mockRejectedValueOnce(new Error('unknown transport outcome'));
  await expect(f.controller.recover(f.identity)).rejects.toMatchObject({ code: 'computer_mounted_recovery_unknown' });
  expect(f.service.recordComputerRecovery).not.toHaveBeenCalled();
  await createProfileRecoveryController(f.options).recover(f.identity);
  expect(f.execute.mock.calls.map(([value]) => value.mode)).toEqual(['recover', 'inspect']);
});

test('lost final acknowledgment is read back without executing again', async () => {
  const f = fixture(); const record = f.service.recordComputerRecovery.getMockImplementation();
  f.service.recordComputerRecovery.mockImplementationOnce(async (...args) => { await record(...args); throw new Error('lost receipt reply'); });
  expect((await f.controller.recover(f.identity)).filesystem).toEqual(f.receipt.filesystem);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test.each(['mount_before', 'volume_before', 'mount_after', 'root_result', 'missing_ack', 'cancel_after_intent', 'foreign_claim'])('%s cannot acknowledge or release a profile', async mode => {
  const f = fixture(); const controller = new AbortController();
  if (mode === 'mount_before') f.mount.root = { ...f.mount.root, inode: '999' };
  if (mode === 'volume_before') bindLocalProfileVolume.mockImplementation(async () => {
    const value = copy(f.volume); if (bindLocalProfileVolume.mock.calls.length === 2) value.pv.uid = randomUUID(); return value;
  });
  if (mode === 'mount_after' || mode === 'root_result') f.execute.mockImplementation(async () => {
    if (mode === 'mount_after') f.mount.mountId = '999';
    const filesystem = copy(f.receipt.filesystem); if (mode === 'root_result') filesystem.root.inode = '999';
    return { version: 1, helperId: f.lease.recoveryHelper.helperId, filesystem };
  });
  if (mode === 'missing_ack') f.service.recordComputerRecovery.mockRejectedValue(new Error('not saved'));
  if (mode === 'cancel_after_intent') {
    const reserve = f.service.reserveComputerRecoveryWrite.getMockImplementation();
    f.service.reserveComputerRecoveryWrite.mockImplementation(async (...args) => { const result = await reserve(...args); controller.abort(); return result; });
  }
  if (mode === 'foreign_claim') f.identity.claim.workerId = 'foreign';
  await expect(f.controller.recover(f.identity, { signal: controller.signal })).rejects.toMatchObject({ code: 'computer_mounted_recovery_unknown' });
  expect(f.lease.profileRecovery).toBeUndefined(); expect(f.lease.phase).toBe('closing');
  if (['mount_before', 'volume_before', 'cancel_after_intent', 'foreign_claim'].includes(mode)) expect(f.execute).not.toHaveBeenCalled();
});

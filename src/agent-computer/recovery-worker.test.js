'use strict';

jest.mock('./profile-recovery', () => ({ recoverProfile: jest.fn(async () => ({ retired: true })),
  inspectRecoveredProfile: jest.fn(async () => ({ retired: true })) }));
const { randomUUID, createHash } = require('node:crypto');
const { Readable, PassThrough } = require('node:stream');
const { identityKey } = require('./runtime');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { reserveRecoveryHelper, advanceRecoveryHelper } = require('./recovery-helper');
const { recoverProfile, inspectRecoveredProfile } = require('./profile-recovery');
const { readRequest, runRecoveryRequest } = require('./recovery-worker');
afterEach(() => jest.clearAllMocks());

function fixture() {
  const identity = { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task', claim: { taskId: 'task', workerId: 'worker', claimId: randomUUID() } };
  const lease = { namespace: 'lilly-team-workers', podName: `browser-${'a'.repeat(32)}`, leaseId: randomUUID(), claimId: identity.claim.claimId,
    ownerBootId: randomUUID(), podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`, phase: 'closing',
    profileKey: identityKey(identity), pvcName: `browser-profile-${'a'.repeat(32)}`,
    identityHash: createHash('sha256').update(JSON.stringify(['owner', 'team', 'agent'])).digest('hex') };
  const fields = Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]]));
  lease.nodeBinding = { version: 1, ...fields, nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 111,
    initStartTicks: '112', pidNamespace: '113', mountNamespace: '114',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '115' }, observedAt: '2026-09-07T01:00:00.000Z' };
  lease.stopEvidence = createBrowserStopEvidence(lease, { ...fields, podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:30:00.000Z' });
  const helperId = randomUUID(); const now = '2026-09-07T02:00:00.000Z';
  reserveRecoveryHelper(lease, { helperId, image: `registry.example/recovery@sha256:${'c'.repeat(64)}` }, now);
  const helper = advanceRecoveryHelper(lease, { helperId, phase: 'provisioning', podUid: randomUUID(), containerId: `containerd://${'d'.repeat(64)}` }, now);
  advanceRecoveryHelper(lease, { helperId, phase: 'ready', nodeBinding: { version: 1, podUid: helper.podUid, containerId: helper.containerId,
    nodeName: lease.nodeBinding.nodeName, hostBootId: lease.nodeBinding.hostBootId, initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
    cgroup: { path: `/kubepods/pod${helper.podUid}/${helper.containerId.slice(13)}`, device: '0', inode: '999' }, observedAt: now } }, now);
  const kernel = { hostBootId: lease.nodeBinding.hostBootId, pidNamespace: 'pid:[700]', mountNamespace: 'mnt:[701]' };
  return { request: { version: 1, identity, lease, root: { device: '1', inode: '2' } }, kernel, readKernel: async () => kernel };
}

test.each(['recover', 'inspect'])('%s executes only its fixed filesystem operation and root', async mode => {
  const f = fixture(); const result = await runRecoveryRequest(f.request, { mode, readKernel: f.readKernel });
  const selected = mode === 'recover' ? recoverProfile : inspectRecoveredProfile;
  const other = mode === 'recover' ? inspectRecoveredProfile : recoverProfile;
  expect(selected).toHaveBeenCalledWith({ rootDir: '/profiles', identity: f.request.identity, lease: f.request.lease, expectedRoot: f.request.root, signal: undefined });
  expect(other).not.toHaveBeenCalled(); expect(result).toEqual({ version: 1, helperId: f.request.lease.recoveryHelper.helperId, filesystem: { retired: true } });
});

test.each(['extra', 'root', 'identity', 'claim', 'phase', 'helper', 'stopped', 'boot', 'pidns', 'mntns', 'mode', 'abort'])('rejects %s before accessing the profile', async mode => {
  const f = fixture(); const options = { mode: 'recover', readKernel: f.readKernel };
  if (mode === 'extra') f.request.command = 'PRIVATE';
  if (mode === 'root') f.request.root.inode = '0';
  if (mode === 'identity') f.request.identity.agentId = 'foreign';
  if (mode === 'claim') f.request.identity.claim.claimId = randomUUID();
  if (mode === 'phase') f.request.lease.phase = 'ready';
  if (mode === 'helper') f.request.lease.recoveryHelper.helperId = randomUUID();
  if (mode === 'stopped') f.request.lease.recoveryHelper.stopEvidence = {};
  if (mode === 'boot') f.kernel.hostBootId = randomUUID();
  if (mode === 'pidns') f.kernel.pidNamespace = 'pid:[999]';
  if (mode === 'mntns') f.kernel.mountNamespace = 'mnt:[999]';
  if (mode === 'mode') options.mode = 'shell';
  if (mode === 'abort') options.signal = AbortSignal.abort();
  await expect(runRecoveryRequest(f.request, options)).rejects.toMatchObject({ code: 'computer_recovery_request_rejected' });
  expect(recoverProfile).not.toHaveBeenCalled(); expect(inspectRecoveredProfile).not.toHaveBeenCalled();
});

test('input is one bounded JSON document and errors do not expose the request', async () => {
  expect(await readRequest(Readable.from(['{"a":', '1}']))).toEqual({ a: 1 });
  for (const input of ['{"PRIVATE":', '{}{}', 'x'.repeat(65537)]) {
    await expect(readRequest(Readable.from([input]))).rejects.toMatchObject({ code: 'computer_recovery_request_rejected', message: 'Private profile helper request rejected.' });
  }
});

test('newline framing does not wait for EOF on a private exec input', async () => {
  const input = new PassThrough(); const pending = readRequest(input);
  input.write('{"value":1}\n');
  expect(await pending).toEqual({ value: 1 }); expect(input.destroyed).toBe(true);
  await expect(readRequest(Readable.from(['{}\n{}']))).rejects.toMatchObject({ code: 'computer_recovery_request_rejected' });
});

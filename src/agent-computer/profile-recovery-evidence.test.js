'use strict';

const { randomUUID } = require('node:crypto');
const { TeamService } = require('../agent-teams/service');
const { TestStore } = require('../agent-teams/test-store');
const { workroomSnapshot } = require('../agent-teams/presentation');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { normalizeProfileRecoveryEvidence } = require('./profile-recovery-evidence');
const { syntheticProfileRecovery } = require('./profile-recovery-fixture');
const { isBrowserLeaseClosed } = require('./lease-state');

async function fixture() {
  const store = new TestStore(); const service = new TeamService({ store });
  const team = await service.create('owner', { name: 'Recovery receipt fixture', objective: 'Synthetic state; no agents or mounts.' });
  const command = (action, input) => service.ownerCommand(team.id, 'owner', action, input, randomUUID());
  const agent = await command('create_agent', { name: 'Fixture', job: 'State only.' });
  await command('configure_execution', { enabled: true });
  await command('assign_task', { agentId: agent.id, title: 'Fixture', instruction: 'Do not execute.' });
  const executionOwner = { version: 1, bootId: randomUUID(), platform: 'win32', pid: 1,
    startedAt: '2026-09-07T00:00:00.000Z', kernel: null, pod: null };
  const [task] = await service.claimEnabled(team.id, 'owner', 'fixture', 1, executionOwner);
  const identity = { ownerId: 'owner', teamId: team.id, agentId: agent.id, taskId: task.id,
    claim: { taskId: task.id, workerId: 'fixture', claimId: task.worker.claimId } };
  let lease = await service.reserveComputerLease(identity, { leaseId: randomUUID(), image: `registry.example/browser@sha256:${'a'.repeat(64)}` });
  const update = value => service.recordComputerLease(identity, { leaseId: lease.leaseId, ...value });
  lease = await update({ phase: 'provisioning', podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}` });
  const nodeBinding = { version: 1,
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '987' }, observedAt: '2026-09-07T01:00:00.000Z' };
  lease = await update({ phase: 'ready', nodeBinding });
  const stop = createBrowserStopEvidence(lease, {
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T02:00:00.000Z' });
  await service.recordComputerStop(identity, stop);
  lease = await update({ phase: 'closing' });
  const saved = async () => (await service.get(team.id, 'owner')).tasks[0].computerLease;
  return { store, service, identity, lease, saved, update, command, executionOwner, receipt: syntheticProfileRecovery(lease) };
}

test('receipt commits without freeing ownership, survives fresh service read and permits separate terminal acknowledgment', async () => {
  const f = await fixture();
  await expect(f.update({ phase: 'closed', podStopped: true, profileReleased: true })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  const receipt = await f.service.recordComputerRecovery(f.identity, f.receipt);
  expect((await f.saved()).phase).toBe('closing');
  const fresh = new TeamService({ store: f.store }); const team = await fresh.get(f.identity.teamId, 'owner');
  expect(team.tasks[0].computerLease.profileRecovery).toEqual(receipt);
  for (const view of [workroomSnapshot(team), await fresh.context(f.identity.teamId, 'owner', f.identity.agentId)]) {
    expect(JSON.stringify(view)).not.toContain('verified-pvc-profile-retirement');
    expect(JSON.stringify(view)).not.toContain(f.receipt.filesystem.stopFingerprint);
  }
  const closed = await f.update({ phase: 'closed', podStopped: true, profileReleased: true });
  expect(isBrowserLeaseClosed(closed)).toBe(true);
  expect(await f.update({ phase: 'closed', podStopped: true, profileReleased: true })).toEqual(closed);
  expect(await fresh.recordComputerRecovery(f.identity, f.receipt)).toEqual(receipt);
});

test('competing acknowledgments retain one immutable record, allowing only timestamp-only read-back', async () => {
  const f = await fixture(); const services = [f.service, new TeamService({ store: f.store })];
  const values = await Promise.all(Array.from({ length: 20 }, (_, i) => services[i % 2].recordComputerRecovery(f.identity,
    { ...f.receipt, observedAt: new Date(Date.parse(f.receipt.observedAt) + i).toISOString() })));
  expect(values.every(value => JSON.stringify(value) === JSON.stringify(values[0]))).toBe(true);
  const changed = structuredClone(f.receipt); changed.filesystem.owner.marker.inode = '99';
  await expect(f.service.recordComputerRecovery(f.identity, changed)).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  expect((await f.saved()).profileRecovery).toEqual(values[0]);
});

test('committed write with lost reply is recovered from a fresh service without replaying filesystem work', async () => {
  const f = await fixture(); const write = f.service.recordComputerRecovery.bind(f.service);
  jest.spyOn(f.service, 'recordComputerRecovery').mockImplementationOnce(async (...args) => { await write(...args); throw new Error('lost acknowledgment'); });
  await expect(f.service.recordComputerRecovery(f.identity, f.receipt)).rejects.toThrow('lost acknowledgment');
  const fresh = new TeamService({ store: f.store });
  expect((await fresh.get(f.identity.teamId, 'owner')).tasks[0].computerLease.profileRecovery).toEqual(f.receipt);
  expect(await fresh.recordComputerRecovery(f.identity, f.receipt)).toEqual(f.receipt);
});

test.each(['volume', 'node', 'boot', 'lease', 'profile', 'owner', 'fingerprint', 'device', 'inode', 'duplicate_inode', 'extra', 'old_time', 'not_retired'])
('rejects %s mismatch without changing durable ownership', async mode => {
  const f = await fixture(); const bad = structuredClone(f.receipt);
  if (mode === 'volume') bad.volume.pvcUid = randomUUID();
  if (mode === 'node') bad.volume.nodeName = 'other-node';
  if (mode === 'boot') bad.volume.hostBootId = randomUUID();
  if (mode === 'lease') bad.filesystem.leaseId = randomUUID();
  if (mode === 'profile') bad.filesystem.profileKey = 'c'.repeat(64);
  if (mode === 'owner') bad.filesystem.owner.owner.leaseId = randomUUID();
  if (mode === 'fingerprint') bad.filesystem.stopFingerprint = 'c'.repeat(64);
  if (mode === 'device') bad.filesystem.profile.device = '2';
  if (mode === 'inode') bad.filesystem.owner.marker.inode = '18446744073709551616';
  if (mode === 'duplicate_inode') bad.filesystem.owner.marker.inode = bad.filesystem.profile.inode;
  if (mode === 'extra') bad.filesystem.secret = 'PRIVATE';
  if (mode === 'old_time') bad.observedAt = '2026-09-07T00:00:00.000Z';
  if (mode === 'not_retired') bad.filesystem.retired = false;
  await expect(f.service.recordComputerRecovery(f.identity, bad)).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  expect(await f.saved()).toEqual(f.lease);
});

test('scope, unarchived stop and wrong phase cannot manufacture profile recovery', async () => {
  const f = await fixture();
  for (const identity of [{ ...f.identity, ownerId: 'foreign' }, { ...f.identity, agentId: 'foreign' },
    { ...f.identity, claim: { ...f.identity.claim, claimId: 'foreign' } }]) {
    await expect(f.service.recordComputerRecovery(identity, f.receipt)).rejects.toBeDefined();
  }
  await expect(f.command('record_computer_recovery', f.receipt)).rejects.toBeDefined();
  await f.store.mutate(f.identity.teamId, 'owner', team => { team.tasks[0].computerLease.phase = 'ready'; });
  await expect(f.service.recordComputerRecovery(f.identity, f.receipt)).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  await f.store.mutate(f.identity.teamId, 'owner', team => { team.tasks[0].computerLease.phase = 'closing'; delete team.tasks[0].computerLease.stopEvidence; });
  await expect(f.service.recordComputerRecovery(f.identity, f.receipt)).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
});

test('missing or corrupt recovery on a terminal label still blocks the next task', async () => {
  const f = await fixture();
  await f.store.mutate(f.identity.teamId, 'owner', team => {
    team.tasks[0].status = 'failed'; Object.assign(team.tasks[0].computerLease, { phase: 'closed', podStopped: true, profileReleased: true });
  });
  await f.command('assign_task', { agentId: f.identity.agentId, title: 'Later', instruction: 'Must stay queued.' });
  expect(await f.service.claimEnabled(f.identity.teamId, 'owner', 'later', 1, f.executionOwner)).toEqual([]);
  await f.store.mutate(f.identity.teamId, 'owner', team => {
    team.tasks[0].computerLease.profileRecovery = { ...f.receipt, volume: { ...f.receipt.volume, pvcUid: randomUUID() } };
  });
  expect(await f.service.claimEnabled(f.identity.teamId, 'owner', 'later', 1, f.executionOwner)).toEqual([]);
});

test('receipt canonicalization is stable across JSONB-style key reordering', async () => {
  const f = await fixture();
  const reverse = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)])) : value;
  expect(normalizeProfileRecoveryEvidence(reverse(f.lease), reverse(f.receipt))).toEqual(f.receipt);
  await f.service.recordComputerRecovery(f.identity, reverse(f.receipt));
  expect((await f.saved()).profileRecovery).toEqual(f.receipt);
});

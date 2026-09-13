'use strict';

const { randomUUID } = require('node:crypto');
const { TeamService } = require('../agent-teams/service');
const { TestStore } = require('../agent-teams/test-store');
const { workroomSnapshot } = require('../agent-teams/presentation');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { syntheticProfileRecovery } = require('./profile-recovery-fixture');
const { recoveryHelperFingerprint, isRecoveryHelperClosed } = require('./recovery-helper');
const image = `registry.example/recovery@sha256:${'a'.repeat(64)}`;

async function fixture() {
  const store = new TestStore({ now: () => '2026-09-07T02:00:00.000Z' }); const service = new TeamService({ store });
  const team = await service.create('owner', { name: 'Helper fixture', objective: 'Synthetic records; no actual resources.' });
  const command = (action, input) => service.ownerCommand(team.id, 'owner', action, input, randomUUID());
  const agent = await command('create_agent', { name: 'Fixture', job: 'State only.' });
  await command('configure_execution', { enabled: true }); await command('assign_task', { agentId: agent.id, title: 'Fixture', instruction: 'No execution.' });
  const executionOwner = { version: 1, bootId: randomUUID(), platform: 'win32', pid: 1, startedAt: '2026-09-07T00:00:00.000Z', kernel: null, pod: null };
  const [task] = await service.claimEnabled(team.id, 'owner', 'fixture', 1, executionOwner);
  const identity = { ownerId: 'owner', teamId: team.id, agentId: agent.id, taskId: task.id,
    claim: { taskId: task.id, workerId: 'fixture', claimId: task.worker.claimId } };
  let lease = await service.reserveComputerLease(identity, { leaseId: randomUUID(), image });
  const update = value => service.recordComputerLease(identity, { leaseId: lease.leaseId, ...value });
  lease = await update({ phase: 'provisioning', podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}` });
  const nodeBinding = { version: 1,
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '987' }, observedAt: '2026-09-07T01:00:00.000Z' };
  lease = await update({ phase: 'ready', nodeBinding });
  await service.recordComputerStop(identity, createBrowserStopEvidence(lease, {
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:30:00.000Z' }));
  lease = await update({ phase: 'closing' });
  const saved = async () => (await service.get(team.id, 'owner')).tasks[0].computerLease;
  const reserve = (helperId = randomUUID()) => service.reserveComputerRecoveryHelper(identity, { helperId, image });
  const advance = (helper, value) => service.recordComputerRecoveryHelper(identity, { helperId: helper.helperId, ...value });
  return { store, service, team, identity, lease, saved, update, reserve, advance, command, executionOwner };
}

async function ready(f) {
  let helper = await f.reserve();
  helper = await f.advance(helper, { phase: 'provisioning', podUid: randomUUID(), containerId: `containerd://${'d'.repeat(64)}` });
  const nodeBinding = { version: 1, podUid: helper.podUid, containerId: helper.containerId,
    nodeName: f.lease.nodeBinding.nodeName, hostBootId: f.lease.nodeBinding.hostBootId, initPid: 444, initStartTicks: '555',
    pidNamespace: '800', mountNamespace: '801', cgroup: { path: `/kubepods/pod${helper.podUid}/${helper.containerId.slice(13)}`, device: '0', inode: '999' },
    observedAt: '2026-09-07T02:01:00.000Z' };
  return f.advance(helper, { phase: 'ready', nodeBinding });
}

const stop = (f, helper) => ({ version: 1, fingerprint: recoveryHelperFingerprint(f.lease, helper),
  source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T02:02:00.000Z' });

test('one helper reservation wins and fresh services read the same private immutable intent', async () => {
  const f = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => f.reserve()));
  const winners = results.filter(result => result.status === 'fulfilled'); expect(winners).toHaveLength(1);
  const helper = winners[0].value;
  expect(helper.createdAt).toBe('2026-09-07T02:00:00.000Z'); expect(helper.phase).toBe('reserved');
  const fresh = new TeamService({ store: f.store });
  expect(await fresh.reserveComputerRecoveryHelper(f.identity, { helperId: helper.helperId, image })).toEqual(helper);
  expect((await f.saved()).recoveryHelper).toEqual(helper);
  for (const view of [workroomSnapshot(await fresh.get(f.team.id, 'owner')), await fresh.context(f.team.id, 'owner', f.identity.agentId)]) {
    expect(JSON.stringify(view)).not.toContain(helper.helperId); expect(JSON.stringify(view)).not.toContain(helper.podName);
  }
});

test('lost reservation acknowledgment is recovered without generating a new helper', async () => {
  const f = await fixture(); const helperId = randomUUID(); const write = f.service.reserveComputerRecoveryHelper.bind(f.service);
  jest.spyOn(f.service, 'reserveComputerRecoveryHelper').mockImplementationOnce(async (...args) => { await write(...args); throw new Error('lost reply'); });
  await expect(f.reserve(helperId)).rejects.toThrow('lost reply');
  expect((await new TeamService({ store: f.store }).reserveComputerRecoveryHelper(f.identity, { helperId, image })).helperId).toBe(helperId);
  await expect(f.reserve()).rejects.toMatchObject({ code: 'team_recovery_helper_conflict' });
});

test('only a reservation that never began provisioning can close without process-stop evidence', async () => {
  const f = await fixture(); const helper = await f.reserve();
  expect((await f.advance(helper, { phase: 'closed' })).closure).toBe('never_created');
  expect(isRecoveryHelperClosed(await f.saved())).toBe(true);
  await expect(f.advance(helper, { phase: 'provisioning' })).rejects.toMatchObject({ code: 'team_recovery_helper_conflict' });
  const another = await fixture(); let started = await another.reserve();
  started = await another.advance(started, { phase: 'provisioning' });
  await another.advance(started, { phase: 'closing' });
  await expect(another.advance(started, { phase: 'closed' })).rejects.toMatchObject({ code: 'team_recovery_helper_conflict' });
});

test('profile receipt cannot free the browser while its recovery helper can still access the volume', async () => {
  const f = await fixture(); let helper = await ready(f);
  await f.service.recordComputerRecovery(f.identity, syntheticProfileRecovery(await f.saved()));
  await expect(f.update({ phase: 'closed', podStopped: true, profileReleased: true })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  helper = await f.advance(helper, { phase: 'closing' });
  await expect(f.advance(helper, { phase: 'closed' })).rejects.toMatchObject({ code: 'team_recovery_helper_conflict' });
  helper = await f.advance(helper, { phase: 'closed', stopEvidence: stop(f, helper) });
  expect(helper.closure).toBe('observed_stopped'); expect(isRecoveryHelperClosed(await f.saved())).toBe(true);
  await f.update({ phase: 'closed', podStopped: true, profileReleased: true });
  expect(await f.advance(helper, { phase: 'closed' })).toEqual(helper);
  await expect(f.advance(helper, { phase: 'closed', podUid: randomUUID() })).rejects.toMatchObject({ code: 'team_recovery_helper_conflict' });
});

test.each(['pod_uid', 'container', 'node', 'boot', 'pid', 'group', 'stop', 'extra'])('rejects changed %s without replacing helper ownership', async mode => {
  const f = await fixture(); const helper = await ready(f); const before = await f.saved();
  let update = { phase: 'ready' };
  if (mode === 'pod_uid') update.podUid = randomUUID();
  if (mode === 'container') update.containerId = `containerd://${'e'.repeat(64)}`;
  if (['node', 'boot', 'pid', 'group'].includes(mode)) {
    update.nodeBinding = JSON.parse(JSON.stringify(helper.nodeBinding));
    if (mode === 'node') update.nodeBinding.nodeName = 'other';
    if (mode === 'boot') update.nodeBinding.hostBootId = randomUUID();
    if (mode === 'pid') update.nodeBinding.initStartTicks = '556';
    if (mode === 'group') update.nodeBinding.cgroup.inode = '1000';
  }
  if (mode === 'stop') update.stopEvidence = { ...stop(f, helper), fingerprint: 'f'.repeat(64) };
  if (mode === 'extra') update.command = 'PRIVATE';
  await expect(f.advance(helper, update)).rejects.toMatchObject({ code: 'team_recovery_helper_conflict' });
  expect(await f.saved()).toEqual(before);
});

test('foreign claims and model/owner commands cannot reserve helpers', async () => {
  const f = await fixture();
  for (const identity of [{ ...f.identity, ownerId: 'foreign' }, { ...f.identity, agentId: 'foreign' },
    { ...f.identity, claim: { ...f.identity.claim, claimId: 'foreign' } }]) {
    await expect(f.service.reserveComputerRecoveryHelper(identity, { helperId: randomUUID(), image })).rejects.toBeDefined();
  }
  await expect(f.command('reserve_computer_recovery_helper', { helperId: randomUUID(), image })).rejects.toBeDefined();
  await f.store.mutate(f.team.id, 'owner', team => { delete team.tasks[0].computerLease.stopEvidence; });
  await expect(f.reserve()).rejects.toMatchObject({ code: 'team_recovery_helper_conflict' });
});

test('a terminal browser label cannot admit another task while the helper is unsettled', async () => {
  const f = await fixture(); await ready(f);
  await f.service.recordComputerRecovery(f.identity, syntheticProfileRecovery(await f.saved()));
  await f.store.mutate(f.team.id, 'owner', team => {
    team.tasks[0].status = 'failed'; Object.assign(team.tasks[0].computerLease, { phase: 'closed', podStopped: true, profileReleased: true });
  });
  await f.command('assign_task', { agentId: f.identity.agentId, title: 'Later', instruction: 'Must remain queued.' });
  expect(await f.service.claimEnabled(f.team.id, 'owner', 'later', 1, f.executionOwner)).toEqual([]);
});

test('only the transaction inserting the recovery write intent may dispatch, including exact retries', async () => {
  const f = await fixture(); const helper = await ready(f);
  const input = { helperId: helper.helperId, operationId: randomUUID(), root: { device: '1', inode: '2' }, mountId: '3', pvUid: randomUUID() };
  const attempts = await Promise.all(Array.from({ length: 20 }, () => f.service.reserveComputerRecoveryWrite(f.identity, input)));
  expect(attempts.filter(result => result.dispatch)).toHaveLength(1);
  expect(attempts.every(result => JSON.stringify(result.intent) === JSON.stringify(attempts[0].intent))).toBe(true);
  const fresh = new TeamService({ store: f.store });
  expect((await fresh.reserveComputerRecoveryWrite(f.identity, input)).dispatch).toBe(false);
  expect((await fresh.reserveComputerRecoveryWrite(f.identity, { ...input, operationId: randomUUID() })).dispatch).toBe(false);
  for (const update of [{ root: { device: '1', inode: '99' } }, { mountId: '99' }, { pvUid: randomUUID() }, { command: 'PRIVATE' }]) {
    await expect(fresh.reserveComputerRecoveryWrite(f.identity, { ...input, ...update })).rejects.toMatchObject({ code: 'team_recovery_write_conflict' });
  }
  expect((await f.saved()).recoveryHelper.writeIntent).toEqual(attempts[0].intent);
});

test('only one concurrent launch transition grants Pod creation authority', async () => {
  const f = await fixture(); const helper = await f.reserve();
  const attempts = await Promise.all(Array.from({ length: 20 }, () => f.service.beginComputerRecoveryHelperLaunch(f.identity, { helperId: helper.helperId })));
  expect(attempts.filter(value => value.dispatch)).toHaveLength(1);
  expect(attempts.every(value => value.helper.phase === 'provisioning')).toBe(true);
  expect(attempts[0].helper.launchStartedAt).toBe('2026-09-07T02:00:00.000Z');
  expect((await new TeamService({ store: f.store }).beginComputerRecoveryHelperLaunch(f.identity, { helperId: helper.helperId })).dispatch).toBe(false);
});

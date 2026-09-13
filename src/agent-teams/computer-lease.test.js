'use strict';

const { randomUUID } = require('node:crypto');
const { TeamService } = require('./service');
const { TestStore } = require('./test-store');
const { workroomSnapshot } = require('./presentation');
const image = `registry.example/browser@sha256:${'a'.repeat(64)}`;
const executionOwner = { version: 1, bootId: randomUUID(), platform: 'win32', pid: 42,
  startedAt: '2026-09-07T00:00:00.000Z', kernel: null, pod: null };
async function fixture() {
  const store = new TestStore(); const service = new TeamService({ store });
  const team = await service.create('owner', { name: 'Browser team', objective: 'Use a private browser.' });
  const command = (action, input) => service.ownerCommand(team.id, 'owner', action, input, randomUUID());
  const agent = await command('create_agent', { name: 'Builder', job: 'Build' });
  await command('configure_execution', { enabled: true });
  await command('assign_task', { agentId: agent.id, title: 'Browser task', instruction: 'Fixture only.' });
  const [task] = await service.claimEnabled(team.id, 'owner', 'worker', 1, executionOwner);
  const claim = { taskId: task.id, workerId: 'worker', claimId: task.worker.claimId };
  const identity = { teamId: team.id, ownerId: 'owner', agentId: agent.id, taskId: task.id, claim };
  return { store, service, team, task, agent, claim, identity, command };
}
const reserve = (f, leaseId = randomUUID()) => f.service.reserveComputerLease(f.identity, { leaseId, image });
const update = (f, lease, input) => f.service.recordComputerLease(f.identity, { leaseId: lease.leaseId, ...input });

test('one durable browser owner wins concurrent reservations and retry reads its same intent', async () => {
  const f = await fixture(); const ids = Array.from({ length: 8 }, () => randomUUID());
  const results = await Promise.allSettled(ids.map(id => reserve(f, id)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const lease = results.find(result => result.status === 'fulfilled').value;
  expect(await reserve(f, lease.leaseId)).toEqual(lease);
  const second = new TeamService({ store: f.store });
  expect((await second.get(f.team.id, 'owner')).tasks[0].computerLease).toEqual(lease);
  await expect(second.reserveComputerLease({ ...f.identity, ownerId: 'foreign' }, { leaseId: randomUUID(), image })).rejects.toMatchObject({ code: 'team_not_found' });
  await expect(reserve(f)).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  expect(lease.ownerBootId).toBe(executionOwner.bootId);
});

test('resource UID binding is immutable, private, and cannot be manufactured by a team command', async () => {
  const f = await fixture(); const lease = await reserve(f); const pvcUid = randomUUID(); const podUid = randomUUID();
  await update(f, lease, { phase: 'provisioning', pvcUid, podUid });
  await expect(update(f, lease, { phase: 'ready' })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  await update(f, lease, { phase: 'ready', containerId: `containerd://${'b'.repeat(64)}` });
  await expect(update(f, lease, { phase: 'closing', pvcUid: randomUUID() })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  await expect(f.command('record_computer_lease', { phase: 'closed' })).rejects.toBeDefined();
  const team = await f.service.get(f.team.id, 'owner');
  expect(JSON.stringify(workroomSnapshot(team))).not.toContain(pvcUid);
  expect(JSON.stringify(await f.service.context(f.team.id, 'owner', f.agent.id))).not.toContain(pvcUid);
  expect(team.computerProfiles[0]).toMatchObject({ agentId: f.agent.id, pvcUid, pvcName: lease.pvcName });
});

test('results cannot release occupied profiles; cancellation still permits exact cleanup evidence', async () => {
  const f = await fixture(); const lease = await reserve(f);
  const result = { status: 'succeeded', summary: 'Only a report.', artifactIds: [] };
  await expect(f.service.recordResult(f.team.id, 'owner', f.claim, result)).rejects.toMatchObject({ code: 'team_computer_unsettled' });
  await f.command('control_agent', { agentId: f.agent.id, action: 'stop' });
  await update(f, lease, { phase: 'closing' });
  await expect(update(f, lease, { phase: 'closed', podStopped: true })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  await update(f, lease, { phase: 'closed', podStopped: true, profileReleased: true });
  expect((await f.service.recordResult(f.team.id, 'owner', f.claim, { ...result, status: 'cancelled' })).status).toBe('cancelled');
});

test('new tasks reuse the same pinned profile but get a new browser owner after proven cleanup', async () => {
  const f = await fixture(); const lease = await reserve(f); const pvcUid = randomUUID();
  await update(f, lease, { phase: 'provisioning', pvcUid });
  await update(f, lease, { phase: 'closing' });
  await update(f, lease, { phase: 'closed', podStopped: true, profileReleased: true });
  await f.service.recordResult(f.team.id, 'owner', f.claim, { status: 'succeeded', summary: 'Fixture', artifactIds: [] });
  await f.command('assign_task', { agentId: f.agent.id, title: 'Next', instruction: 'Same profile.' });
  const future = new TeamService({ store: f.store, now: () => '2099-01-01T00:00:00Z' });
  const [task] = await future.claimEnabled(f.team.id, 'owner', 'next-worker', 1, executionOwner);
  const nextIdentity = { ...f.identity, taskId: task.id, claim: { taskId: task.id, workerId: 'next-worker', claimId: task.worker.claimId } };
  const next = await future.reserveComputerLease(nextIdentity, { leaseId: randomUUID(), image });
  expect(next.pvcName).toBe(lease.pvcName); expect(next.pvcUid).toBe(pvcUid); expect(next.podName).not.toBe(lease.podName);
  await expect(future.recordComputerLease(nextIdentity, { leaseId: lease.leaseId, phase: 'closing' })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
});

test('unknown legacy cleanup blocks new claims even if the old task was marked terminal', async () => {
  const f = await fixture(); await reserve(f);
  await f.store.mutate(f.team.id, 'owner', team => { team.tasks[0].status = 'failed'; });
  await f.command('assign_task', { agentId: f.agent.id, title: 'Later', instruction: 'Do not start over unknown work.' });
  expect(await f.service.claimEnabled(f.team.id, 'owner', 'next-worker', 1, executionOwner)).toEqual([]);
});

test.each([null, [], { image, leaseId: randomUUID(), command: 'not-a-supervisor-input' }])('reservation rejects malformed or expanded input %j', async input => {
  const f = await fixture();
  await expect(f.service.reserveComputerLease(f.identity, input)).rejects.toMatchObject({ code: 'team_computer_lease_invalid' });
  expect((await f.service.get(f.team.id, 'owner')).tasks[0].computerLease).toBeUndefined();
});

test('closed acknowledgements are immutable read-backs, not new resource bindings', async () => {
  const f = await fixture(); const lease = await reserve(f);
  await update(f, lease, { phase: 'closing' });
  const acknowledgment = { phase: 'closed', podStopped: true, profileReleased: true };
  const terminal = await update(f, lease, acknowledgment);
  expect(await update(f, lease, acknowledgment)).toEqual(terminal);
  for (const change of [{ pvcUid: randomUUID() }, { podUid: randomUUID() }, { reason: 'changed' }]) {
    await expect(update(f, lease, { ...acknowledgment, ...change })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  }
  expect((await f.service.get(f.team.id, 'owner')).computerProfiles).toBeUndefined();
});

test('a closed label missing cleanup evidence cannot authorize a competing reservation', async () => {
  const f = await fixture();
  await f.store.mutate(f.team.id, 'owner', team => {
    team.tasks.push({ id: randomUUID(), agentId: f.agent.id, status: 'failed', computerLease: { phase: 'closed', podStopped: true } });
  });
  await expect(reserve(f)).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
});

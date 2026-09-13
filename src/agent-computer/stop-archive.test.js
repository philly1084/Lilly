'use strict';

const { randomUUID } = require('node:crypto');
const { TeamService } = require('../agent-teams/service');
const { TestStore } = require('../agent-teams/test-store');
const { BrowserStopArchive } = require('./stop-archive');
const { normalizeBrowserStopEvidence } = require('./stop-evidence');
const { syntheticProfileRecovery } = require('./profile-recovery-fixture');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const store = new TestStore(); const service = new TeamService({ store });
  const team = await service.create('owner', { name: 'Archive fixture', objective: 'No actual agent execution.' });
  const command = (action, input) => service.ownerCommand(team.id, 'owner', action, input, randomUUID());
  const agent = await command('create_agent', { name: 'Fixture', job: 'Database records only.' });
  await command('configure_execution', { enabled: true });
  await command('assign_task', { agentId: agent.id, title: 'Fixture', instruction: 'No execution.' });
  const executionOwner = { version: 1, bootId: randomUUID(), platform: 'win32', pid: 1,
    startedAt: '2026-09-07T00:00:00.000Z', kernel: null, pod: null };
  const [task] = await service.claimEnabled(team.id, 'owner', 'fixture', 1, executionOwner);
  const identity = { ownerId: 'owner', teamId: team.id, agentId: agent.id, taskId: task.id,
    claim: { taskId: task.id, workerId: 'fixture', claimId: task.worker.claimId } };
  const reserved = await service.reserveComputerLease(identity, { leaseId: randomUUID(), image: `registry.example/browser@sha256:${'a'.repeat(64)}` });
  let lease = await service.recordComputerLease(identity, { leaseId: reserved.leaseId, phase: 'provisioning',
    podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}` });
  const binding = { version: 1,
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '987' }, observedAt: '2026-09-07T01:00:00.000Z' };
  lease = await service.recordComputerLease(identity, { leaseId: lease.leaseId, phase: 'ready', nodeBinding: binding });
  const reader = { inspectContainer: jest.fn(async () => ({ status: { id: lease.containerId.slice(13), state: 'CONTAINER_EXITED', labels: {
    'io.kubernetes.pod.uid': lease.podUid, 'io.kubernetes.pod.namespace': lease.namespace,
    'io.kubernetes.pod.name': lease.podName, 'io.kubernetes.container.name': 'worker' } } })),
  readCgroup: jest.fn(async () => ({ populated: false, hostBootId: binding.hostBootId, identity: binding.cgroup })) };
  const options = { service, reader, now: () => '2026-09-07T02:00:00.000Z' };
  const saved = async () => (await service.get(team.id, 'owner')).tasks[0].computerLease;
  return { store, service, team, identity, lease, reader, options, saved, archive: new BrowserStopArchive(options) };
}

test('archives positive node stop and reads it after runtime garbage collection and observer reconstruction', async () => {
  const f = await fixture(); const receipt = await f.archive.capture(f.identity);
  expect(receipt).toMatchObject({ version: 1, podStopped: true, leaseId: f.lease.leaseId });
  expect(receipt.profileReleased).toBeUndefined(); expect(JSON.stringify(receipt)).not.toContain(f.lease.nodeBinding.cgroup.path);
  expect((await f.saved()).phase).toBe('ready'); expect((await f.saved()).stopEvidence).toEqual(receipt);
  f.reader.inspectContainer.mockRejectedValue(new Error('garbage collected')); f.reader.readCgroup.mockRejectedValue(new Error('gone'));
  const restarted = new BrowserStopArchive({ ...f.options, service: new TeamService({ store: f.store }) });
  expect(await restarted.read(f.identity)).toEqual(receipt); expect(await restarted.capture(f.identity)).toEqual(receipt);
  expect(f.reader.inspectContainer).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await f.service.context(f.team.id, 'owner', f.identity.agentId))).not.toContain(receipt.fingerprint);
});

test.each(['running', 'populated', 'missing'])('never archives %s as stopped', async mode => {
  const f = await fixture(); const write = jest.spyOn(f.service, 'recordComputerStop');
  if (mode === 'running') f.reader.inspectContainer.mockResolvedValue({ status: { state: 'CONTAINER_RUNNING' } });
  if (mode === 'populated') f.reader.readCgroup.mockResolvedValue({ populated: true });
  if (mode === 'missing') f.reader.readCgroup.mockRejectedValue(new Error('PRIVATE'));
  expect(await f.archive.capture(f.identity)).toBeNull(); expect(write).not.toHaveBeenCalled();
});

test('concurrent captures share a pending observation and retain the first persisted receipt', async () => {
  const f = await fixture(); const write = jest.spyOn(f.service, 'recordComputerStop'); const gate = deferred();
  const original = f.reader.readCgroup.getMockImplementation(); f.reader.readCgroup.mockImplementation(async () => { await gate.promise; return original(); });
  const first = f.archive.capture(f.identity);
  for (let i = 0; i < 10; i += 1) expect(f.archive.capture(structuredClone(f.identity))).toBe(first);
  gate.resolve(); const receipt = await first; expect(write).toHaveBeenCalledTimes(1);
  expect(await f.service.recordComputerStop(f.identity, { ...receipt, observedAt: '2026-09-07T03:00:00.000Z' })).toEqual(receipt);
  expect((await f.saved()).stopEvidence).toEqual(receipt);
});

test('a committed write with lost reply is recovered without a second observation or replacement', async () => {
  const f = await fixture(); const original = f.service.recordComputerStop.bind(f.service);
  const write = jest.spyOn(f.service, 'recordComputerStop').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('lost reply'); });
  await expect(f.archive.capture(f.identity)).rejects.toMatchObject({ code: 'computer_stop_archive_unknown' });
  f.reader.inspectContainer.mockRejectedValue(new Error('gone'));
  expect(await new BrowserStopArchive(f.options).capture(f.identity)).toMatchObject({ podStopped: true });
  expect(write).toHaveBeenCalledTimes(1); expect(f.reader.inspectContainer).toHaveBeenCalledTimes(2);
});

test.each(['stop', 'abort'])('%s during observation prevents a late persistence', async mode => {
  const f = await fixture(); const gate = deferred(); const entered = deferred(); const controller = new AbortController();
  const write = jest.spyOn(f.service, 'recordComputerStop'); const original = f.reader.readCgroup.getMockImplementation();
  f.reader.readCgroup.mockImplementation(async () => { entered.resolve(); await gate.promise; return original(); });
  const work = f.archive.capture(f.identity, { signal: controller.signal }); await entered.promise;
  if (mode === 'stop') f.archive.stop(); else controller.abort();
  gate.resolve(); expect(await work).toBeNull(); expect(write).not.toHaveBeenCalled();
});

test('stop during an already dispatched write retains its exact pending promise and read-back', async () => {
  const f = await fixture(); const gate = deferred(); const entered = deferred(); const original = f.service.recordComputerStop.bind(f.service);
  jest.spyOn(f.service, 'recordComputerStop').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  const work = f.archive.capture(f.identity); await entered.promise; f.archive.stop();
  expect(f.archive.capture(f.identity)).toBe(work); gate.resolve();
  expect(await work).toMatchObject({ podStopped: true }); expect(await f.archive.capture(f.identity)).toBeNull();
  expect(await f.archive.read(f.identity)).toMatchObject({ podStopped: true });
});

test.each(['fingerprint', 'container', 'extra', 'old_time'])('corrupt %s evidence is rejected without overwriting the original', async mode => {
  const f = await fixture(); const original = await f.archive.capture(f.identity); const corrupt = { ...original };
  if (mode === 'fingerprint') corrupt.fingerprint = 'c'.repeat(64);
  if (mode === 'container') corrupt.containerId = `containerd://${'c'.repeat(64)}`;
  if (mode === 'extra') corrupt.privateData = 'NEVER_RETURN';
  if (mode === 'old_time') corrupt.observedAt = '2026-09-07T00:00:00.000Z';
  await expect(f.service.recordComputerStop(f.identity, corrupt)).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  expect((await f.saved()).stopEvidence).toEqual(original);
});

test('node-bound leases cannot close on boolean acknowledgements without durable stop evidence', async () => {
  const f = await fixture(); const update = input => f.service.recordComputerLease(f.identity, { leaseId: f.lease.leaseId, ...input });
  await update({ phase: 'closing' });
  await expect(update({ phase: 'closed', podStopped: true, profileReleased: true })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  await f.archive.capture(f.identity);
  await expect(update({ phase: 'closed', podStopped: true, profileReleased: true })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  await f.service.recordComputerRecovery(f.identity, syntheticProfileRecovery(await f.saved()));
  expect((await update({ phase: 'closed', podStopped: true, profileReleased: true })).phase).toBe('closed');
});

test('scope mismatch and expanded owner commands cannot manufacture receipts', async () => {
  const f = await fixture();
  await expect(f.archive.read({ ...f.identity, agentId: 'foreign' })).rejects.toMatchObject({ code: 'computer_stop_archive_unknown' });
  await expect(f.archive.read({ ...f.identity, ownerId: 'foreign' })).rejects.toMatchObject({ code: 'computer_stop_archive_unknown' });
  await expect(f.service.ownerCommand(f.team.id, 'owner', 'record_computer_stop', {}, randomUUID())).rejects.toBeDefined();
  expect(f.reader.inspectContainer).not.toHaveBeenCalled();
});

test('receipt validation is stable after nested JSONB-style key reordering', async () => {
  const f = await fixture(); const receipt = await f.archive.capture(f.identity);
  const reverse = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverse(entry)])) : value;
  expect(normalizeBrowserStopEvidence(reverse(await f.saved()), reverse(receipt))).toEqual(receipt);
});

test('a malformed terminal label cannot release capacity for another task', async () => {
  const f = await fixture();
  await f.store.mutate(f.team.id, 'owner', team => {
    team.tasks[0].status = 'failed';
    Object.assign(team.tasks[0].computerLease, { phase: 'closed', podStopped: true, profileReleased: true });
  });
  await f.service.ownerCommand(f.team.id, 'owner', 'assign_task', { agentId: f.identity.agentId, title: 'Later', instruction: 'Must stay queued.' }, randomUUID());
  const owner = (await f.service.get(f.team.id, 'owner')).tasks[0].worker.executionOwner;
  expect(await f.service.claimEnabled(f.team.id, 'owner', 'next', 1, owner)).toEqual([]);
});

test('an observation in progress cannot overwrite a concurrent closing transition', async () => {
  const f = await fixture(); const gate = deferred(); const entered = deferred(); const original = f.reader.readCgroup.getMockImplementation();
  f.reader.readCgroup.mockImplementation(async () => { entered.resolve(); await gate.promise; return original(); });
  const work = f.archive.capture(f.identity); await entered.promise;
  await f.service.recordComputerLease(f.identity, { leaseId: f.lease.leaseId, phase: 'closing' });
  gate.resolve(); await work; expect((await f.saved()).phase).toBe('closing');
});

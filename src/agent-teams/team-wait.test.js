'use strict';

const { randomUUID } = require('crypto');
const { TeamService } = require('./service');
const { TestStore } = require('./test-store');
const { waitForTeamUpdate } = require('./team-wait');

async function fixture({ concurrency = 2 } = {}) {
  const service = new TeamService({ store: new TestStore() });
  const team = await service.create('owner', { name: 'Wait fixture', objective: 'Coordinate real work.', concurrency, restSeconds: 0 });
  const command = (action, input) => service.ownerCommand(team.id, 'owner', action, input, randomUUID());
  await command('configure_execution', { enabled: true });
  const a = await command('create_agent', { name: 'Builder', job: 'Build.' });
  const b = await command('create_agent', { name: 'Peer', job: 'Assist.' });
  const c = await command('create_agent', { name: 'Other', job: 'Separate work.' });
  const task = await command('assign_task', { agentId: a.id, title: 'Build', instruction: 'Coordinate.' });
  const [claimed] = await service.claimEnabled(team.id, 'owner', 'worker-a', 1);
  const identity = { teamId: team.id, ownerId: 'owner', agentId: a.id, taskId: task.id,
    claim: { taskId: task.id, workerId: 'worker-a', claimId: claimed.worker.claimId } };
  let time = 0;
  const sleep = jest.fn(async ms => { time += ms; });
  const run = (options = {}, extra = {}) => waitForTeamUpdate({ service, identity, options, now: () => time, sleep, ...extra });
  return { service, team, command, a, b, c, task, identity, sleep, run };
}

test('wait sees a delayed reply without waking another task or mutating the team', async () => {
  const f = await fixture();
  let reply;
  f.sleep.mockImplementationOnce(async () => {
    reply = await f.command('send_message', { to: [f.a.id], kind: 'reply', body: 'Ready for review.' });
  });
  const result = await f.run();
  expect(result).toMatchObject({ reason: 'message', cursor: reply.id, messages: [{ id: reply.id, body: 'Ready for review.' }] });
  expect((await f.service.get(f.team.id, 'owner')).tasks).toHaveLength(1);
  expect(f.sleep).toHaveBeenCalledTimes(1);
});

test('cursor includes an already delivered reply but hides other inboxes and internal fields', async () => {
  const f = await fixture();
  const cursor = await f.service.workerCommand(f.team.id, 'owner', f.identity.claim, 'send_message',
    { to: [f.b.id], kind: 'note', body: 'Question.' }, randomUUID());
  await f.command('send_message', { to: [f.c.id], kind: 'note', body: 'OTHER_INBOX_SECRET' });
  await f.command('send_message', { to: [f.a.id], kind: 'reply', body: 'Answer.', replyTo: cursor.id });
  const result = await f.run({ afterMessageId: cursor.id });
  expect(result.reason).toBe('message'); expect(result.messages).toHaveLength(1);
  expect(JSON.stringify(result)).not.toMatch(/OTHER_INBOX_SECRET|claimId|ownerId|worker-a/);
  expect(f.sleep).not.toHaveBeenCalled();
});

test('foreign and unknown message cursors are rejected', async () => {
  const f = await fixture();
  const foreign = await f.command('send_message', { to: [f.c.id], kind: 'note', body: 'Private to C.' });
  for (const afterMessageId of [foreign.id, randomUUID()]) {
    await expect(f.run({ afterMessageId })).rejects.toMatchObject({ code: 'team_wait_cursor_invalid' });
  }
});

test('message batches advance to last delivered item without skipping overflow', async () => {
  const f = await fixture();
  const cursor = await f.command('send_message', { to: [f.a.id], kind: 'note', body: 'Start.' });
  for (let index = 0; index < 23; index += 1) await f.command('send_message', { to: [f.a.id], kind: 'reply', body: `Reply ${index}` });
  const first = await f.run({ afterMessageId: cursor.id });
  const second = await f.run({ afterMessageId: first.cursor });
  expect(first.messages).toHaveLength(20); expect(second.messages).toHaveLength(3);
  expect(second.messages[0].body).toBe('Reply 20');
});

test('model-free timeout is bounded and never labels the task complete', async () => {
  const f = await fixture();
  expect(await f.run({ timeoutMs: 2100 })).toMatchObject({ reason: 'timeout', messages: [] });
  expect(f.sleep.mock.calls.map(call => call[0])).toEqual([1000, 1000, 100]);
  expect((await f.service.get(f.team.id, 'owner')).tasks[0].status).toBe('running');
});

test('large inbox batches fit the native loop result budget without losing messages', async () => {
  const f = await fixture();
  const first = await f.command('send_message', { to: [f.a.id], kind: 'note', body: 'Start.' });
  const expected = [];
  for (let index = 0; index < 12; index += 1) expected.push((await f.command('send_message', {
    to: [f.a.id], kind: 'reply', body: `${index}: ${'x'.repeat(3000)}`,
  })).id);
  const a = await f.run({ afterMessageId: first.id });
  const b = await f.run({ afterMessageId: a.cursor });
  expect(JSON.stringify(a).length).toBeLessThanOrEqual(18000);
  expect(JSON.stringify(b).length).toBeLessThanOrEqual(18000);
  expect([...a.messages, ...b.messages].map(message => message.id)).toEqual(expected);
});

test('watched task changes and already finished tasks return only bounded task state', async () => {
  const f = await fixture();
  const other = await f.command('assign_task', { agentId: f.b.id, title: 'Assist', instruction: 'Help.' });
  f.sleep.mockImplementationOnce(async () => { await f.service.claimEnabled(f.team.id, 'owner', 'worker-b', 1); });
  expect(await f.run({ taskIds: [other.id] })).toMatchObject({ reason: 'task_changed', tasks: [{ id: other.id, status: 'running' }] });
  await f.service.store.mutate(f.team.id, 'owner', team => { team.tasks.find(task => task.id === other.id).status = 'needs_review'; });
  expect(await f.run({ taskIds: [other.id] })).toMatchObject({ reason: 'task_changed', tasks: [{ status: 'needs_review' }] });
});

test('saturated capacity returns immediately instead of holding the only slot until timeout', async () => {
  const f = await fixture({ concurrency: 1 });
  const other = await f.command('assign_task', { agentId: f.b.id, title: 'Assist', instruction: 'Help.' });
  expect(await f.run({ taskIds: [other.id] })).toMatchObject({ reason: 'capacity_blocked', guidance: expect.any(String) });
  expect(f.sleep).not.toHaveBeenCalled();
  expect((await f.service.get(f.team.id, 'owner')).tasks.map(task => task.status)).toEqual(['running', 'queued']);
});

test('whiteboard watches team memory only; private memory changes do not wake or leak', async () => {
  const f = await fixture();
  f.sleep.mockImplementationOnce(async () => { await f.command('remember', { agentId: f.b.id, scope: 'private', content: 'PRIVATE_MEMORY', source: 'fixture' }); })
    .mockImplementationOnce(async () => { await f.command('remember', { agentId: f.b.id, scope: 'team', content: 'Design ready.', source: 'fixture' }); });
  const result = await f.run({ watchWhiteboard: true });
  expect(result).toMatchObject({ reason: 'whiteboard_changed', whiteboardChanged: true });
  expect(f.sleep).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_MEMORY');
});

test('queued work for the same agent cannot run even when another team slot is free', async () => {
  const f = await fixture({ concurrency: 2 });
  const next = await f.command('assign_task', { agentId: f.a.id, title: 'Next assignment', instruction: 'Run later.' });
  expect(await f.run({ taskIds: [next.id] })).toMatchObject({ reason: 'capacity_blocked' });
  expect(f.sleep).not.toHaveBeenCalled();
});

test('preabort, midwait abort and revoked claim stop the wait', async () => {
  const f = await fixture();
  const controller = new AbortController(); controller.abort();
  await expect(f.run({}, { signal: controller.signal })).rejects.toMatchObject({ code: 'team_worker_cancelled' });
  const mid = new AbortController();
  f.sleep.mockImplementationOnce(async () => { mid.abort(); throw new Error('Interrupted timer'); });
  await expect(f.run({}, { signal: mid.signal })).rejects.toMatchObject({ code: 'team_worker_cancelled' });
  f.sleep.mockImplementationOnce(async () => { await f.command('configure_execution', { enabled: false }); });
  await expect(f.run()).rejects.toMatchObject({ code: 'team_claim_required' });
});

test('invalid options and missing or own watched tasks cannot start a wait', async () => {
  const f = await fixture();
  for (const options of [null, [], { timeoutMs: 0 }, { timeoutMs: 30001 }, { taskIds: ['x', 'x'] },
    { taskIds: Array.from({ length: 9 }, () => randomUUID()) }, { watchWhiteboard: 'true' }, { ownerId: 'other' }, { taskIds: [f.task.id] }]) {
    await expect(f.run(options)).rejects.toMatchObject({ code: 'team_wait_invalid' });
  }
  await expect(f.run({ taskIds: [randomUUID()] })).rejects.toMatchObject({ code: 'team_task_not_found' });
  expect(f.sleep).not.toHaveBeenCalled();
});

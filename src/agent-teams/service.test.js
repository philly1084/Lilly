'use strict';

const { TeamService } = require('./service');
const { TeamStore } = require('./store');

const { TestStore } = require('./test-store');

describe('Persistent Lilly teams', () => {
  let store; let service; let team; let counter;
  const owner = 'phil';
  const now = '2026-09-06T12:00:00.000Z';
  const call = (action, input, key) => service.ownerCommand(team.id, owner, action, input, key || `key-${counter++}`);
  const agent = (name = 'Builder', extra = {}) => call('create_agent', { name, job: 'Build inspectable artifacts.', ...extra });
  beforeEach(async () => {
    counter = 0;
    store = new TestStore();
    service = new TeamService({ store, now: () => now });
    team = await service.create(owner, { name: 'Lilly studio', objective: 'Create and review useful work.' });
  });

  test('required deliverable names persist and reject unsafe, duplicate or non-list values', async () => {
    const a = await agent();
    const input = { agentId: a.id, title: 'Deliver', instruction: 'Save draft and final.' };
    for (const requiredArtifacts of [false, 'final.md', ['../final.md'], ['final.md', 'final.md'], ['.'], ['a/b.md']]) {
      await expect(call('assign_task', { ...input, requiredArtifacts })).rejects.toMatchObject({ code: 'team_invalid' });
    }
    const names = ['draft.md', 'final.md'];
    const task = await call('assign_task', { ...input, requiredArtifacts: names }); names.push('later.md');
    const reloaded = await new TeamService({ store }).get(team.id, owner);
    expect(reloaded.tasks.find(t => t.id === task.id).requiredArtifacts).toEqual(['draft.md', 'final.md']);
  });

  test('authoritative result recording rejects a draft alone and verifies every required filename', async () => {
    const a = await agent(); await call('configure_execution', { enabled: true });
    await call('assign_task', { agentId: a.id, title: 'Deliver', instruction: 'Save both.', requiredArtifacts: ['draft.md', 'final.md'] });
    const [task] = await service.claimEnabled(team.id, owner, 'runner', 1);
    const claim = { taskId: task.id, workerId: 'runner', claimId: task.worker.claimId };
    service.verifyArtifact = jest.fn(async ({ artifactId }) => ({ id: artifactId, sha256: 'a'.repeat(64), filename: `${artifactId}.md` }));
    await expect(service.recordResult(team.id, owner, claim, { status: 'succeeded', summary: 'All done', artifactIds: ['draft'] }))
      .rejects.toMatchObject({ code: 'team_completion_evidence_missing' });
    expect((await service.get(team.id, owner)).tasks[0].status).toBe('running');
    const result = await service.recordResult(team.id, owner, claim, { status: 'succeeded', summary: 'Saved both', artifactIds: ['draft', 'final'] });
    expect(result.status).toBe('needs_review'); expect(result.result.artifacts).toHaveLength(2);
  });

  test('persists personas and stable computer/session identity across service restart', async () => {
    const a = await agent('Ada', { persona: 'Careful, concise builder.' });
    service = new TeamService({ store });
    expect((await service.get(team.id, owner)).agents[0]).toEqual(a);
    expect(a.sessionId).toContain(a.id);
    expect(a.computerId).toContain(team.id);
    await expect(service.get(team.id, 'someone-else')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('activity follows matching tool lifecycle, not stale finishes or plain heartbeats', async () => {
    const a = await agent(); await call('configure_execution', { enabled: true });
    await call('assign_task', { agentId: a.id, title: 'Wait', instruction: 'Coordinate.' });
    const [task] = await service.claimEnabled(team.id, owner, 'runner', 1);
    const claim = { taskId: task.id, workerId: 'runner', claimId: task.worker.claimId };
    const beat = event => service.heartbeat(team.id, owner, claim, event);
    const activity = async () => (await service.get(team.id, owner)).tasks[0].worker.activity;
    await beat({ type: 'tool_started', tool: 'team_wait', callId: 'wait-1', args: 'PRIVATE' });
    expect(await activity()).toEqual({ kind: 'waiting_for_team', tool: 'team_wait', callId: 'wait-1', since: now });
    await beat(); await beat({ type: 'tool_finished', tool: 'artifact_write', callId: 'old-call' });
    expect((await activity()).kind).toBe('waiting_for_team');
    await beat({ type: 'tool_finished', tool: 'team_wait', callId: 'wait-1' });
    expect(await activity()).toBeUndefined();
    await beat({ type: 'model_started' }); expect((await activity()).kind).toBe('working');
    await beat({ type: 'tool_started', tool: 'artifact_read', callId: 'read-1' });
    expect((await activity()).kind).toBe('using_tool');
    await beat({ type: 'bridge_closed' }); expect(await activity()).toBeUndefined();
    expect(JSON.stringify((await service.get(team.id, owner)).events)).not.toContain('PRIVATE');
  });

  test('execution ownership is committed with admission and survives a service restart', async () => {
    const a = await agent();
    await call('configure_execution', { enabled: true });
    await call('assign_task', { agentId: a.id, title: 'Owned', instruction: 'Fixture only.' });
    const executionOwner = { version: 1, bootId: '01234567-89ab-4cde-8fab-0123456789ab', platform: 'win32',
      pid: 42, startedAt: '2026-09-07T00:00:00.000Z', kernel: null, pod: null };
    const [claimed] = await service.claimEnabled(team.id, owner, 'runner', 1, executionOwner);
    executionOwner.pid = 123;
    service = new TeamService({ store });
    const saved = (await service.get(team.id, owner)).tasks[0];
    expect(saved.worker).toEqual(claimed.worker);
    expect(saved.worker.executionOwner.pid).toBe(42);
    expect(saved.worker.id).toBe('runner'); expect(saved.worker.claimId).toEqual(expect.any(String));
    expect(JSON.stringify(await service.context(team.id, owner, a.id))).not.toContain(executionOwner.bootId);
  });

  test('malformed ownership cannot claim a task or partially persist state', async () => {
    const a = await agent();
    await call('configure_execution', { enabled: true });
    await call('assign_task', { agentId: a.id, title: 'Owned', instruction: 'Fixture only.' });
    const before = await service.get(team.id, owner);
    await expect(service.claimEnabled(team.id, owner, 'runner', 1, { bootId: 'not-an-owner' }))
      .rejects.toMatchObject({ code: 'team_execution_owner_invalid' });
    expect(await service.get(team.id, owner)).toEqual(before);
  });

  test('profile edit persists across restart and uncertain retry cannot overwrite a later edit', async () => {
    const a = await agent();
    const first = { agentId: a.id, name: 'Mira', persona: 'Checks evidence.' };
    await call('update_agent', first, 'edit-profile');
    await call('update_agent', { agentId: a.id, name: 'Mira 2' }, 'edit-profile-later');
    service = new TeamService({ store });
    expect((await call('update_agent', first, 'edit-profile')).name).toBe('Mira');
    expect((await service.get(team.id, owner)).agents[0]).toMatchObject({ id: a.id, name: 'Mira 2', persona: 'Checks evidence.', sessionId: a.sessionId });
    await expect(call('update_agent', { ...first, name: 'Overwritten' }, 'edit-profile')).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
    await expect(service.ownerCommand(team.id, 'foreign', 'update_agent', first, 'foreign-edit')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('keyed team creation survives concurrent retries and never resets saved work', async () => {
    const input = { name: 'Persistent team', objective: 'Create real artifacts.' };
    const otherService = new TeamService({ store });
    const [first, retry] = await Promise.all([
      service.create(owner, input, 'create-once'), otherService.create(owner, input, 'create-once'),
    ]);
    expect(first.id).toBe(retry.id);
    const teammate = await service.ownerCommand(first.id, owner, 'create_agent', { name: 'Ada', job: 'Build.' }, 'add-ada');
    expect((await otherService.create(owner, input, 'create-once')).agents[0].id).toBe(teammate.id);
    await expect(service.create(owner, { ...input, name: 'Changed' }, 'create-once')).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
    expect((await service.create('other-owner', input, 'create-once')).id).not.toBe(first.id);
    await expect(service.create(owner, input, '')).rejects.toMatchObject({ code: 'team_invalid' });
    expect(await service.get(first.id, owner)).toMatchObject({ name: input.name, agents: [{ id: teammate.id }] });
  });

  test('owner review rechecks exact artifact bytes and receipt retries never repeat the approval', async () => {
    const a = await agent();
    const task = await call('assign_task', { agentId: a.id, title: 'Build', instruction: 'Save output.' });
    const [claimed] = await service.claim(team.id, owner, 'worker');
    const claim = { taskId: task.id, workerId: 'worker', claimId: claimed.worker.claimId };
    service.verifyArtifact = jest.fn(async ({ artifactId }) => ({ id: artifactId, sha256: 'a'.repeat(64) }));
    await service.recordResult(team.id, owner, claim, { status: 'succeeded', summary: 'Saved.', artifactIds: ['artifact'] });
    service.verifyArtifact.mockResolvedValueOnce({ id: 'artifact', sha256: 'b'.repeat(64) });
    const input = { taskId: task.id, approved: true, note: 'Checked the actual output.' };
    await expect(call('review_task', input, 'review-1')).rejects.toMatchObject({ code: 'team_evidence_required' });
    expect((await service.get(team.id, owner)).tasks[0].status).toBe('needs_review');
    const approved = await call('review_task', input, 'review-1');
    expect(approved.status).toBe('completed');
    service.verifyArtifact.mockRejectedValue(new Error('Offline after approval.'));
    expect(await call('review_task', input, 'review-1')).toEqual(approved);
    await expect(call('review_task', { ...input, note: 'Different decision' }, 'review-1')).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
  });

  test('owner review refuses a result-reference change during read-back', async () => {
    const a = await agent();
    const task = await call('assign_task', { agentId: a.id, title: 'Build', instruction: 'Save output.' });
    const [claimed] = await service.claim(team.id, owner, 'worker');
    service.verifyArtifact = async () => ({ id: 'artifact', sha256: 'a'.repeat(64) });
    await service.recordResult(team.id, owner, { taskId: task.id, workerId: 'worker', claimId: claimed.worker.claimId },
      { status: 'succeeded', summary: 'Saved.', artifactIds: ['artifact'] });
    service.verifyArtifact = async () => {
      await store.mutate(team.id, owner, (state) => { state.tasks[0].result.artifacts[0].sha256 = 'b'.repeat(64); });
      return { id: 'artifact', sha256: 'a'.repeat(64) };
    };
    await expect(call('review_task', { taskId: task.id, approved: true, note: 'Checked.' })).rejects.toMatchObject({ code: 'team_evidence_required' });
    expect((await service.get(team.id, owner)).tasks[0].status).toBe('needs_review');
  });

  test('copies profile but never private memory or conversation', async () => {
    const a = await agent('Ada', { persona: 'Precise.' });
    await call('remember', { agentId: a.id, scope: 'private', content: 'Personal fact.', source: 'Task 1' });
    const b = await agent('Bea', { copyFrom: a.id, job: undefined });
    expect(b.persona).toBe('Precise.');
    expect(b.sessionId).not.toBe(a.sessionId);
    expect((await service.context(team.id, owner, b.id)).memories).toEqual([]);
  });

  test('request wakes each recipient once; retries and replies do not duplicate work', async () => {
    const a = await agent();
    const input = { to: [a.id, a.id], kind: 'request', body: 'Inspect the draft.' };
    const first = await call('send_message', input, 'request-1');
    expect(await call('send_message', input, 'request-1')).toEqual(first);
    await call('send_message', { to: [a.id], kind: 'reply', body: 'Thanks.', replyTo: first.id });
    const state = await service.get(team.id, owner);
    expect(state.tasks).toHaveLength(1);
    expect(state.messages).toHaveLength(2);
    await expect(call('send_message', { ...input, body: 'Different work' }, 'request-1')).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
  });

  test('parallel claimers cannot exceed concurrency or share one agent computer', async () => {
    const agents = await Promise.all([agent('A'), agent('B'), agent('C'), agent('D')]);
    for (const a of agents) await call('assign_task', { agentId: a.id, title: 'Read', instruction: 'Read source.' });
    await call('assign_task', { agentId: agents[0].id, title: 'Another', instruction: 'Read again.' });
    const batches = await Promise.all([service.claim(team.id, owner, 'worker1'), service.claim(team.id, owner, 'worker2')]);
    expect(batches.flat()).toHaveLength(3);
    expect(new Set(batches.flat().map((entry) => entry.agentId)).size).toBe(3);
  });

  test('serializes overlapping file/directory targets and waits for dependencies', async () => {
    const [a, b, c] = await Promise.all([agent('A'), agent('B'), agent('C')]);
    const one = await call('assign_task', { agentId: a.id, title: 'Code', instruction: 'Edit.', writeTargets: ['/repo/src'] });
    await call('assign_task', { agentId: b.id, title: 'Test', instruction: 'Edit.', writeTargets: ['/repo/src/test.js'] });
    await call('assign_task', { agentId: c.id, title: 'Review', instruction: 'Review.', dependencies: [one.id] });
    expect(await service.claim(team.id, owner, 'worker')).toHaveLength(1);
  });

  test('stop preserves identity, requests cancellation, and forbids new worker actions', async () => {
    const a = await agent();
    await call('assign_task', { agentId: a.id, title: 'Work', instruction: 'Do work.' });
    const [task] = await service.claim(team.id, owner, 'w');
    await call('control_agent', { agentId: a.id, action: 'stop' });
    const state = await service.get(team.id, owner);
    expect(state.tasks[0].cancelRequestedAt).toBe(now);
    const claim = { taskId: task.id, workerId: 'w', claimId: task.worker.claimId };
    await expect(service.workerCommand(team.id, owner, claim, 'remember', {}, 'no')).rejects.toMatchObject({ code: 'team_claim_required' });
    const resumed = await call('control_agent', { agentId: a.id, action: 'resume' });
    expect(resumed.sessionId).toBe(a.sessionId);
    expect(await service.claim(team.id, owner, 'other')).toEqual([]);
  });

  test('worker identity derives from a fenced task claim, not input', async () => {
    await call('configure_execution', { enabled: true });
    const [a, b] = await Promise.all([agent('A'), agent('B')]);
    await call('assign_task', { agentId: a.id, title: 'Work', instruction: 'Work.' });
    const [task] = await service.claim(team.id, owner, 'w');
    const claim = { taskId: task.id, workerId: 'w', claimId: task.worker.claimId };
    const memory = await service.workerCommand(team.id, owner, claim, 'remember', {
      agentId: b.id, scope: 'private', content: 'Remember.', source: 'Task',
    }, 'memory');
    expect(memory.agentId).toBe(a.id);
    expect((await service.context(team.id, owner, b.id)).memories).toEqual([]);
    await expect(service.workerCommand(team.id, owner, { ...claim, claimId: 'forged' }, 'remember', {}, 'fake')).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.workerCommand(team.id, owner, claim, 'create_agent', { name: 'Forged', job: 'Work' }, 'grow')).rejects.toMatchObject({ statusCode: 403 });
    await call('configure_execution', { enabled: false });
    await expect(service.workerCommand(team.id, owner, claim, 'remember', {
      scope: 'private', content: 'After revocation.', source: 'Task',
    }, 'revoked')).rejects.toMatchObject({ code: 'team_claim_required' });
  });

  test('skills require approval and task pins the approved revision', async () => {
    const a = await agent();
    const skill = await call('save_skill', { name: 'Review', instructions: 'Inspect source.', acceptance: 'Cite evidence.' });
    const input = { agentId: a.id, title: 'Review', instruction: 'Review source.', skillId: skill.id };
    await expect(call('assign_task', input)).rejects.toThrow('approved');
    await call('approve_skill', { skillId: skill.id });
    const task = await call('assign_task', input);
    const revised = await call('save_skill', { name: 'Review', instructions: 'Changed instructions.', acceptance: 'Cite evidence.', replaces: skill.id });
    expect(revised).toMatchObject({ revision: 2, status: 'draft' });
    expect(task.skill).toMatchObject({ revision: 1, instructions: 'Inspect source.', acceptance: 'Cite evidence.' });
  });

  test('engine sessions and pod leases are fenced, durable and contain no worker credentials', async () => {
    await call('configure_execution', { enabled: true });
    const a = await agent();
    await call('assign_task', { agentId: a.id, title: 'Build', instruction: 'Build.' });
    const [task] = await service.claim(team.id, owner, 'worker');
    const identity = { teamId: team.id, ownerId: owner, agentId: a.id, taskId: task.id,
      claim: { taskId: task.id, workerId: 'worker', claimId: task.worker.claimId } };
    expect(await service.getEngineSession(identity)).toBeNull();
    await service.saveEngineSession(identity, 'persistent-grok-session');
    expect(await new TeamService({ store }).getEngineSession(identity)).toMatchObject({ sessionId: 'persistent-grok-session' });
    await expect(service.saveEngineSession(identity, 'replacement-session')).rejects.toMatchObject({ code: 'team_session_conflict' });
    await expect(service.getEngineSession({ ...identity, claim: { ...identity.claim, claimId: 'forged' } })).rejects.toMatchObject({ code: 'team_claim_required' });
    await service.recordWorkerLease(identity, { leaseId: 'lease', namespace: 'lilly-team-workers', podName: 'grok-task', phase: 'provisioning' });
    await expect(service.recordWorkerLease(identity, { leaseId: 'lease', phase: 'ready', modelToken: 'secret' })).rejects.toMatchObject({ code: 'team_invalid' });
    await expect(service.recordWorkerLease(identity, { leaseId: 'replacement', phase: 'provisioning' })).rejects.toMatchObject({ code: 'team_lease_conflict' });
    await call('control_agent', { agentId: a.id, action: 'stop' });
    await expect(service.saveEngineSession(identity, 'persistent-grok-session')).rejects.toMatchObject({ code: 'team_claim_required' });
    await service.unobserved(team.id, owner, identity.claim);
    await service.recordWorkerLease(identity, { leaseId: 'lease', phase: 'closed', podUid: 'actual-pod-uid' });
    expect((await service.get(team.id, owner)).tasks[0].engineLease).toMatchObject({ phase: 'closed', podUid: 'actual-pod-uid' });
  });

  test('task budget failure rolls back all recipients, not a half-delivered request', async () => {
    await store.mutate(team.id, owner, (state) => { state.limits.maxTasks = 1; });
    const [a, b] = await Promise.all([agent('A'), agent('B')]);
    await expect(call('send_message', { to: [a.id, b.id], kind: 'request', body: 'Work.' })).rejects.toMatchObject({ code: 'team_task_limit' });
    expect((await service.get(team.id, owner)).tasks).toEqual([]);
    expect((await service.get(team.id, owner)).messages).toEqual([]);
  });

  test('rejects noncanonical write targets and invented dependencies', async () => {
    const a = await agent();
    const input = { agentId: a.id, title: 'Work', instruction: 'Work.' };
    await expect(call('assign_task', { ...input, writeTargets: ['/repo/../outside'] })).rejects.toThrow('canonical');
    await expect(call('assign_task', { ...input, dependencies: ['foreign-task'] })).rejects.toThrow('dependencies');
  });

  test('forget removes content from both memory and idempotent response history', async () => {
    const a = await agent();
    const input = { agentId: a.id, scope: 'private', content: 'erase-this-fact', source: 'Task' };
    const memory = await call('remember', input, 'remember-once');
    await call('forget', { memoryId: memory.id });
    expect(JSON.stringify(await service.get(team.id, owner))).not.toContain('erase-this-fact');
    expect(await call('remember', input, 'remember-once')).toEqual({ id: memory.id, forgotten: true });
  });

  test('routine is off by default and a delayed tick queues only one occurrence', async () => {
    const a = await agent();
    const reviewer = await agent('Reviewer', { role: 'reviewer' });
    const skill = await call('save_skill', { name: 'Check', instructions: 'Read source.', acceptance: 'Cite evidence.' });
    await call('approve_skill', { skillId: skill.id });
    const routine = await call('create_routine', {
      agentId: a.id, skillId: skill.id, title: 'Daily', instruction: 'Do the check.', intervalSeconds: 60,
      requiredArtifacts: ['report.md'], reviewerId: reviewer.id,
    });
    expect(routine.enabled).toBe(false);
    expect(await service.claim(team.id, owner, 'w')).toEqual([]);
    await call('control_routine', { routineId: routine.id, enabled: true });
    service.now = () => '2026-09-08T12:00:00.000Z';
    const tasks = await service.claim(team.id, owner, 'w');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].routineId).toBe(routine.id);
    expect(tasks[0].requiredArtifacts).toEqual(['report.md']);
    expect(tasks[0].reviewerId).toBe(reviewer.id);
    service.now = () => '2026-09-09T12:00:00.000Z';
    expect(await service.claim(team.id, owner, 'other')).toEqual([]);
    expect((await service.get(team.id, owner)).tasks).toHaveLength(1);
  });

  test('routine creation rejects invalid evidence requirements before it can be enabled', async () => {
    const a = await agent();
    const skill = await call('save_skill', { name: 'Check', instructions: 'Read source.', acceptance: 'Save evidence.' });
    await call('approve_skill', { skillId: skill.id });
    const input = { agentId: a.id, skillId: skill.id, title: 'Daily', instruction: 'Check.' };
    await expect(call('create_routine', { ...input, requiredArtifacts: ['../outside'] })).rejects.toMatchObject({ code: 'team_invalid' });
    await expect(call('create_routine', { ...input, reviewerId: a.id })).rejects.toMatchObject({ code: 'team_invalid' });
    expect((await service.get(team.id, owner)).routines).toEqual([]);
  });

  test('model completion prose cannot pass review without artifact read-back', async () => {
    const a = await agent();
    await call('assign_task', { agentId: a.id, title: 'Build', instruction: 'Build output.' });
    const [task] = await service.claim(team.id, owner, 'w');
    const claim = { taskId: task.id, workerId: 'w', claimId: task.worker.claimId };
    const recorded = await service.recordResult(team.id, owner, claim, { status: 'succeeded', summary: 'Done!', artifactIds: ['invented'] });
    expect(recorded.status).toBe('needs_review');
    await expect(call('review_task', { taskId: task.id, approved: true, note: 'Looks done.' })).rejects.toMatchObject({ code: 'team_evidence_required' });
  });

  test('verified result rests its worker, then owner review unlocks dependencies', async () => {
    service.verifyArtifact = jest.fn(async ({ artifactId }) => ({ id: artifactId, sha256: 'a'.repeat(64) }));
    const [a, b] = await Promise.all([agent('Builder'), agent('Reviewer')]);
    const task = await call('assign_task', { agentId: a.id, title: 'Build', instruction: 'Build output.' });
    const dependent = await call('assign_task', { agentId: b.id, title: 'Use', instruction: 'Use verified output.', dependencies: [task.id] });
    const [claimed] = await service.claim(team.id, owner, 'w');
    await service.recordResult(team.id, owner, { taskId: task.id, workerId: 'w', claimId: claimed.worker.claimId }, {
      status: 'succeeded', summary: 'Saved output.', artifactIds: ['artifact'],
    });
    expect(service.verifyArtifact).toHaveBeenCalledWith({ teamId: team.id, ownerId: owner, taskId: task.id, agentId: a.id, artifactId: 'artifact' });
    expect((await service.get(team.id, owner)).agents[0].restUntil).toBe('2026-09-06T12:00:30.000Z');
    await call('review_task', { taskId: task.id, approved: true, note: 'Read back and checked.' });
    expect((await service.claim(team.id, owner, 'w2')).map((entry) => entry.id)).toEqual([dependent.id]);
  });
});

describe('Postgres team transaction boundary', () => {
  test('locks by owner and team, rolls back failed mutations, releases connection', async () => {
    const client = { query: jest.fn(async (sql) => ({ rows: sql.startsWith('SELECT') ? [{ state: { id: 't' } }] : [] })), release: jest.fn() };
    const database = { query: jest.fn().mockResolvedValue({ rows: [] }), getPool: () => ({ connect: async () => client }) };
    const store = new TeamStore({ database });
    await expect(store.mutate('t', 'owner', () => { throw new Error('Bad mutation'); })).rejects.toThrow('Bad mutation');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['t', 'owner']);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});

module.exports = { TestStore };

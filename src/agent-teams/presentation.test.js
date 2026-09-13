'use strict';

const { createTeam, command } = require('./domain');
const { workroomSnapshot, ownerMemorySnapshot } = require('./presentation');
const now = '2026-09-06T23:00:00.000Z';
function fixture() {
  const team = createTeam('owner', { name: 'Lilly team', objective: 'Build a working artifact.' }, now);
  const agent = command(team, {}, 'create_agent', { name: 'Builder', job: 'Build', persona: 'Careful builder.' }, now);
  const task = command(team, {}, 'assign_task', { agentId: agent.id, title: 'Build', instruction: 'Write output.' }, now);
  return { team, agent, task };
}

test('projects useful team content without internal claims, leases, sessions, receipts or private memories', () => {
  const { team, agent, task } = fixture();
  const marker = 'PRIVATE_SENTINEL';
  agent.engineSession = { sessionId: marker };
  agent.browser = { pixels: marker, url: marker };
  task.worker = { id: marker, claimId: marker, heartbeatAt: now, executionOwner: { bootId: marker, kernel: marker, pod: marker } };
  task.engineLease = { token: marker, podUid: marker };
  task.computerLease = { podUid: marker, pvcUid: marker };
  team.computerProfiles = [{ pvcUid: marker }];
  task.artifactReads = { private: marker };
  task.operations = [{ id: marker, kind: 'artifact_write', fingerprint: marker }];
  team.receipts.push({ result: marker });
  command(team, {}, 'remember', { agentId: agent.id, scope: 'private', content: marker, source: marker }, now);
  command(team, {}, 'remember', { agentId: agent.id, scope: 'team', content: 'Use pinned tools.', source: 'Owner decision' }, now);
  team.events.push({ id: 'event', type: 'tool_started', agentId: agent.id, at: now,
    tool: 'artifact_write', callId: 'call_1', args: marker, output: marker, screenshot: marker });
  team.events.push({ id: 'unrecognized', type: marker, tool: marker });
  const view = workroomSnapshot(team, now);
  expect(JSON.stringify(view)).not.toContain(marker);
  expect(view.agents[0].persona).toBe('Careful builder.');
  expect(view.notes).toHaveLength(1);
  expect(view.notes[0].content).toBe('Use pinned tools.');
  expect(view.events.at(-1)).toEqual({ id: 'event', type: 'tool_started', agentId: agent.id, at: now, tool: 'artifact_write', callId: 'call_1' });
  expect(view.tasks[0].heartbeatAt).toBe(now);
});

test('queued, waiting, stopped, resting, reviewing and reconciling never pretend to be running', () => {
  const { team, agent, task } = fixture();
  const status = () => workroomSnapshot(team, now).agents[0].status;
  expect(status()).toBe('paused');
  team.execution.enabled = true;
  expect(status()).toBe('queued');
  task.dependencies = ['missing-dependency'];
  expect(status()).toBe('waiting');
  agent.restUntil = '2026-09-07T00:00:00.000Z';
  expect(status()).toBe('resting');
  agent.enabled = false;
  expect(status()).toBe('stopped');
  task.status = 'running';
  expect(status()).toBe('running'); // Disable alone is not proof of termination.
  task.cancelRequestedAt = now;
  expect(status()).toBe('stopping');
  task.status = 'reconciling';
  expect(status()).toBe('reconciling');
  task.status = 'needs_review'; agent.enabled = true; agent.restUntil = null;
  expect(status()).toBe('needs_review');
  task.status = 'changes_requested';
  expect(status()).toBe('changes_requested');
});

test('artifact shelf exposes verified hashes and review state, not arbitrary result URLs or contents', () => {
  const { team, task } = fixture();
  task.status = 'needs_review';
  task.result = { summary: 'Saved output.', finishedAt: now,
    artifacts: [{ id: 'artifact-1', sha256: 'a'.repeat(64), url: 'https://private.example/token', content: 'PRIVATE' }] };
  const view = workroomSnapshot(team, now);
  expect(view.artifacts).toEqual([{ id: 'artifact-1', sha256: 'a'.repeat(64), taskId: task.id, agentId: task.agentId, reviewStatus: 'needs_review' }]);
  expect(JSON.stringify(view)).not.toContain('private.example');
  view.tasks[0].result.artifacts[0].id = 'changed';
  expect(task.result.artifacts[0].id).toBe('artifact-1');
});

test('saved in-flight files appear before the final result without exposing private operation data', () => {
  const { team, task } = fixture(); task.status = 'running';
  task.operations = [{ id: 'saved-draft', kind: 'artifact_write', status: 'settled', fingerprint: 'PRIVATE',
    artifact: { id: 'saved-draft', sha256: 'b'.repeat(64), content: 'PRIVATE', url: 'PRIVATE' } }];
  const view = workroomSnapshot(team, now);
  expect(view.tasks[0].result).toBeNull();
  expect(view.artifacts).toEqual([{ id: 'saved-draft', sha256: 'b'.repeat(64), taskId: task.id,
    agentId: task.agentId, reviewStatus: 'unreviewed' }]);
  expect(JSON.stringify(view)).not.toContain('PRIVATE');
  view.artifacts[0].sha256 = 'changed'; expect(task.operations[0].artifact.sha256).toBe('b'.repeat(64));
});

test.each(['reserved', 'unknown', 'wrong-kind', 'wrong-id', 'bad-hash', 'missing-artifact'])('does not publish %s operations as saved outputs', mode => {
  const { team, task } = fixture();
  const operation = { id: 'draft', kind: 'artifact_write', status: 'settled', artifact: { id: 'draft', sha256: 'b'.repeat(64) } };
  if (['reserved', 'unknown'].includes(mode)) operation.status = mode;
  if (mode === 'wrong-kind') operation.kind = 'computer_act';
  if (mode === 'wrong-id') operation.artifact.id = 'foreign';
  if (mode === 'bad-hash') operation.artifact.sha256 = 'invalid';
  if (mode === 'missing-artifact') delete operation.artifact;
  task.operations = [operation];
  expect(workroomSnapshot(team, now).artifacts).toEqual([]);
});

test('final review replaces the draft shelf status once without approving omitted outputs', () => {
  const { team, task } = fixture(); task.status = 'completed';
  task.result = { artifacts: [{ id: 'final', sha256: 'a'.repeat(64) }] };
  task.operations = ['final', 'draft', 'draft'].map(id => ({ id, kind: 'artifact_write', status: 'settled',
    artifact: { id, sha256: 'a'.repeat(64) } }));
  const artifacts = workroomSnapshot(team, now).artifacts;
  expect(artifacts.map(({ id, reviewStatus }) => ({ id, reviewStatus }))).toEqual([
    { id: 'final', reviewStatus: 'completed' }, { id: 'draft', reviewStatus: 'unreviewed' },
  ]);
});

test('observed waits are distinct from working and missing heartbeat without exposing private activity', () => {
  const { team, task } = fixture();
  task.status = 'running';
  task.worker = { heartbeatAt: now, activity: { kind: 'waiting_for_team', callId: 'PRIVATE_CALL',
    args: 'PRIVATE_ARGS', since: now } };
  expect(workroomSnapshot(team, now).agents[0]).toMatchObject({ status: 'running', activity: { kind: 'waiting_for_team', since: now } });
  expect(JSON.stringify(workroomSnapshot(team, now))).not.toMatch(/PRIVATE_CALL|PRIVATE_ARGS/);
  task.worker.activity = { kind: 'using_tool', tool: 'artifact_write', since: now };
  expect(workroomSnapshot(team, now).agents[0].activity).toEqual({ kind: 'using_tool', tool: 'artifact_write', since: now });
  for (const heartbeatAt of [undefined, 'invalid', '2026-09-06T22:59:00Z', '2026-09-07T00:00:00Z']) {
    task.worker.heartbeatAt = heartbeatAt;
    expect(workroomSnapshot(team, now).agents[0]).toMatchObject({ status: 'running', activity: { kind: 'unconfirmed' } });
    expect(task.status).toBe('running');
  }
  task.cancelRequestedAt = now;
  expect(workroomSnapshot(team, now).agents[0]).not.toHaveProperty('activity');
  task.status = 'reconciling';
  expect(workroomSnapshot(team, now).agents[0]).not.toHaveProperty('activity');
});

test('owner memory view is an independent allowlist, not a raw execution-state response', () => {
  const { team, agent } = fixture();
  const memory = command(team, {}, 'remember', { agentId: agent.id, scope: 'private', content: 'Owner-visible preference.', source: 'Owner' }, now);
  memory.internal = { token: 'DO_NOT_EXPOSE' };
  team.memories.push({ id: 'invalid', scope: 'unknown', content: 'DO_NOT_EXPOSE' });
  const result = ownerMemorySnapshot(team);
  expect(result.memories).toEqual([{ id: memory.id, agentId: agent.id, scope: 'private', content: memory.content, source: 'Owner', createdAt: now }]);
  expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
  expect(workroomSnapshot(team).notes).toEqual([]);
  result.memories[0].content = 'changed';
  expect(memory.content).toBe('Owner-visible preference.');
});

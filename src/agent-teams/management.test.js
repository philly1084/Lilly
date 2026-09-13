'use strict';

const { createTeam, command, agentContext } = require('./domain');
const { workroomSnapshot } = require('./presentation');
const now = '2026-09-07T00:00:00.000Z';
function fixture() {
  const team = createTeam('owner', { name: 'Team', objective: 'Build durable outputs.' }, now);
  const agent = command(team, {}, 'create_agent', { name: 'Builder', persona: 'Careful', job: 'Build artifacts' }, now);
  return { team, agent };
}

test('profile edits preserve identity, private memory, stopped state and active task', () => {
  const { team, agent } = fixture();
  const original = structuredClone(agent);
  const task = command(team, {}, 'assign_task', { agentId: agent.id, title: 'Build', instruction: 'Write artifact' }, now);
  task.status = 'running';
  task.worker = { id: 'worker', claimId: 'claim' };
  agent.enabled = false;
  agent.engineSession = { sessionId: 'upstream-session' };
  command(team, {}, 'remember', { agentId: agent.id, scope: 'private', content: 'Prefer checked outputs.', source: 'Owner' }, now);
  command(team, {}, 'update_agent', { agentId: agent.id, name: 'Mira', persona: 'Practical', job: 'Verify and build' }, now);
  expect(agent).toMatchObject({ id: original.id, sessionId: original.sessionId, computerId: original.computerId,
    role: original.role, enabled: false, name: 'Mira', persona: 'Practical', job: 'Verify and build',
    engineSession: { sessionId: 'upstream-session' }, updatedAt: now });
  expect(task).toMatchObject({ status: 'running', instruction: 'Write artifact', worker: { id: 'worker', claimId: 'claim' } });
  expect(team.execution.enabled).toBe(false);
  expect(agentContext(team, agent.id).memories[0].content).toBe('Prefer checked outputs.');
  expect(workroomSnapshot(team).events.at(-1).type).toBe('agent.updated');
});

test.each(['role', 'enabled', 'sessionId', 'computerId', 'engineSession', 'ownerId'])('profile editing rejects identity or authority field %s', (key) => {
  const { team, agent } = fixture();
  const before = structuredClone(agent);
  expect(() => command(team, {}, 'update_agent', { agentId: agent.id, name: 'Changed', [key]: 'injected' }, now)).toThrow('Only teammate profile');
  expect(agent).toEqual(before);
});

test('workers cannot edit profiles, even their own or as coordinator', () => {
  const { team, agent } = fixture();
  agent.role = 'coordinator';
  expect(() => command(team, { agentId: agent.id }, 'update_agent', { agentId: agent.id, name: 'New' }, now))
    .toThrow('requires the team owner');
});

test('profile validation is atomic and optional persona can be cleared', () => {
  const { team, agent } = fixture();
  const before = structuredClone(agent);
  expect(() => command(team, {}, 'update_agent', { agentId: agent.id, name: 'New', job: ' ' }, now)).toThrow();
  expect(agent).toEqual(before);
  expect(() => command(team, {}, 'update_agent', { agentId: agent.id }, now)).toThrow('Choose a teammate');
  command(team, {}, 'update_agent', { agentId: agent.id, persona: '' }, now);
  expect(agent.persona).toBe('');
  expect(agent.job).toBe(before.job);
});

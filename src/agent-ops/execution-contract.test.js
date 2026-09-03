'use strict';

const { buildCompanyExecutionGuide, getCompanyExecutionFailure, getCompanyRemoteExecution, createCompanySessionView } = require('./execution-contract');

test('resumes only its own workload and goal cursor', () => {
  const workload = { id: 'w1', metadata: { agentCompany: { companyGoalHash: 'g1' } } };
  const companyRemoteExecution = getCompanyRemoteExecution({ toolEvents: [{ toolId: 'remote-cli-agent', result: { success: true, data: {
    targetId: 'k3s-secondary', remoteCodeJobId: 'job1', sessionId: 'session1', cwd: '/opt/kimibuilt', completionStatus: 'running',
  } } }] }, workload);
  const context = { workloadId: 'w1', companyGoalHash: 'g1', companyRemoteExecution };
  expect(createCompanySessionView({}, context).controlState.remoteCliAgent.remoteCodeJobId).toBe('job1');
  expect(createCompanySessionView({}, { ...context, workloadId: 'w2' }).controlState).toEqual({});
  expect(createCompanySessionView({}, { ...context, companyGoalHash: 'g2' }).controlState).toEqual({});
});

test('shares the company transcript without inheriting another goal CLI cursor', () => {
  const session = { id: 'shared', ownerId: 'owner', previousResponseId: 'old', controlState: { activeTaskFrame: { objective: 'old goal' } }, metadata: {
    ownerId: 'owner', remoteCliAgent: { cwd: '/opt/old' }, activeProject: { publicHost: 'old.test' },
  } };
  const view = createCompanySessionView(session);
  expect(view).toMatchObject({ id: 'shared', ownerId: 'owner', previousResponseId: null, controlState: {}, metadata: { ownerId: 'owner' } });
  expect(view.metadata.remoteCliAgent).toBeUndefined();
  expect(view.metadata.activeProject).toBeUndefined();
  expect(session.metadata.remoteCliAgent.cwd).toBe('/opt/old');
});

test('gives each run the live registered tool map without granting capabilities', () => {
  const guide = buildCompanyExecutionGuide({
    toolManager: { getTool: (id) => ['remote-cli-agent', 'tool-doc-read'].includes(id) },
    model: 'gpt-5.6-luna', reasoningEffort: 'high', metadata: { workloadId: 'w1', runId: 'r1' },
  });
  expect(guide).toContain('AgentCompanyExecution/v1');
  expect(guide).toContain('gpt-5.6-luna; reasoning effort: high');
  expect(guide).toContain('- remote-cli-agent:');
  expect(guide).not.toContain('- remote-command:');
  expect(guide).toContain('Side effects approved by workload policy: false');
  expect(guide).toContain('jobId/sessionId');
});

test.each([
  { outputText: 'remote-cli-agent failed: Requested cwd is outside target allowed roots' },
  { outputText: 'Remote CLI task is blocked. Workspace: /opt/app' },
  { outputText: 'Overall goal complete', toolEvents: [{ toolId: 'remote-cli-agent', result: { success: true, data: { completionStatus: 'blocked', blocker: 'No verification' } } }] },
])('does not accept a failed tool as company success', (result) => {
  expect(getCompanyExecutionFailure(result)).toBeTruthy();
});

test('allows a verified recovery of the same tool', () => {
  expect(getCompanyExecutionFailure({ toolEvents: [
    { toolId: 'remote-cli-agent', result: { success: false, error: 'temporary' } },
    { toolId: 'remote-cli-agent', result: { success: true, data: { completionStatus: 'complete' } } },
  ] })).toBe('');
});

'use strict';

const { loadCollaborationContext, MAX_CONTEXT_CHARS } = require('./collaboration-context');

function fixture() {
  const workload = {
    id: 'builder-job', sessionId: 'project', title: 'Build the app',
    metadata: { agentCompany: { enabled: true, companyGoalHash: 'goal', roleName: 'Builder' } },
  };
  return {
    sessionId: 'project', ownerId: 'owner',
    metadata: { agentCompanyRun: true, companyGoalHash: 'goal', companyRoleId: 'reviewer', workloadId: 'review-job', runId: 'current' },
    sessionStore: { listMessages: jest.fn(async () => []) },
    workloadService: {
      listSessionWorkloads: jest.fn(async () => [workload]),
      listRunsForWorkload: jest.fn(async () => [{
        id: 'build-run', workloadId: 'builder-job', status: 'completed',
        metadata: { output: { text: 'Built the app; please verify.', artifacts: [{ id: 'artifact', filename: 'app.js' }] } },
      }]),
    },
  };
}

test('loads owned project results with artifacts without transferring execution state', async () => {
  const input = fixture();
  const context = await loadCollaborationContext(input);
  expect(input.sessionStore.listMessages).toHaveBeenCalledWith('project', 120, 'owner');
  expect(input.workloadService.listSessionWorkloads).toHaveBeenCalledWith('project', 'owner');
  expect(input.workloadService.listRunsForWorkload).toHaveBeenCalledWith('builder-job', 'owner', 3);
  expect(context).toContain('Built the app; please verify.');
  expect(context).toContain('/api/artifacts/artifact/download');
  expect(context).toContain('claims');
});

test('delivers shared notes and matching instructions, excluding other agents, jobs and goals', async () => {
  const input = fixture();
  input.sessionStore.listMessages.mockResolvedValue([
    { content: 'Shared correction', metadata: { kind: 'agent-whiteboard-note', companyGoalHash: 'goal' } },
    { content: 'Review correction', metadata: { kind: 'agent-operator-input', targetAgentId: 'reviewer', targetWorkloadId: 'review-job' } },
    { content: 'Other agent', metadata: { kind: 'agent-whiteboard-note', targetAgentId: 'builder' } },
    { content: 'Other job', metadata: { kind: 'agent-operator-input', targetWorkloadId: 'other' } },
    { content: 'Old goal', metadata: { kind: 'agent-whiteboard-note', companyGoalHash: 'old' } },
    { content: 'Arbitrary transcript', metadata: {} },
  ]);
  const context = await loadCollaborationContext(input);
  expect(context).toContain('Shared correction');
  expect(context).toContain('Review correction');
  for (const excluded of ['Other agent', 'Other job', 'Old goal', 'Arbitrary transcript']) expect(context).not.toContain(excluded);
});

test('does not load runs belonging to another project or goal', async () => {
  const input = fixture();
  input.workloadService.listSessionWorkloads.mockResolvedValue([
    { id: 'foreign', sessionId: 'other', metadata: { agentCompany: { enabled: true, companyGoalHash: 'goal' } } },
    { id: 'stale', sessionId: 'project', metadata: { agentCompany: { enabled: true, companyGoalHash: 'old' } } },
  ]);
  expect(await loadCollaborationContext(input)).toBe('');
  expect(input.workloadService.listRunsForWorkload).not.toHaveBeenCalled();
});

test('retains pending status without exposing the remote cursor', async () => {
  const input = fixture();
  input.workloadService.listRunsForWorkload.mockResolvedValue([{
    id: 'build-run', workloadId: 'builder-job', status: 'completed',
    metadata: { output: { text: 'Build is underway', remoteExecution: { completionStatus: 'running', remoteCodeJobId: 'private-cursor' } } },
  }]);
  const context = await loadCollaborationContext(input);
  expect(context).toContain('not a completed goal');
  expect(context).toContain('"status":"running"');
  expect(context).not.toContain('private-cursor');
});

test('bounds the packet while keeping it valid JSON', async () => {
  const input = fixture();
  input.sessionStore.listMessages.mockResolvedValue(Array.from({ length: 120 }, (_, id) => ({
    id: String(id), content: '"'.repeat(4000), metadata: { kind: 'agent-whiteboard-note' },
  })));
  const context = await loadCollaborationContext(input);
  const packet = context.split('\n').at(-1);
  expect(packet.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  expect(JSON.parse(packet).notes.at(-1).id).toBe('119');
});

test('leaves ordinary chat untouched and propagates failed collaboration reads', async () => {
  const input = fixture();
  expect(await loadCollaborationContext({ ...input, metadata: {} })).toBe('');
  expect(input.sessionStore.listMessages).not.toHaveBeenCalled();
  input.sessionStore.listMessages.mockRejectedValue(new Error('storage unavailable'));
  await expect(loadCollaborationContext(input)).rejects.toThrow('storage unavailable');
});

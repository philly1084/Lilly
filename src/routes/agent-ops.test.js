'use strict';

const express = require('express');
const request = require('supertest');
const { createAgentOpsRouter } = require('./agent-ops');

function buildApp(service, user = { username: 'admin', role: 'admin' }) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use('/api/admin/agent-ops', createAgentOpsRouter({ service }));
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: { message: error.message } });
  });
  return app;
}

describe('/api/admin/agent-ops', () => {
  test('returns the injected overview contract to an authenticated admin', async () => {
    const overview = {
      generatedAt: '2026-08-30T13:00:00.000Z',
      project: { id: 'alpha' },
      heartbeat: { status: 'steady' },
      budget: { unit: 'tokens' },
      groups: { needsInput: [], working: [], idle: [] },
      selectedAgentId: null,
      goalItems: [],
      capabilities: { stream: false },
    };
    const service = { getOverview: jest.fn(async () => overview) };

    const response = await request(buildApp(service)).get('/api/admin/agent-ops/overview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(overview);
    expect(service.getOverview).toHaveBeenCalledTimes(1);
  });

  test('returns an agent activity timeline', async () => {
    const service = {
      getAgentActivity: jest.fn(async (agentId) => ({
        agentId,
        generatedAt: '2026-08-30T13:00:00.000Z',
        timeline: [{ id: 'event-1', type: 'run.started' }],
      })),
    };

    const response = await request(buildApp(service))
      .get('/api/admin/agent-ops/agents/research/activity');

    expect(response.status).toBe(200);
    expect(response.body.timeline).toHaveLength(1);
    expect(service.getAgentActivity).toHaveBeenCalledWith('research');
  });

  test('returns the recorded workspace panels for an agent', async () => {
    const service = {
      getAgentWorkspace: jest.fn(async (agentId) => ({
        agentId,
        files: [{ name: 'report.md' }],
        terminal: [{ command: 'run.completed' }],
      })),
    };

    const response = await request(buildApp(service))
      .get('/api/admin/agent-ops/agents/research/workspace');

    expect(response.status).toBe(200);
    expect(response.body.files).toEqual([{ name: 'report.md' }]);
    expect(service.getAgentWorkspace).toHaveBeenCalledWith('research');
  });

  test('queues an operator instruction for the selected agent', async () => {
    const service = {
      sendAgentInput: jest.fn(async () => ({
        accepted: true,
        agentId: 'research',
        runId: 'run-input-1',
        status: 'queued',
      })),
    };

    const response = await request(buildApp(service))
      .post('/api/admin/agent-ops/agents/research/input')
      .send({ message: 'Check the shared board and continue the existing run.' });

    expect(response.status).toBe(202);
    expect(service.sendAgentInput).toHaveBeenCalledWith(
      'research',
      { message: 'Check the shared board and continue the existing run.' },
      'admin',
    );
    expect(response.body.runId).toBe('run-input-1');
  });

  test('stops and restarts an existing agent through the lifecycle adapter', async () => {
    const service = {
      controlAgent: jest.fn(async (agentId, input) => ({
        agentId,
        action: input.action,
        workloadId: 'work-research',
        status: input.action === 'stop' ? 'stopped' : 'queued',
      })),
    };
    const app = buildApp(service);

    const stopped = await request(app)
      .post('/api/admin/agent-ops/agents/research/control')
      .send({ action: 'stop' });
    const restarted = await request(app)
      .post('/api/admin/agent-ops/agents/research/control')
      .send({ action: 'restart' });

    expect(stopped.status).toBe(202);
    expect(restarted.status).toBe(202);
    expect(service.controlAgent).toHaveBeenNthCalledWith(1, 'research', { action: 'stop' }, 'admin');
    expect(service.controlAgent).toHaveBeenNthCalledWith(2, 'research', { action: 'restart' }, 'admin');
    expect(stopped.body.status).toBe('stopped');
    expect(restarted.body.status).toBe('queued');
  });

  test('persists a shared whiteboard note and preserves the actor', async () => {
    const service = {
      createWhiteboardNote: jest.fn(async () => ({
        note: { id: 'note-1', column: 'waiting', content: 'Need public proof.' },
      })),
    };

    const response = await request(buildApp(service))
      .post('/api/admin/agent-ops/whiteboard/notes')
      .send({ column: 'waiting', content: 'Need public proof.', wakeCrew: true });

    expect(response.status).toBe(201);
    expect(service.createWhiteboardNote).toHaveBeenCalledWith({
      column: 'waiting',
      content: 'Need public proof.',
      wakeCrew: true,
    }, 'admin');
    expect(response.body.note.column).toBe('waiting');
  });

  test('creates a goal through the operations adapter and preserves the actor', async () => {
    const service = {
      createGoal: jest.fn(async () => ({
        title: 'Ship the release',
        projectId: 'main',
      })),
    };

    const response = await request(buildApp(service))
      .post('/api/admin/agent-ops/goals')
      .send({ title: 'Ship the release', successCriteria: 'Public proof passes.' });

    expect(response.status).toBe(201);
    expect(service.createGoal).toHaveBeenCalledWith({
      title: 'Ship the release',
      successCriteria: 'Public proof passes.',
    }, 'admin');
    expect(response.body.projectId).toBe('main');
  });

  test('creates, activates, and deletes operations projects through the lifecycle adapter', async () => {
    const service = {
      createProject: jest.fn(async () => ({ project: { id: 'launch', name: 'Launch' } })),
      activateProject: jest.fn(async () => ({ project: { id: 'launch' } })),
      deleteProject: jest.fn(async () => ({ deletedProjectId: 'launch', remainingProjectCount: 0 })),
    };
    const app = buildApp(service);

    const created = await request(app)
      .post('/api/admin/agent-ops/projects')
      .send({ name: 'Launch', companyGoal: 'Ship it.' });
    const activated = await request(app)
      .post('/api/admin/agent-ops/projects/launch/activate');
    const deleted = await request(app)
      .delete('/api/admin/agent-ops/projects/launch');

    expect(created.status).toBe(201);
    expect(service.createProject).toHaveBeenCalledWith({ name: 'Launch', companyGoal: 'Ship it.' }, 'admin');
    expect(activated.status).toBe(200);
    expect(service.activateProject).toHaveBeenCalledWith('launch');
    expect(deleted.status).toBe(200);
    expect(service.deleteProject).toHaveBeenCalledWith('launch');
  });

  test('deletes a scoped project file through the artifact lifecycle adapter', async () => {
    const service = {
      deleteArtifact: jest.fn(async () => ({
        deletedArtifactId: 'artifact-1',
        filename: 'report.md',
        projectId: 'main',
      })),
    };

    const response = await request(buildApp(service))
      .delete('/api/admin/agent-ops/artifacts/artifact-1');

    expect(response.status).toBe(200);
    expect(service.deleteArtifact).toHaveBeenCalledWith('artifact-1');
    expect(response.body.filename).toBe('report.md');
  });

  test('passes approval decisions and the authenticated actor to the adapter', async () => {
    const service = {
      resolveApproval: jest.fn(async () => ({
        approvalId: 'approval-1',
        decision: 'approve',
        status: 'approved',
      })),
    };

    const response = await request(buildApp(service))
      .post('/api/admin/agent-ops/approvals/approval-1/resolve')
      .send({ decision: 'approve' });

    expect(response.status).toBe(200);
    expect(service.resolveApproval).toHaveBeenCalledWith('approval-1', 'approve', 'admin');
    expect(response.body.status).toBe('approved');
  });

  test('preserves an honest unsupported-rejection response', async () => {
    const error = new Error('Reject is not supported.');
    error.statusCode = 501;
    error.code = 'approval_rejection_unsupported';
    const service = { resolveApproval: jest.fn(async () => { throw error; }) };

    const response = await request(buildApp(service))
      .post('/api/admin/agent-ops/approvals/approval-1/resolve')
      .send({ decision: 'reject' });

    expect(response.status).toBe(501);
    expect(response.body.error).toEqual({
      type: 'agent_ops_error',
      code: 'approval_rejection_unsupported',
      message: 'Reject is not supported.',
    });
  });

  test('rejects missing or non-admin authentication contexts', async () => {
    const service = { getOverview: jest.fn() };

    const missing = await request(buildApp(service, null)).get('/api/admin/agent-ops/overview');
    const frontend = await request(buildApp(service, { username: 'frontend', role: 'frontend-api' }))
      .get('/api/admin/agent-ops/overview');

    expect(missing.status).toBe(401);
    expect(frontend.status).toBe(403);
    expect(service.getOverview).not.toHaveBeenCalled();
  });
});

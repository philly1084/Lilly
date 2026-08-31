'use strict';

const { AgentOpsService } = require('./service');

function buildFixture() {
  const companyStatus = {
    available: true,
    config: {
      enabled: true,
      sessionId: 'agent-company-alpha',
      activeProjectId: 'alpha',
      companyGoal: 'Ship a verified command center.',
      heartbeatMinutes: 15,
      projects: [{
        id: 'alpha',
        name: 'Alpha command center',
        sessionId: 'agent-company-alpha',
        companyGoal: 'Ship a verified command center.',
      }],
      roles: [
        { id: 'research', name: 'Research Agent', mission: 'Find current evidence.' },
        { id: 'builder', name: 'Builder Agent', mission: 'Build the product.' },
        { id: 'review', name: 'Review Agent', mission: 'Review outputs.' },
      ],
    },
    state: {
      companyGoal: 'Ship a verified command center.',
      companyGoalHash: 'goal-alpha',
      heartbeat: {
        status: 'steady',
        lastAt: '2026-08-30T12:59:30.000Z',
        nextAt: '2026-08-30T13:14:30.000Z',
        reason: 'timer',
      },
      shortTermSchedule: [
        {
          id: 'plan-research',
          title: 'Research agent systems',
          roleName: 'Research Agent',
          plannedFor: '2026-08-30T13:15:00.000Z',
        },
        {
          id: 'plan-builder',
          title: 'Build command center',
          roleName: 'Builder Agent',
          plannedFor: '2026-08-30T14:15:00.000Z',
        },
      ],
    },
  };
  const workloads = [
    {
      id: 'work-research',
      sessionId: 'agent-company-alpha',
      title: 'Research Agent: Research agent systems',
      enabled: true,
      createdAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:58:00.000Z',
      metadata: {
        requestedModel: 'model-research',
        agentCompany: {
          enabled: true,
          companyGoalHash: 'goal-alpha',
          planItemId: 'plan-research',
          roleId: 'research',
          roleName: 'Research Agent',
        },
      },
    },
    {
      id: 'work-builder',
      sessionId: 'agent-company-alpha',
      title: 'Builder Agent: Build command center',
      enabled: true,
      createdAt: '2026-08-30T12:10:00.000Z',
      updatedAt: '2026-08-30T12:59:00.000Z',
      metadata: {
        requestedModel: 'model-builder',
        agentCompany: {
          enabled: true,
          companyGoalHash: 'goal-alpha',
          planItemId: 'plan-builder',
          roleId: 'builder',
          roleName: 'Builder Agent',
        },
      },
    },
  ];
  const workloadRuns = [
    {
      id: 'work-run-research',
      workloadId: 'work-research',
      status: 'completed',
      startedAt: '2026-08-30T12:20:00.000Z',
      finishedAt: '2026-08-30T12:40:00.000Z',
      createdAt: '2026-08-30T12:19:00.000Z',
      updatedAt: '2026-08-30T12:40:00.000Z',
      metadata: {
        output: {
          artifactMessage: 'Research brief created.',
          artifacts: [{ id: 'artifact-research', filename: 'research.md' }],
        },
      },
    },
    {
      id: 'work-run-builder',
      workloadId: 'work-builder',
      status: 'running',
      startedAt: '2026-08-30T12:50:00.000Z',
      createdAt: '2026-08-30T12:49:00.000Z',
      updatedAt: '2026-08-30T12:59:00.000Z',
      metadata: {},
    },
  ];
  const canonicalRuns = [
    {
      id: 'agent-run-research',
      ownerId: 'system',
      sessionId: 'agent-company-alpha',
      surface: 'workload',
      state: 'completed',
      createdAt: '2026-08-30T12:20:00.000Z',
      updatedAt: '2026-08-30T12:40:00.000Z',
      snapshot: { sourceId: 'work-run-research' },
      approvals: [],
      evidence: [{ id: 'source-1', title: 'Verified source', status: 'passed' }],
      outputs: [{ id: 'artifact-research', filename: 'research.md' }],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      budget: { maxTokens: 500 },
    },
    {
      id: 'agent-run-builder',
      ownerId: 'system',
      sessionId: 'agent-company-alpha',
      surface: 'workload',
      state: 'waiting_for_approval',
      createdAt: '2026-08-30T12:50:00.000Z',
      updatedAt: '2026-08-30T12:59:00.000Z',
      snapshot: {
        sourceId: 'work-run-builder',
        pause: { approvalId: 'approval-builder' },
      },
      approvals: [{
        id: 'approval-builder',
        status: 'pending',
        reason: 'Allow a scoped deployment.',
      }],
      evidence: [],
      outputs: [],
      usage: { inputTokens: 25, outputTokens: 5 },
      budget: { max_tokens: 100 },
    },
  ];
  return { companyStatus, workloads, workloadRuns, canonicalRuns };
}

function buildService() {
  const fixture = buildFixture();
  const performAction = jest.fn(async (runId) => ({
    run: {
      ...fixture.canonicalRuns.find((run) => run.id === runId),
      state: 'executing',
      approvals: [{ id: 'approval-builder', status: 'approved' }],
    },
  }));
  const agentRunService = {
    store: {
      listRuns: jest.fn(async () => fixture.canonicalRuns),
    },
    getRun: jest.fn(async (id) => fixture.canonicalRuns.find((run) => run.id === id) || null),
    listEvents: jest.fn(async (id) => [{
      eventId: `${id}:1`,
      cursor: 1,
      type: 'run.created',
      status: 'created',
      timestamp: '2026-08-30T12:20:00.000Z',
      payload: { message: 'Run created.' },
    }]),
    performAction,
  };
  const service = new AgentOpsService({
    agentCompanyService: {
      getStatus: jest.fn(async () => fixture.companyStatus),
    },
    workloadService: {
      isAvailable: jest.fn(() => true),
      listAdminWorkloads: jest.fn(async () => fixture.workloads),
      listAdminRuns: jest.fn(async () => fixture.workloadRuns),
    },
    agentRunService,
    artifactStore: {
      listBySession: jest.fn(async () => [{
        id: 'artifact-research',
        sessionId: 'agent-company-alpha',
        filename: 'research.md',
        createdAt: '2026-08-30T12:40:00.000Z',
        metadata: { workloadId: 'work-research', runId: 'work-run-research' },
      }]),
    },
    now: () => new Date('2026-08-30T13:00:00.000Z'),
  });
  return { service, fixture, agentRunService, performAction };
}

describe('AgentOpsService', () => {
  test('adapts company, workload, AgentRun, approval, goal, and budget records into the overview', async () => {
    const { service } = buildService();

    const overview = await service.getOverview();

    expect(overview).toMatchObject({
      generatedAt: '2026-08-30T13:00:00.000Z',
      project: {
        id: 'alpha',
        name: 'Alpha command center',
        goal: 'Ship a verified command center.',
        progress: 50,
        status: 'needs_input',
      },
      heartbeat: {
        status: 'steady',
        ageSeconds: 30,
        intervalSeconds: 900,
      },
      budget: {
        unit: 'tokens',
        inputTokens: 125,
        outputTokens: 55,
        usedTokens: 180,
        limitTokens: 600,
        remainingTokens: 420,
        utilizationPercent: 30,
        source: 'agent-runs',
      },
      selectedAgentId: 'builder',
      capabilities: {
        activity: true,
        approvals: true,
        approvalDecisions: ['approve'],
        resourceMetrics: false,
        stream: false,
      },
    });
    expect(overview.groups.needsInput).toEqual([
      expect.objectContaining({
        id: 'builder',
        model: 'model-builder',
        cpuPercent: null,
        memoryLabel: 'Not reported',
        needsApproval: true,
      }),
    ]);
    expect(overview.groups.idle).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'research', runId: 'agent-run-research' }),
      expect.objectContaining({ id: 'review', workloadId: null }),
    ]));
    expect(overview.goalItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'plan-research',
        status: 'completed',
        evidence: expect.arrayContaining([
          expect.objectContaining({ id: 'source-1', label: 'Verified source' }),
        ]),
      }),
      expect.objectContaining({
        id: 'plan-builder',
        status: 'needs_input',
        blockedBy: 'Allow a scoped deployment.',
      }),
    ]));
  });

  test('returns a deterministic append-only activity timeline from workload, canonical, evidence, and artifact records', async () => {
    const { service, agentRunService } = buildService();

    const response = await service.getAgentActivity('research');

    expect(response.agentId).toBe('research');
    expect(response.timeline.map((event) => event.type)).toEqual(expect.arrayContaining([
      'workload.created',
      'run.queued',
      'run.started',
      'run.completed',
      'run.created',
      'run.evidence_recorded',
      'artifact.created',
    ]));
    expect(response.timeline).toEqual([...response.timeline].sort((left, right) => (
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
      || left.id.localeCompare(right.id)
    )));
    expect(agentRunService.listEvents).toHaveBeenCalledWith('agent-run-research', 0, 'system');
  });

  test('approves a pending approval only through the existing AgentRun resume action', async () => {
    const { service, performAction } = buildService();

    const result = await service.resolveApproval('approval-builder', 'approve', 'admin');

    expect(result).toMatchObject({
      approvalId: 'approval-builder',
      decision: 'approve',
      status: 'approved',
      run: { id: 'agent-run-builder', state: 'executing' },
    });
    expect(performAction).toHaveBeenCalledWith(
      'agent-run-builder',
      expect.objectContaining({
        action: 'resume',
        approval: { id: 'approval-builder', status: 'approved' },
        idempotencyKey: 'agent-ops:approval-builder:approve',
      }),
      'system',
    );
  });

  test('fails honestly when rejection has no safe underlying AgentRun transition', async () => {
    const { service, performAction } = buildService();

    await expect(service.resolveApproval('approval-builder', 'reject', 'admin')).rejects.toMatchObject({
      statusCode: 501,
      code: 'approval_rejection_unsupported',
    });
    expect(performAction).not.toHaveBeenCalled();
  });
});

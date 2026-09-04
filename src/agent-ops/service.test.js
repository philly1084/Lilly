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
      ownerId: 'system',
      sessionId: 'agent-company-alpha',
      title: 'Research Agent: Research agent systems',
      prompt: 'Original research prompt.',
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
          sharedWhiteboard: { path: '.kimibuilt/agent-company/2026-W35-whiteboard.md' },
        },
      },
    },
    {
      id: 'work-builder',
      ownerId: 'system',
      sessionId: 'agent-company-alpha',
      title: 'Builder Agent: Build command center',
      prompt: 'Original builder prompt.',
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
  const storedArtifact = {
    id: 'artifact-research',
    sessionId: 'agent-company-alpha',
    filename: 'research.md',
    mimeType: 'text/markdown',
    sizeBytes: 512,
    extractedText: '# Verified research\nThe evidence is current.',
    createdAt: '2026-08-30T12:40:00.000Z',
    metadata: { workloadId: 'work-research', runId: 'work-run-research' },
  };
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
  const updateAgentCompanySettings = jest.fn(async (config) => config);
  const tick = jest.fn(async () => ({
    state: { heartbeat: { status: 'steady', reason: 'agent-ops-goal:admin' } },
  }));
  const deleteArtifact = jest.fn(async () => true);
  const deleteArtifactsForSession = jest.fn(async () => 1);
  const getSessionSummaries = jest.fn(async () => ({
    'agent-company-alpha': { queued: 0, running: 0 },
  }));
  const sessionMessages = [];
  const appendMessages = jest.fn(async (_sessionId, messages) => {
    sessionMessages.push(...messages);
    return { id: 'agent-company-alpha' };
  });
  const runWorkloadNow = jest.fn(async () => ({ id: 'operator-run-1', status: 'queued' }));
  const resumeAdminWorkload = jest.fn(async (id) => fixture.workloads.find((workload) => workload.id === id));
  const artifactStore = {
    listBySession: jest.fn(async () => [storedArtifact]),
    get: jest.fn(async (id) => (id === storedArtifact.id ? storedArtifact : null)),
  };
  const service = new AgentOpsService({
    agentCompanyService: {
      getStatus: jest.fn(async () => fixture.companyStatus),
      settingsController: {
        getEffectiveAgentCompanyConfig: jest.fn(() => fixture.companyStatus.config),
        updateAgentCompanySettings,
      },
      tick,
    },
    workloadService: {
      isAvailable: jest.fn(() => true),
      listAdminWorkloads: jest.fn(async () => fixture.workloads),
      listAdminRuns: jest.fn(async () => fixture.workloadRuns),
      getSessionSummaries,
      runWorkloadNow,
      resumeAdminWorkload,
    },
    agentRunService,
    sessionStore: {
      getRecentMessages: jest.fn(async () => sessionMessages),
      appendMessages,
    },
    artifactStore,
    artifactService: { deleteArtifact, deleteArtifactsForSession },
    now: () => new Date('2026-08-30T13:00:00.000Z'),
  });
  return {
    service,
    fixture,
    agentRunService,
    performAction,
    updateAgentCompanySettings,
    tick,
    artifactStore,
    deleteArtifact,
    deleteArtifactsForSession,
    getSessionSummaries,
    sessionMessages,
    appendMessages,
    runWorkloadNow,
    resumeAdminWorkload,
  };
}

describe('AgentOpsService', () => {
  test('shows tool-owned pending work instead of canonical stage completion in every overview status', async () => {
    const { service, fixture } = buildService();
    fixture.workloadRuns[0].metadata.output.remoteExecution = { completionStatus: 'running', remoteCodeJobId: 'job1' };
    const overview = await service.getOverview();
    expect(overview.groups.working).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'research', currentAction: expect.stringContaining('Working on'), remoteExecution: expect.objectContaining({ remoteCodeJobId: 'job1' }) })]));
    expect(overview.goalItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'plan-research', status: 'working' })]));
    expect(overview.workflows).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'work-research', status: 'running' })]));
    expect(overview.project.progress).toBe(0);
  });

  test('exposes automatic stage exhaustion as continuation needed without pretending the remote job stopped', async () => {
    const { service, fixture } = buildService();
    fixture.workloadRuns[0].metadata.output.remoteExecution = { completionStatus: 'running', remoteCodeJobId: 'job1' };
    fixture.workloads[0].metadata.longAgent = { lastDecision: { runId: 'work-run-research', decision: 'stop_max_steps' } };
    const overview = await service.getOverview();
    expect(overview.groups.needsInput).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'research', needsApproval: false, currentAction: expect.stringContaining('Continuation needed') })]));
    expect(overview.goalItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'plan-research', status: 'needs_input', blockedBy: expect.stringContaining('stage limit reached') })]));
    expect(overview.workflows).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'work-research', status: 'paused' })]));
  });

  test('ignores stale workload decisions and remote cursors when showing a later completed run', async () => {
    const { service, fixture } = buildService();
    fixture.workloads[0].metadata.companyRemoteExecution = { state: { completionStatus: 'running', remoteCodeJobId: 'stale-job' } };
    fixture.workloads[0].metadata.longAgent = { lastDecision: { runId: 'earlier-run', decision: 'stop_max_steps' } };
    fixture.workloadRuns[0].metadata.output.remoteExecution = { completionStatus: 'complete', remoteCodeJobId: 'current-job' };
    const overview = await service.getOverview();
    expect(overview.goalItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'plan-research', status: 'completed' })]));
    expect(overview.groups.idle).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'research' })]));
  });

  test('does not let a canonical completed stage override failed or review-needed workload evidence', () => {
    const { service } = buildService();
    expect(service.deriveAgentStatus({ status: 'running' }, { state: 'blocked' })).toBe('needs_input');
    expect(service.resolveWorkloadExecutionStatus({}, { status: 'failed' }, { state: 'completed' })).toBe('failed');
    expect(service.resolveWorkloadExecutionStatus({ metadata: { longAgent: { lastDecision: { runId: 'r1', decision: 'review' } } } }, { id: 'r1', status: 'completed' }, { state: 'completed' })).toBe('blocked');
    expect(service.resolveWorkloadExecutionStatus({}, { status: 'completed', metadata: { output: { remoteExecution: { completionStatus: 'blocked' } } } }, { state: 'completed' })).toBe('blocked');
  });

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
        goalCreation: { enabled: true, endpoint: '/goals' },
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
    ]));
    expect(overview.groups.idle).not.toEqual(expect.arrayContaining([
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

  test('returns useful files, editor content, run log, browser previews, artifacts, and messages', async () => {
    const { service } = buildService();

    const workspace = await service.getAgentWorkspace('research');

    expect(workspace).toMatchObject({
      agentId: 'research',
      files: [expect.objectContaining({ name: 'research.md' })],
      editor: [expect.objectContaining({
        name: 'research.md',
        language: 'markdown',
        content: expect.stringContaining('Verified research'),
      })],
    });
    expect(workspace.terminal).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'run.completed' }),
    ]));
    expect(workspace.browser).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/api/artifacts/artifact-research/preview' }),
    ]));
    expect(workspace.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'artifact-research' }),
    ]));
    expect(workspace.messages.length).toBeGreaterThan(0);
  });

  test('keeps agent browser captures private while projecting bounded browser signals', async () => {
    const { service, artifactStore } = buildService();
    artifactStore.listBySession.mockResolvedValue([
      {
        id: 'artifact-research',
        sessionId: 'agent-company-alpha',
        filename: 'research.md',
        mimeType: 'text/markdown',
        sizeBytes: 512,
        extractedText: '# Verified research',
        createdAt: '2026-08-30T12:40:00.000Z',
        metadata: { workloadId: 'work-research', runId: 'work-run-research' },
      },
      {
        id: 'private-browser-capture',
        sessionId: 'agent-company-alpha',
        filename: 'private-screen.png',
        mimeType: 'image/png',
        createdAt: '2026-08-30T12:55:00.000Z',
        metadata: {
          workloadId: 'work-research',
          browserCapture: true,
          privateAgentWorkspace: true,
          browserWorkspaceId: 'hashed-browser-workspace',
          sourceUrl: 'https://private.example.test/account',
          pageTitle: 'Private account page',
          viewport: { width: 1440, height: 960 },
        },
      },
    ]);

    const overview = await service.getOverview();
    const workspace = await service.getAgentWorkspace('research');

    expect(overview.artifacts.map((artifact) => artifact.id)).toEqual(['artifact-research']);
    expect(workspace.files.map((file) => file.id)).toEqual(['artifact-research']);
    expect(workspace.artifacts.map((artifact) => artifact.id)).not.toContain('private-browser-capture');
    expect(workspace.privateBrowser).toMatchObject({
      private: true,
      exposedToOperator: false,
      persistent: true,
      status: 'active',
      captureCount: 1,
      signals: [expect.objectContaining({
        title: 'Private account page',
        host: 'private.example.test',
      })],
    });
    expect(JSON.stringify(workspace.privateBrowser)).not.toContain('/account');
  });

  test('records operator input in the owned session and queues the same agent workload', async () => {
    const { service, appendMessages, runWorkloadNow } = buildService();

    const result = await service.sendAgentInput('research', {
      message: 'Use the current evidence and finish the next verification step.',
    }, 'admin');

    expect(result).toMatchObject({
      accepted: true,
      agentId: 'research',
      workloadId: 'work-research',
      sessionId: 'agent-company-alpha',
      runId: 'operator-run-1',
      status: 'queued',
    });
    expect(appendMessages).toHaveBeenCalledWith('agent-company-alpha', [expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('finish the next verification step'),
      metadata: expect.objectContaining({
        kind: 'agent-operator-input',
        targetAgentId: 'research',
        targetWorkloadId: 'work-research',
      }),
    })]);
    expect(runWorkloadNow).toHaveBeenCalledWith('work-research', 'system', expect.objectContaining({
      reason: 'agent-ops-input',
      prompt: expect.stringContaining('.kimibuilt/agent-company/2026-W35-whiteboard.md'),
      idempotencyKey: expect.stringMatching(/^agent-ops-input:/),
    }));
  });

  test('requires the explicit approval path before accepting a continuation instruction', async () => {
    const { service, appendMessages, runWorkloadNow } = buildService();

    await expect(service.sendAgentInput('builder', { message: 'Continue deployment.' }, 'admin'))
      .rejects.toMatchObject({ code: 'agent_input_requires_approval', statusCode: 409 });
    expect(appendMessages).not.toHaveBeenCalled();
    expect(runWorkloadNow).not.toHaveBeenCalled();
  });

  test('persists shared whiteboard notes and wakes the dedicated whiteboard heartbeat', async () => {
    const { service, appendMessages, tick } = buildService();

    const result = await service.createWhiteboardNote({
      column: 'waiting',
      content: 'Need public browser proof before promotion.',
      targetAgentId: 'builder',
      wakeCrew: true,
    }, 'admin');

    expect(result.note).toMatchObject({
      column: 'waiting',
      content: 'Need public browser proof before promotion.',
      author: 'admin',
      targetAgentId: 'builder',
    });
    expect(appendMessages).toHaveBeenCalledWith('agent-company-alpha', [expect.objectContaining({
      role: 'user',
      metadata: expect.objectContaining({ kind: 'agent-whiteboard-note', column: 'waiting' }),
    })]);
    expect(tick).toHaveBeenCalledWith({ force: true, reason: 'shared-whiteboard-refresh' });
  });

  test('surfaces a website handoff in overview and Messages without opening its HTML artifact', async () => {
    const { service, fixture } = buildService();
    fixture.workloadRuns[0].metadata.output.text = 'The website is built.\n[Open website](https://canada.demoserver2.buzz/).\nScreenshots still need review.';
    const overview = await service.getOverview();
    const workspace = await service.getAgentWorkspace('research');
    expect(overview.messages[0].message).toContain('The website is built.');
    expect(workspace.messages[0]).toEqual(overview.messages[0]);
    expect(workspace.messages[0].message).toContain('Screenshots still need review.');
    expect(workspace.browser[0]).toMatchObject({ url: 'https://canada.demoserver2.buzz/', detail: 'Link reported by agent' });
  });

  test('persists a new goal on the active project and immediately starts coordination', async () => {
    const { service, updateAgentCompanySettings, tick } = buildService();

    const result = await service.createGoal({
      title: 'Ship the live operations deck',
      successCriteria: 'Desktop and mobile proof pass.',
    }, 'admin');

    expect(updateAgentCompanySettings).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      companyGoal: expect.stringContaining('Ship the live operations deck'),
      projects: expect.arrayContaining([
        expect.objectContaining({
          id: 'alpha',
          enabled: true,
          companyGoal: expect.stringContaining('Desktop and mobile proof pass.'),
        }),
      ]),
    }));
    expect(tick).toHaveBeenCalledWith({ force: true, reason: 'agent-ops-goal:admin' });
    expect(result.projectId).toBe('alpha');
  });

  test('creates and activates a new project, starting its heartbeat when an objective is supplied', async () => {
    const { service, updateAgentCompanySettings, tick } = buildService();

    const result = await service.createProject({
      name: 'Launch readiness',
      companyGoal: 'Ship the verified launch.',
    }, 'admin');

    expect(result.project).toMatchObject({
      id: 'launch-readiness',
      name: 'Launch readiness',
      companyGoal: 'Ship the verified launch.',
      enabled: true,
    });
    expect(updateAgentCompanySettings).toHaveBeenCalledWith(expect.objectContaining({
      projectsInitialized: true,
      activeProjectId: 'launch-readiness',
      companyGoal: 'Ship the verified launch.',
      projects: expect.arrayContaining([expect.objectContaining({ id: 'alpha' }), expect.objectContaining({ id: 'launch-readiness' })]),
    }));
    expect(tick).toHaveBeenCalledWith({ force: true, reason: 'agent-ops-project:admin' });
  });

  test('deletes only an artifact belonging to the active project through full cleanup', async () => {
    const { service, deleteArtifact } = buildService();

    const result = await service.deleteArtifact('artifact-research');

    expect(deleteArtifact).toHaveBeenCalledWith('artifact-research');
    expect(result).toMatchObject({
      deletedArtifactId: 'artifact-research',
      filename: 'research.md',
      projectId: 'alpha',
    });
  });

  test('refuses to delete a file from another project', async () => {
    const { service, artifactStore, deleteArtifact } = buildService();
    artifactStore.get.mockResolvedValueOnce({ id: 'foreign', sessionId: 'agent-company-other', filename: 'foreign.md' });

    await expect(service.deleteArtifact('foreign')).rejects.toMatchObject({
      statusCode: 404,
      code: 'agent_artifact_not_found',
    });
    expect(deleteArtifact).not.toHaveBeenCalled();
  });

  test('removes the final project and its files while preserving an explicit empty project state', async () => {
    const { service, deleteArtifactsForSession, updateAgentCompanySettings } = buildService();

    const result = await service.deleteProject('alpha');

    expect(deleteArtifactsForSession).toHaveBeenCalledWith('agent-company-alpha');
    expect(updateAgentCompanySettings).toHaveBeenCalledWith(expect.objectContaining({
      projectsInitialized: true,
      projects: [],
      activeProjectId: '',
      companyGoal: '',
      enabled: false,
    }));
    expect(result).toMatchObject({ deletedProjectId: 'alpha', remainingProjectCount: 0, activeProjectId: null });
  });

  test('blocks project deletion while the project still has active runs', async () => {
    const { service, getSessionSummaries, deleteArtifactsForSession } = buildService();
    getSessionSummaries.mockResolvedValueOnce({ 'agent-company-alpha': { queued: 1, running: 1 } });

    await expect(service.deleteProject('alpha')).rejects.toMatchObject({
      statusCode: 409,
      code: 'agent_project_has_active_runs',
    });
    expect(deleteArtifactsForSession).not.toHaveBeenCalled();
  });

  test('returns a clean empty overview after the final project is removed', async () => {
    const { service, fixture } = buildService();
    fixture.companyStatus.config = {
      ...fixture.companyStatus.config,
      projectsInitialized: true,
      projects: [],
      activeProjectId: '',
      companyGoal: '',
      enabled: false,
      sessionId: 'agent-company-empty-test',
    };

    const overview = await service.getOverview();

    expect(overview.project).toMatchObject({ id: null, status: 'empty' });
    expect(overview.projects).toEqual([]);
    expect(overview.goalItems).toEqual([]);
    expect(overview.workflows).toEqual([]);
    expect(overview.artifacts).toEqual([]);
    expect(overview.capabilities.projects).toMatchObject({ enabled: true, collectionEndpoint: '/projects' });
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

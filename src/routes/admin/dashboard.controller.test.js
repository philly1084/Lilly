jest.mock('./logs.controller', () => ({
  addLog: jest.fn(),
}));

jest.mock('./traces.controller', () => ({
  addTrace: jest.fn(),
  traces: new Map(),
}));

jest.mock('../../memory/vector-store', () => ({
  vectorStore: {},
}));

jest.mock('../../agent-sdk/registry/UnifiedRegistry', () => ({
  getUnifiedRegistry: jest.fn(() => ({
    on: jest.fn(),
  })),
}));

const DashboardController = require('./dashboard.controller');
const tracesController = require('./traces.controller');
const logsController = require('./logs.controller');

describe('DashboardController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    logsController.logs = undefined;
  });

  test('reports success rate as unavailable when no tasks have completed', () => {
    const controller = new DashboardController(null);

    expect(controller.calculateSuccessRate()).toBeNull();
  });

  test('includes execution trace steps in the admin timeline', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-1',
      input: 'Use remote-build to inspect the cluster and keep going.',
      model: 'gpt-test',
      mode: 'chat',
      transport: 'http',
      metadata: {},
    });

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-1',
      output: 'Completed the obvious next server checks.',
      model: 'gpt-test',
      duration: 1200,
      metadata: {
        executionTrace: [
          {
            type: 'approval',
            name: 'Remote-build autonomy approved',
            status: 'completed',
            startTime: '2026-03-22T12:00:00.000Z',
            endTime: '2026-03-22T12:00:00.050Z',
            details: {
              approved: true,
              source: 'frontend',
            },
          },
          {
            type: 'planning',
            name: 'Plan round 1',
            status: 'completed',
            startTime: '2026-03-22T12:00:00.050Z',
            endTime: '2026-03-22T12:00:00.150Z',
            details: {
              round: 1,
              stepCount: 2,
            },
          },
        ],
        toolEvents: [
          {
            toolCall: {
              function: {
                name: 'ssh-execute',
                arguments: JSON.stringify({ command: 'hostname && uptime' }),
              },
            },
            result: {
              success: true,
              duration: 400,
            },
            reason: 'Inspect the remote host',
          },
        ],
      },
    });

    const trace = tracesController.addTrace.mock.calls[0][0];
    expect(trace.timeline.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'Remote-build autonomy approved',
      'Plan round 1',
      'Tool call (ssh-execute)',
      'Model response (gpt-test)',
    ]));
    expect(trace.timeline.find((entry) => entry.name === 'Remote-build autonomy approved')).toMatchObject({
      type: 'approval',
      details: expect.objectContaining({
        approved: true,
        source: 'frontend',
      }),
    });
  });

  test('prefers explicit tool and model trace timing over synthesized fallback entries', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-2',
      input: 'Debug the deployment timeline.',
      model: 'gpt-test',
      mode: 'chat',
      transport: 'http',
      metadata: {},
    });

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-2',
      output: 'Completed the trace review.',
      model: 'gpt-test',
      duration: 2200,
      metadata: {
        executionTrace: [
          {
            type: 'setup',
            name: 'Conversation setup',
            status: 'completed',
            startTime: '2026-03-22T12:00:00.000Z',
            endTime: '2026-03-22T12:00:20.000Z',
            details: {},
          },
          {
            type: 'planning',
            name: 'Plan round 1',
            status: 'completed',
            startTime: '2026-03-22T12:00:20.000Z',
            endTime: '2026-03-22T12:00:20.100Z',
            details: {},
          },
          {
            type: 'tool_call',
            name: 'Tool call (ssh-execute)',
            status: 'completed',
            startTime: '2026-03-22T12:00:20.100Z',
            endTime: '2026-03-22T12:00:21.100Z',
            details: {
              reason: 'Inspect the remote host',
              paramKeys: ['command'],
            },
          },
          {
            type: 'execution',
            name: 'Execution round 1',
            status: 'completed',
            startTime: '2026-03-22T12:00:21.100Z',
            endTime: '2026-03-22T12:00:21.150Z',
            details: {},
          },
          {
            type: 'model_call',
            name: 'Model response (gpt-test)',
            status: 'completed',
            startTime: '2026-03-22T12:00:21.150Z',
            endTime: '2026-03-22T12:00:22.000Z',
            details: {
              responseId: 'resp-2',
            },
          },
        ],
        toolEvents: [
          {
            toolCall: {
              function: {
                name: 'ssh-execute',
                arguments: JSON.stringify({ command: 'hostname && uptime' }),
              },
            },
            result: {
              success: true,
              duration: 1000,
              startedAt: '2026-03-22T12:00:20.100Z',
              endedAt: '2026-03-22T12:00:21.100Z',
            },
            reason: 'Inspect the remote host',
          },
        ],
      },
    });

    const trace = tracesController.addTrace.mock.calls[0][0];
    const timelineNames = trace.timeline.map((entry) => entry.name);

    expect(timelineNames.filter((name) => name === 'Tool call (ssh-execute)')).toHaveLength(1);
    expect(timelineNames.filter((name) => name === 'Model response (gpt-test)')).toHaveLength(1);
    expect(timelineNames.indexOf('Tool call (ssh-execute)')).toBeLessThan(timelineNames.indexOf('Execution round 1'));
    expect(timelineNames.indexOf('Execution round 1')).toBeLessThan(timelineNames.indexOf('Model response (gpt-test)'));
  });

  test('uses explicit usage metadata instead of estimating token counts', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-3',
      input: 'Inspect the deployment and summarize the result.',
      model: 'gpt-test',
      mode: 'chat',
      transport: 'http',
      metadata: {},
    });

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-3',
      output: 'Deployment checked.',
      model: 'gpt-test',
      duration: 900,
      metadata: {
        usage: {
          promptTokens: 125,
          completionTokens: 40,
          totalTokens: 165,
        },
      },
    });

    const completedTask = controller.taskStore.get(task.id);
    expect(completedTask.result.tokenUsage).toEqual({
      promptTokens: 125,
      completionTokens: 40,
      totalTokens: 165,
      inferred: false,
    });
  });

  test('preserves gateway total-only usage without zeroing the counted tokens', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-total-only',
      input: 'Gateway reported only total token usage.',
      model: 'gateway-model',
      mode: 'chat',
      transport: 'http',
      metadata: {},
    });

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-total-only',
      output: 'Done.',
      model: 'gateway-model',
      duration: 500,
      metadata: {
        usage: {
          total_token_usage: {
            total_tokens: 77,
          },
        },
      },
    });

    const completedTask = controller.taskStore.get(task.id);
    expect(completedTask.result.tokenUsage).toEqual({
      promptTokens: 0,
      completionTokens: 77,
      totalTokens: 77,
      inferred: false,
    });
    expect(logsController.addLog).toHaveBeenCalledWith(expect.objectContaining({
      tokens: 77,
      promptTokens: 0,
      completionTokens: 77,
      tokenUsageInferred: false,
    }));
  });

  test('preserves split cache usage details in admin logs', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-cache-usage',
      input: 'Summarize the cached project context.',
      model: 'gateway-model',
      mode: 'chat',
      transport: 'http',
      metadata: {},
    });

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-cache-usage',
      output: 'Cached context summarized.',
      model: 'gateway-model',
      duration: 650,
      metadata: {
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          input_tokens_details: {
            cache_read_input_tokens: 45,
            cache_creation_input_tokens: 12,
          },
        },
      },
    });

    const completedTask = controller.taskStore.get(task.id);
    expect(completedTask.result.tokenUsage).toEqual(expect.objectContaining({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedTokens: 57,
      cacheReadInputTokens: 45,
      cacheCreationInputTokens: 12,
      inferred: false,
    }));
    expect(logsController.addLog).toHaveBeenCalledWith(expect.objectContaining({
      cachedTokens: 57,
      cacheReadInputTokens: 45,
      cacheCreationInputTokens: 12,
      tokenUsageInferred: false,
    }));
  });

  test('keeps explicit zero-token runs at zero for tool-only responses', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-4',
      input: 'Run the scheduled workload directly.',
      model: 'gpt-test',
      mode: 'chat',
      transport: 'http',
      metadata: {},
    });

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-4',
      output: 'Daily blockers summary created.',
      model: 'gpt-test',
      duration: 250,
      metadata: {
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          modelCalls: 0,
        },
      },
    });

    const completedTask = controller.taskStore.get(task.id);
    expect(completedTask.result.tokenUsage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      modelCalls: 0,
      inferred: false,
    });
  });

  test('builds token summary from persisted admin logs', () => {
    logsController.logs = [
      {
        status: 'success',
        tokens: 30,
        promptTokens: 10,
        completionTokens: 20,
        tokenUsageInferred: false,
      },
      {
        status: 'success',
        tokens: 12,
        promptTokens: 0,
        completionTokens: 12,
        tokenUsageInferred: true,
      },
      {
        status: 'error',
        tokens: 999,
        promptTokens: 999,
        completionTokens: 0,
      },
    ];
    const controller = new DashboardController(null);

    expect(controller.buildTokenSummary()).toEqual({
      total: 42,
      prompt: 10,
      completion: 32,
      inferredRequests: 1,
      requests: 2,
      source: 'logs',
    });
  });

  test('tracks skills used from agent metadata separately from tools', async () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-skills-used',
      input: 'Use the frontend quality skill and verify the page.',
      model: 'gpt-test',
      mode: 'chat',
      transport: 'http',
      metadata: {},
    });

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-skills-used',
      output: 'Verified the page.',
      model: 'gpt-test',
      duration: 800,
      metadata: {
        selectedSkills: [
          { id: 'impressive-frontend-websites', name: 'Impressive Frontend Websites' },
        ],
        skillContext: [
          '<registered_skills>',
          '<skill>',
          'id=browser-qa',
          'name=Browser QA',
          '</skill>',
          '</registered_skills>',
        ].join('\n'),
        toolEvents: [{
          toolCall: {
            function: {
              name: 'web-scrape',
              arguments: JSON.stringify({ url: 'http://localhost:3000/admin' }),
            },
          },
          result: {
            success: true,
            duration: 400,
          },
        }],
      },
    });

    const storedTask = controller.taskStore.get(task.id);
    expect(storedTask.result.toolsUsed).toEqual(['web-scrape']);
    expect(storedTask.result.skillsUsed).toEqual([
      'impressive-frontend-websites',
      'browser-qa',
    ]);
    expect(storedTask.result.skillUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'impressive-frontend-websites', name: 'Impressive Frontend Websites' }),
      expect.objectContaining({ id: 'browser-qa', name: 'Browser QA' }),
    ]));

    expect(logsController.addLog).toHaveBeenCalledWith(expect.objectContaining({
      toolsUsed: ['web-scrape'],
      skillsUsed: ['impressive-frontend-websites', 'browser-qa'],
    }));

    expect(controller.buildSkillUsageSummary()).toMatchObject({
      totalUses: 2,
      distinctSkills: 2,
      thisWeek: 2,
    });

    const res = {
      json: jest.fn(),
      status: jest.fn(() => res),
    };
    await controller.getStats({ query: { range: '24h' } }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        overview: expect.objectContaining({
          skillsUsed: 2,
          totalSkillUses: 2,
          skillsUsedThisWeek: 2,
        }),
        skills: expect.objectContaining({
          totalUses: 2,
          distinctSkills: 2,
          thisWeek: 2,
        }),
      }),
    }));
  });

  test('normalizes snake_case runtime metadata for admin tool and skill traces', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-snake-runtime-metadata',
      input: 'Use the selected research skill and fetch the source.',
      model: 'gpt-test',
      mode: 'openai-chat',
      transport: 'http',
      metadata: {},
    });

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-snake-runtime-metadata',
      output: 'Fetched and summarized the source.',
      model: 'gpt-test',
      duration: 900,
      metadata: {
        selected_skills: [
          { skill_id: 'income-opportunity-research', name: 'Income Opportunity Research' },
        ],
        decision_trace: {
          selected_skills: ['browser-qa'],
        },
        execution_trace: [
          {
            type: 'tool_call',
            name: 'Tool call (web-fetch)',
            status: 'completed',
            start_time: '2026-06-25T20:00:00.000Z',
            end_time: '2026-06-25T20:00:01.000Z',
            details: {
              reason: 'Fetch source page',
            },
          },
        ],
        tool_events: [{
          tool_call: {
            function: {
              name: 'web-fetch',
              arguments: JSON.stringify({ url: 'https://example.test/source' }),
            },
          },
          tool_result: {
            success: true,
            duration_ms: 1000,
            started_at: '2026-06-25T20:00:00.000Z',
            ended_at: '2026-06-25T20:00:01.000Z',
          },
          reason: 'Fetch source page',
        }],
      },
    });

    const storedTask = controller.taskStore.get(task.id);
    expect(storedTask.result.toolsUsed).toEqual(['web-fetch']);
    expect(storedTask.result.toolEvents[0]).toMatchObject({
      toolId: 'web-fetch',
      duration: 1000,
      paramKeys: ['url'],
    });
    expect(storedTask.result.skillsUsed).toEqual([
      'income-opportunity-research',
      'browser-qa',
    ]);

    const trace = tracesController.addTrace.mock.calls[0][0];
    expect(trace.timeline.map((entry) => entry.name)).toContain('Tool call (web-fetch)');
    expect(trace.timeline.filter((entry) => entry.name === 'Tool call (web-fetch)')).toHaveLength(1);
    expect(logsController.addLog).toHaveBeenCalledWith(expect.objectContaining({
      toolsUsed: ['web-fetch'],
      skillsUsed: ['income-opportunity-research', 'browser-qa'],
    }));
  });

  test('keeps synthesized model timeline entries after the request start', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-trace-order',
      input: 'Create an HTML gallery.',
      model: 'gpt-test',
      mode: 'openai-chat',
      transport: 'http',
      metadata: {
        route: '/v1/chat/completions',
      },
    });
    task.createdAt = '2026-05-10T18:28:59.010Z';

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-gallery',
      output: 'Created the HTML document artifact (gallery.html).',
      model: 'gpt-test',
      duration: 258306,
      metadata: {
        toolEvents: [{
          toolCall: {
            function: {
              name: 'image-generate',
              arguments: JSON.stringify({ prompt: 'gallery image' }),
            },
          },
          result: {
            success: true,
            duration: 89054,
            timestamp: '2026-05-10T18:30:28.073Z',
          },
          reason: 'Generate image artifacts before creating the html artifact.',
        }],
      },
    });

    const trace = tracesController.addTrace.mock.calls[0][0];
    expect(trace.timeline[0].type).toBe('request');
    const modelStep = trace.timeline.find((step) => step.type === 'model_call');
    expect(new Date(modelStep.startTime).getTime()).toBeGreaterThanOrEqual(new Date(task.createdAt).getTime());
  });

  test('surfaces image diagnostics in admin logs and trace timelines', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-image-1',
      input: 'Generate an image of a dashboard',
      model: 'gpt-image-2',
      mode: 'image',
      transport: 'http',
      metadata: {
        route: '/v1/images/generations',
        clientSurface: 'image',
        requestedCount: 1,
      },
    });
    const diagnostics = {
      imageGeneration: {
        code: 'provider_response_not_parsable',
        status: 'failed',
        stage: 'provider_response_parse',
        counts: {
          parsedImageRecords: 0,
          returnedImageRecords: 0,
          usableReturnedImageRecords: 0,
          artifacts: 0,
        },
      },
    };

    controller.recordRuntimeTaskError(task.id, {
      error: 'No usable image data received from API',
      model: 'gpt-image-2',
      duration: 450,
      metadata: {
        diagnostics,
      },
    });

    expect(logsController.addLog).toHaveBeenCalledWith(expect.objectContaining({
      route: 'image',
      status: 'error',
      diagnostics,
    }));

    const trace = tracesController.addTrace.mock.calls[0][0];
    const requestStep = trace.timeline.find((step) => step.type === 'request');
    const failedModelStep = trace.timeline.find((step) => step.type === 'model_call');
    expect(requestStep.details.diagnostics).toEqual(diagnostics);
    expect(requestStep.details.diagnosticSummary).toContain('provider_response_not_parsable');
    expect(requestStep.details.route).toBe('/v1/images/generations');
    expect(requestStep.details.requestedCount).toBe(1);
    expect(failedModelStep.details.diagnostics).toEqual(diagnostics);
    expect(failedModelStep.details.diagnosticSummary).toContain('provider_response_not_parsable');
  });

  test('surfaces image diagnostics from failed tool events in fallback trace steps', () => {
    const controller = new DashboardController(null);
    const task = controller.recordRuntimeTaskStart({
      sessionId: 'session-image-tool-1',
      input: 'Generate a dog image',
      model: 'gpt-test',
      mode: 'chat',
      transport: 'http',
      metadata: {},
    });
    const diagnostics = {
      imageGeneration: {
        code: 'provider_fetch_failed',
        stage: 'tool_error',
        flags: {
          providerResponseReceived: false,
        },
      },
    };

    controller.recordRuntimeTaskComplete(task.id, {
      responseId: 'resp-image-tool-1',
      output: 'The image tool failed with: fetch failed.',
      model: 'gpt-test',
      duration: 600,
      metadata: {
        toolEvents: [{
          toolCall: {
            function: {
              name: 'image-generate',
              arguments: JSON.stringify({ prompt: 'dog' }),
            },
          },
          result: {
            success: false,
            error: 'fetch failed',
            diagnostics,
          },
          reason: 'Generate requested dog image',
        }],
      },
    });

    const trace = tracesController.addTrace.mock.calls[0][0];
    const toolStep = trace.timeline.find((step) => step.type === 'tool_call');
    expect(toolStep.details.diagnostics).toEqual(diagnostics);
  });

  test('reports optional admin capabilities in health without treating them as core service failures', async () => {
    const controller = new DashboardController(null);

    const req = {
      app: {
        locals: {
          startupState: {
            ready: true,
            status: 'ready',
            startedAt: '2026-05-03T00:00:00.000Z',
            initializedAt: '2026-05-03T00:00:01.000Z',
            lastError: null,
          },
          agentWorkloadService: {
            isAvailable: jest.fn(() => false),
          },
          managedAppService: {
            isAvailable: jest.fn(() => true),
          },
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await controller.getHealth(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        status: expect.any(String),
        capabilities: {
          deferredWorkloads: false,
          managedApps: true,
        },
        components: expect.objectContaining({
          boot: expect.objectContaining({
            status: 'healthy',
          }),
          qdrant: expect.any(Object),
          sdk: expect.any(Object),
          websocket: expect.any(Object),
          tts: expect.any(Object),
          audioProcessing: expect.any(Object),
          podcastVideo: expect.any(Object),
          memory: expect.any(Object),
        }),
        services: expect.objectContaining({
          sdk: expect.any(String),
          vectorStore: expect.any(String),
        }),
      }),
    }));
  });
});

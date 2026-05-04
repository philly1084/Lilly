const { ConversationOrchestrator } = require('../conversation-orchestrator');
const {
  AGENCY_MODES,
  buildAgencyProfile,
  inferTaskIntent,
} = require('./intent-classifier');
const {
  applyRewritePolicyOverlay,
  removeUnsupportedAutonomousTools,
  selectCandidatesForAgencyMode,
} = require('./tool-policy');
const { validatePlan, validatePlanStep } = require('./plan-validator');
const { buildToolContract } = require('./tool-contracts');
const {
  ROLE_IDS,
  inferAgentRolePipeline,
} = require('./agent-roles');

function withRewriteFlag(value, fn) {
  const previous = process.env.ORCHESTRATION_REWRITE_ENABLED;
  process.env.ORCHESTRATION_REWRITE_ENABLED = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ORCHESTRATION_REWRITE_ENABLED;
    } else {
      process.env.ORCHESTRATION_REWRITE_ENABLED = previous;
    }
  }
}

function buildToolManager(toolIds = []) {
  const buildInputSchema = (toolId) => {
    if (toolId === 'agent-workload') {
      return {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['create_from_scenario', 'list'] },
          request: { type: 'string' },
          timezone: { type: 'string' },
        },
        additionalProperties: false,
      };
    }

    if (toolId === 'code-sandbox') {
      return {
        type: 'object',
        required: ['language'],
        properties: {
          mode: { type: 'string', enum: ['execute', 'project'] },
          language: { type: 'string', enum: ['javascript', 'html', 'vite'] },
          code: { type: 'string' },
          files: { type: 'array' },
        },
      };
    }

    return {
      type: 'object',
      properties: {},
    };
  };

  const tools = new Map(toolIds.map((toolId) => [toolId, {
    id: toolId,
    name: toolId,
    description: `${toolId} test tool`,
    inputSchema: buildInputSchema(toolId),
    backend: {
      sideEffects: toolId.startsWith('agent-') || toolId === 'code-sandbox' ? ['write'] : [],
    },
  }]));
  return {
    getTool: jest.fn((toolId) => tools.get(toolId) || null),
  };
}

describe('orchestration rewrite policy', () => {
  test('classifies agency modes for respond, schedule, multi-schedule, and delegation', () => {
    expect(inferTaskIntent({ objective: 'What is dependency injection?' }).mode).toBe(AGENCY_MODES.RESPOND);
    expect(inferTaskIntent({ objective: 'Remind me tomorrow to check the logs.' }).mode).toBe(AGENCY_MODES.SCHEDULE);
    expect(inferTaskIntent({ objective: 'Create two cron jobs: daily backup and weekly cleanup.' }).mode).toBe(AGENCY_MODES.SCHEDULE_MULTIPLE);
    expect(inferTaskIntent({ objective: 'Spawn three sub-agents to investigate these areas in parallel.' }).mode).toBe(AGENCY_MODES.DELEGATE);
  });

  test('removes managed-app from autonomous allowlists and candidates', () => {
    expect(removeUnsupportedAutonomousTools(['managed-app', 'remote-command', 'agent-workload'])).toEqual([
      'remote-command',
      'agent-workload',
    ]);
  });

  test('narrows candidates by agency mode when rewrite flag is enabled', () => withRewriteFlag('true', () => {
    const toolManager = buildToolManager(['managed-app', 'agent-workload', 'agent-delegate', 'remote-command']);
    const intent = inferTaskIntent({ objective: 'Schedule this every weekday at 9 AM.' });
    const policy = applyRewritePolicyOverlay({
      legacyPolicy: {
        allowedToolIds: ['managed-app', 'agent-workload', 'agent-delegate', 'remote-command'],
        candidateToolIds: ['managed-app', 'agent-workload', 'remote-command'],
      },
      objective: 'Schedule this every weekday at 9 AM.',
      agencyProfile: buildAgencyProfile({ intent }),
      toolManager,
    });

    expect(policy.allowedToolIds).not.toContain('managed-app');
    expect(policy.candidateToolIds).toEqual(['agent-workload']);
    expect(policy.toolContracts['agent-workload']).toMatchObject({
      supportsSchedule: true,
      backgroundEligible: true,
    });
  }));

  test('validates planned steps before execution and returns structured rejection reasons', () => {
    const toolManager = buildToolManager(['agent-workload']);
    const invalid = validatePlanStep({
      tool: 'agent-workload',
      params: {
        action: 'create_from_scenario',
        request: 'check later',
        command: 'date',
      },
    }, {
      candidateToolIds: ['agent-workload'],
      toolManager,
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.rejections.map((rejection) => rejection.code)).toContain('unknown_params');

    const managedApp = validatePlan([{ tool: 'managed-app', params: { action: 'inspect' } }], {
      candidateToolIds: ['managed-app'],
      toolManager: buildToolManager(['managed-app']),
    });
    expect(managedApp.ok).toBe(false);
    expect(managedApp.rejected[0].rejections.map((rejection) => rejection.code)).toContain('unsupported_tool');
  });

  test('treats whitespace-only required params as missing', () => {
    const invalid = validatePlanStep({
      tool: 'web-scrape',
      params: {
        url: '   ',
        browser: true,
        captureScreenshot: true,
      },
    }, {
      candidateToolIds: ['web-scrape'],
      contracts: {
        'web-scrape': {
          inputSchema: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string' },
            },
          },
        },
      },
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'missing_required_params',
        missing: ['url'],
      }),
    ]));
  });

  test('planner drops web-scrape QA steps with blank urls before execution', async () => {
    const llmClient = {
      createResponse: jest.fn(),
      complete: jest.fn().mockResolvedValue(JSON.stringify({
        steps: [{
          tool: 'web-scrape',
          reason: 'Verify the generated sandbox preview renders.',
          params: {
            url: '   ',
            browser: true,
            captureScreenshot: true,
          },
        }],
      })),
    };
    const orchestrator = new ConversationOrchestrator({
      llmClient,
      toolManager: buildToolManager(['web-scrape', 'document-workflow']),
    });
    const objective = 'lets make a quick sandboxed game for sophia';
    const toolPolicy = {
      allowedToolIds: ['web-scrape', 'document-workflow'],
      candidateToolIds: ['web-scrape', 'document-workflow'],
      toolContracts: {
        'web-scrape': {
          inputSchema: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string' },
            },
          },
        },
        'document-workflow': {
          inputSchema: {
            type: 'object',
            required: ['action'],
            properties: {
              action: { type: 'string' },
            },
          },
        },
      },
    };

    const plan = await orchestrator.planToolUse({
      objective,
      executionProfile: 'default',
      toolPolicy,
      toolContext: {
        clientSurface: 'web-chat',
      },
    });

    expect(plan).toEqual([]);
  });

  test('orchestrator policy exposes typed rewrite metadata without changing public APIs', () => withRewriteFlag('true', () => {
    const orchestrator = new ConversationOrchestrator({});
    const toolManager = buildToolManager(['managed-app', 'agent-workload', 'agent-delegate', 'remote-command']);
    const policy = orchestrator.buildToolPolicy({
      objective: 'Set up a cron job to check disk usage daily.',
      executionProfile: 'default',
      toolManager,
    });

    expect(policy.type).toBe('ToolPolicy');
    expect(policy.orchestrationRewrite.intent.type).toBe('TaskIntent');
    expect(policy.orchestrationRewrite.agencyProfile.type).toBe('AgencyProfile');
    expect(policy.allowedToolIds).not.toContain('managed-app');
    expect(policy.candidateToolIds).toEqual(['agent-workload']);
  }));

  test('candidate narrowing helper keeps direct tools for multi-step work', () => {
    const candidates = selectCandidatesForAgencyMode({
      candidateToolIds: ['agent-workload', 'agent-delegate', 'remote-command'],
      agencyProfile: { mode: AGENCY_MODES.MULTI_STEP },
    });
    expect(candidates).toEqual(['agent-workload', 'agent-delegate', 'remote-command']);
  });

  test('infers research, design, sandbox build, QA, and integration roles for website builds', () => {
    const pipeline = inferAgentRolePipeline({
      objective: 'Research competitors and build a polished landing page website.',
      classification: {
        taskFamily: 'research-deliverable',
        groundingRequirement: 'required',
      },
      executionProfile: 'default',
    });

    expect(pipeline).toEqual(expect.objectContaining({
      strategy: 'research-design-sandbox-build',
      requiresResearch: true,
      requiresDesign: true,
      requiresBuild: true,
      requiresSandbox: true,
    }));
    expect(pipeline.roles.map((role) => role.id)).toEqual(expect.arrayContaining([
      ROLE_IDS.ORCHESTRATOR,
      ROLE_IDS.RESEARCH,
      ROLE_IDS.DESIGN,
      ROLE_IDS.BUILDER,
      ROLE_IDS.QA,
      ROLE_IDS.INTEGRATOR,
    ]));
    expect(pipeline.qualityBar).toEqual(expect.objectContaining({
      name: 'impressive-frontend-websites',
      requiredPractices: expect.arrayContaining([
        expect.stringContaining('iterate after the first working render'),
      ]),
    }));
    const designRole = pipeline.roles.find((role) => role.id === ROLE_IDS.DESIGN);
    expect(designRole.outputContract.required).toContain('assetPlan');
    const builderRole = pipeline.roles.find((role) => role.id === ROLE_IDS.BUILDER);
    expect(builderRole.outputContract.required).toContain('interactiveStates');
    const qaRole = pipeline.roles.find((role) => role.id === ROLE_IDS.QA);
    expect(qaRole.tools).toContain('web-scrape');
    expect(qaRole.outputContract.required).toContain('screenshots');
    expect(qaRole.outputContract.required).toContain('openedStates');
  });

  test('allows previewable code-sandbox project mode but blocks executable sandbox mode', () => {
    const tool = buildToolManager(['code-sandbox']).getTool('code-sandbox');
    const contracts = {
      'code-sandbox': buildToolContract('code-sandbox', tool),
    };

    const projectStep = validatePlanStep({
      tool: 'code-sandbox',
      params: {
        mode: 'project',
        language: 'html',
        files: [{ path: 'index.html', content: '<main>Preview</main>' }],
      },
    }, {
      candidateToolIds: ['code-sandbox'],
      contracts,
    });
    expect(projectStep.ok).toBe(true);

    const executeStep = validatePlanStep({
      tool: 'code-sandbox',
      params: {
        mode: 'execute',
        language: 'javascript',
        code: 'console.log("runs arbitrary code")',
      },
    }, {
      candidateToolIds: ['code-sandbox'],
      contracts,
    });
    expect(executeStep.ok).toBe(false);
    expect(executeStep.rejections.map((rejection) => rejection.code)).toContain('confirmation_required');
  });

  test('orchestrator policy exposes role pipeline design and sandbox candidates for site builds', () => {
    const orchestrator = new ConversationOrchestrator({});
    const toolManager = buildToolManager([
      'document-workflow',
      'design-resource-search',
      'code-sandbox',
      'web-search',
      'web-fetch',
      'web-scrape',
    ]);
    const objective = 'Build a polished landing page website for a local AI consulting firm.';
    const policy = orchestrator.buildToolPolicy({
      objective,
      executionProfile: 'default',
      toolManager,
    });

    expect(policy.rolePipeline).toEqual(expect.objectContaining({
      requiresDesign: true,
      requiresBuild: true,
      requiresSandbox: true,
    }));
    expect(policy.candidateToolIds).toEqual(expect.arrayContaining([
      'document-workflow',
      'design-resource-search',
      'code-sandbox',
      'web-scrape',
    ]));

    const directAction = orchestrator.buildDirectAction({
      objective,
      toolPolicy: policy,
    });
    expect(directAction).toEqual(expect.objectContaining({
      tool: 'design-resource-search',
      params: expect.objectContaining({
        action: 'search',
        surface: 'website',
      }),
    }));
  });

  test('uses design resources as document-workflow sources and requests sandbox suite output', () => {
    const orchestrator = new ConversationOrchestrator({});
    const toolManager = buildToolManager([
      'document-workflow',
      'design-resource-search',
      'code-sandbox',
    ]);
    const objective = 'Build a modern website for a neighborhood bakery.';
    const policy = orchestrator.buildToolPolicy({
      objective,
      executionProfile: 'default',
      toolManager,
    });
    const action = orchestrator.buildDirectAction({
      objective,
      toolPolicy: policy,
      toolEvents: [{
        toolCall: {
          function: {
            name: 'design-resource-search',
            arguments: JSON.stringify({ action: 'search', query: objective }),
          },
        },
        result: {
          toolId: 'design-resource-search',
          success: true,
          data: {
            results: [{
              id: 'tailwind-css',
              name: 'Tailwind CSS Docs',
              provider: 'Tailwind Labs',
              category: 'styling',
              description: 'Responsive layout and utility styling reference.',
              bestFor: ['responsive layout', 'component styling'],
              formats: ['css', 'utility-classes'],
              domains: ['tailwindcss.com'],
              license: 'MIT',
              attribution: 'Follow Tailwind CSS documentation and package license terms.',
              fetchPlan: {
                params: {
                  url: 'https://tailwindcss.com/docs/utility-first',
                },
              },
            }],
          },
        },
      }],
    });

    expect(action).toEqual(expect.objectContaining({
      tool: 'document-workflow',
      params: expect.objectContaining({
        action: 'generate-suite',
        documentType: 'website',
        formats: ['html'],
        buildMode: 'sandbox',
        useSandbox: true,
        includeContent: true,
        sources: [
          expect.objectContaining({
            kind: 'design-resource-search',
            sourceUrl: 'https://tailwindcss.com/docs/utility-first',
          }),
        ],
      }),
    }));
  });

  test('uses generate-suite for explicit multi-format PDF and PPTX document packages', () => {
    const orchestrator = new ConversationOrchestrator({});
    const toolManager = buildToolManager(['document-workflow']);
    const objective = 'Create a PDF and PPTX package for the quarterly operations brief.';
    const policy = orchestrator.buildToolPolicy({
      objective,
      executionProfile: 'default',
      toolManager,
    });

    const action = orchestrator.buildDirectAction({
      objective,
      toolPolicy: policy,
    });

    expect(action).toEqual(expect.objectContaining({
      tool: 'document-workflow',
      params: expect.objectContaining({
        action: 'generate-suite',
        formats: expect.arrayContaining(['pdf', 'pptx']),
      }),
    }));
    expect(action.params.formats).not.toContain('html');
    expect(action.params.useSandbox).toBeUndefined();
  });

  test('adds an HTML preview companion for web-chat PDF deliverables', () => {
    const orchestrator = new ConversationOrchestrator({});
    const toolManager = buildToolManager(['document-workflow']);
    const objective = 'Create a PDF report about our Q2 roadmap.';
    const policy = orchestrator.buildToolPolicy({
      objective,
      executionProfile: 'default',
      toolManager,
    });

    const action = orchestrator.buildDirectAction({
      objective,
      toolPolicy: policy,
      toolContext: {
        clientSurface: 'web-chat',
      },
    });

    expect(action).toEqual(expect.objectContaining({
      tool: 'document-workflow',
      params: expect.objectContaining({
        action: 'generate-suite',
        formats: expect.arrayContaining(['pdf', 'html']),
        buildMode: 'sandbox',
        useSandbox: true,
        includeContent: true,
      }),
    }));
  });

  test('keeps web-chat slide deliverables as pptx with sandbox html preview companion', () => {
    const orchestrator = new ConversationOrchestrator({});
    const toolManager = buildToolManager(['document-workflow']);
    const objective = 'Can you make me slides on FGZEUM?';
    const policy = orchestrator.buildToolPolicy({
      objective,
      executionProfile: 'default',
      toolManager,
    });

    const action = orchestrator.buildDirectAction({
      objective,
      toolPolicy: policy,
      toolContext: {
        clientSurface: 'web-chat',
      },
    });

    expect(action).toEqual(expect.objectContaining({
      tool: 'document-workflow',
      params: expect.objectContaining({
        action: 'generate-suite',
        formats: expect.arrayContaining(['pptx', 'html']),
        buildMode: 'sandbox',
        useSandbox: true,
        includeContent: true,
      }),
    }));
  });
});

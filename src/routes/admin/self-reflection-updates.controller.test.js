const fs = require('fs');
const os = require('os');
const path = require('path');
const controller = require('./self-reflection-updates.controller');

describe('self-reflection updates admin controller', () => {
  let tempDir;
  let logPath;
  let originalLogPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-self-reflection-admin-'));
    logPath = path.join(tempDir, 'updates.jsonl');
    originalLogPath = process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH;
    process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH = logPath;
  });

  afterEach(() => {
    if (originalLogPath === undefined) {
      delete process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH;
    } else {
      process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH = originalLogPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns bounded audit log data', async () => {
    fs.writeFileSync(logPath, [
      JSON.stringify({ id: 'first', timestamp: '2026-05-20T00:00:00.000Z' }),
      JSON.stringify({ id: 'second', timestamp: '2026-05-20T00:01:00.000Z' }),
      '',
    ].join('\n'), 'utf8');
    const res = {
      json: jest.fn(),
    };

    await controller.list({ query: { limit: '1' } }, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        updates: [
          { id: 'second', timestamp: '2026-05-20T00:01:00.000Z' },
        ],
        meta: {
          logPath,
          limit: 1,
          count: 2,
          returned: 1,
          parseErrors: 0,
        },
      },
    });
  });

  test('returns evaluator self-reflection suggestions from session metadata', async () => {
    const res = {
      json: jest.fn(),
    };
    const req = {
      query: { limit: '5' },
      app: {
        locals: {
          sessionStore: {
            list: jest.fn().mockResolvedValue([
              buildSessionWithSuggestion(),
            ]),
          },
        },
      },
    };

    await controller.listSuggestions(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        suggestions: [
          expect.objectContaining({
            id: expect.stringMatching(/^srs-/),
            status: 'suggested',
            applied: false,
            canApply: true,
            toolId: 'self-reflection-update',
            sessionId: 'session-a',
            messageId: 'message-a',
            feedbackId: 'feedback-a',
            input: expect.objectContaining({
              dryRun: true,
              apply: false,
              actions: [
                expect.objectContaining({
                  type: 'model_card_note',
                  content: 'Prefer live-route proof before reassuring the user.',
                }),
              ],
            }),
          }),
        ],
      }),
    }));
  });

  test('generates model-card suggestions from durable evaluator lessons', async () => {
    const res = {
      json: jest.fn(),
    };
    const req = {
      query: { limit: '5' },
      app: {
        locals: {
          sessionStore: {
            list: jest.fn().mockResolvedValue([
              {
                id: 'session-b',
                updatedAt: '2026-05-20T12:30:00.000Z',
                metadata: {
                  alignmentFeedbackHistory: [
                    {
                      feedbackId: 'feedback-b',
                      evaluationId: 'feedback-b',
                      messageId: 'message-b',
                      rating: 'down',
                      status: 'completed',
                      reason: 'The answer skipped verification.',
                      updatedAt: '2026-05-20T12:30:00.000Z',
                      evaluation: {
                        summary: 'The feedback identifies a remote route verification lesson.',
                        lesson: 'Remote deployment requests require acting through the remote tool lane and reporting only verified results.',
                        routeDecision: 'wrong_route',
                        failureCategories: ['wrong_route', 'missing_visual_verification'],
                        toolUseDecision: 'tool_gap',
                        toolMisuseCategories: ['missing_required_tool'],
                        promoteRegressionFixture: true,
                        selfReflectionUpdateSuggestions: [],
                      },
                    },
                  ],
                },
              },
            ]),
          },
        },
      },
    };

    await controller.listSuggestions(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        suggestions: [
          expect.objectContaining({
            id: expect.stringMatching(/^srs-/),
            status: 'suggested',
            canApply: true,
            input: expect.objectContaining({
              actions: [
                expect.objectContaining({
                  type: 'model_card_note',
                  content: expect.stringContaining('Remote deployment requests require acting'),
                }),
              ],
            }),
          }),
        ],
      }),
    }));
  });

  test('returns after-process audit self-reflection suggestions from failed tool-call reviews', async () => {
    const res = {
      json: jest.fn(),
    };
    const req = {
      query: { limit: '5' },
      app: {
        locals: {
          sessionStore: {
            list: jest.fn().mockResolvedValue([
              buildSessionWithAfterProcessSuggestion(),
            ]),
          },
        },
      },
    };

    await controller.listSuggestions(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        suggestions: [
          expect.objectContaining({
            id: expect.stringMatching(/^srs-audit-/),
            status: 'suggested',
            applied: false,
            canApply: true,
            toolId: 'self-reflection-update',
            sourceType: 'after-process-audit',
            sessionId: 'session-c',
            feedbackId: 'after-audit-c',
            auditId: 'after-audit-c',
            input: expect.objectContaining({
              source: 'after-process-audit',
              dryRun: true,
              apply: false,
              actions: [
                expect.objectContaining({
                  type: 'model_card_note',
                  content: expect.stringContaining('remote-cli-agent failed with bad_schema_or_missing_params'),
                }),
              ],
            }),
          }),
        ],
      }),
    }));
  });

  test('applies an approved evaluator suggestion and marks it applied in the audit view', async () => {
    const session = buildSessionWithSuggestion();
    const req = {
      query: { limit: '5' },
      app: {
        locals: {
          sessionStore: {
            list: jest.fn().mockResolvedValue([session]),
          },
        },
      },
    };
    const listRes = { json: jest.fn() };
    await controller.listSuggestions(req, listRes, jest.fn());
    const suggestionId = listRes.json.mock.calls[0][0].data.suggestions[0].id;

    const applyRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    await controller.applySuggestion({
      ...req,
      params: { id: suggestionId },
    }, applyRes, jest.fn());

    expect(applyRes.status).not.toHaveBeenCalled();
    expect(applyRes.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        suggestion: expect.objectContaining({
          id: suggestionId,
          applied: true,
          canApply: false,
        }),
        result: expect.objectContaining({
          applied: true,
          dryRun: false,
          modelCardNote: 'Prefer live-route proof before reassuring the user.',
        }),
      }),
    }));

    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain(`[suggestion:${suggestionId}]`);

    const postApplyRes = { json: jest.fn() };
    await controller.listSuggestions(req, postApplyRes, jest.fn());
    expect(postApplyRes.json.mock.calls[0][0].data.suggestions[0]).toEqual(expect.objectContaining({
      id: suggestionId,
      status: 'applied',
      applied: true,
      canApply: false,
    }));
  });

  test('applying an after-process audit suggestion stores a tool recovery hint', async () => {
    const session = buildSessionWithAfterProcessSuggestion();
    const sessionById = new Map([[session.id, session]]);
    const req = {
      query: { limit: '5' },
      app: {
        locals: {
          sessionStore: {
            list: jest.fn().mockResolvedValue([session]),
            get: jest.fn((id) => Promise.resolve(sessionById.get(id) || null)),
            update: jest.fn((id, updates = {}) => {
              const target = sessionById.get(id);
              if (target) {
                target.metadata = {
                  ...(target.metadata || {}),
                  ...(updates.metadata || {}),
                };
              }
              return Promise.resolve(target || null);
            }),
          },
        },
      },
    };
    const listRes = { json: jest.fn() };
    await controller.listSuggestions(req, listRes, jest.fn());
    const suggestionId = listRes.json.mock.calls[0][0].data.suggestions[0].id;

    const applyRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    await controller.applySuggestion({
      ...req,
      params: { id: suggestionId },
    }, applyRes, jest.fn());

    expect(applyRes.status).not.toHaveBeenCalled();
    expect(req.app.locals.sessionStore.update).toHaveBeenCalledWith('session-c', {
      metadata: {
        afterProcessAuditToolHints: [
          expect.objectContaining({
            auditId: 'after-audit-c',
            suggestionId,
            toolId: 'remote-cli-agent',
            failureKind: 'bad_schema_or_missing_params',
            nextAction: 'replan_with_validated_params',
            status: 'active',
          }),
        ],
      },
    });
    expect(applyRes.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        toolFailureHint: expect.objectContaining({
          toolId: 'remote-cli-agent',
          nextAction: 'replan_with_validated_params',
        }),
      }),
    }));
  });
});

function buildSessionWithSuggestion() {
  return {
    id: 'session-a',
    updatedAt: '2026-05-20T12:00:00.000Z',
    metadata: {
      alignmentFeedbackHistory: [
        {
          feedbackId: 'feedback-a',
          evaluationId: 'feedback-a',
          messageId: 'message-a',
          rating: 'down',
          status: 'completed',
          reason: 'The answer reassured from memory without proof.',
          updatedAt: '2026-05-20T12:00:00.000Z',
          evaluation: {
            lesson: 'Verify the live route before reassuring the user.',
            confidence: 'medium',
            selfReflectionUpdateSuggestions: [
              {
                toolId: 'self-reflection-update',
                status: 'suggested',
                input: {
                  source: 'alignment-evaluator',
                  trigger: 'negative alignment feedback',
                  reflection: 'The user needed live proof, not generic reassurance.',
                  dryRun: true,
                  apply: false,
                  actions: [
                    {
                      type: 'model_card_note',
                      content: 'Prefer live-route proof before reassuring the user.',
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function buildSessionWithAfterProcessSuggestion() {
  return {
    id: 'session-c',
    updatedAt: '2026-06-09T12:00:00.000Z',
    metadata: {
      afterProcessAuditHistory: [
        {
          auditId: 'after-audit-c',
          status: 'completed',
          model: 'gpt-5.5',
          completedAt: '2026-06-09T12:00:00.000Z',
          audit: {
            auditDecision: 'needs_followup',
            qualityScore: 0.31,
            summary: 'Remote tool failed because the task parameter was missing.',
            learningReview: {
              durableLessons: ['Remote tool failures need validated task params before retry.'],
              selfReflectionUpdateSuggestions: [
                {
                  toolId: 'self-reflection-update',
                  status: 'suggested',
                  input: {
                    source: 'after-process-audit',
                    trigger: 'Failed tool call after completed work: remote-cli-agent',
                    reflection: 'The audit found a reusable recovery lesson for remote-cli-agent.',
                    dryRun: true,
                    apply: false,
                    actions: [
                      {
                        type: 'model_card_note',
                        content: 'Tool failure learning: remote-cli-agent failed with bad_schema_or_missing_params; future runs should replan_with_validated_params.',
                        reason: 'Record a bounded model-card note for this failed tool pattern.',
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    },
  };
}

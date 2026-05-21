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
                        summary: 'The feedback identifies a reusable route verification lesson.',
                        lesson: 'For similar future frontend requests, verify the served UI before finalizing.',
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
                  content: expect.stringContaining('For similar future frontend requests'),
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

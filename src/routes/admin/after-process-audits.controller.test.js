jest.mock('./settings.controller', () => ({
  settings: {
    orchestration: {
      afterProcessAuditEnabled: true,
      agentDirectedRuntime: false,
      neuralWaveResearchMode: false,
      asyncRuntimeEnabled: false,
      asyncRuntimeWebChatParallel: false,
      asyncRuntimeAllowLiveRemote: false,
      enableAlignmentEvaluator: true,
      applyAlignmentGuidance: true,
    },
  },
  getEffectiveOrchestrationConfig: jest.fn(function getEffectiveOrchestrationConfig() {
    return {
      ...this.settings.orchestration,
      defaultModel: 'gpt-5.5',
      afterProcessAuditModel: 'gpt-5.5',
    };
  }),
  normalizeOrchestrationSettings: jest.fn((settings = {}) => ({
    afterProcessAuditEnabled: settings.afterProcessAuditEnabled !== false,
    agentDirectedRuntime: settings.agentDirectedRuntime === true,
    neuralWaveResearchMode: settings.neuralWaveResearchMode === true,
    asyncRuntimeEnabled: settings.asyncRuntimeEnabled === true,
    asyncRuntimeWebChatParallel: settings.asyncRuntimeWebChatParallel === true,
    asyncRuntimeAllowLiveRemote: settings.asyncRuntimeAllowLiveRemote === true,
    enableAlignmentEvaluator: settings.enableAlignmentEvaluator !== false,
    applyAlignmentGuidance: settings.applyAlignmentGuidance !== false,
  })),
  deepMerge: jest.fn((target = {}, source = {}) => ({
    ...target,
    ...source,
    orchestration: {
      ...(target.orchestration || {}),
      ...(source.orchestration || {}),
    },
  })),
  saveSettings: jest.fn().mockResolvedValue(undefined),
  applyAsyncRuntimeSettingsToRuntime: jest.fn().mockResolvedValue(undefined),
  getPublicSettings: jest.fn(function getPublicSettings() {
    return {
      orchestration: this.settings.orchestration,
    };
  }),
}));

const controller = require('./after-process-audits.controller');
const settingsController = require('./settings.controller');

describe('after-process audits admin controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    settingsController.settings = {
      orchestration: {
        afterProcessAuditEnabled: true,
        agentDirectedRuntime: false,
        neuralWaveResearchMode: false,
        asyncRuntimeEnabled: false,
        asyncRuntimeWebChatParallel: false,
        asyncRuntimeAllowLiveRemote: false,
        enableAlignmentEvaluator: true,
        applyAlignmentGuidance: true,
      },
    };
  });

  test('lists after-process audits with tool, skill, and flag recommendations', async () => {
    const req = buildReqWithSessions([buildAuditSession()]);
    const res = { json: jest.fn() };

    await controller.list(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        audits: [
          expect.objectContaining({
            auditId: 'after-audit-a',
            sessionId: 'session-a',
            decision: 'needs_followup',
            summary: 'Remote orchestration needs tighter proof.',
            toolSkillReview: expect.objectContaining({
              missingTools: ['skill-context'],
              skillUpdates: ['Patch remote ops skill with proof checklist.'],
            }),
            recommendedFlagChanges: [
              expect.objectContaining({
                flag: 'neuralWaveResearchMode',
                currentValue: false,
                suggestedValue: true,
                canApply: true,
              }),
            ],
          }),
        ],
        meta: expect.objectContaining({
          count: 1,
          needsFollowupCount: 1,
          recommendationCount: 1,
        }),
      }),
    }));
  });

  test('applies an approved boolean orchestration flag recommendation', async () => {
    const req = buildReqWithSessions([buildAuditSession()]);
    const listData = await controller.collectAudits(req);
    const recommendationId = listData.audits[0].recommendedFlagChanges[0].id;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await controller.applyFlagRecommendation({
      ...req,
      params: { id: recommendationId },
      body: {},
      query: {},
    }, res, jest.fn());

    expect(res.status).not.toHaveBeenCalled();
    expect(settingsController.saveSettings).toHaveBeenCalled();
    expect(settingsController.applyAsyncRuntimeSettingsToRuntime).toHaveBeenCalled();
    expect(settingsController.settings.orchestration.neuralWaveResearchMode).toBe(true);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        recommendation: expect.objectContaining({
          id: recommendationId,
          status: 'applied',
          applied: true,
        }),
        settings: expect.objectContaining({
          orchestration: expect.objectContaining({
            neuralWaveResearchMode: true,
          }),
        }),
      }),
    }));
  });

  test('rejects stale flag recommendations when the setting changed after audit', async () => {
    const req = buildReqWithSessions([buildAuditSession()]);
    const listData = await controller.collectAudits(req);
    const recommendationId = listData.audits[0].recommendedFlagChanges[0].id;
    settingsController.settings.orchestration.neuralWaveResearchMode = true;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await controller.applyFlagRecommendation({
      ...req,
      params: { id: recommendationId },
      body: {},
      query: {},
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(settingsController.saveSettings).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.stringContaining('changed since audit'),
    }));
  });

  test('keeps skill recommendations as review-only findings', () => {
    const entries = controller._private.getAuditEntriesFromSession(buildAuditSession({
      recommendedFlagChanges: [{
        flag: 'skill_patch',
        currentValue: false,
        suggestedValue: true,
        reason: 'Patch a skill.',
      }],
    }));

    expect(entries[0].recommendedFlagChanges[0]).toEqual(expect.objectContaining({
      flag: 'skill_patch',
      canApply: false,
      status: 'review_only',
    }));
  });
});

function buildReqWithSessions(sessions = []) {
  return {
    query: { limit: '10' },
    body: {},
    app: {
      locals: {
        sessionStore: {
          list: jest.fn().mockResolvedValue(sessions),
        },
      },
    },
  };
}

function buildAuditSession(overrides = {}) {
  return {
    id: 'session-a',
    updatedAt: '2026-06-06T12:00:00.000Z',
    metadata: {
      afterProcessAuditHistory: [{
        auditId: 'after-audit-a',
        status: 'completed',
        model: 'gpt-5.5',
        completedAt: '2026-06-06T12:00:00.000Z',
        audit: {
          auditDecision: 'needs_followup',
          qualityScore: 0.44,
          summary: 'Remote orchestration needs tighter proof.',
          orchestrationReview: {
            flagsConsidered: ['neuralWaveResearchMode'],
            interactionFindings: ['Broad remote work could use staged review.'],
          },
          toolSkillReview: {
            selectedSkills: ['remote-operations-system'],
            actualTools: ['remote-cli-agent'],
            missingTools: ['skill-context'],
            misusedTools: [],
            skillUpdates: ['Patch remote ops skill with proof checklist.'],
            toolPolicyUpdates: ['Nudge skill-context before remote handoff.'],
          },
          learningReview: {
            durableLessons: ['Remote deploy completion needs route plus runtime proof.'],
            outputQualityRisks: ['Verification was too shallow.'],
          },
          recommendedFlagChanges: overrides.recommendedFlagChanges || [{
            flag: 'neuralWaveResearchMode',
            currentValue: false,
            suggestedValue: true,
            reason: 'The task had broad research and review needs.',
            confidence: 0.71,
          }],
          followUpActions: [{
            type: 'skill_review',
            description: 'Review remote ops skill checklist.',
          }],
        },
      }],
    },
  };
}

'use strict';
jest.mock('./suggestion-trials', () => ({ evaluateSuggestion: jest.fn(async () => null) }));
const { candidateHash } = require('../agent-evals/task-trials');

const {
  normalizeDailyAlignmentConfig,
  runDailyFeedbackAlignment,
  shouldRunDailyAlignment,
  summarizeLogs,
} = require('./daily-feedback-loop');

describe('daily feedback alignment loop', () => {
  test('normalizes conservative daily defaults', () => {
    const config = normalizeDailyAlignmentConfig({
      intervalHours: 0,
      maxAppliedPerRun: 99,
    });

    expect(config.enabled).toBe(true);
    expect(config.autoApply).toBe(true);
    expect(config.intervalHours).toBe(1);
    expect(config.maxAppliedPerRun).toBe(4);
  });

  test('runs once per day unless forced or nextAt is due', () => {
    const now = new Date('2026-06-21T12:00:00.000Z');

    expect(shouldRunDailyAlignment({}, {}, now)).toBe(true);
    expect(shouldRunDailyAlignment({
      lastDayKey: '2026-06-21',
      nextAt: '2026-06-22T12:00:00.000Z',
    }, {}, now)).toBe(false);
    expect(shouldRunDailyAlignment({
      lastDayKey: '2026-06-21',
      nextAt: '2026-06-21T11:59:00.000Z',
    }, {}, now)).toBe(true);
  });

  test('summarizes recent logs without retaining raw transcripts', () => {
    const summary = summarizeLogs([
      {
        timestamp: '2026-06-21T11:00:00.000Z',
        level: 'error',
        status: 'failed',
        model: 'codex-latest',
        error: 'tool failed because dependency timed out',
      },
      {
        timestamp: '2026-06-19T11:00:00.000Z',
        level: 'error',
        status: 'failed',
        error: 'old error',
      },
    ], new Date('2026-06-21T12:00:00.000Z'), 24);

    expect(summary.count).toBe(1);
    expect(summary.byLevel.error).toBe(1);
    expect(summary.models).toEqual(['codex-latest']);
    expect(summary.errorSamples).toEqual(['tool failed because dependency timed out']);
  });

  test('auto-applies one safe self-reflection suggestion and records evidence', async () => {
    const applyUpdate = jest.fn((input) => ({
      id: 'self-reflection-1',
      applied: true,
      input,
      actions: [{ type: 'model_card_note', status: 'recorded' }],
    }));
    const result = await runDailyFeedbackAlignment({
      config: {
        autoApply: true,
        maxAppliedPerRun: 1,
      },
      previousState: {},
      heartbeat: {
        status: 'steady',
        reason: 'timer',
      },
      logs: [{
        timestamp: '2026-06-21T11:00:00.000Z',
        level: 'info',
        status: 'ok',
      }],
      collectSuggestions: async () => ({
        suggestions: [
          {
            id: 'unsafe-soul',
            canApply: true,
            applied: false,
            input: {
              source: 'alignment-evaluator',
              actions: [{ type: 'soul_append', content: 'Durable lesson: use a new voice.' }],
            },
          },
          {
            id: 'safe-model-card',
            canApply: true,
            applied: false,
            rating: 'down',
            updatedAt: '2026-06-21T11:30:00.000Z',
            input: {
              source: 'alignment-evaluator',
              trigger: 'model-card finding from alignment feedback',
              actions: [{
                type: 'model_card_note',
                content: 'Durable lesson: verify frontend work before finalizing.',
                reason: 'durable future routing guidance',
              }],
            },
          },
        ],
        meta: { count: 2 },
      }),
      applyUpdate,
      evaluateSuggestion: async (suggestion) => ({
        baseline: { version: 'TaskTrials/v1', trials: 3, corpusHash: 'same', results: [0, 1, 2].map((trial) => ({ caseId: 'edit', trial, passed: false })), metrics: { verifiedCompletion: 0, falseCompletion: 1, unnecessaryQuestions: 0, repeatedFailures: 0 } },
        candidate: { version: 'TaskTrials/v1', trials: 3, corpusHash: 'same', candidateHash: candidateHash(suggestion.input.actions), results: [0, 1, 2].map((trial) => ({ caseId: 'edit', trial, passed: true })), metrics: { verifiedCompletion: 1, falseCompletion: 0, unnecessaryQuestions: 0, repeatedFailures: 0 } },
      }),
      now: new Date('2026-06-21T12:00:00.000Z'),
      reason: 'test',
    });

    expect(result.status).toBe('applied');
    expect(result.lastDayKey).toBe('2026-06-21');
    expect(result.evidence.suggestions.count).toBe(2);
    expect(result.evidence.suggestions.safeCandidates).toBe(1);
    expect(result.applied).toEqual([expect.objectContaining({
      id: 'safe-model-card',
      resultId: 'self-reflection-1',
      applied: true,
    })]);
    expect(applyUpdate).toHaveBeenCalledWith(expect.objectContaining({
      source: 'alignment-evaluator daily-alignment',
      dryRun: false,
      apply: true,
    }));
    expect(applyUpdate.mock.calls[0][0].trigger).toContain('[daily-alignment:2026-06-21:safe-model-card]');
  });

  test('records a validated state when auto apply is off', async () => {
    const applyUpdate = jest.fn();
    const result = await runDailyFeedbackAlignment({
      config: {
        autoApply: false,
      },
      collectSuggestions: async () => ({
        suggestions: [{
          id: 'safe-note',
          canApply: true,
          applied: false,
          input: {
            actions: [{ type: 'agent_notes_append', content: 'Durable lesson: keep proof concrete.' }],
          },
        }],
      }),
      applyUpdate,
      now: new Date('2026-06-21T12:00:00.000Z'),
    });

    expect(result.status).toBe('validated');
    expect(result.applied).toEqual([]);
    expect(applyUpdate).not.toHaveBeenCalled();
  });
});

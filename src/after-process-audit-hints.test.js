const {
  buildApprovedAfterProcessHint,
  buildApprovedAfterProcessToolFailureHint,
  mergeApprovedAfterProcessHint,
  mergeApprovedAfterProcessToolFailureHint,
  resolveChatTimeAfterProcessAuditHints,
} = require('./after-process-audit-hints');

describe('after-process audit chat-time hints', () => {
  test('builds approved hints and applies matching one-turn orchestration overrides', () => {
    const hint = buildApprovedAfterProcessHint({
      sourceAudit: {
        auditId: 'after-audit-a',
        summary: 'Remote orchestration needs tighter proof.',
        toolSkillReview: {
          selectedSkills: ['remote-operations-system'],
          actualTools: ['remote-cli-agent'],
          missingTools: ['skill-context'],
          toolPolicyUpdates: ['Nudge skill-context before remote handoff.'],
        },
        learningReview: {
          durableLessons: ['Remote deploy completion needs route plus runtime proof.'],
        },
      },
      recommendation: {
        id: 'afr-a',
        flag: 'neuralWaveResearchMode',
        currentValue: false,
        suggestedValue: true,
        reason: 'The task had broad remote research and review needs.',
        confidence: 0.71,
      },
    });
    const session = {
      metadata: {
        afterProcessAuditHints: mergeApprovedAfterProcessHint([], hint),
      },
    };

    const decision = resolveChatTimeAfterProcessAuditHints({
      session,
      text: 'Review the remote deploy proof and tighten the route verification.',
      orchestrationConfig: {
        neuralWaveResearchMode: false,
      },
    });

    expect(decision.hasOverrides).toBe(true);
    expect(decision.overrides).toEqual({ neuralWaveResearchMode: true });
    expect(decision.matchedHints[0]).toEqual(expect.objectContaining({
      auditId: 'after-audit-a',
      flag: 'neuralWaveResearchMode',
      suggestedValue: true,
    }));
  });

  test('does not apply stale hints after the base flag value changes', () => {
    const hint = buildApprovedAfterProcessHint({
      sourceAudit: { auditId: 'after-audit-a', summary: 'Remote orchestration needs tighter proof.' },
      recommendation: {
        id: 'afr-a',
        flag: 'neuralWaveResearchMode',
        currentValue: false,
        suggestedValue: true,
        reason: 'Remote proof should use a heavier orchestration pass.',
      },
    });

    const decision = resolveChatTimeAfterProcessAuditHints({
      session: { metadata: { afterProcessAuditHints: [hint] } },
      text: 'Review the remote proof again.',
      orchestrationConfig: {
        neuralWaveResearchMode: true,
      },
    });

    expect(decision.hasOverrides).toBe(false);
    expect(decision.overrides).toEqual({});
  });

  test('builds approved failed-tool hints and returns matching tool recovery hints', () => {
    const hint = buildApprovedAfterProcessToolFailureHint({
      sourceAudit: {
        auditId: 'after-audit-tool-a',
        summary: 'Remote tool failed because task params were missing.',
        toolFailureReview: {
          failedToolCalls: [{
            toolId: 'remote-cli-agent',
            failureKind: 'bad_schema_or_missing_params',
            nextAction: 'replan_with_validated_params',
            recoveryHint: 'Fill required params before retry.',
          }],
        },
        learningReview: {
          durableLessons: ['Remote tool failures need validated task params before retry.'],
        },
      },
      suggestion: {
        id: 'srs-audit-a',
        input: {
          trigger: 'Failed tool call after completed work: remote-cli-agent',
          reflection: 'Reusable recovery lesson for remote-cli-agent.',
          actions: [{
            type: 'model_card_note',
            content: 'Tool failure learning: remote-cli-agent failed with bad_schema_or_missing_params; future runs should replan_with_validated_params.',
          }],
        },
      },
    });
    const session = {
      metadata: {
        afterProcessAuditToolHints: mergeApprovedAfterProcessToolFailureHint([], hint),
      },
    };

    const decision = resolveChatTimeAfterProcessAuditHints({
      session,
      text: 'Use the remote cli agent to fix the server, but make sure the params are valid.',
      orchestrationConfig: {},
    });

    expect(decision.hasOverrides).toBe(false);
    expect(decision.hasToolRecoveryHints).toBe(true);
    expect(decision.matchedToolFailureHints[0]).toEqual(expect.objectContaining({
      auditId: 'after-audit-tool-a',
      suggestionId: 'srs-audit-a',
      toolId: 'remote-cli-agent',
      failureKind: 'bad_schema_or_missing_params',
      nextAction: 'replan_with_validated_params',
    }));
  });

  test('matches minimal saved failed-tool hints from structured fields', () => {
    const session = {
      metadata: {
        afterProcessAuditToolHints: [{
          id: 'minimal-remote-cli-agent',
          auditId: 'after-audit-tool-minimal',
          suggestionId: 'srs-minimal',
          toolId: 'remote-cli-agent',
          failureKind: 'bad_schema_or_missing_params',
          nextAction: 'replan_with_validated_params',
          approvedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2999-01-01T00:00:00.000Z',
        }],
      },
    };

    const decision = resolveChatTimeAfterProcessAuditHints({
      session,
      text: 'Use remote-cli-agent again, and validate params before retrying.',
      orchestrationConfig: {},
    });

    expect(decision.hasToolRecoveryHints).toBe(true);
    expect(decision.matchedToolFailureHints[0]).toEqual(expect.objectContaining({
      auditId: 'after-audit-tool-minimal',
      suggestionId: 'srs-minimal',
      toolId: 'remote-cli-agent',
      failureKind: 'bad_schema_or_missing_params',
      nextAction: 'replan_with_validated_params',
    }));
  });
});

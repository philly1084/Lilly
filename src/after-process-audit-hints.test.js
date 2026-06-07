const {
  buildApprovedAfterProcessHint,
  mergeApprovedAfterProcessHint,
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
});

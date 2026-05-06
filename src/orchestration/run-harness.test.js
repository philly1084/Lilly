const { HarnessState } = require('./run-harness');

describe('HarnessState', () => {
  test('normalizes evidence and exports trace correlation metadata', () => {
    const harness = new HarnessState({
      runId: 'run-123',
      workflowName: 'Hourly improvement loop',
      evidence: [
        {
          summary: 'Nested trace regression passed',
          tool: 'jest',
          score: '1',
          passed: true,
        },
        {
          metadata: { ignored: true },
        },
      ],
    });

    harness.addToolEvent({ name: 'web-search', status: 'completed' });
    harness.addBlocker({ summary: 'Read-only workspace' });
    const added = harness.addEvidence({
      description: 'OpenAI tracing docs reviewed',
      url: 'https://openai.github.io/openai-agents-js/guides/tracing/',
      metadata: { checkedAt: '2026-05-02' },
    });

    expect(added).toEqual(expect.objectContaining({
      type: 'HarnessEvidence',
      id: 'evidence-2',
      summary: 'OpenAI tracing docs reviewed',
      source: 'https://openai.github.io/openai-agents-js/guides/tracing/',
    }));

    expect(harness.evidence[0]).toEqual(expect.objectContaining({
      summary: 'Nested trace regression passed',
      source: 'jest',
      score: 1,
      passed: true,
    }));

    expect(harness.toTraceMetadata()).toEqual({
      workflowName: 'Hourly improvement loop',
      groupId: 'run-123',
      runId: 'run-123',
      mode: 'respond',
      evidenceCount: 2,
      blockerCount: 1,
      toolEventCount: 1,
      diagnostics: expect.objectContaining({
        outcome: 'blocked',
        failureCategory: 'blocker',
        blockerCount: 1,
        evidenceCount: 2,
        evidenceQuality: expect.objectContaining({
          sourcedCount: 2,
          unsourcedCount: 0,
          sourceCoverage: 1,
        }),
      }),
    });

    expect(harness.toJSON()).toEqual(expect.objectContaining({
      workflowName: 'Hourly improvement loop',
      groupId: 'run-123',
      traceMetadata: expect.objectContaining({
        evidenceCount: 2,
        blockerCount: 1,
      }),
    }));
  });

  test('exports grader-compatible item and sample payload', () => {
    const harness = new HarnessState({
      runId: 'run-456',
      evidence: [{ summary: 'Tool call matched expected route', passed: true }],
      toolEvents: [{ name: 'remote-command', status: 'completed' }],
    });

    harness.addBlocker({ summary: 'No writable sandbox for live patch' });

    const payload = harness.toGradingPayload({
      item: { prompt: 'Route this work to the right tool' },
      referenceAnswer: 'Use remote-command for one-off kubectl inspection.',
      outputText: 'Use remote-command for kubectl inspection.',
      outputTools: [{ name: 'remote-command', arguments: { command: 'kubectl get pods -A' } }],
    });

    expect(payload).toEqual({
      item: {
        prompt: 'Route this work to the right tool',
        reference_answer: 'Use remote-command for one-off kubectl inspection.',
      },
      sample: {
        output_text: 'Use remote-command for kubectl inspection.',
        output_tools: [{ name: 'remote-command', arguments: { command: 'kubectl get pods -A' } }],
        choices: [],
      },
      evidence: [expect.objectContaining({
        summary: 'Tool call matched expected route',
        passed: true,
      })],
      blockers: [expect.objectContaining({
        summary: 'No writable sandbox for live patch',
      })],
      metadata: expect.objectContaining({
        runId: 'run-456',
        groupId: 'run-456',
        evidenceCount: 1,
        blockerCount: 1,
        toolEventCount: 1,
        diagnostics: expect.objectContaining({
          outcome: 'blocked',
          failureCategory: 'blocker',
        }),
      }),
    });
  });

  test('summarizes diagnostics for failed evidence and tool events', () => {
    const harness = new HarnessState({
      runId: 'run-789',
      evidence: [
        { summary: 'Primary route completed', passed: true },
        { summary: 'Screenshot contrast check failed', passed: false },
      ],
      toolEvents: [
        {
          type: 'llm-call',
          status: 'completed',
          usage: { total_tokens: 321 },
        },
        {
          type: 'tool-call',
          name: 'web-fetch',
          status: 'failed',
          retryCount: 2,
          metadata: { tokenUsage: { totalTokens: 12 } },
        },
      ],
    });

    expect(harness.getDiagnostics()).toEqual({
      outcome: 'failed',
      failureCategory: 'tool-event',
      blockerCount: 0,
      evidenceCount: 2,
      failedEvidenceCount: 1,
      failedToolEventCount: 1,
      evidenceQuality: {
        sourcedCount: 0,
        unsourcedCount: 2,
        verifiedCount: 1,
        staleCount: 0,
        sourceCoverage: 0,
        averageScore: null,
      },
      failedStepTypes: ['web-fetch'],
      retryCount: 2,
      tokenCount: 333,
    });
  });

  test('summarizes evidence source discipline for trace grading', () => {
    const harness = new HarnessState({
      runId: 'run-sources',
      evidence: [
        {
          summary: 'Official tracing guide reviewed',
          source: 'https://openai.github.io/openai-agents-js/guides/tracing/',
          score: 0.9,
          passed: true,
        },
        {
          summary: 'Screenshot check still needs rerun',
          metadata: { status: 'stale' },
          score: 0.3,
          passed: false,
        },
      ],
    });

    expect(harness.getDiagnostics().evidenceQuality).toEqual({
      sourcedCount: 1,
      unsourcedCount: 1,
      verifiedCount: 1,
      staleCount: 1,
      sourceCoverage: 0.5,
      averageScore: 0.6,
    });
  });
});

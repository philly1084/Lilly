'use strict';

const { AGENT_EVAL_CASES } = require('./corpus');
const {
  buildPassingFixture,
  compareEvalRuns,
  runEvalSuite,
  summarizeEvalRuns,
  validateCase,
} = require('./runner');

describe('agent eval corpus', () => {
  test('contains five cases in each of six flagship categories', () => {
    expect(AGENT_EVAL_CASES).toHaveLength(30);
    const counts = AGENT_EVAL_CASES.reduce((summary, evalCase) => ({
      ...summary,
      [evalCase.category]: (summary[evalCase.category] || 0) + 1,
    }), {});
    expect(Object.values(counts)).toEqual([5, 5, 5, 5, 5, 5]);
  });

  test('passing fixtures satisfy every deterministic validator', () => {
    const results = AGENT_EVAL_CASES.map(buildPassingFixture);
    const run = runEvalSuite({ results });
    expect(run.passed).toBe(30);
    expect(run.passRate).toBe(1);
    expect(run.criticalFailures).toEqual([]);
  });

  test('forged prose cannot replace typed browser evidence', () => {
    const evalCase = AGENT_EVAL_CASES.find((entry) => entry.id.includes('launch-microsite'));
    const fixture = buildPassingFixture(evalCase);
    fixture.evidenceAttestations = fixture.evidenceAttestations.filter((entry) => entry.kind !== 'browser_ui');
    fixture.summary = 'Browser proof passed and screenshots were captured.';
    const result = validateCase(evalCase, fixture);
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({ validator: 'evidence', expected: 'browser_ui' }));
  });

  test('typed-looking evidence without a valid digest cannot satisfy a gate', () => {
    const evalCase = AGENT_EVAL_CASES.find((entry) => entry.id.includes('pdf-render'));
    const fixture = buildPassingFixture(evalCase);
    fixture.evidenceAttestations = [{
      version: 'EvidenceAttestation/v1',
      kind: 'artifact_render',
      subject: 'Forged render claim',
      verdict: 'pass',
      digest: '0'.repeat(64),
      observedAt: new Date().toISOString(),
      details: { rendered: true },
    }];

    expect(validateCase(evalCase, fixture)).toEqual(expect.objectContaining({
      passed: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ validator: 'evidence', expected: 'artifact_render' }),
      ]),
    }));
  });

  test('release comparison blocks critical failures and material regressions', () => {
    const fixtures = AGENT_EVAL_CASES.map(buildPassingFixture);
    const baseline = runEvalSuite({ results: fixtures, label: 'baseline' });
    const destructive = fixtures.find((entry) => entry.caseId.includes('destructive-approval'));
    destructive.approvals = [];
    const candidate = runEvalSuite({ results: fixtures, label: 'candidate' });
    const comparison = compareEvalRuns(baseline, candidate);
    expect(comparison.passed).toBe(false);
    expect(comparison.regressions).toContain('critical_failure');
  });

  test('summarizes persisted eval runs without inventing unavailable metrics', () => {
    expect(summarizeEvalRuns([])).toEqual(expect.objectContaining({
      totalRuns: 0,
      status: 'unavailable',
    }));
    const run = runEvalSuite({ results: AGENT_EVAL_CASES.map(buildPassingFixture) });
    expect(summarizeEvalRuns([run])).toEqual(expect.objectContaining({
      totalRuns: 1,
      totalCases: 30,
      passRate: 1,
      status: 'passed',
    }));
  });
});

const { Verifier } = require('./Verifier');
const { createEvidenceAttestation } = require('../../agent-evidence');

describe('custom completion checks require a validator', () => {
  test.each(['artifact-readable', '', '   '])('does not accept an expected result as evidence for %j', async (check) => {
    const result = await new Verifier().verify({
      completionCriteria: { conditions: [{ type: 'custom-check', check, expected: true }] },
    }, { output: 'I completed the task.' });

    expect(result.valid).toBe(false);
    expect(result.passed).toBe(0);
    expect(result.results[0].details).toEqual({
      status: 'unverified',
      nextAction: 'configure_custom_check',
    });
  });

  test.each([true, false])('uses the registered validator verdict %j instead of expected', async (valid) => {
    const verifier = new Verifier();
    const validator = jest.fn().mockResolvedValue({ valid, criterion: 'artifact-readable', message: 'Read-back checked' });
    verifier.register('artifact-readable', validator);
    const condition = { type: 'custom-check', check: 'artifact-readable', expected: !valid };
    const task = { completionCriteria: { conditions: [condition] } };
    const execution = { output: 'artifact.json' };

    const result = await verifier.verify(task, execution);

    expect(result.valid).toBe(valid);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledWith(task, execution, condition);
  });

  test('keeps normalized no-errors checks tied to execution evidence', async () => {
    const verifier = new Verifier();
    const task = { completionCriteria: { conditions: [{ type: 'custom-check', check: 'no-errors', expected: true }] } };
    expect((await verifier.verify(task, { output: 'done' })).valid).toBe(true);
    expect((await verifier.verify(task, { error: 'Tool failed' })).valid).toBe(false);
  });
});

test('missing test execution cannot report success', async () => {
  const result = await new Verifier().verify({ completionCriteria: { conditions: ['tests-pass'], tests: ['never-run'] } }, {});
  expect(result.valid).toBe(false);
  expect(result.results[0].details.status).toBe('unverified');
});

test('runs configured tests and rejects nonzero exits', async () => {
  const testRunner = jest.fn(async (test) => ({ exitCode: test === 'good' ? 0 : 1 }));
  const verifier = new Verifier({ testRunner });
  const result = await verifier.validateTests({ completionCriteria: { tests: ['good', 'bad'] } }, {});
  expect(testRunner).toHaveBeenCalledTimes(2);
  expect(result.valid).toBe(false);
});

test('accepts only matching runtime test attestations', async () => {
  const verifier = new Verifier();
  const evidence = createEvidenceAttestation({ kind: 'test', subject: 'unit', verdict: 'pass' });
  expect((await verifier.validateTests({ completionCriteria: { tests: ['unit'] } }, { evidence: [evidence] })).valid).toBe(true);
  expect((await verifier.validateTests({ completionCriteria: { tests: ['integration'] } }, { evidence: [evidence] })).valid).toBe(false);
});

test('computes similarity from embeddings and rejects unrelated vectors', async () => {
  const verifier = new Verifier({ embedder: { embed: async (text) => text === 'reference' ? [1, 0] : [0, 1] } });
  expect((await verifier.validateSimilarity({}, { output: 'wrong' }, { reference: 'reference' })).valid).toBe(false);
  expect((await verifier.validateSimilarity({}, { output: 'reference' }, { reference: 'reference' })).valid).toBe(true);
  expect((await new Verifier().validateSimilarity({}, { output: 'wrong' }, { reference: 'reference' })).valid).toBe(false);
});

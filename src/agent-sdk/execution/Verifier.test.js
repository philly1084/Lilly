const { Verifier } = require('./Verifier');
const { createEvidenceAttestation } = require('../../agent-evidence');

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

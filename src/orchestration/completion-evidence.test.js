const { matchesCompletionEvidence, attestedCompletionEvidence } = require('./completion-evidence');
const { createEvidenceAttestation } = require('../agent-evidence');

test('creation and matching prose cannot satisfy verification', () => {
  expect(matchesCompletionEvidence({ type: 'artifact-created', verified: true }, { text: 'Validate the artifact' })).toBe(false);
  expect(matchesCompletionEvidence({ summary: 'deployment verified', verified: true }, { text: 'Deployment verified' })).toBe(false);
});

test('verification must match the target, state and method', () => {
  const criterion = { text: 'Validate the artifact', target: 'report.pdf', expectedState: 'readable', verificationMethod: 'artifact_render' };
  const evidence = { type: 'artifact-verified', target: 'report.pdf', expectedState: 'readable', verificationMethod: 'artifact_render', verified: true };
  expect(matchesCompletionEvidence(evidence, criterion)).toBe(true);
  expect(matchesCompletionEvidence({ ...evidence, target: 'other.pdf' }, criterion)).toBe(false);
  expect(matchesCompletionEvidence({ ...evidence, verified: false }, criterion)).toBe(false);
});

test('rejects tampered attestations', () => {
  const proof = createEvidenceAttestation({ kind: 'artifact_render', subject: 'report.pdf', verdict: 'pass' });
  expect(attestedCompletionEvidence({ evidence: [proof] })).toHaveLength(1);
  expect(attestedCompletionEvidence({ evidence: [{ ...proof, subject: 'other.pdf' }] })).toHaveLength(0);
});

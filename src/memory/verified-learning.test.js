jest.mock('./vector-store', () => ({ vectorStore: {} }));
const { MemoryService } = require('./memory-service');
const { createEvidenceAttestation } = require('../agent-evidence');

test('unspecified success and unverified completion never become learned skills', async () => {
  const service = new MemoryService();
  service.remember = jest.fn();
  await service.rememberLearnedSkill('session', { objective: 'Create report', toolEvents: [{ result: {} }] });
  expect(service.remember).not.toHaveBeenCalled();
});

test('verified learning preserves provenance, expiry, and recovered failures', async () => {
  const service = new MemoryService();
  service.remember = jest.fn(async (...args) => args);
  const proof = createEvidenceAttestation({ kind: 'artifact_render', subject: 'report.pdf', verdict: 'pass' });
  const result = await service.rememberLearnedSkill('session', {
    objective: 'Create a report', assistantText: 'Report rendered and checked.',
    toolEvents: [{ result: { success: false, error: 'temporary timeout' } },
      { toolCall: { function: { name: 'document-workflow' } }, result: { success: true, evidence: [proof] } }],
    completion: { criteria: [{ status: 'satisfied', evidenceIds: [proof.id] }] },
  });
  expect(result[3].learningOutcome).toBe('verified');
  expect(result[3].evidenceIds).toEqual([proof.id]);
  expect(Date.parse(result[3].revalidateAt)).toBeGreaterThan(Date.now());
  expect(result[1]).toContain('Recovered failure');
});

test('expired learned procedures are excluded from recall', () => {
  const service = new MemoryService();
  const result = service.selectRecallGroups([{ typeGroup: 'skill', metadata: { learningOutcome: 'verified', revalidateAt: '2000-01-01T00:00:00Z' } }]);
  expect(result.selected).toEqual([]);
});

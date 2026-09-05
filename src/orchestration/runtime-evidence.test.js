const { collectRuntimeEvidence } = require('./runtime-evidence');
test('does not convert command names or null exit codes into proof', () => {
  expect(collectRuntimeEvidence('remote-command', { command: 'npm test' }, { success: true, data: { exitCode: null } })).toEqual([]);
  expect(collectRuntimeEvidence('remote-cli-agent', {}, { success: true, data: { finalOutput: 'All tests passed', exitCode: 0 } })).toEqual([]);
});
test('observed failing tests get failing attestations', () => {
  const proof = collectRuntimeEvidence('remote-command', { command: 'npm test' }, { success: true, data: { exitCode: 1 } });
  expect(proof.find((entry) => entry.kind === 'test').verdict).toBe('fail');
});

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { runTaskTrials, compareTaskTrials } = require('./task-trials');

test('grades durable file state, detects false completion, and compares repeated trials', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-trial-test-'));
  const cases = [{ id: 'edit', prompt: 'Replace pending with done', files: { 'state.txt': 'pending' }, checks: [{ type: 'file', path: 'state.txt', equals: 'done' }] }];
  const actions = [{ type: 'agent_notes_append', content: 'Read back the requested state.' }];
  const baseline = await runTaskTrials({ cases, workspace, execute: async () => ({ status: 'completed', costUsd: 0.01 }) });
  const candidate = await runTaskTrials({ cases, workspace, actions, execute: async ({ workspace: root }) => {
    await fs.writeFile(path.join(root, 'state.txt'), 'done');
    return { status: 'completed', costUsd: 0.02 };
  } });
  expect(baseline.metrics.falseCompletion).toBe(1);
  expect(candidate.metrics.verifiedCompletion).toBe(1);
  expect(candidate.metrics.costPerSuccess).toBeCloseTo(0.02);
  expect(compareTaskTrials(baseline, candidate, actions).passed).toBe(true);
  expect(compareTaskTrials(candidate, candidate, actions).passed).toBe(false);
  expect(compareTaskTrials(baseline, candidate, []).passed).toBe(false);
});

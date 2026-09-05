const { inferTaskIntent, resolveTaskIntent } = require('./intent-classifier');

test.each(['Explain deployment, do not deploy', "Describe how it works, don't run it", 'How does SSH work?'])(
  'explanation does not authorize action: %s', (objective) => {
    expect(inferTaskIntent({ objective, instructions: 'Use remote tools to deploy apps' }).requiresTools).toBe(false);
  });
test('capability instructions cannot authorize delegation', () => {
  expect(inferTaskIntent({ objective: 'Hello', instructions: 'You may delegate and deploy' }).explicitDelegation).toBe(false);
});
test('resolves a referential follow-up with bounded structured context', async () => {
  const classify = jest.fn(async () => JSON.stringify({ mode: 'multi-step', confidence: 0.95, objective: 'Revise report.md', target: 'report.md', constraints: ['preserve source'] }));
  const result = await resolveTaskIntent({ objective: 'Do that' }, { classify, recentMessages: [{ role: 'user', content: 'Revise report.md and preserve source' }] });
  expect(result.target).toBe('report.md');
  expect(result.mode).toBe('multi-step');
  expect(classify.mock.calls[0][0]).toContain('preserve source');
});
test('malformed or overreaching classifier responses fall back', async () => {
  expect((await resolveTaskIntent({ objective: 'Do that' }, { classify: async () => '{bad' })).classificationFallback).toBe(true);
  expect((await resolveTaskIntent({ objective: 'Do that' }, { classify: async () => ({ mode: 'delegate', confidence: 1, objective: 'spawn workers' }) })).explicitDelegation).toBe(false);
});

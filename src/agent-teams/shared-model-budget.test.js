'use strict';
const { createSharedModelBudget } = require('./shared-model-budget');
test('three concurrent workers share exactly twenty admissions, including auxiliary calls', async () => {
  const budget = createSharedModelBudget({ maxCalls: 20, maxTimeMs: 300000 });
  let release; const hold = new Promise(resolve => { release = resolve; });
  try {
    const calls = Array.from({ length: 20 }, () => budget.run(() => hold));
    expect(budget.snapshot()).toMatchObject({ calls: 20, active: 20 });
    await expect(budget.run(async () => 'extra')).rejects.toMatchObject({ code: 'team_shared_model_budget' });
    release('done'); await Promise.all(calls);
    expect(budget.snapshot().active).toBe(0);
  } finally { budget.close(); }
});
test('failures consume budget and cannot be retried outside its count', async () => {
  const budget = createSharedModelBudget({ maxCalls: 1, maxTimeMs: 1000 });
  try {
    await expect(budget.run(async () => { throw new Error('provider'); })).rejects.toThrow('provider');
    await expect(budget.run(async () => {})).rejects.toMatchObject({ code: 'team_shared_model_budget' });
  } finally { budget.close(); }
});
test('deadline aborts in-flight requests but does not claim they have settled', async () => {
  jest.useFakeTimers();
  const budget = createSharedModelBudget({ maxCalls: 20, maxTimeMs: 300000 });
  let release; let requestSignal;
  const work = budget.run(signal => { requestSignal = signal; return new Promise(resolve => { release = resolve; }); });
  jest.advanceTimersByTime(300000);
  expect(requestSignal.aborted).toBe(true); expect(budget.snapshot().active).toBe(1);
  await expect(budget.run(async () => {})).rejects.toMatchObject({ code: 'team_shared_model_budget' });
  release(); await work; budget.close(); jest.useRealTimers();
});
test('closed and pre-aborted runs admit no model calls', async () => {
  const abort = new AbortController(); abort.abort();
  const budget = createSharedModelBudget({ maxCalls: 20, maxTimeMs: 1000, signal: abort.signal });
  await expect(budget.run(async () => {})).rejects.toThrow(); budget.close();
  expect(budget.snapshot().calls).toBe(0);
});

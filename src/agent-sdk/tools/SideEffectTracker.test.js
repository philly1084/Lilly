'use strict';

const { createSideEffectTracker } = require('./SideEffectTracker');

describe('SideEffectTracker factory', () => {
  test('creates isolated trackers with legacy handler aliases', () => {
    const first = createSideEffectTracker();
    const second = createSideEffectTracker();

    first.recordNetworkCall('https://example.test/health', 'GET', { status: 200 });
    first.recordExecution('node --check src/app.js', { exitCode: 0 });

    expect(first.getAll().networkCalls).toHaveLength(1);
    expect(first.getAll().executions).toHaveLength(1);
    expect(second.getAll()).toEqual({
      reads: [],
      writes: [],
      networkCalls: [],
      executions: [],
    });
  });
});

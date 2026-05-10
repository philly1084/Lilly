'use strict';

const {
  buildPlan,
  parseArgs,
  percentile,
  summarizeResults,
} = require('./load-release-gate');

describe('load-release-gate', () => {
  test('builds a sanitized release gate plan without exposing the token', () => {
    const options = parseArgs([
      '--url', 'https://lilly.secdevsolutions.help/',
      '--duration', '12',
      '--concurrency', '3',
      '--max-p95', '1500',
      '--token', 'secret-token',
    ], {});

    const plan = buildPlan(options);

    expect(plan.target).toBe('https://lilly.secdevsolutions.help');
    expect(plan.durationSeconds).toBe(12);
    expect(plan.concurrency).toBe(3);
    expect(plan.maxP95Ms).toBe(1500);
    expect(plan.hasToken).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('secret-token');
    expect(plan.endpoints.map((endpoint) => endpoint.path)).toEqual([
      '/health',
      '/web-chat/',
      '/api/chat',
    ]);
  });

  test('reports authenticated endpoints when no bearer token is configured', () => {
    const options = parseArgs(['--url', 'http://localhost:3000'], {});

    const plan = buildPlan(options);

    expect(plan.hasToken).toBe(false);
    expect(plan.missingAuthEndpoints).toEqual(['frontend', 'chat']);
  });

  test('supports smoke mode and static-only checks', () => {
    const options = parseArgs(['--smoke', '--skip-chat'], {});

    const plan = buildPlan(options);

    expect(plan.durationSeconds).toBe(5);
    expect(plan.concurrency).toBe(1);
    expect(plan.endpoints.map((endpoint) => endpoint.name)).toEqual(['health', 'frontend']);
  });

  test('computes percentile from sorted latency samples', () => {
    expect(percentile([500, 100, 200, 800, 300], 95)).toBe(800);
    expect(percentile([500, 100, 200, 800, 300], 50)).toBe(300);
    expect(percentile([], 95)).toBe(0);
  });

  test('fails clearly when error rate or p95 threshold is exceeded', () => {
    const summary = summarizeResults({
      health: {
        total: 4,
        ok: 3,
        failed: 1,
        latencies: [100, 110, 120, 130],
        errors: { 'HTTP 503': 1 },
      },
      chat: {
        total: 2,
        ok: 2,
        failed: 0,
        latencies: [1000, 2500],
        errors: {},
      },
    }, {
      maxErrorRate: 0.1,
      maxP95Ms: 2000,
    });

    expect(summary.passed).toBe(false);
    expect(summary.failures).toEqual([
      'Error rate 16.67% exceeded 10.00%.',
      'chat p95 2500ms exceeded 2000ms.',
    ]);
  });
});

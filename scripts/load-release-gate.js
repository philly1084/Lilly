#!/usr/bin/env node

'use strict';

const DEFAULTS = {
  url: 'http://localhost:3000',
  durationSeconds: 30,
  concurrency: 4,
  maxP95Ms: 2000,
  maxErrorRate: 0.02,
  timeoutMs: 10000,
  tokenEnv: 'KIMIBUILT_LOAD_TEST_TOKEN',
  chatMessage: 'Health check: reply with a short readiness confirmation.',
};

const ENDPOINTS = [
  {
    name: 'health',
    method: 'GET',
    path: '/health',
    auth: false,
  },
  {
    name: 'frontend',
    method: 'GET',
    path: '/web-chat/',
    auth: true,
  },
  {
    name: 'chat',
    method: 'POST',
    path: '/api/chat',
    auth: true,
    body(options) {
      return {
        message: options.chatMessage,
        stream: false,
        metadata: {
          clientSurface: 'load-release-gate',
        },
      };
    },
  },
];

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printUsage() {
  console.log(`Usage: node scripts/load-release-gate.js [options]

Options:
  --url <url>                 Target origin (default: ${DEFAULTS.url})
  --duration <seconds>        Test duration (default: ${DEFAULTS.durationSeconds})
  --concurrency <count>       Concurrent workers (default: ${DEFAULTS.concurrency})
  --max-p95 <ms>              Max allowed p95 latency per endpoint (default: ${DEFAULTS.maxP95Ms})
  --max-error-rate <ratio>    Max allowed total error rate (default: ${DEFAULTS.maxErrorRate})
  --timeout <ms>              Per-request timeout (default: ${DEFAULTS.timeoutMs})
  --token <value>             Bearer token for authenticated routes
  --token-env <name>          Env var containing bearer token (default: ${DEFAULTS.tokenEnv})
  --skip-chat                 Skip /api/chat for health/static-only checks
  --smoke                     Short 5s, 1-worker check with the same pass/fail rules
  --dry-run                   Print sanitized plan without sending requests
  --help                      Show this help
`);
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--url') {
      options.url = next() || options.url;
    } else if (arg === '--duration') {
      options.durationSeconds = parsePositiveNumber(next(), options.durationSeconds);
    } else if (arg === '--concurrency') {
      options.concurrency = Math.max(1, Math.floor(parsePositiveNumber(next(), options.concurrency)));
    } else if (arg === '--max-p95') {
      options.maxP95Ms = parsePositiveNumber(next(), options.maxP95Ms);
    } else if (arg === '--max-error-rate') {
      options.maxErrorRate = parsePositiveNumber(next(), options.maxErrorRate);
    } else if (arg === '--timeout') {
      options.timeoutMs = parsePositiveNumber(next(), options.timeoutMs);
    } else if (arg === '--token') {
      options.token = next() || '';
    } else if (arg === '--token-env') {
      options.tokenEnv = next() || options.tokenEnv;
    } else if (arg === '--skip-chat') {
      options.skipChat = true;
    } else if (arg === '--smoke') {
      options.smoke = true;
      options.durationSeconds = 5;
      options.concurrency = 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.token = options.token || env[options.tokenEnv] || '';
  options.url = String(options.url || DEFAULTS.url).replace(/\/+$/, '');
  return options;
}

function buildPlan(options = {}) {
  const endpoints = ENDPOINTS
    .filter((endpoint) => !(endpoint.name === 'chat' && options.skipChat))
    .map((endpoint) => ({
      ...endpoint,
      url: `${options.url}${endpoint.path}`,
    }));

  const missingAuthEndpoints = endpoints
    .filter((endpoint) => endpoint.auth && !options.token)
    .map((endpoint) => endpoint.name);

  return {
    target: options.url,
    durationSeconds: options.durationSeconds,
    concurrency: options.concurrency,
    maxP95Ms: options.maxP95Ms,
    maxErrorRate: options.maxErrorRate,
    timeoutMs: options.timeoutMs,
    tokenEnv: options.tokenEnv,
    hasToken: Boolean(options.token),
    endpoints: endpoints.map((endpoint) => ({
      name: endpoint.name,
      method: endpoint.method,
      path: endpoint.path,
      auth: endpoint.auth,
    })),
    missingAuthEndpoints,
  };
}

function percentile(values = [], percentileValue = 95) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function createEmptyStats() {
  return {
    total: 0,
    ok: 0,
    failed: 0,
    latencies: [],
    errors: {},
  };
}

function summarizeResults(endpointStats = {}, options = {}) {
  const endpointSummaries = Object.entries(endpointStats).map(([name, stats]) => ({
    name,
    total: stats.total,
    ok: stats.ok,
    failed: stats.failed,
    p95Ms: Math.round(percentile(stats.latencies, 95)),
    minMs: stats.latencies.length ? Math.round(Math.min(...stats.latencies)) : 0,
    maxMs: stats.latencies.length ? Math.round(Math.max(...stats.latencies)) : 0,
    errors: stats.errors,
  }));

  const total = endpointSummaries.reduce((sum, entry) => sum + entry.total, 0);
  const failed = endpointSummaries.reduce((sum, entry) => sum + entry.failed, 0);
  const errorRate = total > 0 ? failed / total : 1;
  const failures = [];

  if (total === 0) {
    failures.push('No requests completed.');
  }

  if (errorRate > options.maxErrorRate) {
    failures.push(`Error rate ${formatPercent(errorRate)} exceeded ${formatPercent(options.maxErrorRate)}.`);
  }

  for (const entry of endpointSummaries) {
    if (entry.p95Ms > options.maxP95Ms) {
      failures.push(`${entry.name} p95 ${entry.p95Ms}ms exceeded ${options.maxP95Ms}ms.`);
    }
  }

  return {
    passed: failures.length === 0,
    total,
    failed,
    errorRate,
    endpoints: endpointSummaries,
    failures,
  };
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

async function timedFetch(endpoint, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = Date.now();

  try {
    const headers = {
      Accept: endpoint.name === 'chat' ? 'application/json' : '*/*',
      ...(endpoint.auth && options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    };
    const body = typeof endpoint.body === 'function' ? endpoint.body(options) : null;
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(endpoint.url, {
      method: endpoint.method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    await response.arrayBuffer();
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || 'response failed'}`.trim());
    }

    return { ok: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    return {
      ok: false,
      latencyMs,
      error: error.name === 'AbortError' ? `Timeout after ${options.timeoutMs}ms` : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runLoadGate(options = {}) {
  const endpoints = ENDPOINTS
    .filter((endpoint) => !(endpoint.name === 'chat' && options.skipChat))
    .map((endpoint) => ({
      ...endpoint,
      url: `${options.url}${endpoint.path}`,
    }));
  const stats = Object.fromEntries(endpoints.map((endpoint) => [endpoint.name, createEmptyStats()]));
  const deadline = Date.now() + (options.durationSeconds * 1000);
  let nextEndpointIndex = 0;

  async function worker() {
    while (Date.now() < deadline) {
      const endpoint = endpoints[nextEndpointIndex % endpoints.length];
      nextEndpointIndex += 1;
      const result = await timedFetch(endpoint, options);
      const entry = stats[endpoint.name];
      entry.total += 1;
      entry.latencies.push(result.latencyMs);
      if (result.ok) {
        entry.ok += 1;
      } else {
        entry.failed += 1;
        entry.errors[result.error] = (entry.errors[result.error] || 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  return summarizeResults(stats, options);
}

function printPlan(plan) {
  console.log('[LoadGate] Plan');
  console.log(JSON.stringify(plan, null, 2));
}

function printSummary(summary) {
  console.log(`[LoadGate] ${summary.passed ? 'PASS' : 'FAIL'} total=${summary.total} failed=${summary.failed} errorRate=${formatPercent(summary.errorRate)}`);
  for (const endpoint of summary.endpoints) {
    console.log(`[LoadGate] ${endpoint.name} total=${endpoint.total} ok=${endpoint.ok} failed=${endpoint.failed} p95=${endpoint.p95Ms}ms min=${endpoint.minMs}ms max=${endpoint.maxMs}ms`);
    for (const [message, count] of Object.entries(endpoint.errors || {}).slice(0, 5)) {
      console.log(`[LoadGate] ${endpoint.name} error x${count}: ${message}`);
    }
  }
  for (const failure of summary.failures) {
    console.log(`[LoadGate] failure: ${failure}`);
  }
}

async function main() {
  try {
    const options = parseArgs();
    if (options.help) {
      printUsage();
      return;
    }

    const plan = buildPlan(options);
    if (plan.missingAuthEndpoints.length > 0) {
      console.warn(`[LoadGate] No bearer token configured for authenticated endpoints: ${plan.missingAuthEndpoints.join(', ')}.`);
      console.warn(`[LoadGate] Set ${options.tokenEnv} or pass --token. The token value is never printed.`);
    }

    if (options.dryRun) {
      printPlan(plan);
      return;
    }

    printPlan(plan);
    const summary = await runLoadGate(options);
    printSummary(summary);
    if (!summary.passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[LoadGate] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULTS,
  ENDPOINTS,
  buildPlan,
  parseArgs,
  percentile,
  summarizeResults,
};

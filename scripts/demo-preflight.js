#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { AGENT_EVAL_CASES } = require('../src/agent-evals/corpus');

const DEFAULT_BASE_URL = 'http://localhost:3000';
const OFFLINE_FILES = [
  'frontend/launchpad/index.html',
  'frontend/web-chat/app.html',
  'frontend/notes-notion/index.html',
  'frontend/canvas-excalidraw/index.html',
  'frontend/agent-dashboard/index.html',
  'src/agent-evals/corpus.js',
  'src/agent-evals/runner.js',
  'src/agent-runs/service.js',
  'src/tool-invocation.js',
  'src/agent-evidence.js',
];

function buildHeaders() {
  const headers = { Accept: 'application/json, text/html;q=0.9' };
  if (process.env.KIMIBUILT_DEMO_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.KIMIBUILT_DEMO_BEARER_TOKEN}`;
  }
  if (process.env.KIMIBUILT_DEMO_COOKIE) {
    headers.Cookie = process.env.KIMIBUILT_DEMO_COOKIE;
  }
  return headers;
}

async function checkEndpoint(baseUrl, target) {
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL(target.path, baseUrl), {
      method: target.method || 'GET',
      headers: {
        ...buildHeaders(),
        ...(target.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(target.body ? { body: JSON.stringify(target.body) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(process.env.KIMIBUILT_DEMO_TIMEOUT_MS || 8000)),
    });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '');
    const accepted = target.statuses.includes(response.status);
    const ready = target.validate ? target.validate(body, response) : true;
    return {
      id: target.id,
      path: target.path,
      status: accepted && ready ? 'pass' : 'fail',
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      detail: accepted && ready ? target.success : (response.status === 401 ? 'Authentication required.' : target.failure),
    };
  } catch (error) {
    return {
      id: target.id,
      path: target.path,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      detail: error.message,
    };
  }
}

async function main() {
  const offlineOnly = process.argv.includes('--offline');
  const fileChecks = OFFLINE_FILES.map((relativePath) => ({
    id: `file:${relativePath}`,
    status: fs.existsSync(path.resolve(process.cwd(), relativePath)) ? 'pass' : 'fail',
    detail: relativePath,
  }));
  const checks = [...fileChecks];
  const categoryCounts = AGENT_EVAL_CASES.reduce((counts, evalCase) => {
    counts[evalCase.category] = (counts[evalCase.category] || 0) + 1;
    return counts;
  }, {});
  checks.push({
    id: 'eval-corpus-contract',
    status: AGENT_EVAL_CASES.length === 30
      && Object.keys(categoryCounts).length === 6
      && Object.values(categoryCounts).every((count) => count === 5)
      ? 'pass'
      : 'fail',
    detail: `${AGENT_EVAL_CASES.length} cases across ${Object.keys(categoryCounts).length} categories.`,
  });
  const baseUrl = String(process.env.KIMIBUILT_DEMO_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');

  if (!offlineOnly) {
    const targets = [
      { id: 'health', path: '/health', statuses: [200], success: 'Runtime dependencies healthy.', failure: 'Health endpoint is not ready.', validate: (body) => body?.status === 'ok' || body?.status === 'healthy' },
      { id: 'models', path: '/api/models', statuses: [200], success: 'Model catalog available.', failure: 'Model catalog unavailable.' },
      {
        id: 'tools',
        path: '/api/tools/available?includeAll=true',
        statuses: [200],
        success: 'Tool readiness available.',
        failure: 'Tool readiness unavailable.',
        validate: (body) => body?.success === true && Array.isArray(body?.data),
      },
      {
        id: 'sandbox',
        path: '/api/tools/available?includeAll=true',
        statuses: [200],
        success: 'Sandbox tool is registered; execution is checked by the live golden mission.',
        failure: 'Sandbox tool registration is unavailable.',
        validate: (body) => (body?.data || []).some((tool) => (
          tool?.id === 'code-sandbox' && tool?.readiness?.status !== 'unavailable'
        )),
      },
      {
        id: 'remote-runner',
        path: '/api/runners',
        statuses: [200],
        success: 'At least one remote runner is registered; a live mission must still prove execution.',
        failure: 'No remote runner is registered.',
        validate: (body) => Number(body?.count || 0) > 0,
      },
      {
        id: 'preview-access-boundary',
        path: '/api/sandbox-workspaces/__demo_preflight_missing__/preview-access/invalid/index.html',
        statuses: [404],
        success: 'Preview access route rejects a missing workspace.',
        failure: 'Preview access boundary is not enforcing workspace existence.',
      },
      {
        id: 'agent-run-contract',
        path: '/api/agent-runs',
        method: 'POST',
        body: {
          objective: 'Demo preflight contract only; perform no external side effects.',
          surface: 'demo-preflight',
          mode: 'contract-check',
          idempotencyKey: `demo-preflight-${Date.now()}`,
        },
        statuses: [200, 201],
        success: 'AgentRun/v1 creation contract is available; this is not a golden mission execution.',
        failure: 'AgentRun creation contract is unavailable.',
        validate: (body) => body?.run?.version === 'AgentRun/v1' && Boolean(body?.run?.id),
      },
      { id: 'launchpad', path: '/', statuses: [200], success: 'Outcome launchpad available.', failure: 'Launchpad unavailable.' },
      { id: 'web-chat', path: '/web-chat/?__kb_full=1', statuses: [200], success: 'Web Chat available.', failure: 'Web Chat unavailable.' },
      { id: 'notes', path: '/notes/?__kb_full=1', statuses: [200], success: 'Notes available.', failure: 'Notes unavailable.' },
      { id: 'canvas', path: '/canvas/?__kb_full=1', statuses: [200], success: 'Canvas available.', failure: 'Canvas unavailable.' },
      { id: 'admin', path: '/admin/', statuses: [200], success: 'Admin available.', failure: 'Admin unavailable.' },
    ];
    checks.push(...await Promise.all(targets.map((target) => checkEndpoint(baseUrl, target))));
  }

  const failed = checks.filter((check) => check.status !== 'pass');
  const report = {
    schemaVersion: 'DemoPreflightReport/v1',
    mode: offlineOnly ? 'offline' : 'live',
    scope: offlineOnly ? 'static-contract-readiness' : 'runtime-readiness',
    baseUrl: offlineOnly ? null : baseUrl,
    createdAt: new Date().toISOString(),
    passed: failed.length === 0,
    releaseEligible: false,
    qualification: 'Run demo:smoke:live three consecutive times in the warmed deployment before release eligibility can be assessed.',
    checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(`[DemoPreflight] ${error.message}`);
  process.exitCode = 1;
});

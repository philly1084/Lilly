#!/usr/bin/env node
'use strict';

const DEFAULT_BASE_URL = 'http://localhost:3000';

function buildHeaders() {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (process.env.KIMIBUILT_DEMO_BEARER_TOKEN) headers.Authorization = `Bearer ${process.env.KIMIBUILT_DEMO_BEARER_TOKEN}`;
  if (process.env.KIMIBUILT_DEMO_COOKIE) headers.Cookie = process.env.KIMIBUILT_DEMO_COOKIE;
  return headers;
}

async function request(baseUrl, targetPath, options = {}) {
  const response = await fetch(new URL(targetPath, baseUrl), {
    ...options,
    headers: { ...buildHeaders(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(Number(process.env.KIMIBUILT_DEMO_TIMEOUT_MS || 30000)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${targetPath} returned ${response.status}: ${payload?.error?.message || payload?.error || 'request failed'}`);
  }
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runContractSmoke(baseUrl) {
  const startedAt = Date.now();
  const createKey = `demo-contract-${Date.now()}`;
  const created = await request(baseUrl, '/api/agent-runs', {
    method: 'POST',
    body: JSON.stringify({
      objective: 'Verify the Trustworthy Mission Control run contract without external side effects.',
      surface: 'demo-smoke',
      mode: 'contract-smoke',
      idempotencyKey: createKey,
      metadata: { dryRun: true, clearlyLabeledReplay: false },
    }),
  });
  const run = created.run || created.data || created;
  assert(run?.id, 'AgentRun creation did not return a run id.');
  const duplicateCreate = await request(baseUrl, '/api/agent-runs', {
    method: 'POST',
    body: JSON.stringify({
      objective: 'Verify the Trustworthy Mission Control run contract without external side effects.',
      surface: 'demo-smoke',
      mode: 'contract-smoke',
      idempotencyKey: createKey,
    }),
  });
  assert(duplicateCreate.duplicate === true && duplicateCreate.run?.id === run.id, 'AgentRun creation idempotency returned a different run.');
  const fetched = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(run.id)}`);
  assert((fetched.run || fetched.data || fetched).id === run.id, 'Fetched AgentRun identity does not match creation.');
  const pauseKey = `demo-pause-${run.id}`;
  const paused = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(run.id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action: 'pause', reason: 'Contract smoke checkpoint.', idempotencyKey: pauseKey }),
  });
  assert(paused.run?.state === 'waiting_for_approval', 'Pause did not enter waiting_for_approval.');
  const duplicatePause = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(run.id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action: 'pause', reason: 'Duplicate checkpoint.', idempotencyKey: pauseKey }),
  });
  assert(duplicatePause.duplicate === true, 'Repeated pause did not deduplicate.');
  const resumed = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(run.id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action: 'resume', reason: 'Contract smoke resume.', idempotencyKey: `demo-resume-${run.id}` }),
  });
  assert(['planning', 'executing'].includes(resumed.run?.state), 'Resume did not restore an executable state.');
  const events = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(run.id)}/events?after=0`);
  const eventRows = events.events || events.data || [];
  const cursors = eventRows.map((event) => Number(event.cursor));
  assert(cursors.length >= 3, 'Expected create, pause, and resume events.');
  assert(cursors.every((cursor, index) => Number.isInteger(cursor) && (index === 0 || cursor > cursors[index - 1])), 'Event cursors are missing, duplicated, or out of order.');
  const afterFirst = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(run.id)}/events?after=${cursors[0]}`);
  assert((afterFirst.events || []).every((event) => Number(event.cursor) > cursors[0]), 'Event replay ignored the after cursor.');
  const forkKey = `demo-fork-${run.id}`;
  const forked = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(run.id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({
      action: 'fork',
      objective: 'Verify fork lineage only; perform no external work.',
      idempotencyKey: forkKey,
    }),
  });
  assert(forked.forkedRun?.id, 'Fork did not return a child run.');
  assert(forked.forkedRun.parentRunId === run.id, 'Fork lineage does not identify its parent.');
  const duplicateFork = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(run.id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action: 'fork', objective: 'Ignored duplicate.', idempotencyKey: forkKey }),
  });
  assert(duplicateFork.duplicate === true && duplicateFork.forkedRun?.id === forked.forkedRun.id, 'Fork idempotency created a second child.');
  return {
    mode: 'contract-smoke',
    passed: true,
    runId: run.id,
    state: resumed.run.state,
    eventCount: eventRows.length,
    eventCursor: cursors[cursors.length - 1],
    pauseDeduplicated: duplicatePause.duplicate === true,
    forkRunId: forked.forkedRun.id,
    forkParentRunId: forked.forkedRun.parentRunId,
    forkDeduplicated: duplicateFork.duplicate === true,
    createDeduplicated: duplicateCreate.duplicate === true,
    durationMs: Date.now() - startedAt,
  };
}

async function runLivePreviewSmoke(baseUrl) {
  const allowDeploy = process.env.KIMIBUILT_DEMO_ALLOW_DEPLOY === '1';
  const startedAt = Date.now();
  const prompt = allowDeploy
    ? 'Build a concise responsive product microsite in an isolated demo target, verify desktop and mobile, and return the preview or public URL with proof.'
    : 'Build a concise responsive product microsite as a preview artifact only. Verify desktop and mobile. Do not push, deploy publicly, or change external systems.';
  const created = await request(baseUrl, '/api/agent-runs', {
    method: 'POST',
    body: JSON.stringify({
      objective: prompt,
      surface: 'demo-smoke',
      mode: 'mission',
      idempotencyKey: `demo-live-${Date.now()}`,
    }),
  });
  const createdRunId = created.run?.id;
  assert(createdRunId, 'Live smoke could not create a canonical AgentRun.');
  const payload = await request(baseUrl, '/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: prompt,
      stream: false,
      clientSurface: 'demo-smoke',
      metadata: {
        demoMission: true,
        missionMode: true,
        agentRunId: createdRunId,
        allowPublicDeployment: allowDeploy,
        requiredEvidenceKinds: ['artifact_render', 'browser_ui'],
      },
    }),
  });
  const artifacts = payload.artifacts || payload.data?.artifacts || [];
  const runPayload = await request(baseUrl, `/api/agent-runs/${encodeURIComponent(createdRunId)}`);
  const canonicalRun = runPayload.run || {};
  const proofPack = canonicalRun.proofPack || {};
  const artifactCount = Array.isArray(artifacts) ? artifacts.length : 0;
  const durationMs = Date.now() - startedAt;
  const publicUrl = payload.publicUrl || payload.data?.publicUrl || proofPack.liveUrl || null;
  assert(canonicalRun.state === 'completed', `Golden mission ended in ${canonicalRun.state || 'unknown'} instead of completed.`);
  assert(artifactCount > 0 || proofPack.artifacts?.length > 0, 'Golden mission produced no artifact.');
  assert(proofPack.status === 'verified', `Golden mission Proof Pack is ${proofPack.status || 'unavailable'}, not verified.`);
  assert((proofPack.screenshots || []).length > 0, 'Golden mission has no screenshot receipt.');
  assert(publicUrl, 'Golden mission has no preview or public URL.');
  assert(durationMs <= (allowDeploy ? 180000 : 60000), 'Golden mission exceeded its latency target.');
  if (allowDeploy) assert(/^https:\/\//i.test(publicUrl), 'Public deployment did not return an HTTPS URL.');
  return {
    mode: allowDeploy ? 'live-public-demo' : 'live-preview-demo',
    passed: true,
    durationMs,
    artifactCount: Math.max(artifactCount, proofPack.artifacts?.length || 0),
    runId: createdRunId,
    publicUrl,
    proofStatus: proofPack.status,
    screenshotCount: proofPack.screenshots.length,
    clearlyLabeledReplay: false,
  };
}

async function main() {
  const baseUrl = String(process.env.KIMIBUILT_DEMO_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const live = process.argv.includes('--live') || process.env.KIMIBUILT_DEMO_LIVE === '1';
  const result = live ? await runLivePreviewSmoke(baseUrl) : await runContractSmoke(baseUrl);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'DemoSmokeReport/v1',
    baseUrl,
    createdAt: new Date().toISOString(),
    ...result,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`[DemoSmoke] ${error.message}`);
  process.exitCode = 1;
});

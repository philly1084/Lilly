#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process'); const execute = require('node:util').promisify(execFile);
const { TeamStore } = require('../src/agent-teams/store');
const { ArtifactStore } = require('../src/artifacts/artifact-store');
const { TeamService } = require('../src/agent-teams/service');
const { TeamRunner } = require('../src/agent-teams/runner');
const { createTeamWorker, readBackArtifact } = require('../src/agent-teams/worker');
const { GrokWorkerBroker } = require('../src/agent-teams/worker-broker');
const { createGrokTaskLoop } = require('../src/agent-teams/grok-loop');
const { createLiveTestModelAdapter } = require('../src/agent-teams/live-test-model-adapter');
const { runLiveTeamScenario } = require('../src/agent-teams/live-team-scenario');
const { createLiveTestSupervisor } = require('./lilly-live-test-supervisor');
const { startLiveModelClient } = require('./lilly-live-model-client');
const { startTeamBrowser } = require('./lilly-team-browser-proof');
const { runIsolated } = require('./lilly-team-postgres-proof');
const { traceToolDispatch } = require('../src/agent-teams/live-tool-trace');
const sha = data => createHash('sha256').update(data).digest('hex');
async function podman(args, allowed = [0]) {
  try { const value = await execute('/usr/bin/podman', args, { timeout: 25000, maxBuffer: 512 * 1024 }); return { status: 0, output: value.stdout.trim() }; }
  catch (error) { if (allowed.includes(error.code)) return { status: error.code, output: '' }; throw Object.assign(new Error('Container operation failed'), { code: 'live_container_failed' }); }
}
async function test(pool, otherPool, pod, { maxCalls = 20, maxTimeMs = 300000, model } = {}) {
  assert(Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 20);
  assert(Number.isSafeInteger(maxTimeMs) && maxTimeMs >= 1000 && maxTimeMs <= 300000);
  const source = path.resolve(__dirname, '..'); const root = fs.mkdtempSync('/tmp/lilly-grok-team-proof.'); fs.chmodSync(root, 0o700);
  const report = { proofId: randomUUID(), root, passed: false, liveInference: true, bufferedProviderEvents: true,
    globalSchedulerEnabled: false, maxModelCalls: maxCalls, maxTimeMs, toolTrace: [], imageRequests: 0, peakActive: 0, modelProtocol: [] };
  process.stdout.write(`LIVE_TEST_HANDLE ${JSON.stringify({ proofId: report.proofId, root })}\n`);
  const controller = new AbortController(); const started = Date.now(); const timer = setTimeout(() => controller.abort(), maxTimeMs);
  let browser; let supervisor; let runner; let client; let adapter; let service; let teamId; let broker;
  try {
    const database = value => ({ query: (...args) => value.query(...args), getPool: () => value });
    const store = new TeamStore({ database: database(pool) });
    const artifacts = new ArtifactStore({ database: database(pool) });
    const ddl = fs.readFileSync(path.join(source, 'src/postgres.js'), 'utf8').match(/CREATE TABLE IF NOT EXISTS artifacts \([\s\S]*?\n\s*\)/)?.[0]; assert(ddl);
    await pool.query('CREATE TABLE sessions (id TEXT PRIMARY KEY, metadata JSONB NOT NULL)'); await pool.query(ddl); await store.initialize();
    const artifactService = { createStoredArtifact: input => artifacts.create({ ...input, id: input.reservedArtifactId, contentBuffer: input.buffer,
      sha256: sha(input.buffer), extension: path.extname(input.filename).slice(1), mimeType: 'text/markdown', sizeBytes: input.buffer.length }),
    getArtifact: (id, options) => artifacts.get(id, options) };
    service = new TeamService({ store, verifyArtifact: async scope => readBackArtifact(await artifactService.getArtifact(scope.artifactId, { includeContent: true }), scope) });
    client = startLiveModelClient({ pod, signal: controller.signal, model }); report.model = await client.ready;
    if (model) assert.equal(report.model, model);
    if (report.model === 'gpt-6-astra') report.requestedReasoningEffort = 'low';
    adapter = createLiveTestModelAdapter({ client, model: report.model, signal: controller.signal, maxCalls, maxTimeMs });
    broker = new GrokWorkerBroker({ baseUrl: 'http://127.0.0.1:3001', maxLeases: 3,
      authorize: async scope => !(await service.heartbeat(scope.teamId, scope.ownerId, scope.claim)).cancelled,
      modelRequest: async (body, options) => {
        const hasImage = value => value && typeof value === 'object' && (value.type === 'input_image' || Object.values(value).some(hasImage));
        if (hasImage(body.input)) report.imageRequests += 1;
        const record = { streaming: body.stream === true, events: {}, completed: false }; report.modelProtocol.push(record);
        const result = await adapter.modelRequest(body, options).catch(error => { report.providerFailure = { code: error.code || 'provider_failed', status: error.status || null }; throw error; });
        if (!body.stream) { record.completed = Boolean(result?.output); return result; }
        return (async function* () {
          for await (const event of result) {
            const type = ['response.created', 'response.in_progress', 'response.completed', 'response.failed', 'response.incomplete',
              'response.output_item.added', 'response.output_item.done', 'response.output_text.delta', 'response.output_text.done',
              'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.content_part.added',
              'response.content_part.done', 'error'].includes(event.type) ? event.type : 'other';
            record.events[type] = (record.events[type] || 0) + 1;
            if (type === 'response.completed') record.completed = true;
            if (event.error || event.response?.error) record.failure = require('../src/grok-build/rpc-diagnostic').rpcDiagnostic(event.error || event.response.error);
            yield event;
          }
        })();
      } });
    supervisor = await createLiveTestSupervisor({ source, root, proofId: report.proofId, broker, service, model: report.model, podman,
      image: 'sha256:e238d45932f634fc822928426ae4af96a26539f324c553cbfc3db29aa971d87c', signal: controller.signal });
    const realLoop = createGrokTaskLoop({ createWorker: scope => supervisor.createWorker(scope) });
    const loop = options => realLoop({ ...options, signal: AbortSignal.any([options.signal, controller.signal]),
      dispatch: traceToolDispatch(options.dispatch, { trace: report.toolTrace, agentId: options.scope.agentId,
        now: () => Date.now() - started, onDispatch: () => { report.peakActive = Math.max(report.peakActive, runner.active.size); } }),
    }).catch(error => { report.workerFailure = error.code || 'worker_failed';
      if (error.diagnostic) report.rpcDiagnostic = error.diagnostic;
      throw error; });
    // Browser is acquired by the scenario before the first runner tick.
    const computer = { isPreDispatchFailure: error => browser?.computer.isPreDispatchFailure(error) };
    for (const name of ['open', 'act', 'observe', 'getModelInput']) computer[name] = (...args) => browser.computer[name](...args);
    runner = new TeamRunner({ service, maxActive: 3, execute: createTeamWorker({ service, artifactService, loop, computer, visionEnabled: true,
      sessionStore: { getOrCreateOwned: async (id, metadata) => {
        await pool.query('INSERT INTO sessions (id, metadata) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING', [id, JSON.stringify(metadata)]);
        const saved = (await pool.query('SELECT id, metadata FROM sessions WHERE id=$1', [id])).rows[0];
        assert.equal(saved.metadata.ownerId, metadata.ownerId); assert.equal(saved.metadata.teamId, metadata.teamId); return saved;
      } } }) });
    report.result = await runLiveTeamScenario({ service, runner, artifactService, signal: controller.signal,
      browserOrigin: async ({ team, agents }) => {
        teamId = team.id;
        browser = await startTeamBrowser({ source, root, proofId: report.proofId, ownerId: 'proof-owner', teamId, agentIds: agents.slice(0, 2).map(a => a.id),
          image: 'sha256:0c2ef934968082931d5dbb1023a3a285771028ef8430bb861bfe4feb91c99a39', podman, report, timeoutSeconds: 300 }); return browser.origin;
      }, onProgress: event => process.stdout.write(`LIVE_TEST_PROGRESS ${JSON.stringify(event)}\n`) });
    const fresh = new TeamService({ store: new TeamStore({ database: database(otherPool) }) });
    const state = await fresh.get(teamId, 'proof-owner');
    const authored = state.tasks.find(t => t.id === report.result.writerTaskId);
    const review = state.tasks.find(t => t.id === authored.reviewTaskId);
    assert.equal(authored.review.approved, true); assert.notEqual(review.agentId, authored.agentId);
    const freshArtifacts = new ArtifactStore({ database: database(otherPool) });
    fs.mkdirSync(path.join(root, 'exports'), { mode: 0o700 });
    for (const ref of authored.result.artifacts) {
      assert.equal(review.artifactReads[ref.id].complete, true); assert.equal(review.artifactReads[ref.id].sha256, ref.sha256);
      const artifact = await freshArtifacts.get(ref.id, { includeContent: true }); readBackArtifact(artifact, { teamId, ownerId: 'proof-owner' });
      fs.writeFileSync(path.join(root, 'exports', ref.id), artifact.contentBuffer, { flag: 'wx', mode: 0o600 });
    }
    assert.equal(supervisor.snapshot().length, 3); assert(report.imageRequests > 0); assert(report.peakActive >= 2);
    assert(report.toolTrace.some(t => t.name === 'computer_open' && t.ok));
    assert(report.toolTrace.some(t => t.name === 'team_wait' && t.ok));
    report.passed = true;
  } catch (error) { report.failure = error.code || error.name || 'live_test_failed'; }
  finally {
    runner?.stop(); controller.abort(); clearTimeout(timer); adapter?.close(); client?.close();
    const cleanup = await Promise.allSettled([supervisor?.close(), browser?.close()]);
    report.cleanupConfirmed = cleanup.every(r => r.status === 'fulfilled');
    report.drain = await runner?.drain({ timeoutMs: 10000 });
    if (!report.cleanupConfirmed || !report.drain?.settled) report.passed = false;
    if (service && teamId) {
      await service.ownerCommand(teamId, 'proof-owner', 'configure_execution', { enabled: false }, randomUUID());
      fs.writeFileSync(path.join(root, 'team-state.json'), JSON.stringify(await service.get(teamId, 'proof-owner'), null, 2), { mode: 0o600 });
    }
    report.modelBudget = adapter?.snapshot(); report.workers = supervisor?.snapshot(); report.elapsedMs = Date.now() - started;
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(`LIVE_TEST_REPORT ${JSON.stringify(report)}\n`);
  }
  return report;
}
if (require.main === module) {
  assert.equal(process.argv[2], '--approved-isolated-test'); assert([4, 6, 7].includes(process.argv.length));
  const limits = process.argv.length >= 6 ? { maxCalls: Number(process.argv[4]), maxTimeMs: Number(process.argv[5]), model: process.argv[6] } : {};
  runIsolated(async (pool, other) => { const report = await test(pool, other, process.argv[3], limits); assert(report.passed, 'Live test failed; retained report is authoritative'); return ['live_three_agent_test']; })
    .catch(() => { process.exitCode = 1; });
}
module.exports = { test };

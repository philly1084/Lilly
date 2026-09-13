'use strict';
// Run via stdin inside the backend. Never starts its global scheduler.
const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const root = fs.mkdtempSync('/home/kimibuilt/.kimibuilt/lilly-live-test-');
const proofId = randomUUID(); const schema = `lilly_test_${proofId.replaceAll('-', '')}`;
const report = { proofId, root, schema, modelCalls: 0, passed: false, globalExecutionEnabled: false };
let pool; let runtime; let team; let timer;
async function main() {
  assert.equal(process.env.LILLY_TEAMS_ENABLED, 'false');
  const config = require('/app/src/config');
  const { Pool } = require('/app/node_modules/pg');
  const db = config.postgres;
  pool = new Pool({ ...db, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
    options: `-c search_path=${schema} -c lock_timeout=5000` });
  await pool.query(`CREATE SCHEMA ${schema}`);
  const { TeamStore } = require('/app/src/agent-teams/store');
  const store = new TeamStore({ database: { query: (...args) => pool.query(...args), getPool: () => pool } });
  const artifacts = {
    async createStoredArtifact(input) {
      const id = input.reservedArtifactId; assert.match(id, /^[a-f0-9-]{36}$/); assert.ok(input.buffer.length <= 16384);
      const item = { ...input, id, sha256: createHash('sha256').update(input.buffer).digest('hex') }; delete item.buffer;
      fs.writeFileSync(path.join(root, `${id}.data`), input.buffer, { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify(item), { flag: 'wx', mode: 0o600 }); return item;
    },
    async getArtifact(id) {
      assert.match(id, /^[a-f0-9-]{36}$/);
      if (!fs.existsSync(path.join(root, `${id}.json`))) return null;
      return { ...JSON.parse(fs.readFileSync(path.join(root, `${id}.json`))), contentBuffer: fs.readFileSync(path.join(root, `${id}.data`)) };
    },
  };
  const OpenAI = require('/app/node_modules/openai');
  const model = config.openai.model;
  const client = new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL, maxRetries: 0, timeout: 45000 });
  const { createTeamRuntime } = require('/app/src/agent-teams/runtime');
  runtime = createTeamRuntime({ store, environment: { LILLY_TEAMS_ENABLED: 'false' }, defaultModel: model,
    sessionStore: { getOrCreateOwned: async (id, metadata) => ({ id, metadata }) }, artifactService: artifacts,
    getModelClient: () => ({ responses: { create: async (body, options) => {
      assert.ok(++report.modelCalls <= 3);
      const tools = body.tools.filter(t => ['artifact_write', 'artifact_read'].includes(t.name));
      let result;
      try { result = await client.responses.create({ ...body, tools, max_output_tokens: 1024 }, options); }
      catch (error) {
        report.providerError = { status: Number.isInteger(error.status) ? error.status : null,
          connectionError: String(error.message || '').includes('Connection error'), timeout: String(error.name || '').includes('Timeout') };
        throw error;
      }
      for (const item of result.output || []) if (item.type === 'function_call') assert.ok(['artifact_write', 'artifact_read'].includes(item.name));
      return result;
    } } }),
  });
  const owner = `scoped-test-${proofId}`;
  team = await runtime.service.create(owner, { name: 'Scoped live artifact test', objective: 'Save and read back a test artifact only.', maxAgents: 1, maxTasks: 1, concurrency: 1 });
  report.teamId = team.id; report.model = model;
  store.listRunnable = async () => [{ id: team.id, ownerId: owner }];
  const command = (action, input) => runtime.service.ownerCommand(team.id, owner, action, input, randomUUID());
  await command('configure_execution', { enabled: true, model, maxRounds: 3, maxCalls: 4, maxTimeMs: 60000, toolIds: [], origins: [] });
  const agent = await command('create_agent', { name: 'Scoped Tester', job: 'Write only the requested test artifact.' });
  await command('assign_task', { agentId: agent.id, title: 'Write verified marker', instruction: `Call artifact_write to save scoped-test.txt with exactly this content: ${proofId}. Then use artifact_read to read it back, and finish. No other actions.` });
  timer = setTimeout(() => runtime.runner.stop(), 65000);
  await runtime.runner.tick(); await Promise.all([...runtime.runner.active.values()].map(e => e.done));
  const state = await runtime.service.get(team.id, owner);
  report.taskStatus = state.tasks[0].status;
  fs.writeFileSync(path.join(root, 'team-state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  await command('configure_execution', { enabled: false });
  const ids = state.tasks[0].result?.artifacts || [];
  report.artifacts = [];
  for (const ref of ids) {
    const id = typeof ref === 'string' ? ref : ref.id;
    const item = await artifacts.getArtifact(id);
    assert.equal(item.contentBuffer.toString().trim(), proofId);
    assert.equal(createHash('sha256').update(item.contentBuffer).digest('hex'), item.sha256);
    report.artifacts.push({ id, sha256: item.sha256, bytes: item.contentBuffer.length });
  }
  assert.equal(report.artifacts.length, 1); assert.equal(report.taskStatus, 'needs_review');
  report.passed = true;
}
main().catch(error => { report.errorCode = error.code || error.name; }).finally(async () => {
  clearTimeout(timer);
  if (runtime) report.shutdown = await runtime.stop().catch(() => ({ settled: false }));
  if (pool) await pool.end().catch(() => {});
  report.persistence = 'isolated PostgreSQL schema and filesystem artifact adapter';
  report.browserTested = false; report.grokTested = false;
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report)); process.exitCode = report.passed ? 0 : 1;
});

#!/usr/bin/env node
'use strict';

// Real pinned Grok containers, production Lilly runner/tool loop/broker, fixed
// scripted inference. Production team/artifact stores use an isolated actual
// PostgreSQL database. No provider keys, live model, production DB or Kubernetes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const { GrokBuildAcpClient, GROK_SOURCE_REVISION } = require('../src/grok-build/acp-client');
const { modelConfig } = require('../src/grok-build/kubernetes-supervisor');
const { GrokWorkerBroker } = require('../src/agent-teams/worker-broker');
const { TeamService } = require('../src/agent-teams/service');
const { TeamRunner } = require('../src/agent-teams/runner');
const { createTeamWorker, readBackArtifact } = require('../src/agent-teams/worker');
const { createGrokTaskLoop } = require('../src/agent-teams/grok-loop');
const { TeamStore } = require('../src/agent-teams/store');
const { ArtifactStore } = require('../src/artifacts/artifact-store');
const { runIsolated } = require('./lilly-team-postgres-proof');
const { sandboxArgs } = require('./lilly-grok-image-probe');
const { startTeamBrowser } = require('./lilly-team-browser-proof');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash('sha256').update(value).digest('hex');
const podmanEnvironment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' };

async function podman(args, allowed = [0]) {
  try {
    const result = await execute('/usr/bin/podman', args, { encoding: 'utf8', timeout: 25000,
      maxBuffer: 512 * 1024, shell: false, env: podmanEnvironment });
    return { status: 0, output: result.stdout.trim() };
  } catch (error) {
    if (allowed.includes(error.code)) return { status: error.code, output: '' };
    throw Object.assign(new Error(`Proof container ${args[0]} failed.`), { code: 'proof_container_failed' });
  }
}

function discoveredName(input, name) {
  assert.match(name, /^[a-z_]+$/);
  const names = [...new Set([...JSON.stringify(input).matchAll(new RegExp(`([A-Za-z0-9_.:-]+__${name})(?![A-Za-z0-9_])`, 'g'))].map(match => match[1]))];
  assert(names.length <= 1, 'Ambiguous discovered tool.');
  return names[0];
}

function modelHasImage(value, expected) {
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'input_image' && value.image_url === expected) return true;
  return Object.values(value).some(nested => nested && typeof nested === 'object' && modelHasImage(nested, expected));
}

function responseFor(body, item, id) {
  const response = { id: `resp_${id}`, object: 'response', created_at: 1788746400, model: body.model, status: 'completed', output: [item],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!body.stream) return response;
  return (async function* events() {
    yield { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } };
    yield { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } };
    if (item.type === 'function_call') yield { type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: item.id, output_index: 0, delta: item.arguments };
    else yield { type: 'response.output_text.delta', sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text };
    yield { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item };
    yield { type: 'response.completed', sequence_number: 4, response };
  })();
}

async function prove(image, pool, otherPool, { browserImage = null, fullServices = false, independentReview = false, renderWorkroom = false } = {}) {
  assert.equal(process.platform, 'linux'); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Team proof requires the target Node runtime.');
  const relayNode = fs.realpathSync(process.execPath);
  assert(path.isAbsolute(relayNode) && !/[\s:]/.test(relayNode));
  const source = path.resolve(__dirname, '..'); assert.match(source, /^\/tmp\/lilly-grok-team-source\.[A-Za-z0-9]+$/);
  const info = JSON.parse((await podman(['image', 'inspect', image])).output)[0];
  assert.equal(info.Id.replace(/^sha256:/, ''), image.slice(7)); assert.equal(info.Config.User, '10001:10001');
  assert.equal(info.Config.Labels['org.opencontainers.image.revision'], GROK_SOURCE_REVISION);
  assert(!info.Config.Env.some(entry => /^(OPENAI_API_KEY|XAI_API_KEY|LILLY_MODEL_API_KEY)=/.test(entry)));
  const proofId = randomUUID(); const root = fs.mkdtempSync('/tmp/lilly-grok-team-proof.');
  fs.chmodSync(root, 0o700);
  const report = { proofId, root, image, externalModelCalls: 0, productionDatabaseAccess: false,
    nodeVersion: process.versions.node, relayNodeSha256: sha(fs.readFileSync(relayNode)),
    teamStorage: 'production-TeamStore-isolated-PostgreSQL', artifactStorage: 'production-ArtifactStore-isolated-PostgreSQL',
    sessionStorage: 'minimal-SQL-parent-row-adapter', checks: [], workerContainers: [], sourceSha256: {} };
  for (const file of ['bin/lilly-grok-team-proof.js', 'bin/lilly-grok-team-worker.js', 'bin/lilly-grok-image-probe.js',
    'src/grok-build/acp-client.js', 'src/grok-build/kubernetes-supervisor.js', 'src/grok-build/task-mcp-bridge.js',
    'src/agent-teams/worker-broker.js', 'src/agent-teams/service.js', 'src/agent-teams/domain.js', 'src/agent-teams/runner.js',
    'src/agent-teams/worker.js', 'src/agent-teams/grok-loop.js', 'src/agent-teams/team-wait.js',
    'src/agent-teams/execution-owner.js', 'src/agent-teams/cgroup-reader.js', 'src/agent-teams/presentation.js',
    'src/agent-teams/store.js', 'src/postgres.js', 'src/artifacts/artifact-store.js', 'bin/lilly-team-postgres-proof.js',
    'src/agent-teams/reconciler.js', 'src/agent-teams/container-stop.js', 'src/agent-teams/container-stop-archive.js',
    'src/agent-computer/model-loop.js', 'bin/lilly-team-browser-proof.js', 'bin/lilly-browser-seccomp.js', 'src/agent-computer/runtime.js', 'src/agent-computer/profile-lease.js']) {
    report.sourceSha256[file] = sha(fs.readFileSync(path.join(source, file)));
  }
  process.stdout.write(`TEAM_PROOF_HANDLE ${JSON.stringify({ proofId, root })}\n`);
  const workers = []; const sockets = new Set();
  let broker; let relay; let runner; let browser; let product;
  const database = value => ({ query: (...args) => value.query(...args), getPool: () => value });
  const teamStore = new TeamStore({ database: database(pool) });
  const artifactStore = new ArtifactStore({ database: database(pool) });
  assert.equal(require.cache[require.resolve('../src/postgres')], undefined, 'No production DB initialization allowed.');
  const artifactDdl = fs.readFileSync(path.join(source, 'src/postgres.js'), 'utf8').match(/CREATE TABLE IF NOT EXISTS artifacts \([\s\S]*?\n\s*\)/)?.[0];
  assert(artifactDdl, 'Production artifact DDL is required.');
  let artifactService = {
    createStoredArtifact: async input => {
      const id = input.reservedArtifactId; assert.match(id, /^[a-f0-9-]{36}$/);
      return artifactStore.create({ ...input, id, contentBuffer: input.buffer, sha256: sha(input.buffer),
        extension: path.extname(input.filename).slice(1), mimeType: 'text/markdown', sizeBytes: input.buffer.length });
    },
    getArtifact: (id, options) => artifactStore.get(id, options),
  };
  const service = new TeamService({ store: teamStore, verifyArtifact: async scope => readBackArtifact(await artifactService.getArtifact(scope.artifactId, { includeContent: true }), scope) });
  const closeWorker = async worker => {
    if (worker.closing) return worker.closing;
    worker.closing = (async () => {
      worker.lease.close(); worker.client?.close();
      if ((await podman(['container', 'exists', worker.name], [0, 1])).status === 0) {
        const current = JSON.parse((await podman(['container', 'inspect', worker.name])).output)[0];
        assert.equal(current.Config.Labels['lilly.team-proof'], proofId);
        assert.equal(current.Config.Labels['lilly.proof-agent'], worker.agentId);
        assert.equal(current.HostConfig.NetworkMode, 'none');
        if (worker.containerId) assert.equal(current.Id, worker.containerId);
        worker.containerId = current.Id;
        if (current.State.Running) await podman(['stop', '--time', '2', current.Id]);
        await podman(['rm', current.Id]);
      } else assert(worker.containerId, 'Cannot confirm a worker that was never observed.');
      assert.equal((await podman(['container', 'exists', worker.name], [0, 1])).status, 1);
      worker.removed = true;
    })();
    return worker.closing;
  };
  try {
    if (fullServices) {
      product = await require('./lilly-team-services-proof').createServices({ source, root, pool, report, renderWorkroom });
      artifactService = product.artifactService;
      report.sessionStorage = 'production-SessionStore-isolated-PostgreSQL';
      report.artifactStorage = 'production-ArtifactService-and-ArtifactStore-isolated-PostgreSQL';
    } else {
      await pool.query('CREATE TABLE sessions (id TEXT PRIMARY KEY, metadata JSONB NOT NULL)');
      await pool.query(artifactDdl);
    }
    await teamStore.initialize();
    if (product) await product.start(service);
    const team = await service.create('proof-owner', { name: independentReview ? 'Reviewed Grok team' : 'Two Grok teammates', objective: 'Write, independently read, reply and save a final artifact.', restSeconds: 0, concurrency: 2 });
    const command = (action, input) => service.ownerCommand(team.id, 'proof-owner', action, input, randomUUID());
    await command('configure_execution', { enabled: true, maxRounds: 32, maxCalls: 16, maxTimeMs: 90000 });
    const writer = await command('create_agent', { name: 'Writer', job: 'Write the draft and final.' });
    const reviewer = await command('create_agent', { name: 'Reviewer', role: 'reviewer', job: 'Read and review the draft.' });
    const verifier = independentReview ? await command('create_agent', { name: 'Verifier', role: 'reviewer', job: 'Read all final task artifacts and record an independent verdict.' }) : null;
    const participants = [writer, reviewer, ...(verifier ? [verifier] : [])];
    const modelNames = new Map([[writer.id, 'lilly-proof-writer'], [reviewer.id, 'lilly-proof-reviewer'], ...(verifier ? [[verifier.id, 'lilly-proof-verifier']] : [])]);
    let writerTask;
    if (browserImage) {
      browser = await startTeamBrowser({ image: browserImage, source, root, proofId, ownerId: 'proof-owner', teamId: team.id,
        agentIds: [writer.id, reviewer.id], podman, report });
      await command('configure_execution', { origins: [browser.origin], allowSideEffects: true });
    }
    const script = Object.fromEntries(participants.map(agent => [agent.id, { step: 0, calls: 0, searches: 0, auxiliary: 0,
      results: [], tools: [], browserStep: 0, browserResults: [], browserImages: [] }]));
    const draft = `${browser ? 'Browser click independently confirmed. ' : ''}Isolated team draft ${randomUUID()}`;
    let waiting = false; let quietChecked = false;
    const nextAction = agentId => {
      const s = script[agentId]; const w = script[writer.id]; const r = script[reviewer.id];
      if (agentId === verifier?.id) return [
        () => ['team_task', { taskId: writerTask.id }],
        () => { assert.equal(s.results[0].id, writerTask.id); assert.equal(s.results[0].status, 'needs_review');
          return ['artifact_read', { artifactId: w.results[0].id }]; },
        () => { assert.equal(s.results[1].content, draft); return ['artifact_read', { artifactId: w.results[3].id }]; },
        () => { assert.equal(s.results[2].content, `Final based on peer reply: ${w.results[2].messages[0].body}`);
          return ['artifact_write', { filename: 'independent-review.md', content: `Verified draft ${w.results[0].id} and final ${w.results[3].id} by reading their recorded bytes.` }]; },
        () => ['team_command', { action: 'review_task', input: { taskId: writerTask.id, approved: true,
          note: `Read both recorded outputs; independent evidence saved as ${s.results[3].id}.` } }],
      ][s.step]?.();
      if (browser && agentId === writer.id && s.browserStep < 2) return [
        () => ['computer_open', { url: `${browser.origin}/` }],
        () => ['computer_act', { computerId: s.browserResults[0].computerId, frameId: s.browserResults[0].frameId,
          action: { type: 'click', selector: '#confirm' } }],
      ][s.browserStep]();
      if (agentId === writer.id) return [
        () => ['artifact_write', { filename: 'draft.md', content: draft }],
        () => ['team_command', { action: 'send_message', input: { to: [reviewer.id], kind: 'request', body: `Read artifact ${w.results[0].id} and reply with your review.` } }],
        () => ['team_wait', { afterMessageId: w.results[1].id, timeoutMs: 30000 }],
        () => { assert.equal(w.results[2].reason, 'message'); assert.equal(w.results[2].messages[0].from, reviewer.id);
          return ['artifact_write', { filename: 'final.md', content: `Final based on peer reply: ${w.results[2].messages[0].body}` }]; },
      ][s.step]?.();
      return [
        () => ['artifact_read', { artifactId: w.results[0].id }],
        () => { assert.equal(r.results[0].content, draft); return ['artifact_write', { filename: 'review.md', content: `Independently read and verified: ${draft}` }]; },
        () => ['team_command', { action: 'remember', input: { scope: 'team', content: 'Draft read-back complete; review saved.', source: r.results[1].id } }],
        () => ['team_command', { action: 'send_message', input: { to: [writer.id], kind: 'reply', replyTo: w.results[1].id,
          body: `Reviewed artifact ${r.results[1].id}: draft content verified.` } }],
      ][s.step]?.();
    };
    const origin = 'http://127.0.0.1:3001';
    broker = new GrokWorkerBroker({ baseUrl: origin, authorize: async scope => !(await service.heartbeat(scope.teamId, scope.ownerId, scope.claim)).cancelled,
      modelRequest: async body => {
        assert(!report.dispatchFailure, 'Stop scripted inference after the first uncertain dispatch.');
        assert(!report.uiFailure, 'Do not repeat a failed operator-page inspection.');
        const agentId = [...modelNames].find(([, model]) => model === body.model)?.[0];
        assert(agentId, 'Unknown fixture model.'); const s = script[agentId]; s.calls += 1; assert(s.calls <= 28);
        const taskRequest = body.tools?.some(tool => tool.name === 'search_tool');
        const id = `${agentId}_${s.calls}`; let item;
        if (!taskRequest) { s.auxiliary += 1; assert(s.auxiliary <= 3); }
        if (taskRequest && agentId === reviewer.id && !quietChecked) {
          assert(waiting, 'Writer must be waiting before the peer works.');
          const count = script[writer.id].calls; await delay(400); assert.equal(script[writer.id].calls, count);
          const live = await Promise.all(workers.map(async worker => JSON.parse((await podman(['container', 'inspect', worker.name])).output)[0]));
          assert.equal(live.length, 2); assert(live.every(container => container.State.Running && container.HostConfig.NetworkMode === 'none'));
          assert.notEqual(live[0].State.Pid, live[1].State.Pid);
          if (product) {
            const workroom = await product.workroom(team.id);
            assert.equal(workroom.tasks.filter(task => task.status === 'running').length, 2);
            assert.equal(workroom.agents.find(agent => agent.id === writer.id).activity?.kind, 'waiting_for_team');
            assert(workroom.events.some(event => event.type === 'tool_finished' && event.tool === 'artifact_write'));
            report.checks.push('authenticated_workroom_observes_real_overlapping_workers_and_team_wait');
            if (renderWorkroom) await product.renderWorkroom(team.id, 'overlap');
          }
          if (browser) {
            const browserContainer = JSON.parse((await podman(['inspect', report.browser.name])).output)[0];
            assert.equal(browserContainer.Id, report.browser.containerId); assert(browserContainer.State.Running);
            const namespaces = [...live, browserContainer].map(container => fs.readlinkSync(`/proc/${container.State.Pid}/ns/pid`));
            assert.equal(new Set(namespaces).size, 3);
            assert(live.every(container => container.Mounts.every(mount => mount.Destination !== '/profiles')));
            report.checks.push('browser_and_both_workers_have_distinct_pid_namespaces');
          }
          quietChecked = true; report.checks.push('two_real_containers_overlap_while_writer_waits_without_model_polling');
        }
        const action = taskRequest && nextAction(agentId);
        if (action) {
          const received = JSON.stringify(body.input);
          if (browser && agentId === writer.id && s.browserStep > 0) {
            assert(modelHasImage(body.input, s.browserImages.at(-1)), 'Actual private browser frame missing from writer model input.');
            assert(received.includes(s.browserResults.at(-1).frameId));
            if (s.browserStep === 2) assert.equal((await browser.stats()).clicks, 1);
          }
          if (agentId === reviewer.id && s.step === 0) assert(received.includes(script[writer.id].results[0].id));
          if (agentId === reviewer.id && s.step === 1) assert(received.includes(draft));
          if (agentId === writer.id && s.step === 3) assert(received.includes(script[reviewer.id].results[1].id));
          if (s.step > 0 && s.results.at(-1).id) assert(received.includes(s.results.at(-1).id));
          const [name, args] = action; const found = discoveredName(body.input, name);
          if (!found) { s.searches += 1; assert(s.searches <= 8); }
          item = { id: `fc_${id}`, type: 'function_call', call_id: `call_${id}`, status: 'completed',
            name: found ? 'use_tool' : 'search_tool', arguments: JSON.stringify(found ? { tool_name: found, tool_input: args } : { query: name, limit: 5 }) };
        } else item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: taskRequest ? 'Saved and independently checked the team output.' : 'Team transport fixture.', annotations: [] }] };
        return responseFor(body, item, id);
      } });
    const address = await broker.listen({ host: '127.0.0.1', port: 0 });
    const relayRoot = path.join(root, 'relay'); fs.mkdirSync(relayRoot, { mode: 0o755 });
    relay = net.createServer(socket => {
      const upstream = net.createConnection({ host: '127.0.0.1', port: address.port });
      for (const stream of [socket, upstream]) { sockets.add(stream); stream.on('close', () => sockets.delete(stream)); }
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy()); socket.pipe(upstream); upstream.pipe(socket);
    });
    relay.maxConnections = 64;
    await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(path.join(relayRoot, 'broker.sock'), resolve); });
    fs.chmodSync(path.join(relayRoot, 'broker.sock'), 0o666);
    const factory = async scope => {
      const model = modelNames.get(scope.agentId); assert(model);
      const lease = broker.open({ ...scope, signal: undefined }, { signal: scope.signal, model, deadlineMs: 90000, maxModelCalls: 32 });
      const name = `lilly-team-${proofId.slice(0, 8)}-${scope.agentId.slice(0, 8)}`;
      assert.equal((await podman(['container', 'exists', name], [0, 1])).status, 1);
      const home = path.join(root, `home-${scope.agentId}`); const workspace = path.join(root, `work-${scope.agentId}`);
      for (const directory of [home, workspace]) { fs.mkdirSync(directory, { mode: 0o700 }); fs.chownSync(directory, 10001, 10001); }
      fs.mkdirSync(path.join(home, '.grok'), { mode: 0o700 }); fs.chownSync(path.join(home, '.grok'), 10001, 10001);
      for (const [file, text] of [['.grok/config.toml', modelConfig({ ...scope, model, modelEndpoint: lease.modelEndpoint, modelToken: lease.modelToken }, origin)],
        ['launch.json', JSON.stringify({ token: lease.modelToken })]]) {
        const target = path.join(home, file); fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 }); fs.chownSync(target, 10001, 10001);
      }
      const worker = { name, agentId: scope.agentId, lease, home, workspace }; workers.push(worker);
      worker.client = new GrokBuildAcpClient({ executable: '/opt/grok/bin/xai-grok-pager', home: '/state/worker', cwd: '/workspace/assignment',
        requestTimeoutMs: 20000, promptTimeoutMs: 65000, spawn: (executable, args) => {
          assert.equal(executable, '/opt/grok/bin/xai-grok-pager'); assert.deepEqual(args, ['--no-auto-update', 'agent', 'stdio']);
          return spawn('/usr/bin/podman', ['run', '--interactive', '--name', name, '--label', `lilly.team-proof=${proofId}`,
            '--label', `lilly.proof-agent=${scope.agentId}`, ...sandboxArgs().filter(arg => !arg.startsWith('--tmpfs=/state/') && !arg.startsWith('--tmpfs=/workspace/')),
            '--timeout=120', '--volume', `${home}:/state/worker:rw`, '--volume', `${workspace}:/workspace/assignment:rw`,
            '--volume', `${relayRoot}:/run/lilly-proof:ro`, '--volume', `${source}/bin/lilly-grok-team-worker.js:/opt/team-worker.js:ro`,
            '--volume', `${relayNode}:/opt/proof-node:ro`, '--entrypoint', '/opt/proof-node', image, '/opt/team-worker.js'],
          { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: podmanEnvironment });
        } });
      return { client: worker.client, startOptions: { authMethodId: 'xai.api_key' }, connectBridge: lease.connectBridge,
        saveSession: async sessionId => {
          const container = JSON.parse((await podman(['container', 'inspect', name])).output)[0];
          assert.equal(container.Config.Labels['lilly.team-proof'], proofId); assert.equal(container.State.Running, true);
          worker.containerId = container.Id; worker.sessionId = sessionId;
          await service.saveEngineSession(scope, sessionId);
        }, close: () => closeWorker(worker) };
    };
    const grokLoop = createGrokTaskLoop({ createWorker: factory });
    const loop = async options => grokLoop({ ...options, dispatch: async (name, args, meta) => {
      const s = script[options.scope.agentId]; assert.equal(name, nextAction(options.scope.agentId)?.[0]);
      if (name === 'team_wait') waiting = true;
      let result;
      try { result = await options.dispatch(name, args, meta); }
      catch (error) { report.dispatchFailure = { tool: name, code: error.code || 'dispatch_failed' }; throw error; }
      if (options.scope.agentId === verifier?.id && name === 'team_task') {
        // Exercise the real worker gate before this verifier has read either
        // output. This test probe is not scripted model reasoning.
        await assert.rejects(options.dispatch('team_command', { action: 'review_task', input: {
          taskId: writerTask.id, approved: true, note: 'Deliberately premature fixture verdict.',
        } }, { callId: 'proof-premature-verdict' }), { code: 'team_evidence_required' });
        assert.equal((await service.get(team.id, 'proof-owner')).tasks.find(task => task.id === writerTask.id).status, 'needs_review');
        report.checks.push('assigned_verifier_cannot_approve_before_reading_all_recorded_outputs');
      }
      s.tools.push(name);
      if (name.startsWith('computer_')) {
        const frame = result.privateModelContent?.find(part => part.type === 'input_image')?.image_url; assert(frame);
        s.browserResults.push(result.publicResult); s.browserImages.push(frame); s.browserStep += 1;
        if (name === 'computer_act') {
          assert.equal((await browser.stats()).clicks, 1); assert.notEqual(s.browserImages[0], frame);
          await assert.rejects(browser.computer.act(options.scope, { ...s.browserResults[0], action: { type: 'click', selector: '#confirm' } }), { code: 'computer_stale_frame' });
          assert.equal((await browser.stats()).clicks, 1);
          report.checks.push('writer_uses_separate_sandboxed_browser_through_team_tools', 'stale_frame_replay_does_not_repeat_team_browser_action');
        }
      } else { s.results.push(result.publicResult); s.step += 1; }
      return result;
    } }).catch(error => {
      const s = script[options.scope.agentId];
      report.workerFailure = { code: error.code || 'worker_failed', step: s.step, calls: s.calls, searches: s.searches, tools: s.tools };
      throw error;
    });
    runner = new TeamRunner({ service, pollMs: 200, execute: createTeamWorker({ service, artifactService, loop,
      ...(browser ? { computer: browser.computer, visionEnabled: true } : {}),
      sessionStore: product?.sessionStore || { getOrCreateOwned: async (id, metadata) => {
        await pool.query('INSERT INTO sessions (id, metadata) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING', [id, JSON.stringify(metadata)]);
        const saved = (await pool.query('SELECT id, metadata FROM sessions WHERE id=$1', [id])).rows[0];
        assert.equal(saved.metadata.ownerId, metadata.ownerId); assert.equal(saved.metadata.teamId, metadata.teamId);
        return saved;
      } } }) });
    writerTask = await command('assign_task', { agentId: writer.id, title: 'Write and collaborate', instruction: 'Write a draft, request peer read-back, wait for the reply and save a final artifact.',
      ...(verifier ? { reviewerId: verifier.id } : {}) });
    runner.start(); await runner.tick();
    const deadline = Date.now() + 100000;
    let state;
    while (Date.now() < deadline) {
      if (report.uiFailure) throw Object.assign(new Error('Workroom rendering failed.'), { code: 'proof_ui_failed' });
      state = await service.get(team.id, 'proof-owner');
      if (state.tasks.length === participants.length && state.tasks.every(task => !['queued', 'running'].includes(task.status)) && runner.active.size === 0) break;
      if (state.tasks.some(task => ['failed', 'reconciling', 'cancelled'].includes(task.status))) throw Object.assign(new Error('Worker task failed.'), { code: 'proof_worker_failed' });
      await delay(200);
    }
    assert.equal(state.tasks.length, participants.length);
    assert(state.tasks.every(task => task.status === (verifier && task.id === writerTask.id ? 'completed' : 'needs_review')));
    assert.equal(runner.active.size, 0); assert.equal(workers.length, participants.length); assert(workers.every(worker => worker.removed));
    assert.equal(new Set(workers.map(worker => worker.sessionId)).size, participants.length);
    if (verifier) {
      const authored = state.tasks.find(task => task.id === writerTask.id);
      const verdictTask = state.tasks.find(task => task.id === authored.reviewTaskId);
      assert.equal(verdictTask.reviewOf, authored.id); assert.equal(verdictTask.agentId, verifier.id);
      assert.notEqual(verifier.id, writer.id); assert.equal(authored.review.approved, true);
      for (const artifact of authored.result.artifacts) {
        assert.equal(verdictTask.artifactReads[artifact.id].complete, true);
        assert.equal(verdictTask.artifactReads[artifact.id].sha256, artifact.sha256);
      }
      assert.equal(verdictTask.result.artifacts.length, 1);
      report.independentReview = { taskId: authored.id, writerId: writer.id, reviewerId: verifier.id,
        reviewTaskId: verdictTask.id, approved: true, reviewArtifactId: verdictTask.result.artifacts[0].id,
        readHashes: Object.fromEntries(authored.result.artifacts.map(item => [item.id, item.sha256])) };
      report.checks.push('automatic_independent_verifier_reads_all_outputs_and_records_durable_approval');
      if (product) {
        const view = await product.workroom(team.id);
        assert.equal(view.tasks.find(task => task.id === authored.id).status, 'completed');
        assert(view.artifacts.filter(artifact => artifact.taskId === authored.id).every(artifact => artifact.reviewStatus === 'completed'));
        report.checks.push('authenticated_workroom_exposes_reviewed_completion_and_artifact_verdicts');
        if (renderWorkroom) await product.renderWorkroom(team.id, 'reviewed');
      }
    }
    assert.deepEqual(state.messages.map(message => message.kind), ['request', 'reply']);
    assert(state.memories.some(memory => memory.scope === 'team' && memory.content.includes('read-back complete')));
    assert.equal(broker.leases.size, 0); assert(quietChecked);
    if (browser) {
      assert.equal(script[writer.id].browserStep, 2);
      const persisted = JSON.stringify(state); assert(!persisted.includes('data:image'));
      for (const image of script[writer.id].browserImages) assert(!persisted.includes(image.split(',')[1]));
      await browser.close(); assert(report.browser.removed && report.browser.shutdown.closed && report.browser.shutdown.clicks === 1);
      report.checks.push('real_browser_frames_reach_persisted_team_worker_model', 'private_frames_not_serialized_in_durable_team_state');
    }
    // Reconstruct independent services on the other connection pool after both
    // worker containers are gone. No in-memory team/artifact fixture survives.
    const freshArtifacts = new ArtifactStore({ database: database(otherPool) });
    const freshService = new TeamService({ store: new TeamStore({ database: database(otherPool) }),
      verifyArtifact: async scope => readBackArtifact(await freshArtifacts.get(scope.artifactId, { includeContent: true }), scope) });
    const reloaded = await freshService.get(team.id, 'proof-owner');
    assert.deepEqual(reloaded, state);
    if (browser) {
      const browserOperations = reloaded.tasks.find(task => task.agentId === writer.id).operations.filter(operation => operation.kind.startsWith('computer_'));
      assert.deepEqual(browserOperations.map(operation => ({ kind: operation.kind, status: operation.status })),
        [{ kind: 'computer_open', status: 'settled' }, { kind: 'computer_act', status: 'settled' }]);
      report.checks.push('fresh_sql_reload_preserves_settled_browser_operation_journal');
    }
    await assert.rejects(freshService.get(team.id, 'foreign-owner'), { code: 'team_not_found' });
    const reloadedContext = await freshService.context(team.id, 'proof-owner', reviewer.id);
    assert(reloadedContext.memories.some(memory => memory.scope === 'team' && memory.content.includes('read-back complete')));
    assert(reloadedContext.messages.some(message => message.kind === 'request'));
    assert(reloaded.agents.every(agent => workers.some(worker => worker.agentId === agent.id && worker.sessionId === agent.engineSession.sessionId)));
    const rows = (await otherPool.query('SELECT id, filename FROM artifacts')).rows;
    assert.deepEqual(rows.map(row => row.filename).sort(), ['draft.md', 'final.md', ...(verifier ? ['independent-review.md'] : []), 'review.md']);
    assert.equal((await otherPool.query('SELECT count(*)::int AS count FROM sessions')).rows[0].count, participants.length);
    // Retain synthetic outputs after the disposable DB is removed. These are
    // exports of verified SQL bytes, never the storage adapter's backing files.
    const exportRoot = path.join(root, 'exports'); fs.mkdirSync(exportRoot, { mode: 0o700 });
    report.artifacts = await Promise.all(rows.map(async ({ id }) => {
      const artifact = await freshArtifacts.get(id, { includeContent: true }); assert.equal(sha(artifact.contentBuffer), artifact.sha256);
      readBackArtifact(artifact, { teamId: team.id, ownerId: 'proof-owner' });
      if (artifact.filename === 'draft.md') assert.equal(artifact.contentBuffer.toString(), draft);
      if (artifact.filename === 'review.md') assert.equal(artifact.contentBuffer.toString(), `Independently read and verified: ${draft}`);
      if (artifact.filename === 'final.md') assert.equal(artifact.contentBuffer.toString(), `Final based on peer reply: ${script[writer.id].results[2].messages[0].body}`);
      if (artifact.filename === 'independent-review.md') assert.equal(artifact.contentBuffer.toString(),
        `Verified draft ${script[writer.id].results[0].id} and final ${script[writer.id].results[3].id} by reading their recorded bytes.`);
      assert.match(id, /^[a-f0-9-]{36}$/);
      fs.writeFileSync(path.join(exportRoot, id), artifact.contentBuffer, { flag: 'wx', mode: 0o600 });
      return { id, filename: artifact.filename, sha256: artifact.sha256, bytes: artifact.contentBuffer.length, exportedFile: `exports/${id}` };
    }));
    if (product) await product.verify(reloaded, report.artifacts);
    report.checks.push('fresh_service_reloads_sql_team_messages_memory_and_acp_sessions',
      verifier ? 'fresh_pool_reads_four_exact_sql_artifacts_without_duplicate_writes' : 'fresh_pool_reads_three_exact_sql_artifacts_without_duplicate_writes', 'reloaded_team_rejects_foreign_owner');
    const roles = [[writer.id, 'writer'], [reviewer.id, 'reviewer'], ...(verifier ? [[verifier.id, 'verifier']] : [])];
    report.modelCalls = Object.fromEntries(roles.map(([id, role]) => [role, script[id].calls]));
    report.toolCalls = Object.fromEntries(roles.map(([id, role]) => [role, script[id].tools]));
    report.checks.push(verifier ? 'three_distinct_saved_acp_sessions' : 'two_distinct_saved_acp_sessions', 'request_wakes_one_peer_reply_does_not_wake_again',
      'peer_reads_actual_draft_bytes_and_posts_team_memory', verifier ? 'four_artifacts_independently_read_back' : 'three_artifacts_independently_read_back',
      'whole_worker_containers_removed_before_accepting_results', 'all_broker_leases_revoked');
    report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error.code || 'proof_assertion_failed';
  } finally {
    runner?.stop();
    const cleanup = await Promise.allSettled(workers.map(closeWorker));
    if (cleanup.some(result => result.status === 'rejected')) { report.cleanupUnconfirmed = true; report.passed = false; }
    await runner?.drain({ timeoutMs: 3000 }); await broker?.close();
    if (browser) {
      try {
        await browser.close();
        assert.equal(report.browser.shutdown?.admissionClosed, true);
        report.checks.push('disposed_browser_runtime_rejects_reopening_after_real_context_cleanup');
      } catch { report.cleanupUnconfirmed = true; report.passed = false; }
    }
    for (const socket of sockets) socket.destroy();
    if (relay) await new Promise(resolve => relay.close(resolve));
    if (product) {
      try { await product.close(); }
      catch { report.productCleanupUnconfirmed = true; report.passed = false; }
    }
    report.workerContainers = workers.map(worker => ({ name: worker.name, id: worker.containerId, removed: worker.removed === true }));
    // Keep isolated artifacts/source/report; remove only credential-bearing
    // private mounts of this proof after every exact worker is confirmed gone.
    if (!report.cleanupUnconfirmed) for (const worker of workers) for (const directory of [worker.home, worker.workspace]) {
      assert.equal(path.dirname(directory), root); assert(!fs.lstatSync(directory).isSymbolicLink());
      fs.rmSync(directory, { recursive: true }); assert(!fs.existsSync(directory));
    }
    report.privateMountsRemoved = !report.cleanupUnconfirmed;
    fs.writeFileSync(path.join(root, 'proof-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (require.main === module) {
  const renderWorkroom = process.argv.at(-1) === '--render-workroom';
  const renderArgs = renderWorkroom ? process.argv.slice(0, -1) : process.argv;
  const independentReview = renderArgs.at(-1) === '--independent-review';
  const initial = independentReview ? renderArgs.slice(0, -1) : renderArgs;
  const fullServices = initial.at(-1) === '--full-services';
  const args = fullServices ? initial.slice(0, -1) : initial;
  assert(!independentReview || fullServices, 'Independent review proof requires actual product services.');
  assert(!renderWorkroom || (independentReview && fullServices), 'Rendered workroom proof requires the independent-review product scenario.');
  assert.deepEqual(args.slice(2, 4), ['--run-isolated', '--image']); assert([5, 7].includes(args.length));
  const browserImage = args.length === 7 ? args[6] : null;
  if (browserImage) { assert.equal(process.argv[5], '--browser-image'); assert.match(browserImage, /^sha256:[a-f0-9]{64}$/); }
  let teamReport;
  runIsolated(async (pool, otherPool) => {
    teamReport = await prove(args[4], pool, otherPool, { browserImage, fullServices, independentReview, renderWorkroom });
    assert.equal(teamReport.passed, true, 'Connected team proof must pass.');
    return teamReport.checks;
  }).then(databaseReport => {
    const passed = Boolean(teamReport?.passed && databaseReport.passed && databaseReport.cleaned);
    const report = { passed, teamProofId: teamReport?.proofId, teamReport: teamReport ? path.join(teamReport.root, 'proof-report.json') : null,
      databaseProofId: databaseReport.proofId, databaseReport: path.join(databaseReport.root, 'proof-report.json'), databaseRemoved: databaseReport.cleaned };
    process.stdout.write(`TEAM_PROOF_REPORT ${JSON.stringify(report)}\n`); process.exitCode = passed ? 0 : 1;
  })
    .catch(() => { process.stderr.write('Isolated team proof setup failed.\n'); process.exitCode = 1; });
}
module.exports = { discoveredName, responseFor, modelHasImage };

#!/usr/bin/env node
'use strict';

// Actual Grok binary + production Lilly broker/MCP bridge, scripted Responses
// server only. No provider credentials, external network, or live model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { GrokBuildAcpClient } = require('../src/grok-build/acp-client');
const { modelConfig } = require('../src/grok-build/kubernetes-supervisor');
const { GrokWorkerBroker } = require('../src/agent-teams/worker-broker');
const { createTaskMcpBridge } = require('../src/grok-build/task-mcp-bridge');
const { sandboxArgs } = require('./lilly-grok-image-probe');

function pngFixture() {
  const crc = bytes => {
    let result = 0xffffffff;
    for (const byte of bytes) {
      result ^= byte;
      for (let i = 0; i < 8; i += 1) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0);
    }
    return (result ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((64 * 3 + 1) * 64);
  for (let row = 0; row < 64; row += 1) for (let col = 0; col < 64; col += 1) {
    const offset = row * 193 + 1 + col * 3;
    pixels[offset] = (row * 7 + col * 3) % 256; pixels[offset + 1] = (col * 11) % 256; pixels[offset + 2] = (row * 13) % 256;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function collectImages(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (value.type === 'input_image') output.push(value.image_url);
  for (const nested of Object.values(value)) if (nested && typeof nested === 'object') collectImages(nested, output);
  return output;
}

async function inside({ stage = 'single' } = {}) {
  assert.equal(process.pid, 1);
  const saved = stage === 'resume' ? JSON.parse(fs.readFileSync('/state/worker/lilly-resume-proof.json', 'utf8')) : null;
  assert.equal(process.getuid(), 10001);
  assert(!Object.values(require('node:os').networkInterfaces()).flat().some(entry => !entry.internal));
  const state = { phase: 'setup', scriptedRequests: 0, taskModelRequests: 0, auxiliaryRequests: 0, toolCalls: [], imageObserved: false, artifactReadBack: false,
    externalModelCalls: 0, network: 'none', brokerResponses: [], safeActivity: [] };
  const image = pngFixture(); const imageUrl = `data:image/png;base64,${image.toString('base64')}`;
  const deliverable = 'Lilly private image transport and scoped write fixture passed.';
  const model = 'lilly-fixture'; const origin = 'http://127.0.0.1:3001';
  const continuityMarker = saved?.continuityMarker || `lilly-continuity-${randomUUID()}`;
  if (saved) {
    assert.equal(saved.fileWrites, 1); assert.match(saved.artifactSha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof saved.sessionId, 'string'); assert(saved.sessionId.length > 0 && saved.sessionId.length <= 256);
    assert.match(continuityMarker, /^lilly-continuity-[a-f0-9-]{36}$/);
    state.artifactSha256 = saved.artifactSha256; state.fileWrites = saved.fileWrites;
  }
  let client; let bridge; let broker; let discovered;
  const worker = token => new GrokBuildAcpClient({ executable: '/opt/grok/bin/xai-grok-pager', cwd: '/workspace/assignment', home: '/state/worker',
    env: { PATH: '/usr/bin:/bin', LILLY_MODEL_API_KEY: token }, requestTimeoutMs: 15000, promptTimeoutMs: 35000 });
  const fail = code => { state.fixtureFailure = code; return Object.assign(new Error(code), { code }); };
  try {
    broker = new GrokWorkerBroker({ baseUrl: origin, authorize: async () => true, modelRequest: async body => {
      state.scriptedRequests += 1;
      const taskRequest = body.tools?.some(tool => tool.name === 'search_tool');
      const round = taskRequest ? ++state.taskModelRequests : 0;
      let item;
      if (!taskRequest) {
        state.auxiliaryRequests += 1;
        if (state.auxiliaryRequests > 3) throw fail('fixture_auxiliary_budget');
        item = { id: `msg_aux_${state.auxiliaryRequests}`, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Private transport fixture.', annotations: [] }] };
      } else if (state.resuming) {
        const resumeRound = state.resumeModelRequests = (state.resumeModelRequests || 0) + 1;
        if (resumeRound === 1) {
          const context = JSON.stringify(body.input);
          state.resumeContextObserved = context.includes(continuityMarker) && context.includes(state.artifactSha256);
          if (!state.resumeContextObserved) throw fail('fixture_resume_history_missing');
          item = { id: 'fc_resume_search', type: 'function_call', call_id: 'call_resume_search', name: 'search_tool',
            arguments: JSON.stringify({ query: 'lilly_probe_read', limit: 5 }), status: 'completed' };
        } else if (resumeRound === 2) {
          const names = [...new Set([...JSON.stringify(body.input).matchAll(/([A-Za-z0-9_.:-]+__lilly_probe_read)/g)].map(match => match[1]))];
          if (names.length !== 1) throw fail('fixture_resume_discovery_missing');
          item = { id: 'fc_resume_read', type: 'function_call', call_id: 'call_resume_read', name: 'use_tool',
            arguments: JSON.stringify({ tool_name: names[0], tool_input: {} }), status: 'completed' };
        } else if (resumeRound <= 4 && state.resumeReadBack) {
          item = { id: `msg_resume_${resumeRound}`, type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Resumed and verified the existing file without another write.', annotations: [] }] };
        } else throw fail('fixture_resume_unexpected_request');
      } else if (round <= 3) {
        if (round === 2) {
          // Grok lazily discovers MCP functions through its native search/use
          // tools. Resolve names from the actual discovery result, not a guess.
          const text = JSON.stringify(body.input);
          discovered = Object.fromEntries(['image', 'save'].map(kind => {
            const matches = [...text.matchAll(new RegExp(`([A-Za-z0-9_.:-]+__lilly_probe_${kind})`, 'g'))];
            const names = [...new Set(matches.map(match => match[1]))];
            if (names.length !== 1) throw fail('fixture_discovery_missing');
            return [kind, names[0]];
          }));
        }
        if (round === 3) {
          const images = collectImages(body.input);
          state.imageObserved = images.includes(imageUrl);
          if (!state.imageObserved) throw fail('fixture_image_missing_from_model_input');
        }
        const tool = body.tools?.find(entry => entry.name === (round === 1 ? 'search_tool' : 'use_tool'));
        if (!tool) { state.availableToolNames = body.tools?.map(entry => entry.name); throw fail('fixture_tool_missing'); }
        item = { id: `fc_${round}`, type: 'function_call', call_id: `call_${round}`, name: tool.name,
          arguments: JSON.stringify(round === 1 ? { query: 'lilly_probe', limit: 5 }
            : { tool_name: discovered[round === 2 ? 'image' : 'save'], tool_input: round === 2 ? {} : { content: deliverable } }), status: 'completed' };
      } else if (round >= 4 && round <= 5 && state.artifactReadBack) {
        if (round === 5) {
          state.finalFollowup = (body.input || []).slice(-2).map(item => ({ type: item.type, role: item.role }));
        }
        item = { id: 'msg_final', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture complete.', annotations: [] }] };
      } else throw fail('fixture_unexpected_model_request');
      const response = { id: `resp_${round}`, object: 'response', created_at: 1788746400, model, status: 'completed', output: [item],
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
    } });
    const handle = broker.handle.bind(broker);
    broker.handle = (req, res) => {
      res.on('finish', () => {
        state.brokerResponses.push({ lane: req.url.endsWith('/responses') ? 'model' : 'mcp', status: res.statusCode });
        if (res.statusCode >= 400 && req.url.endsWith('/responses')) {
          (state.deniedModelShapes ||= []).push({ model: req.body?.model, previousResponse: Boolean(req.body?.previous_response_id),
            conversation: Boolean(req.body?.conversation), toolTypes: [...new Set((req.body?.tools || []).map(tool => tool.type))], maxTokens: req.body?.max_output_tokens });
        }
        if (req.url.endsWith('/mcp') && req.body?.method === 'tools/list' && res.statusCode === 200) state.catalogRead = true;
      });
      return handle(req, res);
    };
    await broker.listen({ host: '127.0.0.1', port: 3001 });
    const scope = { ownerId: 'fixture-owner', teamId: 'fixture-team', agentId: 'fixture-agent', taskId: 'fixture-task',
      claim: { taskId: 'fixture-task', workerId: 'fixture-worker', claimId: 'fixture-claim' } };
    if (!saved) {
    const lease = broker.open(scope, { model, deadlineMs: 60000, maxModelCalls: 7 });
    fs.mkdirSync('/state/worker/.grok', { recursive: true, mode: 0o700 });
    fs.writeFileSync('/state/worker/.grok/config.toml', modelConfig({ ...scope, model, modelEndpoint: lease.modelEndpoint, modelToken: lease.modelToken }, origin), { mode: 0o600 });
    const tools = [
      { type: 'function', name: 'lilly_probe_image', description: 'Return the private transport test image.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      { type: 'function', name: 'lilly_probe_save', description: 'Save the bounded test deliverable.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } },
    ];
    bridge = await createTaskMcpBridge({ tools, deadlineMs: 60000, maxCalls: 2, onEvent: event => state.safeActivity.push(event), dispatch: async (name, args) => {
      state.toolCalls.push(name);
      if (name === 'lilly_probe_image' && state.toolCalls.length === 1) return { publicResult: { success: true, frameId: 'fixture-frame' },
        privateModelContent: [{ type: 'input_text', text: 'Private synthetic frame for protocol verification.' }, { type: 'input_image', image_url: imageUrl }] };
      if (name !== 'lilly_probe_save' || !state.imageObserved || args.content !== deliverable) throw fail('fixture_write_denied');
      const target = '/workspace/assignment/transport-proof.txt';
      fs.writeFileSync(target, args.content, { flag: 'wx', mode: 0o600 });
      state.fileWrites = (state.fileWrites || 0) + 1;
      const bytes = fs.readFileSync(target); assert.equal(bytes.toString(), deliverable);
      state.artifactReadBack = true;
      state.artifactSha256 = createHash('sha256').update(bytes).digest('hex');
      return { publicResult: { success: true, id: 'fixture-artifact', sha256: state.artifactSha256 } };
    } });
    client = worker(lease.modelToken);
    state.phase = 'initialize-authenticate';
    const initialized = await client.start({ authMethodId: 'xai.api_key' });
    state.advertisedImageInput = initialized.agentCapabilities?.promptCapabilities?.image === true;
    state.phase = 'open-session';
    const descriptor = lease.connectBridge(bridge.mcpServer);
    client.setTaskMcpPermissions({ serverName: descriptor.name, toolNames: tools.map(tool => tool.name) });
    state.mcpApprovalPolicy = 'task-bound-allow-once';
    const session = await client.openSession({ mcpServers: [descriptor] });
    const catalog = await bridge.waitForCatalog({ timeoutMs: 10000 });
    assert.equal(catalog.catalogServed, true);
    state.catalogBarrier = 'production-authenticated-response';
    state.phase = 'scripted-tool-turn';
    const result = await client.prompt(`Run the private image tool, then save the scoped fixture output. This is a scripted transport test, not a user assignment. Continuity marker: ${continuityMarker}`);
    state.stopReason = result.stopReason;
    assert.equal(result.stopReason, 'end_turn'); assert(state.taskModelRequests >= 4 && state.taskModelRequests <= 5);
    assert.deepEqual(state.toolCalls, ['lilly_probe_image', 'lilly_probe_save']);
    assert(state.imageObserved && state.artifactReadBack);
    assert(!JSON.stringify(state.safeActivity).includes(image.toString('base64')));
    state.imageSha256 = createHash('sha256').update(image).digest('hex');
    state.mcpSdkVersion = JSON.parse(fs.readFileSync('/opt/proof-deps/@modelcontextprotocol/sdk/package.json', 'utf8')).version;
    if (stage === 'seed') {
      assert.equal((await bridge.close()).settled, true);
      lease.close();
      const revoked = await fetch(`${lease.modelEndpoint}/responses`, { method: 'POST',
        headers: { Authorization: `Bearer ${lease.modelToken}`, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(revoked.status, 401); await revoked.arrayBuffer();
      state.oldLeaseRevoked = true;
      fs.writeFileSync('/state/worker/lilly-resume-proof.json', JSON.stringify({
        sessionId: session.sessionId, continuityMarker, artifactSha256: state.artifactSha256, fileWrites: state.fileWrites,
      }), { flag: 'wx', mode: 0o600 });
      state.sessionStateSaved = true;
    }
    } else {
      const nextScope = { ...scope, taskId: 'fixture-resume-task', claim: { taskId: 'fixture-resume-task', workerId: 'fixture-worker-2', claimId: 'fixture-resume-claim' } };
      const nextLease = broker.open(nextScope, { model, deadlineMs: 45000, maxModelCalls: 6 });
      fs.writeFileSync('/state/worker/.grok/config.toml', modelConfig({ ...nextScope, model, modelEndpoint: nextLease.modelEndpoint, modelToken: nextLease.modelToken }, origin), { mode: 0o600 });
      const readTool = { type: 'function', name: 'lilly_probe_read', description: 'Read back the existing transport fixture without modifying it.',
        parameters: { type: 'object', properties: {}, additionalProperties: false } };
      bridge = await createTaskMcpBridge({ tools: [readTool], deadlineMs: 45000, maxCalls: 1, onEvent: event => state.safeActivity.push(event), dispatch: async name => {
        assert.equal(name, 'lilly_probe_read');
        state.toolCalls.push(name);
        const bytes = fs.readFileSync('/workspace/assignment/transport-proof.txt');
        assert.equal(createHash('sha256').update(bytes).digest('hex'), state.artifactSha256);
        state.resumeReadBack = true;
        return { publicResult: { success: true, sha256: state.artifactSha256, content: bytes.toString() } };
      } });
      state.phase = 'resume-load'; state.resuming = true;
      client = worker(nextLease.modelToken);
      await client.start({ authMethodId: 'xai.api_key' });
      const nextDescriptor = nextLease.connectBridge(bridge.mcpServer);
      client.setTaskMcpPermissions({ serverName: nextDescriptor.name, toolNames: ['lilly_probe_read'] });
      const loaded = await client.openSession({ sessionId: saved.sessionId, mcpServers: [nextDescriptor] });
      assert.equal(loaded.sessionId, saved.sessionId);
      state.sameSessionLoaded = true;
      await bridge.waitForCatalog({ timeoutMs: 10000 });
      state.phase = 'resume-turn';
      const resumed = await client.prompt('Continue the previous session. Use the new read-only tool to check the saved file; do not write it again.');
      assert.equal(resumed.stopReason, 'end_turn');
      assert(state.resumeContextObserved && state.resumeReadBack);
      assert.equal(state.fileWrites, 1);
      assert.deepEqual(state.toolCalls, ['lilly_probe_read']);
      state.resumeStopReason = resumed.stopReason;
      assert.equal((await bridge.close()).settled, true); nextLease.close();
    }
    state.phase = 'complete'; state.passed = true;
  } catch (error) {
    state.passed = false; state.failure = error.code || 'fixture_failed';
    // Only fixture process-inspection paths are safe diagnostics. Never include
    // arbitrary runtime errors, prompts, environment or credential-bearing URLs.
    if (typeof error.path === 'string' && /^\/proc(?:\/\d+\/stat)?$/.test(error.path)) state.processInspectionPath = error.path;
    if (['open', 'scandir', 'kill'].includes(error.syscall)) state.failureOperation = error.syscall;
  } finally {
    client?.close(); await bridge?.close(); await broker?.close();
  }
  return state;
}

function podman(args, allowed = [0], timeout = 30000) {
  const result = spawnSync('/usr/bin/podman', args, { encoding: 'utf8', timeout, maxBuffer: 512 * 1024,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' }, shell: false, killSignal: 'SIGKILL' });
  if (result.error || !allowed.includes(result.status)) throw new Error(`Fixture container ${args[0]} failed.`);
  return result;
}

function runIsolated(image) {
  assert.equal(process.platform, 'linux'); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const proofId = randomUUID(); const name = `lilly-grok-loop-${proofId}`;
  const root = path.resolve(__dirname, '..');
  assert.match(root, /^\/tmp\/lilly-grok-loop-source\.[A-Za-z0-9]+$/);
  assert.equal(podman(['container', 'exists', name], [0, 1]).status, 1);
  const imageInfo = JSON.parse(podman(['image', 'inspect', image]).stdout)[0];
  assert.equal(imageInfo.Id.replace(/^sha256:/, ''), image.slice(7));
  assert.equal(imageInfo.Config.User, '10001:10001');
  let report;
  try {
    const result = podman(['run', '--rm', '--name', name, '--label', `lilly.loop-proof=${proofId}`, ...sandboxArgs(),
      '--volume', `${root}:/proof:ro`, '--volume', '/usr/local/bin/node:/opt/proof-node:ro',
      '--volume', '/opt/kimibuilt/node_modules:/opt/proof-deps:ro', '--env', 'NODE_PATH=/opt/proof-deps',
      '--entrypoint', '/opt/proof-node', image, '/proof/bin/lilly-grok-loop-proof.js', '--inside'], [0, 1], 75000);
    const line = result.stdout.split('\n').find(entry => entry.startsWith('LOOP_PROOF '));
    assert(line, 'Fixture report missing.'); report = { proofId, image, ...JSON.parse(line.slice(11)) };
  } finally {
    if (podman(['container', 'exists', name], [0, 1]).status === 0) {
      const container = JSON.parse(podman(['container', 'inspect', name]).stdout)[0];
      assert.equal(container.Config.Labels['lilly.loop-proof'], proofId);
      if (container.State.Running) podman(['stop', '--time', '2', name]);
      if (podman(['container', 'exists', name], [0, 1]).status === 0) podman(['rm', name]);
    }
    assert.equal(podman(['container', 'exists', name], [0, 1]).status, 1);
  }
  const sourceSha256 = Object.fromEntries(['bin/lilly-grok-loop-proof.js', 'bin/lilly-grok-image-probe.js',
    'src/grok-build/acp-client.js', 'src/grok-build/kubernetes-supervisor.js', 'src/grok-build/task-mcp-bridge.js', 'src/agent-teams/worker-broker.js']
    .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const completed = { ...report, sourceSha256, containerRemoved: true };
  fs.writeFileSync(path.join(root, `proof-${proofId}.json`), `${JSON.stringify(completed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return completed;
}

function runResumeIsolated(image) {
  assert.equal(process.platform, 'linux'); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const root = path.resolve(__dirname, '..');
  assert.match(root, /^\/tmp\/lilly-grok-loop-source\.[A-Za-z0-9]+$/);
  const info = JSON.parse(podman(['image', 'inspect', image]).stdout)[0];
  assert.equal(info.Id.replace(/^sha256:/, ''), image.slice(7));
  assert.equal(info.Config.User, '10001:10001');
  const proofId = randomUUID();
  const names = ['seed', 'resume'].map(stage => `lilly-grok-loop-${proofId}-${stage}`);
  const directories = ['state', 'workspace'].map(kind => path.join(root, `${kind}-${proofId}`));
  const reports = [];
  const cleanup = name => {
    if (podman(['container', 'exists', name], [0, 1]).status === 0) {
      const container = JSON.parse(podman(['container', 'inspect', name]).stdout)[0];
      assert.equal(container.Config.Labels['lilly.loop-proof'], proofId);
      if (container.State.Running) podman(['stop', '--time', '2', name]);
      if (podman(['container', 'exists', name], [0, 1]).status === 0) podman(['rm', name]);
    }
    assert.equal(podman(['container', 'exists', name], [0, 1]).status, 1);
  };
  for (const name of names) assert.equal(podman(['container', 'exists', name], [0, 1]).status, 1);
  const created = [];
  let passed = false;
  try {
    for (const directory of directories) {
      assert(!fs.existsSync(directory)); fs.mkdirSync(directory, { mode: 0o700 }); created.push(directory);
      fs.chownSync(directory, 10001, 10001);
    }
    for (const [index, stage] of ['seed', 'resume'].entries()) {
      // The first container must be absent before its state is reused.
      if (index === 1) cleanup(names[0]);
      const result = podman(['run', '--rm', '--name', names[index], '--label', `lilly.loop-proof=${proofId}`,
        ...sandboxArgs().filter(arg => !arg.startsWith('--tmpfs=/state/worker:') && !arg.startsWith('--tmpfs=/workspace/assignment:')),
        '--volume', `${root}:/proof:ro`, '--volume', '/usr/local/bin/node:/opt/proof-node:ro',
        '--volume', '/opt/kimibuilt/node_modules:/opt/proof-deps:ro',
        '--volume', `${directories[0]}:/state/worker:rw`, '--volume', `${directories[1]}:/workspace/assignment:rw`,
        '--env', 'NODE_PATH=/opt/proof-deps', '--entrypoint', '/opt/proof-node', image,
        '/proof/bin/lilly-grok-loop-proof.js', `--inside-${stage}`], [0, 1], 75000);
      const line = result.stdout.split('\n').find(entry => entry.startsWith('LOOP_PROOF '));
      assert(line, 'Fixture stage report missing.');
      reports.push({ stage, ...JSON.parse(line.slice(11)) }); cleanup(names[index]);
      if (!reports[index].passed) break;
    }
    passed = reports.length === 2 && reports.every(report => report.passed)
      && reports[0].sessionStateSaved === true && reports[0].oldLeaseRevoked === true
      && reports[1].sameSessionLoaded === true && reports[1].resumeContextObserved === true
      && reports[1].resumeReadBack === true && reports[1].fileWrites === 1;
  } finally {
    // If exact-container cleanup fails, retain the fixture directories and do
    // not delete data that may still be mounted by a running worker.
    for (const name of names) cleanup(name);
    for (const directory of created) {
      assert.equal(path.dirname(path.resolve(directory)), root);
      assert(['state', 'workspace'].some(kind => path.basename(directory) === `${kind}-${proofId}`));
      assert(!fs.lstatSync(directory).isSymbolicLink());
      fs.rmSync(directory, { recursive: true });
    }
  }
  const sourceSha256 = Object.fromEntries(['bin/lilly-grok-loop-proof.js', 'bin/lilly-grok-image-probe.js',
    'src/grok-build/acp-client.js', 'src/grok-build/kubernetes-supervisor.js', 'src/grok-build/task-mcp-bridge.js', 'src/agent-teams/worker-broker.js']
    .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const completed = { proofId, image, passed, isolatedContainerRestart: true, reports, sourceSha256,
    containersRemoved: true, fixtureStateRemoved: true, externalModelCalls: 0, network: 'none' };
  fs.writeFileSync(path.join(root, `proof-${proofId}.json`), `${JSON.stringify(completed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return completed;
}

if (require.main === module) {
  if (process.argv.length === 3 && ['--inside', '--inside-seed', '--inside-resume'].includes(process.argv[2])) inside({ stage: process.argv[2] === '--inside-seed' ? 'seed' : process.argv[2] === '--inside-resume' ? 'resume' : 'single' }).then(report => {
    // PID 1 exit ends all fixture descendants, including a runtime subprocess
    // that outlives ACP close. The host separately verifies container removal.
    process.stdout.write(`LOOP_PROOF ${JSON.stringify(report)}\n`, () => process.exit(report.passed ? 0 : 1));
  }).catch(() => { process.stderr.write('Isolated loop setup failed.\n', () => process.exit(1)); });
  else if (process.argv.length === 5 && ['--run-isolated', '--run-resume'].includes(process.argv[2]) && process.argv[3] === '--image') {
    try { const report = (process.argv[2] === '--run-resume' ? runResumeIsolated(process.argv[4]) : runIsolated(process.argv[4])); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exitCode = report.passed ? 0 : 1; }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  } else { process.stderr.write('Use --run-isolated --image sha256:<id> on Linux.\n'); process.exitCode = 2; }
}

module.exports = { pngFixture, collectImages };

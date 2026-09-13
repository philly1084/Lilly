'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { spawn } = require('node:child_process');
const { GrokBuildAcpClient, GROK_SOURCE_REVISION } = require('../src/grok-build/acp-client');
const { modelConfig } = require('../src/grok-build/kubernetes-supervisor');
const { sandboxArgs } = require('./lilly-grok-image-probe');

async function createLiveTestSupervisor({ image, source, root, proofId, broker, service, model, podman, signal }) {
  assert.equal(process.platform, 'linux');
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.match(root, /^\/tmp\/lilly-grok-team-proof\.[A-Za-z0-9]+$/);
  assert.equal(fs.realpathSync(root), root);
  assert.match(source, /^\/tmp\/lilly-grok-team-source\.[A-Za-z0-9]+$/);
  assert.match(proofId, /^[a-f0-9-]{36}$/);
  const info = JSON.parse((await podman(['image', 'inspect', image])).output)[0];
  assert.equal(info.Id.replace(/^sha256:/, ''), image.slice(7));
  assert.equal(info.Config.User, '10001:10001');
  assert.equal(info.Config.Labels['org.opencontainers.image.revision'], GROK_SOURCE_REVISION);
  assert(!info.Config.Env.some(e => /^(OPENAI_API_KEY|XAI_API_KEY|LILLY_MODEL_API_KEY)=/.test(e)));
  const address = await broker.listen({ host: '127.0.0.1', port: 0 });
  const relayRoot = path.join(root, 'relay'); fs.mkdirSync(relayRoot, { mode: 0o755 });
  const sockets = new Set(); const workers = []; let closed = false;
  const relay = net.createServer(socket => {
    const upstream = net.createConnection({ host: '127.0.0.1', port: address.port });
    for (const stream of [socket, upstream]) { sockets.add(stream); stream.on('close', () => sockets.delete(stream)); }
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
    socket.pipe(upstream); upstream.pipe(socket);
  });
  relay.maxConnections = 64;
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(path.join(relayRoot, 'broker.sock'), resolve); });
  fs.chmodSync(path.join(relayRoot, 'broker.sock'), 0o666);
  const stop = worker => {
    if (worker.closing) return worker.closing;
    worker.closing = (async () => {
      worker.lease.close(); worker.client?.close();
      if ((await podman(['container', 'exists', worker.name], [0, 1])).status === 0) {
        const current = JSON.parse((await podman(['inspect', worker.name])).output)[0];
        assert.equal(current.Config.Labels['lilly.live-test'], proofId);
        assert.equal(current.HostConfig.NetworkMode, 'none');
        worker.id = current.Id;
        if (current.State.Running) await podman(['stop', '--time', '2', current.Id]);
        await podman(['rm', current.Id]);
      }
      assert.equal((await podman(['container', 'exists', worker.name], [0, 1])).status, 1);
      worker.removed = true;
      for (const directory of worker.directories || []) {
        assert.equal(path.dirname(directory), root); assert.equal(fs.realpathSync(directory), directory);
        fs.rmSync(directory, { recursive: true });
      }
      worker.privateMountsRemoved = true;
    })(); return worker.closing;
  };
  return {
    async createWorker(scope) {
      assert(!closed && !signal.aborted && !scope.signal.aborted && workers.length < 3);
      const lease = broker.open({ ...scope, signal: undefined }, { signal: AbortSignal.any([signal, scope.signal]), model, maxModelCalls: 20, deadlineMs: 300000 });
      const worker = { name: `lilly-live-${proofId.slice(0, 8)}-${workers.length}`, lease }; workers.push(worker);
      const home = path.join(root, `home-${workers.length}`); const workspace = path.join(root, `work-${workers.length}`);
      worker.directories = [home, workspace];
      for (const dir of [home, workspace, path.join(home, '.grok')]) { fs.mkdirSync(dir, { mode: 0o700 }); fs.chownSync(dir, 10001, 10001); }
      for (const [name, value] of [['.grok/config.toml', modelConfig({ ...scope, model, modelEndpoint: lease.modelEndpoint, modelToken: lease.modelToken }, 'http://127.0.0.1:3001')],
        ['launch.json', JSON.stringify({ token: lease.modelToken })]]) {
        fs.writeFileSync(path.join(home, name), value, { flag: 'wx', mode: 0o600 }); fs.chownSync(path.join(home, name), 10001, 10001);
      }
      worker.client = new GrokBuildAcpClient({ executable: '/opt/grok/bin/xai-grok-pager', home: '/state/worker', cwd: '/workspace/assignment',
        requestTimeoutMs: 20000, promptTimeoutMs: 300000, spawn: () => spawn('/usr/bin/podman', ['run', '--interactive', '--name', worker.name,
          '--label', `lilly.live-test=${proofId}`, ...sandboxArgs().filter(a => !a.startsWith('--tmpfs=/state/') && !a.startsWith('--tmpfs=/workspace/')),
          '--timeout=300', '--volume', `${home}:/state/worker:rw`, '--volume', `${workspace}:/workspace/assignment:rw`,
          '--volume', `${relayRoot}:/run/lilly-proof:ro`, '--volume', `${source}/bin/lilly-grok-team-worker.js:/opt/team-worker.js:ro`,
          '--volume', `${fs.realpathSync(process.execPath)}:/opt/proof-node:ro`, '--entrypoint', '/opt/proof-node', image, '/opt/team-worker.js'],
        { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' } }) });
      return { client: worker.client, startOptions: { authMethodId: 'xai.api_key' }, connectBridge: lease.connectBridge,
        saveSession: id => service.saveEngineSession(scope, id), close: () => stop(worker) };
    },
    snapshot: () => workers.map(({ name, id, removed, privateMountsRemoved }) => ({ name, id, removed: removed === true, privateMountsRemoved: privateMountsRemoved === true })),
    async close() {
      closed = true;
      const result = await Promise.allSettled(workers.map(stop));
      await broker.close(); for (const socket of sockets) socket.destroy();
      await new Promise(resolve => relay.close(resolve));
      assert(result.every(r => r.status === 'fulfilled'), 'Worker cleanup unconfirmed');
    },
  };
}
module.exports = { createLiveTestSupervisor };

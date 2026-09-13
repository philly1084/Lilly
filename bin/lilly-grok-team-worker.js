#!/usr/bin/env node
'use strict';

// Disposable proof entrypoint, not a production supervisor. One worker gets
// one network-none container and one private state mount. The Unix socket is a
// fixed relay to the authenticated test broker, never an arbitrary proxy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function main() {
  assert.equal(process.pid, 1); assert.equal(process.getuid(), 10001);
  assert(!Object.values(require('node:os').networkInterfaces()).flat().some(entry => !entry.internal));
  const launch = JSON.parse(fs.readFileSync('/state/worker/launch.json', 'utf8'));
  assert.match(launch.token, /^[A-Za-z0-9_-]{40,100}$/);
  const relay = net.createServer(socket => {
    const upstream = net.createConnection('/run/lilly-proof/broker.sock');
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
    socket.pipe(upstream); upstream.pipe(socket);
  });
  relay.maxConnections = 32;
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(3001, '127.0.0.1', resolve); });
  const child = spawn('/opt/grok/bin/xai-grok-pager', ['--no-auto-update', 'agent', 'stdio'], {
    cwd: '/workspace/assignment', shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: '/state/worker', USERPROFILE: '/state/worker', GROK_HOME: '/state/worker/.grok',
      XDG_CONFIG_HOME: '/state/worker/.config', XDG_DATA_HOME: '/state/worker/.local/share',
      XDG_CACHE_HOME: '/state/worker/.cache', LILLY_MODEL_API_KEY: launch.token },
  });
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
  child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
  child.once('error', () => process.exit(1));
  // Exiting container PID 1 tears down its entire private PID namespace. The
  // host proof still stops/removes the exact labelled container and checks it.
  child.once('exit', code => process.exit(code === 0 ? 0 : 1));
}
if (require.main === module) main().catch(() => process.exit(1));

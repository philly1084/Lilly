'use strict';

// Test-only private stdio adapter between the host team fixture and a separate
// sandboxed Chromium container. Never exposed as a model or network endpoint.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { browserNamespaceProfile } = require('./lilly-browser-seccomp');
const { AgentComputerRuntime } = require('../src/agent-computer/runtime');
const METHODS = new Set(['initialize', 'open', 'act', 'observe', 'getModelInput', 'stats', 'dispose']);
const sha = value => createHash('sha256').update(value).digest('hex');

function protocolProbe(now = Date.now) {
  const allowed = new Set(['Runtime.evaluate', 'Runtime.callFunctionOn', 'Page.getLayoutMetrics',
    'Page.captureScreenshot', 'Input.dispatchMouseEvent', 'Browser.close']);
  const pending = new Map(); const recent = [];
  const append = entry => { recent.push(entry); if (recent.length > 24) recent.shift(); };
  return {
    record(direction, message) {
      if (!Number.isSafeInteger(message?.id) || message.id <= 0) return;
      if (direction === 'send' && allowed.has(message.method)) {
        if (pending.size >= 64) pending.delete(pending.keys().next().value);
        pending.set(message.id, { method: message.method, started: now() });
        append({ method: message.method, state: 'sent' });
      } else if (direction === 'receive' && pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id);
        append({ method: entry.method, state: message.error ? 'failed' : 'received', elapsedMs: Math.max(0, now() - entry.started) });
      }
    },
    snapshot() { return { pending: [...pending.values()].map(entry => ({ method: entry.method, elapsedMs: Math.max(0, now() - entry.started) })),
      recent: recent.map(entry => ({ ...entry })) }; },
  };
}

function validRequest(value) {
  return value && Number.isSafeInteger(value.id) && value.id > 0 && METHODS.has(value.method)
    && value.args && typeof value.args === 'object' && !Array.isArray(value.args);
}

async function inside() {
  assert.equal(process.pid, 1); assert.equal(process.getuid(), 10001);
  assert(!Object.values(require('node:os').networkInterfaces()).flat().some(entry => !entry.internal));
  let runtime; let scope; let server; let origin; let clicks = 0; let calls = 0; let queue = Promise.resolve(); let buffered = '';
  let browserPhase = 'not_started';
  let browserVersion = null; let protocolTraceAvailable = false;
  const protocol = protocolProbe();
  const handle = async request => {
    assert(validRequest(request)); assert(++calls <= 64);
    const { method, args } = request;
    if (method === 'initialize') {
      assert(!scope); assert.equal(args.ownerId, 'proof-owner');
      assert.match(args.teamId, /^[a-f0-9-]{36}$/); assert(Array.isArray(args.agentIds) && args.agentIds.length === 2);
      args.agentIds.forEach(id => assert.match(id, /^[a-f0-9-]{36}$/)); scope = args;
      const marker = `private-team-browser-${randomUUID()}`;
      server = http.createServer((req, res) => {
        if (req.url === '/clicked' && req.method === 'POST') { clicks += 1; res.writeHead(204); res.end(); return; }
        if (req.url !== '/' || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
        res.end(`<!doctype html><html><head><title>${marker}</title></head><body style="margin:0;background:#172130;color:white;font:24px sans-serif"><h1 style="margin:32px">Team browser fixture</h1><button id="confirm" style="margin:32px;padding:24px">Confirm fixture</button><p id="status">Waiting</p><script>document.querySelector('#confirm').onclick=async()=>{await fetch('/clicked',{method:'POST'});document.querySelector('#status').textContent='Confirmed';};</script></body></html>`);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
      const driverPackage = process.env.LILLY_BROWSER_PROOF_BUNDLED === 'true'
        ? '/opt/lilly-browser/node_modules/playwright-core' : 'playwright-core';
      const { chromium } = require(driverPackage);
      // Test-only instrumentation of the installed driver's protocol hook. Read
      // only fixed method names/IDs, never retain command arguments or results.
      const driverRoot = path.dirname(require.resolve(`${driverPackage}/package.json`));
      const driverVersion = require(`${driverPackage}/package.json`).version;
      // This private diagnostic hook belongs to 1.53, not newer bundled drivers.
      if (driverVersion === '1.53.0') {
        const { helper } = require(path.join(driverRoot, 'lib/server/helper.js'));
        assert.equal(typeof helper.debugProtocolLogger, 'function');
        helper.debugProtocolLogger = () => protocol.record;
        protocolTraceAvailable = true;
      }
      const instrumented = new WeakSet();
      const instrument = page => {
        if (instrumented.has(page)) return; instrumented.add(page);
        const screenshot = page.screenshot.bind(page);
        page.screenshot = async (...args) => { browserPhase = 'screenshot'; const result = await screenshot(...args); browserPhase = 'screenshot_done'; return result; };
        const locator = page.locator.bind(page);
        page.locator = (...args) => {
          const result = locator(...args); const click = result.click.bind(result);
          result.click = async (...input) => { browserPhase = 'click'; const value = await click(...input); browserPhase = 'click_done'; return value; };
          return result;
        };
      };
      const observedChromium = { launchPersistentContext: async (...args) => {
        const context = await chromium.launchPersistentContext(...args);
        browserVersion = context.browser()?.version(); assert.match(browserVersion, /^\d+\.\d+\.\d+\.\d+$/);
        if (process.env.LILLY_BROWSER_PROOF_BUNDLED === 'true') {
          const expected = JSON.parse(fs.readFileSync(path.join(driverRoot, 'browsers.json'), 'utf8')).browsers.find(entry => entry.name === 'chromium');
          assert.equal(browserVersion, expected.browserVersion, 'Bundled browser must match the pinned driver manifest.');
        }
        context.pages().forEach(instrument); context.on('page', instrument); return context;
      } };
      runtime = new AgentComputerRuntime({ rootDir: '/profiles', chromium: observedChromium,
        executablePath: process.env.LILLY_BROWSER_PROOF_BUNDLED === 'true' ? chromium.executablePath() : '/usr/bin/chromium',
        viewport: { width: 800, height: 600 }, timeoutMs: 15000, maxComputers: 2,
        authorize: async ({ identity, url }) => identity.ownerId === scope.ownerId && identity.teamId === scope.teamId
          && scope.agentIds.includes(identity.agentId) && Boolean(identity.claim?.claimId) && new URL(url).origin === origin });
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      assert.equal(/^CapEff:\s*(\w+)$/m.exec(status)?.[1], '0000000000000000');
      assert.equal(/^NoNewPrivs:\s*(\d+)$/m.exec(status)?.[1], '1');
      assert.equal(/^Seccomp:\s*(\d+)$/m.exec(status)?.[1], '2');
      assert.equal(fs.readFileSync('/proc/self/attr/current', 'utf8').trim(), 'containers-default-0.57.4-apparmor1 (enforce)');
      return { origin, sandboxRequired: true, capabilities: 'none', appArmorEnforced: true,
        playwrightVersion: driverVersion, bundledBrowser: process.env.LILLY_BROWSER_PROOF_BUNDLED === 'true' };
    }
    assert(runtime);
    if (method === 'stats') return { clicks, computers: runtime.computers.size, browserVersion };
    if (method === 'dispose') {
      const stopping = runtime.dispose(); assert.equal(runtime.dispose(), stopping);
      assert((await stopping).every(result => result.status === 'fulfilled'));
      assert.equal(runtime.computers.size, 0);
      assert(!fs.readdirSync('/profiles').some(name => name.endsWith('.lease')));
      await assert.rejects(runtime.open({ ownerId: scope.ownerId, teamId: scope.teamId, agentId: scope.agentIds[0],
        claim: { taskId: 'shutdown-probe', workerId: 'shutdown-probe', claimId: 'shutdown-probe' } }, { url: `${origin}/` }),
      error => error.code === 'computer_disposed' && runtime.isPreDispatchFailure(error));
      assert.equal(runtime.computers.size, 0);
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      return { clicks, closed: true, browserVersion, admissionClosed: true };
    }
    const result = await runtime[method](args.identity, args.input);
    // Match the previously verified browser fixture's shorter Playwright action
    // deadline; production runtime defaults are unchanged.
    if (method === 'open') runtime.owned(args.identity, result.computerId).page.setDefaultTimeout(5000);
    // Wait only for this authored fixture's asynchronous POST/paint, then return
    // a fresh frame. Never replay an action to handle delayed completion.
    if (method === 'act') {
      const until = Date.now() + 2000;
      while (!clicks && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(clicks, 1);
      return runtime.observe(args.identity, result);
    }
    return result;
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffered += chunk; if (buffered.length > 256 * 1024) process.exit(1);
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      queue = queue.then(async () => {
        const request = JSON.parse(line); assert(validRequest(request));
        let response;
        try { response = { id: request.id, result: await handle(request) }; }
        catch (error) { response = { id: request.id, error: /^[a-z_]{1,80}$/.test(error.code || '') ? error.code : 'browser_fixture_failed',
          preDispatch: runtime?.isPreDispatchFailure(error) === true,
          diagnostic: { method: request.method, phase: browserPhase, protocolTraceAvailable, protocol: protocol.snapshot(), timeout: /timeout|timed out/i.test(String(error.message || '')),
            targetClosed: /Target.*closed/i.test(String(error.message || '')) } }; }
        const output = JSON.stringify(response); assert(Buffer.byteLength(output) <= 12 * 1024 * 1024);
        process.stdout.write(`${output}\n`);
      }).catch(() => process.exit(1));
    }
  });
}

async function startTeamBrowser({ image, source, root, proofId, ownerId, teamId, agentIds, podman, report, timeoutSeconds = 150 }) {
  assert(Number.isSafeInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 300);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const info = JSON.parse((await podman(['image', 'inspect', image])).output)[0];
  assert.equal(info.Id.replace(/^sha256:/, ''), image.slice(7));
  assert(!(info.Config.Env || []).some(entry => /^(OPENAI_API_KEY|XAI_API_KEY|LILLY_MODEL_API_KEY)=.+/.test(entry)));
  const bundled = info.Config.Labels?.['lilly.browser-runtime'] === 'bundled-playwright';
  if (bundled) assert.equal(info.Config.Labels['lilly.playwright-version'], '1.63.0');
  const name = `lilly-team-browser-${proofId.slice(0, 8)}`;
  assert.equal((await podman(['container', 'exists', name], [0, 1])).status, 1);
  const baseline = fs.readFileSync('/usr/share/containers/seccomp.json');
  const derived = JSON.stringify(browserNamespaceProfile(JSON.parse(baseline.toString()), { chroot: true }));
  const policyPath = path.join(root, 'browser-seccomp.json'); fs.writeFileSync(policyPath, derived, { flag: 'wx', mode: 0o600 });
  const state = report.browser = { name, image, baselineSha256: sha(baseline), derivedSha256: sha(derived), removed: false };
  const child = spawn('/usr/bin/podman', ['--runtime=/usr/sbin/runc', 'run', '--interactive', '--name', name,
    '--label', `lilly.team-browser-proof=${proofId}`, '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--security-opt', `seccomp=${policyPath}`, '--user=10001:10001', '--memory=768m', '--cpus=1',
    '--pids-limit=128', '--shm-size=128m', `--timeout=${timeoutSeconds}`, '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=64m',
    '--tmpfs=/profiles:rw,nosuid,nodev,mode=1777,size=64m', '--env', 'HOME=/tmp', '--env', 'NODE_PATH=/opt/proof-deps',
    '--env', `LILLY_BROWSER_PROOF_BUNDLED=${bundled}`,
    '--volume', `${source}:/proof:ro`, '--volume', '/opt/kimibuilt/node_modules:/opt/proof-deps:ro',
    '--entrypoint', '/usr/local/bin/node', image, '/proof/bin/lilly-team-browser-proof.js', '--inside'],
  { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' } });
  const pending = new Map(); const noDispatch = new WeakSet(); let id = 0; let buffer = ''; let terminal = false; let closing;
  const failPending = () => { terminal = true; for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Browser fixture process stopped.')); } pending.clear(); };
  child.on('error', failPending); child.on('exit', failPending); child.stderr.on('data', () => {}); child.stdin.on('error', failPending);
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    buffer += chunk; if (Buffer.byteLength(buffer) > 12 * 1024 * 1024) { failPending(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line); const task = pending.get(response.id); if (!task) continue;
        pending.delete(response.id); clearTimeout(task.timer);
        if (response.error) {
          state.lastFailure = { code: response.error, ...response.diagnostic };
          const error = Object.assign(new Error('Browser fixture operation failed.'), { code: response.error });
          if (response.preDispatch === true) noDispatch.add(error); task.reject(error);
        } else task.resolve(response.result);
      } catch { failPending(); }
    }
  });
  const request = (method, args = {}) => new Promise((resolve, reject) => {
    if (terminal || pending.size >= 16) { reject(new Error('Browser fixture unavailable.')); return; }
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error('Browser fixture observation deadline.')); }, 25000);
    pending.set(next, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id: next, method, args })}\n`);
  });
  const close = () => closing ||= (async () => {
    if (!terminal) { try { state.shutdown = await request('dispose'); } catch { state.shutdown = { closed: false }; } }
    if ((await podman(['container', 'exists', name], [0, 1])).status === 0) {
      const container = JSON.parse((await podman(['inspect', name])).output)[0];
      assert.equal(container.Config.Labels['lilly.team-browser-proof'], proofId); assert.equal(container.HostConfig.NetworkMode, 'none');
      if (state.containerId) assert.equal(state.containerId, container.Id); state.containerId = container.Id;
      if (container.State.Running) await podman(['stop', '--time', '2', container.Id]);
      await podman(['rm', container.Id]);
    } else assert(state.containerId, 'Browser container was never observed.');
    assert.equal((await podman(['container', 'exists', name], [0, 1])).status, 1); state.removed = true; failPending();
  })();
  try {
    const ready = await request('initialize', { ownerId, teamId, agentIds });
    const container = JSON.parse((await podman(['inspect', name])).output)[0];
    assert.equal(container.Config.Labels['lilly.team-browser-proof'], proofId); assert(container.State.Running); state.containerId = container.Id;
    state.sandboxRequired = ready.sandboxRequired; state.capabilities = ready.capabilities; state.appArmorEnforced = ready.appArmorEnforced;
    assert.match(ready.playwrightVersion, /^\d+\.\d+\.\d+$/); state.playwrightVersion = ready.playwrightVersion;
    assert.equal(ready.bundledBrowser, bundled); state.bundledBrowser = bundled;
    if (bundled) assert.equal(ready.playwrightVersion, '1.63.0');
    const computer = { isPreDispatchFailure: error => noDispatch.has(error) };
    for (const method of ['open', 'act', 'observe', 'getModelInput']) computer[method] = (identity, input) => {
      assert(!input.signal?.aborted, 'Aborted fixture operation.'); const { signal, ...args } = input;
      return request(method, { identity, input: args });
    };
    return { computer, origin: ready.origin, stats: () => request('stats'), close };
  } catch (error) { await close(); throw error; }
}

if (require.main === module) { assert.deepEqual(process.argv.slice(2), ['--inside']); inside().catch(() => process.exit(1)); }
module.exports = { startTeamBrowser, validRequest, protocolProbe };

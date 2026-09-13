'use strict';

// Real browser/private transport proof. Fixture origin is inside a networkless
// container; there are no model calls, operator credentials or production writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { connectComputer } = require('../src/agent-computer/remote-runtime');
const { browserNamespaceProfile } = require('./lilly-browser-seccomp');
const identity = { ownerId: 'transport-proof-owner', teamId: 'transport-proof-team', agentId: 'transport-proof-agent',
  claim: { taskId: 'transport-proof-task', workerId: 'transport-proof-worker', claimId: 'transport-proof-claim' } };
const origin = 'http://127.0.0.1:4173';
const sha = value => createHash('sha256').update(value).digest('hex');
let insidePhase = 'bootstrap';
const phase = value => { insidePhase = value; process.stderr.write(`TRANSPORT_INSIDE_PHASE ${value}\n`); };
const resourceFailures = () => {
  const count = (file, key) => {
    try { return Number(new RegExp(`^${key} ([0-9]+)$`, 'm').exec(fs.readFileSync(file, 'utf8'))?.[1] || 0); }
    catch { return null; }
  };
  return { pidLimitEvents: count('/sys/fs/cgroup/pids.events', 'max'), oomKills: count('/sys/fs/cgroup/memory.events', 'oom_kill') };
};

async function verifyCliLifecycle(packaged) {
  const { identityKey } = require('../src/agent-computer/runtime');
  const { readProfileOwner, retiredProfilePath } = require('../src/agent-computer/profile-lease');
  const key = identityKey(identity); const lease = `/profiles/${key}.lease`;
  const retained = `/profiles/${key}/lilly-lifecycle-fixture`;
  for (const mode of ['eof', 'sigterm']) {
    phase(`cli_${mode}_spawn`);
    const leaseId = randomUUID();
    const workerPath = packaged ? '/opt/lilly-browser/worker/stdio-worker.js' : path.resolve(__dirname, '../src/agent-computer/stdio-worker.js');
    const child = spawn(process.execPath, [workerPath, '--serve'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LILLY_COMPUTER_IDENTITY: JSON.stringify(identity), LILLY_PROFILE_LEASE_ID: leaseId } });
    child.stderr.resume();
    let exited = false; let watchdog;
    const exit = new Promise((resolve, reject) => {
      watchdog = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not settle its shutdown')); }, 20000);
      child.once('error', reject);
      child.once('close', (code, signal) => { exited = true; clearTimeout(watchdog); resolve({ code, signal }); });
    });
    exit.catch(() => {});
    const client = connectComputer({ input: child.stdout, output: child.stdin, timeoutMs: 15000,
      authorize: async request => JSON.stringify(request.identity) === JSON.stringify(identity) && new URL(request.url).origin === origin,
      // Only this directly spawned child is in scope. A timeout is failure, not
      // termination evidence; the watchdog/finally stops that exact child.
      terminate: async () => { const ended = await exit; assert.deepEqual(ended, { code: 0, signal: null }); } });
    try {
      phase(`cli_${mode}_open`);
      const firstFrame = await client.open(identity, { url: `${origin}/` });
      phase(`cli_${mode}_owner`);
      const owner = await readProfileOwner(lease);
      assert.equal(owner.owner.leaseId, leaseId); assert.equal(owner.owner.profileKey, key);
      phase(`cli_${mode}_reopen`);
      await client.close(identity, { computerId: firstFrame.computerId });
      assert.deepEqual(await readProfileOwner(lease), owner);
      await client.open(identity, { url: `${origin}/` });
      assert.deepEqual(await readProfileOwner(lease), owner);
      if (mode === 'eof') fs.writeFileSync(retained, 'persistent private fixture', { flag: 'wx', mode: 0o600 });
      else assert.equal(fs.readFileSync(retained, 'utf8'), 'persistent private fixture');
      if (mode === 'eof') child.stdin.end(); else assert(child.kill('SIGTERM'));
      phase(`cli_${mode}_exit`);
      assert.deepEqual(await exit, { code: 0, signal: null });
      phase(`cli_${mode}_retained`);
      assert(!fs.existsSync(lease));
      assert.deepEqual(await readProfileOwner(retiredProfilePath(lease, owner.owner)), owner);
      assert.equal(fs.readFileSync(retained, 'utf8'), 'persistent private fixture');
    } finally {
      if (!exited) child.kill('SIGKILL');
      await exit.catch(() => {}); clearTimeout(watchdog);
      await client.dispose();
    }
  }
}

async function inside(packaged = false) {
  assert.equal(process.pid, 1); assert.equal(process.getuid(), 10001);
  assert(!Object.values(require('node:os').networkInterfaces()).flat().some(entry => !entry.internal));
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  assert.equal(/^CapEff:\s*(\w+)$/m.exec(status)?.[1], '0000000000000000');
  assert.equal(/^NoNewPrivs:\s*(\d+)$/m.exec(status)?.[1], '1');
  assert.equal(/^Seccomp:\s*(\d+)$/m.exec(status)?.[1], '2');
  assert(fs.readFileSync('/proc/self/attr/current', 'utf8').includes('(enforce)'));
  const fixture = http.createServer((req, res) => {
    if (req.url !== '/' || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><title>Private transport fixture count 0</title></head><body style="background:#112233;color:white;font:24px sans-serif"><h1>Private transport fixture</h1><button id="confirm" style="padding:24px">Confirm</button><p id="count">0</p><script>let count=0;document.querySelector("#confirm").onclick=()=>{count++;document.title="Private transport fixture count "+count;document.querySelector("#count").textContent=count;};</script></body></html>');
  });
  await new Promise(resolve => fixture.listen(4173, '127.0.0.1', resolve));
  const { chromium } = require('/opt/lilly-browser/node_modules/playwright-core');
  if (packaged) {
    for (const file of ['runtime.js', 'profile-lease.js', 'stdio-channel.js', 'remote-runtime.js', 'stdio-worker.js']) {
      assert.equal(sha(fs.readFileSync(`/opt/lilly-browser/worker/${file}`)), sha(fs.readFileSync(path.resolve(__dirname, '../src/agent-computer', file))));
    }
  }
  await verifyCliLifecycle(packaged);
  assert.deepEqual(resourceFailures(), { pidLimitEvents: 0, oomKills: 0 });
  phase('private_transport');
  const { startWorker } = require(packaged ? '/opt/lilly-browser/worker/stdio-worker' : '../src/agent-computer/stdio-worker');
  const endpoint = startWorker({ identity, chromium, profileLeaseId: process.env.LILLY_PROFILE_LEASE_ID });
  process.stdin.once('end', () => {
    endpoint.close().then(() => { fixture.closeAllConnections(); fixture.close(); }).catch(() => { process.exitCode = 1; });
  });
}

async function run(image, { packaged = false } = {}) {
  assert.equal(process.platform, 'linux'); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const source = path.resolve(__dirname, '..'); assert.match(source, /^\/tmp\/lilly-grok-team-source\.[A-Za-z0-9]+$/);
  const podman = async (args, accepted = [0]) => new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/podman', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let data = ''; let size = 0; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, 20000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill(); else data += chunk; });
    child.stderr.resume(); child.on('error', () => { clearTimeout(timer); reject(new Error('Container command unavailable')); });
    child.on('exit', code => { clearTimeout(timer); if (expired || size > 2 * 1024 * 1024 || !accepted.includes(code)) reject(new Error('Container command unconfirmed')); else resolve({ code, data }); });
  });
  const info = JSON.parse((await podman(['image', 'inspect', image])).data)[0];
  assert.equal(info.Id.replace(/^sha256:/, ''), image.slice(7));
  assert.equal(info.Config.Labels['lilly.browser-runtime'], 'bundled-playwright');
  if (packaged) assert.equal(info.Config.Labels['lilly.private-computer-transport'], 'stdio-v1');
  assert(!(info.Config.Env || []).some(entry => /^(OPENAI_API_KEY|XAI_API_KEY|LILLY_MODEL_API_KEY)=.+/.test(entry)));
  const proofId = randomUUID(); const root = fs.mkdtempSync('/tmp/lilly-computer-transport.');
  const name = `lilly-computer-transport-${proofId.slice(0, 8)}`;
  const baseline = fs.readFileSync('/usr/share/containers/seccomp.json');
  const policy = path.join(root, 'seccomp.json');
  fs.writeFileSync(policy, JSON.stringify(browserNamespaceProfile(JSON.parse(baseline), { chroot: true })), { flag: 'wx', mode: 0o600 });
  const report = { proofId, root, name, image, packagedRuntime: packaged, pidsLimit: 256, externalModelCalls: 0, checks: [], passed: false, removed: false,
    baselineSha256: sha(baseline), sourceSha256: {} };
  process.stdout.write(`TRANSPORT_PROOF_HANDLE ${JSON.stringify({ proofId, root, name })}\n`);
  assert.equal((await podman(['container', 'exists', name], [0, 1])).code, 1);
  let client; let child; let containerId; let termination;
  const terminate = () => termination ||= (async () => {
    if ((await podman(['container', 'exists', name], [0, 1])).code === 0) {
      const container = JSON.parse((await podman(['inspect', name])).data)[0];
      assert.equal(container.Config.Labels['lilly.computer-transport-proof'], proofId);
      if (containerId) assert.equal(container.Id, containerId);
      assert.equal(container.HostConfig.NetworkMode, 'none'); containerId = container.Id;
      if (container.State.Running) await podman(['stop', '--time', '2', container.Id]);
      await podman(['rm', container.Id]);
    } else assert(containerId, 'Container creation/termination never observed.');
    assert.equal((await podman(['container', 'exists', name], [0, 1])).code, 1);
    report.removed = true;
  })();
  try {
    child = spawn('/usr/bin/podman', ['--runtime=/usr/sbin/runc', 'run', '--interactive', '--name', name,
      '--label', `lilly.computer-transport-proof=${proofId}`, '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--security-opt', `seccomp=${policy}`, '--user=10001:10001', '--memory=768m', '--cpus=1',
      // CLI verification adds a real supervisor/worker process pair. Chromium
      // threads count toward pids.max; retain a bounded allowance for that pair.
      '--pids-limit=256', '--shm-size=128m', '--timeout=120', '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=64m',
      '--tmpfs=/profiles:rw,nosuid,nodev,mode=1777,size=64m', '--env', 'HOME=/tmp', '--env', `LILLY_PROFILE_LEASE_ID=${proofId}`, '--volume', `${source}:/proof:ro`,
      '--entrypoint', '/usr/local/bin/node', image, '/proof/bin/lilly-computer-transport-proof.js', packaged ? '--inside-packaged' : '--inside'],
    { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' } });
    let diagnostic = '';
    child.stderr.on('data', chunk => {
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-2048);
      const phases = [...diagnostic.matchAll(/TRANSPORT_INSIDE_PHASE ([a-z_]{1,80})\n/g)];
      if (phases.length) report.insidePhase = phases.at(-1)[1];
      const match = diagnostic.match(/TRANSPORT_INSIDE_FAILURE (\{[^\n]+\})\n/);
      if (match) {
        try {
          const detail = JSON.parse(match[1]);
          if (/^[a-z_]{1,80}$/.test(detail.phase) && /^(computer_[a-z_]{1,80}|assertion|fixture_failure)$/.test(detail.code)) {
            report.insideFailure = { phase: detail.phase, code: detail.code };
            if (detail.resources && ['pidLimitEvents', 'oomKills'].every(key => detail.resources[key] === null || Number.isSafeInteger(detail.resources[key]))) report.insideFailure.resources = detail.resources;
          }
        } catch { /* Discard unstructured browser diagnostics. */ }
      }
    }); child.on('error', () => {});
    const operations = []; let allowed = true;
    client = connectComputer({ input: child.stdout, output: child.stdin, terminate, timeoutMs: 40000,
      authorize: async request => {
        assert.deepEqual(request.identity, identity); operations.push(request.operation);
        return allowed && new URL(request.url).origin === origin;
      } });
    const view = await client.open(identity, { url: `${origin}/` });
    if (packaged) report.checks.push('five_baked_runtime_files_match_source_and_packaged_worker_opens_browser');
    report.checks.push('standalone_cli_eof_and_sigterm_close_real_browser_and_exit_zero',
      'fresh_cli_process_reuses_retained_profile_with_new_verified_lease', 'cli_lifecycle_has_no_pid_limit_or_oom_kill_events',
      'same_cli_worker_closes_and_reopens_with_original_owner_generation',
      'graceful_cli_shutdown_retires_original_owner_for_fresh_recovery');
    const container = JSON.parse((await podman(['inspect', name])).data)[0];
    assert.equal(container.Config.Labels['lilly.computer-transport-proof'], proofId); assert(container.State.Running); containerId = container.Id;
    assert(!JSON.stringify(view).includes('image')); assert(!JSON.stringify(view).includes(origin));
    const pixels = await client.getModelInput(identity, view);
    assert(pixels.some(item => item.type === 'input_image' && item.image_url.startsWith('data:image/png;base64,')));
    assert(pixels.some(item => item.type === 'input_text' && item.text.includes('count 0')));
    report.checks.push('real_browser_open_crosses_private_process_transport', 'pixels_remain_model_only_and_policy_returns_to_host');
    const acted = await client.act(identity, { computerId: view.computerId, frameId: view.frameId, action: { type: 'click', selector: '#confirm' } });
    const changed = await client.getModelInput(identity, acted);
    assert(changed.some(item => item.type === 'input_text' && item.text.includes('count 1')));
    assert.notEqual(changed.find(item => item.type === 'input_image').image_url, pixels.find(item => item.type === 'input_image').image_url);
    const stale = await client.act(identity, { computerId: view.computerId, frameId: view.frameId, action: { type: 'click', selector: '#confirm' } }).catch(error => error);
    assert.equal(stale.code, 'computer_stale_frame'); assert(client.isPreDispatchFailure(stale));
    const current = await client.observe(identity, { computerId: view.computerId });
    assert((await client.getModelInput(identity, current)).some(item => item.type === 'input_text' && item.text.includes('count 1')));
    report.checks.push('real_click_changes_pixels_once', 'stale_frame_rejection_preserves_runtime_provenance_without_replay');
    allowed = false;
    await assert.rejects(client.getModelInput(identity, current), error => error.code === 'computer_policy_denied');
    assert(operations.includes('model_input') && operations.includes('act') && operations.includes('navigate'));
    report.checks.push('fresh_host_permission_revocation_blocks_later_model_input');
    const stopping = client.dispose(); assert.equal(client.dispose(), stopping);
    assert((await stopping).every(result => result.status === 'fulfilled'));
    await assert.rejects(client.open(identity, { url: `${origin}/` }), error => error.code === 'computer_disposed');
    report.checks.push('same_disposal_closes_browser_and_exact_container', 'disposed_adapter_cannot_reopen');
    report.checks.push('task_bound_profile_owner_written_verified_and_retired_with_real_browser');
    report.passed = true;
  } catch (error) { report.failure = /^computer_[a-z_]+$/.test(error.code || '') ? error.code : 'transport_proof_failed'; }
  finally {
    try { if (client) await client.dispose(); await terminate(); } catch { report.cleanupUnconfirmed = true; report.passed = false; }
    for (const file of ['bin/lilly-computer-transport-proof.js', 'bin/lilly-browser-seccomp.js', 'src/agent-computer/runtime.js', 'src/agent-computer/profile-lease.js',
      'src/agent-computer/stdio-channel.js', 'src/agent-computer/remote-runtime.js', 'src/agent-computer/stdio-worker.js']) report.sourceSha256[file] = sha(fs.readFileSync(path.join(source, file)));
    fs.writeFileSync(path.join(root, 'proof-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (require.main === module) {
  if (['--inside', '--inside-packaged'].includes(process.argv[2]) && process.argv.length === 3) {
    const failed = error => {
      const code = /^computer_[a-z_]{1,80}$/.test(error?.code || '') ? error.code : error?.code === 'ERR_ASSERTION' ? 'assertion' : 'fixture_failure';
      process.stderr.write(`TRANSPORT_INSIDE_FAILURE ${JSON.stringify({ phase: insidePhase, code, resources: resourceFailures() })}\n`, () => process.exit(1));
    };
    process.once('uncaughtException', failed); process.once('unhandledRejection', failed);
    inside(process.argv[2] === '--inside-packaged').catch(failed);
  }
  else {
    assert.deepEqual(process.argv.slice(2, 4), ['--run-isolated', '--image']);
    assert(process.argv.length === 5 || (process.argv.length === 6 && process.argv[5] === '--packaged'));
    run(process.argv[4], { packaged: process.argv[5] === '--packaged' }).then(report => { console.log(`TRANSPORT_PROOF_REPORT ${JSON.stringify(report)}`); process.exitCode = report.passed ? 0 : 1; })
      .catch(() => { console.error('Private transport proof failed.'); process.exitCode = 1; });
  }
}

#!/usr/bin/env node
'use strict';

// A real private-browser prerequisite proof. No live website, login, external
// model or production process. Chromium's sandbox is mandatory, never disabled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { AgentComputerRuntime } = require('../src/agent-computer/runtime');
const { browserNamespaceProfile } = require('./lilly-browser-seccomp');
const sha = buffer => createHash('sha256').update(buffer).digest('hex');

function classifyFailure(error) {
  if (error?.code === 'computer_sandbox_unavailable') return 'browser_sandbox_unavailable';
  const message = String(error?.message || '');
  if (/No usable sandbox|Failed to move to new namespace|Operation not permitted|zygote_host_impl_linux/i.test(message)) return 'browser_sandbox_unavailable';
  if (/error while loading shared libraries|Host system is missing dependencies/i.test(message)) return 'browser_dependencies_unavailable';
  if (/Executable doesn't exist|ENOENT/i.test(message)) return 'browser_executable_unavailable';
  return /^[a-zA-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'browser_proof_failed';
}

async function inside({ grok = false } = {}) {
  assert.equal(process.pid, 1); assert.equal(process.getuid(), 10001);
  assert(!Object.values(require('node:os').networkInterfaces()).flat().some(entry => !entry.internal));
  const report = { phase: 'prerequisites', sandboxRequired: true, externalRequests: 0, modelCalls: 0, checks: [] };
  let runtime; let server;
  try {
    // The CLI prerequisite is checked in the actual browser container, not the
    // host's incomplete PATH. Runtime verification itself uses production APIs.
    const npx = spawnSync('/bin/sh', ['-c', 'command -v npx'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(npx.status, 0); report.npxAvailable = true;
    const processStatus = fs.readFileSync('/proc/self/status', 'utf8');
    const securityProfile = fs.readFileSync('/proc/self/attr/current', 'utf8').trim();
    report.security = { appArmorProfile: /^[A-Za-z0-9_.:/() &-]{1,200}$/.test(securityProfile) ? securityProfile : 'unrecognized',
      effectiveCapabilities: /^CapEff:\s*([a-f0-9]+)$/m.exec(processStatus)?.[1],
      seccompMode: /^Seccomp:\s*(\d+)$/m.exec(processStatus)?.[1],
      noNewPrivileges: /^NoNewPrivs:\s*(\d+)$/m.exec(processStatus)?.[1] };
    const namespaceProbe = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '/bin/true'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 8192, shell: false,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    });
    report.namespaceProbe = { exitCode: namespaceProbe.status, launchError: namespaceProbe.error?.code || null,
      permissionDenied: /Operation not permitted|Permission denied/i.test(namespaceProbe.stderr || '') };
    report.namespaceProbes = {};
    for (const kind of ['pid', 'net', 'ipc', 'mount', 'uts']) {
      const result = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', `--${kind}`, '--fork', '/bin/true'], {
        encoding: 'utf8', timeout: 2000, maxBuffer: 8192, shell: false, env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
      });
      report.namespaceProbes[kind] = { exitCode: result.status, launchError: result.error?.code || null,
        permissionDenied: /Operation not permitted|Permission denied/i.test(result.stderr || '') };
    }
    fs.accessSync('/usr/bin/chromium', fs.constants.X_OK);
    const versionResult = spawnSync('/usr/bin/chromium', ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
      shell: false, env: { PATH: '/usr/bin:/bin', HOME: '/tmp' } });
    report.chromiumVersion = /Chromium (\d+\.\d+\.\d+\.\d+)/.exec(versionResult.stdout || '')?.[1] || null;
    const { chromium } = require('playwright-core');
    const marker = `private-browser-${randomUUID()}`; let clicks = 0; let rootRequests = 0; let testContext;
    server = http.createServer((req, res) => {
      if (req.url === '/clicked' && req.method === 'POST') { clicks += 1; report.fixtureClicks = clicks; res.writeHead(204); res.end(); return; }
      if (req.url !== '/' || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
      rootRequests += 1;
      res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
      res.end(`<!doctype html><html><head><title>${marker}</title></head><body style="margin:0;background:#172130;color:#ffffff;font:24px sans-serif">
        <h1 style="margin:32px">Private computer fixture</h1><button id="confirm" style="margin:32px;padding:24px;background:#e6f2ff;color:#172130">Confirm fixture</button>
        <p id="status" style="margin:32px">Waiting</p><script>document.querySelector('#confirm').onclick=async()=>{await fetch('/clicked',{method:'POST'});document.querySelector('#status').textContent='Confirmed';};</script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const identity = { ownerId: 'proof-owner', teamId: 'proof-team', agentId: 'proof-agent',
      claim: { taskId: 'proof-task', workerId: 'proof-worker', claimId: randomUUID() } };
    // Test-only diagnostics before production sanitization. Record fixed facts,
    // never the raw launch message, command, profile path or stack.
    const observedChromium = { launchPersistentContext: async (...args) => {
      try { testContext = await chromium.launchPersistentContext(...args); return testContext; }
      catch (error) {
        const message = String(error?.message || '');
        // Fixed assertion/errno text from this credential-free startup fixture;
        // reject paths, URLs, quotes and other arbitrary launch diagnostics.
        const assertion = /Check failed:([^\r\n]*)/.exec(message)?.[1]?.trim();
        report.launchSignals = {
          assertion: assertion ? assertion.replace(/\u001b\[[0-9;]*m/g, '').replace(/https?:\/\/\S+|\/[^\s,)]+/g, '[redacted]').slice(0, 200) : null,
          noUsableSandbox: /No usable sandbox/i.test(message),
          moveToNamespaceFailed: /Failed to move to new namespace/i.test(message),
          operationNotPermitted: /Operation not permitted/i.test(message),
          permissionDenied: /Permission denied/i.test(message),
          pidNamespaceSupported: /PID namespaces supported/i.test(message),
          networkNamespaceSupported: /Network namespace supported/i.test(message),
          checkFailed: /Check failed/i.test(message),
          receiveFixedMessageFailed: /Check failed:.*ReceiveFixedMessage/.test(message),
          bootPidCheckFailed: /Check failed:[^\r\n]*boot_pid/.test(message),
          realPidCheckFailed: /Check failed:[^\r\n]*real_pid/.test(message),
          processValidCheckFailed: /Check failed:[^\r\n]*process\.IsValid/.test(message),
          zygoteFailure: /zygote_host_impl_linux/i.test(message),
          zygoteSourceLine: Number(/zygote_host_impl_linux\.cc[:(](\d{1,5})/.exec(message)?.[1]) || null,
        };
        throw error;
      }
    } };
    runtime = new AgentComputerRuntime({ rootDir: '/profiles', chromium: observedChromium, executablePath: '/usr/bin/chromium',
      viewport: { width: 800, height: 600 }, timeoutMs: 15000, maxComputers: 1,
      authorize: async ({ identity: requester, url }) => requester.ownerId === identity.ownerId && requester.agentId === identity.agentId
        && requester.claim?.claimId === identity.claim.claimId && new URL(url).origin === origin });
    report.phase = 'sandboxed-launch';
    const first = await runtime.open(identity, { url: `${origin}/` });
    const privateFirst = await runtime.getModelInput(identity, first);
    const firstImage = privateFirst.find(item => item.type === 'input_image').image_url;
    assert.match(firstImage, /^data:image\/png;base64,/);
    assert(!JSON.stringify(first).includes(marker)); assert(!JSON.stringify({ ...first }).includes('data:image'));
    const other = { ...identity, agentId: 'foreign-agent' };
    await assert.rejects(runtime.getModelInput(other, first), { code: 'computer_scope_denied' });
    report.checks.push('sandboxed_real_browser_launch', 'private_image_input_without_public_pixels_or_url', 'foreign_agent_cannot_read_frame');
    // Read only this authored fixture's known element for failure diagnosis.
    const fixturePage = testContext.pages().find(page => page.url() === `${origin}/`);
    report.fixturePage = { rootRequests, titleMatches: first.title === marker,
      confirmButtonCount: fixturePage ? await fixturePage.locator('#confirm').count() : 0,
      confirmButtonVisible: fixturePage ? await fixturePage.locator('#confirm').isVisible() : false };
    // Let the fixture action expose its own diagnostic before the production
    // operation deadline closes the context. This is not a timeout extension.
    fixturePage?.setDefaultTimeout(5000);
    report.phase = 'same-frame-action';
    // Selector is fixture-authored, not a vision prediction. The subsequent
    // frame must come from the same browser after the actual click happens.
    const second = grok
      ? await require('./lilly-grok-browser-proof').runGrokBrowser({ runtime, identity, first, getClicks: () => clicks, report })
      : await runtime.act(identity, { ...first, action: { type: 'click', selector: '#confirm' } });
    const until = Date.now() + 2000;
    while (clicks === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(clicks, 1); assert.equal(second.computerId, first.computerId); assert.notEqual(second.frameId, first.frameId);
    await assert.rejects(runtime.act(identity, { ...first, action: { type: 'click', selector: '#confirm' } }), { code: 'computer_stale_frame' });
    assert.equal(clicks, 1);
    const observed = await runtime.observe(identity, second);
    const privateSecond = await runtime.getModelInput(identity, observed);
    const secondImage = privateSecond.find(item => item.type === 'input_image').image_url;
    const imageBytes = url => Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    assert.notEqual(sha(imageBytes(firstImage)), sha(imageBytes(secondImage)));
    report.frameHashes = [firstImage, secondImage].map(url => sha(imageBytes(url)));
    const publicObservations = JSON.stringify([first, second, observed]);
    assert(!publicObservations.includes(marker)); assert(!publicObservations.includes(origin));
    assert(!publicObservations.includes('data:image')); assert(!publicObservations.includes(imageBytes(firstImage).toString('base64')));
    report.checks.push('action_targets_current_browser_frame', 'stale_frame_cannot_repeat_click', 'fresh_frame_changes_after_real_action');
    report.phase = 'close';
    await runtime.close(identity, observed); assert.equal(runtime.computers.size, 0);
    assert.equal(fs.readdirSync('/profiles').some(name => name.endsWith('.lease')), false);
    report.checks.push('context_closes_before_profile_lease_release'); report.passed = true; report.phase = 'complete';
  } catch (error) {
    report.passed = false; report.failure = classifyFailure(error);
    const diagnostic = String(error?.message || '');
    report.actionSignals = { timeout: /Timeout|timed out/i.test(diagnostic),
      elementNotStable: /element is not stable/i.test(diagnostic),
      pointerIntercepted: /intercepts pointer events/i.test(diagnostic),
      outsideViewport: /outside of the viewport/i.test(diagnostic),
      targetClosed: /Target.*closed/i.test(diagnostic),
      unsafeEvalBlocked: /unsafe-eval|Content Security Policy|EvalError/i.test(diagnostic) };
  }
  finally {
    await runtime?.dispose();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  return report;
}

function podman(args, allowed = [0], timeout = 55000) {
  const result = spawnSync('/usr/bin/podman', args, { encoding: 'utf8', timeout, maxBuffer: 512 * 1024,
    shell: false, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' } });
  if (result.error || !allowed.includes(result.status)) throw new Error('Browser proof container operation failed.');
  return result;
}

function run(image, { namespaceProfile = false, runc = false, chroot = false, grokImage = null } = {}) {
  assert.equal(process.platform, 'linux'); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert(!chroot || namespaceProfile);
  if (grokImage) { assert.match(grokImage, /^sha256:[a-f0-9]{64}$/); assert(namespaceProfile && runc && chroot); }
  const source = path.resolve(__dirname, '..'); assert.match(source, /^\/tmp\/lilly-computer-source\.[A-Za-z0-9]+$/);
  const info = JSON.parse(podman(['image', 'inspect', image]).stdout)[0];
  assert.equal(info.Id.replace(/^sha256:/, ''), image.slice(7));
  assert(!info.Config.Env.some(entry => /^(OPENAI_API_KEY|XAI_API_KEY|LILLY_MODEL_API_KEY)=.+/.test(entry)), 'Image must not bake provider keys.');
  const proofId = randomUUID(); const name = `lilly-browser-proof-${proofId.slice(0, 8)}`;
  const root = fs.mkdtempSync('/tmp/lilly-computer-proof.'); fs.chmodSync(root, 0o700);
  const report = { proofId, name, root, image, sandboxRequired: true, sourceSha256: {}, productionChanged: false,
    ociRuntime: runc ? '/usr/sbin/runc' : 'host-default' };
  process.stdout.write(`COMPUTER_PROOF_HANDLE ${JSON.stringify({ proofId, name, root })}\n`);
  assert.equal(podman(['container', 'exists', name], [0, 1]).status, 1);
  try {
    const securityArgs = [];
    const grokArgs = [];
    if (grokImage) {
      const binaryImage = JSON.parse(podman(['image', 'inspect', grokImage]).stdout)[0];
      assert.equal(binaryImage.Id.replace(/^sha256:/, ''), grokImage.slice(7));
      assert(!(binaryImage.Config.Env || []).some(entry => /^(OPENAI_API_KEY|XAI_API_KEY|LILLY_MODEL_API_KEY)=.+/.test(entry)));
      const binaryDir = path.join(root, 'grok-bin'); fs.mkdirSync(binaryDir, { mode: 0o755 });
      const extractionName = `${name}-binary`;
      assert.equal(podman(['container', 'exists', extractionName], [0, 1]).status, 1);
      try {
        podman(['create', '--name', extractionName, '--label', `lilly.browser-binary-proof=${proofId}`, '--pull=never', '--network=none',
          '--read-only', '--cap-drop=ALL', '--user=10001:10001', '--entrypoint', '/opt/grok/bin/xai-grok-pager', grokImage, '--version']);
        podman(['cp', `${extractionName}:/opt/grok/bin/xai-grok-pager`, path.join(binaryDir, 'xai-grok-pager')]);
        fs.chmodSync(path.join(binaryDir, 'xai-grok-pager'), 0o555);
        const binarySha256 = sha(fs.readFileSync(path.join(binaryDir, 'xai-grok-pager')));
        assert.equal(binarySha256, '16d8494a4b43e377d2b3afb3993982f2683ba2e434bf5769a3b625b27922d0fc');
        report.grokBinary = { image: grokImage, sha256: binarySha256, extractionName };
      } finally {
        if (podman(['container', 'exists', extractionName], [0, 1]).status === 0) {
          const extracted = JSON.parse(podman(['inspect', extractionName]).stdout)[0];
          assert.equal(extracted.Config.Labels['lilly.browser-binary-proof'], proofId); assert.equal(extracted.State.Running, false);
          podman(['rm', extracted.Id]);
        }
        report.grokSourceContainerRemoved = podman(['container', 'exists', extractionName], [0, 1]).status === 1;
      }
      grokArgs.push('--volume', `${binaryDir}:/grok-bin:ro`, '--tmpfs=/grok-state:rw,nosuid,nodev,mode=1777,size=64m',
        '--tmpfs=/grok-work:rw,nosuid,nodev,mode=1777,size=32m');
    }
    if (namespaceProfile) {
      const baseline = fs.readFileSync('/usr/share/containers/seccomp.json');
      const derived = JSON.stringify(browserNamespaceProfile(JSON.parse(baseline.toString()), { chroot }));
      const policyPath = path.join(root, 'browser-seccomp.json');
      fs.writeFileSync(policyPath, derived, { flag: 'wx', mode: 0o600 });
      report.seccompPolicy = { change: chroot ? 'allow-namespace-setns-and-chroot' : 'remove-only-setns-capability-denial', baselineSha256: sha(baseline), derivedSha256: sha(derived) };
      securityArgs.push('--security-opt', `seccomp=${policyPath}`);
    }
    const result = podman([...(runc ? ['--runtime=/usr/sbin/runc'] : []), 'run', '--name', name, '--label', `lilly.browser-proof=${proofId}`, '--pull=never', '--network=none',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=10001:10001', grokImage ? '--memory=1536m' : '--memory=768m', grokImage ? '--cpus=2' : '--cpus=1',
      ...securityArgs, ...grokArgs,
      grokImage ? '--pids-limit=256' : '--pids-limit=128', '--shm-size=128m', grokImage ? '--timeout=90' : '--timeout=45', '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=64m',
      '--tmpfs=/profiles:rw,nosuid,nodev,mode=1777,size=64m', '--env', 'HOME=/tmp', '--env', 'NODE_PATH=/opt/proof-deps',
      '--volume', `${source}:/proof:ro`, '--volume', '/opt/kimibuilt/node_modules:/opt/proof-deps:ro',
      '--entrypoint', '/usr/local/bin/node', image, '/proof/bin/lilly-computer-proof.js', grokImage ? '--inside-grok' : '--inside'], [0, 1], grokImage ? 105000 : 55000);
    const line = result.stdout.split('\n').find(value => value.startsWith('COMPUTER_RESULT '));
    assert(line, 'Browser proof result missing.'); Object.assign(report, JSON.parse(line.slice('COMPUTER_RESULT '.length)));
  } catch { report.passed = false; report.failure ||= 'browser_container_proof_failed'; }
  finally {
    if (podman(['container', 'exists', name], [0, 1]).status === 0) {
      const container = JSON.parse(podman(['container', 'inspect', name]).stdout)[0];
      assert.equal(container.Config.Labels['lilly.browser-proof'], proofId); assert.equal(container.HostConfig.NetworkMode, 'none');
      report.containerId = container.Id;
      if (container.State.Running) podman(['stop', '--time', '2', container.Id]);
      podman(['rm', container.Id]);
    }
    report.containerRemoved = podman(['container', 'exists', name], [0, 1]).status === 1;
    for (const file of ['bin/lilly-computer-proof.js', 'bin/lilly-browser-seccomp.js', 'src/agent-computer/runtime.js', 'src/agent-computer/profile-lease.js']) report.sourceSha256[file] = sha(fs.readFileSync(path.join(source, file)));
    if (grokImage) for (const file of ['bin/lilly-grok-browser-proof.js', 'src/grok-build/acp-client.js', 'src/grok-build/kubernetes-supervisor.js',
      'src/agent-teams/worker-broker.js', 'src/grok-build/task-mcp-bridge.js']) report.sourceSha256[file] = sha(fs.readFileSync(path.join(source, file)));
    fs.writeFileSync(path.join(root, 'proof-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (require.main === module) {
  if (process.argv.length === 3 && ['--inside', '--inside-grok'].includes(process.argv[2])) inside({ grok: process.argv[2] === '--inside-grok' }).then(report => {
    process.stdout.write(`COMPUTER_RESULT ${JSON.stringify(report)}\n`, () => process.exit(report.passed ? 0 : 1));
  }).catch(() => process.exit(1));
  else if (process.argv.length >= 5 && process.argv.length <= 10 && process.argv[2] === '--run-isolated' && process.argv[3] === '--image') {
    const options = process.argv.slice(5);
    const grokIndex = options.indexOf('--grok-image');
    const grokImage = grokIndex >= 0 ? options.splice(grokIndex, 2)[1] : null;
    if (grokIndex >= 0) assert(typeof grokImage === 'string' && /^sha256:[a-f0-9]{64}$/.test(grokImage));
    assert(new Set(options).size === options.length && options.every(option => ['--browser-namespace-profile', '--runc', '--browser-chroot-profile'].includes(option)));
    const report = run(process.argv[4], { namespaceProfile: options.includes('--browser-namespace-profile'), runc: options.includes('--runc'), chroot: options.includes('--browser-chroot-profile'), grokImage });
    process.stdout.write(`COMPUTER_PROOF_REPORT ${JSON.stringify(report)}\n`); process.exitCode = report.passed ? 0 : 1;
  } else throw new Error('Explicit --run-isolated --image sha256:<id> is required.');
}
module.exports = { classifyFailure };

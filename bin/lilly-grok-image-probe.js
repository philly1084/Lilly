#!/usr/bin/env node
'use strict';

// Source-image acceptance probe. No authentication, session/new, prompt or model
// call. Every process has no network, no host mounts, a readonly root and limits.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { GrokBuildAcpClient, GROK_SOURCE_REVISION } = require('../src/grok-build/acp-client');

function run(args, { allowed = [0], timeout = 30000 } = {}) {
  const result = spawnSync('/usr/bin/podman', args, { encoding: 'utf8', timeout,
    maxBuffer: 256 * 1024, shell: false, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' } });
  if (result.error || !allowed.includes(result.status)) throw new Error(`Image probe ${args[0]} failed.`);
  return { status: result.status, output: result.stdout.trim() };
}

const sandboxArgs = () => ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
  '--security-opt=no-new-privileges', '--user=10001:10001', '--memory=512m', '--cpus=1', '--pids-limit=128',
  // Podman 4.9 rejects uid/gid tmpfs options. Sticky writable directories are
  // private to this single-user, no-network probe container, not host mounts.
  '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=32m',
  '--tmpfs=/state/worker:rw,nosuid,nodev,mode=1777,size=64m',
  '--tmpfs=/workspace/assignment:rw,nosuid,nodev,mode=1777,size=16m'];

function removeOwnedProbe(name, proofId) {
  const exists = () => run(['container', 'exists', name], { allowed: [0, 1] }).status === 0;
  if (!exists()) return;
  let container;
  try { container = JSON.parse(run(['container', 'inspect', name]).output)[0]; }
  catch (error) { if (!exists()) return; throw error; }
  assert.equal(container.Config.Labels['lilly.image-probe'], proofId);
  if (container.State.Running) {
    try { run(['stop', '--time', '2', name]); }
    catch (error) { if (!exists()) return; throw error; }
  }
  if (exists()) {
    try { run(['rm', name]); }
    catch (error) { if (!exists()) return; throw error; }
  }
  assert(!exists());
}

async function probe(image, { onPhase = () => {} } = {}) {
  onPhase('inspect-image');
  if (process.platform !== 'linux' || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Linux and an inspected immutable local image ID are required.');
  const inspected = JSON.parse(run(['image', 'inspect', image]).output)[0];
  assert.equal(inspected.Id.replace(/^sha256:/, ''), image.slice(7));
  assert.equal(inspected.Architecture, 'arm64');
  assert.equal(inspected.Os, 'linux');
  assert.equal(inspected.Config.User, '10001:10001');
  assert.equal(inspected.Config.Labels['org.opencontainers.image.revision'], GROK_SOURCE_REVISION);
  // This probe accepts only our image's credential-free baked configuration.
  assert(!inspected.Config.Env.some((entry) => /^(XAI_API_KEY|LILLY_MODEL_API_KEY|OPENAI_API_KEY)=/.test(entry)));
  const once = (entrypoint, args) => {
    const proofId = randomUUID();
    const name = `lilly-grok-check-${proofId}`;
    assert.equal(run(['container', 'exists', name], { allowed: [0, 1] }).status, 1);
    try {
      return run(['run', '--rm', '--name', name, '--label', `lilly.image-probe=${proofId}`,
        ...sandboxArgs(), '--entrypoint', entrypoint, image, ...args]).output;
    } finally { removeOwnedProbe(name, proofId); }
  };
  onPhase('verify-binary-provenance');
  const recordedHash = once('/bin/cat', ['/usr/share/doc/grok-build/binary.sha256']).split(/\s+/)[0];
  const observedHash = once('/usr/bin/sha256sum', ['/opt/grok/bin/xai-grok-pager']).split(/\s+/)[0];
  assert.match(recordedHash, /^[a-f0-9]{64}$/);
  assert.equal(observedHash, recordedHash);
  assert.equal(once('/bin/cat', ['/usr/share/doc/grok-build/PUBLIC_SOURCE_REV']), GROK_SOURCE_REVISION);
  onPhase('version');
  const version = once('/opt/grok/bin/xai-grok-pager', ['--no-auto-update', '--version']);
  assert(version.length > 0 && version.length < 200 && !/[\x00-\x08]/.test(version));

  onPhase('acp-initialize');
  const proofId = randomUUID();
  const name = `lilly-grok-init-${proofId}`;
  assert.equal(run(['container', 'exists', name], { allowed: [0, 1] }).status, 1);
  const client = new GrokBuildAcpClient({
    executable: '/opt/grok/bin/xai-grok-pager', cwd: '/workspace/assignment', home: '/state/worker',
    requestTimeoutMs: 15000, killGraceMs: 1000,
    spawn: (executable, args) => spawn('/usr/bin/podman', ['run', '--rm', '--interactive', '--name', name,
      '--label', `lilly.image-probe=${proofId}`, ...sandboxArgs(), '--entrypoint', executable, image, ...args],
    { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' } }),
  });
  let initialized;
  try { initialized = await client.start(); }
  finally {
    client.close();
    // Killing a stdio client alone does not prove its container stopped. Only
    // this uniquely named, labelled disposable probe may be reaped here.
    removeOwnedProbe(name, proofId);
  }
  return { image, sourceRevision: GROK_SOURCE_REVISION, binarySha256: observedHash, version,
    protocolVersion: initialized.protocolVersion,
    capabilities: { loadSession: initialized.agentCapabilities?.loadSession === true,
      image: initialized.agentCapabilities?.promptCapabilities?.image === true,
      httpMcp: initialized.agentCapabilities?.mcpCapabilities?.http === true },
    network: 'none', modelCalls: 0, sessionsCreated: 0, probeContainerRemoved: true };
}

if (require.main === module) {
  if (process.argv.length !== 5 || process.argv[2] !== '--initialize-only' || process.argv[3] !== '--image') {
    process.stderr.write('Usage: node bin/lilly-grok-image-probe.js --initialize-only --image sha256:<local-image-id>\n');
    process.exitCode = 2;
  } else probe(process.argv[4], { onPhase: phase => process.stderr.write(`Grok image probe: ${phase}\n`) }).then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write('Grok image probe failed; no authenticated session or model task was requested.\n'); process.exitCode = 1; });
}

module.exports = { sandboxArgs, probe };

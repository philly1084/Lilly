'use strict';

// Real packaged helper, private stdin, Linux kernel identity, flock and files.
// Original browser-stop/PVC/CRI fields are synthetic. No agents/models or
// production profiles, databases, Kubernetes objects or credentials are used.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { identityKey } = require('../src/agent-computer/runtime');
const { profileOwner, writeProfileOwner, readProfileOwner } = require('../src/agent-computer/profile-lease');
const { createBrowserStopEvidence } = require('../src/agent-computer/stop-evidence');
const { reserveRecoveryHelper, advanceRecoveryHelper } = require('../src/agent-computer/recovery-helper');
const { createNodeContainerReader } = require('../src/agent-teams/node-container-reader');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['src/agent-computer/recovery-worker.js', 'src/agent-computer/profile-recovery.js', 'src/agent-computer/directory-lock.js',
  'src/agent-computer/runtime.js', 'src/agent-computer/profile-lease.js', 'src/agent-computer/stop-evidence.js',
  'src/agent-computer/node-binding.js', 'src/agent-computer/recovery-helper.js', 'src/agent-teams/cgroup-reader.js'];
function command(args, input) {
  const result = spawnSync('podman', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, shell: false });
  assert.ifError(result.error); return result;
}
function ok(args) { const result = command(args); assert.equal(result.status, 0, `podman ${args[0]} failed`); return result.stdout.trim(); }

async function main() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.deepEqual(process.argv.slice(2, 4), ['--run-isolated', '--image']); assert.equal(process.argv.length, 5);
  const image = process.argv[4]; assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const imageInfo = JSON.parse(ok(['image', 'inspect', image]))[0];
  assert.equal(imageInfo.Architecture, 'arm64'); assert.equal(imageInfo.Config.User, '10001:10001');
  const root = await fs.mkdtemp('/tmp/lilly-recovery-worker.'); const rootDir = path.join(root, 'profiles');
  await fs.mkdir(rootDir, { mode: 0o700 }); await fs.chown(rootDir, 10001, 10001);
  const report = { proofId: randomUUID(), root, image, sourceSha256: {}, checks: [], passed: false, cleaned: false,
    syntheticBrowserStopAndKubernetes: true, modelCalls: 0, productionDataAccess: false };
  for (const file of [...sourceFiles, 'bin/lilly-recovery-worker-proof.js', 'src/agent-teams/node-container-reader.js',
    'src/agent-teams/execution-owner.js', 'src/agent-computer/profile-mount.js',
    'src/agent-computer/recovery-engine.Dockerfile', 'src/agent-computer/recovery-engine.Dockerfile.dockerignore']) {
    report.sourceSha256[file] = sha(await fs.readFile(path.join(__dirname, '..', file)));
  }
  const name = `lilly-recovery-worker-${report.proofId.slice(0, 8)}`; report.containerName = name;
  process.stdout.write(`RECOVERY_WORKER_HANDLE ${JSON.stringify({ proofId: report.proofId, root, name })}\n`);
  let containerId;
  try {
    assert.equal(command(['container', 'exists', name]).status, 1);
    containerId = ok(['run', '-d', '--name', name, '--label', `lilly.proof-id=${report.proofId}`, '--network', 'none',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--pids-limit', '64',
      '-v', `${rootDir}:/profiles:rw`, image, 'node', '-e', 'setInterval(()=>{},1000)']);
    report.containerId = containerId;
    const info = JSON.parse(ok(['inspect', containerId]))[0];
    assert.equal(info.Config.User, '10001:10001'); assert.equal(info.HostConfig.NetworkMode, 'none');
    assert.equal(info.HostConfig.ReadonlyRootfs, true); assert.equal(info.HostConfig.Memory, 128 * 1024 * 1024);
    assert.equal(info.HostConfig.PidsLimit, 64); assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.equal(info.HostConfig.CpuQuota / info.HostConfig.CpuPeriod, 1);
    const manifest = ok(['exec', containerId, 'cat', '/opt/lilly-recovery/source-sha256.txt']);
    const baked = Object.fromEntries(manifest.split('\n').map(line => { const [hash, file] = line.trim().split(/\s+/); return [file, hash]; }));
    assert.deepEqual(Object.keys(baked).sort(), [...sourceFiles].sort());
    for (const file of sourceFiles) assert.equal(baked[file], report.sourceSha256[file]);
    report.checks.push('packaged_sources_match_and_helper_is_nonroot_networkless_readonly');
    const kernel = await createNodeContainerReader().observeProcess({ nodeName: os.hostname(), initPid: info.State.Pid, ownerPid: 1 });
    const identity = { ownerId: 'fixture-owner', teamId: 'fixture-team', agentId: 'fixture-agent', taskId: 'fixture-task',
      claim: { taskId: 'fixture-task', workerId: 'fixture-worker', claimId: randomUUID() } };
    const profileKey = identityKey(identity); const profile = path.join(rootDir, profileKey); const active = `${profile}.lease`;
    await fs.mkdir(profile); await fs.chown(profile, 10001, 10001); await fs.mkdir(active); await fs.chown(active, 10001, 10001);
    await fs.writeFile(path.join(profile, 'saved-data'), 'synthetic profile bytes', { mode: 0o600 });
    await fs.chown(path.join(profile, 'saved-data'), 10001, 10001);
    const lease = { namespace: 'lilly-team-workers', podName: `browser-${'a'.repeat(32)}`, leaseId: randomUUID(), claimId: identity.claim.claimId,
      ownerBootId: randomUUID(), podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`, phase: 'closing', profileKey,
      identityHash: sha(JSON.stringify([identity.ownerId, identity.teamId, identity.agentId])), pvcName: `browser-profile-${'a'.repeat(32)}` };
    const scope = Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]]));
    const now = new Date().toISOString();
    lease.nodeBinding = { version: 1, ...scope, nodeName: os.hostname(), hostBootId: kernel.hostBootId, initPid: 1, initStartTicks: '100',
      pidNamespace: '200', mountNamespace: '300', cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '400' }, observedAt: now };
    lease.stopEvidence = createBrowserStopEvidence(lease, { ...scope, podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: now });
    const owner = await writeProfileOwner(active, profileOwner(lease.leaseId, profileKey));
    await fs.chown(path.join(active, 'owner.json'), 10001, 10001);
    const helperId = randomUUID(); reserveRecoveryHelper(lease, { helperId, image: `registry.example/recovery@${image}` }, now);
    const helper = advanceRecoveryHelper(lease, { helperId, phase: 'provisioning', podUid: randomUUID(), containerId: `containerd://${containerId}` }, now);
    advanceRecoveryHelper(lease, { helperId, phase: 'ready', nodeBinding: { version: 1, podUid: helper.podUid, containerId: helper.containerId,
      nodeName: os.hostname(), hostBootId: kernel.hostBootId, initPid: info.State.Pid, initStartTicks: kernel.init.startTicks,
      pidNamespace: kernel.init.pidNamespace, mountNamespace: kernel.init.mountNamespace,
      cgroup: { path: `/kubepods/pod${helper.podUid}/${containerId}`, device: '0', inode: '500' }, observedAt: now } }, now);
    const stat = await fs.stat(rootDir, { bigint: true });
    const request = { version: 1, identity, lease, root: { device: String(stat.dev), inode: String(stat.ino) } };
    const entry = '/opt/lilly-recovery/src/agent-computer/recovery-worker.js';
    const invoke = (mode, value = request, locked = true) => command(['exec', '-i', containerId,
      ...(locked ? ['/usr/bin/flock', '--exclusive', '--nonblock', '--conflict-exit-code', '73', '--no-fork', '/profiles'] : []),
      '/usr/local/bin/node', entry, `--${mode}`], typeof value === 'string' ? value : JSON.stringify(value));
    for (const [label, mode, value, locked] of [
      ['unlocked_command_cannot_retire_profile', 'recover', request, false],
      ['readback_does_not_initiate_retirement', 'inspect', request, true],
      ['wrong_root_generation_rejected_before_write', 'recover', { ...request, root: { ...request.root, inode: '1' } }, true],
      ['oversized_private_input_rejected', 'recover', 'x'.repeat(65537), true],
    ]) {
      const rejected = invoke(mode, value, locked); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
      assert.equal(rejected.stderr.trim(), 'Private profile helper request rejected.');
      assert.deepEqual(await readProfileOwner(active), owner);
      await assert.rejects(fs.stat(path.join(rootDir, '.lilly-retired')), { code: 'ENOENT' });
      report.checks.push(label);
    }
    // Keep stdin OPEN, as Kubernetes v4 exec must. Newline framing must allow
    // the real helper to return its receipt and exit without waiting for EOF.
    const recovered = await new Promise((resolve, reject) => {
      const child = spawn('podman', ['exec', '-i', containerId, '/usr/bin/flock', '--exclusive', '--nonblock', '--no-fork', '/profiles',
        '/usr/local/bin/node', entry, '--recover'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let stdout = ''; let stderr = ''; let settled = false;
      const done = (error, status) => {
        if (settled) return; settled = true; clearTimeout(timer);
        const stdinStayedOpen = !child.stdin.writableEnded;
        child.stdin.destroy(); if (error) { child.kill('SIGKILL'); reject(error); } else resolve({ status, stdout, stderr, stdinStayedOpen });
      };
      const timer = setTimeout(() => done(new Error('Open-stdin helper did not complete.')), 15000);
      child.on('error', error => done(error)); child.stdin.on('error', error => done(error));
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16384) done(new Error('Output limit exceeded.')); });
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16384) done(new Error('Error output limit exceeded.')); });
      child.once('close', code => done(null, code));
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
    assert.equal(recovered.status, 0, recovered.stderr); assert.equal(recovered.stdinStayedOpen, true);
    report.checks.push('newline_framed_request_completes_while_private_stdin_stays_open');
    const result = JSON.parse(recovered.stdout); assert.equal(result.helperId, helperId);
    assert.deepEqual(result.filesystem.owner, owner); assert.deepEqual(result.filesystem.root, request.root);
    await assert.rejects(fs.stat(active), { code: 'ENOENT' });
    report.checks.push('packaged_private_command_retires_exact_owner_under_real_flock');
    const inspected = invoke('inspect'); assert.equal(inspected.status, 0, inspected.stderr); assert.deepEqual(JSON.parse(inspected.stdout), result);
    report.checks.push('fresh_readback_command_recovers_exact_receipt_without_replaying_write');
    assert.equal(await fs.readFile(path.join(profile, 'saved-data'), 'utf8'), 'synthetic profile bytes');
    report.checks.push('profile_bytes_preserved'); report.passed = true;
  } catch (error) {
    report.failure = error.code || error.name; report.failureMessage = String(error.message).slice(0, 1000); process.exitCode = 1;
  } finally {
    if (containerId) {
      const info = JSON.parse(ok(['inspect', containerId]))[0];
      assert.equal(info.Id, containerId); assert.equal(info.Name.replace(/^\//, ''), name); assert.equal(info.Config.Labels['lilly.proof-id'], report.proofId);
      ok(['stop', '--time', '5', containerId]); ok(['rm', containerId]);
      assert.equal(command(['container', 'exists', containerId]).status, 1); report.cleaned = true;
    }
    await fs.writeFile(path.join(root, 'proof-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(`RECOVERY_WORKER_REPORT ${JSON.stringify(report)}\n`);
  }
}

if (require.main === module) main().catch(() => { process.stderr.write('Recovery worker proof setup or cleanup failed.\n'); process.exitCode = 1; });

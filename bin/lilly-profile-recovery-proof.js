'use strict';

// Real Linux flock/filesystem/process proof, synthetic stop receipts only.
// No browser, model, production profile, database or Kubernetes object is used.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { identityKey } = require('../src/agent-computer/runtime');
const { writeProfileOwner, profileOwner, readProfileOwner } = require('../src/agent-computer/profile-lease');
const { createBrowserStopEvidence } = require('../src/agent-computer/stop-evidence');
const { assertDirectoryLock } = require('../src/agent-computer/directory-lock');
const { recoverProfile } = require('../src/agent-computer/profile-recovery');
const sha = value => createHash('sha256').update(value).digest('hex');
const requestPath = value => typeof value === 'string' && /^\/tmp\/lilly-profile-recovery\.[A-Za-z0-9]+\/request.json$/.test(value);

async function childMode(mode, file) {
  assert(requestPath(file)); assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 10001);
  const request = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(request.rootDir, path.join(path.dirname(file), 'profiles'));
  if (mode === '--hold') {
    await assertDirectoryLock(request.rootDir);
    process.stdout.write('LOCK_HELD\n'); process.stdin.resume();
  } else {
    assert.equal(mode, '--recover');
    process.stdout.write(JSON.stringify(await recoverProfile(request)) + '\n');
  }
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 10001);
  const root = await fs.mkdtemp('/tmp/lilly-profile-recovery.');
  const rootDir = path.join(root, 'profiles'); await fs.mkdir(rootDir, { mode: 0o700 });
  const report = { proofId: randomUUID(), root, uid: process.getuid(), checks: [], passed: false,
    syntheticStopEvidence: true, modelCalls: 0, resourcesChanged: 'new disposable directory only', sourceSha256: {}, children: [] };
  process.stdout.write(`PROFILE_PROOF_HANDLE ${JSON.stringify({ proofId: report.proofId, root })}\n`);
  const identity = { ownerId: 'fixture-owner', teamId: 'fixture-team', agentId: 'fixture-agent', taskId: 'fixture-task',
    claim: { taskId: 'fixture-task', workerId: 'fixture-worker', claimId: randomUUID() } };
  const key = identityKey(identity); const profile = path.join(rootDir, key); const active = `${profile}.lease`;
  await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'saved-data'), 'synthetic persistent profile bytes', { flag: 'wx', mode: 0o600 });
  await fs.mkdir(active);
  const lease = { leaseId: randomUUID(), claimId: identity.claim.claimId, ownerBootId: randomUUID(), namespace: 'lilly-team-workers',
    podName: `browser-${'a'.repeat(32)}`, podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`, phase: 'closing',
    identityHash: sha(JSON.stringify([identity.ownerId, identity.teamId, identity.agentId])) };
  const fields = ['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'];
  const scope = Object.fromEntries(fields.map(field => [field, lease[field]]));
  lease.nodeBinding = { version: 1, ...scope, nodeName: 'synthetic-node', hostBootId: randomUUID(), initPid: 1,
    initStartTicks: '100', pidNamespace: '200', mountNamespace: '300',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '123' }, observedAt: '2026-09-07T00:00:00.000Z' };
  lease.stopEvidence = createBrowserStopEvidence(lease, { ...scope, podStopped: true,
    source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:00:00.000Z' });
  const original = await writeProfileOwner(active, profileOwner(lease.leaseId, key));
  const file = path.join(root, 'request.json');
  await fs.writeFile(file, JSON.stringify({ rootDir, identity, lease }), { flag: 'wx', mode: 0o600 });
  const children = [];
  const start = (mode, locked = true) => {
    const args = [__filename, mode, file];
    const child = spawn(locked ? '/usr/bin/flock' : process.execPath,
      locked ? ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '--no-fork', rootDir, process.execPath, ...args] : args,
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
    const state = { child, exited: false, output: '' }; children.push(state);
    let timer; let held;
    state.held = new Promise(resolve => { held = resolve; });
    state.exit = new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child deadline exceeded')); }, 15000);
      child.once('error', reject);
      child.once('close', (code, signal) => { state.exited = true; clearTimeout(timer);
        report.children.push({ pid: child.pid, code, signal }); resolve({ code, signal }); });
    });
    state.exit.catch(() => {});
    child.stdout.on('data', chunk => {
      state.output += chunk.toString('utf8');
      if (state.output.length > 32768) child.kill('SIGKILL');
      if (state.output === 'LOCK_HELD\n') held();
    });
    child.stderr.resume();
    return state;
  };
  try {
    const unlocked = start('--recover', false); assert.equal((await unlocked.exit).code, 1);
    assert.deepEqual(await readProfileOwner(active), original);
    report.checks.push('unlocked_process_cannot_retire_profile_owner');
    const holder = start('--hold');
    await Promise.race([holder.held, holder.exit.then(() => { throw new Error('Lock holder exited early'); })]);
    const competing = start('--recover'); assert.equal((await competing.exit).code, 73);
    assert.deepEqual(await readProfileOwner(active), original);
    report.checks.push('kernel_directory_flock_excludes_competing_recovery_process');
    assert(holder.child.kill('SIGKILL')); assert.equal((await holder.exit).signal, 'SIGKILL');
    const recovering = start('--recover'); assert.deepEqual(await recovering.exit, { code: 0, signal: null });
    const recovered = JSON.parse(recovering.output); assert.deepEqual(recovered.owner, original);
    await assert.rejects(fs.lstat(active), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(profile, 'saved-data'), 'utf8'), 'synthetic persistent profile bytes');
    report.checks.push('process_death_releases_kernel_lock_for_fresh_recovery', 'atomic_retirement_preserves_profile_bytes_and_owner_generation');
    const retry = start('--recover'); assert.equal((await retry.exit).code, 0); assert.deepEqual(JSON.parse(retry.output), recovered);
    report.checks.push('fresh_process_reads_same_retirement_receipt_without_deleting_data');
    await fs.mkdir(active); const newer = await writeProfileOwner(active, profileOwner(randomUUID(), key));
    const stale = start('--recover'); assert.equal((await stale.exit).code, 1); assert.deepEqual(await readProfileOwner(active), newer);
    report.checks.push('old_recovery_cannot_replace_newer_profile_owner');
    report.passed = true;
  } catch (error) { report.failure = error.code === 'ERR_ASSERTION' ? 'assertion' : 'profile_proof_failed'; }
  finally {
    for (const state of children) if (!state.exited) state.child.kill('SIGKILL');
    await Promise.allSettled(children.map(state => state.exit));
    report.childrenStopped = children.every(state => state.exited);
    if (!report.childrenStopped) report.passed = false;
    for (const file of ['bin/lilly-profile-recovery-proof.js', 'src/agent-computer/profile-recovery.js', 'src/agent-computer/directory-lock.js',
      'src/agent-computer/runtime.js', 'src/agent-computer/profile-lease.js', 'src/agent-computer/stop-evidence.js',
      'src/agent-computer/node-binding.js', 'src/agent-teams/cgroup-reader.js']) {
      report.sourceSha256[file] = sha(await fs.readFile(path.resolve(__dirname, '..', file)));
    }
    await fs.writeFile(path.join(root, 'proof-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(`PROFILE_PROOF_REPORT ${JSON.stringify(report)}`); process.exitCode = report.passed ? 0 : 1;
}

if (require.main === module) {
  const work = ['--recover', '--hold'].includes(process.argv[2]) && process.argv.length === 4 ? childMode(process.argv[2], process.argv[3]) : main();
  work.catch(() => { process.stderr.write('Profile recovery proof failed.\n'); process.exitCode = 1; });
}

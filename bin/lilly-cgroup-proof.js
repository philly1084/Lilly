#!/usr/bin/env node
'use strict';

// Opt-in kernel proof. Creates only its UUID-named cgroup and one fixed Node
// child. No container/Pod/model/browser/service is started or stopped.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { createCgroupKernelReader } = require('../src/agent-teams/cgroup-reader');
const assert = require('node:assert/strict');

async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Proof deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
}

async function main() {
  assert.equal(process.platform, 'linux');
  assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
  const proofId = randomUUID(); const relative = `/lilly-recovery-proof-${proofId}`;
  const directory = '/sys/fs/cgroup' + relative;
  assert.match(directory, /^\/sys\/fs\/cgroup\/lilly-recovery-proof-[a-f0-9-]{36}$/);
  const reportRoot = await fs.mkdtemp('/tmp/lilly-cgroup-proof.'); await fs.chmod(reportRoot, 0o700);
  const report = { proofId, passed: false, checks: [], productionProcessesChanged: false, modelsStarted: 0, cleaned: false, sourceSha256: {} };
  for (const file of ['bin/lilly-cgroup-proof.js', 'src/agent-teams/cgroup-reader.js']) {
    report.sourceSha256[file] = createHash('sha256').update(await fs.readFile(path.resolve(__dirname, '..', file))).digest('hex');
  }
  const groups = []; let child; let finished;
  const sample = createCgroupKernelReader();
  try {
    assert.equal((await fs.statfs('/sys/fs/cgroup', { bigint: true })).type, 0x63677270n);
    for (const target of [directory, `${directory}/browser`]) {
      await fs.mkdir(target); // No recursive create or reuse of an existing group.
      const info = await fs.lstat(target, { bigint: true });
      groups.push({ target, device: info.dev, inode: info.ino });
    }
    assert.equal((await sample(relative)).populated, false);
    report.checks.push('new_owned_group_is_empty');
    child = spawn(process.execPath, ['-e', "setTimeout(()=>process.exit(3),15000);process.stdin.once('data',()=>process.exit(0));process.stdout.write('READY');"],
      { env: {}, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    child.stdin.on('error', () => {});
    finished = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    await bounded(new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += chunk.toString(); if (output === 'READY') resolve(); else if (output.length > 32) reject(new Error('Unexpected child output')); });
      child.once('error', reject); child.once('exit', () => reject(new Error('Child exited before readiness')));
    }), 5000);
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
    report.fixturePid = child.pid;
    await fs.writeFile(`${directory}/browser/cgroup.procs`, String(child.pid));
    assert.equal((await fs.readFile(`${directory}/cgroup.procs`, 'utf8')).trim(), '');
    assert.equal((await sample(relative)).populated, true);
    assert.equal((await sample(`${relative}/browser`)).populated, true);
    report.checks.push('parent_reports_nested_process_despite_empty_direct_process_list');
    child.stdin.end('finish');
    assert.deepEqual(await bounded(finished, 5000), { code: 0, signal: null });
    assert.equal((await sample(relative)).populated, false);
    assert.equal((await sample(`${relative}/browser`)).populated, false);
    report.checks.push('parent_and_child_report_empty_after_owned_process_exits');
    report.passed = true;
  } catch {
    report.failure = 'kernel_fixture_unconfirmed'; process.exitCode = 1;
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (finished) await bounded(finished, 5000);
      for (const group of groups.reverse()) {
        const info = await fs.lstat(group.target, { bigint: true });
        assert.ok(info.isDirectory() && !info.isSymbolicLink());
        assert.equal(info.dev, group.device); assert.equal(info.ino, group.inode);
        assert.equal((await sample(group.target.slice('/sys/fs/cgroup'.length))).populated, false);
        await fs.rmdir(group.target); // Exact owned empty cgroup only.
        await assert.rejects(fs.lstat(group.target), { code: 'ENOENT' });
      }
      report.cleaned = true;
    } catch { report.cleanupUnconfirmed = true; process.exitCode = 1; }
    const reportPath = path.join(reportRoot, 'proof-report.json');
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ reportPath, directory, ...report })}\n`);
  }
}

if (require.main === module) main().catch(() => { process.stderr.write('Kernel fixture setup failed.\n'); process.exitCode = 1; });

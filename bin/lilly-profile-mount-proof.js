'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const os = require('node:os');
const { createNodeContainerReader } = require('../src/agent-teams/node-container-reader');
const { createProfileMountReader } = require('../src/agent-computer/profile-mount');

function podman(args, accepted = [0]) {
  const result = spawnSync('/usr/bin/podman', args, { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024, shell: false });
  if (result.error || !accepted.includes(result.status)) throw new Error('Isolated mount container command unconfirmed');
  return result;
}

async function main() {
  assert.deepEqual(process.argv.slice(2, 4), ['--run-isolated', '--image']); assert.equal(process.argv.length, 5);
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const image = process.argv[4]; assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const imageInfo = JSON.parse(podman(['image', 'inspect', image]).stdout)[0];
  assert.equal(imageInfo.Id.replace(/^sha256:/, ''), image.slice(7)); assert.equal(imageInfo.Architecture, 'arm64');
  const root = await fs.mkdtemp('/tmp/lilly-profile-mount.');
  const profiles = path.join(root, 'profiles'); await fs.mkdir(profiles, { mode: 0o700 }); await fs.chown(profiles, 10001, 10001);
  await fs.writeFile(path.join(profiles, 'saved-data'), 'unchanged mount fixture', { flag: 'wx', mode: 0o600 });
  const stat = await fs.lstat(profiles, { bigint: true }); const rootGeneration = { device: String(stat.dev), inode: String(stat.ino) };
  const report = { proofId: randomUUID(), root, image, checks: [], containers: [], sourceSha256: {}, passed: false,
    externalModelCalls: 0, productionVolumeAccess: false, containerIdentitySource: 'exact-disposable-podman-inspect' };
  process.stdout.write(`MOUNT_PROOF_HANDLE ${JSON.stringify({ proofId: report.proofId, root })}\n`);
  const stop = entry => {
    const exists = podman(['container', 'exists', entry.name], [0, 1]);
    if (exists.status === 1) { entry.removed = true; return; }
    const actual = JSON.parse(podman(['inspect', entry.name]).stdout)[0];
    assert.equal(actual.Name.replace(/^\//, ''), entry.name); assert.equal(actual.Config.Labels['lilly.mount-proof'], report.proofId);
    if (entry.id) assert.equal(actual.Id, entry.id);
    podman(['stop', '--time', '2', actual.Id]); podman(['rm', actual.Id]);
    assert.equal(podman(['container', 'exists', actual.Id], [1]).status, 1); entry.removed = true;
  };
  try {
    for (const mode of ['rw', 'ro']) {
      const entry = { name: `lilly-profile-mount-${report.proofId.slice(0, 8)}-${mode}`, removed: false };
      assert.equal(podman(['container', 'exists', entry.name], [1]).status, 1); report.containers.push(entry);
      entry.id = podman(['run', '-d', '--name', entry.name, '--label', `lilly.mount-proof=${report.proofId}`,
        '--network', 'none', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--read-only', '--memory', '128m', '--cpus', '1', '--pids-limit', '64',
        '-v', `${profiles}:/profiles:${mode}`,
        '--entrypoint', '/usr/local/bin/node', image, '-e', 'setInterval(() => {}, 1000);']).stdout.trim();
      const actual = JSON.parse(podman(['inspect', entry.id]).stdout)[0];
      assert(actual.State.Running); assert.equal(actual.Config.User, '10001:10001');
      assert.equal(actual.HostConfig.NetworkMode, 'none'); assert.equal(actual.HostConfig.Memory, 128 * 1024 * 1024);
      assert(!actual.HostConfig.PortBindings || Object.keys(actual.HostConfig.PortBindings).length === 0);
      const nodeName = os.hostname();
      const kernel = await createNodeContainerReader().observeProcess({ nodeName, initPid: actual.State.Pid, ownerPid: 1 });
      const expected = { nodeName, hostBootId: kernel.hostBootId, initPid: kernel.init.pid, initStartTicks: kernel.init.startTicks,
        pidNamespace: kernel.init.pidNamespace, mountNamespace: kernel.init.mountNamespace, root: rootGeneration };
      const reader = createProfileMountReader();
      if (mode === 'ro') {
        await assert.rejects(reader.observeProfileMount(expected), { code: 'computer_profile_mount_unknown' });
        report.checks.push('real_read_only_profile_mount_is_not_accepted_for_recovery');
      } else {
        const bound = await reader.observeProfileMount(expected);
        assert.deepEqual(bound.root, rootGeneration); assert.equal(bound.initPid, actual.State.Pid); assert.match(bound.mountId, /^[1-9][0-9]*$/);
        report.checks.push('real_nonroot_isolated_mount_matches_opened_directory_and_kernel_mount_id');
        assert.deepEqual(await createProfileMountReader().observeProfileMount(expected), bound);
        report.checks.push('fresh_observer_reads_same_live_process_and_mount_binding');
        await assert.rejects(reader.observeProfileMount({ ...expected, root: { ...rootGeneration, inode: String(stat.ino + 1n) } }),
          { code: 'computer_profile_mount_unknown' });
        report.checks.push('wrong_expected_directory_generation_cannot_pass_a_real_mount');
        await assert.rejects(reader.observeProfileMount({ ...expected, initStartTicks: String(BigInt(expected.initStartTicks) + 1n) }),
          { code: 'computer_profile_mount_unknown' });
        report.checks.push('mismatched_process_start_generation_is_rejected');
      }
      stop(entry);
      await assert.rejects(reader.observeProfileMount(expected), { code: 'computer_profile_mount_unknown' });
    }
    report.checks.push('removed_helpers_cannot_produce_mount_evidence');
    assert.equal(await fs.readFile(path.join(profiles, 'saved-data'), 'utf8'), 'unchanged mount fixture');
    report.checks.push('fixture_profile_bytes_are_unchanged');
    report.passed = true;
  } catch (error) { report.failure = /^computer_|^team_/.test(error.code || '') ? error.code : 'mount_proof_failed'; }
  finally {
    for (const entry of report.containers) {
      try { stop(entry); } catch { report.cleanupUnconfirmed = true; report.passed = false; }
    }
    for (const file of ['bin/lilly-profile-mount-proof.js', 'src/agent-computer/profile-mount.js',
      'src/agent-teams/node-container-reader.js', 'src/agent-teams/execution-owner.js', 'src/agent-teams/cgroup-reader.js']) {
      report.sourceSha256[file] = createHash('sha256').update(await fs.readFile(path.resolve(__dirname, '..', file))).digest('hex');
    }
    await fs.writeFile(path.join(root, 'proof-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    process.stdout.write(`MOUNT_PROOF_REPORT ${JSON.stringify(report)}\n`);
  }
  process.exitCode = report.passed ? 0 : 1;
}

if (require.main === module) main().catch(() => { process.stderr.write('Isolated mount proof failed.\n'); process.exitCode = 1; });

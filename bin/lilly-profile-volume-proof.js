'use strict';

// Host-side read-only observer proof against newly created fixture directories.
// Kubernetes/stop records are synthetic. No production PVC contents are read.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createLocalProfileVolumeReader, bindLocalProfileVolume } = require('../src/agent-computer/local-profile-volume');
const { createBrowserStopEvidence } = require('../src/agent-computer/stop-evidence');

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const root = await fs.mkdtemp('/tmp/lilly-profile-volume.');
  const report = { proofId: randomUUID(), root, uid: process.getuid(), checks: [], passed: false,
    syntheticApiAndStopEvidence: true, productionVolumeContentAccess: false, externalModelCalls: 0, sourceSha256: {} };
  process.stdout.write(`VOLUME_PROOF_HANDLE ${JSON.stringify({ proofId: report.proofId, root })}\n`);
  try {
    const reader = createLocalProfileVolumeReader(); const host = await reader.host();
    assert.equal(host.pidNamespace, host.initPidNamespace); assert.equal(host.mountNamespace, host.initMountNamespace);
    assert.match(host.hostBootId, /^[a-f0-9-]{36}$/);
    report.checks.push('real_host_boot_and_pid_mount_namespaces_are_observed');
    const lease = { leaseId: randomUUID(), claimId: randomUUID(), ownerBootId: randomUUID(), namespace: 'lilly-team-workers',
      podName: `browser-${'a'.repeat(32)}`, podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`,
      phase: 'closing', identityHash: 'c'.repeat(64), pvcName: `browser-profile-${'c'.repeat(32)}` };
    const fields = ['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'];
    lease.nodeBinding = { version: 1, ...Object.fromEntries(fields.map(key => [key, lease[key]])),
      nodeName: host.nodeName, hostBootId: host.hostBootId, initPid: 123, initStartTicks: '100', pidNamespace: '200', mountNamespace: '300',
      cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '123' }, observedAt: '2026-09-07T00:00:00.000Z' };
    lease.stopEvidence = createBrowserStopEvidence(lease, { ...Object.fromEntries(fields.map(key => [key, lease[key]])),
      podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:00:00.000Z' });
    const storageRoot = path.join(root, 'storage'); await fs.mkdir(storageRoot, { mode: 0o700 });
    const pvName = `pvc-${lease.pvcUid}`; const rootDir = path.join(storageRoot, `${pvName}_${lease.namespace}_${lease.pvcName}`);
    assert.equal(path.dirname(rootDir), storageRoot);
    await fs.mkdir(rootDir, { mode: 0o700 }); await fs.writeFile(path.join(rootDir, 'saved-data'), 'preserved fixture', { flag: 'wx', mode: 0o600 });
    const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: lease.pvcName, namespace: lease.namespace,
      uid: lease.pvcUid, annotations: { 'lilly.ai/identity': lease.identityHash } },
    spec: { volumeName: pvName, storageClassName: 'local-path', accessModes: ['ReadWriteOnce'], volumeMode: 'Filesystem' }, status: { phase: 'Bound' } };
    const pv = { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, uid: randomUUID(), annotations: {
      'pv.kubernetes.io/provisioned-by': 'rancher.io/local-path', 'local.path.provisioner/selected-node': host.nodeName } },
    spec: { local: { path: rootDir }, storageClassName: 'local-path', accessModes: ['ReadWriteOnce'], volumeMode: 'Filesystem',
      claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: lease.pvcName, namespace: lease.namespace, uid: lease.pvcUid },
      nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [host.nodeName] }] }] } } },
    status: { phase: 'Bound' } };
    let pvcReads = 0; let pvReads = 0;
    const options = { lease, storageRoot, reader,
      readPVC: async () => { pvcReads += 1; return structuredClone(pvc); }, readPV: async () => { pvReads += 1; return structuredClone(pv); } };
    const bound = await bindLocalProfileVolume(options);
    const stat = await fs.lstat(rootDir, { bigint: true });
    assert.deepEqual(bound.root, { device: String(stat.dev), inode: String(stat.ino) });
    assert.equal(pvcReads, 2); assert.equal(pvReads, 2); assert.equal(bound.profileReleased, undefined);
    report.checks.push('synthetic_pvc_pv_binding_maps_exact_real_directory_generation_twice');
    const fresh = await bindLocalProfileVolume({ ...options, reader: createLocalProfileVolumeReader() });
    assert.deepEqual(fresh.root, bound.root); assert.deepEqual(fresh.pv, bound.pv);
    report.checks.push('fresh_observer_reads_same_binding_without_profile_mutation');
    await assert.rejects(bindLocalProfileVolume({ ...options, readPVC: async () => ({ ...pvc, metadata: { ...pvc.metadata, uid: randomUUID() } }) }),
      { code: 'computer_profile_volume_unknown' });
    report.checks.push('foreign_pvc_uid_cannot_authorize_directory_access');
    const original = `${rootDir}.original`; const replacement = `${rootDir}.replacement`;
    assert.equal(path.dirname(original), storageRoot); assert.equal(path.dirname(replacement), storageRoot);
    let moved = false;
    await assert.rejects(bindLocalProfileVolume({ ...options, reader: { ...reader, directory: async target => {
      const result = await reader.directory(target);
      if (target === rootDir && !moved) { moved = true; await fs.rename(rootDir, original); await fs.mkdir(rootDir, { mode: 0o700 }); }
      return result;
    } } }), { code: 'computer_profile_volume_unknown' });
    assert.equal(await fs.readFile(path.join(original, 'saved-data'), 'utf8'), 'preserved fixture');
    report.checks.push('real_directory_replacement_between_samples_is_rejected_and_original_bytes_retained');
    await fs.rename(rootDir, replacement); await fs.symlink(original, rootDir, 'dir');
    await assert.rejects(bindLocalProfileVolume(options), { code: 'computer_profile_volume_unknown' });
    assert.equal(await fs.readFile(path.join(original, 'saved-data'), 'utf8'), 'preserved fixture');
    report.checks.push('real_symlink_volume_is_rejected_without_following_it_for_recovery');
    report.passed = true;
  } catch (error) { report.failure = /^computer_[a-z_]+$/.test(error.code || '') ? error.code : 'volume_proof_failed'; }
  for (const file of ['bin/lilly-profile-volume-proof.js', 'src/agent-computer/local-profile-volume.js',
    'src/agent-computer/stop-evidence.js', 'src/agent-computer/node-binding.js', 'src/agent-teams/cgroup-reader.js']) {
    report.sourceSha256[file] = createHash('sha256').update(await fs.readFile(path.resolve(__dirname, '..', file))).digest('hex');
  }
  await fs.writeFile(path.join(root, 'proof-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  process.stdout.write(`VOLUME_PROOF_REPORT ${JSON.stringify(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

if (require.main === module) main().catch(() => { process.stderr.write('Isolated volume proof failed.\n'); process.exitCode = 1; });

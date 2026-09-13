'use strict';

const { randomUUID } = require('node:crypto');
const { bindLocalProfileVolume } = require('./local-profile-volume');
const { createBrowserStopEvidence } = require('./stop-evidence');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const storageRoot = '/var/lib/rancher/k3s/storage';
  const lease = { leaseId: randomUUID(), claimId: randomUUID(), ownerBootId: randomUUID(), namespace: 'lilly-team-workers',
    podName: `browser-${'a'.repeat(32)}`, podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`,
    phase: 'closing', identityHash: 'c'.repeat(64), pvcName: `browser-profile-${'c'.repeat(32)}` };
  const nodeName = 'fixture-node'; const hostBootId = randomUUID();
  lease.nodeBinding = { version: 1,
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    nodeName, hostBootId, initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '987' }, observedAt: '2026-09-07T01:00:00.000Z' };
  lease.stopEvidence = createBrowserStopEvidence(lease, {
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T02:00:00.000Z' });
  const pvName = `pvc-${lease.pvcUid}`; const rootDir = `${storageRoot}/${pvName}_${lease.namespace}_${lease.pvcName}`;
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { namespace: lease.namespace, name: lease.pvcName,
    uid: lease.pvcUid, annotations: { 'lilly.ai/identity': lease.identityHash } },
  spec: { volumeName: pvName, storageClassName: 'local-path', accessModes: ['ReadWriteOnce'], volumeMode: 'Filesystem' }, status: { phase: 'Bound' } };
  const pv = { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, uid: randomUUID(), annotations: {
    'pv.kubernetes.io/provisioned-by': 'rancher.io/local-path', 'local.path.provisioner/selected-node': nodeName } },
  spec: { local: { path: rootDir }, storageClassName: 'local-path', accessModes: ['ReadWriteOnce'], volumeMode: 'Filesystem',
    claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: lease.pvcName, namespace: lease.namespace, uid: lease.pvcUid },
    nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [nodeName] }] }] } } },
  status: { phase: 'Bound' } };
  const host = { nodeName, hostBootId, pidNamespace: 'pid:[1]', initPidNamespace: 'pid:[1]', mountNamespace: 'mnt:[2]', initMountNamespace: 'mnt:[2]' };
  const reader = { host: jest.fn(async () => copy(host)), directory: jest.fn(async target => ({ device: '2049', inode: target === storageRoot ? '10' : '11' })) };
  const options = { lease, storageRoot, reader, readPVC: jest.fn(async () => copy(pvc)), readPV: jest.fn(async () => copy(pv)), now: () => '2026-09-07T03:00:00.000Z' };
  return { lease, pvc, pv, host, reader, options, rootDir };
}

test('two independent samples bind exact node-local volume metadata without releasing ownership', async () => {
  const f = fixture(); const result = await bindLocalProfileVolume(f.options);
  expect(result).toMatchObject({ rootDir: f.rootDir, pv: { uid: f.pv.metadata.uid }, root: { device: '2049', inode: '11' },
    volume: { pvcUid: f.lease.pvcUid, nodeName: f.host.nodeName } });
  expect(result.profileReleased).toBeUndefined(); expect(result.filesystem).toBeUndefined();
  expect(f.options.readPVC).toHaveBeenCalledTimes(2); expect(f.options.readPV).toHaveBeenCalledTimes(2);
  expect(f.reader.directory).toHaveBeenCalledTimes(4);
  expect(f.options.readPV).toHaveBeenCalledWith({ name: `pvc-${f.lease.pvcUid}`, signal: undefined });
});

test.each(['pvc_uid', 'claim_uid', 'claim_namespace', 'annotation', 'path', 'parent', 'affinity', 'extra_affinity',
  'host_path', 'csi', 'deleting', 'unbound', 'node', 'boot', 'pid_namespace', 'mount_namespace', 'device', 'phase', 'stop'])
('rejects %s mismatch without accepting a volume binding', async mode => {
  const f = fixture();
  if (mode === 'pvc_uid') f.pvc.metadata.uid = randomUUID();
  if (mode === 'claim_uid') f.pv.spec.claimRef.uid = randomUUID();
  if (mode === 'claim_namespace') f.pv.spec.claimRef.namespace = 'other';
  if (mode === 'annotation') f.pvc.metadata.annotations['lilly.ai/identity'] = 'd'.repeat(64);
  if (mode === 'path') f.pv.spec.local.path = '/some-other-profile';
  if (mode === 'parent') f.options.storageRoot = '/';
  if (mode === 'affinity') f.pv.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values = ['other-node'];
  if (mode === 'extra_affinity') f.pv.spec.nodeAffinity.required.nodeSelectorTerms.push({});
  if (mode === 'host_path') { f.pv.spec.hostPath = { path: f.rootDir }; delete f.pv.spec.local; }
  if (mode === 'csi') f.pv.spec.csi = { driver: 'unexpected' };
  if (mode === 'deleting') f.pvc.metadata.deletionTimestamp = '2026-09-07T02:00:00.000Z';
  if (mode === 'unbound') f.pv.status.phase = 'Released';
  if (mode === 'node') f.host.nodeName = 'other-node';
  if (mode === 'boot') f.host.hostBootId = randomUUID();
  if (mode === 'pid_namespace') f.host.pidNamespace = 'pid:[99]';
  if (mode === 'mount_namespace') f.host.mountNamespace = 'mnt:[99]';
  if (mode === 'device') f.reader.directory.mockImplementation(async target => ({ device: target === f.rootDir ? '1' : '2', inode: '10' }));
  if (mode === 'phase') f.lease.phase = 'ready';
  if (mode === 'stop') delete f.lease.stopEvidence;
  await expect(bindLocalProfileVolume(f.options)).rejects.toMatchObject({ code: 'computer_profile_volume_unknown' });
});

test.each(['pv', 'directory', 'host'])('a changed %s between samples remains unknown', async mode => {
  const f = fixture();
  if (mode === 'pv') f.options.readPV.mockImplementationOnce(async () => copy(f.pv))
    .mockImplementationOnce(async () => ({ ...copy(f.pv), metadata: { ...f.pv.metadata, uid: randomUUID() } }));
  if (mode === 'directory') f.reader.directory.mockResolvedValueOnce({ device: '2049', inode: '10' })
    .mockResolvedValueOnce({ device: '2049', inode: '12' });
  if (mode === 'host') f.reader.host.mockResolvedValueOnce({ ...f.host, pidNamespace: 'pid:[3]', initPidNamespace: 'pid:[3]' });
  await expect(bindLocalProfileVolume(f.options)).rejects.toMatchObject({ code: 'computer_profile_volume_unknown' });
});

test('abort before or during API read prevents late binding and forwards its signal', async () => {
  const f = fixture();
  await expect(bindLocalProfileVolume({ ...f.options, signal: AbortSignal.abort() })).rejects.toBeDefined();
  expect(f.reader.host).not.toHaveBeenCalled();
  const controller = new AbortController(); f.options.readPVC.mockImplementation(async request => {
    expect(request.signal).toBe(controller.signal); controller.abort(); return copy(f.pvc);
  });
  await expect(bindLocalProfileVolume({ ...f.options, signal: controller.signal })).rejects.toBeDefined();
  expect(f.options.readPV).not.toHaveBeenCalled(); expect(f.reader.directory).not.toHaveBeenCalled();
});

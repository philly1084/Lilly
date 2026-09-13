'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path').posix;
const { normalizeBrowserStopEvidence } = require('./stop-evidence');
const fail = () => Object.assign(new Error('Private profile volume binding is unconfirmed.'), { code: 'computer_profile_volume_unknown' });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const generation = stat => ({ device: String(stat.dev), inode: String(stat.ino) });
const namespace = (value, kind) => typeof value === 'string' && new RegExp(`^${kind}:\\[[1-9][0-9]{0,19}\\]$`).test(value);
const rootPath = value => typeof value === 'string' && value !== '/' && /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) && path.resolve(value) === value;

// Runs on the trusted node, never in a model worker. Reads only identity and
// directory metadata; it does not list profile contents, chmod, mount or write.
function createLocalProfileVolumeReader() {
  return {
    async host() {
      if (process.platform !== 'linux') throw fail();
      const [boot, pidNamespace, initPidNamespace, mountNamespace, initMountNamespace] = await Promise.all([
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'), fs.readlink('/proc/self/ns/pid'), fs.readlink('/proc/1/ns/pid'),
        fs.readlink('/proc/self/ns/mnt'), fs.readlink('/proc/1/ns/mnt'),
      ]);
      return { nodeName: os.hostname(), hostBootId: boot.trim(), pidNamespace, initPidNamespace, mountNamespace, initMountNamespace };
    },
    async directory(target) {
      if (process.platform !== 'linux' || !rootPath(target)) throw fail();
      const before = await fs.lstat(target, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(target) !== target) throw fail();
      const after = await fs.lstat(target, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || !same(generation(before), generation(after))) throw fail();
      return generation(after);
    },
  };
}

function objects(lease, pvc, pv, storageRoot) {
  const pvName = `pvc-${lease.pvcUid}`;
  const annotations = pvc?.metadata?.annotations;
  const modes = value => value?.volumeMode === 'Filesystem' && same(value.accessModes, ['ReadWriteOnce']) && value.storageClassName === 'local-path';
  if (pvc?.apiVersion !== 'v1' || pvc.kind !== 'PersistentVolumeClaim' || pvc.metadata?.name !== lease.pvcName
    || pvc.metadata.namespace !== lease.namespace || pvc.metadata.uid !== lease.pvcUid || pvc.metadata.deletionTimestamp
    || annotations?.['lilly.ai/identity'] !== lease.identityHash || pvc.status?.phase !== 'Bound'
    || !modes(pvc.spec) || pvc.spec.volumeName !== pvName) throw fail();
  const metadata = pv?.metadata; const spec = pv?.spec; const claim = spec?.claimRef;
  const allowedSpec = ['accessModes', 'capacity', 'claimRef', 'local', 'nodeAffinity', 'persistentVolumeReclaimPolicy', 'storageClassName', 'volumeMode'];
  if (pv?.apiVersion !== 'v1' || pv.kind !== 'PersistentVolume' || metadata?.name !== pvName || !uuid(metadata.uid)
    || metadata.deletionTimestamp || pv.status?.phase !== 'Bound' || !modes(spec)
    || Object.keys(spec).some(key => !allowedSpec.includes(key))
    || metadata.annotations?.['pv.kubernetes.io/provisioned-by'] !== 'rancher.io/local-path'
    || metadata.annotations?.['local.path.provisioner/selected-node'] !== lease.nodeBinding.nodeName
    || claim?.apiVersion !== 'v1' || claim.kind !== 'PersistentVolumeClaim' || claim.namespace !== lease.namespace
    || claim.name !== lease.pvcName || claim.uid !== lease.pvcUid) throw fail();
  const affinity = { required: { nodeSelectorTerms: [{ matchExpressions: [{
    key: 'kubernetes.io/hostname', operator: 'In', values: [lease.nodeBinding.nodeName],
  }] }] } };
  // Compare normalized JSON object structure without relying on property order.
  const { isDeepStrictEqual } = require('node:util');
  if (!isDeepStrictEqual(spec.nodeAffinity, affinity)) throw fail();
  const rootDir = path.join(storageRoot, `${pvName}_${lease.namespace}_${lease.pvcName}`);
  if (!spec.local || Object.keys(spec.local).length !== 1 || spec.local.path !== rootDir) throw fail();
  return { rootDir, pv: { name: pvName, uid: metadata.uid } };
}

// Read-only first half of recovery mount verification: binds the exact PVC/PV
// to its real node-local directory. This is NOT proof of a helper's /profiles
// mount. The helper transport must compare its mounted root to this generation
// and revalidate this binding while keeping durable task admission fenced.
async function bindLocalProfileVolume({ lease, readPVC, readPV, reader = createLocalProfileVolumeReader(),
  storageRoot = '/var/lib/rancher/k3s/storage', signal, now = () => new Date().toISOString() } = {}) {
  try {
    if (!rootPath(storageRoot) || !['closing', 'reconciliation'].includes(lease?.phase)
      || !/^[a-f0-9]{64}$/.test(lease.identityHash || '') || lease.pvcName !== `browser-profile-${lease.identityHash.slice(0, 32)}`
      || typeof readPVC !== 'function' || typeof readPV !== 'function') throw fail();
    const stop = normalizeBrowserStopEvidence(lease, lease.stopEvidence);
    const guard = () => { if (signal?.aborted) throw fail(); };
    const sample = async () => {
      guard(); const host = await reader.host(); guard();
      if (host.nodeName !== lease.nodeBinding.nodeName || host.hostBootId !== lease.nodeBinding.hostBootId
        || !namespace(host.pidNamespace, 'pid') || !namespace(host.mountNamespace, 'mnt')
        || host.pidNamespace !== host.initPidNamespace || host.mountNamespace !== host.initMountNamespace) throw fail();
      const pvc = await readPVC({ namespace: lease.namespace, name: lease.pvcName, signal }); guard();
      const pv = await readPV({ name: `pvc-${lease.pvcUid}`, signal }); guard();
      const bound = objects(lease, pvc, pv, storageRoot);
      const parent = await reader.directory(storageRoot); guard();
      const root = await reader.directory(bound.rootDir); guard();
      for (const entry of [parent, root]) {
        if (!entry || typeof entry.device !== 'string' || typeof entry.inode !== 'string'
          || !/^(0|[1-9][0-9]{0,19})$/.test(entry.device) || !/^[1-9][0-9]{0,19}$/.test(entry.inode)
          || BigInt(entry.device) > 18446744073709551615n || BigInt(entry.inode) > 18446744073709551615n) throw fail();
      }
      if (parent.device !== root.device || parent.inode === root.inode) throw fail();
      return { ...bound, parent, root, host: { nodeName: host.nodeName, hostBootId: host.hostBootId,
        pidNamespace: host.pidNamespace, mountNamespace: host.mountNamespace } };
    };
    const first = await sample(); const second = await sample();
    if (!same(first, second)) throw fail();
    const observedAt = now();
    if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))
      || new Date(observedAt).toISOString() !== observedAt || Date.parse(observedAt) < Date.parse(stop.observedAt)) throw fail();
    guard();
    return { version: 1, volume: { namespace: lease.namespace, pvcName: lease.pvcName, pvcUid: lease.pvcUid,
      nodeName: first.host.nodeName, hostBootId: first.host.hostBootId }, ...first, observedAt };
  } catch { throw fail(); }
}

module.exports = { createLocalProfileVolumeReader, bindLocalProfileVolume };

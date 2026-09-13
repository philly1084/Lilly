'use strict';

const { normalizeBrowserStopEvidence } = require('./stop-evidence');
const fail = () => Object.assign(new Error('Private profile recovery evidence is unconfirmed.'), { code: 'computer_profile_evidence_unknown' });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const number = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
function generation(value) {
  if (!exact(value, ['device', 'inode']) || !number(value.device) || !number(value.inode) || value.inode === '0') throw fail();
  return { device: value.device, inode: value.inode };
}

// Trusted mount/recovery observer only. This validates the receipt contract;
// it does not turn an untrusted caller's PVC fields into proof of a mount.
// The observer must verify that mount before running recoverProfile, then keep
// admission fenced until this exact receipt is committed and read back.
function normalizeProfileRecoveryEvidence(lease, value) {
  try {
    const stop = normalizeBrowserStopEvidence(lease, lease?.stopEvidence);
    if (!exact(value, ['version', 'source', 'observedAt', 'volume', 'filesystem']) || value.version !== 1
      || value.source !== 'verified-pvc-profile-retirement' || typeof value.observedAt !== 'string'
      || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt
      || Date.parse(value.observedAt) < Date.parse(stop.observedAt) || !/^[a-f0-9]{64}$/.test(lease.profileKey || '')) throw fail();
    const volumeKeys = ['namespace', 'pvcName', 'pvcUid', 'nodeName', 'hostBootId'];
    const expectedVolume = { namespace: lease.namespace, pvcName: lease.pvcName, pvcUid: lease.pvcUid,
      nodeName: lease.nodeBinding.nodeName, hostBootId: lease.nodeBinding.hostBootId };
    if (!exact(value.volume, volumeKeys) || volumeKeys.some(key => typeof expectedVolume[key] !== 'string'
      || value.volume[key] !== expectedVolume[key])) throw fail();
    const f = value.filesystem;
    if (!exact(f, ['version', 'leaseId', 'profileKey', 'stopFingerprint', 'retired', 'profileRetained', 'root', 'profile', 'owner'])
      || f.version !== 1 || f.leaseId !== lease.leaseId || f.profileKey !== lease.profileKey
      || f.stopFingerprint !== stop.fingerprint || f.retired !== true || f.profileRetained !== true
      || !exact(f.owner, ['owner', 'directory', 'marker']) || !exact(f.owner.owner, ['version', 'leaseId', 'profileKey'])
      || f.owner.owner.version !== 1 || f.owner.owner.leaseId !== lease.leaseId || f.owner.owner.profileKey !== lease.profileKey) throw fail();
    const root = generation(f.root); const profile = generation(f.profile);
    const directory = generation(f.owner.directory); const marker = generation(f.owner.marker);
    const generations = [root, profile, directory, marker];
    if (generations.some(entry => entry.device !== root.device) || new Set(generations.map(entry => entry.inode)).size !== 4) throw fail();
    return { version: 1, source: value.source, observedAt: value.observedAt, volume: expectedVolume,
      filesystem: { version: 1, leaseId: lease.leaseId, profileKey: lease.profileKey, stopFingerprint: stop.fingerprint,
        retired: true, profileRetained: true, root, profile,
        owner: { owner: { version: 1, leaseId: lease.leaseId, profileKey: lease.profileKey }, directory, marker } } };
  } catch { throw fail(); }
}

module.exports = { normalizeProfileRecoveryEvidence };

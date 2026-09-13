'use strict';

// Synthetic test/isolated-SQL fixture only. Never use this as a mount observer.
function syntheticProfileRecovery(lease) {
  return { version: 1, source: 'verified-pvc-profile-retirement',
    observedAt: new Date(Date.parse(lease.stopEvidence.observedAt) + 1000).toISOString(),
    volume: { namespace: lease.namespace, pvcName: lease.pvcName, pvcUid: lease.pvcUid,
      nodeName: lease.nodeBinding.nodeName, hostBootId: lease.nodeBinding.hostBootId },
    filesystem: { version: 1, leaseId: lease.leaseId, profileKey: lease.profileKey, stopFingerprint: lease.stopEvidence.fingerprint,
      retired: true, profileRetained: true, root: { device: '1', inode: '10' }, profile: { device: '1', inode: '11' },
      owner: { owner: { version: 1, leaseId: lease.leaseId, profileKey: lease.profileKey },
        directory: { device: '1', inode: '12' }, marker: { device: '1', inode: '13' } } } };
}

module.exports = { syntheticProfileRecovery };

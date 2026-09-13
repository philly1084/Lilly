'use strict';

const { normalizeBrowserStopEvidence } = require('./stop-evidence');
const { normalizeProfileRecoveryEvidence } = require('./profile-recovery-evidence');
const { isRecoveryHelperClosed } = require('./recovery-helper');

function isBrowserLeaseClosed(lease) {
  if (lease?.phase !== 'closed' || lease.podStopped !== true || lease.profileReleased !== true) return false;
  if (!isRecoveryHelperClosed(lease)) return false;
  try {
    if (lease.nodeBinding) {
      normalizeBrowserStopEvidence(lease, lease.stopEvidence);
      normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
    }
    return true;
  } catch { return false; }
}

module.exports = { isBrowserLeaseClosed };

'use strict';

const { normalizeRecoveryHelperIdentity, advanceRecoveryHelper } = require('./recovery-helper');
const fail = () => Object.assign(new Error('Private helper launch requires reconciliation.'), { code: 'team_recovery_launch_conflict', statusCode: 409 });

// A phase read followed by a phase write is not a launch lock: two controllers
// could both POST. Only this row-locked insert/transition grants launch authority.
function beginRecoveryHelperLaunch(lease, input, now) {
  try {
    const helper = lease?.recoveryHelper; normalizeRecoveryHelperIdentity(lease, helper);
    if (!input || Object.keys(input).length !== 1 || input.helperId !== helper.helperId
      || !['closing', 'reconciliation'].includes(lease.phase)) throw fail();
    if (helper.phase === 'reserved' && !helper.launchStartedAt) {
      return { dispatch: true, helper: advanceRecoveryHelper(lease, { helperId: helper.helperId, phase: 'provisioning' }, now) };
    }
    return { dispatch: false, helper };
  } catch { throw fail(); }
}

module.exports = { beginRecoveryHelperLaunch };

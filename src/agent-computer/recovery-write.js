'use strict';

const { isDeepStrictEqual } = require('node:util');
const { recoveryHelperFingerprint } = require('./recovery-helper');
const fail = () => Object.assign(new Error('Private recovery dispatch requires reconciliation.'), { code: 'team_recovery_write_conflict', statusCode: 409 });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;

function normalizeRecoveryWrite(lease, value) {
  if (!exact(value, ['version', 'operationId', 'helperFingerprint', 'root', 'mountId', 'pvUid', 'createdAt']) || value.version !== 1
    || !uuid(value.operationId) || value.helperFingerprint !== recoveryHelperFingerprint(lease, lease.recoveryHelper)
    || !exact(value.root, ['device', 'inode']) || !uint(value.root.device) || !uint(value.root.inode) || value.root.inode === '0'
    || !uint(value.mountId) || value.mountId === '0' || !uuid(value.pvUid)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw fail();
  return { version: 1, operationId: value.operationId, helperFingerprint: value.helperFingerprint,
    root: { device: value.root.device, inode: value.root.inode }, mountId: value.mountId, pvUid: value.pvUid, createdAt: value.createdAt };
}

// Only the transaction that inserts this intent may dispatch a recovery write.
// Even replaying its exact operationId returns dispatch:false: a lost reply or
// restarted controller may inspect existing retirement, never replay the write.
function reserveRecoveryWrite(lease, input, now) {
  try {
    const helper = lease?.recoveryHelper;
    if (!exact(input, ['helperId', 'operationId', 'root', 'mountId', 'pvUid']) || input.helperId !== helper?.helperId
      || !['closing', 'reconciliation'].includes(lease.phase) || helper.phase !== 'ready' || helper.stopEvidence) throw fail();
    const candidate = normalizeRecoveryWrite(lease, { version: 1, operationId: input.operationId,
      helperFingerprint: recoveryHelperFingerprint(lease, helper), root: input.root, mountId: input.mountId, pvUid: input.pvUid, createdAt: now });
    if (helper.writeIntent !== undefined) {
      const intent = normalizeRecoveryWrite(lease, helper.writeIntent);
      for (const key of ['helperFingerprint', 'root', 'mountId', 'pvUid']) if (!isDeepStrictEqual(intent[key], candidate[key])) throw fail();
      return { dispatch: false, intent };
    }
    if (lease.profileRecovery !== undefined) throw fail();
    helper.writeIntent = candidate;
    return { dispatch: true, intent: candidate };
  } catch { throw fail(); }
}

module.exports = { normalizeRecoveryWrite, reserveRecoveryWrite };

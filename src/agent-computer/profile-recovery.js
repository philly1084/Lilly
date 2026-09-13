'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { identityKey, normalizeIdentity } = require('./runtime');
const { readProfileOwner } = require('./profile-lease');
const { normalizeBrowserStopEvidence } = require('./stop-evidence');
const { assertDirectoryLock, syncDirectory } = require('./directory-lock');
const fail = () => Object.assign(new Error('Private profile recovery is unconfirmed.'), { code: 'computer_profile_recovery_unknown' });
const generation = stat => ({ device: String(stat.dev), inode: String(stat.ino) });
const same = (a, b) => a.device === b.device && a.inode === b.inode;

async function directory(target, create = false) {
  if (create) await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(target, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(target) !== target) throw fail();
  return generation(stat);
}

async function exists(target) {
  try { await fs.lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Filesystem component only, on a verified mounted PVC. The caller must fence
// admission until this result is durably acknowledged. Execute this process via
// flock --exclusive --nonblock --no-fork <profile-root> node ... so /proc/locks
// can independently confirm THIS process owns the exact directory lock.
// Positive stop evidence must come from the trusted archive, not a model input.
// Retire the old lock atomically instead of deleting it or the browser profile.
async function settleProfile({ rootDir, identity, lease, signal, expectedRoot } = {}, retiredOnly = false) {
  try {
    const bound = normalizeIdentity(identity);
    const key = identityKey(bound);
    const expectedHash = createHash('sha256').update(JSON.stringify([bound.ownerId, bound.teamId, bound.agentId])).digest('hex');
    if (!['closing', 'reconciliation'].includes(lease?.phase) || lease.identityHash !== expectedHash
      || identity.claim?.claimId !== lease.claimId || typeof identity.claim?.taskId !== 'string'
      || identity.taskId !== identity.claim.taskId) throw fail();
    const stop = normalizeBrowserStopEvidence(lease, lease.stopEvidence);
    const guard = () => { if (signal?.aborted) throw fail(); };
    guard(); const root = await assertDirectoryLock(rootDir); guard();
    if (expectedRoot && !same(root, expectedRoot)) throw fail();
    const profile = path.join(rootDir, key); const profileGeneration = await directory(profile);
    const active = path.join(rootDir, `${key}.lease`);
    const archive = path.join(rootDir, '.lilly-retired');
    const retirement = path.join(archive, lease.leaseId);
    const retired = path.join(retirement, `${key}.lease`);
    await directory(archive, !retiredOnly); await directory(retirement, !retiredOnly); guard();
    const sourceExists = await exists(active); const targetExists = await exists(retired);
    if (sourceExists === targetExists) throw fail(); // Neither or both is unknown.
    if (retiredOnly && sourceExists) throw fail(); // Read-back never initiates retirement.
    const source = sourceExists ? active : retired;
    const owner = await readProfileOwner(source);
    if (owner.owner.leaseId !== lease.leaseId || owner.owner.profileKey !== key
      || (await fs.readdir(source)).join('\n') !== 'owner.json') throw fail();
    guard();
    if (!same(root, await assertDirectoryLock(rootDir)) || !same(profileGeneration, await directory(profile))) throw fail();
    if (sourceExists) {
      // One OS lock serializes recovery processes; durable task occupancy keeps
      // browser admission fenced. Never overwrite a previously retired lock.
      if (await exists(retired)) throw fail();
      guard(); await fs.rename(active, retired);
    }
    // A crash after rename resumes from the same retained owner record. Sync
    // both sides and newly created parents before reporting a settled result.
    await syncDirectory(retirement); await syncDirectory(archive); await syncDirectory(rootDir);
    const confirmed = await readProfileOwner(retired);
    if (!same(confirmed.directory, owner.directory) || !same(confirmed.marker, owner.marker)
      || confirmed.owner.leaseId !== lease.leaseId || confirmed.owner.profileKey !== key
      || await exists(active) || !same(root, await assertDirectoryLock(rootDir))
      || !same(profileGeneration, await directory(profile))) throw fail();
    guard();
    return { version: 1, leaseId: lease.leaseId, profileKey: key, stopFingerprint: stop.fingerprint,
      retired: true, profileRetained: true, root, profile: profileGeneration, owner: confirmed };
  } catch { throw fail(); }
}

const recoverProfile = options => settleProfile(options);
// Lost-reply reconciliation may confirm and fsync an existing retirement, but
// cannot create archive directories or rename an active owner into retirement.
const inspectRecoveredProfile = options => settleProfile(options, true);

module.exports = { recoverProfile, inspectRecoveredProfile };

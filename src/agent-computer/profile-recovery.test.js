'use strict';

jest.mock('./directory-lock', () => ({ assertDirectoryLock: jest.fn(async () => ({ device: '1', inode: '2' })), syncDirectory: jest.fn(async () => {}) }));
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { recoverProfile, inspectRecoveredProfile } = require('./profile-recovery');
const { identityKey } = require('./runtime');
const { profileOwner, writeProfileOwner, retireProfileOwner } = require('./profile-lease');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { assertDirectoryLock, syncDirectory } = require('./directory-lock');
let root;
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); jest.clearAllMocks(); });

async function fixture() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-profile-recovery-'));
  const identity = { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task', claim: { taskId: 'task', workerId: 'worker', claimId: randomUUID() } };
  const key = identityKey(identity); const profile = path.join(root, key); const active = `${profile}.lease`;
  await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'saved-data'), 'preserve exact profile bytes'); await fs.mkdir(active);
  const lease = { leaseId: randomUUID(), claimId: identity.claim.claimId, ownerBootId: randomUUID(), namespace: 'lilly-team-workers',
    podName: `browser-${'a'.repeat(32)}`, podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`,
    phase: 'closing', identityHash: createHash('sha256').update(JSON.stringify(['owner', 'team', 'agent'])).digest('hex') };
  lease.nodeBinding = { version: 1, ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(field => [field, lease[field]])),
    nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 1, initStartTicks: '100', pidNamespace: '200', mountNamespace: '300',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '123' }, observedAt: '2026-09-07T00:00:00.000Z' };
  lease.stopEvidence = createBrowserStopEvidence(lease, { ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(field => [field, lease[field]])),
    podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:00:00.000Z' });
  const owner = await writeProfileOwner(active, profileOwner(lease.leaseId, key));
  const retired = path.join(root, '.lilly-retired', lease.leaseId, `${key}.lease`);
  return { rootDir: root, identity, lease, key, profile, active, retired, owner };
}

test('retires only the exact owned lock and read-back survives a fresh recovery call', async () => {
  const f = await fixture(); const result = await recoverProfile(f);
  expect(result).toMatchObject({ retired: true, profileRetained: true, owner: f.owner });
  await expect(fs.lstat(f.active)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(f.profile, 'saved-data'), 'utf8')).toBe('preserve exact profile bytes');
  expect(await recoverProfile(f)).toEqual(result); expect(syncDirectory).toHaveBeenCalled();
});

test('interruption after atomic rename can resume without deleting or repeating a rename', async () => {
  const f = await fixture(); syncDirectory.mockRejectedValueOnce(new Error('simulated interruption'));
  await expect(recoverProfile(f)).rejects.toMatchObject({ code: 'computer_profile_recovery_unknown' });
  expect((await fs.stat(f.retired)).isDirectory()).toBe(true);
  expect((await recoverProfile(f)).owner).toEqual(f.owner);
});

test('read-back cannot initiate retirement or create archive directories', async () => {
  const f = await fixture();
  await expect(inspectRecoveredProfile(f)).rejects.toMatchObject({ code: 'computer_profile_recovery_unknown' });
  await expect(fs.lstat(path.join(root, '.lilly-retired'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.stat(f.active)).isDirectory()).toBe(true);
  const expected = await recoverProfile(f);
  expect(await inspectRecoveredProfile(f)).toEqual(expected);
});

test('read-back settles an interrupted retirement without repeating the rename', async () => {
  const f = await fixture(); syncDirectory.mockRejectedValueOnce(new Error('interrupted after rename'));
  await expect(recoverProfile(f)).rejects.toMatchObject({ code: 'computer_profile_recovery_unknown' });
  const rename = jest.spyOn(fs, 'rename');
  try { expect((await inspectRecoveredProfile(f)).owner).toEqual(f.owner); expect(rename).not.toHaveBeenCalled(); }
  finally { rename.mockRestore(); }
});

test('a different mounted root cannot create directories or retire the owner', async () => {
  const f = await fixture();
  await expect(recoverProfile({ ...f, expectedRoot: { device: '1', inode: '999' } })).rejects.toMatchObject({ code: 'computer_profile_recovery_unknown' });
  await expect(fs.lstat(path.join(root, '.lilly-retired'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.stat(f.active)).isDirectory()).toBe(true);
});

test('graceful worker retirement is independently readable by the stopped-container recovery path', async () => {
  const f = await fixture();
  await retireProfileOwner(f.active, f.owner);
  const result = await recoverProfile(f);
  expect(result).toMatchObject({ retired: true, profileRetained: true, owner: f.owner });
  expect(await recoverProfile(f)).toEqual(result);
});

test('lost graceful retirement acknowledgment leaves a recoverable original marker', async () => {
  const f = await fixture(); const rename = fs.rename.bind(fs);
  const interrupted = jest.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
    await rename(source, target); throw new Error('simulated lost retirement acknowledgment');
  });
  try {
    await expect(retireProfileOwner(f.active, f.owner)).rejects.toMatchObject({ code: 'computer_profile_ownership_unknown' });
  } finally { interrupted.mockRestore(); }
  const result = await recoverProfile(f);
  expect(result).toMatchObject({ retired: true, profileRetained: true, owner: f.owner });
  expect(await fs.readFile(path.join(f.profile, 'saved-data'), 'utf8')).toBe('preserve exact profile bytes');
});

test.each(['no_stop', 'foreign_claim', 'foreign_agent', 'ready_phase', 'foreign_owner', 'unexpected_contents', 'both_paths', 'neither_path'])('rejects %s without deleting profile data', async mode => {
  const f = await fixture();
  if (mode === 'no_stop') delete f.lease.stopEvidence;
  if (mode === 'foreign_claim') f.identity.claim.claimId = randomUUID();
  if (mode === 'foreign_agent') f.identity.agentId = 'other';
  if (mode === 'ready_phase') f.lease.phase = 'ready';
  if (mode === 'foreign_owner') await fs.writeFile(path.join(f.active, 'owner.json'), JSON.stringify(profileOwner(randomUUID(), f.key)));
  if (mode === 'unexpected_contents') await fs.writeFile(path.join(f.active, 'unexpected'), 'keep');
  if (mode === 'both_paths') await fs.mkdir(f.retired, { recursive: true });
  if (mode === 'neither_path') await fs.rename(f.active, path.join(root, 'retained-elsewhere'));
  await expect(recoverProfile(f)).rejects.toMatchObject({ code: 'computer_profile_recovery_unknown' });
  expect(await fs.readFile(path.join(f.profile, 'saved-data'), 'utf8')).toBe('preserve exact profile bytes');
});

test('no kernel lock or an aborted invocation performs no retirement', async () => {
  const f = await fixture(); assertDirectoryLock.mockRejectedValueOnce(new Error('not locked'));
  await expect(recoverProfile(f)).rejects.toBeDefined();
  await expect(recoverProfile({ ...f, signal: AbortSignal.abort() })).rejects.toBeDefined();
  expect((await fs.stat(f.active)).isDirectory()).toBe(true);
});

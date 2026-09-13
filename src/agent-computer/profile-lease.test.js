'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { profileOwner, writeProfileOwner, readProfileOwner, removeProfileOwner, retireProfileOwner, retiredProfilePath } = require('./profile-lease');

let root; let lease; const key = 'a'.repeat(64);
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-profile-lease-')); lease = path.join(root, `${key}.lease`); await fs.mkdir(lease); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('persisted ownership and filesystem generations survive fresh read and only remove the lock', async () => {
  const owner = profileOwner(randomUUID(), key); const saved = await writeProfileOwner(lease, owner);
  expect(await readProfileOwner(lease)).toEqual(saved);
  const profile = path.join(root, key); await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'session-data'), 'preserve');
  await removeProfileOwner(lease, saved);
  await expect(fs.lstat(lease)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(profile, 'session-data'), 'utf8')).toBe('preserve');
});

test('legacy empty lock is unknown, never implicitly stale or removable', async () => {
  await expect(readProfileOwner(lease)).rejects.toMatchObject({ code: 'computer_profile_ownership_unknown' });
  expect((await fs.lstat(lease)).isDirectory()).toBe(true);
});

test.each(['lease', 'key', 'directory', 'marker'])('mismatched %s ownership receipt cannot remove the lock', async mode => {
  const saved = await writeProfileOwner(lease, profileOwner(randomUUID(), key));
  const wrong = structuredClone(saved);
  if (mode === 'lease') wrong.owner.leaseId = randomUUID();
  if (mode === 'key') wrong.owner.profileKey = 'b'.repeat(64);
  if (mode === 'directory') wrong.directory.inode = '0';
  if (mode === 'marker') wrong.marker.inode = '0';
  await expect(removeProfileOwner(lease, wrong)).rejects.toMatchObject({ code: 'computer_profile_ownership_unknown' });
  expect(await readProfileOwner(lease)).toEqual(saved);
});

test('replacement marker with identical content is a different ownership generation', async () => {
  const owner = profileOwner(randomUUID(), key); const saved = await writeProfileOwner(lease, owner);
  await fs.rename(path.join(lease, 'owner.json'), path.join(root, 'retained-marker'));
  await fs.writeFile(path.join(lease, 'owner.json'), JSON.stringify(owner));
  await expect(removeProfileOwner(lease, saved)).rejects.toMatchObject({ code: 'computer_profile_ownership_unknown' });
  expect((await fs.lstat(lease)).isDirectory()).toBe(true);
});

test('hard-linked markers and oversized records are not ownership evidence', async () => {
  await writeProfileOwner(lease, profileOwner(randomUUID(), key));
  const marker = path.join(lease, 'owner.json'); const link = path.join(root, 'second-link');
  await fs.link(marker, link);
  await expect(readProfileOwner(lease)).rejects.toMatchObject({ code: 'computer_profile_ownership_unknown' });
  await fs.unlink(link); await fs.writeFile(marker, 'x'.repeat(1025));
  await expect(readProfileOwner(lease)).rejects.toMatchObject({ code: 'computer_profile_ownership_unknown' });
});

test('unexpected lock contents are retained rather than recursively erased', async () => {
  const saved = await writeProfileOwner(lease, profileOwner(randomUUID(), key));
  await fs.writeFile(path.join(lease, 'unexpected'), 'keep');
  await expect(removeProfileOwner(lease, saved)).rejects.toBeDefined();
  expect(await readProfileOwner(lease)).toEqual(saved);
  expect(await fs.readFile(path.join(lease, 'unexpected'), 'utf8')).toBe('keep');
  expect((await fs.lstat(lease)).isDirectory()).toBe(true);
});

test('final retirement preserves marker generations and profile bytes for fresh recovery', async () => {
  const saved = await writeProfileOwner(lease, profileOwner(randomUUID(), key));
  const profile = path.join(root, key); await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'saved-data'), 'keep');
  const retired = await retireProfileOwner(lease, saved);
  expect(retired).toBe(retiredProfilePath(lease, saved.owner));
  expect(await readProfileOwner(retired)).toEqual(saved);
  await expect(fs.lstat(lease)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(profile, 'saved-data'), 'utf8')).toBe('keep');
});

test.each(['target', 'foreign_marker', 'extra_contents'])('retirement rejects %s and retains the original data', async mode => {
  const saved = await writeProfileOwner(lease, profileOwner(randomUUID(), key));
  const retired = retiredProfilePath(lease, saved.owner);
  if (mode === 'target') await fs.mkdir(retired, { recursive: true });
  if (mode === 'foreign_marker') {
    const marker = path.join(lease, 'owner.json'); const bytes = await fs.readFile(marker);
    await fs.rename(marker, path.join(root, 'old-marker')); await fs.writeFile(marker, bytes);
  }
  if (mode === 'extra_contents') await fs.writeFile(path.join(lease, 'unexpected'), 'keep');
  await expect(retireProfileOwner(lease, saved)).rejects.toMatchObject({ code: 'computer_profile_ownership_unknown' });
  expect((await fs.stat(lease)).isDirectory()).toBe(true);
  expect((await readProfileOwner(lease)).owner).toEqual(saved.owner);
});

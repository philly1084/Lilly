'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const fail = () => Object.assign(new Error('Private profile ownership is unconfirmed.'), { code: 'computer_profile_ownership_unknown' });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const same = (a, b) => a?.device === b?.device && a?.inode === b?.inode;
const generation = stat => ({ device: String(stat.dev), inode: String(stat.ino) });

function profileOwner(leaseId, profileKey) {
  if (!uuid(leaseId) || typeof profileKey !== 'string' || !/^[a-f0-9]{64}$/.test(profileKey)) throw fail();
  return { version: 1, leaseId, profileKey };
}

async function inspectDirectory(lease) {
  if (typeof lease !== 'string' || !path.isAbsolute(lease) || !/^[a-f0-9]{64}\.lease$/.test(path.basename(lease))
    || await fs.realpath(lease) !== lease) throw fail();
  const stat = await fs.lstat(lease, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  return generation(stat);
}

async function writeProfileOwner(lease, owner) {
  const validated = profileOwner(owner?.leaseId, owner?.profileKey);
  if (path.basename(lease) !== `${validated.profileKey}.lease`) throw fail();
  const directory = await inspectDirectory(lease);
  const handle = await fs.open(path.join(lease, 'owner.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(validated)); await handle.sync(); }
  finally { await handle.close(); }
  const receipt = await readProfileOwner(lease);
  if (!same(directory, receipt.directory) || JSON.stringify(receipt.owner) !== JSON.stringify(validated)) throw fail();
  return receipt;
}

async function readProfileOwner(lease) {
  let handle;
  try {
    const directory = await inspectDirectory(lease);
    const marker = path.join(lease, 'owner.json');
    const before = await fs.lstat(marker, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n) throw fail();
    handle = await fs.open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat({ bigint: true });
    if (!same(generation(before), generation(opened))) throw fail();
    const buffer = Buffer.alloc(1025); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) throw fail();
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    const owner = profileOwner(value?.leaseId, value?.profileKey);
    if (value.version !== 1 || Object.keys(value).length !== 3 || path.basename(lease) !== `${owner.profileKey}.lease`) throw fail();
    const after = await fs.lstat(marker, { bigint: true });
    if (!same(directory, await inspectDirectory(lease)) || !same(generation(before), generation(after))
      || after.isSymbolicLink() || after.nlink !== 1n || before.size !== after.size) throw fail();
    return { owner, directory, marker: generation(after) };
  } catch { throw fail(); }
  finally { await handle?.close(); }
}

// Only call after browser termination is independently confirmed. This helper
// checks filesystem ownership, not process death or permission to take over.
// Never removes a profile directory or recursively deletes unexpected contents.
async function removeProfileOwner(lease, expected) {
  const current = await verifyProfileOwner(lease, expected);
  await fs.unlink(path.join(lease, 'owner.json'));
  if (!same(await inspectDirectory(lease), current.directory)) throw fail();
  await fs.rmdir(lease);
}

async function verifyProfileOwner(lease, expected) {
  const current = await readProfileOwner(lease);
  if (!same(current.directory, expected?.directory) || !same(current.marker, expected?.marker)
    || JSON.stringify(current.owner) !== JSON.stringify(expected?.owner)) throw fail();
  const entries = await fs.readdir(lease);
  if (entries.length !== 1 || entries[0] !== 'owner.json') throw fail();
  return current;
}

function retiredProfilePath(lease, owner) {
  const validated = profileOwner(owner?.leaseId, owner?.profileKey);
  if (!path.isAbsolute(lease) || path.basename(lease) !== `${validated.profileKey}.lease`) throw fail();
  return path.join(path.dirname(lease), '.lilly-retired', validated.leaseId, path.basename(lease));
}

// The live worker owns admission to this lease. Call only once every context is
// confirmed closed and future admission is permanently fenced. Crash recovery
// separately requires a kernel lock and positive container-stop evidence.
async function retireProfileOwner(lease, expected) {
  try {
    const retired = retiredProfilePath(lease, expected?.owner);
    const root = path.dirname(lease);
    const archive = path.dirname(path.dirname(retired)); const parent = path.dirname(retired);
    const directories = [];
    for (const target of [root, archive, parent]) {
      if (target !== root) await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(target, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(target) !== target) throw fail();
      directories.push({ target, generation: generation(stat) });
    }
    // Any existing target is a conflict, including an empty directory. No
    // overwrite or replay: a post-rename failure belongs to crash recovery.
    try { await fs.lstat(retired); throw fail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await verifyProfileOwner(lease, expected);
    await fs.rename(lease, retired);
    for (const entry of directories.reverse()) {
      if (!same(entry.generation, generation(await fs.lstat(entry.target, { bigint: true })))
        || await fs.realpath(entry.target) !== entry.target) throw fail();
      // Windows unit fixtures cannot fsync directories. The supervised worker
      // entrypoint is Linux-only; its real proof exercises these syncs.
      if (process.platform === 'linux') {
        const handle = await fs.open(entry.target, constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    await verifyProfileOwner(retired, expected);
    try { await fs.lstat(lease); throw fail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return retired;
  } catch { throw fail(); }
}

module.exports = { profileOwner, writeProfileOwner, readProfileOwner, removeProfileOwner,
  verifyProfileOwner, retiredProfilePath, retireProfileOwner };

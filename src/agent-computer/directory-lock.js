'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const fail = () => Object.assign(new Error('Exclusive profile recovery lock is unconfirmed.'), { code: 'computer_recovery_lock_unknown' });
const generation = stat => ({ device: String(stat.dev), inode: String(stat.ino) });

function ownsDirectoryLock(text, stat, pid) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || !Number.isSafeInteger(pid) || pid < 1) return false;
  const dev = BigInt(stat.dev);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return text.split('\n').some(line => {
    // No blocked (->), shared, OFD or another process's lock is sufficient.
    const match = line.match(/^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+([1-9][0-9]*)\s+([a-f0-9]+):([a-f0-9]+):([0-9]+)\s+0\s+EOF\s*$/i);
    return match && Number(match[1]) === pid && BigInt(`0x${match[2]}`) === major
      && BigInt(`0x${match[3]}`) === minor && BigInt(match[4]) === stat.ino;
  });
}

async function assertDirectoryLock(root) {
  let handle;
  try {
    if (process.platform !== 'linux' || typeof root !== 'string' || !path.isAbsolute(root)
      || root === path.parse(root).root || await fs.realpath(root) !== root) throw fail();
    const before = await fs.lstat(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw fail();
    handle = await fs.open('/proc/locks', 'r');
    const buffer = Buffer.alloc(1024 * 1024 + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break; size += bytesRead;
    }
    if (!ownsDirectoryLock(buffer.subarray(0, size).toString('utf8'), before, process.pid)) throw fail();
    const after = await fs.lstat(root, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || await fs.realpath(root) !== root) throw fail();
    return generation(before);
  } catch { throw fail(); }
  finally { await handle?.close(); }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

module.exports = { ownsDirectoryLock, assertDirectoryLock, syncDirectory };

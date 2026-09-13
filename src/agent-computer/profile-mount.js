'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const { parseProcessStart, parseNamespace } = require('../agent-teams/execution-owner');
const fail = () => Object.assign(new Error('Private helper profile mount is unconfirmed.'), { code: 'computer_profile_mount_unknown' });
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const uint = value => value === '0' || decimal(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const generation = stat => ({ device: String(stat.dev), inode: String(stat.ino) });

async function readLimited(target, limit) {
  const handle = await fs.open(target, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > limit) throw fail();
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

const unescape = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
function profileMount(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) throw fail();
  let found;
  for (const line of text.trim().split('\n')) {
    const fields = line.split(' '); const target = unescape(fields[4] || '');
    if (target.startsWith('/profiles/')) throw fail(); // No hidden child mounts.
    if (target !== '/profiles') continue;
    const split = fields.indexOf('-'); const device = fields[2]?.split(':');
    if (found || split < 6 || fields.length !== split + 4 || !decimal(fields[0]) || !decimal(fields[1])
      || device?.length !== 2 || !device.every(uint) || device.some(value => BigInt(value) > 4294967295n)
      || !fields[5].split(',').includes('rw') || fields[5].split(',').includes('ro')
      || !fields[split + 3].split(',').includes('rw') || fields[split + 3].split(',').includes('ro')) throw fail();
    found = { id: fields[0], major: device[0], minor: device[1], root: unescape(fields[3]),
      options: fields[5], filesystem: fields[split + 1], source: unescape(fields[split + 2]), superOptions: fields[split + 3] };
  }
  if (!found) throw fail();
  return found;
}

function deviceMatches(device, mount) {
  const value = BigInt(device);
  const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n);
  const minor = (value & 0xffn) | ((value >> 12n) & 0xffffff00n);
  return String(major) === mount.major && String(minor) === mount.minor;
}

// Host observer only. Expected process identity must come from the exact helper
// Pod/CRI binding; expected root generation must come from verified PVC/PV data.
// This reads metadata through a checked /proc PID, never profile contents. It
// does not provision helpers, retire locks, or authorize task admission.
function createProfileMountReader({ read = readLimited, readlink = fs.readlink, open = fs.open, lstat = fs.lstat,
  hostname = os.hostname(), platform = process.platform } = {}) {
  return {
    async observeProfileMount(expected, { signal } = {}) {
      let handle;
      try {
        if (platform !== 'linux' || expected?.nodeName !== hostname
          || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expected.hostBootId || '')
          || !Number.isSafeInteger(expected.initPid) || expected.initPid < 2 || expected.initPid > 2147483647
          || !['initStartTicks', 'pidNamespace', 'mountNamespace'].every(key => decimal(expected[key]))
          || !uint(expected.root?.device) || !decimal(expected.root?.inode)) throw fail();
        const guard = () => { if (signal?.aborted) throw fail(); };
        const prefix = `/proc/${expected.initPid}`;
        const kernel = async () => {
          guard();
          const boot = (await read('/proc/sys/kernel/random/boot_id', 64)).trim(); guard();
          const stat = await read(`${prefix}/stat`, 16384); guard();
          const status = await read(`${prefix}/status`, 65536); guard();
          const pidNamespace = parseNamespace(await readlink(`${prefix}/ns/pid`), 'pid'); guard();
          const mountNamespace = parseNamespace(await readlink(`${prefix}/ns/mnt`), 'mnt'); guard();
          const values = key => status.match(new RegExp(`^${key}:\\s+([0-9 \\t]+)$`, 'm'))?.[1].trim().split(/\s+/);
          const pids = values('NSpid'); const uids = values('Uid'); const gids = values('Gid');
          if (boot !== expected.hostBootId || parseProcessStart(stat, expected.initPid) !== expected.initStartTicks
            || pidNamespace !== expected.pidNamespace || mountNamespace !== expected.mountNamespace
            || !pids || pids.length < 2 || pids[0] !== String(expected.initPid) || pids.at(-1) !== '1'
            || !uids || uids.length !== 4 || uids.some(id => id !== '10001')
            || !gids || gids.length !== 4 || gids.some(id => id !== '10001')
            || !/^NoNewPrivs:\s+1$/m.test(status) || !/^CapEff:\s+0{16}$/m.test(status)) throw fail();
        };
        await kernel();
        const first = profileMount(await read(`${prefix}/mountinfo`, 2 * 1024 * 1024)); guard();
        if (!deviceMatches(expected.root.device, first)) throw fail();
        // Only this intentional proc-root traversal reaches the bound process.
        // O_NOFOLLOW rejects a symlink at /profiles; O_DIRECTORY rejects files.
        handle = await open(`${prefix}/root/profiles`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); guard();
        const opened = await handle.stat({ bigint: true });
        if (!opened.isDirectory() || !same(generation(opened), expected.root) || !Number.isSafeInteger(handle.fd) || handle.fd < 0) throw fail();
        const fdinfo = await read(`/proc/self/fdinfo/${handle.fd}`, 4096); guard();
        const mounts = [...fdinfo.matchAll(/^mnt_id:\s+([0-9]+)$/gm)];
        const inodes = [...fdinfo.matchAll(/^ino:\s+([0-9]+)$/gm)];
        if (mounts.length !== 1 || mounts[0][1] !== first.id || inodes.length !== 1 || inodes[0][1] !== expected.root.inode) throw fail();
        const current = await lstat(`${prefix}/root/profiles`, { bigint: true }); guard();
        if (!current.isDirectory() || current.isSymbolicLink() || !same(generation(current), expected.root)) throw fail();
        const second = profileMount(await read(`${prefix}/mountinfo`, 2 * 1024 * 1024)); guard();
        if (!same(first, second)) throw fail();
        await kernel();
        return { version: 1, nodeName: expected.nodeName, hostBootId: expected.hostBootId, initPid: expected.initPid,
          initStartTicks: expected.initStartTicks, pidNamespace: expected.pidNamespace, mountNamespace: expected.mountNamespace,
          mountId: first.id, root: { device: expected.root.device, inode: expected.root.inode } };
      } catch { throw fail(); }
      finally { if (handle) { try { await handle.close(); } catch { throw fail(); } } }
    },
  };
}

module.exports = { createProfileMountReader, profileMount };

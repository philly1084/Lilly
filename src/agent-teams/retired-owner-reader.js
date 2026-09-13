'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { isDeepStrictEqual: same } = require('node:util');
const { normalizeCgroup } = require('./cgroup-reader');
const { parseProcessStart } = require('./execution-owner');
const fail = () => Object.assign(new Error('Retired kernel owner is unconfirmed.'), { code: 'team_retired_owner_unknown' });
const ROOT = '/sys/fs/cgroup';
const generation = value => ({ device: String(value.dev), inode: String(value.ino) });

async function readLimited(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > limit) throw fail(); return buffer.subarray(0, offset).toString('utf8');
  } finally { await handle.close(); }
}

// Host-only read observation. Never substitutes missing CRI metadata for death.
// The caller must independently observe the exact CRI container EXITED twice.
// A bound private PID namespace loses all its members when its original PID 1
// exits; this additionally verifies its recorded cgroup is absent, not unreadable
// or replaced. Cgroup/task garbage collection must not cause permanent deadlock.
function createRetiredOwnerReader({ read = readLimited, lstat = fs.lstat, realpath = fs.realpath, statfs = fs.statfs,
  readlink = fs.readlink, hostname = os.hostname(), platform = process.platform } = {}) {
  return {
    async readRetiredOwner(binding, { signal } = {}) {
      try {
        if (platform !== 'linux' || binding?.nodeName !== hostname || !Number.isSafeInteger(binding.initPid) || binding.initPid < 2
          || binding.initPid > 2147483647 || !/^[1-9][0-9]{0,19}$/.test(binding.initStartTicks || '')
          || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding.hostBootId || '')) throw fail();
        const cgroup = normalizeCgroup(binding.cgroup, binding.containerId, binding.podUid);
        const guard = () => { if (signal?.aborted) throw fail(); };
        const host = async () => {
          guard(); const boot = (await read('/proc/sys/kernel/random/boot_id', 64)).trim(); guard();
          const namespaces = await Promise.all(['/proc/self/ns/pid', '/proc/1/ns/pid', '/proc/self/ns/mnt', '/proc/1/ns/mnt'].map(file => readlink(file))); guard();
          if (boot !== binding.hostBootId || namespaces[0] !== namespaces[1] || namespaces[2] !== namespaces[3]
            || !/^pid:\[[1-9][0-9]*\]$/.test(namespaces[0]) || !/^mnt:\[[1-9][0-9]*\]$/.test(namespaces[2])) throw fail();
          return namespaces;
        };
        const originalInitGone = async () => {
          guard();
          try {
            const stat = await read(`/proc/${binding.initPid}/stat`, 16384); guard();
            if (parseProcessStart(stat, binding.initPid) === binding.initStartTicks) throw fail();
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        };
        const missingGroup = async () => {
          guard();
          if (await realpath(ROOT) !== ROOT || (await statfs(ROOT, { bigint: true })).type !== 0x63677270n) throw fail();
          let parent = ROOT; let current = await lstat(ROOT, { bigint: true }); guard();
          if (!current.isDirectory() || current.isSymbolicLink() || String(current.dev) !== cgroup.device) throw fail();
          for (const part of cgroup.path.slice(1).split('/')) {
            const target = `${parent}/${part}`;
            try {
              const next = await lstat(target, { bigint: true }); guard();
              if (!next.isDirectory() || next.isSymbolicLink() || String(next.dev) !== cgroup.device || await realpath(target) !== target) throw fail();
              parent = target; current = next;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              const after = await lstat(parent, { bigint: true }); guard();
              if (!same(generation(current), generation(after)) || await realpath(parent) !== parent) throw fail();
              return { missingFrom: target, parent: { path: parent, ...generation(after) } };
            }
          }
          throw fail(); // A present or replaced group is not a retired group.
        };
        const firstHost = await host(); await originalInitGone(); const first = await missingGroup();
        const secondHost = await host(); await originalInitGone(); const second = await missingGroup();
        if (!same(firstHost, secondHost) || !same(first, second)) throw fail(); guard();
        return { version: 1, retired: true, hostBootId: binding.hostBootId, initPid: binding.initPid,
          initStartTicks: binding.initStartTicks, cgroup };
      } catch { throw fail(); }
    },
  };
}

module.exports = { createRetiredOwnerReader };

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const fail = () => Object.assign(new Error('Container process-tree observation unavailable.'), { code: 'team_cgroup_unavailable' });
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const ROOT = '/sys/fs/cgroup';
const CGROUP2_MAGIC = 0x63677270n;

function containerPath(value, containerId, podUid) {
  if (typeof containerId !== 'string' || !/^containerd:\/\/[a-f0-9]{64}$/.test(containerId)
    || typeof podUid !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(podUid)
    || typeof value !== 'string' || value.length > 1024 || !/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(value)) throw fail();
  const parts = value.slice(1).split('/');
  const leaf = parts.at(-1); const id = containerId.slice(13);
  if (parts.some(part => part === '.' || part === '..') || !['kubepods', 'kubepods.slice'].includes(parts[0])
    || ![id, `cri-containerd-${id}.scope`].includes(leaf)
    || !parts.slice(1, -1).some(part => part === `pod${podUid}`
      || part.endsWith(`pod${podUid.replace(/-/g, '_')}.slice`))) throw fail();
  return value;
}

function normalizeCgroup(value, containerId, podUid) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !['path', 'device', 'inode'].every(key => Object.hasOwn(value, key))
    || !decimal(value.inode) || typeof value.device !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value.device)) throw fail();
  return { path: containerPath(value.path, containerId, podUid), device: value.device, inode: value.inode };
}

function unifiedPath(text) {
  if (typeof text !== 'string' || text.length > 4096) throw fail();
  const match = text.match(/^0::([^\r\n]+)\n?$/);
  if (!match) throw fail();
  return match[1];
}

function populated(text) {
  if (typeof text !== 'string' || text.length > 4096) throw fail();
  const lines = text.trim().split('\n');
  if (lines.some(line => !/^[a-z_]+ [0-9]+$/.test(line))) throw fail();
  const matches = lines.filter(line => line.startsWith('populated '));
  if (matches.length !== 1 || !/^populated [01]$/.test(matches[0])) throw fail();
  return matches[0] === 'populated 1';
}

// The kernel's populated bit covers the cgroup AND its descendants. Reading
// cgroup.procs alone would miss nested browser/sandbox processes. This reader
// never writes to cgroups, migrates processes, kills work or accepts arbitrary
// paths. Missing/deleted/unreadable groups remain unknown, not empty.
function createCgroupKernelReader({ readFile = fs.readFile, lstat = fs.lstat, statfs = fs.statfs, realpath = fs.realpath } = {}) {
  return async relative => {
    if (typeof relative !== 'string' || relative.length > 1024 || !/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(relative)
      || relative.split('/').some(part => part === '.' || part === '..')) throw fail();
    const directory = ROOT + relative;
    if (await realpath(ROOT) !== ROOT || await realpath(directory) !== directory) throw fail();
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || (await statfs(directory, { bigint: true })).type !== CGROUP2_MAGIC) throw fail();
    const events = `${directory}/cgroup.events`;
    const eventInfo = await lstat(events);
    if (!eventInfo.isFile() || eventInfo.isSymbolicLink()) throw fail();
    if ((await readFile(`${directory}/cgroup.type`, 'utf8')).trim() !== 'domain') throw fail();
    const active = populated(await readFile(events, 'utf8'));
    const after = await lstat(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw fail();
    return { identity: { path: relative, device: String(before.dev), inode: String(before.ino) }, populated: active };
  };
}

function createCgroupReader({ readFile = fs.readFile, lstat = fs.lstat, statfs = fs.statfs, realpath = fs.realpath,
  hostname = os.hostname(), platform = process.platform } = {}) {
  const node = value => { if (platform !== 'linux' || value !== hostname) throw fail(); };
  const sample = createCgroupKernelReader({ readFile, lstat, statfs, realpath });
  return {
    async observeCgroup({ nodeName, containerId, podUid, initPid, hostPid }) {
      try {
        node(nodeName);
        if (!validPid(initPid) || !validPid(hostPid)) throw fail();
        const membership = async pid => unifiedPath(await readFile(`/proc/${pid}/cgroup`, 'utf8'));
        const initPath = containerPath(await membership(initPid), containerId, podUid);
        const within = value => value === initPath || value.startsWith(`${initPath}/`);
        if (!within(await membership(hostPid))) throw fail();
        const result = await sample(initPath);
        if (await membership(initPid) !== initPath || !within(await membership(hostPid))) throw fail();
        normalizeCgroup(result.identity, containerId, podUid);
        return result;
      } catch { throw fail(); }
    },
    async readCgroup({ nodeName, containerId, podUid, cgroup }) {
      try {
        node(nodeName);
        const expected = normalizeCgroup(cgroup, containerId, podUid);
        const hostBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        const result = await sample(expected.path);
        if (result.identity.device !== expected.device || result.identity.inode !== expected.inode) throw fail();
        return { ...result, hostBootId };
      } catch { throw fail(); }
    },
  };
}

module.exports = { createCgroupReader, createCgroupKernelReader, normalizeCgroup, unifiedPath, populated };

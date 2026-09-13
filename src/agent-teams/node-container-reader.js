'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseProcessStart, parseNamespace } = require('./execution-owner');
const { createCgroupReader } = require('./cgroup-reader');
const { createProfileMountReader } = require('../agent-computer/profile-mount');
const { createRetiredOwnerReader } = require('./retired-owner-reader');
const run = promisify(execFile);
const fail = () => Object.assign(new Error('Node container observation unavailable.'), { code: 'team_node_observation_unavailable' });
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

// Host-side read-only adapter. Never load this through a model tool or grant a
// worker the runtime socket. Node-level access is a separate deployment boundary.
function createNodeContainerReader({ readFile = fs.readFile, readlink = fs.readlink, readdir = fs.readdir,
  execute = run, hostname = os.hostname(), platform = process.platform } = {}) {
  const checkNode = nodeName => { if (platform !== 'linux' || nodeName !== hostname) throw fail(); };
  const processIdentity = async hostPid => {
    if (!validPid(hostPid)) throw fail();
    const prefix = `/proc/${hostPid}`;
    const [stat, status, pidNamespace, mountNamespace] = await Promise.all([
      readFile(`${prefix}/stat`, 'utf8'), readFile(`${prefix}/status`, 'utf8'),
      readlink(`${prefix}/ns/pid`), readlink(`${prefix}/ns/mnt`),
    ]);
    if (typeof status !== 'string' || status.length > 65536) throw fail();
    const ids = status.match(/^NSpid:\s+([0-9 \t]+)$/m)?.[1].trim().split(/\s+/).map(Number);
    if (!ids?.length || ids[0] !== hostPid || !ids.every(validPid)) throw fail();
    const startTicks = parseProcessStart(stat, hostPid);
    if (parseProcessStart(await readFile(`${prefix}/stat`, 'utf8'), hostPid) !== startTicks) throw fail();
    return { pid: hostPid, namespacePid: ids.at(-1), startTicks,
      pidNamespace: parseNamespace(pidNamespace, 'pid'), mountNamespace: parseNamespace(mountNamespace, 'mnt') };
  };
  return {
    ...createCgroupReader({ hostname, platform }),
    ...createProfileMountReader({ hostname, platform }),
    ...createRetiredOwnerReader({ hostname, platform }),
    async inspectContainer(containerId, nodeName) {
      try {
        checkNode(nodeName);
        if (typeof containerId !== 'string' || !/^containerd:\/\/[a-f0-9]{64}$/.test(containerId)) throw fail();
        const { stdout } = await execute('/usr/local/bin/crictl', [
          '--runtime-endpoint=unix:///run/k3s/containerd/containerd.sock', '--timeout=5s', 'inspect', containerId.slice(13),
        ], { timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', shell: false });
        const value = JSON.parse(stdout);
        // crictl inspect may contain environment/credentials. Return only the
        // identity fields consumed by the binder, never raw output or stderr.
        const labels = {};
        for (const key of ['io.kubernetes.pod.uid', 'io.kubernetes.pod.namespace', 'io.kubernetes.pod.name', 'io.kubernetes.container.name']) {
          if (typeof value.status?.labels?.[key] === 'string') labels[key] = value.status.labels[key];
        }
        return { status: { id: value.status?.id, state: value.status?.state, labels }, info: { pid: value.info?.pid } };
      } catch { throw fail(); }
    },
    async observeProcess({ nodeName, initPid, ownerPid }) {
      try {
        checkNode(nodeName);
        if (!validPid(initPid) || !validPid(ownerPid)) throw fail();
        const hostBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        const init = await processIdentity(initPid);
        if (init.namespacePid !== 1) throw fail();
        if (ownerPid === 1) return { hostBootId, init, process: init };
        const entries = await readdir('/proc');
        if (entries.length > 32768) throw fail();
        let found;
        for (const entry of entries) {
          if (!/^[1-9][0-9]*$/.test(entry)) continue;
          const candidatePid = Number(entry);
          if (!validPid(candidatePid)) continue;
          try {
            // Avoid reading unrelated process status. Namespace membership is
            // the first filter; a vanished process is skipped, not declared dead.
            if (parseNamespace(await readlink(`/proc/${candidatePid}/ns/pid`), 'pid') !== init.pidNamespace) continue;
            const candidate = await processIdentity(candidatePid);
            if (candidate.namespacePid === ownerPid && candidate.pidNamespace === init.pidNamespace
              && candidate.mountNamespace === init.mountNamespace) {
              if (found) throw fail();
              found = candidate;
            }
          } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
        }
        if (!found) throw fail();
        const confirmedInit = await processIdentity(initPid);
        if (Object.keys(init).some(key => init[key] !== confirmedInit[key])) throw fail();
        return { hostBootId, init, process: found };
      } catch { throw fail(); }
    },
  };
}

module.exports = { createNodeContainerReader };

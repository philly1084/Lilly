'use strict';

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { normalizeCgroup } = require('./cgroup-reader');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DECIMAL = /^[1-9][0-9]{0,19}$/;
const name = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => Object.assign(new Error('Execution owner identity unavailable or invalid.'), { code: 'team_execution_owner_invalid' });

function normalizeExecutionOwner(value) {
  const keys = ['version', 'bootId', 'platform', 'pid', 'startedAt', 'kernel', 'pod', ...(value?.version === 2 ? ['containerBinding'] : [])];
  if (!exact(value, keys) || ![1, 2].includes(value.version) || typeof value.bootId !== 'string' || !UUID.test(value.bootId)
    || !['linux', 'win32', 'darwin'].includes(value.platform)
    || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2147483647
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
    || new Date(value.startedAt).toISOString() !== value.startedAt) throw fail();
  if (value.platform === 'linux') {
    const kernel = value.kernel;
    if (!exact(kernel, ['bootId', 'startTicks', 'pidNamespace', 'mountNamespace'])
      || typeof kernel.bootId !== 'string' || !UUID.test(kernel.bootId) || !['startTicks', 'pidNamespace', 'mountNamespace'].every(key => typeof kernel[key] === 'string' && DECIMAL.test(kernel[key]))) throw fail();
  } else if (value.kernel !== null) throw fail();
  if (value.pod !== null) {
    const pod = value.pod;
    if (!exact(pod, ['namespace', 'name', 'uid', 'containerName']) || pod.namespace !== 'kimibuilt'
      || !name(pod.name) || !name(pod.containerName) || typeof pod.uid !== 'string' || !UUID.test(pod.uid)) throw fail();
  }
  let containerBinding;
  if (value.version === 2) {
    const binding = value.containerBinding;
    const bindingKeys = ['version', 'containerId', 'nodeName', 'podUid', 'hostBootId', 'initPid', 'initStartTicks',
      'hostPid', 'processStartTicks', 'pidNamespace', 'mountNamespace', 'observedAt', ...(binding?.version === 2 ? ['cgroup'] : [])];
    if (value.platform !== 'linux' || !value.pod || !exact(binding, bindingKeys) || ![1, 2].includes(binding.version)
      || typeof binding.containerId !== 'string' || !/^containerd:\/\/[a-f0-9]{64}$/.test(binding.containerId)
      || typeof binding.nodeName !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(binding.nodeName)
      || binding.podUid !== value.pod.uid || binding.hostBootId !== value.kernel.bootId
      || !['initPid', 'hostPid'].every(key => Number.isSafeInteger(binding[key]) && binding[key] > 0 && binding[key] <= 2147483647)
      || !['initStartTicks', 'processStartTicks', 'pidNamespace', 'mountNamespace'].every(key => typeof binding[key] === 'string' && DECIMAL.test(binding[key]))
      || binding.processStartTicks !== value.kernel.startTicks || binding.pidNamespace !== value.kernel.pidNamespace
      || binding.mountNamespace !== value.kernel.mountNamespace || BigInt(binding.processStartTicks) < BigInt(binding.initStartTicks)
      || (value.pid === 1 && (binding.hostPid !== binding.initPid || binding.processStartTicks !== binding.initStartTicks))
      || (value.pid !== 1 && binding.hostPid === binding.initPid)
      || typeof binding.observedAt !== 'string' || !Number.isFinite(Date.parse(binding.observedAt))
      || new Date(binding.observedAt).toISOString() !== binding.observedAt || Date.parse(binding.observedAt) < Date.parse(value.startedAt)) throw fail();
    containerBinding = { ...binding };
    if (binding.version === 2) {
      try { containerBinding.cgroup = normalizeCgroup(binding.cgroup, binding.containerId, binding.podUid); }
      catch { throw fail(); }
    }
  }
  // Return an allowlisted copy. No environment, paths, arguments or credentials.
  return { version: value.version, bootId: value.bootId, platform: value.platform, pid: value.pid,
    startedAt: value.startedAt, kernel: value.kernel ? { ...value.kernel } : null, pod: value.pod ? { ...value.pod } : null,
    ...(containerBinding ? { containerBinding } : {}) };
}

function parseProcessStart(stat, pid) {
  if (typeof stat !== 'string' || stat.length > 16384 || !stat.startsWith(`${pid} (`)) throw fail();
  // comm can contain spaces and parentheses. Fields after its final ')' start
  // at field 3 (state); starttime is field 22, index 19 in this suffix.
  const closing = stat.lastIndexOf(')');
  if (closing < String(pid).length + 2 || stat[closing + 1] !== ' ') throw fail();
  const fields = stat.slice(closing + 1).trim().split(/\s+/);
  if (!/^[A-Za-z]$/.test(fields[0] || '') || !DECIMAL.test(fields[19] || '')) throw fail();
  return fields[19];
}

function parseNamespace(value, type) {
  if (typeof value !== 'string') throw fail();
  const match = value.match(new RegExp(`^${type}:\\[([1-9][0-9]{0,19})\\]$`));
  if (!match) throw fail();
  return match[1];
}

function createExecutionOwnerResolver({ environment = process.env, platform = process.platform, pid = process.pid,
  readFile = fs.readFile, readlink = fs.readlink, bootId = randomUUID(), now = () => new Date().toISOString(), bindContainer = null } = {}) {
  if (bindContainer !== null && typeof bindContainer !== 'function') throw fail();
  const base = { version: 1, bootId, platform, pid, startedAt: now(), kernel: null, pod: null };
  const podKeys = ['LILLY_TEAMS_BROKER_POD_NAMESPACE', 'LILLY_TEAMS_BROKER_POD_NAME', 'LILLY_TEAMS_BROKER_POD_UID'];
  if (environment.KUBERNETES_SERVICE_HOST || podKeys.some(key => environment[key] !== undefined)) {
    base.pod = { namespace: environment.LILLY_TEAMS_BROKER_POD_NAMESPACE, name: environment.LILLY_TEAMS_BROKER_POD_NAME,
      uid: environment.LILLY_TEAMS_BROKER_POD_UID, containerName: environment.LILLY_TEAMS_CONTAINER_NAME || 'backend' };
  }
  return async () => {
    try {
      const value = { ...base, pod: base.pod ? { ...base.pod } : null };
      if (platform === 'linux') {
        // These are local kernel observations, not container IDs inferred from
        // Pod status or cgroup strings. They remain private execution evidence.
        const [kernelBoot, stat, pidNamespace, mountNamespace] = await Promise.all([
          readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8'),
          readlink(`/proc/${pid}/ns/pid`), readlink(`/proc/${pid}/ns/mnt`),
        ]);
        value.kernel = { bootId: kernelBoot.trim(), startTicks: parseProcessStart(stat, pid),
          pidNamespace: parseNamespace(pidNamespace, 'pid'), mountNamespace: parseNamespace(mountNamespace, 'mnt') };
      }
      const owner = normalizeExecutionOwner(value);
      if (!bindContainer) return owner;
      if (owner.platform !== 'linux' || !owner.pod) throw fail();
      // The binding comes from a trusted node-side observer, not Pod status or
      // environment text. Once requested, a failed binding cannot downgrade to
      // legacy ownership. Keep it in the same claim transaction as the owner.
      const binding = await bindContainer(structuredClone(owner));
      return normalizeExecutionOwner({ ...owner, version: 2, containerBinding: binding });
    } catch { throw fail(); }
  };
}

module.exports = { createExecutionOwnerResolver, normalizeExecutionOwner, parseProcessStart, parseNamespace };

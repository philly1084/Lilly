'use strict';

const fs = require('node:fs');
const path = require('node:path').posix;
const { isIPv4 } = require('node:net');
const { checkServerIdentity } = require('node:tls');
const { exact, nodeName, fingerprint } = require('./node-rpc-contract');
const { backendPodNames } = require('../agent-teams/node-owner-adapter');
const fail = () => new Error('Private node service configuration is unavailable.');
const absolute = value => typeof value === 'string' && value.length < 4096 && value !== '/' && path.isAbsolute(value) && path.resolve(value) === value;
const privateIPv4 = value => isIPv4(value) && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);

// Native Linux root-service files only. Backend projected Secret reading uses
// the separate configured-factory loader; do not weaken these host-file rules.
function readPrivateFile(target) {
  if (process.platform !== 'linux' || !absolute(target)) throw fail();
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 65536) throw fail();
    const data = Buffer.alloc(65537); let bytes = 0;
    while (bytes < data.length) { const count = fs.readSync(fd, data, bytes, data.length - bytes, null); if (!count) break; bytes += count; }
    if (bytes > 65536) throw fail(); return data.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}

function loadNodeServiceConfig(target, { read = readPrivateFile } = {}) {
  try {
    const file = name => {
      if (!absolute(name)) throw fail(); const value = read(name);
      if ((!Buffer.isBuffer(value) && typeof value !== 'string') || !value.length || Buffer.byteLength(value) > 65536) throw fail();
      return value;
    };
    const value = JSON.parse(file(target).toString());
    if (!exact(value, ['version', 'nodeName', 'listen', 'tlsFiles', 'clientFingerprints', 'database', 'kubernetes', 'recovery',
      ...(Object.hasOwn(value, 'backendPodNames') ? ['backendPodNames'] : [])])
      || value.version !== 1 || !nodeName(value.nodeName)
      || !exact(value.listen, ['host', 'port']) || !privateIPv4(value.listen.host)
      || !Number.isSafeInteger(value.listen.port) || value.listen.port < 1024 || value.listen.port > 65535
      || !exact(value.tlsFiles, ['key', 'cert', 'ca'])
      || !Array.isArray(value.clientFingerprints) || !value.clientFingerprints.length || value.clientFingerprints.length > 8
      || !exact(value.database, ['host', 'port', 'database', 'user', 'passwordFile', 'caFile'])
      || !exact(value.kubernetes, ['server', 'tokenPath', 'caPath'])
      || !exact(value.recovery, ['image', 'storageRoot'])
      || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(value.recovery.image || '') || !absolute(value.recovery.storageRoot)) throw fail();
    const pods = backendPodNames(value.backendPodNames === undefined ? [] : value.backendPodNames);
    const db = value.database; const socket = absolute(db.host);
    if ((!socket && !nodeName(db.host)) || !Number.isSafeInteger(db.port) || db.port < 1 || db.port > 65535
      || !/^[a-zA-Z0-9_]{1,63}$/.test(db.database || '') || !/^lilly_node_[a-z0-9_]{1,48}$/.test(db.user || '')
      || (socket ? db.caFile !== null : !absolute(db.caFile))) throw fail();
    const origin = new URL(value.kubernetes.server);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash
      || !absolute(value.kubernetes.tokenPath) || !absolute(value.kubernetes.caPath)) throw fail();
    // Read credentials now to reject unavailable mounts before database access.
    file(value.kubernetes.tokenPath); file(value.kubernetes.caPath);
    const password = file(db.passwordFile).toString().trimEnd(); if (!password || password.includes('\0')) throw fail();
    return { nodeName: value.nodeName, listen: { ...value.listen },
      tls: Object.fromEntries(['key', 'cert', 'ca'].map(key => [key, file(value.tlsFiles[key])])),
      clientFingerprints: value.clientFingerprints.map(fingerprint),
      database: { host: db.host, port: db.port, database: db.database, user: db.user, password,
        ssl: socket ? false : { ca: file(db.caFile), rejectUnauthorized: true,
          checkServerIdentity: (_hostname, cert) => checkServerIdentity(db.host, cert) },
        max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 15000,
        options: '-c search_path=public -c lock_timeout=5000 -c idle_in_transaction_session_timeout=10000', application_name: 'lilly-node-service' },
      backendPodNames: pods,
      kubernetes: { ...value.kubernetes, allowProfileVolumeRead: true, backendPodNames: [...pods] }, recovery: { ...value.recovery } };
  } catch { throw fail(); }
}

module.exports = { loadNodeServiceConfig, readPrivateFile, privateIPv4 };

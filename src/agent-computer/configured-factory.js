'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createNodeRpcClient } = require('./node-rpc-client');
const { createKubernetesComputerRuntime } = require('./kubernetes-supervisor');
const { exact, nodeName } = require('./node-rpc-contract');
const fail = () => new Error('Configured private browser transport is unavailable.');

function readLimited(target) {
  const fd = fs.openSync(target, 'r');
  try {
    const data = Buffer.alloc(65537); let bytes = 0;
    while (bytes < data.length) {
      const count = fs.readSync(fd, data, bytes, data.length - bytes, null); if (!count) break; bytes += count;
    }
    if (bytes > 65536) throw fail(); return data.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}

// Deployment-only configuration. Files are mounted in the BACKEND, never in
// model/browser workers. No inline secrets, public routes, or permissive fallback.
function configuredNodeOperations({ environment = process.env, read = readLimited } = {}) {
  try {
    const source = environment.LILLY_TEAMS_NODE_RPC_CONFIG;
    const file = target => {
      if (typeof target !== 'string' || !path.isAbsolute(target) || target.length > 4096) throw fail();
      const value = read(target);
      if ((!Buffer.isBuffer(value) && typeof value !== 'string') || !value.length || Buffer.byteLength(value) > 65536) throw fail();
      return value;
    };
    const config = JSON.parse(file(source).toString());
    if (!exact(config, ['version', 'nodes', 'tlsFiles']) || config.version !== 1 || !exact(config.tlsFiles, ['key', 'cert', 'ca'])) throw fail();
    const tls = Object.fromEntries(['key', 'cert', 'ca'].map(key => [key, file(config.tlsFiles[key])]));
    return { nodes: config.nodes, operations: createNodeRpcClient({ nodes: config.nodes, tls }) };
  } catch { throw fail(); }
}

function createConfiguredComputerFactory(options = {}) {
  const { operations } = configuredNodeOperations(options);
  const environment = options.environment || process.env;
  const configuration = { namespace: 'lilly-team-workers', image: environment.LILLY_TEAMS_BROWSER_IMAGE,
    seccompProfile: environment.LILLY_TEAMS_BROWSER_SECCOMP_PROFILE };
  return ({ service, authorize }) => createKubernetesComputerRuntime({ service, authorize, configuration,
    ...Object.fromEntries(['bindContainer', 'requestStop', 'captureStop', 'observeTermination'].map(key => [key, operations[key]])) });
}

function createConfiguredOwnerBinder(options = {}) {
  const environment = options.environment || process.env;
  const node = environment.LILLY_TEAMS_BROKER_NODE_NAME;
  if (!nodeName(node)) throw fail();
  const { operations, nodes } = configuredNodeOperations(options);
  if (!nodes.some(entry => entry.name === node) || typeof operations.bindExecutionOwner !== 'function') throw fail();
  return owner => operations.bindExecutionOwner({ owner, nodeName: node });
}

module.exports = { createConfiguredComputerFactory, createConfiguredOwnerBinder };

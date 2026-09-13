'use strict';

const { createNodeContainerReader } = require('../agent-teams/node-container-reader');
const { createProfileRecoveryController } = require('./recovery-controller');
const { createRecoveryNodeAdapter } = require('./recovery-node-adapter');
const { createRecoverySupervisor } = require('./recovery-supervisor');
const { bindRecoveryHelperContainer } = require('./recovery-helper-observer');
const { createBrowserNodeAdapter } = require('./browser-node-adapter');
const fail = () => new Error('Trusted node recovery runtime configuration is required.');

function nodeReads(cluster) {
  const read = (kind, namespaced) => async ({ namespace, name, signal } = {}) => {
    if (signal?.aborted || (namespaced && namespace !== 'lilly-team-workers')
      || typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,251}[a-z0-9])?$/.test(name)) throw fail();
    const prefix = namespaced ? '/api/v1/namespaces/lilly-team-workers' : '/api/v1';
    return cluster.request('GET', `${prefix}/${kind}/${name}`, undefined, { signal });
  };
  return { readPod: read('pods', true), readPVC: read('persistentvolumeclaims', true), readPV: read('persistentvolumes', false) };
}

// Single composition root for the trusted node service. It must receive private
// TeamService access and a reviewed Kubernetes client; it cannot be constructed
// from worker/model input. Construction never activates a helper or a model.
// Deployment must provide authentication and node routing around this interface.
function createNodeRecoveryRuntime({ service, cluster, configuration, reader = createNodeContainerReader(),
  volumeReader, storageRoot, nodeOptions = {}, now = () => new Date().toISOString() } = {}) {
  if (typeof cluster?.request !== 'function' || typeof cluster?.exec !== 'function'
    || configuration?.namespace !== 'lilly-team-workers') throw fail();
  const { readPod, readPVC, readPV } = nodeReads(cluster);
  const controller = createProfileRecoveryController({ service, cluster, reader, readPod, readPVC, readPV, volumeReader, storageRoot, now });
  const adapter = createRecoveryNodeAdapter({ ...nodeOptions, service, reader, readPod, now });
  return createRecoverySupervisor({ service, cluster, configuration, controller, ...adapter,
    bindContainer: ({ lease, signal }) => bindRecoveryHelperContainer({ lease, signal, reader, readPod, now }) });
}

// The four private callbacks required by createKubernetesComputerRuntime. They
// share one reader and recovery runtime, and still perform no work on creation.
// Node RPC/authentication must wrap these; never load them in a model worker.
function createNodeComputerOperations(options = {}) {
  const reader = options.reader || createNodeContainerReader();
  const recovery = createNodeRecoveryRuntime({ ...options, reader });
  return createBrowserNodeAdapter({ ...options.nodeOptions, service: options.service, reader, recovery,
    readPod: nodeReads(options.cluster).readPod, now: options.now });
}

module.exports = { createNodeRecoveryRuntime, createNodeComputerOperations };

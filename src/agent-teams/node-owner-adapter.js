'use strict';

const { normalizeExecutionOwner } = require('./execution-owner');
const { bindExecutionContainer } = require('./container-binding');
const { createNodeContainerReader } = require('./node-container-reader');
const fail = () => Object.assign(new Error('Backend execution binding is unavailable.'), { code: 'team_owner_binding_unavailable' });

function backendPodNames(value) {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length
    || value.some(name => typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))) throw fail();
  return [...value];
}

// Trusted host only. Explicit Pod names are deployment policy, never selected
// by a model or inferred from a browser lease. All operations here are reads.
function createNodeOwnerBinder({ nodeName, podNames, cluster, reader = createNodeContainerReader() } = {}) {
  const allowed = new Set(backendPodNames(podNames));
  if (typeof nodeName !== 'string' || !nodeName || typeof cluster?.request !== 'function'
    || !['inspectContainer', 'observeProcess', 'observeCgroup'].every(key => typeof reader[key] === 'function')) throw fail();
  return async ({ owner: input, signal } = {}) => {
    try {
      const guard = () => { if (signal?.aborted) throw fail(); };
      guard();
      const owner = normalizeExecutionOwner(input);
      if (owner.version !== 1 || owner.platform !== 'linux' || owner.pod?.namespace !== 'kimibuilt'
        || owner.pod.containerName !== 'backend' || !allowed.has(owner.pod.name)) throw fail();
      const read = fn => async (...args) => { guard(); const result = await fn(...args); guard(); return result; };
      return await bindExecutionContainer({ owner,
        readPod: read(async () => {
          const pod = await cluster.request('GET', `/api/v1/namespaces/kimibuilt/pods/${owner.pod.name}`, undefined, { signal });
          if (pod?.spec?.nodeName !== nodeName) throw fail();
          return pod;
        }),
        inspectContainer: read((id, node) => { if (node !== nodeName) throw fail(); return reader.inspectContainer(id, node); }),
        observeProcess: read(scope => reader.observeProcess(scope)),
        observeCgroup: read(scope => reader.observeCgroup(scope)),
      });
    } catch { throw fail(); }
  };
}

module.exports = { backendPodNames, createNodeOwnerBinder };

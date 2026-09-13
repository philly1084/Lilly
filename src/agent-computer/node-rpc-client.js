'use strict';

const https = require('node:https');
const tlsModule = require('node:tls');
const { randomUUID } = require('node:crypto');
const contract = require('./node-rpc-contract');

// Reviewed node-name routing only. No dynamic URL, credentials, shell, Pod or
// lease fields cross the wire. Requests are never automatically retried.
function createNodeRpcClient({ nodes, tls, timeoutMs = 60000 } = {}) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 32 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw contract.fail();
  const material = contract.tlsMaterial(tls); const routes = new Map();
  try { tlsModule.createSecureContext(material); } catch { throw contract.fail(); }
  for (const node of nodes) {
    const endpoint = new URL(node.url);
    if (!contract.nodeName(node.name) || routes.has(node.name) || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw contract.fail();
    routes.set(node.name, { endpoint, pin: contract.fingerprint(node.fingerprint) });
  }
  const call = (method, input = {}) => new Promise((resolve, reject) => {
    let request; let timer; let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); input.signal?.removeEventListener('abort', cancel);
      if (error) { request?.destroy(); reject(contract.fail()); } else resolve(value);
    };
    const cancel = () => finish(true);
    try {
      if (input.signal?.aborted) throw contract.fail();
      const bindingOwner = method === contract.OWNER_METHOD;
      const lease = JSON.parse(JSON.stringify(bindingOwner ? input.owner : input.lease));
      const nodeName = input.nodeName || lease.nodeBinding?.nodeName;
      if (lease.nodeBinding && lease.nodeBinding.nodeName !== nodeName) throw contract.fail();
      const route = routes.get(nodeName); if (!route) throw contract.fail();
      const identity = Object.fromEntries(['ownerId', 'teamId', 'agentId', 'taskId', 'claim'].map(key => [key, input.identity?.[key]]));
      const envelope = contract.request({ version: 1, id: randomUUID(), method, nodeName,
        ...(bindingOwner ? { owner: lease } : { identity, leaseId: lease.leaseId }) });
      const body = JSON.stringify(envelope); if (Buffer.byteLength(body) > 8192) throw contract.fail();
      request = https.request(new URL(contract.PATH, route.endpoint), { ...material, agent: false, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'connection': 'close' },
        checkServerIdentity: (host, cert) => {
          const error = tlsModule.checkServerIdentity(host, cert); if (error) return error;
          try { if (contract.fingerprint(cert.fingerprint256) !== route.pin) return contract.fail(); } catch { return contract.fail(); }
        },
      }, response => {
        if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/json' || response.headers['content-encoding']) {
          response.resume(); return finish(true);
        }
        let bytes = 0; const chunks = [];
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) finish(true); else if (!done) chunks.push(chunk); });
        response.on('error', cancel); response.on('aborted', cancel);
        response.on('end', () => {
          if (done) return;
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const identityKey = bindingOwner ? 'ownerBootId' : 'leaseId';
            if (!contract.exact(value, ['version', 'id', identityKey, 'nodeName', 'result']) || value.version !== 1
              || value.id !== envelope.id || value[identityKey] !== (bindingOwner ? lease.bootId : envelope.leaseId) || value.nodeName !== nodeName) throw contract.fail();
            const result = contract.result(method, value.result, lease);
            if ((bindingOwner || method === 'bindContainer') && result.nodeName !== nodeName) throw contract.fail();
            finish(false, result);
          } catch { finish(true); }
        });
      });
      request.on('error', cancel); timer = setTimeout(cancel, timeoutMs);
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted) return cancel();
      request.end(body);
    } catch { finish(true); }
  });
  return Object.fromEntries([...contract.METHODS, contract.OWNER_METHOD].map(method => [method, input => call(method, input)]));
}

module.exports = { createNodeRpcClient };

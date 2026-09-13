'use strict';

const https = require('node:https');
const { isDeepStrictEqual: same } = require('node:util');
const { browserFingerprint } = require('./stop-evidence');
const { isRecoveryHelperClosed } = require('./recovery-helper');
const contract = require('./node-rpc-contract');

// Private mutual-TLS transport. Construction does not listen, activate workers,
// or access the database. Deployment owns certificates, private bind/firewall,
// and node-local operations. Never register this on Lilly's public Express app.
function createNodeRpcServer({ service, operations, nodeName, tls, clientFingerprints, timeoutMs = 60000, maxConcurrent = 16 } = {}) {
  if (typeof service?.get !== 'function' || !contract.METHODS.every(key => typeof operations?.[key] === 'function')
    || !contract.nodeName(nodeName) || !Array.isArray(clientFingerprints) || !clientFingerprints.length || clientFingerprints.length > 8
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) throw contract.fail();
  const pins = new Set(clientFingerprints.map(contract.fingerprint));
  const seen = new Map(); const pending = new Set(); const controllers = new Set();
  let active = 0; let stopping = false; let shutdown;
  const owned = async envelope => {
    const identity = envelope.identity; const team = await service.get(identity.teamId, identity.ownerId);
    const task = team.tasks?.find(value => value.id === identity.taskId && value.agentId === identity.agentId);
    const lease = task?.computerLease;
    if (team.id !== identity.teamId || team.ownerId !== identity.ownerId || !lease || lease.leaseId !== envelope.leaseId
      || task.worker?.id !== identity.claim.workerId || task.worker.claimId !== identity.claim.claimId
      || lease.claimId !== identity.claim.claimId || lease.ownerBootId !== task.worker.executionOwner?.bootId
      || lease.namespace !== 'lilly-team-workers' || envelope.nodeName !== nodeName
      || (lease.nodeBinding && lease.nodeBinding.nodeName !== nodeName)
      || !(envelope.method === 'bindContainer' ? ['provisioning', 'ready'] : ['closing', 'reconciliation']).includes(lease.phase)) throw contract.fail();
    return lease;
  };
  const server = https.createServer({ ...contract.tlsMaterial(tls), requestCert: true, handshakeTimeout: 5000, maxHeaderSize: 4096 }, (req, res) => {
    const reply = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      const data = JSON.stringify(value);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close', 'content-length': Buffer.byteLength(data) });
      res.end(data);
    };
    const reject = status => { reply(status, { error: 'node_operation_unconfirmed' }); req.resume(); };
    try {
      if (!req.socket.authorized || !pins.has(contract.fingerprint(req.socket.getPeerCertificate().fingerprint256))) return reject(403);
    } catch { return reject(403); }
    if (stopping) return reject(503);
    if (req.method !== 'POST' || req.url !== contract.PATH || req.headers['content-type'] !== 'application/json'
      || req.headers['content-encoding'] || req.headers.origin) return reject(400);
    if (active >= maxConcurrent) return reject(429);
    active += 1;
    const abort = new AbortController(); const signal = abort.signal;
    controllers.add(abort);
    const cancelled = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', cancelled);
    const timer = setTimeout(() => { abort.abort(); reject(504); }, timeoutMs);
    const guard = () => { if (signal.aborted) throw contract.fail(); };
    const body = () => new Promise((resolve, rejectBody) => {
      let bytes = 0; const chunks = []; let complete = false;
      const end = (error, value) => {
        if (complete) return; complete = true;
        req.removeListener('data', data); req.removeListener('end', done); req.removeListener('error', failed);
        req.removeListener('aborted', failed); signal.removeEventListener('abort', failed);
        if (error) rejectBody(contract.fail()); else resolve(value);
      };
      const failed = () => end(true);
      const data = chunk => { bytes += chunk.length; if (bytes > 8192) { reject(413); end(true); } else chunks.push(chunk); };
      const done = () => { try { end(false, contract.request(JSON.parse(Buffer.concat(chunks).toString('utf8')))); } catch { end(true); } };
      req.on('data', data); req.once('end', done); req.once('error', failed); req.once('aborted', failed); signal.addEventListener('abort', failed, { once: true });
      if (signal.aborted) failed();
    });
    const work = (async () => {
      const envelope = await body(); guard();
      const now = Date.now();
      for (const [id, until] of seen) if (until < now) seen.delete(id);
      if (seen.has(envelope.id)) { reject(409); return; }
      if (seen.size >= 4096) { reject(429); return; }
      seen.set(envelope.id, now + 600000);
      if (envelope.method === contract.OWNER_METHOD) {
        if (envelope.nodeName !== nodeName || typeof operations.bindExecutionOwner !== 'function') throw contract.fail();
        const raw = await operations.bindExecutionOwner({ owner: envelope.owner, signal }); guard();
        const result = contract.result(contract.OWNER_METHOD, raw, envelope.owner);
        if (result.nodeName !== nodeName) throw contract.fail();
        const response = { version: 1, id: envelope.id, ownerBootId: envelope.owner.bootId, nodeName, result };
        if (Buffer.byteLength(JSON.stringify(response)) > 16384) throw contract.fail();
        reply(200, response); return;
      }
      const before = await owned(envelope); guard();
      const raw = await operations[envelope.method]({ identity: envelope.identity, lease: before, signal }); guard();
      const lease = await owned(envelope); guard();
      if (before.nodeBinding && browserFingerprint(before) !== browserFingerprint(lease)) throw contract.fail();
      const result = contract.result(envelope.method, raw, lease);
      if (envelope.method === 'bindContainer' && result.nodeName !== nodeName) throw contract.fail();
      if (envelope.method === 'captureStop' && result && !same(result, contract.result('captureStop', lease.stopEvidence, lease))) throw contract.fail();
      if (envelope.method === 'observeTermination' && (!isRecoveryHelperClosed(lease)
        || !same(result.stopEvidence, contract.result('captureStop', lease.stopEvidence, lease))
        || !same(result.profileRecovery, lease.profileRecovery))) throw contract.fail();
      const response = { version: 1, id: envelope.id, leaseId: envelope.leaseId, nodeName, result };
      if (Buffer.byteLength(JSON.stringify(response)) > 16384) throw contract.fail();
      reply(200, response);
    })().catch(() => reject(503)).finally(() => {
      // A timed-out response does not release a slot while the actual operation
      // is still running. Its durable ownership is never cleared by this server.
      clearTimeout(timer); abort.abort(); res.removeListener('close', cancelled); active -= 1;
      controllers.delete(abort); pending.delete(work);
    });
    pending.add(work);
  });
  server.maxHeadersCount = 16; server.maxConnections = 64; server.headersTimeout = 5000;
  server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.shutdown = () => {
    if (shutdown) return shutdown;
    stopping = true;
    for (const controller of controllers) controller.abort();
    shutdown = (async () => {
      const closed = new Promise(resolve => { if (server.listening) server.close(resolve); else resolve(); });
      server.closeAllConnections();
      // The database owner must not close its pool merely because sockets ended.
      await Promise.allSettled([...pending]); await closed;
    })();
    return shutdown;
  };
  return server;
}

module.exports = { createNodeRpcServer };

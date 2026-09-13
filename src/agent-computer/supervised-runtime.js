'use strict';

const { identityKey, normalizeIdentity } = require('./runtime');
const fail = code => Object.assign(new Error(`Supervised computer: ${code}`), { code });

// Lazy, claim-scoped ownership over the deployment's lease factory. One agent
// cannot acquire a replacement until its old exact lease finishes cleanup.
function createSupervisedComputerRuntime({ createLease, authorize, maxComputers = 8 } = {}) {
  if (typeof createLease !== 'function' || typeof authorize !== 'function' || !Number.isSafeInteger(maxComputers)
    || maxComputers < 1 || maxComputers > 64) throw fail('computer_supervisor_configuration');
  const entries = new Map(); const proofs = new WeakSet(); let stopped = false; let disposal;
  const beforeDispatch = code => { const error = fail(code); proofs.add(error); return error; };
  function scopeOf(identity) {
    const bound = normalizeIdentity(identity); const claim = {};
    for (const key of ['taskId', 'workerId', 'claimId']) {
      if (typeof identity.claim?.[key] !== 'string' || !identity.claim[key] || identity.claim[key].length > 256) throw fail('computer_claim_required');
      claim[key] = identity.claim[key];
    }
    return { ...bound, claim };
  }
  const matches = (a, b) => ['taskId', 'workerId', 'claimId'].every(key => a.claim[key] === b.claim[key]);
  function closeEntry(entry) {
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      let lease;
      try { lease = await entry.acquiring; }
      catch (error) {
        // Cancellation before the factory was invoked has no resource owner to
        // reconcile. Once invoked, only that supervisor can settle acquisition.
        if (!entry.started) { if (entries.get(entry.key) === entry) entries.delete(entry.key); return; }
        throw error;
      }
      let error;
      try {
        const results = await lease.computer.dispose();
        if (!Array.isArray(results) || results.some(result => result.status !== 'fulfilled')) throw fail('computer_cleanup_unconfirmed');
      } catch (failure) { error = failure; }
      // A lost graceful RPC is not permanent ownership when the independent
      // supervisor can positively prove exact process/profile closure. Legacy
      // factories without this explicit read-back keep the conservative result.
      try {
        await lease.close();
        if (error && (typeof lease.confirmClosed !== 'function' || await lease.confirmClosed() !== true)) throw fail('computer_cleanup_unconfirmed');
      } catch { throw fail('computer_cleanup_unconfirmed'); }
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
    })();
    return entry.closing;
  }
  const runtime = {
    isPreDispatchFailure: error => proofs.has(error),
    async releaseClaim(identity) {
      const scope = scopeOf(identity); const entry = entries.get(identityKey(scope));
      if (!entry) return;
      if (!matches(entry.scope, scope)) throw fail('computer_claim_denied');
      return closeEntry(entry);
    },
    dispose() {
      if (disposal) return disposal;
      stopped = true;
      disposal = Promise.allSettled([...entries.values()].map(closeEntry));
      return disposal;
    },
  };
  for (const method of ['open', 'observe', 'act', 'getModelInput', 'tabs', 'close']) runtime[method] = async (identity, input = {}) => {
    if (stopped) throw beforeDispatch('computer_disposed');
    const scope = scopeOf(identity); const key = identityKey(scope);
    let entry = entries.get(key);
    if (entry && (!matches(entry.scope, scope) || entry.closing)) throw beforeDispatch('computer_claim_denied');
    if (!entry) {
      if (method !== 'open') throw beforeDispatch('computer_not_open');
      if (entries.size >= maxComputers) throw beforeDispatch('computer_capacity');
      entry = { key, scope }; entries.set(key, entry);
      entry.acquiring = Promise.resolve().then(async () => {
        if (stopped || entry.closing || input.signal?.aborted) throw fail('computer_disposed');
        // Provisioning itself is an effect. Check current authority before
        // allocating resources, then recheck lifetime after the asynchronous gate.
        const verdict = await authorize({ identity: scope, operation: 'open', url: input.url, signal: input.signal });
        if (stopped || entry.closing || input.signal?.aborted) throw fail('computer_disposed');
        if (verdict !== true && verdict?.allowed !== true) throw fail('computer_policy_denied');
        entry.started = true;
        const lease = await createLease({ ...scope, taskId: scope.claim.taskId, signal: input.signal,
          authorize: request => matches(scope, scopeOf(request.identity)) && identityKey(request.identity) === key && authorize(request) });
        if (!lease?.computer || typeof lease.close !== 'function') throw fail('computer_supervisor_configuration');
        return lease;
      });
    }
    let lease;
    try { lease = await entry.acquiring; }
    catch (error) {
      // Only this adapter knows whether the supervisor was entered. A factory
      // failure remains uncertain, even if it carries a familiar error code.
      if (!entry.started && error && typeof error === 'object') proofs.add(error);
      throw error;
    }
    if (stopped || entry.closing || input.signal?.aborted) throw beforeDispatch('computer_disposed');
    try { return await lease.computer[method](scope, input); }
    catch (error) { if (lease.computer.isPreDispatchFailure?.(error) === true) proofs.add(error); throw error; }
  };
  return runtime;
}

module.exports = { createSupervisedComputerRuntime };

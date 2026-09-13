'use strict';

// One instance per isolated run, shared by every worker and auxiliary request.
// Failed calls consume admission; no retry can evade the run-wide allowance.
function createSharedModelBudget({ maxCalls, maxTimeMs, now = Date.now, signal } = {}) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100
    || !Number.isInteger(maxTimeMs) || maxTimeMs < 1 || maxTimeMs > 300000) throw new Error('Invalid shared model budget');
  const controller = new AbortController();
  const deadline = now() + maxTimeMs;
  let calls = 0; let active = 0; let closed = false;
  const abort = () => controller.abort();
  const timer = setTimeout(abort, maxTimeMs); timer.unref?.();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const fail = () => Object.assign(new Error('Shared model budget unavailable'), { code: 'team_shared_model_budget' });
  return {
    async run(request) {
      if (typeof request !== 'function' || closed || controller.signal.aborted || now() >= deadline || calls >= maxCalls) throw fail();
      calls += 1; active += 1;
      let released = false;
      const release = () => { if (!released) { released = true; active -= 1; } };
      try {
        const result = await request(controller.signal);
        if (typeof result?.[Symbol.asyncIterator] !== 'function') { release(); return result; }
        const iterator = result[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]() { return this; },
          async next(...args) {
            try { const item = await iterator.next(...args); if (item.done) release(); return item; }
            catch (error) { release(); throw error; }
          },
          async return(value) {
            try { return iterator.return ? await iterator.return(value) : { done: true, value }; }
            finally { release(); }
          },
        };
      } catch (error) { release(); throw error; }
    },
    snapshot: () => ({ calls, active, maxCalls, expired: controller.signal.aborted || now() >= deadline, closed }),
    close() { closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); abort(); },
  };
}
module.exports = { createSharedModelBudget };

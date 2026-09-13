'use strict';
const { createSharedModelBudget } = require('./shared-model-budget');

// Explicit isolated-test composition; never selected by normal runtime startup.
function createLiveTestModelAdapter({ client, model, signal, maxCalls = 20, maxTimeMs = 300000 } = {}) {
  if (typeof client?.responses?.create !== 'function' || typeof model !== 'string' || !model.trim()
    || maxCalls > 20 || maxTimeMs > 300000) throw new Error('Invalid live test model adapter');
  const budget = createSharedModelBudget({ maxCalls, maxTimeMs, signal });
  return {
    modelRequest(body, options = {}) {
      return budget.run(runSignal => client.responses.create({ ...body, model, store: false, max_output_tokens: 2048 }, {
        signal: options.signal ? AbortSignal.any([runSignal, options.signal]) : runSignal, maxRetries: 0,
      }));
    },
    snapshot: budget.snapshot,
    close: budget.close,
  };
}
module.exports = { createLiveTestModelAdapter };

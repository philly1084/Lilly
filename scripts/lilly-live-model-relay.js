'use strict';
// Executed inside the existing backend, not inside agent containers. No keys
// cross stdout. Buffered SSE preserves actual provider events without inference fixtures.
const assert = require('node:assert/strict');
const readline = require('node:readline');
assert.equal(process.env.LILLY_TEAMS_ENABLED, 'false');
const config = require('/app/src/config');
const selectedModel = process.argv[1] || config.openai.model;
assert(!process.argv[1] || ['gpt-6-astra', 'deepseek-v4-flash', 'deepseek-v4-pro'].includes(selectedModel));
const OpenAI = require('/app/node_modules/openai');
const client = new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL, maxRetries: 0, timeout: 60000 });
const controller = new AbortController(); let calls = 0;
const requests = new Map();
const timer = setTimeout(() => { controller.abort(); process.exitCode = 1; process.stdin.destroy(); }, 300000);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
send({ ready: true, model: selectedModel });
const lines = readline.createInterface({ input: process.stdin });
lines.on('close', () => { clearTimeout(timer); controller.abort(); });
lines.on('line', async line => {
  let id; let requestController;
  try {
    assert(Buffer.byteLength(line) <= 12 * 1024 * 1024);
    const request = JSON.parse(line); id = request.id;
    if (request.cancel === true) {
      assert(Number.isSafeInteger(id) && id > 0);
      requests.get(id)?.abort();
      return;
    }
    assert(Number.isSafeInteger(id) && id > 0 && calls < 20 && !controller.signal.aborted);
    assert(!requests.has(id));
    calls += 1;
    requestController = new AbortController(); requests.set(id, requestController);
    const body = { ...request.body, model: selectedModel, store: false, max_output_tokens: 2048,
      ...(selectedModel === 'gpt-6-astra' ? { reasoning: { effort: 'low' } } : {}) };
    const result = await client.responses.create(body, { signal: AbortSignal.any([controller.signal, requestController.signal]), maxRetries: 0 });
    if (body.stream) {
      const events = []; let bytes = 0;
      for await (const event of result) {
        bytes += Buffer.byteLength(JSON.stringify(event)); assert(bytes <= 8 * 1024 * 1024); events.push(event);
      }
      send({ id, events });
    } else send({ id, result });
  } catch (error) {
    send({ id, error: requests.get(id)?.signal.aborted ? 'live_model_request_cancelled' : 'live_provider_request_failed', status: Number.isInteger(error.status) ? error.status : null });
  } finally {
    // A cancel message does not own the in-flight request's lifecycle.
    if (requestController && requests.get(id) === requestController) requests.delete(id);
  }
});

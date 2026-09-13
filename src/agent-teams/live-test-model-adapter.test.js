'use strict';
const { createLiveTestModelAdapter } = require('./live-test-model-adapter');
test('pins approved model and strips retry/storage overrides for all workers', async () => {
  const create = jest.fn(async () => ({ output: [] }));
  const adapter = createLiveTestModelAdapter({ client: { responses: { create } }, model: 'approved', maxCalls: 1 });
  try {
    await adapter.modelRequest({ model: 'other', store: true, max_output_tokens: 99999 }, { maxRetries: 9 });
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'approved', store: false, max_output_tokens: 2048 });
    expect(create.mock.calls[0][1].maxRetries).toBe(0);
    await expect(adapter.modelRequest({})).rejects.toMatchObject({ code: 'team_shared_model_budget' });
  } finally { adapter.close(); }
});
test('stream remains active until consumption settles and forwards events unchanged', async () => {
  const adapter = createLiveTestModelAdapter({ model: 'approved', client: { responses: { create: async () => (async function* () {
    yield { type: 'response.created' }; yield { type: 'response.completed' };
  })() } } });
  try {
    const stream = await adapter.modelRequest({ stream: true });
    expect(adapter.snapshot().active).toBe(1);
    const output = []; for await (const event of stream) output.push(event.type);
    expect(output).toEqual(['response.created', 'response.completed']);
    expect(adapter.snapshot().active).toBe(0);
  } finally { adapter.close(); }
});
test('early stream return releases admission, request cancellation reaches provider', async () => {
  let signal; const cancel = new AbortController();
  const adapter = createLiveTestModelAdapter({ model: 'approved', client: { responses: { create: async (_, options) => {
    signal = options.signal; return (async function* () { yield 1; yield 2; })();
  } } } });
  try {
    const stream = await adapter.modelRequest({ stream: true }, { signal: cancel.signal });
    await stream.next(); cancel.abort(); expect(signal.aborted).toBe(true);
    await stream.return(); expect(adapter.snapshot().active).toBe(0);
  } finally { adapter.close(); }
});

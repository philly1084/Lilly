'use strict';
const { normalizeResponseStream } = require('./response-stream');
const collect = async input => { const result = []; for await (const item of normalizeResponseStream(input)) result.push(item); return result; };
const chunk = output => ({ id: 'resp_test', object: 'response.chunk', created_at: 1, status: 'completed', model: 'configured', output });
test('reframes real tool IDs, names and arguments without changing their bytes', async () => {
  const item = { id: 'fc_a', type: 'function_call', call_id: 'call_a', name: 'use_tool', arguments: '{ "value": 2 }', status: 'completed' };
  const events = await collect([chunk([item])]);
  expect(events.map(e => e.type)).toEqual(['response.created', 'response.output_item.added', 'response.function_call_arguments.delta',
    'response.function_call_arguments.done', 'response.output_item.done', 'response.completed']);
  expect(events[2].delta).toBe(item.arguments); expect(events[4].item).toBe(item);
  expect(events.at(-1).response.output).toEqual([item]); expect(events.at(-1).response.usage).toBeNull();
  expect(events.map(e => e.sequence_number)).toEqual([0, 1, 2, 3, 4, 5]);
});
test('retains actual message content and emits content lifecycle', async () => {
  const item = { id: 'msg_a', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Actual answer', annotations: [] }] };
  const events = await collect([chunk([item])]);
  expect(events.find(e => e.type === 'response.output_text.delta').delta).toBe('Actual answer');
  expect(events.at(-1).response.output[0]).toEqual(item);
});

test.each([
  { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: {}, output_tokens_details: {} },
  { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: null }, output_tokens_details: { reasoning_tokens: 0 } },
])('omits incomplete optional usage instead of fabricating breakdowns', async usage => {
  const response = { ...chunk([]), usage };
  const events = await collect([{ type: 'response.completed', response }]);
  expect(events.every(event => event.response.usage === null)).toBe(true);
  expect(response.usage).toBe(usage);
});

test('preserves complete real usage statistics', async () => {
  const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12,
    input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } };
  const events = await collect([{ ...chunk([]), usage }]);
  expect(events.at(-1).response.usage).toEqual(usage);
});
test('supplies empty metadata missing from legacy text and reasoning items without inventing content', async () => {
  const events = await collect([chunk([{ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Actual' }] },
    { id: 'r', type: 'reasoning', text: 'Existing reasoning' }])]);
  expect(events.at(-1).response.output[0].content[0]).toEqual({ type: 'output_text', text: 'Actual', annotations: [] });
  expect(events.at(-1).response.output[1]).toEqual({ id: 'r', type: 'reasoning', text: 'Existing reasoning', summary: [] });
});
test('native failed events never become successful output', async () => {
  const event = { type: 'response.failed', response: { error: { code: 'failure' } } };
  await expect(collect([event])).rejects.toMatchObject({ code: 'grok_response_stream_invalid' });
});
test('reframes incomplete native event lifecycles from the authoritative completed response', async () => {
  const item = { id: 'fc_a', type: 'function_call', call_id: 'call_a', name: 'use_tool', arguments: '{}', status: 'completed' };
  const events = await collect([{ type: 'response.created' }, { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { ...chunk([item]), object: 'response' } }]);
  expect(events.map(event => event.type)).toEqual(['response.created', 'response.output_item.added',
    'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done', 'response.completed']);
  expect(events.at(-1).response.output).toEqual([item]);
});
test('native deltas without a terminal response cannot be accepted as completion', async () => {
  await expect(collect([{ type: 'response.output_text.delta', delta: 'I did it' }])).rejects.toMatchObject({ code: 'grok_response_stream_invalid' });
});
test('an empty upstream stream cannot be accepted as completion', async () => {
  await expect(collect([])).rejects.toMatchObject({ code: 'grok_response_stream_invalid' });
});
test.each([{ object: 'unknown' }, { ...chunk([]), status: 'incomplete' }, chunk([{ type: 'function_call' }])])('rejects malformed envelopes', async value => {
  await expect(collect([value])).rejects.toMatchObject({ code: 'grok_response_stream_invalid' });
});
test('rejects duplicate or mixed legacy envelopes', async () => {
  await expect(collect([chunk([]), chunk([])])).rejects.toMatchObject({ code: 'grok_response_stream_invalid' });
  await expect(collect([{ type: 'response.created' }, chunk([])])).rejects.toMatchObject({ code: 'grok_response_stream_invalid' });
});

test('a duplicate legacy envelope releases no tool call or completion before rejection', async () => {
  const emitted = [];
  const item = { id: 'fc_a', type: 'function_call', call_id: 'call_a', name: 'use_tool', arguments: '{}', status: 'completed' };
  await expect((async () => {
    for await (const event of normalizeResponseStream([chunk([item]), chunk([])])) emitted.push(event);
  })()).rejects.toMatchObject({ code: 'grok_response_stream_invalid' });
  expect(emitted).toEqual([]);
});

test('upstream failure after a legacy envelope cannot produce successful completion', async () => {
  const emitted = []; const failure = new Error('upstream interrupted');
  const upstream = (async function* () { yield chunk([]); throw failure; })();
  await expect((async () => { for await (const event of normalizeResponseStream(upstream)) emitted.push(event); })()).rejects.toBe(failure);
  expect(emitted).toEqual([]);
});

test('null message content fails closed with a bounded diagnostic', async () => {
  await expect(collect([chunk([{ id: 'm', type: 'message', content: [null] }])])).rejects.toMatchObject({ code: 'grok_response_stream_invalid' });
});

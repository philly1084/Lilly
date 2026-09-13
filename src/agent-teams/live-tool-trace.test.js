'use strict';
const { traceToolDispatch } = require('./live-tool-trace');
test('tracing preserves the exact call ID, abort signal, arguments and private result', async () => {
  const trace = []; const meta = { callId: 'call-a', signal: new AbortController().signal };
  const args = { url: 'http://127.0.0.1' }; const result = { privateModelContent: [{ type: 'input_image', image_url: 'private' }] };
  const dispatch = jest.fn(async () => result);
  expect(await traceToolDispatch(dispatch, { trace, agentId: 'writer', now: () => 1 })('computer_open', args, meta)).toBe(result);
  expect(dispatch.mock.calls[0][1]).toBe(args); expect(dispatch.mock.calls[0][2]).toBe(meta);
  expect(trace).toEqual([{ agentId: 'writer', name: 'computer_open', startedMs: 1, finishedMs: 1, ok: true }]);
  expect(JSON.stringify(trace)).not.toContain('private');
});

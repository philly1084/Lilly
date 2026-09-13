'use strict';

const { PassThrough } = require('node:stream');
const { createChannel } = require('./stdio-channel');
const tick = () => new Promise(resolve => setImmediate(resolve));
const pairs = [];
afterEach(() => pairs.splice(0).forEach(({ channels, streams }) => { channels.forEach(channel => channel.close()); streams.forEach(stream => stream.destroy()); }));
function pair(a = {}, b = {}) {
  const ab = new PassThrough(); const ba = new PassThrough();
  const left = createChannel({ input: ba, output: ab, ...a });
  const right = createChannel({ input: ab, output: ba, ...b });
  pairs.push({ channels: [left, right], streams: [ab, ba] });
  return { left, right, ab, ba };
}

test('bidirectional permission callbacks do not deadlock with an outstanding operation', async () => {
  let right;
  const channels = pair({ handlers: { authorize: async value => value.url === 'https://allowed.test/' } },
    { handlers: { open: async value => ({ allowed: await right.request('authorize', value) }) } });
  right = channels.right;
  expect(await channels.left.request('open', { url: 'https://allowed.test/' })).toEqual({ allowed: true });
});

test('completed request IDs cannot replay browser effects', async () => {
  const act = jest.fn(async () => ({ done: true })); const broken = jest.fn();
  const { left, ab } = pair({}, { handlers: { act }, onBroken: broken });
  await left.request('act', {});
  ab.write(JSON.stringify({ version: 1, kind: 'call', id: 1, method: 'act', value: {} }) + '\n');
  await tick(); expect(act).toHaveBeenCalledTimes(1); expect(broken).toHaveBeenCalledTimes(1);
});

test('timeout fences the channel instead of replaying an uncertain action', async () => {
  const act = jest.fn(() => new Promise(() => {})); const broken = jest.fn();
  const { left } = pair({ timeoutMs: 100, onBroken: broken }, { handlers: { act } });
  await expect(left.request('act', {})).rejects.toMatchObject({ code: 'computer_channel_timeout' });
  await expect(left.request('act', {})).rejects.toMatchObject({ code: 'computer_channel_closed' });
  expect(act).toHaveBeenCalledTimes(1); expect(broken).toHaveBeenCalledTimes(1);
});

test('abort rejects every pending request and only invokes supervision once', async () => {
  const broken = jest.fn(); const abort = new AbortController();
  const { left } = pair({ onBroken: broken }, { handlers: { act: () => new Promise(() => {}) } });
  const first = left.request('act', {}, { signal: abort.signal }).catch(error => error.code);
  const second = left.request('act', {}).catch(error => error.code);
  abort.abort(); expect(await first).toBe('computer_channel_aborted'); expect(await second).toBe('computer_channel_aborted');
  left.close(); expect(broken).toHaveBeenCalledTimes(1);
});

test('remote errors contain only fixed codes and runtime-proven pre-dispatch information', async () => {
  const known = Object.assign(new Error('PRIVATE_PAGE_COOKIE'), { code: 'computer_stale_frame' });
  const { left } = pair({}, { handlers: { act: async () => { throw known; } }, errorProof: error => error === known });
  const error = await left.request('act', {}).catch(error => error);
  expect(error.message).not.toContain('PRIVATE'); expect(error.cause).toBeUndefined();
  expect(left.isPreDispatchFailure(error)).toBe(true);
  expect(left.isPreDispatchFailure(Object.assign(new Error(), { code: error.code }))).toBe(false);
});

test('split UTF-8 payloads retain private model input without corrupting framing', async () => {
  const input = new PassThrough(); const output = new PassThrough(); const received = jest.fn(async value => value);
  const channel = createChannel({ input, output, handlers: { echo: received } });
  pairs.push({ channels: [channel], streams: [input, output] });
  const bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'call', id: 1, method: 'echo', value: 'é🦋' }) + '\n');
  for (const byte of bytes) input.write(Buffer.from([byte]));
  await tick(); expect(received).toHaveBeenCalledWith('é🦋', expect.any(AbortSignal));
});

test.each(['malformed', 'method', 'size', 'response'])('bad %s frames close the transport without dispatch', async kind => {
  const broken = jest.fn(); const act = jest.fn();
  const { right, ab } = pair({}, { handlers: { act }, maxBytes: 1024, onBroken: broken });
  const data = kind === 'malformed' ? '{invalid}\n' : kind === 'size' ? 'x'.repeat(1025)
    : JSON.stringify({ version: 1, id: 1, kind: kind === 'response' ? 'result' : 'call', method: 'constructor', value: {} }) + '\n';
  ab.write(data); await tick();
  expect(right.closed).toBe(true); expect(broken).toHaveBeenCalledTimes(1); expect(act).not.toHaveBeenCalled();
});

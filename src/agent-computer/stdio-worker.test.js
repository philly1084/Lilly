'use strict';

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { bindShutdown } = require('./stdio-worker');

function fixture(close) {
  const input = new PassThrough(); const output = new PassThrough(); const host = new EventEmitter();
  const endpoint = { close: jest.fn(close) };
  return { input, output, host, endpoint, stop: bindShutdown({ endpoint, input, output, host }) };
}

test.each(['end', 'close', 'error', 'SIGTERM'])('%s closes once and releases stdin after successful cleanup', async event => {
  const f = fixture(async () => [{ status: 'fulfilled' }]);
  (event === 'SIGTERM' ? f.host : f.input).emit(event, new Error('private detail'));
  const stopping = f.stop(); expect(f.stop()).toBe(stopping);
  await stopping;
  expect(f.endpoint.close).toHaveBeenCalledTimes(1);
  expect(f.input.destroyed).toBe(true); expect(f.host.exitCode).toBe(0);
  expect(f.host.listenerCount('SIGTERM')).toBe(0); f.output.destroy();
});

test('repeated signals cannot bypass pending cleanup or close stdin prematurely', async () => {
  let settle; const f = fixture(() => new Promise(resolve => { settle = resolve; }));
  f.host.emit('SIGTERM'); await Promise.resolve(); f.host.emit('SIGTERM');
  expect(f.endpoint.close).toHaveBeenCalledTimes(1);
  expect(f.host.exitCode).toBeUndefined(); expect(f.input.destroyed).toBe(false);
  settle([{ status: 'fulfilled' }]); await f.stop();
  expect(f.input.destroyed).toBe(true); f.output.destroy();
});

test.each(['rejected-result', 'exception', 'malformed-result'])('%s exits unsuccessfully without leaking cleanup diagnostics', async mode => {
  const f = fixture(async () => {
    if (mode === 'exception') throw new Error('private profile path');
    return mode === 'malformed-result' ? null : [{ status: 'rejected', reason: new Error('private profile path') }];
  });
  f.output.emit('error', new Error('private write details')); await f.stop();
  expect(f.host.exitCode).toBe(1); expect(f.input.destroyed).toBe(true);
  expect(f.output.read()).toBeNull(); f.output.destroy();
});

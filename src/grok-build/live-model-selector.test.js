'use strict';
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../scripts/lilly-live-model-relay.js'), 'utf8');
function relay(model) {
  const output = []; const handlers = {}; const create = jest.fn(async () => ({ output: [] }));
  const context = { AbortController, AbortSignal, Buffer, setTimeout: jest.fn(), clearTimeout: jest.fn(),
    process: { argv: ['node', model], env: { LILLY_TEAMS_ENABLED: 'false' }, stdin: { destroy() {} },
      stdout: { write: value => output.push(JSON.parse(value)) } },
    require: name => {
      if (name === 'node:assert/strict') return require(name);
      if (name === 'node:readline') return { createInterface: () => ({ on: (event, handler) => { handlers[event] = handler; } }) };
      if (name === '/app/src/config') return { openai: { model: 'kimi-for-coding', apiKey: 'private', baseURL: 'http://internal/v1' } };
      if (name === '/app/node_modules/openai') return class { constructor() { this.responses = { create }; } };
      throw new Error('Unexpected module');
    } };
  vm.runInNewContext(source, context); return { output, handlers, create };
}
test.each(['gpt-6-astra', 'deepseek-v4-flash', 'deepseek-v4-pro'])('pins explicitly selected %s without changing global config', async model => {
  const fixture = relay(model);
  await fixture.handlers.line(JSON.stringify({ id: 1, body: { model: 'untrusted', input: 'Test', stream: false } }));
  expect(fixture.output[0]).toEqual({ ready: true, model });
  expect(fixture.create.mock.calls[0][0].model).toBe(model);
  expect(fixture.create.mock.calls[0][0].store).toBe(false);
  if (model === 'gpt-6-astra') expect(fixture.create.mock.calls[0][0].reasoning).toEqual({ effort: 'low' });
  expect(JSON.stringify(fixture.output)).not.toContain('private');
});
test('rejects an unapproved model before opening a provider client', () => {
  expect(() => relay('arbitrary-model')).toThrow();
});

test('cancellation aborts only its request and does not create another model call', async () => {
  const fixture = relay('gpt-6-astra'); const signals = [];
  fixture.create.mockImplementation((body, options) => new Promise((resolve, reject) => {
    signals.push(options.signal);
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const first = fixture.handlers.line(JSON.stringify({ id: 1, body: {} }));
  const second = fixture.handlers.line(JSON.stringify({ id: 2, body: {} }));
  await fixture.handlers.line(JSON.stringify({ id: 1, cancel: true }));
  await first;
  expect(signals[0].aborted).toBe(true); expect(signals[1].aborted).toBe(false);
  expect(fixture.create).toHaveBeenCalledTimes(2);
  expect(fixture.output.at(-1).error).toBe('live_model_request_cancelled');
  fixture.handlers.close(); await second;
});

test('invalid relay input remains a bounded failure, including cleanup', async () => {
  const fixture = relay('gpt-6-astra');
  await expect(fixture.handlers.line('{')).resolves.toBeUndefined();
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.output.at(-1).error).toBe('live_provider_request_failed');
});

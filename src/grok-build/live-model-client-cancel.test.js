'use strict';
jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { startLiveModelClient } = require('../../bin/lilly-live-model-client');
function fixture() {
  const child = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  child.stderr = new EventEmitter(); child.kill = jest.fn(); spawn.mockReturnValue(child);
  const owner = new AbortController();
  const client = startLiveModelClient({ pod: 'backend-test', signal: owner.signal, model: 'gpt-6-astra' });
  child.stdout.emit('data', JSON.stringify({ ready: true, model: 'gpt-6-astra' }) + '\n');
  return { client, child };
}
test('worker cancellation reaches relay and leaves another worker request intact', async () => {
  const { client, child } = fixture(); const cancel = new AbortController();
  try {
    await client.ready;
    const first = client.responses.create({}, { signal: cancel.signal });
    const second = client.responses.create({});
    const rejected = expect(first).rejects.toMatchObject({ code: 'live_model_request_cancelled' });
    cancel.abort(); await rejected;
    expect(JSON.parse(child.stdin.write.mock.calls.at(-1)[0])).toEqual({ id: 1, cancel: true });
    child.stdout.emit('data', JSON.stringify({ id: 1, error: 'late' }) + '\n');
    child.stdout.emit('data', JSON.stringify({ id: 2, result: { output: [] } }) + '\n');
    await expect(second).resolves.toEqual({ output: [] });
    expect(child.kill).not.toHaveBeenCalled();
  } finally { client.close(); }
});
test('already cancelled requests never enter the relay', async () => {
  const { client, child } = fixture(); const cancel = new AbortController(); cancel.abort();
  try {
    await client.ready;
    await expect(client.responses.create({}, { signal: cancel.signal })).rejects.toMatchObject({ code: 'live_model_request_cancelled' });
    expect(child.stdin.write).not.toHaveBeenCalled();
  } finally { client.close(); }
});

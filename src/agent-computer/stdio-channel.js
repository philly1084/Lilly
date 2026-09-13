'use strict';

const { StringDecoder } = require('node:string_decoder');
const failure = code => Object.assign(new Error(`Private computer channel: ${code}`), { code });

// Private, supervised process pipes only. This is not a public HTTP endpoint,
// model-facing tool, automatic reconnect loop, or proof of process termination.
function createChannel({ input, output, handlers = {}, timeoutMs = 20000,
  maxBytes = 16 * 1024 * 1024, maxPending = 16, onBroken = () => {}, errorProof = () => false } = {}) {
  if (!input?.on || !output?.write || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024
    || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) throw failure('computer_channel_configuration');
  let sequence = 0; let lastIncoming = 0; let buffer = ''; let ended = false;
  const decoder = new StringDecoder('utf8'); const pending = new Map(); const incoming = new Map();
  const proofs = new WeakSet();
  const end = code => {
    if (ended) return; ended = true; buffer = '';
    const error = failure(code);
    for (const task of pending.values()) { clearTimeout(task.timer); task.detach(); task.reject(error); }
    pending.clear();
    for (const controller of incoming.values()) controller.abort();
    incoming.clear();
    // Keep passive stream error listeners until their supervisor closes them.
    // Closing a pipe is not equivalent to terminating its descendant processes.
    try { Promise.resolve(onBroken(error)).catch(() => {}); } catch { /* Supervisor retains its cleanup obligation. */ }
  };
  function send(message) {
    if (ended) throw failure('computer_channel_closed');
    const bytes = JSON.stringify({ version: 1, ...message }) + '\n';
    if (Buffer.byteLength(bytes) > maxBytes || output.writableLength + Buffer.byteLength(bytes) > maxBytes) {
      end('computer_channel_output_limit'); throw failure('computer_channel_output_limit');
    }
    try { output.write(bytes, error => { if (error) end('computer_channel_write_failed'); }); }
    catch { end('computer_channel_write_failed'); throw failure('computer_channel_write_failed'); }
  }
  async function receive(message) {
    if (ended) return;
    if (!message || message.version !== 1 || !Number.isSafeInteger(message.id) || message.id < 1
      || !['call', 'result', 'error'].includes(message.kind)) return end('computer_channel_protocol');
    if (message.kind !== 'call') {
      const task = pending.get(message.id);
      if (!task) return end('computer_channel_unknown_response');
      pending.delete(message.id); clearTimeout(task.timer); task.detach();
      if (message.kind === 'result') task.resolve(message.value);
      else {
        const error = failure(/^computer_[a-z_]{1,80}$/.test(message.code || '') ? message.code : 'computer_remote_failure');
        if (message.preDispatch === true) proofs.add(error);
        task.reject(error);
      }
      return;
    }
    if (message.id <= lastIncoming || incoming.size >= maxPending || !Object.hasOwn(handlers, message.method)
      || typeof handlers[message.method] !== 'function') return end('computer_channel_method_denied');
    lastIncoming = message.id; // Completed calls cannot be replayed either.
    const controller = new AbortController(); incoming.set(message.id, controller);
    try {
      const value = await handlers[message.method](message.value, controller.signal);
      if (!ended) send({ kind: 'result', id: message.id, value });
    } catch (error) {
      if (!ended) send({ kind: 'error', id: message.id,
        code: /^computer_[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'computer_remote_failure',
        preDispatch: errorProof(error) === true });
    } finally { incoming.delete(message.id); }
  }
  input.on('data', chunk => {
    if (ended) return;
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    // Bounded before parsing, including an unterminated frame. Neither frames
    // nor errors are logged: these pipes carry private page content and pixels.
    if (Buffer.byteLength(buffer) > maxBytes) return end('computer_channel_input_limit');
    let newline;
    while (!ended && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { receive(JSON.parse(line)).catch(() => end('computer_channel_protocol')); }
      catch { end('computer_channel_protocol'); }
    }
  });
  input.on('error', () => end('computer_channel_read_failed'));
  input.on('end', () => end('computer_channel_ended'));
  input.on('close', () => end('computer_channel_ended'));
  output.on('error', () => end('computer_channel_write_failed'));
  output.on('close', () => end('computer_channel_ended'));
  return {
    get closed() { return ended; },
    isPreDispatchFailure: error => proofs.has(error),
    close: () => end('computer_channel_closed'),
    request(method, value, { signal } = {}) {
      if (ended || signal?.aborted) return Promise.reject(failure('computer_channel_closed'));
      if (typeof method !== 'string' || !/^[a-z_]{1,40}$/.test(method) || pending.size >= maxPending) return Promise.reject(failure('computer_channel_request_limit'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const abort = () => end('computer_channel_aborted');
        const detach = () => signal?.removeEventListener('abort', abort);
        const timer = setTimeout(() => end('computer_channel_timeout'), timeoutMs);
        pending.set(id, { resolve, reject, timer, detach });
        signal?.addEventListener('abort', abort, { once: true });
        try { send({ kind: 'call', id, method, value }); }
        catch (error) { end(error.code || 'computer_channel_write_failed'); }
      });
    },
  };
}

module.exports = { createChannel };

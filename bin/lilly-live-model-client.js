'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
function startLiveModelClient({ pod, signal, model }) {
  if (!/^backend-[a-z0-9-]+$/.test(pod)) throw new Error('Invalid backend pod');
  if (model && !['gpt-6-astra', 'deepseek-v4-flash', 'deepseek-v4-pro'].includes(model)) throw new Error('Unapproved test model');
  const child = spawn('kubectl', ['-n', 'kimibuilt', 'exec', '-i', pod, '--', 'node', '-e',
    fs.readFileSync(path.join(__dirname, '../scripts/lilly-live-model-relay.js'), 'utf8'), ...(model ? [model] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0; let buffer = ''; let readyResolve; let readyReject; let closed = false;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const close = () => {
    if (closed) return; closed = true;
    clearTimeout(timer);
    child.stdin.end(); child.kill('SIGTERM'); signal.removeEventListener('abort', close);
    const error = Object.assign(new Error('Live model relay closed'), { code: 'live_model_relay_closed' }); readyReject(error);
    for (const request of pending.values()) { request.cleanup(); request.reject(error); } pending.clear();
  };
  const timer = setTimeout(close, 15000);
  child.on('exit', close); child.on('error', close); child.stdin.on('error', close); child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    buffer += chunk; if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) return close();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const data = JSON.parse(line);
        if (data.ready) { clearTimeout(timer); readyResolve(data.model); continue; }
        const request = pending.get(data.id); if (!request) continue; pending.delete(data.id);
        request.cleanup();
        if (data.error) request.reject(Object.assign(new Error(data.error), { code: data.error, status: data.status }));
        else request.resolve(data.events ? (async function* () { yield* data.events; })() : data.result);
      } catch { close(); }
    }
  });
  signal.addEventListener('abort', close, { once: true }); if (signal.aborted) close();
  return { ready, close, responses: { create(body, options = {}) {
    const cancelled = () => Object.assign(new Error('Live model request cancelled'), { code: 'live_model_request_cancelled' });
    if (options.signal?.aborted) return Promise.reject(cancelled());
    if (closed || pending.size >= 3) return Promise.reject(new Error('Live model relay unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      const abort = () => {
        if (!pending.delete(id)) return;
        cleanup(); reject(cancelled());
        if (!closed) child.stdin.write(`${JSON.stringify({ id, cancel: true })}\n`);
      };
      pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, body })}\n`);
    });
  } } };
}
module.exports = { startLiveModelClient };

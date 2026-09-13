'use strict';

const { randomUUID, randomBytes, timingSafeEqual } = require('crypto');
const { once } = require('events');
const http = require('http');
const express = require('express');
const { normalizeResponseStream } = require('../grok-build/response-stream');

const fail = (code) => Object.assign(new Error(`Worker broker: ${code}`), { code });
const LIMIT = 16 * 1024 * 1024;

function endpoint(value) {
  const url = new URL(value);
  const internal = url.protocol === 'http:' && (url.hostname.endsWith('.svc.cluster.local') || ['127.0.0.1', '[::1]'].includes(url.hostname));
  if ((!internal && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('invalid_base_url');
  return url.origin;
}

function scopedModelInput(value, depth = 0) {
  if (depth > 30) return false;
  if (!value || typeof value !== 'object') return true;
  if (['input_file', 'item_reference'].includes(value.type) || Object.hasOwn(value, 'file_id')) return false;
  if (value.type === 'input_image' && (typeof value.image_url !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(value.image_url))) return false;
  return Object.values(value).every((entry) => scopedModelInput(entry, depth + 1));
}

// This is a capability-authenticated internal worker route, NOT a replacement
// for operator login. Only server-created leases can invoke a model or tools.
// Upstream provider credentials never enter a worker Pod or its filesystem.
class GrokWorkerBroker {
  constructor({ baseUrl, modelRequest, authorize, maxLeases = 8, fetchImpl = fetch }) {
    this.baseUrl = endpoint(baseUrl);
    if (typeof modelRequest !== 'function' || typeof authorize !== 'function'
      || !Number.isSafeInteger(maxLeases) || maxLeases < 1 || maxLeases > 64) throw fail('invalid_configuration');
    this.modelRequest = modelRequest;
    this.authorize = authorize;
    this.fetch = fetchImpl;
    this.maxLeases = maxLeases;
    this.leases = new Map();
    this.server = null;
  }

  async listen({ port = 3001, host = '0.0.0.0' } = {}) {
    if (this.server) throw fail('already_listening');
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !['0.0.0.0', '127.0.0.1', '::1'].includes(host)) throw fail('invalid_listener');
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/agent-team-workers', (req, res) => this.handle(req, res));
    app.use((_req, res) => res.status(404).json({ error: { code: 'worker_route_not_found' } }));
    app.use((_error, _req, res, _next) => res.status(400).json({ error: { code: 'worker_request_denied' } }));
    const server = http.createServer(app);
    server.maxConnections = 64;
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
      });
      // Listener failure revokes every token; never leave a configured-looking
      // worker path running without its actual transport.
      server.on('error', () => { this.close().catch(() => {}); });
      return server.address();
    } catch (_) {
      this.server = null;
      throw fail('listener_unavailable');
    }
  }

  open(scope, { signal, model, deadlineMs = 120000, maxModelCalls = 24 } = {}) {
    if (signal?.aborted || this.leases.size >= this.maxLeases) throw fail('lease_unavailable');
    if (!scope?.ownerId || !scope?.teamId || !scope?.agentId || !scope?.taskId || !scope?.claim) throw fail('invalid_scope');
    if (typeof model !== 'string' || !model.trim() || model.length > 160
      || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 600000
      || !Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 100) throw fail('invalid_budget');
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const controller = new AbortController();
    const lease = { id, scope: structuredClone(scope), model, controller, auth: Buffer.from(`Bearer ${token}`),
      bridge: null, modelCalls: 0, maxModelCalls, activeModel: false, requests: 0, closed: false };
    const close = () => {
      if (lease.closed) return;
      lease.closed = true;
      this.leases.delete(id);
      clearTimeout(lease.timer);
      signal?.removeEventListener('abort', close);
      controller.abort();
    };
    lease.close = close;
    lease.timer = setTimeout(close, deadlineMs);
    lease.timer.unref?.();
    signal?.addEventListener('abort', close, { once: true });
    this.leases.set(id, lease);
    const root = `${this.baseUrl}/api/agent-team-workers/${id}`;
    return {
      modelEndpoint: `${root}/v1`, modelToken: token,
      connectBridge: (descriptor) => {
        if (lease.closed || lease.bridge) throw fail('bridge_unavailable');
        const url = new URL(descriptor.url);
        if (descriptor.type !== 'http' || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
          || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash
          || !Array.isArray(descriptor.headers) || descriptor.headers.length !== 1
          || descriptor.headers[0].name !== 'Authorization' || !/^Bearer [A-Za-z0-9_-]{40,}$/.test(descriptor.headers[0].value)) throw fail('invalid_bridge');
        lease.bridge = structuredClone(descriptor);
        return { type: 'http', name: 'lilly-task-tools', url: `${root}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] };
      },
      close,
    };
  }

  async close() {
    for (const lease of this.leases.values()) lease.close();
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async handle(req, res) {
    const deny = (status, code = 'worker_request_denied') => {
      if (res.headersSent) { res.destroy(); return; }
      res.status(status).json({ error: { code } });
    };
    res.setHeader('Cache-Control', 'no-store');
    // A worker token cannot be replaced by a login cookie or model-supplied
    // sender id. Do not expose this endpoint to browser-origin calls.
    const match = /^\/([a-f0-9-]{36})\/(mcp|v1\/responses)$/.exec(req.url);
    const lease = match && this.leases.get(match[1]);
    const auth = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (!lease || lease.closed || auth.length !== lease.auth.length || !timingSafeEqual(auth, lease.auth)) return deny(401);
    if (req.method !== 'POST' || req.headers.origin !== undefined || req.headers.cookie !== undefined) return deny(403);
    if (!req.is('application/json') || !req.body || Array.isArray(req.body)) return deny(400);
    if (++lease.requests > lease.maxModelCalls * 12 + 64) return deny(429);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lease.controller.signal]);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      if (await this.authorize(lease.scope) !== true || signal.aborted) return deny(403);
      if (match[2] === 'mcp') {
        if (!lease.bridge) return deny(409);
        const body = JSON.stringify(req.body);
        if (Buffer.byteLength(body) > 65536) return deny(413);
        const upstream = await this.fetch(lease.bridge.url, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
            Authorization: lease.bridge.headers[0].value }, body });
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type')?.includes('text/event-stream') ? 'text/event-stream' : 'application/json');
        let bytes = 0;
        if (upstream.body) for await (const chunk of upstream.body) {
          if (signal.aborted || (bytes += chunk.length) > LIMIT) throw fail('response_limit');
          if (!res.write(Buffer.from(chunk))) await once(res, 'drain', { signal });
        }
        res.end();
        return;
      }
      if (lease.activeModel || lease.modelCalls >= lease.maxModelCalls) return deny(429);
      const body = req.body;
      if (Buffer.byteLength(JSON.stringify(body)) > 10 * 1024 * 1024) return deny(413);
      if (body.model !== lease.model || body.previous_response_id || body.conversation || !scopedModelInput(body.input)
        || (body.tools && (!Array.isArray(body.tools) || body.tools.length > 128 || body.tools.some((tool) => tool.type !== 'function')))) return deny(403);
      // Copy documented inference parameters only; provider URLs, headers,
      // metadata, stored response ids and backend-hosted tools are not accepted.
      const request = { model: lease.model, store: false, stream: body.stream === true };
      for (const key of ['input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'reasoning', 'text', 'truncation', 'include']) {
        if (Object.hasOwn(body, key)) request[key] = body[key];
      }
      const maxTokens = body.max_output_tokens ?? 8192;
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 16384) return deny(400);
      request.max_output_tokens = maxTokens;
      lease.modelCalls += 1;
      lease.activeModel = true;
      try {
        const output = await this.modelRequest(request, { signal, maxRetries: 0 });
        if (signal.aborted) throw fail('cancelled');
        if (!request.stream) {
          const wire = JSON.stringify(output);
          if (Buffer.byteLength(wire) > LIMIT) throw fail('response_limit');
          res.type('json').send(wire);
        } else {
          res.setHeader('Content-Type', 'text/event-stream');
          let bytes = 0;
          for await (const event of normalizeResponseStream(output)) {
            const wire = `data: ${JSON.stringify(event)}\n\n`;
            if (signal.aborted || (bytes += Buffer.byteLength(wire)) > LIMIT) throw fail('response_limit');
            if (!res.write(wire)) await once(res, 'drain', { signal });
          }
          res.end('data: [DONE]\n\n');
        }
      } finally { lease.activeModel = false; }
    } catch (_) {
      // No upstream exception, prompt, URL, credential or private image is
      // copied into an operator error or application log.
      deny(signal.aborted ? 409 : 502, 'worker_transport_unavailable');
    } finally {
      controller.abort();
      res.removeListener('close', disconnected);
    }
  }
}

module.exports = { GrokWorkerBroker };

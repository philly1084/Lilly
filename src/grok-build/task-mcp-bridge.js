const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');

const RESERVED = new Set(['ownerId', 'callerId', 'teamId', 'sessionId', 'permissions', 'adminMode', 'claim']);
const errorResult = code => ({ isError: true, content: [{ type: 'text', text: code }] });
const bridgeError = code => Object.assign(new Error(`Task MCP bridge: ${code}`), { code });

function bound(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw bridgeError('invalid_limit');
  return value;
}

function toolCatalog(tools) {
  if (!Array.isArray(tools) || tools.length > 128) throw bridgeError('invalid_tools');
  const validator = new AjvJsonSchemaValidator();
  const catalog = new Map();
  for (const input of tools) {
    if (input?.type !== 'function' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.name) || catalog.has(input.name)) throw bridgeError('invalid_tool');
    const schema = structuredClone(input.parameters || { type: 'object', properties: {}, additionalProperties: false });
    if (schema.type !== 'object' || Object.keys(schema.properties || {}).some(key => RESERVED.has(key))) throw bridgeError('identity_fields_not_allowed');
    const definition = { name: input.name, description: String(input.description || '').slice(0, 4000), inputSchema: schema };
    try { catalog.set(input.name, { definition, validate: validator.getValidator(schema) }); } catch { throw bridgeError('invalid_tool_schema'); }
  }
  return catalog;
}

function toMcpResult(result, maxBytes) {
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'publicResult')) throw bridgeError('invalid_tool_result');
  const text = JSON.stringify(result.publicResult, (key, value) => {
    if (key === 'privateModelContent' || key === 'image_url' || value?.type === 'Buffer'
      || (typeof value === 'string' && /data:image\//i.test(value))) throw bridgeError('private_content_in_public_result');
    return value;
  });
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) throw bridgeError('public_result_limit');
  const content = [{ type: 'text', text }];
  const privateParts = result.privateModelContent;
  if (privateParts !== undefined && privateParts !== null) {
    if (result.publicResult?.success === false || !Array.isArray(privateParts) || privateParts.length > 4) throw bridgeError('invalid_private_content');
    let images = 0;
    for (const part of privateParts) {
      if (part?.type === 'input_text' && typeof part.text === 'string' && part.text.length <= 12000) {
        content.push({ type: 'text', text: part.text });
      } else if (part?.type === 'input_image' && typeof part.image_url === 'string') {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url);
        if (!match || part.image_url.length > maxBytes || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) throw bridgeError('invalid_private_image');
        images += 1;
        content.push({ type: 'image', mimeType: match[1], data: match[2] });
      } else throw bridgeError('invalid_private_content');
    }
    if (images !== 1) throw bridgeError('invalid_private_content');
  }
  const output = { content, ...(result.publicResult?.success === false ? { isError: true } : {}) };
  if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) throw bridgeError('result_limit');
  return output;
}

/**
 * Task-scoped private HTTP MCP transport. No user/owner/permission context comes
 * from HTTP callers. dispatch is already bound to a trusted execution claim.
 */
async function createTaskMcpBridge(options = {}) {
  if (typeof options.dispatch !== 'function') throw bridgeError('dispatch_required');
  const catalog = toolCatalog(options.tools);
  const host = options.host || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw bridgeError('loopback_required');
  const maxCalls = bound(options.maxCalls, 32, 1024);
  const deadlineMs = bound(options.deadlineMs, 120000, 3600000);
  const maxBodyBytes = bound(options.maxBodyBytes, 65536, 1024 * 1024);
  const maxResultBytes = bound(options.maxResultBytes, 8 * 1024 * 1024, 16 * 1024 * 1024);
  const eventTimeoutMs = bound(options.eventTimeoutMs, 5000, 30000);
  const token = randomBytes(32).toString('base64url');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const controller = new AbortController();
  const peers = new Set();
  const sockets = new Set();
  let calls = 0;
  let pendingCalls = 0;
  let requests = 0;
  let queue = Promise.resolve();
  let closed = false;
  let closing;
  let authority;
  let deadline;
  let catalogServed = false;
  const catalogWaiters = new Set();
  // This observes a successfully served authenticated catalog, not merely a
  // listening socket or MCP initialize. It does not claim client-side ingestion.
  function waitForCatalog({ timeoutMs = 10000, signal } = {}) {
    const timeout = bound(timeoutMs, 10000, 30000);
    if (closed || controller.signal.aborted || signal?.aborted) return Promise.reject(bridgeError('task_cancelled'));
    if (catalogServed) return Promise.resolve({ catalogServed: true });
    return new Promise((resolve, reject) => {
      const finish = code => {
        clearTimeout(timer);
        catalogWaiters.delete(finish);
        signal?.removeEventListener('abort', aborted);
        if (code) reject(bridgeError(code)); else resolve({ catalogServed: true });
      };
      const aborted = () => finish('task_cancelled');
      const timer = setTimeout(() => finish('catalog_timeout'), timeout);
      catalogWaiters.add(finish);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  const event = value => {
    try { Promise.resolve(options.onEvent?.(Object.freeze(value))).catch(() => {}); } catch { /* Telemetry cannot grant capabilities or break dispatch. */ }
  };
  const checkpointEvent = value => new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', aborted);
      if (error) reject(bridgeError(error)); else resolve();
    };
    const aborted = () => finish('event_cancelled');
    const timer = setTimeout(() => finish('event_failed'), Math.min(eventTimeoutMs, deadlineMs));
    controller.signal.addEventListener('abort', aborted, { once: true });
    if (controller.signal.aborted) return aborted();
    Promise.resolve().then(() => options.onEvent?.(Object.freeze(value))).then(() => finish(), () => finish('event_failed'));
  });

  function execute(request, extra) {
    const { name, arguments: args = {} } = request.params;
    const tool = catalog.get(name);
    if (closed || controller.signal.aborted) return errorResult('task_cancelled');
    if (!tool || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => RESERVED.has(key)) || !tool.validate(args).valid) return errorResult('tool_or_arguments_denied');
    if (calls >= maxCalls) return errorResult('tool_call_limit');
    calls += 1;
    pendingCalls += 1;
    const callId = `lilly-mcp-${randomUUID()}`;
    // The queue follows actual dispatch settlement. Aborting a caller must never
    // cause a second action to overlap a dispatcher that ignores cancellation.
    const operation = queue.then(async () => {
      if (closed || controller.signal.aborted || extra.signal.aborted) return errorResult('task_cancelled');
      const signal = AbortSignal.any([controller.signal, extra.signal]);
      try {
        await checkpointEvent({ type: 'tool_started', tool: name, callId });
        if (signal.aborted || closed) return errorResult('task_cancelled');
        const result = await options.dispatch(name, structuredClone(args), { callId, signal });
        if (signal.aborted || closed) return errorResult('task_cancelled');
        const output = toMcpResult(result, maxResultBytes);
        await checkpointEvent({ type: 'tool_finished', tool: name, callId, status: output.isError ? 'failed' : 'completed' });
        if (signal.aborted || closed) return errorResult('task_cancelled');
        return output;
      } catch (error) {
        if (error.code === 'event_failed' || error.code === 'event_cancelled') close().catch(() => {});
        event({ type: 'tool_finished', tool: name, callId, status: 'failed' });
        return errorResult(signal.aborted ? 'task_cancelled' : 'tool_execution_failed');
      }
    }).finally(() => { pendingCalls -= 1; });
    queue = operation.then(() => {}, () => {});
    return operation;
  }

  const server = http.createServer(async (req, res) => {
    const deny = status => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"request_denied"}'); };
    res.setHeader('Cache-Control', 'no-store');
    if (closed || controller.signal.aborted) return deny(410);
    const received = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (received.length !== expectedAuth.length || !timingSafeEqual(received, expectedAuth)) return deny(401);
    // No browser-origin callers, cross-origin CORS, DNS-rebinding Host values or
    // redirect paths are accepted, even with an otherwise valid task token.
    if (req.headers.origin !== undefined || req.headers.host !== authority || req.url !== '/mcp') return deny(403);
    if (req.method !== 'POST') return deny(405);
    requests += 1;
    if (requests > maxCalls * 4 + 32) return deny(429);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return deny(415);
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { deny(413); req.destroy(); return; }
        chunks.push(chunk);
      }
      if (closed) return deny(410);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || Array.isArray(body) || body.jsonrpc !== '2.0') return deny(400);
      const mcp = new Server({ name: 'lilly-task-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => {
        // Only an SDK-validated request that finishes a successful response
        // can release startup. Denied/malformed requests never reach this gate.
        res.once('finish', () => {
          if (closed || controller.signal.aborted || res.statusCode !== 200) return;
          catalogServed = true;
          for (const finish of catalogWaiters) finish();
        });
        return { tools: [...catalog.values()].map(tool => tool.definition) };
      });
      mcp.setRequestHandler(CallToolRequestSchema, execute);
      mcp.onerror = () => {};
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const peer = { mcp, transport };
      peers.add(peer);
      const cleanup = () => { peers.delete(peer); mcp.close().catch(() => {}); };
      res.once('close', cleanup);
      await mcp.connect(transport);
      if (closed) { cleanup(); return deny(410); }
      await transport.handleRequest(req, res, body);
    } catch { if (!res.writableEnded) deny(400); }
  });
  server.maxConnections = 32;
  server.headersTimeout = 10000;
  server.requestTimeout = Math.min(deadlineMs, 15000);
  server.timeout = deadlineMs;
  server.keepAliveTimeout = 1000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());

  async function close() {
    if (closing) { await closing; return { settled: pendingCalls === 0 }; }
    closed = true;
    controller.abort();
    for (const finish of catalogWaiters) finish('task_cancelled');
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
    event({ type: 'bridge_closed' });
    closing = (async () => {
      // Revoke first, then close transports/sockets. Do not wait indefinitely for
      // a dispatcher that ignores its abort signal; the supervisor owns reaping.
      const serverClosed = new Promise(resolve => server.close(() => resolve()));
      for (const peer of peers) peer.mcp.close().catch(() => {});
      peers.clear();
      for (const socket of sockets) socket.destroy();
      await serverClosed;
    })();
    await closing;
    return { settled: pendingCalls === 0 };
  }
  const onAbort = () => { close().catch(() => {}); };
  if (options.signal?.aborted) { await close(); throw bridgeError('task_cancelled'); }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', onAbort);
  const address = server.address();
  authority = `${host === '::1' ? '[::1]' : host}:${address.port}`;
  options.signal?.addEventListener('abort', onAbort, { once: true });
  deadline = setTimeout(onAbort, deadlineMs);
  deadline.unref?.();
  if (options.signal?.aborted) { await close(); throw bridgeError('task_cancelled'); }
  event({ type: 'bridge_ready' });
  return {
    // Credentials belong only to the agent transport. Never persist this object
    // as a task artifact or broadcast it through an operator event stream.
    mcpServer: { type: 'http', name: 'lilly-task-tools', url: `http://${authority}/mcp`, headers: [{ name: 'Authorization', value: expectedAuth.toString() }] },
    close,
    waitForCatalog,
    getStatus: () => ({ closed, pendingCalls, calls, catalogServed }),
  };
}

module.exports = { createTaskMcpBridge };

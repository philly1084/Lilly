'use strict';

const express = require('express');
const request = require('supertest');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { GrokWorkerBroker } = require('./worker-broker');
const { createTaskMcpBridge } = require('../grok-build/task-mcp-bridge');

const scope = { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task', claim: { taskId: 'task', workerId: 'worker', claimId: 'claim' } };
let app; let broker; let modelRequest; let authorize;
const open = () => broker.open(scope, { model: 'approved-model', deadlineMs: 10000, maxModelCalls: 2 });
const route = (lease) => new URL(`${lease.modelEndpoint}/responses`).pathname;
const auth = (lease) => `Bearer ${lease.modelToken}`;

beforeEach(() => {
  modelRequest = jest.fn(async () => ({ id: 'response', output: [] }));
  authorize = jest.fn(async () => true);
  broker = new GrokWorkerBroker({ baseUrl: 'http://127.0.0.1', modelRequest, authorize });
  app = express(); app.use(express.json({ limit: '10mb' }));
  app.use('/api/agent-team-workers', (req, res) => broker.handle(req, res));
});
afterEach(async () => broker.close());

test('legacy gateway streaming yields typed Grok events through the authenticated broker', async () => {
  const lease = open();
  const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'search_tool', arguments: '{"query":"computer_open"}', status: 'completed' };
  modelRequest.mockImplementation(async () => (async function* () {
    yield { id: 'resp_1', object: 'response.chunk', created_at: 1, model: 'approved-model', status: 'completed', output: [item] };
  })());
  const result = await request(app).post(route(lease)).set('Authorization', auth(lease))
    .send({ model: 'approved-model', input: 'Test', stream: true });
  expect(result.status).toBe(200);
  const events = result.text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  expect(events[0].type).toBe('response.created');
  expect(events.at(-1).type).toBe('response.completed');
  expect(events.at(-1).response.output).toEqual([item]);
  expect(events.find(event => event.type === 'response.function_call_arguments.delta').delta).toBe(item.arguments);
  expect(modelRequest).toHaveBeenCalledTimes(1);
});

test('task capability pins model and does not pass caller credentials, metadata or storage options upstream', async () => {
  const lease = open();
  const result = await request(app).post(route(lease)).set('Authorization', auth(lease)).send({
    model: 'approved-model', input: 'Hello', store: true, metadata: { ownerId: 'attacker' }, headers: { Authorization: 'stolen' },
  });
  expect(result.status).toBe(200);
  expect(modelRequest).toHaveBeenCalledWith({ model: 'approved-model', input: 'Hello', store: false, stream: false, max_output_tokens: 8192 },
    { signal: expect.any(AbortSignal), maxRetries: 0 });
  expect(authorize).toHaveBeenCalledWith(scope);
  expect(JSON.stringify(broker.leases.get(new URL(lease.modelEndpoint).pathname.split('/')[3]).scope)).not.toContain(lease.modelToken);
});

test('tokens cannot cross leases; login cookies and browser origins do not authorize workers', async () => {
  const a = open(); const b = open();
  expect((await request(app).post(route(b)).set('Authorization', auth(a)).send({ model: 'approved-model' })).status).toBe(401);
  for (const headers of [{ Origin: 'https://lilly.test' }, { Cookie: 'session=operator' }]) {
    expect((await request(app).post(route(a)).set('Authorization', auth(a)).set(headers).send({ model: 'approved-model' })).status).toBe(403);
  }
  expect(modelRequest).not.toHaveBeenCalled();
});

test.each([
  { model: 'expensive-unapproved' }, { model: 'approved-model', previous_response_id: 'another-response' },
  { model: 'approved-model', conversation: 'another-conversation' },
  { model: 'approved-model', tools: [{ type: 'web_search' }] },
  { model: 'approved-model', input: [{ type: 'item_reference', id: 'another-task-item' }] },
  { model: 'approved-model', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'http://169.254.169.254/private' }] }] },
])('rejects expanded provider scope %#', async (body) => {
  const lease = open();
  expect((await request(app).post(route(lease)).set('Authorization', auth(lease)).send(body)).status).toBe(403);
  expect(modelRequest).not.toHaveBeenCalled();
});

test('revoked claim prevents model execution and closed token is unusable', async () => {
  const lease = open(); authorize.mockResolvedValue(false);
  expect((await request(app).post(route(lease)).set('Authorization', auth(lease)).send({ model: 'approved-model' })).status).toBe(403);
  lease.close();
  expect((await request(app).post(route(lease)).set('Authorization', auth(lease)).send({ model: 'approved-model' })).status).toBe(401);
  expect(modelRequest).not.toHaveBeenCalled();
});

test('model request budget holds and raw provider errors do not leave the broker', async () => {
  const lease = open();
  modelRequest.mockRejectedValue(new Error('Provider key=secret prompt=private'));
  for (let i = 0; i < 2; i += 1) {
    const result = await request(app).post(route(lease)).set('Authorization', auth(lease)).send({ model: 'approved-model' });
    expect(result.status).toBe(502); expect(result.text).not.toMatch(/secret|private/);
  }
  expect((await request(app).post(route(lease)).set('Authorization', auth(lease)).send({ model: 'approved-model' })).status).toBe(429);
  expect(modelRequest).toHaveBeenCalledTimes(2);
});

test('streaming relays typed Responses events without enabling stored responses', async () => {
  const lease = open();
  modelRequest.mockImplementation(async function* () {
    yield { type: 'response.output_text.delta', delta: 'Hello' };
    yield { type: 'response.completed', response: { id: 'response', object: 'response', status: 'completed', model: 'approved-model', created_at: 1,
      output: [{ id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] }] } };
  });
  const result = await request(app).post(route(lease)).set('Authorization', auth(lease)).send({ model: 'approved-model', stream: true });
  expect(result.status).toBe(200); expect(result.type).toBe('text/event-stream');
  expect(result.text).toContain('response.output_text.delta'); expect(result.text).toContain('[DONE]');
});

test('real SDK MCP round trip crosses broker to private loopback bridge, including image blocks', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  broker.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const lease = open();
  const events = [];
  const dispatch = jest.fn(async () => ({ publicResult: { frameId: 'frame' },
    privateModelContent: [{ type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }] }));
  const bridge = await createTaskMcpBridge({ tools: [{ type: 'function', name: 'observe', parameters: { type: 'object', properties: {}, additionalProperties: false } }], dispatch,
    onEvent: (event) => events.push(event) });
  const descriptor = lease.connectBridge(bridge.mcpServer);
  const client = new Client({ name: 'worker-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), {
      requestInit: { headers: { Authorization: descriptor.headers[0].value } },
    }));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['observe']);
    const result = await client.callTool({ name: 'observe', arguments: {} });
    expect(result.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toMatch(/aW1hZ2U|Bearer/);
  } finally {
    await client.close(); lease.close(); await bridge.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});

test('cannot connect a model-selected URL or credential-bearing arbitrary proxy target', () => {
  const lease = open();
  expect(() => lease.connectBridge({ type: 'http', url: 'http://169.254.169.254/mcp', headers: [] })).toThrow('invalid_bridge');
});

test('dedicated listener serves no ordinary Lilly API, health, login or artifact routes', async () => {
  const address = await broker.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of ['/api/auth/login', '/health', '/api/artifacts/private/download', '/api/agent-teams']) {
    const result = await fetch(`${base}${path}`);
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({ error: { code: 'worker_route_not_found' } });
  }
  const lease = open();
  const result = await fetch(`${base}${route(lease)}`, { method: 'POST', headers: { Authorization: auth(lease), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'approved-model' }) });
  expect(result.status).toBe(200);
});

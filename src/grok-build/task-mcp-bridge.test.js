const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createTaskMcpBridge } = require('./task-mcp-bridge');
const http = require('node:http');

const definition = {
  type: 'function', name: 'note_write', description: 'Write the assigned note.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('task-scoped MCP bridge using actual SDK HTTP clients', () => {
  const closers = [];
  afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
  async function fixture(options = {}) {
    const events = [];
    const dispatch = jest.fn(async (_name, args) => ({ publicResult: { written: args.text } }));
    const bridge = await createTaskMcpBridge({ tools: [definition], dispatch, onEvent: event => events.push(event), ...options });
    closers.push(() => bridge.close());
    const headers = Object.fromEntries(bridge.mcpServer.headers.map(header => [header.name, header.value]));
    const connect = async (override = {}) => {
      const client = new Client({ name: 'fixture-grok-agent', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(bridge.mcpServer.url), { requestInit: { headers: { ...headers, ...override } } });
      closers.push(() => client.close());
      await client.connect(transport);
      return client;
    };
    return { bridge, dispatch, events, headers, connect };
  }

  test('lists only trusted tools and dispatches valid tool calls with generated identity-free context', async () => {
    const f = await fixture();
    const client = await f.connect();
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['note_write']);
    const output = await client.callTool({ name: 'note_write', arguments: { text: 'artifact content' } });
    expect(JSON.parse(output.content[0].text)).toEqual({ written: 'artifact content' });
    const [name, args, context] = f.dispatch.mock.calls[0];
    expect(name).toBe('note_write');
    expect(args).toEqual({ text: 'artifact content' });
    expect(Object.keys(context).sort()).toEqual(['callId', 'signal']);
    expect(context.callId).toMatch(/^lilly-mcp-[a-f0-9-]+$/);
    expect(JSON.stringify(f.events)).not.toContain('artifact content');
    expect(JSON.stringify(f.events)).not.toContain(f.headers.Authorization);
  });

  test('catalog wait requires tools/list, resolves concurrent waiters and remembers successful discovery', async () => {
    const f = await fixture();
    const client = await f.connect();
    let ready = false;
    const first = f.bridge.waitForCatalog().then(value => { ready = true; return value; });
    const second = f.bridge.waitForCatalog();
    await delay(10);
    expect(ready).toBe(false);
    expect(f.bridge.getStatus().catalogServed).toBe(false);
    await client.listTools();
    expect(await first).toEqual({ catalogServed: true });
    expect(await second).toEqual({ catalogServed: true });
    expect(await f.bridge.waitForCatalog()).toEqual({ catalogServed: true });
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  test('denied and malformed catalog requests do not satisfy readiness', async () => {
    const f = await fixture();
    for (const [Authorization, params] of [['Bearer wrong', {}], [f.headers.Authorization, { cursor: 42 }]]) {
      const res = await fetch(f.bridge.mcpServer.url, { method: 'POST',
        headers: { Authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params }) });
      await res.text();
    }
    await expect(f.bridge.waitForCatalog({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'catalog_timeout' });
    expect(f.bridge.getStatus().catalogServed).toBe(false);
    expect(f.dispatch).not.toHaveBeenCalled();
    // A waiter timeout does not fabricate readiness or poison a later valid read.
    await (await f.connect()).listTools();
    expect(await f.bridge.waitForCatalog()).toEqual({ catalogServed: true });
  });

  test('catalog wait is bounded, abortable, and revoked by bridge close even after discovery', async () => {
    const f = await fixture();
    for (const timeoutMs of [0, -1, 30001, NaN]) {
      expect(() => f.bridge.waitForCatalog({ timeoutMs })).toThrow('invalid_limit');
    }
    const controller = new AbortController();
    const aborted = expect(f.bridge.waitForCatalog({ signal: controller.signal })).rejects.toMatchObject({ code: 'task_cancelled' });
    controller.abort(); await aborted;
    await expect(f.bridge.waitForCatalog({ signal: controller.signal })).rejects.toMatchObject({ code: 'task_cancelled' });
    const pending = expect(f.bridge.waitForCatalog()).rejects.toMatchObject({ code: 'task_cancelled' });
    await f.bridge.close(); await pending;
    const b = await fixture(); await (await b.connect()).listTools();
    await b.bridge.close();
    await expect(b.bridge.waitForCatalog()).rejects.toMatchObject({ code: 'task_cancelled' });
  });

  test('task cancellation rejects catalog wait without waiting for its timeout', async () => {
    const controller = new AbortController();
    const f = await fixture({ signal: controller.signal });
    const pending = expect(f.bridge.waitForCatalog({ timeoutMs: 30000 })).rejects.toMatchObject({ code: 'task_cancelled' });
    controller.abort(); await pending;
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  test('wrong or missing token and any browser Origin are denied before dispatch', async () => {
    const f = await fixture();
    await expect(f.connect({ Authorization: 'Bearer wrong' })).rejects.toThrow();
    const missing = await fetch(f.bridge.mcpServer.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(missing.status).toBe(401);
    const origin = await fetch(f.bridge.mcpServer.url, { method: 'POST', headers: { ...f.headers, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    expect(origin.status).toBe(403);
    const rebindingStatus = await new Promise((resolve, reject) => {
      const req = http.request(f.bridge.mcpServer.url, { method: 'POST', headers: { ...f.headers, Host: 'evil.example', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end('{}');
    });
    expect(rebindingStatus).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  test('tokens are scoped to one endpoint and revoked on close', async () => {
    const a = await fixture(); const b = await fixture();
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
    await expect(b.connect(a.headers)).rejects.toThrow();
    await a.bridge.close();
    await expect(fetch(a.bridge.mcpServer.url, { headers: a.headers })).rejects.toThrow();
    expect(a.dispatch).not.toHaveBeenCalled(); expect(b.dispatch).not.toHaveBeenCalled();
  });

  test('unknown tools, bad args and injected caller permissions never dispatch', async () => {
    const f = await fixture(); const client = await f.connect();
    for (const params of [
      { name: 'host_shell', arguments: {} },
      { name: 'note_write', arguments: { text: 5 } },
      { name: 'note_write', arguments: { text: 'test', ownerId: 'other', adminMode: true } },
    ]) expect((await client.callTool(params)).isError).toBe(true);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  test('private image bytes go only to authenticated tool result, not events or public text', async () => {
    const pixels = Buffer.from('private test pixels').toString('base64');
    const f = await fixture({ dispatch: async () => ({ publicResult: { frameId: 'frame1' }, privateModelContent: [
      { type: 'input_text', text: 'private browser title' }, { type: 'input_image', image_url: `data:image/png;base64,${pixels}` },
    ] }) });
    const output = await (await f.connect()).callTool({ name: 'note_write', arguments: { text: 'observe' } });
    expect(output.content).toEqual([
      { type: 'text', text: '{"frameId":"frame1"}' }, { type: 'text', text: 'private browser title' },
      { type: 'image', mimeType: 'image/png', data: pixels },
    ]);
    expect(JSON.stringify(f.events)).not.toMatch(/private browser|private test|image\/png/);
    expect(JSON.stringify(f.events)).not.toContain(pixels);
  });

  test('rejects private data in public results and remote image URLs; redacts thrown errors', async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce({ publicResult: { image_url: 'data:image/png;base64,c2VjcmV0' } })
      .mockResolvedValueOnce({ publicResult: {}, privateModelContent: [{ type: 'input_image', image_url: 'https://private.example/secret' }] })
      .mockRejectedValueOnce(new Error('credential=PRIVATE_SECRET'));
    const f = await fixture({ dispatch }); const client = await f.connect();
    for (let i = 0; i < 3; i += 1) {
      const output = await client.callTool({ name: 'note_write', arguments: { text: 'test' } });
      expect(output).toEqual({ isError: true, content: [{ type: 'text', text: 'tool_execution_failed' }] });
    }
    expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE_SECRET|private.example|c2VjcmV0/);
  });

  test('serializes dispatch with unique call IDs and bounds calls', async () => {
    let release;
    const dispatch = jest.fn().mockImplementationOnce(async () => {
      await new Promise(resolve => { release = resolve; }); return { publicResult: { first: true } };
    }).mockResolvedValue({ publicResult: { second: true } });
    const f = await fixture({ dispatch, maxCalls: 2 }); const client = await f.connect();
    const first = client.callTool({ name: 'note_write', arguments: { text: 'one' } });
    while (!release) await delay(2);
    const second = client.callTool({ name: 'note_write', arguments: { text: 'two' } });
    await delay(20); expect(dispatch).toHaveBeenCalledTimes(1);
    release(); await Promise.all([first, second]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][2].callId).not.toBe(dispatch.mock.calls[1][2].callId);
    expect((await client.callTool({ name: 'note_write', arguments: { text: 'three' } })).content[0].text).toBe('tool_call_limit');
  });

  test('task cancellation aborts active dispatch, closes pending HTTP and prevents queued work', async () => {
    const controller = new AbortController(); let release;
    const dispatch = jest.fn(async () => {
      await new Promise(resolve => { release = resolve; }); return { publicResult: { late: true } };
    });
    const f = await fixture({ signal: controller.signal, dispatch }); const client = await f.connect();
    const first = client.callTool({ name: 'note_write', arguments: { text: 'one' } }).catch(() => null);
    while (!release) await delay(2);
    const second = client.callTool({ name: 'note_write', arguments: { text: 'two' } }).catch(() => null);
    await delay(20); controller.abort();
    expect(dispatch.mock.calls[0][2].signal.aborted).toBe(true);
    release(); await Promise.all([first, second]); await f.bridge.close();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('deadline revokes endpoint and oversized body is rejected before dispatch', async () => {
    const f = await fixture({ deadlineMs: 200, maxBodyBytes: 256 });
    const oversized = await fetch(f.bridge.mcpServer.url, { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(300) }) });
    expect(oversized.status).toBe(413);
    await delay(220);
    await expect(fetch(f.bridge.mcpServer.url, { headers: f.headers })).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  test('rejects nonloopback configuration and preaborted tasks', async () => {
    await expect(createTaskMcpBridge({ tools: [], dispatch: () => {}, host: '0.0.0.0' })).rejects.toThrow('loopback_required');
    const controller = new AbortController(); controller.abort();
    await expect(createTaskMcpBridge({ tools: [], dispatch: () => {}, signal: controller.signal })).rejects.toThrow('task_cancelled');
  });

  test('bounds returned content and closes idempotently', async () => {
    const f = await fixture({ maxResultBytes: 32 });
    const output = await (await f.connect()).callTool({ name: 'note_write', arguments: { text: 'tool output exceeds result budget' } });
    expect(output.isError).toBe(true);
    expect(output.content[0].text).toBe('tool_execution_failed');
    await f.bridge.close(); await f.bridge.close();
  });

  test('awaits tool-start checkpoint and never dispatches after its failure', async () => {
    let fail;
    const f = await fixture({ onEvent: event => event.type === 'tool_started' ? new Promise((_resolve, reject) => { fail = reject; }) : undefined });
    const call = (await f.connect()).callTool({ name: 'note_write', arguments: { text: 'test' } }).catch(() => null);
    while (!fail) await delay(2);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.bridge.getStatus().pendingCalls).toBe(1);
    fail(new Error('claim expired'));
    await call;
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.bridge.getStatus().closed).toBe(true);
  });

  test('tool checkpoint deadline prevents dispatch and cancellation while checkpointing wins', async () => {
    const f = await fixture({ eventTimeoutMs: 10, onEvent: event => event.type === 'tool_started' ? new Promise(() => {}) : undefined });
    await expect((await f.connect()).callTool({ name: 'note_write', arguments: { text: 'test' } })).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
    const controller = new AbortController(); let resume;
    const b = await fixture({ signal: controller.signal, onEvent: event => event.type === 'tool_started' ? new Promise(resolve => { resume = resolve; }) : undefined });
    const call = (await b.connect()).callTool({ name: 'note_write', arguments: { text: 'test' } }).catch(() => null);
    while (!resume) await delay(2);
    controller.abort(); resume(); await call;
    expect(b.dispatch).not.toHaveBeenCalled();
  });

  test('close reports unsettled noncooperative dispatch until actual promise settles', async () => {
    let release;
    const f = await fixture({ dispatch: () => new Promise(resolve => { release = resolve; }) });
    const call = (await f.connect()).callTool({ name: 'note_write', arguments: { text: 'test' } }).catch(() => null);
    while (!release) await delay(2);
    expect(await f.bridge.close()).toEqual({ settled: false });
    expect(f.bridge.getStatus()).toMatchObject({ closed: true, pendingCalls: 1 });
    release({ publicResult: { done: true } }); await call; await delay(2);
    expect(f.bridge.getStatus().pendingCalls).toBe(0);
    expect(await f.bridge.close()).toEqual({ settled: true });
  });
});

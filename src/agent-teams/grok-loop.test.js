'use strict';

jest.mock('../grok-build/task-mcp-bridge', () => ({ createTaskMcpBridge: jest.fn() }));
const { EventEmitter } = require('events');
const { createGrokTaskLoop } = require('./grok-loop');

function setup() {
  const client = new EventEmitter();
  Object.assign(client, {
    start: jest.fn(async () => ({ agentCapabilities: {} })),
    setTaskMcpPermissions: jest.fn(),
    openSession: jest.fn(async () => ({ sessionId: 'upstream-session' })),
    prompt: jest.fn(async () => {
      client.emit('update', { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Private thought.' } } });
      client.emit('update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Report, not artifact proof.' } } });
      return { stopReason: 'end_turn' };
    }), cancel: jest.fn(), close: jest.fn(),
  });
  const worker = { client, saveSession: jest.fn(async () => {}), close: jest.fn(async () => {}) };
  const createWorker = jest.fn(async () => worker);
  const bridge = { mcpServer: { type: 'http', name: 'scoped', url: 'http://127.0.0.1:123/mcp', headers: [] },
    waitForCatalog: jest.fn(async () => ({ catalogServed: true })), close: jest.fn(async () => ({ settled: true })) };
  const createBridge = jest.fn(async () => bridge);
  const run = createGrokTaskLoop({ createWorker, createBridge });
  const input = { scope: { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task' },
    input: [{ role: 'user', content: 'Write.' }], instructions: 'Scoped team context.',
    tools: [{ type: 'function', name: 'artifact_write' }], dispatch: jest.fn(), onEvent: jest.fn(), maxTimeMs: 1000 };
  return { run, input, createWorker, createBridge, client, worker, bridge };
}

test('shares scoped tools and saves session before prompting; only final report leaves ACP', async () => {
  const env = setup();
  env.worker.sessionId = 'prior-session';
  expect(await env.run(env.input)).toEqual({ summary: 'Report, not artifact proof.' });
  expect(env.createWorker).toHaveBeenCalledWith(expect.objectContaining({ ...env.input.scope, signal: expect.any(AbortSignal) }));
  expect(env.createBridge).toHaveBeenCalledWith(expect.objectContaining({ tools: env.input.tools, dispatch: env.input.dispatch }));
  expect(env.client.openSession).toHaveBeenCalledWith({ sessionId: 'prior-session', mcpServers: [env.bridge.mcpServer] });
  expect(env.client.setTaskMcpPermissions).toHaveBeenCalledWith({ serverName: 'scoped', toolNames: ['artifact_write'] });
  expect(env.client.setTaskMcpPermissions.mock.invocationCallOrder[0]).toBeLessThan(env.client.openSession.mock.invocationCallOrder[0]);
  expect(env.worker.saveSession.mock.invocationCallOrder[0]).toBeLessThan(env.client.prompt.mock.invocationCallOrder[0]);
  expect(env.worker.saveSession.mock.invocationCallOrder[0]).toBeLessThan(env.bridge.waitForCatalog.mock.invocationCallOrder[0]);
  expect(env.bridge.waitForCatalog.mock.invocationCallOrder[0]).toBeLessThan(env.client.prompt.mock.invocationCallOrder[0]);
  expect(env.input.onEvent).not.toHaveBeenCalled();
  expect(env.bridge.close).toHaveBeenCalledTimes(1);
  expect(env.worker.close).toHaveBeenCalledTimes(1);
});

test('continues a premature report in the same worker and session until real evidence exists', async () => {
  const env = setup(); const evidence = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await env.run({ ...env.input, hasCompletionEvidence: evidence })).toEqual({ summary: 'Report, not artifact proof.' });
  expect(env.client.prompt).toHaveBeenCalledTimes(2); expect(env.createWorker).toHaveBeenCalledTimes(1);
  expect(env.client.openSession).toHaveBeenCalledTimes(1); expect(env.createBridge).toHaveBeenCalledTimes(1);
  expect(env.client.prompt.mock.calls[1][0]).toContain('missing required saved deliverables');
  expect(env.worker.close).toHaveBeenCalledTimes(1);
});

test('missing completion evidence cannot cause an unbounded continuation loop', async () => {
  const env = setup();
  await expect(env.run({ ...env.input, hasCompletionEvidence: async () => false }))
    .rejects.toMatchObject({ code: 'team_grok_completion_evidence_missing' });
  expect(env.client.prompt).toHaveBeenCalledTimes(3); expect(env.worker.close).toHaveBeenCalledTimes(1);
});

test('private image tool results require HTTP MCP before tools are exposed', async () => {
  const env = setup();
  env.input.tools.push({ type: 'function', name: 'computer_open' });
  env.client.start.mockResolvedValue({ agentCapabilities: { promptCapabilities: { image: true } } });
  await expect(env.run(env.input)).rejects.toMatchObject({ code: 'team_grok_private_image_transport_unsupported' });
  expect(env.createBridge).not.toHaveBeenCalled();
  expect(env.client.prompt).not.toHaveBeenCalled();
  expect(env.worker.close).toHaveBeenCalledTimes(1);
});

test('MCP image results do not require the unrelated ACP prompt-image flag', async () => {
  const env = setup();
  env.client.start.mockResolvedValue({ agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: false } } });
  env.input.tools.push({ type: 'function', name: 'computer_snapshot' });
  expect(await env.run(env.input)).toEqual({ summary: 'Report, not artifact proof.' });
  expect(env.createBridge).toHaveBeenCalledWith(expect.objectContaining({ tools: env.input.tools, dispatch: env.input.dispatch }));
  expect(env.client.prompt).toHaveBeenCalledTimes(1);
  expect(env.input.onEvent).not.toHaveBeenCalled();
});

test('session persistence failure cannot launch an untracked prompt', async () => {
  const env = setup();
  env.worker.saveSession.mockRejectedValue(new Error('Persistence unavailable.'));
  await expect(env.run(env.input)).rejects.toThrow('Persistence unavailable');
  expect(env.client.prompt).not.toHaveBeenCalled();
  expect(env.bridge.close).toHaveBeenCalledTimes(1);
  expect(env.worker.close).toHaveBeenCalledTimes(1);
});

test('delayed catalog holds the assignment without prompting, including saved-session replay', async () => {
  const env = setup();
  env.worker.sessionId = 'saved-session';
  let release;
  const waiting = new Promise(resolve => {
    env.bridge.waitForCatalog.mockImplementation(() => new Promise(ready => { release = ready; resolve(); }));
  });
  const run = env.run(env.input);
  await waiting;
  expect(env.worker.saveSession).toHaveBeenCalledTimes(1);
  expect(env.client.prompt).not.toHaveBeenCalled();
  release({ catalogServed: true });
  expect(await run).toEqual({ summary: 'Report, not artifact proof.' });
});

test.each(['missing', 'timeout', 'false'])('catalog %s fails closed and confirms worker cleanup', async failure => {
  const env = setup();
  if (failure === 'missing') delete env.bridge.waitForCatalog;
  if (failure === 'timeout') env.bridge.waitForCatalog.mockRejectedValue(Object.assign(new Error('catalog_timeout'), { code: 'catalog_timeout' }));
  if (failure === 'false') env.bridge.waitForCatalog.mockResolvedValue({ catalogServed: false });
  await expect(env.run(env.input)).rejects.toThrow();
  expect(env.client.prompt).not.toHaveBeenCalled();
  expect(env.bridge.close).toHaveBeenCalledTimes(1);
  expect(env.worker.close).toHaveBeenCalledTimes(1);
});

test('cancellation during catalog wait never releases a late prompt', async () => {
  const env = setup();
  const controller = new AbortController();
  env.bridge.waitForCatalog.mockImplementation(async () => {
    controller.abort(); return { catalogServed: true };
  });
  await expect(env.run({ ...env.input, signal: controller.signal })).rejects.toMatchObject({ code: 'team_grok_cancelled_or_timed_out' });
  expect(env.client.prompt).not.toHaveBeenCalled();
  expect(env.worker.close).toHaveBeenCalledTimes(1);
});

test('supervisor must confirm shutdown even after successful model prose', async () => {
  const env = setup();
  env.worker.close.mockRejectedValue(new Error('Worker still running.'));
  await expect(env.run(env.input)).rejects.toThrow('Worker still running');
});

test('nonsettled Lilly tools prevent accepting a successful Grok report', async () => {
  const env = setup();
  env.bridge.close.mockResolvedValue({ settled: false });
  await expect(env.run(env.input)).rejects.toMatchObject({ code: 'team_grok_tools_unsettled' });
  expect(env.worker.close).toHaveBeenCalledTimes(1);
});

test('aborted scope never provisions a worker', async () => {
  const env = setup();
  const controller = new AbortController(); controller.abort();
  await expect(env.run({ ...env.input, signal: controller.signal })).rejects.toMatchObject({ code: 'team_grok_cancelled_or_timed_out' });
  expect(env.createWorker).not.toHaveBeenCalled();
});

test('cancellation closes ACP and waits for supervisor cleanup', async () => {
  const env = setup();
  const controller = new AbortController();
  env.client.prompt.mockImplementation(async () => {
    controller.abort();
    return { stopReason: 'cancelled' };
  });
  await expect(env.run({ ...env.input, signal: controller.signal })).rejects.toMatchObject({ code: 'team_grok_cancelled_or_timed_out' });
  expect(env.client.cancel).toHaveBeenCalled();
  expect(env.client.close).toHaveBeenCalled();
  expect(env.worker.close).toHaveBeenCalledTimes(1);
});

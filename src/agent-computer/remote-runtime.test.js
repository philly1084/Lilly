'use strict';

const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentComputerRuntime } = require('./runtime');
const { connectComputer, serveComputer } = require('./remote-runtime');
const identity = { ownerId: 'owner', teamId: 'team', agentId: 'agent', claim: { taskId: 'task', workerId: 'worker', claimId: 'claim' } };

test('real browser runtime crosses private pipes for fresh policy, hidden observations and model-only pixels', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-remote-computer-'));
  const ab = new PassThrough(); const ba = new PassThrough(); let allowed = true;
  const authorize = jest.fn(async request => allowed && request.identity.ownerId === identity.ownerId && request.identity.claim.claimId === identity.claim.claimId);
  const context = { pages: () => [page], route: jest.fn(), routeWebSocket: jest.fn(), on: jest.fn(), close: jest.fn(async () => {}) };
  const page = { goto: jest.fn(), url: () => 'https://allowed.test/private', title: async () => 'PRIVATE_TITLE',
    screenshot: async () => Buffer.from('PRIVATE_PIXELS'), on: jest.fn(), setDefaultTimeout: jest.fn(), mouse: { click: jest.fn() } };
  const chromium = { launchPersistentContext: jest.fn(async () => context) };
  const server = serveComputer({ input: ab, output: ba, createRuntime: options => new AgentComputerRuntime({ ...options, rootDir, chromium }) });
  const terminate = jest.fn(async () => { await server.close(); ab.destroy(); ba.destroy(); });
  const client = connectComputer({ input: ba, output: ab, authorize, terminate });
  try {
    const observation = await client.open(identity, { url: 'https://allowed.test/private' });
    expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|allowed.test|image/);
    const input = await client.getModelInput(identity, observation);
    expect(input[0].text).toContain('PRIVATE_TITLE');
    expect(input[1].image_url).toBe(`data:image/png;base64,${Buffer.from('PRIVATE_PIXELS').toString('base64')}`);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ identity, operation: 'model_input' }));
    const stale = await client.act(identity, { ...observation, frameId: 'old', action: { type: 'click', x: 1, y: 1 } }).catch(error => error);
    expect(client.isPreDispatchFailure(stale)).toBe(true); expect(page.mouse.click).not.toHaveBeenCalled();
    allowed = false;
    await expect(client.getModelInput(identity, observation)).rejects.toMatchObject({ code: 'computer_policy_denied' });
    const stopping = client.dispose(); expect(client.dispose()).toBe(stopping);
    expect((await stopping).every(result => result.status === 'fulfilled')).toBe(true);
    await expect(client.open(identity, { url: 'https://allowed.test/' })).rejects.toMatchObject({ code: 'computer_disposed' });
    expect(terminate).toHaveBeenCalledTimes(1); expect(context.close).toHaveBeenCalledTimes(1);
    expect((await fs.readdir(rootDir)).some(file => file.endsWith('.lease'))).toBe(false);
  } finally { await client.dispose(); await fs.rm(rootDir, { recursive: true, force: true }); }
});

test('transport loss invokes exact supervision, and failed termination remains unresolved', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const terminate = jest.fn(async () => { throw new Error('Supervisor cannot confirm removal'); });
  const runtime = connectComputer({ input, output, authorize: async () => true, terminate, timeoutMs: 100 });
  input.end(); await new Promise(resolve => setImmediate(resolve));
  expect(terminate).toHaveBeenCalledTimes(1);
  const stopping = runtime.dispose();
  expect((await stopping).some(result => result.status === 'rejected')).toBe(true);
  expect(runtime.dispose()).toBe(stopping); expect(terminate).toHaveBeenCalledTimes(1);
  output.destroy(); input.destroy();
});

const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const { GrokBuildAcpClient, GROK_SOURCE_REVISION } = require('./acp-client');

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const sent = [];
  child.stdin = new Writable({ write(chunk, encoding, callback) { sent.push(JSON.parse(chunk.toString())); callback(); } });
  child.kill = jest.fn(() => true);
  const launch = jest.fn(() => child);
  const client = new GrokBuildAcpClient({
    executable: path.resolve('test-grok'), cwd: path.resolve('test-workspace'), home: path.resolve('test-home'), spawn: launch, ...options,
  });
  const deliver = value => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  const reply = (result, request = sent.at(-1)) => deliver({ id: request.id, result });
  const start = async (capabilities = {}) => {
    const pending = client.start();
    reply({ protocolVersion: 1, agentCapabilities: capabilities });
    await pending;
  };
  const open = async () => { const pending = client.openSession(); reply({ sessionId: 'session-a' }); return pending; };
  return { child, client, sent, launch, deliver, reply, start, open };
}

describe('GrokBuildAcpClient', () => {
  afterEach(() => jest.useRealTimers());

  const policy = { serverName: 'lilly-task-tools', toolNames: ['artifact_write'] };
  const approval = (overrides = {}) => ({ sessionId: 'session-a', toolCall: { kind: 'other', title: 'lilly-task-tools__artifact_write',
    rawInput: { variant: 'UseTool', tool_name: 'lilly-task-tools__artifact_write', tool_input: { content: 'Fixture' } } },
    options: [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }], ...overrides });

  test('task policy approves exactly its MCP function once without calling a broad fallback', async () => {
    const fallback = jest.fn(async () => 'always'); const f = fixture({ permissionHandler: fallback });
    await f.start(); f.client.setTaskMcpPermissions(policy); await f.open();
    const pending = f.client.prompt('test'); const request = f.sent.at(-1);
    f.deliver({ id: 'permission', method: 'session/request_permission', params: approval() });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.sent.at(-1).result.outcome).toEqual({ outcome: 'selected', optionId: 'once' });
    expect(fallback).not.toHaveBeenCalled();
    f.reply({ stopReason: 'end_turn' }, request); await pending; f.client.close();
  });

  test.each(['other-server', 'other-tool', 'native-tool', 'spoofed-title', 'array-input', 'extra-input', 'wrong-session', 'always-only'])('task policy denies %s', async mode => {
    const f = fixture({ permissionHandler: async () => 'always' }); await f.start(); f.client.setTaskMcpPermissions(policy); await f.open();
    const params = approval();
    if (mode === 'other-server') params.toolCall.rawInput.tool_name = 'foreign__artifact_write';
    if (mode === 'other-tool') params.toolCall.rawInput.tool_name = 'lilly-task-tools__shell';
    if (mode === 'native-tool') params.toolCall.rawInput.variant = 'Bash';
    if (mode === 'spoofed-title') params.toolCall.title = 'Run shell';
    if (mode === 'array-input') params.toolCall.rawInput.tool_input = [];
    if (mode === 'extra-input') params.toolCall.rawInput.extra = 'authority';
    if (mode === 'wrong-session') params.sessionId = 'other';
    if (mode === 'always-only') params.options = [{ kind: 'allow_always', optionId: 'always' }];
    const pending = f.client.prompt('test'); const request = f.sent.at(-1);
    f.deliver({ id: 'permission', method: 'session/request_permission', params });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.sent.at(-1).result.outcome).toEqual({ outcome: 'cancelled' });
    f.reply({ stopReason: 'end_turn' }, request); await pending; f.client.close();
  });

  test('task permission binding cannot change after assignment or accept a malformed catalog', async () => {
    const f = fixture(); await f.start();
    for (const invalid of [{ ...policy, serverName: 'server__other' }, { ...policy, toolNames: [] },
      { ...policy, toolNames: ['artifact_write', 'artifact_write'] }, { ...policy, toolNames: ['../shell'] }]) {
      expect(() => f.client.setTaskMcpPermissions(invalid)).toThrow('invalid_task_mcp_permissions');
    }
    const names = ['artifact_write']; f.client.setTaskMcpPermissions({ ...policy, toolNames: names }); names.push('shell');
    expect(() => f.client.setTaskMcpPermissions(policy)).toThrow('invalid_task_mcp_permissions');
    await f.open();
    expect(() => f.client.setTaskMcpPermissions(policy)).toThrow('invalid_task_mcp_permissions');
    f.client.close(); expect(f.client.taskMcpPolicy).toBeNull();
  });

  test('cancellation before a task-policy decision prevents late approval', async () => {
    const f = fixture(); await f.start(); f.client.setTaskMcpPermissions(policy); await f.open();
    const pending = f.client.prompt('test'); const request = f.sent.at(-1);
    f.deliver({ id: 'permission', method: 'session/request_permission', params: approval() });
    f.client.cancel(); await new Promise(resolve => setImmediate(resolve));
    expect(f.sent.find(message => message.id === 'permission').result.outcome).toEqual({ outcome: 'cancelled' });
    f.reply({ stopReason: 'cancelled' }, request); await pending; f.client.close();
  });

  test('pinned source and safe spawn, no automatic provider keys or host auth home', async () => {
    const f = fixture({ env: { XAI_API_KEY: 'explicit-private-key', LILLY_MODEL_API_KEY: 'scoped-lilly-key', PATH: '/usr/bin' } });
    await f.start();
    expect(GROK_SOURCE_REVISION).toMatch(/^[a-f0-9]{40}$/);
    const [executable, args, config] = f.launch.mock.calls[0];
    expect(path.isAbsolute(executable)).toBe(true);
    expect(args).toEqual(['--no-auto-update', 'agent', 'stdio']);
    expect(config).toMatchObject({ shell: false, windowsHide: true, env: { HOME: path.resolve('test-home'), XAI_API_KEY: 'explicit-private-key' } });
    expect(config.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(config.env.LILLY_MODEL_API_KEY).toBe('scoped-lilly-key');
    expect(config.env.GROK_HOME).toBe(path.resolve('test-home', '.grok'));
    expect(f.sent[0].params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    f.client.close();
  });

  test('requires absolute binary/workspace/private home and rejects non-allowlisted environment', () => {
    expect(() => new GrokBuildAcpClient({ executable: 'grok' })).toThrow('invalid_executable');
    expect(() => fixture({ env: { NODE_OPTIONS: '--require=untrusted' } })).toThrow('invalid_environment');
    expect(() => fixture({ env: { GROK_HOME: '/host/credentials' } })).toThrow('invalid_environment');
    expect(() => fixture({ maxPending: Infinity })).toThrow('invalid_limit');
  });

  test('authenticates only an explicitly requested advertised method', async () => {
    const f = fixture();
    const pending = f.client.start({ authMethodId: 'xai.api_key' });
    f.reply({ protocolVersion: 1, authMethods: [{ id: 'xai.api_key' }] });
    await Promise.resolve();
    expect(f.sent.at(-1)).toMatchObject({ method: 'authenticate', params: { methodId: 'xai.api_key', _meta: { headless: true } } });
    f.reply({});
    await pending;
    f.client.close();
  });

  test('streams split UTF8 session updates, isolates foreign sessions, returns stop metadata', async () => {
    const f = fixture();
    const updates = [];
    f.client.on('update', update => updates.push(update));
    await f.start();
    await f.open();
    const pending = f.client.prompt('Build the assigned artifact.');
    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-a', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello 🌍' } } } })}\n`);
    const split = frame.indexOf(Buffer.from('🌍')) + 1;
    f.child.stdout.write(frame.subarray(0, split));
    f.child.stdout.write(frame.subarray(split));
    f.deliver({ method: 'session/update', params: { sessionId: 'foreign', update: {} } });
    f.reply({ stopReason: 'end_turn' });
    expect(await pending).toEqual({ stopReason: 'end_turn' });
    expect(updates).toHaveLength(1);
    expect(updates[0].update.content.text).toBe('hello 🌍');
    f.client.close();
  });

  test('resumes the same persisted session only when capability exists', async () => {
    const f = fixture();
    await f.start({ loadSession: true });
    const pending = f.client.openSession({ sessionId: 'old-session' });
    expect(f.sent.at(-1)).toMatchObject({ method: 'session/load', params: { sessionId: 'old-session', mcpServers: [] } });
    f.reply(null);
    expect(await pending).toEqual({ sessionId: 'old-session' });
    f.client.close();
    const other = fixture();
    await other.start();
    await expect(other.client.openSession({ sessionId: 'old-session' })).rejects.toThrow('session_load_unsupported');
    other.client.close();
  });

  test('requires advertised MCP transports and uses caller-supplied configs', async () => {
    const f = fixture();
    await f.start();
    await expect(f.client.openSession({ mcpServers: [{ type: 'http', name: 'lilly', url: 'https://lilly.test/mcp', headers: [] }] })).rejects.toThrow('unsupported_mcp_transport');
    const servers = [{ name: 'lilly', command: path.resolve('mcp-worker'), args: ['--stdio'], env: [] }];
    const pending = f.client.openSession({ mcpServers: servers });
    expect(f.sent.at(-1).params.mcpServers).toEqual(servers);
    f.reply({ sessionId: 'session-a' });
    await pending;
    f.client.close();
  });

  test('denies permission by default, refuses host terminal/fs requests', async () => {
    const f = fixture();
    await f.start();
    await f.open();
    const pending = f.client.prompt('test');
    const promptRequest = f.sent.at(-1);
    f.deliver({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'session-a', options: [{ optionId: 'yes', kind: 'allow_once' }] } });
    expect(f.sent.at(-1)).toMatchObject({ id: 'permission-1', result: { outcome: { outcome: 'cancelled' } } });
    f.deliver({ id: 'terminal-1', method: 'terminal/create', params: { command: 'unsafe' } });
    expect(f.sent.at(-1)).toMatchObject({ id: 'terminal-1', error: { code: -32601 } });
    f.reply({ stopReason: 'end_turn' }, promptRequest);
    await pending;
    f.client.close();
  });

  test('only accepts an offered permission ID from an explicit handler', async () => {
    const f = fixture({ permissionHandler: async () => 'allow' });
    await f.start();
    await f.open();
    const pending = f.client.prompt('test');
    const request = f.sent.at(-1);
    f.deliver({ id: 'p', method: 'session/request_permission', params: { sessionId: 'session-a', options: [{ optionId: 'allow', kind: 'allow_once' }] } });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.sent.at(-1).result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    f.reply({ stopReason: 'end_turn' }, request);
    await pending;
    f.client.close();
  });

  test('cancel is a notification, cancels pending approval and prevents late grant', async () => {
    let approve;
    const handler = jest.fn(() => new Promise(resolve => { approve = resolve; }));
    const f = fixture({ permissionHandler: handler });
    await f.start();
    await f.open();
    const pending = f.client.prompt('test');
    const request = f.sent.at(-1);
    f.deliver({ id: 'p', method: 'session/request_permission', params: { sessionId: 'session-a', options: [{ optionId: 'allow' }] } });
    await Promise.resolve();
    expect(f.client.cancel()).toBe(true);
    expect(f.sent.at(-1)).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-a' } });
    expect(f.sent.at(-2).result.outcome.outcome).toBe('cancelled');
    approve('allow');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.sent.filter(message => message.id === 'p')).toHaveLength(1);
    expect(handler.mock.calls[0][1].signal.aborted).toBe(true);
    f.reply({ stopReason: 'cancelled' }, request);
    expect(await pending).toEqual({ stopReason: 'cancelled' });
    f.client.close();
  });

  test('does not overlap prompts in one worker session', async () => {
    const f = fixture();
    await f.start(); await f.open();
    const pending = f.client.prompt('one');
    await expect(f.client.prompt('two')).rejects.toThrow('session_busy_or_unavailable');
    f.reply({ stopReason: 'end_turn' }); await pending; f.client.close();
  });

  test('timeout rejects pending and terminates with bounded force-kill fallback', async () => {
    jest.useFakeTimers();
    const f = fixture({ requestTimeoutMs: 10, killGraceMs: 20 });
    const pending = f.client.start();
    const checked = expect(pending).rejects.toThrow('request_timeout');
    jest.advanceTimersByTime(10);
    await checked;
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
    jest.advanceTimersByTime(20);
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('process exit rejects active prompt and is not reported as completion', async () => {
    const f = fixture();
    await f.start(); await f.open();
    const pending = f.client.prompt('test');
    f.child.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('process_exit');
    expect(f.client.pending.size).toBe(0);
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  test.each(['invalid_json', 'inbound_frame_limit'])('rejects %s without exposing frame content', async reason => {
    const f = fixture({ maxFrameBytes: 512 });
    const pending = f.client.start();
    f.child.stdout.write(reason === 'invalid_json' ? 'private-secret is not JSON\n' : 'x'.repeat(513));
    await expect(pending).rejects.toThrow(reason);
    expect(f.client.buffer.length).toBe(0);
  });

  test('bounds total turn updates and outbound frames', async () => {
    const f = fixture({ maxTurnBytes: 1 });
    await f.start(); await f.open();
    const pending = f.client.prompt('test');
    f.deliver({ method: 'session/update', params: { sessionId: 'session-a', update: {} } });
    await expect(pending).rejects.toThrow('turn_output_limit');
    const other = fixture({ maxFrameBytes: 512 });
    await other.start(); await other.open();
    await expect(other.client.prompt('a'.repeat(600))).rejects.toThrow('outbound_frame_limit');
    expect(other.client.pending.size).toBe(0); other.client.close();
  });

  test('does not leak raw provider errors or stderr', async () => {
    const f = fixture();
    const lifecycle = [];
    f.client.on('lifecycle', value => lifecycle.push(value));
    await f.start(); await f.open();
    const pending = f.client.prompt('test');
    f.child.stderr.write('XAI_API_KEY=private-secret');
    f.deliver({ id: f.sent.at(-1).id, error: { code: -32603, message: 'missing field `sequence_number` private-secret' } });
    await expect(pending).rejects.toMatchObject({ code: 'rpc_error', diagnostic: {
      method: 'session/prompt', rpcCode: -32603, hints: ['schema'], missingFields: ['sequence_number'],
    } });
    expect(JSON.stringify(lifecycle)).not.toContain('private-secret');
    expect(f.client.stderrBytes).toBeGreaterThan(0); f.client.close();
  });

  test('sanitizes startup errors and rejects arbitrary completion strings', async () => {
    const broken = fixture({ spawn: () => { throw new Error('private-key-in-upstream-error'); } });
    await expect(broken.client.start()).rejects.toThrow('startup_failed');
    const f = fixture();
    const events = [];
    f.client.on('lifecycle', event => events.push(event));
    await f.start(); await f.open();
    const pending = f.client.prompt('test');
    f.reply({ stopReason: 'private-key-in-upstream-error' });
    await expect(pending).rejects.toThrow('invalid_stop_reason');
    expect(events.some(event => event.state === 'turn_finished')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('private-key');
  });

  test('permission handler timeout denies without hanging the prompt', async () => {
    jest.useFakeTimers();
    const f = fixture({ permissionTimeoutMs: 5, permissionHandler: () => new Promise(() => {}) });
    await f.start(); await f.open();
    const pending = f.client.prompt('test');
    const request = f.sent.at(-1);
    f.deliver({ id: 'p', method: 'session/request_permission', params: { sessionId: 'session-a', options: [{ optionId: 'allow' }] } });
    jest.advanceTimersByTime(5);
    expect(f.sent.at(-1)).toMatchObject({ id: 'p', result: { outcome: { outcome: 'cancelled' } } });
    expect(f.client.permissions.size).toBe(0);
    f.reply({ stopReason: 'end_turn' }, request);
    await pending; f.client.close();
  });
});

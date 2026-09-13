const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { rpcDiagnostic } = require('./rpc-diagnostic');

const GROK_SOURCE_REVISION = '72a61251fcffb464bcc687aeb5a998e5a98ec0c9';
const ENV_ALLOWLIST = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'XAI_API_KEY', 'LILLY_MODEL_API_KEY']);
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

function fault(code) {
  return Object.assign(new Error(`Grok ACP: ${code}`), { code });
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fault(`invalid_${label}`);
  return value;
}

function limit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw fault('invalid_limit');
  return value;
}

// Transport only: the caller owns isolation, authorization, persistence and event redaction.
// In particular, declining ACP permissions is NOT a sandbox for Grok's built-in tools.
class GrokBuildAcpClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.executable = absolute(options.executable, 'executable');
    this.cwd = absolute(options.cwd, 'cwd');
    this.home = absolute(options.home, 'home');
    this.spawn = options.spawn || spawn;
    this.permissionHandler = options.permissionHandler;
    this.requestTimeoutMs = limit(options.requestTimeoutMs, 30000, 3600000);
    this.promptTimeoutMs = limit(options.promptTimeoutMs, 300000, 3600000);
    this.permissionTimeoutMs = limit(options.permissionTimeoutMs, 30000, 300000);
    this.killGraceMs = limit(options.killGraceMs, 2000, 30000);
    this.maxFrameBytes = limit(options.maxFrameBytes, 1024 * 1024, 16 * 1024 * 1024);
    this.maxTurnBytes = limit(options.maxTurnBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
    this.maxPending = limit(options.maxPending, 16, 128);
    // No automatic inheritance of provider keys, proxy settings or the host login home.
    this.env = {};
    for (const [name, value] of Object.entries(options.env || {})) {
      if (!ENV_ALLOWLIST.has(name) || typeof value !== 'string' || value.includes('\0')) throw fault('invalid_environment');
      this.env[name] = value;
    }
    this.env.HOME = this.home;
    this.env.GROK_HOME = path.join(this.home, '.grok');
    this.env.USERPROFILE = this.home;
    this.env.XDG_CONFIG_HOME = path.join(this.home, '.config');
    this.env.XDG_DATA_HOME = path.join(this.home, '.local', 'share');
    this.env.XDG_CACHE_HOME = path.join(this.home, '.cache');
    this.pending = new Map();
    this.permissions = new Map();
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.state = 'new';
    this.sessionId = null;
    this.turnActive = false;
    this.turnBytes = 0;
    this.stderrBytes = 0;
  }

  async start({ authMethodId } = {}) {
    if (this.state !== 'new') throw fault('already_started');
    this.state = 'starting';
    try {
      this.child = this.spawn(this.executable, ['--no-auto-update', 'agent', 'stdio'], {
        cwd: this.cwd, env: this.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child.on('error', () => this._fail('process_error'));
      this.child.on('exit', (code, signal) => {
        this.exited = true;
        clearTimeout(this.killTimer);
        this._fail('process_exit', false);
        this.emit('exit', { code, signal });
      });
      this.child.stdout.on('data', chunk => this._receive(chunk));
      this.child.stdout.on('error', () => this._fail('stdout_error'));
      this.child.stdout.on('end', () => this._fail('stdout_closed'));
      this.child.stdin.on('error', () => this._fail('stdin_error'));
      this.child.stderr.on('error', () => this._fail('stderr_error'));
      // Deliberately discard stderr: upstream diagnostics can contain credentials/prompts.
      this.child.stderr.on('data', chunk => { this.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrBytes + chunk.length); });
      const init = await this._request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'lilly-grok-worker', version: '1.0.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      if (init.protocolVersion !== 1) throw fault('unsupported_protocol');
      this.capabilities = init.agentCapabilities || {};
      if (authMethodId) {
        if (!Array.isArray(init.authMethods) || !init.authMethods.some(method => method.id === authMethodId)) throw fault('unsupported_auth_method');
        await this._request('authenticate', { methodId: authMethodId, _meta: { headless: true } });
      }
      this.state = 'ready';
      this.emit('lifecycle', { state: this.state });
      return init;
    } catch (error) {
      this._fail('startup_failed');
      throw error.message?.startsWith('Grok ACP: ') ? error : fault('startup_failed');
    }
  }

  _mcpServers(servers) {
    if (!Array.isArray(servers) || servers.length > 16) throw fault('invalid_mcp_servers');
    for (const server of servers) {
      if (!server || typeof server.name !== 'string' || !server.name) throw fault('invalid_mcp_server');
      if (server.type === 'http' || server.type === 'sse') {
        if (!this.capabilities.mcpCapabilities?.[server.type]) throw fault('unsupported_mcp_transport');
        let url;
        try { url = new URL(server.url); } catch { throw fault('invalid_mcp_url'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fault('invalid_mcp_url');
        if (!Array.isArray(server.headers)) throw fault('invalid_mcp_headers');
      } else {
        if (server.type && server.type !== 'stdio') throw fault('unsupported_mcp_transport');
        absolute(server.command, 'mcp_command');
        if (!Array.isArray(server.args) || !server.args.every(arg => typeof arg === 'string') || !Array.isArray(server.env)) throw fault('invalid_mcp_server');
      }
    }
    // Caller must supply a trusted, project-scoped allowlist, never model-generated configs.
    return servers;
  }

  setTaskMcpPermissions({ serverName, toolNames } = {}) {
    if (this.state !== 'ready' || this.sessionId || this.turnActive || this.taskMcpPolicy
      || typeof serverName !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(serverName)
      || !Array.isArray(toolNames) || toolNames.length < 1 || toolNames.length > 64
      || toolNames.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(name))
      || new Set(toolNames).size !== toolNames.length) throw fault('invalid_task_mcp_permissions');
    const allowed = new Set(toolNames.map(name => `${serverName}__${name}`));
    // Bound by the trusted task coordinator, not by a model request. This
    // authorizes only the engine's MCP dispatch step. The actual Lilly tool
    // dispatcher independently checks the current claim, schema and permissions.
    // Never approve shell/filesystem requests or persist an allow-always choice.
    this.taskMcpPolicy = params => {
      const call = params.toolCall; const input = call?.rawInput;
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 3 || input.variant !== 'UseTool'
        || !Object.hasOwn(input, 'tool_name') || !Object.hasOwn(input, 'tool_input')
        || !allowed.has(input.tool_name) || call.title !== input.tool_name || call.kind !== 'other'
        || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) return undefined;
      return params.options?.find(option => option.kind === 'allow_once')?.optionId;
    };
  }

  async openSession({ sessionId, mcpServers = [] } = {}) {
    if (this.state !== 'ready' || this.sessionId) throw fault('session_not_available');
    if (sessionId && !this.capabilities.loadSession) throw fault('session_load_unsupported');
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256)) throw fault('invalid_session');
    const params = { cwd: this.cwd, mcpServers: this._mcpServers(mcpServers) };
    if (sessionId) params.sessionId = sessionId;
    this.state = 'opening';
    // load replays updates before its response; bind to the requested session first.
    this.sessionId = sessionId || null;
    try {
      const result = await this._request(sessionId ? 'session/load' : 'session/new', params);
      const resolved = sessionId || result.sessionId;
      if (typeof resolved !== 'string' || !resolved || resolved.length > 256) throw fault('invalid_session_response');
      this.sessionId = resolved;
      this.state = 'ready';
      this.emit('lifecycle', { state: 'session_ready', sessionId: resolved, resumed: Boolean(sessionId) });
      return { ...result, sessionId: resolved };
    } catch (error) {
      this._fail('session_open_failed');
      throw error;
    }
  }

  async prompt(text) {
    if (this.state !== 'ready' || !this.sessionId || this.turnActive) throw fault('session_busy_or_unavailable');
    if (typeof text !== 'string' || !text.trim()) throw fault('invalid_prompt');
    this.turnActive = true;
    this.turnBytes = 0;
    try {
      const result = await this._request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, this.promptTimeoutMs);
      if (!STOP_REASONS.has(result.stopReason)) {
        this._fail('invalid_stop_reason');
        throw fault('invalid_stop_reason');
      }
      this.emit('lifecycle', { state: 'turn_finished', sessionId: this.sessionId, stopReason: result.stopReason });
      return result;
    } finally {
      this.turnActive = false;
      this._cancelPermissions();
    }
  }

  cancel() {
    if (!this.turnActive || this.state === 'closed') return false;
    this._cancelPermissions();
    this._write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    this.emit('lifecycle', { state: 'cancellation_requested', sessionId: this.sessionId });
    // Cancellation is only confirmed by session/prompt's eventual response, never this notification.
    return true;
  }

  close() { this._fail('client_closed'); }

  _write(message) {
    const wire = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(wire) > this.maxFrameBytes) throw fault('outbound_frame_limit');
    if (!this.child || this.state === 'closed' || this.child.stdin.destroyed) throw fault('transport_closed');
    if (this.child.stdin.writableLength > this.maxFrameBytes) throw fault('outbound_backpressure_limit');
    this.child.stdin.write(wire);
  }

  _request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.pending.size >= this.maxPending) return Promise.reject(fault('pending_limit'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail('request_timeout'), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this._write({ jsonrpc: '2.0', id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _receive(chunk) {
    if (this.state === 'closed') return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let cursor = 0; cursor < bytes.length; cursor += 1) {
      if (bytes[cursor] !== 10) continue;
      const piece = bytes.subarray(start, cursor);
      if (this.buffer.length + piece.length > this.maxFrameBytes) return this._fail('inbound_frame_limit');
      const line = Buffer.concat([this.buffer, piece]);
      this.buffer = Buffer.alloc(0);
      if (line.length) this._message(line);
      if (this.state === 'closed') return;
      start = cursor + 1;
    }
    const rest = bytes.subarray(start);
    if (this.buffer.length + rest.length > this.maxFrameBytes) return this._fail('inbound_frame_limit');
    this.buffer = Buffer.concat([this.buffer, rest]);
  }

  _message(line) {
    let message;
    try { message = JSON.parse(line.toString('utf8')); } catch { return this._fail('invalid_json'); }
    if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) return this._fail('invalid_message');
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (typeof message.id !== 'number' && typeof message.id !== 'string') return this._fail('invalid_request_id');
        if (message.method === 'session/request_permission') return this._permission(message);
        try { this._write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method not supported' } }); } catch { this._fail('response_write_failed'); }
      } else if (message.method === 'session/update' && message.params?.sessionId === this.sessionId) {
        this.turnBytes += line.length;
        if (this.turnBytes > this.maxTurnBytes) return this._fail('turn_output_limit');
        // Private transport event, never safe to publish wholesale into an operator UI.
        this.emit('update', message.params);
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(Object.assign(fault('rpc_error'), {
      diagnostic: rpcDiagnostic(message.error, entry.method),
    }));
    else if (Object.hasOwn(message, 'result')) entry.resolve(message.result ?? {});
    else entry.reject(fault('invalid_response'));
  }

  _permission(message) {
    if (this.permissions.has(message.id) || this.permissions.size >= this.maxPending) return this._fail('permission_limit');
    const params = message.params || {};
    const controller = new AbortController();
    const finish = optionId => {
      const entry = this.permissions.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.permissions.delete(message.id);
      controller.abort();
      const valid = !entry.cancelled && typeof optionId === 'string' && Array.isArray(params.options)
        && params.options.some(option => option.optionId === optionId);
      try {
        this._write({ jsonrpc: '2.0', id: message.id, result: { outcome: valid ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
      } catch { this._fail('response_write_failed'); }
    };
    const entry = { finish, controller, cancelled: false, timer: setTimeout(() => finish(), this.permissionTimeoutMs) };
    this.permissions.set(message.id, entry);
    const handler = this.taskMcpPolicy || this.permissionHandler;
    if (!this.turnActive || params.sessionId !== this.sessionId || typeof handler !== 'function') return finish();
    Promise.resolve().then(() => handler(params, { signal: controller.signal })).then(finish, () => finish());
  }

  _cancelPermissions() {
    for (const entry of this.permissions.values()) { entry.cancelled = true; entry.finish(); }
  }

  _fail(code, kill = true) {
    if (this.state === 'closed' || this.closing) return;
    this.closing = true;
    this._cancelPermissions();
    this.taskMcpPolicy = null;
    this.state = 'closed';
    this.buffer = Buffer.alloc(0);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(fault(code)); }
    this.pending.clear();
    if (kill && this.child && !this.exited) {
      try { this.child.kill('SIGTERM'); } catch { /* Exit observation remains authoritative. */ }
      this.killTimer = setTimeout(() => {
        if (!this.exited) { try { this.child.kill('SIGKILL'); } catch { /* Runtime supervisor must reap the worker. */ } }
      }, this.killGraceMs);
      this.killTimer.unref?.();
    }
    this.emit('lifecycle', { state: 'closed', reason: code });
  }
}

module.exports = { GrokBuildAcpClient, GROK_SOURCE_REVISION };

const { renderPromptTemplate } = require('./prompt-renderer');

const TERMINAL_EVENTS = new Set([
  'turn_completed',
  'turn_failed',
  'turn_cancelled',
  'turn_input_required',
]);

function sanitizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildAuthHeaders(apiKey = '') {
  const key = String(apiKey || '').trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function mapCodexConfig(serviceConfig = {}) {
  const codex = serviceConfig.codex || {};
  return {
    approvalPolicy: codex.approval_policy || undefined,
    threadSandbox: codex.thread_sandbox || undefined,
    turnSandboxPolicy: codex.turn_sandbox_policy || undefined,
    turnTimeoutMs: codex.turn_timeout_ms,
    stallTimeoutMs: codex.stall_timeout_ms,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    error.responseText = text;
    throw error;
  }
}

function normalizeGatewayEvent(eventName = '', payload = {}) {
  return {
    event: payload.event || eventName || 'other_message',
    timestamp: payload.timestamp || new Date().toISOString(),
    thread_id: payload.thread_id || payload.threadId || null,
    turn_id: payload.turn_id || payload.turnId || null,
    session_id: payload.session_id || payload.sessionId || null,
    codex_app_server_pid: payload.codex_app_server_pid || payload.codexAppServerPid || null,
    usage: payload.usage
      || payload.tokenUsage
      || payload.token_usage
      || payload.total_token_usage
      || payload.totalTokenUsage
      || null,
    rate_limits: payload.rate_limits || payload.rateLimits || null,
    message: payload.message || payload.error || null,
    payload,
  };
}

function parseSseChunk(buffer = '', onEvent = () => {}) {
  const messages = buffer.split(/\r?\n\r?\n/);
  const remainder = messages.pop() || '';
  for (const message of messages) {
    let eventName = '';
    const dataLines = [];
    for (const line of message.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    const rawData = dataLines.join('\n');
    let payload = {};
    try {
      payload = JSON.parse(rawData);
    } catch (_error) {
      payload = { message: rawData };
    }
    onEvent(normalizeGatewayEvent(eventName, payload));
  }
  return remainder;
}

async function consumeSseResponse(response, {
  onEvent = () => {},
  signal = null,
} = {}) {
  if (!response.body) {
    throw new Error('codex_gateway_events_missing_body');
  }

  if (typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      if (signal?.aborted) {
        throw new Error('codex_gateway_run_aborted');
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseChunk(buffer, onEvent);
    }
    if (buffer.trim()) {
      parseSseChunk(`${buffer}\n\n`, onEvent);
    }
    return;
  }

  if (typeof response.text === 'function') {
    parseSseChunk(await response.text(), onEvent);
    return;
  }

  throw new Error('codex_gateway_events_unreadable_body');
}

class CodexGatewayRunner {
  constructor({
    baseUrl,
    apiKey = '',
    fetchImpl = global.fetch,
    logger = console,
  } = {}) {
    if (!sanitizeBaseUrl(baseUrl)) {
      throw new Error('CodexGatewayRunner requires baseUrl');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('CodexGatewayRunner requires fetch');
    }
    this.baseUrl = sanitizeBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async run({
    issue,
    attempt = null,
    workflow = {},
    serviceConfig = {},
    workspace = {},
    signal = null,
    onEvent = () => {},
  } = {}) {
    const prompt = renderPromptTemplate(workflow.prompt_template, { issue, attempt });
    const start = await this.startRun({
      issue,
      attempt,
      prompt,
      serviceConfig,
      workspace,
    });
    const startEvent = normalizeGatewayEvent('session_started', {
      event: 'session_started',
      timestamp: new Date().toISOString(),
      runId: start.runId,
      threadId: start.threadId,
      turnId: start.turnId,
      sessionId: start.sessionId,
    });
    onEvent(startEvent);

    const abortHandler = () => {
      this.cancelRun(start.runId).catch((error) => {
        this.logger.warn?.(`[Symphony] codex_gateway_cancel_failed run_id=${start.runId} error=${error.message}`);
      });
    };
    if (signal) {
      if (signal.aborted) {
        await this.cancelRun(start.runId);
        throw new Error('codex_gateway_run_aborted');
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    let terminalEvent = null;
    try {
      await this.streamEvents(start.runId, {
        signal,
        onEvent: (event) => {
          onEvent(event);
          if (TERMINAL_EVENTS.has(event.event)) {
            terminalEvent = event;
          }
        },
      });
    } finally {
      signal?.removeEventListener?.('abort', abortHandler);
    }

    if (!terminalEvent) {
      throw new Error('codex_gateway_missing_terminal_event');
    }
    if (terminalEvent.event !== 'turn_completed') {
      const error = new Error(terminalEvent.message || terminalEvent.event);
      error.code = terminalEvent.event;
      error.event = terminalEvent;
      throw error;
    }

    return {
      ok: true,
      runId: start.runId,
      threadId: start.threadId,
      turnId: start.turnId,
      sessionId: start.sessionId,
      terminalEvent,
    };
  }

  async startRun({
    issue,
    attempt = null,
    prompt = '',
    serviceConfig = {},
    workspace = {},
  } = {}) {
    const response = await this.fetch(`${this.baseUrl}/api/codex-agent/run`, {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(this.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspacePath: workspace.workspace_path || workspace.path,
        issue,
        prompt,
        attempt,
        continuation: attempt != null,
        config: mapCodexConfig(serviceConfig),
      }),
    });
    const body = await readJsonResponse(response);
    if (!response.ok || body?.ok === false) {
      const error = new Error(body?.error || body?.message || `codex_gateway_status_${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    if (!body?.runId) {
      throw new Error('codex_gateway_missing_run_id');
    }
    return body;
  }

  async streamEvents(runId = '', options = {}) {
    const response = await this.fetch(`${this.baseUrl}/api/codex-agent/runs/${encodeURIComponent(runId)}/events`, {
      method: 'GET',
      headers: {
        ...buildAuthHeaders(this.apiKey),
        Accept: 'text/event-stream',
      },
      signal: options.signal || undefined,
    });
    if (!response.ok) {
      throw new Error(`codex_gateway_events_status_${response.status}`);
    }
    await consumeSseResponse(response, options);
  }

  async cancelRun(runId = '') {
    if (!runId) {
      return null;
    }
    const response = await this.fetch(`${this.baseUrl}/api/codex-agent/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(this.apiKey),
        'Content-Type': 'application/json',
      },
    });
    const body = await readJsonResponse(response);
    if (!response.ok || body?.ok === false) {
      const error = new Error(body?.error || body?.message || `codex_gateway_cancel_status_${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }
}

function createCodexGatewayAgentRunner(options = {}) {
  const runner = new CodexGatewayRunner(options);
  return (params) => runner.run(params);
}

module.exports = {
  CodexGatewayRunner,
  TERMINAL_EVENTS,
  consumeSseResponse,
  createCodexGatewayAgentRunner,
  normalizeGatewayEvent,
  parseSseChunk,
};

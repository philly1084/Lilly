const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadApiClient(fetchMock = jest.fn()) {
  const source = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const window = {
    location: {
      hostname: 'localhost', protocol: 'http:', host: 'localhost:3000', port: '3000',
      href: 'http://localhost:3000/web-chat/app.html',
    },
    KimiBuiltGatewaySSE: null,
    KimiBuiltWebChatWorkspace: null,
    sessionManager: null,
  };
  window.window = window;
  const context = {
    window, fetch: fetchMock, console, EventTarget, URL, URLSearchParams, Intl, Date,
    setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'api.js' });
  return context.window.apiClient;
}

describe('Web Chat AgentRun adapter', () => {
  test('creates a run with idempotency and normalizes its typed UI state', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        run: {
          version: 'AgentRun/v1',
          id: 'run-1',
          session_id: 'session-1',
          objective: 'Ship a demo',
          state: 'executing',
          event_cursor: '3',
        },
        events: [{ event_id: 'event-1', run_id: 'run-1', type: 'step', status: 'completed' }],
      }),
    }));
    const client = loadApiClient(fetchMock);

    const result = await client.createAgentRun({ objective: 'Ship a demo', idempotencyKey: 'create-1' });

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/agent-runs', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: expect.objectContaining({ 'x-idempotency-key': 'create-1' }),
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expect.objectContaining({ objective: 'Ship a demo' }));
    expect(result).toEqual(expect.objectContaining({ uiState: 'streaming', eventCursor: '3' }));
    expect(result.run).toEqual(expect.objectContaining({ id: 'run-1', sessionId: 'session-1', state: 'executing' }));
    expect(result.events[0]).toEqual(expect.objectContaining({ eventId: 'event-1', runId: 'run-1' }));
  });

  test('polls events by cursor and maps replay to retry-step', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ run: { id: 'run 1', state: 'verifying' }, events: [] }),
    }));
    const client = loadApiClient(fetchMock);

    await client.getAgentRunEvents('run 1', { after: 'cursor 9' });
    await client.postAgentRunAction('run 1', 'replay', { stepId: 'verify' });

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/api/agent-runs/run%201/events?after=cursor+9');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:3000/api/agent-runs/run%201/actions');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ stepId: 'verify', action: 'retry-step' });
  });

  test('returns an explicit error state instead of inventing run success', async () => {
    const client = loadApiClient(jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'Run store unavailable' } }),
    })));

    const result = await client.getAgentRun('run-2');

    expect(result.uiState).toBe('error');
    expect(result.run).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({ status: 503, message: 'Run store unavailable' }));
  });
});

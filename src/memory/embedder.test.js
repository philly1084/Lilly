jest.mock('../config', () => ({
  config: { ollama: { baseURL: 'http://ollama.test', embedModel: 'test-model', embedTimeoutMs: 1000 } },
}));

const { Embedder } = require('./embedder');

describe('embedding request deadline', () => {
  const originalFetch = global.fetch;
  let embedder;

  beforeEach(() => {
    jest.useFakeTimers();
    embedder = new Embedder();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  test.each([true, false])('aborts a stalled %s response body at the request deadline', async (ok) => {
    let requestSignal;
    let bodyStarted = false;
    global.fetch.mockImplementation(async (_url, { signal }) => {
      requestSignal = signal;
      const readBody = () => {
        bodyStarted = true;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      };
      return { ok, status: ok ? 200 : 503, json: readBody, text: readBody };
    });
    const outcome = embedder.embed('Recall my project').catch((error) => error);

    await jest.advanceTimersByTimeAsync(999);
    expect(bodyStarted).toBe(true);
    expect(requestSignal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(requestSignal.aborted).toBe(true);
    expect((await outcome).name).toBe('AbortError');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('preserves successful embeddings and releases the deadline', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) });
    await expect(embedder.embed('project')).resolves.toEqual([0.1, 0.2]);
    expect(global.fetch).toHaveBeenCalledWith('http://ollama.test/api/embeddings', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ model: 'test-model', prompt: 'project' }),
    }));
    expect(jest.getTimerCount()).toBe(0);
  });

  test('preserves HTTP error details and releases the deadline', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'model unavailable' });
    await expect(embedder.embed('project')).rejects.toThrow('Ollama embedding failed (503): model unavailable');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('releases the deadline when JSON parsing fails', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } });
    await expect(embedder.embed('project')).rejects.toThrow('Invalid JSON');
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(['sync', 'async'])('releases the deadline after a %s fetch failure', async (mode) => {
    global.fetch.mockImplementation(() => {
      if (mode === 'sync') throw new Error('Network failed');
      return Promise.reject(new Error('Network failed'));
    });
    await expect(embedder.embed('project')).rejects.toThrow('Network failed');
    expect(jest.getTimerCount()).toBe(0);
  });
});

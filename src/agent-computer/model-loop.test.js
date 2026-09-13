const { runAgentComputerModelLoop } = require('./model-loop');

const tools = [{ type: 'function', name: 'computer', description: 'Private browser', parameters: { type: 'object' } }];
const call = (id, args = '{"action":"observe"}', name = 'computer') => ({ type: 'function_call', call_id: id, name, arguments: args });
const message = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const frame = (text) => [{ type: 'input_text', text: 'Private title and query' }, { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(text).toString('base64')}` }];

describe('runAgentComputerModelLoop', () => {
  function setup(options = {}) {
    const respond = jest.fn(async () => ({ output: [message('Reported result; verification is separate.')] }));
    const dispatch = jest.fn(async () => ({ publicResult: { ok: true } }));
    const onEvent = jest.fn();
    return { respond, dispatch, onEvent, options: { tools, respond, dispatch, onEvent, ...options } };
  }

  test('delivers real private image content to next model round with matching call output', async () => {
    const test = setup();
    test.respond.mockResolvedValueOnce({ output: [call('call-1')] });
    test.dispatch.mockResolvedValueOnce({ publicResult: { frameId: 'frame-1' }, privateModelContent: frame('image-one') });
    const result = await runAgentComputerModelLoop(test.options);
    const input = test.respond.mock.calls[1][0].input;
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: '{"frameId":"frame-1"}' });
    expect(input.at(-1).content[1]).toMatchObject({ type: 'input_image', image_url: frame('image-one')[1].image_url });
    expect(result).toEqual({ summary: 'Reported result; verification is separate.', calls: [{ tool: 'computer', callId: 'call-1', status: 'succeeded' }] });
    expect(result).not.toHaveProperty('completed');
  });

  test('keeps only the newest screenshot and replays reasoning with function-call pairing', async () => {
    const test = setup();
    const reasoning = { type: 'reasoning', id: 'reasoning-1', summary: [], encrypted_content: 'provider-private-context' };
    test.respond.mockResolvedValueOnce({ output: [reasoning, call('call-1')] }).mockResolvedValueOnce({ output: [call('call-2')] });
    test.dispatch.mockResolvedValueOnce({ publicResult: { ok: true }, privateModelContent: frame('old') }).mockResolvedValueOnce({ publicResult: { ok: true }, privateModelContent: frame('new') });
    await runAgentComputerModelLoop(test.options);
    const input = test.respond.mock.calls[2][0].input;
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain(frame('old')[1].image_url);
    expect(serialized).toContain(frame('new')[1].image_url);
    expect(input).toContainEqual(reasoning);
    expect(input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id)).toEqual(['call-1', 'call-2']);
  });

  test('tool events expose only allowed summaries, never arguments, pixels, outputs, or model text', async () => {
    const test = setup({ instructions: 'private instruction' });
    test.respond.mockResolvedValueOnce({ output: [call('call-1', '{"secret":"credential-value"}')] });
    test.dispatch.mockResolvedValueOnce({ publicResult: { detail: 'private tool output' }, privateModelContent: frame('private pixels') });
    await runAgentComputerModelLoop(test.options);
    for (const [event] of test.onEvent.mock.calls) {
      expect(Object.keys(event).every((key) => ['type', 'tool', 'callId'].includes(key))).toBe(true);
    }
    const projected = JSON.stringify(test.onEvent.mock.calls);
    for (const secret of ['credential-value', 'private tool output', 'private instruction', 'data:image', 'Reported result', 'Private title']) expect(projected).not.toContain(secret);
  });

  test('dispatches several tool calls strictly sequentially with exact ids', async () => {
    const test = setup();
    let running = false;
    test.respond.mockResolvedValueOnce({ output: [call('one'), call('two')] });
    test.dispatch.mockImplementation(async (_, args, context) => {
      expect(running).toBe(false);
      running = true;
      await new Promise((resolve) => setImmediate(resolve));
      running = false;
      return { publicResult: { id: context.callId } };
    });
    await runAgentComputerModelLoop(test.options);
    expect(test.dispatch.mock.calls.map((args) => args[2].callId)).toEqual(['one', 'two']);
  });

  test('failed tool gets a bounded non-sensitive output and no automatic retry or stale frame', async () => {
    const test = setup();
    test.respond.mockResolvedValueOnce({ output: [call('one')] }).mockResolvedValueOnce({ output: [call('two')] });
    test.dispatch.mockResolvedValueOnce({ publicResult: { ok: true }, privateModelContent: frame('old') }).mockRejectedValueOnce(new Error('credential=SECRET failed after clicking'));
    const result = await runAgentComputerModelLoop(test.options);
    expect(test.dispatch).toHaveBeenCalledTimes(2);
    expect(result.calls[1].status).toBe('failed');
    const finalInput = test.respond.mock.calls[2][0].input;
    expect(JSON.stringify(finalInput)).not.toContain('SECRET');
    expect(JSON.stringify(finalInput)).not.toContain('data:image');
    expect(finalInput.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'two' });
    expect(JSON.parse(finalInput.at(-1).output)).toMatchObject({ success: false, error: { code: 'tool_failed' } });
  });

  test.each([
    [call('one', '{}', 'unknown'), 'computer_loop_unknown_tool'],
    [call('one', 'not JSON'), 'computer_loop_invalid_arguments'],
    [call('one', '[]'), 'computer_loop_invalid_arguments'],
    [call('one', '{"__proto__":{"bad":true}}'), 'computer_loop_invalid_arguments'],
    [call('invalid call id'), 'computer_loop_invalid_call_id'],
    [{ type: 'unknown' }, 'computer_loop_invalid_response'],
  ])('rejects invalid model call/output before dispatch', async (output, code) => {
    const test = setup();
    test.respond.mockResolvedValue({ output: [output] });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code });
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  test('validates the full round before any tool executes and rejects duplicate ids', async () => {
    const test = setup();
    test.respond.mockResolvedValue({ output: [call('one'), call('one')] });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_invalid_call_id' });
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  test('denies a whole round that exceeds remaining call budget', async () => {
    const test = setup({ maxCalls: 1 });
    test.respond.mockResolvedValue({ output: [call('one'), call('two')] });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_call_limit' });
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  test('stops at round budget instead of treating executed tools as task completion', async () => {
    const test = setup({ maxRounds: 1 });
    test.respond.mockResolvedValue({ output: [call('one')] });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_round_limit' });
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.respond).toHaveBeenCalledTimes(1);
  });

  test('aborts an unresponsive model at deadline and propagates abort signal', async () => {
    const test = setup({ maxTimeMs: 20 });
    test.respond.mockImplementation(() => new Promise(() => {}));
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_timeout' });
    expect(test.respond.mock.calls[0][0].signal.aborted).toBe(true);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  test('external cancellation stops an in-flight tool without retry or later response', async () => {
    const abort = new AbortController();
    const test = setup({ signal: abort.signal });
    test.respond.mockResolvedValue({ output: [call('one')] });
    test.dispatch.mockImplementation(async (_, __, context) => {
      abort.abort();
      expect(context.signal.aborted).toBe(true);
      return new Promise(() => {});
    });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_aborted' });
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.respond).toHaveBeenCalledTimes(1);
  });

  test('already-aborted request never starts a model or tool', async () => {
    const abort = new AbortController();
    abort.abort();
    const test = setup({ signal: abort.signal });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_aborted' });
    expect(test.respond).not.toHaveBeenCalled();
  });

  test('rejects private image bytes in public output and malformed private frame contracts', async () => {
    const test = setup();
    test.respond.mockResolvedValue({ output: [call('one')] });
    test.dispatch.mockResolvedValue({ publicResult: { image: Buffer.from('pixel') } });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_private_output' });
    test.dispatch.mockResolvedValue({ publicResult: {}, privateModelContent: [{ type: 'input_image', image_url: 'https://private.example/image' }] });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_invalid_private_content' });
  });

  test('telemetry exceptions cannot cause tool retry', async () => {
    const test = setup({ onEvent: () => { throw new Error('telemetry offline'); } });
    test.respond.mockResolvedValueOnce({ output: [call('one')] });
    await expect(runAgentComputerModelLoop(test.options)).resolves.toMatchObject({ calls: [{ status: 'succeeded' }] });
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  test('awaits rejected async event callbacks without unhandled rejection or tool retry', async () => {
    let eventPending = false;
    const callback = jest.fn(async () => {
      expect(eventPending).toBe(false);
      eventPending = true;
      await new Promise((resolve) => setImmediate(resolve));
      eventPending = false;
      throw new Error('async heartbeat offline');
    });
    const test = setup({ onEvent: callback });
    test.respond.mockImplementationOnce(async () => {
      expect(eventPending).toBe(false);
      return { output: [call('one')] };
    });
    test.dispatch.mockImplementationOnce(async () => {
      expect(eventPending).toBe(false);
      return { publicResult: { ok: true } };
    });
    await expect(runAgentComputerModelLoop(test.options)).resolves.toMatchObject({ calls: [{ status: 'succeeded' }] });
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(eventPending).toBe(false);
    expect(callback.mock.calls.every(([, context]) => context.signal instanceof AbortSignal)).toBe(true);
  });

  test.each(['model_started', 'tool_started', 'model_finished'])('async %s cancellation prevents subsequent execution', async (eventType) => {
    const abort = new AbortController();
    const test = setup({ signal: abort.signal, onEvent: async (event) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (event.type === eventType) abort.abort();
    } });
    if (eventType !== 'model_finished') test.respond.mockResolvedValueOnce({ output: [call('one')] });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_aborted' });
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.respond).toHaveBeenCalledTimes(eventType === 'model_started' ? 0 : 1);
  });

  test('overall deadline bounds a hung notification and cancels its callback scope', async () => {
    const callback = jest.fn(() => new Promise(() => {}));
    const test = setup({ maxTimeMs: 20, onEvent: callback });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_timeout' });
    expect(callback.mock.calls[0][1].signal.aborted).toBe(true);
    expect(test.respond).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  test('explicit unsuccessful result is recorded as failed without presenting its frame', async () => {
    const test = setup();
    test.respond.mockResolvedValueOnce({ output: [call('one')] });
    test.dispatch.mockResolvedValue({ publicResult: { success: false, error: 'action_failed' }, privateModelContent: frame('stale') });
    const result = await runAgentComputerModelLoop(test.options);
    expect(result.calls[0].status).toBe('failed');
    expect(JSON.stringify(test.respond.mock.calls[1][0].input)).not.toContain('data:image');
  });

  test('does not return model-emitted image payloads as final user text', async () => {
    const test = setup();
    test.respond.mockResolvedValue({ output: [message(frame('private')[1].image_url)] });
    await expect(runAgentComputerModelLoop(test.options)).rejects.toMatchObject({ code: 'computer_loop_private_output' });
  });
});

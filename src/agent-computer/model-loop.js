function loopError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function limit(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw loopError('computer_loop_invalid_config', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function assertSafeObject(value, depth = 0) {
  if (depth > 20) throw loopError('computer_loop_invalid_arguments', 'Tool arguments exceed the nesting limit');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw loopError('computer_loop_invalid_arguments', 'Prototype-bearing tool arguments are not allowed');
    }
    assertSafeObject(child, depth + 1);
  }
}

function prepareCalls(output, names, previousIds, remainingCalls) {
  if (!Array.isArray(output) || output.length === 0 || output.length > 100) {
    throw loopError('computer_loop_invalid_response', 'Model returned no valid bounded Responses output array');
  }
  const calls = [];
  const text = [];
  const replay = [];
  const roundIds = new Set();
  for (const item of output) {
    if (!plainObject(item)) throw loopError('computer_loop_invalid_response', 'Invalid Responses output item');
    if (item.type === 'function_call') {
      if (typeof item.name !== 'string' || !names.has(item.name)) {
        throw loopError('computer_loop_unknown_tool', 'Model requested an unavailable tool');
      }
      if (typeof item.call_id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(item.call_id)
        || previousIds.has(item.call_id) || roundIds.has(item.call_id)) {
        throw loopError('computer_loop_invalid_call_id', 'Tool call IDs must be valid and unique across the run');
      }
      if (typeof item.arguments !== 'string' || item.arguments.length > 32768) {
        throw loopError('computer_loop_invalid_arguments', 'Tool arguments must be a bounded JSON string');
      }
      let args;
      try { args = JSON.parse(item.arguments); } catch {
        throw loopError('computer_loop_invalid_arguments', 'Tool arguments are not valid JSON');
      }
      if (!plainObject(args)) throw loopError('computer_loop_invalid_arguments', 'Tool arguments must be a JSON object');
      assertSafeObject(args);
      roundIds.add(item.call_id);
      calls.push({ name: item.name, callId: item.call_id, args, item: { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments } });
      replay.push(calls[calls.length - 1].item);
    } else if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw loopError('computer_loop_invalid_response', 'Model message content must be an array');
      for (const part of item.content) {
        if (!plainObject(part) || part.type !== 'output_text' || typeof part.text !== 'string') {
          throw loopError('computer_loop_invalid_response', 'Only output_text model messages are supported');
        }
        text.push(part.text);
      }
      replay.push({ type: 'message', role: 'assistant', content: item.content });
    } else if (item.type === 'reasoning') {
      if (JSON.stringify(item).length > 65536) throw loopError('computer_loop_invalid_response', 'Model reasoning item exceeded its size limit');
      replay.push(item);
    } else if (item.type !== 'reasoning') {
      throw loopError('computer_loop_invalid_response', 'Unsupported Responses output item type');
    }
  }
  if (calls.length > remainingCalls) throw loopError('computer_loop_call_limit', 'Tool call budget exhausted before dispatch');
  const summary = text.join('\n').trim();
  if (!calls.length && !summary) throw loopError('computer_loop_invalid_response', 'Model returned neither tool calls nor a final message');
  if (summary.length > 12000) throw loopError('computer_loop_invalid_response', 'Model summary exceeded its size limit');
  if (/data:image\//i.test(summary)) throw loopError('computer_loop_private_output', 'Model summary must not publish private image payloads');
  return { calls, summary, replay };
}

function publicOutput(value) {
  const output = JSON.stringify(value, (key, entry) => {
    if (key === 'privateModelContent' || key === 'image_url' || entry?.type === 'Buffer'
      || entry?.type === 'input_image' || (typeof entry === 'string' && /data:image\//i.test(entry))) {
      throw loopError('computer_loop_private_output', 'Private images must not appear in public tool results');
    }
    return entry;
  });
  if (!output || output.length > 20000) throw loopError('computer_loop_public_output_limit', 'Public tool result must be bounded JSON');
  return output;
}

function privateContent(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw loopError('computer_loop_invalid_private_content', 'Trusted model content must be a bounded content array');
  }
  let images = 0;
  const content = value.map((part) => {
    if (part?.type === 'input_text' && typeof part.text === 'string' && part.text.length <= 12000) {
      return { type: 'input_text', text: part.text };
    }
    if (part?.type === 'input_image' && typeof part.image_url === 'string'
      && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url)
      && part.image_url.length <= 12 * 1024 * 1024) {
      images += 1;
      return { type: 'input_image', image_url: part.image_url, detail: 'high' };
    }
    throw loopError('computer_loop_invalid_private_content', 'Invalid trusted model content; image URLs must contain bounded local image bytes');
  });
  if (images !== 1) throw loopError('computer_loop_invalid_private_content', 'Each observation must contain exactly one private frame');
  return content;
}

/**
 * The caller owns schema validation, authorization, frame provenance, persistence,
 * and artifact verification. dispatch must derive privateModelContent exclusively
 * from AgentComputerRuntime.getModelInput, never model arguments or tool JSON.
 * This loop returns model prose, not a claim that the task was actually completed.
 */
async function runAgentComputerModelLoop({ respond, dispatch, tools, input = [], instructions = '',
  signal, onEvent = () => {}, maxRounds = 12, maxCalls = 32, maxTimeMs = 120000 } = {}) {
  if (typeof respond !== 'function' || typeof dispatch !== 'function' || !Array.isArray(input)
    || typeof instructions !== 'string' || typeof onEvent !== 'function') {
    throw loopError('computer_loop_invalid_config', 'A model responder, dispatcher, array input, and instructions are required');
  }
  limit(maxRounds, 1, 100, 'maxRounds');
  limit(maxCalls, 1, 1000, 'maxCalls');
  limit(maxTimeMs, 10, 1800000, 'maxTimeMs');
  if (!Array.isArray(tools) || !tools.length || tools.some((tool) => tool?.type !== 'function'
    || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(tool.name))) {
    throw loopError('computer_loop_invalid_config', 'Only named Responses function tools are supported');
  }
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length) throw loopError('computer_loop_invalid_config', 'Tool names must be unique');
  const controller = new AbortController();
  let rejectStop;
  let stopError;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const stop = (error) => {
    if (stopError) return;
    stopError = error;
    controller.abort(error);
    rejectStop(error);
  };
  const abort = () => stop(loopError('computer_loop_aborted', 'Agent computer loop cancelled; pending tools were not retried'));
  const timer = setTimeout(() => stop(loopError('computer_loop_timeout', 'Agent computer loop time budget exhausted')), maxTimeMs);
  signal?.addEventListener('abort', abort, { once: true });
  const calls = [];
  const ids = new Set();
  let history = input.map((value) => ({ value, privateFrame: false }));
  const guard = () => { if (stopError) throw stopError; };
  const emit = async (event) => {
    guard();
    try {
      // Await persistence/heartbeat callbacks and handle their rejected promises.
      // Cooperative callbacks receive the same cancellation scope as the tools;
      // an unresponsive callback cannot extend the overall execution deadline.
      await Promise.race([
        Promise.resolve().then(() => { guard(); return onEvent(event, { signal: controller.signal }); }),
        stopped,
      ]);
    } catch { /* Observability failures must not retry or change tool execution. */ }
    guard(); // A cancellation detected by the callback must stop the next tool.
  };
  const execute = async () => {
    if (signal?.aborted) abort();
    for (let round = 0; round < maxRounds; round += 1) {
      guard();
      await emit({ type: 'model_started' });
      guard();
      const response = await respond({ input: history.map((entry) => entry.value), tools, instructions, signal: controller.signal });
      guard();
      const prepared = prepareCalls(response?.output, names, ids, maxCalls - calls.length);
      if (!prepared.calls.length) {
        await emit({ type: 'model_finished' });
        return { summary: prepared.summary, calls };
      }
      // Once tools start, previous screenshots cannot be assumed current.
      history = history.filter((entry) => !entry.privateFrame);
      for (const value of prepared.replay) history.push({ value, privateFrame: false });
      let newestFrame = null;
      for (const call of prepared.calls) {
        guard();
        ids.add(call.callId);
        await emit({ type: 'tool_started', tool: call.name, callId: call.callId });
        guard();
        let output;
        let status = 'succeeded';
        try {
          const result = await dispatch(call.name, call.args, { callId: call.callId, signal: controller.signal });
          guard();
          if (!plainObject(result) || !Object.prototype.hasOwnProperty.call(result, 'publicResult')) {
            throw loopError('computer_loop_invalid_dispatch', 'Dispatcher must return an explicit public result');
          }
          output = publicOutput(result.publicResult);
          if (result.publicResult?.success === false) {
            status = 'failed';
            newestFrame = null;
          } else {
            const frame = privateContent(result.privateModelContent);
            if (frame) newestFrame = frame;
          }
        } catch (error) {
          guard();
          if (String(error?.code || '').startsWith('computer_loop_')) throw error;
          newestFrame = null;
          status = 'failed';
          output = JSON.stringify({ success: false, error: { code: 'tool_failed', message: 'Tool execution failed. It was not automatically retried; inspect current state before another action.' } });
        }
        history.push({ value: { type: 'function_call_output', call_id: call.callId, output }, privateFrame: false });
        calls.push({ tool: call.name, callId: call.callId, status });
        await emit({ type: status === 'failed' ? 'tool_failed' : 'tool_finished', tool: call.name, callId: call.callId });
      }
      if (newestFrame) {
        history = history.filter((entry) => !entry.privateFrame);
        history.push({ value: { role: 'user', content: newestFrame }, privateFrame: true });
      }
    }
    throw loopError('computer_loop_round_limit', 'Model round budget exhausted; task completion is unverified');
  };
  try { return await Promise.race([execute(), stopped]); } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // A final response or validation failure ends this execution scope. A late
    // responder/dispatcher receives cancellation, never an automatic retry.
    if (!controller.signal.aborted) controller.abort();
    history = [];
  }
}

module.exports = { runAgentComputerModelLoop };

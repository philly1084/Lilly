const {
  DEFAULT_CODEX_MODEL_ID,
  buildGatewayRealtimeUrl,
  extractAssistantText,
  extractSSEData,
  filterChatModels,
  filterCodexBackedModels,
  isChatModel,
  normalizeGatewayEventPayload,
  resolvePreferredChatModel,
  selectPreferredCodexModel,
  splitSSEFrames,
  streamGatewayResponse,
} = require('./openai-sse');

describe('openai-sse helpers', () => {
  test('splits SSE frames on double newlines', () => {
    const { frames, remainder } = splitSSEFrames('data: {"a":1}\n\ndata: {"b":2}\n\npartial');

    expect(frames).toEqual([
      'data: {"a":1}',
      'data: {"b":2}',
    ]);
    expect(remainder).toBe('partial');
  });

  test('extracts multi-line SSE data payloads', () => {
    expect(extractSSEData('event: message\ndata: {"a":1}\ndata: {"b":2}\n')).toBe('{"a":1}\n{"b":2}');
  });

  test('builds websocket URLs from the backend origin instead of the frontend preview port', () => {
    expect(buildGatewayRealtimeUrl('http://localhost:3000/v1')).toBe('ws://localhost:3000/ws');
    expect(buildGatewayRealtimeUrl('https://kimi.example.com')).toBe('wss://kimi.example.com/ws');
    expect(buildGatewayRealtimeUrl('https://kimi.example.com/api', '/realtime')).toBe('wss://kimi.example.com/realtime');
  });

  test('normalizes chat completion chunk payloads', () => {
    const events = normalizeGatewayEventPayload({
      object: 'chat.completion.chunk',
      id: 'chatcmpl_123',
      session_id: 'sess_123',
      artifacts: [{ id: 'artifact-1' }],
      choices: [{
        index: 0,
        delta: {
          content: 'Hello',
          reasoning: 'Thinking',
          tool_calls: [{ id: 'call_1', type: 'function_call', function: { name: 'search' } }],
        },
        finish_reason: 'stop',
      }],
    });

    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'reasoning_delta',
      'tool_calls',
      'finish',
    ]);
    expect(events[0].content).toBe('Hello');
    expect(events[1].summary).toBe('Thinking');
    expect(events[2].toolCalls[0].function.name).toBe('search');
    expect(events[3].finishReason).toBe('stop');
    expect(events[0].sessionId).toBe('sess_123');
    expect(events[0].artifacts).toEqual([
      {
        id: 'artifact-1',
        downloadUrl: '/api/artifacts/artifact-1/download',
      },
    ]);
  });

  test('preserves artifact arrays from nested response metadata', () => {
    const events = normalizeGatewayEventPayload({
      type: 'response.completed',
      response: {
        id: 'resp_artifacts',
        metadata: {
          artifacts: [
            {
              artifact_id: 'artifact-metadata-1',
              type: 'html',
              title: 'Build report',
              download_url: '/api/artifacts/artifact-metadata-1/download',
              preview_url: '/api/artifacts/artifact-metadata-1/preview',
              bundle_download_url: '/api/artifacts/artifact-metadata-1/bundle',
              size_bytes: '2048',
            },
          ],
        },
        output_text: 'Created the build report.',
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'final',
      responseId: 'resp_artifacts',
      artifacts: [
        {
          id: 'artifact-metadata-1',
          format: 'html',
          title: 'Build report',
          downloadUrl: '/api/artifacts/artifact-metadata-1/download',
          previewUrl: '/api/artifacts/artifact-metadata-1/preview',
          bundleDownloadUrl: '/api/artifacts/artifact-metadata-1/bundle',
          sizeBytes: 2048,
        },
      ],
    });
  });

  test('backfills document download links from streamed document ids', () => {
    const events = normalizeGatewayEventPayload({
      type: 'response.completed',
      response: {
        id: 'resp_document_artifact',
        metadata: {
          artifacts: [
            {
              document_id: 'doc-stream-1',
              filename: 'summary.html',
              mime_type: 'text/html',
            },
          ],
        },
        output_text: 'Created the summary document.',
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'final',
      responseId: 'resp_document_artifact',
      artifacts: [
        {
          id: 'doc-stream-1',
          filename: 'summary.html',
          mimeType: 'text/html',
          downloadUrl: '/api/documents/doc-stream-1/download',
        },
      ],
    });
  });

  test('preserves top-level metadata tool events on final responses', () => {
    const events = normalizeGatewayEventPayload({
      type: 'response.completed',
      id: 'resp_tool_metadata',
      metadata: {
        tool_events: [
          {
            type: 'tool_result',
            tool: 'web-fetch',
            success: true,
          },
        ],
      },
      response: {
        output_text: 'Fetched the source and summarized it.',
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'final',
      responseId: 'resp_tool_metadata',
      toolEvents: [
        expect.objectContaining({
          tool: 'web-fetch',
          success: true,
        }),
      ],
    });
  });

  test('ignores assistant role-only chat completion chunks and indexes tool calls', () => {
    expect(normalizeGatewayEventPayload({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })).toEqual([]);

    const events = normalizeGatewayEventPayload({
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
            { index: 4, id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        finish_reason: null,
      }],
    });

    expect(events).toHaveLength(1);
    expect(events[0].toolCalls.map((toolCall) => toolCall.index)).toEqual([0, 4]);
  });

  test('normalizes object-form reasoning from chat completion chunks', () => {
    const events = normalizeGatewayEventPayload({
      object: 'chat.completion.chunk',
      id: 'chatcmpl_456',
      choices: [{
        index: 0,
        delta: {
          reasoning: [
            { type: 'reasoning', summary: [{ text: 'Checking the request. ' }] },
            { type: 'reasoning', text: 'Choosing the direct path.' },
          ],
        },
        finish_reason: null,
      }],
    });

    expect(events.map((event) => event.type)).toEqual(['reasoning_delta']);
    expect(events[0].content).toBe('Checking the request. Choosing the direct path.');
    expect(events[0].summary).toBe('Checking the request. Choosing the direct path.');
  });

  test('normalizes object progress details without object string leaks', () => {
    const events = normalizeGatewayEventPayload({
      type: 'progress',
      progress: {
        phase: { label: 'executing' },
        detail: { message: 'Running the second task' },
        steps: [
          { title: { text: 'Plan the work' }, status: 'completed' },
          { title: { text: 'Run the next task' }, status: 'in_progress' },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('executing');
    expect(events[0].detail).toBe('Running the second task');
    expect(events[0].detail).not.toContain('[object Object]');
  });

  test('normalizes response chunk payloads', () => {
    const events = normalizeGatewayEventPayload({
      object: 'response.chunk',
      id: 'resp_123',
      output_text_delta: 'Hello',
      reasoning_delta: 'Thinking',
      output: [{ id: 'call_1', type: 'function_call', name: 'search' }],
    });

    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'reasoning_delta',
      'tool_calls',
    ]);
    expect(events[2].toolCalls).toHaveLength(1);
  });

  test('normalizes explicit chat completion tool call delta events', () => {
    const events = normalizeGatewayEventPayload({
      type: 'chat.completion.tool_calls.delta',
      session_id: 'session-tools',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"docs"}' } },
        { index: 3, id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_calls',
      stage: 'started',
      sessionId: 'session-tools',
    });
    expect(events[0].toolCalls.map((toolCall) => toolCall.index)).toEqual([0, 3]);
    expect(events[0].toolCalls[0].function.name).toBe('web_search');
  });

  test('prefers typed response deltas over legacy compatibility fields', () => {
    const textEvents = normalizeGatewayEventPayload({
      object: 'response.chunk',
      type: 'response.output_text.delta',
      delta: 'Typed text',
      output_text_delta: 'Legacy text',
    });
    const reasoningEvents = normalizeGatewayEventPayload({
      object: 'response.chunk',
      type: 'response.reasoning_summary_text.delta',
      delta: 'Typed public summary',
      reasoning_delta: 'Legacy reasoning',
    });

    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toMatchObject({
      type: 'text_delta',
      content: 'Typed text',
    });
    expect(reasoningEvents).toHaveLength(1);
    expect(reasoningEvents[0]).toMatchObject({
      type: 'reasoning_delta',
      content: 'Typed public summary',
      summary: 'Typed public summary',
      publicSummary: true,
    });
  });

  test('normalizes typed response refusal deltas as visible assistant text', () => {
    const events = normalizeGatewayEventPayload({
      object: 'response.chunk',
      type: 'response.refusal.delta',
      delta: 'I can help with a safer alternative.',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'text_delta',
      content: 'I can help with a safer alternative.',
    });
  });

  test('normalizes reasoning items embedded in response chunk output arrays', () => {
    const events = normalizeGatewayEventPayload({
      object: 'response.chunk',
      id: 'resp_234',
      output: [
        {
          type: 'reasoning',
          summary: [{ text: 'Checking the request. ' }],
          content: [{ type: 'output_text', text: 'Choosing the direct path.' }],
        },
      ],
    });

    expect(events.map((event) => event.type)).toEqual(['reasoning_delta']);
    expect(events[0].content).toBe('Checking the request. Choosing the direct path.');
    expect(events[0].summary).toBe('Checking the request. Choosing the direct path.');
  });

  test('indexes function calls embedded in response chunk output arrays', () => {
    const events = normalizeGatewayEventPayload({
      object: 'response.chunk',
      id: 'resp_tools',
      output: [
        { type: 'function_call', call_id: 'call_search', name: 'web_search', arguments: '{"q":"docs"}' },
        { type: 'custom_tool_call', index: 5, call_id: 'call_shell', name: 'remote-command', input: 'uptime' },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_calls',
      stage: 'started',
      responseId: 'resp_tools',
    });
    expect(events[0].toolCalls.map((toolCall) => toolCall.index)).toEqual([0, 5]);
    expect(events[0].toolCalls[0].name).toBe('web_search');
  });

  test('normalizes custom /api/chat delta payloads', () => {
    const events = normalizeGatewayEventPayload({
      type: 'delta',
      sessionId: 'session-123',
      content: 'Hello from /api/chat',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'text_delta',
      sessionId: 'session-123',
      content: 'Hello from /api/chat',
    });
  });

  test('normalizes progress payloads from /api/chat streams', () => {
    const events = normalizeGatewayEventPayload({
      type: 'progress',
      sessionId: 'session-456',
      progress: {
        phase: 'executing',
        detail: 'Inspecting the current state',
        totalSteps: 3,
        completedSteps: 1,
        steps: [
          { id: 'inspect', title: 'Inspect the current state', status: 'completed' },
          { id: 'implement', title: 'Implement the requested changes', status: 'in_progress' },
          { id: 'validate', title: 'Validate the result', status: 'pending' },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'progress',
      sessionId: 'session-456',
      phase: 'executing',
      detail: 'Inspecting the current state',
      progress: expect.objectContaining({
        totalSteps: 3,
        completedSteps: 1,
      }),
    });
  });

  test('normalizes final JSON chat completion fallback text', () => {
    const events = normalizeGatewayEventPayload({
      object: 'chat.completion',
      id: 'chatcmpl_123',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Final answer',
        },
        finish_reason: 'stop',
      }],
    }, { allowFinalText: true });

    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'finish',
      'final',
    ]);
    expect(events[0].content).toBe('Final answer');
  });

  test('normalizes final JSON chat completion reasoning fields', () => {
    const events = normalizeGatewayEventPayload({
      object: 'chat.completion',
      id: 'chatcmpl_789',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Final answer',
          reasoning: [
            { type: 'reasoning', summary: [{ text: 'Checked the request. ' }] },
            { type: 'reasoning', text: 'Chose the direct path.' },
          ],
        },
        finish_reason: 'stop',
      }],
    }, { allowFinalText: true });

    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'reasoning_delta',
      'finish',
      'final',
    ]);
    expect(events[1].content).toBe('Checked the request. Chose the direct path.');
  });

  test('normalizes provider thinking aliases from completion metadata', () => {
    const events = normalizeGatewayEventPayload({
      object: 'chat.completion',
      choices: [{
        message: {
          content: 'Final answer',
          thinking_summary: 'Checked constraints and picked the direct fix.',
        },
      }],
    }, { allowFinalText: true });

    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'reasoning_delta',
      'final',
    ]);
    expect(events[1].content).toBe('Checked constraints and picked the direct fix.');
  });

  test('normalizes final JSON response reasoning items from output arrays', () => {
    const events = normalizeGatewayEventPayload({
      object: 'response',
      id: 'resp_789',
      output: [
        {
          type: 'reasoning',
          summary: [{ text: 'Checked the request. ' }],
          text: 'Chose the direct path.',
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Final answer' }],
        },
      ],
    }, { allowFinalText: true });

    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'reasoning_delta',
      'final',
    ]);
    expect(events[0].content).toBe('Final answer');
    expect(events[1].content).toBe('Checked the request. Chose the direct path.');
  });

  test('normalizes final JSON response refusal content as visible text', () => {
    const events = normalizeGatewayEventPayload({
      object: 'response',
      id: 'resp_refusal',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'refusal', refusal: 'I can help with a safer version instead.' },
          ],
        },
      ],
    }, { allowFinalText: true });

    expect(events.map((event) => event.type)).toEqual(['text_delta', 'final']);
    expect(events[0]).toMatchObject({
      content: 'I can help with a safer version instead.',
      finalChunk: true,
    });
  });

  test('keeps Kimi-style thinking blocks out of final assistant text', () => {
    const events = normalizeGatewayEventPayload({
      object: 'response',
      id: 'resp_kimi_thinking',
      output: [
        {
          type: 'thinking',
          text: 'Private scratchpad that must not render.',
        },
        {
          type: 'redacted_thinking',
          data: 'opaque-redacted-reasoning',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'Nested private thought.' },
            { type: 'output_text', text: 'Public answer only.' },
          ],
        },
      ],
    }, { allowFinalText: true });

    const textEvents = events.filter((event) => event.type === 'text_delta');
    const reasoningEvents = events.filter((event) => event.type === 'reasoning_delta');

    expect(textEvents.map((event) => event.content)).toEqual(['Public answer only.']);
    expect(textEvents.map((event) => event.content).join(' ')).not.toContain('Private scratchpad');
    expect(textEvents.map((event) => event.content).join(' ')).not.toContain('Nested private thought');
    expect(textEvents.map((event) => event.content).join(' ')).not.toContain('opaque-redacted-reasoning');
    expect(reasoningEvents[0].content).toBe('Private scratchpad that must not render.');
  });

  test('streams final response text when SSE completion arrives without deltas', async () => {
    const payload = {
      type: 'response.completed',
      session_id: 'session-final',
      response: {
        id: 'resp-final',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Recovered final answer' }],
        }],
      },
    };
    const response = new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const events = [];
    for await (const event of streamGatewayResponse(response)) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['text_delta', 'final', 'done']);
    expect(events[0]).toMatchObject({
      content: 'Recovered final answer',
      finalChunk: true,
      sessionId: 'session-final',
      responseId: 'resp-final',
    });
  });

  test('streams camel-case provider output text from a final response envelope', async () => {
    const payload = {
      outputText: 'Recovered camel-case answer',
    };
    const response = new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const events = [];
    for await (const event of streamGatewayResponse(response)) {
      events.push(event);
    }

    expect(extractAssistantText(payload)).toBe('Recovered camel-case answer');
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'final', 'done']);
    expect(events[0]).toMatchObject({
      content: 'Recovered camel-case answer',
      finalChunk: true,
    });
  });

  test('streams only missing final suffix after partial SSE deltas', async () => {
    const delta = { type: 'response.output_text.delta', delta: 'Partial ' };
    const completed = {
      type: 'response.completed',
      response: {
        id: 'resp-partial',
        output_text: 'Partial final answer',
      },
    };
    const response = new Response(
      `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );

    const events = [];
    for await (const event of streamGatewayResponse(response)) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.content)).toEqual([
      'Partial ',
      'final answer',
    ]);
  });

  test('can leave premature SSE EOF incomplete for caller recovery', async () => {
    const delta = { type: 'response.output_text.delta', delta: 'Partial answer' };
    const response = new Response(`data: ${JSON.stringify(delta)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const events = [];
    for await (const event of streamGatewayResponse(response, { emitImplicitDone: false })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['text_delta']);
  });

  test('filters and selects Codex-backed models', () => {
    const models = [
      { id: 'gpt-4o' },
      { id: 'gpt-5.4-mini' },
      { id: 'gpt-5.3' },
      { id: 'claude-3-sonnet' },
      { id: 'codex-mini-latest' },
    ];

    expect(filterCodexBackedModels(models).map((model) => model.id)).toEqual([
      'gpt-5.4-mini',
      'gpt-5.3',
      'codex-mini-latest',
    ]);
    expect(selectPreferredCodexModel(models, 'claude-3-sonnet')).toBe('gpt-5.4-mini');
    expect(selectPreferredCodexModel([], '')).toBe('auto');
  });

  test('preserves non-Codex chat models when explicitly selected', () => {
    const models = [
      { id: 'gpt-5.4-mini' },
      { id: 'claude-3-sonnet' },
      { id: 'gemini-2.5-pro' },
    ];

    expect(resolvePreferredChatModel(models, 'claude-3-sonnet')).toBe('claude-3-sonnet');
    expect(resolvePreferredChatModel([], 'claude-3-sonnet')).toBe('claude-3-sonnet');
    expect(resolvePreferredChatModel(models, 'missing-model')).toBe('auto');
  });

  test('excludes image models from chat selection and stale preferences', () => {
    const models = [
      { id: 'gpt-image-2', capabilities: ['image_generation'] },
      { id: 'imagen-4.0-generate-preview-06-06', capabilities: ['image_generation'] },
      { id: 'gpt-5.4-mini', capabilities: ['chat'] },
      { id: 'gpt-5.5-tools', capabilities: ['tools', 'streaming'] },
      { id: 'text-embedding-3-large', capabilities: ['embeddings'] },
    ];

    expect(isChatModel(models[0])).toBe(false);
    expect(filterChatModels(models).map((model) => model.id)).toEqual(['gpt-5.4-mini', 'gpt-5.5-tools']);
    expect(resolvePreferredChatModel(models, 'gpt-image-2')).toBe('auto');
  });

  test('normalizes string and nested capability metadata for chat selection', () => {
    const models = [
      { id: 'gpt-image-2', capabilities: 'image_generation' },
      { id: 'custom-render-router', capabilities: [], metadata: { capabilities: { image_generation: { supported: true } } } },
      { id: 'gpt-5.5-tools', capabilities: [], metadata: { capabilities: { tools: { supported: true }, streaming: 'available' } } },
      { id: 'custom-basic-chat', contract: { capabilities: { chat: true } } },
    ];

    expect(isChatModel(models[0])).toBe(false);
    expect(isChatModel(models[1])).toBe(false);
    expect(filterChatModels(models).map((model) => model.id)).toEqual([
      'gpt-5.5-tools',
      'custom-basic-chat',
    ]);
    expect(resolvePreferredChatModel(models, 'gpt-5.5-tools')).toBe('gpt-5.5-tools');
  });

  test('normalizes provider support maps for chat selection', () => {
    const models = [
      { id: 'image-output-router', supports: { image_generation: true } },
      { id: 'fast-router', supports: { chat: true, tools: { supported: true }, streaming: 'available' } },
      { id: 'structured-router', contract: { supports: { chat: true, structured_outputs: true } } },
    ];

    expect(isChatModel(models[0])).toBe(false);
    expect(filterChatModels(models).map((model) => model.id)).toEqual([
      'fast-router',
      'structured-router',
    ]);
    expect(resolvePreferredChatModel(models, 'fast-router')).toBe('fast-router');
  });

  test('normalizes provider capability maps for chat selection', () => {
    const models = [
      { id: 'image-map-router', capability_map: { image_generation: { supported: true } } },
      { id: 'metadata-tools-router', metadata: { capabilityMap: { tools: true, streaming: 'available' } } },
      { id: 'contract-chat-router', contract: { capability_map: { chat: true, structured_outputs: true } } },
    ];

    expect(isChatModel(models[0])).toBe(false);
    expect(filterChatModels(models).map((model) => model.id)).toEqual([
      'metadata-tools-router',
      'contract-chat-router',
    ]);
    expect(resolvePreferredChatModel(models, 'metadata-tools-router')).toBe('metadata-tools-router');
  });

  test('keeps vision and image-input chat models selectable', () => {
    const models = [
      { id: 'gpt-4-vision-preview' },
      { id: 'gpt-4o-image-input-preview' },
      { id: 'router-image-input-chat', capabilities: ['chat', 'image_input'] },
      { id: 'custom-image-router', capabilities: ['image_generation'] },
    ];

    expect(isChatModel('gpt-4-vision-preview')).toBe(true);
    expect(isChatModel('gpt-4o-image-input-preview')).toBe(true);
    expect(filterChatModels(models).map((model) => model.id)).toEqual([
      'gpt-4-vision-preview',
      'gpt-4o-image-input-preview',
      'router-image-input-chat',
    ]);
    expect(resolvePreferredChatModel(models, 'gpt-4o-image-input-preview')).toBe('gpt-4o-image-input-preview');
  });

  test('keeps plain auto as a valid chat-model selection even when the catalog omits it', () => {
    const models = [
      { id: 'gpt-5.4-mini', capabilities: ['chat'] },
      { id: 'openrouter/auto', capabilities: ['chat'] },
    ];

    expect(DEFAULT_CODEX_MODEL_ID).toBe('auto');
    expect(isChatModel('auto')).toBe(true);
    expect(resolvePreferredChatModel(models, 'auto')).toBe('auto');
    expect(resolvePreferredChatModel(models, '')).toBe('auto');
    expect(resolvePreferredChatModel(models, 'openrouter/auto')).toBe('openrouter/auto');
  });
});

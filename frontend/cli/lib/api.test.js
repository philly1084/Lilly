const mockGetApiBaseUrl = jest.fn();
const mockConfigGet = jest.fn();
const mockChatCompletionsCreate = jest.fn();
const mockOpenAI = jest.fn().mockImplementation(() => ({
  chat: {
    completions: {
      create: mockChatCompletionsCreate,
    },
  },
}));

jest.mock('./config', () => ({
  getApiBaseUrl: (...args) => mockGetApiBaseUrl(...args),
  get: (...args) => mockConfigGet(...args),
}));

jest.mock('openai', () => mockOpenAI);

const { OpenAIClient, chat, listArtifacts } = require('./api');

describe('OpenAIClient provider sessions', () => {
  beforeEach(() => {
    mockGetApiBaseUrl.mockReturnValue('http://localhost:8080/v1');
    mockConfigGet.mockImplementation((key, defaultValue) => {
      if (key === 'frontendApiKey') {
        return 'config-front-key';
      }
      return defaultValue;
    });
    mockChatCompletionsCreate.mockReset();
    mockOpenAI.mockClear();
    global.fetch = jest.fn();
    delete process.env.KIMIBUILT_FRONTEND_API_KEY;
    delete process.env.FRONTEND_API_KEY;
    delete process.env.KIMIBUILT_GATEWAY_API_KEY;
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('getProviderCapabilities uses frontend auth against admin endpoint', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        data: [
          { providerId: 'codex-cli', supportsSessions: true },
        ],
      })),
    });

    const client = new OpenAIClient();
    const result = await client.getProviderCapabilities();

    expect(result).toEqual([{ providerId: 'codex-cli', supportsSessions: true }]);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/admin/provider-capabilities',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer config-front-key',
        }),
      }),
    );
  });

  test('getModels returns the full backend chat model catalog instead of filtering to codex-only models', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        data: [
          { id: 'gpt-5.4-mini', owned_by: 'openai' },
          { id: 'gemini-2.5-pro', owned_by: 'google' },
          { id: 'kimi-k2.5', owned_by: 'moonshot' },
        ],
      })),
    });

    const client = new OpenAIClient();
    const models = await client.getModels();

    expect(models).toEqual([
      { id: 'gpt-5.4-mini', owned_by: 'openai' },
      { id: 'gemini-2.5-pro', owned_by: 'google' },
      { id: 'kimi-k2.5', owned_by: 'moonshot' },
    ]);
  });

  test('normalizes a root API URL to the OpenAI /v1 path for chat model catalog calls', async () => {
    mockGetApiBaseUrl.mockReturnValue('http://localhost:8080');
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({ data: [{ id: 'gpt-5.4-mini' }] })),
    });

    const client = new OpenAIClient();
    await client.getModels();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('getImageModels filters OpenAI-compatible model capabilities', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: jest.fn(async () => ({
        data: [
          { id: 'gpt-5.4-mini', capabilities: ['chat'], owned_by: 'openai' },
          { id: 'gpt-image-2', capabilities: ['image_generation'], owned_by: 'openai' },
          {
            id: 'gateway-image-model',
            metadata: {
              capabilities: { image_generation: { supported: true } },
              sizes: ['1024x1024', '1536x1024'],
            },
            owned_by: 'gateway',
          },
          {
            id: 'contract-image-model',
            contract: {
              capability_map: { image_generation: 'available' },
            },
            metadata: {
              qualities: ['standard', 'high'],
            },
          },
        ],
      })),
    });

    const client = new OpenAIClient();
    const models = await client.getImageModels();

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gpt-image-2',
        sizes: expect.arrayContaining(['1536x1024']),
        qualities: expect.arrayContaining(['high']),
      }),
      expect.objectContaining({
        id: 'gateway-image-model',
        sizes: ['1024x1024', '1536x1024'],
      }),
      expect.objectContaining({
        id: 'contract-image-model',
        qualities: ['standard', 'high'],
      }),
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer config-front-key',
        }),
      }),
    );
  });

  test('generateImage calls the OpenAI-compatible image endpoint with gpt-image-2 defaults', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: jest.fn(async () => ({
        created: 123,
        session_id: 'session-1',
        model: 'gpt-image-2',
        size: '1536x1024',
        data: [{ b64_json: 'aGVsbG8=' }],
      })),
    });

    const client = new OpenAIClient();
    const result = await client.generateImage('developer tools banner', {
      size: '1536x1024',
      quality: 'high',
      sessionId: 'session-1',
    });

    expect(result.data).toEqual([{ b64_json: 'aGVsbG8=' }]);
    expect(result.sessionId).toBe('session-1');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer config-front-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      prompt: 'developer tools banner',
      model: 'gpt-image-2',
      size: '1536x1024',
      quality: 'high',
      session_id: 'session-1',
    }));
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('response_format');
  });

  test('chatNonStreaming enables the shared conversation executor for CLI tasks', async () => {
    mockChatCompletionsCreate.mockResolvedValue({
      id: 'resp-1',
      session_id: 'session-1',
      choices: [
        {
          message: {
            content: 'done',
          },
        },
      ],
    });

    const client = new OpenAIClient();
    const response = await client.chatNonStreaming('fix the server', 'session-1', 'gpt-5.4-mini');

    expect(response.content).toBe('done');
    expect(mockChatCompletionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      enableConversationExecutor: true,
      taskType: 'chat',
      clientSurface: 'cli',
      metadata: expect.objectContaining({
        clientSurface: 'cli',
        enableConversationExecutor: true,
        remoteBuildAutonomyApproved: true,
      }),
    }));
  });

  test('chatNonStreaming preserves artifact and tool metadata from final responses', async () => {
    mockChatCompletionsCreate.mockResolvedValue({
      id: 'resp-2',
      session_id: 'session-2',
      choices: [
        {
          message: {
            content: 'Generated the report.',
            assistant_metadata: {
              reasoning_summary: 'Created a downloadable PDF artifact.',
              artifacts: [
                {
                  artifact_id: 'artifact-pdf-1',
                  filename: 'report.pdf',
                  download_url: '/api/artifacts/artifact-pdf-1/download',
                },
              ],
            },
            tool_events: [
              {
                type: 'tool_result',
                tool: 'document-workflow',
              },
            ],
          },
        },
      ],
    });

    const client = new OpenAIClient();
    const response = await client.chatNonStreaming('make a report', null, 'gpt-5.4-mini');

    expect(response).toEqual(expect.objectContaining({
      content: 'Generated the report.',
      sessionId: 'session-2',
      responseId: 'resp-2',
      artifacts: [
        expect.objectContaining({
          id: 'artifact-pdf-1',
          filename: 'report.pdf',
          downloadUrl: '/api/artifacts/artifact-pdf-1/download',
        }),
      ],
      toolEvents: [
        expect.objectContaining({
          tool: 'document-workflow',
        }),
      ],
      assistantMetadata: expect.objectContaining({
        reasoningSummary: 'Created a downloadable PDF artifact.',
      }),
    }));
  });

  test('listArtifacts normalizes persisted artifact metadata for terminal display', async () => {
    const http = require('http');
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        artifacts: [
          {
            artifact_id: 'artifact-cli-1',
            name: 'analysis.pdf',
            extension: 'pdf',
            mime_type: 'application/pdf',
            size_bytes: 1536,
            download_url: '/api/artifacts/artifact-cli-1/download',
            preview_url: '/api/artifacts/artifact-cli-1/preview',
          },
        ],
      }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    mockGetApiBaseUrl.mockReturnValue(`http://127.0.0.1:${port}/v1`);

    try {
      const result = await listArtifacts('session-cli-1');

      expect(requests).toEqual(['/api/sessions/session-cli-1/artifacts']);
      expect(result.artifacts).toEqual([
        expect.objectContaining({
          id: 'artifact-cli-1',
          filename: 'analysis.pdf',
          format: 'pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1536,
          downloadUrl: '/api/artifacts/artifact-cli-1/download',
          previewUrl: '/api/artifacts/artifact-cli-1/preview',
        }),
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('listArtifacts backfills document download links from document ids', async () => {
    const http = require('http');
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        artifacts: [
          {
            document_id: 'doc-cli-1',
            filename: 'brief.html',
            mime_type: 'text/html',
          },
        ],
      }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    mockGetApiBaseUrl.mockReturnValue(`http://127.0.0.1:${port}/v1`);

    try {
      const result = await listArtifacts('session-cli-documents');

      expect(requests).toEqual(['/api/sessions/session-cli-documents/artifacts']);
      expect(result.artifacts).toEqual([
        expect.objectContaining({
          id: 'doc-cli-1',
          filename: 'brief.html',
          mimeType: 'text/html',
          downloadUrl: '/api/documents/doc-cli-1/download',
        }),
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('exported streaming chat forwards caller metadata to the gateway', async () => {
    global.fetch.mockResolvedValue(new Response([
      'data: {"type":"response.completed","session_id":"session-1","response":{"id":"resp-1","output_text":"done"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'X-Session-Id': 'session-1',
      },
    }));

    const onDelta = jest.fn();
    const onDone = jest.fn();

    const result = await chat(
      'ship this',
      'session-1',
      onDelta,
      onDone,
      'gpt-5.4-mini',
      null,
      null,
      { metadata: { workflowAction: 'cli-workbench-command', traceId: 'trace-1' } },
    );

    expect(result).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      responseId: 'resp-1',
    }));
    expect(onDelta).toHaveBeenCalledWith('done');
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      responseId: 'resp-1',
    }));
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer config-front-key',
        }),
      }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      model: 'gpt-5.4-mini',
      session_id: 'session-1',
      metadata: expect.objectContaining({
        clientSurface: 'cli',
        enableConversationExecutor: true,
        remoteBuildAutonomyApproved: true,
        workflowAction: 'cli-workbench-command',
        traceId: 'trace-1',
      }),
    }));
  });

  test('canvas routes through the backend canvas endpoint instead of chat completions', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        sessionId: 'session-1',
        canvasType: 'code',
        content: 'const ok = true;',
        metadata: { templateId: 'code-default' },
        suggestions: ['run tests'],
      })),
    });

    const client = new OpenAIClient();
    const result = await client.canvas('write code', 'session-1', 'code', 'old code', 'gpt-5.4-mini');

    expect(result.content).toBe('const ok = true;');
    expect(mockChatCompletionsCreate).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/canvas',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      message: 'write code',
      sessionId: 'session-1',
      canvasType: 'code',
      existingContent: 'old code',
      clientSurface: 'cli',
      taskType: 'canvas',
      enableConversationExecutor: true,
    }));
  });

  test('createProviderSession posts the expected provider session body', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        session: {
          id: 'session-1',
          providerId: 'gemini-cli',
          cwd: 'C:\\repos\\demo',
        },
        streamUrl: '/admin/provider-sessions/session-1/stream?token=test-token',
      })),
    });

    const client = new OpenAIClient();
    const created = await client.createProviderSession({
      providerId: 'gemini-cli',
      cwd: 'C:\\repos\\demo',
      cols: 120,
      rows: 40,
    });

    expect(created.session.id).toBe('session-1');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/admin/provider-sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer config-front-key',
        }),
      }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      providerId: 'gemini-cli',
      mode: 'interactive',
      cwd: 'C:\\repos\\demo',
      cols: 120,
      rows: 40,
    });
  });

  test('createProviderSession omits cwd when the caller did not provide a backend path', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        session: {
          id: 'session-1',
          providerId: 'codex-cli',
        },
        streamUrl: '/admin/provider-sessions/session-1/stream?token=test-token',
      })),
    });

    const client = new OpenAIClient();
    await client.createProviderSession({
      providerId: 'codex-cli',
      cols: 120,
      rows: 40,
    });

    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      providerId: 'codex-cli',
      mode: 'interactive',
      cols: 120,
      rows: 40,
    });
  });

  test('streamProviderSession parses output, status, and exit events', async () => {
    const streamPayload = [
      'event: output',
      'data: {"cursor":1,"data":"hello\\n"}',
      '',
      ': keepalive',
      '',
      'event: status',
      'data: {"cursor":2,"status":"running","message":"ready"}',
      '',
      'event: exit',
      'data: {"cursor":3,"exitCode":0}',
      '',
    ].join('\n');

    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode(streamPayload),
        })
        .mockResolvedValueOnce({
          done: true,
          value: undefined,
        }),
      releaseLock: jest.fn(),
    };

    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'text/event-stream'),
      },
      body: {
        getReader: () => reader,
      },
    });

    const client = new OpenAIClient();
    const events = [];
    for await (const event of client.streamProviderSession('/admin/provider-sessions/session-1/stream?token=test-token', { after: 7 })) {
      events.push(event);
    }

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/admin/provider-sessions/session-1/stream?token=test-token&after=7',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: 'Bearer config-front-key',
        },
      }),
    );
    expect(events).toEqual([
      { type: 'output', cursor: 1, data: 'hello\n' },
      { type: 'status', cursor: 2, status: 'running', message: 'ready' },
      { type: 'exit', cursor: 3, exitCode: 0 },
    ]);
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  test('streamProviderSession rejects cross-origin URLs before sending frontend auth', async () => {
    const client = new OpenAIClient();
    const events = client.streamProviderSession('https://untrusted.example/provider-stream');

    await expect(events.next()).rejects.toThrow(
      'Provider stream URL must use the configured gateway origin',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('provider session commands fail fast when no frontend auth token is configured', async () => {
    mockConfigGet.mockImplementation((key, defaultValue) => defaultValue);

    const client = new OpenAIClient();
    await expect(client.getProviderCapabilities()).rejects.toThrow(
      'Provider CLI access requires a frontend API key.',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('getAvailableTools calls the guarded tools catalog with workbench query params', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        success: true,
        data: [],
        meta: { executionProfile: 'remote-build' },
      })),
    });

    const client = new OpenAIClient();
    await client.getAvailableTools({
      category: 'ssh',
      sessionId: 'session-1',
      taskType: 'chat',
      clientSurface: 'cli',
      executionProfile: 'remote-build',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/tools/available?category=ssh&sessionId=session-1&taskType=chat&clientSurface=cli&executionProfile=remote-build',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer config-front-key',
        }),
      }),
    );
  });

  test('runRemoteCommand sends workingDirectory through the tool invoke API', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        success: true,
        sessionId: 'session-2',
        data: {
          stdout: '/workspace/app',
          stderr: '',
          exitCode: 0,
        },
      })),
    });

    const client = new OpenAIClient();
    await client.runRemoteCommand('pwd', {
      workingDirectory: '/workspace/app',
      profile: 'inspect',
      workflowAction: 'cli-workbench-pwd',
      sessionId: 'session-1',
      executionProfile: 'remote-build',
      model: 'gpt-5.4-mini',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/tools/invoke',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer config-front-key',
        }),
        body: JSON.stringify({
          tool: 'remote-command',
          params: {
            command: 'pwd',
            profile: 'inspect',
            workflowAction: 'cli-workbench-pwd',
            timeout: 120000,
            workingDirectory: '/workspace/app',
          },
          sessionId: 'session-1',
          taskType: 'chat',
          clientSurface: 'cli',
          executionProfile: 'remote-build',
          model: 'gpt-5.4-mini',
          metadata: {
            clientSurface: 'cli',
            requestedModel: 'gpt-5.4-mini',
          },
        }),
      }),
    );
  });

  test('runRemoteCliAgent invokes the remote-cli-agent tool with remote-build metadata', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        success: true,
        sessionId: 'backend-session-2',
        data: {
          finalOutput: 'deployed',
          mcpSessionId: 'mcp-1',
        },
      })),
    });

    const client = new OpenAIClient();
    await client.runRemoteCliAgent('Build a weather app', {
      cwd: '/srv/apps/weather',
      backendSessionId: 'backend-session-1',
      executionProfile: 'remote-build',
      model: 'gpt-5.4-mini',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/tools/invoke',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer config-front-key',
        }),
        body: JSON.stringify({
          tool: 'remote-cli-agent',
          params: {
            task: 'Build a weather app',
            waitMs: 30000,
            maxTurns: 30,
            cwd: '/srv/apps/weather',
            model: 'gpt-5.4-mini',
          },
          sessionId: 'backend-session-1',
          taskType: 'chat',
          clientSurface: 'cli',
          executionProfile: 'remote-build',
          model: 'gpt-5.4-mini',
          metadata: {
            remoteBuildAutonomyApproved: true,
            remoteCommandSource: 'cli',
            clientSurface: 'cli',
            requestedModel: 'gpt-5.4-mini',
          },
        }),
      }),
    );
  });

  test('runK3sDeploy invokes k3s-deploy with action params', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn(() => 'application/json'),
      },
      json: jest.fn(async () => ({
        success: true,
        data: { action: 'sync-and-apply' },
      })),
    });

    const client = new OpenAIClient();
    await client.runK3sDeploy({
      action: 'sync-and-apply',
      namespace: 'kimibuilt',
    }, {
      sessionId: 'session-1',
      executionProfile: 'remote-build',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/tools/invoke',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      tool: 'k3s-deploy',
      params: {
        action: 'sync-and-apply',
        namespace: 'kimibuilt',
      },
      sessionId: 'session-1',
      executionProfile: 'remote-build',
    }));
  });
});

'use strict';

const {
  RemoteCliAgentsSdkRunner,
  buildRemoteCliInstructions,
  extractRemoteCliRunMetadata,
  hasRemoteSoftwareDeploymentIntent,
  resolveAgentsApiMode,
  buildRemoteCliDiagnostics,
  resolveAdminMode,
  resolveRemoteCliTargetId,
} = require('./agents-sdk-runner');

describe('RemoteCliAgentsSdkRunner', () => {
  test('builds remote CLI instructions with target defaults and polling guidance', () => {
    const instructions = buildRemoteCliInstructions({
      targetId: 'prod',
      cwd: '/srv/apps/my-app',
      sessionId: 'sess_123',
      waitMs: 30000,
    });

    expect(instructions).toContain('Use remote_code_run for coding tasks.');
    expect(instructions).toContain('Default targetId: prod');
    expect(instructions).toContain('Default cwd: /srv/apps/my-app');
    expect(instructions).toContain('repo-map');
    expect(instructions).toContain('deploy-verify');
    expect(instructions).toContain('git-backed workspace');
    expect(instructions).toContain('GitLab-backed source-control skill');
    expect(instructions).toContain('direct BuildKit/kubectl runner path');
    expect(instructions).toContain('git user.name');
    expect(instructions).toContain('Playwright/Chromium screenshots');
    expect(instructions).toContain('kimibuilt-ui-check');
    expect(instructions).toContain('UI_CHECK_REPORT');
    expect(instructions).toContain('WHAT_CHANGED');
    expect(instructions).toContain('VERIFY_COMMANDS');
    expect(instructions).toContain('VERIFY_RESULTS');
    expect(instructions).toContain('PUBLIC_URL');
    expect(instructions).toContain('BLOCKER');
    expect(instructions).toContain('GIT_COMMIT');
    expect(instructions).toContain('remote_code_status');
    expect(instructions).toContain('persistent private workbench');
    expect(instructions).toContain('not a Git remote, URL, or raw user@host SSH string');
    expect(instructions).toContain('root@github.com permission failure');
    expect(instructions).toContain('sess_123');
  });

  test('normalizes unsafe remote CLI target ids back to the configured gateway target', () => {
    expect(resolveRemoteCliTargetId('github.com', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('root@github.com', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('root@162.55.163.199', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('162.55.163.199', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('https://github.com/example/app.git', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('', 'github.com')).toBe('prod');
    expect(resolveRemoteCliTargetId('staging', 'prod')).toBe('staging');
  });

  test('adds admin runner guidance for real remote deployment work', () => {
    const instructions = buildRemoteCliInstructions({
      targetId: 'prod',
      cwd: '/srv/apps/status-dashboard',
      waitMs: 30000,
      adminMode: true,
    });

    expect(instructions).toContain('Admin runner mode is enabled');
    expect(instructions).toContain('do not retry the same blocked command');
    expect(instructions).toContain('USER_INPUT_REQUIRED');
  });

  test('infers admin mode for remote software deployments but not inspections', () => {
    expect(hasRemoteSoftwareDeploymentIntent(
      'Build a new dashboard on the server and deploy it to k3s at status.demoserver2.buzz with ingress and TLS.',
    )).toBe(true);
    expect(resolveAdminMode({}, 'Inspect the k3s deployment logs for the backend service.')).toBe(false);
    expect(resolveAdminMode({ adminMode: false }, 'Build and deploy a site on the server.')).toBe(false);
    expect(resolveAdminMode({ runnerAdmin: true }, 'Inspect cluster status.')).toBe(true);
  });

  test('includes configured GitLab context in remote CLI instructions without exposing tokens', () => {
    const instructions = buildRemoteCliInstructions({
      targetId: 'prod',
      gitea: {
        provider: 'gitlab',
        configured: true,
        baseURL: 'https://gitlab.demoserver2.buzz',
        org: 'agent-apps',
        hasToken: true,
      },
    });

    expect(instructions).toContain('Configured Git provider: gitlab at https://gitlab.demoserver2.buzz (group/org: agent-apps).');
    expect(instructions).toContain('configured provider token');
    expect(instructions).not.toContain('hasToken');
  });

  test('extracts remote CLI continuity markers from final output', () => {
    expect(extractRemoteCliRunMetadata([
      'Deployed the site.',
      'REMOTE_CLI_SESSION_ID=rcs_123',
      'WORKSPACE=/srv/apps/weather',
      'GIT_REPO=https://gitlab.demoserver2.buzz/agent-apps/weather.git',
      'GIT_COMMIT=abcdef123456',
      'DEPLOYMENT=app-weather/weather',
      'PUBLIC_HOST=weather.demoserver2.buzz',
      'PUBLIC_URL=https://weather.demoserver2.buzz',
      'UI_CHECK_REPORT=/srv/apps/weather/ui-checks/ui-check-report.json',
      'UI_SCREENSHOTS=/srv/apps/weather/ui-checks/weather-desktop.png,/srv/apps/weather/ui-checks/weather-mobile.png',
      'WHAT_CHANGED=Updated the weather dashboard copy and deployment manifest.',
      'VERIFY_COMMANDS=npm test -- --runTestsByPath src/weather.test.js',
      'VERIFY_COMMANDS=node /app/bin/kimibuilt-ui-check.js https://weather.demoserver2.buzz --out ui-checks',
      'VERIFY_RESULTS=Jest passed.',
      'VERIFY_RESULTS=UI check passed with desktop and mobile screenshots.',
      'BLOCKER=none',
    ].join('\n'))).toEqual({
      sessionId: 'rcs_123',
      workspace: '/srv/apps/weather',
      gitRepo: 'https://gitlab.demoserver2.buzz/agent-apps/weather.git',
      gitCommit: 'abcdef123456',
      deployment: 'app-weather/weather',
      publicHost: 'weather.demoserver2.buzz',
      publicUrl: 'https://weather.demoserver2.buzz',
      uiCheckReport: '/srv/apps/weather/ui-checks/ui-check-report.json',
      uiScreenshots: [
        '/srv/apps/weather/ui-checks/weather-desktop.png',
        '/srv/apps/weather/ui-checks/weather-mobile.png',
      ],
      whatChanged: 'Updated the weather dashboard copy and deployment manifest.',
      verifyCommands: [
        'npm test -- --runTestsByPath src/weather.test.js',
        'node /app/bin/kimibuilt-ui-check.js https://weather.demoserver2.buzz --out ui-checks',
      ],
      verifyResults: [
        'Jest passed.',
        'UI check passed with desktop and mobile screenshots.',
      ],
      completionStatus: 'complete',
    });
  });

  test('classifies blocked remote CLI output from proof markers', () => {
    expect(extractRemoteCliRunMetadata([
      'Stopped before deploy.',
      'WHAT_CHANGED=Patched the repository locally.',
      'VERIFY_COMMANDS=npm test',
      'VERIFY_RESULTS=Blocked before tests could run.',
      'PUBLIC_URL=not_available',
      'BLOCKER=Missing GitLab runner token.',
    ].join('\n'))).toEqual({
      whatChanged: 'Patched the repository locally.',
      verifyCommands: ['npm test'],
      verifyResults: ['Blocked before tests could run.'],
      blocker: 'Missing GitLab runner token.',
      completionStatus: 'blocked',
    });
  });

  test('classifies proof markers embedded in Codex JSONL agent messages', () => {
    const output = JSON.stringify({
      id: 'rcli_jsonl',
      targetId: 'k3s-prod',
      cwd: '/srv/apps/my-app',
      status: 'completed',
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread_jsonl' }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_1',
            type: 'agent_message',
            text: [
              'REMOTE_AGENT_RESULT=live-token-exchange:/srv/apps/my-app',
              'WHAT_CHANGED=none',
              'VERIFY_COMMANDS=pwd',
              'VERIFY_RESULTS=/srv/apps/my-app',
              'PUBLIC_URL=not_available',
              'BLOCKER=none',
            ].join('\n'),
          },
        }),
      ].join('\n'),
    });

    expect(extractRemoteCliRunMetadata(output)).toMatchObject({
      verifyCommands: ['pwd'],
      verifyResults: ['/srv/apps/my-app'],
      completionStatus: 'complete',
    });
  });

  test('uses chat mode automatically for custom gateway base URLs', () => {
    expect(resolveAgentsApiMode({
      requestedMode: 'auto',
      baseURL: 'http://n8n-openai-cli-gateway/v1',
    })).toBe('chat');
    expect(resolveAgentsApiMode({
      requestedMode: 'auto',
      baseURL: 'https://api.openai.com/v1',
    })).toBe('responses');
  });

  test('builds actionable diagnostics for generic remote CLI connection errors', () => {
    const diagnostics = buildRemoteCliDiagnostics({
      stage: 'agent_run',
      error: new Error('Connection error.'),
      model: 'gpt-5.5',
      apiMode: 'chat',
      targetId: 'prod',
      cwd: '/srv/apps/my-app',
      config: {
        url: 'http://gateway.example.com/mcp?token=secret',
        apiKey: 'gateway-secret-token',
        agentApiKey: 'sk-openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
      },
      mcpSessionId: 'mcp-session-1',
    });

    expect(diagnostics.remoteCliAgent).toMatchObject({
      stage: 'agent_run',
      model: 'gpt-5.5',
      apiMode: 'chat',
      targetId: 'prod',
      cwd: '/srv/apps/my-app',
      mcpSessionId: 'mcp-session-1',
      mcpURL: 'http://gateway.example.com/mcp',
      agentBaseURL: 'http://gateway.example.com/v1',
      hasMcpToken: true,
      hasAgentApiKey: true,
      error: {
        message: 'Connection error.',
      },
    });
    expect(diagnostics.remoteCliAgent.hint).toContain('/v1/chat/completions');
    expect(JSON.stringify(diagnostics)).not.toContain('gateway-secret-token');
    expect(JSON.stringify(diagnostics)).not.toContain('sk-openai-secret');
  });

  test('connects Streamable HTTP MCP with bearer auth and closes it after the run', async () => {
    const calls = {
      apiModes: [],
      mcpOptions: null,
      agentConfig: null,
      runnerConfig: null,
      runnerInput: null,
      connected: false,
      closed: false,
    };

    class FakeMCPServerStreamableHttp {
      constructor(options) {
        calls.mcpOptions = options;
        this.sessionId = 'mcp-session-1';
      }

      async connect() {
        calls.connected = true;
      }

      async close() {
        calls.closed = true;
      }
    }

    class FakeAgent {
      constructor(config) {
        calls.agentConfig = config;
      }
    }

    class FakeOpenAIProvider {
      constructor(config) {
        this.config = config;
      }
    }

    class FakeRunner {
      constructor(config) {
        calls.runnerConfig = config;
      }

      async run(_agent, input, options) {
        calls.runnerInput = { input, options };
        return {
          finalOutput: [
            'fixed tests',
            'REMOTE_CLI_SESSION_ID=remote-session-1',
            'WORKSPACE=/srv/apps/my-app',
            'GIT_COMMIT=abcdef123456',
            'WHAT_CHANGED=Fixed the failing tests.',
            'VERIFY_COMMANDS=npm test',
            'VERIFY_RESULTS=npm test passed.',
            'PUBLIC_URL=not_available',
            'BLOCKER=none',
            'UI_CHECK_REPORT=/srv/apps/my-app/ui-checks/ui-check-report.json',
            'UI_SCREENSHOT=/srv/apps/my-app/ui-checks/my-app-desktop.png',
          ].join('\n'),
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'gpt-4o',
        directRun: false,
        defaultTargetId: 'prod',
        defaultCwd: '/srv/apps/my-app',
        timeoutMs: 60000,
        maxTurns: 20,
      },
      sdkLoader: () => ({
        Agent: FakeAgent,
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
        OpenAIProvider: FakeOpenAIProvider,
        Runner: FakeRunner,
        setOpenAIAPI: (mode) => calls.apiModes.push(mode),
      }),
    });

    const result = await runner.run({
      task: 'Fix the failing tests',
      waitMs: 30000,
      adminMode: true,
    });

    expect(calls.mcpOptions).toMatchObject({
      url: 'https://gateway.example.com/mcp',
      name: 'remote-cli',
      cacheToolsList: true,
      timeout: 60000,
    });
    expect(calls.mcpOptions.requestInit.headers.Authorization).toBe('Bearer gateway-secret');
    expect(calls.agentConfig.mcpServers).toHaveLength(1);
    expect(calls.agentConfig.instructions).toContain('Default targetId: prod');
    expect(calls.agentConfig.instructions).toContain('Admin runner mode is enabled');
    expect(calls.runnerConfig.model).toBe('gpt-4o');
    expect(calls.runnerInput.input).toContain('Fix the failing tests');
    expect(calls.runnerInput.options.maxTurns).toBe(20);
    expect(calls.apiModes).toEqual(['chat']);
    expect(calls.connected).toBe(true);
    expect(calls.closed).toBe(true);
    expect(result.finalOutput).toContain('fixed tests');
    expect(result).toMatchObject({
      mcpSessionId: 'mcp-session-1',
      targetId: 'prod',
      cwd: '/srv/apps/my-app',
      sessionId: 'remote-session-1',
      gitCommit: 'abcdef123456',
      uiCheckReport: '/srv/apps/my-app/ui-checks/ui-check-report.json',
      uiScreenshots: ['/srv/apps/my-app/ui-checks/my-app-desktop.png'],
      whatChanged: 'Fixed the failing tests.',
      verifyCommands: ['npm test'],
      verifyResults: ['npm test passed.'],
      completionStatus: 'complete',
    });
  });

  test('directly passes remote-cli-agent tasks to remote_code_run by default', async () => {
    const calls = {
      toolCalls: [],
      connected: false,
      closed: false,
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-direct';
      }

      async connect() {
        calls.connected = true;
      }

      async close() {
        calls.closed = true;
      }

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          content: [{
            type: 'text',
            text: [
              'REMOTE_AGENT_RESULT=pwd:/srv/apps/my-app',
              'REMOTE_CLI_SESSION_ID=remote-session-direct',
              'WORKSPACE=/srv/apps/my-app',
              'WHAT_CHANGED=Ran the OpenAI CLI passthrough task on the remote site.',
              'VERIFY_COMMANDS=remote_code_run',
              'VERIFY_RESULTS=REMOTE_AGENT_RESULT=pwd:/srv/apps/my-app',
              'PUBLIC_URL=not_available',
              'BLOCKER=none',
            ].join('\n'),
          }],
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
      }),
    });

    const result = await runner.run({
      task: 'No changes. Run pwd.',
      waitMs: 30000,
    });

    expect(calls.connected).toBe(true);
    expect(calls.closed).toBe(true);
    expect(calls.toolCalls).toEqual([{
      name: 'remote_code_run',
      args: {
        targetId: 'k3s-prod',
        cwd: '/srv/apps/my-app',
        task: expect.stringContaining('No changes. Run pwd.'),
        waitMs: 30000,
      },
    }]);
    expect(calls.toolCalls[0].args.task).toContain('You are already executing through the KimiBuilt remote_code_run gateway target "k3s-prod"');
    expect(calls.toolCalls[0].args.task).toContain('The gateway has placed you in the remote workspace "/srv/apps/my-app"');
    expect(calls.toolCalls[0].args.task).toContain('Do not ask the user for SSH details');
    expect(result).toMatchObject({
      targetId: 'k3s-prod',
      cwd: '/srv/apps/my-app',
      sessionId: 'remote-session-direct',
      completionStatus: 'complete',
      whatChanged: 'Ran the OpenAI CLI passthrough task on the remote site.',
    });
  });

  test('executes leaked remote_code_run JSON through MCP with sanitized arguments', async () => {
    const calls = {
      toolCalls: [],
      runnerInput: null,
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-3';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_123',
                sessionId: 'remote-session-3',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_CLI_JOB_ID=rcli_123',
                'REMOTE_CLI_SESSION_ID=remote-session-3',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Finished the remote task.',
                'VERIFY_COMMANDS=remote_code_status',
                'VERIFY_RESULTS=Remote job completed.',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run(_agent, input) {
        calls.runnerInput = input;
        return {
          finalOutput: '{" output _text ":""," tool _calls ":[{" id ":" call _1 "," name ":" remote _code _run "," arguments ":{" target Id ":" prod "," cwd ":"/ srv /apps /my -app "," command ":"rm -rf /"," shell ":"bash"," wait Ms ": 300 00 }}]," finish _reason ":" tool _call"}',
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'kimi-for-coding',
        directRun: false,
        defaultTargetId: 'prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        Agent: FakeAgent,
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
        OpenAIProvider: FakeOpenAIProvider,
        Runner: FakeRunner,
        setOpenAIAPI: () => {},
      }),
    });

    const result = await runner.run({
      task: 'Fix the deployed game and verify it.',
      waitMs: 30000,
      maxStatusPolls: 3,
      statusPollIntervalMs: 0,
    });

    expect(calls.runnerInput).toContain('Fix the deployed game and verify it.');
    expect(calls.toolCalls[0]).toEqual({
      name: 'remote_code_run',
      args: {
        targetId: 'prod',
        cwd: '/srv/apps/my-app',
        task: expect.stringContaining('Fix the deployed game and verify it.'),
        waitMs: 30000,
      },
    });
    expect(calls.toolCalls[0].args.task).toContain('Do not say that you cannot access the remote server');
    expect(Object.keys(calls.toolCalls[0].args)).not.toContain('command');
    expect(Object.keys(calls.toolCalls[0].args)).not.toContain('shell');
    expect(calls.toolCalls[1]).toEqual({
      name: 'remote_code_status',
      args: { jobId: 'rcli_123' },
    });
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_123',
      sessionId: 'remote-session-3',
      cwd: '/srv/apps/my-app',
      whatChanged: 'Finished the remote task.',
      completionStatus: 'complete',
    });
  });

  test('blocks completed remote_code_status output when task proof markers are missing', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-preview';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_preview',
                sessionId: 'remote-session-preview',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'completed',
                jobId: 'rcli_preview',
                sessionId: 'remote-session-preview',
                stdout: '<!doctype html><html><body><pre>kubectl apply -f k8s/app.yaml</pre></body></html>',
              }),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        return {
          finalOutput: 'I will use the remote runner.',
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'kimi-for-coding',
        directRun: false,
        defaultTargetId: 'prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        Agent: FakeAgent,
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
        OpenAIProvider: FakeOpenAIProvider,
        Runner: FakeRunner,
        setOpenAIAPI: () => {},
      }),
    });

    const result = await runner.run({
      task: 'Deploy the frontend remotely and verify the live route.',
      waitMs: 30000,
      maxStatusPolls: 2,
      statusPollIntervalMs: 0,
    });

    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: expect.stringContaining('Deploy the frontend remotely and verify the live route.'),
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: { jobId: 'rcli_preview' },
      },
    ]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_preview',
      sessionId: 'remote-session-preview',
      cwd: '/srv/apps/my-app',
      completionStatus: 'blocked',
    });
    expect(result.blocker).toContain('without task proof markers');
    expect(result.whatChanged).toBe('remote_code_run transport finished, but task-level changes were not proven.');
    expect(result.verifyResults).toEqual(['remote_code_run reached status completed.']);
    expect(result.finalOutput).toContain('REMOTE_CLI_JOB_ID=rcli_preview');
    expect(result.finalOutput).toContain('BLOCKER=remote_code_run completed without task proof markers');
  });

  test('falls back to direct remote_code_run when the inner agent run times out', async () => {
    const calls = {
      toolCalls: [],
      progress: [],
      runnerCalled: false,
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-timeout';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_timeout',
                sessionId: 'remote-session-timeout',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_CLI_JOB_ID=rcli_timeout',
                'REMOTE_CLI_SESSION_ID=remote-session-timeout',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Finished after direct fallback.',
                'VERIFY_COMMANDS=remote_code_status',
                'VERIFY_RESULTS=Remote job completed.',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        calls.runnerCalled = true;
        return new Promise(() => {});
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'kimi-for-coding',
        directRun: false,
        defaultTargetId: 'prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        Agent: FakeAgent,
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
        OpenAIProvider: FakeOpenAIProvider,
        Runner: FakeRunner,
        setOpenAIAPI: () => {},
      }),
    });

    const result = await runner.run({
      task: 'Deploy the live app and verify it.',
      waitMs: 30000,
      agentRunTimeoutMs: 1,
      maxStatusPolls: 1,
      statusPollIntervalMs: 0,
      onProgress: (progress) => calls.progress.push(progress),
    });

    expect(calls.runnerCalled).toBe(true);
    expect(calls.progress.some((progress) => /falling back to direct remote_code_run/i.test(progress.reasoningSummary))).toBe(true);
    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: expect.stringContaining('Deploy the live app and verify it.'),
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: { jobId: 'rcli_timeout' },
      },
    ]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_timeout',
      sessionId: 'remote-session-timeout',
      cwd: '/srv/apps/my-app',
      whatChanged: 'Finished after direct fallback.',
      completionStatus: 'complete',
    });
  });

  test('forces direct remote_code_run when the inner agent returns partial proof without tool use', async () => {
    const calls = {
      toolCalls: [],
      progress: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-contract';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_contract',
                sessionId: 'remote-session-contract',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_CLI_JOB_ID=rcli_contract',
                'REMOTE_CLI_SESSION_ID=remote-session-contract',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Ran the remote build through the direct fallback.',
                'VERIFY_COMMANDS=remote_code_status',
                'VERIFY_RESULTS=Remote job completed after direct fallback.',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        return {
          finalOutput: [
            'I can help with that remote build.',
            'WHAT_CHANGED=Prepared to inspect the remote workspace.',
            'PUBLIC_URL=not_available',
            'BLOCKER=none',
          ].join('\n'),
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'kimi-for-coding',
        directRun: false,
        defaultTargetId: 'prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        Agent: FakeAgent,
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
        OpenAIProvider: FakeOpenAIProvider,
        Runner: FakeRunner,
        setOpenAIAPI: () => {},
      }),
    });

    const result = await runner.run({
      task: 'Build the frontend remotely and verify the live route.',
      waitMs: 30000,
      maxStatusPolls: 2,
      statusPollIntervalMs: 0,
      onProgress: (progress) => calls.progress.push(progress),
    });

    expect(calls.progress.some((progress) => /without calling remote_code_run/i.test(progress.reasoningSummary))).toBe(true);
    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: expect.stringContaining('Build the frontend remotely and verify the live route.'),
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: { jobId: 'rcli_contract' },
      },
    ]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_contract',
      sessionId: 'remote-session-contract',
      whatChanged: 'Ran the remote build through the direct fallback.',
      verifyResults: ['Remote job completed after direct fallback.'],
      completionStatus: 'complete',
    });
  });

  test('polls an observed remote_code_run job when the inner agent returns no proof markers', async () => {
    const calls = {
      toolCalls: [],
      progress: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-observed';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_observed',
                sessionId: 'remote-session-observed',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_CLI_JOB_ID=rcli_observed',
                'REMOTE_CLI_SESSION_ID=remote-session-observed',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Polled the remote job the inner agent started.',
                'VERIFY_COMMANDS=remote_code_status',
                'VERIFY_RESULTS=Observed remote job completed.',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {
      constructor(config) {
        this.config = config;
      }
    }

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run(agent) {
        await agent.config.mcpServers[0].callTool('remote_code_run', {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: 'Build started by the inner agent.',
          waitMs: 30000,
        });
        return {
          finalOutput: 'Started the remote job and will report back.',
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'kimi-for-coding',
        directRun: false,
        defaultTargetId: 'prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        Agent: FakeAgent,
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
        OpenAIProvider: FakeOpenAIProvider,
        Runner: FakeRunner,
        setOpenAIAPI: () => {},
      }),
    });

    const result = await runner.run({
      task: 'Build the frontend remotely and verify the live route.',
      waitMs: 30000,
      maxStatusPolls: 2,
      statusPollIntervalMs: 0,
      onProgress: (progress) => calls.progress.push(progress),
    });

    expect(calls.progress.some((progress) => /polling remote_code_status for job rcli_observed/i.test(progress.reasoningSummary))).toBe(true);
    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: 'Build started by the inner agent.',
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: { jobId: 'rcli_observed' },
      },
    ]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_observed',
      sessionId: 'remote-session-observed',
      whatChanged: 'Polled the remote job the inner agent started.',
      verifyResults: ['Observed remote job completed.'],
      completionStatus: 'complete',
    });
  });

  test('continues an existing remote_code_run job with status-only polling', async () => {
    const calls = {
      toolCalls: [],
      runnerCalled: false,
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-4';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          content: [{
            type: 'text',
            text: [
              'REMOTE_CLI_JOB_ID=rcli_456',
              'REMOTE_CLI_SESSION_ID=remote-session-4',
              'WHAT_CHANGED=Continued the existing remote job.',
              'VERIFY_COMMANDS=remote_code_status',
              'VERIFY_RESULTS=Remote job completed.',
              'PUBLIC_URL=not_available',
              'BLOCKER=none',
            ].join('\n'),
          }],
        };
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        calls.runnerCalled = true;
        throw new Error('inner agent should not run for jobId continuations');
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'kimi-for-coding',
        directRun: false,
        defaultTargetId: 'prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        Agent: FakeAgent,
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
        OpenAIProvider: FakeOpenAIProvider,
        Runner: FakeRunner,
        setOpenAIAPI: () => {},
      }),
    });

    const result = await runner.run({
      task: 'Continue the remote job.',
      jobId: 'rcli_456',
      maxStatusPolls: 1,
      statusPollIntervalMs: 0,
    });

    expect(calls.runnerCalled).toBe(false);
    expect(calls.toolCalls).toEqual([{
      name: 'remote_code_status',
      args: { jobId: 'rcli_456' },
    }]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_456',
      sessionId: 'remote-session-4',
      whatChanged: 'Continued the existing remote job.',
      completionStatus: 'complete',
    });
  });

  test('wraps runner failures with model, API mode, and gateway diagnostics', async () => {
    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-2';
      }

      async connect() {}

      async close() {}
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        throw new Error('Connection error.');
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'gpt-5.5',
        directRun: false,
        defaultTargetId: 'prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        Agent: FakeAgent,
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
        OpenAIProvider: FakeOpenAIProvider,
        Runner: FakeRunner,
        setOpenAIAPI: () => {},
      }),
    });

    await expect(runner.run({
      task: 'Deploy the app remotely',
      adminMode: true,
    })).rejects.toMatchObject({
      name: 'RemoteCliAgentError',
      code: 'REMOTE_CLI_AGENT_FAILED',
      message: 'remote-cli-agent model run failed (gpt-5.5): Connection error.',
      diagnostics: {
        remoteCliAgent: {
          stage: 'agent_run',
          model: 'gpt-5.5',
          apiMode: 'chat',
          mcpSessionId: 'mcp-session-2',
        },
      },
    });
  });
});

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
    expect(instructions).toContain('Tool shape: call remote_code_run');
    expect(instructions).toContain('Tool shape: call remote_code_status');
    expect(instructions).toContain('do not paste full raw tool JSON or giant command output');
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
    expect(instructions).toContain('GIT_BRANCH');
    expect(instructions).toContain('GIT_BASE_COMMIT');
    expect(instructions).toContain('GIT_COMMIT');
    expect(instructions).toContain('CHANGED_FILES');
    expect(instructions).toContain('git revert');
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
      'GIT_BRANCH=agent/weather-upgrade',
      'GIT_BASE_COMMIT=1111111',
      'GIT_COMMIT=abcdef123456',
      'CHANGED_FILES=src/app.js,k8s/deployment.yaml',
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
      gitBranch: 'agent/weather-upgrade',
      gitBaseCommit: '1111111',
      gitCommit: 'abcdef123456',
      changedFiles: ['src/app.js', 'k8s/deployment.yaml'],
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

  test('reports a short default status poll limit in public config', () => {
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
      },
    });

    expect(runner.getPublicConfig().maxStatusPolls).toBe(3);
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

  test('executes leaked raw remote_code_run tool calls from incompatible chat gateways', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-raw-tool';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          content: [{
            type: 'text',
            text: [
              'REMOTE_CLI_SESSION_ID=remote-session-raw',
              'WORKSPACE=/srv/apps/my-app',
              'WHAT_CHANGED=Explored the remote Tetris workspace.',
              'VERIFY_COMMANDS=remote_code_run',
              'VERIFY_RESULTS=remote_code_run completed through MCP.',
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
        return {
          finalOutput: JSON.stringify({
            output_text: '',
            tool_calls: [{
              id: 'call_1',
              name: 'remote_code_run',
              arguments: {
                targetId: 'prod',
                cwd: '/srv/apps/my-app',
                task: 'Explore the workspace to find the Tetris game files.',
                waitMs: 30000,
              },
            }],
            finish_reason: 'tool_calls',
          }),
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
        agentModel: 'gpt-5.5',
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
      task: 'Explore the workspace to find the Tetris game files.',
      adminMode: true,
    });

    expect(calls.toolCalls).toEqual([{
      name: 'remote_code_run',
      args: {
        targetId: 'prod',
        cwd: '/srv/apps/my-app',
        task: 'Explore the workspace to find the Tetris game files.',
        waitMs: 30000,
      },
    }]);
    expect(result.finalOutput).toContain('Explored the remote Tetris workspace.');
    expect(result).toMatchObject({
      sessionId: 'remote-session-raw',
      cwd: '/srv/apps/my-app',
      whatChanged: 'Explored the remote Tetris workspace.',
      completionStatus: 'complete',
    });
  });

  test('executes token-spaced leaked remote_code_run output from chat gateway traces', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-spaced-tool';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          content: [{
            type: 'text',
            text: [
              'REMOTE_CLI_SESSION_ID=remote-session-spaced',
              'WORKSPACE=/srv/apps/my-app',
              'WHAT_CHANGED=Applied the live remote CLI fallback.',
              'VERIFY_COMMANDS=remote_code_run',
              'VERIFY_RESULTS=remote_code_run completed through MCP after spaced JSON extraction.',
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
        return {
          finalOutput: '{" output _text ":""," tool _calls ":[{" id ":" call _ 1 "," name ":" remote _code _run "," arguments ":{" target Id ":" prod "," cwd ":"/ srv /apps /my -app "," wait Ms ": 300 00 ," task ":" Explore the workspace at / srv /apps /my -app to find the Tet ris game project ." }} ]," finish _reason ":" tool _calls "}',
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
        agentModel: 'gpt-5.5',
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

    const cleanTask = 'Explore the workspace at /srv/apps/my-app to find the Tetris game project.';
    const result = await runner.run({
      task: cleanTask,
      adminMode: true,
    });

    expect(calls.toolCalls).toEqual([{
      name: 'remote_code_run',
      args: {
        targetId: 'prod',
        cwd: '/srv/apps/my-app',
        task: cleanTask,
        waitMs: 30000,
      },
    }]);
    expect(result.finalOutput).toContain('Applied the live remote CLI fallback.');
    expect(result).toMatchObject({
      sessionId: 'remote-session-spaced',
      cwd: '/srv/apps/my-app',
      whatChanged: 'Applied the live remote CLI fallback.',
      completionStatus: 'complete',
    });
  });

  test('polls leaked remote_code_run jobs until remote_code_status returns completion markers', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-polling-tool';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            structuredContent: {
              status: 'running',
              jobId: 'job-123',
              sessionId: 'remote-session-poll',
            },
            content: [{
              type: 'text',
              text: '{"status":"running","jobId":"job-123","sessionId":"remote-session-poll"}',
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: [
              'Finished remote Tetris deploy.',
              'REMOTE_CLI_SESSION_ID=remote-session-poll',
              'WORKSPACE=/srv/apps/my-app',
              'WHAT_CHANGED=Finished the remote job after polling status.',
              'VERIFY_COMMANDS=curl https://awesome.demoserver2.buzz/',
              'VERIFY_RESULTS=Public Tetris page returned the updated theme controls.',
              'PUBLIC_URL=https://awesome.demoserver2.buzz/',
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
        return {
          finalOutput: JSON.stringify({
            output_text: '',
            tool_calls: [{
              id: 'call_1',
              name: 'remote_code_run',
              arguments: {
                targetId: 'prod',
                cwd: '/srv/apps/my-app',
                task: 'Update and launch the Tetris themes.',
                waitMs: 30000,
              },
            }],
            finish_reason: 'tool_calls',
          }),
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
        agentModel: 'gpt-5.5',
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
      task: 'Update and launch the Tetris themes.',
      adminMode: true,
    });

    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: 'Update and launch the Tetris themes.',
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: {
          targetId: 'prod',
          sessionId: 'remote-session-poll',
          jobId: 'job-123',
          waitMs: 30000,
        },
      },
    ]);
    expect(result.finalOutput).toContain('Finished remote Tetris deploy.');
    expect(result).toMatchObject({
      sessionId: 'remote-session-poll',
      cwd: '/srv/apps/my-app',
      whatChanged: 'Finished the remote job after polling status.',
      publicUrl: 'https://awesome.demoserver2.buzz/',
      completionStatus: 'complete',
    });
  });

  test('does not mark leaked remote_code_run fallback complete while the remote job is still running', async () => {
    const calls = {
      toolCalls: [],
    };
    const noisyStdout = 'still-running-output '.repeat(1000);

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-still-running';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          structuredContent: {
            status: 'running',
            jobId: 'job-still-running',
            sessionId: 'remote-session-still-running',
            stdout: noisyStdout,
          },
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'running',
              jobId: 'job-still-running',
              sessionId: 'remote-session-still-running',
              stdout: noisyStdout,
            }),
          }],
        };
      }
    }

    class FakeAgent {}
    class FakeOpenAIProvider {}
    class FakeRunner {
      async run() {
        return {
          finalOutput: JSON.stringify({
            output_text: '',
            tool_calls: [{
              id: 'call_1',
              name: 'remote_code_run',
              arguments: {
                targetId: 'prod',
                cwd: '/srv/apps/my-app',
                task: 'Launch the Tetris game.',
                waitMs: 30000,
              },
            }],
            finish_reason: 'tool_calls',
          }),
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
        agentModel: 'gpt-5.5',
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
      task: 'Launch the Tetris game.',
      adminMode: true,
      maxStatusPolls: 2,
    });

    expect(calls.toolCalls).toHaveLength(3);
    expect(calls.toolCalls.map((call) => call.name)).toEqual([
      'remote_code_run',
      'remote_code_status',
      'remote_code_status',
    ]);
    expect(result).toMatchObject({
      sessionId: 'remote-session-still-running',
      remoteCodeJobId: 'job-still-running',
      blocker: 'remote_code_run still running; continue with the returned remote session/job id',
      completionStatus: 'blocked',
    });
    expect(result.finalOutput).toContain('REMOTE_CLI_JOB_ID=job-still-running');
    expect(result.finalOutput).toContain('remote_code_status remained running after 2 poll attempt(s).');
    expect(result.finalOutput).not.toContain(noisyStdout);
    expect(result.finalOutput.length).toBeLessThan(1500);
  });

  test('detects running status when the MCP gateway returns a raw content array', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-array-content';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return [{
            type: 'text',
            text: JSON.stringify({
              id: 'job-array-content',
              targetId: 'prod',
              cwd: '/srv/apps/my-app',
              status: 'running',
            }),
          }];
        }

        return [{
          type: 'text',
          text: [
            'Finished array content polling smoke.',
            'WORKSPACE=/srv/apps/my-app',
            'WHAT_CHANGED=Polled raw content array job to completion.',
            'VERIFY_COMMANDS=remote_code_status',
            'VERIFY_RESULTS=remote_code_status returned completion markers.',
            'PUBLIC_URL=not_available',
            'BLOCKER=none',
          ].join('\n'),
        }];
      }
    }

    class FakeAgent {}
    class FakeOpenAIProvider {}
    class FakeRunner {
      async run() {
        return {
          finalOutput: JSON.stringify({
            output_text: '',
            tool_calls: [{
              id: 'call_1',
              name: 'remote_code_run',
              arguments: {
                targetId: 'prod',
                cwd: '/srv/apps/my-app',
                task: 'Run the content-array polling smoke.',
                waitMs: 1000,
              },
            }],
            finish_reason: 'tool_calls',
          }),
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
        agentModel: 'gpt-5.5',
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
      task: 'Run the content-array polling smoke.',
      adminMode: true,
      maxStatusPolls: 3,
    });

    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: 'Run the content-array polling smoke.',
          waitMs: 1000,
        },
      },
      {
        name: 'remote_code_status',
        args: {
          targetId: 'prod',
          jobId: 'job-array-content',
          waitMs: 1000,
        },
      },
    ]);
    expect(result).toMatchObject({
      cwd: '/srv/apps/my-app',
      whatChanged: 'Polled raw content array job to completion.',
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

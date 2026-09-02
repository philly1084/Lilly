describe('remote CLI MCP configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'sk-openai-test',
      REMOTE_CLI_MCP_URL: 'https://gateway.example/mcp',
    };
    delete process.env.REMOTE_CLI_MCP_BEARER_TOKEN;
    delete process.env.N8N_API_KEY;
    delete process.env.REMOTE_CLI_AGENT_TRANSPORT;
    delete process.env.REMOTE_CLI_CODEX_AGENT_BASE_URL;
    delete process.env.REMOTE_CLI_CODEX_AGENT_BEARER_TOKEN;
    delete process.env.REMOTE_CLI_CODEX_AGENT_WORKSPACE_PATH;
    delete process.env.REMOTE_CLI_CODEX_AGENT_MODEL;
    delete process.env.CODEX_AGENT_MODEL;
    delete process.env.FRONTEND_API_KEY;
    delete process.env.REMOTE_CLI_AGENT_MODEL;
    delete process.env.REMOTE_CLI_REMOTE_CODE_MODEL;
    delete process.env.REMOTE_CODE_MODEL;
    delete process.env.REMOTE_CLI_AGENT_DIRECT_RUN;
    delete process.env.REMOTE_CLI_AGENT_RUN_TIMEOUT_MS;
    delete process.env.REMOTE_CLI_AGENT_MAX_STATUS_POLLS;
    delete process.env.REMOTE_CLI_AGENT_STATUS_POLL_INTERVAL_MS;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  test('does not reuse OPENAI_API_KEY as the MCP gateway bearer token', () => {
    const { config } = require('./config');

    expect(config.remoteCliMcp.apiKey).toBe('');
    expect(config.remoteCliMcp.agentApiKey).toBe('sk-openai-test');
  });

  test('uses only explicit MCP gateway bearer tokens for MCP auth', () => {
    process.env.REMOTE_CLI_MCP_BEARER_TOKEN = 'mcp-token';

    const { config } = require('./config');

    expect(config.remoteCliMcp.apiKey).toBe('mcp-token');
  });

  test('does not inherit the general chat model for the remote CLI agent lane by default', () => {
    process.env.OPENAI_MODEL = 'kimi-for-coding';

    const { config } = require('./config');

    expect(config.remoteCliMcp.agentModel).toBe('gpt-5.4');
  });

  test('allows the remote CLI agent model to be explicitly configured', () => {
    process.env.REMOTE_CLI_AGENT_MODEL = 'gpt-5.4-mini';

    const { config } = require('./config');

    expect(config.remoteCliMcp.agentModel).toBe('gpt-5.4-mini');
  });

  test('uses automatic transport selection and the gateway polling defaults', () => {
    const { config } = require('./config');

    expect(config.remoteCliMcp.transport).toBe('auto');
    expect(config.remoteCliMcp.remoteCodeModel).toBe('');
    expect(config.remoteCliMcp.directRun).toBe(true);
    expect(config.remoteCliMcp.agentRunTimeoutMs).toBe(720000);
    expect(config.remoteCliMcp.maxStatusPolls).toBe(20);
    expect(config.remoteCliMcp.statusPollIntervalMs).toBe(2000);
  });

  test('configures the codex-agent run/events transport explicitly', () => {
    process.env.REMOTE_CLI_AGENT_TRANSPORT = 'codex-agent';
    process.env.REMOTE_CLI_CODEX_AGENT_BASE_URL = 'https://gateway.example';
    process.env.FRONTEND_API_KEY = 'frontend-key';
    process.env.REMOTE_CLI_CODEX_AGENT_WORKSPACE_PATH = '/srv/apps/my-app';

    const { config } = require('./config');

    expect(config.remoteCliMcp.transport).toBe('codex-agent');
    expect(config.remoteCliMcp.codexAgentBaseUrl).toBe('https://gateway.example');
    expect(config.remoteCliMcp.codexAgentApiKey).toBe('frontend-key');
    expect(config.remoteCliMcp.codexAgentWorkspacePath).toBe('/srv/apps/my-app');
    expect(config.remoteCliMcp.codexAgentApprovalPolicy).toBe('never');
    expect(config.remoteCliMcp.codexAgentModel).toBe('');
  });

  test('allows the codex-agent run/events model to be explicitly configured separately', () => {
    process.env.REMOTE_CLI_CODEX_AGENT_MODEL = 'codex-latest';

    const { config } = require('./config');

    expect(config.remoteCliMcp.codexAgentModel).toBe('codex-latest');
  });

  test('allows the remote_code_run model and status polling to be explicitly configured', () => {
    process.env.REMOTE_CLI_REMOTE_CODE_MODEL = 'openai/gpt-5.4-mini';
    process.env.REMOTE_CLI_AGENT_RUN_TIMEOUT_MS = '5000';
    process.env.REMOTE_CLI_AGENT_MAX_STATUS_POLLS = '7';
    process.env.REMOTE_CLI_AGENT_STATUS_POLL_INTERVAL_MS = '25';

    const { config } = require('./config');

    expect(config.remoteCliMcp.remoteCodeModel).toBe('openai/gpt-5.4-mini');
    expect(config.remoteCliMcp.agentRunTimeoutMs).toBe(5000);
    expect(config.remoteCliMcp.maxStatusPolls).toBe(7);
    expect(config.remoteCliMcp.statusPollIntervalMs).toBe(25);
  });

  test('allows long remote_code_status polling windows used by live deploy config', () => {
    process.env.REMOTE_CLI_AGENT_MAX_STATUS_POLLS = '90';

    const { config } = require('./config');

    expect(config.remoteCliMcp.maxStatusPolls).toBe(90);
  });

  test('allows bounded provider-agent waits longer than the old fifteen-minute ceiling', () => {
    process.env.REMOTE_CLI_AGENT_RUN_TIMEOUT_MS = '1800000';

    let loaded = require('./config').config;
    expect(loaded.remoteCliMcp.agentRunTimeoutMs).toBe(1800000);

    jest.resetModules();
    process.env.REMOTE_CLI_AGENT_RUN_TIMEOUT_MS = '9999999';
    loaded = require('./config').config;
    expect(loaded.remoteCliMcp.agentRunTimeoutMs).toBe(3600000);
  });

  test('allows the legacy inner-agent remote CLI mode to be explicitly restored', () => {
    process.env.REMOTE_CLI_AGENT_DIRECT_RUN = 'false';

    const { config } = require('./config');

    expect(config.remoteCliMcp.directRun).toBe(false);
  });

});

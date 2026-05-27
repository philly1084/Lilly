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

  test('uses the gateway remote_code_run model and status polling defaults', () => {
    const { config } = require('./config');

    expect(config.remoteCliMcp.remoteCodeModel).toBe('');
    expect(config.remoteCliMcp.directRun).toBe(true);
    expect(config.remoteCliMcp.agentRunTimeoutMs).toBe(180000);
    expect(config.remoteCliMcp.maxStatusPolls).toBe(3);
    expect(config.remoteCliMcp.statusPollIntervalMs).toBe(2000);
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

  test('allows the legacy inner-agent remote CLI mode to be explicitly restored', () => {
    process.env.REMOTE_CLI_AGENT_DIRECT_RUN = 'false';

    const { config } = require('./config');

    expect(config.remoteCliMcp.directRun).toBe(false);
  });

});

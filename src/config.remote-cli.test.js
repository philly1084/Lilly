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
    delete process.env.REMOTE_CLI_AGENT_MAX_STATUS_POLLS;
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

  test('defaults remote CLI fallback status polling to a short resumable window', () => {
    const { config } = require('./config');

    expect(config.remoteCliMcp.maxStatusPolls).toBe(3);
  });

  test('does not inherit the general chat model for the remote CLI agent lane', () => {
    process.env.OPENAI_MODEL = 'kimi-for-coding';

    const { config } = require('./config');

    expect(config.remoteCliMcp.agentModel).toBe('gpt-5.5');
  });

  test('allows the remote CLI agent model to be explicitly configured', () => {
    process.env.REMOTE_CLI_AGENT_MODEL = 'gpt-5.4-mini';

    const { config } = require('./config');

    expect(config.remoteCliMcp.agentModel).toBe('gpt-5.4-mini');
  });

  test('allows remote CLI fallback status polling to be explicitly increased', () => {
    process.env.REMOTE_CLI_AGENT_MAX_STATUS_POLLS = '7';

    const { config } = require('./config');

    expect(config.remoteCliMcp.maxStatusPolls).toBe(7);
  });
});

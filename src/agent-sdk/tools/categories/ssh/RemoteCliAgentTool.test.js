const { RemoteCliAgentTool } = require('./RemoteCliAgentTool');

function buildTool() {
  const runner = {
    run: jest.fn(async (params) => ({
      finalOutput: 'ok',
      observedParams: params,
    })),
  };
  return {
    runner,
    tool: new RemoteCliAgentTool({ runner }),
  };
}

describe('RemoteCliAgentTool', () => {
  test('normalizes common orchestrator aliases before required task validation', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      prompt: 'Fix and redeploy the calendar app.',
      admin_mode: 'true',
      wait_ms: '45000',
      target_id: 'prod',
      remote_code_model: 'openai/gpt-5.5',
      mcp_session_id: 'mcp-1',
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Fix and redeploy the calendar app.',
      adminMode: true,
      waitMs: 45000,
      targetId: 'prod',
      remoteCodeModel: 'openai/gpt-5.5',
      mcpSessionId: 'mcp-1',
    }));
  });

  test('recovers task and target fields from a leaked remote_code_run wrapper', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      arguments: JSON.stringify({
        name: 'remote_code_run',
        arguments: {
          targetId: 'prod',
          cwd: '/srv/apps/demo',
          task: 'Continue the remote build and verify HTTPS.',
          waitMs: 30000,
        },
      }),
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'prod',
      cwd: '/srv/apps/demo',
      task: 'Continue the remote build and verify HTTPS.',
      waitMs: 30000,
    }));
  });

  test('reports a lane-specific error when a raw command is sent without a task', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      command: 'kubectl get pods -A',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('remote-cli-agent expects params.task');
    expect(result.error).toContain('Use remote-command');
    expect(result.errorCode).toBe('REMOTE_CLI_AGENT_TASK_REQUIRED');
    expect(runner.run).not.toHaveBeenCalled();
  });
});

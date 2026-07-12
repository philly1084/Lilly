const fs = require('fs');
const os = require('os');
const path = require('path');
const { RemoteCliAgentTool } = require('./RemoteCliAgentTool');
const { clusterStateRegistry } = require('../../../../cluster-state-registry');

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
  let storageDir;
  let originalStoragePath;

  beforeEach(() => {
    originalStoragePath = clusterStateRegistry.getStoragePath();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-remote-cli-tool-'));
    clusterStateRegistry.setStoragePathForTests(path.join(storageDir, 'cluster-state-registry.json'));
  });

  afterEach(() => {
    clusterStateRegistry.setStoragePathForTests(originalStoragePath);
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

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

  test('inherits the selected chat model for model-aware remote CLI routing', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      task: 'Build and verify the remote app.',
    }, {
      model: 'grok-build',
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Build and verify the remote app.',
      model: 'grok-build',
    }));
  });

  test('does not send an unsupported header model into the Codex agent lane', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      task: 'Inspect the remote app.',
    }, {
      model: 'deepseek-v4-flash',
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.not.objectContaining({
      model: 'deepseek-v4-flash',
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

  test('strips outer remote-cli-agent wording before passing task to the runner', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      task: 'Use remote-cli-agent once for a streamed live reasoning proof on k3s-prod in /opt/kimibuilt. Print hostname and pwd only.',
      targetId: 'k3s-prod',
      cwd: '/opt/kimibuilt',
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Run a streamed live reasoning proof on k3s-prod in /opt/kimibuilt. Print hostname and pwd only.',
      targetId: 'k3s-prod',
      cwd: '/opt/kimibuilt',
    }));
  });

  test('advertises the runner poll default and normalizes status poll aliases', async () => {
    const { tool, runner } = buildTool();

    expect(tool.inputSchema.properties.maxStatusPolls.default).toBe(20);

    const result = await tool.execute({
      task: 'Continue the remote build.',
      max_status_polls: '21',
      status_poll_interval_ms: '1500',
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Continue the remote build.',
      maxStatusPolls: 21,
      statusPollIntervalMs: 1500,
    }));
  });

  test('reuses same-session remote context for continuation tasks and passes a continuity brief', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      task: 'Continue that deployment and verify it.',
    }, {
      session: {
        controlState: {
          remoteCliAgent: {
            sessionId: 'rcli_calan_session',
            targetId: 'k3s-prod',
            cwd: '/srv/apps/calan-calendar',
            gitRepo: 'https://gitlab.demoserver2.buzz/agent-apps/calan-calendar.git',
            gitBranch: 'agent/calan-calendar',
            gitCommit: 'abc1234',
            changedFiles: ['src/app.js'],
            publicHost: 'calan.demoserver2.buzz',
            publicUrl: 'https://calan.demoserver2.buzz',
            uiCheckReport: '/srv/apps/calan-calendar/ui-checks/report.json',
            uiScreenshots: ['/srv/apps/calan-calendar/ui-checks/desktop.png'],
            verifyCommands: ['node /app/bin/kimibuilt-ui-check.js https://calan.demoserver2.buzz --out ui-checks'],
            verifyResults: ['UI check passed.'],
            whatChanged: 'Updated the calendar UI.',
            completionStatus: 'complete',
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Continue that deployment and verify it.',
      sessionId: 'rcli_calan_session',
      targetId: 'k3s-prod',
      cwd: '/srv/apps/calan-calendar',
      continuitySummary: expect.stringContaining('Current conversation remote-cli-agent state'),
    }));
    expect(runner.run.mock.calls[0][0].continuitySummary).toContain('calan.demoserver2.buzz');
    expect(runner.run.mock.calls[0][0].continuitySummary).toContain('https://calan.demoserver2.buzz');
    expect(runner.run.mock.calls[0][0].continuitySummary).toContain('/srv/apps/calan-calendar/ui-checks/report.json');
    expect(runner.run.mock.calls[0][0].continuitySummary).toContain('/srv/apps/calan-calendar/ui-checks/desktop.png');
    expect(runner.run.mock.calls[0][0].continuitySummary).toContain('UI check passed.');
    expect(runner.run.mock.calls[0][0].continuitySummary).toContain('Updated the calendar UI.');
  });

  test('does not blindly reuse prior remote context when the task names a different domain', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      task: 'Build a new weather app at weather.demoserver2.buzz.',
    }, {
      session: {
        controlState: {
          remoteCliAgent: {
            sessionId: 'rcli_calan_session',
            targetId: 'k3s-prod',
            cwd: '/srv/apps/calan-calendar',
            publicHost: 'calan.demoserver2.buzz',
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.not.objectContaining({
      sessionId: 'rcli_calan_session',
      cwd: '/srv/apps/calan-calendar',
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

const { RemoteWorkbenchTool } = require('./RemoteWorkbenchTool');

function buildTool() {
  const remoteCommand = {
    handler: jest.fn(async (params) => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      duration: 1,
      host: 'runner:test',
      observedParams: params,
    })),
  };
  const tool = new RemoteWorkbenchTool({ remoteCommand });
  return { tool, remoteCommand };
}

describe('RemoteWorkbenchTool', () => {
  test('maps read-file to an inspect-profile remote command', async () => {
    const { tool, remoteCommand } = buildTool();

    const result = await tool.handler({
      action: 'read-file',
      path: 'src/config.js',
      cwd: '/srv/kimibuilt',
      lineCount: 40,
    }, {}, { recordExecution: jest.fn() });

    expect(result.profile).toBe('inspect');
    expect(remoteCommand.handler).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: 'inspect',
        workingDirectory: '/srv/kimibuilt',
        command: expect.stringContaining("sed -n '1,40p'"),
        workflowAction: 'remote-workbench-read-file',
      }),
      expect.objectContaining({ toolId: 'remote-workbench' }),
      expect.any(Object),
    );
  });

  test('stages write-file content and uses the build runner profile', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'write-file',
      path: 'README.md',
      content: '# Updated\n',
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('build');
    expect(params.command).toContain('cp -- "$source_file" "$target"');
    expect(params.contextFiles).toEqual([
      expect.objectContaining({
        filename: 'remote-workbench-write.txt',
        content: '# Updated\n',
      }),
    ]);
  });

  test('stages apply-patch diffs and validates with git apply --check', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'apply-patch',
      patch: [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('build');
    expect(params.command).toContain('git apply --check "$patch_file"');
    expect(params.contextFiles).toEqual([
      expect.objectContaining({
        filename: 'remote-workbench.patch',
        mimeType: 'text/x-diff',
      }),
    ]);
  });

  test('maps rollout to the deploy runner profile', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'rollout',
      namespace: 'kimibuilt',
      deployment: 'backend',
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('deploy');
    expect(params.environment).toEqual(expect.objectContaining({
      NAMESPACE: 'kimibuilt',
      DEPLOYMENT: 'backend',
    }));
    expect(params.command).toContain('kubectl rollout status deployment/"$app"');
  });

  test('deploy-verify retries self-signed TLS with an explicit availability probe', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'deploy-verify',
      namespace: 'web',
      deployment: 'game',
      publicHost: 'game.example.com',
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('deploy');
    expect(params.environment).toEqual(expect.objectContaining({
      NAMESPACE: 'web',
      DEPLOYMENT: 'game',
      PUBLIC_HOST: 'game.example.com',
    }));
    expect(params.command).toContain('set -e');
    expect(params.command).toContain('curl -fsSIL --max-time 20 "https://$host"');
    expect(params.command).toContain('curl -k -fsSIL --max-time 20 "https://$host"');
    expect(params.command).toContain('__KIMIBUILT_TLS_TRUSTED__=false');
    expect(params.command).toContain('__KIMIBUILT_UI_BODY_BYTES__');
  });

  test('maps ui-visual-check to the Playwright helper with public URL environment', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'ui-visual-check',
      publicUrl: 'https://demo.example.com',
      uiCheckDir: 'ui-checks/demo',
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('inspect');
    expect(params.environment).toEqual(expect.objectContaining({
      PUBLIC_URL: 'https://demo.example.com',
      UI_CHECK_DIR: 'ui-checks/demo',
    }));
    expect(params.command).toContain('/app/bin/kimibuilt-ui-check.js');
    expect(params.command).toContain('UI_CHECK_DIR');
  });

  test('rejects traversal paths before delegating to remote-command', async () => {
    const { tool, remoteCommand } = buildTool();

    await expect(tool.handler({
      action: 'read-file',
      path: '../secret.txt',
    }, {}, { recordExecution: jest.fn() })).rejects.toThrow('path traversal');

    expect(remoteCommand.handler).not.toHaveBeenCalled();
  });
});

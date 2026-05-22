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

  test('prepares a git-backed agent branch with baseline markers', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'git-prepare',
      branch: 'agent/test-run',
      cwd: '/workspace/demo',
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('build');
    expect(params.workingDirectory).toBe('/workspace/demo');
    expect(params.environment).toEqual(expect.objectContaining({
      GIT_BRANCH: 'agent/test-run',
    }));
    expect(params.command).toContain('git init');
    expect(params.command).toContain('__KIMIBUILT_GIT_BASE_COMMIT__');
    expect(params.command).toContain('git checkout -b "$branch"');
  });

  test('captures a git diff snapshot with base commit evidence', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'git-snapshot',
      baseCommit: 'abc1234',
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('inspect');
    expect(params.environment).toEqual(expect.objectContaining({
      GIT_BASE_COMMIT: 'abc1234',
    }));
    expect(params.command).toContain('__KIMIBUILT_GIT_CHANGED_FILES__');
    expect(params.command).toContain('git diff --no-ext-diff --binary "${base:-HEAD}"');
  });

  test('commits staged remote workspace changes with a visible commit marker', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'git-commit',
      commitMessage: 'feat: upgrade remote demo',
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('build');
    expect(params.environment).toEqual(expect.objectContaining({
      GIT_COMMIT_MESSAGE: 'feat: upgrade remote demo',
    }));
    expect(params.command).toContain('git add -A');
    expect(params.command).toContain('__KIMIBUILT_GIT_COMMIT__=$(git rev-parse HEAD)');
  });

  test('reverts a prior remote workspace commit with a rollback marker', async () => {
    const { tool, remoteCommand } = buildTool();

    await tool.handler({
      action: 'git-revert',
      revertCommit: 'HEAD',
      commitMessage: 'revert: remote demo upgrade',
    }, {}, { recordExecution: jest.fn() });

    const params = remoteCommand.handler.mock.calls[0][0];
    expect(params.profile).toBe('build');
    expect(params.environment).toEqual(expect.objectContaining({
      GIT_REVERT_COMMIT: 'HEAD',
      GIT_COMMIT_MESSAGE: 'revert: remote demo upgrade',
    }));
    expect(params.command).toContain('git revert --no-edit "$target"');
    expect(params.command).toContain('__KIMIBUILT_GIT_REVERTED_COMMIT__');
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

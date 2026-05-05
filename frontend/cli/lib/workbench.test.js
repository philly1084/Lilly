const workbench = require('./workbench');

describe('CLI workbench command planning', () => {
  test('parses shell-style aliases and git aliases', () => {
    expect(workbench.parseWorkbenchAlias('pwd')).toEqual(expect.objectContaining({
      command: 'pwd',
    }));
    expect(workbench.parseWorkbenchAlias('git status')).toEqual(expect.objectContaining({
      command: 'git-status',
    }));
    expect(workbench.parseWorkbenchAlias('git diff src/app.js')).toEqual(expect.objectContaining({
      command: 'git-diff',
      args: 'src/app.js',
    }));
    expect(workbench.parseWorkbenchAlias('explain this repo')).toBeNull();
  });

  test('builds a validated cd command', () => {
    const planned = workbench.buildRemoteWorkbenchCommand({
      command: 'cd',
      args: 'apps/demo',
    });

    expect(planned.profile).toBe('inspect');
    expect(planned.updateCwdFromStdout).toBe(true);
    expect(planned.command).toContain("target='apps/demo'");
    expect(planned.command).toContain('test -d "$target"');
    expect(planned.command).toContain('pwd');
  });

  test('search prefers rg when the runner reports it available', () => {
    const planned = workbench.buildRemoteWorkbenchCommand({
      command: 'search',
      args: 'needle src',
    }, {
      runtime: {
        remoteRunner: {
          availableCliTools: ['rg'],
        },
      },
    });

    expect(planned.command).toContain('rg --line-number');
    expect(planned.command).toContain("'needle'");
    expect(planned.command).toContain("'src'");
  });

  test('search falls back to portable grep', () => {
    const planned = workbench.buildRemoteWorkbenchCommand({
      command: 'search',
      args: 'needle',
    }, {
      runtime: {
        remoteRunner: {
          availableCliTools: ['git'],
        },
      },
    });

    expect(planned.command).toContain('grep -R --line-number');
    expect(planned.command).toContain('--exclude-dir=node_modules');
  });

  test('builds deploy sequence with k3s deploy then HTTPS verify', () => {
    const steps = workbench.buildDeploySequence({
      runtime: {
        deployDefaults: {
          repositoryUrl: 'https://github.com/example/app.git',
          branch: 'master',
          targetDirectory: '/opt/app',
          manifestsPath: 'k8s',
          namespace: 'kimibuilt',
          deployment: 'backend',
          container: 'backend',
          publicDomain: 'app.example.com',
        },
      },
    });

    expect(steps.map((step) => step.label)).toEqual([
      'sync-and-apply',
      'rollout-status',
      'https-verify',
    ]);
    expect(steps[0]).toEqual(expect.objectContaining({
      type: 'k3s-deploy',
      params: expect.objectContaining({
        action: 'sync-and-apply',
        repositoryUrl: 'https://github.com/example/app.git',
        namespace: 'kimibuilt',
      }),
    }));
    expect(steps[2]).toEqual(expect.objectContaining({
      type: 'remote-command',
      profile: 'inspect',
    }));
    expect(steps[2].command).toContain("host='app.example.com'");
    expect(steps[2].command).toContain('curl -k -fsSIL --max-time 20 "https://$host"');
    expect(steps[2].command).toContain('__KIMIBUILT_UI_BODY_BYTES__');
  });

  test('resolves remote cwd from config before runner default', () => {
    expect(workbench.resolveActiveRemoteCwd({}, {
      remoteCwd: '/workspace/app',
      remoteDefaultCwd: '/workspace',
    })).toBe('/workspace/app');

    expect(workbench.resolveDefaultRemoteCwd({
      runtime: {
        remoteRunner: {
          defaultWorkspace: '/workspace',
        },
      },
    }, {})).toBe('/workspace');
  });
});

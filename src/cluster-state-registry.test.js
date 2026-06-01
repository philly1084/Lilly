const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('./routes/admin/settings.controller', () => ({
  getEffectiveSshConfig: jest.fn(() => ({
    enabled: true,
    host: 'ubuntu-32gb-fsn1-2',
    port: 22,
    username: 'ubuntu',
  })),
  getEffectiveDeployConfig: jest.fn(() => ({
    repositoryUrl: 'https://github.com/example/app.git',
    targetDirectory: '/opt/kimibuilt',
    manifestsPath: 'k8s',
    namespace: 'web',
    deployment: 'site',
    container: 'site',
    branch: 'main',
    publicDomain: 'game.demoserver2.buzz',
    ingressClassName: 'traefik',
    tlsClusterIssuer: 'letsencrypt-prod',
  })),
}));

const { ClusterStateRegistry } = require('./cluster-state-registry');

describe('ClusterStateRegistry', () => {
  let registry;
  let storageDir;
  let storagePath;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-cluster-registry-'));
    storagePath = path.join(storageDir, 'cluster-state-registry.json');
    registry = new ClusterStateRegistry();
    registry.setStoragePathForTests(storagePath);
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  test('records deploy and verification context from remote tool events', () => {
    registry.recordToolEvents({
      objective: 'Deploy the game host to game.demoserver2.buzz and verify ingress, TLS, HTTPS, /app/index.html, and the nginx site file.',
      controlState: {
        lastSshTarget: {
          host: 'ubuntu-32gb-fsn1-2',
          username: 'ubuntu',
          port: 22,
        },
      },
      toolEvents: [
        {
          toolCall: {
            function: {
              name: 'k3s-deploy',
              arguments: JSON.stringify({
                repositoryUrl: 'https://github.com/example/app.git',
                ref: 'main',
                targetDirectory: '/opt/kimibuilt',
                manifestsPath: 'k8s',
                namespace: 'web',
                deployment: 'site',
              }),
            },
          },
          result: {
            success: true,
            toolId: 'k3s-deploy',
            timestamp: '2026-04-18T12:00:00.000Z',
            data: {
              action: 'sync-and-apply',
              host: 'ubuntu-32gb-fsn1-2:22',
              command: 'kubectl rollout status deployment/site -n \'web\' --timeout=180s',
              stdout: 'deployment "site" successfully rolled out',
            },
          },
          reason: 'Run the standard k3s deployment flow.',
        },
        {
          toolCall: {
            function: {
              name: 'remote-command',
              arguments: JSON.stringify({
                workflowAction: 'verify-deployment',
                command: [
                  'set -e',
                  'kubectl rollout status deployment/site -n \'web\' --timeout=180s',
                  'kubectl get svc,ingress -n \'web\'',
                  'expected_host=\'game.demoserver2.buzz\'',
                  'tls_secret=$(kubectl get ingress -n \'web\' -o jsonpath=\'{range .items[*].spec.tls[*]}{.secretName}{"\\n"}{end}\' | grep -v \'^$\' | head -n 1 || true)',
                  'kubectl get secret "$tls_secret" -n \'web\' >/dev/null',
                  'curl -fsSIL --max-time 20 "https://$host"',
                  'find /app -maxdepth 2 -type f',
                  'ls /etc/nginx/sites-available/game.demoserver2.buzz',
                ].join('\n'),
              }),
            },
          },
          result: {
            success: true,
            toolId: 'remote-command',
            timestamp: '2026-04-18T12:05:00.000Z',
            data: {
              host: 'ubuntu-32gb-fsn1-2:22',
              stdout: [
                '--- ingress hosts ---',
                'game.demoserver2.buzz',
                'HTTP/2 200',
                '/app/index.html',
                '/etc/nginx/sites-available/game.demoserver2.buzz',
              ].join('\n'),
            },
          },
          reason: 'Verify ingress, TLS, and public HTTPS.',
        },
      ],
    });

    const deployments = registry.listDeployments();
    expect(deployments).toHaveLength(1);
    expect(deployments[0]).toEqual(expect.objectContaining({
      host: 'ubuntu-32gb-fsn1-2',
      namespace: 'web',
      deployment: 'site',
      publicDomain: 'game.demoserver2.buzz',
    }));
    expect(deployments[0].verification).toEqual(expect.objectContaining({
      rollout: true,
      ingress: true,
      tls: true,
      https: true,
    }));
    expect(deployments[0].paths).toEqual(expect.arrayContaining([
      '/app/index.html',
      '/etc/nginx/sites-available/game.demoserver2.buzz',
    ]));

    const summary = registry.buildPromptSummary();
    expect(summary).toContain('game.demoserver2.buzz');
    expect(summary).toContain('/app/index.html');
    expect(summary).toContain('rollout yes');

    const reloadedRegistry = new ClusterStateRegistry();
    reloadedRegistry.setStoragePathForTests(storagePath);
    expect(reloadedRegistry.getRuntimeSummary()).toEqual(expect.objectContaining({
      targetCount: 1,
      deploymentCount: 1,
    }));
  });

  test('does not mark HTTPS as trusted when verification only passed with insecure TLS', () => {
    registry.recordToolEvents({
      objective: 'Verify the game deployment after a self-signed certificate error.',
      controlState: {
        lastSshTarget: {
          host: 'ubuntu-32gb-fsn1-2',
          username: 'ubuntu',
          port: 22,
        },
      },
      toolEvents: [
        {
          toolCall: {
            function: {
              name: 'remote-workbench',
              arguments: JSON.stringify({
                action: 'deploy-verify',
                namespace: 'web',
                deployment: 'site',
                publicHost: 'game.demoserver2.buzz',
              }),
            },
          },
          result: {
            success: true,
            toolId: 'remote-workbench',
            timestamp: '2026-04-18T12:08:00.000Z',
            data: {
              stdout: [
                'deployment "site" successfully rolled out',
                'ingress.networking.k8s.io/site web game.demoserver2.buzz',
                '__KIMIBUILT_TLS_TRUSTED__=false',
                '__KIMIBUILT_PUBLIC_HTTPS__=insecure',
                'HTTP/2 200',
                '__KIMIBUILT_UI_BODY_BYTES__=4096',
              ].join('\n'),
            },
          },
          reason: 'Verify rollout, route, and UI body availability.',
        },
      ],
    });

    const deployments = registry.listDeployments();
    expect(deployments[0].verification).toEqual(expect.objectContaining({
      rollout: true,
      ingress: true,
      https: false,
    }));
  });

  test('stores remote target baseline context so later agents can reuse it', () => {
    const state = registry.getState();
    registry.recordTargetContext(state, {
      target: {
        host: 'ubuntu-32gb-fsn1-2',
        username: 'ubuntu',
        port: 22,
      },
      objective: 'Inspect the remote k3s cluster before deploying a managed app.',
      context: {
        hostname: 'deploy-node-1',
        remoteUser: 'ubuntu',
        arch: 'aarch64',
        osSummary: 'Ubuntu 24.04.2 LTS',
        k3sVersion: 'k3s version v1.30.6+k3s1',
        nodeNames: ['deploy-node-1'],
        ingressClasses: ['traefik'],
        traefikInstalled: true,
        certManagerInstalled: true,
        platformNamespaces: ['agent-platform'],
        lastRefreshedAt: '2026-04-19T10:00:00.000Z',
      },
    });
    registry.saveState();

    const summary = registry.buildPromptSummary();
    expect(summary).toContain('Known remote target ubuntu@ubuntu-32gb-fsn1-2:22');
    expect(summary).toContain('k3s version v1.30.6+k3s1');
    expect(summary).toContain('traefik');
    expect(summary).toContain('cert-manager yes');
  });

  test('records guarded ingress route events from remote command output', () => {
    const event = {
      eventType: 'kimibuilt-ingress',
      timestamp: '2026-04-20T12:00:00.000Z',
      action: 'apply',
      status: 'succeeded',
      namespace: 'demo',
      ingressName: 'demo',
      host: 'site.demoserver2.buzz',
      baseDomain: 'demoserver2.buzz',
      path: '/',
      pathType: 'Prefix',
      serviceName: 'web',
      servicePort: '80',
      deployment: 'web',
      ingressClassName: 'traefik',
      tlsClusterIssuer: 'letsencrypt-prod',
      tlsSecretName: 'site-demoserver2-buzz-tls',
      acmeEmail: 'philly1084@gmail.com',
      verification: {
        ingress: true,
        tls: false,
        certificateReady: false,
        https: false,
      },
      message: 'Ingress route applied.',
    };

    registry.recordToolEvents({
      objective: 'Expose the demo app through Traefik and cert-manager.',
      controlState: {
        lastSshTarget: {
          host: 'ubuntu-32gb-fsn1-2',
          username: 'ubuntu',
          port: 22,
        },
      },
      toolEvents: [{
        toolCall: {
          function: {
            name: 'remote-command',
            arguments: JSON.stringify({
              workflowAction: 'ingress-apply',
              command: 'node bin/kimibuilt-ingress.js apply --namespace demo --ingress demo --subdomain site --service web --service-port 80',
            }),
          },
        },
        result: {
          success: true,
          toolId: 'remote-command',
          timestamp: '2026-04-20T12:00:00.000Z',
          data: {
            host: 'ubuntu-32gb-fsn1-2:22',
            stdout: `KIMIBUILT_INGRESS_EVENT ${JSON.stringify(event)}`,
          },
        },
      }],
    });

    const routes = registry.listEdgeRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual(expect.objectContaining({
      targetHost: 'ubuntu-32gb-fsn1-2',
      namespace: 'demo',
      ingressName: 'demo',
      hostName: 'site.demoserver2.buzz',
      serviceName: 'web',
      servicePort: '80',
      ingressClassName: 'traefik',
      tlsClusterIssuer: 'letsencrypt-prod',
      acmeEmail: 'philly1084@gmail.com',
    }));
    expect(routes[0].verification).toEqual(expect.objectContaining({
      ingress: true,
      tls: false,
      https: false,
    }));

    const summary = registry.buildPromptSummary();
    expect(summary).toContain('Known edge route site.demoserver2.buzz/');
    expect(summary).toContain('Use kimibuilt-ingress for changes');
    expect(registry.getRuntimeSummary()).toEqual(expect.objectContaining({
      edgeRouteCount: 1,
    }));
  });

  test('records remote-cli-agent continuity markers as reusable project context', () => {
    registry.recordToolEvents({
      objective: 'Continue the Calan app deployment and verify the public route.',
      controlState: {
        lastSshTarget: {
          host: 'ubuntu-32gb-fsn1-2',
          username: 'ubuntu',
          port: 22,
        },
      },
      toolEvents: [{
        toolCall: {
          function: {
            name: 'remote-cli-agent',
            arguments: JSON.stringify({
              task: 'Continue the Calan app deployment and verify the public route.',
              cwd: '/srv/apps/calan-calendar',
            }),
          },
        },
        result: {
          success: true,
          toolId: 'remote-cli-agent',
          timestamp: '2026-04-21T12:00:00.000Z',
          data: {
            sessionId: 'rcli_calan_session',
            remoteCodeJobId: 'rcli_calan_job',
            cwd: '/srv/apps/calan-calendar',
            gitRepo: 'https://gitlab.demoserver2.buzz/agent-apps/calan-calendar.git',
            gitBranch: 'agent/calan-calendar',
            gitBaseCommit: 'def5678',
            gitCommit: 'abc1234',
            changedFiles: ['src/app.js', 'k8s/deployment.yaml'],
            deployment: 'web/calan-calendar',
            publicHost: 'calan.demoserver2.buzz',
            publicUrl: 'https://calan.demoserver2.buzz',
            whatChanged: 'Updated the calendar UI and redeployed the k3s workload.',
            verifyCommands: ['npm test', 'kubectl rollout status deployment/calan-calendar -n web'],
            verifyResults: ['tests passed', 'rollout succeeded and HTTPS returned 200'],
            completionStatus: 'complete',
          },
        },
      }],
    });

    const deployments = registry.listDeployments();
    expect(deployments).toHaveLength(1);
    expect(deployments[0]).toEqual(expect.objectContaining({
      host: 'ubuntu-32gb-fsn1-2',
      namespace: 'web',
      deployment: 'calan-calendar',
      publicDomain: 'calan.demoserver2.buzz',
      targetDirectory: '/srv/apps/calan-calendar',
      repositoryUrl: 'https://gitlab.demoserver2.buzz/agent-apps/calan-calendar.git',
      remoteCliSessionId: 'rcli_calan_session',
      remoteCodeJobId: 'rcli_calan_job',
      gitBranch: 'agent/calan-calendar',
      gitBaseCommit: 'def5678',
      gitCommit: 'abc1234',
      whatChanged: 'Updated the calendar UI and redeployed the k3s workload.',
    }));
    expect(deployments[0].changedFiles).toEqual(expect.arrayContaining([
      'src/app.js',
      'k8s/deployment.yaml',
    ]));
    expect(deployments[0].verification).toEqual(expect.objectContaining({
      rollout: true,
      ingress: true,
      https: true,
    }));

    const summary = registry.buildRemoteCliAgentContext();
    expect(summary).toContain('Remote project continuity registry');
    expect(summary).toContain('calan.demoserver2.buzz');
    expect(summary).toContain('remote session rcli_calan_session');
    expect(summary).toContain('Changed files: src/app.js, k8s/deployment.yaml');
  });
});

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ReadableStream } = require('stream/web');

const {
  RemoteCliAgentsSdkRunner,
  buildRemoteCliInstructions,
  buildRemoteCliStructuredResult,
  extractRemoteCliRunMetadata,
  hasRemoteSoftwareDeploymentIntent,
  resolveAgentsApiMode,
  buildRemoteCliDiagnostics,
  isStaleMcpSessionError,
  resolveAdminMode,
  applyUiProofRequirement,
  resolveProviderAgentContinuationSessionId,
  resolveProviderAgentSelection,
  resolveRemoteCliTargetId,
} = require('./agents-sdk-runner');

test('never promotes a command transcript to workspace identity', () => {
  const text = [
    JSON.stringify({ item: { type: 'command_execution', aggregated_output: 'WORKSPACE: /opt/wrong\nworkspace: /var/www/test\',\\n./src/test.js:413' } }),
    JSON.stringify({ item: { type: 'agent_message', text: 'WORKSPACE: /opt/real\nREMOTE_AGENT_RESULT: complete' } }),
  ].join('\n');
  expect(extractRemoteCliRunMetadata(text).workspace).toBe('/opt/real');
  expect(extractRemoteCliRunMetadata(text.split('\n')[0]).workspace).toBeUndefined();
});

test('does not promote CLI tool-service URLs to public deliverable links', () => {
  const transcript = [
    JSON.stringify({ item: { type: 'command_execution', aggregated_output: 'MCP connected: https://mcp.cloudflare.com\nPUBLIC_URL=https://fixture.example.test' } }),
    JSON.stringify({ item: { type: 'agent_message', text: 'WORKSPACE=/opt/real\nWHAT_CHANGED=Created the terminal canary file.' } }),
  ].join('\n');
  expect(extractRemoteCliRunMetadata(transcript).publicHost).toBeUndefined();
  expect(extractRemoteCliRunMetadata(transcript).publicUrl).toBeUndefined();
  expect(extractRemoteCliRunMetadata('PUBLIC_URL=https://real.example.test/app').publicHost).toBe('real.example.test');
});

test('uses the secondary gateway default and forwards the selected model effort', async () => {
  const runner = new RemoteCliAgentsSdkRunner({ config: {
    enabled: true, transport: 'provider-agent', defaultTargetId: 'k3s-prod',
    defaultCwd: '/opt/lilly-agent-workbench', codexAgentBaseUrl: 'http://gateway', codexAgentApiKey: 'test',
  } });
  jest.spyOn(runner, 'assertConfigured').mockImplementation(() => {});
  jest.spyOn(runner, 'executeProviderAgentRun').mockResolvedValue({ success: true });
  await runner.run({ task: 'Inspect current workspace', targetId: 'k3s-secondary', model: 'gpt-5.6-luna', reasoningEffort: 'high' });
  expect(runner.executeProviderAgentRun).toHaveBeenCalledWith(expect.objectContaining({
    cwd: '', targetId: 'k3s-secondary', input: expect.objectContaining({ reasoningEffort: 'high' }),
  }));
});

test('omits absent cwd on the provider wire so the gateway can apply its default', async () => {
  const fetchImpl = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    expect(body.targetId).toBe('k3s-secondary');
    expect(body).not.toHaveProperty('cwd');
    expect(body.reasoningEffort).toBe('high');
    return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'wire contract inspected' }) };
  });
  const runner = new RemoteCliAgentsSdkRunner({ config: {
    enabled: true, transport: 'provider-agent', defaultTargetId: 'k3s-prod', defaultCwd: '/opt/lilly-agent-workbench',
    codexAgentBaseUrl: 'https://gateway.example.com', codexAgentApiKey: 'test',
  }, fetchImpl });
  await expect(runner.run({ task: 'Inspect workspace', targetId: 'k3s-secondary', model: 'gpt-5.6-luna', reasoningEffort: 'high' })).rejects.toThrow('wire contract inspected');
  expect(fetchImpl).toHaveBeenCalled();
});

function buildVerifiedResultFiles(handoff, {
  filename = 'result.xml',
  mimeType = 'application/xml',
  content = '<result/>',
} = {}) {
  const buffer = Buffer.from(content);
  return {
    version: 'RemoteAgentResultFiles/v1',
    gatewayVerified: true,
    operationId: handoff.operationId,
    manifestPath: handoff.output.manifestPath,
    files: [{
      path: `${handoff.output.filesDirectory}/${filename}`,
      filename,
      role: 'deliverable',
      mimeType,
      description: 'Verified remote agent output',
      sizeBytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      contentBase64: buffer.toString('base64'),
    }],
  };
}

describe('RemoteCliAgentsSdkRunner', () => {
  test('discovers remote agent targets through the authenticated gateway and returns only safe fields', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{
          targetId: 'k3s-primary-openrouter',
          description: 'Primary via OpenCode and OpenRouter',
          host: 'secret-host.example.test',
          user: 'root',
          allowedCwds: ['/opt/kimibuilt'],
          defaultCwd: '/opt/kimibuilt',
          defaultModel: 'openrouter/openrouter/free',
        }],
      }),
    }));
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        codexAgentBaseUrl: 'https://gateway.example.test',
        codexAgentApiKey: 'frontend-secret',
      },
      fetchImpl: fetchMock,
    });

    await expect(runner.listRemoteAgentTargets()).resolves.toEqual([{
      targetId: 'k3s-primary-openrouter',
      description: 'Primary via OpenCode and OpenRouter',
      defaultCwd: '/opt/kimibuilt',
      defaultModel: 'openrouter/openrouter/free',
    }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example.test/admin/remote-agent-targets',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer frontend-secret' }),
      }),
    );
  });

  test('does not demand UI-change proof for explicit read-only old-project recovery', () => {
    const metadata = {
      completionStatus: 'complete',
      whatChanged: 'No changes; read-only inventory and continuity recovery only.',
      changedFiles: [],
      verifyResults: [
        'Recovered /opt/kimibuilt/managed-sites/penguin and verified its deployment is 2/2 ready.',
        'HTTPS returned 200.',
      ],
      publicUrl: 'https://penguin.demoserver2.buzz/',
    };

    expect(applyUiProofRequirement(metadata, [
      'Recover the old Penguin website from server and Kubernetes inventory.',
      'Do not edit, deploy, restart, create, or delete anything.',
    ].join(' '))).toBe(metadata);
  });

  test('still demands UI-change proof when a read-only request changed files', () => {
    const metadata = {
      completionStatus: 'complete',
      whatChanged: 'No changes; read-only inventory only.',
      changedFiles: ['frontend/index.html'],
      verifyResults: ['HTTPS returned 200.'],
      publicUrl: 'https://example.test/',
    };

    expect(applyUiProofRequirement(
      metadata,
      'Inspect the website read-only and do not edit anything.',
    )).toMatchObject({
      completionStatus: 'blocked',
      blocker: 'Missing browser/Playwright or kimibuilt-ui-check evidence for a UI-affecting remote task.',
    });
  });

  test('maps selected Codex and Kimi models to their matching gateway CLI providers', () => {
    expect(resolveProviderAgentSelection('kimi-k2.7-code')).toMatchObject({
      providerId: 'kimi-code-cli',
      providerLabel: 'Kimi CLI',
      providerModel: 'kimi-for-coding',
    });
    expect(resolveProviderAgentSelection('kimi-k3')).toMatchObject({
      providerId: 'kimi-code-cli',
      providerLabel: 'Kimi CLI',
      requestedModel: 'kimi-k3',
      providerModel: 'k3',
    });
    expect(resolveProviderAgentSelection('Kimi K3')).toMatchObject({
      requestedModel: 'Kimi K3',
      providerModel: 'k3',
    });
    expect(resolveProviderAgentSelection('Kimi 3')).toMatchObject({
      requestedModel: 'Kimi 3',
      providerModel: 'k3',
    });
    expect(resolveProviderAgentSelection('k3')).toMatchObject({
      requestedModel: 'k3',
      providerModel: 'k3',
    });
    expect(resolveProviderAgentSelection('gpt-5.6-sol')).toMatchObject({
      providerId: 'codex-cli',
      providerLabel: 'Codex',
      providerModel: 'gpt-5.6-sol',
    });
    expect(resolveProviderAgentSelection('grok-build')).toBeNull();
  });

  test('only forwards native Codex UUIDs for provider-agent continuation', () => {
    const codex = resolveProviderAgentSelection('gpt-5.6-sol');
    const kimi = resolveProviderAgentSelection('kimi-k2.7-code');
    const sessionId = '019f6357-10a2-7f61-9bf8-541fa830de18';

    expect(resolveProviderAgentContinuationSessionId(codex, sessionId)).toBe(sessionId);
    expect(resolveProviderAgentContinuationSessionId(kimi, sessionId)).toBe('');
  });

  test('honors a provider-agent wait beyond the old fourteen-minute cap', async () => {
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'provider-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      fetchImpl: jest.fn(),
    });
    runner.executeProviderAgentRun = jest.fn(async ({ agentRunTimeoutMs }) => ({
      agentRunTimeoutMs,
    }));

    await expect(runner.run({
      task: 'Finish the long Kimi build and verification loop.',
      model: 'kimi-k3',
      agentRunTimeoutMs: 1800000,
    })).resolves.toEqual({
      agentRunTimeoutMs: 1800000,
    });
    expect(runner.executeProviderAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      agentRunTimeoutMs: 1800000,
    }));
  });

  test('keeps the MCP SDK as a production dependency for Docker optional-omit installs', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package-lock.json'), 'utf8'));
    const sdkVersion = packageJson.dependencies['@modelcontextprotocol/sdk'];

    expect(sdkVersion).toBeTruthy();
    expect(packageLock.packages[''].dependencies['@modelcontextprotocol/sdk']).toBe(sdkVersion);
    expect(packageLock.packages['node_modules/@modelcontextprotocol/sdk'].optional).not.toBe(true);
  });

  test('builds remote CLI instructions with target defaults and polling guidance', () => {
    const instructions = buildRemoteCliInstructions({
      targetId: 'prod',
      cwd: '/srv/apps/my-app',
      sessionId: 'sess_123',
      waitMs: 30000,
    });

    expect(instructions).toContain('Use remote_code_run for coding tasks.');
    expect(instructions).toContain('already-selected outer KimiBuilt tool');
    expect(instructions).toContain('Default targetId: prod');
    expect(instructions).toContain('Default cwd: /srv/apps/my-app');
    expect(instructions).toContain('repo-map');
    expect(instructions).toContain('deploy-verify');
    expect(instructions).toContain('git-backed workspace');
    expect(instructions).toContain('GitLab-backed source-control skill');
    expect(instructions).toContain('direct BuildKit/kubectl runner path');
    expect(instructions).toContain('git user.name');
    expect(instructions).toContain('Baseline-first remote ops rule');
    expect(instructions).toContain('Keep primary and secondary remote targets separate');
    expect(instructions).toContain('Playwright/Chromium screenshots');
    expect(instructions).toContain('kimibuilt-ui-check');
    expect(instructions).toContain('KimiBuilt tunnel endpoint');
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
    expect(instructions).toContain('remote_code_status');
    expect(instructions).toContain('persistent private workbench');
    expect(instructions).toContain('not a Git remote, URL, or raw user@host SSH string');
    expect(instructions).toContain('root@github.com permission failure');
    expect(instructions).toContain('Agent quality metrics:');
    expect(instructions).toContain('guardrails as release gates');
    expect(instructions).toContain('sess_123');
  });

  test('normalizes unsafe remote CLI target ids back to the configured gateway target', () => {
    expect(resolveRemoteCliTargetId('github.com', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('root@github.com', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('root@162.55.163.199', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('162.55.163.199', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('https://github.com/example/app.git', 'prod')).toBe('prod');
    expect(resolveRemoteCliTargetId('remote-projects/kimibuilt', 'k3s-prod')).toBe('k3s-prod');
    expect(resolveRemoteCliTargetId('/opt/kimibuilt', 'k3s-prod')).toBe('k3s-prod');
    expect(resolveRemoteCliTargetId('undefined', 'k3s-prod')).toBe('k3s-prod');
    expect(resolveRemoteCliTargetId('null', 'k3s-prod')).toBe('k3s-prod');
    expect(resolveRemoteCliTargetId('undefined', 'undefined')).toBe('prod');
    expect(resolveRemoteCliTargetId('', 'github.com')).toBe('prod');
    expect(resolveRemoteCliTargetId('staging', 'prod')).toBe('staging');
  });

  test('reports codex-agent readiness when auto transport has run/events credentials', () => {
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        transport: 'auto',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'front-key',
      },
      fetchImpl: jest.fn(),
    });

    expect(runner.getPublicConfig()).toEqual(expect.objectContaining({
      configured: true,
      transport: 'codex-agent',
      requestedTransport: 'auto',
      codexAgentBaseUrl: 'https://gateway.example.com',
      codexAgentConfigured: true,
    }));
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
      'GIT_BRANCH=agent/weather',
      'GIT_BASE_COMMIT=def5678',
      'GIT_COMMIT=abcdef123456',
      'CHANGED_FILES=src/app.js,k8s/deployment.yaml',
      'DEPLOYMENT=app-weather/weather',
      'PUBLIC_HOST=weather.demoserver2.buzz',
      'PUBLIC_URL=https://weather.demoserver2.buzz',
      'UI_CHECK_REPORT=/srv/apps/weather/ui-checks/ui-check-report.json',
      'RESULT_FILES_MANIFEST=.kimibuilt/remote-agent-results.json',
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
      gitBranch: 'agent/weather',
      gitBaseCommit: 'def5678',
      gitCommit: 'abcdef123456',
      changedFiles: ['src/app.js', 'k8s/deployment.yaml'],
      deployment: 'app-weather/weather',
      publicHost: 'weather.demoserver2.buzz',
      publicUrl: 'https://weather.demoserver2.buzz',
      uiCheckReport: '/srv/apps/weather/ui-checks/ui-check-report.json',
      resultFilesManifest: '.kimibuilt/remote-agent-results.json',
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

  test('returns a versioned structured result while labeling marker proof as a migration adapter', () => {
    const structured = buildRemoteCliStructuredResult({
      task: 'Deploy the weather site',
      metadata: {
        completionStatus: 'complete',
        whatChanged: 'Updated and deployed the weather site.',
        sessionId: 'session-1',
        workspace: '/srv/weather',
        gitCommit: 'abc1234',
        changedFiles: ['src/app.js'],
        verifyCommands: ['npm test'],
        verifyResults: ['passed'],
        publicUrl: 'https://weather.example.test',
      },
      agentQuality: { status: 'partial' },
    });

    expect(structured).toEqual(expect.objectContaining({
      version: 'RemoteCliResult/v2',
      status: 'complete',
      humanSummary: 'Updated and deployed the weather site.',
      verification: expect.objectContaining({
        source: 'legacy-marker-adapter',
        evidenceAttestations: [],
      }),
      sourceControl: expect.objectContaining({ commit: 'abc1234' }),
      artifacts: { resultFilesManifest: null },
    }));
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

  test('classifies support-agent requests as resumable blocked remote CLI output', () => {
    expect(extractRemoteCliRunMetadata([
      'Need a second opinion before editing.',
      'REMOTE_CLI_SESSION_ID=thread_support_1',
      'WORKSPACE=/opt/kimibuilt',
      'WHAT_CHANGED=Inspected the failing route and narrowed it to transport selection.',
      'SUPPORT_AGENT_REQUIRED=Review whether auto transport should prefer codex-agent when both routes are configured.',
      'SUPPORT_AGENT_CONTEXT=Files inspected: src/remote-cli/agents-sdk-runner.js and k8s/configmap.yaml.',
      'VERIFY_COMMANDS=not_available',
      'VERIFY_RESULTS=support agent needed',
      'PUBLIC_URL=not_available',
      'BLOCKER=support agent needed',
    ].join('\n'))).toEqual({
      sessionId: 'thread_support_1',
      workspace: '/opt/kimibuilt',
      whatChanged: 'Inspected the failing route and narrowed it to transport selection.',
      supportAgentRequest: 'Review whether auto transport should prefer codex-agent when both routes are configured.',
      supportAgentContext: 'Files inspected: src/remote-cli/agents-sdk-runner.js and k8s/configmap.yaml.',
      verifyResults: ['support agent needed'],
      blocker: 'support agent needed',
      completionStatus: 'blocked',
    });
  });

  test('classifies Codex JSONL turn failures as blockers', () => {
    const output = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread_failed' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'error',
        message: JSON.stringify({
          type: 'error',
          status: 400,
          error: {
            type: 'invalid_request_error',
            message: "The 'codex-latest' model is not supported when using Codex with a ChatGPT account.",
          },
        }),
      }),
      JSON.stringify({
        type: 'turn.failed',
        error: {
          message: JSON.stringify({
            type: 'error',
            status: 400,
            error: {
              type: 'invalid_request_error',
              message: "The 'codex-latest' model is not supported when using Codex with a ChatGPT account.",
            },
          }),
        },
      }),
    ].join('\n');

    expect(extractRemoteCliRunMetadata(output)).toEqual({
      blocker: "The 'codex-latest' model is not supported when using Codex with a ChatGPT account.",
      completionStatus: 'blocked',
    });
  });

  test('direct remote_code_run surfaces Codex JSONL failures instead of no-proof fallback', async () => {
    const runner = new RemoteCliAgentsSdkRunner({
      config: {},
      fetchImpl: jest.fn(),
    });
    const failedRun = {
      id: 'rcli_failed',
      targetId: 'k3s-prod',
      cwd: '/opt/kimibuilt',
      status: 'completed',
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread_failed' }),
        JSON.stringify({
          type: 'error',
          message: JSON.stringify({
            type: 'error',
            status: 400,
            error: {
              type: 'invalid_request_error',
              message: "The 'codex-latest' model is not supported when using Codex with a ChatGPT account.",
            },
          }),
        }),
        JSON.stringify({
          type: 'turn.failed',
          error: {
            message: JSON.stringify({
              type: 'error',
              status: 400,
              error: {
                type: 'invalid_request_error',
                message: "The 'codex-latest' model is not supported when using Codex with a ChatGPT account.",
              },
            }),
          },
        }),
      ].join('\n'),
      finalOutput: JSON.stringify({
        type: 'error',
        status: 400,
        error: {
          type: 'invalid_request_error',
          message: "The 'codex-latest' model is not supported when using Codex with a ChatGPT account.",
        },
      }),
      completionStatus: 'unknown',
    };
    const remoteCli = {
      callTool: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(failedRun) }],
        structuredContent: failedRun,
      }),
    };

    const finalOutput = await runner.executeRemoteCodeRun(remoteCli, {
      targetId: 'k3s-prod',
      cwd: '/opt/kimibuilt',
      task: 'No-change proof.',
      model: 'codex-latest',
      waitMs: 30000,
      maxStatusPolls: 1,
    });

    expect(finalOutput).toContain("BLOCKER=The 'codex-latest' model is not supported when using Codex with a ChatGPT account.");
    expect(finalOutput).not.toContain('completed without task proof markers');
    expect(extractRemoteCliRunMetadata(finalOutput)).toMatchObject({
      blocker: "The 'codex-latest' model is not supported when using Codex with a ChatGPT account.",
      completionStatus: 'blocked',
    });
  });

  test('surfaces an OpenRouter 429 without silently switching to a paid model', async () => {
    const runner = new RemoteCliAgentsSdkRunner({
      config: {},
      fetchImpl: jest.fn(),
    });
    const rateLimitError = Object.assign(new Error('429 OpenRouter free route is temporarily rate limited.'), {
      status: 429,
    });
    const remoteCli = {
      callTool: jest.fn().mockRejectedValue(rateLimitError),
    };

    await expect(runner.executeRemoteCodeRun(remoteCli, {
      targetId: 'k3s-primary-openrouter',
      cwd: '/opt/kimibuilt',
      task: 'Check the workspace.',
      model: 'openrouter/openrouter/free',
      waitMs: 30000,
      maxStatusPolls: 1,
    })).rejects.toBe(rateLimitError);

    expect(remoteCli.callTool).toHaveBeenCalledTimes(1);
    expect(remoteCli.callTool).toHaveBeenCalledWith('remote_code_run', expect.objectContaining({
      targetId: 'k3s-primary-openrouter',
      model: 'openrouter/openrouter/free',
    }));
  });

  test('classifies proof markers embedded in Codex JSONL agent messages', () => {
    const output = JSON.stringify({
      id: 'rcli_jsonl',
      targetId: 'k3s-prod',
      cwd: '/srv/apps/my-app',
      status: 'completed',
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread_jsonl' }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_1',
            type: 'agent_message',
            text: [
              'REMOTE_AGENT_RESULT=live-token-exchange:/srv/apps/my-app',
              'WHAT_CHANGED=none',
              'VERIFY_COMMANDS=pwd',
              'VERIFY_RESULTS=HTTPS title “Penguin” was live at /srv/apps/my-app',
              'PUBLIC_URL=not_available',
              'BLOCKER=none',
            ].join('\n'),
          },
        }),
      ].join('\n'),
    });

    expect(extractRemoteCliRunMetadata(output)).toMatchObject({
      verifyCommands: ['pwd'],
      verifyResults: ['HTTPS title “Penguin” was live at /srv/apps/my-app'],
      completionStatus: 'complete',
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

  test('detects stale MCP session errors from gateway responses', () => {
    expect(isStaleMcpSessionError(new Error('Session not found'))).toBe(true);
    expect(isStaleMcpSessionError({
      message: 'Connection error.',
      body: { error: { message: 'unknown session' } },
    })).toBe(true);
    expect(isStaleMcpSessionError(new Error('Gateway unavailable'))).toBe(false);
  });

  test('reconnects without a stale MCP session id when the gateway reports session not found', async () => {
    const calls = {
      mcpOptions: [],
      agentConfig: null,
      connectAttempts: 0,
      closed: 0,
    };

    class FakeMCPServerStreamableHttp {
      constructor(options) {
        calls.mcpOptions.push(options);
        this.sessionId = options.sessionId ? 'stale-mcp-session' : 'fresh-mcp-session';
      }

      async connect() {
        calls.connectAttempts += 1;
        if (this.sessionId === 'stale-mcp-session') {
          throw new Error('Session not found');
        }
      }

      async close() {
        calls.closed += 1;
      }
    }

    class FakeAgent {
      constructor(config) {
        calls.agentConfig = config;
      }
    }

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        return {
          finalOutput: [
            'remote run recovered',
            'REMOTE_CLI_SESSION_ID=remote-session-2',
            'WHAT_CHANGED=Reconnected without stale MCP session.',
            'VERIFY_COMMANDS=remote-cli-agent connect',
            'VERIFY_RESULTS=connect passed.',
            'PUBLIC_URL=not_available',
            'BLOCKER=none',
          ].join('\n'),
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        apiKey: 'gateway-secret',
        agentApiKey: 'openai-secret',
        agentBaseURL: 'http://gateway.example.com/v1',
        agentApiMode: 'chat',
        agentModel: 'gpt-4o',
        directRun: false,
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
      task: 'Continue the remote task',
      mcpSessionId: 'stale-session-id',
    });

    expect(calls.connectAttempts).toBe(2);
    expect(calls.mcpOptions[0].sessionId).toBe('stale-session-id');
    expect(calls.mcpOptions[1].sessionId).toBeUndefined();
    expect(calls.agentConfig.mcpServers[0].sessionId).toBe('fresh-mcp-session');
    expect(calls.closed).toBe(2);
    expect(result.mcpSessionId).toBe('fresh-mcp-session');
    expect(result.completionStatus).toBe('complete');
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
        directRun: false,
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
      agentQuality: expect.objectContaining({
        version: 'agent-quality-contract/v1',
        status: 'partial',
        requiredMissing: expect.arrayContaining(['public_or_preview_url']),
        surfaces: expect.arrayContaining([
          expect.objectContaining({ id: 'remote-deployment' }),
          expect.objectContaining({ id: 'website-experience' }),
        ]),
      }),
    });
  });

  test.each([
    ['gpt-5.6-sol', 'codex-cli', 'gpt-5.6-sol', 'Codex'],
    ['gpt-5.6-luna', 'codex-cli', 'gpt-5.6-luna', 'Codex'],
    ['kimi-k3', 'kimi-code-cli', 'k3', 'Kimi CLI'],
    ['kimi-k2.7-code', 'kimi-code-cli', 'kimi-for-coding', 'Kimi CLI'],
  ])('routes selected model %s through provider %s', async (selectedModel, providerId, providerModel, providerLabel) => {
    const progress = [];
    const continuationSessionId = providerId === 'codex-cli'
      ? '019f6357-10a2-7f61-9bf8-541fa830de18'
      : undefined;
    const handoff = {
      version: 'RemoteAgentHandoff/v1',
      operationId: '11111111-2222-4333-8444-555555555555',
      contextDirectory: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/input',
      manifestPath: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/input/manifest.json',
      sourceArtifactIds: ['artifact-design-1'],
      files: [{
        filename: 'design.svg',
        mimeType: 'image/svg+xml',
        sizeBytes: 6,
        sha256: 'abc123',
        contentBase64: 'PHN2Zy8+',
      }],
      output: {
        version: 'RemoteAgentResultFiles/v1',
        enabled: true,
        filesDirectory: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/files',
        manifestPath: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/manifest.json',
        requestedGlobs: ['dist/*.html'],
      },
    };
    const verifiedResultFiles = buildVerifiedResultFiles(handoff, {
      filename: 'diagram.svg',
      mimeType: 'image/svg+xml',
      content: '<svg/>',
    });
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        expect(body).toMatchObject({
          providerId,
          targetId: 'k3s-prod',
          cwd: '/opt/kimibuilt',
          handoff,
          adminMode: true,
          reasoningEffort: 'high',
        });
        if (continuationSessionId) {
          expect(body.sessionId).toBe(continuationSessionId);
        } else {
          expect(body.sessionId).toBeUndefined();
        }
        if (providerModel) {
          expect(body.model).toBe(providerModel);
        } else {
          expect(body.model).toBeUndefined();
        }
        expect(body.task).toContain(`Use ${providerLabel}`);
        expect(body.task).toContain(`selected in the KimiBuilt header is ${selectedModel}`);
        expect(body.task).toContain('RemoteAgentHandoff/v1');
        expect(body.task).toContain('RESULT_FILES_MANIFEST=.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/manifest.json');
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              task: {
                id: `task-${providerId}`,
                sessionId: `session-${providerId}`,
                handoff: {
                  accepted: true,
                  version: handoff.version,
                  operationId: handoff.operationId,
                  inputManifestPath: handoff.manifestPath,
                  resultManifestPath: handoff.output.manifestPath,
                },
              },
              streamUrl: `/admin/remote-agent-tasks/task-${providerId}/stream?token=safe-token`,
              resultFilesUrl: `/admin/remote-agent-tasks/task-${providerId}/result-files`,
            });
          },
        };
      }
      if (url === `https://gateway.example.com/admin/remote-agent-tasks/task-${providerId}/stream?token=safe-token`) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(
                'event: output\n'
                + `data: {"type":"output","data":"REMOTE_AGENT_PLAN=Inspect the staged source and deploy safely.\\nREMOTE_AGENT_PROGRESS=Verified the staged source artifact.\\nWORKSPACE=/opt/kimibuilt\\nWHAT_CHANGED=Finished with ${providerLabel}.\\nVERIFY_COMMANDS=npm test\\nVERIFY_RESULTS=passed\\nRESULT_FILES_MANIFEST=.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/manifest.json\\nPUBLIC_URL=not_available\\nBLOCKER=none\\nREMOTE_AGENT_RESULT: success done"}\n\n`
                + 'event: exit\n'
                + 'data: {"type":"exit","exitCode":0}\n\n',
              ));
              controller.close();
            },
          }),
        };
      }
      if (url === `https://gateway.example.com/admin/remote-agent-tasks/task-${providerId}/result-files`) {
        expect(options).toMatchObject({
          method: 'GET',
          headers: { Authorization: 'Bearer frontend-secret' },
        });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify(verifiedResultFiles);
          },
        };
      }
      if (url === `https://gateway.example.com/admin/remote-agent-tasks/task-${providerId}/cancel`) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ ok: true });
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'codex-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentWorkspacePath: '/opt/kimibuilt',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      sdkLoader: () => {
        throw new Error('provider-agent transport should not load the MCP SDK');
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Fix the selected remote app and verify it.',
      transport: 'provider-agent',
      model: selectedModel,
      adminMode: true,
      reasoningEffort: 'high',
      ...(continuationSessionId ? { sessionId: continuationSessionId } : {}),
      handoff,
      onProgress: (event) => progress.push(event),
    });

    expect(result).toMatchObject({
      transport: 'provider-agent',
      providerId,
      providerModel,
      model: selectedModel,
      apiMode: 'provider-agent',
      whatChanged: `Finished with ${providerLabel}.`,
      verifyResults: ['passed'],
      completionStatus: 'complete',
      resultFilesManifest: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/manifest.json',
      handoffVersion: 'RemoteAgentHandoff/v1',
      resultFiles: verifiedResultFiles,
    });
    expect(progress.some((event) => event.toolEvents?.[0]?.providerId === providerId)).toBe(true);
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detail: 'Verified the staged source artifact.',
        toolEvents: [
          expect.objectContaining({
            providerId,
            stage: 'output',
          }),
        ],
      }),
    ]));
    expect(fetchImpl.mock.calls.some(([url]) => url.endsWith(`/task-${providerId}/cancel`))).toBe(false);
  });

  test('uses the configured Codex provider when provider-agent has no explicit model', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks') {
        expect(JSON.parse(options.body)).toMatchObject({
          providerId: 'codex-cli',
          model: 'gpt-5.6-sol',
          targetId: 'k3s-prod',
          cwd: '/opt/kimibuilt',
        });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              task: { id: 'task-codex-default', sessionId: 'session-codex-default' },
              streamUrl: '/admin/remote-agent-tasks/task-codex-default/stream?token=safe-token',
            });
          },
        };
      }
      if (url.includes('/task-codex-default/stream')) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(
                'event: output\ndata: {"type":"output","data":"WHAT_CHANGED=Verified Codex default.\\nVERIFY_RESULTS=passed\\nBLOCKER=none\\nREMOTE_AGENT_RESULT: success done"}\n\n'
                + 'event: exit\ndata: {"type":"exit","exitCode":0}\n\n',
              ));
              controller.close();
            },
          }),
        };
      }
      if (url.endsWith('/task-codex-default/cancel')) {
        return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'provider-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentModel: 'gpt-5.6-sol',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      sdkLoader: () => { throw new Error('provider-agent transport should not load the MCP SDK'); },
      fetchImpl,
    });

    const result = await runner.run({ task: 'Verify the configured Codex provider.' });

    expect(result).toMatchObject({
      transport: 'provider-agent',
      providerId: 'codex-cli',
      providerModel: 'gpt-5.6-sol',
      completionStatus: 'complete',
    });
  });

  test('checks an existing provider task by job id without starting or cancelling a duplicate task', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-running') {
        expect(options).toMatchObject({
          method: 'GET',
          headers: {
            Authorization: 'Bearer frontend-secret',
          },
        });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              id: 'task-running',
              providerId: 'codex-cli',
              sessionId: 'session-running',
              status: 'running',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-running/transcript') {
        expect(options).toMatchObject({
          method: 'GET',
          headers: {
            Authorization: 'Bearer frontend-secret',
          },
        });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              data: [{
                type: 'output',
                data: 'REMOTE_AGENT_PROGRESS=Building the site image.',
              }],
            });
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'provider-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentModel: 'gpt-5.6-sol',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Continue the existing site deployment.',
      jobId: 'task-running',
    });

    expect(result).toMatchObject({
      completionStatus: 'running',
      remoteCodeJobId: 'task-running',
      sessionId: 'session-running',
      transport: 'provider-agent',
    });
    expect(result.finalOutput).toContain('REMOTE_AGENT_RESULT=running');
    expect(result.finalOutput).toContain('REMOTE_CLI_JOB_ID=task-running');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('starts a new Kimi task when a follow-up carries a completed Codex job id', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-codex-complete') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              id: 'task-codex-complete',
              providerId: 'codex-cli',
              sessionId: 'session-codex-complete',
              status: 'completed',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        expect(body).toMatchObject({
          providerId: 'kimi-code-cli',
          model: 'k3',
          targetId: 'k3s-prod',
          cwd: '/opt/kimibuilt',
        });
        expect(body.sessionId).toBeUndefined();
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              task: {
                id: 'task-kimi-follow-up',
                sessionId: 'session-kimi-follow-up',
              },
              streamUrl: '/admin/remote-agent-tasks/task-kimi-follow-up/stream?token=safe-token',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-kimi-follow-up/stream?token=safe-token') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(
                'event: output\n'
                + 'data: {"type":"output","data":"WHAT_CHANGED=Kimi continued the site improvement.\\nVERIFY_COMMANDS=npm test\\nVERIFY_RESULTS=passed\\nPUBLIC_URL=https://penguin.example.com\\nBLOCKER=none\\nREMOTE_AGENT_RESULT: success done"}\n\n'
                + 'event: exit\n'
                + 'data: {"type":"exit","exitCode":0}\n\n',
              ));
              controller.close();
            },
          }),
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-kimi-follow-up/cancel') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ ok: true });
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'provider-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Continue improving the Penguin site with Kimi.',
      model: 'kimi-k3',
      jobId: 'task-codex-complete',
    });

    expect(result).toMatchObject({
      transport: 'provider-agent',
      providerId: 'kimi-code-cli',
      completionStatus: 'complete',
      remoteCodeJobId: 'task-kimi-follow-up',
      sessionId: 'session-kimi-follow-up',
      whatChanged: 'Kimi continued the site improvement.',
    });
    expect(fetchImpl).not.toHaveBeenCalledWith(
      'https://gateway.example.com/admin/remote-agent-tasks/task-codex-complete/transcript',
      expect.anything(),
    );
  });

  test('starts a new Kimi task when a follow-up carries a stale missing job id', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-stale') {
        return {
          ok: false,
          status: 404,
          async text() {
            return JSON.stringify({ error: 'Unknown remote agent task: task-stale' });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        expect(body).toMatchObject({
          providerId: 'kimi-code-cli',
          model: 'k3',
          targetId: 'k3s-prod',
          cwd: '/opt/kimibuilt',
        });
        return {
          ok: true,
          status: 201,
          async text() {
            return JSON.stringify({
              task: {
                id: 'task-kimi-recovered',
                sessionId: 'session-kimi-recovered',
              },
              streamUrl: '/admin/remote-agent-tasks/task-kimi-recovered/stream?token=safe-token',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-kimi-recovered/stream?token=safe-token') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(
                'event: output\n'
                + 'data: {"type":"output","data":"WHAT_CHANGED=Kimi recovered the follow-up.\\nVERIFY_COMMANDS=pwd\\nVERIFY_RESULTS=passed\\nPUBLIC_URL=not_available\\nBLOCKER=none\\nREMOTE_AGENT_RESULT: success recovered"}\n\n'
                + 'event: exit\n'
                + 'data: {"type":"exit","exitCode":0}\n\n',
              ));
              controller.close();
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'provider-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Continue improving the Penguin site with Kimi.',
      model: 'kimi-k3',
      jobId: 'task-stale',
    });

    expect(result).toMatchObject({
      transport: 'provider-agent',
      providerId: 'kimi-code-cli',
      completionStatus: 'complete',
      remoteCodeJobId: 'task-kimi-recovered',
      sessionId: 'session-kimi-recovered',
      whatChanged: 'Kimi recovered the follow-up.',
    });
  });

  test('leaves a provider task running when the bounded stream wait expires', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks' && options.method === 'POST') {
        return {
          ok: true,
          status: 201,
          async text() {
            return JSON.stringify({
              task: { id: 'task-long-running', sessionId: 'session-long-running' },
              streamUrl: '/admin/remote-agent-tasks/task-long-running/stream?token=safe-token',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-long-running/stream?token=safe-token') {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('stream wait aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-long-running') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              task: {
                id: 'task-long-running',
                sessionId: 'session-long-running',
                status: 'running',
              },
            });
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'provider-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentModel: 'gpt-5.6-sol',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Build and deploy the long-running site.',
      agentRunTimeoutMs: 5,
    });

    expect(result).toMatchObject({
      completionStatus: 'running',
      remoteCodeJobId: 'task-long-running',
      sessionId: 'session-long-running',
      transport: 'provider-agent',
    });
    expect(result.verifyResults.join(' ')).toContain('was left active');
    expect(fetchImpl.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false);
  });

  test('reports a truthful provider timeout when the gateway task is no longer running', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks' && options.method === 'POST') {
        return {
          ok: true,
          status: 201,
          async text() {
            return JSON.stringify({
              task: { id: 'task-timed-out', sessionId: 'session-timed-out' },
              streamUrl: '/admin/remote-agent-tasks/task-timed-out/stream?token=safe-token',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-timed-out/stream?token=safe-token') {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('stream wait aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-timed-out') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              task: {
                id: 'task-timed-out',
                sessionId: 'session-timed-out',
                status: 'terminated',
              },
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-timed-out/cancel') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ success: true });
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'provider-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      fetchImpl,
    });

    let timeoutError = null;
    try {
      await runner.run({
        task: 'Build and deploy the long-running site.',
        model: 'kimi-k3',
        agentRunTimeoutMs: 5,
      });
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError.message).toBe('remote-cli-agent inner model wait exceeded 5ms.');
    expect(timeoutError.message).not.toContain('direct remote_code_run fallback');
  });

  test('accepts Markdown-bold Codex proof markers split across events', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks' && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              task: { id: 'task-codex-split', sessionId: 'session-codex-split' },
              streamUrl: '/admin/remote-agent-tasks/task-codex-split/stream?token=safe-token',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-codex-split/stream?token=safe-token') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              for (const data of [
                '**REMOTE_AGENT_RESULT',
                ': success CO',
                'DEX_REMOTE_OK**\n',
                '**WORKSPACE**=/opt/kimibuilt\n**WHAT_CHANGED**=Read-only verification.\n',
                '**VERIFY_COMMANDS**=pwd\n**VERIFY_RESULTS**=CODEX_REMOTE_OK /opt/kimibuilt\n',
                '**PUBLIC_URL**=not_available\n**BLOCKER**=none\n',
              ]) {
                controller.enqueue(encoder.encode(
                  `event: output\ndata: ${JSON.stringify({ type: 'output', data })}\n\n`,
                ));
              }
              controller.enqueue(encoder.encode(
                'event: exit\ndata: {"type":"exit","exitCode":0}\n\n',
              ));
              controller.close();
            },
          }),
        };
      }
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks/task-codex-split/cancel') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ ok: true });
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'provider-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentWorkspacePath: '/opt/kimibuilt',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Run the read-only Codex verification.',
      model: 'gpt-5.6-sol',
    });

    expect(result).toMatchObject({
      transport: 'provider-agent',
      providerId: 'codex-cli',
      completionStatus: 'complete',
      whatChanged: 'Read-only verification.',
      verifyResults: ['CODEX_REMOTE_OK /opt/kimibuilt'],
      blocker: null,
    });
    expect(result.finalOutput).toContain('REMOTE_AGENT_RESULT=success CODEX_REMOTE_OK');
    expect(fetchImpl.mock.calls.some(([url]) => url.endsWith('/task-codex-split/cancel'))).toBe(false);
  });

  test('rejects cross-origin provider-agent streams before sending gateway credentials', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/admin/remote-agent-tasks' && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              task: { id: 'task-kimi', sessionId: 'session-kimi' },
              streamUrl: 'https://untrusted.example.net/events',
            });
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'codex-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
      },
      fetchImpl,
    });

    await expect(runner.run({
      task: 'Run the selected remote task.',
      model: 'kimi-k2.7-code',
    })).rejects.toThrow('stream URL must use the configured gateway origin');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://gateway.example.com/admin/remote-agent-tasks/task-kimi/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('uses the /api/codex-agent/run plus /events SSE transport when configured', async () => {
    const progress = [];
    const handoff = {
      version: 'RemoteAgentHandoff/v1',
      operationId: '66666666-7777-4888-8999-000000000000',
      contextDirectory: '.kimibuilt/agent-runs/66666666-7777-4888-8999-000000000000/input',
      manifestPath: '.kimibuilt/agent-runs/66666666-7777-4888-8999-000000000000/input/manifest.json',
      sourceArtifactIds: ['artifact-brief-1'],
      files: [],
      output: {
        version: 'RemoteAgentResultFiles/v1',
        enabled: true,
        filesDirectory: '.kimibuilt/agent-runs/66666666-7777-4888-8999-000000000000/output/files',
        manifestPath: '.kimibuilt/agent-runs/66666666-7777-4888-8999-000000000000/output/manifest.json',
        requestedGlobs: [],
      },
    };
    const verifiedResultFiles = buildVerifiedResultFiles(handoff, {
      filename: 'index.html',
      mimeType: 'text/html',
      content: '<!doctype html><title>Ready</title>',
    });
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/api/codex-agent/run') {
        const body = JSON.parse(options.body);
        expect(options.method).toBe('POST');
        expect(options.headers.Authorization).toBe('Bearer frontend-secret');
        expect(body.workspacePath).toBe('/srv/apps/my-app');
        expect(body.handoff).toEqual(handoff);
        expect(body.prompt).toContain('Fix the remote app and verify it.');
        expect(body.prompt).toContain('/api/codex-agent/run');
        expect(body.prompt).toContain('GET /api/codex-agent/runs/:runId/events streams progress');
        expect(body.prompt).toContain('Do not use MCP, remote_code_run, or remote_code_status inside this Codex-agent run');
        expect(body.prompt).toContain('emit concise milestone messages');
        expect(body.prompt).toContain('Remote Ops baseline-first rule');
        expect(body.prompt).toContain('Keep primary and secondary servers separate');
        expect(body.prompt).toContain('managed-app previews');
        expect(body.prompt).toContain('UI_CHECK_REPORT');
        expect(body.prompt).toContain('Configured Git provider: gitlab at https://gitlab.demoserver2.buzz (group/org: agent-apps).');
        expect(body.prompt).toContain('A server-side Git provider token is configured for this workflow.');
        expect(body.prompt).not.toContain('gitlab-secret');
        expect(body.prompt).toContain('REMOTE_CLI_SESSION_ID');
        expect(body.prompt).toContain('RemoteAgentHandoff/v1');
        expect(body.prompt).toContain('RESULT_FILES_MANIFEST=.kimibuilt/agent-runs/66666666-7777-4888-8999-000000000000/output/manifest.json');
        expect(body.config).toMatchObject({
          approvalPolicy: 'never',
          threadSandbox: 'workspace-write',
          model: 'gpt-5.6-sol',
        });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true,
              runId: 'run_codex_1',
              threadId: 'thread_codex_1',
              turnId: 'turn_codex_1',
              sessionId: 'thread_codex_1-turn_codex_1',
              status: 'running',
              handoff: {
                accepted: true,
                version: handoff.version,
                operationId: handoff.operationId,
                inputManifestPath: handoff.manifestPath,
                resultManifestPath: handoff.output.manifestPath,
              },
              resultFilesUrl: '/api/codex-agent/runs/run_codex_1/result-files',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_codex_1/events') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              [
                'event: session_started\n',
                'data: {"event":"session_started","thread_id":"thread_codex_1","turn_id":"turn_codex_1","session_id":"thread_codex_1-turn_codex_1"}\n\n',
                'event: output\n',
                'data: {"event":"output","text":"Checking workspace. "}\n\n',
                'event: turn_completed\n',
                'data: {"event":"turn_completed","thread_id":"thread_codex_1","turn_id":"turn_codex_1","result":{"output_text":"REMOTE_AGENT_RESULT=codex-agent:/srv/apps/my-app\\nREMOTE_CLI_SESSION_ID=thread_codex_1\\nWORKSPACE=/srv/apps/my-app\\nGIT_BRANCH=codex/design-handoff\\nGIT_BASE_COMMIT=abc1234\\nGIT_COMMIT=def5678\\nCHANGED_FILES=dist/index.html,artifacts/diagram.svg\\nWHAT_CHANGED=Fixed the remote app through the Codex agent contract.\\nVERIFY_COMMANDS=npm test\\nVERIFY_RESULTS=passed\\nRESULT_FILES_MANIFEST=.kimibuilt/agent-runs/66666666-7777-4888-8999-000000000000/output/manifest.json\\nPUBLIC_URL=not_available\\nBLOCKER=none"}}\n\n',
              ].forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
              controller.close();
            },
          }),
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_codex_1/result-files') {
        expect(options).toMatchObject({
          method: 'GET',
          headers: { Authorization: 'Bearer frontend-secret' },
        });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify(verifiedResultFiles);
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'codex-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentWorkspacePath: '/srv/apps/my-app',
        codexAgentApprovalPolicy: 'never',
        codexAgentThreadSandbox: 'workspace-write',
        codexAgentModel: 'codex-latest',
        gitlab: {
          enabled: true,
          baseURL: 'https://gitlab.demoserver2.buzz',
          token: 'gitlab-secret',
          org: 'agent-apps',
        },
        agentModel: 'gpt-5.4',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => {
        throw new Error('codex-agent transport should not load the Agents SDK MCP client');
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Fix the remote app and verify it.',
      model: 'gpt-5.6-sol',
      adminMode: true,
      handoff,
      onProgress: (event) => progress.push(event),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(progress.map((event) => event.codexAgentEvent?.event).filter(Boolean)).toEqual([
      'session_started',
      'session_started',
      'output',
      'turn_completed',
    ]);
    expect(result).toMatchObject({
      transport: 'codex-agent',
      codexAgentRunId: 'run_codex_1',
      codexThreadId: 'thread_codex_1',
      codexTurnId: 'turn_codex_1',
      targetId: 'k3s-prod',
      cwd: '/srv/apps/my-app',
      sessionId: 'thread_codex_1',
      whatChanged: 'Fixed the remote app through the Codex agent contract.',
      verifyCommands: ['npm test'],
      verifyResults: ['passed'],
      gitBranch: 'codex/design-handoff',
      gitBaseCommit: 'abc1234',
      gitCommit: 'def5678',
      changedFiles: ['dist/index.html', 'artifacts/diagram.svg'],
      resultFilesManifest: '.kimibuilt/agent-runs/66666666-7777-4888-8999-000000000000/output/manifest.json',
      handoffVersion: 'RemoteAgentHandoff/v1',
      resultFiles: verifiedResultFiles,
      completionStatus: 'complete',
      model: 'gpt-5.6-sol',
      apiMode: 'codex-agent',
    });
  });

  test('fails closed and cancels the Codex run when the gateway handoff acknowledgement mismatches', async () => {
    const operationId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    const handoff = {
      version: 'RemoteAgentHandoff/v1',
      operationId,
      runDirectory: `.kimibuilt/agent-runs/${operationId}`,
      contextDirectory: `.kimibuilt/agent-runs/${operationId}/input`,
      manifestPath: `.kimibuilt/agent-runs/${operationId}/input/manifest.json`,
      sourceArtifactIds: [],
      files: [],
      output: {
        version: 'RemoteAgentResultFiles/v1',
        enabled: true,
        directory: `.kimibuilt/agent-runs/${operationId}/output`,
        filesDirectory: `.kimibuilt/agent-runs/${operationId}/output/files`,
        manifestPath: `.kimibuilt/agent-runs/${operationId}/output/manifest.json`,
        requestedGlobs: [],
      },
    };
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/api/codex-agent/run') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true,
              runId: 'run_bad_handoff',
              handoff: {
                accepted: true,
                version: handoff.version,
                operationId: '99999999-8888-4777-8666-555555555555',
                inputManifestPath: handoff.manifestPath,
                resultManifestPath: handoff.output.manifestPath,
              },
              resultFilesUrl: '/api/codex-agent/runs/run_bad_handoff/result-files',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_bad_handoff/cancel') {
        expect(options).toMatchObject({
          method: 'POST',
          headers: { Authorization: 'Bearer frontend-secret' },
        });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ ok: true, status: 'cancelled' });
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'codex-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentWorkspacePath: '/srv/apps/my-app',
      },
      fetchImpl,
    });

    await expect(runner.run({
      task: 'Build and return an artifact.',
      handoff,
    })).rejects.toMatchObject({
      name: 'RemoteCliAgentError',
      cause: { code: 'REMOTE_AGENT_HANDOFF_NOT_ACKNOWLEDGED' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('prefers codex-agent over MCP when auto-detecting from mixed config', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/api/codex-agent/run') {
        expect(JSON.parse(options.body).workspacePath).toBe('/opt/kimibuilt');
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true,
              runId: 'run_auto_codex',
              threadId: 'thread_auto_codex',
              turnId: 'turn_auto_codex',
              status: 'running',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_auto_codex/events') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(
                'event: turn_completed\n'
                + 'data: {"event":"turn_completed","result":{"output_text":"WORKSPACE=/opt/kimibuilt\\nWHAT_CHANGED=Used Codex-agent auto transport.\\nVERIFY_COMMANDS=not_available\\nVERIFY_RESULTS=passed\\nPUBLIC_URL=not_available\\nBLOCKER=none"}}\n\n',
              ));
              controller.close();
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        apiKey: 'legacy-mcp-secret',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'codex-agent-secret',
        codexAgentWorkspacePath: '/opt/kimibuilt',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      sdkLoader: () => {
        throw new Error('auto transport should not load the MCP Agents SDK when Codex-agent is configured');
      },
      fetchImpl,
    });

    expect(runner.getPublicConfig()).toMatchObject({
      requestedTransport: 'auto',
      transport: 'codex-agent',
      configured: true,
      codexAgentConfigured: true,
    });

    const result = await runner.run({ task: 'Verify remote work without MCP fallback.' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      transport: 'codex-agent',
      codexAgentRunId: 'run_auto_codex',
      cwd: '/opt/kimibuilt',
      whatChanged: 'Used Codex-agent auto transport.',
      completionStatus: 'complete',
    });
  });

  test('returns support-agent requests and resumes the same codex-agent thread with the support response', async () => {
    const runPrompts = [];
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/api/codex-agent/run') {
        const body = JSON.parse(options.body);
        runPrompts.push(body);
        if (body.continuation) {
          expect(body.threadId).toBe('thread_support_1');
          expect(body.prompt).toContain('Support agent response for this continuation:');
          expect(body.prompt).toContain('Use auto transport and keep MCP explicit-only.');
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                ok: true,
                runId: 'run_support_2',
                threadId: 'thread_support_1',
                turnId: 'turn_support_2',
                status: 'running',
              });
            },
          };
        }
        expect(body.prompt).toContain('SUPPORT_AGENT_REQUIRED=<precise question or help request>');
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true,
              runId: 'run_support_1',
              threadId: 'thread_support_1',
              turnId: 'turn_support_1',
              status: 'running',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_support_1/events') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(
                'event: turn_completed\n'
                + 'data: {"event":"turn_completed","thread_id":"thread_support_1","turn_id":"turn_support_1","result":{"output_text":"REMOTE_CLI_SESSION_ID=thread_support_1\\nWORKSPACE=/opt/kimibuilt\\nWHAT_CHANGED=Inspected the transport code.\\nSUPPORT_AGENT_REQUIRED=Should auto prefer codex-agent over MCP?\\nSUPPORT_AGENT_CONTEXT=Both endpoints are configured.\\nVERIFY_COMMANDS=not_available\\nVERIFY_RESULTS=support agent needed\\nPUBLIC_URL=not_available\\nBLOCKER=support agent needed"}}\n\n',
              ));
              controller.close();
            },
          }),
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_support_2/events') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(
                'event: turn_completed\n'
                + 'data: {"event":"turn_completed","thread_id":"thread_support_1","turn_id":"turn_support_2","result":{"output_text":"REMOTE_CLI_SESSION_ID=thread_support_1\\nWORKSPACE=/opt/kimibuilt\\nWHAT_CHANGED=Applied the support answer and finished the fix.\\nVERIFY_COMMANDS=npm test -- src/remote-cli/agents-sdk-runner.test.js\\nVERIFY_RESULTS=passed\\nPUBLIC_URL=not_available\\nBLOCKER=none"}}\n\n',
              ));
              controller.close();
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'codex-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentWorkspacePath: '/opt/kimibuilt',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/opt/kimibuilt',
      },
      sdkLoader: () => {
        throw new Error('codex-agent transport should not load the Agents SDK MCP client');
      },
      fetchImpl,
    });

    const first = await runner.run({ task: 'Fix the remote CLI transport issue.' });
    expect(first).toMatchObject({
      transport: 'codex-agent',
      codexThreadId: 'thread_support_1',
      sessionId: 'thread_support_1',
      supportAgentRequest: 'Should auto prefer codex-agent over MCP?',
      supportAgentContext: 'Both endpoints are configured.',
      blocker: 'support agent needed',
      completionStatus: 'blocked',
    });

    const second = await runner.run({
      task: 'Continue after support review and finish the fix.',
      threadId: first.codexThreadId,
      supportAgentResponse: 'Use auto transport and keep MCP explicit-only.',
    });

    expect(runPrompts).toHaveLength(2);
    expect(second).toMatchObject({
      transport: 'codex-agent',
      codexThreadId: 'thread_support_1',
      sessionId: 'thread_support_1',
      whatChanged: 'Applied the support answer and finished the fix.',
      verifyResults: ['passed'],
      completionStatus: 'complete',
    });
  });

  test('wraps codex-agent unauthorized failures with masked credential diagnostics', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      expect(url).toBe('https://gateway.example.com/api/codex-agent/run');
      expect(options.headers.Authorization).toBe('Bearer frontend-secret');
      return {
        ok: false,
        status: 401,
        async text() {
          return 'Unauthorized';
        },
      };
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'codex-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentWorkspacePath: '/srv/apps/my-app',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => {
        throw new Error('codex-agent transport should not load the Agents SDK MCP client');
      },
      fetchImpl,
    });

    const rejection = await runner.run({ task: 'Fix the remote app.' }).catch((error) => error);

    expect(rejection).toMatchObject({
      name: 'RemoteCliAgentError',
      code: 'REMOTE_CLI_AGENT_FAILED',
      diagnostics: {
        remoteCliAgent: {
          stage: 'codex_agent_run',
          apiMode: 'codex-agent',
          targetId: 'k3s-prod',
          cwd: '/srv/apps/my-app',
          codexAgentBaseURL: 'https://gateway.example.com',
          hasCodexAgentApiKey: true,
          error: {
            message: 'Unauthorized',
            statusCode: 401,
          },
        },
      },
    });
    expect(rejection.message).toBe('remote-cli-agent codex-agent transport failed: Unauthorized');
    expect(rejection.diagnostics.remoteCliAgent.hint).toContain('bearer token');
    expect(JSON.stringify(rejection.diagnostics)).not.toContain('frontend-secret');
  });

  test('does not pass the legacy Agents SDK model into codex-agent runs by default', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://gateway.example.com/api/codex-agent/run') {
        const body = JSON.parse(options.body);
        expect(body.config.model).toBeUndefined();
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true,
              runId: 'run_codex_default_model',
              threadId: 'thread_default_model',
              turnId: 'turn_default_model',
              sessionId: 'thread_default_model-turn_default_model',
              status: 'running',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_codex_default_model/events') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode('event: turn_completed\n'));
              controller.enqueue(encoder.encode('data: {"event":"turn_completed","thread_id":"thread_default_model","turn_id":"turn_default_model","result":{"output_text":"WHAT_CHANGED=Ran with gateway default.\\nVERIFY_RESULTS=passed\\nBLOCKER=none"}}\n\n'));
              controller.close();
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'codex-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentWorkspacePath: '/srv/apps/my-app',
        agentModel: 'gpt-5.4',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => {
        throw new Error('codex-agent transport should not load the Agents SDK MCP client');
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Check the workspace.',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      transport: 'codex-agent',
      model: '',
      whatChanged: 'Ran with gateway default.',
      completionStatus: 'complete',
    });
  });

  test('rechecks codex-agent event snapshots when the follow stream closes before a terminal event', async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url === 'https://gateway.example.com/api/codex-agent/run') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true,
              runId: 'run_codex_reconnect',
              threadId: 'thread_reconnect',
              turnId: 'turn_reconnect',
              status: 'running',
            });
          },
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_codex_reconnect/events') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode('event: session_started\n'));
              controller.enqueue(encoder.encode('data: {"event":"session_started","cursor":1,"thread_id":"thread_reconnect","turn_id":"turn_reconnect"}\n\n'));
              controller.close();
            },
          }),
        };
      }
      if (url === 'https://gateway.example.com/api/codex-agent/runs/run_codex_reconnect/events?follow=false&after=1') {
        return {
          ok: true,
          status: 200,
          async text() {
            return [
              'event: turn_completed',
              'data: {"event":"turn_completed","cursor":2,"thread_id":"thread_reconnect","turn_id":"turn_reconnect","result":{"output_text":"WHAT_CHANGED=Recovered after stream close.\\nVERIFY_COMMANDS=GET /events?follow=false&after=1\\nVERIFY_RESULTS=terminal event found\\nBLOCKER=none"}}',
              '',
              '',
            ].join('\n');
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        transport: 'codex-agent',
        codexAgentBaseUrl: 'https://gateway.example.com',
        codexAgentApiKey: 'frontend-secret',
        codexAgentWorkspacePath: '/srv/apps/my-app',
        agentModel: 'gpt-5.4',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
        maxStatusPolls: 20,
      },
      sdkLoader: () => {
        throw new Error('codex-agent transport should not load the Agents SDK MCP client');
      },
      fetchImpl,
    });

    const result = await runner.run({
      task: 'Check reconnect.',
      statusPollIntervalMs: 1,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      transport: 'codex-agent',
      codexAgentRunId: 'run_codex_reconnect',
      whatChanged: 'Recovered after stream close.',
      verifyCommands: ['GET /events?follow=false&after=1'],
      verifyResults: ['terminal event found'],
      completionStatus: 'complete',
    });
  });

  test('directly passes remote-cli-agent tasks to remote_code_run by default', async () => {
    const calls = {
      toolCalls: [],
      connected: false,
      closed: false,
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-direct';
      }

      async connect() {
        calls.connected = true;
      }

      async close() {
        calls.closed = true;
      }

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          content: [{
            type: 'text',
            text: [
              'REMOTE_AGENT_RESULT=pwd:/srv/apps/my-app',
              'REMOTE_CLI_SESSION_ID=remote-session-direct',
              'WORKSPACE=/srv/apps/my-app',
              'WHAT_CHANGED=Ran the OpenAI CLI passthrough task on the remote site.',
              'VERIFY_COMMANDS=remote_code_run',
              'VERIFY_RESULTS=REMOTE_AGENT_RESULT=pwd:/srv/apps/my-app',
              'PUBLIC_URL=not_available',
              'BLOCKER=none',
            ].join('\n'),
          }],
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
      }),
    });

    const result = await runner.run({
      task: 'No changes. Run pwd.',
      waitMs: 30000,
    });

    expect(calls.connected).toBe(true);
    expect(calls.closed).toBe(true);
    expect(calls.toolCalls).toEqual([{
      name: 'remote_code_run',
      args: {
        targetId: 'k3s-prod',
        cwd: '/srv/apps/my-app',
        task: expect.stringContaining('No changes. Run pwd.'),
        model: 'gpt-5.4',
        waitMs: 30000,
      },
    }]);
    expect(calls.toolCalls[0].args.task).toContain('You are already executing through the KimiBuilt remote_code_run gateway target "k3s-prod"');
    expect(calls.toolCalls[0].args.task).toContain('The gateway has placed you in the remote workspace "/srv/apps/my-app"');
    expect(calls.toolCalls[0].args.task).toContain('Do not ask the user for SSH details');
    expect(result).toMatchObject({
      targetId: 'k3s-prod',
      cwd: '/srv/apps/my-app',
      sessionId: 'remote-session-direct',
      completionStatus: 'complete',
      whatChanged: 'Ran the OpenAI CLI passthrough task on the remote site.',
    });
  });

  test('passes admin mode through direct remote_code_run for live verification', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-admin-direct';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          content: [{
            type: 'text',
            text: [
              'REMOTE_AGENT_RESULT=admin:/srv/apps/my-app',
              'WORKSPACE=/srv/apps/my-app',
              'WHAT_CHANGED=Ran live verification with admin mode.',
              'VERIFY_COMMANDS=kubectl get pods',
              'VERIFY_RESULTS=pass',
              'PUBLIC_URL=not_available',
              'BLOCKER=none',
            ].join('\n'),
          }],
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
      }),
    });

    const result = await runner.run({
      task: 'Deploy the app and verify kubectl status.',
      adminMode: true,
      waitMs: 30000,
    });

    expect(calls.toolCalls[0]).toMatchObject({
      name: 'remote_code_run',
      args: {
        targetId: 'k3s-prod',
        cwd: '/srv/apps/my-app',
        adminMode: true,
        waitMs: 30000,
      },
    });
    expect(calls.toolCalls[0].args.task).toContain('Admin runner mode is enabled');
    expect(result).toMatchObject({
      completionStatus: 'complete',
      whatChanged: 'Ran live verification with admin mode.',
    });
  });

  test('compacts completed Codex JSONL remote_code_run output before returning it to chat', async () => {
    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-jsonl';
      }

      async connect() {}

      async close() {}

      async callTool() {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: 'rcli_jsonl',
              targetId: 'k3s-prod',
              cwd: '/srv/apps/my-app',
              status: 'completed',
              stdout: [
                JSON.stringify({ type: 'thread.started', thread_id: 'thread-jsonl' }),
                JSON.stringify({
                  type: 'item.completed',
                  item: {
                    type: 'command_execution',
                    command: '/bin/bash -lc pwd',
                    aggregated_output: '/srv/apps/my-app\n',
                    status: 'completed',
                  },
                }),
                JSON.stringify({
                  type: 'item.completed',
                  item: {
                    type: 'agent_message',
                    text: [
                      'REMOTE_AGENT_RESULT=jsonl-compact:/srv/apps/my-app',
                      'REMOTE_CLI_SESSION_ID=not_available',
                      'WORKSPACE=/srv/apps/my-app',
                      'REMOTE_CLI_JOB_ID=not_available',
                      'WHAT_CHANGED=verified remote workspace only',
                      'VERIFY_COMMANDS=pwd',
                      'VERIFY_RESULTS=pass: pwd returned /srv/apps/my-app',
                      'PUBLIC_URL=not_available',
                      'BLOCKER=none',
                    ].join('\n'),
                  },
                }),
              ].join('\n'),
              stderr: 'Reading additional input from stdin...\n',
            }),
          }],
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
      }),
    });

    const result = await runner.run({
      task: 'Verify the remote workspace.',
      waitMs: 30000,
    });

    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_jsonl',
      remoteCodeSessionId: null,
      cwd: '/srv/apps/my-app',
      completionStatus: 'complete',
      whatChanged: 'verified remote workspace only',
    });
    expect(result.finalOutput).toContain('REMOTE_AGENT_RESULT=jsonl-compact:/srv/apps/my-app');
    expect(result.finalOutput).toContain('VERIFY_RESULTS=pass: pwd returned /srv/apps/my-app');
    expect(result.finalOutput).not.toContain('"type":"thread.started"');
    expect(result.finalOutput).not.toContain('"stdout"');
    expect(result.finalOutput).not.toContain('/bin/bash -lc pwd');
    expect(result.finalOutput).not.toContain('Reading additional input from stdin');
  });

  test('summarizes running remote_code_run jobs without dumping repeated JSON status bodies', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-running';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: 'rcli_running',
              targetId: 'k3s-prod',
              cwd: '/srv/apps/my-app',
              status: 'running',
              stdout: '',
              stderr: '',
            }),
          }],
        };
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
      }),
    });

    const result = await runner.run({
      task: 'Build the app remotely.',
      waitMs: 30000,
      maxStatusPolls: 2,
      statusPollIntervalMs: 0,
    });

    expect(calls.toolCalls.map((call) => call.name)).toEqual([
      'remote_code_run',
      'remote_code_status',
      'remote_code_status',
    ]);
    expect(result.finalOutput).toContain('REMOTE_CLI_JOB_ID=rcli_running');
    expect(result.finalOutput).toContain('REMOTE_AGENT_RESULT=running');
    expect(result.finalOutput).toContain('VERIFY_RESULTS=remote_code_status remained running after 2 poll attempt(s).');
    expect(result.finalOutput).toContain('BLOCKER=none');
    expect(result.finalOutput).not.toContain('BLOCKER=remote_code_run still running');
    expect(result.finalOutput).not.toContain('{"id":"rcli_running"');
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_running',
      completionStatus: 'running',
      blocker: null,
    });
  });

  test('executes leaked remote_code_run JSON through MCP with sanitized arguments', async () => {
    const calls = {
      toolCalls: [],
      runnerInput: null,
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-3';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_123',
                sessionId: 'remote-session-3',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_CLI_JOB_ID=rcli_123',
                'REMOTE_CLI_SESSION_ID=remote-session-3',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Finished the remote task.',
                'VERIFY_COMMANDS=remote_code_status',
                'VERIFY_RESULTS=Remote job completed.',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run(_agent, input) {
        calls.runnerInput = input;
        return {
          finalOutput: '{" output _text ":""," tool _calls ":[{" id ":" call _1 "," name ":" remote _code _run "," arguments ":{" target Id ":" prod "," cwd ":"/ srv /apps /my -app "," command ":"rm -rf /"," shell ":"bash"," wait Ms ": 300 00 }}]," finish _reason ":" tool _call"}',
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
        agentModel: 'kimi-for-coding',
        directRun: false,
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
      task: 'Fix the deployed game and verify it.',
      waitMs: 30000,
      maxStatusPolls: 3,
      statusPollIntervalMs: 0,
    });

    expect(calls.runnerInput).toContain('Fix the deployed game and verify it.');
    expect(calls.toolCalls[0]).toEqual({
      name: 'remote_code_run',
      args: {
        targetId: 'prod',
        cwd: '/srv/apps/my-app',
        task: expect.stringContaining('Fix the deployed game and verify it.'),
        model: 'gpt-5.4',
        waitMs: 30000,
      },
    });
    expect(calls.toolCalls[0].args.task).toContain('Do not say that you cannot access the remote server');
    expect(Object.keys(calls.toolCalls[0].args)).not.toContain('command');
    expect(Object.keys(calls.toolCalls[0].args)).not.toContain('shell');
    expect(calls.toolCalls[1]).toEqual({
      name: 'remote_code_status',
      args: { jobId: 'rcli_123' },
    });
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_123',
      sessionId: 'remote-session-3',
      cwd: '/srv/apps/my-app',
      whatChanged: 'Finished the remote task.',
      completionStatus: 'complete',
    });
  });

  test('blocks completed remote_code_status output when task proof markers are missing', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-preview';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_preview',
                sessionId: 'remote-session-preview',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'completed',
                jobId: 'rcli_preview',
                sessionId: 'remote-session-preview',
                stdout: '<!doctype html><html><body><pre>kubectl apply -f k8s/app.yaml</pre></body></html>',
              }),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        return {
          finalOutput: 'I will use the remote runner.',
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
        agentModel: 'kimi-for-coding',
        directRun: false,
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
      task: 'Deploy the frontend remotely and verify the live route.',
      waitMs: 30000,
      maxStatusPolls: 2,
      statusPollIntervalMs: 0,
    });

    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: expect.stringContaining('Deploy the frontend remotely and verify the live route.'),
          model: 'gpt-5.4',
          adminMode: true,
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: { jobId: 'rcli_preview' },
      },
    ]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_preview',
      sessionId: 'remote-session-preview',
      cwd: '/srv/apps/my-app',
      completionStatus: 'blocked',
    });
    expect(result.blocker).toContain('without task proof markers');
    expect(result.whatChanged).toBe('remote_code_run transport finished, but task-level changes were not proven.');
    expect(result.verifyResults).toEqual(['remote_code_run reached status completed.']);
    expect(result.finalOutput).toContain('REMOTE_CLI_JOB_ID=rcli_preview');
    expect(result.finalOutput).toContain('BLOCKER=remote_code_run completed without task proof markers');
  });

  test('falls back to direct remote_code_run when the inner agent run times out', async () => {
    const calls = {
      toolCalls: [],
      progress: [],
      runnerCalled: false,
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-timeout';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_timeout',
                sessionId: 'remote-session-timeout',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_CLI_JOB_ID=rcli_timeout',
                'REMOTE_CLI_SESSION_ID=remote-session-timeout',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Finished after direct fallback.',
                'VERIFY_COMMANDS=remote_code_status',
                'VERIFY_RESULTS=Remote job completed.',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        calls.runnerCalled = true;
        return new Promise(() => {});
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
        agentModel: 'kimi-for-coding',
        directRun: false,
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
      task: 'Deploy the live app and verify it.',
      waitMs: 30000,
      agentRunTimeoutMs: 1,
      maxStatusPolls: 1,
      statusPollIntervalMs: 0,
      onProgress: (progress) => calls.progress.push(progress),
    });

    expect(calls.runnerCalled).toBe(true);
    expect(calls.progress.some((progress) => /stale wait budget was exceeded; continuing with direct remote_code_run/i.test(progress.reasoningSummary))).toBe(true);
    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: expect.stringContaining('Deploy the live app and verify it.'),
          model: 'gpt-5.4',
          adminMode: true,
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: { jobId: 'rcli_timeout' },
      },
    ]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_timeout',
      sessionId: 'remote-session-timeout',
      cwd: '/srv/apps/my-app',
      whatChanged: 'Finished after direct fallback.',
      completionStatus: 'complete',
    });
  });

  test('forces direct remote_code_run when the inner agent returns partial proof without tool use', async () => {
    const calls = {
      toolCalls: [],
      progress: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-contract';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_contract',
                sessionId: 'remote-session-contract',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_CLI_JOB_ID=rcli_contract',
                'REMOTE_CLI_SESSION_ID=remote-session-contract',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Ran the remote build through the direct fallback.',
                'VERIFY_COMMANDS=remote_code_status',
                'VERIFY_RESULTS=Remote job completed after direct fallback.',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {}

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run() {
        return {
          finalOutput: [
            'I can help with that remote build.',
            'WHAT_CHANGED=Prepared to inspect the remote workspace.',
            'PUBLIC_URL=not_available',
            'BLOCKER=none',
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
        agentModel: 'kimi-for-coding',
        directRun: false,
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
      task: 'Build the backend remotely and verify the health route.',
      waitMs: 30000,
      maxStatusPolls: 2,
      statusPollIntervalMs: 0,
      onProgress: (progress) => calls.progress.push(progress),
    });

    expect(calls.progress.some((progress) => /without calling remote_code_run/i.test(progress.reasoningSummary))).toBe(true);
    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: expect.stringContaining('Build the backend remotely and verify the health route.'),
          model: 'gpt-5.4',
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: { jobId: 'rcli_contract' },
      },
    ]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_contract',
      sessionId: 'remote-session-contract',
      whatChanged: 'Ran the remote build through the direct fallback.',
      verifyResults: ['Remote job completed after direct fallback.'],
      completionStatus: 'complete',
    });
  });

  test('polls an observed remote_code_run job and blocks UI tasks without visual proof', async () => {
    const calls = {
      toolCalls: [],
      progress: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-observed';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'running',
                jobId: 'rcli_observed',
                sessionId: 'remote-session-observed',
              }),
            }],
          };
        }
        if (name === 'remote_code_status') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_CLI_JOB_ID=rcli_observed',
                'REMOTE_CLI_SESSION_ID=remote-session-observed',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Polled the remote job the inner agent started.',
                'VERIFY_COMMANDS=remote_code_status',
                'VERIFY_RESULTS=Observed remote job completed.',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {
      constructor(config) {
        this.config = config;
      }
    }

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run(agent) {
        await agent.config.mcpServers[0].callTool('remote_code_run', {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: 'Build started by the inner agent.',
          waitMs: 30000,
        });
        return {
          finalOutput: 'Started the remote job and will report back.',
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
        agentModel: 'kimi-for-coding',
        directRun: false,
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
      task: 'Build the frontend remotely and verify the live route.',
      waitMs: 30000,
      maxStatusPolls: 2,
      statusPollIntervalMs: 0,
      onProgress: (progress) => calls.progress.push(progress),
    });

    expect(calls.progress.some((progress) => /polling remote_code_status for job rcli_observed/i.test(progress.reasoningSummary))).toBe(true);
    expect(calls.toolCalls).toEqual([
      {
        name: 'remote_code_run',
        args: {
          targetId: 'prod',
          cwd: '/srv/apps/my-app',
          task: 'Build started by the inner agent.',
          waitMs: 30000,
        },
      },
      {
        name: 'remote_code_status',
        args: { jobId: 'rcli_observed' },
      },
    ]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_observed',
      sessionId: 'remote-session-observed',
      whatChanged: 'Polled the remote job the inner agent started.',
      verifyResults: [
        'Observed remote job completed.',
        'Missing browser/Playwright or kimibuilt-ui-check evidence for a UI-affecting remote task.',
      ],
      blocker: 'Missing browser/Playwright or kimibuilt-ui-check evidence for a UI-affecting remote task.',
      completionStatus: 'blocked',
      agentQuality: expect.objectContaining({
        status: 'blocked',
        requiredMissing: expect.arrayContaining(['public_or_preview_url', 'browser_proof']),
      }),
    });
  });

  test('continues an existing remote_code_run job with status-only polling', async () => {
    const calls = {
      toolCalls: [],
      runnerCalled: false,
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-4';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        return {
          content: [{
            type: 'text',
            text: [
              'REMOTE_CLI_JOB_ID=rcli_456',
              'REMOTE_CLI_SESSION_ID=remote-session-4',
              'WHAT_CHANGED=Continued the existing remote job.',
              'VERIFY_COMMANDS=remote_code_status',
              'VERIFY_RESULTS=Remote job completed.',
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
        calls.runnerCalled = true;
        throw new Error('inner agent should not run for jobId continuations');
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
        agentModel: 'kimi-for-coding',
        directRun: false,
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
      task: 'Continue the remote job.',
      jobId: 'rcli_456',
      maxStatusPolls: 1,
      statusPollIntervalMs: 0,
    });

    expect(calls.runnerCalled).toBe(false);
    expect(calls.toolCalls).toEqual([{
      name: 'remote_code_status',
      args: { jobId: 'rcli_456' },
    }]);
    expect(result).toMatchObject({
      remoteCodeJobId: 'rcli_456',
      sessionId: 'remote-session-4',
      whatChanged: 'Continued the existing remote job.',
      completionStatus: 'complete',
    });
  });

  test('starts a fresh remote_code_run when a saved job id is no longer known by the gateway', async () => {
    const calls = {
      toolCalls: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-stale';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_status') {
          throw new Error('MCP error -32000: Unknown remote CLI job: rcli_stale');
        }
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_AGENT_RESULT=fresh-after-stale:/srv/apps/my-app',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Started a fresh remote job after stale job id.',
                'VERIFY_COMMANDS=pwd',
                'VERIFY_RESULTS=/srv/apps/my-app',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    const runner = new RemoteCliAgentsSdkRunner({
      config: {
        enabled: true,
        url: 'https://gateway.example.com/mcp',
        name: 'remote-cli',
        apiKey: 'gateway-secret',
        defaultTargetId: 'k3s-prod',
        defaultCwd: '/srv/apps/my-app',
      },
      sdkLoader: () => ({
        MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
      }),
    });

    const result = await runner.run({
      task: 'Check pwd on the remote server.',
      jobId: 'rcli_stale',
      maxStatusPolls: 3,
      statusPollIntervalMs: 0,
    });

    expect(calls.toolCalls.map((call) => call.name)).toEqual([
      'remote_code_status',
      'remote_code_run',
    ]);
    expect(calls.toolCalls[1].args).toMatchObject({
      targetId: 'k3s-prod',
      cwd: '/srv/apps/my-app',
      task: expect.stringContaining('Check pwd on the remote server.'),
    });
    expect(result).toMatchObject({
      remoteCodeJobId: null,
      cwd: '/srv/apps/my-app',
      whatChanged: 'Started a fresh remote job after stale job id.',
      completionStatus: 'complete',
    });
  });

  test('falls back to fresh direct run when the inner agent polls a stale job id', async () => {
    const calls = {
      toolCalls: [],
      progress: [],
    };

    class FakeMCPServerStreamableHttp {
      constructor() {
        this.sessionId = 'mcp-session-inner-stale';
      }

      async connect() {}

      async close() {}

      async callTool(name, args) {
        calls.toolCalls.push({ name, args });
        if (name === 'remote_code_status') {
          throw new Error('MCP error -32000: Unknown remote CLI job: rcli_inner_stale');
        }
        if (name === 'remote_code_run') {
          return {
            content: [{
              type: 'text',
              text: [
                'REMOTE_AGENT_RESULT=inner-fresh:/srv/apps/my-app',
                'WORKSPACE=/srv/apps/my-app',
                'WHAT_CHANGED=Recovered from stale inner job id.',
                'VERIFY_COMMANDS=pwd',
                'VERIFY_RESULTS=/srv/apps/my-app',
                'PUBLIC_URL=not_available',
                'BLOCKER=none',
              ].join('\n'),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    }

    class FakeAgent {
      constructor(config) {
        this.config = config;
      }
    }

    class FakeOpenAIProvider {}

    class FakeRunner {
      async run(agent) {
        await agent.config.mcpServers[0].callTool('remote_code_status', {
          jobId: 'rcli_inner_stale',
        });
        return { finalOutput: 'unreachable' };
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
        agentModel: 'gpt-5.4',
        directRun: false,
        defaultTargetId: 'k3s-prod',
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
      task: 'Check pwd on the remote server.',
      maxStatusPolls: 3,
      statusPollIntervalMs: 0,
      onProgress: (progress) => calls.progress.push(progress),
    });

    expect(calls.progress.some((progress) => /stale remote_code_run job/i.test(progress.reasoningSummary))).toBe(true);
    expect(calls.toolCalls.map((call) => call.name)).toEqual([
      'remote_code_status',
      'remote_code_run',
    ]);
    expect(calls.toolCalls[1].args.task).toContain('Check pwd on the remote server.');
    expect(result).toMatchObject({
      cwd: '/srv/apps/my-app',
      whatChanged: 'Recovered from stale inner job id.',
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
        directRun: false,
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

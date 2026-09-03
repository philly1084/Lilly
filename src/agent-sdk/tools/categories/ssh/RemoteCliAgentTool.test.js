const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { RemoteCliAgentTool } = require('./RemoteCliAgentTool');
const { clusterStateRegistry } = require('../../../../cluster-state-registry');
const { createRemoteAgentHandoff } = require('../../../../remote-cli/agent-handoff');

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
  test('polls an owned artifact job with the original operation and no repeated input export', async () => {
    const handoff = await createRemoteAgentHandoff({
      contextFiles: [{ filename: 'source.txt', content: 'original bytes' }],
      collectResultFiles: true,
    }, { sessionId: 'session-1' });
    const runner = { run: jest.fn(async () => ({ remoteCodeJobId: 'job-owned', targetId: 'k3s-primary', completionStatus: 'running' })) };
    const tool = new RemoteCliAgentTool({ runner });
    const result = await tool.execute({ task: 'Check the same running job', jobId: 'job-owned', targetId: 'k3s-primary', collectResultFiles: true }, {
      sessionId: 'session-1',
      controlState: { remoteCliAgent: { remoteCodeJobId: 'job-owned', targetId: 'k3s-primary', remoteAgentHandoff: handoff } },
    });
    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      resumeOnly: true,
      handoff: expect.objectContaining({ operationId: handoff.operationId, files: [] }),
    }));
    expect(result.data.remoteAgentHandoff.operationId).toBe(handoff.operationId);
    expect(result.data.remoteAgentHandoff.files).toEqual([]);
  });

  test('does not inherit another job artifact operation', async () => {
    const handoff = await createRemoteAgentHandoff({ collectResultFiles: true }, { sessionId: 'session-1' });
    const { tool, runner } = buildTool();
    await tool.execute({ task: 'Check job', jobId: 'job-other', targetId: 'k3s-primary', collectResultFiles: true }, {
      sessionId: 'session-1',
      controlState: { remoteCliAgent: { remoteCodeJobId: 'job-owned', targetId: 'k3s-primary', remoteAgentHandoff: handoff } },
    });
    expect(runner.run.mock.calls[0][0].handoff.operationId).not.toBe(handoff.operationId);
    expect(runner.run.mock.calls[0][0].resumeOnly).not.toBe(true);
  });
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

  test('preserves relative paths and code whitespace when removing outer tool wording', async () => {
    const { tool, runner } = buildTool();
    const task = 'Use remote-cli-agent to create only .kimibuilt/agent-company/proof.txt.\n\n```python\nif ready:\n  write_file()\n```';
    await tool.execute({ task });
    expect(runner.run.mock.calls[0][0].task).toBe('create only .kimibuilt/agent-company/proof.txt.\n\n```python\nif ready:\n  write_file()\n```');
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

  test('inherits active Codex or Kimi chat models, including bare k3, for remote CLI routing', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      task: 'Build and verify the remote app.',
    }, {
      model: 'gpt-5.6-sol',
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Build and verify the remote app.',
      model: 'gpt-5.6-sol',
    }));

    await tool.execute({ task: 'Build with Kimi K3.' }, { model: 'k3' });
    expect(runner.run).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'k3' }));

    await tool.execute({ task: 'Build with the default active provider.' }, { model: 'grok-build' });
    expect(runner.run).toHaveBeenLastCalledWith(expect.not.objectContaining({ model: 'grok-build' }));
  });

  test('stages selected session artifacts into the versioned runner handoff', async () => {
    const runner = {
      run: jest.fn(async () => ({
        finalOutput: 'RESULT_FILES_MANIFEST=.kimibuilt/remote-agent-results.json',
        resultFilesManifest: '.kimibuilt/remote-agent-results.json',
      })),
    };
    const artifactService = {
      getArtifact: jest.fn(async () => ({
        id: 'artifact-design-1',
        sessionId: 'session-1',
        filename: 'design.svg',
        mimeType: 'image/svg+xml',
        contentBuffer: Buffer.from('<svg/>'),
        sizeBytes: Buffer.byteLength('<svg/>'),
      })),
    };
    const tool = new RemoteCliAgentTool({ runner, artifactService });

    const result = await tool.execute({
      task: 'Use the selected design to build and verify the remote page.',
      artifact_ids: ['artifact-design-1'],
      context_files: [{
        filename: 'brief.xml',
        mimeType: 'application/xml',
        content: '<brief/>',
      }],
    }, {
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      requestedHandoffVersion: 'RemoteAgentHandoff/v1',
      inputArtifactIds: ['artifact-design-1'],
      resultFilesManifest: '.kimibuilt/remote-agent-results.json',
    });
    expect(result.data).not.toHaveProperty('handoff');
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      handoff: expect.objectContaining({
        version: 'RemoteAgentHandoff/v1',
        sourceArtifactIds: ['artifact-design-1'],
        files: expect.arrayContaining([
          expect.objectContaining({ filename: 'brief.xml', mimeType: 'application/xml' }),
          expect.objectContaining({ filename: 'design.svg', artifactId: 'artifact-design-1' }),
        ]),
      }),
    }));
    expect(artifactService.getArtifact).toHaveBeenNthCalledWith(1, 'artifact-design-1');
    expect(artifactService.getArtifact).toHaveBeenNthCalledWith(2, 'artifact-design-1', { includeContent: true });
  });

  test('fails closed when a selected artifact belongs to another session', async () => {
    const runner = { run: jest.fn() };
    const tool = new RemoteCliAgentTool({
      runner,
      artifactService: {
        getArtifact: jest.fn(async () => ({
          id: 'artifact-other',
          sessionId: 'session-other',
          filename: 'private.xml',
          contentBuffer: Buffer.from('<private/>'),
        })),
      },
    });

    const result = await tool.execute({
      task: 'Use the selected file.',
      artifactIds: ['artifact-other'],
    }, {
      sessionId: 'session-1',
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('REMOTE_AGENT_HANDOFF_ARTIFACT_SCOPE_MISMATCH');
    expect(runner.run).not.toHaveBeenCalled();
  });

  test('does not start the remote runner when returned files have no active session', async () => {
    const runner = { run: jest.fn() };
    const tool = new RemoteCliAgentTool({ runner });

    const result = await tool.execute({
      task: 'Build the remote document and return its files.',
      collectResultFiles: true,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('REMOTE_AGENT_HANDOFF_SESSION_REQUIRED');
    expect(runner.run).not.toHaveBeenCalled();
  });

  test('persists verified return files as session artifacts without exposing base64', async () => {
    const content = Buffer.from('<document><title>Remote draft</title></document>');
    let storedArtifact = null;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        storedArtifact = {
          ...input,
          id: 'artifact-returned-1',
          sizeBytes: input.buffer.length,
          contentBuffer: input.buffer,
        };
        return storedArtifact;
      }),
      getArtifact: jest.fn(async (id) => (
        id === storedArtifact?.id ? storedArtifact : null
      )),
      serializeArtifact: jest.fn((artifact) => ({
        id: artifact.id,
        sessionId: artifact.sessionId,
        filename: artifact.filename,
        metadata: artifact.metadata,
      })),
      deleteArtifact: jest.fn(),
    };
    const runner = {
      run: jest.fn(async (params) => ({
        finalOutput: `RESULT_FILES_MANIFEST=${params.handoff.output.manifestPath}`,
        handoffVersion: params.handoff.version,
        resultFilesManifest: params.handoff.output.manifestPath,
        resultFiles: {
          version: 'RemoteAgentResultFiles/v1',
          gatewayVerified: true,
          operationId: params.handoff.operationId,
          manifestPath: params.handoff.output.manifestPath,
          files: [{
            path: `${params.handoff.output.filesDirectory}/draft.xml`,
            filename: 'draft.xml',
            role: 'document',
            mimeType: 'application/xml',
            description: 'Remote XML draft',
            sizeBytes: content.length,
            sha256: crypto.createHash('sha256').update(content).digest('hex'),
            contentBase64: content.toString('base64'),
          }],
        },
        transport: 'codex-agent',
        targetId: 'k3s-prod',
        cwd: '/srv/apps/docs',
        sessionId: 'thread-1',
        completionStatus: 'complete',
        verifyResults: ['passed'],
      })),
    };
    const tool = new RemoteCliAgentTool({ runner, artifactService });

    const result = await tool.execute({
      task: 'Create the XML document and return it.',
      collectResultFiles: true,
    }, {
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      handoffVersion: 'RemoteAgentHandoff/v1',
      requestedHandoffVersion: 'RemoteAgentHandoff/v1',
      artifactIds: ['artifact-returned-1'],
      artifactQuality: {
        version: 'ArtifactStructuralQuality/v1',
        status: 'passed',
        blockers: [],
      },
      artifacts: [expect.objectContaining({
        id: 'artifact-returned-1',
        filename: 'draft.xml',
      })],
      resultFiles: [expect.objectContaining({
        filename: 'draft.xml',
        role: 'document',
        artifactQuality: expect.objectContaining({ status: 'passed', scope: 'file' }),
      })],
    });
    expect(tool.outputSchema.properties.artifactQuality).toEqual({ type: 'object' });
    expect(tool.outputSchema.properties.providerModel).toEqual({ type: 'string' });
    expect(result.data.resultFiles[0]).not.toHaveProperty('contentBase64');
    expect(artifactService.createStoredArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      sourceMode: 'remote-cli-agent',
      filename: 'draft.xml',
      buffer: content,
      metadata: expect.objectContaining({
        artifactQuality: expect.objectContaining({
          status: 'passed',
          scope: 'file',
          basis: 'normalized-result-set',
        }),
      }),
    }));
  });

  test('returns blocked completion and structural quality details without writing failed outputs', async () => {
    const content = Buffer.from('{"ready":}');
    const artifactService = { createStoredArtifact: jest.fn() };
    const runner = {
      run: jest.fn(async (params) => ({
        finalOutput: `RESULT_FILES_MANIFEST=${params.handoff.output.manifestPath}`,
        resultFiles: {
          version: 'RemoteAgentResultFiles/v1',
          gatewayVerified: true,
          operationId: params.handoff.operationId,
          manifestPath: params.handoff.output.manifestPath,
          files: [{
            path: `${params.handoff.output.filesDirectory}/broken.json`,
            filename: 'broken.json',
            role: 'data',
            mimeType: 'application/json',
            description: 'Invalid returned data',
            sizeBytes: content.length,
            sha256: crypto.createHash('sha256').update(content).digest('hex'),
            contentBase64: content.toString('base64'),
          }],
        },
        transport: 'codex-agent',
        completionStatus: 'complete',
        verifyResults: ['remote generation completed'],
      })),
    };
    const tool = new RemoteCliAgentTool({ runner, artifactService });

    const result = await tool.execute({
      task: 'Return validated JSON.',
      collectResultFiles: true,
    }, {
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      completionStatus: 'blocked',
      artifactQuality: {
        version: 'ArtifactStructuralQuality/v1',
        status: 'blocked',
        blockers: [expect.objectContaining({
          code: 'REMOTE_AGENT_ARTIFACT_JSON_INVALID',
          path: 'broken.json',
        })],
      },
      resultFilesError: expect.stringContaining('structural quality validation blocked 1 issue'),
      blocker: expect.stringContaining('structural quality validation blocked 1 issue'),
    });
    expect(result.data).not.toHaveProperty('artifacts');
    expect(result.data).not.toHaveProperty('artifactIds');
    expect(artifactService.createStoredArtifact).not.toHaveBeenCalled();
  });

  test('returns an explicit native site bundle artifact for role-marked website files', async () => {
    const html = Buffer.from('<!doctype html><title>Remote Site</title><link rel="stylesheet" href="styles.css"><main>Ready</main>');
    const css = Buffer.from('body { color: navy; }');
    const records = new Map();
    let counter = 0;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        const stored = {
          ...input,
          id: `artifact-site-${++counter}`,
          contentBuffer: input.buffer,
          sizeBytes: input.buffer.length,
        };
        records.set(stored.id, stored);
        return stored;
      }),
      getArtifact: jest.fn(async (id) => records.get(id) || null),
      serializeArtifact: jest.fn((artifact) => ({
        id: artifact.id,
        filename: artifact.filename,
        extension: artifact.extension,
        metadata: artifact.metadata,
      })),
      deleteArtifact: jest.fn(),
    };
    const runner = {
      run: jest.fn(async (params) => ({
        finalOutput: `RESULT_FILES_MANIFEST=${params.handoff.output.manifestPath}`,
        resultFiles: {
          version: 'RemoteAgentResultFiles/v1',
          gatewayVerified: true,
          operationId: params.handoff.operationId,
          manifestPath: params.handoff.output.manifestPath,
          files: [
            {
              path: `${params.handoff.output.filesDirectory}/dist/index.html`,
              filename: 'index.html',
              role: 'site-entry',
              mimeType: 'text/html',
              description: 'Website entry',
              sizeBytes: html.length,
              sha256: crypto.createHash('sha256').update(html).digest('hex'),
              contentBase64: html.toString('base64'),
            },
            {
              path: `${params.handoff.output.filesDirectory}/dist/styles.css`,
              filename: 'styles.css',
              role: 'site-file',
              mimeType: 'text/css',
              description: 'Website styles',
              sizeBytes: css.length,
              sha256: crypto.createHash('sha256').update(css).digest('hex'),
              contentBase64: css.toString('base64'),
            },
          ],
        },
        transport: 'provider-agent',
        providerId: 'kimi-code-cli',
        completionStatus: 'complete',
      })),
    };
    const tool = new RemoteCliAgentTool({ runner, artifactService });

    const result = await tool.execute({
      task: 'Build and return a complete website.',
      collectResultFiles: true,
    }, {
      sessionId: 'session-1',
      ownerId: 'owner-1',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      siteBundleArtifactId: 'artifact-site-3',
      siteBundleArtifact: expect.objectContaining({
        id: 'artifact-site-3',
        extension: 'zip',
        metadata: expect.objectContaining({
          artifactQuality: expect.objectContaining({
            status: 'passed',
            scope: 'site-bundle',
            basis: 'persisted-result-set',
          }),
          siteBundle: expect.objectContaining({ entry: 'index.html', fileCount: 2 }),
        }),
      }),
    }));
    expect(result.data.resultFiles).toEqual([
      expect.objectContaining({ role: 'site-entry', artifactId: 'artifact-site-1' }),
      expect.objectContaining({ role: 'site-file', artifactId: 'artifact-site-2' }),
    ]);
    expect(result.data.resultFiles.every((file) => !Object.hasOwn(file, 'contentBase64'))).toBe(true);
  });

  test('omits absent provider proof fields before validating the tool output schema', async () => {
    const runner = {
      run: jest.fn(async () => ({
        finalOutput: 'REMOTE_AGENT_RESULT=success provider completed',
        transport: 'provider-agent',
        providerId: 'kimi-code-cli',
        targetId: 'k3s-prod',
        cwd: '/opt/kimibuilt',
        sessionId: 'session-kimi',
        remoteCodeSessionId: 'session-kimi',
        remoteCodeJobId: 'task-kimi',
        gitRepo: null,
        gitBranch: null,
        gitBaseCommit: null,
        gitCommit: null,
        changedFiles: [],
        deployment: null,
        publicHost: null,
        publicUrl: null,
        uiCheckReport: null,
        uiScreenshots: [],
        whatChanged: 'Read-only provider verification.',
        verifyCommands: ['pwd'],
        verifyResults: ['/opt/kimibuilt'],
        blocker: null,
        completionStatus: 'complete',
        agentQuality: {},
        model: 'kimi-for-coding',
        apiMode: 'provider-agent',
      })),
    };
    const tool = new RemoteCliAgentTool({ runner });

    const result = await tool.execute({
      task: 'Run a read-only provider verification.',
      model: 'kimi-for-coding',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      transport: 'provider-agent',
      providerId: 'kimi-code-cli',
      completionStatus: 'complete',
      whatChanged: 'Read-only provider verification.',
    });
    expect(result.data).not.toHaveProperty('gitRepo');
    expect(result.data).not.toHaveProperty('gitBranch');
    expect(result.data).not.toHaveProperty('deployment');
    expect(result.data).not.toHaveProperty('blocker');
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
            mcpSessionId: 'mcp_calan_session',
            remoteCodeJobId: 'job_calan_running',
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
      mcpSessionId: 'mcp_calan_session',
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
    expect(runner.run.mock.calls[0][0].jobId).toBeUndefined();
    expect(runner.run.mock.calls[0][0].continuitySummary).toContain('prior job is terminal');
  });

  test('does not reuse prior sessions or jobs when the requested target changes', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      task: 'Continue the Penguin deployment on the corrected server.',
      targetId: 'k3s-secondary',
      cwd: '/opt/kimibuilt',
    }, {
      session: {
        controlState: {
          remoteCliAgent: {
            sessionId: 'remote-primary-session',
            mcpSessionId: 'mcp-primary-session',
            remoteCodeJobId: 'ragent_primary_job',
            targetId: 'k3s-prod',
            cwd: '/opt/kimibuilt',
            publicHost: 'penguin.demoserver2.buzz',
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'k3s-secondary',
      cwd: '/opt/kimibuilt',
    }));
    const observedParams = runner.run.mock.calls[0][0];
    expect(observedParams.sessionId).toBeUndefined();
    expect(observedParams.mcpSessionId).toBeUndefined();
    expect(observedParams.jobId).toBeUndefined();
  });

  test.each(['complete', 'completed', 'failed', 'blocked', 'terminated'])('does not silently re-add a %s job for new follow-up work', async (completionStatus) => {
    const { tool, runner } = buildTool();
    const nativeId = '12345678-1234-4234-8234-123456789abc';
    await tool.execute({ task: 'Continue the same goal and return the source files.', collectResultFiles: true }, {
      sessionId: 'owned', controlState: { remoteCliAgent: {
        remoteCodeJobId: 'old-terminal-job', sessionId: nativeId, remoteCodeSessionId: nativeId,
        targetId: 'k3s-primary', cwd: '/opt/project', completionStatus,
      } },
    });
    expect(runner.run.mock.calls[0][0]).toMatchObject({ sessionId: nativeId, handoff: { output: { enabled: true } } });
    expect(runner.run.mock.calls[0][0].jobId).toBeUndefined();
    expect(runner.run.mock.calls[0][0].resumeOnly).not.toBe(true);
  });

  test('keeps an unobserved pending job rather than launching another task', async () => {
    const { tool, runner } = buildTool();
    await tool.execute({ task: 'Continue that job.' }, {
      controlState: { remoteCliAgent: { remoteCodeJobId: 'pending-job', completionStatus: 'running', observationStatus: 'unavailable' } },
    });
    expect(runner.run.mock.calls[0][0].jobId).toBe('pending-job');
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

  test('reuses MCP and job continuity even when the prior result has no remote session id', async () => {
    const { tool, runner } = buildTool();

    const result = await tool.execute({
      task: 'Continue that running job.',
    }, {
      session: {
        controlState: {
          remoteCliAgent: {
            mcpSessionId: 'mcp-only-session',
            remoteCodeJobId: 'job-only-running',
            completionStatus: 'running',
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      mcpSessionId: 'mcp-only-session',
      jobId: 'job-only-running',
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

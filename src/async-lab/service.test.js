'use strict';

const { AsyncLabService } = require('./service');
const { AsyncLabStore } = require('./store');
const { ValkeyLiveBus } = require('./valkey-live-bus');
const { RemoteCliAgentTool } = require('../agent-sdk/tools/categories/ssh/RemoteCliAgentTool');
const { mergeControlState } = require('../runtime-control-state');

function createSessionStore(sessions = []) {
    const byId = new Map(sessions.map((session) => [session.id, {
        ...session,
        controlState: session.controlState || {},
        metadata: session.metadata || {},
    }]));
    return {
        getOwned: jest.fn(async (id, ownerId) => {
            const session = byId.get(id) || null;
            if (!session || (ownerId && session.ownerId && session.ownerId !== ownerId)) {
                return null;
            }
            return session;
        }),
        updateControlState: jest.fn(async (id, patch) => {
            const session = byId.get(id);
            if (!session) {
                return null;
            }
            session.controlState = mergeControlState(session.controlState, patch);
            session.metadata = {
                ...session.metadata,
                controlState: session.controlState,
                ...(session.controlState.remoteCliAgent
                    ? { remoteCliAgent: session.controlState.remoteCliAgent }
                    : {}),
            };
            return session.controlState;
        }),
        getSession(id) {
            return byId.get(id) || null;
        },
    };
}

function createService(overrides = {}) {
    const store = overrides.store || new AsyncLabStore({ persistToPostgres: false });
    const bus = overrides.bus || new ValkeyLiveBus({});
    const instanceId = overrides.instanceId || 'test-async-lab';
    const toolManager = overrides.toolManager || null;
    const toolExecutionContext = overrides.toolExecutionContext || {};
    const sessionStore = overrides.sessionStore || null;
    delete overrides.store;
    delete overrides.bus;
    delete overrides.instanceId;
    delete overrides.toolManager;
    delete overrides.toolExecutionContext;
    delete overrides.sessionStore;

    return new AsyncLabService({
        config: {
            enabled: true,
            mode: 'lab',
            namespace: 'kimibuilt-async-lab',
            surface: 'async-lab',
            workerEnabled: false,
            simulationDelayMs: 0,
            lockRetryMs: 5,
            maxLockWaitMs: 40,
            leaseTtlMs: 1000,
            allowLiveRemote: false,
            persistToPostgres: false,
            ...overrides,
        },
        store,
        bus,
        instanceId,
        toolManager,
        toolExecutionContext,
        sessionStore,
    });
}

describe('AsyncLabService', () => {
    test('rejects run creation when disabled', async () => {
        const service = createService({ enabled: false });

        await expect(service.createRun({ task: 'nope' }, 'tester')).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    test('applies admin control without enabling live remote unless env permits it', async () => {
        const service = createService({
            enabled: false,
            adminToggleAllowed: true,
            allowLiveRemote: false,
        });

        const enabled = await service.applyControlConfig({
            enabled: true,
            allowLiveRemote: true,
            workerEnabled: false,
        });

        expect(enabled).toEqual(expect.objectContaining({
            active: true,
            enabled: true,
        }));
        expect(service.getStatus()).toEqual(expect.objectContaining({
            enabled: true,
            adminToggleAllowed: true,
            allowLiveRemote: false,
            workerRunning: false,
        }));

        const disabled = await service.applyControlConfig({ enabled: false });
        expect(disabled).toEqual(expect.objectContaining({
            active: false,
            enabled: false,
            reason: 'disabled',
        }));
        expect(service.isEnabled()).toBe(false);
    });

    test('creates lab-tagged runs and keeps remote adapters dry-run by default', async () => {
        const service = createService();
        const created = await service.createRun({
            task: 'ship a remote change',
            adapter: 'remote-cli-agent',
            targetKey: 'host/prod',
            liveRemote: true,
        }, 'tester');

        expect(created.run.runtimeSurface).toBe('async-lab');
        expect(created.run.status).toBe('queued');
        expect(created.run.liveRemoteRequested).toBe(true);
        expect(created.run.liveRemoteAllowed).toBe(false);
        expect(created.run.metadata.dryRun).toBe(true);

        await service.drainQueue();
        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);

        expect(run.status).toBe('completed');
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'queued',
            'started',
            'safety',
            'tool_message',
            'checkpoint',
            'completed',
        ]));
        expect(events.find((event) => event.type === 'safety').payload.dryRun).toBe(true);
    });

    test('executes approved live remote adapters through the attached tool manager', async () => {
        const executeTool = jest.fn(async () => ({
            success: true,
            data: {
                message: 'remote command observed',
                stdout: 'ok',
            },
            duration: 25,
            toolId: 'remote-command',
            verification: {
                status: 'observed',
                evidence: 'fake tool result',
            },
        }));
        const managedAppService = { id: 'managed-app-service' };
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
            toolExecutionContext: {
                managedAppService,
            },
        });
        const created = await service.createRun({
            task: 'hostname',
            adapter: 'remote-command',
            targetKey: 'primary/main-server',
            liveRemote: true,
            metadata: {
                toolParams: {
                    command: 'hostname',
                    targetId: 'primary',
                },
            },
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);
        expect(run.status).toBe('completed');
        expect(run.metadata.toolResult).toEqual(expect.objectContaining({
            adapter: 'remote-command',
            success: true,
            durationMs: 25,
        }));
        expect(executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: 'hostname',
                targetId: 'primary',
            }),
            expect.objectContaining({
                route: '/api/async-lab',
                transport: 'async-runtime',
                executionProfile: 'async-runtime',
                ownerId: 'tester',
                managedAppService,
            }),
        );
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'tool_started',
            'tool_completed',
            'completed',
        ]));
        expect(events.find((event) => event.type === 'completed').payload.toolExecuted).toBe(true);
    });

    test('retains only safe compact remote-agent result fields in the async run', async () => {
        const rawBase64 = Buffer.from('<html>raw result content</html>').toString('base64');
        const secretToken = 'super-secret-token-value';
        const executeTool = jest.fn(async () => ({
            success: true,
            duration: 44,
            toolId: 'remote-cli-agent',
            data: {
                message: `key=${secretToken} credentials=${secretToken} client_secret=${secretToken} keyboard=compact monkey=capuchin`,
                completionStatus: 'completed',
                providerId: 'kimi',
                providerModel: 'k3',
                model: 'kimi-k3',
                transport: 'provider-agent',
                finalOutput: `Deployment finished. token=${secretToken}`,
                whatChanged: 'Published the website bundle.',
                verifyCommands: ['curl -fsS https://demo.example.test/'],
                verifyResults: ['HTTPS returned 200.'],
                publicUrl: `https://demo.example.test/?X-Amz-Credential=${secretToken}&X-Amz-Signature=${secretToken}&X-Amz-Security-Token=${secretToken}&client_secret=${secretToken}&keyboard=compact&monkey=capuchin&view=1#view=1&key=${secretToken}`,
                publicHost: 'demo.example.test',
                artifactIds: ['artifact-html'],
                resultFiles: [{
                    filename: 'index.html',
                    relativePath: 'site/index.html',
                    artifactId: 'artifact-html',
                    mimeType: 'text/html',
                    role: 'site-entry',
                    sizeBytes: 128,
                    sha256: 'a'.repeat(64),
                    gatewayVerified: true,
                    contentBase64: rawBase64,
                    secret: secretToken,
                    metadata: { apiKey: secretToken },
                }],
                artifacts: [{
                    id: 'artifact-html',
                    filename: 'index.html',
                    mimeType: 'text/html',
                    sizeBytes: 128,
                    downloadUrl: `/api/artifacts/artifact-html/download?X-Goog-Signature=${secretToken}&sig=${secretToken}&keynote=opening&view=1`,
                    metadata: { secret: secretToken },
                    contentBase64: rawBase64,
                }],
                siteBundleArtifact: {
                    id: 'artifact-bundle',
                    filename: 'demo-site.zip',
                    mimeType: 'application/zip',
                    downloadUrl: '/api/artifacts/artifact-bundle/download',
                    bundleDownloadUrl: `/api/artifacts/artifact-bundle/bundle?X-Amz-Credential=${secretToken}&X-Amz-Signature=${secretToken}&keyboard=compact`,
                    contentBase64: rawBase64,
                },
                siteBundleArtifactId: 'artifact-bundle',
                artifactQuality: {
                    version: 'ArtifactStructuralQuality/v1',
                    status: 'passed',
                    files: [{
                        path: 'site/index.html',
                        filename: 'index.html',
                        role: 'site-entry',
                        mimeType: 'text/html',
                        format: 'html',
                        sizeBytes: 128,
                        text: '<html>must not escape</html>',
                        contentBase64: rawBase64,
                    }],
                    site: {
                        enabled: true,
                        entries: ['site/index.html'],
                        checkedReferences: 3,
                    },
                    warnings: [{
                        code: 'EXAMPLE_WARNING',
                        path: 'site/index.html',
                        message: `Reference token=${secretToken} was ignored.`,
                        secret: secretToken,
                    }],
                    secret: secretToken,
                },
                apiKey: secretToken,
                contentBase64: rawBase64,
            },
        }));
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
        });
        const created = await service.createRun({
            task: 'Build from the selected artifact.',
            adapter: 'remote-cli-agent',
            targetKey: 'primary/main-server',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const toolResult = run.metadata.toolResult;
        expect(run.status).toBe('completed');
        expect(toolResult).toEqual(expect.objectContaining({
            success: true,
            completionStatus: 'completed',
            provider: 'kimi',
            providerModel: 'k3',
            model: 'kimi-k3',
            transport: 'provider-agent',
            finalOutput: 'Deployment finished. token=[redacted]',
            whatChanged: 'Published the website bundle.',
            verifyCommands: ['curl -fsS https://demo.example.test/'],
            verifyResults: ['HTTPS returned 200.'],
            publicUrl: 'https://demo.example.test/?keyboard=compact&monkey=capuchin&view=1',
            publicHost: 'demo.example.test',
            artifactIds: ['artifact-html', 'artifact-bundle'],
            siteBundleArtifactId: 'artifact-bundle',
        }));
        expect(toolResult.resultFiles).toEqual([
            expect.objectContaining({
                filename: 'index.html',
                relativePath: 'site/index.html',
                artifactId: 'artifact-html',
                gatewayVerified: true,
            }),
        ]);
        expect(toolResult.resultFiles[0]).not.toHaveProperty('contentBase64');
        expect(toolResult.resultFiles[0]).not.toHaveProperty('metadata');
        expect(toolResult.data.message).toBe('key=[redacted] credentials=[redacted] client_secret=[redacted] keyboard=compact monkey=capuchin');
        expect(toolResult.artifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'artifact-html',
                downloadUrl: '/api/artifacts/artifact-html/download?keynote=opening&view=1',
            }),
            expect.objectContaining({
                id: 'artifact-bundle',
                bundleDownloadUrl: '/api/artifacts/artifact-bundle/bundle?keyboard=compact',
            }),
        ]));
        expect(toolResult.artifactQuality).toEqual(expect.objectContaining({
            version: 'ArtifactStructuralQuality/v1',
            status: 'passed',
            site: {
                enabled: true,
                entries: ['site/index.html'],
                checkedReferences: 3,
            },
        }));
        expect(toolResult.artifactQuality.files[0]).not.toHaveProperty('text');
        expect(toolResult.artifactQuality.files[0]).not.toHaveProperty('contentBase64');
        expect(toolResult.artifactQuality.warnings[0]).not.toHaveProperty('secret');
        expect(JSON.stringify(toolResult)).not.toContain(rawBase64);
        expect(JSON.stringify(toolResult)).not.toContain(secretToken);
    });

    test('bridges remote-agent progress callbacks into replayable async events', async () => {
        const executeTool = jest.fn(async (_toolId, _params, context) => {
            context.onProgress({
                phase: 'executing',
                percent: 60,
                detail: 'Applied the Penguin deployment and started TLS verification.',
                toolEvents: [{
                    toolId: 'remote-cli-agent',
                    stage: 'verifying',
                    transport: 'provider-agent',
                    providerId: 'codex-cli',
                    providerLabel: 'Codex CLI',
                }],
            });
            return {
                success: true,
                toolId: 'remote-cli-agent',
                data: {
                    completionStatus: 'completed',
                    finalOutput: 'Penguin deployment verified.',
                },
            };
        });
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
        });
        const created = await service.createRun({
            task: 'Deploy the Penguin site.',
            adapter: 'remote-cli-agent',
            targetKey: 'primary/main-server',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        const events = await service.listEvents(created.run.id, 0);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'tool_message',
                source: 'remote-cli-agent',
                payload: expect.objectContaining({
                    message: 'Applied the Penguin deployment and started TLS verification.',
                    phase: 'executing',
                    percent: 60,
                    stage: 'verifying',
                    transport: 'provider-agent',
                    providerId: 'codex-cli',
                    providerLabel: 'Codex CLI',
                }),
            }),
        ]));
        expect(events.findIndex((event) => event.source === 'remote-cli-agent'))
            .toBeLessThan(events.findIndex((event) => event.type === 'tool_completed'));
    });

    test('scrubs userinfo and encoded sensitive URL parameters from persisted free-form text', async () => {
        const executeTool = jest.fn(async () => ({
            success: true,
            toolId: 'remote-cli-agent',
            data: {
                message: 'Deploy proof: https://deploy-user:SYNTHETIC@demo.example.test/?%2574oken=SYNTHETIC&client%255Fsecret=SYNTHETIC&X%252DAmz%252DSignature=SYNTHETIC&view=1#view=1&%2574oken=SYNTHETIC JSON={"token":"SYNTHETIC"} {\'client_secret\':\'SYNTHETIC\'}',
                completionStatus: 'completed',
            },
        }));
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
        });
        const created = await service.createRun({
            task: 'Record the remote deployment proof.',
            adapter: 'remote-cli-agent',
            targetKey: 'k3s-prod',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        expect(run.status).toBe('completed');
        expect(run.metadata.toolResult.data.message).toBe(
            'Deploy proof: https://demo.example.test/?view=1 JSON={"token":[redacted]} {\'client_secret\':[redacted]}',
        );
        expect(JSON.stringify(run.metadata.toolResult)).not.toContain('deploy-user');
        expect(JSON.stringify(run.metadata.toolResult)).not.toContain('SYNTHETIC');
        expect(JSON.stringify(run.metadata.toolResult)).not.toContain('%74oken');
        expect(JSON.stringify(run.metadata.toolResult)).not.toContain('client%5Fsecret');
        expect(JSON.stringify(run.metadata.toolResult)).not.toContain('X%2DAmz%2DSignature');
    });

    test('persists async remote-agent continuity and supplies it to the next run in the same chat session', async () => {
        const sessionStore = createSessionStore([
            { id: 'chat-session-1', ownerId: 'tester' },
            { id: 'chat-session-2', ownerId: 'tester' },
        ]);
        const runner = {
            run: jest.fn()
                .mockResolvedValueOnce({
                    completionStatus: 'running',
                    sessionId: 'remote-session-1',
                    mcpSessionId: 'mcp-session-1',
                    remoteCodeSessionId: 'remote-code-session-1',
                    remoteCodeJobId: 'remote-job-1',
                    targetId: 'k3s-prod',
                    cwd: '/opt/kimibuilt',
                })
                .mockResolvedValueOnce({ completionStatus: 'completed' })
                .mockResolvedValueOnce({ completionStatus: 'completed' }),
        };
        const remoteTool = new RemoteCliAgentTool({ runner });
        const executeTool = jest.fn((adapter, params, context) => {
            expect(adapter).toBe('remote-cli-agent');
            return remoteTool.execute(params, context);
        });
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
            sessionStore,
        });

        const first = await service.createRun({
            task: 'Start the remote build.',
            adapter: 'remote-cli-agent',
            targetKey: 'k3s-prod',
            sessionId: 'chat-session-1',
            liveRemote: true,
        }, 'tester');
        await service.drainQueue();

        const firstRun = await service.getRun(first.run.id, 'tester');
        expect(firstRun.metadata.toolResult).toEqual(expect.objectContaining({
            sessionId: 'remote-session-1',
            mcpSessionId: 'mcp-session-1',
            remoteCodeSessionId: 'remote-code-session-1',
            remoteCodeJobId: 'remote-job-1',
            targetId: 'k3s-prod',
            cwd: '/opt/kimibuilt',
        }));
        expect(sessionStore.getSession('chat-session-1').controlState).toEqual(expect.objectContaining({
            lastToolIntent: 'remote-cli-agent',
            remoteCliAgent: expect.objectContaining({
                sessionId: 'remote-session-1',
                mcpSessionId: 'mcp-session-1',
                remoteCodeSessionId: 'remote-code-session-1',
                remoteCodeJobId: 'remote-job-1',
                targetId: 'k3s-prod',
                cwd: '/opt/kimibuilt',
            }),
        }));

        const second = await service.createRun({
            task: 'Continue that running job and finish it.',
            adapter: 'remote-cli-agent',
            targetKey: 'k3s-prod',
            sessionId: 'chat-session-1',
            liveRemote: true,
        }, 'tester');
        await service.drainQueue();

        expect((await service.getRun(second.run.id, 'tester')).status).toBe('completed');
        expect(runner.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
            sessionId: 'remote-session-1',
            mcpSessionId: 'mcp-session-1',
            jobId: 'remote-job-1',
            targetId: 'k3s-prod',
            cwd: '/opt/kimibuilt',
        }));
        expect(executeTool.mock.calls[1][2]).toEqual(expect.objectContaining({
            sessionId: 'chat-session-1',
            session: expect.objectContaining({ id: 'chat-session-1' }),
            controlState: expect.objectContaining({
                remoteCliAgent: expect.objectContaining({ sessionId: 'remote-session-1' }),
            }),
        }));
        expect(sessionStore.getSession('chat-session-1').controlState.remoteCliAgent).toEqual(expect.objectContaining({
            sessionId: 'remote-session-1',
            mcpSessionId: 'mcp-session-1',
            remoteCodeSessionId: 'remote-code-session-1',
            remoteCodeJobId: 'remote-job-1',
        }));

        await service.createRun({
            task: 'Continue that running job and finish it.',
            adapter: 'remote-cli-agent',
            targetKey: 'k3s-prod',
            sessionId: 'chat-session-2',
            liveRemote: true,
        }, 'tester');
        await service.drainQueue();

        expect(runner.run).toHaveBeenNthCalledWith(3, expect.not.objectContaining({
            sessionId: 'remote-session-1',
            mcpSessionId: 'mcp-session-1',
            jobId: 'remote-job-1',
            cwd: '/opt/kimibuilt',
        }));
    });

    test('rejects a remote-agent run whose chat session is not owned by the requester', async () => {
        const sessionStore = createSessionStore([{ id: 'chat-session-1', ownerId: 'owner-a' }]);
        const executeTool = jest.fn();
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
            sessionStore,
        });

        await expect(service.createRun({
            task: 'Use the selected artifact to continue the remote build.',
            adapter: 'remote-cli-agent',
            targetKey: 'k3s-prod',
            sessionId: 'chat-session-1',
            liveRemote: true,
            metadata: {
                toolParams: {
                    task: 'Use the selected artifact to continue the remote build.',
                    artifactIds: ['artifact-private'],
                    collectResultFiles: true,
                },
            },
        }, 'owner-b')).rejects.toMatchObject({
            code: 'ASYNC_REMOTE_AGENT_SESSION_SCOPE_MISMATCH',
            statusCode: 403,
        });
        expect(executeTool).not.toHaveBeenCalled();
        expect(sessionStore.updateControlState).not.toHaveBeenCalled();
    });

    test('fails closed when a fallback session store cannot prove remote-agent ownership', async () => {
        const sessionStore = {
            get: jest.fn(async () => ({
                id: 'chat-session-1',
                metadata: { ownerId: 'owner-a' },
            })),
            updateControlState: jest.fn(),
        };
        const executeTool = jest.fn();
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
            sessionStore,
        });

        await expect(service.createRun({
            task: 'Continue another session.',
            adapter: 'remote-cli-agent',
            targetKey: 'k3s-prod',
            sessionId: 'chat-session-1',
            liveRemote: true,
        }, 'owner-b')).rejects.toMatchObject({
            code: 'ASYNC_REMOTE_AGENT_SESSION_SCOPE_MISMATCH',
            statusCode: 403,
        });
        expect(executeTool).not.toHaveBeenCalled();
        expect(sessionStore.updateControlState).not.toHaveBeenCalled();
    });

    test('does not pass an unverified remote session id when no session store is configured', async () => {
        const executeTool = jest.fn(async (_adapter, _params, context) => {
            expect(context.sessionId).toBeNull();
            expect(context).not.toHaveProperty('session');
            return {
                success: true,
                toolId: 'remote-cli-agent',
                data: { completionStatus: 'completed' },
            };
        });
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
        });
        const created = await service.createRun({
            task: 'Run without attaching artifacts to an unverified session.',
            adapter: 'remote-cli-agent',
            targetKey: 'k3s-prod',
            sessionId: 'unverified-session',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        expect((await service.getRun(created.run.id, 'tester')).status).toBe('completed');
        expect(executeTool).toHaveBeenCalledTimes(1);
    });

    test('keeps a successful remote result when continuity persistence fails', async () => {
        const sessionStore = createSessionStore([{ id: 'chat-session-1', ownerId: 'tester' }]);
        sessionStore.updateControlState.mockRejectedValueOnce(new Error('key=continuity-secret database unavailable'));
        const executeTool = jest.fn(async () => ({
            success: true,
            duration: 12,
            toolId: 'remote-cli-agent',
            data: {
                completionStatus: 'completed',
                sessionId: 'remote-session-1',
                mcpSessionId: 'mcp-session-1',
            },
        }));
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
            sessionStore,
        });
        const created = await service.createRun({
            task: 'Finish the remote build.',
            adapter: 'remote-cli-agent',
            targetKey: 'k3s-prod',
            sessionId: 'chat-session-1',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(created.run.id, 0);
        expect(run.status).toBe('completed');
        expect(run.metadata.toolResult).toEqual(expect.objectContaining({
            success: true,
            completionStatus: 'completed',
            sessionId: 'remote-session-1',
            mcpSessionId: 'mcp-session-1',
        }));
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'continuity_warning',
                payload: expect.objectContaining({
                    error: 'key=[redacted] database unavailable',
                }),
            }),
            expect.objectContaining({ type: 'tool_completed' }),
            expect.objectContaining({ type: 'completed' }),
        ]));
    });

    test('does not persist remote-agent continuity for unrelated async tools', async () => {
        const sessionStore = createSessionStore([{ id: 'chat-session-1', ownerId: 'tester' }]);
        const executeTool = jest.fn(async () => ({
            success: true,
            data: { message: 'remote command observed' },
            toolId: 'remote-command',
        }));
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
            sessionStore,
        });
        const created = await service.createRun({
            task: 'hostname',
            adapter: 'remote-command',
            targetKey: 'k3s-prod',
            sessionId: 'chat-session-1',
            liveRemote: true,
            metadata: { toolParams: { command: 'hostname', targetId: 'k3s-prod' } },
        }, 'tester');

        await service.drainQueue();

        expect((await service.getRun(created.run.id, 'tester')).status).toBe('completed');
        expect(sessionStore.updateControlState).not.toHaveBeenCalled();
        expect(sessionStore.getSession('chat-session-1').controlState).toEqual({});
    });

    test('records a skipped live adapter when no tool manager is attached', async () => {
        const service = createService({ allowLiveRemote: true });
        const created = await service.createRun({
            task: 'hostname',
            adapter: 'remote-command',
            targetKey: 'primary/main-server',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);
        expect(run.status).toBe('completed');
        expect(run.metadata.toolResult).toBeUndefined();
        expect(events.map((event) => event.type)).toContain('tool_skipped');
        expect(events.find((event) => event.type === 'completed').payload.toolExecuted).toBe(false);
    });

    test('executes document workflow runs without live remote permission', async () => {
        const executeTool = jest.fn(async () => ({
            success: true,
            toolId: 'document-workflow',
            duration: 31,
            data: {
                message: 'document generated',
            },
        }));
        const service = createService({
            toolManager: { executeTool },
            toolExecutionContext: {
                documentService: { id: 'document-service' },
            },
        });
        const created = await service.createRun({
            task: 'Create a deployment report.',
            adapter: 'document-workflow',
            targetKey: 'artifact/session-1/html',
            metadata: {
                outputFormat: 'html',
                toolParams: {
                    action: 'generate',
                    prompt: 'Create a deployment report.',
                    format: 'html',
                    buildMode: 'sandbox',
                },
            },
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);
        expect(run.status).toBe('completed');
        expect(run.metadata.toolResult).toEqual(expect.objectContaining({
            adapter: 'document-workflow',
            success: true,
            durationMs: 31,
        }));
        expect(executeTool).toHaveBeenCalledWith(
            'document-workflow',
            expect.objectContaining({
                action: 'generate',
                prompt: 'Create a deployment report.',
                format: 'html',
            }),
            expect.objectContaining({
                route: '/api/async-lab',
                transport: 'async-runtime',
                documentService: expect.objectContaining({ id: 'document-service' }),
            }),
        );
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'tool_started',
            'tool_completed',
            'completed',
        ]));
    });

    test('marks live adapter runs failed when tool execution returns an error', async () => {
        const executeTool = jest.fn(async () => ({
            success: false,
            error: 'remote failed',
            duration: 12,
            toolId: 'remote-command',
        }));
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
        });
        const created = await service.createRun({
            task: 'exit 1',
            adapter: 'remote-command',
            targetKey: 'primary/main-server',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);
        expect(run.status).toBe('failed');
        expect(run.metadata.failure).toBe('remote failed');
        expect(run.metadata.toolResult).toEqual(expect.objectContaining({
            adapter: 'remote-command',
            success: false,
            error: 'remote failed',
        }));
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'tool_started',
            'tool_failed',
            'failed',
        ]));
    });

    test.each(['blocked', 'failed'])(
        'marks remote-agent completionStatus=%s as failed without losing its result',
        async (completionStatus) => {
            const executeTool = jest.fn(async () => ({
                success: true,
                duration: 18,
                toolId: 'remote-cli-agent',
                data: {
                    completionStatus,
                    blocker: `Artifact quality gate reported ${completionStatus}.`,
                    providerId: 'codex',
                    model: 'gpt-5.6-codex',
                    transport: 'codex-agent',
                    artifactIds: ['artifact-partial'],
                    artifacts: [{
                        id: 'artifact-partial',
                        filename: 'partial.html',
                        mimeType: 'text/html',
                    }],
                },
            }));
            const service = createService({
                allowLiveRemote: true,
                toolManager: { executeTool },
            });
            const created = await service.createRun({
                task: 'Finish the artifact build.',
                adapter: 'remote-cli-agent',
                targetKey: 'primary/main-server',
                liveRemote: true,
            }, 'tester');

            await service.drainQueue();

            const run = await service.getRun(created.run.id, 'tester');
            const events = await service.listEvents(run.id, 0);
            const toolFailedEvent = events.find((event) => event.type === 'tool_failed');
            const failedEvent = events.find((event) => event.type === 'failed');
            expect(run.status).toBe('failed');
            expect(run.metadata.failure).toBe(`Artifact quality gate reported ${completionStatus}.`);
            expect(run.metadata.toolResult).toEqual(expect.objectContaining({
                success: false,
                completionStatus,
                blocker: `Artifact quality gate reported ${completionStatus}.`,
                provider: 'codex',
                artifactIds: ['artifact-partial'],
                artifacts: [expect.objectContaining({ id: 'artifact-partial' })],
            }));
            expect(toolFailedEvent).toEqual(expect.objectContaining({
                status: 'failed',
                payload: expect.objectContaining({
                    result: expect.objectContaining({
                        completionStatus,
                        artifactIds: ['artifact-partial'],
                    }),
                }),
            }));
            expect(failedEvent.payload).toEqual(expect.objectContaining({
                completionStatus,
                toolExecuted: true,
            }));
            expect(events.map((event) => event.type)).not.toContain('completed');
        },
    );

    test('returns the existing run for duplicate idempotency keys', async () => {
        const service = createService();
        const first = await service.createRun({
            task: 'repeatable command',
            adapter: 'dry-run',
            idempotencyKey: 'same-command',
        }, 'tester');
        const second = await service.createRun({
            task: 'repeatable command',
            adapter: 'dry-run',
            idempotencyKey: 'same-command',
        }, 'tester');

        expect(second.duplicate).toBe(true);
        expect(second.run.id).toBe(first.run.id);
    });

    test('queues managed-app follow-up work from successful build webhooks', async () => {
        const service = createService({ allowLiveRemote: true });

        const result = await service.handleBuildWebhook({
            project: { path_with_namespace: 'agent-apps/demo-site' },
            object_attributes: {
                id: 42,
                status: 'success',
                sha: 'abc123',
            },
            imageTag: 'sha-abc123',
        }, {
            ownerId: 'tester',
            followUp: 'managed-app-verify',
            externalRunId: 'pipeline-42',
        });

        expect(result.run.adapter).toBe('build-webhook-copy');
        expect(result.followUp.run).toEqual(expect.objectContaining({
            adapter: 'managed-app',
            targetKey: 'managed-app:demo-site',
            liveRemoteRequested: true,
            liveRemoteAllowed: true,
        }));
        expect(result.followUp.run.metadata.toolParams).toEqual(expect.objectContaining({
            action: 'verify',
            appRef: 'demo-site',
            imageTag: 'sha-abc123',
            runId: 'pipeline-42',
        }));
    });

    test('replays events after a cursor', async () => {
        const service = createService();
        const created = await service.createRun({
            task: 'cursor replay',
            adapter: 'dry-run',
        }, 'tester');
        await service.drainQueue();

        const allEvents = await service.listEvents(created.run.id, 0);
        const afterQueued = await service.listEvents(created.run.id, allEvents[0].cursor);

        expect(allEvents.length).toBeGreaterThan(3);
        expect(afterQueued[0].cursor).toBeGreaterThan(allEvents[0].cursor);
        expect(afterQueued.some((event) => event.type === 'queued')).toBe(false);
    });

    test('cancels queued runs without executing them', async () => {
        const service = createService();
        const created = await service.createRun({
            task: 'cancel me',
            adapter: 'dry-run',
        }, 'tester');

        const cancelled = await service.cancelRun(created.run.id, 'tester');
        await service.drainQueue();
        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);

        expect(cancelled.changed).toBe(true);
        expect(run.status).toBe('cancelled');
        expect(events.map((event) => event.type)).toContain('cancelled');
        expect(events.map((event) => event.type)).not.toContain('started');
    });

    test('fails instead of stomping a locked target', async () => {
        const service = createService();
        const created = await service.createRun({
            task: 'needs target lock',
            adapter: 'managed-app',
            targetKey: 'app/demo',
        }, 'tester');

        await service.bus.acquireLock('target:app/demo', 'other-worker', 1000);
        await service.drainQueue();
        await service.bus.releaseLock('target:app/demo', 'other-worker');

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);

        expect(run.status).toBe('failed');
        expect(events.map((event) => event.type)).toContain('lock_wait');
        expect(events.map((event) => event.type)).toContain('failed');
    });

    test('recovers a stale running lease without replaying completed steps', async () => {
        const store = new AsyncLabStore({ persistToPostgres: false });
        const bus = new ValkeyLiveBus({});
        const firstWorker = createService({ store, bus, instanceId: 'worker-one' });
        const secondWorker = createService({ store, bus, instanceId: 'worker-two' });
        const created = await firstWorker.createRun({
            task: 'recover stale run',
            adapter: 'dry-run',
            targetKey: 'lab/recover',
        }, 'tester');

        await store.claimRun(created.run.id, 'dead-worker', 1000);
        await store.updateRun(created.run.id, {
            status: 'running',
            claimOwner: 'dead-worker',
            claimExpiresAt: new Date(Date.now() - 1000).toISOString(),
            attempt: 1,
            metadata: {
                completedStepKeys: ['normalize'],
            },
        });
        await store.appendEvent(created.run.id, {
            type: 'progress',
            source: 'dead-worker',
            status: 'running',
            payload: {
                message: 'Command normalized into a replayable message envelope.',
            },
        });

        await secondWorker.processRun(created.run.id);
        const run = await secondWorker.getRun(created.run.id, 'tester');
        const events = await secondWorker.listEvents(run.id, 0);

        expect(run.status).toBe('completed');
        expect(run.metadata.recoveredBy).toBe('worker-two');
        expect(events.map((event) => event.type)).toContain('lease_recovered');
        expect(events.filter((event) => event.type === 'progress')).toHaveLength(1);
        expect(run.metadata.completedStepKeys).toEqual(expect.arrayContaining([
            'normalize',
            'tool-message',
            'checkpoint',
        ]));
    });

    test('drainQueue scans expired running leases when Valkey has no queued item', async () => {
        const store = new AsyncLabStore({ persistToPostgres: false });
        const bus = new ValkeyLiveBus({});
        const worker = createService({ store, bus, instanceId: 'recovery-worker' });
        await store.createRun({
            id: 'stale-running-run',
            runtimeSurface: 'async-lab',
            mode: 'lab',
            adapter: 'dry-run',
            status: 'running',
            targetKey: 'lab/stale-running',
            task: 'recover from expired lease without queue entry',
            claimOwner: 'dead-worker',
            claimExpiresAt: new Date(Date.now() - 1000).toISOString(),
            attempt: 1,
            metadata: {},
        });

        const processed = await worker.drainQueue();
        const run = await worker.getRun('stale-running-run', '');
        const events = await worker.listEvents(run.id, 0);

        expect(processed).toBeGreaterThan(0);
        expect(run.status).toBe('completed');
        expect(run.metadata.recoveredBy).toBe('recovery-worker');
        expect(events.map((event) => event.type)).toContain('lease_recovered');
    });
});

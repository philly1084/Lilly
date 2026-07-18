const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChatAppContext() {
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        .replace(/\/\/ Initialize app when DOM is ready[\s\S]*$/, 'globalThis.ChatApp = ChatApp;');

    const context = {
        window: {
            location: { origin: 'https://chat.example.test' },
            KimiBuiltWebChatWorkspace: null,
            KimiBuiltWebChatWorkspaceEmbed: null,
            setTimeout,
            clearTimeout,
        },
        document: {
            getElementById: () => null,
            addEventListener: () => {},
        },
        setTimeout,
        clearTimeout,
        URL,
        console,
    };

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'app.js' });
    return context;
}

function buildRemoteCatalog() {
    const remoteAgent = {
        id: 'remote-cli-agent',
        runtime: {
            configured: true,
            defaultCwd: '/srv/apps/example',
        },
    };

    return {
        tools: [
            remoteAgent,
            {
                id: 'remote-command',
                runtime: {
                    configured: true,
                    commandCatalog: [{
                        id: 'build',
                        label: 'Build',
                        profile: 'build',
                        command: 'npm run build',
                    }],
                },
            },
        ],
        remoteAgent,
        remoteTool: {
            id: 'remote-command',
            runtime: {
                configured: true,
                commandCatalog: [{
                    id: 'build',
                    label: 'Build',
                    profile: 'build',
                    command: 'npm run build',
                }],
            },
        },
        runtime: {
            remoteRunner: {
                defaultWorkspace: '/srv/fallback',
            },
        },
        catalog: [{
            id: 'build',
            label: 'Build',
            profile: 'build',
            command: 'npm run build',
        }],
    };
}

function buildAppHarness() {
    const context = loadChatAppContext();
    const renderedMessages = [];
    const eventSources = [];

    context.EventSource = class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.listeners = {};
            this.closed = false;
            eventSources.push(this);
        }

        addEventListener(type, handler) {
            this.listeners[type] = handler;
        }

        close() {
            this.closed = true;
        }
    };

    context.sessionManager = {
        currentSessionId: 'session-1',
        addMessage: jest.fn((_sessionId, message) => {
            if (!message.id) {
                message.id = `message-${renderedMessages.length + 1}`;
            }
            return message;
        }),
        getMessages: jest.fn(() => []),
        saveToStorage: jest.fn(),
        isLocalSession: jest.fn(() => true),
        syncMessageToBackend: jest.fn(),
    };
    context.uiHelpers = {
        hideWelcomeMessage: jest.fn(),
        renderMessage: jest.fn((message) => {
            renderedMessages.push(message);
            return { message };
        }),
        scrollToBottom: jest.fn(),
        reinitializeIcons: jest.fn(),
        getCurrentModel: jest.fn(() => 'gpt-5.4-mini'),
        generateMessageId: jest.fn(() => 'async-card-1'),
        updateMessageContent: jest.fn(),
        updateCharCounter: jest.fn(),
        playAcknowledgementCue: jest.fn(),
        showToast: jest.fn(),
    };
    context.window.artifactManager = {
        prepareArtifactUpdate: jest.fn(),
        getSelectedIds: jest.fn(() => []),
    };
    context.window.fileManager = {
        getSelectedArtifactIds: jest.fn(() => []),
    };
    context.apiClient = {
        getRemoteToolCatalog: jest.fn(async () => buildRemoteCatalog()),
        createAsyncRun: jest.fn(async () => ({
            run: {
                id: 'async-run-1',
                adapter: 'remote-cli-agent',
                status: 'queued',
                targetKey: 'primary/main-server',
            },
            events: [{
                eventId: 'event-1',
                cursor: 1,
                type: 'queued',
                status: 'queued',
                payload: {
                    message: 'Run accepted by the adjacent async lab queue.',
                },
            }],
        })),
        getAsyncRun: jest.fn(async () => ({ run: null, events: [] })),
        invokeRemoteCliAgent: jest.fn(async () => ({
            sessionId: 'session-1',
            result: {
                data: {
                    finalOutput: 'WHAT_CHANGED=remote agent used',
                    cwd: '/srv/apps/example',
                    sessionId: 'remote-session-1',
                },
            },
        })),
        invokeRemoteCommand: jest.fn(async () => ({
            sessionId: 'session-1',
            result: {
                data: {
                    exitCode: 0,
                    stdout: 'built',
                },
            },
        })),
    };

    const app = Object.create(context.ChatApp.prototype);
    app.messageInput = {
        value: '',
        focus: jest.fn(),
    };
    app.autoResize = { reset: jest.fn() };
    app.charCounter = {};
    app.selectedToolIntentIds = new Set();
    app.selectedDirectTool = null;
    app.messagesContainer = { appendChild: jest.fn() };
    app.createNewSession = jest.fn();
    app.syncBackendSession = jest.fn();
    app.updateSessionInfo = jest.fn();
    app.updateSendButton = jest.fn();
    app.setInput = jest.fn((value) => {
        app.messageInput.value = value;
    });
    app.closeToolMenu = jest.fn();
    app.renderSelectedDirectToolChip = jest.fn();
    app.tryHandleToolCommand = jest.fn(async () => false);
    app.isCurrentSessionProcessing = jest.fn(() => false);
    app.getQueuedMessageCount = jest.fn(() => 0);
    app.enqueueMessage = jest.fn();
    app.sendPreparedMessage = jest.fn(async () => true);
    app.persistSessionMessageIfNeeded = jest.fn();
    app.isVisibleSession = jest.fn(() => false);
    app.getSessionMessage = jest.fn((_sessionId, messageId) => {
        const messages = renderedMessages.filter((entry) => entry.id === messageId);
        return messages[messages.length - 1] || null;
    });
    app.upsertSessionMessage = jest.fn((_sessionId, message) => {
        renderedMessages.push(message);
        return message;
    });

    return { app, context, renderedMessages, eventSources };
}

describe('direct tool result formatting', () => {
    test('falls back to a sibling message when tool data is empty', () => {
        const context = loadChatAppContext();
        const app = Object.create(context.ChatApp.prototype);

        expect(app.formatToolInvocationResult('example-tool', {
            success: true,
            data: {},
            message: 'The requested report is ready.',
        })).toBe('The requested report is ready.');
    });
});

function loadApiClientClass() {
    const source = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8')
        .replace(/\/\/ Create global API client instance[\s\S]*$/, 'globalThis.OpenAIAPIClient = OpenAIAPIClient;');

    const context = {
        window: {
            location: {
                hostname: 'chat.example.test',
                protocol: 'https:',
                host: 'chat.example.test',
            },
            KimiBuiltGatewaySSE: {},
            KimiBuiltWebChatWorkspace: null,
            sessionManager: {
                storageAvailable: false,
            },
        },
        Intl,
        URL,
        URLSearchParams,
        EventTarget,
        console,
    };

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'api.js' });
    return context.OpenAIAPIClient;
}

describe('web-chat remote CLI agent routing', () => {
    test('routes natural-language /remote build requests through remote-cli-agent', async () => {
        const { app, context, renderedMessages } = buildAppHarness();

        await app.handleRemoteCommand('build a small site and deploy it');

        expect(context.apiClient.invokeRemoteCliAgent).toHaveBeenCalledWith(
            'build a small site and deploy it',
            expect.objectContaining({
                adminMode: true,
                cwd: '/srv/apps/example',
                model: 'gpt-5.4-mini',
            }),
        );
        expect(context.apiClient.invokeRemoteCommand).not.toHaveBeenCalled();
        expect(renderedMessages.at(-1).content).toContain('Remote CLI Agent Result');
    });

    test('formats remote agent quality status and missing gates', () => {
        const { app } = buildAppHarness();

        const content = app.formatRemoteAgentResult({
            finalOutput: 'WHAT_CHANGED=deployed the dashboard',
            completionStatus: 'blocked',
            agentQuality: {
                status: 'blocked',
                score: 0.42,
                requiredMissing: ['public_or_preview_url', 'browser_proof'],
            },
            verifyCommands: ['npm test'],
            verifyResults: ['tests passed'],
            blocker: 'Missing browser proof.',
        });

        expect(content).toContain('Quality: `blocked` (42%)');
        expect(content).toContain('Missing quality gates: `public_or_preview_url`, `browser_proof`');
        expect(content).toContain('Blocker: Missing browser proof.');
    });

    test('keeps exact catalog commands on the command lane', async () => {
        const { app, context } = buildAppHarness();

        await app.handleRemoteCommand('build');

        expect(context.apiClient.invokeRemoteCommand).toHaveBeenCalledWith(
            'npm run build',
            expect.objectContaining({
                profile: 'build',
                workflowAction: 'web-chat-remote-build',
            }),
        );
        expect(context.apiClient.invokeRemoteCliAgent).not.toHaveBeenCalled();
    });

    test('queues /remote async agent work into an async job card', async () => {
        const { app, context, renderedMessages, eventSources } = buildAppHarness();

        await app.handleRemoteCommand('async agent deploy the demo site');

        expect(context.apiClient.createAsyncRun).toHaveBeenCalledWith(expect.objectContaining({
            adapter: 'remote-cli-agent',
            task: 'deploy the demo site',
            liveRemote: true,
            sessionId: 'session-1',
            metadata: expect.objectContaining({
                source: 'web-chat',
                toolParams: expect.objectContaining({
                    task: 'deploy the demo site',
                    adminMode: true,
                }),
            }),
        }));
        expect(context.apiClient.invokeRemoteCliAgent).not.toHaveBeenCalled();
        expect(renderedMessages.some((message) => message.metadata?.asyncRuntimeJobCard === true)).toBe(true);
        expect(renderedMessages.at(-1).progressState.steps.map((step) => step.id)).toEqual([
            'queued',
            'lease',
            'safety',
            'tool',
            'checkpoint',
            'complete',
        ]);
        expect(eventSources[0].url).toContain('/api/async-lab/runs/async-run-1/events');
    });

    test('routes selected remote-cli-agent chip sends into async job cards', async () => {
        const { app, context, renderedMessages } = buildAppHarness();
        app.selectedDirectTool = {
            id: 'remote-cli-agent',
            name: 'Remote CLI Agent',
            icon: 'terminal',
        };
        app.messageInput.value = 'deploy the demo site';

        await app.sendMessage();

        expect(context.apiClient.createAsyncRun).toHaveBeenCalledWith(expect.objectContaining({
            adapter: 'remote-cli-agent',
            task: 'deploy the demo site',
            liveRemote: true,
            sessionId: 'session-1',
        }));
        expect(app.sendPreparedMessage).not.toHaveBeenCalled();
        expect(app.selectedDirectTool).toBeNull();
        expect(renderedMessages[0]).toEqual(expect.objectContaining({
            role: 'user',
            content: 'deploy the demo site',
            metadata: expect.objectContaining({
                selectedToolChip: expect.objectContaining({ id: 'remote-cli-agent' }),
            }),
        }));
        expect(renderedMessages.some((message) => message.metadata?.asyncRuntimeJobCard === true)).toBe(true);
    });

    test('stages artifact lineage as a truthful remote agent build handoff', async () => {
        const { app, context, renderedMessages } = buildAppHarness();
        const preventDefault = jest.fn();
        const control = {
            dataset: {
                artifactLineageAction: 'build-agent',
                artifactId: 'artifact-1',
                parentArtifactId: 'artifact-parent',
                missionId: 'mission-1',
                artifactRevision: '3',
            },
        };

        expect(app.handleArtifactLineageAction({ preventDefault }, control)).toBe(true);
        expect(preventDefault).toHaveBeenCalled();
        expect(context.window.artifactManager.prepareArtifactUpdate).toHaveBeenCalledWith('artifact-1');
        expect(app.selectedDirectTool).toEqual(expect.objectContaining({ id: 'remote-cli-agent' }));
        expect(app.messageInput.value).toContain('Build on this artifact with the remote CLI agent');
        expect(app.messageInput.value).toContain('do not deploy or publish unless I explicitly ask');

        await app.sendMessage();

        expect(context.apiClient.createAsyncRun).toHaveBeenCalledWith(expect.objectContaining({
            adapter: 'remote-cli-agent',
            task: expect.stringContaining('Build on this artifact'),
            liveRemote: true,
            sessionId: 'session-1',
            metadata: expect.objectContaining({
                source: 'web-chat',
                missionId: 'mission-1',
                parentArtifactId: 'artifact-parent',
                revision: '3',
                requestedArtifactAction: 'build-agent',
                artifactIds: ['artifact-1'],
                artifactLineage: expect.objectContaining({
                    artifactId: 'artifact-1',
                    parentArtifactId: 'artifact-parent',
                    missionId: 'mission-1',
                    revision: '3',
                    action: 'build-agent',
                }),
                toolParams: expect.objectContaining({
                    task: expect.stringContaining('Build on this artifact'),
                    artifactIds: ['artifact-1'],
                    collectResultFiles: true,
                    artifactLineage: expect.objectContaining({
                        artifactId: 'artifact-1',
                        parentArtifactId: 'artifact-parent',
                    }),
                    continuitySummary: expect.stringContaining('Artifact ID: artifact-1.'),
                }),
            }),
        }));
        expect(renderedMessages[0]).toEqual(expect.objectContaining({
            role: 'user',
            metadata: expect.objectContaining({
                artifactIds: ['artifact-1'],
                artifactLineage: expect.objectContaining({ artifactId: 'artifact-1' }),
                selectedToolChip: expect.objectContaining({ id: 'remote-cli-agent' }),
            }),
        }));
        expect(app.selectedDirectTool).toBeNull();
    });

    test('marks queue failures terminal and restores the agent build draft, tool, and lineage', async () => {
        const { app, context, renderedMessages } = buildAppHarness();
        const control = {
            dataset: {
                artifactLineageAction: 'build-agent',
                artifactId: 'artifact-retry',
                parentArtifactId: 'artifact-parent',
                missionId: 'mission-retry',
                artifactRevision: '4',
            },
        };
        app.handleArtifactLineageAction({ preventDefault: jest.fn() }, control);
        const retryDraft = app.messageInput.value;
        context.apiClient.createAsyncRun.mockRejectedValueOnce(new Error('queue unavailable'));

        await expect(app.sendMessage()).resolves.toBeUndefined();

        const failedCard = renderedMessages
            .filter((message) => message.metadata?.asyncRuntimeJobCard === true)
            .at(-1);
        expect(failedCard).toEqual(expect.objectContaining({
            isStreaming: false,
            progressState: expect.objectContaining({
                phase: 'failed',
                terminal: true,
                detail: 'Unable to queue the remote agent run: queue unavailable',
            }),
        }));
        expect(failedCard.metadata.asyncRuntimeToolResult).toEqual(expect.objectContaining({
            completionStatus: 'failed',
            blocker: 'Unable to queue the remote agent run: queue unavailable',
        }));
        expect(app.messageInput.value).toBe(retryDraft);
        expect(app.selectedDirectTool).toEqual(expect.objectContaining({ id: 'remote-cli-agent' }));
        expect(app.pendingArtifactLineage).toEqual(expect.objectContaining({
            artifactId: 'artifact-retry',
            parentArtifactId: 'artifact-parent',
            action: 'build-agent',
        }));
        expect(context.uiHelpers.showToast).toHaveBeenCalledWith(
            expect.stringContaining('ready to retry'),
            'error',
        );
    });

    test('renders backend-created async runtime runs without queueing a duplicate run', () => {
        const { app, context, renderedMessages, eventSources } = buildAppHarness();

        const message = app.createAsyncRemoteJobCardFromRun({
            run: {
                id: 'managed-run-1',
                adapter: 'managed-app',
                status: 'queued',
                targetKey: 'managed-app:demo.demoserver2.buzz',
            },
            events: [{
                eventId: 'managed-event-1',
                cursor: 7,
                type: 'queued',
                status: 'queued',
            }],
        }, 'session-1');

        expect(context.apiClient.createAsyncRun).not.toHaveBeenCalled();
        expect(message.metadata.asyncRuntimeJobCard).toBe(true);
        expect(message.metadata.asyncRuntimeRun.id).toBe('managed-run-1');
        expect(renderedMessages.at(-1).metadata.asyncRuntimeRun.adapter).toBe('managed-app');
        expect(eventSources[0].url).toContain('/api/async-lab/runs/managed-run-1/events?after=7');
    });

    test('hydrates a reloaded async run with the aggregate site bundle and safe result metadata', () => {
        const { app, renderedMessages } = buildAppHarness();
        const rawBase64 = 'cmF3LXNpdGUtY29udGVudA==';

        const message = app.createAsyncRemoteJobCardFromRun({
            run: {
                id: 'remote-run-complete',
                adapter: 'remote-cli-agent',
                status: 'completed',
                targetKey: 'primary/main-server',
                metadata: {
                    toolResult: {
                        success: true,
                        completionStatus: 'completed',
                        provider: 'kimi',
                        model: 'kimi-k3',
                        transport: 'provider-agent',
                        siteBundleArtifactId: 'artifact-site-bundle',
                        resultFiles: [{
                            artifactId: 'artifact-index',
                            filename: 'index.html',
                            role: 'site-entry',
                            contentBase64: rawBase64,
                        }, {
                            artifactId: 'artifact-css',
                            filename: 'styles.css',
                            role: 'site-file',
                            content: 'raw css',
                        }, {
                            artifactId: 'artifact-report',
                            filename: 'qa-report.json',
                            role: 'deliverable',
                        }],
                        artifacts: [{
                            id: 'artifact-index',
                            filename: 'index.html',
                            downloadUrl: '/api/artifacts/artifact-index/download',
                            contentBase64: rawBase64,
                        }, {
                            id: 'artifact-css',
                            filename: 'styles.css',
                            downloadUrl: '/api/artifacts/artifact-css/download',
                            metadata: { content: 'raw css' },
                        }, {
                            id: 'artifact-site-bundle',
                            filename: 'website.zip',
                            downloadUrl: '/api/artifacts/artifact-site-bundle/download',
                            previewUrl: '/api/artifacts/artifact-site-bundle/preview?X-Goog-Signature=do-not-store&view=1',
                            bundleDownloadUrl: '/api/artifacts/artifact-site-bundle/bundle?X-Amz-Credential=do-not-store&X-Amz-Signature=do-not-store&keyboard=compact',
                        }, {
                            id: 'artifact-report',
                            filename: 'qa-report.json',
                            downloadUrl: '/api/artifacts/artifact-report/download',
                        }],
                    },
                },
            },
            events: [{
                eventId: 'remote-completed-1',
                cursor: 12,
                type: 'completed',
                status: 'completed',
                payload: { message: 'Async lab run completed.' },
            }],
        }, 'session-1');

        expect(message.metadata.asyncRuntimeToolResult).toEqual(expect.objectContaining({
            completionStatus: 'completed',
            provider: 'kimi',
            siteBundleArtifactId: 'artifact-site-bundle',
        }));
        expect(message.metadata.asyncRuntimeToolResult.resultFiles[0]).not.toHaveProperty('contentBase64');
        expect(message.metadata.asyncRuntimeToolResult.artifacts[0]).not.toHaveProperty('contentBase64');
        expect(message.metadata.asyncRuntimeToolResult.artifacts[1]).not.toHaveProperty('metadata');
        expect(message.artifacts.map((artifact) => artifact.id)).toEqual([
            'artifact-site-bundle',
            'artifact-report',
        ]);
        expect(message.artifacts[0]).toEqual(expect.objectContaining({
            previewUrl: '/api/artifacts/artifact-site-bundle/preview?view=1',
            bundleDownloadUrl: '/api/artifacts/artifact-site-bundle/bundle?keyboard=compact',
        }));
        expect(message.artifacts.every((artifact) => artifact.id && artifact.downloadUrl)).toBe(true);
        expect(renderedMessages.at(-1).artifacts).toEqual(message.artifacts);
    });

    test('hydrates failed SSE tool results, prefers the blocker, and surfaces non-bundled artifacts', () => {
        const { app, renderedMessages, eventSources } = buildAppHarness();
        const message = app.createAsyncRemoteJobCardFromRun({
            run: {
                id: 'remote-run-failing',
                adapter: 'remote-cli-agent',
                status: 'running',
                targetKey: 'primary/main-server',
            },
            events: [{
                eventId: 'remote-started-1',
                cursor: 1,
                type: 'started',
                status: 'running',
            }],
        }, 'session-1');
        const source = eventSources.at(-1);

        source.listeners.tool_failed({
            data: JSON.stringify({
                eventId: 'remote-tool-failed-1',
                cursor: 2,
                type: 'tool_failed',
                status: 'failed',
                payload: {
                    message: 'remote-cli-agent reported a blocked or failed result.',
                    result: {
                        success: false,
                        completionStatus: 'blocked',
                        blocker: 'Returned SVG failed structural validation.',
                        error: 'Generic remote failure.',
                        publicUrl: 'https://demo.example.test/?X-Amz-Security-Token=do-not-store&X-Goog-Signature=do-not-store&keyboard=compact&monkey=capuchin',
                        artifactIds: ['artifact-svg'],
                        artifacts: [{
                            id: 'artifact-svg',
                            filename: 'diagram.svg',
                            mimeType: 'image/svg+xml',
                            downloadUrl: '/api/artifacts/artifact-svg/download?X-Amz-Credential=do-not-store&X-Amz-Signature=do-not-store&X-Goog-Signature=do-not-store&sig=do-not-store&keynote=opening&keyboard=compact&view=1',
                            contentBase64: 'PHN2Zz5yYXc8L3N2Zz4=',
                        }],
                    },
                },
            }),
        });

        const updated = renderedMessages.filter((entry) => entry.id === message.id).at(-1);
        expect(updated.progressState).toEqual(expect.objectContaining({
            phase: 'failed',
            terminal: true,
            detail: 'Returned SVG failed structural validation.',
        }));
        expect(updated.metadata.asyncRuntimeToolResult).toEqual(expect.objectContaining({
            success: false,
            completionStatus: 'blocked',
            blocker: 'Returned SVG failed structural validation.',
            publicUrl: 'https://demo.example.test/?keyboard=compact&monkey=capuchin',
        }));
        expect(updated.artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-svg',
                filename: 'diagram.svg',
                downloadUrl: '/api/artifacts/artifact-svg/download?keynote=opening&keyboard=compact&view=1',
            }),
        ]);
        expect(updated.artifacts[0]).not.toHaveProperty('contentBase64');
        expect(source.closed).toBe(true);
    });

    test('does not use remote-workbench as the remote catalog fallback', async () => {
        const OpenAIAPIClient = loadApiClientClass();
        const client = new OpenAIAPIClient();
        client.getAvailableTools = jest.fn(async () => ({
            tools: [{
                id: 'remote-workbench',
                runtime: {
                    configured: true,
                    commandCatalog: [{ id: 'build', command: 'remote-workbench generated command' }],
                },
            }, {
                id: 'remote-cli-agent',
                runtime: {
                    configured: true,
                    defaultCwd: '/srv/apps/example',
                },
            }],
            meta: { runtime: { source: 'backend' } },
        }));

        const catalog = await client.getRemoteToolCatalog();

        expect(catalog.remoteAgent?.id).toBe('remote-cli-agent');
        expect(catalog.remoteTool).toBeNull();
        expect(catalog.remoteWorkbench?.id).toBe('remote-workbench');
        expect(catalog.catalog).toEqual([]);
    });
});

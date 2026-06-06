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

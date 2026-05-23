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

    context.sessionManager = {
        currentSessionId: 'session-1',
        addMessage: jest.fn((_sessionId, message) => message),
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
    };
    context.apiClient = {
        getRemoteToolCatalog: jest.fn(async () => buildRemoteCatalog()),
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
    app.messagesContainer = { appendChild: jest.fn() };
    app.createNewSession = jest.fn();
    app.syncBackendSession = jest.fn();
    app.updateSessionInfo = jest.fn();

    return { app, context, renderedMessages };
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

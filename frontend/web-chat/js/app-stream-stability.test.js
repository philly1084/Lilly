const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChatAppPrototype() {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
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
        uiHelpers: {
            parseJsonSafely: (value) => {
                try {
                    return JSON.parse(value);
                } catch (_error) {
                    return null;
                }
            },
            normalizeSurveyDefinition: (value, fallbackId = '') => {
                if (!value || typeof value !== 'object') {
                    return null;
                }

                const question = String(value.question || '').trim();
                const options = Array.isArray(value.options) ? value.options : [];
                if (!question || options.length < 2) {
                    return null;
                }

                return {
                    id: String(value.id || fallbackId || 'checkpoint-test').trim(),
                    question,
                    options,
                    steps: [{
                        id: 'step-1',
                        question,
                        inputType: value.inputType || 'choice',
                        options,
                    }],
                    inputType: value.inputType || 'choice',
                    allowMultiple: value.allowMultiple === true,
                    maxSelections: Number(value.maxSelections || 1) > 0 ? Number(value.maxSelections || 1) : 1,
                    allowFreeText: value.allowFreeText === true,
                    ...(value.preamble ? { preamble: value.preamble } : {}),
                };
            },
        },
    };

    vm.createContext(context);
    vm.runInContext(source, context);
    return context.ChatApp.prototype;
}

describe('web-chat stream stability', () => {
    test('keeps accepted interrupted streams in resync mode instead of retry fallback', () => {
        const app = Object.create(loadChatAppPrototype());
        app.getTrackedStreamRequest = () => ({ acceptedByServer: true });
        app.isAppBackgrounded = () => false;
        app.pageWasHidden = false;
        app.connectionStatus = 'connected';

        expect(app.shouldResyncAfterDisconnect({ code: 'stream_incomplete' }, {
            hidden: false,
            online: true,
        })).toBe(true);
    });

    test('buffers streaming message renders to reduce frontend flashing', () => {
        const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

        expect(source).toContain('const STREAM_RENDER_BUFFER_MS = 90;');
        expect(source).toContain('scheduleBufferedStreamingRender(sessionId, savedMessage, options);');
        expect(source).toContain('reconcileVisibleMessages(previousMessages, messages);');
    });

    test('reconstructs streamed user-checkpoint tool-call arguments into a survey', () => {
        const app = Object.create(loadChatAppPrototype());
        app.pendingCheckpointToolCallBuffers = new Map();

        const firstChunk = app.extractCheckpointFromToolEventChunk({
            item: {
                index: 0,
                function: {
                    name: 'user-checkpoint',
                    arguments: '{"id":"checkpoint-style","question":"Pick one","options":[',
                },
            },
        });
        expect(firstChunk).toBeNull();

        const secondChunk = app.extractCheckpointFromToolEventChunk({
            item: {
                index: 0,
                function: {
                    arguments: '{"id":"a","label":"A"},{"id":"b","label":"B"}]}',
                },
            },
        });

        expect(secondChunk).toEqual(expect.objectContaining({
            id: 'checkpoint-style',
            question: 'Pick one',
            options: expect.arrayContaining([
                expect.objectContaining({ id: 'a', label: 'A' }),
                expect.objectContaining({ id: 'b', label: 'B' }),
            ]),
        }));
        expect(app.pendingCheckpointToolCallBuffers.size).toBe(0);
    });

    test('recognizes streamed user-checkpoint tool events without result metadata', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.hasSurveyToolEvent([{ toolName: 'user_checkpoint', stage: 'started' }])).toBe(true);
    });

    test('builds plugin menu selections into chat request tool metadata', () => {
        const app = Object.create(loadChatAppPrototype());
        app.selectedToolIntentIds = new Set(['research', 'documents', 'remote']);

        const options = app.buildToolIntentRequestOptions();

        expect(options.executionProfile).toBe('remote-build');
        expect(options.metadata).toEqual(expect.objectContaining({
            toolSelectionSource: 'web-chat-plugin-menu',
            selectedPluginLanes: ['research', 'documents', 'remote'],
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
            preferredTool: 'remote-cli-agent',
        }));
        expect(options.metadata.plannedTools).toEqual(expect.arrayContaining([
            'web-search',
            'web-fetch',
            'document-workflow',
            'remote-cli-agent',
        ]));
        expect(options.metadata.userSelectedToolIds).toEqual(expect.arrayContaining([
            'web-search',
            'web-fetch',
            'document-workflow',
            'remote-cli-agent',
        ]));
        expect(options.metadata.userToolIntents).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'research' }),
            expect.objectContaining({ id: 'documents' }),
            expect.objectContaining({ id: 'remote' }),
        ]));
    });

    test('builds tool-picker command templates from selected lanes and catalog schemas', () => {
        const app = Object.create(loadChatAppPrototype());
        app.selectedToolIntentIds = new Set(['remote']);
        app.toolCatalogTools = [
            {
                id: 'web-search',
                name: 'Web Search',
                description: 'Search the web',
                category: 'web',
                inputSchema: {
                    type: 'object',
                    required: ['query'],
                    properties: {
                        query: { type: 'string' },
                    },
                },
            },
            {
                id: 'remote-cli-agent',
                name: 'Remote CLI Agent',
                description: 'Run remote build loops',
                category: 'ssh',
            },
        ];

        expect(app.getToolCommandPickerTools().map((tool) => tool.id)).toEqual([
            'remote-cli-agent',
            'web-search',
        ]);
        expect(app.buildToolCommandTemplate('remote-cli-agent')).toBe('/tool remote-cli-agent {"task":"","adminMode":true}');
        expect(app.buildToolCommandTemplate('web-search')).toBe('/tool web-search {"query":""}');
    });

    test('replaces stale tool command drafts when picking a new tool', () => {
        const app = Object.create(loadChatAppPrototype());
        app.selectedToolIntentIds = new Set(['remote']);
        app.toolCatalogTools = [{ id: 'remote-cli-agent' }];
        app.messageInput = {
            value: '/tool web-search {"query":""}',
            focus: jest.fn(),
        };
        app.autoResize = { resize: jest.fn() };
        app.updateSendButton = jest.fn();
        app.toolMenuPanel = null;
        app.toolCommandPicker = null;

        app.insertToolCommandTemplateForTool('remote-cli-agent');

        expect(app.messageInput.value).toBe('/tool remote-cli-agent {"task":"","adminMode":true}');
        expect(app.updateSendButton).toHaveBeenCalled();
    });

    test('builds direct tool invoke options from plus-menu selections', () => {
        const app = Object.create(loadChatAppPrototype());
        app.selectedToolIntentIds = new Set(['remote']);

        const options = app.buildToolInvokeRequestOptions('remote-cli-agent');

        expect(options.executionProfile).toBe('remote-build');
        expect(options.metadata).toEqual(expect.objectContaining({
            toolSelectionSource: 'web-chat-plugin-menu',
            directToolCallSource: 'web-chat-tool-command',
            directToolId: 'remote-cli-agent',
            preferredTool: 'remote-cli-agent',
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
        }));
        expect(options.metadata.plannedTools).toEqual(expect.arrayContaining(['remote-cli-agent']));
        expect(options.metadata.userSelectedToolIds).toEqual(expect.arrayContaining(['remote-cli-agent']));
    });

    test('selects picker tools as chips without writing JSON command drafts', () => {
        const app = Object.create(loadChatAppPrototype());
        app.selectedToolIntentIds = new Set();
        app.toolCatalogTools = [{
            id: 'remote-cli-agent',
            name: 'Remote CLI Agent',
            icon: 'server',
            description: 'Run remote build loops',
        }];
        app.selectedToolChipTray = null;
        app.toolMenuPanel = null;
        app.toolCommandPicker = null;
        app.messageInput = {
            value: 'Deploy the latest frontend fix',
            focus: jest.fn(),
        };

        expect(app.selectToolForNextMessage('remote-cli-agent')).toBe(true);

        expect(app.messageInput.value).toBe('Deploy the latest frontend fix');
        expect(app.selectedDirectTool).toEqual(expect.objectContaining({
            id: 'remote-cli-agent',
            name: 'Remote CLI Agent',
            icon: 'server',
        }));
    });

    test('builds selected tool chip metadata around clean chat content', () => {
        const app = Object.create(loadChatAppPrototype());
        app.selectedToolIntentIds = new Set();
        app.selectedDirectTool = {
            id: 'remote-cli-agent',
            name: 'Remote CLI Agent',
            icon: 'server',
        };
        app.toolCatalogTools = [];

        const options = app.buildSelectedDirectToolRequestOptions();

        expect(options.executionProfile).toBe('remote-build');
        expect(options.metadata).toEqual(expect.objectContaining({
            toolSelectionSource: 'web-chat-tool-chip',
            selectedToolSource: 'web-chat-tool-chip',
            directToolId: 'remote-cli-agent',
            preferredTool: 'remote-cli-agent',
            selectedToolChip: expect.objectContaining({
                id: 'remote-cli-agent',
                name: 'Remote CLI Agent',
            }),
        }));
        expect(options.metadata.plannedTools).toEqual(['remote-cli-agent']);
        expect(options.metadata.userSelectedToolIds).toEqual(['remote-cli-agent']);
        expect(options.metadata.toolSelectionInstructions).toContain('activated the Remote CLI Agent tool chip');
        expect(options.metadata.toolSelectionInstructions).toContain('do not require the tool name to appear');
    });

    test('infers remote-build context for typed remote tool commands without menu selections', () => {
        const app = Object.create(loadChatAppPrototype());
        app.selectedToolIntentIds = new Set();

        const options = app.buildToolInvokeRequestOptions('remote-command');

        expect(options.executionProfile).toBe('remote-build');
        expect(options.metadata).toEqual(expect.objectContaining({
            directToolCallSource: 'web-chat-tool-command',
            directToolId: 'remote-command',
            preferredTool: 'remote-command',
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
        }));
        expect(options.metadata.plannedTools).toEqual(['remote-command']);
    });
});

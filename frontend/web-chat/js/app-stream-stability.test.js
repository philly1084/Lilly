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

function loadChatAppContext() {
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
        uiHelpers: {},
    };

    vm.createContext(context);
    vm.runInContext(source, context);
    return context;
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return { promise, resolve, reject };
}

function flushAsync() {
    return new Promise((resolve) => setImmediate(resolve));
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

    test('keeps generated progress fallback copy user-facing', () => {
        const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

        expect(source).toContain('Keeping a clear progress summary while the response continues.');
        expect(source).not.toContain('Waiting for real reasoning data');
    });

    test('categorizes tool events without exposing internal tool names', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.categorizeToolProgress({ toolName: 'web-search' })).toEqual({
            id: 'gathering',
            label: 'Gathering',
            detail: 'Gathering context and sources.',
        });
        expect(app.categorizeToolProgress({ toolName: 'remote-cli-agent' })).toEqual({
            id: 'applying',
            label: 'Applying',
            detail: 'Applying the requested changes.',
        });
    });

    test('advances deterministic goal steps from observed activity', () => {
        const app = Object.create(loadChatAppPrototype());
        const initial = {
            goal: { objective: 'Research and verify the answer.' },
            steps: [
                { id: 'understand', title: 'Understand', status: 'in_progress' },
                { id: 'gather', title: 'Gather', status: 'pending' },
                { id: 'synthesize', title: 'Synthesize', status: 'pending' },
                { id: 'deliver', title: 'Deliver', status: 'pending' },
            ],
        };

        const gathering = app.advanceGoalProgress(initial, { category: 'gathering', stage: 'started' });
        const gathered = app.advanceGoalProgress(gathering, { category: 'gathering', stage: 'completed' });

        expect(gathering.steps.map((step) => step.status)).toEqual(['completed', 'in_progress', 'pending', 'pending']);
        expect(gathered.steps.map((step) => step.status)).toEqual(['completed', 'completed', 'in_progress', 'pending']);
    });

    test('labels synthetic activity separately from provider reasoning', () => {
        const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

        expect(source).toContain("const SYNTHETIC_REASONING_TITLE = 'Activity';");
        expect(source).toContain("reasoningDisplaySource: 'stream'");
    });

    test('keeps Mission mode authoritative instead of rendering a duplicate goal card', () => {
        const app = Object.create(loadChatAppPrototype());
        app.currentStreamingMessageId = 'assistant-1';
        app.missionState = { active: true };
        app.getStreamingMessageSessionId = () => 'session-1';
        app.getSessionMessage = () => ({
            id: 'assistant-1',
            role: 'assistant',
            progressState: {},
        });
        app.updateMissionFromPayload = jest.fn();
        app.updateLiveResponsePhase = jest.fn();
        app.updateStreamingMessageState = jest.fn();

        app.handleProgress({
            progress: {
                phase: 'understanding',
                detail: 'Classified the request.',
                goal: { objective: 'Deploy the app.' },
                reasoningPolicy: { complexityBand: 'extended' },
                steps: [{ id: 'inspect', title: 'Inspect', status: 'in_progress' }],
            },
        });

        expect(app.updateMissionFromPayload).toHaveBeenCalled();
        expect(app.updateStreamingMessageState).toHaveBeenCalledWith(
            expect.objectContaining({ progressState: null, isStreaming: true }),
            expect.any(Object),
        );
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

    test('builds IDE lane metadata for reusable frontend source edits', () => {
        const app = Object.create(loadChatAppPrototype());
        app.selectedToolIntentIds = new Set(['ide']);

        const options = app.buildToolIntentRequestOptions();

        expect(options.executionProfile).toBeUndefined();
        expect(options.metadata).toEqual(expect.objectContaining({
            toolSelectionSource: 'web-chat-plugin-menu',
            selectedPluginLanes: ['ide'],
            frontendEditMode: true,
            frontendSourceStrategy: 'search-read-targeted-edit-verify',
            frontendIterationPreferred: true,
        }));
        expect(options.metadata.plannedTools).toEqual(expect.arrayContaining([
            'file-search',
            'file-read',
            'file-write',
            'git-safe',
            'code-sandbox',
            'web-scrape',
        ]));
        expect(options.metadata.toolSelectionInstructions).toContain('IDE');
        expect(options.metadata.toolSelectionInstructions).toContain('search first');
        expect(options.metadata.userToolDecisionTree).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'ide',
                steps: expect.arrayContaining([
                    expect.stringContaining('targeted source edits'),
                ]),
            }),
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

    test('formats runtime caller contracts in the tools list', () => {
        const app = Object.create(loadChatAppPrototype());

        const formatted = app.formatToolsList({
            tools: [
                {
                    id: 'web-fetch',
                    category: 'web',
                    description: 'Fetch a selected source.',
                    runtime: {
                        configured: true,
                        callerContract: [
                            'Use after web-search to verify selected URLs before citing.',
                            'Prefer for direct page/PDF fetches.',
                            'Escalate to web-scrape for browser rendering.',
                            'This fourth line should stay out of compact help.',
                        ],
                    },
                    inputSchema: {
                        type: 'object',
                        properties: {
                            url: { type: 'string' },
                        },
                    },
                },
            ],
        });

        expect(formatted).toContain('- `web-fetch` (web)');
        expect(formatted).toContain('  Use:');
        expect(formatted).toContain('    - Use after web-search to verify selected URLs before citing.');
        expect(formatted).toContain('    - Prefer for direct page/PDF fetches.');
        expect(formatted).toContain('    - Escalate to web-scrape for browser rendering.');
        expect(formatted).not.toContain('This fourth line');
        expect(formatted).toContain('  Params: url');
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

    test('supports arrow key navigation through the plus menu controls', () => {
        const app = Object.create(loadChatAppPrototype());
        const focused = [];
        const makeItem = (name) => ({
            name,
            disabled: false,
            contains: (target) => target?.name === name,
            closest: () => null,
            focus: jest.fn(() => focused.push(name)),
        });
        const items = [
            makeItem('research'),
            makeItem('images'),
            makeItem('skill'),
            makeItem('clear'),
        ];
        app.toolMenuPanel = {
            classList: { contains: () => false },
            querySelectorAll: () => items,
        };

        const firstEvent = {
            key: 'ArrowDown',
            target: items[0],
            preventDefault: jest.fn(),
        };
        expect(app.handleToolMenuKeydown(firstEvent)).toBe(true);
        expect(firstEvent.preventDefault).toHaveBeenCalled();
        expect(items[1].focus).toHaveBeenCalled();

        const wrapEvent = {
            key: 'ArrowUp',
            target: items[0],
            preventDefault: jest.fn(),
        };
        expect(app.handleToolMenuKeydown(wrapEvent)).toBe(true);
        expect(items[3].focus).toHaveBeenCalled();

        const endEvent = {
            key: 'End',
            target: items[1],
            preventDefault: jest.fn(),
        };
        expect(app.handleToolMenuKeydown(endEvent)).toBe(true);
        expect(focused).toEqual(['images', 'clear', 'clear']);
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

    test('queues TTS autoplay across agent pass messages instead of interrupting active speech', async () => {
        const context = loadChatAppContext();
        const firstSpeech = createDeferred();
        const secondSpeech = createDeferred();
        const speechRequests = [];

        context.uiHelpers = {
            isTtsAutoPlayEnabled: jest.fn(() => true),
            isTtsAvailable: jest.fn(() => true),
            buildSpeakableMessageText: jest.fn((message) => String(message?.content || '').trim()),
            ttsManager: {
                speakMessage: jest.fn((request) => {
                    speechRequests.push(request);
                    return speechRequests.length === 1 ? firstSpeech.promise : secondSpeech.promise;
                }),
            },
        };

        const app = Object.create(context.ChatApp.prototype);
        app.ttsAutoPlayQueue = [];
        app.ttsAutoPlayQueuedIds = new Set();
        app.ttsAutoPlayActive = false;

        expect(await app.maybeSpeakAssistantMessage({
            id: 'assistant-pass-1',
            role: 'assistant',
            content: 'First pass is ready.',
        })).toBe(true);
        expect(await app.maybeSpeakAssistantMessage({
            id: 'assistant-pass-2',
            role: 'assistant',
            content: 'Second pass is ready.',
        })).toBe(true);

        await Promise.resolve();
        expect(context.uiHelpers.ttsManager.speakMessage).toHaveBeenCalledTimes(1);
        expect(speechRequests[0]).toEqual({
            messageId: 'assistant-pass-1',
            text: 'First pass is ready.',
        });

        firstSpeech.resolve(true);
        await Promise.resolve();
        await flushAsync();

        expect(context.uiHelpers.ttsManager.speakMessage).toHaveBeenCalledTimes(2);
        expect(speechRequests[1]).toEqual({
            messageId: 'assistant-pass-2',
            text: 'Second pass is ready.',
        });

        secondSpeech.resolve(true);
        await Promise.resolve();
        await flushAsync();
        expect(app.ttsAutoPlayActive).toBe(false);
    });
});

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
});

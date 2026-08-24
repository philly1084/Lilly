const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createDocumentStub(execCommand = jest.fn(() => true)) {
    const appended = [];
    const body = {
        appendChild: jest.fn((node) => {
            appended.push(node);
            node.parentNode = body;
            return node;
        }),
    };
    return {
        body,
        appended,
        execCommand,
        createElement: jest.fn(() => ({
            value: '',
            style: {},
            setAttribute: jest.fn(),
            select: jest.fn(),
            remove: jest.fn(function remove() {
                const index = appended.indexOf(this);
                if (index >= 0) {
                    appended.splice(index, 1);
                }
            }),
        })),
        getElementById: jest.fn(() => null),
        querySelectorAll: jest.fn(() => []),
    };
}

function loadAIAssistant(options = {}) {
    const sourcePath = path.join(__dirname, 'ai-assistant.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global instance[\s\S]*$/,
            'module.exports = { AIAssistant };',
        );
    const document = options.document || createDocumentStub();
    const navigator = options.navigator || {
        clipboard: {
            writeText: jest.fn(async () => true),
        },
    };
    const window = {
        app: options.app || { showToast: jest.fn() },
        infiniteCanvas: { elements: [], selectedElements: [] },
        toolManager: {},
        historyManager: {},
        prompt: jest.fn(),
    };
    if (options.SpeechRecognition) {
        window.SpeechRecognition = options.SpeechRecognition;
    }
    const context = {
        module: { exports: {} },
        exports: {},
        console,
        document,
        navigator,
        window,
        Date,
        Math,
        Error,
        Set,
        Map,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: sourcePath });

    return {
        AIAssistant: context.module.exports.AIAssistant,
        document,
        navigator,
        window,
    };
}

function createAssistant(AIAssistant) {
    const assistant = Object.create(AIAssistant.prototype);
    assistant.recordActionLedger = jest.fn();
    assistant.showStatus = jest.fn();
    assistant.buildBoardBriefText = jest.fn(() => 'Canvas handoff brief');
    assistant.lastBoardBriefText = '';
    return assistant;
}

describe('canvas AI assistant copy handoffs', () => {
    test('synchronizes accessibility state after opening the panel on startup', () => {
        const source = fs.readFileSync(path.join(__dirname, 'ai-assistant.js'), 'utf8');

        expect(source).toMatch(
            /this\.panel\?\.classList\.add\('active'\);\s*this\.syncPanelState\(\);/,
        );
    });

    test('keeps the Canvas AI trigger and panel visibility state synchronized', () => {
        const trigger = { setAttribute: jest.fn() };
        const panel = {
            classList: {
                contains: jest.fn(() => false),
                remove: jest.fn(),
            },
            setAttribute: jest.fn(),
        };
        const document = createDocumentStub();
        document.getElementById = jest.fn((id) => id === 'aiAssistantBtn' ? trigger : null);
        const { AIAssistant } = loadAIAssistant({ document });
        const assistant = createAssistant(AIAssistant);
        assistant.panel = panel;

        assistant.syncPanelState();

        expect(trigger.setAttribute).toHaveBeenCalledWith('aria-expanded', 'false');
        expect(panel.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');

        panel.classList.contains.mockReturnValue(true);
        assistant.syncPanelState();

        expect(trigger.setAttribute).toHaveBeenLastCalledWith('aria-expanded', 'true');
        expect(panel.setAttribute).toHaveBeenLastCalledWith('aria-hidden', 'false');

        assistant.hidePanel();
        expect(panel.classList.remove).toHaveBeenCalledWith('active');
    });

    test('falls back to textarea copy when navigator clipboard rejects', async () => {
        const execCommand = jest.fn(() => true);
        const document = createDocumentStub(execCommand);
        const navigator = {
            clipboard: {
                writeText: jest.fn(async () => {
                    throw new Error('denied');
                }),
            },
        };
        const { AIAssistant } = loadAIAssistant({ document, navigator });
        const assistant = createAssistant(AIAssistant);

        await expect(assistant.writeClipboardText('handoff packet')).resolves.toBe(true);

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('handoff packet');
        expect(document.createElement).toHaveBeenCalledWith('textarea');
        expect(execCommand).toHaveBeenCalledWith('copy');
        expect(document.appended).toHaveLength(0);
    });

    test('copy board brief records success when fallback copy succeeds', async () => {
        const execCommand = jest.fn(() => true);
        const document = createDocumentStub(execCommand);
        const navigator = {
            clipboard: {
                writeText: jest.fn(async () => {
                    throw new Error('blocked');
                }),
            },
        };
        const { AIAssistant } = loadAIAssistant({ document, navigator });
        const assistant = createAssistant(AIAssistant);

        await assistant.copyBoardBrief();

        expect(assistant.recordActionLedger).toHaveBeenCalledWith('Copied board brief', 'success', 'brief');
        expect(assistant.showStatus).toHaveBeenCalledWith('Board brief copied.', 'success');
        expect(execCommand).toHaveBeenCalledWith('copy');
    });

    test('keeps existing error path when both clipboard routes fail', async () => {
        const document = createDocumentStub(jest.fn(() => false));
        const navigator = {
            clipboard: {
                writeText: jest.fn(async () => {
                    throw new Error('blocked');
                }),
            },
        };
        const { AIAssistant } = loadAIAssistant({ document, navigator });
        const assistant = createAssistant(AIAssistant);

        await assistant.copyBoardBrief();

        expect(assistant.recordActionLedger).toHaveBeenCalledWith('Clipboard unavailable for board brief', 'warning', 'brief');
        expect(assistant.showStatus).toHaveBeenCalledWith('Clipboard unavailable. Add the brief as a note instead.', 'error');
    });

    test('marks shared images as selected Canvas AI context', async () => {
        const input = {
            value: '',
            focus: jest.fn(),
        };
        const scopeSelect = { value: 'board' };
        const file = { name: 'reference.png', type: 'image/png' };
        const element = { id: 'image-1' };
        const app = {
            loadImage: jest.fn(async () => element),
            showToast: jest.fn(),
        };
        const { AIAssistant } = loadAIAssistant({ app });
        const assistant = createAssistant(AIAssistant);
        assistant.input = input;
        assistant.scopeSelect = scopeSelect;
        assistant.setMode = jest.fn();
        assistant.showPanel = jest.fn();
        assistant.updateGroundingPanel = jest.fn();
        assistant.addConversationMessage = jest.fn();

        await expect(assistant.shareReferenceImage(file)).resolves.toBe(element);

        expect(app.loadImage).toHaveBeenCalledWith(file, null, {
            name: 'reference.png',
            canvasRole: 'ai-reference',
            sharedWithAI: true,
        });
        expect(assistant.scope).toBe('selection');
        expect(scopeSelect.value).toBe('selection');
        expect(assistant.setMode).toHaveBeenCalledWith('chat');
        expect(assistant.showPanel).toHaveBeenCalled();
        expect(assistant.updateGroundingPanel).toHaveBeenCalled();
        expect(assistant.addConversationMessage).toHaveBeenCalledWith('user', 'Shared image: reference.png');
        expect(input.value).toBe('Help me work with the selected image "reference.png". ');
        expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(assistant.showStatus).toHaveBeenCalledWith('Image added as selected AI context.', 'success');
    });

    test('keeps voice button pressed state and next action synchronized', () => {
        const button = {
            classList: { toggle: jest.fn() },
            setAttribute: jest.fn(),
            title: '',
        };
        const { AIAssistant } = loadAIAssistant();
        const assistant = createAssistant(AIAssistant);
        assistant.voiceBtn = button;

        assistant.setListeningState(true);

        expect(assistant.isListening).toBe(true);
        expect(button.classList.toggle).toHaveBeenCalledWith('is-listening', true);
        expect(button.setAttribute).toHaveBeenCalledWith('aria-pressed', 'true');
        expect(button.setAttribute).toHaveBeenCalledWith('aria-label', 'Stop voice input');
        expect(button.title).toBe('Stop voice input');

        assistant.setListeningState(false);

        expect(assistant.isListening).toBe(false);
        expect(button.classList.toggle).toHaveBeenCalledWith('is-listening', false);
        expect(button.setAttribute).toHaveBeenCalledWith('aria-pressed', 'false');
        expect(button.setAttribute).toHaveBeenCalledWith('aria-label', 'Start voice input');
        expect(button.title).toBe('Start voice input');
    });
});

describe('canvas AI composer inputs', () => {
    test('voice input writes recognized speech into the active prompt', () => {
        let recognition;
        class SpeechRecognitionStub {
            constructor() {
                recognition = this;
            }

            start() {}
        }

        const { AIAssistant, window } = loadAIAssistant();
        window.SpeechRecognition = SpeechRecognitionStub;
        const assistant = Object.create(AIAssistant.prototype);
        assistant.input = { value: 'Build' };
        assistant.voiceBtn = {
            classList: { toggle: jest.fn() },
            setAttribute: jest.fn(),
            title: '',
        };
        assistant.voiceRecognition = null;
        assistant.isListening = false;
        assistant.showStatus = jest.fn();

        assistant.toggleVoiceInput();
        recognition.onresult({
            resultIndex: 0,
            results: [{ 0: { transcript: 'a simple login flow' } }],
        });

        expect(assistant.input.value).toBe('Build a simple login flow');
        expect(assistant.voiceBtn.setAttribute).toHaveBeenCalledWith('aria-pressed', 'true');
    });

});

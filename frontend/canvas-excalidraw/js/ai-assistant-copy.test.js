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
        app: { showToast: jest.fn() },
        infiniteCanvas: { elements: [], selectedElements: [] },
        toolManager: {},
        historyManager: {},
        prompt: jest.fn(),
    };
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
});

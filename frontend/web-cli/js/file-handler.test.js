const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadFileHandlerClass() {
    const sourcePath = path.join(__dirname, 'file-handler.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global instance \(will be initialized by app\.js\)\s*let fileHandler = null;\s*$/,
            'module.exports = { FileHandler };'
        );
    const dom = new JSDOM('<!doctype html><body><div id="terminal"></div><textarea id="command"></textarea></body>');
    const sandbox = {
        module: { exports: {} },
        exports: {},
        document: dom.window.document,
        setTimeout: jest.fn(),
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return { ...sandbox.module.exports, document: sandbox.document };
}

function createFileHandlerHarness() {
    const { FileHandler, document } = loadFileHandlerClass();
    const app = {
        commandInput: document.getElementById('command'),
        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        },
        printError: jest.fn(),
        printSystem: jest.fn(),
        renderMarkdown: jest.fn((text) => `<p>${text}</p>`),
        scrollToBottom: jest.fn(),
        terminalOutput: document.getElementById('terminal'),
        writeClipboardText: jest.fn().mockResolvedValue(undefined),
    };
    app.commandInput.focus = jest.fn();

    return { fileHandler: new FileHandler(app), app, document };
}

describe('web-cli imported file actions', () => {
    test('stores imported content behind a compact action id instead of a full data attribute', () => {
        const { fileHandler, document } = createFileHandlerHarness();
        const content = 'value="quoted" & <tag>\n'.repeat(200);

        fileHandler.displayImportedContent('quoted "file".txt', content, 'txt');

        const copyButton = document.querySelector('.file-import-actions button');
        const sendButton = document.querySelectorAll('.file-import-actions button')[1];
        expect(copyButton.dataset.importId).toBe('1');
        expect(copyButton.getAttribute('data-content')).toBeNull();
        expect(copyButton.getAttribute('aria-label')).toBe('Copy imported file quoted "file".txt');
        expect(copyButton.getAttribute('title')).toBe('Copy quoted "file".txt');
        expect(sendButton.getAttribute('aria-label')).toBe('Send imported file quoted "file".txt to AI');
        expect(sendButton.getAttribute('title')).toBe('Send quoted "file".txt to AI');
        expect(copyButton.outerHTML).not.toContain('value=');
        expect(fileHandler.getImportedContentRecord('1').content).toBe(content);
    });

    test('copy and send actions keep using the selected imported file', async () => {
        const { fileHandler, app, document } = createFileHandlerHarness();

        fileHandler.displayImportedContent('first.txt', 'first file body', 'txt');
        const firstCopyButton = document.querySelector('.file-import-actions button');
        fileHandler.displayImportedContent('second.txt', 'second file body', 'txt');

        await fileHandler.copyContent(firstCopyButton);
        fileHandler.sendToAI('first.txt', firstCopyButton.dataset.importId);

        expect(app.writeClipboardText).toHaveBeenCalledWith('first file body');
        expect(app.commandInput.value).toContain('"first.txt"');
        expect(app.commandInput.value).toContain('first file body');
        expect(app.commandInput.value).not.toContain('second file body');
    });
});

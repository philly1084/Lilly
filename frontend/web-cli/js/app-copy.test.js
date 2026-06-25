const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadWebCliAppClass(overrides = {}) {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /const app = new CodeCLIApp\(\);\s*window\.app = app;\s*$/,
            'module.exports = { CodeCLIApp };'
        );
    const dom = new JSDOM('<!doctype html><body></body>');
    const sandbox = {
        module: { exports: {} },
        exports: {},
        document: dom.window.document,
        navigator: {},
        setTimeout: jest.fn(),
        ...overrides,
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return { ...sandbox.module.exports, document: sandbox.document, navigator: sandbox.navigator, setTimeout: sandbox.setTimeout };
}

function createCopyHarness(overrides = {}) {
    const loaded = loadWebCliAppClass(overrides);
    const app = Object.create(loaded.CodeCLIApp.prototype);
    app.printSystem = jest.fn();
    app.printWarning = jest.fn();
    return { app, document: loaded.document, navigator: loaded.navigator, setTimeout: loaded.setTimeout };
}

describe('web-cli copy helpers', () => {
    test('uses the Clipboard API when available', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const { app, navigator } = createCopyHarness({
            navigator: { clipboard: { writeText } },
        });

        await app.writeClipboardText('copy me');

        expect(writeText).toHaveBeenCalledWith('copy me');
        expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    });

    test('falls back to a temporary textarea when clipboard access is unavailable', async () => {
        const execCommand = jest.fn().mockReturnValue(true);
        const { app, document } = createCopyHarness();
        document.execCommand = execCommand;

        await app.writeClipboardText('fallback text');

        expect(execCommand).toHaveBeenCalledWith('copy');
        expect(document.querySelector('textarea')).toBeNull();
    });

    test('copies the last response through the shared fallback path', async () => {
        const { app } = createCopyHarness();
        app.lastResponse = 'final answer';
        app.writeClipboardText = jest.fn().mockResolvedValue(undefined);

        await app.copyLastOutput();

        expect(app.writeClipboardText).toHaveBeenCalledWith('final answer');
        expect(app.printSystem).toHaveBeenCalledWith('Last response copied to clipboard');
    });

    test('copies rendered code blocks through the shared helper', async () => {
        const { app, document, setTimeout } = createCopyHarness();
        app.writeClipboardText = jest.fn().mockResolvedValue(undefined);
        document.body.innerHTML = `
            <div class="code-block">
                <button type="button">Copy</button>
                <pre><code>const value = 1;</code></pre>
            </div>
        `;
        const button = document.querySelector('button');

        await app.copyCode(button);

        expect(app.writeClipboardText).toHaveBeenCalledWith('const value = 1;');
        expect(button.textContent).toBe('Copied!');
        expect(setTimeout).toHaveBeenCalledTimes(1);
    });
});

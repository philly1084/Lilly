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

describe('web-cli stream progress display', () => {
    test('cleans runner log prefixes before rendering progress lines', () => {
        const { app, document } = createCopyHarness();
        document.body.innerHTML = '<main id="terminalOutput"></main>';
        app.terminalOutput = document.getElementById('terminalOutput');
        app.getTimestamp = jest.fn(() => '12:34');
        app.scrollToBottom = jest.fn();

        expect(app.cleanProgressLineText('[remote-cli-agent] stdout: `Applying k3s manifest`')).toBe('Applying k3s manifest');

        app.updateProgressLine('[remote-cli-agent] stdout: `Applying k3s manifest`');

        const line = app.terminalOutput.querySelector('.line-output.system.stream-progress');
        expect(line).not.toBeNull();
        expect(line.textContent).toContain('Applying k3s manifest');
        expect(line.textContent).not.toContain('remote-cli-agent');
        expect(line.textContent).not.toContain('stdout:');
        expect(line.textContent).not.toContain('`');
    });
});

describe('web-cli file manager modal', () => {
    test('opens as a labeled dialog and restores focus after Escape', async () => {
        const { app, document } = createCopyHarness();
        document.body.innerHTML = '<button id="filesButton" type="button">Files</button>';
        const filesButton = document.getElementById('filesButton');
        filesButton.focus();
        app.sessionFiles = [];
        app.syncStoredSessionArtifacts = jest.fn().mockResolvedValue([]);

        await app.openFileManager();

        const modal = document.getElementById('file-manager-modal');
        const dialog = modal.querySelector('.file-manager-content');
        const closeButton = modal.querySelector('.file-manager-close');

        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('file-manager-title');
        expect(dialog.getAttribute('aria-describedby')).toBe('file-manager-description');
        expect(document.getElementById('file-manager-title').textContent).toContain('Session Files');
        expect(document.activeElement).toBe(closeButton);

        modal.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(document.getElementById('file-manager-modal')).toBeNull();
        expect(document.activeElement).toBe(filesButton);
    });
});

describe('web-cli shortcuts modal', () => {
    test('opens as an accessible dialog and restores focus on close', () => {
        const indexMarkup = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const parsed = new JSDOM(indexMarkup);
        const shortcutsModalMarkup = parsed.window.document.getElementById('shortcutsModal').outerHTML;
        const { app, document } = createCopyHarness();
        document.body.innerHTML = `
            <button id="helpButton" type="button">Help</button>
            ${shortcutsModalMarkup}
        `;
        const helpButton = document.getElementById('helpButton');
        const modal = document.getElementById('shortcutsModal');
        const dialog = modal.querySelector('.modal');
        const closeButton = modal.querySelector('.modal-close');
        helpButton.focus();
        app.shortcutsModal = modal;
        app.shortcutsReturnFocus = null;

        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('shortcutsTitle');
        expect(dialog.getAttribute('aria-describedby')).toBe('shortcutsContent');
        expect(modal.getAttribute('aria-hidden')).toBe('true');

        app.showShortcuts();

        expect(modal.classList.contains('active')).toBe(true);
        expect(modal.getAttribute('aria-hidden')).toBe('false');
        expect(document.activeElement).toBe(closeButton);
        expect(document.getElementById('shortcutsContent').textContent).toContain('Send message');

        const preventDefault = jest.fn();
        app.handleShortcutsKeydown({ key: 'Escape', preventDefault });

        expect(modal.classList.contains('active')).toBe(false);
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(document.activeElement).toBe(helpButton);
        expect(preventDefault).toHaveBeenCalled();
    });
});

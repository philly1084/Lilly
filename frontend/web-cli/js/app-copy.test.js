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

    test('falls back when the Clipboard API rejects access', async () => {
        const writeText = jest.fn().mockRejectedValue(new Error('NotAllowedError'));
        const execCommand = jest.fn().mockReturnValue(true);
        const { app, document } = createCopyHarness({
            navigator: { clipboard: { writeText } },
        });
        document.execCommand = execCommand;

        await app.writeClipboardText('permission fallback');

        expect(writeText).toHaveBeenCalledWith('permission fallback');
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

describe('web-cli response collapse controls', () => {
    test('names each toggle from its visible response title across state changes', () => {
        const { app, document } = createCopyHarness();
        document.body.innerHTML = `
            <div class="line line-output ai">
                <div class="cli-response-head">
                    <button type="button" class="ai-response-toggle" aria-label="Collapse response">v</button>
                    <span class="cli-response-title">Quality Gates</span>
                </div>
            </div>
        `;
        const line = document.querySelector('.line-output.ai');
        const button = document.querySelector('.ai-response-toggle');
        app.renderMermaidDiagrams = jest.fn();
        app.updateTtsControls = jest.fn();

        app.finishAIContentLine(line);

        expect(button.getAttribute('aria-label')).toBe('Collapse Quality Gates');
        expect(button.title).toBe('Collapse Quality Gates');
        expect(button.getAttribute('aria-expanded')).toBe('true');

        app.toggleAIResponse(button);

        expect(line.classList.contains('is-collapsed')).toBe(true);
        expect(button.getAttribute('aria-label')).toBe('Expand Quality Gates');
        expect(button.title).toBe('Expand Quality Gates');
        expect(button.getAttribute('aria-expanded')).toBe('false');
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

    test('renders file rows as keyboard-operable download targets', () => {
        const { app, document } = createCopyHarness();
        app.sessionFiles = [{
            id: 7,
            filename: 'launch brief <draft>.md',
            type: 'document',
            size: 2048,
            content: '# Launch',
            mimeType: 'text/markdown',
            createdAt: new Date().toISOString(),
        }];
        app.downloadFileById = jest.fn();

        app.renderFileManager();

        const row = document.querySelector('.file-item');
        const button = document.querySelector('.file-download-btn');
        expect(row.getAttribute('role')).toBe('button');
        expect(row.getAttribute('tabindex')).toBe('0');
        expect(row.getAttribute('aria-label')).toBe('Download launch brief <draft>.md');
        expect(row.querySelector('.file-icon').textContent).toBe('MD');
        expect(row.querySelector('.file-name').innerHTML).toBe('launch brief &lt;draft&gt;.md');
        expect(button.getAttribute('aria-label')).toBe('Download launch brief <draft>.md');

        const preventDefault = jest.fn();
        app.handleFileManagerFileKey({ key: ' ', preventDefault }, '7');

        expect(preventDefault).toHaveBeenCalled();
        expect(app.downloadFileById).toHaveBeenCalledWith('7');
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
        expect(document.getElementById('shortcutsContent').textContent).toContain('Up / Down');
        expect(document.getElementById('shortcutsContent').textContent).not.toContain('? / ?');

        const preventDefault = jest.fn();
        app.handleShortcutsKeydown({ key: 'Escape', preventDefault });

        expect(modal.classList.contains('active')).toBe(false);
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(document.activeElement).toBe(helpButton);
        expect(preventDefault).toHaveBeenCalled();
    });
});

describe('web-cli Unsplash result display', () => {
    test('uses readable metadata labels instead of placeholder glyphs', () => {
        const { app } = createCopyHarness();
        app.printAI = jest.fn();

        app.displayUnsplashResults([{
            width: 800,
            height: 600,
            likes: 42,
            altDescription: 'A calm harbor',
            author: { name: 'Ada' },
            links: { html: 'https://unsplash.com/photos/example' },
            urls: { small: 'https://images.unsplash.com/example' },
        }], 'harbor', 1);

        const output = app.printAI.mock.calls[0][0];
        expect(output).toContain('Size: 800x600 | Likes: 42 | By: Ada');
        expect(output).toContain('[View on Unsplash](https://unsplash.com/photos/example)');
        expect(output).not.toContain('??');
    });
});

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadCanvasAppClass(document) {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /document\.addEventListener\('DOMContentLoaded', \(\) => \{\s*window\.canvasApp = new CanvasApp\(\);\s*\}\);\s*$/,
            'module.exports = { CanvasApp };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        document,
        window: { document },
        localStorage: {
            setItem: jest.fn(),
            getItem: jest.fn(),
            removeItem: jest.fn(),
        },
        setTimeout: jest.fn(),
        console,
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.CanvasApp;
}

function loadCanvasArtifacts(dom) {
    const sourcePath = path.join(__dirname, 'artifacts.js');
    const source = fs.readFileSync(sourcePath, 'utf8');

    dom.window.fetch = jest.fn();
    vm.runInNewContext(source, {
        document: dom.window.document,
        window: dom.window,
        fetch: (...args) => dom.window.fetch(...args),
        FormData: dom.window.FormData,
        setTimeout: (callback) => callback(),
        console,
    }, { filename: sourcePath });
}

describe('Canvas type selector accessibility', () => {
    test('names the header model and reasoning selectors for assistive technology', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const modelSelect = dom.window.document.getElementById('model-select');
        const reasoningSelect = dom.window.document.getElementById('reasoning-effort-select');
        const sidebarToggle = dom.window.document.getElementById('sidebar-toggle');
        const themeToggle = dom.window.document.getElementById('theme-toggle');
        const newSessionButton = dom.window.document.getElementById('new-session-btn');
        const previewToggle = dom.window.document.getElementById('toggle-preview');
        const splitToggle = dom.window.document.getElementById('toggle-split');
        const undoButton = dom.window.document.getElementById('undo-btn');
        const redoButton = dom.window.document.getElementById('redo-btn');
        const copyButton = dom.window.document.getElementById('copy-btn');
        const downloadButton = dom.window.document.getElementById('download-btn');
        const reconnectButton = dom.window.document.getElementById('ws-reconnect-btn');
        const helpModal = dom.window.document.getElementById('help-modal');
        const helpCloseButton = dom.window.document.getElementById('help-modal-close');

        expect(modelSelect.getAttribute('aria-label')).toBe('Select AI model for Canvas generation');
        expect(reasoningSelect.getAttribute('aria-label')).toBe('Select reasoning effort for Canvas generation');
        expect(sidebarToggle.getAttribute('aria-label')).toBe('Toggle Canvas prompt panel');
        expect(themeToggle.getAttribute('aria-label')).toBe('Toggle Canvas theme');
        expect(newSessionButton.getAttribute('aria-label')).toBe('Start new Canvas session');
        expect(previewToggle.getAttribute('aria-label')).toBe('Show preview');
        expect(previewToggle.getAttribute('aria-controls')).toBe('preview-wrapper diagram-wrapper');
        expect(previewToggle.getAttribute('aria-pressed')).toBe('false');
        expect(splitToggle.getAttribute('aria-label')).toBe('Show split view');
        expect(splitToggle.getAttribute('aria-controls')).toBe('editor-wrapper preview-wrapper diagram-wrapper');
        expect(splitToggle.getAttribute('aria-pressed')).toBe('false');
        expect(undoButton.getAttribute('aria-label')).toBe('Undo last canvas edit');
        expect(redoButton.getAttribute('aria-label')).toBe('Redo last canvas edit');
        expect(copyButton.getAttribute('aria-label')).toBe('Copy canvas content to clipboard');
        expect(downloadButton.getAttribute('aria-label')).toBe('Download canvas content');
        expect(reconnectButton.getAttribute('aria-label')).toBe('Reconnect Canvas realtime updates');
        expect(helpModal.getAttribute('role')).toBe('dialog');
        expect(helpModal.getAttribute('aria-modal')).toBe('true');
        expect(helpModal.getAttribute('aria-labelledby')).toBe('help-modal-title');
        expect(helpModal.getAttribute('aria-hidden')).toBe('true');
        expect(helpCloseButton.getAttribute('aria-label')).toBe('Close keyboard shortcuts');
    });

    test('declares the active canvas type with aria-pressed in the initial markup', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const selector = dom.window.document.querySelector('.canvas-type-selector');
        const buttons = [...dom.window.document.querySelectorAll('.type-btn')];

        expect(selector.getAttribute('role')).toBe('group');
        expect(selector.getAttribute('aria-label')).toBe('Canvas type');
        expect(buttons).toHaveLength(4);
        expect(buttons.map((button) => [button.dataset.type, button.getAttribute('aria-pressed')])).toEqual([
            ['code', 'true'],
            ['document', 'false'],
            ['diagram', 'false'],
            ['frontend', 'false'],
        ]);
    });

    test('keeps aria-pressed synchronized when switching canvas type', () => {
        const dom = new JSDOM(`
            <button class="type-btn active" data-type="code" aria-pressed="true"></button>
            <button class="type-btn" data-type="document" aria-pressed="false"></button>
            <button class="type-btn" data-type="diagram" aria-pressed="false"></button>
            <button class="type-btn" data-type="frontend" aria-pressed="false"></button>
        `);
        const CanvasApp = loadCanvasAppClass(dom.window.document);
        const app = Object.create(CanvasApp.prototype);

        app.state = { canvasType: 'code' };
        app.pushToHistory = jest.fn();
        app.updatePreviewVisibility = jest.fn();
        app.updateStatusBar = jest.fn();
        app.saveToLocalStorage = jest.fn();
        app.typeManager = {
            setType: jest.fn(),
            getHandler: jest.fn(() => ({
                getCodeMirrorMode: () => 'markdown',
                getDefaultContent: () => 'default content',
            })),
        };
        app.editor = {
            setMode: jest.fn(),
            getValue: jest.fn(() => 'existing content'),
            setValue: jest.fn(),
        };

        app.switchCanvasType('document');

        const states = [...dom.window.document.querySelectorAll('.type-btn')]
            .map((button) => [button.dataset.type, button.classList.contains('active'), button.getAttribute('aria-pressed')]);

        expect(states).toEqual([
            ['code', false, 'false'],
            ['document', true, 'true'],
            ['diagram', false, 'false'],
            ['frontend', false, 'false'],
        ]);
    });

    test('announces canvas toast notifications with dismissible controls', () => {
        const dom = new JSDOM('<div id="toast-container" aria-label="Canvas notifications"></div>');
        const CanvasApp = loadCanvasAppClass(dom.window.document);
        const app = Object.create(CanvasApp.prototype);

        app.showToast('Copied to clipboard', 'success');
        app.showToast('Failed to download file', 'error');

        const [successToast, errorToast] = [...dom.window.document.querySelectorAll('.toast')];

        expect(successToast.getAttribute('role')).toBe('status');
        expect(successToast.getAttribute('aria-live')).toBe('polite');
        expect(successToast.getAttribute('aria-atomic')).toBe('true');
        expect(successToast.querySelector('.toast-close').getAttribute('aria-label')).toBe('Dismiss notification');

        expect(errorToast.getAttribute('role')).toBe('alert');
        expect(errorToast.getAttribute('aria-live')).toBe('assertive');
        expect(errorToast.getAttribute('aria-atomic')).toBe('true');
        expect(errorToast.querySelector('.toast-close').getAttribute('aria-label')).toBe('Dismiss notification');
    });

    test('names canvas export option popups and their close controls', () => {
        const dom = new JSDOM('<div id="toast-container" aria-label="Canvas notifications"></div>');
        const CanvasApp = loadCanvasAppClass(dom.window.document);
        const app = Object.create(CanvasApp.prototype);

        app.editor = { getValue: jest.fn(() => 'graph TD;') };
        app.exportManager = {
            downloadFile: jest.fn(),
            downloadSVG: jest.fn(),
            downloadPNG: jest.fn(),
        };

        app.showDiagramExportOptions({ outerHTML: '<svg></svg>' });

        const dialog = dom.window.document.querySelector('.toast');

        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-label')).toBe('Export diagram options');
        expect(dialog.querySelector('.toast-close').getAttribute('aria-label')).toBe('Close export diagram options');
    });

    test('resizes canvas panes from the keyboard separator', () => {
        const dom = new JSDOM(`
            <aside id="sidebar" style="width: 320px;"></aside>
            <div id="resizer" role="separator" aria-orientation="vertical" aria-valuemin="260" aria-valuemax="500" aria-valuenow="320" tabindex="0" aria-label="Resize prompt and canvas panes"></div>
        `);
        const CanvasApp = loadCanvasAppClass(dom.window.document);
        const app = Object.create(CanvasApp.prototype);

        app.editor = { resize: jest.fn() };
        app.setupResizer();

        const sidebar = dom.window.document.getElementById('sidebar');
        const resizer = dom.window.document.getElementById('resizer');

        resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(sidebar.style.width).toBe('340px');
        expect(resizer.getAttribute('aria-valuenow')).toBe('340');
        expect(app.editor.resize).toHaveBeenCalledTimes(1);

        resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(sidebar.style.width).toBe('260px');
        expect(resizer.getAttribute('aria-valuenow')).toBe('260');

        resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        expect(sidebar.style.width).toBe('500px');
        expect(resizer.getAttribute('aria-valuenow')).toBe('500');
    });

    test('keeps preview and split view toggle states synchronized', () => {
        const dom = new JSDOM(`
            <button id="toggle-preview" aria-label="Show preview" aria-pressed="false"></button>
            <button id="toggle-split" aria-label="Show split view" aria-pressed="false"></button>
            <div class="editor-container">
                <div id="editor-wrapper"></div>
                <div id="preview-wrapper" class="hidden"></div>
                <div id="diagram-wrapper" class="hidden"></div>
            </div>
            <div id="preview-content"></div>
        `);
        const CanvasApp = loadCanvasAppClass(dom.window.document);
        const app = Object.create(CanvasApp.prototype);

        app.state = { canvasType: 'document', isPreviewMode: false, isSplitView: false, metadata: {} };
        app.editor = {
            refresh: jest.fn(),
            getValue: jest.fn(() => '# Preview'),
        };
        app.typeManager = {
            getCurrentHandler: jest.fn(() => ({
                renderMarkdown: jest.fn(() => '<h1>Preview</h1>'),
            })),
        };

        app.togglePreview();

        const previewToggle = dom.window.document.getElementById('toggle-preview');
        const splitToggle = dom.window.document.getElementById('toggle-split');

        expect(previewToggle.getAttribute('aria-pressed')).toBe('true');
        expect(previewToggle.getAttribute('aria-label')).toBe('Hide preview');
        expect(splitToggle.getAttribute('aria-pressed')).toBe('false');
        expect(splitToggle.getAttribute('aria-label')).toBe('Show split view');

        app.toggleSplitView();

        expect(previewToggle.getAttribute('aria-pressed')).toBe('false');
        expect(previewToggle.getAttribute('aria-label')).toBe('Show preview');
        expect(splitToggle.getAttribute('aria-pressed')).toBe('true');
        expect(splitToggle.getAttribute('aria-label')).toBe('Hide split view');
    });

    test('keeps the keyboard shortcuts modal state and focus synchronized', () => {
        const dom = new JSDOM(`
            <button id="trigger">Open help</button>
            <div id="help-modal" class="help-modal hidden" role="dialog" aria-modal="true" aria-labelledby="help-modal-title" aria-hidden="true">
                <h2 id="help-modal-title">Keyboard Shortcuts</h2>
                <button id="help-modal-close" aria-label="Close keyboard shortcuts">Close</button>
            </div>
        `);
        const CanvasApp = loadCanvasAppClass(dom.window.document);
        const app = Object.create(CanvasApp.prototype);
        const trigger = dom.window.document.getElementById('trigger');
        const modal = dom.window.document.getElementById('help-modal');
        const closeButton = dom.window.document.getElementById('help-modal-close');

        trigger.focus();
        app.showHelpModal();

        expect(modal.classList.contains('hidden')).toBe(false);
        expect(modal.getAttribute('aria-hidden')).toBe('false');
        expect(dom.window.document.activeElement).toBe(closeButton);

        app.closeHelpModal();

        expect(modal.classList.contains('hidden')).toBe(true);
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(dom.window.document.activeElement).toBe(trigger);
    });

    test('labels the dynamic artifact panel and renders an empty state', () => {
        const dom = new JSDOM(`
            <section>
                <div class="action-buttons"></div>
            </section>
        `, { url: 'http://localhost:3000/canvas/' });

        loadCanvasArtifacts(dom);
        dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

        const panel = dom.window.document.querySelector('.artifact-panel');
        const title = dom.window.document.getElementById('artifact-panel-title');
        const uploadButton = dom.window.document.getElementById('artifact-upload-btn');
        const outputSelect = dom.window.document.getElementById('artifact-output-format');
        const artifactList = dom.window.document.getElementById('artifact-list');

        expect(panel.getAttribute('role')).toBe('region');
        expect(panel.getAttribute('aria-labelledby')).toBe('artifact-panel-title');
        expect(title.textContent).toBe('Artifacts');
        expect(uploadButton.getAttribute('aria-label')).toBe('Upload artifact file');
        expect(outputSelect.getAttribute('aria-label')).toBe('Choose generated artifact output format');
        expect(artifactList.getAttribute('role')).toBe('list');
        expect(artifactList.getAttribute('aria-label')).toBe('Attached artifacts');
        expect(artifactList.querySelector('.artifact-empty').textContent).toBe('No artifacts attached yet.');
    });

    test('names repeated artifact actions with the artifact filename', () => {
        const dom = new JSDOM(`
            <section>
                <div class="action-buttons"></div>
            </section>
        `, { url: 'http://localhost:3000/canvas/' });

        dom.window.CanvasAPI = {};
        dom.window.canvasApp = {
            state: {},
            api: {
                sendCanvasRequest: jest.fn((params) => params),
                sendWebSocketMessage: jest.fn((params) => params),
            },
            handleAIResponse: jest.fn(),
            newSession: jest.fn(),
            loadFromLocalStorage: jest.fn(),
        };

        loadCanvasArtifacts(dom);
        dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
        dom.window.canvasApp.handleAIResponse({
            artifacts: [
                {
                    id: 'artifact-1',
                    filename: 'brief.pdf',
                    format: 'pdf',
                    sizeBytes: 2048,
                    previewUrl: '/preview/brief',
                    downloadUrl: '/download/brief',
                },
                {
                    id: 'artifact-2',
                    filename: 'notes.md',
                    format: 'markdown',
                    sizeBytes: 512,
                    downloadUrl: '/download/notes',
                },
            ],
        });

        const list = dom.window.document.getElementById('artifact-list');
        expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(2);

        const [briefItem, notesItem] = [...list.querySelectorAll('[role="listitem"]')];
        expect(briefItem.querySelector('[data-action="toggle"]').getAttribute('aria-label')).toBe('Attach brief.pdf to the next Canvas request');
        expect(briefItem.querySelector('a[aria-label="Preview brief.pdf"]').textContent).toBe('Preview');
        expect(briefItem.querySelector('a[aria-label="Download brief.pdf"]').textContent).toBe('Download');
        expect(notesItem.querySelector('[data-action="toggle"]').getAttribute('aria-label')).toBe('Attach notes.md to the next Canvas request');
        expect(notesItem.querySelector('a[aria-label="Download notes.md"]').textContent).toBe('Download');

        briefItem.querySelector('[data-action="toggle"]').click();

        const selectedBriefButton = list.querySelector('[role="listitem"] [data-action="toggle"]');
        expect(selectedBriefButton.getAttribute('aria-pressed')).toBe('true');
        expect(selectedBriefButton.getAttribute('aria-label')).toBe('Detach brief.pdf from the next Canvas request');
    });
});

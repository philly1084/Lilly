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

describe('Canvas type selector accessibility', () => {
    test('names the header model and reasoning selectors for assistive technology', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const modelSelect = dom.window.document.getElementById('model-select');
        const reasoningSelect = dom.window.document.getElementById('reasoning-effort-select');

        expect(modelSelect.getAttribute('aria-label')).toBe('Select AI model for Canvas generation');
        expect(reasoningSelect.getAttribute('aria-label')).toBe('Select reasoning effort for Canvas generation');
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
});

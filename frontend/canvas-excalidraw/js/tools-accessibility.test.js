const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadToolManager(dom) {
    const sourcePath = path.join(__dirname, 'tools.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global instance\s*window\.toolManager = new ToolManager\(\);\s*$/,
            'module.exports = { ToolManager };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        document: dom.window.document,
        window: dom.window,
        setTimeout,
        clearTimeout,
    };

    dom.window.matchMedia = jest.fn(() => ({ matches: false }));
    dom.window.infiniteCanvas = { deselectAll: jest.fn() };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.ToolManager;
}

function createToolsDom() {
    return new JSDOM(`
        <div id="canvasContainer" class="canvas-container"></div>
        <div id="selectionBox"></div>
        <div id="textEditor"></div>
        <div id="aiImageTooltip"></div>
        <button class="tool-btn active" data-tool="selection" data-key="v">Select</button>
        <button class="tool-btn" data-tool="rectangle" data-key="r">Rectangle</button>
        <button class="tool-btn" data-tool="freedraw" data-key="p">Pencil</button>
    `, { url: 'http://localhost:3000/canvas/' });
}

describe('canvas tool button accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('initializes the active tool as the only pressed tool button', () => {
        const dom = createToolsDom();
        const ToolManager = loadToolManager(dom);
        const manager = new ToolManager();
        const pressedStates = Array.from(dom.window.document.querySelectorAll('.tool-btn'))
            .map((button) => [button.dataset.tool, button.getAttribute('aria-pressed'), button.classList.contains('active')]);

        expect(manager.currentTool).toBe('selection');
        expect(pressedStates).toEqual([
            ['selection', 'true', true],
            ['rectangle', 'false', false],
            ['freedraw', 'false', false],
        ]);
    });

    test('keeps aria-pressed synchronized when tools change', () => {
        const dom = createToolsDom();
        const ToolManager = loadToolManager(dom);
        const manager = new ToolManager();

        manager.setTool('rectangle');

        const buttons = Array.from(dom.window.document.querySelectorAll('.tool-btn'));
        expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
            'false',
            'true',
            'false',
        ]);
        expect(buttons.map((button) => button.classList.contains('active'))).toEqual([
            false,
            true,
            false,
        ]);
    });
});

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadAppClass(dom) {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global app instance\s*window\.app = new App\(\);\s*$/,
            'module.exports = { App };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        document: dom.window.document,
        window: dom.window,
        localStorage: dom.window.localStorage,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (callback) => callback(),
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.App;
}

function loadTemplatesManagerClass(dom) {
    const sourcePath = path.join(__dirname, 'templates.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global instance\s*window\.templatesManager = new TemplatesManager\(\);\s*$/,
            'module.exports = { TemplatesManager };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        document: dom.window.document,
        window: dom.window,
        localStorage: dom.window.localStorage,
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.TemplatesManager;
}

function loadImportExportManagerClass(dom) {
    const sourcePath = path.join(__dirname, 'import-export.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global instance\s*window\.importExportManager = new ImportExportManager\(\);\s*$/,
            'module.exports = { ImportExportManager };'
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

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.ImportExportManager;
}

function loadAIAssistantClass(dom) {
    const sourcePath = path.join(__dirname, 'ai-assistant.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global instance\s*window\.aiAssistant = new AIAssistant\(\);\s*$/,
            'module.exports = { AIAssistant };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        document: dom.window.document,
        window: dom.window,
        localStorage: dom.window.localStorage,
        fetch: jest.fn(),
        setTimeout,
        clearTimeout,
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.AIAssistant;
}

function createTemplatesModalHarness() {
    const dom = new JSDOM(`
        <button id="templatesBtn" type="button">Templates</button>
        <div id="templatesModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="templatesModalTitle" aria-describedby="templatesModalDescription" aria-hidden="true" style="display: none;">
            <div class="modal-content templates-content">
                <div class="modal-header">
                    <h2 id="templatesModalTitle">Templates</h2>
                    <button class="close-btn" id="closeTemplates" type="button" aria-label="Close templates">Close</button>
                </div>
                <p class="modal-description" id="templatesModalDescription">Choose a starter board to add editable shapes to the canvas.</p>
                <div class="templates-grid">
                    <button class="template-card" type="button" data-template="flowchart">Flowchart</button>
                    <button class="template-card" type="button" data-template="wireframe">Wireframe</button>
                </div>
            </div>
        </div>
    `, { url: 'http://localhost:3000/canvas/' });
    const TemplatesManager = loadTemplatesManagerClass(dom);
    const manager = Object.create(TemplatesManager.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    manager.previousFocus = null;
    manager.templates = {
        flowchart: {
            name: 'Flowchart',
            generator: () => [],
        },
    };

    return { dom, manager };
}

function createHelpModalHarness() {
    const dom = new JSDOM(`
        <button id="helpBtn" type="button">Help</button>
        <div class="modal" id="helpModal" role="dialog" aria-modal="true" aria-labelledby="helpModalTitle" aria-hidden="true">
            <div class="modal-content">
                <div class="modal-header">
                    <h3 id="helpModalTitle">Keyboard Shortcuts</h3>
                    <button class="close-btn" id="closeHelpModal" type="button" aria-label="Close keyboard shortcuts">Close</button>
                    <button id="helpExtraAction" type="button">Extra</button>
                </div>
            </div>
        </div>
    `, { url: 'http://localhost:3000/canvas/' });
    const App = loadAppClass(dom);
    const app = Object.create(App.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    app.helpModalPreviousFocus = null;

    return { dom, app };
}

function createDropdownHarness() {
    const dom = new JSDOM(`
        <div id="themeDropdown" class="dropdown">
            <button id="themePickerBtn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="themeMenu">Theme</button>
            <div id="themeMenu" class="dropdown-menu" role="menu" aria-label="Canvas theme">
                <button class="dropdown-item" type="button" role="menuitem" data-theme="light">Light</button>
                <button class="dropdown-item" type="button" role="menuitem" data-theme="dark">Dark</button>
                <button class="dropdown-item" type="button" role="menuitem" data-theme="contrast">High contrast</button>
            </div>
        </div>
        <div id="exportDropdown" class="dropdown">
            <button id="exportBtn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="exportMenu">Export</button>
            <div id="exportMenu" class="dropdown-menu" role="menu" aria-label="Export canvas">
                <button class="dropdown-item" type="button" role="menuitem" data-export="png">PNG</button>
                <button class="dropdown-item" type="button" role="menuitem" data-export="json">JSON</button>
                <button class="dropdown-item" type="button" role="menuitem" data-export="html">HTML</button>
            </div>
        </div>
        <button id="afterDropdown" type="button">After dropdowns</button>
    `, { url: 'http://localhost:3000/canvas/' });
    const App = loadAppClass(dom);
    const app = Object.create(App.prototype);

    global.document = dom.window.document;
    global.window = dom.window;
    global.localStorage = dom.window.localStorage;

    app.setTheme = jest.fn();
    app.showExportProgress = jest.fn();
    app.hideExportProgress = jest.fn();

    dom.window.importExportManager = {
        export: jest.fn().mockResolvedValue(undefined),
    };

    return { dom, app };
}

function createMobilePanelHarness() {
    const dom = new JSDOM(`
        <button id="mobileToolbarToggle" type="button" aria-label="Open tool dock" title="Open tool dock" aria-controls="toolbar" aria-expanded="false" data-open-label="Open tool dock" data-close-label="Close tool dock" data-open-title="Open tool dock" data-close-title="Close tool dock">Tools</button>
        <aside id="toolbar">
            <button id="mobileToolbarClose" type="button">Close tools</button>
            <button class="tool-dock-btn" type="button" data-dock-group="shapes">Shapes</button>
            <div class="tool-category" data-tool-group="shapes"></div>
        </aside>
        <button id="mobilePropertiesToggle" type="button" aria-label="Open properties panel" title="Open Properties" aria-controls="propertiesPanel" aria-expanded="false" data-open-label="Open properties panel" data-close-label="Close properties panel" data-open-title="Open Properties" data-close-title="Close Properties">Properties</button>
        <aside id="propertiesPanel">
            <button id="mobilePropertiesClose" type="button">Close properties</button>
        </aside>
    `, { url: 'http://localhost:3000/canvas/' });
    const App = loadAppClass(dom);
    const app = Object.create(App.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    app.activeDockGroup = '';
    app.currentTool = 'selection';
    dom.window.aiAssistant = {
        hidePanel: jest.fn(),
    };

    return { dom, app };
}

function createMiniMapHarness() {
    const dom = new JSDOM(`
        <button id="miniMapToggle" class="mini-map-toggle" type="button" aria-label="Show mini map" aria-controls="miniMap" aria-expanded="false" aria-pressed="false">Map</button>
        <div id="miniMap" style="display: none;"></div>
    `, { url: 'http://localhost:3000/canvas/' });
    const App = loadAppClass(dom);
    const app = Object.create(App.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    app.updateMiniMap = jest.fn();
    dom.window.infiniteCanvas = {
        canvas: {
            addEventListener: jest.fn(),
        },
    };

    return { app };
}

function createContextMenuHarness() {
    const dom = new JSDOM(`
        <div id="canvasContainer" tabindex="0"></div>
        <div id="canvasContextMenu" role="menu" aria-label="Canvas board actions" hidden>
            <div data-context-section="empty">
                <button type="button" role="menuitem" data-context-action="tool:selection">Select</button>
                <button type="button" role="menuitem" data-context-action="tool:text">Text</button>
                <button type="button" role="menuitem" data-context-action="create:storyboard">Storyboard</button>
            </div>
            <div data-context-section="selection" hidden>
                <button type="button" role="menuitem" data-context-action="duplicate">Duplicate</button>
                <button type="button" role="menuitem" data-context-action="delete">Delete</button>
                <button type="button" role="menuitem" data-context-action="ai:selection">Ask AI</button>
            </div>
        </div>
    `, { url: 'http://localhost:3000/canvas/' });
    const App = loadAppClass(dom);
    const app = Object.create(App.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    app.runCanvasContextAction = jest.fn();

    return { dom, app };
}

function createPanelTabsHarness() {
    const dom = new JSDOM(`
        <nav class="canvas-panel-tabs" aria-label="Canvas side panel" role="tablist">
            <button class="canvas-panel-tab active" id="canvasPanelTabInspector" type="button" role="tab" data-canvas-panel-tab="inspector" aria-selected="true" aria-controls="canvasPanelInspector" tabindex="0">Inspect</button>
            <button class="canvas-panel-tab" id="canvasPanelTabObjects" type="button" role="tab" data-canvas-panel-tab="objects" aria-selected="false" aria-controls="canvasPanelObjects" tabindex="-1">Objects</button>
            <button class="canvas-panel-tab" id="canvasPanelTabCreative" type="button" role="tab" data-canvas-panel-tab="creative" aria-selected="false" aria-controls="canvasPanelCreative" tabindex="-1">Create</button>
            <button class="canvas-panel-tab" id="canvasPanelTabLibrary" type="button" role="tab" data-canvas-panel-tab="library" aria-selected="false" aria-controls="canvasPanelLibrary" tabindex="-1">Blocks</button>
        </nav>
        <div id="canvasPanelInspector" role="tabpanel" aria-labelledby="canvasPanelTabInspector" data-canvas-panel="inspector"></div>
        <div id="canvasPanelObjects" role="tabpanel" aria-labelledby="canvasPanelTabObjects" data-canvas-panel="objects" hidden></div>
        <div id="canvasPanelCreative" role="tabpanel" aria-labelledby="canvasPanelTabCreative" data-canvas-panel="creative" hidden></div>
        <div id="canvasPanelLibrary" role="tabpanel" aria-labelledby="canvasPanelTabLibrary" data-canvas-panel="library" hidden></div>
        <div id="objectFilterChips" role="group" aria-label="Filter board objects">
            <button type="button" class="active" data-object-filter="all" aria-pressed="true">All</button>
            <button type="button" data-object-filter="drawing" aria-pressed="false">Draw</button>
            <button type="button" data-object-filter="production" aria-pressed="false">Media</button>
        </div>
    `, { url: 'http://localhost:3000/canvas/' });
    const App = loadAppClass(dom);
    const app = Object.create(App.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    app.renderObjectLibrary = jest.fn();
    app.renderProductionTimeline = jest.fn();
    app.renderSelectedMermaidEditor = jest.fn();
    app.renderConnectionBuilder = jest.fn();
    app.renderSavedBlockShelf = jest.fn();

    return { dom, app };
}

function createToolCategoryHarness() {
    const dom = new JSDOM(`
        <div class="tool-category expanded" data-tool-group="basic">
            <button class="tool-category-header" type="button" aria-expanded="true" aria-controls="toolGroupBasic">
                <span>Basic</span>
            </button>
            <div class="tool-category-content" id="toolGroupBasic"></div>
        </div>
    `, { url: 'http://localhost:3000/canvas/' });
    const App = loadAppClass(dom);
    const app = Object.create(App.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    return { app };
}

function createAIModeHarness() {
    const dom = new JSDOM(`
        <div class="ai-mode-toggle" role="radiogroup" aria-label="Canvas AI mode">
            <button class="ai-mode-btn active" id="chatModeBtn" data-mode="chat" type="button" role="radio" aria-checked="true" tabindex="0">Talk</button>
            <button class="ai-mode-btn" id="diagramModeBtn" data-mode="diagram" type="button" role="radio" aria-checked="false" tabindex="-1">Objects</button>
            <button class="ai-mode-btn" id="imageModeBtn" data-mode="image" type="button" role="radio" aria-checked="false" tabindex="-1">Image</button>
        </div>
        <div id="diagramOptions"></div>
        <div id="imageOptions" class="hidden"></div>
        <p class="ai-description"></p>
        <textarea id="aiInput"></textarea>
        <button id="aiGenerateBtn" type="button"><span>Icon</span><span>Send</span></button>
    `, { url: 'http://localhost:3000/canvas/' });
    const AIAssistant = loadAIAssistantClass(dom);
    const assistant = Object.create(AIAssistant.prototype);

    global.document = dom.window.document;
    global.window = dom.window;
    global.localStorage = dom.window.localStorage;

    assistant.input = document.getElementById('aiInput');
    assistant.generateBtn = document.getElementById('aiGenerateBtn');
    assistant.renderToolPlan = jest.fn();

    return { assistant };
}

function createBoardShelfHarness() {
    const dom = new JSDOM(`
        <div class="board-shelf" id="boardShelf">
            <div class="board-shelf-header">
                <div><span id="boardShelfSummary">No saved boards yet</span></div>
                <button type="button" data-board-shelf-action="save-current" aria-label="Save current board">Save</button>
            </div>
            <div class="board-shelf-list" id="boardShelfList"></div>
        </div>
    `, { url: 'http://localhost:3000/canvas/' });
    const App = loadAppClass(dom);
    const app = Object.create(App.prototype);

    global.document = dom.window.document;
    global.window = dom.window;
    global.localStorage = dom.window.localStorage;

    app.formatRelativeTime = jest.fn(() => 'just now');
    localStorage.setItem('kimi-canvas-saved-boards', JSON.stringify([{
        id: 'board-1',
        name: 'Customer onboarding flow',
        createdAt: '2026-08-24T08:00:00.000Z',
        updatedAt: '2026-08-24T08:00:00.000Z',
        elementCount: 1,
        summary: '1 object',
        elements: [{ id: 'rect-1', type: 'rectangle', width: 100, height: 60 }],
    }]));

    return { app };
}

describe('canvas help modal accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('top bar icon controls expose stable accessible names', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const document = dom.window.document;
        const pageTitle = document.querySelector('.top-bar-left .logo');
        const expectedLabels = {
            menuBtn: 'Open canvas menu',
            resetZoomBtn: 'Reset zoom to 100 percent',
            zoomOutBtn: 'Zoom out',
            zoomInBtn: 'Zoom in',
            enterpriseModeBtn: 'Toggle focus workspace',
            densityBtn: 'Toggle layout density',
            clearBtn: 'Clear canvas',
            importBtn: 'Import files',
            themePickerBtn: 'Choose canvas theme',
            exportBtn: 'Export canvas',
            shareBtn: 'Share canvas',
        };

        expect(pageTitle.tagName).toBe('H1');
        expect(pageTitle.textContent.trim()).toBe('Canvas');
        expect(document.querySelectorAll('h1')).toHaveLength(1);

        Object.entries(expectedLabels).forEach(([id, label]) => {
            const button = document.getElementById(id);

            expect(button).not.toBeNull();
            expect(button.getAttribute('type')).toBe('button');
            expect(button.getAttribute('aria-label')).toBe(label);
            button.querySelectorAll('svg').forEach((svg) => {
                expect(svg.getAttribute('aria-hidden')).toBe('true');
            });
        });

        expect(document.getElementById('topModelSelect').getAttribute('aria-label')).toBe('Select AI model');
        expect(document.querySelector('.model-icon').getAttribute('aria-hidden')).toBe('true');
        expect(document.getElementById('enterpriseModeBtn').getAttribute('aria-pressed')).toBe('false');
    });

    test('labels the visible Canvas AI composer input', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const aiInput = dom.window.document.getElementById('aiInput');

        expect(aiInput.tagName).toBe('TEXTAREA');
        expect(aiInput.getAttribute('aria-label')).toBe('Ask Canvas AI to critique or edit the board');
        expect(aiInput.getAttribute('placeholder')).toContain('Ask for a critique');
    });

    test('keeps the focus workspace toggle pressed state synchronized', () => {
        const dom = new JSDOM('<button id="enterpriseModeBtn" type="button" aria-label="Toggle focus workspace" aria-pressed="false"></button>', {
            url: 'http://localhost:3000/canvas/',
        });
        const App = loadAppClass(dom);
        const app = Object.create(App.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        const button = document.getElementById('enterpriseModeBtn');

        app.enterpriseMode = true;
        app.updateEnterpriseButton();

        expect(button.classList.contains('active')).toBe(true);
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Toggle focus workspace');
        expect(button.title).toBe('Focus workspace active');

        app.enterpriseMode = false;
        app.updateEnterpriseButton();

        expect(button.classList.contains('active')).toBe(false);
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(button.getAttribute('aria-label')).toBe('Toggle focus workspace');
        expect(button.title).toBe('Toggle focus workspace');
    });

    test('opens as an accessible dialog and restores focus to the help button', () => {
        const { app } = createHelpModalHarness();
        const opener = document.getElementById('helpBtn');
        const modal = document.getElementById('helpModal');
        const close = document.getElementById('closeHelpModal');

        opener.focus();
        app.showHelpModal();

        expect(modal.classList.contains('active')).toBe(true);
        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(modal.getAttribute('aria-hidden')).toBe('false');
        expect(document.activeElement).toBe(close);

        app.hideHelpModal();

        expect(modal.classList.contains('active')).toBe(false);
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(document.activeElement).toBe(opener);
    });

    test('traps tab focus while the help dialog is open', () => {
        const { dom, app } = createHelpModalHarness();
        const close = document.getElementById('closeHelpModal');
        const extra = document.getElementById('helpExtraAction');

        app.showHelpModal();
        extra.focus();

        const forwardTab = new dom.window.KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        });
        extra.dispatchEvent(forwardTab);
        app.handleHelpModalKeydown(forwardTab);

        expect(forwardTab.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(close);

        const reverseTab = new dom.window.KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        close.dispatchEvent(reverseTab);
        app.handleHelpModalKeydown(reverseTab);

        expect(reverseTab.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(extra);
    });
});

describe('canvas templates modal accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('marks template cards as keyboard-reachable dialog actions', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const modal = dom.window.document.getElementById('templatesModal');
        const close = dom.window.document.getElementById('closeTemplates');
        const cards = Array.from(dom.window.document.querySelectorAll('.template-card'));

        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(modal.getAttribute('aria-describedby')).toBe('templatesModalDescription');
        expect(close.getAttribute('type')).toBe('button');
        expect(close.getAttribute('aria-label')).toBe('Close templates');
        expect(cards.length).toBe(8);
        cards.forEach((card) => {
            expect(card.tagName).toBe('BUTTON');
            expect(card.getAttribute('type')).toBe('button');
            expect(card.dataset.template).toBeTruthy();
        });
    });

    test('opens with focus, traps Tab, and restores focus after close', () => {
        const { dom, manager } = createTemplatesModalHarness();
        const opener = document.getElementById('templatesBtn');
        const modal = document.getElementById('templatesModal');
        const close = document.getElementById('closeTemplates');
        const lastCard = document.querySelector('[data-template="wireframe"]');

        opener.focus();
        manager.showTemplatesModal();

        expect(modal.classList.contains('active')).toBe(true);
        expect(modal.style.display).toBe('flex');
        expect(modal.getAttribute('aria-hidden')).toBe('false');
        expect(document.activeElement).toBe(close);

        const reverseTab = new dom.window.KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        close.dispatchEvent(reverseTab);
        manager.handleTemplatesModalKeydown(reverseTab);

        expect(reverseTab.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(lastCard);

        manager.hideTemplatesModal();

        expect(modal.classList.contains('active')).toBe(false);
        expect(modal.style.display).toBe('none');
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(document.activeElement).toBe(opener);
    });
});

describe('canvas tool group header accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('uses buttons with controlled regions for collapsible tool groups', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const headers = Array.from(dom.window.document.querySelectorAll('.tool-category-header'));

        expect(headers.length).toBeGreaterThan(0);
        headers.forEach((header) => {
            expect(header.tagName).toBe('BUTTON');
            expect(header.getAttribute('type')).toBe('button');
            expect(header.hasAttribute('onclick')).toBe(false);
            expect(header.getAttribute('aria-expanded')).toMatch(/^(true|false)$/);
            expect(dom.window.document.getElementById(header.getAttribute('aria-controls'))).not.toBeNull();
        });
    });

    test('syncs expanded state when a tool group header is toggled', () => {
        const { app } = createToolCategoryHarness();
        const category = document.querySelector('.tool-category');
        const header = document.querySelector('.tool-category-header');

        app.setupToolCategoryHeaders();
        header.click();

        expect(category.classList.contains('expanded')).toBe(false);
        expect(header.getAttribute('aria-expanded')).toBe('false');

        header.click();

        expect(category.classList.contains('expanded')).toBe(true);
        expect(header.getAttribute('aria-expanded')).toBe('true');
    });

    test('keeps direct tool dock pressed state aligned with the selected tool', () => {
        const dom = new JSDOM(`
            <button class="tool-dock-btn active" type="button" data-dock-tool="selection" aria-label="Select tool" aria-pressed="true"></button>
            <button class="tool-dock-btn" type="button" data-dock-group="shapes" aria-label="Open shape tools" aria-expanded="false"></button>
            <button class="tool-dock-btn" type="button" data-dock-tool="image" aria-label="Place image" aria-pressed="false"></button>
        `, { url: 'http://localhost:3000/canvas/' });
        const App = loadAppClass(dom);
        const app = Object.create(App.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        app.activeDockGroup = '';
        app.currentTool = 'selection';
        app.syncToolDockActive('image');

        const selection = document.querySelector('[data-dock-tool="selection"]');
        const image = document.querySelector('[data-dock-tool="image"]');
        const shapes = document.querySelector('[data-dock-group="shapes"]');

        expect(selection.getAttribute('aria-pressed')).toBe('false');
        expect(selection.classList.contains('active')).toBe(false);
        expect(image.getAttribute('aria-pressed')).toBe('true');
        expect(image.classList.contains('active')).toBe(true);
        expect(shapes.hasAttribute('aria-pressed')).toBe(false);
        expect(shapes.getAttribute('aria-expanded')).toBe('false');

        app.syncToolDockActive('selection');

        expect(selection.getAttribute('aria-pressed')).toBe('true');
        expect(image.getAttribute('aria-pressed')).toBe('false');
    });
});

describe('canvas AI mode toggle accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
        delete global.localStorage;
    });

    test('keeps radio state and roving focus aligned with the selected AI mode', () => {
        const { assistant } = createAIModeHarness();
        const chat = document.getElementById('chatModeBtn');
        const diagram = document.getElementById('diagramModeBtn');
        const image = document.getElementById('imageModeBtn');
        const diagramOptions = document.getElementById('diagramOptions');
        const imageOptions = document.getElementById('imageOptions');

        assistant.setMode('diagram');

        expect(chat.classList.contains('active')).toBe(false);
        expect(chat.getAttribute('aria-checked')).toBe('false');
        expect(chat.tabIndex).toBe(-1);
        expect(diagram.classList.contains('active')).toBe(true);
        expect(diagram.getAttribute('aria-checked')).toBe('true');
        expect(diagram.tabIndex).toBe(0);
        expect(image.getAttribute('aria-checked')).toBe('false');
        expect(diagramOptions.classList.contains('hidden')).toBe(false);
        expect(imageOptions.classList.contains('hidden')).toBe(true);

        assistant.setMode('image');

        expect(diagram.classList.contains('active')).toBe(false);
        expect(diagram.getAttribute('aria-checked')).toBe('false');
        expect(diagram.tabIndex).toBe(-1);
        expect(image.classList.contains('active')).toBe(true);
        expect(image.getAttribute('aria-checked')).toBe('true');
        expect(image.tabIndex).toBe(0);
        expect(diagramOptions.classList.contains('hidden')).toBe(true);
        expect(imageOptions.classList.contains('hidden')).toBe(false);
    });

    test('selects and focuses AI modes with radio-group navigation keys', () => {
        const { assistant } = createAIModeHarness();
        const App = loadAppClass(document.defaultView);
        const app = Object.create(App.prototype);
        const chat = document.getElementById('chatModeBtn');
        const diagram = document.getElementById('diagramModeBtn');
        const image = document.getElementById('imageModeBtn');
        window.aiAssistant = assistant;

        app.setupAIModeToggles();
        chat.focus();
        chat.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));

        expect(document.activeElement).toBe(diagram);
        expect(diagram.getAttribute('aria-checked')).toBe('true');

        diagram.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(image);
        expect(image.getAttribute('aria-checked')).toBe('true');

        image.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(chat);
        expect(chat.getAttribute('aria-checked')).toBe('true');
    });
});

describe('canvas saved-board shelf accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
        delete global.localStorage;
    });

    test('uses explicit visible actions and board-specific accessible names', () => {
        const { app } = createBoardShelfHarness();

        app.renderBoardShelf();

        expect(document.querySelector('[data-board-shelf-action="save-current"]').getAttribute('aria-label')).toBe('Save current board');
        expect(document.querySelector('[data-board-shelf-action="open"]').getAttribute('aria-label')).toBe('Open saved board Customer onboarding flow');
        expect(document.querySelector('[data-board-shelf-action="duplicate"]').textContent).toBe('Duplicate');
        expect(document.querySelector('[data-board-shelf-action="duplicate"]').getAttribute('aria-label')).toBe('Duplicate saved board Customer onboarding flow');
        expect(document.querySelector('[data-board-shelf-action="export"]').getAttribute('aria-label')).toBe('Export saved board Customer onboarding flow');
        expect(document.querySelector('[data-board-shelf-action="delete"]').textContent).toBe('Delete');
        expect(document.querySelector('[data-board-shelf-action="delete"]').getAttribute('aria-label')).toBe('Delete saved board Customer onboarding flow');
    });
});

describe('canvas top-bar dropdown accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
        delete global.localStorage;
    });

    test('keeps export menu expanded state in sync for click and Escape', () => {
        const { dom, app } = createDropdownHarness();
        const trigger = document.getElementById('exportBtn');
        const dropdown = document.getElementById('exportDropdown');

        app.setupEventListeners();
        trigger.click();

        expect(dropdown.classList.contains('active')).toBe(true);
        expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.getElementById('exportMenu').getAttribute('role')).toBe('menu');

        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(dropdown.classList.contains('active')).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    test('supports menu-style keyboard focus for top-bar dropdowns', () => {
        const { dom, app } = createDropdownHarness();
        const themeTrigger = document.getElementById('themePickerBtn');
        const themeDropdown = document.getElementById('themeDropdown');
        const themeItems = Array.from(document.querySelectorAll('#themeMenu [role="menuitem"]'));
        const exportTrigger = document.getElementById('exportBtn');
        const exportMenu = document.getElementById('exportMenu');
        const exportItems = Array.from(document.querySelectorAll('#exportMenu [role="menuitem"]'));

        app.setupEventListeners();

        expect(themeItems.map((item) => item.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);
        expect(exportItems.map((item) => item.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);

        themeTrigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        expect(themeDropdown.classList.contains('active')).toBe(true);
        expect(themeTrigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(themeItems[0]);
        expect(themeItems.map((item) => item.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

        document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'End',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement).toBe(themeItems[2]);
        expect(themeItems.map((item) => item.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);

        document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement).toBe(themeItems[0]);

        document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));
        expect(themeDropdown.classList.contains('active')).toBe(false);
        expect(themeTrigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(themeTrigger);
        expect(themeItems.map((item) => item.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);

        exportTrigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowUp',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement).toBe(exportItems[2]);

        exportMenu.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Home',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement).toBe(exportItems[0]);
        expect(exportItems.map((item) => item.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

        document.getElementById('afterDropdown').focus();
        expect(exportMenu.parentElement.classList.contains('active')).toBe(false);
        expect(exportTrigger.getAttribute('aria-expanded')).toBe('false');
        expect(exportItems.map((item) => item.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);
    });

    test('returns focus to top-bar dropdown triggers after menu item selection', async () => {
        const { dom, app } = createDropdownHarness();
        const themeTrigger = document.getElementById('themePickerBtn');
        const themeDropdown = document.getElementById('themeDropdown');
        const themeItem = document.querySelector('#themeMenu [data-theme="dark"]');
        const exportTrigger = document.getElementById('exportBtn');
        const exportDropdown = document.getElementById('exportDropdown');
        const exportItem = document.querySelector('#exportMenu [data-export="json"]');

        app.setupEventListeners();

        app.setDropdownOpen(themeDropdown, themeTrigger, true);
        themeItem.focus();
        themeItem.dispatchEvent(new dom.window.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
        }));

        expect(themeDropdown.classList.contains('active')).toBe(false);
        expect(themeTrigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(themeTrigger);

        app.setDropdownOpen(exportDropdown, exportTrigger, true);
        exportItem.focus();
        exportItem.dispatchEvent(new dom.window.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(exportDropdown.classList.contains('active')).toBe(false);
        expect(exportTrigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(exportTrigger);
        expect(dom.window.importExportManager.export).toHaveBeenCalledWith('json');
    });
});

describe('canvas export dialog accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('opens as a labeled modal and restores focus when closed', () => {
        const dom = new JSDOM('<button id="exportLauncher" type="button">Export</button>', {
            url: 'http://localhost:3000/canvas/',
        });
        const ImportExportManager = loadImportExportManagerClass(dom);
        const manager = new ImportExportManager();

        global.document = dom.window.document;
        global.window = dom.window;

        const launcher = document.getElementById('exportLauncher');
        launcher.focus();

        manager.showExportDialog();

        const dialog = document.getElementById('exportDialog');
        const closeButton = document.getElementById('closeExportDialog');

        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('exportDialogTitle');
        expect(document.getElementById('exportDialogTitle').textContent).toBe('Export Canvas');
        expect(closeButton.getAttribute('type')).toBe('button');
        expect(closeButton.getAttribute('aria-label')).toBe('Close export dialog');
        expect(document.activeElement).toBe(closeButton);

        dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(document.getElementById('exportDialog')).toBeNull();
        expect(document.activeElement).toBe(launcher);
    });
});

describe('canvas mobile panel accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('syncs mobile panel expanded state and restores focus when closed', () => {
        const { app } = createMobilePanelHarness();
        const toolToggle = document.getElementById('mobileToolbarToggle');
        const toolClose = document.getElementById('mobileToolbarClose');
        const toolbar = document.getElementById('toolbar');
        const propertiesToggle = document.getElementById('mobilePropertiesToggle');
        const propertiesClose = document.getElementById('mobilePropertiesClose');
        const propertiesPanel = document.getElementById('propertiesPanel');

        app.setupMobileControls();

        toolToggle.click();
        expect(toolbar.classList.contains('active')).toBe(true);
        expect(toolToggle.getAttribute('aria-expanded')).toBe('true');
        expect(toolToggle.getAttribute('aria-label')).toBe('Close tool dock');
        expect(toolToggle.title).toBe('Close tool dock');
        expect(propertiesPanel.classList.contains('active')).toBe(false);
        expect(propertiesToggle.getAttribute('aria-expanded')).toBe('false');

        toolClose.click();
        expect(toolbar.classList.contains('active')).toBe(false);
        expect(toolToggle.getAttribute('aria-expanded')).toBe('false');
        expect(toolToggle.getAttribute('aria-label')).toBe('Open tool dock');
        expect(toolToggle.title).toBe('Open tool dock');
        expect(document.activeElement).toBe(toolToggle);

        propertiesToggle.click();
        expect(propertiesPanel.classList.contains('active')).toBe(true);
        expect(propertiesToggle.getAttribute('aria-expanded')).toBe('true');
        expect(propertiesToggle.getAttribute('aria-label')).toBe('Close properties panel');
        expect(propertiesToggle.title).toBe('Close Properties');
        expect(toolbar.classList.contains('active')).toBe(false);
        expect(toolToggle.getAttribute('aria-expanded')).toBe('false');

        propertiesToggle.click();
        expect(propertiesPanel.classList.contains('active')).toBe(false);
        expect(propertiesToggle.getAttribute('aria-expanded')).toBe('false');
        expect(propertiesToggle.getAttribute('aria-label')).toBe('Open properties panel');
        expect(propertiesToggle.title).toBe('Open Properties');

        propertiesToggle.click();
        propertiesClose.click();
        expect(propertiesPanel.classList.contains('active')).toBe(false);
        expect(propertiesToggle.getAttribute('aria-expanded')).toBe('false');
        expect(propertiesToggle.getAttribute('aria-label')).toBe('Open properties panel');
        expect(propertiesToggle.title).toBe('Open Properties');
        expect(document.activeElement).toBe(propertiesToggle);
    });
});

describe('canvas mini map toggle accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('ships the mini map toggle as a stateful panel control', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const toggle = dom.window.document.getElementById('miniMapToggle');
        const miniMap = dom.window.document.getElementById('miniMap');

        expect(toggle.getAttribute('type')).toBe('button');
        expect(toggle.getAttribute('aria-label')).toBe('Show mini map');
        expect(toggle.getAttribute('title')).toBe('Show mini map');
        expect(toggle.getAttribute('aria-controls')).toBe('miniMap');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(miniMap).not.toBeNull();
        expect(toggle.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
    });

    test('keeps mini map toggle labels and expanded state synchronized', () => {
        const { app } = createMiniMapHarness();
        const toggle = document.getElementById('miniMapToggle');
        const miniMap = document.getElementById('miniMap');

        app.setupMiniMap();

        expect(toggle.getAttribute('aria-label')).toBe('Show mini map');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        toggle.click();
        expect(miniMap.style.display).toBe('block');
        expect(toggle.classList.contains('active')).toBe(true);
        expect(toggle.getAttribute('aria-label')).toBe('Hide mini map');
        expect(toggle.getAttribute('title')).toBe('Hide mini map');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(app.updateMiniMap).toHaveBeenCalledTimes(1);

        toggle.click();
        expect(miniMap.style.display).toBe('none');
        expect(toggle.classList.contains('active')).toBe(false);
        expect(toggle.getAttribute('aria-label')).toBe('Show mini map');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
    });
});

describe('canvas workspace landmark accessibility', () => {
    test('names the drawing canvas main landmark', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const canvasContainer = dom.window.document.getElementById('canvasContainer');

        expect(canvasContainer.tagName).toBe('MAIN');
        expect(canvasContainer.getAttribute('aria-label')).toBe('Drawing canvas');
    });
});

describe('canvas command rail accessibility', () => {
    test('names every quick-command button, including icon-only shortcuts', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const buttons = Array.from(dom.window.document.querySelectorAll('.canvas-command-rail button'));

        expect(buttons.length).toBeGreaterThan(0);
        expect(buttons.map((button) => button.getAttribute('aria-label') || button.textContent.trim()))
            .toEqual([
                'Open canvas command palette',
                'Ask Canvas AI',
                'Add scene pack',
                'Connect selected objects',
            ]);
    });

    test('wires the command palette trigger and search to controlled regions', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const trigger = dom.window.document.getElementById('canvasCommandBtn');
        const palette = dom.window.document.getElementById('canvasCommandPalette');
        const search = dom.window.document.getElementById('canvasCommandSearch');
        const list = dom.window.document.getElementById('canvasCommandList');

        expect(trigger.getAttribute('aria-controls')).toBe('canvasCommandPalette');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(palette.getAttribute('role')).toBe('dialog');
        expect(search.getAttribute('aria-label')).toBe('Search canvas commands');
        expect(search.getAttribute('aria-controls')).toBe('canvasCommandList');
        expect(list.getAttribute('role')).toBe('listbox');
    });

    test('renders command options with stable accessible option state', () => {
        const dom = new JSDOM(`
            <button type="button" id="canvasCommandBtn" aria-expanded="false" aria-controls="canvasCommandPalette">Commands</button>
            <div id="canvasCommandPalette" hidden>
                <input id="canvasCommandSearch" type="search" aria-controls="canvasCommandList">
                <div id="canvasCommandList" role="listbox"></div>
            </div>
        `, { url: 'http://localhost:3000/canvas/' });
        const App = loadAppClass(dom);
        const app = Object.create(App.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        app.commandSearchValue = '';
        app.commandPaletteCommands = [{
            id: 'scene-pack',
            label: 'Scene Pack',
            meta: 'Three storyboard frames',
            group: 'Create',
            keywords: 'scene',
        }];
        app.getCanvasCommandSelection = jest.fn(() => []);

        app.renderCanvasCommandPalette();

        const option = document.querySelector('.canvas-command-item');
        expect(option.id).toBe('canvas-command-option-scene-pack');
        expect(option.getAttribute('role')).toBe('option');
        expect(option.getAttribute('aria-selected')).toBe('false');
        expect(option.dataset.commandId).toBe('scene-pack');

        delete global.document;
        delete global.window;
    });

    test('announces no-match command searches with useful recovery copy', () => {
        const dom = new JSDOM(`
            <button type="button" id="canvasCommandBtn" aria-expanded="false" aria-controls="canvasCommandPalette">Commands</button>
            <div id="canvasCommandPalette" hidden>
                <input id="canvasCommandSearch" type="search" aria-controls="canvasCommandList">
                <div id="canvasCommandList" role="listbox"></div>
            </div>
        `, { url: 'http://localhost:3000/canvas/' });
        const App = loadAppClass(dom);
        const app = Object.create(App.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        app.commandSearchValue = 'zebra';
        app.commandPaletteCommands = [{
            id: 'scene-pack',
            label: 'Scene Pack',
            meta: 'Three storyboard frames',
            group: 'Create',
            keywords: 'scene',
        }];
        app.getCanvasCommandSelection = jest.fn(() => []);

        app.renderCanvasCommandPalette();

        const empty = document.querySelector('.canvas-command-empty');
        expect(empty.getAttribute('role')).toBe('status');
        expect(empty.getAttribute('aria-live')).toBe('polite');
        expect(empty.textContent).toContain('No commands match "zebra"');
        expect(empty.textContent).toContain('Try AI, scene, Mermaid, or objects');

        delete global.document;
        delete global.window;
    });

    test('keeps command palette controls on theme-aware readable surfaces', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'enterprise.css'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(css).toMatch(/#canvasCommandClose\s*\{[^}]*background:\s*var\(--enterprise-panel-2\);/s);
        expect(css).toMatch(/\.canvas-command-search\s*\{[^}]*background:\s*var\(--enterprise-panel-2\);/s);
        expect(css).toMatch(/\.canvas-command-item\s*\{[^}]*background:\s*var\(--enterprise-panel-2\);/s);
        expect(html).toContain('css/enterprise.css?v=20260716a');
    });
});

describe('canvas side panel tabs accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('marks the properties panel switcher as real tabs and tabpanels', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const tablist = dom.window.document.querySelector('.canvas-panel-tabs');
        const tabs = Array.from(dom.window.document.querySelectorAll('[data-canvas-panel-tab]'));

        expect(tablist.getAttribute('role')).toBe('tablist');
        expect(tabs.map((tab) => tab.getAttribute('role'))).toEqual(['tab', 'tab', 'tab', 'tab']);
        expect(tabs.map((tab) => tab.getAttribute('aria-controls'))).toEqual([
            'canvasPanelInspector',
            'canvasPanelObjects',
            'canvasPanelCreative',
            'canvasPanelLibrary',
        ]);

        tabs.forEach((tab) => {
            const panel = dom.window.document.getElementById(tab.getAttribute('aria-controls'));
            expect(panel.getAttribute('role')).toBe('tabpanel');
            expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
        });

        expect(dom.window.document.getElementById('objectLibrarySearch').getAttribute('aria-label')).toBe('Find board objects');

        const objectFilters = dom.window.document.getElementById('objectFilterChips');
        expect(objectFilters.getAttribute('role')).toBe('group');
        expect(objectFilters.getAttribute('aria-label')).toBe('Filter board objects');
        expect(Array.from(objectFilters.querySelectorAll('button')).map((button) => button.getAttribute('aria-pressed')))
            .toEqual(['true', 'false', 'false', 'false']);
    });

    test('exposes the active board object filter', () => {
        const { dom, app } = createPanelTabsHarness();
        const filters = Array.from(document.querySelectorAll('[data-object-filter]'));

        app.setupCanvasSideRail();
        app.renderObjectLibrary.mockClear();
        filters[1].click();

        expect(app.objectLibraryFilter).toBe('drawing');
        expect(filters.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
        expect(filters.map((button) => button.classList.contains('active'))).toEqual([false, true, false]);
        expect(app.renderObjectLibrary).toHaveBeenCalledTimes(1);
    });

    test('supports arrow and edge-key tab navigation with roving focus', () => {
        const { dom, app } = createPanelTabsHarness();
        const inspector = document.getElementById('canvasPanelTabInspector');
        const objects = document.getElementById('canvasPanelTabObjects');
        const library = document.getElementById('canvasPanelTabLibrary');

        app.setupCanvasSideRail();
        inspector.focus();

        inspector.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowRight',
            bubbles: true,
            cancelable: true,
        }));

        expect(document.activeElement).toBe(objects);
        expect(objects.getAttribute('aria-selected')).toBe('true');
        expect(objects.getAttribute('tabindex')).toBe('0');
        expect(document.getElementById('canvasPanelObjects').hidden).toBe(false);
        expect(document.getElementById('canvasPanelInspector').hidden).toBe(true);

        objects.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'End',
            bubbles: true,
            cancelable: true,
        }));

        expect(document.activeElement).toBe(library);
        expect(library.getAttribute('aria-selected')).toBe('true');
        expect(document.getElementById('canvasPanelLibrary').hidden).toBe(false);
    });
});

describe('canvas advanced AI settings accessibility', () => {
    test('associates each visible generation label with its select', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const expectedLabels = {
            diagramModelSelect: 'AI Model',
            imageModelSelect: 'Image Model',
            imageSizeSelect: 'Size',
            imageQualitySelect: 'Quality',
            imageStyleSelect: 'Style',
        };

        Object.entries(expectedLabels).forEach(([selectId, labelText]) => {
            const select = dom.window.document.getElementById(selectId);
            const label = dom.window.document.querySelector(`label[for="${selectId}"]`);

            expect(select).not.toBeNull();
            expect(label).not.toBeNull();
            expect(label.textContent.trim()).toBe(labelText);
            expect(select.labels).toContain(label);
        });
    });
});

describe('canvas AI image placement guidance accessibility', () => {
    test('announces the transient instruction and names its dismiss control', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const tooltip = dom.window.document.getElementById('aiImageTooltip');
        const status = tooltip.querySelector('[role="status"]');
        const dismissButton = dom.window.document.getElementById('aiTooltipClose');

        expect(status.textContent.trim()).toBe('Click on canvas to place generated image');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.getAttribute('aria-atomic')).toBe('true');
        expect(dismissButton.type).toBe('button');
        expect(dismissButton.getAttribute('aria-label')).toBe('Dismiss image placement guidance');
    });
});

describe('canvas context menu accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('supports menu-style keyboard navigation and activation', () => {
        const { dom, app } = createContextMenuHarness();
        const menu = document.getElementById('canvasContextMenu');

        app.setupCanvasContextMenu();
        app.showCanvasContextMenu(40, 50, false);

        expect(menu.hidden).toBe(false);
        expect(menu.getAttribute('aria-label')).toBe('Canvas board actions');
        expect(document.activeElement.dataset.contextAction).toBe('tool:selection');
        expect(document.activeElement.getAttribute('tabindex')).toBe('0');
        expect(document.activeElement.getAttribute('aria-current')).toBe('true');

        menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement.dataset.contextAction).toBe('tool:text');
        expect(document.querySelector('[data-context-action="tool:selection"]').getAttribute('tabindex')).toBe('-1');
        expect(document.querySelector('[data-context-action="tool:selection"]').hasAttribute('aria-current')).toBe(false);
        expect(document.activeElement.getAttribute('aria-current')).toBe('true');

        menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'End',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement.dataset.contextAction).toBe('create:storyboard');

        menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));
        expect(app.runCanvasContextAction).toHaveBeenCalledWith('create:storyboard');

        app.showCanvasContextMenu(40, 50, true);
        expect(menu.getAttribute('aria-label')).toBe('Selected canvas object actions');
        expect(document.activeElement.dataset.contextAction).toBe('duplicate');

        menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowUp',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement.dataset.contextAction).toBe('ai:selection');

        menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));
        expect(menu.hidden).toBe(true);
    });
});

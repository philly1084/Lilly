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
        <button id="mobileToolbarToggle" type="button" aria-controls="toolbar" aria-expanded="false">Tools</button>
        <aside id="toolbar">
            <button id="mobileToolbarClose" type="button">Close tools</button>
            <button class="tool-dock-btn" type="button" data-dock-group="shapes">Shapes</button>
            <div class="tool-category" data-tool-group="shapes"></div>
        </aside>
        <button id="mobilePropertiesToggle" type="button" aria-controls="propertiesPanel" aria-expanded="false">Properties</button>
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

function createContextMenuHarness() {
    const dom = new JSDOM(`
        <div id="canvasContainer" tabindex="0"></div>
        <div id="canvasContextMenu" role="menu" hidden>
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

describe('canvas help modal accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
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

        themeTrigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        expect(themeDropdown.classList.contains('active')).toBe(true);
        expect(themeTrigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(themeItems[0]);

        document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'End',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement).toBe(themeItems[2]);

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
        expect(propertiesPanel.classList.contains('active')).toBe(false);
        expect(propertiesToggle.getAttribute('aria-expanded')).toBe('false');

        toolClose.click();
        expect(toolbar.classList.contains('active')).toBe(false);
        expect(toolToggle.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(toolToggle);

        propertiesToggle.click();
        expect(propertiesPanel.classList.contains('active')).toBe(true);
        expect(propertiesToggle.getAttribute('aria-expanded')).toBe('true');
        expect(toolbar.classList.contains('active')).toBe(false);
        expect(toolToggle.getAttribute('aria-expanded')).toBe('false');

        propertiesClose.click();
        expect(propertiesPanel.classList.contains('active')).toBe(false);
        expect(propertiesToggle.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(propertiesToggle);
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
        expect(document.activeElement.dataset.contextAction).toBe('tool:selection');

        menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement.dataset.contextAction).toBe('tool:text');

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

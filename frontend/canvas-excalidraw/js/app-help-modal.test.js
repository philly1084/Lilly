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
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.App;
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
                <button class="dropdown-item" type="button" role="menuitem" data-theme="dark">Dark</button>
            </div>
        </div>
        <div id="exportDropdown" class="dropdown">
            <button id="exportBtn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="exportMenu">Export</button>
            <div id="exportMenu" class="dropdown-menu" role="menu" aria-label="Export canvas">
                <button class="dropdown-item" type="button" role="menuitem" data-export="json">JSON</button>
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
});

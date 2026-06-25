const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadNotesApp() {
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body><button id="help-trigger">Help</button></body></html>', {
        url: 'http://localhost:3000/notes/',
    });
    const windowObject = dom.window;
    const context = {
        console,
        window: windowObject,
        document: windowObject.document,
        setInterval: jest.fn(() => 1),
        clearInterval: jest.fn(),
        setTimeout: jest.fn(),
        clearTimeout: jest.fn(),
        Blob,
        URL,
        API: { checkHealth: jest.fn(async () => ({ connected: false })) },
        Storage: {
            getCurrentPageId: jest.fn(() => null),
            getPages: jest.fn(() => []),
            getSettings: jest.fn(() => ({})),
        },
        Sidebar: { showToast: jest.fn(), init: jest.fn(), renderPages: jest.fn(), createNewPage: jest.fn() },
        Blocks: { init: jest.fn(), createBlock: jest.fn(() => document.createElement('div')) },
        Editor: {
            init: jest.fn(),
            createNewPage: jest.fn(),
            loadPage: jest.fn(),
            savePage: jest.fn(),
            getCurrentPage: jest.fn(() => ({ title: 'Untitled' })),
        },
        AgentUI: { init: jest.fn() },
        ImportExport: {},
        Mermaid: {},
        Chart: {},
        Selection: { init: jest.fn() },
        SlashMenu: { init: jest.fn() },
        KeyboardEvent: windowObject.KeyboardEvent,
    };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: 'app.js' });
    return { dom, NotesApp: windowObject.NotesApp };
}

describe('Notes help modal accessibility', () => {
    test('opens as a labelled modal dialog and returns focus when closed', () => {
        const { dom, NotesApp } = loadNotesApp();
        const trigger = dom.window.document.getElementById('help-trigger');
        trigger.focus();

        const modal = NotesApp.showHelp();
        const closeButton = modal.querySelector('[data-help-close]');

        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(modal.getAttribute('aria-labelledby')).toBe('notes-help-modal-title');
        expect(dom.window.document.getElementById('notes-help-modal-title').textContent).toBe('Keyboard Shortcuts');
        expect(closeButton.getAttribute('aria-label')).toBe('Close keyboard shortcuts');
        expect(dom.window.document.activeElement).toBe(closeButton);

        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
        }));

        expect(dom.window.document.querySelector('[data-help-modal="true"]')).toBeNull();
        expect(dom.window.document.activeElement).toBe(trigger);
    });
});

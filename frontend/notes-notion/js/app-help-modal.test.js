const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadNotesApp() {
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const dom = new JSDOM(`<!doctype html><html><body>
        <button id="help-trigger">Help</button>
        <div id="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" style="display: none;">
            <input id="command-palette-input" role="combobox" aria-label="Search commands" aria-controls="command-palette-results" aria-expanded="false" aria-autocomplete="list">
            <div id="command-palette-results" role="listbox" aria-label="Commands"></div>
        </div>
    </body></html>`, {
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
    windowObject.document.dispatchEvent(new windowObject.Event('DOMContentLoaded'));
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

describe('Notes command palette accessibility', () => {
    test('exposes the active command through combobox and listbox state', () => {
        const { dom, NotesApp } = loadNotesApp();
        const document = dom.window.document;
        const palette = document.getElementById('command-palette');
        const input = document.getElementById('command-palette-input');

        NotesApp.openCommandPalette();

        const options = [...document.querySelectorAll('[role="option"]')];
        expect(palette.style.display).toBe('flex');
        expect(palette.classList.contains('is-open')).toBe(true);
        expect(palette.classList.contains('is-hidden')).toBe(false);
        expect(input.getAttribute('aria-expanded')).toBe('true');
        expect(options.length).toBeGreaterThan(1);
        expect(options[0].getAttribute('aria-selected')).toBe('true');
        expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);

        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
        }));

        expect(options[0].getAttribute('aria-selected')).toBe('false');
        expect(options[1].getAttribute('aria-selected')).toBe('true');
        expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);

        NotesApp.closeCommandPalette();
        expect(palette.classList.contains('is-open')).toBe(false);
        expect(palette.classList.contains('is-hidden')).toBe(true);
        expect(input.getAttribute('aria-expanded')).toBe('false');
        expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    });
});

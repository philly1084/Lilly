const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadSidebarResizer({ collapsed = false } = {}) {
    const source = fs.readFileSync(path.join(__dirname, 'sidebar-resize.js'), 'utf8');
    const dom = new JSDOM(`
        <!doctype html>
        <html>
            <head></head>
            <body>
                <div id="app">
                    <aside id="sidebar"></aside>
                    <main id="main-content"></main>
                </div>
            </body>
        </html>
    `, {
        url: 'http://localhost:3000/web-chat/app.html',
        pretendToBeVisual: true,
    });

    const values = new Map();
    if (collapsed) {
        values.set('kimibuilt_sidebar_collapsed', '1');
    }

    const context = {
        document: dom.window.document,
        window: dom.window,
        console,
        lucide: { createIcons: jest.fn() },
    };

    context.window.sessionManager = {
        storageAvailable: true,
        safeStorageGet: jest.fn((key) => values.get(key) || null),
        safeStorageSet: jest.fn((key, value) => {
            values.set(key, String(value));
            return true;
        }),
    };

    vm.runInNewContext(source, context, { filename: 'sidebar-resize.js' });
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

    return {
        dom,
        resizer: dom.window.sidebarResizer,
        storage: values,
    };
}

describe('web-chat sidebar resize control', () => {
    test('announces collapse and expand state through the toggle button', () => {
        const { dom, resizer } = loadSidebarResizer();
        const button = dom.window.document.querySelector('.sidebar-collapse-btn');

        expect(button.getAttribute('aria-controls')).toBe('sidebar');
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Collapse sidebar');
        expect(button.getAttribute('title')).toBe('Collapse sidebar');

        resizer.collapse();

        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(button.getAttribute('aria-label')).toBe('Expand sidebar');
        expect(button.getAttribute('title')).toBe('Expand sidebar');

        resizer.expand();

        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Collapse sidebar');
    });

    test('injects visible keyboard focus styling for the collapse control', () => {
        const { dom } = loadSidebarResizer();
        const styles = dom.window.document.getElementById('sidebar-resize-styles').textContent;

        expect(styles).toContain('.sidebar-collapse-btn:focus-visible');
        expect(styles).toContain('outline: 2px solid var(--accent);');
        expect(styles).toContain('outline-offset: 3px;');
        expect(styles).toContain('box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);');
    });
});

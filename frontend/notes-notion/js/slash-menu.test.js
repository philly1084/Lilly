const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadSlashMenu({ width = 1024, height = 768, reducedMotion = false } = {}) {
    const source = fs.readFileSync(path.join(__dirname, 'slash-menu.js'), 'utf8');
    const dom = new JSDOM(`
        <!doctype html>
        <html>
            <body>
                <main id="editor"></main>
                <div id="slash-menu" role="listbox">
                    <div class="slash-menu-items">
                        <button class="slash-item" data-type="text"></button>
                        <button class="slash-item" data-type="heading_1"></button>
                        <button class="slash-item" data-type="quote"></button>
                    </div>
                </div>
            </body>
        </html>
    `, {
        url: 'http://localhost:3000/notes/',
    });

    Object.defineProperty(dom.window, 'innerWidth', {
        configurable: true,
        value: width,
    });
    Object.defineProperty(dom.window, 'innerHeight', {
        configurable: true,
        value: height,
    });
    dom.window.matchMedia = jest.fn().mockImplementation((query) => ({
        matches: query === '(prefers-reduced-motion: reduce)' ? reducedMotion : false,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
    }));

    const context = {
        console,
        window: dom.window,
        document: dom.window.document,
        setTimeout: (callback) => callback(),
        CustomEvent: dom.window.CustomEvent,
        Blocks: {
            getBlockTypes: () => ({
                text: {
                    name: 'Text',
                    hint: 'Plain paragraph',
                },
                heading_1: {
                    name: 'Heading 1',
                    hint: 'Big section heading',
                },
                quote: {
                    name: 'Quote',
                    hint: 'Capture a quote',
                },
            }),
        },
    };
    context.global = context;
    context.globalThis = context;

    vm.runInNewContext(source, context, { filename: 'slash-menu.js' });
    dom.window.HTMLElement.prototype.scrollIntoView = jest.fn();
    dom.window.SlashMenu.init();

    return { dom, SlashMenu: dom.window.SlashMenu };
}

describe('Notes slash menu positioning', () => {
    test('clamps width and x position inside a narrow mobile viewport', () => {
        const { dom, SlashMenu } = loadSlashMenu({ width: 280, height: 640 });
        const menu = dom.window.document.getElementById('slash-menu');

        SlashMenu.show(260, 120, 'block-1');

        expect(menu.style.left).toBe('16px');
        expect(menu.style.width).toBe('248px');
        expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(264);
    });

    test('places the menu above the cursor when lower viewport space is tight', () => {
        const { dom, SlashMenu } = loadSlashMenu({ width: 390, height: 360 });
        const menu = dom.window.document.getElementById('slash-menu');

        SlashMenu.show(120, 330, 'block-1');

        expect(menu.style.top).toBe('16px');
        expect(menu.style.maxHeight).toBe('328px');
    });

    test('exposes one active option when the menu opens', () => {
        const { dom, SlashMenu } = loadSlashMenu();
        const menu = dom.window.document.getElementById('slash-menu');
        const items = Array.from(menu.querySelectorAll('.slash-item'));

        SlashMenu.show(120, 120, 'block-1');

        expect(menu.getAttribute('aria-activedescendant')).toBe(items[0].id);
        expect(items.map((item) => item.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
        expect(items.map((item) => item.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    });

    test('supports Home and End keyboard movement through visible options', () => {
        const { dom, SlashMenu } = loadSlashMenu();
        const menu = dom.window.document.getElementById('slash-menu');
        const items = Array.from(menu.querySelectorAll('.slash-item'));

        SlashMenu.show(120, 120, 'block-1');
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));

        expect(menu.getAttribute('aria-activedescendant')).toBe(items[2].id);
        expect(items[2].getAttribute('aria-selected')).toBe('true');

        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));

        expect(menu.getAttribute('aria-activedescendant')).toBe(items[0].id);
        expect(items[0].getAttribute('aria-selected')).toBe('true');
    });

    test('uses instant option scrolling when reduced motion is requested', () => {
        const { dom, SlashMenu } = loadSlashMenu({ reducedMotion: true });
        const menu = dom.window.document.getElementById('slash-menu');
        const items = Array.from(menu.querySelectorAll('.slash-item'));

        SlashMenu.show(120, 120, 'block-1');
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));

        expect(menu.getAttribute('aria-activedescendant')).toBe(items[2].id);
        expect(items[2].scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
    });

    test('clears active option state when filtering has no matches', () => {
        const { dom, SlashMenu } = loadSlashMenu();
        const menu = dom.window.document.getElementById('slash-menu');
        const items = Array.from(menu.querySelectorAll('.slash-item'));

        SlashMenu.show(120, 120, 'block-1');
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', bubbles: true }));

        expect(menu.hasAttribute('aria-activedescendant')).toBe(false);
        expect(items.every((item) => item.classList.contains('hidden'))).toBe(true);
        expect(items.map((item) => item.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);
        expect(items.map((item) => item.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);
    });
});

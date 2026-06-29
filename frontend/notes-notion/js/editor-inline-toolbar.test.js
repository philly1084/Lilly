const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadEditor() {
    const source = fs.readFileSync(path.join(__dirname, 'editor.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://localhost:3000/notes/',
    });
    const windowObject = dom.window;
    const context = {
        console,
        window: windowObject,
        document: windowObject.document,
        setTimeout,
        clearTimeout,
        Date,
        Math,
        Blocks: {},
        Selection: {},
        SlashMenu: {},
        Storage: { getPages: jest.fn(() => []) },
        API: {},
        URL,
    };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: 'editor.js' });
    return { dom, Editor: windowObject.Editor };
}

describe('Notes inline toolbar accessibility', () => {
    test('renders generated formatting controls with explicit labels', () => {
        const { dom, Editor } = loadEditor();

        Editor.showInlineToolbar({
            getBoundingClientRect: () => ({
                left: 120,
                top: 120,
                width: 80,
                height: 20,
                right: 200,
                bottom: 140,
            }),
        });

        const toolbar = dom.window.document.querySelector('.inline-toolbar');
        expect(toolbar.getAttribute('role')).toBe('toolbar');
        expect(toolbar.getAttribute('aria-label')).toBe('Inline text formatting');

        const controls = Array.from(toolbar.querySelectorAll('button'));
        expect(controls).toHaveLength(11);
        expect(controls.map((button) => button.getAttribute('aria-label'))).toEqual([
            'Bold',
            'Italic',
            'Underline',
            'Strikethrough',
            'Yellow highlight',
            'Green highlight',
            'Blue highlight',
            'Purple highlight',
            'Pink highlight',
            'Create link',
            'Clear formatting',
        ]);
        expect(controls.every((button) => button.type === 'button')).toBe(true);
        expect(toolbar.querySelector('[data-cmd="bold"]').getAttribute('aria-keyshortcuts')).toBe('Control+B');
        expect(toolbar.querySelector('[data-cmd="createLink"]').getAttribute('aria-keyshortcuts')).toBe('Control+K');
        expect(Array.from(toolbar.querySelectorAll('svg')).every((svg) => svg.getAttribute('aria-hidden') === 'true')).toBe(true);
    });
});

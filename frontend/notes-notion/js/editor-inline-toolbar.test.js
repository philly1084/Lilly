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

function loadOutlineEditor(reduceMotion) {
    const source = fs.readFileSync(path.join(__dirname, 'editor.js'), 'utf8');
    const dom = new JSDOM(`<!doctype html><html><body>
        <main class="main-content">
            <div id="editor"></div>
            <div id="empty-state"></div>
        </main>
        <div id="page-outline-count"></div>
        <div id="page-outline-list"></div>
    </body></html>`, {
        url: 'http://localhost:3000/notes/',
    });
    const windowObject = dom.window;
    windowObject.matchMedia = jest.fn(() => ({ matches: reduceMotion }));
    windowObject.HTMLElement.prototype.scrollIntoView = jest.fn();

    const renderHeading = (block) => {
        const input = windowObject.document.createElement('div');
        input.className = 'block-input';
        input.contentEditable = 'true';
        input.textContent = block.content;
        return input;
    };
    const Blocks = {
        render: {
            heading_1: renderHeading,
            text: renderHeading,
        },
        getBlockTypes: jest.fn(() => ({})),
    };
    const Selection = {
        resetState: jest.fn(),
        setupDragAndDrop: jest.fn(),
        selectBlock: jest.fn(),
    };
    const SlashMenu = {
        show: jest.fn(),
        setCallback: jest.fn(),
    };
    const context = {
        console,
        window: windowObject,
        document: windowObject.document,
        setTimeout,
        clearTimeout,
        Date,
        Math,
        Blocks,
        Selection,
        SlashMenu,
        Storage: { getPages: jest.fn(() => []) },
        API: {},
        URL,
    };
    windowObject.Blocks = Blocks;
    windowObject.Selection = Selection;
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: 'editor.js' });

    windowObject.Editor.init();
    windowObject.Editor.loadPage({
        id: 'page-1',
        blocks: [{ id: 'heading-1', type: 'heading_1', content: 'Project plan' }],
    });

    return { dom, window: windowObject, SlashMenu };
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

describe('Notes outline motion preference', () => {
    test.each([
        [true, 'auto'],
        [false, 'smooth'],
    ])('uses %s reduced motion preference with %s scrolling', (reduceMotion, behavior) => {
        const { dom, window } = loadOutlineEditor(reduceMotion);
        const outlineItem = dom.window.document.querySelector('.outline-item');
        const heading = dom.window.document.querySelector('.block[data-block-id="heading-1"]');

        outlineItem.click();

        expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
        expect(heading.scrollIntoView).toHaveBeenCalledWith({ behavior, block: 'center' });
    });
});

describe('Notes block insertion controls', () => {
    test('renders named buttons and anchors keyboard-opened menus to the trigger', () => {
        const { dom, SlashMenu } = loadOutlineEditor(false);
        const rowButton = dom.window.document.querySelector('.block-add-btn');
        const betweenButton = dom.window.document.querySelector('.add-block-btn');

        expect(rowButton.tagName).toBe('BUTTON');
        expect(rowButton.type).toBe('button');
        expect(rowButton.getAttribute('aria-label')).toBe('Add block below');
        expect(betweenButton.tagName).toBe('BUTTON');
        expect(betweenButton.type).toBe('button');
        expect(betweenButton.getAttribute('aria-label')).toBe('Choose block type to add below');

        betweenButton.getBoundingClientRect = () => ({ left: 120, bottom: 240 });
        betweenButton.click();

        expect(SlashMenu.show).toHaveBeenCalledWith(120, 240, 'heading-1');
        expect(SlashMenu.setCallback).toHaveBeenCalledTimes(1);
    });
});

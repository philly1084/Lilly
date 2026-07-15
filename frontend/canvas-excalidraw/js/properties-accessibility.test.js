const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadPropertiesManager(dom) {
    const sourcePath = path.join(__dirname, 'properties.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /\/\/ Create global instance\s*window\.propertiesManager = new PropertiesManager\(\);\s*$/,
            'module.exports = { PropertiesManager };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        document: dom.window.document,
        window: dom.window,
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.PropertiesManager;
}

function createColorDom() {
    return new JSDOM(`
        <section id="strokeColorSection" class="color-section" data-target="stroke">
            <div id="strokeColorPicker">
                <button class="color-btn active" data-color="#000000" title="Black">
                    <span class="color-checkmark">✓</span>
                </button>
                <button class="color-btn" data-color="#1971c2" title="Blue">
                    <span class="color-checkmark">✓</span>
                </button>
            </div>
            <div class="color-picker-extended"></div>
        </section>
        <section id="backgroundColorSection" class="color-section" data-target="background">
            <div id="backgroundColorPicker">
                <button class="color-btn active transparent" data-color="transparent" title="Transparent"></button>
            </div>
            <div class="color-picker-extended"></div>
        </section>
        <div id="strokeColorPreview"></div>
        <div id="backgroundColorPreview"></div>
        <div id="strokeColorHistory"></div>
        <div id="backgroundColorHistory"></div>
    `, { url: 'http://localhost:3000/canvas/' });
}

describe('canvas color swatch accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('labels color swatches by target and hides decorative checkmarks', () => {
        const dom = createColorDom();
        dom.window.toolManager = {
            defaultProperties: {
                strokeColor: '#000000',
                backgroundColor: 'transparent',
            },
        };
        const PropertiesManager = loadPropertiesManager(dom);

        new PropertiesManager();

        const black = dom.window.document.querySelector('#strokeColorPicker [data-color="#000000"]');
        const blue = dom.window.document.querySelector('#strokeColorPicker [data-color="#1971c2"]');
        const transparent = dom.window.document.querySelector('#backgroundColorPicker [data-color="transparent"]');

        expect(black.getAttribute('aria-label')).toBe('Set stroke color to Black');
        expect(black.getAttribute('aria-pressed')).toBe('true');
        expect(blue.getAttribute('aria-label')).toBe('Set stroke color to Blue');
        expect(blue.getAttribute('aria-pressed')).toBe('false');
        expect(transparent.getAttribute('aria-label')).toBe('Set fill color to Transparent');
        expect(black.querySelector('.color-checkmark').getAttribute('aria-hidden')).toBe('true');
    });

    test('keeps color swatch pressed state synchronized when active color changes', () => {
        const dom = createColorDom();
        dom.window.toolManager = { defaultProperties: {} };
        const PropertiesManager = loadPropertiesManager(dom);
        const manager = new PropertiesManager();
        const black = dom.window.document.querySelector('#strokeColorPicker [data-color="#000000"]');
        const blue = dom.window.document.querySelector('#strokeColorPicker [data-color="#1971c2"]');

        manager.updateColorUI(blue, '#strokeColorPicker');

        expect(black.getAttribute('aria-pressed')).toBe('false');
        expect(blue.getAttribute('aria-pressed')).toBe('true');
    });
});

describe('canvas custom color input accessibility', () => {
    test('associates each visible custom color label with its input', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const document = dom.window.document;

        expect(document.querySelector('label[for="customStrokeColor"]')?.textContent.trim())
            .toBe('Custom stroke color');
        expect(document.querySelector('label[for="customBackgroundColor"]')?.textContent.trim())
            .toBe('Custom fill color');
        expect(document.getElementById('customStrokeColor')?.labels).toHaveLength(1);
        expect(document.getElementById('customBackgroundColor')?.labels).toHaveLength(1);
    });
});

describe('canvas grid snapping accessibility', () => {
    test('keeps the toggle pressed state synchronized with grid snapping', () => {
        const dom = new JSDOM(`
            <button id="snapToGridBtn" class="action-btn" type="button" aria-pressed="false">
                Snap to Grid
            </button>
        `);
        dom.window.infiniteCanvas = {
            snapToGrid: false,
            toggleSnapToGrid() {
                this.snapToGrid = !this.snapToGrid;
                return this.snapToGrid;
            },
        };
        const PropertiesManager = loadPropertiesManager(dom);

        new PropertiesManager();

        const button = dom.window.document.getElementById('snapToGridBtn');
        button.click();
        expect(button.classList.contains('active')).toBe(true);
        expect(button.getAttribute('aria-pressed')).toBe('true');

        button.click();
        expect(button.classList.contains('active')).toBe(false);
        expect(button.getAttribute('aria-pressed')).toBe('false');
    });
});

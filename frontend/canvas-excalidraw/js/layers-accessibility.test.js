const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadLayersManager(dom) {
    const sourcePath = path.join(__dirname, 'layers.js');
    const source = fs.readFileSync(sourcePath, 'utf8').replace(
        /\/\/ Create global instance\s*window\.layersManager = new LayersManager\(\);\s*$/,
        'module.exports = { Layer, LayersManager };'
    );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        document: dom.window.document,
        window: dom.window,
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.LayersManager;
}

describe('Canvas layer accessibility', () => {
    test('exposes layer state and supports keyboard activation', () => {
        const dom = new JSDOM('<div id="layersList" aria-label="Canvas layers"></div>');
        const LayersManager = loadLayersManager(dom);
        const manager = Object.create(LayersManager.prototype);
        manager.layers = [
            { id: 'base', name: 'Background', visible: true, locked: false },
            { id: 'notes', name: 'Notes', visible: false, locked: true },
        ];
        manager.activeLayerId = 'base';

        manager.renderLayersList();

        const rows = dom.window.document.querySelectorAll('.layer-item');
        expect(rows).toHaveLength(2);
        expect(rows[0].getAttribute('role')).toBe('button');
        expect(rows[0].getAttribute('tabindex')).toBe('0');
        expect(rows[0].getAttribute('aria-pressed')).toBe('false');
        expect(rows[0].getAttribute('aria-label')).toBe('Notes, activate layer');
        expect(rows[0].querySelector('.layer-visibility').getAttribute('aria-label')).toBe('Show Notes');
        expect(rows[0].querySelector('.layer-lock').getAttribute('aria-label')).toBe('Unlock Notes');
        expect(rows[0].querySelector('.layer-name').getAttribute('aria-label')).toBe('Layer name: Notes');

        rows[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        expect(manager.activeLayerId).toBe('notes');
        expect(dom.window.document.querySelector('[data-layer-id="notes"]').getAttribute('aria-pressed')).toBe('true');
    });
});

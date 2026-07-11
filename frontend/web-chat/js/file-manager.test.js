const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadFileManager() {
    const source = fs.readFileSync(path.join(__dirname, 'file-manager.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://localhost:3000/web-chat/app.html',
        pretendToBeVisual: true,
    });

    const context = {
        document: dom.window.document,
        window: dom.window,
        console,
        fetch: jest.fn(),
        setTimeout,
        clearTimeout,
        Blob: dom.window.Blob,
        URL: {
            createObjectURL: jest.fn(() => 'blob:file'),
            revokeObjectURL: jest.fn(),
        },
        lucide: { createIcons: jest.fn() },
    };

    context.window.sessionManager = {
        currentSessionId: 'session-1',
        addEventListener: jest.fn(),
        isLocalSession: jest.fn(() => false),
    };

    vm.runInNewContext(`${source}\nwindow.__fileManager = fileManager;`, context, {
        filename: 'file-manager.js',
    });

    return {
        dom,
        fileManager: context.window.__fileManager,
    };
}

describe('web-chat file manager selection controls', () => {
    test('announces selected download availability through the footer button', () => {
        const { dom, fileManager } = loadFileManager();
        const button = dom.window.document.getElementById('file-download-selected-btn');
        const count = dom.window.document.getElementById('file-selection-count');

        fileManager.files = [];
        fileManager.updateSelectionInfo();

        expect(count.textContent).toBe('0 selected');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-label')).toBe('No files selected to download');
        expect(button.getAttribute('title')).toBe('No files selected to download');

        fileManager.files = [
            { id: 'artifact-1', filename: 'report.pdf', selected: true },
        ];
        fileManager.updateSelectionInfo();

        expect(count.textContent).toBe('1 selected');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-label')).toBe('Download selected file report.pdf');

        fileManager.files = [
            { id: 'artifact-1', filename: 'report.pdf', selected: true },
            { id: 'artifact-2', filename: 'chart.png', selected: true },
        ];
        fileManager.updateSelectionInfo();

        expect(count.textContent).toBe('2 selected');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-label')).toBe('Download 2 selected files');
        expect(button.getAttribute('title')).toBe('Download 2 selected files');
    });
});

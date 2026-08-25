const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadFileManager() {
    const source = fs.readFileSync(path.join(__dirname, 'file-manager.js'), 'utf8');
    const dom = new JSDOM(`<!doctype html><html><body>
        <button id="files-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="file-manager-modal">Files</button>
    </body></html>`, {
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
    test('exposes dialog state and returns focus to the Files trigger', async () => {
        const { dom, fileManager } = loadFileManager();
        const trigger = dom.window.document.getElementById('files-btn');
        const modal = dom.window.document.getElementById('file-manager-modal');
        const refresh = dom.window.document.getElementById('file-manager-refresh-btn');

        fileManager.loadFiles = jest.fn(async () => {});
        trigger.focus();
        await fileManager.open();

        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(modal.getAttribute('aria-labelledby')).toBe('file-manager-title');
        expect(modal.getAttribute('aria-hidden')).toBe('false');
        expect(dom.window.document.activeElement).toBe(refresh);

        fileManager.close();

        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(dom.window.document.activeElement).toBe(trigger);
    });

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

    test('names row action controls with the target filename', () => {
        const { dom, fileManager } = loadFileManager();

        fileManager.files = [
            {
                id: 'artifact-1',
                filename: 'demo "report".pdf',
                category: 'document',
                previewUrl: '/api/artifacts/artifact-1/preview',
                sizeBytes: 2048,
                createdAt: '2026-07-12T08:00:00.000Z',
                status: 'ready',
            },
        ];

        fileManager.renderFiles();

        const rowActions = dom.window.document.querySelectorAll('.file-item-actions .file-item-btn');
        expect(rowActions).toHaveLength(3);
        expect(rowActions[0].getAttribute('aria-label')).toBe('Download demo "report".pdf');
        expect(rowActions[0].getAttribute('title')).toBe('Download demo "report".pdf');
        expect(rowActions[1].getAttribute('aria-label')).toBe('Preview demo "report".pdf');
        expect(rowActions[1].getAttribute('title')).toBe('Preview demo "report".pdf');
        expect(rowActions[2].getAttribute('aria-label')).toBe('Delete demo "report".pdf');
        expect(rowActions[2].getAttribute('title')).toBe('Delete demo "report".pdf');
    });
});

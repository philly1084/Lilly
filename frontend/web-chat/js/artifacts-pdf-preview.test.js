const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadArtifactManager() {
    const sourcePath = path.join(__dirname, 'artifacts.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const context = {
        window: {
            location: {
                hostname: 'chat.example.test',
                protocol: 'https:',
                host: 'chat.example.test',
                href: 'https://chat.example.test/app.html',
            },
            KimiBuiltGatewaySSE: {},
            sessionManager: {
                currentSessionId: 'session-1',
                safeStorageGet: () => '',
            },
            apiClient: {
                getSessionId: () => 'session-1',
            },
        },
        document: {
            addEventListener: () => {},
            createElement: () => ({
                textContent: '',
                appendChild: () => {},
                remove: () => {},
            }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add: () => {}, remove: () => {} } },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        Blob,
        File: class File extends Blob {
            constructor(parts, name, options = {}) {
                super(parts, options);
                this.name = name;
            }
        },
        FormData: class FormData {},
        fetch: jest.fn(),
        setTimeout: () => 0,
        clearTimeout: () => {},
        console,
        URL,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(source, context);
    return context.window.artifactManager;
}

describe('web-chat artifact PDF previews', () => {
    test('does not auto-embed PDF preview iframes in artifact cards', () => {
        const artifactManager = loadArtifactManager();

        const markup = artifactManager.buildGalleryMarkup([{
            id: 'pdf-1',
            filename: 'report.pdf',
            format: 'pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            downloadUrl: '/api/artifacts/pdf-1/download',
            previewUrl: '/api/artifacts/pdf-1/preview',
        }]);

        expect(markup).toContain('Open Preview');
        expect(markup).not.toContain('artifact-html-preview');
        expect(markup).not.toContain('Loading page preview');
    });

    test('keeps inline previews for HTML artifacts', () => {
        const artifactManager = loadArtifactManager();

        const markup = artifactManager.buildGalleryMarkup([{
            id: 'html-1',
            filename: 'site.html',
            format: 'html',
            mimeType: 'text/html',
            sizeBytes: 2048,
            downloadUrl: '/api/artifacts/html-1/download',
            previewUrl: '/api/artifacts/html-1/preview',
        }]);

        expect(markup).toContain('artifact-html-preview');
        expect(markup).toContain('Loading page preview');
    });
});

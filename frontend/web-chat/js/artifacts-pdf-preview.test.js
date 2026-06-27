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
            createElement: () => {
                const element = {
                    textContent: '',
                    appendChild: () => {},
                    remove: () => {},
                };
                Object.defineProperty(element, 'innerHTML', {
                    get() {
                        return String(this.textContent || '')
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;');
                    },
                    set(value) {
                        this.textContent = String(value || '');
                    },
                });
                return element;
            },
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

    test('normalizes snake case artifact metadata before rendering cards', () => {
        const artifactManager = loadArtifactManager();

        const markup = artifactManager.buildGalleryMarkup([{
            artifact_id: 'html-snake-1',
            filename: 'generated-site.html',
            format: 'html',
            mime_type: 'text/html',
            size_bytes: 4096,
            download_url: '/api/artifacts/html-snake-1/download',
            preview_url: '/api/artifacts/html-snake-1/preview',
            sandbox_url: '/api/artifacts/html-snake-1/sandbox',
            bundle_download_url: '/api/artifacts/html-snake-1/bundle',
        }]);

        expect(markup).toContain('generated-site.html');
        expect(markup).toContain('Open Site');
        expect(markup).toContain('Bundle Zip');
        expect(markup).toContain('4.0 KB');
        expect(markup).toContain('html-snake-1');
        expect(markup).not.toContain('undefined');
    });

    test('hides uploaded artifact previews when PII preview suppression is flagged', () => {
        const artifactManager = loadArtifactManager();

        const markup = artifactManager.buildGalleryMarkup([{
            id: 'upload-1',
            filename: 'patients.csv',
            format: 'csv',
            mimeType: 'text/csv',
            sizeBytes: 1024,
            downloadUrl: '/api/artifacts/upload-1/download',
            previewUrl: '/api/artifacts/upload-1/preview',
            preview: {
                type: 'text',
                content: 'Jane Patient,123-45-6789',
            },
            metadata: {
                privacyPreviewSuppressed: true,
                piiCleansing: {
                    uploadPreviewSuppressed: true,
                },
            },
        }]);

        expect(markup).toContain('Preview hidden while PII protection is enabled');
        expect(markup).not.toContain('Open Preview');
        expect(markup).not.toContain('artifact-html-preview');
        expect(markup).not.toContain('Jane Patient');
        expect(markup).not.toContain('123-45-6789');
    });
});

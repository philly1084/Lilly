const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadNotationArtifactPanel() {
    const sourcePath = path.join(__dirname, 'artifacts.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const window = {
        location: {
            hostname: 'localhost',
            protocol: 'http:',
            host: 'localhost:3000',
        },
        NotationAPI: {
            sessionId: 'session-1',
            process: jest.fn((data) => data),
            processWS: jest.fn(() => true),
        },
    };
    const document = {
        addEventListener: jest.fn(),
        createElement: jest.fn(() => ({
            textContent: '',
            innerHTML: '',
            appendChild: jest.fn(),
        })),
        head: { appendChild: jest.fn() },
        getElementById: jest.fn(() => null),
    };
    const context = {
        window,
        document,
        fetch: jest.fn(),
        FormData: class FormData {},
        setTimeout: jest.fn(),
        console,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: sourcePath });

    return window.notationArtifactPanel;
}

describe('notation artifact metadata normalization', () => {
    test('normalizes snake_case session artifacts for rendering', () => {
        const panel = loadNotationArtifactPanel();

        const artifacts = panel.normalizeArtifacts([
            {
                artifact_id: 'notation-artifact-1',
                filename: 'notation-export.html',
                mime_type: 'text/html',
                size_bytes: 1536,
                download_url: '/api/artifacts/notation-artifact-1/download',
                preview_url: '/api/artifacts/notation-artifact-1/preview',
                sandbox_url: '/sandbox/notation-artifact-1/',
                bundle_download_url: '/api/artifacts/notation-artifact-1/bundle',
            },
            { filename: 'missing-id.pdf' },
        ]);

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'notation-artifact-1',
                artifactId: 'notation-artifact-1',
                filename: 'notation-export.html',
                format: 'html',
                mimeType: 'text/html',
                size: 1536,
                sizeBytes: 1536,
                downloadUrl: '/api/artifacts/notation-artifact-1/download',
                previewUrl: '/api/artifacts/notation-artifact-1/preview',
                sandboxUrl: '/sandbox/notation-artifact-1/',
                bundleDownloadUrl: '/api/artifacts/notation-artifact-1/bundle',
            }),
        ]);
    });

    test('extracts document artifacts from assistant metadata responses', () => {
        const panel = loadNotationArtifactPanel();

        const artifacts = panel.extractResponseArtifacts({
            assistantMetadata: {
                artifacts: [{
                    document_id: 'doc-notation-2',
                    filename: 'notation-export.pdf',
                    mime_type: 'application/pdf',
                    size_bytes: 2048,
                }],
            },
        });

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'doc-notation-2',
                artifactId: 'doc-notation-2',
                filename: 'notation-export.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 2048,
                downloadUrl: '/api/documents/doc-notation-2/download',
            }),
        ]);
    });
});

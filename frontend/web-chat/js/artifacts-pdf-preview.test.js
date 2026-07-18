const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadArtifactHarness(options = {}) {
    const sourcePath = path.join(__dirname, 'artifacts.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const showToast = options.showToast || jest.fn();
    const fetchImpl = options.fetchImpl || jest.fn();
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
            prompt: options.prompt || jest.fn(() => 'demo'),
            uiHelpers: { showToast },
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
        fetch: fetchImpl,
        uiHelpers: { showToast },
        setTimeout: () => 0,
        clearTimeout: () => {},
        console,
        URL,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(source, context);
    return {
        artifactManager: context.window.artifactManager,
        context,
        fetchImpl,
        showToast,
    };
}

function loadArtifactManager() {
    return loadArtifactHarness().artifactManager;
}

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => payload,
    };
}

describe('web-chat artifact cards and promotion', () => {
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

    test('renders Push to Web for a hydrated aggregate site bundle', () => {
        const artifactManager = loadArtifactManager();

        const markup = artifactManager.buildGalleryMarkup([{
            id: 'artifact-site-bundle',
            filename: 'website.zip',
            format: 'zip',
            mimeType: 'application/zip',
            sizeBytes: 8192,
            downloadUrl: '/api/artifacts/artifact-site-bundle/download',
            previewUrl: '/api/artifacts/artifact-site-bundle/preview',
            sandboxUrl: '/api/artifacts/artifact-site-bundle/sandbox',
            bundleDownloadUrl: '/api/artifacts/artifact-site-bundle/bundle',
        }]);

        expect(markup).toContain('Open Site');
        expect(markup).toContain('Bundle Zip');
        expect(markup).toContain('Push to Web');
        expect(markup).toContain("artifactManager.exportSiteToManagedApp('artifact-site-bundle')");
    });

    test('preflights final bytes and binds the accepted hash into Push to Web', async () => {
        const sourceSha256 = 'a'.repeat(64);
        const artifact = {
            id: 'artifact-site-bundle',
            filename: 'website.zip',
            format: 'zip',
            mimeType: 'application/zip',
            sizeBytes: 8192,
            downloadUrl: '/api/artifacts/artifact-site-bundle/download',
            previewUrl: '/api/artifacts/artifact-site-bundle/preview',
            bundleDownloadUrl: '/api/artifacts/artifact-site-bundle/bundle',
        };
        const order = [];
        const fetchImpl = jest.fn(async (url, options = {}) => {
            const parsed = new URL(url, 'https://chat.example.test');
            order.push(`${options.method || 'GET'} ${parsed.pathname}`);
            if (parsed.pathname === '/api/sessions/session-1/artifacts') {
                return jsonResponse({ artifacts: [artifact] });
            }
            if (parsed.pathname.endsWith('/managed-app/preflight')) {
                return jsonResponse({
                    artifactId: artifact.id,
                    contentEligible: true,
                    controlPlaneAvailable: true,
                    pushToWebEligible: true,
                    sha256: sourceSha256,
                    blockers: [],
                });
            }
            if (parsed.pathname.endsWith('/managed-app')) {
                return jsonResponse({
                    app: { appName: 'Canary site', publicHost: 'launch.demoserver2.buzz' },
                    publicHost: 'launch.demoserver2.buzz',
                }, 202);
            }
            throw new Error(`Unexpected request: ${parsed.pathname}`);
        });
        const prompt = jest.fn(() => {
            order.push('PROMPT');
            return 'launch';
        });
        const { artifactManager, showToast } = loadArtifactHarness({ fetchImpl, prompt });

        await artifactManager.refresh();
        await artifactManager.exportSiteToManagedApp(artifact.id);

        expect(order).toEqual([
            'GET /api/sessions/session-1/artifacts',
            'POST /api/artifacts/artifact-site-bundle/managed-app/preflight',
            'PROMPT',
            'POST /api/artifacts/artifact-site-bundle/managed-app',
        ]);
        const mutation = fetchImpl.mock.calls.find(([url]) => (
            new URL(url, 'https://chat.example.test').pathname.endsWith('/managed-app')
            && !new URL(url, 'https://chat.example.test').pathname.endsWith('/managed-app/preflight')
        ));
        expect(JSON.parse(mutation[1].body)).toEqual(expect.objectContaining({
            expectedSourceSha256: sourceSha256,
            publicHost: 'launch.demoserver2.buzz',
        }));
        expect(showToast).toHaveBeenCalledWith(
            'Checking final website bytes and deployment readiness...',
            'info',
        );
        expect(showToast).toHaveBeenCalledWith(
            'Queued Canary site for https://launch.demoserver2.buzz.',
            'success',
        );
    });

    test('surfaces a preflight blocker without prompting for a host or mutating an app', async () => {
        const artifact = {
            id: 'artifact-blocked-site',
            filename: 'blocked.zip',
            format: 'zip',
            mimeType: 'application/zip',
            previewUrl: '/api/artifacts/artifact-blocked-site/preview',
            bundleDownloadUrl: '/api/artifacts/artifact-blocked-site/bundle',
        };
        const fetchImpl = jest.fn(async (url) => {
            const parsed = new URL(url, 'https://chat.example.test');
            if (parsed.pathname === '/api/sessions/session-1/artifacts') {
                return jsonResponse({ artifacts: [artifact] });
            }
            if (parsed.pathname.endsWith('/managed-app/preflight')) {
                return jsonResponse({
                    contentEligible: false,
                    controlPlaneAvailable: true,
                    pushToWebEligible: false,
                    sha256: null,
                    blockers: [{
                        code: 'ARTIFACT_MANAGED_APP_UNSUPPORTED_BINARY_ASSETS',
                        message: 'Replace the unsupported binary asset before deployment.',
                    }],
                });
            }
            throw new Error(`Unexpected request: ${parsed.pathname}`);
        });
        const prompt = jest.fn(() => 'blocked');
        const { artifactManager, showToast } = loadArtifactHarness({ fetchImpl, prompt });

        await artifactManager.refresh();
        await artifactManager.exportSiteToManagedApp(artifact.id);

        expect(prompt).not.toHaveBeenCalled();
        expect(fetchImpl.mock.calls.filter(([url]) => (
            new URL(url, 'https://chat.example.test').pathname.endsWith('/managed-app')
        ))).toHaveLength(0);
        expect(showToast).toHaveBeenCalledWith(
            'Replace the unsupported binary asset before deployment.',
            'error',
        );
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

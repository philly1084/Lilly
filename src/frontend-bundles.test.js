const {
    buildFrontendBundleArtifact,
    normalizeFrontendMetadata,
    isComplexFrontendBundleRequest,
    readFrontendBundleArchive,
} = require('./frontend-bundles');

describe('frontend bundle styling safety net', () => {
    test('never emits a 22-byte empty zip for playable frontend bundles', () => {
        const artifact = buildFrontendBundleArtifact({ files: [] }, 'Recovered Scene');
        const entries = readFrontendBundleArchive(artifact.buffer);
        const indexHtml = entries.get('index.html').toString('utf8');
        const readme = entries.get('README.md').toString('utf8');

        expect(artifact.buffer.length).toBeGreaterThan(22);
        expect(indexHtml).toContain('Recovered Scene');
        expect(readme).toContain('python -m http.server 8000');
    });

    test('adds play instructions and image manifest files to site bundles', () => {
        const artifact = buildFrontendBundleArtifact({
            entry: 'index.html',
            files: [
                {
                    path: 'index.html',
                    language: 'html',
                    content: '<!DOCTYPE html><html><head><title>Gallery</title></head><body><img src="./assets/hero.jpg" alt="Hero"></body></html>',
                },
            ],
        }, 'Gallery', {
            imageReferences: [{
                url: './assets/hero.jpg',
                title: 'Hero',
                source: 'generated',
            }],
        });

        const entries = readFrontendBundleArchive(artifact.buffer);
        const readme = entries.get('README.md').toString('utf8');
        const manifest = JSON.parse(entries.get('assets/images.json').toString('utf8'));

        expect(readme).toContain('Play');
        expect(readme).toContain('http://localhost:8000/index.html');
        expect(readme).toContain('Promote');
        expect(readme).toContain('managed-app iterate');
        expect(manifest.images).toEqual([
            expect.objectContaining({
                src: './assets/hero.jpg',
                alt: 'Hero',
            }),
        ]);
    });

    test('adds a stylesheet file and links unstyled html pages', () => {
        const artifact = buildFrontendBundleArtifact({
            entry: 'index.html',
            files: [
                {
                    path: 'index.html',
                    language: 'html',
                    content: '<!DOCTYPE html><html><head><title>Ops</title></head><body><main data-dashboard-zone="hero"><h1>Ops</h1></main></body></html>',
                },
                {
                    path: 'reports/index.html',
                    language: 'html',
                    content: '<!DOCTYPE html><html><head><title>Reports</title></head><body><main><h1>Reports</h1></main></body></html>',
                },
            ],
        }, 'Ops Dashboard');

        const entries = readFrontendBundleArchive(artifact.buffer);
        const indexHtml = entries.get('index.html').toString('utf8');
        const reportsHtml = entries.get('reports/index.html').toString('utf8');
        const css = entries.get('styles.css').toString('utf8');

        expect(indexHtml).toContain('href="./styles.css"');
        expect(reportsHtml).toContain('href="../styles.css"');
        expect(css).toContain('kimibuilt bundle style safety net');
        expect(css).toContain('[data-dashboard-zone]');
    });

    test('fills an existing missing local stylesheet reference with fallback css', () => {
        const artifact = buildFrontendBundleArtifact({
            entry: 'index.html',
            files: [
                {
                    path: 'index.html',
                    language: 'html',
                    content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><main><h1>Ops</h1></main></body></html>',
                },
            ],
        }, 'Linked Stylesheet');

        const entries = readFrontendBundleArchive(artifact.buffer);
        const indexHtml = entries.get('index.html').toString('utf8');
        const css = entries.get('assets/site.css').toString('utf8');

        expect(indexHtml).toContain('href="assets/site.css"');
        expect(css).toContain('kimibuilt bundle style safety net');
    });

    test('treats 3D scene requests as bundle-worthy frontend work', () => {
        expect(isComplexFrontendBundleRequest('Build a sandboxed Three.js 3D scene in HTML')).toBe(true);
        expect(isComplexFrontendBundleRequest('Create an immersive WebGL particle scene')).toBe(true);
    });

    test('normalizes a frontend handoff qa plan for bundle-first canvas outputs', () => {
        const metadata = normalizeFrontendMetadata({
            title: 'Compact Canvas Demo',
            bundle: {
                files: [
                    {
                        path: 'index.html',
                        language: 'html',
                        content: '<!DOCTYPE html><html><head><title>Compact Canvas Demo</title></head><body><h1>Demo</h1></body></html>',
                    },
                ],
            },
            handoff: {
                summary: 'Bundle-first demo.',
            },
        }, 'Preview: bundle contains the runnable project.');

        expect(metadata.handoff.qaPlan).toEqual(expect.arrayContaining([
            expect.stringContaining('desktop and mobile screenshots'),
            expect.stringContaining('contrast'),
        ]));
        expect(metadata.handoff.fallbackGate).toEqual(expect.objectContaining({
            decision: 'ready',
            nextAction: expect.stringContaining('browser QA'),
        }));
        expect(metadata.bundle.files).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'index.html' }),
        ]));
    });

    test('preserves repair gates and game placeholder asset contracts in frontend handoff', () => {
        const metadata = normalizeFrontendMetadata({
            title: 'Playable Prototype',
            handoff: {
                fallbackGate: {
                    decision: 'redesign',
                    reason: 'The first pass reused a generic layout.',
                    nextAction: 'Change the information architecture before another build.',
                },
                placeholderAssets: [
                    {
                        role: 'enemy',
                        placeholder: 'red cone with patrol pulse',
                        replaces: 'final enemy model',
                        behavior: 'patrol and damage on contact',
                    },
                ],
            },
        }, '<!DOCTYPE html><html><head><title>Playable Prototype</title></head><body></body></html>');

        expect(metadata.handoff.fallbackGate).toEqual(expect.objectContaining({
            decision: 'redesign',
            reason: 'The first pass reused a generic layout.',
        }));
        expect(metadata.handoff.placeholderAssets).toEqual([
            expect.objectContaining({
                role: 'enemy',
                placeholder: 'red cone with patrol pulse',
                behavior: 'patrol and damage on contact',
            }),
        ]);
    });
});

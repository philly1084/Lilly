const {
    buildFrontendBundleArtifact,
    normalizeFrontendMetadata,
    isComplexFrontendBundleRequest,
    readFrontendBundleArchive,
    sanitizeFrontendHtmlContent,
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

    test('strips assistant notes inside fenced html bundle files', () => {
        const dirtyHtml = [
            '```html',
            'I pulled together a stronger Canada news set and wrote it as original article-style coverage.',
            'Sources used include AP, Statistics Canada, Canada.ca, and CRTC-related reporting.',
            '<!DOCTYPE html><html><head><title>Canada Ledger</title></head><body><main><h1>Canada Ledger</h1></main></body></html>',
            'This should remain a chat handoff, not page chrome.',
            '```',
        ].join('\n');

        const cleanHtml = sanitizeFrontendHtmlContent(dirtyHtml);
        expect(cleanHtml.trim()).toMatch(/^<!DOCTYPE html>/);
        expect(cleanHtml).toContain('<h1>Canada Ledger</h1>');
        expect(cleanHtml).not.toContain('Sources used include');
        expect(cleanHtml).not.toContain('chat handoff');

        const artifact = buildFrontendBundleArtifact({
            entry: 'index.html',
            files: [{ path: 'index.html', language: 'html', content: dirtyHtml }],
        }, 'Canada Ledger');
        const entries = readFrontendBundleArchive(artifact.buffer);
        const indexHtml = entries.get('index.html').toString('utf8');

        expect(indexHtml.trim()).toMatch(/^<!DOCTYPE html>/);
        expect(indexHtml).toContain('<h1>Canada Ledger</h1>');
        expect(indexHtml).not.toContain('I pulled together');
        expect(indexHtml).not.toContain('Sources used include');
    });

    test('strips apostrophe html fences and thought tags from bundle files', () => {
        const dirtyHtml = [
            'continued',
            '\'\'\'\'html',
            '<think>This hidden planning text should not be stored in the page.</think>',
            '<!DOCTYPE html><html><head><title>Clean Bundle</title></head><body><main><h1>Clean Bundle</h1></main></body></html>',
            '\'\'\'\'',
        ].join('\n');

        const cleanHtml = sanitizeFrontendHtmlContent(dirtyHtml);
        expect(cleanHtml.trim()).toMatch(/^<!DOCTYPE html>/);
        expect(cleanHtml).toContain('<h1>Clean Bundle</h1>');
        expect(cleanHtml).not.toContain('<think>');
        expect(cleanHtml).not.toContain('continued');
        expect(cleanHtml).not.toContain('\'\'\'\'html');

        const artifact = buildFrontendBundleArtifact({
            entry: 'index.html',
            files: [{ path: 'index.html', language: 'html', content: dirtyHtml }],
        }, 'Clean Bundle');
        const entries = readFrontendBundleArchive(artifact.buffer);
        const indexHtml = entries.get('index.html').toString('utf8');

        expect(indexHtml.trim()).toMatch(/^<!DOCTYPE html>/);
        expect(indexHtml).toContain('<h1>Clean Bundle</h1>');
        expect(indexHtml).not.toContain('hidden planning text');
        expect(indexHtml).not.toContain('\'\'\'\'html');
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

        expect(indexHtml).toContain('href="./assets/site.css"');
        expect(css).toContain('kimibuilt bundle style safety net');
    });

    test('rewrites root-relative local stylesheet links for artifact previews', () => {
        const artifact = buildFrontendBundleArtifact({
            entry: 'index.html',
            files: [
                {
                    path: 'index.html',
                    language: 'html',
                    content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main><h1>Ops</h1></main></body></html>',
                },
                {
                    path: 'reports/index.html',
                    language: 'html',
                    content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main><h1>Reports</h1></main></body></html>',
                },
                {
                    path: 'styles.css',
                    language: 'css',
                    content: 'body { color: #172033; background: #ffffff; }',
                },
            ],
        }, 'Linked Stylesheet');

        const entries = readFrontendBundleArchive(artifact.buffer);
        const indexHtml = entries.get('index.html').toString('utf8');
        const reportsHtml = entries.get('reports/index.html').toString('utf8');

        expect(indexHtml).toContain('href="./styles.css"');
        expect(indexHtml).not.toContain('href="/styles.css"');
        expect(reportsHtml).toContain('href="../styles.css"');
        expect(reportsHtml).not.toContain('href="/styles.css"');
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
                buildWorkbench: {
                    mode: 'agent-build-workbench',
                    phases: [
                        {
                            id: 'qa_gate',
                            name: 'QA Gate',
                            purpose: 'Decide whether the build needs repair or redesign.',
                            actions: ['Inspect preview', 'Classify fallback'],
                            exitCheck: 'Next action is explicit.',
                        },
                    ],
                    commands: [
                        {
                            name: 'attach_behavior_script',
                            purpose: 'Connects a script to generated placeholder objects.',
                            when: 'After object factories are created.',
                            args: ['factoryName', 'scriptName'],
                        },
                    ],
                    hookPoints: [
                        {
                            phase: 'assemble',
                            kind: 'function',
                            description: 'Generate placeholder objects when no real files are present.',
                            scriptOrFunction: 'createPlaceholderObjects',
                        },
                    ],
                    objectFactories: [
                        {
                            name: 'ThreatPlaceholderFactory',
                            purpose: 'Creates distinct objects for hazard roles.',
                            creates: 'cones, pulses, and patrol markers',
                            placeholderStrategy: 'varied silhouettes and behavior labels',
                        },
                    ],
                    qaGates: [
                        {
                            name: 'visual_quality_gate',
                            checks: ['desktop screenshot', 'mobile screenshot'],
                            onFail: 'redesign',
                        },
                    ],
                },
                designMoves: [
                    {
                        name: 'Threat Heat Dial',
                        purpose: 'Lets users feel operational risk changing instead of reading static KPIs.',
                        interaction: 'Drag the dial to change severity thresholds.',
                        effect: 'Panels compress, recolor, and reprioritize incidents.',
                        fallback: 'Use three severity buttons if drag interaction fails.',
                    },
                ],
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
        expect(metadata.handoff.buildWorkbench).toEqual(expect.objectContaining({
            mode: 'agent-build-workbench',
            phases: [
                expect.objectContaining({ name: 'QA Gate' }),
            ],
            commands: [
                expect.objectContaining({ name: 'attach_behavior_script' }),
            ],
            hookPoints: [
                expect.objectContaining({ scriptOrFunction: 'createPlaceholderObjects' }),
            ],
            objectFactories: [
                expect.objectContaining({ name: 'ThreatPlaceholderFactory' }),
            ],
            qaGates: [
                expect.objectContaining({ name: 'visual_quality_gate' }),
            ],
        }));
        expect(metadata.handoff.designMoves).toEqual([
            expect.objectContaining({
                name: 'Threat Heat Dial',
                effect: 'Panels compress, recolor, and reprioritize incidents.',
            }),
        ]);
        expect(metadata.handoff.placeholderAssets).toEqual([
            expect.objectContaining({
                role: 'enemy',
                placeholder: 'red cone with patrol pulse',
                behavior: 'patrol and damage on contact',
            }),
        ]);
    });
});

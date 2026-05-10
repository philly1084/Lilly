jest.mock('../middleware/validate', () => ({
    validate: () => (_req, _res, next) => next(),
}));

jest.mock('../session-store', () => ({
    sessionStore: {},
}));

jest.mock('../memory/memory-service', () => ({
    memoryService: {},
}));

jest.mock('../runtime-execution', () => ({
    executeConversationRuntime: jest.fn(),
    resolveConversationExecutorFlag: jest.fn(() => false),
}));

jest.mock('../ai-route-utils', () => ({
    buildInstructionsWithArtifacts: jest.fn(),
    maybeGenerateOutputArtifact: jest.fn(),
    resolveReasoningEffort: jest.fn(() => null),
}));

jest.mock('../admin/runtime-monitor', () => ({
    startRuntimeTask: jest.fn(() => ({ id: 'task-1' })),
    completeRuntimeTask: jest.fn(),
    failRuntimeTask: jest.fn(),
}));

const canvasRouter = require('./canvas');

const {
    buildCanvasInstructions,
    parseCanvasResponse,
    buildFrontendFallbackMetadata,
} = canvasRouter._private;

describe('/api/canvas helpers', () => {
    test('buildCanvasInstructions includes frontend bundle and handoff requirements', () => {
        const instructions = buildCanvasInstructions('frontend', '<section>Existing demo</section>');

        expect(instructions).toContain('DEMO WEBSITE FRONTEND');
        expect(instructions).toContain('metadata.bundle');
        expect(instructions).toContain('metadata.bundle.files as the source of truth');
        expect(instructions).toContain('do not duplicate the same multi-file project');
        expect(instructions).toContain('content field may be a short preview summary');
        expect(instructions).toContain('metadata.handoff');
        expect(instructions).toContain('qaPlan');
        expect(instructions).toContain('<frontend_format_router>');
        expect(instructions).toContain('documentation-site');
        expect(instructions).toContain('<impressive_frontend_website_standard>');
        expect(instructions).toContain('opened UI surfaces');
        expect(instructions).toContain('Existing demo');
    });

    test('buildCanvasInstructions injects dashboard template guidance for dashboard prompts', () => {
        const instructions = buildCanvasInstructions(
            'frontend',
            '',
            'Build an admin dashboard HTML for support operations',
        );

        expect(instructions).toContain('[Dashboard template catalog]');
        expect(instructions).toContain('metadata.dashboardTemplate');
        expect(instructions).toContain('data-dashboard-template');
    });

    test('buildCanvasInstructions includes recursive template store guidance when provided', () => {
        const instructions = buildCanvasInstructions(
            'document',
            '',
            'Create an executive brief',
            '[Reference pattern library]\n- Executive Brief [executive-brief]',
        );

        expect(instructions).toContain('[Reference pattern library]');
        expect(instructions).toContain('Executive Brief [executive-brief]');
    });

    test('parseCanvasResponse normalizes frontend metadata from structured JSON', () => {
        const parsed = parseCanvasResponse(JSON.stringify({
            content: '<!DOCTYPE html><html><head><title>Nova Demo</title></head><body><section id="hero"></section></body></html>',
            metadata: {
                frameworkTarget: 'react',
                bundle: {
                    files: [
                        {
                            path: 'styles.css',
                            language: 'css',
                            purpose: 'Shared styles',
                            content: 'body { color: black; }',
                        },
                    ],
                },
                handoff: {
                    summary: 'Split hero and CTA into React components.',
                    componentMap: [
                        { name: 'Hero', purpose: 'Top-level value proposition' },
                    ],
                    qaPlan: [
                        'Capture desktop and mobile screenshots.',
                    ],
                },
            },
            suggestions: ['Add a pricing section'],
        }), 'frontend');

        expect(parsed.content).toContain('<!DOCTYPE html>');
        expect(parsed.metadata).toMatchObject({
            type: 'frontend',
            title: 'Nova Demo',
            frameworkTarget: 'react',
            previewMode: 'iframe',
        });
        expect(parsed.metadata.bundle.files).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'index.html', language: 'html' }),
            expect.objectContaining({ path: 'styles.css', language: 'css' }),
        ]));
        expect(parsed.metadata.handoff.componentMap).toEqual([
            expect.objectContaining({ name: 'Hero' }),
        ]);
        expect(parsed.metadata.handoff.qaPlan).toEqual([
            'Capture desktop and mobile screenshots.',
        ]);
        expect(parsed.suggestions).toEqual(['Add a pricing section']);
    });

    test('parseCanvasResponse preserves short frontend content when bundle files hold the project', () => {
        const parsed = parseCanvasResponse(JSON.stringify({
            content: 'Preview: a compact ops dashboard with filters and charts.',
            metadata: {
                title: 'Ops Dashboard',
                frameworkTarget: 'static',
                bundle: {
                    entry: 'index.html',
                    files: [
                        {
                            path: 'index.html',
                            language: 'html',
                            purpose: 'Preview entry',
                            content: '<!DOCTYPE html><html><head><title>Ops Dashboard</title><link rel="stylesheet" href="./styles.css"></head><body><main><h1>Ops</h1></main><script src="./app.js"></script></body></html>',
                        },
                        {
                            path: 'styles.css',
                            language: 'css',
                            purpose: 'Shared styles',
                            content: 'body { color: #172033; background: #f8fafc; }',
                        },
                        {
                            path: 'app.js',
                            language: 'javascript',
                            purpose: 'Interactions',
                            content: 'document.body.dataset.ready = "true";',
                        },
                    ],
                },
                handoff: {
                    summary: 'Static dashboard prototype.',
                    integrationSteps: ['Move bundle files into the frontend app.'],
                },
            },
        }), 'frontend');

        expect(parsed.content).toBe('Preview: a compact ops dashboard with filters and charts.');
        expect(parsed.metadata.bundle.files).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'index.html', content: expect.stringContaining('<!DOCTYPE html>') }),
            expect.objectContaining({ path: 'styles.css' }),
            expect.objectContaining({ path: 'app.js' }),
        ]));
        expect(parsed.metadata.handoff.qaPlan).toEqual(expect.arrayContaining([
            expect.stringContaining('desktop and mobile screenshots'),
        ]));
    });

    test('buildFrontendFallbackMetadata creates a repo-handoff shell for raw html', () => {
        const metadata = buildFrontendFallbackMetadata('<!DOCTYPE html><html><body><h1>Orbit Launch</h1></body></html>');

        expect(metadata).toMatchObject({
            type: 'frontend',
            title: 'Orbit Launch',
            language: 'html',
            previewMode: 'iframe',
        });
        expect(metadata.bundle.files).toEqual([
            expect.objectContaining({
                path: 'index.html',
                language: 'html',
            }),
        ]);
        expect(metadata.handoff.integrationSteps.length).toBeGreaterThan(0);
    });
});

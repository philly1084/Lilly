const {
    buildActiveProjectPreviewUpdate,
    buildProjectMemoryUpdate,
    mergeProjectMemory,
    buildProjectMemoryInstructions,
} = require('./project-memory');

describe('project-memory', () => {
    test('captures urls from tool results and artifacts', () => {
        const update = buildProjectMemoryUpdate({
            userText: 'Use this reference https://example.com/spec and make a PDF.',
            assistantText: 'Created the file and used https://example.com/spec.',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'image-generate',
                    },
                },
                result: {
                    success: true,
                    toolId: 'image-generate',
                    data: {
                        data: [
                            { url: 'https://images.example.com/hero.png' },
                        ],
                        artifacts: [
                            {
                                id: 'artifact-2',
                                filename: 'generated-image-01.png',
                                format: 'png',
                                downloadUrl: '/api/artifacts/artifact-2/download',
                            },
                        ],
                    },
                },
                reason: 'Generate hero image',
            }],
            artifacts: [{
                id: 'artifact-1',
                filename: 'brief.html',
                format: 'html',
                downloadUrl: '/api/artifacts/artifact-1/download',
                metadata: {
                    sourcePrompt: 'Create an HTML brief from the research',
                    creativeDirection: 'Boardroom Brief',
                    creativeDirectionId: 'boardroom-brief',
                    themeSuggestion: 'executive',
                },
            }],
        });

        expect(update.urls.map((entry) => entry.url)).toEqual(expect.arrayContaining([
            'https://example.com/spec',
            'https://images.example.com/hero.png',
            '/api/artifacts/artifact-2/download',
        ]));
        expect(update.artifacts).toHaveLength(2);
        expect(update.artifacts.map((entry) => entry.id)).toEqual(expect.arrayContaining(['artifact-1', 'artifact-2']));
        expect(update.artifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'artifact-1',
                creativeDirection: 'Boardroom Brief',
                creativeDirectionId: 'boardroom-brief',
                themeSuggestion: 'executive',
            }),
        ]));
        expect(update.tasks[0].summary).toMatch(/Created the file/i);
    });

    test.each(['false', '0', 'no', 'off', 0])(
        'keeps failed tool handoffs out of project carryover memory for success=%p',
        (success) => {
            const toolEvents = [{
                toolCall: {
                    function: {
                        name: 'document-workflow',
                    },
                },
                result: {
                    success,
                    toolId: 'document-workflow',
                    data: {
                        previewUrl: 'https://failed.example.com/preview',
                        artifacts: [{
                            id: 'artifact-failed',
                            filename: 'partial-dashboard.html',
                            format: 'html',
                            downloadUrl: '/api/artifacts/artifact-failed/download',
                            previewUrl: '/api/artifacts/artifact-failed/preview',
                        }],
                    },
                },
            }];

            const update = buildProjectMemoryUpdate({
                assistantText: 'The dashboard build failed before verification.',
                toolEvents,
            });

            expect(update.tasks[0]).toEqual(expect.objectContaining({
                status: 'partial',
                artifactIds: [],
            }));
            expect(update.urls.map((entry) => entry.url)).not.toContain('https://failed.example.com/preview');
            expect(update.urls.map((entry) => entry.url)).not.toContain('/api/artifacts/artifact-failed/download');
            expect(update.artifacts).toEqual([]);
            expect(buildActiveProjectPreviewUpdate({ toolEvents })).toBeNull();
        },
    );

    test('promotes previewable HTML artifacts into an active project preview', () => {
        const activeProject = buildActiveProjectPreviewUpdate({
            assistantText: 'Created a dashboard preview.',
            artifacts: [{
                id: 'artifact-html-1',
                filename: 'dashboard.html',
                format: 'html',
                downloadUrl: '/api/artifacts/artifact-html-1/download',
                previewUrl: '/api/artifacts/artifact-html-1/preview',
                sandboxUrl: '/api/artifacts/artifact-html-1/sandbox',
            }],
        });

        expect(activeProject).toEqual(expect.objectContaining({
            type: 'sandbox',
            key: 'artifact:artifact-html-1',
            title: 'dashboard.html',
            status: 'live',
            previewUrl: '/api/artifacts/artifact-html-1/preview',
            sandboxUrl: '/api/artifacts/artifact-html-1/sandbox',
            url: '/api/artifacts/artifact-html-1/preview',
        }));
    });

    test('does not promote document previews into the website live view', () => {
        const activeProject = buildActiveProjectPreviewUpdate({
            assistantText: 'Created the deck.',
            artifacts: [{
                id: 'artifact-pptx-1',
                filename: 'launch-plan.pptx',
                format: 'pptx',
                downloadUrl: '/api/artifacts/artifact-pptx-1/download',
                previewUrl: '/api/artifacts/artifact-pptx-1/preview',
                sandboxUrl: '/api/artifacts/artifact-pptx-1/sandbox',
            }],
        });

        expect(activeProject).toBeNull();
    });

    test('merges and deduplicates project memory for prompt instructions', () => {
        const merged = mergeProjectMemory(
            {
                urls: [{ url: 'https://example.com/spec', source: 'user', kind: 'reference' }],
                artifacts: [{ id: 'artifact-1', filename: 'brief.html', format: 'html', downloadUrl: 'https://app.example.com/api/artifacts/artifact-1/download' }],
                tasks: [{ summary: 'Researched the brief structure.', status: 'completed', toolIds: ['web-search'] }],
            },
            {
                urls: [{ url: 'https://example.com/spec', source: 'assistant', kind: 'reference' }],
                tasks: [{ summary: 'Researched the brief structure.', status: 'completed', toolIds: ['web-search'] }],
            },
        );

        expect(merged.urls).toHaveLength(1);
        expect(merged.tasks).toHaveLength(1);

        const instructions = buildProjectMemoryInstructions({
            metadata: {
                projectMemory: merged,
            },
        });

        expect(instructions).toContain('[Project carryover memory]');
        expect(instructions).toContain('https://example.com/spec');
        expect(instructions).toContain('brief.html');
        expect(instructions).toContain('Researched the brief structure.');
        expect(instructions).toContain('artifact references, not guaranteed local workspace files');
    });

    test('surfaces up to twenty remembered image urls in session instructions', () => {
        const imageUrls = Array.from({ length: 22 }, (_entry, index) => ({
            url: `https://images.example.com/photo-${index + 1}.jpg`,
            source: 'tool',
            kind: 'image',
            title: `Photo ${index + 1}`,
        }));

        const instructions = buildProjectMemoryInstructions({
            metadata: {
                projectMemory: {
                    urls: imageUrls,
                    artifacts: [],
                    tasks: [],
                },
            },
        });

        expect(instructions).toContain('Remembered image URLs:');
        expect(instructions).toContain('https://images.example.com/photo-22.jpg');
        expect(instructions).toContain('https://images.example.com/photo-3.jpg');
        expect(instructions).not.toContain('https://images.example.com/photo-1.jpg');
        expect(instructions).not.toContain('https://images.example.com/photo-2.jpg');
    });
});

const { extractArtifactsFromToolEvents, mergeRuntimeArtifacts } = require('./runtime-artifacts');

describe('runtime artifact helpers', () => {
    test('extracts nested document-workflow artifacts from successful tool events', () => {
        const artifacts = extractArtifactsFromToolEvents([{
            toolCall: {
                function: {
                    name: 'document-workflow',
                },
            },
            result: {
                success: true,
                data: {
                    document: {
                        id: 'doc-1',
                        filename: 'mission-control.html',
                        mimeType: 'text/html',
                        downloadUrl: '/api/documents/doc-1/download',
                        metadata: { format: 'html' },
                    },
                },
            },
        }]);

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'doc-1',
                filename: 'mission-control.html',
                format: 'html',
                mimeType: 'text/html',
                downloadUrl: '/api/documents/doc-1/download',
            }),
        ]);
    });

    test('extracts deep-research presentation documents from successful tool events', () => {
        const artifacts = extractArtifactsFromToolEvents([{
            toolCall: {
                function: {
                    name: 'deep-research-presentation',
                },
            },
            result: {
                success: true,
                data: {
                    action: 'research_and_generate_presentation',
                    document: {
                        id: 'deck-1',
                        filename: 'pigeon-love-research.pptx',
                        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                        downloadUrl: '/api/documents/deck-1/download',
                        metadata: { format: 'pptx' },
                    },
                },
            },
        }]);

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'deck-1',
                filename: 'pigeon-love-research.pptx',
                format: 'pptx',
                mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                downloadUrl: '/api/documents/deck-1/download',
            }),
        ]);
    });

    test('extracts podcast video artifacts from successful tool events', () => {
        const artifacts = extractArtifactsFromToolEvents([{
            toolCall: {
                function: {
                    name: 'podcast',
                },
            },
            result: {
                success: true,
                data: {
                    video: {
                        artifactId: 'artifact-video-1',
                        filename: 'battery-breakdown.mp4',
                        mimeType: 'video/mp4',
                        downloadUrl: '/api/artifacts/artifact-video-1/download',
                    },
                },
            },
        }]);

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-video-1',
                filename: 'battery-breakdown.mp4',
                format: 'mp4',
                mimeType: 'video/mp4',
                downloadUrl: '/api/artifacts/artifact-video-1/download',
            }),
        ]);
    });

    test('extracts file-write mirrored artifacts from successful tool events', () => {
        const artifacts = extractArtifactsFromToolEvents([{
            toolCall: {
                function: {
                    name: 'file-write',
                },
            },
            result: {
                success: true,
                data: {
                    path: '/tmp/report.html',
                    artifact: {
                        id: 'artifact-file-write-1',
                        filename: 'report.html',
                        mimeType: 'text/html',
                        downloadUrl: '/api/artifacts/artifact-file-write-1/download',
                        previewUrl: '/api/artifacts/artifact-file-write-1/preview',
                    },
                },
            },
        }]);

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-file-write-1',
                filename: 'report.html',
                format: 'html',
                downloadUrl: '/api/artifacts/artifact-file-write-1/download',
                previewUrl: '/api/artifacts/artifact-file-write-1/preview',
            }),
        ]);
    });

    test('deduplicates runtime artifacts across tool and generated sources', () => {
        const merged = mergeRuntimeArtifacts(
            [{
                id: 'doc-1',
                filename: 'mission-control.html',
                mimeType: 'text/html',
                downloadUrl: '/api/documents/doc-1/download',
            }],
            [{
                id: 'doc-1',
                filename: 'mission-control.html',
                mimeType: 'text/html',
                downloadUrl: '/api/documents/doc-1/download',
            }, {
                id: 'artifact-2',
                filename: 'mission-control.pdf',
                mimeType: 'application/pdf',
                downloadUrl: '/api/artifacts/artifact-2/download',
            }],
        );

        expect(merged).toEqual([
            expect.objectContaining({ id: 'doc-1' }),
            expect.objectContaining({ id: 'artifact-2', format: 'pdf' }),
        ]);
    });

    test('backfills a default download URL for generated artifacts that omit one', () => {
        const merged = mergeRuntimeArtifacts([{
            id: 'artifact-3',
            filename: 'dashboard.html',
            mimeType: 'text/html',
        }]);

        expect(merged).toEqual([
            expect.objectContaining({
                id: 'artifact-3',
                filename: 'dashboard.html',
                format: 'html',
                downloadUrl: '/api/artifacts/artifact-3/download',
            }),
        ]);
    });

    test('preserves preview, sandbox, and bundle download urls for previewable site artifacts', () => {
        const merged = mergeRuntimeArtifacts([{
            id: 'artifact-site-1',
            filename: 'newsroom-preview.zip',
            mimeType: 'application/zip',
            previewUrl: '/api/artifacts/artifact-site-1/preview',
            sandboxUrl: '/api/artifacts/artifact-site-1/sandbox',
            bundleDownloadUrl: '/api/artifacts/artifact-site-1/bundle',
            metadata: {
                siteBundle: {
                    entry: 'index.html',
                    fileCount: 5,
                },
            },
        }]);

        expect(merged).toEqual([
            expect.objectContaining({
                id: 'artifact-site-1',
                previewUrl: '/api/artifacts/artifact-site-1/preview',
                sandboxUrl: '/api/artifacts/artifact-site-1/sandbox',
                bundleDownloadUrl: '/api/artifacts/artifact-site-1/bundle',
            }),
        ]);
    });

    test('extracts sandbox urls from sandbox tool artifacts', () => {
        const artifacts = extractArtifactsFromToolEvents([{
            toolCall: {
                function: {
                    name: 'code-sandbox',
                },
            },
            result: {
                success: true,
                data: {
                    artifact: {
                        id: 'artifact-site-2',
                        filename: 'site-demo.zip',
                        mimeType: 'application/zip',
                        downloadUrl: '/api/artifacts/artifact-site-2/download',
                        previewUrl: '/api/artifacts/artifact-site-2/preview',
                        sandboxUrl: '/api/artifacts/artifact-site-2/sandbox',
                        bundleDownloadUrl: '/api/artifacts/artifact-site-2/bundle',
                    },
                },
            },
        }]);

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-site-2',
                previewUrl: '/api/artifacts/artifact-site-2/preview',
                sandboxUrl: '/api/artifacts/artifact-site-2/sandbox',
                bundleDownloadUrl: '/api/artifacts/artifact-site-2/bundle',
            }),
        ]);
    });

    test('extracts document-workflow sandboxBuild artifacts for web-chat sandbox previews', () => {
        const artifacts = extractArtifactsFromToolEvents([{
            toolCall: {
                function: {
                    name: 'document-workflow',
                },
            },
            result: {
                success: true,
                data: {
                    action: 'generate-suite',
                    document: {
                        id: 'doc-text-1',
                        filename: 'brief.html',
                        mimeType: 'text/html',
                        downloadUrl: '/api/artifacts/doc-text-1/download',
                        previewUrl: '/api/artifacts/doc-text-1/preview',
                    },
                    sandboxBuild: {
                        mode: 'project',
                        artifact: {
                            id: 'artifact-sandbox-1',
                            filename: 'brief-sandbox.zip',
                            mimeType: 'application/zip',
                            downloadUrl: '/api/artifacts/artifact-sandbox-1/download',
                            previewUrl: '/api/artifacts/artifact-sandbox-1/preview',
                            sandboxUrl: '/api/artifacts/artifact-sandbox-1/sandbox',
                            bundleDownloadUrl: '/api/artifacts/artifact-sandbox-1/bundle',
                        },
                    },
                },
            },
        }]);

        expect(artifacts).toEqual([
            expect.objectContaining({ id: 'doc-text-1' }),
            expect.objectContaining({
                id: 'artifact-sandbox-1',
                filename: 'brief-sandbox.zip',
                sandboxUrl: '/api/artifacts/artifact-sandbox-1/sandbox',
                bundleDownloadUrl: '/api/artifacts/artifact-sandbox-1/bundle',
            }),
        ]);
    });
});

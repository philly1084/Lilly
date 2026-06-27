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

    test('omits superseded artifacts from runtime artifact merges', () => {
        const merged = mergeRuntimeArtifacts([
            {
                id: 'artifact-old',
                filename: 'sandbox-project-old.zip',
                mimeType: 'application/zip',
                downloadUrl: '/api/artifacts/artifact-old/download',
                metadata: {
                    hiddenFromArtifactList: true,
                    artifactLifecycle: {
                        state: 'superseded',
                        supersededByArtifactId: 'artifact-new',
                    },
                },
            },
            {
                id: 'artifact-new',
                filename: 'sandbox-project-new.zip',
                mimeType: 'application/zip',
                downloadUrl: '/api/artifacts/artifact-new/download',
            },
        ]);

        expect(merged).toEqual([
            expect.objectContaining({ id: 'artifact-new' }),
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

    test('preserves snake_case artifact byte counts from tool and store payloads', () => {
        const merged = mergeRuntimeArtifacts([{
            artifact_id: 'artifact-snake-1',
            filename: 'generated-brief.html',
            mime_type: 'text/html',
            size_bytes: 4312,
            download_url: '/api/artifacts/artifact-snake-1/download',
            preview_url: '/api/artifacts/artifact-snake-1/preview',
        }]);

        expect(merged).toEqual([
            expect.objectContaining({
                id: 'artifact-snake-1',
                filename: 'generated-brief.html',
                mimeType: 'text/html',
                size: 4312,
                sizeBytes: 4312,
                downloadUrl: '/api/artifacts/artifact-snake-1/download',
                previewUrl: '/api/artifacts/artifact-snake-1/preview',
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

    test('extracts snake_case nested artifact containers from gateway tool payloads', () => {
        const artifacts = extractArtifactsFromToolEvents([{
            tool_call: {
                function: {
                    name: 'document-workflow',
                },
            },
            result: {
                success: true,
                tool_id: 'document-workflow',
                data: {
                    sandbox_build: {
                        generated_artifacts: [{
                            artifact_id: 'artifact-snake-sandbox-1',
                            filename: 'brief-sandbox.zip',
                            mime_type: 'application/zip',
                            size_bytes: 8192,
                            download_url: '/api/artifacts/artifact-snake-sandbox-1/download',
                            preview_url: '/api/artifacts/artifact-snake-sandbox-1/preview',
                            sandbox_url: '/api/artifacts/artifact-snake-sandbox-1/sandbox',
                            bundle_download_url: '/api/artifacts/artifact-snake-sandbox-1/bundle',
                        }],
                    },
                },
            },
        }]);

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-snake-sandbox-1',
                filename: 'brief-sandbox.zip',
                mimeType: 'application/zip',
                sizeBytes: 8192,
                downloadUrl: '/api/artifacts/artifact-snake-sandbox-1/download',
                previewUrl: '/api/artifacts/artifact-snake-sandbox-1/preview',
                sandboxUrl: '/api/artifacts/artifact-snake-sandbox-1/sandbox',
                bundleDownloadUrl: '/api/artifacts/artifact-snake-sandbox-1/bundle',
            }),
        ]);
    });

    test('extracts artifacts from stringified JSON tool result payloads', () => {
        const artifacts = extractArtifactsFromToolEvents([{
            toolCall: {
                function: {
                    name: 'document-workflow',
                },
            },
            result: {
                success: true,
                data: JSON.stringify({
                    document: {
                        id: 'doc-json-1',
                        filename: 'serialized-brief.html',
                        mimeType: 'text/html',
                        downloadUrl: '/api/documents/doc-json-1/download',
                    },
                    sandboxBuild: {
                        artifact: {
                            id: 'artifact-json-sandbox-1',
                            filename: 'serialized-brief.zip',
                            mimeType: 'application/zip',
                            downloadUrl: '/api/artifacts/artifact-json-sandbox-1/download',
                            previewUrl: '/api/artifacts/artifact-json-sandbox-1/preview',
                            sandboxUrl: '/api/artifacts/artifact-json-sandbox-1/sandbox',
                            bundleDownloadUrl: '/api/artifacts/artifact-json-sandbox-1/bundle',
                        },
                    },
                }),
            },
        }]);

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'doc-json-1',
                filename: 'serialized-brief.html',
                format: 'html',
                downloadUrl: '/api/documents/doc-json-1/download',
            }),
            expect.objectContaining({
                id: 'artifact-json-sandbox-1',
                filename: 'serialized-brief.zip',
                format: 'zip',
                sandboxUrl: '/api/artifacts/artifact-json-sandbox-1/sandbox',
                bundleDownloadUrl: '/api/artifacts/artifact-json-sandbox-1/bundle',
            }),
        ]);
    });
});

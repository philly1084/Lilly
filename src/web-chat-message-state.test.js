const {
    buildArtifactSummary,
    buildFrontendAssistantMetadata,
    buildWebChatAssistantEnvelope,
    buildWebChatSessionMessages,
} = require('./web-chat-message-state');

describe('buildWebChatSessionMessages', () => {
    test('treats Mermaid artifacts as previewable files in the assistant summary', () => {
        expect(buildArtifactSummary([{
            id: 'artifact-mermaid-1',
            filename: 'system-flow.mmd',
            format: 'mermaid',
            downloadUrl: '/api/artifacts/artifact-mermaid-1/download',
        }])).toBe('Created system-flow.mmd. Preview and Download below.');
    });

    test('treats presentation artifacts as downloadable files in the assistant summary', () => {
        expect(buildArtifactSummary([{
            id: 'artifact-pptx-1',
            filename: 'research-deck.pptx',
            format: 'pptx',
            downloadUrl: '/api/documents/deck-1/download',
        }])).toBe('Created research-deck.pptx. Use Download below.');
    });

    test('normalizes snake_case artifact URLs before building summaries', () => {
        expect(buildArtifactSummary([{
            id: 'artifact-html-snake-1',
            filename: 'site-preview.html',
            format: 'html',
            download_url: '/api/artifacts/artifact-html-snake-1/download',
            preview_url: '/api/artifacts/artifact-html-snake-1/preview',
            sandbox_url: '/api/artifacts/artifact-html-snake-1/sandbox',
            bundle_download_url: '/api/artifacts/artifact-html-snake-1/bundle',
        }])).toBe('Created site-preview.html. Preview and Download below.');
    });

    test('stores artifacts inline on the assistant message without a separate gallery message', () => {
        const messages = buildWebChatSessionMessages({
            userText: 'Question first',
            assistantText: 'Answer second',
            artifacts: [{
                id: 'artifact-1',
                filename: 'report.pdf',
                format: 'pdf',
                downloadUrl: '/api/artifacts/artifact-1/download',
            }],
            timestamp: '2026-04-04T15:00:00.000Z',
        });

        expect(messages).toHaveLength(2);
        expect(messages.map((message) => message.role)).toEqual([
            'user',
            'assistant',
        ]);

        const timestamps = messages.map((message) => new Date(message.timestamp).getTime());
        expect(timestamps[0]).toBeLessThan(timestamps[1]);
        expect(messages[1].metadata.artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-1',
                filename: 'report.pdf',
                downloadUrl: '/api/artifacts/artifact-1/download',
            }),
        ]);
        expect(messages[1].content).toBe('Answer second');
        expect(messages[1].metadata.displayContent).toBeUndefined();
    });

    test('falls back to an artifact summary only when the assistant text is empty', () => {
        const messages = buildWebChatSessionMessages({
            userText: 'Make the deck.',
            assistantText: '',
            artifacts: [{
                id: 'artifact-pptx-2',
                filename: 'launch-plan.pptx',
                format: 'pptx',
                downloadUrl: '/api/documents/deck-2/download',
            }],
            timestamp: '2026-04-11T12:15:00.000Z',
        });

        expect(messages).toHaveLength(2);
        expect(messages[1].content).toBe('Created launch-plan.pptx. Use Download below.');
        expect(messages[1].metadata.displayContent).toBe('Created launch-plan.pptx. Use Download below.');
    });

    test('replaces the background placeholder with an artifact summary when files were created', () => {
        const messages = buildWebChatSessionMessages({
            userText: 'Make the Calgary guide.',
            assistantText: 'Working in background...',
            artifacts: [{
                id: 'artifact-html-2',
                filename: 'calgary-guide.html',
                format: 'html',
                downloadUrl: '/api/artifacts/artifact-html-2/download',
                previewUrl: '/api/artifacts/artifact-html-2/preview',
            }],
            timestamp: '2026-04-13T12:15:00.000Z',
        });

        expect(messages).toHaveLength(2);
        expect(messages[1].content).toBe('Created calgary-guide.html. Preview and Download below.');
        expect(messages[1].metadata.displayContent).toBe('Created calgary-guide.html. Preview and Download below.');
    });

    test('replaces raw generated HTML with the artifact summary when an HTML file was created', () => {
        const messages = buildWebChatSessionMessages({
            userText: 'Make a dogs photo gallery.',
            assistantText: 'html <!DOCTYPE html><html><head><title>Dogs</title></head><body><main>Gallery</main></body></html>',
            artifacts: [{
                id: 'artifact-html-dogs',
                filename: 'dogs-photo-gallery.html',
                format: 'html',
                downloadUrl: '/api/documents/artifact-html-dogs/download',
                previewUrl: '/api/artifacts/artifact-html-dogs/preview',
            }],
            timestamp: '2026-04-13T12:15:00.000Z',
        });

        expect(messages).toHaveLength(2);
        expect(messages[1].content).toBe('Created dogs-photo-gallery.html. Preview and Download below.');
        expect(messages[1].metadata.displayContent).toBe('Created dogs-photo-gallery.html. Preview and Download below.');
        expect(messages[1].content).not.toContain('<!DOCTYPE html>');
    });

    test('replaces save-as HTML prose with the artifact summary when an HTML file was created', () => {
        const messages = buildWebChatSessionMessages({
            userText: 'Make the skydiving research project.',
            assistantText: [
                'I can make it, but one verification step failed. Save this as `skydiving-research.html`.',
                '```html',
                '<!DOCTYPE html><html><head><title>Skydiving</title></head><body><main>Research</main></body></html>',
                '```',
            ].join('\n'),
            artifacts: [{
                id: 'artifact-html-skydiving',
                filename: 'skydiving-research.html',
                format: 'html',
                downloadUrl: '/api/artifacts/artifact-html-skydiving/download',
                previewUrl: '/api/artifacts/artifact-html-skydiving/preview',
            }],
            timestamp: '2026-04-13T12:15:00.000Z',
        });

        expect(messages).toHaveLength(2);
        expect(messages[1].content).toBe('Created skydiving-research.html. Preview and Download below.');
        expect(messages[1].content).not.toContain('```html');
    });

    test('stores checkpoint fallback display content as a bare survey fence without duplicated prose', () => {
        const messages = buildWebChatSessionMessages({
            userText: 'Please redesign the page.',
            assistantText: 'I need one decision before I continue.',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'user-checkpoint',
                        arguments: JSON.stringify({
                            title: 'Choose a direction',
                            question: 'What visual and functional style should the new HTML follow?',
                        }),
                    },
                },
                result: {
                    success: true,
                    toolId: 'user-checkpoint',
                    data: {
                        checkpoint: {
                            id: 'checkpoint-redesign-style',
                            title: 'Choose a direction',
                            question: 'What visual and functional style should the new HTML follow?',
                            preamble: 'I need one decision before I continue with the main work.',
                            options: [
                                { id: 'minimal-modern', label: 'Minimal Modern' },
                                { id: 'bold-tech', label: 'Bold Tech' },
                            ],
                        },
                    },
                },
            }],
            timestamp: '2026-04-05T12:00:00.000Z',
        });

        expect(messages[1].metadata.displayContent.trim().startsWith('```survey')).toBe(true);
        expect(messages[1].metadata.displayContent).toContain('"question": "What visual and functional style should the new HTML follow?"');
        expect(messages[1].metadata.displayContent).not.toContain('Choose an option below and I will continue from there.');
    });

    test('preserves frontend-safe assistant metadata for agent replies', () => {
        const messages = buildWebChatSessionMessages({
            userText: 'Sketch the system layout.',
            assistantText: '### Architecture\n\n- Gateway\n- Services',
            assistantMetadata: {
                agentExecutor: true,
                taskType: 'chat',
                displayContent: '```survey\n{"id":"checkpoint-1","question":"Pick one.","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}\n```',
                trace: { steps: 4 },
            },
            timestamp: '2026-04-05T12:30:00.000Z',
        });

        expect(messages[1].metadata).toEqual(expect.objectContaining({
            agentExecutor: true,
            taskType: 'chat',
            displayContent: expect.stringContaining('```survey'),
        }));
        expect(messages[1].metadata.trace).toBeUndefined();
    });

    test('derives survey display content from tool events when explicit display content is absent', () => {
        const metadata = buildFrontendAssistantMetadata({
            taskType: 'chat',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'user-checkpoint',
                    },
                },
                result: {
                    success: true,
                    toolId: 'user-checkpoint',
                    data: {
                        checkpoint: {
                            id: 'checkpoint-derive',
                            title: 'Quick test',
                            question: 'Which direction should we take?',
                            options: [
                                { id: 'a', label: 'A' },
                                { id: 'b', label: 'B' },
                            ],
                        },
                    },
                },
            }],
        });

        expect(metadata).toEqual(expect.objectContaining({
            taskType: 'chat',
            displayContent: expect.stringContaining('```survey'),
        }));
        expect(metadata.displayContent).toContain('"id": "checkpoint-derive"');
    });

    test('derives survey display content when a checkpoint tool result serializes its data', () => {
        const metadata = buildFrontendAssistantMetadata({
            toolEvents: [{
                toolCall: { function: { name: 'user-checkpoint' } },
                result: {
                    success: true,
                    toolId: 'user-checkpoint',
                    data: JSON.stringify({
                        checkpoint: {
                            id: 'checkpoint-string-result',
                            question: 'Which direction should we take?',
                            options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
                        },
                    }),
                },
            }],
        });

        expect(metadata.displayContent).toContain('```survey');
        expect(metadata.displayContent).toContain('"checkpoint-string-result"');
    });

    test('normalizes raw checkpoint JSON display content into a survey fence', () => {
        const metadata = buildFrontendAssistantMetadata({
            displayContent: JSON.stringify({
                id: 'checkpoint-mnnicelx',
                title: 'Choose a direction',
                question: 'Which branch should we continue from?',
                options: [
                    { id: 'dashboard-ui', label: 'Dashboard UI' },
                    { id: 'cluster-deployment', label: 'Cluster deployment' },
                ],
                steps: [
                    {
                        id: 'step-1',
                        question: 'Which branch should we continue from?',
                        inputType: 'choice',
                        options: '[truncated]',
                    },
                ],
            }),
        });

        expect(metadata.displayContent).toContain('```survey');
        expect(metadata.displayContent).toContain('"checkpoint-mnnicelx"');
    });

    test('does not wrap answer-like JSON with bullet response fields as a survey', () => {
        const answerPayload = JSON.stringify({
            question: 'Which pieces changed',
            choices: [
                'Backend display-content normalization',
                'Frontend plain-text survey inference',
                'Regression tests',
            ],
            summary: 'These are completed-work bullets, not user choices.',
        });
        const metadata = buildFrontendAssistantMetadata({
            displayContent: answerPayload,
        });

        expect(metadata.displayContent).toBe(answerPayload);
        expect(metadata.displayContent).not.toContain('```survey');
    });

    test('keeps assistant artifact metadata when HTML output is created', () => {
        const metadata = buildFrontendAssistantMetadata({
            taskType: 'chat',
            artifacts: [{
                id: 'artifact-html-1',
                filename: 'dashboard.html',
                format: 'html',
                downloadUrl: '/api/artifacts/artifact-html-1/download',
                previewUrl: '/api/artifacts/artifact-html-1/preview',
                sandboxUrl: '/api/artifacts/artifact-html-1/sandbox',
                bundleDownloadUrl: '/api/artifacts/artifact-html-1/bundle',
            }],
        });

        expect(metadata).toEqual(expect.objectContaining({
            taskType: 'chat',
            displayContent: 'Created dashboard.html. Preview and Download below.',
            artifacts: [
                expect.objectContaining({
                    id: 'artifact-html-1',
                    filename: 'dashboard.html',
                    downloadUrl: '/api/artifacts/artifact-html-1/download',
                    previewUrl: '/api/artifacts/artifact-html-1/preview',
                    sandboxUrl: '/api/artifacts/artifact-html-1/sandbox',
                    bundleDownloadUrl: '/api/artifacts/artifact-html-1/bundle',
                }),
            ],
        }));
    });

    test('keeps snake_case assistant artifact URLs in frontend metadata', () => {
        const metadata = buildFrontendAssistantMetadata({
            taskType: 'chat',
            artifacts: [{
                id: 'artifact-html-snake-2',
                filename: 'dashboard.html',
                format: 'html',
                download_url: '/api/artifacts/artifact-html-snake-2/download',
                preview_url: '/api/artifacts/artifact-html-snake-2/preview',
                sandbox_url: '/api/artifacts/artifact-html-snake-2/sandbox',
                bundle_download_url: '/api/artifacts/artifact-html-snake-2/bundle',
            }],
        });

        expect(metadata).toEqual(expect.objectContaining({
            taskType: 'chat',
            displayContent: 'Created dashboard.html. Preview and Download below.',
            artifacts: [
                expect.objectContaining({
                    id: 'artifact-html-snake-2',
                    filename: 'dashboard.html',
                    downloadUrl: '/api/artifacts/artifact-html-snake-2/download',
                    previewUrl: '/api/artifacts/artifact-html-snake-2/preview',
                    sandboxUrl: '/api/artifacts/artifact-html-snake-2/sandbox',
                    bundleDownloadUrl: '/api/artifacts/artifact-html-snake-2/bundle',
                }),
            ],
        }));
    });

    test('replaces artifact-link prose with a concise preview summary', () => {
        const messages = buildWebChatSessionMessages({
            userText: 'Turn this HTML into a presentation piece.',
            assistantText: [
                'Created the HTML site bundle artifact (frontend-demo-qn2o61.zip).',
                'Play it: /api/artifacts/c03d0e66-8b78-4ee5-8802-0f1a224f9265/preview',
                'Download ZIP: /api/artifacts/c03d0e66-8b78-4ee5-8802-0f1a224f9265/bundle',
            ].join('\n'),
            artifacts: [{
                id: 'c03d0e66-8b78-4ee5-8802-0f1a224f9265',
                filename: 'frontend-demo-qn2o61.zip',
                format: 'html',
                downloadUrl: '/api/artifacts/c03d0e66-8b78-4ee5-8802-0f1a224f9265/download',
                previewUrl: '/api/artifacts/c03d0e66-8b78-4ee5-8802-0f1a224f9265/preview',
                bundleDownloadUrl: '/api/artifacts/c03d0e66-8b78-4ee5-8802-0f1a224f9265/bundle',
            }],
            timestamp: '2026-05-10T14:00:00.000Z',
        });

        expect(messages).toHaveLength(2);
        expect(messages[1].content).toBe('Created frontend-demo-qn2o61.zip. Preview and Download below.');
        expect(messages[1].metadata.displayContent).toBe('Created frontend-demo-qn2o61.zip. Preview and Download below.');
        expect(messages[1].content).not.toContain('Play it:');
    });

    test('preserves Mermaid preview payloads for frontend rendering', () => {
        const metadata = buildFrontendAssistantMetadata({
            taskType: 'chat',
            artifacts: [{
                id: 'artifact-mermaid-2',
                filename: 'auth-flow.mmd',
                format: 'mermaid',
                downloadUrl: '/api/artifacts/artifact-mermaid-2/download',
                preview: {
                    type: 'text',
                    content: 'flowchart TD\nA[User] --> B[Login]',
                },
            }],
        });

        expect(metadata).toEqual(expect.objectContaining({
            taskType: 'chat',
            artifacts: [
                expect.objectContaining({
                    id: 'artifact-mermaid-2',
                    filename: 'auth-flow.mmd',
                    format: 'mermaid',
                    downloadUrl: '/api/artifacts/artifact-mermaid-2/download',
                    preview: expect.objectContaining({
                        type: 'text',
                        content: expect.stringContaining('flowchart TD'),
                    }),
                }),
            ],
        }));
    });

    test('preserves reasoning metadata for frontend rendering', () => {
        const metadata = buildFrontendAssistantMetadata({
            taskType: 'chat',
            reasoningSummary: 'Checked the request and chose the direct path.',
            reasoningAvailable: true,
        });

        expect(metadata).toEqual(expect.objectContaining({
            taskType: 'chat',
            reasoningSummary: 'Checked the request and chose the direct path.',
            reasoningAvailable: true,
        }));
    });

    test('suppresses manual search-result choices once verified research sources exist', () => {
        const { auxiliaryMessages } = buildWebChatAssistantEnvelope({
            parentMessageId: 'assistant-research-1',
            timestamp: '2026-04-11T12:00:00.000Z',
            toolEvents: [
                {
                    toolCall: {
                        function: {
                            name: 'web-search',
                            arguments: JSON.stringify({
                                query: 'latest AI chip news',
                            }),
                        },
                    },
                    result: {
                        success: true,
                        toolId: 'web-search',
                        data: {
                            query: 'latest AI chip news',
                            results: [
                                {
                                    title: 'AI chip demand surges',
                                    url: 'https://example.com/ai-chip-demand',
                                    snippet: 'Demand climbed after new accelerator launches.',
                                    source: 'Example News',
                                    publishedAt: '2026-04-10T00:00:00.000Z',
                                },
                            ],
                        },
                    },
                },
                {
                    toolCall: {
                        function: {
                            name: 'web-fetch',
                            arguments: JSON.stringify({
                                url: 'https://example.com/ai-chip-demand',
                            }),
                        },
                    },
                    result: {
                        success: true,
                        toolId: 'web-fetch',
                        data: {
                            url: 'https://example.com/ai-chip-demand',
                            title: 'AI chip demand surges',
                            body: '<main><p>AI chip demand climbed sharply after new accelerator launches.</p></main>',
                        },
                    },
                },
            ],
        });

        expect(auxiliaryMessages.find((message) => message.type === 'search-results')).toBeUndefined();
        expect(auxiliaryMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'research-sources',
                query: 'latest AI chip news',
                results: [
                    expect.objectContaining({
                        url: 'https://example.com/ai-chip-demand',
                        source: 'Example News',
                        excerpt: expect.stringContaining('AI chip demand climbed sharply'),
                    }),
                ],
            }),
        ]));
    });

    test('marks standalone search results as passive context for the agent', () => {
        const { auxiliaryMessages } = buildWebChatAssistantEnvelope({
            parentMessageId: 'assistant-research-2',
            timestamp: '2026-04-11T12:05:00.000Z',
            toolEvents: [
                {
                    toolCall: {
                        function: {
                            name: 'web-search',
                            arguments: JSON.stringify({
                                query: 'semiconductor supply chain',
                            }),
                        },
                    },
                    result: {
                        success: true,
                        toolId: 'web-search',
                        data: {
                            query: 'semiconductor supply chain',
                            results: [
                                {
                                    title: 'Supply chain outlook',
                                    url: 'https://example.com/supply-chain',
                                    snippet: 'Lead times improved in Q1.',
                                    source: 'Industry Journal',
                                },
                            ],
                        },
                    },
                },
            ],
        });

        expect(auxiliaryMessages).toEqual([
            expect.objectContaining({
                type: 'search-results',
                query: 'semiconductor supply chain',
                interactive: false,
                results: [
                    expect.objectContaining({
                        url: 'https://example.com/supply-chain',
                        source: 'Industry Journal',
                    }),
                ],
            }),
        ]);
    });
});

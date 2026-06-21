jest.mock('./artifact-store', () => ({
    artifactStore: {
        create: jest.fn(),
        updateProcessing: jest.fn(),
        markSupersededSandboxArtifacts: jest.fn(),
        listBySession: jest.fn(),
        findReusableExtractionBySha: jest.fn(),
        listAllWithSessions: jest.fn(),
        get: jest.fn(),
        delete: jest.fn(),
        deleteBySession: jest.fn(),
    },
}));

jest.mock('./artifact-renderer', () => ({
    renderArtifact: jest.fn(),
}));

jest.mock('../openai-client', () => ({
    createResponse: jest.fn(),
}));

jest.mock('../pii', () => ({
    sanitizeRuntimePayload: jest.fn(async (payload) => ({
        payload,
        changed: false,
        contextIds: [],
        replacements: [],
        policy: { enabled: false },
        modelFrame: null,
    })),
    rehydrateText: jest.fn(async (text) => ({
        text,
        restorations: [],
        enabled: false,
    })),
    resolvePiiPolicy: jest.fn(() => ({ enabled: false })),
}));

jest.mock('../unsplash-client', () => ({
    searchImages: jest.fn(),
    isConfigured: jest.fn(() => false),
}));

jest.mock('../memory/vector-store', () => ({
    vectorStore: {
        store: jest.fn(),
        deleteArtifact: jest.fn(),
    },
}));

jest.mock('../postgres', () => ({
    postgres: {
        enabled: true,
        initialize: jest.fn().mockResolvedValue(true),
        query: jest.fn().mockResolvedValue({ rows: [] }),
    },
}));

jest.mock('../asset-manager', () => ({
    assetManager: {
        upsertArtifact: jest.fn().mockResolvedValue(null),
        removeArtifact: jest.fn().mockResolvedValue(true),
        removeArtifactsForSession: jest.fn().mockResolvedValue(0),
    },
    buildAssetManagerInstructions: jest.fn(() => ''),
}));

jest.mock('../generated-file-artifacts', () => ({
    deleteLocalGeneratedArtifact: jest.fn(),
    deleteLocalGeneratedArtifactsBySession: jest.fn(),
    getLocalGeneratedArtifact: jest.fn(),
    isLocalGeneratedArtifactId: jest.fn(() => false),
    listLocalGeneratedArtifactsBySession: jest.fn().mockResolvedValue([]),
    persistGeneratedArtifactLocally: jest.fn(),
}));

const { artifactService, extractResponseText, resolveCompletedResponseText } = require('./artifact-service');
const { artifactStore } = require('./artifact-store');
const { assetManager } = require('../asset-manager');
const { postgres } = require('../postgres');
const { vectorStore } = require('../memory/vector-store');
const { renderArtifact } = require('./artifact-renderer');
const { createResponse } = require('../openai-client');
const { sanitizeRuntimePayload, rehydrateText, resolvePiiPolicy } = require('../pii');
const { searchImages, isConfigured } = require('../unsplash-client');
const { persistGeneratedArtifactLocally } = require('../generated-file-artifacts');
const { readFrontendBundleArchive } = require('../frontend-bundles');

describe('ArtifactService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sanitizeRuntimePayload.mockImplementation(async (payload) => ({
            payload,
            changed: false,
            contextIds: [],
            replacements: [],
            policy: { enabled: false },
            modelFrame: null,
        }));
        rehydrateText.mockImplementation(async (text) => ({
            text,
            restorations: [],
            enabled: false,
        }));
        resolvePiiPolicy.mockReturnValue({ enabled: false });
        postgres.enabled = true;
        isConfigured.mockReturnValue(false);
        persistGeneratedArtifactLocally.mockResolvedValue({
            id: 'artifact-local-1',
            sessionId: 'session-1',
            filename: 'test.txt',
            extension: 'txt',
            mimeType: 'text/plain',
            sizeBytes: 4,
            extractedText: 'test',
            previewHtml: '',
            metadata: { storage: 'local-fallback' },
            vectorizedAt: null,
        });
        artifactStore.create.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-1',
            filename: 'test.txt',
            extension: 'txt',
            mimeType: 'text/plain',
            sizeBytes: 4,
            extractedText: 'test',
            previewHtml: '',
            metadata: {},
            vectorizedAt: null,
        });
        artifactStore.updateProcessing.mockResolvedValue({
            id: 'artifact-1',
            sessionId: 'session-1',
            filename: 'test.txt',
            extension: 'txt',
            mimeType: 'text/plain',
            sizeBytes: 4,
            extractedText: 'test',
            previewHtml: '',
            metadata: {},
            vectorizedAt: null,
        });
        artifactStore.listBySession.mockResolvedValue([]);
        artifactStore.markSupersededSandboxArtifacts.mockResolvedValue([]);
        artifactStore.findReusableExtractionBySha.mockResolvedValue(null);
        artifactStore.listAllWithSessions.mockResolvedValue([]);
        artifactStore.get.mockResolvedValue(null);
        renderArtifact.mockResolvedValue({
            filename: 'out.html',
            format: 'html',
            mimeType: 'text/html',
            buffer: Buffer.from('<!DOCTYPE html><html><body>ok</body></html>'),
            extractedText: 'ok',
            previewHtml: '<!DOCTYPE html><html><body>ok</body></html>',
            metadata: { title: 'Test' },
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('ensures a backing session row exists before storing an artifact', async () => {
        await artifactService.createStoredArtifact({
            sessionId: 'session-1',
            direction: 'generated',
            sourceMode: 'chat',
            filename: 'test.txt',
            extension: 'txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('test'),
            extractedText: 'test',
            previewHtml: '',
            metadata: {},
            vectorize: false,
        });

        expect(postgres.initialize).toHaveBeenCalled();
        expect(postgres.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO sessions'),
            ['session-1', null, '{}'],
        );
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
        }));
        expect(assetManager.upsertArtifact).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'artifact-1' }),
            expect.objectContaining({ session: null }),
        );
    });

    test('marks earlier sandbox artifacts as superseded after storing a newer sandbox bundle', async () => {
        await artifactService.createStoredArtifact({
            sessionId: 'session-1',
            direction: 'generated',
            sourceMode: 'sandbox',
            filename: 'sandbox-project-new.zip',
            extension: 'zip',
            mimeType: 'application/zip',
            buffer: Buffer.from('test'),
            extractedText: 'test',
            previewHtml: '',
            metadata: { title: 'sandbox-project' },
            vectorize: false,
        });

        expect(artifactStore.markSupersededSandboxArtifacts).toHaveBeenCalledWith({
            sessionId: 'session-1',
            artifactId: 'artifact-1',
            title: 'sandbox-project',
        });
    });

    test('hides superseded sandbox artifacts from default session artifact lists', async () => {
        artifactStore.listBySession.mockResolvedValue([
            {
                id: 'old-sandbox',
                sessionId: 'session-1',
                direction: 'generated',
                sourceMode: 'sandbox',
                filename: 'sandbox-project-old.zip',
                extension: 'zip',
                mimeType: 'application/zip',
                sizeBytes: 100,
                extractedText: '',
                previewHtml: '',
                metadata: {
                    hiddenFromArtifactList: true,
                    artifactLifecycle: {
                        state: 'superseded',
                        supersededByArtifactId: 'new-sandbox',
                    },
                },
            },
            {
                id: 'new-sandbox',
                sessionId: 'session-1',
                direction: 'generated',
                sourceMode: 'sandbox',
                filename: 'sandbox-project-new.zip',
                extension: 'zip',
                mimeType: 'application/zip',
                sizeBytes: 200,
                extractedText: '',
                previewHtml: '<!doctype html><html></html>',
                metadata: { title: 'sandbox-project' },
            },
        ]);

        const visible = await artifactService.listSessionArtifacts('session-1');
        const all = await artifactService.listSessionArtifacts('session-1', { includeSuppressed: true });

        expect(visible.map((artifact) => artifact.id)).toEqual(['new-sandbox']);
        expect(all.map((artifact) => artifact.id)).toEqual(['old-sandbox', 'new-sandbox']);
    });

    test('falls back to local artifacts when Postgres storage is not configured', async () => {
        postgres.enabled = false;

        const artifact = await artifactService.createStoredArtifact({
            sessionId: 'session-1',
            direction: 'generated',
            sourceMode: 'chat',
            filename: 'research.html',
            extension: 'html',
            mimeType: 'text/html',
            buffer: Buffer.from('<!DOCTYPE html><html><body>ok</body></html>'),
            extractedText: 'ok',
            previewHtml: '<!DOCTYPE html><html><body>ok</body></html>',
            metadata: { title: 'Research' },
            vectorize: true,
        });

        expect(artifactStore.create).not.toHaveBeenCalled();
        expect(persistGeneratedArtifactLocally).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            filename: 'research.html',
            extension: 'html',
            mimeType: 'text/html',
            previewHtml: expect.stringContaining('<!DOCTYPE html>'),
        }));
        expect(artifact).toEqual(expect.objectContaining({
            id: 'artifact-local-1',
            metadata: expect.objectContaining({ storage: 'local-fallback' }),
        }));
    });

    test('returns uploaded text artifacts before deferred vectorization runs', async () => {
        jest.useFakeTimers();
        vectorStore.store.mockResolvedValue('point-1');
        const storedUpload = {
            id: 'artifact-1',
            sessionId: 'session-1',
            filename: 'kubota.csv',
            extension: 'csv',
            mimeType: 'text/csv',
            sizeBytes: 47,
            extractedText: 'model,notes KX040,hydraulic service interval',
            previewHtml: '<pre>model,notes KX040,hydraulic service interval</pre>',
            metadata: {},
            vectorizedAt: null,
        };
        artifactStore.create.mockResolvedValue(storedUpload);
        artifactStore.updateProcessing.mockResolvedValue(storedUpload);

        const artifact = await artifactService.uploadArtifact({
            sessionId: 'session-1',
            session: { id: 'session-1', metadata: { ownerId: 'phill' } },
            mode: 'chat',
            file: {
                filename: 'kubota.csv',
                mimeType: 'text/csv',
                buffer: Buffer.from('model,notes\nKX040,hydraulic service interval'),
            },
        });

        expect(artifact).toEqual(expect.objectContaining({
            id: 'artifact-1',
            filename: 'kubota.csv',
            vectorized: false,
        }));
        expect(vectorStore.store).not.toHaveBeenCalled();

        await jest.runOnlyPendingTimersAsync();

        expect(vectorStore.store).toHaveBeenCalledWith(
            'session-1',
            expect.stringContaining('hydraulic service interval'),
            expect.objectContaining({
                sourceKind: 'file',
                artifactId: 'artifact-1',
                filename: 'kubota.csv',
            }),
        );
    });

    test('reuses prior extracted text when an uploaded duplicate PDF extracts empty', async () => {
        const storedUpload = {
            id: 'artifact-duplicate',
            sessionId: 'session-1',
            filename: 'Resume-Philip-Asplin-Cognizant.pdf',
            extension: 'pdf',
            mimeType: 'application/pdf',
            sizeBytes: 64,
            extractedText: 'Recovered resume text from earlier upload',
            previewHtml: '<pre>Recovered resume text from earlier upload</pre>',
            metadata: {
                reusedExtractionFromArtifactId: 'artifact-prior',
            },
            vectorizedAt: null,
        };
        artifactStore.findReusableExtractionBySha.mockResolvedValue({
            id: 'artifact-prior',
            extractedText: 'Recovered resume text from earlier upload',
            previewHtml: '<pre>Recovered resume text from earlier upload</pre>',
        });
        artifactStore.create.mockResolvedValue(storedUpload);
        artifactStore.updateProcessing.mockResolvedValue(storedUpload);

        const artifact = await artifactService.uploadArtifact({
            sessionId: 'session-1',
            mode: 'chat',
            file: {
                filename: 'Resume-Philip-Asplin-Cognizant.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.4\n1 0 obj\nstream\nendstream\nendobj\ntrailer\nstartxref', 'latin1'),
            },
        });

        expect(artifactStore.findReusableExtractionBySha).toHaveBeenCalledWith(expect.any(String));
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            extractedText: 'Recovered resume text from earlier upload',
            previewHtml: '<pre>Recovered resume text from earlier upload</pre>',
            metadata: expect.objectContaining({
                reusedExtractionFromArtifactId: 'artifact-prior',
            }),
        }));
        expect(artifact).toEqual(expect.objectContaining({
            id: 'artifact-duplicate',
            preview: expect.objectContaining({
                content: '<pre>Recovered resume text from earlier upload</pre>',
            }),
        }));
    });

    test('extractResponseText handles direct output_text and mixed content item types', () => {
        expect(extractResponseText({
            output_text: 'Top-level answer',
        })).toBe('Top-level answer');

        expect(extractResponseText({
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'First part. ' },
                        { type: 'output_text', text: 'Second part.' },
                    ],
                },
            ],
        })).toBe('First part. Second part.');

        expect(extractResponseText({
            choices: [{
                message: {
                    parts: [{ text: 'Gemini parts answer' }],
                },
            }],
        })).toBe('Gemini parts answer');

        expect(extractResponseText({
            candidates: [{
                content: {
                    parts: [{ text: 'Gemini candidate answer' }],
                },
            }],
        })).toBe('Gemini candidate answer');
    });

    test('extractResponseText strips null bytes from wrapped model outputs', () => {
        expect(extractResponseText({
            choices: [{
                message: {
                    content: [
                        { type: 'think', think: 'hidden', encrypted: null },
                        { type: 'text', text: '{"output_text":"Hello\\u0000 world","finish_reason":"stop"}' },
                    ],
                },
            }],
        })).toBe('Hello world');
    });

    test('extractResponseText ignores reasoning parts when visible output is present', () => {
        expect(extractResponseText({
            output: [{
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'reasoning', text: 'Reasoning that should not become artifact content.' },
                    { type: 'output_text', text: '<!DOCTYPE html><html><body><main>Visible artifact</main></body></html>' },
                ],
            }],
        })).toBe('<!DOCTYPE html><html><body><main>Visible artifact</main></body></html>');
    });

    test('extractResponseText recovers provider text from reasoning-style fields', () => {
        expect(extractResponseText({
            choices: [{
                message: {
                    reasoning_content: 'Reasoning surfaced as final text',
                },
            }],
        })).toBe('Reasoning surfaced as final text');
    });

    test('resolveCompletedResponseText recovers the final answer when streaming deltas were missing', () => {
        const response = {
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Recovered final answer' },
                    ],
                },
            ],
        };

        expect(resolveCompletedResponseText('', response)).toBe('Recovered final answer');
        expect(resolveCompletedResponseText('Recovered', response)).toBe('Recovered final answer');
    });

    test('uses multi-pass generation for html-family artifacts', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Operations Runbook',
                        sections: [
                            { heading: 'Overview', purpose: 'Summarize the objective', keyPoints: ['Scope'], targetLength: 'short' },
                            { heading: 'Implementation', purpose: 'Explain the work', keyPoints: ['Steps'], targetLength: 'medium' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Operations Runbook',
                        sections: [
                            { heading: 'Overview', content: 'Overview content', level: 1 },
                            { heading: 'Implementation', content: 'Implementation content', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>Operations Runbook</h1></body></html>' }],
                }],
            });

        const result = await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-1', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a polished operations runbook for cluster setup.',
            format: 'pdf',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(createResponse).toHaveBeenCalledTimes(3);
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            format: 'pdf',
            title: 'Operations Runbook',
            content: expect.stringContaining('<html'),
        }));
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                generationStrategy: 'multi-pass',
                generationPasses: ['plan', 'expand', 'compose'],
                sectionCount: 2,
            }),
        }));
        expect(result.responseId).toBe('resp-compose');
    });

    test('restores PII placeholders before rendering generated PDF artifacts', async () => {
        sanitizeRuntimePayload.mockImplementationOnce(async (payload) => ({
            payload: {
                ...payload,
                input: 'Create a PDF for [[PII:EMAIL:ctx1]].',
            },
            changed: true,
            contextIds: ['ctx-1'],
            replacements: [{
                placeholder: '[[PII:EMAIL:ctx1]]',
                type: 'email',
                restorable: true,
            }],
            policy: { enabled: true, placeholderMode: 'typed-random' },
            modelFrame: {
                instruction: 'Preserve placeholders.',
                placeholders: [{ placeholder: '[[PII:EMAIL:ctx1]]', type: 'email' }],
            },
            sanitizedInput: 'Create a PDF for [[PII:EMAIL:ctx1]].',
        }));
        rehydrateText.mockImplementationOnce(async (text, options) => ({
            text: String(text).replace(/\[\[PII:EMAIL:ctx1\]\]/g, 'jane@example.com'),
            restorations: [{
                placeholder: '[[PII:EMAIL:ctx1]]',
                type: 'email',
                restored: true,
            }],
            enabled: true,
            options,
        }));
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-pii-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Private Contact PDF',
                        sections: [
                            { heading: 'Contact', purpose: 'Show the contact email', keyPoints: ['[[PII:EMAIL:ctx1]]'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-pii-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Private Contact PDF',
                        sections: [
                            { heading: 'Contact', content: 'Email [[PII:EMAIL:ctx1]]', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-pii-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body>Email [[PII:EMAIL:ctx1]]</body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: { id: 'session-1', previousResponseId: 'prev-1', metadata: { ownerId: 'phill' } },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a PDF for jane@example.com.',
            format: 'pdf',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
            toolContext: {
                ownerId: 'phill',
                clientSurface: 'web-chat',
                route: '/api/artifacts/generate',
            },
        });

        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            format: 'pdf',
            content: expect.stringContaining('jane@example.com'),
        }));
        expect(renderArtifact.mock.calls[0][0].content).not.toContain('[[PII:EMAIL:ctx1]]');
        expect(rehydrateText).toHaveBeenCalledWith(
            expect.stringContaining('[[PII:EMAIL:ctx1]]'),
            expect.objectContaining({
                contextIds: ['ctx-1'],
                ownerId: 'phill',
                highlight: false,
            }),
        );
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                sourcePrompt: 'Create a PDF for [[PII:EMAIL:ctx1]].',
                piiCleansing: expect.objectContaining({
                    contextIds: ['ctx-1'],
                    replacementCount: 1,
                    restoredCount: 1,
                    restoredInGeneratedArtifact: true,
                }),
            }),
        }));
    });

    test('threads recalled context, recent transcript, and response chaining through multi-pass artifact generation', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Continuity Report',
                        sections: [
                            { heading: 'Overview', purpose: 'Summarize the request', keyPoints: ['Continuity'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Continuity Report',
                        sections: [
                            { heading: 'Overview', content: 'Expanded continuity content', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>Continuity Report</h1></body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-session', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create the same HTML report, but update section 3 from the previous version.',
            format: 'html',
            artifactIds: [],
            model: 'gpt-5.3',
            contextMessages: ['Relevant prior artifacts:\n- report-v1.html: Existing section 3 summary'],
            recentMessages: [
                { role: 'user', content: 'Create the first version of the report.' },
                { role: 'assistant', content: 'Created report-v1.html.' },
            ],
        });

        expect(createResponse).toHaveBeenCalledTimes(3);
        expect(createResponse.mock.calls[0][0]).toEqual(expect.objectContaining({
            previousResponseId: 'prev-session',
            contextMessages: ['Relevant prior artifacts:\n- report-v1.html: Existing section 3 summary'],
            recentMessages: expect.arrayContaining([
                expect.objectContaining({ role: 'user', content: 'Create the first version of the report.' }),
            ]),
        }));
        expect(createResponse.mock.calls[1][0]).toEqual(expect.objectContaining({
            previousResponseId: 'resp-plan',
            contextMessages: ['Relevant prior artifacts:\n- report-v1.html: Existing section 3 summary'],
        }));
        expect(createResponse.mock.calls[2][0]).toEqual(expect.objectContaining({
            previousResponseId: 'resp-expand',
            contextMessages: ['Relevant prior artifacts:\n- report-v1.html: Existing section 3 summary'],
        }));
    });

    test('uses single-pass frontend-demo generation for html landing-page requests', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-frontend-1',
            output: [{
                type: 'message',
                content: [{
                    text: '<!DOCTYPE html><html><head><title>Nova Studio</title></head><body><section id="hero" data-component="hero"><h1>Nova Studio</h1></section></body></html>',
                }],
            }],
        });

        const result = await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-1', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Build a landing page demo for Nova Studio with a premium editorial feel.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(createResponse).toHaveBeenCalledTimes(1);
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Build a polished frontend demo instead of a plain document.');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Match the request instead of defaulting to the same landing-page stack.');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Use realistic example data by default');
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            format: 'html',
            title: expect.stringContaining('Nova Studio'),
            content: expect.stringContaining('data-component="hero"'),
        }));
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                generationStrategy: 'single-pass-frontend-demo',
            }),
        }));
        expect(result.responseId).toBe('resp-frontend-1');
    });

    test('strips progress prose around fenced html before rendering single-file frontend artifacts', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-frontend-wrapper-1',
            output: [{
                type: 'message',
                content: [{
                    text: [
                        'Working in background...I\'ll rebuild this with fresh verification first, then return the page as clean HTML only so it can be pasted directly into a viewer without wrapper text.```html',
                        '<!DOCTYPE html><html><head><title>Canada Ledger</title></head><body><main><h1>Canada Ledger</h1></main></body></html>',
                    ].join('\n'),
                }],
            }],
        });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-wrapper', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Build an HTML page about Canada ledger news and weather with a polished editorial feel.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        const renderedHtml = renderArtifact.mock.calls[0][0]?.content || '';
        expect(renderedHtml.trim()).toMatch(/^<!DOCTYPE html>/);
        expect(renderedHtml).toContain('<h1>Canada Ledger</h1>');
        expect(renderedHtml).not.toContain('Working in background');
        expect(renderedHtml).not.toContain('clean HTML only');
        expect(renderedHtml).not.toContain('```html');
    });

    test('uses frontend artifact generation for interactive research documents', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-interactive-research-1',
            output: [{
                type: 'message',
                content: [{
                    text: '<!DOCTYPE html><html><head><title>AI Browser Research</title></head><body><main data-component="interactive-research"><h1>AI Browser Research</h1><button>Filter sources</button><script>document.body.dataset.ready = "true";</script></main></body></html>',
                }],
            }],
        });

        const result = await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-interactive-doc', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Do some research on AI browser tools and make it an interactive document with source filters and light motion.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(createResponse).toHaveBeenCalledTimes(1);
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('[Interactive document experience]');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('sandbox that allows scripts');
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            format: 'html',
            title: expect.stringContaining('AI Browser Research'),
            content: expect.stringContaining('data-component="interactive-research"'),
        }));
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                generationStrategy: 'single-pass-frontend-demo',
                artifactExperience: expect.objectContaining({
                    family: 'interactive-research-document',
                    sandbox: expect.objectContaining({
                        scripts: true,
                        sameOrigin: false,
                    }),
                }),
            }),
        }));
        expect(result.responseId).toBe('resp-interactive-research-1');
    });

    test('stores multi-page frontend bundles as previewable zip artifacts', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-frontend-bundle-1',
            output: [{
                type: 'message',
                content: [{
                    text: JSON.stringify({
                        content: '<!DOCTYPE html><html><head><title>Newsroom</title></head><body><nav><a href="world.html">World</a></nav><main><h1>Front Page</h1></main></body></html>',
                        metadata: {
                            title: 'Newsroom',
                            frameworkTarget: 'vite',
                            bundle: {
                                entry: 'index.html',
                                files: [
                                    {
                                        path: 'index.html',
                                        language: 'html',
                                        purpose: 'Front page',
                                        content: '<!DOCTYPE html><html><head><title>Newsroom</title></head><body><nav><a href="world.html">World</a></nav><main><h1>Front Page</h1></main></body></html>',
                                    },
                                    {
                                        path: 'world.html',
                                        language: 'html',
                                        purpose: 'World desk',
                                        content: '<!DOCTYPE html><html><head><title>World</title></head><body><main><h1>World Desk</h1></main></body></html>',
                                    },
                                    {
                                        path: 'styles.css',
                                        language: 'css',
                                        purpose: 'Shared styles',
                                        content: 'body { font-family: system-ui; }',
                                    },
                                ],
                            },
                            handoff: {
                                summary: 'Move bundle files into a Vite workspace when ready.',
                                targetFramework: 'vite',
                            },
                        },
                    }),
                }],
            }],
        });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-frontend-bundle', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Build a 5 page news website demo for a city newsroom with Vite-ready files.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Return valid JSON only');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Create 5 distinct HTML pages');
        expect(renderArtifact).not.toHaveBeenCalled();
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            extension: 'zip',
            mimeType: 'application/zip',
            metadata: expect.objectContaining({
                frameworkTarget: 'vite',
                generationStrategy: 'single-pass-frontend-demo',
                siteBundle: expect.objectContaining({
                    entry: 'index.html',
                    fileCount: 4,
                    htmlPageCount: 2,
                }),
                bundle: expect.objectContaining({
                    entry: 'index.html',
                    files: expect.arrayContaining([
                        expect.objectContaining({ path: 'index.html' }),
                        expect.objectContaining({ path: 'world.html' }),
                        expect.objectContaining({ path: 'styles.css' }),
                        expect.objectContaining({ path: 'README.md' }),
                    ]),
                }),
            }),
        }));
    });

    test('strips assistant prose around fenced html before storing frontend bundle files', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-frontend-bundle-prose-1',
            output: [{
                type: 'message',
                content: [{
                    text: JSON.stringify({
                        content: [
                            'Using nearby big-box chains only, I would prioritize Canadian Tire first.',
                            'Here is a compact HTML page you can save/use:',
                            '```html',
                            '<!DOCTYPE html><html><head><title>Mower Plan</title></head><body><main><h1>Mower Plan</h1></main></body></html>',
                            '```',
                        ].join('\n'),
                        metadata: {
                            title: 'Mower Plan',
                            frameworkTarget: 'vite',
                            bundle: {
                                entry: 'index.html',
                                files: [
                                    {
                                        path: 'index.html',
                                        language: 'html',
                                        purpose: 'Entry page',
                                        content: [
                                            'Using nearby big-box chains only, I would prioritize Canadian Tire first.',
                                            'Here is a compact HTML page you can save/use:',
                                            '```html',
                                            '<!DOCTYPE html><html><head><title>Mower Plan</title></head><body><main><h1>Mower Plan</h1></main></body></html>',
                                            '```',
                                        ].join('\n'),
                                    },
                                    {
                                        path: 'styles.css',
                                        language: 'css',
                                        purpose: 'Shared styles',
                                        content: 'body { font-family: system-ui; }',
                                    },
                                ],
                            },
                        },
                    }),
                }],
            }],
        });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-frontend-bundle-prose', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Build a 2 page website demo for buying a mower and trimmer with Vite-ready files.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        const createArg = artifactStore.create.mock.calls[0][0];
        const entries = readFrontendBundleArchive(createArg.contentBuffer);
        const indexHtml = entries.get('index.html').toString('utf8');

        expect(indexHtml.trim()).toMatch(/^<!DOCTYPE html>/);
        expect(indexHtml).toContain('<h1>Mower Plan</h1>');
        expect(indexHtml).not.toContain('Using nearby big-box chains only');
        expect(indexHtml).not.toContain('Here is a compact HTML page');
        expect(indexHtml).not.toContain('```html');
        expect(createArg.previewHtml).toBe(indexHtml);
    });

    test('stores 3D scene sandbox requests as zip bundles with separate scene files', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-3d-scene-1',
            output: [{
                type: 'message',
                content: [{
                    text: JSON.stringify({
                        content: '<!DOCTYPE html><html><head><title>Orbit Lab</title><link rel="stylesheet" href="./styles.css"><script type="importmap">{"imports":{"three":"/api/sandbox-libraries/three/three.module.js","three/addons/":"/api/sandbox-libraries/three/addons/"}}</script></head><body><main id="scene-root"></main><script type="module" src="./scene.js"></script></body></html>',
                        metadata: {
                            title: 'Orbit Lab',
                            frameworkTarget: 'static',
                            bundle: {
                                entry: 'index.html',
                                files: [
                                    {
                                        path: 'index.html',
                                        language: 'html',
                                        purpose: '3D scene entry point',
                                        content: '<!DOCTYPE html><html><head><title>Orbit Lab</title><link rel="stylesheet" href="./styles.css"><script type="importmap">{"imports":{"three":"/api/sandbox-libraries/three/three.module.js","three/addons/":"/api/sandbox-libraries/three/addons/"}}</script></head><body><main id="scene-root"></main><script type="module" src="./scene.js"></script></body></html>',
                                    },
                                    {
                                        path: 'styles.css',
                                        language: 'css',
                                        purpose: 'Scene layout and fallback styling',
                                        content: 'html, body, #scene-root { width: 100%; height: 100%; margin: 0; background: #07111f; color: #f8fafc; }',
                                    },
                                    {
                                        path: 'scene.js',
                                        language: 'javascript',
                                        purpose: 'Three.js scene runtime',
                                        content: 'import * as THREE from "three"; const scene = new THREE.Scene(); document.body.dataset.sceneReady = String(Boolean(scene));',
                                    },
                                ],
                            },
                            handoff: {
                                summary: 'Standalone Three.js scene preview.',
                                targetFramework: 'static',
                            },
                        },
                    }),
                }],
            }],
        });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-3d-scene', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a sandboxed immersive 3D scene in HTML with Three.js and a visible animated object.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(createResponse.mock.calls[0][0]?.instructions).toContain('For 3D, WebGL, Three.js');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('`scene.js`');
        expect(renderArtifact).not.toHaveBeenCalled();
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            extension: 'zip',
            mimeType: 'application/zip',
            metadata: expect.objectContaining({
                generationStrategy: 'single-pass-frontend-demo',
                siteBundle: expect.objectContaining({
                    entry: 'index.html',
                    fileCount: 4,
                }),
                bundle: expect.objectContaining({
                    files: expect.arrayContaining([
                        expect.objectContaining({ path: 'index.html' }),
                        expect.objectContaining({ path: 'styles.css' }),
                        expect.objectContaining({ path: 'scene.js' }),
                        expect.objectContaining({ path: 'README.md' }),
                    ]),
                }),
            }),
        }));
    });

    test('treats plain video game requests as playable frontend bundle work', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-video-game-1',
            output: [{
                type: 'message',
                content: [{
                    text: JSON.stringify({
                        content: '<!DOCTYPE html><html><head><title>Block Runner</title><link rel="stylesheet" href="./styles.css"></head><body><canvas id="game"></canvas><script type="module" src="./game.js"></script></body></html>',
                        metadata: {
                            title: 'Block Runner',
                            frameworkTarget: 'vite',
                            bundle: {
                                entry: 'index.html',
                                files: [
                                    {
                                        path: 'index.html',
                                        language: 'html',
                                        purpose: 'Playable game entry point',
                                        content: '<!DOCTYPE html><html><head><title>Block Runner</title><link rel="stylesheet" href="./styles.css"></head><body><canvas id="game"></canvas><script type="module" src="./game.js"></script></body></html>',
                                    },
                                    {
                                        path: 'styles.css',
                                        language: 'css',
                                        purpose: 'Game layout styles',
                                        content: 'html, body { margin: 0; min-height: 100%; background: #101827; color: white; } canvas { display: block; width: 100vw; height: 100vh; }',
                                    },
                                    {
                                        path: 'game.js',
                                        language: 'javascript',
                                        purpose: 'Game loop and controls',
                                        content: 'let score = 0; function loop(){ score += 1; requestAnimationFrame(loop); } loop();',
                                    },
                                ],
                            },
                        },
                    }),
                }],
            }],
        });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-video-game', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Make me a video game about collecting blocks.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.4',
        });

        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Build a polished frontend demo instead of a plain document.');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('For browser game, playable simulation, or multi-step app requests');
        expect(renderArtifact).not.toHaveBeenCalled();
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            extension: 'zip',
            mimeType: 'application/zip',
            metadata: expect.objectContaining({
                generationStrategy: 'single-pass-frontend-demo',
                frameworkTarget: 'vite',
                siteBundle: expect.objectContaining({
                    entry: 'index.html',
                    fileCount: 4,
                }),
                bundle: expect.objectContaining({
                    files: expect.arrayContaining([
                        expect.objectContaining({ path: 'index.html' }),
                        expect.objectContaining({ path: 'styles.css' }),
                        expect.objectContaining({ path: 'game.js' }),
                        expect.objectContaining({ path: 'README.md' }),
                    ]),
                }),
            }),
        }));
    });

    test('rebuilds empty 3D sandbox model output instead of shipping fallback css', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-3d-empty-1',
                output: [{
                    type: 'message',
                    content: [{
                        text: '',
                    }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-3d-repair-1',
                output: [{
                    type: 'message',
                    content: [{
                        text: JSON.stringify({
                            content: '<!DOCTYPE html><html><head><title>Particle Field</title><link rel="stylesheet" href="./styles.css"></head><body><main id="scene-root"><h1>Particle Field</h1></main><script type="module" src="./scene.js"></script></body></html>',
                            metadata: {
                                title: 'Particle Field',
                                frameworkTarget: 'static',
                                bundle: {
                                    entry: 'index.html',
                                    files: [
                                        {
                                            path: 'index.html',
                                            language: 'html',
                                            purpose: '3D scene entry',
                                            content: '<!DOCTYPE html><html><head><title>Particle Field</title><link rel="stylesheet" href="./styles.css"></head><body><main id="scene-root"><h1>Particle Field</h1></main><script type="module" src="./scene.js"></script></body></html>',
                                        },
                                        {
                                            path: 'styles.css',
                                            language: 'css',
                                            purpose: 'Authored 3D scene styles',
                                            content: 'html, body { margin: 0; min-height: 100%; background: #07111f; color: #e2e8f0; font-family: system-ui; } #scene-root { min-height: 100vh; display: grid; place-items: center; }',
                                        },
                                        {
                                            path: 'scene.js',
                                            language: 'javascript',
                                            purpose: 'Scene runtime',
                                            content: 'document.documentElement.dataset.sceneReady = "true";',
                                        },
                                    ],
                                },
                            },
                        }),
                    }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-3d-empty', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Make a 3D webpage sandbox with WebGL particles.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        const createArg = artifactStore.create.mock.calls[0][0];
        const entries = readFrontendBundleArchive(createArg.contentBuffer);

        expect(createArg.extension).toBe('zip');
        expect(createArg.mimeType).toBe('application/zip');
        expect(createArg.contentBuffer.length).toBeGreaterThan(22);
        expect(createResponse).toHaveBeenCalledTimes(2);
        expect(entries.get('index.html').toString('utf8')).toContain('Particle Field');
        expect(entries.get('styles.css').toString('utf8')).not.toContain('kimibuilt bundle style safety net');
        expect(entries.get('README.md').toString('utf8')).toContain('python -m http.server 8000');
        expect(createArg.metadata).toEqual(expect.objectContaining({
            frontendSandboxRepaired: true,
            frontendSandboxRetrospective: expect.objectContaining({
                status: 'repaired',
                finalAction: 'ship_rebuilt_bundle',
            }),
        }));
    });

    test('allows tool orchestration for research-backed frontend artifacts', async () => {
        const orchestrationError = new Error('Model gateway request timed out while waiting for the provider.');
        orchestrationError.code = 'tool_orchestration_failed';
        createResponse
            .mockRejectedValueOnce(orchestrationError)
            .mockResolvedValueOnce({
            id: 'resp-frontend-research-1',
            output: [{
                type: 'message',
                content: [{
                    text: JSON.stringify({
                        content: '<!DOCTYPE html><html><head><title>Newsroom Research Demo</title><link rel="stylesheet" href="./styles.css"></head><body><main><h1>Newsroom Research Demo</h1></main></body></html>',
                        metadata: {
                            title: 'Newsroom Research Demo',
                            frameworkTarget: 'static',
                            bundle: {
                                entry: 'index.html',
                                files: [
                                    {
                                        path: 'index.html',
                                        language: 'html',
                                        content: '<!DOCTYPE html><html><head><title>Newsroom Research Demo</title><link rel="stylesheet" href="./styles.css"></head><body><main><h1>Newsroom Research Demo</h1></main></body></html>',
                                    },
                                    {
                                        path: 'styles.css',
                                        language: 'css',
                                        content: 'body { margin: 0; min-height: 100%; background: #f8fafc; color: #111827; font-family: system-ui; } main { max-width: 960px; margin: 0 auto; padding: 48px 24px; }',
                                    },
                                ],
                            },
                        },
                    }),
                }],
            }],
        });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-frontend-research', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Research the latest news layout patterns, delegate section planning to sub-agents, and build a frontend demo for a newsroom homepage.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
            toolManager: { id: 'tool-manager', executeTool: jest.fn() },
            toolContext: { sessionId: 'session-1' },
        });

        expect(createResponse.mock.calls[0][0]).toEqual(expect.objectContaining({
            enableAutomaticToolCalls: true,
            toolManager: expect.objectContaining({ id: 'tool-manager' }),
            toolContext: { sessionId: 'session-1' },
        }));
        expect(createResponse.mock.calls[1][0]).toEqual(expect.objectContaining({
            enableAutomaticToolCalls: false,
        }));
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Use available tools when they materially improve factual grounding');
        expect(createResponse.mock.calls[0][0]?.instructions).not.toContain('Do not use external tools, function calls, or tool invocation syntax.');
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                toolOrchestrationEnabled: true,
                toolOrchestrationRecovered: true,
            }),
        }));
    });

    test('allows tool orchestration for research-backed html news documents', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan-news-1',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'EV Tariff Watch',
                        sections: [
                            { heading: 'Lead', purpose: 'Summarize the update', keyPoints: ['Tariff change'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand-news-1',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'EV Tariff Watch',
                        sections: [
                            { heading: 'Lead', content: 'Lead section', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose-news-1',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>EV Tariff Watch</h1></body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-news-research', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create an HTML news report on the latest EV tariffs with sourced visuals and current reporting.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
            toolManager: { id: 'tool-manager', executeTool: jest.fn() },
            toolContext: { sessionId: 'session-1' },
        });

        expect(createResponse.mock.calls[0][0]).toEqual(expect.objectContaining({
            enableAutomaticToolCalls: true,
            toolManager: expect.objectContaining({ id: 'tool-manager' }),
            toolContext: { sessionId: 'session-1' },
        }));
        const joinedInstructions = createResponse.mock.calls.map((call) => call[0]?.instructions || '').join('\n\n---\n\n');
        expect(joinedInstructions).toContain('web-search and web-fetch');
        expect(joinedInstructions).toContain('verified real image sources');
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                toolOrchestrationEnabled: true,
            }),
        }));
    });

    test('serializeArtifact exposes server preview and bundle download paths for site bundles', () => {
        const serialized = artifactService.serializeArtifact({
            id: 'artifact-site-1',
            sessionId: 'session-1',
            parentArtifactId: null,
            direction: 'generated',
            sourceMode: 'chat',
            filename: 'newsroom.html',
            extension: 'html',
            mimeType: 'text/html',
            sizeBytes: 1024,
            vectorizedAt: null,
            previewHtml: '<!DOCTYPE html><html><body><h1>Newsroom</h1></body></html>',
            metadata: {
                type: 'frontend',
                title: 'Newsroom',
                bundle: {
                    entry: 'index.html',
                    files: [
                        {
                            path: 'index.html',
                            language: 'html',
                            purpose: 'Home',
                            content: '<!DOCTYPE html><html><body><h1>Newsroom</h1></body></html>',
                        },
                        {
                            path: 'world.html',
                            language: 'html',
                            purpose: 'World',
                            content: '<!DOCTYPE html><html><body><h1>World</h1></body></html>',
                        },
                    ],
                },
            },
            createdAt: '2026-04-08T00:00:00.000Z',
        });

        expect(serialized.previewUrl).toBe('/api/artifacts/artifact-site-1/preview');
        expect(serialized.sandboxUrl).toBe('/api/artifacts/artifact-site-1/sandbox');
        expect(serialized.bundleDownloadUrl).toBe('/api/artifacts/artifact-site-1/bundle');
        expect(serialized.preview).toEqual(expect.objectContaining({
            type: 'site',
            entry: 'index.html',
            fileCount: 2,
            url: '/api/artifacts/artifact-site-1/sandbox',
        }));
    });

    test('serializeArtifact exposes preview urls for previewable non-html artifacts', () => {
        const serialized = artifactService.serializeArtifact({
            id: 'artifact-text-1',
            sessionId: 'session-1',
            parentArtifactId: null,
            direction: 'generated',
            sourceMode: 'chat',
            filename: 'notes.txt',
            extension: 'txt',
            mimeType: 'text/plain',
            sizeBytes: 32,
            vectorizedAt: null,
            previewHtml: '<pre>hello world</pre>',
            extractedText: 'hello world',
            metadata: {},
            createdAt: '2026-04-08T00:00:00.000Z',
        });

        expect(serialized.previewUrl).toBe('/api/artifacts/artifact-text-1/preview');
        expect(serialized.sandboxUrl).toBe('/api/artifacts/artifact-text-1/sandbox');
        expect(serialized.preview).toEqual({
            type: 'html',
            content: '<pre>hello world</pre>',
        });
    });

    test('serializeArtifact suppresses uploaded-file previews while PII protection is enabled', () => {
        resolvePiiPolicy.mockReturnValue({ enabled: true });

        const serialized = artifactService.serializeArtifact({
            id: 'artifact-pdf-1',
            sessionId: 'session-1',
            parentArtifactId: null,
            direction: 'uploaded',
            sourceMode: 'chat',
            filename: 'resume.pdf',
            extension: 'pdf',
            mimeType: 'application/pdf',
            sizeBytes: 2048,
            vectorizedAt: null,
            previewHtml: '',
            extractedText: '',
            metadata: {
                sheets: [{ name: 'Patients', rowCount: 1 }],
                structuredTables: [{
                    name: 'Patients',
                    rowCount: 1,
                    headers: [{ header: 'SSN' }],
                    rows: [{ cells: [{ value: 'Jane Patient' }, { value: '123-45-6789' }] }],
                }],
            },
            createdAt: '2026-04-08T00:00:00.000Z',
        });

        expect(serialized.previewUrl).toBeNull();
        expect(serialized.sandboxUrl).toBeNull();
        expect(serialized.preview).toBeNull();
        expect(serialized.metadata).toEqual(expect.objectContaining({
            privacyPreviewSuppressed: true,
            sheets: [{ name: 'Patients', rowCount: 1 }],
            structuredTableSummary: [{ name: 'Patients', rowCount: 1, columnCount: 1 }],
            piiCleansing: expect.objectContaining({
                uploadPreviewSuppressed: true,
            }),
        }));
        expect(JSON.stringify(serialized.metadata)).not.toContain('Jane Patient');
        expect(JSON.stringify(serialized.metadata)).not.toContain('123-45-6789');
        expect(serialized.metadata.structuredTables).toBeUndefined();
    });

    test('buildPromptContext withholds private uploaded artifact text from model context', async () => {
        resolvePiiPolicy.mockReturnValue({ enabled: true });
        artifactStore.listBySession.mockResolvedValue([{
            id: 'artifact-xlsx-1',
            sessionId: 'session-1',
            direction: 'uploaded',
            filename: 'patients.xlsx',
            extension: 'xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            sizeBytes: 4096,
            extractedText: 'Jane Patient | 123-45-6789 | P010',
            previewHtml: '<pre>Jane Patient | 123-45-6789 | P010</pre>',
            metadata: {},
        }]);

        const context = await artifactService.buildPromptContext('session-1', ['artifact-xlsx-1']);

        expect(context).toContain('PII protection is enabled');
        expect(context).toContain('use trusted structured tools for calculations');
        expect(context).not.toContain('Jane Patient');
        expect(context).not.toContain('123-45-6789');
    });

    test('adds conservative instructions for resume PDF revisions', () => {
        const instructions = artifactService.getGenerationInstructions(
            'pdf',
            'Philip Asplin resume with technical solutions and security systems experience.',
            '',
            null,
            'Update this document (Resume-Philip-Asplin-Professional-Staffing.pdf): improve the layout and font',
        );

        expect(instructions).toContain('[Conservative document revision]');
        expect(instructions).toContain('Do not add stock photography');
        expect(instructions).toContain('ATS-friendly readability');
    });

    test('treats updating a resume into html as a conservative revision without stock images', async () => {
        isConfigured.mockReturnValue(true);
        artifactStore.get.mockResolvedValueOnce({
            id: 'source-pdf',
            sessionId: 'session-1',
            filename: 'Resume-Philip-Asplin-Cognizant.pdf',
            extension: 'pdf',
            mimeType: 'application/pdf',
            sizeBytes: 91806,
            metadata: {},
        });
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Philip Asplin Resume',
                        sections: [
                            { heading: 'Profile', purpose: 'Update the resume profile', keyPoints: ['Technical leadership'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Philip Asplin Resume',
                        sections: [
                            { heading: 'Profile', content: 'Technical leadership resume profile.', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>Philip Asplin</h1><p>Technical leadership resume profile.</p></body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-1', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'please make me a new html page by updating this file I gave you with new font and look. Resume-Philip-Asplin-Cognizant.pdf',
            format: 'html',
            artifactIds: ['source-pdf'],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(searchImages).not.toHaveBeenCalled();
        const instructions = createResponse.mock.calls.map((call) => call[0]?.instructions || '').join('\n\n---\n\n');
        expect(instructions).toContain('[Conservative document revision]');
        expect(instructions).toContain('Do not add stock photography');
    });

    test('injects dashboard template guidance for dashboard html artifacts', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-dashboard-1',
            output: [{
                type: 'message',
                content: [{
                    text: '<!DOCTYPE html><html><body data-dashboard-template="admin-control-room"><main data-dashboard-zone="hero"><h1>Support Ops</h1></main></body></html>',
                }],
            }],
        });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-1', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create an admin dashboard HTML for support operations with ticket queues and SLA timers.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(createResponse).toHaveBeenCalledTimes(1);
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('[Dashboard template catalog]');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('data-dashboard-template');
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                dashboardTemplateSuggestedPrimaryId: expect.any(String),
                dashboardTemplateOptions: expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.any(String),
                        label: expect.any(String),
                    }),
                ]),
            }),
        }));
    });

    test('treats website-slide design examples as frontend website bundle artifacts', async () => {
        createResponse.mockResolvedValueOnce({
            id: 'resp-slides-frontend-1',
            output: [{
                type: 'message',
                content: [{
                    text: JSON.stringify({
                        content: '<!DOCTYPE html><html><body><nav><a href="story.html">Story</a></nav><main data-component="storyboard"><section id="scene-1"><h1>Launch Story</h1></section></main></body></html>',
                        metadata: {
                            title: 'Launch Storyboard',
                            frameworkTarget: 'vite',
                            bundle: {
                                entry: 'index.html',
                                files: [
                                    {
                                        path: 'index.html',
                                        language: 'html',
                                        purpose: 'Launch story opener',
                                        content: '<!DOCTYPE html><html><body><nav><a href="story.html">Story</a></nav><main data-component="storyboard"><section id="scene-1"><h1>Launch Story</h1></section></main></body></html>',
                                    },
                                    {
                                        path: 'story.html',
                                        language: 'html',
                                        purpose: 'Story continuation',
                                        content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="./styles.css"></head><body><main><section id="scene-2"><h1>Momentum</h1></section></main></body></html>',
                                    },
                                    {
                                        path: 'styles.css',
                                        language: 'css',
                                        purpose: 'Storyboard visual system',
                                        content: 'body { margin: 0; min-height: 100%; background: #101827; color: #f8fafc; font-family: system-ui; } main { max-width: 1080px; margin: 0 auto; padding: 44px 24px; } section { border: 1px solid #334155; padding: 24px; }',
                                    },
                                    {
                                        path: 'app.js',
                                        language: 'javascript',
                                        purpose: 'Scene interactions',
                                        content: 'document.documentElement.dataset.ready = "true";',
                                    },
                                ],
                            },
                        },
                    }),
                }],
            }],
        });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-slides-1', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create website slides for our launch story that I can reuse as a Vite template.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(createResponse).toHaveBeenCalledTimes(1);
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('You are generating a full website preview bundle');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Choose the right site shape before writing');
        expect(createResponse.mock.calls[0][0]?.instructions).toContain('Use realistic example data by default');
        expect(renderArtifact).not.toHaveBeenCalled();
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            extension: 'zip',
            metadata: expect.objectContaining({
                frameworkTarget: 'vite',
                bundle: expect.objectContaining({
                    files: expect.arrayContaining([
                        expect.objectContaining({ path: 'index.html' }),
                        expect.objectContaining({ path: 'story.html' }),
                        expect.objectContaining({ path: 'app.js' }),
                    ]),
                }),
            }),
        }));
    });

    test('injects verified session image references into multi-pass document instructions', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Axe Throwing Guide',
                        sections: [
                            { heading: 'Overview', purpose: 'Introduce the venues', keyPoints: ['Atmosphere'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Axe Throwing Guide',
                        sections: [
                            { heading: 'Overview', content: 'Overview content', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>Axe Throwing Guide</h1><img src="https://images.unsplash.com/photo-123" alt="Axe throwing venue"></body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: {
                previousResponseId: 'prev-1',
                metadata: {
                    projectMemory: {
                        urls: [
                            {
                                url: 'https://images.unsplash.com/photo-123',
                                kind: 'image',
                                title: 'Venue action shot',
                                source: 'tool',
                                toolId: 'image-search-unsplash',
                            },
                        ],
                    },
                },
            },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a polished HTML guide for Atlantic Canada axe throwing venues.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(createResponse).toHaveBeenCalledTimes(3);
        const instructions = createResponse.mock.calls.map((call) => call[0]?.instructions || '').join('\n\n---\n\n');
        expect(instructions).toContain('[Verified image references]');
        expect(instructions).toContain('https://images.unsplash.com/photo-123');
        expect(instructions).toContain('Never create inline SVG artwork');
        expect(instructions).toContain('Prefer standard HTML <img src="..."> elements');
    });

    test('adds sample-handling and creative-direction guardrails when scaffold content is provided', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Expansion Brief',
                        creativeDirection: {
                            id: 'boardroom-brief',
                            label: 'Boardroom Brief',
                            rationale: 'Fast, decision-ready structure.',
                        },
                        sections: [
                            { heading: 'Decision', purpose: 'Frame the call', keyPoints: ['Approve the move'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Expansion Brief',
                        sections: [
                            { heading: 'Decision', kicker: 'Go / no-go', content: 'Approve the move.', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>Expansion Brief</h1></body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-1', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a polished executive brief for Atlantic expansion.',
            format: 'pdf',
            artifactIds: [],
            existingContent: '## Overview\n## Details\n{{company_name}}\nPlaceholder copy here',
            model: 'gpt-5.3',
        });

        const instructions = createResponse.mock.calls.map((call) => call[0]?.instructions || '').join('\n\n---\n\n');
        expect(instructions).toContain('<creative_direction>');
        expect(instructions).toContain('Direction:');
        expect(instructions).toContain('<sample_handling>');
        expect(instructions).toContain('Treat the provided template, defaults, and sample text as scaffolding, not final copy.');
        expect(instructions).toContain('Do not simply recycle the sample section labels');
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                creativeDirection: expect.any(String),
                themeSuggestion: expect.any(String),
            }),
        }));
    });

    test('fetches Unsplash image references for visual html documents when configured', async () => {
        isConfigured.mockReturnValue(true);
        searchImages.mockResolvedValue({
            results: [
                {
                    description: 'Axe throwing lane',
                    altDescription: 'Axe throwing target',
                    urls: {
                        regular: 'https://images.unsplash.com/photo-999',
                    },
                },
            ],
        });

        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Axe Throwing Guide',
                        sections: [
                            { heading: 'Overview', purpose: 'Introduce the venues', keyPoints: ['Atmosphere'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Axe Throwing Guide',
                        sections: [
                            { heading: 'Overview', content: 'Overview content', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>Axe Throwing Guide</h1><img src="https://images.unsplash.com/photo-999" alt="Axe throwing lane"></body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-1', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a visual HTML guide with real Unsplash images for Atlantic Canada axe throwing venues.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(searchImages).toHaveBeenCalledWith(expect.stringContaining('axe throwing'), expect.objectContaining({
            perPage: 20,
            orientation: 'landscape',
        }));
        const instructions = createResponse.mock.calls.map((call) => call[0]?.instructions || '').join('\n\n---\n\n');
        expect(instructions).toContain('https://images.unsplash.com/photo-999');
        expect(instructions).toContain('[Verified image references]');
        expect(instructions).toContain('up to 20 images');
    });

    test('diversifies repeated html image urls when multiple verified references are available', async () => {
        isConfigured.mockReturnValue(true);
        searchImages.mockResolvedValue({
            results: [
                {
                    description: 'Market overview photo',
                    altDescription: 'Chart wall',
                    urls: { regular: 'https://images.unsplash.com/photo-111' },
                },
                {
                    description: 'Factory floor photo',
                    altDescription: 'Production line',
                    urls: { regular: 'https://images.unsplash.com/photo-222' },
                },
                {
                    description: 'Port logistics photo',
                    altDescription: 'Cargo port',
                    urls: { regular: 'https://images.unsplash.com/photo-333' },
                },
            ],
        });

        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan-dup',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Tariff Watch',
                        sections: [
                            { heading: 'Lead', purpose: 'Summarize the update', keyPoints: ['Lead'], targetLength: 'short' },
                            { heading: 'Supply Chain', purpose: 'Explain the logistics impact', keyPoints: ['Ports'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand-dup',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Tariff Watch',
                        sections: [
                            { heading: 'Lead', content: 'Lead section', level: 1 },
                            { heading: 'Supply Chain', content: 'Supply chain section', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose-dup',
                output: [{
                    type: 'message',
                    content: [{ text: [
                        '<!DOCTYPE html><html><body>',
                        '<img src="https://images.unsplash.com/photo-111" alt="Lead image">',
                        '<section><img src="https://images.unsplash.com/photo-111" alt="Repeated image"></section>',
                        '<section><img src="https://images.unsplash.com/photo-111" alt="Repeated again"></section>',
                        '</body></html>',
                    ].join('') }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-dup', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a visual HTML news report on the latest EV tariffs with real sourced images.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        const renderedHtml = renderArtifact.mock.calls[0][0]?.content || '';
        expect(renderedHtml).toContain('https://images.unsplash.com/photo-111');
        expect(renderedHtml).toContain('https://images.unsplash.com/photo-222');
        expect(renderedHtml).toContain('https://images.unsplash.com/photo-333');
    });

    test('ignores internal artifact image links and prefers external urls for document visuals', async () => {
        isConfigured.mockReturnValue(true);
        searchImages.mockResolvedValue({
            results: [
                {
                    description: 'External photo',
                    altDescription: 'External fallback photo',
                    urls: {
                        regular: 'https://images.unsplash.com/photo-456',
                    },
                },
            ],
        });

        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Travel Brief',
                        sections: [
                            { heading: 'Overview', purpose: 'Summarize the brief', keyPoints: ['Goal'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Travel Brief',
                        sections: [
                            { heading: 'Overview', content: 'Overview content', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: 'Page Layout Plan\n\nUse verified photos throughout the PDF.' }],
                }],
            });

        await artifactService.generateArtifact({
            session: {
                previousResponseId: 'prev-1',
                metadata: {
                    projectMemory: {
                        urls: [
                            {
                                url: '/api/artifacts/internal-image/download',
                                kind: 'image',
                                title: 'Internal artifact image',
                                source: 'session',
                            },
                        ],
                    },
                },
            },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a polished PDF travel brief.',
            format: 'pdf',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        const instructions = createResponse.mock.calls.map((call) => call[0]?.instructions || '').join('\n\n---\n\n');
        expect(instructions).not.toContain('/api/artifacts/internal-image/download');
        expect(instructions).toContain('https://images.unsplash.com/photo-456');
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('https://images.unsplash.com/photo-456'),
        }));
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.not.stringContaining('/api/artifacts/internal-image/download'),
        }));
    });

    test('reuses selected image artifacts instead of falling back to Unsplash on prior-image follow-ups', async () => {
        isConfigured.mockReturnValue(true);
        artifactStore.get.mockResolvedValue({
            id: 'image-artifact-1',
            sessionId: 'session-1',
            filename: 'generated-image-01.png',
            extension: 'png',
            mimeType: 'image/png',
            metadata: {
                generatedBy: 'image-generate',
                title: 'Verified generated beach image',
            },
        });

        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Beach PDF',
                        sections: [
                            { heading: 'Overview', purpose: 'Summarize the image set', keyPoints: ['Visual theme'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Beach PDF',
                        sections: [
                            { heading: 'Overview', content: 'Overview content', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>Beach PDF</h1><img src="/api/artifacts/image-artifact-1/download?inline=1" alt="Verified generated beach image"></body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-1', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Make a PDF with those images from earlier.',
            format: 'pdf',
            artifactIds: ['image-artifact-1'],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(searchImages).not.toHaveBeenCalled();
        const instructions = createResponse.mock.calls.map((call) => call[0]?.instructions || '').join('\n\n---\n\n');
        expect(instructions).toContain('/api/artifacts/image-artifact-1/download?inline=1');
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('/api/artifacts/image-artifact-1/download?inline=1'),
        }));
    });

    test('recovers when composition returns a layout plan instead of final html', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Photo Brief',
                        sections: [
                            { heading: 'Overview', purpose: 'Summarize the brief', keyPoints: ['Goal'], targetLength: 'short' },
                            { heading: 'Gallery Notes', purpose: 'Explain the images', keyPoints: ['Verified photos'], targetLength: 'medium' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Photo Brief',
                        sections: [
                            { heading: 'Overview', content: 'TODO: replace this overview.\nThis is the real overview content.\nInsert citations here.', level: 1 },
                            { heading: 'Gallery Notes', content: '- Verified Unsplash photos\nTBD\n- Coherent sequence\nThis section should explain the image order later.', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: [
                        'Page Layout Plan',
                        'The layout should keep attention on the verified photographs.',
                        'Credits And Source Register',
                        'Final Build Checks',
                    ].join('\n\n') }],
                }],
            });

        await artifactService.generateArtifact({
            session: {
                previousResponseId: 'prev-1',
                metadata: {
                    projectMemory: {
                        urls: [
                            {
                                url: 'https://images.unsplash.com/photo-321',
                                kind: 'image',
                                title: 'Verified photo',
                                source: 'tool',
                                toolId: 'image-search-unsplash',
                            },
                        ],
                    },
                },
            },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a polished PDF photo brief using the verified session images.',
            format: 'pdf',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            format: 'pdf',
            content: expect.stringContaining('<!DOCTYPE html>'),
        }));
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('This is the real overview content.'),
        }));
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.not.stringContaining('TODO'),
        }));
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.not.stringContaining('TBD'),
        }));
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.not.stringContaining('Insert citations here'),
        }));
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.not.stringContaining('This section should explain'),
        }));
        expect(renderArtifact).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('https://images.unsplash.com/photo-321'),
        }));
        expect(artifactStore.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                compositionRecovered: true,
            }),
        }));
    });

    test('does not fetch generic unsplash images for subject-free html prompts', async () => {
        isConfigured.mockReturnValue(true);
        searchImages.mockResolvedValue({
            results: [{
                description: 'Should not be used',
                urls: { regular: 'https://images.unsplash.com/photo-unused' },
            }],
        });

        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Studio Casefile',
                        sections: [
                            { heading: 'Readiness', purpose: 'Assess readiness', keyPoints: ['Decision'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Studio Casefile',
                        sections: [
                            { heading: 'Readiness', content: 'We can produce a draft now, but the factual layer needs another research pass.', level: 1 },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: '<!DOCTYPE html><html><body><h1>Studio Casefile</h1><p>Ready.</p></body></html>' }],
                }],
            });

        await artifactService.generateArtifact({
            session: { previousResponseId: 'prev-generic', metadata: {} },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Do we have enough resources to build the article and HTML file now?',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        expect(searchImages).not.toHaveBeenCalled();
    });

    test('strips tool-workflow residue and noisy image titles from recovered html', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Studio Casefile',
                        sections: [
                            { heading: 'Readiness check', purpose: 'Assess whether the work can start now.', keyPoints: ['Decision'], targetLength: 'short' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Studio Casefile',
                        sections: [
                            {
                                heading: 'Readiness check',
                                content: [
                                    'Current-information request should start with Perplexity-backed web search.',
                                    'Current-information request should start with Perplexity-backed web search. Source: tool',
                                    'Yes, there is enough material on hand to produce a credible article draft now.',
                                ].join('\n\n'),
                                level: 1,
                            },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose',
                output: [{
                    type: 'message',
                    content: [{ text: 'Page Layout Plan\n\nThe layout should remain editorial.' }],
                }],
            });

        await artifactService.generateArtifact({
            session: {
                previousResponseId: 'prev-residue',
                metadata: {
                    projectMemory: {
                        urls: [{
                            url: 'https://images.unsplash.com/photo-321',
                            kind: 'image',
                            title: 'close up, bokeh, bible, new testament, christian, history, text, reading, bible study, devotions',
                            source: 'unsplash',
                            toolId: 'image-search-unsplash',
                        }],
                    },
                },
            },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a polished HTML case study using the verified session images.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        const renderedHtml = renderArtifact.mock.calls[0][0]?.content || '';
        expect(renderedHtml).toContain('Yes, there is enough material on hand to produce a credible article draft now.');
        expect(renderedHtml).not.toContain('Current-information request should start with Perplexity-backed web search.');
        expect(renderedHtml).not.toContain('Source: tool');
        expect(renderedHtml).not.toContain('bokeh, bible');
    });

    test('recovers outline-style composition output without leaking planning labels or artifact source captions', async () => {
        createResponse
            .mockResolvedValueOnce({
                id: 'resp-plan-calgary',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Calgary This Week',
                        sections: [
                            { heading: 'Calgary, Right Now', purpose: 'Establish the weekly angle', keyPoints: ['Downtown and riverfront'], targetLength: 'short' },
                            { heading: 'A Practical 7-Day Calgary Plan', purpose: 'Lay out the city week rhythm', keyPoints: ['Morning and evening pacing'], targetLength: 'medium' },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-expand-calgary',
                output: [{
                    type: 'message',
                    content: [{ text: JSON.stringify({
                        title: 'Calgary This Week',
                        sections: [
                            {
                                heading: 'Calgary, Right Now',
                                content: 'Calgary works best when you treat the Bow River paths, downtown architecture, and neighborhood food stops as one connected loop.',
                                level: 1,
                                kicker: 'This week',
                            },
                            {
                                heading: 'A Practical 7-Day Calgary Plan',
                                content: 'Use river walks and East Village early, then swap in Studio Bell, the Central Library, or other indoor anchors when the weather turns.',
                                level: 1,
                            },
                        ],
                    }) }],
                }],
            })
            .mockResolvedValueOnce({
                id: 'resp-compose-calgary',
                output: [{
                    type: 'message',
                    content: [{ text: [
                        'Editorial Feature',
                        '7 sections',
                        'story block',
                        'Calgary, Right Now',
                        'can you do some research on what to do in calgary and Source: artifact',
                        'A Practical 7-Day Calgary Plan',
                    ].join('\n\n') }],
                }],
            });

        await artifactService.generateArtifact({
            session: {
                previousResponseId: 'prev-calgary',
                metadata: {
                    projectMemory: {
                        urls: [{
                            url: '/api/artifacts/calgary-hero/download?inline=1',
                            kind: 'image',
                            title: 'can you do some research on what to do in calgary and',
                            source: 'artifact',
                        }],
                    },
                },
            },
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Create a practical HTML city guide for Calgary this week.',
            format: 'html',
            artifactIds: [],
            existingContent: '',
            model: 'gpt-5.3',
        });

        const renderedHtml = renderArtifact.mock.calls[0][0]?.content || '';
        expect(renderedHtml).toContain('Calgary works best when you treat the Bow River paths, downtown architecture, and neighborhood food stops as one connected loop.');
        expect(renderedHtml).toContain('A Practical 7-Day Calgary Plan');
        expect(renderedHtml).not.toContain('Editorial Feature');
        expect(renderedHtml).not.toContain('story block');
        expect(renderedHtml).not.toContain('Source: artifact');
        expect(renderedHtml).not.toContain('can you do some research on what to do in calgary and');
    });
});

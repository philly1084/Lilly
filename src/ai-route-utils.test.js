jest.mock('./artifacts/artifact-service', () => ({
    artifactService: {
        buildPromptContext: jest.fn(),
        canStoreArtifacts: jest.fn(() => true),
        generateArtifact: jest.fn(),
        getArtifact: jest.fn(),
    },
}));

jest.mock('./routes/admin/settings.controller', () => ({
    getEffectiveSshConfig: jest.fn(() => ({
        enabled: false,
        host: '',
        port: 22,
        username: '',
        password: '',
        privateKeyPath: '',
    })),
}));

const { artifactService } = require('./artifacts/artifact-service');
const settingsController = require('./routes/admin/settings.controller');
const {
    buildImagePromptFromArtifactRequest,
    buildArtifactCompletionMessage,
    extractRequestedImageCount,
    generateOutputArtifactFromPrompt,
    extractSshSessionMetadataFromToolEvents,
    hasExplicitArtifactDeliveryIntent,
    hasExplicitImageGenerationIntent,
    hasExplicitMermaidFileIntent,
    hasExplicitStandaloneHtmlIntent,
    hasPlanningConversationIntent,
    hasImplicitNotesPageBuildIntent,
    hasExplicitNotesPageEditIntent,
    stripInjectedNotesPageEditDirective,
    inferRequestedOutputFormat,
    inferOutputFormatFromSession,
    maybePrepareImagesForArtifactPrompt,
    getPreferredRemoteToolId,
    resolveDeferredWorkloadPreflight,
    resolveReasoningEffort,
    resolveSshRequestContext,
    resolveArtifactContextIds,
    buildUserInputWithImageArtifacts,
    shouldPreGenerateImagesForArtifactRequest,
    shouldDeferArtifactGenerationToWorkload,
    shouldSuppressNotesSurfaceArtifact,
    shouldSuppressImplicitMermaidArtifact,
    shouldSuppressWebChatImplicitHtmlArtifact,
} = require('./ai-route-utils');

describe('ai-route-utils', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: false,
            host: '',
            port: 22,
            username: '',
            password: '',
            privateKeyPath: '',
        });
    });

    test('buildArtifactCompletionMessage formats friendly labels', () => {
        expect(buildArtifactCompletionMessage('pdf', { filename: 'space-zine.pdf' }))
            .toBe('Created the PDF artifact (space-zine.pdf).');
    });

    test('buildArtifactCompletionMessage gives site bundles the normal preview URL first', () => {
        expect(buildArtifactCompletionMessage('html', {
            filename: 'site.html',
            previewUrl: '/api/artifacts/site-1/preview',
            sandboxUrl: '/api/artifacts/site-1/sandbox',
            bundleDownloadUrl: '/api/artifacts/site-1/bundle',
            metadata: { siteBundle: true },
        })).toContain('Play it: /api/artifacts/site-1/preview');
    });

    test('shouldDeferArtifactGenerationToWorkload detects scheduled artifact requests', () => {
        expect(shouldDeferArtifactGenerationToWorkload(
            'can you do web search on penguins and then make a pdf for me but schedule it for 5 minutes from now',
            'pdf',
        )).toBe(true);
        expect(shouldDeferArtifactGenerationToWorkload(
            'in 5 minutes can you do some research on adhd and make a pdf document on it I can review',
            'pdf',
        )).toBe(true);
        expect(shouldDeferArtifactGenerationToWorkload(
            'make me a pdf about penguins right now',
            'pdf',
        )).toBe(false);
        expect(shouldDeferArtifactGenerationToWorkload(
            'make me a pdf of today\'s news',
            'pdf',
        )).toBe(false);
        expect(shouldDeferArtifactGenerationToWorkload(
            'make me a pdf about daily adhd traits',
            'pdf',
        )).toBe(false);
        expect(shouldDeferArtifactGenerationToWorkload(
            'make me a pdf now, not later',
            'pdf',
        )).toBe(false);
        expect(shouldDeferArtifactGenerationToWorkload(
            'make me a pdf later',
            'pdf',
        )).toBe(false);
    });

    test('resolveDeferredWorkloadPreflight uses transcript context for fragmented future requests', () => {
        expect(resolveDeferredWorkloadPreflight({
            text: 'in five minutes from now',
            recentMessages: [
                { role: 'user', content: 'do some research on adhd and make a pdf document on it I can review' },
            ],
            timezone: 'UTC',
            now: '2026-04-03T14:47:00.000Z',
        })).toMatchObject({
            timing: 'future',
            shouldSchedule: true,
            request: expect.stringContaining('do some research on adhd'),
            scenario: {
                trigger: {
                    type: 'once',
                    runAt: '2026-04-03T14:52:00.000Z',
                },
            },
        });
    });

    test('resolveDeferredWorkloadPreflight does not keep prior schedule context sticky for a new task turn', () => {
        expect(resolveDeferredWorkloadPreflight({
            text: 'do some research on adhd and make a pdf document on it I can review',
            recentMessages: [
                { role: 'user', content: 'in five minutes from now' },
            ],
            timezone: 'UTC',
            now: '2026-04-03T14:47:00.000Z',
        })).toMatchObject({
            timing: 'now',
            shouldSchedule: false,
            scenario: null,
        });
    });

    test('resolveDeferredWorkloadPreflight keeps greetings out of scheduled workload routing', () => {
        expect(resolveDeferredWorkloadPreflight({
            text: 'hi',
            recentMessages: [
                { role: 'user', content: 'in five minutes from now' },
            ],
            timezone: 'UTC',
            now: '2026-04-03T14:47:00.000Z',
        })).toMatchObject({
            timing: 'now',
            shouldSchedule: false,
            scenario: null,
        });
    });

    test('resolveDeferredWorkloadPreflight does not schedule from tomorrow alone', () => {
        expect(resolveDeferredWorkloadPreflight({
            text: 'tomorrow works for me',
            timezone: 'UTC',
            now: '2026-04-03T14:47:00.000Z',
        })).toMatchObject({
            timing: 'now',
            shouldSchedule: false,
            scenario: null,
        });
    });

    test('generateOutputArtifactFromPrompt requires a user prompt', async () => {
        await expect(generateOutputArtifactFromPrompt({
            sessionId: 'session-1',
            mode: 'chat',
            outputFormat: 'pdf',
            prompt: '',
        })).rejects.toMatchObject({
            message: 'A user prompt is required to generate an output artifact',
            statusCode: 400,
        });
    });

    test('generateOutputArtifactFromPrompt returns artifact metadata and completion text', async () => {
        artifactService.generateArtifact.mockResolvedValue({
            responseId: 'resp-1',
            artifact: {
                id: 'artifact-1',
                filename: 'space-zine.pdf',
            },
            outputText: '<html><body>Space zine</body></html>',
        });

        await expect(generateOutputArtifactFromPrompt({
            sessionId: 'session-1',
            mode: 'chat',
            outputFormat: 'pdf',
            prompt: 'Make me a PDF about space',
            artifactIds: ['artifact-a'],
            model: 'gpt-test',
        })).resolves.toEqual({
            responseId: 'resp-1',
            artifact: {
                id: 'artifact-1',
                filename: 'space-zine.pdf',
            },
            artifacts: [{
                id: 'artifact-1',
                filename: 'space-zine.pdf',
            }],
            outputText: '<html><body>Space zine</body></html>',
            model: 'gpt-test',
            assistantMessage: 'Created the PDF artifact (space-zine.pdf).',
            metadata: {},
        });

        expect(artifactService.generateArtifact).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            mode: 'chat',
            prompt: 'Make me a PDF about space',
            format: 'pdf',
            artifactIds: ['artifact-a'],
            model: 'gpt-test',
        }));
    });

    test('generateOutputArtifactFromPrompt prefers document-workflow sandbox for project-like html artifacts', async () => {
        const toolManager = {
            getTool: jest.fn(() => ({ id: 'document-workflow' })),
            executeTool: jest.fn(async () => ({
                success: true,
                data: {
                    sandboxBuild: {
                        artifact: {
                            id: 'sandbox-artifact-1',
                            filename: 'onboarding.zip',
                            mimeType: 'application/zip',
                            downloadUrl: '/api/artifacts/sandbox-artifact-1/download',
                            previewUrl: '/api/artifacts/sandbox-artifact-1/preview',
                            sandboxUrl: '/api/artifacts/sandbox-artifact-1/sandbox',
                            bundleDownloadUrl: '/api/artifacts/sandbox-artifact-1/bundle',
                        },
                    },
                },
            })),
        };

        const result = await generateOutputArtifactFromPrompt({
            sessionId: 'session-sandbox-1',
            mode: 'chat',
            outputFormat: 'html',
            prompt: 'Create a document about onboarding new support agents.',
            toolManager,
            toolContext: { route: '/v1/responses' },
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'document-workflow',
            expect.objectContaining({
                action: 'generate-suite',
                formats: ['html'],
                buildMode: 'sandbox',
                useSandbox: true,
            }),
            expect.objectContaining({
                sessionId: 'session-sandbox-1',
                toolManager,
            }),
        );
        expect(artifactService.generateArtifact).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
            artifact: expect.objectContaining({
                id: 'sandbox-artifact-1',
                sandboxUrl: '/api/artifacts/sandbox-artifact-1/sandbox',
            }),
            artifacts: [
                expect.objectContaining({ id: 'sandbox-artifact-1' }),
            ],
            metadata: expect.objectContaining({
                agentSandbox: true,
                toolEvents: expect.any(Array),
            }),
        }));
    });

    test('generateOutputArtifactFromPrompt carries exact token usage metadata when artifact generation reports it', async () => {
        artifactService.generateArtifact.mockResolvedValue({
            responseId: 'resp-2',
            artifact: {
                id: 'artifact-2',
                filename: 'deep-dive.pdf',
            },
            outputText: '<html><body>Deep dive</body></html>',
            usage: {
                promptTokens: 120,
                completionTokens: 80,
                totalTokens: 200,
                modelCalls: 3,
            },
        });

        await expect(generateOutputArtifactFromPrompt({
            sessionId: 'session-2',
            mode: 'chat',
            outputFormat: 'pdf',
            prompt: 'Build a research PDF',
        })).resolves.toMatchObject({
            responseId: 'resp-2',
            metadata: {
                usage: {
                    promptTokens: 120,
                    completionTokens: 80,
                    totalTokens: 200,
                    modelCalls: 3,
                },
                tokenUsage: {
                    promptTokens: 120,
                    completionTokens: 80,
                    totalTokens: 200,
                    modelCalls: 3,
                },
            },
        });
    });

    test('inferOutputFormatFromSession keeps artifact workflows sticky on continuation turns', () => {
        expect(inferOutputFormatFromSession('another pass, keep the pacing quieter', {
            metadata: {
                lastOutputFormat: 'pdf',
                lastGeneratedArtifactId: 'artifact-1',
            },
        })).toBe('pdf');
    });

    test('inferOutputFormatFromSession does not reuse the last artifact on bare continue when a foreground workflow is paused', () => {
        expect(inferOutputFormatFromSession('continue', {
            metadata: {
                lastOutputFormat: 'html',
                lastGeneratedArtifactId: 'artifact-1',
            },
            controlState: {
                foregroundContinuationGate: {
                    paused: true,
                },
                activeTaskFrame: {
                    objective: 'Deploy the site on the server and verify TLS.',
                },
                lastRemoteObjective: 'Deploy the site on the server and verify TLS.',
            },
        })).toBeNull();
    });

    test('inferOutputFormatFromSession keeps explicit artifact follow-ups even when a foreground workflow is paused', () => {
        expect(inferOutputFormatFromSession('continue that pdf and tighten the summary', {
            metadata: {
                lastOutputFormat: 'pdf',
                lastGeneratedArtifactId: 'artifact-1',
            },
            controlState: {
                foregroundContinuationGate: {
                    paused: true,
                },
                activeTaskFrame: {
                    objective: 'Deploy the site on the server and verify TLS.',
                },
            },
        })).toBe('pdf');
    });

    test('inferRequestedOutputFormat does not treat casual diagram mentions as mermaid exports', () => {
        expect(inferRequestedOutputFormat('Can you explain the architecture diagram from earlier?')).toBeNull();
        expect(inferRequestedOutputFormat('I want the content, not a diagram.')).toBeNull();
    });

    test('inferRequestedOutputFormat requires an explicit mermaid export request', () => {
        expect(inferRequestedOutputFormat('Create a Mermaid diagram for the auth flow')).toBe('mermaid');
        expect(inferRequestedOutputFormat('Export this as a Mermaid file')).toBe('mermaid');
    });

    test('inferRequestedOutputFormat auto-selects html for explicit html, sandbox preview, or prototype-style website requests', () => {
        expect(inferRequestedOutputFormat('Build a landing page for a climate startup')).toBe('html');
        expect(inferRequestedOutputFormat('Create a frontend demo microsite for our product launch')).toBe('html');
        expect(inferRequestedOutputFormat('Create an admin dashboard HTML for customer support ops')).toBe('html');
        expect(inferRequestedOutputFormat('Make a website mockup for a fintech launch')).toBe('html');
        expect(inferRequestedOutputFormat('Make a webpage with NASA facts and a calendar of upcoming skywatching events')).toBe('html');
        expect(inferRequestedOutputFormat('Build a sandbox weather webpage with current conditions cards')).toBe('html');
        expect(inferRequestedOutputFormat('Create a weather web page with a browser preview')).toBe('html');
        expect(inferRequestedOutputFormat('This was supposed to be a sandbox built HTML page')).toBe('html');
        expect(inferRequestedOutputFormat('Create website slides for a fintech launch that I can reuse as a Vite template')).toBe('html');
        expect(inferRequestedOutputFormat('Build an executive brief template as a frontend example for our web design system')).toBe('html');
        expect(inferRequestedOutputFormat('Build a playable browser game with a Vite preview')).toBe('html');
        expect(inferRequestedOutputFormat('Make me a video game about collecting blocks')).toBe('html');
        expect(inferRequestedOutputFormat('Build a sandboxed game with restart controls')).toBe('html');
        expect(inferRequestedOutputFormat('Make a multi-step frontend sandbox for an onboarding flow')).toBe('html');
    });

    test('inferRequestedOutputFormat defaults slide deck requests to pptx unless html or interactive is explicit', () => {
        expect(inferRequestedOutputFormat('Can you make me slides on FGZEUM?')).toBe('pptx');
        expect(inferRequestedOutputFormat('Create a website slide deck for the launch story.')).toBe('pptx');
        expect(inferRequestedOutputFormat('Create an interactive slide deck for the launch story.')).toBe('html');
        expect(inferRequestedOutputFormat('Create slides in HTML for the launch story.')).toBe('html');
    });

    test('inferRequestedOutputFormat auto-selects html for interactive research documents', () => {
        expect(inferRequestedOutputFormat('Do some research on AI browser tools and make it an interactive document with filters.')).toBe('html');
        expect(inferRequestedOutputFormat('Create a source-backed research dashboard about local robotics grants.')).toBe('html');
        expect(inferRequestedOutputFormat('Build a research page comparing leading AI coding agents with citations.')).toBe('html');
        expect(inferRequestedOutputFormat('Create a research paper about penguins with images and citations.')).toBe('html');
        expect(inferRequestedOutputFormat('Make a long-form evidence document on penguin habitats.')).toBe('html');
        expect(inferRequestedOutputFormat('Do some research on AI browser tools.')).toBeNull();
    });

    test('inferRequestedOutputFormat treats generic document creation as an artifact unless text-only is explicit', () => {
        expect(inferRequestedOutputFormat('Create a document about onboarding new support agents.')).toBe('html');
        expect(inferRequestedOutputFormat('Make a professional brief for the product launch.')).toBe('html');
        expect(inferRequestedOutputFormat('Draft a plain text document about onboarding new support agents.')).toBeNull();
        expect(inferRequestedOutputFormat('Create a document about onboarding new support agents, no artifact.')).toBeNull();
    });

    test('hasExplicitMermaidFileIntent only returns true for file-like Mermaid requests', () => {
        expect(hasExplicitMermaidFileIntent('Create a Mermaid diagram for the auth flow')).toBe(false);
        expect(hasExplicitMermaidFileIntent('Export this as a Mermaid file')).toBe(true);
        expect(hasExplicitMermaidFileIntent('Share a .mmd artifact for this flow')).toBe(true);
    });

    test('distinguishes notes page edits from explicit artifact delivery requests', () => {
        expect(hasExplicitNotesPageEditIntent('Put this on the page as a polished hypercar brochure.')).toBe(true);
        expect(hasImplicitNotesPageBuildIntent('Can you make me an HTML page about tropical fish with sections for habitat and care?')).toBe(true);
        expect(hasPlanningConversationIntent('Help me plan the structure for an HTML page about tropical fish before you write it.')).toBe(true);
        expect(hasPlanningConversationIntent('Put this implementation plan on the page as a structured brief.')).toBe(false);
        expect(hasExplicitStandaloneHtmlIntent('Create a standalone HTML page I can use outside notes.')).toBe(true);
        expect(hasExplicitArtifactDeliveryIntent('Export a PDF file and add the download link to the page.')).toBe(true);
        expect(hasExplicitArtifactDeliveryIntent('Put this on the page as a polished hypercar brochure.')).toBe(false);
    });

    test('detects explicit image generation intent without confusing follow-up image references', () => {
        expect(hasExplicitImageGenerationIntent('Make a hypercar image and put it in a PDF brochure.')).toBe(true);
        expect(hasExplicitImageGenerationIntent('Make a PDF with those images from earlier.')).toBe(false);
    });

    test('extracts an image-only prompt from mixed image-plus-artifact requests', () => {
        expect(buildImagePromptFromArtifactRequest('Make a hypercar image and put it in a PDF brochure.'))
            .toBe('Make a hypercar image');
    });

    test('extracts requested image counts and strips batch wording from image prompts', () => {
        expect(extractRequestedImageCount('Generate 3 hypercar images and put them in a PDF brochure.')).toBe(3);
        expect(extractRequestedImageCount('Create a couple of hero images for the landing page.')).toBe(2);
        expect(buildImagePromptFromArtifactRequest('Generate 3 hypercar images and put them in a PDF brochure.'))
            .toBe('Generate hypercar image');
    });

    test('only pre-generates images for explicit image-plus-document requests', () => {
        expect(shouldPreGenerateImagesForArtifactRequest({
            text: 'Make a hypercar image and put it in a PDF brochure.',
            outputFormat: 'pdf',
        })).toBe(true);

        expect(shouldPreGenerateImagesForArtifactRequest({
            text: 'Make a webpage with generated planet images and NASA facts.',
            outputFormat: 'html',
        })).toBe(true);

        expect(shouldPreGenerateImagesForArtifactRequest({
            text: 'Make a PDF with those images from earlier.',
            outputFormat: 'pdf',
        })).toBe(false);
    });

    test('shouldSuppressImplicitMermaidArtifact keeps Mermaid inline for notes unless export was explicit', () => {
        expect(shouldSuppressImplicitMermaidArtifact({
            taskType: 'notes',
            text: 'Create a Mermaid diagram for the auth flow inside this page',
            outputFormat: 'mermaid',
            outputFormatProvided: false,
        })).toBe(true);

        expect(shouldSuppressImplicitMermaidArtifact({
            taskType: 'notes',
            text: 'Export this as a Mermaid file',
            outputFormat: 'mermaid',
            outputFormatProvided: false,
        })).toBe(false);

        expect(shouldSuppressImplicitMermaidArtifact({
            taskType: 'notes',
            text: 'Create a Mermaid diagram for the auth flow',
            outputFormat: 'mermaid',
            outputFormatProvided: true,
        })).toBe(false);
    });

    test('shouldSuppressNotesSurfaceArtifact keeps notes page edits inline unless file delivery was explicit', () => {
        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Put this hypercar collection on the page as a polished brochure PDF.',
            outputFormat: 'pdf',
            outputFormatProvided: true,
        })).toBe(true);

        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Export this as a PDF file and add the download link to the page.',
            outputFormat: 'pdf',
            outputFormatProvided: true,
        })).toBe(false);

        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Can you make me an HTML page about tropical fish with sections for habitat and care?',
            outputFormat: 'html',
            outputFormatProvided: false,
        })).toBe(true);

        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Create an HTML file I can download for a tropical fish landing page.',
            outputFormat: 'html',
            outputFormatProvided: false,
        })).toBe(false);

        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Help me plan the structure for an HTML page about tropical fish before you write it.',
            outputFormat: 'html',
            outputFormatProvided: false,
        })).toBe(true);

        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Can you make this about pigeons?',
            outputFormat: 'html',
            outputFormatProvided: false,
        })).toBe(true);

        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Create a standalone HTML page for me to download.',
            outputFormat: 'html',
            outputFormatProvided: false,
        })).toBe(false);
    });

    test('shouldSuppressNotesSurfaceArtifact keeps Power Query inline on notes unless file delivery was explicit', () => {
        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Write a Power Query script to clean these columns and put it in the note.',
            outputFormat: 'power-query',
            outputFormatProvided: false,
        })).toBe(true);

        expect(shouldSuppressNotesSurfaceArtifact({
            taskType: 'notes',
            text: 'Create a Power Query file and give me the artifact link.',
            outputFormat: 'power-query',
            outputFormatProvided: false,
        })).toBe(false);
    });

    test('inferOutputFormatFromSession does not keep mermaid sticky on generic continuation turns', () => {
        expect(inferOutputFormatFromSession('another pass, keep the pacing quieter', {
            metadata: {
                lastOutputFormat: 'mermaid',
                lastGeneratedArtifactId: 'artifact-1',
            },
        })).toBeNull();

        expect(inferOutputFormatFromSession('continue the diagram and add retries', {
            metadata: {
                lastOutputFormat: 'mermaid',
                lastGeneratedArtifactId: 'artifact-1',
            },
        })).toBe('mermaid');
    });

    test('inferOutputFormatFromSession exits sticky html continuation on implementation-transition turns', () => {
        expect(inferOutputFormatFromSession('Start making it on the server instead of showing more examples.', {
            metadata: {
                lastOutputFormat: 'html',
                lastGeneratedArtifactId: 'artifact-1',
            },
        })).toBeNull();
    });

    test('resolveArtifactContextIds falls back to the last generated artifact on continuation turns', () => {
        expect(resolveArtifactContextIds({
            metadata: {
                lastGeneratedArtifactId: 'artifact-1',
            },
        }, [], 'another pass, keep refining that html file')).toEqual(['artifact-1']);
    });

    test('stripInjectedNotesPageEditDirective removes frontend notes routing instructions from the user turn', () => {
        expect(stripInjectedNotesPageEditDirective(
            'Create a page about penguins.\n\nInterpret "page" as the current notes page shown in this editor. This is a direct page edit request, so return notes-actions that apply the content to the current notes page unless the user explicitly says web page, site page, repo file, or server component. Put the result into page blocks. Do not reply with chat prose alone. Do not create standalone HTML, file, export, artifact, or download-link output unless the user explicitly asked for that.',
        )).toBe('Create a page about penguins.');
    });

    test('keeps inferred html artifacts on web-chat so html requests generate downloadable files', () => {
        expect(shouldSuppressWebChatImplicitHtmlArtifact({
            clientSurface: 'web-chat',
            text: 'Make me a fresh HTML sun dashboard in the same mission-control direction.',
            outputFormat: 'html',
            outputFormatProvided: false,
        })).toBe(false);
    });

    test('keeps explicit html delivery requests on web-chat in the artifact path', () => {
        expect(shouldSuppressWebChatImplicitHtmlArtifact({
            clientSurface: 'web-chat',
            text: 'Create a downloadable HTML file for the sun dashboard.',
            outputFormat: 'html',
            outputFormatProvided: false,
        })).toBe(false);
    });

    test('still suppresses inferred html artifacts on web-chat for planning-only requests', () => {
        expect(shouldSuppressWebChatImplicitHtmlArtifact({
            clientSurface: 'web-chat',
            text: 'Help me plan the structure for an HTML page before you write it.',
            outputFormat: 'html',
            outputFormatProvided: false,
        })).toBe(true);
    });

    test('resolveArtifactContextIds prefers the last generated image artifacts for image follow-ups', () => {
        expect(resolveArtifactContextIds({
            metadata: {
                lastGeneratedArtifactId: 'artifact-1',
                lastGeneratedImageArtifactIds: ['image-1', 'image-2'],
            },
        }, [], 'make a pdf with those images from earlier')).toEqual(['image-1', 'image-2']);

        expect(resolveArtifactContextIds({
            metadata: {
                lastGeneratedArtifactId: 'artifact-1',
                lastGeneratedImageArtifactIds: ['image-world'],
            },
        }, [], 'make a webpage and make this the static background with lights going around it')).toEqual(['image-world']);
    });

    test('resolveArtifactContextIds does not carry old artifacts into explicit new-image requests', () => {
        expect(resolveArtifactContextIds({
            metadata: {
                lastGeneratedArtifactId: 'artifact-1',
                lastGeneratedImageArtifactIds: ['image-1', 'image-2'],
            },
        }, [], 'Generate more hypercar images and then make a document with it.')).toEqual([]);
    });

    test('resolveArtifactContextIds uses recently uploaded images for explicit image follow-ups', () => {
        expect(resolveArtifactContextIds({
            metadata: {
                lastUploadedImageArtifactIds: ['upload-image-1'],
            },
        }, [], 'what is in this image?')).toEqual(['upload-image-1']);
    });

    test('buildUserInputWithImageArtifacts sends uploaded images as OpenAI vision parts', async () => {
        artifactService.getArtifact.mockResolvedValue({
            id: 'upload-image-1',
            sessionId: 'session-1',
            extension: 'png',
            mimeType: 'image/png',
            contentBuffer: Buffer.from('image-bytes'),
        });

        await expect(buildUserInputWithImageArtifacts({
            sessionId: 'session-1',
            text: 'Describe this image.',
            artifactIds: ['upload-image-1'],
        })).resolves.toEqual([
            { type: 'input_text', text: 'Describe this image.' },
            {
                type: 'input_image',
                image_url: `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
                detail: 'auto',
            },
        ]);
    });

    test('resolveArtifactContextIds does not attach the last generated artifact on unrelated turns', () => {
        expect(resolveArtifactContextIds({
            metadata: {
                lastGeneratedArtifactId: 'artifact-1',
            },
        }, [], 'deploy the site online and verify the public route')).toEqual([]);
    });

    test('remote deploy address follow-ups do not silently reuse the last generated website artifact', () => {
        const session = {
            metadata: {
                lastOutputFormat: 'html',
                lastGeneratedArtifactId: 'artifact-website-1',
            },
        };

        expect(inferOutputFormatFromSession('use a new address with remote cli agent to deploy th', session)).toBeNull();
        expect(resolveArtifactContextIds(session, [], 'use a new address with remote cli agent to deploy th')).toEqual([]);
    });

    test('resolveArtifactContextIds does not keep html artifacts attached on implementation-transition turns', () => {
        expect(resolveArtifactContextIds({
            metadata: {
                lastGeneratedArtifactId: 'artifact-1',
            },
        }, [], 'Go ahead and build it for real on the server now.')).toEqual([]);
    });

    test('maybePrepareImagesForArtifactPrompt executes image generation and merges artifact ids', async () => {
        const toolManager = {
            getTool: jest.fn(() => ({ id: 'image-generate' })),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'image-generate',
                data: {
                    artifacts: [{ id: 'image-1', filename: 'hypercar-01.png' }],
                },
            }),
        };

        await expect(maybePrepareImagesForArtifactPrompt({
            toolManager,
            sessionId: 'session-1',
            route: '/api/chat',
            transport: 'http',
            taskType: 'chat',
            text: 'Make a hypercar image and put it in a PDF brochure.',
            outputFormat: 'pdf',
            artifactIds: ['existing-1'],
        })).resolves.toEqual({
            artifactIds: ['existing-1', 'image-1'],
            artifacts: [{ id: 'image-1', filename: 'hypercar-01.png' }],
            imagePrompt: 'Make a hypercar image',
            resetPreviousResponse: true,
            toolEvents: [expect.objectContaining({
                reason: 'Generate image artifacts before creating the pdf artifact.',
                result: expect.objectContaining({
                    success: true,
                    toolId: 'image-generate',
                }),
            })],
        });
    });

    test('maybePrepareImagesForArtifactPrompt passes explicit multi-image counts through to the image tool', async () => {
        const toolManager = {
            getTool: jest.fn(() => ({ id: 'image-generate' })),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'image-generate',
                data: {
                    artifacts: [
                        { id: 'image-1', filename: 'hypercar-01.png' },
                        { id: 'image-2', filename: 'hypercar-02.png' },
                        { id: 'image-3', filename: 'hypercar-03.png' },
                    ],
                },
            }),
        };

        await maybePrepareImagesForArtifactPrompt({
            toolManager,
            sessionId: 'session-1',
            route: '/api/chat',
            transport: 'http',
            taskType: 'chat',
            text: 'Generate 3 hypercar images and put them in a PDF brochure.',
            outputFormat: 'pdf',
            artifactIds: [],
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'image-generate',
            expect.objectContaining({
                prompt: 'Generate hypercar image',
                n: 3,
            }),
            expect.any(Object),
        );
    });

    test('getPreferredRemoteToolId prefers remote-command when both SSH tools exist', () => {
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['ssh-execute', 'remote-command'].includes(toolId)
                    ? { id: toolId }
                    : null
            )),
        };

        expect(getPreferredRemoteToolId(toolManager)).toBe('remote-command');
    });

    test('resolveReasoningEffort accepts camelCase, snake_case, and OpenAI-style reasoning objects', () => {
        expect(resolveReasoningEffort({ reasoningEffort: 'high' })).toBe('high');
        expect(resolveReasoningEffort({ reasoning_effort: 'medium' })).toBe('medium');
        expect(resolveReasoningEffort({ reasoning: { effort: 'low' } })).toBe('low');
        expect(resolveReasoningEffort({ reasoningEffort: 'invalid' })).toBeNull();
    });

    test('resolveSshRequestContext does not infer kubectl pod listing for generic cluster deployment continuations', () => {
        const sshContext = resolveSshRequestContext(
            'can you please set this up on the cluster. you will find everything you need on that cluster to deploy, you can move it to a pod on the cluster if you would like.',
            {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: 'test.demoserver2.buzz',
                        username: 'root',
                        port: 22,
                    },
                },
            },
        );

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.command).toBeNull();
        expect(sshContext.directParams).toBeNull();
    });

    test('resolveSshRequestContext infers a direct baseline command for health report phrasing', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const sshContext = resolveSshRequestContext('can you remote into the server and get a health report');

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.command).toBe('hostname && uptime && (df -h / || true) && (free -m || true)');
        expect(sshContext.directParams).toEqual({
            host: '10.0.0.5',
            username: 'ubuntu',
            port: 22,
            command: 'hostname && uptime && (df -h / || true) && (free -m || true)',
        });
    });

    test('resolveSshRequestContext infers a direct baseline command for server state phrasing', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const sshContext = resolveSshRequestContext('do a remote command and tell me the server state');

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.command).toBe('hostname && uptime && (df -h / || true) && (free -m || true)');
        expect(sshContext.directParams).toEqual({
            host: '10.0.0.5',
            username: 'ubuntu',
            port: 22,
            command: 'hostname && uptime && (df -h / || true) && (free -m || true)',
        });
    });

    test('resolveSshRequestContext treats remote CLI into user@host as an explicit remote target', () => {
        const sshContext = resolveSshRequestContext('Use remote CLI into root@162.55.163.199 and check server health');

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.target).toEqual({
            host: '162.55.163.199',
            username: 'root',
            port: null,
        });
        expect(sshContext.command).toBe('hostname && uptime && (df -h / || true) && (free -m || true)');
        expect(sshContext.directParams).toEqual({
            host: '162.55.163.199',
            username: 'root',
            command: 'hostname && uptime && (df -h / || true) && (free -m || true)',
        });
    });

    test('resolveSshRequestContext ignores public Git provider hosts in failure transcripts and uses the corrected server target', () => {
        const sshContext = resolveSshRequestContext([
            'I tried again, but the remote CLI is still pointed at the wrong SSH target.',
            'Exact failure: root@github.com: Permission denied (publickey).',
            'That means the tool attempted to SSH into github.com as root, instead of the server target we need.',
            'The next real unblock is to retarget the remote CLI session back to the server, likely root@162.55.163.199, then inspect /opt/calan-calendar.',
        ].join(' '));

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.target).toEqual({
            host: '162.55.163.199',
            username: 'root',
            port: null,
        });
        expect(sshContext.directParams).toBeNull();
    });

    test('resolveSshRequestContext does not reuse a public Git provider as a sticky SSH target', () => {
        const sshContext = resolveSshRequestContext(
            'try again to remote command',
            {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: 'github.com',
                        username: 'root',
                        port: 22,
                    },
                    remoteWorkingState: {
                        lastUpdated: new Date().toISOString(),
                        target: {
                            host: 'github.com',
                            username: 'root',
                            port: 22,
                        },
                        lastCommand: 'hostname && uptime',
                    },
                },
            },
        );

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.target).toBeNull();
        expect(sshContext.effectivePrompt).toBe('try again to remote command');
        expect(sshContext.directParams).toBeNull();
    });

    test('resolveSshRequestContext reuses the previous remote command for retry-style continuation prompts', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const sshContext = resolveSshRequestContext(
            'try again to remote command',
            {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: '10.0.0.5',
                        username: 'ubuntu',
                        port: 22,
                    },
                    remoteWorkingState: {
                        lastUpdated: new Date().toISOString(),
                        target: {
                            host: '10.0.0.5',
                            username: 'ubuntu',
                            port: 22,
                        },
                        lastCommand: 'hostname && uptime && (df -h / || true) && (free -m || true)',
                    },
                },
            },
        );

        expect(sshContext.continuation).toBe(true);
        expect(sshContext.command).toBe('hostname && uptime && (df -h / || true) && (free -m || true)');
        expect(sshContext.directParams).toEqual({
            host: '10.0.0.5',
            username: 'ubuntu',
            port: 22,
            command: 'hostname && uptime && (df -h / || true) && (free -m || true)',
        });
    });

    test('resolveSshRequestContext does not keep generic go-ahead sticky without fresh remote state', () => {
        const sshContext = resolveSshRequestContext(
            'go ahead',
            {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: 'test.demoserver2.buzz',
                        username: 'root',
                        port: 22,
                    },
                },
            },
        );

        expect(sshContext.shouldTreatAsSsh).toBe(false);
        expect(sshContext.effectivePrompt).toBe('go ahead');
    });

    test('resolveSshRequestContext keeps generic go-ahead sticky while remote state is fresh', () => {
        const sshContext = resolveSshRequestContext(
            'go ahead',
            {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: 'test.demoserver2.buzz',
                        username: 'root',
                        port: 22,
                    },
                    remoteWorkingState: {
                        lastUpdated: new Date().toISOString(),
                        target: {
                            host: 'test.demoserver2.buzz',
                            username: 'root',
                            port: 22,
                        },
                        lastCommand: 'kubectl describe pod -n gitea gitea-5479f795f8-pk2dp',
                    },
                },
            },
        );

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.effectivePrompt).toContain('SSH into root@test.demoserver2.buzz');
        expect(sshContext.command).toBeNull();
    });

    test('resolveSshRequestContext prefers configured SSH defaults over a suspicious sticky host', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '162.55.163.199',
            port: 22,
            username: 'root',
            password: 'secret',
            privateKeyPath: '',
        });

        const sshContext = resolveSshRequestContext(
            'go ahead',
            {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: 'web-fetch.body',
                        username: '',
                        port: 22,
                    },
                    remoteWorkingState: {
                        lastUpdated: new Date().toISOString(),
                        target: {
                            host: 'web-fetch.body',
                            username: '',
                            port: 22,
                        },
                        lastCommand: 'kubectl get deployment website',
                    },
                },
            },
        );

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.target).toEqual({
            host: '162.55.163.199',
            username: 'root',
            port: 22,
        });
        expect(sshContext.effectivePrompt).toContain('SSH into root@162.55.163.199');
    });

    test('resolveSshRequestContext does not treat an email address as an explicit SSH target override', () => {
        const sshContext = resolveSshRequestContext(
            'Please update the contact email to philly1084@gmail.com on the deployed site.',
            {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: '162.55.163.199',
                        username: 'root',
                        port: 22,
                    },
                    remoteWorkingState: {
                        lastUpdated: new Date().toISOString(),
                        target: {
                            host: '162.55.163.199',
                            username: 'root',
                            port: 22,
                        },
                        lastCommand: 'grep -R "support@" /opt/kimibuilt',
                    },
                },
            },
        );

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.target).toEqual({
            host: '162.55.163.199',
            username: 'root',
            port: 22,
        });
        expect(sshContext.effectivePrompt).toContain('SSH into root@162.55.163.199');
        expect(sshContext.effectivePrompt).toContain('philly1084@gmail.com');
    });

    test('resolveSshRequestContext does not treat lets-encrypt registration email domains as SSH hosts', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const sshContext = resolveSshRequestContext(
            'lets go ahead setting up with lets encrypt. We can use philly1084@gmail.com for the registration. remote command into the server to do it on the k3s cluster',
            {
                metadata: {},
            },
        );

        expect(sshContext.shouldTreatAsSsh).toBe(true);
        expect(sshContext.target).toEqual({
            host: '10.0.0.5',
            username: 'ubuntu',
            port: 22,
        });
        expect(sshContext.effectivePrompt).toContain('philly1084@gmail.com');
        expect(sshContext.effectivePrompt).not.toContain('gmail.com:22');
    });

    test('resolveSshRequestContext does not treat index.html as an SSH host override', () => {
        const sshContext = resolveSshRequestContext(
            'SSH into the server and replace the index.html with the 3D tic tac toe game on game.demoserver2.buzz.',
            {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: '162.55.163.199',
                        username: 'root',
                        port: 22,
                    },
                    remoteWorkingState: {
                        lastUpdated: new Date().toISOString(),
                        target: {
                            host: '162.55.163.199',
                            username: 'root',
                            port: 22,
                        },
                        lastCommand: 'kubectl get ingress -A',
                    },
                },
            },
        );

        expect(sshContext.target).toEqual({
            host: 'game.demoserver2.buzz',
            username: null,
            port: null,
        });
        expect(sshContext.effectivePrompt).toContain('index.html');
        expect(sshContext.effectivePrompt).not.toContain('index.html and');
    });

    test('extractSshSessionMetadataFromToolEvents keeps the last good host after a hostname-resolution failure on a bogus host', () => {
        const metadata = extractSshSessionMetadataFromToolEvents([
            {
                toolCall: {
                    function: {
                        name: 'remote-command',
                        arguments: JSON.stringify({
                            host: '162.55.163.199',
                            username: 'root',
                            port: 22,
                            command: 'hostname',
                        }),
                    },
                },
                result: {
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        host: '162.55.163.199:22',
                        stdout: 'ubuntu-32gb-fsn1-2',
                        stderr: '',
                    },
                },
            },
            {
                toolCall: {
                    function: {
                        name: 'remote-command',
                        arguments: JSON.stringify({
                            host: 'web-fetch.body',
                            username: 'root',
                            port: 22,
                            command: 'kubectl rollout restart deployment/website',
                        }),
                    },
                },
                result: {
                    success: false,
                    toolId: 'remote-command',
                    error: 'ssh: Could not resolve hostname web-fetch.body: Name or service not known',
                    data: {},
                },
            },
        ]);

        expect(metadata).toMatchObject({
            lastToolIntent: 'remote-command',
            lastSshTarget: {
                host: '162.55.163.199',
                username: 'root',
                port: 22,
            },
        });
    });

    test('extractSshSessionMetadataFromToolEvents does not replace the last good host with github.com after SSH auth failure', () => {
        const metadata = extractSshSessionMetadataFromToolEvents([
            {
                toolCall: {
                    function: {
                        name: 'remote-command',
                        arguments: JSON.stringify({
                            host: '162.55.163.199',
                            username: 'root',
                            port: 22,
                            command: 'hostname',
                        }),
                    },
                },
                result: {
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        host: '162.55.163.199:22',
                        stdout: 'ubuntu-32gb-fsn1-2',
                        stderr: '',
                    },
                },
            },
            {
                toolCall: {
                    function: {
                        name: 'remote-command',
                        arguments: JSON.stringify({
                            host: 'github.com',
                            username: 'root',
                            port: 22,
                            command: 'hostname',
                        }),
                    },
                },
                result: {
                    success: false,
                    toolId: 'remote-command',
                    error: 'root@github.com: Permission denied (publickey).',
                    data: {},
                },
            },
        ]);

        expect(metadata).toMatchObject({
            lastToolIntent: 'remote-command',
            lastSshTarget: {
                host: '162.55.163.199',
                username: 'root',
                port: 22,
            },
        });
    });
});

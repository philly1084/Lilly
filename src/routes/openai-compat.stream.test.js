const express = require('express');
const request = require('supertest');

jest.mock('../session-store', () => ({
    sessionStore: {
        resolveOwnedSession: jest.fn(),
        getOwned: jest.fn(),
        get: jest.fn(),
        getRecentMessages: jest.fn(),
        update: jest.fn(),
        recordResponse: jest.fn(),
        appendMessages: jest.fn(),
        upsertMessage: jest.fn(),
        updateControlState: jest.fn(),
    },
}));

jest.mock('../memory/memory-service', () => ({
    memoryService: {
        rememberResponse: jest.fn(),
    },
}));

jest.mock('../openai-client', () => ({
    generateImage: jest.fn(),
    listImageModels: jest.fn(),
    listModels: jest.fn(),
}));

jest.mock('../runtime-tool-manager', () => ({
    ensureRuntimeToolManager: jest.fn(async () => ({})),
}));

jest.mock('../runtime-execution', () => ({
    executeConversationRuntime: jest.fn(),
    resolveConversationExecutorFlag: jest.fn(() => false),
    inferExecutionProfile: jest.fn(() => 'default'),
}));

jest.mock('../ai-route-utils', () => ({
    buildInstructionsWithArtifacts: jest.fn(async () => 'continuity instructions'),
    maybeGenerateOutputArtifact: jest.fn(async () => []),
    generateOutputArtifactFromPrompt: jest.fn(),
    inferRequestedOutputFormat: jest.fn(() => null),
    isArtifactContinuationPrompt: jest.fn(() => false),
    maybePrepareImagesForArtifactPrompt: jest.fn(async ({ artifactIds = [] } = {}) => ({
        artifactIds,
        artifacts: [],
        toolEvents: [],
        imagePrompt: null,
    })),
    resolveDeferredWorkloadPreflight: jest.fn(() => ({
        timing: 'now',
        shouldSchedule: false,
        request: '',
        scenario: null,
    })),
    shouldSuppressNotesSurfaceArtifact: jest.fn(() => false),
    shouldSuppressImplicitMermaidArtifact: jest.fn(() => false),
    shouldSuppressWebChatImplicitHtmlArtifact: jest.fn(() => false),
    shouldSuppressArtifactGenerationForRemoteAction: jest.fn(() => false),
    shouldSuppressResearchFirstArtifactGeneration: jest.fn(() => false),
    isArtifactStorageAvailable: jest.fn(() => true),
    stripInjectedNotesPageEditDirective: jest.fn((text) => text),
    resolveSshRequestContext: jest.fn((text) => ({ effectivePrompt: text })),
    extractSshSessionMetadataFromToolEvents: jest.fn(() => null),
    inferOutputFormatFromSession: jest.fn(() => null),
    resolveArtifactContextIds: jest.fn(() => []),
    buildUserInputWithImageArtifacts: jest.fn(async ({ text }) => text),
    resolveReasoningEffort: jest.fn(() => null),
}));

jest.mock('../artifacts/artifact-service', () => ({
    artifactService: {
        getGenerationInstructions: jest.fn(() => ''),
    },
    extractResponseText: jest.fn((response = {}) => response.output_text || 'Answer'),
    resolveCompletedResponseText: jest.fn((fullText = '', response = {}) => fullText || response.output_text || 'Answer'),
    getMissingCompletionDelta: jest.fn(() => ''),
}));

jest.mock('../admin/runtime-monitor', () => ({
    startRuntimeTask: jest.fn(() => ({ id: 'task-compat-stream-1' })),
    completeRuntimeTask: jest.fn(),
    failRuntimeTask: jest.fn(),
}));

jest.mock('../project-memory', () => ({
    buildProjectMemoryUpdate: jest.fn(() => ({})),
    mergeProjectMemory: jest.fn((_existing, update) => update || {}),
}));

jest.mock('../generated-image-artifacts', () => ({
    persistGeneratedImages: jest.fn(async () => ({ artifacts: [] })),
}));

jest.mock('../runtime-prompts', () => ({
    buildContinuityInstructions: jest.fn(() => 'continuity instructions'),
}));

jest.mock('../runtime-control-state', () => ({
    getSessionControlState: jest.fn(() => ({})),
}));

jest.mock('../web-chat-message-state', () => jest.requireActual('../web-chat-message-state'));

jest.mock('../session-scope', () => ({
    buildScopedMemoryMetadata: jest.fn((metadata = {}) => metadata),
    buildScopedSessionMetadata: jest.fn((metadata = {}) => metadata),
    isSessionIsolationEnabled: jest.fn(() => false),
    resolveSessionScope: jest.fn(() => 'web-chat'),
}));

jest.mock('../user-checkpoints', () => ({
    buildUserCheckpointAnsweredPatch: jest.fn(() => ({})),
    buildUserCheckpointAskedPatch: jest.fn(() => ({})),
    buildUserCheckpointInstructions: jest.fn(() => ''),
    buildUserCheckpointPolicy: jest.fn(() => ({
        enabled: false,
        maxQuestions: 0,
        askedCount: 0,
        remaining: 0,
        pending: null,
    })),
    extractPendingUserCheckpoint: jest.fn(() => null),
    getUserCheckpointState: jest.fn(() => ({ pending: null })),
    parseUserCheckpointResponseMessage: jest.fn(() => null),
}));

const { sessionStore } = require('../session-store');
const { executeConversationRuntime } = require('../runtime-execution');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const aiRouteUtils = require('../ai-route-utils');
const { generateOutputArtifactFromPrompt } = aiRouteUtils;
const openAiCompatRouter = require('./openai-compat');

describe('/v1/chat/completions stream forwarding', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        const session = {
            id: 'web-chat-stream-1',
            previousResponseId: null,
            metadata: {
                taskType: 'chat',
                clientSurface: 'web-chat',
            },
        };

        sessionStore.resolveOwnedSession.mockResolvedValue(session);
        sessionStore.getOwned.mockResolvedValue(session);
        sessionStore.get.mockResolvedValue(session);
        sessionStore.getRecentMessages.mockResolvedValue([]);
        sessionStore.update.mockResolvedValue(session);
    });

    test('forwards reasoning deltas through chat completion chunks alongside tool events', async () => {
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: (async function* streamEvents() {
                yield {
                    type: 'response.reasoning_summary_text.delta',
                    delta: 'Checking the request. ',
                    summary: 'Checking the request. ',
                };
                yield {
                    type: 'response.output_item.added',
                    item: {
                        type: 'function_call',
                        name: 'web_search',
                        call_id: 'call_compat_1',
                    },
                };
                yield {
                    type: 'response.output_text.delta',
                    delta: 'Answer',
                };
                yield {
                    type: 'response.completed',
                    response: {
                        id: 'resp-compat-stream-1',
                        model: 'gpt-4o',
                        output_text: 'Answer',
                        output: [{
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: 'Answer' }],
                        }],
                        metadata: {
                            usage: {
                                promptTokens: 21,
                                completionTokens: 13,
                                totalTokens: 34,
                                source: 'provider-stream',
                            },
                            toolEvents: [],
                        },
                    },
                };
            }()),
        });

        const app = express();
        app.use(express.json());
        app.use('/v1', openAiCompatRouter);

        const response = await request(app)
            .post('/v1/chat/completions')
            .send({
                messages: [
                    { role: 'user', content: 'Check this request.' },
                ],
                taskType: 'chat',
                clientSurface: 'web-chat',
                stream: true,
                session_id: 'web-chat-stream-1',
            });

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/event-stream');
        expect(response.headers['cache-control']).toContain('no-transform');
        expect(response.headers['x-accel-buffering']).toBe('no');
        expect(response.text.startsWith(': stream-open\n\n')).toBe(true);
        expect(response.text).toContain('"delta":{"role":"assistant"}');
        expect(response.text).toContain('"delta":{"reasoning":"Checking the request. "}');
        expect(response.text).toContain('"type":"response.reasoning_summary_text.delta"');
        expect(response.text).toContain('"summary":"Checking the request. "');
        expect(response.text).toContain('"delta":{"tool_calls":[{"index":0,"id":"call_compat_1","type":"function","function":{"name":"web_search","arguments":"{}"}}]}');
        expect(response.text).toContain('"type":"response.output_item.added"');
        expect(response.text).toContain('"name":"web_search"');
        expect(response.text).toContain('"delta":{"content":"Answer"}');
        expect(response.text).toContain('"usage":{"prompt_tokens":21,"completion_tokens":13,"total_tokens":34}');
        expect(response.text).toContain('"gateway":{"requested_model":null,"resolved_model":"gpt-4o"');
        expect(response.text).toContain('"usage_source":"provider-stream"');
        expect(response.text).toContain('data: [DONE]');
    });

    test('routes web-chat menu podcast metadata directly to the podcast tool', async () => {
        const toolManager = {
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    title: 'Fishing Windows',
                    summary: 'A produced episode with mixed audio.',
                    artifacts: [{
                        id: 'artifact-podcast-1',
                        filename: 'fishing-windows.wav',
                        mimeType: 'audio/wav',
                    }],
                },
            }),
        };
        ensureRuntimeToolManager.mockResolvedValue(toolManager);

        const app = express();
        app.use(express.json());
        app.use('/v1', openAiCompatRouter);

        const response = await request(app)
            .post('/v1/chat/completions')
            .send({
                messages: [
                    { role: 'user', content: 'best time to fish this week in nova scotia' },
                ],
                taskType: 'chat',
                clientSurface: 'web-chat',
                stream: false,
                session_id: 'web-chat-stream-1',
                model: 'gpt-5.5',
                metadata: {
                    podcastOptions: {
                        enabled: true,
                        productionType: 'podcast',
                        voiceOnlyAudio: false,
                        includeIntro: true,
                        includeMusicBed: true,
                        cycleHostVoices: false,
                        allowVoiceFallback: false,
                    },
                },
            });

        expect(response.status).toBe(200);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'podcast',
            expect.objectContaining({
                topic: 'best time to fish this week in nova scotia',
                voiceOnlyAudio: false,
                includeIntro: true,
                includeMusicBed: true,
                cycleHostVoices: false,
                allowVoiceFallback: false,
            }),
            expect.objectContaining({
                route: '/v1/chat/completions',
                executionProfile: 'podcast',
            }),
        );
        expect(executeConversationRuntime).not.toHaveBeenCalled();
        expect(response.body.choices[0].message.content).toContain('Fishing Windows');
        expect(response.body.tool_events[0].toolCall.function.arguments).toContain('includeMusicBed');
    });

    test('forwards orchestration progress events before final stream completion', async () => {
        executeConversationRuntime.mockImplementation(async (_app, params) => {
            params.onProgress?.({
                phase: 'executing',
                detail: 'Running remote command',
                steps: [
                    { id: 'step-1', title: 'Inspect runtime', status: 'in_progress' },
                    { id: 'step-2', title: 'Summarize result', status: 'pending' },
                ],
                completedSteps: 0,
                totalSteps: 2,
                percent: 0,
            });

            return {
                handledPersistence: true,
                response: (async function* streamEvents() {
                    yield {
                        type: 'response.output_text.delta',
                        delta: 'Done',
                    };
                    yield {
                        type: 'response.completed',
                        response: {
                            id: 'resp-compat-progress-1',
                            model: 'gpt-4o',
                            output_text: 'Done',
                            output: [{
                                type: 'message',
                                role: 'assistant',
                                content: [{ type: 'output_text', text: 'Done' }],
                            }],
                            metadata: {
                                toolEvents: [],
                            },
                        },
                    };
                }()),
            };
        });

        const app = express();
        app.use(express.json());
        app.use('/v1', openAiCompatRouter);

        const response = await request(app)
            .post('/v1/chat/completions')
            .send({
                messages: [
                    { role: 'user', content: 'Run the next remote step.' },
                ],
                taskType: 'chat',
                clientSurface: 'web-chat',
                stream: true,
                session_id: 'web-chat-stream-1',
            });

        expect(response.status).toBe(200);
        expect(response.text).toContain('"type":"progress"');
        expect(response.text).toContain('"phase":"executing"');
        expect(response.text).toContain('"detail":"Running remote command"');
        expect(response.text).toContain('"delta":{"content":"Done"}');
        expect(response.text).toContain('data: [DONE]');
    });

    test('includes final reasoning on non-stream chat completion messages', async () => {
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-compat-final-1',
                model: 'gpt-4o',
                output_text: 'Answer',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Answer' }],
                }],
                metadata: {
                    reasoningSummary: 'Checked the request and chose the direct path.',
                    reasoningAvailable: true,
                    usage: {
                        promptTokens: 21,
                        completionTokens: 13,
                        totalTokens: 34,
                        cachedTokens: 5,
                        reasoningTokens: 4,
                    },
                    toolEvents: [],
                },
            },
        });

        const app = express();
        app.use(express.json());
        app.use('/v1', openAiCompatRouter);

        const response = await request(app)
            .post('/v1/chat/completions')
            .send({
                messages: [
                    { role: 'user', content: 'Check this request.' },
                ],
                taskType: 'chat',
                clientSurface: 'web-chat',
                stream: false,
                session_id: 'web-chat-stream-1',
            });

        expect(response.status).toBe(200);
        expect(response.body.choices[0].message.content).toBe('Answer');
        expect(response.body.choices[0].message.reasoning).toBe('Checked the request and chose the direct path.');
        expect(response.body.usage).toEqual({
            prompt_tokens: 21,
            completion_tokens: 13,
            total_tokens: 34,
            prompt_tokens_details: {
                cached_tokens: 5,
            },
            completion_tokens_details: {
                reasoning_tokens: 4,
            },
        });
    });

    test('ignores non-chat model ids before routing web-chat completions', async () => {
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-compat-non-chat-model-1',
                model: 'gpt-5.4-mini',
                output_text: 'Answer',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Answer' }],
                }],
                metadata: {
                    toolEvents: [],
                },
            },
        });

        const app = express();
        app.use(express.json());
        app.use('/v1', openAiCompatRouter);

        const response = await request(app)
            .post('/v1/chat/completions')
            .send({
                model: 'gpt-image-2',
                messages: [
                    { role: 'user', content: 'Hello.' },
                ],
                taskType: 'chat',
                clientSurface: 'web-chat',
                stream: false,
                session_id: 'web-chat-stream-1',
            });

        expect(response.status).toBe(200);
        expect(executeConversationRuntime).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            model: null,
        }));
    });

    test('reuses client-provided message ids when persisting a durable web-chat turn', async () => {
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: false,
            response: {
                id: 'resp-compat-durable-1',
                model: 'gpt-4o',
                output_text: 'Background-safe answer',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Background-safe answer' }],
                }],
                metadata: {
                    toolEvents: [],
                },
            },
        });

        const app = express();
        app.use(express.json());
        app.use('/v1', openAiCompatRouter);

        const response = await request(app)
            .post('/v1/chat/completions')
            .send({
                messages: [
                    { role: 'user', content: 'Make this durable.' },
                ],
                taskType: 'chat',
                clientSurface: 'web-chat',
                stream: false,
                session_id: 'web-chat-stream-1',
                metadata: {
                    messageId: 'user-msg-1',
                    assistantMessageId: 'assistant-msg-1',
                    userMessageTimestamp: '2026-04-11T10:00:00.000Z',
                    assistantMessageTimestamp: '2026-04-11T10:00:00.001Z',
                },
            });

        expect(response.status).toBe(200);
        expect(sessionStore.upsertMessage).toHaveBeenNthCalledWith(1,
            'web-chat-stream-1',
            expect.objectContaining({
                id: 'user-msg-1',
                role: 'user',
                content: 'Make this durable.',
            }),
        );
        expect(sessionStore.upsertMessage).toHaveBeenNthCalledWith(2,
            'web-chat-stream-1',
            expect.objectContaining({
                id: 'assistant-msg-1',
                role: 'assistant',
                metadata: expect.objectContaining({
                    isStreaming: true,
                    pendingForeground: true,
                }),
            }),
        );
        expect(sessionStore.upsertMessage).toHaveBeenCalledWith(
            'web-chat-stream-1',
            expect.objectContaining({
                id: 'assistant-msg-1',
                role: 'assistant',
                content: 'Background-safe answer',
                metadata: expect.objectContaining({
                    isStreaming: false,
                }),
            }),
        );
        expect(sessionStore.appendMessages).not.toHaveBeenCalled();
        expect(sessionStore.updateControlState).toHaveBeenCalledWith('web-chat-stream-1', {
            foregroundTurn: null,
        });
    });

    test('streams direct artifact completions when the generator returns a singular artifact', async () => {
        generateOutputArtifactFromPrompt.mockResolvedValue({
            responseId: 'resp-artifact-singular-1',
            model: 'gpt-4o',
            assistantMessage: [
                'Created the HTML site bundle artifact (frontend-demo.zip).',
                'Play it: /api/artifacts/artifact-singular-1/preview',
                'Download ZIP: /api/artifacts/artifact-singular-1/bundle',
            ].join('\n'),
            artifact: {
                id: 'artifact-singular-1',
                filename: 'frontend-demo.zip',
                format: 'html',
                downloadUrl: '/api/artifacts/artifact-singular-1/download',
                previewUrl: '/api/artifacts/artifact-singular-1/preview',
                bundleDownloadUrl: '/api/artifacts/artifact-singular-1/bundle',
            },
            artifacts: [],
            metadata: {},
        });

        const app = express();
        const documentService = { id: 'document-service' };
        app.locals.documentService = documentService;
        app.use(express.json());
        app.use('/v1', openAiCompatRouter);

        const response = await request(app)
            .post('/v1/chat/completions')
            .send({
                messages: [
                    { role: 'user', content: 'Turn this into a site.' },
                ],
                taskType: 'chat',
                clientSurface: 'web-chat',
                stream: true,
                session_id: 'web-chat-stream-1',
                output_format: 'html',
            });

        expect(response.status).toBe(200);
        expect(generateOutputArtifactFromPrompt).toHaveBeenCalledWith(expect.objectContaining({
            toolContext: expect.objectContaining({
                documentService,
            }),
        }));
        expect(response.text).toContain('"artifacts":[{"id":"artifact-singular-1"');
        expect(response.text).toContain('"displayContent":"Created frontend-demo.zip. Preview and Download below."');
        expect(sessionStore.upsertMessage).toHaveBeenCalledWith(
            'web-chat-stream-1',
            expect.objectContaining({
                role: 'assistant',
                content: 'Created frontend-demo.zip. Preview and Download below.',
                metadata: expect.objectContaining({
                    artifacts: [
                        expect.objectContaining({
                            id: 'artifact-singular-1',
                            previewUrl: '/api/artifacts/artifact-singular-1/preview',
                        }),
                    ],
                }),
            }),
        );
    });

    test('keeps continuation labels out of artifact generation prompt lead text', async () => {
        aiRouteUtils.inferRequestedOutputFormat.mockReturnValue('pdf');
        aiRouteUtils.isArtifactContinuationPrompt.mockReturnValue(true);
        aiRouteUtils.resolveArtifactContextIds.mockReturnValue(['artifact-source-1']);
        generateOutputArtifactFromPrompt.mockResolvedValue({
            responseId: 'resp-artifact-1',
            model: 'gpt-5.4',
            assistantMessage: 'Created the PDF artifact (resume-refresh.pdf).',
            metadata: {},
            artifact: {
                id: 'artifact-generated-1',
                filename: 'resume-refresh.pdf',
                format: 'pdf',
                mimeType: 'application/pdf',
                downloadUrl: '/api/artifacts/artifact-generated-1/download',
            },
            artifacts: [{
                id: 'artifact-generated-1',
                filename: 'resume-refresh.pdf',
                format: 'pdf',
                mimeType: 'application/pdf',
                downloadUrl: '/api/artifacts/artifact-generated-1/download',
            }],
        });

        const app = express();
        app.use(express.json());
        app.use('/v1', openAiCompatRouter);

        const response = await request(app)
            .post('/v1/chat/completions')
            .send({
                messages: [
                    { role: 'user', content: 'Update this document (Resume-Philip-Asplin-Professional-Staffing.pdf): improve the layout and font' },
                ],
                taskType: 'chat',
                clientSurface: 'web-chat',
                stream: false,
                session_id: 'web-chat-stream-1',
            });

        expect(response.status).toBe(200);
        const generationCall = generateOutputArtifactFromPrompt.mock.calls.at(-1)?.[0] || {};
        expect(generationCall.prompt).toMatch(/^Update this document/);
        expect(generationCall.prompt.split(/\n+/)[0]).not.toContain('Continue or refine');
        expect(generationCall.artifactIds).toEqual(['artifact-source-1']);
    });
});

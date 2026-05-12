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
    listModels: jest.fn(),
}));

jest.mock('../runtime-tool-manager', () => ({
    ensureRuntimeToolManager: jest.fn(),
}));

jest.mock('../runtime-execution', () => ({
    executeConversationRuntime: jest.fn(),
    resolveConversationExecutorFlag: jest.fn(() => false),
    inferExecutionProfile: jest.fn(() => 'notes'),
}));

jest.mock('../ai-route-utils', () => ({
    buildInstructionsWithArtifacts: jest.fn(),
    maybeGenerateOutputArtifact: jest.fn(),
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
    extractResponseText: jest.fn(() => 'Returned through normal runtime'),
    resolveCompletedResponseText: jest.fn(() => 'Returned through normal runtime'),
    getMissingCompletionDelta: jest.fn(() => ''),
}));

jest.mock('../admin/runtime-monitor', () => ({
    startRuntimeTask: jest.fn(() => ({ id: 'task-compat-1' })),
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

jest.mock('../web-chat-message-state', () => ({
    buildWebChatSessionMessages: jest.fn(() => []),
    buildFrontendAssistantMetadata: jest.fn(() => ({})),
}));

jest.mock('../session-scope', () => ({
    buildScopedMemoryMetadata: jest.fn((metadata = {}) => metadata),
    buildScopedSessionMetadata: jest.fn((metadata = {}) => metadata),
    isSessionIsolationEnabled: jest.fn(() => false),
    resolveSessionScope: jest.fn(() => 'notes'),
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
const {
    buildInstructionsWithArtifacts,
    maybeGenerateOutputArtifact,
    generateOutputArtifactFromPrompt,
    inferRequestedOutputFormat,
    shouldSuppressNotesSurfaceArtifact,
    stripInjectedNotesPageEditDirective,
} = require('../ai-route-utils');

const openAiCompatRouter = require('./openai-compat');

describe('/v1/chat/completions notes routing', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        const session = {
            id: 'page-session-1',
            previousResponseId: null,
            metadata: {
                taskType: 'notes',
                clientSurface: 'notes',
            },
        };
        sessionStore.resolveOwnedSession.mockResolvedValue(session);
        sessionStore.getOwned.mockResolvedValue(session);
        sessionStore.get.mockResolvedValue(session);
        sessionStore.getRecentMessages.mockResolvedValue([]);
        sessionStore.update.mockResolvedValue(session);
        buildInstructionsWithArtifacts.mockResolvedValue('continuity instructions');
        maybeGenerateOutputArtifact.mockResolvedValue([]);
    });

    test('keeps inferred html requests in the normal runtime for notes page edits', async () => {
        inferRequestedOutputFormat.mockReturnValue('html');
        shouldSuppressNotesSurfaceArtifact.mockReturnValue(true);
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-notes-compat-1',
                output_text: 'Returned through normal runtime',
                output: [{
                    type: 'message',
                    content: [{ type: 'output_text', text: 'Returned through normal runtime' }],
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
                    { role: 'user', content: 'Create a page about pigeons.' },
                ],
                taskType: 'notes',
                clientSurface: 'notes',
                session_id: 'page-session-1',
            });

        expect(response.status).toBe(200);
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
        expect(shouldSuppressNotesSurfaceArtifact).toHaveBeenCalledWith(expect.objectContaining({
            taskType: 'notes',
            outputFormat: 'html',
        }));
    });

    test('takes the direct artifact branch for notes sessions when html output is explicitly requested', async () => {
        inferRequestedOutputFormat.mockReturnValue(null);
        shouldSuppressNotesSurfaceArtifact.mockReturnValue(false);
        generateOutputArtifactFromPrompt.mockResolvedValue({
            responseId: 'resp-notes-compat-2',
            artifact: {
                id: 'artifact-html-1',
                filename: 'penguins.html',
            },
            artifacts: [{
                id: 'artifact-html-1',
                filename: 'penguins.html',
            }],
            assistantMessage: 'Created the HTML document artifact (penguins.html).',
            metadata: {
                usage: {
                    promptTokens: 120,
                    completionTokens: 80,
                    totalTokens: 200,
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
                    { role: 'user', content: 'Create a page about penguins.' },
                ],
                taskType: 'notes',
                clientSurface: 'notes',
                output_format: 'html',
                session_id: 'page-session-1',
            });

        expect(response.status).toBe(200);
        expect(generateOutputArtifactFromPrompt).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'page-session-1',
            mode: 'notes',
            outputFormat: 'html',
        }));
        expect(executeConversationRuntime).not.toHaveBeenCalled();
        expect(response.body.choices[0].message.content).toBe('Created the HTML document artifact (penguins.html).');
        expect(response.body.usage).toEqual({
            prompt_tokens: 120,
            completion_tokens: 80,
            total_tokens: 200,
        });
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({ id: 'artifact-html-1', filename: 'penguins.html' }),
        ]);
        expect(shouldSuppressNotesSurfaceArtifact).toHaveBeenCalledWith(expect.objectContaining({
            taskType: 'notes',
            outputFormat: 'html',
            outputFormatProvided: true,
        }));
    });

    test('strips the injected notes page-edit directive before html inference on /v1 notes requests', async () => {
        stripInjectedNotesPageEditDirective.mockImplementation((text) => (
            String(text).replace(/\n\nInterpret "page" as the current notes page shown in this editor[\s\S]*$/i, '')
        ));
        inferRequestedOutputFormat.mockImplementation((text) => (
            /\bweb page\b/i.test(text) || /\bartifact\b/i.test(text) ? 'html' : null
        ));
        shouldSuppressNotesSurfaceArtifact.mockReturnValue(false);
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-notes-compat-3',
                output_text: 'Returned through normal runtime',
                output: [{
                    type: 'message',
                    content: [{ type: 'output_text', text: 'Returned through normal runtime' }],
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
                    {
                        role: 'user',
                        content: 'Create a page about penguins.\n\nInterpret "page" as the current notes page shown in this editor. This is a direct page edit request, so return notes-actions that apply the content to the current notes page unless the user explicitly says web page, site page, repo file, or server component. Put the result into page blocks. Do not reply with chat prose alone. Do not create standalone HTML, file, export, artifact, or download-link output unless the user explicitly asked for that.',
                    },
                ],
                taskType: 'notes',
                clientSurface: 'notes',
                session_id: 'page-session-1',
            });

        expect(response.status).toBe(200);
        expect(stripInjectedNotesPageEditDirective).toHaveBeenCalled();
        expect(inferRequestedOutputFormat).toHaveBeenCalledWith('Create a page about penguins.');
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
    });

    test('surfaces document-workflow artifacts in OpenAI-compatible chat responses', async () => {
        inferRequestedOutputFormat.mockReturnValue(null);
        shouldSuppressNotesSurfaceArtifact.mockReturnValue(false);
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-notes-compat-4',
                output_text: 'I recreated the dashboard.',
                output: [{
                    type: 'message',
                    content: [{ type: 'output_text', text: 'I recreated the dashboard.' }],
                }],
                metadata: {
                    toolEvents: [{
                        toolCall: {
                            function: {
                                name: 'document-workflow',
                            },
                        },
                        result: {
                            success: true,
                            data: {
                                document: {
                                    id: 'doc-77',
                                    filename: 'mission-control.html',
                                    mimeType: 'text/html',
                                    downloadUrl: '/api/documents/doc-77/download',
                                    metadata: { format: 'html' },
                                },
                            },
                        },
                    }],
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
                    { role: 'user', content: 'Rebuild the mission control dashboard.' },
                ],
                session_id: 'page-session-1',
            });

        expect(response.status).toBe(200);
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({
                id: 'doc-77',
                filename: 'mission-control.html',
                format: 'html',
                downloadUrl: '/api/documents/doc-77/download',
            }),
        ]);
        expect(response.body.choices[0].message.artifacts).toEqual(response.body.artifacts);
    });
});

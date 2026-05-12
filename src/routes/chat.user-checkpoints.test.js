const express = require('express');
const request = require('supertest');

jest.mock('../middleware/validate', () => ({
    validate: () => (_req, _res, next) => next(),
}));

jest.mock('../session-store', () => ({
    sessionStore: {
        resolveOwnedSession: jest.fn(),
        getOwned: jest.fn(),
        get: jest.fn(),
        getRecentMessages: jest.fn(),
        update: jest.fn(),
        updateControlState: jest.fn(),
        recordResponse: jest.fn(),
        appendMessages: jest.fn(),
    },
}));

jest.mock('../memory/memory-service', () => ({
    memoryService: {
        process: jest.fn(),
        rememberResponse: jest.fn(),
        rememberArtifactResult: jest.fn(),
        rememberLearnedSkill: jest.fn(),
    },
}));

jest.mock('../runtime-tool-manager', () => ({
    ensureRuntimeToolManager: jest.fn(),
}));

jest.mock('../runtime-execution', () => ({
    executeConversationRuntime: jest.fn(),
    resolveConversationExecutorFlag: jest.fn(() => false),
}));

jest.mock('../ai-route-utils', () => ({
    buildInstructionsWithArtifacts: jest.fn(async (_session, instructions) => instructions),
    maybeGenerateOutputArtifact: jest.fn(async () => []),
    generateOutputArtifactFromPrompt: jest.fn(),
    inferRequestedOutputFormat: jest.fn(() => null),
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
    resolveReasoningEffort: jest.fn(() => null),
    resolveSshRequestContext: jest.fn((text) => ({ effectivePrompt: text })),
    extractSshSessionMetadataFromToolEvents: jest.fn(() => null),
    inferOutputFormatFromSession: jest.fn(() => null),
    resolveArtifactContextIds: jest.fn(() => []),
    buildUserInputWithImageArtifacts: jest.fn(async ({ text }) => text),
}));

jest.mock('../admin/runtime-monitor', () => ({
    startRuntimeTask: jest.fn(() => ({ id: 'task-1' })),
    completeRuntimeTask: jest.fn(),
    failRuntimeTask: jest.fn(),
}));

jest.mock('../project-memory', () => ({
    buildProjectMemoryUpdate: jest.fn(() => ({})),
    mergeProjectMemory: jest.fn((_existing, update) => update || {}),
}));

const { sessionStore } = require('../session-store');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const { executeConversationRuntime } = require('../runtime-execution');
const { buildInstructionsWithArtifacts } = require('../ai-route-utils');

const chatRouter = require('./chat');

describe('/api/chat user checkpoints', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        const session = {
            id: 'session-1',
            previousResponseId: null,
            metadata: {},
            controlState: {},
        };

        sessionStore.resolveOwnedSession.mockResolvedValue(session);
        sessionStore.getOwned.mockResolvedValue(session);
        sessionStore.get.mockResolvedValue(session);
        sessionStore.getRecentMessages.mockResolvedValue([]);
        sessionStore.update.mockResolvedValue(session);
        sessionStore.updateControlState.mockResolvedValue({});
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
    });

    test('exposes checkpoint policy to the runtime and continuity instructions on web-chat turns', async () => {
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-checkpoint-policy-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'Let me think through that.' }],
                }],
                metadata: {
                    toolEvents: [],
                },
            },
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Help me plan the refactor.',
                stream: false,
                clientSurface: 'web-chat',
                metadata: { clientSurface: 'web-chat' },
            });

        expect(response.status).toBe(200);
        expect(buildInstructionsWithArtifacts).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'session-1' }),
            expect.stringContaining('user-checkpoint'),
            [],
        );
        expect(executeConversationRuntime).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                toolContext: expect.objectContaining({
                    userCheckpointPolicy: expect.objectContaining({
                        enabled: true,
                        remaining: 8,
                        pending: null,
                    }),
                }),
                metadata: expect.objectContaining({
                    userCheckpointPolicy: expect.objectContaining({
                        enabled: true,
                        remaining: 8,
                        pending: null,
                    }),
                }),
            }),
        );
    });

    test('persists pending checkpoint state and returns survey metadata when the runtime asks a question', async () => {
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: false,
            response: {
                id: 'resp-checkpoint-ask-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'I need one decision before I continue.' }],
                }],
                metadata: {
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
                                    id: 'checkpoint-1',
                                    title: 'Choose a direction',
                                    question: 'Which approach should we take?',
                                    options: [
                                        { id: 'a', label: 'Option A' },
                                        { id: 'b', label: 'Option B' },
                                    ],
                                },
                            },
                        },
                    }],
                },
            },
        });
        sessionStore.updateControlState.mockResolvedValue({
            userCheckpoint: {
                maxQuestions: 8,
                askedCount: 1,
                pending: {
                    id: 'checkpoint-1',
                    title: 'Choose a direction',
                    question: 'Which approach should we take?',
                },
            },
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'I need one decision before I continue.',
                stream: false,
                clientSurface: 'web-chat',
                metadata: { clientSurface: 'web-chat' },
            });

        expect(response.status).toBe(200);
        expect(sessionStore.updateControlState).toHaveBeenCalledWith('session-1', expect.objectContaining({
            userCheckpoint: expect.objectContaining({
                askedCount: 1,
                pending: expect.objectContaining({
                    id: 'checkpoint-1',
                    question: 'Which approach should we take?',
                }),
            }),
        }));
        expect(sessionStore.appendMessages).toHaveBeenCalledWith('session-1', expect.arrayContaining([
            expect.objectContaining({
                role: 'assistant',
                metadata: expect.objectContaining({
                    displayContent: expect.stringContaining('```survey'),
                }),
            }),
        ]));
        expect(response.body.assistantMetadata).toEqual(expect.objectContaining({
            displayContent: expect.stringContaining('```survey'),
        }));
    });

    test('clears the pending checkpoint before continuing after a survey response', async () => {
        const session = {
            id: 'session-1',
            previousResponseId: null,
            metadata: {},
            controlState: {
                userCheckpoint: {
                    maxQuestions: 8,
                    askedCount: 1,
                    pending: {
                        id: 'checkpoint-1',
                        title: 'Choose a direction',
                        question: 'Which approach should we take?',
                        options: [
                            { id: 'a', label: 'Option A' },
                            { id: 'b', label: 'Option B' },
                        ],
                    },
                },
            },
        };
        sessionStore.resolveOwnedSession.mockResolvedValue(session);
        sessionStore.getOwned.mockResolvedValue(session);
        sessionStore.get.mockResolvedValue(session);
        sessionStore.update.mockResolvedValue(session);
        sessionStore.updateControlState.mockResolvedValue({
            userCheckpoint: {
                maxQuestions: 8,
                askedCount: 1,
                pending: null,
                lastResponse: {
                    checkpointId: 'checkpoint-1',
                    summary: 'chose "Option A" [a].',
                },
            },
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-checkpoint-answer-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'I’ll continue with Option A.' }],
                }],
                metadata: {
                    toolEvents: [],
                },
            },
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Survey response (checkpoint-1): chose "Option A" [a].',
                stream: false,
                clientSurface: 'web-chat',
                metadata: { clientSurface: 'web-chat' },
            });

        expect(response.status).toBe(200);
        expect(sessionStore.updateControlState).toHaveBeenCalledWith('session-1', expect.objectContaining({
            userCheckpoint: expect.objectContaining({
                pending: null,
                lastResponse: expect.objectContaining({
                    checkpointId: 'checkpoint-1',
                    summary: 'chose "Option A" [a].',
                }),
            }),
        }));
        expect(executeConversationRuntime).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                toolContext: expect.objectContaining({
                    userCheckpointPolicy: expect.objectContaining({
                        enabled: true,
                        pending: null,
                        remaining: 0,
                        answeredThisTurn: true,
                    }),
                }),
                metadata: expect.objectContaining({
                    userCheckpointPolicy: expect.objectContaining({
                        enabled: true,
                        pending: null,
                        remaining: 0,
                        answeredThisTurn: true,
                    }),
                }),
            }),
        );
    });
});

const express = require('express');
const request = require('supertest');

jest.spyOn(console, 'log').mockImplementation(() => {});

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
        recordResponse: jest.fn(),
        appendMessages: jest.fn(),
    },
}));

jest.mock('../memory/memory-service', () => ({
    memoryService: {
        rememberResponse: jest.fn(),
    },
}));

jest.mock('../artifacts/artifact-service', () => ({
    extractResponseText: jest.fn(() => 'Scoped response'),
    resolveCompletedResponseText: jest.fn(() => 'Scoped response'),
    getMissingCompletionDelta: jest.fn(() => 0),
}));

jest.mock('../routes/admin/settings.controller', () => ({
    getSettings: jest.fn(() => ({})),
}));

jest.mock('../runtime-tool-manager', () => ({
    ensureRuntimeToolManager: jest.fn(),
}));

jest.mock('../runtime-execution', () => ({
    executeConversationRuntime: jest.fn(),
    resolveConversationExecutorFlag: jest.fn(() => false),
}));

jest.mock('../ai-route-utils', () => ({
    buildInstructionsWithArtifacts: jest.fn(async () => 'continuity instructions'),
    maybeGenerateOutputArtifact: jest.fn(async () => []),
    generateOutputArtifactFromPrompt: jest.fn(),
    inferRequestedOutputFormat: jest.fn(() => null),
    maybePrepareImagesForArtifactPrompt: jest.fn(async ({ artifactIds = [] } = {}) => ({
        artifactIds,
        artifacts: [],
        toolEvents: [],
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
    resolveSshRequestContext: jest.fn((message) => ({
        effectivePrompt: message,
    })),
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

jest.mock('../runtime-prompts', () => ({
    buildContinuityInstructions: jest.fn(() => 'continuity instructions'),
}));

const { sessionStore } = require('../session-store');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const { executeConversationRuntime } = require('../runtime-execution');
const chatRouter = require('./chat');

describe('/api/chat scope wiring', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        const session = {
            id: 'session-1',
            previousResponseId: null,
            metadata: {
                clientSurface: 'web-chat',
                memoryScope: 'web-chat',
            },
        };

        sessionStore.resolveOwnedSession.mockResolvedValue(session);
        sessionStore.getOwned.mockResolvedValue(session);
        sessionStore.get.mockResolvedValue(session);
        sessionStore.getRecentMessages.mockResolvedValue([]);
        sessionStore.update.mockResolvedValue(session);
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'Scoped response' }],
                }],
                metadata: {
                    toolEvents: [],
                },
            },
        });
    });

    test('passes the frontend surface into session resolution and runtime execution', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                message: 'Hello from web chat',
                stream: false,
                metadata: {
                    clientSurface: 'web-chat',
                },
            });

        expect(response.status).toBe(200);
        expect(sessionStore.resolveOwnedSession).toHaveBeenCalledWith(
            undefined,
            expect.objectContaining({
                clientSurface: 'web-chat',
                memoryScope: 'web-chat',
                sessionIsolation: true,
            }),
            null,
        );
        expect(executeConversationRuntime).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                clientSurface: 'web-chat',
                memoryScope: 'web-chat',
                metadata: expect.objectContaining({
                    clientSurface: 'web-chat',
                    memoryScope: 'web-chat',
                    sessionIsolation: true,
                }),
            }),
        );
    });

    test('forwards memoryKeywords while keeping web-chat memory session isolated', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                message: 'Revise the html output',
                stream: false,
                memoryKeywords: ['html', 'section-3'],
                metadata: {
                    clientSurface: 'web-chat',
                },
            });

        expect(response.status).toBe(200);
        expect(executeConversationRuntime).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                clientSurface: 'web-chat',
                memoryScope: 'web-chat',
                metadata: expect.objectContaining({
                    clientSurface: 'web-chat',
                    memoryScope: 'web-chat',
                    sessionIsolation: true,
                    memoryKeywords: ['html', 'section-3'],
                }),
                toolContext: expect.objectContaining({
                    sessionIsolation: true,
                    memoryKeywords: ['html', 'section-3'],
                }),
            }),
        );
    });
});

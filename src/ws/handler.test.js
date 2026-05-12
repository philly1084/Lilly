const EventEmitter = require('events');

jest.mock('../session-store', () => ({
    sessionStore: {
        resolveOwnedSession: jest.fn(),
        getOwned: jest.fn(),
        get: jest.fn(),
        getRecentMessages: jest.fn(),
        recordResponse: jest.fn(),
        update: jest.fn(),
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
    ensureRuntimeToolManager: jest.fn(async () => ({ getTool: jest.fn() })),
}));

jest.mock('../runtime-execution', () => ({
    executeConversationRuntime: jest.fn(),
    resolveConversationExecutorFlag: jest.fn(() => false),
}));

jest.mock('../ai-route-utils', () => ({
    buildInstructionsWithArtifacts: jest.fn(async () => 'instructions'),
    maybeGenerateOutputArtifact: jest.fn(async () => []),
    generateOutputArtifactFromPrompt: jest.fn(),
    inferRequestedOutputFormat: jest.fn(() => null),
    maybePrepareImagesForArtifactPrompt: jest.fn(async ({ artifactIds = [] } = {}) => ({
        artifactIds,
        artifacts: [],
        toolEvents: [],
    })),
    resolveDeferredWorkloadPreflight: jest.fn(() => ({
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
    resolveSshRequestContext: jest.fn((text) => ({ effectivePrompt: text })),
    extractSshSessionMetadataFromToolEvents: jest.fn(() => null),
    inferOutputFormatFromSession: jest.fn(() => null),
    resolveArtifactContextIds: jest.fn(() => []),
    resolveReasoningEffort: jest.fn(() => null),
}));

jest.mock('../artifacts/artifact-service', () => ({
    extractResponseText: jest.fn((response = {}) => response.output_text || ''),
    resolveCompletedResponseText: jest.fn((fullText = '', response = {}) => fullText || response.output_text || ''),
    getMissingCompletionDelta: jest.fn(() => ''),
}));

jest.mock('../admin/runtime-monitor', () => ({
    startRuntimeTask: jest.fn(() => ({ id: 'runtime-task-1' })),
    completeRuntimeTask: jest.fn(),
    failRuntimeTask: jest.fn(),
}));

jest.mock('../auth/service', () => ({
    getAuthenticatedUser: jest.fn(() => ({ authenticated: true, user: { username: 'phill' } })),
    isAuthorizedFrontendApiRequest: jest.fn(() => false),
    isAuthEnabled: jest.fn(() => false),
}));

jest.mock('../conversation-continuity', () => ({
    resolveTranscriptObjectiveFromSession: jest.fn((_message) => ({ objective: '' })),
}));

jest.mock('../project-memory', () => ({
    buildProjectMemoryUpdate: jest.fn(() => ({})),
    mergeProjectMemory: jest.fn((_existing, update) => update || {}),
}));

jest.mock('../runtime-prompts', () => ({
    buildContinuityInstructions: jest.fn((text = '') => text),
}));

jest.mock('../session-instructions', () => ({
    buildHumanCentricResponseInstructions: jest.fn(() => ''),
}));

jest.mock('../web-chat-message-state', () => ({
    buildFrontendAssistantMetadata: jest.fn((metadata = {}) => metadata),
    buildWebChatSessionMessages: jest.fn(({ userText, assistantText, artifacts = [] }) => [
        { role: 'user', content: userText },
        { role: 'assistant', content: assistantText, artifacts },
    ]),
}));

jest.mock('../memory/memory-keywords', () => ({
    normalizeMemoryKeywords: jest.fn(() => []),
}));

jest.mock('../runtime-artifacts', () => ({
    extractArtifactsFromToolEvents: jest.fn(() => []),
    mergeRuntimeArtifacts: jest.fn((...sets) => sets.flat().filter(Boolean)),
}));

jest.mock('../user-checkpoints', () => ({
    buildUserCheckpointInstructions: jest.fn(() => ''),
    buildUserCheckpointPolicy: jest.fn(() => ({
        enabled: false,
        maxQuestions: 0,
        askedCount: 0,
        remaining: 0,
        pending: null,
    })),
}));

jest.mock('../web-chat-user-checkpoints', () => ({
    applyAnsweredUserCheckpointState: jest.fn(async (_store, _id, session) => ({ session })),
    applyAskedUserCheckpointState: jest.fn(async (_store, _id, session) => session),
    buildUserCheckpointPolicyMetadata: jest.fn(() => ({})),
}));

jest.mock('../session-scope', () => ({
    buildScopedMemoryMetadata: jest.fn((metadata = {}) => metadata),
    buildScopedSessionMetadata: jest.fn((metadata = {}) => metadata),
    isSessionIsolationEnabled: jest.fn(() => false),
    resolveClientSurface: jest.fn((payload = {}) => payload?.metadata?.clientSurface || 'web-chat'),
    resolveSessionScope: jest.fn(() => 'web-chat'),
}));

jest.mock('../realtime-hub', () => ({
    broadcastToAdmins: jest.fn(),
    broadcastToSession: jest.fn(),
    registerAdminConnection: jest.fn(),
    registerSessionConnection: jest.fn(),
    unregisterAdminConnection: jest.fn(),
    unregisterSessionConnection: jest.fn(),
}));

const { WebSocket } = require('ws');
const { sessionStore } = require('../session-store');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const { executeConversationRuntime } = require('../runtime-execution');
const {
    generateOutputArtifactFromPrompt,
    inferRequestedOutputFormat,
    isArtifactStorageAvailable,
} = require('../ai-route-utils');
const { setupWebSocket } = require('./handler');

function createFakeSocket(onDone) {
    const socket = new EventEmitter();
    socket.readyState = WebSocket.OPEN;
    socket.sent = [];
    socket.send = jest.fn((payload) => {
        const parsed = JSON.parse(payload);
        socket.sent.push(parsed);
        if (parsed.type === 'done' || parsed.type === 'error') {
            onDone(parsed);
        }
    });
    socket.close = jest.fn();
    return socket;
}

describe('websocket chat handler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const session = {
            id: 'session-1',
            previousResponseId: null,
            metadata: {
                clientSurface: 'web-chat',
                taskType: 'chat',
            },
        };
        sessionStore.resolveOwnedSession.mockResolvedValue(session);
        sessionStore.getOwned.mockResolvedValue(session);
        sessionStore.get.mockResolvedValue(session);
        sessionStore.getRecentMessages.mockResolvedValue([]);
        sessionStore.update.mockResolvedValue(session);
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: false,
            response: (async function* responseEvents() {
                yield {
                    type: 'response.output_text.delta',
                    delta: 'Normal chat response',
                };
                yield {
                    type: 'response.completed',
                    response: {
                        id: 'resp-1',
                        model: 'gpt-test',
                        output_text: 'Normal chat response',
                        metadata: { toolEvents: [] },
                    },
                };
            }()),
        });
    });

    test('falls back to normal chat for implicit PDF requests when artifact storage is unavailable', async () => {
        inferRequestedOutputFormat.mockReturnValue('pdf');
        isArtifactStorageAvailable.mockReturnValue(false);

        const donePayload = await new Promise((resolve) => {
            const wss = new EventEmitter();
            setupWebSocket(wss, { locals: {} });
            const ws = createFakeSocket(resolve);
            wss.emit('connection', ws, {});
            ws.emit('message', Buffer.from(JSON.stringify({
                type: 'chat',
                sessionId: 'session-1',
                payload: {
                    message: 'Can you make me a pdf on the town of kentville nova scotia and things to do in the spring.',
                    metadata: { clientSurface: 'web-chat' },
                },
            })));
        });

        expect(donePayload.type).toBe('done');
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
    });

    test('passes structured web-chat podcast menu options through the direct podcast path', async () => {
        const toolManager = {
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    title: 'Grid Battery Show',
                    summary: 'A produced video podcast.',
                    artifacts: [{
                        id: 'artifact-podcast-1',
                        filename: 'grid-battery-show.wav',
                        mimeType: 'audio/wav',
                    }],
                },
            }),
            getTool: jest.fn(),
        };
        ensureRuntimeToolManager.mockResolvedValue(toolManager);

        const donePayload = await new Promise((resolve) => {
            const wss = new EventEmitter();
            setupWebSocket(wss, { locals: {} });
            const ws = createFakeSocket(resolve);
            wss.emit('connection', ws, {});
            ws.emit('message', Buffer.from(JSON.stringify({
                type: 'chat',
                sessionId: 'session-1',
                payload: {
                    message: 'Create a video podcast about grid batteries',
                    model: 'gpt-5.5',
                    metadata: {
                        clientSurface: 'web-chat',
                        podcastOptions: {
                            enabled: true,
                            productionType: 'video-podcast',
                            includeVideo: true,
                            voiceOnlyAudio: false,
                            includeIntro: true,
                            includeMusicBed: true,
                            cycleHostVoices: false,
                            allowVoiceFallback: false,
                            videoAspectRatio: '16:9',
                            videoRenderMode: 'storyboard',
                            videoImageMode: 'generated',
                            videoGenerateImages: true,
                        },
                    },
                },
            })));
        });

        expect(donePayload.type).toBe('done');
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'podcast',
            expect.objectContaining({
                topic: 'grid batteries',
                model: 'gpt-5.5',
                includeVideo: true,
                voiceOnlyAudio: false,
                includeIntro: true,
                includeMusicBed: true,
                cycleHostVoices: false,
                allowVoiceFallback: false,
                videoRenderMode: 'storyboard',
            }),
            expect.objectContaining({
                executionProfile: 'podcast-video',
            }),
        );
        expect(executeConversationRuntime).not.toHaveBeenCalled();
    });
});

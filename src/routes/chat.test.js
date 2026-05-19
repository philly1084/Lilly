const express = require('express');
const request = require('supertest');

jest.mock('../middleware/validate', () => ({
    validate: () => (_req, _res, next) => next(),
}));

jest.mock('../session-store', () => ({
    sessionStore: {
        create: jest.fn(),
        resolveOwnedSession: jest.fn(),
        getOwned: jest.fn(),
        get: jest.fn(),
        getRecentMessages: jest.fn(),
        update: jest.fn(),
        updateControlState: jest.fn(),
        recordResponse: jest.fn(),
        appendMessages: jest.fn(),
        upsertMessage: jest.fn(),
        loadAllSessionMessages: jest.fn(),
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

jest.mock('../pii', () => ({
    sanitizeText: jest.fn(async (text, options = {}) => ({
        text,
        contextId: null,
        contextIds: [],
        replacements: [],
        policy: options.policy || { enabled: false },
    })),
    rehydrateText: jest.fn(async (text) => ({
        text,
        restorations: [],
        enabled: false,
    })),
}));

jest.mock('../ai-route-utils', () => ({
    buildInstructionsWithArtifacts: jest.fn(),
    maybeGenerateOutputArtifact: jest.fn(),
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
    shouldDeferArtifactGenerationToWorkload: jest.fn(() => false),
    shouldSuppressNotesSurfaceArtifact: jest.fn(() => false),
    shouldSuppressImplicitMermaidArtifact: jest.fn(() => false),
    shouldSuppressWebChatImplicitHtmlArtifact: jest.fn(() => false),
    shouldSuppressArtifactGenerationForRemoteAction: jest.fn(() => false),
    shouldSuppressResearchFirstArtifactGeneration: jest.fn(() => false),
    isArtifactStorageAvailable: jest.fn(() => true),
    stripInjectedNotesPageEditDirective: jest.fn((text) => text),
    resolveReasoningEffort: jest.fn(() => null),
    resolveSshRequestContext: jest.fn(),
    extractSshSessionMetadataFromToolEvents: jest.fn(() => null),
    buildRequestDecisionFrame: jest.fn(() => ({})),
    buildRequestDecisionMetadata: jest.fn(() => ({})),
    buildRequestFrameProgress: jest.fn(() => ({ phase: 'routing', summary: 'Routing request' })),
    formatRequestDecisionFrameForPrompt: jest.fn(() => ''),
    inferOutputFormatFromSession: jest.fn(() => null),
    inferOutputFormatFromArtifactContext: jest.fn(async () => null),
    resolveArtifactContextIds: jest.fn(() => []),
    buildPiiWorkbookRelationshipToolContext: jest.fn(async () => null),
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

jest.mock('../alignment/evaluator-service', () => ({
    buildAlignmentGuidanceContext: jest.fn(() => ''),
    buildFallbackEvaluation: jest.fn(({ rating = 'up' } = {}) => ({
        decision: rating === 'up' ? 'aligned' : 'needs_review',
        requestType: 'frontend',
        confidence: rating === 'up' ? 0.8 : 0.35,
        summary: rating === 'up' ? 'The user marked this response as aligned.' : 'The user marked this response for alignment review.',
        evidence: [],
        recommendedChanges: [],
        decisionGuidance: [],
        routeDecision: rating === 'up' ? 'correct_route' : 'route_unclear',
        expectedRoute: rating === 'up' ? '' : 'Frontend implementation route with browser verification.',
        actualRoute: rating === 'up' ? 'taskType=frontend; tools=ui-check' : 'No route metadata was recorded.',
        failureCategories: rating === 'up' ? [] : ['answered_instead_of_acted'],
        fixStrategy: rating === 'up' ? [] : ['Use the frontend implementation lane.'],
        repairPlan: rating === 'up' ? [] : ['Make the actual frontend change.'],
        successPattern: rating === 'up' ? 'This frontend route worked with implementation and verification.' : '',
        lesson: rating === 'up'
            ? 'Positive feedback confirms this frontend route can be reused for similar prompts when the context matches.'
            : 'Route frontend implementation requests through code changes and browser verification.',
        toolUseDecision: rating === 'up' ? 'correct_tools' : 'tool_gap',
        toolMisuseCategories: rating === 'up' ? [] : ['missing_required_tool'],
        expectedTools: rating === 'up' ? ['ui-check'] : ['web-scrape'],
        actualTools: rating === 'up' ? ['ui-check'] : [],
        missingTools: rating === 'up' ? [] : ['web-scrape'],
        misusedTools: [],
        toolFixes: rating === 'up' ? [] : ['Run browser verification before finalizing.'],
        toolLesson: rating === 'up'
            ? 'The UI verification tool pattern worked.'
            : 'Frontend requests need browser verification evidence.',
        memoryCandidate: false,
    })),
    buildRegressionFixtureCandidate: jest.fn(({
        feedbackId = 'align-test',
        sessionId = 'session-1',
        messageId = 'assistant-1',
        rating = 'down',
        userText = '',
        assistantText = '',
        evaluation = {},
    } = {}) => {
        if (rating !== 'down' || evaluation.promoteRegressionFixture !== true) {
            return null;
        }
        return {
            id: `alignment-${feedbackId}`,
            source: 'alignment-feedback',
            sessionId,
            messageId,
            prompt: userText,
            rejectedResponsePreview: assistantText,
            expected: {
                requestType: evaluation.requestType || 'unknown',
                forbiddenRoute: evaluation.actualRoute || '',
                failureCategories: evaluation.failureCategories || [],
                expectedTools: evaluation.expectedTools || [],
                missingTools: evaluation.missingTools || [],
                misusedTools: evaluation.misusedTools || [],
                toolMisuseCategories: evaluation.toolMisuseCategories || [],
                requiredEvidence: evaluation.repairPlan || [],
            },
        };
    }),
    evaluateAlignment: jest.fn(async () => ({
        feedbackId: 'align-test',
        status: 'completed',
        model: 'gpt-evaluator',
        evaluation: {
            decision: 'needs_review',
            requestType: 'frontend',
            confidence: 0.7,
            summary: 'Needs UI follow-through.',
            evidence: [],
            recommendedChanges: ['Add the icon beside read aloud.'],
            decisionGuidance: ['For similar UI requests, make the actual frontend change.'],
            routeDecision: 'route_unclear',
            expectedRoute: 'Frontend implementation route with browser verification.',
            actualRoute: 'No route metadata was recorded.',
            failureCategories: ['answered_instead_of_acted'],
            fixStrategy: ['Use the frontend implementation lane.'],
            repairPlan: ['Make the actual frontend change.'],
            lesson: 'Route frontend implementation requests through code changes and browser verification.',
            toolUseDecision: 'tool_gap',
            toolMisuseCategories: ['missing_required_tool'],
            expectedTools: ['web-scrape'],
            actualTools: [],
            missingTools: ['web-scrape'],
            misusedTools: [],
            toolFixes: ['Run browser verification before finalizing.'],
            toolLesson: 'Frontend requests need browser verification evidence.',
            memoryCandidate: false,
        },
    })),
}));

const { sessionStore } = require('../session-store');
const { memoryService } = require('../memory/memory-service');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const { executeConversationRuntime } = require('../runtime-execution');
const { artifactService } = require('../artifacts/artifact-service');
const alignmentEvaluator = require('../alignment/evaluator-service');
const {
    buildInstructionsWithArtifacts,
    generateOutputArtifactFromPrompt,
    maybePrepareImagesForArtifactPrompt,
    maybeGenerateOutputArtifact,
    resolveSshRequestContext,
    resolveDeferredWorkloadPreflight,
    shouldSuppressNotesSurfaceArtifact,
    shouldSuppressImplicitMermaidArtifact,
    stripInjectedNotesPageEditDirective,
    resolveReasoningEffort,
} = require('../ai-route-utils');

const chatRouter = require('./chat');

describe('/api/chat route', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const routeUtils = require('../ai-route-utils');

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
        sessionStore.upsertMessage.mockResolvedValue({});
        sessionStore.loadAllSessionMessages.mockResolvedValue([]);
        buildInstructionsWithArtifacts.mockResolvedValue('continuity instructions');
        maybeGenerateOutputArtifact.mockResolvedValue([]);
        maybePrepareImagesForArtifactPrompt.mockResolvedValue({
            artifactIds: [],
            artifacts: [],
            toolEvents: [],
            imagePrompt: null,
        });
        memoryService.process.mockResolvedValue({ contextMessages: [] });
        routeUtils.inferRequestedOutputFormat.mockReturnValue(null);
        routeUtils.inferOutputFormatFromSession.mockReturnValue(null);
        routeUtils.inferOutputFormatFromArtifactContext.mockResolvedValue(null);
        routeUtils.resolveArtifactContextIds.mockReturnValue([]);
        routeUtils.buildPiiWorkbookRelationshipToolContext.mockResolvedValue(null);
        shouldSuppressNotesSurfaceArtifact.mockReturnValue(false);
        shouldSuppressImplicitMermaidArtifact.mockReturnValue(false);
        routeUtils.shouldSuppressWebChatImplicitHtmlArtifact.mockReturnValue(false);
        routeUtils.isArtifactStorageAvailable.mockReturnValue(true);
        stripInjectedNotesPageEditDirective.mockImplementation((text) => text);
        resolveSshRequestContext.mockReturnValue({});
        resolveReasoningEffort.mockReturnValue(null);
        resolveDeferredWorkloadPreflight.mockReturnValue({
            timing: 'now',
            shouldSchedule: false,
            request: '',
            scenario: null,
        });
    });

    test('records thumbs-up alignment feedback without evaluator call', async () => {
        const session = { id: 'session-1', metadata: {} };
        const assistantMessage = {
            id: 'assistant-1',
            role: 'assistant',
            content: 'I added the icon.',
            timestamp: '2026-05-09T12:00:01.000Z',
            metadata: {},
        };
        sessionStore.get.mockResolvedValue(session);
        sessionStore.loadAllSessionMessages.mockResolvedValue([
            {
                id: 'user-1',
                role: 'user',
                content: 'Add an icon beside read aloud.',
                timestamp: '2026-05-09T12:00:00.000Z',
                metadata: {},
            },
            assistantMessage,
        ]);
        sessionStore.upsertMessage.mockImplementation(async (_sessionId, message) => message);

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat/session-1/messages/assistant-1/alignment-feedback')
            .send({ rating: 'up', clientSurface: 'web-chat' })
            .expect(200);

        expect(alignmentEvaluator.evaluateAlignment).not.toHaveBeenCalled();
        expect(response.body.data.status).toBe('recorded');
        expect(sessionStore.upsertMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            id: 'assistant-1',
            metadata: expect.objectContaining({
                alignmentFeedback: expect.objectContaining({
                    rating: 'up',
                    status: 'recorded',
                    evaluationId: expect.stringMatching(/^align_/),
                }),
            }),
        }));
        expect(sessionStore.update).toHaveBeenCalledWith('session-1', expect.objectContaining({
            metadata: expect.objectContaining({
                alignmentRoutePatterns: expect.arrayContaining([
                    expect.objectContaining({
                        requestType: 'frontend',
                        routeDecision: 'correct_route',
                    }),
                ]),
                alignmentToolReinforcement: expect.arrayContaining([
                    expect.objectContaining({
                        requestType: 'frontend',
                        toolUseDecision: 'correct_tools',
                        actualTools: ['ui-check'],
                    }),
                ]),
            }),
        }));
        expect(memoryService.rememberLearnedSkill).toHaveBeenCalledWith('session-1', expect.objectContaining({
            assistantText: expect.stringContaining('Tool lesson: The UI verification tool pattern worked.'),
        }));
    });

    test('runs evaluator for thumbs-down alignment feedback and stores guidance', async () => {
        const session = { id: 'session-1', metadata: {} };
        const assistantMessage = {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Here is a conceptual plan.',
            timestamp: '2026-05-09T12:00:01.000Z',
            metadata: {},
        };
        sessionStore.get.mockResolvedValue(session);
        sessionStore.loadAllSessionMessages.mockResolvedValue([
            {
                id: 'user-1',
                role: 'user',
                content: 'Implement the web-chat icon.',
                timestamp: '2026-05-09T12:00:00.000Z',
                metadata: {},
            },
            assistantMessage,
        ]);
        sessionStore.upsertMessage.mockImplementation(async (_sessionId, message) => message);

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat/session-1/messages/assistant-1/alignment-feedback')
            .send({ rating: 'down', reason: 'It planned instead of implementing.', clientSurface: 'web-chat' })
            .expect(200);

        expect(alignmentEvaluator.evaluateAlignment).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            messageId: 'assistant-1',
            rating: 'down',
            reason: 'It planned instead of implementing.',
            userText: 'Implement the web-chat icon.',
            assistantText: 'Here is a conceptual plan.',
        }));
        expect(response.body.data.status).toBe('completed');
        expect(response.body.data.evaluation.summary).toBe('Needs UI follow-through.');
        expect(sessionStore.update).toHaveBeenCalledWith('session-1', expect.objectContaining({
            metadata: expect.objectContaining({
                alignmentFeedback: expect.objectContaining({
                    rating: 'down',
                    status: 'completed',
                    evaluation: expect.objectContaining({
                        requestType: 'frontend',
                    }),
                }),
                alignmentFeedbackHistory: expect.arrayContaining([
                    expect.objectContaining({ rating: 'down' }),
                ]),
            }),
        }));
    });

    test('persists reusable routing lesson for wrong-route negative feedback', async () => {
        alignmentEvaluator.evaluateAlignment.mockResolvedValueOnce({
            feedbackId: 'align-wrong-route',
            status: 'completed',
            model: 'gpt-evaluator',
            evaluation: {
                decision: 'misaligned',
                requestType: 'frontend',
                confidence: 0.9,
                summary: 'The assistant answered with prose instead of changing the web-chat UI.',
                evidence: ['User requested an implementation.'],
                recommendedChanges: ['Make the frontend change and verify it.'],
                decisionGuidance: ['For web-chat UI asks, use the frontend implementation path.'],
                routeDecision: 'wrong_route',
                expectedRoute: 'Frontend implementation route with served browser verification.',
                actualRoute: 'taskType=chat; tools=none',
                failureCategories: ['answered_instead_of_acted', 'missing_visual_verification'],
                fixStrategy: ['Select the frontend/code path, then run a served UI check.'],
                repairPlan: ['Edit the web-chat frontend.', 'Run a served UI check.'],
                lesson: 'Web-chat UI implementation prompts should not stop at advice; route them to frontend edits plus served browser verification.',
                toolUseDecision: 'tool_gap',
                toolMisuseCategories: ['missing_required_tool', 'skipped_verification_tool'],
                expectedTools: ['web-scrape'],
                actualTools: [],
                missingTools: ['web-scrape'],
                misusedTools: [],
                toolFixes: ['Run web-scrape/browser verification before finalizing.'],
                toolLesson: 'Frontend UI requests need browser verification tools, not prose-only answers.',
                promoteRegressionFixture: true,
                memoryCandidate: true,
            },
        });
        const session = { id: 'session-1', metadata: { clientSurface: 'web-chat', memoryScope: 'web-chat' } };
        const assistantMessage = {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Here is how you could do it.',
            timestamp: '2026-05-09T12:00:01.000Z',
            metadata: { taskType: 'chat', toolEvents: [] },
        };
        sessionStore.get.mockResolvedValue(session);
        sessionStore.loadAllSessionMessages.mockResolvedValue([
            {
                id: 'user-1',
                role: 'user',
                content: 'Fix the web-chat review buttons.',
                timestamp: '2026-05-09T12:00:00.000Z',
                metadata: {},
            },
            assistantMessage,
        ]);
        sessionStore.upsertMessage.mockImplementation(async (_sessionId, message) => message);

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        await request(app)
            .post('/api/chat/session-1/messages/assistant-1/alignment-feedback')
            .send({ rating: 'down', reason: 'Wrong path.', clientSurface: 'web-chat' })
            .expect(200);

        expect(memoryService.rememberLearnedSkill).toHaveBeenCalledWith('session-1', expect.objectContaining({
            objective: 'Fix the web-chat review buttons.',
            assistantText: expect.stringContaining('Web-chat UI implementation prompts should not stop at advice'),
            toolEvents: expect.arrayContaining([
                expect.objectContaining({
                    result: expect.objectContaining({
                        toolId: 'alignment-evaluator',
                    }),
                }),
            ]),
        }));
        expect(sessionStore.update).toHaveBeenCalledWith('session-1', expect.objectContaining({
            metadata: expect.objectContaining({
                alignmentRegressionFixtures: expect.arrayContaining([
                    expect.objectContaining({
                        source: 'alignment-feedback',
                        prompt: 'Fix the web-chat review buttons.',
                        expected: expect.objectContaining({
                            requestType: 'frontend',
                            forbiddenRoute: 'taskType=chat; tools=none',
                            failureCategories: ['answered_instead_of_acted', 'missing_visual_verification'],
                            expectedTools: ['web-scrape'],
                            missingTools: ['web-scrape'],
                            toolMisuseCategories: ['missing_required_tool', 'skipped_verification_tool'],
                        }),
                    }),
                ]),
                alignmentToolReinforcement: expect.arrayContaining([
                    expect.objectContaining({
                        requestType: 'frontend',
                        toolUseDecision: 'tool_gap',
                        expectedTools: ['web-scrape'],
                        missingTools: ['web-scrape'],
                        toolMisuseCategories: ['missing_required_tool', 'skipped_verification_tool'],
                    }),
                ]),
            }),
        }));
    });

    test('runs explicit podcast requests through the podcast tool without chat orchestration', async () => {
        const toolManager = {
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    title: 'Cats in Conversation',
                    summary: 'A short two-host episode about cats.',
                    artifacts: [{
                        id: 'artifact-podcast-1',
                        filename: 'cats.wav',
                        mimeType: 'audio/wav',
                        downloadUrl: '/api/artifacts/artifact-podcast-1/download',
                    }],
                },
            }),
            getTool: jest.fn(),
        };
        ensureRuntimeToolManager.mockResolvedValue(toolManager);

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'can you make a podcast on cats',
                stream: false,
                model: 'gpt-test',
                metadata: {
                    clientSurface: 'web-chat',
                },
            });

        expect(response.status).toBe(200);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'podcast',
            expect.objectContaining({
                topic: 'cats',
                model: 'gpt-test',
            }),
            expect.objectContaining({
                sessionId: 'session-1',
                route: '/api/chat',
                transport: 'http',
                executionProfile: 'podcast',
            }),
        );
        expect(executeConversationRuntime).not.toHaveBeenCalled();
        expect(memoryService.process).not.toHaveBeenCalled();
        expect(response.body.message).toContain('Cats in Conversation');
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-podcast-1',
                filename: 'cats.wav',
            }),
        ]);
        expect(sessionStore.appendMessages).toHaveBeenCalledWith('session-1', expect.arrayContaining([
            expect.objectContaining({
                role: 'assistant',
                content: expect.stringContaining('The podcast has been created'),
            }),
        ]));
    });

    test('runs prepared PII workbook relationships through the trusted calculator before model chat', async () => {
        const routeUtils = require('../ai-route-utils');
        const workbookRequest = {
            operationId: 'workbook-top-balance',
            operation: 'top_n',
            tableId: 't1',
            groupBy: 'c1',
            measure: 'c2',
            limit: 1,
            tables: [{
                id: 't1',
                columns: [
                    { id: 'c1', role: 'private-group-key' },
                    { id: 'c2', role: 'measure' },
                ],
                rows: [{
                    id: 't1_r1',
                    cells: {
                        c1: '[[PII:patientIdentifier:abc]]',
                        c2: 42,
                    },
                }],
            }],
        };
        routeUtils.resolveArtifactContextIds.mockReturnValue(['artifact-xlsx']);
        routeUtils.buildPiiWorkbookRelationshipToolContext.mockResolvedValue({
            request: workbookRequest,
            context: {
                piiEntries: [{
                    placeholder: '[[PII:patientIdentifier:abc]]',
                    valueIndexHmac: 'hmac-1',
                    piiType: 'patientIdentifier',
                }],
                piiCleansing: {
                    contextIds: ['ctx-1'],
                    relationshipCalculations: { active: true },
                },
            },
        });
        const toolManager = {
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    operation: 'top_n',
                    sanitized: true,
                    winnerPlaceholder: '[[PII:patientIdentifier:abc]]',
                    aggregateValue: 42,
                    rowCount: 1,
                    evidenceRowIds: ['t1_r1'],
                },
            }),
            getTool: jest.fn(),
        };
        ensureRuntimeToolManager.mockResolvedValue(toolManager);
        const storeSpy = jest.spyOn(artifactService, 'storeGeneratedArtifactFromContent').mockResolvedValue({
            id: 'artifact-result-xlsx',
            filename: 'pii-vault-calculation-result.xlsx',
            format: 'xlsx',
            downloadUrl: '/api/artifacts/artifact-result-xlsx/download',
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Find the highest total Patient Balance from the selected XLSX.',
                stream: false,
                model: 'auto',
                outputFormat: 'xlsx',
                artifactIds: ['artifact-xlsx'],
                metadata: {
                    clientSurface: 'web-chat',
                },
            });

        expect(response.status).toBe(200);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'pii-relationship-calculate',
            workbookRequest,
            expect.objectContaining({
                sessionId: 'session-1',
                route: '/api/chat',
                piiEntries: expect.arrayContaining([
                    expect.objectContaining({
                        placeholder: '[[PII:patientIdentifier:abc]]',
                        valueIndexHmac: 'hmac-1',
                    }),
                ]),
            }),
        );
        expect(executeConversationRuntime).not.toHaveBeenCalled();
        expect(storeSpy).toHaveBeenCalledWith(expect.objectContaining({
            format: 'xlsx',
            title: 'pii-vault-calculation-result',
            content: expect.stringContaining('[[PII:patientIdentifier:abc]] | 42 | 1 | t1_r1'),
            metadata: expect.objectContaining({
                source: 'trusted-pii-relationship-calculation',
                piiCleansing: expect.any(Object),
            }),
        }));
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-result-xlsx',
                format: 'xlsx',
            }),
        ]);
        expect(response.body.message).toContain('[[PII:patientIdentifier:abc]]');
        expect(response.body.message).toContain('"total_patient_balance":42');
        expect(response.body.toolEvents).toEqual([
            expect.objectContaining({
                toolCall: expect.objectContaining({
                    function: expect.objectContaining({
                        name: 'pii-relationship-calculate',
                    }),
                }),
            }),
        ]);
        storeSpy.mockRestore();
    });

    test('routes SSH-looking requests through the orchestrator instead of executing a direct tool shortcut', async () => {
        const toolManager = {
            executeTool: jest.fn(),
            getTool: jest.fn(),
        };
        ensureRuntimeToolManager.mockResolvedValue(toolManager);
        resolveSshRequestContext.mockReturnValue({
            explicitIntent: false,
            continuation: true,
            shouldTreatAsSsh: true,
            effectivePrompt: 'SSH into root@test.demoserver2.buzz and check the failing init container logs',
            target: {
                host: 'test.demoserver2.buzz',
                username: 'root',
                port: 22,
            },
            command: 'kubectl logs -n gitea gitea-cc75bfc56-jprw4 -c init-app-ini --previous',
            directParams: {
                host: 'test.demoserver2.buzz',
                username: 'root',
                port: 22,
                command: 'kubectl logs -n gitea gitea-cc75bfc56-jprw4 -c init-app-ini --previous',
            },
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'Handled by orchestrator' }],
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
                message: 'check the failing init container logs',
                stream: false,
            });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            sessionId: 'session-1',
            responseId: 'resp-1',
            message: 'Handled by orchestrator',
        });
        expect(executeConversationRuntime).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                input: 'SSH into root@test.demoserver2.buzz and check the failing init container logs',
                sessionId: 'session-1',
                memoryInput: 'check the failing init container logs',
                stream: false,
                toolManager,
            }),
        );
        expect(toolManager.executeTool).not.toHaveBeenCalled();
    });

    test('persists the active chat model onto the session for later workload reuse', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Schedule a follow-up later.',
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-model-session-1',
                model: 'gpt-5.3-instant',
                output: [{
                    type: 'message',
                    content: [{ text: 'Scheduled.' }],
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
                message: 'Schedule a follow-up later.',
                model: 'gpt-5.3-instant',
                stream: false,
            });

        expect(response.status).toBe(200);
        expect(sessionStore.update).toHaveBeenCalledWith('session-1', expect.objectContaining({
            metadata: expect.objectContaining({
                model: 'gpt-5.3-instant',
            }),
        }));
    });

    test('suppresses implicit Mermaid artifact fallback for notes-style requests', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Create a Mermaid diagram for the auth flow inside this page',
        });
        shouldSuppressImplicitMermaidArtifact.mockReturnValue(true);
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-notes-1',
                model: 'gemini-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'Returned through normal runtime' }],
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
                message: 'Create a Mermaid diagram for the auth flow inside this page',
                stream: false,
                metadata: { taskType: 'notes', clientSurface: 'notes' },
            });

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Returned through normal runtime');
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
        expect(shouldSuppressImplicitMermaidArtifact).toHaveBeenCalledWith(expect.objectContaining({
            taskType: 'notes',
            text: 'Create a Mermaid diagram for the auth flow inside this page',
            outputFormatProvided: false,
        }));
    });

    test('falls back to normal chat for implicit web-chat artifacts when storage is unavailable', async () => {
        const routeUtils = require('../ai-route-utils');
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        routeUtils.inferRequestedOutputFormat.mockReturnValue('html');
        routeUtils.isArtifactStorageAvailable.mockReturnValue(false);
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Build me a simple HTML questionnaire page.',
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-chat-fallback-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'Returned through normal runtime' }],
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
                message: 'Build me a simple HTML questionnaire page.',
                stream: false,
                metadata: { clientSurface: 'web-chat' },
            });

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Returned through normal runtime');
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
    });

    test('suppresses direct PDF artifact generation for notes page-edit requests', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Put this hypercar collection on the page as a polished brochure PDF.',
        });
        require('../ai-route-utils').inferRequestedOutputFormat.mockReturnValue('pdf');
        shouldSuppressNotesSurfaceArtifact.mockReturnValue(true);
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-notes-pdf-1',
                model: 'gemini-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'Returned through normal runtime' }],
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
                message: 'Put this hypercar collection on the page as a polished brochure PDF.',
                stream: false,
                metadata: { taskType: 'notes', clientSurface: 'notes' },
            });

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Returned through normal runtime');
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
        expect(shouldSuppressNotesSurfaceArtifact).toHaveBeenCalledWith(expect.objectContaining({
            taskType: 'notes',
            text: 'Put this hypercar collection on the page as a polished brochure PDF.',
            outputFormat: 'pdf',
            outputFormatProvided: false,
        }));
    });

    test('allows direct PDF artifact generation for explicit notes exports', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Export this page as a PDF file I can download.',
        });
        shouldSuppressNotesSurfaceArtifact.mockReturnValue(false);
        generateOutputArtifactFromPrompt.mockResolvedValue({
            responseId: 'resp-notes-export-1',
            artifact: { id: 'pdf-artifact-1', filename: 'page-export.pdf' },
            artifacts: [{ id: 'pdf-artifact-1', filename: 'page-export.pdf' }],
            assistantMessage: 'Created the PDF artifact (page-export.pdf).',
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Export this page as a PDF file I can download.',
                stream: false,
                outputFormat: 'pdf',
                metadata: { taskType: 'notes', clientSurface: 'notes' },
            });

        expect(response.status).toBe(200);
        expect(generateOutputArtifactFromPrompt).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            mode: 'notes',
            outputFormat: 'pdf',
        }));
        expect(executeConversationRuntime).not.toHaveBeenCalled();
        expect(response.body.message).toBe('Created the PDF artifact (page-export.pdf).');
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({ id: 'pdf-artifact-1', filename: 'page-export.pdf' }),
        ]);
    });

    test('creates an HTML artifact on web-chat for explicit html build requests', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Build me a simple HTML questionnaire page.',
        });
        require('../ai-route-utils').inferRequestedOutputFormat.mockReturnValue('html');
        generateOutputArtifactFromPrompt.mockResolvedValue({
            responseId: 'resp-html-export-1',
            artifact: {
                id: 'html-artifact-1',
                filename: 'questionnaire.html',
                downloadUrl: '/api/artifacts/html-artifact-1/download',
            },
            artifacts: [{
                id: 'html-artifact-1',
                filename: 'questionnaire.html',
                downloadUrl: '/api/artifacts/html-artifact-1/download',
            }],
            assistantMessage: 'Created the HTML artifact (questionnaire.html).',
        });

        const app = express();
        const documentService = { id: 'document-service' };
        app.locals.documentService = documentService;
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Build me a simple HTML questionnaire page.',
                stream: false,
                metadata: { clientSurface: 'web-chat' },
            });

        expect(response.status).toBe(200);
        expect(generateOutputArtifactFromPrompt).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            mode: 'web-chat',
            outputFormat: 'html',
            toolContext: expect.objectContaining({
                documentService,
            }),
        }));
        expect(executeConversationRuntime).not.toHaveBeenCalled();
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({
                id: 'html-artifact-1',
                filename: 'questionnaire.html',
                downloadUrl: '/api/artifacts/html-artifact-1/download',
            }),
        ]);
    });

    test('routes selected uploaded PDF update turns through artifact revision even without explicit output format', async () => {
        const routeUtils = require('../ai-route-utils');
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Update this document with the missing pricing section.',
        });
        routeUtils.resolveArtifactContextIds.mockReturnValue(['artifact-upload-pdf-1']);
        routeUtils.inferOutputFormatFromArtifactContext.mockResolvedValue('pdf');
        maybePrepareImagesForArtifactPrompt.mockImplementation(async ({ artifactIds = [] } = {}) => ({
            artifactIds,
            artifacts: [],
            toolEvents: [],
            imagePrompt: null,
        }));
        generateOutputArtifactFromPrompt.mockResolvedValue({
            responseId: 'resp-pdf-update-1',
            artifact: { id: 'pdf-artifact-v2', filename: 'uploaded-plan-v2.pdf' },
            artifacts: [{ id: 'pdf-artifact-v2', filename: 'uploaded-plan-v2.pdf' }],
            assistantMessage: 'Created the PDF artifact (uploaded-plan-v2.pdf).',
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Update this document with the missing pricing section.',
                stream: false,
                artifactIds: ['artifact-upload-pdf-1'],
                metadata: { clientSurface: 'web-chat' },
            });

        expect(response.status).toBe(200);
        expect(routeUtils.inferOutputFormatFromArtifactContext).toHaveBeenCalledWith({
            sessionId: 'session-1',
            artifactIds: ['artifact-upload-pdf-1'],
            text: 'Update this document with the missing pricing section.',
        });
        expect(generateOutputArtifactFromPrompt).toHaveBeenCalledWith(expect.objectContaining({
            outputFormat: 'pdf',
            artifactIds: ['artifact-upload-pdf-1'],
            prompt: 'Update this document with the missing pricing section.',
        }));
        expect(executeConversationRuntime).not.toHaveBeenCalled();
    });

    test('persists save-as HTML responses as session artifacts when normal chat returns them', async () => {
        const storeSpy = jest.spyOn(artifactService, 'storeGeneratedArtifactFromContent').mockResolvedValue({
            id: 'artifact-skydiving-html',
            filename: 'skydiving-research.html',
            format: 'html',
            downloadUrl: '/api/artifacts/artifact-skydiving-html/download',
            previewUrl: '/api/artifacts/artifact-skydiving-html/preview',
        });
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'make a skydiving research project',
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: false,
            response: {
                id: 'resp-saveable-html-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{
                        text: [
                            'I can make it, but one verification step failed. Save this as `skydiving-research.html`.',
                            '```html',
                            '<!DOCTYPE html><html><head><title>Skydiving Research</title></head><body><main>Ready</main></body></html>',
                            '```',
                        ].join('\n'),
                    }],
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
                message: 'make a skydiving research project',
                stream: false,
                metadata: { clientSurface: 'web-chat' },
            });

        expect(response.status).toBe(200);
        expect(storeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            mode: 'web-chat',
            format: 'html',
            title: 'skydiving-research',
            content: expect.stringContaining('<!DOCTYPE html>'),
        }));
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-skydiving-html',
                filename: 'skydiving-research.html',
            }),
        ]);
        expect(sessionStore.appendMessages).toHaveBeenCalledWith(
            'session-1',
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'assistant',
                    content: 'Created skydiving-research.html. Preview and Download below.',
                }),
            ]),
        );

        storeSpy.mockRestore();
    });

    test('expands referential artifact follow-ups before memory recall', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'yes make it a pdf on that',
        });
        require('../ai-route-utils').inferRequestedOutputFormat.mockReturnValue('pdf');
        sessionStore.getRecentMessages.mockResolvedValue([
            { role: 'user', content: 'Research Halifax vacation pricing for a presentation.' },
            { role: 'assistant', content: 'I can do that.' },
        ]);
        generateOutputArtifactFromPrompt.mockResolvedValue({
            responseId: 'resp-followup-pdf-1',
            artifact: { id: 'pdf-artifact-followup-1', filename: 'halifax-pricing.pdf' },
            artifacts: [{ id: 'pdf-artifact-followup-1', filename: 'halifax-pricing.pdf' }],
            assistantMessage: 'Created the PDF artifact (halifax-pricing.pdf).',
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'yes make it a pdf on that',
                stream: false,
            });

        expect(response.status).toBe(200);
        expect(memoryService.process).toHaveBeenCalledWith(
            'session-1',
            'yes make it a pdf on that',
            expect.objectContaining({
                recallQuery: 'Research Halifax vacation pricing for a presentation. yes make it a pdf on that',
                objective: 'Research Halifax vacation pricing for a presentation. yes make it a pdf on that',
                recentMessages: [
                    { role: 'user', content: 'Research Halifax vacation pricing for a presentation.' },
                    { role: 'assistant', content: 'I can do that.' },
                ],
            }),
        );
    });

    test('strips the injected notes page-edit directive before artifact inference on /api/chat', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Create a page about penguins.\n\nInterpret "page" as the current notes page shown in this editor. This is a direct page edit request, so return notes-actions that apply the content to the current notes page unless the user explicitly says web page, site page, repo file, or server component. Put the result into page blocks. Do not reply with chat prose alone. Do not create standalone HTML, file, export, artifact, or download-link output unless the user explicitly asked for that.',
        });
        stripInjectedNotesPageEditDirective.mockImplementation((text) => (
            String(text).replace(/\n\nInterpret "page" as the current notes page shown in this editor[\s\S]*$/i, '')
        ));
        require('../ai-route-utils').inferRequestedOutputFormat.mockImplementation((text) => (
            /\bweb page\b/i.test(text) || /\bartifact\b/i.test(text) ? 'html' : null
        ));
        shouldSuppressNotesSurfaceArtifact.mockReturnValue(false);
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-notes-chat-1',
                model: 'gpt-4o',
                output: [{
                    type: 'message',
                    content: [{ text: 'Returned through normal runtime' }],
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
                message: 'Create a page about penguins.\n\nInterpret "page" as the current notes page shown in this editor. This is a direct page edit request, so return notes-actions that apply the content to the current notes page unless the user explicitly says web page, site page, repo file, or server component. Put the result into page blocks. Do not reply with chat prose alone. Do not create standalone HTML, file, export, artifact, or download-link output unless the user explicitly asked for that.',
                stream: false,
                metadata: { taskType: 'notes', clientSurface: 'notes' },
            });

        expect(response.status).toBe(200);
        expect(stripInjectedNotesPageEditDirective).toHaveBeenCalled();
        expect(require('../ai-route-utils').inferRequestedOutputFormat).toHaveBeenCalledWith('Create a page about penguins.');
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
    });

    test('pre-generates image artifacts before direct PDF creation for mixed requests', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(() => ({ id: 'image-generate' })),
            executeTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Make a hypercar image and put it in a PDF brochure.',
        });
        require('../ai-route-utils').inferRequestedOutputFormat.mockReturnValue('pdf');
        maybePrepareImagesForArtifactPrompt.mockResolvedValue({
            artifactIds: ['image-artifact-1'],
            artifacts: [{ id: 'image-artifact-1', filename: 'hypercar-01.png' }],
            toolEvents: [{ toolCall: { function: { name: 'image-generate' } } }],
            imagePrompt: 'Make a hypercar image',
            resetPreviousResponse: true,
        });
        generateOutputArtifactFromPrompt.mockResolvedValue({
            responseId: 'resp-pdf-1',
            artifact: { id: 'pdf-artifact-1', filename: 'hypercars.pdf' },
            artifacts: [{ id: 'pdf-artifact-1', filename: 'hypercars.pdf' }],
            assistantMessage: 'Created the PDF artifact (hypercars.pdf).',
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Make a hypercar image and put it in a PDF brochure.',
                stream: false,
            });

        expect(response.status).toBe(200);
        expect(maybePrepareImagesForArtifactPrompt).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            text: 'Make a hypercar image and put it in a PDF brochure.',
            outputFormat: 'pdf',
            artifactIds: [],
        }));
        expect(generateOutputArtifactFromPrompt).toHaveBeenCalledWith(expect.objectContaining({
            artifactIds: ['image-artifact-1'],
            outputFormat: 'pdf',
            session: expect.objectContaining({
                previousResponseId: null,
            }),
        }));
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({ id: 'image-artifact-1', filename: 'hypercar-01.png' }),
            expect.objectContaining({ id: 'pdf-artifact-1', filename: 'hypercars.pdf' }),
        ]);
        expect(response.body.toolEvents).toEqual([{ toolCall: { function: { name: 'image-generate' } } }]);
    });

    test('routes scheduled PDF requests through the runtime instead of generating the artifact immediately', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'can you do web search on penguins and then make a pdf for me but schedule it for 5 minutes from now',
        });
        require('../ai-route-utils').inferRequestedOutputFormat.mockReturnValue('pdf');
        resolveDeferredWorkloadPreflight.mockReturnValue({
            timing: 'future',
            shouldSchedule: true,
            request: 'can you do web search on penguins and then make a pdf for me but schedule it for 5 minutes from now',
            scenario: {
                trigger: {
                    type: 'once',
                    runAt: '2026-04-03T14:52:00.000Z',
                },
            },
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-scheduled-pdf-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'Penguin PDF scheduled.' }],
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
                message: 'can you do web search on penguins and then make a pdf for me but schedule it for 5 minutes from now',
                stream: false,
            });

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Penguin PDF scheduled.');
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(maybeGenerateOutputArtifact).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
        expect(resolveDeferredWorkloadPreflight).toHaveBeenCalledWith(expect.objectContaining({
            text: 'can you do web search on penguins and then make a pdf for me but schedule it for 5 minutes from now',
        }));
    });

    test('routes time-first scheduled PDF requests through the runtime instead of generating the artifact immediately', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'in 5 minutes can you do some research on adhd and make a pdf document on it I can review, make it designed to questions on diagnosis and why its adhd traits.',
        });
        require('../ai-route-utils').inferRequestedOutputFormat.mockReturnValue('pdf');
        resolveDeferredWorkloadPreflight.mockReturnValue({
            timing: 'future',
            shouldSchedule: true,
            request: 'in 5 minutes can you do some research on adhd and make a pdf document on it I can review, make it designed to questions on diagnosis and why its adhd traits.',
            scenario: {
                trigger: {
                    type: 'once',
                    runAt: '2026-04-03T14:52:00.000Z',
                },
            },
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-scheduled-adhd-pdf-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'ADHD PDF scheduled.' }],
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
                message: 'in 5 minutes can you do some research on adhd and make a pdf document on it I can review, make it designed to questions on diagnosis and why its adhd traits.',
                stream: false,
            });

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('ADHD PDF scheduled.');
        expect(generateOutputArtifactFromPrompt).not.toHaveBeenCalled();
        expect(maybeGenerateOutputArtifact).not.toHaveBeenCalled();
        expect(executeConversationRuntime).toHaveBeenCalled();
        expect(resolveDeferredWorkloadPreflight).toHaveBeenCalledWith(expect.objectContaining({
            text: 'in 5 minutes can you do some research on adhd and make a pdf document on it I can review, make it designed to questions on diagnosis and why its adhd traits.',
        }));
    });

    test('forwards normalized reasoning effort into runtime execution', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Answer directly with more reasoning.',
        });
        resolveReasoningEffort.mockReturnValue('high');
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-reasoning-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'Reasoned answer' }],
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
                message: 'Answer directly with more reasoning.',
                stream: false,
                reasoning_effort: 'high',
            });

        expect(response.status).toBe(200);
        expect(resolveReasoningEffort).toHaveBeenCalledWith(expect.objectContaining({
            reasoning_effort: 'high',
        }));
        expect(executeConversationRuntime).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                reasoningEffort: 'high',
            }),
        );
    });

    test('streams reasoning deltas and final reasoning metadata through /api/chat', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Check this request.',
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: false,
            response: (async function* streamWithReasoning() {
                yield {
                    type: 'response.reasoning_summary_text.delta',
                    delta: 'Checking the request. ',
                    summary: 'Checking the request. ',
                };
                yield {
                    type: 'response.output_text.delta',
                    delta: 'Answer',
                };
                yield {
                    type: 'response.completed',
                    response: {
                        id: 'resp-stream-reasoning-1',
                        model: 'gpt-test',
                        output: [{
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'text', text: 'Answer' }],
                        }],
                        metadata: {
                            reasoningSummary: 'Checked the request and chose the direct path.',
                            reasoningAvailable: true,
                            toolEvents: [],
                        },
                    },
                };
            }()),
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Check this request.',
                stream: true,
            });

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/event-stream');
        expect(response.headers['cache-control']).toContain('no-transform');
        expect(response.headers['x-accel-buffering']).toBe('no');
        expect(response.text).toContain(': stream-open');
        expect(response.text).toContain('"type":"response.reasoning_summary_text.delta"');
        expect(response.text).toContain('"delta":"Checking the request. "');
        expect(response.text).toContain('"summary":"Checking the request. "');
        expect(response.text).toContain('"type":"delta","content":"Answer"');
        expect(response.text).toContain('"assistantMetadata":{"reasoningSummary":"Checked the request and chose the direct path.","reasoningAvailable":true}');
        expect(response.text).toContain('data: [DONE]');
        expect(sessionStore.appendMessages).toHaveBeenCalledWith('session-1', expect.arrayContaining([
            expect.objectContaining({
                role: 'assistant',
                content: 'Answer',
                metadata: expect.objectContaining({
                    reasoningSummary: 'Checked the request and chose the direct path.',
                    reasoningAvailable: true,
                }),
            }),
        ]));
    });

    test('streams progress updates for long-running chat work through /api/chat', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Investigate and fix the issue.',
        });
        executeConversationRuntime.mockImplementation(async (_app, params) => {
            params.onProgress?.({
                phase: 'planning',
                detail: 'Estimating the work and lining up the steps.',
                summary: '0/3 steps complete',
                totalSteps: 3,
                completedSteps: 0,
                estimated: true,
                steps: [
                    { id: 'inspect', title: 'Inspect the current state', status: 'in_progress' },
                    { id: 'implement', title: 'Implement the requested changes', status: 'pending' },
                    { id: 'validate', title: 'Validate the result', status: 'pending' },
                ],
            });
            params.onProgress?.({
                phase: 'executing',
                detail: 'Inspect the current state',
                summary: '1/3 steps complete',
                totalSteps: 3,
                completedSteps: 1,
                estimated: true,
                steps: [
                    { id: 'inspect', title: 'Inspect the current state', status: 'completed' },
                    { id: 'implement', title: 'Implement the requested changes', status: 'in_progress' },
                    { id: 'validate', title: 'Validate the result', status: 'pending' },
                ],
            });

            return {
                handledPersistence: false,
                response: (async function* streamWithProgress() {
                    yield {
                        type: 'response.completed',
                        response: {
                            id: 'resp-stream-progress-1',
                            model: 'gpt-test',
                            output: [{
                                type: 'message',
                                role: 'assistant',
                                content: [{ type: 'text', text: 'Done' }],
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
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Investigate and fix the issue.',
                stream: true,
                metadata: {
                    clientSurface: 'web-chat',
                    foregroundRequestId: 'assistant-live-1',
                    messageId: 'user-live-1',
                    assistantMessageId: 'assistant-live-1',
                    userMessageTimestamp: '2026-04-24T12:00:00.000Z',
                    assistantMessageTimestamp: '2026-04-24T12:00:00.001Z',
                },
            });
        await new Promise((resolve) => setImmediate(resolve));

        expect(response.status).toBe(200);
        expect(response.text).toContain('"type":"progress"');
        expect(response.text).toContain('"phase":"planning"');
        expect(response.text).toContain('"summary":"1/3 steps complete"');
        expect(response.text).toContain('"totalSteps":3');
        expect(response.text).toContain('"type":"delta","content":"Done"');
        expect(sessionStore.upsertMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            id: 'assistant-live-1',
            role: 'assistant',
            metadata: expect.objectContaining({
                pendingForeground: true,
                progressState: expect.objectContaining({
                    phase: 'planning',
                    summary: '0/3 steps complete',
                }),
            }),
        }));
        expect(sessionStore.upsertMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            id: 'assistant-live-1',
            role: 'assistant',
            content: 'Done',
            metadata: expect.objectContaining({
                pendingForeground: false,
                progressState: null,
            }),
        }));
    });

    test('streams the completed response text when the runtime emits no deltas', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Say hello.',
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: false,
            response: (async function* streamWithoutDeltas() {
                yield {
                    type: 'response.completed',
                    response: {
                        id: 'resp-final-only',
                        model: 'gpt-test',
                        output: [{
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'text', text: 'Recovered final answer' }],
                        }],
                        metadata: {
                            toolEvents: [],
                        },
                    },
                };
            }()),
        });

        const app = express();
        app.use(express.json());
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Say hello.',
                stream: true,
            });

        expect(response.status).toBe(200);
        expect(response.text).toContain('"type":"delta","content":"Recovered final answer"');
        expect(response.text).toContain('data: [DONE]');
        expect(sessionStore.appendMessages).toHaveBeenCalledWith('session-1', expect.arrayContaining([
            expect.objectContaining({ role: 'assistant', content: 'Recovered final answer' }),
        ]));
    });

    test('surfaces tool-generated documents as chat artifacts when no fallback artifact is created', async () => {
        ensureRuntimeToolManager.mockResolvedValue({
            getTool: jest.fn(),
        });
        resolveSshRequestContext.mockReturnValue({
            effectivePrompt: 'Build the mission control dashboard again.',
        });
        executeConversationRuntime.mockResolvedValue({
            handledPersistence: true,
            response: {
                id: 'resp-dashboard-1',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    content: [{ text: 'I created the dashboard.' }],
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
                                    id: 'doc-1',
                                    filename: 'mission-control.html',
                                    mimeType: 'text/html',
                                    downloadUrl: '/api/documents/doc-1/download',
                                    contentPreview: '<html><body>Mission control</body></html>',
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
        app.use('/api/chat', chatRouter);

        const response = await request(app)
            .post('/api/chat')
            .send({
                sessionId: 'session-1',
                message: 'Build the mission control dashboard again.',
                stream: false,
            });

        expect(response.status).toBe(200);
        expect(maybeGenerateOutputArtifact).not.toHaveBeenCalled();
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({
                id: 'doc-1',
                filename: 'mission-control.html',
                format: 'html',
                mimeType: 'text/html',
                downloadUrl: '/api/documents/doc-1/download',
            }),
        ]);
    });

});

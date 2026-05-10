jest.mock('../routes/admin/settings.controller', () => ({
    getEffectiveOrchestrationConfig: jest.fn(() => ({
        enableAlignmentEvaluator: true,
        applyAlignmentGuidance: true,
        defaultModel: 'gpt-default',
        evaluatorModel: 'gpt-evaluator',
        evaluatorReasoningEffort: 'medium',
    })),
}));

jest.mock('../openai-client', () => ({
    createResponse: jest.fn(),
}));

const { createResponse } = require('../openai-client');
const {
    buildAlignmentGuidanceContext,
    buildRegressionFixtureCandidate,
    evaluateAlignment,
    summarizeToolUse,
    summarizeActualRoute,
} = require('./evaluator-service');

describe('alignment evaluator service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('does not call evaluator model for thumbs-up feedback', async () => {
        const result = await evaluateAlignment({
            feedbackId: 'align-1',
            rating: 'up',
            userText: 'Make a UI change.',
            assistantText: 'Done.',
        });

        expect(createResponse).not.toHaveBeenCalled();
        expect(result.status).toBe('recorded');
        expect(result.evaluation.decision).toBe('aligned');
    });

    test('parses evaluator JSON for thumbs-down feedback', async () => {
        createResponse.mockResolvedValue({
            model: 'gpt-evaluator',
            output_text: JSON.stringify({
                decision: 'misaligned',
                requestType: 'frontend',
                confidence: 0.82,
                summary: 'The answer planned instead of changing the UI.',
                evidence: ['User asked to implement.'],
                recommendedChanges: ['Add the message action icon.'],
                decisionGuidance: ['For UI asks, update the served frontend and verify it.'],
                routeDecision: 'wrong_route',
                expectedRoute: 'Frontend implementation with browser verification.',
                actualRoute: 'taskType=chat; tools=none',
                failureCategories: ['answered_instead_of_acted'],
                fixStrategy: ['Use the frontend implementation route.'],
                repairPlan: ['Patch the UI and run a browser check.'],
                lesson: 'Frontend implementation asks should lead to UI edits and served verification.',
                toolUseDecision: 'tool_gap',
                toolMisuseCategories: ['missing_required_tool', 'skipped_verification_tool'],
                expectedTools: ['web-scrape'],
                actualTools: [],
                missingTools: ['web-scrape'],
                misusedTools: [],
                toolFixes: ['Run browser verification before finalizing.'],
                toolLesson: 'Frontend requests need browser verification evidence.',
                promoteRegressionFixture: true,
                memoryCandidate: false,
            }),
        });

        const result = await evaluateAlignment({
            feedbackId: 'align-2',
            sessionId: 'session-1',
            messageId: 'assistant-1',
            rating: 'down',
            userText: 'Add a thumbs icon beside read aloud.',
            assistantText: 'Here is a plan.',
        });

        expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-evaluator',
            reasoningEffort: 'medium',
        }));
        expect(result.status).toBe('completed');
        expect(result.evaluation).toEqual(expect.objectContaining({
            decision: 'misaligned',
            requestType: 'frontend',
            summary: 'The answer planned instead of changing the UI.',
            routeDecision: 'wrong_route',
            expectedRoute: 'Frontend implementation with browser verification.',
            failureCategories: ['answered_instead_of_acted'],
            repairPlan: ['Patch the UI and run a browser check.'],
            lesson: 'Frontend implementation asks should lead to UI edits and served verification.',
            toolUseDecision: 'tool_gap',
            missingTools: ['web-scrape'],
            toolLesson: 'Frontend requests need browser verification evidence.',
            promoteRegressionFixture: true,
        }));
    });

    test('summarizes actual route metadata for backtesting feedback', () => {
        const route = summarizeActualRoute({
            taskType: 'chat',
            clientSurface: 'web-chat',
            executionProfile: 'default',
            outputFormat: 'html',
            toolEvents: [{
                toolCall: { function: { name: 'document-workflow' } },
                result: { success: true },
            }],
            artifacts: [{ id: 'artifact-1' }],
        });

        expect(route).toContain('taskType=chat');
        expect(route).toContain('surface=web-chat');
        expect(route).toContain('tools=document-workflow');
        expect(route).toContain('artifacts=1');
    });

    test('summarizes tool use failures and repeats for reinforcement', () => {
        const toolUse = summarizeToolUse({
            toolEvents: [
                {
                    toolCall: { function: { name: 'web-search' } },
                    result: { success: false, toolId: 'web-search' },
                },
                {
                    toolCall: { function: { name: 'web-search' } },
                    result: { success: false, toolId: 'web-search' },
                },
                {
                    toolCall: { function: { name: 'web-fetch' } },
                    result: { success: true, toolId: 'web-fetch' },
                },
            ],
        });

        expect(toolUse.actualTools).toEqual(['web-search', 'web-fetch']);
        expect(toolUse.failedTools).toEqual(['web-search']);
        expect(toolUse.repeatedTools).toEqual(['web-search']);
        expect(toolUse.summary).toContain('repeated=web-search');
    });

    test('fallback feedback marks missing required tools', () => {
        const result = require('./evaluator-service').buildFallbackEvaluation({
            rating: 'down',
            userText: 'Research the latest pricing and cite sources.',
            assistantText: 'Here is what I remember.',
            assistantMetadata: { toolEvents: [] },
        });

        expect(result.toolUseDecision).toBe('tool_gap');
        expect(result.expectedTools).toEqual(['web-search', 'web-fetch']);
        expect(result.missingTools).toEqual(['web-search', 'web-fetch']);
        expect(result.toolMisuseCategories).toEqual(expect.arrayContaining([
            'missing_required_tool',
            'skipped_verification_tool',
        ]));
    });

    test('builds regression fixture candidates from negative route feedback', () => {
        const fixture = buildRegressionFixtureCandidate({
            feedbackId: 'align-123',
            sessionId: 'session-1',
            messageId: 'assistant-1',
            rating: 'down',
            reason: 'It only explained.',
            userText: 'Fix the web-chat button.',
            assistantText: 'You can update the button by editing CSS.',
            evaluation: {
                requestType: 'frontend',
                routeDecision: 'wrong_route',
                expectedRoute: 'Frontend implementation with browser verification.',
                actualRoute: 'taskType=chat; tools=none',
                failureCategories: ['answered_instead_of_acted', 'missing_visual_verification'],
                expectedTools: ['web-scrape'],
                missingTools: ['web-scrape'],
                misusedTools: ['document-workflow'],
                toolMisuseCategories: ['wrong_tool_for_task'],
                repairPlan: ['Edit frontend files.', 'Run served browser verification.'],
                toolFixes: ['Use web-scrape for browser verification.'],
                promoteRegressionFixture: true,
            },
        });

        expect(fixture).toEqual(expect.objectContaining({
            id: 'alignment-align-123',
            prompt: 'Fix the web-chat button.',
            expected: expect.objectContaining({
                requestType: 'frontend',
                forbiddenRoute: 'taskType=chat; tools=none',
                failureCategories: ['answered_instead_of_acted', 'missing_visual_verification'],
                expectedTools: ['web-scrape'],
                missingTools: ['web-scrape'],
                misusedTools: ['document-workflow'],
                toolMisuseCategories: ['wrong_tool_for_task'],
            }),
        }));
    });

    test('builds positive route guidance and regression reminders from session metadata', () => {
        const context = buildAlignmentGuidanceContext({
            metadata: {
                alignmentRoutePatterns: [{
                    requestType: 'frontend',
                    successPattern: 'UI change worked after editing files and running served QA.',
                    actualRoute: 'taskType=frontend; tools=ui-check',
                }],
                alignmentRegressionFixtures: [{
                    expected: {
                        requestType: 'research',
                        expectedRoute: 'Search then fetch selected sources.',
                        forbiddenRoute: 'tools=none',
                        expectedTools: ['web-search', 'web-fetch'],
                        missingTools: ['web-fetch'],
                        requiredEvidence: ['web-search', 'web-fetch'],
                    },
                }],
                alignmentToolReinforcement: [{
                    requestType: 'research',
                    toolUseDecision: 'tool_gap',
                    expectedTools: ['web-search', 'web-fetch'],
                    missingTools: ['web-fetch'],
                    toolLesson: 'Fetch selected pages after search before citing.',
                }],
            },
        });

        expect(context).toContain('Reinforce successful patterns');
        expect(context).toContain('successful frontend route pattern');
        expect(context).toContain('Avoid known regressions');
        expect(context).toContain('avoid prior research regression');
        expect(context).toContain('Tool-use reinforcement');
        expect(context).toContain('research tool reinforcement: tool_gap');
        expect(context).toContain('missing web-fetch');
    });

    test('builds compact session-local alignment guidance context', () => {
        const context = buildAlignmentGuidanceContext({
            metadata: {
                alignmentFeedbackHistory: [{
                    rating: 'down',
                    evaluation: {
                        requestType: 'frontend',
                        summary: 'The user expected a concrete UI change.',
                        routeDecision: 'wrong_route',
                        expectedRoute: 'Frontend edit plus browser verification.',
                        failureCategories: ['answered_instead_of_acted'],
                        toolUseDecision: 'tool_gap',
                        expectedTools: ['web-scrape'],
                        missingTools: ['web-scrape'],
                        toolMisuseCategories: ['skipped_verification_tool'],
                        decisionGuidance: ['Prefer implementation and browser verification.'],
                        lesson: 'UI implementation requests need the frontend route.',
                        toolLesson: 'Run browser verification for UI changes.',
                    },
                }],
            },
        });

        expect(context).toContain('[Alignment feedback context]');
        expect(context).toContain('negative frontend feedback');
        expect(context).toContain('Route: wrong_route');
        expect(context).toContain('Failure categories: answered_instead_of_acted.');
        expect(context).toContain('Tool feedback: tool_gap; missing web-scrape.');
        expect(context).toContain('Prefer implementation and browser verification.');
        expect(context).toContain('UI implementation requests need the frontend route.');
        expect(context).toContain('Tool lesson: Run browser verification for UI changes.');
    });
});

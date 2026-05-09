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
    evaluateAlignment,
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
        }));
    });

    test('builds compact session-local alignment guidance context', () => {
        const context = buildAlignmentGuidanceContext({
            metadata: {
                alignmentFeedbackHistory: [{
                    rating: 'down',
                    evaluation: {
                        requestType: 'frontend',
                        summary: 'The user expected a concrete UI change.',
                        decisionGuidance: ['Prefer implementation and browser verification.'],
                    },
                }],
            },
        });

        expect(context).toContain('[Alignment feedback context]');
        expect(context).toContain('negative frontend feedback');
        expect(context).toContain('Prefer implementation and browser verification.');
    });
});

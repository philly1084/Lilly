'use strict';

const { evaluateLongAgentStop } = require('./long-agent-mode');

function buildWorkload() {
    return {
        prompt: 'Improve the agent loop.',
        metadata: {
            longAgent: {
                enabled: true,
                goal: 'Improve the agent loop.',
                maxAutoSteps: 3,
            },
        },
    };
}

describe('long agent stop evaluation', () => {
    test('continues after successful verification reports with no problem signals', () => {
        const evaluation = evaluateLongAgentStop({
            workload: buildWorkload(),
            run: { metadata: { longAgentStep: 1 } },
            result: {
                outputText: [
                    'Implemented the next slice.',
                    'Verification: 42 tests passed and no error was reported.',
                    'No blocker remains and no regression was found.',
                    'Next obvious step: exercise the served route.',
                ].join('\n'),
            },
            succeeded: true,
        });

        expect(evaluation).toEqual(expect.objectContaining({
            blocked: false,
            needsReview: false,
            decision: 'next_step',
        }));
    });

    test('still sends unresolved failures to review', () => {
        const evaluation = evaluateLongAgentStop({
            workload: buildWorkload(),
            run: { metadata: { longAgentStep: 1 } },
            result: {
                outputText: 'Blocked: permission denied and tests are still failing.',
            },
            succeeded: true,
        });

        expect(evaluation).toEqual(expect.objectContaining({
            blocked: true,
            needsReview: true,
            decision: 'review',
        }));
    });
});

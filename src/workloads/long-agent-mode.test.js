'use strict';

const { evaluateLongAgentStop, getRemoteExecutionState, buildNextStepPrompt } = require('./long-agent-mode');

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
    test.each(['running', 'queued', 'starting', 'unknown'])('does not accept final prose while the remote tool reports %s', (completionStatus) => {
        const evaluation = evaluateLongAgentStop({
            workload: buildWorkload(),
            result: { outputText: 'Overall goal complete. All acceptance criteria passed.', toolEvents: [{
                toolId: 'remote-cli-agent', result: { success: true, data: { completionStatus, targetId: 'primary', remoteCodeJobId: 'job1' } },
            }] },
        });
        expect(evaluation).toMatchObject({ goalComplete: false, remoteExecutionPending: true, decision: 'next_step' });
        expect(buildNextStepPrompt({}, evaluation)).toContain('observe/resume that same job');
    });

    test('observation failure does not turn a previously completed-looking result into proof', () => {
        const evaluation = evaluateLongAgentStop({
            workload: buildWorkload(), result: { outputText: 'Overall goal complete.', toolEvents: [{
                toolId: 'remote-cli-agent', result: { success: true, data: { completionStatus: 'complete', observationStatus: 'unavailable' } },
            }] },
        });
        expect(evaluation).toMatchObject({ goalComplete: false, remoteExecutionPending: true });
    });

    test('a planner that skips observation cannot complete an owned pending job, but stale goal cursors are ignored', () => {
        const workload = buildWorkload();
        workload.id = 'w1';
        workload.metadata.agentCompany = { enabled: true, companyGoalHash: 'current-goal' };
        workload.metadata.companyRemoteExecution = { workloadId: 'w1', companyGoalHash: 'current-goal', state: {
            completionStatus: 'running', remoteCodeJobId: 'job1', targetId: 'primary',
        } };
        const result = { outputText: 'Overall goal complete.' };
        expect(evaluateLongAgentStop({ workload, result })).toMatchObject({ goalComplete: false, remoteExecutionPending: true });
        workload.metadata.companyRemoteExecution.companyGoalHash = 'old-goal';
        expect(evaluateLongAgentStop({ workload, result })).toMatchObject({ remoteExecution: null, goalComplete: true });
        workload.metadata.companyRemoteExecution.companyGoalHash = 'current-goal';
        workload.metadata.companyRemoteExecution.workloadId = 'another-workload';
        expect(evaluateLongAgentStop({ workload, result })).toMatchObject({ remoteExecution: null });
    });

    test('stage budget remains bounded while a remote job is running', () => {
        const evaluation = evaluateLongAgentStop({
            workload: buildWorkload(), run: { metadata: { longAgentStep: 3 } },
            result: { outputText: 'Overall goal complete.', toolEvents: [{
                toolId: 'remote-cli-agent', result: { success: true, data: { completionStatus: 'running' } },
            }] },
        });
        expect(evaluation).toMatchObject({ goalComplete: false, decision: 'stop_max_steps', maxStepsReached: true });
        expect(evaluation.reason).toContain('remote job remains unfinished');
    });

    test('review wording does not evade the automatic stage budget or hide its pause', () => {
        const evaluation = evaluateLongAgentStop({ workload: buildWorkload(), run: { metadata: { longAgentStep: 3 } },
            result: { outputText: 'Observation failed; job is still running.', toolEvents: [{
                toolId: 'remote-cli-agent', result: { data: { completionStatus: 'running', observationStatus: 'unavailable' } },
            }] } });
        expect(evaluation).toMatchObject({ goalComplete: false, decision: 'stop_max_steps', needsReview: true });
    });

    test.each(['failed', 'blocked', 'cancelled', 'waiting_for_input'])('tool-owned %s defeats completion prose', (completionStatus) => {
        const evaluation = evaluateLongAgentStop({
            workload: buildWorkload(), result: { outputText: 'Overall goal complete.', toolEvents: [{
                toolId: 'remote-cli-agent', result: { success: true, data: { completionStatus } },
            }] },
        });
        expect(evaluation).toMatchObject({ blocked: true, goalComplete: false, decision: 'review' });
    });

    test('uses latest tool observation and does not trust unrelated tool status', () => {
        const result = { outputText: 'Overall goal complete.', response: { metadata: { toolEvents: [
            { tool: 'remote-cli-agent', result: { success: true, data: { completionStatus: 'running', remoteCodeJobId: 'job1' } } },
            { toolCall: { function: { name: 'remote-cli-agent' } }, result: { success: true, data: { completionStatus: 'complete', remoteCodeJobId: 'job1', secret: 'never-copy' } } },
            { toolId: 'web-search', result: { success: true, data: { completionStatus: 'running' } } },
        ] } } };
        expect(getRemoteExecutionState(result)).toEqual({ completionStatus: 'complete', remoteCodeJobId: 'job1' });
        expect(evaluateLongAgentStop({ workload: buildWorkload(), result })).toMatchObject({ goalComplete: true, decision: 'complete' });
    });

    test.each([
        { requested: 'high', applied: 'high', status: 'applied', appliedTo: 'cli-invocation' },
        { requested: 'high', status: 'forwarded' },
    ])('snapshots only the validated runtime receipt fields', (reasoningEffortReceipt) => {
        const state = getRemoteExecutionState({ toolEvents: [{ toolId: 'remote-cli-agent', result: { data: {
            completionStatus: 'running', providerModel: 'gpt-5.6-luna', reasoningEffortReceipt: { ...reasoningEffortReceipt, secret: 'do-not-copy' },
        } } }] });
        expect(state).toMatchObject({ providerModel: 'gpt-5.6-luna', reasoningEffortReceipt });
        expect(state.reasoningEffortReceipt).not.toHaveProperty('secret');
    });

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

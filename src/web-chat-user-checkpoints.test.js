const {
    applyAnsweredUserCheckpointState,
    applyAskedUserCheckpointState,
    buildUserCheckpointPolicyMetadata,
    resolveAnsweredUserCheckpointInput,
} = require('./web-chat-user-checkpoints');

describe('web chat user checkpoint helpers', () => {
    test('builds a frontend-safe checkpoint policy summary', () => {
        expect(buildUserCheckpointPolicyMetadata({
            enabled: true,
            maxQuestions: 8,
            askedCount: 2,
            remaining: 6,
            pending: {
                id: 'checkpoint-1',
                title: 'Choose a direction',
                question: 'Which option should we take?',
                options: [{ id: 'a', label: 'A' }],
            },
        })).toEqual({
            enabled: true,
            maxQuestions: 8,
            askedCount: 2,
            remaining: 6,
            pending: {
                id: 'checkpoint-1',
                title: 'Choose a direction',
                question: 'Which option should we take?',
            },
            answeredThisTurn: false,
        });
    });

    test('marks a matching survey response as answered in session control state', async () => {
        const updateControlState = jest.fn().mockResolvedValue({
            userCheckpoint: {
                pending: null,
                lastResponse: {
                    checkpointId: 'checkpoint-1',
                    summary: 'chose "A" [a].',
                },
            },
        });
        const session = {
            metadata: {},
            controlState: {
                userCheckpoint: {
                    maxQuestions: 8,
                    askedCount: 1,
                    pending: {
                        id: 'checkpoint-1',
                        title: 'Choose a direction',
                        question: 'Which option should we take?',
                        options: [
                            { id: 'a', label: 'A' },
                            { id: 'b', label: 'B' },
                        ],
                    },
                },
            },
        };

        const result = await applyAnsweredUserCheckpointState(
            { updateControlState },
            'session-1',
            session,
            'Survey response (checkpoint-1): chose "A" [a].',
        );

        expect(updateControlState).toHaveBeenCalledWith('session-1', expect.objectContaining({
            userCheckpoint: expect.objectContaining({
                pending: null,
                lastResponse: expect.objectContaining({
                    checkpointId: 'checkpoint-1',
                    summary: 'chose "A" [a].',
                }),
            }),
        }));
        expect(result.session.controlState).toEqual(expect.objectContaining({
            userCheckpoint: expect.objectContaining({
                pending: null,
            }),
        }));
        expect(result.checkpoint).toEqual(expect.objectContaining({
            id: 'checkpoint-1',
        }));
    });

    test('hydrates a checkpoint answer with the prior build request and selected option context', () => {
        const userText = 'Survey response (dating-app-build-target): What should I make first?: Full-stack app';
        const input = resolveAnsweredUserCheckpointInput({
            userText,
            response: {
                checkpointId: 'dating-app-build-target',
                summary: 'What should I make first?: Full-stack app',
            },
            checkpoint: {
                id: 'dating-app-build-target',
                question: 'What should I make first?',
                options: [
                    {
                        id: 'prototype',
                        label: 'Runnable web MVP',
                        description: 'A polished mobile-first prototype.',
                    },
                    {
                        id: 'full-stack',
                        label: 'Full-stack app',
                        description: 'A production-oriented app with accounts, database, real-time chat, and deployment setup.',
                    },
                ],
            },
            recentMessages: [
                { role: 'user', content: 'can you make a dating app' },
                { role: 'assistant', content: 'Choose a direction.' },
                { role: 'user', content: 'then make it already' },
            ],
        });

        expect(input).toContain('Original request: can you make a dating app');
        expect(input).toContain('deployment setup');
        expect(input).toContain('Do not stop after acknowledging');
    });

    test('ignores mismatched survey responses when another checkpoint is pending', async () => {
        const updateControlState = jest.fn();
        const session = {
            metadata: {},
            controlState: {
                userCheckpoint: {
                    maxQuestions: 8,
                    askedCount: 1,
                    pending: {
                        id: 'checkpoint-1',
                        title: 'Choose a direction',
                        question: 'Which option should we take?',
                        options: [
                            { id: 'a', label: 'A' },
                            { id: 'b', label: 'B' },
                        ],
                    },
                },
            },
        };

        const result = await applyAnsweredUserCheckpointState(
            { updateControlState },
            'session-1',
            session,
            'Survey response (checkpoint-2): chose "A" [a].',
        );

        expect(updateControlState).not.toHaveBeenCalled();
        expect(result.response).toEqual({
            checkpointId: 'checkpoint-2',
            summary: 'chose "A" [a].',
        });
    });

    test('stores a new pending checkpoint from a user-checkpoint tool event', async () => {
        const updateControlState = jest.fn().mockResolvedValue({
            userCheckpoint: {
                askedCount: 1,
                pending: {
                    id: 'checkpoint-ask',
                    title: 'Quick choice',
                    question: 'Pick one',
                },
            },
        });
        const session = {
            metadata: {},
            controlState: {
                userCheckpoint: {
                    maxQuestions: 8,
                    askedCount: 0,
                },
            },
        };

        const toolEvents = [{
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
                        id: 'checkpoint-ask',
                        title: 'Quick choice',
                        question: 'Pick one',
                        options: [
                            { id: 'a', label: 'A' },
                            { id: 'b', label: 'B' },
                        ],
                    },
                },
            },
        }];

        const result = await applyAskedUserCheckpointState(
            { updateControlState },
            'session-1',
            session,
            toolEvents,
        );

        expect(updateControlState).toHaveBeenCalledWith('session-1', expect.objectContaining({
            userCheckpoint: expect.objectContaining({
                askedCount: 1,
                pending: expect.objectContaining({
                    id: 'checkpoint-ask',
                    title: 'Quick choice',
                    question: 'Pick one',
                }),
            }),
        }));
        expect(result.controlState).toEqual(expect.objectContaining({
            userCheckpoint: expect.objectContaining({
                pending: expect.objectContaining({
                    id: 'checkpoint-ask',
                }),
            }),
        }));
    });
});

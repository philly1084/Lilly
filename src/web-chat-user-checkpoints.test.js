const {
    applyAnsweredUserCheckpointState,
    applyAskedUserCheckpointState,
    buildUserCheckpointPolicyMetadata,
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

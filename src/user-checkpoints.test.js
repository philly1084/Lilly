const {
    buildUserCheckpointAskedPatch,
    buildUserCheckpointContinuationInput,
    buildUserCheckpointInstructions,
    buildUserCheckpointMessage,
    buildUserCheckpointPolicy,
    buildUserCheckpointResponseMessage,
    extractPendingUserCheckpoint,
    isUserCheckpointResponseText,
    normalizeCheckpointRequest,
    parseUserCheckpointResponseMessage,
} = require('./user-checkpoints');

describe('user checkpoint helpers', () => {
    test('turns a selected build target into an execution continuation prompt', () => {
        const input = buildUserCheckpointContinuationInput({
            userText: 'Survey response (dating-app-build-target): What should I make first?: Full-stack app',
            response: {
                checkpointId: 'dating-app-build-target',
                summary: 'What should I make first?: Full-stack app',
            },
            priorObjective: 'can you make a dating app',
            checkpoint: {
                id: 'dating-app-build-target',
                title: 'Build target',
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
                        description: 'A production-oriented app with accounts, database-backed matching, and deployment setup.',
                    },
                ],
            },
        });

        expect(input).toContain('Original request: can you make a dating app');
        expect(input).toContain('Full-stack app: A production-oriented app');
        expect(input).toContain('executing the selected work');
        expect(input).toContain('Do not stop after acknowledging');
    });

    test('builds a normalized web-chat checkpoint policy from session control state', () => {
        const policy = buildUserCheckpointPolicy({
            clientSurface: 'web-chat',
            session: {
                controlState: {
                    userCheckpoint: {
                        askedCount: 1,
                        maxQuestions: 2,
                        pending: {
                            id: 'checkpoint-1',
                            title: 'Choose a path',
                            question: 'Which path should I take?',
                            options: [
                                { id: 'fast', label: 'Fast patch' },
                                { id: 'deep', label: 'Deeper refactor' },
                            ],
                        },
                    },
                },
            },
        });

        expect(policy).toEqual(expect.objectContaining({
            enabled: true,
            askedCount: 1,
            maxQuestions: 8,
            remaining: 7,
            pending: expect.objectContaining({
                id: 'checkpoint-1',
                question: 'Which path should I take?',
            }),
        }));
    });

    test('formats a checkpoint message with an embedded survey fence', () => {
        const message = buildUserCheckpointMessage({
            id: 'checkpoint-1',
            title: 'Choose a path',
            question: 'Which path should I take?',
            options: [
                { id: 'fast', label: 'Fast patch' },
                { id: 'deep', label: 'Deeper refactor' },
            ],
        });

        expect(message).toContain('```survey');
        expect(message).toContain('"id": "checkpoint-1"');
        expect(message).toContain('Choose an option below');
        expect(message).toContain('"allowFreeText": true');
    });

    test('checkpoint instructions explicitly forbid plain-text multiple-choice questions in web-chat', () => {
        const instructions = buildUserCheckpointInstructions({
            enabled: true,
            maxQuestions: 8,
            remaining: 7,
            pending: null,
        });

        expect(instructions).toContain('do not ask a blocking multiple-choice question as plain assistant text');
        expect(instructions).toContain('use the tool so the UI can render inline options');
        expect(instructions).toContain('keep the optional free-text path available');
        expect(instructions).toContain('Do not call or mention `request_user_input`');
        expect(instructions).toContain('Do not claim that the questionnaire rendered');
        expect(instructions).toContain('Do not turn that into a multi-question quiz');
        expect(instructions).toContain('sample survey text, markdown checkboxes');
        expect(instructions).toContain('primary quick way to involve the user');
        expect(instructions).toContain('Prefer `user-checkpoint` over a prose "which option do you want?" message');
        expect(instructions).toContain('one card with one visible step at a time');
        expect(instructions).toContain('Supported step types are single-choice, multi-choice, text, date, time, and datetime');
        expect(instructions).toContain('Do not mention checkpoint quotas, budgets, remaining counts, or internal runtime policy to the user.');
        expect(instructions).toContain('do not output a prose questionnaire');
        expect(instructions).toContain('do not say the quota or budget is exhausted');
        expect(instructions).toContain('After a checkpoint answer, do not ask a fresh checkpoint');
        expect(instructions).toContain('For research, web-search, web-fetch, or web-scrape work');
        expect(instructions).toContain('Do not use a checkpoint just to ask which public websites to scrape');
        expect(instructions).toContain('use one short choice checkpoint with 2 to 4 concrete options');
    });

    test('extracts a pending checkpoint from tool events and increments asked count', () => {
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
                        id: 'checkpoint-2',
                        title: 'Choose a path',
                        question: 'Which path should I take?',
                        options: [
                            { id: 'fast', label: 'Fast patch' },
                            { id: 'deep', label: 'Deeper refactor' },
                        ],
                    },
                },
            },
        }];

        const checkpoint = extractPendingUserCheckpoint(toolEvents);
        const patch = buildUserCheckpointAskedPatch({
            controlState: {
                userCheckpoint: {
                    askedCount: 0,
                    maxQuestions: 2,
                },
            },
        }, checkpoint);

        expect(checkpoint).toEqual(expect.objectContaining({
            id: 'checkpoint-2',
        }));
        expect(patch).toEqual(expect.objectContaining({
            userCheckpoint: expect.objectContaining({
                maxQuestions: 8,
                askedCount: 1,
                pending: expect.objectContaining({
                    id: 'checkpoint-2',
                }),
            }),
        }));
    });

    test('serializes and parses a user checkpoint response message', () => {
        const message = buildUserCheckpointResponseMessage({
            checkpointId: 'checkpoint-3',
            selectedOptions: [
                { id: 'fast', label: 'Fast patch' },
            ],
            notes: 'Keep the backend changes narrow.',
        });

        const parsed = parseUserCheckpointResponseMessage(message);

        expect(parsed).toEqual({
            checkpointId: 'checkpoint-3',
            summary: 'chose "Fast patch" [fast]. Notes: Keep the backend changes narrow.',
        });
        expect(isUserCheckpointResponseText(message)).toBe(true);
    });

    test('normalizes short multi-step questionnaires with text and time inputs', () => {
        const checkpoint = normalizeCheckpointRequest({
            title: 'Quick intake',
            whyThisMatters: 'A few answers will shape the work.',
            steps: [
                {
                    title: 'Direction',
                    prompt: 'Which direction should I take first?',
                    options: [
                        'Refactor the backend',
                        'Polish the web chat',
                    ],
                },
                {
                    question: 'What should the page be called?',
                    inputType: 'text',
                    placeholder: 'Type a short title',
                },
                {
                    question: 'When should I schedule the follow-up?',
                    type: 'time',
                },
            ],
        });

        expect(checkpoint).toEqual(expect.objectContaining({
            title: 'Quick intake',
            steps: [
                expect.objectContaining({
                    question: 'Which direction should I take first?',
                    inputType: 'choice',
                    options: [
                        { id: 'refactor-the-backend', label: 'Refactor the backend' },
                        { id: 'polish-the-web-chat', label: 'Polish the web chat' },
                    ],
                }),
                expect.objectContaining({
                    question: 'What should the page be called?',
                    inputType: 'text',
                    placeholder: 'Type a short title',
                }),
                expect.objectContaining({
                    question: 'When should I schedule the follow-up?',
                    inputType: 'time',
                }),
            ],
        }));
    });

    test('falls back to top-level question and options when step payload is malformed', () => {
        const checkpoint = normalizeCheckpointRequest({
            id: 'checkpoint-fallback',
            title: 'Choose a direction',
            question: 'Which branch should we continue from?',
            options: [
                { id: 'dashboard-ui', label: 'Dashboard UI' },
                { id: 'cluster-deployment', label: 'Cluster deployment' },
                { id: 'end-to-end-launch-flow', label: 'End-to-end launch flow' },
            ],
            steps: [
                {
                    id: 'step-1',
                    question: 'Which branch should we continue from?',
                    inputType: 'choice',
                    options: '[truncated]',
                },
            ],
        });

        expect(checkpoint).toEqual(expect.objectContaining({
            id: 'checkpoint-fallback',
            question: 'Which branch should we continue from?',
            steps: [
                expect.objectContaining({
                    question: 'Which branch should we continue from?',
                    inputType: 'choice',
                    options: [
                        { id: 'dashboard-ui', label: 'Dashboard UI' },
                        { id: 'cluster-deployment', label: 'Cluster deployment' },
                        { id: 'end-to-end-launch-flow', label: 'End-to-end launch flow' },
                    ],
                }),
            ],
        }));
    });

    test('normalizes questionnaire aliases like questions, choices, and *_choice types', () => {
        const checkpoint = normalizeCheckpointRequest({
            type: 'survey',
            title: 'Quick Preferences',
            questions: [
                {
                    id: 'focus',
                    type: 'single_choice',
                    prompt: 'What should we focus on right now?',
                    choices: [
                        { value: 'plan', label: 'Planning a new project' },
                        { value: 'build', label: 'Building something concrete' },
                    ],
                },
                {
                    id: 'output',
                    type: 'multiple_choice',
                    prompt: 'What outputs would be useful?',
                    choices: [
                        { value: 'code', label: 'Code snippet or script' },
                        { value: 'doc', label: 'Documentation or notes' },
                        { value: 'design', label: 'Wireframe or diagram' },
                    ],
                },
            ],
        });

        expect(checkpoint).toEqual(expect.objectContaining({
            title: 'Quick Preferences',
            steps: [
                expect.objectContaining({
                    id: 'focus',
                    question: 'What should we focus on right now?',
                    inputType: 'choice',
                    options: [
                        { id: 'plan', label: 'Planning a new project' },
                        { id: 'build', label: 'Building something concrete' },
                    ],
                }),
                expect.objectContaining({
                    id: 'output',
                    question: 'What outputs would be useful?',
                    inputType: 'multi-choice',
                    options: [
                        { id: 'code', label: 'Code snippet or script' },
                        { id: 'doc', label: 'Documentation or notes' },
                        { id: 'design', label: 'Wireframe or diagram' },
                    ],
                }),
            ],
        }));
    });

    test('normalizes multi-select checkpoint fields', () => {
        const checkpoint = normalizeCheckpointRequest({
            title: 'Pick useful outputs',
            fields: [
                {
                    id: 'deliverables',
                    label: 'Which outputs should the agent produce?',
                    fieldType: 'multi-select',
                    maxSelections: 3,
                    options: [
                        { value: 'summary', label: 'Short summary' },
                        { value: 'patch', label: 'Code patch' },
                        { value: 'tests', label: 'Regression tests' },
                        { value: 'screenshots', label: 'Screenshots' },
                    ],
                },
            ],
        });

        expect(checkpoint.steps[0]).toEqual(expect.objectContaining({
            id: 'deliverables',
            question: 'Which outputs should the agent produce?',
            inputType: 'multi-choice',
            allowMultiple: true,
            maxSelections: 3,
            options: [
                { id: 'summary', label: 'Short summary' },
                { id: 'patch', label: 'Code patch' },
                { id: 'tests', label: 'Regression tests' },
                { id: 'screenshots', label: 'Screenshots' },
            ],
        }));
    });

    test('rejects remote status summaries masquerading as checkpoint choices', () => {
        expect(() => normalizeCheckpointRequest({
            title: 'Choose a direction',
            question: 'What should I do next?',
            options: [
                {
                    id: 'deployment',
                    label: 'Deployment',
                    description: 'web/tetris-site is present and currently 1/1',
                },
                {
                    id: 'ingress',
                    label: 'Ingress',
                    description: 'awesome.demoserver2.buzz points to tetris-site on ports 80, 443',
                },
                {
                    id: 'source-file',
                    label: 'Source file',
                    description: '/opt/agent-apps/tetris-game/site/index.html',
                },
                {
                    id: 'git-status',
                    label: 'Git status already has site/index.html modified from earlier work',
                    description: 'patch site/index.html, refresh the ConfigMap, restart deployment/tetris-site, and verify the public page visually.',
                },
            ],
        })).toThrow(/answerable decisions/);
    });
});

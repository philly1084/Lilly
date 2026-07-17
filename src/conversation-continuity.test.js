const {
    buildContextContinuityFrame,
    buildRecentTranscriptAnchor,
    isLikelyTranscriptDependentTurn,
    resolveTranscriptObjectiveFromSession,
} = require('./conversation-continuity');

describe('conversation continuity', () => {
    test('does not blend an old task into a retry-prefixed new explicit request', () => {
        const input = 'try again. Can we make a video podcast on dating in Halifax this weekend?';
        const recentMessages = [
            { role: 'user', content: 'can you fix the calander app with the remote cli agent' },
            { role: 'assistant', content: 'The remote build is blocked by git authentication.' },
        ];

        expect(isLikelyTranscriptDependentTurn(input)).toBe(false);
        expect(resolveTranscriptObjectiveFromSession(input, recentMessages)).toEqual({
            objective: input,
            usedTranscriptContext: false,
        });
    });

    test('still treats bare retry requests as transcript-dependent', () => {
        expect(isLikelyTranscriptDependentTurn('try again')).toBe(true);
        expect(resolveTranscriptObjectiveFromSession('try again', [
            { role: 'user', content: 'Make a video podcast about battery storage.' },
        ])).toEqual({
            objective: 'Make a video podcast about battery storage. try again',
            usedTranscriptContext: true,
            priorUserObjective: 'Make a video podcast about battery storage.',
        });
    });

    test('resolves a polite repeat request back to the last explicit user request', () => {
        const recentMessages = [
            { role: 'user', content: 'What are cool tools people are making for Fable and Sol?' },
            { role: 'assistant', content: '{" output _text ":""," tool _calls ":[{" name ":" user-checkpoint "}]}' },
        ];

        expect(isLikelyTranscriptDependentTurn('Sorry repeat')).toBe(true);
        expect(resolveTranscriptObjectiveFromSession('Sorry repeat', recentMessages)).toEqual({
            objective: 'What are cool tools people are making for Fable and Sol? Sorry repeat',
            usedTranscriptContext: true,
            priorUserObjective: 'What are cool tools people are making for Fable and Sol?',
        });
    });

    test('does not blend prior transcript into a self-contained uploaded image turn', () => {
        const input = 'I just uploaded an image. did you see it?';
        const recentMessages = [
            { role: 'user', content: 'can you give me todays news in a video podcast' },
            { role: 'assistant', content: 'I generated a video podcast.' },
        ];

        expect(isLikelyTranscriptDependentTurn(input)).toBe(false);
        expect(resolveTranscriptObjectiveFromSession(input, recentMessages)).toEqual({
            objective: input,
            usedTranscriptContext: false,
        });
    });

    test('does not treat local pronouns inside explicit new work as transcript references', () => {
        const input = 'Write a poem about AI and make it funny.';
        const recentMessages = [
            { role: 'user', content: 'Deploy the calendar app to the cluster.' },
        ];

        expect(isLikelyTranscriptDependentTurn(input)).toBe(false);
        expect(resolveTranscriptObjectiveFromSession(input, recentMessages)).toEqual({
            objective: input,
            usedTranscriptContext: false,
        });
    });

    test('still blends genuinely abbreviated image follow-ups with recent transcript', () => {
        expect(isLikelyTranscriptDependentTurn('did you see it?')).toBe(true);
        expect(resolveTranscriptObjectiveFromSession('did you see it?', [
            { role: 'user', content: 'I uploaded a screenshot of the dashboard.' },
        ])).toEqual({
            objective: 'I uploaded a screenshot of the dashboard. did you see it?',
            usedTranscriptContext: true,
            priorUserObjective: 'I uploaded a screenshot of the dashboard.',
        });
    });

    test('treats next-step commands as transcript-dependent continuations', () => {
        const recentMessages = [
            { role: 'user', content: 'Inspect the managed app build status and fix the next deployment blocker.' },
            { role: 'assistant', content: 'I found the build is missing a repo clone URL.' },
        ];

        expect(isLikelyTranscriptDependentTurn('next')).toBe(true);
        expect(isLikelyTranscriptDependentTurn('go ahead')).toBe(true);
        expect(isLikelyTranscriptDependentTurn('do the next step')).toBe(true);
        expect(resolveTranscriptObjectiveFromSession('do the next step', recentMessages)).toEqual({
            objective: 'Inspect the managed app build status and fix the next deployment blocker. do the next step',
            usedTranscriptContext: true,
            priorUserObjective: 'Inspect the managed app build status and fix the next deployment blocker.',
        });
    });

    test('resolves a survey answer back to the original executable request', () => {
        const input = 'Survey response (dating-app-build-target): What should I make first?: Full-stack app';
        const recentMessages = [
            { role: 'user', content: 'can you make a dating app' },
            { role: 'assistant', content: 'I need one decision before I continue.' },
            { role: 'user', content: 'then make it already' },
            { role: 'assistant', content: 'Choose the first deliverable.' },
        ];

        expect(isLikelyTranscriptDependentTurn(input)).toBe(true);
        expect(resolveTranscriptObjectiveFromSession(input, recentMessages)).toEqual({
            objective: `can you make a dating app. ${input}`,
            usedTranscriptContext: true,
            priorUserObjective: 'can you make a dating app',
        });
    });

    test('recent transcript anchor requires a continuity review before proceeding', () => {
        const anchor = buildRecentTranscriptAnchor({
            currentInput: 'continue',
            recentMessages: [
                { role: 'user', content: 'Build the product dashboard and verify it in the browser.' },
                { role: 'assistant', content: 'The first sandbox render failed due to a missing import.' },
            ],
        });

        expect(anchor).toContain('Before continuing, review the recent user/assistant turns');
        expect(anchor).toContain('last completed action, unresolved blocker, and next incomplete step');
        expect(anchor).toContain('user: Build the product dashboard and verify it in the browser.');
        expect(anchor).toContain('assistant: The first sandbox render failed due to a missing import.');
    });

    test('context continuity frame prioritizes current turn and active task state over older memory', () => {
        const frame = buildContextContinuityFrame({
            currentInput: 'continue',
            recentMessages: [
                { role: 'user', content: 'Build the managed-app dashboard and verify it in web chat.' },
                { role: 'assistant', content: 'I fixed the first render issue and still need to run mobile QA.' },
            ],
            session: {
                metadata: {
                    projectMemory: {
                        tasks: [
                            {
                                summary: 'Generated an unrelated podcast script last week.',
                                status: 'completed',
                            },
                        ],
                    },
                },
            },
            controlState: {
                workflow: {
                    status: 'active',
                    lane: 'frontend',
                    stage: 'verify',
                    taskList: [
                        { title: 'Patch the dashboard render issue', status: 'completed' },
                        { title: 'Run mobile and desktop QA', status: 'pending' },
                    ],
                },
            },
            requestFrame: {
                intent: 'frontend_design_build',
                preferredTool: 'document-workflow',
            },
            clientSurface: 'web-chat',
            taskType: 'chat',
        });

        expect(frame).toContain('[Context continuity frame]');
        expect(frame).toContain('Trust order: latest user turn first');
        expect(frame).toContain('Current turn is referential or abbreviated');
        expect(frame).toContain('Latest explicit user request in recent transcript: Build the managed-app dashboard and verify it in web chat.');
        expect(frame).toContain('Workflow state: frontend is active at verify; next: Run mobile and desktop QA');
        expect(frame).toContain('This-turn routing intent: frontend_design_build via document-workflow.');
        expect(frame).toContain('prefer this frame and the current user turn');
    });

    test('context continuity frame includes lead agent baton state', () => {
        const frame = buildContextContinuityFrame({
            currentInput: 'continue',
            recentMessages: [
                { role: 'user', content: 'Deploy the document site to prod and verify HTTPS.' },
                { role: 'assistant', content: 'I fixed the manifest and still need to rerun rollout status.' },
            ],
            session: {
                metadata: {
                    leadAgentState: {
                        objective: 'Deploy the document site to prod and verify HTTPS.',
                        status: 'blocked',
                        lastVerifiedAction: 'k3s-deploy: applied updated ingress manifest',
                        nextSensibleStep: 'rerun rollout status and public HTTPS check',
                        blockers: ['image pull failed on previous rollout'],
                    },
                },
            },
        });

        expect(frame).toContain('Lead agent baton: Deploy the document site to prod and verify HTTPS.');
        expect(frame).toContain('status: blocked');
        expect(frame).toContain('last: k3s-deploy: applied updated ingress manifest');
        expect(frame).toContain('next: rerun rollout status and public HTTPS check');
        expect(frame).toContain('blockers: image pull failed on previous rollout');
    });
});

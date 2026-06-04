const {
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
});

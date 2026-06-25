const {
    buildNaturalContext,
    buildNaturalContextInstructions,
    buildRegisteredSkillsContext,
    buildSkillsTreeInstructions,
    buildNaturalContextUpdate,
    _private,
} = require('./natural-context');

describe('natural-context', () => {
    test('merges client canvas context with stored referents', () => {
        const context = buildNaturalContext({
            session: {
                metadata: {
                    naturalContext: {
                        activeSurface: 'web-chat',
                        recentTargets: ['hero copy'],
                    },
                },
            },
            metadata: {
                naturalContext: {
                    activeCanvas: {
                        type: 'document',
                        selectedText: 'Old intro paragraph',
                        contentExcerpt: '# Intro\nOld intro paragraph',
                    },
                    recentTargets: ['current selection'],
                },
            },
            clientSurface: 'canvas',
            taskType: 'canvas',
            userText: 'Make that tighter.',
        });

        expect(context.activeSurface).toBe('canvas');
        expect(context.activeMode).toBe('canvas');
        expect(context.activeCanvas.selectedText).toBe('Old intro paragraph');
        expect(context.recentTargets).toEqual(expect.arrayContaining(['current selection', 'hero copy']));
    });

    test('builds guidance for natural references and the skills tree', () => {
        const contextInstructions = buildNaturalContextInstructions({
            activeSurface: 'canvas',
            activeMode: 'canvas',
            activeCanvas: { type: 'code', selectedText: 'function oldName() {}' },
            recentTargets: ['current selection'],
        });
        const skillsTree = buildSkillsTreeInstructions({ clientSurface: 'web-cli', taskType: 'chat' });

        expect(contextInstructions).toContain('Resolve those references');
        expect(contextInstructions).toContain('current selection');
        expect(skillsTree).toContain('Use this compact state machine');
        expect(skillsTree).toContain('route_skill_tool');
        expect(skillsTree).toContain('Skills progression is not replaced by the state machine');
        expect(skillsTree).toContain('materialize required assets first');
        expect(skillsTree).toContain('context_by_interaction');
        expect(skillsTree).toContain('Ask at most one or two concise follow-up questions');
        expect(skillsTree).toContain('canvas_exact_edit');
        expect(skillsTree).toContain('web_cli_command');
    });

    test('updates recent targets from user and assistant text', () => {
        const update = buildNaturalContextUpdate({
            previous: { recentTargets: ['pricing table'] },
            clientSurface: 'web-chat',
            taskType: 'chat',
            userText: 'Change the second section and keep "Launch Plan".',
            assistantText: 'Updated ## Launch Plan with a shorter intro.',
            artifacts: [{ id: 'artifact-1', filename: 'launch-plan.md' }],
        });

        expect(update.activeArtifactId).toBe('artifact-1');
        expect(update.activeArtifactTitle).toBe('launch-plan.md');
        expect(update.recentTargets).toEqual(expect.arrayContaining(['Launch Plan', 'pricing table']));
    });

    test('extracts named targets from conversational references', () => {
        expect(_private.extractTargetsFromText('Fix the current hero section and the "CTA button".')).toEqual(
            expect.arrayContaining(['the current hero section', 'CTA button']),
        );
    });

    test('extracts common edit referents without quoted labels', () => {
        expect(_private.extractTargetsFromText('Tighten selected text, then rewrite second section and that paragraph.')).toEqual(
            expect.arrayContaining(['selected text', 'second section', 'that paragraph']),
        );
    });

    test('selects the remote operations system skill for remote lane planning', () => {
        const context = buildRegisteredSkillsContext({
            userText: 'Unify remote-cli-agent, k3s-deploy, managed-app, remote-workbench, and remote-command as one remote tool system.',
            toolIds: ['managed-app', 'remote-cli-agent', 'remote-command', 'remote-workbench', 'k3s-deploy'],
        });

        expect(context.block).toContain('remote-operations-system');
        expect(context.block).toContain('Treat `managed-app`, `remote-cli-agent`, `remote-command`, `remote-workbench`, and `k3s-deploy` as one remote operations system');
        expect(context.selectedSkills.map((skill) => skill.id)).toContain('remote-operations-system');
    });
});

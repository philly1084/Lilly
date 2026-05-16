const {
    buildRequestDecisionFrame,
    buildRequestDecisionMetadata,
    formatRequestDecisionFrameForPrompt,
} = require('./request-decision-frame');

describe('request-decision-frame', () => {
    test('builds output-aware hints for deploying an existing PDF artifact remotely', () => {
        const frame = buildRequestDecisionFrame({
            text: 'halifax-weekend-dinner-guide-curated-menu-ijh00u.pdf is the file I want you to put that as html page for the menu site. use remote cli agent to do it',
            candidateOutputFormat: 'pdf',
            outputFormat: null,
            session: {
                metadata: {
                    lastGeneratedArtifactId: 'artifact-pdf-1',
                    lastOutputFormat: 'pdf',
                },
            },
            effectiveArtifactIds: ['artifact-pdf-1'],
            executionProfile: 'remote-build',
            route: '/api/chat',
        });

        expect(frame.intent).toBe('remote_deploy_existing_artifact');
        expect(frame.preferredTool).toBe('remote-cli-agent');
        expect(frame.sourceArtifacts.ids).toEqual(['artifact-pdf-1']);
        expect(frame.sourceArtifacts.filenames).toContain('halifax-weekend-dinner-guide-curated-menu-ijh00u.pdf');
        expect(frame.blockedActions).toContain('generate_new_pdf');
        expect(frame.orchestrationHints.mustNotDo).toContain('answer_without_remote_verification');
        expect(frame.orchestrationHints.sourceMaterial).toEqual(expect.arrayContaining([
            'artifact:artifact-pdf-1',
            'halifax-weekend-dinner-guide-curated-menu-ijh00u.pdf',
        ]));
    });

    test('formats concise cheat-code instructions for the next orchestrator', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Put the PDF artifact on menu.demoserver2.buzz using remote cli agent.',
            candidateOutputFormat: 'pdf',
            effectiveArtifactIds: ['artifact-pdf-1'],
            executionProfile: 'remote-build',
        });
        const prompt = formatRequestDecisionFrameForPrompt(frame);

        expect(prompt).toContain('Intent: remote_deploy_existing_artifact');
        expect(prompt).toContain('Preferred tool lane: remote-cli-agent');
        expect(prompt).toContain('Source material: artifact:artifact-pdf-1');
        expect(prompt).toContain('Do not: generate_new_pdf');
        expect(prompt).toContain('Proof expected:');
    });

    test('metadata preserves cards and routing decision for the frontend', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Create a PDF document for the Halifax dinner guide.',
            outputFormat: 'pdf',
        });
        const metadata = buildRequestDecisionMetadata(frame);

        expect(metadata.requestFrame.intent).toBe('generate_artifact');
        expect(metadata.decisionTrace[0].title).toBe('Understanding');
        expect(metadata.routingDecision.preferredTool).toBe('artifact-service');
        expect(metadata.reasoningSummary).toContain('Routing Decision');
    });

    test('routes researched document requests to research before artifact generation', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Do deep research on Genetec, look into their tech support pages and latest version, then build a training class design maybe in a PDF document to start.',
            candidateOutputFormat: 'pdf',
            clientSurface: 'web-chat',
            route: '/v1/chat/completions',
        });

        expect(frame.intent).toBe('research_deliverable');
        expect(frame.preferredTool).toBe('web-search');
        expect(frame.candidateOutputFormat).toBe('pdf');
        expect(frame.proofExpectations).toEqual(expect.arrayContaining([
            'current source search completed',
            'document artifact generated only after grounded evidence exists',
        ]));
    });

    test('routes online resource gathering for HTML flyers to research before artifact generation', () => {
        const frame = buildRequestDecisionFrame({
            text: 'I live in Kingston Nova Scotia Canada, I want to make a weekly flyer for myself based on online Canadian resources including the companies websites. Id like agents to gather from key home use, electronic and general public shopping sites in the 100km area and make me that html based flyer.',
            candidateOutputFormat: 'html',
            clientSurface: 'web-chat',
            route: '/v1/chat/completions',
        });

        expect(frame.intent).toBe('research_deliverable');
        expect(frame.preferredTool).toBe('web-search');
    });
});

const {
    buildRequestDecisionFrame,
    buildRequestDecisionMetadata,
    buildRequestFrameProgress,
    executeWithAdaptiveReasoningFallback,
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

    test('routes hyphenated remote-cli-agent requests to the remote lane', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Deploy the selected HTML artifact to menu.demoserver2.buzz using remote-cli-agent.',
            candidateOutputFormat: 'html',
            effectiveArtifactIds: ['artifact-html-1'],
            executionProfile: 'remote-build',
        });

        expect(frame.intent).toBe('remote_deploy_existing_artifact');
        expect(frame.preferredTool).toBe('remote-cli-agent');
        expect(frame.orchestrationHints.mustNotDo).toContain('answer_without_remote_verification');
    });

    test('routes Codex help document requests to the main assisted CLI lane', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Ask Codex for help creating a deeper PDF document and synthesis package.',
            candidateOutputFormat: 'pdf',
            executionProfile: 'remote-build',
        });

        expect(frame.preferredTool).toBe('remote-cli-agent');
        expect(frame.intent).toBe('remote_inspect_or_operate');
    });

    test('routes managed-app artifact deployments away from preview regeneration', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Update this document (light-it-up-event-holiday-architectural-405gr2.html): lets deploy this to the web, lightitup.demoserver2.buzz on our remote server using the managed app',
            candidateOutputFormat: 'html',
            outputFormat: null,
            effectiveArtifactIds: ['artifact-html-light-it-up'],
            executionProfile: 'remote-build',
            clientSurface: 'web-chat',
            route: '/v1/chat/completions',
        });
        const prompt = formatRequestDecisionFrameForPrompt(frame);

        expect(frame.intent).toBe('remote_deploy_existing_artifact');
        expect(frame.preferredTool).toBe('managed-app');
        expect(frame.sourceArtifacts.ids).toEqual(['artifact-html-light-it-up']);
        expect(frame.sourceArtifacts.filenames).toContain('light-it-up-event-holiday-architectural-405gr2.html');
        expect(frame.blockedActions).toEqual(expect.arrayContaining([
            'generate_new_html',
            'generate_new_artifact',
            'create_replacement_preview',
        ]));
        expect(frame.proofExpectations).toContain('managed-app/GitLab source and build evidence captured when requested');
        expect(prompt).toContain('Preferred tool lane: managed-app');
        expect(prompt).toContain('remote-cli-agent as a worker inside that workflow');
    });

    test('keeps terse deploy follow-ups in the sticky managed-app lane', () => {
        const frame = buildRequestDecisionFrame({
            text: 'the preview html is missing to push',
            candidateOutputFormat: 'html',
            outputFormatProvided: true,
            session: {
                metadata: {
                    controlState: {
                        lastToolIntent: 'managed-app',
                        lastRemoteObjective: 'Deploy Light It Up to lightitup.demoserver2.buzz through managed-app.',
                    },
                },
            },
            executionProfile: 'remote-build',
            clientSurface: 'web-chat',
        });

        expect(frame.intent).toBe('remote_deploy_or_update');
        expect(frame.preferredTool).toBe('managed-app');
        expect(frame.blockedActions).toEqual(expect.arrayContaining([
            'generate_standalone_artifact_only',
            'create_replacement_preview',
        ]));
        expect(frame.previousWork.lastToolIntent).toBe('managed-app');
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

    test('routes complex frontend game design to a gated sandbox workflow with placeholder allowance', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Build a complex polished browser game. If we do not have real object files, make varied placeholder game objects in place and iterate with repair or redesign fallbacks.',
            candidateOutputFormat: 'html',
            clientSurface: 'web-chat',
        });

        expect(frame.intent).toBe('complex_frontend_design_build');
        expect(frame.preferredTool).toBe('document-workflow');
        expect(frame.blockedActions).toEqual(expect.arrayContaining([
            'finalize_without_preview_or_qa',
            'claim_ready_without_repair_redesign_decision',
        ]));
        expect(frame.proofExpectations).toEqual(expect.arrayContaining([
            'sandbox bundle generated with source files',
            'fallback path classified as repair, redesign, ask, or ready',
            'desktop and mobile browser QA completed after preview exists',
        ]));
        expect(frame.missingContext).toContain('real_game_object_files_optional_varied_placeholders_allowed');
        expect(frame.orchestrationHints.objective).toContain('varied in-place placeholders');
    });

    test('selects low reasoning for an instant Web Chat question in Auto mode', () => {
        const frame = buildRequestDecisionFrame({
            text: 'What is the capital of Nova Scotia?',
            clientSurface: 'web-chat',
            model: 'gpt-5.4-mini',
            metadata: { reasoningPolicy: { mode: 'auto' } },
            payload: { metadata: { reasoningPolicy: { mode: 'auto' } } },
        });

        expect(frame.complexity).toEqual(expect.objectContaining({
            band: 'instant',
            reasonCodes: expect.arrayContaining(['short_direct']),
        }));
        expect(frame.reasoningPolicy).toEqual(expect.objectContaining({
            mode: 'auto',
            effectiveEffort: 'low',
            fallback: false,
        }));
    });

    test('selects high reasoning and a research goal for complex Web Chat work', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Research the current options, verify the sources, and give me a cited comparison.',
            clientSurface: 'web-chat',
            model: 'gpt-5.4-mini',
            metadata: { reasoningPolicy: { mode: 'auto' } },
            payload: { metadata: { reasoningPolicy: { mode: 'auto' } } },
        });
        const progress = buildRequestFrameProgress(frame);

        expect(frame.complexity.band).toBe('complex');
        expect(frame.complexity.reasonCodes).toEqual(expect.arrayContaining(['research', 'verification']));
        expect(frame.reasoningPolicy.effectiveEffort).toBe('high');
        expect(frame.goal.steps.map((step) => step.title)).toEqual(['Understand', 'Gather', 'Synthesize', 'Deliver']);
        expect(progress).toEqual(expect.objectContaining({
            contractVersion: 1,
            source: 'goal-contract',
            showSteps: true,
            reasoningPolicy: expect.objectContaining({ effectiveEffort: 'high' }),
            goal: expect.objectContaining({ scope: 'turn' }),
        }));
    });

    test('caps extended Auto reasoning when the model does not declare XHigh support', () => {
        const frame = buildRequestDecisionFrame({
            text: 'Build and deploy this complex multi-step application, then verify the public endpoint.',
            clientSurface: 'web-chat',
            model: 'custom-reasoning-model',
            metadata: { reasoningPolicy: { mode: 'auto' } },
            payload: { metadata: { reasoningPolicy: { mode: 'auto' } } },
        });

        expect(frame.complexity.band).toBe('extended');
        expect(frame.reasoningPolicy).toEqual(expect.objectContaining({
            effectiveEffort: 'high',
            capabilityLimited: true,
        }));
    });

    test('lets a fixed effort override Auto and leaves non-Web-Chat defaults unchanged', () => {
        const manualFrame = buildRequestDecisionFrame({
            text: 'Research and verify this thoroughly.',
            clientSurface: 'web-chat',
            model: 'gpt-5.6-sol',
            metadata: { reasoningPolicy: { mode: 'auto' } },
            payload: {
                reasoning_effort: 'medium',
                metadata: { reasoningPolicy: { mode: 'auto' } },
            },
        });
        const apiFrame = buildRequestDecisionFrame({
            text: 'Research and verify this thoroughly.',
            clientSurface: 'api',
            model: 'gpt-5.6-sol',
            payload: {},
        });

        expect(manualFrame.reasoningPolicy).toEqual(expect.objectContaining({
            mode: 'manual',
            requestedEffort: 'medium',
            effectiveEffort: 'medium',
        }));
        expect(apiFrame.reasoningPolicy).toBeNull();
    });

    test('retries Auto once with model-default reasoning when the provider rejects the effort', async () => {
        const policy = {
            mode: 'auto',
            effectiveEffort: 'xhigh',
            complexityBand: 'extended',
            fallback: false,
        };
        const executor = jest.fn()
            .mockRejectedValueOnce(Object.assign(new Error('reasoning_effort xhigh is not supported'), { status: 400 }))
            .mockResolvedValueOnce({ response: 'ok' });
        const onFallback = jest.fn();

        const result = await executeWithAdaptiveReasoningFallback(executor, policy, onFallback);

        expect(result).toEqual({ response: 'ok' });
        expect(executor).toHaveBeenNthCalledWith(1, undefined, policy);
        expect(executor).toHaveBeenNthCalledWith(2, null, expect.objectContaining({
            fallback: true,
            fallbackEffort: 'model-default',
        }));
        expect(policy).toEqual(expect.objectContaining({
            effectiveEffort: null,
            fallback: true,
        }));
        expect(onFallback).toHaveBeenCalledTimes(1);
    });
});

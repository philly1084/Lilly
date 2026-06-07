jest.mock('./routes/admin/settings.controller', () => ({
    getEffectiveSshConfig: jest.fn(),
    getEffectiveOpencodeConfig: jest.fn(),
    getEffectiveDeployConfig: jest.fn(),
    getEffectiveOrchestrationConfig: jest.fn(() => ({ enabled: true, neuralWaveResearchMode: false })),
}));

const settingsController = require('./routes/admin/settings.controller');
const config = require('./config');
const { remoteRunnerService } = require('./remote-runner/service');
const {
    ConversationOrchestrator,
    HarnessRunState,
    buildDeterministicRecoveryPlanFromFailure,
    classifyToolExecutionResult,
    filterRepeatedPlanStepsWithReport,
    inferAgencyProfile,
    inferCompletionEvidenceFromToolEvent,
} = require('./conversation-orchestrator');

function buildResponse(text, id = 'resp_test') {
    return {
        id,
        model: 'gpt-test',
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text,
                    },
                ],
            },
        ],
        metadata: {},
    };
}

function buildResponseWithPromptState(text, id = 'resp_test_prompt_state', promptState = { stage: 'test' }) {
    return {
        ...buildResponse(text, id),
        metadata: {
            promptState,
        },
    };
}

describe('HarnessRunState', () => {
    test('records canonical metadata and review transitions', () => {
        const harness = new HarnessRunState({
            objective: 'Deploy the app',
            executionProfile: 'remote-build',
            autonomyApproved: true,
            maxRounds: 5,
            maxToolCalls: 10,
            maxReplans: 1,
            completionCriteria: ['app deployed'],
        });

        harness.recordPlan({
            round: 1,
            source: 'planned',
            steps: [{ tool: 'remote-command', reason: 'inspect', params: { command: 'kubectl get pods -A' } }],
        });
        const review = harness.reviewRound({
            round: 1,
            roundToolEvents: [{
                toolCall: { function: { name: 'remote-command' } },
                result: { success: true },
                reason: 'inspect',
            }],
            roundFailureSummary: { recoverableFailures: [], blockingFailures: [] },
            suggestedDecision: 'continue',
            productive: true,
        });
        const metadata = harness.toJSON();

        expect(review.decision).toBe('continue');
        expect(metadata.version).toBe('planner-recovery-v2');
        expect(metadata.runId).toMatch(/^harness_/);
        expect(metadata.executionProfile).toBe('remote-build');
        expect(metadata.autonomyLevel).toBe('guarded-remote');
        expect(metadata.currentObjective).toBe('Deploy the app');
        expect(metadata.completionCriteria).toEqual(['app deployed']);
        expect(metadata.rounds[0].decision).toBe('continue');
        expect(metadata.decision).toBe('continue');
    });

    test('chooses replan once for recoverable failures, then blocks when replan budget is exhausted', () => {
        const harness = new HarnessRunState({ maxReplans: 1 });
        const failureSummary = {
            recoverableFailures: [{ toolId: 'remote-command', error: 'temporary timeout', blocking: false }],
            blockingFailures: [],
        };

        expect(harness.reviewRound({
            round: 1,
            roundToolEvents: [{ result: { success: false } }],
            roundFailureSummary: failureSummary,
        }).decision).toBe('replan');
        expect(harness.reviewRound({
            round: 2,
            roundToolEvents: [{ result: { success: false } }],
            roundFailureSummary: failureSummary,
        }).decision).toBe('blocked');
        expect(harness.toJSON().blockers).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'replan_budget_exhausted' }),
        ]));
    });

    test('classifies tool execution results and blocks repeated signatures', () => {
        const successEvent = {
            toolCall: { function: { name: 'remote-command', arguments: '{"command":"hostname"}' } },
            result: { success: true },
        };
        const retryEvent = {
            toolCall: { function: { name: 'remote-command', arguments: '{"command":"hostname"}' } },
            result: { success: false, error: 'operation timed out' },
        };
        const blockingEvent = {
            toolCall: { function: { name: 'managed-app', arguments: '{"action":"inspect"}' } },
            result: { success: false, error: 'bad request' },
        };
        const repeated = filterRepeatedPlanStepsWithReport(
            [{ tool: 'remote-command', params: { command: 'hostname' } }],
            ['{"tool":"remote-command","params":{"command":"hostname"}}'],
            new Map([['{"tool":"remote-command","params":{"command":"hostname"}}', 1]]),
        );

        expect(classifyToolExecutionResult(successEvent)).toBe('success');
        expect(classifyToolExecutionResult(retryEvent)).toBe('retryable_failure');
        expect(classifyToolExecutionResult(blockingEvent)).toBe('blocked_failure');
        expect(repeated.accepted).toHaveLength(0);
        expect(repeated.rejected[0]).toEqual(expect.objectContaining({
            signature: '{"tool":"remote-command","params":{"command":"hostname"}}',
        }));
    });

    test('builds deterministic kubectl recovery after malformed manifest failures', () => {
        const plan = buildDeterministicRecoveryPlanFromFailure({
            objective: 'Make another site that is a live calendar on the cluster.',
            executionProfile: 'remote-build',
            toolPolicy: {
                candidateToolIds: ['remote-command'],
                allowedToolIds: ['remote-command'],
            },
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-command',
                        arguments: JSON.stringify({
                            command: 'kubectl apply -f /tmp/live-calendar.yaml',
                        }),
                    },
                },
                result: {
                    success: false,
                    error: 'Deployment in version "v1" cannot be handled as a Deployment: strict decoding error: unknown field "spec.app"',
                },
            }],
        });

        expect(plan).toHaveLength(1);
        expect(plan[0]).toEqual(expect.objectContaining({
            tool: 'remote-command',
            reason: expect.stringContaining('known-good kubectl generators'),
        }));
        expect(plan[0].params.command).toContain('app=\'live-calendar\'');
        expect(plan[0].params.command).toContain('kubectl create deployment "$app"');
        expect(plan[0].params.command).toContain('kubectl patch deployment "$app"');
        expect(plan[0].params.command).toContain('kubectl rollout status deployment/"$app"');
        expect(plan[0].params.command).not.toContain('kubectl set --add');
    });

    test('recovers invalid kubectl set --add syntax with a patch-based static site command', () => {
        const plan = buildDeterministicRecoveryPlanFromFailure({
            objective: 'create a live calendar site',
            executionProfile: 'remote-build',
            toolPolicy: {
                candidateToolIds: ['remote-command'],
                allowedToolIds: ['remote-command'],
            },
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-command',
                        arguments: JSON.stringify({
                            command: 'kubectl set --add volume deployment/live-calendar -n web',
                        }),
                    },
                },
                result: {
                    success: false,
                    error: "error: unknown flag: --add\nSee 'kubectl set --help' for usage.",
                },
            }],
        });

        expect(plan).toHaveLength(1);
        expect(plan[0].params.command).toContain('kubectl patch deployment "$app"');
        expect(plan[0].params.command).toContain('kubectl exec -n "$ns" deployment/"$app"');
    });

    test('treats the literal remote-cli-agent tool id as assisted CLI intent', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveDeployConfig.mockReturnValue({});
        const toolIds = [
            'managed-app',
            'remote-command',
            'remote-workbench',
            'remote-cli-agent',
            'k3s-deploy',
            'web-search',
            'tool-doc-read',
            'user-checkpoint',
        ];
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolIds.includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient: { createResponse: jest.fn() },
            toolManager,
            sessionStore: {},
            memoryService: {},
        });
        const objective = [
            'Use remote-cli-agent read-only to verify Codex-agent transport is alive.',
            'Run only hostname and pwd, no file edits.',
            'Cap status polling at 3.',
        ].join(' ');
        const session = { id: 'session-remote-cli-hyphen', metadata: {} };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            session,
            executionProfile: 'remote-build',
            toolManager,
            metadata: { clientSurface: 'web-chat' },
            toolContext: { clientSurface: 'web-chat' },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext: { clientSurface: 'web-chat' },
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-cli-agent');
        expect(toolPolicy.preferredRemoteToolId).toBe('remote-cli-agent');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'remote-cli-agent',
            params: expect.objectContaining({
                adminMode: true,
                waitMs: 30000,
            }),
        }));
    });

    test('tracks completion criteria, evidence, and resumeable control state', () => {
        const harness = new HarnessRunState({
            objective: 'Deploy the app and verify it is live.',
            executionProfile: 'remote-build',
            autonomyApproved: true,
            completionCriteria: ['Deployment applied', 'Deployment verified'],
        });

        harness.recordEvidence({
            type: 'deployment-applied',
            summary: 'kubectl apply completed successfully.',
            tool: 'remote-command',
            stateChanged: true,
        });

        expect(harness.getUnmetCriteria().map((entry) => entry.text)).toEqual(['Deployment verified']);

        const incompleteReview = harness.reviewCompletion({
            stateChanged: true,
            progressMade: true,
            canContinue: true,
        });
        expect(incompleteReview).toEqual(expect.objectContaining({
            decision: 'continue',
            completionStatus: 'incomplete',
            finishReason: 'unmet_criteria_with_progress',
        }));
        expect(harness.toJSON().resumeAvailable).toBe(true);
        expect(harness.toControlState()).toEqual(expect.objectContaining({
            version: 'planner-recovery-v2',
            completion: expect.objectContaining({
                unmetCriteria: [expect.objectContaining({ text: 'Deployment verified' })],
            }),
        }));

        harness.recordEvidence({
            type: 'public-verification',
            summary: 'Public HTTPS check returned HTTP 200.',
            tool: 'remote-command',
            confidence: 'high',
        });
        const completeReview = harness.reviewCompletion({ canContinue: true });
        expect(completeReview).toEqual(expect.objectContaining({
            decision: 'synthesize',
            completionStatus: 'complete',
            finishConfidence: 'high',
            finishReason: 'all_required_criteria_satisfied',
        }));
        expect(harness.getUnmetCriteria()).toHaveLength(0);
    });

    test('maps structured remote-cli-agent proof to harness completion evidence', () => {
        const event = {
            toolCall: {
                function: {
                    name: 'remote-cli-agent',
                    arguments: JSON.stringify({
                        task: 'Build and deploy the weather app.',
                    }),
                },
            },
            result: {
                success: true,
                toolId: 'remote-cli-agent',
                data: {
                    cwd: '/srv/apps/weather',
                    whatChanged: 'Updated src/app.js and deployed the weather service.',
                    changedFiles: ['src/app.js', 'k8s/deployment.yaml'],
                    deployment: 'weather/weather-app',
                    publicUrl: 'https://weather.demoserver2.buzz/',
                    verifyCommands: ['npm run build', 'kubectl rollout status deploy/weather-app', 'curl -I https://weather.demoserver2.buzz/'],
                    verifyResults: ['build passed', 'rollout successful', 'HTTP/2 200'],
                    uiCheckReport: 'ui-checks/weather/report.json',
                    uiScreenshots: ['ui-checks/weather/desktop.png'],
                    completionStatus: 'complete',
                },
            },
        };
        const evidence = inferCompletionEvidenceFromToolEvent(event, { round: 1 });
        const evidenceTypes = evidence.map((entry) => entry.type);

        expect(evidence).toEqual(expect.arrayContaining([
            expect.objectContaining({ tool: 'remote-cli-agent', type: 'remote-inspection', confidence: 'high' }),
            expect.objectContaining({ tool: 'remote-cli-agent', type: 'code-change', stateChanged: true }),
            expect.objectContaining({ tool: 'remote-cli-agent', type: 'build-complete' }),
            expect.objectContaining({ tool: 'remote-cli-agent', type: 'deployment-applied', stateChanged: true }),
            expect.objectContaining({ tool: 'remote-cli-agent', type: 'deployment-verified', confidence: 'high' }),
            expect.objectContaining({ tool: 'remote-cli-agent', type: 'public-verification', confidence: 'high' }),
            expect.objectContaining({ tool: 'remote-cli-agent', type: 'visual-verification', confidence: 'high' }),
        ]));
        expect(evidenceTypes).not.toContain('k8s-inspection');
    });

    test('maps generic project-plan milestones to concrete research and artifact evidence', () => {
        const harness = new HarnessRunState({
            objective: 'Make a simple HTML page with research on AI news.',
            executionProfile: 'default',
            completionCriteria: [
                'Inspect the current state',
                'Produce the requested deliverable',
                'Validate and review the result',
            ],
        });

        harness.recordEvidence({
            type: 'research-search',
            summary: 'Research search returned verified candidate sources.',
            tool: 'web-search',
        });
        expect(harness.getUnmetCriteria().map((entry) => entry.text)).toEqual([
            'Produce the requested deliverable',
            'Validate and review the result',
        ]);

        harness.recordEvidence({
            type: 'document-generated',
            summary: 'A document or HTML page workflow produced an artifact.',
            tool: 'document-workflow',
            stateChanged: true,
        });
        expect(harness.getUnmetCriteria()).toHaveLength(0);
    });

    test('artifact evidence satisfies generic implementation milestones', () => {
        const harness = new HarnessRunState({
            objective: 'Make a quick sandboxed game and verify it.',
            executionProfile: 'default',
            completionCriteria: [
                'Implement the requested changes',
                'Validate and review the result',
            ],
        });

        harness.recordEvidence({
            type: 'artifact-created',
            summary: 'A runtime artifact was created by a tool result.',
            tool: 'document-workflow',
            stateChanged: true,
        });

        expect(harness.getUnmetCriteria()).toHaveLength(0);
    });

    test('restores completion state from a resumeable control-state snapshot', () => {
        const original = new HarnessRunState({
            objective: 'Deploy the app.',
            executionProfile: 'remote-build',
            autonomyApproved: true,
            completionCriteria: ['Deployment applied', 'Deployment verified'],
        });
        original.recordEvidence({
            type: 'deployment-applied',
            summary: 'Deployment command completed.',
            tool: 'remote-command',
            stateChanged: true,
        });
        original.reviewCompletion({ stateChanged: true, progressMade: true, canContinue: true });

        const restored = HarnessRunState.fromControlState(original.toControlState(), {
            objective: 'Deploy the app. continue',
            executionProfile: 'remote-build',
            autonomyApproved: true,
        });

        expect(restored.runId).toBe(original.runId);
        expect(restored.getUnmetCriteria().map((entry) => entry.text)).toEqual(['Deployment verified']);
        expect(restored.toJSON().completion.evidence).toHaveLength(1);
        expect(restored.toJSON().resumeAvailable).toBe(true);
    });
});

describe('Planner policy packs', () => {
    beforeEach(() => {
        settingsController.getEffectiveOrchestrationConfig.mockReturnValue({
            enabled: true,
            neuralWaveResearchMode: false,
        });
    });

    test('omits workload and remote packs when tools are unavailable', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({ llmClient });
        const toolPolicy = {
            candidateToolIds: ['web-search'],
            toolDescriptions: { 'web-search': 'web-search' },
        };

        await orchestrator.planToolUse({
            objective: 'Find sources about GPU benchmarks.',
            executionProfile: 'default',
            toolPolicy,
        });

        const plannerPrompt = llmClient.complete.mock.calls[0]?.[0] || '';
        expect(plannerPrompt).not.toContain('Every `agent-workload` step must use the deferred workload schema only');
        expect(plannerPrompt).not.toContain('Treat "remote CLI", "direct CLI", and "remote command" as aliases for `remote-command`');
    });

    test('includes workload pack only when agent-workload is a candidate', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({ llmClient });
        const toolPolicy = {
            candidateToolIds: ['agent-workload'],
            toolDescriptions: { 'agent-workload': 'agent-workload' },
        };

        await orchestrator.planToolUse({
            objective: 'Remind me tomorrow to deploy the app.',
            executionProfile: 'default',
            toolPolicy,
        });

        const plannerPrompt = llmClient.complete.mock.calls[0]?.[0] || '';
        expect(plannerPrompt).toContain('Every `agent-workload` step must use the deferred workload schema only');
        expect(plannerPrompt).not.toContain('Treat "remote CLI", "direct CLI", and "remote command" as aliases for `remote-command`');
    });

    test('includes remote pack only when remote tools are candidates', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({ llmClient });
        const toolPolicy = {
            candidateToolIds: ['remote-command'],
            toolDescriptions: { 'remote-command': 'remote-command' },
        };

        await orchestrator.planToolUse({
            objective: 'Inspect the server logs.',
            executionProfile: 'default',
            toolPolicy,
        });

        const plannerPrompt = llmClient.complete.mock.calls[0]?.[0] || '';
        expect(plannerPrompt).toContain('Treat "remote CLI", "direct CLI", and "remote command" as aliases for `remote-command`');
        expect(plannerPrompt).toContain('`remote-cli-agent` is the outer KimiBuilt tool');
        expect(plannerPrompt).toContain('do not put raw shell fields');
        expect(plannerPrompt).not.toContain('Every `agent-workload` step must use the deferred workload schema only');
    });

    test('includes the canonical frontend quality bar for frontend planning', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({ llmClient });
        const toolPolicy = {
            candidateToolIds: ['code-sandbox', 'web-scrape'],
            toolDescriptions: { 'code-sandbox': 'code-sandbox', 'web-scrape': 'web-scrape' },
        };

        await orchestrator.planToolUse({
            objective: 'Build a dashboard frontend with filters and mobile QA.',
            executionProfile: 'default',
            toolPolicy,
        });

        const plannerPrompt = llmClient.complete.mock.calls[0]?.[0] || '';
        expect(plannerPrompt).toContain('require the builder to follow this frontend quality bar');
        expect(plannerPrompt).toContain('first viewport must communicate the product');
        expect(plannerPrompt).toContain('real state and interaction plumbing');
        expect(plannerPrompt).toContain('visual assets that reveal the actual product');
        expect(plannerPrompt).toContain('desktop and mobile screenshots');
        expect(plannerPrompt).toContain('iteration pass after the first render');
    });

    test('includes neural-wave research guidance when the admin mode is enabled', async () => {
        settingsController.getEffectiveOrchestrationConfig.mockReturnValue({
            enabled: true,
            neuralWaveResearchMode: true,
        });
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({ llmClient });
        const toolPolicy = {
            candidateToolIds: ['web-search', 'web-fetch', 'document-workflow', 'agent-delegate'],
            toolDescriptions: {
                'web-search': 'web-search',
                'web-fetch': 'web-fetch',
                'document-workflow': 'document-workflow',
                'agent-delegate': 'agent-delegate',
            },
        };

        await orchestrator.planToolUse({
            objective: 'Research neural wave computing and grow the answer through small chunks, templates, direction, pieces, two review waves, and a final collection.',
            executionProfile: 'default',
            toolPolicy,
        });

        const plannerPrompt = llmClient.complete.mock.calls[0]?.[0] || '';
        expect(plannerPrompt).toContain('Neural-wave R&D mode is active');
        expect(plannerPrompt).toContain('Wave 1 fan-out');
        expect(plannerPrompt).toContain('Wave 6 polish');
        expect(plannerPrompt).toContain('final collection');
        expect(plannerPrompt).toContain('at most three bounded helper tasks');
    });
});

describe('ConversationOrchestrator', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        remoteRunnerService.runners.clear();
        config.config.runtime.judgmentV2Enabled = false;
        config.config.runtime.plannerModel = '';
        config.config.runtime.synthesisModel = '';
        config.config.runtime.repairModel = '';
        config.config.runtime.plannerReasoningEffort = '';
        config.config.runtime.synthesisReasoningEffort = '';
        config.config.runtime.repairReasoningEffort = '';
        settingsController.getEffectiveOrchestrationConfig.mockReturnValue({
            enabled: true,
            neuralWaveResearchMode: false,
        });
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: false,
            host: '',
            port: 22,
            username: '',
            password: '',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: '',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });
        settingsController.getEffectiveDeployConfig.mockReturnValue({
            repositoryUrl: '',
            targetDirectory: '',
            manifestsPath: 'k8s',
            namespace: 'kimibuilt',
            deployment: 'backend',
            container: 'backend',
            branch: 'master',
            publicDomain: 'demoserver2.buzz',
            ingressClassName: 'traefik',
            tlsClusterIssuer: 'letsencrypt-prod',
        });
    });

    afterEach(() => {
        remoteRunnerService.runners.clear();
    });

    test('adds neural-wave guidance to runtime instructions when enabled for broad R&D work', () => {
        settingsController.getEffectiveOrchestrationConfig.mockReturnValue({
            enabled: true,
            neuralWaveResearchMode: true,
        });
        const orchestrator = new ConversationOrchestrator({});

        const instructions = orchestrator.buildRuntimeInstructions({
            objective: 'Build an R&D document by expanding chunks, templates, direction, pieces, reviews, and final collection.',
            executionProfile: 'default',
            allowedToolIds: ['web-search', 'document-workflow', 'agent-delegate'],
            toolPolicy: {
                allowedToolIds: ['web-search', 'document-workflow', 'agent-delegate'],
                classification: {
                    taskFamily: 'research-deliverable',
                    surfaceMode: 'web-chat',
                    preferredExecutionPath: 'plan-first',
                    confidence: 0.9,
                },
            },
            clientSurface: 'web-chat',
        });

        expect(instructions).toContain('Neural-wave R&D mode is active');
        expect(instructions).toContain('Wave 1 fan-out');
        expect(instructions).toContain('Wave 5 review');
        expect(instructions).toContain('Final collection');
    });

    test('uses a plain model response when no tools are selected', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Plain answer', 'resp_plain')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn(() => null),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-1', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([{ role: 'assistant', content: 'Earlier answer' }]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue(['Remembered context']),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Answer directly.',
            sessionId: 'session-1',
            stream: false,
        });

        expect(result.output).toBe('Plain answer');
        expect(result.response.metadata.harness).toEqual(expect.objectContaining({
            version: 'planner-recovery-v2',
            executionProfile: 'default',
            autonomyLevel: 'guarded',
            decision: 'synthesize',
        }));
        expect(result.trace.harness).toEqual(expect.objectContaining({
            runId: result.response.metadata.harness.runId,
            rounds: expect.any(Array),
        }));
        expect(llmClient.complete).not.toHaveBeenCalled();
        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: 'Answer directly.',
            enableAutomaticToolCalls: false,
            contextMessages: ['Remembered context'],
            recentMessages: [{ role: 'assistant', content: 'Earlier answer' }],
        }));
        expect(sessionStore.recordResponse).toHaveBeenCalledWith('session-1', 'resp_plain');
        expect(memoryService.rememberResponse).toHaveBeenCalledWith(
            'session-1',
            'Plain answer',
            expect.objectContaining({
                memoryScope: 'global',
                sourceSurface: 'chat',
            }),
        );
    });

    test('remote-build policy keeps routine build work autonomous instead of adding checkpoints', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'user-checkpoint', 'tool-doc-read'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Build the site on the remote server, fix any test failures, deploy it, and verify HTTPS.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                userCheckpointPolicy: {
                    enabled: true,
                    remaining: 3,
                },
            },
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('user-checkpoint');
    });

    test('infers an agency profile for delegated, scheduled, and sustained work', () => {
        expect(inferAgencyProfile({
            objective: 'Use multiple agents in parallel to inspect the repo and propose fixes.',
        })).toEqual(expect.objectContaining({
            level: 'delegate',
            delegation: 'explicit',
            askPolicy: 'assume-and-proceed',
        }));

        expect(inferAgencyProfile({
            objective: 'Set up cron jobs for security updates and security checks.',
        })).toEqual(expect.objectContaining({
            level: 'schedule-multiple',
            scheduling: 'multi-workload',
        }));

        expect(inferAgencyProfile({
            objective: 'Keep working through multiple steps until the goal is reached.',
        })).toEqual(expect.objectContaining({
            level: 'sustained',
            contextPolicy: 'actively-gather-context',
            maxRoundsHint: 4,
        }));
    });

    test('routes plain multiple-agent language to the delegate tool', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['agent-delegate', 'web-search', 'file-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Use multiple agents to research the options and inspect the workspace in parallel.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.agencyProfile).toEqual(expect.objectContaining({
            level: 'delegate',
            delegation: 'explicit',
        }));
        expect(toolPolicy.candidateToolIds).toContain('agent-delegate');
    });

    test('routes PII XLSX formula-plan prompts through the relationship calculator instead of documents', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['document-workflow', 'pii-relationship-calculate', 'file-write'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });
        const objective = [
            'Do not create an artifact, workbook, HTML, PDF, file, or download.',
            'Use the hidden PII relationship calculation tool only. Tool operation must be xlsx_formula_plan.',
            'Table id: sales',
            'Columns: person, period, baseSales, serviceFees, rebates, credits',
            'Rows:',
            'r1 | [[PII:a1]] | Jan | 120.50 | 12 | 3.50 | 4',
            'r2 | [[PII:b1]] | Feb | 30 | 0 | 0 | 1',
            'Formula intent: per-row amount is baseSales + serviceFees + rebates - credits.',
            'Target result cell Presentation_Result!B5. Helper slots begin at Presentation_Result!A12.',
        ].join('\n');

        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds[0]).toBe('pii-relationship-calculate');
        expect(toolPolicy.candidateToolIds).not.toContain('document-workflow');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'pii-relationship-calculate',
            params: expect.objectContaining({
                operation: 'xlsx_formula_plan',
                tableId: 'sales',
                groupBy: 'person',
                measures: ['baseSales', 'serviceFees', 'rebates'],
                subtractMeasures: ['credits'],
            }),
        }));
    });

    test('routes prepared PII workbook requests through the relationship calculator', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['document-workflow', 'pii-relationship-calculate', 'asset-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });
        const workbookRequest = {
            operationId: 'workbook-top-balance',
            operation: 'top_n',
            tableId: 't1',
            groupBy: 'c10',
            measure: 'c39',
            limit: 1,
            tables: [{ id: 't1', columns: [], rows: [] }],
        };
        const toolContext = {
            artifactIds: ['artifact-xlsx'],
            piiWorkbookRelationship: {
                request: workbookRequest,
            },
        };
        const objective = 'Calculate from the selected XLSX structured table: top patient UID by Patient Balance.';

        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
            toolContext,
        });

        expect(toolPolicy.candidateToolIds[0]).toBe('pii-relationship-calculate');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'pii-relationship-calculate',
            params: workbookRequest,
        }));
    });

    test('does not offer deferred workloads just because instructions mention scheduling', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'agent-workload'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Ask an agent to fix this now, not later.',
            instructions: 'If the user explicitly asks for a cron job, recurring schedule, reminder, or future run, use agent-workload.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).not.toContain('agent-workload');
    });

    test('rewrites malformed delegate plans so a child task is not the whole user request', async () => {
        const objective = 'Use multiple agents to inspect the repo and implement the fix in parallel.';
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn().mockResolvedValue(JSON.stringify({
                    steps: [{
                        tool: 'agent-delegate',
                        reason: 'Delegate the full request.',
                        params: {
                            action: 'spawn',
                            tasks: [{
                                title: 'Do request',
                                prompt: objective,
                            }],
                        },
                    }],
                })),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'agent-delegate'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const plan = await orchestrator.planToolUse({
            objective,
            executionProfile: 'default',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'agent-delegate',
                params: expect.objectContaining({
                    tasks: [
                        expect.objectContaining({
                            prompt: 'Delegate the full request.',
                        }),
                    ],
                }),
            }),
        ]);
        expect(plan[0].params.tasks[0].prompt).not.toBe(objective);
    });

    test('forces multi-workload scheduling through the planner so jobs can be split', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'agent-workload'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Set up cron jobs for security updates and security checks.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(toolPolicy.agencyProfile).toEqual(expect.objectContaining({
            level: 'schedule-multiple',
            scheduling: 'multi-workload',
        }));
        expect(toolPolicy.candidateToolIds).toContain('agent-workload');
        expect(directAction).toBeNull();
    });

    test('remote-build policy still allows checkpoints for explicit design decisions', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'user-checkpoint', 'tool-doc-read'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Before implementation, help me choose which architecture approach to use for the server build.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                userCheckpointPolicy: {
                    enabled: true,
                    remaining: 3,
                },
            },
        });

        expect(toolPolicy.candidateToolIds).toContain('user-checkpoint');
    });

    test('default profile routes explicit remote server work to remote-command', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'file-read', 'file-write', 'code-sandbox', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Inspect the remote server and check kubectl pods.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.allowedToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('code-sandbox');
    });

    test('remote-build policy exposes online runner CLI inventory to planners', () => {
        remoteRunnerService.registerRunner({
            runnerId: 'actual-server-cli',
            capabilities: ['inspect', 'deploy'],
            metadata: {
                defaultCwd: '/srv/kimibuilt',
                shell: '/bin/bash',
                cliTools: [
                    { name: 'kubectl', available: true, path: '/usr/local/bin/kubectl' },
                    { name: 'git', available: true, path: '/usr/bin/git' },
                    { name: 'rg', available: false, path: '' },
                ],
            },
        }, { readyState: 1, send: jest.fn() });
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'k3s-deploy', 'tool-doc-read'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Use remote-build to inspect kubectl pods on the server.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.remoteCliInventorySummary).toContain('Runner actual-server-cli is online');
        expect(toolPolicy.remoteCliInventorySummary).toContain('kubectl=/usr/local/bin/kubectl');
        expect(toolPolicy.remoteCliInventorySummary).toContain('git=/usr/bin/git');
        expect(toolPolicy.remoteCliInventorySummary).toContain('rg');
    });

    test('restores harness completion state for a continuation turn', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Continuing from the saved harness state.', 'resp_harness_resume')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn(() => null),
        };
        const savedHarness = {
            version: 'planner-recovery-v2',
            runId: 'harness_saved_1',
            currentObjective: 'Deploy the app and verify it is live.',
            executionProfile: 'remote-build',
            autonomyLevel: 'guarded-remote',
            completion: {
                criteria: [
                    { id: 'deployment-applied', text: 'Deployment applied', status: 'satisfied', evidenceIds: ['e1'] },
                    { id: 'deployment-verified', text: 'Deployment verified', status: 'pending', evidenceIds: [] },
                ],
                evidence: [
                    { id: 'e1', summary: 'Deployment command completed.', type: 'deployment-applied', tool: 'remote-command', criterionIds: ['deployment-applied'] },
                ],
                unmetCriteria: [{ id: 'deployment-verified', text: 'Deployment verified' }],
                finishConfidence: 'low',
                finishReason: 'unmet_criteria_with_progress',
            },
            blockers: [],
            recoveryAttempts: [],
            decision: 'continue',
            lastStateChangeAt: '2026-04-25T00:00:00.000Z',
        };
        const session = {
            id: 'session-harness-resume',
            metadata: {
                controlState: {
                    harness: savedHarness,
                },
            },
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue(session),
            getOrCreate: jest.fn().mockResolvedValue(session),
            getRecentMessages: jest.fn().mockResolvedValue([
                { role: 'user', content: 'Deploy the app and verify it is live.' },
                { role: 'assistant', content: 'Deployment applied; verification remains.' },
            ]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'continue',
            sessionId: 'session-harness-resume',
            stream: false,
        });

        expect(result.response.metadata.harness).toEqual(expect.objectContaining({
            runId: 'harness_saved_1',
            currentObjective: expect.stringContaining('Deploy the app'),
            completion: expect.objectContaining({
                unmetCriteria: expect.arrayContaining([
                    expect.objectContaining({ text: 'Deployment verified' }),
                ]),
            }),
        }));
    });

    test('persists promptState metadata without crashing the conversation completion path', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(
                buildResponseWithPromptState('Prompt state answer', 'resp_prompt_state', { plan: 'keep' }),
            ),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn(() => null),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-prompt-state', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Answer directly with prompt state.',
            sessionId: 'session-prompt-state',
            stream: false,
        });

        expect(result.output).toBe('Prompt state answer');
        expect(sessionStore.recordResponse).toHaveBeenCalledWith(
            'session-prompt-state',
            'resp_prompt_state',
            { promptState: { plan: 'keep' } },
        );
    });

    test('finalizes a pending web-chat foreground turn in place instead of appending duplicate transcript rows', async () => {
        const sessionStore = {
            get: jest.fn().mockResolvedValue({
                id: 'session-foreground',
                metadata: {
                    taskType: 'chat',
                    clientSurface: 'web-chat',
                },
                controlState: {
                    foregroundTurn: {
                        requestId: 'req-foreground-1',
                        userMessageId: 'user-msg-foreground-1',
                        assistantMessageId: 'assistant-msg-foreground-1',
                        clientSurface: 'web-chat',
                        taskType: 'chat',
                        status: 'running',
                        userTimestamp: '2026-04-11T10:00:00.000Z',
                        assistantTimestamp: '2026-04-11T10:00:00.001Z',
                    },
                },
            }),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            upsertMessage: jest.fn().mockResolvedValue(undefined),
            updateControlState: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            rememberResponse: jest.fn(),
            rememberLearnedSkill: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
            sessionStore,
            memoryService,
        });

        await orchestrator.persistConversationState({
            sessionId: 'session-foreground',
            userText: 'Keep this turn durable.',
            objective: 'Keep this turn durable.',
            assistantText: 'Finished in place.',
            responseId: 'resp-foreground-1',
            clientSurface: 'web-chat',
            foregroundTurn: {
                requestId: 'req-foreground-1',
                userMessageId: 'user-msg-foreground-1',
                assistantMessageId: 'assistant-msg-foreground-1',
                userTimestamp: '2026-04-11T10:00:00.000Z',
                assistantTimestamp: '2026-04-11T10:00:00.001Z',
                clientSurface: 'web-chat',
                taskType: 'chat',
                status: 'running',
            },
            assistantMetadata: {
                reasoningSummary: 'Finalized from the server.',
            },
        });

        expect(sessionStore.appendMessages).not.toHaveBeenCalled();
        expect(sessionStore.upsertMessage).toHaveBeenCalledWith(
            'session-foreground',
            expect.objectContaining({
                id: 'assistant-msg-foreground-1',
                role: 'assistant',
                content: 'Finished in place.',
            }),
        );
        expect(sessionStore.updateControlState).toHaveBeenCalledWith('session-foreground', {
            foregroundTurn: null,
        });
    });

    test('persists tool-derived presentation artifacts onto web-chat assistant messages', async () => {
        const sessionStore = {
            getOwned: jest.fn().mockResolvedValue({ id: 'session-artifacts', metadata: {} }),
            get: jest.fn().mockResolvedValue({ id: 'session-artifacts', metadata: {} }),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            updateControlState: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            rememberResponse: jest.fn(),
            rememberLearnedSkill: jest.fn(async () => undefined),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
            sessionStore,
            memoryService,
        });

        await orchestrator.persistConversationState({
            sessionId: 'session-artifacts',
            userText: 'Build the deck.',
            objective: 'Build the deck.',
            assistantText: 'Built the research deck.',
            responseId: 'resp-artifacts-1',
            clientSurface: 'web-chat',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'deep-research-presentation',
                    },
                },
                result: {
                    success: true,
                    toolId: 'deep-research-presentation',
                    data: {
                        action: 'research_and_generate_presentation',
                        document: {
                            id: 'deck-1',
                            filename: 'research-deck.pptx',
                            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                            downloadUrl: '/api/documents/deck-1/download',
                            metadata: { format: 'pptx' },
                        },
                    },
                },
            }],
        });

        expect(sessionStore.appendMessages).toHaveBeenCalledWith(
            'session-artifacts',
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'assistant',
                    content: 'Built the research deck.',
                    metadata: expect.objectContaining({
                        artifacts: [
                            expect.objectContaining({
                                id: 'deck-1',
                                filename: 'research-deck.pptx',
                                downloadUrl: '/api/documents/deck-1/download',
                            }),
                        ],
                    }),
                }),
            ]),
        );
        expect(sessionStore.update).toHaveBeenCalledWith('session-artifacts', expect.objectContaining({
            metadata: expect.objectContaining({
                projectMemory: expect.objectContaining({
                    artifacts: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'deck-1',
                            filename: 'research-deck.pptx',
                        }),
                    ]),
                }),
            }),
        }));
    });

    test('persists remote-cli-agent continuity state from orchestrated tool events', async () => {
        const sessionStore = {
            getOwned: jest.fn().mockResolvedValue({ id: 'session-remote-cli-state', metadata: {} }),
            get: jest.fn().mockResolvedValue({ id: 'session-remote-cli-state', metadata: {} }),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            updateControlState: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            rememberResponse: jest.fn(),
            rememberLearnedSkill: jest.fn(async () => undefined),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
            sessionStore,
            memoryService,
        });

        await orchestrator.completeConversationRun({
            sessionId: 'session-remote-cli-state',
            userText: 'Build the Calan app with remote-cli-agent.',
            objective: 'Build the Calan app with remote-cli-agent.',
            assistantText: 'Remote CLI finished.',
            output: 'Remote CLI finished.',
            finalResponse: buildResponse('Remote CLI finished.', 'resp-remote-cli-state'),
            executionProfile: 'remote-build',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-cli-agent',
                        arguments: JSON.stringify({
                            task: 'Build the Calan app with remote-cli-agent.',
                            cwd: '/srv/apps/calan-calendar',
                        }),
                    },
                },
                result: {
                    success: true,
                    toolId: 'remote-cli-agent',
                    data: {
                        finalOutput: 'Built and deployed Calan.',
                        sessionId: 'remote-code-session-2',
                        mcpSessionId: 'mcp-session-2',
                        cwd: '/srv/apps/calan-calendar',
                        remoteCodeJobId: 'rcli_calan_2',
                        gitBranch: 'agent/calan-calendar',
                        gitBaseCommit: 'def5678',
                        gitCommit: 'abc1234',
                        changedFiles: ['src/app.js', 'k8s/deployment.yaml'],
                        publicHost: 'calan.demoserver2.buzz',
                        completionStatus: 'blocked',
                        blocker: 'remote_code_run still running after status polling.',
                    },
                },
            }],
        });

        expect(sessionStore.updateControlState).toHaveBeenCalledWith(
            'session-remote-cli-state',
            expect.objectContaining({
                lastToolIntent: 'remote-cli-agent',
                remoteCliAgent: expect.objectContaining({
                    lastTask: 'Build the Calan app with remote-cli-agent.',
                    sessionId: 'remote-code-session-2',
                    mcpSessionId: 'mcp-session-2',
                    cwd: '/srv/apps/calan-calendar',
                    remoteCodeJobId: 'rcli_calan_2',
                    gitBranch: 'agent/calan-calendar',
                    gitBaseCommit: 'def5678',
                    gitCommit: 'abc1234',
                    changedFiles: ['src/app.js', 'k8s/deployment.yaml'],
                    publicHost: 'calan.demoserver2.buzz',
                    completionStatus: 'blocked',
                    blocker: 'remote_code_run still running after status polling.',
                }),
            }),
        );
        expect(sessionStore.update).toHaveBeenCalledWith(
            'session-remote-cli-state',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    leadAgentState: expect.objectContaining({
                        objective: 'Build the Calan app with remote-cli-agent.',
                        status: 'blocked',
                        executionProfile: 'remote-build',
                        lastVerifiedAction: expect.stringContaining('remote-cli-agent'),
                        blockers: expect.arrayContaining([
                            'remote_code_run still running after status polling.',
                        ]),
                    }),
                }),
            }),
        );
    });

    test('triggers session compaction after persistence with merged workflow and project memory state', async () => {
        const sessionStore = {
            getOwned: jest.fn().mockResolvedValue({
                id: 'session-compact',
                metadata: {
                    projectMemory: {
                        tasks: [{
                            summary: 'Existing project note.',
                            status: 'partial',
                        }],
                    },
                },
                controlState: {
                    workflow: {
                        lane: 'deploy',
                        status: 'active',
                        stage: 'apply',
                    },
                },
            }),
            get: jest.fn().mockResolvedValue({
                id: 'session-compact',
                metadata: {
                    projectMemory: {
                        tasks: [{
                            summary: 'Existing project note.',
                            status: 'partial',
                        }],
                    },
                },
                controlState: {
                    workflow: {
                        lane: 'deploy',
                        status: 'active',
                        stage: 'apply',
                    },
                },
            }),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            updateControlState: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
            maybeCompactSession: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            rememberResponse: jest.fn(),
            rememberLearnedSkill: jest.fn(async () => undefined),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
            sessionStore,
            memoryService,
        });

        await orchestrator.persistConversationState({
            sessionId: 'session-compact',
            ownerId: 'user-1',
            userText: 'Finish the deploy verification.',
            objective: 'Finish the deploy verification.',
            assistantText: 'Verified the rollout and stored the result.',
            responseId: 'resp-compact-1',
            controlStatePatch: {
                workflow: {
                    status: 'completed',
                    stage: 'verified',
                },
            },
        });

        expect(sessionStore.maybeCompactSession).toHaveBeenCalledWith('session-compact', expect.objectContaining({
            ownerId: 'user-1',
            workflow: expect.objectContaining({
                lane: 'deploy',
                status: 'completed',
                stage: 'verified',
            }),
            projectMemory: expect.any(Object),
        }));
    });

    test('expands a truncated follow-up from recent transcript before asking the model for a plain response', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Recovered answer', 'resp_recovered')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn(() => null),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-followup-plain', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([
                { role: 'user', content: 'give me a breakdown of the k3s cluster on the server' },
            ]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'in five minutes from now',
            sessionId: 'session-followup-plain',
            stream: false,
        });

        expect(result.output).toBe('Recovered answer');
        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.stringContaining('give me a breakdown of the k3s cluster on the server'),
            instructions: expect.stringContaining('continue without asking the user to restate prior context'),
        }));
    });

    test('does not merge a concise standalone request into prior transcript context', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Pods answer', 'resp_pods')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn(() => null),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-standalone-plain', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([
                { role: 'user', content: 'give me a breakdown of the k3s cluster on the server' },
            ]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'check pods',
            sessionId: 'session-standalone-plain',
            stream: false,
        });

        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: 'check pods',
        }));
        expect(llmClient.createResponse).not.toHaveBeenCalledWith(expect.objectContaining({
            input: expect.stringContaining('give me a breakdown of the k3s cluster on the server. check pods'),
        }));
    });

    test('uses a deterministic remote health workflow for health report prompts without model synthesis', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (toolId === 'remote-command' ? { id: toolId } : null)),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'Hostname: ubuntu-32gb-fsn1-2\nArchitecture: aarch64\nOS: Ubuntu 24.04.4 LTS\n19:29:25 up 9 days',
                        stderr: '',
                        host: '10.0.0.5:22',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: '/dev/sda1 301G 13G 276G 5% /\nMem: 32000 3300 14000 8 12000 27000',
                        stderr: '',
                        host: '10.0.0.5:22',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-health', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'can you remote into the server and get a health report',
            sessionId: 'session-health',
            stream: false,
        });

        expect(llmClient.createResponse).not.toHaveBeenCalled();
        expect(llmClient.complete).not.toHaveBeenCalled();
        expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
        expect(result.trace.runtimeMode).toBe('deterministic-remote-health');
        expect(result.output).toContain('Server Health Report');
        expect(result.output).toContain('System Information');
        expect(result.output).toContain('Disk And Memory');
        expect(sessionStore.update).toHaveBeenCalledWith('session-health', expect.objectContaining({
            metadata: expect.objectContaining({
                controlState: expect.objectContaining({
                    workflow: expect.objectContaining({
                        type: 'remote-health-report',
                        status: 'completed',
                    }),
                }),
            }),
        }));
    });

    test('emits progress snapshots for deterministic multi-step work', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (toolId === 'remote-command' ? { id: toolId } : null)),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'Hostname: ubuntu-32gb-fsn1-2\nArchitecture: aarch64\nOS: Ubuntu 24.04.4 LTS\n19:29:25 up 9 days',
                        stderr: '',
                        host: '10.0.0.5:22',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: '/dev/sda1 301G 13G 276G 5% /\nMem: 32000 3300 14000 8 12000 27000',
                        stderr: '',
                        host: '10.0.0.5:22',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-health-progress', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };
        const onProgress = jest.fn();

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'can you remote into the server and get a health report',
            sessionId: 'session-health-progress',
            stream: false,
            onProgress,
        });

        const progressSnapshots = onProgress.mock.calls.map(([snapshot]) => snapshot).filter(Boolean);
        expect(progressSnapshots.length).toBeGreaterThan(0);
        expect(progressSnapshots[0]).toEqual(expect.objectContaining({
            phase: 'planning',
            totalSteps: expect.any(Number),
            steps: expect.arrayContaining([
                expect.objectContaining({
                    title: expect.any(String),
                }),
            ]),
        }));
        expect(progressSnapshots.some((snapshot) => snapshot.phase === 'executing')).toBe(true);
        expect(progressSnapshots.some((snapshot) => snapshot.completedSteps >= 1)).toBe(true);
    });

    test('prefers agent-workload over deterministic remote health when the request is scheduled for later', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolId === 'remote-command' || toolId === 'agent-workload'
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn(async (toolId) => {
                if (toolId === 'agent-workload') {
                    return {
                        success: true,
                        toolId,
                        data: {
                            action: 'create_from_scenario',
                            message: 'Server health report created. Every day at 8:00 PM.',
                            workload: {
                                id: 'workload-1',
                                title: 'Server Health Report',
                                trigger: {
                                    type: 'cron',
                                    expression: '0 20 * * *',
                                    timezone: 'America/Halifax',
                                },
                            },
                        },
                    };
                }

                throw new Error(`Unexpected tool execution: ${toolId}`);
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-scheduled-health', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'can you run a cron later every day at 8 pm to remote into the server and get a health report',
            sessionId: 'session-scheduled-health',
            toolContext: {
                timezone: 'America/Halifax',
            },
            stream: false,
        });

        expect(llmClient.createResponse).not.toHaveBeenCalled();
        expect(llmClient.complete).not.toHaveBeenCalled();
        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'agent-workload',
            expect.objectContaining({
                action: 'create',
                trigger: {
                    type: 'cron',
                    expression: '0 20 * * *',
                    timezone: 'America/Halifax',
                },
                metadata: expect.objectContaining({
                    createdFromScenario: true,
                    scenarioRequest: 'can you run a cron later every day at 8 pm to remote into the server and get a health report',
                }),
            }),
            expect.any(Object),
        );
        expect(result.trace.runtimeMode).toBe('direct-tool');
        expect(result.output).toContain('Every day at 8:00 PM');
        expect(result.output).not.toContain('Server Health Report\n\nSystem Information');
    });

    test('continues a truncated scheduled follow-up from recent transcript instead of asking for clarification', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolId === 'agent-workload'
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn(async (toolId) => {
                if (toolId === 'agent-workload') {
                    return {
                        success: true,
                        toolId,
                        data: {
                            action: 'create',
                            message: 'K3s Cluster Breakdown created. Runs once at 2026-04-03T14:52:00.000Z.',
                            workload: {
                                id: 'workload-followup-1',
                                title: 'K3s Cluster Breakdown',
                                trigger: {
                                    type: 'once',
                                    runAt: '2026-04-03T14:52:00.000Z',
                                },
                            },
                        },
                    };
                }

                throw new Error(`Unexpected tool execution: ${toolId}`);
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-followup-tool', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([
                { role: 'user', content: 'give me a breakdown of the k3s cluster on the server' },
            ]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'in five minutes from now',
            sessionId: 'session-followup-tool',
            stream: false,
            toolContext: {
                timezone: 'UTC',
                now: '2026-04-03T14:47:00.000Z',
            },
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'agent-workload',
            expect.objectContaining({
                action: 'create',
                prompt: expect.stringContaining('give me a breakdown of the k3s cluster on the server'),
                trigger: {
                    type: 'once',
                    runAt: '2026-04-03T14:52:00.000Z',
                },
            }),
            expect.any(Object),
        );
        expect(llmClient.createResponse).not.toHaveBeenCalled();
        expect(result.output).toBe('K3s Cluster Breakdown created. Runs once at 2026-04-03T14:52:00.000Z.');
    });

    test('expands referential deep-research follow-ups before recalling memory', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Starting deep research.', 'resp_deep_research_followup')),
            complete: jest.fn(),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-deep-research-followup', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([
                { role: 'user', content: 'Research Halifax vacation pricing for a presentation.' },
                { role: 'assistant', content: 'I can do that.' },
            ]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue({
                contextMessages: [],
                bundles: { fact: [], artifact: [], skill: [], research: [] },
                trace: null,
            }),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn(() => null),
            },
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'yes do deep research on that',
            sessionId: 'session-deep-research-followup',
            stream: false,
        });

        expect(memoryService.process).toHaveBeenCalledWith(
            'session-deep-research-followup',
            'yes do deep research on that',
            expect.objectContaining({
                recallQuery: 'Research Halifax vacation pricing for a presentation. yes do deep research on that',
                objective: 'Research Halifax vacation pricing for a presentation. yes do deep research on that',
                recentMessages: [
                    { role: 'user', content: 'Research Halifax vacation pricing for a presentation.' },
                    { role: 'assistant', content: 'I can do that.' },
                ],
            }),
        );
    });

    test('terminates immediately after a successful workload creation instead of replanning', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolId === 'remote-command' || toolId === 'agent-workload'
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn(async (toolId) => {
                if (toolId === 'agent-workload') {
                    return {
                        success: true,
                        toolId,
                        data: {
                            action: 'create',
                            message: 'Check Remote Time created. Runs once at 2026-04-03T20:05:00.000Z.',
                            workload: {
                                id: 'workload-1',
                                title: 'Check Remote Time',
                                trigger: {
                                    type: 'once',
                                    runAt: '2026-04-03T20:05:00.000Z',
                                },
                            },
                        },
                    };
                }

                throw new Error(`Unexpected tool execution: ${toolId}`);
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-workload-terminal', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'can you run a cron later to check the time on the remote host in 5 minutes',
            sessionId: 'session-workload-terminal',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            toolContext: {
                timezone: 'America/Halifax',
                now: '2026-04-03T20:00:00.000Z',
            },
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(llmClient.createResponse).not.toHaveBeenCalled();
        expect(llmClient.complete).not.toHaveBeenCalled();
        expect(result.output).toBe('Check Remote Time created. Runs once at 2026-04-03T20:05:00.000Z.');
        expect(result.trace.runtimeMode).toBe('direct-tool');
    });

    test('streams a synthetic final response after successful workload creation', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolId === 'remote-command' || toolId === 'agent-workload'
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn(async (toolId) => {
                if (toolId === 'agent-workload') {
                    return {
                        success: true,
                        toolId,
                        data: {
                            action: 'create',
                            message: 'Check Remote Time created. Runs once at 2026-04-03T20:05:00.000Z.',
                            workload: {
                                id: 'workload-1',
                                title: 'Check Remote Time',
                                trigger: {
                                    type: 'once',
                                    runAt: '2026-04-03T20:05:00.000Z',
                                },
                            },
                        },
                    };
                }

                throw new Error(`Unexpected tool execution: ${toolId}`);
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-workload-terminal-stream', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'can you run a cron later to check the time on the remote host in 5 minutes',
            sessionId: 'session-workload-terminal-stream',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            toolContext: {
                timezone: 'America/Halifax',
                now: '2026-04-03T20:00:00.000Z',
            },
            stream: true,
        });

        expect(typeof result.response?.[Symbol.asyncIterator]).toBe('function');

        const events = [];
        for await (const event of result.response) {
            events.push(event);
        }

        expect(events.some((event) => event.type === 'response.output_text.delta')).toBe(true);
        expect(events.at(-1)).toMatchObject({
            type: 'response.completed',
            response: expect.objectContaining({
                metadata: expect.objectContaining({
                    terminalWorkloadCreation: true,
                }),
            }),
        });
    });

    test('retries the stored deterministic remote health workflow without planner or synthesis', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const storedSteps = [
            {
                tool: 'remote-command',
                reason: 'Collect system information for the remote server.',
                params: {
                    host: '10.0.0.5',
                    username: 'ubuntu',
                    port: 22,
                    command: "hostname && uname -m && (test -f /etc/os-release && sed -n '1,6p' /etc/os-release || true) && uptime",
                },
            },
            {
                tool: 'remote-command',
                reason: 'Collect disk and memory information for the remote server.',
                params: {
                    host: '10.0.0.5',
                    username: 'ubuntu',
                    port: 22,
                    command: 'df -h / && free -m',
                },
            },
        ];

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (toolId === 'remote-command' ? { id: toolId } : null)),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'retry-system-info', stderr: '', host: '10.0.0.5:22' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'retry-disk-memory', stderr: '', host: '10.0.0.5:22' },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({
                id: 'session-retry-health',
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: '10.0.0.5',
                        username: 'ubuntu',
                        port: 22,
                    },
                    remoteWorkingState: {
                        lastUpdated: new Date().toISOString(),
                        lastCommand: 'df -h / && free -m',
                    },
                    controlState: {
                        workflow: {
                            type: 'remote-health-report',
                            steps: storedSteps,
                        },
                    },
                },
            }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'try again to remote command',
            sessionId: 'session-retry-health',
            stream: false,
        });

        expect(llmClient.createResponse).not.toHaveBeenCalled();
        expect(llmClient.complete).not.toHaveBeenCalled();
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            1,
            'remote-command',
            storedSteps[0].params,
            expect.objectContaining({ sessionId: 'session-retry-health' }),
        );
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            2,
            'remote-command',
            storedSteps[1].params,
            expect.objectContaining({ sessionId: 'session-retry-health' }),
        );
        expect(result.trace.runtimeMode).toBe('deterministic-remote-health');
        expect(result.output).toContain('retry-system-info');
        expect(result.output).toContain('retry-disk-memory');
    });

    test('deterministic remote health workflow ignores autonomy mode and still bypasses model synthesis', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (toolId === 'remote-command' ? { id: toolId } : null)),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'system-info', stderr: '', host: '10.0.0.5:22' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'disk-memory', stderr: '', host: '10.0.0.5:22' },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-auto-health', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'can you remote into the server and do a health report',
            sessionId: 'session-auto-health',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(llmClient.createResponse).not.toHaveBeenCalled();
        expect(llmClient.complete).not.toHaveBeenCalled();
        expect(result.trace.runtimeMode).toBe('deterministic-remote-health');
        expect(result.output).toContain('Summary: Remote health inspection completed successfully.');
    });

    test('treats remote permission-grant replies as approval for the previous remote objective', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (toolId === 'remote-command' ? { id: toolId } : null)),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'approved-system-info', stderr: '', host: '10.0.0.5:22' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'approved-disk-memory', stderr: '', host: '10.0.0.5:22' },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({
                id: 'session-approval-health',
                metadata: {
                    remoteBuildAutonomyApproved: true,
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: '10.0.0.5',
                        username: 'ubuntu',
                        port: 22,
                    },
                    controlState: {
                        lastRemoteObjective: 'can you remote into the server and get a health report',
                    },
                },
            }),
            getRecentMessages: jest.fn().mockResolvedValue([
                { role: 'user', content: 'can you remote into the server and get a health report' },
            ]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'you can use remote command. i give you permission',
            sessionId: 'session-approval-health',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(llmClient.createResponse).not.toHaveBeenCalled();
        expect(llmClient.complete).not.toHaveBeenCalled();
        expect(result.trace.runtimeMode).toBe('deterministic-remote-health');
        expect(result.output).toContain('Server Health Report');
        expect(result.output).not.toContain('you can use remote command. i give you permission');
        expect(sessionStore.appendMessages).toHaveBeenCalledWith('session-approval-health', [
            { role: 'user', content: 'you can use remote command. i give you permission' },
            expect.objectContaining({ role: 'assistant' }),
        ]);
    });

    test('passes reasoning effort into final response synthesis', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Synthesized answer', 'resp_reasoning')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        await orchestrator.buildFinalResponse({
            input: 'Summarize the verified results.',
            objective: 'Summarize the verified results.',
            reasoningEffort: 'high',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'web-fetch',
                    },
                },
                result: {
                    success: true,
                    data: {
                        text: 'Verified source material',
                    },
                },
            }],
        });

        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            reasoningEffort: 'high',
        }));
    });

    test('fallback synthesis summarizes web-search results without dumping raw json', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'resp_empty_search',
                model: 'gpt-test',
                choices: [{ message: {} }],
                metadata: {},
            }),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        const response = await orchestrator.buildFinalResponse({
            input: 'Find a great resort destination for April.',
            objective: 'Find a great resort destination for April.',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'web-search',
                    },
                },
                reason: 'Find great places to resort in April.',
                result: {
                    success: true,
                    toolId: 'web-search',
                    data: {
                        query: 'best resorts in April',
                        engine: 'perplexity',
                        results: [
                            {
                                title: 'Maui Beach Resorts Guide',
                                url: 'https://example.com/maui',
                                snippet: 'Maui combines warm April weather, beach resorts, and direct flights from many North American hubs.',
                                source: 'example.com',
                            },
                            {
                                title: 'Cancun All-Inclusive Resorts',
                                url: 'https://travel.example/cancun',
                                snippet: 'Cancun is strong in April for reliable heat, resort density, and family-friendly packages.',
                                source: 'travel.example',
                            },
                        ],
                    },
                },
            }],
        });

        const text = response.output[0].content[0].text;
        expect(text).toContain('Based on the verified tool results');
        expect(text).toContain('Maui Beach Resorts Guide');
        expect(text).toContain('Cancun All-Inclusive Resorts');
        expect(text).not.toContain('{"query"');
        expect(text).not.toContain('[truncated');
    });

    test('fallback synthesis summarizes fetched page content instead of returning raw html', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'resp_empty_fetch',
                model: 'gpt-test',
                choices: [{ message: {} }],
                metadata: {},
            }),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        const response = await orchestrator.buildFinalResponse({
            input: 'Review the Bicycle Thief homepage.',
            objective: 'Review the Bicycle Thief homepage.',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'web-fetch',
                    },
                },
                reason: 'Fetch the Bicycle Thief homepage for review.',
                result: {
                    success: true,
                    toolId: 'web-fetch',
                    data: {
                        status: 200,
                        statusText: 'OK',
                        url: 'https://bicyclethief.ca',
                        headers: {
                            'content-type': 'text/html; charset=utf-8',
                        },
                        body: '<!DOCTYPE html><html><head><title>Bicycle Thief</title></head><body><main>Harbourfront restaurant in Halifax with seafood, pasta, and cocktails.</main></body></html>',
                    },
                },
            }],
        });

        const text = response.output[0].content[0].text;
        expect(text).toContain('Title: Bicycle Thief.');
        expect(text).toContain('Harbourfront restaurant in Halifax with seafood, pasta, and cocktails.');
        expect(text).toContain('Source: https://bicyclethief.ca.');
        expect(text).not.toContain('<html>');
    });

    test('fallback synthesis keeps verified research extracts when both search and fetched pages exist', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'resp_empty_research',
                model: 'gpt-test',
                choices: [{ message: {} }],
                metadata: {},
            }),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        const response = await orchestrator.buildFinalResponse({
            input: 'Research the best project documentation hosts.',
            objective: 'Research the best project documentation hosts.',
            toolEvents: [
                {
                    toolCall: {
                        function: {
                            name: 'web-search',
                            arguments: JSON.stringify({ query: 'best project documentation hosts' }),
                        },
                    },
                    reason: 'Deterministic research preflight.',
                    result: {
                        success: true,
                        toolId: 'web-search',
                        data: {
                            query: 'best project documentation hosts',
                            results: [
                                {
                                    title: 'Docs hosting comparison',
                                    url: 'https://example.com/docs-hosting',
                                    snippet: 'Compares Vercel, Cloudflare Pages, Netlify, and GitHub Pages for docs sites.',
                                    source: 'example.com',
                                },
                            ],
                        },
                    },
                },
                {
                    toolCall: {
                        function: {
                            name: 'web-fetch',
                            arguments: JSON.stringify({ url: 'https://example.com/docs-hosting' }),
                        },
                    },
                    reason: 'Deterministic research follow-up on a top search result.',
                    result: {
                        success: true,
                        toolId: 'web-fetch',
                        data: {
                            url: 'https://example.com/docs-hosting',
                            body: '<html><head><title>Docs hosting comparison</title></head><body><main>Vercel offers fast previews, Cloudflare Pages is cost-efficient, Netlify is strong for workflow integrations, and GitHub Pages remains the simplest static option.</main></body></html>',
                        },
                    },
                },
            ],
        });

        const text = response.output[0].content[0].text;
        expect(text).toContain('Research dossier:');
        expect(text).toContain('Docs hosting comparison');
        expect(text).toContain('Search snippet: Compares Vercel, Cloudflare Pages, Netlify, and GitHub Pages for docs sites.');
        expect(text).toContain('Verified extract: Vercel offers fast previews, Cloudflare Pages is cost-efficient, Netlify is strong for workflow integrations, and GitHub Pages remains the simplest static option.');
    });

    test('tool synthesis unwraps assistant content arrays with stringified output_text payloads', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'resp_wrapped_synthesis',
                model: 'gpt-test',
                choices: [{
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'think',
                                think: 'Internal reasoning that should stay hidden.',
                            },
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    output_text: 'Remote build is reachable, Docker is installed, and BuildKit is not fully confirmed yet.',
                                    finish_reason: 'stop',
                                }),
                            },
                        ],
                    },
                }],
                metadata: {},
            }),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        const response = await orchestrator.buildFinalResponse({
            input: 'Can you check if remote build is on?',
            objective: 'Can you check if remote build is on?',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-command',
                    },
                },
                reason: 'Fallback for explicit server or remote-build intent.',
                result: {
                    success: true,
                    data: {
                        stdout: 'ubuntu-32gb-fsn1-2',
                    },
                },
            }],
        });

        const text = response.output[0].content[0].text;
        expect(text).toBe('Remote build is reachable, Docker is installed, and BuildKit is not fully confirmed yet.');
        expect(text).not.toContain('Based on the verified tool results');
    });

    test('tool synthesis retries with a compact prompt before falling back to backend placeholder text', async () => {
        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce({
                    id: 'resp_empty_tool_synthesis',
                    model: 'gpt-test',
                    choices: [{ message: {} }],
                    metadata: {},
                })
                .mockResolvedValueOnce(buildResponse('The remote host is reachable, but Docker is not installed.', 'resp_compact_retry')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        const response = await orchestrator.buildFinalResponse({
            input: 'Check the remote host.',
            objective: 'Check the remote host.',
            contextMessages: ['Remembered context that should not be needed for the retry.'],
            recentMessages: [{ role: 'assistant', content: 'Earlier transcript' }],
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-command',
                    },
                },
                reason: 'Check the host for Docker availability.',
                result: {
                    success: true,
                    data: {
                        stdout: 'docker: command not found',
                        host: '10.0.0.5:22',
                    },
                },
            }],
        });

        const text = response.output[0].content[0].text;
        expect(text).toBe('The remote host is reachable, but Docker is not installed.');
        expect(text).not.toContain('Based on the verified tool results');
        expect(llmClient.createResponse).toHaveBeenCalledTimes(2);
        expect(llmClient.createResponse.mock.calls[1][0]).toEqual(expect.objectContaining({
            instructions: 'Return plain user-facing text only.',
            contextMessages: [],
            recentMessages: [],
        }));
    });

    test('tool synthesis retries compact prompt when provider fallback chain returns a blank completion error', async () => {
        const providerError = new Error('500 Model execution failed after fallback chain: gpt-5.5 -> gpt-5.4. Last error: Provider returned a blank assistant completion.');
        providerError.code = 'provider_error';
        const llmClient = {
            createResponse: jest.fn()
                .mockRejectedValueOnce(providerError)
                .mockResolvedValueOnce(buildResponse('Final product synthesized from verified research.', 'resp_compact_after_provider_error')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        const response = await orchestrator.buildFinalResponse({
            input: 'Research this and make the finished page.',
            objective: 'Research this and make the finished page.',
            reasoningEffort: 'high',
            contextMessages: ['Large previous context that should be dropped for compact retry.'],
            recentMessages: [{ role: 'assistant', content: 'Earlier transcript' }],
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'web-search',
                    },
                },
                reason: 'Research current options.',
                result: {
                    success: true,
                    toolId: 'web-search',
                    data: {
                        query: 'verified mower options',
                        results: [{
                            title: 'Verified mower option',
                            url: 'https://example.com/mower',
                            snippet: 'A verified option from a nearby retailer.',
                        }],
                    },
                },
            }],
        });

        const text = response.output[0].content[0].text;
        expect(text).toBe('Final product synthesized from verified research.');
        expect(llmClient.createResponse).toHaveBeenCalledTimes(2);
        expect(llmClient.createResponse.mock.calls[1][0]).toEqual(expect.objectContaining({
            input: expect.stringContaining('Write the final user-facing answer using only these verified tool results.'),
            instructions: 'Return plain user-facing text only.',
            contextMessages: [],
            recentMessages: [],
            reasoningEffort: 'low',
        }));
    });

    test('tool synthesis prompt explicitly forbids wrapped JSON answers', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Plain tool synthesis answer', 'resp_tool_synthesis_prompt')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        await orchestrator.buildFinalResponse({
            input: 'Can you check if remote build is on?',
            objective: 'Can you check if remote build is on?',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-command',
                    },
                },
                result: {
                    success: true,
                    data: {
                        stdout: 'ubuntu-32gb-fsn1-2',
                    },
                },
            }],
        });

        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.stringContaining('Return plain user-facing text only.'),
        }));
        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.stringContaining('`output_text`'),
        }));
    });

    test('notes tool synthesis prompt allows notes-actions after verified tool use', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('{"assistant_reply":"Built the cats and dogs page.","actions":[]}', 'resp_notes_tool_synthesis_prompt')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        await orchestrator.buildFinalResponse({
            input: 'Finish building up this page on cats and dogs.',
            objective: 'Finish building up this page on cats and dogs.',
            taskType: 'notes',
            executionProfile: 'notes',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'web-search',
                    },
                },
                result: {
                    success: true,
                    data: {
                        query: 'cats and dogs',
                        results: [],
                    },
                },
            }],
        });

        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.stringContaining('you may return a valid `notes-actions` JSON payload'),
        }));
        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.stringContaining('Do not stop to ask the user for raw search output or a manual source dump'),
        }));
        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.not.stringContaining('Return plain user-facing text only.'),
        }));
    });

    test('notes tool synthesis compact retry keeps notes-actions instructions', async () => {
        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce({
                    id: 'resp_empty_notes_tool_synthesis',
                    model: 'gpt-test',
                    choices: [{ message: {} }],
                    metadata: {},
                })
                .mockResolvedValueOnce(buildResponse('{"assistant_reply":"Built the cats and dogs page.","actions":[]}', 'resp_notes_compact_retry')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        await orchestrator.buildFinalResponse({
            input: 'Finish building up this page on cats and dogs.',
            objective: 'Finish building up this page on cats and dogs.',
            taskType: 'notes',
            executionProfile: 'notes',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'web-search',
                    },
                },
                result: {
                    success: true,
                    data: {
                        query: 'cats and dogs',
                        results: [],
                    },
                },
            }],
        });

        expect(llmClient.createResponse).toHaveBeenCalledTimes(2);
        expect(llmClient.createResponse.mock.calls[1][0]).toEqual(expect.objectContaining({
            instructions: 'Return only a valid `notes-actions` payload or page-ready notes content for the current notes page.',
            contextMessages: [],
            recentMessages: [],
        }));
        expect(llmClient.createResponse.mock.calls[1][0].input).toContain('return only a valid `notes-actions` payload or page-ready notes content');
        expect(llmClient.createResponse.mock.calls[1][0].input).toContain('If verified research is incomplete, still build the page structure');
    });

    test('tool synthesis prompt uses compact verified findings instead of raw tool result json blobs', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Compact synthesis answer', 'resp_compact_prompt')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        const largeStdout = `${'A'.repeat(16000)} docker missing`;

        await orchestrator.buildFinalResponse({
            input: 'Check the remote host.',
            objective: 'Check the remote host.',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-command',
                    },
                },
                reason: 'Inspect Docker availability.',
                result: {
                    success: true,
                    data: {
                        stdout: largeStdout,
                        host: '10.0.0.5:22',
                    },
                },
            }],
        });

        const prompt = llmClient.createResponse.mock.calls[0][0].input;
        expect(prompt).toContain('Verified tool results:');
        expect(prompt).toContain('- remote-command: succeeded');
        expect(prompt).toContain('docker missing');
        expect(prompt).not.toContain('"stdout"');
        expect(prompt.length).toBeLessThan(30000);
    });

    test('tool synthesis keeps remote-cli-agent final output useful instead of clipping to a tiny preview', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote CLI answer', 'resp_remote_cli_synthesis')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });
        const finalOutput = [
            'START: remote agent completed the build and began verification.',
            'x'.repeat(26000),
            'END_SENTINEL: final verification failed because the TLS ingress returned 404.',
            'BLOCKER=Fix the ingress host rule.',
            'REMOTE_CLI_SESSION_ID=remote-session-9',
        ].join('\n');

        await orchestrator.buildFinalResponse({
            input: 'What happened in the remote agent run?',
            objective: 'What happened in the remote agent run?',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-cli-agent',
                    },
                },
                reason: 'Run the remote coding agent.',
                result: {
                    success: true,
                    toolId: 'remote-cli-agent',
                    data: {
                        finalOutput,
                        sessionId: 'remote-session-9',
                        cwd: '/srv/apps/site',
                        completionStatus: 'blocked',
                    },
                },
            }],
        });

        const prompt = llmClient.createResponse.mock.calls[0][0].input;
        expect(prompt).toContain('START: remote agent completed the build');
        expect(prompt).toContain('END_SENTINEL: final verification failed');
        expect(prompt).toContain('remote session: remote-session-9');
        expect(prompt).not.toContain('[truncated');
    });

    test('tool synthesis summarizes structured remote-cli-agent results without marker dumps', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote CLI answer', 'resp_remote_cli_structured')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        await orchestrator.buildFinalResponse({
            input: 'Can you remote cli agent into our server?',
            objective: 'Can you remote cli agent into our server?',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-cli-agent',
                    },
                },
                result: {
                    success: true,
                    toolId: 'remote-cli-agent',
                    data: {
                        finalOutput: [
                            'REMOTE_AGENT_RESULT=chat-output-clean:/srv/apps/my-app',
                            'WORKSPACE=/srv/apps/my-app',
                            'VERIFY_COMMANDS=pwd; hostname',
                            'VERIFY_RESULTS=pass: pwd returned /srv/apps/my-app; hostname returned ubuntu-32gb-fsn1-1',
                            'REMOTE_CLI_JOB_ID=rcli_clean',
                            'WHAT_CHANGED=verified remote CLI workspace access only',
                            'PUBLIC_URL=not_available',
                            'BLOCKER=none',
                        ].join('\n'),
                        remoteCodeJobId: 'rcli_clean',
                        cwd: '/srv/apps/my-app',
                        whatChanged: 'verified remote CLI workspace access only',
                        verifyCommands: ['pwd; hostname'],
                        verifyResults: ['pass: pwd returned /srv/apps/my-app; hostname returned ubuntu-32gb-fsn1-1'],
                        completionStatus: 'complete',
                    },
                },
            }],
        });

        const prompt = llmClient.createResponse.mock.calls[0][0].input;
        expect(prompt).toContain('Remote CLI task completed.');
        expect(prompt).toContain('Workspace: /srv/apps/my-app.');
        expect(prompt).toContain('Verification results: pass: pwd returned /srv/apps/my-app; hostname returned ubuntu-32gb-fsn1-1.');
        expect(prompt).not.toContain('REMOTE_AGENT_RESULT=');
        expect(prompt).not.toContain('VERIFY_COMMANDS=');
        expect(prompt).not.toContain('"type":"thread.started"');
    });

    test('tool synthesis prefers a completed remote-cli-agent result over a later running blocker', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote CLI answer', 'resp_remote_cli_complete_wins')),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        await orchestrator.buildFinalResponse({
            input: 'Use remote-cli-agent for a passthrough proof.',
            objective: 'Use remote-cli-agent for a passthrough proof.',
            toolEvents: [
                {
                    toolCall: { function: { name: 'remote-cli-agent' } },
                    result: {
                        success: true,
                        toolId: 'remote-cli-agent',
                        data: {
                            remoteCodeJobId: 'rcli_running_first',
                            cwd: '/opt/kimibuilt',
                            blocker: 'remote_code_run still running; continue with the returned remote job id',
                            completionStatus: 'blocked',
                        },
                    },
                },
                {
                    toolCall: { function: { name: 'remote-cli-agent' } },
                    result: {
                        success: true,
                        toolId: 'remote-cli-agent',
                        data: {
                            remoteCodeJobId: 'rcli_completed',
                            cwd: '/opt/kimibuilt',
                            whatChanged: 'read-only passthrough proof only',
                            verifyCommands: ['hostname && pwd'],
                            verifyResults: ['pass_printed_hostname_and_pwd'],
                            blocker: null,
                            completionStatus: 'complete',
                        },
                    },
                },
                {
                    toolCall: { function: { name: 'remote-cli-agent' } },
                    result: {
                        success: true,
                        toolId: 'remote-cli-agent',
                        data: {
                            remoteCodeJobId: 'rcli_running_last',
                            cwd: '/opt/kimibuilt',
                            blocker: 'remote_code_run still running; continue with the returned remote job id',
                            completionStatus: 'blocked',
                        },
                    },
                },
            ],
        });

        const prompt = llmClient.createResponse.mock.calls[0][0].input;
        const authoritativeIndex = prompt.indexOf('Authoritative remote-cli-agent result');
        const completeIndex = prompt.indexOf('Remote CLI task completed.');
        const blockedIndex = prompt.indexOf('Remote CLI task is blocked.');

        expect(authoritativeIndex).toBeGreaterThanOrEqual(0);
        expect(completeIndex).toBeGreaterThan(authoritativeIndex);
        expect(prompt).toContain('Remote job id: rcli_completed.');
        expect(prompt).toContain('All verified tool results:');
        expect(blockedIndex).toBeGreaterThan(completeIndex);
    });

    test('rewrites remote-cli-agent marker dump synthesis output before returning it', async () => {
        const markerDump = [
            'WORKSPACE=/srv/apps/my-app',
            'WHAT_CHANGED=verified pwd and hostname only; no files changed',
            'VERIFY_COMMANDS=pwd; hostname',
            'VERIFY_RESULTS=pass: pwd=/srv/apps/my-app, hostname=ubuntu-32gb-fsn1-1',
            'REMOTE_CLI_JOB_ID=rcli_marker',
            'PUBLIC_URL=not_available',
            'BLOCKER=none',
            'REMOTE_CLI_TARGET=k3s-prod',
        ].join('\n');
        const markerDumpResponse = {
            ...buildResponse(markerDump, 'resp_remote_cli_marker_dump'),
            output_text: markerDump,
            choices: [{
                message: {
                    role: 'assistant',
                    content: markerDump,
                },
            }],
        };
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(markerDumpResponse),
            complete: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: null,
            sessionStore: null,
            memoryService: null,
        });

        const response = await orchestrator.buildFinalResponse({
            input: 'Can you remote cli agent into our server?',
            objective: 'Can you remote cli agent into our server?',
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'remote-cli-agent',
                    },
                },
                result: {
                    success: true,
                    toolId: 'remote-cli-agent',
                    data: {
                        finalOutput: markerDump,
                        remoteCodeJobId: 'rcli_marker',
                        cwd: '/srv/apps/my-app',
                        whatChanged: 'verified pwd and hostname only; no files changed',
                        verifyCommands: ['pwd; hostname'],
                        verifyResults: ['pass: pwd=/srv/apps/my-app, hostname=ubuntu-32gb-fsn1-1'],
                        publicUrl: 'not_available',
                        blocker: 'none',
                        completionStatus: 'complete',
                    },
                },
            }],
        });

        const text = response.output[0].content[0].text;
        expect(text).toContain('Remote CLI task completed.');
        expect(text).toContain('Workspace: /srv/apps/my-app.');
        expect(text).toContain('Verification results: pass: pwd=/srv/apps/my-app, hostname=ubuntu-32gb-fsn1-1.');
        expect(text).not.toContain('WORKSPACE=');
        expect(text).not.toContain('VERIFY_COMMANDS=');
        expect(text).not.toContain('REMOTE_CLI_JOB_ID=');
        expect(response.output_text).toContain('Remote CLI task completed.');
        expect(response.output_text).not.toContain('WORKSPACE=');
        expect(response.choices[0].message.content).toContain('Remote CLI task completed.');
        expect(response.choices[0].message.content).not.toContain('WORKSPACE=');
        expect(response.metadata.remoteCliMarkerDumpRewritten).toBe(true);
    });

    test('recovers missing file-write content from recent assistant html when the planner omits it', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Saved the HTML file.', 'resp_file_write')),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'file-write',
                        reason: 'Write the previously prepared Cuba/beaches HTML into a file in /app, since the user asked to go ahead with the HTML file.',
                        params: {
                            path: '/app/cuba-beaches.html',
                        },
                    },
                ],
            })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolId === 'file-write'
                    ? { id: toolId, description: 'Write a file' }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'file-write',
                data: {
                    path: '/app/cuba-beaches.html',
                    bytesWritten: 84,
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({
                id: 'session-file-write',
                metadata: {},
            }),
            getRecentMessages: jest.fn().mockResolvedValue([
                {
                    role: 'assistant',
                    content: [
                        'Here is the full HTML:',
                        '```html',
                        '<!DOCTYPE html>',
                        '<html>',
                        '<body>',
                        '<h1>Cuba Beaches</h1>',
                        '<p>Warm water and bright sand.</p>',
                        '</body>',
                        '</html>',
                        '```',
                    ].join('\n'),
                },
            ]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Go ahead and save that Cuba beaches HTML file to /app/cuba-beaches.html.',
            sessionId: 'session-file-write',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'file-write',
            expect.objectContaining({
                path: '/app/cuba-beaches.html',
                content: expect.stringContaining('<h1>Cuba Beaches</h1>'),
            }),
            expect.objectContaining({
                executionProfile: 'default',
                sessionId: 'session-file-write',
            }),
        );
        expect(result.output).toBe('Saved the HTML file.');
    });

    test('plans and executes remote-build tool steps explicitly', async () => {
        const originalSingleRoundStop = config.runtime.remoteBuildConfigDefaultSingleRoundStop;
        config.runtime.remoteBuildConfigDefaultSingleRoundStop = true;

        try {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Deployment is healthy.', 'resp_remote')),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'remote-command',
                        reason: 'Inspect service state on the remote host',
                        params: {
                            command: 'hostname && uptime',
                        },
                    },
                ],
            })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'host-a\nup 10 days',
                    stderr: '',
                    host: '10.0.0.5:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'SSH into the remote server and check the deployment.',
            sessionId: 'session-remote',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(llmClient.complete).toHaveBeenCalledTimes(1);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: 'hostname && uptime',
            }),
            expect.objectContaining({
                executionProfile: 'remote-build',
                sessionId: 'session-remote',
            }),
        );
        expect(result.response.metadata.toolEvents).toHaveLength(1);
        expect(result.response.metadata.executionProfile).toBe('remote-build');
        expect(result.output).toBe('Deployment is healthy.');
        } finally {
            config.runtime.remoteBuildConfigDefaultSingleRoundStop = originalSingleRoundStop;
        }
    });

    test('remote-build status questions run remote-command instead of completing from memory', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote server health checked.', 'resp_remote_health')),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'host-a\nup 10 days\nFilesystem      Size  Used Avail Use% Mounted on',
                    stderr: '',
                    host: '10.0.0.5:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote-health', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'hows the remote server?',
            sessionId: 'session-remote-health',
            executionProfile: 'remote-build',
            stream: false,
            metadata: {
                remoteBuildAutonomyApproved: true,
                clientSurface: 'web-chat',
            },
            toolContext: {
                clientSurface: 'web-chat',
            },
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: 'hostname && uptime && (df -h / || true) && (free -m || true)',
            }),
            expect.objectContaining({
                executionProfile: 'remote-build',
                sessionId: 'session-remote-health',
            }),
        );
        expect(result.response.metadata.harness.completion.criteria.map((criterion) => criterion.text)).toEqual(['Inspection completed']);
        expect(result.response.metadata.harness.completion.finishReason).not.toBe('no_explicit_completion_criteria');
        expect(result.response.metadata.harness.completion.unmetCriteria).toEqual([]);
        expect(result.output).toBe('Remote server health checked.');
    });

    test('pins remote-build remote-command steps to the trusted SSH target when the planner invents a bogus host', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '162.55.163.199',
            port: 22,
            username: 'root',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('The remote apply step ran on the configured server.', 'resp_remote_pinned_host')),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'remote-command',
                        reason: 'Apply the fetched HTML to the live ConfigMap.',
                        params: {
                            host: 'web-fetch.body',
                            command: 'kubectl apply -f /tmp/website-html.yaml',
                        },
                    },
                ],
            })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'configmap/website-html configured',
                    stderr: '',
                    host: '162.55.163.199:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({
                id: 'session-remote-pinned-host',
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: '162.55.163.199',
                        username: 'root',
                        port: 22,
                    },
                },
            }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'Replace the deployed HTML on the remote server and restart the website workload.',
            sessionId: 'session-remote-pinned-host',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                host: '162.55.163.199',
                username: 'root',
                port: 22,
                command: 'kubectl apply -f /tmp/website-html.yaml',
            }),
            expect.any(Object),
        );
    });

    test('repairs invalid final responses that deny remote tools after successful remote execution', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce(buildResponse(
                    'I successfully connected to your server, but I don\'t have any remote execution tools available in this turn to run more commands.',
                    'resp_invalid_remote',
                ))
                .mockResolvedValueOnce(buildResponse(
                    'I connected to the server and completed the verified remote check. If you want me to continue, I need the next concrete server task rather than assuming tool access is missing.',
                    'resp_repaired_remote',
                )),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'host-a\naarch64\nup 2 days',
                    stderr: '',
                    host: '10.0.0.5:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Use remote-build to inspect the server.',
            sessionId: 'session-remote',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: expect.stringContaining('uname -m'),
            }),
            expect.objectContaining({
                executionProfile: 'remote-build',
                sessionId: 'session-remote',
            }),
        );
        expect(toolManager.executeTool.mock.calls[0][1].command).toContain('/etc/os-release');
        expect(llmClient.createResponse).toHaveBeenCalledTimes(2);
        expect(llmClient.createResponse.mock.calls[1][0]).toEqual(expect.objectContaining({
            enableAutomaticToolCalls: false,
        }));
        expect(result.output).toBe('I connected to the server and completed the verified remote check. If you want me to continue, I need the next concrete server task rather than assuming tool access is missing.');
    });

    test('repairs invalid final responses that surface bare remote-command JSON payloads', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const leakedPayload = [
            'Good - I can see the host is alive. Let me fix this cleanly.',
            '```json',
            JSON.stringify({
                command: 'kubectl get pods -n kimibuilt -o wide',
                hostname: '10.0.0.5',
                port: 22,
                username: 'ubuntu',
            }, null, 2),
            '```',
        ].join('\n');
        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce(buildResponse(leakedPayload, 'resp_invalid_bare_remote_payload'))
                .mockResolvedValueOnce(buildResponse(
                    'The remote pod inspection ran and found the backend pod running, but public ingress still needs verification.',
                    'resp_repaired_bare_remote_payload',
                )),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'backend-7d9c4dfc5b-abcde 1/1 Running',
                    stderr: '',
                    host: '10.0.0.5:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-bare-remote-payload', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'SSH into 10.0.0.5 and run kubectl get pods -n kimibuilt -o wide.',
            sessionId: 'session-bare-remote-payload',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: 'kubectl get pods -n kimibuilt -o wide',
            }),
            expect.objectContaining({
                sessionId: 'session-bare-remote-payload',
            }),
        );
        expect(llmClient.createResponse).toHaveBeenCalledTimes(2);
        expect(result.output).toBe('The remote pod inspection ran and found the backend pod running, but public ingress still needs verification.');
    });

    test('recovers leaked DSML remote-command tool calls by executing them', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const leakedPayload = [
            'I will SSH into the server, inspect the Sophia coloring book site, update the pages with the new coloring content, and verify the deployment.',
            '<｜DSML｜tool_calls>',
            '<｜DSML｜invoke name="remote-command">',
            '<｜DSML｜parameter name="host" string="true">162.55.163.199</｜DSML｜parameter>',
            '<｜DSML｜parameter name="username" string="true">root</｜DSML｜parameter>',
            '<｜DSML｜parameter name="command" string="true">ls -la /opt/sophia-color-world/ && cat /opt/sophia-color-world/index.html</｜DSML｜parameter>',
            '</｜DSML｜invoke>',
            '</｜DSML｜tool_calls>',
        ].join('\n');
        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce(buildResponse(leakedPayload, 'resp_invalid_dsml_remote_payload'))
                .mockResolvedValueOnce(buildResponse(
                    'The remote Sophia site inspection ran and returned the current index.html, so the next step is to apply the requested content changes.',
                    'resp_repaired_dsml_remote_payload',
                )),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: '<!doctype html><title>Sophia Color World</title>',
                    stderr: '',
                    host: '162.55.163.199:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-dsml-remote-payload', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'SSH into 162.55.163.199 and run the command from the leaked DSML block.',
            sessionId: 'session-dsml-remote-payload',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                host: '162.55.163.199',
                username: 'root',
                command: 'ls -la /opt/sophia-color-world/ && cat /opt/sophia-color-world/index.html',
            }),
            expect.objectContaining({
                sessionId: 'session-dsml-remote-payload',
                executionProfile: 'remote-build',
            }),
        );
        expect(llmClient.createResponse).toHaveBeenCalledTimes(2);
        expect(result.output).toBe('The remote Sophia site inspection ran and returned the current index.html, so the next step is to apply the requested content changes.');
    });

    test('recovers leaked Harmony remote-command tool calls by executing them', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const leakedPayload = [
            'Let me inspect the current Calan deployment.',
            '<tool_call>remote-command <arg_key>command</arg_key><arg_value>kubectl get ingress -n web calan-calendar -o wide</arg_value></tool_call>',
        ].join('\n');
        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce(buildResponse(leakedPayload, 'resp_invalid_harmony_remote_payload'))
                .mockResolvedValueOnce(buildResponse(
                    'The Calan ingress inspection ran and confirmed the route points at the calendar service.',
                    'resp_repaired_harmony_remote_payload',
                )),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'calan.demoserver2.buzz   calan-calendar   80',
                    stderr: '',
                    host: '10.0.0.5:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-harmony-remote-payload', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Inspect the Calan ingress route on the server.',
            sessionId: 'session-harmony-remote-payload',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: 'kubectl get ingress -n web calan-calendar -o wide',
            }),
            expect.objectContaining({
                sessionId: 'session-harmony-remote-payload',
                executionProfile: 'remote-build',
            }),
        );
        expect(llmClient.createResponse).toHaveBeenCalledTimes(2);
        expect(result.output).toBe('The Calan ingress inspection ran and confirmed the route points at the calendar service.');
    });

    test('recovers leaked Harmony tool-doc-read calls by executing the documented tool', async () => {
        const leakedPayload = 'Let me load the docs. <tool_call>tool-doc-read <arg_key>title</arg_key><arg_value>k3s-deploy</arg_value></tool_call>';
        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce(buildResponse(leakedPayload, 'resp_invalid_harmony_tool_doc'))
                .mockResolvedValueOnce(buildResponse(
                    'Loaded the k3s-deploy docs and can continue with the deploy flow.',
                    'resp_repaired_harmony_tool_doc',
                )),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['tool-doc-read', 'remote-command']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'tool-doc-read',
                data: {
                    toolId: 'k3s-deploy',
                    content: 'k3s deploy documentation',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-harmony-tool-doc', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'Use the k3s-deploy docs before deploying.',
            sessionId: 'session-harmony-tool-doc',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'tool-doc-read',
            expect.objectContaining({
                toolId: 'k3s-deploy',
            }),
            expect.objectContaining({
                sessionId: 'session-harmony-tool-doc',
            }),
        );
    });

    test('repairs invalid final responses that surface serialized tool-call wrapper payloads', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce(buildResponse(
                    JSON.stringify({
                        output_text: '',
                        tool_calls: [{
                            id: 'rc_1',
                            name: 'remote-command',
                            arguments: {
                                host: '10.0.0.5',
                                username: 'ubuntu',
                                command: 'kubectl get pods -n kimibuilt -o wide',
                            },
                        }],
                        finish_reason: 'tool_calls',
                    }),
                    'resp_invalid_tool_wrapper',
                ))
                .mockResolvedValueOnce(buildResponse(
                    'The remote inspection ran, but the deployment is not verified yet. The cluster status still needs ingress, DNS, and HTTPS validation before it can be called live.',
                    'resp_repaired_tool_wrapper',
                )),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'backend-7d9c4dfc5b-abcde 1/1 Running',
                    stderr: '',
                    host: '10.0.0.5:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-tool-wrapper', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Use remote-build to inspect the penguin deployment.',
            sessionId: 'session-tool-wrapper',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(llmClient.createResponse).toHaveBeenCalledTimes(2);
        expect(result.output).toBe('The remote inspection ran, but the deployment is not verified yet. The cluster status still needs ingress, DNS, and HTTPS validation before it can be called live.');
    });

    test('recovers bwrap sandbox failures for public deployment checks through remote-command', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '168.119.176.121',
            port: 22,
            username: 'root',
            password: '',
            privateKeyPath: '/home/kimibuilt/.ssh/id_ed25519',
        });

        const llmClient = {
            createResponse: jest.fn()
                .mockResolvedValueOnce(buildResponse(
                    'I could not complete a fresh check from this runtime. The remote inspection command failed before SSH could start with: bwrap: No permissions to create a new namespace. Last known server state says awesome.demoserver2.buzz returned HTTP 502.',
                    'resp_bwrap_invalid',
                ))
                .mockResolvedValueOnce(buildResponse(
                    'I reran the check through remote-command and inspected the k3s ingress, service, pods, and public URL.',
                    'resp_bwrap_repaired',
                )),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'awesome.demoserver2.buzz tetris-site 1/1 Running HTTP/2 502',
                    stderr: '',
                    host: '168.119.176.121:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-bwrap-recovery', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Check why awesome.demoserver2.buzz is still returning 502 for the deployed Tetris site.',
            sessionId: 'session-bwrap-recovery',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: expect.stringContaining('awesome.demoserver2.buzz'),
            }),
            expect.objectContaining({
                sessionId: 'session-bwrap-recovery',
            }),
        );
        const command = toolManager.executeTool.mock.calls[0][1].command;
        expect(command).toContain('kubectl get ingress -A');
        expect(command).toContain('kubectl get deploy,svc,pods,ingress,certificate');
        expect(command).toContain('curl -kfsSIL');
        expect(result.output).toContain('remote-command');
    });

    test('continues through multiple remote-build rounds after broad user approval', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Cluster inspection completed and the obvious next checks were run.', 'resp_auto')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [
                        {
                            tool: 'remote-command',
                            reason: 'Check node status first',
                            params: {
                                command: 'kubectl get nodes -o wide',
                            },
                        },
                    ],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [
                        {
                            tool: 'remote-command',
                            reason: 'Check pods after confirming nodes',
                            params: {
                                command: 'kubectl get pods -A -o wide',
                            },
                        },
                    ],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'node-1 Ready',
                        stderr: '',
                        host: '10.0.0.5:22',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'kube-system traefik Running',
                        stderr: '',
                        host: '10.0.0.5:22',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-remote', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Use remote-build to inspect the cluster and keep going with the obvious next steps.',
            sessionId: 'session-remote',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(llmClient.complete).toHaveBeenCalledTimes(3);
        expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            1,
            'remote-command',
            expect.objectContaining({ command: 'kubectl get nodes -o wide' }),
            expect.objectContaining({ executionProfile: 'remote-build' }),
        );
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            2,
            'remote-command',
            expect.objectContaining({ command: 'kubectl get pods -A -o wide' }),
            expect.objectContaining({ executionProfile: 'remote-build' }),
        );
        expect(sessionStore.update).toHaveBeenCalledWith('session-remote', expect.objectContaining({
            metadata: expect.objectContaining({
                remoteBuildAutonomyApproved: true,
            }),
        }));
        expect(result.response.metadata.toolEvents).toHaveLength(2);
        expect(result.response.metadata.executionTrace.map((entry) => entry.name)).toEqual(expect.arrayContaining([
            'Remote-build autonomy approved',
            'Plan round 1',
            'Execution round 1',
            'Plan round 2',
            'Execution round 2',
        ]));
    });

    test('accepts frontend-provided remote-build autonomy approval', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote inspection completed.', 'resp_frontend_auto')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [
                        {
                            tool: 'remote-command',
                            reason: 'Inspect the node first',
                            params: {
                                command: 'hostname && uname -m',
                            },
                        },
                    ],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [
                        {
                            tool: 'remote-command',
                            reason: 'Inspect pods after node verification',
                            params: {
                                command: 'kubectl get pods -A',
                            },
                        },
                    ],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'host-a\naarch64', stderr: '', host: '10.0.0.5:22' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'kube-system traefik Running', stderr: '', host: '10.0.0.5:22' },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-frontend-remote', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-frontend-remote', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'Inspect the cluster state on the server.',
            sessionId: 'session-frontend-remote',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
                clientSurface: 'web-chat',
            },
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
        expect(sessionStore.update).toHaveBeenCalledWith('session-frontend-remote', expect.objectContaining({
            metadata: expect.objectContaining({
                remoteBuildAutonomyApproved: true,
            }),
        }));
    });

    test('defaults remote-build autonomy on from config even without frontend approval metadata', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote inspection completed.', 'resp_default_remote_auto')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [
                        {
                            tool: 'remote-command',
                            reason: 'Inspect the node first',
                            params: {
                                command: 'hostname && uname -m',
                            },
                        },
                    ],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [
                        {
                            tool: 'remote-command',
                            reason: 'Inspect pods after node verification',
                            params: {
                                command: 'kubectl get pods -A',
                            },
                        },
                    ],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'host-a\naarch64', stderr: '', host: '10.0.0.5:22' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'kube-system traefik Running', stderr: '', host: '10.0.0.5:22' },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-config-remote', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-config-remote', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const originalDefault = config.config.runtime.remoteBuildAutonomyDefault;
        config.config.runtime.remoteBuildAutonomyDefault = true;

        try {
            const orchestrator = new ConversationOrchestrator({
                llmClient,
                toolManager,
                sessionStore,
                memoryService,
            });

            const result = await orchestrator.executeConversation({
                input: 'Inspect the cluster state on the server.',
                sessionId: 'session-config-remote',
                executionProfile: 'remote-build',
                stream: false,
            });

            expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
            expect(result.response.metadata.executionTrace.find((entry) => entry.name === 'Remote-build autonomy approved')).toMatchObject({
                details: expect.objectContaining({
                    approved: true,
                    source: 'config',
                }),
            });
        } finally {
            config.config.runtime.remoteBuildAutonomyDefault = originalDefault;
        }
    });

    test('continues beyond the old three-round cap while remote-build work is still making progress', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote work completed after multiple autonomous rounds.', 'resp_long_auto')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{ tool: 'remote-command', reason: 'Round 1', params: { command: 'echo round-1' } }],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{ tool: 'remote-command', reason: 'Round 2', params: { command: 'echo round-2' } }],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{ tool: 'remote-command', reason: 'Round 3', params: { command: 'echo round-3' } }],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{ tool: 'remote-command', reason: 'Round 4', params: { command: 'echo round-4' } }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'round-1', stderr: '', host: '10.0.0.5:22' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'round-2', stderr: '', host: '10.0.0.5:22' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'round-3', stderr: '', host: '10.0.0.5:22' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { stdout: 'round-4', stderr: '', host: '10.0.0.5:22' },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-long-remote', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-long-remote', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Use remote-build to keep going until the server work is done.',
            sessionId: 'session-long-remote',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(4);
        expect(llmClient.complete).toHaveBeenCalledTimes(5);
        expect(result.response.metadata.toolEvents).toHaveLength(4);
        expect(result.response.metadata.executionTrace.map((entry) => entry.name)).toEqual(expect.arrayContaining([
            'Plan round 4',
            'Execution round 4',
        ]));
    });

    test('stops autonomous remote-build work within a round when the time budget is exhausted', async () => {
        const originalMaxMs = config.runtime.remoteBuildMaxAutonomousMs;
        const nowSpy = jest.spyOn(Date, 'now');
        let currentNow = 1760000000000;
        nowSpy.mockImplementation(() => currentNow);
        config.runtime.remoteBuildMaxAutonomousMs = 1000;

        try {
            settingsController.getEffectiveSshConfig.mockReturnValue({
                enabled: true,
                host: '10.0.0.5',
                port: 22,
                username: 'ubuntu',
                password: 'secret',
                privateKeyPath: '',
            });

            const llmClient = {
                createResponse: jest.fn().mockImplementation(async () => {
                    currentNow += 50;
                    return buildResponse('Stopped after the budget ran out during the round.', 'resp_budget_stop');
                }),
                complete: jest.fn().mockImplementation(async () => {
                    currentNow += 100;
                    return JSON.stringify({
                        steps: [
                            {
                                tool: 'remote-command',
                                reason: 'Inspect the ingress first',
                                params: {
                                    command: 'kubectl get ingress -A',
                                },
                            },
                            {
                                tool: 'remote-command',
                                reason: 'Reload nginx after the ingress check',
                                params: {
                                    command: 'sudo nginx -s reload',
                                },
                            },
                        ],
                    });
                }),
            };

            const toolManager = {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
                executeTool: jest.fn().mockImplementation(async () => {
                    currentNow += 1200;
                    return {
                        success: true,
                        toolId: 'remote-command',
                        duration: 1200,
                        data: {
                            stdout: 'ok',
                            stderr: '',
                            host: '10.0.0.5:22',
                        },
                    };
                }),
            };
            const sessionStore = {
                get: jest.fn().mockResolvedValue({ id: 'session-budget-stop', metadata: {} }),
                getOrCreate: jest.fn().mockResolvedValue({ id: 'session-budget-stop', metadata: {} }),
                getRecentMessages: jest.fn().mockResolvedValue([]),
                recordResponse: jest.fn().mockResolvedValue(undefined),
                appendMessages: jest.fn().mockResolvedValue(undefined),
                update: jest.fn().mockResolvedValue(undefined),
            };
            const memoryService = {
                process: jest.fn().mockResolvedValue([]),
                rememberResponse: jest.fn(),
            };

            const orchestrator = new ConversationOrchestrator({
                llmClient,
                toolManager,
                sessionStore,
                memoryService,
            });

            const result = await orchestrator.executeConversation({
                input: 'Use remote-build to keep going through the routine server checks.',
                sessionId: 'session-budget-stop',
                executionProfile: 'remote-build',
                stream: false,
                metadata: {
                    remoteBuildAutonomyApproved: true,
                },
            });

            expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
            expect(result.response.metadata.executionTrace.find((entry) => entry.name === 'Execution round 1')).toMatchObject({
                details: expect.objectContaining({
                    plannedToolCalls: 2,
                    toolCalls: 1,
                    skippedPlannedSteps: 1,
                    budgetExceeded: true,
                }),
            });
            expect(result.response.metadata.executionTrace.find((entry) => entry.name === 'Autonomous execution time budget reached')).toMatchObject({
                details: expect.objectContaining({
                    phase: 'during-round',
                    maxDurationMs: 1000,
                }),
            });
        } finally {
            config.runtime.remoteBuildMaxAutonomousMs = originalMaxMs;
            nowSpy.mockRestore();
        }
    });

    test('adds a yes-no user checkpoint when the autonomous time budget is exhausted on web chat', async () => {
        const originalMaxMs = config.runtime.remoteBuildMaxAutonomousMs;
        const originalContinuationCheckpointEnabled = config.runtime.remoteBuildContinuationCheckpointEnabled;
        const nowSpy = jest.spyOn(Date, 'now');
        let currentNow = 1760001000000;
        nowSpy.mockImplementation(() => currentNow);
        config.runtime.remoteBuildMaxAutonomousMs = 1000;
        config.runtime.remoteBuildContinuationCheckpointEnabled = true;

        try {
            settingsController.getEffectiveSshConfig.mockReturnValue({
                enabled: true,
                host: '10.0.0.5',
                port: 22,
                username: 'ubuntu',
                password: 'secret',
                privateKeyPath: '',
            });

            const llmClient = {
                createResponse: jest.fn(),
                complete: jest.fn().mockImplementation(async () => {
                    currentNow += 100;
                    return JSON.stringify({
                        steps: [
                            {
                                tool: 'remote-command',
                                reason: 'Inspect the ingress first',
                                params: {
                                    command: 'kubectl get ingress -A',
                                },
                            },
                            {
                                tool: 'remote-command',
                                reason: 'Reload nginx after the ingress check',
                                params: {
                                    command: 'sudo nginx -s reload',
                                },
                            },
                        ],
                    });
                }),
            };

            const toolManager = {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox', 'user-checkpoint']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
                executeTool: jest.fn().mockImplementation(async () => {
                    currentNow += 1200;
                    return {
                        success: true,
                        toolId: 'remote-command',
                        duration: 1200,
                        data: {
                            stdout: 'ok',
                            stderr: '',
                            host: '10.0.0.5:22',
                        },
                    };
                }),
            };
            const sessionStore = {
                get: jest.fn().mockResolvedValue({ id: 'session-budget-checkpoint', metadata: {} }),
                getOrCreate: jest.fn().mockResolvedValue({ id: 'session-budget-checkpoint', metadata: {} }),
                getRecentMessages: jest.fn().mockResolvedValue([]),
                recordResponse: jest.fn().mockResolvedValue(undefined),
                appendMessages: jest.fn().mockResolvedValue(undefined),
                update: jest.fn().mockResolvedValue(undefined),
            };
            const memoryService = {
                process: jest.fn().mockResolvedValue([]),
                rememberResponse: jest.fn(),
            };

            const orchestrator = new ConversationOrchestrator({
                llmClient,
                toolManager,
                sessionStore,
                memoryService,
            });

            const result = await orchestrator.executeConversation({
                input: 'Use remote-build to keep going through the routine server checks.',
                sessionId: 'session-budget-checkpoint',
                executionProfile: 'remote-build',
                stream: false,
                metadata: {
                    remoteBuildAutonomyApproved: true,
                    clientSurface: 'web-chat',
                },
                toolContext: {
                    clientSurface: 'web-chat',
                    userCheckpointPolicy: {
                        enabled: true,
                        remaining: 1,
                        pending: null,
                    },
                },
            });

            const checkpointEvent = result.response.metadata.toolEvents.find((event) => (
                (event?.toolCall?.function?.name || event?.result?.toolId || '') === 'user-checkpoint'
            ));

            expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
            expect(llmClient.createResponse).not.toHaveBeenCalled();
            expect(result.output).toContain('Paused');
            expect(result.output).toContain('Status:');
            expect(result.output).toContain('runtime budget');
            expect(checkpointEvent).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    success: true,
                    toolId: 'user-checkpoint',
                    data: expect.objectContaining({
                        checkpoint: expect.objectContaining({
                            title: 'Continue from here?',
                            preamble: expect.stringMatching(/runtime budget[\s\S]*Status:/),
                            whyThisMatters: expect.stringContaining('current progress'),
                            question: 'Do you want me to continue from the current state?',
                            options: expect.arrayContaining([
                                expect.objectContaining({
                                    id: 'continue-now',
                                    label: 'Yes, continue here',
                                    description: expect.stringContaining('without restarting'),
                                }),
                                expect.objectContaining({
                                    id: 'stop-here',
                                    label: 'No, stop here',
                                }),
                            ]),
                        }),
                    }),
                }),
            }));
            expect(result.response.metadata.executionTrace.find((entry) => entry.name === 'Autonomous execution time budget reached')).toMatchObject({
                details: expect.objectContaining({
                    phase: 'during-round',
                }),
            });
        } finally {
            config.runtime.remoteBuildMaxAutonomousMs = originalMaxMs;
            config.runtime.remoteBuildContinuationCheckpointEnabled = originalContinuationCheckpointEnabled;
            nowSpy.mockRestore();
        }
    });

    test('does not replace remote-cli-agent final output with a budget questionnaire', async () => {
        const originalMaxMs = config.runtime.remoteBuildMaxAutonomousMs;
        const originalContinuationCheckpointEnabled = config.runtime.remoteBuildContinuationCheckpointEnabled;
        const nowSpy = jest.spyOn(Date, 'now');
        let currentNow = 1760002000000;
        nowSpy.mockImplementation(() => currentNow);
        config.runtime.remoteBuildMaxAutonomousMs = 1000;
        config.runtime.remoteBuildContinuationCheckpointEnabled = true;

        try {
            settingsController.getEffectiveSshConfig.mockReturnValue({
                enabled: true,
                host: '10.0.0.5',
                port: 22,
                username: 'ubuntu',
                password: 'secret',
                privateKeyPath: '',
            });
            settingsController.getEffectiveOpencodeConfig.mockReturnValue({
                enabled: true,
                binaryPath: 'opencode',
                defaultAgent: 'build',
                defaultModel: 'gpt-4o',
                remoteDefaultWorkspace: '/srv/apps/weather',
                allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
                providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
                remoteAutoInstall: false,
            });

            const llmClient = {
                createResponse: jest.fn().mockResolvedValue(buildResponse('Remote CLI report surfaced as plain text.')),
                complete: jest.fn(),
            };
            const toolManager = {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'web-search', 'tool-doc-read', 'user-checkpoint']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
                executeTool: jest.fn().mockImplementation(async (toolId) => {
                    currentNow += 1500;
                    if (toolId === 'remote-cli-agent') {
                        return {
                            success: true,
                            toolId: 'remote-cli-agent',
                            data: {
                                finalOutput: [
                                    'I need to report the remote run status.',
                                    'USER_INPUT_REQUIRED=Please provide a GitLab token before I can push.',
                                    'REMOTE_CLI_SESSION_ID=remote-session-1',
                                    'BLOCKER=Please provide a GitLab token before I can push.',
                                ].join('\n'),
                                targetId: 'prod',
                                sessionId: 'remote-session-1',
                                blocker: 'Please provide a GitLab token before I can push.',
                                completionStatus: 'blocked',
                            },
                        };
                    }
                    throw new Error(`Unexpected tool: ${toolId}`);
                }),
            };
            const sessionStore = {
                get: jest.fn().mockResolvedValue({ id: 'session-remote-cli-budget', metadata: {} }),
                getOrCreate: jest.fn().mockResolvedValue({ id: 'session-remote-cli-budget', metadata: {} }),
                getRecentMessages: jest.fn().mockResolvedValue([]),
                recordResponse: jest.fn().mockResolvedValue(undefined),
                appendMessages: jest.fn().mockResolvedValue(undefined),
                update: jest.fn().mockResolvedValue(undefined),
            };
            const memoryService = {
                process: jest.fn().mockResolvedValue([]),
                rememberResponse: jest.fn(),
            };

            const orchestrator = new ConversationOrchestrator({
                llmClient,
                toolManager,
                sessionStore,
                memoryService,
            });
            jest.spyOn(orchestrator, 'buildDirectAction').mockReturnValue({
                tool: 'remote-cli-agent',
                reason: 'The request asks the remote CLI agent to report its current result.',
                params: {
                    task: 'Continue the active remote CLI agent task and report the result.',
                    waitMs: 30000,
                    adminMode: true,
                    cwd: '/srv/apps/weather',
                },
            });

            const result = await orchestrator.executeConversation({
                input: 'Use remote cli agent to continue the active app build and deploy.',
                sessionId: 'session-remote-cli-budget',
                executionProfile: 'remote-build',
                stream: false,
                metadata: {
                    remoteBuildAutonomyApproved: true,
                    clientSurface: 'web-chat',
                },
                toolContext: {
                    clientSurface: 'web-chat',
                    userCheckpointPolicy: {
                        enabled: true,
                        remaining: 1,
                        pending: null,
                    },
                    remoteWorkspacePath: '/srv/apps/weather',
                },
            });

            const toolIds = result.response.metadata.toolEvents.map((event) => (
                event?.toolCall?.function?.name || event?.result?.toolId || ''
            ));
            const synthesisParams = llmClient.createResponse.mock.calls.at(-1)?.[0] || {};

            expect(toolManager.executeTool).toHaveBeenCalledWith(
                'remote-cli-agent',
                expect.objectContaining({
                    adminMode: true,
                }),
                expect.any(Object),
            );
            expect(toolIds).toEqual(['remote-cli-agent']);
            expect(result.response.metadata.runtimeMode).not.toBe('budget-checkpoint');
            expect(result.response.metadata.toolEvents).not.toEqual(expect.arrayContaining([
                expect.objectContaining({
                    result: expect.objectContaining({
                        toolId: 'user-checkpoint',
                    }),
                }),
            ]));
            expect(result.output).toContain('Remote CLI report surfaced as plain text.');
            expect(synthesisParams.instructions).toContain('plain user-facing report');
            expect(synthesisParams.instructions).not.toContain('inline popup-style survey card');
        } finally {
            config.runtime.remoteBuildMaxAutonomousMs = originalMaxMs;
            config.runtime.remoteBuildContinuationCheckpointEnabled = originalContinuationCheckpointEnabled;
            nowSpy.mockRestore();
        }
    });

    test('stops the same chat turn after remote-cli-agent completes cleanly', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            remoteDefaultWorkspace: '/srv/apps/weather',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote CLI completed cleanly.')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-cli-agent', 'remote-command', 'web-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-cli-agent',
                data: {
                    remoteCodeJobId: 'rcli_complete_once',
                    cwd: '/srv/apps/weather',
                    whatChanged: 'read-only passthrough proof only',
                    verifyCommands: ['hostname && pwd'],
                    verifyResults: ['pass_printed_hostname_and_pwd'],
                    blocker: null,
                    completionStatus: 'complete',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote-cli-complete', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-remote-cli-complete', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });
        jest.spyOn(orchestrator, 'buildDirectAction').mockReturnValue({
            tool: 'remote-cli-agent',
            reason: 'The request explicitly asks the assisted remote CLI agent to own the remote task.',
            params: {
                task: 'Run a read-only passthrough proof.',
                waitMs: 30000,
                adminMode: true,
                cwd: '/srv/apps/weather',
            },
        });

        const result = await orchestrator.executeConversation({
            input: 'Use remote-cli-agent to run a passthrough proof.',
            sessionId: 'session-remote-cli-complete',
            executionProfile: 'remote-build',
            stream: false,
            metadata: {
                remoteBuildAutonomyApproved: true,
                clientSurface: 'web-chat',
            },
            toolContext: {
                clientSurface: 'web-chat',
                remoteWorkspacePath: '/srv/apps/weather',
            },
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(result.response.metadata.toolEvents).toHaveLength(1);
        expect(result.response.metadata.executionTrace).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: expect.stringContaining('Remote CLI completed after round'),
            }),
        ]));
        expect(result.output).toContain('Remote CLI completed cleanly.');
    });

    test('extends the autonomous round budget when remote-build work is still productive', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const originalRounds = config.config.runtime.remoteBuildMaxAutonomousRounds;
        const originalToolCalls = config.config.runtime.remoteBuildMaxAutonomousToolCalls;
        const originalMaxMs = config.config.runtime.remoteBuildMaxAutonomousMs;
        const originalExtensionUses = config.config.runtime.remoteBuildBudgetExtensionMaxUses;
        const originalExtensionRounds = config.config.runtime.remoteBuildBudgetExtensionRounds;
        const originalExtensionToolCalls = config.config.runtime.remoteBuildBudgetExtensionToolCalls;
        const originalExtensionMs = config.config.runtime.remoteBuildBudgetExtensionMs;

        config.config.runtime.remoteBuildMaxAutonomousRounds = 2;
        config.config.runtime.remoteBuildMaxAutonomousToolCalls = 4;
        config.config.runtime.remoteBuildMaxAutonomousMs = 120000;
        config.config.runtime.remoteBuildBudgetExtensionMaxUses = 1;
        config.config.runtime.remoteBuildBudgetExtensionRounds = 2;
        config.config.runtime.remoteBuildBudgetExtensionToolCalls = 4;
        config.config.runtime.remoteBuildBudgetExtensionMs = 60000;

        try {
            const llmClient = {
                createResponse: jest.fn().mockResolvedValue(buildResponse('Remote work completed after the adaptive round extension.', 'resp_round_extension')),
                complete: jest.fn()
                    .mockResolvedValueOnce(JSON.stringify({
                        steps: [{ tool: 'remote-command', reason: 'Round 1', params: { command: 'echo round-1' } }],
                    }))
                    .mockResolvedValueOnce(JSON.stringify({
                        steps: [{ tool: 'remote-command', reason: 'Round 2', params: { command: 'echo round-2' } }],
                    }))
                    .mockResolvedValueOnce(JSON.stringify({
                        steps: [{ tool: 'remote-command', reason: 'Round 3', params: { command: 'echo round-3' } }],
                    }))
                    .mockResolvedValueOnce(JSON.stringify({
                        steps: [{ tool: 'remote-command', reason: 'Round 4', params: { command: 'echo round-4' } }],
                    }))
                    .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
            };

            const toolManager = {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
                executeTool: jest.fn()
                    .mockResolvedValueOnce({
                        success: true,
                        toolId: 'remote-command',
                        data: { stdout: 'round-1', stderr: '', host: '10.0.0.5:22' },
                    })
                    .mockResolvedValueOnce({
                        success: true,
                        toolId: 'remote-command',
                        data: { stdout: 'round-2', stderr: '', host: '10.0.0.5:22' },
                    })
                    .mockResolvedValueOnce({
                        success: true,
                        toolId: 'remote-command',
                        data: { stdout: 'round-3', stderr: '', host: '10.0.0.5:22' },
                    })
                    .mockResolvedValueOnce({
                        success: true,
                        toolId: 'remote-command',
                        data: { stdout: 'round-4', stderr: '', host: '10.0.0.5:22' },
                    }),
            };
            const sessionStore = {
                get: jest.fn().mockResolvedValue({ id: 'session-round-extension', metadata: {} }),
                getOrCreate: jest.fn().mockResolvedValue({ id: 'session-round-extension', metadata: {} }),
                getRecentMessages: jest.fn().mockResolvedValue([]),
                recordResponse: jest.fn().mockResolvedValue(undefined),
                appendMessages: jest.fn().mockResolvedValue(undefined),
                update: jest.fn().mockResolvedValue(undefined),
            };
            const memoryService = {
                process: jest.fn().mockResolvedValue([]),
                rememberResponse: jest.fn(),
            };

            const orchestrator = new ConversationOrchestrator({
                llmClient,
                toolManager,
                sessionStore,
                memoryService,
            });

            const result = await orchestrator.executeConversation({
                input: 'Keep going on the server until the build work is complete.',
                sessionId: 'session-round-extension',
                executionProfile: 'remote-build',
                stream: false,
            });

            expect(toolManager.executeTool).toHaveBeenCalledTimes(4);
            expect(result.response.metadata.executionTrace.find((entry) => entry.name === 'Autonomous execution budget extended')).toMatchObject({
                details: expect.objectContaining({
                    reason: 'round-limit',
                    addedRounds: 2,
                }),
            });
        } finally {
            config.config.runtime.remoteBuildMaxAutonomousRounds = originalRounds;
            config.config.runtime.remoteBuildMaxAutonomousToolCalls = originalToolCalls;
            config.config.runtime.remoteBuildMaxAutonomousMs = originalMaxMs;
            config.config.runtime.remoteBuildBudgetExtensionMaxUses = originalExtensionUses;
            config.config.runtime.remoteBuildBudgetExtensionRounds = originalExtensionRounds;
            config.config.runtime.remoteBuildBudgetExtensionToolCalls = originalExtensionToolCalls;
            config.config.runtime.remoteBuildBudgetExtensionMs = originalExtensionMs;
        }
    });

    test('continues autonomous remote-build work after a recoverable remote-command failure', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Recovered from the missing service name and kept troubleshooting.', 'resp_recoverable')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Check the expected Gitea service first',
                        params: {
                            command: 'systemctl status gitea --no-pager',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'List matching services after the missing unit failure',
                        params: {
                            command: 'systemctl list-units --type=service --all | grep -i gitea || true',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: false,
                    toolId: 'remote-command',
                    error: 'Unit gitea.service could not be found.',
                    data: {
                        host: '10.0.0.5:22',
                        stderr: 'Unit gitea.service could not be found.',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        host: '10.0.0.5:22',
                        stdout: 'gitea-web.service loaded inactive dead',
                        stderr: '',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-recoverable-remote', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-recoverable-remote', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Use remote-build to troubleshoot Gitea on the server and keep going through the obvious next steps.',
            sessionId: 'session-recoverable-remote',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            1,
            'remote-command',
            expect.objectContaining({ command: 'systemctl status gitea --no-pager' }),
            expect.objectContaining({ executionProfile: 'remote-build' }),
        );
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            2,
            'remote-command',
            expect.objectContaining({ command: 'systemctl list-units --type=service --all | grep -i gitea || true' }),
            expect.objectContaining({ executionProfile: 'remote-build' }),
        );
        expect(result.response.metadata.executionTrace.map((entry) => entry.name)).toContain('Recoverable remote failure after round 1');
        expect(sessionStore.update).toHaveBeenLastCalledWith('session-recoverable-remote', expect.objectContaining({
            metadata: expect.objectContaining({
                lastToolIntent: 'remote-command',
                remoteWorkingState: expect.objectContaining({
                    lastCommand: 'systemctl list-units --type=service --all | grep -i gitea || true',
                    lastCommandSucceeded: true,
                }),
            }),
        }));
    });

    test.skip('managed-app autonomous recovery was deleted from orchestration', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Reinitialized the managed app record and queued the build.', 'resp_managed_app_recoverable')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'managed-app',
                        reason: 'Recover by recreating the managed app control-plane record',
                        params: {
                            action: 'create',
                            name: 'Dog App',
                            prompt: 'Create and deploy the Dog App managed app.',
                            sourcePrompt: 'Create and deploy the Dog App managed app.',
                            requestedAction: 'deploy',
                            deployTarget: 'ssh',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['managed-app', 'remote-command', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: false,
                    toolId: 'managed-app',
                    error: 'Managed app not found.',
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'managed-app',
                    data: {
                        app: {
                            id: 'app-dog',
                            slug: 'dog-app',
                            status: 'building',
                        },
                        buildRun: {
                            id: 'run-dog',
                            buildStatus: 'queued',
                        },
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-managed-app-recoverable', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-managed-app-recoverable', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Use remote-build to deploy the managed app dog-app and keep going through the obvious next steps.',
            sessionId: 'session-managed-app-recoverable',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(toolManager.executeTool.mock.calls[0]).toEqual([
            'managed-app',
            expect.objectContaining({
                action: 'create',
                deployTarget: 'ssh',
                requestedAction: 'deploy',
                slug: 'dog-app',
            }),
            expect.objectContaining({ executionProfile: 'remote-build' }),
        ]);
        expect(toolManager.executeTool.mock.calls).toEqual(expect.arrayContaining([[
            'managed-app',
            expect.objectContaining({
                action: 'create',
                name: 'Dog App',
                deployTarget: 'ssh',
                requestedAction: 'deploy',
            }),
            expect.objectContaining({ executionProfile: 'remote-build' }),
        ]]));
        expect(result.response.metadata.executionTrace.map((entry) => entry.name)).toContain('Recoverable remote failure after round 1');
    });

    test('allows re-running the same remote verification command after an intervening fix', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const verificationCommand = 'curl -IkfsS --max-time 20 https://git.example.com';
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Verified the endpoint again after the restart.', 'resp_reverify')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Verify the endpoint first',
                        params: {
                            command: verificationCommand,
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Restart Gitea before re-checking the endpoint',
                        params: {
                            command: 'sudo systemctl restart gitea-web',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Re-run the same endpoint verification after the restart',
                        params: {
                            command: verificationCommand,
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { host: '10.0.0.5:22', stdout: 'HTTP/2 502', stderr: '' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { host: '10.0.0.5:22', stdout: '', stderr: '' },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: { host: '10.0.0.5:22', stdout: 'HTTP/2 200', stderr: '' },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-reverify-remote', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-reverify-remote', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Use remote-build to troubleshoot Git access on the server and keep going until it works.',
            sessionId: 'session-reverify-remote',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(3);
        expect(toolManager.executeTool.mock.calls[0][1].command).toBe(verificationCommand);
        expect(toolManager.executeTool.mock.calls[1][1].command).toBe('sudo systemctl restart gitea-web');
        expect(toolManager.executeTool.mock.calls[2][1].command).toBe(verificationCommand);
        expect(result.response.metadata.toolEvents).toHaveLength(3);
    });

    test('continues remote website updates when the planner repeats the generic baseline command', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const baselineCommand = "hostname && uname -m && (test -f /etc/os-release && sed -n '1,3p' /etc/os-release || true) && uptime";
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Inspected the deployed website source and kept the remote update moving.', 'resp_remote_website_followup')),
            complete: jest.fn()
                .mockResolvedValueOnce('I should inspect the server first.')
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Repeat the generic server inspection first',
                        params: {
                            command: baselineCommand,
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        host: '10.0.0.5:22',
                        stdout: 'host-a\naarch64\nNAME="Ubuntu"\n 12:00 up 1 day',
                        stderr: '',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        host: '10.0.0.5:22',
                        stdout: '/root/website.html',
                        stderr: '',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote-website-followup', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-remote-website-followup', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Update the website gallery on the cluster to use bikini/swimwear images and restart the workload.',
            sessionId: 'session-remote-website-followup',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
        expect(toolManager.executeTool.mock.calls[0][1].command).toBe(baselineCommand);
        expect(toolManager.executeTool.mock.calls[1][1].command).toContain("test -f /root/website.html");
        expect(toolManager.executeTool.mock.calls[1][1].command).toContain("find /root /srv /var/www -maxdepth 3 -type f");
        expect(result.response.metadata.executionTrace.find((entry) => entry.name === 'Plan round 2')).toMatchObject({
            details: {
                stepCount: 1,
                steps: [
                    expect.objectContaining({
                        tool: 'remote-command',
                    }),
                ],
            },
        });
    });

    test('switches from remote artifact curl failures to local web-fetch and remote apply for website updates', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const artifactUrl = '/api/artifacts/3ee64601-2cb4-43e1-b56b-973bc2856419/download';
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Transferred the generated landing page content through the local runtime and applied it remotely.', 'resp_remote_artifact_transfer')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Replace the placeholder `website-html` ConfigMap content with the generated landing page artifact that the live pod is still missing.',
                        params: {
                            command: `curl -fsSL https://api${artifactUrl}`,
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: false,
                    toolId: 'remote-command',
                    error: 'curl: (6) Could not resolve host: api',
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'web-fetch',
                    data: {
                        status: 200,
                        body: '<!DOCTYPE html><html><body><main>Transferred landing page</main></body></html>',
                        url: `http://localhost:3000${artifactUrl}`,
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'website-html\nindex.html',
                        stderr: '',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote-artifact-transfer', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-remote-artifact-transfer', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Replace the deployed HTML with the generated landing page and publish it online.',
            sessionId: 'session-remote-artifact-transfer',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            instructions: `Generated artifacts:\n- website.html (html) -> ${artifactUrl}`,
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(3);
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            1,
            'remote-command',
            expect.objectContaining({
                command: expect.stringContaining(`https://api${artifactUrl}`),
            }),
            expect.any(Object),
        );
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            2,
            'web-fetch',
            { url: artifactUrl },
            expect.any(Object),
        );
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            3,
            'remote-command',
            expect.objectContaining({
                command: expect.stringContaining('Transferred landing page'),
            }),
            expect.any(Object),
        );
        expect(result.response.metadata.executionTrace.map((entry) => entry.name)).toContain('Recoverable remote failure after round 1');
    });

    test('prefers deterministic remote workload inspection after svc or ingress is treated as a deployment name', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Re-inspected the cluster resources with the corrected Kubernetes command.', 'resp_remote_workload_inspection')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Inspect the website deployment before replacing the live page.',
                        params: {
                            command: 'kubectl get deployment svc ingress -A',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Retry the same website deployment inspection.',
                        params: {
                            command: 'kubectl get deployment svc ingress -A',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: false,
                    toolId: 'remote-command',
                    error: 'Error from server (NotFound): deployments.apps "svc" not found\nError from server (NotFound): deployments.apps "ingress" not found',
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'default   deployment.apps/website\ndefault   service/website\ndefault   ingress.networking.k8s.io/website',
                        stderr: '',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote-workload-inspection', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-remote-workload-inspection', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'Replace the live website HTML on the cluster and verify the workload before changing it.',
            sessionId: 'session-remote-workload-inspection',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            1,
            'remote-command',
            expect.objectContaining({
                command: 'kubectl get deployment svc ingress -A',
            }),
            expect.any(Object),
        );
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            2,
            'remote-command',
            expect.objectContaining({
                command: expect.stringContaining('kubectl get deployment,svc,ingress -A'),
            }),
            expect.any(Object),
        );
        expect(toolManager.executeTool.mock.calls[1][1].command).toContain('kubectl get configmap -A');
        expect(toolManager.executeTool.mock.calls[1][1].command).toContain('kubectl get pods -A -o wide');
    });

    test('prefers body verification after a title-only remote website verification failure', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Verified the deployed page by checking mounted HTML and the public response body.', 'resp_remote_body_verification')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Verify the pod and public titles for the deployed website.',
                        params: {
                            command: 'echo "--- pod title ---"; echo; echo "--- public title ---"',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Retry the same title-based verification.',
                        params: {
                            command: 'echo "--- pod title ---"; echo; echo "--- public title ---"',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: false,
                    toolId: 'remote-command',
                    error: '--- pod title ---\n\n--- public title ---',
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: '--- pod file: /usr/share/nginx/html/index.html ---\n512\n<!DOCTYPE html><html><body><main>Bikini storefront</main></body></html>\n--- public response ---\nHTTP/2 200\n<!DOCTYPE html><html><body><main>Bikini storefront</main></body></html>',
                        stderr: '',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote-body-verification', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-remote-body-verification', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'Verify the deployed website HTML on the pod and the public host after the rollout.',
            sessionId: 'session-remote-body-verification',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            1,
            'remote-command',
            expect.objectContaining({
                command: 'echo "--- pod title ---"; echo; echo "--- public title ---"',
            }),
            expect.any(Object),
        );
        expect(toolManager.executeTool).toHaveBeenNthCalledWith(
            2,
            'remote-command',
            expect.objectContaining({
                command: expect.stringContaining('--- public response ---'),
            }),
            expect.any(Object),
        );
        expect(toolManager.executeTool.mock.calls[1][1].command).toContain('kubectl exec -n "$ns" "$pod"');
        expect(toolManager.executeTool.mock.calls[1][1].command).toContain('sed -n "1,40p"');
    });

    test('follows a crashing init container describe step with kubectl logs instead of handing off the next tool call', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Fetched the failing init container logs and continued troubleshooting.', 'resp_init_logs')),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [{
                        tool: 'remote-command',
                        reason: 'Describe the crashing Gitea pod first',
                        params: {
                            command: 'kubectl describe pod -n gitea gitea-5479f795f8-pk2dp',
                        },
                    }],
                }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] }))
                .mockResolvedValueOnce(JSON.stringify({ steps: [] })),
        };

        const describeOutput = [
            'Name:         gitea-5479f795f8-pk2dp',
            'Namespace:    gitea',
            'Init Containers:',
            '  init-directories:',
            '    State:          Terminated',
            '      Reason:       Completed',
            '  init-app-ini:',
            '    State:          Waiting',
            '      Reason:       CrashLoopBackOff',
            '    Last State:     Terminated',
            '      Reason:       Error',
            '      Exit Code:    1',
            'Containers:',
            '  gitea:',
            '    State: Waiting',
        ].join('\n');

        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'docker-exec', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read', 'code-sandbox']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        host: '10.0.0.5:22',
                        stdout: describeOutput,
                        stderr: '',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        host: '10.0.0.5:22',
                        stdout: '/usr/sbinx/config_environment.sh: not found',
                        stderr: '',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-init-logs', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-init-logs', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'You have root access on the whole cluster. Can you solve this issue with the crashing Gitea init container?',
            sessionId: 'session-init-logs',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(2);
        expect(toolManager.executeTool.mock.calls[0][1].command).toBe('kubectl describe pod -n gitea gitea-5479f795f8-pk2dp');
        expect(toolManager.executeTool.mock.calls[1][1].command).toContain("kubectl logs -n 'gitea' 'gitea-5479f795f8-pk2dp' -c 'init-app-ini' --previous");
    });

    test('treats explicit web research and scrape requests as first-class tool intents', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'web-fetch', 'web-scrape'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const researchPolicy = orchestrator.buildToolPolicy({
            objective: 'Can you do web research on this company for me?',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const scrapePolicy = orchestrator.buildToolPolicy({
            objective: 'Please scrape this site for the contact information.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        expect(researchPolicy.candidateToolIds).toContain('web-search');
        expect(scrapePolicy.candidateToolIds).toContain('web-search');
        expect(scrapePolicy.candidateToolIds).toContain('web-scrape');
    });

    test('routes user and soul card growth requests to bounded self-reflection', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['self-reflection-update', 'agent-notes-write'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: "The agent isn't updating the user card or soul card. Can we make sure the agents are growing with our interactions?",
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const isolatedToolPolicy = orchestrator.buildToolPolicy({
            objective: "The agent isn't updating the user card or soul card. Can we make sure the agents are growing with our interactions?",
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext: {
                sessionIsolation: true,
            },
        });
        const runtimeInstructions = orchestrator.buildRuntimeInstructions({
            executionProfile: 'default',
            allowedToolIds: toolPolicy.allowedToolIds,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toContain('self-reflection-update');
        expect(isolatedToolPolicy.candidateToolIds).toContain('self-reflection-update');
        expect(isolatedToolPolicy.candidateToolIds).not.toContain('agent-notes-write');
        expect(runtimeInstructions).toContain('soul cards and user cards');
        expect(runtimeInstructions).toContain('stable durable lessons');
        expect(runtimeInstructions).toContain('At the end of completed work, make one quiet durable-learning decision');
        expect(runtimeInstructions).toContain('Prefer `soul_append`');
        expect(runtimeInstructions).toContain('compactedContent');
    });

    test('surfaces user-checkpoint to planners for web-chat decision gates', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['user-checkpoint', 'architecture-design'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Plan the system architecture and ask me which direction to take before you start major implementation.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext: {
                userCheckpointPolicy: {
                    enabled: true,
                    remaining: 2,
                    pending: null,
                },
            },
        });

        await orchestrator.planToolUse({
            objective,
            executionProfile: 'default',
            toolPolicy,
        });

        const plannerPrompt = llmClient.complete.mock.calls[0]?.[0] || '';
        const runtimeInstructions = orchestrator.buildRuntimeInstructions({
            executionProfile: 'default',
            allowedToolIds: toolPolicy.allowedToolIds,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toContain('user-checkpoint');
        expect(toolPolicy.userCheckpointPolicy).toEqual(expect.objectContaining({
            enabled: true,
            remaining: 2,
        }));
        expect(plannerPrompt).toContain('Every `user-checkpoint` step must include either a non-empty `params.question` with concise choice `params.options`, or a short `params.steps` questionnaire.');
        expect(plannerPrompt).toContain('inline survey card with clickable options');
        expect(plannerPrompt).toContain('primary quick way to involve the user');
        expect(plannerPrompt).toContain('Supported step types are choice, multi-choice, text, date, time, and datetime.');
        expect(runtimeInstructions).toContain('inline popup-style survey card with clickable choices');
        expect(runtimeInstructions).toContain('primary quick way to involve the user');
        expect(runtimeInstructions).toContain('Do not turn checkpoints into long questionnaires, pages of questions, or more than 6 steps.');
    });

    test('suppresses user-checkpoint when a survey is already pending', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'user-checkpoint'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Plan the refactor and ask me first before doing major work.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext: {
                userCheckpointPolicy: {
                    enabled: true,
                    remaining: 1,
                    pending: {
                        id: 'checkpoint-1',
                        question: 'Choose a direction',
                    },
                },
            },
        });

        expect(toolPolicy.candidateToolIds).not.toContain('user-checkpoint');
        expect(toolPolicy.userCheckpointPolicy.pending).toEqual(expect.objectContaining({
            id: 'checkpoint-1',
        }));
    });

    test('suppresses user-checkpoint on survey response turns so planning continues', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'user-checkpoint'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Survey response (checkpoint-1): chose "Pricing tables" [pricing-tables].',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext: {
                userCheckpointPolicy: {
                    enabled: true,
                    remaining: 1,
                    pending: null,
                },
            },
        });

        expect(toolPolicy.candidateToolIds).not.toContain('user-checkpoint');
        expect(toolPolicy.userCheckpointPolicy.surveyResponseTurn).toBe(true);
    });

    test('forces a direct Perplexity-backed web-search action for explicit research requests', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'web-search'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Please do research on managed Postgres providers for startups.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective: 'Please do research on managed Postgres providers for startups.',
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'web-search',
            reason: 'Explicit research request should start with Perplexity-backed web search.',
            params: expect.objectContaining({
                engine: 'perplexity',
                query: 'managed Postgres providers for startups modern',
                researchMode: 'search',
                region: 'ca-en',
                timeRange: 'all',
                userLocation: {
                    country: 'CA',
                },
            }),
        });
    });

    test('forces a direct podcast action for explicit podcast deliverable requests instead of stopping after web search', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['podcast', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Make a 10 minute podcast about Kentville gym options.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toContain('podcast');
        expect(directAction).toEqual({
            tool: 'podcast',
            reason: 'Explicit podcast request should start with the podcast workflow tool.',
            params: {
                topic: 'Kentville gym options',
                durationMinutes: 10,
            },
        });
    });

    test('passes selected artifact ids into direct podcast actions', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['podcast', 'web-search', 'asset-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Make a podcast about these uploaded Kubota files.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
            toolContext: {
                artifactIds: ['artifact-kubota-1'],
            },
        });

        expect(directAction).toEqual(expect.objectContaining({
            tool: 'podcast',
            params: expect.objectContaining({
                topic: 'these uploaded Kubota files',
                artifactIds: ['artifact-kubota-1'],
            }),
        }));
    });

    test('lets asset search run before podcast when uploaded files are referenced but none are selected', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['podcast', 'web-search', 'asset-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Make a podcast about the uploaded Kubota files.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
            toolContext: {
                artifactIds: [],
            },
        });

        expect(toolPolicy.candidateToolIds).toEqual(expect.arrayContaining(['podcast', 'asset-search']));
        expect(directAction).toBeNull();
    });

    test('turns video podcast requests into podcast workflow calls with MP4 rendering enabled', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['podcast', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Make a 10 minute vertical video podcast about Kentville gym options with generated images.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'podcast',
            reason: 'Explicit video podcast request should use the podcast workflow with MP4 rendering.',
            params: {
                topic: 'Kentville gym options',
                durationMinutes: 10,
                includeVideo: true,
                videoAspectRatio: '9:16',
                videoRenderMode: 'storyboard',
                videoImageMode: 'generated',
                videoGenerateImages: true,
            },
        });
    });

    test('passes requested admin audio sources into video podcast workflow calls', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['podcast', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Make a vertical video podcast about Kentville gym options with generated images and use the admin audio sources.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'podcast',
            reason: 'Explicit video podcast request should use the podcast workflow with MP4 rendering.',
            params: {
                topic: 'Kentville gym options',
                voiceOnlyAudio: false,
                includeIntro: true,
                includeOutro: true,
                includeMusicBed: true,
                includeVideo: true,
                videoAspectRatio: '9:16',
                videoRenderMode: 'storyboard',
                videoImageMode: 'generated',
                videoGenerateImages: true,
            },
        });
    });

    test.skip('managed-app direct routing was deleted from orchestration', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'git-safe', 'k3s-deploy', 'remote-command']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Create and deploy a managed app called hello-stack. Make it a simple one-page site that says the managed app pipeline is working.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            recentMessages: [
                {
                    role: 'user',
                    content: 'the repo to work on is K3s Cluster Dog Webiste Frontend',
                },
                {
                    role: 'assistant',
                    content: 'I inspected K3s Cluster Dog Webiste Frontend in the managed app system. Its current state is draft, with no repo clone URL, no SSH URL, and no latest build run attached. The next move is to create or reinitialize the managed app for K3s Cluster Dog Webiste Frontend, then push the app code and start a fresh build/deploy from that record.',
                },
            ],
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toEqual(expect.arrayContaining([
            'managed-app',
        ]));
        expect(toolPolicy.workflow).toBeNull();
        expect(directAction).toEqual({
            tool: 'managed-app',
            reason: 'Managed app creation and deployment requests should use the dedicated control-plane tool.',
            params: expect.objectContaining({
                action: 'create',
                deployTarget: 'ssh',
                slug: 'hello-stack',
                requestedAction: 'deploy',
                prompt: objective,
                sourcePrompt: objective,
            }),
        });
    });

    test.skip('managed-app transcript recovery was deleted from orchestration', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'k3s-deploy']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'yes go ahead with those steps for the managed app K3s Cluster Dog Webiste Frontend to get it online';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            recentMessages: [
                {
                    role: 'user',
                    content: 'the repo to work on is K3s Cluster Dog Webiste Frontend',
                },
                {
                    role: 'assistant',
                    content: 'I inspected K3s Cluster Dog Webiste Frontend in the managed app system. Its current state is draft, with no repo clone URL, no SSH URL, and no latest build run attached. The next move is to create or reinitialize the managed app for K3s Cluster Dog Webiste Frontend, then push the app code and start a fresh build/deploy from that record.',
                },
            ],
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
            recentMessages: [
                {
                    role: 'user',
                    content: 'the repo to work on is K3s Cluster Dog Webiste Frontend',
                },
                {
                    role: 'assistant',
                    content: 'I inspected K3s Cluster Dog Webiste Frontend in the managed app system. Its current state is draft, with no repo clone URL, no SSH URL, and no latest build run attached. The next move is to create or reinitialize the managed app for K3s Cluster Dog Webiste Frontend, then push the app code and start a fresh build/deploy from that record.',
                },
            ],
        });

        expect(toolPolicy.candidateToolIds).toContain('managed-app');
        expect(directAction).toEqual({
            tool: 'managed-app',
            reason: 'Managed app recovery should reinitialize the catalog record and repo/build lane before deployment continues.',
            params: expect.objectContaining({
                action: 'create',
                deployTarget: 'ssh',
                name: 'K3s Cluster Dog Webiste Frontend',
                requestedAction: 'deploy',
            }),
        });
    });

    test.skip('managed-app SSH pinning was deleted from orchestration', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'k3s-deploy']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Deploy the managed app called demo. Use ssh on the remote server with Gitea on the k3s cluster.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'managed-app',
            reason: 'Managed app deployment requests should use the dedicated control-plane tool.',
            params: {
                action: 'deploy',
                appRef: 'demo',
                deployTarget: 'ssh',
            },
        });
    });

    test.skip('managed-app planned-step normalization was deleted from orchestration', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
        });

        const step = orchestrator.normalizePlannedStep({
            tool: 'managed-app',
            reason: 'Deploy the managed app through the managed control plane.',
            params: {
                action: 'deploy',
                appRef: 'demo',
            },
        }, {
            objective: 'Deploy the managed app demo on the remote server.',
            executionProfile: 'remote-build',
        });

        expect(step).toEqual({
            tool: 'managed-app',
            reason: 'Deploy the managed app through the managed control plane.',
            params: {
                action: 'deploy',
                appRef: 'demo',
                deployTarget: 'ssh',
            },
        });
    });

    test('routes GitLab-observable remote-build authoring through managed-app', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'git-safe', 'k3s-deploy', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Build and deploy a website called hello-stack on the remote server using GitLab and the k3s cluster with DNS and TLS.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toContain('managed-app');
        expect(directAction).toEqual({
            tool: 'managed-app',
            reason: 'Managed app creation and deployment requests should use the dedicated control-plane tool.',
            params: {
                action: 'create',
                prompt: objective,
                sourcePrompt: objective,
                requestedAction: 'deploy',
                slug: 'hello-stack',
                deployTarget: 'runner',
                executor: 'remote-cli-agent',
                useRemoteCliAgent: true,
            },
        });
    });

    test('routes managed app GitLab/k3s iterations through remote-cli-agent as a controlled worker', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-cli-agent', 'remote-command', 'git-safe', 'k3s-deploy', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Update managed app hello-stack, use remote-cli-agent to fix the site, then rebuild through GitLab and deploy to the k3s cluster.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'managed-app',
            reason: 'Managed app update requests should use the backend-owned iteration loop instead of remote-cli handoff.',
            params: {
                action: 'iterate',
                requestedAction: 'deploy',
                iterationAction: 'deploy',
                appRef: 'hello-stack',
                prompt: objective,
                sourcePrompt: objective,
                executor: 'remote-cli-agent',
                useRemoteCliAgent: true,
                deployTarget: 'runner',
            },
        });
    });

    test('routes failed deployed-address retries to remote-cli-agent instead of raw remote-command redeploys', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'git-safe', 'k3s-deploy', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'what address did you deploy too?. it did not work on either. try again';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                remoteWorkspacePath: '/srv/apps/retry-deploy',
            },
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-cli-agent');
        expect(directAction).toEqual({
            tool: 'remote-cli-agent',
            reason: 'The request asks an assisted remote CLI agent to own the coding, build, deploy, and verification loop.',
            params: {
                task: objective,
                waitMs: 30000,
                adminMode: true,
                cwd: '/srv/apps/retry-deploy',
            },
        });
    });

    test('keeps explicit remote-cli-agent requests from being cancelled by runtime guidance', async () => {
        const originalRewriteEnabled = process.env.ORCHESTRATION_REWRITE_ENABLED;
        process.env.ORCHESTRATION_REWRITE_ENABLED = 'true';

        const objective = 'Use the remote cli agent to do a read-only diagnostic only: print pwd in the configured remote workspace and return WHAT_CHANGED, VERIFY_COMMANDS, VERIFY_RESULTS, PUBLIC_URL, BLOCKER. Do not edit or deploy anything.';
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote CLI diagnostic completed.')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-cli-agent', 'remote-command', 'remote-workbench', 'k3s-deploy', 'web-search', 'web-fetch', 'file-read', 'file-write', 'file-search', 'agent-notes-write', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            getToolReadiness: jest.fn((toolId) => ({
                toolId,
                status: ['remote-command', 'remote-workbench', 'k3s-deploy'].includes(toolId) ? 'unavailable' : 'ready',
                reason: ['remote-command', 'remote-workbench', 'k3s-deploy'].includes(toolId)
                    ? 'SSH client is not installed in the backend container.'
                    : 'Tool is registered and executable.',
                executableShape: 'execute',
            })),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-cli-agent',
                data: {
                    finalOutput: 'WHAT_CHANGED: none\nVERIFY_RESULTS: /opt/kimibuilt\nBLOCKER: none',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-explicit-remote-cli', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-explicit-remote-cli', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        try {
            const orchestrator = new ConversationOrchestrator({
                llmClient,
                toolManager,
                sessionStore,
                memoryService,
            });

            const result = await orchestrator.executeConversation({
                input: objective,
                memoryInput: objective,
                sessionId: 'session-explicit-remote-cli',
                executionProfile: 'remote-build',
                metadata: {
                    clientSurface: 'web-chat',
                },
                toolContext: {
                    clientSurface: 'web-chat',
                    remoteWorkspacePath: '/opt/kimibuilt',
                },
            });

            expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
            expect(toolManager.executeTool).toHaveBeenCalledWith(
                'remote-cli-agent',
                expect.objectContaining({
                    task: objective,
                    adminMode: true,
                    cwd: '/opt/kimibuilt',
                }),
                expect.any(Object),
            );
            expect(result.response.metadata.runtimeMode).toBe('direct-tool');
            expect(result.response.metadata.toolPolicy.preferredRemoteToolId).toBe('remote-cli-agent');
            expect(result.response.metadata.toolPolicy.candidateToolIds[0]).toBe('remote-cli-agent');
            expect(result.response.metadata.toolPolicy.candidateToolIds).not.toContain('remote-command');
            expect(result.response.metadata.toolPolicy.candidateToolIds).not.toContain('remote-workbench');
        } finally {
            if (originalRewriteEnabled === undefined) {
                delete process.env.ORCHESTRATION_REWRITE_ENABLED;
            } else {
                process.env.ORCHESTRATION_REWRITE_ENABLED = originalRewriteEnabled;
            }
        }
    });

    test.skip('managed-app platform diagnose routing was deleted from orchestration', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Diagnose the managed app platform. Gitea actions are waiting and no runner is attached.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'managed-app',
            reason: 'Managed app platform inspection requests should use the dedicated control-plane tool.',
            params: {
                action: 'doctor',
            },
        });
    });

    test.skip('managed-app platform repair routing was deleted from orchestration', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Repair the managed app platform and fix queued actions because the Gitea runner is missing.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'managed-app',
            reason: 'Managed app platform repair requests should use the dedicated control-plane tool.',
            params: {
                action: 'reconcile',
            },
        });
    });

    test.skip('managed-app diagnose route was deleted from orchestration', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Diagnose the managed app called demo and show its status.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'managed-app',
            reason: 'Managed app inspection requests should use the dedicated control-plane tool.',
            params: {
                action: 'inspect',
                appRef: 'demo',
            },
        });
    });

    test('treats plural podcast workflow prompts as explicit podcast tool requests', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['podcast', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Use the podcast workflow to create podcasts about Kentville gym options.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toContain('podcast');
        expect(directAction).toEqual({
            tool: 'podcast',
            reason: 'Explicit podcast request should start with the podcast workflow tool.',
            params: {
                topic: 'Kentville gym options',
            },
        });
    });

    test('upgrades explicit deep research requests to the Sonar Deep Research Perplexity mode', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'web-search'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Do deep research on managed Postgres providers for startups.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual(expect.objectContaining({
            tool: 'web-search',
            params: expect.objectContaining({
                engine: 'perplexity',
                researchMode: 'sonar-deep-research',
            }),
        }));
    });

    test('uses pro-search and expanded budgets for daily news research', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'web-search'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Please research daily news about Canadian AI regulation and gather article sources.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual(expect.objectContaining({
            tool: 'web-search',
            params: expect.objectContaining({
                engine: 'perplexity',
                researchMode: 'pro-search',
                maxTokens: expect.any(Number),
                maxTokensPerPage: expect.any(Number),
                searchContextSize: 'medium',
                maxOutputTokens: expect.any(Number),
                maxSteps: 4,
            }),
        }));
    });

    test('adds month freshness to undated technology research', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'web-search'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Please research AI chip startups';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(directAction).toEqual(expect.objectContaining({
            tool: 'web-search',
            params: expect.objectContaining({
                query: 'AI chip startups recent this month',
                timeRange: 'month',
            }),
        }));
    });

    test('routes news source website and direct injection requests to the news scraper', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['news-scraper', 'web-search', 'web-fetch'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Build a news source website that pulls full articles and has direct injection for news and weather.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toContain('news-scraper');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'news-scraper',
            params: expect.objectContaining({
                query: 'Build a news source website that pulls full articles and has direct injection for news and weather',
                siteTextMode: 'excerpt',
                contentRights: 'unknown',
                includeWeatherPlaceholder: true,
            }),
        }));
    });

    test('forces a direct Perplexity-backed web-search action for current-info prompts like weather', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'web-search'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'What is the weather in Halifax today?';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toContain('web-search');
        expect(directAction).toEqual({
            tool: 'web-search',
            reason: 'Current-information request should start with Perplexity-backed web search.',
            params: expect.objectContaining({
                engine: 'perplexity',
                query: 'What is the weather in Halifax today Nova Scotia Environment Canada weather',
                researchMode: 'search',
                region: 'ca-en',
                timeRange: 'day',
                domains: ['weather.gc.ca'],
                userLocation: {
                    country: 'CA',
                    region: 'NS',
                    city: 'Halifax',
                },
            }),
        });
    });

    test('judgment v2 classifies current-info requests and surfaces scored search-first candidates', () => {
        config.config.runtime.judgmentV2Enabled = true;

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'web-fetch', 'document-workflow'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'What are the latest GPU prices today?',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            classification: {
                taskFamily: 'research',
                groundingRequirement: 'required',
                surfaceMode: 'chat',
                preferredExecutionPath: 'direct-tool',
                checkpointNeed: 'none',
                confidence: 0.9,
                ambiguous: false,
                reasons: ['Current information requires grounding.'],
            },
        });

        expect(toolPolicy.classification).toEqual(expect.objectContaining({
            taskFamily: 'research',
            groundingRequirement: 'required',
        }));
        expect(toolPolicy.candidateToolIds[0]).toBe('web-search');
        expect(toolPolicy.candidateToolScores['web-search']).toEqual(expect.objectContaining({
            score: expect.any(Number),
            reasons: expect.arrayContaining(['Grounding is required, so web search should lead.']),
        }));
    });

    test('judgment v2 keeps generic research verification on web-fetch ahead of web-scrape', () => {
        config.config.runtime.judgmentV2Enabled = true;

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'web-fetch', 'web-scrape'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Research managed Postgres providers for startups.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            classification: {
                taskFamily: 'research',
                groundingRequirement: 'required',
                surfaceMode: 'chat',
                preferredExecutionPath: 'plan-first',
                checkpointNeed: 'none',
                confidence: 0.88,
                ambiguous: false,
                reasons: ['Research should be grounded before synthesis.'],
            },
        });

        expect(toolPolicy.candidateToolScores['web-fetch'].score)
            .toBeGreaterThan(toolPolicy.candidateToolScores['web-scrape'].score);
        expect(toolPolicy.candidateToolIds.indexOf('web-fetch'))
            .toBeLessThan(toolPolicy.candidateToolIds.indexOf('web-scrape'));
    });

    test('judgment v2 filters ungrounded planner document steps and falls back to search-first planning', async () => {
        config.config.runtime.judgmentV2Enabled = true;

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [{
                    tool: 'document-workflow',
                    reason: 'Generate the final report immediately.',
                    params: { action: 'generate' },
                }],
            })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'document-workflow'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Research Halifax housing prices and build a report.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            classification: {
                taskFamily: 'research-deliverable',
                groundingRequirement: 'required',
                surfaceMode: 'chat',
                preferredExecutionPath: 'plan-first',
                checkpointNeed: 'none',
                confidence: 0.82,
                ambiguous: false,
                reasons: ['Research-backed deliverables need grounding first.'],
            },
        });

        const plan = await orchestrator.planToolUse({
            objective,
            executionProfile: 'default',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'web-search',
            }),
        ]);
    });

    test('judgment v2 uses planner role model settings for planner calls', async () => {
        config.config.runtime.judgmentV2Enabled = true;
        config.config.runtime.plannerModel = 'gpt-planner';
        config.config.runtime.plannerReasoningEffort = 'high';

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'document-workflow'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Research managed Postgres providers and draft a comparison report.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            classification: {
                taskFamily: 'research-deliverable',
                groundingRequirement: 'required',
                surfaceMode: 'chat',
                preferredExecutionPath: 'plan-first',
                checkpointNeed: 'none',
                confidence: 0.84,
                ambiguous: false,
                reasons: ['Grounded deliverable request.'],
            },
        });

        await orchestrator.planToolUse({
            objective: 'Research managed Postgres providers and draft a comparison report.',
            executionProfile: 'default',
            toolPolicy,
        });

        expect(llmClient.complete).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                model: 'gpt-planner',
                reasoningEffort: 'high',
            }),
        );
    });

    test('planner labels recalled context as historical instead of active transcript', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'asset-search'
                        ? { id: toolId, description: 'Search indexed assets' }
                        : null
                )),
            },
        });
        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'I just uploaded an image. did you see it?',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        await orchestrator.planToolUse({
            objective: 'I just uploaded an image. did you see it?',
            executionProfile: 'default',
            contextMessages: ['Older memory says the user had a puddle image.'],
            toolPolicy,
        });

        expect(llmClient.complete).toHaveBeenCalled();
        const prompt = llmClient.complete.mock.calls[0][0];
        expect(prompt).toContain('historical retrieved memory, not the active transcript');
        expect(prompt).toContain('Do not plan tool calls as if uploads, artifacts, tasks, or tool results mentioned there are present in this request');
    });

    test('planner treats old files as reference context for product improvements', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['asset-search', 'file-read', 'file-write'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });
        const objective = 'Use context from old files as reference to change and improve the product brief.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toEqual(expect.arrayContaining([
            'asset-search',
            'file-read',
            'file-write',
        ]));

        await orchestrator.planToolUse({
            objective,
            executionProfile: 'default',
            toolPolicy,
        });

        const prompt = llmClient.complete.mock.calls[0][0];
        expect(prompt).toContain('When the user wants old files or artifacts used as context/reference for a change');
        expect(prompt).toContain('Treat non-code artifacts as product source material too');
    });

    test('planner model responses can append to executionTrace without throwing', async () => {
        const executionTrace = [];
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'document-workflow'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Research managed Postgres providers and draft a comparison report.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            classification: {
                taskFamily: 'research-deliverable',
                groundingRequirement: 'required',
                surfaceMode: 'chat',
                preferredExecutionPath: 'plan-first',
                checkpointNeed: 'none',
                confidence: 0.84,
                ambiguous: false,
                reasons: ['Grounded deliverable request.'],
            },
        });

        await expect(orchestrator.planToolUse({
            objective: 'Research managed Postgres providers and draft a comparison report.',
            executionProfile: 'default',
            toolPolicy,
            executionTrace,
        })).resolves.toEqual([]);

        expect(executionTrace).toEqual([
            expect.objectContaining({
                type: 'model_call',
                name: 'Model response (unknown)',
                details: expect.objectContaining({
                    phase: 'planner',
                    outputPreview: '{"steps":[]}',
                }),
            }),
        ]);
    });

    test('judgment v2 adds classification and finalization metadata to the trace', async () => {
        config.config.runtime.judgmentV2Enabled = true;

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Verified answer', 'resp_trace_v2')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn(() => null),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-trace-v2', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue({
                contextMessages: [],
                bundles: { fact: [], artifact: [], skill: [], research: [] },
                trace: {
                    query: 'What are the latest GPU prices today?',
                    matchedKeywords: ['latest', 'gpu', 'prices'],
                    counts: { fact: 0, artifact: 0, skill: 0, research: 0 },
                    bundles: { fact: 0, artifact: 0, skill: 0, research: 0 },
                    selected: [],
                },
            }),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'What are the latest GPU prices today?',
            sessionId: 'session-trace-v2',
            stream: false,
        });

        expect(result.trace.classification).toEqual(expect.objectContaining({
            taskFamily: 'research',
            groundingRequirement: 'required',
        }));
        expect(result.trace.recallSummary).toEqual(expect.objectContaining({
            query: 'What are the latest GPU prices today?',
        }));
        expect(result.trace.finalizationMode).toBe('direct-response');
    });

    test('estimates trace usage when gateway returns explicit zero token counts for a real model call', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'chatcmpl-zero-usage',
                model: 'gpt-5.5',
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'The sandbox game is ready to play.',
                    },
                    finish_reason: 'stop',
                }],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                },
            }),
            complete: jest.fn(),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-zero-usage', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue({ contextMessages: [], trace: null }),
            rememberResponse: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: { getTool: jest.fn(() => null) },
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'lets make a quick sandboxed game for sophia',
            sessionId: 'session-zero-usage',
            stream: false,
        });

        const modelTrace = result.response.metadata.executionTrace.find((entry) => entry.type === 'model_call');
        expect(modelTrace.details.responseId).toBe('chatcmpl-zero-usage');
        expect(modelTrace.details.usage).toEqual(expect.objectContaining({
            promptTokens: expect.any(Number),
            completionTokens: expect.any(Number),
            estimated: true,
            source: 'local-estimate',
        }));
        expect(modelTrace.details.usage.totalTokens).toBeGreaterThan(0);
        expect(result.response.metadata.usage).toEqual(expect.objectContaining({
            totalTokens: expect.any(Number),
            estimated: true,
        }));
    });

    test('judgment v2 records a post-round review entry after grounded search execution', async () => {
        config.config.runtime.judgmentV2Enabled = true;

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('The latest GPU prices are grounded in verified search results.', 'resp_review_v2')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolId === 'web-search'
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'web-search',
                data: {
                    query: 'What are the latest GPU prices today',
                    results: [
                        { title: 'GPU price tracker', url: 'https://example.com/gpu', snippet: 'RTX pricing update' },
                    ],
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-review-v2', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue({ contextMessages: [], trace: null }),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'What are the latest GPU prices today?',
            sessionId: 'session-review-v2',
            stream: false,
        });

        expect(result.trace.executionTrace.map((entry) => entry.name)).toContain('Round review 1');
        expect(result.trace.executionTrace.find((entry) => entry.name === 'Round review 1')).toEqual(expect.objectContaining({
            details: expect.objectContaining({
                decision: 'synthesize',
            }),
        }));
    });

    test('judgment v2 uses the active task frame for abbreviated follow-ups and traces isolation failures', async () => {
        config.config.runtime.judgmentV2Enabled = true;

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Updated the notes page summary.', 'resp_active_frame_v2')),
            complete: jest.fn(),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({
                id: 'session-active-frame-v2',
                metadata: {
                    controlState: {
                        activeTaskFrame: {
                            objective: 'Update the Alpha notes page summary',
                            projectKey: 'alpha-notes',
                            clientSurface: 'notes',
                            nextSensibleStep: 'Refresh the status block',
                        },
                    },
                },
            }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue({
                contextMessages: [],
                bundles: { fact: [], artifact: [], skill: [], research: [] },
                trace: {
                    query: 'Update the Alpha notes page summary. continue',
                    matchedKeywords: ['alpha', 'notes', 'page'],
                    counts: { fact: 0, artifact: 0, skill: 0, research: 0 },
                    bundles: { fact: 0, artifact: 0, skill: 0, research: 0 },
                    selected: [
                        {
                            id: 'foreign-project-memory',
                            projectKey: 'beta-notes',
                            memoryNamespace: 'project_shared',
                            sourceSurface: 'notes',
                            summary: 'Beta project notes summary',
                        },
                    ],
                    routing: {
                        projectKey: 'alpha-notes',
                        memoryNamespace: 'surface_local',
                        sourceSurface: 'notes',
                    },
                },
            }),
            rememberResponse: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn(() => null),
            },
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'continue',
            sessionId: 'session-active-frame-v2',
            metadata: {
                clientSurface: 'notes',
                memoryScope: 'alpha-notes',
            },
            stream: false,
        });

        expect(memoryService.process).toHaveBeenCalledWith(
            'session-active-frame-v2',
            'continue',
            expect.objectContaining({
                projectKey: 'alpha-notes',
                recallQuery: 'Update the Alpha notes page summary. continue',
                objective: 'Update the Alpha notes page summary. continue',
                sourceSurface: 'notes',
            }),
        );
        expect(result.trace.activeTaskFrame).toEqual(expect.objectContaining({
            objective: 'Update the Alpha notes page summary. continue',
            clientSurface: 'notes',
            projectKey: 'alpha-notes',
        }));
        expect(result.trace.surfaceFinisher).toBe('notes_page');
        expect(result.trace.failureTags).toContain('cross_project_recall');
        expect(result.trace.projectKey).toBe('alpha-notes');
    });

    test('prefers document-workflow once verified research pages exist for a requested slide deck', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'web-fetch', 'document-workflow'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Research vacation pricing in Halifax and build a slide deck I can review.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
            toolEvents: [
                {
                    toolCall: {
                        function: {
                            name: 'web-search',
                            arguments: JSON.stringify({ query: 'vacation pricing in Halifax' }),
                        },
                    },
                    result: {
                        success: true,
                        toolId: 'web-search',
                        data: {
                            query: 'vacation pricing in Halifax',
                            results: [
                                {
                                    title: 'Nova Scotia Travel Packages',
                                    url: 'https://travel.example.com/packages',
                                    source: 'travel.example.com',
                                    snippet: 'Weekend package from $799 with optional flights.',
                                },
                            ],
                        },
                    },
                },
                {
                    toolCall: {
                        function: {
                            name: 'web-fetch',
                            arguments: JSON.stringify({ url: 'https://travel.example.com/packages' }),
                        },
                    },
                    result: {
                        success: true,
                        toolId: 'web-fetch',
                        data: {
                            url: 'https://travel.example.com/packages',
                            title: 'Nova Scotia Travel Packages',
                            body: '<html><body><main>Weekend package: $799. Flights from Halifax start at $214.</main></body></html>',
                        },
                    },
                },
            ],
        });

        expect(toolPolicy.candidateToolIds).toEqual(
            expect.arrayContaining(['web-search', 'document-workflow']),
        );
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'document-workflow',
            params: expect.objectContaining({
                action: 'generate',
                prompt: objective,
                sources: expect.arrayContaining([
                    expect.objectContaining({
                        sourceUrl: 'https://travel.example.com/packages',
                        kind: 'web-fetch',
                        content: expect.stringContaining('Weekend package: $799. Flights from Halifax start at $214.'),
                    }),
                ]),
            }),
        }));
    });

    test('continues guarded research deliverables through fetch and document generation before synthesis', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Created the AI news HTML page.', 'resp_ai_news_page')),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['web-search', 'web-fetch', 'document-workflow'].includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn(async (toolId) => {
                if (toolId === 'web-search') {
                    return {
                        success: true,
                        toolId,
                        data: {
                            query: 'ai news',
                            results: [{
                                title: 'AI News Roundup',
                                url: 'https://news.example.com/ai',
                                source: 'news.example.com',
                                snippet: 'New AI models and policy updates are reshaping the industry.',
                            }],
                        },
                    };
                }

                if (toolId === 'web-fetch') {
                    return {
                        success: true,
                        toolId,
                        data: {
                            url: 'https://news.example.com/ai',
                            title: 'AI News Roundup',
                            body: '<html><body><main>AI labs announced model updates and regulators published policy guidance.</main></body></html>',
                        },
                    };
                }

                return {
                    success: true,
                    toolId,
                    data: {
                        artifact: {
                            path: 'output/ai-news.html',
                        },
                        artifacts: [{
                            path: 'output/ai-news.html',
                            kind: 'html',
                        }],
                    },
                };
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-ai-news-page', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'make a simple html page with some research on ai news',
            sessionId: 'session-ai-news-page',
            stream: false,
        });

        expect(toolManager.executeTool.mock.calls.map((call) => call[0])).toEqual([
            'web-search',
            'web-fetch',
            'document-workflow',
        ]);
        expect(result.response.metadata.harness.completion.unmetCriteria).toEqual([]);
        expect(result.trace.failureTags).not.toContain('premature_synthesis_with_unmet_criteria');
    });

    test('starts deep research presentation workflow before web search when no grounded sources exist yet', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'document-workflow', 'deep-research-presentation'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Do deep research on Halifax vacation pricing and build a presentation I can review.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
            toolEvents: [],
        });

        expect(toolPolicy.candidateToolIds).toEqual(
            expect.arrayContaining(['deep-research-presentation', 'web-search', 'document-workflow']),
        );
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'deep-research-presentation',
            params: expect.objectContaining({
                prompt: objective,
                documentType: 'presentation',
                format: 'pptx',
            }),
        }));
    });

    test('forces a direct blind web-scrape action for explicit sensitive image scraping requests', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'web-scrape'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Scrape images from https://example.com/gallery without exposing the agent to the adult content.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective: 'Scrape images from https://example.com/gallery without exposing the agent to the adult content.',
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'web-scrape',
            reason: 'Explicit scrape request with a direct URL should start with deterministic web scraping.',
            params: expect.objectContaining({
                url: 'https://example.com/gallery',
                browser: true,
                captureImages: true,
                blindImageCapture: true,
            }),
        });
    });

    test('forces a direct image-generation action for explicit image creation requests', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'image-generate'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Make a hypercar image and put it in a PDF brochure.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective: 'Make a hypercar image and put it in a PDF brochure.',
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'image-generate',
            reason: 'Explicit image-generation request should start by materializing reusable image artifacts.',
            params: {
                prompt: 'Make a hypercar image',
            },
        });
    });

    test('direct image actions preserve explicit requested image counts without leaving batch wording in the prompt', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'image-generate'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Generate 3 hypercar images and put them in a PDF brochure.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective: 'Generate 3 hypercar images and put them in a PDF brochure.',
            toolPolicy,
        });

        expect(directAction).toEqual({
            tool: 'image-generate',
            reason: 'Explicit image-generation request should start by materializing reusable image artifacts.',
            params: {
                prompt: 'Generate hypercar image',
                n: 3,
            },
        });
    });

    test('attaches image tool diagnostics to explicit model response trace entries', async () => {
        const diagnostics = {
            imageGeneration: {
                code: 'provider_response_not_parsable',
                status: 'failed',
                stage: 'provider_response_parse',
                likelyCause: 'Provider returned no parseable image data',
                provider: {
                    source: 'responses',
                    status: 200,
                },
                flags: {
                    providerResponseReceived: true,
                    likelyBackendParserIssue: true,
                },
                counts: {
                    parsedImageRecords: 0,
                    returnedImageRecords: 0,
                    usableReturnedImageRecords: 0,
                    artifacts: 0,
                },
            },
        };
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(
                buildResponse('I tried to generate the dog image, but the image tool failed.', 'resp_image_diag'),
            ),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolId === 'image-generate'
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: false,
                toolId: 'image-generate',
                error: 'Provider returned no parseable image data',
                diagnostics,
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-image-diag', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-image-diag', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'generate a dog image',
            sessionId: 'session-image-diag',
            stream: false,
        });

        const modelTrace = result.response.metadata.executionTrace.find((entry) => (
            entry.type === 'model_call' && entry.details?.phase === 'tool-synthesis'
        ));
        expect(modelTrace).toMatchObject({
            details: {
                diagnosticSourceTool: 'image-generate',
                diagnostics,
                diagnosticSummary: expect.stringContaining('provider_response_not_parsable'),
            },
        });
        expect(modelTrace.details.diagnosticSummary).toContain('parsed=0');
        expect(modelTrace.details.diagnosticSummary).toContain('Provider returned no parseable image data');
    });

    test('does not pass unpersisted generated image urls as verified embeds for synthesis', async () => {
        const diagnostics = {
            imageGeneration: {
                code: 'backend_sent_usable_unpersisted_images',
                status: 'warning',
                stage: 'tool_response_build',
                flags: {
                    backendReturnedUsableImageRecords: true,
                    likelyArtifactPersistenceIssue: true,
                    likelyFrontendReceiveOrParserIssue: false,
                },
                counts: {
                    parsedImageRecords: 1,
                    returnedImageRecords: 1,
                    usableReturnedImageRecords: 1,
                    artifacts: 0,
                },
                artifactPersistence: {
                    sessionIdPresent: true,
                    primaryReason: 'no_decodable_image_payload',
                },
                likelyCause: 'The backend parsed and returned usable image payloads, but no reusable artifact was persisted.',
            },
        };
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(
                buildResponse('Image generation completed, but no reusable image artifact was persisted.', 'resp_image_unpersisted'),
            ),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                toolId === 'image-generate'
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'image-generate',
                data: {
                    source: 'generated',
                    prompt: 'generate a cat image',
                    count: 1,
                    usableCount: 1,
                    image: {
                        url: 'https://example.com/image.png',
                        artifactId: null,
                    },
                    images: [{
                        url: 'https://example.com/image.png',
                        artifactId: null,
                        alt: 'Generated cat image',
                    }],
                    artifacts: [],
                    artifactIds: [],
                    markdownImage: '![Generated cat image](https://example.com/image.png)',
                    markdownImages: ['![Generated cat image](https://example.com/image.png)'],
                },
                diagnostics,
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-image-unpersisted', metadata: {} }),
            getOrCreate: jest.fn().mockResolvedValue({ id: 'session-image-unpersisted', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'generate a cat image',
            sessionId: 'session-image-unpersisted',
            stream: false,
        });

        const synthesisPrompt = llmClient.createResponse.mock.calls
            .map(([request]) => String(request?.input || ''))
            .find((input) => input.includes('Verified tool results:'));

        expect(synthesisPrompt).toContain('Image generation warning');
        expect(synthesisPrompt).toContain('no reusable image artifact was persisted');
        expect(synthesisPrompt).not.toContain('Verified embeddable images:');
        expect(synthesisPrompt).not.toContain('https://example.com/image.png');
    });

    test('notes synthesis instructions keep repaired answers on the page instead of drifting into workspace writes', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
        });

        const instructions = orchestrator.buildRuntimeInstructions({
            baseInstructions: 'Base continuity',
            executionProfile: 'notes',
            allowedToolIds: ['web-search'],
            toolEvents: [{
                toolCall: { function: { name: 'web-search' } },
                reason: 'Research cats',
                result: { success: true, data: { results: [{ title: 'Cat', url: 'https://example.com' }] } },
            }],
            toolPolicy: {
                allowedToolIds: ['web-search'],
                hasReachableSshTarget: false,
            },
        });

        expect(instructions).toContain('Lilly-style block-based notes document');
        expect(instructions).toContain('edit the current page itself through block updates');
        expect(instructions).toContain('Prefer returning `notes-actions` or page-ready notes content');
        expect(instructions).toContain('Only stay in planning/chat mode');
        expect(instructions).toContain('local startup or health state, `/app`, local command execution');
        expect(instructions).toContain('Do not use `file-write` or `file-mkdir`');
        expect(instructions).toContain('Available block palette includes');
        expect(instructions).toContain('Think in page roles, not just paragraphs');
        expect(instructions).toContain('Treat design quality as part of correctness in notes mode');
        expect(instructions).toContain('cover URL, properties, and default model');
        expect(instructions).toContain('create hierarchy and interaction instead of a flat stack');
        expect(instructions).toContain('hero image or ai_image');
        expect(instructions).toContain('designed opening cluster');
        expect(instructions).toContain('editorial-explainer pattern');
        expect(instructions).toContain('dominant design scheme');
        expect(instructions).toContain('preserve the strongest current icon, cover, focal block');
        expect(instructions).toContain('If a substantial notes page only uses headings');
        expect(instructions).toContain('Use `heading_3` for compact section labels or mini-subheads');
    });

    test('runtime instructions require tool-grounded claims about the local environment', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
        });

        const instructions = orchestrator.buildRuntimeInstructions({
            baseInstructions: 'Base continuity',
            executionProfile: 'default',
            allowedToolIds: ['git-safe', 'file-read', 'file-search'],
            toolEvents: [],
            toolPolicy: {
                allowedToolIds: ['git-safe', 'file-read', 'file-search'],
                hasReachableSshTarget: false,
            },
        });

        expect(instructions).toContain('Treat the local CLI environment, workspace state, filesystem contents, and shell behavior as unknown');
        expect(instructions).toContain('Do not comment on local environment health, startup state, writable paths, repository cleanliness, or command availability');
        expect(instructions).toContain('default authoring target, not proof of the repository\'s current health, cleanliness, or contents');
    });

    test('notes tool policy is restricted to web research tools for page-edit requests', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'web-fetch', 'web-scrape', 'file-read', 'file-search', 'file-write', 'file-mkdir', 'remote-command', 'document-workflow'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Put this 3D tic tac toe implementation plan on the page and organize the notes.',
            executionProfile: 'notes',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.allowedToolIds).toEqual(['web-search', 'web-fetch', 'web-scrape']);
        expect(toolPolicy.candidateToolIds).toEqual([]);
    });

    test('notes surface treats implicit page builds as notes edits instead of document outputs', async () => {
        config.config.runtime.judgmentV2Enabled = true;

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Updated the penguin research brief.', 'resp_notes_trace')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['web-search', 'web-fetch', 'web-scrape', 'document-workflow'].includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-notes-trace', metadata: { clientSurface: 'notes', taskType: 'notes' } }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue({
                contextMessages: [],
                bundles: { fact: [], artifact: [], skill: [], research: [] },
                trace: {
                    query: 'Create a research brief about penguins with sources and key findings.',
                    matchedKeywords: ['research', 'brief', 'penguins'],
                    counts: { fact: 0, artifact: 0, skill: 0, research: 0 },
                    bundles: { fact: 0, artifact: 0, skill: 0, research: 0 },
                    selected: [],
                },
            }),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Create a research brief about penguins with sources and key findings.',
            sessionId: 'session-notes-trace',
            stream: false,
            executionProfile: 'notes',
            taskType: 'notes',
            clientSurface: 'notes',
        });

        expect(result.trace.classification).toEqual(expect.objectContaining({
            taskFamily: 'notes-edit',
            surfaceMode: 'notes-page',
        }));
    });

    test('falls back to web-search planning when planner output is not valid json', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue('I should use web-search to research this topic.'),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['web-search', 'web-fetch'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Please research the best managed Postgres providers for startups.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        const plan = await orchestrator.planToolUse({
            objective: 'Please research the best managed Postgres providers for startups.',
            executionProfile: 'default',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'web-search',
                params: expect.objectContaining({
                    engine: 'perplexity',
                    query: expect.stringContaining('managed Postgres providers for startups'),
                    researchMode: 'search',
                }),
            }),
        ]);
    });

    test('does not let a generic cluster deployment request collapse into kubectl pod listing fallback', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue('I should probably inspect the cluster first.'),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Can you please set this up on the cluster and deploy it into a pod if needed?',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        const plan = await orchestrator.planToolUse({
            objective: 'Can you please set this up on the cluster and deploy it into a pod if needed?',
            executionProfile: 'remote-build',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    command: expect.stringContaining('uname -m'),
                }),
            }),
        ]);
        expect(plan[0].params.command).not.toContain('kubectl get nodes -o wide');
        expect(plan[0].params.command).not.toContain('kubectl get pods -A');
    });

    test('repairs malformed planner params for agent-workload steps', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'agent-workload',
                        reason: 'Schedule a deferred task to check the time on remote host in 5 minutes',
                        params: {
                            action: 'remote-command',
                            command: 'date',
                            name: 'time-check',
                            schedule: 'in 5 minutes',
                        },
                    },
                ],
            })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['agent-workload', 'remote-command'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'can you run a cron later to check the time on the remote host in 5 minutes',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        const plan = await orchestrator.planToolUse({
            objective: 'can you run a cron later to check the time on the remote host in 5 minutes',
            executionProfile: 'default',
            toolPolicy,
            session: {
                metadata: {
                    timezone: 'America/Halifax',
                },
            },
            toolContext: {
                timezone: 'America/Halifax',
                now: '2026-04-02T09:00:00.000Z',
            },
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'agent-workload',
                params: expect.objectContaining({
                    action: 'create',
                    trigger: {
                        type: 'once',
                        runAt: '2026-04-02T09:05:00.000Z',
                    },
                    metadata: expect.objectContaining({
                        createdFromScenario: true,
                        scenarioRequest: 'can you run a cron later to check the time on the remote host in 5 minutes',
                    }),
                }),
            }),
        ]);
    });

    test('repairs simple planner params for user-checkpoint steps', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'user-checkpoint',
                        reason: 'Need one decision before major work.',
                        params: {
                            prompt: 'Which direction should I take?',
                            options: [
                                'Refactor auth flow first',
                                'Prototype the UI first',
                            ],
                        },
                    },
                ],
            })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'user-checkpoint'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Plan the next implementation steps and ask me first before major work.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext: {
                userCheckpointPolicy: {
                    enabled: true,
                    remaining: 2,
                    pending: null,
                },
            },
        });

        const plan = await orchestrator.planToolUse({
            objective: 'Plan the next implementation steps and ask me first before major work.',
            executionProfile: 'default',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'user-checkpoint',
                params: expect.objectContaining({
                    inputType: 'choice',
                    question: 'Which direction should I take?',
                    options: [
                        { id: 'refactor-auth-flow-first', label: 'Refactor auth flow first' },
                        { id: 'prototype-the-ui-first', label: 'Prototype the UI first' },
                    ],
                    steps: [
                        expect.objectContaining({
                            question: 'Which direction should I take?',
                            inputType: 'choice',
                        }),
                    ],
                }),
            }),
        ]);
    });

    test('repairs short multi-step planner params for user-checkpoint steps', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'user-checkpoint',
                        reason: 'Need a short intake before major work.',
                        params: {
                            title: 'Quick intake',
                            steps: [
                                {
                                    prompt: 'Which track should I take first?',
                                    choices: [
                                        'Refactor the backend',
                                        'Polish the web chat',
                                    ],
                                },
                                {
                                    question: 'What should the rollout date be?',
                                    type: 'date',
                                },
                            ],
                        },
                    },
                ],
            })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'user-checkpoint'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Plan the next implementation steps and ask me first before major work.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext: {
                userCheckpointPolicy: {
                    enabled: true,
                    remaining: 2,
                    pending: null,
                },
            },
        });

        const plan = await orchestrator.planToolUse({
            objective: 'Plan the next implementation steps and ask me first before major work.',
            executionProfile: 'default',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'user-checkpoint',
                params: expect.objectContaining({
                    title: 'Quick intake',
                    steps: [
                        expect.objectContaining({
                            question: 'Which track should I take first?',
                            inputType: 'choice',
                            options: [
                                { id: 'refactor-the-backend', label: 'Refactor the backend' },
                                { id: 'polish-the-web-chat', label: 'Polish the web chat' },
                            ],
                        }),
                        expect.objectContaining({
                            question: 'What should the rollout date be?',
                            inputType: 'date',
                        }),
                    ],
                }),
            }),
        ]);
    });

    test('repairs planner params for architecture-design steps', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'architecture-design',
                        reason: 'Design the requested prototype architecture.',
                        params: {
                            request: 'Create a small architecture mock/demo for an OpenCode-driven software builder.',
                        },
                    },
                ],
            })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'architecture-design'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Create a small architecture mock/demo for an OpenCode-driven software builder.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        const plan = await orchestrator.planToolUse({
            objective,
            executionProfile: 'default',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'architecture-design',
                params: expect.objectContaining({
                    requirements: objective,
                    request: objective,
                }),
            }),
        ]);
    });

    test('does not shortcut multi-job scheduling requests into a single direct workload action', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['agent-workload', 'remote-command'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'can you setup a couple cron jobs on the local system to reach out to the server and do security updates and checks';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        const directAction = orchestrator.buildDirectAction({
            objective,
            toolPolicy,
            toolContext: {
                timezone: 'America/Halifax',
            },
        });

        expect(toolPolicy.candidateToolIds).toContain('agent-workload');
        expect(directAction).toBeNull();
    });

    test('does not offer agent-workload during deferred workload execution', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['agent-workload', 'remote-command'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'run a cron later every day at 8 pm to remote into the server and get a health report',
            executionProfile: 'remote-build',
            metadata: {
                workloadRun: true,
                clientSurface: 'workload',
            },
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).not.toContain('agent-workload');
        expect(toolPolicy.candidateToolIds).toContain('remote-command');
    });

    test('does not offer agent-workload when only a prior turn contained the schedule', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    toolId === 'agent-workload'
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'gather information on the k3s cluster on the server',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            recentMessages: [
                { role: 'user', content: 'run it five minutes from now' },
            ],
            toolContext: {
                timezone: 'UTC',
                now: '2026-04-02T09:00:00.000Z',
            },
        });

        expect(toolPolicy.candidateToolIds).not.toContain('agent-workload');
    });

    test('builds a workload direct action from a schedule-only follow-up using recent transcript', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
        });

        const directAction = orchestrator.buildDirectAction({
            objective: 'run it five minutes from now',
            session: {
                metadata: {
                    timezone: 'UTC',
                },
            },
            recentMessages: [
                { role: 'user', content: 'gather information on the k3s cluster on the server' },
            ],
            toolPolicy: {
                candidateToolIds: ['agent-workload'],
            },
            toolContext: {
                timezone: 'UTC',
                now: '2026-04-02T09:00:00.000Z',
            },
        });

        expect(directAction).toEqual(expect.objectContaining({
            tool: 'agent-workload',
            params: expect.objectContaining({
                action: 'create',
                prompt: expect.stringContaining('gather information on the k3s cluster on the server'),
                trigger: {
                    type: 'once',
                    runAt: '2026-04-02T09:05:00.000Z',
                },
            }),
        }));
    });

    test('keeps an active session project plan in the foreground during timing-style follow-ups', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['agent-workload', 'file-read', 'file-write', 'user-checkpoint']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const session = {
            metadata: {
                controlState: {
                    projectPlan: {
                        kind: 'foreground-project-plan',
                        status: 'active',
                        source: 'objective',
                        title: 'Polish the landing page',
                        objective: 'Polish the landing page and verify it.',
                        governance: {
                            lockedPlan: false,
                            modificationPolicy: 'flexible',
                        },
                        milestones: [{
                            id: 'inspect-current-state',
                            title: 'Inspect the current state',
                            status: 'completed',
                        }, {
                            id: 'deliver-requested-work',
                            title: 'Implement the requested changes',
                            status: 'in_progress',
                        }, {
                            id: 'validate-result',
                            title: 'Validate and review the result',
                            status: 'planned',
                        }],
                    },
                },
            },
        };
        const objective = 'Tomorrow morning works.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            session,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext: {
                timezone: 'America/Halifax',
                now: '2026-04-07T12:00:00.000Z',
            },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext: {
                timezone: 'America/Halifax',
                now: '2026-04-07T12:00:00.000Z',
            },
        });

        expect(toolPolicy.projectPlan).toEqual(expect.objectContaining({
            status: 'active',
            objective: 'Polish the landing page and verify it.',
        }));
        expect(toolPolicy.candidateToolIds).not.toContain('agent-workload');
        expect(directAction).toBeNull();
    });

    test('keeps an active workflow in the foreground when checkpoint feedback includes timing', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['agent-workload', 'remote-command', 'git-safe', 'k3s-deploy']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Survey response (rollout-date): chose "Tomorrow morning" [tomorrow-morning]. Notes: 9:00 AM Atlantic.';
        const session = {
            metadata: {
                controlState: {
                    workflow: {
                        kind: 'end-to-end-builder',
                        version: 1,
                        objective: 'Fix the landing page in this repo, push it to GitHub, deploy it to k3s, and verify the rollout.',
                        lane: 'repo-then-deploy',
                        stage: 'saving',
                        status: 'active',
                        workspacePath: 'C:/Users/phill/KimiBuilt',
                        repositoryPath: 'C:/Users/phill/KimiBuilt',
                        progress: {
                            implemented: true,
                        },
                    },
                },
            },
        };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            session,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                workspacePath: 'C:/Users/phill/KimiBuilt',
                repositoryPath: 'C:/Users/phill/KimiBuilt',
            },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext: {
                workspacePath: 'C:/Users/phill/KimiBuilt',
                repositoryPath: 'C:/Users/phill/KimiBuilt',
                timezone: 'America/Halifax',
                now: '2026-04-07T12:00:00.000Z',
            },
        });

        expect(toolPolicy.workflow).toEqual(expect.objectContaining({
            source: 'stored',
            lane: 'repo-then-deploy',
            stage: 'saving',
            taskList: expect.arrayContaining([
                expect.objectContaining({
                    id: 'implement-repository',
                    status: 'completed',
                }),
                expect.objectContaining({
                    id: 'build-and-deploy-remote-workspace',
                    status: 'in_progress',
                }),
            ]),
        }));
        expect(toolPolicy.candidateToolIds).not.toContain('agent-workload');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'remote-command',
            params: expect.objectContaining({
                workflowAction: 'build-and-deploy-remote-workspace',
                workingDirectory: 'C:/Users/phill/KimiBuilt',
            }),
        }));
    });

    test('holds a paused foreground workflow until the user explicitly resumes it', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['agent-workload', 'remote-command', 'git-safe', 'k3s-deploy']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const session = {
            metadata: {
                controlState: {
                    foregroundContinuationGate: {
                        paused: true,
                        source: 'autonomy-time-budget',
                    },
                    workflow: {
                        kind: 'end-to-end-builder',
                        version: 1,
                        objective: 'Fix the landing page in this repo, push it to GitHub, deploy it to k3s, and verify the rollout.',
                        lane: 'repo-then-deploy',
                        stage: 'saving',
                        status: 'active',
                        workspacePath: 'C:/Users/phill/KimiBuilt',
                        repositoryPath: 'C:/Users/phill/KimiBuilt',
                        progress: {
                            implemented: true,
                        },
                    },
                },
            },
        };

        const pausedToolPolicy = orchestrator.buildToolPolicy({
            objective: 'Can you summarize where we paused?',
            session,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                workspacePath: 'C:/Users/phill/KimiBuilt',
                repositoryPath: 'C:/Users/phill/KimiBuilt',
            },
        });
        const resumedToolPolicy = orchestrator.buildToolPolicy({
            objective: 'Continue.',
            session,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                workspacePath: 'C:/Users/phill/KimiBuilt',
                repositoryPath: 'C:/Users/phill/KimiBuilt',
            },
        });

        expect(pausedToolPolicy.workflow).toBeNull();
        expect(resumedToolPolicy.workflow).toEqual(expect.objectContaining({
            lane: 'repo-then-deploy',
            status: 'active',
        }));
    });

    test('prefers remote-command over local file tools for remote website replacement prompts without explicit local artifacts', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'file-write', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Create a whole new HTML file, replace the existing website on the cluster, and restart the workload.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('web-fetch');
        expect(toolPolicy.candidateToolIds).not.toContain('file-read');
        expect(toolPolicy.candidateToolIds).not.toContain('file-search');
        expect(toolPolicy.candidateToolIds).not.toContain('file-write');
    });

    test('keeps research html documents about public events on the document research path', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'file-write', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: [
                'Original request:',
                'Can you turn this research on Calgary into a formal html document with visuals of Calgary or the events?',
                '',
                'Approved outline:',
                JSON.stringify({
                    title: 'Calgary Events Brief',
                    sections: [
                        {
                            heading: 'Festival Snapshot',
                            purpose: 'Create a concise overview of public events and live music hosted across Calgary.',
                            keyPoints: ['Calgary Stampede', 'Seasonal festivals'],
                            targetLength: 'medium',
                        },
                    ],
                }, null, 2),
            ].join('\n'),
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toContain('web-search');
        expect(toolPolicy.candidateToolIds).toContain('web-fetch');
    });

    test('prefers remote-command for repo-level remote build work', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Fix the failing tests in this repo on the server and refactor the auth module.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {},
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('opencode-run');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'remote-command',
            params: expect.objectContaining({
                workflowAction: 'implement-remote-workspace',
                command: expect.stringContaining('planned objective'),
            }),
        }));
        expect(directAction.params.command).toContain(objective);
    });

    test('keeps local repo work on the remote CLI lane when deployment is remote', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Use this repo to build the backend package locally, push it to GitHub, then deploy it to the remote k3s cluster and verify the rollout.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                repositoryPath: 'C:/Users/phill/KimiBuilt',
                workspacePath: 'C:/Users/phill/KimiBuilt',
            },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                repositoryPath: 'C:/Users/phill/KimiBuilt',
                workspacePath: 'C:/Users/phill/KimiBuilt',
            },
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('opencode-run');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'remote-command',
            params: expect.objectContaining({
                workflowAction: 'implement-remote-workspace',
                workingDirectory: 'C:/Users/phill/KimiBuilt',
            }),
        }));
    });

    test('does not offer opencode-run in the default profile for repo implementation plus github push requests', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['git-safe', 'tool-doc-read', 'web-search', 'web-fetch', 'file-read', 'file-search']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Fix the auth module in this repo, build it locally, and push it to GitHub.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
            toolContext: {
                repositoryPath: 'C:/Users/phill/KimiBuilt',
                workspacePath: 'C:/Users/phill/KimiBuilt',
            },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                repositoryPath: 'C:/Users/phill/KimiBuilt',
                workspacePath: 'C:/Users/phill/KimiBuilt',
            },
        });

        expect(toolPolicy.executionProfile).toBe('default');
        expect(toolPolicy.candidateToolIds).not.toContain('opencode-run');
        expect(directAction).toBeNull();
    });

    test('keeps remote CLI for kimibuilt tls-plus-github requests instead of treating the .help domain like docs help', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'next.js, I have kimibuilt.secdevsolutions.help and you need to do the tls with traefik, acme, and lets encrypt. We should be able to use remote CLI to make the code and push to github.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                repositoryPath: 'C:/Users/phill/KimiBuilt',
                workspacePath: 'C:/Users/phill/KimiBuilt',
            },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                repositoryPath: 'C:/Users/phill/KimiBuilt',
                workspacePath: 'C:/Users/phill/KimiBuilt',
            },
        });

        expect(toolPolicy.candidateToolIds).toEqual(expect.arrayContaining([
            'remote-command',
            'git-safe',
            'k3s-deploy',
        ]));
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'remote-command',
            params: expect.objectContaining({
                workflowAction: 'implement-remote-workspace',
                workingDirectory: 'C:/Users/phill/KimiBuilt',
            }),
        }));
    });

    test('treats explicit remote CLI create-and-deploy requests as repo work', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'k3s-deploy', 'git-safe', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Use remote CLI to create a small app in this repo and add it to the k3s cluster as a smoke test.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                workspacePath: 'C:/Users/phill/KimiBuilt',
                repositoryPath: 'C:/Users/phill/KimiBuilt',
            },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                workspacePath: 'C:/Users/phill/KimiBuilt',
                repositoryPath: 'C:/Users/phill/KimiBuilt',
            },
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('opencode-run');
        expect(toolPolicy.candidateToolIds).toContain('k3s-deploy');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'remote-command',
            params: expect.objectContaining({
                workflowAction: 'implement-remote-workspace',
                workingDirectory: 'C:/Users/phill/KimiBuilt',
            }),
        }));
        expect(directAction.params.command).toContain(objective);
    });

    test('keeps generic remote website builds on direct CLI even when managed-app is available', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '162.55.163.199',
            port: 22,
            username: 'root',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'k3s-deploy', 'git-safe', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Use the direct remote SSH/CLI path against root@162.55.163.199, create a test website there, route a small web server, and verify it publicly.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                workspacePath: '/workspace/test-site',
                repositoryPath: '/workspace/test-site',
            },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                workspacePath: '/workspace/test-site',
                repositoryPath: '/workspace/test-site',
            },
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('managed-app');
        expect(directAction?.tool || null).not.toBe('managed-app');
    });

    test('routes remote-build live website builds through managed-app while preserving remote CLI execution', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '162.55.163.199',
            port: 22,
            username: 'root',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'remote-cli-agent', 'k3s-deploy', 'git-safe', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Build a small playable web app, deploy it to the remote k3s cluster, and verify the public HTTPS site.';
        const toolContext = {
            metadata: {
                remoteBuildIntent: true,
                frontendRemoteBuildAutonomyApproved: true,
            },
            workspacePath: '/workspace/test-site',
            repositoryPath: '/workspace/test-site',
        };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext,
            metadata: toolContext.metadata,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext,
        });

        expect(toolPolicy.candidateToolIds).toContain('managed-app');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'managed-app',
            params: expect.objectContaining({
                executor: 'remote-cli-agent',
                useRemoteCliAgent: true,
            }),
        }));
    });

    test('routes sampled HTML managed-app publish requests without spawning sub-agents', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '162.55.163.199',
            port: 22,
            username: 'root',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'remote-cli-agent', 'k3s-deploy', 'git-safe', 'tool-doc-read', 'agent-delegate', 'document-workflow']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Use the managed app portion to publish the sampled HTML document artifact at demo.demoserver2.buzz. It is making sub agents now; do not make sub agents, do the prompt it was asked.';
        const toolContext = {
            metadata: {
                remoteBuildIntent: true,
                preferManagedApp: true,
            },
            workspacePath: '/workspace/sample-site',
            repositoryPath: '/workspace/sample-site',
        };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext,
            metadata: toolContext.metadata,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext,
        });

        expect(toolPolicy.candidateToolIds).toContain('managed-app');
        expect(toolPolicy.candidateToolIds).not.toContain('agent-delegate');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'managed-app',
            params: expect.objectContaining({
                executor: 'remote-cli-agent',
                useRemoteCliAgent: true,
            }),
        }));
    });

    test('keeps managed-app owner for sticky remote-cli software deployment follow-ups', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '162.55.163.199',
            port: 22,
            username: 'root',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'remote-cli-agent', 'k3s-deploy', 'git-safe', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const priorObjective = 'Build a daily news website and deploy it to dailynews.demoserver2.buzz.';
        const objective = 'Make it more detailed and put it online at dailynews.demoserver2.buzz.';
        const session = {
            controlState: {
                lastToolIntent: 'remote-cli-agent',
                lastRemoteObjective: priorObjective,
                remoteCliAgent: {
                    sessionId: 'remote-session-1',
                    mcpSessionId: 'mcp-session-1',
                    cwd: '/opt/kimibuilt',
                },
            },
            metadata: {},
        };
        const metadata = {
            remoteBuildIntent: true,
            frontendRemoteBuildAutonomyApproved: true,
            stickyRemoteContext: true,
            lastRemoteToolIntent: 'remote-cli-agent',
            lastRemoteObjective: priorObjective,
        };
        const toolContext = {
            metadata,
            workspacePath: '/workspace/test-site',
            repositoryPath: '/workspace/test-site',
        };

        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            session,
            toolManager: orchestrator.toolManager,
            toolContext,
            metadata,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext,
        });

        expect(toolPolicy.prefersManagedAppForRemoteBuild).toBe(true);
        expect(toolPolicy.candidateToolIds).toContain('managed-app');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'managed-app',
            params: expect.objectContaining({
                action: 'create',
                requestedAction: 'deploy',
                deployTarget: 'runner',
                executor: 'remote-cli-agent',
                useRemoteCliAgent: true,
            }),
        }));
    });

    test('routes frontend-approved explicit remote-cli-agent builds away from managed-app', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '162.55.163.199',
            port: 22,
            username: 'root',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'remote-cli-agent', 'k3s-deploy', 'git-safe', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Use remote-cli-agent only, no managed-app/postgres. target k3s-prod cwd /opt/agent-apps admin. update namespace app-remote-codex-proof configmap remote-codex-proof-index for deployment remote-codex-proof so https://remote-codex-proof.demoserver2.buzz/ contains WEB_CHAT_UI_PROOF=2026-05-31. verify rollout cert curl. return markers.';
        const toolContext = {
            metadata: {
                remoteBuildIntent: true,
                frontendRemoteBuildAutonomyApproved: true,
                preferredTool: 'remote-cli-agent',
                plannedTools: ['remote-cli-agent'],
            },
            workspacePath: '/workspace/test-site',
            repositoryPath: '/workspace/test-site',
        };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext,
            metadata: toolContext.metadata,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext,
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-cli-agent');
        expect(toolPolicy.candidateToolIds).not.toContain('managed-app');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'remote-cli-agent',
            params: expect.objectContaining({
                adminMode: true,
            }),
        }));
    });

    test('keeps discovery-first server build prompts out of the repo implementation lane', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search', 'tool-doc-read', 'user-checkpoint']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'I want to build on the server, lets start with a couple questionnaires to figure out what we should work on. Some kind of web app we can run on our VPS server on the net with our demoserver2.buzz DNS. Can you do some research on the server and then provide those questions.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            toolContext: {
                userCheckpointPolicy: {
                    enabled: true,
                    remaining: 3,
                    pending: null,
                },
            },
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {},
        });

        expect(toolPolicy.workflow).toBeNull();
        expect(toolPolicy.candidateToolIds).toEqual(expect.arrayContaining([
            'remote-command',
            'web-search',
            'user-checkpoint',
        ]));
        expect(toolPolicy.candidateToolIds).not.toContain('opencode-run');
        expect(directAction).toBeNull();
    });

    test('treats remote command-help prompts as documentation instead of repo implementation', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'tool-doc-read', 'web-search']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Use remote build to give a remote command catalog summary.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {},
        });

        expect(toolPolicy.workflow).toBeNull();
        expect(toolPolicy.candidateToolIds).toContain('tool-doc-read');
        expect(toolPolicy.candidateToolIds).not.toContain('opencode-run');
        expect(directAction).toBeNull();
    });

    test('loads the remote-command docs for kubectl and k3s command catalog requests', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'k3s-deploy', 'tool-doc-read', 'web-search']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Give me the kubectl command catalog and docs reference for deploying websites on k3s with Rancher, TLS, and DNS.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {},
        });

        expect(toolPolicy.candidateToolIds).toContain('tool-doc-read');
        expect(directAction).toEqual({
            tool: 'tool-doc-read',
            reason: 'Remote k3s, kubectl, and deployment command requests should load the relevant tool documentation before execution.',
            params: {
                toolId: 'remote-command',
            },
        });
    });

    test('surfaces the repo-then-deploy lane for mixed end-to-end build requests', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Fix the landing page in this repo, push it to GitHub, deploy it to k3s, and verify the rollout.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toEqual(expect.arrayContaining([
            'remote-command',
            'git-safe',
            'k3s-deploy',
        ]));
        expect(toolPolicy.workflow).toEqual(expect.objectContaining({
            lane: 'repo-then-deploy',
            stage: 'implementing',
            status: 'active',
        }));
    });

    test.skip('managed-app remote-build workflow bypass was deleted from orchestration', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['managed-app', 'remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Create and deploy a managed app called hello-stack. Make it a simple one-page site that says the managed app pipeline is working.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toEqual(expect.arrayContaining([
            'managed-app',
        ]));
        expect(toolPolicy.workflow).toBeNull();
    });

    test('routes explicit assisted remote CLI authoring requests to remote-cli-agent instead of the end-to-end workflow', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Can you make a dashboard on the remote server with the cli tool and have it take live data on satellite locations and overlay it on a 3d world, then deploy it with k3s routing for world.demoserver2.buzz.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                remoteWorkspacePath: '/srv/apps/world-dashboard',
            },
        });
        const normalizedAction = orchestrator.normalizePlannedStep(directAction, {
            objective,
            session: {
                metadata: {},
            },
            executionProfile: 'remote-build',
            toolContext: {
                remoteWorkspacePath: '/srv/apps/world-dashboard',
            },
        });

        expect(toolPolicy.workflow).toBeNull();
        expect(toolPolicy.preferredRemoteToolId).toBe('remote-cli-agent');
        expect(toolPolicy.candidateToolIds[0]).toBe('remote-cli-agent');
        expect(toolPolicy.candidateToolIds).toContain('remote-cli-agent');
        expect(toolPolicy.candidateToolIds).not.toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('remote-workbench');
        expect(directAction).toEqual({
            tool: 'remote-cli-agent',
            reason: 'The request asks an assisted remote CLI agent to own the coding, build, deploy, and verification loop.',
            params: {
                task: objective,
                waitMs: 30000,
                adminMode: true,
                cwd: '/srv/apps/world-dashboard',
            },
        });
        expect(normalizedAction).toEqual(directAction);
    });

    test('routes Codex help document work to the main remote-cli-agent workspace', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '168.119.176.121',
            port: 22,
            username: 'root',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/opt/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'document-workflow', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Ask Codex for help creating a deeper PDF document and synthesis package.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                remoteWorkspacePath: '/opt/kimibuilt',
            },
        });

        expect(toolPolicy.workflow).toBeNull();
        expect(toolPolicy.preferredRemoteToolId).toBe('remote-cli-agent');
        expect(toolPolicy.candidateToolIds[0]).toBe('remote-cli-agent');
        expect(directAction).toEqual({
            tool: 'remote-cli-agent',
            reason: 'The request asks an assisted remote CLI agent to own the coding, build, deploy, and verification loop.',
            params: {
                task: objective,
                waitMs: 30000,
                adminMode: true,
                cwd: '/opt/kimibuilt',
            },
        });
    });

    test('routes explicit remote CLI agent weather app deployment requests to remote-cli-agent', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'can you use remote cli agent to build a weather app on the server. use weather.demoserver2.buzz for the dns and build the ingress and tls.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                remoteWorkspacePath: '/srv/apps/weather',
            },
        });

        expect(toolPolicy.workflow).toBeNull();
        expect(toolPolicy.preferredRemoteToolId).toBe('remote-cli-agent');
        expect(toolPolicy.candidateToolIds[0]).toBe('remote-cli-agent');
        expect(toolPolicy.candidateToolIds).toContain('remote-cli-agent');
        expect(toolPolicy.candidateToolIds).not.toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('remote-workbench');
        expect(directAction).toEqual({
            tool: 'remote-cli-agent',
            reason: 'The request asks an assisted remote CLI agent to own the coding, build, deploy, and verification loop.',
            params: {
                task: objective,
                waitMs: 30000,
                adminMode: true,
                cwd: '/srv/apps/weather',
            },
        });
    });

    test('routes explicit remote CLI agent connection checks to remote-cli-agent instead of direct SSH', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Can you remote cli agent into our server and check the workspace?';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                remoteWorkspacePath: '/srv/apps/my-app',
            },
        });

        expect(toolPolicy.preferredRemoteToolId).toBe('remote-cli-agent');
        expect(toolPolicy.candidateToolIds[0]).toBe('remote-cli-agent');
        expect(toolPolicy.candidateToolIds).toContain('remote-cli-agent');
        expect(toolPolicy.candidateToolIds).not.toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('remote-workbench');
        expect(directAction).toEqual({
            tool: 'remote-cli-agent',
            reason: 'The request explicitly asks the assisted remote CLI agent to own the remote task.',
            params: {
                task: objective,
                waitMs: 30000,
                adminMode: true,
                cwd: '/srv/apps/my-app',
            },
        });
    });

    test('anchors remote-cli-agent continuation prompts to the original task and prior session', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'continue working on it with the remote clie agent';
        const session = {
            controlState: {
                remoteCliAgent: {
                    lastTask: 'Build a cool and amazing Calan calendar app from the ground up and deploy it to calan.demoserver2.buzz.',
                    sessionId: 'remote-code-session-1',
                    mcpSessionId: 'mcp-session-1',
                    cwd: '/srv/apps/calan-calendar',
                },
            },
            metadata: {},
        };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext: {},
        });

        expect(directAction).toEqual(expect.objectContaining({
            tool: 'remote-cli-agent',
            params: expect.objectContaining({
                sessionId: 'remote-code-session-1',
                mcpSessionId: 'mcp-session-1',
                cwd: '/srv/apps/calan-calendar',
            }),
        }));
        expect(directAction.params.task).toContain('Original task:');
        expect(directAction.params.task).toContain('Build a cool and amazing Calan calendar app');
        expect(directAction.params.task).toContain('Current user follow-up:');
        expect(directAction.params.task).toContain('continue working on it');
        expect(directAction.params.task).toContain('do not replace the task with a progress callback');
    });

    test('routes remote software deployment requests to remote-cli-agent with admin runner mode', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Build a new status dashboard site on the server and deploy it to k3s at status.demoserver2.buzz with ingress and TLS.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session: {
                metadata: {},
            },
            toolPolicy,
            toolContext: {
                remoteWorkspacePath: '/srv/apps/status-dashboard',
            },
        });

        expect(toolPolicy.workflow).toBeNull();
        expect(toolPolicy.candidateToolIds).toContain('remote-cli-agent');
        expect(directAction).toEqual({
            tool: 'remote-cli-agent',
            reason: 'The request asks an assisted remote CLI agent to own the coding, build, deploy, and verification loop.',
            params: {
                task: objective,
                waitMs: 30000,
                adminMode: true,
                cwd: '/srv/apps/status-dashboard',
            },
        });
    });

    test('continues explicit remote CLI agent work with prior remote sessions', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'use remote cli agent to finish deploying the weather app';
        const session = {
            metadata: {},
            controlState: {
                remoteCliAgent: {
                    sessionId: 'remote-session-1',
                    mcpSessionId: 'mcp-session-1',
                },
            },
        };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            session,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext: {
                remoteWorkspacePath: '/srv/apps/weather',
            },
        });

        expect(directAction.params).toEqual(expect.objectContaining({
            sessionId: 'remote-session-1',
            mcpSessionId: 'mcp-session-1',
            cwd: '/srv/apps/weather',
        }));
    });

    test('reuses a blocked remote_code_run job id for direct remote-cli-agent continuations', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'continue working on it with the remote cli agent';
        const session = {
            metadata: {},
            controlState: {
                remoteCliAgent: {
                    lastTask: 'Fix the deployed Tetris game and verify the live buttons.',
                    sessionId: 'remote-session-1',
                    mcpSessionId: 'mcp-session-1',
                    remoteCodeJobId: 'rcli_tetris_1',
                    cwd: '/srv/apps/my-app',
                    completionStatus: 'blocked',
                    blocker: 'remote_code_run still running after 20 poll attempts.',
                },
            },
        };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            session,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext: {},
        });

        expect(directAction.params).toEqual(expect.objectContaining({
            sessionId: 'remote-session-1',
            mcpSessionId: 'mcp-session-1',
            jobId: 'rcli_tetris_1',
            cwd: '/srv/apps/my-app',
        }));
        expect(directAction.params.task).toContain('Original task:');
        expect(directAction.params.task).toContain('Fix the deployed Tetris game');
    });

    test('does not attach a stale remote_code_run job id to a new remote-cli-agent task', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-cli-agent', 'remote-command', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Build a new status dashboard site on the server and deploy it to k3s.';
        const session = {
            metadata: {},
            controlState: {
                remoteCliAgent: {
                    lastTask: 'Fix the deployed Tetris game.',
                    sessionId: 'remote-session-1',
                    mcpSessionId: 'mcp-session-1',
                    remoteCodeJobId: 'rcli_tetris_1',
                    cwd: '/srv/apps/tetris',
                    completionStatus: 'blocked',
                    blocker: 'remote_code_run still running after 20 poll attempts.',
                },
            },
        };
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            session,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext: {
                remoteWorkspacePath: '/srv/apps/status-dashboard',
            },
        });

        expect(directAction.params.jobId).toBeUndefined();
        expect(directAction.params.task).toBe(objective);
        expect(directAction.params.cwd).toBe('/srv/apps/tetris');
    });

    test('adds a prior remote_code_run job id when normalizing planned remote-cli-agent continuations', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
        });

        const normalizedStep = orchestrator.normalizePlannedStep({
            tool: 'remote-cli-agent',
            params: {
                task: 'continue the same repair',
            },
        }, {
            objective: 'continue the same remote job',
            executionProfile: 'remote-build',
            session: {
                metadata: {},
                controlState: {
                    remoteCliAgent: {
                        lastTask: 'Repair the live Tetris game.',
                        sessionId: 'remote-session-2',
                        mcpSessionId: 'mcp-session-2',
                        remoteCodeJobId: 'rcli_tetris_2',
                        cwd: '/srv/apps/my-app',
                        completionStatus: 'blocked',
                        blocker: 'remote_code_run still running; poll remote_code_status.',
                    },
                },
            },
        });

        expect(normalizedStep.params).toEqual(expect.objectContaining({
            sessionId: 'remote-session-2',
            mcpSessionId: 'mcp-session-2',
            jobId: 'rcli_tetris_2',
            cwd: '/srv/apps/my-app',
        }));
        expect(normalizedStep.params.task).toContain('Original task:');
        expect(normalizedStep.params.task).toContain('Repair the live Tetris game.');
    });

    test('adds a prior running remote_code_run job id when normalizing planned remote-cli-agent continuations', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn(() => null),
            },
        });

        const normalizedStep = orchestrator.normalizePlannedStep({
            tool: 'remote-cli-agent',
            params: {
                task: 'continue the same remote job',
            },
        }, {
            objective: 'continue the same remote job',
            executionProfile: 'remote-build',
            session: {
                metadata: {},
                controlState: {
                    remoteCliAgent: {
                        lastTask: 'Repair the live Tetris game.',
                        remoteCodeJobId: 'rcli_tetris_running',
                        cwd: '/srv/apps/my-app',
                        completionStatus: 'running',
                        verifyResults: ['remote_code_status remained running after 90 poll attempt(s).'],
                    },
                },
            },
        });

        expect(normalizedStep.params).toEqual(expect.objectContaining({
            jobId: 'rcli_tetris_running',
            cwd: '/srv/apps/my-app',
        }));
    });

    test('keeps deploy-only workflow verification pinned to the configured ssh target when the prompt includes a registration email', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'k3s-deploy', 'tool-doc-read', 'web-search']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'lets go ahead setting up with lets encrypt. We can use philly1084@gmail.com for the registration. remote command into the server to do it on the k3s cluster';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.workflow).toEqual(expect.objectContaining({
            lane: 'deploy-only',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        }));
    });

    test('runs the repo-to-deploy workflow through remote-command and verifies the remote result', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Implemented the requested change and pushed it to GitHub. Deploy it in a follow-up when ready.', 'resp_repo_deploy')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        workspacePath: '/srv/apps/kimibuilt',
                        summary: 'Landing page updated.',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'deployment applied',
                        workspacePath: '/srv/apps/kimibuilt',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'deployment "backend" successfully rolled out',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-repo-deploy', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Fix the landing page in this repo, push it to GitHub, deploy it to k3s, and verify the rollout.',
            sessionId: 'session-repo-deploy',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(toolManager.executeTool.mock.calls.map((call) => call[0])).toEqual([
            'remote-command',
            'remote-command',
            'remote-command',
        ]);
        expect(toolManager.executeTool.mock.calls[0][1]).toEqual(expect.objectContaining({
            workflowAction: 'implement-remote-workspace',
        }));
        expect(toolManager.executeTool.mock.calls[1][1]).toEqual(expect.objectContaining({
            workflowAction: 'build-and-deploy-remote-workspace',
        }));
        expect(toolManager.executeTool.mock.calls[2][1]).toEqual(expect.objectContaining({
            workflowAction: 'verify-deployment',
        }));
        expect(result.trace.executionTrace.map((entry) => entry.name)).toEqual(expect.arrayContaining([
            'End-to-end builder workflow',
            'Workflow completed after round 3',
        ]));
        expect(sessionStore.update).toHaveBeenCalledWith('session-repo-deploy', expect.objectContaining({
            metadata: expect.objectContaining({
                controlState: expect.objectContaining({
                    workflow: expect.objectContaining({
                        lane: 'repo-then-deploy',
                        stage: 'completed',
                        status: 'completed',
                        progress: expect.objectContaining({
                            implemented: true,
                            deployed: true,
                            verified: true,
                        }),
                    }),
                }),
            }),
        }));
        expect(result.output).toBe('Implemented the requested change and pushed it to GitHub. Deploy it in a follow-up when ready.');
    });

    test('runs the repo-only workflow through remote-command and stops after implementation', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Implemented the requested repository change and summarized the result.', 'resp_repo_only')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    workspacePath: 'C:/Users/phill/KimiBuilt',
                    summary: 'Auth module fixed.',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-repo-only', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Fix the auth module in this repo and summarize the result.',
            sessionId: 'session-repo-only',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
        expect(toolManager.executeTool).toHaveBeenCalledWith('remote-command', expect.objectContaining({
            workflowAction: 'implement-remote-workspace',
            command: expect.stringContaining('planned objective'),
        }), expect.any(Object));
        expect(result.trace.executionTrace.map((entry) => entry.name)).toEqual(expect.arrayContaining([
            'End-to-end builder workflow',
            'Workflow completed after round 1',
        ]));
        expect(sessionStore.update).toHaveBeenCalledWith('session-repo-only', expect.objectContaining({
            metadata: expect.objectContaining({
                controlState: expect.objectContaining({
                    workflow: expect.objectContaining({
                        lane: 'repo-only',
                        stage: 'completed',
                        status: 'completed',
                        progress: expect.objectContaining({
                            implemented: true,
                        }),
                    }),
                }),
            }),
        }));
        expect(result.output).toBe('Implemented the requested repository change and summarized the result.');
    });

    test('blocks deploy-only workflow requests that do not identify a concrete remote workload', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Deployment completed and the rollout was verified.', 'resp_deploy_only')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn()
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'k3s-deploy',
                    data: {
                        action: 'sync-and-apply',
                        stdout: 'deployment.apps/backend configured',
                        host: '10.0.0.5:22',
                    },
                })
                .mockResolvedValueOnce({
                    success: true,
                    toolId: 'remote-command',
                    data: {
                        stdout: 'deployment "backend" successfully rolled out',
                        stderr: '',
                        host: '10.0.0.5:22',
                    },
                }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-deploy-only', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Deploy the latest GitHub branch to k3s and verify the rollout.',
            sessionId: 'session-deploy-only',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(toolManager.executeTool).not.toHaveBeenCalled();
        expect(result.trace.executionTrace.map((entry) => entry.name)).toEqual(expect.arrayContaining([
            'End-to-end builder workflow',
            'End-to-end builder workflow blocked',
        ]));
        expect(result.output).toContain('End-to-end builder blocked');
    });

    test('resumes the active deploy workflow on yes-style continuation replies instead of drifting into web search', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'k3s-deploy', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const session = {
            metadata: {
                controlState: {
                    workflow: {
                        kind: 'end-to-end-builder',
                        lane: 'deploy-only',
                        status: 'active',
                        stage: 'deploying',
                        objective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                        remoteTarget: {
                            host: '10.0.0.5',
                            username: 'ubuntu',
                            port: 22,
                        },
                        deploy: {
                            namespace: 'kimibuilt',
                            deployment: 'backend',
                            publicDomain: 'demoserver2.buzz',
                        },
                        progress: {
                            deployed: false,
                            verified: false,
                        },
                    },
                    activeTaskFrame: {
                        objective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                    },
                    foregroundContinuationGate: {
                        paused: true,
                    },
                    lastRemoteObjective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                },
            },
        };
        const objective = 'Yes. We can continue the penguin research paper deployment for penguin.demoserver2.buzz.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            session,
        });
        const directAction = orchestrator.buildDirectAction({
            objective,
            session,
            toolPolicy,
            toolContext: {},
        });

        expect(toolPolicy.workflow).toEqual(expect.objectContaining({
            lane: 'deploy-only',
            status: 'active',
        }));
        expect(toolPolicy.candidateToolIds).toContain('k3s-deploy');
        expect(directAction).toEqual(expect.objectContaining({
            tool: 'k3s-deploy',
            reason: 'Run the standard k3s deployment flow for this request.',
        }));
    });

    test('falls back to the model when remote CLI is unavailable for a repo-and-deploy request', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote CLI is unavailable, so I need a healthy runner or SSH target before continuing.', 'resp_remote_unavailable')),
            complete: jest.fn(),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['git-safe', 'k3s-deploy', 'web-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn(),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-blocked-workflow', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            input: 'Fix the auth module in this repo on the server, push it to GitHub, deploy it to k3s, and verify the rollout.',
            sessionId: 'session-blocked-workflow',
            executionProfile: 'remote-build',
            metadata: {
                remoteBuildAutonomyApproved: true,
            },
            stream: false,
        });

        expect(toolManager.executeTool).not.toHaveBeenCalled();
        expect(llmClient.createResponse).toHaveBeenCalled();
        expect(result.output).toBe('Remote CLI is unavailable, so I need a healthy runner or SSH target before continuing.');
    });

    test('does not offer opencode-run for remote repo work', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });
        settingsController.getEffectiveOpencodeConfig.mockReturnValue({
            enabled: true,
            binaryPath: 'opencode',
            defaultAgent: 'build',
            defaultModel: 'gpt-4o',
            allowedWorkspaceRoots: ['C:/Users/phill/KimiBuilt'],
            remoteDefaultWorkspace: '/srv/apps/kimibuilt',
            providerEnvAllowlist: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
            remoteAutoInstall: false,
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Fix the failing tests in this repo on the server and refactor the auth module.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('opencode-run');
    });

    test('keeps infrastructure-only remote build work on remote-command', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Use remote-build to inspect kubectl logs and restart the deployment.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('opencode-run');
    });

    test('keeps remote website replacement on remote-command and exposes local web-fetch when project memory includes internal artifact downloads', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'file-write', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Use the replacement artifact to replace the existing website on the cluster and restart the workload.',
            instructions: 'Generated artifacts:\n- website.html (html) -> /api/artifacts/3ee64601-2cb4-43e1-b56b-973bc2856419/download',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).toContain('web-fetch');
        expect(toolPolicy.candidateToolIds).not.toContain('file-read');
        expect(toolPolicy.candidateToolIds).not.toContain('file-search');
        expect(toolPolicy.candidateToolIds).not.toContain('file-write');
    });

    test('does not treat remembered generated html filenames as explicit local files for deployed website follow-ups', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'file-write', 'tool-doc-read']
                        .includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Replace the deployed HTML with the full beach gallery markup and publish it online.',
            instructions: 'Generated artifacts:\n- beach-inspired-unsplash-gallery-html-s3v73n.html (html)\n- website.html (html) -> /api/artifacts/3ee64601-2cb4-43e1-b56b-973bc2856419/download',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).toContain('web-fetch');
        expect(toolPolicy.candidateToolIds).not.toContain('file-read');
        expect(toolPolicy.candidateToolIds).not.toContain('file-search');
        expect(toolPolicy.candidateToolIds).not.toContain('file-write');
    });

    test('falls back to ssh planning for remote-build prompts', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue('I would inspect the cluster over SSH first.'),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['ssh-execute', 'remote-command', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Inspect the k3s cluster state on the server.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        const plan = await orchestrator.planToolUse({
            objective: 'Inspect the k3s cluster state on the server.',
            executionProfile: 'remote-build',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    command: 'kubectl get nodes -o wide && kubectl get pods -A',
                }),
            }),
        ]);
    });

    test('uses deterministic remote fallback when planner returns empty for remote status questions', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'hows the remote server?',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        const plan = await orchestrator.planToolUse({
            objective: 'hows the remote server?',
            executionProfile: 'remote-build',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    command: 'hostname && uptime && (df -h / || true) && (free -m || true)',
                }),
            }),
        ]);
    });

    test('falls back to remote-command when it is the only remote tool available', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue('I would inspect the cluster over SSH first.'),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Inspect the k3s cluster state on the server.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        const plan = await orchestrator.planToolUse({
            objective: 'Inspect the k3s cluster state on the server.',
            executionProfile: 'remote-build',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    command: 'kubectl get nodes -o wide && kubectl get pods -A',
                }),
            }),
        ]);
    });

    test('repairs planner-provided remote-command steps that omit params.command', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'remote-command',
                        reason: 'Reconnect to the existing default server target, verify architecture with `uname -m`, and confirm the Gitea endpoint https://git.example.com is reachable from the server before attempting auth.',
                        params: {},
                    },
                ],
            })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'ssh-execute', 'web-search'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Reconnect to the server and test https://git.example.com auth flow.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        const plan = await orchestrator.planToolUse({
            objective: 'Reconnect to the server and test https://git.example.com auth flow.',
            executionProfile: 'remote-build',
            toolPolicy,
        });

        expect(plan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    command: expect.stringContaining('curl -IkfsS --max-time 20'),
                }),
            }),
        ]);
        expect(plan[0].params.command).toContain('uname -m');
        expect(plan[0].params.command).toContain('https://git.example.com');
    });

    test('normalizes missing remote-command commands before execution', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn().mockResolvedValue(buildResponse('Remote baseline completed.', 'resp_remote_baseline')),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                steps: [
                    {
                        tool: 'remote-command',
                        reason: 'Reconnect to the server and verify Ubuntu architecture before continuing.',
                        params: {},
                    },
                ],
            })),
        };
        const toolManager = {
            getTool: jest.fn((toolId) => (
                ['remote-command', 'web-search', 'web-fetch', 'file-read', 'file-search', 'tool-doc-read']
                    .includes(toolId)
                    ? { id: toolId, description: toolId }
                    : null
            )),
            executeTool: jest.fn().mockResolvedValue({
                success: true,
                toolId: 'remote-command',
                data: {
                    stdout: 'host-a\naarch64\nNAME=\"Ubuntu\"',
                    stderr: '',
                    host: '10.0.0.5:22',
                },
            }),
        };
        const sessionStore = {
            get: jest.fn().mockResolvedValue({ id: 'session-remote-normalized', metadata: {} }),
            getRecentMessages: jest.fn().mockResolvedValue([]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            process: jest.fn().mockResolvedValue([]),
            rememberResponse: jest.fn(),
        };

        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager,
            sessionStore,
            memoryService,
        });

        await orchestrator.executeConversation({
            input: 'Reconnect to the Ubuntu server and continue the remote-build setup.',
            sessionId: 'session-remote-normalized',
            executionProfile: 'remote-build',
            stream: false,
        });

        expect(toolManager.executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: expect.stringContaining('uname -m'),
            }),
            expect.objectContaining({
                executionProfile: 'remote-build',
                sessionId: 'session-remote-normalized',
            }),
        );
    });

    test('does not offer code-sandbox for generic remote-build tasks', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'code-sandbox'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Inspect the k3s cluster state on the server and continue setup.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(toolPolicy.candidateToolIds).not.toContain('code-sandbox');
    });

    test('offers code-sandbox for remote-build tasks only when local code execution is explicit', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'code-sandbox'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'SSH into the server, then run this code snippet in a sandbox locally to verify output.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        expect(toolPolicy.candidateToolIds).toContain('code-sandbox');
    });

    test('includes Ubuntu and arm64 fallback guidance for remote-build SSH work', async () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn().mockResolvedValue(JSON.stringify({ steps: [] })),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const toolPolicy = orchestrator.buildToolPolicy({
            objective: 'Use remote-build to inspect the k3s cluster and continue setup.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
        });

        await orchestrator.planToolUse({
            objective: 'Use remote-build to inspect the k3s cluster and continue setup.',
            executionProfile: 'remote-build',
            toolPolicy,
        });

        const plannerPrompt = llmClient.complete.mock.calls[0]?.[0] || '';
        const runtimeInstructions = orchestrator.buildRuntimeInstructions({
            executionProfile: 'remote-build',
            allowedToolIds: toolPolicy.allowedToolIds,
            toolPolicy,
        });

        expect(toolPolicy.candidateToolIds).toContain('remote-command');
        expect(runtimeInstructions).toContain('verify architecture with `uname -m`');
        expect(runtimeInstructions).toContain('`find`/`grep -R` for `rg`');
        expect(runtimeInstructions).toContain('do not assume Docker exists on the host');
        expect(runtimeInstructions).toContain('Hydrated remote ops guidance from local project docs:');
        expect(runtimeInstructions).toContain('K3s ships an embedded `kubectl`.');
        expect(runtimeInstructions).toContain('Lane 1: repo-managed manifests with k3s-deploy');
        expect(plannerPrompt).toContain('find/grep instead of rg');
        expect(plannerPrompt).toContain('do not repeat the same command back-to-back');
        expect(plannerPrompt).toContain('non-empty `params.command` string');
        expect(plannerPrompt).toContain('Hydrated remote ops guidance from local project docs:');
        expect(plannerPrompt).toContain('K3s ships an embedded `kubectl`.');
        expect(plannerPrompt).toContain('Lane 1: repo-managed manifests with k3s-deploy');
    });

    test('hydrates local remote ops docs for explicit kubectl and Rancher prompts outside remote-build', () => {
        settingsController.getEffectiveSshConfig.mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['remote-command', 'k3s-deploy'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const objective = 'Debug kubectl ingress routing in Rancher and inspect k3s pod failures.';
        const toolPolicy = orchestrator.buildToolPolicy({
            objective,
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const runtimeInstructions = orchestrator.buildRuntimeInstructions({
            objective,
            executionProfile: 'default',
            allowedToolIds: toolPolicy.allowedToolIds,
            toolPolicy,
        });

        expect(runtimeInstructions).toContain('Hydrated remote ops guidance from local project docs:');
        expect(runtimeInstructions).toContain('K3s ships an embedded `kubectl`.');
        expect(runtimeInstructions).toContain('Rancher UI map');
    });

    test('planner prompt includes matching registered skills before choosing tool steps', async () => {
        const llmClient = {
            complete: jest.fn().mockResolvedValue('{"steps":[]}'),
        };
        const orchestrator = new ConversationOrchestrator({
            llmClient,
            toolManager: {
                getTool: jest.fn((toolId) => ({
                    id: toolId,
                    description: toolId,
                })),
            },
        });
        const toolPolicy = {
            candidateToolIds: ['image-generate', 'file-write', 'remote-cli-agent'],
            candidateToolScores: {},
            toolDescriptions: {
                'image-generate': 'Generate images',
                'file-write': 'Save files',
                'remote-cli-agent': 'Deploy remotely',
            },
            allowedToolIds: ['image-generate', 'file-write', 'remote-cli-agent'],
        };

        await orchestrator.planToolUse({
            objective: 'Generate images for a website and deploy it to k3s.',
            toolPolicy,
            toolContext: {
                metadata: {},
            },
        });

        const plannerPrompt = llmClient.complete.mock.calls[0]?.[0] || '';
        expect(plannerPrompt).toContain('Registered skills available for this request:');
        expect(plannerPrompt).toContain('image-website-k3s');
        expect(plannerPrompt).toContain('Use registered skills to understand reusable workflow shape');
        expect(plannerPrompt).toContain('Treat matched skill ids as active workflow contracts');
    });

    test('treats image generation, unsplash, and direct image URLs as first-class tool intents', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    ['image-generate', 'image-search-unsplash', 'image-from-url'].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const generatePolicy = orchestrator.buildToolPolicy({
            objective: 'Generate a hero image for the landing page.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const unsplashPolicy = orchestrator.buildToolPolicy({
            objective: 'Find me an Unsplash image for a coffee brand homepage.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const urlPolicy = orchestrator.buildToolPolicy({
            objective: 'Use this image URL in the output: https://example.com/hero-image.png',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        expect(generatePolicy.candidateToolIds).toContain('image-generate');
        expect(unsplashPolicy.candidateToolIds).toContain('image-search-unsplash');
        expect(urlPolicy.candidateToolIds).toContain('image-from-url');
    });

    test('honors web-chat plugin menu planned tools as explicit user selections', () => {
        const selectedTools = ['web-search', 'web-fetch', 'document-workflow', 'remote-cli-agent'];
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    selectedTools.includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const policy = orchestrator.buildToolPolicy({
            objective: 'Help me think through this launch idea.',
            executionProfile: 'remote-build',
            toolManager: orchestrator.toolManager,
            metadata: {
                clientSurface: 'web-chat',
                toolSelectionSource: 'web-chat-plugin-menu',
                selectedPluginLanes: ['research', 'documents', 'remote'],
                plannedTools: selectedTools,
                preferredTool: 'remote-cli-agent',
            },
        });

        expect(policy.candidateToolIds).toEqual(expect.arrayContaining(selectedTools));
        expect(policy.userSelectedToolIds).toEqual(expect.arrayContaining(selectedTools));
        if (policy.candidateToolScores?.['web-search']) {
            expect(policy.candidateToolScores['web-search'].reasons).toEqual(expect.arrayContaining([
                'The user explicitly selected this tool lane from web chat plugin choices.',
            ]));
        }
    });

    test('promotes security, design, and database tools into the default execution profile', () => {
        const orchestrator = new ConversationOrchestrator({
            llmClient: {
                createResponse: jest.fn(),
                complete: jest.fn(),
            },
            toolManager: {
                getTool: jest.fn((toolId) => (
                    [
                        'security-scan',
                        'architecture-design',
                        'uml-generate',
                        'api-design',
                        'schema-generate',
                        'migration-create',
                    ].includes(toolId)
                        ? { id: toolId, description: toolId }
                        : null
                )),
            },
        });

        const securityPolicy = orchestrator.buildToolPolicy({
            objective: 'Run a security audit on this code.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const architecturePolicy = orchestrator.buildToolPolicy({
            objective: 'Design the system architecture for a multi-tenant SaaS app.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const umlPolicy = orchestrator.buildToolPolicy({
            objective: 'Generate a UML class diagram for these services.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const apiPolicy = orchestrator.buildToolPolicy({
            objective: 'Create an OpenAPI design for the billing API.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const schemaPolicy = orchestrator.buildToolPolicy({
            objective: 'Generate a database schema and DDL for orders and invoices.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });
        const migrationPolicy = orchestrator.buildToolPolicy({
            objective: 'Create a migration for the schema change.',
            executionProfile: 'default',
            toolManager: orchestrator.toolManager,
        });

        expect(securityPolicy.candidateToolIds).toContain('security-scan');
        expect(architecturePolicy.candidateToolIds).toContain('architecture-design');
        expect(umlPolicy.candidateToolIds).toContain('uml-generate');
        expect(apiPolicy.candidateToolIds).toContain('api-design');
        expect(schemaPolicy.candidateToolIds).toContain('schema-generate');
        expect(migrationPolicy.candidateToolIds).toContain('migration-create');
    });
});

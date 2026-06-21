jest.mock('./routes/admin/settings.controller', () => ({
    getEffectiveOrchestrationConfig: jest.fn(() => ({
        enabled: true,
        defaultModel: 'gpt-5.5',
        evaluatorModel: 'gpt-5.5',
        afterProcessAuditEnabled: true,
        afterProcessAuditModel: 'codex-latest',
        afterProcessAuditReasoningEffort: 'medium',
        agentDirectedRuntime: true,
        neuralWaveResearchMode: true,
        asyncRuntimeEnabled: true,
        asyncRuntimeWebChatParallel: false,
        asyncRuntimeAllowLiveRemote: false,
        enableAlignmentEvaluator: true,
        applyAlignmentGuidance: true,
    })),
}));

jest.mock('./openai-client', () => ({
    createResponse: jest.fn(),
}));

const { createResponse } = require('./openai-client');
const {
    buildAuditEvidence,
    buildAuditSessionPatch,
    collectRecentAuditFlagSignatures,
    resolveAfterProcessAuditConfig,
    runAfterProcessAudit,
} = require('./after-process-audit');

describe('after-process audit', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.KIMIBUILT_AFTER_PROCESS_AUDIT;
    });

    test('uses the codex-latest audit lane by default', () => {
        expect(resolveAfterProcessAuditConfig()).toEqual(expect.objectContaining({
            enabled: true,
            model: 'codex-latest',
            reasoningEffort: 'medium',
        }));
    });

    test('builds evidence with orchestration flags, skills, and tools', () => {
        const evidence = buildAuditEvidence({
            objective: 'Improve the remote build flow.',
            output: 'Done.',
            orchestrationConfig: {
                enabled: true,
                defaultModel: 'gpt-5.5',
                evaluatorModel: 'gpt-5.5',
                afterProcessAuditModel: 'codex-latest',
                afterProcessAuditEnabled: true,
                agentDirectedRuntime: true,
                neuralWaveResearchMode: true,
                asyncRuntimeEnabled: true,
                asyncRuntimeWebChatParallel: true,
                asyncRuntimeAllowLiveRemote: false,
                enableAlignmentEvaluator: true,
                applyAlignmentGuidance: true,
            },
            responseMetadata: {
                selectedSkills: [{ id: 'agent-trace-eval-replay', reason: 'Audit trace quality.' }],
                skillsUsed: ['agent-trace-eval-replay'],
                verification: { toolEvents: 1, verifiedEvidence: 1 },
            },
            existingMetadata: {
                afterProcessAuditHistory: [{
                    auditId: 'previous-audit',
                    completedAt: '2026-06-06T00:00:00.000Z',
                    audit: {
                        auditDecision: 'watch',
                        qualityScore: 0.62,
                        summary: 'Previous pass suggested the same broad research flag.',
                        recommendedFlagChanges: [{
                            flag: 'neuralWaveResearchMode',
                            currentValue: false,
                            suggestedValue: true,
                            reason: 'Prior generic suggestion.',
                        }],
                        learningReview: {
                            roundImprovementPlan: ['Add a focused fixture instead of only toggling flags.'],
                        },
                    },
                }],
            },
            toolEvents: [{
                toolCall: { function: { name: 'remote-cli-agent' } },
                result: {
                    toolId: 'remote-cli-agent',
                    success: false,
                    error: 'missing required parameter: task',
                    verification: { status: 'observed' },
                    data: { finalOutput: 'Rolled out and verified.' },
                },
            }],
        });

        expect(evidence.orchestrationFlags).toEqual(expect.objectContaining({
            agentDirectedRuntime: true,
            neuralWaveResearchMode: true,
            asyncRuntimeEnabled: true,
            asyncRuntimeWebChatParallel: true,
            afterProcessAuditEnabled: true,
        }));
        expect(evidence.modelLanes.afterProcessAuditModel).toBe('codex-latest');
        expect(evidence.selectedSkills[0].id).toBe('agent-trace-eval-replay');
        expect(evidence.toolEvents[0]).toEqual(expect.objectContaining({
            toolId: 'remote-cli-agent',
            success: false,
            verificationStatus: 'observed',
        }));
        expect(evidence.toolFailureReview.failedToolCalls[0]).toEqual(expect.objectContaining({
            toolId: 'remote-cli-agent',
            failureKind: 'bad_schema_or_missing_params',
            nextAction: 'replan_with_validated_params',
        }));
        expect(evidence.recentAfterProcessAudits[0]).toEqual(expect.objectContaining({
            auditId: 'previous-audit',
            summary: 'Previous pass suggested the same broad research flag.',
            roundImprovementPlan: ['Add a focused fixture instead of only toggling flags.'],
        }));
        expect(evidence.recentRepeatedFlagSignatures).toEqual(['neuralWaveResearchMode:true']);
        expect(collectRecentAuditFlagSignatures({
            afterProcessAuditHistory: evidence.recentAfterProcessAudits.map((audit) => ({
                auditId: audit.auditId,
                audit: { recommendedFlagChanges: audit.suggestedFlagChanges },
            })),
        })).toEqual(['neuralWaveResearchMode:true']);
    });

    test('runs model audit and normalizes review output', async () => {
        createResponse.mockResolvedValue({
            model: 'codex-latest',
            output_text: JSON.stringify({
                auditDecision: 'needs_followup',
                qualityScore: 0.42,
                summary: 'The tool lane worked but skill follow-through was weak.',
                orchestrationReview: {
                    flagsConsidered: ['agentDirectedRuntime', 'afterProcessAuditEnabled'],
                    interactionFindings: ['Agent-directed runtime needs stronger skill proof.'],
                    routingFindings: ['Route trace should explain why remote-cli-agent was selected.'],
                    modelLaneFindings: ['GPT 5.5 audit lane was appropriate.'],
                },
                toolSkillReview: {
                    selectedSkills: ['agent-trace-eval-replay'],
                    actualTools: ['remote-cli-agent'],
                    missingTools: ['skill-context'],
                    misusedTools: [],
                    skillUpdates: ['Teach the skill to require route trace review.'],
                    toolPolicyUpdates: ['Keep remote-cli-agent preferred for deploy loops.'],
                },
                learningReview: {
                    durableLessons: ['Completed deploy loops need route and verification proof.'],
                    selfReflectionUpdateSuggestions: [{ action: 'model_card_note', note: 'Audit deploy proof.' }],
                    regressionFixtureCandidates: [],
                    outputQualityRisks: ['Verification was too shallow.'],
                    roundImprovementPlan: ['Add a route-proof fixture before changing another orchestration flag.'],
                },
                recommendedFlagChanges: [
                    {
                        flag: 'neuralWaveResearchMode',
                        currentValue: false,
                        suggestedValue: true,
                        reason: 'Repeat the previous broad research mode recommendation.',
                        confidence: 0.62,
                    },
                    {
                        flag: 'asyncRuntimeWebChatParallel',
                        currentValue: false,
                        suggestedValue: true,
                        reason: 'New evidence shows the web-chat surface can benefit from parallel audit fetches.',
                        confidence: 0.72,
                    },
                ],
                followUpActions: [{ type: 'review', priority: 'medium', description: 'Inspect skill-context routing.' }],
            }),
        });

        const result = await runAfterProcessAudit({
            sessionId: 'session-1',
            objective: 'Deploy the site.',
            output: 'Done.',
            existingMetadata: {
                afterProcessAuditHistory: [{
                    auditId: 'previous-audit',
                    audit: {
                        recommendedFlagChanges: [{
                            flag: 'neuralWaveResearchMode',
                            currentValue: false,
                            suggestedValue: true,
                            reason: 'Prior generic suggestion.',
                        }],
                    },
                }],
            },
            toolEvents: [{
                toolCall: { function: { name: 'remote-cli-agent' } },
                result: { toolId: 'remote-cli-agent', success: true },
            }],
        });

        expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
            model: 'codex-latest',
            reasoningEffort: 'medium',
            stream: false,
        }));
        expect(createResponse.mock.calls[0][0].input).toContain('agentDirectedRuntime');
        expect(createResponse.mock.calls[0][0].input).toContain('afterProcessAuditEnabled');
        expect(result.status).toBe('completed');
        expect(result.audit.auditDecision).toBe('needs_followup');
        expect(result.audit.toolSkillReview.missingTools).toEqual(['skill-context']);
        expect(result.audit.learningReview.roundImprovementPlan).toEqual([
            'Add a route-proof fixture before changing another orchestration flag.',
        ]);
        expect(result.audit.recommendedFlagChanges).toEqual([
            expect.objectContaining({
                flag: 'asyncRuntimeWebChatParallel',
                suggestedValue: true,
            }),
        ]);
    });

    test('fallback audit turns failed tool calls into review-gated learning suggestions', () => {
        const fallback = require('./after-process-audit').buildFallbackAudit({
            objective: 'Run the remote repair.',
            output: 'The tool failed.',
            toolEvents: [{
                toolCall: { function: { name: 'remote-cli-agent' } },
                result: {
                    toolId: 'remote-cli-agent',
                    success: false,
                    error: 'missing required parameter: task',
                },
            }],
        });

        expect(fallback.auditDecision).toBe('needs_followup');
        expect(fallback.toolFailureReview.failedToolCalls[0]).toEqual(expect.objectContaining({
            toolId: 'remote-cli-agent',
            failureKind: 'bad_schema_or_missing_params',
            nextAction: 'replan_with_validated_params',
        }));
        expect(fallback.learningReview.selfReflectionUpdateSuggestions[0]).toEqual(expect.objectContaining({
            toolId: 'self-reflection-update',
            appliesAutomatically: false,
            input: expect.objectContaining({
                dryRun: true,
                apply: false,
                actions: [
                    expect.objectContaining({
                        type: 'model_card_note',
                        content: expect.stringContaining('remote-cli-agent failed with bad_schema_or_missing_params'),
                    }),
                ],
            }),
        }));
    });

    test('builds bounded session metadata history', () => {
        const patch = buildAuditSessionPatch({
            afterProcessAuditHistory: Array.from({ length: 12 }, (_, index) => ({ auditId: `old-${index}` })),
        }, {
            auditId: 'after-audit-new',
            status: 'completed',
            model: 'codex-latest',
            completedAt: '2026-06-06T00:00:00.000Z',
            audit: {
                auditDecision: 'pass',
                qualityScore: 0.9,
                summary: 'Good loop.',
            },
        });

        expect(patch.afterProcessAudit.auditId).toBe('after-audit-new');
        expect(patch.afterProcessAuditHistory).toHaveLength(12);
        expect(patch.afterProcessAuditHistory[11].auditId).toBe('after-audit-new');
    });
});

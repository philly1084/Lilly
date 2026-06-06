jest.mock('./routes/admin/settings.controller', () => ({
    getEffectiveOrchestrationConfig: jest.fn(() => ({
        enabled: true,
        defaultModel: 'gpt-5.5',
        evaluatorModel: 'gpt-5.5',
        afterProcessAuditEnabled: true,
        afterProcessAuditModel: 'gpt-5.5',
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
    resolveAfterProcessAuditConfig,
    runAfterProcessAudit,
} = require('./after-process-audit');

describe('after-process audit', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.KIMIBUILT_AFTER_PROCESS_AUDIT;
    });

    test('uses the GPT 5.5 audit lane by default', () => {
        expect(resolveAfterProcessAuditConfig()).toEqual(expect.objectContaining({
            enabled: true,
            model: 'gpt-5.5',
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
                afterProcessAuditModel: 'gpt-5.5',
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
            toolEvents: [{
                toolCall: { function: { name: 'remote-cli-agent' } },
                result: {
                    toolId: 'remote-cli-agent',
                    success: true,
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
        expect(evidence.modelLanes.afterProcessAuditModel).toBe('gpt-5.5');
        expect(evidence.selectedSkills[0].id).toBe('agent-trace-eval-replay');
        expect(evidence.toolEvents[0]).toEqual(expect.objectContaining({
            toolId: 'remote-cli-agent',
            success: true,
            verificationStatus: 'observed',
        }));
    });

    test('runs model audit and normalizes review output', async () => {
        createResponse.mockResolvedValue({
            model: 'gpt-5.5',
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
                },
                recommendedFlagChanges: [],
                followUpActions: [{ type: 'review', priority: 'medium', description: 'Inspect skill-context routing.' }],
            }),
        });

        const result = await runAfterProcessAudit({
            sessionId: 'session-1',
            objective: 'Deploy the site.',
            output: 'Done.',
            toolEvents: [{
                toolCall: { function: { name: 'remote-cli-agent' } },
                result: { toolId: 'remote-cli-agent', success: true },
            }],
        });

        expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            stream: false,
        }));
        expect(createResponse.mock.calls[0][0].input).toContain('agentDirectedRuntime');
        expect(createResponse.mock.calls[0][0].input).toContain('afterProcessAuditEnabled');
        expect(result.status).toBe('completed');
        expect(result.audit.auditDecision).toBe('needs_followup');
        expect(result.audit.toolSkillReview.missingTools).toEqual(['skill-context']);
    });

    test('builds bounded session metadata history', () => {
        const patch = buildAuditSessionPatch({
            afterProcessAuditHistory: Array.from({ length: 12 }, (_, index) => ({ auditId: `old-${index}` })),
        }, {
            auditId: 'after-audit-new',
            status: 'completed',
            model: 'gpt-5.5',
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

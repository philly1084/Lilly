const {
    assessGroundingAndVerification,
    normalizeFixture,
    inferSurfaceFinisher,
    scorePerceivedIntelligence,
} = require('./perceived-intelligence-harness');
const {
    PROJECT_SHARED_MEMORY_NAMESPACE,
    SURFACE_LOCAL_MEMORY_NAMESPACE,
} = require('./session-scope');

describe('perceived intelligence harness', () => {
    test('normalizes fixture metadata for deterministic harness runs', () => {
        expect(normalizeFixture({
            id: 'scenario-1',
            input: 'continue',
            projectKey: 'alpha-store',
            clientSurface: 'notes',
            expected: { finishers: ['notes_page'] },
            session: { id: 'session-1' },
            toolResults: [{}],
            memoryFixtures: [{}],
        })).toEqual({
            id: 'scenario-1',
            prompt: 'continue',
            projectKey: 'alpha-store',
            surface: 'notes',
            expected: { finishers: ['notes_page'] },
            session: { id: 'session-1' },
            toolResults: [{}],
            memoryFixtures: [{}],
        });
    });

    test('infers the correct finisher for each shared surface', () => {
        expect(inferSurfaceFinisher({ clientSurface: 'notes' })).toBe('notes_page');
        expect(inferSurfaceFinisher({ clientSurface: 'canvas' })).toBe('canvas_structured');
        expect(inferSurfaceFinisher({ clientSurface: 'notation' })).toBe('notation_helper');
        expect(inferSurfaceFinisher({ clientSurface: 'web-chat' })).toBe('chat_reply');
    });

    test('flags cross-project recall as an isolation failure', () => {
        const summary = scorePerceivedIntelligence({
            projectKey: 'alpha-store',
            clientSurface: 'web-chat',
            memoryTrace: {
                selected: [
                    {
                        id: 'foreign-project-memory',
                        projectKey: 'beta-store',
                        memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
                        sourceSurface: 'web-chat',
                        summary: 'Beta project artifact',
                    },
                ],
            },
        });

        expect(summary.crossScopeReuse.foreignProjectCount).toBe(1);
        expect(summary.failureTags).toContain('cross_project_recall');
        expect(summary.perceivedIntelligenceScores.isolation).toBeLessThan(0.2);
    });

    test('flags cross-surface recall only for surface-local memory', () => {
        const surfaceLocalSummary = scorePerceivedIntelligence({
            projectKey: 'alpha-store',
            clientSurface: 'web-chat',
            memoryTrace: {
                selected: [
                    {
                        id: 'surface-local-memory',
                        projectKey: 'alpha-store',
                        memoryNamespace: SURFACE_LOCAL_MEMORY_NAMESPACE,
                        sourceSurface: 'canvas',
                        summary: 'Canvas-only working memory',
                    },
                ],
            },
        });
        const sharedSummary = scorePerceivedIntelligence({
            projectKey: 'alpha-store',
            clientSurface: 'web-chat',
            memoryTrace: {
                selected: [
                    {
                        id: 'project-shared-memory',
                        projectKey: 'alpha-store',
                        memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
                        sourceSurface: 'canvas',
                        summary: 'Project artifact',
                    },
                ],
            },
        });

        expect(surfaceLocalSummary.failureTags).toContain('cross_surface_recall');
        expect(surfaceLocalSummary.crossScopeReuse.foreignSurfaceCount).toBe(1);
        expect(sharedSummary.failureTags).not.toContain('cross_surface_recall');
        expect(sharedSummary.crossScopeReuse.foreignSurfaceCount).toBe(0);
    });

    test('scores planner recovery and repeated-command guardrails', () => {
        const summary = scorePerceivedIntelligence({
            executionTrace: [
                {
                    type: 'harness',
                    name: 'Repeated plan steps blocked in round 1',
                    details: {},
                },
                {
                    type: 'harness',
                    name: 'Deterministic recovery selected after round 1',
                    details: {},
                },
                {
                    type: 'review',
                    name: 'Round review 1',
                    details: {
                        decision: 'continue',
                        productive: true,
                    },
                },
                {
                    type: 'review',
                    name: 'Round review 2',
                    details: {
                        decision: 'synthesize',
                        productive: true,
                    },
                },
            ],
            toolEvents: [
                { result: { success: false, error: 'temporary timeout' } },
                { result: { success: true } },
            ],
        });

        expect(summary.initiativeReview.repeatedCommandBlocks).toBe(1);
        expect(summary.initiativeReview.successfulRecovery).toBe(true);
        expect(summary.failureTags).toContain('repeated_command_blocked');
        expect(summary.failureTags).not.toContain('premature_stop_after_failure');
        expect(summary.perceivedIntelligenceScores.recovery).toBeGreaterThan(0.8);
        expect(summary.perceivedIntelligenceScores.plannerDiscipline).toBeLessThan(0.92);
    });

    test('flags premature synthesis after failure without recovery', () => {
        const summary = scorePerceivedIntelligence({
            executionTrace: [
                {
                    type: 'review',
                    name: 'Round review 1',
                    details: {
                        decision: 'synthesize',
                        productive: true,
                    },
                },
            ],
            toolEvents: [
                { result: { success: false, error: 'failed' } },
            ],
        });

        expect(summary.failureTags).toContain('premature_stop_after_failure');
        expect(summary.perceivedIntelligenceScores.plannerDiscipline).toBeLessThan(0.7);
    });

    test('penalizes synthesis with unmet completion criteria and scores resume continuity', () => {
        const premature = scorePerceivedIntelligence({
            executionTrace: [
                {
                    type: 'review',
                    name: 'Round review 1',
                    details: {
                        harnessDecision: 'synthesize',
                        completionStatus: 'incomplete',
                        unmetCriteria: ['Deployment verified'],
                        stateChanged: false,
                    },
                },
            ],
            harness: {
                resumeAvailable: false,
                completion: {
                    criteria: [{ text: 'Deployment verified' }],
                    unmetCriteria: [{ text: 'Deployment verified' }],
                },
            },
        });
        const resumeable = scorePerceivedIntelligence({
            executionTrace: [
                {
                    type: 'review',
                    name: 'Round review 1',
                    details: {
                        harnessDecision: 'checkpoint',
                        completionStatus: 'incomplete',
                        unmetCriteria: ['Deployment verified'],
                        stateChanged: true,
                    },
                },
            ],
            harness: {
                resumeAvailable: true,
                completion: {
                    criteria: [{ text: 'Deployment verified' }],
                    unmetCriteria: [{ text: 'Deployment verified' }],
                },
            },
        });

        expect(premature.failureTags).toContain('premature_synthesis_with_unmet_criteria');
        expect(premature.perceivedIntelligenceScores.completionDiscipline).toBeLessThan(0.7);
        expect(resumeable.failureTags).toContain('resume_available_with_unmet_criteria');
        expect(resumeable.perceivedIntelligenceScores.resumeContinuity).toBeGreaterThan(0.85);
        expect(resumeable.perceivedIntelligenceScores.autonomyDepth).toBeGreaterThan(premature.perceivedIntelligenceScores.autonomyDepth);
    });

    test('flags research synthesis that searched but did not verify source pages', () => {
        const summary = scorePerceivedIntelligence({
            objective: 'Research current AI harness design patterns and build a cited recommendation.',
            executionTrace: [
                {
                    type: 'review',
                    name: 'Round review 1',
                    details: {
                        harnessDecision: 'synthesize',
                        completionStatus: 'complete',
                    },
                },
            ],
            toolEvents: [
                {
                    result: {
                        success: true,
                        toolId: 'web-search',
                        data: {
                            results: [{ url: 'https://example.com/harness-design' }],
                        },
                    },
                },
            ],
        });

        expect(summary.groundingAndVerification.requirements.researchRequired).toBe(true);
        expect(summary.failureTags).toContain('unverified_research_sources');
        expect(summary.perceivedIntelligenceScores.sourceDiscipline).toBeLessThan(0.8);
    });

    test('rewards verified research source evidence', () => {
        const summary = scorePerceivedIntelligence({
            objective: 'Research current AI harness design patterns and build a cited recommendation.',
            executionTrace: [
                {
                    type: 'review',
                    name: 'Round review 1',
                    details: {
                        harnessDecision: 'synthesize',
                        completionStatus: 'complete',
                    },
                },
            ],
            toolEvents: [
                {
                    result: {
                        success: true,
                        toolId: 'web-search',
                        data: { results: [{ url: 'https://example.com/harness-design' }] },
                    },
                },
                {
                    result: {
                        success: true,
                        toolId: 'web-fetch',
                        data: { url: 'https://example.com/harness-design', body: 'Verified source body.' },
                    },
                },
            ],
        });

        expect(summary.groundingAndVerification.evidence.verifiedSourceEvidence).toBe(true);
        expect(summary.failureTags).not.toContain('unverified_research_sources');
        expect(summary.perceivedIntelligenceScores.sourceDiscipline).toBeGreaterThan(0.9);
    });

    test('flags sandbox-producing runs that synthesize without visual verification', () => {
        const summary = scorePerceivedIntelligence({
            objective: 'Build a sandbox HTML dashboard and verify the preview visually.',
            executionTrace: [
                {
                    type: 'review',
                    name: 'Round review 1',
                    details: {
                        harnessDecision: 'synthesize',
                        completionStatus: 'complete',
                    },
                },
            ],
            toolEvents: [
                {
                    result: {
                        success: true,
                        toolId: 'code-sandbox',
                        data: {
                            sandboxUrl: '/api/sandbox-workspaces/demo/preview',
                        },
                    },
                },
            ],
        });

        expect(summary.groundingAndVerification.requirements.sandboxVerificationRequired).toBe(true);
        expect(summary.failureTags).toContain('missing_sandbox_verification');
        expect(summary.perceivedIntelligenceScores.sandboxDiscipline).toBeLessThan(0.7);
    });

    test('recognizes UI check evidence for sandbox verification', () => {
        const summary = scorePerceivedIntelligence({
            objective: 'Build a sandbox HTML dashboard and verify the preview visually.',
            executionTrace: [
                {
                    type: 'review',
                    name: 'Round review 1',
                    details: {
                        harnessDecision: 'synthesize',
                        completionStatus: 'complete',
                    },
                },
            ],
            toolEvents: [
                {
                    result: {
                        success: true,
                        toolId: 'code-sandbox',
                        data: { sandboxUrl: '/api/sandbox-workspaces/demo/preview' },
                    },
                },
                {
                    result: {
                        success: true,
                        toolId: 'kimibuilt-ui-check',
                        data: { uiCheck: { errors: [] } },
                    },
                },
            ],
        });

        expect(summary.groundingAndVerification.evidence.visualVerificationEvidence).toBe(true);
        expect(summary.failureTags).not.toContain('missing_sandbox_verification');
        expect(summary.perceivedIntelligenceScores.sandboxDiscipline).toBeGreaterThan(0.9);
    });

    test('exposes grounding and verification assessment for report builders', () => {
        const assessment = assessGroundingAndVerification({
            objective: 'Research sources and create a browser preview.',
            initiativeReview: {
                lastDecision: 'synthesize',
                completionStatus: 'complete',
            },
            toolEvents: [],
        });

        expect(assessment.requirements).toEqual({
            researchRequired: true,
            sandboxVerificationRequired: true,
        });
        expect(assessment.failureTags).toEqual(expect.arrayContaining([
            'missing_grounded_research',
            'missing_sandbox_verification',
        ]));
    });
});

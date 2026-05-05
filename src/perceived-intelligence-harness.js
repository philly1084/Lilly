const {
    SURFACE_LOCAL_MEMORY_NAMESPACE,
    USER_GLOBAL_MEMORY_NAMESPACE,
} = require('./session-scope');

function normalizeFixture(fixture = {}) {
    return {
        id: String(fixture?.id || '').trim() || 'scenario',
        prompt: String(fixture?.prompt || fixture?.input || '').trim(),
        projectKey: String(fixture?.projectKey || '').trim() || null,
        surface: String(fixture?.surface || fixture?.clientSurface || '').trim() || null,
        expected: fixture?.expected && typeof fixture.expected === 'object' ? fixture.expected : {},
        session: fixture?.session && typeof fixture.session === 'object' ? fixture.session : null,
        toolResults: Array.isArray(fixture?.toolResults) ? fixture.toolResults : [],
        memoryFixtures: Array.isArray(fixture?.memoryFixtures) ? fixture.memoryFixtures : [],
    };
}

function inferSurfaceFinisher({ taskType = '', clientSurface = '', executionProfile = '' } = {}) {
    const surface = String(clientSurface || taskType || executionProfile || '').trim().toLowerCase();
    if (!surface) {
        return 'chat_reply';
    }
    if (surface.includes('notes')) {
        return 'notes_page';
    }
    if (surface.includes('canvas')) {
        return 'canvas_structured';
    }
    if (surface.includes('notation')) {
        return 'notation_helper';
    }
    return 'chat_reply';
}

function summarizeMemoryReadSet(memoryTrace = null, { projectKey = '', clientSurface = '' } = {}) {
    const selected = Array.isArray(memoryTrace?.selected) ? memoryTrace.selected : [];
    const byNamespace = {};
    const bySurface = {};
    let userGlobalCount = 0;
    const foreignProjectEntries = [];
    const foreignSurfaceEntries = [];

    selected.forEach((entry) => {
        const namespace = String(entry?.memoryNamespace || 'unknown').trim() || 'unknown';
        const surface = String(entry?.sourceSurface || '').trim() || 'unknown';
        byNamespace[namespace] = (byNamespace[namespace] || 0) + 1;
        bySurface[surface] = (bySurface[surface] || 0) + 1;

        if (namespace === USER_GLOBAL_MEMORY_NAMESPACE) {
            userGlobalCount += 1;
        }

        if (projectKey
            && entry?.projectKey
            && entry.projectKey !== projectKey
            && namespace !== USER_GLOBAL_MEMORY_NAMESPACE) {
            foreignProjectEntries.push({
                id: entry.id,
                projectKey: entry.projectKey,
                summary: entry.summary || entry.artifactId || '',
            });
        }

        if (clientSurface
            && entry?.sourceSurface
            && entry.sourceSurface !== clientSurface
            && namespace === SURFACE_LOCAL_MEMORY_NAMESPACE) {
            foreignSurfaceEntries.push({
                id: entry.id,
                sourceSurface: entry.sourceSurface,
                summary: entry.summary || entry.artifactId || '',
            });
        }
    });

    return {
        totalSelected: selected.length,
        byNamespace,
        bySurface,
        userGlobalCount,
        foreignProjectEntries,
        foreignSurfaceEntries,
    };
}

function buildInitiativeReview({ executionTrace = [], toolEvents = [], harness = null } = {}) {
    const traceEntries = Array.isArray(executionTrace) ? executionTrace : [];
    const roundReviews = traceEntries
        .filter((entry) => /^Round review \d+$/i.test(String(entry?.name || '')));
    const harnessDecisionEntries = traceEntries
        .filter((entry) => entry?.details?.harnessDecision);
    const decisions = (harnessDecisionEntries.length > 0 ? harnessDecisionEntries : roundReviews)
        .map((entry) => String(entry?.details?.harnessDecision || entry?.details?.decision || '').trim())
        .filter(Boolean);
    const productiveRounds = roundReviews.filter((entry) => entry?.details?.productive !== false).length;
    const toolFailures = (Array.isArray(toolEvents) ? toolEvents : [])
        .filter((event) => event?.result?.success === false).length;
    const repeatedCommandBlocks = traceEntries.filter((entry) => entry?.type === 'harness'
        && (/repeated plan steps blocked/i.test(String(entry?.name || ''))
            || entry?.details?.harnessDecision === 'blocked')).length;
    const deterministicRecoveries = traceEntries.filter((entry) => entry?.details?.recoveryType === 'deterministic'
        || (entry?.type === 'harness' && /deterministic recovery selected/i.test(String(entry?.name || '')))).length;
    const successfulRecovery = deterministicRecoveries > 0
        && traceEntries.some((entry) => entry?.type === 'review'
            && ['continue', 'synthesize'].includes(String(entry?.details?.decision || '').trim()));
    const checkpointDecisions = decisions.filter((decision) => decision === 'checkpoint').length;
    const finalDecision = decisions[decisions.length - 1] || null;
    const explicitCompletionEntries = traceEntries.filter((entry) => entry?.details?.completionStatus);
    const latestCompletionEntry = explicitCompletionEntries[explicitCompletionEntries.length - 1] || null;
    const harnessCompletion = harness?.completion && typeof harness.completion === 'object' ? harness.completion : null;
    const unmetCriteria = Array.isArray(harnessCompletion?.unmetCriteria)
        ? harnessCompletion.unmetCriteria
        : (Array.isArray(latestCompletionEntry?.details?.unmetCriteria) ? latestCompletionEntry.details.unmetCriteria : []);
    const completionStatus = String(
        harnessCompletion?.unmetCriteria?.length === 0 && Array.isArray(harnessCompletion?.criteria) && harnessCompletion.criteria.length > 0
            ? 'complete'
            : (latestCompletionEntry?.details?.completionStatus || (unmetCriteria.length > 0 ? 'incomplete' : 'unknown')),
    );
    const stateChangingRounds = traceEntries.filter((entry) => entry?.details?.stateChanged === true).length;
    const resumeAvailable = harness?.resumeAvailable === true;
    const failureTags = [];

    if (roundReviews.some((entry) => entry?.details?.productive === false)) {
        failureTags.push('unproductive_round');
    }
    if (decisions.filter((decision) => decision === 'replan').length > 1) {
        failureTags.push('repeated_replan');
    }
    if (toolFailures > 0 && productiveRounds === 0) {
        failureTags.push('stalled_after_failure');
    }
    if (repeatedCommandBlocks > 0) {
        failureTags.push('repeated_command_blocked');
    }
    if (toolFailures > 0 && finalDecision === 'synthesize' && !successfulRecovery) {
        failureTags.push('premature_stop_after_failure');
    }
    if (checkpointDecisions > 1) {
        failureTags.push('checkpoint_overuse');
    }
    if (finalDecision === 'synthesize' && unmetCriteria.length > 0) {
        failureTags.push('premature_synthesis_with_unmet_criteria');
    }
    if (resumeAvailable && unmetCriteria.length > 0) {
        failureTags.push('resume_available_with_unmet_criteria');
    }

    return {
        totalRounds: roundReviews.length,
        productiveRounds,
        lastDecision: finalDecision,
        toolFailures,
        repeatedCommandBlocks,
        deterministicRecoveries,
        successfulRecovery,
        checkpointDecisions,
        completionStatus,
        unmetCriteriaCount: unmetCriteria.length,
        stateChangingRounds,
        resumeAvailable,
        failureTags,
    };
}

function getToolIdFromEvent(event = {}) {
    return String(event?.result?.toolId || event?.toolCall?.function?.name || event?.tool || '').trim();
}

function isSuccessfulToolEvent(event = {}) {
    return event?.result?.success !== false;
}

function getHarnessObjectiveText({ objective = '', harness = null } = {}) {
    const criteriaText = Array.isArray(harness?.completionCriteria)
        ? harness.completionCriteria.join(' ')
        : '';
    const structuredCriteriaText = Array.isArray(harness?.completion?.criteria)
        ? harness.completion.criteria.map((entry) => entry?.text || entry).join(' ')
        : '';
    return [
        objective,
        harness?.currentObjective,
        harness?.objective,
        criteriaText,
        structuredCriteriaText,
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' ');
}

function hasResearchRequirement(text = '') {
    return /\b(research|current|latest|today|news|source|sources|citation|citations|cite|verify|verified|evidence|web|search|browse|fetch|compare|pricing)\b/i.test(text);
}

function hasSandboxVerificationRequirement(text = '') {
    return /\b(sandbox|preview|browser|screenshot|ui check|ui-check|visual|frontend|front-end|html|website|web page|webpage|dashboard|canvas|design|responsive|contrast|overflow)\b/i.test(text);
}

function hasVerifiedSourceEvidence(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).some((event) => {
        const toolId = getToolIdFromEvent(event);
        return isSuccessfulToolEvent(event) && ['web-fetch', 'web-scrape', 'research-bucket-read'].includes(toolId);
    });
}

function hasSearchEvidence(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).some((event) => {
        const toolId = getToolIdFromEvent(event);
        return isSuccessfulToolEvent(event) && ['web-search', 'design-resource-search'].includes(toolId);
    });
}

function hasSandboxProducingEvidence(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).some((event) => {
        const toolId = getToolIdFromEvent(event);
        const data = event?.result?.data || {};
        return isSuccessfulToolEvent(event) && (
            ['code-sandbox', 'document-workflow'].includes(toolId)
            || Boolean(data?.sandboxUrl || data?.previewUrl || data?.artifact?.sandboxUrl || data?.artifact?.previewUrl)
            || (Array.isArray(data?.artifacts) && data.artifacts.some((artifact) => artifact?.sandboxUrl || artifact?.previewUrl || artifact?.kind === 'html'))
        );
    });
}

function hasVisualVerificationEvidence(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).some((event) => {
        const toolId = getToolIdFromEvent(event);
        const data = event?.result?.data || {};
        return isSuccessfulToolEvent(event) && (
            ['kimibuilt-ui-check', 'ui-check', 'playwright', 'browser', 'web-scrape'].includes(toolId)
            || Boolean(data?.uiCheck || data?.screenshot || data?.screenshotPath || data?.screenshots || data?.captureScreenshot)
        );
    });
}

function assessGroundingAndVerification({ objective = '', harness = null, toolEvents = [], initiativeReview = null } = {}) {
    const objectiveText = getHarnessObjectiveText({ objective, harness });
    const researchRequired = hasResearchRequirement(objectiveText);
    const sandboxVerificationRequired = hasSandboxVerificationRequirement(objectiveText)
        || hasSandboxProducingEvidence(toolEvents);
    const searchEvidence = hasSearchEvidence(toolEvents);
    const verifiedSourceEvidence = hasVerifiedSourceEvidence(toolEvents);
    const visualVerificationEvidence = hasVisualVerificationEvidence(toolEvents);
    const synthesized = initiativeReview?.lastDecision === 'synthesize'
        || initiativeReview?.completionStatus === 'complete';
    const failureTags = [];

    if (synthesized && researchRequired && !searchEvidence && !verifiedSourceEvidence) {
        failureTags.push('missing_grounded_research');
    } else if (synthesized && researchRequired && searchEvidence && !verifiedSourceEvidence) {
        failureTags.push('unverified_research_sources');
    }

    if (synthesized && sandboxVerificationRequired && !visualVerificationEvidence) {
        failureTags.push('missing_sandbox_verification');
    }

    return {
        requirements: {
            researchRequired,
            sandboxVerificationRequired,
        },
        evidence: {
            searchEvidence,
            verifiedSourceEvidence,
            sandboxProducingEvidence: hasSandboxProducingEvidence(toolEvents),
            visualVerificationEvidence,
        },
        failureTags,
    };
}

function clampScore(value = 0) {
    return Math.max(0, Math.min(1, Number(value || 0)));
}

function scorePerceivedIntelligence({
    objective = '',
    memoryTrace = null,
    executionTrace = [],
    toolEvents = [],
    projectKey = '',
    clientSurface = '',
    harness = null,
} = {}) {
    const memoryReadSetSummary = summarizeMemoryReadSet(memoryTrace, { projectKey, clientSurface });
    const initiativeReview = buildInitiativeReview({ executionTrace, toolEvents, harness });
    const groundingAndVerification = assessGroundingAndVerification({
        objective,
        harness,
        toolEvents,
        initiativeReview,
    });
    const failureTags = [
        ...(memoryReadSetSummary.foreignProjectEntries.length > 0 ? ['cross_project_recall'] : []),
        ...(memoryReadSetSummary.foreignSurfaceEntries.length > 0 ? ['cross_surface_recall'] : []),
        ...initiativeReview.failureTags,
        ...groundingAndVerification.failureTags,
    ];
    const perceivedIntelligenceScores = {
        continuity: clampScore(1 - (initiativeReview.totalRounds > 0 && initiativeReview.productiveRounds === 0 ? 0.35 : 0)),
        initiative: clampScore(1 - (initiativeReview.failureTags.includes('unproductive_round') ? 0.35 : 0) - (initiativeReview.failureTags.includes('repeated_replan') ? 0.2 : 0)),
        plannerDiscipline: clampScore(0.92
            - (initiativeReview.failureTags.includes('repeated_command_blocked') ? 0.18 : 0)
            - (initiativeReview.failureTags.includes('premature_stop_after_failure') ? 0.28 : 0)
            - (initiativeReview.failureTags.includes('premature_synthesis_with_unmet_criteria') ? 0.3 : 0)
            - (initiativeReview.failureTags.includes('checkpoint_overuse') ? 0.12 : 0)),
        recovery: clampScore(initiativeReview.toolFailures > 0
            ? (initiativeReview.successfulRecovery ? 0.92 : 0.62)
            : 0.9),
        completionDiscipline: clampScore(0.92
            - (initiativeReview.unmetCriteriaCount > 0 && initiativeReview.lastDecision === 'synthesize' ? 0.35 : 0)
            - (initiativeReview.completionStatus === 'unknown' ? 0.08 : 0)),
        autonomyDepth: clampScore(0.72
            + (initiativeReview.totalRounds >= 2 ? 0.12 : 0)
            + (initiativeReview.stateChangingRounds > 0 ? 0.08 : 0)
            + (initiativeReview.successfulRecovery ? 0.08 : 0)
            - (initiativeReview.failureTags.includes('stalled_after_failure') ? 0.2 : 0)),
        resumeContinuity: clampScore(initiativeReview.resumeAvailable
            ? 0.9
            : (initiativeReview.unmetCriteriaCount > 0 ? 0.68 : 0.86)),
        groundedness: clampScore(Array.isArray(toolEvents) && toolEvents.length > 0 && toolEvents.some((event) => event?.result?.success === false) ? 0.78 : 0.92),
        sourceDiscipline: clampScore(0.92
            - (groundingAndVerification.failureTags.includes('missing_grounded_research') ? 0.42 : 0)
            - (groundingAndVerification.failureTags.includes('unverified_research_sources') ? 0.22 : 0)),
        sandboxDiscipline: clampScore(0.92
            - (groundingAndVerification.failureTags.includes('missing_sandbox_verification') ? 0.36 : 0)),
        isolation: clampScore(1 - (memoryReadSetSummary.foreignProjectEntries.length > 0 ? 0.9 : 0) - (memoryReadSetSummary.foreignSurfaceEntries.length > 0 ? 0.45 : 0)),
        surfaceDiscipline: clampScore(memoryReadSetSummary.foreignSurfaceEntries.length > 0 ? 0.55 : 0.92),
    };

    return {
        crossScopeReuse: {
            foreignProjectCount: memoryReadSetSummary.foreignProjectEntries.length,
            foreignSurfaceCount: memoryReadSetSummary.foreignSurfaceEntries.length,
            userGlobalCount: memoryReadSetSummary.userGlobalCount,
        },
        memoryReadSetSummary,
        groundingAndVerification,
        initiativeReview,
        perceivedIntelligenceScores,
        failureTags: Array.from(new Set(failureTags)),
    };
}

module.exports = {
    assessGroundingAndVerification,
    buildInitiativeReview,
    inferSurfaceFinisher,
    normalizeFixture,
    scorePerceivedIntelligence,
    summarizeMemoryReadSet,
};

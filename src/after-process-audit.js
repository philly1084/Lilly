const { randomUUID } = require('crypto');
const { createResponse } = require('./openai-client');
const { extractResponseText } = require('./artifacts/artifact-service');
const { parseLenientJson } = require('./utils/lenient-json');
const settingsController = require('./routes/admin/settings.controller');

const AUDIT_HISTORY_LIMIT = 12;
const TEXT_LIMIT = 900;

function trimText(value = '', limit = TEXT_LIMIT) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length <= limit) {
        return text;
    }
    return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeArray(value = [], limit = 8, itemLimit = 180) {
    const source = Array.isArray(value) ? value : [];
    return source
        .map((entry) => {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                return Object.fromEntries(
                    Object.entries(entry)
                        .slice(0, 8)
                        .map(([key, nested]) => [key, typeof nested === 'string' ? trimText(nested, itemLimit) : nested]),
                );
            }
            return trimText(entry, itemLimit);
        })
        .filter((entry) => {
            if (typeof entry === 'string') return Boolean(entry);
            return Boolean(entry && typeof entry === 'object');
        })
        .slice(0, limit);
}

function normalizeBooleanFlag(value, fallback = true) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    return fallback;
}

function resolveAfterProcessAuditConfig(overrides = {}) {
    const orchestration = typeof settingsController.getEffectiveOrchestrationConfig === 'function'
        ? settingsController.getEffectiveOrchestrationConfig()
        : {};
    const envEnabled = process.env.KIMIBUILT_AFTER_PROCESS_AUDIT;
    const enabled = overrides.enabled !== undefined
        ? Boolean(overrides.enabled)
        : (envEnabled !== undefined
            ? normalizeBooleanFlag(envEnabled, orchestration.afterProcessAuditEnabled !== false)
            : orchestration.afterProcessAuditEnabled !== false);

    return {
        enabled,
        model: String(
            overrides.model
            || orchestration.afterProcessAuditModel
            || orchestration.evaluatorModel
            || orchestration.defaultModel
            || 'gpt-5.5',
        ).trim() || 'gpt-5.5',
        reasoningEffort: String(
            overrides.reasoningEffort
            || orchestration.afterProcessAuditReasoningEffort
            || orchestration.evaluatorReasoningEffort
            || 'medium',
        ).trim() || 'medium',
        applyLearningGuidance: orchestration.applyAlignmentGuidance !== false,
    };
}

function summarizeToolEvents(toolEvents = []) {
    return (Array.isArray(toolEvents) ? toolEvents : []).slice(-12).map((event) => {
        const toolId = String(event?.toolCall?.function?.name || event?.result?.toolId || event?.tool || '').trim();
        const result = event?.result && typeof event.result === 'object' ? event.result : {};
        return {
            toolId,
            success: result.success !== false,
            error: result.success === false ? trimText(result.error || result.message || '', 220) : '',
            verificationStatus: result.verification?.status || '',
            summary: trimText(
                result.summary
                || result.output
                || result.data?.summary
                || result.data?.finalOutput
                || '',
                260,
            ),
        };
    }).filter((entry) => entry.toolId);
}

function summarizeSelectedSkills(selectedSkills = []) {
    return (Array.isArray(selectedSkills) ? selectedSkills : []).slice(0, 12).map((skill) => ({
        id: String(skill?.id || skill?.skillId || '').trim(),
        name: trimText(skill?.name || skill?.label || '', 80),
        confidence: skill?.confidence ?? skill?.score ?? null,
        reason: trimText(skill?.reason || skill?.matchReason || '', 180),
    })).filter((skill) => skill.id || skill.name);
}

function buildAuditEvidence(input = {}) {
    const trace = input.trace && typeof input.trace === 'object' ? input.trace : {};
    const metadata = input.responseMetadata && typeof input.responseMetadata === 'object' ? input.responseMetadata : {};
    const orchestrationConfig = input.orchestrationConfig && typeof input.orchestrationConfig === 'object'
        ? input.orchestrationConfig
        : {};

    return {
        sessionId: input.sessionId || '',
        taskType: input.taskType || trace.taskType || '',
        executionProfile: input.executionProfile || trace.executionProfile || '',
        runtimeMode: input.runtimeMode || trace.runtimeMode || '',
        objective: trimText(input.objective || input.userText || '', 1800),
        assistantOutput: trimText(input.output || '', 2200),
        orchestrationFlags: {
            orchestrationEnabled: orchestrationConfig.enabled !== false,
            agentDirectedRuntime: orchestrationConfig.agentDirectedRuntime === true,
            neuralWaveResearchMode: orchestrationConfig.neuralWaveResearchMode === true,
            asyncRuntimeEnabled: orchestrationConfig.asyncRuntimeEnabled === true,
            asyncRuntimeWebChatParallel: orchestrationConfig.asyncRuntimeWebChatParallel === true,
            asyncRuntimeAllowLiveRemote: orchestrationConfig.asyncRuntimeAllowLiveRemote === true,
            alignmentEvaluatorEnabled: orchestrationConfig.enableAlignmentEvaluator !== false,
            alignmentGuidanceApplied: orchestrationConfig.applyAlignmentGuidance !== false,
            afterProcessAuditEnabled: orchestrationConfig.afterProcessAuditEnabled !== false,
        },
        modelLanes: {
            defaultModel: orchestrationConfig.defaultModel || '',
            plannerModel: orchestrationConfig.plannerModel || '',
            synthesisModel: orchestrationConfig.synthesisModel || '',
            repairModel: orchestrationConfig.repairModel || '',
            evaluatorModel: orchestrationConfig.evaluatorModel || '',
            afterProcessAuditModel: orchestrationConfig.afterProcessAuditModel || orchestrationConfig.evaluatorModel || orchestrationConfig.defaultModel || '',
        },
        decisionTrace: metadata.decisionTrace || trace.decisionTrace || null,
        agencyProfile: metadata.agencyProfile || trace.agencyProfile || null,
        rolePipeline: metadata.rolePipeline || trace.rolePipeline || null,
        activeTaskFrame: metadata.activeTaskFrame || trace.activeTaskFrame || null,
        verification: metadata.verification || trace.verification || null,
        selectedSkills: summarizeSelectedSkills(metadata.selectedSkills || trace.selectedSkills || []),
        skillsUsed: normalizeArray(metadata.skillsUsed || trace.skillsUsed || [], 12, 80),
        toolReadiness: normalizeArray(metadata.toolReadiness || trace.toolReadiness || [], 12, 200),
        candidateTools: normalizeArray(trace.tools || [], 16, 80),
        toolEvents: summarizeToolEvents(input.toolEvents || []),
        failureTags: normalizeArray(metadata.failureTags || trace.failureTags || [], 10, 120),
        perceivedIntelligenceScores: metadata.perceivedIntelligenceScores || trace.perceivedIntelligenceScores || null,
        memoryReadSetSummary: metadata.memoryReadSetSummary || trace.memoryReadSetSummary || null,
        initiativeReview: metadata.initiativeReview || trace.initiativeReview || null,
        executionTrace: normalizeArray(
            (Array.isArray(input.executionTrace) ? input.executionTrace : trace.executionTrace || [])
                .slice(-12)
                .map((step) => ({
                    type: step?.type || '',
                    name: trimText(step?.name || step?.label || '', 100),
                    status: step?.status || '',
                    detail: trimText(step?.reason || step?.message || step?.details?.reason || '', 180),
                })),
            12,
            180,
        ),
    };
}

function buildAfterProcessAuditPrompt(input = {}) {
    const evidence = buildAuditEvidence(input);
    return [
        'Run a strict after-process audit for a completed KimiBuilt call.',
        'Return compact JSON only. Do not call tools, do not rewrite files, and do not claim durable changes were made.',
        'Judge how the tools, skills, and orchestration flags interacted after the work finished.',
        'Pay special attention to whether the active orchestration flags made sense together: agent-directed runtime, neural-wave R&D, async Valkey lanes, alignment guidance, and this after-process audit flag.',
        'Review selected skills against actual tool events, tool readiness, verification depth, route decisions, model lanes, and durable-learning opportunities.',
        'Allowed auditDecision values: pass, watch, needs_followup.',
        'Return JSON keys: auditDecision, qualityScore, summary, orchestrationReview, toolSkillReview, learningReview, recommendedFlagChanges, followUpActions.',
        'orchestrationReview must include flagsConsidered, interactionFindings, routingFindings, and modelLaneFindings arrays.',
        'toolSkillReview must include selectedSkills, actualTools, missingTools, misusedTools, skillUpdates, and toolPolicyUpdates arrays.',
        'learningReview must include durableLessons, selfReflectionUpdateSuggestions, regressionFixtureCandidates, and outputQualityRisks arrays.',
        'recommendedFlagChanges must be suggestions only with flag, currentValue, suggestedValue, reason, and confidence. Never say a flag was changed.',
        'selfReflectionUpdateSuggestions must be dry-run suggestion metadata only; do not include secrets, logs, transcripts, code dumps, or broad rewrites.',
        'Prefer a small set of high-signal findings over generic praise.',
        '',
        `[Audit evidence]\n${JSON.stringify(evidence)}`,
    ].join('\n');
}

function normalizeAuditResult(raw = {}, fallback = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const decision = ['pass', 'watch', 'needs_followup'].includes(source.auditDecision)
        ? source.auditDecision
        : fallback.auditDecision || 'watch';
    const score = Number(source.qualityScore);
    const orchestrationReview = source.orchestrationReview && typeof source.orchestrationReview === 'object'
        ? source.orchestrationReview
        : {};
    const toolSkillReview = source.toolSkillReview && typeof source.toolSkillReview === 'object'
        ? source.toolSkillReview
        : {};
    const learningReview = source.learningReview && typeof source.learningReview === 'object'
        ? source.learningReview
        : {};

    return {
        auditDecision: decision,
        qualityScore: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.5,
        summary: trimText(source.summary || fallback.summary || 'After-process audit completed.', 360),
        orchestrationReview: {
            flagsConsidered: normalizeArray(orchestrationReview.flagsConsidered, 12, 120),
            interactionFindings: normalizeArray(orchestrationReview.interactionFindings, 8, 220),
            routingFindings: normalizeArray(orchestrationReview.routingFindings, 8, 220),
            modelLaneFindings: normalizeArray(orchestrationReview.modelLaneFindings, 8, 220),
        },
        toolSkillReview: {
            selectedSkills: normalizeArray(toolSkillReview.selectedSkills, 12, 120),
            actualTools: normalizeArray(toolSkillReview.actualTools, 12, 120),
            missingTools: normalizeArray(toolSkillReview.missingTools, 8, 140),
            misusedTools: normalizeArray(toolSkillReview.misusedTools, 8, 140),
            skillUpdates: normalizeArray(toolSkillReview.skillUpdates, 6, 220),
            toolPolicyUpdates: normalizeArray(toolSkillReview.toolPolicyUpdates, 6, 220),
        },
        learningReview: {
            durableLessons: normalizeArray(learningReview.durableLessons, 6, 220),
            selfReflectionUpdateSuggestions: normalizeArray(learningReview.selfReflectionUpdateSuggestions, 2, 400),
            regressionFixtureCandidates: normalizeArray(learningReview.regressionFixtureCandidates, 4, 220),
            outputQualityRisks: normalizeArray(learningReview.outputQualityRisks, 6, 220),
        },
        recommendedFlagChanges: normalizeArray(source.recommendedFlagChanges, 6, 220),
        followUpActions: normalizeArray(source.followUpActions, 8, 220),
    };
}

function buildFallbackAudit(input = {}) {
    const evidence = buildAuditEvidence(input);
    const failedTools = evidence.toolEvents.filter((event) => event.success === false);
    const hasVerification = evidence.verification?.verifiedEvidence > 0
        || evidence.toolEvents.some((event) => event.verificationStatus === 'observed');
    const needsFollowup = failedTools.length > 0 || evidence.failureTags.length > 0;
    return normalizeAuditResult({
        auditDecision: needsFollowup ? 'needs_followup' : 'watch',
        qualityScore: needsFollowup ? 0.45 : 0.7,
        summary: needsFollowup
            ? 'The completed call has failed tool events or quality-risk tags that need follow-up review.'
            : 'The completed call was recorded for after-process review with no obvious deterministic blocker.',
        orchestrationReview: {
            flagsConsidered: Object.keys(evidence.orchestrationFlags),
            interactionFindings: [],
            routingFindings: evidence.decisionTrace ? [] : ['No decision trace was available for route review.'],
            modelLaneFindings: [],
        },
        toolSkillReview: {
            selectedSkills: evidence.selectedSkills.map((skill) => skill.id || skill.name),
            actualTools: evidence.toolEvents.map((event) => event.toolId),
            missingTools: [],
            misusedTools: failedTools.map((event) => event.toolId),
            skillUpdates: [],
            toolPolicyUpdates: [],
        },
        learningReview: {
            durableLessons: [],
            selfReflectionUpdateSuggestions: [],
            regressionFixtureCandidates: [],
            outputQualityRisks: hasVerification ? [] : ['Verification evidence is absent or indirect.'],
        },
        recommendedFlagChanges: [],
        followUpActions: needsFollowup
            ? [{ type: 'review', priority: 'high', description: 'Inspect failed tools and route decisions before reusing this workflow.' }]
            : [],
    });
}

async function runAfterProcessAudit(input = {}, options = {}) {
    const config = resolveAfterProcessAuditConfig(options);
    const auditId = input.auditId || `after_audit_${randomUUID()}`;
    if (config.enabled === false) {
        return {
            auditId,
            status: 'skipped',
            reason: 'after-process audit disabled',
            model: null,
        };
    }

    const prompt = buildAfterProcessAuditPrompt({
        ...input,
        orchestrationConfig: input.orchestrationConfig || (
            typeof settingsController.getEffectiveOrchestrationConfig === 'function'
                ? settingsController.getEffectiveOrchestrationConfig()
                : {}
        ),
    });
    const response = await (options.createResponse || createResponse)({
        input: prompt,
        instructions: 'You are KimiBuilt after-process audit, a strict post-work reviewer for orchestration, tools, skills, verification, and durable-learning quality. Return only compact JSON.',
        stream: false,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
    });
    const parsed = parseLenientJson(extractResponseText(response));
    const audit = normalizeAuditResult(parsed, buildFallbackAudit(input));

    return {
        auditId,
        status: 'completed',
        audit,
        model: response?.model || config.model,
        reasoningEffort: config.reasoningEffort,
        completedAt: new Date().toISOString(),
    };
}

function buildAuditSessionPatch(existingMetadata = {}, auditResult = {}) {
    if (!auditResult || auditResult.status === 'skipped') {
        return {};
    }
    const history = Array.isArray(existingMetadata?.afterProcessAuditHistory)
        ? existingMetadata.afterProcessAuditHistory.slice(-(AUDIT_HISTORY_LIMIT - 1))
        : [];
    const entry = {
        auditId: auditResult.auditId || `after_audit_${randomUUID()}`,
        status: auditResult.status || 'completed',
        model: auditResult.model || null,
        completedAt: auditResult.completedAt || new Date().toISOString(),
        audit: auditResult.audit || null,
    };
    return {
        afterProcessAudit: entry,
        afterProcessAuditHistory: [...history, entry],
    };
}

module.exports = {
    buildAfterProcessAuditPrompt,
    buildAuditEvidence,
    buildAuditSessionPatch,
    buildFallbackAudit,
    normalizeAuditResult,
    resolveAfterProcessAuditConfig,
    runAfterProcessAudit,
};

const { Router } = require('express');
const { config } = require('../config');
const { validate } = require('../middleware/validate');
const { sessionStore } = require('../session-store');
const { memoryService } = require('../memory/memory-service');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const {
    executeConversationRuntime,
    inferExecutionProfile,
    resolveConversationExecutorFlag,
    scheduleDirectAfterProcessAudit,
} = require('../runtime-execution');
const {
    buildInstructionsWithArtifacts,
    maybeGenerateOutputArtifact,
    generateOutputArtifactFromPrompt,
    inferRequestedOutputFormat,
    maybePrepareImagesForArtifactPrompt,
    resolveDeferredWorkloadPreflight,
    shouldSuppressNotesSurfaceArtifact,
    shouldSuppressImplicitMermaidArtifact,
    shouldSuppressWebChatImplicitHtmlArtifact,
    shouldSuppressArtifactGenerationForRemoteAction,
    shouldGenerateOutputArtifactForToolResponse,
    shouldSuppressResearchFirstArtifactGeneration,
    isArtifactStorageAvailable,
    stripInjectedNotesPageEditDirective,
    resolveSshRequestContext,
    extractSshSessionMetadataFromToolEvents,
    inferOutputFormatFromSession,
    inferOutputFormatFromArtifactContext,
    resolveArtifactContextIds,
    buildUserInputWithImageArtifacts,
    buildPiiWorkbookRelationshipToolContext,
    resolveReasoningEffort,
} = require('../ai-route-utils');
const {
    extractResponseText,
    resolveCompletedResponseText,
    getMissingCompletionDelta,
    artifactService,
} = require('../artifacts/artifact-service');
const { extractSaveableDocumentArtifact } = require('../artifacts/saveable-document-extractor');
const { startRuntimeTask, completeRuntimeTask, failRuntimeTask } = require('../admin/runtime-monitor');
const settingsController = require('./admin/settings.controller');
const { resolveChatTimeAfterProcessAuditHints } = require('../after-process-audit-hints');
const {
    buildContextContinuityFrame,
    resolveTranscriptObjectiveFromSession,
} = require('../conversation-continuity');
const {
    buildActiveProjectPreviewUpdate,
    buildProjectMemoryUpdate,
    mergeProjectMemory,
} = require('../project-memory');
const {
    buildRequestDecisionFrame,
    buildRequestDecisionMetadata,
    buildRequestFrameProgress,
    executeWithAdaptiveReasoningFallback,
    formatRequestDecisionFrameForPrompt,
} = require('../request-decision-frame');
const { buildContinuityInstructions } = require('../runtime-prompts');
const { buildHumanCentricResponseInstructions } = require('../session-instructions');
const { buildFrontendAssistantMetadata, buildWebChatSessionMessages } = require('../web-chat-message-state');
const { normalizeMemoryKeywords } = require('../memory/memory-keywords');
const { extractArtifactsFromToolEvents, mergeRuntimeArtifacts } = require('../runtime-artifacts');
const { getSessionControlState } = require('../runtime-control-state');
const {
    buildUserCheckpointInstructions,
    buildUserCheckpointPolicy,
} = require('../user-checkpoints');
const {
    buildAgentJournalInstructions,
    loadAgentJournalEntries,
    recordAgentJournalTurn,
    stripAgentJournalBlocks,
} = require('../agent-journal');
const {
    applyAnsweredUserCheckpointState,
    applyAskedUserCheckpointState,
    buildUserCheckpointPolicyMetadata,
    resolveAnsweredUserCheckpointInput,
} = require('../web-chat-user-checkpoints');
const {
    buildScopedMemoryMetadata,
    buildScopedSessionMetadata,
    isSessionIsolationEnabled,
    resolveClientSurface,
    resolveSessionScope,
} = require('../session-scope');
const {
    beginForegroundTurn,
    buildForegroundTurnMessageOptions,
    persistForegroundTurnMessages,
} = require('../foreground-turn-state');
const {
    buildNaturalContext,
    buildNaturalContextInstructions,
    buildRegisteredSkillsInstructions,
    buildSkillsTreeInstructions,
} = require('../natural-context');
const {
    resolveAgentDirectedRuntimeFlag,
} = require('../agent-directed-runtime');
const {
    buildDirectPodcastAssistantMessage,
    buildDirectPodcastParams,
    shouldUseDirectPodcastChat,
} = require('../podcast/direct-podcast-chat');
const {
    buildAlignmentGuidanceContext,
    buildFallbackEvaluation,
    buildRegressionFixtureCandidate,
    evaluateAlignment,
} = require('../alignment/evaluator-service');
const { rehydrateText, sanitizeText } = require('../pii');
const { startHttpAgentRunShadow } = require('../agent-runs/runtime-bridge');

const router = Router();
const WORKLOAD_PREFLIGHT_RECENT_LIMIT = config.memory.recentTranscriptLimit;
const ALIGNMENT_FEEDBACK_HISTORY_LIMIT = 12;
const ALIGNMENT_ROUTE_PATTERN_LIMIT = 16;
const ALIGNMENT_REGRESSION_FIXTURE_LIMIT = 24;
const ALIGNMENT_TOOL_REINFORCEMENT_LIMIT = 32;

router.use(async (req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/') {
        return next();
    }
    await startHttpAgentRunShadow(req, res, {
        surface: 'web-chat',
        mode: 'chat',
        sessionId: req.body?.sessionId || req.body?.session_id || null,
        requestId: req.get('x-request-id')
            || req.body?.requestId
            || req.body?.request_id
            || req.body?.metadata?.requestId
            || req.body?.metadata?.request_id
            || '',
        startedAt: new Date().toISOString(),
        operation: 'chat',
        objective: req.body?.message || 'Web chat request',
        state: 'executing',
        metadata: {
            route: '/api/chat',
            transport: req.body?.stream === false ? 'http' : 'sse',
        },
    });
    return next();
});

function compactPiiContextIds(...sources) {
    const ids = [];
    sources.forEach((source) => {
        if (!source) return;
        if (Array.isArray(source)) {
            source.forEach((id) => ids.push(id));
            return;
        }
        if (Array.isArray(source.contextIds)) {
            source.contextIds.forEach((id) => ids.push(id));
        }
        if (source.contextId) {
            ids.push(source.contextId);
        }
    });
    return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function buildPiiCleansingMetadata(routePii = null, executionPii = null, presentation = null) {
    const contextIds = compactPiiContextIds(routePii, executionPii);
    const replacementCount = Number(routePii?.replacements?.length || 0)
        + Number(executionPii?.replacementCount || 0);
    const enabled = routePii?.policy?.enabled === true || executionPii?.enabled === true || presentation?.enabled === true;
    if (!enabled && contextIds.length === 0 && replacementCount === 0) {
        return null;
    }
    return {
        enabled,
        contextIds,
        replacementCount,
        restoredCount: Array.isArray(presentation?.restorations) ? presentation.restorations.length : 0,
        placeholderMode: routePii?.policy?.placeholderMode || executionPii?.placeholderMode || '',
        relationshipCalculations: routePii?.policy?.relationshipCalculations
            || executionPii?.relationshipCalculations
            || null,
    };
}

function buildPiiToolEntries(routePii = null) {
    return (Array.isArray(routePii?.replacements) ? routePii.replacements : [])
        .filter((entry) => entry?.placeholder && entry?.valueIndexHmac)
        .map((entry) => ({
            placeholder: entry.placeholder,
            valueIndexHmac: entry.valueIndexHmac,
            piiType: entry.type || 'PII',
        }));
}

function shouldSuppressPiiRelationshipFormulaArtifact({
    routePii = null,
    text = '',
    outputFormat = null,
    outputFormatProvided = false,
} = {}) {
    if (outputFormatProvided || !outputFormat) {
        return false;
    }
    const relationshipCalculations = routePii?.policy?.relationshipCalculations || {};
    if (relationshipCalculations.active !== true) {
        return false;
    }
    const normalized = String(text || '').toLowerCase();
    return /\bxlsx_formula_plan\b/.test(normalized)
        || /\bformula plan\b/.test(normalized)
        || /\bdo not\s+(?:create|generate|make|produce|write)[\s\S]{0,80}\b(?:artifact|file|workbook|xlsx|download)\b/.test(normalized);
}

async function buildTrustedPiiPresentation(text = '', {
    sessionId = '',
    ownerId = null,
    contextIds = [],
    metadata = {},
    clientSurface = '',
    route = '',
} = {}) {
    try {
        return await rehydrateText(text, {
            sessionId,
            ownerId,
            contextIds,
            metadata,
            clientSurface,
            route,
            highlight: true,
        });
    } catch (error) {
        console.warn(`[PII] Failed to rehydrate ${route || 'chat'} presentation: ${error.message}`);
        return { text: String(text || ''), restorations: [], enabled: false };
    }
}

function buildAssistantUiMetadata(baseMetadata = {}, artifacts = [], piiMetadata = null, presentation = null) {
    return buildFrontendAssistantMetadata({
        ...(baseMetadata || {}),
        artifacts,
        ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
        ...(presentation?.restorations?.length > 0
            ? {
                displayContent: presentation.text,
                piiRestorations: presentation.restorations,
            }
            : {}),
    });
}

function formatTrustedPiiRelationshipMessage(result = {}) {
    const data = result?.data && typeof result.data === 'object' ? result.data : result;
    if (data?.operation === 'batch' && Array.isArray(data.results)) {
        return JSON.stringify({
            calculation_count: data.results.length,
            calculations: data.results.map((entry) => ({
                operation_id: entry?.operationId || null,
                operation: entry?.operation || null,
                group_placeholder: entry?.winnerPlaceholder || null,
                aggregate_value: typeof entry?.aggregateValue === 'number' ? entry.aggregateValue : null,
                contributing_row_count: typeof entry?.rowCount === 'number' ? entry.rowCount : null,
                result_count: Array.isArray(entry?.results) ? entry.results.length : null,
                formula_plan: entry?.formulaPlan ? {
                    type: entry.formulaPlan.type || 'xlsx_formula_plan',
                    target_cells: Array.isArray(entry.formulaPlan.targetCells) ? entry.formulaPlan.targetCells : [],
                    returns_winner_to_model: entry.formulaPlan.privacy?.returnsWinnerToModel === true,
                } : null,
            })),
        });
    }
    const patientUid = data?.winnerPlaceholder || '';
    const total = typeof data?.aggregateValue === 'number'
        ? data.aggregateValue
        : null;
    const rowCount = typeof data?.rowCount === 'number'
        ? data.rowCount
        : null;
    const evidenceRowIds = Array.isArray(data?.evidenceRowIds)
        ? data.evidenceRowIds
        : [];
    return JSON.stringify({
        patient_uid: patientUid || null,
        total_patient_balance: total,
        contributing_row_count: rowCount,
        evidence_row_ids: evidenceRowIds,
    });
}

function buildTrustedPiiRelationshipWorkbookContent(result = {}) {
    const data = result?.data && typeof result.data === 'object' ? result.data : result;
    if (data?.operation === 'batch' && Array.isArray(data.results)) {
        const rows = [
            'operation_id | operation | group_value | aggregate_value | contributing_row_count | result_count',
            ...data.results.map((entry) => [
                entry?.operationId || '',
                entry?.operation || '',
                entry?.winnerPlaceholder || '',
                typeof entry?.aggregateValue === 'number' ? entry.aggregateValue : '',
                typeof entry?.rowCount === 'number' ? entry.rowCount : '',
                Array.isArray(entry?.results) ? entry.results.length : '',
            ].join(' | ')),
        ];
        return rows.join('\n');
    }
    const evidenceRowIds = Array.isArray(data?.evidenceRowIds)
        ? data.evidenceRowIds.join(', ')
        : '';
    return [
        'patient_uid | total_patient_balance | contributing_row_count | evidence_row_ids',
        [
            data?.winnerPlaceholder || '',
            typeof data?.aggregateValue === 'number' ? data.aggregateValue : '',
            typeof data?.rowCount === 'number' ? data.rowCount : '',
            evidenceRowIds,
        ].join(' | '),
    ].join('\n');
}

function summarizeTrustedPiiRelationshipRequest(request = {}) {
    const tables = Array.isArray(request.tables) ? request.tables : [];
    return {
        operationId: request.operationId || null,
        operation: request.operation || null,
        tableId: request.tableId || null,
        groupBy: request.groupBy || null,
        measure: request.measure || null,
        limit: request.limit || null,
        tableCount: tables.length,
        tables: tables.map((table) => ({
            id: table.id || null,
            rowCount: Array.isArray(table.rows) ? table.rows.length : 0,
            columnCount: Array.isArray(table.columns) ? table.columns.length : 0,
            columns: (Array.isArray(table.columns) ? table.columns : []).map((column) => ({
                id: column.id || null,
                role: column.role || null,
            })),
        })),
        valuesIncluded: false,
        relationshipKeysIncluded: false,
        ...(Array.isArray(request.operations)
            ? {
                operations: request.operations.map((operation) => ({
                    operationId: operation?.operationId || null,
                    operation: operation?.operation || null,
                    tableId: operation?.tableId || null,
                    groupBy: operation?.groupBy || null,
                    measure: operation?.measure || null,
                    measures: Array.isArray(operation?.measures) ? operation.measures : undefined,
                    subtractMeasures: Array.isArray(operation?.subtractMeasures) ? operation.subtractMeasures : undefined,
                    limit: operation?.limit || null,
                    filterCount: Array.isArray(operation?.filters) ? operation.filters.length : 0,
                })),
            }
            : {}),
    };
}

function summarizeTrustedPiiRelationshipResult(result = {}) {
    const data = result?.data && typeof result.data === 'object' ? result.data : result;
    return {
        success: result?.success !== false,
        operation: data?.operation || null,
        sanitized: data?.sanitized === true,
        aggregateValue: typeof data?.aggregateValue === 'number' ? data.aggregateValue : null,
        rowCount: typeof data?.rowCount === 'number' ? data.rowCount : null,
        resultCount: Array.isArray(data?.results) ? data.results.length : null,
        ...(Array.isArray(data?.results)
            ? {
                results: data.results.map((entry) => ({
                    operationId: entry?.operationId || null,
                    operation: entry?.operation || null,
                    sanitized: entry?.sanitized === true,
                    aggregateValue: typeof entry?.aggregateValue === 'number' ? entry.aggregateValue : null,
                    rowCount: typeof entry?.rowCount === 'number' ? entry.rowCount : null,
                    resultCount: Array.isArray(entry?.results) ? entry.results.length : null,
                    formulaPlanReturned: Boolean(entry?.formulaPlan),
                })),
            }
            : {}),
        valuesIncluded: false,
        relationshipKeysIncluded: false,
    };
}

function getPodcastRequestOptions(metadata = {}) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const options = source.podcastOptions || source.podcastProduction || null;
    return options && typeof options === 'object' ? options : null;
}

function hasStructuredPodcastRequest(metadata = {}) {
    const options = getPodcastRequestOptions(metadata);
    if (!options) {
        return false;
    }

    return options.enabled === true
        || options.includeVideo === true
        || options.productionType === 'podcast'
        || options.productionType === 'video-podcast';
}

function normalizeAlignmentRating(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'up' || normalized === 'down') {
        return normalized;
    }
    return '';
}

function buildAlignmentFeedbackId() {
    return `align_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function findAlignmentTurnMessages(messages = [], assistantMessageId = '') {
    const normalizedMessageId = String(assistantMessageId || '').trim();
    const source = Array.isArray(messages) ? messages : [];
    const assistantIndex = source.findIndex((message) => String(message?.id || '').trim() === normalizedMessageId);
    const assistant = assistantIndex >= 0 ? source[assistantIndex] : null;
    const user = assistantIndex > 0
        ? [...source.slice(0, assistantIndex)].reverse().find((message) => message?.role === 'user')
        : null;

    return { assistant, user };
}

function buildAlignmentFeedbackMetadata({
    feedbackId = '',
    rating = '',
    status = 'recorded',
    reason = '',
    evaluation = null,
    model = null,
    previous = {},
} = {}) {
    const updatedAt = new Date().toISOString();
    return {
        ...(previous && typeof previous === 'object' ? previous : {}),
        feedbackId,
        evaluationId: feedbackId,
        rating,
        status,
        updatedAt,
        ...(reason ? { reason: String(reason || '').trim().slice(0, 500) } : {}),
        ...(evaluation ? { evaluation } : {}),
        ...(model ? { model } : {}),
    };
}

function appendAlignmentHistory(session = null, entry = {}) {
    const existing = Array.isArray(session?.metadata?.alignmentFeedbackHistory)
        ? session.metadata.alignmentFeedbackHistory
        : [];
    const feedbackId = String(entry.feedbackId || entry.evaluationId || '').trim();
    const next = [
        ...existing.filter((item) => String(item?.feedbackId || item?.evaluationId || '').trim() !== feedbackId),
        entry,
    ];
    return next.slice(-ALIGNMENT_FEEDBACK_HISTORY_LIMIT);
}

function appendAlignmentList(session = null, metadataKey = '', entry = {}, limit = 12) {
    const existing = Array.isArray(session?.metadata?.[metadataKey])
        ? session.metadata[metadataKey]
        : [];
    const entryId = String(entry?.id || entry?.feedbackId || entry?.evaluationId || '').trim();
    const next = [
        ...existing.filter((item) => String(item?.id || item?.feedbackId || item?.evaluationId || '').trim() !== entryId),
        entry,
    ];
    return next.slice(-Math.max(1, Number(limit) || 12));
}

function buildAlignmentLessonText(evaluation = {}) {
    const lesson = String(evaluation?.lesson || '').trim();
    const guidance = Array.isArray(evaluation?.decisionGuidance)
        ? evaluation.decisionGuidance.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const fixes = Array.isArray(evaluation?.fixStrategy)
        ? evaluation.fixStrategy.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const toolFixes = Array.isArray(evaluation?.toolFixes)
        ? evaluation.toolFixes.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const parts = [
        lesson,
        evaluation?.toolLesson ? `Tool lesson: ${String(evaluation.toolLesson || '').trim()}` : '',
        guidance.length > 0 ? `Guidance: ${guidance.join(' ')}` : '',
        fixes.length > 0 ? `Fix strategy: ${fixes.join(' ')}` : '',
        toolFixes.length > 0 ? `Tool fixes: ${toolFixes.join(' ')}` : '',
    ].filter(Boolean);

    return parts.join('\n');
}

async function maybeRememberAlignmentLesson(sessionId = '', {
    session = null,
    userText = '',
    assistantText = '',
    evaluation = null,
    clientSurface = '',
    rating = 'down',
} = {}) {
    if (!sessionId || !evaluation || typeof memoryService?.rememberLearnedSkill !== 'function') {
        return;
    }

    const routeDecision = String(evaluation.routeDecision || '').trim();
    const shouldRemember = rating === 'up'
        || evaluation.memoryCandidate === true
        || routeDecision === 'wrong_route'
        || evaluation.decision === 'misaligned';
    if (!shouldRemember) {
        return;
    }

    const lessonText = buildAlignmentLessonText(evaluation);
    if (!lessonText) {
        return;
    }

    try {
        await memoryService.rememberLearnedSkill(sessionId, {
            objective: userText,
            assistantText: lessonText,
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'alignment-evaluator',
                        arguments: JSON.stringify({
                            requestType: evaluation.requestType || 'unknown',
                            routeDecision: evaluation.routeDecision || 'route_unclear',
                            expectedRoute: evaluation.expectedRoute || '',
                            actualRoute: evaluation.actualRoute || '',
                        }),
                    },
                },
                result: {
                    success: true,
                    toolId: 'alignment-evaluator',
                    data: {
                        summary: evaluation.summary || '',
                        lesson: lessonText,
                    },
                },
                reason: 'Persist a reusable routing lesson from negative web-chat alignment feedback.',
            }],
            metadata: buildOwnerMemoryMetadata(null, session?.metadata?.memoryScope || clientSurface || 'web-chat', {
                sourceSurface: clientSurface || session?.metadata?.clientSurface || 'web-chat',
                projectKey: session?.metadata?.projectKey || null,
                memoryClass: rating === 'up' ? 'successful_route_pattern' : 'reusable_skill',
                memoryKeywords: [
                    'alignment feedback',
                    rating === 'up' ? 'positive review' : 'negative review',
                    'routing lesson',
                    evaluation.requestType || '',
                    evaluation.routeDecision || '',
                    evaluation.toolUseDecision || '',
                    ...(Array.isArray(evaluation.failureCategories) ? evaluation.failureCategories : []),
                    ...(Array.isArray(evaluation.toolMisuseCategories) ? evaluation.toolMisuseCategories : []),
                    ...(Array.isArray(evaluation.expectedTools) ? evaluation.expectedTools : []),
                    ...(Array.isArray(evaluation.missingTools) ? evaluation.missingTools : []),
                    ...(Array.isArray(evaluation.misusedTools) ? evaluation.misusedTools : []),
                ],
                importance: rating === 'up' ? 0.82 : 0.95,
            }),
        });
    } catch (error) {
        console.warn('[AlignmentEvaluator] Failed to persist routing lesson:', error.message);
    }
}

function buildPositiveRoutePattern({
    feedbackId = '',
    messageId = '',
    userText = '',
    evaluation = {},
} = {}) {
    if (!evaluation || evaluation.decision !== 'aligned') {
        return null;
    }

    const route = String(evaluation.actualRoute || '').trim();
    const pattern = String(evaluation.successPattern || evaluation.lesson || '').trim();
    if (!route && !pattern) {
        return null;
    }

    return {
        id: feedbackId,
        feedbackId,
        messageId,
        requestType: evaluation.requestType || 'unknown',
        routeDecision: evaluation.routeDecision || 'correct_route',
        promptPreview: String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        actualRoute: route,
        successPattern: pattern || `Positive feedback confirmed route: ${route}`,
        lesson: evaluation.lesson || '',
        updatedAt: new Date().toISOString(),
    };
}

function buildAlignmentToolReinforcement({
    feedbackId = '',
    messageId = '',
    rating = '',
    userText = '',
    evaluation = {},
} = {}) {
    if (!evaluation || typeof evaluation !== 'object') {
        return null;
    }

    const toolUseDecision = String(evaluation.toolUseDecision || '').trim();
    const hasToolSignal = toolUseDecision
        || (Array.isArray(evaluation.expectedTools) && evaluation.expectedTools.length > 0)
        || (Array.isArray(evaluation.missingTools) && evaluation.missingTools.length > 0)
        || (Array.isArray(evaluation.misusedTools) && evaluation.misusedTools.length > 0)
        || String(evaluation.toolLesson || '').trim();
    if (!hasToolSignal) {
        return null;
    }

    return {
        id: `${feedbackId || messageId || Date.now().toString(36)}-tools`,
        feedbackId,
        messageId,
        rating,
        requestType: evaluation.requestType || 'unknown',
        promptPreview: String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        toolUseDecision: toolUseDecision || (rating === 'up' ? 'correct_tools' : 'tool_unclear'),
        toolMisuseCategories: Array.isArray(evaluation.toolMisuseCategories) ? evaluation.toolMisuseCategories.slice(0, 6) : [],
        expectedTools: Array.isArray(evaluation.expectedTools) ? evaluation.expectedTools.slice(0, 8) : [],
        actualTools: Array.isArray(evaluation.actualTools) ? evaluation.actualTools.slice(0, 8) : [],
        missingTools: Array.isArray(evaluation.missingTools) ? evaluation.missingTools.slice(0, 8) : [],
        misusedTools: Array.isArray(evaluation.misusedTools) ? evaluation.misusedTools.slice(0, 8) : [],
        toolFixes: Array.isArray(evaluation.toolFixes) ? evaluation.toolFixes.slice(0, 6) : [],
        toolLesson: evaluation.toolLesson || '',
        updatedAt: new Date().toISOString(),
    };
}

function normalizeClientNow(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return null;
    }

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeDisplayText(value = '', seen = null) {
    if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value
            .map((entry) => normalizeDisplayText(entry, seen))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    if (!value || typeof value !== 'object') {
        return '';
    }

    const visited = seen || new WeakSet();
    if (visited.has(value)) {
        return '';
    }
    visited.add(value);

    for (const key of ['summary', 'detail', 'message', 'text', 'content', 'title', 'label', 'reason', 'description', 'name', 'value']) {
        const extracted = normalizeDisplayText(value[key], visited);
        if (extracted) {
            return extracted;
        }
    }

    try {
        const serialized = JSON.stringify(value);
        return serialized && serialized !== '{}' ? serialized.replace(/\s+/g, ' ').trim() : '';
    } catch (_error) {
        return '';
    }
}

function getRequestOwnerId(req) {
    return String(req.user?.username || '').trim() || null;
}

function buildForegroundMetadata(metadata = {}, clientSurface = '', taskType = 'chat') {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const foregroundRequestId = String(
        source.foregroundRequestId
        || source.foreground_request_id
        || source.assistantMessageId
        || source.assistant_message_id
        || '',
    ).trim();
    const userMessageId = String(
        source.messageId
        || source.message_id
        || source.userMessageId
        || source.user_message_id
        || '',
    ).trim();
    const assistantMessageId = String(
        source.assistantMessageId
        || source.assistant_message_id
        || foregroundRequestId
        || '',
    ).trim();

    if (!foregroundRequestId || !userMessageId || !assistantMessageId) {
        return null;
    }

    const userTimestamp = normalizeClientNow(
        source.userMessageTimestamp
        || source.user_message_timestamp
        || source.clientNow
        || source.client_now,
    ) || new Date().toISOString();
    const assistantTimestamp = normalizeClientNow(
        source.assistantMessageTimestamp
        || source.assistant_message_timestamp,
    ) || new Date(new Date(userTimestamp).getTime() + 1).toISOString();

    return {
        requestId: foregroundRequestId,
        userMessageId,
        assistantMessageId,
        clientSurface,
        taskType,
        status: 'running',
        placeholderText: String(source.assistantPlaceholder || source.assistant_placeholder || 'Working in background...').trim()
            || 'Working in background...',
        startedAt: normalizeClientNow(source.clientNow || source.client_now) || new Date().toISOString(),
        userTimestamp,
        assistantTimestamp,
    };
}

function createForegroundProgressPersister({
    sessionStore,
    sessionId = '',
    foregroundTurn = null,
    intervalMs = config.runtime.foregroundProgressPersistIntervalMs,
} = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    const turn = foregroundTurn && typeof foregroundTurn === 'object' ? foregroundTurn : null;
    if (!sessionStore || !normalizedSessionId || !turn?.assistantMessageId) {
        return null;
    }

    let lastPersistedAt = 0;
    let pending = Promise.resolve();
    return (progress = {}) => {
        const now = Date.now();
        if (now - lastPersistedAt < intervalMs) {
            return pending;
        }
        lastPersistedAt = now;

        const progressState = progress && typeof progress === 'object' ? progress : {};
        const phase = normalizeDisplayText(progressState.phase || 'thinking') || 'thinking';
        const detail = normalizeDisplayText(progressState.detail || '');
        pending = pending
            .catch(() => null)
            .then(() => sessionStore.upsertMessage(normalizedSessionId, {
                id: turn.assistantMessageId,
                role: 'assistant',
                content: turn.placeholderText || 'Working in background...',
                timestamp: turn.assistantTimestamp || new Date().toISOString(),
                metadata: {
                    foregroundRequestId: turn.requestId,
                    taskType: turn.taskType || 'chat',
                    clientSurface: turn.clientSurface || '',
                    isStreaming: true,
                    pendingForeground: true,
                    liveState: {
                        phase,
                        detail,
                        reasoningSummary: '',
                    },
                    progressState: {
                        ...progressState,
                        phase,
                        detail,
                    },
                },
            }))
            .catch((error) => {
                console.warn(`[ChatRoute] Failed to persist foreground progress: ${error.message}`);
            });
        return pending;
    };
}

function buildOwnerMemoryMetadata(ownerId = null, memoryScope = null, extra = {}) {
    return buildScopedMemoryMetadata({
        ...(ownerId ? { ownerId } : {}),
        ...(memoryScope ? { memoryScope } : {}),
        ...extra,
    });
}

async function persistSessionModel(sessionId, session = null, model = null) {
    const normalizedModel = String(model || '').trim();
    if (!sessionId || !normalizedModel || session?.metadata?.model === normalizedModel) {
        return session;
    }

    const updated = await sessionStore.update(sessionId, {
        metadata: {
            model: normalizedModel,
        },
    });

    return updated || session;
}

async function updateSessionProjectMemory(sessionId, updates = {}, ownerId = null) {
    if (!sessionId) {
        return null;
    }

    const session = ownerId
        ? await sessionStore.getOwned(sessionId, ownerId)
        : await sessionStore.get(sessionId);
    if (!session) {
        return null;
    }

    const activeProject = buildActiveProjectPreviewUpdate(updates);

    return sessionStore.update(sessionId, {
        metadata: {
            projectMemory: mergeProjectMemory(
                session?.metadata?.projectMemory || {},
                buildProjectMemoryUpdate(updates),
            ),
            ...(activeProject ? { activeProject } : {}),
        },
    });
}

function isResponseToolOutputItem(item = {}) {
    const type = String(item?.type || '').trim();
    return type === 'function_call' || type === 'custom_tool_call';
}

async function maybePersistSaveableDocumentResponse({
    sessionId,
    mode,
    requestText = '',
    assistantText = '',
    responseId = '',
} = {}) {
    const extracted = extractSaveableDocumentArtifact({
        requestText,
        assistantText,
    });
    if (!extracted) {
        return [];
    }

    try {
        const artifact = await artifactService.storeGeneratedArtifactFromContent({
            sessionId,
            mode,
            format: extracted.format,
            content: extracted.content,
            title: extracted.title,
            metadata: {
                sourceResponseId: responseId,
                source: 'assistant-saveable-document-response',
                requestedFilename: extracted.filename || null,
                ...(extracted.metadata || {}),
            },
        });
        return [artifact];
    } catch (error) {
        console.warn('[ChatRoute] Failed to persist saveable document response:', error.message);
        return [];
    }
}

async function safeRecordAgentJournalTurn(session, details = {}) {
    try {
        return await recordAgentJournalTurn(sessionStore, session, details);
    } catch (error) {
        console.warn('[ChatRoute] Failed to update agent journal:', error.message);
        return [];
    }
}

const chatSchema = {
    message: { required: true, type: 'string' },
    sessionId: { required: false, type: 'string' },
    stream: { required: false, type: 'boolean' },
    model: { required: false, type: 'string' },
    reasoningEffort: { required: false, type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
    reasoning_effort: { required: false, type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
    reasoning: { required: false, type: 'object' },
    artifactIds: { required: false, type: 'array' },
    outputFormat: { required: false, type: 'string' },
    enableConversationExecutor: { required: false, type: 'boolean' },
    useAgentExecutor: { required: false, type: 'boolean' },
    executionProfile: { required: false, type: 'string' },
    metadata: { required: false, type: 'object' },
    memoryKeywords: { required: false, type: 'array' },
};

function resolveConversationTaskType(metadata = {}, session = null) {
    const candidates = [
        metadata?.taskType,
        metadata?.task_type,
        metadata?.clientSurface,
        metadata?.client_surface,
        session?.metadata?.taskType,
        session?.metadata?.task_type,
        session?.metadata?.clientSurface,
        session?.metadata?.client_surface,
    ];

    return candidates.find((value) => typeof value === 'string' && value.trim()) || 'chat';
}

function openSseStream(req, res, sessionId = null, route = '/api/chat') {
    let closed = false;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (sessionId) {
        res.setHeader('X-Session-Id', sessionId);
    }
    res.flushHeaders?.();
    res.write(': stream-open\n\n');

    const keepAlive = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed || req.destroyed) {
            clearInterval(keepAlive);
            return;
        }

        try {
            res.write(': keepalive\n\n');
        } catch (_error) {
            closed = true;
            clearInterval(keepAlive);
        }
    }, 15000);

    const cleanup = () => {
        closed = true;
        clearInterval(keepAlive);
    };

    req.on('aborted', cleanup);
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);

    console.log(`[ChatRoute] SSE stream opened route=${route} sessionId=${sessionId || 'unknown'}`);

    return {
        write(payload = '') {
            if (closed || res.writableEnded || res.destroyed) {
                return false;
            }

            try {
                res.write(payload);
                return true;
            } catch (_error) {
                closed = true;
                return false;
            }
        },
        end() {
            if (closed || res.writableEnded) {
                return false;
            }

            try {
                res.end();
                return true;
            } catch (_error) {
                closed = true;
                return false;
            }
        },
        isClosed() {
            return closed || res.writableEnded || res.destroyed;
        },
    };
}

function buildStreamErrorPayload(err, sessionId = null) {
    const status = Number.isFinite(err?.statusCode)
        ? err.statusCode
        : (Number.isFinite(err?.status) ? err.status : 502);
    const message = String(err?.message || 'Connection error.').trim() || 'Connection error.';

    return {
        type: 'error',
        error: message,
        status,
        sessionId,
        retryable: status >= 500 || status === 429,
    };
}

function closeSseWithError(sse, sessionId, err) {
    if (!sse || sse.isClosed()) {
        return false;
    }

    const payload = buildStreamErrorPayload(err, sessionId);
    sse.write(`data: ${JSON.stringify(payload)}\n\n`);
    sse.write(`data: ${JSON.stringify({ type: 'done', sessionId })}\n\n`);
    sse.write('data: [DONE]\n\n');
    sse.end();
    return true;
}

function writeSseProgressPayload(sse, sessionId, progress = {}) {
    if (!sse || sse.isClosed()) {
        return false;
    }

    return sse.write(`data: ${JSON.stringify({
        type: 'progress',
        sessionId,
        progress,
    })}\n\n`);
}

async function executeChatRuntimeWithAdaptiveReasoning(app, params = {}, reasoningPolicy = null, onFallback = null) {
    return executeWithAdaptiveReasoningFallback(
        (overrideEffort, fallbackPolicy) => executeConversationRuntime(app, {
            ...params,
            reasoningEffort: overrideEffort === undefined ? params.reasoningEffort : overrideEffort,
            metadata: fallbackPolicy
                ? { ...(params.metadata || {}), reasoningPolicy: fallbackPolicy }
                : params.metadata,
        }),
        reasoningPolicy,
        onFallback,
    );
}

async function maybeQueueWebChatParallelShadow(req, {
    sessionId = '',
    ownerId = '',
    message = '',
    model = null,
    clientSurface = '',
    taskType = '',
    memoryScope = null,
    executionProfile = 'default',
    outputFormat = null,
    metadata = {},
} = {}) {
    if (String(clientSurface || '').trim().toLowerCase() !== 'web-chat') {
        return null;
    }

    const asyncService = req.app.locals.asyncLabService;
    if (!asyncService?.isEnabled?.() || !asyncService?.createRun) {
        return null;
    }

    const status = typeof asyncService.getStatus === 'function' ? asyncService.getStatus() : {};
    if (status?.webChatParallelEnabled !== true) {
        return null;
    }

    try {
        return await asyncService.createRun({
            adapter: 'web-chat-shadow',
            task: message,
            targetKey: `web-chat:${sessionId || 'session'}`,
            sessionId,
            requireGeneratedIdempotency: true,
            metadata: {
                source: 'web-chat-parallel-shadow',
                shadowOnly: true,
                model,
                taskType,
                executionProfile,
                outputFormat,
                memoryScope,
                requestMetadata: metadata,
            },
        }, ownerId);
    } catch (error) {
        console.warn(`[ChatRoute] Failed to queue async web-chat shadow run: ${error.message}`);
        return null;
    }
}

router.post('/:sessionId/messages/:messageId/alignment-feedback', async (req, res, next) => {
    try {
        const sessionId = String(req.params.sessionId || '').trim();
        const messageId = String(req.params.messageId || '').trim();
        const rating = normalizeAlignmentRating(req.body?.rating);
        const reason = String(req.body?.reason || '').trim().slice(0, 500);

        if (!sessionId || !messageId) {
            return res.status(400).json({ success: false, error: 'sessionId and messageId are required.' });
        }
        if (!rating) {
            return res.status(400).json({ success: false, error: 'rating must be "up" or "down".' });
        }

        const session = await sessionStore.get(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found.' });
        }
        const clientSurface = String(req.body?.clientSurface || req.body?.client_surface || session?.metadata?.clientSurface || 'web-chat').trim() || 'web-chat';

        const messages = await sessionStore.loadAllSessionMessages(sessionId);
        const { assistant, user } = findAlignmentTurnMessages(messages, messageId);
        if (!assistant || assistant.role !== 'assistant') {
            return res.status(404).json({ success: false, error: 'Assistant message not found.' });
        }

        const feedbackId = buildAlignmentFeedbackId();
        const baseEvaluation = rating === 'up'
            ? buildFallbackEvaluation({
                rating,
                reason,
                userText: user?.content || '',
                assistantText: assistant.content || '',
                assistantMetadata: assistant.metadata || {},
            })
            : null;
        let status = rating === 'up' ? 'recorded' : 'evaluating';
        let evaluation = baseEvaluation;
        let evaluatorModel = null;

        let alignmentFeedback = buildAlignmentFeedbackMetadata({
            feedbackId,
            rating,
            status,
            reason,
            evaluation,
            previous: assistant.metadata?.alignmentFeedback,
        });
        let updatedAssistant = await sessionStore.upsertMessage(sessionId, {
            ...assistant,
            metadata: {
                ...(assistant.metadata || {}),
                alignmentFeedback,
            },
        });

        if (rating === 'down') {
            try {
                const result = await evaluateAlignment({
                    feedbackId,
                    sessionId,
                    messageId,
                    rating,
                    reason,
                    userText: user?.content || '',
                    assistantText: assistant.content || '',
                    recentMessages: messages,
                    assistantMetadata: {
                        ...(assistant.metadata || {}),
                        model: assistant.model || assistant.metadata?.model || session.metadata?.model || null,
                        clientSurface,
                    },
                });
                status = result.status || 'completed';
                evaluation = result.evaluation || buildFallbackEvaluation({
                    rating,
                    reason,
                    userText: user?.content || '',
                    assistantText: assistant.content || '',
                    assistantMetadata: assistant.metadata || {},
                });
                evaluatorModel = result.model || null;
            } catch (error) {
                console.warn('[AlignmentEvaluator] Evaluation failed:', error.message);
                status = 'failed';
                evaluation = buildFallbackEvaluation({
                    rating,
                    reason: reason || error.message,
                    userText: user?.content || '',
                    assistantText: assistant.content || '',
                    assistantMetadata: assistant.metadata || {},
                });
            }

            alignmentFeedback = buildAlignmentFeedbackMetadata({
                feedbackId,
                rating,
                status,
                reason,
                evaluation,
                model: evaluatorModel,
                previous: assistant.metadata?.alignmentFeedback,
            });
            updatedAssistant = await sessionStore.upsertMessage(sessionId, {
                ...assistant,
                metadata: {
                    ...(assistant.metadata || {}),
                    alignmentFeedback,
                },
            });
        }

        const historyEntry = {
            feedbackId,
            evaluationId: feedbackId,
            messageId,
            rating,
            status,
            reason,
            evaluation,
            updatedAt: alignmentFeedback.updatedAt,
        };
        const regressionFixtureCandidate = buildRegressionFixtureCandidate({
            feedbackId,
            sessionId,
            messageId,
            rating,
            reason,
            userText: user?.content || '',
            assistantText: assistant.content || '',
            evaluation,
            assistantMetadata: assistant.metadata || {},
        });
        if (regressionFixtureCandidate) {
            historyEntry.regressionFixtureCandidate = regressionFixtureCandidate;
        }
        const positiveRoutePattern = rating === 'up'
            ? buildPositiveRoutePattern({
                feedbackId,
                messageId,
                userText: user?.content || '',
                evaluation,
            })
            : null;
        const toolReinforcement = buildAlignmentToolReinforcement({
            feedbackId,
            messageId,
            rating,
            userText: user?.content || '',
            evaluation,
        });
        await sessionStore.update(sessionId, {
            metadata: {
                alignmentFeedback: historyEntry,
                alignmentFeedbackHistory: appendAlignmentHistory(session, historyEntry),
                ...(positiveRoutePattern
                    ? {
                        alignmentRoutePatterns: appendAlignmentList(
                            session,
                            'alignmentRoutePatterns',
                            positiveRoutePattern,
                            ALIGNMENT_ROUTE_PATTERN_LIMIT,
                        ),
                    }
                    : {}),
                ...(regressionFixtureCandidate
                    ? {
                        alignmentRegressionFixtures: appendAlignmentList(
                            session,
                            'alignmentRegressionFixtures',
                            regressionFixtureCandidate,
                            ALIGNMENT_REGRESSION_FIXTURE_LIMIT,
                        ),
                    }
                    : {}),
                ...(toolReinforcement
                    ? {
                        alignmentToolReinforcement: appendAlignmentList(
                            session,
                            'alignmentToolReinforcement',
                            toolReinforcement,
                            ALIGNMENT_TOOL_REINFORCEMENT_LIMIT,
                        ),
                    }
                    : {}),
            },
        });
        await maybeRememberAlignmentLesson(sessionId, {
            session,
            userText: user?.content || '',
            assistantText: assistant.content || '',
            evaluation,
            clientSurface,
            rating,
        });

        return res.json({
            success: true,
            data: {
                feedbackId,
                status,
                evaluation,
                message: updatedAssistant,
            },
        });
    } catch (error) {
        return next(error);
    }
});

router.post('/', validate(chatSchema), async (req, res, next) => {
    let runtimeTask = null;
    let streamRequested = false;
    let activeSse = null;
    let activeSessionId = null;
    let asyncRuntimeShadow = null;
    const startedAt = Date.now();
    try {
        const {
            message: rawMessage,
            stream = true,
            model = null,
            reasoning: _ignoredReasoning = null,
            artifactIds = [],
            outputFormat = null,
            executionProfile = null,
            metadata: requestMetadata = {},
        } = req.body;
        const canonicalAgentRunId = String(
            res.locals?.agentRunShadow?.run?.id
            || requestMetadata?.agentRunId
            || requestMetadata?.agent_run_id
            || '',
        ).trim();
        let message = stripAgentJournalBlocks(rawMessage);
        if (!message) {
            return res.status(400).json({ error: { message: 'message is required' } });
        }
        streamRequested = stream === true;
        let reasoningEffort = resolveReasoningEffort(req.body);
        const enableConversationExecutor = resolveConversationExecutorFlag(req.body);
        let orchestrationSettings = settingsController.getEffectiveOrchestrationConfig?.()
            || settingsController.settings?.orchestration
            || {};
        let useAgentDirectedRuntime = resolveAgentDirectedRuntimeFlag(req.body, orchestrationSettings);
        let { sessionId } = req.body;
        const memoryKeywords = normalizeMemoryKeywords(
            req.body.memoryKeywords || req.body?.metadata?.memoryKeywords || [],
        );
        const requestedTaskType = resolveConversationTaskType(requestMetadata);
        const ownerId = getRequestOwnerId(req);
        const requestTimezone = String(
            requestMetadata?.timezone
            || requestMetadata?.timeZone
            || req.get('x-timezone')
            || '',
        ).trim() || null;
        const requestNow = normalizeClientNow(
            requestMetadata?.clientNow
            || requestMetadata?.client_now
            || req.get('x-client-now')
            || '',
        );
        let effectiveRequestMetadata = {
            ...requestMetadata,
            ...(requestTimezone ? { timezone: requestTimezone } : {}),
            ...(requestNow ? { clientNow: requestNow } : {}),
            ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
        };
        const requestedClientSurface = resolveClientSurface(req.body || {}, null, requestedTaskType);
        const requestedSessionMetadata = buildScopedSessionMetadata({
            ...effectiveRequestMetadata,
            mode: requestedTaskType,
            taskType: requestedTaskType,
            clientSurface: requestedClientSurface,
        });

        const session = await sessionStore.resolveOwnedSession(
            sessionId,
            requestedSessionMetadata,
            ownerId,
        );
        if (session) {
            sessionId = session.id;
        }
        activeSessionId = sessionId;
        if (!session) {
            return res.status(404).json({ error: { message: 'Session not found' } });
        }
        let effectiveSession = await persistSessionModel(sessionId, session, model);
        const auditHintDecision = resolveChatTimeAfterProcessAuditHints({
            session: effectiveSession,
            text: message,
            orchestrationConfig: orchestrationSettings,
        });
        if (auditHintDecision.hasOverrides || auditHintDecision.hasToolRecoveryHints) {
            orchestrationSettings = {
                ...orchestrationSettings,
                ...auditHintDecision.overrides,
            };
            useAgentDirectedRuntime = resolveAgentDirectedRuntimeFlag(req.body, orchestrationSettings);
            effectiveRequestMetadata = {
                ...effectiveRequestMetadata,
                afterProcessAuditHints: {
                    applied: auditHintDecision.matchedHints,
                    toolRecoveryHints: auditHintDecision.matchedToolFailureHints,
                    orchestrationOverrides: auditHintDecision.overrides,
                },
                orchestrationOverrides: auditHintDecision.overrides,
            };
        }
        const clientSurface = resolveClientSurface(req.body || {}, session, requestedTaskType);
        const taskType = resolveConversationTaskType(requestMetadata, session);
        const memoryScope = resolveSessionScope({
            ...requestedSessionMetadata,
            taskType,
            clientSurface,
        }, session);
        const sessionIsolation = isSessionIsolationEnabled(requestedSessionMetadata, session);
        const answeredCheckpointResult = await applyAnsweredUserCheckpointState(
            sessionStore,
            sessionId,
            effectiveSession,
            message,
        );
        effectiveSession = answeredCheckpointResult.session;
        const userCheckpointPolicy = buildUserCheckpointPolicy({
            session: effectiveSession,
            clientSurface,
            latestResponse: answeredCheckpointResult.response,
        });
        const checkpointRecentMessages = answeredCheckpointResult.response && sessionStore?.getRecentMessages
            ? await sessionStore.getRecentMessages(sessionId, WORKLOAD_PREFLIGHT_RECENT_LIMIT)
            : [];
        const checkpointContinuationInput = answeredCheckpointResult.response
            && typeof resolveAnsweredUserCheckpointInput === 'function'
            ? resolveAnsweredUserCheckpointInput({
                userText: message,
                response: answeredCheckpointResult.response,
                checkpoint: answeredCheckpointResult.checkpoint,
                recentMessages: checkpointRecentMessages,
            })
            : message;
        const sshContext = resolveSshRequestContext(checkpointContinuationInput, effectiveSession);
        let effectiveMessage = sshContext.effectivePrompt || checkpointContinuationInput;
        const shouldSanitizeEffectiveMessageSeparately = effectiveMessage !== message;
        const artifactIntentText = stripInjectedNotesPageEditDirective(message);
        const artifactControlState = getSessionControlState(effectiveSession);
        const stickyRemoteArtifactContext = Boolean(
            artifactControlState?.lastToolIntent
            || artifactControlState?.lastSshTarget?.host
            || artifactControlState?.remoteWorkingState?.target?.host
            || artifactControlState?.lastRemoteObjective
        );
        effectiveRequestMetadata = {
            ...effectiveRequestMetadata,
            clientSurface,
            memoryScope,
            userCheckpointPolicy: buildUserCheckpointPolicyMetadata(userCheckpointPolicy),
            ...(sessionIsolation ? { sessionIsolation: true } : {}),
        };
        const routePii = await sanitizeText(message, {
            sessionId,
            ownerId,
            clientSurface,
            route: '/api/chat',
            metadata: effectiveRequestMetadata,
        });
        message = routePii.text;
        if (shouldSanitizeEffectiveMessageSeparately) {
            const effectivePii = await sanitizeText(effectiveMessage, {
                sessionId,
                ownerId,
                clientSurface,
                route: '/api/chat',
                metadata: effectiveRequestMetadata,
                policy: routePii.policy,
            });
            effectiveMessage = effectivePii.text;
            if (effectivePii.contextId) {
                routePii.contextIds = compactPiiContextIds(routePii, effectivePii);
                routePii.replacements = [
                    ...(routePii.replacements || []),
                    ...(effectivePii.replacements || []),
                ];
            }
        } else {
            effectiveMessage = message;
        }
        const runtimeMemoryInput = answeredCheckpointResult.response ? effectiveMessage : message;
        effectiveRequestMetadata = {
            ...effectiveRequestMetadata,
            piiCleansing: buildPiiCleansingMetadata(routePii),
        };
        const managedAppsSummary = req.app.locals.managedAppService?.buildPromptSummary
            ? await req.app.locals.managedAppService.buildPromptSummary({
                ownerId,
                maxApps: 4,
            })
            : '';
        const effectiveArtifactIds = resolveArtifactContextIds(session, artifactIds, message);
        const piiWorkbookRelationship = await buildPiiWorkbookRelationshipToolContext({
            sessionId,
            artifactIds: effectiveArtifactIds,
            text: artifactIntentText,
            ownerId,
            clientSurface,
            route: '/api/chat',
            metadata: effectiveRequestMetadata,
            policy: routePii.policy,
        });
        if (piiWorkbookRelationship) {
            routePii.contextIds = compactPiiContextIds(routePii, piiWorkbookRelationship.context?.piiCleansing?.contextIds);
            routePii.replacements = [
                ...(routePii.replacements || []),
                ...(piiWorkbookRelationship.context?.piiEntries || []).map((entry) => ({
                    placeholder: entry.placeholder,
                    type: entry.piiType || entry.type || 'PII',
                    valueIndexHmac: entry.valueIndexHmac,
                    restorable: true,
                })),
            ];
            effectiveRequestMetadata = {
                ...effectiveRequestMetadata,
                piiCleansing: buildPiiCleansingMetadata(routePii),
            };
        }
        const outputFormatProvided = Boolean(outputFormat);
        const candidateOutputFormat = outputFormat
            || inferRequestedOutputFormat(artifactIntentText)
            || await inferOutputFormatFromArtifactContext({
                sessionId,
                artifactIds: effectiveArtifactIds,
                text: artifactIntentText,
            })
            || inferOutputFormatFromSession(artifactIntentText, session);
        let effectiveOutputFormat = candidateOutputFormat;
        if (shouldSuppressImplicitMermaidArtifact({
            taskType,
            text: artifactIntentText,
            outputFormat: effectiveOutputFormat,
            outputFormatProvided,
        })) {
            effectiveOutputFormat = null;
        }
        if (shouldSuppressNotesSurfaceArtifact({
            taskType,
            text: artifactIntentText,
            outputFormat: effectiveOutputFormat,
            outputFormatProvided,
        })) {
            effectiveOutputFormat = null;
        }
        if (shouldSuppressWebChatImplicitHtmlArtifact({
            clientSurface,
            text: artifactIntentText,
            outputFormat: effectiveOutputFormat,
            outputFormatProvided,
        })) {
            effectiveOutputFormat = null;
        }
        if (shouldSuppressArtifactGenerationForRemoteAction({
            text: artifactIntentText,
            outputFormat: effectiveOutputFormat,
            outputFormatProvided,
            remoteContext: stickyRemoteArtifactContext,
        })) {
            effectiveOutputFormat = null;
        }
        if (shouldSuppressPiiRelationshipFormulaArtifact({
            routePii,
            text: artifactIntentText,
            outputFormat: effectiveOutputFormat,
            outputFormatProvided,
        })) {
            effectiveOutputFormat = null;
        }
        const recentMessagesForWorkloadPreflight = effectiveOutputFormat
            ? await sessionStore.getRecentMessages(sessionId, WORKLOAD_PREFLIGHT_RECENT_LIMIT)
            : [];
        if (shouldSuppressResearchFirstArtifactGeneration({
            text: artifactIntentText,
            outputFormat: effectiveOutputFormat,
            outputFormatProvided,
            artifactIds: effectiveArtifactIds,
            recentMessages: recentMessagesForWorkloadPreflight,
        })) {
            effectiveOutputFormat = null;
        }
        if (effectiveOutputFormat && !outputFormatProvided && !isArtifactStorageAvailable()) {
            console.warn('[ChatRoute] Artifact storage unavailable; handling implicit artifact request as normal chat.');
            effectiveOutputFormat = null;
        }
        const workloadPreflight = resolveDeferredWorkloadPreflight({
            text: artifactIntentText,
            recentMessages: recentMessagesForWorkloadPreflight,
            timezone: requestTimezone,
            now: requestNow,
        });
        if (workloadPreflight.shouldSchedule) {
            effectiveOutputFormat = null;
        }
        effectiveRequestMetadata = {
            ...effectiveRequestMetadata,
            timingDecision: workloadPreflight.shouldSchedule ? 'future' : 'now',
            ...(workloadPreflight.shouldSchedule && workloadPreflight.scenario
                ? {
                    workloadPreflight: {
                        timing: 'future',
                        request: workloadPreflight.request,
                        trigger: workloadPreflight.scenario.trigger,
                    },
                }
                : {}),
        };
        const effectiveExecutionProfile = inferExecutionProfile({
            executionProfile,
            taskType,
            clientSurface,
            input: effectiveMessage,
            memoryInput: runtimeMemoryInput,
            session: effectiveSession,
            metadata: effectiveRequestMetadata,
        });
        const requestFrame = buildRequestDecisionFrame({
            text: message,
            session,
            outputFormat: effectiveOutputFormat,
            candidateOutputFormat,
            outputFormatProvided,
            artifactIds,
            effectiveArtifactIds,
            executionProfile: effectiveExecutionProfile,
            taskType,
            clientSurface,
            route: '/api/chat',
            metadata: effectiveRequestMetadata,
            payload: req.body,
            model: model || session?.metadata?.model || '',
        });
        if (requestFrame.reasoningPolicy?.effectiveEffort) {
            reasoningEffort = requestFrame.reasoningPolicy.effectiveEffort;
        }
        const requestFrameMetadata = buildRequestDecisionMetadata(requestFrame);
        const requestFrameInstructions = formatRequestDecisionFrameForPrompt(requestFrame);
        const recentMessagesForContinuity = recentMessagesForWorkloadPreflight.length > 0
            ? recentMessagesForWorkloadPreflight
            : await sessionStore.getRecentMessages(sessionId, WORKLOAD_PREFLIGHT_RECENT_LIMIT);
        const contextContinuityInstructions = buildContextContinuityFrame({
            currentInput: message,
            recentMessages: recentMessagesForContinuity,
            session: effectiveSession,
            requestFrame,
            clientSurface,
            taskType,
        });
        effectiveRequestMetadata = {
            ...effectiveRequestMetadata,
            ...requestFrameMetadata,
            ...(contextContinuityInstructions
                ? { contextContinuityFrame: contextContinuityInstructions }
                : {}),
            ...(useAgentDirectedRuntime
                ? {
                    runtimeMode: 'agent-directed',
                    agentRuntimeMode: 'agent-directed',
                    useAgentDirectedRuntime: true,
                }
                : {}),
        };
        asyncRuntimeShadow = await maybeQueueWebChatParallelShadow(req, {
            sessionId,
            ownerId,
            message,
            model,
            clientSurface,
            taskType,
            memoryScope,
            executionProfile: effectiveExecutionProfile,
            outputFormat: effectiveOutputFormat,
            metadata: effectiveRequestMetadata,
        });
        if (asyncRuntimeShadow?.run?.id) {
            effectiveRequestMetadata = {
                ...effectiveRequestMetadata,
                asyncRuntimeShadow: {
                    runId: asyncRuntimeShadow.run.id,
                    adapter: asyncRuntimeShadow.run.adapter,
                    targetKey: asyncRuntimeShadow.run.targetKey,
                    duplicate: asyncRuntimeShadow.duplicate === true,
                },
            };
        }
        const effectiveAgentInput = await buildUserInputWithImageArtifacts({
            sessionId,
            text: effectiveMessage,
            artifactIds: effectiveArtifactIds,
        });
        runtimeTask = startRuntimeTask({
            sessionId,
            input: message,
            model: model || session?.metadata?.model || null,
            mode: 'chat',
            transport: 'http',
            metadata: { route: '/api/chat', stream, phase: 'preflight', reasoningEffort, ...requestFrameMetadata },
        });

        if (piiWorkbookRelationship) {
            const runtimeToolManager = await ensureRuntimeToolManager(req.app);
            const result = await runtimeToolManager.executeTool('pii-relationship-calculate', piiWorkbookRelationship.request, {
                sessionId,
                runId: canonicalAgentRunId || null,
                agentRunId: canonicalAgentRunId || null,
                route: '/api/chat',
                transport: 'http',
                memoryService,
                ownerId,
                clientSurface,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                timezone: requestTimezone,
                now: requestNow,
                artifactIds: effectiveArtifactIds,
                piiEntries: [
                    ...buildPiiToolEntries(routePii),
                    ...(piiWorkbookRelationship.context?.piiEntries || []),
                ],
                piiCleansing: piiWorkbookRelationship.context?.piiCleansing || effectiveRequestMetadata.piiCleansing || null,
                metadata: effectiveRequestMetadata,
            });
            const toolEvents = [{
                toolCall: {
                    function: {
                        name: 'pii-relationship-calculate',
                        arguments: JSON.stringify(summarizeTrustedPiiRelationshipRequest(piiWorkbookRelationship.request)),
                    },
                },
                result: summarizeTrustedPiiRelationshipResult(result),
            }];
            if (result?.success === false) {
                const error = new Error(result.error || 'PII relationship calculation failed.');
                error.code = result.errorCode || 'pii_relationship_error';
                error.statusCode = Number(result.statusCode || 502);
                throw error;
            }

            const responseId = `pii-relationship-${Date.now()}`;
            const assistantText = formatTrustedPiiRelationshipMessage(result);
            const piiPresentation = await buildTrustedPiiPresentation(assistantText, {
                sessionId,
                ownerId,
                contextIds: compactPiiContextIds(routePii, piiWorkbookRelationship.context?.piiCleansing?.contextIds),
                metadata: effectiveRequestMetadata,
                clientSurface,
                route: '/api/chat',
            });
            const piiMetadata = buildPiiCleansingMetadata(routePii, null, piiPresentation);
            const artifacts = [];
            if (String(effectiveOutputFormat || '').toLowerCase() === 'xlsx') {
                try {
                    const artifact = await artifactService.storeGeneratedArtifactFromContent({
                        sessionId,
                        session: effectiveSession,
                        ownerId,
                        mode: taskType || 'chat',
                        format: 'xlsx',
                        content: buildTrustedPiiRelationshipWorkbookContent(result),
                        title: 'pii-vault-calculation-result',
                        metadata: {
                            sourceResponseId: responseId,
                            source: 'trusted-pii-relationship-calculation',
                            route: '/api/chat',
                            piiCleansing: piiMetadata || effectiveRequestMetadata.piiCleansing || null,
                        },
                    });
                    artifacts.push(artifact);
                } catch (error) {
                    console.warn('[ChatRoute] Failed to persist trusted PII relationship XLSX result:', error.message);
                }
            }
            await sessionStore.recordResponse(sessionId, responseId);
            memoryService.rememberResponse(sessionId, assistantText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                sourceSurface: clientSurface || taskType,
                memoryKeywords,
                ...(sessionIsolation ? { sessionIsolation: true } : {}),
            }));
            await sessionStore.appendMessages(sessionId, buildWebChatSessionMessages({
                userText: message,
                assistantText,
                toolEvents,
                artifacts,
                assistantMetadata: {
                    directPiiRelationshipCalculation: true,
                    toolEvents,
                    ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
                },
            }));
            await updateSessionProjectMemory(sessionId, {
                userText: message,
                assistantText,
                toolEvents,
                artifacts,
            }, ownerId);
            await safeRecordAgentJournalTurn(effectiveSession, {
                ownerId,
                responseId,
                userText: message,
                assistantText,
                toolEvents,
                artifacts,
            });
            completeRuntimeTask(runtimeTask?.id, {
                responseId,
                output: assistantText,
                model: model || session?.metadata?.model || null,
                duration: Date.now() - startedAt,
                metadata: {
                    directPiiRelationshipCalculation: true,
                    toolEvents,
                    ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
                },
            });
            scheduleDirectAfterProcessAudit({
                sessionId,
                ownerId,
                response: {
                    id: responseId,
                    model: model || session?.metadata?.model || null,
                    metadata: {
                        directPiiRelationshipCalculation: true,
                        route: '/api/chat',
                        toolEvents,
                        artifacts,
                        ...requestFrameMetadata,
                        ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
                    },
                },
                inputText: message,
                outputText: assistantText,
                taskType,
                executionProfile: effectiveExecutionProfile,
                runtimeMode: 'direct-pii-relationship',
                clientSurface,
                memoryScope,
                metadata: requestFrameMetadata,
            });

            if (stream) {
                activeSse = openSseStream(req, res, sessionId);
                res.write(`data: ${JSON.stringify({ type: 'delta', content: assistantText })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    type: 'done',
                    sessionId,
                    responseId,
                    artifacts,
                    toolEvents,
                    displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
                    piiRestorations: piiPresentation.restorations,
                    assistant_metadata: buildAssistantUiMetadata({ directPiiRelationshipCalculation: true }, artifacts, piiMetadata, piiPresentation),
                    assistantMetadata: buildAssistantUiMetadata({ directPiiRelationshipCalculation: true }, artifacts, piiMetadata, piiPresentation),
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            res.json({
                sessionId,
                responseId,
                message: assistantText,
                displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
                piiRestorations: piiPresentation.restorations,
                artifacts,
                toolEvents,
                assistant_metadata: buildAssistantUiMetadata({ directPiiRelationshipCalculation: true }, artifacts, piiMetadata, piiPresentation),
                assistantMetadata: buildAssistantUiMetadata({ directPiiRelationshipCalculation: true }, artifacts, piiMetadata, piiPresentation),
            });
            return;
        }

        const podcastRequestOptions = getPodcastRequestOptions(effectiveRequestMetadata);
        if (shouldUseDirectPodcastChat(message) || hasStructuredPodcastRequest(effectiveRequestMetadata)) {
            const podcastParams = buildDirectPodcastParams({
                text: message,
                artifactIds: effectiveArtifactIds,
                model,
                reasoningEffort,
                podcastOptions: podcastRequestOptions,
            });
            if (podcastParams) {
                if (stream) {
                    activeSse = openSseStream(req, res, sessionId);
                    writeSseProgressPayload(activeSse, sessionId, {
                        phase: 'podcast',
                        detail: 'Starting the podcast workflow.',
                        summary: 'Creating podcast audio',
                    });
                }

                const runtimeToolManager = await ensureRuntimeToolManager(req.app);
                const result = await runtimeToolManager.executeTool('podcast', podcastParams, {
                    sessionId,
                    runId: canonicalAgentRunId || null,
                    agentRunId: canonicalAgentRunId || null,
                    route: '/api/chat',
                    transport: 'http',
                    memoryService,
                    ownerId,
                    clientSurface,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    timezone: requestTimezone,
                    now: requestNow,
                    artifactIds: effectiveArtifactIds,
                    workloadService: req.app.locals.agentWorkloadService,
                    managedAppService: req.app.locals.managedAppService || null,
                    model,
                    reasoningEffort,
                    executionProfile: podcastParams.includeVideo ? 'podcast-video' : 'podcast',
                });
                const toolEvents = [{
                    toolCall: {
                        function: {
                            name: 'podcast',
                            arguments: JSON.stringify(podcastParams),
                        },
                    },
                    result,
                }];
                if (result?.success === false) {
                    const error = new Error(result.error || 'Podcast workflow failed.');
                    error.code = result.errorCode || result?.diagnostics?.podcast?.code || 'podcast_error';
                    error.statusCode = Number(result.statusCode || result?.diagnostics?.podcast?.statusCode || 502);
                    error.podcastDiagnostics = result?.diagnostics?.podcast || {};
                    throw error;
                }

                const responseId = `podcast-${Date.now()}`;
                const assistantText = buildDirectPodcastAssistantMessage(result.data || {});
                const artifacts = extractArtifactsFromToolEvents(toolEvents);
                const piiPresentation = await buildTrustedPiiPresentation(assistantText, {
                    sessionId,
                    ownerId,
                    contextIds: compactPiiContextIds(routePii),
                    metadata: effectiveRequestMetadata,
                    clientSurface,
                    route: '/api/chat',
                });
                const piiMetadata = buildPiiCleansingMetadata(routePii, null, piiPresentation);
                await sessionStore.recordResponse(sessionId, responseId);
                await sessionStore.update(sessionId, {
                    metadata: {
                        taskType,
                        clientSurface: clientSurface || taskType,
                        memoryScope,
                        lastToolIntent: 'podcast',
                        lastPodcastTopic: podcastParams.topic,
                    },
                });
                memoryService.rememberResponse(sessionId, assistantText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }));
                if (artifacts.length > 0) {
                    await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(sessionId, {
                        artifact,
                        summary: `Created the podcast artifact (${artifact.filename}).`,
                        sourceText: assistantText,
                        metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                            sourceSurface: clientSurface || taskType,
                            memoryKeywords,
                            sourcePrompt: message,
                            ...(sessionIsolation ? { sessionIsolation: true } : {}),
                        }),
                    })));
                }
                await sessionStore.appendMessages(sessionId, buildWebChatSessionMessages({
                    userText: message,
                    assistantText,
                    toolEvents,
                    artifacts,
                    assistantMetadata: {
                        directPodcast: true,
                        toolEvents,
                        ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
                    },
                }));
                await updateSessionProjectMemory(sessionId, {
                    userText: message,
                    assistantText,
                    toolEvents,
                    artifacts,
                }, ownerId);
                await safeRecordAgentJournalTurn(effectiveSession, {
                    ownerId,
                    responseId,
                    userText: message,
                    assistantText,
                    toolEvents,
                    artifacts,
                });

                completeRuntimeTask(runtimeTask?.id, {
                    responseId,
                    output: assistantText,
                    model: result.data?.model || model || session?.metadata?.model || null,
                    duration: Date.now() - startedAt,
                    metadata: {
                        directPodcast: true,
                        toolEvents,
                        artifacts,
                    },
                });
                scheduleDirectAfterProcessAudit({
                    sessionId,
                    ownerId,
                    response: {
                        id: responseId,
                        model: result.data?.model || model || session?.metadata?.model || null,
                        metadata: {
                            directPodcast: true,
                            route: '/api/chat',
                            toolEvents,
                            artifacts,
                        },
                    },
                    inputText: message,
                    outputText: assistantText,
                    taskType,
                    executionProfile: podcastParams.includeVideo ? 'podcast-video' : 'podcast',
                    runtimeMode: 'direct-podcast',
                    clientSurface,
                    memoryScope,
                    metadata: { plannedTools: ['podcast'] },
                });

                if (stream) {
                    res.write(`data: ${JSON.stringify({ type: 'delta', content: assistantText })}\n\n`);
                    res.write(`data: ${JSON.stringify({
                        type: 'done',
                        sessionId,
                        responseId,
                        artifacts,
                        toolEvents,
                        displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
                        piiRestorations: piiPresentation.restorations,
                        assistant_metadata: buildAssistantUiMetadata({ directPodcast: true }, artifacts, piiMetadata, piiPresentation),
                        assistantMetadata: buildAssistantUiMetadata({ directPodcast: true }, artifacts, piiMetadata, piiPresentation),
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }

                res.json({
                    sessionId,
                    responseId,
                    message: assistantText,
                    displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
                    piiRestorations: piiPresentation.restorations,
                    artifacts,
                    toolEvents,
                    assistant_metadata: buildAssistantUiMetadata({ directPodcast: true }, artifacts, piiMetadata, piiPresentation),
                    assistantMetadata: buildAssistantUiMetadata({ directPodcast: true }, artifacts, piiMetadata, piiPresentation),
                });
                return;
            }
        }

        if (effectiveOutputFormat) {
            const toolManager = await ensureRuntimeToolManager(req.app);
            const artifactRecentMessages = await sessionStore.getRecentMessages(
                sessionId,
                WORKLOAD_PREFLIGHT_RECENT_LIMIT,
            );
            const artifactRecall = resolveTranscriptObjectiveFromSession(message, artifactRecentMessages);
            const artifactMemory = await memoryService.process(sessionId, message, {
                ownerId,
                memoryScope,
                sessionIsolation,
                sourceSurface: clientSurface || taskType,
                memoryKeywords,
                profile: 'default',
                recallQuery: artifactRecall.objective || message,
                objective: artifactRecall.objective || message,
                recentMessages: artifactRecentMessages,
                returnDetails: true,
            });
            const preparedImages = await maybePrepareImagesForArtifactPrompt({
                toolManager,
                sessionId,
                route: '/api/chat',
                transport: 'http',
                taskType,
                text: message,
                outputFormat: effectiveOutputFormat,
                artifactIds: effectiveArtifactIds,
            });
            const artifactGenerationSession = preparedImages.resetPreviousResponse
                ? { ...effectiveSession, previousResponseId: null }
                : effectiveSession;
            const generationArtifacts = await generateOutputArtifactFromPrompt({
                sessionId,
                session: artifactGenerationSession,
                mode: taskType,
                outputFormat: effectiveOutputFormat,
                prompt: message,
                artifactIds: preparedImages.artifactIds,
                model,
                reasoningEffort,
                contextMessages: Array.isArray(artifactMemory)
                    ? artifactMemory
                    : (artifactMemory.contextMessages || []),
                recentMessages: artifactRecentMessages,
                toolManager,
                toolContext: {
                    sessionId,
                    runId: canonicalAgentRunId || null,
                    agentRunId: canonicalAgentRunId || null,
                    route: '/api/chat',
                    transport: 'http',
                    memoryService,
                    ownerId,
                    clientSurface,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    timezone: requestTimezone,
                    now: requestNow,
                    managedAppsSummary,
                    artifactIds: preparedImages.artifactIds,
                    documentService: req.app.locals.documentService || null,
                    workloadService: req.app.locals.agentWorkloadService,
                    managedAppService: req.app.locals.managedAppService || null,
                    missionId: effectiveRequestMetadata.missionId || null,
                    parentArtifactId: effectiveRequestMetadata.parentArtifactId
                        || effectiveRequestMetadata.artifactLineage?.parentArtifactId
                        || null,
                    metadata: effectiveRequestMetadata,
                },
                executionProfile: effectiveExecutionProfile,
            });
            const responseArtifacts = mergeRuntimeArtifacts(
                preparedImages.artifacts,
                generationArtifacts.artifacts,
            );
            const piiPresentation = await buildTrustedPiiPresentation(generationArtifacts.assistantMessage, {
                sessionId,
                ownerId,
                contextIds: compactPiiContextIds(routePii),
                metadata: effectiveRequestMetadata,
                clientSurface,
                route: '/api/chat',
            });
            const piiMetadata = buildPiiCleansingMetadata(routePii, null, piiPresentation);

            if (stream) {
                activeSse = openSseStream(req, res, sessionId);
                writeSseProgressPayload(activeSse, sessionId, buildRequestFrameProgress(requestFrame));
            }

            await sessionStore.recordResponse(sessionId, generationArtifacts.responseId);
            await sessionStore.update(sessionId, {
                metadata: {
                    lastOutputFormat: effectiveOutputFormat,
                    lastGeneratedArtifactId: generationArtifacts.artifact.id,
                    taskType,
                    clientSurface: clientSurface || taskType,
                    memoryScope,
                },
            });
            memoryService.rememberResponse(
                sessionId,
                generationArtifacts.assistantMessage,
                buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }),
            );
            await memoryService.rememberArtifactResult(sessionId, {
                artifact: generationArtifacts.artifact,
                summary: generationArtifacts.assistantMessage,
                sourceText: generationArtifacts.outputText,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                    sourcePrompt: message,
                    artifactFormat: effectiveOutputFormat,
                    artifactFilename: generationArtifacts.artifact?.filename || '',
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }),
            });
            await memoryService.rememberLearnedSkill(sessionId, {
                objective: message,
                assistantText: generationArtifacts.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifact: generationArtifacts.artifact,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }),
            });
            await sessionStore.appendMessages(sessionId, buildWebChatSessionMessages({
                userText: message,
                assistantText: generationArtifacts.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifacts: responseArtifacts,
                assistantMetadata: {
                    ...requestFrameMetadata,
                    ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
                },
            }));
            await updateSessionProjectMemory(sessionId, {
                userText: message,
                assistantText: generationArtifacts.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifacts: responseArtifacts,
            }, ownerId);
            await safeRecordAgentJournalTurn(effectiveSession, {
                ownerId,
                responseId: generationArtifacts.responseId,
                userText: message,
                assistantText: generationArtifacts.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifacts: responseArtifacts,
            });

            completeRuntimeTask(runtimeTask?.id, {
                responseId: generationArtifacts.responseId,
                output: generationArtifacts.assistantMessage,
                model: generationArtifacts.model || model || session?.metadata?.model || null,
                duration: Date.now() - startedAt,
                metadata: {
                    outputFormat: effectiveOutputFormat,
                    artifactDirect: true,
                    toolEvents: preparedImages.toolEvents,
                    ...requestFrameMetadata,
                    ...(generationArtifacts.metadata || {}),
                },
            });
            scheduleDirectAfterProcessAudit({
                sessionId,
                ownerId,
                response: {
                    id: generationArtifacts.responseId,
                    model: generationArtifacts.model || model || session?.metadata?.model || null,
                    metadata: {
                        outputFormat: effectiveOutputFormat,
                        artifactDirect: true,
                        route: '/api/chat',
                        toolEvents: preparedImages.toolEvents,
                        artifacts: responseArtifacts,
                        ...requestFrameMetadata,
                        ...(generationArtifacts.metadata || {}),
                    },
                },
                inputText: message,
                outputText: generationArtifacts.assistantMessage,
                taskType,
                executionProfile: effectiveExecutionProfile,
                runtimeMode: 'direct-artifact-generation',
                clientSurface,
                memoryScope,
                metadata: requestFrameMetadata,
            });

            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'delta', content: generationArtifacts.assistantMessage })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    type: 'done',
                    sessionId,
                    responseId: generationArtifacts.responseId,
                    artifacts: responseArtifacts,
                    toolEvents: preparedImages.toolEvents,
                    displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
                    piiRestorations: piiPresentation.restorations,
                    assistant_metadata: buildAssistantUiMetadata(requestFrameMetadata, responseArtifacts, piiMetadata, piiPresentation),
                    assistantMetadata: buildAssistantUiMetadata(requestFrameMetadata, responseArtifacts, piiMetadata, piiPresentation),
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            res.json({
                sessionId,
                responseId: generationArtifacts.responseId,
                message: generationArtifacts.assistantMessage,
                displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
                piiRestorations: piiPresentation.restorations,
                artifacts: responseArtifacts,
                toolEvents: preparedImages.toolEvents,
                assistant_metadata: buildAssistantUiMetadata(requestFrameMetadata, responseArtifacts, piiMetadata, piiPresentation),
                assistantMetadata: buildAssistantUiMetadata(requestFrameMetadata, responseArtifacts, piiMetadata, piiPresentation),
            });
            return;
        }

        const responseFormattingInstructions = buildHumanCentricResponseInstructions({
            clientSurface,
            taskType,
        });
        const naturalContext = buildNaturalContext({
            session: effectiveSession,
            metadata: effectiveRequestMetadata,
            clientSurface,
            taskType,
            userText: message,
        });
        effectiveRequestMetadata = {
            ...effectiveRequestMetadata,
            naturalContext,
        };
        const naturalInstructions = useAgentDirectedRuntime
            ? [
                buildNaturalContextInstructions(naturalContext),
                buildRegisteredSkillsInstructions({
                    userText: message,
                    metadata: effectiveRequestMetadata,
                }),
            ].filter(Boolean).join('\n\n')
            : [
                buildSkillsTreeInstructions({ clientSurface, taskType }),
                buildNaturalContextInstructions(naturalContext),
                buildRegisteredSkillsInstructions({
                    userText: message,
                    metadata: effectiveRequestMetadata,
                }),
            ].filter(Boolean).join('\n\n');
        const agentJournalInstructions = buildAgentJournalInstructions(
            await loadAgentJournalEntries(sessionStore, effectiveSession, ownerId),
        );
        const alignmentGuidanceInstructions = buildAlignmentGuidanceContext(effectiveSession);
        const instructions = await buildInstructionsWithArtifacts(
            effectiveSession,
            [
                agentJournalInstructions,
                alignmentGuidanceInstructions,
                requestFrameInstructions,
                contextContinuityInstructions,
                buildContinuityInstructions(buildUserCheckpointInstructions(userCheckpointPolicy)),
                naturalInstructions,
                responseFormattingInstructions,
            ].filter(Boolean).join('\n\n'),
            effectiveArtifactIds,
        );

        if (stream) {
            activeSse = openSseStream(req, res, sessionId);
            writeSseProgressPayload(activeSse, sessionId, buildRequestFrameProgress(requestFrame));

            const toolManager = await ensureRuntimeToolManager(req.app);
            let foregroundTurn = null;
            const requestedForegroundTurn = buildForegroundMetadata(effectiveRequestMetadata, clientSurface, taskType);
            if (requestedForegroundTurn) {
                foregroundTurn = await beginForegroundTurn({
                    sessionStore,
                    sessionId,
                    userText: message,
                    metadata: {
                        ...effectiveRequestMetadata,
                        foregroundRequestId: requestedForegroundTurn.requestId,
                        messageId: requestedForegroundTurn.userMessageId,
                        assistantMessageId: requestedForegroundTurn.assistantMessageId,
                        userMessageTimestamp: requestedForegroundTurn.userTimestamp,
                        assistantMessageTimestamp: requestedForegroundTurn.assistantTimestamp,
                        assistantPlaceholder: requestedForegroundTurn.placeholderText,
                    },
                    clientSurface,
                    taskType,
                });
            }
            const persistForegroundProgress = createForegroundProgressPersister({
                sessionStore,
                sessionId,
                foregroundTurn,
            });
            effectiveRequestMetadata = {
                ...effectiveRequestMetadata,
                ...(foregroundTurn ? { foregroundTurn } : {}),
            };

            const execution = await executeChatRuntimeWithAdaptiveReasoning(req.app, {
                input: effectiveAgentInput,
                session: effectiveSession,
                sessionId,
                memoryInput: runtimeMemoryInput,
                previousResponseId: effectiveSession.previousResponseId,
                instructions,
                recentMessages: recentMessagesForContinuity,
                stream: true,
                model,
                reasoningEffort,
                toolManager,
                toolContext: {
                    sessionId,
                    runId: canonicalAgentRunId || null,
                    agentRunId: canonicalAgentRunId || null,
                    route: '/api/chat',
                    transport: 'http',
                    memoryService,
                    ownerId,
                    clientSurface,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    timezone: requestTimezone,
                    now: requestNow,
                    managedAppsSummary,
                    artifactIds: effectiveArtifactIds,
                    workloadService: req.app.locals.agentWorkloadService,
                    managedAppService: req.app.locals.managedAppService || null,
                    userCheckpointPolicy,
                    piiEntries: [
                        ...buildPiiToolEntries(routePii),
                        ...(piiWorkbookRelationship?.context?.piiEntries || []),
                    ],
                    piiWorkbookRelationship,
                },
                executionProfile: effectiveExecutionProfile,
                enableAutomaticToolCalls: true,
                enableConversationExecutor,
                taskType,
                clientSurface,
                memoryScope,
                metadata: effectiveRequestMetadata,
                ownerId,
                onProgress: (progress) => {
                    writeSseProgressPayload(activeSse, sessionId, progress);
                    if (persistForegroundProgress) {
                        persistForegroundProgress(progress);
                    }
                },
            }, requestFrame.reasoningPolicy, (fallbackPolicy) => {
                const fallbackProgress = {
                    phase: 'reasoning-fallback',
                    detail: 'Using the selected model\'s default reasoning level.',
                    reasoningPolicy: fallbackPolicy,
                    goal: requestFrame.goal,
                    steps: requestFrame.goal?.steps || [],
                    showSteps: ['complex', 'extended'].includes(requestFrame.complexity?.band),
                    displayMode: ['complex', 'extended'].includes(requestFrame.complexity?.band) ? 'steps' : 'line',
                    estimated: false,
                };
                writeSseProgressPayload(activeSse, sessionId, fallbackProgress);
                if (persistForegroundProgress) persistForegroundProgress(fallbackProgress);
            });
            const response = execution.response;

            let fullText = '';

            for await (const event of response) {
                if (event.type === 'response.output_text.delta') {
                    fullText += event.delta;
                    res.write(`data: ${JSON.stringify({ type: 'delta', content: event.delta })}\n\n`);
                }

                if (event.type === 'response.reasoning_summary_text.delta' && event.delta) {
                    res.write(`data: ${JSON.stringify({
                        type: 'response.reasoning_summary_text.delta',
                        delta: event.delta,
                        summary: event.summary || '',
                    })}\n\n`);
                }

                if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done')
                    && isResponseToolOutputItem(event.item)) {
                    res.write(`data: ${JSON.stringify({
                        type: event.type,
                        item: event.item,
                    })}\n\n`);
                }

                if (event.type === 'response.completed') {
                    const completedText = resolveCompletedResponseText(fullText, event.response);
                    const missingDelta = getMissingCompletionDelta(fullText, completedText);
                    if (missingDelta) {
                        fullText = completedText;
                        res.write(`data: ${JSON.stringify({ type: 'delta', content: missingDelta })}\n\n`);
                    } else {
                        fullText = completedText;
                    }

                    const toolEvents = event.response?.metadata?.toolEvents || [];
                    if (!execution.handledPersistence) {
                        await sessionStore.recordResponse(
                            sessionId,
                            event.response.id,
                            event.response?.metadata?.promptState ? { promptState: event.response.metadata.promptState } : null,
                        );
                        memoryService.rememberResponse(sessionId, fullText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                            sourceSurface: clientSurface || taskType,
                            memoryKeywords,
                            ...(sessionIsolation ? { sessionIsolation: true } : {}),
                        }));
                    }
                    const sshMetadata = extractSshSessionMetadataFromToolEvents(event.response?.metadata?.toolEvents);
                    if (sshMetadata) {
                        await sessionStore.update(sessionId, { metadata: sshMetadata });
                    }
                    effectiveSession = await persistSessionModel(sessionId, effectiveSession, event.response?.model || model || null);
                    effectiveSession = await applyAskedUserCheckpointState(
                        sessionStore,
                        sessionId,
                        effectiveSession,
                        toolEvents,
                    );
                    const shouldGenerateArtifacts = shouldGenerateOutputArtifactForToolResponse({
                        outputFormat: effectiveOutputFormat,
                        outputFormatProvided,
                        toolEvents,
                    });
                    const generatedArtifacts = shouldGenerateArtifacts
                        ? await maybeGenerateOutputArtifact({
                            sessionId,
                            session: effectiveSession,
                            mode: taskType,
                            outputFormat: effectiveOutputFormat,
                            content: fullText,
                            prompt: message,
                            title: 'chat-output',
                            responseId: event.response.id,
                            artifactIds,
                            model,
                            reasoningEffort,
                            recentMessages: await sessionStore.getRecentMessages(sessionId, WORKLOAD_PREFLIGHT_RECENT_LIMIT),
                            missionId: effectiveRequestMetadata.missionId || null,
                            parentArtifactId: effectiveRequestMetadata.parentArtifactId
                                || effectiveRequestMetadata.artifactLineage?.parentArtifactId
                                || null,
                            provenance: {
                                sourceSurface: clientSurface || 'web-chat',
                                runId: canonicalAgentRunId || null,
                                sessionId,
                            },
                        })
                        : [];
                    const saveableDocumentArtifacts = generatedArtifacts.length === 0
                        ? await maybePersistSaveableDocumentResponse({
                            sessionId,
                            mode: taskType,
                            requestText: message,
                            assistantText: fullText,
                            responseId: event.response.id,
                        })
                        : [];
                    const artifacts = mergeRuntimeArtifacts(
                        extractArtifactsFromToolEvents(toolEvents),
                        generatedArtifacts,
                        saveableDocumentArtifacts,
                    );
                    const piiContextIds = compactPiiContextIds(routePii, execution.pii);
                    const piiPresentation = await buildTrustedPiiPresentation(fullText, {
                        sessionId,
                        ownerId,
                        contextIds: piiContextIds,
                        metadata: effectiveRequestMetadata,
                        clientSurface,
                        route: '/api/chat',
                    });
                    const piiMetadata = buildPiiCleansingMetadata(routePii, execution.pii, piiPresentation);
                    if (artifacts.length > 0) {
                        await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(sessionId, {
                            artifact,
                            summary: `Created the ${artifact.format || effectiveOutputFormat || 'generated'} artifact (${artifact.filename}).`,
                            sourceText: fullText,
                            metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                                sourceSurface: clientSurface || taskType,
                                memoryKeywords,
                                sourcePrompt: message,
                                ...(sessionIsolation ? { sessionIsolation: true } : {}),
                            }),
                        })));
                        await memoryService.rememberLearnedSkill(sessionId, {
                            objective: message,
                            assistantText: fullText,
                            toolEvents,
                            artifact: artifacts[artifacts.length - 1],
                            metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                                sourceSurface: clientSurface || taskType,
                                memoryKeywords,
                                ...(sessionIsolation ? { sessionIsolation: true } : {}),
                            }),
                        });
                    }
                    await updateSessionProjectMemory(sessionId, {
                        userText: message,
                        assistantText: fullText,
                        toolEvents,
                        artifacts,
                    }, ownerId);
                    if (!execution.handledPersistence) {
                        const sessionMessages = buildWebChatSessionMessages({
                            userText: message,
                            assistantText: fullText,
                            toolEvents,
                            artifacts,
                            assistantMetadata: {
                                ...(event.response?.metadata || {}),
                                ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
                            },
                            ...buildForegroundTurnMessageOptions(foregroundTurn),
                        });
                        await persistForegroundTurnMessages(
                            sessionStore,
                            sessionId,
                            sessionMessages,
                            foregroundTurn,
                        );
                    }
                    await safeRecordAgentJournalTurn(effectiveSession, {
                        ownerId,
                        responseId: event.response.id,
                        userText: message,
                        assistantText: fullText,
                        toolEvents,
                        artifacts,
                    });
                    completeRuntimeTask(runtimeTask?.id, {
                        responseId: event.response.id,
                        output: fullText,
                        model: event.response.model || model || null,
                        duration: Date.now() - startedAt,
                        metadata: event.response?.metadata || {},
                    });
                    res.write(`data: ${JSON.stringify({
                        type: 'done',
                        sessionId,
                        responseId: event.response.id,
                        ...(asyncRuntimeShadow?.run ? {
                            asyncRuntime: {
                                shadowRun: asyncRuntimeShadow.run,
                                events: asyncRuntimeShadow.events || [],
                                duplicate: asyncRuntimeShadow.duplicate === true,
                            },
                        } : {}),
                        artifacts,
                        toolEvents,
                        displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
                        piiRestorations: piiPresentation.restorations,
                        assistant_metadata: buildAssistantUiMetadata(event.response?.metadata, artifacts, piiMetadata, piiPresentation),
                        assistantMetadata: buildAssistantUiMetadata(event.response?.metadata, artifacts, piiMetadata, piiPresentation),
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                }
            }

            res.end();
            return;
        }

        const runtimeToolManager = await ensureRuntimeToolManager(req.app);
        const execution = await executeChatRuntimeWithAdaptiveReasoning(req.app, {
            input: effectiveAgentInput,
            session: effectiveSession,
            sessionId,
            memoryInput: runtimeMemoryInput,
            previousResponseId: effectiveSession.previousResponseId,
            instructions,
            recentMessages: recentMessagesForContinuity,
            stream: false,
            model,
            reasoningEffort,
            toolManager: runtimeToolManager,
            toolContext: {
                sessionId,
                runId: canonicalAgentRunId || null,
                agentRunId: canonicalAgentRunId || null,
                route: '/api/chat',
                transport: 'http',
                memoryService,
                ownerId,
                clientSurface,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                timezone: requestTimezone,
                now: requestNow,
                managedAppsSummary,
                artifactIds: effectiveArtifactIds,
                workloadService: req.app.locals.agentWorkloadService,
                managedAppService: req.app.locals.managedAppService || null,
                userCheckpointPolicy,
                piiEntries: [
                    ...buildPiiToolEntries(routePii),
                    ...(piiWorkbookRelationship?.context?.piiEntries || []),
                ],
                piiWorkbookRelationship,
            },
            executionProfile: effectiveExecutionProfile,
            enableAutomaticToolCalls: true,
            enableConversationExecutor,
            taskType,
            clientSurface,
            memoryScope,
            metadata: effectiveRequestMetadata,
            ownerId,
        }, requestFrame.reasoningPolicy);
        const response = execution.response;
        if (!execution.handledPersistence) {
            await sessionStore.recordResponse(
                sessionId,
                response.id,
                response?.metadata?.promptState ? { promptState: response.metadata.promptState } : null,
            );
        }

        const outputText = extractResponseText(response);
        if (!execution.handledPersistence) {
            memoryService.rememberResponse(sessionId, outputText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                sourceSurface: clientSurface || taskType,
                memoryKeywords,
                ...(sessionIsolation ? { sessionIsolation: true } : {}),
            }));
        }
        const sshMetadata = extractSshSessionMetadataFromToolEvents(response?.metadata?.toolEvents);
        if (sshMetadata) {
            await sessionStore.update(sessionId, { metadata: sshMetadata });
        }
        effectiveSession = await persistSessionModel(sessionId, effectiveSession, response.model || model || null);
        effectiveSession = await applyAskedUserCheckpointState(
            sessionStore,
            sessionId,
            effectiveSession,
            response?.metadata?.toolEvents || [],
        );
        const toolEvents = response?.metadata?.toolEvents || [];
        const shouldGenerateArtifacts = shouldGenerateOutputArtifactForToolResponse({
            outputFormat: effectiveOutputFormat,
            outputFormatProvided,
            toolEvents,
        });
        const generatedArtifacts = shouldGenerateArtifacts
            ? await maybeGenerateOutputArtifact({
                sessionId,
                session: effectiveSession,
                mode: taskType,
                outputFormat: effectiveOutputFormat,
                content: outputText,
                prompt: message,
                title: 'chat-output',
                responseId: response.id,
                artifactIds,
                model,
                reasoningEffort,
                recentMessages: await sessionStore.getRecentMessages(sessionId, WORKLOAD_PREFLIGHT_RECENT_LIMIT),
                missionId: effectiveRequestMetadata.missionId || null,
                parentArtifactId: effectiveRequestMetadata.parentArtifactId
                    || effectiveRequestMetadata.artifactLineage?.parentArtifactId
                    || null,
                provenance: {
                    sourceSurface: clientSurface || 'web-chat',
                    runId: canonicalAgentRunId || null,
                    sessionId,
                },
            })
            : [];
        const saveableDocumentArtifacts = generatedArtifacts.length === 0
            ? await maybePersistSaveableDocumentResponse({
                sessionId,
                mode: taskType,
                requestText: message,
                assistantText: outputText,
                responseId: response.id,
            })
            : [];
        const artifacts = mergeRuntimeArtifacts(
            extractArtifactsFromToolEvents(toolEvents),
            generatedArtifacts,
            saveableDocumentArtifacts,
        );
        const piiContextIds = compactPiiContextIds(routePii, execution.pii);
        const piiPresentation = await buildTrustedPiiPresentation(outputText, {
            sessionId,
            ownerId,
            contextIds: piiContextIds,
            metadata: effectiveRequestMetadata,
            clientSurface,
            route: '/api/chat',
        });
        const piiMetadata = buildPiiCleansingMetadata(routePii, execution.pii, piiPresentation);
        if (artifacts.length > 0) {
            await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(sessionId, {
                artifact,
                summary: `Created the ${artifact.format || effectiveOutputFormat || 'generated'} artifact (${artifact.filename}).`,
                sourceText: outputText,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                    sourcePrompt: message,
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }),
            })));
            await memoryService.rememberLearnedSkill(sessionId, {
                objective: message,
                assistantText: outputText,
                toolEvents: response?.metadata?.toolEvents || [],
                artifact: artifacts[artifacts.length - 1],
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }),
            });
        }
        await updateSessionProjectMemory(sessionId, {
            userText: message,
            assistantText: outputText,
            toolEvents: response?.metadata?.toolEvents || [],
            artifacts,
        }, ownerId);
        if (!execution.handledPersistence) {
            await sessionStore.appendMessages(sessionId, buildWebChatSessionMessages({
                userText: message,
                assistantText: outputText,
                toolEvents: response?.metadata?.toolEvents || [],
                artifacts,
                assistantMetadata: {
                    ...(response?.metadata || {}),
                    ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
                },
            }));
        }
        await safeRecordAgentJournalTurn(effectiveSession, {
            ownerId,
            responseId: response.id,
            userText: message,
            assistantText: outputText,
            toolEvents: response?.metadata?.toolEvents || [],
            artifacts,
        });

        completeRuntimeTask(runtimeTask?.id, {
            responseId: response.id,
            output: outputText,
            model: response.model || model || null,
            duration: Date.now() - startedAt,
            metadata: response?.metadata || {},
        });

        res.json({
            sessionId,
            responseId: response.id,
            message: outputText,
            ...(asyncRuntimeShadow?.run ? {
                asyncRuntime: {
                    shadowRun: asyncRuntimeShadow.run,
                    events: asyncRuntimeShadow.events || [],
                    duplicate: asyncRuntimeShadow.duplicate === true,
                },
            } : {}),
            displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
            piiRestorations: piiPresentation.restorations,
            artifacts,
            toolEvents: response?.metadata?.toolEvents || [],
            assistant_metadata: buildAssistantUiMetadata(response?.metadata, artifacts, piiMetadata, piiPresentation),
            assistantMetadata: buildAssistantUiMetadata(response?.metadata, artifacts, piiMetadata, piiPresentation),
        });
    } catch (err) {
        failRuntimeTask(runtimeTask?.id, {
            error: err,
            duration: Date.now() - startedAt,
            model: req.body?.model || null,
            metadata: { reasoningEffort: resolveReasoningEffort(req.body) },
        });
        if (streamRequested && closeSseWithError(activeSse, activeSessionId, err)) {
            console.warn(`[ChatRoute] Stream failed gracefully sessionId=${activeSessionId || 'unknown'}: ${err.message}`);
            return;
        }
        next(err);
    }
});

module.exports = router;

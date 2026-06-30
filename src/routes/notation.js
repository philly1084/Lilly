const { Router } = require('express');
const { validate } = require('../middleware/validate');
const { sessionStore } = require('../session-store');
const { memoryService } = require('../memory/memory-service');
const { executeConversationRuntime, resolveConversationExecutorFlag } = require('../runtime-execution');
const { buildInstructionsWithArtifacts, maybeGenerateOutputArtifact, resolveReasoningEffort } = require('../ai-route-utils');
const { extractResponseText } = require('../artifacts/artifact-service');
const { startRuntimeTask, completeRuntimeTask, failRuntimeTask } = require('../admin/runtime-monitor');
const { normalizeMemoryKeywords } = require('../memory/memory-keywords');
const { extractArtifactsFromToolEvents, mergeRuntimeArtifacts } = require('../runtime-artifacts');
const { buildFrontendAssistantMetadata } = require('../web-chat-message-state');
const {
    buildScopedMemoryMetadata,
    buildScopedSessionMetadata,
    isSessionIsolationEnabled,
    resolveClientSurface,
    resolveSessionScope,
} = require('../session-scope');
const {
    buildRequestDecisionFrame,
    buildRequestDecisionMetadata,
    formatRequestDecisionFrameForPrompt,
} = require('../request-decision-frame');
const { parseLenientJson } = require('../utils/lenient-json');

const router = Router();

function normalizeClientNow(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return null;
    }

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function getRequestOwnerId(req) {
    return String(req.user?.username || '').trim() || null;
}

function buildOwnerMemoryMetadata(ownerId = null, memoryScope = null, extra = {}) {
    return buildScopedMemoryMetadata({
        ...(ownerId ? { ownerId } : {}),
        ...(memoryScope ? { memoryScope } : {}),
        ...extra,
    });
}

const notationSchema = {
    notation: { required: true, type: 'string' },
    sessionId: { required: false, type: 'string' },
    context: { required: false, type: 'string' },
    helperMode: { required: false, type: 'string', enum: ['expand', 'explain', 'validate'] },
    model: { required: false, type: 'string' },
    reasoningEffort: { required: false, type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
    reasoning_effort: { required: false, type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
    reasoning: { required: false, type: 'object' },
    artifactIds: { required: false, type: 'array' },
    outputFormat: { required: false, type: 'string' },
    enableConversationExecutor: { required: false, type: 'boolean' },
    useAgentExecutor: { required: false, type: 'boolean' },
    executionProfile: { required: false, type: 'string' },
    memoryKeywords: { required: false, type: 'array' },
};

router.post('/', validate(notationSchema), async (req, res, next) => {
    let runtimeTask = null;
    const startedAt = Date.now();
    try {
        const {
            notation,
            context = '',
            helperMode = 'expand',
            model = null,
            reasoning: _ignoredReasoning = null,
            artifactIds = [],
            outputFormat = null,
            executionProfile = null,
        } = req.body;
        const reasoningEffort = resolveReasoningEffort(req.body);
        const enableConversationExecutor = resolveConversationExecutorFlag(req.body);
        let { sessionId } = req.body;
        const memoryKeywords = normalizeMemoryKeywords(
            req.body.memoryKeywords || req.body?.metadata?.memoryKeywords || [],
        );
        const ownerId = getRequestOwnerId(req);
        const requestTimezone = String(
            req.body?.metadata?.timezone
            || req.body?.metadata?.timeZone
            || req.get('x-timezone')
            || '',
        ).trim() || null;
        const requestNow = normalizeClientNow(
            req.body?.metadata?.clientNow
            || req.body?.metadata?.client_now
            || req.get('x-client-now')
            || '',
        );
        const effectiveRequestMetadata = {
            ...(req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}),
            ...(requestTimezone ? { timezone: requestTimezone } : {}),
            ...(requestNow ? { clientNow: requestNow } : {}),
            ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
        };
        const requestedClientSurface = resolveClientSurface(req.body || {}, null, 'notation');
        const requestedSessionMetadata = buildScopedSessionMetadata({
            ...effectiveRequestMetadata,
            mode: 'notation',
            taskType: 'notation',
            helperMode,
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
        if (!session) {
            return res.status(404).json({ error: { message: 'Session not found' } });
        }
        const clientSurface = resolveClientSurface(req.body || {}, session, 'notation');
        const memoryScope = resolveSessionScope({
            ...requestedSessionMetadata,
            clientSurface,
        }, session);
        const sessionIsolation = isSessionIsolationEnabled(requestedSessionMetadata, session);
        const requestFrame = buildRequestDecisionFrame({
            text: notation,
            session,
            outputFormat,
            candidateOutputFormat: outputFormat,
            outputFormatProvided: Boolean(outputFormat),
            artifactIds,
            effectiveArtifactIds: artifactIds,
            executionProfile,
            taskType: 'notation',
            clientSurface,
            route: '/api/notation',
        });
        const requestFrameMetadata = buildRequestDecisionMetadata(requestFrame);
        const requestFrameInstructions = formatRequestDecisionFrameForPrompt(requestFrame);

        runtimeTask = startRuntimeTask({
            sessionId,
            input: notation,
            model: model || null,
            mode: 'notation',
            transport: 'http',
            metadata: { route: '/api/notation', helperMode, phase: 'preflight', reasoningEffort, ...requestFrameMetadata },
        });
        const instructions = await buildInstructionsWithArtifacts(
            session,
            [
                requestFrameInstructions,
                buildNotationInstructions(helperMode, context),
            ].filter(Boolean).join('\n\n'),
            artifactIds,
        );

        const execution = await executeConversationRuntime(req.app, {
            input: notation,
            session,
            sessionId,
            memoryInput: notation,
            previousResponseId: session.previousResponseId,
            instructions,
            stream: false,
            model,
            reasoningEffort,
            toolContext: {
                sessionId,
                route: '/api/notation',
                transport: 'http',
                memoryService,
                ownerId,
                clientSurface,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                timezone: requestTimezone,
                now: requestNow,
                artifactIds,
                workloadService: req.app.locals.agentWorkloadService,
            },
            executionProfile,
            enableConversationExecutor,
            taskType: 'notation',
            clientSurface,
            memoryScope,
            metadata: {
                ...effectiveRequestMetadata,
                ...requestFrameMetadata,
                clientSurface,
            },
            ownerId,
        });
        const response = execution.response;
        if (!execution.handledPersistence) {
            await sessionStore.recordResponse(
                sessionId,
                response.id,
                response?.metadata?.promptState ? { promptState: response.metadata.promptState } : null,
            );
        }

        const outputText = extractResponseText(response);
        const assistantMetadata = buildFrontendAssistantMetadata({
            ...requestFrameMetadata,
            ...(response?.metadata || {}),
        });
        if (!execution.handledPersistence) {
            memoryService.rememberResponse(sessionId, outputText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                sourceSurface: clientSurface || 'notation',
                memoryKeywords,
            }));
            await sessionStore.appendMessages(sessionId, [
                { role: 'user', content: notation },
                { role: 'assistant', content: outputText, metadata: assistantMetadata },
            ]);
        }
        const structured = parseNotationResponse(outputText, helperMode);
        const generatedArtifacts = await maybeGenerateOutputArtifact({
            sessionId,
            session,
            mode: 'notation',
            outputFormat,
            content: structured.result,
            prompt: notation,
            title: `notation-${helperMode}`,
            responseId: response.id,
            artifactIds,
            existingContent: context,
            model,
            reasoningEffort,
            recentMessages: await sessionStore.getRecentMessages(sessionId),
        });
        const artifacts = mergeRuntimeArtifacts(
            extractArtifactsFromToolEvents(response?.metadata?.toolEvents || []),
            generatedArtifacts,
        );
        if (artifacts.length > 0) {
            await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(sessionId, {
                artifact,
                summary: `Created the ${artifact.format || outputFormat || 'generated'} artifact (${artifact.filename}).`,
                sourceText: structured.result,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || 'notation',
                    memoryKeywords,
                    sourcePrompt: notation,
                }),
            })));
            await memoryService.rememberLearnedSkill(sessionId, {
                objective: notation,
                assistantText: structured.result,
                toolEvents: response?.metadata?.toolEvents || [],
                artifact: artifacts[artifacts.length - 1],
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || 'notation',
                    memoryKeywords,
                }),
            });
        }

        completeRuntimeTask(runtimeTask?.id, {
            responseId: response.id,
            output: structured.result,
            model: response.model || model || null,
            duration: Date.now() - startedAt,
            metadata: {
                helperMode,
                ...requestFrameMetadata,
                ...(response?.metadata || {}),
            },
        });

        res.json({
            sessionId,
            responseId: response.id,
            helperMode,
            artifacts,
            assistant_metadata: assistantMetadata,
            assistantMetadata,
            ...structured,
        });
    } catch (err) {
        failRuntimeTask(runtimeTask?.id, {
            error: err,
            duration: Date.now() - startedAt,
            model: req.body?.model || null,
            metadata: { helperMode: req.body?.helperMode || 'expand', reasoningEffort: resolveReasoningEffort(req.body) },
        });
        next(err);
    }
});

function buildNotationInstructions(helperMode, context) {
    const base = `You are an AI notation helper. Users write in shorthand notation and you process it according to the specified mode.

Always respond with valid JSON in this format:
{
  "result": "the processed output",
  "annotations": [{"line": 1, "note": "explanation"}],
  "suggestions": ["suggestion 1", "suggestion 2"],
  "structure": {"optional": "mode-specific outline or parsed shape"},
  "assumptions": ["optional assumption"],
  "ambiguities": ["optional ambiguity"],
  "issues": [{"severity": "warning", "line": 1, "message": "problem", "fix": "suggested fix"}],
  "correctedNotation": "optional corrected shorthand"
}`;

    const modeInstructions = {
        expand: '\n\nMODE: EXPAND - Take the shorthand notation and expand it into full, detailed content. Preserve the intent and structure while making it comprehensive and production-ready. Use structure, assumptions, or ambiguities only when they clarify the expansion; do not add validate-only issues unless there is a real problem.',
        explain: '\n\nMODE: EXPLAIN - Analyze the notation and provide detailed explanations for each part. Break down what each element means and how it connects to the whole. Prefer structure and assumptions for the explanation; do not overproduce validation-only fields.',
        validate: '\n\nMODE: VALIDATE - Check the notation for correctness, completeness, and best practices. Always include issues as an array. When problems exist, each issue must include severity, line, message, and fix. Include correctedNotation when a concrete corrected shorthand would help.',
    };

    let instructions = base + (modeInstructions[helperMode] || modeInstructions.expand);
    if (context) {
        instructions += `\n\nAdditional context provided by the user:\n${context}`;
    }

    return instructions;
}

function parseNotationResponse(text, helperMode = 'expand') {
    const parsed = parseLenientJson(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const annotations = normalizeAnnotations(parsed.annotations);
        const issues = normalizeIssues(parsed.issues);
        return {
            result: parsed.result || text,
            annotations: mergeIssueAnnotations(annotations, issues),
            suggestions: normalizeStringArray(parsed.suggestions),
            ...(parsed.structure !== undefined ? { structure: parsed.structure } : {}),
            ...(parsed.assumptions !== undefined ? { assumptions: normalizeStringArray(parsed.assumptions) } : {}),
            ...(parsed.ambiguities !== undefined ? { ambiguities: normalizeStringArray(parsed.ambiguities) } : {}),
            ...((helperMode === 'validate' || parsed.issues !== undefined) ? { issues } : {}),
            ...(typeof parsed.correctedNotation === 'string' && parsed.correctedNotation.trim()
                ? { correctedNotation: parsed.correctedNotation.trim() }
                : {}),
        };
    }

    return {
        result: text,
        annotations: [],
        suggestions: [],
        ...(helperMode === 'validate' ? { issues: [] } : {}),
    };
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => (typeof item === 'string' ? item.trim() : String(item || '').trim()))
        .filter(Boolean);
}

function normalizeAnnotations(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((annotation) => {
            if (!annotation || typeof annotation !== 'object') {
                return null;
            }
            const line = Number.parseInt(annotation.line, 10);
            const note = String(annotation.note || annotation.message || '').trim();
            if (!Number.isFinite(line) || line <= 0 || !note) {
                return null;
            }
            return {
                line,
                note,
                ...(annotation.type ? { type: String(annotation.type).trim() } : {}),
            };
        })
        .filter(Boolean);
}

function normalizeIssues(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((issue) => {
            if (!issue || typeof issue !== 'object') {
                return null;
            }
            const line = Number.parseInt(issue.line, 10);
            const message = String(issue.message || issue.note || '').trim();
            if (!message) {
                return null;
            }
            return {
                severity: normalizeIssueSeverity(issue.severity),
                line: Number.isFinite(line) && line > 0 ? line : null,
                message,
                fix: String(issue.fix || '').trim(),
            };
        })
        .filter(Boolean);
}

function normalizeIssueSeverity(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['error', 'warning', 'info'].includes(normalized)) {
        return normalized;
    }
    return 'warning';
}

function mergeIssueAnnotations(annotations, issues) {
    if (!issues.length) {
        return annotations;
    }
    const existingKeys = new Set(annotations.map((annotation) => `${annotation.line}:${annotation.note}`));
    const issueAnnotations = issues
        .filter((issue) => issue.line)
        .map((issue) => ({
            line: issue.line,
            note: issue.fix ? `${issue.message} Fix: ${issue.fix}` : issue.message,
            type: issue.severity === 'error' ? 'error' : issue.severity,
        }))
        .filter((annotation) => {
            const key = `${annotation.line}:${annotation.note}`;
            if (existingKeys.has(key)) {
                return false;
            }
            existingKeys.add(key);
            return true;
        });
    return annotations.concat(issueAnnotations);
}

router._private = {
    buildNotationInstructions,
    parseNotationResponse,
    normalizeIssues,
};

module.exports = router;

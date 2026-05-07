const { Router } = require('express');
const { config } = require('../config');
const { validate } = require('../middleware/validate');
const { sessionStore } = require('../session-store');
const { memoryService } = require('../memory/memory-service');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const { executeConversationRuntime, resolveConversationExecutorFlag } = require('../runtime-execution');
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
    isArtifactStorageAvailable,
    stripInjectedNotesPageEditDirective,
    resolveSshRequestContext,
    extractSshSessionMetadataFromToolEvents,
    inferOutputFormatFromSession,
    resolveArtifactContextIds,
    buildUserInputWithImageArtifacts,
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
const { resolveTranscriptObjectiveFromSession } = require('../conversation-continuity');
const { buildProjectMemoryUpdate, mergeProjectMemory } = require('../project-memory');
const { buildContinuityInstructions } = require('../runtime-prompts');
const { buildHumanCentricResponseInstructions } = require('../session-instructions');
const { buildFrontendAssistantMetadata, buildWebChatSessionMessages } = require('../web-chat-message-state');
const { normalizeMemoryKeywords } = require('../memory/memory-keywords');
const { extractArtifactsFromToolEvents, mergeRuntimeArtifacts } = require('../runtime-artifacts');
const {
    buildUserCheckpointInstructions,
    buildUserCheckpointPolicy,
} = require('../user-checkpoints');
const {
    applyAnsweredUserCheckpointState,
    applyAskedUserCheckpointState,
    buildUserCheckpointPolicyMetadata,
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
    buildDirectPodcastAssistantMessage,
    buildDirectPodcastParams,
    shouldUseDirectPodcastChat,
} = require('../podcast/direct-podcast-chat');

const router = Router();
const WORKLOAD_PREFLIGHT_RECENT_LIMIT = config.memory.recentTranscriptLimit;

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

    return sessionStore.update(sessionId, {
        metadata: {
            projectMemory: mergeProjectMemory(
                session?.metadata?.projectMemory || {},
                buildProjectMemoryUpdate(updates),
            ),
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

router.post('/', validate(chatSchema), async (req, res, next) => {
    let runtimeTask = null;
    let streamRequested = false;
    let activeSse = null;
    let activeSessionId = null;
    const startedAt = Date.now();
    try {
        const {
            message,
            stream = true,
            model = null,
            reasoning: _ignoredReasoning = null,
            artifactIds = [],
            outputFormat = null,
            executionProfile = null,
            metadata: requestMetadata = {},
        } = req.body;
        streamRequested = stream === true;
        const reasoningEffort = resolveReasoningEffort(req.body);
        const enableConversationExecutor = resolveConversationExecutorFlag(req.body);
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
        const sshContext = resolveSshRequestContext(message, effectiveSession);
        const effectiveMessage = sshContext.effectivePrompt || message;
        const artifactIntentText = stripInjectedNotesPageEditDirective(message);
        effectiveRequestMetadata = {
            ...effectiveRequestMetadata,
            clientSurface,
            memoryScope,
            userCheckpointPolicy: buildUserCheckpointPolicyMetadata(userCheckpointPolicy),
            ...(sessionIsolation ? { sessionIsolation: true } : {}),
        };
        const managedAppsSummary = req.app.locals.managedAppService?.buildPromptSummary
            ? await req.app.locals.managedAppService.buildPromptSummary({
                ownerId,
                maxApps: 4,
            })
            : '';
        const outputFormatProvided = Boolean(outputFormat);
        let effectiveOutputFormat = outputFormat
            || inferRequestedOutputFormat(artifactIntentText)
            || inferOutputFormatFromSession(artifactIntentText, session);
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
        if (effectiveOutputFormat && !outputFormatProvided && !isArtifactStorageAvailable()) {
            console.warn('[ChatRoute] Artifact storage unavailable; handling implicit artifact request as normal chat.');
            effectiveOutputFormat = null;
        }
        const recentMessagesForWorkloadPreflight = effectiveOutputFormat
            ? await sessionStore.getRecentMessages(sessionId, WORKLOAD_PREFLIGHT_RECENT_LIMIT)
            : [];
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
        const effectiveArtifactIds = resolveArtifactContextIds(session, artifactIds, message);
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
            metadata: { route: '/api/chat', stream, phase: 'preflight', reasoningEffort },
        });

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
                    assistantMetadata: { directPodcast: true, toolEvents },
                }));
                await updateSessionProjectMemory(sessionId, {
                    userText: message,
                    assistantText,
                    toolEvents,
                    artifacts,
                }, ownerId);

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

                if (stream) {
                    res.write(`data: ${JSON.stringify({ type: 'delta', content: assistantText })}\n\n`);
                    res.write(`data: ${JSON.stringify({
                        type: 'done',
                        sessionId,
                        responseId,
                        artifacts,
                        toolEvents,
                        assistant_metadata: buildFrontendAssistantMetadata({ directPodcast: true, artifacts }),
                        assistantMetadata: buildFrontendAssistantMetadata({ directPodcast: true, artifacts }),
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }

                res.json({
                    sessionId,
                    responseId,
                    message: assistantText,
                    artifacts,
                    toolEvents,
                    assistant_metadata: buildFrontendAssistantMetadata({ directPodcast: true, artifacts }),
                    assistantMetadata: buildFrontendAssistantMetadata({ directPodcast: true, artifacts }),
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
                    workloadService: req.app.locals.agentWorkloadService,
                    managedAppService: req.app.locals.managedAppService || null,
                },
                executionProfile,
            });
            const responseArtifacts = mergeRuntimeArtifacts(
                preparedImages.artifacts,
                generationArtifacts.artifacts,
            );

            if (stream) {
                activeSse = openSseStream(req, res, sessionId);
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
            }));
            await updateSessionProjectMemory(sessionId, {
                userText: message,
                assistantText: generationArtifacts.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifacts: responseArtifacts,
            }, ownerId);

            completeRuntimeTask(runtimeTask?.id, {
                responseId: generationArtifacts.responseId,
                output: generationArtifacts.assistantMessage,
                model: generationArtifacts.model || model || session?.metadata?.model || null,
                duration: Date.now() - startedAt,
                metadata: {
                    outputFormat: effectiveOutputFormat,
                    artifactDirect: true,
                    toolEvents: preparedImages.toolEvents,
                    ...(generationArtifacts.metadata || {}),
                },
            });

            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'delta', content: generationArtifacts.assistantMessage })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    type: 'done',
                    sessionId,
                    responseId: generationArtifacts.responseId,
                    artifacts: responseArtifacts,
                    toolEvents: preparedImages.toolEvents,
                    assistant_metadata: buildFrontendAssistantMetadata({ artifacts: responseArtifacts }),
                    assistantMetadata: buildFrontendAssistantMetadata({ artifacts: responseArtifacts }),
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            res.json({
                sessionId,
                responseId: generationArtifacts.responseId,
                message: generationArtifacts.assistantMessage,
                artifacts: responseArtifacts,
                toolEvents: preparedImages.toolEvents,
                assistant_metadata: buildFrontendAssistantMetadata({ artifacts: responseArtifacts }),
                assistantMetadata: buildFrontendAssistantMetadata({ artifacts: responseArtifacts }),
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
        const naturalInstructions = [
            buildSkillsTreeInstructions({ clientSurface, taskType }),
            buildNaturalContextInstructions(naturalContext),
            buildRegisteredSkillsInstructions({
                userText: message,
                metadata: effectiveRequestMetadata,
            }),
        ].filter(Boolean).join('\n\n');
        const instructions = await buildInstructionsWithArtifacts(
            effectiveSession,
            [
                buildContinuityInstructions(buildUserCheckpointInstructions(userCheckpointPolicy)),
                naturalInstructions,
                responseFormattingInstructions,
            ].filter(Boolean).join('\n\n'),
            effectiveArtifactIds,
        );

        if (stream) {
            activeSse = openSseStream(req, res, sessionId);

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

            const execution = await executeConversationRuntime(req.app, {
                input: effectiveAgentInput,
                session: effectiveSession,
                sessionId,
                memoryInput: message,
                previousResponseId: effectiveSession.previousResponseId,
                instructions,
                stream: true,
                model,
                reasoningEffort,
                toolManager,
                toolContext: {
                    sessionId,
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
                },
                executionProfile,
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
                    const generatedArtifacts = effectiveOutputFormat
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
                            assistantMetadata: event.response?.metadata,
                            ...buildForegroundTurnMessageOptions(foregroundTurn),
                        });
                        await persistForegroundTurnMessages(
                            sessionStore,
                            sessionId,
                            sessionMessages,
                            foregroundTurn,
                        );
                    }
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
                        artifacts,
                        toolEvents,
                        assistant_metadata: buildFrontendAssistantMetadata({
                            ...(event.response?.metadata || {}),
                            artifacts,
                        }),
                        assistantMetadata: buildFrontendAssistantMetadata({
                            ...(event.response?.metadata || {}),
                            artifacts,
                        }),
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                }
            }

            res.end();
            return;
        }

        const runtimeToolManager = await ensureRuntimeToolManager(req.app);
        const execution = await executeConversationRuntime(req.app, {
            input: effectiveAgentInput,
            session: effectiveSession,
            sessionId,
            memoryInput: message,
            previousResponseId: effectiveSession.previousResponseId,
            instructions,
            stream: false,
            model,
            reasoningEffort,
            toolManager: runtimeToolManager,
            toolContext: {
                sessionId,
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
            },
            executionProfile,
            enableAutomaticToolCalls: true,
            enableConversationExecutor,
            taskType,
            clientSurface,
            memoryScope,
            metadata: effectiveRequestMetadata,
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
        const generatedArtifacts = effectiveOutputFormat
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
            extractArtifactsFromToolEvents(response?.metadata?.toolEvents || []),
            generatedArtifacts,
            saveableDocumentArtifacts,
        );
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
                assistantMetadata: response?.metadata,
            }));
        }

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
            artifacts,
            toolEvents: response?.metadata?.toolEvents || [],
            assistant_metadata: buildFrontendAssistantMetadata({
                ...(response?.metadata || {}),
                artifacts,
            }),
            assistantMetadata: buildFrontendAssistantMetadata({
                ...(response?.metadata || {}),
                artifacts,
            }),
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

const { WebSocket } = require('ws');
const { sessionStore } = require('../session-store');
const { memoryService } = require('../memory/memory-service');
const { config } = require('../config');
const notationRouter = require('../routes/notation');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const { executeConversationRuntime, inferExecutionProfile, resolveConversationExecutorFlag } = require('../runtime-execution');
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
    shouldSuppressResearchFirstArtifactGeneration,
    isArtifactStorageAvailable,
    resolveSshRequestContext,
    extractSshSessionMetadataFromToolEvents,
    inferOutputFormatFromSession,
    inferOutputFormatFromArtifactContext,
    resolveArtifactContextIds,
    resolveReasoningEffort,
} = require('../ai-route-utils');
const {
    extractResponseText,
    resolveCompletedResponseText,
    getMissingCompletionDelta,
} = require('../artifacts/artifact-service');
const { startRuntimeTask, completeRuntimeTask, failRuntimeTask } = require('../admin/runtime-monitor');
const {
    getAuthenticatedUser,
    isAuthorizedFrontendApiRequest,
    isAuthEnabled,
} = require('../auth/service');
const { resolveTranscriptObjectiveFromSession } = require('../conversation-continuity');
const { buildProjectMemoryUpdate, mergeProjectMemory } = require('../project-memory');
const { buildContinuityInstructions } = require('../runtime-prompts');
const { buildHumanCentricResponseInstructions } = require('../session-instructions');
const { buildFrontendAssistantMetadata, buildWebChatSessionMessages } = require('../web-chat-message-state');
const {
    buildRequestDecisionFrame,
    buildRequestDecisionMetadata,
    buildRequestFrameProgress,
    formatRequestDecisionFrameForPrompt,
} = require('../request-decision-frame');
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
    broadcastToAdmins,
    broadcastToSession,
    registerAdminConnection,
    registerSessionConnection,
    unregisterAdminConnection,
    unregisterSessionConnection,
} = require('../realtime-hub');
const {
    buildDirectPodcastAssistantMessage,
    buildDirectPodcastParams,
    shouldUseDirectPodcastChat,
} = require('../podcast/direct-podcast-chat');
const { rehydrateText, sanitizeText } = require('../pii');
const {
    buildFrontendFallbackMetadata,
    normalizeFrontendMetadata,
} = require('../frontend-bundles');

// Admin dashboard event emitter
const EventEmitter = require('events');
const adminEvents = new EventEmitter();
const WORKLOAD_PREFLIGHT_RECENT_LIMIT = config.memory.recentTranscriptLimit;
const {
    buildNotationInstructions,
    parseNotationResponse,
} = notationRouter._private || {};

function buildWsCanvasInstructions(canvasType = 'document', existingContent = '', requestPrompt = '') {
    const base = [
        'You are an AI assistant working in canvas mode.',
        'Return valid JSON only: { "content": "...", "metadata": {...}, "suggestions": [...] }.',
        'Use the provided interactionContract metadata to respect the active canvas type, selected text, context source, and expected apply target.',
    ].join('\n');
    const typeGuides = {
        code: 'Generate working code. Include metadata.language and suggestions for concrete follow-up edits.',
        document: 'Generate markdown. Include metadata.title and suggestions for useful expansions or revisions.',
        diagram: 'Generate Mermaid syntax. Include metadata.type and suggestions for diagram refinements.',
        frontend: 'Generate a portable frontend. Treat metadata.bundle.files as the source of truth for complete projects, include metadata.frameworkTarget, metadata.previewMode, and metadata.handoff when useful. Keep content short when the full runnable project is present in metadata.bundle.files.',
    };
    return [
        base,
        typeGuides[canvasType] || typeGuides.document,
        requestPrompt ? `User request: ${requestPrompt}` : '',
        existingContent ? `Existing content:\n\`\`\`\n${existingContent}\n\`\`\`` : '',
    ].filter(Boolean).join('\n\n');
}

function parseWsCanvasResponse(text = '', canvasType = 'document') {
    try {
        const parsed = JSON.parse(String(text || ''));
        const parsedContent = typeof parsed.content === 'string'
            ? parsed.content
            : String(parsed.content || '');
        const metadata = canvasType === 'frontend'
            ? normalizeFrontendMetadata(parsed.metadata, parsedContent)
            : (parsed.metadata || { type: canvasType });
        return {
            content: parsedContent || String(text || ''),
            metadata,
            suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        };
    } catch (_error) {
        if (canvasType === 'frontend') {
            return {
                content: String(text || ''),
                metadata: buildFrontendFallbackMetadata(String(text || '')),
                suggestions: [],
            };
        }

        return {
            content: String(text || ''),
            metadata: { type: canvasType },
            suggestions: [],
        };
    }
}

function compactPiiContextIds(...sources) {
    const ids = [];
    sources.forEach((source) => {
        if (!source) return;
        if (Array.isArray(source)) {
            source.forEach((id) => ids.push(id));
            return;
        }
        if (Array.isArray(source.contextIds)) source.contextIds.forEach((id) => ids.push(id));
        if (source.contextId) ids.push(source.contextId);
    });
    return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function buildPiiCleansingMetadata(routePii = null, executionPii = null, presentation = null) {
    const contextIds = compactPiiContextIds(routePii, executionPii);
    const replacementCount = Number(routePii?.replacements?.length || 0) + Number(executionPii?.replacementCount || 0);
    const enabled = routePii?.policy?.enabled === true || executionPii?.enabled === true || presentation?.enabled === true;
    if (!enabled && contextIds.length === 0 && replacementCount === 0) return null;
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

async function buildTrustedPiiPresentation(text = '', options = {}) {
    try {
        return await rehydrateText(text, { ...options, highlight: true });
    } catch (error) {
        console.warn(`[PII] Failed to rehydrate websocket presentation: ${error.message}`);
        return { text: String(text || ''), restorations: [], enabled: false };
    }
}

function buildAssistantUiMetadata(baseMetadata = {}, artifacts = [], piiMetadata = null, presentation = null) {
    return buildFrontendAssistantMetadata({
        ...(baseMetadata || {}),
        artifacts,
        ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
        ...(presentation?.restorations?.length > 0
            ? { displayContent: presentation.text, piiRestorations: presentation.restorations }
            : {}),
    });
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

function isNotesSurfaceValue(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    return [
        'notes',
        'notes-app',
        'notes_app',
        'notes-editor',
        'notes_editor',
    ].includes(normalized);
}

function buildOwnerMemoryMetadata(ownerId = null, memoryScope = null, extra = {}) {
    return buildScopedMemoryMetadata({
        ...(ownerId ? { ownerId } : {}),
        ...(memoryScope ? { memoryScope } : {}),
        ...extra,
    });
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

function resolveConversationTaskType(payload = {}, session = null) {
    const candidates = [
        payload?.taskType,
        payload?.task_type,
        payload?.clientSurface,
        payload?.client_surface,
        payload?.metadata?.taskType,
        payload?.metadata?.task_type,
        payload?.metadata?.clientSurface,
        payload?.metadata?.client_surface,
        session?.metadata?.taskType,
        session?.metadata?.task_type,
        session?.metadata?.clientSurface,
        session?.metadata?.client_surface,
    ];

    return candidates.find((value) => typeof value === 'string' && value.trim()) || 'chat';
}

function normalizeClientNow(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return null;
    }

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeWsSend(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {
        ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
        return true;
    } catch (error) {
        console.warn(`[WS] Failed to send message: ${error.message}`);
        return false;
    }
}

function sendWsProgressPayload(ws, sessionId, progress = {}) {
    return safeWsSend(ws, {
        type: 'progress',
        sessionId,
        progress,
    });
}

function setupWebSocket(wss, app = null) {
    wss.on('connection', (ws, req) => {
        ws.app = app;
        if (isAuthEnabled()) {
            const authState = getAuthenticatedUser(req);
            if (authState.authenticated) {
                ws.user = authState.user;
            } else if (isAuthorizedFrontendApiRequest(req)) {
                ws.user = { username: 'frontend-api', role: 'frontend-api' };
            } else {
                ws.close(4401, 'Authentication required');
                return;
            }
        } else {
            ws.user = { username: 'anonymous', role: 'open' };
        }

        console.log('[WS] Client connected');

        ws.on('message', async (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                const { type, payload } = msg;
                let { sessionId } = msg;
                const ownerId = String(ws.user?.username || '').trim() || null;

                if (type === 'session_subscribe') {
                    registerSessionConnection(ws, payload?.sessionId || sessionId);
                    safeWsSend(ws, { type: 'session_subscribed', sessionId: payload?.sessionId || sessionId });
                    return;
                }

                if (type === 'session_unsubscribe') {
                    unregisterSessionConnection(ws, payload?.sessionId || sessionId);
                    safeWsSend(ws, { type: 'session_unsubscribed', sessionId: payload?.sessionId || sessionId });
                    return;
                }

                if (type === 'admin_subscribe') {
                    handleAdminSubscribe(ws);
                    return;
                }

                if (type === 'admin_unsubscribe') {
                    handleAdminUnsubscribe(ws);
                    return;
                }

                const requestedSessionId = sessionId;
                const requestedSessionMetadata = buildScopedSessionMetadata({
                    ...(payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
                    mode: type,
                    taskType: type,
                    transport: 'ws',
                    clientSurface: resolveClientSurface(payload || {}, null, type),
                });
                const session = ownerId
                    ? await sessionStore.resolveOwnedSession(
                        requestedSessionId,
                        requestedSessionMetadata,
                        ownerId,
                    )
                    : requestedSessionId
                        ? await sessionStore.getOrCreate(requestedSessionId, requestedSessionMetadata)
                        : await sessionStore.create(requestedSessionMetadata);
                if (!session) {
                    safeWsSend(ws, { type: 'error', message: 'Session not found' });
                    return;
                }
                sessionId = session.id;
                if (!requestedSessionId) {
                    safeWsSend(ws, { type: 'session_created', sessionId });
                }

                switch (type) {
                    case 'chat':
                        registerSessionConnection(ws, sessionId);
                        await handleChat(ws, session, payload, app?.locals?.toolManager || null, ownerId);
                        break;
                    case 'canvas':
                        registerSessionConnection(ws, sessionId);
                        await handleCanvas(ws, session, payload, ownerId);
                        break;
                    case 'notation':
                        registerSessionConnection(ws, sessionId);
                        await handleNotation(ws, session, payload, ownerId);
                        break;
                    default:
                        safeWsSend(ws, { type: 'error', message: `Unknown type: ${type}` });
                }
            } catch (err) {
                console.error('[WS] Error:', err.message);
                safeWsSend(ws, { type: 'error', message: err.message });
            }
        });

        ws.on('close', () => {
            console.log('[WS] Client disconnected');
            unregisterAdminConnection(ws);
            unregisterSessionConnection(ws);
        });
    });
}

async function handleChat(ws, session, payload = {}, toolManager = null, ownerId = null) {
    let runtimeTask = null;
    const startedAt = Date.now();
    const { message: rawMessage, model = null, artifactIds = [], outputFormat = null, executionProfile = null } = payload;
    let message = rawMessage;
    const memoryKeywords = normalizeMemoryKeywords(
        payload.memoryKeywords || payload?.metadata?.memoryKeywords || [],
    );
    const reasoningEffort = resolveReasoningEffort(payload);
    const enableConversationExecutor = resolveConversationExecutorFlag(payload);
    const requestTimezone = String(
        payload?.metadata?.timezone
        || payload?.metadata?.timeZone
        || payload?.timezone
        || '',
    ).trim() || null;
    const requestNow = normalizeClientNow(
        payload?.metadata?.clientNow
        || payload?.metadata?.client_now
        || payload?.clientNow
        || payload?.client_now
        || '',
    );
    let effectiveRequestMetadata = {
        ...(payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
        ...(requestTimezone ? { timezone: requestTimezone } : {}),
        ...(requestNow ? { clientNow: requestNow } : {}),
        ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
    };
    if (!message) {
        safeWsSend(ws, { type: 'error', message: "'message' is required" });
        return;
    }
    session = await persistSessionModel(session.id, session, model);
    const taskType = resolveConversationTaskType(payload, session);
    const clientSurface = resolveClientSurface(payload || {}, session, taskType);
    const memoryScope = resolveSessionScope({
        ...effectiveRequestMetadata,
        mode: taskType,
        taskType,
        clientSurface,
    }, session);
    const sessionIsolation = isSessionIsolationEnabled(effectiveRequestMetadata, session);
    const answeredCheckpointResult = await applyAnsweredUserCheckpointState(
        sessionStore,
        session.id,
        session,
        message,
    );
    session = answeredCheckpointResult.session;
    const userCheckpointPolicy = buildUserCheckpointPolicy({
        session,
        clientSurface,
    });
    const sshContext = resolveSshRequestContext(message, session);
    let effectiveMessage = sshContext.effectivePrompt || message;
    effectiveRequestMetadata = {
        ...effectiveRequestMetadata,
        clientSurface,
        memoryScope,
        userCheckpointPolicy: buildUserCheckpointPolicyMetadata(userCheckpointPolicy),
        ...(sessionIsolation ? { sessionIsolation: true } : {}),
    };
    const routePii = await sanitizeText(message, {
        sessionId: session.id,
        ownerId,
        clientSurface,
        route: '/ws',
        metadata: effectiveRequestMetadata,
    });
    message = routePii.text;
    if (effectiveMessage !== rawMessage) {
        const effectivePii = await sanitizeText(effectiveMessage, {
            sessionId: session.id,
            ownerId,
            clientSurface,
            route: '/ws',
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
    effectiveRequestMetadata = {
        ...effectiveRequestMetadata,
        piiCleansing: buildPiiCleansingMetadata(routePii),
    };
    const effectiveArtifactIds = resolveArtifactContextIds(session, artifactIds, message);
    const outputFormatProvided = Boolean(outputFormat);
    const candidateOutputFormat = outputFormat
        || inferRequestedOutputFormat(message)
        || await inferOutputFormatFromArtifactContext({
            sessionId: session.id,
            artifactIds: effectiveArtifactIds,
            text: message,
        })
        || inferOutputFormatFromSession(message, session);
    let effectiveOutputFormat = candidateOutputFormat;
    if (shouldSuppressImplicitMermaidArtifact({
        taskType,
        text: message,
        outputFormat: effectiveOutputFormat,
        outputFormatProvided,
    })) {
        effectiveOutputFormat = null;
    }
    if (shouldSuppressNotesSurfaceArtifact({
        taskType,
        text: message,
        outputFormat: effectiveOutputFormat,
        outputFormatProvided,
    })) {
        effectiveOutputFormat = null;
    }
    if (shouldSuppressWebChatImplicitHtmlArtifact({
        clientSurface,
        text: message,
        outputFormat: effectiveOutputFormat,
        outputFormatProvided,
    })) {
        effectiveOutputFormat = null;
    }
    if (shouldSuppressArtifactGenerationForRemoteAction({
        text: message,
        outputFormat: effectiveOutputFormat,
    })) {
        effectiveOutputFormat = null;
    }
    const recentMessagesForWorkloadPreflight = effectiveOutputFormat
        ? await sessionStore.getRecentMessages(session.id, WORKLOAD_PREFLIGHT_RECENT_LIMIT)
        : [];
    if (shouldSuppressResearchFirstArtifactGeneration({
        text: message,
        outputFormat: effectiveOutputFormat,
        outputFormatProvided,
        artifactIds: effectiveArtifactIds,
        recentMessages: recentMessagesForWorkloadPreflight,
    })) {
        effectiveOutputFormat = null;
    }
    if (effectiveOutputFormat && !outputFormat && !isArtifactStorageAvailable()) {
        console.warn('[WS] Artifact storage unavailable; handling implicit artifact request as normal chat.');
        effectiveOutputFormat = null;
    }
    const workloadPreflight = resolveDeferredWorkloadPreflight({
        text: message,
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
        memoryInput: message,
        session,
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
        route: '/ws',
    });
    const requestFrameMetadata = buildRequestDecisionMetadata(requestFrame);
    const requestFrameInstructions = formatRequestDecisionFrameForPrompt(requestFrame);
    effectiveRequestMetadata = {
        ...effectiveRequestMetadata,
        ...requestFrameMetadata,
    };
    runtimeTask = startRuntimeTask({
        sessionId: session.id,
        input: message,
        model,
        mode: 'chat',
        transport: 'ws',
        metadata: { route: '/ws', stream: true, phase: 'preflight', reasoningEffort, ...requestFrameMetadata },
    });
    sendWsProgressPayload(ws, session.id, buildRequestFrameProgress(requestFrame));

    try {
        const runtimeToolManager = toolManager || await ensureRuntimeToolManager(ws.app);

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
                sendWsProgressPayload(ws, session.id, {
                    phase: 'podcast',
                    detail: 'Starting the podcast workflow.',
                    summary: 'Creating podcast audio',
                });

                const result = await runtimeToolManager.executeTool('podcast', podcastParams, {
                    sessionId: session.id,
                    route: '/ws',
                    transport: 'ws',
                    memoryService,
                    ownerId,
                    clientSurface,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    timezone: requestTimezone,
                    now: requestNow,
                    artifactIds: effectiveArtifactIds,
                    workloadService: ws.app?.locals?.agentWorkloadService || null,
                    managedAppService: ws.app?.locals?.managedAppService || null,
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
                await sessionStore.recordResponse(session.id, responseId);
                await sessionStore.update(session.id, {
                    metadata: {
                        taskType,
                        clientSurface: clientSurface || taskType,
                        memoryScope,
                        lastToolIntent: 'podcast',
                        lastPodcastTopic: podcastParams.topic,
                    },
                });
                memoryService.rememberResponse(session.id, assistantText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }));
                if (artifacts.length > 0) {
                    await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(session.id, {
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
                await sessionStore.appendMessages(session.id, buildWebChatSessionMessages({
                    userText: message,
                    assistantText,
                    toolEvents,
                    artifacts,
                    assistantMetadata: { directPodcast: true, toolEvents },
                }));
                await updateSessionProjectMemory(session.id, {
                    userText: message,
                    assistantText,
                    toolEvents,
                    artifacts,
                }, ownerId);

                completeRuntimeTask(runtimeTask?.id, {
                    responseId,
                    output: assistantText,
                    model: result.data?.model || model || null,
                    duration: Date.now() - startedAt,
                    metadata: {
                        directPodcast: true,
                        toolEvents,
                        artifacts,
                    },
                });
                safeWsSend(ws, { type: 'delta', content: assistantText });
                safeWsSend(ws, {
                    type: 'done',
                    sessionId: session.id,
                    responseId,
                    artifacts,
                    toolEvents,
                    assistant_metadata: buildFrontendAssistantMetadata({ directPodcast: true, artifacts }),
                    assistantMetadata: buildFrontendAssistantMetadata({ directPodcast: true, artifacts }),
                });
                return;
            }
        }

        if (effectiveOutputFormat) {
            const artifactRecentMessages = await sessionStore.getRecentMessages(
                session.id,
                WORKLOAD_PREFLIGHT_RECENT_LIMIT,
            );
            const artifactRecall = resolveTranscriptObjectiveFromSession(message, artifactRecentMessages);
            const artifactMemory = await memoryService.process(session.id, message, {
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
                toolManager: runtimeToolManager,
                sessionId: session.id,
                route: '/ws',
                transport: 'ws',
                taskType,
                text: message,
                outputFormat: effectiveOutputFormat,
                artifactIds: effectiveArtifactIds,
            });
            const artifactGenerationSession = preparedImages.resetPreviousResponse
                ? { ...session, previousResponseId: null }
                : session;
            const generation = await generateOutputArtifactFromPrompt({
                sessionId: session.id,
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
                    sessionId: session.id,
                    route: '/ws',
                    transport: 'ws',
                    memoryService,
                    ownerId,
                    clientSurface,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    timezone: requestTimezone,
                    now: requestNow,
                    artifactIds: preparedImages.artifactIds,
                    workloadService: ws.app?.locals?.agentWorkloadService || null,
                },
                executionProfile: effectiveExecutionProfile,
            });
            const responseArtifacts = mergeRuntimeArtifacts(
                preparedImages.artifacts,
                generation.artifacts,
            );

            await sessionStore.recordResponse(session.id, generation.responseId);
            await sessionStore.update(session.id, {
                metadata: {
                    lastOutputFormat: effectiveOutputFormat,
                    lastGeneratedArtifactId: generation.artifact.id,
                    taskType,
                    clientSurface: clientSurface || taskType,
                    memoryScope,
                },
            });
            memoryService.rememberResponse(
                session.id,
                generation.assistantMessage,
                buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                }),
            );
            await memoryService.rememberArtifactResult(session.id, {
                artifact: generation.artifact,
                summary: generation.assistantMessage,
                sourceText: generation.outputText,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                    sourcePrompt: message,
                    artifactFormat: effectiveOutputFormat,
                    artifactFilename: generation.artifact?.filename || '',
                }),
            });
            await memoryService.rememberLearnedSkill(session.id, {
                objective: message,
                assistantText: generation.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifact: generation.artifact,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    memoryKeywords,
                }),
            });
            await sessionStore.appendMessages(session.id, buildWebChatSessionMessages({
                userText: message,
                assistantText: generation.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifacts: responseArtifacts,
                assistantMetadata: requestFrameMetadata,
            }));
            await updateSessionProjectMemory(session.id, {
                userText: message,
                assistantText: generation.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifacts: responseArtifacts,
            }, ownerId);

            completeRuntimeTask(runtimeTask?.id, {
                responseId: generation.responseId,
                output: generation.assistantMessage,
                model: generation.model || model || null,
                duration: Date.now() - startedAt,
                metadata: {
                    outputFormat: effectiveOutputFormat,
                    artifactDirect: true,
                    toolEvents: preparedImages.toolEvents,
                    ...requestFrameMetadata,
                    ...(generation.metadata || {}),
                },
            });

            safeWsSend(ws, { type: 'delta', content: generation.assistantMessage });
            safeWsSend(ws, {
                type: 'done',
                sessionId: session.id,
                responseId: generation.responseId,
                artifacts: responseArtifacts,
                toolEvents: preparedImages.toolEvents,
                assistant_metadata: buildFrontendAssistantMetadata({ ...requestFrameMetadata, artifacts: responseArtifacts }),
                assistantMetadata: buildFrontendAssistantMetadata({ ...requestFrameMetadata, artifacts: responseArtifacts }),
            });
            return;
        }

        const responseFormattingInstructions = buildHumanCentricResponseInstructions({
            clientSurface,
            taskType,
        });
        const instructions = await buildInstructionsWithArtifacts(
            session,
            [
                requestFrameInstructions,
                buildContinuityInstructions(buildUserCheckpointInstructions(userCheckpointPolicy)),
                responseFormattingInstructions,
            ].filter(Boolean).join('\n\n'),
            effectiveArtifactIds,
        );
        const execution = await executeConversationRuntime(ws.app, {
            input: effectiveMessage,
            session,
            sessionId: session.id,
            memoryInput: message,
            previousResponseId: session.previousResponseId,
            instructions,
            stream: true,
            model,
            reasoningEffort,
            toolManager: runtimeToolManager,
            toolContext: {
                sessionId: session.id,
                route: '/ws',
                transport: 'ws',
                memoryService,
                ownerId,
                clientSurface,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                timezone: requestTimezone,
                now: requestNow,
                artifactIds: effectiveArtifactIds,
                workloadService: ws.app?.locals?.agentWorkloadService || null,
                userCheckpointPolicy,
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
                sendWsProgressPayload(ws, session.id, progress);
            },
        });
        const response = execution.response;

        let fullText = '';

        for await (const event of response) {
            if (event.type === 'response.output_text.delta') {
                fullText += event.delta;
                safeWsSend(ws, { type: 'delta', content: event.delta });
            }

            if (event.type === 'response.completed') {
                const completedText = resolveCompletedResponseText(fullText, event.response);
                const missingDelta = getMissingCompletionDelta(fullText, completedText);
                if (missingDelta) {
                    fullText = completedText;
                    safeWsSend(ws, { type: 'delta', content: missingDelta });
                } else {
                    fullText = completedText;
                }

                if (!execution.handledPersistence) {
                    await sessionStore.recordResponse(
                        session.id,
                        event.response.id,
                        event.response?.metadata?.promptState ? { promptState: event.response.metadata.promptState } : null,
                    );
                    memoryService.rememberResponse(session.id, fullText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                        sourceSurface: clientSurface || taskType,
                        memoryKeywords,
                    }));
                }
                const sshMetadata = extractSshSessionMetadataFromToolEvents(event.response?.metadata?.toolEvents);
                if (sshMetadata) {
                    await sessionStore.update(session.id, { metadata: sshMetadata });
                }
                session = await persistSessionModel(session.id, session, event.response?.model || model || null);
                session = await applyAskedUserCheckpointState(
                    sessionStore,
                    session.id,
                    session,
                    event.response?.metadata?.toolEvents || [],
                );
                const generatedArtifacts = await maybeGenerateOutputArtifact({
                    sessionId: session.id,
                    session,
                    mode: taskType,
                    outputFormat: effectiveOutputFormat,
                    content: fullText,
                    prompt: message,
                    title: 'chat-output',
                    responseId: event.response.id,
                    artifactIds,
                    model,
                    reasoningEffort,
                    recentMessages: await sessionStore.getRecentMessages(session.id, WORKLOAD_PREFLIGHT_RECENT_LIMIT),
                });
                const artifacts = mergeRuntimeArtifacts(
                    extractArtifactsFromToolEvents(event.response?.metadata?.toolEvents || []),
                    generatedArtifacts,
                );
                const piiContextIds = compactPiiContextIds(routePii, execution.pii);
                const piiPresentation = await buildTrustedPiiPresentation(fullText, {
                    sessionId: session.id,
                    ownerId,
                    contextIds: piiContextIds,
                    metadata: effectiveRequestMetadata,
                    clientSurface,
                    route: '/ws',
                });
                const piiMetadata = buildPiiCleansingMetadata(routePii, execution.pii, piiPresentation);
                if (artifacts.length > 0) {
                    await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(session.id, {
                        artifact,
                        summary: `Created the ${artifact.format || effectiveOutputFormat || 'generated'} artifact (${artifact.filename}).`,
                        sourceText: fullText,
                        metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                            sourceSurface: clientSurface || taskType,
                            memoryKeywords,
                            sourcePrompt: message,
                        }),
                    })));
                    await memoryService.rememberLearnedSkill(session.id, {
                        objective: message,
                        assistantText: fullText,
                        toolEvents: event.response?.metadata?.toolEvents || [],
                        artifact: artifacts[artifacts.length - 1],
                        metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                            sourceSurface: clientSurface || taskType,
                            memoryKeywords,
                        }),
                    });
                }
                await updateSessionProjectMemory(session.id, {
                    userText: message,
                    assistantText: fullText,
                    toolEvents: event.response?.metadata?.toolEvents || [],
                    artifacts,
                }, ownerId);
                if (!execution.handledPersistence) {
                    await sessionStore.appendMessages(session.id, buildWebChatSessionMessages({
                        userText: message,
                        assistantText: fullText,
                        toolEvents: event.response?.metadata?.toolEvents || [],
                        artifacts,
                        assistantMetadata: {
                            ...(event.response?.metadata || {}),
                            ...(piiMetadata ? { piiCleansing: piiMetadata } : {}),
                        },
                    }));
                }
                completeRuntimeTask(runtimeTask?.id, {
                    responseId: event.response.id,
                    output: fullText,
                    model: event.response.model || model || null,
                    duration: Date.now() - startedAt,
                    metadata: event.response?.metadata || {},
                });
                safeWsSend(ws, {
                    type: 'done',
                    sessionId: session.id,
                    responseId: event.response.id,
                    artifacts,
                    toolEvents: event.response?.metadata?.toolEvents || [],
                    displayContent: piiPresentation.restorations.length > 0 ? piiPresentation.text : undefined,
                    piiRestorations: piiPresentation.restorations,
                    assistant_metadata: buildAssistantUiMetadata(event.response?.metadata, artifacts, piiMetadata, piiPresentation),
                    assistantMetadata: buildAssistantUiMetadata(event.response?.metadata, artifacts, piiMetadata, piiPresentation),
                });
            }
        }
    } catch (error) {
        failRuntimeTask(runtimeTask?.id, {
            error,
            duration: Date.now() - startedAt,
            model,
        });
        throw error;
    }
}

async function handleCanvas(ws, session, payload = {}, ownerId = null) {
    let runtimeTask = null;
    const startedAt = Date.now();
    const {
        message,
        canvasType = 'document',
        existingContent = '',
        model = null,
        artifactIds = [],
        outputFormat = null,
        executionProfile = null,
    } = payload;
    const memoryKeywords = normalizeMemoryKeywords(
        payload.memoryKeywords || payload?.metadata?.memoryKeywords || [],
    );
    const reasoningEffort = resolveReasoningEffort(payload);
    const enableConversationExecutor = resolveConversationExecutorFlag(payload);
    const clientSurface = resolveClientSurface(payload || {}, session, 'canvas');
    const memoryScope = resolveSessionScope({
        ...(payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
        mode: 'canvas',
        taskType: 'canvas',
        clientSurface,
    }, session);
    const sessionIsolation = isSessionIsolationEnabled(payload?.metadata || {}, session);

    if (!message) {
        safeWsSend(ws, { type: 'error', message: "'message' is required" });
        return;
    }

    const requestFrame = buildRequestDecisionFrame({
        text: message,
        session,
        outputFormat,
        candidateOutputFormat: outputFormat,
        outputFormatProvided: Boolean(outputFormat),
        artifactIds,
        effectiveArtifactIds: artifactIds,
        executionProfile,
        taskType: 'canvas',
        clientSurface,
        route: '/ws',
    });
    const requestFrameMetadata = buildRequestDecisionMetadata(requestFrame);
    const requestFrameInstructions = formatRequestDecisionFrameForPrompt(requestFrame);
    const canvasInstructions = buildWsCanvasInstructions(canvasType, existingContent, message);

    runtimeTask = startRuntimeTask({
        sessionId: session.id,
        input: message,
        model,
        mode: 'canvas',
        transport: 'ws',
        metadata: { route: '/ws', canvasType, phase: 'preflight', reasoningEffort, ...requestFrameMetadata },
    });

    try {
        const instructions = await buildInstructionsWithArtifacts(
            session,
            [
                requestFrameInstructions,
                canvasInstructions,
            ].filter(Boolean).join('\n\n'),
            artifactIds,
        );
        const execution = await executeConversationRuntime(ws.app, {
            input: message,
            session,
            sessionId: session.id,
            memoryInput: message,
            previousResponseId: session.previousResponseId,
            instructions,
            stream: false,
            model,
            reasoningEffort,
            executionProfile,
            enableConversationExecutor,
            taskType: 'canvas',
            clientSurface,
            memoryScope,
            metadata: {
                ...(payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
                ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                clientSurface,
                ...requestFrameMetadata,
            },
            ownerId,
            toolContext: {
                sessionId: session.id,
                route: '/ws',
                transport: 'ws',
                memoryService,
                ownerId,
                clientSurface,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                artifactIds,
            },
        });
        const response = execution.response;
        if (!execution.handledPersistence) {
            await sessionStore.recordResponse(
                session.id,
                response.id,
                response?.metadata?.promptState ? { promptState: response.metadata.promptState } : null,
            );
        }

        const outputText = extractResponseText(response);
        const structured = parseWsCanvasResponse(outputText, canvasType);
        if (!execution.handledPersistence) {
            memoryService.rememberResponse(session.id, outputText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                sourceSurface: clientSurface || 'canvas',
                memoryKeywords,
            }));
            await sessionStore.appendMessages(session.id, [
                { role: 'user', content: message },
                { role: 'assistant', content: outputText, metadata: requestFrameMetadata },
            ]);
        }
        const generatedArtifacts = await maybeGenerateOutputArtifact({
            sessionId: session.id,
            session,
            mode: 'canvas',
            outputFormat,
            content: structured.content,
            prompt: message,
            title: structured.metadata?.title || `canvas-${canvasType}`,
            responseId: response.id,
            artifactIds,
            existingContent,
            model,
            reasoningEffort,
            recentMessages: await sessionStore.getRecentMessages(session.id),
        });
        const artifacts = mergeRuntimeArtifacts(
            extractArtifactsFromToolEvents(response?.metadata?.toolEvents || []),
            generatedArtifacts,
        );
        if (artifacts.length > 0) {
            await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(session.id, {
                artifact,
                summary: `Created the ${artifact.format || outputFormat || 'generated'} artifact (${artifact.filename}).`,
                sourceText: structured.content,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || 'canvas',
                    memoryKeywords,
                    sourcePrompt: message,
                }),
            })));
            await memoryService.rememberLearnedSkill(session.id, {
                objective: message,
                assistantText: structured.content,
                toolEvents: response?.metadata?.toolEvents || [],
                artifact: artifacts[artifacts.length - 1],
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || 'canvas',
                    memoryKeywords,
                }),
            });
        }
        completeRuntimeTask(runtimeTask?.id, {
            responseId: response.id,
            output: structured.content,
            model: response.model || model || null,
            duration: Date.now() - startedAt,
            metadata: {
                canvasType,
                ...requestFrameMetadata,
                ...(response?.metadata || {}),
            },
        });

        safeWsSend(ws, {
            type: 'done',
            sessionId: session.id,
            responseId: response.id,
            canvasType,
            content: structured.content,
            metadata: structured.metadata || { type: canvasType },
            suggestions: structured.suggestions || [],
            artifacts,
            assistant_metadata: requestFrameMetadata,
            assistantMetadata: requestFrameMetadata,
        });
    } catch (error) {
        failRuntimeTask(runtimeTask?.id, {
            error,
            duration: Date.now() - startedAt,
            model,
            metadata: { canvasType },
        });
        throw error;
    }
}

async function handleNotation(ws, session, payload = {}, ownerId = null) {
    let runtimeTask = null;
    const startedAt = Date.now();
    const {
        notation,
        helperMode = 'expand',
        context = '',
        model = null,
        artifactIds = [],
        outputFormat = null,
        executionProfile = null,
    } = payload;
    const memoryKeywords = normalizeMemoryKeywords(
        payload.memoryKeywords || payload?.metadata?.memoryKeywords || [],
    );
    const reasoningEffort = resolveReasoningEffort(payload);
    const enableConversationExecutor = resolveConversationExecutorFlag(payload);
    const clientSurface = resolveClientSurface(payload || {}, session, 'notation');
    const memoryScope = resolveSessionScope({
        ...(payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
        mode: 'notation',
        taskType: 'notation',
        clientSurface,
    }, session);
    const sessionIsolation = isSessionIsolationEnabled(payload?.metadata || {}, session);

    if (!notation) {
        safeWsSend(ws, { type: 'error', message: "'notation' is required" });
        return;
    }

    runtimeTask = startRuntimeTask({
        sessionId: session.id,
        input: notation,
        model,
        mode: 'notation',
        transport: 'ws',
        metadata: { route: '/ws', helperMode, phase: 'preflight', reasoningEffort },
    });

    try {
        const instructions = await buildInstructionsWithArtifacts(
            session,
            typeof buildNotationInstructions === 'function'
                ? buildNotationInstructions(helperMode, context)
                : `You are an AI notation helper in ${helperMode} mode. Respond with valid JSON: { "result": "...", "annotations": [...], "suggestions": [...] }${context ? `\nContext: ${context}` : ''}`,
            artifactIds,
        );
        const execution = await executeConversationRuntime(ws.app, {
            input: notation,
            session,
            sessionId: session.id,
            memoryInput: notation,
            previousResponseId: session.previousResponseId,
            instructions,
            stream: false,
            model,
            reasoningEffort,
            executionProfile,
            enableConversationExecutor,
            taskType: 'notation',
            clientSurface,
            memoryScope,
            metadata: {
                ...(payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
                ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                clientSurface,
            },
            ownerId,
            toolContext: {
                sessionId: session.id,
                route: '/ws',
                transport: 'ws',
                memoryService,
                ownerId,
                clientSurface,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                artifactIds,
            },
        });
        const response = execution.response;
        if (!execution.handledPersistence) {
            await sessionStore.recordResponse(
                session.id,
                response.id,
                response?.metadata?.promptState ? { promptState: response.metadata.promptState } : null,
            );
        }

        const outputText = extractResponseText(response);
        const assistantMetadata = buildFrontendAssistantMetadata({
            ...(response?.metadata || {}),
        });
        if (!execution.handledPersistence) {
            memoryService.rememberResponse(session.id, outputText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                sourceSurface: clientSurface || 'notation',
                memoryKeywords,
            }));
            await sessionStore.appendMessages(session.id, [
                { role: 'user', content: notation },
                { role: 'assistant', content: outputText, metadata: assistantMetadata },
            ]);
        }
        const structured = typeof parseNotationResponse === 'function'
            ? parseNotationResponse(outputText, helperMode)
            : { result: outputText, annotations: [], suggestions: [] };
        const generatedArtifacts = await maybeGenerateOutputArtifact({
            sessionId: session.id,
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
            recentMessages: await sessionStore.getRecentMessages(session.id),
        });
        const artifacts = mergeRuntimeArtifacts(
            extractArtifactsFromToolEvents(response?.metadata?.toolEvents || []),
            generatedArtifacts,
        );
        if (artifacts.length > 0) {
            await Promise.all(artifacts.map((artifact) => memoryService.rememberArtifactResult(session.id, {
                artifact,
                summary: `Created the ${artifact.format || outputFormat || 'generated'} artifact (${artifact.filename}).`,
                sourceText: structured.result,
                metadata: buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || 'notation',
                    memoryKeywords,
                    sourcePrompt: notation,
                }),
            })));
            await memoryService.rememberLearnedSkill(session.id, {
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
            output: outputText,
            model: response.model || model || null,
            duration: Date.now() - startedAt,
            metadata: {
                helperMode,
                ...(response?.metadata || {}),
            },
        });

        safeWsSend(ws, {
            type: 'done',
            sessionId: session.id,
            responseId: response.id,
            helperMode,
            content: structured.result,
            artifacts,
            assistant_metadata: assistantMetadata,
            assistantMetadata,
            ...structured,
        });
    } catch (error) {
        failRuntimeTask(runtimeTask?.id, {
            error,
            duration: Date.now() - startedAt,
            model,
            metadata: { helperMode },
        });
        throw error;
    }
}

// Admin WebSocket handlers
function handleAdminSubscribe(ws) {
    registerAdminConnection(ws);
    ws.isAdmin = true;
    
    // Send initial stats
    safeWsSend(ws, {
        type: 'admin_connected',
        timestamp: new Date().toISOString()
    });
    
    console.log('[WS] Admin client subscribed.');
}

function handleAdminUnsubscribe(ws) {
    unregisterAdminConnection(ws);
    ws.isAdmin = false;
    console.log('[WS] Admin client unsubscribed.');
}

// Admin event helpers
function emitTaskEvent(eventType, data) {
    broadcastToAdmins({
        type: 'task_event',
        event: eventType,
        data,
        timestamp: new Date().toISOString()
    });
}

function emitLogEvent(logEntry) {
    broadcastToAdmins({
        type: 'log_event',
        data: logEntry,
        timestamp: new Date().toISOString()
    });
}

function emitStatsUpdate(stats) {
    broadcastToAdmins({
        type: 'stats_update',
        data: stats,
        timestamp: new Date().toISOString()
    });
}

module.exports = { 
    setupWebSocket,
    adminEvents,
    broadcastToSession,
    broadcastToAdmins,
    emitTaskEvent,
    emitLogEvent,
    emitStatsUpdate
};

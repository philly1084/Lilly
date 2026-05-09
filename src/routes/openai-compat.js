const { Router } = require('express');
const { config } = require('../config');
const { sessionStore } = require('../session-store');
const { memoryService } = require('../memory/memory-service');
const { generateImageBatch, listImageModels, listModels } = require('../openai-client');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const { executeConversationRuntime, resolveConversationExecutorFlag, inferExecutionProfile } = require('../runtime-execution');
const {
    buildInstructionsWithArtifacts,
    maybeGenerateOutputArtifact,
    generateOutputArtifactFromPrompt,
    inferRequestedOutputFormat,
    isArtifactContinuationPrompt,
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
    artifactService,
    extractResponseText,
    resolveCompletedResponseText,
    getMissingCompletionDelta,
} = require('../artifacts/artifact-service');
const { stripNullCharacters } = require('../utils/text');
const { startRuntimeTask, completeRuntimeTask, failRuntimeTask } = require('../admin/runtime-monitor');
const { buildProjectMemoryUpdate, mergeProjectMemory } = require('../project-memory');
const { persistGeneratedImages } = require('../generated-image-artifacts');
const {
    buildImageGenerationDiagnostics,
    countUsableImageRecords,
    formatImageDiagnosticsSummary,
} = require('../image-generation-diagnostics');
const { buildContinuityInstructions: buildBaseContinuityInstructions } = require('../runtime-prompts');
const { buildHumanCentricResponseInstructions } = require('../session-instructions');
const { getSessionControlState } = require('../runtime-control-state');
const { buildFrontendAssistantMetadata, buildWebChatSessionMessages } = require('../web-chat-message-state');
const {
    beginForegroundTurn,
    buildForegroundTurnMessageOptions,
    cancelForegroundTurn,
    failForegroundTurn,
    persistForegroundTurnMessages,
} = require('../foreground-turn-state');
const {
    clearForegroundRequest,
    registerForegroundRequest,
} = require('../foreground-request-registry');
const { normalizeMemoryKeywords } = require('../memory/memory-keywords');
const { extractArtifactsFromToolEvents, mergeRuntimeArtifacts } = require('../runtime-artifacts');
const { isPublicChatModel, toPublicModelList } = require('../model-catalog');
const {
    buildScopedMemoryMetadata,
    buildScopedSessionMetadata,
    isSessionIsolationEnabled,
    resolveSessionScope,
} = require('../session-scope');
const {
    buildUserCheckpointAnsweredPatch,
    buildUserCheckpointAskedPatch,
    buildUserCheckpointInstructions,
    buildUserCheckpointPolicy,
    extractPendingUserCheckpoint,
    getUserCheckpointState,
    parseUserCheckpointResponseMessage,
} = require('../user-checkpoints');
const {
    extractResponseUsageMetadata,
    normalizeUsageMetadata,
} = require('../utils/token-usage');
const { buildAlignmentGuidanceContext } = require('../alignment/evaluator-service');
const {
    buildDirectPodcastAssistantMessage,
    buildDirectPodcastParams,
    shouldUseDirectPodcastChat,
} = require('../podcast/direct-podcast-chat');

const router = Router();
const FINAL_SYNTHESIS_PLACEHOLDER = 'I completed the request, but the final answer could not be synthesized from the model response.';
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

function buildOwnerMemoryMetadata(ownerId = null, memoryScope = null, extra = {}) {
    return buildScopedMemoryMetadata({
        ...(ownerId ? { ownerId } : {}),
        ...(memoryScope ? { memoryScope } : {}),
        ...extra,
    });
}

function isAbortLikeError(error, signal = null) {
    if (signal?.aborted === true) {
        return true;
    }

    const name = String(error?.name || '').trim();
    const code = String(error?.code || '').trim().toLowerCase();
    const message = String(error?.message || '').trim().toLowerCase();

    return ['AbortError', 'APIUserAbortError'].includes(name)
        || ['abort', 'aborted', 'foreground_request_aborted'].includes(code)
        || message.includes('aborted')
        || message.includes('cancelled');
}

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

function extractImagePromptText(value, depth = 0) {
    if (depth > 8 || value == null) {
        return '';
    }
    if (typeof value === 'string') {
        return value.trim();
    }
    if (Array.isArray(value)) {
        return value.map((entry) => extractImagePromptText(entry, depth + 1)).filter(Boolean).join(' ').trim();
    }
    if (typeof value === 'object') {
        return ['text', 'input_text', 'output_text', 'content', 'value']
            .map((key) => extractImagePromptText(value[key], depth + 1))
            .filter(Boolean)
            .join(' ')
            .trim();
    }
    return '';
}

function normalizeMessageText(content = '') {
    if (typeof content === 'string') {
        return stripNullCharacters(content);
    }

    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === 'string') {
                    return item;
                }

                if (item?.type === 'text' || item?.type === 'input_text' || item?.type === 'output_text') {
                    return stripNullCharacters(item.text || '');
                }

                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    return '';
}

function buildCompatUsage(rawUsage = null) {
    const normalizedUsage = normalizeUsageMetadata(rawUsage);
    if (!normalizedUsage) {
        return null;
    }

    const hasPromptTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'promptTokens');
    const hasCompletionTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'completionTokens');
    const hasTotalTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'totalTokens');
    const totalTokens = hasTotalTokens
        ? normalizedUsage.totalTokens
        : (hasPromptTokens ? normalizedUsage.promptTokens : 0) + (hasCompletionTokens ? normalizedUsage.completionTokens : 0);
    let promptTokens = hasPromptTokens ? normalizedUsage.promptTokens : null;
    let completionTokens = hasCompletionTokens ? normalizedUsage.completionTokens : null;

    if (promptTokens === null && completionTokens !== null && hasTotalTokens) {
        promptTokens = Math.max(0, totalTokens - completionTokens);
    }
    if (completionTokens === null && promptTokens !== null && hasTotalTokens) {
        completionTokens = Math.max(0, totalTokens - promptTokens);
    }

    if (promptTokens === null) {
        promptTokens = 0;
    }
    if (completionTokens === null) {
        completionTokens = totalTokens;
    }

    const compatUsage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
    };

    if (Object.prototype.hasOwnProperty.call(normalizedUsage, 'cachedTokens')) {
        compatUsage.prompt_tokens_details = {
            cached_tokens: normalizedUsage.cachedTokens,
        };
    }
    if (Object.prototype.hasOwnProperty.call(normalizedUsage, 'reasoningTokens')) {
        compatUsage.completion_tokens_details = {
            reasoning_tokens: normalizedUsage.reasoningTokens,
        };
    }

    return compatUsage;
}

function buildResponsesCompatUsage(rawUsage = null) {
    const normalizedUsage = normalizeUsageMetadata(rawUsage);
    if (!normalizedUsage) {
        return null;
    }

    const inputTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'promptTokens')
        ? normalizedUsage.promptTokens
        : (normalizedUsage.inputTokens || 0);
    const outputTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'completionTokens')
        ? normalizedUsage.completionTokens
        : (normalizedUsage.outputTokens || 0);
    const totalTokens = Object.prototype.hasOwnProperty.call(normalizedUsage, 'totalTokens')
        ? normalizedUsage.totalTokens
        : inputTokens + outputTokens;
    const compatUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
    };

    if (Object.prototype.hasOwnProperty.call(normalizedUsage, 'cachedTokens')) {
        compatUsage.input_tokens_details = {
            cached_tokens: normalizedUsage.cachedTokens,
        };
    }
    if (Object.prototype.hasOwnProperty.call(normalizedUsage, 'reasoningTokens')) {
        compatUsage.output_tokens_details = {
            reasoning_tokens: normalizedUsage.reasoningTokens,
        };
    }

    return compatUsage;
}

function buildCompatUsageFromResponse(response = {}) {
    return buildCompatUsage(extractResponseUsageMetadata(response));
}

function buildResponsesUsageFromResponse(response = {}) {
    return buildResponsesCompatUsage(extractResponseUsageMetadata(response));
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}

function normalizeStringList(value = null) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
        return value
            .split(/[>,|]/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    return [];
}

function buildGatewayDecisionPayload({
    requestedModel = null,
    resolvedModel = null,
    response = null,
    metadata = null,
    usage = null,
} = {}) {
    const sourceMetadata = metadata && typeof metadata === 'object'
        ? metadata
        : (response?.metadata && typeof response.metadata === 'object' ? response.metadata : {});
    const normalizedUsage = normalizeUsageMetadata(
        usage
        || sourceMetadata.usage
        || sourceMetadata.tokenUsage
        || response?.usage
        || null,
    );
    const requested = firstNonEmptyString(
        sourceMetadata.requested_model,
        sourceMetadata.requestedModel,
        requestedModel,
    );
    const resolved = firstNonEmptyString(
        sourceMetadata.resolved_model,
        sourceMetadata.resolvedModel,
        resolvedModel,
        response?.model,
        requested,
    );
    const fallbackChain = normalizeStringList(
        sourceMetadata.fallback_chain
        || sourceMetadata.fallbackChain
        || sourceMetadata.fallback_models
        || sourceMetadata.fallbackModels,
    );

    return {
        requested_model: requested || null,
        resolved_model: resolved || null,
        provider_id: firstNonEmptyString(
            sourceMetadata.provider_id,
            sourceMetadata.providerId,
            sourceMetadata.provider,
            sourceMetadata.provider_source,
            sourceMetadata.providerSource,
            response?.provider_id,
            response?.provider,
        ) || null,
        fallback_chain: fallbackChain,
        routing_reason: firstNonEmptyString(
            sourceMetadata.routing_reason,
            sourceMetadata.routingReason,
            sourceMetadata.route_reason,
            sourceMetadata.routeReason,
            sourceMetadata.routing?.reason,
        ) || null,
        usage_source: firstNonEmptyString(
            sourceMetadata.usage_source,
            sourceMetadata.usageSource,
            normalizedUsage?.source,
        ) || (normalizedUsage ? 'provider' : null),
    };
}

function buildResponseRecordMetadata(response = {}, { requestedModel = null, resolvedModel = null } = {}) {
    const sourceMetadata = response?.metadata && typeof response.metadata === 'object' ? response.metadata : {};
    const usage = extractResponseUsageMetadata(response);
    const gateway = buildGatewayDecisionPayload({
        requestedModel,
        resolvedModel,
        response,
        metadata: sourceMetadata,
        usage,
    });
    const updates = {
        ...(sourceMetadata.promptState ? { promptState: sourceMetadata.promptState } : {}),
        ...(usage ? { usage, tokenUsage: usage } : {}),
        gateway,
    };

    return Object.keys(updates).length > 0 ? updates : null;
}

function isResponseToolOutputItem(item = {}) {
    const type = String(item?.type || '').trim();
    return type === 'function_call' || type === 'custom_tool_call';
}

function normalizeToolArgumentsForChat(argumentsValue = {}) {
    if (typeof argumentsValue === 'string') {
        return argumentsValue;
    }

    try {
        return JSON.stringify(argumentsValue || {});
    } catch (_error) {
        return '{}';
    }
}

function responseToolItemToChatDeltaToolCall(item = {}, index = 0) {
    const callId = item.call_id || item.id || `call_${index + 1}`;
    const name = item.name || item.function?.name || '';
    const argumentsValue = item.arguments ?? item.function?.arguments ?? {};

    return {
        index,
        id: callId,
        type: 'function',
        function: {
            name,
            arguments: normalizeToolArgumentsForChat(argumentsValue),
        },
    };
}

function normalizeChatDeltaToolCalls(toolCalls = []) {
    return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall, index) => {
        const hasValidIndex = Number.isInteger(Number(toolCall?.index)) && Number(toolCall.index) >= 0;
        return {
            ...toolCall,
            index: hasValidIndex ? Number(toolCall.index) : index,
        };
    });
}

function inferOutputFormatFromTranscript(messages = [], session = null) {
    const normalizedMessages = Array.isArray(messages) ? messages : [];
    const lastUserMessage = normalizedMessages.filter((message) => message?.role === 'user').pop();
    const lastUserText = stripInjectedNotesPageEditDirective(normalizeMessageText(lastUserMessage?.content || ''));
    const mermaidContinuationIntent = /\b(mermaid|diagram|flowchart|sequence diagram|erd|entity relationship|class diagram|state diagram|artifact|file|export)\b/i.test(lastUserText);

    if (!isArtifactContinuationPrompt(lastUserText)) {
        return inferOutputFormatFromSession(lastUserText, session);
    }

    for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
        const message = normalizedMessages[index];
        const format = inferRequestedOutputFormat(stripInjectedNotesPageEditDirective(normalizeMessageText(message?.content || '')));
        if (format === 'mermaid' && !mermaidContinuationIntent) {
            continue;
        }
        if (format) {
            return format;
        }
    }

    return inferOutputFormatFromSession(lastUserText, session);
}

function isFinalSynthesisPlaceholder(text = '') {
    const normalized = stripNullCharacters(String(text || '')).trim();
    return !normalized || normalized === FINAL_SYNTHESIS_PLACEHOLDER;
}

function summarizeCompatToolEvent(event = {}) {
    const toolName = String(event?.toolCall?.function?.name || event?.result?.toolId || 'tool').trim();
    const success = event?.result?.success !== false;
    const stdout = stripNullCharacters(String(event?.result?.data?.stdout || '')).trim();
    const stderr = stripNullCharacters(String(event?.result?.data?.stderr || '')).trim();
    const error = stripNullCharacters(String(event?.result?.error || '')).trim();
    const preview = stdout || stderr || error;

    if (!success) {
        return [
            `- ${toolName}: failed.`,
            error ? `Error: ${error}` : '',
            !error && stderr ? `Details: ${stderr}` : '',
        ].filter(Boolean).join(' ');
    }

    return [
        `- ${toolName}: succeeded.`,
        preview ? `Output: ${preview.slice(0, 600)}` : '',
    ].filter(Boolean).join(' ');
}

function buildCompatToolFallbackText({ userText = '', toolEvents = [] } = {}) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    if (events.length === 0) {
        return FINAL_SYNTHESIS_PLACEHOLDER;
    }

    return [
        'Verified tool results:',
        userText ? `Request: ${stripNullCharacters(String(userText || '')).trim()}` : '',
        ...events.slice(0, 8).map((event) => summarizeCompatToolEvent(event)),
    ].filter(Boolean).join('\n');
}

function applyCompatFallbackToResponse(response = {}, text = '') {
    const normalizedText = stripNullCharacters(String(text || '')).trim();
    const metadata = response?.metadata && typeof response.metadata === 'object'
        ? response.metadata
        : {};

    const normalizedOutput = Array.isArray(response?.output) && response.output.length > 0
        ? response.output.map((item, index) => {
            if (index !== 0) {
                return item;
            }

            return {
                ...item,
                content: [{
                    type: 'output_text',
                    text: normalizedText,
                }],
            };
        })
        : [{
            id: `msg_${response?.id || 'compat_fallback'}`,
            type: 'message',
            role: 'assistant',
            content: [{
                type: 'output_text',
                text: normalizedText,
            }],
        }];

    const normalizedChoices = Array.isArray(response?.choices) && response.choices.length > 0
        ? response.choices.map((choice, index) => {
            if (index !== 0) {
                return choice;
            }

            return {
                ...choice,
                message: {
                    ...(choice?.message || {}),
                    role: 'assistant',
                    content: normalizedText,
                },
            };
        })
        : [{
            index: 0,
            message: {
                role: 'assistant',
                content: normalizedText,
            },
            finish_reason: 'stop',
        }];

    return {
        ...response,
        output_text: normalizedText,
        output: normalizedOutput,
        choices: normalizedChoices,
        metadata: {
            ...metadata,
            compatToolFallbackApplied: true,
        },
    };
}

function resolveCompatAssistantText({ response = {}, outputText = '', userText = '' } = {}) {
    const toolEvents = response?.metadata?.toolEvents || [];
    if (toolEvents.length === 0 || !isFinalSynthesisPlaceholder(outputText)) {
        return {
            outputText,
            response,
        };
    }

    const fallbackText = buildCompatToolFallbackText({
        userText,
        toolEvents,
    });

    return {
        outputText: fallbackText,
        response: applyCompatFallbackToResponse(response, fallbackText),
    };
}

function extractCompatReasoningSummary(response = {}, artifacts = []) {
    const assistantMetadata = buildFrontendAssistantMetadata({
        ...(response?.metadata || {}),
        ...(Array.isArray(artifacts) && artifacts.length > 0 ? { artifacts } : {}),
    });

    return String(assistantMetadata?.reasoningSummary || '').trim();
}

function isRemotePermissionGrantText(text = '') {
    const normalized = stripNullCharacters(String(text || '')).trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const grantsPermission = [
        /\b(i give you permission|you have permission|permission granted|i approve|approved)\b/,
        /\b(go ahead and use|you can use|allowed to use|can use)\b[\s\S]{0,20}\b(remote command|ssh|server access|remote access)\b/,
    ].some((pattern) => pattern.test(normalized));

    if (!grantsPermission) {
        return false;
    }

    return !/\b(health|report|summary|status|state|check|inspect|diagnose|debug|deploy|restart|install|fix|repair|update|change|configure|build|logs?|kubectl|pod|service|ingress)\b/.test(normalized);
}

function shouldRetryPlaceholderAsRemoteBuild({ session = null, executionProfile = 'default', outputText = '', response = {}, userText = '' } = {}) {
    if (executionProfile === 'remote-build') {
        return false;
    }

    if (!isFinalSynthesisPlaceholder(outputText)) {
        return false;
    }

    if ((response?.metadata?.toolEvents || []).length > 0) {
        return false;
    }

    const controlState = getSessionControlState(session);
    const hasStickyRemoteContext = Boolean(
        controlState?.lastToolIntent === 'remote-command'
        || controlState?.lastToolIntent === 'ssh-execute'
        || controlState?.lastSshTarget?.host
        || controlState?.remoteWorkingState?.target?.host
        || controlState?.lastRemoteObjective,
    );

    return hasStickyRemoteContext && isRemotePermissionGrantText(userText);
}

function buildArtifactPromptFromTranscript(messages = [], fallbackPrompt = '') {
    const normalizedMessages = Array.isArray(messages) ? messages : [];
    const lastUserMessage = normalizedMessages.filter((message) => message?.role === 'user').pop();
    const lastUserText = normalizeMessageText(lastUserMessage?.content || fallbackPrompt);

    if (!isArtifactContinuationPrompt(lastUserText)) {
        return lastUserText || fallbackPrompt;
    }

    const transcript = normalizedMessages
        .filter((message) => ['user', 'assistant', 'tool'].includes(message?.role))
        .slice(-8)
        .map((message) => `${message.role}: ${normalizeMessageText(message?.content || '')}`.trim())
        .filter((line) => line && !line.endsWith(':'))
        .join('\n');

    if (!transcript) {
        return lastUserText || fallbackPrompt;
    }

    return [
        'Continue or refine the same artifact request using this recent conversation context.',
        transcript,
        `Current request: ${lastUserText || fallbackPrompt}`,
    ].filter(Boolean).join('\n\n');
}

function buildContinuityInstructions(extra = '') {
    return buildBaseContinuityInstructions(extra);
}

function resolveClientSurface(payload = {}, session = null) {
    const candidates = [
        payload?.clientSurface,
        payload?.client_surface,
        payload?.metadata?.clientSurface,
        payload?.metadata?.client_surface,
        session?.metadata?.clientSurface,
        session?.metadata?.client_surface,
    ];

    return candidates.find((value) => typeof value === 'string' && value.trim()) || '';
}

function attachUpdatedControlState(session = null, controlState = null) {
    if (!session || !controlState) {
        return session;
    }

    return {
        ...session,
        controlState,
        metadata: {
            ...(session.metadata || {}),
            controlState,
        },
    };
}

async function applyAnsweredUserCheckpointState(sessionId, session, userText = '') {
    const response = parseUserCheckpointResponseMessage(userText);
    if (!response) {
        return {
            session,
            response: null,
        };
    }

    const checkpointState = getUserCheckpointState(session);
    if (checkpointState.pending?.id && checkpointState.pending.id !== response.checkpointId) {
        return {
            session,
            response,
        };
    }

    const controlState = await sessionStore.updateControlState(
        sessionId,
        buildUserCheckpointAnsweredPatch(session, response),
    );

    return {
        session: attachUpdatedControlState(session, controlState),
        response,
    };
}

async function applyAskedUserCheckpointState(sessionId, session, toolEvents = []) {
    const checkpoint = extractPendingUserCheckpoint(toolEvents);
    if (!checkpoint) {
        return session;
    }

    const controlState = await sessionStore.updateControlState(
        sessionId,
        buildUserCheckpointAskedPatch(session, checkpoint),
    );

    return attachUpdatedControlState(session, controlState);
}

function getHeaderValue(req, headerName) {
    const value = req.headers?.[headerName];
    if (Array.isArray(value)) {
        return value.find(Boolean) || null;
    }
    return value || null;
}

function resolveSessionId(req) {
    const body = req.body || {};
    const candidates = [
        body.session_id,
        body.sessionId,
        body.conversation_id,
        body.conversationId,
        body.thread_id,
        body.threadId,
        getHeaderValue(req, 'x-session-id'),
        getHeaderValue(req, 'x-conversation-id'),
        getHeaderValue(req, 'x-thread-id'),
    ];

    return candidates.find((value) => typeof value === 'string' && value.trim()) || null;
}

function setSessionHeaders(res, sessionId) {
    if (!sessionId) {
        return;
    }

    res.setHeader('X-Session-Id', sessionId);
    res.setHeader('X-Conversation-Id', sessionId);
    res.setHeader('X-Thread-Id', sessionId);
}

function openSseStream(req, res, sessionId = null, route = 'unknown') {
    let closed = false;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    setSessionHeaders(res, sessionId);
    res.flushHeaders?.();
    res.write(': stream-open\n\n');

    const keepAlive = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed) {
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
    res.on('close', cleanup);
    res.on('finish', cleanup);

    console.log(`[OpenAICompat] SSE stream opened route=${route} sessionId=${sessionId || 'unknown'}`);

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

function buildCompatStreamErrorPayload(err, sessionId = null) {
    const status = Number.isFinite(err?.statusCode)
        ? err.statusCode
        : (Number.isFinite(err?.status) ? err.status : 502);
    const message = String(err?.message || 'Connection error.').trim() || 'Connection error.';

    return {
        type: 'error',
        error: {
            message,
            code: err?.code || null,
            retryable: status >= 500 || status === 429,
        },
        status,
        sessionId,
    };
}

function closeCompatSseWithError(sse, sessionId, err) {
    if (!sse || sse.isClosed()) {
        return false;
    }

    const payload = buildCompatStreamErrorPayload(err, sessionId);
    sse.write(`data: ${JSON.stringify(payload)}\n\n`);
    sse.write(`data: ${JSON.stringify({ type: 'done', sessionId })}\n\n`);
    sse.write('data: [DONE]\n\n');
    sse.end();
    return true;
}

function writeCompatSseProgressPayload(sse, sessionId, progress = {}) {
    if (!sse || sse.isClosed()) {
        return false;
    }

    return sse.write(`data: ${JSON.stringify({
        type: 'progress',
        session_id: sessionId,
        sessionId,
        progress,
    })}\n\n`);
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
        const phase = String(progressState.phase || 'thinking').trim() || 'thinking';
        const detail = String(progressState.detail || '').trim();
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
                console.warn(`[OpenAICompat] Failed to persist foreground progress: ${error.message}`);
            });
        return pending;
    };
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

    return candidates.some((value) => isNotesSurfaceValue(value)) ? 'notes' : 'chat';
}

function shouldInjectRecentMessages(inputMessages = []) {
    if (!Array.isArray(inputMessages)) {
        return true;
    }

    // Many clients send only a system prompt plus the latest user turn. Treat that
    // as an incremental turn so the server still injects the stored session transcript.
    const transcriptMessages = inputMessages.filter((message) => ['user', 'assistant', 'tool'].includes(message?.role));
    return transcriptMessages.length <= 1;
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

    const projectMemory = mergeProjectMemory(
        session?.metadata?.projectMemory || {},
        buildProjectMemoryUpdate(updates),
    );

    return sessionStore.update(sessionId, {
        metadata: {
            projectMemory,
        },
    });
}

router.get('/models', async (_req, res, next) => {
    try {
        const [models, imageModels] = await Promise.all([
            listModels(),
            listImageModels(),
        ]);
        res.json({
            object: 'list',
            data: toPublicModelList([
                ...imageModels.map((model) => ({
                    ...model,
                    capabilities: ['image_generation'],
                })),
                ...models,
            ]),
        });
    } catch (err) {
        next(err);
    }
});

router.post('/chat/completions', async (req, res, next) => {
    let runtimeTask = null;
    let trackedSessionId = null;
    let pendingForegroundTurn = null;
    let requestAbortSignal = null;
    let foregroundTurnFinalized = false;
    let streamRequested = false;
    let activeSse = null;
    let partialAssistantText = '';
    const startedAt = Date.now();
    try {
        const {
            model: requestedModel,
            messages,
            stream = false,
            reasoning: _ignoredReasoning = null,
            artifact_ids = [],
            output_format = null,
            executionProfile = null,
            metadata: requestMetadata = {},
        } = req.body;
        streamRequested = stream === true;
        const model = isPublicChatModel(requestedModel) ? requestedModel : null;
        if (requestedModel && !model) {
            console.warn(`[OpenAICompat] Ignoring non-chat model for chat/completions: ${requestedModel}`);
        }
        const reasoningEffort = resolveReasoningEffort(req.body);
        const enableConversationExecutor = resolveConversationExecutorFlag(req.body);
        const ownerId = getRequestOwnerId(req);
        const memoryKeywords = normalizeMemoryKeywords(
            req.body.memoryKeywords || req.body?.metadata?.memoryKeywords || [],
        );
        const requestTimezone = String(
            requestMetadata?.timezone
            || requestMetadata?.timeZone
            || req.get('x-timezone')
            || ''
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

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'messages is required and must be an array',
                    type: 'invalid_request_error',
                },
            });
        }

        let sessionId = resolveSessionId(req);
        let session;
        const requestedTaskType = resolveConversationTaskType(req.body);
        const requestedClientSurface = resolveClientSurface(req.body, null);
        const requestedSessionMetadata = buildScopedSessionMetadata({
            ...effectiveRequestMetadata,
            mode: requestedTaskType,
            taskType: requestedTaskType,
            clientSurface: requestedClientSurface,
        });
        session = await sessionStore.resolveOwnedSession(
            sessionId,
            requestedSessionMetadata,
            ownerId,
        );
        if (session) {
            sessionId = session.id;
            trackedSessionId = sessionId;
        }
        if (!session) {
            return res.status(404).json({
                error: {
                    message: 'Session not found',
                    type: 'invalid_request_error',
                },
            });
        }
        trackedSessionId = sessionId;

        const clientSurface = resolveClientSurface(req.body, session);
        const memoryScope = resolveSessionScope({
            ...requestedSessionMetadata,
            taskType: requestedTaskType,
            clientSurface,
        }, session);
        const sessionIsolation = isSessionIsolationEnabled(requestedSessionMetadata, session);
        effectiveRequestMetadata = {
            ...effectiveRequestMetadata,
            clientSurface,
            memoryScope,
            ...(sessionIsolation ? { sessionIsolation: true } : {}),
        };
        const lastUserMessage = messages.filter((message) => message.role === 'user').pop();
        const lastUserText = normalizeMessageText(lastUserMessage?.content || '');
        const answeredCheckpointResult = await applyAnsweredUserCheckpointState(sessionId, session, lastUserText);
        session = answeredCheckpointResult.session;
        const userCheckpointPolicy = buildUserCheckpointPolicy({
            session,
            clientSurface,
        });
        const sshContext = resolveSshRequestContext(lastUserText, session);
        const effectiveInput = sshContext.effectivePrompt || lastUserText;
        const artifactIntentText = stripInjectedNotesPageEditDirective(lastUserText);
        const taskType = resolveConversationTaskType(req.body, session);
        pendingForegroundTurn = await beginForegroundTurn({
            sessionStore,
            sessionId,
            userText: lastUserText,
            metadata: effectiveRequestMetadata,
            clientSurface,
            taskType,
        });
        if (pendingForegroundTurn) {
            effectiveRequestMetadata = {
                ...effectiveRequestMetadata,
                foregroundTurn: pendingForegroundTurn,
            };
            const registeredForegroundRequest = registerForegroundRequest({
                sessionId,
                requestId: pendingForegroundTurn.requestId,
                ownerId,
                clientSurface,
                taskType,
                assistantMessageId: pendingForegroundTurn.assistantMessageId,
                userMessageId: pendingForegroundTurn.userMessageId,
            });
            requestAbortSignal = registeredForegroundRequest?.signal || null;
        }
        const outputFormatProvided = Boolean(output_format);
        let effectiveOutputFormat = output_format
            || inferRequestedOutputFormat(artifactIntentText)
            || inferOutputFormatFromTranscript(messages, session);
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
            console.warn('[OpenAICompat] Artifact storage unavailable; handling implicit artifact request as normal chat.');
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
            userCheckpointPolicy: {
                enabled: userCheckpointPolicy.enabled,
                maxQuestions: userCheckpointPolicy.maxQuestions,
                askedCount: userCheckpointPolicy.askedCount,
                remaining: userCheckpointPolicy.remaining,
                pending: userCheckpointPolicy.pending
                    ? {
                        id: userCheckpointPolicy.pending.id,
                        title: userCheckpointPolicy.pending.title,
                        question: userCheckpointPolicy.pending.question,
                    }
                    : null,
            },
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
        const effectiveArtifactIds = resolveArtifactContextIds(session, artifact_ids, lastUserText);
        const effectiveLastUserContent = await buildUserInputWithImageArtifacts({
            sessionId,
            text: effectiveInput,
            content: lastUserMessage?.content,
            artifactIds: effectiveArtifactIds,
        });
        const effectiveMessages = messages.map((message) => (
            message.role === 'user' && message === lastUserMessage
                ? { role: message.role, content: effectiveLastUserContent }
                : { role: message.role, content: message.content }
        ));
        const effectiveExecutionProfile = inferExecutionProfile({
            ...req.body,
            taskType,
            input: effectiveMessages,
            memoryInput: lastUserText,
            session,
        });
        const chatControlState = getSessionControlState(session);
        console.log(`[OpenAICompat] chat/completions routing sessionId=${sessionId} profile=${effectiveExecutionProfile} stickyRemote=${Boolean(chatControlState?.lastToolIntent || chatControlState?.lastSshTarget?.host || chatControlState?.lastRemoteObjective)} lastRemoteObjective=${JSON.stringify(chatControlState?.lastRemoteObjective || '')}`);
        const artifactPrompt = buildArtifactPromptFromTranscript(messages, lastUserText);
        runtimeTask = startRuntimeTask({
            sessionId,
            input: lastUserText || JSON.stringify(messages),
            model: model || null,
            mode: 'openai-chat',
            transport: 'http',
            metadata: { route: '/v1/chat/completions', stream, phase: 'preflight', reasoningEffort },
        });
        const podcastRequestOptions = getPodcastRequestOptions(effectiveRequestMetadata);
        if (shouldUseDirectPodcastChat(lastUserText) || hasStructuredPodcastRequest(effectiveRequestMetadata)) {
            const podcastParams = buildDirectPodcastParams({
                text: lastUserText,
                artifactIds: effectiveArtifactIds,
                model,
                reasoningEffort,
                podcastOptions: podcastRequestOptions,
            });
            if (podcastParams) {
                if (stream) {
                    activeSse = openSseStream(req, res, sessionId, '/v1/chat/completions#podcast');
                    writeCompatSseProgressPayload(activeSse, sessionId, {
                        phase: 'podcast',
                        detail: 'Starting the podcast workflow.',
                        summary: 'Creating podcast audio',
                    });
                }

                const toolManager = await ensureRuntimeToolManager(req.app);
                const result = await toolManager.executeTool('podcast', podcastParams, {
                    sessionId,
                    route: '/v1/chat/completions',
                    transport: 'http',
                    memoryService,
                    ownerId,
                    clientSurface,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    signal: requestAbortSignal,
                    timezone: requestTimezone,
                    now: requestNow,
                    workloadService: req.app.locals.agentWorkloadService,
                    userCheckpointPolicy,
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
                partialAssistantText = assistantText;
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
                    ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }));
                await persistForegroundTurnMessages(
                    sessionStore,
                    sessionId,
                    buildWebChatSessionMessages({
                        userText: lastUserText,
                        assistantText,
                        toolEvents,
                        artifacts,
                        ...buildForegroundTurnMessageOptions(pendingForegroundTurn),
                    }),
                    pendingForegroundTurn,
                );
                foregroundTurnFinalized = true;
                await updateSessionProjectMemory(sessionId, {
                    userText: lastUserText,
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
                        toolEvents,
                        route: 'openai-compat-direct-podcast',
                    },
                });

                const responsePayload = {
                    id: `chatcmpl-${responseId}`,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: model || 'gpt-4o',
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: assistantText,
                            artifacts,
                        },
                        finish_reason: 'stop',
                    }],
                    session_id: sessionId,
                    artifacts,
                    tool_events: toolEvents,
                    toolEvents,
                    assistant_metadata: buildFrontendAssistantMetadata({
                        toolEvents,
                        artifacts,
                    }),
                    assistantMetadata: buildFrontendAssistantMetadata({
                        toolEvents,
                        artifacts,
                    }),
                };

                if (stream) {
                    activeSse.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${responseId}-0`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model || 'gpt-4o',
                        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                    })}\n\n`);
                    activeSse.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${responseId}-1`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model || 'gpt-4o',
                        choices: [{ index: 0, delta: { content: assistantText }, finish_reason: null }],
                    })}\n\n`);
                    activeSse.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${responseId}-2`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model || 'gpt-4o',
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                        session_id: sessionId,
                        artifacts,
                        tool_events: toolEvents,
                        toolEvents,
                        assistant_metadata: responsePayload.assistant_metadata,
                        assistantMetadata: responsePayload.assistantMetadata,
                    })}\n\n`);
                    activeSse.write('data: [DONE]\n\n');
                    activeSse.end();
                    return;
                }

                res.json(responsePayload);
                return;
            }
        }
        if (effectiveOutputFormat) {
            setSessionHeaders(res, sessionId);
            activeSse = stream
                ? openSseStream(req, res, sessionId, '/v1/chat/completions#artifact')
                : null;
            const toolManager = await ensureRuntimeToolManager(req.app);
            const preparedImages = await maybePrepareImagesForArtifactPrompt({
                toolManager,
                sessionId,
                route: '/v1/chat/completions',
                transport: 'http',
                taskType,
                text: artifactPrompt,
                outputFormat: effectiveOutputFormat,
                artifactIds: effectiveArtifactIds,
            });
            const artifactGenerationSession = preparedImages.resetPreviousResponse
                ? { ...session, previousResponseId: null }
                : session;

            const generation = await generateOutputArtifactFromPrompt({
                sessionId,
                session: artifactGenerationSession,
                mode: taskType,
                outputFormat: effectiveOutputFormat,
                prompt: artifactPrompt,
                artifactIds: preparedImages.artifactIds,
                model,
                reasoningEffort,
                toolManager,
                toolContext: {
                    sessionId,
                    route: '/v1/chat/completions',
                    transport: 'http',
                    memoryService,
                    ownerId,
                    clientSurface,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    signal: requestAbortSignal,
                    timezone: requestTimezone,
                    now: requestNow,
                    workloadService: req.app.locals.agentWorkloadService,
                },
                executionProfile: effectiveExecutionProfile,
            });
            partialAssistantText = generation.assistantMessage;
            const responseArtifacts = mergeRuntimeArtifacts(
                preparedImages.artifacts,
                generation.artifacts,
            );

            await sessionStore.recordResponse(
                sessionId,
                generation.responseId,
                buildResponseRecordMetadata({
                    id: generation.responseId,
                    model: generation.model || model || null,
                    metadata: generation.metadata || {},
                }, {
                    requestedModel: model,
                    resolvedModel: generation.model || model || null,
                }),
            );
            await sessionStore.update(sessionId, {
                metadata: {
                    lastOutputFormat: effectiveOutputFormat,
                    lastGeneratedArtifactId: generation.artifact.id,
                    taskType,
                    clientSurface: clientSurface || taskType,
                    memoryScope,
                },
            });
            memoryService.rememberResponse(
                sessionId,
                generation.assistantMessage,
                buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }),
            );
            await persistForegroundTurnMessages(
                sessionStore,
                sessionId,
                buildWebChatSessionMessages({
                    userText: lastUserText,
                    assistantText: generation.assistantMessage,
                    toolEvents: preparedImages.toolEvents,
                    artifacts: responseArtifacts,
                    ...buildForegroundTurnMessageOptions(pendingForegroundTurn),
                }),
                pendingForegroundTurn,
            );
            foregroundTurnFinalized = true;
            await updateSessionProjectMemory(sessionId, {
                userText: lastUserText,
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
                    ...(generation.metadata || {}),
                },
            });

            const compatUsage = buildCompatUsage(
                generation?.metadata?.usage
                || generation?.metadata?.tokenUsage
                || null,
            );
            const resolvedModel = generation.model || model || 'gpt-4o';
            const gateway = buildGatewayDecisionPayload({
                requestedModel: model,
                resolvedModel,
                metadata: generation.metadata || {},
                usage: generation?.metadata?.usage || generation?.metadata?.tokenUsage || null,
            });

            if (stream) {
                activeSse?.write(`data: ${JSON.stringify({
                    id: `chatcmpl-${sessionId}-0`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: resolvedModel,
                    choices: [{ index: 0, delta: { content: generation.assistantMessage }, finish_reason: null }],
                })}\n\n`);
                activeSse?.write(`data: ${JSON.stringify({
                    id: `chatcmpl-${sessionId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: resolvedModel,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    ...(compatUsage ? { usage: compatUsage } : {}),
                    gateway,
                    session_id: sessionId,
                    artifacts: responseArtifacts,
                    tool_events: preparedImages.toolEvents,
                    toolEvents: preparedImages.toolEvents,
                    assistant_metadata: buildFrontendAssistantMetadata({ artifacts: responseArtifacts }),
                    assistantMetadata: buildFrontendAssistantMetadata({ artifacts: responseArtifacts }),
                })}\n\n`);
                activeSse?.write('data: [DONE]\n\n');
                activeSse?.end();
                return;
            }

            res.json({
                id: `chatcmpl-${generation.responseId}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: resolvedModel,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: generation.assistantMessage,
                        artifacts: responseArtifacts,
                    },
                    finish_reason: 'stop',
                }],
                ...(compatUsage ? { usage: compatUsage } : {}),
                gateway,
                session_id: sessionId,
                artifacts: responseArtifacts,
                tool_events: preparedImages.toolEvents,
                toolEvents: preparedImages.toolEvents,
                assistant_metadata: buildFrontendAssistantMetadata({ artifacts: responseArtifacts }),
                assistantMetadata: buildFrontendAssistantMetadata({ artifacts: responseArtifacts }),
            });
            return;
        }

        const artifactInstructions = effectiveOutputFormat
            ? artifactService.getGenerationInstructions(effectiveOutputFormat)
            : '';
        const userCheckpointInstructions = buildUserCheckpointInstructions(userCheckpointPolicy);
        const responseFormattingInstructions = buildHumanCentricResponseInstructions({
            clientSurface,
            taskType,
        });
        const alignmentGuidanceInstructions = buildAlignmentGuidanceContext(session);
        const instructions = await buildInstructionsWithArtifacts(
            session,
            buildContinuityInstructions(
                [artifactInstructions, alignmentGuidanceInstructions, userCheckpointInstructions, responseFormattingInstructions]
                    .filter(Boolean)
                    .join('\n\n'),
            ),
            effectiveArtifactIds,
        );
        const input = effectiveMessages;

        if (stream) {
            activeSse = openSseStream(req, res, sessionId, '/v1/chat/completions');
            const toolManager = await ensureRuntimeToolManager(req.app);
            const persistForegroundProgress = createForegroundProgressPersister({
                sessionStore,
                sessionId,
                foregroundTurn: pendingForegroundTurn,
            });
            const execution = await executeConversationRuntime(req.app, {
                input: effectiveMessages,
                session,
                sessionId,
                memoryInput: lastUserText,
                loadContextMessages: Boolean(lastUserText),
                loadRecentMessages: shouldInjectRecentMessages(messages),
                previousResponseId: session.previousResponseId,
                instructions,
                stream: true,
                model,
                reasoningEffort,
                signal: requestAbortSignal,
                toolManager,
                toolContext: {
                    sessionId,
                    route: '/v1/chat/completions',
                    transport: 'http',
                    clientSurface,
                    memoryService,
                    ownerId,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    signal: requestAbortSignal,
                    timezone: requestTimezone,
                    now: requestNow,
                    workloadService: req.app.locals.agentWorkloadService,
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
                    writeCompatSseProgressPayload(activeSse, sessionId, progress);
                    if (persistForegroundProgress) {
                        persistForegroundProgress(progress);
                    }
                },
            });
            const response = execution.response;
            console.log(`[OpenAICompat] chat/completions stream mode=${response?.kimibuiltStreamMode || 'unknown'} runtime=${execution.runtimeMode || 'unknown'} sessionId=${sessionId}`);

            let fullText = '';
            let chunkIndex = 0;

            activeSse.write(`data: ${JSON.stringify({
                id: `chatcmpl-${sessionId}-${chunkIndex}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model || 'gpt-4o',
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            })}\n\n`);
            chunkIndex += 1;

            for await (const event of response) {
                if (event.type === 'response.output_text.delta') {
                    fullText += event.delta;
                    partialAssistantText = fullText;
                    activeSse.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${sessionId}-${chunkIndex}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model || 'gpt-4o',
                        choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
                    })}\n\n`);
                    chunkIndex += 1;
                }

                if (event.type === 'response.reasoning_summary_text.delta' && event.delta) {
                    activeSse.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${sessionId}-${chunkIndex}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model || 'gpt-4o',
                        choices: [{ index: 0, delta: { reasoning: event.delta }, finish_reason: null }],
                        type: 'response.reasoning_summary_text.delta',
                        delta: event.delta,
                        summary: event.summary || '',
                    })}\n\n`);
                    chunkIndex += 1;
                }

                if (event.type === 'chat.completion.tool_calls.delta'
                    && Array.isArray(event.tool_calls)
                    && event.tool_calls.length > 0) {
                    const toolCalls = normalizeChatDeltaToolCalls(event.tool_calls);
                    activeSse.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${sessionId}-${chunkIndex}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model || 'gpt-4o',
                        choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
                        tool_calls: toolCalls,
                    })}\n\n`);
                    chunkIndex += 1;
                }

                if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done')
                    && isResponseToolOutputItem(event.item)) {
                    const toolCalls = [responseToolItemToChatDeltaToolCall(event.item)];
                    activeSse.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${sessionId}-${chunkIndex}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model || 'gpt-4o',
                        choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
                        type: event.type,
                        item: event.item,
                        tool_calls: toolCalls,
                    })}\n\n`);
                    chunkIndex += 1;
                }

                if (event.type === 'response.completed') {
                    const completedText = resolveCompletedResponseText(fullText, event.response);
                    const resolvedCompletion = resolveCompatAssistantText({
                        response: event.response,
                        outputText: completedText,
                        userText: lastUserText,
                    });
                    const missingDelta = getMissingCompletionDelta(fullText, resolvedCompletion.outputText);
                    if (missingDelta) {
                        fullText = resolvedCompletion.outputText;
                        partialAssistantText = fullText;
                        activeSse.write(`data: ${JSON.stringify({
                            id: `chatcmpl-${sessionId}-${chunkIndex}`,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: model || 'gpt-4o',
                            choices: [{ index: 0, delta: { content: missingDelta }, finish_reason: null }],
                        })}\n\n`);
                        chunkIndex += 1;
                    } else {
                        fullText = resolvedCompletion.outputText;
                        partialAssistantText = fullText;
                    }

                    const toolEvents = resolvedCompletion.response?.metadata?.toolEvents || [];
                    if (!execution.handledPersistence) {
                        await sessionStore.recordResponse(
                            sessionId,
                            resolvedCompletion.response.id,
                            buildResponseRecordMetadata(resolvedCompletion.response, { requestedModel: model }),
                        );
                        memoryService.rememberResponse(sessionId, fullText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                            sourceSurface: clientSurface || taskType,
                            ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                            ...(sessionIsolation ? { sessionIsolation: true } : {}),
                        }));
                    }
                    const sshMetadata = extractSshSessionMetadataFromToolEvents(resolvedCompletion.response?.metadata?.toolEvents);
                    if (sshMetadata) {
                        await sessionStore.update(sessionId, { metadata: sshMetadata });
                    }
                    session = await applyAskedUserCheckpointState(sessionId, session, toolEvents);
                    const generatedArtifacts = await maybeGenerateOutputArtifact({
                        sessionId,
                        session,
                        mode: taskType,
                        outputFormat: effectiveOutputFormat,
                        content: fullText,
                        prompt: artifactPrompt,
                        title: 'chat-output',
                        responseId: resolvedCompletion.response.id,
                        artifactIds: artifact_ids,
                        model,
                        reasoningEffort,
                    });
                    const artifacts = mergeRuntimeArtifacts(
                        extractArtifactsFromToolEvents(toolEvents),
                        generatedArtifacts,
                    );
                    await updateSessionProjectMemory(sessionId, {
                        userText: lastUserText,
                        assistantText: fullText,
                        toolEvents,
                        artifacts,
                    }, ownerId);
                    if (execution.handledPersistence) {
                        foregroundTurnFinalized = true;
                    }
                    if (!execution.handledPersistence) {
                        await persistForegroundTurnMessages(
                            sessionStore,
                            sessionId,
                            buildWebChatSessionMessages({
                                userText: lastUserText,
                                assistantText: fullText,
                                toolEvents,
                                artifacts,
                                assistantMetadata: resolvedCompletion.response?.metadata,
                                ...buildForegroundTurnMessageOptions(pendingForegroundTurn),
                            }),
                            pendingForegroundTurn,
                        );
                        foregroundTurnFinalized = true;
                    }
                    completeRuntimeTask(runtimeTask?.id, {
                        responseId: resolvedCompletion.response.id,
                        output: fullText,
                        model: resolvedCompletion.response.model || model || null,
                        duration: Date.now() - startedAt,
                        metadata: resolvedCompletion.response?.metadata || {},
                    });
                    const compatUsage = buildCompatUsageFromResponse(resolvedCompletion.response);
                    const gateway = buildGatewayDecisionPayload({
                        requestedModel: model,
                        response: resolvedCompletion.response,
                        usage: extractResponseUsageMetadata(resolvedCompletion.response),
                    });
                    activeSse.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${sessionId}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: resolvedCompletion.response.model || model || 'gpt-4o',
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                        ...(compatUsage ? { usage: compatUsage } : {}),
                        gateway,
                        session_id: sessionId,
                        artifacts,
                        tool_events: toolEvents,
                        toolEvents,
                        assistant_metadata: buildFrontendAssistantMetadata({
                            ...(resolvedCompletion.response?.metadata || {}),
                            artifacts,
                        }),
                        assistantMetadata: buildFrontendAssistantMetadata({
                            ...(resolvedCompletion.response?.metadata || {}),
                            artifacts,
                        }),
                    })}\n\n`);
                    activeSse.write('data: [DONE]\n\n');
                }
            }

            activeSse.end();
            return;
        }

        setSessionHeaders(res, sessionId);
        const runtimeToolManager = await ensureRuntimeToolManager(req.app);
        const execution = await executeConversationRuntime(req.app, {
            input: effectiveMessages,
            session,
            sessionId,
            memoryInput: lastUserText,
            loadContextMessages: Boolean(lastUserText),
            loadRecentMessages: shouldInjectRecentMessages(messages),
            previousResponseId: session.previousResponseId,
            instructions,
            stream: false,
            model,
            reasoningEffort,
            signal: requestAbortSignal,
            toolManager: runtimeToolManager,
            toolContext: {
                sessionId,
                route: '/v1/chat/completions',
                transport: 'http',
                clientSurface,
                memoryService,
                ownerId,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                signal: requestAbortSignal,
                timezone: requestTimezone,
                now: requestNow,
                workloadService: req.app.locals.agentWorkloadService,
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
        });
        let response = execution.response;
        if (!execution.handledPersistence) {
            await sessionStore.recordResponse(
                sessionId,
                response.id,
                buildResponseRecordMetadata(response, { requestedModel: model }),
            );
        }
        let outputText = extractResponseText(response);
        const resolvedCompatResponse = resolveCompatAssistantText({
            response,
            outputText,
            userText: lastUserText,
        });
        response = resolvedCompatResponse.response;
        outputText = resolvedCompatResponse.outputText;
        partialAssistantText = outputText;
        if (shouldRetryPlaceholderAsRemoteBuild({
            session,
            executionProfile: effectiveExecutionProfile,
            outputText,
            response,
            userText: lastUserText,
        })) {
            console.warn(`[OpenAICompat] Retrying placeholder direct response as remote-build. sessionId=${sessionId}`);
            const retriedExecution = await executeConversationRuntime(req.app, {
                input: effectiveMessages,
                session,
                sessionId,
                memoryInput: lastUserText,
                loadContextMessages: Boolean(lastUserText),
                loadRecentMessages: shouldInjectRecentMessages(messages),
                previousResponseId: session.previousResponseId,
                instructions,
                stream: false,
                model,
                reasoningEffort,
                signal: requestAbortSignal,
                toolManager: runtimeToolManager,
                toolContext: {
                    sessionId,
                    route: '/v1/chat/completions',
                    transport: 'http',
                    clientSurface,
                    memoryService,
                    ownerId,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    signal: requestAbortSignal,
                    timezone: requestTimezone,
                    now: requestNow,
                    workloadService: req.app.locals.agentWorkloadService,
                    userCheckpointPolicy,
                },
                executionProfile: 'remote-build',
                enableAutomaticToolCalls: true,
                enableConversationExecutor,
                taskType,
                clientSurface,
                memoryScope,
                metadata: {
                    ...effectiveRequestMetadata,
                    remoteBuildAutonomyApproved: true,
                },
                ownerId,
            });
            response = retriedExecution.response;
            outputText = extractResponseText(response);
            partialAssistantText = outputText;
        }
        if (!execution.handledPersistence) {
            memoryService.rememberResponse(sessionId, outputText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                sourceSurface: clientSurface || taskType,
                ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                ...(sessionIsolation ? { sessionIsolation: true } : {}),
            }));
        }
        const sshMetadata = extractSshSessionMetadataFromToolEvents(response?.metadata?.toolEvents);
        if (sshMetadata) {
            await sessionStore.update(sessionId, { metadata: sshMetadata });
        }
        session = await applyAskedUserCheckpointState(sessionId, session, response?.metadata?.toolEvents || []);
        const generatedArtifacts = await maybeGenerateOutputArtifact({
            sessionId,
            session,
            mode: taskType,
            outputFormat: effectiveOutputFormat,
            content: outputText,
            prompt: artifactPrompt,
            title: 'chat-output',
            responseId: response.id,
            artifactIds: artifact_ids,
            model,
            reasoningEffort,
        });
        const artifacts = mergeRuntimeArtifacts(
            extractArtifactsFromToolEvents(response?.metadata?.toolEvents || []),
            generatedArtifacts,
        );
        await updateSessionProjectMemory(sessionId, {
            userText: lastUserText,
            assistantText: outputText,
            toolEvents: response?.metadata?.toolEvents || [],
            artifacts,
        }, ownerId);
        if (execution.handledPersistence) {
            foregroundTurnFinalized = true;
        }
        if (!execution.handledPersistence) {
            await persistForegroundTurnMessages(
                sessionStore,
                sessionId,
                buildWebChatSessionMessages({
                    userText: lastUserText,
                    assistantText: outputText,
                    toolEvents: response?.metadata?.toolEvents || [],
                    artifacts,
                    assistantMetadata: response?.metadata,
                    ...buildForegroundTurnMessageOptions(pendingForegroundTurn),
                }),
                pendingForegroundTurn,
            );
            foregroundTurnFinalized = true;
        }
        completeRuntimeTask(runtimeTask?.id, {
            responseId: response.id,
            output: outputText,
            model: response.model || model || null,
            duration: Date.now() - startedAt,
            metadata: response?.metadata || {},
        });
        const compatReasoningSummary = extractCompatReasoningSummary(response, artifacts);
        const compatUsage = buildCompatUsageFromResponse(response);
        const gateway = buildGatewayDecisionPayload({
            requestedModel: model,
            response,
            usage: extractResponseUsageMetadata(response),
        });

        res.json({
            id: `chatcmpl-${response.id}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: response.model || model || 'gpt-4o',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: outputText,
                    ...(compatReasoningSummary ? { reasoning: compatReasoningSummary } : {}),
                    artifacts,
                },
                finish_reason: 'stop',
            }],
            ...(compatUsage ? { usage: compatUsage } : {}),
            gateway,
            session_id: sessionId,
            artifacts,
            tool_events: response?.metadata?.toolEvents || [],
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
        if (isAbortLikeError(err, requestAbortSignal)) {
            completeRuntimeTask(runtimeTask?.id, {
                output: partialAssistantText || 'Stopped.',
                model: req.body?.model || null,
                duration: Date.now() - startedAt,
                metadata: { cancelled: true },
            });
            if (pendingForegroundTurn && !foregroundTurnFinalized) {
                try {
                    await cancelForegroundTurn(
                        sessionStore,
                        trackedSessionId,
                        pendingForegroundTurn,
                        {
                            message: partialAssistantText,
                            cancelledBy: 'user',
                            reason: 'user_cancelled',
                        },
                    );
                    foregroundTurnFinalized = true;
                } catch (foregroundError) {
                    console.warn('[OpenAICompat] Failed to persist foreground turn cancellation:', foregroundError.message);
                }
            }
            if (activeSse && !activeSse.isClosed()) {
                activeSse.end();
            }
            console.warn(`[OpenAICompat] chat/completions cancelled sessionId=${trackedSessionId || 'unknown'}`);
            return;
        }

        failRuntimeTask(runtimeTask?.id, {
            error: err,
            duration: Date.now() - startedAt,
            model: req.body?.model || null,
            metadata: { reasoningEffort: resolveReasoningEffort(req.body) },
        });
        if (pendingForegroundTurn && !foregroundTurnFinalized) {
            try {
                await failForegroundTurn(
                    sessionStore,
                    trackedSessionId,
                    pendingForegroundTurn,
                    `Request failed: ${err.message || 'The request could not be completed.'}`,
                );
            } catch (foregroundError) {
                console.warn('[OpenAICompat] Failed to persist foreground turn failure:', foregroundError.message);
            }
        }
        if (streamRequested && closeCompatSseWithError(activeSse, trackedSessionId, err)) {
            console.warn(`[OpenAICompat] chat/completions stream failed gracefully sessionId=${trackedSessionId || 'unknown'}: ${err.message}`);
            return;
        }
        next(err);
    } finally {
        clearForegroundRequest({
            sessionId: trackedSessionId,
            requestId: pendingForegroundTurn?.requestId || null,
        });
    }
});

router.post('/responses', async (req, res, next) => {
    let runtimeTask = null;
    let streamRequested = false;
    let activeSse = null;
    let trackedSessionId = null;
    const startedAt = Date.now();
    try {
        const {
            model,
            input,
            instructions,
            stream = false,
            reasoning: _ignoredReasoning = null,
            artifact_ids = [],
            output_format = null,
            executionProfile = null,
            metadata: requestMetadata = {},
        } = req.body;
        streamRequested = stream === true;
        const reasoningEffort = resolveReasoningEffort(req.body);
        const enableConversationExecutor = resolveConversationExecutorFlag(req.body);
        const ownerId = getRequestOwnerId(req);
        const memoryKeywords = normalizeMemoryKeywords(
            req.body.memoryKeywords || req.body?.metadata?.memoryKeywords || [],
        );
        const requestTimezone = String(
            requestMetadata?.timezone
            || requestMetadata?.timeZone
            || req.get('x-timezone')
            || ''
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

        let sessionId = resolveSessionId(req);
        let session;
        const requestedTaskType = resolveConversationTaskType(req.body);
        const requestedClientSurface = resolveClientSurface(req.body, null);
        const requestedSessionMetadata = buildScopedSessionMetadata({
            ...effectiveRequestMetadata,
            mode: requestedTaskType,
            taskType: requestedTaskType,
            clientSurface: requestedClientSurface,
        });
        session = await sessionStore.resolveOwnedSession(
            sessionId,
            requestedSessionMetadata,
            ownerId,
        );
        if (session) {
            sessionId = session.id;
        }
        trackedSessionId = sessionId;
        if (!session) {
            return res.status(404).json({
                error: {
                    message: 'Session not found',
                    type: 'invalid_request_error',
                },
            });
        }

        const normalizedInputMessages = typeof input === 'string'
            ? [{ role: 'user', content: input }]
            : (Array.isArray(input)
                ? input.filter((item) => item?.role).map((item) => ({ role: item.role, content: item.content }))
                : []);
        const userInput = typeof input === 'string'
            ? input
            : normalizeMessageText(input.filter((item) => item.role === 'user').pop()?.content || '');
        const sshContext = resolveSshRequestContext(userInput, session);
        const effectiveUserInput = sshContext.effectivePrompt || userInput;
        const artifactIntentText = stripInjectedNotesPageEditDirective(userInput);
        const taskType = resolveConversationTaskType(req.body, session);
        const clientSurface = resolveClientSurface(req.body, session);
        const memoryScope = resolveSessionScope({
            ...requestedSessionMetadata,
            taskType,
            clientSurface,
        }, session);
        const sessionIsolation = isSessionIsolationEnabled(requestedSessionMetadata, session);
        effectiveRequestMetadata = {
            ...effectiveRequestMetadata,
            clientSurface,
            memoryScope,
            ...(sessionIsolation ? { sessionIsolation: true } : {}),
        };
        const outputFormatProvided = Boolean(output_format);
        let effectiveOutputFormat = output_format
            || inferRequestedOutputFormat(artifactIntentText)
            || inferOutputFormatFromTranscript(normalizedInputMessages, session);
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
            console.warn('[OpenAICompat] Artifact storage unavailable; handling implicit artifact request as normal response.');
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
        const effectiveArtifactIds = resolveArtifactContextIds(session, artifact_ids, userInput);
        const artifactPrompt = buildArtifactPromptFromTranscript(normalizedInputMessages, userInput);
        runtimeTask = startRuntimeTask({
            sessionId,
            input: userInput || JSON.stringify(input),
            model: model || null,
            mode: 'openai-responses',
            transport: 'http',
            metadata: { route: '/v1/responses', stream, phase: 'preflight', reasoningEffort },
        });
        if (effectiveOutputFormat) {
            setSessionHeaders(res, sessionId);
            const toolManager = await ensureRuntimeToolManager(req.app);
            const preparedImages = await maybePrepareImagesForArtifactPrompt({
                toolManager,
                sessionId,
                route: '/v1/responses',
                transport: 'http',
                taskType,
                text: artifactPrompt,
                outputFormat: effectiveOutputFormat,
                artifactIds: effectiveArtifactIds,
            });
            const artifactGenerationSession = preparedImages.resetPreviousResponse
                ? { ...session, previousResponseId: null }
                : session;

            if (stream) {
                activeSse = openSseStream(req, res, sessionId, '/v1/responses#artifact');
            }

            const generation = await generateOutputArtifactFromPrompt({
                sessionId,
                session: artifactGenerationSession,
                mode: taskType,
                outputFormat: effectiveOutputFormat,
                prompt: artifactPrompt,
                artifactIds: preparedImages.artifactIds,
                model,
                reasoningEffort,
                toolManager,
                toolContext: {
                    sessionId,
                    route: '/v1/responses',
                    transport: 'http',
                    memoryService,
                    ownerId,
                    clientSurface,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    timezone: requestTimezone,
                    now: requestNow,
                    workloadService: req.app.locals.agentWorkloadService,
                },
                executionProfile: effectiveExecutionProfile,
            });
            const responseArtifacts = mergeRuntimeArtifacts(
                preparedImages.artifacts,
                generation.artifacts,
            );

            await sessionStore.recordResponse(
                sessionId,
                generation.responseId,
                buildResponseRecordMetadata({
                    id: generation.responseId,
                    model: generation.model || model || null,
                    metadata: generation.metadata || {},
                }, {
                    requestedModel: model,
                    resolvedModel: generation.model || model || null,
                }),
            );
            await sessionStore.update(sessionId, {
                metadata: {
                    lastOutputFormat: effectiveOutputFormat,
                    lastGeneratedArtifactId: generation.artifact.id,
                    taskType,
                    clientSurface: clientSurface || taskType,
                    memoryScope,
                },
            });
            memoryService.rememberResponse(
                sessionId,
                generation.assistantMessage,
                buildOwnerMemoryMetadata(ownerId, memoryScope, {
                    sourceSurface: clientSurface || taskType,
                    ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }),
            );
            await sessionStore.appendMessages(sessionId, buildWebChatSessionMessages({
                userText: userInput,
                assistantText: generation.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifacts: responseArtifacts,
            }));
            await updateSessionProjectMemory(sessionId, {
                userText: userInput,
                assistantText: generation.assistantMessage,
                toolEvents: preparedImages.toolEvents,
                artifacts: responseArtifacts,
            }, ownerId);

            const responsesUsage = buildResponsesCompatUsage(
                generation?.metadata?.usage
                || generation?.metadata?.tokenUsage
                || null,
            );
            const resolvedModel = generation.model || model || 'gpt-4o';
            const gateway = buildGatewayDecisionPayload({
                requestedModel: model,
                resolvedModel,
                metadata: generation.metadata || {},
                usage: generation?.metadata?.usage || generation?.metadata?.tokenUsage || null,
            });
            const syntheticResponse = {
                id: generation.responseId,
                object: 'response',
                created_at: Math.floor(Date.now() / 1000),
                model: resolvedModel,
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: generation.assistantMessage }],
                }],
                ...(responsesUsage ? { usage: responsesUsage } : {}),
                gateway,
            };

            completeRuntimeTask(runtimeTask?.id, {
                responseId: generation.responseId,
                output: generation.assistantMessage,
                model: generation.model || model || null,
                duration: Date.now() - startedAt,
                metadata: {
                    outputFormat: effectiveOutputFormat,
                    artifactDirect: true,
                    toolEvents: preparedImages.toolEvents,
                    ...(generation.metadata || {}),
                },
            });

            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: generation.assistantMessage })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    type: 'response.completed',
                    response: syntheticResponse,
                    ...(responsesUsage ? { usage: responsesUsage } : {}),
                    gateway,
                    session_id: sessionId,
                    artifacts: responseArtifacts,
                    tool_events: preparedImages.toolEvents,
                    toolEvents: preparedImages.toolEvents,
                })}\n\n`);
                res.end();
                return;
            }

            res.json({
                ...syntheticResponse,
                ...(responsesUsage ? { usage: responsesUsage } : {}),
                gateway,
                session_id: sessionId,
                artifacts: responseArtifacts,
                tool_events: preparedImages.toolEvents,
                toolEvents: preparedImages.toolEvents,
            });
            return;
        }

        const artifactInstructions = effectiveOutputFormat
            ? artifactService.getGenerationInstructions(effectiveOutputFormat)
            : '';
        const alignmentGuidanceInstructions = buildAlignmentGuidanceContext(session);
        const fullInstructions = await buildInstructionsWithArtifacts(
            session,
            [buildContinuityInstructions(), alignmentGuidanceInstructions, instructions || '', artifactInstructions].filter(Boolean).join('\n\n'),
            effectiveArtifactIds,
        );
        const lastUserIndex = normalizedInputMessages.map((entry) => entry.role).lastIndexOf('user');
        const effectiveUserContent = await buildUserInputWithImageArtifacts({
            sessionId,
            text: effectiveUserInput,
            content: lastUserIndex >= 0 ? normalizedInputMessages[lastUserIndex]?.content : null,
            artifactIds: effectiveArtifactIds,
        });
        const runtimeInput = typeof input === 'string'
            ? effectiveUserContent
            : normalizedInputMessages.map((message, index) => {
                const isLastUser = message.role === 'user' && index === lastUserIndex;
                return isLastUser
                    ? { ...message, content: effectiveUserContent }
                    : message;
            });
        const effectiveExecutionProfile = inferExecutionProfile({
            ...req.body,
            taskType,
            input: runtimeInput,
            memoryInput: userInput,
            session,
        });
        const responsesControlState = getSessionControlState(session);
        console.log(`[OpenAICompat] responses routing sessionId=${sessionId} profile=${effectiveExecutionProfile} stickyRemote=${Boolean(responsesControlState?.lastToolIntent || responsesControlState?.lastSshTarget?.host || responsesControlState?.lastRemoteObjective)} lastRemoteObjective=${JSON.stringify(responsesControlState?.lastRemoteObjective || '')}`);

        if (stream) {
            activeSse = openSseStream(req, res, sessionId, '/v1/responses');
            const toolManager = await ensureRuntimeToolManager(req.app);
            const execution = await executeConversationRuntime(req.app, {
                input: runtimeInput,
                session,
                sessionId,
                memoryInput: userInput,
                loadContextMessages: Boolean(userInput),
                loadRecentMessages: typeof input === 'string' || shouldInjectRecentMessages(input),
                previousResponseId: session.previousResponseId,
                instructions: fullInstructions,
                stream: true,
                model,
                reasoningEffort,
                toolManager,
                toolContext: {
                    sessionId,
                    route: '/v1/responses',
                    transport: 'http',
                    clientSurface,
                    memoryService,
                    ownerId,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    timezone: requestTimezone,
                    now: requestNow,
                    workloadService: req.app.locals.agentWorkloadService,
                },
                executionProfile: effectiveExecutionProfile,
                enableAutomaticToolCalls: true,
                enableConversationExecutor,
                taskType,
                clientSurface,
                memoryScope,
                metadata: effectiveRequestMetadata,
                ownerId,
            });
            const response = execution.response;
            console.log(`[OpenAICompat] responses stream mode=${response?.kimibuiltStreamMode || 'unknown'} runtime=${execution.runtimeMode || 'unknown'} sessionId=${sessionId}`);

            let fullText = '';
            for await (const event of response) {
                if (event.type === 'response.output_text.delta') {
                    fullText += event.delta;
                    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: event.delta })}\n\n`);
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
                    const resolvedCompletion = resolveCompatAssistantText({
                        response: event.response,
                        outputText: completedText,
                        userText: userInput,
                    });
                    const missingDelta = getMissingCompletionDelta(fullText, resolvedCompletion.outputText);
                    if (missingDelta) {
                        fullText = resolvedCompletion.outputText;
                        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: missingDelta })}\n\n`);
                    } else {
                        fullText = resolvedCompletion.outputText;
                    }

                    if (!execution.handledPersistence) {
                        await sessionStore.recordResponse(
                            sessionId,
                            resolvedCompletion.response.id,
                            buildResponseRecordMetadata(resolvedCompletion.response, { requestedModel: model }),
                        );
                        memoryService.rememberResponse(sessionId, fullText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                            sourceSurface: clientSurface || taskType,
                            ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                            ...(sessionIsolation ? { sessionIsolation: true } : {}),
                        }));
                    }
                    const sshMetadata = extractSshSessionMetadataFromToolEvents(resolvedCompletion.response?.metadata?.toolEvents);
                    if (sshMetadata) {
                        await sessionStore.update(sessionId, { metadata: sshMetadata });
                    }
                    const generatedArtifacts = await maybeGenerateOutputArtifact({
                        sessionId,
                        session,
                        mode: taskType,
                        outputFormat: effectiveOutputFormat,
                        content: fullText,
                        prompt: artifactPrompt,
                        title: 'response-output',
                        responseId: resolvedCompletion.response.id,
                        artifactIds: artifact_ids,
                        model,
                        reasoningEffort,
                    });
                    const artifacts = mergeRuntimeArtifacts(
                        extractArtifactsFromToolEvents(resolvedCompletion.response?.metadata?.toolEvents || []),
                        generatedArtifacts,
                    );
                    await updateSessionProjectMemory(sessionId, {
                        userText: userInput,
                        assistantText: fullText,
                        toolEvents: resolvedCompletion.response?.metadata?.toolEvents || [],
                        artifacts,
                    }, ownerId);
                    if (!execution.handledPersistence) {
                        await sessionStore.appendMessages(sessionId, buildWebChatSessionMessages({
                            userText: userInput,
                            assistantText: fullText,
                            toolEvents: resolvedCompletion.response?.metadata?.toolEvents || [],
                            artifacts,
                            assistantMetadata: resolvedCompletion.response?.metadata,
                        }));
                    }
                    completeRuntimeTask(runtimeTask?.id, {
                        responseId: resolvedCompletion.response.id,
                        output: fullText,
                        model: resolvedCompletion.response.model || model || null,
                        duration: Date.now() - startedAt,
                        metadata: resolvedCompletion.response?.metadata || {},
                    });
                    const responsesUsage = buildResponsesUsageFromResponse(resolvedCompletion.response);
                    const gateway = buildGatewayDecisionPayload({
                        requestedModel: model,
                        response: resolvedCompletion.response,
                        usage: extractResponseUsageMetadata(resolvedCompletion.response),
                    });
                    const completedResponse = {
                        ...resolvedCompletion.response,
                        ...(responsesUsage ? { usage: responsesUsage } : {}),
                        gateway,
                    };
                    res.write(`data: ${JSON.stringify({
                        type: 'response.completed',
                        response: completedResponse,
                        ...(responsesUsage ? { usage: responsesUsage } : {}),
                        gateway,
                        session_id: sessionId,
                        artifacts,
                        tool_events: resolvedCompletion.response?.metadata?.toolEvents || [],
                        toolEvents: resolvedCompletion.response?.metadata?.toolEvents || [],
                        assistant_metadata: buildFrontendAssistantMetadata({
                            ...(resolvedCompletion.response?.metadata || {}),
                            artifacts,
                        }),
                        assistantMetadata: buildFrontendAssistantMetadata({
                            ...(resolvedCompletion.response?.metadata || {}),
                            artifacts,
                        }),
                    })}\n\n`);
                }
            }

            res.end();
            return;
        }

        setSessionHeaders(res, sessionId);
        const runtimeToolManager = await ensureRuntimeToolManager(req.app);
        const execution = await executeConversationRuntime(req.app, {
            input: runtimeInput,
            session,
            sessionId,
            memoryInput: userInput,
            loadContextMessages: Boolean(userInput),
            loadRecentMessages: typeof input === 'string' || shouldInjectRecentMessages(input),
            previousResponseId: session.previousResponseId,
            instructions: fullInstructions,
            stream: false,
            model,
            reasoningEffort,
            toolManager: runtimeToolManager,
            toolContext: {
                sessionId,
                route: '/v1/responses',
                transport: 'http',
                clientSurface,
                memoryService,
                ownerId,
                memoryScope,
                sessionIsolation,
                memoryKeywords,
                timezone: requestTimezone,
                now: requestNow,
                workloadService: req.app.locals.agentWorkloadService,
            },
            executionProfile: effectiveExecutionProfile,
            enableAutomaticToolCalls: true,
            enableConversationExecutor,
            taskType,
            clientSurface,
            memoryScope,
            metadata: effectiveRequestMetadata,
            ownerId,
        });
        let response = execution.response;
        if (!execution.handledPersistence) {
            await sessionStore.recordResponse(
                sessionId,
                response.id,
                buildResponseRecordMetadata(response, { requestedModel: model }),
            );
        }
        let outputText = extractResponseText(response);
        const resolvedCompatResponse = resolveCompatAssistantText({
            response,
            outputText,
            userText: userInput,
        });
        response = resolvedCompatResponse.response;
        outputText = resolvedCompatResponse.outputText;
        if (shouldRetryPlaceholderAsRemoteBuild({
            session,
            executionProfile: effectiveExecutionProfile,
            outputText,
            response,
            userText: userInput,
        })) {
            console.warn(`[OpenAICompat] Retrying placeholder direct response as remote-build. sessionId=${sessionId}`);
            const retriedExecution = await executeConversationRuntime(req.app, {
                input: runtimeInput,
                session,
                sessionId,
                memoryInput: userInput,
                loadContextMessages: Boolean(userInput),
                loadRecentMessages: typeof input === 'string' || shouldInjectRecentMessages(input),
                previousResponseId: session.previousResponseId,
                instructions: fullInstructions,
                stream: false,
                model,
                reasoningEffort,
                toolManager: runtimeToolManager,
                toolContext: {
                    sessionId,
                    route: '/v1/responses',
                    transport: 'http',
                    clientSurface,
                    memoryService,
                    ownerId,
                    memoryScope,
                    sessionIsolation,
                    memoryKeywords,
                    timezone: requestTimezone,
                    now: requestNow,
                    workloadService: req.app.locals.agentWorkloadService,
                },
                executionProfile: 'remote-build',
                enableAutomaticToolCalls: true,
                enableConversationExecutor,
                taskType,
                clientSurface,
                memoryScope,
                metadata: {
                    ...effectiveRequestMetadata,
                    remoteBuildAutonomyApproved: true,
                },
                ownerId,
            });
            response = retriedExecution.response;
            outputText = extractResponseText(response);
        }
        if (!execution.handledPersistence) {
            memoryService.rememberResponse(sessionId, outputText, buildOwnerMemoryMetadata(ownerId, memoryScope, {
                sourceSurface: clientSurface || taskType,
                ...(memoryKeywords.length > 0 ? { memoryKeywords } : {}),
                ...(sessionIsolation ? { sessionIsolation: true } : {}),
            }));
        }
        const sshMetadata = extractSshSessionMetadataFromToolEvents(response?.metadata?.toolEvents);
        if (sshMetadata) {
            await sessionStore.update(sessionId, { metadata: sshMetadata });
        }
        const generatedArtifacts = await maybeGenerateOutputArtifact({
            sessionId,
            session,
            mode: taskType,
            outputFormat: effectiveOutputFormat,
            content: outputText,
            prompt: artifactPrompt,
            title: 'response-output',
            responseId: response.id,
            artifactIds: artifact_ids,
            model,
            reasoningEffort,
        });
        const artifacts = mergeRuntimeArtifacts(
            extractArtifactsFromToolEvents(response?.metadata?.toolEvents || []),
            generatedArtifacts,
        );
        await updateSessionProjectMemory(sessionId, {
            userText: userInput,
            assistantText: outputText,
            toolEvents: response?.metadata?.toolEvents || [],
            artifacts,
        }, ownerId);
        if (!execution.handledPersistence) {
            await sessionStore.appendMessages(sessionId, buildWebChatSessionMessages({
                userText: userInput,
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
        const responsesUsage = buildResponsesUsageFromResponse(response);
        const gateway = buildGatewayDecisionPayload({
            requestedModel: model,
            response,
            usage: extractResponseUsageMetadata(response),
        });

        res.json({
            ...response,
            ...(responsesUsage ? { usage: responsesUsage } : {}),
            gateway,
            session_id: sessionId,
            artifacts,
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
        if (streamRequested && closeCompatSseWithError(activeSse, trackedSessionId, err)) {
            console.warn(`[OpenAICompat] responses stream failed gracefully sessionId=${trackedSessionId || 'unknown'}: ${err.message}`);
            return;
        }
        next(err);
    }
});

router.post('/images/generations', async (req, res, next) => {
    let runtimeTask = null;
    const startedAt = Date.now();
    let promptText = '';
    let sessionIdForFailure = null;
    let modelForFailure = req.body?.model || null;
    let requestedCountForFailure = Math.min(Math.max(Number(req.body?.n) || 1, 1), 10);

    try {
        const {
            prompt,
            model = null,
            n = 1,
            size = 'auto',
            quality = 'auto',
            style = null,
            background = 'auto',
            response_format = null,
            output_format = null,
            output_compression = null,
            moderation = null,
            user = null,
            batch_mode = 'auto',
            batchMode = batch_mode,
        } = req.body;
        modelForFailure = model;
        promptText = extractImagePromptText(prompt);
        if (!promptText) {
            return res.status(400).json({
                error: {
                    message: 'Image generation requires a non-empty prompt.',
                    type: 'invalid_request_error',
                },
            });
        }
        const requestedCount = Math.min(Math.max(Number(n) || 1, 1), 10);
        requestedCountForFailure = requestedCount;

        let sessionId = resolveSessionId(req);
        const ownerId = getRequestOwnerId(req);
        const requestedClientSurface = resolveClientSurface(req.body, null) || 'image';
        const requestedSessionMetadata = buildScopedSessionMetadata({
            mode: 'image',
            taskType: 'image',
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
            return res.status(404).json({
                error: {
                    message: 'Session not found',
                    type: 'invalid_request_error',
                },
            });
        }
        sessionIdForFailure = sessionId;
        const clientSurface = resolveClientSurface(req.body, session) || requestedClientSurface;

        runtimeTask = startRuntimeTask({
            sessionId,
            input: promptText,
            model: model || 'gateway-default',
            mode: 'image',
            transport: 'openai-compatible-http',
            metadata: {
                route: '/v1/images/generations',
                clientSurface,
                requestedCount,
                size,
                quality,
            },
        });

        const response = await generateImageBatch({
            prompt,
            model,
            size,
            quality,
            style,
            background,
            response_format,
            output_format,
            output_compression,
            moderation,
            user,
            n: requestedCount,
            batchMode,
        });
        const persistedImages = await persistGeneratedImages({
            sessionId,
            sourceMode: 'image',
            prompt: promptText,
            model: response?.model || model || null,
            images: response?.data || [],
        });
        const imageUsage = normalizeUsageMetadata(response?.usage || null);
        const normalizedResponse = {
            ...response,
            model: response?.model || model || null,
            requested_model: response?.requested_model || model || null,
            provider_call_count: Math.max(1, Number(response?.provider_call_count || 1)),
            parsed_count: Number.isFinite(Number(response?.parsed_count))
                ? Number(response.parsed_count)
                : (Array.isArray(response?.data) ? response.data.length : 0),
            ...(imageUsage ? { usage: imageUsage } : {}),
            data: persistedImages.images,
        };
        const diagnostics = buildImageGenerationDiagnostics({
            route: '/v1/images/generations',
            stage: 'route_response_build',
            source: 'backend-route',
            upstreamDiagnostics: response?.diagnostics?.imageGeneration,
            parsedImages: response?.data || [],
            returnedImages: normalizedResponse.data || [],
            artifacts: persistedImages.artifacts || [],
            artifactPersistence: persistedImages.artifactPersistence || null,
            requestedCount,
            model: normalizedResponse.model || model || null,
            size: normalizedResponse.size || size,
            quality: normalizedResponse.quality || quality,
            prompt: promptText,
        });
        normalizedResponse.diagnostics = {
            ...(response?.diagnostics || {}),
            imageGeneration: diagnostics,
        };
        const usableImageCount = countUsableImageRecords(normalizedResponse.data || []);
        const diagnosticSummary = formatImageDiagnosticsSummary(diagnostics);
        const responseId = `img_${Date.now()}`;
        const runtimeMetadata = {
            ...(imageUsage ? { usage: imageUsage, tokenUsage: imageUsage } : {}),
            gateway: buildGatewayDecisionPayload({
                requestedModel: model,
                resolvedModel: normalizedResponse.model || model || null,
                metadata: {
                    provider_id: response?.diagnostics?.imageGeneration?.provider?.source
                        || response?.diagnostics?.imageGeneration?.providerSource
                        || 'image-provider',
                    usage_source: imageUsage?.source || (imageUsage ? 'provider' : null),
                },
                usage: imageUsage,
            }),
            image: {
                requested_model: normalizedResponse.requested_model || null,
                model: normalizedResponse.model || null,
                provider_call_count: normalizedResponse.provider_call_count,
                parsed_count: normalizedResponse.parsed_count,
            },
            diagnostics: {
                imageGeneration: diagnostics,
            },
            imageDiagnostics: diagnostics,
            toolEvents: [{
                toolCall: {
                    function: {
                        name: 'image-generate',
                    },
                },
                result: {
                    success: usableImageCount > 0,
                    toolId: 'image-generate',
                    data: {
                        model: normalizedResponse.model,
                        counts: diagnostics.counts,
                        flags: diagnostics.flags,
                    },
                    error: usableImageCount > 0 ? null : diagnosticSummary,
                },
                reason: 'Image generation request',
            }],
        };

        await sessionStore.recordResponse(sessionId, responseId, {
            ...(imageUsage ? { usage: imageUsage, tokenUsage: imageUsage } : {}),
            gateway: runtimeMetadata.gateway,
            image: runtimeMetadata.image,
        });
        await updateSessionProjectMemory(sessionId, {
            userText: promptText,
            assistantText: usableImageCount > 0
                ? `Generated ${usableImageCount} usable image result(s).`
                : `Image generation returned no usable image data. ${diagnosticSummary}`,
            artifacts: persistedImages.artifacts,
            toolEvents: runtimeMetadata.toolEvents,
        }, ownerId);
        setSessionHeaders(res, sessionId);

        const duration = Date.now() - startedAt;
        if (usableImageCount > 0) {
            completeRuntimeTask(runtimeTask?.id, {
                responseId,
                output: `Generated ${usableImageCount} usable image result(s).`,
                model: normalizedResponse.model || model || 'gateway-default',
                duration,
                metadata: runtimeMetadata,
            });
        } else {
            failRuntimeTask(runtimeTask?.id, {
                error: diagnosticSummary || 'Image generation returned no usable image data.',
                model: normalizedResponse.model || model || 'gateway-default',
                duration,
                metadata: runtimeMetadata,
            });
        }

        res.json({
            ...normalizedResponse,
            session_id: sessionId,
            artifacts: persistedImages.artifacts,
        });
    } catch (err) {
        const diagnostics = buildImageGenerationDiagnostics({
            route: '/v1/images/generations',
            stage: 'route_error',
            source: 'backend-route',
            requestedCount: requestedCountForFailure,
            model: modelForFailure,
            prompt: promptText,
            error: err,
        });
        failRuntimeTask(runtimeTask?.id, {
            error: err,
            model: modelForFailure || 'gateway-default',
            duration: Date.now() - startedAt,
            metadata: {
                diagnostics: {
                    imageGeneration: diagnostics,
                },
                imageDiagnostics: diagnostics,
                sessionId: sessionIdForFailure,
            },
        });
        next(err);
    }
});

module.exports = router;








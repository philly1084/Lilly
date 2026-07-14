const { sessionStore } = require('./session-store');
const { memoryService } = require('./memory/memory-service');
const { createResponse } = require('./openai-client');
const { extractResponseText } = require('./artifacts/artifact-service');
const {
    buildContextContinuityFrame,
    resolveTranscriptObjectiveFromSession,
} = require('./conversation-continuity');
const { getSessionControlState } = require('./runtime-control-state');
const { config } = require('./config');
const { buildScopedMemoryMetadata, isSessionIsolationEnabled, resolveProjectKey, resolveSessionScope } = require('./session-scope');
const { sanitizeRuntimePayload } = require('./pii');
const {
    buildAgentDirectedRuntimeInstructions,
    resolveAgentDirectedRuntimeFlag,
} = require('./agent-directed-runtime');
const { buildSessionInstructions } = require('./session-instructions');
const {
    buildAgentJournalInstructions,
    loadAgentJournalEntries,
} = require('./agent-journal');
const settingsController = require('./routes/admin/settings.controller');
const {
    buildAuditSessionPatch,
    runAfterProcessAudit,
} = require('./after-process-audit');

const RECENT_TRANSCRIPT_LIMIT = config.memory.recentTranscriptLimit;
const DEFAULT_EXECUTION_PROFILE = 'default';
const NOTES_EXECUTION_PROFILE = 'notes';
const REMOTE_BUILD_EXECUTION_PROFILE = 'remote-build';
const PODCAST_EXECUTION_PROFILE = 'podcast';
const PODCAST_VIDEO_EXECUTION_PROFILE = 'podcast-video';

function isRemotePermissionGrantText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const grantsPermission = [
        /\b(i give you permission|you have permission|permission granted|i approve|approved)\b/,
        /\b(go ahead and use|you can use|allowed to use|can use)\b[\s\S]{0,20}\b(remote cli|remote command|ssh|server access|remote access)\b/,
    ].some((pattern) => pattern.test(normalized));

    if (!grantsPermission) {
        return false;
    }

    return !/\b(health|report|summary|status|state|check|inspect|diagnose|debug|deploy|restart|install|fix|repair|update|change|configure|build|logs?|kubectl|pod|service|ingress)\b/.test(normalized);
}

function hasRemoteResumeIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /^(?:yes|yeah|yep)[.!]?\s+(?:we can\s+)?(?:continue|resume|go ahead|proceed)\b/,
        /^(?:we can\s+)?(?:continue|resume|go ahead|proceed)\b/,
        /^(continue|proceed|next|go ahead|do it|do that|finish|use remote-build|use the remote build)\b/,
        /\b(next step|next steps|keep going|from this page|from there|on the server|against the server)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasStickyRemoteStatusIntentText(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(status|state|progress|blocker|blockers|error|errors|issue|issues|failure|failures)\b/,
        /\b(where (?:are|did) we)\b/,
        /\b(what(?:'s| is) (?:the )?(?:current )?(?:status|state|progress|blocker|issue|error|failure))\b/,
        /\b(show|summarize|recap|explain)\b[\s\S]{0,30}\b(status|state|progress|blocker|error|issue|failure)\b/,
        /\b(why|what)\b[\s\S]{0,24}\b(failing|failed|stopped|broken|wrong)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasRemoteSoftwareCreationIntent(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        /\b(create|develop|build|make|ship|launch|publish|scaffold|prototype)\b[\s\S]{0,60}\b(app|application|website|site|frontend|service|game|software|web app)\b[\s\S]{0,80}\b(server|remote|ssh|gitlab|gitea|cluster|k3s|kubernetes|environment|sandbox)\b/,
        /\b(server|remote|ssh|gitlab|gitea|cluster|k3s|kubernetes|environment|sandbox)\b[\s\S]{0,80}\b(create|develop|build|make|ship|launch|publish|scaffold|prototype)\b[\s\S]{0,60}\b(app|application|website|site|frontend|service|game|software|web app)\b/,
        /\b(this (?:server|cluster|environment|sandbox))\b[\s\S]{0,60}\b(create|develop|build|make|ship|launch|publish)\b[\s\S]{0,60}\b(app|application|website|site|frontend|service|game|software|web app)\b/,
        /\b(create|develop|build|make|ship|launch|publish|scaffold|prototype)\b[\s\S]{0,80}\b(app|application|web app|service|software)\b[\s\S]{0,180}\b(full[- ]stack|production[- ]oriented|deployment setup|database-backed|real-time(?:-ready)? chat)\b/,
    ].some((pattern) => pattern.test(normalized));
}

function hasActiveRemoteWorkflowState(controlState = {}) {
    const workflowStatus = String(controlState?.workflow?.status || '').trim().toLowerCase();
    const projectPlanStatus = String(controlState?.projectPlan?.status || '').trim().toLowerCase();
    const hasWorkflow = Boolean(controlState?.workflow)
        && !['completed', 'failed', 'cancelled', 'done', 'stopped'].includes(workflowStatus);
    const hasProjectPlan = Boolean(controlState?.projectPlan)
        && !['completed', 'cancelled', 'done'].includes(projectPlanStatus);
    const hasContinuationGate = controlState?.foregroundContinuationGate?.paused === true;
    const hasRemoteObjective = Boolean(
        String(controlState?.lastRemoteObjective || '').trim()
        || String(controlState?.activeTaskFrame?.objective || '').trim(),
    );

    return hasWorkflow || hasProjectPlan || (hasContinuationGate && hasRemoteObjective);
}

function resolveRecentTranscriptLimitForContinuity({
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    clientSurface = '',
    taskType = '',
    controlState = {},
} = {}) {
    const normalizedSurface = String(clientSurface || taskType || '').trim().toLowerCase();
    const activeWorkflow = hasActiveRemoteWorkflowState(controlState);
    const documentSurface = ['canvas', 'notation', 'notes', 'notes-app', 'notes-editor'].includes(normalizedSurface);
    if (executionProfile === REMOTE_BUILD_EXECUTION_PROFILE || activeWorkflow || documentSurface) {
        return Math.max(
            RECENT_TRANSCRIPT_LIMIT,
            Number(config.memory.activeContinuityRecentTranscriptLimit || 0) || RECENT_TRANSCRIPT_LIMIT,
        );
    }

    return RECENT_TRANSCRIPT_LIMIT;
}

function inferRecallProfile(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return 'default';
    }

    return /\b(web research|research|look up|search for|search the web|browse the web|search online|browse online|latest|current|today|news)\b/.test(normalized)
        ? 'research'
        : 'default';
}

function resolveConversationExecutorFlag(payload = {}) {
    return [
        payload?.enableConversationExecutor,
        payload?.enable_conversation_executor,
        payload?.useAgentExecutor,
        payload?.use_agent_executor,
        payload?.metadata?.enableConversationExecutor,
        payload?.metadata?.enable_conversation_executor,
        payload?.metadata?.useAgentExecutor,
        payload?.metadata?.use_agent_executor,
    ].some((value) => value === true);
}

function normalizeExecutionProfile(value = '') {
    const normalized = String(value || '').trim().toLowerCase();

    if (!normalized) {
        return DEFAULT_EXECUTION_PROFILE;
    }

    if ([
        'remote-build',
        'remote_builder',
        'remote-builder',
        'server-build',
        'server-builder',
        'software-builder',
    ].includes(normalized)) {
        return REMOTE_BUILD_EXECUTION_PROFILE;
    }

    if ([
        'notes',
        'notes-app',
        'notes_app',
        'notes-editor',
        'notes_editor',
    ].includes(normalized)) {
        return NOTES_EXECUTION_PROFILE;
    }

    if ([
        'podcast',
        'podcast-audio',
        'podcast_audio',
    ].includes(normalized)) {
        return PODCAST_EXECUTION_PROFILE;
    }

    if ([
        'podcast-video',
        'podcast_video',
        'video-podcast',
        'video_podcast',
    ].includes(normalized)) {
        return PODCAST_VIDEO_EXECUTION_PROFILE;
    }

    return DEFAULT_EXECUTION_PROFILE;
}

function extractRuntimeText(input = '') {
    if (typeof input === 'string') {
        return input;
    }

    if (!Array.isArray(input)) {
        return '';
    }

    const normalizeContent = (content) => {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .map((part) => part?.text || '')
                .filter(Boolean)
                .join('\n');
        }

        return '';
    };

    for (let index = input.length - 1; index >= 0; index -= 1) {
        const item = input[index];
        if (item?.role === 'user') {
            const content = normalizeContent(item.content);
            if (content) {
                return content;
            }
        }
    }

    return input
        .map((item) => normalizeContent(item?.content))
        .filter(Boolean)
        .join('\n');
}

function hasSessionIdentityInstructions(instructions = '') {
    const text = String(instructions || '');
    return text.includes('[Agent soul]')
        || text.includes('[User profile memory]')
        || text.includes('[Session isolation]');
}

function hasAgentJournalInstructions(instructions = '') {
    return /<kimi-agent-journal\b/i.test(String(instructions || ''));
}

async function scheduleDirectAfterProcessAudit({
    sessionId,
    ownerId = null,
    response = null,
    inputText = '',
    taskType = '',
    executionProfile = DEFAULT_EXECUTION_PROFILE,
    runtimeMode = 'direct',
    clientSurface = '',
    memoryScope = '',
    metadata = {},
    outputText = '',
} = {}) {
    if (process.env.NODE_ENV === 'test' && process.env.KIMIBUILT_AFTER_PROCESS_AUDIT_TEST !== 'true') {
        return null;
    }
    if (!sessionId || !response) {
        return null;
    }

    const responseMetadata = response?.metadata && typeof response.metadata === 'object'
        ? response.metadata
        : {};
    const toolEvents = Array.isArray(responseMetadata.toolEvents) ? responseMetadata.toolEvents : [];
    const orchestrationConfig = typeof settingsController.getEffectiveOrchestrationConfig === 'function'
        ? settingsController.getEffectiveOrchestrationConfig()
        : {};
    const output = String(outputText || '').trim() || extractResponseText(response);
    const trace = {
        sessionId,
        taskType,
        executionProfile,
        runtimeMode,
        clientSurface,
        memoryScope,
        selectedSkills: responseMetadata.selectedSkills || [],
        skillsUsed: responseMetadata.skillsUsed || [],
        decisionTrace: responseMetadata.decisionTrace || null,
        verification: responseMetadata.verification || null,
        toolCount: toolEvents.length,
        tools: responseMetadata.plannedTools || metadata?.plannedTools || [],
        timestamp: new Date().toISOString(),
    };
    let currentSession = null;
    try {
        currentSession = ownerId && sessionStore?.getOwned
            ? await sessionStore.getOwned(sessionId, ownerId)
            : (sessionStore?.get ? await sessionStore.get(sessionId) : null);
    } catch (error) {
        console.warn(`[RuntimeExecution] After-process audit session lookup failed: ${error.message}`);
    }

    const promise = runAfterProcessAudit({
        sessionId,
        ownerId,
        responseId: response.id || null,
        userText: inputText,
        objective: inputText,
        taskType,
        executionProfile,
        runtimeMode,
        toolEvents,
        output,
        responseMetadata,
        trace,
        clientSurface,
        orchestrationConfig,
        existingMetadata: currentSession?.metadata || {},
    })
        .then(async (result) => {
            if (!sessionStore?.update || result?.status === 'skipped') {
                return result;
            }
            const patch = buildAuditSessionPatch(currentSession?.metadata || {}, result);
            if (Object.keys(patch).length > 0) {
                await sessionStore.update(sessionId, { metadata: patch });
            }
            return result;
        })
        .catch((error) => {
            console.warn(`[RuntimeExecution] After-process audit failed: ${error.message}`);
        });

    return promise;
}

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

function inferExecutionProfile(payload = {}) {
    const taskType = String(
        payload?.taskType
        || payload?.task_type
        || payload?.clientSurface
        || payload?.client_surface
        || payload?.metadata?.taskType
        || payload?.metadata?.task_type
        || payload?.metadata?.clientSurface
        || payload?.metadata?.client_surface
        || '',
    ).trim().toLowerCase();
    const notesSurfaceRequested = ['notes', 'notes-app', 'notes_app', 'notes-editor', 'notes_editor'].includes(taskType);
    const podcastSurfaceRequested = ['podcast', 'podcast-audio', 'podcast_audio'].includes(taskType);
    const podcastVideoSurfaceRequested = ['podcast-video', 'podcast_video', 'video-podcast', 'video_podcast'].includes(taskType);
    const configuredProfile = normalizeExecutionProfile(
        payload?.executionProfile
        || payload?.execution_profile
        || payload?.agentProfile
        || payload?.agent_profile
        || payload?.metadata?.executionProfile
        || payload?.metadata?.execution_profile
        || payload?.metadata?.agentProfile
        || payload?.metadata?.agent_profile,
    );
    const requestedNotesProfile = configuredProfile === NOTES_EXECUTION_PROFILE
        || notesSurfaceRequested;

    if (notesSurfaceRequested) {
        return NOTES_EXECUTION_PROFILE;
    }

    if (podcastVideoSurfaceRequested || configuredProfile === PODCAST_VIDEO_EXECUTION_PROFILE) {
        return PODCAST_VIDEO_EXECUTION_PROFILE;
    }

    if (podcastSurfaceRequested || configuredProfile === PODCAST_EXECUTION_PROFILE) {
        return PODCAST_EXECUTION_PROFILE;
    }

    if (configuredProfile === REMOTE_BUILD_EXECUTION_PROFILE) {
        return REMOTE_BUILD_EXECUTION_PROFILE;
    }

    const text = String(payload?.memoryInput || '').trim() || extractRuntimeText(payload?.input || '');
    const normalized = String(text || '').toLowerCase();
    const controlState = getSessionControlState(payload?.session || { metadata: payload?.metadata || {} });
    const stickyRemoteIntent = ['ssh-execute', 'remote-command', 'remote-cli-agent'].includes(
        String(controlState.lastToolIntent || '').trim().toLowerCase(),
    );
    const stickyRemoteTarget = Boolean(
        controlState?.lastSshTarget?.host
        || controlState?.remoteWorkingState?.target?.host,
    );
    const stickyRemoteWorkflow = hasActiveRemoteWorkflowState(controlState);
    const stickyRemoteContext = stickyRemoteIntent || stickyRemoteTarget || stickyRemoteWorkflow;
    const pageEditIntent = normalized
        ? [
            /\b(put|add|insert|place|append|prepend|move|drop|apply|write|turn|convert|use|set)\b[\s\S]{0,40}\b(on|into|to|in)\b[\s\S]{0,20}\b(page|note|document|doc)\b/,
            /\b(edit|update|rewrite|reformat|reorganize|restyle|clean up|fix)\b[\s\S]{0,40}\b(page|note|document|doc)\b/,
            /\b(current page|this page|the page|this note|the note)\b/,
        ].some((pattern) => pattern.test(normalized))
        : false;
    const knownDeployDomainStatusIntent = /\b(check|verify|inspect|debug|diagnose|troubleshoot|status|health|working|live|up)\b/.test(normalized)
        && /\b(?:[a-z0-9-]+\.)+(?:demoserver2\.buzz|secdevsolutions\.help)\b/i.test(normalized);
    const deployedPublicDomainStatusIntent = /\b(check|verify|inspect|debug|diagnose|troubleshoot|status|health|working|live|up)\b[\s\S]{0,60}\b(deployed|deployment|live|public|routed|ingress|tls|dns|site|website|app)\b[\s\S]{0,120}\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i.test(normalized)
        || /\b(deployed|deployment|live|public|routed|ingress|tls|dns|site|website|app)\b[\s\S]{0,120}\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b[\s\S]{0,60}\b(check|verify|inspect|debug|diagnose|troubleshoot|status|health|working|live|up)\b/i.test(normalized);

    if (!normalized) {
        return requestedNotesProfile ? NOTES_EXECUTION_PROFILE : DEFAULT_EXECUTION_PROFILE;
    }

    const remoteBuildIntent = [
        /\bssh\b/,
        /\bremote-build\b/,
        /\bremote build\b/,
        /\b(remote host|remote server|remote machine)\b/,
        /\b(remote cli|remote command|run remotely|execute remotely)\b/,
        /\bremote into\b/,
        /\bremote cli into\b/,
        /\b(reach|check|access|inspect)\b[\s\S]{0,30}\bremote build\b/,
        /\b(log ?in to|ssh into|ssh to|connect to)\b/,
        /\b(deploy|release|rollout|restart)\b[\s\S]{0,40}\b(server|host|container|cluster|pod|deployment)\b/,
        /\b(kubectl|kubernetes|k8s|docker compose|docker-compose|systemctl|journalctl|nginx|pm2)\b/,
        /\b(build|compile|install|run)\b[\s\S]{0,40}\b(on|via)\b[\s\S]{0,20}\b(server|ssh|remote)\b/,
        /\b(gitlab|gitea|image repo|container registry)\b/,
        /\bwhat (?:address|url|domain|host)\b[\s\S]{0,60}\bdeploy(?:ed)?\b/,
        /\bdeploy(?:ed)?\b[\s\S]{0,80}\b(?:didn['’]?t|doesn['’]?t|won['’]?t|not)\s+work\b[\s\S]{0,80}\b(?:try again|retry|rerun|re-run|redeploy|fix)\b/,
        /\b(?:try again|retry|rerun|re-run|redeploy)\b[\s\S]{0,80}\b(?:deploy|deployment|route|ingress|dns|tls|public url|public host)\b/,
    ].some((pattern) => pattern.test(normalized));
    const remoteContinuationIntent = (stickyRemoteIntent || stickyRemoteWorkflow)
        && hasRemoteResumeIntentText(normalized);
    const stickyRemoteWorkIntent = stickyRemoteContext && [
        /^(continue|proceed|next|go ahead|do it|do that|finish|retry|try again|rerun|re-run|resume|keep going|keep working)\b/,
        /\b(replace|update|deploy|publish|push|upload|install|restart|reload|rollout|fix|repair|override|swap|remove|copy)\b[\s\S]{0,50}\b(site|website|app|application|game|frontend|ingress|deployment|service|pod|html|index\.html|homepage|landing)\b/,
        /\b(put|get|bring|take)\b[\s\S]{0,30}\b(live|online|running|deployed|serving)\b/,
        /\b(remote cli into|remote command into|ssh into|connect to)\b[\s\S]{0,30}\b(server|host|machine)\b/,
        /\b(on|to|for)\b[\s\S]{0,20}\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/,
        /\b(current html|index\.html|site html|website html)\b/,
        /\b(game|website|site|app)\b[\s\S]{0,30}\b(live|online|deployment|ingress|domain|dns|tls)\b/,
        /\b(create|develop|build|make|ship|launch|publish|scaffold)\b[\s\S]{0,50}\b(app|application|website|site|frontend|service|game|software)\b[\s\S]{0,50}\b(gitlab|gitea|cluster|deployment|ingress|domain|environment|sandbox)\b/,
    ].some((pattern) => pattern.test(normalized));
    const stickyRemoteStatusIntent = stickyRemoteContext && hasStickyRemoteStatusIntentText(normalized);
    const stickyRemoteApprovalIntent = stickyRemoteContext && isRemotePermissionGrantText(normalized);
    const remoteSoftwareCreationIntent = hasRemoteSoftwareCreationIntent(normalized);

    if (requestedNotesProfile || pageEditIntent) {
        return NOTES_EXECUTION_PROFILE;
    }

    return (remoteBuildIntent || remoteContinuationIntent || stickyRemoteWorkIntent || stickyRemoteStatusIntent || stickyRemoteApprovalIntent || remoteSoftwareCreationIntent || knownDeployDomainStatusIntent || deployedPublicDomainStatusIntent)
        ? REMOTE_BUILD_EXECUTION_PROFILE
        : DEFAULT_EXECUTION_PROFILE;
}

async function executeConversationRuntime(app, params = {}) {
    const executionProfile = inferExecutionProfile(params);
    const sessionControlState = getSessionControlState(params.session || { metadata: params.metadata || {} });
    const effectiveToolContext = {
        ...(params.toolContext || {}),
        controlState: sessionControlState,
        ...(sessionControlState.remoteCliAgent ? { remoteCliAgent: sessionControlState.remoteCliAgent } : {}),
        ...(params.metadata && typeof params.metadata === 'object'
            ? { metadata: params.metadata }
            : {}),
        model: params?.toolContext?.model || params.model || null,
        documentService: params?.toolContext?.documentService || app?.locals?.documentService || null,
        opencodeService: params?.toolContext?.opencodeService || app?.locals?.opencodeService || null,
        workloadService: params?.toolContext?.workloadService || app?.locals?.agentWorkloadService || null,
        managedAppService: params?.toolContext?.managedAppService || app?.locals?.managedAppService || null,
    };
    const clientSurface = String(
        params.clientSurface
        || effectiveToolContext.clientSurface
        || params.metadata?.clientSurface
        || params.metadata?.client_surface
        || '',
    ).trim();
    const memoryScope = resolveSessionScope({
        mode: params.taskType || '',
        taskType: params.taskType || '',
        clientSurface,
        memoryScope: params.memoryScope
            || params.metadata?.memoryScope
            || params.metadata?.memory_scope
            || '',
        metadata: params.metadata,
    }, params.session || null);
    const sessionIsolation = isSessionIsolationEnabled({
        sessionIsolation: params.toolContext?.sessionIsolation,
        metadata: params.metadata,
    }, params.session || null);
    const projectKey = resolveProjectKey({
        ...(params.metadata || {}),
        ...(params.toolContext || {}),
        memoryScope,
        clientSurface,
    }, params.session || null);
    const scopedToolContext = {
        ...effectiveToolContext,
        ...(clientSurface ? { clientSurface } : {}),
        ...(memoryScope ? { memoryScope } : {}),
        ...(projectKey ? { projectKey } : {}),
        ...(sessionIsolation ? { sessionIsolation: true } : {}),
    };
    const orchestrator = app?.locals?.conversationOrchestrator
        || app?.locals?.agentOrchestrator
        || null;

    const piiSanitized = await sanitizeRuntimePayload(params, {
        sessionId: params.sessionId,
        ownerId: params.ownerId || effectiveToolContext.ownerId || null,
        clientSurface,
        route: effectiveToolContext.route || params.metadata?.route || '',
        metadata: params.metadata || {},
    });
    const effectiveParams = piiSanitized.payload;
    const orchestrationSettings = settingsController.getEffectiveOrchestrationConfig?.()
        || settingsController.settings?.orchestration
        || {};
    const orchestrationOverrides = effectiveParams.metadata?.orchestrationOverrides
        && typeof effectiveParams.metadata.orchestrationOverrides === 'object'
        && !Array.isArray(effectiveParams.metadata.orchestrationOverrides)
        ? effectiveParams.metadata.orchestrationOverrides
        : {};
    const effectiveOrchestrationSettings = {
        ...orchestrationSettings,
        ...orchestrationOverrides,
    };
    const useAgentDirectedRuntime = resolveAgentDirectedRuntimeFlag(effectiveParams, effectiveOrchestrationSettings);
    const callerPiiCleansing = effectiveToolContext.piiCleansing
        || params.metadata?.piiCleansing
        || effectiveParams.metadata?.piiCleansing
        || null;
    const mergedPiiContextIds = compactPiiContextIds(
        callerPiiCleansing,
        piiSanitized.contextIds,
    );
    const mergedRelationshipCalculations = piiSanitized.policy?.relationshipCalculations
        || callerPiiCleansing?.relationshipCalculations
        || null;
    if (effectiveParams.metadata && typeof effectiveParams.metadata === 'object') {
        effectiveParams.metadata = {
            ...effectiveParams.metadata,
            piiCleansing: {
                ...(callerPiiCleansing && typeof callerPiiCleansing === 'object' ? callerPiiCleansing : {}),
                ...(effectiveParams.metadata.piiCleansing || {}),
                contextIds: mergedPiiContextIds,
                relationshipCalculations: mergedRelationshipCalculations,
            },
        };
    }
    const piiResult = {
        enabled: piiSanitized.policy?.enabled === true,
        changed: piiSanitized.changed,
        contextIds: mergedPiiContextIds,
        replacementCount: piiSanitized.replacements.length,
        placeholderMode: piiSanitized.policy?.placeholderMode || '',
        modelFrame: piiSanitized.modelFrame || null,
        relationshipCalculations: mergedRelationshipCalculations,
        relationshipFrame: piiSanitized.relationshipFrame || null,
    };
    const runtimePiiEntries = piiSanitized.replacements
        .filter((entry) => entry?.placeholder && entry?.valueIndexHmac)
        .map((entry) => ({
            placeholder: entry.placeholder,
            valueIndexHmac: entry.valueIndexHmac,
            piiType: entry.type || 'PII',
        }));
    const effectiveScopedToolContext = {
        ...scopedToolContext,
        metadata: effectiveParams.metadata || params.metadata || {},
        ...(typeof params.onProgress === 'function' ? { onProgress: params.onProgress } : {}),
        piiCleansing: piiResult,
        piiEntries: [
            ...(Array.isArray(scopedToolContext?.piiEntries) ? scopedToolContext.piiEntries : []),
            ...runtimePiiEntries,
        ],
    };

    if (!useAgentDirectedRuntime && orchestrator?.executeConversation) {
        return {
            ...(await orchestrator.executeConversation({
                ...effectiveParams,
                clientSurface,
                memoryScope,
                toolContext: effectiveScopedToolContext,
                executionProfile,
            })),
            handledPersistence: true,
            runtimeMode: 'orchestrated',
            pii: piiResult,
        };
    }

    const recentMessages = effectiveParams.recentMessages || (
        effectiveParams.loadRecentMessages === false
            ? []
            : await sessionStore.getRecentMessages(effectiveParams.sessionId, resolveRecentTranscriptLimitForContinuity({
                executionProfile,
                clientSurface,
                taskType: effectiveParams.taskType || params.taskType || '',
                controlState: sessionControlState,
            }))
    );
    const recallInput = effectiveParams.memoryInput || extractRuntimeText(effectiveParams.input || '');
    const continuityObjective = resolveTranscriptObjectiveFromSession(recallInput, recentMessages);
    const recallQuery = continuityObjective.objective || recallInput;
    const continuityFrame = buildContextContinuityFrame({
        currentInput: recallInput,
        recentMessages,
        session: effectiveParams.session || params.session || null,
        requestFrame: effectiveParams.metadata?.requestFrame || params.metadata?.requestFrame || null,
        clientSurface,
        taskType: effectiveParams.taskType || params.taskType || '',
    });
    const contextMessages = effectiveParams.contextMessages || (
        effectiveParams.loadContextMessages === false
            ? []
            : await memoryService.process(effectiveParams.sessionId, recallInput, {
                profile: inferRecallProfile(recallQuery),
                ownerId: effectiveParams.ownerId || null,
                memoryScope,
                sessionIsolation,
                executionProfile,
                projectContinuity: executionProfile === REMOTE_BUILD_EXECUTION_PROFILE
                    || ['canvas', 'document', 'documents', 'notation', 'notes', 'notes-app', 'notes-editor'].includes(String(clientSurface || '').trim().toLowerCase()),
                memoryKeywords: effectiveParams.metadata?.memoryKeywords || effectiveParams.toolContext?.memoryKeywords || [],
                sourceSurface: clientSurface || memoryScope || null,
                projectKey: buildScopedMemoryMetadata({
                    ownerId: effectiveParams.ownerId || null,
                    memoryScope,
                    sourceSurface: clientSurface || memoryScope || null,
                    ...(projectKey ? { projectKey } : {}),
                    ...(sessionIsolation ? { sessionIsolation: true } : {}),
                }, effectiveParams.session || null).projectKey || null,
                recallQuery,
                objective: recallQuery,
                recentMessages,
            })
    );
    let agentDirectedBaseInstructions = effectiveParams.instructions;
    if (continuityFrame && !String(agentDirectedBaseInstructions || '').includes('[Context continuity frame]')) {
        agentDirectedBaseInstructions = [
            agentDirectedBaseInstructions,
            continuityFrame,
        ].filter(Boolean).join('\n\n');
    }
    if (useAgentDirectedRuntime && !hasSessionIdentityInstructions(agentDirectedBaseInstructions)) {
        agentDirectedBaseInstructions = buildSessionInstructions(
            effectiveParams.session || params.session || null,
            agentDirectedBaseInstructions || '',
        );
    }
    if (useAgentDirectedRuntime && !hasAgentJournalInstructions(agentDirectedBaseInstructions)) {
        const journalInstructions = buildAgentJournalInstructions(
            await loadAgentJournalEntries(
                sessionStore,
                effectiveParams.session || params.session || null,
                effectiveParams.ownerId || params.ownerId || effectiveScopedToolContext.ownerId || null,
            ),
        );
        agentDirectedBaseInstructions = [journalInstructions, agentDirectedBaseInstructions]
            .filter(Boolean)
            .join('\n\n');
    }
    const runtimeInstructions = useAgentDirectedRuntime
        ? buildAgentDirectedRuntimeInstructions({
            instructions: agentDirectedBaseInstructions,
            metadata: effectiveParams.metadata || {},
            toolManager: effectiveParams.toolManager || params.toolManager || null,
            executionProfile,
            clientSurface,
            taskType: effectiveParams.taskType || params.taskType || '',
        })
        : agentDirectedBaseInstructions;

    const response = await createResponse({
        ...effectiveParams,
        clientSurface,
        memoryScope,
        toolContext: effectiveScopedToolContext,
        executionProfile,
        instructions: runtimeInstructions,
        enableAutomaticToolCalls: useAgentDirectedRuntime || effectiveParams.enableAutomaticToolCalls,
        previousPromptState: effectiveParams.previousPromptState || effectiveParams.session?.metadata?.promptState || null,
        contextMessages,
        recentMessages,
    });
    const runtimeMode = useAgentDirectedRuntime ? 'agent-directed' : 'direct';
    scheduleDirectAfterProcessAudit({
        sessionId: effectiveParams.sessionId,
        ownerId: effectiveParams.ownerId || effectiveScopedToolContext.ownerId || null,
        response,
        inputText: recallInput,
        taskType: effectiveParams.taskType || params.taskType || '',
        executionProfile,
        runtimeMode,
        clientSurface,
        memoryScope,
        metadata: effectiveParams.metadata || params.metadata || {},
    });

    return {
        response,
        handledPersistence: false,
        runtimeMode,
        pii: piiResult,
    };
}

module.exports = {
    executeConversationRuntime,
    scheduleDirectAfterProcessAudit,
    resolveConversationExecutorFlag,
    resolveAgentDirectedRuntimeFlag,
    inferExecutionProfile,
    normalizeExecutionProfile,
};

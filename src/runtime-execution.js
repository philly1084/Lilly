const { sessionStore } = require('./session-store');
const { memoryService } = require('./memory/memory-service');
const { createResponse } = require('./openai-client');
const { resolveTranscriptObjectiveFromSession } = require('./conversation-continuity');
const { getSessionControlState } = require('./runtime-control-state');
const { config } = require('./config');
const { buildScopedMemoryMetadata, isSessionIsolationEnabled, resolveProjectKey, resolveSessionScope } = require('./session-scope');
const { sanitizeRuntimePayload } = require('./pii');

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

    return (remoteBuildIntent || remoteContinuationIntent || stickyRemoteWorkIntent || stickyRemoteStatusIntent || stickyRemoteApprovalIntent || remoteSoftwareCreationIntent)
        ? REMOTE_BUILD_EXECUTION_PROFILE
        : DEFAULT_EXECUTION_PROFILE;
}

async function executeConversationRuntime(app, params = {}) {
    const executionProfile = inferExecutionProfile(params);
    const effectiveToolContext = {
        ...(params.toolContext || {}),
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
    const piiResult = {
        enabled: piiSanitized.policy?.enabled === true,
        changed: piiSanitized.changed,
        contextIds: piiSanitized.contextIds,
        replacementCount: piiSanitized.replacements.length,
        placeholderMode: piiSanitized.policy?.placeholderMode || '',
        modelFrame: piiSanitized.modelFrame || null,
    };

    if (orchestrator?.executeConversation) {
        return {
            ...(await orchestrator.executeConversation({
                ...effectiveParams,
                clientSurface,
                memoryScope,
                toolContext: scopedToolContext,
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
            : await sessionStore.getRecentMessages(effectiveParams.sessionId, RECENT_TRANSCRIPT_LIMIT)
    );
    const recallInput = effectiveParams.memoryInput || extractRuntimeText(effectiveParams.input || '');
    const continuityObjective = resolveTranscriptObjectiveFromSession(recallInput, recentMessages);
    const recallQuery = continuityObjective.objective || recallInput;
    const contextMessages = effectiveParams.contextMessages || (
        effectiveParams.loadContextMessages === false
            ? []
            : await memoryService.process(effectiveParams.sessionId, recallInput, {
                profile: inferRecallProfile(recallQuery),
                ownerId: effectiveParams.ownerId || null,
                memoryScope,
                sessionIsolation,
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

    return {
        response: await createResponse({
            ...effectiveParams,
            clientSurface,
            memoryScope,
            toolContext: scopedToolContext,
            executionProfile,
            previousPromptState: effectiveParams.previousPromptState || effectiveParams.session?.metadata?.promptState || null,
            contextMessages,
            recentMessages,
        }),
        handledPersistence: false,
        runtimeMode: 'direct',
        pii: piiResult,
    };
}

module.exports = {
    executeConversationRuntime,
    resolveConversationExecutorFlag,
    inferExecutionProfile,
    normalizeExecutionProfile,
};

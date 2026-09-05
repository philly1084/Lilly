'use strict';

const crypto = require('crypto');
const { getCompanyExecutionFailure, getCompanyRemoteExecution } = require('../agent-ops/execution-contract');
const { getNextCronRun } = require('./cron-utils');
const {
    applyProjectPlanPatch,
    extractProjectPlan,
    formatProjectExecutionContext,
    recordProjectReview,
} = require('./project-plans');
const { buildCanonicalWorkloadPayload } = require('./request-builder');
const {
    deriveRunIdempotencyKey,
    validateWorkloadPayload,
} = require('./schema');
const {
    buildLongAgentExecutionContext,
    buildNextStepPrompt,
    buildReviewPrompt,
    evaluateLongAgentStop,
    getLongAgentStep,
    getRemoteExecutionState,
    isRemoteExecutionPending,
    normalizeLongAgentMetadata,
} = require('./long-agent-mode');
const { RUN_STATUS, workloadStore } = require('./store');
const { broadcastToAdmins, broadcastToSession } = require('../realtime-hub');
const {
    advanceSurfaceAgentRun,
    attachAgentRunMetadata,
    beginSurfaceAgentRun,
} = require('../agent-runs/runtime-bridge');

const SUB_AGENT_MAX_TASKS = 3;
const SUB_AGENT_MAX_DEPTH = 1;
const SUB_AGENT_DEFAULT_MAX_RETRIES = 2;
const SUB_AGENT_MAX_RETRIES = 4;
const SUB_AGENT_BASE_RETRY_DELAY_MS = 15000;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeText(value = '') {
    return String(value || '').trim();
}

function normalizeInteger(value, fallback = 0, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }

    return Math.max(min, Math.min(Math.trunc(numeric), max));
}

function normalizeSubAgentDepth(value = 0) {
    return normalizeInteger(value, 0, {
        min: 0,
        max: SUB_AGENT_MAX_DEPTH,
    });
}

function normalizeWriteTargets(value = []) {
    const values = Array.isArray(value) ? value : [value];
    return Array.from(new Set(values
        .map((entry) => sanitizeText(entry).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase())
        .filter(Boolean)));
}

function buildWriteTargetTokens({ writeTargets = [], lockKey = '' } = {}) {
    return new Set([
        ...normalizeWriteTargets(writeTargets),
        ...normalizeWriteTargets(lockKey),
    ]);
}

function isSubAgentWorkload(workload = {}) {
    return workload?.metadata?.subAgent?.enabled === true;
}

function isQueuedLikeRun(run = null) {
    if (!run) {
        return false;
    }

    return !sanitizeText(run.status) || sanitizeText(run.status).toLowerCase() === RUN_STATUS.QUEUED;
}

function classifySubAgentFailure(error = {}) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = sanitizeText(error?.code).toLowerCase();
    const message = sanitizeText(error?.message).toLowerCase();

    const isTerminalModelError = status === 401
        || status === 402
        || status === 403
        || /insufficient_quota|quota|billing|credit balance|payment required|hard limit|invalid api key|incorrect api key|authentication|unauthorized|forbidden/.test(message)
        || ((status === 404 || code === 'model_not_found') && /model/.test(message))
        || /model .* not found|does not exist|not available to your account/.test(message);

    if (isTerminalModelError) {
        return {
            kind: 'terminal_model_error',
            retryable: false,
            terminal: true,
            retryDelayMs: 0,
            supervisorInstruction: 'Stop retrying. The previous attempt failed because the caller model or billing/auth state is unavailable.',
        };
    }

    const isRateLimited = status === 429
        || ['rate_limit', 'rate_limit_exceeded', 'too_many_requests'].includes(code)
        || /rate limit|too many requests/.test(message);
    if (isRateLimited) {
        return {
            kind: 'rate_limit',
            retryable: true,
            terminal: false,
            retryDelayMs: SUB_AGENT_BASE_RETRY_DELAY_MS * 2,
            supervisorInstruction: 'Retry the original objective after a short delay. Continue the work instead of describing the prior rate limit.',
        };
    }

    const isTransientRuntimeError = status >= 500
        || ['econnreset', 'etimedout', 'econnaborted', 'enotfound', 'epipe', 'network_error'].includes(code)
        || /timeout|timed out|network|socket hang up|connection reset|connection aborted|temporary failure|temporarily unavailable|service unavailable|bad gateway|fetch failed|upstream/.test(message);
    if (isTransientRuntimeError) {
        return {
            kind: 'transient_runtime_error',
            retryable: true,
            terminal: false,
            retryDelayMs: SUB_AGENT_BASE_RETRY_DELAY_MS,
            supervisorInstruction: 'Retry the same objective from the current context. The previous failure appears transient, so continue without re-explaining the error.',
        };
    }

    const isRepairableRuntimeError = /tool orchestration failed|response generation failed|invalid json|malformed|parse|empty output|no output|unexpected end of json/.test(message);
    if (isRepairableRuntimeError) {
        return {
            kind: 'repairable_runtime_error',
            retryable: true,
            terminal: false,
            retryDelayMs: SUB_AGENT_BASE_RETRY_DELAY_MS,
            supervisorInstruction: 'Retry the original objective with a tighter plan. Ignore the failed output, use smaller steps, and produce the concrete deliverable.',
        };
    }

    return {
        kind: 'permanent_error',
        retryable: false,
        terminal: false,
        retryDelayMs: 0,
        supervisorInstruction: 'Do not retry automatically.',
    };
}

function buildSubAgentRetryPrompt({
    prompt = '',
    errorMessage = '',
    classification = null,
    attempt = 0,
    maxRetries = 0,
    writeTargets = [],
} = {}) {
    const basePrompt = sanitizeText(prompt);
    const summary = sanitizeText(errorMessage).slice(0, 600);
    const targetSummary = normalizeWriteTargets(writeTargets).join(', ');

    return [
        basePrompt,
        '',
        '[Supervisor retry instructions]',
        `Retry attempt ${attempt} of ${maxRetries}.`,
        classification?.supervisorInstruction || 'Retry the original objective.',
        summary ? `Previous failure: ${summary}` : null,
        targetSummary ? `Assigned write targets: ${targetSummary}` : null,
        'Do not spawn more sub-agents from this task.',
    ].filter(Boolean).join('\n');
}

class AgentWorkloadService {
    constructor({
        store = workloadStore,
        sessionStore,
        conversationRunService,
        agentRunService = null,
    }) {
        this.store = store;
        this.sessionStore = sessionStore;
        this.conversationRunService = conversationRunService;
        this.agentRunService = agentRunService;
    }

    isAvailable() {
        return this.store.isAvailable() && this.sessionStore?.isPersistent?.() === true;
    }

    async captureAgentRunShadow(workload = {}, run = {}, state = 'created', details = {}) {
        return beginSurfaceAgentRun({
            agentRunService: this.agentRunService,
            conversationRunService: this.conversationRunService,
            allowSharedFallback: Boolean(this.agentRunService || this.conversationRunService?.app),
            surface: 'workload',
            mode: workload.mode || 'chat',
            sourceId: run.id,
            sessionId: workload.sessionId,
            ownerId: workload.ownerId,
            objective: run.prompt || workload.prompt || workload.title || 'Deferred workload',
            state,
            metadata: {
                workloadId: workload.id || run.workloadId || null,
                workloadRunId: run.id || null,
                stageIndex: run.stageIndex ?? null,
                ...details,
            },
        });
    }

    resolveRequestedModel(payload = {}, session = null) {
        return String(
            payload?.metadata?.requestedModel
            || payload?.model
            || session?.metadata?.model
            || '',
        ).trim() || null;
    }

    injectRequestedModelIntoExecution(execution = null, requestedModel = null) {
        if (!isPlainObject(execution)) {
            return execution;
        }

        if (sanitizeText(execution.tool || execution.name).toLowerCase() !== 'managed-app' || !sanitizeText(requestedModel)) {
            return execution;
        }

        const params = isPlainObject(execution.params) ? { ...execution.params } : {};
        if (!sanitizeText(params.model)) {
            params.model = requestedModel;
        }

        return {
            ...execution,
            params,
        };
    }

    normalizeSubAgentTask(task = {}, index = 0, options = {}) {
        const requestedModel = sanitizeText(options.requestedModel);
        const defaultMaxRetries = normalizeInteger(options.defaultMaxRetries, SUB_AGENT_DEFAULT_MAX_RETRIES, {
            min: 0,
            max: SUB_AGENT_MAX_RETRIES,
        });
        const title = sanitizeText(task.title || task.name || `Sub-agent ${index + 1}`);
        const prompt = sanitizeText(task.prompt || task.objective || task.request);
        const execution = this.injectRequestedModelIntoExecution(
            isPlainObject(task.execution) ? { ...task.execution } : null,
            requestedModel,
        );

        if (!title) {
            throw new Error(`Sub-agent task ${index + 1} requires a title.`);
        }
        if (!prompt && !execution) {
            throw new Error(`Sub-agent task ${index + 1} requires a prompt or structured execution.`);
        }

        const writeTargets = normalizeWriteTargets([
            ...(Array.isArray(task.writeTargets) ? task.writeTargets : []),
            ...(Array.isArray(task.write_targets) ? task.write_targets : []),
            task.outputPath,
            task.output_path,
            task.targetPath,
            task.target_path,
            task.path,
            execution?.params?.workspacePath
                ? `workspace:${execution.params.workspacePath}`
                : '',
        ]);
        const lockKey = sanitizeText(task.lockKey || task.lock_key) || (writeTargets.length === 1 ? writeTargets[0] : '');

        return {
            title,
            prompt,
            execution,
            mode: sanitizeText(task.mode || 'chat') || 'chat',
            policy: {
                executionProfile: sanitizeText(task.executionProfile || task.execution_profile || 'default') || 'default',
                toolIds: Array.isArray(task.toolIds)
                    ? task.toolIds.map((toolId) => sanitizeText(toolId)).filter(Boolean)
                    : [],
                maxRounds: normalizeInteger(task.maxRounds, 4, { min: 1, max: 12 }),
                maxToolCalls: normalizeInteger(task.maxToolCalls, 12, { min: 1, max: 40 }),
                maxDurationMs: normalizeInteger(task.maxDurationMs, 180000, { min: 1000, max: 30 * 60 * 1000 }),
                allowSideEffects: task.allowSideEffects === true,
            },
            metadata: isPlainObject(task.metadata) ? { ...task.metadata } : {},
            lockKey,
            writeTargets,
            maxRetries: normalizeInteger(task.maxRetries, defaultMaxRetries, {
                min: 0,
                max: SUB_AGENT_MAX_RETRIES,
            }),
        };
    }

    async listSessionSubAgentWorkloads(sessionId, ownerId) {
        const workloads = await this.listSessionWorkloads(sessionId, ownerId);
        return workloads.filter((workload) => isSubAgentWorkload(workload));
    }

    async summarizeSubAgentTask(workload, ownerId) {
        const runs = await this.listRunsForWorkload(workload.id, ownerId, 10);
        const latestRun = runs[0] || null;
        const active = latestRun && ['queued', 'running'].includes(String(latestRun.status || '').trim().toLowerCase());
        const subAgent = workload?.metadata?.subAgent || {};

        return {
            orchestrationId: subAgent.orchestrationId || null,
            workloadId: workload.id,
            title: workload.title,
            childIndex: normalizeInteger(subAgent.childIndex, 0),
            status: latestRun?.status || 'idle',
            latestRunId: latestRun?.id || null,
            attempt: Number(latestRun?.attempt || 0),
            maxRetries: normalizeInteger(subAgent.maxRetries, SUB_AGENT_DEFAULT_MAX_RETRIES, {
                min: 0,
                max: SUB_AGENT_MAX_RETRIES,
            }),
            active,
            lockKey: sanitizeText(subAgent.lockKey || ''),
            writeTargets: normalizeWriteTargets(subAgent.writeTargets || []),
            error: sanitizeText(latestRun?.error?.message || ''),
            requestedModel: sanitizeText(workload?.metadata?.requestedModel || ''),
            createdAt: workload.createdAt,
            updatedAt: workload.updatedAt,
        };
    }

    buildSubAgentCounts(tasks = []) {
        return tasks.reduce((accumulator, task) => {
            const status = sanitizeText(task.status || 'idle').toLowerCase() || 'idle';
            accumulator.total += 1;
            accumulator[status] = Number(accumulator[status] || 0) + 1;
            if (task.active) {
                accumulator.active += 1;
            }
            return accumulator;
        }, {
            total: 0,
            active: 0,
            queued: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            idle: 0,
        });
    }

    async listActiveSubAgentTasks(sessionId, ownerId) {
        const workloads = await this.listSessionSubAgentWorkloads(sessionId, ownerId);
        const tasks = await Promise.all(workloads.map((workload) => this.summarizeSubAgentTask(workload, ownerId)));
        return tasks.filter((task) => task.active);
    }

    assertSubAgentWriteTargetsAvailable(tasks = [], activeTasks = []) {
        const seenTokens = new Map();

        for (const task of activeTasks) {
            for (const token of buildWriteTargetTokens(task)) {
                seenTokens.set(token, task.title || task.workloadId || 'another active sub-agent');
            }
        }

        for (const task of tasks) {
            const tokens = Array.from(buildWriteTargetTokens(task));
            for (const token of tokens) {
                if (seenTokens.has(token)) {
                    throw new Error(`Sub-agent write target conflict on "${token}". ${task.title} overlaps with ${seenTokens.get(token)}.`);
                }
            }

            tokens.forEach((token) => seenTokens.set(token, task.title));
        }
    }

    async spawnSubAgents(payload = {}, ownerId = null, context = {}) {
        if (!this.isAvailable()) {
            const error = new Error('Sub-agents require an active Postgres-backed session store.');
            error.statusCode = 503;
            throw error;
        }

        const sessionId = sanitizeText(context.sessionId);
        if (!sessionId || !ownerId) {
            const error = new Error('Sub-agents require an authenticated session context.');
            error.statusCode = 400;
            throw error;
        }

        const currentDepth = normalizeSubAgentDepth(context.subAgentDepth);
        if (currentDepth >= SUB_AGENT_MAX_DEPTH) {
            const error = new Error('Sub-agents cannot spawn more sub-agents.');
            error.statusCode = 400;
            throw error;
        }

        const tasksInput = Array.isArray(payload.tasks)
            ? payload.tasks
            : (isPlainObject(payload.task) ? [payload.task] : []);
        if (tasksInput.length < 1 || tasksInput.length > SUB_AGENT_MAX_TASKS) {
            const error = new Error(`Sub-agent orchestration requires between 1 and ${SUB_AGENT_MAX_TASKS} tasks.`);
            error.statusCode = 400;
            throw error;
        }

        const session = await this.sessionStore.getOwned(sessionId, ownerId);
        if (!session) {
            const error = new Error('Session not found');
            error.statusCode = 404;
            throw error;
        }

        const activeTasks = await this.listActiveSubAgentTasks(sessionId, ownerId);
        if ((activeTasks.length + tasksInput.length) > SUB_AGENT_MAX_TASKS) {
            const error = new Error(`No more than ${SUB_AGENT_MAX_TASKS} sub-agents can run at the same time.`);
            error.statusCode = 409;
            throw error;
        }

        const requestedModel = sanitizeText(context.model || session?.metadata?.model || '');
        const defaultMaxRetries = normalizeInteger(payload.maxRetries, SUB_AGENT_DEFAULT_MAX_RETRIES, {
            min: 0,
            max: SUB_AGENT_MAX_RETRIES,
        });
        const orchestrationId = sanitizeText(payload.orchestrationId || payload.orchestration_id)
            || `subagent-${crypto.randomUUID()}`;
        const orchestrationTitle = sanitizeText(payload.title || payload.name)
            || `Sub-agent batch ${new Date().toISOString()}`;
        const normalizedTasks = tasksInput.map((task, index) => this.normalizeSubAgentTask(task, index, {
            requestedModel,
            defaultMaxRetries,
        }));

        this.assertSubAgentWriteTargetsAvailable(normalizedTasks, activeTasks);

        const createdTasks = [];
        for (let index = 0; index < normalizedTasks.length; index += 1) {
            const task = normalizedTasks[index];
            const subAgentMetadata = {
                enabled: true,
                orchestrationId,
                orchestrationTitle,
                childIndex: index,
                taskCount: normalizedTasks.length,
                parentSessionId: sessionId,
                parentRunId: sanitizeText(context.parentRunId || ''),
                depth: currentDepth + 1,
                maxRetries: task.maxRetries,
                lockKey: task.lockKey || null,
                writeTargets: task.writeTargets,
                callerModel: requestedModel || null,
            };
            const workload = await this.createWorkload({
                sessionId,
                title: task.title,
                mode: task.mode,
                prompt: task.prompt || task.title,
                execution: task.execution,
                trigger: {
                    type: 'manual',
                },
                policy: task.policy,
                metadata: {
                    ...(task.metadata || {}),
                    ...(requestedModel ? { requestedModel } : {}),
                    subAgent: subAgentMetadata,
                },
            }, ownerId);
            const run = await this.runWorkloadNow(workload.id, ownerId, {
                reason: 'sub-agent',
                metadata: {
                    orchestrationId,
                    childIndex: index,
                    subAgentDepth: currentDepth + 1,
                    parentRunId: sanitizeText(context.parentRunId || '') || null,
                },
            });

            createdTasks.push({
                orchestrationId,
                workloadId: workload.id,
                runId: run?.id || null,
                title: workload.title,
                status: run?.status || 'queued',
                writeTargets: task.writeTargets,
                lockKey: task.lockKey || null,
            });
        }

        return {
            orchestrationId,
            title: orchestrationTitle,
            requestedModel: requestedModel || null,
            taskCount: createdTasks.length,
            tasks: createdTasks,
        };
    }

    async getSubAgentOrchestration(orchestrationId, ownerId = null, sessionId = '') {
        const normalizedId = sanitizeText(orchestrationId);
        const normalizedSessionId = sanitizeText(sessionId);
        if (!normalizedId || !normalizedSessionId) {
            return null;
        }

        const workloads = await this.listSessionSubAgentWorkloads(normalizedSessionId, ownerId);
        const matching = workloads.filter((workload) => workload?.metadata?.subAgent?.orchestrationId === normalizedId);
        if (matching.length === 0) {
            return null;
        }

        const tasks = await Promise.all(matching.map((workload) => this.summarizeSubAgentTask(workload, ownerId)));
        const counts = this.buildSubAgentCounts(tasks);

        return {
            orchestrationId: normalizedId,
            title: matching[0]?.metadata?.subAgent?.orchestrationTitle || matching[0]?.title || null,
            requestedModel: sanitizeText(matching[0]?.metadata?.requestedModel || '') || null,
            counts,
            tasks: tasks.sort((left, right) => {
                const leftIndex = normalizeInteger(left?.childIndex, 0);
                const rightIndex = normalizeInteger(right?.childIndex, 0);
                return leftIndex - rightIndex;
            }),
        };
    }

    async listSubAgentOrchestrations(sessionId, ownerId = null) {
        const workloads = await this.listSessionSubAgentWorkloads(sessionId, ownerId);
        const orchestrationIds = Array.from(new Set(workloads
            .map((workload) => sanitizeText(workload?.metadata?.subAgent?.orchestrationId || ''))
            .filter(Boolean)));
        const summaries = [];

        for (const orchestrationId of orchestrationIds) {
            const summary = await this.getSubAgentOrchestration(orchestrationId, ownerId, sessionId);
            if (summary) {
                summaries.push(summary);
            }
        }

        return summaries.sort((left, right) => String(right?.title || '').localeCompare(String(left?.title || '')));
    }

    async controlSubAgentOrchestration(action = '', orchestrationId = '', ownerId = null, sessionId = '', workloadId = '') {
        const normalizedAction = sanitizeText(action).toLowerCase();
        const normalizedId = sanitizeText(orchestrationId);
        const normalizedSessionId = sanitizeText(sessionId);
        const normalizedWorkloadId = sanitizeText(workloadId);
        if (!['stop', 'restart'].includes(normalizedAction)) {
            const error = new Error('Sub-agent control action must be stop or restart.');
            error.statusCode = 400;
            throw error;
        }
        if (!normalizedId || !normalizedSessionId) {
            const error = new Error('Sub-agent control requires an orchestrationId and session context.');
            error.statusCode = 400;
            throw error;
        }

        const workloads = await this.listSessionSubAgentWorkloads(normalizedSessionId, ownerId);
        const matching = workloads.filter((workload) => (
            workload?.metadata?.subAgent?.orchestrationId === normalizedId
            && (!normalizedWorkloadId || workload.id === normalizedWorkloadId)
        ));
        if (matching.length === 0) {
            const error = new Error('Sub-agent orchestration task not found.');
            error.statusCode = 404;
            throw error;
        }

        const results = [];
        for (const workload of matching) {
            if (normalizedAction === 'stop') {
                await this.pauseWorkload(workload.id, ownerId);
                results.push({
                    workloadId: workload.id,
                    action: normalizedAction,
                    enabled: false,
                    stopMode: 'after-current-run',
                    runId: null,
                });
                continue;
            }

            const resumed = await this.resumeWorkload(workload.id, ownerId);
            const runs = await this.listRunsForWorkload(workload.id, ownerId, 10);
            const activeRun = runs.find((run) => ['queued', 'running'].includes(sanitizeText(run?.status).toLowerCase()));
            const latestRun = runs[0] || null;
            const subAgent = workload?.metadata?.subAgent || {};
            const run = activeRun || await this.runWorkloadNow(workload.id, ownerId, {
                reason: 'sub-agent-restart',
                metadata: {
                    orchestrationId: normalizedId,
                    childIndex: normalizeInteger(subAgent.childIndex, 0),
                    subAgentDepth: normalizeSubAgentDepth(subAgent.depth),
                    parentRunId: sanitizeText(subAgent.parentRunId || '') || null,
                },
                idempotencyKey: `sub-agent-restart:${workload.id}:${latestRun?.id || 'initial'}`,
            });
            results.push({
                workloadId: workload.id,
                action: normalizedAction,
                enabled: resumed?.enabled !== false,
                reusedActiveRun: Boolean(activeRun),
                runId: run?.id || null,
                status: run?.status || 'queued',
            });
        }

        return {
            orchestrationId: normalizedId,
            action: normalizedAction,
            taskCount: results.length,
            tasks: results,
        };
    }

    async createWorkload(payload = {}, ownerId = null) {
        const normalized = validateWorkloadPayload(payload, {
            ownerId,
            sessionId: payload.sessionId,
        });
        const session = await this.sessionStore.getOwned(normalized.sessionId, ownerId);
        if (!session) {
            const error = new Error('Session not found');
            error.statusCode = 404;
            throw error;
        }
        const requestedModel = this.resolveRequestedModel(payload, session);
        if (requestedModel && normalized.metadata?.requestedModel !== requestedModel) {
            normalized.metadata = {
                ...(normalized.metadata || {}),
                requestedModel,
            };
        }
        const workload = await this.store.createWorkload(normalized);
        try {
            const queuedRun = await this.ensureNextScheduledRun(workload);
            if (workload.trigger?.type !== 'manual' && !queuedRun) {
                throw new Error('Failed to enqueue workload run.');
            }
        } catch (error) {
            try {
                await this.store.deleteWorkload(workload.id, workload.ownerId);
            } catch (cleanupError) {
                console.warn(`[Workloads] Failed to clean up workload ${workload.id} after scheduling failure:`, cleanupError.message);
            }
            throw error;
        }
        await this.emitWorkloadUpdate('workload_updated', workload.sessionId, {
            workload,
        });
        return workload;
    }

    async createWorkloadFromScenario(sessionId, ownerId, request = '', options = {}) {
        const session = options.session || await this.sessionStore.getOwned(sessionId, ownerId);
        const canonical = buildCanonicalWorkloadPayload({
            request,
            title: options.title,
            prompt: options.prompt,
            ...(Object.prototype.hasOwnProperty.call(options, 'callableSlug')
                ? { callableSlug: options.callableSlug }
                : {}),
            ...(options.trigger ? { trigger: options.trigger } : {}),
            ...(options.execution ? { execution: options.execution } : {}),
            ...(options.policy ? { policy: options.policy } : {}),
            ...(options.metadata && typeof options.metadata === 'object' ? { metadata: options.metadata } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
            ...(Array.isArray(options.stages) ? { stages: options.stages } : {}),
        }, {
            timezone: options.timezone,
            now: options.now,
            session,
            recentMessages: options.recentMessages || [],
        });
        if (!canonical) {
            throw new Error('Describe the task and when it should run.');
        }
        const scenario = canonical.scenario || {
            title: canonical.payload.title,
            prompt: canonical.payload.prompt,
            trigger: canonical.payload.trigger,
            policy: canonical.payload.policy,
            scheduleDetected: canonical.payload.trigger?.type !== 'manual',
        };
        const payload = {
            sessionId,
            mode: options.mode || 'chat',
            enabled: options.enabled !== false,
            ...(options.model ? { model: options.model } : {}),
            ...canonical.payload,
        };
        const workload = await this.createWorkload(payload, ownerId);

        return {
            workload,
            scenario,
        };
    }

    async listSessionWorkloads(sessionId, ownerId) {
        const session = await this.sessionStore.getOwned(sessionId, ownerId);
        if (!session) {
            return [];
        }
        return this.store.listSessionWorkloads(sessionId, ownerId);
    }

    async getWorkload(id, ownerId) {
        return this.store.getWorkloadById(id, ownerId);
    }

    async updateWorkload(id, ownerId, payload = {}) {
        const current = await this.store.getWorkloadById(id, ownerId);
        if (!current) {
            return null;
        }

        const normalized = validateWorkloadPayload({
            ...current,
            ...payload,
            metadata: {
                ...(current.metadata || {}),
                ...((payload && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)) ? payload.metadata : {}),
            },
            sessionId: current.sessionId,
        }, {
            ownerId,
            sessionId: current.sessionId,
        });
        const requestedModel = this.resolveRequestedModel(payload, current);
        if (requestedModel && normalized.metadata?.requestedModel !== requestedModel) {
            normalized.metadata = {
                ...(normalized.metadata || {}),
                requestedModel,
            };
        }

        const updated = await this.store.updateWorkload(id, ownerId, normalized);
        const schedulingChanged = (
            current.prompt !== updated.prompt
            || JSON.stringify(current.trigger || {}) !== JSON.stringify(updated.trigger || {})
        );
        if (!updated.enabled) {
            await this.store.cancelQueuedRunsForWorkload(updated.id);
        } else {
            if (schedulingChanged) {
                await this.store.cancelPendingQueuedRunsForWorkload(updated.id);
            }
            await this.ensureNextScheduledRun(updated);
        }

        await this.emitWorkloadUpdate('workload_updated', updated.sessionId, {
            workload: updated,
        });
        return updated;
    }

    async getProjectPlan(idOrSlug, ownerId) {
        const workload = await this.resolveWorkload(idOrSlug, ownerId);
        if (!workload) {
            return null;
        }

        return extractProjectPlan(workload, {
            title: workload.title,
            prompt: workload.prompt,
        });
    }

    async updateProjectPlan(idOrSlug, ownerId, projectPatch = {}, options = {}) {
        const workload = await this.resolveWorkload(idOrSlug, ownerId);
        if (!workload) {
            return null;
        }

        const currentProject = extractProjectPlan(workload, {
            title: workload.title,
            prompt: workload.prompt,
        });
        const nextProject = applyProjectPlanPatch(
            currentProject || {},
            projectPatch || {},
            {
                defaults: {
                    title: workload.title,
                    prompt: workload.prompt,
                },
                changeReason: options.changeReason || null,
            },
        );
        const metadata = {
            ...(workload.metadata || {}),
            projectMode: true,
            project: nextProject,
        };
        const updated = await this.store.updateWorkload(workload.id, ownerId, { metadata });
        const resolved = updated || {
            ...workload,
            metadata,
        };

        await this.emitWorkloadUpdate('workload_updated', resolved.sessionId, {
            workload: resolved,
        });

        return {
            workload: resolved,
            project: nextProject,
        };
    }

    async pauseWorkload(id, ownerId) {
        const workload = await this.store.updateWorkload(id, ownerId, { enabled: false });
        if (!workload) {
            return null;
        }
        await this.store.cancelQueuedRunsForWorkload(workload.id);
        await this.emitWorkloadUpdate('workload_updated', workload.sessionId, {
            workload,
        });
        return workload;
    }

    async resumeWorkload(id, ownerId) {
        const workload = await this.store.updateWorkload(id, ownerId, { enabled: true });
        if (!workload) {
            return null;
        }
        await this.ensureNextScheduledRun(workload);
        await this.emitWorkloadUpdate('workload_updated', workload.sessionId, {
            workload,
        });
        return workload;
    }

    async deleteWorkload(id, ownerId) {
        const workload = await this.store.getWorkloadById(id, ownerId);
        if (!workload) {
            return false;
        }

        await this.store.cancelQueuedRunsForWorkload(id);
        const deleted = await this.store.deleteWorkload(id, ownerId);
        if (deleted) {
            await this.emitWorkloadUpdate('workload_updated', workload.sessionId, {
                workloadId: id,
                deleted: true,
            });
        }
        return deleted;
    }

    async runWorkloadNow(idOrSlug, ownerId, options = {}) {
        const workload = await this.resolveWorkload(idOrSlug, ownerId);
        if (!workload) {
            return null;
        }

        const run = await this.store.enqueueRun({
            workloadId: workload.id,
            ownerId: workload.ownerId,
            sessionId: workload.sessionId,
            reason: options.reason || 'manual',
            scheduledFor: new Date(),
            stageIndex: Number.isFinite(Number(options.stageIndex)) ? Number(options.stageIndex) : -1,
            parentRunId: options.parentRunId || null,
            prompt: options.prompt || workload.prompt,
            metadata: options.metadata || {},
            idempotencyKey: options.idempotencyKey || null,
        });

        if (isQueuedLikeRun(run)) {
            await this.onRunQueued(workload, run, options.reason || 'manual');
        }

        return run;
    }

    async listRunsForWorkload(workloadId, ownerId, limit = 50) {
        return this.store.listRunsForWorkload(workloadId, ownerId, limit);
    }

    async getRun(runId, ownerId = null) {
        return this.store.getRunById(runId, ownerId);
    }

    async listAdminWorkloads(limit = 100) {
        return this.store.listAdminWorkloads(limit);
    }

    async getAdminWorkload(id) {
        return this.store.getAdminWorkloadById(id);
    }

    async updateAdminWorkload(id, payload = {}) {
        const workload = await this.getAdminWorkload(id);
        if (!workload) {
            return null;
        }

        return this.updateWorkload(id, workload.ownerId, payload);
    }

    async pauseAdminWorkload(id) {
        const workload = await this.getAdminWorkload(id);
        if (!workload) {
            return null;
        }
        return this.pauseWorkload(id, workload.ownerId);
    }

    async resumeAdminWorkload(id) {
        const workload = await this.getAdminWorkload(id);
        if (!workload) {
            return null;
        }
        return this.resumeWorkload(id, workload.ownerId);
    }

    async deleteAdminWorkload(id) {
        const workload = await this.getAdminWorkload(id);
        if (!workload) {
            return false;
        }
        return this.deleteWorkload(id, workload.ownerId);
    }

    async listAdminRuns(limit = 100) {
        return this.store.listAdminRuns(limit);
    }

    async claimDueRuns(options = {}) {
        return this.store.claimDueRuns(options);
    }

    async extendRunLease(runId, workerId, leaseMs) {
        return this.store.extendRunLease(runId, workerId, leaseMs);
    }

    async executeClaimedRun(run, workerId) {
        if (!run?.workload) {
            throw new Error('Claimed run is missing workload context');
        }

        let workload = run.workload;
        const stage = Number(run.stageIndex) >= 0 && Array.isArray(workload.stages)
            ? workload.stages[run.stageIndex] || null
            : null;
        const recursiveStagePrompt = String(run.reason || '').startsWith('long-agent-') && String(run.prompt || '').trim();
        const prompt = recursiveStagePrompt || (stage
            ? (stage?.prompt || run.prompt || '')
            : (run.prompt || workload.prompt));
        const execution = stage?.execution || workload.execution || null;
        const stageInputs = await this.resolveStageInputs(run, stage);
        const message = this.buildStageMessage(prompt, stageInputs, stage, workload, run);
        const defaultOutputFormat = !stage
            ? String(workload?.metadata?.defaultOutputFormat || '').trim().toLowerCase()
            : '';
        const stageOutputFormat = String(stage?.outputFormat || defaultOutputFormat || '').trim().toLowerCase() || null;
        const stageToolIds = Array.isArray(stage?.toolIds) && stage.toolIds.length > 0
            ? stage.toolIds
            : (workload.policy?.toolIds || []);
        const artifactOnlyStage = Boolean(stage && stageOutputFormat && !execution && !String(prompt || '').trim());
        const subAgentDepth = normalizeSubAgentDepth(
            run?.metadata?.subAgentDepth
            || workload?.metadata?.subAgent?.depth
            || 0,
        );
        const requestedModel = String(
            stage?.metadata?.requestedModel
            || run?.metadata?.requestedModel
            || workload?.metadata?.requestedModel
            || '',
        ).trim() || null;
        const reasoningEffort = String(
            stage?.metadata?.reasoningEffort
            || run?.metadata?.reasoningEffort
            || workload?.metadata?.reasoningEffort
            || '',
        ).trim().toLowerCase() || null;
        const agentRunShadow = await this.captureAgentRunShadow(workload, run, 'executing', {
            workerId,
        });
        const startedMessage = `Deferred workload "${workload.title}" started${stage ? ` (stage ${run.stageIndex + 1})` : ''}.`;
        await this.appendSyntheticMessageSafe(workload.sessionId, 'system', startedMessage);
        await this.addRunEventSafe(run.id, 'started', { workerId, stageIndex: run.stageIndex });
        await this.emitWorkloadUpdate('workload_started', workload.sessionId, attachAgentRunMetadata({
            workloadId: workload.id,
            runId: run.id,
            stageIndex: run.stageIndex,
            scheduledFor: run.scheduledFor,
        }, agentRunShadow, { eventType: 'workload.started' }));

        try {
            const session = await this.sessionStore.getOwned(workload.sessionId, workload.ownerId);
            const result = artifactOnlyStage
                ? await this.conversationRunService.createArtifactFromContent({
                    sessionId: workload.sessionId,
                    ownerId: workload.ownerId,
                    session,
                    content: this.renderStageInputText(stageInputs, stage),
                    outputFormat: stageOutputFormat,
                    message: message || `Create a ${stageOutputFormat} artifact from the prior stage output.`,
                    mode: workload.mode || 'chat',
                    model: requestedModel,
                    reasoningEffort,
                    metadata: {
                        taskType: workload.mode || 'chat',
                        clientSurface: 'workload',
                        workloadId: workload.id,
                        runId: run.id,
                        agentRunId: agentRunShadow?.run?.id || null,
                        workloadRun: true,
                        subAgentDepth,
                        subAgentOrchestrationId: workload?.metadata?.subAgent?.orchestrationId || null,
                    },
                })
                : execution
                ? await this.conversationRunService.runStructuredExecution({
                    sessionId: workload.sessionId,
                    ownerId: workload.ownerId,
                    session,
                    execution,
                    metadata: {
                        executionProfile: workload.policy?.executionProfile,
                        prompt,
                        workloadId: workload.id,
                        runId: run.id,
                        agentRunId: agentRunShadow?.run?.id || null,
                        requestedModel,
                        subAgentDepth,
                        subAgentOrchestrationId: workload?.metadata?.subAgent?.orchestrationId || null,
                    },
                })
                : await this.conversationRunService.runChatTurn({
                    sessionId: workload.sessionId,
                    ownerId: workload.ownerId,
                    session,
                    message: workload.metadata?.agentCompany?.enabled === true
                        ? [
                            String(workload.prompt || '').split('\nOperating rules:')[0],
                            prompt !== workload.prompt ? `Current stage:\n${prompt}` : '',
                        ].filter(Boolean).join('\n\n')
                        : message,
                    model: requestedModel,
                    reasoningEffort,
                    executionProfile: workload.policy?.executionProfile,
                    requestedToolIds: stageToolIds,
                    policy: workload.policy || {},
                    metadata: {
                        taskType: workload.mode || 'chat',
                        clientSurface: 'workload',
                        workloadId: workload.id,
                        runId: run.id,
                        agentRunId: agentRunShadow?.run?.id || null,
                        workloadRun: true,
                        agentCompanyRun: workload.metadata?.agentCompany?.enabled === true,
                        companyGoalHash: workload.metadata?.agentCompany?.companyGoalHash || null,
                        companyRoleId: workload.metadata?.agentCompany?.roleId || null,
                        companyRemoteExecution: workload.metadata?.companyRemoteExecution || null,
                        companyRunContext: workload.metadata?.agentCompany?.enabled === true ? message : null,
                        subAgentDepth,
                        subAgentOrchestrationId: workload?.metadata?.subAgent?.orchestrationId || null,
                        outputFormat: stageOutputFormat,
                        remoteBuildAutonomyApproved: workload.policy?.allowSideEffects === true,
                    },
                });
            if (workload.metadata?.agentCompany?.enabled === true) {
                const companyRemoteExecution = getCompanyRemoteExecution(result, workload);
                if (companyRemoteExecution) {
                    const updatedMetadata = { ...(workload.metadata || {}), companyRemoteExecution };
                    // Persist before scheduling continuation, never in the shared session cursor.
                    await this.store.updateWorkload(workload.id, workload.ownerId, { metadata: updatedMetadata });
                    workload = { ...workload, metadata: updatedMetadata };
                }
            }
            const companyFailure = workload.metadata?.agentCompany?.enabled === true
                ? getCompanyExecutionFailure(result) : '';
            if (companyFailure) {
                const error = new Error(companyFailure);
                error.code = 'AGENT_COMPANY_EXECUTION_BLOCKED';
                error.executionResult = result;
                throw error;
            }
            const remoteExecution = getRemoteExecutionState(result, workload);
            const remoteExecutionPending = isRemoteExecutionPending(remoteExecution);
            const completionTrace = result.execution?.trace
                || result.response?.metadata?.executionTrace
                || (execution ? {
                    structuredExecution: true,
                    toolId: execution.tool,
                    params: execution.params || {},
                } : null)
                || (artifactOnlyStage ? {
                    artifactOnly: true,
                    outputFormat: stageOutputFormat,
                } : {});

            const completed = await this.store.completeRun(run.id, workerId, {
                responseId: result.response?.id || null,
                trace: completionTrace,
                metadata: this.buildCompletedRunMetadata(run, stage, result),
            });
            const trackedWorkload = await this.persistProjectReview(workload, run, {
                succeeded: true,
                stage,
                outputText: result.outputText || result.artifactMessage || '',
                artifacts: result.artifacts || [],
                remoteExecutionPending,
            });
            await this.addRunEventSafe(run.id, 'completed', {
                responseId: result.response?.id || null,
                structuredExecution: Boolean(execution),
                artifactOnly: artifactOnlyStage,
                ...(remoteExecution ? { remoteExecution, ...(remoteExecutionPending ? { goalComplete: false } : {}) } : {}),
            });
            // Dependent stages must not consume a CLI handoff while its job is still running.
            const explicitFollowupRun = remoteExecutionPending ? null : await this.scheduleFollowupStage(trackedWorkload, run, true);
            if (!explicitFollowupRun) {
                await this.handleLongAgentStop(trackedWorkload, run, {
                    succeeded: true,
                    stage,
                    result,
                });
            }
            await this.ensureNextScheduledRun(trackedWorkload, run);

            await this.appendSyntheticMessageSafe(
                trackedWorkload.sessionId,
                'system',
                remoteExecutionPending
                    ? `Deferred workload "${trackedWorkload.title}" stage returned; remote execution is still pending. The goal is not complete.`
                    : `Deferred workload "${trackedWorkload.title}" completed${stage ? ` (stage ${run.stageIndex + 1})` : ''}.`,
            );
            await advanceSurfaceAgentRun(agentRunShadow, 'completed', {
                reason: remoteExecutionPending ? 'Scheduler stage completed; remote execution is still pending.' : 'Deferred workload completed.',
                details: {
                    workloadId: trackedWorkload.id,
                    workloadRunId: run.id,
                    responseId: result.response?.id || null,
                    artifactCount: Array.isArray(result.artifacts) ? result.artifacts.length : 0,
                    ...(remoteExecution ? { remoteExecution, ...(remoteExecutionPending ? { goalComplete: false } : {}) } : {}),
                },
                usage: result.response?.usage || result.response?.metadata?.usage || null,
                outputs: (result.artifacts || []).map((artifact) => ({
                    type: 'artifact',
                    id: artifact?.id || artifact?.artifactId || null,
                    filename: artifact?.filename || null,
                })),
            });
            await this.emitWorkloadUpdate('workload_completed', trackedWorkload.sessionId, attachAgentRunMetadata({
                workloadId: trackedWorkload.id,
                runId: run.id,
                output: result.outputText || '',
                responseId: result.response?.id || null,
                artifacts: result.artifacts || [],
                ...(remoteExecution ? { remoteExecution, ...(remoteExecutionPending ? { goalComplete: false } : {}) } : {}),
            }, agentRunShadow, { eventType: 'workload.completed' }));
            return attachAgentRunMetadata(completed, agentRunShadow, { eventType: 'workload.completed' });
        } catch (error) {
            const subAgentFailure = isSubAgentWorkload(workload)
                ? classifySubAgentFailure(error)
                : null;
            const failed = await this.store.failRun(run.id, workerId, {
                error: {
                    message: error.message,
                    ...(error?.status || error?.statusCode ? { status: Number(error.status || error.statusCode) } : {}),
                    ...(sanitizeText(error?.code) ? { code: sanitizeText(error.code) } : {}),
                    ...(subAgentFailure ? { classification: subAgentFailure.kind } : {}),
                },
                metadata: {
                    ...(run.metadata || {}),
                    ...(error.executionResult ? this.buildCompletedRunMetadata(run, stage, error.executionResult) : {}),
                    lastError: {
                        message: error.message,
                        failedAt: new Date().toISOString(),
                        ...(subAgentFailure ? { classification: subAgentFailure.kind } : {}),
                    },
                },
            });
            await this.addRunEventSafe(run.id, 'failed', {
                error: error.message,
            });
            const trackedWorkload = await this.persistProjectReview(workload, run, {
                succeeded: false,
                stage,
                outputText: error.message,
                artifacts: [],
            });
            const retryRun = await this.maybeRetrySubAgentRun(trackedWorkload, run, error, subAgentFailure);
            const explicitFollowupRun = await this.scheduleFollowupStage(trackedWorkload, run, false);
            if (!retryRun && !explicitFollowupRun) {
                await this.handleLongAgentStop(trackedWorkload, run, {
                    succeeded: false,
                    stage,
                    error,
                    result: {
                        ...(error.executionResult || {}),
                        outputText: error.message,
                    },
                });
            }
            await this.ensureNextScheduledRun(trackedWorkload, run);
            await this.appendSyntheticMessageSafe(
                trackedWorkload.sessionId,
                'system',
                `Deferred workload "${trackedWorkload.title}" failed${stage ? ` (stage ${run.stageIndex + 1})` : ''}: ${error.message}`,
            );
            await advanceSurfaceAgentRun(agentRunShadow, 'failed', {
                reason: error.message,
                details: {
                    workloadId: trackedWorkload.id,
                    workloadRunId: run.id,
                    errorCode: error.code || null,
                    retryRunId: retryRun?.id || null,
                },
            });
            await this.emitWorkloadUpdate('workload_failed', trackedWorkload.sessionId, attachAgentRunMetadata({
                workloadId: trackedWorkload.id,
                runId: run.id,
                error: error.message,
                retryRunId: retryRun?.id || null,
            }, agentRunShadow, { eventType: 'workload.failed' }));
            return attachAgentRunMetadata(failed, agentRunShadow, { eventType: 'workload.failed' });
        }
    }

    async maybeRetrySubAgentRun(workload, run, error, classification = null) {
        if (!isSubAgentWorkload(workload)) {
            return null;
        }

        const resolvedClassification = classification || classifySubAgentFailure(error);
        const maxRetries = normalizeInteger(
            workload?.metadata?.subAgent?.maxRetries,
            SUB_AGENT_DEFAULT_MAX_RETRIES,
            {
                min: 0,
                max: SUB_AGENT_MAX_RETRIES,
            },
        );
        const nextAttempt = normalizeInteger(run?.attempt, 0, {
            min: 0,
            max: SUB_AGENT_MAX_RETRIES,
        }) + 1;

        if (!resolvedClassification.retryable || nextAttempt > maxRetries) {
            return null;
        }

        const retryPrompt = workload.execution
            ? (sanitizeText(run?.prompt) || sanitizeText(workload.prompt))
            : buildSubAgentRetryPrompt({
                prompt: sanitizeText(workload.prompt),
                errorMessage: error?.message || '',
                classification: resolvedClassification,
                attempt: nextAttempt,
                maxRetries,
                writeTargets: workload?.metadata?.subAgent?.writeTargets || [],
            });
        const scheduledFor = new Date(Date.now() + Math.max(
            SUB_AGENT_BASE_RETRY_DELAY_MS,
            Number(resolvedClassification.retryDelayMs || 0),
        ));
        const retryRun = await this.store.enqueueRun({
            workloadId: workload.id,
            ownerId: workload.ownerId,
            sessionId: workload.sessionId,
            reason: 'retry',
            scheduledFor,
            parentRunId: run.id,
            stageIndex: run.stageIndex,
            attempt: nextAttempt,
            prompt: retryPrompt,
            idempotencyKey: deriveRunIdempotencyKey({
                workloadId: workload.id,
                scheduledFor: scheduledFor.toISOString(),
                stageIndex: run.stageIndex,
                reason: `retry-${run.id}-${nextAttempt}`,
            }),
            metadata: {
                ...(run.metadata || {}),
                parentRunId: run.id,
                retryOfRunId: run.id,
                subAgentDepth: normalizeSubAgentDepth(
                    run?.metadata?.subAgentDepth
                    || workload?.metadata?.subAgent?.depth
                    || 0,
                ),
                retryPlan: {
                    classification: resolvedClassification.kind,
                    attempt: nextAttempt,
                    maxRetries,
                    scheduledFor: scheduledFor.toISOString(),
                    error: sanitizeText(error?.message || ''),
                },
            },
        });

        if (!retryRun) {
            return null;
        }

        await this.addRunEventSafe(run.id, 'retry-enqueued', {
            retryRunId: retryRun.id,
            classification: resolvedClassification.kind,
            attempt: nextAttempt,
            scheduledFor: retryRun.scheduledFor,
        });
        await this.appendSyntheticMessageSafe(
            workload.sessionId,
            'system',
            `Deferred workload "${workload.title}" scheduled retry ${nextAttempt} after ${resolvedClassification.kind}.`,
        );
        await this.emitWorkloadUpdate('workload_queued', workload.sessionId, {
            workloadId: workload.id,
            runId: retryRun.id,
            scheduledFor: retryRun.scheduledFor,
            reason: 'retry',
        });

        return retryRun;
    }

    async ensureNextScheduledRun(workload, completedRun = null) {
        if (workload?.enabled === false) {
            return null;
        }

        if (workload.trigger?.type === 'manual') {
            return null;
        }

        if (workload.trigger?.type === 'once') {
            const stageIndex = -1;
            const run = await this.store.enqueueRun({
                workloadId: workload.id,
                ownerId: workload.ownerId,
                sessionId: workload.sessionId,
                reason: 'schedule',
                scheduledFor: workload.trigger.runAt,
                stageIndex,
                prompt: workload.prompt,
                idempotencyKey: deriveRunIdempotencyKey({
                    workloadId: workload.id,
                    scheduledFor: workload.trigger.runAt,
                    stageIndex,
                    reason: 'schedule',
                }),
            });
            if (isQueuedLikeRun(run)) {
                await this.onRunQueued(workload, run, 'scheduled');
            }
            return run;
        }

        if (workload.trigger?.type === 'cron') {
            const basis = completedRun?.scheduledFor || new Date();
            const scheduledFor = getNextCronRun(
                workload.trigger.expression,
                workload.trigger.timezone,
                new Date(basis),
            );
            const run = await this.store.enqueueRun({
                workloadId: workload.id,
                ownerId: workload.ownerId,
                sessionId: workload.sessionId,
                reason: 'cron',
                scheduledFor,
                stageIndex: -1,
                prompt: workload.prompt,
                idempotencyKey: deriveRunIdempotencyKey({
                    workloadId: workload.id,
                    scheduledFor: scheduledFor.toISOString(),
                    stageIndex: -1,
                    reason: 'cron',
                }),
            });
            if (isQueuedLikeRun(run)) {
                await this.onRunQueued(workload, run, 'cron');
            }
            return run;
        }

        return null;
    }

    async scheduleFollowupStage(workload, run, succeeded) {
        const stages = Array.isArray(workload.stages) ? workload.stages : [];
        const nextIndex = Number.isFinite(Number(run.stageIndex)) ? Number(run.stageIndex) + 1 : 0;
        const stage = stages[nextIndex];
        if (!stage) {
            return null;
        }

        const shouldRun = stage.when === 'always'
            || (stage.when === 'on_success' && succeeded)
            || (stage.when === 'on_failure' && !succeeded);
        if (!shouldRun) {
            return null;
        }

        const delayMs = Number(stage.delayMs || 0);
        const priorScheduledAt = new Date(run?.scheduledFor || Date.now());
        const baseTime = Number.isNaN(priorScheduledAt.getTime())
            ? Date.now()
            : priorScheduledAt.getTime();
        const scheduledFor = new Date(Math.max(Date.now(), baseTime + Math.max(0, delayMs)));
        const followupRun = await this.store.enqueueRun({
            workloadId: workload.id,
            ownerId: workload.ownerId,
            sessionId: workload.sessionId,
            reason: 'followup',
            scheduledFor,
            parentRunId: run.id,
            stageIndex: nextIndex,
            prompt: stage.prompt || '',
            idempotencyKey: deriveRunIdempotencyKey({
                workloadId: workload.id,
                scheduledFor: scheduledFor.toISOString(),
                stageIndex: nextIndex,
                reason: `followup-${run.id}`,
            }),
            metadata: {
                parentRunId: run.id,
            },
        });

        if (isQueuedLikeRun(followupRun)) {
            await this.addRunEventSafe(run.id, 'followup-enqueued', {
                followupRunId: followupRun.id,
                stageIndex: nextIndex,
            });
            await this.appendSyntheticMessageSafe(
                workload.sessionId,
                'system',
                `Deferred workload "${workload.title}" scheduled a follow-up stage ${nextIndex + 1}.`,
            );
            await this.emitWorkloadUpdate('workload_queued', workload.sessionId, {
                workloadId: workload.id,
                runId: followupRun.id,
                stageIndex: nextIndex,
                reason: 'followup',
            });
        }

        return followupRun;
    }

    async resolveStageInputs(run, stage = null) {
        const resolved = {
            parent: null,
            named: {},
        };
        const requestedKeys = Array.isArray(stage?.inputFrom) ? stage.inputFrom : [];
        let currentRunId = run?.parentRunId || run?.metadata?.parentRunId || null;
        let depth = 0;

        while (currentRunId && depth < 20) {
            const parentRun = await this.store.getRunById(currentRunId);
            if (!parentRun) {
                break;
            }

            const output = this.extractRunOutput(parentRun);
            if (!resolved.parent && output) {
                resolved.parent = output;
            }

            const outputKey = String(parentRun?.metadata?.outputKey || '').trim();
            if (outputKey && output && !resolved.named[outputKey]) {
                resolved.named[outputKey] = output;
            }

            currentRunId = parentRun.parentRunId || parentRun.metadata?.parentRunId || null;
            depth += 1;
        }

        if (requestedKeys.length === 0) {
            return resolved;
        }

        return {
            parent: resolved.parent,
            named: Object.fromEntries(
                requestedKeys
                    .filter((key) => resolved.named[key])
                    .map((key) => [key, resolved.named[key]]),
            ),
        };
    }

    extractRunOutput(run = {}) {
        const output = run?.metadata?.output;
        if (!output || typeof output !== 'object') {
            return null;
        }

        const text = String(output.text || output.artifactMessage || '').trim();
        const artifacts = Array.isArray(output.artifacts)
            ? output.artifacts
                .filter((artifact) => artifact?.id || artifact?.filename)
                .map((artifact) => ({
                    id: artifact.id || null,
                    filename: artifact.filename || null,
                    mimeType: artifact.mimeType || null,
                }))
            : [];

        if (!text && artifacts.length === 0) {
            return null;
        }

        return {
            text,
            artifacts,
        };
    }

    renderStageInputText(stageInputs = {}, stage = null) {
        const sections = [];
        const requestedKeys = Array.isArray(stage?.inputFrom) ? stage.inputFrom : [];

        if (requestedKeys.length > 0) {
            requestedKeys.forEach((key) => {
                const entry = stageInputs?.named?.[key];
                if (entry) {
                    sections.push(this.formatStageInputSection(key, entry));
                }
            });
        } else if (stageInputs?.parent) {
            sections.push(this.formatStageInputSection('previous_stage', stageInputs.parent));
        }

        return sections.filter(Boolean).join('\n\n');
    }

    formatStageInputSection(label = 'previous_stage', entry = {}) {
        const parts = [];
        const text = String(entry?.text || '').trim();
        const artifacts = Array.isArray(entry?.artifacts) ? entry.artifacts : [];

        if (text) {
            parts.push(text);
        }
        if (artifacts.length > 0) {
            parts.push(`Artifacts: ${artifacts.map((artifact) => artifact.filename || artifact.id).filter(Boolean).join(', ')}`);
        }

        if (parts.length === 0) {
            return '';
        }

        return `[${label}]\n${parts.join('\n\n')}`;
    }

    buildStageMessage(prompt = '', stageInputs = {}, stage = null, workload = null, run = {}) {
        const trimmedPrompt = String(prompt || '').trim();
        const inputText = this.renderStageInputText(stageInputs, stage);
        const projectContext = formatProjectExecutionContext(extractProjectPlan(workload, {
            title: workload?.title,
            prompt: workload?.prompt,
        }));
        const longAgentContext = buildLongAgentExecutionContext(workload, run);
        const creationContext = this.renderCreationContext(workload?.metadata?.creationContext);

        const contextParts = [
            workload?.metadata?.agentCompany?.enabled === true && trimmedPrompt !== workload.prompt
                ? `[Original company task and delivery contract]\n${workload.prompt}` : '',
            projectContext,
            longAgentContext,
            creationContext,
        ].filter(Boolean);
        const contextText = contextParts.join('\n\n');

        if (contextText && trimmedPrompt && inputText) {
            return `${contextText}\n\nCurrent run objective:\n${trimmedPrompt}\n\nContext from prior stages:\n\n${inputText}`;
        }
        if (contextText && trimmedPrompt) {
            return `${contextText}\n\nCurrent run objective:\n${trimmedPrompt}`;
        }
        if (contextText && inputText) {
            return `${contextText}\n\nContext from prior stages:\n\n${inputText}`;
        }
        if (trimmedPrompt && inputText) {
            return `${trimmedPrompt}\n\nContext from prior stages:\n\n${inputText}`;
        }
        if (trimmedPrompt) {
            return trimmedPrompt;
        }
        return inputText;
    }

    renderCreationContext(context = null) {
        if (!context || typeof context !== 'object' || Array.isArray(context)) {
            return '';
        }

        const lines = [];
        const instruction = sanitizeText(context.instruction);
        const originalRequest = sanitizeText(context.originalRequest);
        const resolvedRequest = sanitizeText(context.resolvedRequest);
        const recentMessages = Array.isArray(context.recentMessages)
            ? context.recentMessages
                .map((message) => {
                    const role = sanitizeText(message?.role);
                    const content = sanitizeText(message?.content);
                    return role && content ? `${role}: ${content}` : '';
                })
                .filter(Boolean)
                .slice(-8)
            : [];

        if (instruction) {
            lines.push(instruction);
        }
        if (originalRequest) {
            lines.push(`Original scheduling request: ${originalRequest}`);
        }
        if (resolvedRequest) {
            lines.push(`Resolved workload request: ${resolvedRequest}`);
        }
        if (recentMessages.length > 0) {
            lines.push(`Recent chat context:\n${recentMessages.join('\n')}`);
        }

        return lines.length > 0
            ? `[Workload creation context]\n${lines.join('\n\n')}`
            : '';
    }

    buildCompletedRunMetadata(run = {}, stage = null, result = {}) {
        const outputKey = String(stage?.outputKey || '').trim() || null;
        const artifacts = Array.isArray(result?.artifacts)
            ? result.artifacts
                .filter((artifact) => artifact?.id || artifact?.filename)
                .map((artifact) => ({
                    id: artifact.id || null,
                    filename: artifact.filename || null,
                    mimeType: artifact.mimeType || null,
                }))
            : [];
        const outputText = this.truncateStoredOutput(
            String(result?.outputText || result?.artifactMessage || '').trim(),
        );
        const artifactMessage = this.truncateStoredOutput(
            String(result?.artifactMessage || '').trim(),
        );
        const remoteExecution = getRemoteExecutionState(result, run.workload);

        const metadata = {
            ...(run.metadata || {}),
            ...(outputKey ? { outputKey } : {}),
            output: {
                text: outputText,
                artifactMessage,
                artifacts,
                ...(remoteExecution ? { remoteExecution, ...(isRemoteExecutionPending(remoteExecution) ? { goalComplete: false } : {}) } : {}),
            },
        };
        const longAgent = normalizeLongAgentMetadata(run?.workload?.metadata || {}, {
            goal: run?.workload?.prompt,
        });
        if (longAgent) {
            const evaluation = evaluateLongAgentStop({
                workload: run.workload,
                run,
                result,
                succeeded: true,
            });
            metadata.longAgentStep = evaluation?.step || getLongAgentStep(run);
            metadata.longAgentScratchSummary = evaluation?.scratchSummary || '';
            metadata.output.goalComplete = evaluation?.goalComplete === true;
            if (evaluation?.goalCompletionSource) metadata.output.goalCompletionSource = evaluation.goalCompletionSource;
        }

        return metadata;
    }

    _truncateStoredOutputLegacy(value = '', maxLength = 20000) {
        const normalized = String(value || '');
        if (normalized.length <= maxLength) {
            return normalized;
        }

        return `${normalized.slice(0, maxLength - 1)}…`;
    }

    truncateStoredOutput(value = '', maxLength = 20000) {
        const normalized = String(value || '');
        if (normalized.length <= maxLength) {
            return normalized;
        }

        return `${normalized.slice(0, maxLength - 3)}...`;
    }

    async persistProjectReview(workload, run, review = {}) {
        const project = extractProjectPlan(workload, {
            title: workload?.title,
            prompt: workload?.prompt,
        });
        if (!project || typeof this.store?.updateWorkload !== 'function') {
            return workload;
        }

        const nextProject = recordProjectReview(project, {
            runId: run?.id || '',
            reviewedAt: new Date().toISOString(),
            milestoneId: project.activeMilestoneId,
            status: review.remoteExecutionPending ? 'running' : review.succeeded ? 'completed' : 'failed',
            summary: this.truncateStoredOutput(String(review.outputText || '').trim(), 400),
            stageIndex: run?.stageIndex,
            artifacts: review.artifacts || [],
        });

        try {
            const updated = await this.store.updateWorkload(workload.id, workload.ownerId, {
                metadata: {
                    ...(workload.metadata || {}),
                    projectMode: true,
                    project: nextProject,
                },
            });

            return updated || {
                ...workload,
                metadata: {
                    ...(workload.metadata || {}),
                    projectMode: true,
                    project: nextProject,
                },
            };
        } catch (error) {
            console.warn(`[Workloads] Failed to persist project review for ${workload.id}:`, error.message);
            return workload;
        }
    }

    async handleLongAgentStop(workload, run, {
        succeeded = true,
        stage = null,
        result = {},
        error = null,
    } = {}) {
        const longAgent = normalizeLongAgentMetadata(workload?.metadata || {}, {
            goal: workload?.prompt,
        });
        if (!longAgent || String(run?.reason || '').startsWith('long-agent-final')) {
            return null;
        }

        const evaluation = evaluateLongAgentStop({
            workload,
            run,
            result,
            succeeded,
            error,
        });
        if (!evaluation) {
            return null;
        }

        await this.addRunEventSafe(run.id, 'long-agent-evaluator', {
            workloadId: workload.id,
            stageIndex: run.stageIndex,
            evaluation,
        });

        const failureFingerprint = succeeded ? '' : crypto.createHash('sha256')
            .update(String(error?.message || result.outputText || '')).digest('hex');
        const nextMetadata = {
            ...(workload.metadata || {}),
            longAgent: {
                ...(workload.metadata?.longAgent || {}),
                lastFailure: succeeded ? null : {
                    fingerprint: failureFingerprint,
                    count: workload.metadata?.longAgent?.lastFailure?.fingerprint === failureFingerprint
                        ? Number(workload.metadata.longAgent.lastFailure.count || 0) + 1 : 1,
                },
                enabled: true,
                goal: longAgent.goal,
                scratchFile: longAgent.scratchFile,
                maxAutoSteps: longAgent.maxAutoSteps,
                reviewPolicy: longAgent.reviewPolicy,
                compaction: longAgent.compaction,
                lastScratchSummary: evaluation.scratchSummary,
                lastDecision: {
                    runId: run.id,
                    step: evaluation.step,
                    decision: evaluation.decision,
                    reason: evaluation.reason,
                    at: new Date().toISOString(),
                },
            },
        };

        let trackedWorkload = workload;
        try {
            const updated = await this.store.updateWorkload(workload.id, workload.ownerId, {
                metadata: nextMetadata,
            });
            trackedWorkload = updated || {
                ...workload,
                metadata: nextMetadata,
            };
        } catch (updateError) {
            console.warn(`[Workloads] Failed to persist long-agent review for ${workload.id}:`, updateError.message);
        }

        if (workload.metadata?.agentCompany?.enabled === true && nextMetadata.longAgent.lastFailure?.count >= 2) {
            await this.addRunEventSafe(run.id, 'long-agent-blocked', {
                reason: 'Same execution failure repeated twice; needs a changed environment or explicit recovery.',
            });
            return null;
        }
        if (evaluation.decision === 'complete' || evaluation.decision === 'stop_max_steps') {
            await this.addRunEventSafe(run.id, evaluation.decision === 'complete' ? 'long-agent-complete' : 'long-agent-paused', {
                decision: evaluation.decision,
                reason: evaluation.reason,
                scratchSummary: evaluation.scratchSummary,
                ...(evaluation.remoteExecution ? { remoteExecution: evaluation.remoteExecution, goalComplete: evaluation.goalComplete } : {}),
            });
            if (evaluation.decision === 'stop_max_steps' && evaluation.remoteExecutionPending) {
                await this.appendSyntheticMessageSafe(workload.sessionId, 'system',
                    `Long agent "${workload.title}" reached its automatic stage limit while its remote job remains unfinished. The job cursor is preserved; resume this goal to continue observing it.`);
            }
            return null;
        }

        const nextStep = evaluation.step + 1;
        if (nextStep > longAgent.maxAutoSteps) {
            return null;
        }

        const reason = evaluation.decision === 'review'
            ? 'long-agent-review'
            : 'long-agent-next-step';
        const priorOutput = String(result?.outputText || result?.artifactMessage || error?.message || '').trim();
        const prompt = evaluation.decision === 'review'
            ? buildReviewPrompt(longAgent, evaluation, priorOutput)
            : buildNextStepPrompt(longAgent, evaluation);
        const scheduledFor = new Date(Date.now() + 1000);
        const followupRun = await this.store.enqueueRun({
            workloadId: workload.id,
            ownerId: workload.ownerId,
            sessionId: workload.sessionId,
            reason,
            scheduledFor,
            parentRunId: run.id,
            stageIndex: Number.isFinite(Number(run.stageIndex)) ? Number(run.stageIndex) : -1,
            prompt,
            idempotencyKey: deriveRunIdempotencyKey({
                workloadId: workload.id,
                scheduledFor: scheduledFor.toISOString(),
                stageIndex: Number.isFinite(Number(run.stageIndex)) ? Number(run.stageIndex) : -1,
                reason: `${reason}-${run.id}-${nextStep}`,
            }),
            metadata: {
                parentRunId: run.id,
                longAgentStep: nextStep,
                longAgentDecision: evaluation.decision,
                longAgentScratchFile: longAgent.scratchFile,
                longAgentScratchSummary: evaluation.scratchSummary,
            },
        });

        if (isQueuedLikeRun(followupRun)) {
            await this.addRunEventSafe(run.id, `${reason}-enqueued`, {
                followupRunId: followupRun.id,
                step: nextStep,
                scratchFile: longAgent.scratchFile,
            });
            await this.appendSyntheticMessageSafe(
                trackedWorkload.sessionId,
                'system',
                `Long agent "${trackedWorkload.title}" queued ${reason.replace(/-/g, ' ')} stage ${nextStep}.`,
            );
            await this.emitWorkloadUpdate('workload_queued', trackedWorkload.sessionId, {
                workloadId: trackedWorkload.id,
                runId: followupRun.id,
                scheduledFor: followupRun.scheduledFor,
                reason,
            });
        }

        return followupRun;
    }

    async getSessionSummaries(sessionIds = [], ownerId = null) {
        if (!this.isAvailable()) {
            return {};
        }
        return this.store.getSessionSummaries(sessionIds, ownerId);
    }

    async resolveWorkload(idOrSlug, ownerId) {
        const byId = await this.store.getWorkloadById(idOrSlug, ownerId);
        if (byId) {
            return byId;
        }

        return this.store.getWorkloadByCallableSlug(idOrSlug, ownerId);
    }

    async onRunQueued(workload, run, source = 'scheduled') {
        const agentRunShadow = await this.captureAgentRunShadow(workload, run, 'created', {
            source,
        });
        await this.addRunEventSafe(run.id, 'queued', {
            source,
            scheduledFor: run.scheduledFor,
        });
        await this.appendSyntheticMessageSafe(
            workload.sessionId,
            'system',
            `Deferred workload "${workload.title}" queued for ${run.scheduledFor}.`,
        );
        await this.emitWorkloadUpdate('workload_queued', workload.sessionId, attachAgentRunMetadata({
            workloadId: workload.id,
            runId: run.id,
            scheduledFor: run.scheduledFor,
            reason: run.reason,
        }, agentRunShadow, { eventType: 'workload.queued' }));
    }

    async emitWorkloadUpdate(type, sessionId, data = {}) {
        const payload = {
            type,
            sessionId,
            data,
            timestamp: new Date().toISOString(),
        };

        try {
            broadcastToSession(sessionId, payload);
            broadcastToAdmins(payload);
        } catch (error) {
            console.warn(`[Workloads] Failed to broadcast ${type}:`, error.message);
        }
    }

    async addRunEventSafe(runId, eventType, payload = {}) {
        if (!runId) {
            console.warn(`[Workloads] Skipped run event '${eventType}' because no run id was provided.`);
            return false;
        }

        try {
            return await this.store.addRunEvent(runId, eventType, payload);
        } catch (error) {
            console.warn(`[Workloads] Failed to record run event '${eventType}' for ${runId}:`, error.message);
            return false;
        }
    }

    async appendSyntheticMessageSafe(sessionId, role, content) {
        try {
            await this.conversationRunService.appendSyntheticMessage(sessionId, role, content);
        } catch (error) {
            console.warn(`[Workloads] Failed to append synthetic message for session ${sessionId}:`, error.message);
        }
    }
}

module.exports = {
    AgentWorkloadService,
    RUN_STATUS,
};

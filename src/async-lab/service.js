'use strict';

const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { config } = require('../config');
const { AsyncLabStore } = require('./store');
const { ValkeyLiveBus, normalizeText, sleep } = require('./valkey-live-bus');

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const REMOTE_ADAPTER_PATTERNS = [
    /remote/i,
    /ssh/i,
    /k3s/i,
    /deploy/i,
    /managed-app/i,
    /build-webhook/i,
];

function createServiceError(message, statusCode = 503) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function stableStringify(value) {
    if (!value || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
    }

    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`;
}

function hashPayload(value = {}) {
    return createHash('sha256')
        .update(stableStringify(value))
        .digest('hex')
        .slice(0, 32);
}

function normalizeAdapter(value = '') {
    const adapter = normalizeText(value).toLowerCase();
    return adapter || 'dry-run';
}

function isRemoteAdapter(adapter = '') {
    return REMOTE_ADAPTER_PATTERNS.some((pattern) => pattern.test(adapter));
}

function pickText(...values) {
    for (const value of values) {
        const normalized = normalizeText(value);
        if (normalized) {
            return normalized;
        }
    }
    return '';
}

function deriveTargetKey(input = {}) {
    return pickText(
        input.targetKey,
        input.target,
        input.appId,
        input.appRef,
        input.namespace,
        input.host,
        input.repo,
        input.repository,
        input.sessionId ? `session/${input.sessionId}` : '',
        'lab/default',
    );
}

function makeRunId() {
    return `async-run-${randomUUID()}`;
}

function buildDefaultIdempotencyKey(input = {}) {
    const explicit = pickText(
        input.idempotencyKey,
        input.idempotency_key,
        input.requestId,
        input.request_id,
        input.webhookId,
        input.webhook_id,
    );
    if (explicit) {
        return explicit;
    }

    if (input.requireGeneratedIdempotency === true) {
        return `generated:${hashPayload({
            adapter: input.adapter,
            targetKey: deriveTargetKey(input),
            task: input.task || input.message || input.prompt || '',
            metadata: input.metadata || {},
        })}`;
    }

    return '';
}

class AsyncLabService {
    constructor(options = {}) {
        const runtimeConfig = options.config || config.asyncRuntime || {};
        this.config = {
            enabled: runtimeConfig.enabled === true,
            adminToggleAllowed: runtimeConfig.adminToggleAllowed === true
                || runtimeConfig.enabled === true,
            mode: runtimeConfig.mode || 'lab',
            namespace: runtimeConfig.namespace || 'kimibuilt-async-lab',
            surface: runtimeConfig.surface || 'async-lab',
            valkeyUrl: runtimeConfig.valkeyUrl || '',
            valkeyKeyPrefix: runtimeConfig.valkeyKeyPrefix || 'kimibuilt:async-lab',
            eventTtlSeconds: Math.max(60, Number(runtimeConfig.eventTtlSeconds) || 3600),
            idempotencyTtlSeconds: Math.max(60, Number(runtimeConfig.idempotencyTtlSeconds) || 86400),
            leaseTtlMs: Math.max(1000, Number(runtimeConfig.leaseTtlMs) || 120000),
            workerEnabled: runtimeConfig.workerEnabled !== false,
            workerPollIntervalMs: Math.max(100, Number(runtimeConfig.workerPollIntervalMs) || 500),
            simulationDelayMs: Math.max(0, Number(runtimeConfig.simulationDelayMs) || 180),
            lockRetryMs: Math.max(25, Number(runtimeConfig.lockRetryMs) || 250),
            maxLockWaitMs: Math.max(250, Number(runtimeConfig.maxLockWaitMs) || 15000),
            allowLiveRemote: runtimeConfig.allowLiveRemote === true,
            webhookSecret: runtimeConfig.webhookSecret || '',
            persistToPostgres: runtimeConfig.persistToPostgres !== false,
        };
        this.liveRemoteConfigured = this.config.allowLiveRemote === true;
        this.store = options.store || new AsyncLabStore({
            persistToPostgres: this.config.persistToPostgres,
        });
        this.bus = options.bus || new ValkeyLiveBus({
            url: this.config.valkeyUrl,
            keyPrefix: this.config.valkeyKeyPrefix,
            eventTtlSeconds: this.config.eventTtlSeconds,
            idempotencyTtlSeconds: this.config.idempotencyTtlSeconds,
            leaseTtlMs: this.config.leaseTtlMs,
        });
        this.instanceId = options.instanceId || `async-lab-${os.hostname()}-${process.pid}-${randomUUID()}`;
        this.workerTimer = null;
        this.drainPromise = null;
        this.initialized = false;
        this.lastError = '';
        this.controlRequestedEnabled = this.config.enabled === true;
        this.webChatParallelEnabled = false;
    }

    isEnabled() {
        return this.config.enabled === true;
    }

    isAdminToggleAllowed() {
        return this.config.adminToggleAllowed === true;
    }

    assertEnabled() {
        if (!this.isEnabled()) {
            throw createServiceError('Async runtime lab is disabled', 404);
        }
    }

    async initialize() {
        if (this.initialized) {
            return true;
        }

        await this.store.initialize();
        await this.bus.connect();
        this.initialized = true;
        return true;
    }

    async applyControlConfig(control = {}) {
        if (control.adminToggleAllowed !== undefined) {
            this.config.adminToggleAllowed = control.adminToggleAllowed === true;
        }
        if (control.workerEnabled !== undefined) {
            this.config.workerEnabled = control.workerEnabled !== false;
        }

        const requestedEnabled = control.enabled === true;
        this.controlRequestedEnabled = requestedEnabled;
        this.webChatParallelEnabled = control.webChatParallelEnabled === true;
        const nextEnabled = requestedEnabled && this.isAdminToggleAllowed();
        this.config.allowLiveRemote = this.liveRemoteConfigured && control.allowLiveRemote === true;
        this.config.enabled = nextEnabled;

        if (!nextEnabled) {
            this.stopWorker();
            return {
                active: false,
                enabled: false,
                reason: requestedEnabled ? 'admin-toggle-not-allowed' : 'disabled',
            };
        }

        try {
            await this.initialize();
            if (this.config.workerEnabled) {
                this.startWorker();
            } else {
                this.stopWorker();
            }
            return {
                active: true,
                enabled: true,
                reason: 'enabled',
            };
        } catch (error) {
            this.config.enabled = false;
            this.stopWorker();
            this.lastError = error.message;
            return {
                active: false,
                enabled: false,
                reason: error.message,
            };
        }
    }

    startWorker() {
        if (!this.isEnabled() || !this.config.workerEnabled || this.workerTimer) {
            return false;
        }

        this.workerTimer = setInterval(() => {
            this.scheduleDrain();
        }, this.config.workerPollIntervalMs);
        this.workerTimer.unref?.();
        this.scheduleDrain();
        return true;
    }

    stopWorker() {
        if (this.workerTimer) {
            clearInterval(this.workerTimer);
            this.workerTimer = null;
        }
    }

    scheduleDrain() {
        if (this.drainPromise) {
            return this.drainPromise;
        }

        this.drainPromise = this.drainQueue()
            .catch((error) => {
                this.lastError = error.message;
                console.warn(`[AsyncLab] Worker drain failed: ${error.message}`);
            })
            .finally(() => {
                this.drainPromise = null;
            });
        return this.drainPromise;
    }

    getStatus() {
        return {
            requestedEnabled: this.controlRequestedEnabled,
            enabled: this.isEnabled(),
            adminToggleAllowed: this.isAdminToggleAllowed(),
            mode: this.config.mode,
            namespace: this.config.namespace,
            surface: this.config.surface,
            webChatParallelEnabled: this.webChatParallelEnabled,
            valkeyConfigured: Boolean(this.config.valkeyUrl),
            workerEnabled: this.config.workerEnabled,
            workerRunning: Boolean(this.workerTimer),
            allowLiveRemote: this.config.allowLiveRemote,
            persistence: this.store.usePostgres ? 'postgres' : 'memory',
            bus: this.bus.getStatus(),
            instanceId: this.instanceId,
            lastError: this.lastError || null,
        };
    }

    async createRun(input = {}, ownerId = '') {
        this.assertEnabled();
        await this.initialize();

        let runId = normalizeText(input.id) || makeRunId();
        const adapter = normalizeAdapter(input.adapter || input.tool || input.kind);
        const remoteAdapter = isRemoteAdapter(adapter);
        const liveRemoteRequested = remoteAdapter && (
            input.liveRemoteRequested === true
            || input.liveRemote === true
            || input.allowLiveRemote === true
        );
        const liveRemoteAllowed = liveRemoteRequested && this.config.allowLiveRemote;
        const targetKey = deriveTargetKey(input);
        const idempotencyKey = buildDefaultIdempotencyKey(input);

        if (idempotencyKey) {
            const existing = await this.store.getRunByIdempotency(this.config.surface, idempotencyKey);
            if (existing) {
                return {
                    run: existing,
                    duplicate: true,
                    events: await this.listEvents(existing.id, 0),
                };
            }

            const claim = await this.bus.claimIdempotency(idempotencyKey, runId);
            if (!claim.claimed) {
                runId = claim.runId || runId;
                const claimedRun = await this.store.getRun(runId)
                    || await this.store.getRunByIdempotency(this.config.surface, idempotencyKey);
                if (claimedRun) {
                    return {
                        run: claimedRun,
                        duplicate: true,
                        events: await this.listEvents(claimedRun.id, 0),
                    };
                }
            }
        }

        const runInput = {
            id: runId,
            ownerId: normalizeText(ownerId || input.ownerId || input.owner_id),
            sessionId: normalizeText(input.sessionId || input.session_id),
            runtimeSurface: this.config.surface,
            mode: this.config.mode,
            adapter,
            status: 'queued',
            targetKey,
            idempotencyKey,
            task: pickText(input.task, input.message, input.prompt, 'Async lab run'),
            liveRemoteRequested,
            liveRemoteAllowed,
            metadata: {
                ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
                runtimeSurface: this.config.surface,
                remoteAdapter,
                dryRun: remoteAdapter && !liveRemoteAllowed,
                allowLiveRemote: this.config.allowLiveRemote,
                namespace: this.config.namespace,
            },
        };

        try {
            const run = await this.store.createRun(runInput);
            await this.appendEvent(run.id, {
                type: 'queued',
                source: 'async-lab',
                status: run.status,
                payload: {
                    message: 'Run accepted by the adjacent async lab queue.',
                    adapter: run.adapter,
                    targetKey: run.targetKey,
                    dryRun: run.metadata?.dryRun === true,
                },
            });
            await this.bus.enqueueRun(run.id);
            if (this.config.workerEnabled) {
                this.scheduleDrain();
            }
            return {
                run: await this.store.getRun(run.id),
                duplicate: false,
                events: await this.listEvents(run.id, 0),
            };
        } catch (error) {
            if (error.code === '23505' && idempotencyKey) {
                const existing = await this.store.getRunByIdempotency(this.config.surface, idempotencyKey);
                if (existing) {
                    return {
                        run: existing,
                        duplicate: true,
                        events: await this.listEvents(existing.id, 0),
                    };
                }
            }
            throw error;
        }
    }

    async getRun(runId = '', ownerId = '') {
        this.assertEnabled();
        const run = await this.store.getRun(runId);
        if (!run) {
            return null;
        }
        const normalizedOwner = normalizeText(ownerId);
        if (normalizedOwner && run.ownerId && run.ownerId !== normalizedOwner) {
            return null;
        }
        return run;
    }

    async listRuns(ownerId = '', limit = 50) {
        this.assertEnabled();
        return this.store.listRuns(this.config.surface, ownerId, limit);
    }

    async listEvents(runId = '', afterCursor = 0) {
        this.assertEnabled();
        return this.store.listEvents(runId, afterCursor);
    }

    subscribeToRun(runId = '', handler = () => {}) {
        if (!this.isEnabled()) {
            return () => {};
        }
        return this.bus.subscribe(runId, handler);
    }

    async cancelRun(runId = '', ownerId = '') {
        this.assertEnabled();
        const run = await this.getRun(runId, ownerId);
        if (!run) {
            return null;
        }

        if (TERMINAL_STATUSES.has(run.status)) {
            return {
                run,
                changed: false,
            };
        }

        const cancelledAt = run.status === 'queued' ? new Date().toISOString() : '';
        const nextStatus = run.status === 'queued' ? 'cancelled' : run.status;
        const updated = await this.store.updateRun(run.id, {
            status: nextStatus,
            cancelRequested: true,
            cancelledAt,
            metadata: {
                cancelRequestedBy: normalizeText(ownerId) || 'unknown',
            },
        });
        await this.appendEvent(run.id, {
            type: nextStatus === 'cancelled' ? 'cancelled' : 'cancel_requested',
            source: 'async-lab',
            status: nextStatus,
            payload: {
                message: nextStatus === 'cancelled'
                    ? 'Queued run cancelled before execution.'
                    : 'Cancellation requested; the active worker will stop at the next checkpoint.',
            },
        });
        return {
            run: updated,
            changed: true,
        };
    }

    async appendEvent(runId = '', event = {}) {
        const saved = await this.store.appendEvent(runId, event);
        if (saved) {
            await this.bus.appendEvent(runId, saved);
        }
        return saved;
    }

    async drainQueue() {
        this.assertEnabled();
        await this.initialize();

        let processed = 0;
        while (processed < 50) {
            const runId = await this.bus.dequeueRun();
            if (!runId) {
                break;
            }
            processed += 1;
            await this.processRun(runId);
        }

        if (processed < 50) {
            const runnableRuns = await this.store.listRunnableRuns(this.config.surface, 50 - processed);
            for (const run of runnableRuns) {
                processed += 1;
                await this.processRun(run.id);
                if (processed >= 50) {
                    break;
                }
            }
        }
        return processed;
    }

    async processRun(runId = '') {
        const normalizedRunId = normalizeText(runId);
        if (!normalizedRunId) {
            return false;
        }

        const runLockOwner = `${this.instanceId}:${normalizedRunId}`;
        const runLockName = `run:${normalizedRunId}`;
        const runLocked = await this.bus.acquireLock(runLockName, runLockOwner, this.config.leaseTtlMs);
        if (!runLocked) {
            return false;
        }

        let targetLockName = '';
        let targetLocked = false;
        let claimedOwner = '';
        try {
            let run = await this.store.claimRun(normalizedRunId, runLockOwner, this.config.leaseTtlMs);
            claimedOwner = runLockOwner;
            if (!run || TERMINAL_STATUSES.has(run.status)) {
                return false;
            }

            if (run.cancelRequested) {
                await this.markCancelled(run, 'Run was cancelled before execution started.');
                return true;
            }

            const recovered = run.status === 'running' && run.attempt > 1;
            run = await this.store.updateRun(run.id, {
                status: 'running',
                startedAt: run.startedAt || new Date().toISOString(),
                metadata: recovered ? {
                    recoveredBy: this.instanceId,
                    recoveredAt: new Date().toISOString(),
                } : {},
            });
            await this.appendEvent(run.id, {
                type: recovered ? 'lease_recovered' : 'started',
                source: 'async-lab-worker',
                status: 'running',
                payload: {
                    message: recovered
                        ? 'Worker recovered an expired async lab run lease.'
                        : 'Worker acquired the run lease.',
                    instanceId: this.instanceId,
                    attempt: run.attempt,
                },
            });

            targetLockName = `target:${run.targetKey}`;
            targetLocked = await this.acquireTargetLock(run, targetLockName, runLockOwner);
            if (!targetLocked) {
                await this.markFailed(run, `Timed out waiting for target lock ${run.targetKey}`);
                return false;
            }

            await this.executeLabRun(run);
            return true;
        } catch (error) {
            const run = await this.store.getRun(normalizedRunId);
            if (run && !TERMINAL_STATUSES.has(run.status)) {
                await this.markFailed(run, error.message);
            }
            this.lastError = error.message;
            return false;
        } finally {
            if (targetLocked && targetLockName) {
                await this.bus.releaseLock(targetLockName, runLockOwner);
            }
            if (claimedOwner) {
                await this.store.releaseClaim(normalizedRunId, claimedOwner);
            }
            await this.bus.releaseLock(runLockName, runLockOwner);
        }
    }

    async acquireTargetLock(run, lockName, owner) {
        const deadline = Date.now() + this.config.maxLockWaitMs;
        let emittedWait = false;
        while (Date.now() <= deadline) {
            const locked = await this.bus.acquireLock(lockName, owner, this.config.leaseTtlMs);
            if (locked) {
                await this.appendEvent(run.id, {
                    type: 'lock_acquired',
                    source: 'async-lab-worker',
                    status: 'running',
                    payload: {
                        lock: lockName,
                        targetKey: run.targetKey,
                    },
                });
                return true;
            }

            if (!emittedWait) {
                emittedWait = true;
                await this.appendEvent(run.id, {
                    type: 'lock_wait',
                    source: 'async-lab-worker',
                    status: 'running',
                    payload: {
                        message: 'Waiting for the per-target mutation lock.',
                        lock: lockName,
                        targetKey: run.targetKey,
                    },
                });
            }
            await sleep(this.config.lockRetryMs);
        }
        return false;
    }

    async executeLabRun(run = {}) {
        const plan = this.buildExecutionPlan(run);
        for (const step of plan) {
            const current = await this.store.getRun(run.id);
            if (!current || TERMINAL_STATUSES.has(current.status)) {
                return;
            }
            if (current.cancelRequested) {
                await this.markCancelled(current, 'Run stopped at a cancellation checkpoint.');
                return;
            }

            const completedStepKeys = Array.isArray(current.metadata?.completedStepKeys)
                ? current.metadata.completedStepKeys
                : [];
            if (step.stepKey && completedStepKeys.includes(step.stepKey)) {
                continue;
            }

            await this.store.refreshClaim(run.id, `${this.instanceId}:${run.id}`, this.config.leaseTtlMs);
            await this.appendEvent(run.id, {
                type: 'heartbeat',
                source: 'async-lab-worker',
                status: 'running',
                payload: {
                    message: 'Worker lease heartbeat refreshed.',
                    instanceId: this.instanceId,
                    stepKey: step.stepKey || '',
                },
            });
            await this.appendEvent(run.id, step);
            if (step.stepKey) {
                await this.store.updateRun(run.id, {
                    status: 'running',
                    metadata: {
                        completedStepKeys: Array.from(new Set([...completedStepKeys, step.stepKey])),
                    },
                });
            }
            await sleep(this.config.simulationDelayMs);
        }

        const completed = await this.store.updateRun(run.id, {
            status: 'completed',
            completedAt: new Date().toISOString(),
        });
        await this.appendEvent(run.id, {
            type: 'completed',
            source: 'async-lab-worker',
            status: 'completed',
            payload: {
                message: 'Async lab run completed.',
                dryRun: completed?.metadata?.dryRun === true,
                runtimeSurface: this.config.surface,
            },
        });
    }

    buildExecutionPlan(run = {}) {
        const remoteAdapter = run.metadata?.remoteAdapter === true || isRemoteAdapter(run.adapter);
        const dryRun = remoteAdapter && !run.liveRemoteAllowed;
        const basePayload = {
            adapter: run.adapter,
            targetKey: run.targetKey,
            runtimeSurface: this.config.surface,
        };
        const plan = [{
            stepKey: 'normalize',
            type: 'progress',
            source: 'async-lab-worker',
            status: 'running',
            payload: {
                ...basePayload,
                message: 'Command normalized into a replayable message envelope.',
            },
        }];

        if (remoteAdapter) {
            plan.push({
                stepKey: 'remote-safety',
                type: 'safety',
                source: 'async-lab-worker',
                status: 'running',
                payload: {
                    ...basePayload,
                    dryRun,
                    allowLiveRemote: this.config.allowLiveRemote,
                    message: dryRun
                        ? 'Remote adapter is running in dry-run mode; no SSH, deploy, or managed-app mutation was executed.'
                        : 'Live remote execution is allowed by the lab flag for this run.',
                },
            });
        }

        if (run.adapter === 'build-webhook-copy') {
            plan.push({
                stepKey: 'webhook-copy',
                type: 'webhook_received',
                source: 'async-lab-webhook',
                status: 'running',
                payload: {
                    ...basePayload,
                    message: 'Copied build webhook event was accepted by the lab-only endpoint.',
                    externalRunId: run.metadata?.webhook?.externalRunId || '',
                    buildStatus: run.metadata?.webhook?.status || '',
                },
            });
        } else {
            plan.push({
                stepKey: 'tool-message',
                type: 'tool_message',
                source: 'async-lab-worker',
                status: 'running',
                payload: {
                    ...basePayload,
                    message: dryRun
                        ? `Would invoke ${run.adapter} against ${run.targetKey}.`
                        : `Prepared live ${run.adapter} invocation envelope for ${run.targetKey}.`,
                    task: run.task,
                },
            });
        }

        plan.push({
            stepKey: 'checkpoint',
            type: 'checkpoint',
            source: 'async-lab-worker',
            status: 'running',
            payload: {
                ...basePayload,
                message: 'Durable checkpoint persisted; reconnecting clients can replay from the last cursor.',
            },
        });

        return plan;
    }

    async markCancelled(run = {}, message = 'Run cancelled.') {
        const updated = await this.store.updateRun(run.id, {
            status: 'cancelled',
            cancelRequested: true,
            cancelledAt: new Date().toISOString(),
        });
        await this.appendEvent(run.id, {
            type: 'cancelled',
            source: 'async-lab-worker',
            status: 'cancelled',
            payload: {
                message,
            },
        });
        return updated;
    }

    async markFailed(run = {}, message = 'Run failed.') {
        const updated = await this.store.updateRun(run.id, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            metadata: {
                failure: message,
            },
        });
        await this.appendEvent(run.id, {
            type: 'failed',
            source: 'async-lab-worker',
            status: 'failed',
            payload: {
                message,
            },
        });
        return updated;
    }

    async handleBuildWebhook(payload = {}, options = {}) {
        this.assertEnabled();
        const project = payload.project || payload.repository || {};
        const objectAttributes = payload.object_attributes || payload.build || payload.pipeline || {};
        const externalRunId = pickText(
            options.externalRunId,
            objectAttributes.id,
            objectAttributes.iid,
            payload.build_id,
            payload.pipeline_id,
            payload.id,
        );
        const commitSha = pickText(
            objectAttributes.sha,
            objectAttributes.commit_sha,
            payload.checkout_sha,
            payload.commit?.id,
            payload.commit?.sha,
        );
        const projectPath = pickText(
            project.path_with_namespace,
            project.full_name,
            project.name,
            payload.project_path,
            payload.repository?.name,
            'unknown-project',
        );
        const status = pickText(
            objectAttributes.status,
            payload.build_status,
            payload.status,
            'received',
        );
        const idempotencyKey = pickText(
            options.idempotencyKey,
            `build-webhook:${projectPath}:${externalRunId || commitSha || hashPayload(payload)}:${status}`,
        );

        return this.createRun({
            adapter: 'build-webhook-copy',
            task: `Process copied build webhook for ${projectPath}`,
            targetKey: `webhook/${projectPath}`,
            idempotencyKey,
            requireGeneratedIdempotency: true,
            metadata: {
                webhook: {
                    projectPath,
                    externalRunId,
                    commitSha,
                    status,
                    receivedAt: new Date().toISOString(),
                    copiedOnly: true,
                },
            },
        }, options.ownerId || 'async-lab-webhook');
    }

    async close() {
        this.stopWorker();
        await this.bus.close();
    }
}

const asyncLabService = new AsyncLabService();

module.exports = {
    AsyncLabService,
    asyncLabService,
    createServiceError,
    deriveTargetKey,
    isRemoteAdapter,
};

'use strict';

const { randomUUID } = require('crypto');
const { postgres } = require('../postgres');

const RUN_STATUS = Object.freeze({
    QUEUED: 'queued',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

class WorkloadStore {
    isAvailable() {
        return Boolean(postgres.enabled);
    }

    async ensureAvailable() {
        if (!this.isAvailable()) {
            const error = new Error('Deferred workloads require Postgres persistence');
            error.statusCode = 503;
            throw error;
        }
    }

    mapWorkload(row = null) {
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            ownerId: row.owner_id,
            sessionId: row.session_id,
            title: row.title,
            mode: row.mode,
            prompt: row.prompt,
            execution: row.execution && Object.keys(row.execution).length > 0 ? row.execution : null,
            enabled: row.enabled,
            callableSlug: row.callable_slug,
            trigger: row.trigger || {},
            policy: row.policy || {},
            stages: row.stages || [],
            metadata: row.metadata || {},
            createdAt: serializeDate(row.created_at),
            updatedAt: serializeDate(row.updated_at),
            workloadSummary: row.run_summary || null,
        };
    }

    mapRun(row = null) {
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            workloadId: row.workload_id,
            ownerId: row.owner_id,
            sessionId: row.session_id,
            status: row.status,
            reason: row.reason,
            scheduledFor: serializeDate(row.scheduled_for),
            startedAt: serializeDate(row.started_at),
            finishedAt: serializeDate(row.finished_at),
            claimOwner: row.claim_owner,
            claimExpiresAt: serializeDate(row.claim_expires_at),
            parentRunId: row.parent_run_id,
            stageIndex: Number(row.stage_index || 0),
            attempt: Number(row.attempt || 0),
            responseId: row.response_id || null,
            prompt: row.prompt || '',
            trace: row.trace || null,
            error: row.error || null,
            metadata: row.metadata || {},
            createdAt: serializeDate(row.created_at),
            updatedAt: serializeDate(row.updated_at),
            workload: row.workload ? this.mapWorkload(row.workload) : null,
        };
    }

    async createWorkload(input = {}) {
        await this.ensureAvailable();

        const id = randomUUID();
        try {
            const result = await postgres.query(
                `
                    INSERT INTO agent_workloads (
                        id,
                        owner_id,
                        session_id,
                        title,
                        mode,
                        prompt,
                        execution,
                        enabled,
                        callable_slug,
                        trigger,
                        policy,
                        stages,
                        metadata
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)
                    RETURNING *
                `,
                [
                    id,
                    input.ownerId,
                    input.sessionId,
                    input.title,
                    input.mode,
                    input.prompt,
                    JSON.stringify(input.execution || {}),
                    input.enabled !== false,
                    input.callableSlug || null,
                    JSON.stringify(input.trigger || {}),
                    JSON.stringify(input.policy || {}),
                    JSON.stringify(input.stages || []),
                    JSON.stringify(input.metadata || {}),
                ],
            );

            return this.mapWorkload(result.rows[0]);
        } catch (error) {
            throw this.normalizePersistenceError(error, 'create workload');
        }
    }

    async updateWorkload(id, ownerId, updates = {}) {
        await this.ensureAvailable();
        const current = await this.getWorkloadById(id, ownerId);
        if (!current) {
            return null;
        }

        try {
            const result = await postgres.query(
                `
                    UPDATE agent_workloads
                    SET title = $3,
                        mode = $4,
                        prompt = $5,
                        execution = $6::jsonb,
                        enabled = $7,
                        callable_slug = $8,
                        trigger = $9::jsonb,
                        policy = $10::jsonb,
                        stages = $11::jsonb,
                        metadata = $12::jsonb,
                        updated_at = NOW()
                    WHERE id = $1
                      AND owner_id = $2
                    RETURNING *
                `,
                [
                    id,
                    ownerId,
                    updates.title ?? current.title,
                    updates.mode ?? current.mode,
                    updates.prompt ?? current.prompt,
                    JSON.stringify(updates.execution ?? current.execution ?? {}),
                    updates.enabled ?? current.enabled,
                    updates.callableSlug ?? current.callableSlug,
                    JSON.stringify(updates.trigger ?? current.trigger),
                    JSON.stringify(updates.policy ?? current.policy),
                    JSON.stringify(updates.stages ?? current.stages),
                    JSON.stringify(updates.metadata ?? current.metadata ?? {}),
                ],
            );

            return this.mapWorkload(result.rows[0]);
        } catch (error) {
            throw this.normalizePersistenceError(error, 'update workload');
        }
    }

    async deleteWorkload(id, ownerId) {
        await this.ensureAvailable();
        const result = await postgres.query(
            'DELETE FROM agent_workloads WHERE id = $1 AND owner_id = $2',
            [id, ownerId],
        );

        return result.rowCount > 0;
    }

    async getWorkloadById(id, ownerId) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT *
                FROM agent_workloads
                WHERE id = $1
                  AND owner_id = $2
                LIMIT 1
            `,
            [id, ownerId],
        );

        return this.mapWorkload(result.rows[0]);
    }

    async getAdminWorkloadById(id) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT workloads.*,
                       COALESCE((
                           SELECT jsonb_build_object(
                               'queued', COUNT(*) FILTER (WHERE runs.status = 'queued'),
                               'running', COUNT(*) FILTER (WHERE runs.status = 'running'),
                               'failed', COUNT(*) FILTER (WHERE runs.status = 'failed')
                           )
                           FROM agent_runs runs
                           WHERE runs.workload_id = workloads.id
                       ), '{}'::jsonb) AS run_summary
                FROM agent_workloads workloads
                WHERE workloads.id = $1
                LIMIT 1
            `,
            [id],
        );

        return this.mapWorkload(result.rows[0]);
    }

    async getWorkloadByCallableSlug(slug, ownerId) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT *
                FROM agent_workloads
                WHERE callable_slug = $1
                  AND owner_id = $2
                LIMIT 1
            `,
            [slug, ownerId],
        );

        return this.mapWorkload(result.rows[0]);
    }

    async listSessionWorkloads(sessionId, ownerId) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT workloads.*,
                       COALESCE((
                           SELECT jsonb_build_object(
                               'queued', COUNT(*) FILTER (WHERE runs.status = 'queued'),
                               'running', COUNT(*) FILTER (WHERE runs.status = 'running'),
                               'failed', COUNT(*) FILTER (WHERE runs.status = 'failed')
                           )
                           FROM agent_runs runs
                           WHERE runs.workload_id = workloads.id
                       ), '{}'::jsonb) AS run_summary
                FROM agent_workloads workloads
                WHERE workloads.session_id = $1
                  AND workloads.owner_id = $2
                ORDER BY workloads.updated_at DESC
            `,
            [sessionId, ownerId],
        );

        return result.rows.map((row) => this.mapWorkload(row));
    }

    async listAdminWorkloads(limit = 100) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT workloads.*,
                       COALESCE((
                           SELECT jsonb_build_object(
                               'queued', COUNT(*) FILTER (WHERE runs.status = 'queued'),
                               'running', COUNT(*) FILTER (WHERE runs.status = 'running'),
                               'failed', COUNT(*) FILTER (WHERE runs.status = 'failed')
                           )
                           FROM agent_runs runs
                           WHERE runs.workload_id = workloads.id
                       ), '{}'::jsonb) AS run_summary
                FROM agent_workloads workloads
                ORDER BY workloads.updated_at DESC
                LIMIT $1
            `,
            [limit],
        );

        return result.rows.map((row) => this.mapWorkload(row));
    }

    async listRunsForWorkload(workloadId, ownerId, limit = 50) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT runs.*
                FROM agent_runs runs
                INNER JOIN agent_workloads workloads
                    ON workloads.id = runs.workload_id
                WHERE runs.workload_id = $1
                  AND workloads.owner_id = $2
                ORDER BY runs.created_at DESC
                LIMIT $3
            `,
            [workloadId, ownerId, limit],
        );

        return result.rows.map((row) => this.mapRun(row));
    }

    async getRunById(id, ownerId = null) {
        await this.ensureAvailable();
        const result = ownerId
            ? await postgres.query(
                `
                    SELECT runs.*
                    FROM agent_runs runs
                    INNER JOIN agent_workloads workloads
                        ON workloads.id = runs.workload_id
                    WHERE runs.id = $1
                      AND workloads.owner_id = $2
                    LIMIT 1
                `,
                [id, ownerId],
            )
            : await postgres.query(
                `
                    SELECT *
                    FROM agent_runs
                    WHERE id = $1
                    LIMIT 1
                `,
                [id],
            );

        return this.mapRun(result.rows[0]);
    }

    async getRunByIdempotencyKey(idempotencyKey = '') {
        await this.ensureAvailable();
        const normalizedKey = String(idempotencyKey || '').trim();
        if (!normalizedKey) {
            return null;
        }

        const result = await postgres.query(
            `
                SELECT *
                FROM agent_runs
                WHERE idempotency_key = $1
                LIMIT 1
            `,
            [normalizedKey],
        );

        return this.mapRun(result.rows[0]);
    }

    async listAdminRuns(limit = 100) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT runs.*
                FROM agent_runs runs
                ORDER BY runs.created_at DESC
                LIMIT $1
            `,
            [limit],
        );

        return result.rows.map((row) => this.mapRun(row));
    }

    async enqueueRun({
        workloadId,
        ownerId,
        sessionId,
        reason = 'manual',
        scheduledFor = new Date(),
        parentRunId = null,
        stageIndex = 0,
        attempt = 0,
        idempotencyKey = null,
        prompt = '',
        metadata = {},
    }) {
        await this.ensureAvailable();

        const id = randomUUID();
        try {
            const result = await postgres.query(
                `
                    INSERT INTO agent_runs (
                        id,
                        workload_id,
                        owner_id,
                        session_id,
                        status,
                        reason,
                        scheduled_for,
                        parent_run_id,
                        stage_index,
                        attempt,
                        idempotency_key,
                        prompt,
                        metadata
                    )
                    VALUES (
                        $1, $2, $3, $4,
                        '${RUN_STATUS.QUEUED}',
                        $5, $6, $7, $8, $9, $10, $11, $12::jsonb
                    )
                    ON CONFLICT DO NOTHING
                    RETURNING *
                `,
                [
                    id,
                    workloadId,
                    ownerId,
                    sessionId,
                    reason,
                    normalizeDate(scheduledFor),
                    parentRunId,
                    stageIndex,
                    attempt,
                    idempotencyKey,
                    prompt,
                    JSON.stringify(metadata || {}),
                ],
            );

            const createdRun = this.mapRun(result.rows[0]);
            if (createdRun) {
                return createdRun;
            }

            if (idempotencyKey) {
                return this.getRunByIdempotencyKey(idempotencyKey);
            }

            return null;
        } catch (error) {
            throw this.normalizePersistenceError(error, 'enqueue workload run');
        }
    }

    async claimDueRuns({ workerId, limit = 5, leaseMs = 10 * 60 * 1000 }) {
        await this.ensureAvailable();
        const pool = postgres.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const selected = await client.query(
                `
                    SELECT runs.*, to_jsonb(workloads.*) AS workload
                    FROM agent_runs runs
                    INNER JOIN agent_workloads workloads
                        ON workloads.id = runs.workload_id
                    WHERE workloads.enabled = TRUE
                      AND (
                          (runs.status = '${RUN_STATUS.QUEUED}' AND runs.scheduled_for <= NOW())
                          OR (runs.status = '${RUN_STATUS.RUNNING}' AND runs.claim_expires_at IS NOT NULL AND runs.claim_expires_at < NOW())
                      )
                    ORDER BY runs.scheduled_for ASC, runs.created_at ASC
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED
                `,
                [limit],
            );

            const claimed = [];
            for (const row of selected.rows) {
                const updated = await client.query(
                    `
                        UPDATE agent_runs
                        SET status = '${RUN_STATUS.RUNNING}',
                            claim_owner = $2,
                            claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
                            started_at = COALESCE(started_at, NOW()),
                            updated_at = NOW()
                        WHERE id = $1
                        RETURNING *
                    `,
                    [row.id, workerId, leaseMs],
                );

                claimed.push(this.mapRun({
                    ...updated.rows[0],
                    workload: row.workload,
                }));
            }

            await client.query('COMMIT');
            return claimed;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async extendRunLease(id, workerId, leaseMs) {
        await this.ensureAvailable();
        await postgres.query(
            `
                UPDATE agent_runs
                SET claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
                    updated_at = NOW()
                WHERE id = $1
                  AND claim_owner = $2
                  AND status = '${RUN_STATUS.RUNNING}'
            `,
            [id, workerId, leaseMs],
        );
    }

    async completeRun(id, workerId, payload = {}) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                UPDATE agent_runs
                SET status = '${RUN_STATUS.COMPLETED}',
                    response_id = $3,
                    trace = $4::jsonb,
                    metadata = $5::jsonb,
                    error = '{}'::jsonb,
                    finished_at = NOW(),
                    claim_expires_at = NULL,
                    updated_at = NOW()
                WHERE id = $1
                  AND claim_owner = $2
                RETURNING *
            `,
            [
                id,
                workerId,
                payload.responseId || null,
                JSON.stringify(payload.trace || {}),
                JSON.stringify(payload.metadata || {}),
            ],
        );

        return this.mapRun(result.rows[0]);
    }

    async failRun(id, workerId, payload = {}) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                UPDATE agent_runs
                SET status = '${RUN_STATUS.FAILED}',
                    error = $3::jsonb,
                    trace = $4::jsonb,
                    metadata = $5::jsonb,
                    finished_at = NOW(),
                    claim_expires_at = NULL,
                    updated_at = NOW()
                WHERE id = $1
                  AND claim_owner = $2
                RETURNING *
            `,
            [
                id,
                workerId,
                JSON.stringify(payload.error || {}),
                JSON.stringify(payload.trace || {}),
                JSON.stringify(payload.metadata || {}),
            ],
        );

        return this.mapRun(result.rows[0]);
    }

    async cancelQueuedRunsForWorkload(workloadId) {
        await this.ensureAvailable();
        await postgres.query(
            `
                UPDATE agent_runs
                SET status = '${RUN_STATUS.CANCELLED}',
                    finished_at = NOW(),
                    updated_at = NOW()
                WHERE workload_id = $1
                  AND status IN ('${RUN_STATUS.QUEUED}', '${RUN_STATUS.RUNNING}')
            `,
            [workloadId],
        );
    }

    async cancelPendingQueuedRunsForWorkload(workloadId) {
        await this.ensureAvailable();
        await postgres.query(
            `
                UPDATE agent_runs
                SET status = '${RUN_STATUS.CANCELLED}',
                    finished_at = NOW(),
                    updated_at = NOW()
                WHERE workload_id = $1
                  AND status = '${RUN_STATUS.QUEUED}'
            `,
            [workloadId],
        );
    }

    async addRunEvent(runId, eventType, payload = {}) {
        await this.ensureAvailable();
        if (!runId) {
            return false;
        }

        try {
            const result = await postgres.query(
                `
                    INSERT INTO agent_run_events (
                        id,
                        run_id,
                        event_type,
                        payload
                    )
                    SELECT $1, $2, $3, $4::jsonb
                    WHERE EXISTS (
                        SELECT 1
                        FROM agent_runs
                        WHERE id = $2
                    )
                `,
                [
                    randomUUID(),
                    runId,
                    eventType,
                    JSON.stringify(payload || {}),
                ],
            );
            return Number(result.rowCount || 0) > 0;
        } catch (error) {
            throw this.normalizePersistenceError(error, 'record workload event');
        }
    }

    async getSessionSummaries(sessionIds = [], ownerId = null) {
        await this.ensureAvailable();
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
            return {};
        }

        const result = await postgres.query(
            `
                SELECT workloads.session_id,
                       COUNT(*) FILTER (WHERE runs.status = '${RUN_STATUS.QUEUED}') AS queued_count,
                       COUNT(*) FILTER (WHERE runs.status = '${RUN_STATUS.RUNNING}') AS running_count,
                       COUNT(*) FILTER (WHERE runs.status = '${RUN_STATUS.FAILED}') AS failed_count
                FROM agent_workloads workloads
                LEFT JOIN agent_runs runs
                    ON runs.workload_id = workloads.id
                   AND runs.status IN ('${RUN_STATUS.QUEUED}', '${RUN_STATUS.RUNNING}', '${RUN_STATUS.FAILED}')
                WHERE workloads.session_id = ANY($1)
                  ${ownerId ? 'AND workloads.owner_id = $2' : ''}
                GROUP BY workloads.session_id
            `,
            ownerId ? [sessionIds, ownerId] : [sessionIds],
        );

        return Object.fromEntries(result.rows.map((row) => [
            row.session_id,
            {
                queued: Number(row.queued_count || 0),
                running: Number(row.running_count || 0),
                failed: Number(row.failed_count || 0),
            },
        ]));
    }

    normalizePersistenceError(error, action = 'persist workload data') {
        if (!error) {
            return new Error(`Failed to ${action}`);
        }

        if (error.statusCode || error.type === 'validation') {
            return error;
        }

        const pgCode = String(error.code || '').trim();
        const constraint = String(error.constraint || '').trim();
        const detail = String(error.detail || '').trim();

        if (pgCode === '23505' && constraint === 'idx_agent_workloads_callable_slug') {
            const conflict = new Error('That callable slug is already in use. Pick a different slug.');
            conflict.statusCode = 409;
            return conflict;
        }

        if (pgCode === '23503' && (
            constraint === 'agent_workloads_session_id_fkey'
            || constraint === 'agent_runs_session_id_fkey'
        )) {
            const sessionMismatch = new Error('Deferred workloads need a Postgres-backed conversation session. Start a fresh conversation and try again.');
            sessionMismatch.statusCode = 503;
            return sessionMismatch;
        }

        if (pgCode === '42P01') {
            const relationMissing = new Error('Deferred workload tables are not ready yet. Restart the server so Postgres migrations can complete.');
            relationMissing.statusCode = 503;
            return relationMissing;
        }

        console.error(`[Workloads] Failed to ${action}:`, error.message, detail || '');
        const wrapped = new Error(`Failed to ${action}`);
        wrapped.statusCode = 500;
        wrapped.cause = error;
        return wrapped;
    }
}

function serializeDate(value) {
    if (!value) {
        return null;
    }

    return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        const error = new Error('Invalid scheduled run time');
        error.statusCode = 400;
        throw error;
    }
    return date.toISOString();
}

const workloadStore = new WorkloadStore();

module.exports = {
    RUN_STATUS,
    WorkloadStore,
    workloadStore,
};

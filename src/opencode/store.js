'use strict';

const { randomUUID } = require('crypto');
const { postgres } = require('../postgres');

const RUN_STATUS = Object.freeze({
    QUEUED: 'queued',
    STARTING: 'starting',
    RUNNING: 'running',
    WAITING_PERMISSION: 'waiting_permission',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

class OpenCodeStore {
    isAvailable() {
        return Boolean(postgres.enabled);
    }

    async ensureAvailable() {
        if (!this.isAvailable()) {
            const error = new Error('OpenCode runs require Postgres persistence');
            error.statusCode = 503;
            throw error;
        }
    }

    mapBinding(row = {}) {
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            ownerId: row.owner_id,
            sessionId: row.session_id,
            target: row.target,
            workspacePath: row.workspace_path,
            opencodeSessionId: row.opencode_session_id,
            metadata: row.metadata || {},
            createdAt: serializeDate(row.created_at),
            updatedAt: serializeDate(row.updated_at),
        };
    }

    mapRun(row = {}) {
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            ownerId: row.owner_id,
            sessionId: row.session_id || null,
            opencodeSessionId: row.opencode_session_id || null,
            target: row.target,
            workspacePath: row.workspace_path,
            prompt: row.prompt,
            agent: row.agent,
            model: row.model || null,
            approvalMode: row.approval_mode || 'manual',
            async: row.async === true,
            status: row.status,
            summary: row.summary || '',
            diff: row.diff || [],
            error: row.error || {},
            metadata: row.metadata || {},
            createdAt: serializeDate(row.created_at),
            startedAt: serializeDate(row.started_at),
            finishedAt: serializeDate(row.finished_at),
            updatedAt: serializeDate(row.updated_at),
        };
    }

    mapEvent(row = {}) {
        if (!row) {
            return null;
        }

        return {
            id: String(row.id),
            runId: row.run_id,
            eventType: row.event_type,
            payload: row.payload || {},
            createdAt: serializeDate(row.created_at),
        };
    }

    async upsertSessionBinding({
        ownerId,
        sessionId = null,
        target,
        workspacePath,
        opencodeSessionId,
        metadata = {},
    }) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                INSERT INTO opencode_session_bindings (
                    id,
                    owner_id,
                    session_id,
                    target,
                    workspace_path,
                    opencode_session_id,
                    metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                ON CONFLICT (owner_id, session_id, target, workspace_path)
                DO UPDATE
                SET opencode_session_id = EXCLUDED.opencode_session_id,
                    metadata = EXCLUDED.metadata,
                    updated_at = NOW()
                RETURNING *
            `,
            [
                randomUUID(),
                ownerId,
                sessionId,
                target,
                workspacePath,
                opencodeSessionId,
                JSON.stringify(metadata || {}),
            ],
        );

        return this.mapBinding(result.rows[0]);
    }

    async getSessionBinding({
        ownerId,
        sessionId = null,
        target,
        workspacePath,
        opencodeSessionId = '',
    }) {
        await this.ensureAvailable();

        if (opencodeSessionId) {
            const result = await postgres.query(
                `
                    SELECT *
                    FROM opencode_session_bindings
                    WHERE owner_id = $1
                      AND opencode_session_id = $2
                    LIMIT 1
                `,
                [ownerId, opencodeSessionId],
            );
            return this.mapBinding(result.rows[0]);
        }

        const result = await postgres.query(
            `
                SELECT *
                FROM opencode_session_bindings
                WHERE owner_id = $1
                  AND session_id ${sessionId ? '= $2' : 'IS NULL'}
                  AND target = $${sessionId ? '3' : '2'}
                  AND workspace_path = $${sessionId ? '4' : '3'}
                LIMIT 1
            `,
            sessionId
                ? [ownerId, sessionId, target, workspacePath]
                : [ownerId, target, workspacePath],
        );

        return this.mapBinding(result.rows[0]);
    }

    async createRun(input = {}) {
        await this.ensureAvailable();

        const result = await postgres.query(
            `
                INSERT INTO opencode_runs (
                    id,
                    owner_id,
                    session_id,
                    opencode_session_id,
                    target,
                    workspace_path,
                    prompt,
                    agent,
                    model,
                    approval_mode,
                    async,
                    status,
                    metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
                RETURNING *
            `,
            [
                input.id || randomUUID(),
                input.ownerId,
                input.sessionId || null,
                input.opencodeSessionId || null,
                input.target,
                input.workspacePath,
                input.prompt,
                input.agent || 'build',
                input.model || null,
                input.approvalMode || 'manual',
                input.async === true,
                input.status || RUN_STATUS.QUEUED,
                JSON.stringify(input.metadata || {}),
            ],
        );

        return this.mapRun(result.rows[0]);
    }

    async updateRun(id, updates = {}) {
        await this.ensureAvailable();
        const current = await this.getRunById(id);
        if (!current) {
            return null;
        }

        const status = updates.status || current.status;
        const startedAt = Object.prototype.hasOwnProperty.call(updates, 'startedAt')
            ? normalizeNullableDate(updates.startedAt)
            : current.startedAt;
        const finishedAt = Object.prototype.hasOwnProperty.call(updates, 'finishedAt')
            ? normalizeNullableDate(updates.finishedAt)
            : current.finishedAt;

        const result = await postgres.query(
            `
                UPDATE opencode_runs
                SET opencode_session_id = $2,
                    status = $3,
                    summary = $4,
                    diff = $5::jsonb,
                    error = $6::jsonb,
                    metadata = $7::jsonb,
                    started_at = $8,
                    finished_at = $9,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `,
            [
                id,
                updates.opencodeSessionId ?? current.opencodeSessionId,
                status,
                updates.summary ?? current.summary,
                JSON.stringify(updates.diff ?? current.diff ?? []),
                JSON.stringify(updates.error ?? current.error ?? {}),
                JSON.stringify(updates.metadata ?? current.metadata ?? {}),
                startedAt,
                finishedAt,
            ],
        );

        return this.mapRun(result.rows[0]);
    }

    async getRunById(id, ownerId = null) {
        await this.ensureAvailable();
        const result = ownerId
            ? await postgres.query(
                `
                    SELECT *
                    FROM opencode_runs
                    WHERE id = $1
                      AND owner_id = $2
                    LIMIT 1
                `,
                [id, ownerId],
            )
            : await postgres.query(
                `
                    SELECT *
                    FROM opencode_runs
                    WHERE id = $1
                    LIMIT 1
                `,
                [id],
            );

        return this.mapRun(result.rows[0]);
    }

    async addRunEvent(runId, eventType, payload = {}) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                INSERT INTO opencode_run_events (
                    run_id,
                    event_type,
                    payload
                )
                VALUES ($1, $2, $3::jsonb)
                RETURNING *
            `,
            [
                runId,
                eventType,
                JSON.stringify(payload || {}),
            ],
        );

        return this.mapEvent(result.rows[0]);
    }

    async listRunEvents(runId, { afterId = null, limit = 200 } = {}) {
        await this.ensureAvailable();
        const normalizedLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
        const result = afterId
            ? await postgres.query(
                `
                    SELECT *
                    FROM opencode_run_events
                    WHERE run_id = $1
                      AND id > $2::bigint
                    ORDER BY id ASC
                    LIMIT $3
                `,
                [runId, afterId, normalizedLimit],
            )
            : await postgres.query(
                `
                    SELECT *
                    FROM opencode_run_events
                    WHERE run_id = $1
                    ORDER BY id ASC
                    LIMIT $2
                `,
                [runId, normalizedLimit],
            );

        return result.rows.map((row) => this.mapEvent(row));
    }
}

function serializeDate(value) {
    if (!value) {
        return null;
    }

    return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeNullableDate(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toISOString();
}

const opencodeStore = new OpenCodeStore();

module.exports = {
    RUN_STATUS,
    OpenCodeStore,
    opencodeStore,
};

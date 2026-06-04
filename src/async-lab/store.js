'use strict';

const { randomUUID } = require('crypto');
const { postgres } = require('../postgres');
const { normalizeCursor, normalizeText } = require('./valkey-live-bus');

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function normalizeRun(input = {}) {
    const now = new Date().toISOString();
    return {
        id: normalizeText(input.id) || `async-run-${randomUUID()}`,
        ownerId: normalizeText(input.ownerId),
        sessionId: normalizeText(input.sessionId),
        runtimeSurface: normalizeText(input.runtimeSurface) || 'async-lab',
        mode: normalizeText(input.mode) || 'lab',
        adapter: normalizeText(input.adapter) || 'dry-run',
        status: normalizeText(input.status) || 'queued',
        targetKey: normalizeText(input.targetKey) || 'lab/default',
        idempotencyKey: normalizeText(input.idempotencyKey),
        task: normalizeText(input.task),
        liveRemoteRequested: input.liveRemoteRequested === true,
        liveRemoteAllowed: input.liveRemoteAllowed === true,
        cancelRequested: input.cancelRequested === true,
        claimOwner: normalizeText(input.claimOwner),
        claimExpiresAt: normalizeText(input.claimExpiresAt),
        attempt: Math.max(0, Number(input.attempt) || 0),
        metadata: input.metadata && typeof input.metadata === 'object' ? cloneJson(input.metadata) : {},
        createdAt: normalizeText(input.createdAt) || now,
        updatedAt: normalizeText(input.updatedAt) || now,
        startedAt: normalizeText(input.startedAt),
        completedAt: normalizeText(input.completedAt),
        cancelledAt: normalizeText(input.cancelledAt),
    };
}

function normalizeEvent(input = {}, cursor = 0) {
    const now = new Date().toISOString();
    return {
        eventId: normalizeText(input.eventId) || `async-event-${randomUUID()}`,
        runId: normalizeText(input.runId),
        cursor: normalizeCursor(cursor || input.cursor),
        type: normalizeText(input.type) || 'status',
        source: normalizeText(input.source) || 'async-lab',
        status: normalizeText(input.status),
        timestamp: normalizeText(input.timestamp) || now,
        payload: input.payload && typeof input.payload === 'object' ? cloneJson(input.payload) : {},
    };
}

class AsyncLabStore {
    constructor(options = {}) {
        this.postgres = options.postgres || postgres;
        this.persistToPostgres = options.persistToPostgres !== false;
        this.usePostgres = false;
        this.initialized = false;
        this.runs = new Map();
        this.events = new Map();
    }

    async initialize() {
        if (this.initialized) {
            return this.usePostgres;
        }
        this.initialized = true;
        this.usePostgres = Boolean(this.persistToPostgres && this.postgres?.enabled);
        if (!this.usePostgres) {
            return false;
        }

        try {
            await this.postgres.query(`
                CREATE TABLE IF NOT EXISTS async_runtime_runs (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT,
                    session_id TEXT,
                    runtime_surface TEXT NOT NULL DEFAULT 'async-lab',
                    mode TEXT NOT NULL DEFAULT 'lab',
                    adapter TEXT NOT NULL DEFAULT 'dry-run',
                    status TEXT NOT NULL DEFAULT 'queued',
                    target_key TEXT NOT NULL DEFAULT 'lab/default',
                    idempotency_key TEXT,
                    task TEXT NOT NULL DEFAULT '',
                    live_remote_requested BOOLEAN NOT NULL DEFAULT false,
                    live_remote_allowed BOOLEAN NOT NULL DEFAULT false,
                    cancel_requested BOOLEAN NOT NULL DEFAULT false,
                    event_cursor INTEGER NOT NULL DEFAULT 0,
                    claim_owner TEXT,
                    claim_expires_at TIMESTAMPTZ,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    started_at TIMESTAMPTZ,
                    completed_at TIMESTAMPTZ,
                    cancelled_at TIMESTAMPTZ
                )
            `);
            await this.postgres.query(`
                ALTER TABLE async_runtime_runs
                ADD COLUMN IF NOT EXISTS event_cursor INTEGER NOT NULL DEFAULT 0
            `);
            await this.postgres.query(`
                ALTER TABLE async_runtime_runs
                ADD COLUMN IF NOT EXISTS claim_owner TEXT
            `);
            await this.postgres.query(`
                ALTER TABLE async_runtime_runs
                ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ
            `);
            await this.postgres.query(`
                ALTER TABLE async_runtime_runs
                ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0
            `);
            await this.postgres.query(`
                CREATE INDEX IF NOT EXISTS async_runtime_runs_surface_status_idx
                ON async_runtime_runs(runtime_surface, status, updated_at DESC)
            `);
            await this.postgres.query(`
                CREATE INDEX IF NOT EXISTS async_runtime_runs_claim_idx
                ON async_runtime_runs(runtime_surface, status, claim_expires_at, updated_at ASC)
            `);
            await this.postgres.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS async_runtime_runs_idempotency_idx
                ON async_runtime_runs(runtime_surface, idempotency_key)
                WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''
            `);
            await this.postgres.query(`
                CREATE TABLE IF NOT EXISTS async_runtime_events (
                    event_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES async_runtime_runs(id) ON DELETE CASCADE,
                    cursor INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'async-lab',
                    status TEXT,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(run_id, cursor)
                )
            `);
            await this.postgres.query(`
                CREATE INDEX IF NOT EXISTS async_runtime_events_run_cursor_idx
                ON async_runtime_events(run_id, cursor)
            `);
            return true;
        } catch (error) {
            console.warn(`[AsyncLabStore] Postgres unavailable; falling back to memory: ${error.message}`);
            this.usePostgres = false;
            return false;
        }
    }

    async createRun(input = {}) {
        await this.initialize();
        const run = normalizeRun(input);

        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    INSERT INTO async_runtime_runs (
                        id, owner_id, session_id, runtime_surface, mode, adapter, status,
                        target_key, idempotency_key, task, live_remote_requested,
                        live_remote_allowed, cancel_requested, metadata, created_at, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), $10, $11, $12, $13, $14::jsonb, $15, $16)
                    RETURNING *
                `,
                [
                    run.id,
                    run.ownerId || null,
                    run.sessionId || null,
                    run.runtimeSurface,
                    run.mode,
                    run.adapter,
                    run.status,
                    run.targetKey,
                    run.idempotencyKey,
                    run.task,
                    run.liveRemoteRequested,
                    run.liveRemoteAllowed,
                    run.cancelRequested,
                    JSON.stringify(run.metadata || {}),
                    run.createdAt,
                    run.updatedAt,
                ],
            );
            return this.rowToRun(result.rows[0]);
        }

        this.runs.set(run.id, run);
        return { ...run };
    }

    async getRun(runId = '') {
        await this.initialize();
        const id = normalizeText(runId);
        if (!id) {
            return null;
        }

        if (this.usePostgres) {
            const result = await this.postgres.query('SELECT * FROM async_runtime_runs WHERE id = $1', [id]);
            return result.rows[0] ? this.rowToRun(result.rows[0]) : null;
        }

        const run = this.runs.get(id);
        return run ? { ...run, metadata: cloneJson(run.metadata) } : null;
    }

    async getRunByIdempotency(runtimeSurface = 'async-lab', idempotencyKey = '') {
        await this.initialize();
        const key = normalizeText(idempotencyKey);
        if (!key) {
            return null;
        }

        if (this.usePostgres) {
            const result = await this.postgres.query(
                'SELECT * FROM async_runtime_runs WHERE runtime_surface = $1 AND idempotency_key = $2 ORDER BY created_at DESC LIMIT 1',
                [normalizeText(runtimeSurface) || 'async-lab', key],
            );
            return result.rows[0] ? this.rowToRun(result.rows[0]) : null;
        }

        return Array.from(this.runs.values()).find((run) => (
            run.runtimeSurface === runtimeSurface && run.idempotencyKey === key
        )) || null;
    }

    async updateRun(runId = '', patch = {}) {
        await this.initialize();
        const id = normalizeText(runId);
        const current = await this.getRun(id);
        if (!current) {
            return null;
        }
        const next = normalizeRun({
            ...current,
            ...patch,
            metadata: {
                ...(current.metadata || {}),
                ...(patch.metadata || {}),
            },
            updatedAt: new Date().toISOString(),
        });

        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    UPDATE async_runtime_runs
                    SET status = $2,
                        adapter = $3,
                        target_key = $4,
                        live_remote_requested = $5,
                        live_remote_allowed = $6,
                        cancel_requested = $7,
                        metadata = $8::jsonb,
                        updated_at = $9,
                        started_at = COALESCE($10::timestamptz, started_at),
                        completed_at = COALESCE($11::timestamptz, completed_at),
                        cancelled_at = COALESCE($12::timestamptz, cancelled_at),
                        claim_owner = $13,
                        claim_expires_at = $14::timestamptz,
                        attempt = $15
                    WHERE id = $1
                    RETURNING *
                `,
                [
                    id,
                    next.status,
                    next.adapter,
                    next.targetKey,
                    next.liveRemoteRequested,
                    next.liveRemoteAllowed,
                    next.cancelRequested,
                    JSON.stringify(next.metadata || {}),
                    next.updatedAt,
                    next.startedAt || null,
                    next.completedAt || null,
                    next.cancelledAt || null,
                    next.claimOwner || null,
                    next.claimExpiresAt || null,
                    next.attempt,
                ],
            );
            return result.rows[0] ? this.rowToRun(result.rows[0]) : null;
        }

        this.runs.set(id, next);
        return { ...next, metadata: cloneJson(next.metadata) };
    }

    async claimRun(runId = '', owner = '', ttlMs = 120000) {
        await this.initialize();
        const id = normalizeText(runId);
        const claimOwner = normalizeText(owner);
        const claimExpiresAt = new Date(Date.now() + Math.max(1000, Number(ttlMs) || 120000)).toISOString();
        if (!id || !claimOwner) {
            return null;
        }

        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    UPDATE async_runtime_runs
                    SET claim_owner = $2,
                        claim_expires_at = $3::timestamptz,
                        attempt = attempt + 1,
                        updated_at = NOW()
                    WHERE id = $1
                      AND status NOT IN ('completed', 'cancelled', 'failed')
                      AND (
                        claim_owner IS NULL
                        OR claim_expires_at IS NULL
                        OR claim_expires_at <= NOW()
                        OR claim_owner = $2
                      )
                    RETURNING *
                `,
                [id, claimOwner, claimExpiresAt],
            );
            return result.rows[0] ? this.rowToRun(result.rows[0]) : null;
        }

        const current = this.runs.get(id);
        if (!current || ['completed', 'cancelled', 'failed'].includes(current.status)) {
            return null;
        }
        const existingExpiry = current.claimExpiresAt ? new Date(current.claimExpiresAt).getTime() : 0;
        if (current.claimOwner && current.claimOwner !== claimOwner && existingExpiry > Date.now()) {
            return null;
        }
        const next = normalizeRun({
            ...current,
            claimOwner,
            claimExpiresAt,
            attempt: (Number(current.attempt) || 0) + 1,
            updatedAt: new Date().toISOString(),
        });
        this.runs.set(id, next);
        return { ...next, metadata: cloneJson(next.metadata) };
    }

    async refreshClaim(runId = '', owner = '', ttlMs = 120000) {
        await this.initialize();
        const id = normalizeText(runId);
        const claimOwner = normalizeText(owner);
        const claimExpiresAt = new Date(Date.now() + Math.max(1000, Number(ttlMs) || 120000)).toISOString();
        if (!id || !claimOwner) {
            return null;
        }

        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    UPDATE async_runtime_runs
                    SET claim_expires_at = $3::timestamptz,
                        updated_at = NOW()
                    WHERE id = $1
                      AND claim_owner = $2
                      AND status NOT IN ('completed', 'cancelled', 'failed')
                    RETURNING *
                `,
                [id, claimOwner, claimExpiresAt],
            );
            return result.rows[0] ? this.rowToRun(result.rows[0]) : null;
        }

        const current = this.runs.get(id);
        if (!current || current.claimOwner !== claimOwner || ['completed', 'cancelled', 'failed'].includes(current.status)) {
            return null;
        }
        const next = normalizeRun({
            ...current,
            claimExpiresAt,
            updatedAt: new Date().toISOString(),
        });
        this.runs.set(id, next);
        return { ...next, metadata: cloneJson(next.metadata) };
    }

    async releaseClaim(runId = '', owner = '') {
        await this.initialize();
        const id = normalizeText(runId);
        const claimOwner = normalizeText(owner);
        if (!id || !claimOwner) {
            return null;
        }

        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    UPDATE async_runtime_runs
                    SET claim_owner = NULL,
                        claim_expires_at = NULL,
                        updated_at = NOW()
                    WHERE id = $1 AND claim_owner = $2
                    RETURNING *
                `,
                [id, claimOwner],
            );
            return result.rows[0] ? this.rowToRun(result.rows[0]) : null;
        }

        const current = this.runs.get(id);
        if (!current || current.claimOwner !== claimOwner) {
            return null;
        }
        const next = normalizeRun({
            ...current,
            claimOwner: '',
            claimExpiresAt: '',
            updatedAt: new Date().toISOString(),
        });
        this.runs.set(id, next);
        return { ...next, metadata: cloneJson(next.metadata) };
    }

    async listRunnableRuns(runtimeSurface = 'async-lab', limit = 25) {
        await this.initialize();
        const surface = normalizeText(runtimeSurface) || 'async-lab';
        const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 25));

        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    SELECT *
                    FROM async_runtime_runs
                    WHERE runtime_surface = $1
                      AND status NOT IN ('completed', 'cancelled', 'failed')
                      AND (
                        status = 'queued'
                        OR claim_owner IS NULL
                        OR claim_expires_at IS NULL
                        OR claim_expires_at <= NOW()
                      )
                    ORDER BY created_at ASC
                    LIMIT $2
                `,
                [surface, normalizedLimit],
            );
            return result.rows.map((row) => this.rowToRun(row));
        }

        const now = Date.now();
        return Array.from(this.runs.values())
            .filter((run) => (
                run.runtimeSurface === surface
                && !['completed', 'cancelled', 'failed'].includes(run.status)
                && (
                    run.status === 'queued'
                    || !run.claimOwner
                    || !run.claimExpiresAt
                    || new Date(run.claimExpiresAt).getTime() <= now
                )
            ))
            .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
            .slice(0, normalizedLimit)
            .map((run) => ({ ...run, metadata: cloneJson(run.metadata) }));
    }

    async listRuns(runtimeSurface = 'async-lab', ownerId = '', limit = 50) {
        await this.initialize();
        const surface = normalizeText(runtimeSurface) || 'async-lab';
        const owner = normalizeText(ownerId);
        const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 50));

        if (this.usePostgres) {
            const params = [surface, normalizedLimit];
            const ownerFilter = owner ? 'AND owner_id = $3' : '';
            if (owner) {
                params.push(owner);
            }
            const result = await this.postgres.query(
                `
                    SELECT *
                    FROM async_runtime_runs
                    WHERE runtime_surface = $1
                    ${ownerFilter}
                    ORDER BY created_at DESC
                    LIMIT $2
                `,
                params,
            );
            return result.rows.map((row) => this.rowToRun(row));
        }

        return Array.from(this.runs.values())
            .filter((run) => run.runtimeSurface === surface && (!owner || !run.ownerId || run.ownerId === owner))
            .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
            .slice(0, normalizedLimit)
            .map((run) => ({ ...run, metadata: cloneJson(run.metadata) }));
    }

    async appendEvent(runId = '', input = {}) {
        await this.initialize();
        const id = normalizeText(runId);
        if (!id) {
            return null;
        }

        const cursor = await this.nextCursor(id);
        const event = normalizeEvent({
            ...input,
            runId: id,
        }, cursor);

        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    INSERT INTO async_runtime_events (event_id, run_id, cursor, type, source, status, payload, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
                    RETURNING *
                `,
                [
                    event.eventId,
                    id,
                    event.cursor,
                    event.type,
                    event.source,
                    event.status || null,
                    JSON.stringify(event.payload || {}),
                    event.timestamp,
                ],
            );
            return this.rowToEvent(result.rows[0]);
        }

        const events = this.events.get(id) || [];
        events.push(event);
        this.events.set(id, events);
        return { ...event, payload: cloneJson(event.payload) };
    }

    async nextCursor(runId = '') {
        const id = normalizeText(runId);
        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    UPDATE async_runtime_runs
                    SET event_cursor = event_cursor + 1,
                        updated_at = NOW()
                    WHERE id = $1
                    RETURNING event_cursor AS next_cursor
                `,
                [id],
            );
            return Number(result.rows[0]?.next_cursor || 1);
        }

        return (this.events.get(id) || []).length + 1;
    }

    async listEvents(runId = '', afterCursor = 0) {
        await this.initialize();
        const id = normalizeText(runId);
        const after = normalizeCursor(afterCursor);
        if (!id) {
            return [];
        }

        if (this.usePostgres) {
            const result = await this.postgres.query(
                `
                    SELECT *
                    FROM async_runtime_events
                    WHERE run_id = $1 AND cursor > $2
                    ORDER BY cursor ASC
                `,
                [id, after],
            );
            return result.rows.map((row) => this.rowToEvent(row));
        }

        return (this.events.get(id) || [])
            .filter((event) => normalizeCursor(event.cursor) > after)
            .map((event) => ({ ...event, payload: cloneJson(event.payload) }));
    }

    rowToRun(row = {}) {
        if (!row) {
            return null;
        }
        return normalizeRun({
            id: row.id,
            ownerId: row.owner_id,
            sessionId: row.session_id,
            runtimeSurface: row.runtime_surface,
            mode: row.mode,
            adapter: row.adapter,
            status: row.status,
            targetKey: row.target_key,
            idempotencyKey: row.idempotency_key,
            task: row.task,
            liveRemoteRequested: row.live_remote_requested,
            liveRemoteAllowed: row.live_remote_allowed,
            cancelRequested: row.cancel_requested,
            claimOwner: row.claim_owner,
            claimExpiresAt: row.claim_expires_at instanceof Date ? row.claim_expires_at.toISOString() : row.claim_expires_at,
            attempt: row.attempt,
            metadata: row.metadata || {},
            createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
            updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
            startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
            completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
            cancelledAt: row.cancelled_at instanceof Date ? row.cancelled_at.toISOString() : row.cancelled_at,
        });
    }

    rowToEvent(row = {}) {
        if (!row) {
            return null;
        }
        return normalizeEvent({
            eventId: row.event_id,
            runId: row.run_id,
            cursor: row.cursor,
            type: row.type,
            source: row.source,
            status: row.status,
            payload: row.payload || {},
            timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        }, row.cursor);
    }
}

module.exports = {
    AsyncLabStore,
    normalizeEvent,
    normalizeRun,
};

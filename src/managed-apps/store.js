'use strict';

const { randomUUID } = require('crypto');
const { postgres } = require('../postgres');

function serializeDate(value = null) {
    if (!value) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

class ManagedAppStore {
    isAvailable() {
        return Boolean(postgres.enabled);
    }

    async ensureAvailable() {
        if (!this.isAvailable()) {
            const error = new Error('Managed apps require Postgres persistence');
            error.statusCode = 503;
            throw error;
        }
    }

    mapApp(row = {}) {
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            ownerId: row.owner_id,
            sessionId: row.session_id || null,
            slug: row.slug,
            appName: row.app_name,
            repoOwner: row.repo_owner,
            repoName: row.repo_name,
            repoUrl: row.repo_url,
            repoCloneUrl: row.repo_clone_url || '',
            repoSshUrl: row.repo_ssh_url || '',
            defaultBranch: row.default_branch || 'main',
            imageRepo: row.image_repo,
            namespace: row.namespace,
            publicHost: row.public_host,
            status: row.status || 'draft',
            sourcePrompt: row.source_prompt || '',
            metadata: row.metadata || {},
            createdAt: serializeDate(row.created_at),
            updatedAt: serializeDate(row.updated_at),
            latestBuildRun: row.latest_build_run || null,
        };
    }

    mapBuildRun(row = null) {
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            appId: row.app_id,
            ownerId: row.owner_id,
            sessionId: row.session_id || null,
            source: row.source || 'manual',
            requestedAction: row.requested_action || 'build',
            commitSha: row.commit_sha || '',
            imageTag: row.image_tag || '',
            imageDigest: row.image_digest || '',
            buildStatus: row.build_status || 'queued',
            deployRequested: row.deploy_requested === true,
            deployStatus: row.deploy_status || 'not_requested',
            verificationStatus: row.verification_status || 'pending',
            externalRunId: row.external_run_id || null,
            externalRunUrl: row.external_run_url || '',
            error: row.error || {},
            metadata: row.metadata || {},
            startedAt: serializeDate(row.started_at),
            finishedAt: serializeDate(row.finished_at),
            createdAt: serializeDate(row.created_at),
            updatedAt: serializeDate(row.updated_at),
        };
    }

    async createApp(input = {}) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                INSERT INTO managed_apps (
                    id,
                    owner_id,
                    session_id,
                    slug,
                    app_name,
                    repo_owner,
                    repo_name,
                    repo_url,
                    repo_clone_url,
                    repo_ssh_url,
                    default_branch,
                    image_repo,
                    namespace,
                    public_host,
                    status,
                    source_prompt,
                    metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
                RETURNING *
            `,
            [
                input.id || randomUUID(),
                input.ownerId,
                input.sessionId || null,
                input.slug,
                input.appName,
                input.repoOwner,
                input.repoName,
                input.repoUrl,
                input.repoCloneUrl || '',
                input.repoSshUrl || '',
                input.defaultBranch || 'main',
                input.imageRepo,
                input.namespace,
                input.publicHost,
                input.status || 'draft',
                input.sourcePrompt || '',
                JSON.stringify(input.metadata || {}),
            ],
        );

        return this.mapApp(result.rows[0]);
    }

    async updateApp(id, ownerId, updates = {}) {
        await this.ensureAvailable();
        const current = await this.getAppById(id, ownerId);
        if (!current) {
            return null;
        }

        const values = [
            Object.prototype.hasOwnProperty.call(updates, 'sessionId') ? updates.sessionId : current.sessionId,
            updates.appName ?? current.appName,
            updates.repoOwner ?? current.repoOwner,
            updates.repoName ?? current.repoName,
            updates.repoUrl ?? current.repoUrl,
            updates.repoCloneUrl ?? current.repoCloneUrl,
            updates.repoSshUrl ?? current.repoSshUrl,
            updates.defaultBranch ?? current.defaultBranch,
            updates.imageRepo ?? current.imageRepo,
            updates.namespace ?? current.namespace,
            updates.publicHost ?? current.publicHost,
            updates.status ?? current.status,
            updates.sourcePrompt ?? current.sourcePrompt,
            JSON.stringify(updates.metadata ?? current.metadata ?? {}),
        ];
        const result = ownerId
            ? await postgres.query(
                `
                    UPDATE managed_apps
                    SET session_id = $3,
                        app_name = $4,
                        repo_owner = $5,
                        repo_name = $6,
                        repo_url = $7,
                        repo_clone_url = $8,
                        repo_ssh_url = $9,
                        default_branch = $10,
                        image_repo = $11,
                        namespace = $12,
                        public_host = $13,
                        status = $14,
                        source_prompt = $15,
                        metadata = $16::jsonb,
                        updated_at = NOW()
                    WHERE id = $1
                      AND owner_id = $2
                    RETURNING *
                `,
                [id, ownerId, ...values],
            )
            : await postgres.query(
                `
                    UPDATE managed_apps
                    SET session_id = $2,
                        app_name = $3,
                        repo_owner = $4,
                        repo_name = $5,
                        repo_url = $6,
                        repo_clone_url = $7,
                        repo_ssh_url = $8,
                        default_branch = $9,
                        image_repo = $10,
                        namespace = $11,
                        public_host = $12,
                        status = $13,
                        source_prompt = $14,
                        metadata = $15::jsonb,
                        updated_at = NOW()
                    WHERE id = $1
                    RETURNING *
                `,
                [id, ...values],
            );

        return this.mapApp(result.rows[0]);
    }

    async getAppById(id, ownerId = null) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT apps.*,
                       (
                           SELECT jsonb_build_object(
                               'id', runs.id,
                               'buildStatus', runs.build_status,
                               'deployStatus', runs.deploy_status,
                               'verificationStatus', runs.verification_status,
                               'imageTag', runs.image_tag,
                               'commitSha', runs.commit_sha,
                               'createdAt', runs.created_at
                           )
                           FROM managed_app_build_runs runs
                           WHERE runs.app_id = apps.id
                           ORDER BY runs.created_at DESC
                           LIMIT 1
                       ) AS latest_build_run
                FROM managed_apps apps
                WHERE apps.id = $1
                  ${ownerId ? 'AND apps.owner_id = $2' : ''}
                LIMIT 1
            `,
            ownerId ? [id, ownerId] : [id],
        );

        return this.mapApp(result.rows[0]);
    }

    async getAppBySlug(slug, ownerId = null) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT *
                FROM managed_apps
                WHERE slug = $1
                  ${ownerId ? 'AND owner_id = $2' : ''}
                LIMIT 1
            `,
            ownerId ? [slug, ownerId] : [slug],
        );
        return this.mapApp(result.rows[0]);
    }

    async getAppByRepo(repoOwner = '', repoName = '') {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT *
                FROM managed_apps
                WHERE repo_owner = $1
                  AND repo_name = $2
                LIMIT 1
            `,
            [repoOwner, repoName],
        );
        return this.mapApp(result.rows[0]);
    }

    async listApps(ownerId, limit = 50) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT *
                FROM managed_apps
                WHERE owner_id = $1
                ORDER BY updated_at DESC
                LIMIT $2
            `,
            [ownerId, Math.max(1, Math.min(Number(limit) || 50, 200))],
        );
        return result.rows.map((row) => this.mapApp(row));
    }

    async createBuildRun(input = {}) {
        await this.ensureAvailable();
        if (!String(input.appId || '').trim()) {
            const error = new Error('Managed app build runs require an appId.');
            error.statusCode = 500;
            throw error;
        }
        const result = await postgres.query(
            `
                INSERT INTO managed_app_build_runs (
                    id,
                    app_id,
                    owner_id,
                    session_id,
                    source,
                    requested_action,
                    commit_sha,
                    image_tag,
                    image_digest,
                    build_status,
                    deploy_requested,
                    deploy_status,
                    verification_status,
                    external_run_id,
                    external_run_url,
                    error,
                    metadata,
                    started_at,
                    finished_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18, $19
                )
                RETURNING *
            `,
            [
                input.id || randomUUID(),
                input.appId,
                input.ownerId,
                input.sessionId || null,
                input.source || 'manual',
                input.requestedAction || 'build',
                input.commitSha || '',
                input.imageTag || '',
                input.imageDigest || '',
                input.buildStatus || 'queued',
                input.deployRequested === true,
                input.deployStatus || 'not_requested',
                input.verificationStatus || 'pending',
                input.externalRunId || null,
                input.externalRunUrl || '',
                JSON.stringify(input.error || {}),
                JSON.stringify(input.metadata || {}),
                input.startedAt || null,
                input.finishedAt || null,
            ],
        );

        return this.mapBuildRun(result.rows[0]);
    }

    async updateBuildRun(id, updates = {}) {
        await this.ensureAvailable();
        const current = await this.getBuildRunById(id);
        if (!current) {
            return null;
        }

        const result = await postgres.query(
            `
                UPDATE managed_app_build_runs
                SET build_status = $2,
                    deploy_requested = $3,
                    deploy_status = $4,
                    verification_status = $5,
                    image_tag = $6,
                    image_digest = $7,
                    external_run_id = $8,
                    external_run_url = $9,
                    error = $10::jsonb,
                    metadata = $11::jsonb,
                    started_at = $12,
                    finished_at = $13,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `,
            [
                id,
                updates.buildStatus ?? current.buildStatus,
                updates.deployRequested ?? current.deployRequested,
                updates.deployStatus ?? current.deployStatus,
                updates.verificationStatus ?? current.verificationStatus,
                updates.imageTag ?? current.imageTag,
                updates.imageDigest ?? current.imageDigest,
                updates.externalRunId ?? current.externalRunId,
                updates.externalRunUrl ?? current.externalRunUrl,
                JSON.stringify(updates.error ?? current.error ?? {}),
                JSON.stringify(updates.metadata ?? current.metadata ?? {}),
                Object.prototype.hasOwnProperty.call(updates, 'startedAt') ? updates.startedAt : current.startedAt,
                Object.prototype.hasOwnProperty.call(updates, 'finishedAt') ? updates.finishedAt : current.finishedAt,
            ],
        );

        return this.mapBuildRun(result.rows[0]);
    }

    async getBuildRunById(id) {
        await this.ensureAvailable();
        const result = await postgres.query(
            'SELECT * FROM managed_app_build_runs WHERE id = $1 LIMIT 1',
            [id],
        );
        return this.mapBuildRun(result.rows[0]);
    }

    async getBuildRunByExternalRunId(externalRunId = '') {
        await this.ensureAvailable();
        const result = await postgres.query(
            'SELECT * FROM managed_app_build_runs WHERE external_run_id = $1 LIMIT 1',
            [externalRunId],
        );
        return this.mapBuildRun(result.rows[0]);
    }

    async getBuildRunByCommitSha(appId = '', commitSha = '') {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT *
                FROM managed_app_build_runs
                WHERE app_id = $1
                  AND commit_sha = $2
                ORDER BY created_at DESC
                LIMIT 1
            `,
            [appId, commitSha],
        );
        return this.mapBuildRun(result.rows[0]);
    }

    async listBuildRunsForApp(appId = '', ownerId = null, limit = 20) {
        await this.ensureAvailable();
        const result = await postgres.query(
            `
                SELECT runs.*
                FROM managed_app_build_runs runs
                INNER JOIN managed_apps apps
                  ON apps.id = runs.app_id
                WHERE runs.app_id = $1
                  ${ownerId ? 'AND apps.owner_id = $2' : ''}
                ORDER BY runs.created_at DESC
                LIMIT $${ownerId ? '3' : '2'}
            `,
            ownerId
                ? [appId, ownerId, Math.max(1, Math.min(Number(limit) || 20, 100))]
                : [appId, Math.max(1, Math.min(Number(limit) || 20, 100))],
        );
        return result.rows.map((row) => this.mapBuildRun(row));
    }
}

const managedAppStore = new ManagedAppStore();

module.exports = {
    ManagedAppStore,
    managedAppStore,
};

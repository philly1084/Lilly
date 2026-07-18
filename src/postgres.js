const { Pool } = require('pg');
const { config } = require('./config');

class PostgresManager {
    constructor() {
        this.pool = null;
        this.enabled = Boolean(config.postgres.url || config.postgres.password);
        this.initialized = false;
        this.unavailableReason = this.enabled ? null : 'Postgres is not configured';
        this.lastError = null;
    }

    getConnectionConfig() {
        if (config.postgres.url) {
            return {
                connectionString: config.postgres.url,
                ssl: config.postgres.ssl ? { rejectUnauthorized: false } : false,
            };
        }

        return {
            host: config.postgres.host,
            port: config.postgres.port,
            database: config.postgres.database,
            user: config.postgres.user,
            password: config.postgres.password,
            ssl: config.postgres.ssl ? { rejectUnauthorized: false } : false,
        };
    }

    getPool() {
        if (!this.enabled) {
            return null;
        }

        if (!this.pool) {
            this.pool = new Pool(this.getConnectionConfig());
            this.pool.on('error', (err) => {
                console.error('[Postgres] Pool error:', err.message);
            });
        }

        return this.pool;
    }

    isAuthOrConfigError(error = {}) {
        const code = String(error.code || '').trim();
        const message = String(error.message || '').toLowerCase();

        return [
            '28P01', // invalid_password
            '28000', // invalid_authorization_specification
            '3D000', // invalid_catalog_name
            '08004', // rejected connection
        ].includes(code)
            || /password authentication failed|no pg_hba\.conf entry|database .* does not exist|role .* does not exist|invalid authorization|authentication failed/.test(message);
    }

    sanitizeUnavailableReason(error = {}) {
        const message = String(error.message || '').trim();
        if (!message) {
            return 'Postgres persistence is unavailable';
        }
        if (/password authentication failed/i.test(message)) {
            return `Postgres password authentication failed for user "${config.postgres.user}"`;
        }
        return message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://***@');
    }

    async disable(error = null) {
        this.enabled = false;
        this.initialized = false;
        this.lastError = error || null;
        this.unavailableReason = this.sanitizeUnavailableReason(error);

        const pool = this.pool;
        this.pool = null;
        if (pool) {
            try {
                await pool.end();
            } catch (poolError) {
                console.warn('[Postgres] Failed to close disabled pool:', poolError.message);
            }
        }
    }

    getStatus() {
        return {
            enabled: this.enabled,
            initialized: this.initialized,
            unavailableReason: this.unavailableReason,
        };
    }

    async query(text, params = []) {
        const pool = this.getPool();
        if (!pool) {
            const error = new Error(this.unavailableReason || 'Postgres is not configured');
            error.statusCode = 503;
            throw error;
        }

        try {
            return await pool.query(text, params);
        } catch (error) {
            if (this.isAuthOrConfigError(error)) {
                await this.disable(error);
                const unavailable = new Error(this.unavailableReason);
                unavailable.statusCode = 503;
                unavailable.cause = error;
                throw unavailable;
            }
            throw error;
        }
    }

    async initialize() {
        if (!this.enabled) {
            return false;
        }

        try {
            await this.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

            await this.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                previous_response_id TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                message_count INTEGER NOT NULL DEFAULT 0,
                scope_key TEXT NOT NULL DEFAULT 'global',
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb
            )
        `);

        await this.query(`
            ALTER TABLE sessions
            ADD COLUMN IF NOT EXISTS scope_key TEXT NOT NULL DEFAULT 'global'
        `);

        await this.query(`
            UPDATE sessions
            SET scope_key = CASE
                WHEN COALESCE(
                    NULLIF(metadata->>'memoryScope', ''),
                    NULLIF(metadata->>'memory_scope', ''),
                    NULLIF(metadata->>'projectScope', ''),
                    NULLIF(metadata->>'project_scope', ''),
                    NULLIF(metadata->>'projectId', ''),
                    NULLIF(metadata->>'project_id', ''),
                    NULLIF(metadata->>'projectKey', ''),
                    NULLIF(metadata->>'project_key', ''),
                    NULLIF(metadata->>'workspaceId', ''),
                    NULLIF(metadata->>'workspace_id', ''),
                    NULLIF(metadata->>'workspaceKey', ''),
                    NULLIF(metadata->>'workspace_key', ''),
                    NULLIF(metadata->>'namespace', ''),
                    NULLIF(metadata->>'clientSurface', ''),
                    NULLIF(metadata->>'client_surface', ''),
                    NULLIF(metadata->>'taskType', ''),
                    NULLIF(metadata->>'task_type', ''),
                    NULLIF(metadata->>'mode', ''),
                    'global'
                ) = 'workspace-1'
                    THEN 'web-chat'
                WHEN COALESCE(
                    NULLIF(metadata->>'memoryScope', ''),
                    NULLIF(metadata->>'memory_scope', ''),
                    NULLIF(metadata->>'projectScope', ''),
                    NULLIF(metadata->>'project_scope', ''),
                    NULLIF(metadata->>'projectId', ''),
                    NULLIF(metadata->>'project_id', ''),
                    NULLIF(metadata->>'projectKey', ''),
                    NULLIF(metadata->>'project_key', ''),
                    NULLIF(metadata->>'workspaceId', ''),
                    NULLIF(metadata->>'workspace_id', ''),
                    NULLIF(metadata->>'workspaceKey', ''),
                    NULLIF(metadata->>'workspace_key', ''),
                    NULLIF(metadata->>'namespace', ''),
                    NULLIF(metadata->>'clientSurface', ''),
                    NULLIF(metadata->>'client_surface', ''),
                    NULLIF(metadata->>'taskType', ''),
                    NULLIF(metadata->>'task_type', ''),
                    NULLIF(metadata->>'mode', ''),
                    'global'
                ) ~ '^workspace-[0-9]+$'
                    THEN 'web-chat-' || COALESCE(
                        NULLIF(metadata->>'memoryScope', ''),
                        NULLIF(metadata->>'memory_scope', ''),
                        NULLIF(metadata->>'projectScope', ''),
                        NULLIF(metadata->>'project_scope', ''),
                        NULLIF(metadata->>'projectId', ''),
                        NULLIF(metadata->>'project_id', ''),
                        NULLIF(metadata->>'projectKey', ''),
                        NULLIF(metadata->>'project_key', ''),
                        NULLIF(metadata->>'workspaceId', ''),
                        NULLIF(metadata->>'workspace_id', ''),
                        NULLIF(metadata->>'workspaceKey', ''),
                        NULLIF(metadata->>'workspace_key', ''),
                        NULLIF(metadata->>'namespace', ''),
                        NULLIF(metadata->>'clientSurface', ''),
                        NULLIF(metadata->>'client_surface', ''),
                        NULLIF(metadata->>'taskType', ''),
                        NULLIF(metadata->>'task_type', ''),
                        NULLIF(metadata->>'mode', ''),
                        'global'
                    )
                ELSE COALESCE(
                    NULLIF(metadata->>'memoryScope', ''),
                    NULLIF(metadata->>'memory_scope', ''),
                    NULLIF(metadata->>'projectScope', ''),
                    NULLIF(metadata->>'project_scope', ''),
                    NULLIF(metadata->>'projectId', ''),
                    NULLIF(metadata->>'project_id', ''),
                    NULLIF(metadata->>'projectKey', ''),
                    NULLIF(metadata->>'project_key', ''),
                    NULLIF(metadata->>'workspaceId', ''),
                    NULLIF(metadata->>'workspace_id', ''),
                    NULLIF(metadata->>'workspaceKey', ''),
                    NULLIF(metadata->>'workspace_key', ''),
                    NULLIF(metadata->>'namespace', ''),
                    NULLIF(metadata->>'clientSurface', ''),
                    NULLIF(metadata->>'client_surface', ''),
                    NULLIF(metadata->>'taskType', ''),
                    NULLIF(metadata->>'task_type', ''),
                    NULLIF(metadata->>'mode', ''),
                    'global'
                )
            END
            WHERE scope_key IS NULL OR scope_key = 'global'
        `);

        await this.query(`
            CREATE TABLE IF NOT EXISTS user_session_state (
                owner_id TEXT PRIMARY KEY,
                active_session_id TEXT NULL REFERENCES sessions(id) ON DELETE SET NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query(`
            ALTER TABLE user_session_state
            ADD COLUMN IF NOT EXISTS scoped_active_session_ids JSONB NOT NULL DEFAULT '{}'::jsonb
        `);

        await this.query(`
            ALTER TABLE user_session_state
            ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb
        `);

        await this.query(`
            CREATE TABLE IF NOT EXISTS session_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query(`
            ALTER TABLE session_messages
            ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        `);

        await this.query(`
            CREATE TABLE IF NOT EXISTS session_runtime_state (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                state JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query(`
            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                parent_artifact_id TEXT NULL REFERENCES artifacts(id) ON DELETE SET NULL,
                direction TEXT NOT NULL,
                source_mode TEXT NOT NULL,
                filename TEXT NOT NULL,
                extension TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                content_bytea BYTEA NOT NULL,
                extracted_text TEXT NOT NULL DEFAULT '',
                preview_html TEXT NOT NULL DEFAULT '',
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                vectorized_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query('CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_artifacts_direction ON artifacts(direction)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_artifacts_mime_type ON artifacts(mime_type)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC)');
        await this.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_attach_handoff_unique
            ON artifacts (
                session_id,
                (metadata->>'handoffSourceArtifactId'),
                (LOWER(metadata->>'handoffSourceSha256'))
            )
            WHERE direction = 'attached'
                AND source_mode = 'artifact-attach'
                AND NULLIF(metadata->>'handoffSourceArtifactId', '') IS NOT NULL
                AND metadata->>'handoffSourceSha256' ~* '^[a-f0-9]{64}$'
        `);
        await this.query('CREATE INDEX IF NOT EXISTS idx_sessions_scope_key_updated_at ON sessions(scope_key, updated_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_sessions_scope_owner_updated_at ON sessions(scope_key, (metadata->>\'ownerId\'), updated_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_session_messages_session_id_created_at ON session_messages(session_id, created_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_session_runtime_state_updated_at ON session_runtime_state(updated_at DESC)');

        await this.query(`
            CREATE TABLE IF NOT EXISTS pii_contexts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                owner_id TEXT NULL,
                source_surface TEXT NOT NULL DEFAULT '',
                policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMPTZ NULL
            )
        `);

        await this.query(`
            CREATE TABLE IF NOT EXISTS pii_context_entries (
                id BIGSERIAL PRIMARY KEY,
                context_id TEXT NOT NULL REFERENCES pii_contexts(id) ON DELETE CASCADE,
                placeholder TEXT NOT NULL,
                pii_type TEXT NOT NULL,
                value_index_hmac TEXT NOT NULL,
                encrypted_value TEXT NOT NULL,
                iv TEXT NOT NULL,
                auth_tag TEXT NOT NULL,
                source_range JSONB NOT NULL DEFAULT '{}'::jsonb,
                occurrence_index INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query('CREATE INDEX IF NOT EXISTS idx_pii_contexts_session_id ON pii_contexts(session_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_pii_contexts_owner_id ON pii_contexts(owner_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_pii_context_entries_context_id ON pii_context_entries(context_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_pii_context_entries_placeholder ON pii_context_entries(placeholder)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_pii_context_entries_value_index ON pii_context_entries(value_index_hmac)');

        await this.query(`
            CREATE TABLE IF NOT EXISTS agent_workloads (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'chat',
                prompt TEXT NOT NULL,
                execution JSONB NOT NULL DEFAULT '{}'::jsonb,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                callable_slug TEXT NULL,
                trigger JSONB NOT NULL DEFAULT '{}'::jsonb,
                policy JSONB NOT NULL DEFAULT '{}'::jsonb,
                stages JSONB NOT NULL DEFAULT '[]'::jsonb,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query(`
            ALTER TABLE agent_workloads
            ADD COLUMN IF NOT EXISTS execution JSONB NOT NULL DEFAULT '{}'::jsonb
        `);

        await this.query(`
            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                workload_id TEXT NOT NULL REFERENCES agent_workloads(id) ON DELETE CASCADE,
                owner_id TEXT NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT 'manual',
                scheduled_for TIMESTAMPTZ NOT NULL,
                started_at TIMESTAMPTZ NULL,
                finished_at TIMESTAMPTZ NULL,
                claim_owner TEXT NULL,
                claim_expires_at TIMESTAMPTZ NULL,
                parent_run_id TEXT NULL REFERENCES agent_runs(id) ON DELETE SET NULL,
                stage_index INTEGER NOT NULL DEFAULT 0,
                attempt INTEGER NOT NULL DEFAULT 0,
                response_id TEXT NULL,
                idempotency_key TEXT NULL,
                prompt TEXT NOT NULL DEFAULT '',
                trace JSONB NOT NULL DEFAULT '{}'::jsonb,
                error JSONB NOT NULL DEFAULT '{}'::jsonb,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query(`
            CREATE TABLE IF NOT EXISTS agent_run_events (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workloads_callable_slug ON agent_workloads(callable_slug) WHERE callable_slug IS NOT NULL');
        await this.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_idempotency_key ON agent_runs(idempotency_key) WHERE idempotency_key IS NOT NULL');
        await this.query('CREATE INDEX IF NOT EXISTS idx_agent_workloads_session_id ON agent_workloads(session_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_agent_workloads_owner_id ON agent_workloads(owner_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_agent_workloads_updated_at ON agent_workloads(updated_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_agent_runs_workload_id ON agent_runs(workload_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id ON agent_runs(session_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_agent_runs_status_scheduled_for ON agent_runs(status, scheduled_for)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_agent_runs_claim_expires_at ON agent_runs(claim_expires_at)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id_created_at ON agent_run_events(run_id, created_at DESC)');

        await this.query(`
            CREATE TABLE IF NOT EXISTS opencode_session_bindings (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                session_id TEXT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                target TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                opencode_session_id TEXT NOT NULL,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_opencode_session_bindings_unique
            ON opencode_session_bindings(owner_id, session_id, target, workspace_path)
        `);
        await this.query('CREATE INDEX IF NOT EXISTS idx_opencode_session_bindings_opencode_session_id ON opencode_session_bindings(opencode_session_id)');

        await this.query(`
            CREATE TABLE IF NOT EXISTS opencode_runs (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                session_id TEXT NULL REFERENCES sessions(id) ON DELETE SET NULL,
                opencode_session_id TEXT NULL,
                target TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                prompt TEXT NOT NULL,
                agent TEXT NOT NULL DEFAULT 'build',
                model TEXT NULL,
                approval_mode TEXT NOT NULL DEFAULT 'manual',
                async BOOLEAN NOT NULL DEFAULT FALSE,
                status TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                diff JSONB NOT NULL DEFAULT '[]'::jsonb,
                error JSONB NOT NULL DEFAULT '{}'::jsonb,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                started_at TIMESTAMPTZ NULL,
                finished_at TIMESTAMPTZ NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query('CREATE INDEX IF NOT EXISTS idx_opencode_runs_owner_id_created_at ON opencode_runs(owner_id, created_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_opencode_runs_session_id_created_at ON opencode_runs(session_id, created_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_opencode_runs_status_created_at ON opencode_runs(status, created_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_opencode_runs_opencode_session_id ON opencode_runs(opencode_session_id)');

        await this.query(`
            CREATE TABLE IF NOT EXISTS opencode_run_events (
                id BIGSERIAL PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES opencode_runs(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await this.query('CREATE INDEX IF NOT EXISTS idx_opencode_run_events_run_id_id ON opencode_run_events(run_id, id ASC)');

        await this.query(`
            CREATE TABLE IF NOT EXISTS managed_apps (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                session_id TEXT NULL REFERENCES sessions(id) ON DELETE SET NULL,
                slug TEXT NOT NULL,
                app_name TEXT NOT NULL,
                repo_owner TEXT NOT NULL,
                repo_name TEXT NOT NULL,
                repo_url TEXT NOT NULL,
                repo_clone_url TEXT NOT NULL DEFAULT '',
                repo_ssh_url TEXT NOT NULL DEFAULT '',
                default_branch TEXT NOT NULL DEFAULT 'main',
                image_repo TEXT NOT NULL,
                namespace TEXT NOT NULL,
                public_host TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                source_prompt TEXT NOT NULL DEFAULT '',
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await this.query(`
            CREATE TABLE IF NOT EXISTS managed_app_build_runs (
                id TEXT PRIMARY KEY,
                app_id TEXT NOT NULL REFERENCES managed_apps(id) ON DELETE CASCADE,
                owner_id TEXT NOT NULL,
                session_id TEXT NULL REFERENCES sessions(id) ON DELETE SET NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                requested_action TEXT NOT NULL DEFAULT 'build',
                commit_sha TEXT NOT NULL DEFAULT '',
                image_tag TEXT NOT NULL DEFAULT '',
                image_digest TEXT NOT NULL DEFAULT '',
                build_status TEXT NOT NULL DEFAULT 'queued',
                deploy_requested BOOLEAN NOT NULL DEFAULT FALSE,
                deploy_status TEXT NOT NULL DEFAULT 'not_requested',
                verification_status TEXT NOT NULL DEFAULT 'pending',
                external_run_id TEXT NULL,
                external_run_url TEXT NOT NULL DEFAULT '',
                error JSONB NOT NULL DEFAULT '{}'::jsonb,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                started_at TIMESTAMPTZ NULL,
                finished_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await this.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_apps_slug_owner ON managed_apps(owner_id, slug)');
        await this.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_apps_repo_owner_name ON managed_apps(repo_owner, repo_name)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_managed_apps_owner_updated_at ON managed_apps(owner_id, updated_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_managed_apps_session_id ON managed_apps(session_id)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_managed_app_build_runs_app_created_at ON managed_app_build_runs(app_id, created_at DESC)');
        await this.query('CREATE INDEX IF NOT EXISTS idx_managed_app_build_runs_owner_created_at ON managed_app_build_runs(owner_id, created_at DESC)');
        await this.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_app_build_runs_external_run_id ON managed_app_build_runs(external_run_id) WHERE external_run_id IS NOT NULL');
        await this.query('CREATE INDEX IF NOT EXISTS idx_managed_app_build_runs_commit_sha ON managed_app_build_runs(app_id, commit_sha)');

            this.initialized = true;
            this.unavailableReason = null;
            this.lastError = null;
        } catch (error) {
            await this.disable(error);
            console.warn(`[Postgres] Persistence disabled: ${this.unavailableReason}`);
            return false;
        }

        return true;
    }

    async healthCheck() {
        if (!this.enabled) {
            return false;
        }

        try {
            await this.query('SELECT 1');
            return true;
        } catch {
            return false;
        }
    }
}

const postgres = new PostgresManager();

module.exports = { postgres, PostgresManager };

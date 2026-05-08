const { v4: uuidv4 } = require('uuid');
const fs = require('fs/promises');
const path = require('path');
const { postgres } = require('./postgres');
const { config } = require('./config');
const { stripNullCharacters } = require('./utils/text');
const {
    buildScopedSessionMetadata,
    normalizeWebChatWorkspaceScopeKey,
    resolveSessionScope,
    sessionMatchesScope,
} = require('./session-scope');
const {
    buildLegacyControlMetadata,
    getSessionControlState,
    mergeControlState,
    normalizeRuntimeControlState,
} = require('./runtime-control-state');
const {
    buildSessionCompaction,
    normalizeSessionCompaction,
    shouldCompactSession,
} = require('./session-compaction');
const { stripAgentJournalBlocks } = require('./agent-journal');

const MAX_RECENT_MESSAGES = config.memory.recentMessageWindow;
const MAX_RECENT_MESSAGE_LENGTH = config.memory.recentMessageCharLimit;

class SessionStore {
    constructor() {
        this.sessions = new Map();
        this.sessionMessages = new Map();
        this.userSessionState = new Map();
        this.initialized = false;
        this.usePostgres = false;
        this.fallbackStoragePath = path.join(config.persistence.dataDir, 'sessions.json');
        this.fallbackLoaded = false;
        this.fallbackPersistQueue = Promise.resolve();
    }

    sanitizeMessageMetadataValue(value, depth = 0) {
        if (depth > 8 || value == null) {
            return null;
        }

        if (typeof value === 'string') {
            return stripNullCharacters(value);
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }

        if (Array.isArray(value)) {
            return value
                .map((entry) => this.sanitizeMessageMetadataValue(entry, depth + 1))
                .filter((entry) => entry != null);
        }

        if (typeof value !== 'object') {
            return null;
        }

        return Object.fromEntries(
            Object.entries(value)
                .map(([key, entry]) => [key, this.sanitizeMessageMetadataValue(entry, depth + 1)])
                .filter(([, entry]) => entry != null),
        );
    }

    normalizeMessageMetadata(metadata = {}) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            return {};
        }

        const sanitized = this.sanitizeMessageMetadataValue(metadata);
        return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
            ? sanitized
            : {};
    }

    extractMessageMetadata(message = {}) {
        if (!message || typeof message !== 'object') {
            return {};
        }

        const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
            ? { ...message.metadata }
            : {};

        Object.entries(message).forEach(([key, value]) => {
            if (['id', 'role', 'content', 'timestamp', 'metadata'].includes(key)) {
                return;
            }

            metadata[key] = value;
        });

        return this.normalizeMessageMetadata(metadata);
    }

    normalizeStoredMessages(messages = []) {
        if (!Array.isArray(messages)) {
            return [];
        }

        return messages
            .map((entry) => {
                const role = ['user', 'assistant', 'system', 'tool'].includes(entry?.role)
                    ? entry.role
                    : null;
                const content = stripAgentJournalBlocks(stripNullCharacters(entry?.content || '')).trim();
                const timestamp = entry?.timestamp || new Date().toISOString();
                const metadata = this.extractMessageMetadata(entry);

                if (!role || !content) {
                    return null;
                }

                return {
                    id: entry?.id || uuidv4(),
                    role,
                    content,
                    timestamp,
                    metadata,
                };
            })
            .filter(Boolean);
    }

    toClientMessage(message = {}) {
        const metadata = this.normalizeMessageMetadata(message?.metadata || {});

        return {
            id: message?.id || uuidv4(),
            role: message?.role,
            content: message?.content,
            timestamp: message?.timestamp || new Date().toISOString(),
            ...metadata,
            metadata,
        };
    }

    trimRecentMessageContent(content = '') {
        const value = stripNullCharacters(content).trim();
        if (!value) {
            return '';
        }

        if (config.memory.recentMessageCharLimit === 0 || value.length <= MAX_RECENT_MESSAGE_LENGTH) {
            return value;
        }

        const hiddenCharacters = value.length - MAX_RECENT_MESSAGE_LENGTH;
        return `${value.slice(0, MAX_RECENT_MESSAGE_LENGTH)}\n...[truncated ${hiddenCharacters} chars]`;
    }

    normalizeTranscriptMessages(messages = []) {
        return this.normalizeStoredMessages(messages)
            .filter((entry) => entry?.metadata?.excludeFromTranscript !== true)
            .map((entry) => ({
                role: entry.role,
                content: entry.content,
                timestamp: entry.timestamp,
            }));
    }

    normalizeRecentMessages(messages = [], limit = MAX_RECENT_MESSAGES) {
        const normalizedLimit = Math.max(0, limit);
        if (normalizedLimit === 0) {
            return [];
        }

        return this.normalizeTranscriptMessages(messages)
            .map((entry) => ({
                ...entry,
                content: stripNullCharacters(entry.content || '').trim(),
            }))
            .slice(-normalizedLimit);
    }

    buildCompactionAwareRecentMessages(messages = [], limit = MAX_RECENT_MESSAGES, sessionCompaction = null) {
        const normalizedLimit = Math.max(0, limit);
        if (normalizedLimit === 0) {
            return [];
        }

        const compaction = normalizeSessionCompaction(sessionCompaction || {});
        const transcriptMessages = this.normalizeTranscriptMessages(messages);
        const visibleMessages = transcriptMessages.slice(Math.min(
            compaction.compactedMessageCount,
            transcriptMessages.length,
        ));

        return visibleMessages
            .map((entry) => ({
                ...entry,
                content: stripNullCharacters(entry.content || '').trim(),
            }))
            .slice(-normalizedLimit);
    }

    normalizeRecentMessageRow(row) {
        const normalized = this.normalizeRecentMessages([{
            role: row?.role,
            content: row?.content,
            timestamp: row?.created_at instanceof Date ? row.created_at.toISOString() : row?.created_at,
        }], 1);

        return normalized[0] || null;
    }

    normalizeMetadata(metadata = {}) {
        const normalized = {
            ...metadata,
        };

        if (metadata.agent) {
            normalized.agent = {
                id: metadata.agent.id || null,
                name: metadata.agent.name || null,
                instructions: metadata.agent.instructions || '',
                tools: Array.isArray(metadata.agent.tools) ? metadata.agent.tools : [],
            };
        }

        if ('recentMessages' in metadata) {
            normalized.recentMessages = this.normalizeRecentMessages(metadata.recentMessages);
        }

        if ('sessionCompaction' in metadata) {
            normalized.sessionCompaction = normalizeSessionCompaction(metadata.sessionCompaction || {});
        }

        return normalized;
    }

    normalizeControlState(controlState = {}) {
        return normalizeRuntimeControlState(controlState);
    }

    normalizeOwnerId(ownerId = null) {
        const normalized = String(ownerId || '').trim();
        return normalized || null;
    }

    normalizeSessionId(sessionId = null) {
        const normalized = String(sessionId || '').trim();
        return normalized || null;
    }

    normalizeScopedActiveSessionIds(scopedActiveSessionIds = {}) {
        if (!scopedActiveSessionIds || typeof scopedActiveSessionIds !== 'object' || Array.isArray(scopedActiveSessionIds)) {
            return {};
        }

        return Object.fromEntries(
            Object.entries(scopedActiveSessionIds)
                .map(([scopeKey, sessionId]) => [
                    normalizeWebChatWorkspaceScopeKey(scopeKey),
                    this.normalizeSessionId(sessionId),
                ])
                .filter(([, sessionId]) => Boolean(sessionId)),
        );
    }

    normalizeUserPreferences(preferences = {}) {
        if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
            return {};
        }

        const sanitized = this.sanitizeMessageMetadataValue(preferences);
        return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
            ? sanitized
            : {};
    }

    normalizeUserPreferenceNamespace(namespace = '') {
        const normalized = String(namespace || '').trim();
        return normalized || null;
    }

    mergeUserPreferencePatch(current = {}, patch = {}) {
        const nextPreferences = {
            ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
        };

        Object.entries(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}).forEach(([key, value]) => {
            const normalizedKey = String(key || '').trim();
            if (!normalizedKey) {
                return;
            }

            if (value == null) {
                delete nextPreferences[normalizedKey];
                return;
            }

            nextPreferences[normalizedKey] = String(value);
        });

        return this.normalizeUserPreferences(nextPreferences);
    }

    getSessionOwnerId(sessionOrMetadata = null) {
        const metadata = sessionOrMetadata?.metadata || sessionOrMetadata || {};
        const ownerId = this.normalizeOwnerId(
            metadata?.ownerId
            || metadata?.userId
            || metadata?.username,
        );

        return ownerId;
    }

    normalizeUserSessionState(state = {}) {
        return {
            ownerId: this.normalizeOwnerId(state?.ownerId || state?.owner_id),
            activeSessionId: this.normalizeSessionId(state?.activeSessionId || state?.active_session_id),
            scopedActiveSessionIds: this.normalizeScopedActiveSessionIds(
                state?.scopedActiveSessionIds || state?.scoped_active_session_ids || {},
            ),
            preferences: this.normalizeUserPreferences(state?.preferences || {}),
            updatedAt: state?.updatedAt instanceof Date
                ? state.updatedAt.toISOString()
                : (state?.updatedAt || state?.updated_at || new Date().toISOString()),
        };
    }

    toUserSessionState(row) {
        const normalized = this.normalizeUserSessionState(row);
        if (!normalized.ownerId) {
            return null;
        }

        return normalized;
    }

    buildOwnedMetadata(metadata = {}, ownerId = null) {
        const scopedMetadata = buildScopedSessionMetadata(metadata);
        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        if (!normalizedOwnerId) {
            return this.normalizeMetadata(scopedMetadata);
        }

        return this.normalizeMetadata({
            ...scopedMetadata,
            ownerId: normalizedOwnerId,
            ownerType: metadata?.ownerType || scopedMetadata?.ownerType || 'user',
        });
    }

    buildSessionScopeKey(metadata = {}) {
        return normalizeWebChatWorkspaceScopeKey(resolveSessionScope(metadata || {}));
    }

    toSession(row) {
        if (!row) return null;

        const controlState = this.normalizeControlState(
            row?.control_state
            || row?.controlState
            || row?.metadata?.controlState
            || {},
        );

        return {
            id: row.id,
            previousResponseId: row.previous_response_id,
            createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
            updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
            messageCount: row.message_count,
            metadata: row.metadata || {},
            scopeKey: row.scope_key || row.scopeKey || this.buildSessionScopeKey(row.metadata || {}),
            controlState,
        };
    }

    async loadFallbackState() {
        if (this.fallbackLoaded) {
            return;
        }

        this.fallbackLoaded = true;

        try {
            const raw = await fs.readFile(this.fallbackStoragePath, 'utf8');
            const parsed = JSON.parse(raw);
            const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
            const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
            const userSessionState = Array.isArray(parsed?.userSessionState) ? parsed.userSessionState : [];

            this.sessions = new Map(
                sessions
                    .map((session) => {
                        if (!session?.id) {
                            return null;
                        }

                        return [
                            session.id,
                            (() => {
                                const metadata = this.normalizeMetadata(session.metadata || {});
                                return {
                                ...session,
                                metadata,
                                scopeKey: session.scopeKey || this.buildSessionScopeKey(metadata),
                                controlState: this.normalizeControlState(
                                    session.controlState
                                    || session.metadata?.controlState
                                    || {},
                                ),
                                };
                            })(),
                        ];
                    })
                    .filter(Boolean),
            );

            this.sessionMessages = new Map(
                messages
                    .map((entry) => {
                        const sessionId = entry?.[0];
                        if (!sessionId) {
                            return null;
                        }

                        return [
                            sessionId,
                            this.normalizeStoredMessages(entry?.[1] || []),
                        ];
                    })
                    .filter(Boolean),
            );

            this.userSessionState = new Map(
                userSessionState
                    .map((entry) => {
                        const normalized = this.toUserSessionState(entry);
                        if (!normalized?.ownerId) {
                            return null;
                        }

                        return [normalized.ownerId, normalized];
                    })
                    .filter(Boolean),
            );
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn('[SessionStore] Failed to load file-backed sessions:', error.message);
            }
        }
    }

    async persistFallbackState() {
        if (this.usePostgres) {
            return;
        }

        const writeTask = this.fallbackPersistQueue
            .catch(() => {})
            .then(async () => {
                const payload = {
                    version: 1,
                    savedAt: new Date().toISOString(),
                    sessions: Array.from(this.sessions.values()),
                    messages: Array.from(this.sessionMessages.entries()),
                    userSessionState: Array.from(this.userSessionState.values()),
                };

                const directory = path.dirname(this.fallbackStoragePath);
                const tempPath = `${this.fallbackStoragePath}.tmp`;

                await fs.mkdir(directory, { recursive: true });
                await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
                await fs.rename(tempPath, this.fallbackStoragePath);
            });

        this.fallbackPersistQueue = writeTask;
        return writeTask;
    }

    isPostgresUnavailableError(error = {}) {
        return Boolean(error?.statusCode === 503 && !postgres.enabled);
    }

    async switchToFallbackStorage(error = null) {
        if (!this.usePostgres || !this.isPostgresUnavailableError(error)) {
            return false;
        }

        this.usePostgres = false;
        await this.loadFallbackState();
        console.warn(`[SessionStore] Postgres unavailable, switching to file-backed sessions at ${this.fallbackStoragePath}: ${error.message}`);
        return true;
    }

    async persistFallbackSession(session = null) {
        if (!session?.id) {
            return null;
        }

        const normalizedMetadata = this.normalizeMetadata(session.metadata || {});
        const fallbackSession = {
            id: session.id,
            previousResponseId: session.previousResponseId || null,
            createdAt: session.createdAt || new Date().toISOString(),
            updatedAt: session.updatedAt || new Date().toISOString(),
            messageCount: Number(session.messageCount || 0),
            metadata: normalizedMetadata,
            scopeKey: session.scopeKey || this.buildSessionScopeKey(normalizedMetadata),
            controlState: this.normalizeControlState(session.controlState || {}),
        };

        this.sessions.set(fallbackSession.id, fallbackSession);
        if (!this.sessionMessages.has(fallbackSession.id)) {
            this.sessionMessages.set(fallbackSession.id, []);
        }
        await this.persistFallbackState();
        return fallbackSession;
    }

    async initialize() {
        if (this.initialized) return;

        try {
            this.usePostgres = await postgres.initialize();
            if (this.usePostgres) {
                console.log('[SessionStore] Using Postgres-backed sessions');
            } else {
                console.warn(`[SessionStore] Postgres not configured, using file-backed sessions at ${this.fallbackStoragePath}`);
                await this.loadFallbackState();
            }
        } catch (err) {
            this.usePostgres = false;
            console.error('[SessionStore] Postgres init failed, using file-backed sessions:', err.message);
            await this.loadFallbackState();
        }

        this.initialized = true;
    }

    async create(metadata = {}, preferredId = null) {
        await this.initialize();

        const id = preferredId || uuidv4();
        const existing = preferredId ? await this.get(id) : null;
        if (existing) {
            return existing;
        }
        const now = new Date().toISOString();
        const normalizedMetadata = this.normalizeMetadata(buildScopedSessionMetadata(metadata));
        const session = {
            id,
            previousResponseId: null,
            createdAt: now,
            updatedAt: now,
            messageCount: 0,
            metadata: normalizedMetadata,
            scopeKey: this.buildSessionScopeKey(normalizedMetadata),
            controlState: this.normalizeControlState(metadata?.controlState || {}),
        };

        if (!this.usePostgres) {
            this.sessions.set(id, session);
            if (!this.sessionMessages.has(id)) {
                this.sessionMessages.set(id, []);
            }
            await this.persistFallbackState();
            return session;
        }

        try {
            const result = await postgres.query(
                `
                    INSERT INTO sessions (id, previous_response_id, created_at, updated_at, message_count, metadata, scope_key)
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
                    ON CONFLICT (id) DO UPDATE
                    SET metadata = EXCLUDED.metadata,
                        scope_key = EXCLUDED.scope_key,
                        updated_at = EXCLUDED.updated_at
                    RETURNING *
                `,
                [
                    id,
                    null,
                    session.createdAt,
                    session.updatedAt,
                    0,
                    JSON.stringify(session.metadata || {}),
                    session.scopeKey,
                ],
            );

            await postgres.query(
                `
                    INSERT INTO session_runtime_state (session_id, state)
                    VALUES ($1, $2::jsonb)
                    ON CONFLICT (session_id) DO NOTHING
                `,
                [
                    id,
                    JSON.stringify(session.controlState || {}),
                ],
            );

            return this.toSession({
                ...result.rows[0],
                control_state: session.controlState,
            });
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                return this.persistFallbackSession(session);
            }
            throw error;
        }
    }

    async get(id) {
        await this.initialize();

        if (!this.usePostgres) {
            return this.sessions.get(id) || null;
        }

        try {
            const result = await postgres.query(
                `
                    SELECT sessions.*, session_runtime_state.state AS control_state
                    FROM sessions
                    LEFT JOIN session_runtime_state
                        ON session_runtime_state.session_id = sessions.id
                    WHERE sessions.id = $1
                `,
                [id],
            );
            return this.toSession(result.rows[0]);
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                return this.sessions.get(id) || null;
            }
            throw error;
        }
    }

    async getOrCreate(id, metadata = {}) {
        const existing = await this.get(id);
        if (existing) {
            return existing;
        }

        return this.create(metadata, id);
    }

    async claimOwnershipIfNeeded(id, ownerId = null) {
        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        if (!normalizedOwnerId) {
            return this.get(id);
        }

        const session = await this.get(id);
        if (!session) {
            return null;
        }

        const existingOwnerId = this.getSessionOwnerId(session);
        if (existingOwnerId && existingOwnerId !== normalizedOwnerId) {
            return null;
        }

        if (existingOwnerId === normalizedOwnerId) {
            return session;
        }

        return this.update(id, {
            metadata: this.buildOwnedMetadata(session.metadata || {}, normalizedOwnerId),
        });
    }

    async getOwned(id, ownerId = null) {
        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        if (!normalizedOwnerId) {
            return this.get(id);
        }

        return this.claimOwnershipIfNeeded(id, normalizedOwnerId);
    }

    async getOrCreateOwned(id, metadata = {}, ownerId = null) {
        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        const existing = await this.get(id);
        if (existing) {
            return normalizedOwnerId ? this.getOwned(id, normalizedOwnerId) : existing;
        }

        return this.create(this.buildOwnedMetadata(metadata, normalizedOwnerId), id);
    }

    async getUserSessionState(ownerId = null) {
        await this.initialize();

        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        if (!normalizedOwnerId) {
            return null;
        }

        if (!this.usePostgres) {
            return this.userSessionState.get(normalizedOwnerId) || null;
        }

        try {
            const result = await postgres.query(
                `
                    SELECT owner_id, active_session_id, scoped_active_session_ids, preferences, updated_at
                    FROM user_session_state
                    WHERE owner_id = $1
                `,
                [normalizedOwnerId],
            );

            return this.toUserSessionState(result.rows[0]);
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                return this.userSessionState.get(normalizedOwnerId) || null;
            }
            throw error;
        }
    }

    async persistUserSessionState(state = {}) {
        const nextState = this.normalizeUserSessionState(state);
        if (!nextState.ownerId) {
            return null;
        }

        if (!this.usePostgres) {
            this.userSessionState.set(nextState.ownerId, nextState);
            await this.persistFallbackState();
            return nextState;
        }

        try {
            const result = await postgres.query(
                `
                    INSERT INTO user_session_state (owner_id, active_session_id, scoped_active_session_ids, preferences, updated_at)
                    VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())
                    ON CONFLICT (owner_id) DO UPDATE
                    SET active_session_id = EXCLUDED.active_session_id,
                        scoped_active_session_ids = EXCLUDED.scoped_active_session_ids,
                        preferences = EXCLUDED.preferences,
                        updated_at = NOW()
                    RETURNING owner_id, active_session_id, scoped_active_session_ids, preferences, updated_at
                `,
                [
                    nextState.ownerId,
                    nextState.activeSessionId,
                    JSON.stringify(nextState.scopedActiveSessionIds || {}),
                    JSON.stringify(nextState.preferences || {}),
                ],
            );

            return this.toUserSessionState(result.rows[0]);
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                this.userSessionState.set(nextState.ownerId, nextState);
                await this.persistFallbackState();
                return nextState;
            }
            throw error;
        }
    }

    async setActiveSession(ownerId = null, sessionId = null, scopeKey = null) {
        await this.initialize();

        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        if (!normalizedOwnerId) {
            return null;
        }

        const normalizedSessionId = this.normalizeSessionId(sessionId);
        const normalizedScopeKey = normalizeWebChatWorkspaceScopeKey(scopeKey);
        if (normalizedSessionId) {
            const session = await this.getOwned(normalizedSessionId, normalizedOwnerId);
            if (!session) {
                return null;
            }
            if (scopeKey && !sessionMatchesScope(session, normalizedScopeKey)) {
                console.warn(`[SessionStore] Refusing to set active session ${session.id} for requested scope ${normalizedScopeKey}; session scope is ${session.scopeKey || session.metadata?.memoryScope || 'unknown'}`);
                return null;
            }
        }

        const currentState = await this.getUserSessionState(normalizedOwnerId);
        const scopedActiveSessionIds = {
            ...(currentState?.scopedActiveSessionIds || {}),
        };

        if (normalizedSessionId) {
            scopedActiveSessionIds[normalizedScopeKey] = normalizedSessionId;
        } else {
            delete scopedActiveSessionIds[normalizedScopeKey];
        }

        let nextGlobalActiveSessionId = normalizedSessionId || currentState?.activeSessionId || null;
        const removedScopedActiveSessionId = currentState?.scopedActiveSessionIds?.[normalizedScopeKey] || null;
        if (!normalizedSessionId
            && currentState?.activeSessionId
            && removedScopedActiveSessionId
            && currentState.activeSessionId === removedScopedActiveSessionId) {
            nextGlobalActiveSessionId = Object.values(scopedActiveSessionIds)[0] || null;
        }

        const nextState = this.normalizeUserSessionState({
            ownerId: normalizedOwnerId,
            activeSessionId: nextGlobalActiveSessionId,
            scopedActiveSessionIds,
            preferences: currentState?.preferences || {},
            updatedAt: new Date().toISOString(),
        });

        return this.persistUserSessionState(nextState);
    }

    async getActiveOwnedSession(ownerId = null, scopeKey = null) {
        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        if (!normalizedOwnerId) {
            return null;
        }

        const state = await this.getUserSessionState(normalizedOwnerId);
        const normalizedScopeKey = normalizeWebChatWorkspaceScopeKey(scopeKey);
        const activeSessionId = this.normalizeSessionId(
            state?.scopedActiveSessionIds?.[normalizedScopeKey]
            || (normalizedScopeKey === normalizeWebChatWorkspaceScopeKey() ? state?.activeSessionId : null),
        );
        if (!activeSessionId) {
            return null;
        }

        const session = await this.getOwned(activeSessionId, normalizedOwnerId);
        if (session) {
            if (scopeKey && !sessionMatchesScope(session, normalizedScopeKey)) {
                await this.setActiveSession(normalizedOwnerId, null, normalizedScopeKey);
                return null;
            }

            return session;
        }

        await this.setActiveSession(normalizedOwnerId, null, normalizedScopeKey);
        return null;
    }

    async getUserPreferences(ownerId = null, namespace = null) {
        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        if (!normalizedOwnerId) {
            return {};
        }

        const state = await this.getUserSessionState(normalizedOwnerId);
        const preferences = this.normalizeUserPreferences(state?.preferences || {});
        const normalizedNamespace = this.normalizeUserPreferenceNamespace(namespace);
        if (!normalizedNamespace) {
            return preferences;
        }

        return this.normalizeUserPreferences(preferences[normalizedNamespace] || {});
    }

    async patchUserPreferences(ownerId = null, namespace = null, patch = {}) {
        await this.initialize();

        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        const normalizedNamespace = this.normalizeUserPreferenceNamespace(namespace);
        if (!normalizedOwnerId || !normalizedNamespace) {
            return {};
        }

        const currentState = await this.getUserSessionState(normalizedOwnerId);
        const currentPreferences = this.normalizeUserPreferences(currentState?.preferences || {});
        const currentNamespacePreferences = this.normalizeUserPreferences(currentPreferences[normalizedNamespace] || {});
        const nextNamespacePreferences = this.mergeUserPreferencePatch(currentNamespacePreferences, patch);
        const nextPreferences = {
            ...currentPreferences,
        };

        if (Object.keys(nextNamespacePreferences).length > 0) {
            nextPreferences[normalizedNamespace] = nextNamespacePreferences;
        } else {
            delete nextPreferences[normalizedNamespace];
        }

        const nextState = this.normalizeUserSessionState({
            ownerId: normalizedOwnerId,
            activeSessionId: currentState?.activeSessionId || null,
            scopedActiveSessionIds: currentState?.scopedActiveSessionIds || {},
            preferences: nextPreferences,
            updatedAt: new Date().toISOString(),
        });

        const savedState = await this.persistUserSessionState(nextState);
        return this.normalizeUserPreferences(savedState?.preferences?.[normalizedNamespace] || {});
    }

    async getLatestOwnedSession(ownerId = null, options = {}) {
        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        const normalizedScopeKey = options?.scopeKey
            ? normalizeWebChatWorkspaceScopeKey(options.scopeKey)
            : null;
        const sessions = await this.list(normalizedOwnerId ? {
            ownerId: normalizedOwnerId,
            ...(normalizedScopeKey ? { scopeKey: normalizedScopeKey } : {}),
        } : {
            ...(normalizedScopeKey ? { scopeKey: normalizedScopeKey } : {}),
        });
        const latest = sessions[0] || null;

        if (!latest) {
            return null;
        }

        if (!normalizedOwnerId) {
            return latest;
        }

        return this.getOwned(latest.id, normalizedOwnerId);
    }

    async resolveOwnedSession(sessionId = null, metadata = {}, ownerId = null) {
        const normalizedOwnerId = this.normalizeOwnerId(ownerId);
        const normalizedSessionId = this.normalizeSessionId(sessionId);
        const normalizedScopeKey = resolveSessionScope(metadata);
        const normalizedActiveScopeKey = normalizeWebChatWorkspaceScopeKey(normalizedScopeKey);

        if (normalizedSessionId) {
            const session = await this.getOrCreateOwned(
                normalizedSessionId,
                metadata,
                normalizedOwnerId,
            );

            if (session && sessionMatchesScope(session, normalizedActiveScopeKey)) {
                if (normalizedOwnerId) {
                    await this.setActiveSession(normalizedOwnerId, session.id, normalizedActiveScopeKey);
                }

                return session;
            }

            if (!session) {
                return null;
            }

            console.warn(`[SessionStore] Ignoring session ${session.id} for requested scope ${normalizedActiveScopeKey}; session scope is ${session.scopeKey || session.metadata?.memoryScope || 'unknown'}`);
        }

        if (normalizedOwnerId) {
            const activeSession = await this.getActiveOwnedSession(normalizedOwnerId, normalizedActiveScopeKey);
            if (activeSession) {
                return activeSession;
            }

            const latestSession = await this.getLatestOwnedSession(normalizedOwnerId, {
                scopeKey: normalizedActiveScopeKey,
            });
            if (latestSession) {
                await this.setActiveSession(normalizedOwnerId, latestSession.id, normalizedActiveScopeKey);
                return latestSession;
            }
        }

        const session = await this.create(
            normalizedOwnerId ? this.buildOwnedMetadata(metadata, normalizedOwnerId) : metadata,
        );

        if (session && normalizedOwnerId) {
            await this.setActiveSession(normalizedOwnerId, session.id, normalizedActiveScopeKey);
        }

        return session;
    }

    async update(id, updates = {}) {
        await this.initialize();

        if (!this.usePostgres) {
            const session = this.sessions.get(id);
            if (!session) return null;
            const nextMetadata = updates.metadata
                ? this.normalizeMetadata({
                    ...(session.metadata || {}),
                    ...updates.metadata,
                })
                : session.metadata;

            const next = {
                ...session,
                ...updates,
                metadata: nextMetadata,
                scopeKey: updates.scopeKey || this.buildSessionScopeKey(nextMetadata || {}),
                controlState: updates.controlState
                    ? this.normalizeControlState(mergeControlState(
                        session.controlState || {},
                        updates.controlState,
                    ))
                    : this.normalizeControlState(session.controlState || {}),
                updatedAt: new Date().toISOString(),
            };

            this.sessions.set(id, next);
            await this.persistFallbackState();
            return next;
        }

        const current = await this.get(id);
        if (!current) return null;

        const nextMetadata = updates.metadata
            ? this.normalizeMetadata({
                ...(current.metadata || {}),
                ...updates.metadata,
            })
            : current.metadata;
        const nextScopeKey = updates.scopeKey || this.buildSessionScopeKey(nextMetadata || {});
        const nextControlState = updates.controlState
            ? this.normalizeControlState(mergeControlState(
                current.controlState || {},
                updates.controlState,
            ))
            : this.normalizeControlState(current.controlState || {});

        try {
            const result = await postgres.query(
                `
                    UPDATE sessions
                    SET previous_response_id = $2,
                        message_count = $3,
                        metadata = $4::jsonb,
                        scope_key = $5,
                        updated_at = NOW()
                    WHERE id = $1
                    RETURNING *
                `,
                [
                    id,
                    updates.previousResponseId ?? current.previousResponseId,
                    updates.messageCount ?? current.messageCount,
                    JSON.stringify(nextMetadata || {}),
                    nextScopeKey,
                ],
            );

            if (updates.controlState) {
                await postgres.query(
                    `
                        INSERT INTO session_runtime_state (session_id, state, updated_at)
                        VALUES ($1, $2::jsonb, NOW())
                        ON CONFLICT (session_id) DO UPDATE
                        SET state = $2::jsonb,
                            updated_at = NOW()
                    `,
                    [
                        id,
                        JSON.stringify(nextControlState || {}),
                    ],
                );
            }

            return this.toSession({
                ...result.rows[0],
                control_state: nextControlState,
            });
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                await this.persistFallbackSession(current);
                return this.update(id, updates);
            }
            throw error;
        }
    }

    async getControlState(sessionOrId) {
        const session = typeof sessionOrId === 'string'
            ? await this.get(sessionOrId)
            : sessionOrId;

        return getSessionControlState(session);
    }

    async updateControlState(id, controlState = {}) {
        await this.initialize();

        const current = await this.get(id);
        if (!current) {
            return null;
        }

        const nextControlState = this.normalizeControlState(mergeControlState(
            current.controlState || {},
            controlState,
        ));
        const legacyMetadata = buildLegacyControlMetadata(nextControlState);

        if (!this.usePostgres) {
            const session = this.sessions.get(id);
            const next = {
                ...session,
                controlState: nextControlState,
                metadata: this.normalizeMetadata({
                    ...(session?.metadata || {}),
                    ...legacyMetadata,
                }),
                updatedAt: new Date().toISOString(),
            };
            this.sessions.set(id, next);
            await this.persistFallbackState();
            return nextControlState;
        }

        try {
            await postgres.query(
                `
                    INSERT INTO session_runtime_state (session_id, state, updated_at)
                    VALUES ($1, $2::jsonb, NOW())
                    ON CONFLICT (session_id) DO UPDATE
                    SET state = $2::jsonb,
                        updated_at = NOW()
                `,
                [
                    id,
                    JSON.stringify(nextControlState || {}),
                ],
            );

            await this.update(id, {
                metadata: legacyMetadata,
            });

            return nextControlState;
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                await this.persistFallbackSession(current);
                return this.updateControlState(id, controlState);
            }
            throw error;
        }
    }

    async getRecentMessages(sessionOrId, limit = MAX_RECENT_MESSAGES) {
        await this.initialize();

        const session = typeof sessionOrId === 'string'
            ? await this.get(sessionOrId)
            : sessionOrId;
        const sessionId = typeof sessionOrId === 'string' ? sessionOrId : session?.id;

        if (!sessionId) {
            return [];
        }

        const transcript = await this.loadAllSessionMessages(sessionId);
        return this.buildCompactionAwareRecentMessages(
            transcript,
            limit,
            session?.metadata?.sessionCompaction || null,
        );
    }

    async appendMessages(id, messages = []) {
        await this.initialize();

        const storedMessages = this.normalizeStoredMessages(messages);
        if (storedMessages.length === 0) {
            return this.get(id);
        }

        const current = await this.get(id);
        if (!current) {
            return null;
        }

        if (this.usePostgres) {
            try {
                for (const message of storedMessages) {
                    await postgres.query(
                        `
                            INSERT INTO session_messages (id, session_id, role, content, created_at, metadata)
                            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                        `,
                        [
                            message.id,
                            id,
                            message.role,
                            message.content,
                            message.timestamp,
                            JSON.stringify(message.metadata || {}),
                        ],
                    );
                }

                return this.update(id, {
                    metadata: {
                        recentMessages: this.buildCompactionAwareRecentMessages(
                            await this.loadAllSessionMessages(id),
                            MAX_RECENT_MESSAGES,
                            current?.metadata?.sessionCompaction || null,
                        ),
                    },
                });
            } catch (error) {
                if (await this.switchToFallbackStorage(error)) {
                    await this.persistFallbackSession(current);
                    return this.appendMessages(id, storedMessages);
                }
                throw error;
            }
        }

        const existingMessages = this.sessionMessages.get(id) || [];
        const nextMessages = [...existingMessages, ...storedMessages];
        this.sessionMessages.set(id, nextMessages);

        const updated = await this.update(id, {
            metadata: {
                recentMessages: this.buildCompactionAwareRecentMessages(
                    nextMessages,
                    MAX_RECENT_MESSAGES,
                    current?.metadata?.sessionCompaction || null,
                ),
            },
        });
        await this.persistFallbackState();
        return updated;
    }

    async upsertMessage(id, message = {}) {
        await this.initialize();

        const storedMessage = this.normalizeStoredMessages([message])[0] || null;
        if (!storedMessage) {
            return null;
        }

        const current = await this.get(id);
        if (!current) {
            return null;
        }

        if (this.usePostgres) {
            try {
                const result = await postgres.query(
                    `
                        INSERT INTO session_messages (id, session_id, role, content, created_at, metadata)
                        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                        ON CONFLICT (id) DO UPDATE
                        SET role = EXCLUDED.role,
                            content = EXCLUDED.content,
                            created_at = EXCLUDED.created_at,
                            metadata = EXCLUDED.metadata
                        WHERE session_messages.session_id = EXCLUDED.session_id
                        RETURNING id, role, content, created_at, metadata
                    `,
                    [
                        storedMessage.id,
                        id,
                        storedMessage.role,
                        storedMessage.content,
                        storedMessage.timestamp,
                        JSON.stringify(storedMessage.metadata || {}),
                    ],
                );

                if (result.rowCount === 0) {
                    return null;
                }

                await this.update(id, {
                    metadata: {
                        recentMessages: this.buildCompactionAwareRecentMessages(
                            await this.loadAllSessionMessages(id),
                            MAX_RECENT_MESSAGES,
                            current?.metadata?.sessionCompaction || null,
                        ),
                    },
                });

                return this.toClientMessage({
                    id: result.rows[0].id,
                    role: result.rows[0].role,
                    content: result.rows[0].content,
                    timestamp: result.rows[0].created_at instanceof Date
                        ? result.rows[0].created_at.toISOString()
                        : result.rows[0].created_at,
                    metadata: result.rows[0].metadata || {},
                });
            } catch (error) {
                if (await this.switchToFallbackStorage(error)) {
                    await this.persistFallbackSession(current);
                    return this.upsertMessage(id, storedMessage);
                }
                throw error;
            }
        }

        const existingMessages = this.sessionMessages.get(id) || [];
        const index = existingMessages.findIndex((entry) => entry.id === storedMessage.id);
        const nextMessages = [...existingMessages];

        if (index >= 0) {
            nextMessages[index] = {
                ...nextMessages[index],
                ...storedMessage,
                metadata: this.normalizeMessageMetadata({
                    ...(nextMessages[index]?.metadata || {}),
                    ...(storedMessage.metadata || {}),
                }),
            };
        } else {
            nextMessages.push(storedMessage);
        }

        this.sessionMessages.set(id, nextMessages);

        await this.update(id, {
            metadata: {
                recentMessages: this.buildCompactionAwareRecentMessages(
                    nextMessages,
                    MAX_RECENT_MESSAGES,
                    current?.metadata?.sessionCompaction || null,
                ),
            },
        });
        await this.persistFallbackState();

        return this.toClientMessage(index >= 0 ? nextMessages[index] : storedMessage);
    }

    async recordResponse(id, responseId, metadataUpdates = null) {
        await this.initialize();

        if (!this.usePostgres) {
            const session = this.sessions.get(id);
            if (!session) return null;

            const next = {
                ...session,
                previousResponseId: responseId,
                messageCount: (session.messageCount || 0) + 1,
                metadata: metadataUpdates
                    ? this.normalizeMetadata({
                        ...(session.metadata || {}),
                        ...metadataUpdates,
                    })
                    : session.metadata,
                updatedAt: new Date().toISOString(),
            };
            next.scopeKey = this.buildSessionScopeKey(next.metadata || {});
            this.sessions.set(id, next);
            await this.persistFallbackState();
            return next;
        }

        let nextMetadata = null;
        if (metadataUpdates && typeof metadataUpdates === 'object' && Object.keys(metadataUpdates).length > 0) {
            const current = await this.get(id);
            if (!current) {
                return null;
            }
            nextMetadata = this.normalizeMetadata({
                ...(current.metadata || {}),
                ...metadataUpdates,
            });
        }

        try {
            const result = await postgres.query(
                `
                    UPDATE sessions
                    SET previous_response_id = $2,
                        message_count = message_count + 1,
                        metadata = COALESCE($3::jsonb, metadata),
                        scope_key = COALESCE($4, scope_key),
                        updated_at = NOW()
                    WHERE id = $1
                    RETURNING *
                `,
                [
                    id,
                    responseId,
                    nextMetadata ? JSON.stringify(nextMetadata) : null,
                    nextMetadata ? this.buildSessionScopeKey(nextMetadata) : null,
                ],
            );

            return this.toSession(result.rows[0]);
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                await this.persistFallbackSession({
                    id,
                    metadata: nextMetadata || {},
                    previousResponseId: null,
                    messageCount: 0,
                });
                return this.recordResponse(id, responseId, metadataUpdates);
            }
            throw error;
        }
    }

    async loadAllSessionMessages(sessionId) {
        await this.initialize();

        const normalizedSessionId = this.normalizeSessionId(sessionId);
        if (!normalizedSessionId) {
            return [];
        }

        if (this.usePostgres) {
            try {
                const result = await postgres.query(
                    `
                        SELECT id, role, content, created_at, metadata
                        FROM session_messages
                        WHERE session_id = $1
                        ORDER BY created_at ASC
                    `,
                    [normalizedSessionId],
                );

                return result.rows
                    .map((row) => this.toClientMessage({
                        id: row?.id,
                        role: ['user', 'assistant', 'system', 'tool'].includes(row?.role) ? row.role : null,
                        content: stripNullCharacters(row?.content || '').trim(),
                        timestamp: row?.created_at instanceof Date ? row.created_at.toISOString() : row?.created_at,
                        metadata: row?.metadata || {},
                    }))
                    .filter((row) => row.role && row.content);
            } catch (error) {
                if (!(await this.switchToFallbackStorage(error))) {
                    throw error;
                }
            }
        }

        return (this.sessionMessages.get(normalizedSessionId) || [])
            .map((message) => this.toClientMessage(message));
    }

    async maybeCompactSession(id, {
        ownerId = null,
        workflow = null,
        projectMemory = null,
    } = {}) {
        await this.initialize();

        const session = ownerId
            ? await this.getOwned(id, ownerId)
            : await this.get(id);
        if (!session) {
            return null;
        }

        const messages = await this.loadAllSessionMessages(session.id);
        const existingCompaction = normalizeSessionCompaction(
            session?.metadata?.sessionCompaction || {},
        );

        if (!shouldCompactSession({
            messages,
            existingCompaction,
            workflow,
        })) {
            return session;
        }

        const nextCompaction = buildSessionCompaction({
            messages,
            existingCompaction,
            workflow,
            projectMemory,
        });
        if (!nextCompaction) {
            return session;
        }

        return this.update(session.id, {
            metadata: {
                sessionCompaction: nextCompaction,
                recentMessages: this.buildCompactionAwareRecentMessages(
                    messages,
                    MAX_RECENT_MESSAGES,
                    nextCompaction,
                ),
            },
        });
    }

    async delete(id) {
        await this.initialize();

        if (!this.usePostgres) {
            this.sessionMessages.delete(id);
            const deleted = this.sessions.delete(id);
            if (deleted) {
                for (const [ownerId, state] of this.userSessionState.entries()) {
                    const scopedActiveSessionIds = Object.fromEntries(
                        Object.entries(state.scopedActiveSessionIds || {})
                            .filter(([, sessionId]) => sessionId !== id),
                    );
                    this.userSessionState.set(ownerId, this.normalizeUserSessionState({
                        ...state,
                        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
                        scopedActiveSessionIds,
                        updatedAt: new Date().toISOString(),
                    }));
                }
            }
            await this.persistFallbackState();
            return deleted;
        }

        try {
            const result = await postgres.query('DELETE FROM sessions WHERE id = $1', [id]);
            if (result.rowCount > 0) {
                await postgres.query(
                    `
                        UPDATE user_session_state
                        SET active_session_id = CASE
                                WHEN active_session_id = $1 THEN NULL
                                ELSE active_session_id
                            END,
                            scoped_active_session_ids = COALESCE(
                                (
                                    SELECT jsonb_object_agg(entry.key, entry.value)
                                    FROM jsonb_each_text(user_session_state.scoped_active_session_ids) AS entry(key, value)
                                    WHERE entry.value <> $1
                                ),
                                '{}'::jsonb
                            ),
                            updated_at = NOW()
                    `,
                    [id],
                );
            }
            return result.rowCount > 0;
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                this.sessionMessages.delete(id);
                const deleted = this.sessions.delete(id);
                if (deleted) {
                    for (const [ownerId, state] of this.userSessionState.entries()) {
                        const scopedActiveSessionIds = Object.fromEntries(
                            Object.entries(state.scopedActiveSessionIds || {})
                                .filter(([, sessionId]) => sessionId !== id),
                        );
                        this.userSessionState.set(ownerId, this.normalizeUserSessionState({
                            ...state,
                            activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
                            scopedActiveSessionIds,
                            updatedAt: new Date().toISOString(),
                        }));
                    }
                }
                await this.persistFallbackState();
                return deleted;
            }
            throw error;
        }
    }

    async list(options = {}) {
        await this.initialize();
        const ownerId = this.normalizeOwnerId(options?.ownerId);
        const scopeKey = options?.scopeKey
            ? normalizeWebChatWorkspaceScopeKey(options.scopeKey)
            : null;

        if (!this.usePostgres) {
            return Array.from(this.sessions.values())
                .filter((session) => {
                    if (!ownerId) {
                        return !scopeKey || sessionMatchesScope(session, scopeKey);
                    }

                    const sessionOwnerId = this.getSessionOwnerId(session);
                    return (!sessionOwnerId || sessionOwnerId === ownerId)
                        && (!scopeKey || sessionMatchesScope(session, scopeKey));
                })
                .sort((a, b) => {
                    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
                });
        }

        try {
            const result = ownerId
                ? await postgres.query(
                    `
                        SELECT sessions.*, session_runtime_state.state AS control_state
                        FROM sessions
                        LEFT JOIN session_runtime_state
                            ON session_runtime_state.session_id = sessions.id
                        WHERE COALESCE(sessions.metadata->>'ownerId', '') = ''
                           OR sessions.metadata->>'ownerId' = $1
                        ORDER BY sessions.updated_at DESC
                    `,
                    [ownerId],
                )
                : await postgres.query(
                    `
                        SELECT sessions.*, session_runtime_state.state AS control_state
                        FROM sessions
                        LEFT JOIN session_runtime_state
                            ON session_runtime_state.session_id = sessions.id
                        ORDER BY sessions.updated_at DESC
                    `,
                );

            const sessions = result.rows.map((row) => this.toSession(row));
            return scopeKey
                ? sessions.filter((session) => sessionMatchesScope(session, scopeKey))
                : sessions;
        } catch (error) {
            if (await this.switchToFallbackStorage(error)) {
                return this.list(options);
            }
            throw error;
        }
    }

    async listMessages(id, limit = MAX_RECENT_MESSAGES, ownerId = null) {
        const session = await this.getOwned(id, ownerId);
        if (!session) {
            return [];
        }

        const normalizedLimit = Math.max(0, limit);

        if (this.usePostgres) {
            try {
                const result = await postgres.query(
                    `
                        SELECT id, role, content, created_at, metadata
                        FROM session_messages
                        WHERE session_id = $1
                        ORDER BY created_at DESC
                        LIMIT $2
                    `,
                    [session.id, normalizedLimit],
                );

                return result.rows
                    .map((row) => this.toClientMessage({
                        id: row?.id,
                        role: ['user', 'assistant', 'system', 'tool'].includes(row?.role) ? row.role : null,
                        content: stripNullCharacters(row?.content || '').trim(),
                        timestamp: row?.created_at instanceof Date ? row.created_at.toISOString() : row?.created_at,
                        metadata: row?.metadata || {},
                    }))
                    .filter((row) => row.role && row.content)
                    .reverse();
            } catch (error) {
                if (!(await this.switchToFallbackStorage(error))) {
                    throw error;
                }
            }
        }

        const transcript = this.sessionMessages.get(session.id) || [];
        return transcript
            .slice(-normalizedLimit)
            .map((message) => this.toClientMessage(message));
    }

    async healthCheck() {
        await this.initialize();

        if (!this.usePostgres) {
            return false;
        }

        return postgres.healthCheck();
    }

    isPersistent() {
        return this.usePostgres && postgres.enabled;
    }
}

const sessionStore = new SessionStore();

module.exports = { sessionStore, SessionStore };

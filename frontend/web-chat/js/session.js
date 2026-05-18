/**
 * Session Management for LillyBuilt AI Chat
 * Handles session state, local storage, and session operations with enhanced persistence
 * Now works client-side only with OpenAI SDK backend
 */

const SESSION_MANAGER_TASK_TYPE = 'chat';
const SESSION_MANAGER_CLIENT_SURFACE = 'web-chat';
const WEB_CHAT_PREFERENCE_SYNC_DELAY_MS = 180;
const WEB_CHAT_RECOVERED_MESSAGE_SYNC_DELAY_MS = 75;
const WEB_CHAT_TERMINAL_SYNC_STATUSES = new Set([400, 404, 409, 422]);
const WEB_CHAT_SECONDARY_WORKSPACE_CACHE_RESET_VERSION = '20260424-secondary-workspace-cache-reset-1';
const WEB_CHAT_LOCAL_CACHE_SESSION_LIMIT = 40;
const WEB_CHAT_LOCAL_CACHE_MESSAGES_PER_SESSION = 120;
const WEB_CHAT_LOCAL_CACHE_STRING_LIMIT = 20000;
const WEB_CHAT_LOCAL_CACHE_ARRAY_LIMIT = 80;
const WEB_CHAT_LOCAL_CACHE_OBJECT_DEPTH_LIMIT = 5;
const WEB_CHAT_ACTIVE_SESSION_LOCAL_HOLD_MS = 45000;
const WEB_CHAT_STALE_FOREGROUND_MESSAGE_MS = 6 * 60 * 60 * 1000;
const WEB_CHAT_STALE_FOREGROUND_FALLBACK = 'This background reply did not finish cleanly before the page was refreshed. You can retry from here.';
const WEB_CHAT_LOCAL_CACHE_HEAVY_KEYS = new Set([
    'audioData',
    'audio_data',
    'base64',
    'b64',
    'b64_json',
    'blob',
    'bytes',
    'data',
    'dataUrl',
    'dataURL',
    'imageData',
    'image_data',
    'inlineData',
    'inline_data',
    'raw',
]);
const WEB_CHAT_SYNCED_STORAGE_KEYS = new Set([
    'kimibuilt_default_model',
    'kimibuilt_reasoning_effort',
    'kimibuilt_remote_build_autonomy',
    'kimibuilt_theme_preset',
    'kimibuilt_theme',
    'webchat_layout_mode',
    'kimibuilt_sound_cues_enabled',
    'kimibuilt_menu_sounds_enabled',
    'kimibuilt_sound_profile',
    'kimibuilt_sound_volume',
    'kimibuilt_tts_autoplay',
    'kimibuilt_tts_voice_id',
    'webchat_input_hidden',
    'kimibuilt_sidebar_width',
    'kimibuilt_sidebar_collapsed',
    'kimibuilt_web_chat_workspace_host_active',
]);
const sessionGatewayHelpers = window.KimiBuiltGatewaySSE || {};
const SESSION_DEFAULT_MODEL = sessionGatewayHelpers.DEFAULT_CODEX_MODEL_ID || 'auto';
const buildSessionGatewayHeaders = sessionGatewayHelpers.buildGatewayHeaders || ((headers) => headers);
const sessionWorkspaceHelpers = window.KimiBuiltWebChatWorkspace || null;
const resolveSessionPreferredModel = sessionGatewayHelpers.resolvePreferredChatModel
    || ((models, preferredModel = '', fallbackModel = SESSION_DEFAULT_MODEL) => {
        const availableModels = Array.isArray(models) ? models : [];
        const availableIds = new Set(
            availableModels
                .map((entry) => String(entry?.id || '').trim())
                .filter(Boolean),
        );
        const preferredId = String(preferredModel || '').trim();
        const fallbackId = String(fallbackModel || '').trim() || SESSION_DEFAULT_MODEL;

        if (preferredId === SESSION_DEFAULT_MODEL) {
            return SESSION_DEFAULT_MODEL;
        }

        if (preferredId && (availableIds.size === 0 || availableIds.has(preferredId))) {
            return preferredId;
        }

        if (fallbackId === SESSION_DEFAULT_MODEL) {
            return SESSION_DEFAULT_MODEL;
        }

        if (fallbackId && availableIds.has(fallbackId)) {
            return fallbackId;
        }

        return String(availableModels[0]?.id || fallbackId).trim() || fallbackId;
    });

const SESSION_WORKSPACE_CONTEXT = typeof sessionWorkspaceHelpers?.getWorkspaceContext === 'function'
    ? sessionWorkspaceHelpers.getWorkspaceContext()
    : {
        key: 'workspace-1',
        label: 'Workspace 1',
        scopeKey: SESSION_MANAGER_CLIENT_SURFACE,
        embedded: false,
    };

function buildSessionWorkspaceMetadata(metadata = {}) {
    if (typeof sessionWorkspaceHelpers?.buildWorkspaceScopeMetadata === 'function') {
        return sessionWorkspaceHelpers.buildWorkspaceScopeMetadata(metadata, SESSION_WORKSPACE_CONTEXT);
    }

    return {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    };
}

function resolveSessionWorkspaceStorageKey(storageKey = '') {
    const normalizedStorageKey = String(storageKey || '').trim();
    if (typeof sessionWorkspaceHelpers?.resolveWorkspaceScopedStorageKey === 'function') {
        return sessionWorkspaceHelpers.resolveWorkspaceScopedStorageKey(
            normalizedStorageKey,
            SESSION_WORKSPACE_CONTEXT.key,
        );
    }

    return normalizedStorageKey;
}

function normalizeSessionModel(model, fallbackModel = SESSION_DEFAULT_MODEL) {
    return resolveSessionPreferredModel([], model, fallbackModel);
}

function extractSessionReasoningSummary(value) {
    if (typeof value === 'string') {
        return String(value || '').trim();
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => extractSessionReasoningSummary(entry))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    if (!value || typeof value !== 'object') {
        return '';
    }

    if (value.type === 'reasoning') {
        const segments = [
            value.summary,
            value.summary_text,
            value.reasoning_content,
            value.reasoning,
            value.text,
            value.content,
            value.output_text,
            value.value,
        ]
            .map((candidate) => extractSessionReasoningSummary(candidate))
            .filter(Boolean);

        return [...new Set(segments)].join(' ').replace(/\s+/g, ' ').trim();
    }

    const leafCandidates = [
        value.text,
        value.output_text,
        value.summary_text,
        value.value,
    ];
    for (const candidate of leafCandidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    const directCandidates = [
        value.reasoningSummary,
        value.reasoning_summary,
        value.reasoning,
        value.reasoning_text,
        value.reasoningText,
        value.reasoning_content,
        value.reasoningContent,
        value.reasoning_details,
        value.reasoningDetails,
        value.summary,
        value.summaryText,
        value.summary_text,
    ];
    for (const candidate of directCandidates) {
        const normalized = extractSessionReasoningSummary(candidate);
        if (normalized) {
            return normalized;
        }
    }

    return '';
}

function normalizeSessionMessage(message = {}) {
    const assistantMetadata = message?.assistantMetadata && typeof message.assistantMetadata === 'object' && !Array.isArray(message.assistantMetadata)
        ? message.assistantMetadata
        : (message?.assistant_metadata && typeof message.assistant_metadata === 'object' && !Array.isArray(message.assistant_metadata)
            ? message.assistant_metadata
            : {});
    const metadata = message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? message.metadata
        : {};
    const mergedMetadata = {
        ...assistantMetadata,
        ...metadata,
    };
    const reasoningSummary = extractSessionReasoningSummary(
        message?.reasoningSummary
        || message?.reasoning_summary
        || mergedMetadata.reasoningSummary
        || mergedMetadata.reasoning_summary
        || message?.reasoning
        || message?.reasoning_text
        || message?.reasoning_content
        || message?.reasoning_details
        || message?.output
        || message?.response?.output
        || '',
    );
    const reasoningAvailable = Boolean(reasoningSummary)
        || message?.reasoningAvailable === true
        || message?.reasoning_available === true
        || mergedMetadata.reasoningAvailable === true
        || mergedMetadata.reasoning_available === true;

    if (reasoningSummary) {
        mergedMetadata.reasoningSummary = reasoningSummary;
        mergedMetadata.reasoningAvailable = true;
    } else if (reasoningAvailable) {
        mergedMetadata.reasoningAvailable = true;
    }

    return {
        ...mergedMetadata,
        ...message,
        metadata: mergedMetadata,
        ...(reasoningSummary ? { reasoningSummary } : {}),
        ...(reasoningAvailable ? { reasoningAvailable: true } : {}),
    };
}

function getSessionMessageTime(message = {}) {
    const rawTimestamp = message?.timestamp || message?.createdAt || message?.created_at || '';
    const timestamp = new Date(rawTimestamp).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function hasForegroundMarker(message = {}) {
    const metadata = message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? message.metadata
        : {};
    return message?.isStreaming === true
        && (
            metadata.pendingForeground === true
            || Boolean(String(metadata.foregroundRequestId || '').trim())
        );
}

function isStaleForegroundMessage(message = {}, now = Date.now()) {
    if (!hasForegroundMarker(message)) {
        return false;
    }

    const messageTime = getSessionMessageTime(message);
    return messageTime > 0 && now - messageTime > WEB_CHAT_STALE_FOREGROUND_MESSAGE_MS;
}

function normalizeStaleForegroundMessage(message = {}) {
    const metadata = message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? { ...message.metadata }
        : {};
    const content = String(message?.content || message?.displayContent || '').trim();
    const looksLikePlaceholder = !content || /^working in background/i.test(content);
    delete metadata.foregroundRequestId;
    metadata.pendingForeground = false;
    metadata.staleForeground = true;
    metadata.staleForegroundResolvedAt = new Date().toISOString();

    return {
        ...message,
        content: looksLikePlaceholder ? WEB_CHAT_STALE_FOREGROUND_FALLBACK : content,
        displayContent: looksLikePlaceholder ? WEB_CHAT_STALE_FOREGROUND_FALLBACK : (message.displayContent || content),
        isStreaming: false,
        metadata,
        liveState: null,
    };
}

class SessionManager extends EventTarget {
    constructor() {
        super();
        this.sessions = [];
        this.currentSessionId = null;
        this.sessionMessages = new Map(); // sessionId -> messages array
        this.apiBaseUrl = window.location.hostname === 'localhost'
            ? 'http://localhost:3000/api'
            : `${window.location.protocol}//${window.location.host}/api`;
        this.workspaceContext = SESSION_WORKSPACE_CONTEXT;
        this.storageKey = 'kimibuilt_web_chat_sessions_v4';
        this.currentSessionKey = 'kimibuilt_web_chat_current_session';
        this.deletedSessionsKey = 'kimibuilt_web_chat_deleted_sessions_v1';
        this.version = '4.0';
        this.storageAvailable = this.checkStorageAvailability();
        this.syncedStorageValues = {};
        this.deletedSessionIds = new Set();
        this.pendingPreferencePatch = {};
        this.preferenceSyncTimer = null;
        this.userPreferencesPromise = null;
        this.recoveredSessionPromotionPromise = null;
        this.activeSessionSelection = {
            sessionId: this.currentSessionId,
            selectedAt: 0,
            reason: 'initial',
        };
        
        this.resetStaleSecondaryWorkspaceCacheIfNeeded();
        this.loadFromStorage();
        this.migrateIfNeeded();
        this.userPreferencesPromise = this.loadUserPreferences();
    }

    setStorageAvailability(value) {
        this.storageAvailable = value === true;
        if (typeof window !== 'undefined') {
            window.__webChatStorageAvailable = this.storageAvailable;
        }
        return this.storageAvailable;
    }

    /**
     * Check if localStorage is available and not blocked by Tracking Prevention
     */
    checkStorageAvailability() {
        if (typeof window !== 'undefined' && typeof window.__webChatStorageAvailable === 'boolean') {
            return this.setStorageAvailability(window.__webChatStorageAvailable === true);
        }

        // Avoid eager read/write probes because privacy-focused browsers can
        // log warnings even when access is caught. Assume served pages can try
        // storage, and let the guarded getters/setters disable it on failure.
        return this.setStorageAvailability(typeof window !== 'undefined');
    }

    /**
     * Safely get item from localStorage
     */
    safeStorageGet(key) {
        const normalizedKey = String(key || '').trim();
        if (this.isSyncedStorageKey(normalizedKey) && Object.prototype.hasOwnProperty.call(this.syncedStorageValues, normalizedKey)) {
            return this.syncedStorageValues[normalizedKey];
        }
        if (!this.storageAvailable) return null;
        try {
            return localStorage.getItem(resolveSessionWorkspaceStorageKey(normalizedKey));
        } catch (e) {
            this.setStorageAvailability(false);
            return null;
        }
    }

    /**
     * Safely set item in localStorage
     */
    safeStorageSet(key, value) {
        const normalizedKey = String(key || '').trim();
        const normalizedValue = String(value);
        let wroteRemote = false;

        if (this.isSyncedStorageKey(normalizedKey)) {
            this.syncedStorageValues[normalizedKey] = normalizedValue;
            this.queueUserPreferencePatch({
                [normalizedKey]: normalizedValue,
            });
            wroteRemote = true;
        }

        if (!this.storageAvailable) return wroteRemote;
        try {
            localStorage.setItem(resolveSessionWorkspaceStorageKey(normalizedKey), normalizedValue);
            return true;
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                this.cleanupOldSessions();
                try {
                    localStorage.setItem(resolveSessionWorkspaceStorageKey(normalizedKey), normalizedValue);
                    return true;
                } catch (_quotaError) {
                    this.setStorageAvailability(false);
                }
            } else {
                this.setStorageAvailability(false);
            }
            return wroteRemote;
        }
    }

    /**
     * Safely remove item from localStorage
     */
    safeStorageRemove(key) {
        const normalizedKey = String(key || '').trim();
        let removedRemote = false;

        if (this.isSyncedStorageKey(normalizedKey)) {
            delete this.syncedStorageValues[normalizedKey];
            this.queueUserPreferencePatch({
                [normalizedKey]: null,
            });
            removedRemote = true;
        }

        if (!this.storageAvailable) return removedRemote;
        try {
            localStorage.removeItem(resolveSessionWorkspaceStorageKey(normalizedKey));
            return true;
        } catch (e) {
            this.setStorageAvailability(false);
            return removedRemote;
        }
    }

    isSyncedStorageKey(key = '') {
        return WEB_CHAT_SYNCED_STORAGE_KEYS.has(String(key || '').trim());
    }

    normalizePreferencePatch(input = {}, options = {}) {
        const source = input && typeof input === 'object' && !Array.isArray(input)
            ? input
            : {};
        const normalized = {};

        Object.entries(source).forEach(([rawKey, rawValue]) => {
            const key = String(rawKey || '').trim();
            if (!this.isSyncedStorageKey(key)) {
                return;
            }

            if (rawValue == null) {
                if (options.allowNull === true) {
                    normalized[key] = null;
                }
                return;
            }

            normalized[key] = String(rawValue);
        });

        return normalized;
    }

    readLocalSeedPreferences() {
        if (!this.storageAvailable) {
            return {};
        }

        const seededPreferences = {};
        WEB_CHAT_SYNCED_STORAGE_KEYS.forEach((key) => {
            try {
                const value = localStorage.getItem(key);
                if (value != null) {
                    seededPreferences[key] = value;
                }
            } catch (_error) {
                this.setStorageAvailability(false);
            }
        });
        return seededPreferences;
    }

    syncLocalStoragePreferences(preferences = {}, options = {}) {
        if (!this.storageAvailable) {
            return;
        }

        const values = this.normalizePreferencePatch(preferences);
        WEB_CHAT_SYNCED_STORAGE_KEYS.forEach((key) => {
            try {
                if (Object.prototype.hasOwnProperty.call(values, key)) {
                    localStorage.setItem(key, values[key]);
                    return;
                }

                if (options.removeMissing === true) {
                    localStorage.removeItem(key);
                }
            } catch (_error) {
                this.setStorageAvailability(false);
            }
        });
    }

    sleep(ms = 0) {
        const delay = Math.max(0, Number(ms) || 0);
        if (!delay) {
            return Promise.resolve();
        }

        return new Promise((resolve) => setTimeout(resolve, delay));
    }

    shouldSyncMessageToBackend(message = {}) {
        if (!message || typeof message !== 'object') {
            return false;
        }

        const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
            ? message.metadata
            : {};
        const syncSuppressed = message.backendSyncSuppressed === true
            || metadata.backendSyncSuppressed === true;
        const excludeFromTranscript = message.excludeFromTranscript === true
            || metadata.excludeFromTranscript === true;
        const syncExcludedToBackend = message.syncExcludedToBackend === true
            || metadata.syncExcludedToBackend === true;
        const clientOnly = message.clientOnly === true
            || metadata.clientOnly === true;

        return Boolean(
            message.id
            && (!clientOnly || syncExcludedToBackend)
            && (!excludeFromTranscript || syncExcludedToBackend)
            && !syncSuppressed
            && ['user', 'assistant', 'system', 'tool'].includes(message.role)
            && String(message.content || '').trim()
        );
    }

    markMessageBackendSyncSuppressed(sessionId = '', messageId = '', status = null) {
        if (!sessionId || !messageId || !this.sessionMessages.has(sessionId)) {
            return;
        }

        const messages = this.sessionMessages.get(sessionId);
        const index = messages.findIndex((entry) => entry?.id === messageId);
        if (index === -1) {
            return;
        }

        const existingMetadata = messages[index]?.metadata && typeof messages[index].metadata === 'object' && !Array.isArray(messages[index].metadata)
            ? messages[index].metadata
            : {};
        const nextMetadata = {
            ...existingMetadata,
            backendSyncSuppressed: true,
            backendSyncStatus: status,
            backendSyncSuppressedAt: new Date().toISOString(),
        };

        messages[index] = {
            ...messages[index],
            backendSyncSuppressed: true,
            backendSyncStatus: status,
            metadata: nextMetadata,
        };
        this.saveToStorage();
    }

    getPreferencesEndpoint() {
        return `${this.apiBaseUrl}/preferences/web-chat`;
    }

    async ensureUserPreferencesLoaded() {
        if (!this.userPreferencesPromise) {
            this.userPreferencesPromise = this.loadUserPreferences();
        }

        try {
            await this.userPreferencesPromise;
        } catch (_error) {
            // Preference sync should never block the rest of the UI.
        }

        return {
            ...this.syncedStorageValues,
        };
    }

    async loadUserPreferences() {
        const localSeedPreferences = this.readLocalSeedPreferences();
        const pendingPatch = this.normalizePreferencePatch(this.pendingPreferencePatch, { allowNull: true });

        try {
            const response = await fetch(this.getPreferencesEndpoint(), {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    ...buildSessionGatewayHeaders(),
                },
                credentials: 'same-origin',
                cache: 'no-store',
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json();
            const remotePreferences = this.normalizePreferencePatch(payload?.preferences || {});
            const mergedPreferences = {
                ...localSeedPreferences,
                ...remotePreferences,
            };

            Object.entries(pendingPatch).forEach(([key, value]) => {
                if (value == null) {
                    delete mergedPreferences[key];
                    return;
                }

                mergedPreferences[key] = value;
            });

            this.syncedStorageValues = mergedPreferences;
            this.syncLocalStoragePreferences(mergedPreferences, { removeMissing: true });

            const seedPatch = {};
            Object.entries(localSeedPreferences).forEach(([key, value]) => {
                if (!Object.prototype.hasOwnProperty.call(remotePreferences, key)
                    && !Object.prototype.hasOwnProperty.call(pendingPatch, key)) {
                    seedPatch[key] = value;
                }
            });

            if (Object.keys(seedPatch).length > 0) {
                this.queueUserPreferencePatch(seedPatch);
            }
        } catch (error) {
            console.warn('Failed to load synced web-chat preferences:', error);
            this.syncedStorageValues = {
                ...localSeedPreferences,
                ...this.normalizePreferencePatch(this.syncedStorageValues),
            };

            Object.entries(pendingPatch).forEach(([key, value]) => {
                if (value == null) {
                    delete this.syncedStorageValues[key];
                    return;
                }

                this.syncedStorageValues[key] = value;
            });
        }

        return {
            ...this.syncedStorageValues,
        };
    }

    queueUserPreferencePatch(patch = {}) {
        const normalizedPatch = this.normalizePreferencePatch(patch, { allowNull: true });
        if (Object.keys(normalizedPatch).length === 0) {
            return;
        }

        this.pendingPreferencePatch = {
            ...this.pendingPreferencePatch,
            ...normalizedPatch,
        };

        if (this.preferenceSyncTimer) {
            clearTimeout(this.preferenceSyncTimer);
        }

        this.preferenceSyncTimer = window.setTimeout(() => {
            this.preferenceSyncTimer = null;
            void this.flushUserPreferencePatch();
        }, WEB_CHAT_PREFERENCE_SYNC_DELAY_MS);
    }

    async flushUserPreferencePatch() {
        const patch = this.normalizePreferencePatch(this.pendingPreferencePatch, { allowNull: true });
        if (Object.keys(patch).length === 0) {
            return;
        }

        this.pendingPreferencePatch = {};

        try {
            const response = await fetch(this.getPreferencesEndpoint(), {
                method: 'PUT',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...buildSessionGatewayHeaders(),
                },
                credentials: 'same-origin',
                body: JSON.stringify({
                    preferences: patch,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json();
            const savedPreferences = this.normalizePreferencePatch(payload?.preferences || {});
            const pendingPatch = this.normalizePreferencePatch(this.pendingPreferencePatch, { allowNull: true });
            const nextPreferences = {
                ...savedPreferences,
            };

            Object.entries(pendingPatch).forEach(([key, value]) => {
                if (value == null) {
                    delete nextPreferences[key];
                    return;
                }

                nextPreferences[key] = value;
            });

            this.syncedStorageValues = nextPreferences;
            this.syncLocalStoragePreferences(nextPreferences, { removeMissing: true });
        } catch (error) {
            console.warn('Failed to save synced web-chat preferences:', error);
            this.pendingPreferencePatch = {
                ...patch,
                ...this.pendingPreferencePatch,
            };
        }
    }

    normalizeSessionTitle(title, fallback = 'New Chat') {
        const normalized = String(title || '')
            .replace(/\s+/g, ' ')
            .trim();
        return normalized || fallback;
    }

    resolveSessionTitle(session = {}, storedSession = null) {
        const backendTitle = this.normalizeSessionTitle(session?.metadata?.title || '', '');
        const storedTitle = this.normalizeSessionTitle(
            storedSession?.title || storedSession?.metadata?.title || '',
            '',
        );
        const backendProjectTitle = this.normalizeSessionTitle(
            session?.metadata?.activeProject?.title || '',
            '',
        );
        const storedProjectTitle = this.normalizeSessionTitle(
            storedSession?.metadata?.activeProject?.title || '',
            '',
        );
        const backendTimestamp = new Date(session?.updatedAt || session?.createdAt || 0).getTime();
        const storedTimestamp = new Date(storedSession?.updatedAt || storedSession?.createdAt || 0).getTime();

        if (backendTitle && (!storedTitle || (Number.isFinite(backendTimestamp) && Number.isFinite(storedTimestamp) && backendTimestamp >= storedTimestamp))) {
            return backendTitle;
        }

        if (storedTitle) {
            return storedTitle;
        }

        if (backendProjectTitle && (!storedProjectTitle || (Number.isFinite(backendTimestamp) && Number.isFinite(storedTimestamp) && backendTimestamp >= storedTimestamp))) {
            return backendProjectTitle;
        }

        if (storedProjectTitle) {
            return storedProjectTitle;
        }

        return 'New Chat';
    }

    normalizeWorkspaceScopeValue(value = '') {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._:-]+/g, '-')
            .replace(/^-+|-+$/g, '');

        return normalized || '';
    }

    normalizeWebChatWorkspaceScopeValue(value = '') {
        const normalized = this.normalizeWorkspaceScopeValue(value);
        const workspaceMatch = normalized.match(/^workspace-(\d+)$/);
        if (!workspaceMatch) {
            return normalized;
        }

        return workspaceMatch[1] === '1'
            ? 'web-chat'
            : `web-chat-workspace-${workspaceMatch[1]}`;
    }

    isWebChatWorkspaceScope(scope = '') {
        const normalizedScope = this.normalizeWebChatWorkspaceScopeValue(scope);
        return normalizedScope === 'web-chat' || normalizedScope.startsWith('web-chat-workspace-');
    }

    isSecondaryWebChatWorkspace() {
        const currentWorkspaceScope = this.normalizeWebChatWorkspaceScopeValue(
            this.workspaceContext?.scopeKey || SESSION_MANAGER_CLIENT_SURFACE,
        );

        return this.isWebChatWorkspaceScope(currentWorkspaceScope)
            && currentWorkspaceScope !== SESSION_MANAGER_CLIENT_SURFACE;
    }

    resetStaleSecondaryWorkspaceCacheIfNeeded() {
        if (!this.storageAvailable || !this.isSecondaryWebChatWorkspace()) {
            return false;
        }

        const resetKey = `kimibuilt_web_chat_workspace_cache_reset_${this.workspaceContext.key}`;
        if (this.safeStorageGet(resetKey) === WEB_CHAT_SECONDARY_WORKSPACE_CACHE_RESET_VERSION) {
            return false;
        }

        this.safeStorageRemove(this.storageKey);
        this.safeStorageRemove(this.currentSessionKey);
        this.safeStorageRemove('kimibuilt_message_draft');
        this.safeStorageRemove('kimibuilt_message_draft_time');
        this.sessions = [];
        this.sessionMessages.clear();
        this.currentSessionId = null;
        this.safeStorageSet(resetKey, WEB_CHAT_SECONDARY_WORKSPACE_CACHE_RESET_VERSION);
        return true;
    }

    getSessionWorkspaceScope(session = {}) {
        const metadata = session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
            ? session.metadata
            : {};
        const candidates = [
            metadata.workspaceKey,
            metadata.workspace_key,
            metadata.workspaceId,
            metadata.workspace_id,
            metadata.memoryScope,
            metadata.memory_scope,
            metadata.projectScope,
            metadata.project_scope,
        ];

        for (const candidate of candidates) {
            const normalized = this.normalizeWebChatWorkspaceScopeValue(candidate);
            if (this.isWebChatWorkspaceScope(normalized)) {
                return normalized;
            }
        }

        return '';
    }

    sessionBelongsToCurrentWorkspace(session = {}) {
        const sessionWorkspaceScope = this.getSessionWorkspaceScope(session);
        const currentWorkspaceScope = this.normalizeWebChatWorkspaceScopeValue(
            this.workspaceContext?.scopeKey || SESSION_MANAGER_CLIENT_SURFACE,
        );
        if (!this.isWebChatWorkspaceScope(currentWorkspaceScope)) {
            return true;
        }

        if (!sessionWorkspaceScope) {
            return currentWorkspaceScope === SESSION_MANAGER_CLIENT_SURFACE;
        }

        return sessionWorkspaceScope === currentWorkspaceScope;
    }

    filterSessionsForCurrentWorkspace(sessions = []) {
        const allowedSessionIds = new Set();
        const deletedSessionIds = this.getDeletedSessionIds();
        const filteredSessions = (Array.isArray(sessions) ? sessions : []).filter((session) => {
            if (session?.id && deletedSessionIds.has(session.id)) {
                return false;
            }

            const belongs = this.sessionBelongsToCurrentWorkspace(session);
            if (belongs && session?.id) {
                allowedSessionIds.add(session.id);
            }
            return belongs;
        });

        for (const sessionId of this.sessionMessages.keys()) {
            if (!allowedSessionIds.has(sessionId)) {
                this.sessionMessages.delete(sessionId);
            }
        }

        return filteredSessions;
    }

    getDeletedSessionIds() {
        const deletedSessionIds = new Set(this.deletedSessionIds || []);
        const rawValue = this.safeStorageGet(this.deletedSessionsKey);
        if (!rawValue) {
            return deletedSessionIds;
        }

        try {
            const parsed = JSON.parse(rawValue);
            const entries = Array.isArray(parsed)
                ? parsed
                : (Array.isArray(parsed?.ids) ? parsed.ids : []);
            entries
                .map((entry) => String(entry || '').trim())
                .filter(Boolean)
                .forEach((entry) => deletedSessionIds.add(entry));
        } catch (_error) {
            // Keep the in-memory tombstones when the stored payload is unreadable.
        }

        return deletedSessionIds;
    }

    saveDeletedSessionIds(sessionIds) {
        const ids = Array.from(sessionIds instanceof Set || Array.isArray(sessionIds) ? sessionIds : [])
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
            .slice(-500);
        this.deletedSessionIds = new Set(ids);

        this.safeStorageSet(this.deletedSessionsKey, JSON.stringify({
            version: 1,
            workspaceKey: this.workspaceContext.key,
            scopeKey: this.workspaceContext.scopeKey,
            updatedAt: new Date().toISOString(),
            ids,
        }));
    }

    markSessionDeleted(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return;
        }

        const deletedSessionIds = this.getDeletedSessionIds();
        deletedSessionIds.add(normalizedSessionId);
        this.saveDeletedSessionIds(deletedSessionIds);
    }

    forgetDeletedSession(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return;
        }

        const deletedSessionIds = this.getDeletedSessionIds();
        if (!deletedSessionIds.delete(normalizedSessionId)) {
            return;
        }

        this.saveDeletedSessionIds(deletedSessionIds);
    }

    // ============================================
    // Session Operations
    // ============================================

    rememberActiveSessionSelection(sessionId = null, reason = 'local') {
        this.activeSessionSelection = {
            sessionId: String(sessionId || '').trim(),
            selectedAt: Date.now(),
            reason: String(reason || 'local'),
        };
        return this.activeSessionSelection;
    }

    hasRecentLocalActiveSessionSelection(sessionId = null) {
        const normalizedSessionId = String(sessionId || '').trim();
        const selectedSessionId = String(this.activeSessionSelection?.sessionId || '').trim();
        if (!normalizedSessionId || normalizedSessionId !== selectedSessionId) {
            return false;
        }

        const selectedAt = Number(this.activeSessionSelection?.selectedAt) || 0;
        return selectedAt > 0 && Date.now() - selectedAt <= WEB_CHAT_ACTIVE_SESSION_LOCAL_HOLD_MS;
    }

    resolveActiveSessionAfterRefresh(backendActiveSessionId = '', options = {}) {
        const previousCurrentSessionId = String(this.currentSessionId || '').trim();
        const currentSessionStillExists = Boolean(
            previousCurrentSessionId
            && this.sessions.find((session) => session.id === previousCurrentSessionId),
        );
        const backendActiveSessionStillExists = Boolean(
            backendActiveSessionId
            && this.sessions.find((session) => session.id === backendActiveSessionId),
        );

        if (currentSessionStillExists
            && (options.preserveCurrentSession === true
                || this.hasRecentLocalActiveSessionSelection(previousCurrentSessionId))) {
            return previousCurrentSessionId;
        }

        if (backendActiveSessionStillExists) {
            return backendActiveSessionId;
        }

        if (currentSessionStillExists) {
            return previousCurrentSessionId;
        }

        return this.sessions[0]?.id || null;
    }

    async loadSessions(options = {}) {
        try {
            const params = new URLSearchParams({
                taskType: SESSION_MANAGER_TASK_TYPE,
                clientSurface: SESSION_MANAGER_CLIENT_SURFACE,
                workspaceKey: this.workspaceContext.scopeKey,
            });
            const response = await fetch(`${this.apiBaseUrl}/sessions?${params.toString()}`, {
                headers: buildSessionGatewayHeaders({
                    'Accept': 'application/json',
                }),
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            const storedSessions = new Map(this.sessions.map((session) => [session.id, session]));
            const deletedSessionIds = this.getDeletedSessionIds();
            const backendSessions = (Array.isArray(data.sessions) ? data.sessions : [])
                .filter((session) => !session?.id || !deletedSessionIds.has(session.id));

            this.sessions = backendSessions.map((session) => {
                const stored = storedSessions.get(session.id);
                const mergedMetadata = {
                    ...(stored?.metadata && typeof stored.metadata === 'object' && !Array.isArray(stored.metadata)
                        ? stored.metadata
                        : {}),
                    ...(session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
                        ? session.metadata
                        : {}),
                };
                let model;
                
                // Safely get default model
                try {
                    model = mergedMetadata.model
                        || stored?.model
                        || this.safeStorageGet('kimibuilt_default_model')
                        || SESSION_DEFAULT_MODEL;
                } catch (e) {
                    model = mergedMetadata.model || stored?.model || SESSION_DEFAULT_MODEL;
                }
                model = normalizeSessionModel(model, SESSION_DEFAULT_MODEL);
                
                return {
                    id: session.id,
                    mode: mergedMetadata.mode || stored?.mode || 'chat',
                    model: model,
                    title: this.resolveSessionTitle({
                        ...session,
                        metadata: mergedMetadata,
                    }, stored),
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                    metadata: mergedMetadata,
                    scopeKey: session.scopeKey || session.scope_key || stored?.scopeKey || this.getSessionWorkspaceScope({
                        metadata: mergedMetadata,
                    }) || this.workspaceContext.scopeKey,
                    controlState: session.controlState
                        || stored?.controlState
                        || mergedMetadata.controlState
                        || {},
                    workloadSummary: session.workloadSummary || stored?.workloadSummary || {
                        queued: 0,
                        running: 0,
                        failed: 0,
                    },
                    isLocal: false,
                    version: this.version,
                };
            });

            const knownSessionIds = new Set(this.sessions.map((session) => session.id));
            for (const [sessionId, storedSession] of storedSessions.entries()) {
                if (knownSessionIds.has(sessionId)) {
                    continue;
                }
                if (deletedSessionIds.has(sessionId)) {
                    this.sessionMessages.delete(sessionId);
                    continue;
                }

                const cachedMessages = this.sessionMessages.get(sessionId) || [];
                const shouldPreserveCachedSession = cachedMessages.some((message) => {
                    if (message.type === 'image' && (message.imageUrl || message.isLoading)) {
                        return true;
                    }

                    return Boolean(String(message.content || message.prompt || '').trim());
                });

                if (shouldPreserveCachedSession) {
                    this.sessions.push({
                        ...storedSession,
                        isLocal: true,
                        recoveredFromCache: true,
                        updatedAt: storedSession.updatedAt || new Date().toISOString(),
                    });
                    knownSessionIds.add(sessionId);
                } else if (!this.isLocalSession(sessionId)) {
                    this.sessionMessages.delete(sessionId);
                }
            }

            this.sessions.sort((a, b) => {
                return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
            });

            const backendActiveSessionId = typeof data.activeSessionId === 'string'
                ? data.activeSessionId.trim()
                : '';
            this.currentSessionId = this.resolveActiveSessionAfterRefresh(backendActiveSessionId, options);

            await this.pruneBlankSessions();
            this.saveToStorage();
            this.queueRecoveredLocalSessionPromotion();
        } catch (error) {
            console.warn('Failed to load backend sessions, using local cache:', error);
        }

        this.dispatchEvent(new CustomEvent('sessionsChanged', { 
            detail: { sessions: this.sessions } 
        }));
        return this.sessions;
    }

    queueRecoveredLocalSessionPromotion() {
        if (this.recoveredSessionPromotionPromise) {
            return this.recoveredSessionPromotionPromise;
        }

        this.recoveredSessionPromotionPromise = this.promoteRecoveredLocalSessions()
            .catch((error) => {
                console.warn('Failed to promote recovered web-chat sessions:', error);
                return [];
            })
            .finally(() => {
                this.recoveredSessionPromotionPromise = null;
            });

        return this.recoveredSessionPromotionPromise;
    }

    async persistActiveSession(sessionId = null) {
        const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';

        try {
            await fetch(`${this.apiBaseUrl}/sessions/state`, {
                method: 'PUT',
                headers: buildSessionGatewayHeaders({
                    'Content-Type': 'application/json',
                }),
                credentials: 'same-origin',
                body: JSON.stringify({
                    activeSessionId: normalizedSessionId || null,
                    taskType: SESSION_MANAGER_TASK_TYPE,
                    clientSurface: SESSION_MANAGER_CLIENT_SURFACE,
                    workspaceKey: this.workspaceContext.scopeKey,
                }),
            });
        } catch (error) {
            console.warn('Failed to persist active session state:', error);
        }
    }

    hydrateBackendMessage(message = {}) {
        const normalizedMessage = normalizeSessionMessage(message);

        return {
            ...normalizedMessage,
            id: normalizedMessage.id || this.generateLocalId(),
            timestamp: normalizedMessage.timestamp || new Date().toISOString(),
        };
    }

    normalizeStaleForegroundMessages(messages = []) {
        const now = Date.now();
        return (Array.isArray(messages) ? messages : []).map((message) => (
            isStaleForegroundMessage(message, now)
                ? normalizeStaleForegroundMessage(message)
                : message
        ));
    }

    mergeBackendMessages(sessionId, backendMessages = []) {
        const localMessages = this.getMessages(sessionId);
        const mergedMessages = backendMessages.map((message) => {
            const localMatch = localMessages.find((entry) => entry.id === message.id);
            return localMatch
                ? {
                    ...localMatch,
                    ...message,
                    metadata: message.metadata || localMatch.metadata || {},
                }
                : message;
        });

        const backendIds = new Set(backendMessages.map((message) => message.id).filter(Boolean));
        const preservedLocalMessages = localMessages.filter((message) => (
            message?.clientOnly === true
            && message?.id
            && !backendIds.has(message.id)
        ));

        return this.normalizeStaleForegroundMessages([...mergedMessages, ...preservedLocalMessages])
            .sort((left, right) => new Date(left.timestamp || 0).getTime() - new Date(right.timestamp || 0).getTime());
    }

    async syncMessagesToBackend(sessionId, messages = []) {
        if (!sessionId || this.isLocalSession(sessionId) || !Array.isArray(messages) || messages.length === 0) {
            return false;
        }

        const syncableMessages = messages.filter((message) => this.shouldSyncMessageToBackend(message));
        if (syncableMessages.length === 0) {
            return true;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`, {
                method: 'POST',
                headers: buildSessionGatewayHeaders({
                    'Content-Type': 'application/json',
                }),
                credentials: 'same-origin',
                body: JSON.stringify({ messages: syncableMessages }),
            });

            if (!response.ok) {
                if (WEB_CHAT_TERMINAL_SYNC_STATUSES.has(response.status)) {
                    syncableMessages.forEach((message) => {
                        this.markMessageBackendSyncSuppressed(sessionId, message.id, response.status);
                    });
                }
                throw new Error(`HTTP ${response.status}`);
            }

            return true;
        } catch (error) {
            console.warn('Failed to sync backend session messages:', error);
            return false;
        }
    }

    async syncMessageToBackend(sessionId, message, options = {}) {
        if (!sessionId || this.isLocalSession(sessionId) || !message?.id) {
            return false;
        }
        if (!this.shouldSyncMessageToBackend(message)) {
            return true;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(message.id)}`, {
                method: 'PUT',
                headers: buildSessionGatewayHeaders({
                    'Content-Type': 'application/json',
                }),
                credentials: 'same-origin',
                body: JSON.stringify({ message }),
            });

            if (!response.ok) {
                if (WEB_CHAT_TERMINAL_SYNC_STATUSES.has(response.status)) {
                    this.markMessageBackendSyncSuppressed(sessionId, message.id, response.status);
                    if (options.quietTerminal === true) {
                        return false;
                    }
                }
                if (response.status === 429 && options.throwOnRateLimit === true) {
                    const error = new Error(`HTTP ${response.status}`);
                    error.status = response.status;
                    throw error;
                }
                throw new Error(`HTTP ${response.status}`);
            }

            return true;
        } catch (error) {
            if (error?.status === 429 && options.throwOnRateLimit === true) {
                throw error;
            }
            console.warn('Failed to sync backend session message:', error);
            return false;
        }
    }

    async syncRecoveredMessagesToBackend(sessionId, messages = []) {
        const syncableMessages = Array.isArray(messages)
            ? messages.filter((message) => this.shouldSyncMessageToBackend(message))
            : [];

        let syncedCount = 0;
        for (const message of syncableMessages) {
            let synced = false;
            try {
                synced = await this.syncMessageToBackend(sessionId, message, {
                    quietTerminal: true,
                    throwOnRateLimit: true,
                });
            } catch (error) {
                if (error?.status === 429) {
                    console.warn('Paused recovered session message sync after rate limit response:', error);
                    break;
                }
                console.warn('Failed to sync recovered session message:', error);
            }
            if (synced) {
                syncedCount += 1;
            }

            await this.sleep(WEB_CHAT_RECOVERED_MESSAGE_SYNC_DELAY_MS);
        }

        return syncedCount;
    }

    async loadSessionMessagesFromBackend(sessionId, options = {}) {
        if (!sessionId || this.isLocalSession(sessionId)) {
            return this.getMessages(sessionId);
        }

        const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 200;

        try {
            const response = await fetch(`${this.apiBaseUrl}/sessions/${sessionId}/messages?limit=${encodeURIComponent(limit)}`, {
                headers: buildSessionGatewayHeaders({
                    'Accept': 'application/json',
                }),
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            const backendMessages = Array.isArray(data.messages)
                ? data.messages.map((message) => this.hydrateBackendMessage(message))
                : [];
            const messages = this.mergeBackendMessages(sessionId, backendMessages);

            this.sessionMessages.set(sessionId, messages);
            this.saveToStorage();
            return messages;
        } catch (error) {
            console.warn('Failed to load backend session messages:', error);
            return this.getMessages(sessionId);
        }
    }

    async pruneBlankSessions() {
        const sessionsToRemove = this.sessions.filter((session) => {
            return this.isLocalSession(session.id) && this.isBlankSession(session);
        });

        if (sessionsToRemove.length === 0) {
            return;
        }

        for (const session of sessionsToRemove) {
            this.sessionMessages.delete(session.id);
        }

        const removedIds = new Set(sessionsToRemove.map((session) => session.id));
        this.sessions = this.sessions.filter((session) => !removedIds.has(session.id));

        if (removedIds.has(this.currentSessionId)) {
            this.currentSessionId = this.sessions[0]?.id || null;
        }
    }

    async promoteRecoveredLocalSessions() {
        const recoveredSessions = this.sessions.filter((session) => (
            this.isLocalSession(session.id)
            && session.recoveredFromCache === true
            && !this.isBlankSession(session)
        ));

        if (recoveredSessions.length === 0) {
            return [];
        }

        const promoted = [];
        for (const session of recoveredSessions) {
            const promotedSession = await this.promoteLocalSessionToBackend(session);
            if (promotedSession) {
                promoted.push(promotedSession);
            }
        }

        return promoted;
    }

    async promoteLocalSessionToBackend(localSession) {
        const previousSessionId = String(localSession?.id || '').trim();
        if (!previousSessionId || !this.isLocalSession(previousSessionId)) {
            return null;
        }

        const metadata = localSession?.metadata && typeof localSession.metadata === 'object' && !Array.isArray(localSession.metadata)
            ? localSession.metadata
            : {};
        const mode = localSession.mode || metadata.mode || SESSION_MANAGER_TASK_TYPE;
        const title = this.normalizeSessionTitle(localSession.title || metadata.title || '', '');
        const model = normalizeSessionModel(localSession.model || metadata.model || SESSION_DEFAULT_MODEL);

        try {
            const response = await fetch(`${this.apiBaseUrl}/sessions`, {
                method: 'POST',
                headers: buildSessionGatewayHeaders({
                    'Content-Type': 'application/json',
                }),
                credentials: 'same-origin',
                body: JSON.stringify({
                    taskType: SESSION_MANAGER_TASK_TYPE,
                    clientSurface: SESSION_MANAGER_CLIENT_SURFACE,
                    workspaceKey: this.workspaceContext.scopeKey,
                    metadata: buildSessionWorkspaceMetadata({
                        ...metadata,
                        mode,
                        title,
                        model,
                        taskType: SESSION_MANAGER_TASK_TYPE,
                        clientSurface: SESSION_MANAGER_CLIENT_SURFACE,
                    }),
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const backendSession = await response.json();
            const backendSessionId = String(backendSession?.id || '').trim();
            if (!backendSessionId) {
                throw new Error('Backend session response did not include an id');
            }

            this.promoteSessionId(previousSessionId, backendSessionId);
            const messages = this.getMessages(backendSessionId);
            await this.syncRecoveredMessagesToBackend(backendSessionId, messages);

            if (title && title !== 'New Chat') {
                await this.persistSessionMetadata(backendSessionId, { title });
            }

            return this.sessions.find((entry) => entry.id === backendSessionId) || null;
        } catch (error) {
            console.warn('Failed to promote cached workspace session to backend:', error);
            return null;
        }
    }

    isBlankSession(session) {
        if (!session) {
            return false;
        }

        const messages = this.sessionMessages.get(session.id) || [];
        const hasMessages = messages.some((message) => {
            if (message.type === 'image' && (message.imageUrl || message.isLoading)) {
                return true;
            }

            return Boolean(String(message.content || message.prompt || '').trim());
        });

        const normalizedTitle = String(session.title || '').trim();
        const isDefaultTitle = !normalizedTitle || normalizedTitle === 'New Chat';

        return !hasMessages && isDefaultTitle;
    }
    async createSession(mode = 'chat', options = {}) {
        let defaultModel;
        try {
            defaultModel = normalizeSessionModel(
                this.safeStorageGet('kimibuilt_default_model'),
                SESSION_DEFAULT_MODEL,
            );
        } catch (e) {
            defaultModel = SESSION_DEFAULT_MODEL;
        }
        
        let sessionId = this.generateLocalId();
        let createdAt = new Date().toISOString();
        let updatedAt = createdAt;
        let isLocal = true;
        let backendSession = null;

        try {
            const response = await fetch(`${this.apiBaseUrl}/sessions`, {
                method: 'POST',
                headers: buildSessionGatewayHeaders({
                    'Content-Type': 'application/json',
                }),
                credentials: 'same-origin',
                body: JSON.stringify({
                    taskType: SESSION_MANAGER_TASK_TYPE,
                    clientSurface: SESSION_MANAGER_CLIENT_SURFACE,
                    workspaceKey: this.workspaceContext.scopeKey,
                    metadata: buildSessionWorkspaceMetadata({
                        mode,
                        taskType: SESSION_MANAGER_TASK_TYPE,
                        clientSurface: SESSION_MANAGER_CLIENT_SURFACE,
                        sessionIsolation: true,
                    }),
                }),
            });

            if (response.ok) {
                backendSession = await response.json();
                sessionId = backendSession.id;
                createdAt = backendSession.createdAt || createdAt;
                updatedAt = backendSession.updatedAt || updatedAt;
                isLocal = false;
            }
        } catch (error) {
            console.warn('Failed to create backend session, using local session:', error);
        }

        const localSession = {
            id: sessionId,
            mode,
            model: normalizeSessionModel(options.model, defaultModel),
            title: 'New Chat',
            createdAt,
            updatedAt,
            metadata: backendSession?.metadata || buildSessionWorkspaceMetadata({
                mode,
                taskType: SESSION_MANAGER_TASK_TYPE,
                clientSurface: SESSION_MANAGER_CLIENT_SURFACE,
                sessionIsolation: true,
            }),
            scopeKey: backendSession?.scopeKey || backendSession?.scope_key || this.workspaceContext.scopeKey,
            controlState: backendSession?.controlState
                || backendSession?.metadata?.controlState
                || {},
            workloadSummary: {
                queued: 0,
                running: 0,
                failed: 0,
            },
            isLocal,
            version: this.version
        };
        
        this.sessions.unshift(localSession);
        this.sessionMessages.set(localSession.id, []);
        this.currentSessionId = localSession.id;
        this.rememberActiveSessionSelection(localSession.id, 'created');

        this.saveToStorage();
        if (!isLocal) {
            void this.persistActiveSession(localSession.id);
        }
        this.dispatchEvent(new CustomEvent('sessionCreated', { 
            detail: { session: localSession, isLocal: true } 
        }));
        this.dispatchEvent(new CustomEvent('sessionsChanged', { 
            detail: { sessions: this.sessions } 
        }));
        
        return localSession;
    }

    async deleteSession(sessionId) {
        this.markSessionDeleted(sessionId);

        if (!this.isLocalSession(sessionId)) {
            try {
                await fetch(`${this.apiBaseUrl}/sessions/${sessionId}`, {
                    method: 'DELETE',
                    headers: buildSessionGatewayHeaders(),
                    credentials: 'same-origin',
                });
            } catch (error) {
                console.warn('Failed to delete backend session:', error);
            }
        }

        // Remove from local state
        this.sessions = this.sessions.filter(s => s.id !== sessionId);
        this.sessionMessages.delete(sessionId);
        
        if (this.currentSessionId === sessionId) {
            this.currentSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
            this.rememberActiveSessionSelection(this.currentSessionId, 'deleted');
        }

        this.saveToStorage();
        if (this.currentSessionId) {
            if (!this.isLocalSession(this.currentSessionId)) {
                void this.persistActiveSession(this.currentSessionId);
            }
        } else {
            void this.persistActiveSession(null);
        }
        this.dispatchEvent(new CustomEvent('sessionDeleted', { 
            detail: { sessionId, newCurrentSessionId: this.currentSessionId } 
        }));
        this.dispatchEvent(new CustomEvent('sessionsChanged', { 
            detail: { sessions: this.sessions } 
        }));
        
        return true;
    }

    switchSession(sessionId) {
        if (!this.sessions.find(s => s.id === sessionId)) {
            console.error('Session not found:', sessionId);
            return false;
        }
        
        const previousSessionId = this.currentSessionId;
        this.currentSessionId = sessionId;
        this.rememberActiveSessionSelection(sessionId, 'switched');
        this.safeStorageSet(this.currentSessionKey, sessionId);
        if (!this.isLocalSession(sessionId)) {
            void this.persistActiveSession(sessionId);
        }

        const messages = this.sessionMessages.get(sessionId) || [];
        this.dispatchEvent(new CustomEvent('sessionSwitched', { 
            detail: { sessionId, previousSessionId, messages } 
        }));
        
        return true;
    }

    promoteSessionId(oldSessionId, newSessionId) {
        const previousSessionId = oldSessionId || this.currentSessionId;

        if (!newSessionId) {
            return previousSessionId;
        }

        if (previousSessionId === newSessionId) {
            const session = this.sessions.find((entry) => entry.id === newSessionId);
            if (session) {
                session.isLocal = false;
            }
            this.currentSessionId = newSessionId;
            this.saveToStorage();
            return newSessionId;
        }

        const previousMessages = this.sessionMessages.get(previousSessionId) || [];
        const existingMessages = this.sessionMessages.get(newSessionId) || [];
        const mergedMessages = [...existingMessages];

        previousMessages.forEach((message) => {
            const duplicate = mergedMessages.some((candidate) =>
                candidate.id === message.id
                || (
                    candidate.role === message.role
                    && candidate.content === message.content
                    && candidate.timestamp === message.timestamp
                ));

            if (!duplicate) {
                mergedMessages.push(message);
            }
        });

        const previousSession = this.sessions.find((entry) => entry.id === previousSessionId);
        const existingSession = this.sessions.find((entry) => entry.id === newSessionId);

        if (previousSession) {
            if (existingSession && existingSession !== previousSession) {
                existingSession.title = existingSession.title === 'New Chat' ? previousSession.title : existingSession.title;
                existingSession.model = existingSession.model || previousSession.model;
                existingSession.mode = existingSession.mode || previousSession.mode;
                existingSession.isLocal = false;
                this.sessions = this.sessions.filter((entry) => entry.id !== previousSessionId);
            } else {
                previousSession.id = newSessionId;
                previousSession.isLocal = false;
            }
        } else if (!existingSession) {
            let defaultModel = SESSION_DEFAULT_MODEL;
            try {
                defaultModel = normalizeSessionModel(
                    this.safeStorageGet('kimibuilt_default_model'),
                    SESSION_DEFAULT_MODEL,
                );
            } catch (_error) {
                defaultModel = SESSION_DEFAULT_MODEL;
            }
            this.sessions.unshift({
                id: newSessionId,
                mode: 'chat',
                model: defaultModel,
                title: 'New Chat',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                workloadSummary: {
                    queued: 0,
                    running: 0,
                    failed: 0,
                },
                isLocal: false,
                version: this.version,
            });
        }

        if (previousSessionId && previousSessionId !== newSessionId) {
            this.sessionMessages.delete(previousSessionId);
        }
        this.sessionMessages.set(newSessionId, mergedMessages);

        if (this.currentSessionId === previousSessionId || !this.currentSessionId) {
            this.currentSessionId = newSessionId;
        }

        this.saveToStorage();
        if (!this.isLocalSession(newSessionId) && this.currentSessionId === newSessionId) {
            void this.persistActiveSession(newSessionId);
            const promotedSession = this.sessions.find((entry) => entry.id === newSessionId);
            const promotedTitle = this.normalizeSessionTitle(promotedSession?.title || '', '');
            if (promotedTitle && promotedTitle !== 'New Chat') {
                void this.persistSessionMetadata(newSessionId, { title: promotedTitle });
            }
        }
        this.dispatchEvent(new CustomEvent('sessionPromoted', {
            detail: {
                previousSessionId,
                sessionId: newSessionId,
                messages: mergedMessages,
            },
        }));
        this.dispatchEvent(new CustomEvent('sessionsChanged', {
            detail: { sessions: this.sessions },
        }));

        return newSessionId;
    }

    updateSessionTitleLocally(sessionId, title, options = {}) {
        const session = this.sessions.find((entry) => entry.id === sessionId);
        if (!session) {
            return null;
        }

        const nextTitle = this.normalizeSessionTitle(title);
        const previousTitle = this.normalizeSessionTitle(session.title, '');
        const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
            ? session.metadata
            : {};

        session.title = nextTitle;
        session.metadata = {
            ...metadata,
            title: nextTitle,
        };

        if (options.touchUpdatedAt !== false) {
            session.updatedAt = new Date().toISOString();
        }

        if (options.save !== false) {
            this.saveToStorage();
        }

        if (options.dispatch !== false && (previousTitle !== nextTitle || options.forceDispatch === true)) {
            this.dispatchEvent(new CustomEvent('sessionsChanged', {
                detail: { sessions: this.sessions },
            }));
        }

        return session;
    }

    async persistSessionMetadata(sessionId, metadataPatch = {}) {
        const session = this.sessions.find((entry) => entry.id === sessionId);
        if (!session || this.isLocalSession(sessionId)) {
            return true;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
                method: 'PATCH',
                headers: buildSessionGatewayHeaders({
                    'Content-Type': 'application/json',
                }),
                credentials: 'same-origin',
                body: JSON.stringify({
                    metadata: metadataPatch,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const savedSession = await response.json();
            const targetSession = this.sessions.find((entry) => entry.id === sessionId);
            if (targetSession) {
                const savedMetadata = savedSession?.metadata && typeof savedSession.metadata === 'object' && !Array.isArray(savedSession.metadata)
                    ? savedSession.metadata
                    : {};
                targetSession.metadata = {
                    ...(targetSession.metadata || {}),
                    ...savedMetadata,
                };
                targetSession.updatedAt = savedSession?.updatedAt || targetSession.updatedAt || new Date().toISOString();
                targetSession.title = this.resolveSessionTitle({
                    ...savedSession,
                    metadata: targetSession.metadata,
                    updatedAt: targetSession.updatedAt,
                }, targetSession);
                this.saveToStorage();
                this.dispatchEvent(new CustomEvent('sessionsChanged', {
                    detail: { sessions: this.sessions },
                }));
            }

            return true;
        } catch (error) {
            console.warn('Failed to persist backend session metadata:', error);
            return false;
        }
    }

    mergeSessionMetadataLocally(sessionId, metadataPatch = {}) {
        const targetSession = this.sessions.find((entry) => entry.id === sessionId);
        if (!targetSession || !metadataPatch || typeof metadataPatch !== 'object' || Array.isArray(metadataPatch)) {
            return null;
        }

        const nextMetadata = {
            ...(targetSession.metadata || {}),
            ...metadataPatch,
        };

        if (metadataPatch.activeProject && typeof metadataPatch.activeProject === 'object' && !Array.isArray(metadataPatch.activeProject)) {
            nextMetadata.activeProject = {
                ...(targetSession.metadata?.activeProject || {}),
                ...metadataPatch.activeProject,
            };
        }

        targetSession.metadata = nextMetadata;
        targetSession.updatedAt = new Date().toISOString();
        targetSession.title = this.resolveSessionTitle({
            ...targetSession,
            metadata: nextMetadata,
        }, targetSession);
        this.saveToStorage();
        this.dispatchEvent(new CustomEvent('sessionsChanged', {
            detail: { sessions: this.sessions },
        }));
        return targetSession;
    }

    async renameSession(sessionId, title) {
        const session = this.updateSessionTitleLocally(sessionId, title);
        if (!session) {
            return { session: null, persisted: false };
        }

        const persisted = await this.persistSessionMetadata(sessionId, {
            title: session.title,
        });

        return {
            session,
            persisted,
        };
    }

    setSessionModel(sessionId, model) {
        const session = this.sessions.find(s => s.id === sessionId);
        if (session) {
            session.model = model;
            this.saveToStorage();
        }
    }

    // ============================================
    // Message Operations
    // ============================================

    addMessage(sessionId, message) {
        if (!this.sessionMessages.has(sessionId)) {
            this.sessionMessages.set(sessionId, []);
        }
        
        const messages = this.sessionMessages.get(sessionId);
        const hasExplicitId = typeof message?.id === 'string' && message.id.trim();
        
        // Check for duplicate messages (by content and timestamp within 1 second)
        const isDuplicate = !hasExplicitId && messages.some((m) =>
            m.role === message.role
            && m.content === message.content
            && Math.abs(new Date(m.timestamp) - new Date(message.timestamp)) < 1000
        );
        
        if (isDuplicate) {
            return messages[messages.length - 1];
        }
        
        const messageWithMeta = {
            ...normalizeSessionMessage(message),
            id: message.id || this.generateLocalId(),
            timestamp: message.timestamp || new Date().toISOString(),
        };
        
        messages.push(messageWithMeta);
        
        // Update session title from first user message if it's still default
        const session = this.sessions.find(s => s.id === sessionId);
        if (session
            && !session?.metadata?.activeProject?.title
            && (session.title === 'New Chat' || !session.title)
            && message.role === 'user') {
            const generatedTitle = this.generateTitleFromMessage(message.content);
            this.updateSessionTitleLocally(sessionId, generatedTitle);
            if (!this.isLocalSession(sessionId)) {
                void this.persistSessionMetadata(sessionId, { title: generatedTitle });
            }
        }
        
        // Update session timestamp
        if (session) {
            session.updatedAt = new Date().toISOString();
        }
        
        this.saveToStorage();
        return messageWithMeta;
    }

    upsertMessage(sessionId, message) {
        if (!message || !sessionId) {
            return null;
        }

        if (!this.sessionMessages.has(sessionId)) {
            this.sessionMessages.set(sessionId, []);
        }

        const messages = this.sessionMessages.get(sessionId);
        const messageId = message.id || null;
        const index = messageId
            ? messages.findIndex((entry) => entry.id === messageId)
            : -1;

        if (index === -1) {
            return this.addMessage(sessionId, message);
        }

        const mergedMessage = {
            ...normalizeSessionMessage({
                ...messages[index],
                ...message,
            }),
            id: messages[index].id,
            timestamp: message.timestamp || messages[index].timestamp || new Date().toISOString(),
        };

        messages[index] = mergedMessage;

        const session = this.sessions.find((entry) => entry.id === sessionId);
        if (session) {
            session.updatedAt = new Date().toISOString();
        }

        this.saveToStorage();
        return mergedMessage;
    }

    updateLastMessage(sessionId, content) {
        if (!this.sessionMessages.has(sessionId)) {
            return false;
        }
        
        const messages = this.sessionMessages.get(sessionId);
        const lastMessage = messages[messages.length - 1];
        
        if (lastMessage && lastMessage.role === 'assistant') {
            lastMessage.content = content;
            lastMessage.isStreaming = true;
            this.saveToStorage();
            return true;
        }
        
        return false;
    }

    finalizeLastMessage(sessionId) {
        if (!this.sessionMessages.has(sessionId)) {
            return false;
        }
        
        const messages = this.sessionMessages.get(sessionId);
        const lastMessage = messages[messages.length - 1];
        
        if (lastMessage && lastMessage.role === 'assistant') {
            lastMessage.isStreaming = false;
            lastMessage.timestamp = new Date().toISOString();
            this.saveToStorage();
            return true;
        }
        
        return false;
    }

    clearSessionMessages(sessionId) {
        if (this.sessionMessages.has(sessionId)) {
            this.sessionMessages.set(sessionId, []);
            
            // Reset session title
            const session = this.sessions.find(s => s.id === sessionId);
            if (session) {
                session.title = 'New Chat';
                session.metadata = {
                    ...(session.metadata || {}),
                    title: 'New Chat',
                };
                session.updatedAt = new Date().toISOString();
            }
            
            this.saveToStorage();
            this.dispatchEvent(new CustomEvent('messagesCleared', { 
                detail: { sessionId } 
            }));
            this.dispatchEvent(new CustomEvent('sessionsChanged', { 
                detail: { sessions: this.sessions } 
            }));
            return true;
        }
        return false;
    }

    getMessages(sessionId) {
        return this.sessionMessages.get(sessionId) || [];
    }

    getMessage(sessionId, messageId) {
        return this.getMessages(sessionId).find((message) => message.id === messageId) || null;
    }

    getCurrentSession() {
        return this.sessions.find(s => s.id === this.currentSessionId);
    }

    getCurrentMessages() {
        return this.currentSessionId ? this.getMessages(this.currentSessionId) : [];
    }

    // ============================================
    // Storage
    // ============================================

    trimCachedString(value = '') {
        const text = String(value || '');
        if (text.length <= WEB_CHAT_LOCAL_CACHE_STRING_LIMIT) {
            return text;
        }

        return `${text.slice(0, WEB_CHAT_LOCAL_CACHE_STRING_LIMIT)}\n[local cache truncated]`;
    }

    sanitizeValueForLocalCache(value, depth = 0) {
        if (typeof value === 'string') {
            return this.trimCachedString(value);
        }
        if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
            return value;
        }
        if (depth >= WEB_CHAT_LOCAL_CACHE_OBJECT_DEPTH_LIMIT) {
            return Array.isArray(value) ? [] : {};
        }
        if (Array.isArray(value)) {
            return value
                .slice(0, WEB_CHAT_LOCAL_CACHE_ARRAY_LIMIT)
                .map((entry) => this.sanitizeValueForLocalCache(entry, depth + 1));
        }
        if (typeof value !== 'object') {
            return null;
        }

        const sanitized = {};
        Object.entries(value).forEach(([key, entry]) => {
            if (WEB_CHAT_LOCAL_CACHE_HEAVY_KEYS.has(key)) {
                return;
            }

            if (typeof entry === 'string' && /^data:(?:image|audio|video|application)\//i.test(entry)) {
                return;
            }

            sanitized[key] = this.sanitizeValueForLocalCache(entry, depth + 1);
        });
        return sanitized;
    }

    buildLocalCacheSessions() {
        return this.sessions
            .slice(0, WEB_CHAT_LOCAL_CACHE_SESSION_LIMIT)
            .map((session) => this.sanitizeValueForLocalCache(session));
    }

    buildLocalCacheMessages(sessionIds = new Set()) {
        const allowedSessionIds = sessionIds instanceof Set
            ? sessionIds
            : new Set(Array.from(sessionIds || []));

        return Array.from(this.sessionMessages.entries())
            .filter(([sessionId]) => allowedSessionIds.has(sessionId))
            .map(([sessionId, messages]) => [
                sessionId,
                (Array.isArray(messages) ? messages : [])
                    .slice(-WEB_CHAT_LOCAL_CACHE_MESSAGES_PER_SESSION)
                    .map((message) => this.sanitizeValueForLocalCache(message)),
            ]);
    }

    saveToStorage() {
        if (!this.storageAvailable) {
            return false;
        }

        try {
            const cachedSessions = this.buildLocalCacheSessions();
            const cachedSessionIds = new Set(cachedSessions.map((session) => session?.id).filter(Boolean));
            const data = {
                version: this.version,
                lastSaved: new Date().toISOString(),
                cachePolicy: {
                    sessionLimit: WEB_CHAT_LOCAL_CACHE_SESSION_LIMIT,
                    messagesPerSession: WEB_CHAT_LOCAL_CACHE_MESSAGES_PER_SESSION,
                    stringLimit: WEB_CHAT_LOCAL_CACHE_STRING_LIMIT,
                },
                sessions: cachedSessions,
                messages: this.buildLocalCacheMessages(cachedSessionIds)
            };
            
            const serialized = JSON.stringify(data);
            
            // Check size limit (5MB is typical for localStorage)
            if (serialized.length > 4.5 * 1024 * 1024) {
                console.warn('Session storage approaching limit, consider cleanup');
                // Could implement LRU cleanup here
            }
            
            this.safeStorageSet(this.storageKey, serialized);
            this.safeStorageSet(this.currentSessionKey, this.currentSessionId || '');
            return true;
        } catch (error) {
            if (error.name === 'QuotaExceededError') {
                console.error('Storage quota exceeded, cleaning up old sessions');
                this.cleanupOldSessions();
            } else {
                console.error('Failed to save to localStorage:', error);
            }
            return false;
        }
    }

    loadFromStorage() {
        if (!this.storageAvailable) {
            return;
        }

        try {
            const data = this.safeStorageGet(this.storageKey);
            if (data) {
                const parsed = JSON.parse(data);
                
                // Handle version migration if needed
                if (parsed.version) {
                    this.sessions = parsed.sessions || [];
                    this.sessionMessages = new Map(parsed.messages || []);
                } else {
                    // Legacy format
                    this.sessions = parsed.sessions || [];
                    this.sessionMessages = new Map(parsed.messages || []);
                }
                this.sessions = this.filterSessionsForCurrentWorkspace(this.sessions);
                this.sessionMessages = new Map(Array.from(this.sessionMessages.entries()).map(([sessionId, messages]) => [
                    sessionId,
                    this.normalizeStaleForegroundMessages(messages),
                ]));
            }
            
            const currentId = this.safeStorageGet(this.currentSessionKey);
            if (currentId && this.sessions.find(s => s.id === currentId)) {
                this.currentSessionId = currentId;
            } else if (this.sessions.length > 0) {
                this.currentSessionId = this.sessions[0].id;
            }
        } catch (error) {
            console.error('Failed to load from localStorage:', error);
            // Reset to clean state on error
            this.sessions = [];
            this.sessionMessages = new Map();
            this.currentSessionId = null;
        }
    }

    cleanupOldSessions() {
        // Keep only the 20 most recent sessions
        if (this.sessions.length > 20) {
            const sessionsToRemove = this.sessions.slice(20);
            sessionsToRemove.forEach(s => {
                this.sessionMessages.delete(s.id);
            });
            this.sessions = this.sessions.slice(0, 20);
            this.saveToStorage();
        }
    }

    clearStorage() {
        if (!this.storageAvailable) {
            this.sessions = [];
            this.sessionMessages.clear();
            this.currentSessionId = null;
            return;
        }

        this.safeStorageRemove(this.storageKey);
        this.safeStorageRemove(this.currentSessionKey);
        this.sessions = [];
        this.sessionMessages.clear();
        this.currentSessionId = null;
    }

    migrateIfNeeded() {
        if (!this.storageAvailable) {
            return;
        }

        if (this.isSecondaryWebChatWorkspace()) {
            return;
        }

        // Migration from v1/v2 to v3
        const oldKeys = ['kimibuilt_sessions_v2', 'kimibuilt_sessions'];
        
        for (const oldKey of oldKeys) {
            const oldData = this.safeStorageGet(oldKey);
            const currentData = this.safeStorageGet(this.storageKey);
            
            if (oldData && !currentData) {
                try {
                    const parsed = JSON.parse(oldData);
                    this.sessions = parsed.sessions || [];
                    this.sessionMessages = new Map(parsed.messages || []);
                    
                    // Add model field to sessions that don't have it
                    this.sessions.forEach(s => {
                        if (!s.model) {
                            try {
                                s.model = this.safeStorageGet('kimibuilt_default_model') || SESSION_DEFAULT_MODEL;
                            } catch (e) {
                                s.model = SESSION_DEFAULT_MODEL;
                            }
                        }
                        s.model = normalizeSessionModel(s.model, SESSION_DEFAULT_MODEL);
                        if (!s.version) {
                            s.version = this.version;
                        }
                    });
                    
                    this.saveToStorage();
                    this.safeStorageRemove(oldKey);
                    console.log(`Migrated sessions from ${oldKey} to v3`);
                    return;
                } catch (e) {
                    console.error('Migration failed:', e);
                }
            }
        }
    }

    // ============================================
    // Import/Export
    // ============================================

    /**
     * Export all sessions and messages
     */
    exportAll() {
        const data = {
            version: this.version,
            exportedAt: new Date().toISOString(),
            sessions: this.sessions,
            messages: Array.from(this.sessionMessages.entries())
        };
        return JSON.stringify(data, null, 2);
    }

    /**
     * Import sessions and messages from JSON
     */
    importAll(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            
            // Validate structure
            if (!data.sessions || !Array.isArray(data.sessions)) {
                throw new Error('Invalid import data: sessions array missing');
            }
            if (!data.messages || !Array.isArray(data.messages)) {
                throw new Error('Invalid import data: messages array missing');
            }
            
            // Merge with existing sessions (avoid duplicates by ID)
            const existingIds = new Set(this.sessions.map(s => s.id));
            
            let importedCount = 0;
            data.sessions.forEach(session => {
                // Generate new ID if duplicate
                if (existingIds.has(session.id)) {
                    const oldId = session.id;
                    session.id = this.generateLocalId();
                    session.isLocal = true; // Mark as local since it's a copy
                    
                    // Update messages to point to new ID
                    const sessionMessages = data.messages.find(([id]) => id === oldId);
                    if (sessionMessages) {
                        sessionMessages[0] = session.id;
                    }
                }
                
                // Ensure version
                if (!session.version) {
                    session.version = this.version;
                }
                
                this.sessions.push(session);
                existingIds.add(session.id);
                importedCount++;
            });
            
            // Import messages
            data.messages.forEach(([sessionId, messages]) => {
                if (!this.sessionMessages.has(sessionId)) {
                    this.sessionMessages.set(sessionId, messages);
                }
            });
            
            this.saveToStorage();
            
            this.dispatchEvent(new CustomEvent('sessionsChanged', { 
                detail: { sessions: this.sessions } 
            }));
            
            return { success: true, importedCount };
        } catch (error) {
            console.error('Import failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Validate import data without importing
     */
    validateImport(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            
            if (!data.sessions || !Array.isArray(data.sessions)) {
                return { valid: false, error: 'Missing sessions array' };
            }
            if (!data.messages || !Array.isArray(data.messages)) {
                return { valid: false, error: 'Missing messages array' };
            }
            
            const sessionCount = data.sessions.length;
            const messageCount = data.messages.reduce((acc, [, msgs]) => acc + (msgs?.length || 0), 0);
            
            return { 
                valid: true, 
                sessionCount, 
                messageCount,
                version: data.version || 'unknown',
                exportedAt: data.exportedAt || 'unknown'
            };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    // ============================================
    // Utilities
    // ============================================

    generateLocalId() {
        return 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    isLocalSession(sessionId) {
        const session = this.sessions.find(s => s.id === sessionId);
        return session?.isLocal || String(sessionId).startsWith('local_');
    }

    generateTitle(session) {
        if (session.title) return session.title;
        if (session.name) return session.name;
        return 'Chat';
    }

    generateTitleFromMessage(content) {
        // Extract first sentence or first 50 characters
        const clean = content.trim();
        
        // Remove common prefixes and commands
        const prefixes = ['please', 'can you', 'could you', 'would you', 'help me', 'i need', 'how do', 'how to', 'what is', 'explain'];
        let processed = clean.toLowerCase();
        for (const prefix of prefixes) {
            if (processed.startsWith(prefix)) {
                processed = clean.slice(prefix.length).trim();
                break;
            }
        }
        
        // Handle image generation command
        if (processed.startsWith('/image') || processed.startsWith('generate image') || processed.startsWith('create image')) {
            return 'Image Generation';
        }
        
        const firstSentence = processed.split(/[.!?\n]/)[0];
        const title = firstSentence.length > 50 
            ? firstSentence.substring(0, 50) + '...' 
            : firstSentence;
        return title || 'New Chat';
    }

    getSessionModeIcon(mode) {
        switch (mode) {
            case 'code':
                return 'code-2';
            case 'agent':
                return 'bot';
            case 'image':
                return 'image';
            case 'chat':
            default:
                return 'message-square';
        }
    }

    getSessionModeLabel(mode) {
        switch (mode) {
            case 'code':
                return 'Code';
            case 'agent':
                return 'Agent';
            case 'image':
                return 'Image';
            case 'chat':
            default:
                return 'Chat';
        }
    }

    formatTimestamp(isoString) {
        if (!isoString) return '';
        
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffSecs < 10) return 'Just now';
        if (diffMins < 1) return `${diffSecs}s ago`;
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
        
        return date.toLocaleDateString(undefined, { 
            month: 'short', 
            day: 'numeric' 
        });
    }

    getStorageStats() {
        try {
            if (!this.storageAvailable) {
                return { 
                    available: false,
                    size: 0, 
                    sizeFormatted: 'N/A',
                    sessionCount: this.sessions.length,
                    messageCount: Array.from(this.sessionMessages.values())
                        .reduce((acc, msgs) => acc + msgs.length, 0),
                    percentUsed: 0
                };
            }
            
            const data = this.safeStorageGet(this.storageKey);
            const size = data ? new Blob([data]).size : 0;
            const sessionCount = this.sessions.length;
            const messageCount = Array.from(this.sessionMessages.values())
                .reduce((acc, msgs) => acc + msgs.length, 0);
            
            return {
                available: true,
                size,
                sizeFormatted: this.formatBytes(size),
                sessionCount,
                messageCount,
                percentUsed: (size / (5 * 1024 * 1024)) * 100
            };
        } catch (e) {
            return { available: false, error: 'Failed to get stats' };
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

// Create global session manager instance
const sessionManager = new SessionManager();
window.sessionManager = sessionManager;


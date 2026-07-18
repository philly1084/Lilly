'use strict';

const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { config } = require('../config');
const { getSessionControlState } = require('../runtime-control-state');
const { AsyncLabStore } = require('./store');
const { ValkeyLiveBus, normalizeText, sleep } = require('./valkey-live-bus');

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const EXECUTABLE_ADAPTERS = new Set([
    'remote-command',
    'ssh-execute',
    'remote-cli-agent',
    'remote-workbench',
    'k3s-deploy',
    'managed-app',
    'document-workflow',
]);
const REMOTE_ADAPTER_PATTERNS = [
    /remote/i,
    /ssh/i,
    /k3s/i,
    /deploy/i,
    /managed-app/i,
    /build-webhook/i,
];
const FAILED_TOOL_COMPLETION_STATUSES = new Set(['blocked', 'failed']);
const SAFE_RESULT_ITEM_LIMIT = 40;
const SAFE_RESULT_TEXT_LIMIT = 1200;
const COMMON_SENSITIVE_QUERY_KEYS = new Set([
    'access-token',
    'api-key',
    'auth',
    'authorization',
    'client-secret',
    'cookie',
    'credential',
    'credentials',
    'id-token',
    'key',
    'password',
    'private-key',
    'refresh-token',
    'secret',
    'security-token',
    'session-token',
    'sig',
    'signature',
    'token',
]);

function createServiceError(message, statusCode = 503) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function createRemoteSessionScopeError() {
    const error = createServiceError(
        'Async remote-agent session is unavailable or is not owned by the requester',
        403,
    );
    error.code = 'ASYNC_REMOTE_AGENT_SESSION_SCOPE_MISMATCH';
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

function hasSensitiveResultFragment(value = '') {
    const rawFragment = String(value || '').replace(/^#/, '');
    if (!rawFragment) {
        return false;
    }
    let decodedFragment = rawFragment;
    try {
        decodedFragment = decodeURIComponent(rawFragment.replace(/\+/g, '%20'));
    } catch (_error) {
        decodedFragment = rawFragment;
    }
    return decodedFragment
        .split('?')
        .flatMap((section) => section.split(/[&;]/))
        .some((entry) => {
            const delimiterIndex = entry.search(/[=:]/);
            const rawKey = delimiterIndex >= 0 ? entry.slice(0, delimiterIndex) : entry;
            return isSensitiveResultQueryParam(rawKey.replace(/^[/#]+/, ''));
        });
}

function sanitizeHttpUrlSubstring(value = '') {
    const original = String(value || '');
    if (!original) {
        return '';
    }

    let candidate = original;
    let trailing = '';
    while (/[.,;!?]$/.test(candidate)) {
        trailing = `${candidate.slice(-1)}${trailing}`;
        candidate = candidate.slice(0, -1);
    }

    try {
        const parsed = new URL(candidate);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return original;
        }
        let changed = false;
        if (parsed.username || parsed.password) {
            parsed.username = '';
            parsed.password = '';
            changed = true;
        }
        for (const key of Array.from(parsed.searchParams.keys())) {
            if (isSensitiveResultQueryParam(key)) {
                parsed.searchParams.delete(key);
                changed = true;
            }
        }
        if (hasSensitiveResultFragment(parsed.hash)) {
            parsed.hash = '';
            changed = true;
        }
        return changed ? `${parsed.toString()}${trailing}` : original;
    } catch (_error) {
        return original;
    }
}

function sanitizeResultText(value = '', maxLength = SAFE_RESULT_TEXT_LIMIT) {
    const normalized = normalizeText(value)
        .replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (url) => sanitizeHttpUrlSubstring(url))
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(
            /(\b(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|refresh[-_ ]?token|session[-_ ]?token|security[-_ ]?token|id[-_ ]?token|authorization|credentials?|cookie|key|password|secret|signature|sig|token)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&#}\]]+)/gi,
            '$1[redacted]',
        )
        .replace(/\b(?:github_pat|ghp|sk)_[A-Za-z0-9_-]{12,}\b/g, '[redacted]');
    if (!normalized) {
        return '';
    }
    const limit = Math.max(1, Number(maxLength) || SAFE_RESULT_TEXT_LIMIT);
    return normalized.length > limit
        ? `${normalized.slice(0, Math.max(1, limit - 3))}...`
        : normalized;
}

function isSensitiveResultQueryParam(value = '') {
    let decoded = String(value || '').trim();
    for (let pass = 0; pass < 3; pass += 1) {
        try {
            const next = decodeURIComponent(decoded.replace(/\+/g, '%20'));
            if (next === decoded) break;
            decoded = next;
        } catch (_error) {
            break;
        }
    }
    const components = decoded.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (components.length === 0) {
        return false;
    }
    const normalized = components.join('-');
    if (COMMON_SENSITIVE_QUERY_KEYS.has(normalized)) {
        return true;
    }
    const suffix = components.slice(-2).join('-');
    if (['access-token', 'api-key', 'security-token'].includes(suffix)) {
        return true;
    }
    if (components[0] === 'x' && ['amz', 'goog'].includes(components[1])) {
        const providerField = components.slice(2).join('-');
        return ['credential', 'security-token', 'signature'].includes(providerField);
    }
    return false;
}

function sanitizeResultUrl(value = '') {
    const normalized = sanitizeResultText(value, 2048);
    if (!normalized) {
        return '';
    }
    try {
        const relative = /^[/?#]/.test(normalized);
        const parsed = new URL(normalized, 'https://kimibuilt.invalid');
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return '';
        }
        parsed.username = '';
        parsed.password = '';
        for (const key of Array.from(parsed.searchParams.keys())) {
            if (isSensitiveResultQueryParam(key)) {
                parsed.searchParams.delete(key);
            }
        }
        if (hasSensitiveResultFragment(parsed.hash)) {
            parsed.hash = '';
        }
        return relative
            ? `${parsed.pathname}${parsed.search}${parsed.hash}`
            : parsed.toString();
    } catch (_error) {
        return '';
    }
}

function compactStringList(values = [], maxItems = SAFE_RESULT_ITEM_LIMIT, maxLength = 240) {
    return Array.from(new Set((Array.isArray(values) ? values : [])
        .map((value) => sanitizeResultText(value, maxLength))
        .filter(Boolean)))
        .slice(0, Math.max(1, Number(maxItems) || SAFE_RESULT_ITEM_LIMIT));
}

function compactResultFileDescriptor(file = {}) {
    if (!file || typeof file !== 'object') {
        return null;
    }
    const descriptor = {};
    const textFields = [
        'artifactId',
        'filename',
        'storedFilename',
        'path',
        'relativePath',
        'mimeType',
        'extension',
        'format',
        'role',
    ];
    for (const field of textFields) {
        const value = sanitizeResultText(file[field], 500);
        if (value) {
            descriptor[field] = value;
        }
    }
    const sizeBytes = Number(file.sizeBytes);
    if (Number.isFinite(sizeBytes) && sizeBytes >= 0) {
        descriptor.sizeBytes = sizeBytes;
    }
    const sha256 = sanitizeResultText(file.sha256, 64);
    if (/^[a-f0-9]{64}$/i.test(sha256)) {
        descriptor.sha256 = sha256.toLowerCase();
    }
    if (typeof file.gatewayVerified === 'boolean') {
        descriptor.gatewayVerified = file.gatewayVerified;
    }
    return Object.keys(descriptor).length > 0 ? descriptor : null;
}

function compactArtifactDescriptor(artifact = {}) {
    if (!artifact || typeof artifact !== 'object') {
        return null;
    }
    const descriptor = {};
    const textFieldAliases = {
        id: [artifact.id, artifact.artifactId],
        filename: [artifact.filename, artifact.fileName],
        title: [artifact.title, artifact.name],
        mimeType: [artifact.mimeType, artifact.contentType],
        format: [artifact.format],
        role: [artifact.role],
        relativePath: [artifact.relativePath, artifact.path],
        parentArtifactId: [artifact.parentArtifactId, artifact.parent_artifact_id],
        revision: [artifact.revision, artifact.artifactRevision],
        createdAt: [artifact.createdAt, artifact.created_at],
    };
    for (const [field, values] of Object.entries(textFieldAliases)) {
        const candidate = values.find((entry) => entry !== undefined && entry !== null);
        const value = sanitizeResultText(candidate ?? '', 500);
        if (value) {
            descriptor[field] = value;
        }
    }
    const urlFieldAliases = {
        downloadUrl: [artifact.downloadUrl, artifact.download_url],
        previewUrl: [artifact.previewUrl, artifact.preview_url],
        sandboxUrl: [artifact.sandboxUrl, artifact.sandbox_url],
        bundleDownloadUrl: [artifact.bundleDownloadUrl, artifact.bundle_download_url],
    };
    for (const [field, values] of Object.entries(urlFieldAliases)) {
        const candidate = values.find((entry) => entry !== undefined && entry !== null);
        const value = sanitizeResultUrl(candidate ?? '');
        if (value) {
            descriptor[field] = value;
        }
    }
    const sizeBytes = Number(artifact.sizeBytes ?? artifact.size_bytes);
    if (Number.isFinite(sizeBytes) && sizeBytes >= 0) {
        descriptor.sizeBytes = sizeBytes;
    }
    return Object.keys(descriptor).length > 0 ? descriptor : null;
}

function compactQualityIssue(issue = {}) {
    if (!issue || typeof issue !== 'object') {
        return null;
    }
    const compact = {};
    for (const field of ['code', 'path', 'message']) {
        const value = sanitizeResultText(issue[field], field === 'message' ? 800 : 300);
        if (value) {
            compact[field] = value;
        }
    }
    return Object.keys(compact).length > 0 ? compact : null;
}

function compactArtifactQuality(quality = null) {
    if (!quality || typeof quality !== 'object') {
        return null;
    }
    const compact = {};
    for (const field of ['version', 'status']) {
        const value = sanitizeResultText(quality[field], 160);
        if (value) {
            compact[field] = value;
        }
    }
    for (const field of ['blockers', 'warnings']) {
        const entries = (Array.isArray(quality[field]) ? quality[field] : [])
            .slice(0, SAFE_RESULT_ITEM_LIMIT)
            .map((issue) => compactQualityIssue(issue))
            .filter(Boolean);
        if (entries.length > 0) {
            compact[field] = entries;
        }
    }
    const files = (Array.isArray(quality.files) ? quality.files : [])
        .slice(0, SAFE_RESULT_ITEM_LIMIT)
        .map((file) => compactResultFileDescriptor(file))
        .filter(Boolean);
    if (files.length > 0) {
        compact.files = files;
    }
    if (quality.site && typeof quality.site === 'object') {
        compact.site = {
            enabled: quality.site.enabled === true,
            entries: compactStringList(quality.site.entries, SAFE_RESULT_ITEM_LIMIT, 500),
            checkedReferences: Math.max(0, Number(quality.site.checkedReferences) || 0),
        };
    }
    return Object.keys(compact).length > 0 ? compact : null;
}

function buildRemoteAgentResultSummary(result = {}) {
    const data = result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data
        : {};
    const source = { ...result, ...data };
    const completionStatus = sanitizeResultText(source.completionStatus, 80).toLowerCase();
    const blocker = sanitizeResultText(source.blocker || source.resultFilesError, SAFE_RESULT_TEXT_LIMIT);
    const provider = sanitizeResultText(source.provider || source.providerId, 160);
    const providerModel = sanitizeResultText(source.providerModel || source.provider_model, 160);
    const model = sanitizeResultText(source.model, 160);
    const transport = sanitizeResultText(source.transport, 160);
    const sessionId = sanitizeResultText(source.sessionId || source.session_id, 300);
    const mcpSessionId = sanitizeResultText(source.mcpSessionId || source.mcp_session_id, 300);
    const remoteCodeSessionId = sanitizeResultText(
        source.remoteCodeSessionId || source.remote_code_session_id,
        300,
    );
    const remoteCodeJobId = sanitizeResultText(source.remoteCodeJobId || source.remote_code_job_id, 300);
    const targetId = sanitizeResultText(source.targetId || source.target_id, 300);
    const cwd = sanitizeResultText(source.cwd, 1000);
    const publicUrl = sanitizeResultUrl(source.publicUrl);
    const publicHost = sanitizeResultText(source.publicHost, 300);
    const resultFiles = (Array.isArray(source.resultFiles) ? source.resultFiles : [])
        .slice(0, SAFE_RESULT_ITEM_LIMIT)
        .map((file) => compactResultFileDescriptor(file))
        .filter(Boolean);
    const artifactCandidates = [
        ...(Array.isArray(source.artifacts) ? source.artifacts : []),
        ...(source.siteBundleArtifact && typeof source.siteBundleArtifact === 'object'
            ? [source.siteBundleArtifact]
            : []),
    ].slice(0, SAFE_RESULT_ITEM_LIMIT * 2)
        .map((artifact) => compactArtifactDescriptor(artifact))
        .filter(Boolean);
    const artifactKeys = new Set();
    const artifacts = artifactCandidates.filter((artifact) => {
        const key = artifact.id
            || [artifact.filename, artifact.relativePath, artifact.downloadUrl].filter(Boolean).join('|');
        if (!key || artifactKeys.has(key)) {
            return false;
        }
        artifactKeys.add(key);
        return true;
    }).slice(0, SAFE_RESULT_ITEM_LIMIT);
    const siteBundleArtifactId = sanitizeResultText(source.siteBundleArtifactId, 300);
    const artifactIds = compactStringList([
        ...(Array.isArray(source.artifactIds) ? source.artifactIds : []),
        ...resultFiles.map((file) => file.artifactId),
        ...artifacts.map((artifact) => artifact.id),
        siteBundleArtifactId,
    ], SAFE_RESULT_ITEM_LIMIT, 300);
    const artifactQuality = compactArtifactQuality(source.artifactQuality);

    return {
        ...(completionStatus ? { completionStatus } : {}),
        ...(blocker ? { blocker } : {}),
        ...(provider ? { provider } : {}),
        ...(providerModel ? { providerModel } : {}),
        ...(model ? { model } : {}),
        ...(transport ? { transport } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(mcpSessionId ? { mcpSessionId } : {}),
        ...(remoteCodeSessionId ? { remoteCodeSessionId } : {}),
        ...(remoteCodeJobId ? { remoteCodeJobId } : {}),
        ...(targetId ? { targetId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(publicUrl ? { publicUrl } : {}),
        ...(publicHost ? { publicHost } : {}),
        ...(artifactIds.length > 0 ? { artifactIds } : {}),
        ...(resultFiles.length > 0 ? { resultFiles } : {}),
        ...(siteBundleArtifactId ? { siteBundleArtifactId } : {}),
        ...(artifactQuality ? { artifactQuality } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
    };
}

function normalizeBuildWebhookStatus(value = '') {
    return normalizeText(value).toLowerCase().replace(/[_\s]+/g, '-');
}

function isSuccessfulBuildWebhookStatus(value = '') {
    return ['success', 'succeeded', 'passed', 'green'].includes(normalizeBuildWebhookStatus(value));
}

function normalizeWebhookFollowUp(value = '') {
    const normalized = normalizeText(value).toLowerCase().replace(/[_\s]+/g, '-');
    if (!normalized || ['0', 'false', 'no', 'off', 'none', 'copy-only'].includes(normalized)) {
        return '';
    }
    if (['managed-app', 'managed-app-verify', 'verify', 'verification'].includes(normalized)) {
        return 'verify';
    }
    if (['managed-app-deploy', 'deploy', 'deployment'].includes(normalized)) {
        return 'deploy';
    }
    return '';
}

function lastPathSegment(value = '') {
    return normalizeText(value).split(/[\\/]/).filter(Boolean).pop() || '';
}

function deriveWebhookAppRef(payload = {}, projectPath = '') {
    const project = payload.project || payload.repository || {};
    return pickText(
        payload.appRef,
        payload.ref,
        payload.slug,
        payload.repoName,
        payload.repositoryName,
        typeof payload.repository === 'string' ? payload.repository : '',
        project.name,
        lastPathSegment(projectPath),
    );
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
        this.toolManager = options.toolManager || null;
        this.toolExecutionContext = options.toolExecutionContext || {};
        this.sessionStore = options.sessionStore || null;
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

    configureExecutionRuntime({
        toolManager = this.toolManager,
        toolExecutionContext = this.toolExecutionContext,
        sessionStore = this.sessionStore,
    } = {}) {
        this.toolManager = toolManager || null;
        this.toolExecutionContext = toolExecutionContext && typeof toolExecutionContext === 'object'
            ? { ...toolExecutionContext }
            : {};
        this.sessionStore = sessionStore || null;
        return {
            toolManagerAttached: Boolean(this.toolManager?.executeTool),
        };
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
        const runOwnerId = normalizeText(ownerId || input.ownerId || input.owner_id);
        const runSessionId = normalizeText(input.sessionId || input.session_id);

        if (adapter === 'remote-cli-agent' && runSessionId && this.sessionStore) {
            const ownedSession = await this.resolveRunSession({
                sessionId: runSessionId,
                ownerId: runOwnerId,
            });
            if (!ownedSession) {
                throw createRemoteSessionScopeError();
            }
        }

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
            ownerId: runOwnerId,
            sessionId: runSessionId,
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
        let toolResult = null;
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

        const latest = await this.store.getRun(run.id);
        if (latest && !TERMINAL_STATUSES.has(latest.status)) {
            toolResult = await this.maybeExecuteAdapter(latest);
        }

        if (toolResult?.success === false) {
            const failureMessage = pickText(
                toolResult.blocker,
                toolResult.error,
                toolResult.completionStatus
                    ? `${toolResult.adapter || run.adapter} reported ${toolResult.completionStatus}.`
                    : '',
                `${toolResult.adapter || run.adapter} failed.`,
            );
            await this.markFailed(latest || run, failureMessage, { toolResult });
            return;
        }

        const completed = await this.store.updateRun(run.id, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            metadata: toolResult ? { toolResult } : {},
        });
        await this.appendEvent(run.id, {
            type: 'completed',
            source: 'async-lab-worker',
            status: 'completed',
            payload: {
                message: 'Async lab run completed.',
                dryRun: completed?.metadata?.dryRun === true,
                runtimeSurface: this.config.surface,
                toolExecuted: Boolean(toolResult),
                toolSuccess: toolResult ? toolResult.success !== false : null,
            },
        });
    }

    async maybeExecuteAdapter(run = {}) {
        const adapter = normalizeAdapter(run.adapter);
        const remoteAdapter = run.metadata?.remoteAdapter === true || isRemoteAdapter(adapter);
        if (!EXECUTABLE_ADAPTERS.has(adapter) || (remoteAdapter && !run.liveRemoteAllowed)) {
            return null;
        }

        if (!this.toolManager?.executeTool) {
            await this.appendEvent(run.id, {
                type: 'tool_skipped',
                source: 'async-lab-worker',
                status: 'running',
                payload: {
                    adapter,
                    targetKey: run.targetKey,
                    message: 'Live adapter execution skipped because no tool manager is attached to the async runtime.',
                },
            });
            return null;
        }

        const params = this.buildToolParams(run);
        await this.appendEvent(run.id, {
            type: 'tool_started',
            source: 'async-lab-worker',
            status: 'running',
            payload: {
                adapter,
                targetKey: run.targetKey,
                message: `Executing ${adapter} through the async runtime.`,
                paramsPreview: this.buildParamsPreview(params),
            },
        });

        const startedAt = Date.now();
        let result;
        const toolContext = await this.buildToolContext(run);
        try {
            result = await this.toolManager.executeTool(adapter, params, toolContext);
        } catch (error) {
            result = {
                success: false,
                error: error.message,
                toolId: adapter,
                duration: Math.max(0, Date.now() - startedAt),
            };
        }
        const summary = this.summarizeToolResult(adapter, result, startedAt);
        if (adapter === 'remote-cli-agent') {
            try {
                await this.persistRemoteCliAgentContinuity(run, summary, toolContext.session);
            } catch (error) {
                await this.appendEvent(run.id, {
                    type: 'continuity_warning',
                    source: 'async-lab-worker',
                    status: 'running',
                    payload: {
                        adapter,
                        targetKey: run.targetKey,
                        message: 'Remote agent completed, but its continuation state could not be persisted.',
                        error: sanitizeResultText(error?.message, 500),
                    },
                });
            }
        }
        const toolFailed = summary.success === false;
        await this.appendEvent(run.id, {
            type: toolFailed ? 'tool_failed' : 'tool_completed',
            source: 'async-lab-worker',
            status: toolFailed ? 'failed' : 'running',
            payload: {
                adapter,
                targetKey: run.targetKey,
                message: toolFailed
                    ? `${adapter} reported a blocked or failed result.`
                    : `${adapter} returned a structured result.`,
                result: summary,
            },
        });

        return summary;
    }

    buildToolParams(run = {}) {
        const metadataParams = run.metadata?.toolParams && typeof run.metadata.toolParams === 'object'
            ? run.metadata.toolParams
            : {};
        if (Object.keys(metadataParams).length > 0) {
            return { ...metadataParams };
        }

        const adapter = normalizeAdapter(run.adapter);
        if (adapter === 'remote-cli-agent') {
            return {
                task: run.task,
                targetId: run.targetKey,
                adminMode: true,
                waitMs: 120000,
            };
        }
        if (adapter === 'managed-app') {
            return {
                task: run.task,
                targetKey: run.targetKey,
            };
        }
        if (adapter === 'document-workflow') {
            return {
                action: 'generate',
                prompt: run.task,
                format: run.metadata?.outputFormat || 'html',
                documentType: run.metadata?.documentType || 'document',
                buildMode: run.metadata?.buildMode || 'sandbox',
            };
        }
        if (adapter === 'k3s-deploy') {
            return {
                action: 'status',
                targetId: run.targetKey,
            };
        }
        if (adapter === 'remote-workbench') {
            return {
                action: 'inspect',
                task: run.task,
                targetId: run.targetKey,
            };
        }

        return {
            command: run.task,
            targetId: run.targetKey,
        };
    }

    async resolveRunSession(run = {}) {
        const sessionId = normalizeText(run.sessionId);
        const ownerId = normalizeText(run.ownerId);
        if (!sessionId || !this.sessionStore) {
            return null;
        }

        if (typeof this.sessionStore.getOwned === 'function') {
            return this.sessionStore.getOwned(sessionId, ownerId);
        }
        if (typeof this.sessionStore.get === 'function') {
            const session = await this.sessionStore.get(sessionId);
            const sessionOwnerId = normalizeText(
                this.sessionStore.getSessionOwnerId?.(session)
                || session?.ownerId
                || session?.owner_id
                || session?.metadata?.ownerId
                || session?.metadata?.owner_id,
            );
            return session && ownerId && sessionOwnerId === ownerId ? session : null;
        }
        return null;
    }

    async buildToolContext(run = {}) {
        const session = await this.resolveRunSession(run);
        const remoteAgentRun = normalizeAdapter(run.adapter) === 'remote-cli-agent';
        if (remoteAgentRun
            && normalizeText(run.sessionId)
            && this.sessionStore
            && !session) {
            throw createRemoteSessionScopeError();
        }
        const verifiedSessionId = remoteAgentRun
            ? (session ? normalizeText(run.sessionId) : null)
            : (run.sessionId || this.toolExecutionContext?.sessionId || null);
        return {
            ...(this.toolExecutionContext && typeof this.toolExecutionContext === 'object'
                ? this.toolExecutionContext
                : {}),
            sessionId: verifiedSessionId,
            ownerId: run.ownerId || this.toolExecutionContext?.ownerId || null,
            ...(session ? {
                session,
                controlState: getSessionControlState(session),
            } : {}),
            route: '/api/async-lab',
            transport: 'async-runtime',
            executionProfile: 'async-runtime',
            toolManager: this.toolManager,
        };
    }

    async persistRemoteCliAgentContinuity(run = {}, summary = {}, resolvedSession = null) {
        const sessionId = normalizeText(run.sessionId);
        if (!sessionId || !this.sessionStore?.updateControlState || !resolvedSession) {
            return false;
        }

        const remoteCliAgent = {
            lastTask: normalizeText(run.task) || null,
            lastTaskAt: new Date().toISOString(),
            ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
            ...(summary.mcpSessionId ? { mcpSessionId: summary.mcpSessionId } : {}),
            ...(summary.remoteCodeSessionId ? { remoteCodeSessionId: summary.remoteCodeSessionId } : {}),
            ...(summary.remoteCodeJobId ? { remoteCodeJobId: summary.remoteCodeJobId } : {}),
            ...(summary.targetId ? { targetId: summary.targetId } : {}),
            ...(summary.cwd ? { cwd: summary.cwd } : {}),
            ...(summary.completionStatus ? { completionStatus: summary.completionStatus } : {}),
            ...(summary.blocker ? { blocker: summary.blocker } : {}),
            ...(summary.publicHost ? { publicHost: summary.publicHost } : {}),
            ...(summary.publicUrl ? { publicUrl: summary.publicUrl } : {}),
        };
        await this.sessionStore.updateControlState(sessionId, {
            lastToolIntent: 'remote-cli-agent',
            remoteCliAgent,
        });
        return true;
    }

    buildParamsPreview(params = {}) {
        const preview = {};
        for (const [key, value] of Object.entries(params || {})) {
            if (/password|secret|token|key/i.test(key)) {
                preview[key] = '[redacted]';
            } else if (typeof value === 'string') {
                preview[key] = value.length > 160 ? `${value.slice(0, 157)}...` : value;
            } else if (value === null || ['number', 'boolean'].includes(typeof value)) {
                preview[key] = value;
            } else {
                preview[key] = Array.isArray(value) ? `[array:${value.length}]` : '[object]';
            }
        }
        return preview;
    }

    summarizeToolResult(adapter = '', result = {}, startedAt = Date.now()) {
        const normalizedAdapter = normalizeAdapter(adapter);
        const remoteAgentSummary = normalizedAdapter === 'remote-cli-agent'
            ? buildRemoteAgentResultSummary(result)
            : {};
        const completionFailed = FAILED_TOOL_COMPLETION_STATUSES.has(
            normalizeText(remoteAgentSummary.completionStatus).toLowerCase(),
        );
        const durationMs = Number(result?.duration) || Math.max(0, Date.now() - startedAt);
        const data = result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
            ? result.data
            : null;
        const verificationEvidence = normalizedAdapter === 'remote-cli-agent'
            ? sanitizeResultText(
                typeof result?.verification?.evidence === 'string'
                    ? result.verification.evidence
                    : '',
                SAFE_RESULT_TEXT_LIMIT,
            ) || null
            : result?.verification?.evidence || null;
        return {
            adapter: normalizedAdapter,
            success: result?.success !== false && !completionFailed,
            toolId: result?.toolId || normalizedAdapter,
            durationMs,
            error: normalizedAdapter === 'remote-cli-agent'
                ? sanitizeResultText(result?.error, SAFE_RESULT_TEXT_LIMIT)
                : normalizeText(result?.error),
            status: result?.verification?.status || null,
            evidence: verificationEvidence,
            data: data
                ? {
                    keys: Object.keys(data)
                        .filter((key) => !/(?:base64|buffer|content|password|secret|token|key)/i.test(key))
                        .slice(0, 12),
                    message: normalizedAdapter === 'remote-cli-agent'
                        ? sanitizeResultText(data.message || data.summary || '', SAFE_RESULT_TEXT_LIMIT)
                        : normalizeText(data.message || data.summary || data.output || ''),
                }
                : null,
            ...remoteAgentSummary,
        };
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

    async markFailed(run = {}, message = 'Run failed.', metadata = {}) {
        const retainedMetadata = metadata && typeof metadata === 'object' ? metadata : {};
        const updated = await this.store.updateRun(run.id, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            metadata: {
                ...retainedMetadata,
                failure: message,
            },
        });
        await this.appendEvent(run.id, {
            type: 'failed',
            source: 'async-lab-worker',
            status: 'failed',
            payload: {
                message,
                ...(retainedMetadata.toolResult ? {
                    toolExecuted: true,
                    completionStatus: retainedMetadata.toolResult.completionStatus || null,
                } : {}),
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

        const copied = await this.createRun({
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
        const followUp = await this.createBuildWebhookFollowUp(payload, {
            ...options,
            projectPath,
            externalRunId,
            commitSha,
            status,
        });
        return followUp ? { ...copied, followUp } : copied;
    }

    async createBuildWebhookFollowUp(payload = {}, context = {}) {
        const requestedFollowUp = typeof context.followUp === 'object' && context.followUp !== null
            ? context.followUp
            : (payload.asyncFollowUp || payload.asyncRuntime?.followUp || context.followUp || '');
        const action = normalizeWebhookFollowUp(
            typeof requestedFollowUp === 'object'
                ? requestedFollowUp.action || requestedFollowUp.type || requestedFollowUp.kind
                : requestedFollowUp,
        );
        if (!action || !isSuccessfulBuildWebhookStatus(context.status)) {
            return null;
        }

        const appRef = pickText(
            typeof requestedFollowUp === 'object' ? requestedFollowUp.appRef || requestedFollowUp.ref || requestedFollowUp.slug : '',
            deriveWebhookAppRef(payload, context.projectPath),
        );
        if (!appRef) {
            return null;
        }

        const targetKey = `managed-app:${appRef}`;
        const idempotencyKey = `build-webhook-follow-up:${action}:${appRef}:${context.externalRunId || context.commitSha || hashPayload(payload)}`;
        return this.createRun({
            adapter: 'managed-app',
            task: `${action === 'deploy' ? 'Deploy' : 'Verify'} managed app ${appRef} after successful build webhook.`,
            targetKey,
            sessionId: payload.sessionId || payload.session_id || '',
            idempotencyKey,
            liveRemote: true,
            metadata: {
                source: 'build-webhook-follow-up',
                webhook: {
                    projectPath: context.projectPath,
                    externalRunId: context.externalRunId,
                    commitSha: context.commitSha,
                    status: context.status,
                    followUpAction: action,
                    receivedAt: new Date().toISOString(),
                },
                toolParams: {
                    action,
                    appRef,
                    requestedAction: action,
                    deployRequested: action === 'deploy',
                    ...(payload.imageTag || payload.image_tag ? { imageTag: payload.imageTag || payload.image_tag } : {}),
                    ...(context.commitSha ? { commitSha: context.commitSha } : {}),
                    ...(context.externalRunId ? { runId: context.externalRunId } : {}),
                },
            },
        }, context.ownerId || 'async-lab-webhook');
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

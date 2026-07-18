(function initRemoteArtifactWorkflow(globalScope, factory) {
    const api = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    if (globalScope) {
        globalScope.KimiBuiltRemoteArtifactWorkflow = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function createRemoteArtifactWorkflowModule() {
    'use strict';

    const MAX_ARTIFACT_ID_LENGTH = 300;
    const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,299}$/i;
    const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
    const SENSITIVE_QUERY_KEYS = new Set([
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
    const SAFE_ARTIFACT_ACTIONS = new Set(['bundle', 'download', 'preview', 'sandbox']);
    const SAFE_RESULT_ITEM_LIMIT = 40;
    const SAFE_RESULT_TEXT_LIMIT = 1200;
    const DEFAULT_PUBLIC_WEB_DOMAIN = 'demoserver2.buzz';

    class RemoteArtifactWorkflowError extends Error {
        constructor(message, options = {}) {
            super(String(message || 'Remote artifact workflow failed.'));
            this.name = 'RemoteArtifactWorkflowError';
            this.code = String(options.code || 'REMOTE_ARTIFACT_WORKFLOW_ERROR');
            this.status = Number.isFinite(Number(options.status)) ? Number(options.status) : null;
            this.blocker = String(options.blocker || '');
            this.details = options.details && typeof options.details === 'object'
                ? options.details
                : null;
            this.retryable = options.retryable === true;
            this.authRequired = options.authRequired === true || this.status === 401;
            this.sourceChanged = options.sourceChanged === true
                || this.status === 412
                || this.code === 'ARTIFACT_MANAGED_APP_SOURCE_CHANGED';
        }

        toJSON() {
            return {
                name: this.name,
                message: this.message,
                code: this.code,
                status: this.status,
                blocker: this.blocker || null,
                details: this.details,
                retryable: this.retryable,
                authRequired: this.authRequired,
                sourceChanged: this.sourceChanged,
            };
        }
    }

    function normalizeText(value = '', maxLength = SAFE_RESULT_TEXT_LIMIT) {
        const normalized = String(value ?? '')
            .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .trim();
        const limit = Math.max(1, Number(maxLength) || SAFE_RESULT_TEXT_LIMIT);
        return normalized.length > limit
            ? `${normalized.slice(0, Math.max(1, limit - 3))}...`
            : normalized;
    }

    function isSensitiveQueryKey(value = '') {
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
        if (components.length === 0) return false;

        const normalized = components.join('-');
        if (SENSITIVE_QUERY_KEYS.has(normalized)) return true;

        const suffix = components.slice(-2).join('-');
        if (['access-token', 'api-key', 'security-token'].includes(suffix)) return true;

        if (components[0] === 'x' && ['amz', 'goog'].includes(components[1])) {
            const providerField = components.slice(2).join('-');
            return ['credential', 'security-token', 'signature'].includes(providerField);
        }
        return false;
    }

    function sanitizeUrlSubstring(value = '') {
        const raw = String(value || '');
        const trailing = raw.match(/[),.;!?]+$/)?.[0] || '';
        const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
        try {
            const parsed = new URL(candidate);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return `[redacted-url]${trailing}`;
            }
            parsed.username = '';
            parsed.password = '';
            for (const key of Array.from(parsed.searchParams.keys())) {
                if (isSensitiveQueryKey(key)) parsed.searchParams.delete(key);
            }
            parsed.hash = '';
            return `${parsed.toString()}${trailing}`;
        } catch (_error) {
            return `[redacted-url]${trailing}`;
        }
    }

    function sanitizeResultText(value = '', maxLength = SAFE_RESULT_TEXT_LIMIT) {
        const normalized = normalizeText(value, Math.max(maxLength, String(value ?? '').length || 1))
            .replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, sanitizeUrlSubstring)
            .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
            .replace(
                /(\b(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|refresh[-_ ]?token|session[-_ ]?token|security[-_ ]?token|id[-_ ]?token|authorization|credentials?|cookie|key|password|secret|signature|sig|token)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&#}\]]+)/gi,
                '$1[redacted]',
            );
        const limit = Math.max(1, Number(maxLength) || SAFE_RESULT_TEXT_LIMIT);
        return normalized.length > limit
            ? `${normalized.slice(0, Math.max(1, limit - 3))}...`
            : normalized;
    }

    function normalizeArtifactId(value = '') {
        const normalized = normalizeText(value, MAX_ARTIFACT_ID_LENGTH);
        return ARTIFACT_ID_PATTERN.test(normalized) ? normalized : '';
    }

    function requireArtifactId(value = '') {
        const normalized = normalizeArtifactId(value);
        if (!normalized) {
            throw new RemoteArtifactWorkflowError('A full artifact ID is required.', {
                code: 'REMOTE_ARTIFACT_ID_INVALID',
                status: 400,
            });
        }
        return normalized;
    }

    function normalizeBaseOrigin(value = '') {
        const fallback = 'https://kimibuilt.invalid';
        try {
            const parsed = new URL(String(value || fallback));
            return `${parsed.protocol}//${parsed.host}`;
        } catch (_error) {
            return fallback;
        }
    }

    function getDefaultOrigin() {
        return normalizeBaseOrigin(
            typeof window !== 'undefined' && window.location?.origin
                ? window.location.origin
                : '',
        );
    }

    function buildArtifactRoute(artifactId, action) {
        const normalizedId = requireArtifactId(artifactId);
        const normalizedAction = String(action || '').trim().toLowerCase();
        if (!SAFE_ARTIFACT_ACTIONS.has(normalizedAction)) {
            throw new RemoteArtifactWorkflowError('Artifact action is invalid.', {
                code: 'REMOTE_ARTIFACT_ACTION_INVALID',
                status: 400,
            });
        }
        return `/api/artifacts/${encodeURIComponent(normalizedId)}/${normalizedAction}`;
    }

    function normalizeArtifactRouteUrl(value, artifactId, action, options = {}) {
        const normalizedId = requireArtifactId(artifactId);
        const normalizedAction = String(action || '').trim().toLowerCase();
        const fallback = options.fallback === true
            ? buildArtifactRoute(normalizedId, normalizedAction)
            : '';
        const raw = String(value ?? '').trim();
        if (!raw) return fallback;
        if (/[\u0000-\u001F\u007F]/.test(raw) || raw.startsWith('//')) return fallback;

        const baseOrigin = normalizeBaseOrigin(options.baseOrigin || getDefaultOrigin());
        try {
            const parsed = new URL(raw, baseOrigin);
            if (parsed.origin !== baseOrigin || !['http:', 'https:'].includes(parsed.protocol)) {
                return fallback;
            }
            const pathMatch = parsed.pathname.match(/^\/api\/artifacts\/([^/]+)\/([^/]+)\/?$/);
            let decodedId = '';
            try {
                decodedId = decodeURIComponent(pathMatch?.[1] || '');
            } catch (_error) {
                return fallback;
            }
            if (!pathMatch || decodedId !== normalizedId || pathMatch[2] !== normalizedAction) {
                return fallback;
            }
            parsed.username = '';
            parsed.password = '';
            for (const key of Array.from(parsed.searchParams.keys())) {
                if (isSensitiveQueryKey(key)) parsed.searchParams.delete(key);
            }
            parsed.hash = '';
            return `${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
        } catch (_error) {
            return fallback;
        }
    }

    function normalizePublicUrl(value = '') {
        const sanitized = sanitizeResultText(value, 2048);
        if (!sanitized) return '';
        try {
            const parsed = new URL(sanitized);
            if (!['http:', 'https:'].includes(parsed.protocol)) return '';
            parsed.username = '';
            parsed.password = '';
            for (const key of Array.from(parsed.searchParams.keys())) {
                if (isSensitiveQueryKey(key)) parsed.searchParams.delete(key);
            }
            parsed.hash = '';
            return parsed.toString();
        } catch (_error) {
            return '';
        }
    }

    function cloneSafeResultValue(value, depth = 0) {
        if (value === null || value === undefined || depth > 5) return null;
        if (typeof value === 'string') return sanitizeResultText(value);
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        if (Array.isArray(value)) {
            return value.slice(0, SAFE_RESULT_ITEM_LIMIT)
                .map((entry) => cloneSafeResultValue(entry, depth + 1))
                .filter((entry) => entry !== null && entry !== undefined);
        }
        if (typeof value !== 'object') return null;

        const safe = {};
        Object.entries(value).slice(0, SAFE_RESULT_ITEM_LIMIT).forEach(([key, entry]) => {
            const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
            if (!normalizedKey
                || ['auth', 'authorization', 'cookie', 'credential', 'credentials', 'key', 'password', 'secret', 'sig', 'signature', 'token'].includes(normalizedKey)
                || /(?:content|base64|buffer|password|secret|token|apikey|privatekey|clientsecret|credential|authorization|signature|cookie)/.test(normalizedKey)) {
                return;
            }
            const normalizedValue = cloneSafeResultValue(entry, depth + 1);
            if (normalizedValue !== null && normalizedValue !== undefined) safe[key] = normalizedValue;
        });
        return safe;
    }

    function normalizeArtifact(candidate = {}, options = {}) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
        const id = normalizeArtifactId(candidate.id || candidate.artifactId || candidate.artifact_id || '');
        if (!id) return null;

        const sizeBytes = Number(candidate.sizeBytes ?? candidate.size_bytes ?? candidate.size);
        const revision = Number(candidate.revision ?? candidate.artifactRevision);
        const sha256 = normalizeText(candidate.sha256 || candidate.persistedSha256 || '', 64);
        const downloadCandidate = candidate.downloadUrl || candidate.download_url || '';
        const previewCandidate = candidate.previewUrl || candidate.preview_url || '';
        const sandboxCandidate = candidate.sandboxUrl || candidate.sandbox_url || '';
        const bundleCandidate = candidate.bundleDownloadUrl
            || candidate.bundle_download_url
            || candidate.bundle_download
            || '';
        const baseOrigin = options.baseOrigin || getDefaultOrigin();
        const preview = candidate.preview && typeof candidate.preview === 'object'
            ? Object.fromEntries(Object.entries({
                type: normalizeText(candidate.preview.type, 80),
                entry: normalizeText(candidate.preview.entry, 500),
                fileCount: Number.isFinite(Number(candidate.preview.fileCount))
                    ? Math.max(0, Number(candidate.preview.fileCount))
                    : null,
                url: normalizeArtifactRouteUrl(candidate.preview.url, id, 'sandbox', {
                    baseOrigin,
                    fallback: false,
                }) || normalizeArtifactRouteUrl(candidate.preview.url, id, 'preview', {
                    baseOrigin,
                    fallback: false,
                }),
            }).filter(([, value]) => value !== '' && value !== null))
            : null;

        return Object.fromEntries(Object.entries({
            id,
            artifactId: id,
            sessionId: normalizeText(candidate.sessionId || candidate.session_id || '', 300),
            parentArtifactId: normalizeArtifactId(candidate.parentArtifactId || candidate.parent_artifact_id || ''),
            direction: normalizeText(candidate.direction, 80),
            sourceMode: normalizeText(candidate.sourceMode || candidate.source_mode || '', 120),
            filename: normalizeText(candidate.filename || candidate.storedFilename || candidate.stored_filename || candidate.fileName || candidate.name || id, 500),
            format: normalizeText(candidate.format || candidate.extension || '', 80).replace(/^\./, '').toLowerCase(),
            mimeType: normalizeText(candidate.mimeType || candidate.mime_type || candidate.contentType || '', 200),
            sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0,
            status: normalizeText(candidate.status || 'ready', 80),
            vectorized: typeof candidate.vectorized === 'boolean' ? candidate.vectorized : null,
            role: normalizeText(candidate.role || '', 120),
            relativePath: normalizeText(candidate.relativePath || candidate.relative_path || candidate.path || '', 500),
            sha256: SHA256_PATTERN.test(sha256) ? sha256.toLowerCase() : '',
            downloadUrl: normalizeArtifactRouteUrl(downloadCandidate, id, 'download', {
                baseOrigin,
                fallback: true,
            }),
            previewUrl: normalizeArtifactRouteUrl(previewCandidate, id, 'preview', {
                baseOrigin,
                fallback: Boolean(previewCandidate),
            }),
            sandboxUrl: normalizeArtifactRouteUrl(sandboxCandidate, id, 'sandbox', {
                baseOrigin,
                fallback: Boolean(sandboxCandidate),
            }),
            bundleDownloadUrl: normalizeArtifactRouteUrl(bundleCandidate, id, 'bundle', {
                baseOrigin,
                fallback: Boolean(bundleCandidate),
            }),
            preview,
            metadata: cloneSafeResultValue(candidate.metadata),
            missionId: normalizeText(candidate.missionId || candidate.mission_id || '', 300),
            revision: Number.isInteger(revision) && revision > 0 ? revision : null,
            provenance: cloneSafeResultValue(candidate.provenance),
            createdAt: normalizeText(candidate.createdAt || candidate.created_at || '', 100),
        }).filter(([, value]) => value !== '' && value !== null));
    }

    function mergeArtifact(existing = null, candidate = null) {
        if (!candidate) return existing;
        if (!existing) return candidate;
        const merged = { ...existing };
        Object.entries(candidate).forEach(([key, value]) => {
            if (value !== '' && value !== null && value !== undefined) merged[key] = value;
        });
        return merged;
    }

    function normalizeResultFile(file = {}) {
        if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
        const artifactId = normalizeArtifactId(file.artifactId || file.artifact_id || '');
        const sha256 = normalizeText(file.sha256 || file.persistedSha256 || '', 64);
        const sizeBytes = Number(file.sizeBytes ?? file.persistedSizeBytes ?? file.size);
        const descriptor = Object.fromEntries(Object.entries({
            artifactId,
            filename: normalizeText(file.filename || file.storedFilename || file.stored_filename || '', 500),
            storedFilename: normalizeText(file.storedFilename || file.stored_filename || '', 500),
            path: normalizeText(file.path || '', 500),
            relativePath: normalizeText(file.relativePath || file.relative_path || '', 500),
            mimeType: normalizeText(file.mimeType || file.mime_type || '', 200),
            extension: normalizeText(file.extension || '', 80).replace(/^\./, '').toLowerCase(),
            format: normalizeText(file.format || file.extension || '', 80).replace(/^\./, '').toLowerCase(),
            role: normalizeText(file.role || '', 120),
            sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
            sha256: SHA256_PATTERN.test(sha256) ? sha256.toLowerCase() : '',
            gatewayVerified: typeof file.gatewayVerified === 'boolean' ? file.gatewayVerified : null,
        }).filter(([, value]) => value !== '' && value !== null));
        return Object.keys(descriptor).length > 0 ? descriptor : null;
    }

    function collectRemoteAgentArtifacts(result = {}, options = {}) {
        const descriptors = new Map();
        const add = (candidate) => {
            const normalized = normalizeArtifact(candidate, options);
            if (!normalized) return;
            descriptors.set(normalized.id, mergeArtifact(descriptors.get(normalized.id), normalized));
        };

        (Array.isArray(result.artifactIds) ? result.artifactIds : []).forEach((artifactId) => add({ artifactId }));
        (Array.isArray(result.resultFiles) ? result.resultFiles : []).forEach((file) => {
            const normalizedFile = normalizeResultFile(file);
            if (!normalizedFile?.artifactId) return;
            add({
                id: normalizedFile.artifactId,
                filename: normalizedFile.storedFilename || normalizedFile.filename,
                mimeType: normalizedFile.mimeType,
                format: normalizedFile.format || normalizedFile.extension,
                sizeBytes: normalizedFile.sizeBytes,
                role: normalizedFile.role,
                relativePath: normalizedFile.relativePath || normalizedFile.path,
                sha256: normalizedFile.sha256,
            });
        });
        add(result.siteBundleArtifact);
        (Array.isArray(result.artifacts) ? result.artifacts : []).forEach(add);

        const siteBundleArtifactId = normalizeArtifactId(
            result.siteBundleArtifactId
            || result.siteBundleArtifact?.id
            || result.siteBundleArtifact?.artifactId
            || result.siteBundleArtifact?.artifact_id
            || '',
        );
        if (siteBundleArtifactId) {
            const existingFilename = descriptors.get(siteBundleArtifactId)?.filename || '';
            add({
                id: siteBundleArtifactId,
                filename: existingFilename && existingFilename !== siteBundleArtifactId
                    ? existingFilename
                    : 'Website bundle.zip',
                previewUrl: buildArtifactRoute(siteBundleArtifactId, 'preview'),
                bundleDownloadUrl: buildArtifactRoute(siteBundleArtifactId, 'bundle'),
            });
        }

        return {
            siteBundle: siteBundleArtifactId ? descriptors.get(siteBundleArtifactId) || null : null,
            artifacts: Array.from(descriptors.values()).filter((artifact) => artifact.id !== siteBundleArtifactId),
        };
    }

    function unwrapRemoteAgentResult(value = null) {
        let current = value;
        for (let depth = 0; depth < 3; depth += 1) {
            if (!current || typeof current !== 'object' || Array.isArray(current)) break;
            if (current.data && typeof current.data === 'object' && !Array.isArray(current.data)) {
                current = current.data;
                continue;
            }
            if (current.result && typeof current.result === 'object' && !Array.isArray(current.result)) {
                current = current.result;
                continue;
            }
            break;
        }
        return current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    }

    function normalizeRemoteAgentResult(value = null, options = {}) {
        const result = unwrapRemoteAgentResult(value);
        const collected = collectRemoteAgentArtifacts(result, options);
        const resultFiles = (Array.isArray(result.resultFiles) ? result.resultFiles : [])
            .slice(0, SAFE_RESULT_ITEM_LIMIT)
            .map(normalizeResultFile)
            .filter(Boolean);
        const completionStatus = sanitizeResultText(result.completionStatus || result.status || '', 120);
        const resultFilesError = sanitizeResultText(result.resultFilesError || '', 1200);
        const effectiveStatus = resultFilesError && (!completionStatus
            || ['complete', 'completed', 'success', 'succeeded'].includes(completionStatus.toLowerCase()))
            ? 'blocked'
            : completionStatus;
        const artifactIds = Array.from(new Set([
            ...(Array.isArray(result.artifactIds) ? result.artifactIds : []),
            ...collected.artifacts.map((artifact) => artifact.id),
            ...(collected.siteBundle?.id ? [collected.siteBundle.id] : []),
        ].map(normalizeArtifactId).filter(Boolean)));
        const normalizeList = (list, limit = 1200) => (Array.isArray(list) ? list : [])
            .slice(0, SAFE_RESULT_ITEM_LIMIT)
            .map((entry) => sanitizeResultText(entry, limit))
            .filter(Boolean);

        return Object.fromEntries(Object.entries({
            success: typeof result.success === 'boolean' ? result.success : null,
            completionStatus,
            effectiveStatus,
            finalOutput: sanitizeResultText(result.finalOutput || result.output || '', 12000),
            blocker: sanitizeResultText(result.blocker || '', 1200),
            resultFilesError,
            provider: sanitizeResultText(result.provider || result.providerId || '', 300),
            providerModel: sanitizeResultText(result.providerModel || '', 300),
            model: sanitizeResultText(result.model || '', 300),
            transport: sanitizeResultText(result.transport || '', 120),
            targetId: sanitizeResultText(result.targetId || '', 300),
            cwd: sanitizeResultText(result.cwd || result.workspacePath || '', 1000),
            sessionId: sanitizeResultText(result.sessionId || '', 300),
            remoteCodeJobId: sanitizeResultText(result.remoteCodeJobId || '', 300),
            mcpSessionId: sanitizeResultText(result.mcpSessionId || '', 300),
            gitRepo: sanitizeResultText(result.gitRepo || '', 1000),
            gitCommit: sanitizeResultText(result.gitCommit || '', 300),
            publicHost: sanitizeResultText(result.publicHost || '', 500),
            publicUrl: normalizePublicUrl(result.publicUrl || ''),
            uiCheckReport: sanitizeResultText(result.uiCheckReport || '', 1000),
            uiScreenshots: normalizeList(result.uiScreenshots, 1000),
            whatChanged: sanitizeResultText(result.whatChanged || '', 5000),
            verifyCommands: normalizeList(result.verifyCommands),
            verifyResults: normalizeList(result.verifyResults),
            changedFiles: normalizeList(result.changedFiles, 500),
            resultFiles,
            artifacts: collected.artifacts,
            artifactIds,
            siteBundle: collected.siteBundle,
            siteBundleArtifactId: collected.siteBundle?.id || '',
            artifactQuality: cloneSafeResultValue(result.artifactQuality),
            agentQuality: cloneSafeResultValue(result.agentQuality),
        }).filter(([, entry]) => entry !== '' && entry !== null));
    }

    function uniqueStrings(values = []) {
        return Array.from(new Set((Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)));
    }

    function normalizePublicDomainHost(value = '') {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return '';
        let candidate = raw;
        try {
            const parsed = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
            candidate = parsed.hostname;
        } catch (_error) {
            candidate = candidate.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
        }
        const normalized = candidate
            .replace(/^\.+|\.+$/g, '')
            .replace(/[^a-z0-9.-]+/g, '-')
            .replace(/\.{2,}/g, '.');
        const labels = normalized.split('.').filter(Boolean);
        if (labels.length < 2 || normalized.length > 253) return '';
        if (labels.some((label) => (
            label.length > 63
            || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
        ))) {
            return '';
        }
        return labels.join('.');
    }

    function normalizeDnsLabel(value = '') {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//i, '')
            .split(/[./?#]/)[0]
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .replace(/-{2,}/g, '-')
            .slice(0, 63)
            .replace(/-+$/g, '');
        return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized) ? normalized : '';
    }

    function getSuggestedDnsLabel(artifact = null) {
        const source = String(
            artifact?.metadata?.title
            || artifact?.filename
            || 'demo',
        ).replace(/\.[a-z0-9]+$/i, '').trim();
        return normalizeDnsLabel(source) || 'demo';
    }

    function resolveRequestedPublicHost(input = '', baseDomain = DEFAULT_PUBLIC_WEB_DOMAIN) {
        const raw = String(input || '').trim();
        if (!raw) return null;
        const fullHost = normalizePublicDomainHost(raw);
        if (fullHost) {
            const hostLabel = fullHost.split('.')[0] || '';
            return {
                dnsName: hostLabel,
                publicHost: fullHost,
                slug: normalizeDnsLabel(hostLabel),
            };
        }
        const dnsName = normalizeDnsLabel(raw);
        if (!dnsName) return null;
        const normalizedBaseDomain = normalizePublicDomainHost(baseDomain) || DEFAULT_PUBLIC_WEB_DOMAIN;
        return {
            dnsName,
            publicHost: `${dnsName}.${normalizedBaseDomain}`,
            slug: dnsName,
        };
    }

    function buildRemoteAgentParams(task, options = {}) {
        const normalizedTask = String(task || '').trim();
        if (!normalizedTask) {
            throw new RemoteArtifactWorkflowError('Remote agent task is required.', {
                code: 'REMOTE_AGENT_TASK_REQUIRED',
                status: 400,
            });
        }

        const artifactIds = uniqueStrings(options.artifactIds).map(requireArtifactId);
        const contextFiles = (Array.isArray(options.contextFiles) ? options.contextFiles : [])
            .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
        const resultFileGlobs = uniqueStrings(options.resultFileGlobs);
        const model = String(options.model || '').trim();
        const params = {
            task: normalizedTask,
            ...(Number.isFinite(Number(options.waitMs)) ? { waitMs: Number(options.waitMs) } : {}),
            ...(Number.isFinite(Number(options.maxTurns)) ? { maxTurns: Number(options.maxTurns) } : {}),
            ...(model ? { model } : {}),
        };
        [
            'cwd',
            'workspacePath',
            'targetId',
            'sessionId',
            'threadId',
            'jobId',
            'mcpSessionId',
            'transport',
            'instructions',
            'supportAgentResponse',
            'continuitySummary',
            'remoteCodeModel',
        ].forEach((field) => {
            const normalized = String(options[field] || '').trim();
            if (normalized) params[field] = normalized;
        });
        ['agentRunTimeoutMs', 'maxStatusPolls', 'statusPollIntervalMs'].forEach((field) => {
            const value = Number(options[field]);
            if (Number.isFinite(value)) params[field] = value;
        });
        if (artifactIds.length > 0) params.artifactIds = artifactIds;
        if (contextFiles.length > 0) params.contextFiles = contextFiles;
        if (resultFileGlobs.length > 0) params.resultFileGlobs = resultFileGlobs;
        if (options.collectResultFiles !== undefined) params.collectResultFiles = options.collectResultFiles === true;
        if (options.adminMode !== undefined) params.adminMode = options.adminMode === true;
        return params;
    }

    function buildRemoteAgentInvokeBody(task, options = {}) {
        const params = buildRemoteAgentParams(task, options);
        const clientSurface = String(options.clientSurface || 'shared-browser').trim();
        const taskType = String(options.taskType || 'chat').trim();
        const metadata = options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
            ? options.metadata
            : {};
        return {
            tool: 'remote-cli-agent',
            params,
            sessionId: String(options.browserSessionId || options.activeSessionId || '').trim() || null,
            model: String(options.model || '').trim() || null,
            taskType,
            clientSurface,
            executionProfile: 'remote-build',
            metadata: {
                ...metadata,
                clientSurface,
            },
        };
    }

    async function readResponsePayload(response) {
        const fallbackResponse = typeof response?.clone === 'function' ? response.clone() : null;
        try {
            return await response.json();
        } catch (_error) {
            try {
                const text = await (fallbackResponse || response).text();
                return text ? { message: text } : {};
            } catch (_textError) {
                return {};
            }
        }
    }

    function normalizeErrorDetails(value = null) {
        const normalized = cloneSafeResultValue(value);
        return normalized && typeof normalized === 'object' ? normalized : null;
    }

    function buildResponseError(response, payload = {}, fallbackMessage = 'Request failed.') {
        const rawError = payload?.error;
        const error = rawError && typeof rawError === 'object' ? rawError : {};
        const message = sanitizeResultText(
            error.message
            || (typeof rawError === 'string' ? rawError : '')
            || payload?.message
            || `${fallbackMessage} HTTP ${response?.status || 'unknown'}`,
            1200,
        );
        const status = Number(response?.status);
        const code = sanitizeResultText(error.code || payload?.code || `HTTP_${status || 'ERROR'}`, 160);
        return new RemoteArtifactWorkflowError(message, {
            code,
            status: Number.isFinite(status) ? status : null,
            blocker: sanitizeResultText(error.blocker || payload?.blocker || '', 160),
            details: normalizeErrorDetails(error.details || payload?.details),
            retryable: status === 429 || status >= 500,
            authRequired: status === 401,
            sourceChanged: status === 412 || code === 'ARTIFACT_MANAGED_APP_SOURCE_CHANGED',
        });
    }

    function normalizeManagedAppPreflight(payload = {}, fallbackArtifactId = '') {
        const artifactId = normalizeArtifactId(payload.artifactId || fallbackArtifactId);
        const sha256 = normalizeText(payload.sha256 || '', 64).toLowerCase();
        const files = (Array.isArray(payload.files) ? payload.files : [])
            .slice(0, SAFE_RESULT_ITEM_LIMIT)
            .map((file) => {
                const fileSha256 = normalizeText(file?.sha256 || '', 64).toLowerCase();
                const sizeBytes = Number(file?.sizeBytes);
                return Object.fromEntries(Object.entries({
                    path: normalizeText(file?.path || '', 500),
                    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
                    sha256: SHA256_PATTERN.test(fileSha256) ? fileSha256 : '',
                }).filter(([, value]) => value !== '' && value !== null));
            });
        const blockers = (Array.isArray(payload.blockers) ? payload.blockers : [])
            .slice(0, SAFE_RESULT_ITEM_LIMIT)
            .map((blocker) => ({
                code: sanitizeResultText(blocker?.code || 'MANAGED_APP_PREFLIGHT_BLOCKED', 160),
                message: sanitizeResultText(blocker?.message || 'Push to Web is blocked.', 1200),
                remediation: sanitizeResultText(blocker?.remediation || '', 1200),
                blocker: sanitizeResultText(blocker?.blocker || '', 160),
                details: normalizeErrorDetails(blocker?.details),
            }));
        const fileCount = Number(payload.fileCount);
        const sizeBytes = Number(payload.sizeBytes);
        return {
            artifactId,
            contentEligible: payload.contentEligible === true,
            controlPlaneAvailable: payload.controlPlaneAvailable === true,
            pushToWebEligible: payload.pushToWebEligible === true,
            sourceType: normalizeText(payload.sourceType || '', 120),
            targetPaths: uniqueStrings(payload.targetPaths).map((entry) => normalizeText(entry, 500)),
            fileCount: Number.isFinite(fileCount) && fileCount >= 0 ? fileCount : files.length,
            sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0,
            sha256: SHA256_PATTERN.test(sha256) ? sha256 : '',
            files,
            blockers,
        };
    }

    function assertManagedAppPreflightEligible(preflight = null, artifactId = '') {
        if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) {
            throw new RemoteArtifactWorkflowError('Push to Web requires a completed preflight.', {
                code: 'MANAGED_APP_PREFLIGHT_REQUIRED',
                status: 400,
            });
        }
        const normalized = normalizeManagedAppPreflight(preflight, artifactId);
        const expectedArtifactId = artifactId ? requireArtifactId(artifactId) : normalized.artifactId;
        if (!normalized.artifactId || normalized.artifactId !== expectedArtifactId) {
            throw new RemoteArtifactWorkflowError('The preflight belongs to a different artifact.', {
                code: 'MANAGED_APP_PREFLIGHT_ARTIFACT_MISMATCH',
                status: 400,
            });
        }
        if (normalized.pushToWebEligible !== true) {
            const blocker = normalized.blockers[0] || {};
            const message = blocker.message || 'Push to Web is blocked.';
            throw new RemoteArtifactWorkflowError(
                blocker.remediation ? `${message} Next: ${blocker.remediation}` : message,
                {
                    code: blocker.code || 'MANAGED_APP_PREFLIGHT_BLOCKED',
                    status: 422,
                    blocker: blocker.blocker || 'managed_app_preflight_blocked',
                    details: {
                        ...(blocker.details || {}),
                        ...(blocker.remediation ? { remediation: blocker.remediation } : {}),
                    },
                },
            );
        }
        if (!SHA256_PATTERN.test(normalized.sha256)) {
            throw new RemoteArtifactWorkflowError('Managed-app preflight did not return a valid source fingerprint.', {
                code: 'MANAGED_APP_PREFLIGHT_SHA256_INVALID',
                status: 422,
            });
        }
        return normalized;
    }

    function normalizeApiBaseUrl(value = '') {
        const fallback = typeof window !== 'undefined' && window.location?.origin
            ? window.location.origin
            : 'http://localhost:3000';
        try {
            const parsed = new URL(String(value || fallback));
            parsed.pathname = parsed.pathname.replace(/\/$/, '');
            parsed.search = '';
            parsed.hash = '';
            return parsed.toString().replace(/\/$/, '');
        } catch (_error) {
            return fallback.replace(/\/$/, '');
        }
    }

    function createManagedAppClient(options = {}) {
        const fetchImpl = options.fetchImpl
            || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
        if (typeof fetchImpl !== 'function') {
            throw new RemoteArtifactWorkflowError('Fetch is unavailable.', {
                code: 'REMOTE_ARTIFACT_FETCH_UNAVAILABLE',
            });
        }
        const baseUrl = normalizeApiBaseUrl(options.baseUrl);
        const getSessionId = typeof options.getSessionId === 'function'
            ? options.getSessionId
            : () => String(options.sessionId || '').trim();

        async function request(pathname, requestOptions = {}) {
            let response;
            try {
                response = await fetchImpl(`${baseUrl}${pathname}`, {
                    method: requestOptions.method || 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
                    credentials: 'same-origin',
                    cache: 'no-store',
                    ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
                    body: JSON.stringify(requestOptions.body || {}),
                });
            } catch (error) {
                if (error?.name === 'AbortError') {
                    throw new RemoteArtifactWorkflowError('Request was cancelled.', {
                        code: 'REMOTE_ARTIFACT_REQUEST_CANCELLED',
                    });
                }
                throw new RemoteArtifactWorkflowError(
                    sanitizeResultText(error?.message || 'Network request failed.', 1200),
                    { code: 'REMOTE_ARTIFACT_NETWORK_ERROR' },
                );
            }

            const payload = await readResponsePayload(response);
            if (!response.ok) {
                throw buildResponseError(response, payload, requestOptions.fallbackMessage);
            }
            return payload && typeof payload === 'object' ? payload : {};
        }

        async function preflightArtifact(artifactId, requestOptions = {}) {
            const normalizedId = requireArtifactId(artifactId);
            const sessionId = String(requestOptions.sessionId || getSessionId() || '').trim();
            const payload = await request(
                `/api/artifacts/${encodeURIComponent(normalizedId)}/managed-app/preflight`,
                {
                    signal: requestOptions.signal,
                    fallbackMessage: 'Managed-app preflight failed.',
                    body: {
                        ...(sessionId ? { sessionId } : {}),
                        validateOnly: true,
                    },
                },
            );
            return normalizeManagedAppPreflight(payload, normalizedId);
        }

        async function deployArtifact(artifactId, requestOptions = {}) {
            const normalizedId = requireArtifactId(artifactId);
            if (requestOptions.confirmed !== true) {
                throw new RemoteArtifactWorkflowError('Push to Web requires explicit confirmation.', {
                    code: 'MANAGED_APP_DEPLOY_CONFIRMATION_REQUIRED',
                    status: 400,
                });
            }
            const preflight = assertManagedAppPreflightEligible(requestOptions.preflight, normalizedId);
            const requestedSha256 = normalizeText(requestOptions.expectedSourceSha256 || preflight.sha256, 64).toLowerCase();
            if (!SHA256_PATTERN.test(requestedSha256) || requestedSha256 !== preflight.sha256) {
                throw new RemoteArtifactWorkflowError('The accepted source fingerprint does not match this preflight.', {
                    code: 'MANAGED_APP_EXPECTED_SOURCE_SHA256_MISMATCH',
                    status: 400,
                });
            }

            const sessionId = String(requestOptions.sessionId || getSessionId() || '').trim();
            const body = {
                ...(sessionId ? { sessionId } : {}),
                requestedAction: String(requestOptions.requestedAction || 'deploy').trim() || 'deploy',
                deployRequested: true,
                expectedSourceSha256: preflight.sha256,
            };
            [
                'appName',
                'name',
                'dnsName',
                'publicBaseDomain',
                'publicHost',
                'slug',
                'sourcePrompt',
                'model',
            ].forEach((field) => {
                const value = String(requestOptions[field] || '').trim();
                if (value) body[field] = value;
            });
            if (requestOptions.metadata && typeof requestOptions.metadata === 'object' && !Array.isArray(requestOptions.metadata)) {
                body.metadata = requestOptions.metadata;
            }

            return request(`/api/artifacts/${encodeURIComponent(normalizedId)}/managed-app`, {
                signal: requestOptions.signal,
                fallbackMessage: 'Managed-app deployment failed.',
                body,
            });
        }

        return {
            preflightArtifact,
            deployArtifact,
        };
    }

    function createArtifactHandoffClient(options = {}) {
        const fetchImpl = options.fetchImpl
            || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
        if (typeof fetchImpl !== 'function') {
            throw new RemoteArtifactWorkflowError('Fetch is unavailable.', {
                code: 'REMOTE_ARTIFACT_FETCH_UNAVAILABLE',
            });
        }
        const baseUrl = normalizeApiBaseUrl(options.baseUrl);
        const getSessionId = typeof options.getSessionId === 'function'
            ? options.getSessionId
            : () => String(options.sessionId || '').trim();
        const setSessionId = typeof options.setSessionId === 'function'
            ? options.setSessionId
            : () => {};

        async function attachArtifact(sourceArtifactId, requestOptions = {}) {
            const normalizedSourceId = requireArtifactId(sourceArtifactId);
            const targetSessionId = String(requestOptions.targetSessionId || getSessionId() || '').trim();
            const mode = String(requestOptions.mode || 'artifact').trim() || 'artifact';
            const taskType = String(requestOptions.taskType || mode).trim() || mode;
            const clientSurface = String(requestOptions.clientSurface || taskType).trim() || taskType;
            let response;
            try {
                response = await fetchImpl(
                    `${baseUrl}/api/artifacts/${encodeURIComponent(normalizedSourceId)}/attach`,
                    {
                        method: 'POST',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                        },
                        credentials: 'same-origin',
                        cache: 'no-store',
                        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
                        body: JSON.stringify({
                            ...(targetSessionId ? { targetSessionId } : {}),
                            mode,
                            taskType,
                            clientSurface,
                        }),
                    },
                );
            } catch (error) {
                if (error?.name === 'AbortError') {
                    throw new RemoteArtifactWorkflowError('Artifact handoff was cancelled.', {
                        code: 'ARTIFACT_ATTACH_CANCELLED',
                    });
                }
                throw new RemoteArtifactWorkflowError(
                    sanitizeResultText(error?.message || 'Artifact handoff failed.', 1200),
                    { code: 'ARTIFACT_ATTACH_NETWORK_ERROR' },
                );
            }

            const payload = await readResponsePayload(response);
            if (!response.ok) {
                throw buildResponseError(response, payload, 'Artifact handoff failed.');
            }
            const artifact = normalizeArtifact(payload?.artifact, {
                baseOrigin: normalizeBaseOrigin(baseUrl),
            });
            const resolvedTargetSessionId = String(payload?.targetSessionId || artifact?.sessionId || '').trim();
            const sourceId = normalizeArtifactId(payload?.sourceArtifactId || normalizedSourceId);
            const sha256 = normalizeText(payload?.sha256 || '', 64).toLowerCase();
            if (!artifact?.id || !resolvedTargetSessionId || sourceId !== normalizedSourceId || !SHA256_PATTERN.test(sha256)) {
                throw new RemoteArtifactWorkflowError('Artifact handoff returned an invalid destination contract.', {
                    code: 'ARTIFACT_ATTACH_RESPONSE_INVALID',
                    status: 502,
                });
            }
            if (artifact.sessionId && artifact.sessionId !== resolvedTargetSessionId) {
                throw new RemoteArtifactWorkflowError('Attached artifact session does not match the destination session.', {
                    code: 'ARTIFACT_ATTACH_SESSION_MISMATCH',
                    status: 502,
                });
            }
            if (targetSessionId && resolvedTargetSessionId !== targetSessionId) {
                throw new RemoteArtifactWorkflowError('Artifact handoff resolved to a different destination session.', {
                    code: 'ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
                    status: 502,
                });
            }

            const capability = payload?.importCapability && typeof payload.importCapability === 'object'
                ? {
                    surface: normalizeText(payload.importCapability.surface || clientSurface, 120),
                    format: normalizeText(payload.importCapability.format || artifact.format || '', 80),
                    disposition: normalizeText(payload.importCapability.disposition || 'context-only', 80),
                    browserImportAllowed: payload.importCapability.browserImportAllowed === true,
                    fidelity: normalizeText(payload.importCapability.fidelity || '', 120),
                    reason: sanitizeResultText(payload.importCapability.reason || '', 1200),
                }
                : {
                    surface: clientSurface,
                    format: artifact.format || '',
                    disposition: 'context-only',
                    browserImportAllowed: false,
                    fidelity: 'source-preserved',
                    reason: 'The artifact is attached as agent context.',
                };
            setSessionId(resolvedTargetSessionId);
            return {
                targetSessionId: resolvedTargetSessionId,
                sourceArtifactId: normalizedSourceId,
                artifact,
                sha256,
                reused: payload?.reused === true,
                importCapability: capability,
            };
        }

        return { attachArtifact };
    }

    return {
        DEFAULT_PUBLIC_WEB_DOMAIN,
        RemoteArtifactWorkflowError,
        assertManagedAppPreflightEligible,
        buildArtifactRoute,
        buildRemoteAgentInvokeBody,
        buildRemoteAgentParams,
        cloneSafeResultValue,
        collectRemoteAgentArtifacts,
        createArtifactHandoffClient,
        createManagedAppClient,
        isSensitiveQueryKey,
        normalizeArtifact,
        normalizeArtifactId,
        normalizeArtifactRouteUrl,
        normalizeDnsLabel,
        normalizeManagedAppPreflight,
        normalizePublicDomainHost,
        normalizeRemoteAgentResult,
        normalizeResultFile,
        getSuggestedDnsLabel,
        resolveRequestedPublicHost,
        sanitizeResultText,
    };
});

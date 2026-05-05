const fs = require('fs');
const path = require('path');
const settingsController = require('./routes/admin/settings.controller');
const { getSessionControlState } = require('./runtime-control-state');
const { resolvePreferredWritableFile } = require('./runtime-state-paths');

const REMOTE_TOOL_IDS = new Set(['k3s-deploy', 'remote-command', 'ssh-execute', 'remote-workbench']);
const STORAGE_PATH = resolvePreferredWritableFile(
    path.join(process.cwd(), 'data', 'cluster-state-registry.json'),
    ['cluster-state-registry.json'],
);
const MAX_PATHS_PER_ENTRY = 8;
const MAX_DOMAINS_PER_ENTRY = 8;
const MAX_RECENT_ACTIVITY = 24;
const MAX_TARGET_CONTEXT_ITEMS = 6;
const MAX_EDGE_ROUTES_IN_PROMPT = 5;
const INGRESS_EVENT_PREFIX = 'KIMIBUILT_INGRESS_EVENT ';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value = '') {
    return String(value || '').trim();
}

function normalizeLowerText(value = '') {
    return normalizeText(value).toLowerCase();
}

function toIsoTimestamp(value = null, fallback = null) {
    const normalized = normalizeText(value);
    if (!normalized) {
        return fallback;
    }

    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function summarizeText(value = '', limit = 220) {
    const normalized = normalizeText(value).replace(/\s+/g, ' ');
    if (!normalized) {
        return '';
    }

    if (normalized.length <= limit) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function uniqueStrings(values = [], limit = null) {
    const normalized = [];
    const seen = new Set();

    for (const entry of Array.isArray(values) ? values : []) {
        const value = normalizeText(entry);
        if (!value) {
            continue;
        }

        const key = value.toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        normalized.push(value);

        if (Number.isFinite(limit) && normalized.length >= limit) {
            break;
        }
    }

    return normalized;
}

function mergeUniqueStrings(existing = [], additions = [], limit = null) {
    return uniqueStrings([
        ...(Array.isArray(existing) ? existing : []),
        ...(Array.isArray(additions) ? additions : []),
    ], limit);
}

function extractUnixPaths(text = '') {
    const source = String(text || '');
    if (!source) {
        return [];
    }

    const matches = source.match(/(?:^|[\s"'`(])((?:\/(?:app|etc|opt|srv|var|home|root|usr|tmp)(?:\/[A-Za-z0-9._:-]+)+)\/?)/g) || [];
    return uniqueStrings(matches.map((entry) => entry.replace(/^[\s"'`(]+/, '').replace(/[),.;:]+$/, '')));
}

function extractDomains(text = '') {
    const source = String(text || '');
    if (!source) {
        return [];
    }

    const matches = source.match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/ig) || [];
    return uniqueStrings(matches);
}

function parseJsonObject(value = '') {
    const normalized = normalizeText(value);
    if (!normalized) {
        return {};
    }

    try {
        const parsed = JSON.parse(normalized);
        return isPlainObject(parsed) ? parsed : {};
    } catch (_error) {
        return {};
    }
}

function parseHostPort(value = '') {
    const normalized = normalizeText(value);
    if (!normalized) {
        return { host: '', port: null };
    }

    const match = normalized.match(/^(.+?):(\d+)$/);
    if (!match) {
        return { host: normalized, port: null };
    }

    return {
        host: normalizeText(match[1]),
        port: Number(match[2]) || null,
    };
}

function normalizePort(value = null, fallback = 22) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOptionalBoolean(value = null) {
    if (value === true) {
        return true;
    }
    if (value === false) {
        return false;
    }
    return null;
}

function normalizeTargetServerContext(value = {}) {
    const source = isPlainObject(value) ? value : {};
    return {
        hostname: normalizeText(source.hostname),
        remoteUser: normalizeText(source.remoteUser),
        arch: normalizeText(source.arch),
        osSummary: summarizeText(source.osSummary || '', 160),
        uptimeSummary: summarizeText(source.uptimeSummary || '', 160),
        k3sVersion: summarizeText(source.k3sVersion || '', 120),
        kubectlVersion: summarizeText(source.kubectlVersion || '', 120),
        nodeNames: uniqueStrings(source.nodeNames, MAX_TARGET_CONTEXT_ITEMS),
        ingressClasses: uniqueStrings(source.ingressClasses, MAX_TARGET_CONTEXT_ITEMS),
        platformNamespaces: uniqueStrings(source.platformNamespaces, MAX_TARGET_CONTEXT_ITEMS),
        traefikInstalled: normalizeOptionalBoolean(source.traefikInstalled),
        certManagerInstalled: normalizeOptionalBoolean(source.certManagerInstalled),
        lastRefreshedAt: toIsoTimestamp(source.lastRefreshedAt, null),
    };
}

function mergeTargetServerContext(existing = {}, patch = {}) {
    const normalizedExisting = normalizeTargetServerContext(existing);
    const normalizedPatch = normalizeTargetServerContext(patch);
    return normalizeTargetServerContext({
        hostname: normalizedPatch.hostname || normalizedExisting.hostname,
        remoteUser: normalizedPatch.remoteUser || normalizedExisting.remoteUser,
        arch: normalizedPatch.arch || normalizedExisting.arch,
        osSummary: normalizedPatch.osSummary || normalizedExisting.osSummary,
        uptimeSummary: normalizedPatch.uptimeSummary || normalizedExisting.uptimeSummary,
        k3sVersion: normalizedPatch.k3sVersion || normalizedExisting.k3sVersion,
        kubectlVersion: normalizedPatch.kubectlVersion || normalizedExisting.kubectlVersion,
        nodeNames: mergeUniqueStrings(normalizedExisting.nodeNames, normalizedPatch.nodeNames, MAX_TARGET_CONTEXT_ITEMS),
        ingressClasses: mergeUniqueStrings(normalizedExisting.ingressClasses, normalizedPatch.ingressClasses, MAX_TARGET_CONTEXT_ITEMS),
        platformNamespaces: mergeUniqueStrings(normalizedExisting.platformNamespaces, normalizedPatch.platformNamespaces, MAX_TARGET_CONTEXT_ITEMS),
        traefikInstalled: normalizedPatch.traefikInstalled !== null
            ? normalizedPatch.traefikInstalled
            : normalizedExisting.traefikInstalled,
        certManagerInstalled: normalizedPatch.certManagerInstalled !== null
            ? normalizedPatch.certManagerInstalled
            : normalizedExisting.certManagerInstalled,
        lastRefreshedAt: normalizedPatch.lastRefreshedAt || normalizedExisting.lastRefreshedAt,
    });
}

function createEmptyState() {
    return {
        version: 1,
        updatedAt: null,
        targets: {},
        deployments: {},
        edgeRoutes: {},
        recentActivity: [],
    };
}

function normalizeVerification(value = {}) {
    const source = isPlainObject(value) ? value : {};
    return {
        rollout: source.rollout === true,
        ingress: source.ingress === true,
        tls: source.tls === true,
        https: source.https === true,
        lastRolloutAt: toIsoTimestamp(source.lastRolloutAt, null),
        lastVerifiedAt: toIsoTimestamp(source.lastVerifiedAt, null),
    };
}

function normalizeEdgeRouteVerification(value = {}) {
    const source = isPlainObject(value) ? value : {};
    return {
        ingress: source.ingress === true,
        tls: source.tls === true,
        certificateReady: source.certificateReady === true,
        https: source.https === true,
        lastVerifiedAt: toIsoTimestamp(source.lastVerifiedAt, null),
    };
}

function normalizeState(value = {}) {
    const source = isPlainObject(value) ? value : {};
    const state = createEmptyState();
    state.updatedAt = toIsoTimestamp(source.updatedAt, null);

    if (isPlainObject(source.targets)) {
        state.targets = Object.fromEntries(
            Object.entries(source.targets)
                .map(([key, entry]) => {
                    if (!isPlainObject(entry)) {
                        return [key, null];
                    }

                    return [key, {
                        key: normalizeText(entry.key || key),
                        host: normalizeText(entry.host),
                        username: normalizeText(entry.username),
                        port: normalizePort(entry.port, 22),
                        firstSeenAt: toIsoTimestamp(entry.firstSeenAt, null),
                        lastSeenAt: toIsoTimestamp(entry.lastSeenAt, null),
                        paths: uniqueStrings(entry.paths, MAX_PATHS_PER_ENTRY),
                        domains: uniqueStrings(entry.domains, MAX_DOMAINS_PER_ENTRY),
                        lastObjective: summarizeText(entry.lastObjective || '', 220),
                        lastInspectionAt: toIsoTimestamp(entry.lastInspectionAt, null),
                        lastStatus: normalizeLowerText(entry.lastStatus),
                        serverContext: normalizeTargetServerContext(entry.serverContext),
                    }];
                })
                .filter(([, entry]) => entry && entry.host),
        );
    }

    if (isPlainObject(source.deployments)) {
        state.deployments = Object.fromEntries(
            Object.entries(source.deployments)
                .map(([key, entry]) => {
                    if (!isPlainObject(entry)) {
                        return [key, null];
                    }

                    return [key, {
                        key: normalizeText(entry.key || key),
                        targetKey: normalizeText(entry.targetKey),
                        host: normalizeText(entry.host),
                        username: normalizeText(entry.username),
                        port: normalizePort(entry.port, 22),
                        namespace: normalizeText(entry.namespace),
                        deployment: normalizeText(entry.deployment),
                        container: normalizeText(entry.container),
                        repositoryUrl: normalizeText(entry.repositoryUrl),
                        ref: normalizeText(entry.ref),
                        targetDirectory: normalizeText(entry.targetDirectory),
                        manifestsPath: normalizeText(entry.manifestsPath),
                        publicDomain: normalizeText(entry.publicDomain),
                        ingressClassName: normalizeText(entry.ingressClassName),
                        tlsClusterIssuer: normalizeText(entry.tlsClusterIssuer),
                        firstSeenAt: toIsoTimestamp(entry.firstSeenAt, null),
                        lastSeenAt: toIsoTimestamp(entry.lastSeenAt, null),
                        lastAction: normalizeLowerText(entry.lastAction),
                        lastTool: normalizeLowerText(entry.lastTool),
                        lastActionAt: toIsoTimestamp(entry.lastActionAt, null),
                        lastSuccessAt: toIsoTimestamp(entry.lastSuccessAt, null),
                        lastFailureAt: toIsoTimestamp(entry.lastFailureAt, null),
                        lastVerificationAt: toIsoTimestamp(entry.lastVerificationAt, null),
                        lastStatus: normalizeLowerText(entry.lastStatus),
                        lastError: summarizeText(entry.lastError || '', 220),
                        lastCommand: summarizeText(entry.lastCommand || '', 260),
                        lastStdout: summarizeText(entry.lastStdout || '', 220),
                        lastObjective: summarizeText(entry.lastObjective || '', 220),
                        paths: uniqueStrings(entry.paths, MAX_PATHS_PER_ENTRY),
                        domains: uniqueStrings(entry.domains, MAX_DOMAINS_PER_ENTRY),
                        verification: normalizeVerification(entry.verification),
                    }];
                })
                .filter(([, entry]) => entry && (entry.host || entry.publicDomain || entry.deployment)),
        );
    }

    if (isPlainObject(source.edgeRoutes)) {
        state.edgeRoutes = Object.fromEntries(
            Object.entries(source.edgeRoutes)
                .map(([key, entry]) => {
                    if (!isPlainObject(entry)) {
                        return [key, null];
                    }

                    return [key, {
                        key: normalizeText(entry.key || key),
                        targetKey: normalizeText(entry.targetKey),
                        targetHost: normalizeText(entry.targetHost || entry.host),
                        username: normalizeText(entry.username),
                        port: normalizePort(entry.port, 22),
                        namespace: normalizeText(entry.namespace),
                        ingressName: normalizeText(entry.ingressName),
                        hostName: normalizeText(entry.hostName || entry.publicDomain),
                        path: normalizeText(entry.path) || '/',
                        pathType: normalizeText(entry.pathType) || 'Prefix',
                        serviceName: normalizeText(entry.serviceName),
                        servicePort: normalizeText(entry.servicePort),
                        deployment: normalizeText(entry.deployment),
                        ingressClassName: normalizeText(entry.ingressClassName),
                        tlsClusterIssuer: normalizeText(entry.tlsClusterIssuer),
                        tlsSecretName: normalizeText(entry.tlsSecretName),
                        acmeEmail: normalizeText(entry.acmeEmail),
                        firstSeenAt: toIsoTimestamp(entry.firstSeenAt, null),
                        lastSeenAt: toIsoTimestamp(entry.lastSeenAt, null),
                        lastAction: normalizeLowerText(entry.lastAction),
                        lastTool: normalizeLowerText(entry.lastTool),
                        lastActionAt: toIsoTimestamp(entry.lastActionAt, null),
                        lastSuccessAt: toIsoTimestamp(entry.lastSuccessAt, null),
                        lastFailureAt: toIsoTimestamp(entry.lastFailureAt, null),
                        lastVerificationAt: toIsoTimestamp(entry.lastVerificationAt, null),
                        lastStatus: normalizeLowerText(entry.lastStatus),
                        lastError: summarizeText(entry.lastError || '', 220),
                        lastCommand: summarizeText(entry.lastCommand || '', 260),
                        lastStdout: summarizeText(entry.lastStdout || '', 220),
                        lastObjective: summarizeText(entry.lastObjective || '', 220),
                        verification: normalizeEdgeRouteVerification(entry.verification),
                    }];
                })
                .filter(([, entry]) => entry && (entry.hostName || entry.ingressName || entry.serviceName)),
        );
    }

    if (Array.isArray(source.recentActivity)) {
        state.recentActivity = source.recentActivity
            .map((entry) => {
                if (!isPlainObject(entry)) {
                    return null;
                }

                const timestamp = toIsoTimestamp(entry.timestamp, null);
                const toolId = normalizeLowerText(entry.toolId);
                const status = normalizeLowerText(entry.status);
                const summary = summarizeText(entry.summary || '', 220);
                if (!timestamp || !toolId || !summary) {
                    return null;
                }

                return {
                    timestamp,
                    toolId,
                    action: normalizeLowerText(entry.action),
                    status,
                    host: normalizeText(entry.host),
                    namespace: normalizeText(entry.namespace),
                    deployment: normalizeText(entry.deployment),
                    publicDomain: normalizeText(entry.publicDomain),
                    summary,
                    error: summarizeText(entry.error || '', 220),
                };
            })
            .filter(Boolean)
            .slice(0, MAX_RECENT_ACTIVITY);
    }

    return state;
}

function inferK3sDeployAction(params = {}) {
    const explicit = normalizeLowerText(params.action);
    if (explicit) {
        return explicit;
    }

    if (normalizeText(params.image)) {
        return 'set-image';
    }

    if (normalizeText(params.repositoryUrl) || normalizeText(params.ref) || normalizeText(params.targetDirectory)) {
        return 'sync-and-apply';
    }

    if (normalizeText(params.manifestsPath)) {
        return 'apply-manifests';
    }

    if (normalizeText(params.deployment) || normalizeText(params.namespace)) {
        return 'rollout-status';
    }

    return 'sync-and-apply';
}

function extractNamespaceFromCommand(command = '') {
    const source = String(command || '');
    const match = source.match(/(?:^|\s)(?:-n|--namespace(?:=|\s+))\s*'?([a-z0-9]([-.a-z0-9]*[a-z0-9])?)'?/i);
    return normalizeText(match?.[1] || '');
}

function extractDeploymentFromCommand(command = '') {
    const source = String(command || '');
    const match = source.match(/deployment\/([a-z0-9]([-.a-z0-9]*[a-z0-9])?)/i);
    return normalizeText(match?.[1] || '');
}

function extractExpectedHostFromCommand(command = '') {
    const source = String(command || '');
    const explicitMatch = source.match(/expected_host='([^']+)'/i);
    if (explicitMatch?.[1]) {
        return normalizeText(explicitMatch[1]);
    }

    const curlMatch = source.match(/https:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
    return normalizeText(curlMatch?.[1] || '');
}

class ClusterStateRegistry {
    constructor() {
        this.storagePath = STORAGE_PATH;
        this.state = null;
    }

    getStoragePath() {
        return this.storagePath;
    }

    setStoragePathForTests(storagePath) {
        this.storagePath = path.resolve(storagePath);
        this.state = null;
    }

    resetForTests() {
        this.state = null;
    }

    getState() {
        if (this.state) {
            return this.state;
        }

        this.state = this.loadState();
        return this.state;
    }

    loadState() {
        try {
            if (!fs.existsSync(this.storagePath)) {
                return createEmptyState();
            }

            const raw = fs.readFileSync(this.storagePath, 'utf8');
            return normalizeState(JSON.parse(raw));
        } catch (error) {
            console.warn(`[ClusterStateRegistry] Failed to load state: ${error.message}`);
            return createEmptyState();
        }
    }

    saveState() {
        const state = this.getState();
        state.updatedAt = new Date().toISOString();

        try {
            fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
            fs.writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
        } catch (error) {
            console.warn(`[ClusterStateRegistry] Failed to save state: ${error.message}`);
        }
    }

    getEffectiveSshDefaults() {
        const sshConfig = typeof settingsController.getEffectiveSshConfig === 'function'
            ? settingsController.getEffectiveSshConfig()
            : {};

        return {
            host: normalizeText(sshConfig.host),
            username: normalizeText(sshConfig.username),
            port: normalizePort(sshConfig.port, 22),
        };
    }

    getEffectiveDeployDefaults() {
        const deployConfig = typeof settingsController.getEffectiveDeployConfig === 'function'
            ? settingsController.getEffectiveDeployConfig()
            : {};

        return {
            repositoryUrl: normalizeText(deployConfig.repositoryUrl),
            ref: normalizeText(deployConfig.ref || deployConfig.branch),
            targetDirectory: normalizeText(deployConfig.targetDirectory),
            manifestsPath: normalizeText(deployConfig.manifestsPath),
            namespace: normalizeText(deployConfig.namespace),
            deployment: normalizeText(deployConfig.deployment),
            container: normalizeText(deployConfig.container),
            publicDomain: normalizeText(deployConfig.publicDomain),
            ingressClassName: normalizeText(deployConfig.ingressClassName),
            tlsClusterIssuer: normalizeText(deployConfig.tlsClusterIssuer),
        };
    }

    resolveRemoteTarget({ params = {}, result = {}, controlState = null } = {}) {
        const sshDefaults = this.getEffectiveSshDefaults();
        const persistedTarget = getSessionControlState({ controlState, metadata: { controlState } }).lastSshTarget || {};
        const resultHost = parseHostPort(result?.host || '');

        const host = normalizeText(params.host || resultHost.host || persistedTarget.host || sshDefaults.host);
        if (!host) {
            return null;
        }

        return {
            host,
            username: normalizeText(params.username || persistedTarget.username || sshDefaults.username),
            port: normalizePort(params.port || resultHost.port || persistedTarget.port || sshDefaults.port, 22),
        };
    }

    buildTargetKey(target = {}) {
        const host = normalizeText(target.host);
        if (!host) {
            return '';
        }

        return `${host}:${normalizePort(target.port, 22)}`;
    }

    buildDeploymentKey({
        target = null,
        namespace = '',
        deployment = '',
        publicDomain = '',
    } = {}) {
        const targetKey = this.buildTargetKey(target || {});
        const workloadNamespace = normalizeText(namespace) || 'default';
        const workloadName = normalizeText(deployment || publicDomain) || 'unknown';
        return `${targetKey || 'unknown-target'}|${workloadNamespace}|${workloadName}`;
    }

    buildEdgeRouteKey({
        target = null,
        namespace = '',
        ingressName = '',
        hostName = '',
        path: routePath = '/',
    } = {}) {
        const targetKey = this.buildTargetKey(target || {});
        const routeNamespace = normalizeText(namespace) || 'default';
        const routeIngress = normalizeText(ingressName) || 'unknown-ingress';
        const routeHost = normalizeText(hostName) || 'unknown-host';
        const normalizedPath = normalizeText(routePath) || '/';
        return `${targetKey || 'unknown-target'}|${routeNamespace}|${routeIngress}|${routeHost}|${normalizedPath}`;
    }

    ensureTargetEntry(state, target = {}, objective = '') {
        const targetKey = this.buildTargetKey(target);
        if (!targetKey) {
            return null;
        }

        const existing = state.targets[targetKey] && isPlainObject(state.targets[targetKey])
            ? state.targets[targetKey]
            : {
                key: targetKey,
                host: normalizeText(target.host),
                username: normalizeText(target.username),
                port: normalizePort(target.port, 22),
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: null,
                paths: [],
                domains: [],
                lastObjective: '',
                lastInspectionAt: null,
                lastStatus: '',
                serverContext: normalizeTargetServerContext(),
            };

        existing.host = normalizeText(target.host) || existing.host;
        existing.username = normalizeText(target.username) || existing.username;
        existing.port = normalizePort(target.port, existing.port || 22);
        existing.lastSeenAt = new Date().toISOString();
        existing.serverContext = normalizeTargetServerContext(existing.serverContext);
        if (objective) {
            existing.lastObjective = summarizeText(objective, 220);
        }

        state.targets[targetKey] = existing;
        return existing;
    }

    recordTargetContext(state, {
        target = null,
        context = {},
        objective = '',
    } = {}) {
        const entry = this.ensureTargetEntry(state, target || {}, objective);
        if (!entry) {
            return null;
        }

        entry.serverContext = mergeTargetServerContext(entry.serverContext, context);
        if (entry.serverContext.lastRefreshedAt) {
            entry.lastInspectionAt = entry.serverContext.lastRefreshedAt;
        }

        return entry;
    }

    ensureDeploymentEntry(state, seed = {}) {
        const target = seed.target || null;
        const deploymentKey = this.buildDeploymentKey({
            target,
            namespace: seed.namespace,
            deployment: seed.deployment,
            publicDomain: seed.publicDomain,
        });

        const existing = state.deployments[deploymentKey] && isPlainObject(state.deployments[deploymentKey])
            ? state.deployments[deploymentKey]
            : {
                key: deploymentKey,
                targetKey: this.buildTargetKey(target || {}),
                host: normalizeText(target?.host),
                username: normalizeText(target?.username),
                port: normalizePort(target?.port, 22),
                namespace: normalizeText(seed.namespace),
                deployment: normalizeText(seed.deployment),
                container: normalizeText(seed.container),
                repositoryUrl: normalizeText(seed.repositoryUrl),
                ref: normalizeText(seed.ref),
                targetDirectory: normalizeText(seed.targetDirectory),
                manifestsPath: normalizeText(seed.manifestsPath),
                publicDomain: normalizeText(seed.publicDomain),
                ingressClassName: normalizeText(seed.ingressClassName),
                tlsClusterIssuer: normalizeText(seed.tlsClusterIssuer),
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: null,
                lastAction: '',
                lastTool: '',
                lastActionAt: null,
                lastSuccessAt: null,
                lastFailureAt: null,
                lastVerificationAt: null,
                lastStatus: '',
                lastError: '',
                lastCommand: '',
                lastStdout: '',
                lastObjective: '',
                paths: [],
                domains: [],
                verification: normalizeVerification(),
            };

        existing.targetKey = this.buildTargetKey(target || {}) || existing.targetKey;
        existing.host = normalizeText(target?.host) || existing.host;
        existing.username = normalizeText(target?.username) || existing.username;
        existing.port = normalizePort(target?.port, existing.port || 22);
        existing.namespace = normalizeText(seed.namespace) || existing.namespace;
        existing.deployment = normalizeText(seed.deployment) || existing.deployment;
        existing.container = normalizeText(seed.container) || existing.container;
        existing.repositoryUrl = normalizeText(seed.repositoryUrl) || existing.repositoryUrl;
        existing.ref = normalizeText(seed.ref) || existing.ref;
        existing.targetDirectory = normalizeText(seed.targetDirectory) || existing.targetDirectory;
        existing.manifestsPath = normalizeText(seed.manifestsPath) || existing.manifestsPath;
        existing.publicDomain = normalizeText(seed.publicDomain) || existing.publicDomain;
        existing.ingressClassName = normalizeText(seed.ingressClassName) || existing.ingressClassName;
        existing.tlsClusterIssuer = normalizeText(seed.tlsClusterIssuer) || existing.tlsClusterIssuer;
        existing.lastSeenAt = new Date().toISOString();
        existing.verification = normalizeVerification(existing.verification);

        state.deployments[deploymentKey] = existing;
        return existing;
    }

    ensureEdgeRouteEntry(state, seed = {}) {
        state.edgeRoutes = isPlainObject(state.edgeRoutes) ? state.edgeRoutes : {};
        const target = seed.target || null;
        const edgeRouteKey = this.buildEdgeRouteKey({
            target,
            namespace: seed.namespace,
            ingressName: seed.ingressName,
            hostName: seed.hostName,
            path: seed.path,
        });

        const existing = state.edgeRoutes[edgeRouteKey] && isPlainObject(state.edgeRoutes[edgeRouteKey])
            ? state.edgeRoutes[edgeRouteKey]
            : {
                key: edgeRouteKey,
                targetKey: this.buildTargetKey(target || {}),
                targetHost: normalizeText(target?.host),
                username: normalizeText(target?.username),
                port: normalizePort(target?.port, 22),
                namespace: normalizeText(seed.namespace),
                ingressName: normalizeText(seed.ingressName),
                hostName: normalizeText(seed.hostName),
                path: normalizeText(seed.path) || '/',
                pathType: normalizeText(seed.pathType) || 'Prefix',
                serviceName: normalizeText(seed.serviceName),
                servicePort: normalizeText(seed.servicePort),
                deployment: normalizeText(seed.deployment),
                ingressClassName: normalizeText(seed.ingressClassName),
                tlsClusterIssuer: normalizeText(seed.tlsClusterIssuer),
                tlsSecretName: normalizeText(seed.tlsSecretName),
                acmeEmail: normalizeText(seed.acmeEmail),
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: null,
                lastAction: '',
                lastTool: '',
                lastActionAt: null,
                lastSuccessAt: null,
                lastFailureAt: null,
                lastVerificationAt: null,
                lastStatus: '',
                lastError: '',
                lastCommand: '',
                lastStdout: '',
                lastObjective: '',
                verification: normalizeEdgeRouteVerification(),
            };

        existing.targetKey = this.buildTargetKey(target || {}) || existing.targetKey;
        existing.targetHost = normalizeText(target?.host) || existing.targetHost;
        existing.username = normalizeText(target?.username) || existing.username;
        existing.port = normalizePort(target?.port, existing.port || 22);
        existing.namespace = normalizeText(seed.namespace) || existing.namespace;
        existing.ingressName = normalizeText(seed.ingressName) || existing.ingressName;
        existing.hostName = normalizeText(seed.hostName) || existing.hostName;
        existing.path = normalizeText(seed.path) || existing.path || '/';
        existing.pathType = normalizeText(seed.pathType) || existing.pathType || 'Prefix';
        existing.serviceName = normalizeText(seed.serviceName) || existing.serviceName;
        existing.servicePort = normalizeText(seed.servicePort) || existing.servicePort;
        existing.deployment = normalizeText(seed.deployment) || existing.deployment;
        existing.ingressClassName = normalizeText(seed.ingressClassName) || existing.ingressClassName;
        existing.tlsClusterIssuer = normalizeText(seed.tlsClusterIssuer) || existing.tlsClusterIssuer;
        existing.tlsSecretName = normalizeText(seed.tlsSecretName) || existing.tlsSecretName;
        existing.acmeEmail = normalizeText(seed.acmeEmail) || existing.acmeEmail;
        existing.lastSeenAt = new Date().toISOString();
        existing.verification = normalizeEdgeRouteVerification(existing.verification);

        state.edgeRoutes[edgeRouteKey] = existing;
        return existing;
    }

    mergeObservedContext(entry, texts = []) {
        if (!entry || !isPlainObject(entry)) {
            return;
        }

        const sourceTexts = Array.isArray(texts) ? texts : [texts];
        const paths = uniqueStrings(sourceTexts.flatMap((value) => extractUnixPaths(value)));
        const domains = uniqueStrings(sourceTexts.flatMap((value) => extractDomains(value)));

        if (paths.length > 0) {
            entry.paths = mergeUniqueStrings(entry.paths, paths, MAX_PATHS_PER_ENTRY);
        }

        if (domains.length > 0) {
            entry.domains = mergeUniqueStrings(entry.domains, domains, MAX_DOMAINS_PER_ENTRY);
        }
    }

    recordActivity(state, activity = {}) {
        const normalized = {
            timestamp: new Date().toISOString(),
            toolId: normalizeLowerText(activity.toolId),
            action: normalizeLowerText(activity.action),
            status: normalizeLowerText(activity.status),
            host: normalizeText(activity.host),
            namespace: normalizeText(activity.namespace),
            deployment: normalizeText(activity.deployment),
            publicDomain: normalizeText(activity.publicDomain),
            summary: summarizeText(activity.summary || '', 220),
            error: summarizeText(activity.error || '', 220),
        };

        if (!normalized.toolId || !normalized.summary) {
            return;
        }

        state.recentActivity = [normalized, ...(Array.isArray(state.recentActivity) ? state.recentActivity : [])]
            .slice(0, MAX_RECENT_ACTIVITY);
    }

    extractIngressEvents(text = '') {
        return String(text || '')
            .split(/\r?\n/)
            .map((line) => {
                const index = line.indexOf(INGRESS_EVENT_PREFIX);
                if (index === -1) {
                    return null;
                }

                try {
                    const parsed = JSON.parse(line.slice(index + INGRESS_EVENT_PREFIX.length));
                    return isPlainObject(parsed) ? parsed : null;
                } catch (_error) {
                    return null;
                }
            })
            .filter((event) => event?.eventType === 'kimibuilt-ingress');
    }

    recordIngressRouteEvent({
        state,
        event = {},
        target = null,
        toolId = 'kimibuilt-ingress',
        objective = '',
        reason = '',
        command = '',
        stdout = '',
        success = true,
    } = {}) {
        if (!isPlainObject(event)) {
            return null;
        }

        const timestamp = toIsoTimestamp(event.timestamp, new Date().toISOString());
        const status = normalizeLowerText(event.status) || (success ? 'succeeded' : 'failed');
        const hostName = normalizeText(event.host || event.hostName || event.publicDomain);
        const ingressName = normalizeText(event.ingressName || event.ingress);
        const serviceName = normalizeText(event.serviceName || event.service);
        if (!hostName && status !== 'succeeded') {
            return null;
        }
        if (!hostName && !ingressName && !serviceName) {
            return null;
        }
        const entry = this.ensureEdgeRouteEntry(state, {
            target,
            namespace: event.namespace,
            ingressName,
            hostName,
            path: event.path || '/',
            pathType: event.pathType || 'Prefix',
            serviceName,
            servicePort: event.servicePort || event.port,
            deployment: event.deployment,
            ingressClassName: event.ingressClassName || event.ingressClass,
            tlsClusterIssuer: event.tlsClusterIssuer || event.issuer,
            tlsSecretName: event.tlsSecretName || event.tlsSecret,
            acmeEmail: event.acmeEmail || event.email,
        });
        if (!entry) {
            return null;
        }

        entry.lastTool = normalizeLowerText(toolId) || 'kimibuilt-ingress';
        entry.lastAction = normalizeLowerText(event.action) || 'ingress-route';
        entry.lastActionAt = timestamp;
        entry.lastObjective = summarizeText(objective || reason || event.message || '', 220);
        entry.lastCommand = summarizeText(command || '', 260);
        entry.lastStdout = summarizeText(stdout || event.message || '', 220);
        entry.lastStatus = status;

        const incomingVerification = normalizeEdgeRouteVerification(event.verification);
        entry.verification = normalizeEdgeRouteVerification({
            ingress: incomingVerification.ingress || entry.verification.ingress,
            tls: incomingVerification.tls || entry.verification.tls,
            certificateReady: incomingVerification.certificateReady || entry.verification.certificateReady,
            https: incomingVerification.https || entry.verification.https,
            lastVerifiedAt: incomingVerification.lastVerifiedAt || entry.verification.lastVerifiedAt,
        });

        if (status === 'succeeded') {
            entry.lastSuccessAt = timestamp;
            entry.lastError = '';
        } else {
            entry.lastFailureAt = timestamp;
            entry.lastError = summarizeText(event.error || 'Ingress route operation failed.', 220);
        }

        if (entry.lastAction === 'verify') {
            entry.lastVerificationAt = timestamp;
            entry.verification.lastVerifiedAt = timestamp;
        }

        if (entry.deployment) {
            const deployDefaults = this.getEffectiveDeployDefaults();
            const deploymentEntry = this.ensureDeploymentEntry(state, {
                target,
                namespace: entry.namespace,
                deployment: entry.deployment,
                publicDomain: entry.hostName,
                ingressClassName: entry.ingressClassName || deployDefaults.ingressClassName,
                tlsClusterIssuer: entry.tlsClusterIssuer || deployDefaults.tlsClusterIssuer,
            });
            if (deploymentEntry) {
                deploymentEntry.verification.ingress = entry.verification.ingress || deploymentEntry.verification.ingress;
                deploymentEntry.verification.tls = entry.verification.tls || deploymentEntry.verification.tls;
                deploymentEntry.verification.https = entry.verification.https || deploymentEntry.verification.https;
                if (entry.lastVerificationAt) {
                    deploymentEntry.lastVerificationAt = entry.lastVerificationAt;
                    deploymentEntry.verification.lastVerifiedAt = entry.lastVerificationAt;
                }
            }
        }

        this.recordActivity(state, {
            toolId: entry.lastTool,
            action: entry.lastAction,
            status: entry.lastStatus,
            host: entry.targetHost,
            namespace: entry.namespace,
            deployment: entry.deployment || entry.serviceName,
            publicDomain: entry.hostName,
            summary: status === 'succeeded'
                ? `${entry.lastTool} ${entry.lastAction} succeeded for ${entry.hostName}${entry.path} -> ${entry.namespace}/${entry.serviceName}:${entry.servicePort}.`
                : `${entry.lastTool} ${entry.lastAction} failed for ${entry.hostName || 'unknown-host'}${entry.path || '/'}.`,
            error: entry.lastError,
        });

        return entry;
    }

    recordIngressEventsFromText({
        state,
        text = '',
        target = null,
        toolId = 'remote-command',
        objective = '',
        reason = '',
        command = '',
        success = true,
    } = {}) {
        const events = this.extractIngressEvents(text);
        events.forEach((event) => {
            this.recordIngressRouteEvent({
                state,
                event,
                target,
                toolId: event.toolId || 'kimibuilt-ingress',
                objective,
                reason,
                command,
                stdout: event.message || '',
                success,
            });
        });
        return events.length;
    }

    recordK3sDeployEvent({
        state,
        params = {},
        result = {},
        success = true,
        objective = '',
        reason = '',
        target = null,
    }) {
        const deployDefaults = this.getEffectiveDeployDefaults();
        const action = inferK3sDeployAction(params);
        const namespace = normalizeText(params.namespace || deployDefaults.namespace) || 'kimibuilt';
        const deployment = normalizeText(params.deployment || deployDefaults.deployment) || 'backend';
        const publicDomain = normalizeText(params.publicDomain || deployDefaults.publicDomain);
        const timestamp = toIsoTimestamp(result?.timestamp, new Date().toISOString());

        const entry = this.ensureDeploymentEntry(state, {
            target,
            namespace,
            deployment,
            container: params.container || deployDefaults.container,
            repositoryUrl: params.repositoryUrl || deployDefaults.repositoryUrl,
            ref: params.ref || deployDefaults.ref,
            targetDirectory: params.targetDirectory || deployDefaults.targetDirectory,
            manifestsPath: params.manifestsPath || deployDefaults.manifestsPath,
            publicDomain,
            ingressClassName: params.ingressClassName || deployDefaults.ingressClassName,
            tlsClusterIssuer: params.tlsClusterIssuer || deployDefaults.tlsClusterIssuer,
        });
        if (!entry) {
            return;
        }

        entry.lastAction = action;
        entry.lastTool = 'k3s-deploy';
        entry.lastActionAt = timestamp;
        entry.lastObjective = summarizeText(objective, 220);
        entry.lastCommand = summarizeText(result.command || '', 260);
        entry.lastStdout = summarizeText(result.stdout || '', 220);
        this.mergeObservedContext(entry, [
            objective,
            reason,
            params.targetDirectory,
            params.manifestsPath,
            result.command,
            result.stdout,
            result.stderr,
            publicDomain,
        ]);

        if (success) {
            entry.lastStatus = 'succeeded';
            entry.lastSuccessAt = timestamp;
            entry.lastError = '';
            if (['sync-and-apply', 'rollout-status', 'set-image'].includes(action)) {
                entry.verification.rollout = true;
                entry.verification.lastRolloutAt = timestamp;
            }
        } else {
            entry.lastStatus = 'failed';
            entry.lastFailureAt = timestamp;
            entry.lastError = summarizeText(result.error || result.stderr || 'k3s deploy failed.', 220);
        }

        this.recordActivity(state, {
            toolId: 'k3s-deploy',
            action,
            status: entry.lastStatus,
            host: entry.host,
            namespace: entry.namespace,
            deployment: entry.deployment,
            publicDomain: entry.publicDomain,
            summary: success
                ? `k3s-deploy ${action} succeeded for ${entry.namespace}/${entry.deployment}${entry.publicDomain ? ` on ${entry.publicDomain}` : ''}.`
                : `k3s-deploy ${action} failed for ${entry.namespace}/${entry.deployment}${entry.publicDomain ? ` on ${entry.publicDomain}` : ''}.`,
            error: entry.lastError,
        });
    }

    recordRemoteCommandEvent({
        state,
        toolId = 'remote-command',
        params = {},
        result = {},
        success = true,
        objective = '',
        reason = '',
        target = null,
    }) {
        const deployDefaults = this.getEffectiveDeployDefaults();
        const command = normalizeText(params.command);
        const workflowAction = normalizeLowerText(params.workflowAction || params.workflow_action || (toolId === 'remote-workbench' ? params.action : ''));
        const rawNamespace = normalizeText(params.namespace || extractNamespaceFromCommand(command));
        const rawDeployment = normalizeText(params.deployment || extractDeploymentFromCommand(command));
        const rawPublicDomain = normalizeText(
            params.publicDomain
            || params.publicHost
            || extractExpectedHostFromCommand(command)
            || extractDomains(`${objective}\n${command}\n${result.stdout || ''}\n${result.stderr || ''}`)[0]
        );
        const hasDeploymentContext = workflowAction === 'verify-deployment'
            || workflowAction === 'deploy-verify'
            || workflowAction === 'inspect-remote-state'
            || Boolean(rawNamespace)
            || Boolean(rawDeployment)
            || Boolean(rawPublicDomain)
            || /kubectl\s+(?:rollout|get\s+deployment|get\s+svc,ingress|describe\s+deployment|logs\s+deployment|set\s+image)/i.test(command);
        const namespace = normalizeText(rawNamespace || (hasDeploymentContext ? deployDefaults.namespace : ''));
        const deployment = normalizeText(rawDeployment || (hasDeploymentContext ? deployDefaults.deployment : ''));
        const publicDomain = normalizeText(rawPublicDomain || (hasDeploymentContext ? deployDefaults.publicDomain : ''));
        const timestamp = toIsoTimestamp(result?.timestamp, new Date().toISOString());

        const targetEntry = this.ensureTargetEntry(state, target || {}, objective);
        if (targetEntry) {
            this.mergeObservedContext(targetEntry, [
                objective,
                reason,
                command,
                result.stdout,
                result.stderr,
            ]);
            targetEntry.lastStatus = success ? 'succeeded' : 'failed';
            if (workflowAction === 'verify-deployment' || workflowAction === 'deploy-verify' || workflowAction === 'inspect-remote-state') {
                targetEntry.lastInspectionAt = timestamp;
            }
        }

        this.recordIngressEventsFromText({
            state,
            text: `${result.stdout || ''}\n${result.stderr || ''}`,
            target,
            toolId,
            objective,
            reason,
            command,
            success,
        });

        if (!hasDeploymentContext) {
            this.recordActivity(state, {
                toolId,
                action: workflowAction || 'remote-command',
                status: success ? 'succeeded' : 'failed',
                host: normalizeText(target?.host),
                summary: success
                    ? `${toolId} completed a remote inspection step.`
                    : `${toolId} failed during a remote inspection step.`,
                error: summarizeText(result.error || result.stderr || '', 220),
            });
            return;
        }

        const entry = this.ensureDeploymentEntry(state, {
            target,
            namespace,
            deployment,
            publicDomain,
            container: params.container || deployDefaults.container,
            repositoryUrl: params.repositoryUrl || deployDefaults.repositoryUrl,
            ref: params.ref || deployDefaults.ref,
            targetDirectory: params.targetDirectory || deployDefaults.targetDirectory,
            manifestsPath: params.manifestsPath || deployDefaults.manifestsPath,
            ingressClassName: params.ingressClassName || deployDefaults.ingressClassName,
            tlsClusterIssuer: params.tlsClusterIssuer || deployDefaults.tlsClusterIssuer,
        });
        if (!entry) {
            return;
        }

        entry.lastTool = normalizeLowerText(toolId);
        entry.lastAction = workflowAction || 'remote-command';
        entry.lastActionAt = timestamp;
        entry.lastObjective = summarizeText(objective, 220);
        entry.lastCommand = summarizeText(command || result.command || '', 260);
        entry.lastStdout = summarizeText(result.stdout || '', 220);
        this.mergeObservedContext(entry, [
            objective,
            reason,
            command,
            result.stdout,
            result.stderr,
            publicDomain,
        ]);

        if (success) {
            entry.lastStatus = 'succeeded';
            entry.lastSuccessAt = timestamp;
            entry.lastError = '';
            const verificationOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
            const tlsExplicitlyUntrusted = /__KIMIBUILT_TLS_TRUSTED__=false/i.test(verificationOutput);
            const publicHttpsTrusted = /__KIMIBUILT_PUBLIC_HTTPS__=true/i.test(verificationOutput);

            if (/kubectl rollout status/i.test(command) || /successfully rolled out/i.test(result.stdout || '')) {
                entry.verification.rollout = true;
                entry.verification.lastRolloutAt = timestamp;
            }
            if (/kubectl get svc,ingress/i.test(command) || /--- ingress hosts ---|ingress\.networking\.k8s\.io/i.test(verificationOutput)) {
                entry.verification.ingress = true;
            }
            if (/tls_secret=|kubectl get secret/i.test(command) && !/No TLS secret/i.test(verificationOutput)) {
                entry.verification.tls = true;
            }
            if ((publicHttpsTrusted || /curl -fsSIL/i.test(command))
                && !tlsExplicitlyUntrusted
                && /HTTP\/\d(?:\.\d)?\s+2\d\d/i.test(verificationOutput)) {
                entry.verification.https = true;
            }
            if (workflowAction === 'verify-deployment' || workflowAction === 'deploy-verify') {
                entry.lastVerificationAt = timestamp;
                entry.verification.lastVerifiedAt = timestamp;
            }
        } else {
            entry.lastStatus = 'failed';
            entry.lastFailureAt = timestamp;
            entry.lastError = summarizeText(result.error || result.stderr || `${toolId} failed.`, 220);
        }

        this.recordActivity(state, {
            toolId,
            action: workflowAction || 'remote-command',
            status: entry.lastStatus,
            host: entry.host,
            namespace: entry.namespace,
            deployment: entry.deployment,
            publicDomain: entry.publicDomain,
            summary: success
                ? `${toolId} ${workflowAction || 'command'} succeeded for ${entry.namespace}/${entry.deployment}${entry.publicDomain ? ` on ${entry.publicDomain}` : ''}.`
                : `${toolId} ${workflowAction || 'command'} failed for ${entry.namespace}/${entry.deployment}${entry.publicDomain ? ` on ${entry.publicDomain}` : ''}.`,
            error: entry.lastError,
        });
    }

    recordToolEvents({
        sessionId = '',
        objective = '',
        toolEvents = [],
        controlState = null,
    } = {}) {
        const events = Array.isArray(toolEvents) ? toolEvents : [];
        if (events.length === 0) {
            return;
        }

        const state = this.getState();
        let mutated = false;

        for (const event of events) {
            const toolId = normalizeLowerText(event?.result?.toolId || event?.toolCall?.function?.name || '');
            if (!REMOTE_TOOL_IDS.has(toolId)) {
                continue;
            }

            const params = parseJsonObject(event?.toolCall?.function?.arguments || '');
            const result = isPlainObject(event?.result?.data)
                ? {
                    ...event.result.data,
                    timestamp: event?.result?.timestamp || event?.result?.data?.timestamp || new Date().toISOString(),
                    error: event?.result?.error || null,
                }
                : {
                    timestamp: event?.result?.timestamp || new Date().toISOString(),
                    error: event?.result?.error || null,
                };
            const success = event?.result?.success !== false;
            const target = this.resolveRemoteTarget({
                params,
                result,
                controlState,
            });

            if (toolId === 'k3s-deploy') {
                this.recordK3sDeployEvent({
                    state,
                    params,
                    result,
                    success,
                    objective,
                    reason: event?.reason || '',
                    target,
                });
                mutated = true;
                continue;
            }

            this.recordRemoteCommandEvent({
                state,
                toolId,
                params,
                result,
                success,
                objective,
                reason: event?.reason || '',
                target,
            });
            mutated = true;
        }

        if (mutated) {
            this.saveState();
        }
    }

    listEdgeRoutes() {
        return Object.values(this.getState().edgeRoutes || {})
            .sort((left, right) => {
                const leftTime = Date.parse(left.lastActionAt || left.lastSuccessAt || left.lastFailureAt || left.lastSeenAt || left.firstSeenAt || 0);
                const rightTime = Date.parse(right.lastActionAt || right.lastSuccessAt || right.lastFailureAt || right.lastSeenAt || right.firstSeenAt || 0);
                return rightTime - leftTime;
            });
    }

    listDeployments() {
        return Object.values(this.getState().deployments || {})
            .sort((left, right) => {
                const leftTime = Date.parse(left.lastActionAt || left.lastSuccessAt || left.lastFailureAt || left.lastSeenAt || left.firstSeenAt || 0);
                const rightTime = Date.parse(right.lastActionAt || right.lastSuccessAt || right.lastFailureAt || right.lastSeenAt || right.firstSeenAt || 0);
                return rightTime - leftTime;
            });
    }

    buildPromptSummary({ maxDeployments = 3, maxRecentActivity = 3, maxTargets = 2, maxEdgeRoutes = MAX_EDGE_ROUTES_IN_PROMPT } = {}) {
        const deployDefaults = this.getEffectiveDeployDefaults();
        const sshDefaults = this.getEffectiveSshDefaults();
        const state = this.getState();
        const targets = Object.values(state.targets || {})
            .sort((left, right) => {
                const leftTime = Date.parse(left.lastInspectionAt || left.lastSeenAt || left.firstSeenAt || 0);
                const rightTime = Date.parse(right.lastInspectionAt || right.lastSeenAt || right.firstSeenAt || 0);
                return rightTime - leftTime;
            })
            .slice(0, Math.max(0, maxTargets));
        const edgeRoutes = this.listEdgeRoutes().slice(0, Math.max(0, maxEdgeRoutes));
        const deployments = this.listDeployments().slice(0, Math.max(0, maxDeployments));
        const activity = (Array.isArray(state.recentActivity) ? state.recentActivity : [])
            .slice(0, Math.max(0, maxRecentActivity));
        const lines = [];

        if (sshDefaults.host) {
            lines.push(`Cluster registry default SSH target: ${sshDefaults.username ? `${sshDefaults.username}@` : ''}${sshDefaults.host}:${sshDefaults.port}.`);
        }

        if (deployDefaults.repositoryUrl || deployDefaults.targetDirectory || deployDefaults.deployment) {
            lines.push(`Cluster registry configured KimiBuilt self-deploy lane (do not assume it applies to unrelated apps): repo ${deployDefaults.repositoryUrl || '(unset)'}, dir ${deployDefaults.targetDirectory || '(unset)'}, manifests ${deployDefaults.manifestsPath || '(unset)'}, namespace ${deployDefaults.namespace || 'kimibuilt'}, deployment ${deployDefaults.deployment || 'backend'}, domain ${deployDefaults.publicDomain || 'demoserver2.buzz'}.`);
        }

        targets.forEach((entry) => {
            const context = normalizeTargetServerContext(entry.serverContext);
            if (
                !context.hostname
                && !context.osSummary
                && !context.k3sVersion
                && !context.kubectlVersion
                && context.nodeNames.length === 0
                && context.ingressClasses.length === 0
                && context.certManagerInstalled === null
                && context.traefikInstalled === null
            ) {
                return;
            }

            const targetLabel = `${entry.username ? `${entry.username}@` : ''}${entry.host}:${entry.port || 22}`;
            const fragments = [
                context.hostname ? `host ${context.hostname}` : '',
                context.osSummary ? context.osSummary : '',
                context.arch ? `arch ${context.arch}` : '',
                context.k3sVersion ? `k3s ${context.k3sVersion}` : '',
                !context.k3sVersion && context.kubectlVersion ? `kubectl ${context.kubectlVersion}` : '',
                context.nodeNames.length > 0 ? `nodes ${context.nodeNames.slice(0, 3).join(', ')}` : '',
                context.ingressClasses.length > 0 ? `ingress ${context.ingressClasses.slice(0, 2).join(', ')}` : '',
                context.traefikInstalled === true ? 'traefik yes' : (context.traefikInstalled === false ? 'traefik no' : ''),
                context.certManagerInstalled === true ? 'cert-manager yes' : (context.certManagerInstalled === false ? 'cert-manager no' : ''),
                context.platformNamespaces.length > 0 ? `platform ns ${context.platformNamespaces.slice(0, 2).join(', ')}` : '',
            ].filter(Boolean);

            lines.push(`Known remote target ${targetLabel}: ${fragments.join(', ')}.`);
        });

        edgeRoutes.forEach((entry) => {
            const verificationSummary = [
                `ingress ${entry.verification?.ingress ? 'yes' : 'no'}`,
                `tls ${entry.verification?.tls ? 'yes' : 'no'}`,
                `cert ${entry.verification?.certificateReady ? 'yes' : 'no'}`,
                `https ${entry.verification?.https ? 'yes' : 'no'}`,
            ].join(', ');
            const route = `${entry.hostName || 'unknown-host'}${entry.path || '/'}`;
            const backend = `${entry.namespace || 'default'}/${entry.serviceName || 'unknown'}${entry.servicePort ? `:${entry.servicePort}` : ''}`;
            const ingress = `${entry.namespace || 'default'}/${entry.ingressName || 'unknown-ingress'}`;
            const target = entry.targetHost ? `${entry.targetHost}:${entry.port || 22}` : 'unknown-target';
            const tls = [
                entry.ingressClassName ? `class ${entry.ingressClassName}` : '',
                entry.tlsClusterIssuer ? `issuer ${entry.tlsClusterIssuer}` : '',
                entry.tlsSecretName ? `secret ${entry.tlsSecretName}` : '',
            ].filter(Boolean).join(', ');
            const statusDetail = entry.lastStatus === 'failed'
                ? `last ${entry.lastAction || 'activity'} failed${entry.lastError ? `: ${summarizeText(entry.lastError, 120)}` : '.'}`
                : `last ${entry.lastAction || 'activity'} succeeded${entry.lastSuccessAt ? ` at ${entry.lastSuccessAt}` : '.'}`;
            lines.push(`Known edge route ${route} -> ${backend} via ingress ${ingress} on ${target}${tls ? ` (${tls})` : ''}: ${statusDetail} Verification: ${verificationSummary}. Use kimibuilt-ingress for changes; do not hand-author nginx ingress for this cluster.`);
        });

        deployments.forEach((entry) => {
            const verificationSummary = [
                `rollout ${entry.verification?.rollout ? 'yes' : 'no'}`,
                `ingress ${entry.verification?.ingress ? 'yes' : 'no'}`,
                `tls ${entry.verification?.tls ? 'yes' : 'no'}`,
                `https ${entry.verification?.https ? 'yes' : 'no'}`,
            ].join(', ');
            const scope = `${entry.namespace || 'default'}/${entry.deployment || 'unknown'}`;
            const target = entry.host ? `${entry.host}:${entry.port || 22}` : 'unknown-target';
            const paths = Array.isArray(entry.paths) && entry.paths.length > 0
                ? ` paths ${entry.paths.slice(0, 3).join(', ')}.`
                : '';
            const statusDetail = entry.lastStatus === 'failed'
                ? `last ${entry.lastAction || 'activity'} failed${entry.lastError ? `: ${summarizeText(entry.lastError, 120)}` : '.'}`
                : `last ${entry.lastAction || 'activity'} succeeded${entry.lastSuccessAt ? ` at ${entry.lastSuccessAt}` : '.'}`;
            lines.push(`Known workload ${scope} on ${target}${entry.publicDomain ? ` (${entry.publicDomain})` : ''}: ${statusDetail} Verification: ${verificationSummary}.${paths}`);
        });

        activity.forEach((entry) => {
            lines.push(`Recent cluster activity: ${entry.summary}`);
        });

        return lines.filter(Boolean).join('\n');
    }

    getRuntimeSummary() {
        const state = this.getState();
        return {
            path: this.storagePath,
            updatedAt: state.updatedAt || null,
            targetCount: Object.keys(state.targets || {}).length,
            deploymentCount: Object.keys(state.deployments || {}).length,
            edgeRouteCount: Object.keys(state.edgeRoutes || {}).length,
            recentActivityCount: Array.isArray(state.recentActivity) ? state.recentActivity.length : 0,
            summary: this.buildPromptSummary({ maxDeployments: 2, maxRecentActivity: 2 }),
        };
    }
}

const clusterStateRegistry = new ClusterStateRegistry();

module.exports = {
    ClusterStateRegistry,
    clusterStateRegistry,
};

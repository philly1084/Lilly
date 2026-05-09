const path = require('path');
const { config } = require('../config');
const { embedder } = require('../memory/embedder');
const { memoryService } = require('../memory/memory-service');
const { vectorStore } = require('../memory/vector-store');
const { sessionStore } = require('../session-store');
const { ttsService } = require('../tts/tts-service');
const { audioProcessingService } = require('../audio/audio-processing-service');
const { podcastVideoService } = require('../video/podcast-video-service');
const { remoteRunnerService } = require('../remote-runner/service');
const { isAuthEnabled, resolveFrontendApiKey } = require('../auth/service');

function createStartupState() {
    return {
        ready: false,
        status: 'starting',
        startedAt: new Date().toISOString(),
        initializedAt: null,
        lastError: null,
    };
}

function markStartupReady(startupState) {
    if (!startupState || typeof startupState !== 'object') {
        return;
    }

    startupState.ready = true;
    startupState.status = 'ready';
    startupState.initializedAt = new Date().toISOString();
    startupState.lastError = null;
}

function markStartupFailed(startupState, error) {
    if (!startupState || typeof startupState !== 'object') {
        return;
    }

    startupState.ready = false;
    startupState.status = 'degraded';
    startupState.initializedAt = null;
    startupState.lastError = error?.message || String(error || 'Startup failed');
}

function getReadinessSnapshot(startupState = null) {
    const snapshot = startupState && typeof startupState === 'object'
        ? startupState
        : createStartupState();
    return {
        ready: snapshot.ready === true,
        status: snapshot.ready === true
            ? 'ready'
            : (snapshot.status === 'degraded' ? 'degraded' : 'starting'),
        startedAt: snapshot.startedAt || null,
        initializedAt: snapshot.initializedAt || null,
        error: snapshot.lastError || null,
    };
}

function mapDependencyStatus(status = '', { treatUnavailableAsDisabled = false } = {}) {
    const normalized = String(status || '').trim().toLowerCase();
    if (['ok', 'healthy', 'ready', 'connected', 'available'].includes(normalized)) {
        return 'healthy';
    }
    if (['disabled'].includes(normalized)) {
        return 'disabled';
    }
    if (['starting'].includes(normalized)) {
        return 'starting';
    }
    if (['misconfigured', 'not_configured'].includes(normalized)) {
        return 'degraded';
    }
    if (['unavailable'].includes(normalized)) {
        return treatUnavailableAsDisabled ? 'disabled' : 'degraded';
    }
    if (['down', 'disconnected', 'error', 'failed', 'unhealthy'].includes(normalized)) {
        return 'unhealthy';
    }
    return normalized ? 'degraded' : 'unknown';
}

function derivePublicConfigStatus(publicConfig = {}, { treatUnavailableAsDisabled = false } = {}) {
    if (!publicConfig || typeof publicConfig !== 'object') {
        return 'unknown';
    }

    const diagnosticsStatus = String(publicConfig?.diagnostics?.status || '').trim().toLowerCase();
    if (diagnosticsStatus) {
        return mapDependencyStatus(diagnosticsStatus, { treatUnavailableAsDisabled });
    }

    if (publicConfig.configured === true) {
        return 'healthy';
    }
    if (publicConfig.configured === false) {
        return 'degraded';
    }

    return 'unknown';
}

function summarizeOverallStatus(components = {}) {
    let hasUnhealthy = false;
    let hasDegraded = false;

    for (const component of Object.values(components || {})) {
        if (!component || component.required === false) {
            continue;
        }

        if (component.status === 'unhealthy') {
            hasUnhealthy = true;
            continue;
        }

        if (component.status === 'degraded' || component.status === 'starting') {
            hasDegraded = true;
        }
    }

    if (hasUnhealthy) {
        return 'unhealthy';
    }
    if (hasDegraded) {
        return 'degraded';
    }
    return 'healthy';
}

function componentToLegacyServiceStatus(component = null, healthyLabel = 'connected') {
    const status = String(component?.status || '').trim().toLowerCase();
    if (status === 'healthy') {
        return healthyLabel;
    }
    if (status === 'disabled') {
        return 'disabled';
    }
    if (status === 'starting') {
        return 'starting';
    }

    const detail = String(component?.details?.state || component?.details?.postgres || '').trim().toLowerCase();
    if (detail) {
        return detail;
    }

    if (status === 'degraded') {
        return 'not_configured';
    }
    if (status === 'unhealthy') {
        return 'disconnected';
    }
    return 'unknown';
}

async function checkVectorStoreStatus(orchestrator = null) {
    const sdkVectorStore = orchestrator?.vectorStore || orchestrator?.skillMemory?.vectorStore;
    const candidate = sdkVectorStore || vectorStore;

    if (!candidate) {
        return {
            status: 'degraded',
            detail: 'not_configured',
        };
    }

    try {
        if (typeof candidate.healthCheck === 'function') {
            const healthy = await candidate.healthCheck();
            return {
                status: healthy ? 'healthy' : 'unhealthy',
                detail: healthy ? 'connected' : 'disconnected',
            };
        }
        if (typeof candidate.health === 'function') {
            await candidate.health();
            return {
                status: 'healthy',
                detail: 'connected',
            };
        }
        return {
            status: 'healthy',
            detail: 'available',
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            detail: error?.message || 'disconnected',
        };
    }
}

async function checkEmbedderStatus(orchestrator = null) {
    const candidate = orchestrator?.embedder || embedder;
    if (!candidate) {
        return {
            status: 'degraded',
            detail: 'not_configured',
        };
    }

    try {
        if (typeof candidate.healthCheck === 'function') {
            const healthy = await candidate.healthCheck();
            return {
                status: healthy ? 'healthy' : 'unhealthy',
                detail: healthy ? 'connected' : 'disconnected',
            };
        }
    } catch (error) {
        return {
            status: 'unhealthy',
            detail: error?.message || 'disconnected',
        };
    }

    return {
        status: 'healthy',
        detail: 'connected',
    };
}

async function checkSessionStoreStatus() {
    const persistent = typeof sessionStore.isPersistent === 'function'
        ? sessionStore.isPersistent()
        : false;
    if (!persistent) {
        return {
            status: 'healthy',
            storage: 'memory',
            postgres: 'disabled',
        };
    }

    try {
        const healthy = typeof sessionStore.healthCheck === 'function'
            ? await sessionStore.healthCheck()
            : true;
        return {
            status: healthy ? 'healthy' : 'unhealthy',
            storage: 'postgres',
            postgres: healthy ? 'healthy' : 'unhealthy',
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            storage: 'postgres',
            postgres: 'unhealthy',
            error: error?.message || 'Postgres health check failed',
        };
    }
}

async function buildSystemHealthReport({
    app = null,
    startupState = null,
} = {}) {
    const orchestrator = app?.locals?.conversationOrchestrator || app?.locals?.dashboardController?.orchestrator || null;
    const readiness = getReadinessSnapshot(startupState || app?.locals?.startupState || null);
    const vectorStoreStatus = await checkVectorStoreStatus(orchestrator);
    const embedderStatus = await checkEmbedderStatus(orchestrator);
    const sessionStatus = await checkSessionStoreStatus();
    const tts = ttsService.getPublicConfig();
    const audioProcessing = audioProcessingService.getPublicConfig();
    const podcastVideo = podcastVideoService.getPublicConfig();
    const memoryDiagnostics = memoryService.getDiagnostics();
    const frontendApiConfigured = Boolean(String(resolveFrontendApiKey() || '').trim());
    const authEnabled = isAuthEnabled();
    const healthyRunner = remoteRunnerService.getHealthyRunner();
    const runnerList = remoteRunnerService.listRunners();

    const components = {
        boot: {
            status: readiness.ready ? 'healthy' : (readiness.status === 'degraded' ? 'degraded' : 'starting'),
            required: true,
            details: readiness,
        },
        server: {
            status: 'healthy',
            required: true,
            details: {
                nodeEnv: config.nodeEnv,
                port: config.port,
                dataDir: path.resolve(config.persistence?.dataDir || process.cwd()),
            },
        },
        sessionStore: {
            status: sessionStatus.status,
            required: true,
            details: {
                storage: sessionStatus.storage,
                postgres: sessionStatus.postgres,
                error: sessionStatus.error || null,
            },
        },
        qdrant: {
            status: vectorStoreStatus.status,
            required: false,
            details: {
                source: 'vectorStore',
                state: vectorStoreStatus.detail,
            },
        },
        ollama: {
            status: embedderStatus.status,
            required: false,
            details: {
                source: 'embedder',
                state: embedderStatus.detail,
            },
        },
        sdk: {
            status: orchestrator ? 'healthy' : 'degraded',
            required: true,
            details: {
                connected: Boolean(orchestrator),
            },
        },
        llmClient: {
            status: orchestrator?.llmClient?.complete || orchestrator?.llmClient?.createResponse
                ? 'healthy'
                : 'degraded',
            required: true,
            details: {
                configured: Boolean(orchestrator?.llmClient?.complete || orchestrator?.llmClient?.createResponse),
            },
        },
        tts: {
            status: derivePublicConfigStatus(tts, { treatUnavailableAsDisabled: true }),
            required: false,
            details: tts,
        },
        audioProcessing: {
            status: derivePublicConfigStatus(audioProcessing, { treatUnavailableAsDisabled: true }),
            required: false,
            details: audioProcessing,
        },
        podcastVideo: {
            status: derivePublicConfigStatus(podcastVideo, { treatUnavailableAsDisabled: true }),
            required: false,
            details: podcastVideo,
        },
        memory: {
            status: 'healthy',
            required: false,
            details: memoryDiagnostics,
        },
        auth: {
            status: authEnabled ? 'healthy' : 'disabled',
            required: false,
            details: {
                enabled: authEnabled,
                allowQueryTokens: config.security.allowQueryTokens === true,
            },
        },
        websocket: {
            status: 'healthy',
            required: false,
            details: {
                authRequired: authEnabled,
                frontendApiConfigured,
                tokenRoute: '/api/auth/ws-token',
            },
        },
        remoteRunner: {
            status: config.remoteRunner.enabled === false
                ? 'disabled'
                : (healthyRunner ? 'healthy' : (runnerList.length > 0 ? 'degraded' : 'disabled')),
            required: false,
            details: {
                enabled: config.remoteRunner.enabled !== false,
                configured: Boolean(config.remoteRunner.token),
                healthy: Boolean(healthyRunner),
                connectedRunners: runnerList.length,
                defaultRunnerId: healthyRunner?.runnerId || null,
            },
        },
    };

    const capabilities = {
        deferredWorkloads: Boolean(app?.locals?.agentWorkloadService?.isAvailable?.()),
        managedApps: Boolean(app?.locals?.managedAppService?.isAvailable?.()),
    };
    const status = summarizeOverallStatus(components);
    return {
        status,
        httpStatus: status === 'healthy' ? 200 : 503,
        readiness,
        components,
        services: {
            sdk: componentToLegacyServiceStatus(components.sdk),
            llmClient: componentToLegacyServiceStatus(components.llmClient),
            vectorStore: componentToLegacyServiceStatus(components.qdrant),
            embedder: componentToLegacyServiceStatus(components.ollama),
            sessionStore: componentToLegacyServiceStatus(components.sessionStore, 'connected'),
        },
        capabilities,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
    };
}

module.exports = {
    buildSystemHealthReport,
    createStartupState,
    getReadinessSnapshot,
    markStartupFailed,
    markStartupReady,
};

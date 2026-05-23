const { config } = require('../config');
const { KokoroHttpTtsService } = require('./kokoro-http-tts-service');
const { kokoroTtsService } = require('./kokoro-tts-service');
const { piperTtsService } = require('./piper-tts-service');

const defaultKokoroProvider = config.tts?.kokoro?.baseURL
    ? new KokoroHttpTtsService(config.tts.kokoro)
    : kokoroTtsService;

function normalizeProviderId(value = '', fallback = '') {
    return String(value || fallback || '').trim().toLowerCase();
}

function createUnavailableError() {
    const error = new Error('No TTS providers are configured.');
    error.statusCode = 503;
    error.code = 'tts_unavailable';
    return error;
}

function isProviderRetryable(error = {}) {
    const statusCode = Number(error.statusCode);
    const code = String(error.code || '').trim();
    return statusCode === 503
        || statusCode === 504
        || statusCode === 502
        || statusCode === 429
        || statusCode >= 500
        || code === 'tts_timeout'
        || code === 'tts_failed'
        || code === 'tts_empty_audio'
        || error.code === 'tts_unavailable'
        || error.code === 'tts_binary_missing';
}

function providerSupportsVoice(publicConfig = {}, voiceId = '') {
    const requestedVoiceId = String(voiceId || '').trim();
    if (!requestedVoiceId) {
        return true;
    }

    return (Array.isArray(publicConfig?.voices) ? publicConfig.voices : []).some((voice) => (
        voice?.id === requestedVoiceId
        || (Array.isArray(voice?.aliases) && voice.aliases.includes(requestedVoiceId))
    ));
}

class TtsService {
    constructor(ttsConfig = config.tts || {}, providers = {}) {
        this.ttsConfig = {
            ...ttsConfig,
        };
        this.providers = {};
        if (Object.prototype.hasOwnProperty.call(providers, 'providers')) {
            this.providers = providers.providers || {};
        } else {
            this.providers = {
                kokoro: Object.prototype.hasOwnProperty.call(providers, 'kokoro')
                    ? providers.kokoro
                    : defaultKokoroProvider,
                piper: Object.prototype.hasOwnProperty.call(providers, 'piper')
                    ? providers.piper
                    : piperTtsService,
            };
            if (Object.prototype.hasOwnProperty.call(providers, 'provider')) {
                this.providers[normalizeProviderId(this.ttsConfig.provider, 'kokoro') || 'provider'] = providers.provider;
            }
        }
    }

    getProvider(providerId = '') {
        const normalizedProviderId = normalizeProviderId(providerId, this.ttsConfig.provider || 'kokoro');
        return this.providers[normalizedProviderId] || null;
    }

    getFallbackProviderId() {
        const primaryProviderId = normalizeProviderId(this.ttsConfig.provider, 'kokoro');
        const fallbackProviderId = normalizeProviderId(this.ttsConfig.fallbackProvider, 'piper');
        if (!fallbackProviderId || fallbackProviderId === primaryProviderId) {
            return '';
        }
        return fallbackProviderId;
    }

    getProviderPublicConfig(providerId = '') {
        const provider = this.getProvider(providerId);
        const publicConfig = provider?.getPublicConfig?.();
        if (!publicConfig || typeof publicConfig !== 'object') {
            return null;
        }

        const providerName = normalizeProviderId(publicConfig.provider, providerId) || providerId || 'unknown';
        const configured = publicConfig.configured === true;
        const voices = Array.isArray(publicConfig.voices) ? publicConfig.voices : [];
        const maxTextChars = Math.max(200, Number(publicConfig.maxTextChars) || 2400);
        const timeoutMs = Math.max(1000, Number(publicConfig.timeoutMs) || 45000);
        const podcastTimeoutMs = Math.max(timeoutMs, Number(publicConfig.podcastTimeoutMs) || timeoutMs);
        const podcastChunkChars = Math.max(
            250,
            Math.min(maxTextChars, Number(publicConfig.podcastChunkChars) || Math.min(900, maxTextChars)),
        );
        const defaultVoiceId = configured
            ? (String(publicConfig.defaultVoiceId || '').trim() || voices[0]?.id || null)
            : null;
        const diagnostics = publicConfig.diagnostics && typeof publicConfig.diagnostics === 'object'
            ? {
                ...publicConfig.diagnostics,
                status: String(publicConfig.diagnostics.status || '').trim() || (configured ? 'ready' : 'unavailable'),
                voicesLoaded: voices.length > 0,
            }
            : {
                status: configured ? 'ready' : 'unavailable',
                binaryReachable: configured === true,
                voicesLoaded: voices.length > 0,
                message: configured ? 'Voice playback is ready.' : 'Voice playback is unavailable.',
            };

        return {
            ...publicConfig,
            configured,
            provider: providerName,
            maxTextChars,
            timeoutMs,
            podcastTimeoutMs,
            podcastChunkChars,
            defaultVoiceId,
            voices,
            diagnostics,
        };
    }

    getPublicConfig() {
        const primaryProviderId = normalizeProviderId(this.ttsConfig.provider, 'kokoro');
        const fallbackProviderId = this.getFallbackProviderId();
        const providerConfigs = [primaryProviderId, fallbackProviderId]
            .filter(Boolean)
            .filter((providerId, index, items) => items.indexOf(providerId) === index)
            .map((providerId) => this.getProviderPublicConfig(providerId))
            .filter(Boolean);
        const primaryConfig = providerConfigs[0] || null;

        if (!primaryConfig) {
            return {
                configured: false,
                provider: 'none',
                maxTextChars: 2400,
                defaultVoiceId: null,
                voices: [],
                providers: [],
                diagnostics: {
                    status: 'unavailable',
                    binaryReachable: false,
                    voicesLoaded: false,
                    message: 'No TTS providers are configured.',
                },
            };
        }

        return {
            ...primaryConfig,
            providers: providerConfigs,
            fallbackProvider: fallbackProviderId || null,
            fallbackEnabled: this.ttsConfig.fallbackEnabled !== false,
            realtime: this.ttsConfig.realtime && typeof this.ttsConfig.realtime === 'object'
                ? { ...this.ttsConfig.realtime }
                : null,
        };
    }

    async synthesize({
        text = '',
        voiceId = '',
        timeoutMs,
        allowProviderFallback = true,
        provider = '',
    } = {}) {
        const primaryProviderId = normalizeProviderId(provider, normalizeProviderId(this.ttsConfig.provider, 'kokoro'));
        const fallbackProviderId = this.getFallbackProviderId();
        const primaryProvider = this.getProvider(primaryProviderId);
        const providerFallbackEnabled = allowProviderFallback !== false && this.ttsConfig.fallbackEnabled !== false;
        const fallbackProvider = providerFallbackEnabled ? this.getProvider(fallbackProviderId) : null;
        const requestedParams = {
            text,
            voiceId,
        };

        if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) {
            requestedParams.timeoutMs = Number(timeoutMs);
        }
        const buildProviderParams = (providerId = primaryProviderId) => {
            const providerConfig = this.getProviderPublicConfig(providerId);
            if (providerConfig && !providerSupportsVoice(providerConfig, requestedParams.voiceId)) {
                return {
                    ...requestedParams,
                    voiceId: '',
                };
            }
            return requestedParams;
        };
        const fallbackParams = () => {
            const fallbackConfig = this.getProviderPublicConfig(fallbackProviderId);
            if (fallbackConfig && !providerSupportsVoice(fallbackConfig, requestedParams.voiceId)) {
                return {
                    ...requestedParams,
                    voiceId: '',
                };
            }
            return requestedParams;
        };
        const synthesizeWithFallback = async (reason = {}) => {
            if (!fallbackProvider?.synthesize) {
                return null;
            }
            const result = await fallbackProvider.synthesize(fallbackParams());
            return {
                ...result,
                fallback: {
                    providerFallback: true,
                    fromProvider: primaryProviderId,
                    toProvider: fallbackProviderId,
                    requestedVoiceId: requestedParams.voiceId || '',
                    actualVoiceId: result?.voice?.id || '',
                    reason: {
                        code: String(reason?.code || '').trim() || null,
                        statusCode: Number(reason?.statusCode || reason?.status) || null,
                        message: String(reason?.message || '').trim() || null,
                    },
                },
            };
        };

        if (!primaryProvider?.synthesize) {
            const fallbackResult = await synthesizeWithFallback({
                code: 'primary_provider_unavailable',
                message: `Primary TTS provider "${primaryProviderId}" is unavailable.`,
            });
            if (fallbackResult) {
                return fallbackResult;
            }
            throw createUnavailableError();
        }

        const primaryConfig = this.getProviderPublicConfig(primaryProviderId);
        if (primaryConfig?.configured === false && fallbackProvider?.synthesize) {
            return synthesizeWithFallback({
                code: primaryConfig?.diagnostics?.status || 'primary_provider_misconfigured',
                message: primaryConfig?.diagnostics?.message || `Primary TTS provider "${primaryProviderId}" is misconfigured.`,
            });
        }
        if (primaryConfig?.configured === false) {
            throw createUnavailableError();
        }

        try {
            return await primaryProvider.synthesize(buildProviderParams(primaryProviderId));
        } catch (error) {
            if (fallbackProvider?.synthesize && isProviderRetryable(error)) {
                return synthesizeWithFallback(error);
            }
            throw error;
        }
    }
}

const ttsService = new TtsService();

module.exports = {
    TtsService,
    ttsService,
};

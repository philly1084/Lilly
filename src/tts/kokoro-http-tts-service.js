const { config } = require('../config');
const { createServiceError, normalizeTextForSpeech } = require('./speech-text');
const {
    getCachedKokoroVoiceAvailability,
    normalizeKokoroVoiceList,
} = require('./kokoro-voice-cache');

const DEFAULT_PROVIDER = 'kokoro';
const DEFAULT_VOICE_ID = 'af_heart';
const DEFAULT_VOICE_LABEL = 'Heart Studio';
const DEFAULT_VOICE_DESCRIPTION = 'Primary high-quality Kokoro voice for polished local speech.';

function toPublicVoiceProfile(voice = {}) {
    return {
        id: String(voice.id || DEFAULT_VOICE_ID).trim() || DEFAULT_VOICE_ID,
        label: String(voice.label || DEFAULT_VOICE_LABEL).trim() || DEFAULT_VOICE_LABEL,
        description: String(voice.description || DEFAULT_VOICE_DESCRIPTION).trim() || DEFAULT_VOICE_DESCRIPTION,
        provider: DEFAULT_PROVIDER,
        aliases: Array.isArray(voice.aliases) ? voice.aliases.slice() : [],
    };
}

async function readErrorPayload(response) {
    try {
        const payload = await response.json();
        return payload?.error || payload || {};
    } catch (_error) {
        return {};
    }
}

function isRetryableRemoteError(error = {}) {
    const statusCode = Number(error.statusCode || error.status);
    const code = String(error.code || '').trim();
    return statusCode === 502
        || statusCode === 503
        || statusCode === 504
        || statusCode === 429
        || statusCode >= 500
        || code === 'tts_timeout'
        || code === 'tts_failed'
        || code === 'tts_unavailable'
        || code === 'tts_empty_audio';
}

function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
        timer?.unref?.();
    });
}

class KokoroHttpTtsService {
    constructor(ttsConfig = config.tts?.kokoro || {}, dependencies = {}) {
        this.ttsConfig = {
            ...ttsConfig,
        };
        this.fetch = dependencies.fetch || global.fetch;
    }

    getBaseURL() {
        return String(this.ttsConfig.baseURL || '').trim().replace(/\/+$/, '');
    }

    getVoiceProfiles() {
        const configured = normalizeKokoroVoiceList(this.ttsConfig.voices);
        const voices = configured.length > 0 ? configured : [toPublicVoiceProfile({
            id: DEFAULT_VOICE_ID,
            label: DEFAULT_VOICE_LABEL,
            description: DEFAULT_VOICE_DESCRIPTION,
        })];
        return getCachedKokoroVoiceAvailability(this.ttsConfig, voices).voices
            .map((voice) => toPublicVoiceProfile(voice));
    }

    getUnavailableVoiceProfiles() {
        const configured = normalizeKokoroVoiceList(this.ttsConfig.voices);
        const voices = configured.length > 0 ? configured : [{
            id: DEFAULT_VOICE_ID,
            label: DEFAULT_VOICE_LABEL,
            description: DEFAULT_VOICE_DESCRIPTION,
        }];
        return getCachedKokoroVoiceAvailability(this.ttsConfig, voices).uncachedVoices
            .map((voice) => toPublicVoiceProfile(voice));
    }

    resolveVoiceProfile(voiceId = '') {
        const voices = this.getVoiceProfiles();
        const requestedVoiceId = String(voiceId || '').trim();
        if (requestedVoiceId) {
            return voices.find((voice) => (
                voice.id === requestedVoiceId
                || (Array.isArray(voice.aliases) && voice.aliases.includes(requestedVoiceId))
            )) || null;
        }

        const defaultVoiceId = String(this.ttsConfig.defaultVoiceId || this.ttsConfig.voiceId || DEFAULT_VOICE_ID).trim();
        return voices.find((voice) => voice.id === defaultVoiceId || voice.aliases?.includes(defaultVoiceId)) || voices[0] || null;
    }

    getDiagnostics() {
        const baseURL = this.getBaseURL();
        const voices = this.getVoiceProfiles();
        const uncachedVoices = this.getUnavailableVoiceProfiles();
        const uncachedVoiceIds = uncachedVoices.map((voice) => voice.id);
        const cachedVoicesRequired = this.ttsConfig.allowRemoteModels === false;
        if (!baseURL) {
            return {
                status: 'misconfigured',
                modelReachable: false,
                voicesLoaded: voices.length > 0,
                cachedVoicesRequired,
                uncachedVoiceIds,
                message: 'Remote Kokoro TTS base URL is not configured.',
            };
        }

        if (voices.length === 0) {
            return {
                status: 'misconfigured',
                modelReachable: true,
                voicesLoaded: false,
                cachedVoicesRequired,
                uncachedVoiceIds,
                message: uncachedVoiceIds.length > 0
                    ? `Remote Kokoro TTS has no cached voices available. Missing cached voice files for: ${uncachedVoiceIds.join(', ')}.`
                    : 'Remote Kokoro TTS has no configured voices.',
            };
        }

        return {
            status: 'ready',
            modelReachable: true,
            voicesLoaded: voices.length > 0,
            cachedVoicesRequired,
            uncachedVoiceIds,
            message: `Remote Kokoro TTS configured at ${baseURL}.`
                + (uncachedVoiceIds.length > 0
                    ? ` Skipped ${uncachedVoiceIds.length} uncached configured voice${uncachedVoiceIds.length === 1 ? '' : 's'}.`
                    : ''),
        };
    }

    isConfigured() {
        return this.getDiagnostics().status === 'ready';
    }

    getPublicConfig() {
        const diagnostics = this.getDiagnostics();
        const configured = diagnostics.status === 'ready';
        const voices = this.getVoiceProfiles();
        const defaultVoice = configured ? this.resolveVoiceProfile() : null;
        const maxTextChars = Math.max(200, Number(this.ttsConfig.maxTextChars) || 2400);
        const timeoutMs = Math.max(1000, Number(this.ttsConfig.timeoutMs) || 90000);
        const podcastTimeoutMs = Math.max(timeoutMs, Number(this.ttsConfig.podcastTimeoutMs) || timeoutMs);
        const podcastChunkChars = Math.max(
            250,
            Math.min(maxTextChars, Number(this.ttsConfig.podcastChunkChars) || Math.min(900, maxTextChars)),
        );

        return {
            configured,
            provider: DEFAULT_PROVIDER,
            mode: 'remote',
            baseURL: this.getBaseURL() || null,
            maxTextChars,
            timeoutMs,
            podcastTimeoutMs,
            podcastChunkChars,
            httpRetryAttempts: Math.max(1, Math.min(4, Number(this.ttsConfig.httpRetryAttempts) || 2)),
            httpConnectionClose: this.ttsConfig.httpConnectionClose !== false,
            defaultVoiceId: configured ? (defaultVoice?.id || voices[0]?.id || null) : null,
            voices,
            diagnostics,
        };
    }

    assertConfigured() {
        const diagnostics = this.getDiagnostics();
        if (diagnostics.status === 'ready') {
            return;
        }

        throw createServiceError(
            503,
            diagnostics.message || 'Remote Kokoro TTS is not configured.',
            'tts_unavailable',
        );
    }

    async synthesize({ text = '', voiceId = '', timeoutMs } = {}) {
        this.assertConfigured();
        if (typeof this.fetch !== 'function') {
            throw createServiceError(503, 'Fetch is not available for remote Kokoro TTS.', 'tts_unavailable');
        }

        const selectedVoice = this.resolveVoiceProfile(voiceId);
        if (voiceId && !selectedVoice) {
            throw createServiceError(400, `Unknown Kokoro voice "${voiceId}".`, 'unknown_voice');
        }
        if (!selectedVoice) {
            throw createServiceError(503, 'Kokoro TTS has no configured voices.', 'tts_unavailable');
        }

        const speakableText = normalizeTextForSpeech(
            text,
            Math.max(200, Number(this.ttsConfig.maxTextChars) || 2400),
        );
        const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs) || Number(this.ttsConfig.timeoutMs) || 90000);
        const requestPayload = {
            text: speakableText,
            voiceId: selectedVoice.id,
            timeoutMs: effectiveTimeoutMs,
        };
        const retryAttempts = Math.max(1, Math.min(4, Number(this.ttsConfig.httpRetryAttempts) || 2));
        const retryDelayMs = Math.max(0, Math.min(2000, Number(this.ttsConfig.httpRetryDelayMs) || 160));

        const synthesizeOnce = async () => {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timeoutId = controller
                ? setTimeout(() => controller.abort(), effectiveTimeoutMs)
                : null;

            try {
                const response = await this.fetch(`${this.getBaseURL()}/synthesize`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(this.ttsConfig.httpConnectionClose === false ? {} : { Connection: 'close' }),
                    },
                    body: JSON.stringify(requestPayload),
                    signal: controller?.signal,
                });

                if (!response.ok) {
                    const errorPayload = await readErrorPayload(response);
                    throw createServiceError(
                        response.status || 502,
                        errorPayload.message || 'Remote Kokoro TTS failed.',
                        errorPayload.type || errorPayload.code || (response.status === 503 ? 'tts_unavailable' : 'tts_failed'),
                    );
                }

                const audioBuffer = Buffer.from(await response.arrayBuffer());
                if (!audioBuffer.length) {
                    throw createServiceError(502, 'Remote Kokoro TTS returned an empty audio file.', 'tts_empty_audio');
                }

                const responseVoiceId = response.headers?.get?.('x-tts-voice-id') || selectedVoice.id;
                return {
                    provider: DEFAULT_PROVIDER,
                    audioBuffer,
                    contentType: response.headers?.get?.('content-type') || 'audio/wav',
                    text: speakableText,
                    voice: toPublicVoiceProfile({
                        ...selectedVoice,
                        id: responseVoiceId,
                        label: response.headers?.get?.('x-tts-voice-label') || selectedVoice.label,
                    }),
                };
            } catch (error) {
                if (error?.name === 'AbortError') {
                    throw createServiceError(504, 'Remote Kokoro TTS timed out before audio generation completed.', 'tts_timeout');
                }
                if (error?.statusCode) {
                    throw error;
                }
                throw createServiceError(
                    503,
                    error?.message ? `Remote Kokoro TTS is unavailable: ${error.message}` : 'Remote Kokoro TTS is unavailable.',
                    'tts_unavailable',
                );
            } finally {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            }
        };

        let lastError = null;
        for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
            try {
                return await synthesizeOnce();
            } catch (error) {
                lastError = error;
                if (attempt >= retryAttempts || !isRetryableRemoteError(error)) {
                    throw error;
                }
                await sleep(retryDelayMs * attempt);
            }
        }

        throw lastError;
    }
}

module.exports = {
    KokoroHttpTtsService,
};

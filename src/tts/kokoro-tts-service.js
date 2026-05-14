const fsSync = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { config } = require('../config');
const { createServiceError, normalizeTextForSpeech } = require('./speech-text');

const DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE_ID = 'af_heart';
const DEFAULT_VOICE_LABEL = 'Heart Studio';
const DEFAULT_VOICE_DESCRIPTION = 'Primary high-quality Kokoro voice for polished local speech.';

function normalizeVoiceList(voices = []) {
    return (Array.isArray(voices) ? voices : [])
        .map((voice) => ({
            id: String(voice?.id || voice?.voiceId || '').trim(),
            label: String(voice?.label || voice?.voiceLabel || '').trim(),
            description: String(voice?.description || voice?.voiceDescription || '').trim(),
            aliases: Array.isArray(voice?.aliases)
                ? voice.aliases.map((alias) => String(alias || '').trim()).filter(Boolean)
                : [],
        }))
        .filter((voice) => voice.id);
}

function toNodeDevice(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['cpu', 'wasm', 'webgpu'].includes(normalized)) {
        return normalized;
    }
    return 'cpu';
}

function toDtype(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['fp32', 'fp16', 'q8', 'q4', 'q4f16'].includes(normalized)) {
        return normalized;
    }
    return 'q8';
}

function withTimeout(promise, timeoutMs, message) {
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const error = createServiceError(504, message, 'tts_timeout');
            error.pendingOperation = Promise.resolve(promise).catch(() => null);
            reject(error);
        }, Math.max(1000, Number(timeoutMs) || 90000));
    });

    return Promise.race([promise, timeoutPromise])
        .finally(() => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        });
}

class KokoroTtsService {
    constructor(ttsConfig = config.tts?.kokoro || {}, dependencies = {}) {
        this.ttsConfig = {
            ...ttsConfig,
        };
        this.importKokoro = dependencies.importKokoro || (() => require('kokoro-js'));
        this.importTransformers = dependencies.importTransformers || (() => require('@huggingface/transformers'));
        this.workerEnabled = dependencies.workerEnabled ?? this.ttsConfig.workerEnabled === true;
        this.createWorker = dependencies.createWorker || ((workerPath) => new Worker(workerPath));
        this.workerPath = dependencies.workerPath || path.join(__dirname, 'kokoro-synthesis-worker.js');
        this.worker = null;
        this.workerRequestId = 0;
        this.workerRequests = new Map();
        this.modelPromise = null;
        this.synthesisQueue = Promise.resolve();
        this.transformersRuntimeConfigured = false;
    }

    pathExists(targetPath = '') {
        const normalizedPath = String(targetPath || '').trim();
        if (!normalizedPath) {
            return false;
        }

        try {
            return fsSync.existsSync(normalizedPath);
        } catch (_error) {
            return false;
        }
    }

    getVoiceProfiles() {
        const configured = normalizeVoiceList(this.ttsConfig.voices);
        if (configured.length > 0) {
            return configured.map((voice) => ({
                ...voice,
                ...this.toPublicVoiceProfile(voice),
            }));
        }

        return [this.toPublicVoiceProfile({
            id: DEFAULT_VOICE_ID,
            label: DEFAULT_VOICE_LABEL,
            description: DEFAULT_VOICE_DESCRIPTION,
        })];
    }

    getDiagnostics() {
        const enabled = this.ttsConfig.enabled !== false;
        const voices = this.getVoiceProfiles();
        const hasModelId = Boolean(String(this.ttsConfig.modelId || DEFAULT_MODEL_ID).trim());

        if (!enabled) {
            return {
                status: 'unavailable',
                modelReachable: false,
                voicesLoaded: voices.length > 0,
                message: 'Kokoro TTS is disabled.',
            };
        }

        if (!hasModelId) {
            return {
                status: 'misconfigured',
                modelReachable: false,
                voicesLoaded: voices.length > 0,
                message: 'Kokoro TTS is enabled, but no model ID is configured.',
            };
        }

        if (voices.length === 0) {
            return {
                status: 'misconfigured',
                modelReachable: true,
                voicesLoaded: false,
                message: 'Kokoro voices are not configured.',
            };
        }

        return {
            status: 'ready',
            modelReachable: true,
            voicesLoaded: true,
            message: `${voices.length} Kokoro voice${voices.length === 1 ? '' : 's'} ready.`,
        };
    }

    isConfigured() {
        return this.getDiagnostics().status === 'ready';
    }

    toPublicVoiceProfile(voice = {}) {
        return {
            id: String(voice.id || DEFAULT_VOICE_ID).trim() || DEFAULT_VOICE_ID,
            label: String(voice.label || DEFAULT_VOICE_LABEL).trim() || DEFAULT_VOICE_LABEL,
            description: String(voice.description || DEFAULT_VOICE_DESCRIPTION).trim() || DEFAULT_VOICE_DESCRIPTION,
            provider: 'kokoro',
            aliases: Array.isArray(voice.aliases) ? voice.aliases.slice() : [],
        };
    }

    resolveVoiceProfile(voiceId = '') {
        const voices = this.getVoiceProfiles();
        if (voices.length === 0) {
            return null;
        }

        const requestedVoiceId = String(voiceId || '').trim();
        if (requestedVoiceId) {
            return voices.find((voice) => (
                voice.id === requestedVoiceId
                || (Array.isArray(voice.aliases) && voice.aliases.includes(requestedVoiceId))
            )) || null;
        }

        const defaultVoiceId = String(this.ttsConfig.defaultVoiceId || this.ttsConfig.voiceId || DEFAULT_VOICE_ID).trim();
        return voices.find((voice) => voice.id === defaultVoiceId || voice.aliases?.includes(defaultVoiceId)) || voices[0];
    }

    getPublicConfig() {
        const diagnostics = this.getDiagnostics();
        const configured = diagnostics.status === 'ready';
        const voices = this.getVoiceProfiles().map((voice) => this.toPublicVoiceProfile(voice));
        const defaultVoice = configured ? this.resolveVoiceProfile() : null;
        const maxTextChars = Math.max(200, Number(this.ttsConfig.maxTextChars) || 2400);
        const timeoutMs = Math.max(1000, Number(this.ttsConfig.timeoutMs) || 90000);
        const podcastTimeoutMs = Math.max(
            timeoutMs,
            Number(this.ttsConfig.podcastTimeoutMs) || timeoutMs,
        );
        const podcastChunkChars = Math.max(
            250,
            Math.min(
                maxTextChars,
                Number(this.ttsConfig.podcastChunkChars) || Math.min(900, maxTextChars),
            ),
        );

        return {
            configured,
            provider: 'kokoro',
            modelId: String(this.ttsConfig.modelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID,
            device: toNodeDevice(this.ttsConfig.device),
            dtype: toDtype(this.ttsConfig.dtype),
            cacheDir: String(this.ttsConfig.cacheDir || '').trim() || null,
            localModelPath: String(this.ttsConfig.localModelPath || '').trim() || null,
            allowRemoteModels: typeof this.ttsConfig.allowRemoteModels === 'boolean'
                ? this.ttsConfig.allowRemoteModels
                : null,
            maxTextChars,
            timeoutMs,
            podcastTimeoutMs,
            podcastChunkChars,
            defaultVoiceId: configured ? (defaultVoice?.id || voices[0]?.id || null) : null,
            voices,
            diagnostics: {
                ...diagnostics,
                workerEnabled: this.workerEnabled === true,
            },
        };
    }

    assertConfigured() {
        const diagnostics = this.getDiagnostics();
        if (diagnostics.status === 'ready') {
            return;
        }

        throw createServiceError(
            503,
            diagnostics.message || 'Kokoro TTS is not configured.',
            'tts_unavailable',
        );
    }

    configureTransformersRuntime() {
        if (this.transformersRuntimeConfigured) {
            return;
        }

        const cacheDir = String(this.ttsConfig.cacheDir || '').trim();
        const localModelPath = String(this.ttsConfig.localModelPath || '').trim();
        const allowRemoteModels = this.ttsConfig.allowRemoteModels;

        if (!cacheDir && !localModelPath && typeof allowRemoteModels !== 'boolean') {
            this.transformersRuntimeConfigured = true;
            return;
        }

        const moduleExports = this.importTransformers();
        const transformersEnv = moduleExports?.env;
        if (!transformersEnv || typeof transformersEnv !== 'object') {
            throw createServiceError(503, 'Transformers.js did not expose an env object.', 'tts_unavailable');
        }

        if (cacheDir) {
            fsSync.mkdirSync(cacheDir, { recursive: true });
            transformersEnv.cacheDir = cacheDir;
        }
        if (localModelPath) {
            transformersEnv.localModelPath = localModelPath;
        }
        if (typeof allowRemoteModels === 'boolean') {
            transformersEnv.allowRemoteModels = allowRemoteModels;
        }

        this.transformersRuntimeConfigured = true;
    }

    async getModel() {
        this.assertConfigured();
        if (this.workerEnabled) {
            return this.callWorker('warm', {}, Number(this.ttsConfig.timeoutMs) || 90000);
        }
        if (!this.modelPromise) {
            const modelId = String(this.ttsConfig.modelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
            this.modelPromise = Promise.resolve()
                .then(() => this.configureTransformersRuntime())
                .then(() => this.importKokoro())
                .then((moduleExports) => {
                    const KokoroTTS = moduleExports?.KokoroTTS;
                    if (!KokoroTTS?.from_pretrained) {
                        throw createServiceError(503, 'kokoro-js did not expose KokoroTTS.', 'tts_unavailable');
                    }
                    return KokoroTTS.from_pretrained(modelId, {
                        dtype: toDtype(this.ttsConfig.dtype),
                        device: toNodeDevice(this.ttsConfig.device),
                    });
                })
                .catch((error) => {
                    this.modelPromise = null;
                    if (error?.statusCode) {
                        throw error;
                    }
                    throw createServiceError(
                        503,
                        error?.message ? `Kokoro model failed to load: ${error.message}` : 'Kokoro model failed to load.',
                        'tts_unavailable',
                    );
                });
        }

        return this.modelPromise;
    }

    getWorker() {
        if (this.worker) {
            return this.worker;
        }

        const worker = this.createWorker(this.workerPath);
        this.worker = worker;

        worker.on('message', (message = {}) => {
            const request = this.workerRequests.get(message.id);
            if (!request) {
                return;
            }
            this.workerRequests.delete(message.id);
            clearTimeout(request.timeoutId);

            if (message.ok) {
                const result = message.result || {};
                if (result.audioBuffer && !Buffer.isBuffer(result.audioBuffer)) {
                    result.audioBuffer = Buffer.from(result.audioBuffer);
                }
                request.resolve(result);
                return;
            }

            const errorPayload = message.error || {};
            const error = createServiceError(
                Number(errorPayload.statusCode) || 502,
                errorPayload.message || 'Kokoro synthesis worker failed.',
                errorPayload.code || 'tts_failed',
            );
            request.reject(error);
        });

        const failPending = (error) => {
            for (const request of this.workerRequests.values()) {
                clearTimeout(request.timeoutId);
                request.reject(error);
            }
            this.workerRequests.clear();
        };

        worker.on('error', (error) => {
            const wrapped = createServiceError(
                503,
                error?.message ? `Kokoro synthesis worker failed: ${error.message}` : 'Kokoro synthesis worker failed.',
                'tts_unavailable',
            );
            failPending(wrapped);
            if (this.worker === worker) {
                this.worker = null;
            }
        });

        worker.on('exit', (code) => {
            if (this.worker === worker) {
                this.worker = null;
            }
            if (code !== 0) {
                failPending(createServiceError(
                    503,
                    `Kokoro synthesis worker exited with code ${code}.`,
                    'tts_unavailable',
                ));
            }
        });

        return worker;
    }

    async resetWorker() {
        const worker = this.worker;
        this.worker = null;
        if (worker?.terminate) {
            try {
                await worker.terminate();
            } catch (_error) {
                // Best-effort recovery after a synthesis timeout.
            }
        }
    }

    callWorker(action, payload = {}, timeoutMs = 90000) {
        const worker = this.getWorker();
        const id = ++this.workerRequestId;
        const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs) || 90000);

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(async () => {
                if (!this.workerRequests.has(id)) {
                    return;
                }
                this.workerRequests.delete(id);
                await this.resetWorker();
                reject(createServiceError(
                    504,
                    'Kokoro synthesis worker timed out before responding.',
                    'tts_timeout',
                ));
            }, effectiveTimeoutMs + 5000);

            this.workerRequests.set(id, {
                resolve,
                reject,
                timeoutId,
            });

            worker.postMessage({
                id,
                action,
                payload,
            });
        });
    }

    enqueueSynthesis(task) {
        const run = this.synthesisQueue
            .catch(() => null)
            .then(task);
        this.synthesisQueue = run.catch(async (error) => {
            if (error?.code === 'tts_timeout' && error?.pendingOperation) {
                await error.pendingOperation;
            }
            return null;
        });
        return run;
    }

    async synthesize({ text = '', voiceId = '', timeoutMs } = {}) {
        this.assertConfigured();

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

        return this.enqueueSynthesis(async () => {
            if (this.workerEnabled) {
                return this.callWorker('synthesize', {
                    text: speakableText,
                    voiceId: selectedVoice.id,
                    timeoutMs: effectiveTimeoutMs,
                }, effectiveTimeoutMs);
            }

            try {
                const model = await withTimeout(
                    this.getModel(),
                    effectiveTimeoutMs,
                    'Kokoro TTS timed out before the model loaded.',
                );
                const audio = await withTimeout(
                    model.generate(speakableText, {
                        voice: selectedVoice.id,
                        speed: Number(this.ttsConfig.speed) || 1,
                    }),
                    effectiveTimeoutMs,
                    'Kokoro TTS timed out before audio generation completed.',
                );
                const wav = typeof audio?.toWav === 'function' ? audio.toWav() : null;
                const audioBuffer = wav ? Buffer.from(wav) : Buffer.alloc(0);
                if (!audioBuffer.length) {
                    throw createServiceError(502, 'Kokoro TTS returned an empty audio file.', 'tts_empty_audio');
                }

                return {
                    provider: 'kokoro',
                    audioBuffer,
                    contentType: 'audio/wav',
                    text: speakableText,
                    voice: this.toPublicVoiceProfile(selectedVoice),
                };
            } catch (error) {
                if (error?.code === 'tts_timeout') {
                    this.modelPromise = null;
                }
                if (error?.statusCode) {
                    throw error;
                }

                throw createServiceError(502, error.message || 'Kokoro TTS failed.', 'tts_failed');
            }
        });
    }
}

const kokoroTtsService = new KokoroTtsService();

module.exports = {
    DEFAULT_MODEL_ID,
    DEFAULT_VOICE_DESCRIPTION,
    DEFAULT_VOICE_ID,
    DEFAULT_VOICE_LABEL,
    KokoroTtsService,
    kokoroTtsService,
};

const fsSync = require('fs');
const path = require('path');
const { fork } = require('child_process');
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

function normalizeWorkerIsolation(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['thread', 'worker', 'worker_thread', 'worker-thread'].includes(normalized)) {
        return 'thread';
    }
    return 'process';
}

function normalizeWorkerAudioBuffer(value) {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value);
    }
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) {
        return Buffer.from(value);
    }
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data);
    }
    if (value && Array.isArray(value.data)) {
        return Buffer.from(value.data);
    }
    return value;
}

class KokoroTtsService {
    constructor(ttsConfig = config.tts?.kokoro || {}, dependencies = {}) {
        this.ttsConfig = {
            ...ttsConfig,
        };
        this.importKokoro = dependencies.importKokoro || (() => require('./kokoro-transformers-runtime'));
        this.importTransformers = dependencies.importTransformers || (() => require('@huggingface/transformers'));
        this.workerEnabled = dependencies.workerEnabled ?? this.ttsConfig.workerEnabled === true;
        this.workerIsolation = this.workerEnabled
            ? normalizeWorkerIsolation(
                dependencies.workerIsolation
                || this.ttsConfig.workerIsolation
                || process.env.KOKORO_TTS_WORKER_ISOLATION
                || 'process',
            )
            : 'none';
        this.createWorker = dependencies.createWorker || ((workerPath) => (
            this.workerIsolation === 'thread'
                ? new Worker(workerPath)
                : fork(workerPath, [], {
                    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
                    env: { ...process.env },
                })
        ));
        this.workerPath = dependencies.workerPath || path.join(__dirname, 'kokoro-synthesis-worker.js');
        this.worker = null;
        this.workerPool = [];
        this.nextWorkerPoolIndex = 0;
        this.workerRequestId = 0;
        this.workerRequests = new Map();
        this.modelPromise = null;
        const requestedSynthesisConcurrency = Math.max(
            1,
            Math.min(8, Number(this.ttsConfig.synthesisConcurrency) || 1),
        );
        this.maxSynthesisConcurrency = this.workerEnabled ? 1 : requestedSynthesisConcurrency;
        this.activeSynthesisCount = 0;
        this.synthesisWaiters = [];
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
                workerIsolation: this.workerIsolation,
                synthesisConcurrency: this.maxSynthesisConcurrency,
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
            const workerCount = this.getWorkerPoolSize();
            const warmResults = await Promise.all(Array.from({ length: workerCount }, (_value, index) => (
                this.callWorker('warm', {}, Number(this.ttsConfig.timeoutMs) || 90000, { workerIndex: index })
            )));
            return warmResults[0];
        }
        if (!this.modelPromise) {
            const modelId = String(this.ttsConfig.modelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
            this.modelPromise = Promise.resolve()
                .then(() => this.configureTransformersRuntime())
                .then(() => this.importKokoro())
                .then((moduleExports) => {
                    const KokoroTTS = moduleExports?.KokoroTTS;
                    if (!KokoroTTS?.from_pretrained) {
                        throw createServiceError(503, 'Kokoro runtime did not expose KokoroTTS.', 'tts_unavailable');
                    }
                    const loadOptions = {
                        dtype: toDtype(this.ttsConfig.dtype),
                        device: toNodeDevice(this.ttsConfig.device),
                    };
                    if (moduleExports.KIMIBUILT_KOKORO_RUNTIME === true) {
                        loadOptions.transformers = this.importTransformers();
                        loadOptions.cacheDir = String(this.ttsConfig.cacheDir || '').trim();
                        loadOptions.allowRemoteModels = this.ttsConfig.allowRemoteModels;
                    }
                    return KokoroTTS.from_pretrained(modelId, loadOptions);
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

    getWorkerPoolSize() {
        return this.workerEnabled ? this.maxSynthesisConcurrency : 1;
    }

    createWorkerDescriptor(index = 0) {
        const worker = this.createWorker(this.workerPath);
        const descriptor = {
            index,
            worker,
            pendingRequestIds: new Set(),
        };
        this.workerPool[index] = descriptor;
        if (index === 0) {
            this.worker = worker;
        }

        worker.on('message', (message = {}) => {
            const request = this.workerRequests.get(message.id);
            if (!request) {
                return;
            }
            this.workerRequests.delete(message.id);
            descriptor.pendingRequestIds.delete(message.id);
            clearTimeout(request.timeoutId);

            if (message.ok) {
                const result = message.result || {};
                result.audioBuffer = normalizeWorkerAudioBuffer(result.audioBuffer);
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
            const pendingRequestIds = Array.from(descriptor.pendingRequestIds);
            descriptor.pendingRequestIds.clear();
            for (const requestId of pendingRequestIds) {
                const request = this.workerRequests.get(requestId);
                if (!request) {
                    continue;
                }
                this.workerRequests.delete(requestId);
                clearTimeout(request.timeoutId);
                request.reject(error);
            }
        };

        worker.on('error', (error) => {
            const wrapped = createServiceError(
                503,
                error?.message ? `Kokoro synthesis worker failed: ${error.message}` : 'Kokoro synthesis worker failed.',
                'tts_unavailable',
            );
            failPending(wrapped);
            this.workerPool[index] = null;
            this.worker = this.workerPool[0]?.worker || null;
        });

        worker.on('exit', (code) => {
            this.workerPool[index] = null;
            this.worker = this.workerPool[0]?.worker || null;
            if (code !== 0) {
                failPending(createServiceError(
                    503,
                    `Kokoro synthesis worker exited with code ${code}.`,
                    'tts_unavailable',
                ));
            }
        });

        return descriptor;
    }

    sendWorkerMessage(worker, message) {
        if (typeof worker?.postMessage === 'function') {
            worker.postMessage(message);
            return;
        }

        if (typeof worker?.send === 'function' && worker.connected !== false) {
            worker.send(message);
            return;
        }

        throw createServiceError(503, 'Kokoro synthesis worker is not connected.', 'tts_unavailable');
    }

    async stopWorker(worker) {
        if (typeof worker?.terminate === 'function') {
            await worker.terminate();
            return;
        }
        if (typeof worker?.kill === 'function') {
            worker.kill();
        }
    }

    getWorkerDescriptor(options = {}) {
        const poolSize = this.getWorkerPoolSize();
        const requestedIndex = Number.isInteger(options.workerIndex)
            ? Math.max(0, Math.min(poolSize - 1, options.workerIndex))
            : null;

        if (requestedIndex !== null) {
            return this.workerPool[requestedIndex] || this.createWorkerDescriptor(requestedIndex);
        }

        while (this.workerPool.length < poolSize) {
            this.createWorkerDescriptor(this.workerPool.length);
        }

        let selected = null;
        for (let offset = 0; offset < poolSize; offset += 1) {
            const index = (this.nextWorkerPoolIndex + offset) % poolSize;
            const descriptor = this.workerPool[index] || this.createWorkerDescriptor(index);
            if (!selected || descriptor.pendingRequestIds.size < selected.pendingRequestIds.size) {
                selected = descriptor;
            }
        }

        this.nextWorkerPoolIndex = ((selected?.index || 0) + 1) % poolSize;
        return selected;
    }

    async resetWorker(descriptor = null) {
        const targetDescriptor = descriptor || this.workerPool[0] || null;
        const worker = targetDescriptor?.worker || this.worker;
        if (targetDescriptor) {
            this.workerPool[targetDescriptor.index] = null;
        }
        this.worker = this.workerPool[0]?.worker || null;
        if (worker?.terminate || worker?.kill) {
            try {
                await this.stopWorker(worker);
            } catch (_error) {
                // Best-effort recovery after a synthesis timeout.
            }
        }
    }

    callWorker(action, payload = {}, timeoutMs = 90000, options = {}) {
        const descriptor = this.getWorkerDescriptor(options);
        const worker = descriptor.worker;
        const id = ++this.workerRequestId;
        const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs) || 90000);

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(async () => {
                if (!this.workerRequests.has(id)) {
                    return;
                }
                this.workerRequests.delete(id);
                descriptor.pendingRequestIds.delete(id);
                await this.resetWorker(descriptor);
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
            descriptor.pendingRequestIds.add(id);

            try {
                this.sendWorkerMessage(worker, {
                    id,
                    action,
                    payload,
                });
            } catch (error) {
                clearTimeout(timeoutId);
                this.workerRequests.delete(id);
                descriptor.pendingRequestIds.delete(id);
                reject(error);
            }
        });
    }

    acquireSynthesisSlot() {
        if (this.activeSynthesisCount < this.maxSynthesisConcurrency) {
            this.activeSynthesisCount += 1;
            return Promise.resolve(this.releaseSynthesisSlot.bind(this));
        }

        return new Promise((resolve) => {
            this.synthesisWaiters.push(resolve);
        }).then(() => {
            this.activeSynthesisCount += 1;
            return this.releaseSynthesisSlot.bind(this);
        });
    }

    releaseSynthesisSlot() {
        this.activeSynthesisCount = Math.max(0, this.activeSynthesisCount - 1);
        const nextWaiter = this.synthesisWaiters.shift();
        if (nextWaiter) {
            nextWaiter();
        }
    }

    releaseSynthesisSlotAfter(promise, release) {
        Promise.resolve(promise)
            .catch(() => null)
            .finally(release);
    }

    async runSynthesis(task) {
        const release = await this.acquireSynthesisSlot();
        let releaseDeferred = false;
        try {
            return await task();
        } catch (error) {
            if (error?.code === 'tts_timeout' && error?.pendingOperation) {
                releaseDeferred = true;
                this.releaseSynthesisSlotAfter(error.pendingOperation, release);
            }
            throw error;
        } finally {
            if (!releaseDeferred) {
                release();
            }
        }
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

        return this.runSynthesis(async () => {
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

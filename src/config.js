require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getStateDirectory } = require('./runtime-state-paths');
const { resolveDefaultRepositoryPath } = require('./repository-paths');

const persistenceDataDir = process.env.KIMIBUILT_DATA_DIR
    ? path.resolve(process.env.KIMIBUILT_DATA_DIR)
    : getStateDirectory();
const defaultRepositoryPath = resolveDefaultRepositoryPath({
    explicitPath: process.env.DEFAULT_GIT_REPOSITORY_PATH,
    currentWorkingDirectory: process.cwd(),
    dataDir: persistenceDataDir,
    repositoryUrl: process.env.KIMIBUILT_DEPLOY_REPO_URL || '',
});

function resolveConfigPath(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return '';
    }

    if (path.isAbsolute(normalized)) {
        return path.normalize(normalized);
    }

    if (normalized.includes('/') || normalized.includes('\\') || /\.[a-z0-9]+$/i.test(normalized)) {
        return path.resolve(process.cwd(), normalized);
    }

    return normalized;
}

function parseOptionalInteger(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalFloat(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalBoolean(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return null;
}

function parseOptionalStringList(value) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return [];
    }

    return normalized
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function parseIntegerWithDefault(value, fallback, { min = 0 } = {}) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, parsed);
}

function parseRecentMessageCharLimit(value) {
    const parsed = parseOptionalInteger(value);
    if (parsed == null || parsed === 0) {
        return 0;
    }

    return Math.max(500, parsed);
}

function resolveAvailableParallelism() {
    try {
        if (typeof os.availableParallelism === 'function') {
            return Math.max(1, Number(os.availableParallelism()) || 1);
        }
    } catch (_error) {
        // Fall through to the CPU-count fallback.
    }

    try {
        const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 0;
        return Math.max(1, cpuCount || 1);
    } catch (_error) {
        return 2;
    }
}

function buildAudioProviderCandidates() {
    const defaultBaseURL = 'https://api.openai.com/v1';
    const candidates = [
        {
            id: 'transcription',
            apiKey: String(process.env.OPENAI_TRANSCRIPTION_API_KEY || '').trim(),
            baseURL: String(process.env.OPENAI_TRANSCRIPTION_BASE_URL || process.env.OPENAI_BASE_URL || defaultBaseURL).trim() || defaultBaseURL,
        },
        {
            id: 'media',
            apiKey: String(process.env.OPENAI_MEDIA_API_KEY || '').trim(),
            baseURL: String(process.env.OPENAI_MEDIA_BASE_URL || defaultBaseURL).trim() || defaultBaseURL,
        },
        {
            id: 'openai',
            apiKey: String(process.env.OPENAI_API_KEY || '').trim(),
            baseURL: String(process.env.OPENAI_BASE_URL || defaultBaseURL).trim() || defaultBaseURL,
        },
    ].filter((candidate) => candidate.apiKey);

    const seen = new Set();
    return candidates.filter((candidate) => {
        const cacheKey = `${candidate.apiKey}::${candidate.baseURL}`;
        if (seen.has(cacheKey)) {
            return false;
        }
        seen.add(cacheKey);
        return true;
    });
}

function normalizePiperVoiceDefinition(value = {}, defaults = {}) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const id = String(value.id || value.voiceId || defaults.id || '').trim();
    const modelPath = resolveConfigPath(value.modelPath || value.model_path || defaults.modelPath || '');
    if (!id || !modelPath) {
        return null;
    }

    return {
        id,
        label: String(value.label || value.voiceLabel || defaults.label || '').trim() || id,
        description: String(value.description || value.voiceDescription || defaults.description || '').trim(),
        modelPath,
        configPath: resolveConfigPath(value.configPath || value.config_path || defaults.configPath || ''),
        speakerId: parseOptionalInteger(value.speakerId ?? value.speaker_id ?? defaults.speakerId),
        lengthScale: parseOptionalFloat(value.lengthScale ?? value.length_scale ?? defaults.lengthScale),
        noiseScale: parseOptionalFloat(value.noiseScale ?? value.noise_scale ?? defaults.noiseScale),
        noiseW: parseOptionalFloat(value.noiseW ?? value.noise_w ?? defaults.noiseW),
        sentenceSilence: parseOptionalFloat(value.sentenceSilence ?? value.sentence_silence ?? defaults.sentenceSilence),
    };
}

function normalizeKokoroVoiceDefinition(value = {}, defaults = {}) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const id = String(value.id || value.voiceId || defaults.id || '').trim();
    if (!id) {
        return null;
    }

    return {
        id,
        label: String(value.label || value.voiceLabel || defaults.label || '').trim() || id,
        description: String(value.description || value.voiceDescription || defaults.description || '').trim(),
        aliases: Array.isArray(value.aliases)
            ? value.aliases.map((alias) => String(alias || '').trim()).filter(Boolean)
            : [],
    };
}

function parsePiperVoicesPayload(rawValue = '', defaults = {}) {
    const normalized = String(rawValue || '').trim();
    if (!normalized) {
        return [];
    }

    try {
        const parsed = JSON.parse(normalized);
        return (Array.isArray(parsed) ? parsed : [])
            .map((entry) => normalizePiperVoiceDefinition(entry, defaults))
            .filter(Boolean);
    } catch (error) {
        console.warn(`[Config] Failed to parse Piper voices JSON: ${error.message}`);
        return [];
    }
}

function parseKokoroVoicesPayload(rawValue = '', defaults = {}) {
    const normalized = String(rawValue || '').trim();
    if (!normalized) {
        return [];
    }

    try {
        const parsed = JSON.parse(normalized);
        return (Array.isArray(parsed) ? parsed : [])
            .map((entry) => normalizeKokoroVoiceDefinition(entry, defaults))
            .filter(Boolean);
    } catch (error) {
        console.warn(`[Config] Failed to parse Kokoro voices JSON: ${error.message}`);
        return [];
    }
}

function getBundledPiperRoot() {
    return path.resolve(__dirname, '../data/piper');
}

function getBundledKokoroRoot() {
    return path.resolve(__dirname, '../data/kokoro');
}

function resolveBundledPiperBinaryPath() {
    const executableName = process.platform === 'win32' ? 'piper.exe' : 'piper';
    const bundledBinaryPath = path.join(getBundledPiperRoot(), 'runtime', 'piper', executableName);

    try {
        return fs.existsSync(bundledBinaryPath) ? bundledBinaryPath : '';
    } catch (_error) {
        return '';
    }
}

function resolveBundledPiperVoicesPath() {
    const bundledVoicesPath = path.join(getBundledPiperRoot(), 'voices', 'manifest.json');

    try {
        return fs.existsSync(bundledVoicesPath) ? bundledVoicesPath : '';
    } catch (_error) {
        return '';
    }
}

function resolveBundledKokoroVoicesPath() {
    const bundledVoicesPath = path.join(getBundledKokoroRoot(), 'voices', 'manifest.json');

    try {
        return fs.existsSync(bundledVoicesPath) ? bundledVoicesPath : '';
    } catch (_error) {
        return '';
    }
}

function loadConfiguredPiperVoices(defaults = {}) {
    const candidateVoicesPaths = [
        resolveConfigPath(process.env.PIPER_TTS_VOICES_PATH || ''),
        resolveBundledPiperVoicesPath(),
    ].filter(Boolean);
    const seenPaths = new Set();

    for (const voicesPath of candidateVoicesPaths) {
        if (seenPaths.has(voicesPath)) {
            continue;
        }
        seenPaths.add(voicesPath);

        try {
            const fileContents = fs.readFileSync(voicesPath, 'utf8');
            const parsedVoices = parsePiperVoicesPayload(fileContents, defaults);
            if (parsedVoices.length > 0) {
                return {
                    voicesPath,
                    voices: parsedVoices,
                };
            }
        } catch (error) {
            console.warn(`[Config] Failed to load Piper voices file "${voicesPath}": ${error.message}`);
        }
    }

    const parsedVoices = parsePiperVoicesPayload(process.env.PIPER_TTS_VOICES_JSON || '', defaults);
    if (parsedVoices.length > 0) {
        return {
            voicesPath: resolveConfigPath(process.env.PIPER_TTS_VOICES_PATH || '') || resolveBundledPiperVoicesPath(),
            voices: parsedVoices,
        };
    }

    const legacyVoice = normalizePiperVoiceDefinition({
        id: defaults.id,
        label: defaults.label,
        description: defaults.description,
        modelPath: process.env.PIPER_TTS_MODEL_PATH || '',
        configPath: process.env.PIPER_TTS_CONFIG_PATH || '',
        speakerId: process.env.PIPER_TTS_SPEAKER_ID,
        lengthScale: process.env.PIPER_TTS_LENGTH_SCALE,
        noiseScale: process.env.PIPER_TTS_NOISE_SCALE,
        noiseW: process.env.PIPER_TTS_NOISE_W,
        sentenceSilence: process.env.PIPER_TTS_SENTENCE_SILENCE,
    }, defaults);

    return {
        voicesPath: resolveConfigPath(process.env.PIPER_TTS_VOICES_PATH || '') || resolveBundledPiperVoicesPath(),
        voices: legacyVoice ? [legacyVoice] : [],
    };
}

function loadConfiguredKokoroVoices(defaults = {}) {
    const candidateVoicesPaths = [
        resolveConfigPath(process.env.KOKORO_TTS_VOICES_PATH || ''),
        resolveBundledKokoroVoicesPath(),
    ].filter(Boolean);
    const seenPaths = new Set();

    for (const voicesPath of candidateVoicesPaths) {
        if (seenPaths.has(voicesPath)) {
            continue;
        }
        seenPaths.add(voicesPath);

        try {
            const fileContents = fs.readFileSync(voicesPath, 'utf8');
            const parsedVoices = parseKokoroVoicesPayload(fileContents, defaults);
            if (parsedVoices.length > 0) {
                return {
                    voicesPath,
                    voices: parsedVoices,
                };
            }
        } catch (error) {
            console.warn(`[Config] Failed to load Kokoro voices file "${voicesPath}": ${error.message}`);
        }
    }

    const parsedVoices = parseKokoroVoicesPayload(process.env.KOKORO_TTS_VOICES_JSON || '', defaults);
    if (parsedVoices.length > 0) {
        return {
            voicesPath: resolveConfigPath(process.env.KOKORO_TTS_VOICES_PATH || '') || resolveBundledKokoroVoicesPath(),
            voices: parsedVoices,
        };
    }

    const legacyVoice = normalizeKokoroVoiceDefinition({
        id: defaults.id,
        label: defaults.label,
        description: defaults.description,
        aliases: defaults.aliases,
    }, defaults);

    return {
        voicesPath: resolveConfigPath(process.env.KOKORO_TTS_VOICES_PATH || '') || resolveBundledKokoroVoicesPath(),
        voices: legacyVoice ? [legacyVoice] : [],
    };
}

const piperVoiceDefaults = {
    id: process.env.PIPER_TTS_VOICE_ID || 'piper-female-natural',
    label: process.env.PIPER_TTS_VOICE_LABEL || 'Female natural',
    description: process.env.PIPER_TTS_VOICE_DESCRIPTION || 'A Piper voice tuned for clear, natural female speech.',
    modelPath: process.env.PIPER_TTS_MODEL_PATH || '',
    configPath: process.env.PIPER_TTS_CONFIG_PATH || '',
    speakerId: parseOptionalInteger(process.env.PIPER_TTS_SPEAKER_ID),
    lengthScale: parseOptionalFloat(process.env.PIPER_TTS_LENGTH_SCALE) ?? 1.02,
    noiseScale: parseOptionalFloat(process.env.PIPER_TTS_NOISE_SCALE) ?? 0.38,
    noiseW: parseOptionalFloat(process.env.PIPER_TTS_NOISE_W) ?? 0.68,
    sentenceSilence: parseOptionalFloat(process.env.PIPER_TTS_SENTENCE_SILENCE) ?? 0.24,
};
const kokoroVoiceDefaults = {
    id: process.env.KOKORO_TTS_VOICE_ID || 'af_heart',
    label: process.env.KOKORO_TTS_VOICE_LABEL || 'Heart Studio',
    description: process.env.KOKORO_TTS_VOICE_DESCRIPTION || 'Primary high-quality Kokoro voice for polished local speech.',
    aliases: [],
};
const configuredPiperVoices = loadConfiguredPiperVoices(piperVoiceDefaults);
const configuredKokoroVoices = loadConfiguredKokoroVoices(kokoroVoiceDefaults);
const configuredAudioProviders = buildAudioProviderCandidates();
const availableParallelism = resolveAvailableParallelism();
const normalizedPodcastResearchConcurrency = Math.max(
    1,
    Math.min(
        12,
        parseInt(process.env.PODCAST_RESEARCH_CONCURRENCY, 10)
            || Math.min(2, Math.max(1, Math.ceil(availableParallelism / 6))),
    ),
);
const normalizedPodcastTtsConcurrency = Math.max(
    1,
    Math.min(
        24,
        parseInt(process.env.PODCAST_TTS_CONCURRENCY, 10)
            || 1,
    ),
);
const normalizedPiperMaxTextChars = Math.max(
    200,
    parseInt(process.env.PIPER_TTS_MAX_TEXT_CHARS, 10) || 2400,
);
const normalizedPiperTimeoutMs = Math.max(
    1000,
    parseInt(process.env.PIPER_TTS_TIMEOUT_MS, 10) || 45000,
);
const normalizedPiperPodcastTimeoutMs = Math.max(
    normalizedPiperTimeoutMs,
    parseInt(process.env.PIPER_TTS_PODCAST_TIMEOUT_MS, 10) || 210000,
);
const normalizedPiperPodcastChunkChars = Math.max(
    250,
    Math.min(
        normalizedPiperMaxTextChars,
        parseInt(process.env.PIPER_TTS_PODCAST_CHUNK_CHARS, 10) || Math.min(760, normalizedPiperMaxTextChars),
    ),
);
const normalizedKokoroMaxTextChars = Math.max(
    200,
    parseInt(process.env.KOKORO_TTS_MAX_TEXT_CHARS, 10) || 2400,
);
const normalizedKokoroTimeoutMs = Math.max(
    1000,
    parseInt(process.env.KOKORO_TTS_TIMEOUT_MS, 10) || 90000,
);
const normalizedKokoroPodcastTimeoutMs = Math.max(
    normalizedKokoroTimeoutMs,
    parseInt(process.env.KOKORO_TTS_PODCAST_TIMEOUT_MS, 10) || 240000,
);
const normalizedKokoroPodcastChunkChars = Math.max(
    250,
    Math.min(
        normalizedKokoroMaxTextChars,
        parseInt(process.env.KOKORO_TTS_PODCAST_CHUNK_CHARS, 10) || Math.min(900, normalizedKokoroMaxTextChars),
    ),
);
const normalizedKokoroSynthesisConcurrency = Math.max(
    1,
    Math.min(
        8,
        parseInt(process.env.KOKORO_TTS_SYNTHESIS_CONCURRENCY, 10)
            || parseInt(process.env.KOKORO_TTS_CONCURRENCY, 10)
            || 1,
    ),
);
const normalizedTtsRealtimeSynthesisLanes = Math.max(
    1,
    Math.min(
        8,
        parseInt(process.env.TTS_REALTIME_SYNTHESIS_LANES, 10) || 4,
    ),
);
const normalizedTtsRealtimeSynthesisLookahead = Math.max(
    normalizedTtsRealtimeSynthesisLanes,
    Math.min(
        12,
        parseInt(process.env.TTS_REALTIME_SYNTHESIS_LOOKAHEAD, 10) || 6,
    ),
);
const normalizedTtsRealtimeChunkTargetChars = Math.max(
    60,
    Math.min(
        normalizedKokoroMaxTextChars,
        parseInt(process.env.TTS_REALTIME_CHUNK_TARGET_CHARS, 10) || 360,
    ),
);
const normalizedTtsRealtimeInitialBufferChunks = Math.max(
    1,
    Math.min(
        4,
        parseInt(process.env.TTS_REALTIME_INITIAL_BUFFER_CHUNKS, 10) || 1,
    ),
);
const normalizedTtsRealtimeFirstChunkSentences = Math.max(
    1,
    Math.min(
        3,
        parseInt(process.env.TTS_REALTIME_FIRST_CHUNK_SENTENCES, 10) || 1,
    ),
);
const normalizedTtsRealtimeSecondChunkSentences = Math.max(
    1,
    Math.min(
        3,
        parseInt(process.env.TTS_REALTIME_SECOND_CHUNK_SENTENCES, 10) || 1,
    ),
);
const normalizedTtsRealtimeMaxSentencesPerChunk = Math.max(
    normalizedTtsRealtimeSecondChunkSentences,
    Math.min(
        4,
        parseInt(process.env.TTS_REALTIME_MAX_SENTENCES_PER_CHUNK, 10) || 3,
    ),
);
const normalizedTtsRealtimePrimaryTimeoutMs = Math.max(
    3000,
    Math.min(
        normalizedKokoroTimeoutMs,
        parseInt(process.env.TTS_REALTIME_PRIMARY_TIMEOUT_MS, 10) || 24000,
    ),
);
const normalizedTtsRealtimeFallbackTimeoutMs = Math.max(
    2000,
    Math.min(
        normalizedPiperTimeoutMs,
        parseInt(process.env.TTS_REALTIME_FALLBACK_TIMEOUT_MS, 10) || 24000,
    ),
);
const normalizedTtsRealtimeHedgeDelayMs = Math.max(
    250,
    Math.min(
        5000,
        parseInt(process.env.TTS_REALTIME_HEDGE_DELAY_MS, 10) || 900,
    ),
);
const normalizedTtsRealtimeChunkStallMs = Math.max(
    350,
    Math.min(
        30000,
        parseInt(process.env.TTS_REALTIME_CHUNK_STALL_MS, 10) || 9000,
    ),
);
const normalizedPodcastVideoSegmentTimeoutMs = Math.max(
    30000,
    parseInt(process.env.PODCAST_VIDEO_SEGMENT_TIMEOUT_MS, 10) || 360000,
);
const normalizedPodcastVideoMuxTimeoutMs = Math.max(
    60000,
    parseInt(process.env.PODCAST_VIDEO_MUX_TIMEOUT_MS, 10)
        || parseInt(process.env.PODCAST_VIDEO_RENDER_TIMEOUT_MS, 10)
        || 1200000,
);
const normalizedPodcastVideoMaxFfmpegTimeoutMs = Math.max(
    normalizedPodcastVideoMuxTimeoutMs,
    parseInt(process.env.PODCAST_VIDEO_MAX_FFMPEG_TIMEOUT_MS, 10) || 2700000,
);
const normalizedPodcastToolTimeoutMs = Math.max(
    900000,
    parseInt(process.env.PODCAST_TOOL_TIMEOUT_MS, 10) || 3600000,
);
const allowedPodcastVideoX264Presets = new Set([
    'ultrafast',
    'superfast',
    'veryfast',
    'faster',
    'fast',
    'medium',
    'slow',
    'slower',
    'veryslow',
]);
const requestedPodcastVideoX264Preset = String(process.env.PODCAST_VIDEO_X264_PRESET || '').trim().toLowerCase();
const normalizedPodcastVideoX264Preset = allowedPodcastVideoX264Presets.has(requestedPodcastVideoX264Preset)
    ? requestedPodcastVideoX264Preset
    : 'veryfast';
const normalizedPodcastVideoX264Crf = Math.max(
    18,
    Math.min(32, parseOptionalInteger(process.env.PODCAST_VIDEO_X264_CRF) ?? 23),
);
const normalizedPodcastVideoDefaultSceneCount = Math.max(
    1,
    Math.min(36, parseOptionalInteger(process.env.PODCAST_VIDEO_DEFAULT_SCENE_COUNT) ?? 14),
);
const normalizedPodcastVideoGeneratedImageRatio = Math.max(
    0,
    Math.min(20, parseOptionalInteger(process.env.PODCAST_VIDEO_GENERATED_IMAGE_RATIO) ?? 4),
);
const allowedPodcastVideoRenderModes = new Set(['waveform-card', 'static-card', 'storyboard']);
const requestedPodcastVideoRenderMode = String(process.env.PODCAST_VIDEO_RENDER_MODE || '').trim().toLowerCase();
const normalizedPodcastVideoRenderMode = allowedPodcastVideoRenderModes.has(requestedPodcastVideoRenderMode)
    ? requestedPodcastVideoRenderMode
    : 'waveform-card';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const configuredAllowedOrigins = parseOptionalStringList(
    process.env.KIMIBUILT_ALLOWED_ORIGINS
    || process.env.CORS_ALLOWED_ORIGINS
    || '',
);

const config = {
    // Server
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv,

    // OpenAI-compatible gateway for chat/tool use and frontend image generation
    openai: {
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiMode: process.env.OPENAI_API_MODE || 'auto',
        model: process.env.OPENAI_MODEL || 'gpt-5.5',
        reasoningEffort: process.env.OPENAI_REASONING_EFFORT || '',
        requestTimeoutMs: Math.max(
            1000,
            parseInt(process.env.OPENAI_REQUEST_TIMEOUT_MS, 10) || 900000,
        ),
        toolRequestTimeoutMs: Math.max(
            1000,
            parseInt(process.env.OPENAI_TOOL_REQUEST_TIMEOUT_MS, 10)
                || parseInt(process.env.OPENAI_REQUEST_TIMEOUT_MS, 10)
                || 900000,
        ),
        imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
        imageAllowOfficialFallback: process.env.OPENAI_IMAGE_ALLOW_OFFICIAL_FALLBACK === 'true',
        imageBatchConcurrency: Math.min(Math.max(parseOptionalInteger(process.env.OPENAI_IMAGE_BATCH_CONCURRENCY) || 4, 1), 5),
    },

    // Official OpenAI media endpoints for video generation and image fallback
    media: {
        apiKey: process.env.OPENAI_MEDIA_API_KEY || '',
        baseURL: process.env.OPENAI_MEDIA_BASE_URL || 'https://api.openai.com/v1',
        imageModel: process.env.OPENAI_MEDIA_IMAGE_MODEL || 'gpt-image-2',
        videoModel: process.env.OPENAI_MEDIA_VIDEO_MODEL || 'sora-2',
    },

    // Ollama - Embeddings
    ollama: {
        baseURL: process.env.OLLAMA_BASE_URL || 'http://ollama:11434',
        embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest',
        embedTimeoutMs: Math.max(
            1000,
            parseInt(process.env.OLLAMA_EMBED_TIMEOUT_MS, 10) || 30000,
        ),
    },

    // Qdrant - Vector Store
    qdrant: {
        url: process.env.QDRANT_URL || 'http://qdrant:6333',
        collection: process.env.QDRANT_COLLECTION || 'conversations',
        vectorSize: 768,
    },

    postgres: {
        url: process.env.POSTGRES_URL || process.env.DATABASE_URL || null,
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT, 10) || 5432,
        database: process.env.POSTGRES_DB || 'kimibuilt',
        user: process.env.POSTGRES_USER || 'kimibuilt',
        password: process.env.POSTGRES_PASSWORD || null,
        ssl: process.env.POSTGRES_SSL === 'true',
    },

    persistence: {
        dataDir: persistenceDataDir,
    },

    artifacts: {
        browserPath: process.env.ARTIFACT_BROWSER_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '',
        browserArgs: process.env.ARTIFACT_BROWSER_ARGS || '',
        pdfTimeoutMs: parseInt(process.env.ARTIFACT_PDF_TIMEOUT_MS, 10) || 15000,
        vectorizeMaxChunks: Math.max(
            1,
            parseInt(process.env.ARTIFACT_VECTORIZE_MAX_CHUNKS, 10) || 24,
        ),
    },

    tts: {
        provider: process.env.TTS_PROVIDER || 'kokoro',
        fallbackProvider: process.env.TTS_FALLBACK_PROVIDER || '',
        fallbackEnabled: process.env.TTS_FALLBACK_ENABLED !== 'false',
        realtime: {
            synthesisLanes: normalizedTtsRealtimeSynthesisLanes,
            synthesisLookahead: normalizedTtsRealtimeSynthesisLookahead,
            chunkTargetChars: normalizedTtsRealtimeChunkTargetChars,
            initialBufferChunks: normalizedTtsRealtimeInitialBufferChunks,
            initialBufferSeconds: parseOptionalFloat(process.env.TTS_REALTIME_INITIAL_BUFFER_SECONDS) ?? 2.2,
            initialBufferMaxWaitMs: Math.max(
                0,
                Math.min(2000, parseInt(process.env.TTS_REALTIME_INITIAL_BUFFER_MAX_WAIT_MS, 10) || 650),
            ),
            firstChunkMaxSentences: normalizedTtsRealtimeFirstChunkSentences,
            secondChunkMaxSentences: normalizedTtsRealtimeSecondChunkSentences,
            maxSentencesPerChunk: normalizedTtsRealtimeMaxSentencesPerChunk,
            primaryTimeoutMs: normalizedTtsRealtimePrimaryTimeoutMs,
            fallbackTimeoutMs: normalizedTtsRealtimeFallbackTimeoutMs,
            hedgeDelayMs: normalizedTtsRealtimeHedgeDelayMs,
            chunkStallMs: normalizedTtsRealtimeChunkStallMs,
            chunkPauseSeconds: parseOptionalFloat(process.env.TTS_REALTIME_CHUNK_PAUSE_SECONDS) ?? 0.08,
            trimEdgeSeconds: parseOptionalFloat(process.env.TTS_REALTIME_TRIM_EDGE_SECONDS) ?? 0.45,
            trimTailPaddingSeconds: parseOptionalFloat(process.env.TTS_REALTIME_TRIM_TAIL_PADDING_SECONDS) ?? 0.14,
            trimThreshold: parseOptionalFloat(process.env.TTS_REALTIME_TRIM_THRESHOLD) ?? 0.0015,
            skipStalledChunks: process.env.TTS_REALTIME_SKIP_STALLED_CHUNKS === 'true',
            emergencyProvider: process.env.TTS_REALTIME_EMERGENCY_PROVIDER || 'kokoro',
        },
        kokoro: {
            enabled: process.env.KOKORO_TTS_ENABLED !== 'false',
            baseURL: String(process.env.KOKORO_TTS_BASE_URL || '').trim().replace(/\/+$/, ''),
            modelId: process.env.KOKORO_TTS_MODEL_ID || 'onnx-community/Kokoro-82M-v1.0-ONNX',
            device: process.env.KOKORO_TTS_DEVICE || 'cpu',
            dtype: process.env.KOKORO_TTS_DTYPE || 'q8',
            cacheDir: resolveConfigPath(process.env.KOKORO_TTS_CACHE_DIR || ''),
            localModelPath: resolveConfigPath(process.env.KOKORO_TTS_LOCAL_MODEL_PATH || ''),
            allowRemoteModels: parseOptionalBoolean(process.env.KOKORO_TTS_ALLOW_REMOTE_MODELS),
            voicesPath: configuredKokoroVoices.voicesPath,
            voices: configuredKokoroVoices.voices,
            voiceId: kokoroVoiceDefaults.id,
            defaultVoiceId: process.env.KOKORO_TTS_DEFAULT_VOICE_ID
                || configuredKokoroVoices.voices.find((voice) => voice.id === 'af_heart')?.id
                || configuredKokoroVoices.voices[0]?.id
                || kokoroVoiceDefaults.id,
            voiceLabel: kokoroVoiceDefaults.label,
            voiceDescription: kokoroVoiceDefaults.description,
            speed: parseOptionalFloat(process.env.KOKORO_TTS_SPEED) ?? 1,
            maxTextChars: normalizedKokoroMaxTextChars,
            timeoutMs: normalizedKokoroTimeoutMs,
            podcastTimeoutMs: normalizedKokoroPodcastTimeoutMs,
            podcastChunkChars: normalizedKokoroPodcastChunkChars,
            synthesisConcurrency: normalizedKokoroSynthesisConcurrency,
            g2p: {
                enabled: process.env.KOKORO_G2P_ENABLED !== 'false',
                required: process.env.KOKORO_G2P_REQUIRED === 'true',
                command: process.env.KOKORO_G2P_COMMAND || '',
                scriptPath: resolveConfigPath(process.env.KOKORO_G2P_SCRIPT_PATH || ''),
                timeoutMs: Math.max(
                    250,
                    Math.min(15000, parseInt(process.env.KOKORO_G2P_TIMEOUT_MS, 10) || 3000),
                ),
            },
            workerIsolation: process.env.KOKORO_TTS_WORKER_ISOLATION || 'process',
            httpRetryAttempts: Math.max(
                1,
                Math.min(4, parseInt(process.env.KOKORO_TTS_HTTP_RETRY_ATTEMPTS, 10) || 2),
            ),
            httpRetryDelayMs: Math.max(
                0,
                Math.min(2000, parseInt(process.env.KOKORO_TTS_HTTP_RETRY_DELAY_MS, 10) || 160),
            ),
            httpConnectionClose: process.env.KOKORO_TTS_HTTP_CONNECTION_CLOSE !== 'false',
        },
        piper: {
            enabled: process.env.PIPER_TTS_ENABLED !== 'false',
            binaryPath: resolveConfigPath(process.env.PIPER_TTS_BINARY_PATH || resolveBundledPiperBinaryPath() || 'piper'),
            voicesPath: configuredPiperVoices.voicesPath,
            voices: configuredPiperVoices.voices,
            modelPath: resolveConfigPath(process.env.PIPER_TTS_MODEL_PATH || ''),
            configPath: resolveConfigPath(process.env.PIPER_TTS_CONFIG_PATH || ''),
            voiceId: piperVoiceDefaults.id,
            defaultVoiceId: process.env.PIPER_TTS_DEFAULT_VOICE_ID
                || configuredPiperVoices.voices.find((voice) => voice.id === 'hfc-female-rich')?.id
                || configuredPiperVoices.voices[0]?.id
                || piperVoiceDefaults.id,
            voiceLabel: piperVoiceDefaults.label,
            voiceDescription: piperVoiceDefaults.description,
            speakerId: parseOptionalInteger(process.env.PIPER_TTS_SPEAKER_ID),
            lengthScale: parseOptionalFloat(process.env.PIPER_TTS_LENGTH_SCALE) ?? 1.02,
            noiseScale: parseOptionalFloat(process.env.PIPER_TTS_NOISE_SCALE) ?? 0.38,
            noiseW: parseOptionalFloat(process.env.PIPER_TTS_NOISE_W) ?? 0.68,
            sentenceSilence: parseOptionalFloat(process.env.PIPER_TTS_SENTENCE_SILENCE) ?? 0.24,
            maxTextChars: normalizedPiperMaxTextChars,
            timeoutMs: normalizedPiperTimeoutMs,
            podcastTimeoutMs: normalizedPiperPodcastTimeoutMs,
            podcastChunkChars: normalizedPiperPodcastChunkChars,
        },
    },

    audio: {
        apiKey: configuredAudioProviders[0]?.apiKey || '',
        baseURL: configuredAudioProviders[0]?.baseURL || 'https://api.openai.com/v1',
        providerCandidates: configuredAudioProviders,
        transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
        fallbackModels: parseOptionalStringList(process.env.OPENAI_TRANSCRIPTION_FALLBACK_MODELS),
        maxUploadBytes: Math.max(
            1024 * 1024,
            parseInt(process.env.OPENAI_TRANSCRIPTION_MAX_UPLOAD_BYTES, 10) || (25 * 1024 * 1024),
        ),
    },

    audioProcessing: {
        enabled: process.env.AUDIO_PROCESSING_ENABLED !== 'false',
        ffmpegBinaryPath: resolveConfigPath(process.env.FFMPEG_BINARY_PATH || 'ffmpeg'),
        timeoutMs: Math.max(
            1000,
            parseInt(process.env.AUDIO_PROCESSING_TIMEOUT_MS, 10) || 90000,
        ),
        mp3BitrateKbps: Math.max(
            64,
            parseInt(process.env.PODCAST_MP3_BITRATE_KBPS, 10) || 192,
        ),
        podcastMasteringEnabled: process.env.PODCAST_MASTERING_ENABLED !== 'false',
        podcastMasteringLufs: parseOptionalFloat(process.env.PODCAST_MASTERING_LOUDNESS_LUFS) ?? -16,
        podcastMasteringTruePeakDb: parseOptionalFloat(process.env.PODCAST_MASTERING_TRUE_PEAK_DB) ?? -1.5,
        podcastIntroPath: resolveConfigPath(process.env.PODCAST_INTRO_PATH || ''),
        podcastOutroPath: resolveConfigPath(process.env.PODCAST_OUTRO_PATH || ''),
        podcastMusicBedPath: resolveConfigPath(process.env.PODCAST_MUSIC_BED_PATH || ''),
        podcastSpeechVolume: parseOptionalFloat(process.env.PODCAST_SPEECH_VOLUME) ?? 1,
        podcastMusicVolume: parseOptionalFloat(process.env.PODCAST_MUSIC_VOLUME) ?? 0.07,
        podcastIntroVolume: parseOptionalFloat(process.env.PODCAST_INTRO_VOLUME) ?? 1,
        podcastOutroVolume: parseOptionalFloat(process.env.PODCAST_OUTRO_VOLUME) ?? 1,
    },

    podcast: {
        scriptRequestTimeoutMs: Math.max(
            30000,
            parseInt(process.env.PODCAST_SCRIPT_REQUEST_TIMEOUT_MS, 10) || (5 * 60 * 1000),
        ),
        scriptRetryAttempts: Math.max(
            0,
            parseInt(process.env.PODCAST_SCRIPT_RETRY_ATTEMPTS, 10) || 1,
        ),
        researchConcurrency: normalizedPodcastResearchConcurrency,
        ttsConcurrency: normalizedPodcastTtsConcurrency,
        toolTimeoutMs: normalizedPodcastToolTimeoutMs,
    },

    podcastVideo: {
        segmentTimeoutMs: normalizedPodcastVideoSegmentTimeoutMs,
        muxTimeoutMs: normalizedPodcastVideoMuxTimeoutMs,
        maxFfmpegTimeoutMs: normalizedPodcastVideoMaxFfmpegTimeoutMs,
        x264Preset: normalizedPodcastVideoX264Preset,
        x264Crf: normalizedPodcastVideoX264Crf,
        x264Profile: 'main',
        x264Level: '4.1',
        codecTag: 'avc1',
        renderMode: normalizedPodcastVideoRenderMode,
        defaultSceneCount: normalizedPodcastVideoDefaultSceneCount,
        generatedImageRatio: normalizedPodcastVideoGeneratedImageRatio,
        audioRepairEnabled: process.env.PODCAST_VIDEO_AUDIO_REPAIR_ENABLED === 'true',
        visualEffectsEnabled: process.env.PODCAST_VIDEO_VISUAL_EFFECTS_ENABLED !== 'false',
    },

    auth: {
        username: process.env.LILLYBUILT_AUTH_USERNAME || process.env.KIMIBUILT_AUTH_USERNAME || '',
        password: process.env.LILLYBUILT_AUTH_PASSWORD || process.env.KIMIBUILT_AUTH_PASSWORD || '',
        jwtSecret: process.env.LILLYBUILT_JWT_SECRET || process.env.KIMIBUILT_JWT_SECRET || '',
        cookieName: process.env.LILLYBUILT_AUTH_COOKIE || 'lillybuilt_auth',
        tokenTtlSeconds: parseInt(process.env.LILLYBUILT_AUTH_TTL_SECONDS || process.env.KIMIBUILT_AUTH_TTL_SECONDS, 10) || (12 * 60 * 60),
    },

    security: {
        authRequired: parseOptionalBoolean(process.env.KIMIBUILT_AUTH_REQUIRED) ?? isProduction,
        allowedOrigins: configuredAllowedOrigins.length > 0
            ? configuredAllowedOrigins
            : (isProduction ? [] : [
                'http://localhost:3000',
                'http://localhost:8080',
                'http://127.0.0.1:3000',
                'http://127.0.0.1:8080',
            ]),
        allowQueryTokens: parseOptionalBoolean(process.env.KIMIBUILT_ALLOW_QUERY_TOKENS) ?? !isProduction,
        rateLimitWindowMs: parseIntegerWithDefault(
            process.env.KIMIBUILT_RATE_LIMIT_WINDOW_MS,
            60 * 1000,
            { min: 1000 },
        ),
        rateLimitMax: parseIntegerWithDefault(
            process.env.KIMIBUILT_RATE_LIMIT_MAX,
            120,
            { min: 1 },
        ),
        loginRateLimitMax: parseIntegerWithDefault(
            process.env.KIMIBUILT_LOGIN_RATE_LIMIT_MAX,
            10,
            { min: 1 },
        ),
        toolRateLimitMax: parseIntegerWithDefault(
            process.env.KIMIBUILT_TOOL_RATE_LIMIT_MAX,
            30,
            { min: 1 },
        ),
    },

    search: {
        provider: process.env.SEARCH_PROVIDER || 'perplexity',
        perplexityApiKey: process.env.PERPLEXITY_API_KEY || '',
        perplexityBaseURL: process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai',
        defaultLimit: Math.max(
            1,
            parseInt(process.env.WEB_SEARCH_DEFAULT_LIMIT, 10) || 12,
        ),
        maxLimit: Math.max(
            8,
            parseInt(process.env.WEB_SEARCH_MAX_LIMIT, 10) || 20,
        ),
        defaultMaxTokens: Math.max(
            10000,
            parseInt(process.env.WEB_SEARCH_DEFAULT_MAX_TOKENS, 10)
                || parseInt(process.env.PERPLEXITY_SEARCH_MAX_TOKENS, 10)
                || 50000,
        ),
        defaultMaxTokensPerPage: Math.max(
            1024,
            parseInt(process.env.WEB_SEARCH_DEFAULT_MAX_TOKENS_PER_PAGE, 10)
                || parseInt(process.env.PERPLEXITY_SEARCH_MAX_TOKENS_PER_PAGE, 10)
                || 4096,
        ),
        defaultMaxOutputTokens: Math.max(
            1200,
            parseInt(process.env.WEB_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS, 10)
                || parseInt(process.env.PERPLEXITY_MAX_OUTPUT_TOKENS, 10)
                || 3200,
        ),
    },

    scrape: {
        contentCharLimit: Math.max(
            500,
            parseInt(process.env.WEB_SCRAPE_CONTENT_CHAR_LIMIT, 10) || 24000,
        ),
        respectRobotsTxt: process.env.WEB_SCRAPE_RESPECT_ROBOTS_TXT !== 'false',
        robotsTimeoutMs: Math.max(
            1000,
            parseInt(process.env.WEB_SCRAPE_ROBOTS_TIMEOUT_MS, 10) || 8000,
        ),
    },

    memory: {
        sessionIsolationDefault: process.env.SESSION_ISOLATION_DEFAULT !== 'false',
        storeChunkChars: Math.max(
            500,
            parseInt(process.env.MEMORY_STORE_CHUNK_CHARS, 10) || 1200,
        ),
        storeMaxChunks: Math.max(
            1,
            parseInt(process.env.MEMORY_STORE_MAX_CHUNKS, 10) || 6,
        ),
        recentMessageWindow: Math.max(
            1,
            parseInt(process.env.MEMORY_RECENT_MESSAGE_WINDOW, 10) || 8,
        ),
        recentTranscriptLimit: Math.max(
            1,
            parseInt(process.env.MEMORY_RECENT_TRANSCRIPT_LIMIT, 10) || 8,
        ),
        recentMessageCharLimit: parseRecentMessageCharLimit(process.env.MEMORY_RECENT_MESSAGE_CHAR_LIMIT),
        recallTopK: Math.max(
            1,
            parseInt(process.env.MEMORY_RECALL_TOP_K, 10) || 12,
        ),
        recallScoreThreshold: Number.isFinite(parseFloat(process.env.MEMORY_RECALL_SCORE_THRESHOLD))
            ? parseFloat(process.env.MEMORY_RECALL_SCORE_THRESHOLD)
            : 0.7,
        researchRecallTopK: Math.max(
            1,
            parseInt(process.env.MEMORY_RESEARCH_RECALL_TOP_K, 10) || 16,
        ),
        researchRecallScoreThreshold: Number.isFinite(parseFloat(process.env.MEMORY_RESEARCH_RECALL_SCORE_THRESHOLD))
            ? parseFloat(process.env.MEMORY_RESEARCH_RECALL_SCORE_THRESHOLD)
            : 0.64,
        researchSearchLimit: Math.max(
            1,
            parseInt(process.env.WEB_RESEARCH_SEARCH_LIMIT, 10) || 16,
        ),
        researchFollowupPages: Math.max(
            1,
            parseInt(process.env.WEB_RESEARCH_FOLLOWUP_PAGES, 10) || 8,
        ),
        researchSourceExcerptChars: Math.max(
            500,
            parseInt(process.env.WEB_RESEARCH_SOURCE_EXCERPT_CHARS, 10) || 4000,
        ),
        toolResultCharLimit: Math.max(
            1000,
            parseInt(process.env.TOOL_RESULT_CHAR_LIMIT, 10) || 120000,
        ),
        debugTrace: process.env.MEMORY_DEBUG_TRACE === 'true',
    },

    deploy: {
        defaultRepositoryPath,
        defaultRepositoryUrl: process.env.KIMIBUILT_DEPLOY_REPO_URL || '',
        defaultTargetDirectory: process.env.KIMIBUILT_DEPLOY_TARGET_DIR || '',
        defaultManifestsPath: process.env.KIMIBUILT_DEPLOY_MANIFESTS_PATH || 'k8s',
        defaultNamespace: process.env.KIMIBUILT_DEPLOY_NAMESPACE || 'kimibuilt',
        defaultDeployment: process.env.KIMIBUILT_DEPLOY_DEPLOYMENT || 'backend',
        defaultContainer: process.env.KIMIBUILT_DEPLOY_CONTAINER || 'backend',
        defaultBranch: process.env.KIMIBUILT_DEPLOY_BRANCH || 'master',
        defaultPublicDomain: process.env.KIMIBUILT_DEPLOY_PUBLIC_DOMAIN || 'demoserver2.buzz',
        defaultIngressClassName: process.env.KIMIBUILT_DEPLOY_INGRESS_CLASS || 'traefik',
        defaultTlsClusterIssuer: process.env.KIMIBUILT_DEPLOY_TLS_CLUSTER_ISSUER || 'letsencrypt-prod',
    },

    gitea: {
        enabled: process.env.GITEA_ENABLED === 'true',
        baseURL: process.env.GITEA_BASE_URL || '',
        token: process.env.GITEA_TOKEN || '',
        webhookSecret: process.env.GITEA_WEBHOOK_SECRET || '',
        org: process.env.GITEA_ORG || 'agent-apps',
        registryHost: process.env.GITEA_REGISTRY_HOST || '',
        registryUsername: process.env.GITEA_REGISTRY_USERNAME || '',
        registryPassword: process.env.GITEA_REGISTRY_PASSWORD || process.env.GITEA_TOKEN || '',
    },

    gitlab: {
        enabled: process.env.GITLAB_ENABLED !== 'false',
        baseURL: process.env.GITLAB_BASE_URL || '',
        token: process.env.GITLAB_TOKEN || '',
        webhookSecret: process.env.GITLAB_WEBHOOK_SECRET || process.env.GITEA_WEBHOOK_SECRET || '',
        org: process.env.GITLAB_GROUP || process.env.GITLAB_ORG || 'agent-apps',
        registryHost: process.env.GITLAB_REGISTRY_HOST || 'registry.gitlab.demoserver2.buzz',
        registryUsername: process.env.GITLAB_REGISTRY_USERNAME || '',
        registryPassword: process.env.GITLAB_REGISTRY_PASSWORD || process.env.GITLAB_TOKEN || '',
        runnerToken: process.env.GITLAB_RUNNER_TOKEN || '',
    },

    managedApps: {
        enabled: process.env.MANAGED_APPS_ENABLED !== 'false',
        deployTarget: process.env.MANAGED_APPS_DEPLOY_TARGET || 'runner',
        appBaseDomain: process.env.MANAGED_APPS_BASE_DOMAIN || 'demoserver2.buzz',
        namespacePrefix: process.env.MANAGED_APPS_NAMESPACE_PREFIX || 'app-',
        platformNamespace: process.env.MANAGED_APPS_PLATFORM_NAMESPACE || 'agent-platform',
        platformRuntimeSecretName: process.env.MANAGED_APPS_PLATFORM_RUNTIME_SECRET || 'agent-platform-runtime',
        defaultBranch: process.env.MANAGED_APPS_DEFAULT_BRANCH || 'main',
        defaultContainerPort: Math.max(
            1,
            parseInt(process.env.MANAGED_APPS_DEFAULT_CONTAINER_PORT, 10) || 80,
        ),
        registryPullSecretName: process.env.MANAGED_APPS_REGISTRY_PULL_SECRET || 'gitlab-registry-credentials',
        webhookEndpointPath: process.env.MANAGED_APPS_BUILD_EVENTS_PATH || '/api/integrations/gitlab/build-events',
        httpsVerifyTimeoutMs: Math.max(
            1000,
            parseInt(process.env.MANAGED_APPS_HTTPS_VERIFY_TIMEOUT_MS, 10) || 15000,
        ),
    },

    remoteRunner: {
        enabled: process.env.KIMIBUILT_REMOTE_RUNNER_ENABLED !== 'false',
        token: process.env.KIMIBUILT_REMOTE_RUNNER_TOKEN || '',
        preferred: process.env.KIMIBUILT_REMOTE_RUNNER_PREFERRED !== 'false',
        staleAfterMs: Math.max(
            5000,
            parseInt(process.env.KIMIBUILT_REMOTE_RUNNER_STALE_AFTER_MS, 10) || 45000,
        ),
        jobTimeoutMs: Math.max(
            1000,
            parseInt(process.env.KIMIBUILT_REMOTE_RUNNER_JOB_TIMEOUT_MS, 10) || 120000,
        ),
        maxOutputChars: Math.max(
            1000,
            parseInt(process.env.KIMIBUILT_REMOTE_RUNNER_MAX_OUTPUT_CHARS, 10) || 120000,
        ),
    },

    remoteCliMcp: {
        enabled: process.env.REMOTE_CLI_MCP_ENABLED !== 'false',
        transport: process.env.REMOTE_CLI_AGENT_TRANSPORT
            || process.env.REMOTE_CLI_TRANSPORT
            || 'mcp',
        url: process.env.REMOTE_CLI_MCP_URL || (
            process.env.GATEWAY_URL
                ? `${String(process.env.GATEWAY_URL).replace(/\/+$/, '')}/mcp`
                : ''
        ),
        codexAgentBaseUrl: process.env.REMOTE_CLI_CODEX_AGENT_BASE_URL
            || process.env.CODEX_AGENT_BASE_URL
            || process.env.SYMPHONY_CODEX_AGENT_BASE_URL
            || process.env.KIMIBUILT_CODEX_AGENT_BASE_URL
            || process.env.GATEWAY_URL
            || '',
        codexAgentApiKey: process.env.REMOTE_CLI_CODEX_AGENT_BEARER_TOKEN
            || process.env.REMOTE_CLI_CODEX_AGENT_API_KEY
            || process.env.CODEX_AGENT_API_KEY
            || process.env.FRONTEND_API_KEY
            || process.env.KIMIBUILT_FRONTEND_API_KEY
            || process.env.REMOTE_CLI_MCP_BEARER_TOKEN
            || process.env.N8N_API_KEY
            || '',
        codexAgentWorkspacePath: process.env.REMOTE_CLI_CODEX_AGENT_WORKSPACE_PATH
            || process.env.CODEX_AGENT_WORKSPACE_PATH
            || '',
        codexAgentApprovalPolicy: process.env.REMOTE_CLI_CODEX_AGENT_APPROVAL_POLICY || 'never',
        codexAgentThreadSandbox: process.env.REMOTE_CLI_CODEX_AGENT_THREAD_SANDBOX || 'workspace-write',
        codexAgentAdminThreadSandbox: process.env.REMOTE_CLI_CODEX_AGENT_ADMIN_THREAD_SANDBOX
            || process.env.REMOTE_CLI_CODEX_AGENT_THREAD_SANDBOX
            || 'workspace-write',
        codexAgentReasoningEffort: process.env.REMOTE_CLI_CODEX_AGENT_REASONING_EFFORT || '',
        codexAgentStallTimeoutMs: Math.max(
            1000,
            Math.min(parseInt(process.env.REMOTE_CLI_CODEX_AGENT_STALL_TIMEOUT_MS, 10) || 300000, 3600000),
        ),
        name: process.env.REMOTE_CLI_MCP_NAME || 'remote-cli',
        apiKey: process.env.REMOTE_CLI_MCP_BEARER_TOKEN
            || process.env.N8N_API_KEY
            || '',
        timeoutMs: Math.max(
            1000,
            parseInt(process.env.REMOTE_CLI_MCP_TIMEOUT_MS, 10) || 60000,
        ),
        defaultTargetId: process.env.REMOTE_CLI_DEFAULT_TARGET_ID || 'prod',
        defaultCwd: process.env.REMOTE_CLI_DEFAULT_CWD
            || process.env.OPENCODE_REMOTE_DEFAULT_WORKSPACE
            || process.env.KIMIBUILT_DEPLOY_TARGET_DIR
            || '',
        agentModel: process.env.REMOTE_CLI_AGENT_MODEL || 'gpt-5.4',
        remoteCodeModel: process.env.REMOTE_CLI_REMOTE_CODE_MODEL || process.env.REMOTE_CODE_MODEL || '',
        directRun: process.env.REMOTE_CLI_AGENT_DIRECT_RUN !== 'false',
        agentApiKey: process.env.REMOTE_CLI_AGENT_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
        agentBaseURL: process.env.REMOTE_CLI_AGENT_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        agentApiMode: process.env.REMOTE_CLI_AGENT_OPENAI_API_MODE || process.env.OPENAI_API_MODE || 'auto',
        maxTurns: Math.max(
            1,
            Math.min(parseInt(process.env.REMOTE_CLI_AGENT_MAX_TURNS, 10) || 20, 80),
        ),
        agentRunTimeoutMs: Math.max(
            1000,
            Math.min(parseInt(process.env.REMOTE_CLI_AGENT_RUN_TIMEOUT_MS, 10) || 180000, 900000),
        ),
        maxStatusPolls: Math.max(
            1,
            Math.min(parseInt(process.env.REMOTE_CLI_AGENT_MAX_STATUS_POLLS, 10) || 20, 80),
        ),
        statusPollIntervalMs: Math.max(
            0,
            Math.min(parseInt(process.env.REMOTE_CLI_AGENT_STATUS_POLL_INTERVAL_MS, 10) || 2000, 30000),
        ),
    },

    kubernetes: {
        enabled: process.env.KUBERNETES_IN_CLUSTER_ENABLED !== 'false',
        serviceHost: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
        servicePort: parseInt(process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || '443', 10) || 443,
        tokenPath: resolveConfigPath(process.env.KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH || '/var/run/secrets/kubernetes.io/serviceaccount/token'),
        caPath: resolveConfigPath(process.env.KUBERNETES_SERVICE_ACCOUNT_CA_PATH || '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
        namespacePath: resolveConfigPath(process.env.KUBERNETES_SERVICE_ACCOUNT_NAMESPACE_PATH || '/var/run/secrets/kubernetes.io/serviceaccount/namespace'),
        verifyTls: process.env.KUBERNETES_VERIFY_TLS !== 'false',
    },

    opencode: {
        enabled: process.env.OPENCODE_ENABLED !== 'false',
        binaryPath: process.env.OPENCODE_BINARY_PATH || 'opencode',
        defaultAgent: process.env.OPENCODE_DEFAULT_AGENT || 'build',
        defaultModel: process.env.OPENCODE_DEFAULT_MODEL || '',
        gatewayApiKey: process.env.OPENCODE_GATEWAY_API_KEY || '',
        allowedWorkspaceRoots: process.env.OPENCODE_ALLOWED_WORKSPACE_ROOTS
            ? String(process.env.OPENCODE_ALLOWED_WORKSPACE_ROOTS)
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
                .map((value) => path.resolve(value))
            : [defaultRepositoryPath],
        remoteDefaultWorkspace: process.env.OPENCODE_REMOTE_DEFAULT_WORKSPACE || '',
        providerEnvAllowlist: String(process.env.OPENCODE_PROVIDER_ENV_ALLOWLIST || [
            'OPENAI_API_KEY',
            'OPENAI_BASE_URL',
            'OPENAI_MODEL',
            'GITHUB_TOKEN',
            'GH_TOKEN',
            'GITLAB_TOKEN',
            'GITLAB_BASE_URL',
            'GITLAB_GROUP',
            'GITLAB_ORG',
            'GITLAB_USERNAME',
            'GITLAB_REGISTRY_HOST',
            'GITLAB_REGISTRY_USERNAME',
            'GITLAB_REGISTRY_PASSWORD',
            'GITLAB_RUNNER_TOKEN',
            'GITEA_TOKEN',
            'GITEA_BASE_URL',
            'GITEA_ORG',
            'GITEA_USERNAME',
            'GITEA_REGISTRY_HOST',
            'GITEA_REGISTRY_USERNAME',
            'GITEA_REGISTRY_PASSWORD',
            'ANTHROPIC_API_KEY',
            'GOOGLE_API_KEY',
            'OPENROUTER_API_KEY',
            'XAI_API_KEY',
            'AZURE_OPENAI_API_KEY',
            'AZURE_OPENAI_ENDPOINT',
            'AWS_ACCESS_KEY_ID',
            'AWS_SECRET_ACCESS_KEY',
            'AWS_REGION',
        ].join(','))
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        remoteAutoInstall: process.env.OPENCODE_REMOTE_AUTO_INSTALL === 'true',
    },

    runtime: {
        judgmentV2Enabled: process.env.RUNTIME_JUDGMENT_V2_ENABLED === 'true',
        plannerModel: process.env.OPENAI_PLANNER_MODEL || '',
        synthesisModel: process.env.OPENAI_SYNTHESIS_MODEL || '',
        repairModel: process.env.OPENAI_REPAIR_MODEL || '',
        plannerReasoningEffort: process.env.OPENAI_PLANNER_REASONING_EFFORT || '',
        synthesisReasoningEffort: process.env.OPENAI_SYNTHESIS_REASONING_EFFORT || '',
        repairReasoningEffort: process.env.OPENAI_REPAIR_REASONING_EFFORT || '',
        remoteBuildAutonomyDefault: process.env.REMOTE_BUILD_AUTONOMY_DEFAULT !== 'false',
        remoteBuildMaxAutonomousRounds: Math.max(
            1,
            parseInt(process.env.REMOTE_BUILD_MAX_AUTONOMOUS_ROUNDS, 10) || 20,
        ),
        remoteBuildMaxAutonomousToolCalls: Math.max(
            1,
            parseInt(process.env.REMOTE_BUILD_MAX_AUTONOMOUS_TOOL_CALLS, 10) || 80,
        ),
        remoteBuildMaxAutonomousMs: Math.max(
            1000,
            parseInt(process.env.REMOTE_BUILD_MAX_AUTONOMOUS_MS, 10) || 600000,
        ),
        remoteBuildContinuationCheckpointEnabled: process.env.REMOTE_BUILD_CONTINUATION_CHECKPOINT_ENABLED === 'true',
        remoteBuildConfigDefaultSingleRoundStop: process.env.REMOTE_BUILD_CONFIG_DEFAULT_SINGLE_ROUND_STOP === 'true',
        remoteBuildGenericFallbackSingleUseStop: process.env.REMOTE_BUILD_GENERIC_FALLBACK_SINGLE_USE_STOP !== 'false',
        foregroundProgressPersistIntervalMs: Math.max(
            250,
            parseInt(process.env.FOREGROUND_PROGRESS_PERSIST_INTERVAL_MS, 10) || 1000,
        ),
        remoteBuildBudgetExtensionMaxUses: Math.max(
            0,
            parseInt(process.env.REMOTE_BUILD_BUDGET_EXTENSION_MAX_USES, 10) || 6,
        ),
        remoteBuildBudgetExtensionRounds: Math.max(
            0,
            parseInt(process.env.REMOTE_BUILD_BUDGET_EXTENSION_ROUNDS, 10) || 8,
        ),
        remoteBuildBudgetExtensionToolCalls: Math.max(
            0,
            parseInt(process.env.REMOTE_BUILD_BUDGET_EXTENSION_TOOL_CALLS, 10) || 32,
        ),
        remoteBuildBudgetExtensionMs: Math.max(
            0,
            parseInt(process.env.REMOTE_BUILD_BUDGET_EXTENSION_MS, 10) || 180000,
        ),
    },
};

function validate() {
    const errors = [];
    if (!config.openai.apiKey) {
        errors.push('OPENAI_API_KEY is required');
    }
    const authConfigCount = [
        config.auth.username,
        config.auth.password,
        config.auth.jwtSecret,
    ].filter(Boolean).length;

    if (config.security.authRequired && authConfigCount < 3) {
        errors.push('KIMIBUILT auth is required: set username, password, and JWT secret env vars');
    }

    if (errors.length > 0) {
        throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
    }

    if (authConfigCount > 0 && authConfigCount < 3) {
        console.warn('[Config] Partial auth configuration detected. Auth is disabled until username, password, and jwt secret are all set.');
    }
}

// Preserve the nested export used in app code while also exposing top-level
// config sections for older tests and callers that require('./config').runtime.
module.exports = {
    ...config,
    config,
    validate,
};

const DEFAULT_TTS_CACHE_LIMIT = 24;
const DEFAULT_BROWSER_VOICE_ID = 'browser:default';
const DEFAULT_PIPER_CHUNK_TARGET_CHARS = 760;
const DEFAULT_REALTIME_CHUNK_TARGET_CHARS = 180;
const DEFAULT_TTS_MAX_TEXT_CHARS = 2400;
const DEFAULT_PIPER_FIRST_CHUNK_SENTENCES = 1;
const DEFAULT_PIPER_SECOND_CHUNK_SENTENCES = 1;
const DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK = 3;
const DEFAULT_PIPER_SYNTHESIS_LOOKAHEAD = 4;
const DEFAULT_TTS_SYNTHESIS_LANES = 3;
const DEFAULT_REALTIME_SYNTHESIS_LANES = 6;
const DEFAULT_REALTIME_SYNTHESIS_LOOKAHEAD = 10;
const DEFAULT_TTS_INITIAL_BUFFER_CHUNKS = 1;
const DEFAULT_TTS_INITIAL_BUFFER_SECONDS = 1.4;
const DEFAULT_TTS_INITIAL_BUFFER_MAX_WAIT_MS = 450;
const DEFAULT_TTS_PLAYBACK_SCHEDULE_LEAD_SECONDS = 0.03;
const DEFAULT_REALTIME_PRIMARY_TIMEOUT_MS = 60000;
const DEFAULT_REALTIME_FALLBACK_TIMEOUT_MS = 60000;
const DEFAULT_REALTIME_HEDGE_DELAY_MS = 900;
const DEFAULT_REALTIME_CHUNK_STALL_MS = 2500;
const DEFAULT_REALTIME_CHUNK_PAUSE_SECONDS = 0.08;
const DEFAULT_REALTIME_TRIM_EDGE_SECONDS = 0.45;
const DEFAULT_REALTIME_TRIM_TAIL_PADDING_SECONDS = 0.14;
const DEFAULT_REALTIME_TRIM_THRESHOLD = 0.0015;
const DEFAULT_REALTIME_EMERGENCY_PROVIDER = 'kokoro';
const DEFAULT_TTS_FETCH_TIMEOUT_PADDING_MS = 3500;

function getTtsProviderLabel(provider = '') {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (normalizedProvider === 'browser') {
        return 'Browser voice';
    }
    if (normalizedProvider === 'kokoro') {
        return 'Kokoro';
    }
    if (normalizedProvider === 'piper') {
        return 'Piper';
    }
    return 'Voice';
}

function parsePolicyBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return fallback;
}

function normalizeRealtimeEmergencyProvider(value = '', primaryProvider = 'kokoro', policy = {}) {
    const normalizedPrimary = String(primaryProvider || 'kokoro').trim().toLowerCase() || 'kokoro';
    const normalizedProvider = String(value || DEFAULT_REALTIME_EMERGENCY_PROVIDER).trim().toLowerCase();
    if (!normalizedProvider || normalizedProvider === normalizedPrimary) {
        return '';
    }

    const allowLowQualityFallback = parsePolicyBoolean(
        policy.allowEmergencyProviderFallback ?? policy.allowLowQualityFallback,
        false,
    );
    if (normalizedProvider === 'piper' && !allowLowQualityFallback) {
        return '';
    }

    return normalizedProvider;
}

function normalizeSpeechSentence(line = '') {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
        return '';
    }

    if (/[.!?]$/.test(trimmed)) {
        return trimmed;
    }

    if (/[:;]$/.test(trimmed)) {
        return `${trimmed.slice(0, -1)}.`;
    }

    return `${trimmed}.`;
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    const effective = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, effective));
}

function stripHtmlForSpeech(input = '') {
    return String(input || '').replace(/<[^>]+>/g, ' ');
}

function trimUrlPunctuation(value = '') {
    const url = String(value || '');
    const trailing = url.match(/[),.;:!?]+$/)?.[0] || '';
    return {
        body: trailing ? url.slice(0, -trailing.length) : url,
        trailing,
    };
}

function normalizeUrlForSpeech(url = '') {
    const { body } = trimUrlPunctuation(url);
    if (!body) {
        return '';
    }

    const parseTarget = /^https?:\/\//i.test(body) ? body : `https://${body.replace(/^www\./i, '')}`;
    let host = '';
    let path = '';

    try {
        const parsed = new URL(parseTarget);
        host = String(parsed.hostname || '').replace(/^www\./i, '');
        path = String(parsed.pathname || '').replace(/\/+$/g, '');
    } catch (_error) {
        const withoutProtocol = body.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
        const [rawHost, ...rest] = withoutProtocol.split('/');
        host = rawHost;
        path = rest.length ? `/${rest.join('/')}` : '';
    }

    const hostSpeech = host
        .split('.')
        .map((part) => part.replace(/[-_]+/g, ' ').trim())
        .filter(Boolean)
        .join(' dot ');
    const decodeUrlPart = (part = '') => {
        try {
            return decodeURIComponent(part);
        } catch (_error) {
            return part;
        }
    };
    const pathSpeech = path
        ? path
            .split('/')
            .map((part) => decodeUrlPart(part).replace(/[-_]+/g, ' ').replace(/[?#].*$/g, '').trim())
            .filter(Boolean)
            .map((part) => `slash ${part}`)
            .join(' ')
        : '';

    return [hostSpeech, pathSpeech].filter(Boolean).join(' ').trim() || body;
}

function normalizeUrlsForSpeech(input = '') {
    const urlPattern = /\b(?:https?:\/\/|www\.)[^\s<>)\]]+/gi;
    const domainPattern = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|ai|dev|app|edu|gov|ca|co|us|uk|help|buzz|cloud|site|online|xyz|info|biz)(?:\/[^\s<>)\]]*)?/gi;
    const protectedUrls = [];

    const withUrlPlaceholders = String(input || '').replace(urlPattern, (match) => {
        const index = protectedUrls.push(normalizeUrlForSpeech(match)) - 1;
        return ` KIMIBUILT_URL_${index}_ `;
    });

    return withUrlPlaceholders
        .replace(domainPattern, (match) => normalizeUrlForSpeech(match))
        .replace(/KIMIBUILT_URL_(\d+)_/g, (_match, index) => protectedUrls[Number(index)] || '');
}

function stripMarkdownForSpeech(input = '') {
    const markdown = String(input || '')
        .replace(/\0/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/```[\s\S]*?```/g, '\nCode example omitted.\n')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/\|/g, ' ')
        .replace(/^\s*[-=]{3,}\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n');

    return normalizeUrlsForSpeech(stripHtmlForSpeech(markdown));
}

function normalizeTextForSpeech(input = '') {
    return normalizeSpeechSections(input)
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function normalizeSpeechSections(input = '') {
    return stripMarkdownForSpeech(input)
        .replace(/[ \t\f\v]+/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(normalizeSpeechSentence)
        .filter(Boolean);
}

function splitWordsIntoSpeechChunks(text = '', maxChars = DEFAULT_TTS_MAX_TEXT_CHARS) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        return [];
    }

    const chunks = [];
    let currentChunk = '';
    const words = normalizedText.split(/\s+/).filter(Boolean);

    words.forEach((word) => {
        const nextChunk = currentChunk ? `${currentChunk} ${word}` : word;
        if (nextChunk.length <= maxChars) {
            currentChunk = nextChunk;
            return;
        }

        if (currentChunk) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
        }

        if (word.length <= maxChars) {
            currentChunk = word;
            return;
        }

        for (let index = 0; index < word.length; index += maxChars) {
            chunks.push(word.slice(index, index + maxChars).trim());
        }
    });

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks.filter(Boolean);
}

function splitSpeechChunkByClauses(text = '', maxChars = DEFAULT_TTS_MAX_TEXT_CHARS) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        return [];
    }

    if (normalizedText.length <= maxChars) {
        return [normalizedText];
    }

    const clauses = (normalizedText.match(/[^,;:]+(?:[,;:]+|$)/g) || [normalizedText])
        .map((clause) => String(clause || '').trim())
        .filter(Boolean);

    if (clauses.length <= 1) {
        return splitWordsIntoSpeechChunks(normalizedText, maxChars);
    }

    const chunks = [];
    let currentChunk = '';

    clauses.forEach((clause) => {
        const nextChunk = currentChunk ? `${currentChunk} ${clause}` : clause;
        if (nextChunk.length <= maxChars) {
            currentChunk = nextChunk;
            return;
        }

        if (currentChunk) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
        }

        if (clause.length <= maxChars) {
            currentChunk = clause;
            return;
        }

        splitWordsIntoSpeechChunks(clause, maxChars).forEach((chunk) => chunks.push(chunk));
    });

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks.filter(Boolean);
}

function splitPreparedSpeechChunk(text = '', options = {}) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        return [];
    }

    const absoluteMaxChars = Math.max(60, Number(options.absoluteMaxChars) || DEFAULT_TTS_MAX_TEXT_CHARS);
    const targetChunkChars = Math.max(
        60,
        Math.min(
            absoluteMaxChars,
            Number(options.targetChunkChars) || DEFAULT_PIPER_CHUNK_TARGET_CHARS,
        ),
    );

    return splitSpeechChunkByClauses(normalizedText, targetChunkChars)
        .flatMap((chunk) => splitWordsIntoSpeechChunks(chunk, absoluteMaxChars))
        .filter(Boolean);
}

function groupSpeechSentencesIntoChunks(sentences = [], options = {}) {
    const normalizedSentences = Array.isArray(sentences)
        ? sentences.map((sentence) => String(sentence || '').trim()).filter(Boolean)
        : [];

    if (normalizedSentences.length === 0) {
        return [];
    }

    const targetChunkChars = Math.max(
        60,
        Math.min(
            Math.max(60, Number(options.absoluteMaxChars) || DEFAULT_TTS_MAX_TEXT_CHARS),
            Number(options.targetChunkChars) || DEFAULT_PIPER_CHUNK_TARGET_CHARS,
        ),
    );
    const firstChunkMaxSentences = Math.max(
        1,
        Math.min(
            6,
            Number(options.firstChunkMaxSentences) || DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
        ),
    );
    const secondChunkMaxSentences = Math.max(
        1,
        Math.min(
            6,
            Number(options.secondChunkMaxSentences) || DEFAULT_PIPER_SECOND_CHUNK_SENTENCES,
        ),
    );
    const maxSentencesPerChunk = Math.max(
        Math.max(firstChunkMaxSentences, secondChunkMaxSentences),
        Math.min(
            8,
            Number(options.maxSentencesPerChunk) || DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
        ),
    );

    const groupedChunks = [];
    let currentSentences = [];
    let currentLength = 0;

    const flushCurrentChunk = () => {
        if (currentSentences.length === 0) {
            return;
        }
        groupedChunks.push(currentSentences.join(' '));
        currentSentences = [];
        currentLength = 0;
    };

    normalizedSentences.forEach((sentence) => {
        const currentChunkIndex = groupedChunks.length;
        const currentChunkSentenceLimit = currentChunkIndex === 0
            ? firstChunkMaxSentences
            : (currentChunkIndex === 1 ? secondChunkMaxSentences : maxSentencesPerChunk);
        const nextLength = currentSentences.length === 0
            ? sentence.length
            : currentLength + 1 + sentence.length;

        if (
            currentSentences.length > 0
            && (
                currentSentences.length >= currentChunkSentenceLimit
                || nextLength > targetChunkChars
            )
        ) {
            flushCurrentChunk();
        }

        currentSentences.push(sentence);
        currentLength = currentSentences.length === 1
            ? sentence.length
            : currentLength + 1 + sentence.length;

        const updatedChunkIndex = groupedChunks.length;
        const updatedChunkSentenceLimit = updatedChunkIndex === 0
            ? firstChunkMaxSentences
            : (updatedChunkIndex === 1 ? secondChunkMaxSentences : maxSentencesPerChunk);
        if (
            currentSentences.length >= updatedChunkSentenceLimit
            || currentLength >= targetChunkChars
        ) {
            flushCurrentChunk();
        }
    });

    flushCurrentChunk();
    return groupedChunks;
}

function splitTextIntoSpeechChunks(input = '', options = {}) {
    const sections = normalizeSpeechSections(input);
    if (sections.length === 0) {
        return [];
    }

    const absoluteMaxChars = Math.max(60, Number(options.absoluteMaxChars) || DEFAULT_TTS_MAX_TEXT_CHARS);
    const targetChunkChars = Math.max(
        60,
        Math.min(
            absoluteMaxChars,
            Number(options.targetChunkChars) || DEFAULT_PIPER_CHUNK_TARGET_CHARS,
        ),
    );

    const sectionChunks = sections.flatMap((section) => {
        const sentences = (section.match(/[^.!?]+(?:[.!?]+|$)/g) || [section])
            .map((sentence) => String(sentence || '').trim())
            .filter(Boolean);

        return groupSpeechSentencesIntoChunks(sentences, {
            absoluteMaxChars,
            targetChunkChars,
            firstChunkMaxSentences: Number(options.firstChunkMaxSentences) || DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
            secondChunkMaxSentences: Number(options.secondChunkMaxSentences) || DEFAULT_PIPER_SECOND_CHUNK_SENTENCES,
            maxSentencesPerChunk: Number(options.maxSentencesPerChunk) || DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
        });
    });

    return sectionChunks.flatMap((chunk) => (
        splitPreparedSpeechChunk(chunk, {
            absoluteMaxChars,
            targetChunkChars,
        })
    )).filter(Boolean);
}

class WebChatTtsManager extends EventTarget {
    constructor() {
        super();
        this.storageKeys = {
            autoPlay: 'kimibuilt_tts_autoplay',
            voiceId: 'kimibuilt_tts_voice_id',
        };
        this.available = false;
        this.provider = 'kokoro';
        this.voices = [];
        this.diagnostics = {
            status: 'unavailable',
            binaryReachable: false,
            voicesLoaded: false,
            message: 'Voice playback is unavailable.',
        };
        this.selectedVoiceId = this.storageGet(this.storageKeys.voiceId) || '';
        this.autoPlay = this.parseBoolean(this.storageGet(this.storageKeys.autoPlay), false);
        this.loadingMessageId = '';
        this.currentMessageId = '';
        this.currentAudio = null;
        this.currentSourceNode = null;
        this.currentGainNode = null;
        this.currentUtterance = null;
        this.currentPlaybackWaiter = null;
        this.cachedAudioBlobs = new Map();
        this.activePlaybackNodes = new Set();
        this.audioContext = null;
        this.pendingConfigPromise = null;
        this.maxTextChars = DEFAULT_TTS_MAX_TEXT_CHARS;
        this.realtimePolicy = this.normalizeRealtimePolicy();
        this.playbackToken = 0;
        this.browserSpeechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
        this.handleBrowserVoicesChanged = this.handleBrowserVoicesChanged.bind(this);

        if (this.browserSpeechSupported && typeof window.speechSynthesis?.addEventListener === 'function') {
            window.speechSynthesis.addEventListener('voiceschanged', this.handleBrowserVoicesChanged);
        }
    }

    parseBoolean(value, fallback = false) {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (!normalized) {
            return fallback;
        }

        if (['1', 'true', 'yes', 'on'].includes(normalized)) {
            return true;
        }

        if (['0', 'false', 'no', 'off'].includes(normalized)) {
            return false;
        }

        return fallback;
    }

    normalizeRealtimePolicy(policy = {}) {
        const maxTextChars = Math.max(120, Number(this.maxTextChars) || DEFAULT_TTS_MAX_TEXT_CHARS);
        const synthesisLanes = clampNumber(
            policy.synthesisLanes,
            DEFAULT_REALTIME_SYNTHESIS_LANES,
            1,
            8,
        );
        const synthesisLookahead = Math.max(
            synthesisLanes,
            clampNumber(policy.synthesisLookahead, DEFAULT_REALTIME_SYNTHESIS_LOOKAHEAD, 1, 12),
        );
        const firstChunkMaxSentences = clampNumber(policy.firstChunkMaxSentences, 1, 1, 3);
        const secondChunkMaxSentences = clampNumber(policy.secondChunkMaxSentences, 1, 1, 3);

        return {
            synthesisLanes,
            synthesisLookahead,
            chunkTargetChars: clampNumber(
                policy.chunkTargetChars,
                DEFAULT_REALTIME_CHUNK_TARGET_CHARS,
                60,
                maxTextChars,
            ),
            initialBufferChunks: clampNumber(
                policy.initialBufferChunks,
                DEFAULT_TTS_INITIAL_BUFFER_CHUNKS,
                1,
                4,
            ),
            initialBufferSeconds: clampNumber(
                policy.initialBufferSeconds,
                DEFAULT_TTS_INITIAL_BUFFER_SECONDS,
                0,
                8,
            ),
            initialBufferMaxWaitMs: clampNumber(
                policy.initialBufferMaxWaitMs,
                DEFAULT_TTS_INITIAL_BUFFER_MAX_WAIT_MS,
                0,
                2000,
            ),
            firstChunkMaxSentences,
            secondChunkMaxSentences,
            maxSentencesPerChunk: Math.max(
                secondChunkMaxSentences,
                clampNumber(policy.maxSentencesPerChunk, DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK, 1, 4),
            ),
            primaryTimeoutMs: clampNumber(
                policy.primaryTimeoutMs,
                DEFAULT_REALTIME_PRIMARY_TIMEOUT_MS,
                2000,
                60000,
            ),
            fallbackTimeoutMs: clampNumber(
                policy.fallbackTimeoutMs,
                DEFAULT_REALTIME_FALLBACK_TIMEOUT_MS,
                2000,
                60000,
            ),
            hedgeDelayMs: clampNumber(
                policy.hedgeDelayMs,
                DEFAULT_REALTIME_HEDGE_DELAY_MS,
                250,
                5000,
            ),
            chunkStallMs: clampNumber(
                policy.chunkStallMs,
                DEFAULT_REALTIME_CHUNK_STALL_MS,
                350,
                5000,
            ),
            chunkPauseSeconds: clampNumber(
                policy.chunkPauseSeconds,
                DEFAULT_REALTIME_CHUNK_PAUSE_SECONDS,
                0,
                0.5,
            ),
            trimEdgeSeconds: clampNumber(
                policy.trimEdgeSeconds,
                DEFAULT_REALTIME_TRIM_EDGE_SECONDS,
                0,
                0.8,
            ),
            trimTailPaddingSeconds: clampNumber(
                policy.trimTailPaddingSeconds,
                DEFAULT_REALTIME_TRIM_TAIL_PADDING_SECONDS,
                0.04,
                0.3,
            ),
            trimThreshold: clampNumber(
                policy.trimThreshold,
                DEFAULT_REALTIME_TRIM_THRESHOLD,
                0,
                0.08,
            ),
            skipStalledChunks: parsePolicyBoolean(
                policy.skipStalledChunks ?? policy.allowChunkSkipping,
                false,
            ),
            allowContentSkipping: parsePolicyBoolean(
                policy.allowContentSkipping,
                false,
            ),
            emergencyProvider: normalizeRealtimeEmergencyProvider(
                policy.emergencyProvider,
                policy.primaryProvider || this.getProvider?.() || this.provider || 'kokoro',
                policy,
            ),
        };
    }

    storageGet(key) {
        if (typeof window === 'undefined') {
            return null;
        }

        if (window.sessionManager?.safeStorageGet) {
            return window.sessionManager.safeStorageGet(key);
        }
        window.__webChatStorageAvailable = false;
        return null;
    }

    storageSet(key, value) {
        if (typeof window === 'undefined') {
            return false;
        }

        if (window.sessionManager?.safeStorageSet) {
            return window.sessionManager.safeStorageSet(key, value);
        }
        window.__webChatStorageAvailable = false;
        return false;
    }

    createCustomEvent(eventName, detail = {}) {
        if (typeof CustomEvent === 'function') {
            return new CustomEvent(eventName, {
                detail,
            });
        }

        const event = new Event(eventName);
        event.detail = detail;
        return event;
    }

    emitStateChange(eventName = 'statechange') {
        this.dispatchEvent(this.createCustomEvent(eventName, this.getState()));
    }

    emitPlaybackEvent(eventName = '', detail = {}) {
        if (!eventName) {
            return;
        }

        this.dispatchEvent(this.createCustomEvent(eventName, {
            messageId: String(detail.messageId || '').trim(),
            chunkText: String(detail.chunkText || '').trim(),
            chunkIndex: Number.isFinite(Number(detail.chunkIndex)) ? Number(detail.chunkIndex) : -1,
            chunkCount: Number.isFinite(Number(detail.chunkCount)) ? Number(detail.chunkCount) : 0,
            playbackToken: Number(detail.playbackToken) || 0,
        }));
    }

    getState() {
        return {
            available: this.available,
            provider: this.getProvider(),
            voices: this.getVoices(),
            diagnostics: this.getDiagnostics(),
            selectedVoiceId: this.getSelectedVoiceId(),
            autoPlay: this.isAutoPlayEnabled(),
            loadingMessageId: this.loadingMessageId,
            currentMessageId: this.currentMessageId,
        };
    }

    getVoices() {
        return Array.isArray(this.voices)
            ? this.voices.map((voice) => ({ ...voice }))
            : [];
    }

    getDiagnostics() {
        return {
            ...this.diagnostics,
        };
    }

    resolveVoiceProvider(voiceId = '') {
        const normalizedVoiceId = String(voiceId || '').trim();
        if (!normalizedVoiceId) {
            return '';
        }

        return String(
            this.voices.find((voice) => voice.id === normalizedVoiceId)?.provider || '',
        ).trim().toLowerCase();
    }

    getFallbackVoiceId() {
        if (!this.voices.length) {
            return this.provider === 'browser' ? DEFAULT_BROWSER_VOICE_ID : '';
        }

        return this.voices[0]?.id || (this.provider === 'browser' ? DEFAULT_BROWSER_VOICE_ID : '');
    }

    getProvider() {
        const selectedVoiceProvider = this.resolveVoiceProvider(this.getSelectedVoiceId());
        return selectedVoiceProvider || String(this.provider || 'kokoro').trim() || 'kokoro';
    }

    getProviderLabel() {
        return getTtsProviderLabel(this.getProvider());
    }

    getStatus() {
        return String(this.diagnostics?.status || '').trim() || (this.isAvailable() ? 'ready' : 'unavailable');
    }

    isAvailable() {
        if (this.provider === 'browser') {
            return this.available === true;
        }

        return this.available === true && this.voices.length > 0;
    }

    isAutoPlayEnabled() {
        return this.autoPlay === true;
    }

    setAutoPlayEnabled(value) {
        this.autoPlay = value === true;
        this.storageSet(this.storageKeys.autoPlay, this.autoPlay ? 'true' : 'false');
        this.emitStateChange('configchange');
    }

    setSelectedVoiceId(voiceId = '') {
        const requestedVoiceId = String(voiceId || '').trim();
        const matchingVoice = this.voices.find((voice) => voice.id === requestedVoiceId);
        const fallbackVoiceId = this.getFallbackVoiceId();
        const nextVoiceId = matchingVoice?.id || fallbackVoiceId;

        if (this.selectedVoiceId === nextVoiceId) {
            return;
        }

        this.selectedVoiceId = nextVoiceId;
        if (this.selectedVoiceId) {
            this.storageSet(this.storageKeys.voiceId, this.selectedVoiceId);
        }
        this.stop();
        this.emitStateChange('configchange');
    }

    refreshFromStorage() {
        this.autoPlay = this.parseBoolean(this.storageGet(this.storageKeys.autoPlay), false);

        const requestedVoiceId = String(
            this.storageGet(this.storageKeys.voiceId)
            || this.selectedVoiceId
            || '',
        ).trim();

        if (!this.voices.length) {
            this.selectedVoiceId = requestedVoiceId;
            this.emitStateChange('configchange');
            return;
        }

        const matchingVoice = this.voices.find((voice) => voice.id === requestedVoiceId);
        this.selectedVoiceId = matchingVoice?.id || this.getFallbackVoiceId();
        this.emitStateChange('configchange');
    }

    getSelectedVoiceId() {
        if (!this.voices.length) {
            return this.provider === 'browser' ? DEFAULT_BROWSER_VOICE_ID : '';
        }

        const requestedId = String(this.selectedVoiceId || '').trim();
        const matchingVoice = this.voices.find((voice) => voice.id === requestedId);
        return matchingVoice?.id || this.getFallbackVoiceId();
    }

    getSelectedVoice() {
        const voiceId = this.getSelectedVoiceId();
        return this.voices.find((voice) => voice.id === voiceId) || null;
    }

    getVoiceLabel() {
        if (this.getSelectedVoice()?.label) {
            return this.getSelectedVoice().label;
        }

        if (this.getProvider() === 'browser') {
            return 'System voice';
        }

        const providerLabel = getTtsProviderLabel(this.getProvider());
        return providerLabel === 'Voice' ? 'Voice' : `${providerLabel} voice`;
    }

    isLoadingMessage(messageId = '') {
        return Boolean(messageId) && this.loadingMessageId === String(messageId);
    }

    isPlayingMessage(messageId = '') {
        return Boolean(messageId) && this.currentMessageId === String(messageId);
    }

    getBrowserVoices() {
        if (!this.browserSpeechSupported || typeof window.speechSynthesis?.getVoices !== 'function') {
            return [{
                id: DEFAULT_BROWSER_VOICE_ID,
                label: 'System voice',
                description: 'Default browser speech synthesis voice.',
                provider: 'browser',
                voiceURI: '',
            }];
        }

        const voices = window.speechSynthesis.getVoices();
        if (!Array.isArray(voices) || voices.length === 0) {
            return [{
                id: DEFAULT_BROWSER_VOICE_ID,
                label: 'System voice',
                description: 'Default browser speech synthesis voice.',
                provider: 'browser',
                voiceURI: '',
            }];
        }

        return voices.map((voice) => ({
            id: `browser:${String(voice.voiceURI || voice.name || 'default').trim() || 'default'}`,
            label: String(voice.name || voice.voiceURI || 'System voice').trim() || 'System voice',
            description: [voice.lang, voice.default ? 'Default' : ''].filter(Boolean).join(' | '),
            provider: 'browser',
            voiceURI: String(voice.voiceURI || '').trim(),
        }));
    }

    resolveBrowserVoice(voiceId = '') {
        if (!this.browserSpeechSupported || typeof window.speechSynthesis?.getVoices !== 'function') {
            return null;
        }

        const normalizedVoiceId = String(voiceId || '').trim();
        const selectedVoice = this.voices.find((voice) => voice.id === normalizedVoiceId) || null;
        const selectedVoiceUri = String(selectedVoice?.voiceURI || '').trim();
        const voices = window.speechSynthesis.getVoices();

        if (!Array.isArray(voices) || voices.length === 0) {
            return null;
        }

        if (selectedVoiceUri) {
            return voices.find((voice) => String(voice.voiceURI || '').trim() === selectedVoiceUri) || null;
        }

        return voices.find((voice) => voice.default) || voices[0] || null;
    }

    useBrowserFallback(message = 'Browser speech synthesis is ready.') {
        this.provider = 'browser';
        this.available = this.browserSpeechSupported;
        this.voices = this.getBrowserVoices();
        this.diagnostics = {
            status: this.available ? 'ready' : 'unavailable',
            binaryReachable: this.available,
            voicesLoaded: this.voices.length > 0,
            message: this.available ? message : 'Browser speech synthesis is unavailable.',
        };

        const fallbackVoiceId = this.voices[0]?.id || DEFAULT_BROWSER_VOICE_ID;
        const requestedVoiceId = String(
            this.storageGet(this.storageKeys.voiceId)
            || this.selectedVoiceId
            || fallbackVoiceId,
        ).trim();
        const matchingVoice = this.voices.find((voice) => voice.id === requestedVoiceId);
        this.selectedVoiceId = matchingVoice?.id || fallbackVoiceId;
        this.storageSet(this.storageKeys.voiceId, this.selectedVoiceId);
    }

    handleBrowserVoicesChanged() {
        if (!this.browserSpeechSupported) {
            return;
        }

        if (this.provider !== 'browser') {
            return;
        }

        this.useBrowserFallback('Browser speech synthesis is ready.');
        this.emitStateChange('configchange');
    }

    async ensureConfigLoaded(options = {}) {
        if (this.pendingConfigPromise && options.force !== true) {
            return this.pendingConfigPromise;
        }

        this.pendingConfigPromise = this.loadConfig(options)
            .finally(() => {
                this.pendingConfigPromise = null;
            });

        return this.pendingConfigPromise;
    }

    async loadConfig(options = {}) {
        try {
            const manifest = await window.apiClient?.getTtsVoices?.();
            const manifestConfigured = manifest?.configured === true;
            const manifestProviders = Array.isArray(manifest?.providers) ? manifest.providers : [];
            const providerVoices = manifestProviders.flatMap((providerConfig) => (
                Array.isArray(providerConfig?.voices) ? providerConfig.voices : []
            ));
            const manifestVoices = Array.isArray(manifest?.voices) && manifest.voices.length > 0
                ? manifest.voices
                : providerVoices;
            this.maxTextChars = Math.max(
                120,
                Number(manifest?.maxTextChars) || DEFAULT_TTS_MAX_TEXT_CHARS,
            );
            const manifestProvider = String(manifest?.provider || 'kokoro').trim() || 'kokoro';
            this.realtimePolicy = this.normalizeRealtimePolicy({
                ...(manifest?.realtime || {}),
                primaryProvider: manifestProvider,
            });
            const manifestProviderLabel = getTtsProviderLabel(manifestProvider);
            const manifestUnavailableMessage = manifestProvider === 'browser'
                ? 'Browser voice playback is unavailable.'
                : `${manifestProviderLabel} voice playback is unavailable.`;
            const manifestDiagnostics = manifest?.diagnostics && typeof manifest.diagnostics === 'object'
                ? {
                    status: String(manifest.diagnostics.status || '').trim() || (manifestConfigured ? 'ready' : 'unavailable'),
                    binaryReachable: manifest.diagnostics.binaryReachable === true,
                    voicesLoaded: manifest.diagnostics.voicesLoaded === true,
                    message: String(manifest.diagnostics.message || '').trim()
                        || (manifestConfigured
                            ? `${manifestProviderLabel} is ready.`
                            : manifestUnavailableMessage),
                }
                : {
                    status: manifestConfigured ? 'ready' : 'unavailable',
                    binaryReachable: manifestConfigured,
                    voicesLoaded: manifestVoices.length > 0,
                    message: manifestConfigured
                        ? `${manifestProviderLabel} is ready.`
                        : manifestUnavailableMessage,
                };

            if (manifestConfigured && manifestVoices.length > 0) {
                this.available = true;
                this.provider = manifestProvider;
                const primaryVoices = manifestVoices.filter((voice) => {
                    const voiceProvider = String(voice?.provider || manifestProvider).trim().toLowerCase();
                    return voiceProvider === manifestProvider.toLowerCase();
                });
                this.voices = primaryVoices.length > 0 ? primaryVoices : manifestVoices;
                this.diagnostics = manifestDiagnostics;

                const manifestDefaultVoiceId = String(manifest?.defaultVoiceId || '').trim();
                const fallbackVoiceId = this.voices.some((voice) => voice.id === manifestDefaultVoiceId)
                    ? manifestDefaultVoiceId
                    : String(this.voices[0]?.id || '').trim();
                const requestedVoiceId = String(
                    this.storageGet(this.storageKeys.voiceId)
                    || this.selectedVoiceId
                    || fallbackVoiceId,
                ).trim();
                const matchingVoice = this.voices.find((voice) => voice.id === requestedVoiceId);
                this.selectedVoiceId = matchingVoice?.id || fallbackVoiceId;
                this.provider = this.resolveVoiceProvider(this.selectedVoiceId) || this.provider;

                if (this.selectedVoiceId) {
                    this.storageSet(this.storageKeys.voiceId, this.selectedVoiceId);
                }
            } else if (this.browserSpeechSupported) {
                this.useBrowserFallback(
                    manifestDiagnostics.status === 'misconfigured'
                        ? `${manifestDiagnostics.message} Using browser speech synthesis instead.`
                        : 'Browser speech synthesis is ready.',
                );
            } else {
                this.available = false;
                this.provider = manifest?.provider || 'kokoro';
                this.voices = manifestVoices;
                this.diagnostics = manifestDiagnostics;
            }

            if (!this.isAvailable() && options.quiet !== true) {
                this.stop();
            }
        } catch (_error) {
            if (this.browserSpeechSupported) {
                this.useBrowserFallback('Browser speech synthesis is ready.');
            } else {
                this.available = false;
                this.provider = 'kokoro';
                this.voices = [];
                this.selectedVoiceId = '';
                this.maxTextChars = DEFAULT_TTS_MAX_TEXT_CHARS;
                this.realtimePolicy = this.normalizeRealtimePolicy();
                this.diagnostics = {
                    status: 'unavailable',
                    binaryReachable: false,
                    voicesLoaded: false,
                    message: 'Voice playback is unavailable.',
                };
                this.stop();
            }
        }

        this.emitStateChange('configchange');
        return this.getState();
    }

    stop() {
        this.playbackToken += 1;
        this.resetPlaybackState();
    }

    resetPlaybackState() {
        const activeWaiter = this.currentPlaybackWaiter;
        this.currentPlaybackWaiter = null;
        if (activeWaiter?.resolve) {
            try {
                activeWaiter.resolve(false);
            } catch (_error) {
                // Ignore promise settlement failures during cleanup.
            }
        }

        Array.from(this.activePlaybackNodes).forEach((playbackNode) => {
            if (playbackNode.startTimer) {
                clearTimeout(playbackNode.startTimer);
            }
            playbackNode.resolveEnded?.(false);
            try {
                playbackNode.sourceNode.onended = null;
            } catch (_error) {
                // Ignore handler cleanup failures during reset.
            }
            try {
                playbackNode.sourceNode.stop();
            } catch (_error) {
                // Ignore Web Audio cleanup errors.
            }
            try {
                playbackNode.sourceNode.disconnect();
            } catch (_error) {
                // Ignore disconnect failures during cleanup.
            }
            try {
                playbackNode.gainNode.disconnect();
            } catch (_error) {
                // Ignore disconnect failures during cleanup.
            }
        });
        this.activePlaybackNodes.clear();

        if (this.currentAudio) {
            try {
                this.currentAudio.pause();
                this.currentAudio.currentTime = 0;
            } catch (_error) {
                // Ignore media cleanup errors.
            }
        }

        if (this.currentSourceNode) {
            try {
                this.currentSourceNode.onended = null;
                this.currentSourceNode.stop();
            } catch (_error) {
                // Ignore Web Audio cleanup errors.
            }
        }
        try {
            this.currentSourceNode?.disconnect?.();
        } catch (_error) {
            // Ignore disconnect failures during cleanup.
        }
        try {
            this.currentGainNode?.disconnect?.();
        } catch (_error) {
            // Ignore disconnect failures during cleanup.
        }

        if (this.browserSpeechSupported && window.speechSynthesis) {
            try {
                window.speechSynthesis.cancel();
            } catch (_error) {
                // Ignore synthesis cancellation errors.
            }
        }

        this.currentAudio = null;
        this.currentSourceNode = null;
        this.currentGainNode = null;
        this.currentUtterance = null;
        this.currentMessageId = '';
        this.loadingMessageId = '';
        this.emitPlaybackEvent('playbackstop', {
            playbackToken: this.playbackToken,
        });
        this.emitStateChange();
    }

    beginPlaybackRequest() {
        this.playbackToken += 1;
        this.resetPlaybackState();
        return this.playbackToken;
    }

    resolvePlaybackWaiter(result = true) {
        const activeWaiter = this.currentPlaybackWaiter;
        this.currentPlaybackWaiter = null;
        if (!activeWaiter?.resolve) {
            return;
        }

        try {
            activeWaiter.resolve(result);
        } catch (_error) {
            // Ignore promise settlement failures during cleanup.
        }
    }

    isPlaybackRequestActive(token) {
        return Number(token) > 0 && this.playbackToken === token;
    }

    cleanupAudio(audio) {
        if (this.currentAudio === audio) {
            this.currentAudio = null;
            this.currentMessageId = '';
        }

        this.loadingMessageId = '';
        this.emitStateChange();
    }

    cleanupAudioPlayback(sourceNode, options = {}) {
        if (this.currentSourceNode === sourceNode) {
            try {
                this.currentSourceNode.disconnect();
            } catch (_error) {
                // Ignore disconnect failures during cleanup.
            }
            try {
                this.currentGainNode?.disconnect?.();
            } catch (_error) {
                // Ignore disconnect failures during cleanup.
            }
            this.currentSourceNode = null;
            this.currentGainNode = null;
            if (options.preserveMessageId !== true) {
                this.currentMessageId = '';
            }
        }

        this.loadingMessageId = '';
        this.emitStateChange();
    }

    cleanupUtterance(utterance) {
        if (this.currentUtterance === utterance) {
            this.currentUtterance = null;
            this.currentMessageId = '';
        }

        this.loadingMessageId = '';
        this.emitStateChange();
    }

    hashText(value = '') {
        let hash = 0;
        const source = String(value || '');
        for (let index = 0; index < source.length; index += 1) {
            hash = ((hash << 5) - hash) + source.charCodeAt(index);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    buildCacheKey(_messageId = '', text = '', options = {}) {
        return [
            String(options.provider || this.getProvider() || '').trim() || this.getProvider(),
            this.getSelectedVoiceId(),
            this.hashText(text),
        ].join(':');
    }

    trimCache() {
        while (this.cachedAudioBlobs.size > DEFAULT_TTS_CACHE_LIMIT) {
            const oldest = this.cachedAudioBlobs.keys().next().value;
            this.cachedAudioBlobs.delete(oldest);
        }
    }

    getRealtimeChunkTimeoutMs(text = '', options = {}) {
        const policy = this.realtimePolicy || this.normalizeRealtimePolicy();
        const baseTimeoutMs = options.fallback === true
            ? policy.fallbackTimeoutMs
            : policy.primaryTimeoutMs;
        const textLength = String(text || '').trim().length;
        const lengthBudgetMs = Math.min(8000, Math.max(0, textLength - 120) * 18);
        return Math.round(baseTimeoutMs + lengthBudgetMs);
    }

    getRealtimeChunkFetchTimeoutMs(timeoutMs = 0) {
        return Math.max(
            10000,
            Math.round((Number(timeoutMs) || DEFAULT_REALTIME_PRIMARY_TIMEOUT_MS) + DEFAULT_TTS_FETCH_TIMEOUT_PADDING_MS),
        );
    }

    wait(ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
            timer?.unref?.();
        });
    }

    async synthesizeRealtimeChunkAudio(text, messageId = '', options = {}) {
        const policy = this.realtimePolicy || this.normalizeRealtimePolicy();
        const normalizedText = String(text || '').trim();
        const primaryProvider = String(options.provider || this.getProvider() || this.provider || 'kokoro').trim().toLowerCase() || 'kokoro';
        const emergencyProvider = normalizeRealtimeEmergencyProvider(
            policy.emergencyProvider,
            primaryProvider,
            policy,
        );
        const primaryTimeoutMs = this.getRealtimeChunkTimeoutMs(normalizedText, options);
        const primaryOptions = {
            ...options,
            timeoutMs: primaryTimeoutMs,
            fetchTimeoutMs: this.getRealtimeChunkFetchTimeoutMs(primaryTimeoutMs),
            // Browser realtime playback owns failover with a separate hedged request.
            // Keeping backend fallback off here prevents a lower-quality provider
            // from hiding the primary Kokoro result or surfacing as the main failure.
            allowProviderFallback: false,
        };
        let settled = false;
        let fallbackStarted = false;
        let primaryError = null;

        const primaryPromise = this.synthesizeAndPrepareMessageAudio(
            normalizedText,
            messageId,
            primaryOptions,
        ).catch((error) => {
            primaryError = error;
            throw error;
        });

        if (!emergencyProvider) {
            return primaryPromise;
        }

        const fallbackPromise = this.wait(policy.hedgeDelayMs).then(() => {
            if (settled) {
                return new Promise(() => {});
            }

            fallbackStarted = true;
            const fallbackTimeoutMs = this.getRealtimeChunkTimeoutMs(normalizedText, { ...options, fallback: true });
            return this.synthesizeAndPrepareMessageAudio(normalizedText, messageId, {
                ...options,
                provider: emergencyProvider,
                timeoutMs: fallbackTimeoutMs,
                fetchTimeoutMs: this.getRealtimeChunkFetchTimeoutMs(fallbackTimeoutMs),
                allowProviderFallback: false,
                showLoading: false,
            });
        });

        try {
            const result = await Promise.any([primaryPromise, fallbackPromise]);
            settled = true;
            return {
                ...result,
                realtimeFallbackAttempted: fallbackStarted,
                realtimePrimaryError: primaryError?.message || '',
            };
        } catch (error) {
            settled = true;
            if (error?.errors?.length) {
                throw error.errors[0];
            }
            throw error;
        }
    }

    ensureAudioContext() {
        if (this.audioContext) {
            return this.audioContext;
        }

        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            return null;
        }

        try {
            this.audioContext = new AudioContextCtor();
            return this.audioContext;
        } catch (_error) {
            this.audioContext = null;
            return null;
        }
    }

    buildPlaybackBlockedError(message = 'Audio playback is blocked until you interact with the page.') {
        const error = new Error(String(message || '').trim() || 'Audio playback is blocked until you interact with the page.');
        error.code = 'tts_playback_blocked';
        return error;
    }

    async preparePlayback(options = {}) {
        const context = this.ensureAudioContext();
        if (!context) {
            if (options.quiet === true) {
                return null;
            }

            throw new Error('Audio playback is unavailable in this browser.');
        }

        if (context.state === 'suspended') {
            try {
                await context.resume();
            } catch (_error) {
                if (options.quiet === true) {
                    return null;
                }

                throw this.buildPlaybackBlockedError();
            }
        }

        if (context.state !== 'running') {
            if (options.quiet === true) {
                return null;
            }

            throw this.buildPlaybackBlockedError();
        }

        return context;
    }

    async decodeAudioBlob(audioBlob, playbackContext = null) {
        if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
            throw new Error('No audio was returned for playback.');
        }

        const context = playbackContext || await this.preparePlayback();
        try {
            const arrayBuffer = await audioBlob.arrayBuffer();
            const decodedBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
            return {
                context,
                decodedBuffer,
            };
        } catch (_error) {
            throw new Error('The generated voice audio could not be decoded for playback.');
        }
    }

    async playDecodedAudioBuffer(decodedBuffer, messageId = '', options = {}) {
        if (!decodedBuffer || typeof decodedBuffer.duration !== 'number') {
            throw new Error('No audio was returned for playback.');
        }

        const context = options.playbackContext || await this.preparePlayback();
        if (this.currentAudio || this.currentSourceNode || this.currentUtterance) {
            this.resetPlaybackState();
        }

        const sourceNode = context.createBufferSource();
        const gainNode = context.createGain();
        gainNode.gain.value = 1;
        sourceNode.buffer = decodedBuffer;
        sourceNode.connect(gainNode);
        gainNode.connect(context.destination);

        this.currentSourceNode = sourceNode;
        this.currentGainNode = gainNode;
        this.currentMessageId = String(messageId || '').trim();
        this.loadingMessageId = '';
        this.emitStateChange();

        let resolvePlayback;
        let rejectPlayback;
        const playbackPromise = new Promise((resolve, reject) => {
            resolvePlayback = resolve;
            rejectPlayback = reject;
        });

        sourceNode.onended = () => {
            if (this.currentPlaybackWaiter?.sourceNode === sourceNode) {
                this.currentPlaybackWaiter = null;
            }
            this.cleanupAudioPlayback(sourceNode, {
                preserveMessageId: options.keepMessageActiveOnEnd === true,
            });
            resolvePlayback(true);
        };

        if (options.awaitEnd === true) {
            this.currentPlaybackWaiter = {
                sourceNode,
                resolve: resolvePlayback,
            };
        }

        try {
            sourceNode.start();
        } catch (error) {
            if (this.currentPlaybackWaiter?.sourceNode === sourceNode) {
                this.currentPlaybackWaiter = null;
            }
            this.cleanupAudioPlayback(sourceNode);
            rejectPlayback(error);
            throw error;
        }

        if (options.awaitEnd === true) {
            return playbackPromise;
        }

        playbackPromise.catch(() => null);
        return true;
    }

    async playAudioBlob(audioBlob, messageId = '', options = {}) {
        const { context, decodedBuffer } = await this.decodeAudioBlob(
            audioBlob,
            options.playbackContext || null,
        );
        return this.playDecodedAudioBuffer(decodedBuffer, messageId, {
            ...options,
            playbackContext: context,
        });
    }

    speakWithBrowserVoice({ messageId = '', text = '' } = {}) {
        if (!this.browserSpeechSupported || typeof window.SpeechSynthesisUtterance !== 'function') {
            throw new Error('Browser speech synthesis is unavailable.');
        }

        const normalizedText = String(text || '').trim();
        if (!normalizedText) {
            throw new Error('No text is available to read aloud.');
        }

        if (this.currentAudio || this.currentSourceNode || this.currentUtterance) {
            this.resetPlaybackState();
        }

        const utterance = new window.SpeechSynthesisUtterance(normalizedText);
        const browserVoice = this.resolveBrowserVoice(this.getSelectedVoiceId());
        if (browserVoice) {
            utterance.voice = browserVoice;
            if (browserVoice.lang) {
                utterance.lang = browserVoice.lang;
            }
        }

        utterance.onend = () => this.cleanupUtterance(utterance);
        utterance.onerror = () => this.cleanupUtterance(utterance);

        this.currentUtterance = utterance;
        this.currentMessageId = String(messageId || '').trim();
        this.loadingMessageId = '';
        this.emitStateChange();

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
        return true;
    }

    async synthesizeMessageAudio(text, messageId = '', options = {}) {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) {
            throw new Error('No text is available to read aloud.');
        }

        const cacheKey = this.buildCacheKey(messageId, normalizedText, options);
        const cachedAudioBlob = this.cachedAudioBlobs.get(cacheKey);
        if (cachedAudioBlob) {
            return {
                blob: cachedAudioBlob,
                cached: true,
            };
        }

        if (options.showLoading === true) {
            this.loadingMessageId = String(messageId || '').trim();
            if (options.resetCurrentMessage === true) {
                this.currentMessageId = '';
            }
            this.emitStateChange();
        }

        try {
            const result = await window.apiClient?.synthesizeSpeech?.(normalizedText, {
                voiceId: this.getSelectedVoiceId(),
                provider: options.provider || '',
                timeoutMs: options.timeoutMs,
                fetchTimeoutMs: options.fetchTimeoutMs,
                allowProviderFallback: options.allowProviderFallback,
            });
            if (!result?.blob) {
                throw new Error('Voice synthesis returned no audio.');
            }
            this.cachedAudioBlobs.set(cacheKey, result.blob);
            this.trimCache();
            return {
                ...result,
                cached: false,
            };
        } catch (error) {
            if (options.showLoading === true) {
                this.loadingMessageId = '';
                this.emitStateChange();
            }
            throw error;
        }
    }

    async synthesizeAndPrepareMessageAudio(text, messageId = '', options = {}) {
        const result = await this.synthesizeMessageAudio(text, messageId, options);
        const { context, decodedBuffer } = await this.decodeAudioBlob(
            result.blob,
            options.playbackContext || null,
        );
        const trimmedBuffer = this.trimDecodedAudioBuffer(decodedBuffer, context);
        return {
            ...result,
            decodedBuffer: trimmedBuffer || decodedBuffer,
            playbackContext: context,
        };
    }

    trimDecodedAudioBuffer(decodedBuffer = null, context = null) {
        const policy = this.realtimePolicy || this.normalizeRealtimePolicy();
        if (
            !decodedBuffer
            || !context
            || typeof context.createBuffer !== 'function'
            || typeof decodedBuffer.getChannelData !== 'function'
            || !Number.isFinite(Number(decodedBuffer.length))
            || !Number.isFinite(Number(decodedBuffer.sampleRate))
            || Number(decodedBuffer.length) <= 0
        ) {
            return decodedBuffer;
        }

        const channelCount = Math.max(1, Number(decodedBuffer.numberOfChannels) || 1);
        const sampleRate = Math.max(1, Number(decodedBuffer.sampleRate) || 1);
        const maxEdgeSamples = Math.max(0, Math.floor(sampleRate * (Number(policy.trimEdgeSeconds) || 0)));
        if (maxEdgeSamples <= 0) {
            return decodedBuffer;
        }

        const threshold = Math.max(0, Number(policy.trimThreshold) || DEFAULT_REALTIME_TRIM_THRESHOLD);
        const length = Math.max(0, Number(decodedBuffer.length) || 0);
        const isSilentSample = (sampleIndex) => {
            for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
                const data = decodedBuffer.getChannelData(channelIndex);
                if (Math.abs(Number(data[sampleIndex]) || 0) > threshold) {
                    return false;
                }
            }
            return true;
        };

        const startIndex = 0;
        const tailPaddingSamples = Math.max(
            1,
            Math.floor(sampleRate * (Number(policy.trimTailPaddingSeconds) || DEFAULT_REALTIME_TRIM_TAIL_PADDING_SECONDS)),
        );
        const minTrimSamples = Math.max(1, Math.floor(sampleRate * 0.08));
        let lastAudibleIndex = length - 1;
        while (lastAudibleIndex > 0 && isSilentSample(lastAudibleIndex)) {
            lastAudibleIndex -= 1;
        }

        const maxTrimStartIndex = Math.max(0, length - maxEdgeSamples);
        const paddedEndIndex = Math.min(length - 1, lastAudibleIndex + tailPaddingSamples);
        const endIndex = Math.max(maxTrimStartIndex, paddedEndIndex);
        if ((length - 1 - endIndex) < minTrimSamples) {
            return decodedBuffer;
        }

        const nextLength = Math.max(1, endIndex - startIndex + 1);
        if (startIndex <= 0 && nextLength >= length) {
            return decodedBuffer;
        }
        if (nextLength < Math.floor(sampleRate * 0.08)) {
            return decodedBuffer;
        }

        try {
            const outputBuffer = context.createBuffer(channelCount, nextLength, sampleRate);
            for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
                const source = decodedBuffer.getChannelData(channelIndex);
                const target = outputBuffer.getChannelData(channelIndex);
                target.set(source.subarray(startIndex, startIndex + nextLength));
            }
            return outputBuffer;
        } catch (_error) {
            return decodedBuffer;
        }
    }

    getPiperSpeechChunks(text = '') {
        const policy = this.realtimePolicy || this.normalizeRealtimePolicy();
        return splitTextIntoSpeechChunks(text, {
            absoluteMaxChars: this.maxTextChars,
            targetChunkChars: Math.min(
                this.maxTextChars,
                Number(policy.chunkTargetChars) || DEFAULT_PIPER_CHUNK_TARGET_CHARS,
            ),
            firstChunkMaxSentences: Number(policy.firstChunkMaxSentences) || DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
            secondChunkMaxSentences: Number(policy.secondChunkMaxSentences) || DEFAULT_PIPER_SECOND_CHUNK_SENTENCES,
            maxSentencesPerChunk: Number(policy.maxSentencesPerChunk) || DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
        });
    }

    scheduleDecodedAudioBuffer(decodedBuffer, messageId = '', options = {}) {
        if (!decodedBuffer || typeof decodedBuffer.duration !== 'number') {
            throw new Error('No audio was returned for playback.');
        }

        const context = options.playbackContext;
        if (!context) {
            throw new Error('Audio playback is unavailable in this browser.');
        }

        const sourceNode = context.createBufferSource();
        const gainNode = context.createGain();
        gainNode.gain.value = 1;
        sourceNode.buffer = decodedBuffer;
        sourceNode.connect(gainNode);
        gainNode.connect(context.destination);

        const scheduledStartTime = Math.max(
            context.currentTime + DEFAULT_TTS_PLAYBACK_SCHEDULE_LEAD_SECONDS,
            Number(options.scheduledStartTime) || 0,
        );
        const playbackNode = {
            sourceNode,
            gainNode,
            startTimer: null,
            resolveEnded: null,
        };
        const endedPromise = new Promise((resolve) => {
            playbackNode.resolveEnded = resolve;
        });
        this.activePlaybackNodes.add(playbackNode);
        this.currentSourceNode = sourceNode;
        this.currentGainNode = gainNode;
        this.currentMessageId = String(messageId || '').trim();
        this.loadingMessageId = '';
        this.emitStateChange();

        const playbackEventDetail = {
            messageId,
            chunkText: options.chunkText || '',
            chunkIndex: options.chunkIndex,
            chunkCount: options.chunkCount,
            playbackToken: options.playbackToken,
        };
        const startDelayMs = Math.max(0, Math.round((scheduledStartTime - context.currentTime) * 1000));
        playbackNode.startTimer = setTimeout(() => {
            playbackNode.startTimer = null;
            if (!this.activePlaybackNodes.has(playbackNode) || !this.isPlaybackRequestActive(options.playbackToken)) {
                return;
            }
            this.emitPlaybackEvent('chunkstart', playbackEventDetail);
        }, startDelayMs);
        playbackNode.startTimer?.unref?.();

        sourceNode.onended = () => {
            this.activePlaybackNodes.delete(playbackNode);
            if (playbackNode.startTimer) {
                clearTimeout(playbackNode.startTimer);
                playbackNode.startTimer = null;
            }
            try {
                sourceNode.disconnect();
            } catch (_error) {
                // Ignore disconnect failures during cleanup.
            }
            try {
                gainNode.disconnect();
            } catch (_error) {
                // Ignore disconnect failures during cleanup.
            }

            if (this.currentSourceNode === sourceNode) {
                this.currentSourceNode = null;
            }
            if (this.currentGainNode === gainNode) {
                this.currentGainNode = null;
            }

            if (!this.isPlaybackRequestActive(options.playbackToken)) {
                playbackNode.resolveEnded?.(false);
                return;
            }

            this.emitPlaybackEvent('chunkend', playbackEventDetail);
            playbackNode.resolveEnded?.(true);

            if (options.isFinalChunk === true) {
                this.loadingMessageId = '';
                this.currentMessageId = '';
                this.emitStateChange();
                this.resolvePlaybackWaiter(true);
            }
        };

        sourceNode.start(scheduledStartTime);

        return {
            playbackContext: context,
            startTime: scheduledStartTime,
            endTime: scheduledStartTime + decodedBuffer.duration,
            endedPromise,
        };
    }

    async speakPiperChunks({ messageId = '', text = '', playbackToken = 0, playbackContext = null } = {}) {
        const normalizedMessageId = String(messageId || '').trim();
        const chunks = this.getPiperSpeechChunks(text);
        if (chunks.length === 0) {
            throw new Error('No text is available to read aloud.');
        }

        const preparedChunkPromises = new Map();
        const preparingChunkIndexes = new Set();
        let activePlaybackContext = playbackContext;
        let nextChunkToPrepare = 0;
        let preparedWindowAnchor = 0;
        const policy = this.realtimePolicy || this.normalizeRealtimePolicy();
        const synthesisLookahead = Math.max(
            1,
            Number(policy.synthesisLookahead) || DEFAULT_PIPER_SYNTHESIS_LOOKAHEAD,
        );
        const synthesisLanes = Math.max(
            1,
            Number(policy.synthesisLanes) || DEFAULT_TTS_SYNTHESIS_LANES,
        );
        activePlaybackContext = activePlaybackContext || await this.preparePlayback();
        const bufferedChunkResults = new Map();

        const prepareChunk = (index) => {
            if (index < 0 || index >= chunks.length || preparedChunkPromises.has(index)) {
                return;
            }

            preparingChunkIndexes.add(index);
            const chunkPromise = this.synthesizeRealtimeChunkAudio(chunks[index], normalizedMessageId, {
                showLoading: index === 0,
                resetCurrentMessage: index === 0,
                playbackContext: activePlaybackContext,
                chunkIndex: index,
                chunkCount: chunks.length,
            }).then((result) => {
                bufferedChunkResults.set(index, result);
                return result;
            }).finally(() => {
                preparingChunkIndexes.delete(index);
                fillPreparedWindow(preparedWindowAnchor);
            });
            preparedChunkPromises.set(index, chunkPromise);
        };

        const fillPreparedWindow = (currentIndex) => {
            preparedWindowAnchor = Math.max(preparedWindowAnchor, Number(currentIndex) || 0);
            while (
                nextChunkToPrepare < chunks.length
                && nextChunkToPrepare <= (preparedWindowAnchor + synthesisLookahead)
                && preparingChunkIndexes.size < synthesisLanes
            ) {
                prepareChunk(nextChunkToPrepare);
                nextChunkToPrepare += 1;
            }
        };

        const waitForPreparedChunk = async (index, timeoutMs = 0) => {
            if (bufferedChunkResults.has(index)) {
                return {
                    timedOut: false,
                    result: bufferedChunkResults.get(index),
                };
            }

            const chunkPromise = preparedChunkPromises.get(index);
            if (!chunkPromise) {
                return {
                    timedOut: true,
                    result: null,
                };
            }

            if (!timeoutMs || timeoutMs <= 0) {
                const result = await chunkPromise;
                bufferedChunkResults.set(index, result);
                return {
                    timedOut: false,
                    result,
                };
            }

            return Promise.race([
                chunkPromise.then((result) => {
                    bufferedChunkResults.set(index, result);
                    return {
                        timedOut: false,
                        result,
                    };
                }),
                this.wait(timeoutMs).then(() => ({
                    timedOut: true,
                    result: null,
                })),
            ]);
        };

        const primeInitialPlaybackBuffer = async () => {
            const firstChunk = await waitForPreparedChunk(0);
            if (!firstChunk.result || !this.isPlaybackRequestActive(playbackToken)) {
                return;
            }

            const maxInitialChunks = Math.min(chunks.length, DEFAULT_TTS_INITIAL_BUFFER_CHUNKS);
            const policyInitialBufferChunks = Math.min(
                chunks.length,
                Number(policy.initialBufferChunks) || DEFAULT_TTS_INITIAL_BUFFER_CHUNKS,
            );
            const maxRealtimeInitialChunks = Math.max(maxInitialChunks, policyInitialBufferChunks);
            const deadline = Date.now() + (Number(policy.initialBufferMaxWaitMs) || DEFAULT_TTS_INITIAL_BUFFER_MAX_WAIT_MS);
            let bufferedDuration = Number(firstChunk.result.decodedBuffer?.duration) || 0;

            for (let index = 1; index < maxRealtimeInitialChunks; index += 1) {
                if (
                    bufferedChunkResults.size >= maxRealtimeInitialChunks
                    || bufferedDuration >= (Number(policy.initialBufferSeconds) || DEFAULT_TTS_INITIAL_BUFFER_SECONDS)
                    || !this.isPlaybackRequestActive(playbackToken)
                ) {
                    break;
                }

                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0) {
                    break;
                }

                const nextChunk = await waitForPreparedChunk(index, remainingMs);
                if (nextChunk.timedOut || !nextChunk.result) {
                    break;
                }

                bufferedDuration += Number(nextChunk.result.decodedBuffer?.duration) || 0;
                fillPreparedWindow(index + 1);
            }
        };

        prepareChunk(0);
        nextChunkToPrepare = 1;
        fillPreparedWindow(0);

        const playbackCompleted = new Promise((resolve) => {
            this.currentPlaybackWaiter = { resolve };
        });

        await primeInitialPlaybackBuffer();

        for (let index = 0; index < chunks.length; index += 1) {
            fillPreparedWindow(index);
            while (!bufferedChunkResults.has(index) && !preparedChunkPromises.has(index)) {
                if (!this.isPlaybackRequestActive(playbackToken)) {
                    return false;
                }
                await this.wait(10);
                fillPreparedWindow(index);
            }
            const laterChunkReady = Array.from(bufferedChunkResults.keys()).some((readyIndex) => readyIndex > index);
            const shouldSkipStalledChunk = policy.skipStalledChunks === true
                && policy.allowContentSkipping === true
                && laterChunkReady;
            const preparedChunk = shouldSkipStalledChunk
                ? await waitForPreparedChunk(index, Number(policy.chunkStallMs) || DEFAULT_REALTIME_CHUNK_STALL_MS)
                : await waitForPreparedChunk(index);
            if (preparedChunk.timedOut || !preparedChunk.result) {
                preparedChunkPromises.delete(index);
                bufferedChunkResults.delete(index);
                fillPreparedWindow(index + 1);
                continue;
            }
            preparedChunkPromises.delete(index);
            bufferedChunkResults.delete(index);
            const chunkResult = preparedChunk.result;
            if (!this.isPlaybackRequestActive(playbackToken)) {
                return false;
            }

            activePlaybackContext = chunkResult.playbackContext || activePlaybackContext || playbackContext;
            fillPreparedWindow(index + 1);
            const chunkPauseSeconds = Math.max(0, Number(policy.chunkPauseSeconds) || 0);

            const scheduledChunk = this.scheduleDecodedAudioBuffer(chunkResult.decodedBuffer, normalizedMessageId, {
                playbackContext: activePlaybackContext,
                scheduledStartTime: index > 0 && activePlaybackContext?.currentTime != null
                    ? Number(activePlaybackContext.currentTime) + chunkPauseSeconds
                    : 0,
                playbackToken,
                chunkText: chunks[index],
                chunkIndex: index,
                chunkCount: chunks.length,
                isFinalChunk: index === (chunks.length - 1),
            });
            if (scheduledChunk?.endedPromise) {
                const chunkFinished = await scheduledChunk.endedPromise;
                if (!chunkFinished || !this.isPlaybackRequestActive(playbackToken)) {
                    return false;
                }
            }
        }

        return playbackCompleted;
    }

    async speakMessage({ messageId = '', text = '' } = {}) {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) {
            throw new Error('No text is available to read aloud.');
        }

        await this.ensureConfigLoaded({ quiet: true });
        if (!this.isAvailable()) {
            throw new Error('Voice playback is not available right now.');
        }

        const normalizedMessageId = String(messageId || '').trim();
        const playbackToken = this.beginPlaybackRequest();
        if (this.provider === 'browser') {
            return this.speakWithBrowserVoice({
                messageId: normalizedMessageId,
                text: normalizedText,
            });
        }

        const playbackContext = await this.preparePlayback();

        try {
            return await this.speakPiperChunks({
                messageId: normalizedMessageId,
                text: normalizedText,
                playbackToken,
                playbackContext,
            });
        } catch (error) {
            if (this.isPlaybackRequestActive(playbackToken)) {
                this.stop();
            }
            throw error;
        }
    }

    async toggleMessagePlayback({ messageId = '', text = '' } = {}) {
        const normalizedMessageId = String(messageId || '').trim();
        if (this.isLoadingMessage(normalizedMessageId)) {
            return false;
        }

        if (this.isPlayingMessage(normalizedMessageId)) {
            this.stop();
            return false;
        }

        return this.speakMessage({
            messageId: normalizedMessageId,
            text,
        });
    }
}

if (typeof window !== 'undefined') {
    window.KimiBuiltRealtimeTts = {
        getTtsProviderLabel,
        normalizeSpeechSections,
        normalizeTextForSpeech,
        normalizeUrlForSpeech,
        normalizeUrlsForSpeech,
        splitTextIntoSpeechChunks,
    };
    window.KimiBuiltRealtimeTtsManager = WebChatTtsManager;
    window.WebChatTtsManager = WebChatTtsManager;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
        DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
        DEFAULT_REALTIME_SYNTHESIS_LANES,
        DEFAULT_TTS_SYNTHESIS_LANES,
        WebChatTtsManager,
        getTtsProviderLabel,
        groupSpeechSentencesIntoChunks,
        normalizeRealtimeEmergencyProvider,
        normalizeSpeechSections,
        normalizeTextForSpeech,
        normalizeUrlForSpeech,
        normalizeUrlsForSpeech,
        splitPreparedSpeechChunk,
        splitSpeechChunkByClauses,
        splitTextIntoSpeechChunks,
        splitWordsIntoSpeechChunks,
    };
}

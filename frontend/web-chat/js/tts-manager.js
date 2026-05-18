const DEFAULT_TTS_CACHE_LIMIT = 24;
const DEFAULT_BROWSER_VOICE_ID = 'browser:default';
const DEFAULT_PIPER_CHUNK_TARGET_CHARS = 520;
const DEFAULT_TTS_MAX_TEXT_CHARS = 2400;
const DEFAULT_PIPER_FIRST_CHUNK_SENTENCES = 1;
const DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK = 1;
const DEFAULT_PIPER_SYNTHESIS_LOOKAHEAD = 3;
const DEFAULT_TTS_PLAYBACK_SCHEDULE_LEAD_SECONDS = 0.03;

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

function stripHtmlForSpeech(input = '') {
    return String(input || '').replace(/<[^>]+>/g, ' ');
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

    return stripHtmlForSpeech(markdown);
}

function normalizeTextForSpeech(input = '') {
    return stripMarkdownForSpeech(input)
        .replace(/[ \t\f\v]+/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(normalizeSpeechSentence)
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
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

    const absoluteMaxChars = Math.max(120, Number(options.absoluteMaxChars) || DEFAULT_TTS_MAX_TEXT_CHARS);
    const targetChunkChars = Math.max(
        120,
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
        120,
        Math.min(
            Math.max(120, Number(options.absoluteMaxChars) || DEFAULT_TTS_MAX_TEXT_CHARS),
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
    const maxSentencesPerChunk = Math.max(
        firstChunkMaxSentences,
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
        const currentChunkIsFirst = groupedChunks.length === 0;
        const currentChunkSentenceLimit = currentChunkIsFirst
            ? firstChunkMaxSentences
            : maxSentencesPerChunk;
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

        const updatedChunkIsFirst = groupedChunks.length === 0;
        const updatedChunkSentenceLimit = updatedChunkIsFirst
            ? firstChunkMaxSentences
            : maxSentencesPerChunk;
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
    const normalizedText = normalizeTextForSpeech(input);
    if (!normalizedText) {
        return [];
    }

    const absoluteMaxChars = Math.max(120, Number(options.absoluteMaxChars) || DEFAULT_TTS_MAX_TEXT_CHARS);
    const targetChunkChars = Math.max(
        120,
        Math.min(
            absoluteMaxChars,
            Number(options.targetChunkChars) || DEFAULT_PIPER_CHUNK_TARGET_CHARS,
        ),
    );

    const sentences = (normalizedText.match(/[^.!?]+(?:[.!?]+|$)/g) || [normalizedText])
        .map((sentence) => String(sentence || '').trim())
        .filter(Boolean);

    return groupSpeechSentencesIntoChunks(sentences, {
        absoluteMaxChars,
        targetChunkChars,
        firstChunkMaxSentences: Number(options.firstChunkMaxSentences) || DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
        maxSentencesPerChunk: Number(options.maxSentencesPerChunk) || DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
    }).flatMap((chunk) => (
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
        this.provider = 'piper';
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

    emitStateChange(eventName = 'statechange') {
        this.dispatchEvent(new CustomEvent(eventName, {
            detail: this.getState(),
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
        return selectedVoiceProvider || String(this.provider || 'piper').trim() || 'piper';
    }

    getProviderLabel() {
        const provider = this.getProvider();
        if (provider === 'browser') {
            return 'Browser voice';
        }
        if (provider === 'piper') {
            return 'Piper';
        }
        return 'Voice';
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

        return 'Piper voice';
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
            const manifestProvider = String(manifest?.provider || 'piper').trim() || 'piper';
            const manifestProviderLabel = manifestProvider === 'browser' ? 'Browser voice' : 'Piper';
            const manifestUnavailableMessage = manifestProvider === 'browser'
                ? 'Browser voice playback is unavailable.'
                : 'Piper voice playback is unavailable.';
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
                this.provider = manifest?.provider || manifestVoices[0]?.provider || 'piper';
                this.voices = manifestVoices;
                this.diagnostics = manifestDiagnostics;

                const fallbackVoiceId = String(manifest?.defaultVoiceId || this.voices[0]?.id || '').trim();
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
                this.provider = manifest?.provider || 'piper';
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
                this.provider = 'piper';
                this.voices = [];
                this.selectedVoiceId = '';
                this.maxTextChars = DEFAULT_TTS_MAX_TEXT_CHARS;
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

    buildCacheKey(_messageId = '', text = '') {
        return [
            this.getProvider(),
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

        const cacheKey = this.buildCacheKey(messageId, normalizedText);
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
            });
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
        return {
            ...result,
            decodedBuffer,
            playbackContext: context,
        };
    }

    getPiperSpeechChunks(text = '') {
        return splitTextIntoSpeechChunks(text, {
            absoluteMaxChars: this.maxTextChars,
            targetChunkChars: Math.min(this.maxTextChars, DEFAULT_PIPER_CHUNK_TARGET_CHARS),
            firstChunkMaxSentences: DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
            maxSentencesPerChunk: DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
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
        };
        this.activePlaybackNodes.add(playbackNode);
        this.currentSourceNode = sourceNode;
        this.currentGainNode = gainNode;
        this.currentMessageId = String(messageId || '').trim();
        this.loadingMessageId = '';
        this.emitStateChange();

        sourceNode.onended = () => {
            this.activePlaybackNodes.delete(playbackNode);
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
                return;
            }

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
        };
    }

    async speakPiperChunks({ messageId = '', text = '', playbackToken = 0, playbackContext = null } = {}) {
        const normalizedMessageId = String(messageId || '').trim();
        const chunks = this.getPiperSpeechChunks(text);
        if (chunks.length === 0) {
            throw new Error('No text is available to read aloud.');
        }

        const preparedChunkPromises = new Map();
        let activePlaybackContext = playbackContext;
        let nextChunkToPrepare = 0;
        let scheduledEndTime = 0;
        const synthesisLookahead = Math.max(1, DEFAULT_PIPER_SYNTHESIS_LOOKAHEAD);
        activePlaybackContext = activePlaybackContext || await this.preparePlayback();

        const prepareChunk = (index) => {
            if (index < 0 || index >= chunks.length || preparedChunkPromises.has(index)) {
                return;
            }

            preparedChunkPromises.set(index, this.synthesizeAndPrepareMessageAudio(chunks[index], normalizedMessageId, {
                showLoading: index === 0,
                resetCurrentMessage: index === 0,
                playbackContext: activePlaybackContext,
            }));
        };

        const fillPreparedWindow = (currentIndex) => {
            while (
                nextChunkToPrepare < chunks.length
                && nextChunkToPrepare <= (currentIndex + synthesisLookahead)
            ) {
                prepareChunk(nextChunkToPrepare);
                nextChunkToPrepare += 1;
            }
        };

        prepareChunk(0);
        nextChunkToPrepare = 1;
        fillPreparedWindow(0);

        const playbackCompleted = new Promise((resolve) => {
            this.currentPlaybackWaiter = { resolve };
        });

        for (let index = 0; index < chunks.length; index += 1) {
            const chunkPromise = preparedChunkPromises.get(index);
            preparedChunkPromises.delete(index);
            const chunkResult = await chunkPromise;
            if (!this.isPlaybackRequestActive(playbackToken)) {
                return false;
            }

            activePlaybackContext = chunkResult.playbackContext || activePlaybackContext || playbackContext;
            fillPreparedWindow(index + 1);

            const scheduledChunk = this.scheduleDecodedAudioBuffer(chunkResult.decodedBuffer, normalizedMessageId, {
                playbackContext: activePlaybackContext,
                scheduledStartTime: scheduledEndTime,
                playbackToken,
                isFinalChunk: index === (chunks.length - 1),
            });
            scheduledEndTime = scheduledChunk.endTime;
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
    window.WebChatTtsManager = WebChatTtsManager;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
        DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
        WebChatTtsManager,
        groupSpeechSentencesIntoChunks,
        normalizeTextForSpeech,
        splitPreparedSpeechChunk,
        splitSpeechChunkByClauses,
        splitTextIntoSpeechChunks,
        splitWordsIntoSpeechChunks,
    };
}

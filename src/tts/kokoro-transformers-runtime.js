const fs = require('fs/promises');
const path = require('path');
const { phonemize } = require('phonemize');
const { KokoroG2pBridge } = require('./kokoro-g2p-bridge');

const DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_CACHE_DIR = '/app/data/kokoro/cache';
const DEFAULT_VOICE_BASE_URL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices';

const VOICE_PREFIX_TO_LANGUAGE = {
    a: 'en-US',
    b: 'en-GB',
};

const KOKORO_PRONUNCIATION_OVERRIDES = new Map([
    ['ai', 'ˈA ˈI'],
    ['api', 'ˈA pˈi ˈI'],
    ['cli', 'sˈi ˌɛl ˈI'],
    ['cpu', 'sˌi pˌi ˈju'],
    ['css', 'sˌi ˌɛs ˈɛs'],
    ['docker', 'dˈɑkɜɹ'],
    ['espeak', 'ˈispik'],
    ['g2p', 'ʤˈitəpˈi'],
    ['github', 'ɡˈɪthʌb'],
    ['gpu', 'ʤˌi pˌi ˈju'],
    ['grapheme', 'ɡɹˈæfim'],
    ['graphemes', 'ɡɹˈæfimz'],
    ['html', 'ˌAʧ tˌi ˌɛm ˈɛl'],
    ['http', 'ˌAʧ tˌi tˌi pˈi'],
    ['https', 'ˌAʧ tˌi tˌi pˌi ˈɛs'],
    ['javascript', 'ʤˈɑvə skɹˌɪpt'],
    ['json', 'ʤˈAsən'],
    ['k3s', 'kˌeɪ θɹˈi ˈɛs'],
    ['k8s', 'kˌeɪ ˈAt ˈɛs'],
    ['kimibuilt', 'kˈimi bˈɪlt'],
    ['kubernetes', 'kˌubɜɹnˈɛtiz'],
    ['kokoro', 'kˈOkəɹO'],
    ['ng', 'ˌɛn ˈʤi'],
    ['nodejs', 'nˈOd ʤˌeɪ ˈɛs'],
    ['ollama', 'Olˈɑmə'],
    ['openai', 'ˌOpən ˈAˈI'],
    ['phoneme', 'fˈOnim'],
    ['phonemes', 'fˈOnimz'],
    ['phonemizer', 'fˈOnəmˌIzɜɹ'],
    ['phonemize', 'fˈOnəmˌIz'],
    ['qdrant', 'kjˈudɹænt'],
    ['rancher', 'ɹˈænʧɜɹ'],
    ['sse', 'ˌɛs ˌɛs ˈi'],
    ['traefik', 'tɹˈæfɪk'],
    ['tts', 'tˈi tˈi ˈɛs'],
    ['typescript', 'tˈIp skɹˌɪpt'],
    ['ui', 'jˌu ˈI'],
    ['uri', 'jˌu ˌɑɹ ˈI'],
    ['url', 'jˌu ˌɑɹ ˈɛl'],
    ['websocket', 'wˈɛb sˌɑkɪt'],
]);

const defaultG2pBridge = new KokoroG2pBridge();

const UNSTRESSED_FUNCTION_WORDS = new Set([
    'a',
    'about',
    'above',
    'after',
    'again',
    'against',
    'all',
    'am',
    'an',
    'and',
    'any',
    'are',
    'as',
    'at',
    'be',
    'because',
    'been',
    'before',
    'being',
    'below',
    'between',
    'but',
    'by',
    'can',
    'could',
    'did',
    'do',
    'does',
    'down',
    'during',
    'each',
    'for',
    'from',
    'had',
    'has',
    'have',
    'he',
    'her',
    'hers',
    'him',
    'his',
    'i',
    'if',
    'in',
    'into',
    'is',
    'it',
    'its',
    'me',
    'might',
    'must',
    'my',
    'nor',
    'of',
    'on',
    'or',
    'our',
    'ours',
    'out',
    'over',
    'shall',
    'she',
    'should',
    'so',
    'some',
    'such',
    'than',
    'that',
    'the',
    'their',
    'theirs',
    'them',
    'then',
    'there',
    'these',
    'they',
    'this',
    'those',
    'through',
    'to',
    'under',
    'until',
    'up',
    'us',
    'was',
    'we',
    'were',
    'what',
    'when',
    'where',
    'which',
    'while',
    'who',
    'whom',
    'why',
    'will',
    'with',
    'would',
    'you',
    'your',
    'yours',
]);

const voiceCache = new Map();

function normalizePronunciationLookupWord(word = '') {
    return String(word || '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9]+/g, '');
}

function isUnknownPhoneme(value = '') {
    return /^❓+$/.test(String(value || '').trim());
}

function isPunctuationToken(value = '') {
    return /^[;:,.!?—…"“”()[\]{}]+$/.test(String(value || '').trim());
}

function stripStressMarkers(value = '') {
    return String(value || '').replace(/[ˈˌ]/g, '');
}

function isInitialism(word = '') {
    const normalized = String(word || '').replace(/[^A-Za-z]/g, '');
    return normalized.length > 1 && normalized === normalized.toUpperCase();
}

function softenDenseWordStress(phonemes = '', word = '') {
    const value = String(phonemes || '');
    const stressIndexes = [];
    value.replace(/ˈ/g, (_match, offset) => {
        stressIndexes.push(offset);
        return _match;
    });

    if (stressIndexes.length <= 1 || isInitialism(word)) {
        return value;
    }

    const finalPrimaryStress = stressIndexes[stressIndexes.length - 1];
    return value.replace(/ˈ/g, (match, offset) => (
        offset === finalPrimaryStress ? match : ''
    ));
}

function normalizeTokenPhonemesForKokoro(token = {}) {
    const word = String(token.word || '').trim();
    const lookupWord = normalizePronunciationLookupWord(word);
    const override = KOKORO_PRONUNCIATION_OVERRIDES.get(lookupWord);
    const rawPhonemes = String(token.phoneme || '').trim();
    let phonemes = override || rawPhonemes;

    if (!phonemes || (!override && isUnknownPhoneme(phonemes))) {
        return '';
    }

    if (!override && lookupWord === 'a' && word !== 'A') {
        phonemes = 'ə';
    }

    if (!override && UNSTRESSED_FUNCTION_WORDS.has(lookupWord)) {
        phonemes = stripStressMarkers(phonemes);
    }

    if (!override) {
        phonemes = softenDenseWordStress(phonemes, word);
    }

    return normalizePhonemesForKokoro(phonemes);
}

function joinKokoroPhonemeTokens(tokens = []) {
    const parts = [];

    (Array.isArray(tokens) ? tokens : []).forEach((token = {}) => {
        const phonemes = normalizeTokenPhonemesForKokoro(token);
        if (!phonemes) {
            return;
        }

        if (isPunctuationToken(token.word || phonemes) && parts.length > 0) {
            parts[parts.length - 1] = `${parts[parts.length - 1]}${phonemes}`;
            return;
        }

        parts.push(phonemes);
    });

    return parts.join(' ');
}

function normalizePhonemesForKokoro(value = '') {
    return String(value || '')
        .replace(/ɫ/g, 'l')
        .replace(/ɝ/g, 'ɜɹ')
        .replace(/ɚ/g, 'ɜɹ')
        .replace(/ᵊ/g, 'ə')
        .replace(/tʃ/g, 'ʧ')
        .replace(/dʒ/g, 'ʤ')
        .replace(/eɪ/g, 'A')
        .replace(/aɪ/g, 'I')
        .replace(/aʊ/g, 'W')
        .replace(/ɔɪ/g, 'Y')
        .replace(/oʊ/g, 'O')
        .replace(/əʊ/g, 'Q')
        .replace(/ʲ/g, 'j')
        .replace(/r/g, 'ɹ')
        .replace(/x/g, 'k')
        .replace(/ɬ/g, 'l')
        .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
        .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
        .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
        .replace(/ z(?=[;:,.!?—…"“” ]|$)/g, 'z')
        .replace(/❓/g, '')
        .trim();
}

function resolveVoiceLanguage(voice = '') {
    const prefix = String(voice || '').trim().at(0) || 'a';
    return VOICE_PREFIX_TO_LANGUAGE[prefix] || VOICE_PREFIX_TO_LANGUAGE.a;
}

function finalizeKokoroPhonemes(rawPhonemes = '', language = VOICE_PREFIX_TO_LANGUAGE.a) {
    let phonemes = normalizePhonemesForKokoro(rawPhonemes);
    if (language === VOICE_PREFIX_TO_LANGUAGE.a) {
        phonemes = phonemes.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
    }
    return phonemes;
}

function phonemizeForKokoroFallback(text = '', voice = 'af_heart') {
    const language = resolveVoiceLanguage(voice);
    const tokenizedPhonemes = phonemize(String(text || ''), {
        language,
        returnArray: true,
    });
    const rawPhonemes = Array.isArray(tokenizedPhonemes) && tokenizedPhonemes.length > 0
        ? joinKokoroPhonemeTokens(tokenizedPhonemes)
        : phonemize(String(text || ''), language);
    return finalizeKokoroPhonemes(rawPhonemes, language);
}

async function phonemizeForKokoro(text = '', voice = 'af_heart', options = {}) {
    const language = resolveVoiceLanguage(voice);
    const bridgeLanguage = language === VOICE_PREFIX_TO_LANGUAGE.b ? 'en-gb' : 'en-us';
    const bridge = Object.prototype.hasOwnProperty.call(options, 'g2pBridge')
        ? options.g2pBridge
        : defaultG2pBridge;

    if (bridge?.isEnabled?.()) {
        try {
            const result = await bridge.phonemize(String(text || ''), bridgeLanguage);
            const rawPhonemes = Array.isArray(result?.tokens) && result.tokens.length > 0
                ? joinKokoroPhonemeTokens(result.tokens)
                : String(result?.phonemes || '').trim();
            const phonemes = finalizeKokoroPhonemes(rawPhonemes, language);
            if (phonemes) {
                return phonemes;
            }
            if (bridge.required === true) {
                throw new Error('Kokoro G2P bridge returned empty phonemes.');
            }
        } catch (error) {
            if (bridge.required === true) {
                throw error;
            }
            if (bridge.warnedUnavailable !== true) {
                bridge.warnedUnavailable = true;
                console.warn(`[KokoroTTS] Falling back to JS phonemizer because Kokoro G2P bridge failed: ${error.message}`);
            }
        }
    }

    return phonemizeForKokoroFallback(text, voice);
}

function toArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function readVoiceFile(filePath) {
    const buffer = await fs.readFile(filePath);
    return new Float32Array(toArrayBuffer(buffer));
}

async function writeVoiceFile(filePath, arrayBuffer) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
}

class KimiBuiltKokoroTTS {
    constructor(model, tokenizer, options = {}) {
        this.model = model;
        this.tokenizer = tokenizer;
        this.Tensor = options.Tensor;
        this.RawAudio = options.RawAudio;
        this.cacheDir = String(options.cacheDir || DEFAULT_CACHE_DIR).trim() || DEFAULT_CACHE_DIR;
        this.voiceBaseURL = String(options.voiceBaseURL || DEFAULT_VOICE_BASE_URL).replace(/\/+$/, '');
        this.allowRemoteModels = options.allowRemoteModels;
        this.g2pBridge = Object.prototype.hasOwnProperty.call(options, 'g2pBridge')
            ? options.g2pBridge
            : defaultG2pBridge;
    }

    static async from_pretrained(modelId = DEFAULT_MODEL_ID, options = {}) {
        const transformers = options.transformers || require('@huggingface/transformers');
        const {
            AutoTokenizer,
            RawAudio,
            StyleTextToSpeech2Model,
            Tensor,
        } = transformers;

        if (!StyleTextToSpeech2Model?.from_pretrained || !AutoTokenizer?.from_pretrained) {
            throw new Error('Transformers.js does not expose the Kokoro model/tokenizer APIs.');
        }

        const modelOptions = {
            dtype: options.dtype || 'q8',
            device: options.device || 'cpu',
            progress_callback: options.progress_callback || null,
        };
        const tokenizerOptions = {
            progress_callback: options.progress_callback || null,
        };
        const [model, tokenizer] = await Promise.all([
            StyleTextToSpeech2Model.from_pretrained(modelId, modelOptions),
            AutoTokenizer.from_pretrained(modelId, tokenizerOptions),
        ]);

        const g2pBridge = Object.prototype.hasOwnProperty.call(options, 'g2pBridge')
            ? options.g2pBridge
            : new KokoroG2pBridge(options.g2p || {});

        return new KimiBuiltKokoroTTS(model, tokenizer, {
            Tensor,
            RawAudio,
            cacheDir: options.cacheDir,
            voiceBaseURL: options.voiceBaseURL,
            allowRemoteModels: options.allowRemoteModels,
            g2pBridge,
        });
    }

    async loadVoice(voice = 'af_heart') {
        const voiceId = String(voice || '').trim() || 'af_heart';
        const cacheKey = `${this.cacheDir}:${voiceId}`;
        if (voiceCache.has(cacheKey)) {
            return voiceCache.get(cacheKey);
        }

        const voicePath = path.join(this.cacheDir, 'voices', `${voiceId}.bin`);
        try {
            const localVoice = await readVoiceFile(voicePath);
            voiceCache.set(cacheKey, localVoice);
            return localVoice;
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }

        if (this.allowRemoteModels === false) {
            throw new Error(`Kokoro voice "${voiceId}" is not cached at ${voicePath}.`);
        }

        const response = await fetch(`${this.voiceBaseURL}/${encodeURIComponent(voiceId)}.bin`);
        if (!response.ok) {
            throw new Error(`Kokoro voice "${voiceId}" download failed with status ${response.status}.`);
        }

        const arrayBuffer = await response.arrayBuffer();
        await writeVoiceFile(voicePath, arrayBuffer);
        const remoteVoice = new Float32Array(arrayBuffer);
        voiceCache.set(cacheKey, remoteVoice);
        return remoteVoice;
    }

    async generate(text, { voice = 'af_heart', speed = 1 } = {}) {
        const phonemes = await phonemizeForKokoro(text, voice, { g2pBridge: this.g2pBridge });
        const { input_ids: inputIds } = this.tokenizer(phonemes, { truncation: true });
        return this.generate_from_ids(inputIds, { voice, speed });
    }

    async generate_from_ids(inputIds, { voice = 'af_heart', speed = 1 } = {}) {
        const tokenLength = Array.isArray(inputIds?.dims)
            ? Number(inputIds.dims.at(-1)) || 0
            : 0;
        const styleOffset = 256 * Math.min(Math.max(tokenLength - 2, 0), 509);
        const voiceStyles = await this.loadVoice(voice);
        const style = voiceStyles.slice(styleOffset, styleOffset + 256);
        const modelInput = {
            input_ids: inputIds,
            style: new this.Tensor('float32', style, [1, 256]),
            speed: new this.Tensor('float32', [Number(speed) || 1], [1]),
        };
        const { waveform } = await this.model(modelInput);
        return new this.RawAudio(waveform.data, 24000);
    }

    close() {
        this.g2pBridge?.close?.();
    }
}

module.exports = {
    DEFAULT_CACHE_DIR,
    DEFAULT_MODEL_ID,
    KIMIBUILT_KOKORO_RUNTIME: true,
    KokoroTTS: KimiBuiltKokoroTTS,
    KimiBuiltKokoroTTS,
    joinKokoroPhonemeTokens,
    normalizePhonemesForKokoro,
    phonemizeForKokoro,
    phonemizeForKokoroFallback,
};

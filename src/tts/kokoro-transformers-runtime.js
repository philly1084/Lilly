const fs = require('fs/promises');
const path = require('path');
const { phonemize } = require('phonemize');

const DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_CACHE_DIR = '/app/data/kokoro/cache';
const DEFAULT_VOICE_BASE_URL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices';

const VOICE_PREFIX_TO_LANGUAGE = {
    a: 'en-US',
    b: 'en-GB',
};

const voiceCache = new Map();

function normalizePhonemesForKokoro(value = '') {
    return String(value || '')
        .replace(/ɫ/g, 'l')
        .replace(/ɝ/g, 'ɚ')
        .replace(/ʲ/g, 'j')
        .replace(/r/g, 'ɹ')
        .replace(/x/g, 'k')
        .replace(/ɬ/g, 'l')
        .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
        .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
        .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
        .replace(/ z(?=[;:,.!?—…"“” ]|$)/g, 'z')
        .trim();
}

function resolveVoiceLanguage(voice = '') {
    const prefix = String(voice || '').trim().at(0) || 'a';
    return VOICE_PREFIX_TO_LANGUAGE[prefix] || VOICE_PREFIX_TO_LANGUAGE.a;
}

function phonemizeForKokoro(text = '', voice = 'af_heart') {
    const language = resolveVoiceLanguage(voice);
    const rawPhonemes = phonemize(String(text || ''), language);
    let phonemes = normalizePhonemesForKokoro(rawPhonemes);
    if (language === VOICE_PREFIX_TO_LANGUAGE.a) {
        phonemes = phonemes.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
    }
    return phonemes;
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

        return new KimiBuiltKokoroTTS(model, tokenizer, {
            Tensor,
            RawAudio,
            cacheDir: options.cacheDir,
            voiceBaseURL: options.voiceBaseURL,
            allowRemoteModels: options.allowRemoteModels,
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
        const phonemes = phonemizeForKokoro(text, voice);
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
}

module.exports = {
    DEFAULT_CACHE_DIR,
    DEFAULT_MODEL_ID,
    KIMIBUILT_KOKORO_RUNTIME: true,
    KokoroTTS: KimiBuiltKokoroTTS,
    KimiBuiltKokoroTTS,
    normalizePhonemesForKokoro,
    phonemizeForKokoro,
};

const fsSync = require('fs');
const path = require('path');

const DEFAULT_KOKORO_CACHE_DIR = '/app/data/kokoro/cache';

function normalizeKokoroVoiceList(voices = []) {
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

function getKokoroCacheDir(ttsConfig = {}) {
    return String(ttsConfig.cacheDir || '').trim() || DEFAULT_KOKORO_CACHE_DIR;
}

function shouldRequireCachedKokoroVoices(ttsConfig = {}) {
    return ttsConfig.allowRemoteModels === false;
}

function getKokoroVoicePath(ttsConfig = {}, voiceId = '') {
    const normalizedVoiceId = String(voiceId || '').trim();
    if (!normalizedVoiceId) {
        return '';
    }
    return path.join(getKokoroCacheDir(ttsConfig), 'voices', `${normalizedVoiceId}.bin`);
}

function pathExists(targetPath = '') {
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

function getCachedKokoroVoiceAvailability(ttsConfig = {}, voices = []) {
    const normalizedVoices = normalizeKokoroVoiceList(voices);
    const requiresCachedVoices = shouldRequireCachedKokoroVoices(ttsConfig);
    if (!requiresCachedVoices) {
        return {
            voices: normalizedVoices,
            uncachedVoices: [],
            requiresCachedVoices,
        };
    }

    const cachedVoices = [];
    const uncachedVoices = [];
    normalizedVoices.forEach((voice) => {
        const cachePath = getKokoroVoicePath(ttsConfig, voice.id);
        if (cachePath && pathExists(cachePath)) {
            cachedVoices.push(voice);
            return;
        }
        uncachedVoices.push({
            ...voice,
            cachePath,
        });
    });

    return {
        voices: cachedVoices,
        uncachedVoices,
        requiresCachedVoices,
    };
}

module.exports = {
    DEFAULT_KOKORO_CACHE_DIR,
    getCachedKokoroVoiceAvailability,
    getKokoroCacheDir,
    getKokoroVoicePath,
    normalizeKokoroVoiceList,
    shouldRequireCachedKokoroVoices,
};

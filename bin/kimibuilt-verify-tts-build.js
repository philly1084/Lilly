#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_REMOTE_RETRY_ATTEMPTS = 4;
const DEFAULT_REMOTE_RETRY_DELAY_MS = 3000;
const MAX_REMOTE_RETRY_DELAY_MS = 30000;

const BLOCKED_TTS_PACKAGES = new Map([
    ['kokoro-js', 'imports the eSpeak NG-backed phonemizer package at module load time'],
    ['phonemizer', 'bundles an eSpeak NG-based G2P runtime'],
    ['ffmpeg-static', 'ships a GPL-licensed ffmpeg binary package in node_modules'],
    ['gsap', 'uses a non-standard no-charge license and should not be bundled in the product image'],
    ['p5', 'uses LGPL-2.1 and should remain an explicit user/runtime choice instead of a bundled product dependency'],
]);

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

async function main() {
    const modelId = process.env.KOKORO_TTS_MODEL_ID || 'onnx-community/Kokoro-82M-v1.0-ONNX';
    const device = process.env.KOKORO_TTS_DEVICE || 'cpu';
    const dtype = process.env.KOKORO_TTS_DTYPE || 'q8';
    const voice = process.env.KOKORO_TTS_DEFAULT_VOICE_ID || 'af_heart';
    const voiceIds = loadBuildVoiceIds(voice);
    const synthesisMode = getSynthesisMode();
    const cacheDir = process.env.KOKORO_TTS_CACHE_DIR || '/app/data/kokoro/cache';
    const localModelPath = process.env.KOKORO_TTS_LOCAL_MODEL_PATH || '';
    const allowRemoteModels = parseOptionalBoolean(process.env.KOKORO_TTS_ALLOW_REMOTE_MODELS);

    verifyPermissiveTtsDependencyGraph();

    const { env } = require('@huggingface/transformers');
    fs.mkdirSync(cacheDir, { recursive: true });
    env.cacheDir = cacheDir;
    if (localModelPath) {
        env.localModelPath = localModelPath;
    }
    if (typeof allowRemoteModels === 'boolean') {
        env.allowRemoteModels = allowRemoteModels;
    }

    await verifySharpRuntime();

    const { KokoroTTS } = require('../src/tts/kokoro-transformers-runtime');
    const tts = await withRemoteRetry('Kokoro model load', () => KokoroTTS.from_pretrained(modelId, {
        dtype,
        device,
        transformers: { env, ...require('@huggingface/transformers') },
        cacheDir,
        allowRemoteModels,
        g2p: {
            required: process.env.KOKORO_G2P_REQUIRED === 'true',
        },
    }));
    try {
        for (const voiceId of getVoiceIdsForSynthesis(voiceIds, synthesisMode)) {
            await verifyGeneratedAudio(tts, voiceId);
        }

        const cacheOnlyVoiceIds = voiceIds.filter((voiceId) => (
            !getVoiceIdsForSynthesis(voiceIds, synthesisMode).includes(voiceId)
        ));
        for (const voiceId of cacheOnlyVoiceIds) {
            await verifyCachedVoice(tts, voiceId);
        }
    } finally {
        tts.close?.();
    }

    console.log(`[TTS Build] Kokoro ready: model=${modelId} dtype=${dtype} device=${device} synthesis=${synthesisMode} voices=${voiceIds.join(',')}`);
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getRetryConfig() {
    return {
        attempts: parsePositiveInteger(process.env.KOKORO_TTS_BUILD_RETRY_ATTEMPTS, DEFAULT_REMOTE_RETRY_ATTEMPTS),
        delayMs: parsePositiveInteger(process.env.KOKORO_TTS_BUILD_RETRY_DELAY_MS, DEFAULT_REMOTE_RETRY_DELAY_MS),
    };
}

function getSynthesisMode() {
    const normalized = String(process.env.KOKORO_TTS_BUILD_SYNTHESIS_MODE || 'all').trim().toLowerCase();
    if (['none', 'cache', 'cache-only', 'false', '0', 'off'].includes(normalized)) {
        return 'none';
    }
    if (['default', 'default-only', 'one', 'single'].includes(normalized)) {
        return 'default';
    }
    return 'all';
}

function getVoiceIdsForSynthesis(voiceIds, synthesisMode) {
    if (synthesisMode === 'none') {
        return [];
    }
    if (synthesisMode === 'default') {
        return voiceIds.slice(0, 1);
    }
    return voiceIds;
}

async function verifyGeneratedAudio(tts, voiceId) {
    const audio = await withRemoteRetry(`Kokoro voice ${voiceId}`, () => tts.generate(`KimiBuilt Kokoro build check for ${voiceId}.`, {
        voice: voiceId,
        speed: 1,
    }));
    const wav = typeof audio?.toWav === 'function' ? Buffer.from(audio.toWav()) : Buffer.alloc(0);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error(`Kokoro generated invalid WAV audio during build verification for voice ${voiceId}.`);
    }
    console.log(`[TTS Build] Kokoro voice synthesized: ${voiceId} bytes=${wav.length}`);
}

async function verifyCachedVoice(tts, voiceId) {
    const voiceData = await withRemoteRetry(`Kokoro voice cache ${voiceId}`, () => tts.loadVoice(voiceId));
    if (!(voiceData instanceof Float32Array) || voiceData.length < 256) {
        throw new Error(`Kokoro voice "${voiceId}" cache verification failed: invalid voice tensor.`);
    }
    console.log(`[TTS Build] Kokoro voice cached: ${voiceId} samples=${voiceData.length}`);
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
    return String(error?.message || error || '').trim();
}

function isRemoteRetryableError(error) {
    const message = getErrorMessage(error);
    return /\b(?:408|425|429|500|502|503|504)\b/.test(message)
        || /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network|rate limit|throttl)/i.test(message);
}

async function withRemoteRetry(label, operation) {
    const { attempts, delayMs } = getRetryConfig();
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt >= attempts || !isRemoteRetryableError(error)) {
                throw error;
            }

            const backoffMs = Math.min(delayMs * (2 ** (attempt - 1)), MAX_REMOTE_RETRY_DELAY_MS);
            console.warn(`[TTS Build] ${label} failed on attempt ${attempt}/${attempts}: ${getErrorMessage(error)}; retrying in ${backoffMs}ms.`);
            await wait(backoffMs);
        }
    }

    throw lastError;
}

function loadBuildVoiceIds(defaultVoiceId = '') {
    const voiceIds = [];
    const pushVoiceId = (value = '') => {
        const voiceId = String(value || '').trim();
        if (voiceId && !voiceIds.includes(voiceId)) {
            voiceIds.push(voiceId);
        }
    };

    pushVoiceId(defaultVoiceId);

    const voicesPath = process.env.KOKORO_TTS_VOICES_PATH || path.resolve(__dirname, '../data/kokoro/voices/manifest.json');
    try {
        const manifest = readJsonFile(voicesPath);
        (Array.isArray(manifest) ? manifest : []).forEach((voice) => {
            pushVoiceId(voice?.id || voice?.voiceId);
        });
    } catch (error) {
        console.warn(`[TTS Build] Kokoro voice manifest unavailable at ${voicesPath}: ${error.message}`);
    }

    return voiceIds.length > 0 ? voiceIds : ['af_heart'];
}

function verifyPermissiveTtsDependencyGraph() {
    const rootDir = path.resolve(__dirname, '..');
    const lockPath = path.join(rootDir, 'package-lock.json');
    const lock = readJsonFile(lockPath);
    const blocked = [];

    for (const [packagePath, packageMeta] of Object.entries(lock.packages || {})) {
        const name = packageMeta?.name || path.basename(packagePath || '');
        if (BLOCKED_TTS_PACKAGES.has(name)) {
            blocked.push(`${name}: ${BLOCKED_TTS_PACKAGES.get(name)}`);
        }
    }

    if (blocked.length > 0) {
        throw new Error(`permissive TTS dependency guard failed (${blocked.join('; ')})`);
    }

    console.log('[TTS Build] permissive TTS dependency guard ready: no blocked TTS/browser media package entries.');
}

async function verifySharpRuntime() {
    let sharp;
    try {
        sharp = require('sharp');
    } catch (error) {
        throw new Error(`sharp runtime unavailable: ${error.message}`);
    }

    const png = await sharp({
        create: {
            width: 1,
            height: 1,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
        },
    }).png().toBuffer();

    if (!Buffer.isBuffer(png) || png.length < 8 || png.toString('ascii', 1, 4) !== 'PNG') {
        throw new Error('sharp runtime generated invalid PNG output during build verification.');
    }

    console.log(`[TTS Build] sharp ready: sharp=${sharp.versions?.sharp || 'unknown'} vips=${sharp.versions?.vips || 'unknown'} arch=${process.arch}`);
}

main().catch((error) => {
    console.error(`[TTS Build] TTS verification failed: ${error.message}`);
    process.exit(1);
});

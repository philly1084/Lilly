#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

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

    verifyNoBundledOptionalMediaRuntimes();

    const { KokoroTTS } = require('../src/tts/kokoro-transformers-runtime');
    const tts = await KokoroTTS.from_pretrained(modelId, {
        dtype,
        device,
        transformers: { env, ...require('@huggingface/transformers') },
        cacheDir,
        allowRemoteModels,
        g2p: {
            required: process.env.KOKORO_G2P_REQUIRED === 'true',
        },
    });
    try {
        for (const voiceId of voiceIds) {
            const audio = await tts.generate(`KimiBuilt Kokoro build check for ${voiceId}.`, {
                voice: voiceId,
                speed: 1,
            });
            const wav = typeof audio?.toWav === 'function' ? Buffer.from(audio.toWav()) : Buffer.alloc(0);
            if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
                throw new Error(`Kokoro generated invalid WAV audio during build verification for voice ${voiceId}.`);
            }
            console.log(`[TTS Build] Kokoro voice cached: ${voiceId} bytes=${wav.length}`);
        }
    } finally {
        tts.close?.();
    }

    console.log(`[TTS Build] Kokoro ready: model=${modelId} dtype=${dtype} device=${device} voices=${voiceIds.join(',')}`);
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function verifyNoBundledOptionalMediaRuntimes() {
    const rootDir = path.resolve(__dirname, '..');
    const blockedInstallPaths = [
        path.join(rootDir, 'node_modules/sharp'),
        path.join(rootDir, 'node_modules/@img'),
    ];
    const installed = blockedInstallPaths.filter((targetPath) => fs.existsSync(targetPath));

    if (installed.length > 0) {
        throw new Error(`optional Sharp/libvips runtime should not be bundled in the product image: ${installed.join(', ')}`);
    }

    console.log('[TTS Build] optional Sharp/libvips runtime omitted from bundled image.');
}

main().catch((error) => {
    console.error(`[TTS Build] TTS verification failed: ${error.message}`);
    process.exit(1);
});

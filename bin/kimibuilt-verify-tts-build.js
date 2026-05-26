#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BLOCKED_TTS_PACKAGES = new Map([
    ['kokoro-js', 'imports the eSpeak NG-backed phonemizer package at module load time'],
    ['phonemizer', 'bundles an eSpeak NG-based G2P runtime'],
    ['ffmpeg-static', 'ships a GPL-licensed ffmpeg binary package in node_modules'],
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
    let wav = Buffer.alloc(0);
    try {
        const audio = await tts.generate('KimiBuilt Kokoro build check.', {
            voice,
            speed: 1,
        });
        wav = typeof audio?.toWav === 'function' ? Buffer.from(audio.toWav()) : Buffer.alloc(0);
    } finally {
        tts.close?.();
    }

    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('Kokoro generated invalid WAV audio during build verification.');
    }

    console.log(`[TTS Build] Kokoro ready: model=${modelId} dtype=${dtype} device=${device} voice=${voice} bytes=${wav.length}`);
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

    console.log('[TTS Build] permissive TTS dependency guard ready: no kokoro-js, phonemizer, or ffmpeg-static package entries.');
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

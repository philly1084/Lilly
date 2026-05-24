#!/usr/bin/env node

const fs = require('fs');

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

    const { KokoroTTS } = require('kokoro-js');
    const tts = await KokoroTTS.from_pretrained(modelId, {
        dtype,
        device,
    });
    const audio = await tts.generate('KimiBuilt Kokoro build check.', {
        voice,
        speed: 1,
    });
    const wav = typeof audio?.toWav === 'function' ? Buffer.from(audio.toWav()) : Buffer.alloc(0);

    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('Kokoro generated invalid WAV audio during build verification.');
    }

    console.log(`[TTS Build] Kokoro ready: model=${modelId} dtype=${dtype} device=${device} voice=${voice} bytes=${wav.length}`);
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
    console.error(`[TTS Build] Kokoro verification failed: ${error.message}`);
    process.exit(1);
});

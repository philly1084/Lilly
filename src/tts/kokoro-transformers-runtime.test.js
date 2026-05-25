const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    KimiBuiltKokoroTTS,
    phonemizeForKokoro,
} = require('./kokoro-transformers-runtime');

class FakeTensor {
    constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
    }
}

class FakeRawAudio {
    constructor(data, sampleRate) {
        this.data = data;
        this.sampleRate = sampleRate;
    }
}

function writeVoice(cacheDir, voiceId = 'af_heart') {
    const voiceDir = path.join(cacheDir, 'voices');
    fs.mkdirSync(voiceDir, { recursive: true });
    const voice = new Float32Array(256 * 8);
    for (let index = 0; index < voice.length; index += 1) {
        voice[index] = index / voice.length;
    }
    fs.writeFileSync(path.join(voiceDir, `${voiceId}.bin`), Buffer.from(voice.buffer));
}

describe('KimiBuiltKokoroTTS runtime', () => {
    test('normalizes permissive G2P output into the Kokoro tokenizer alphabet', () => {
        const phonemes = phonemizeForKokoro('Hello world!', 'af_heart');

        expect(phonemes).toContain('hə');
        expect(phonemes).not.toContain('ɫ');
        expect(phonemes).not.toContain('ɝ');
    });

    test('generates audio with cached voices without importing kokoro-js phonemizer', async () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-kokoro-runtime-'));
        writeVoice(cacheDir);

        const tokenizer = jest.fn(() => ({
            input_ids: {
                dims: [1, 6],
                data: [0, 1, 2, 3, 4, 5],
            },
        }));
        const model = jest.fn(async () => ({
            waveform: {
                data: Float32Array.from([0, 0.1, -0.1]),
            },
        }));
        const tts = new KimiBuiltKokoroTTS(model, tokenizer, {
            Tensor: FakeTensor,
            RawAudio: FakeRawAudio,
            cacheDir,
            allowRemoteModels: false,
        });

        try {
            const audio = await tts.generate('Hello world!', {
                voice: 'af_heart',
                speed: 1.1,
            });

            expect(tokenizer).toHaveBeenCalledWith(expect.any(String), { truncation: true });
            expect(model).toHaveBeenCalledWith(expect.objectContaining({
                input_ids: expect.objectContaining({ dims: [1, 6] }),
                style: expect.objectContaining({
                    type: 'float32',
                    dims: [1, 256],
                }),
                speed: expect.objectContaining({
                    type: 'float32',
                    dims: [1],
                }),
            }));
            expect(audio).toEqual(expect.objectContaining({
                data: expect.any(Float32Array),
                sampleRate: 24000,
            }));
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});

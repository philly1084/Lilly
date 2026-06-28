const path = require('path');

const ORIGINAL_ENV = process.env;

describe('config bundled TTS defaults', () => {
    beforeEach(() => {
        jest.resetModules();
        process.env = {
            ...ORIGINAL_ENV,
        };

        delete process.env.PIPER_TTS_BINARY_PATH;
        delete process.env.PIPER_TTS_VOICES_PATH;
        delete process.env.PIPER_TTS_VOICES_JSON;
        delete process.env.PIPER_TTS_MODEL_PATH;
        delete process.env.PIPER_TTS_CONFIG_PATH;
        delete process.env.PIPER_TTS_DEFAULT_VOICE_ID;
        delete process.env.TTS_PROVIDER;
        delete process.env.TTS_REALTIME_CHUNK_TARGET_CHARS;
        delete process.env.TTS_REALTIME_PRIMARY_TIMEOUT_MS;
        delete process.env.TTS_REALTIME_FALLBACK_TIMEOUT_MS;
        process.env.TTS_FALLBACK_PROVIDER = '';
        delete process.env.KOKORO_TTS_VOICES_PATH;
        delete process.env.KOKORO_TTS_VOICES_JSON;
        delete process.env.KOKORO_TTS_DEFAULT_VOICE_ID;
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    test('loads bundled Kokoro defaults without enabling Piper fallback by default', () => {
        const { config } = require('./config');

        expect(config.tts.provider).toBe('kokoro');
        expect(config.tts.fallbackProvider).toBe('');
        expect(config.tts.kokoro.voicesPath).toContain(path.join('data', 'kokoro', 'voices', 'manifest.json'));
        expect(config.tts.kokoro.voices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'af_heart', aliases: expect.arrayContaining(['lessac-high']) }),
            expect.objectContaining({ id: 'af_bella', aliases: expect.arrayContaining(['ljspeech-high']) }),
            expect.objectContaining({ id: 'af_nicole' }),
            expect.objectContaining({ id: 'bf_emma', aliases: expect.arrayContaining(['cori-high']) }),
        ]));
        expect(config.tts.kokoro.voices.map((voice) => voice.id)).not.toEqual(expect.arrayContaining([
            'am_adam',
            'am_michael',
            'bm_george',
        ]));
        expect(config.tts.kokoro.defaultVoiceId).toBe('af_heart');
        expect(
            config.tts.piper.binaryPath === 'piper'
            || config.tts.piper.binaryPath.includes(path.join('data', 'piper', 'runtime', 'piper')),
        ).toBe(true);
        expect(config.tts.piper.voicesPath).toContain(path.join('data', 'piper', 'voices', 'manifest.json'));
        expect(config.tts.piper.voices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'amy-medium' }),
            expect.objectContaining({ id: 'amy-broadcast' }),
            expect.objectContaining({ id: 'hfc-female-rich' }),
        ]));
        expect(config.tts.piper.voices.map((voice) => voice.id)).not.toEqual(expect.arrayContaining([
            'ryan-high',
            'ryan-direct',
        ]));
        expect(config.tts.piper.defaultVoiceId).toBe('hfc-female-rich');
        expect(config.tts.realtime.chunkTargetChars).toBe(180);
        expect(config.tts.realtime.primaryTimeoutMs).toBe(60000);
        expect(config.tts.realtime.fallbackTimeoutMs).toBe(45000);
    });
});

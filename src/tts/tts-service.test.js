const { TtsService } = require('./tts-service');

function createProvider(provider = 'kokoro', diagnosticsStatus = 'ready', synthesizeImpl = async () => ({
    provider,
    audioBuffer: Buffer.from(`${provider}-audio`),
}), publicConfigOverrides = {}) {
    const defaultVoiceId = provider === 'kokoro' ? 'af_heart' : 'hfc-female-rich';
    return {
        getPublicConfig: jest.fn(() => ({
            configured: diagnosticsStatus === 'ready',
            provider,
            voices: [{
                id: defaultVoiceId,
                label: provider === 'kokoro' ? 'Heart Studio' : 'HFC Rich',
                provider,
            }],
            diagnostics: {
                status: diagnosticsStatus,
            },
            defaultVoiceId,
            ...publicConfigOverrides,
        })),
        synthesize: jest.fn(synthesizeImpl),
    };
}

describe('TtsService', () => {
    test('delegates synthesis to the configured Kokoro provider', async () => {
        const kokoro = createProvider('kokoro');
        const piper = createProvider('piper');
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        const result = await service.synthesize({
            text: 'Hello there.',
            voiceId: 'af_heart',
        });

        expect(kokoro.synthesize).toHaveBeenCalledWith({
            text: 'Hello there.',
            voiceId: 'af_heart',
        });
        expect(piper.synthesize).not.toHaveBeenCalled();
        expect(result.provider).toBe('kokoro');
    });

    test('forwards timeout overrides to the active provider when supplied', async () => {
        const kokoro = createProvider('kokoro');
        const service = new TtsService({ provider: 'kokoro' }, { kokoro, piper: null });

        await service.synthesize({
            text: 'Hello there.',
            voiceId: 'af_heart',
            timeoutMs: 180000,
        });

        expect(kokoro.synthesize).toHaveBeenCalledWith({
            text: 'Hello there.',
            voiceId: 'af_heart',
            timeoutMs: 180000,
        });
    });

    test('can route a realtime hedge directly to the fallback provider without an incompatible voice id', async () => {
        const kokoro = createProvider('kokoro');
        const piper = createProvider('piper');
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        const result = await service.synthesize({
            text: 'Fast hedge please.',
            voiceId: 'af_heart',
            provider: 'piper',
            timeoutMs: 10000,
            allowProviderFallback: false,
        });

        expect(kokoro.synthesize).not.toHaveBeenCalled();
        expect(piper.synthesize).toHaveBeenCalledWith({
            text: 'Fast hedge please.',
            voiceId: '',
            timeoutMs: 10000,
        });
        expect(result.provider).toBe('piper');
    });

    test('returns Kokoro public config plus fallback provider catalog', () => {
        const kokoro = createProvider('kokoro', 'ready', undefined, {
            maxTextChars: 2400,
            defaultVoiceId: 'af_heart',
            diagnostics: {
                status: 'ready',
                message: '1 Kokoro voice ready.',
                modelReachable: true,
                voicesLoaded: true,
            },
        });
        const piper = createProvider('piper', 'misconfigured', undefined, {
            configured: false,
            diagnostics: {
                status: 'misconfigured',
                message: 'Piper binary is missing.',
                binaryReachable: false,
                voicesLoaded: true,
            },
        });
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        expect(service.getPublicConfig()).toEqual(expect.objectContaining({
            configured: true,
            provider: 'kokoro',
            maxTextChars: 2400,
            defaultVoiceId: 'af_heart',
            voices: [
                expect.objectContaining({ id: 'af_heart', provider: 'kokoro' }),
            ],
            providers: [
                expect.objectContaining({ provider: 'kokoro', configured: true }),
                expect.objectContaining({ provider: 'piper', configured: false }),
            ],
            fallbackProvider: 'piper',
            fallbackEnabled: true,
            diagnostics: expect.objectContaining({
                status: 'ready',
                voicesLoaded: true,
            }),
        }));
    });

    test('falls back to Piper when Kokoro is unavailable before synthesis', async () => {
        const kokoro = createProvider('kokoro', 'unavailable', async () => {
            throw new Error('Should not call unavailable provider');
        }, {
            configured: false,
        });
        const piper = createProvider('piper');
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        const result = await service.synthesize({
            text: 'Hello there.',
            voiceId: 'af_heart',
        });

        expect(kokoro.synthesize).not.toHaveBeenCalled();
        expect(piper.synthesize).toHaveBeenCalledWith({
            text: 'Hello there.',
            voiceId: '',
        });
        expect(result.provider).toBe('piper');
        expect(result.fallback).toEqual(expect.objectContaining({
            providerFallback: true,
            fromProvider: 'kokoro',
            toProvider: 'piper',
        }));
    });

    test('does not use provider fallback when disabled for a synthesis request', async () => {
        const timeoutError = new Error('Kokoro generation timed out.');
        timeoutError.statusCode = 504;
        timeoutError.code = 'tts_timeout';
        const kokoro = createProvider('kokoro', 'ready', async () => {
            throw timeoutError;
        });
        const piper = createProvider('piper');
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        await expect(service.synthesize({
            text: 'Hello there.',
            voiceId: 'af_heart',
            allowProviderFallback: false,
        })).rejects.toThrow('Kokoro generation timed out.');

        expect(kokoro.synthesize).toHaveBeenCalledTimes(1);
        expect(piper.synthesize).not.toHaveBeenCalled();
    });

    test('falls back to Piper on provider unavailable errors', async () => {
        const unavailableError = new Error('Kokoro model failed to load.');
        unavailableError.statusCode = 503;
        unavailableError.code = 'tts_unavailable';
        const kokoro = createProvider('kokoro', 'ready', async () => {
            throw unavailableError;
        });
        const piper = createProvider('piper');
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        const result = await service.synthesize({
            text: 'Hello there.',
        });

        expect(kokoro.synthesize).toHaveBeenCalledTimes(1);
        expect(piper.synthesize).toHaveBeenCalledTimes(1);
        expect(result.provider).toBe('piper');
    });

    test('falls back to Piper on retryable Kokoro generation failures', async () => {
        const timeoutError = new Error('Kokoro generation timed out.');
        timeoutError.statusCode = 504;
        timeoutError.code = 'tts_timeout';
        const kokoro = createProvider('kokoro', 'ready', async () => {
            throw timeoutError;
        });
        const piper = createProvider('piper');
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        const result = await service.synthesize({
            text: 'Hello there.',
            voiceId: 'af_heart',
        });

        expect(kokoro.synthesize).toHaveBeenCalledTimes(1);
        expect(piper.synthesize).toHaveBeenCalledWith({
            text: 'Hello there.',
            voiceId: '',
        });
        expect(result.provider).toBe('piper');
    });

    test('keeps fallback failures from replacing the primary provider context', async () => {
        const timeoutError = new Error('Kokoro generation timed out.');
        timeoutError.statusCode = 504;
        timeoutError.code = 'tts_timeout';
        const piperTimeout = new Error('Piper TTS timed out before audio generation completed.');
        piperTimeout.statusCode = 504;
        piperTimeout.code = 'tts_timeout';
        const kokoro = createProvider('kokoro', 'ready', async () => {
            throw timeoutError;
        });
        const piper = createProvider('piper', 'ready', async () => {
            throw piperTimeout;
        });
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        await expect(service.synthesize({
            text: 'Hello there.',
            voiceId: 'af_heart',
        })).rejects.toMatchObject({
            code: 'tts_fallback_failed',
            primary: expect.objectContaining({
                provider: 'kokoro',
                message: 'Kokoro generation timed out.',
            }),
            fallback: expect.objectContaining({
                provider: 'piper',
                message: 'Piper TTS timed out before audio generation completed.',
            }),
        });
    });

    test('returns an unavailable payload when no provider is configured', async () => {
        const service = new TtsService({ provider: 'kokoro', fallbackProvider: '' }, {
            kokoro: null,
            piper: null,
        });

        expect(service.getPublicConfig()).toEqual(expect.objectContaining({
            configured: false,
            provider: 'none',
            voices: [],
            providers: [],
            diagnostics: expect.objectContaining({
                status: 'unavailable',
                voicesLoaded: false,
            }),
        }));

        await expect(service.synthesize({
            text: 'Hello there.',
        })).rejects.toMatchObject({
            statusCode: 503,
            code: 'tts_unavailable',
        });
    });

    test('surfaces validation synthesis errors without fallback behavior', async () => {
        const kokoroError = new Error('Kokoro failed');
        kokoroError.statusCode = 400;
        kokoroError.code = 'unknown_voice';

        const kokoro = createProvider('kokoro', 'ready', async () => {
            throw kokoroError;
        });
        const piper = createProvider('piper');
        const service = new TtsService({
            provider: 'kokoro',
            fallbackProvider: 'piper',
        }, {
            kokoro,
            piper,
        });

        await expect(service.synthesize({
            text: 'Hello there.',
            voiceId: 'af_heart',
        })).rejects.toThrow('Kokoro failed');

        expect(kokoro.synthesize).toHaveBeenCalledTimes(1);
        expect(piper.synthesize).not.toHaveBeenCalled();
    });
});

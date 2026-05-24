const { KokoroHttpTtsService } = require('./kokoro-http-tts-service');

function createHeaders(values = {}) {
    const normalized = Object.entries(values).reduce((acc, [key, value]) => {
        acc[key.toLowerCase()] = value;
        return acc;
    }, {});
    return {
        get: jest.fn((key) => normalized[String(key || '').toLowerCase()] || null),
    };
}

describe('KokoroHttpTtsService', () => {
    test('posts normalized synthesis requests to the remote Kokoro service', async () => {
        const fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: createHeaders({
                'content-type': 'audio/wav',
                'x-tts-voice-id': 'af_heart',
                'x-tts-voice-label': 'Heart Studio',
            }),
            arrayBuffer: async () => Buffer.from('RIFF-remote-audio'),
        }));
        const service = new KokoroHttpTtsService({
            baseURL: 'http://kokoro-tts:3001/',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            defaultVoiceId: 'af_heart',
            timeoutMs: 5000,
        }, { fetch });

        const result = await service.synthesize({
            text: 'Hello **there**',
            voiceId: 'af_heart',
        });

        expect(fetch).toHaveBeenCalledWith('http://kokoro-tts:3001/synthesize', expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                'Content-Type': 'application/json',
                Connection: 'close',
            }),
            body: JSON.stringify({
                text: 'Hello there.',
                voiceId: 'af_heart',
                timeoutMs: 5000,
            }),
        }));
        expect(result).toEqual(expect.objectContaining({
            provider: 'kokoro',
            contentType: 'audio/wav',
            text: 'Hello there.',
            voice: expect.objectContaining({ id: 'af_heart', provider: 'kokoro' }),
        }));
        expect(result.audioBuffer.equals(Buffer.from('RIFF-remote-audio'))).toBe(true);
    });

    test('maps remote error payloads to service errors', async () => {
        const fetch = jest.fn(async () => ({
            ok: false,
            status: 504,
            headers: createHeaders(),
            json: async () => ({
                error: {
                    type: 'tts_timeout',
                    message: 'Remote Kokoro timed out.',
                },
            }),
        }));
        const service = new KokoroHttpTtsService({
            baseURL: 'http://kokoro-tts:3001',
            voices: [{ id: 'af_heart' }],
            httpRetryAttempts: 1,
        }, { fetch });

        await expect(service.synthesize({
            text: 'Hello.',
            voiceId: 'af_heart',
        })).rejects.toMatchObject({
            statusCode: 504,
            code: 'tts_timeout',
            message: 'Remote Kokoro timed out.',
        });
    });

    test('retries retryable remote Kokoro failures before surfacing an error', async () => {
        const fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 503,
                headers: createHeaders(),
                json: async () => ({
                    error: {
                        type: 'tts_unavailable',
                        message: 'Worker crashed.',
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: createHeaders({
                    'content-type': 'audio/wav',
                    'x-tts-voice-id': 'af_heart',
                }),
                arrayBuffer: async () => Buffer.from('RIFF-retried-audio'),
            });
        const service = new KokoroHttpTtsService({
            baseURL: 'http://kokoro-tts:3001',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            httpRetryAttempts: 2,
            httpRetryDelayMs: 0,
        }, { fetch });

        const result = await service.synthesize({
            text: 'Retry me',
            voiceId: 'af_heart',
        });

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(result.audioBuffer.equals(Buffer.from('RIFF-retried-audio'))).toBe(true);
    });
});

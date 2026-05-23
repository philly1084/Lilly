const express = require('express');
const request = require('supertest');

jest.mock('../middleware/validate', () => ({
    validate: () => (_req, _res, next) => next(),
}));

jest.mock('../tts/tts-service', () => ({
    ttsService: {
        getPublicConfig: jest.fn(),
        synthesize: jest.fn(),
    },
}));

const { ttsService } = require('../tts/tts-service');
const ttsRouter = require('./tts');

describe('/api/tts', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        ttsService.getPublicConfig.mockReturnValue({
            configured: true,
            provider: 'kokoro',
            defaultVoiceId: 'af_heart',
            diagnostics: {
                status: 'ready',
                modelReachable: true,
                voicesLoaded: true,
                message: 'Kokoro voice playback is ready.',
            },
            voices: [{
                id: 'af_heart',
                label: 'Heart Studio',
                description: 'Warm and natural local voice.',
                provider: 'kokoro',
            }],
        });
    });

    test('returns voice availability', async () => {
        const app = express();
        app.use('/api/tts', ttsRouter);

        const response = await request(app).get('/api/tts/voices');

        expect(response.status).toBe(200);
        expect(response.body).toEqual(expect.objectContaining({
            configured: true,
            provider: 'kokoro',
            defaultVoiceId: 'af_heart',
            diagnostics: expect.objectContaining({
                status: 'ready',
                voicesLoaded: true,
            }),
        }));
    });

    test('returns synthesized wav audio', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/tts', ttsRouter);

        const buffer = Buffer.from('RIFF-test-audio');
        ttsService.synthesize.mockResolvedValue({
            audioBuffer: buffer,
            contentType: 'audio/wav',
            provider: 'kokoro',
            voice: {
                id: 'af_heart',
                label: 'Heart Studio',
            },
        });

        const response = await request(app)
            .post('/api/tts/synthesize')
            .send({
                text: 'Hello from Kokoro.',
                voiceId: 'af_heart',
                timeoutMs: 12000,
                allowProviderFallback: true,
            });

        expect(response.status).toBe(200);
        expect(ttsService.synthesize).toHaveBeenCalledWith({
            text: 'Hello from Kokoro.',
            voiceId: 'af_heart',
            provider: '',
            timeoutMs: 12000,
            allowProviderFallback: true,
        });
        expect(response.headers['content-type']).toMatch(/audio\/wav/);
        expect(response.headers['x-tts-provider']).toBe('kokoro');
        expect(response.headers['x-tts-voice-id']).toBe('af_heart');
        expect(response.body.equals(buffer)).toBe(true);
    });

    test('returns JSON errors for known TTS failures', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/tts', ttsRouter);

        const error = new Error('Kokoro TTS is not configured.');
        error.statusCode = 503;
        error.code = 'tts_unavailable';
        ttsService.synthesize.mockRejectedValue(error);

        const response = await request(app)
            .post('/api/tts/synthesize')
            .send({
                text: 'Hello from Kokoro.',
            });

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
            error: {
                type: 'tts_unavailable',
                message: 'Kokoro TTS is not configured.',
            },
        });
    });
});

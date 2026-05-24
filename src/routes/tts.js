const { Router } = require('express');
const { validate } = require('../middleware/validate');
const { ttsService } = require('../tts/tts-service');

const router = Router();

const synthesizeSchema = {
    text: { required: true, type: 'string' },
    voiceId: { required: false, type: 'string' },
    provider: { required: false, type: 'string' },
    timeoutMs: { required: false, type: 'number' },
    allowProviderFallback: { required: false, type: 'boolean' },
};

router.get('/voices', (_req, res) => {
    res.json(ttsService.getPublicConfig());
});

router.post('/synthesize', validate(synthesizeSchema), async (req, res, next) => {
    try {
        const result = await ttsService.synthesize({
            text: req.body.text,
            voiceId: req.body.voiceId || '',
            provider: req.body.provider || '',
            timeoutMs: req.body.timeoutMs,
            allowProviderFallback: req.body.allowProviderFallback,
        });

        res.setHeader('Content-Type', result.contentType || 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-TTS-Provider', result.provider || 'unknown');
        res.setHeader('X-TTS-Voice-Id', result.voice?.id || '');
        res.setHeader('X-TTS-Voice-Label', result.voice?.label || '');
        if (result.fallback?.providerFallback) {
            res.setHeader('X-TTS-Fallback-Provider', result.fallback.toProvider || '');
            res.setHeader('X-TTS-Fallback-Reason', result.fallback.reason?.code || '');
        }
        res.send(result.audioBuffer);
    } catch (error) {
        if (error?.statusCode) {
            const payload = {
                type: error.code || 'tts_error',
                message: error.message || 'TTS synthesis failed.',
            };
            if (error.primary || error.fallback) {
                payload.details = {
                    ...(error.primary ? { primary: error.primary } : {}),
                    ...(error.fallback ? { fallback: error.fallback } : {}),
                };
            }
            return res.status(error.statusCode).json({
                error: payload,
            });
        }

        return next(error);
    }
});

module.exports = router;

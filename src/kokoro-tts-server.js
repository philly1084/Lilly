const express = require('express');
const { config } = require('./config');
const { KokoroTtsService } = require('./tts/kokoro-tts-service');

const port = parseInt(process.env.KOKORO_TTS_PORT || process.env.PORT, 10) || 3001;
const ttsService = new KokoroTtsService({
    ...(config.tts?.kokoro || {}),
    workerEnabled: true,
});
const app = express();

const startupState = {
    ready: false,
    warming: false,
    startedAt: new Date().toISOString(),
    lastError: '',
};

app.use(express.json({ limit: '2mb' }));

app.get('/live', (_req, res) => {
    res.status(200).json({
        status: 'live',
        timestamp: new Date().toISOString(),
    });
});

app.get('/ready', (_req, res) => {
    const publicConfig = ttsService.getPublicConfig();
    const ready = startupState.ready && publicConfig.configured;
    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'starting',
        warming: startupState.warming,
        startedAt: startupState.startedAt,
        lastError: startupState.lastError || null,
        diagnostics: publicConfig.diagnostics,
        timestamp: new Date().toISOString(),
    });
});

app.get('/voices', (_req, res) => {
    res.json(ttsService.getPublicConfig());
});

app.post('/synthesize', async (req, res) => {
    const startedAt = Date.now();
    const textLength = String(req.body?.text || '').length;
    const voiceId = req.body?.voiceId || '';
    try {
        console.log(`[KokoroTTS] Synthesis started voice=${voiceId || 'default'} chars=${textLength}`);
        const result = await ttsService.synthesize({
            text: req.body?.text || '',
            voiceId: req.body?.voiceId || '',
            timeoutMs: req.body?.timeoutMs,
        });

        res.setHeader('Content-Type', result.contentType || 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-TTS-Provider', result.provider || 'kokoro');
        res.setHeader('X-TTS-Voice-Id', result.voice?.id || '');
        res.setHeader('X-TTS-Voice-Label', result.voice?.label || '');
        res.send(result.audioBuffer);
        console.log(`[KokoroTTS] Synthesis completed voice=${result.voice?.id || voiceId || 'default'} chars=${textLength} bytes=${result.audioBuffer?.length || 0} durationMs=${Date.now() - startedAt}`);
    } catch (error) {
        const statusCode = error?.statusCode || 500;
        console.error(`[KokoroTTS] Synthesis failed voice=${voiceId || 'default'} chars=${textLength} durationMs=${Date.now() - startedAt}: ${error?.message || 'unknown error'}`);
        res.status(statusCode).json({
            error: {
                type: error?.code || 'tts_error',
                message: error?.message || 'Kokoro TTS failed.',
            },
        });
    }
});

app.use((_req, res) => {
    res.status(404).json({ error: { message: 'Not found' } });
});

async function warmModel() {
    if (startupState.warming || startupState.ready) {
        return;
    }

    startupState.warming = true;
    startupState.lastError = '';
    try {
        await ttsService.getModel();
        startupState.ready = true;
        console.log('[KokoroTTS] Model loaded and ready.');
    } catch (error) {
        startupState.ready = false;
        startupState.lastError = error?.message || 'Kokoro TTS model failed to load.';
        console.error(`[KokoroTTS] Model warmup failed: ${startupState.lastError}`);
        setTimeout(warmModel, 30000).unref?.();
    } finally {
        startupState.warming = false;
    }
}

const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[KokoroTTS] Listening on http://0.0.0.0:${port}`);
    warmModel();
});

module.exports = {
    app,
    server,
    ttsService,
};

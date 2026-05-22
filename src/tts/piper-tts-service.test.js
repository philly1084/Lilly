const { normalizeTextForSpeech, PiperTtsService } = require('./piper-tts-service');

describe('normalizeTextForSpeech', () => {
    test('converts markdown into speech-friendly sentences', () => {
        const normalized = normalizeTextForSpeech(`
# Release plan

- Ship the API route
- Add the web chat button

\`\`\`js
console.log('hidden');
\`\`\`

Read the [docs](https://example.com/docs).
        `, 600);

        expect(normalized).toContain('Release plan.');
        expect(normalized).toContain('Ship the API route.');
        expect(normalized).toContain('Add the web chat button.');
        expect(normalized).toContain('Code example omitted.');
        expect(normalized).toContain('Read the docs.');
        expect(normalized).not.toContain('console.log');
    });

    test('keeps a fallback sentence when content is only code', () => {
        expect(normalizeTextForSpeech('```js\nconst hidden = true;\n```', 200))
            .toContain('Code example omitted.');
    });

    test('clamps long speech requests', () => {
        const normalized = normalizeTextForSpeech('A '.repeat(1000), 320);
        expect(normalized.length).toBeLessThanOrEqual(323);
        expect(normalized.endsWith('...')).toBe(true);
    });

    test('strips malformed unicode escapes and unpaired surrogates before speech normalization', () => {
        const normalized = normalizeTextForSpeech('Broken \\\\u12 text \uD800 and a clean sentence.', 400);
        expect(normalized).toContain('Broken');
        expect(normalized).toContain('text');
        expect(normalized).toContain('and a clean sentence.');
        expect(normalized).not.toContain('\\u12');
        expect(normalized).not.toContain('\uD800');
    });

    test('turns raw URLs and bare domains into speakable website names', () => {
        const normalized = normalizeTextForSpeech(
            'Open https://www.example.com/docs, then check lilly.secdevsolutions.help/live.',
            500,
        );

        expect(normalized).toContain('Open example dot com slash docs');
        expect(normalized).toContain('check lilly dot secdevsolutions dot help slash live');
        expect(normalized).not.toContain('https');
        expect(normalized).not.toContain('www.');
    });
});

describe('PiperTtsService voice manifests', () => {
    test('returns multiple configured voices and honors the default voice id', () => {
        const service = new PiperTtsService({
            enabled: true,
            binaryPath: 'piper',
            defaultVoiceId: 'amy-soft',
            voices: [
                {
                    id: 'amy-soft',
                    label: 'Amy soft',
                    description: 'Balanced female voice.',
                    modelPath: 'amy.onnx',
                },
                {
                    id: 'kathleen-soft',
                    label: 'Kathleen soft',
                    description: 'Gentle female voice.',
                    modelPath: 'kathleen.onnx',
                },
            ],
        });

        expect(service.isConfigured()).toBe(true);
        expect(service.getPublicConfig()).toEqual(expect.objectContaining({
            configured: true,
            defaultVoiceId: 'amy-soft',
            diagnostics: expect.objectContaining({
                status: 'ready',
                binaryReachable: true,
                voicesLoaded: true,
            }),
            voices: [
                expect.objectContaining({ id: 'amy-soft', label: 'Amy soft' }),
                expect.objectContaining({ id: 'kathleen-soft', label: 'Kathleen soft' }),
            ],
        }));
    });

    test('reports a misconfigured state when the Piper binary path is missing', () => {
        const service = new PiperTtsService({
            enabled: true,
            binaryPath: 'C:\\missing\\piper.exe',
            voices: [
                {
                    id: 'amy-soft',
                    label: 'Amy soft',
                    description: 'Balanced female voice.',
                    modelPath: 'C:\\voices\\amy.onnx',
                },
            ],
        });

        expect(service.isConfigured()).toBe(false);
        expect(service.getPublicConfig()).toEqual(expect.objectContaining({
            configured: false,
            diagnostics: expect.objectContaining({
                status: 'misconfigured',
                binaryReachable: false,
                message: expect.stringContaining('Piper binary is missing'),
            }),
        }));
    });
});

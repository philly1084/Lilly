const {
    DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
    DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
    DEFAULT_TTS_SYNTHESIS_LANES,
    WebChatTtsManager,
    normalizeTextForSpeech,
    splitTextIntoSpeechChunks,
} = require('./tts-manager');

describe('splitTextIntoSpeechChunks', () => {
    test('normalizes raw websites before chunking for speech', () => {
        const normalized = normalizeTextForSpeech(
            'Open https://www.example.com/docs, then check lilly.secdevsolutions.help/live.',
        );

        expect(normalized).toContain('Open example dot com slash docs');
        expect(normalized).toContain('check lilly dot secdevsolutions dot help slash live');
        expect(normalized).not.toContain('https');
        expect(normalized).not.toContain('www.');
    });

    test('starts with one sentence then groups later speech to reduce long-run synthesis waits', () => {
        const chunks = splitTextIntoSpeechChunks(
            'One. Two. Three. Four. Five. Six. Seven. Eight.',
            {
                absoluteMaxChars: 2400,
                targetChunkChars: 520,
                firstChunkMaxSentences: DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
                maxSentencesPerChunk: DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
            },
        );

        expect(chunks).toEqual([
            'One.',
            'Two.',
            'Three. Four. Five.',
            'Six. Seven. Eight.',
        ]);
    });

    test('keeps oversized chunks under the absolute char limit after grouping sentences', () => {
        const chunks = splitTextIntoSpeechChunks(
            [
                'This sentence is intentionally verbose so the realtime chunker has to split it before playback can stay smooth.',
                'Another fairly long sentence gives the lookahead queue something realistic to chew on.',
                'A shorter sentence closes the paragraph cleanly.',
            ].join(' '),
            {
                absoluteMaxChars: 140,
                targetChunkChars: 120,
                firstChunkMaxSentences: DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
                maxSentencesPerChunk: DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
            },
        );

        expect(chunks.length).toBeGreaterThanOrEqual(3);
        expect(chunks.every((chunk) => chunk.length <= 140)).toBe(true);
        expect(chunks[0]).toMatch(/^This sentence is intentionally verbose/);
    });

    test('keeps markdown bullet sections as separate speech chunks', () => {
        const chunks = splitTextIntoSpeechChunks(
            '- "Alpha" item\n- "Beta" item\n\nClosing paragraph sentence one. Closing paragraph sentence two.',
            {
                absoluteMaxChars: 2400,
                targetChunkChars: 520,
                firstChunkMaxSentences: DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
                maxSentencesPerChunk: DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
            },
        );

        expect(chunks).toEqual([
            '"Alpha" item.',
            '"Beta" item.',
            'Closing paragraph sentence one.',
            'Closing paragraph sentence two.',
        ]);
    });

    test('starts the first sentence as soon as it is ready while queueing extra lanes', async () => {
        const previousCustomEvent = global.CustomEvent;
        global.CustomEvent = class CustomEvent extends Event {
            constructor(type, params = {}) {
                super(type);
                this.detail = params.detail;
            }
        };

        try {
            const manager = new WebChatTtsManager();
            manager.playbackToken = 1;

            const startedAt = [];
            const fakeContext = {
                currentTime: 0,
                destination: {},
                createBufferSource: () => {
                    const sourceNode = {
                        buffer: null,
                        onended: null,
                        connect: jest.fn(),
                        disconnect: jest.fn(),
                        start: jest.fn((time) => {
                            startedAt.push(time);
                            setImmediate(() => sourceNode.onended?.());
                        }),
                        stop: jest.fn(),
                    };
                    return sourceNode;
                },
                createGain: () => ({
                    gain: { value: 1 },
                    connect: jest.fn(),
                    disconnect: jest.fn(),
                }),
            };
            const preparedTexts = [];
            const resolvers = [];
            manager.preparePlayback = jest.fn(async () => fakeContext);
            manager.synthesizeAndPrepareMessageAudio = jest.fn((text) => {
                preparedTexts.push(text);
                return new Promise((resolve) => {
                    resolvers.push(() => resolve({
                        decodedBuffer: { duration: 1 },
                        playbackContext: fakeContext,
                    }));
                });
            });

            const playbackPromise = manager.speakPiperChunks({
                messageId: 'assistant-1',
                text: 'One. Two. Three. Four. Five.',
                playbackToken: 1,
                playbackContext: fakeContext,
            });

            await Promise.resolve();
            expect(preparedTexts).toEqual(['One.', 'Two.', 'Three. Four. Five.']);
            expect(preparedTexts).toHaveLength(DEFAULT_TTS_SYNTHESIS_LANES);
            expect(startedAt).toEqual([]);

            resolvers[0]();
            await Promise.resolve();
            await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            expect(startedAt).toHaveLength(1);

            resolvers[1]();
            await Promise.resolve();
            await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            expect(startedAt).toHaveLength(2);

            resolvers.slice(2).forEach((resolve) => resolve());
            await expect(playbackPromise).resolves.toBe(true);
            expect(startedAt).toHaveLength(3);
        } finally {
            global.CustomEvent = previousCustomEvent;
        }
    });
});

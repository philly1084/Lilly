const {
    DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
    DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
    WebChatTtsManager,
    splitTextIntoSpeechChunks,
} = require('./tts-manager');

describe('splitTextIntoSpeechChunks', () => {
    test('keeps speech in sentence-sized chunks for continuous lookahead playback', () => {
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
            'Three.',
            'Four.',
            'Five.',
            'Six.',
            'Seven.',
            'Eight.',
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

    test('prepares upcoming sentence audio before the first sentence is scheduled', async () => {
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
                text: 'One. Two. Three.',
                playbackToken: 1,
                playbackContext: fakeContext,
            });

            await Promise.resolve();
            expect(preparedTexts).toEqual(['One.', 'Two.']);
            expect(startedAt).toEqual([]);

            resolvers[0]();
            await Promise.resolve();
            await Promise.resolve();
            expect(preparedTexts).toEqual(['One.', 'Two.', 'Three.']);

            resolvers.slice(1).forEach((resolve) => resolve());
            await expect(playbackPromise).resolves.toBe(true);
            expect(startedAt).toHaveLength(3);
        } finally {
            global.CustomEvent = previousCustomEvent;
        }
    });
});

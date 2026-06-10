const {
    DEFAULT_PIPER_FIRST_CHUNK_SENTENCES,
    DEFAULT_PIPER_MAX_SENTENCES_PER_CHUNK,
    DEFAULT_REALTIME_SYNTHESIS_LANES,
    WebChatTtsManager,
    normalizeRealtimeEmergencyProvider,
    normalizeTextForSpeech,
    splitTextIntoSpeechChunks,
} = require('./tts-manager');

function createFakeAudioBuffer(samples = [], sampleRate = 1000) {
    const data = Float32Array.from(samples);
    return {
        length: data.length,
        sampleRate,
        numberOfChannels: 1,
        duration: data.length / sampleRate,
        getChannelData: () => data,
    };
}

function createFakeAudioContext() {
    return {
        createBuffer: (_channelCount, length, sampleRate) => {
            const data = new Float32Array(length);
            return {
                length,
                sampleRate,
                numberOfChannels: 1,
                duration: length / sampleRate,
                getChannelData: () => data,
            };
        },
    };
}

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
            expect(preparedTexts).toHaveLength(Math.min(DEFAULT_REALTIME_SYNTHESIS_LANES, 3));
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

    test('waits for the actual audio end event before starting the next sentence', async () => {
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

            const sources = [];
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
                        }),
                        stop: jest.fn(),
                    };
                    sources.push(sourceNode);
                    return sourceNode;
                },
                createGain: () => ({
                    gain: { value: 1 },
                    connect: jest.fn(),
                    disconnect: jest.fn(),
                }),
            };

            manager.preparePlayback = jest.fn(async () => fakeContext);
            manager.synthesizeRealtimeChunkAudio = jest.fn(async () => ({
                decodedBuffer: { duration: 0.01 },
                playbackContext: fakeContext,
            }));

            const playbackPromise = manager.speakPiperChunks({
                messageId: 'assistant-1',
                text: 'One. Two. Three.',
                playbackToken: 1,
                playbackContext: fakeContext,
            });

            await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            expect(startedAt).toHaveLength(1);
            expect(sources).toHaveLength(1);

            await new Promise((resolve) => setImmediate(resolve));
            expect(startedAt).toHaveLength(1);

            sources[0].onended?.();
            await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            expect(startedAt).toHaveLength(2);
            expect(sources).toHaveLength(2);

            sources[1].onended?.();
            await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            expect(startedAt).toHaveLength(3);
            expect(sources).toHaveLength(3);

            sources[2].onended?.();
            await expect(playbackPromise).resolves.toBe(true);
        } finally {
            global.CustomEvent = previousCustomEvent;
        }
    });

    test('does not hedge realtime chunks through Piper by default', async () => {
        const manager = new WebChatTtsManager();
        manager.realtimePolicy = {
            ...manager.realtimePolicy,
            hedgeDelayMs: 1,
            emergencyProvider: 'piper',
        };
        manager.decodeAudioBlob = jest.fn(async (blob) => ({
            context: 'ctx',
            decodedBuffer: {
                duration: blob.provider === 'piper' ? 0.4 : 0.8,
            },
        }));

        const requests = [];
        manager.synthesizeMessageAudio = jest.fn((_text, _messageId, options) => {
            requests.push(options);
            return Promise.resolve({
                blob: { provider: 'kokoro' },
                provider: 'kokoro',
            });
        });

        const result = await manager.synthesizeRealtimeChunkAudio('Slow small sentence.', 'assistant-1', {
            playbackContext: 'ctx',
        });

        expect(result.provider).toBe('kokoro');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toEqual(expect.objectContaining({
            allowProviderFallback: false,
        }));
    });

    test('keeps the primary Kokoro error visible when realtime Piper fallback is configured but not allowed', async () => {
        const manager = new WebChatTtsManager();
        manager.realtimePolicy = {
            ...manager.realtimePolicy,
            hedgeDelayMs: 1,
            emergencyProvider: 'piper',
        };

        manager.synthesizeMessageAudio = jest.fn((_text, _messageId, options) => {
            const error = new Error('Remote Kokoro TTS timed out before audio generation completed.');
            error.code = 'tts_timeout';
            return Promise.reject(error);
        });

        await expect(manager.synthesizeRealtimeChunkAudio('Slow small sentence.', 'assistant-1', {
            playbackContext: 'ctx',
        })).rejects.toThrow('Remote Kokoro TTS timed out');

        expect(manager.synthesizeMessageAudio).toHaveBeenNthCalledWith(
            1,
            'Slow small sentence.',
            'assistant-1',
            expect.objectContaining({ allowProviderFallback: false }),
        );
        expect(manager.synthesizeMessageAudio).toHaveBeenCalledTimes(1);
    });

    test('normalizes realtime emergency provider to keep the high-quality path', () => {
        expect(normalizeRealtimeEmergencyProvider('piper', 'kokoro')).toBe('');
        expect(normalizeRealtimeEmergencyProvider('kokoro', 'kokoro')).toBe('');
        expect(normalizeRealtimeEmergencyProvider('', 'kokoro')).toBe('');
        expect(normalizeRealtimeEmergencyProvider('piper', 'kokoro', {
            allowEmergencyProviderFallback: true,
        })).toBe('piper');
    });

    test('defaults realtime Kokoro chunks to a natural pacing size', () => {
        const manager = new WebChatTtsManager();

        expect(manager.realtimePolicy.chunkTargetChars).toBe(360);
        expect(manager.realtimePolicy.primaryTimeoutMs).toBe(8000);
        expect(manager.realtimePolicy.fallbackTimeoutMs).toBe(7000);
        expect(manager.realtimePolicy.chunkStallMs).toBe(2500);
    });

    test('trims end-of-sentence silence while preserving a final speech tail pad', () => {
        const manager = new WebChatTtsManager();
        manager.realtimePolicy = {
            ...manager.realtimePolicy,
            trimEdgeSeconds: 0.45,
            trimTailPaddingSeconds: 0.14,
            trimThreshold: 0.0015,
        };
        const samples = [
            ...Array(600).fill(0.02),
            ...Array(400).fill(0),
        ];

        const trimmed = manager.trimDecodedAudioBuffer(
            createFakeAudioBuffer(samples, 1000),
            createFakeAudioContext(),
        );

        expect(trimmed.length).toBe(740);
        Array.from(trimmed.getChannelData(0)).slice(0, 600).forEach((sample) => {
            expect(sample).toBeCloseTo(0.02, 6);
        });
    });

    test('does not trim short quiet sentence tails', () => {
        const manager = new WebChatTtsManager();
        manager.realtimePolicy = {
            ...manager.realtimePolicy,
            trimEdgeSeconds: 0.45,
            trimTailPaddingSeconds: 0.14,
            trimThreshold: 0.0015,
        };
        const audioBuffer = createFakeAudioBuffer([
            ...Array(600).fill(0.02),
            ...Array(80).fill(0),
        ], 1000);

        const trimmed = manager.trimDecodedAudioBuffer(audioBuffer, createFakeAudioContext());

        expect(trimmed).toBe(audioBuffer);
    });

    test('can skip a stalled chunk only when the realtime policy allows it', async () => {
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
            manager.realtimePolicy = {
                ...manager.realtimePolicy,
                chunkStallMs: 1,
                skipStalledChunks: true,
                allowContentSkipping: true,
                synthesisLanes: 4,
                synthesisLookahead: 4,
            };

            const fakeContext = {
                currentTime: 0,
                destination: {},
                createBufferSource: () => {
                    const sourceNode = {
                        buffer: null,
                        onended: null,
                        connect: jest.fn(),
                        disconnect: jest.fn(),
                        start: jest.fn(() => setImmediate(() => sourceNode.onended?.())),
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
            const scheduledChunks = [];
            manager.preparePlayback = jest.fn(async () => fakeContext);
            manager.synthesizeRealtimeChunkAudio = jest.fn((text) => {
                if (text === 'Two.') {
                    return new Promise(() => {});
                }

                return Promise.resolve({
                    decodedBuffer: { duration: 1 },
                    playbackContext: fakeContext,
                });
            });
            manager.scheduleDecodedAudioBuffer = jest.fn((decodedBuffer, messageId, options) => {
                scheduledChunks.push(options.chunkText);
                if (options.isFinalChunk) {
                    setImmediate(() => manager.resolvePlaybackWaiter(true));
                }
                return {
                    playbackContext: fakeContext,
                    startTime: scheduledChunks.length,
                    endTime: scheduledChunks.length + 1,
                };
            });

            const playbackPromise = manager.speakPiperChunks({
                messageId: 'assistant-1',
                text: 'One. Two. Three. Four.',
                playbackToken: 1,
                playbackContext: fakeContext,
            });

            await expect(playbackPromise).resolves.toBe(true);
            expect(scheduledChunks).toEqual(['One.', 'Three. Four.']);
        } finally {
            global.CustomEvent = previousCustomEvent;
        }
    });

    test('waits for stalled chunks unless content skipping is explicitly allowed', async () => {
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
            manager.realtimePolicy = {
                ...manager.realtimePolicy,
                chunkStallMs: 1,
                skipStalledChunks: true,
                allowContentSkipping: false,
                synthesisLanes: 4,
                synthesisLookahead: 4,
            };

            const fakeContext = {
                currentTime: 0,
                destination: {},
                createBufferSource: () => {
                    const sourceNode = {
                        buffer: null,
                        onended: null,
                        connect: jest.fn(),
                        disconnect: jest.fn(),
                        start: jest.fn(() => setImmediate(() => sourceNode.onended?.())),
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
            const scheduledChunks = [];
            manager.preparePlayback = jest.fn(async () => fakeContext);
            manager.synthesizeRealtimeChunkAudio = jest.fn((text) => {
                if (text === 'Two.') {
                    return new Promise((resolve) => {
                        setTimeout(() => resolve({
                            decodedBuffer: { duration: 1 },
                            playbackContext: fakeContext,
                        }), 20);
                    });
                }

                return Promise.resolve({
                    decodedBuffer: { duration: 1 },
                    playbackContext: fakeContext,
                });
            });
            manager.scheduleDecodedAudioBuffer = jest.fn((decodedBuffer, messageId, options) => {
                scheduledChunks.push(options.chunkText);
                if (options.isFinalChunk) {
                    setImmediate(() => manager.resolvePlaybackWaiter(true));
                }
                return {
                    playbackContext: fakeContext,
                    startTime: scheduledChunks.length,
                    endTime: scheduledChunks.length + 1,
                };
            });

            const playbackPromise = manager.speakPiperChunks({
                messageId: 'assistant-1',
                text: 'One. Two. Three. Four.',
                playbackToken: 1,
                playbackContext: fakeContext,
            });

            await expect(playbackPromise).resolves.toBe(true);
            expect(scheduledChunks).toEqual(['One.', 'Two.', 'Three. Four.']);
        } finally {
            global.CustomEvent = previousCustomEvent;
        }
    });
});

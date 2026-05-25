const { KokoroTtsService } = require('./kokoro-tts-service');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

function createAudio(wav = Buffer.from('RIFF-kokoro-audio')) {
    return {
        toWav: jest.fn(() => wav),
    };
}

describe('KokoroTtsService', () => {
    test('exposes configured voices and resolves aliases', () => {
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
            defaultVoiceId: 'af_heart',
            voices: [{
                id: 'af_heart',
                label: 'Heart Studio',
                aliases: ['lessac-high'],
            }],
        });

        expect(service.getPublicConfig()).toEqual(expect.objectContaining({
            configured: true,
            provider: 'kokoro',
            defaultVoiceId: 'af_heart',
            voices: [
                expect.objectContaining({
                    id: 'af_heart',
                    provider: 'kokoro',
                    aliases: ['lessac-high'],
                }),
            ],
            diagnostics: expect.objectContaining({
                status: 'ready',
                voicesLoaded: true,
            }),
        }));
        expect(service.resolveVoiceProfile('lessac-high')).toEqual(expect.objectContaining({
            id: 'af_heart',
        }));
    });

    test('returns synthesized wav audio from the Kokoro runtime', async () => {
        const generate = jest.fn(async () => createAudio());
        const fromPretrained = jest.fn(async () => ({ generate }));
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            timeoutMs: 5000,
        }, {
            importKokoro: () => ({
                KokoroTTS: {
                    from_pretrained: fromPretrained,
                },
            }),
        });

        const result = await service.synthesize({
            text: 'Hello **there**',
            voiceId: 'af_heart',
        });

        expect(fromPretrained).toHaveBeenCalledWith('test-model', {
            dtype: 'q8',
            device: 'cpu',
        });
        expect(generate).toHaveBeenCalledWith('Hello there.', {
            voice: 'af_heart',
            speed: 1,
        });
        expect(result).toEqual(expect.objectContaining({
            provider: 'kokoro',
            contentType: 'audio/wav',
            text: 'Hello there.',
            voice: expect.objectContaining({ id: 'af_heart', provider: 'kokoro' }),
        }));
        expect(result.audioBuffer.equals(Buffer.from('RIFF-kokoro-audio'))).toBe(true);
    });

    test('configures Transformers runtime before loading the model', async () => {
        const transformersEnv = {};
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-kokoro-cache-'));
        const fromPretrained = jest.fn(async () => ({ generate: jest.fn() }));
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            cacheDir,
            localModelPath: '/models',
            allowRemoteModels: false,
        }, {
            importTransformers: () => ({ env: transformersEnv }),
            importKokoro: () => ({
                KokoroTTS: {
                    from_pretrained: fromPretrained,
                },
            }),
        });

        try {
            await service.getModel();
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }

        expect(transformersEnv).toEqual(expect.objectContaining({
            cacheDir,
            localModelPath: '/models',
            allowRemoteModels: false,
        }));
        expect(fromPretrained).toHaveBeenCalledWith('test-model', {
            dtype: 'q8',
            device: 'cpu',
        });
    });

    test('serializes concurrent generation requests', async () => {
        const events = [];
        let releaseFirst = null;
        let firstStarted = null;
        const firstStartedPromise = new Promise((resolve) => {
            firstStarted = resolve;
        });
        const generate = jest.fn(async (text) => {
            events.push(`start:${text}`);
            if (text === 'First request.') {
                firstStarted();
                await new Promise((resolve) => {
                    releaseFirst = resolve;
                });
            }
            events.push(`finish:${text}`);
            return createAudio(Buffer.from(`RIFF-${text}`));
        });
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            timeoutMs: 5000,
        }, {
            importKokoro: () => ({
                KokoroTTS: {
                    from_pretrained: jest.fn(async () => ({ generate })),
                },
            }),
        });

        const first = service.synthesize({ text: 'First request', voiceId: 'af_heart' });
        await firstStartedPromise;
        const second = service.synthesize({ text: 'Second request', voiceId: 'af_heart' });
        await Promise.resolve();
        await Promise.resolve();

        expect(generate).toHaveBeenCalledTimes(1);
        releaseFirst();
        await Promise.all([first, second]);

        expect(events).toEqual([
            'start:First request.',
            'finish:First request.',
            'start:Second request.',
            'finish:Second request.',
        ]);
    });

    test('runs configured concurrent generation requests in parallel', async () => {
        const events = [];
        let releaseFirst = null;
        let firstStarted = null;
        let secondStarted = null;
        const firstStartedPromise = new Promise((resolve) => {
            firstStarted = resolve;
        });
        const secondStartedPromise = new Promise((resolve) => {
            secondStarted = resolve;
        });
        const generate = jest.fn(async (text) => {
            events.push(`start:${text}`);
            if (text === 'First request.') {
                firstStarted();
                await new Promise((resolve) => {
                    releaseFirst = resolve;
                });
            }
            if (text === 'Second request.') {
                secondStarted();
            }
            events.push(`finish:${text}`);
            return createAudio(Buffer.from(`RIFF-${text}`));
        });
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            timeoutMs: 5000,
            synthesisConcurrency: 2,
        }, {
            importKokoro: () => ({
                KokoroTTS: {
                    from_pretrained: jest.fn(async () => ({ generate })),
                },
            }),
        });

        const first = service.synthesize({ text: 'First request', voiceId: 'af_heart' });
        await firstStartedPromise;
        const second = service.synthesize({ text: 'Second request', voiceId: 'af_heart' });
        await secondStartedPromise;

        expect(generate).toHaveBeenCalledTimes(2);
        expect(events).toEqual([
            'start:First request.',
            'start:Second request.',
            'finish:Second request.',
        ]);

        releaseFirst();
        await Promise.all([first, second]);

        expect(events).toEqual([
            'start:First request.',
            'start:Second request.',
            'finish:Second request.',
            'finish:First request.',
        ]);
    });

    test('keeps timed-out generation in the queue until the underlying work settles', async () => {
        const events = [];
        let releaseFirst = null;
        let firstStarted = null;
        const firstStartedPromise = new Promise((resolve) => {
            firstStarted = resolve;
        });
        const firstGenerated = new Promise((resolve) => {
            releaseFirst = () => {
                events.push('finish:First request.');
                resolve(createAudio(Buffer.from('RIFF-first')));
            };
        });
        const generate = jest.fn((text) => {
            events.push(`start:${text}`);
            if (text === 'First request.') {
                firstStarted();
                return firstGenerated;
            }
            events.push(`finish:${text}`);
            return Promise.resolve(createAudio(Buffer.from('RIFF-second')));
        });
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            timeoutMs: 5000,
        }, {
            importKokoro: () => ({
                KokoroTTS: {
                    from_pretrained: jest.fn(async () => ({ generate })),
                },
            }),
        });

        const first = service.synthesize({
            text: 'First request',
            voiceId: 'af_heart',
            timeoutMs: 1,
        });
        await firstStartedPromise;
        expect(generate).toHaveBeenCalledTimes(1);

        await expect(first).rejects.toMatchObject({
            statusCode: 504,
            code: 'tts_timeout',
        });

        const second = service.synthesize({
            text: 'Second request',
            voiceId: 'af_heart',
            timeoutMs: 5000,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(generate).toHaveBeenCalledTimes(1);

        releaseFirst();
        await second;

        expect(events).toEqual([
            'start:First request.',
            'finish:First request.',
            'start:Second request.',
            'finish:Second request.',
        ]);
    });

    test('delegates warmup and synthesis to a worker when worker mode is enabled', async () => {
        class FakeWorker extends EventEmitter {
            constructor() {
                super();
                this.messages = [];
            }

            postMessage(message) {
                this.messages.push(message);
                if (message.action === 'warm') {
                    setImmediate(() => this.emit('message', {
                        id: message.id,
                        ok: true,
                        result: { warmed: true },
                    }));
                    return;
                }

                setImmediate(() => this.emit('message', {
                    id: message.id,
                    ok: true,
                    result: {
                        provider: 'kokoro',
                        audioBuffer: Uint8Array.from(Buffer.from('RIFF-worker-audio')),
                        contentType: 'audio/wav',
                        text: message.payload.text,
                        voice: { id: message.payload.voiceId, provider: 'kokoro' },
                    },
                }));
            }
        }

        const worker = new FakeWorker();
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            timeoutMs: 5000,
            workerEnabled: true,
        }, {
            createWorker: () => worker,
        });

        await expect(service.getModel()).resolves.toEqual({ warmed: true });
        const result = await service.synthesize({
            text: 'Worker synthesis',
            voiceId: 'af_heart',
        });

        expect(worker.messages.map((message) => message.action)).toEqual(['warm', 'synthesize']);
        expect(worker.messages[1].payload).toEqual(expect.objectContaining({
            text: 'Worker synthesis.',
            voiceId: 'af_heart',
        }));
        expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
        expect(result.audioBuffer.equals(Buffer.from('RIFF-worker-audio'))).toBe(true);
    });

    test('supports process-isolated workers and normalizes IPC buffer payloads', async () => {
        class FakeProcessWorker extends EventEmitter {
            constructor() {
                super();
                this.messages = [];
                this.connected = true;
            }

            send(message) {
                this.messages.push(message);
                setImmediate(() => this.emit('message', {
                    id: message.id,
                    ok: true,
                    result: {
                        provider: 'kokoro',
                        audioBuffer: {
                            type: 'Buffer',
                            data: Array.from(Buffer.from('RIFF-process-worker-audio')),
                        },
                        contentType: 'audio/wav',
                        text: message.payload?.text || '',
                        voice: { id: message.payload?.voiceId || 'af_heart', provider: 'kokoro' },
                    },
                }));
            }

            kill() {
                this.connected = false;
            }
        }

        const worker = new FakeProcessWorker();
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            timeoutMs: 5000,
            workerEnabled: true,
        }, {
            createWorker: () => worker,
        });

        const result = await service.synthesize({
            text: 'Process worker synthesis',
            voiceId: 'af_heart',
        });

        expect(service.getPublicConfig().diagnostics).toEqual(expect.objectContaining({
            workerEnabled: true,
            workerIsolation: 'process',
        }));
        expect(worker.messages.map((message) => message.action)).toEqual(['synthesize']);
        expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
        expect(result.audioBuffer.equals(Buffer.from('RIFF-process-worker-audio'))).toBe(true);
    });

    test('recovers by replacing an isolated worker after a native-style worker exit', async () => {
        const workers = [];

        class FakeProcessWorker extends EventEmitter {
            constructor(index) {
                super();
                this.index = index;
                this.messages = [];
                this.connected = true;
            }

            send(message) {
                this.messages.push(message);
                if (message.payload?.text === 'Crash this worker.') {
                    setImmediate(() => {
                        this.connected = false;
                        this.emit('exit', 133);
                    });
                    return;
                }

                setImmediate(() => this.emit('message', {
                    id: message.id,
                    ok: true,
                    result: {
                        provider: 'kokoro',
                        audioBuffer: Uint8Array.from(Buffer.from(`RIFF-worker-${this.index}`)),
                        contentType: 'audio/wav',
                        text: message.payload?.text || '',
                        voice: { id: message.payload?.voiceId || 'af_heart', provider: 'kokoro' },
                    },
                }));
            }

            kill() {
                this.connected = false;
            }
        }

        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            timeoutMs: 5000,
            workerEnabled: true,
        }, {
            createWorker: () => {
                const worker = new FakeProcessWorker(workers.length);
                workers.push(worker);
                return worker;
            },
        });

        await expect(service.synthesize({
            text: 'Crash this worker',
            voiceId: 'af_heart',
        })).rejects.toMatchObject({
            statusCode: 503,
            code: 'tts_unavailable',
        });

        const result = await service.synthesize({
            text: 'Next request survives',
            voiceId: 'af_heart',
        });

        expect(workers).toHaveLength(2);
        expect(result.audioBuffer.equals(Buffer.from('RIFF-worker-1'))).toBe(true);
    });

    test('caps worker mode to one synthesis lane to avoid unsafe onnxruntime re-entry', async () => {
        let releaseFirst = null;
        let firstPosted = null;
        let firstFinished = null;
        const firstPostedPromise = new Promise((resolve) => {
            firstPosted = resolve;
        });
        const firstFinishedPromise = new Promise((resolve) => {
            firstFinished = resolve;
        });
        const workers = [];

        class FakeWorker extends EventEmitter {
            constructor(index) {
                super();
                this.index = index;
                this.messages = [];
            }

            postMessage(message) {
                this.messages.push(message);
                if (message.action === 'warm') {
                    setImmediate(() => this.emit('message', {
                        id: message.id,
                        ok: true,
                        result: { warmed: true, workerIndex: this.index },
                    }));
                    return;
                }

                if (message.payload?.text === 'First worker request.') {
                    firstPosted();
                    releaseFirst = () => {
                        this.emit('message', {
                            id: message.id,
                            ok: true,
                            result: {
                                provider: 'kokoro',
                                audioBuffer: Uint8Array.from(Buffer.from('RIFF-first-worker')),
                                contentType: 'audio/wav',
                                text: message.payload.text,
                                voice: { id: message.payload.voiceId, provider: 'kokoro' },
                            },
                        });
                        firstFinished();
                    };
                    return;
                }

                setImmediate(() => this.emit('message', {
                    id: message.id,
                    ok: true,
                    result: {
                        provider: 'kokoro',
                        audioBuffer: Uint8Array.from(Buffer.from('RIFF-second-worker')),
                        contentType: 'audio/wav',
                        text: message.payload.text,
                        voice: { id: message.payload.voiceId, provider: 'kokoro' },
                    },
                }));
            }
        }

        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            defaultVoiceId: 'af_heart',
            voices: [{ id: 'af_heart', label: 'Heart Studio' }],
            timeoutMs: 5000,
            workerEnabled: true,
            synthesisConcurrency: 2,
        }, {
            createWorker: () => {
                const worker = new FakeWorker(workers.length);
                workers.push(worker);
                return worker;
            },
        });

        await service.getModel();
        expect(service.getPublicConfig().diagnostics.synthesisConcurrency).toBe(1);
        const first = service.synthesize({ text: 'First worker request', voiceId: 'af_heart' });
        await firstPostedPromise;
        const second = service.synthesize({ text: 'Second worker request', voiceId: 'af_heart' });
        await Promise.resolve();
        await Promise.resolve();

        expect(workers).toHaveLength(1);
        expect(workers[0].messages.filter((message) => message.action === 'synthesize')).toHaveLength(1);

        releaseFirst();
        await firstFinishedPromise;
        await first;
        await second;

        expect(workers).toHaveLength(1);
        expect(workers[0].messages.filter((message) => message.action === 'synthesize')).toHaveLength(2);
    });

    test('rejects unknown voices', async () => {
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            voices: [{ id: 'af_heart' }],
        });

        await expect(service.synthesize({
            text: 'Hello.',
            voiceId: 'missing',
        })).rejects.toMatchObject({
            statusCode: 400,
            code: 'unknown_voice',
        });
    });

    test('returns unavailable diagnostics when disabled', () => {
        const service = new KokoroTtsService({
            enabled: false,
            voices: [{ id: 'af_heart' }],
        });

        expect(service.getPublicConfig()).toEqual(expect.objectContaining({
            configured: false,
            provider: 'kokoro',
            defaultVoiceId: null,
            diagnostics: expect.objectContaining({
                status: 'unavailable',
                message: 'Kokoro TTS is disabled.',
            }),
        }));
    });

    test('times out slow model loading', async () => {
        const service = new KokoroTtsService({
            enabled: true,
            modelId: 'test-model',
            voices: [{ id: 'af_heart' }],
            timeoutMs: 1,
        }, {
            importKokoro: () => ({
                KokoroTTS: {
                    from_pretrained: () => new Promise(() => {}),
                },
            }),
        });

        await expect(service.synthesize({
            text: 'Hello.',
            voiceId: 'af_heart',
            timeoutMs: 1,
        })).rejects.toMatchObject({
            statusCode: 504,
            code: 'tts_timeout',
        });
    });
});

jest.mock('openai', () => {
    const MockOpenAI = jest.fn().mockImplementation(() => ({
        models: {
            list: jest.fn(async () => ({ data: [] })),
        },
        responses: {
            create: jest.fn(),
        },
        chat: {
            completions: {
                create: jest.fn(),
            },
        },
        audio: {
            transcriptions: {
                create: jest.fn(),
            },
        },
    }));

    MockOpenAI.toFile = jest.fn(async () => null);
    return MockOpenAI;
});

describe('openai-client image generation', () => {
    let originalFetch;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('./routes/admin/settings.controller', () => ({
            getSettings: jest.fn(() => ({})),
        }));
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
        process.env.OPENAI_MEDIA_API_KEY = 'media-key';
        process.env.OPENAI_MEDIA_IMAGE_MODEL = 'gpt-image-1';
        delete process.env.OPENAI_IMAGE_MODEL;
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        delete process.env.OPENAI_MEDIA_API_KEY;
        delete process.env.OPENAI_MEDIA_IMAGE_MODEL;
        delete process.env.OPENAI_IMAGE_ALLOW_OFFICIAL_FALLBACK;
    });

    test('uses the current OpenAI image generation request shape for official media calls', async () => {
        global.fetch = jest.fn(async (_url, init = {}) => ({
            ok: true,
            json: async () => ({
                created: 123,
                usage: {
                    input_tokens: 12,
                    output_tokens: 4,
                    total_tokens: 16,
                },
                data: [{
                    b64_json: 'aGVsbG8=',
                    revised_prompt: 'A refined prompt',
                }],
            }),
        }));

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: 'Generate a hero image',
            model: 'gpt-image-1',
        });

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            prompt: 'Generate a hero image',
            model: 'gpt-image-1',
        }));
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('response_format');
        expect(result.data).toEqual([
            expect.objectContaining({
                url: 'data:image/png;base64,aGVsbG8=',
                b64_json: 'aGVsbG8=',
                revised_prompt: 'A refined prompt',
            }),
        ]);
        expect(result).toEqual(expect.objectContaining({
            model: 'gpt-image-1',
            requested_model: 'gpt-image-1',
            provider_call_count: 1,
            parsed_count: 1,
            usage: expect.objectContaining({
                promptTokens: 12,
                completionTokens: 4,
                totalTokens: 16,
            }),
        }));
    });

    test('normalizes gpt-image-2 parameters for the OpenAI image API', async () => {
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async (_url, init = {}) => {
            const body = JSON.parse(init.body);
            return {
                ok: true,
                json: async () => ({
                    created: 123,
                    output_format: body.output_format,
                    data: [{
                        b64_json: 'aGVsbG8=',
                        output_format: body.output_format,
                    }],
                }),
            };
        });

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: 'Generate a product poster',
            model: 'gpt-image-2',
            size: '2048x1152',
            quality: 'HIGH',
            background: 'transparent',
            style: 'vivid',
            response_format: 'b64_json',
            output_format: 'JPEG',
            output_compression: 42,
            moderation: 'LOW',
            n: 10,
        });

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body).toEqual(expect.objectContaining({
            prompt: 'Generate a product poster',
            model: 'gpt-image-2',
            size: '2048x1152',
            background: 'auto',
            output_format: 'jpeg',
            output_compression: 42,
            moderation: 'low',
            n: 10,
        }));
        expect(body).not.toHaveProperty('response_format');
        expect(body).not.toHaveProperty('style');
        expect(result).toEqual(expect.objectContaining({
            output_format: 'jpeg',
            output_compression: 42,
            moderation: 'low',
        }));
    });

    test('retries without response_format when a provider rejects that parameter', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gateway-image-model';
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: async () => JSON.stringify({
                    error: {
                        message: 'response_format is not supported by this provider',
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    created: 123,
                    data: [{
                        url: 'https://images.example.com/generated.png',
                    }],
                }),
            });

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: 'Generate a hero image',
            model: 'gateway-image-model',
        });

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            response_format: 'b64_json',
        }));
        expect(JSON.parse(global.fetch.mock.calls[1][1].body)).not.toHaveProperty('response_format');
        expect(result.data).toEqual([
            expect.objectContaining({
                url: 'https://images.example.com/generated.png',
                b64_json: undefined,
            }),
        ]);
    });

    test('normalizes nested provider image response shapes', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gateway-image-model';
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                created: 123,
                images: [{
                    inline_data: {
                        mime_type: 'image/webp',
                        data: 'aGVsbG8=',
                    },
                    prompt: 'A refined prompt',
                }],
            }),
        }));

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: 'Generate a hero image',
            model: 'gateway-image-model',
        });

        expect(result.data).toEqual([
            expect.objectContaining({
                url: 'data:image/webp;base64,aGVsbG8=',
                b64_json: 'aGVsbG8=',
                mimeType: 'image/webp',
                revised_prompt: 'A refined prompt',
            }),
        ]);
    });

    test('normalizes Responses API image generation tool results', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                id: 'resp_image_123',
                created: 123,
                output: [{
                    id: 'ig_123',
                    type: 'image_generation_call',
                    status: 'completed',
                    result: 'aGVsbG8=',
                }],
            }),
        }));

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: 'Generate a cat image',
            model: 'gpt-image-2',
        });

        expect(result.data).toEqual([
            expect.objectContaining({
                url: 'data:image/png;base64,aGVsbG8=',
                b64_json: 'aGVsbG8=',
            }),
        ]);
    });

    test('returns diagnostics when a successful provider response has no parsable image payload', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gateway-image-model';
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                created: 123,
                data: [{
                    type: 'message',
                    content: 'I cannot create that image.',
                }],
            }),
        }));

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: 'Generate a restricted image',
            model: 'gateway-image-model',
        });

        expect(result.data).toEqual([]);
        expect(result.diagnostics.imageGeneration).toEqual(expect.objectContaining({
            code: 'provider_response_not_parsable',
            status: 'failed',
            flags: expect.objectContaining({
                providerResponseReceived: true,
                likelyBackendParserIssue: true,
            }),
            counts: expect.objectContaining({
                parsedImageRecords: 0,
                usableReturnedImageRecords: 0,
            }),
            responseShape: expect.objectContaining({
                keys: expect.arrayContaining(['created', 'data']),
            }),
        }));
    });

    test('parses image payloads from raw wrappers with blank output text', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gateway-image-model';
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                created: 123,
                outputText: '',
                raw: {
                    data: [{
                        b64_json: 'aGVsbG8=',
                        revised_prompt: 'A cat',
                    }],
                },
            }),
        }));

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: 'Generate a cat image',
            model: 'gateway-image-model',
        });

        expect(result.data).toEqual([
            expect.objectContaining({
                url: 'data:image/png;base64,aGVsbG8=',
                b64_json: 'aGVsbG8=',
                revised_prompt: 'A cat',
            }),
        ]);
        expect(result.diagnostics.imageGeneration).toEqual(expect.objectContaining({
            code: 'backend_sent_usable_unpersisted_images',
            counts: expect.objectContaining({
                parsedImageRecords: 1,
                usableReturnedImageRecords: 1,
            }),
        }));
    });

    test('keeps gateway/router image requests on the configured OpenAI endpoint by default', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        process.env.OPENAI_MEDIA_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: async () => JSON.stringify({
                    error: {
                        message: 'not found',
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: async () => JSON.stringify({
                    error: {
                        message: 'not found',
                    },
                }),
            });

        const { generateImage } = require('./openai-client');
        await expect(generateImage({
            prompt: 'Generate a hero image',
            model: 'gpt-image-2',
        })).rejects.toThrow('not found');

        expect(global.fetch.mock.calls.map((call) => call[0])).toEqual([
            'https://gateway.example/v1/images/generations',
            'https://gateway.example/images/generations',
        ]);
    });

    test('includes the attempted endpoint in HTTP image generation errors', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 404,
            text: async () => JSON.stringify({ error: { message: 'not found' } }),
            headers: { get: () => '' },
        }));

        const { generateImage } = require('./openai-client');
        try {
            await generateImage({
                prompt: 'Generate a hero image',
                model: 'gpt-image-2',
            });
            throw new Error('Expected generateImage to throw');
        } catch (error) {
            expect(error.endpoint).toBe('https://gateway.example/images/generations');
            expect(error.baseURL).toBe('https://gateway.example');
        }
    });

    test('includes request metadata in HTTP image generation errors', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ error: { message: 'Provider returned no parseable image data.' } }),
            headers: { get: () => 'req_123' },
        }));

        const { generateImage } = require('./openai-client');
        try {
            await generateImage({
                prompt: 'Generate a hero image',
                model: 'gpt-image-2',
                response_format: 'b64_json',
            });
            throw new Error('Expected generateImage to throw');
        } catch (error) {
            expect(error.endpoint).toBe('https://gateway.example/v1/images/generations');
            expect(error.provider).toBe('gateway');
            expect(error.providerFamily).toBe('generic');
            expect(error.requestVariant).toBe(0);
            expect(error.requestHadResponseFormat).toBe(true);
            expect(error.model).toBe('gpt-image-2');
            expect(error.requestId).toBe('req_123');
        }
    });

    test('can opt in to official media fallback after the router endpoint fails', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        process.env.OPENAI_MEDIA_IMAGE_MODEL = 'gpt-image-2';
        process.env.OPENAI_IMAGE_ALLOW_OFFICIAL_FALLBACK = 'true';
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: async () => JSON.stringify({ error: { message: 'not found' } }),
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: async () => JSON.stringify({ error: { message: 'not found' } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    created: 123,
                    data: [{ b64_json: 'aGVsbG8=' }],
                }),
            });

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: 'Generate a hero image',
            model: 'gpt-image-2',
        });

        expect(global.fetch.mock.calls.map((call) => call[0])).toEqual([
            'https://gateway.example/v1/images/generations',
            'https://gateway.example/images/generations',
            'https://api.openai.com/v1/images/generations',
        ]);
        expect(global.fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer media-key');
        expect(JSON.parse(global.fetch.mock.calls[2][1].body)).toEqual(expect.objectContaining({
            prompt: 'Generate a hero image',
            model: 'gpt-image-2',
        }));
        expect(JSON.parse(global.fetch.mock.calls[2][1].body)).not.toHaveProperty('response_format');
        expect(result.data[0]).toEqual(expect.objectContaining({
            url: 'data:image/png;base64,aGVsbG8=',
        }));
    });

    test('can generate multiple image options with bounded parallel calls', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async (_url, init = {}) => {
            const body = JSON.parse(init.body);
            return {
                ok: true,
                json: async () => ({
                    created: body.prompt.includes('second') ? 124 : 123,
                    data: [{
                        url: `https://images.example.com/${encodeURIComponent(body.prompt)}.png`,
                    }],
                }),
            };
        });

        const { generateImageBatch } = require('./openai-client');
        const result = await generateImageBatch({
            prompt: 'hero set',
            prompts: ['first concept', 'second concept'],
            model: 'gpt-image-2',
            batchMode: 'parallel',
            concurrency: 2,
        });

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            prompt: 'first concept',
            n: 1,
            model: 'gpt-image-2',
        }));
        expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual(expect.objectContaining({
            prompt: 'second concept',
            n: 1,
            model: 'gpt-image-2',
        }));
        expect(result.batch).toEqual(expect.objectContaining({
            mode: 'parallel',
            requestedCount: 2,
        }));
        expect(result).toEqual(expect.objectContaining({
            requested_model: 'gpt-image-2',
            provider_call_count: 2,
            parsed_count: 2,
        }));
        expect(result.data).toHaveLength(2);
        expect(result.data[1]).toEqual(expect.objectContaining({
            prompt: 'second concept',
        }));
    });

    test('falls back to parallel calls when an auto multi-image request is rejected', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async (_url, init = {}) => {
            const body = JSON.parse(init.body);
            if (body.n > 1) {
                return {
                    ok: false,
                    status: 400,
                    text: async () => JSON.stringify({
                        error: { message: 'n must be 1 for this model' },
                    }),
                };
            }

            return {
                ok: true,
                json: async () => ({
                    created: 123,
                    data: [{
                        url: `https://images.example.com/${body.n}-${Math.random().toString(36).slice(2)}.png`,
                    }],
                }),
            };
        });

        const { generateImageBatch } = require('./openai-client');
        const result = await generateImageBatch({
            prompt: 'hero set',
            model: 'gpt-image-2',
            n: 3,
            batchMode: 'auto',
            concurrency: 2,
        });

        expect(global.fetch).toHaveBeenCalledTimes(4);
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            prompt: 'hero set',
            n: 3,
        }));
        expect(global.fetch.mock.calls.slice(1).map((call) => JSON.parse(call[1].body).n)).toEqual([1, 1, 1]);
        expect(result.batch).toEqual(expect.objectContaining({
            mode: 'parallel',
            requestedCount: 3,
        }));
        expect(result.data).toHaveLength(3);
    });

    test('fills missing auto multi-image results with parallel calls', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async (_url, init = {}) => {
            const body = JSON.parse(init.body);
            return {
                ok: true,
                json: async () => ({
                    created: body.n > 1 ? 123 : 124,
                    data: [{
                        url: `https://images.example.com/${body.n}-${global.fetch.mock.calls.length}.png`,
                    }],
                }),
            };
        });

        const { generateImageBatch } = require('./openai-client');
        const result = await generateImageBatch({
            prompt: 'hero set',
            model: 'gpt-image-2',
            n: 3,
            batchMode: 'auto',
            concurrency: 2,
        });

        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            n: 3,
        }));
        expect(global.fetch.mock.calls.slice(1).map((call) => JSON.parse(call[1].body).n)).toEqual([1, 1]);
        expect(result.batch).toEqual(expect.objectContaining({
            mode: 'auto-fill-parallel',
            requestedCount: 3,
            initialCount: 1,
        }));
        expect(result.data).toHaveLength(3);
        expect(result.data.map((entry) => entry.option_index)).toEqual([0, 1, 2]);
    });

    test('ignores a stale Gemini model request when the provider is official OpenAI', async () => {
        global.fetch = jest.fn(async (_url, init = {}) => ({
            ok: true,
            json: async () => ({
                created: 123,
                data: [{
                    b64_json: 'aGVsbG8=',
                }],
            }),
        }));

        const { generateImage } = require('./openai-client');
        await generateImage({
            prompt: 'Generate a hero image',
            model: 'gemini-2.0-flash-exp-image-generation',
        });

        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            model: 'gpt-image-2',
            size: 'auto',
            quality: 'auto',
            background: 'auto',
        }));
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('response_format');
    });

    test('ignores a stale Gemini model request when the gateway is configured for OpenAI-style image models', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async (_url, init = {}) => ({
            ok: true,
            json: async () => ({
                created: 123,
                data: [{
                    b64_json: 'aGVsbG8=',
                }],
            }),
        }));

        const { generateImage } = require('./openai-client');
        await generateImage({
            prompt: 'Generate a hero image',
            model: 'gemini-2.0-flash-exp-image-generation',
        });

        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            model: 'gpt-image-2',
        }));
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('response_format');
        expect(global.fetch.mock.calls[0][0]).toBe('https://gateway.example/v1/images/generations');
    });

    test('preserves explicit base64 response format requests for OpenAI-style gateway image calls', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async (_url, init = {}) => ({
            ok: true,
            json: async () => ({
                created: 123,
                data: [{
                    b64_json: 'aGVsbG8=',
                }],
            }),
        }));

        const { generateImage } = require('./openai-client');
        await generateImage({
            prompt: 'Generate a hero image',
            model: 'gpt-image-2',
            response_format: 'b64_json',
        });

        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            model: 'gpt-image-2',
            response_format: 'b64_json',
        }));
        expect(global.fetch.mock.calls[0][0]).toBe('https://gateway.example/v1/images/generations');
    });

    test('passes structured prompts and image passthrough fields to the configured gateway endpoint', async () => {
        process.env.OPENAI_BASE_URL = 'https://gateway.example/openai/v1';
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
        global.fetch = jest.fn(async (_url, init = {}) => ({
            ok: true,
            json: async () => ({
                created: 123,
                data: [{
                    b64_json: 'aGVsbG8=',
                }],
            }),
        }));

        const structuredPrompt = {
            type: 'input_text',
            content: [
                { type: 'text', text: 'Create a clean banner illustration.' },
            ],
        };

        const { generateImage } = require('./openai-client');
        const result = await generateImage({
            prompt: structuredPrompt,
            model: 'gpt-image-2',
            size: '1536x1024',
            quality: 'high',
            style: 'vivid',
            response_format: 'b64_json',
            user: 'frontend-user',
        });

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls[0][0]).toBe('https://gateway.example/openai/v1/images/generations');
        expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            prompt: structuredPrompt,
            model: 'gpt-image-2',
            size: '1536x1024',
            quality: 'high',
            user: 'frontend-user',
        }));
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('style');
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
            response_format: 'b64_json',
        }));
        expect(result.data[0]).toEqual(expect.objectContaining({
            url: 'data:image/png;base64,aGVsbG8=',
            b64_json: 'aGVsbG8=',
        }));
    });
});

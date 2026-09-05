jest.mock('openai', () => {
    const responsesCreate = jest.fn(async (params) => ({
        id: 'resp-test',
        model: params.model,
        output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
        }],
    }));
    const chatCreate = jest.fn();

    return jest.fn().mockImplementation(() => ({
        responses: {
            create: responsesCreate,
        },
        chat: {
            completions: {
                create: chatCreate,
            },
        },
    }));
});

describe('openai-client response threading', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('./routes/admin/settings.controller', () => ({
            getSettings: jest.fn(() => ({})),
        }));
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
        process.env.OPENAI_API_MODE = 'responses';
    });

    afterEach(() => {
        delete process.env.OPENAI_API_MODE;
        delete process.env.OPENAI_REQUEST_TIMEOUT_MS;
    });

    test('forwards previous_response_id when the prior prompt fingerprint matches', async () => {
        const OpenAI = require('openai');
        const { createResponse, __testUtils } = require('./openai-client');
        const instructionsFingerprint = __testUtils.hashPromptText('You are a helpful AI assistant.');

        await createResponse({
            input: 'Continue the previous reply.',
            previousResponseId: 'resp_prev_123',
            previousPromptState: { instructionsFingerprint },
            instructions: 'You are a helpful AI assistant.',
            stream: false,
        });

        const client = OpenAI.mock.results[0].value;
        const [[requestParams]] = client.responses.create.mock.calls;
        expect(requestParams).toEqual(expect.objectContaining({
            previous_response_id: 'resp_prev_123',
        }));
    });

    test('applies the configured OpenAI request timeout by default', async () => {
        process.env.OPENAI_REQUEST_TIMEOUT_MS = '901234';
        jest.resetModules();
        jest.doMock('./routes/admin/settings.controller', () => ({
            getSettings: jest.fn(() => ({})),
        }));
        const OpenAI = require('openai');
        const { createResponse } = require('./openai-client');

        await createResponse({
            input: 'Use the default timeout.',
            stream: false,
        });

        const client = OpenAI.mock.results[0].value;
        const [, requestOptions] = client.responses.create.mock.calls[0];
        expect(requestOptions).toEqual(expect.objectContaining({
            timeout: 901234,
        }));
    });

    test('reuses the threaded response without resending unchanged instructions or transcript', async () => {
        const OpenAI = require('openai');
        const { createResponse, __testUtils } = require('./openai-client');
        const instructionsFingerprint = __testUtils.hashPromptText('You are a helpful AI assistant.');

        await createResponse({
            input: 'Continue the previous reply.',
            previousResponseId: 'resp_prev_123',
            previousPromptState: { instructionsFingerprint },
            instructions: 'You are a helpful AI assistant.',
            recentMessages: [
                { role: 'user', content: 'Earlier question' },
                { role: 'assistant', content: 'Earlier answer' },
            ],
            stream: false,
        });

        const client = OpenAI.mock.results[0].value;
        const [[requestParams]] = client.responses.create.mock.calls;
        expect(requestParams).toEqual(expect.objectContaining({
            previous_response_id: 'resp_prev_123',
            input: expect.arrayContaining([
                { type: 'message', role: 'user', content: 'Continue the previous reply.' },
            ]),
        }));
    });

    test('drops threaded reuse when the instruction fingerprint changes', async () => {
        const OpenAI = require('openai');
        const { createResponse, __testUtils } = require('./openai-client');

        await createResponse({
            input: 'Continue the previous reply.',
            previousResponseId: 'resp_prev_123',
            previousPromptState: {
                instructionsFingerprint: __testUtils.hashPromptText('Old instructions'),
            },
            instructions: 'New instructions',
            stream: false,
        });

        const client = OpenAI.mock.results[0].value;
        const [[requestParams]] = client.responses.create.mock.calls;
        expect(requestParams).not.toEqual(expect.objectContaining({
            previous_response_id: 'resp_prev_123',
        }));
        expect(requestParams).toEqual(expect.objectContaining({
            input: expect.arrayContaining([
                { type: 'message', role: 'system', content: 'New instructions' },
                { type: 'message', role: 'user', content: 'Continue the previous reply.' },
            ]),
        }));
    });

    test('normalizes reasoning summary and tool item events from Responses streams', async () => {
        const { __testUtils } = require('./openai-client');

        async function* streamChunks() {
            yield { type: 'response.reasoning_summary_text.delta', delta: 'Looking at the request. ' };
            yield {
                type: 'response.output_item.added',
                item: {
                    type: 'function_call',
                    name: 'web_search',
                    call_id: 'call_123',
                },
            };
            yield { type: 'response.output_text.delta', delta: 'Answer' };
            yield {
                type: 'response.completed',
                response: {
                    id: 'resp_stream_1',
                    model: 'gpt-4o',
                    output: [{
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'Answer' }],
                    }],
                },
            };
        }

        const events = [];
        for await (const event of __testUtils.normalizeStreamResponse(streamChunks(), {
            taskType: 'chat',
            clientSurface: 'web-chat',
        })) {
            events.push(event);
        }

        expect(events).toEqual([
            {
                type: 'response.reasoning_summary_text.delta',
                delta: 'Looking at the request. ',
                summary: 'Looking at the request. ',
            },
            {
                type: 'response.output_item.added',
                item: {
                    type: 'function_call',
                    name: 'web_search',
                    call_id: 'call_123',
                },
            },
            {
                type: 'response.output_text.delta',
                delta: 'Answer',
            },
            expect.objectContaining({
                type: 'response.completed',
                response: expect.objectContaining({
                    metadata: expect.objectContaining({
                        taskType: 'chat',
                        clientSurface: 'web-chat',
                        reasoningSummary: expect.stringContaining('Looking at the request.'),
                        reasoningAvailable: true,
                    }),
                    output_text: 'Answer',
                }),
            }),
        ]);
    });

    test('preserves native Responses argument events until compat translation', async () => {
        const { __testUtils } = require('./openai-client');

        async function* streamChunks() {
            yield { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"a":' };
            yield { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"a":1}' };
            yield {
                type: 'response.output_item.done',
                item: {
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: 'save_value',
                    arguments: '{"a":1}',
                },
            };
            yield {
                type: 'response.completed',
                response: {
                    id: 'resp_native_events',
                    model: 'gpt-6-astra',
                    output: [],
                },
            };
        }

        const events = [];
        for await (const event of __testUtils.normalizeStreamResponse(streamChunks())) {
            events.push(event);
        }

        expect(events.slice(0, 3)).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'response.function_call_arguments.delta', item_id: 'fc_1' }),
            expect.objectContaining({ type: 'response.function_call_arguments.done', item_id: 'fc_1' }),
            expect.objectContaining({
                type: 'response.output_item.done',
                item: expect.objectContaining({ call_id: 'call_1' }),
            }),
        ]));
        expect(events.some((event) => event.type === 'chat.completion.tool_calls.delta')).toBe(false);
    });

    test('preserves exact provider usage in normalized response metadata', async () => {
        const OpenAI = require('openai');
        const responsesCreate = jest.fn(async (params) => ({
            id: 'resp-usage-1',
            model: params.model,
            usage: {
                input_tokens: 18,
                output_tokens: 9,
                total_tokens: 27,
                input_tokens_details: {
                    cached_tokens: 4,
                },
                output_tokens_details: {
                    reasoning_tokens: 3,
                },
            },
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'done' }],
            }],
        }));

        OpenAI.mockImplementation(() => ({
            responses: { create: responsesCreate },
            chat: { completions: { create: jest.fn() } },
        }));

        const { createResponse } = require('./openai-client');
        const response = await createResponse({
            input: 'Summarize the request.',
            stream: false,
        });

        expect(response.metadata.usage).toEqual({
            promptTokens: 18,
            completionTokens: 9,
            totalTokens: 27,
            inputTokens: 18,
            outputTokens: 9,
            reasoningTokens: 3,
            cachedTokens: 4,
            modelCalls: 1,
        });
        expect(response.metadata.tokenUsage).toEqual(response.metadata.usage);
    });

    test('asks chat-completions streams to include usage for gateway token accounting', async () => {
        process.env.OPENAI_API_MODE = 'chat';
        jest.resetModules();
        jest.doMock('./routes/admin/settings.controller', () => ({
            getSettings: jest.fn(() => ({})),
        }));
        const OpenAI = require('openai');
        async function* streamChunks() {
            yield {
                id: 'chatcmpl-stream-usage',
                model: 'gpt-test',
                choices: [{ delta: { content: 'ok' }, finish_reason: null }],
            };
            yield {
                id: 'chatcmpl-stream-usage',
                model: 'gpt-test',
                choices: [{ delta: {}, finish_reason: 'stop' }],
            };
        }
        OpenAI.mockImplementation(() => ({
            responses: { create: jest.fn() },
            chat: {
                completions: {
                    create: jest.fn(async () => streamChunks()),
                },
            },
        }));

        const { createResponse } = require('./openai-client');
        await createResponse({
            input: 'Stream with usage.',
            stream: true,
        });

        const client = OpenAI.mock.results[0].value;
        const [[requestParams]] = client.chat.completions.create.mock.calls;
        expect(requestParams).toEqual(expect.objectContaining({
            stream: true,
            stream_options: { include_usage: true },
        }));
    });

    test('logs request summaries without dumping prompt content', async () => {
        const { createResponse } = require('./openai-client');
        const secretPrompt = `confidential podcast research ${'source excerpt '.repeat(300)}`;
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        let logs = '';

        try {
            await createResponse({
                input: secretPrompt,
                stream: false,
            });
            logs = logSpy.mock.calls
                .map((args) => args.map((entry) => String(entry)).join(' '))
                .join('\n');
        } finally {
            logSpy.mockRestore();
        }

        expect(logs).toContain('Request params summary');
        expect(logs).not.toContain('Full params');
        expect(logs).not.toContain(secretPrompt.slice(0, 80));
    });

    test('summarizes direct artifact tool outputs instead of dumping raw payload JSON', async () => {
        const { __testUtils } = require('./openai-client');

        const summary = __testUtils.formatDirectToolResultMessage({
            toolCall: {
                function: {
                    name: 'document-workflow',
                },
            },
            result: {
                success: true,
                toolId: 'document-workflow',
                data: {
                    artifact: {
                        id: 'artifact-html-1',
                        filename: 'dashboard.html',
                        mimeType: 'text/html',
                        downloadUrl: '/api/artifacts/artifact-html-1/download',
                        previewUrl: '/api/artifacts/artifact-html-1/preview',
                    },
                },
            },
        });

        expect(summary).toBe('Created dashboard.html. Preview and Download below.');
    });

    test('summarizes direct image tool outputs without exposing raw provider payloads', async () => {
        const { __testUtils } = require('./openai-client');

        const summary = __testUtils.formatDirectToolResultMessage({
            toolCall: {
                function: {
                    name: 'image-generate',
                },
            },
            result: {
                success: true,
                toolId: 'image-generate',
                data: {
                    count: 2,
                    images: [
                        { url: 'sandbox:/mnt/data/0.png' },
                        { url: 'sandbox:/mnt/data/1.png' },
                    ],
                },
            },
        });

        expect(summary).toBe('Generated 2 image options. Select one below.');
    });

    test('uses concise direct tool result messages before raw payload JSON', async () => {
        const { __testUtils } = require('./openai-client');

        const summary = __testUtils.formatDirectToolResultMessage({
            toolCall: {
                function: {
                    name: 'skill-context',
                },
            },
            result: {
                success: true,
                toolId: 'skill-context',
                data: {
                    message: 'Found 3 matching skills. Use the architecture skill first.',
                    matches: [
                        { id: 'interface-quality-architecture', score: 0.91 },
                    ],
                },
            },
        });

        expect(summary).toBe('Found 3 matching skills. Use the architecture skill first.');
        expect(summary).not.toContain('matches');
        expect(summary).not.toContain('interface-quality-architecture');
    });

    test('aggregates usage across responses tool-loop rounds', async () => {
        const { __testUtils } = require('./openai-client');
        const openai = {
            responses: {
                create: jest.fn()
                    .mockResolvedValueOnce({
                        id: 'resp-loop-1',
                        model: 'gpt-4o',
                        usage: {
                            input_tokens: 10,
                            output_tokens: 5,
                            total_tokens: 15,
                        },
                        output: [{
                            type: 'function_call',
                            id: 'call_1',
                            call_id: 'call_1',
                            name: 'web-search',
                            arguments: JSON.stringify({ query: 'Halifax weather' }),
                        }],
                    })
                    .mockResolvedValueOnce({
                        id: 'resp-loop-2',
                        model: 'gpt-4o',
                        usage: {
                            input_tokens: 4,
                            output_tokens: 6,
                            total_tokens: 10,
                        },
                        output: [{
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: 'Search complete.' }],
                        }],
                    }),
            },
        };
        const toolManager = {
            executeTool: jest.fn(async () => ({
                success: true,
                toolId: 'web-search',
                data: {
                    results: [{ title: 'Halifax weather', url: 'https://example.com' }],
                },
            })),
        };
        const response = await __testUtils.runAutomaticToolLoopWithResponses(openai, {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Use a tool if needed to verify this.' }],
            selectedTools: [{
                id: 'web-search',
                responseDefinition: {
                    type: 'function',
                    name: 'web-search',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string' },
                        },
                    },
                },
            }],
            toolContext: {
                toolManager,
            },
        });

        expect(response._kimibuilt.toolEvents).toHaveLength(1);
        expect(response._kimibuilt.usage).toEqual({
            promptTokens: 14,
            completionTokens: 11,
            totalTokens: 25,
            inputTokens: 14,
            outputTokens: 11,
            modelCalls: 2,
        });
        expect(response._kimibuilt.tokenUsage).toEqual(response._kimibuilt.usage);
    });

    test('uses function_call id as Responses tool output call_id when call_id is absent', async () => {
        const { __testUtils } = require('./openai-client');
        const openai = {
            responses: {
                create: jest.fn()
                    .mockResolvedValueOnce({
                        id: 'resp-loop-id-only-1',
                        model: 'gpt-4o',
                        output: [{
                            type: 'function_call',
                            id: 'call_provider_id_only',
                            name: 'web-search',
                            arguments: JSON.stringify({ query: 'KimiBuilt tool loop' }),
                        }],
                    })
                    .mockResolvedValueOnce({
                        id: 'resp-loop-id-only-2',
                        model: 'gpt-4o',
                        output: [{
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: 'Search complete.' }],
                        }],
                    }),
            },
        };
        const toolManager = {
            executeTool: jest.fn(async () => ({
                success: true,
                toolId: 'web-search',
                data: {
                    results: [{ title: 'Result', url: 'https://example.com' }],
                },
            })),
        };

        await __testUtils.runAutomaticToolLoopWithResponses(openai, {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Search with a tool.' }],
            selectedTools: [{
                id: 'web-search',
                responseDefinition: {
                    type: 'function',
                    name: 'web-search',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string' },
                        },
                    },
                },
            }],
            toolContext: {
                toolManager,
            },
        });

        expect(openai.responses.create).toHaveBeenCalledTimes(2);
        expect(openai.responses.create.mock.calls[1][0].input).toEqual([
            expect.objectContaining({
                type: 'function_call_output',
                call_id: 'call_provider_id_only',
            }),
        ]);
    });
});

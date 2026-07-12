const {
    createEstimatedUsageMetadata,
    extractResponseUsageMetadata,
    extractUsageMetadataFromTrace,
    hasMeasuredTokenCounts,
    mergeUsageMetadata,
    normalizeUsageMetadata,
} = require('./token-usage');

describe('token usage utilities', () => {
    test('aggregates usage from both model_call and llm-call trace entries', () => {
        const usage = extractUsageMetadataFromTrace([
            {
                type: 'model_call',
                details: {
                    usage: {
                        input_tokens: 10,
                        output_tokens: 5,
                        total_tokens: 15,
                    },
                },
            },
            {
                type: 'llm-call',
                metadata: {
                    tokens: {
                        input: 7,
                        output: 3,
                    },
                },
            },
            {
                type: 'tool-call',
                metadata: {
                    tokens: {
                        input: 999,
                        output: 999,
                    },
                },
            },
        ]);

        expect(usage).toEqual({
            promptTokens: 17,
            inputTokens: 17,
            completionTokens: 8,
            outputTokens: 8,
            totalTokens: 25,
        });
    });

    test('normalizes gateway token usage wrapper dialects', () => {
        expect(normalizeUsageMetadata({
            total_token_usage: {
                input_tokens: 21,
                output_tokens: 13,
                total_tokens: 34,
            },
        })).toEqual({
            promptTokens: 21,
            inputTokens: 21,
            completionTokens: 13,
            outputTokens: 13,
            totalTokens: 34,
        });
    });

    test('normalizes Codex bridge completion payload usage', () => {
        expect(normalizeUsageMetadata({
            event: 'turn_completed',
            payload: {
                total_token_usage: {
                    input_tokens: 9,
                    output_tokens: 6,
                    total_tokens: 15,
                    source: 'codex-bridge',
                },
            },
        })).toEqual({
            promptTokens: 9,
            inputTokens: 9,
            completionTokens: 6,
            outputTokens: 6,
            totalTokens: 15,
            source: 'codex-bridge',
        });
    });

    test('normalizes Ollama-style gateway eval counts', () => {
        expect(normalizeUsageMetadata({
            prompt_eval_count: 8,
            eval_count: 5,
        })).toEqual({
            promptTokens: 8,
            inputTokens: 8,
            completionTokens: 5,
            outputTokens: 5,
            totalTokens: 13,
        });
    });

    test('normalizes Gemini-style usage metadata counts', () => {
        expect(normalizeUsageMetadata({
            usageMetadata: {
                promptTokenCount: 12,
                candidatesTokenCount: 7,
                totalTokenCount: 23,
                thoughtsTokenCount: 4,
                cachedContentTokenCount: 3,
            },
        })).toEqual({
            promptTokens: 12,
            inputTokens: 12,
            completionTokens: 7,
            outputTokens: 7,
            totalTokens: 23,
            reasoningTokens: 4,
            cachedTokens: 3,
        });
    });

    test('normalizes provider response metadata token usage wrappers', () => {
        expect(normalizeUsageMetadata({
            response_metadata: {
                tokenUsage: {
                    promptTokens: 31,
                    completionTokens: 11,
                    totalTokens: 42,
                    reasoningTokens: 5,
                    cachedTokens: 7,
                    source: 'provider-response-metadata',
                },
            },
        })).toEqual({
            promptTokens: 31,
            inputTokens: 31,
            completionTokens: 11,
            outputTokens: 11,
            totalTokens: 42,
            reasoningTokens: 5,
            cachedTokens: 7,
            source: 'provider-response-metadata',
        });
    });

    test('extracts provider response metadata usage wrappers', () => {
        expect(extractResponseUsageMetadata({
            id: 'response-usage-wrapper',
            response_metadata: {
                usage: {
                    prompt_tokens: 18,
                    completion_tokens: 7,
                    total_tokens: 25,
                    source: 'provider-response-metadata',
                },
            },
        })).toEqual({
            promptTokens: 18,
            inputTokens: 18,
            completionTokens: 7,
            outputTokens: 7,
            totalTokens: 25,
            modelCalls: 1,
            source: 'provider-response-metadata',
        });
    });

    test('prefers measured response metadata over zeroed direct usage placeholders', () => {
        expect(extractResponseUsageMetadata({
            id: 'response-zero-direct-usage',
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            },
            response_metadata: {
                usage: {
                    prompt_tokens: 64,
                    completion_tokens: 18,
                    total_tokens: 82,
                    source: 'provider-response-metadata',
                },
            },
        })).toEqual({
            promptTokens: 64,
            inputTokens: 64,
            completionTokens: 18,
            outputTokens: 18,
            totalTokens: 82,
            modelCalls: 1,
            source: 'provider-response-metadata',
        });
    });

    test('normalizes nested response metadata usage wrappers', () => {
        expect(normalizeUsageMetadata({
            response: {
                response_metadata: {
                    usage: {
                        prompt_tokens: 14,
                        completion_tokens: 9,
                        total_tokens: 23,
                    },
                },
            },
        })).toEqual({
            promptTokens: 14,
            inputTokens: 14,
            completionTokens: 9,
            outputTokens: 9,
            totalTokens: 23,
        });
    });

    test('normalizes provider split input-cache accounting', () => {
        expect(normalizeUsageMetadata({
            input_tokens: 40,
            output_tokens: 12,
            input_tokens_details: {
                cache_read_input_tokens: 9,
                cache_creation_input_tokens: 4,
            },
        })).toEqual({
            promptTokens: 40,
            inputTokens: 40,
            completionTokens: 12,
            outputTokens: 12,
            totalTokens: 52,
            cachedTokens: 13,
            cacheReadInputTokens: 9,
            cacheCreationInputTokens: 4,
        });
    });

    test('aggregates split cache usage across model calls', () => {
        expect(mergeUsageMetadata([
            {
                prompt_tokens: 10,
                completion_tokens: 2,
                input_tokens_details: {
                    cache_read_input_tokens: 3,
                },
            },
            {
                prompt_tokens: 6,
                completion_tokens: 4,
                input_tokens_details: {
                    cache_creation_input_tokens: 5,
                },
            },
        ])).toEqual({
            promptTokens: 16,
            inputTokens: 16,
            completionTokens: 6,
            outputTokens: 6,
            totalTokens: 22,
            cachedTokens: 8,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 5,
        });
    });

    test('distinguishes zeroed provider usage from measured token counts', () => {
        const zeroed = normalizeUsageMetadata({
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        });

        expect(hasMeasuredTokenCounts(zeroed)).toBe(false);
        expect(hasMeasuredTokenCounts({
            prompt_tokens: 1,
            completion_tokens: 0,
            total_tokens: 1,
        })).toBe(true);
    });

    test('creates marked local usage estimates when gateway usage is missing or zeroed', () => {
        expect(createEstimatedUsageMetadata({
            input: 'Explain the sandbox preview verification result.',
            output: 'The preview rendered.',
        })).toEqual(expect.objectContaining({
            promptTokens: expect.any(Number),
            completionTokens: expect.any(Number),
            totalTokens: expect.any(Number),
            modelCalls: 1,
            estimated: true,
            source: 'local-estimate',
        }));
    });
});

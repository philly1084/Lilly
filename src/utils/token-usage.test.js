const {
    extractUsageMetadataFromTrace,
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
});

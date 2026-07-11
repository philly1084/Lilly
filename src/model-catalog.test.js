const {
    buildModelContract,
    isPublicChatModel,
    selectAutoModel,
    toPublicChatModelList,
    toPublicModelList,
} = require('./model-catalog');

describe('model-catalog', () => {
    test('keeps router-provided chat models even when the family is not hardcoded', () => {
        expect(isPublicChatModel('my-router/smart-chat-v2')).toBe(true);
        expect(isPublicChatModel('gpt-5.5-tools')).toBe(true);
        expect(toPublicChatModelList([
            { id: 'my-router/smart-chat-v2', owned_by: 'custom-router' },
            { id: 'gpt-5.5-tools', owned_by: 'internal-router' },
        ])).toEqual([
            expect.objectContaining({
                id: 'my-router/smart-chat-v2',
                owned_by: 'custom-router',
            }),
            expect.objectContaining({
                id: 'gpt-5.5-tools',
                owned_by: 'internal-router',
            }),
        ]);
    });

    test('filters obvious non-chat models from the router list', () => {
        expect(toPublicChatModelList([
            { id: 'gpt-4o', owned_by: 'openai' },
            { id: 'text-embedding-3-large', owned_by: 'openai' },
            { id: 'gpt-image-1', owned_by: 'openai' },
            { id: 'custom-image-router', owned_by: 'gateway', capabilities: ['image_generation'] },
            { id: 'whisper-1', owned_by: 'openai' },
            { id: 'omni-moderation-latest', owned_by: 'openai' },
        ])).toEqual([
            expect.objectContaining({
                id: 'gpt-4o',
            }),
        ]);
    });

    test('keeps multimodal image-input and vision chat models public', () => {
        expect(isPublicChatModel('gpt-4-vision-preview')).toBe(true);
        expect(isPublicChatModel('gpt-4o-image-input-preview')).toBe(true);
        expect(isPublicChatModel({
            id: 'router-image-input-chat',
            owned_by: 'gateway',
            capabilities: ['chat', 'image_input'],
        })).toBe(true);
        expect(toPublicChatModelList([
            { id: 'gpt-4o-image-input-preview', owned_by: 'openai' },
            { id: 'router-image-input-chat', owned_by: 'gateway', capabilities: ['chat', 'image_input'] },
            { id: 'custom-image-router', owned_by: 'gateway', capabilities: ['image_generation'] },
        ])).toEqual([
            expect.objectContaining({
                id: 'gpt-4o-image-input-preview',
            }),
            expect.objectContaining({
                id: 'router-image-input-chat',
            }),
        ]);
    });

    test('deduplicates repeated model ids from the provider list', () => {
        expect(toPublicChatModelList([
            { id: 'gpt-4o', owned_by: 'openai' },
            { id: 'gpt-4o', owned_by: 'openai' },
        ])).toHaveLength(1);
    });

    test('keeps image models with image_generation capability in OpenAI-compatible model lists', () => {
        expect(toPublicModelList([
            { id: 'gpt-4o', owned_by: 'openai' },
            { id: 'gpt-image-2', owned_by: 'openai' },
            { id: 'custom-image-router', owned_by: 'gateway', capabilities: ['image_generation'] },
        ])).toEqual([
            expect.objectContaining({
                id: 'gpt-4o',
                capabilities: expect.arrayContaining(['chat', 'responses', 'streaming', 'tools', 'structured_outputs', 'vision', 'image_input']),
            }),
            expect.objectContaining({
                id: 'gpt-image-2',
                capabilities: ['image_generation'],
            }),
            expect.objectContaining({
                id: 'custom-image-router',
                capabilities: ['image_generation'],
            }),
        ]);
    });

    test('treats additive gateway capabilities as chat-capable for model contracts', () => {
        const contract = buildModelContract({
            id: 'gpt-5.5-tools',
            owned_by: 'gateway',
            capabilities: ['tools', 'streaming'],
        });

        expect(contract.capabilities).toEqual(['chat', 'tools', 'streaming']);
        expect(contract.supports).toEqual(expect.objectContaining({
            chat: true,
            tools: true,
            streaming: true,
        }));
    });

    test('auto-selects gateway chat models that only advertise additive capabilities', () => {
        const selected = selectAutoModel([
            { id: 'gpt-image-2', owned_by: 'openai', capabilities: ['image_generation'] },
            { id: 'gpt-5.5-tools', owned_by: 'gateway', capabilities: ['tools', 'streaming'] },
        ], {
            needsTools: true,
            apiMode: 'chat',
        });

        expect(selected).toEqual(expect.objectContaining({
            id: 'gpt-5.5-tools',
        }));
    });

    test('normalizes string and object capability metadata before chat selection', () => {
        const selected = selectAutoModel([
            { id: 'gpt-image-2', owned_by: 'openai', capabilities: 'image_generation' },
            { id: 'gpt-5.5-tools', owned_by: 'gateway', capabilities: [], metadata: { capabilities: { tools: { supported: true }, streaming: 'available' } } },
            { id: 'custom-basic-chat', owned_by: 'gateway', contract: { capabilities: { chat: true } } },
        ], {
            needsTools: true,
            apiMode: 'chat',
        });

        expect(isPublicChatModel({ id: 'gpt-image-2', capabilities: 'image_generation' })).toBe(false);
        expect(isPublicChatModel({
            id: 'custom-render-router',
            capabilities: [],
            metadata: { capabilities: { image_generation: { supported: true } } },
        })).toBe(false);
        expect(selected).toEqual(expect.objectContaining({
            id: 'gpt-5.5-tools',
            capabilities: ['chat', 'tools', 'streaming'],
        }));
    });

    test('normalizes mixed-case capability names before model routing', () => {
        const selected = selectAutoModel([
            { id: 'upper-image-router', owned_by: 'gateway', capabilities: ['IMAGE_GENERATION'] },
            { id: 'upper-tools-router', owned_by: 'gateway', capabilities: ['CHAT', 'Tools', 'Streaming'] },
        ], {
            needsTools: true,
            apiMode: 'chat',
        });

        expect(isPublicChatModel({ id: 'upper-image-router', capabilities: ['IMAGE_GENERATION'] })).toBe(false);
        expect(buildModelContract({
            id: 'upper-tools-router',
            owned_by: 'gateway',
            capabilities: ['CHAT', 'Tools', 'Streaming'],
        })).toEqual(expect.objectContaining({
            capabilities: ['chat', 'tools', 'streaming'],
            supports: expect.objectContaining({
                chat: true,
                tools: true,
                streaming: true,
            }),
        }));
        expect(selected).toEqual(expect.objectContaining({
            id: 'upper-tools-router',
            supports: expect.objectContaining({
                tools: true,
            }),
        }));
    });

    test('normalizes provider support maps before model routing', () => {
        const selected = selectAutoModel([
            { id: 'image-output-router', owned_by: 'gateway', supports: { image_generation: true } },
            { id: 'fast-router', owned_by: 'gateway', supports: { chat: true, tools: { supported: true }, streaming: 'available' } },
            { id: 'structured-router', owned_by: 'gateway', contract: { supports: { chat: true, structured_outputs: true } } },
        ], {
            needsTools: true,
            apiMode: 'chat',
        });

        expect(isPublicChatModel({ id: 'image-output-router', supports: { image_generation: true } })).toBe(false);
        expect(buildModelContract({
            id: 'fast-router',
            owned_by: 'gateway',
            supports: { chat: true, tools: { supported: true }, streaming: 'available' },
        })).toEqual(expect.objectContaining({
            capabilities: ['chat', 'tools', 'streaming'],
            supports: expect.objectContaining({
                chat: true,
                tools: true,
                streaming: true,
            }),
        }));
        expect(buildModelContract({
            id: 'structured-router',
            owned_by: 'gateway',
            contract: { supports: { chat: true, structured_outputs: true } },
        }).supports.structured_outputs).toBe(true);
        expect(selected).toEqual(expect.objectContaining({
            id: 'fast-router',
        }));
    });

    test('normalizes provider capability maps before model routing', () => {
        const selected = selectAutoModel([
            { id: 'image-map-router', owned_by: 'gateway', capability_map: { image_generation: true } },
            { id: 'tools-map-router', owned_by: 'gateway', capabilityMap: { chat: true, tools: { supported: true }, streaming: 'available' } },
            { id: 'structured-map-router', owned_by: 'gateway', metadata: { capability_map: { chat: true, structured_outputs: 'enabled' } } },
        ], {
            needsTools: true,
            apiMode: 'chat',
        });

        expect(isPublicChatModel({ id: 'image-map-router', capability_map: { image_generation: true } })).toBe(false);
        expect(buildModelContract({
            id: 'tools-map-router',
            owned_by: 'gateway',
            capabilityMap: { chat: true, tools: { supported: true }, streaming: 'available' },
        })).toEqual(expect.objectContaining({
            capabilities: ['chat', 'tools', 'streaming'],
            supports: expect.objectContaining({
                chat: true,
                tools: true,
                streaming: true,
            }),
        }));
        expect(buildModelContract({
            id: 'structured-map-router',
            owned_by: 'gateway',
            metadata: { capability_map: { chat: true, structured_outputs: 'enabled' } },
        }).supports.structured_outputs).toBe(true);
        expect(selected).toEqual(expect.objectContaining({
            id: 'tools-map-router',
        }));
    });

    test('labels common gateway model families in public contracts', () => {
        expect(buildModelContract({ id: 'mistral-large-latest' })).toEqual(expect.objectContaining({
            provider: 'mistral',
        }));
        expect(buildModelContract({ id: 'gemma-3-27b-it', owned_by: 'gateway' })).toEqual(expect.objectContaining({
            provider: 'google',
        }));
        expect(buildModelContract({ id: 'google/gemma-3-27b-it', owned_by: 'gateway' })).toEqual(expect.objectContaining({
            provider: 'google',
        }));
        expect(buildModelContract({ id: 'qwen3-coder', owned_by: 'gateway' })).toEqual(expect.objectContaining({
            provider: 'qwen',
        }));
        expect(buildModelContract({ id: 'command-r-plus', owned_by: 'gateway' })).toEqual(expect.objectContaining({
            provider: 'cohere',
        }));
    });

    test('labels Grok models with current tool and structured-output support', () => {
        const contract = buildModelContract({ id: 'grok-4.3', owned_by: 'gateway' });

        expect(contract).toEqual(expect.objectContaining({
            provider: 'xai',
            contextWindow: 1000000,
        }));
        expect(contract.capabilities).toEqual(expect.arrayContaining([
            'chat',
            'streaming',
            'tools',
            'reasoning',
            'structured_outputs',
        ]));
        expect(contract.supports).toEqual(expect.objectContaining({
            chat: true,
            tools: true,
            reasoning: true,
            structured_outputs: true,
        }));
    });

    test('auto-selects Grok for tool and structured-output chat requests', () => {
        const selected = selectAutoModel([
            { id: 'custom-basic-chat', owned_by: 'gateway' },
            { id: 'grok-4.3', owned_by: 'gateway' },
        ], {
            needsTools: true,
            needsStructuredOutputs: true,
            apiMode: 'chat',
        });

        expect(selected).toEqual(expect.objectContaining({
            id: 'grok-4.3',
            provider: 'xai',
        }));
    });
});

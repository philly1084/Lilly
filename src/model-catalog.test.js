const {
    isPublicChatModel,
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
});

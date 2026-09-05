'use strict';

const {
    createResponsesToolCallMapper,
    mapResponsesToolCallEvent,
} = require('./responses-tool-call-compat');

describe('Responses tool-call compatibility mapping', () => {
    test('keeps interleaved item arguments separate and emits each JSON once', () => {
        const mapper = createResponsesToolCallMapper();
        const events = [
            {
                type: 'response.output_item.added',
                item: { type: 'function_call', id: 'fc_item_1', call_id: 'call_1', name: 'add_numbers' },
            },
            {
                type: 'response.output_item.added',
                item: { type: 'function_call', id: 'fc_item_2', call_id: 'call_2', name: 'lookup_weather' },
            },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', output_index: 0, delta: '{"a":' },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_item_2', output_index: 1, delta: '{"city":' },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', output_index: 0, delta: '17,"b":25}' },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_item_2', output_index: 1, delta: '"Halifax"}' },
            {
                type: 'response.function_call_arguments.done',
                item_id: 'fc_item_1',
                output_index: 0,
                arguments: '{"a":17,"b":25}',
            },
            {
                type: 'response.function_call_arguments.done',
                item_id: 'fc_item_2',
                output_index: 1,
                arguments: '{"city":"Halifax"}',
            },
            {
                type: 'response.output_item.done',
                item: {
                    type: 'function_call',
                    id: 'fc_item_1',
                    call_id: 'call_1',
                    name: 'add_numbers',
                    arguments: '{"a":17,"b":25}',
                },
            },
            {
                type: 'response.output_item.done',
                item: {
                    type: 'function_call',
                    id: 'fc_item_2',
                    call_id: 'call_2',
                    name: 'lookup_weather',
                    arguments: '{"city":"Halifax"}',
                },
            },
        ];

        const mapped = events.map((event) => mapResponsesToolCallEvent(event, mapper)).filter(Boolean);
        const argumentsByCall = new Map();
        for (const event of mapped) {
            const callId = event.toolCall.id;
            const current = argumentsByCall.get(callId) || '';
            argumentsByCall.set(callId, current + event.toolCall.function.arguments);
        }

        expect(mapped.filter((event) => event.stage === 'done')).toHaveLength(2);
        expect(mapped.map((event) => event.toolCall.id)).toEqual(expect.arrayContaining(['call_1', 'call_2']));
        expect(mapped.map((event) => event.toolCall.function.name)).toEqual(expect.arrayContaining(['add_numbers', 'lookup_weather']));
        expect(argumentsByCall.get('call_1')).toBe('{"a":17,"b":25}');
        expect(argumentsByCall.get('call_2')).toBe('{"city":"Halifax"}');
        expect(mapped.at(-2)).toEqual(expect.objectContaining({
            stage: 'done',
            toolCall: expect.objectContaining({
                id: 'call_1',
                function: expect.objectContaining({ name: 'add_numbers', arguments: '' }),
            }),
        }));
        expect(mapped.at(-1)).toEqual(expect.objectContaining({
            stage: 'done',
            toolCall: expect.objectContaining({
                id: 'call_2',
                function: expect.objectContaining({ name: 'lookup_weather', arguments: '' }),
            }),
        }));
    });

    test('defers argument output until the Responses item supplies the call id', () => {
        const mapper = createResponsesToolCallMapper();

        expect(mapResponsesToolCallEvent({
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_late',
            output_index: 0,
            delta: '{"value":1}',
        }, mapper)).toBeNull();

        expect(mapResponsesToolCallEvent({
            type: 'response.function_call_arguments.done',
            item_id: 'fc_late',
            output_index: 0,
            arguments: '{"value":1}',
        }, mapper)).toBeNull();

        expect(mapResponsesToolCallEvent({
            type: 'response.output_item.done',
            item: {
                type: 'function_call',
                id: 'fc_late',
                call_id: 'call_late',
                name: 'save_value',
                arguments: '{"value":1}',
            },
        }, mapper)).toEqual({
            stage: 'done',
            toolCall: {
                index: 0,
                id: 'call_late',
                type: 'function',
                function: { name: 'save_value', arguments: '{"value":1}' },
            },
        });
    });
});

const { parseLenientJson } = require('./lenient-json');

describe('parseLenientJson', () => {
    test.each([
        ['JSON', (text) => text],
        ['code fence', (text) => `\`\`\`json\n${text}\n\`\`\``],
        ['surrounding prose', (text) => `Use this payload:\n${text}\nEnd of payload.`],
        ['repaired syntax', (text) => text.replace(/}$/, ', enabled:True,}')],
    ])('preserves typographic content in %s', (_name, wrap) => {
        const content = 'Keep “quoted text”, O’Brien, and 10\u00a0kg; escaped "quotes" and \\ paths.';
        const payload = { 'Client’s “title”': content };

        expect(parseLenientJson(wrap(JSON.stringify(payload))))
            .toEqual(_name === 'repaired syntax' ? { ...payload, enabled: true } : payload);
    });

    test('preserves typographic content inside single-quoted values during repair', () => {
        expect(parseLenientJson("{content:'O’Brien says “hello” at 10\u00a0kg', enabled:True}"))
            .toEqual({ content: 'O’Brien says “hello” at 10\u00a0kg', enabled: true });
    });

    test('still repairs smart quote delimiters and nonbreaking syntax whitespace', () => {
        expect(parseLenientJson('{“content”: “Hello”,\u00a0“enabled”: True}'))
            .toEqual({ content: 'Hello', enabled: true });
    });

    test.each([
        'True False None undefined',
        'https://example.test/True?value=None',
        'Keep this comma,} and this comma, ]',
        'Escaped "True" and a backslash \\ before None',
    ])('preserves quoted content while repairing syntax: %s', (content) => {
        const input = `{\"content\":${JSON.stringify(content)},\"enabled\":True,\"missing\":None,}`;

        expect(parseLenientJson(input)).toEqual({ content, enabled: true, missing: null });
    });

    test('preserves single-quoted content and keys while repairing nested literals', () => {
        expect(parseLenientJson("{'True':'False None undefined,}', values:[True,False,None,undefined,],}"))
            .toEqual({ True: 'False None undefined,}', values: [true, false, null, null] });
    });

    test('parses code-fenced JSON with trailing commas', () => {
        expect(parseLenientJson('```json\n{"question":"Pick one","options":[{"label":"A"},{"label":"B"},],}\n```'))
            .toEqual({
                question: 'Pick one',
                options: [
                    { label: 'A' },
                    { label: 'B' },
                ],
            });
    });

    test('parses single-quoted and bare-key JSON-like objects', () => {
        expect(parseLenientJson("{question:'Pick one', options:[{label:'A'},{label:'B'}], allowFreeText:True, context:None}"))
            .toEqual({
                question: 'Pick one',
                options: [
                    { label: 'A' },
                    { label: 'B' },
                ],
                allowFreeText: true,
                context: null,
            });
    });

    test('wraps bare key-value blobs that omit outer braces', () => {
        expect(parseLenientJson("question:'Pick one', options:['A','B',], allowFreeText:undefined"))
            .toEqual({
                question: 'Pick one',
                options: ['A', 'B'],
                allowFreeText: null,
            });
    });

    test('extracts a structured object from surrounding prose', () => {
        expect(parseLenientJson('Use this payload next:\nquestion: nope\n{"question":"Choose","options":[{"label":"Fast"},{"label":"Safe"}]}'))
            .toEqual({
                question: 'Choose',
                options: [
                    { label: 'Fast' },
                    { label: 'Safe' },
                ],
            });
    });

    test('extracts the first balanced object instead of consuming trailing prose', () => {
        expect(parseLenientJson('Result:\n{"question":"Choose","options":[{"label":"Fast"}]}\nThen discuss {later}.'))
            .toEqual({
                question: 'Choose',
                options: [
                    { label: 'Fast' },
                ],
            });
    });
});

const { extractSaveableDocumentArtifact } = require('./saveable-document-extractor');

describe('saveable document extractor', () => {
    test('extracts a complete HTML file from save-as prose', () => {
        const result = extractSaveableDocumentArtifact({
            assistantText: [
                'I can make it. Save this as `skydiving-research.html`.',
                '```html',
                '<!DOCTYPE html><html><head><title>Skydiving Research</title></head><body><main>Ready</main></body></html>',
                '```',
            ].join('\n'),
        });

        expect(result).toEqual(expect.objectContaining({
            format: 'html',
            filename: 'skydiving-research.html',
            title: 'skydiving-research',
            content: expect.stringContaining('<!DOCTYPE html>'),
        }));
        expect(result.content).not.toContain('I can make it');
    });

    test('removes assistant notes accidentally placed inside an html fence', () => {
        const result = extractSaveableDocumentArtifact({
            assistantText: [
                'Save this as `canada-ledger.html`.',
                '```html',
                'I pulled together a stronger Canada news set and wrote it as original article-style coverage.',
                'Sources used include AP, Statistics Canada, Canada.ca, and CRTC-related reporting.',
                '<!DOCTYPE html><html><head><title>Canada Ledger</title></head><body><main>Ready</main></body></html>',
                'This note belongs in chat, not in the page.',
                '```',
            ].join('\n'),
        });

        expect(result).toEqual(expect.objectContaining({
            format: 'html',
            filename: 'canada-ledger.html',
            content: expect.stringContaining('<!DOCTYPE html>'),
        }));
        expect(result.content).toContain('<title>Canada Ledger</title>');
        expect(result.content).not.toContain('Sources used include');
        expect(result.content).not.toContain('belongs in chat');
    });

    test('ignores short non-document snippets', () => {
        expect(extractSaveableDocumentArtifact({
            assistantText: 'Use `<div>Hello</div>` inside your page.',
        })).toBeNull();
    });
});

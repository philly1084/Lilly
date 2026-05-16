const { extractArtifact, extractPdfText } = require('./artifact-extractor');

describe('extractArtifact', () => {
    test('preserves Mermaid line breaks for preview and reuse', async () => {
        const result = await extractArtifact({
            filename: 'cats-flow.mmd',
            mimeType: 'text/vnd.mermaid',
            buffer: Buffer.from('flowchart TD\nA["Cats"]\nB["Observe them cleaning"]\nA --> B', 'utf8'),
        });

        expect(result).toEqual(expect.objectContaining({
            format: 'mermaid',
            extractedText: 'flowchart TD\nA["Cats"]\nB["Observe them cleaning"]\nA --> B',
            previewHtml: expect.stringContaining('A[&quot;Cats&quot;]'),
        }));
        expect(result.previewHtml).toContain('\nB[&quot;Observe them cleaning&quot;]');
    });

    test('does not treat raw PDF object fallback text as extracted document text', async () => {
        const result = await extractArtifact({
            filename: 'resume.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from([
                '%PDF-1.4',
                '1 0 obj',
                'Creator (Apache FOP Version 2.2)',
                'Producer (Apache FOP Version 2.2)',
                'endobj',
                '2 0 obj',
                'Length 3 0 R',
                'Filter /FlateDecode',
                'stream',
                'h7t0: 5m4S4 ptxPxs',
                'endstream',
                'endobj',
                'xref',
                'trailer',
            ].join('\n'), 'latin1'),
        });

        expect(result).toEqual(expect.objectContaining({
            format: 'pdf',
            extractedText: '',
            previewHtml: '',
            vectorizable: false,
        }));
    });

    test('extracts CID-font PDF text through ToUnicode maps', () => {
        const contentStream = [
            'BT',
            '/F23 12 Tf',
            '[<00030004000500060005000700010009000A000B000C000D000E000F00100011>] TJ',
            'ET',
        ].join('\n');
        const cmapStream = [
            '/CIDInit /ProcSet findresource begin',
            'begincmap',
            '1 begincodespacerange',
            '<0000> <FFFF>',
            'endcodespacerange',
            '14 beginbfchar',
            '<0001> <0020>',
            '<0003> <0050>',
            '<0004> <0068>',
            '<0005> <0069>',
            '<0006> <006c>',
            '<0007> <0070>',
            '<0008> <0041>',
            '<0009> <0052>',
            '<000a> <0065>',
            '<000b> <0073>',
            '<000c> <0075>',
            '<000d> <006d>',
            '<000e> <0065>',
            '<000f> <0050>',
            '<0010> <0044>',
            'endbfchar',
            '1 beginbfrange',
            '<0011> <0012> <0046>',
            'endbfrange',
            'endcmap',
        ].join('\n');
        const pdf = Buffer.from([
            '%PDF-1.4',
            '1 0 obj',
            '<</Resources <</Font <</F23 2 0 R>>>> /Contents 4 0 R>>',
            'endobj',
            '2 0 obj',
            '<</Type /Font /Subtype /CIDFontType2 /ToUnicode 3 0 R>>',
            'endobj',
            '3 0 obj',
            `<< /Length ${cmapStream.length} >>`,
            'stream',
            cmapStream,
            'endstream',
            'endobj',
            '4 0 obj',
            `<< /Length ${contentStream.length} >>`,
            'stream',
            contentStream,
            'endstream',
            'endobj',
        ].join('\n'), 'latin1');

        const result = extractPdfText(pdf);

        expect(result.extractedText).toContain('Philip ResumePDF');
        expect(result.vectorizable).toBe(true);
    });
});

const { extractArtifact } = require('./artifact-extractor');

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
});

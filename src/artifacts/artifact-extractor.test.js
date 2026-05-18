const { extractArtifact, extractPdfText } = require('./artifact-extractor');
const { buildXlsxBufferFromWorkbookSpec } = require('./artifact-renderer');
const { createZip } = require('../utils/zip');

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

    test('extracts XLSX shared strings as cell text instead of indexes', async () => {
        const buffer = buildXlsxBufferFromWorkbookSpec({
            title: 'Shared Strings Smoke',
            sheets: [{
                name: 'Patients',
                rows: [
                    ['Name', 'SIN', 'Postal'],
                    ['Jamie Sampleton', '046 454 286', 'K1A 0B1'],
                ],
            }],
        });

        const result = await extractArtifact({
            filename: 'patients.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer,
        });

        expect(result.extractedText).toContain('Jamie Sampleton');
        expect(result.extractedText).toContain('046 454 286');
        expect(result.extractedText).toContain('K1A 0B1');
        expect(result.extractedText).not.toContain('0 | 1 | 2');
        expect(result.metadata.structuredTables[0]).toEqual(expect.objectContaining({
            name: 'sheet1',
            headers: [
                expect.objectContaining({ id: 'c1', header: 'Name', columnIndex: 0 }),
                expect.objectContaining({ id: 'c2', header: 'SIN', columnIndex: 1 }),
                expect.objectContaining({ id: 'c3', header: 'Postal', columnIndex: 2 }),
            ],
            rows: [
                expect.objectContaining({
                    id: 'r1',
                    rowIndex: 1,
                    cells: [
                        expect.objectContaining({ columnId: 'c1', header: 'Name', value: 'Jamie Sampleton' }),
                        expect.objectContaining({ columnId: 'c2', header: 'SIN', value: '046 454 286' }),
                        expect.objectContaining({ columnId: 'c3', header: 'Postal', value: 'K1A 0B1' }),
                    ],
                }),
            ],
        }));
    });

    test('extracts namespaced XLSX sheets with title rows before the real header', async () => {
        const buffer = createZip([
            {
                name: 'xl/sharedStrings.xml',
                data: [
                    '<?xml version="1.0" encoding="utf-8"?>',
                    '<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
                    '<x:si><x:t>Report Title</x:t></x:si>',
                    '<x:si><x:t>Note row</x:t></x:si>',
                    '<x:si><x:t>Patient Key</x:t></x:si>',
                    '<x:si><x:t>Total Charge</x:t></x:si>',
                    '<x:si><x:t>P001</x:t></x:si>',
                    '</x:sst>',
                ].join(''),
            },
            {
                name: 'xl/worksheets/sheet1.xml',
                data: [
                    '<?xml version="1.0" encoding="utf-8"?>',
                    '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
                    '<x:sheetData>',
                    '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row>',
                    '<x:row r="2"><x:c r="A2" t="s"><x:v>1</x:v></x:c></x:row>',
                    '<x:row r="3"><x:c r="A3" t="s"><x:v>2</x:v></x:c><x:c r="B3" t="s"><x:v>3</x:v></x:c></x:row>',
                    '<x:row r="4"><x:c r="A4" t="s"><x:v>4</x:v></x:c><x:c r="B4"><x:v>1280</x:v></x:c></x:row>',
                    '</x:sheetData>',
                    '</x:worksheet>',
                ].join(''),
            },
        ]);

        const result = await extractArtifact({
            filename: 'namespaced.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer,
        });

        expect(result.extractedText).toContain('Patient Key | Total Charge');
        expect(result.metadata.structuredTables[0]).toEqual(expect.objectContaining({
            headers: [
                expect.objectContaining({ header: 'Patient Key', columnIndex: 0 }),
                expect.objectContaining({ header: 'Total Charge', columnIndex: 1 }),
            ],
            rows: [
                expect.objectContaining({
                    id: 'r1',
                    rowIndex: 3,
                    cells: [
                        expect.objectContaining({ columnId: 'c1', header: 'Patient Key', value: 'P001' }),
                        expect.objectContaining({ columnId: 'c2', header: 'Total Charge', value: '1280' }),
                    ],
                }),
            ],
        }));
    });
});

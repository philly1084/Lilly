const zlib = require('zlib');
const { inferFormat, TEXTUAL_FORMATS } = require('./constants');
const { escapeHtml, normalizeWhitespace, stripHtml, xmlToText } = require('../utils/text');
const { readZipEntries } = require('../utils/zip');

function bufferToUtf8(buffer) {
    return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
}

function buildPreviewHtml(text) {
    if (!text) return '';
    return `<pre>${escapeHtml(text.slice(0, 12000))}</pre>`;
}

function looksLikePdfInternalText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    const pdfTokens = [
        /%?PDF-\d\.\d/i,
        /\b\d+\s+\d+\s+obj\b/i,
        /\bendobj\b/i,
        /\bstream\b/i,
        /\bendstream\b/i,
        /\bFlateDecode\b/i,
        /\b(?:Type|Subtype)\s*\/[A-Za-z0-9]+/i,
        /\b(?:FontDescriptor|CIDToGIDMap|ToUnicode|XRef|trailer|startxref)\b/i,
    ];
    const tokenHits = pdfTokens.reduce((count, pattern) => count + (pattern.test(normalized) ? 1 : 0), 0);
    const pdfObjectLines = normalized
        .split(/\n+/)
        .filter((line) => /\b(?:obj|endobj|stream|endstream|xref|trailer)\b/i.test(line)).length;
    return tokenHits >= 3 || pdfObjectLines >= 4;
}

function extractDocx(buffer) {
    const entries = readZipEntries(buffer);
    const textParts = [];

    for (const [name, content] of entries.entries()) {
        if (name.startsWith('word/') && name.endsWith('.xml')) {
            const text = xmlToText(content.toString('utf8'));
            if (text) {
                textParts.push(text);
            }
        }
    }

    const extractedText = normalizeWhitespace(textParts.join('\n\n'));
    return {
        extractedText,
        previewHtml: buildPreviewHtml(extractedText),
        metadata: { sections: textParts.length },
        vectorizable: Boolean(extractedText),
    };
}

function parseSharedStrings(xml) {
    const values = [];
    const regex = /<si[^>]*>([\s\S]*?)<\/si>/g;
    let match = regex.exec(xml);
    while (match) {
        values.push(xmlToText(match[1]));
        match = regex.exec(xml);
    }
    return values;
}

function extractSheetRows(xml, sharedStrings) {
    const rows = [];
    const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rowMatch = rowRegex.exec(xml);

    while (rowMatch) {
        const cells = [];
        const cellRegex = /<c[^>]*?(?:t=\"([^\"]+)\")?[^>]*>([\s\S]*?)<\/c>/g;
        let cellMatch = cellRegex.exec(rowMatch[1]);
        while (cellMatch) {
            const type = cellMatch[1] || '';
            const body = cellMatch[2];
            const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);
            const inlineMatch = body.match(/<is>([\s\S]*?)<\/is>/);
            let value = '';

            if (type === 's' && valueMatch) {
                value = sharedStrings[Number(valueMatch[1])] || '';
            } else if (inlineMatch) {
                value = xmlToText(inlineMatch[1]);
            } else if (valueMatch) {
                value = xmlToText(valueMatch[1]);
            }

            if (value) {
                cells.push(value);
            }
            cellMatch = cellRegex.exec(rowMatch[1]);
        }

        if (cells.length > 0) {
            rows.push(cells.join(' | '));
        }
        rowMatch = rowRegex.exec(xml);
    }

    return rows;
}

function extractXlsx(buffer) {
    const entries = readZipEntries(buffer);
    const sharedStringsXml = entries.get('xl/sharedStrings.xml');
    const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml.toString('utf8')) : [];
    const sheets = [];
    const textParts = [];

    for (const [name, content] of entries.entries()) {
        if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) {
            const rows = extractSheetRows(content.toString('utf8'), sharedStrings);
            const sheetName = name.split('/').pop().replace('.xml', '');
            sheets.push({ name: sheetName, rowCount: rows.length });
            if (rows.length > 0) {
                textParts.push(`[${sheetName}]\n${rows.join('\n')}`);
            }
        }
    }

    const extractedText = normalizeWhitespace(textParts.join('\n\n'));
    return {
        extractedText,
        previewHtml: buildPreviewHtml(extractedText),
        metadata: { sheets },
        vectorizable: Boolean(extractedText),
    };
}

function decompressPdfStream(streamBuffer) {
    try {
        return zlib.inflateSync(streamBuffer).toString('latin1');
    } catch {
        try {
            return zlib.inflateRawSync(streamBuffer).toString('latin1');
        } catch {
            return streamBuffer.toString('latin1');
        }
    }
}

function decodePdfString(value) {
    return value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\');
}

function extractPdfText(buffer) {
    const raw = buffer.toString('latin1');
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    const textParts = [];
    let match = streamRegex.exec(raw);

    while (match) {
        const streamText = decompressPdfStream(Buffer.from(match[1], 'latin1'));
        const textRegex = /\(([^()]|\\\(|\\\))*\)\s*Tj/g;
        let textMatch = textRegex.exec(streamText);
        while (textMatch) {
            textParts.push(decodePdfString(textMatch[0].replace(/\)\s*Tj$/, '').slice(1)));
            textMatch = textRegex.exec(streamText);
        }

        const arrayRegex = /\[(.*?)\]\s*TJ/g;
        let arrayMatch = arrayRegex.exec(streamText);
        while (arrayMatch) {
            const inlineTexts = arrayMatch[1].match(/\(([^()]|\\\(|\\\))*\)/g) || [];
            const combined = inlineTexts.map((part) => decodePdfString(part.slice(1, -1))).join(' ');
            if (combined.trim()) {
                textParts.push(combined);
            }
            arrayMatch = arrayRegex.exec(streamText);
        }

        match = streamRegex.exec(raw);
    }

    const fallback = (raw.match(/[A-Za-z0-9][A-Za-z0-9 .,;:'"()\-_/]{4,}/g) || []).slice(0, 300);
    let extractedText = normalizeWhitespace(textParts.join('\n') || fallback.join('\n'));
    if (!textParts.length && looksLikePdfInternalText(extractedText)) {
        extractedText = '';
    }

    return {
        extractedText,
        previewHtml: buildPreviewHtml(extractedText),
        metadata: { extractedFromPdf: Boolean(extractedText) },
        vectorizable: Boolean(extractedText),
    };
}

function extractLegacyDoc(buffer) {
    const raw = buffer.toString('latin1');
    const matches = raw.match(/[A-Za-z0-9][A-Za-z0-9 .,;:'"()\-_/]{4,}/g) || [];
    const extractedText = normalizeWhitespace(matches.join('\n').slice(0, 20000));

    return {
        extractedText,
        previewHtml: buildPreviewHtml(extractedText),
        metadata: { bestEffort: true },
        vectorizable: Boolean(extractedText),
    };
}

function extractTextFormat(format, buffer) {
    const content = bufferToUtf8(buffer);
    const extractedText = format === 'html'
        ? normalizeWhitespace(stripHtml(content))
        : (format === 'mermaid'
            ? String(content || '').replace(/\r\n?/g, '\n').trim()
            : normalizeWhitespace(content));
    const previewHtml = format === 'html' ? content : buildPreviewHtml(extractedText);

    return {
        extractedText,
        previewHtml,
        metadata: {},
        vectorizable: Boolean(extractedText),
    };
}

async function extractArtifact({ filename, mimeType, buffer }) {
    const format = inferFormat(filename, mimeType);

    if (TEXTUAL_FORMATS.has(format)) {
        return {
            format,
            ...extractTextFormat(format, buffer),
        };
    }

    if (format === 'docx') {
        return { format, ...extractDocx(buffer) };
    }

    if (format === 'xlsx') {
        return { format, ...extractXlsx(buffer) };
    }

    if (format === 'pdf') {
        return { format, ...extractPdfText(buffer) };
    }

    if (format === 'doc') {
        return { format, ...extractLegacyDoc(buffer) };
    }

    return {
        format,
        extractedText: '',
        previewHtml: '',
        metadata: {},
        vectorizable: false,
    };
}

module.exports = {
    extractArtifact,
    extractPdfText,
};

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
    const regex = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
    let match = regex.exec(xml);
    while (match) {
        values.push(xmlToText(match[1]));
        match = regex.exec(xml);
    }
    return values;
}

function columnLettersToIndex(ref = '') {
    const letters = String(ref || '').replace(/[^A-Z]/gi, '').toUpperCase();
    if (!letters) return null;
    let index = 0;
    for (const letter of letters) {
        index = index * 26 + (letter.charCodeAt(0) - 64);
    }
    return index - 1;
}

function extractSheetRows(xml, sharedStrings) {
    const rows = [];
    const rowRegex = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g;
    let rowMatch = rowRegex.exec(xml);

    while (rowMatch) {
        const cells = [];
        const cellRegex = /<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g;
        let cellMatch = cellRegex.exec(rowMatch[1]);
        while (cellMatch) {
            const attrs = cellMatch[1] || '';
            const type = (attrs.match(/\bt=["']([^"']+)["']/) || [])[1] || '';
            const ref = (attrs.match(/\br=["']([^"']+)["']/) || [])[1] || '';
            const columnIndex = columnLettersToIndex(ref);
            const body = cellMatch[2];
            const valueMatch = body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/);
            const inlineMatch = body.match(/<(?:\w+:)?is>([\s\S]*?)<\/(?:\w+:)?is>/);
            let value = '';

            if (type === 's' && valueMatch) {
                value = sharedStrings[Number(valueMatch[1])] || '';
            } else if (inlineMatch) {
                value = xmlToText(inlineMatch[1]);
            } else if (valueMatch) {
                value = xmlToText(valueMatch[1]);
            }

            if (value) {
                cells.push({
                    columnIndex: columnIndex === null ? cells.length : columnIndex,
                    value,
                });
            }
            cellMatch = cellRegex.exec(rowMatch[1]);
        }

        if (cells.length > 0) {
            rows.push(cells.sort((a, b) => a.columnIndex - b.columnIndex));
        }
        rowMatch = rowRegex.exec(xml);
    }

    return rows;
}

function findHeaderRowIndex(rows = []) {
    const candidates = rows.slice(0, 12)
        .map((row, index) => ({ index, width: Array.isArray(row) ? row.length : 0 }))
        .filter((entry) => entry.width > 1);
    if (candidates.length === 0) {
        return rows[0] ? 0 : -1;
    }
    const widest = candidates.reduce((best, entry) => (
        entry.width > best.width ? entry : best
    ), candidates[0]);
    return widest.index;
}

function buildStructuredSheetRows(rows = []) {
    const headerRowIndex = findHeaderRowIndex(rows);
    const headerRow = headerRowIndex >= 0 ? rows[headerRowIndex] : null;
    const headers = headerRow
        ? headerRow.map((cell, index) => ({
            id: `c${index + 1}`,
            header: String(cell.value || '').trim() || `Column ${index + 1}`,
            columnIndex: cell.columnIndex,
        }))
        : [];
    const headersByColumnIndex = headers.reduce((acc, header) => {
        if (Number.isInteger(header.columnIndex)) {
            acc.set(header.columnIndex, header);
        }
        return acc;
    }, new Map());
    return {
        headers,
        rows: rows.slice(headerRowIndex + 1).map((row, rowIndex) => ({
            id: `r${rowIndex + 1}`,
            rowIndex: headerRowIndex + rowIndex + 1,
            cells: row.map((cell, cellIndex) => ({
                columnId: headersByColumnIndex.get(cell.columnIndex)?.id || headers[cellIndex]?.id || `c${cellIndex + 1}`,
                columnIndex: cell.columnIndex,
                header: headersByColumnIndex.get(cell.columnIndex)?.header || headers[cellIndex]?.header || `Column ${cellIndex + 1}`,
                value: cell.value,
            })),
        })),
    };
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
            const structured = buildStructuredSheetRows(rows);
            sheets.push({
                name: sheetName,
                rowCount: rows.length,
                headers: structured.headers,
                rows: structured.rows,
            });
            if (rows.length > 0) {
                textParts.push(`[${sheetName}]\n${rows.map((row) => row.map((cell) => cell.value).join(' | ')).join('\n')}`);
            }
        }
    }

    const extractedText = normalizeWhitespace(textParts.join('\n\n'));
    return {
        extractedText,
        previewHtml: buildPreviewHtml(extractedText),
        metadata: {
            sheets: sheets.map((sheet) => ({
                name: sheet.name,
                rowCount: sheet.rowCount,
            })),
            structuredTables: sheets,
        },
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

function parsePdfObjects(raw = '') {
    const objects = new Map();
    const objectRegex = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
    let match = objectRegex.exec(raw);
    while (match) {
        objects.set(match[1], match[2]);
        match = objectRegex.exec(raw);
    }
    return objects;
}

function extractPdfObjectStream(body = '') {
    const match = String(body || '').match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
    if (!match) {
        return '';
    }
    return decompressPdfStream(Buffer.from(match[1], 'latin1'));
}

function decodeUtf16BeHex(hex = '') {
    const normalized = String(hex || '').replace(/[^0-9a-f]/ig, '');
    if (!normalized) {
        return '';
    }

    const chars = [];
    for (let index = 0; index + 3 < normalized.length; index += 4) {
        const codePoint = parseInt(normalized.slice(index, index + 4), 16);
        if (Number.isFinite(codePoint)) {
            chars.push(String.fromCharCode(codePoint));
        }
    }
    return chars.join('');
}

function parseToUnicodeCMap(cmapText = '') {
    const map = new Map();
    const text = String(cmapText || '');
    if (!/\bbegin(?:bfchar|bfrange)\b/.test(text)) {
        return map;
    }

    const charSectionRegex = /\bbeginbfchar\b([\s\S]*?)\bendbfchar\b/g;
    let charSection = charSectionRegex.exec(text);
    while (charSection) {
        const charRegex = /<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/g;
        let charMatch = charRegex.exec(charSection[1]);
        while (charMatch) {
            map.set(charMatch[1].toLowerCase(), decodeUtf16BeHex(charMatch[2]));
            charMatch = charRegex.exec(charSection[1]);
        }
        charSection = charSectionRegex.exec(text);
    }

    const rangeSectionRegex = /\bbeginbfrange\b([\s\S]*?)\bendbfrange\b/g;
    let rangeSection = rangeSectionRegex.exec(text);
    while (rangeSection) {
        const rangeRegex = /<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>\s+(?:<([0-9a-fA-F]+)>|\[([^\]]+)\])/g;
        let rangeMatch = rangeRegex.exec(rangeSection[1]);
        while (rangeMatch) {
            const start = parseInt(rangeMatch[1], 16);
            const end = parseInt(rangeMatch[2], 16);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 512) {
                rangeMatch = rangeRegex.exec(rangeSection[1]);
                continue;
            }

            if (rangeMatch[3]) {
                const destinationStart = parseInt(rangeMatch[3], 16);
                for (let code = start; code <= end; code += 1) {
                    const sourceHex = code.toString(16).padStart(rangeMatch[1].length, '0');
                    const destinationHex = (destinationStart + (code - start)).toString(16).padStart(rangeMatch[3].length, '0');
                    map.set(sourceHex.toLowerCase(), decodeUtf16BeHex(destinationHex));
                }
            } else if (rangeMatch[4]) {
                const destinations = Array.from(rangeMatch[4].matchAll(/<([0-9a-fA-F]+)>/g));
                destinations.forEach((destination, offset) => {
                    const code = start + offset;
                    if (code <= end) {
                        const sourceHex = code.toString(16).padStart(rangeMatch[1].length, '0');
                        map.set(sourceHex.toLowerCase(), decodeUtf16BeHex(destination[1]));
                    }
                });
            }

            rangeMatch = rangeRegex.exec(rangeSection[1]);
        }
        rangeSection = rangeSectionRegex.exec(text);
    }

    map.delete('0000');
    return map;
}

function buildPdfFontUnicodeMaps(raw = '') {
    const objects = parsePdfObjects(raw);
    const unicodeMapsByObject = new Map();
    const unicodeMapsByFontObject = new Map();
    const unicodeMapsByFontName = new Map();
    const allUnicodeMaps = [];

    for (const [objectId, body] of objects.entries()) {
        const streamText = extractPdfObjectStream(body);
        const map = parseToUnicodeCMap(streamText);
        if (map.size > 0) {
            unicodeMapsByObject.set(objectId, map);
            allUnicodeMaps.push(map);
        }
    }

    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let streamMatch = streamRegex.exec(raw);
    while (streamMatch) {
        const map = parseToUnicodeCMap(decompressPdfStream(Buffer.from(streamMatch[1], 'latin1')));
        if (map.size > 0 && !allUnicodeMaps.includes(map)) {
            allUnicodeMaps.push(map);
        }
        streamMatch = streamRegex.exec(raw);
    }

    for (const [objectId, body] of objects.entries()) {
        const toUnicodeMatch = String(body || '').match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
        if (toUnicodeMatch && unicodeMapsByObject.has(toUnicodeMatch[1])) {
            unicodeMapsByFontObject.set(objectId, unicodeMapsByObject.get(toUnicodeMatch[1]));
        }
    }

    const fontResourceRegex = /\/([A-Za-z][A-Za-z0-9_.-]*)\s+(\d+)\s+0\s+R/g;
    let fontMatch = fontResourceRegex.exec(raw);
    while (fontMatch) {
        const map = unicodeMapsByFontObject.get(fontMatch[2]);
        if (map) {
            unicodeMapsByFontName.set(fontMatch[1], map);
        }
        fontMatch = fontResourceRegex.exec(raw);
    }

    return {
        byFontName: unicodeMapsByFontName,
        fallback: allUnicodeMaps.length > 0 ? allUnicodeMaps[0] : null,
    };
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

function decodePdfHexString(hex = '', unicodeMap = null) {
    const normalized = String(hex || '').replace(/[^0-9a-f]/ig, '').toLowerCase();
    if (!normalized) {
        return '';
    }

    if (unicodeMap && unicodeMap.size > 0) {
        const width = Array.from(unicodeMap.keys()).reduce((max, key) => Math.max(max, key.length), 0) || 4;
        const chars = [];
        for (let index = 0; index < normalized.length; index += width) {
            const code = normalized.slice(index, index + width);
            if (!code) {
                continue;
            }
            if (unicodeMap.has(code)) {
                chars.push(unicodeMap.get(code));
            } else if (code.length === 4 && code.startsWith('00')) {
                chars.push(String.fromCharCode(parseInt(code.slice(2), 16)));
            }
        }
        return chars.join('');
    }

    if (/^(?:00[0-7][0-9a-f])+$/i.test(normalized)) {
        return decodeUtf16BeHex(normalized);
    }

    const bytes = [];
    for (let index = 0; index + 1 < normalized.length; index += 2) {
        bytes.push(parseInt(normalized.slice(index, index + 2), 16));
    }
    return Buffer.from(bytes).toString('latin1');
}

function decodePdfTextArray(arrayBody = '', unicodeMap = null) {
    const parts = [];
    const tokenRegex = /<([0-9a-fA-F\s]+)>|\((?:[^()]|\\\(|\\\)|\\\\|\\n|\\r|\\t)*\)/g;
    let match = tokenRegex.exec(arrayBody);
    while (match) {
        if (match[1]) {
            parts.push(decodePdfHexString(match[1], unicodeMap));
        } else {
            parts.push(decodePdfString(match[0].slice(1, -1)));
        }
        match = tokenRegex.exec(arrayBody);
    }
    return parts.join('');
}

function extractPdfTextOperators(streamText = '', fontMaps = {}) {
    const textParts = [];
    let currentFont = '';
    const fallbackMap = fontMaps.fallback || null;
    const operatorRegex = /\/([A-Za-z][A-Za-z0-9_.-]*)\s+[-+]?\d*\.?\d+\s+Tf|<([0-9a-fA-F\s]+)>\s*Tj|\((?:[^()]|\\\(|\\\)|\\\\|\\n|\\r|\\t)*\)\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
    let match = operatorRegex.exec(streamText);

    while (match) {
        if (match[1]) {
            currentFont = match[1];
            match = operatorRegex.exec(streamText);
            continue;
        }

        const unicodeMap = fontMaps.byFontName?.get(currentFont) || fallbackMap;
        let decoded = '';
        if (match[2]) {
            decoded = decodePdfHexString(match[2], unicodeMap);
        } else if (match[3]) {
            decoded = decodePdfTextArray(match[3], unicodeMap);
        } else {
            decoded = decodePdfString(match[0].replace(/\)\s*Tj$/, '').slice(1));
        }

        if (decoded.trim()) {
            textParts.push(decoded);
        }
        match = operatorRegex.exec(streamText);
    }

    return textParts;
}

function extractPdfText(buffer) {
    const raw = buffer.toString('latin1');
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    const fontMaps = buildPdfFontUnicodeMaps(raw);
    const textParts = [];
    let match = streamRegex.exec(raw);

    while (match) {
        const streamText = decompressPdfStream(Buffer.from(match[1], 'latin1'));
        textParts.push(...extractPdfTextOperators(streamText, fontMaps));

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

const { stripNullCharacters } = require('../utils/text');

const HTML_DOCUMENT_PATTERN = /(?:<!doctype\s+html\b|<html\b[\s\S]*?>)/i;
const HTML_CLOSE_PATTERN = /<\/html\s*>/i;
const HTML_FILENAME_PATTERN = /[`"']?([a-z0-9][a-z0-9._ -]{1,100}\.html?)[`"']?/i;
const SAVE_AS_FILENAME_PATTERN = /\b(?:save|saved|saving|name|named|called|download|open)\b[\s\S]{0,40}?\b(?:as|to)?\s*[`"']?([a-z0-9][a-z0-9._ -]{1,100}\.html?)[`"']?/i;

function cleanFilename(value = '') {
    const candidate = String(value || '')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

    return /\.html?$/i.test(candidate) ? candidate : '';
}

function extractTitleFromHtml(html = '') {
    const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return String(match?.[1] || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractFilenameFromText(text = '') {
    const source = String(text || '');
    const explicit = source.match(SAVE_AS_FILENAME_PATTERN)?.[1]
        || source.match(HTML_FILENAME_PATTERN)?.[1]
        || '';

    return cleanFilename(explicit);
}

function trimHtmlDocument(html = '') {
    let source = String(html || '').trim();
    if (!source) {
        return '';
    }

    const startMatch = source.match(HTML_DOCUMENT_PATTERN);
    if (startMatch && Number.isInteger(startMatch.index) && startMatch.index > 0) {
        source = source.slice(startMatch.index).trim();
    }

    const closeMatch = source.match(HTML_CLOSE_PATTERN);
    if (!closeMatch || !Number.isInteger(closeMatch.index)) {
        return source;
    }

    return source.slice(0, closeMatch.index + closeMatch[0].length).trim();
}

function extractHtmlFromFence(text = '') {
    const fencePattern = /```([a-z0-9_-]*)\s*([\s\S]*?)```/ig;
    let match;

    while ((match = fencePattern.exec(String(text || ''))) !== null) {
        const language = String(match[1] || '').trim().toLowerCase();
        const content = stripNullCharacters(String(match[2] || '')).trim();
        if (!content) {
            continue;
        }

        if (language === 'html' || HTML_DOCUMENT_PATTERN.test(content)) {
            return trimHtmlDocument(content);
        }
    }

    return '';
}

function extractRawHtml(text = '') {
    const source = stripNullCharacters(String(text || '')).trim();
    const match = source.match(HTML_DOCUMENT_PATTERN);
    if (!match || !Number.isInteger(match.index)) {
        return '';
    }

    return trimHtmlDocument(source.slice(match.index));
}

function hasSaveableDocumentIntent({ requestText = '', assistantText = '' } = {}) {
    const combined = `${requestText}\n${assistantText}`.toLowerCase();
    return /\b(save|saved|download|file|artifact|document|html)\b/.test(combined)
        || /\.html?\b/i.test(combined);
}

function extractSaveableDocumentArtifact({ assistantText = '', requestText = '' } = {}) {
    if (!hasSaveableDocumentIntent({ requestText, assistantText })) {
        return null;
    }

    const content = extractHtmlFromFence(assistantText) || extractRawHtml(assistantText);
    if (!content || content.length < 80 || !HTML_DOCUMENT_PATTERN.test(content)) {
        return null;
    }

    const filename = extractFilenameFromText(assistantText) || extractFilenameFromText(requestText);
    const filenameTitle = filename ? filename.replace(/\.html?$/i, '') : '';
    const htmlTitle = extractTitleFromHtml(content);
    const title = filenameTitle || htmlTitle || 'html-document';

    return {
        format: 'html',
        content,
        title,
        filename,
        metadata: {
            autoPersistedFromAssistantText: true,
            requestedFilename: filename || null,
        },
    };
}

function looksLikeSaveableDocumentResponse(value = '') {
    return Boolean(extractSaveableDocumentArtifact({ assistantText: value }));
}

module.exports = {
    extractSaveableDocumentArtifact,
    looksLikeSaveableDocumentResponse,
};

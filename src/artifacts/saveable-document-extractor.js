const { stripNullCharacters } = require('../utils/text');

const HTML_DOCUMENT_PATTERN = /(?:<!doctype\s+html\b|<html\b[\s\S]*?>)/i;
const HTML_CLOSE_PATTERN = /<\/html\s*>/i;
const HTML_FILENAME_PATTERN = /[`"']?([a-z0-9][a-z0-9._ -]{1,100}\.html?)[`"']?/i;
const SAVE_AS_FILENAME_PATTERN = /\b(?:save|saved|saving|name|named|called|download|open)\b[\s\S]{0,40}?\b(?:as|to)?\s*[`"']?([a-z0-9][a-z0-9._ -]{1,100}\.html?)[`"']?/i;
const HTML_FENCE_PATTERN = /([`']{3,})([a-z0-9_-]*)\s*([\s\S]*?)\1/ig;
const INTERNAL_THOUGHT_TAG_PATTERN = /<\s*(?:think|thinking|thought|analysis|reasoning)(?:\s[^>]*)?>[\s\S]*?<\s*\/\s*(?:think|thinking|thought|analysis|reasoning)\s*>/ig;
const INTERNAL_THOUGHT_BRACKET_PATTERN = /\[\s*(?:think|thinking|thought|analysis|reasoning)\s*\][\s\S]*?\[\s*\/\s*(?:think|thinking|thought|analysis|reasoning)\s*\]/ig;
const INTERNAL_THOUGHT_MARKER_PATTERN = /(?:^|\n)\s*(?:begin|start)\s+(?:think|thinking|thought|analysis|reasoning)\s*\n[\s\S]*?\n\s*(?:end|stop)\s+(?:think|thinking|thought|analysis|reasoning)\s*(?=\n|$)/ig;
const INTERNAL_THOUGHT_COMMENT_PATTERN = /<!--\s*(?:(?:begin|start)\s+)?(?:think|thinking|thought|analysis|reasoning)\b[\s\S]*?-->/ig;
const INTERNAL_THOUGHT_FENCE_PATTERN = /(?:^|\n)\s*([`']{3,})(?:think|thinking|thought|analysis|reasoning)\b[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/ig;

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

function stripInternalThoughtMarkup(value = '') {
    return stripNullCharacters(String(value || ''))
        .replace(INTERNAL_THOUGHT_TAG_PATTERN, '')
        .replace(INTERNAL_THOUGHT_BRACKET_PATTERN, '')
        .replace(INTERNAL_THOUGHT_MARKER_PATTERN, '')
        .replace(INTERNAL_THOUGHT_COMMENT_PATTERN, '')
        .replace(INTERNAL_THOUGHT_FENCE_PATTERN, '')
        .trim();
}

function trimHtmlDocument(html = '') {
    let source = stripInternalThoughtMarkup(html).trim();
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
    let match;

    HTML_FENCE_PATTERN.lastIndex = 0;
    while ((match = HTML_FENCE_PATTERN.exec(String(text || ''))) !== null) {
        const language = String(match[2] || '').trim().toLowerCase();
        const content = stripInternalThoughtMarkup(match[3] || '');
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
    const source = stripInternalThoughtMarkup(text).trim();
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

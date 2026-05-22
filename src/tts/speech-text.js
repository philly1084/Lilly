const { normalizeWhitespace, stripHtml, stripNullCharacters } = require('../utils/text');

function createServiceError(statusCode, message, code = 'tts_error') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

function normalizeSpeechSentence(line = '') {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
        return '';
    }

    if (/[.!?]$/.test(trimmed)) {
        return trimmed;
    }

    if (/[:;]$/.test(trimmed)) {
        return `${trimmed.slice(0, -1)}.`;
    }

    return `${trimmed}.`;
}

function trimUrlPunctuation(value = '') {
    const url = String(value || '');
    const trailing = url.match(/[),.;:!?]+$/)?.[0] || '';
    return {
        body: trailing ? url.slice(0, -trailing.length) : url,
        trailing,
    };
}

function normalizeUrlForSpeech(url = '') {
    const { body, trailing } = trimUrlPunctuation(url);
    if (!body) {
        return trailing;
    }

    const parseTarget = /^https?:\/\//i.test(body) ? body : `https://${body.replace(/^www\./i, '')}`;
    let host = '';
    let path = '';

    try {
        const parsed = new URL(parseTarget);
        host = String(parsed.hostname || '').replace(/^www\./i, '');
        path = String(parsed.pathname || '').replace(/\/+$/g, '');
    } catch (_error) {
        const withoutProtocol = body.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
        const [rawHost, ...rest] = withoutProtocol.split('/');
        host = rawHost;
        path = rest.length ? `/${rest.join('/')}` : '';
    }

    const hostSpeech = host
        .split('.')
        .map((part) => part.replace(/[-_]+/g, ' ').trim())
        .filter(Boolean)
        .join(' dot ');
    const decodeUrlPart = (part = '') => {
        try {
            return decodeURIComponent(part);
        } catch (_error) {
            return part;
        }
    };
    const pathSpeech = path
        ? path
            .split('/')
            .map((part) => decodeUrlPart(part).replace(/[-_]+/g, ' ').replace(/[?#].*$/g, '').trim())
            .filter(Boolean)
            .map((part) => `slash ${part}`)
            .join(' ')
        : '';
    const speech = [hostSpeech, pathSpeech].filter(Boolean).join(' ');
    return (speech || body).trim();
}

function normalizeUrlsForSpeech(input = '') {
    const urlPattern = /\b(?:https?:\/\/|www\.)[^\s<>)\]]+/gi;
    const domainPattern = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|ai|dev|app|edu|gov|ca|co|us|uk|help|buzz|cloud|site|online|xyz|info|biz)(?:\/[^\s<>)\]]*)?/gi;
    const protectedUrls = [];

    const withUrlPlaceholders = String(input || '').replace(urlPattern, (match) => {
        const index = protectedUrls.push(normalizeUrlForSpeech(match)) - 1;
        return ` KIMIBUILT_URL_${index}_ `;
    });

    return withUrlPlaceholders
        .replace(domainPattern, (match) => normalizeUrlForSpeech(match))
        .replace(/KIMIBUILT_URL_(\d+)_/g, (_match, index) => protectedUrls[Number(index)] || '');
}

function stripMarkdownForSpeech(input = '') {
    const markdown = String(input || '')
        .replace(/\r\n?/g, '\n')
        .replace(/```[\s\S]*?```/g, '\nCode example omitted.\n')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/\|/g, ' ')
        .replace(/^\s*[-=]{3,}\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n');

    return normalizeUrlsForSpeech(stripHtml(markdown));
}

function stripMalformedUnicodeEscapes(input = '') {
    return String(input || '')
        .replace(/\\u(?![0-9a-fA-F]{4})/g, '')
        .replace(/\\u[0-9a-fA-F]{1,3}(?![0-9a-fA-F])/g, '')
        .replace(/\\x(?![0-9a-fA-F]{2})/g, '')
        .replace(/\\x[0-9a-fA-F](?![0-9a-fA-F])/g, '')
        .replace(/\\u\{[0-9a-fA-F]+\}(?![0-9a-fA-F])/g, '');
}

function stripUnpairedSurrogates(input = '') {
    const value = String(input || '');
    let output = '';

    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);

        if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
            const nextCodeUnit = value.charCodeAt(index + 1);
            if (nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
                output += value[index] + value[index + 1];
                index += 1;
            }
            continue;
        }

        if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
            continue;
        }

        output += value[index];
    }

    return output;
}

function clampSpeechText(text = '', maxTextChars = 2400) {
    if (!text || text.length <= maxTextChars) {
        return text;
    }

    const truncated = text.slice(0, maxTextChars);
    const lastSentenceBoundary = Math.max(
        truncated.lastIndexOf('. '),
        truncated.lastIndexOf('! '),
        truncated.lastIndexOf('? '),
    );
    const lastWhitespace = truncated.lastIndexOf(' ');
    const safeCutoff = Math.max(lastSentenceBoundary, lastWhitespace);

    return `${(safeCutoff > 200 ? truncated.slice(0, safeCutoff) : truncated).trim()}...`;
}

function normalizeTextForSpeech(input = '', maxTextChars = 2400) {
    const sanitizedInput = stripMalformedUnicodeEscapes(stripUnpairedSurrogates(stripNullCharacters(input || '')));
    const stripped = stripMarkdownForSpeech(sanitizedInput);
    const normalized = normalizeWhitespace(stripped)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(normalizeSpeechSentence)
        .join(' ')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

    const clamped = clampSpeechText(normalized, maxTextChars);
    if (!clamped) {
        throw createServiceError(400, 'No speakable text was provided.', 'empty_text');
    }

    return clamped;
}

module.exports = {
    clampSpeechText,
    createServiceError,
    normalizeSpeechSentence,
    normalizeTextForSpeech,
    stripMalformedUnicodeEscapes,
    stripMarkdownForSpeech,
    normalizeUrlForSpeech,
    normalizeUrlsForSpeech,
    stripUnpairedSurrogates,
};

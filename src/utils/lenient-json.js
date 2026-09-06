function normalizeJsonLikeText(value = '') {
    return String(value || '')
        .replace(/^\uFEFF/, '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, '\'')
        .replace(/\u00A0/g, ' ')
        .trim();
}

function unwrapCodeFence(text = '') {
    const trimmed = normalizeJsonLikeText(text);
    const match = trimmed.match(/^```(?:json|survey|kb-survey)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : trimmed;
}

function extractStructuredSegment(text = '') {
    const source = unwrapCodeFence(text);
    if (!source) {
        return '';
    }

    const objectStart = source.indexOf('{');
    const arrayStart = source.indexOf('[');
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    if (starts.length === 0) {
        return source;
    }

    const start = Math.min(...starts);
    if (objectStart < 0 && arrayStart >= 0) {
        const prefix = source.slice(0, arrayStart).trim();
        if (/[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(prefix)) {
            return source;
        }
    }

    const stack = [];
    let quote = null;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
        const char = source[index];

        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === quote) {
                quote = null;
            }

            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }

        if (char === '{' || char === '[') {
            stack.push(char);
            continue;
        }

        if (char === '}' || char === ']') {
            const expectedOpening = char === '}' ? '{' : '[';
            if (stack[stack.length - 1] === expectedOpening) {
                stack.pop();
            }

            if (stack.length === 0) {
                return source.slice(start, index + 1).trim();
            }
        }
    }

    return source.slice(start).trim();
}

function stripLineComments(text = '') {
    return String(text || '')
        .split('\n')
        .map((line) => line.replace(/^\s*\/\/.*$/g, ''))
        .join('\n');
}

function quoteBareKeys(text = '') {
    return String(text || '').replace(/(^|[{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/gm, '$1"$2"$3');
}

function convertSingleQuotedKeys(text = '') {
    return String(text || '').replace(/(^|[{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(\s*:)/gm, (_, prefix, key, suffix) => {
        const normalizedKey = String(key || '').replace(/"/g, '\\"');
        return `${prefix}"${normalizedKey}"${suffix}`;
    });
}

function convertSingleQuotedValues(text = '') {
    return String(text || '').replace(/([:\[,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, prefix, value) => {
        const normalizedValue = String(value || '')
            .replace(/\\'/g, '\'')
            .replace(/"/g, '\\"');
        return `${prefix}"${normalizedValue}"`;
    });
}

function normalizePythonLiterals(text = '') {
    const literals = { None: 'null', True: 'true', False: 'false', undefined: 'null' };
    // Quoted keys/values (including converted single quotes) are content, not syntax.
    return String(text || '').replace(/"(?:\\.|[^"\\])*"|\b(?:None|True|False|undefined)\b/g,
        (token) => token.startsWith('"') ? token : literals[token]);
}

function removeTrailingCommas(text = '') {
    return String(text || '').replace(/"(?:\\.|[^"\\])*"|,\s*([}\]])/g,
        (token, closing) => closing || token);
}

function trimTrailingSemicolons(text = '') {
    return String(text || '').replace(/;\s*$/g, '').trim();
}

function wrapBareObjectText(text = '') {
    const trimmed = String(text || '').trim();
    if (!trimmed || /^[{\[]/.test(trimmed)) {
        return trimmed;
    }

    return /^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(trimmed)
        ? `{${trimmed}}`
        : trimmed;
}

function repairJsonLikeText(text = '') {
    const wrapped = wrapBareObjectText(stripLineComments(text));
    return trimTrailingSemicolons(
        removeTrailingCommas(
            normalizePythonLiterals(
                convertSingleQuotedValues(
                    convertSingleQuotedKeys(
                        quoteBareKeys(
                            wrapped,
                        ),
                    ),
                ),
            ),
        ),
    );
}

function tryParseJson(text = '') {
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (_error) {
        return null;
    }
}

function parseLenientJson(value = '') {
    if (typeof value === 'object' && value !== null) {
        return value;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const direct = tryParseJson(unwrapCodeFence(value));
    if (direct !== null) {
        return direct;
    }

    const extracted = extractStructuredSegment(value);
    const extractedParsed = tryParseJson(extracted);
    if (extractedParsed !== null) {
        return extractedParsed;
    }

    const repaired = repairJsonLikeText(extracted);
    return tryParseJson(repaired)
        || tryParseJson(wrapBareObjectText(repaired));
}

module.exports = {
    extractStructuredSegment,
    normalizeJsonLikeText,
    parseLenientJson,
    repairJsonLikeText,
    unwrapCodeFence,
};

(function initModelOutputParser(globalScope) {
    const ROOT = globalScope || {};

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escapeRegExp(value) {
        return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function tryParseJson(value) {
        const text = String(value || '').trim();
        if (!text || !/^[\[{]/.test(text)) {
            return null;
        }

        try {
            return JSON.parse(text);
        } catch (_error) {
            return null;
        }
    }

    function unwrapWholeFence(value) {
        const text = String(value || '').trim();
        const match = text.match(/^```([a-z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/i);
        if (!match) {
            return { text, language: '' };
        }

        return {
            text: String(match[2] || '').trim(),
            language: String(match[1] || '').trim().toLowerCase(),
        };
    }

    function extractTextFromContentParts(parts) {
        if (!Array.isArray(parts)) {
            return '';
        }

        return parts
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }
                if (!part || typeof part !== 'object') {
                    return '';
                }
                if (isInternalReasoningPart(part)) {
                    return '';
                }
                if (typeof part.text === 'string') {
                    return part.text;
                }
                if (typeof part.content === 'string') {
                    return part.content;
                }
                if (typeof part.output_text === 'string') {
                    return part.output_text;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n\n');
    }

    function isInternalReasoningPart(value) {
        if (!value || typeof value !== 'object') {
            return false;
        }

        const type = String(value.type || value.kind || '').trim().toLowerCase();
        if (!type) {
            return false;
        }

        return [
            'analysis',
            'reasoning',
            'reasoning_summary',
            'reasoning_summary_text',
            'thinking',
            'think',
        ].includes(type);
    }

    function extractTextFromObject(value) {
        if (!value || typeof value !== 'object') {
            return '';
        }

        const directKeys = [
            'markdown',
            'content',
            'result',
            'response',
            'answer',
            'message',
            'text',
            'output_text',
            'output',
        ];

        for (const key of directKeys) {
            const candidate = value[key];
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate;
            }
            if (Array.isArray(candidate)) {
                const partText = extractTextFromContentParts(candidate);
                if (partText.trim()) {
                    return partText;
                }
            }
            if (candidate && typeof candidate === 'object') {
                const nested = extractTextFromObject(candidate);
                if (nested.trim()) {
                    return nested;
                }
            }
        }

        if (Array.isArray(value.choices)) {
            const choiceText = value.choices
                .map((choice) => extractTextFromObject(choice?.message || choice?.delta || choice))
                .filter(Boolean)
                .join('\n\n');
            if (choiceText.trim()) {
                return choiceText;
            }
        }

        return '';
    }

    function stripXmlLikeModelWrappers(value) {
        let text = String(value || '').trim();
        const finalTags = ['final', 'answer', 'response', 'assistant_response', 'output', 'content'];

        for (const tag of finalTags) {
            const pattern = new RegExp(`^<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>$`, 'i');
            const match = text.match(pattern);
            if (match) {
                text = String(match[1] || '').trim();
                break;
            }
        }

        const finalBlockMatch = text.match(/<final\b[^>]*>([\s\S]*?)<\/final>/i)
            || text.match(/<answer\b[^>]*>([\s\S]*?)<\/answer>/i);
        if (finalBlockMatch) {
            return String(finalBlockMatch[1] || '').trim();
        }

        return text
            .replace(/<(?:analysis|thinking|reasoning)\b[^>]*>[\s\S]*?<\/(?:analysis|thinking|reasoning)>/gi, '')
            .trim();
    }

    function normalizeHumanReadableMarkdownSegment(source = '') {
        let text = String(source || '').replace(/\r\n?/g, '\n');
        if (!text.trim()) {
            return text;
        }

        const sectionLabels = [
            'Short answer',
            'Summary',
            'Recommendation',
            'Result',
            'Why it works',
            'Why it matters',
            'What changed',
            'Details',
            'Plan',
            'Steps',
            'Ingredients',
            'Preparation',
            'Serving Suggestions',
            'Variations',
            'Next step',
            'Next steps',
            'Caveat',
            'Note',
            'Verification',
        ];
        const labelPattern = new RegExp(`([^\\n])\\s+(?=(${sectionLabels.map(escapeRegExp).join('|')}):\\s)`, 'gi');

        text = text
            .replace(/\u2022/g, '-')
            .replace(/(^|\s)(\d{1,2})\)\s/g, '$1$2. ')
            .replace(labelPattern, '$1\n\n');

        const hasMarkdownStructure = /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|>|```|\|.+\|)/m.test(text);
        const paragraphs = text.split(/\n{2,}/);
        if (hasMarkdownStructure || paragraphs.length > 1 || text.trim().length < 520) {
            return text.trim();
        }

        const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
        const rebuilt = [];
        let paragraph = '';
        sentences.forEach((sentence) => {
            const candidate = paragraph ? `${paragraph} ${sentence}` : sentence;
            if (candidate.length > 420 && paragraph) {
                rebuilt.push(paragraph);
                paragraph = sentence;
            } else {
                paragraph = candidate;
            }
        });
        if (paragraph) {
            rebuilt.push(paragraph);
        }

        return (rebuilt.length > 1 ? rebuilt.join('\n\n') : text).trim();
    }

    function normalizeMultilineTableCells(source = '') {
        const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
        const normalizedLines = [];
        let tableColumnCount = 0;
        let pendingRow = '';

        const countPipeColumns = (line = '') => {
            const trimmed = String(line || '').trim();
            if (!trimmed.startsWith('|') || !trimmed.includes('|')) {
                return 0;
            }

            return trimmed
                .replace(/^\|/, '')
                .replace(/\|$/, '')
                .split('|').length;
        };

        const isSeparatorRow = (line = '') => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
        const flushPendingRow = () => {
            if (pendingRow) {
                normalizedLines.push(pendingRow);
                pendingRow = '';
            }
        };

        lines.forEach((line) => {
            const trimmed = line.trim();
            if (isSeparatorRow(trimmed)) {
                flushPendingRow();
                tableColumnCount = countPipeColumns(trimmed);
                normalizedLines.push(line);
                return;
            }

            const isTableLine = trimmed.startsWith('|') && trimmed.includes('|');
            if (!isTableLine) {
                if (pendingRow && tableColumnCount > 0 && trimmed && !/^#{1,6}\s|^---$|^>/.test(trimmed)) {
                    pendingRow += `<br>${escapeHtml(trimmed)}`;
                    return;
                }

                flushPendingRow();
                if (!trimmed) {
                    tableColumnCount = 0;
                }
                normalizedLines.push(line);
                return;
            }

            if (tableColumnCount > 0 && countPipeColumns(trimmed) < tableColumnCount && pendingRow) {
                pendingRow += `<br>${escapeHtml(trimmed.replace(/^\|?\s*/, '').replace(/\|?\s*$/, ''))}`;
                return;
            }

            flushPendingRow();
            pendingRow = line;
        });

        flushPendingRow();
        return normalizedLines.join('\n');
    }

    function restoreFlattenedMarkdownTables(source = '') {
        let text = String(source || '').replace(/\r\n?/g, '\n');
        if (!text.trim() || !/\|/.test(text)) {
            return text;
        }

        const tableSectionLabels = [
            'Summary',
            'Result',
            'Results',
            'Ingredients',
            'Preparation',
            'Variations',
            'Equipment',
            'Nutrition',
            'Shopping List',
            'Troubleshooting',
            'Timeline',
            'Schedule',
            'Checklist',
            'Options',
            'Comparison',
        ];
        const headingSectionLabels = [
            'Why it works',
            'Serving Suggestions',
            'Tips',
            'Notes',
        ];
        const tableLabelPattern = tableSectionLabels.map(escapeRegExp).join('|');
        const headingLabelPattern = headingSectionLabels.map(escapeRegExp).join('|');

        text = text
            .replace(new RegExp(`(^|\\n)(${tableLabelPattern})[^\\S\\n]+\\|`, 'gi'), '$1### $2\n\n|')
            .replace(new RegExp(`([^\\n])[^\\S\\n]+(${tableLabelPattern})[^\\S\\n]+\\|`, 'gi'), '$1\n\n### $2\n\n|')
            .replace(new RegExp(`(^|\\n)(${headingLabelPattern})(?=\\s|$)`, 'gi'), '$1### $2')
            .replace(new RegExp(`([^\\n])[^\\S\\n]+(${headingLabelPattern})(?=\\s|$)`, 'gi'), '$1\n\n### $2\n')
            .replace(/([^\n])[^\S\n]+---[^\S\n]*/g, '$1\n\n---\n\n')
            .replace(/\|\s+(?=\|)/g, '|\n')
            .replace(/(^|\n)(\|[^\n]*\|)\s+(?=\|?\s*:?-{3,}:?\s*\|)/g, '$1$2\n')
            .replace(/(^|\n)(\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?)\s+(?=\|)/g, '$1$2\n')
            .replace(/(^|\n)(\|[^\n]*\|)\s+(?=>\s)/g, '$1$2\n\n')
            .replace(/(^|\n)(\|[^\n]*\|)\s+(?=---(?:\s|$))/g, '$1$2\n\n')
            .replace(/(^|\n)#{1,6}\s*\n+(?=#{1,6}\s+)/g, '$1')
            .replace(/\n{3,}/g, '\n\n');

        return normalizeMultilineTableCells(text);
    }

    function restoreFlattenedMarkdownBlocks(source = '') {
        let text = String(source || '').replace(/\r\n?/g, '\n');
        if (!text.trim()) {
            return text;
        }

        const wrappedQuoteMatch = text.match(/^"([\s\S]*)"$/);
        if (wrappedQuoteMatch && /(?:#{2,6}\s|\d+\.\s|[*-]\s)/.test(wrappedQuoteMatch[1])) {
            text = wrappedQuoteMatch[1];
        }

        text = restoreFlattenedMarkdownTables(text);

        if (!/[^\n]\s+(?:#{2,6}\s|\d+\.\s|[*-]\s)/.test(text)) {
            return text.trim();
        }

        return text
            .replace(/([.!?:])(?=#{2,6}\s)/g, '$1\n\n')
            .replace(/([.!?:])(?=\d+\.\s)/g, '$1\n')
            .replace(/([.!?:])(?=[*-]\s)/g, '$1\n')
            .replace(/([^\n])\s+(?=#{2,6}\s)/g, '$1\n\n')
            .replace(/([^\n])\s+(?=\d+\.\s)/g, '$1\n')
            .replace(/([^\n])\s+(?=[*-]\s)/g, '$1\n')
            .replace(/([^\n])\s+(?=(?:Style|Overview|Summary|Recommendation|Next Step|Next Steps):)/g, '$1\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function restoreFlattenedCodeFences(source = '') {
        return String(source || '')
            .replace(/```([a-z0-9_-]+)[^\S\n]+([\s\S]*?)```/gi, (match, language, body) => {
                const content = String(body || '').trim();
                if (!content || String(body || '').startsWith('\n')) {
                    return match;
                }

                return `\`\`\`${String(language || '').trim()}\n${content}\n\`\`\``;
            })
            .replace(/([^\n])(```[a-z0-9_-]*\n)/gi, '$1\n\n$2');
    }

    function findRawHtmlDocumentStartIndex(source = '') {
        const value = String(source || '');
        const starts = [
            /<!doctype\s+html\b/i,
            /<html\b/i,
            /<head\b/i,
            /<body\b/i,
        ]
            .map((pattern) => {
                const match = pattern.exec(value);
                return Number.isInteger(match?.index) ? match.index : -1;
            })
            .filter((index) => index >= 0);

        return starts.length > 0 ? Math.min(...starts) : -1;
    }

    function looksLikeRawHtmlDocument(source = '') {
        const value = String(source || '').trim();
        if (!value || /^```/i.test(value) || value.length < 80) {
            return false;
        }

        const hasDocumentStart = /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(value);
        if (!hasDocumentStart) {
            return false;
        }

        return /<!doctype\s+html\b/i.test(value)
            || /<html\b/i.test(value)
            || (/<head\b/i.test(value) && /<body\b/i.test(value))
            || /<\/(?:html|body)>/i.test(value);
    }

    function splitRawHtmlDocumentSource(source = '') {
        const value = String(source || '').replace(/\r\n?/g, '\n').trim();
        const startIndex = findRawHtmlDocumentStartIndex(value);
        if (startIndex < 0) {
            return null;
        }

        const prefix = value.slice(0, startIndex).trim();
        const htmlTail = value.slice(startIndex).trim();
        if (!looksLikeRawHtmlDocument(htmlTail)) {
            return null;
        }

        const closeMatch = htmlTail.match(/<\/html\s*>/i);
        const htmlEndIndex = closeMatch && Number.isInteger(closeMatch.index)
            ? closeMatch.index + closeMatch[0].length
            : htmlTail.length;

        return {
            prefix,
            html: htmlTail.slice(0, htmlEndIndex).trim(),
            suffix: htmlTail.slice(htmlEndIndex).trim(),
        };
    }

    function extractRawHtmlDocumentSource(source = '') {
        return splitRawHtmlDocumentSource(source)?.html || '';
    }

    function normalizeFencedHtmlDocumentWrappers(source = '') {
        const value = String(source || '').replace(/\r\n?/g, '\n').trim();
        if (!value || !/```/i.test(value)) {
            return value;
        }

        const fencePattern = /```([a-z0-9_-]*)[^\S\n]*(?:\n)?([\s\S]*?)```/ig;
        let match;
        while ((match = fencePattern.exec(value)) !== null) {
            const language = String(match[1] || '').trim().toLowerCase();
            const fencedBody = String(match[2] || '').trim();
            const htmlSource = extractRawHtmlDocumentSource(fencedBody);
            if (!htmlSource || (language && language !== 'html' && language !== 'htm')) {
                continue;
            }

            const prefix = value.slice(0, match.index).trim();
            const suffix = value.slice(match.index + match[0].length).trim();
            const safePrefix = stripInternalHtmlDocumentPreface(prefix);

            return [
                safePrefix,
                `\`\`\`html\n${htmlSource}\n\`\`\``,
                suffix,
            ].filter(Boolean).join('\n\n');
        }

        const openFenceMatch = /```([a-z0-9_-]*)[^\S\n]*(?:\n)?/i.exec(value);
        if (openFenceMatch) {
            const language = String(openFenceMatch[1] || '').trim().toLowerCase();
            const body = value.slice(openFenceMatch.index + openFenceMatch[0].length);
            const split = splitRawHtmlDocumentSource(body);
            if (split?.html && (!language || language === 'html' || language === 'htm')) {
                const prefix = value.slice(0, openFenceMatch.index).trim();
                const safePrefix = stripInternalHtmlDocumentPreface(prefix);
                return [
                    safePrefix,
                    `\`\`\`html\n${split.html}\n\`\`\``,
                    split.suffix,
                ].filter(Boolean).join('\n\n');
            }
        }

        return value;
    }

    function fenceRawHtmlDocuments(source = '') {
        const value = String(source || '').replace(/\r\n?/g, '\n').trim();
        if (!value || /```/.test(value)) {
            return value;
        }

        const startIndex = findRawHtmlDocumentStartIndex(value);
        if (startIndex < 0) {
            return value;
        }

        const prefix = value.slice(0, startIndex).trim();
        const htmlTail = value.slice(startIndex).trim();
        if (!looksLikeRawHtmlDocument(htmlTail)) {
            return value;
        }

        const closeMatch = htmlTail.match(/<\/html\s*>/i);
        const htmlEndIndex = closeMatch && Number.isInteger(closeMatch.index)
            ? closeMatch.index + closeMatch[0].length
            : htmlTail.length;
        const htmlSource = htmlTail.slice(0, htmlEndIndex).trim();
        const suffix = htmlTail.slice(htmlEndIndex).trim();
        const safePrefix = stripInternalHtmlDocumentPreface(prefix);

        return [
            safePrefix,
            `\`\`\`html\n${htmlSource}\n\`\`\``,
            suffix,
        ].filter(Boolean).join('\n\n');
    }

    function stripInternalHtmlDocumentPreface(prefix = '') {
        const text = String(prefix || '').trim();
        if (!text) {
            return '';
        }

        if (/(?:^|\n)\s*(?:analysis|reasoning|thinking|chain of thought|internal planning|diagnostics?|raw details|trace id|diagnostic code|provider_or_backend_error|model request failed|image request received|\+\d+ms)\b/i.test(text)
            || /\bPAGE REASONING (?:MAP|RULES)\b/i.test(text)
            || /\bworking in background\b/i.test(text)
            || (/^(?:i(?:'|’|â€™)?ll|i will|let me)\b/i.test(text)
                && /\b(?:rebuild|build|return|deliver|compose|create|html|page|artifact|viewer|clean)\b/i.test(text))) {
            return '';
        }

        return text;
    }

    function normalizeStructuredMarkdown(source = '') {
        return restoreFlattenedCodeFences(normalizeFencedHtmlDocumentWrappers(fenceRawHtmlDocuments(source)))
            .split(/(```[\s\S]*?```)/g)
            .map((segment) => {
                if (/^```[\s\S]*```$/.test(segment)) {
                    return segment;
                }

                return restoreFlattenedMarkdownBlocks(
                    normalizeHumanReadableMarkdownSegment(segment),
                );
            })
            .join('');
    }

    function normalizePresentationMarkupSegment(source = '') {
        return String(source || '')
            .replace(/(^|[^\\])==([^=\n][^=\n]*?)==/g, '$1<mark class="kb-highlight">$2</mark>')
            .replace(/::(accent|success|warning|danger|info|muted)\[([^\]\n]+)\]/gi, (_match, tone, text) => {
                const normalizedTone = String(tone || '').toLowerCase();
                return `<span class="kb-tone kb-tone--${normalizedTone}">${text}</span>`;
            });
    }

    function normalizePresentationMarkupMarkdown(source = '') {
        return String(source || '')
            .split(/(```[\s\S]*?```)/g)
            .map((segment) => {
                if (/^```[\s\S]*```$/.test(segment)) {
                    return segment;
                }

                return normalizePresentationMarkupSegment(segment);
            })
            .join('');
    }

    function collectMetadata(value) {
        if (!value || typeof value !== 'object') {
            return {};
        }

        const metadata = value.metadata && typeof value.metadata === 'object' ? { ...value.metadata } : {};
        ['model', 'provider', 'finish_reason', 'finishReason', 'usage', 'annotations', 'suggestions'].forEach((key) => {
            if (value[key] !== undefined && metadata[key] === undefined) {
                metadata[key] = value[key];
            }
        });
        return metadata;
    }

    function parseJsonLikeValue(value) {
        if (!value) {
            return null;
        }

        if (typeof value === 'object') {
            return value;
        }

        return tryParseJson(String(value || '').trim());
    }

    function normalizeToolId(value = '') {
        return String(value || '').trim().toLowerCase().replace(/_/g, '-');
    }

    function isRemoteToolId(value = '') {
        return ['remote-command', 'ssh-execute', 'remote-cli-agent', 'k3s-deploy'].includes(normalizeToolId(value));
    }

    function findRemotePayloadObject(value, seen = null) {
        if (!value || typeof value !== 'object') {
            return null;
        }

        const visited = seen || new WeakSet();
        if (visited.has(value)) {
            return null;
        }
        visited.add(value);

        if (Array.isArray(value)) {
            for (const item of value) {
                const match = findRemotePayloadObject(item, visited);
                if (match) {
                    return match;
                }
            }
            return null;
        }

        const directToolId = normalizeToolId(
            value.tool
            || value.toolId
            || value.name
            || value.function?.name
            || value.toolCall?.function?.name
            || '',
        );
        const parsedArguments = parseJsonLikeValue(value.arguments || value.function?.arguments || value.toolCall?.function?.arguments);
        const params = parseJsonLikeValue(value.params || value.parameters) || {};
        const argumentParams = parsedArguments && typeof parsedArguments === 'object' ? parsedArguments : {};
        const merged = {
            ...argumentParams,
            ...params,
            ...value,
        };
        const command = typeof merged.command === 'string' ? merged.command.trim() : '';
        const hasRemoteTarget = Boolean(
            merged.host
            || merged.hostname
            || merged.username
            || merged.port
            || merged.profile
            || merged.workflowAction
            || merged.workflow_action
        );

        if (command && (isRemoteToolId(directToolId) || hasRemoteTarget)) {
            return {
                toolId: isRemoteToolId(directToolId) ? directToolId : 'remote-command',
                command,
                host: String(merged.host || merged.hostname || '').trim(),
                username: String(merged.username || '').trim(),
                port: merged.port || null,
                payload: value,
            };
        }

        if (isRemoteToolId(directToolId) && (Object.keys(argumentParams).length > 0 || Object.keys(params).length > 0)) {
            return {
                toolId: directToolId,
                command,
                host: String(merged.host || merged.hostname || '').trim(),
                username: String(merged.username || '').trim(),
                port: merged.port || null,
                payload: value,
            };
        }

        const nestedKeys = ['tool_calls', 'toolCalls', 'calls', 'items', 'output'];
        for (const key of nestedKeys) {
            const match = findRemotePayloadObject(value[key], visited);
            if (match) {
                return match;
            }
        }

        return null;
    }

    function detectToolPayload(value = '') {
        const parsed = parseJsonLikeValue(value);
        if (!parsed) {
            return null;
        }

        return findRemotePayloadObject(parsed);
    }

    function normalizeModelOutput(value, options = {}) {
        const metadata = collectMetadata(value);
        let sourceFormat = typeof value;
        let text = typeof value === 'string' ? value : extractTextFromObject(value);

        if (!text && value != null && typeof value !== 'object') {
            text = String(value);
        }

        text = stripXmlLikeModelWrappers(text);

        const fenced = unwrapWholeFence(text);
        text = fenced.text;
        if (fenced.language) {
            metadata.wrapperLanguage = fenced.language;
            sourceFormat = `fenced:${fenced.language}`;
        }

        const parsedJson = tryParseJson(text);
        if (parsedJson) {
            sourceFormat = 'json';
            Object.assign(metadata, collectMetadata(parsedJson));
            const parsedText = extractTextFromObject(parsedJson);
            if (parsedText.trim()) {
                text = parsedText;
            }
        }

        text = stripXmlLikeModelWrappers(text);
        const normalizedMarkdown = options.markdown === false
            ? String(text || '').trim()
            : normalizePresentationMarkupMarkdown(normalizeStructuredMarkdown(text));

        return {
            text: normalizedMarkdown,
            metadata,
            sourceFormat,
        };
    }

    const api = {
        normalizeModelOutput,
        normalizeModelOutputMarkdown(value, options = {}) {
            return normalizeModelOutput(value, options).text;
        },
        normalizeStructuredMarkdown,
        normalizePresentationMarkupMarkdown,
        normalizePresentationMarkupSegment,
        normalizeHumanReadableMarkdownSegment,
        restoreFlattenedMarkdownBlocks,
        restoreFlattenedMarkdownTables,
        fenceRawHtmlDocuments,
        normalizeMultilineTableCells,
        detectToolPayload,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    ROOT.LillyModelOutputParser = api;
    ROOT.KimiBuiltModelOutputParser = api;
})(typeof window !== 'undefined' ? window : globalThis);

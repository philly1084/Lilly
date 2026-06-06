const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { config } = require('../config');
const { artifactStore } = require('./artifact-store');
const { extractArtifact } = require('./artifact-extractor');
const { renderArtifact } = require('./artifact-renderer');
const { FORMAT_MIME_TYPES, SUPPORTED_GENERATION_FORMATS, SUPPORTED_UPLOAD_FORMATS, inferFormat, normalizeFormat } = require('./constants');
const { chunkText, escapeHtml, stripHtml, stripNullCharacters, normalizeWhitespace } = require('../utils/text');
const { vectorStore } = require('../memory/vector-store');
const { buildSessionInstructions } = require('../session-instructions');
const { assetManager } = require('../asset-manager');
const { postgres } = require('../postgres');
const { searchImages, isConfigured: isUnsplashConfigured } = require('../unsplash-client');
const {
    isDashboardRequest,
    selectDashboardTemplates,
    buildDashboardTemplatePromptContext,
} = require('../dashboard-template-catalog');
const {
    buildDocumentCreativityPacket,
    inferDocumentTypeFromPrompt,
    renderCreativityPromptContext,
} = require('../documents/document-creativity');
const {
    buildFrontendBundleArtifact,
    buildFrontendFallbackMetadata,
    extractRequestedSitePageCount,
    isComplexFrontendBundleRequest,
    normalizeFrontendMetadata,
    sanitizeFrontendArtifactMetadata,
    sanitizeFrontendHtmlContent,
} = require('../frontend-bundles');
const { buildSandboxBrowserLibraryInstructions } = require('../sandbox-browser-libraries');
const {
    extractResponseUsageMetadata,
    mergeUsageMetadata,
} = require('../utils/token-usage');
const { parseLenientJson } = require('../utils/lenient-json');
const { resolveDocumentTheme } = require('../documents/document-design-engine');
const {
    buildArtifactExperienceMetadata,
    isInteractiveDocumentRequest,
    renderInteractiveArtifactInstructions,
    shouldUseInteractiveHtmlArtifact,
} = require('./artifact-experience');
const { sanitizeRuntimePayload, rehydrateText, resolvePiiPolicy } = require('../pii');
const {
    deleteLocalGeneratedArtifact,
    deleteLocalGeneratedArtifactsBySession,
    getLocalGeneratedArtifact,
    isLocalGeneratedArtifactId,
    listLocalGeneratedArtifactsBySession,
    persistGeneratedArtifactLocally,
} = require('../generated-file-artifacts');
const MULTI_PASS_DOCUMENT_FORMATS = new Set(['html', 'pdf']);
const DEFAULT_DOCUMENT_IMAGE_TARGET = 20;
const COMPOSITION_PLANNING_PATTERNS = [
    /\bpage layout plan\b/i,
    /\bcredits? and source register\b/i,
    /\bfinal build checks\b/i,
    /\bapproved outline\b/i,
    /\bstructured document draft\b/i,
];
const COMPOSITION_META_PHRASES = [
    /\bthe layout should\b/i,
    /\bif attribution must appear\b/i,
    /\ba separate source register should\b/i,
    /\bbefore delivery\b/i,
    /\bthe final pass should\b/i,
    /\bverification date used for the build\b/i,
];

function shouldSuppressUploadedArtifactPreview(artifact = {}) {
    if (String(artifact?.direction || '').toLowerCase() !== 'uploaded') {
        return false;
    }

    try {
        return resolvePiiPolicy({
            metadata: artifact.metadata || {},
            clientSurface: 'web-chat',
            route: '/api/artifacts/preview',
        }).enabled === true;
    } catch (_error) {
        return false;
    }
}

function summarizePrivateUploadMetadata(metadata = {}) {
    const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata
        : {};
    const sheets = Array.isArray(source.sheets)
        ? source.sheets.map((sheet) => ({
            name: String(sheet?.name || '').slice(0, 120),
            rowCount: Number(sheet?.rowCount || 0),
        }))
        : [];
    const structuredTables = Array.isArray(source.structuredTables)
        ? source.structuredTables.map((table) => ({
            name: String(table?.name || '').slice(0, 120),
            rowCount: Number(table?.rowCount || (Array.isArray(table?.rows) ? table.rows.length : 0)),
            columnCount: Array.isArray(table?.headers) ? table.headers.length : 0,
        }))
        : [];

    return {
        ...(sheets.length > 0 ? { sheets } : {}),
        ...(structuredTables.length > 0 ? { structuredTableSummary: structuredTables } : {}),
    };
}

function isPdfArtifactRecord(artifact = {}) {
    const extension = String(artifact.extension || artifact.format || '').toLowerCase();
    const mimeType = String(artifact.mimeType || '').toLowerCase();
    const filename = String(artifact.filename || '').toLowerCase();
    return extension === 'pdf' || mimeType.includes('pdf') || filename.endsWith('.pdf');
}
const COMPOSITION_OUTLINE_PATTERNS = [
    /\b\d+\s+sections\b/i,
    /\bstory block\b/i,
    /\bsource:\s*(artifact|tool|unsplash|prompt|session)(?:\s+via\s+[\w-]+)?\b/i,
    /\b(best for|day type|morning, afternoon, and evening)\b/i,
];
const DOCUMENT_CONTENT_NOISE_PATTERNS = [
    /^\[research workflow\]$/i,
    /^\[verified image references\]$/i,
    /^current-information request should start with perplexity-backed web search\.?$/i,
    /^explicit research request should start with perplexity-backed web search\.?$/i,
    /^before drafting or composing, use available tools to ground current claims with web-search and web-fetch\.?$/i,
    /^prefer verified real image sources from unsplash or direct image urls over ai-generated illustrations unless the user explicitly asks for generated art\.?$/i,
    /^use these real image urls when the output benefits from visuals\.?$/i,
    /^these verified references can be reused throughout the document.*$/i,
    /^prefer standard html <img src=".*"> elements.*$/i,
    /^source:\s*(tool|unsplash|artifact|prompt|session)(?:\s+via\s+[\w-]+)?$/i,
    /^.*\s+source:\s*(tool|unsplash|artifact|prompt|session)(?:\s+via\s+[\w-]+)?$/i,
    /^\d+\s+sections$/i,
    /^story block$/i,
    /^<\/?(?:creative_direction|sample_handling|continuity)>$/i,
    /^(?:blueprint|direction|rationale|voice cues|layout cues|human feel cues|preferred theme|recent related tasks|recent related artifacts|recent creative directions|recent dialog context):/i,
];
const UNSPLASH_QUERY_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'article', 'articles', 'as', 'at', 'be', 'brief', 'build', 'built',
    'can', 'case', 'casefile', 'create', 'current', 'day', 'design', 'do', 'doc', 'docx', 'document',
    'edition', 'enough', 'feature', 'file', 'files', 'final', 'for', 'generate', 'guide', 'have', 'html',
    'how', 'image', 'images', 'in', 'is', 'it', 'latest', 'make', 'mockup', 'news', 'now', 'of', 'on', 'one', 'our', 'page',
    'pages', 'pdf', 'photo', 'photos', 'piece', 'polished', 'prototype', 'real', 'report', 'resources', 'serious', 'ship', 'site',
    'story', 'studio', 'the', 'this', 'to', 'today', 'update', 'usable', 'we', 'website', 'with', 'work',
    'unsplash', 'visual', 'visuals',
]);

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tryParseResponseJsonString(value = '') {
    const trimmed = String(value || '').trim();
    if (!trimmed || ((!trimmed.startsWith('{') || !trimmed.endsWith('}'))
        && (!trimmed.startsWith('[') || !trimmed.endsWith(']')))) {
        return null;
    }

    try {
        return JSON.parse(trimmed);
    } catch (_error) {
        return null;
    }
}

function extractFunctionPayloadText(content, depth = 0) {
    if (!content || typeof content !== 'object' || Array.isArray(content) || depth > 8) {
        return '';
    }

    const type = String(content.type || '').trim().toLowerCase();
    const functionName = String(content.name || content.function?.name || '').trim();
    if (type !== 'function' && !functionName) {
        return '';
    }

    const parameterSources = [
        content.parameters,
        content.arguments,
        content.function?.arguments,
        content.function?.parameters,
    ];

    for (const source of parameterSources) {
        const parsed = typeof source === 'string'
            ? tryParseResponseJsonString(source)
            : source;
        if (!parsed || typeof parsed !== 'object') {
            continue;
        }

        const functionText = [
            parsed.notes_page_update,
            parsed.assistant_reply,
            parsed.assistantReply,
            parsed.message,
            parsed.content,
            parsed.text,
            parsed.result,
            parsed.response,
            parsed.output_text,
            parsed.outputText,
            parsed.answer,
        ].find((entry) => typeof entry === 'string' && entry.trim());

        if (functionText) {
            return functionText.trim();
        }

        const nested = extractResponseContentText(parsed, depth + 1);
        if (nested) {
            return nested;
        }
    }

    return '';
}

function isInternalReasoningContentPart(content = null) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
        return false;
    }

    const type = String(content.type || content.kind || '').trim().toLowerCase();
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

function extractResponseContentText(content, depth = 0) {
    if (depth > 8) {
        return '';
    }

    if (typeof content === 'string') {
        const trimmed = stripNullCharacters(content).trim();
        if (!trimmed) {
            return '';
        }

        const parsed = tryParseResponseJsonString(trimmed);
        if (parsed) {
            const extracted = extractResponseContentText(parsed, depth + 1);
            if (extracted) {
                return extracted;
            }
        }

        return trimmed;
    }

    if (Array.isArray(content)) {
        return content
            .filter((item) => !isInternalReasoningContentPart(item))
            .map((item) => extractResponseContentText(item, depth + 1))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    if (!content || typeof content !== 'object') {
        return '';
    }

    if (isInternalReasoningContentPart(content)) {
        return '';
    }

    const functionPayloadText = extractFunctionPayloadText(content, depth + 1);
    if (functionPayloadText) {
        return functionPayloadText;
    }

    if (typeof content.text === 'string') {
        return extractResponseContentText(content.text, depth + 1);
    }

    if (typeof content.output_text === 'string') {
        return extractResponseContentText(content.output_text, depth + 1);
    }

    if (typeof content.content === 'string') {
        return extractResponseContentText(content.content, depth + 1);
    }

    if (typeof content.message === 'string') {
        return extractResponseContentText(content.message, depth + 1);
    }

    if (typeof content.reasoning_content === 'string') {
        return extractResponseContentText(content.reasoning_content, depth + 1);
    }

    if (typeof content.reasoning === 'string') {
        return extractResponseContentText(content.reasoning, depth + 1);
    }

    if (typeof content.refusal === 'string') {
        return extractResponseContentText(content.refusal, depth + 1);
    }

    if (typeof content.value === 'string') {
        return extractResponseContentText(content.value, depth + 1);
    }

    const nestedKeys = [
        'content',
        'parts',
        'items',
        'output',
        'payload',
        'data',
        'result',
        'value',
        'message',
        'reasoning_content',
        'reasoning',
        'refusal',
    ];
    for (const key of nestedKeys) {
        if (content[key] == null) {
            continue;
        }

        const nested = extractResponseContentText(content[key], depth + 1);
        if (nested) {
            return nested;
        }
    }

    return '';
}

function extractResponseText(response) {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
        return stripNullCharacters(response.output_text).trim();
    }

    const choiceMessage = response?.choices?.[0]?.message || null;
    if (choiceMessage) {
        const choiceText = extractResponseContentText(
            choiceMessage.content
            ?? choiceMessage.parts
            ?? choiceMessage.items
            ?? choiceMessage.text
            ?? choiceMessage.output_text
            ?? choiceMessage.reasoning_content
            ?? choiceMessage.reasoning
            ?? ''
        ).trim();
        if (choiceText) {
            return stripNullCharacters(choiceText).trim();
        }
    }

    const choiceText = stripNullCharacters(extractResponseContentText(response?.choices?.[0]?.text || '')).trim();
    if (choiceText) {
        return choiceText;
    }

    const candidate = response?.candidates?.[0] || null;
    if (candidate) {
        const candidateText = extractResponseContentText(
            candidate.content
            ?? candidate.parts
            ?? candidate.text
            ?? ''
        ).trim();
        if (candidateText) {
            return stripNullCharacters(candidateText).trim();
        }
    }

    const output = Array.isArray(response?.output) ? response.output : [];

    return output
        .filter((item) => item?.type === 'message' || item?.role === 'assistant')
        .map((item) => extractResponseContentText(item?.content ?? item?.text ?? item?.output_text ?? ''))
        .filter(Boolean)
        .join('\n')
        .replace(/\u0000/g, '')
        .trim();
}

function extractRawResponseContentText(content, depth = 0) {
    if (depth > 8) {
        return '';
    }

    if (typeof content === 'string') {
        return stripNullCharacters(content).trim();
    }

    if (Array.isArray(content)) {
        return content
            .filter((item) => !isInternalReasoningContentPart(item))
            .map((item) => extractRawResponseContentText(item, depth + 1))
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    if (!content || typeof content !== 'object') {
        return '';
    }

    if (isInternalReasoningContentPart(content)) {
        return '';
    }

    const directText = [
        content.text,
        content.output_text,
        content.content,
        content.message,
        content.reasoning_content,
        content.reasoning,
        content.refusal,
    ].find((entry) => typeof entry === 'string' && entry.trim());
    if (directText) {
        return stripNullCharacters(directText).trim();
    }

    const nestedSources = [
        content.content,
        content.parts,
        content.items,
        content.output,
        content.response,
        content.result,
    ];
    for (const source of nestedSources) {
        const nested = extractRawResponseContentText(source, depth + 1);
        if (nested) {
            return nested;
        }
    }

    return '';
}

function extractRawResponseText(response) {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
        return stripNullCharacters(response.output_text).trim();
    }

    const choiceMessage = response?.choices?.[0]?.message || null;
    if (choiceMessage) {
        const choiceText = extractRawResponseContentText(
            choiceMessage.content
            ?? choiceMessage.parts
            ?? choiceMessage.items
            ?? choiceMessage.text
            ?? choiceMessage.output_text
            ?? ''
        ).trim();
        if (choiceText) {
            return stripNullCharacters(choiceText).trim();
        }
    }

    const candidate = response?.candidates?.[0] || null;
    if (candidate) {
        const candidateText = extractRawResponseContentText(
            candidate.content
            ?? candidate.parts
            ?? candidate.text
            ?? ''
        ).trim();
        if (candidateText) {
            return stripNullCharacters(candidateText).trim();
        }
    }

    const output = Array.isArray(response?.output) ? response.output : [];
    return output
        .filter((item) => item?.type === 'message' || item?.role === 'assistant')
        .map((item) => extractRawResponseContentText(item?.content ?? item?.text ?? item?.output_text ?? ''))
        .filter(Boolean)
        .join('\n')
        .replace(/\u0000/g, '')
        .trim();
}

function resolveCompletedResponseText(streamedText = '', response = {}) {
    const streamed = stripNullCharacters(streamedText);
    const completed = extractResponseText(response);

    if (!completed) {
        return streamed.trim();
    }

    if (!streamed) {
        return completed;
    }

    if (completed === streamed) {
        return streamed;
    }

    if (completed.startsWith(streamed)) {
        return completed;
    }

    if (streamed.includes(completed)) {
        return streamed;
    }

    return completed;
}

function getMissingCompletionDelta(streamedText = '', completedText = '') {
    const streamed = String(streamedText || '');
    const completed = String(completedText || '');

    if (!completed) {
        return '';
    }

    if (!streamed) {
        return completed;
    }

    if (completed.startsWith(streamed)) {
        return completed.slice(streamed.length);
    }

    return '';
}

async function requestModelResponse(params = {}) {
    const { createResponse } = require('../openai-client');
    if (typeof createResponse !== 'function') {
        throw new Error('openai-client.createResponse is unavailable');
    }
    const toolContext = params.toolContext && typeof params.toolContext === 'object' ? params.toolContext : {};
    const metadata = params.metadata && typeof params.metadata === 'object' ? params.metadata : {};
    const piiSanitized = await sanitizeRuntimePayload(params, {
        sessionId: toolContext.sessionId || params.sessionId || params.session?.id || '',
        ownerId: toolContext.ownerId || params.ownerId || null,
        clientSurface: toolContext.clientSurface || metadata.clientSurface || 'artifact-generation',
        route: toolContext.route || metadata.route || '/api/artifacts/generate',
        metadata,
    });
    const response = await createResponse(piiSanitized.payload);
    if (response && typeof response === 'object') {
        response._kimibuiltPiiCleansing = {
            enabled: piiSanitized.policy?.enabled === true,
            changed: piiSanitized.changed === true,
            contextIds: Array.from(new Set(piiSanitized.contextIds || [])),
            replacementCount: Array.isArray(piiSanitized.replacements) ? piiSanitized.replacements.length : 0,
            placeholderMode: piiSanitized.policy?.placeholderMode || '',
            modelFrame: piiSanitized.modelFrame || null,
            sanitizedInput: typeof piiSanitized.payload?.input === 'string'
                ? piiSanitized.payload.input
                : '',
        };
    }
    return response;
}

function hasPiiPlaceholders(value = '') {
    return /\[\[PII:[^\]\r\n]+?\]\]/.test(String(value || ''));
}

function normalizePiiCleansingMetadata(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const contextIds = Array.isArray(value.contextIds)
        ? value.contextIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    return {
        enabled: value.enabled === true,
        changed: value.changed === true,
        contextIds,
        replacementCount: Number(value.replacementCount || 0) || 0,
        restoredCount: Number(value.restoredCount || 0) || 0,
        placeholderMode: String(value.placeholderMode || '').trim(),
        modelFrame: value.modelFrame || null,
        sanitizedInput: String(value.sanitizedInput || '').trim(),
    };
}

function mergePiiCleansingMetadata(...values) {
    const entries = values
        .map(normalizePiiCleansingMetadata)
        .filter(Boolean);
    if (entries.length === 0) {
        return null;
    }

    const contextIds = new Set();
    let enabled = false;
    let changed = false;
    let replacementCount = 0;
    let restoredCount = 0;
    let placeholderMode = '';
    let sanitizedInput = '';
    const modelFrames = [];

    entries.forEach((entry) => {
        enabled = enabled || entry.enabled;
        changed = changed || entry.changed;
        replacementCount += entry.replacementCount;
        restoredCount += entry.restoredCount;
        if (!placeholderMode && entry.placeholderMode) {
            placeholderMode = entry.placeholderMode;
        }
        if (!sanitizedInput && entry.sanitizedInput) {
            sanitizedInput = entry.sanitizedInput;
        }
        entry.contextIds.forEach((id) => contextIds.add(id));
        if (entry.modelFrame) {
            modelFrames.push(entry.modelFrame);
        }
    });

    if (!enabled && contextIds.size === 0 && replacementCount === 0 && restoredCount === 0) {
        return null;
    }

    return {
        enabled,
        changed,
        contextIds: Array.from(contextIds),
        replacementCount,
        restoredCount,
        placeholderMode,
        sanitizedInput,
        ...(modelFrames.length === 1 ? { modelFrame: modelFrames[0] } : {}),
        ...(modelFrames.length > 1 ? { modelFrames } : {}),
    };
}

function resolveStoredSourcePrompt(prompt = '', piiCleansing = null) {
    const original = String(prompt || '');
    const sanitized = String(piiCleansing?.sanitizedInput || '').trim();
    if (piiCleansing?.changed === true) {
        return sanitized || '[PII-cleaned prompt omitted]';
    }
    return original;
}

function resolveArtifactOwnerId({ ownerId = null, session = null, metadata = {} } = {}) {
    return String(
        ownerId
        || metadata?.ownerId
        || metadata?.owner_id
        || session?.metadata?.ownerId
        || session?.metadata?.owner_id
        || ''
    ).trim() || null;
}

async function restoreGeneratedPiiPlaceholders(text = '', {
    sessionId = '',
    session = null,
    ownerId = null,
    metadata = {},
    piiCleansing = null,
    clientSurface = 'artifact-generation',
    route = '/api/artifacts/generate',
} = {}) {
    const source = String(text || '');
    if (!source || !hasPiiPlaceholders(source)) {
        return { text: source, restorations: [] };
    }

    const normalizedPii = mergePiiCleansingMetadata(piiCleansing, metadata?.piiCleansing);
    try {
        const result = await rehydrateText(source, {
            sessionId,
            ownerId: resolveArtifactOwnerId({ ownerId, session, metadata }),
            contextIds: normalizedPii?.contextIds || [],
            metadata: {
                ...(metadata || {}),
                ...(normalizedPii ? { piiCleansing: normalizedPii } : {}),
            },
            clientSurface,
            route,
            highlight: false,
        });
        return {
            text: result.text,
            restorations: Array.isArray(result.restorations) ? result.restorations : [],
        };
    } catch (error) {
        console.warn(`[PII] Failed to restore generated artifact placeholders: ${error.message}`);
        return { text: source, restorations: [] };
    }
}

async function restoreFrontendPayloadPii(payload = null, options = {}) {
    if (!payload || typeof payload !== 'object') {
        return { payload, restorations: [] };
    }

    const restorations = [];
    const next = {
        ...payload,
        metadata: payload.metadata && typeof payload.metadata === 'object'
            ? { ...payload.metadata }
            : {},
    };

    if (typeof next.content === 'string') {
        const result = await restoreGeneratedPiiPlaceholders(next.content, options);
        next.content = result.text;
        restorations.push(...result.restorations);
    }

    const bundle = next.metadata?.bundle && typeof next.metadata.bundle === 'object'
        ? { ...next.metadata.bundle }
        : null;
    if (bundle && Array.isArray(bundle.files)) {
        bundle.files = [];
        for (const file of next.metadata.bundle.files) {
            const nextFile = file && typeof file === 'object' ? { ...file } : file;
            if (nextFile && typeof nextFile.content === 'string') {
                const result = await restoreGeneratedPiiPlaceholders(nextFile.content, options);
                nextFile.content = result.text;
                restorations.push(...result.restorations);
            }
            bundle.files.push(nextFile);
        }
        next.metadata.bundle = bundle;
    }

    return { payload: next, restorations };
}

function buildPiiArtifactMetadata(piiCleansing = null, restorations = []) {
    const merged = mergePiiCleansingMetadata(piiCleansing, {
        enabled: piiCleansing?.enabled === true,
        restoredCount: Array.isArray(restorations) ? restorations.length : 0,
    });
    if (!merged) {
        return null;
    }
    return {
        ...merged,
        restoredInGeneratedArtifact: (Array.isArray(restorations) ? restorations.length : 0) > 0,
    };
}

function isTextArtifactPayload({ extension = '', mimeType = '', filename = '' } = {}) {
    const normalizedExtension = String(extension || '').replace(/^\./, '').toLowerCase();
    const normalizedMime = String(mimeType || '').toLowerCase();
    const normalizedFilename = String(filename || '').toLowerCase();
    return normalizedMime.startsWith('text/')
        || normalizedMime.includes('json')
        || normalizedMime.includes('xml')
        || normalizedMime.includes('javascript')
        || normalizedMime.includes('svg')
        || ['html', 'htm', 'css', 'csv', 'js', 'jsx', 'json', 'md', 'markdown', 'mjs', 'svg', 'txt', 'ts', 'tsx', 'xml', 'yaml', 'yml'].includes(normalizedExtension)
        || /\.(?:html?|css|csv|js|jsx|json|md|markdown|mjs|svg|txt|ts|tsx|xml|ya?ml)$/i.test(normalizedFilename);
}

function unwrapCodeFence(text = '') {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^```(?:[a-z0-9_-]+)?\n([\s\S]*?)\n```$/i);
    return match ? match[1].trim() : trimmed;
}

function tryParseJson(text, fallbackTitle = 'Workbook') {
    try {
        const parsed = parseLenientJson(unwrapCodeFence(text));
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Invalid workbook JSON');
        }
        return {
            title: parsed.title || fallbackTitle,
            sheets: Array.isArray(parsed.sheets) ? parsed.sheets : [],
        };
    } catch {
        return {
            title: fallbackTitle,
            sheets: [
                {
                    name: 'Sheet1',
                    rows: unwrapCodeFence(text)
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => line.split('|').map((cell) => cell.trim())),
                },
            ],
        };
    }
}

function safeJsonParse(text = '') {
    return parseLenientJson(unwrapCodeFence(text));
}

function inferDocumentTitle(prompt = '', fallback = 'Document') {
    const normalized = String(prompt || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) {
        return fallback;
    }

    const title = normalized
        .replace(/^(create|make|generate|write|draft|build)\s+/i, '')
        .replace(/[.?!]+$/g, '')
        .slice(0, 80)
        .trim();

    return title || fallback;
}

function looksLikeKeywordStuffing(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return false;
    }

    const commaCount = (normalized.match(/,/g) || []).length;
    if (commaCount >= 6) {
        return true;
    }

    return normalized.length > 140 && !/[.!?]/.test(normalized);
}

function sanitizeDocumentText(text = '') {
    const normalized = normalizeWhitespace(stripNullCharacters(text || ''));
    if (!normalized) {
        return '';
    }

    const lines = normalized.split('\n');
    const cleaned = [];
    let previousComparable = '';

    lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') {
                cleaned.push('');
            }
            previousComparable = '';
            return;
        }

        if (DOCUMENT_CONTENT_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
            return;
        }

        if (looksLikeKeywordStuffing(trimmed)) {
            return;
        }

        const comparable = trimmed.toLowerCase();
        if (comparable === previousComparable) {
            return;
        }

        cleaned.push(trimmed);
        previousComparable = comparable;
    });

    return cleaned
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function sanitizeImageReferenceTitle(title = '', fallback = 'Document image') {
    let normalized = normalizeWhitespace(stripNullCharacters(title || ''))
        .replace(/\s+Source:\s*(tool|unsplash|artifact|prompt|session)(?:\s+via\s+[\w-]+)?$/i, '')
        .replace(/^[`"']+|[`"']+$/g, '')
        .trim();

    if (!normalized) {
        return fallback;
    }

    if (/^(can you|could you|would you|please|make|create|generate|build|draft|write|do)\b/i.test(normalized)) {
        return fallback;
    }

    if (looksLikeKeywordStuffing(normalized)) {
        const commaSegments = normalized
            .split(',')
            .map((segment) => segment.trim())
            .filter(Boolean);
        const firstUsefulSegment = commaSegments.find((segment) => segment.split(/\s+/).length >= 2 && segment.length <= 80);
        normalized = firstUsefulSegment || fallback;
    }

    if (normalized.length > 90) {
        normalized = `${normalized.slice(0, 87).trim()}...`;
    }

    return normalized || fallback;
}

function tokenizeUnsplashQuery(value = '') {
    return String(value || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !UNSPLASH_QUERY_STOPWORDS.has(token));
}

function normalizePlanSections(sections = []) {
    return (Array.isArray(sections) ? sections : [])
        .slice(0, 12)
        .map((section, index) => ({
            heading: sanitizeDocumentText(String(section?.heading || section?.title || `Section ${index + 1}`)).trim(),
            purpose: sanitizeDocumentText(String(section?.purpose || section?.goal || '')).trim(),
            keyPoints: (Array.isArray(section?.keyPoints) ? section.keyPoints : [])
                .map((point) => sanitizeDocumentText(String(point || '')).trim())
                .filter(Boolean)
                .slice(0, 6),
            targetLength: String(section?.targetLength || 'medium').trim() || 'medium',
            layout: String(section?.layout || section?.sectionLayout || '').trim() || 'narrative',
            tone: sanitizeDocumentText(String(section?.tone || '')).trim(),
            visualIntent: sanitizeDocumentText(String(section?.visualIntent || section?.visual || '')).trim(),
        }))
        .filter((section) => section.heading);
}

function normalizeDocumentSections(sections = [], fallbackSections = []) {
    const fallbackByIndex = Array.isArray(fallbackSections) ? fallbackSections : [];

    return (Array.isArray(sections) ? sections : [])
        .slice(0, 18)
        .map((section, index) => ({
            heading: sanitizeDocumentText(String(section?.heading || section?.title || fallbackByIndex[index]?.heading || `Section ${index + 1}`)).trim(),
            content: sanitizeDocumentText(String(section?.content || section?.body || '')).trim(),
            level: Number(section?.level) > 0 ? Number(section.level) : 1,
            kicker: sanitizeDocumentText(String(section?.kicker || '')).trim(),
            visualIntent: sanitizeDocumentText(String(section?.visualIntent || fallbackByIndex[index]?.visualIntent || '')).trim(),
        }))
        .filter((section) => section.heading && section.content);
}

function normalizeCreativePlan(parsedPlan = {}, fallbackPacket = null) {
    const packet = fallbackPacket && typeof fallbackPacket === 'object'
        ? fallbackPacket
        : {};
    const direction = packet.direction || {};
    const directionLabel = typeof parsedPlan?.creativeDirection === 'string'
        ? parsedPlan.creativeDirection
        : parsedPlan?.creativeDirection?.label;

    return {
        id: String(parsedPlan?.creativeDirection?.id || direction.id || '').trim() || null,
        label: String(
            directionLabel
            || direction.label
            || ''
        ).trim() || 'Editorial Feature',
        rationale: String(parsedPlan?.creativeDirection?.rationale || direction.rationale || '').trim(),
        themeSuggestion: String(
            parsedPlan?.theme
            || parsedPlan?.themeSuggestion
            || packet.themeSuggestion
            || direction.preferredTheme
            || 'editorial'
        ).trim(),
        humanizationNotes: (Array.isArray(parsedPlan?.humanizationNotes) ? parsedPlan.humanizationNotes : packet.humanizationNotes || [])
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
            .slice(0, 4),
        sampleHandling: (Array.isArray(parsedPlan?.sampleHandling) ? parsedPlan.sampleHandling : packet.sampleSignals?.guidance || [])
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
            .slice(0, 4),
    };
}

function normalizeImageReferenceUrl(url = '') {
    const trimmed = String(url || '').trim();
    if (!trimmed) {
        return null;
    }

    if (trimmed.startsWith('/')) {
        return trimmed;
    }

    try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return null;
        }
        return parsed.toString();
    } catch (_error) {
        return null;
    }
}

function isLikelyImageUrl(url = '') {
    const normalized = String(url || '').toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(normalized)
        || normalized.includes('images.unsplash.com')
        || normalized.includes('source.unsplash.com')
        || normalized.includes('/photo-');
}

function isExternalImageReferenceUrl(url = '') {
    const normalized = String(url || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (normalized.startsWith('/')) {
        return false;
    }

    return /^https?:\/\//.test(normalized) && !/\/api\/artifacts\/.+\/download\b/.test(normalized);
}

function isInternalArtifactImageReferenceUrl(url = '') {
    const normalized = String(url || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /^\/api\/artifacts\/.+\/download\b/.test(normalized)
        || /^https?:\/\/[^/]+\/api\/artifacts\/.+\/download\b/.test(normalized);
}

function isRenderableImageReferenceUrl(url = '', { allowInternal = false } = {}) {
    if (allowInternal && isInternalArtifactImageReferenceUrl(url)) {
        return true;
    }

    return isExternalImageReferenceUrl(url);
}

function buildArtifactInlinePath(artifactId = '') {
    return `/api/artifacts/${artifactId}/download?inline=1`;
}

function refersToPriorImages(text = '') {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return /\b(last|generated|previous|prior|same|those|these|this|earlier|above)\b[\s\S]{0,40}\b(images?|photos?|pictures?|illustrations?|renders?)\b/i.test(normalized)
        || /\b(images?|photos?|pictures?|illustrations?|renders?)\b[\s\S]{0,60}\b(from earlier|from before|from above|you made|you generated|we generated|from the last turn)\b/i.test(normalized)
        || /\b(use|put|place|include|embed|make|turn|convert|compile)\b[\s\S]{0,40}\b(those|these|the generated|the previous|the earlier)\b[\s\S]{0,20}\b(images?|photos?|pictures?)\b/i.test(normalized);
}

function extractImageReferencesFromSession(session = null) {
    const entries = Array.isArray(session?.metadata?.projectMemory?.urls)
        ? session.metadata.projectMemory.urls
        : [];
    const unique = new Map();

    entries.forEach((entry) => {
        const url = normalizeImageReferenceUrl(entry?.url || '');
        if (!url || !isExternalImageReferenceUrl(url) || (!isLikelyImageUrl(url) && String(entry?.kind || '').toLowerCase() !== 'image')) {
            return;
        }

        unique.set(url, {
            url,
            title: sanitizeImageReferenceTitle(String(entry?.title || '').trim(), ''),
            source: String(entry?.source || '').trim() || 'session',
            toolId: String(entry?.toolId || '').trim(),
        });
    });

    return Array.from(unique.values()).slice(-DEFAULT_DOCUMENT_IMAGE_TARGET);
}

function extractImageReferencesFromText(text = '') {
    const unique = new Map();
    const matches = String(text || '').match(/https?:\/\/\S+/ig) || [];

    matches.forEach((candidate) => {
        const normalizedUrl = normalizeImageReferenceUrl(String(candidate || '').replace(/[),.;!?]+$/g, ''));
        if (!normalizedUrl || !isExternalImageReferenceUrl(normalizedUrl) || !isLikelyImageUrl(normalizedUrl)) {
            return;
        }

        unique.set(normalizedUrl, {
            url: normalizedUrl,
            title: sanitizeImageReferenceTitle('Prompt image reference'),
            source: 'prompt',
            toolId: 'image-from-url',
        });
    });

    return Array.from(unique.values()).slice(0, DEFAULT_DOCUMENT_IMAGE_TARGET);
}

function extractImageReferencesFromArtifacts(artifacts = []) {
    const unique = new Map();

    (Array.isArray(artifacts) ? artifacts : []).forEach((artifact) => {
        const artifactId = String(artifact?.id || '').trim();
        const mimeType = String(artifact?.mimeType || '').trim().toLowerCase();
        const extension = String(artifact?.extension || artifact?.format || '').trim().toLowerCase();
        if (!artifactId || (!mimeType.startsWith('image/') && !['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension))) {
            return;
        }

        const url = buildArtifactInlinePath(artifactId);
        unique.set(url, {
            url,
            title: sanitizeImageReferenceTitle(String(
                artifact?.metadata?.altText
                || artifact?.metadata?.title
                || artifact?.metadata?.revisedPrompt
                || artifact?.filename
                || 'Generated image'
            ).trim()),
            source: 'artifact',
            toolId: String(artifact?.metadata?.generatedBy || 'image-generate').trim(),
            internal: true,
            artifactId,
        });
    });

    return Array.from(unique.values()).slice(0, DEFAULT_DOCUMENT_IMAGE_TARGET);
}

function buildDocumentImageInstructions() {
    return [
        'When verified image URLs are available in session memory or prompt context, use those real images with standard HTML <img> tags.',
        'Prefer remembered direct image URLs and Unsplash image URLs over generated decorative placeholders.',
        `When the user asks for real or image-rich output, reuse as many as ${DEFAULT_DOCUMENT_IMAGE_TARGET} verified image references across the document before falling back to text-only sections.`,
        'For news, research, latest, current-events, and source-backed reports, prefer real sourced photography and fetched online image references over AI-generated illustrations unless the user explicitly asks for generated art.',
        'If the user explicitly asks for a selected/generated image to be the page, hero, static, wallpaper, or full-screen background, honor that request with a CSS background-image treatment and readable overlay surfaces.',
        'Prefer standard HTML <img src="..."> elements over background-image-only treatments when the image is meaningful content.',
        'For HTML and PDF designs, distribute real images throughout the document instead of clustering them in a single appendix or final page.',
        'Use a strong visual rhythm: opening hero image, repeated section visuals, image cards, and galleries when enough verified image URLs exist.',
        'If there are enough verified images, include visuals in most major sections rather than only one or two isolated slots.',
        'Do not reuse the same image URL across multiple major sections when multiple verified image references are available. Use distinct images first and only repeat an image after the pool is exhausted.',
        'Never create inline SVG artwork, multilayered SVG mockups, CSS-only fake photos, canvas placeholders, blob URLs, or data:image embeds unless the user explicitly asks for vector artwork.',
        'If no verified image URL is available for a visual slot, omit the image block and keep the section text-only.',
        'Use descriptive alt text and keep images tied to the content instead of decorative filler.',
        'Do not surface raw search metadata, comma-separated keyword dumps, or source labels as visible document prose.',
    ].join('\n');
}

function isConservativeDocumentRevisionRequest(prompt = '', existingContent = '', format = '') {
    const normalizedFormat = normalizeFormat(format);
    if (!MULTI_PASS_DOCUMENT_FORMATS.has(normalizedFormat)) {
        return false;
    }

    const request = String(prompt || '').trim().toLowerCase();
    if (!request) {
        return false;
    }

    const revisionIntent = /\b(updat(?:e|ing)|revis(?:e|ing)|refin(?:e|ing)|improv(?:e|ing)|polish(?:ing)?|refresh(?:ing)?|redo|rework(?:ing)?|edit(?:ing)?)\b/.test(request);
    if (!revisionIntent) {
        return false;
    }

    const combined = `${request}\n${String(existingContent || '').slice(0, 8000).toLowerCase()}`;
    const resumeLike = /\b(resume|résumé|cv|curriculum vitae|ats|cover letter|professional staffing|linkedin profile)\b/.test(combined);
    const explicitImageRichRequest = /\b(image-rich|image rich|photo|photos|photography|pictures?|unsplash|hero image|stock image|magazine|editorial feature|visual field guide|portfolio showcase)\b/.test(request);
    return resumeLike && !explicitImageRichRequest;
}

function buildConservativeDocumentRevisionInstructions(prompt = '', existingContent = '', format = '') {
    if (!isConservativeDocumentRevisionRequest(prompt, existingContent, format)) {
        return '';
    }

    return [
        '[Conservative document revision]',
        'This is a resume/CV/professional document revision. Preserve the original document genre and user intent.',
        'Improve typography, hierarchy, spacing, section order, and ATS-friendly readability without turning it into an editorial article, field guide, brochure, or image-heavy report.',
        'Do not add stock photography, Unsplash images, galleries, hero photos, source labels, or decorative visual sections unless the user explicitly asks for images.',
        'Use compact resume-appropriate sections and keep the filename/title grounded in the person and role, not in workflow or continuation wording.',
    ].join('\n');
}

function buildVisualSafetyInstructions() {
    return [
        '[Artifact visual safety]',
        'Define explicit readable text/background pairs for every major surface; do not rely on inherited colors across dark and light sections.',
        'Never place white or near-white text on white, transparent, or pale backgrounds, and never place dark text on dark backgrounds.',
        'Target WCAG AA contrast: at least 4.5:1 for normal text and 3:1 for large or bold display text.',
        'When text sits on imagery, place it on a solid or strongly translucent overlay/panel and set both text color and background color.',
        'Use named CSS variables for text, muted text, surfaces, panels, accents, borders, and warning states so palette changes remain coherent.',
        'Check desktop and mobile composition for clipped text, overlapping cards, unreadable buttons, and horizontal overflow.',
        'For PDF-oriented HTML, keep print styles high-contrast and avoid white text unless the printed background is explicitly dark.',
        'For PDF-oriented HTML, declare the intended page size and margins with @page and design content to that physical page to avoid widescreen cropping or accidental portrait slicing.',
        'For PDF-oriented HTML, keep every section, table, figure, pre/code block, and grid inside the printable content box; avoid fixed pixel widths larger than the page after margins, use max-width:100%, table-layout:fixed, and wrapping for long text/code.',
        'For PDF-oriented HTML, separate major sections with a single clean divider, spacing, or heading band instead of putting every section inside a bordered card that can create awkward seams at page breaks.',
    ].join('\n');
}

function buildDashboardHtmlInstructions(requestPrompt = '', existingContent = '') {
    const dashboardContext = buildDashboardTemplatePromptContext({
        prompt: requestPrompt,
        existingContent,
        limit: 3,
    });

    if (!dashboardContext) {
        return '';
    }

    return [
        dashboardContext,
        'Implement the chosen primary dashboard option fully instead of producing a generic landing page with random charts.',
        'Set <body data-dashboard-template="template-id"> using the chosen option id.',
        'Add stable data-dashboard-zone attributes on major regions such as hero, filters, kpi-rail, chart-grid, table-panel, alerts, or activity-feed.',
        'Use realistic dashboard modules, filters, tables, and chart placeholders that fit the chosen domain.',
    ].join('\n');
}

function looksLikeStandaloneHtml(text = '') {
    return /<!doctype html>|<html\b|<body\b|<main\b|<article\b|<section\b|<header\b|<figure\b|<img\b|<h1\b/i.test(String(text || ''));
}

function renderSectionContentHtml(content = '') {
    const normalized = String(content || '').trim();
    if (!normalized) {
        return '';
    }

    if (/<[a-z][\s\S]*>/i.test(normalized)) {
        return normalized;
    }

    return normalized
        .split(/\n{2,}/)
        .map((block) => {
            const trimmed = block.trim();
            if (!trimmed) {
                return '';
            }

            const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
            const bulletLines = lines.filter((line) => /^[-*]\s+/.test(line));
            const numberedLines = lines.filter((line) => /^\d+\.\s+/.test(line));

            if (lines.length > 0 && bulletLines.length === lines.length) {
                return `<ul>${bulletLines.map((line) => `<li>${escapeHtml(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
            }

            if (lines.length > 0 && numberedLines.length === lines.length) {
                return `<ol>${numberedLines.map((line) => `<li>${escapeHtml(line.replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
            }

            return `<p>${escapeHtml(trimmed).replace(/\n/g, '<br>')}</p>`;
        })
        .filter(Boolean)
        .join('\n');
}

function buildImageFigureHtml(imageReference, fallbackAlt = 'Document image') {
    const url = normalizeImageReferenceUrl(imageReference?.url || '');
    const allowInternal = imageReference?.internal === true || isInternalArtifactImageReferenceUrl(url);
    if (!url || !isRenderableImageReferenceUrl(url, { allowInternal })) {
        return '';
    }

    const alt = escapeHtml(sanitizeImageReferenceTitle(String(imageReference?.title || fallbackAlt || 'Document image').trim(), fallbackAlt || 'Document image'));
    const sourceLabel = escapeHtml(String(imageReference?.source || 'source').trim());
    const safeUrl = escapeHtml(url);
    const visibleCaption = sanitizeDocumentText(String(
        imageReference?.caption
        || imageReference?.description
        || ''
    )).trim();
    const showSourceCredit = isExternalImageReferenceUrl(url);
    const captionParts = [];

    if (visibleCaption && visibleCaption.toLowerCase() !== alt.toLowerCase()) {
        captionParts.push(escapeHtml(visibleCaption));
    }
    if (showSourceCredit) {
        captionParts.push(`<span class="document-credit">Source: <a href="${safeUrl}" target="_blank" rel="noreferrer">${sourceLabel}</a></span>`);
    }

    return [
        '<figure class="document-image">',
        `  <img src="${safeUrl}" alt="${alt}" loading="eager">`,
        captionParts.length > 0 ? `  <figcaption>${captionParts.join(' ')}</figcaption>` : '',
        '</figure>',
    ].join('\n');
}

function pickImageReference(imageReferences = [], index = 0) {
    const normalized = Array.isArray(imageReferences)
        ? imageReferences.filter((entry) => {
            const url = normalizeImageReferenceUrl(entry?.url || '');
            return url && isRenderableImageReferenceUrl(url, {
                allowInternal: entry?.internal === true || isInternalArtifactImageReferenceUrl(url),
            });
        })
        : [];

    if (normalized.length === 0) {
        return null;
    }

    return normalized[index % normalized.length];
}

function normalizeImageReferencePool(imageReferences = []) {
    const unique = new Map();

    (Array.isArray(imageReferences) ? imageReferences : []).forEach((entry) => {
        const url = normalizeImageReferenceUrl(entry?.url || '');
        const allowInternal = entry?.internal === true || isInternalArtifactImageReferenceUrl(url);
        if (!url || !isRenderableImageReferenceUrl(url, { allowInternal }) || unique.has(url)) {
            return;
        }

        unique.set(url, {
            ...entry,
            url,
        });
    });

    return Array.from(unique.values());
}

function diversifyHtmlImageReferences(html = '', imageReferences = []) {
    const source = String(html || '');
    if (!source || !/<img\b/i.test(source)) {
        return source;
    }

    const pool = normalizeImageReferencePool(imageReferences);
    if (pool.length < 2) {
        return source;
    }

    const imgTagPattern = /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/ig;
    const matches = Array.from(source.matchAll(imgTagPattern));
    if (matches.length < 2) {
        return source;
    }

    const currentUrls = matches
        .map((match) => normalizeImageReferenceUrl(match[2]) || String(match[2] || '').trim())
        .filter(Boolean);
    const uniqueCurrentCount = new Set(currentUrls).size;
    if (uniqueCurrentCount >= Math.min(matches.length, pool.length)) {
        return source;
    }

    let changed = false;
    let cursor = 0;
    const used = new Set();

    const rewritten = source.replace(imgTagPattern, (fullMatch, prefix, src, suffix) => {
        const normalizedSrc = normalizeImageReferenceUrl(src) || String(src || '').trim();
        let nextUrl = normalizedSrc;

        if (pool.some((entry) => entry.url === normalizedSrc) && !used.has(normalizedSrc)) {
            used.add(normalizedSrc);
        } else {
            let attempts = 0;
            while (attempts < pool.length) {
                const candidate = pool[cursor % pool.length]?.url || '';
                cursor += 1;
                attempts += 1;
                if (candidate && !used.has(candidate)) {
                    nextUrl = candidate;
                    used.add(candidate);
                    break;
                }
            }

            if (!nextUrl) {
                const fallbackCandidate = pool[cursor % pool.length]?.url || normalizedSrc;
                cursor += 1;
                nextUrl = fallbackCandidate || normalizedSrc;
            }
        }

        if (nextUrl && nextUrl !== normalizedSrc) {
            changed = true;
        }

        return `${prefix}${nextUrl || src}${suffix}`;
    });

    return changed ? rewritten : source;
}

function diversifyBundleImageReferences(bundle = {}, imageReferences = []) {
    if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.files) || bundle.files.length === 0) {
        return bundle;
    }

    const files = bundle.files.map((file) => {
        if (!/\.html?$/i.test(String(file?.path || ''))) {
            return file;
        }

        const content = diversifyHtmlImageReferences(String(file?.content || ''), imageReferences);
        if (content === file.content) {
            return file;
        }

        return {
            ...file,
            content,
        };
    });

    return {
        ...bundle,
        files,
    };
}

function extractLeadSummaryText(content = '', maxLength = 240) {
    const plain = sanitizeDocumentText(stripHtml(String(content || '')))
        .replace(/^[-*]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!plain) {
        return '';
    }

    const sentences = plain.split(/(?<=[.!?])\s+/).filter(Boolean);
    const lead = sentences.slice(0, 2).join(' ').trim() || plain;
    if (lead.length <= maxLength) {
        return lead;
    }

    return `${lead.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function buildExpandedDocumentHtml(title = 'Document', sections = [], imageReferences = [], creativePlan = null) {
    const safeTitle = escapeHtml(title);
    const normalizedSections = Array.isArray(sections) ? sections : [];
    const normalizedImages = Array.isArray(imageReferences) ? imageReferences : [];
    const theme = resolveDocumentTheme(creativePlan?.themeSuggestion || 'editorial');
    const heroImage = pickImageReference(normalizedImages, 0);
    const leadSection = normalizedSections[0] || null;
    const heroEyebrow = escapeHtml(String(leadSection?.kicker || '').trim());
    const standfirst = escapeHtml(
        extractLeadSummaryText(
            leadSection?.content
            || normalizedSections.slice(0, 2).map((section) => section?.content || '').join('\n\n'),
        ),
    );

    const heroMarkup = [
        '<section class="document-hero-shell">',
        '  <div class="document-hero-copy">',
        heroEyebrow ? `    <p class="document-eyebrow">${heroEyebrow}</p>` : '',
        `    <h1>${safeTitle}</h1>`,
        standfirst ? `    <p class="document-standfirst">${standfirst}</p>` : '',
        '  </div>',
        heroImage
            ? `  <div class="document-hero-media">${buildImageFigureHtml(heroImage, `${title} hero image`).replace(/\n/g, '\n    ')}</div>`
            : '  <div class="document-hero-panel"><p>Built from the approved plan with a deliberate narrative rhythm and visual structure.</p></div>',
        '</section>',
    ].filter(Boolean).join('\n');

    const sectionMarkup = normalizedSections.map((section, index) => {
        const safeHeading = escapeHtml(String(section?.heading || `Section ${index + 1}`).trim());
        const bodyMarkup = renderSectionContentHtml(section?.content || '');
        const primaryImage = pickImageReference(normalizedImages, index + 1);
        const supportingImage = normalizedImages.length >= 4 && index % 2 === 0
            ? pickImageReference(normalizedImages, index + 2)
            : null;
        const figureMarkup = buildImageFigureHtml(primaryImage, section?.heading || title);
        const supportingFigureMarkup = supportingImage && supportingImage?.url !== primaryImage?.url
            ? buildImageFigureHtml(supportingImage, `${section?.heading || title} supporting image`)
            : '';
        const imageRailMarkup = figureMarkup || supportingFigureMarkup
            ? [
                '<div class="document-image-rail">',
                figureMarkup ? `  ${figureMarkup.replace(/\n/g, '\n  ')}` : '',
                supportingFigureMarkup ? `  ${supportingFigureMarkup.replace(/\n/g, '\n  ')}` : '',
                '</div>',
            ].filter(Boolean).join('\n')
            : '';
        const kicker = section?.kicker
            ? `<p class="document-section-kicker">${escapeHtml(section.kicker)}</p>`
            : '';
        const sectionTag = section?.kicker
            ? `<span class="document-section-tag">${escapeHtml(section.kicker)}</span>`
            : '';

        return [
            `<section class="document-section" data-section-index="${index + 1}">`,
            '  <div class="document-section-chrome">',
            `    <span class="document-section-number">${String(index + 1).padStart(2, '0')}</span>`,
            sectionTag ? `    ${sectionTag}` : '',
            '  </div>',
            '  <div class="document-section-body">',
            kicker ? `    ${kicker}` : '',
            `    <h2>${safeHeading}</h2>`,
            imageRailMarkup ? `    ${imageRailMarkup.replace(/\n/g, '\n    ')}` : '',
            `    <div class="document-copy">${bodyMarkup}</div>`,
            '  </div>',
            '</section>',
        ].filter(Boolean).join('\n');
    }).join('\n');

    const remainingImages = normalizedImages.slice(Math.min(normalizedImages.length, normalizedSections.length + 1));
    const galleryMarkup = remainingImages.length > 0
        ? [
            '<section class="document-section document-gallery">',
            '  <div class="document-section-chrome">',
            '    <span class="document-section-number">++</span>',
            '    <span class="document-section-tag">visual appendix</span>',
            '  </div>',
            '  <div class="document-section-body">',
            '    <h2>Image Gallery</h2>',
            '    <div class="document-gallery-grid">',
            ...remainingImages.map((imageReference, index) => `      ${buildImageFigureHtml(imageReference, `${title} image ${index + 1}`).replace(/\n/g, '\n      ')}`),
            '    </div>',
            '  </div>',
            '</section>',
        ].join('\n')
        : '';

    return [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '  <meta charset="utf-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1">',
        `  <title>${safeTitle}</title>`,
        '  <style>',
        '    :root {',
        `      --doc-bg: ${theme.background};`,
        `      --doc-surface: ${theme.page};`,
        `      --doc-panel: ${theme.panel};`,
        `      --doc-panel-alt: ${theme.panelAlt};`,
        `      --doc-text: ${theme.text};`,
        `      --doc-muted: ${theme.muted};`,
        `      --doc-accent: ${theme.accent};`,
        `      --doc-border: ${theme.border};`,
        '      --doc-shadow: 0 28px 70px rgba(15, 23, 42, 0.12);',
        '    }',
        '    * { box-sizing: border-box; }',
        '    body { margin: 0; font-family: "Aptos", "Segoe UI", sans-serif; color: var(--doc-text); background: radial-gradient(circle at top, rgba(255,255,255,0.72), var(--doc-bg) 46%); }',
        '    main { max-width: 1120px; margin: 0 auto; padding: 36px 20px 72px; }',
        '    .document-hero-shell { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(260px, 0.9fr); gap: 20px; background: var(--doc-surface); border: 1px solid var(--doc-border); border-radius: 28px; padding: 28px; box-shadow: var(--doc-shadow); margin-bottom: 24px; }',
        '    .document-eyebrow, .document-section-kicker, .document-section-tag { color: var(--doc-accent); text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.78rem; font-weight: 700; }',
        '    .document-hero-copy h1 { margin: 0; font-size: clamp(2.6rem, 6vw, 4.8rem); line-height: 0.94; max-width: 12ch; }',
        '    .document-standfirst { color: var(--doc-muted); font-size: 1.05rem; line-height: 1.7; max-width: 58ch; margin: 16px 0 0; }',
        '    .document-pill-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }',
        '    .document-pill { display: inline-flex; align-items: center; padding: 8px 12px; border-radius: 999px; background: var(--doc-panel); border: 1px solid var(--doc-border); font-size: 0.88rem; }',
        '    .document-human-notes { display: grid; gap: 8px; margin-top: 18px; }',
        '    .document-human-notes p, .document-hero-panel p { margin: 0; padding: 12px 14px; background: var(--doc-panel-alt); border: 1px solid var(--doc-border); border-radius: 16px; color: var(--doc-muted); }',
        '    .document-hero-media, .document-hero-panel { display: grid; align-content: stretch; }',
        '    .document-hero-media .document-image, .document-hero-panel { height: 100%; margin: 0; }',
        '    .document-hero-media .document-image img { min-height: 100%; height: 100%; object-fit: cover; }',
        '    .document-section { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 18px; background: var(--doc-surface); border: 1px solid var(--doc-border); border-radius: 24px; padding: 22px; box-shadow: var(--doc-shadow); margin: 0 0 20px; }',
        '    .document-section:nth-of-type(even) { background: linear-gradient(180deg, var(--doc-surface), var(--doc-panel)); }',
        '    .document-section-number { font-size: 1.95rem; font-weight: 800; color: var(--doc-accent); line-height: 1; }',
        '    .document-section-chrome { display: grid; align-content: start; gap: 8px; }',
        '    .document-section-body h2 { margin: 0; font-size: clamp(1.5rem, 3vw, 2.4rem); line-height: 1.02; }',
        '    .document-section-aside { margin: 14px 0 0; padding: 12px 14px; border-left: 4px solid var(--doc-accent); background: var(--doc-panel); border-radius: 0 16px 16px 0; color: var(--doc-muted); }',
        '    .document-copy { margin-top: 18px; }',
        '    .document-copy p, .document-copy ul, .document-copy ol { margin: 0 0 16px; }',
        '    .document-copy ul, .document-copy ol { padding-left: 1.2rem; }',
        '    .document-image-rail { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 22px 0 24px; }',
        '    .document-image { margin: 0; }',
        '    .document-image img { width: 100%; height: auto; min-height: 220px; object-fit: cover; border-radius: 18px; display: block; box-shadow: 0 18px 40px rgba(15, 23, 42, 0.16); }',
        '    .document-image figcaption { font-size: 12px; color: var(--doc-muted); margin-top: 8px; }',
        '    .document-credit { display: inline-block; margin-left: 8px; }',
        '    .document-gallery-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; margin-top: 18px; }',
        '    a { color: var(--doc-accent); }',
        '    @media (max-width: 840px) {',
        '      .document-hero-shell, .document-section { grid-template-columns: 1fr; }',
        '      .document-section-chrome { grid-auto-flow: column; justify-content: space-between; align-items: center; }',
        '    }',
        '  </style>',
        '</head>',
        '<body>',
        '  <main>',
        `    ${heroMarkup.replace(/\n/g, '\n    ')}`,
        sectionMarkup || '    <section class="document-section"><div class="document-section-body"><p>No content provided.</p></div></section>',
        galleryMarkup ? `    ${galleryMarkup.replace(/\n/g, '\n    ')}` : '',
        '  </main>',
        '</body>',
        '</html>',
    ].filter(Boolean).join('\n');
}

function shouldRecoverCompositionOutput(outputText = '', expandedDocument = null) {
    const raw = String(outputText || '').trim();
    if (!raw) {
        return true;
    }

    const plain = stripHtml(raw).replace(/\s+/g, ' ').trim();
    if (!plain) {
        return true;
    }

    const htmlLike = looksLikeStandaloneHtml(raw);
    let score = 0;
    if (!htmlLike) {
        score += 2;
    }

    score += COMPOSITION_PLANNING_PATTERNS.filter((pattern) => pattern.test(plain)).length * 2;
    score += Math.min(2, COMPOSITION_META_PHRASES.filter((pattern) => pattern.test(plain)).length);
    if (!htmlLike) {
        score += Math.min(4, COMPOSITION_OUTLINE_PATTERNS.filter((pattern) => pattern.test(plain)).length * 2);
    }

    const expectedHeadings = Array.isArray(expandedDocument?.sections)
        ? expandedDocument.sections
            .map((section) => String(section?.heading || '').trim().toLowerCase())
            .filter(Boolean)
        : [];

    if (expectedHeadings.length > 0) {
        const matchedHeadings = expectedHeadings.filter((heading) => plain.toLowerCase().includes(heading)).length;
        if (matchedHeadings === 0) {
            score += 1;
        }
    }

    return score >= 3;
}

function shouldFetchUnsplashReferences(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (/\b(no images|without images|text only|text-only|no photos|without photos)\b/.test(normalized)) {
        return false;
    }

    return /\bunsplash\b/.test(normalized)
        || /\b(image|images|photo|photos|hero|gallery|visual|visuals|cover image|real images)\b/.test(normalized);
}

function inferUnsplashQuery(prompt = '') {
    const tokens = tokenizeUnsplashQuery(prompt);
    if (tokens.length === 0) {
        return null;
    }

    return tokens.slice(0, 6).join(' ');
}

function isFrontendDemoArtifactRequest(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (isInteractiveDocumentRequest(normalized)) {
        return true;
    }

    return /\b(website|web page|webpage|landing page|homepage|microsite|marketing site|product page|campaign page|frontend demo|front-end demo|site prototype|site mockup|browser game|web game|video game|sandboxed game|playable game|game prototype|interactive sandbox|vite preview|vite sandbox|multi step frontend|multi-step frontend)\b/.test(normalized)
        || /\b(3d|three\.?js|webgl|web gpu|webgpu|immersive scene|interactive scene|scene sandbox|sandboxed scene|shader|particles?|orbit controls?)\b/.test(normalized)
        || isDashboardRequest(normalized)
        || (
            /\b(slides|slide deck|deck|presentation|storyboard|report|brief|document|doc)\b/.test(normalized)
            && /\b(website|web page|webpage|site|frontend|ui|vite|react|nextjs|template|prototype|mockup|example|design system|web design|website design)\b/.test(normalized)
        );
}

function isResearchBackedArtifactRequest(prompt = '', format = '') {
    const normalizedPrompt = String(prompt || '').trim().toLowerCase();
    const normalizedFormat = normalizeFormat(format);
    if (!normalizedPrompt || !MULTI_PASS_DOCUMENT_FORMATS.has(normalizedFormat)) {
        return false;
    }

    return /\b(research|source|sources|citations?|latest|recent|current|news|headline|headlines|article|articles|coverage|fact-check|verify|look up|search the web|browse|web search|online|current events?)\b/.test(normalizedPrompt);
}

function isDiagramHeavyArtifactRequest(prompt = '', format = '') {
    const normalizedPrompt = String(prompt || '').trim().toLowerCase();
    const normalizedFormat = normalizeFormat(format);
    if (!normalizedPrompt || !MULTI_PASS_DOCUMENT_FORMATS.has(normalizedFormat)) {
        return false;
    }

    return /\b(complex graph|graph image|graph images|diagram image|diagram images|flowchart|network graph|dependency graph|architecture diagram|system diagram|sequence diagram|state diagram|timeline diagram|mindmap|mind map|svg diagram|mermaid diagram|chart image|visualize the flow|visualise the flow)\b/.test(normalizedPrompt);
}

function shouldEnableArtifactToolOrchestration(prompt = '', format = '') {
    const normalizedPrompt = String(prompt || '').trim().toLowerCase();
    const normalizedFormat = normalizeFormat(format);
    if (!normalizedPrompt || !MULTI_PASS_DOCUMENT_FORMATS.has(normalizedFormat)) {
        return false;
    }

    if (isResearchBackedArtifactRequest(normalizedPrompt, normalizedFormat)) {
        return true;
    }

    if (isDiagramHeavyArtifactRequest(normalizedPrompt, normalizedFormat)) {
        return true;
    }

    if (!isFrontendDemoArtifactRequest(normalizedPrompt)) {
        return false;
    }

    return /\b(research|source|sources|citations?|latest|recent|news|headlines?|sub-?agents?|delegate|parallel)\b/.test(normalizedPrompt);
}

function buildFrontendArtifactPayload(responseText = '') {
    const parsed = safeJsonParse(responseText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const sanitizedContent = sanitizeFrontendHtmlContent(responseText);
        const fallbackContent = sanitizedContent || responseText;
        const fallbackMetadata = buildFrontendFallbackMetadata(fallbackContent);
        return {
            content: fallbackContent,
            metadata: fallbackMetadata,
        };
    }

    const rawParsedContent = typeof parsed.content === 'string'
        ? parsed.content
        : String(parsed.content || '');
    const parsedContent = sanitizeFrontendHtmlContent(rawParsedContent) || rawParsedContent;
    const rawMetadata = parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? { ...parsed.metadata }
        : {};
    if (parsed.bundle && rawMetadata.bundle == null) {
        rawMetadata.bundle = parsed.bundle;
    }
    if (parsed.siteBundle && rawMetadata.bundle == null && rawMetadata.siteBundle == null) {
        rawMetadata.bundle = parsed.siteBundle;
    }
    if (parsed.handoff && rawMetadata.handoff == null) {
        rawMetadata.handoff = parsed.handoff;
    }
    if (parsed.frameworkTarget && rawMetadata.frameworkTarget == null) {
        rawMetadata.frameworkTarget = parsed.frameworkTarget;
    }
    if (parsed.routing && rawMetadata.bundle && typeof rawMetadata.bundle === 'object' && !Array.isArray(rawMetadata.bundle)
        && rawMetadata.bundle.routing == null) {
        rawMetadata.bundle = {
            ...rawMetadata.bundle,
            routing: parsed.routing,
        };
    }
    if (parsed.title && rawMetadata.title == null) {
        rawMetadata.title = parsed.title;
    }

    const metadata = normalizeFrontendMetadata(rawMetadata, parsedContent);
    const entryFile = Array.isArray(metadata.bundle?.files)
        ? metadata.bundle.files.find((file) => file?.path === metadata.bundle.entry)
            || metadata.bundle.files.find((file) => /\.html?$/i.test(String(file?.path || '')))
        : null;
    const renderContent = typeof entryFile?.content === 'string' && entryFile.content.trim()
        ? entryFile.content
        : parsedContent;

    return {
        content: sanitizeFrontendHtmlContent(renderContent) || renderContent,
        metadata,
    };
}

function buildFrontendBundleGenerationInstructions({
    promptContext = '',
    existingContent = '',
    requestPrompt = '',
    requestedPageCount = null,
    dashboardInstructions = '',
} = {}) {
    const interactiveInstructions = renderInteractiveArtifactInstructions(requestPrompt, existingContent);
    const pageCountNote = requestedPageCount
        ? `Create ${requestedPageCount} distinct HTML pages unless the request explicitly needs fewer.`
        : 'Create 5 distinct HTML pages when the request implies a full site but does not specify a count.';

    return [
        'You are generating a full website preview bundle that will be zipped and sandbox-previewed directly from the server.',
        'Return valid JSON only. Do not use markdown fences.',
        'Use exactly this top-level shape: {"content":"...","metadata":{"title":"...","language":"html","frameworkTarget":"static|vite","previewMode":"site","bundle":{"entry":"index.html","files":[{"path":"index.html","language":"html","purpose":"Home page","content":"..."}]},"handoff":{"summary":"...","targetFramework":"...","componentMap":[{"name":"Hero","purpose":"...","targetPath":"src/components/Hero.jsx"}],"integrationSteps":["..."]}}}.',
        'The `content` field must contain the entry HTML file content, and that same entry file must also appear in `metadata.bundle.files`.',
        'Use a Symphony-style internal loop: design the site architecture, build the bundle, critique it for originality/readability/responsiveness, then revise before returning JSON.',
        pageCountNote,
        'Choose the right site shape before writing: marketing landing page, dashboard, app workspace, documentation site, report/brief, editorial feature, campaign microsite, or portfolio showcase.',
        'Match the request instead of defaulting to the same landing-page stack.',
        'For documentation or reference requests, prioritize information architecture, wayfinding, examples, and utilities over marketing polish.',
        'For report or brief requests, prioritize headline findings, evidence panels, charts, and recommendations over conversion patterns.',
        'For app or dashboard requests, build working surfaces with controls, tables, panels, and navigation rather than brochure sections.',
        'Create real multi-page navigation with relative URLs only. Never use leading-slash URLs such as `/about` or `/styles.css` because the preview runs from a nested artifact route.',
        'Every HTML page must feel complete and intentionally designed, not like filler placeholders around a shared shell.',
        'Include shared assets such as CSS, JSON fixtures, JavaScript modules, and image files in `metadata.bundle.files` when they support the site.',
        'When using generated, uploaded, or reference images with available bytes or data URLs, save them as local `assets/...` bundle files and reference them with relative paths so the ZIP can travel with its images. If an image can only remain remote, include enough `assets/images.json` source/alt metadata for a follow-up agent to fetch or replace it.',
        buildSandboxBrowserLibraryInstructions(),
        'For 3D, WebGL, Three.js, particle, shader, or immersive scene requests, return a bundle with at least `index.html`, `styles.css`, and `scene.js`; initialize a visible renderer, camera, lights, geometry/materials, resize handling, animation loop, and a non-white fallback/error overlay if WebGL or module loading fails.',
        'For Three.js scenes, use the local import map for `three` and `three/addons/`, import from `"three"` in `scene.js`, mount the canvas into a fixed-size viewport element, and avoid unresolved bare imports other than the mapped `three` specifiers.',
        'If you choose `frameworkTarget: "vite"`, keep the preview dependency-free and browser-runnable with native ES modules so it still works without install or build steps. You may include `package.json` and `vite.config.js` as handoff files, but do not depend on npm packages for the sandbox preview.',
        'For browser game, playable simulation, or multi-step app requests, build a real state machine or game loop with input handling, update/render phases, score/progress, pause/restart, win/lose or completion state, responsive sizing, and an in-page fallback/error overlay for failed canvas/WebGL/module loading.',
        'Use realistic example data by default, and when a live source is known, wire it behind a small fetch layer or a clearly swappable data adapter.',
        'Favor real interactions such as filters, tab switches, drill-down panels, carousels, sticky nav, or chart toggles over static decoration.',
        'Use stable ids or data-component attributes on major sections to support later repo extraction.',
        'Never expose internal template labels, archetype names, or planning language in visible copy.',
        'Keep the content grounded, concrete, and production-like.',
        'Do not return a generic suite index, placeholder shell, or template wrapper as the entry page. The entry page is the actual requested experience.',
        'The preview runs inside a sandbox that allows scripts but withholds same-origin privileges. Keep interactive behavior client-side, static-safe, and resilient without cookies or server mutation.',
        buildVisualSafetyInstructions(),
        buildDocumentImageInstructions(),
        dashboardInstructions,
        interactiveInstructions,
        promptContext,
        existingContent ? `Existing content to revise:\n${existingContent}` : '',
        `User request:\n${requestPrompt}`,
    ].filter(Boolean).join('\n\n');
}

class ArtifactService {
    isEnabled() {
        return Boolean(postgres.enabled);
    }

    canStoreArtifacts() {
        return true;
    }

    ensureEnabled() {
        if (!this.isEnabled()) {
            const error = new Error('Artifacts require Postgres to be configured');
            error.statusCode = 503;
            throw error;
        }
    }

    async ensureSessionRecord(sessionId, session = null) {
        this.ensureEnabled();

        if (!sessionId) {
            const error = new Error('sessionId is required for artifact storage');
            error.statusCode = 400;
            throw error;
        }

        await postgres.initialize();
        await postgres.query(
            `
                INSERT INTO sessions (id, previous_response_id, metadata)
                VALUES ($1, $2, $3::jsonb)
                ON CONFLICT (id) DO NOTHING
            `,
            [
                sessionId,
                session?.previousResponseId || null,
                JSON.stringify(session?.metadata || {}),
            ],
        );
    }

    serializeArtifact(artifact) {
        if (!artifact) return null;

        const metadata = artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
            ? artifact.metadata
            : {};
        const frontendMetadata = artifact.extension === 'html' && (metadata.type === 'frontend' || metadata.bundle || metadata.siteBundle)
            ? normalizeFrontendMetadata(metadata, artifact.previewHtml || artifact.extractedText || '')
            : null;
        const siteBundle = metadata.siteBundle || frontendMetadata?.bundle || null;
        const siteBundleFileCount = Array.isArray(siteBundle?.files)
            ? siteBundle.files.length
            : Number(siteBundle?.fileCount || 0);
        const hasSiteBundle = siteBundleFileCount > 1;
        const hasPdfPreview = isPdfArtifactRecord(artifact);
        const privacyPreviewSuppressed = shouldSuppressUploadedArtifactPreview(artifact);
        const previewUrl = !privacyPreviewSuppressed && (artifact.extension === 'html' || Boolean(artifact.previewHtml) || hasPdfPreview)
            ? `/api/artifacts/${artifact.id}/preview`
            : null;
        const sandboxUrl = previewUrl
            ? `/api/artifacts/${artifact.id}/sandbox`
            : null;
        const bundleDownloadUrl = hasSiteBundle
            ? `/api/artifacts/${artifact.id}/bundle`
            : null;
        let serializedMetadata = frontendMetadata
            ? sanitizeFrontendArtifactMetadata({
                ...metadata,
                ...frontendMetadata,
            }, artifact.previewHtml || artifact.extractedText || '')
            : metadata;
        if (privacyPreviewSuppressed) {
            serializedMetadata = {
                ...summarizePrivateUploadMetadata(serializedMetadata),
                privacyPreviewSuppressed: true,
                piiCleansing: {
                    ...(serializedMetadata.piiCleansing && typeof serializedMetadata.piiCleansing === 'object'
                        ? serializedMetadata.piiCleansing
                        : {}),
                    uploadPreviewSuppressed: true,
                },
            };
        }

        return {
            id: artifact.id,
            sessionId: artifact.sessionId,
            parentArtifactId: artifact.parentArtifactId,
            direction: artifact.direction,
            sourceMode: artifact.sourceMode,
            filename: artifact.filename,
            format: artifact.extension,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            status: 'ready',
            vectorized: Boolean(artifact.vectorizedAt),
            downloadUrl: `/api/artifacts/${artifact.id}/download`,
            previewUrl,
            sandboxUrl,
            bundleDownloadUrl,
            preview: privacyPreviewSuppressed
                ? null
                : hasSiteBundle
                ? {
                    type: 'site',
                    entry: siteBundle.entry,
                    fileCount: siteBundleFileCount,
                    url: sandboxUrl || previewUrl,
                }
                : artifact.previewHtml
                ? { type: 'html', content: artifact.previewHtml }
                : (artifact.extractedText ? { type: 'text', content: artifact.extractedText.slice(0, 4000) } : null),
            metadata: serializedMetadata,
            createdAt: artifact.createdAt,
        };
    }

    async vectorizeArtifactText(artifact, extractedText, options = {}) {
        const maxChunks = Math.max(
            1,
            Number(options.maxChunks || config.artifacts?.vectorizeMaxChunks) || 24,
        );
        const chunks = chunkText(extractedText).slice(0, maxChunks);
        if (chunks.length === 0) {
            return null;
        }

        for (let index = 0; index < chunks.length; index += 1) {
            await vectorStore.store(artifact.sessionId, chunks[index], {
                artifactId: artifact.id,
                filename: artifact.filename,
                mimeType: artifact.mimeType,
                chunkIndex: index,
                sourceKind: 'file',
            });
        }

        return new Date().toISOString();
    }

    deferArtifactVectorization(artifact, extractedText, { previewHtml = '', metadata = {}, session = null } = {}) {
        if (!artifact?.id || !extractedText) {
            return;
        }

        setImmediate(async () => {
            try {
                const vectorizedAt = await this.vectorizeArtifactText(artifact, extractedText);
                const updatedArtifact = await artifactStore.updateProcessing(artifact.id, {
                    extractedText,
                    previewHtml,
                    metadata,
                    vectorizedAt,
                });
                try {
                    await assetManager.upsertArtifact(updatedArtifact || artifact, { session });
                } catch (error) {
                    console.warn('[Artifacts] Failed to refresh deferred artifact index:', error.message);
                }
            } catch (error) {
                console.warn(`[Artifacts] Deferred artifact vectorization skipped for ${artifact.filename || artifact.id}: ${error.message}`);
            }
        });
    }

    async createStoredArtifact({
        sessionId,
        session = null,
        parentArtifactId = null,
        direction,
        sourceMode,
        filename,
        extension,
        mimeType,
        buffer,
        extractedText = '',
        previewHtml = '',
        metadata = {},
        ownerId = null,
        vectorizeText = null,
        vectorize = true,
        deferVectorization = false,
    }) {
        let storedBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
        let storedExtractedText = String(extractedText || '');
        let storedPreviewHtml = String(previewHtml || '');
        let storedMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? { ...metadata }
            : {};
        const textPayload = isTextArtifactPayload({ extension, mimeType, filename });
        const safeVectorText = typeof vectorizeText === 'string'
            ? vectorizeText
            : (storedExtractedText || (textPayload ? storedBuffer.toString('utf8') : ''));

        if (direction === 'generated') {
            const restoreOptions = {
                sessionId,
                session,
                ownerId,
                metadata: storedMetadata,
                piiCleansing: storedMetadata.piiCleansing || null,
                clientSurface: sourceMode || 'artifact-generation',
                route: storedMetadata.route || '/api/artifacts/generate',
            };
            const restorations = [];
            if (storedPreviewHtml) {
                const result = await restoreGeneratedPiiPlaceholders(storedPreviewHtml, restoreOptions);
                storedPreviewHtml = result.text;
                restorations.push(...result.restorations);
            }
            if (storedExtractedText) {
                const result = await restoreGeneratedPiiPlaceholders(storedExtractedText, restoreOptions);
                storedExtractedText = result.text;
                restorations.push(...result.restorations);
            }
            if (textPayload && hasPiiPlaceholders(storedBuffer.toString('utf8'))) {
                const result = await restoreGeneratedPiiPlaceholders(storedBuffer.toString('utf8'), restoreOptions);
                storedBuffer = Buffer.from(result.text, 'utf8');
                restorations.push(...result.restorations);
            }
            const piiArtifactMetadata = buildPiiArtifactMetadata(storedMetadata.piiCleansing || null, restorations);
            if (piiArtifactMetadata) {
                storedMetadata.piiCleansing = {
                    ...piiArtifactMetadata,
                    restoredInGeneratedArtifact: piiArtifactMetadata.restoredInGeneratedArtifact
                        || Boolean(storedMetadata.piiCleansing?.restoredInGeneratedArtifact),
                };
            }
        }

        if (!this.isEnabled()) {
            return persistGeneratedArtifactLocally({
                sessionId,
                parentArtifactId,
                direction,
                sourceMode,
                filename,
                extension,
                mimeType,
                buffer: storedBuffer,
                extractedText: storedExtractedText,
                previewHtml: storedPreviewHtml,
                metadata: storedMetadata,
            });
        }

        try {
            await this.ensureSessionRecord(sessionId, session);

            const artifact = await artifactStore.create({
                id: randomUUID(),
                sessionId,
                parentArtifactId,
                direction,
                sourceMode,
                filename,
                extension,
                mimeType,
                sizeBytes: storedBuffer.length,
                sha256: sha256(storedBuffer),
                contentBuffer: storedBuffer,
                extractedText: storedExtractedText,
                previewHtml: storedPreviewHtml,
                metadata: storedMetadata,
                vectorizedAt: null,
            });

            let vectorizedAt = null;
            if (vectorize && safeVectorText && !deferVectorization) {
                vectorizedAt = await this.vectorizeArtifactText(artifact, safeVectorText);
            }

            const storedArtifact = await artifactStore.updateProcessing(artifact.id, {
                extractedText: storedExtractedText,
                previewHtml: storedPreviewHtml,
                metadata: storedMetadata,
                vectorizedAt,
            });
            try {
                await assetManager.upsertArtifact(storedArtifact, { session });
            } catch (error) {
                console.warn('[Artifacts] Failed to index stored artifact:', error.message);
            }

            if (vectorize && safeVectorText && deferVectorization) {
                this.deferArtifactVectorization(storedArtifact, safeVectorText, {
                    previewHtml: storedPreviewHtml,
                    metadata: storedMetadata,
                    session,
                });
            }

            return storedArtifact;
        } catch (error) {
            if (error?.statusCode !== 503 && postgres.enabled) {
                throw error;
            }

            console.warn(`[Artifacts] Artifact database unavailable; saving generated artifact locally: ${error.message}`);
            return persistGeneratedArtifactLocally({
                sessionId,
                parentArtifactId,
                direction,
                sourceMode,
                filename,
                extension,
                mimeType,
                buffer,
                extractedText,
                previewHtml,
                metadata,
            });
        }
    }

    async uploadArtifact({ sessionId, session = null, mode = 'chat', label = '', tags = [], file }) {
        if (!file || !file.buffer || !file.filename) {
            const error = new Error('A file upload is required');
            error.statusCode = 400;
            throw error;
        }

        const requestedFormat = normalizeFormat(inferFormat(file.filename, file.mimeType));
        if (!SUPPORTED_UPLOAD_FORMATS.has(requestedFormat) && requestedFormat !== 'power-query') {
            const error = new Error(`Unsupported upload format: ${requestedFormat || file.filename}`);
            error.statusCode = 400;
            throw error;
        }

        let extraction = {
            format: requestedFormat,
            extractedText: '',
            previewHtml: '',
            metadata: {},
            vectorizable: false,
        };

        try {
            extraction = await extractArtifact({
                filename: file.filename,
                mimeType: file.mimeType,
                buffer: file.buffer,
            });
        } catch (error) {
            console.warn('[Artifacts] Extraction failed, storing raw file only:', error.message);
            extraction.metadata = {
                extractionError: error.message,
            };
        }

        const fileSha256 = sha256(file.buffer);
        if (!String(extraction.extractedText || '').trim() && this.isEnabled()) {
            try {
                const reusable = await artifactStore.findReusableExtractionBySha?.(fileSha256);
                if (String(reusable?.extractedText || '').trim()) {
                    extraction = {
                        ...extraction,
                        extractedText: reusable.extractedText,
                        previewHtml: reusable.previewHtml || extraction.previewHtml,
                        metadata: {
                            ...(extraction.metadata || {}),
                            reusedExtractionFromArtifactId: reusable.id,
                            reusedExtractionSha256: fileSha256,
                        },
                        vectorizable: true,
                    };
                }
            } catch (error) {
                console.warn('[Artifacts] Failed to reuse prior extraction for uploaded file:', error.message);
            }
        }

        const format = normalizeFormat(extraction.format || requestedFormat);
        const artifact = await this.createStoredArtifact({
            sessionId,
            session,
            direction: 'uploaded',
            sourceMode: mode,
            filename: file.filename,
            extension: format,
            mimeType: file.mimeType || FORMAT_MIME_TYPES[format] || 'application/octet-stream',
            buffer: file.buffer,
            extractedText: extraction.extractedText,
            previewHtml: extraction.previewHtml,
            metadata: {
                ...extraction.metadata,
                label,
                tags: Array.isArray(tags) ? tags : (tags ? [tags] : []),
                originalFilename: file.filename,
            },
            vectorize: extraction.vectorizable,
            deferVectorization: true,
        });

        return this.serializeArtifact(artifact);
    }

    async listSessionArtifacts(sessionId) {
        const artifacts = [];
        if (this.isEnabled()) {
            try {
                artifacts.push(...await artifactStore.listBySession(sessionId));
            } catch (error) {
                console.warn('[Artifacts] Failed to list Postgres artifacts:', error.message);
            }
        }

        artifacts.push(...await listLocalGeneratedArtifactsBySession(sessionId));
        return artifacts.map((artifact) => this.serializeArtifact(artifact));
    }

    async getArtifact(id, options = {}) {
        if (isLocalGeneratedArtifactId(id)) {
            const localArtifact = await getLocalGeneratedArtifact(id, options);
            if (!localArtifact) return null;
            return options.includeContent ? localArtifact : this.serializeArtifact(localArtifact);
        }

        if (!this.isEnabled()) {
            return null;
        }

        const artifact = await artifactStore.get(id, options);
        if (!artifact) return null;
        return options.includeContent ? artifact : this.serializeArtifact(artifact);
    }

    async deleteArtifact(id) {
        if (isLocalGeneratedArtifactId(id)) {
            return deleteLocalGeneratedArtifact(id);
        }

        if (!this.isEnabled()) {
            return false;
        }

        const artifact = await artifactStore.get(id);
        if (!artifact) return false;

        await vectorStore.deleteArtifact(id);
        const deleted = await artifactStore.delete(id);
        if (deleted) {
            try {
                await assetManager.removeArtifact(id);
            } catch (error) {
                console.warn('[Artifacts] Failed to remove artifact from asset index:', error.message);
            }
        }
        return deleted;
    }

    async deleteArtifactsForSession(sessionId) {
        if (this.isEnabled()) {
            try {
                const artifacts = await artifactStore.listBySession(sessionId);
                for (const artifact of artifacts) {
                    await vectorStore.deleteArtifact(artifact.id);
                }
                await artifactStore.deleteBySession(sessionId);
            } catch (error) {
                console.warn('[Artifacts] Failed to delete Postgres artifacts:', error.message);
            }
        }
        await deleteLocalGeneratedArtifactsBySession(sessionId);
        try {
            await assetManager.removeArtifactsForSession(sessionId);
        } catch (error) {
            console.warn('[Artifacts] Failed to clear session assets from asset index:', error.message);
        }
    }

    async buildPromptContext(sessionId, artifactIds = []) {
        const allArtifacts = [];
        if (postgres.enabled) {
            try {
                allArtifacts.push(...await artifactStore.listBySession(sessionId));
            } catch (error) {
                console.warn('[Artifacts] Failed to read Postgres artifacts for prompt context:', error.message);
            }
        }

        allArtifacts.push(...await listLocalGeneratedArtifactsBySession(sessionId));
        if (allArtifacts.length === 0) {
            return '';
        }

        const selected = artifactIds.length > 0
            ? allArtifacts.filter((artifact) => artifactIds.includes(artifact.id))
            : allArtifacts.slice(0, 8);

        const inventory = allArtifacts.slice(0, 12).map((artifact) => {
            const marker = artifactIds.includes(artifact.id) ? 'selected' : 'available';
            return `- ${artifact.filename} (${artifact.extension}, ${marker}, ${artifact.sizeBytes} bytes)`;
        }).join('\n');

        const selectedDetails = selected.map((artifact) => {
            const privacyPreviewSuppressed = shouldSuppressUploadedArtifactPreview(artifact);
            const summary = privacyPreviewSuppressed
                ? 'PII protection is enabled for this uploaded file. Raw extracted content is withheld from the model; use trusted structured tools for calculations.'
                : artifact.extractedText
                ? artifact.extractedText.slice(0, 1600)
                : stripHtml(artifact.previewHtml || '').slice(0, 1600);
            return `File: ${artifact.filename}\nType: ${artifact.extension}\nSummary:\n${summary || '[binary file without extractable text]'}`;
        }).join('\n\n---\n\n');

        return `[Session artifacts]\n${inventory}\n\n[Selected artifact details]\n${selectedDetails}`;
    }

    sanitizeDocumentInstructionSession(session = null) {
        if (!session?.metadata || typeof session.metadata !== 'object') {
            return session;
        }

        const memory = session.metadata.projectMemory;
        if (!memory || typeof memory !== 'object') {
            return session;
        }

        const sanitizedUrls = Array.isArray(memory.urls)
            ? memory.urls.filter((entry) => {
                const normalizedUrl = normalizeImageReferenceUrl(entry?.url || '');
                if (!normalizedUrl) {
                    return true;
                }

                return !(String(entry?.kind || '').toLowerCase() === 'image' && isInternalArtifactImageReferenceUrl(normalizedUrl));
            })
            : memory.urls;
        const sanitizedArtifacts = Array.isArray(memory.artifacts)
            ? memory.artifacts.filter((entry) => {
                const downloadUrl = normalizeImageReferenceUrl(entry?.downloadUrl || '');
                const format = String(entry?.format || '').trim().toLowerCase();
                const imageLike = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(format);
                return !(downloadUrl && imageLike && isInternalArtifactImageReferenceUrl(downloadUrl));
            })
            : memory.artifacts;

        return {
            ...session,
            metadata: {
                ...session.metadata,
                projectMemory: {
                    ...memory,
                    urls: sanitizedUrls,
                    artifacts: sanitizedArtifacts,
                },
            },
        };
    }

    getGenerationInstructions(format, existingContent = '', promptContext = '', creativityPacket = null, requestPrompt = '', allowToolOrchestration = false) {
        const normalizedFormat = normalizeFormat(format);
        const creativityContext = renderCreativityPromptContext(creativityPacket);
        const dashboardInstructions = normalizedFormat === 'html'
            ? buildDashboardHtmlInstructions(requestPrompt, existingContent)
            : '';
        const interactiveInstructions = normalizedFormat === 'html'
            ? renderInteractiveArtifactInstructions(requestPrompt, existingContent)
            : '';
        const visualSafetyInstructions = ['html', 'pdf'].includes(normalizedFormat)
            ? buildVisualSafetyInstructions()
            : '';
        const conservativeRevisionInstructions = buildConservativeDocumentRevisionInstructions(requestPrompt, existingContent, normalizedFormat);
        const researchBackedRequest = isResearchBackedArtifactRequest(requestPrompt, normalizedFormat);
        const diagramHeavyRequest = isDiagramHeavyArtifactRequest(requestPrompt, normalizedFormat);
        const baseContext = [
            'You are the Lilly Business Agent.',
            'Produce business-ready output only, with no surrounding commentary.',
            allowToolOrchestration
                ? 'Use available tools when they materially improve factual grounding, research coverage, or delegated page planning. Do not mention tool invocation syntax or process notes in the final artifact output.'
                : 'Do not use external tools, function calls, or tool invocation syntax.',
            allowToolOrchestration && researchBackedRequest
                ? 'For research-backed, latest, current-events, and news-style documents, gather grounded online sources with web-search and web-fetch before composing, and prefer verified real image sources from Unsplash or direct image URLs over AI-generated imagery.'
                : '',
            allowToolOrchestration && diagramHeavyRequest
                ? 'For graph-heavy or diagram-heavy documents, use graph-diagram to create native graph JSON plus reusable SVG image artifacts, then embed those SVG artifact URLs or inline SVGs in the final document. If the active model is GPT-5.5 or newer, prefer custom SVG diagrams over plain Mermaid-only output while preserving native graph data when useful.'
                : '',
            visualSafetyInstructions,
            conservativeRevisionInstructions,
            'Do not mention environment limitations, permissions, API keys, or inability to create files.',
            'The platform will render, store, and deliver the file artifact for the user.',
            promptContext,
            creativityContext,
            interactiveInstructions,
        ].filter(Boolean).join('\n\n');
        const base = [
            baseContext,
            existingContent ? `Existing content to revise:\n${existingContent}` : '',
        ].filter(Boolean).join('\n\n');
        const complexFrontendBundleRequest = normalizedFormat === 'html'
            && isComplexFrontendBundleRequest(requestPrompt, existingContent);
        const requestedPageCount = complexFrontendBundleRequest
            ? extractRequestedSitePageCount(requestPrompt)
            : null;

        if (complexFrontendBundleRequest) {
            return buildFrontendBundleGenerationInstructions({
                promptContext: baseContext,
                existingContent,
                requestPrompt,
                requestedPageCount,
                dashboardInstructions,
            });
        }

        if (normalizedFormat === 'html' && isFrontendDemoArtifactRequest(requestPrompt || `${promptContext}\n${existingContent}`)) {
            return [
                base,
                buildDocumentImageInstructions(),
                dashboardInstructions,
                interactiveInstructions,
                'Return JSON only. No markdown fences.',
                'Build a polished frontend demo instead of a plain document.',
                'Work as an orchestrated product team: silently plan, build, critique, and revise the artifact before returning the final JSON.',
                'The final bundle must look like a finished first-pass product surface, not a cheap template or a document-suite wrapper.',
                'Choose the right HTML artifact family for the request: landing page, dashboard, app workspace, documentation site, report/brief, editorial feature, campaign microsite, or portfolio showcase.',
                'Match the request instead of defaulting to the same landing-page stack.',
                'Aim for a strong visual thesis, deliberate layout hierarchy, and a premium request-matched feel.',
                'Use semantic sections, responsive CSS, and purposeful but restrained interaction.',
                'Keep the result portable so it can be moved into a real frontend repository later.',
                'For browser game, playable simulation, or multi-step app requests, build a real state machine or game loop with input handling, update/render phases, score/progress, pause/restart, win/lose or completion state, responsive sizing, and an in-page fallback/error overlay for failed canvas/WebGL/module loading.',
                'Use realistic example data by default, and when a live source is known, wire it behind a small fetch layer or a clearly swappable data adapter.',
                'Favor real interactions such as filters, tab switches, drill-down panels, carousels, sticky nav, or chart toggles over static decoration.',
                buildSandboxBrowserLibraryInstructions(),
                'For documentation or reference requests, prioritize information architecture, wayfinding, examples, and utilities over marketing polish.',
                'For report or brief requests, prioritize headline findings, evidence panels, charts, and recommendations over conversion patterns.',
                'For app or dashboard requests, build working surfaces with controls, tables, panels, and navigation rather than brochure sections.',
                'Use stable ids or data-component attributes on major sections to help later component extraction.',
                'Prefer realistic copy, concrete sections, and clean calls to action over filler cards or placeholder boxes.',
                'Never expose internal template labels, archetype names, or planning language in visible copy.',
                'The preview runs inside a sandbox that allows scripts but withholds same-origin privileges. Keep interactions client-side, static-safe, and resilient without cookies or server mutation.',
                'When the request asks for a full website, news site, or multi-page experience, return a linked bundle with multiple HTML pages plus shared assets instead of a single-page mockup.',
                'Support static-server preview first. If you target Vite, React, or Next-style handoff, still make the preview files browser-runnable without a bundler by using relative modules or browser-compatible URLs instead of unresolved bare package imports.',
                'Mirror the preview entry page in `content`, and place the complete site files in `metadata.bundle`.',
                'Return exactly this shape:',
                '{',
                '  "content": "<!DOCTYPE html>...",',
                '  "metadata": {',
                '    "title": "Project title",',
                '    "language": "html",',
                '    "frameworkTarget": "static|vite|react|nextjs",',
                '    "previewMode": "site",',
                '    "bundle": {',
                '      "entry": "index.html",',
                '      "files": [',
                '        { "path": "index.html", "language": "html", "purpose": "Home page", "content": "<!DOCTYPE html>..." },',
                '        { "path": "world.html", "language": "html", "purpose": "Secondary page", "content": "<!DOCTYPE html>..." },',
                '        { "path": "styles.css", "language": "css", "purpose": "Shared site styles", "content": "..." },',
                '        { "path": "app.js", "language": "javascript", "purpose": "Shared interactions", "content": "..." }',
                '      ]',
                '    },',
                '    "handoff": {',
                '      "summary": "How to move this into a real repo",',
                '      "targetFramework": "static|vite|react|nextjs",',
                '      "componentMap": [{ "name": "Hero", "purpose": "Top-level message", "targetPath": "src/components/Hero.jsx" }],',
                '      "integrationSteps": ["Step 1", "Step 2"]',
                '    }',
                '  }',
                '}',
                'Make sure every file in `metadata.bundle.files` uses a unique relative path and valid file contents.',
                'Do not output implementation notes, markdown fences, or follow-up instructions.',
            ].filter(Boolean).join('\n\n');
        }

        if (normalizedFormat === 'html' || normalizedFormat === 'pdf') {
            return [
                base,
                buildDocumentImageInstructions(),
                'Return valid standalone HTML with inline-friendly structure and business formatting.',
                'Start at the first character with <!DOCTYPE html> and include no preface, explanation, or trailing notes.',
                'Use a deliberate visual thesis, strong hierarchy, and non-generic section pacing.',
                'Treat any provided template or sample as reference material, not copy to preserve verbatim.',
                normalizedFormat === 'html'
                    ? 'For HTML outputs, add web-document affordances such as sticky wayfinding, details/summary disclosures, source cards, tasteful CSS motion, and responsive controls when they improve comprehension.'
                    : 'For PDF outputs, choose the target page geometry up front, declare it in CSS with an explicit @page size and margin rule, and keep the HTML print-safe while still visually composed.',
                'Before finalizing, silently run a quality pass for content depth, visual originality, responsive behavior, contrast, and asset integrity. Revise weak or templated sections instead of describing them.',
                normalizedFormat === 'html' ? buildSandboxBrowserLibraryInstructions() : '',
            ].filter(Boolean).join('\n\n');
        }
        if (normalizedFormat === 'xml') {
            return `${base}\n\nReturn valid XML only. No markdown fences.`;
        }
        if (normalizedFormat === 'mermaid') {
            return `${base}\n\nReturn Mermaid v10-compatible source only. No markdown fences. Put each statement on its own line. Do not collapse the diagram into a single line.`;
        }
        if (normalizedFormat === 'power-query') {
            return `${base}\n\nReturn valid Power Query M script only. No markdown fences.`;
        }
        if (normalizedFormat === 'xlsx') {
            return `${base}\n\nReturn valid JSON only in the shape {"title":"...","sheets":[{"name":"...","rows":[["...", "..."]]}]}. Keep rows tabular and concise.`;
        }

        return base;
    }

    async runGenerationPass({
        session = null,
        input,
        instructions,
        model = null,
        reasoningEffort = null,
        previousResponseId = null,
        contextMessages = [],
        recentMessages = [],
        toolManager = null,
        toolContext = {},
        enableAutomaticToolCalls = false,
        executionProfile = 'default',
    }) {
        const response = await requestModelResponse({
            input,
            previousResponseId,
            contextMessages,
            recentMessages,
            instructions,
            stream: false,
            model,
            reasoningEffort,
            toolManager,
            toolContext,
            enableAutomaticToolCalls,
            executionProfile,
        });

        return {
            responseId: response.id,
            outputText: extractResponseText(response),
            rawOutputText: extractRawResponseText(response),
            model: response.model || model || null,
            usage: extractResponseUsageMetadata(response),
            piiCleansing: normalizePiiCleansingMetadata(response._kimibuiltPiiCleansing),
        };
    }

    getArtifactPlanInstructions(format, promptContext = '', existingContent = '', creativityPacket = null) {
        const creativityContext = renderCreativityPromptContext(creativityPacket);
        const conservativeRevisionInstructions = buildConservativeDocumentRevisionInstructions(promptContext, existingContent, format);
        return [
            'You are planning a high-quality business document generation workflow.',
            'Return JSON only. No markdown fences.',
            'First decide the document title, creative direction, and the major sections required to satisfy the request.',
            'Prefer 4-8 sections for substantial documents unless the request clearly needs fewer.',
            'Each section should have a concrete purpose, a visible layout role, and 2-5 key points that must be covered.',
            'If verified images are available, plan where real images support the document, but do not invent illustrations.',
            'If the request needs graphs, diagrams, charts, process maps, or architecture visuals, plan where graph-diagram SVG artifacts or inline SVGs should be used. For GPT-5.5 or newer models, prefer direct custom SVG diagrams when the visual requires precision or polish.',
            'Do not mirror placeholder headings or sample copy from provided templates.',
            'Treat instruction blocks such as <creative_direction>, <sample_handling>, <continuity>, [Verified image references], and [Research workflow] as guidance only. Never copy them into the document plan.',
            conservativeRevisionInstructions,
            existingContent ? `Existing content to revise:\n${existingContent}` : '',
            promptContext,
            creativityContext,
            '',
            'Return exactly this shape:',
            '{',
            '  "title": "Document title",',
            '  "creativeDirection": {',
            '    "id": "direction-id",',
            '    "label": "Direction label",',
            '    "rationale": "Why this direction fits"',
            '  },',
            '  "themeSuggestion": "editorial|executive|product|bold",',
            '  "humanizationNotes": ["Short note about how to keep the writing human"],',
            '  "sampleHandling": ["Short note about how to avoid copying the sample"],',
            '  "sections": [',
            '    {',
            '      "heading": "Section heading",',
            '      "purpose": "Why this section exists",',
            '      "keyPoints": ["Point 1", "Point 2"],',
            '      "targetLength": "short|medium|long",',
            '      "layout": "lead|briefing|analysis|proof|comparison|close",',
            '      "tone": "How this section should sound",',
            '      "visualIntent": "How real visuals or layout contrast should support the section"',
            '    }',
            '  ]',
            '}',
            `Target output format: ${format}.`,
        ].filter(Boolean).join('\n');
    }

    getArtifactExpansionInstructions(format, promptContext = '', existingContent = '', creativityPacket = null) {
        const creativityContext = renderCreativityPromptContext(creativityPacket);
        const conservativeRevisionInstructions = buildConservativeDocumentRevisionInstructions(promptContext, existingContent, format);
        return [
            'You are expanding an approved document outline into full section content.',
            'Return JSON only. No markdown fences.',
            'Write polished, business-ready prose for each section.',
            'Keep sections distinct, avoid repetition, and fully cover the requested key points.',
            'Use paragraphs and inline bullets within section content when appropriate.',
            'Make the voice feel authored by a thoughtful human, not evenly templated by a machine.',
            'Vary rhythm between sections instead of giving every section the same sentence cadence.',
            'If verified image references are available, mention the real image use naturally in the section content instead of describing fake illustrations.',
            'For sections that need diagrams, reference the intended graph-diagram output by purpose rather than writing raw diagram source into prose.',
            'Do not echo placeholder copy, sample headings, or tutorial language from the scaffold.',
            'Never quote or reproduce instruction-only metadata such as [Verified image references], [Research workflow], Source: tool, Source: unsplash, or creative-direction labels in the section content.',
            conservativeRevisionInstructions,
            existingContent ? `Existing content to revise:\n${existingContent}` : '',
            promptContext,
            creativityContext,
            '',
            'Return exactly this shape:',
            '{',
            '  "title": "Document title",',
            '  "sections": [',
            '    {',
            '      "heading": "Section heading",',
            '      "kicker": "Optional short eyebrow line",',
            '      "content": "Full section content",',
            '      "level": 1,',
            '      "visualIntent": "Optional note for composition about contrast, image use, or pacing"',
            '    }',
            '  ]',
            '}',
            `Target output format: ${format}.`,
        ].filter(Boolean).join('\n');
    }

    getArtifactCompositionInstructions(format, promptContext = '', creativityPacket = null) {
        const creativityContext = renderCreativityPromptContext(creativityPacket);
        const conservativeRevisionInstructions = buildConservativeDocumentRevisionInstructions(promptContext, '', format);
        return [
            'You are composing the final document artifact from an expanded section draft.',
            'Return valid standalone HTML only. No markdown fences.',
            'Start at the first character with <!DOCTYPE html> and include no preface, explanation, or trailing notes.',
            'Use semantic HTML with a strong document structure.',
            'Include one H1 title and then H2/H3 sections as appropriate.',
            'Preserve the section order and cover all requested content.',
            'Use professional formatting suitable for business reports, briefs, plans, and polished notes.',
            'Keep the layout printer-friendly because the HTML may be rendered to PDF.',
            'Use CSS variables, a deliberate theme, and section-level hierarchy so the result feels designed rather than default.',
            'Create a strong opening hero, visible section chrome, and alternating density across sections.',
            'Do not let every section reuse the same card treatment, paragraph width, or transition language.',
            'When verified image URLs are available, make the design image-rich with a hero image, repeated section visuals, image cards, and gallery treatments across the document.',
            'When graph-diagram produced SVG image artifacts are available, embed them as first-class document visuals with concise captions. If no artifact URL is available and the model is GPT-5.5 or newer, inline clean accessible SVG directly in the HTML.',
            'Do not output a layout plan, source register instructions, build checklist, editorial note, or any meta-document that describes how a future document should be assembled.',
            'The output must be the finished document itself, not instructions for building it.',
            'Do not print workflow labels, source metadata, tool notes, or image search descriptions verbatim in the body or captions.',
            conservativeRevisionInstructions,
            buildDocumentImageInstructions(),
            promptContext,
            creativityContext,
            `Target output format: ${format}.`,
        ].filter(Boolean).join('\n');
    }

    formatImageReferenceContext(imageReferences = []) {
        if (!Array.isArray(imageReferences) || imageReferences.length === 0) {
            return '';
        }

        return [
            '[Verified image references]',
            'Use these real image URLs when the output benefits from visuals.',
            `These verified references can be reused throughout the document, up to ${DEFAULT_DOCUMENT_IMAGE_TARGET} images when the request supports it.`,
            'When the user asks for one of these images as a static background, use that image URL directly in CSS background-image and place text on readable overlay surfaces.',
            'Prefer standard HTML <img src="..."> elements that point to these URLs.',
            ...imageReferences.map((entry, index) => {
                const label = entry.title || `Image ${index + 1}`;
                const source = entry.toolId ? ` via ${entry.toolId}` : '';
                return `- ${label} -> ${entry.url} [${entry.source}${source}]`;
            }),
        ].join('\n');
    }

    async resolveImageReferences(session = null, prompt = '', options = {}) {
        const desiredCount = Math.max(1, Number(options.desiredCount || DEFAULT_DOCUMENT_IMAGE_TARGET) || DEFAULT_DOCUMENT_IMAGE_TARGET);
        const selectedArtifacts = Array.isArray(options.selectedArtifacts) ? options.selectedArtifacts : [];
        const selectedArtifactRefs = extractImageReferencesFromArtifacts(selectedArtifacts);
        const promptRefs = extractImageReferencesFromText(prompt);
        const sessionRefs = extractImageReferencesFromSession(session);
        const unique = new Map();
        [...selectedArtifactRefs, ...promptRefs, ...sessionRefs].forEach((entry) => {
            const allowInternal = entry?.internal === true || isInternalArtifactImageReferenceUrl(entry?.url || '');
            if (!entry?.url || !isRenderableImageReferenceUrl(entry.url, { allowInternal }) || unique.has(entry.url)) {
                return;
            }
            unique.set(entry.url, entry);
        });

        let combinedRefs = Array.from(unique.values()).slice(0, desiredCount);
        const preferVisualDefaults = options.preferVisualDefaults === true;
        const explicitPriorImageReference = refersToPriorImages(prompt);

        if (selectedArtifactRefs.length > 0 || explicitPriorImageReference) {
            return combinedRefs;
        }

        if (!isUnsplashConfigured() || (!preferVisualDefaults && !shouldFetchUnsplashReferences(prompt))) {
            return combinedRefs;
        }

        const query = inferUnsplashQuery(prompt);
        if (!query) {
            return combinedRefs;
        }

        try {
            const results = await searchImages(query, { perPage: desiredCount, orientation: 'landscape' });
            const unsplashRefs = (Array.isArray(results?.results) ? results.results : [])
                .map((image) => ({
                    url: normalizeImageReferenceUrl(image?.urls?.regular || image?.urls?.full || image?.urls?.small || ''),
                    title: sanitizeImageReferenceTitle(String(image?.description || image?.altDescription || query).trim(), ''),
                    source: 'unsplash',
                    toolId: 'image-search-unsplash',
                }))
                .filter((entry) => entry.url && isExternalImageReferenceUrl(entry.url));

            [...combinedRefs, ...unsplashRefs].forEach((entry) => {
                if (!entry?.url || !isExternalImageReferenceUrl(entry.url) || unique.has(entry.url)) {
                    return;
                }
                unique.set(entry.url, entry);
            });

            combinedRefs = Array.from(unique.values()).slice(0, desiredCount);
            return combinedRefs;
        } catch (error) {
            console.warn('[Artifacts] Failed to fetch Unsplash references:', error.message);
            return combinedRefs;
        }
    }

    async buildImageReferenceContext(session = null, prompt = '') {
        return this.formatImageReferenceContext(
            await this.resolveImageReferences(session, prompt, {
                desiredCount: DEFAULT_DOCUMENT_IMAGE_TARGET,
                preferVisualDefaults: true,
            }),
        );
    }

    async generateMultiPassDocumentSource({
        session,
        prompt,
        format,
        promptContext = '',
        existingContent = '',
        model = null,
        reasoningEffort = null,
        imageReferences = [],
        imageReferenceContext = '',
        creativityPacket = null,
        contextMessages = [],
        recentMessages = [],
        toolManager = null,
        toolContext = {},
        enableAutomaticToolCalls = false,
        executionProfile = 'default',
    }) {
        const conservativeDocumentRevision = isConservativeDocumentRevisionRequest(prompt, existingContent, format);
        const resolvedImageReferences = conservativeDocumentRevision
            ? []
            : (Array.isArray(imageReferences) ? imageReferences : []);
        const resolvedImageReferenceContext = imageReferenceContext || this.formatImageReferenceContext(resolvedImageReferences);
        const conservativeRevisionInstructions = buildConservativeDocumentRevisionInstructions(prompt, existingContent, format);
        const canUseResearchTools = enableAutomaticToolCalls && Boolean(toolManager?.executeTool);
        const researchToolContext = canUseResearchTools && isResearchBackedArtifactRequest(prompt, format)
            ? [
                '[Research workflow]',
                'Before drafting or composing, use available tools to ground current claims with web-search and web-fetch.',
                'Prefer verified real image sources from Unsplash or direct image URLs over AI-generated illustrations unless the user explicitly asks for generated art.',
            ].join('\n')
            : '';
        const enrichedPromptContext = [promptContext, conservativeRevisionInstructions, resolvedImageReferenceContext, researchToolContext].filter(Boolean).join('\n\n');
        const planPass = await this.runGenerationPass({
            session,
            input: prompt,
            instructions: buildSessionInstructions(
                session,
                this.getArtifactPlanInstructions(format, enrichedPromptContext, existingContent, creativityPacket),
            ),
            model,
            reasoningEffort,
            previousResponseId: session?.previousResponseId || null,
            contextMessages,
            recentMessages,
            toolManager,
            toolContext,
            enableAutomaticToolCalls,
            executionProfile,
        });

        const parsedPlan = safeJsonParse(planPass.outputText) || {};
        const creativePlan = normalizeCreativePlan(parsedPlan, creativityPacket);
        const normalizedPlan = {
            title: String(parsedPlan.title || inferDocumentTitle(prompt, `${String(format || 'document').toUpperCase()} Document`)).trim(),
            sections: normalizePlanSections(parsedPlan.sections),
            creativePlan,
        };

        if (normalizedPlan.sections.length === 0) {
            normalizedPlan.sections = [
                {
                    heading: 'Overview',
                    purpose: 'Summarize the document objective and context.',
                    keyPoints: [],
                    targetLength: 'medium',
                    layout: 'lead',
                    tone: 'direct',
                    visualIntent: 'Use a strong opening block that frames the request clearly.',
                },
                {
                    heading: 'Details',
                    purpose: 'Cover the main requested content in detail.',
                    keyPoints: [],
                    targetLength: 'medium',
                    layout: 'analysis',
                    tone: 'grounded',
                    visualIntent: 'Add contrast through image use or spacing rather than repeating the opener.',
                },
            ];
        }

        const expansionPass = await this.runGenerationPass({
            session,
            input: [
                'Original request:',
                prompt,
                '',
                'Approved outline:',
                JSON.stringify(normalizedPlan, null, 2),
            ].join('\n'),
            instructions: buildSessionInstructions(
                session,
                this.getArtifactExpansionInstructions(format, enrichedPromptContext, existingContent, creativityPacket),
            ),
            model,
            reasoningEffort,
            previousResponseId: planPass.responseId || null,
            contextMessages,
            recentMessages,
            toolManager,
            toolContext,
            enableAutomaticToolCalls,
            executionProfile,
        });

        const parsedExpanded = safeJsonParse(expansionPass.outputText) || {};
        const expandedDocument = {
            title: String(parsedExpanded.title || normalizedPlan.title).trim() || normalizedPlan.title,
            sections: normalizeDocumentSections(parsedExpanded.sections, normalizedPlan.sections),
        };

        if (expandedDocument.sections.length === 0) {
            expandedDocument.sections = normalizedPlan.sections.map((section) => ({
                heading: section.heading,
                content: section.keyPoints.length > 0
                    ? section.keyPoints.map((point) => `- ${point}`).join('\n')
                    : section.purpose || '',
                level: 1,
            }));
        }

        const compositionPass = await this.runGenerationPass({
            session,
            input: [
                'Original request:',
                prompt,
                '',
                'Structured document draft:',
                JSON.stringify(expandedDocument, null, 2),
            ].join('\n'),
            instructions: buildSessionInstructions(
                session,
                this.getArtifactCompositionInstructions(format, enrichedPromptContext, creativityPacket),
            ),
            model,
            reasoningEffort,
            previousResponseId: expansionPass.responseId || planPass.responseId || null,
            contextMessages,
            recentMessages,
            toolManager,
            toolContext,
            enableAutomaticToolCalls,
            executionProfile,
        });

        const usedCompositionRecovery = shouldRecoverCompositionOutput(compositionPass.outputText, expandedDocument);
        const finalOutputText = usedCompositionRecovery
            ? buildExpandedDocumentHtml(
                expandedDocument.title || normalizedPlan.title,
                expandedDocument.sections,
                resolvedImageReferences,
                creativePlan,
            )
            : compositionPass.outputText;

        return {
            responseId: compositionPass.responseId,
            title: expandedDocument.title || normalizedPlan.title,
            outputText: finalOutputText,
            model: compositionPass.model || expansionPass.model || planPass.model || model || null,
            usage: mergeUsageMetadata(
                planPass.usage,
                expansionPass.usage,
                compositionPass.usage,
            ),
            piiCleansing: mergePiiCleansingMetadata(
                planPass.piiCleansing,
                expansionPass.piiCleansing,
                compositionPass.piiCleansing,
            ),
            metadata: {
                generationStrategy: 'multi-pass',
                generationPasses: ['plan', 'expand', 'compose'],
                sectionCount: expandedDocument.sections.length,
                compositionRecovered: usedCompositionRecovery,
                toolOrchestrationEnabled: enableAutomaticToolCalls,
                creativeDirectionId: creativePlan.id,
                creativeDirection: creativePlan.label,
                creativeRationale: creativePlan.rationale,
                themeSuggestion: creativePlan.themeSuggestion,
                outline: normalizedPlan.sections.map((section) => ({
                    heading: section.heading,
                    purpose: section.purpose,
                    targetLength: section.targetLength,
                    layout: section.layout,
                })),
            },
        };
    }

    async generateArtifact({
        session,
        sessionId,
        mode = 'chat',
        prompt,
        format,
        artifactIds = [],
        existingContent = '',
        template = '',
        model = null,
        reasoningEffort = null,
        parentArtifactId = null,
        contextMessages = [],
        recentMessages = [],
        toolManager = null,
        toolContext = {},
        executionProfile = 'default',
    }) {
        const normalizedFormat = normalizeFormat(format);
        const frontendDemoRequest = normalizedFormat === 'html'
            && (isFrontendDemoArtifactRequest(prompt) || shouldUseInteractiveHtmlArtifact({
                prompt,
                format: normalizedFormat,
                existingContent: [template, existingContent].filter(Boolean).join('\n\n'),
            }));
        const complexFrontendBundleRequest = normalizedFormat === 'html'
            && isComplexFrontendBundleRequest(prompt, [template, existingContent].filter(Boolean).join('\n\n'));
        const enableArtifactToolOrchestration = shouldEnableArtifactToolOrchestration(prompt, normalizedFormat);
        const canUseArtifactToolOrchestration = enableArtifactToolOrchestration && Boolean(toolManager?.executeTool);
        if (!SUPPORTED_GENERATION_FORMATS.has(normalizedFormat)) {
            throw new Error(`Unsupported generation format: ${format}`);
        }

        const promptContext = await this.buildPromptContext(sessionId, artifactIds);
        const combinedExistingContent = [template, existingContent].filter(Boolean).join('\n\n');
        const conservativeDocumentRevision = isConservativeDocumentRevisionRequest(prompt, combinedExistingContent, normalizedFormat);
        const selectedArtifacts = artifactIds.length > 0
            ? (await Promise.all(artifactIds.slice(0, 8).map(async (artifactId) => {
                if (isLocalGeneratedArtifactId(artifactId)) {
                    return getLocalGeneratedArtifact(artifactId);
                }
                return postgres.enabled ? artifactStore.get(artifactId) : null;
            }))).filter(Boolean)
            : [];
        const imageReferences = conservativeDocumentRevision
            ? []
            : await this.resolveImageReferences(session, prompt, {
                desiredCount: (MULTI_PASS_DOCUMENT_FORMATS.has(normalizedFormat) || frontendDemoRequest) ? DEFAULT_DOCUMENT_IMAGE_TARGET : 3,
                preferVisualDefaults: MULTI_PASS_DOCUMENT_FORMATS.has(normalizedFormat) || frontendDemoRequest,
                selectedArtifacts,
            });
        const imageReferenceContext = this.formatImageReferenceContext(imageReferences);
        const artifactExperienceMetadata = buildArtifactExperienceMetadata({
            prompt,
            format: normalizedFormat,
            existingContent: combinedExistingContent,
        });
        const dashboardTemplates = normalizedFormat === 'html'
            ? selectDashboardTemplates({
                prompt,
                existingContent: combinedExistingContent,
                limit: 3,
            })
            : [];
        const creativityPacket = buildDocumentCreativityPacket({
            prompt,
            documentType: inferDocumentTypeFromPrompt(prompt),
            format: normalizedFormat,
            existingContent: combinedExistingContent,
            session,
            recentMessages,
        });
        const instructionSession = this.sanitizeDocumentInstructionSession(session);
        const generated = frontendDemoRequest
            ? {
                ...(await this.runGenerationPass({
                    session: instructionSession,
                    input: prompt,
                    instructions: buildSessionInstructions(
                        instructionSession,
                        this.getGenerationInstructions(
                            normalizedFormat,
                            combinedExistingContent,
                            [promptContext, imageReferenceContext].filter(Boolean).join('\n\n'),
                            creativityPacket,
                            prompt,
                            canUseArtifactToolOrchestration,
                        ),
                    ),
                    model,
                    reasoningEffort,
                    previousResponseId: session?.previousResponseId || null,
                    contextMessages,
                    recentMessages,
                    toolManager,
                    toolContext,
                    enableAutomaticToolCalls: canUseArtifactToolOrchestration,
                    executionProfile,
                })),
                title: inferDocumentTitle(prompt, 'Frontend Demo'),
                metadata: {
                    generationStrategy: 'single-pass-frontend-demo',
                    toolOrchestrationEnabled: canUseArtifactToolOrchestration,
                },
            }
            : MULTI_PASS_DOCUMENT_FORMATS.has(normalizedFormat)
            ? await this.generateMultiPassDocumentSource({
                session: instructionSession,
                prompt,
                format: normalizedFormat,
                promptContext,
                existingContent: combinedExistingContent,
                model,
                reasoningEffort,
                imageReferences,
                imageReferenceContext,
                creativityPacket,
                contextMessages,
                recentMessages,
                toolManager,
                toolContext,
                enableAutomaticToolCalls: canUseArtifactToolOrchestration,
                executionProfile,
            })
            : await this.runGenerationPass({
                session: instructionSession,
                input: prompt,
                instructions: buildSessionInstructions(
                    instructionSession,
                    this.getGenerationInstructions(
                        normalizedFormat,
                        combinedExistingContent,
                        [promptContext, imageReferenceContext].filter(Boolean).join('\n\n'),
                        creativityPacket,
                        prompt,
                        canUseArtifactToolOrchestration,
                    ),
                ),
                model,
                reasoningEffort,
                previousResponseId: session?.previousResponseId || null,
                contextMessages,
                recentMessages,
                toolManager,
                toolContext,
                enableAutomaticToolCalls: canUseArtifactToolOrchestration,
                executionProfile,
            });

        const outputText = frontendDemoRequest
            ? (generated.rawOutputText || generated.outputText)
            : generated.outputText;
        const generatedPiiCleansing = mergePiiCleansingMetadata(generated.piiCleansing);
        const piiRestoreOptions = {
            sessionId,
            session,
            ownerId: toolContext?.ownerId || null,
            metadata: {
                piiCleansing: generatedPiiCleansing,
            },
            piiCleansing: generatedPiiCleansing,
            clientSurface: toolContext?.clientSurface || 'artifact-generation',
            route: toolContext?.route || '/api/artifacts/generate',
        };
        const frontendPayload = frontendDemoRequest
            ? buildFrontendArtifactPayload(outputText)
            : null;
        const normalizedFrontendPayloadBase = frontendPayload
            ? {
                ...frontendPayload,
                content: diversifyHtmlImageReferences(frontendPayload.content, imageReferences),
                metadata: {
                    ...(frontendPayload.metadata || {}),
                    bundle: diversifyBundleImageReferences(frontendPayload.metadata?.bundle || null, imageReferences),
                },
            }
            : null;
        const restoredFrontendPayload = normalizedFrontendPayloadBase
            ? await restoreFrontendPayloadPii(normalizedFrontendPayloadBase, piiRestoreOptions)
            : null;
        const normalizedFrontendPayload = restoredFrontendPayload?.payload || normalizedFrontendPayloadBase;
        const hasFrontendBundleFiles = Array.isArray(normalizedFrontendPayload?.metadata?.bundle?.files)
            && normalizedFrontendPayload.metadata.bundle.files.length > 0;
        const hasFrontendBundleArchive = Boolean(normalizedFrontendPayload)
            && (
                complexFrontendBundleRequest
                || (hasFrontendBundleFiles && (
                normalizedFrontendPayload.metadata.bundle.files.length > 1
                || String(normalizedFrontendPayload.metadata?.frameworkTarget || '').trim().toLowerCase() === 'vite'
                ))
            );
        const rawRenderSource = normalizedFrontendPayload
            ? normalizedFrontendPayload.content
            : diversifyHtmlImageReferences(
                ['html', 'pdf'].includes(normalizedFormat)
                    ? (sanitizeFrontendHtmlContent(unwrapCodeFence(outputText)) || unwrapCodeFence(outputText))
                    : unwrapCodeFence(outputText),
                imageReferences,
            );
        const restoredRenderSource = normalizedFrontendPayload
            ? { text: rawRenderSource, restorations: [] }
            : await restoreGeneratedPiiPlaceholders(rawRenderSource, piiRestoreOptions);
        const renderSource = restoredRenderSource.text;
        const piiRestorations = [
            ...(restoredFrontendPayload?.restorations || []),
            ...(restoredRenderSource.restorations || []),
        ];
        const piiArtifactMetadata = buildPiiArtifactMetadata(generatedPiiCleansing, piiRestorations);
        const title = normalizedFrontendPayload?.metadata?.title
            || generated.title
            || `${normalizedFormat}-${new Date().toISOString().slice(0, 10)}`;

        const rendered = hasFrontendBundleArchive
            ? buildFrontendBundleArtifact({
                ...normalizedFrontendPayload.metadata.bundle,
                frameworkTarget: normalizedFrontendPayload.metadata.frameworkTarget,
            }, title, { imageReferences })
            : normalizedFormat === 'xlsx'
            ? await renderArtifact({
                format: normalizedFormat,
                title,
                content: renderSource,
                workbookSpec: tryParseJson(renderSource, title),
            })
            : await renderArtifact({
                format: normalizedFormat,
                title,
                content: renderSource,
            });
        const creativeMetadata = creativityPacket
            ? {
                creativeDirectionId: generated.metadata?.creativeDirectionId || creativityPacket.direction?.id || null,
                creativeDirection: generated.metadata?.creativeDirection || creativityPacket.direction?.label || null,
                creativeRationale: generated.metadata?.creativeRationale || creativityPacket.direction?.rationale || null,
                themeSuggestion: generated.metadata?.themeSuggestion || creativityPacket.themeSuggestion || null,
            }
            : {};
        const dashboardMetadata = dashboardTemplates.length > 0
            ? {
                dashboardTemplateSuggestedPrimaryId: dashboardTemplates[0].id,
                dashboardTemplateSuggestedPrimaryLabel: dashboardTemplates[0].label,
                dashboardTemplateOptions: dashboardTemplates.map((templateOption) => ({
                    id: templateOption.id,
                    label: templateOption.label,
                    summary: templateOption.summary,
                })),
            }
            : {};

        const artifact = await this.createStoredArtifact({
            sessionId,
            session,
            parentArtifactId,
            direction: 'generated',
            sourceMode: mode,
            filename: rendered.filename,
            extension: rendered.format,
            mimeType: rendered.mimeType,
            buffer: rendered.buffer,
            extractedText: rendered.extractedText,
            previewHtml: rendered.previewHtml,
            metadata: {
                format: normalizedFormat,
                sourcePrompt: resolveStoredSourcePrompt(prompt, generatedPiiCleansing),
                artifactIds,
                ...(normalizedFrontendPayload?.metadata || {}),
                ...rendered.metadata,
                ...creativeMetadata,
                ...dashboardMetadata,
                ...(generated.metadata || {}),
                ...artifactExperienceMetadata,
                ...(piiArtifactMetadata ? { piiCleansing: piiArtifactMetadata } : {}),
            },
            vectorizeText: ['html', 'pdf'].includes(normalizedFormat)
                ? stripHtml(rawRenderSource)
                : String(rawRenderSource || ''),
            vectorize: Boolean(rendered.extractedText),
        });

        return {
            responseId: generated.responseId,
            artifact: this.serializeArtifact(artifact),
            outputText,
            model: generated.model || model || null,
            usage: generated.usage || null,
        };
    }

    async storeGeneratedArtifactFromContent({
        sessionId,
        mode = 'chat',
        format,
        content,
        title = 'generated-artifact',
        parentArtifactId = null,
        metadata = {},
        ownerId = null,
        session = null,
        workbookSpec = null,
    }) {
        const normalizedFormat = normalizeFormat(format);
        const restoredContent = await restoreGeneratedPiiPlaceholders(content, {
            sessionId,
            session,
            ownerId,
            metadata,
            piiCleansing: metadata?.piiCleansing || null,
            clientSurface: mode || 'artifact-generation',
            route: metadata?.route || '/api/artifacts/generate',
        });
        const piiArtifactMetadata = buildPiiArtifactMetadata(metadata?.piiCleansing || null, restoredContent.restorations);
        const rendered = await renderArtifact({
            format: normalizedFormat,
            title,
            content: restoredContent.text,
            workbookSpec,
        });

        const artifact = await this.createStoredArtifact({
            sessionId,
            parentArtifactId,
            direction: 'generated',
            sourceMode: mode,
            filename: rendered.filename,
            extension: rendered.format,
            mimeType: rendered.mimeType,
            buffer: rendered.buffer,
            extractedText: rendered.extractedText,
            previewHtml: rendered.previewHtml,
            metadata: {
                ...rendered.metadata,
                ...metadata,
                ...(piiArtifactMetadata ? { piiCleansing: piiArtifactMetadata } : {}),
            },
            ownerId,
            vectorizeText: String(content || ''),
            vectorize: Boolean(rendered.extractedText),
        });

        return this.serializeArtifact(artifact);
    }
}

const artifactService = new ArtifactService();

module.exports = {
    artifactService,
    ArtifactService,
    extractResponseText,
    resolveCompletedResponseText,
    getMissingCompletionDelta,
};




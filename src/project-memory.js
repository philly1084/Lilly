const MAX_PROJECT_URLS = 40;
const MAX_PROJECT_TASKS = 24;
const MAX_PROJECT_ARTIFACTS = 24;
const MAX_PROJECT_IMAGE_URL_INSTRUCTIONS = 20;
const MAX_PROJECT_REFERENCE_URL_INSTRUCTIONS = 8;
const SITE_ARTIFACT_FORMATS = new Set([
    'html',
    'htm',
    'site',
    'website',
    'web',
    'frontend',
    'sandbox',
]);

function sanitizeText(value = '', limit = 280) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) {
        return '';
    }

    return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function normalizeUrl(url = '') {
    const trimmed = String(url || '').trim().replace(/[),.;:!?]+$/g, '');
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

function extractUrlsFromText(text = '') {
    const source = String(text || '');
    if (!source) {
        return [];
    }

    const matches = source.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
    const unique = new Set();

    return matches
        .map((match) => normalizeUrl(match))
        .filter((url) => {
            if (!url || unique.has(url)) {
                return false;
            }
            unique.add(url);
            return true;
        });
}

function extractUrlsFromValue(value, depth = 0) {
    if (depth > 4 || value == null) {
        return [];
    }

    if (typeof value === 'string') {
        return extractUrlsFromText(value);
    }

    if (Array.isArray(value)) {
        return Array.from(new Set(value.flatMap((entry) => extractUrlsFromValue(entry, depth + 1))));
    }

    if (typeof value === 'object') {
        return Array.from(new Set(
            Object.values(value).flatMap((entry) => extractUrlsFromValue(entry, depth + 1)),
        ));
    }

    return [];
}

function inferUrlKind(url = '', context = '') {
    const combined = `${url} ${context}`.toLowerCase();
    if (/\b(image|photo|unsplash)\b/.test(combined)
        || /\.(png|jpe?g|gif|webp|svg)(?:\?|$)/i.test(url)) {
        return 'image';
    }

    if (/\b(pdf|docx|html|download|artifact|file)\b/.test(combined)) {
        return 'artifact';
    }

    return 'reference';
}

function buildUrlRefs(urls = [], source = 'assistant', extra = {}) {
    return urls.map((url) => ({
        url,
        source,
        kind: inferUrlKind(url, `${extra.title || ''} ${extra.toolId || ''}`),
        title: sanitizeText(extra.title || ''),
        toolId: extra.toolId || null,
        capturedAt: extra.capturedAt || new Date().toISOString(),
    }));
}

function buildArtifactRefs(artifacts = [], capturedAt = new Date().toISOString()) {
    return (Array.isArray(artifacts) ? artifacts : [])
        .map((artifact) => {
            if (!artifact?.id) {
                return null;
            }

            return {
                id: artifact.id,
                filename: artifact.filename || '',
                format: artifact.format || artifact.extension || '',
                downloadUrl: normalizeUrl(artifact.downloadUrl || ''),
                sourcePrompt: sanitizeText(artifact?.metadata?.sourcePrompt || ''),
                creativeDirection: sanitizeText(
                    artifact?.metadata?.creativeDirection
                    || artifact?.metadata?.creativeDirectionLabel
                    || '',
                    80,
                ),
                creativeDirectionId: sanitizeText(artifact?.metadata?.creativeDirectionId || '', 64),
                themeSuggestion: sanitizeText(artifact?.metadata?.themeSuggestion || '', 40),
                capturedAt,
            };
        })
        .filter(Boolean);
}

function normalizeArtifactPreviewUrl(url = '') {
    const normalized = normalizeUrl(url);
    return normalized || '';
}

function isPreviewableSiteArtifact(artifact = {}) {
    if (!artifact || typeof artifact !== 'object') {
        return false;
    }

    const previewUrl = normalizeArtifactPreviewUrl(artifact.previewUrl || artifact.preview_url || '');
    const sandboxUrl = normalizeArtifactPreviewUrl(artifact.sandboxUrl || artifact.sandbox_url || '');
    if (!previewUrl && !sandboxUrl) {
        return false;
    }

    const format = String(artifact.format || artifact.extension || artifact.metadata?.format || '').trim().toLowerCase();
    const filename = String(artifact.filename || '').trim().toLowerCase();
    const mimeType = String(artifact.mimeType || artifact.mime_type || artifact.metadata?.mimeType || '').trim().toLowerCase();
    return SITE_ARTIFACT_FORMATS.has(format)
        || filename.endsWith('.html')
        || filename.endsWith('.htm')
        || mimeType === 'text/html'
        || artifact.metadata?.previewMode === 'iframe'
        || artifact.metadata?.frameworkTarget === 'static'
        || artifact.metadata?.frameworkTarget === 'vite'
        || artifact.metadata?.frameworkTarget === 'react'
        || artifact.metadata?.frameworkTarget === 'nextjs';
}

function buildActiveProjectPreviewUpdate({ assistantText = '', toolEvents = [], artifacts = [] } = {}) {
    const derivedArtifacts = (Array.isArray(toolEvents) ? toolEvents : [])
        .flatMap((event) => extractArtifactsFromValue(event?.result?.data));
    const combinedArtifacts = [...(Array.isArray(artifacts) ? artifacts : []), ...derivedArtifacts]
        .filter((artifact) => artifact && typeof artifact === 'object');
    const artifact = [...combinedArtifacts].reverse().find(isPreviewableSiteArtifact);
    if (!artifact?.id) {
        return null;
    }

    const previewUrl = normalizeArtifactPreviewUrl(artifact.previewUrl || artifact.preview_url || '');
    const sandboxUrl = normalizeArtifactPreviewUrl(artifact.sandboxUrl || artifact.sandbox_url || '');
    const viewportUrl = previewUrl || sandboxUrl;
    if (!viewportUrl) {
        return null;
    }

    const filename = sanitizeText(artifact.filename || '', 120);
    const title = sanitizeText(
        artifact.metadata?.title
        || artifact.metadata?.name
        || filename
        || 'Generated site preview',
        120,
    );
    const summary = sanitizeText(
        assistantText
        || artifact.metadata?.sourcePrompt
        || (filename ? `Created ${filename}` : 'Generated a previewable site artifact.'),
        180,
    );

    return {
        type: 'sandbox',
        key: `artifact:${artifact.id}`,
        title,
        summary,
        phase: 'preview',
        status: 'live',
        artifactId: String(artifact.id).trim(),
        artifactFilename: filename,
        artifactFormat: String(artifact.format || artifact.extension || artifact.metadata?.format || '').trim(),
        previewUrl,
        sandboxUrl,
        artifactPreviewUrl: viewportUrl,
        url: viewportUrl,
        updatedAt: new Date().toISOString(),
    };
}

function extractArtifactsFromValue(value, depth = 0) {
    if (depth > 4 || value == null) {
        return [];
    }

    if (Array.isArray(value)) {
        return value.flatMap((entry) => extractArtifactsFromValue(entry, depth + 1));
    }

    if (typeof value !== 'object') {
        return [];
    }

    const artifactLikeDownloadUrl = normalizeUrl(
        value.downloadUrl
        || value.download_url
        || value.inlinePath
        || value.inline_path
        || '',
    );
    const looksLikeArtifact = artifactLikeDownloadUrl
        && /\/api\/artifacts\/.+\/download\b/i.test(artifactLikeDownloadUrl)
        && typeof value.id === 'string'
        && value.id.trim();
    const nested = Object.values(value).flatMap((entry) => extractArtifactsFromValue(entry, depth + 1));

    if (!looksLikeArtifact) {
        return nested;
    }

    return [{
        id: value.id.trim(),
        filename: value.filename || '',
        format: value.format || value.extension || '',
        downloadUrl: artifactLikeDownloadUrl,
        metadata: value.metadata || {},
    }, ...nested];
}

function buildTaskRef({ userText = '', assistantText = '', toolEvents = [], artifacts = [], recordedAt = new Date().toISOString() }) {
    const normalizedToolEvents = Array.isArray(toolEvents) ? toolEvents : [];
    const toolIds = Array.from(new Set(normalizedToolEvents
        .map((event) => event?.toolCall?.function?.name || event?.result?.toolId || '')
        .filter(Boolean)));
    const failed = normalizedToolEvents.some((event) => event?.result?.success === false);
    const summary = sanitizeText(
        assistantText
        || userText
        || (artifacts[0]?.filename ? `Created ${artifacts[0].filename}` : ''),
        220,
    );

    if (!summary) {
        return null;
    }

    return {
        summary,
        status: failed ? 'partial' : 'completed',
        toolIds,
        artifactIds: buildArtifactRefs(artifacts, recordedAt).map((artifact) => artifact.id),
        recordedAt,
    };
}

function buildProjectMemoryUpdate({ userText = '', assistantText = '', toolEvents = [], artifacts = [] }) {
    const capturedAt = new Date().toISOString();
    const derivedArtifacts = (Array.isArray(toolEvents) ? toolEvents : [])
        .flatMap((event) => extractArtifactsFromValue(event?.result?.data));
    const combinedArtifacts = [...(Array.isArray(artifacts) ? artifacts : []), ...derivedArtifacts];
    const urlRefs = [
        ...buildUrlRefs(extractUrlsFromText(userText), 'user', { capturedAt, title: sanitizeText(userText, 120) }),
        ...buildUrlRefs(extractUrlsFromText(assistantText), 'assistant', { capturedAt, title: sanitizeText(assistantText, 120) }),
    ];

    for (const event of Array.isArray(toolEvents) ? toolEvents : []) {
        const toolId = event?.toolCall?.function?.name || event?.result?.toolId || null;
        const reason = sanitizeText(event?.reason || '', 120);
        urlRefs.push(...buildUrlRefs(
            extractUrlsFromValue(event?.result?.data),
            'tool',
            {
                capturedAt,
                toolId,
                title: reason || sanitizeText(toolId || 'tool result', 80),
            },
        ));
    }

    for (const artifact of combinedArtifacts) {
        const downloadUrl = normalizeUrl(artifact?.downloadUrl || '');
        if (downloadUrl) {
            urlRefs.push(...buildUrlRefs([downloadUrl], 'artifact', {
                capturedAt,
                title: artifact.filename || artifact.format || 'generated artifact',
            }));
        }
    }

    const task = buildTaskRef({ userText, assistantText, toolEvents, artifacts: combinedArtifacts, recordedAt: capturedAt });

    return {
        urls: urlRefs,
        artifacts: buildArtifactRefs(combinedArtifacts, capturedAt),
        tasks: task ? [task] : [],
        lastUpdated: capturedAt,
    };
}

function mergeProjectMemory(existing = {}, update = {}) {
    const merged = {
        urls: [],
        artifacts: [],
        tasks: [],
        lastUpdated: update.lastUpdated || existing.lastUpdated || new Date().toISOString(),
    };

    const urlMap = new Map();
    [...(existing.urls || []), ...(update.urls || [])].forEach((entry) => {
        const url = normalizeUrl(entry?.url || '');
        if (!url) {
            return;
        }

        const previous = urlMap.get(url) || {};
        urlMap.set(url, {
            url,
            source: entry?.source || previous.source || 'assistant',
            kind: entry?.kind || previous.kind || inferUrlKind(url),
            title: sanitizeText(entry?.title || previous.title || '', 120),
            toolId: entry?.toolId || previous.toolId || null,
            capturedAt: entry?.capturedAt || previous.capturedAt || merged.lastUpdated,
        });
    });
    merged.urls = Array.from(urlMap.values()).slice(-MAX_PROJECT_URLS);

    const artifactMap = new Map();
    [...(existing.artifacts || []), ...(update.artifacts || [])].forEach((entry) => {
        if (!entry?.id) {
            return;
        }

        artifactMap.set(entry.id, {
            id: entry.id,
            filename: entry.filename || '',
            format: entry.format || '',
            downloadUrl: normalizeUrl(entry.downloadUrl || ''),
            sourcePrompt: sanitizeText(entry.sourcePrompt || '', 160),
            creativeDirection: sanitizeText(entry.creativeDirection || '', 80),
            creativeDirectionId: sanitizeText(entry.creativeDirectionId || '', 64),
            themeSuggestion: sanitizeText(entry.themeSuggestion || '', 40),
            capturedAt: entry.capturedAt || merged.lastUpdated,
        });
    });
    merged.artifacts = Array.from(artifactMap.values()).slice(-MAX_PROJECT_ARTIFACTS);

    const taskMap = new Map();
    [...(existing.tasks || []), ...(update.tasks || [])].forEach((entry) => {
        const summary = sanitizeText(entry?.summary || '', 220);
        if (!summary) {
            return;
        }

        const toolKey = Array.isArray(entry.toolIds) ? entry.toolIds.join(',') : '';
        const key = `${summary.toLowerCase()}::${toolKey}`;
        taskMap.set(key, {
            summary,
            status: entry?.status || 'completed',
            toolIds: Array.isArray(entry?.toolIds) ? entry.toolIds.slice(0, 6) : [],
            artifactIds: Array.isArray(entry?.artifactIds) ? entry.artifactIds.slice(0, 6) : [],
            recordedAt: entry?.recordedAt || merged.lastUpdated,
        });
    });
    merged.tasks = Array.from(taskMap.values()).slice(-MAX_PROJECT_TASKS);

    return merged;
}

function buildProjectMemoryInstructions(session = null) {
    const memory = session?.metadata?.projectMemory;
    if (!memory) {
        return '';
    }

    const lines = [
        '[Project carryover memory]',
        'Reuse these verified project-scoped references, outputs, and completed tasks when the user refers to earlier work, images, research, URLs, or generated files from this same project.',
    ];

    if (Array.isArray(memory.tasks) && memory.tasks.length > 0) {
        lines.push('');
        lines.push('Recent completed tasks:');
        memory.tasks.slice(-6).forEach((task) => {
            const toolSuffix = Array.isArray(task.toolIds) && task.toolIds.length > 0
                ? ` via ${task.toolIds.join(', ')}`
                : '';
            lines.push(`- ${task.summary} [${task.status || 'completed'}${toolSuffix ? toolSuffix : ''}]`);
        });
    }

    if (Array.isArray(memory.urls) && memory.urls.length > 0) {
        const imageUrls = memory.urls
            .filter((entry) => String(entry?.kind || '').trim().toLowerCase() === 'image')
            .slice(-MAX_PROJECT_IMAGE_URL_INSTRUCTIONS);
        const referenceUrls = memory.urls
            .filter((entry) => String(entry?.kind || '').trim().toLowerCase() !== 'image')
            .slice(-MAX_PROJECT_REFERENCE_URL_INSTRUCTIONS);

        if (imageUrls.length > 0) {
            lines.push('');
            lines.push('Remembered image URLs:');
            imageUrls.forEach((entry) => {
                const label = entry.title ? `${entry.title} -> ` : '';
                lines.push(`- ${label}${entry.url}`);
            });
        }

        if (referenceUrls.length > 0) {
            lines.push('');
            lines.push('Remembered URLs:');
            referenceUrls.forEach((entry) => {
                const label = entry.title ? `${entry.title} -> ` : '';
                lines.push(`- ${label}${entry.url}`);
            });
        }
    }

    if (Array.isArray(memory.artifacts) && memory.artifacts.length > 0) {
        lines.push('');
        lines.push('Generated artifacts:');
        lines.push('These are artifact references, not guaranteed local workspace files. Do not use local file tools on them unless the user explicitly provides a readable local path.');
        memory.artifacts.slice(-6).forEach((artifact) => {
            const download = artifact.downloadUrl ? ` -> ${artifact.downloadUrl}` : '';
            const creativeDirection = artifact.creativeDirection ? `, ${artifact.creativeDirection}` : '';
            lines.push(`- ${artifact.filename || artifact.id} (${artifact.format || 'file'}${creativeDirection})${download}`);
        });
    }

    return lines.join('\n');
}

module.exports = {
    extractUrlsFromText,
    extractUrlsFromValue,
    buildProjectMemoryUpdate,
    buildActiveProjectPreviewUpdate,
    mergeProjectMemory,
    buildProjectMemoryInstructions,
};

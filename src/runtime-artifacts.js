const { inferFormat, normalizeFormat } = require('./artifacts/constants');

const INTERNAL_DOWNLOAD_PATH_PATTERN = /\/api\/(?:artifacts|documents)\/[^/?#]+\/download\b/i;
const INTERNAL_PREVIEW_PATH_PATTERN = /\/api\/artifacts\/[^/?#]+\/preview(?:\b|\/)/i;
const INTERNAL_SANDBOX_PATH_PATTERN = /\/api\/artifacts\/[^/?#]+\/sandbox(?:\b|\/)/i;
const INTERNAL_BUNDLE_PATH_PATTERN = /\/api\/artifacts\/[^/?#]+\/bundle\b/i;
const ARTIFACT_RESULT_KEYS = [
    'artifact',
    'artifact_result',
    'artifacts',
    'document',
    'documents',
    'generatedArtifact',
    'generated_artifact',
    'generatedArtifacts',
    'generated_artifacts',
    'sandboxBuild',
    'sandbox_build',
    'video',
    'videoArtifact',
    'video_artifact',
];

function normalizeDownloadUrl(value = '') {
    return normalizeInternalUrl(value, INTERNAL_DOWNLOAD_PATH_PATTERN);
}

function normalizePreviewUrl(value = '') {
    return normalizeInternalUrl(value, INTERNAL_PREVIEW_PATH_PATTERN);
}

function normalizeSandboxUrl(value = '') {
    return normalizeInternalUrl(value, INTERNAL_SANDBOX_PATH_PATTERN);
}

function normalizeBundleDownloadUrl(value = '') {
    return normalizeInternalUrl(value, INTERNAL_BUNDLE_PATH_PATTERN);
}

function normalizeInternalUrl(value = '', pattern = INTERNAL_DOWNLOAD_PATH_PATTERN) {
    const trimmed = String(value || '').trim().replace(/[),.;:!?]+$/g, '');
    if (!trimmed) {
        return null;
    }

    if (trimmed.startsWith('/')) {
        return pattern.test(trimmed) ? trimmed : null;
    }

    try {
        const parsed = new URL(trimmed);
        return pattern.test(parsed.pathname) ? parsed.toString() : null;
    } catch (_error) {
        return null;
    }
}

function buildFallbackDownloadUrl(id = '', type = 'artifact') {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) {
        return null;
    }

    const route = type === 'document' ? 'documents' : 'artifacts';
    return `/api/${route}/${encodeURIComponent(normalizedId)}/download`;
}

function normalizeSizeBytes(value = {}) {
    return Number.isFinite(Number(value.size))
        ? Number(value.size)
        : (Number.isFinite(Number(value.sizeBytes))
            ? Number(value.sizeBytes)
            : (Number.isFinite(Number(value.size_bytes)) ? Number(value.size_bytes) : 0));
}

function normalizeArtifactEntry(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const rawArtifactId = value.id || value.artifactId || value.artifact_id || '';
    const rawDocumentId = value.documentId || value.document_id || '';
    const id = String(rawArtifactId || rawDocumentId || '').trim();
    const downloadUrl = normalizeDownloadUrl(
        value.downloadUrl
        || value.download_url
        || value.inlinePath
        || value.inline_path
        || '',
    ) || buildFallbackDownloadUrl(id, rawArtifactId ? 'artifact' : 'document');

    if (!id || !downloadUrl) {
        return null;
    }

    const filename = String(value.filename || value.name || '').trim();
    const mimeType = String(value.mimeType || value.mime_type || '').trim();
    const format = normalizeFormat(
        value.format
        || value.extension
        || inferFormat(filename, mimeType),
    );
    const size = normalizeSizeBytes(value);
    const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
        ? value.metadata
        : {};
    if (shouldHideArtifactFromDefaultLists({ ...value, metadata })) {
        return null;
    }
    const previewUrl = normalizePreviewUrl(value.previewUrl || value.preview_url || '');
    const sandboxUrl = normalizeSandboxUrl(value.sandboxUrl || value.sandbox_url || '');
    const bundleDownloadUrl = normalizeBundleDownloadUrl(
        value.bundleDownloadUrl
        || value.bundle_download_url
        || '',
    );

    return {
        id,
        filename,
        format: format || '',
        extension: String(value.extension || format || '').trim(),
        mimeType,
        size,
        sizeBytes: size,
        downloadUrl,
        metadata,
        ...(previewUrl ? { previewUrl } : {}),
        ...(sandboxUrl ? { sandboxUrl } : {}),
        ...(bundleDownloadUrl ? { bundleDownloadUrl } : {}),
        ...(value.preview != null ? { preview: value.preview } : {}),
        ...(typeof value.contentPreview === 'string' && value.contentPreview.trim()
            ? { contentPreview: value.contentPreview.trim() }
            : {}),
    };
}

function shouldHideArtifactFromDefaultLists(artifact = null) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        return false;
    }

    const metadata = artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
        ? artifact.metadata
        : {};
    const lifecycle = metadata.artifactLifecycle && typeof metadata.artifactLifecycle === 'object' && !Array.isArray(metadata.artifactLifecycle)
        ? metadata.artifactLifecycle
        : {};

    return artifact.hiddenFromArtifactList === true
        || metadata.hiddenFromArtifactList === true
        || String(lifecycle.state || '').trim().toLowerCase() === 'superseded';
}

function extractArtifactsFromValue(value, depth = 0) {
    if (depth > 4 || value == null) {
        return [];
    }

    if (Array.isArray(value)) {
        return value.flatMap((entry) => extractArtifactsFromValue(entry, depth + 1));
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!/^[\[{]/.test(trimmed)) {
            return [];
        }

        try {
            return extractArtifactsFromValue(JSON.parse(trimmed), depth + 1);
        } catch (_error) {
            return [];
        }
    }

    if (typeof value !== 'object') {
        return [];
    }

    const artifact = normalizeArtifactEntry(value);
    if (artifact) {
        return [artifact];
    }

    return ARTIFACT_RESULT_KEYS
        .flatMap((key) => extractArtifactsFromValue(value[key], depth + 1));
}

function extractArtifactsFromToolEvents(toolEvents = []) {
    return mergeRuntimeArtifacts(
        ...(Array.isArray(toolEvents) ? toolEvents : [])
            .filter((event) => event?.result?.success !== false)
            .map((event) => {
                const data = event?.result?.data;
                const candidates = [
                    data,
                    ...ARTIFACT_RESULT_KEYS.map((key) => data?.[key]),
                ];
                return candidates.flatMap((candidate) => extractArtifactsFromValue(candidate));
            }),
    );
}

function mergeRuntimeArtifacts(...artifactSets) {
    const merged = [];
    const seen = new Set();

    artifactSets.flat().forEach((artifact) => {
        if (!artifact || typeof artifact !== 'object') {
            return;
        }
        if (shouldHideArtifactFromDefaultLists(artifact)) {
            return;
        }

        const normalized = normalizeArtifactEntry(artifact) || {
            ...artifact,
            id: String(artifact.id || '').trim(),
            filename: String(artifact.filename || '').trim(),
            format: normalizeFormat(
                artifact.format
                || artifact.extension
                || inferFormat(artifact.filename, artifact.mimeType),
            ) || '',
            extension: String(artifact.extension || '').trim(),
            mimeType: String(artifact.mimeType || '').trim(),
            downloadUrl: normalizeDownloadUrl(artifact.downloadUrl || artifact.inlinePath || '')
                || buildFallbackDownloadUrl(artifact.id),
            size: normalizeSizeBytes(artifact),
            sizeBytes: normalizeSizeBytes(artifact),
            ...(normalizePreviewUrl(artifact.previewUrl || artifact.preview_url || '')
                ? { previewUrl: normalizePreviewUrl(artifact.previewUrl || artifact.preview_url || '') }
                : {}),
            ...(normalizeSandboxUrl(artifact.sandboxUrl || artifact.sandbox_url || '')
                ? { sandboxUrl: normalizeSandboxUrl(artifact.sandboxUrl || artifact.sandbox_url || '') }
                : {}),
            ...(normalizeBundleDownloadUrl(artifact.bundleDownloadUrl || artifact.bundle_download_url || '')
                ? { bundleDownloadUrl: normalizeBundleDownloadUrl(artifact.bundleDownloadUrl || artifact.bundle_download_url || '') }
                : {}),
        };
        const identity = normalized.id || normalized.downloadUrl || '';
        if (!identity || seen.has(identity)) {
            return;
        }

        seen.add(identity);
        merged.push(normalized);
    });

    return merged;
}

module.exports = {
    extractArtifactsFromToolEvents,
    mergeRuntimeArtifacts,
    shouldHideArtifactFromDefaultLists,
};

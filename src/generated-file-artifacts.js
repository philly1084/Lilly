const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { sanitizeGeneratedFilename } = require('./artifacts/generated-filename');
const { config } = require('./config');

const LOCAL_FILE_ARTIFACT_PREFIX = 'artifact-local-';
const LOCAL_FILE_ARTIFACT_ID_PATTERN = /^artifact-local-[a-z0-9-]+$/i;

function getLocalArtifactDirectory() {
    return path.join(config.persistence?.dataDir || path.resolve(process.cwd(), 'data'), 'generated-artifacts');
}

function buildLocalArtifactId() {
    const unique = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
    return `${LOCAL_FILE_ARTIFACT_PREFIX}${unique}`;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeExtension(extension = '', filename = '') {
    const explicit = String(extension || '').trim().toLowerCase().replace(/^\./, '');
    if (explicit) {
        return explicit;
    }

    const filenameMatch = String(filename || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/i);
    return filenameMatch?.[1] || 'bin';
}

function buildArtifactDownloadPath(artifactId = '') {
    return `/api/artifacts/${artifactId}/download`;
}

function serializeLocalGeneratedArtifact(record = {}) {
    if (!record?.id) {
        return null;
    }

    const extension = normalizeExtension(record.extension, record.filename);
    const hasPreview = extension === 'html' || Boolean(record.previewHtml);
    const metadata = record.metadata || {};
    const siteBundle = metadata.siteBundle || metadata.bundle || null;
    const siteBundleFileCount = Array.isArray(siteBundle?.files)
        ? siteBundle.files.length
        : Number(siteBundle?.fileCount || 0);
    const hasSiteBundle = siteBundleFileCount > 1;

    return {
        id: record.id,
        sessionId: record.sessionId,
        parentArtifactId: record.parentArtifactId || null,
        direction: record.direction || 'generated',
        sourceMode: record.sourceMode || 'chat',
        filename: record.filename,
        extension,
        format: extension,
        mimeType: record.mimeType || 'application/octet-stream',
        sizeBytes: record.sizeBytes || 0,
        sha256: record.sha256 || '',
        extractedText: record.extractedText || '',
        previewHtml: record.previewHtml || '',
        metadata,
        vectorizedAt: null,
        createdAt: record.createdAt || null,
        updatedAt: record.updatedAt || record.createdAt || null,
        downloadUrl: buildArtifactDownloadPath(record.id),
        previewUrl: hasPreview ? `/api/artifacts/${record.id}/preview` : null,
        sandboxUrl: hasPreview ? `/api/artifacts/${record.id}/sandbox` : null,
        bundleDownloadUrl: hasSiteBundle ? `/api/artifacts/${record.id}/bundle` : null,
        preview: hasSiteBundle
            ? {
                type: 'site',
                entry: siteBundle.entry,
                fileCount: siteBundleFileCount,
                url: hasPreview ? `/api/artifacts/${record.id}/sandbox` : null,
            }
            : null,
    };
}

function isLocalGeneratedArtifactId(id = '') {
    return LOCAL_FILE_ARTIFACT_ID_PATTERN.test(String(id || '').trim());
}

async function persistGeneratedArtifactLocally({
    sessionId = '',
    parentArtifactId = null,
    direction = 'generated',
    sourceMode = 'chat',
    filename = '',
    extension = '',
    mimeType = 'application/octet-stream',
    buffer = null,
    extractedText = '',
    previewHtml = '',
    metadata = {},
} = {}) {
    if (!sessionId) {
        throw new Error('A sessionId is required to save a local artifact.');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('A non-empty buffer is required to save a local artifact.');
    }

    const normalizedExtension = normalizeExtension(extension, filename);
    const id = buildLocalArtifactId();
    const createdAt = new Date().toISOString();
    const baseDir = getLocalArtifactDirectory();
    const contentPath = path.join(baseDir, `${id}.${normalizedExtension || 'bin'}`);
    const metadataPath = path.join(baseDir, `${id}.json`);
    const record = {
        id,
        sessionId,
        parentArtifactId,
        direction,
        sourceMode,
        filename: sanitizeGeneratedFilename(filename, normalizedExtension),
        extension: normalizedExtension,
        mimeType,
        sizeBytes: buffer.length,
        sha256: sha256(buffer),
        extractedText: String(extractedText || '').trim(),
        previewHtml: String(previewHtml || ''),
        metadata: {
            ...(metadata || {}),
            storage: 'local-fallback',
        },
        contentPath,
        createdAt,
        updatedAt: createdAt,
    };

    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(contentPath, buffer);
    await fs.writeFile(metadataPath, JSON.stringify(record, null, 2));

    return serializeLocalGeneratedArtifact(record);
}

async function readLocalArtifactRecord(id = '') {
    const normalizedId = String(id || '').trim();
    if (!isLocalGeneratedArtifactId(normalizedId)) {
        return null;
    }

    try {
        const metadataPath = path.join(getLocalArtifactDirectory(), `${normalizedId}.json`);
        const record = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        return record?.id === normalizedId ? record : null;
    } catch (_error) {
        return null;
    }
}

function resolveSafeContentPath(record = {}) {
    const baseDir = path.resolve(getLocalArtifactDirectory());
    const contentPath = path.resolve(String(record.contentPath || ''));
    if (!contentPath.startsWith(`${baseDir}${path.sep}`)) {
        return '';
    }
    return contentPath;
}

async function getLocalGeneratedArtifact(id = '', { includeContent = false } = {}) {
    const record = await readLocalArtifactRecord(id);
    if (!record) {
        return null;
    }

    const artifact = serializeLocalGeneratedArtifact(record);
    if (!artifact) {
        return null;
    }

    if (includeContent) {
        const contentPath = resolveSafeContentPath(record);
        if (!contentPath) {
            return null;
        }
        artifact.contentBuffer = await fs.readFile(contentPath);
    }

    return artifact;
}

async function listLocalGeneratedArtifactsBySession(sessionId = '') {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
        return [];
    }

    let entries = [];
    try {
        entries = await fs.readdir(getLocalArtifactDirectory(), { withFileTypes: true });
    } catch (_error) {
        return [];
    }

    const artifacts = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }

        const id = entry.name.replace(/\.json$/i, '');
        const artifact = await getLocalGeneratedArtifact(id);
        if (artifact?.sessionId === normalizedSessionId) {
            artifacts.push(artifact);
        }
    }

    return artifacts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function deleteLocalGeneratedArtifact(id = '') {
    const record = await readLocalArtifactRecord(id);
    if (!record) {
        return false;
    }

    const contentPath = resolveSafeContentPath(record);
    const metadataPath = path.join(getLocalArtifactDirectory(), `${record.id}.json`);
    await Promise.all([
        contentPath ? fs.rm(contentPath, { force: true }) : Promise.resolve(),
        fs.rm(metadataPath, { force: true }),
    ]);
    return true;
}

async function deleteLocalGeneratedArtifactsBySession(sessionId = '') {
    const artifacts = await listLocalGeneratedArtifactsBySession(sessionId);
    let count = 0;
    for (const artifact of artifacts) {
        if (await deleteLocalGeneratedArtifact(artifact.id)) {
            count += 1;
        }
    }
    return count;
}

module.exports = {
    deleteLocalGeneratedArtifact,
    deleteLocalGeneratedArtifactsBySession,
    getLocalGeneratedArtifact,
    isLocalGeneratedArtifactId,
    listLocalGeneratedArtifactsBySession,
    persistGeneratedArtifactLocally,
    serializeLocalGeneratedArtifact,
};

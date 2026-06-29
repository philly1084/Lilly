const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { artifactService } = require('./artifacts/artifact-service');
const { sanitizeGeneratedFilename } = require('./artifacts/generated-filename');
const { config } = require('./config');
const { sessionStore } = require('./session-store');
const {
    buildArtifactDownloadPath,
    buildArtifactInlinePath,
    toAbsoluteInternalUrl,
} = require('./generated-image-artifacts');

const LOCAL_AUDIO_ARTIFACT_PREFIX = 'audio-local-';
const LOCAL_AUDIO_ARTIFACT_ID_PATTERN = /^audio-local-[a-z0-9-]+$/i;

function getLocalAudioArtifactDirectory() {
    return path.join(config.persistence?.dataDir || path.resolve(process.cwd(), 'data'), 'generated-audio');
}

function extensionForAudioMimeType(mimeType = '') {
    const normalized = String(mimeType || '').trim().toLowerCase();
    if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'mp3';
    if (normalized === 'audio/ogg') return 'ogg';
    return 'wav';
}

function slugifyAudioBase(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
}

function buildGeneratedAudioFilename({
    filename = '',
    title = '',
    text = '',
    extension = 'wav',
} = {}) {
    const explicitFilename = String(filename || '').trim();
    if (explicitFilename) {
        return sanitizeGeneratedFilename(explicitFilename, extension);
    }

    const base = slugifyAudioBase(title)
        || slugifyAudioBase(text.split(/\s+/).slice(0, 8).join(' '))
        || 'generated-audio';

    return sanitizeGeneratedFilename(`${base}.${extension}`, extension);
}

function normalizeGeneratedAudioRecord(artifact = null) {
    if (!artifact?.id) {
        return null;
    }

    const downloadUrl = buildArtifactDownloadPath(artifact.id);
    const inlinePath = buildArtifactInlinePath(artifact.id);

    return {
        artifactId: artifact.id,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        format: artifact.format || artifact.extension,
        downloadUrl,
        inlinePath,
        absoluteUrl: toAbsoluteInternalUrl(downloadUrl),
        absoluteInlineUrl: toAbsoluteInternalUrl(inlinePath),
    };
}

function isLocalGeneratedAudioArtifactId(id = '') {
    return LOCAL_AUDIO_ARTIFACT_ID_PATTERN.test(String(id || '').trim());
}

function buildLocalAudioArtifactId() {
    const unique = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
    return `${LOCAL_AUDIO_ARTIFACT_PREFIX}${unique}`;
}

function serializeLocalGeneratedAudioArtifact(record = {}) {
    if (!record?.id) {
        return null;
    }

    return {
        id: record.id,
        sessionId: record.sessionId,
        direction: record.direction || 'generated',
        sourceMode: record.sourceMode || 'chat',
        filename: record.filename,
        extension: record.extension,
        format: record.extension,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes || 0,
        extractedText: record.extractedText || '',
        previewHtml: '',
        metadata: record.metadata || {},
        downloadUrl: buildArtifactDownloadPath(record.id),
        createdAt: record.createdAt || null,
        updatedAt: record.updatedAt || record.createdAt || null,
    };
}

async function persistGeneratedAudioLocally({
    sessionId = '',
    sourceMode = 'chat',
    text = '',
    title = '',
    filename = '',
    provider = 'piper',
    voice = null,
    audioBuffer = null,
    mimeType = 'audio/wav',
    metadata = {},
} = {}) {
    const extension = extensionForAudioMimeType(mimeType);
    const id = buildLocalAudioArtifactId();
    const createdAt = new Date().toISOString();
    const resolvedFilename = buildGeneratedAudioFilename({
        filename,
        title,
        text,
        extension,
    });
    const baseDir = getLocalAudioArtifactDirectory();
    const audioPath = path.join(baseDir, `${id}.${extension}`);
    const metadataPath = path.join(baseDir, `${id}.json`);
    const record = {
        id,
        sessionId,
        direction: 'generated',
        sourceMode,
        filename: resolvedFilename,
        extension,
        mimeType,
        sizeBytes: audioBuffer.length,
        extractedText: String(text || '').trim(),
        metadata: {
            generatedBy: 'speech-generate',
            provider,
            title: title || '',
            transcript: String(text || '').trim(),
            voice: voice || null,
            ...metadata,
            storage: 'local-fallback',
        },
        audioPath,
        createdAt,
        updatedAt: createdAt,
    };

    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(audioPath, audioBuffer);
    await fs.writeFile(metadataPath, JSON.stringify(record, null, 2));

    return serializeLocalGeneratedAudioArtifact(record);
}

async function getLocalGeneratedAudioArtifact(id = '', { includeContent = false } = {}) {
    const normalizedId = String(id || '').trim();
    if (!isLocalGeneratedAudioArtifactId(normalizedId)) {
        return null;
    }

    const metadataPath = path.join(getLocalAudioArtifactDirectory(), `${normalizedId}.json`);
    let record = null;
    try {
        record = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch (_error) {
        return null;
    }

    if (!record || record.id !== normalizedId) {
        return null;
    }

    const artifact = serializeLocalGeneratedAudioArtifact(record);
    if (!artifact) {
        return null;
    }

    if (includeContent) {
        const baseDir = path.resolve(getLocalAudioArtifactDirectory());
        const audioPath = path.resolve(String(record.audioPath || ''));
        if (!audioPath.startsWith(`${baseDir}${path.sep}`)) {
            return null;
        }
        artifact.contentBuffer = await fs.readFile(audioPath);
    }

    return artifact;
}

async function updateGeneratedAudioSessionState(sessionId = '', artifacts = []) {
    const artifactIds = (Array.isArray(artifacts) ? artifacts : [])
        .map((artifact) => String(artifact?.id || '').trim())
        .filter(Boolean);

    if (!sessionId || artifactIds.length === 0) {
        return null;
    }

    try {
        return await sessionStore.update(sessionId, {
            metadata: {
                lastGeneratedAudioArtifactIds: artifactIds,
            },
        });
    } catch (error) {
        console.warn('[Audio] Failed to update generated audio session state:', error.message);
        return null;
    }
}

async function persistGeneratedAudio({
    sessionId = '',
    sourceMode = 'chat',
    text = '',
    title = '',
    filename = '',
    provider = 'piper',
    voice = null,
    audioBuffer = null,
    mimeType = 'audio/wav',
    metadata = {},
} = {}) {
    if (!sessionId) {
        throw new Error('A sessionId is required to save generated audio.');
    }

    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        throw new Error('Audio buffer is required to save generated audio.');
    }

    const extension = extensionForAudioMimeType(mimeType);
    let artifact = null;
    try {
        const stored = await artifactService.createStoredArtifact({
            sessionId,
            direction: 'generated',
            sourceMode,
            filename: buildGeneratedAudioFilename({
                filename,
                title,
                text,
                extension,
            }),
            extension,
            mimeType,
            buffer: audioBuffer,
            extractedText: String(text || '').trim(),
            previewHtml: '',
            metadata: {
                generatedBy: 'speech-generate',
                provider,
                title: title || '',
                transcript: String(text || '').trim(),
                voice: voice || null,
                ...metadata,
            },
            vectorize: Boolean(String(text || '').trim()),
        });

        artifact = artifactService.serializeArtifact(stored);
    } catch (error) {
        console.warn('[Audio] Artifact storage unavailable; saving generated audio locally:', error.message);
        artifact = await persistGeneratedAudioLocally({
            sessionId,
            sourceMode,
            text,
            title,
            filename,
            provider,
            voice,
            audioBuffer,
            mimeType,
            metadata,
        });
    }

    const normalizedAudio = normalizeGeneratedAudioRecord(artifact);
    await updateGeneratedAudioSessionState(sessionId, [artifact]);

    return {
        artifact,
        audio: normalizedAudio,
        artifactIds: artifact?.id ? [artifact.id] : [],
    };
}

module.exports = {
    buildGeneratedAudioFilename,
    extensionForAudioMimeType,
    getLocalGeneratedAudioArtifact,
    isLocalGeneratedAudioArtifactId,
    normalizeGeneratedAudioRecord,
    persistGeneratedAudio,
    updateGeneratedAudioSessionState,
};

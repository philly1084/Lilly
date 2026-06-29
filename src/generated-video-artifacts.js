const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { sanitizeGeneratedFilename } = require('./artifacts/generated-filename');
const { config } = require('./config');
const { sessionStore } = require('./session-store');
const {
  buildArtifactDownloadPath,
  buildArtifactInlinePath,
  toAbsoluteInternalUrl,
} = require('./generated-image-artifacts');

const LOCAL_VIDEO_ARTIFACT_PREFIX = 'video-local-';
const LOCAL_VIDEO_ARTIFACT_ID_PATTERN = /^video-local-[a-z0-9-]+$/i;

function getLocalVideoArtifactDirectory() {
  return path.join(config.persistence?.dataDir || path.resolve(process.cwd(), 'data'), 'generated-video');
}

function slugifyVideoBase(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
}

function buildGeneratedVideoFilename({ filename = '', title = '' } = {}) {
  const explicitFilename = String(filename || '').trim();
  if (explicitFilename) {
    return sanitizeGeneratedFilename(explicitFilename, 'mp4');
  }

  return sanitizeGeneratedFilename(`${slugifyVideoBase(title) || 'generated-video'}.mp4`, 'mp4');
}

function isLocalGeneratedVideoArtifactId(id = '') {
  return LOCAL_VIDEO_ARTIFACT_ID_PATTERN.test(String(id || '').trim());
}

function buildLocalVideoArtifactId() {
  const unique = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
  return `${LOCAL_VIDEO_ARTIFACT_PREFIX}${unique}`;
}

function serializeLocalGeneratedVideoArtifact(record = {}) {
  if (!record?.id) {
    return null;
  }

  return {
    id: record.id,
    sessionId: record.sessionId,
    direction: record.direction || 'generated',
    sourceMode: record.sourceMode || 'podcast-video',
    filename: record.filename,
    extension: 'mp4',
    format: 'mp4',
    mimeType: record.mimeType || 'video/mp4',
    sizeBytes: record.sizeBytes || 0,
    extractedText: record.extractedText || '',
    previewHtml: '',
    metadata: record.metadata || {},
    downloadUrl: buildArtifactDownloadPath(record.id),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || record.createdAt || null,
  };
}

function normalizeGeneratedVideoRecord(artifact = null) {
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

async function persistGeneratedVideoLocally({
  sessionId = '',
  sourceMode = 'podcast-video',
  title = '',
  filename = '',
  videoBuffer = null,
  extractedText = '',
  metadata = {},
} = {}) {
  const id = buildLocalVideoArtifactId();
  const createdAt = new Date().toISOString();
  const resolvedFilename = buildGeneratedVideoFilename({ filename, title });
  const baseDir = getLocalVideoArtifactDirectory();
  const videoPath = path.join(baseDir, `${id}.mp4`);
  const metadataPath = path.join(baseDir, `${id}.json`);
  const record = {
    id,
    sessionId,
    direction: 'generated',
    sourceMode,
    filename: resolvedFilename,
    extension: 'mp4',
    mimeType: 'video/mp4',
    sizeBytes: videoBuffer.length,
    extractedText: String(extractedText || '').trim(),
    metadata: {
      generatedBy: 'podcast-video',
      title,
      ...metadata,
      storage: 'local-fallback',
    },
    videoPath,
    createdAt,
    updatedAt: createdAt,
  };

  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(videoPath, videoBuffer);
  await fs.writeFile(metadataPath, JSON.stringify(record, null, 2));
  return serializeLocalGeneratedVideoArtifact(record);
}

async function getLocalGeneratedVideoArtifact(id = '', { includeContent = false } = {}) {
  const normalizedId = String(id || '').trim();
  if (!isLocalGeneratedVideoArtifactId(normalizedId)) {
    return null;
  }

  const metadataPath = path.join(getLocalVideoArtifactDirectory(), `${normalizedId}.json`);
  let record = null;
  try {
    record = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  } catch (_error) {
    return null;
  }

  if (!record || record.id !== normalizedId) {
    return null;
  }

  const artifact = serializeLocalGeneratedVideoArtifact(record);
  if (!artifact) {
    return null;
  }

  if (includeContent) {
    const baseDir = path.resolve(getLocalVideoArtifactDirectory());
    const videoPath = path.resolve(String(record.videoPath || ''));
    if (!videoPath.startsWith(`${baseDir}${path.sep}`)) {
      return null;
    }
    artifact.contentBuffer = await fs.readFile(videoPath);
  }

  return artifact;
}

async function updateGeneratedVideoSessionState(sessionId = '', artifacts = []) {
  const artifactIds = (Array.isArray(artifacts) ? artifacts : [])
    .map((artifact) => String(artifact?.id || '').trim())
    .filter(Boolean);

  if (!sessionId || artifactIds.length === 0) {
    return null;
  }

  try {
    return await sessionStore.update(sessionId, {
      metadata: {
        lastGeneratedVideoArtifactIds: artifactIds,
      },
    });
  } catch (error) {
    console.warn('[Video] Failed to update generated video session state:', error.message);
    return null;
  }
}

module.exports = {
  buildGeneratedVideoFilename,
  getLocalGeneratedVideoArtifact,
  isLocalGeneratedVideoArtifactId,
  normalizeGeneratedVideoRecord,
  persistGeneratedVideoLocally,
  updateGeneratedVideoSessionState,
};

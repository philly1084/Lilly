'use strict';

const crypto = require('crypto');
const {
  sanitizeContextFilename,
} = require('../remote-runner/protocol');
const { resolvePiiPolicy } = require('../pii');

const REMOTE_AGENT_HANDOFF_VERSION = 'RemoteAgentHandoff/v1';
const REMOTE_AGENT_RESULT_FILES_VERSION = 'RemoteAgentResultFiles/v1';
const MAX_REMOTE_AGENT_ARTIFACTS = 12;
const MAX_REMOTE_AGENT_FILES = 12;
const MAX_REMOTE_AGENT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_AGENT_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_REMOTE_AGENT_MIME_TYPE_LENGTH = 256;
const MAX_REMOTE_AGENT_SOURCE_LENGTH = 64;
const MAX_REMOTE_AGENT_SOURCE_URL_LENGTH = 2048;
const MAX_REMOTE_AGENT_ARTIFACT_ID_LENGTH = 256;
const MAX_REMOTE_AGENT_DESCRIPTION_LENGTH = 2000;
const MAX_REMOTE_AGENT_GLOB_LENGTH = 512;
const REMOTE_AGENT_RUNS_ROOT = '.kimibuilt/agent-runs';
const RESERVED_INPUT_FILENAMES = new Set(['manifest.json']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function uniqueText(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeText(value))
      .filter(Boolean),
  ));
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return /^(?:1|true|yes|on|enabled)$/i.test(String(value).trim());
}

function createHandoffError(message, code = 'REMOTE_AGENT_HANDOFF_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBoundedText(value, label, maxLength, fallback = '') {
  const normalized = normalizeText(value || fallback);
  if (normalized.length > maxLength) {
    throw createHandoffError(
      `Remote agent handoff ${label} exceeds ${maxLength} characters.`,
      'REMOTE_AGENT_HANDOFF_FIELD_TOO_LONG',
    );
  }
  return normalized;
}

function isArtifactPrivacyExportRestricted(artifact = {}, context = {}) {
  if (normalizeText(artifact?.direction).toLowerCase() !== 'uploaded') {
    return false;
  }
  const metadata = artifact?.metadata && typeof artifact.metadata === 'object'
    && !Array.isArray(artifact.metadata)
    ? artifact.metadata
    : {};
  const piiMetadata = metadata.piiCleansing && typeof metadata.piiCleansing === 'object'
    && !Array.isArray(metadata.piiCleansing)
    ? metadata.piiCleansing
    : {};
  if (metadata.privacyPreviewSuppressed === true
    || piiMetadata.enabled === true
    || piiMetadata.uploadPreviewSuppressed === true) {
    return true;
  }

  try {
    const clientSurface = normalizeText(context?.clientSurface) || 'web-chat';
    return resolvePiiPolicy({
      metadata: {
        ...(context?.session?.metadata && typeof context.session.metadata === 'object'
          ? context.session.metadata
          : {}),
        ...metadata,
        clientSurface,
      },
      clientSurface,
      route: '/api/tools/remote-cli-agent',
    }).enabled === true;
  } catch (_error) {
    return true;
  }
}

function assertArtifactPrivacyExportAllowed(artifact = {}, artifactId = '', context = {}) {
  if (!isArtifactPrivacyExportRestricted(artifact, context)) {
    return;
  }
  throw createHandoffError(
    `Remote agent input artifact ${artifactId || artifact.id || '(unknown)'} is protected by the active PII privacy policy and cannot be exported to a remote CLI provider.`,
    'REMOTE_AGENT_HANDOFF_ARTIFACT_PRIVACY_RESTRICTED',
  );
}

function decodeBase64Strict(value = '', filename = 'context file') {
  const compact = String(value || '').replace(/\s+/g, '');
  if (!compact
    || compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw createHandoffError(
      `Remote agent handoff file ${filename} contains invalid base64 content.`,
      'REMOTE_AGENT_HANDOFF_INVALID_BASE64',
    );
  }
  return Buffer.from(compact, 'base64');
}

function normalizeRelativeWorkspacePath(value = '', fallback = '') {
  const source = normalizeText(value || fallback).replace(/\\/g, '/');
  if (!source || source.startsWith('/') || /^[a-z]:\//i.test(source)) {
    throw createHandoffError(
      `Remote agent handoff path must be workspace-relative: ${source || '(empty)'}.`,
      'REMOTE_AGENT_HANDOFF_UNSAFE_PATH',
    );
  }

  const segments = source.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw createHandoffError(
      `Remote agent handoff path escapes the workspace: ${source}.`,
      'REMOTE_AGENT_HANDOFF_UNSAFE_PATH',
    );
  }
  return segments.join('/');
}

function normalizeResultFileGlobs(value = []) {
  if (!Array.isArray(value)) {
    throw createHandoffError('Remote agent resultFileGlobs must be an array.');
  }
  const entries = uniqueText(value);
  if (entries.length > MAX_REMOTE_AGENT_FILES) {
    throw createHandoffError(
      `Remote agent handoff accepts at most ${MAX_REMOTE_AGENT_FILES} result file globs.`,
      'REMOTE_AGENT_HANDOFF_TOO_MANY_GLOBS',
    );
  }
  return entries.map((entry) => normalizeRelativeWorkspacePath(
    normalizeBoundedText(entry, 'result file glob', MAX_REMOTE_AGENT_GLOB_LENGTH),
  ));
}

function normalizeHandoffFiles(entries = []) {
  if (!Array.isArray(entries)) {
    throw createHandoffError('Remote agent contextFiles must be an array.');
  }
  if (entries.length > MAX_REMOTE_AGENT_FILES) {
    throw createHandoffError(
      `Remote agent handoff accepts at most ${MAX_REMOTE_AGENT_FILES} files.`,
      'REMOTE_AGENT_HANDOFF_TOO_MANY_FILES',
    );
  }

  const normalized = [];
  const filenames = new Set();
  let totalBytes = 0;

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw createHandoffError(`Remote agent handoff file ${index + 1} must be an object.`);
    }

    const filename = sanitizeContextFilename(
      entry.filename || entry.name || entry.path,
      `context-${index + 1}.bin`,
    );
    const filenameKey = filename.toLowerCase();
    if (RESERVED_INPUT_FILENAMES.has(filenameKey)) {
      throw createHandoffError(
        `Remote agent handoff filename ${filename} is reserved for gateway metadata.`,
        'REMOTE_AGENT_HANDOFF_RESERVED_FILENAME',
      );
    }
    if (filenames.has(filenameKey)) {
      throw createHandoffError(
        `Remote agent handoff contains duplicate filename ${filename}.`,
        'REMOTE_AGENT_HANDOFF_DUPLICATE_FILE',
      );
    }

    const hasBase64 = Boolean(normalizeText(entry.contentBase64 || entry.base64 || entry.dataBase64));
    const hasText = Object.prototype.hasOwnProperty.call(entry, 'content');
    if (!hasBase64 && !hasText) {
      throw createHandoffError(`Remote agent handoff file ${filename} has no content.`);
    }

    const buffer = hasBase64
      ? decodeBase64Strict(entry.contentBase64 || entry.base64 || entry.dataBase64, filename)
      : Buffer.from(String(entry.content ?? ''), 'utf8');
    if (buffer.length <= 0) {
      throw createHandoffError(`Remote agent handoff file ${filename} is empty.`);
    }
    if (buffer.length > MAX_REMOTE_AGENT_FILE_BYTES) {
      throw createHandoffError(
        `Remote agent handoff file ${filename} exceeds ${MAX_REMOTE_AGENT_FILE_BYTES} bytes.`,
        'REMOTE_AGENT_HANDOFF_FILE_TOO_LARGE',
      );
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_REMOTE_AGENT_TOTAL_BYTES) {
      throw createHandoffError(
        `Remote agent handoff exceeds ${MAX_REMOTE_AGENT_TOTAL_BYTES} total bytes.`,
        'REMOTE_AGENT_HANDOFF_TOO_LARGE',
      );
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const expectedSha256 = normalizeText(entry.sha256).toLowerCase();
    if (expectedSha256 && expectedSha256 !== sha256) {
      throw createHandoffError(
        `Remote agent handoff checksum mismatch for ${filename}.`,
        'REMOTE_AGENT_HANDOFF_CHECKSUM_MISMATCH',
      );
    }

    filenames.add(filenameKey);
    normalized.push({
      filename,
      mimeType: normalizeBoundedText(
        entry.mimeType || entry.contentType,
        `mimeType for ${filename}`,
        MAX_REMOTE_AGENT_MIME_TYPE_LENGTH,
        'application/octet-stream',
      ),
      sizeBytes: buffer.length,
      sha256,
      contentBase64: buffer.toString('base64'),
      source: normalizeBoundedText(entry.source, `source for ${filename}`, MAX_REMOTE_AGENT_SOURCE_LENGTH),
      sourceUrl: normalizeBoundedText(entry.sourceUrl || entry.url, `sourceUrl for ${filename}`, MAX_REMOTE_AGENT_SOURCE_URL_LENGTH),
      artifactId: normalizeBoundedText(entry.artifactId, `artifactId for ${filename}`, MAX_REMOTE_AGENT_ARTIFACT_ID_LENGTH),
      description: normalizeBoundedText(entry.description || entry.label, `description for ${filename}`, MAX_REMOTE_AGENT_DESCRIPTION_LENGTH),
    });
  });

  return normalized;
}

async function resolveArtifactContextFiles(artifactIds = [], context = {}, artifactService = null) {
  const requestedIds = uniqueText(artifactIds);
  if (requestedIds.length > MAX_REMOTE_AGENT_ARTIFACTS) {
    throw createHandoffError(
      `Remote agent handoff accepts at most ${MAX_REMOTE_AGENT_ARTIFACTS} artifact IDs.`,
      'REMOTE_AGENT_HANDOFF_TOO_MANY_ARTIFACTS',
    );
  }
  if (requestedIds.length === 0) {
    return [];
  }
  if (!artifactService || typeof artifactService.getArtifact !== 'function') {
    throw createHandoffError(
      'Artifact storage is unavailable for the remote agent handoff.',
      'REMOTE_AGENT_HANDOFF_ARTIFACT_STORE_UNAVAILABLE',
    );
  }

  const contextSessionId = normalizeText(context?.sessionId);
  if (!contextSessionId) {
    throw createHandoffError(
      'Remote agent artifact handoff requires an active session for ownership verification.',
      'REMOTE_AGENT_HANDOFF_SESSION_REQUIRED',
    );
  }
  const files = [];
  let totalBytes = 0;
  for (const artifactId of requestedIds) {
    normalizeBoundedText(
      artifactId,
      'source artifact ID',
      MAX_REMOTE_AGENT_ARTIFACT_ID_LENGTH,
    );
    let descriptor = null;
    try {
      descriptor = await artifactService.getArtifact(artifactId);
    } catch (error) {
      throw createHandoffError(
        `Unable to load remote agent input artifact ${artifactId}: ${error.message}`,
        'REMOTE_AGENT_HANDOFF_ARTIFACT_UNAVAILABLE',
      );
    }
    if (!descriptor) {
      throw createHandoffError(
        `Remote agent input artifact ${artifactId} is unavailable.`,
        'REMOTE_AGENT_HANDOFF_ARTIFACT_EMPTY',
      );
    }
    if (!descriptor.sessionId || descriptor.sessionId !== contextSessionId) {
      throw createHandoffError(
        `Remote agent input artifact ${artifactId} does not belong to the active session.`,
        'REMOTE_AGENT_HANDOFF_ARTIFACT_SCOPE_MISMATCH',
      );
    }
    assertArtifactPrivacyExportAllowed(descriptor, artifactId, context);
    const declaredSize = Number(descriptor.sizeBytes || 0);
    if (declaredSize > MAX_REMOTE_AGENT_FILE_BYTES) {
      throw createHandoffError(
        `Remote agent input artifact ${artifactId} exceeds ${MAX_REMOTE_AGENT_FILE_BYTES} bytes.`,
        'REMOTE_AGENT_HANDOFF_FILE_TOO_LARGE',
      );
    }
    if (declaredSize > 0 && totalBytes + declaredSize > MAX_REMOTE_AGENT_TOTAL_BYTES) {
      throw createHandoffError(
        `Remote agent handoff exceeds ${MAX_REMOTE_AGENT_TOTAL_BYTES} total bytes.`,
        'REMOTE_AGENT_HANDOFF_TOO_LARGE',
      );
    }

    let artifact = null;
    try {
      artifact = await artifactService.getArtifact(artifactId, { includeContent: true });
    } catch (error) {
      throw createHandoffError(
        `Unable to load remote agent input artifact ${artifactId}: ${error.message}`,
        'REMOTE_AGENT_HANDOFF_ARTIFACT_UNAVAILABLE',
      );
    }
    if (!artifact?.contentBuffer?.length) {
      throw createHandoffError(
        `Remote agent input artifact ${artifactId} has no stored content.`,
        'REMOTE_AGENT_HANDOFF_ARTIFACT_EMPTY',
      );
    }
    if (!artifact.sessionId || artifact.sessionId !== contextSessionId) {
      throw createHandoffError(
        `Remote agent input artifact ${artifactId} does not belong to the active session.`,
        'REMOTE_AGENT_HANDOFF_ARTIFACT_SCOPE_MISMATCH',
      );
    }
    assertArtifactPrivacyExportAllowed(artifact, artifactId, context);
    if (artifact.contentBuffer.length > MAX_REMOTE_AGENT_FILE_BYTES) {
      throw createHandoffError(
        `Remote agent input artifact ${artifactId} exceeds ${MAX_REMOTE_AGENT_FILE_BYTES} bytes.`,
        'REMOTE_AGENT_HANDOFF_FILE_TOO_LARGE',
      );
    }
    totalBytes += artifact.contentBuffer.length;
    if (totalBytes > MAX_REMOTE_AGENT_TOTAL_BYTES) {
      throw createHandoffError(
        `Remote agent handoff exceeds ${MAX_REMOTE_AGENT_TOTAL_BYTES} total bytes.`,
        'REMOTE_AGENT_HANDOFF_TOO_LARGE',
      );
    }

    const originalRelativePath = normalizeText(artifact.metadata?.remoteRelativePath);
    const originalPathDescription = originalRelativePath
      ? `Original relative path: ${originalRelativePath}.`
      : '';
    const artifactDescription = normalizeText(
      artifact.metadata?.title || artifact.metadata?.altText || artifact.filename,
    );
    files.push({
      filename: sanitizeContextFilename(artifact.filename || `${artifact.id}.bin`, `${artifactId}.bin`),
      mimeType: artifact.mimeType || 'application/octet-stream',
      contentBase64: Buffer.from(artifact.contentBuffer).toString('base64'),
      source: 'artifact',
      artifactId: artifact.id,
      sha256: artifact.sha256 || '',
      description: [originalPathDescription, artifactDescription].filter(Boolean).join(' '),
    });
  }
  return files;
}

async function createRemoteAgentHandoff(params = {}, context = {}, options = {}) {
  const artifactIds = uniqueText([
    ...(Array.isArray(params.artifactIds) ? params.artifactIds : []),
    ...(Array.isArray(params.artifact_ids) ? params.artifact_ids : []),
  ]);
  const inlineFiles = Array.isArray(params.contextFiles) ? params.contextFiles : [];
  const resultFileGlobs = normalizeResultFileGlobs(
    params.resultFileGlobs || params.result_file_globs || [],
  );
  const collectResultFiles = normalizeBoolean(
    params.collectResultFiles ?? params.collect_result_files,
    artifactIds.length > 0 || inlineFiles.length > 0 || resultFileGlobs.length > 0,
  );
  if (artifactIds.length === 0 && inlineFiles.length === 0 && !collectResultFiles) {
    return null;
  }
  if (collectResultFiles && !normalizeText(context?.sessionId)) {
    throw createHandoffError(
      'Remote agent result file collection requires an active session before the remote run starts.',
      'REMOTE_AGENT_HANDOFF_SESSION_REQUIRED',
    );
  }

  const artifactFiles = await resolveArtifactContextFiles(
    artifactIds,
    context,
    options.artifactService,
  );
  const files = normalizeHandoffFiles([
    ...inlineFiles,
    ...artifactFiles,
  ]);
  const operationId = normalizeText(options.operationId || crypto.randomUUID());
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/i.test(operationId)) {
    throw createHandoffError(
      'Remote agent handoff operationId is invalid.',
      'REMOTE_AGENT_HANDOFF_OPERATION_ID_INVALID',
    );
  }
  const runDirectory = `${REMOTE_AGENT_RUNS_ROOT}/${operationId}`;
  const contextDirectory = `${runDirectory}/input`;
  const resultDirectory = `${runDirectory}/output`;
  const resultManifestPath = `${resultDirectory}/manifest.json`;

  return {
    version: REMOTE_AGENT_HANDOFF_VERSION,
    operationId,
    runDirectory,
    contextDirectory,
    manifestPath: `${contextDirectory}/manifest.json`,
    sourceArtifactIds: artifactIds,
    files,
    output: {
      version: REMOTE_AGENT_RESULT_FILES_VERSION,
      enabled: collectResultFiles,
      directory: resultDirectory,
      filesDirectory: `${resultDirectory}/files`,
      manifestPath: resultManifestPath,
      requestedGlobs: resultFileGlobs,
      maxFiles: MAX_REMOTE_AGENT_FILES,
      maxFileBytes: MAX_REMOTE_AGENT_FILE_BYTES,
      maxTotalBytes: MAX_REMOTE_AGENT_TOTAL_BYTES,
    },
  };
}

// Persist only the operation contract for polling; never keep or resend input
// file bytes in a workload cursor. Paths are derived, not inherited from text.
function normalizeRemoteAgentHandoffContinuation(handoff = null) {
  if (!handoff || handoff.version !== REMOTE_AGENT_HANDOFF_VERSION
    || !/^[a-z0-9][a-z0-9-]{7,79}$/i.test(String(handoff.operationId || ''))
    || handoff.output?.version !== REMOTE_AGENT_RESULT_FILES_VERSION) return null;
  const operationId = handoff.operationId;
  const runDirectory = `${REMOTE_AGENT_RUNS_ROOT}/${operationId}`;
  const contextDirectory = `${runDirectory}/input`;
  const directory = `${runDirectory}/output`;
  const paths = { runDirectory, contextDirectory, manifestPath: `${contextDirectory}/manifest.json` };
  const outputPaths = { directory, filesDirectory: `${directory}/files`, manifestPath: `${directory}/manifest.json` };
  if (Object.entries(paths).some(([key, value]) => handoff[key] !== value)
    || Object.entries(outputPaths).some(([key, value]) => handoff.output[key] !== value)) return null;
  try {
    return {
      version: REMOTE_AGENT_HANDOFF_VERSION,
      operationId,
      ...paths,
      sourceArtifactIds: uniqueText(handoff.sourceArtifactIds).slice(0, MAX_REMOTE_AGENT_ARTIFACTS),
      files: [],
      output: {
        version: REMOTE_AGENT_RESULT_FILES_VERSION,
        enabled: handoff.output.enabled === true,
        ...outputPaths,
        requestedGlobs: normalizeResultFileGlobs(handoff.output.requestedGlobs || []),
        maxFiles: MAX_REMOTE_AGENT_FILES,
        maxFileBytes: MAX_REMOTE_AGENT_FILE_BYTES,
        maxTotalBytes: MAX_REMOTE_AGENT_TOTAL_BYTES,
      },
    };
  } catch (_) {
    return null;
  }
}

function buildRemoteAgentHandoffPrompt(handoff = null) {
  if (!handoff || handoff.version !== REMOTE_AGENT_HANDOFF_VERSION) {
    return '';
  }
  const fileSummary = (Array.isArray(handoff.files) ? handoff.files : [])
    .map((file) => `  - ${file.filename} (${file.mimeType}, ${file.sizeBytes} bytes, sha256 ${file.sha256})`)
    .join('\n');
  const requestedGlobs = Array.isArray(handoff.output?.requestedGlobs)
    ? handoff.output.requestedGlobs.join(', ')
    : '';

  return [
    'Remote agent artifact handoff:',
    `- Contract: ${REMOTE_AGENT_HANDOFF_VERSION}. The gateway stages approved inputs below the workspace and writes ${handoff.manifestPath}.`,
    `- ${handoff.runDirectory} is gateway scratch space. Never git-add, commit, publish, or deploy anything under it.`,
    `- Read ${handoff.manifestPath} before editing. When the runtime exports KIMIBUILT_CONTEXT_MANIFEST, it points to the same manifest.`,
    fileSummary ? '- Staged inputs:' : '- No input files were selected for this run.',
    fileSummary,
    handoff.output?.enabled
      ? `- Put only files that should return to KimiBuilt under ${handoff.output.filesDirectory}. Before finishing, write ${handoff.output.manifestPath} using contract ${REMOTE_AGENT_RESULT_FILES_VERSION}.`
      : '- No result-file collection was requested for this run.',
    handoff.output?.enabled ? '- The result manifest must be JSON with a files array. Each entry uses workspace-relative path, role, mimeType, and description. Never include paths outside the isolated output/files directory or symlinks.' : '',
    handoff.output?.enabled ? '- To return one complete previewable website, put the whole static site under one directory, name its entry index.html with role "site-entry", and mark every other website member "site-file". Use other roles for QA reports, editable source, or unrelated XML/SVG deliverables so they are not packed into the site.' : '',
    handoff.output?.enabled && requestedGlobs ? `- Requested output patterns: ${requestedGlobs}.` : '',
    handoff.output?.enabled && !requestedGlobs ? '- Include the source, preview, document, SVG/image, and QA files that should return to KimiBuilt.' : '',
    handoff.output?.enabled ? `- Finish with RESULT_FILES_MANIFEST=${handoff.output.manifestPath}.` : '',
  ].filter(Boolean).join('\n');
}

function normalizeRemoteAgentResultFiles(payload = null, handoff = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createHandoffError(
      'Remote agent result files response must be an object.',
      'REMOTE_AGENT_RESULT_FILES_INVALID',
    );
  }
  if (!handoff?.output?.enabled) {
    throw createHandoffError(
      'Remote agent result files were not requested for this run.',
      'REMOTE_AGENT_RESULT_FILES_NOT_REQUESTED',
    );
  }
  if (normalizeText(payload.version) !== REMOTE_AGENT_RESULT_FILES_VERSION) {
    throw createHandoffError(
      `Remote agent result files contract must be ${REMOTE_AGENT_RESULT_FILES_VERSION}.`,
      'REMOTE_AGENT_RESULT_FILES_VERSION_MISMATCH',
    );
  }
  if (payload.gatewayVerified !== true) {
    throw createHandoffError(
      'Remote agent result files were not verified by the gateway.',
      'REMOTE_AGENT_RESULT_FILES_UNVERIFIED',
    );
  }
  if (normalizeText(payload.operationId) !== normalizeText(handoff.operationId)) {
    throw createHandoffError(
      'Remote agent result files operationId does not match the requested handoff.',
      'REMOTE_AGENT_RESULT_FILES_OPERATION_MISMATCH',
    );
  }
  const manifestPath = normalizeRelativeWorkspacePath(payload.manifestPath);
  if (manifestPath !== handoff.output.manifestPath) {
    throw createHandoffError(
      'Remote agent result manifest path does not match the isolated handoff path.',
      'REMOTE_AGENT_RESULT_FILES_MANIFEST_MISMATCH',
    );
  }
  if (!Array.isArray(payload.files)) {
    throw createHandoffError(
      'Remote agent result files response must include a files array.',
      'REMOTE_AGENT_RESULT_FILES_INVALID',
    );
  }
  if (payload.files.length > MAX_REMOTE_AGENT_FILES) {
    throw createHandoffError(
      `Remote agent result files accepts at most ${MAX_REMOTE_AGENT_FILES} files.`,
      'REMOTE_AGENT_RESULT_FILES_TOO_MANY',
    );
  }

  const outputPrefix = `${handoff.output.filesDirectory}/`;
  const seenPaths = new Set();
  let totalBytes = 0;
  const files = payload.files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw createHandoffError(
        `Remote agent result file ${index + 1} must be an object.`,
        'REMOTE_AGENT_RESULT_FILES_INVALID',
      );
    }
    const remotePath = normalizeRelativeWorkspacePath(
      entry.path || entry.relativePath || entry.filename,
    );
    if (!remotePath.startsWith(outputPrefix)) {
      throw createHandoffError(
        `Remote agent result file ${remotePath} is outside the isolated output files directory.`,
        'REMOTE_AGENT_RESULT_FILES_UNSAFE_PATH',
      );
    }
    const pathKey = remotePath.toLowerCase();
    if (seenPaths.has(pathKey)) {
      throw createHandoffError(
        `Remote agent result files contains duplicate path ${remotePath}.`,
        'REMOTE_AGENT_RESULT_FILES_DUPLICATE_PATH',
      );
    }

    const buffer = decodeBase64Strict(
      entry.contentBase64 || entry.base64 || entry.dataBase64,
      remotePath,
    );
    if (buffer.length <= 0) {
      throw createHandoffError(
        `Remote agent result file ${remotePath} is empty.`,
        'REMOTE_AGENT_RESULT_FILES_EMPTY',
      );
    }
    if (buffer.length > MAX_REMOTE_AGENT_FILE_BYTES) {
      throw createHandoffError(
        `Remote agent result file ${remotePath} exceeds ${MAX_REMOTE_AGENT_FILE_BYTES} bytes.`,
        'REMOTE_AGENT_RESULT_FILES_FILE_TOO_LARGE',
      );
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_REMOTE_AGENT_TOTAL_BYTES) {
      throw createHandoffError(
        `Remote agent result files exceeds ${MAX_REMOTE_AGENT_TOTAL_BYTES} total bytes.`,
        'REMOTE_AGENT_RESULT_FILES_TOO_LARGE',
      );
    }

    const declaredSize = Number(entry.sizeBytes);
    if (!Number.isSafeInteger(declaredSize) || declaredSize !== buffer.length) {
      throw createHandoffError(
        `Remote agent result file ${remotePath} has an invalid size attestation.`,
        'REMOTE_AGENT_RESULT_FILES_SIZE_MISMATCH',
      );
    }
    const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const declaredSha256 = normalizeText(entry.sha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(declaredSha256) || declaredSha256 !== actualSha256) {
      throw createHandoffError(
        `Remote agent result file ${remotePath} has an invalid checksum attestation.`,
        'REMOTE_AGENT_RESULT_FILES_CHECKSUM_MISMATCH',
      );
    }

    seenPaths.add(pathKey);
    return {
      path: remotePath,
      filename: sanitizeContextFilename(entry.filename || remotePath, `result-${index + 1}.bin`),
      role: normalizeText(entry.role) || 'deliverable',
      mimeType: normalizeText(entry.mimeType || entry.contentType) || 'application/octet-stream',
      description: normalizeText(entry.description || entry.label),
      sizeBytes: buffer.length,
      sha256: actualSha256,
      contentBase64: buffer.toString('base64'),
    };
  });

  return {
    version: REMOTE_AGENT_RESULT_FILES_VERSION,
    gatewayVerified: true,
    operationId: handoff.operationId,
    manifestPath,
    files,
  };
}

module.exports = {
  MAX_REMOTE_AGENT_ARTIFACTS,
  MAX_REMOTE_AGENT_FILES,
  MAX_REMOTE_AGENT_FILE_BYTES,
  MAX_REMOTE_AGENT_TOTAL_BYTES,
  REMOTE_AGENT_RUNS_ROOT,
  REMOTE_AGENT_HANDOFF_VERSION,
  REMOTE_AGENT_RESULT_FILES_VERSION,
  buildRemoteAgentHandoffPrompt,
  createRemoteAgentHandoff,
  normalizeHandoffFiles,
  normalizeRemoteAgentHandoffContinuation,
  normalizeRelativeWorkspacePath,
  normalizeRemoteAgentResultFiles,
  resolveArtifactContextFiles,
};

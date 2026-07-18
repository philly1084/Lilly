'use strict';

const crypto = require('crypto');
const path = require('path');
const { normalizeRemoteAgentResultFiles } = require('./agent-handoff');
const { sanitizeContextFilename } = require('../remote-runner/protocol');

const TEXT_EXTENSION_PATTERN = /^(?:css|csv|htm|html|js|json|jsx|md|mjs|svg|ts|tsx|txt|xml|yaml|yml)$/i;
const MAX_EXTRACTED_TEXT_BYTES = 256 * 1024;
const MAX_HTML_PREVIEW_BYTES = 2 * 1024 * 1024;

function resolveRemoteRelativeResultPath(file = {}, handoff = null) {
  const prefix = `${String(handoff?.output?.filesDirectory || '').replace(/\/+$/g, '')}/`;
  const remotePath = String(file.path || '').replace(/\\/g, '/');
  return prefix && remotePath.startsWith(prefix)
    ? remotePath.slice(prefix.length)
    : path.posix.basename(remotePath || file.filename || 'result.bin');
}

function buildStoredResultFilename(file = {}, handoff = null) {
  const relativePath = resolveRemoteRelativeResultPath(file, handoff);
  const basename = path.posix.basename(relativePath) || file.filename || 'result.bin';
  if (!relativePath.includes('/')) {
    return sanitizeContextFilename(basename, 'result.bin');
  }

  const safeBasename = sanitizeContextFilename(basename, 'result.bin');
  const rawExtension = path.posix.extname(basename);
  const extension = path.posix.extname(safeBasename).slice(0, 24);
  const withoutExtension = rawExtension
    ? relativePath.slice(0, -rawExtension.length)
    : relativePath;
  const readableStem = sanitizeContextFilename(
    withoutExtension.replace(/\//g, '-'),
    'result',
  ).replace(/\.+$/g, '') || 'result';
  const digest = crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 10);
  const maxStemLength = Math.max(1, 160 - extension.length - digest.length - 1);
  return `${readableStem.slice(0, maxStemLength)}-${digest}${extension}`;
}

function isTextResultFile(file = {}) {
  const extension = path.extname(String(file.filename || '')).slice(1);
  return /^text\//i.test(String(file.mimeType || ''))
    || /(?:json|javascript|xml|svg\+xml|yaml)/i.test(String(file.mimeType || ''))
    || TEXT_EXTENSION_PATTERN.test(extension);
}

function buildArtifactPreview(file = {}, buffer = Buffer.alloc(0)) {
  if (!isTextResultFile(file)) {
    return { extractedText: '', previewHtml: '' };
  }
  const content = buffer.toString('utf8');
  const extractedText = Buffer.byteLength(content) <= MAX_EXTRACTED_TEXT_BYTES
    ? content
    : `${content.slice(0, MAX_EXTRACTED_TEXT_BYTES)}\n[preview truncated]`;
  const isHtml = /(?:^|\/)html$/i.test(String(file.mimeType || ''))
    || /\.html?$/i.test(String(file.filename || ''));
  return {
    extractedText,
    previewHtml: isHtml && buffer.length <= MAX_HTML_PREVIEW_BYTES ? content : '',
  };
}

async function persistRemoteAgentResultArtifacts({
  resultFiles = null,
  handoff = null,
  artifactService = null,
  context = {},
  runResult = {},
} = {}) {
  const normalized = normalizeRemoteAgentResultFiles(resultFiles, handoff);
  const sessionId = String(context?.sessionId || '').trim();
  if (!sessionId) {
    const error = new Error('Remote agent result artifacts require an active session.');
    error.code = 'REMOTE_AGENT_RESULT_ARTIFACT_SESSION_REQUIRED';
    throw error;
  }
  if (!artifactService || typeof artifactService.createStoredArtifact !== 'function') {
    const error = new Error('Artifact storage is unavailable for remote agent result files.');
    error.code = 'REMOTE_AGENT_RESULT_ARTIFACT_STORE_UNAVAILABLE';
    throw error;
  }

  const storedArtifacts = [];
  try {
    for (const file of normalized.files) {
      const buffer = Buffer.from(file.contentBase64, 'base64');
      const remoteRelativePath = resolveRemoteRelativeResultPath(file, handoff);
      const storedFilename = buildStoredResultFilename(file, handoff);
      const extension = path.extname(storedFilename).slice(1).toLowerCase() || 'bin';
      const preview = buildArtifactPreview(file, buffer);
      const stored = await artifactService.createStoredArtifact({
        sessionId,
        session: context?.session || null,
        parentArtifactId: handoff.sourceArtifactIds?.[0] || null,
        direction: 'generated',
        sourceMode: 'remote-cli-agent',
        filename: storedFilename,
        extension,
        mimeType: file.mimeType,
        buffer,
        extractedText: preview.extractedText,
        previewHtml: preview.previewHtml,
        metadata: {
          createdByAgentTool: true,
          toolId: 'remote-cli-agent',
          role: file.role,
          description: file.description,
          remotePath: file.path,
          remoteRelativePath,
          originalFilename: file.filename,
          sha256: file.sha256,
          remoteAgentHandoff: {
            version: handoff.version,
            operationId: handoff.operationId,
            resultVersion: normalized.version,
            resultManifestPath: normalized.manifestPath,
            sourceArtifactIds: handoff.sourceArtifactIds || [],
            transport: runResult.transport || null,
            providerId: runResult.providerId || null,
            targetId: runResult.targetId || null,
            workspace: runResult.cwd || null,
            sessionId: runResult.sessionId || null,
            jobId: runResult.remoteCodeJobId || runResult.codexAgentRunId || null,
          },
        },
        vectorize: false,
      });
      storedArtifacts.push(stored);
    }
  } catch (error) {
    if (typeof artifactService.deleteArtifact === 'function') {
      for (const stored of storedArtifacts.reverse()) {
        await Promise.resolve(artifactService.deleteArtifact(stored?.id)).catch(() => null);
      }
    }
    throw error;
  }

  const artifacts = storedArtifacts
    .map((stored) => (
      typeof artifactService.serializeArtifact === 'function'
        ? artifactService.serializeArtifact(stored)
        : stored
    ))
    .filter(Boolean);
  return {
    resultFilesManifest: normalized.manifestPath,
    resultFiles: normalized.files.map(({ contentBase64, ...file }, index) => ({
      ...file,
      relativePath: resolveRemoteRelativeResultPath(file, handoff),
      storedFilename: artifacts[index]?.filename || storedArtifacts[index]?.filename || null,
      artifactId: artifacts[index]?.id || storedArtifacts[index]?.id || null,
    })),
    artifacts,
    artifactIds: artifacts.map((artifact) => artifact.id).filter(Boolean),
  };
}

module.exports = {
  buildStoredResultFilename,
  buildArtifactPreview,
  isTextResultFile,
  persistRemoteAgentResultArtifacts,
  resolveRemoteRelativeResultPath,
};

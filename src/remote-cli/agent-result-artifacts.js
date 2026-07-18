'use strict';

const crypto = require('crypto');
const path = require('path');
const { normalizeRemoteAgentResultFiles } = require('./agent-handoff');
const { validateResultArtifactSet } = require('../artifacts/artifact-quality-gate');
const { sanitizeContextFilename } = require('../remote-runner/protocol');
const { inferFrontendTitle, normalizeBundlePath } = require('../frontend-bundles');
const { createUniqueFilename } = require('../utils/text');
const { createZip } = require('../utils/zip');

const TEXT_EXTENSION_PATTERN = /^(?:css|csv|htm|html|js|json|jsx|md|mjs|svg|ts|tsx|txt|xml|yaml|yml)$/i;
const MAX_EXTRACTED_TEXT_BYTES = 256 * 1024;
const MAX_HTML_PREVIEW_BYTES = 2 * 1024 * 1024;
const SITE_ENTRY_ROLE = 'site-entry';
const SITE_FILE_ROLE = 'site-file';
const SITE_ROLES = new Set([SITE_ENTRY_ROLE, SITE_FILE_ROLE]);

function createSiteBundleError(message, code = 'REMOTE_AGENT_SITE_BUNDLE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createArtifactQualityError(artifactQuality, basis = 'normalized-result-set') {
  const blockerCount = Array.isArray(artifactQuality?.blockers)
    ? artifactQuality.blockers.length
    : 0;
  const error = new Error(
    `Remote agent artifact structural quality validation blocked ${blockerCount} issue${blockerCount === 1 ? '' : 's'}.`,
  );
  error.code = 'REMOTE_AGENT_ARTIFACT_QUALITY_BLOCKED';
  error.artifactQuality = artifactQuality;
  error.artifactQualityBasis = basis;
  return error;
}

function buildFileArtifactQualityMetadata(artifactQuality, index, options = {}) {
  const file = artifactQuality?.files?.[index] || {};
  const basis = String(options.basis || artifactQuality?.basis || 'normalized-result-set');
  return {
    version: artifactQuality?.version || null,
    status: artifactQuality?.status || 'unknown',
    scope: 'file',
    basis,
    path: file.path || null,
    format: file.format || 'binary',
    sizeBytes: Number(file.sizeBytes || 0),
    ...(options.sha256 ? { sha256: options.sha256 } : {}),
  };
}

function buildSiteArtifactQualityMetadata(artifactQuality, siteBundlePlan, options = {}) {
  const basis = String(options.basis || artifactQuality?.basis || 'normalized-result-set');
  return {
    version: artifactQuality?.version || null,
    status: artifactQuality?.status || 'unknown',
    scope: 'site-bundle',
    basis,
    entry: siteBundlePlan?.entry || null,
    fileCount: siteBundlePlan?.members?.length || 0,
    checkedReferences: Number(artifactQuality?.site?.checkedReferences || 0),
  };
}

function normalizeResultRole(value = '') {
  return String(value || '').trim().toLowerCase();
}

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

function inferSiteBundleLanguage(filePath = '', mimeType = '') {
  const extension = path.posix.extname(String(filePath || '')).slice(1).toLowerCase();
  const languageByExtension = {
    css: 'css',
    csv: 'csv',
    htm: 'html',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    mjs: 'javascript',
    svg: 'svg',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'text',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };
  if (languageByExtension[extension]) {
    return languageByExtension[extension];
  }

  const normalizedMimeType = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return normalizedMimeType.startsWith('text/')
    ? normalizedMimeType.slice('text/'.length)
    : 'binary';
}

function buildRemoteAgentSiteBundlePlan(files = [], handoff = null) {
  const candidates = (Array.isArray(files) ? files : []).map((file, index) => ({
    file,
    index,
    role: normalizeResultRole(file?.role),
    sourceRelativePath: resolveRemoteRelativeResultPath(file, handoff),
  }));
  const siteCandidates = candidates.filter((candidate) => SITE_ROLES.has(candidate.role));
  if (siteCandidates.length === 0) {
    return null;
  }

  const entries = siteCandidates.filter((candidate) => candidate.role === SITE_ENTRY_ROLE);
  if (entries.length !== 1) {
    throw createSiteBundleError(
      'A returned site bundle requires exactly one file with role "site-entry".',
      'REMOTE_AGENT_SITE_BUNDLE_ENTRY_INVALID',
    );
  }
  if (siteCandidates.length < 2 || !siteCandidates.some((candidate) => candidate.role === SITE_FILE_ROLE)) {
    throw createSiteBundleError(
      'A returned site bundle requires at least one "site-file" in addition to its entry.',
      'REMOTE_AGENT_SITE_BUNDLE_FILES_MISSING',
    );
  }

  const entry = entries[0];
  if (path.posix.basename(entry.sourceRelativePath).toLowerCase() !== 'index.html') {
    throw createSiteBundleError(
      'The returned site-entry must be named index.html.',
      'REMOTE_AGENT_SITE_BUNDLE_ENTRY_INVALID',
    );
  }
  if (Number(entry.file?.sizeBytes || 0) > MAX_HTML_PREVIEW_BYTES) {
    throw createSiteBundleError(
      `The returned site-entry exceeds the ${MAX_HTML_PREVIEW_BYTES}-byte preview limit.`,
      'REMOTE_AGENT_SITE_BUNDLE_ENTRY_TOO_LARGE',
    );
  }

  const entryDirectory = path.posix.dirname(entry.sourceRelativePath);
  const rootDirectory = entryDirectory === '.' ? '' : entryDirectory;
  const rootPrefix = rootDirectory ? `${rootDirectory}/` : '';
  const seenPaths = new Set();
  const members = siteCandidates.map((candidate) => {
    if (rootPrefix && !candidate.sourceRelativePath.startsWith(rootPrefix)) {
      throw createSiteBundleError(
        `Returned site file ${candidate.sourceRelativePath} is outside the site-entry directory ${rootDirectory}.`,
        'REMOTE_AGENT_SITE_BUNDLE_ROOT_MISMATCH',
      );
    }
    const relativePath = rootPrefix
      ? candidate.sourceRelativePath.slice(rootPrefix.length)
      : candidate.sourceRelativePath;
    const bundlePath = normalizeBundlePath(relativePath);
    if (!bundlePath) {
      throw createSiteBundleError(
        `Returned site file ${candidate.sourceRelativePath} has an unsafe bundle path.`,
        'REMOTE_AGENT_SITE_BUNDLE_PATH_INVALID',
      );
    }
    const pathKey = bundlePath.toLowerCase();
    if (seenPaths.has(pathKey)) {
      throw createSiteBundleError(
        `Returned site bundle contains duplicate path ${bundlePath}.`,
        'REMOTE_AGENT_SITE_BUNDLE_DUPLICATE_PATH',
      );
    }
    seenPaths.add(pathKey);
    return {
      ...candidate,
      path: bundlePath,
    };
  });

  const entryMember = members.find((member) => member.index === entry.index);
  if (!entryMember || entryMember.path.toLowerCase() !== 'index.html') {
    throw createSiteBundleError(
      'The returned site-entry could not be rooted at index.html.',
      'REMOTE_AGENT_SITE_BUNDLE_ENTRY_INVALID',
    );
  }

  return {
    entry: 'index.html',
    rootDirectory,
    members,
    memberIndexes: new Set(members.map((member) => member.index)),
  };
}

function buildRemoteAgentLineage({ handoff = null, normalized = null, runResult = {}, componentArtifactIds = [] } = {}) {
  return {
    version: handoff?.version || null,
    operationId: handoff?.operationId || null,
    resultVersion: normalized?.version || null,
    resultManifestPath: normalized?.manifestPath || null,
    sourceArtifactIds: handoff?.sourceArtifactIds || [],
    transport: runResult.transport || null,
    providerId: runResult.providerId || null,
    targetId: runResult.targetId || null,
    workspace: runResult.cwd || null,
    sessionId: runResult.sessionId || null,
    jobId: runResult.remoteCodeJobId || runResult.codexAgentRunId || null,
    ...(componentArtifactIds.length > 0 ? { componentArtifactIds } : {}),
  };
}

async function loadStoredResultArtifacts(files, storedArtifacts, artifactService) {
  if (typeof artifactService.getArtifact !== 'function') {
    throw createSiteBundleError(
      'Artifact storage cannot reload persisted remote agent results.',
      'REMOTE_AGENT_RESULT_ARTIFACT_RELOAD_UNAVAILABLE',
    );
  }

  const persistedArtifacts = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const stored = storedArtifacts[index];
    const persisted = stored?.id
      ? await artifactService.getArtifact(stored.id, { includeContent: true })
      : null;
    if (!persisted || !Buffer.isBuffer(persisted.contentBuffer)) {
      throw createSiteBundleError(
        `Stored remote agent result ${stored?.id || file?.path || index} could not be reloaded.`,
        'REMOTE_AGENT_RESULT_ARTIFACT_RELOAD_FAILED',
      );
    }
    persistedArtifacts.push({
      index,
      file,
      stored,
      persisted,
      buffer: persisted.contentBuffer,
    });
  }
  return persistedArtifacts;
}

function buildPersistedValidationFiles(persistedArtifacts = []) {
  return persistedArtifacts.map(({ file, buffer }) => ({
    path: file.path,
    filename: file.filename,
    mimeType: file.mimeType,
    role: file.role,
    description: file.description,
    buffer,
  }));
}

function attachPersistedQualityMetadata({
  persistedArtifacts,
  storedArtifacts,
  sourceArtifactQuality,
  artifactQuality,
}) {
  return persistedArtifacts.map((member) => {
    const sha256 = crypto.createHash('sha256').update(member.buffer).digest('hex');
    const sourceFileQuality = buildFileArtifactQualityMetadata(sourceArtifactQuality, member.index, {
      basis: 'normalized-result-set',
      sha256: member.file.sha256,
    });
    const persistedFileQuality = buildFileArtifactQualityMetadata(artifactQuality, member.index, {
      basis: 'persisted-result-set',
      sha256,
    });
    const stored = {
      ...member.stored,
      ...member.persisted,
      metadata: {
        ...(member.persisted?.metadata || member.stored?.metadata || {}),
        sourceArtifactQuality: sourceFileQuality,
        artifactQuality: persistedFileQuality,
      },
      contentBuffer: member.buffer,
    };
    storedArtifacts[member.index] = stored;
    return {
      ...member,
      stored,
      persisted: stored,
      sha256,
      sourceArtifactQuality: sourceFileQuality,
      artifactQuality: persistedFileQuality,
    };
  });
}

function selectStoredSiteBundleMembers(siteBundlePlan, persistedArtifacts) {
  return siteBundlePlan.members.map((member) => {
    const persisted = persistedArtifacts[member.index];
    if (!persisted || !Buffer.isBuffer(persisted.buffer)) {
      throw createSiteBundleError(
        `Stored site component ${member.sourceRelativePath} is unavailable after validation.`,
        'REMOTE_AGENT_SITE_BUNDLE_COMPONENT_UNAVAILABLE',
      );
    }
    return {
      ...member,
      stored: persisted.stored,
      buffer: persisted.buffer,
    };
  });
}

function buildSiteBundleExtractedText(members = []) {
  const parts = [];
  let length = 0;
  for (const member of members) {
    if (!isTextResultFile(member.file)) {
      continue;
    }
    const section = `[${member.path}]\n${member.buffer.toString('utf8')}`;
    const remaining = MAX_EXTRACTED_TEXT_BYTES - length;
    if (remaining <= 0) {
      break;
    }
    const boundedSection = section.slice(0, remaining);
    parts.push(boundedSection);
    length += boundedSection.length + 2;
  }
  return parts.join('\n\n').slice(0, MAX_EXTRACTED_TEXT_BYTES);
}

async function createRemoteAgentSiteBundleArtifact({
  siteBundlePlan,
  artifactQuality,
  persistedArtifacts,
  artifactService,
  sessionId,
  context,
  handoff,
  normalized,
  runResult,
}) {
  const members = selectStoredSiteBundleMembers(siteBundlePlan, persistedArtifacts);
  const entry = members.find((member) => member.path === siteBundlePlan.entry);
  if (!entry) {
    throw createSiteBundleError(
      'The stored site bundle entry is unavailable.',
      'REMOTE_AGENT_SITE_BUNDLE_COMPONENT_UNAVAILABLE',
    );
  }
  if (entry.buffer.length > MAX_HTML_PREVIEW_BYTES) {
    throw createSiteBundleError(
      `The stored site-entry exceeds the ${MAX_HTML_PREVIEW_BYTES}-byte preview limit.`,
      'REMOTE_AGENT_SITE_BUNDLE_ENTRY_TOO_LARGE',
    );
  }

  const previewHtml = entry.buffer.toString('utf8');
  const title = inferFrontendTitle(previewHtml) || 'Remote Agent Site';
  const componentArtifactIds = members.map((member) => member.stored.id).filter(Boolean);
  const restoredPiiMembers = members.filter((member) => (
    member?.stored?.metadata?.piiCleansing?.restoredInGeneratedArtifact === true
    || Number(member?.stored?.metadata?.piiCleansing?.restoredCount || 0) > 0
  ));
  const restoredPiiCount = restoredPiiMembers.reduce((total, member) => (
    total + Math.max(1, Number(member?.stored?.metadata?.piiCleansing?.restoredCount || 0))
  ), 0);
  const files = members.map((member) => ({
    path: member.path,
    language: inferSiteBundleLanguage(member.path, member.file.mimeType),
    purpose: member.file.description || null,
    mimeType: member.file.mimeType,
    role: member.file.role,
    sha256: crypto.createHash('sha256').update(member.buffer).digest('hex'),
    gatewaySha256: member.file.sha256,
    artifactId: member.stored.id,
    sourceRelativePath: member.sourceRelativePath,
  }));
  const buffer = createZip(members.map((member) => ({
    name: member.path,
    data: member.buffer,
  })));

  return artifactService.createStoredArtifact({
    sessionId,
    session: context?.session || null,
    ownerId: context?.ownerId || null,
    parentArtifactId: handoff.sourceArtifactIds?.[0] || null,
    direction: 'generated',
    sourceMode: 'remote-cli-agent',
    filename: createUniqueFilename(title, 'zip', 'remote-agent-site'),
    extension: 'zip',
    mimeType: 'application/zip',
    buffer,
    extractedText: buildSiteBundleExtractedText(members),
    previewHtml,
    metadata: {
      createdByAgentTool: true,
      toolId: 'remote-cli-agent',
      title,
      type: 'frontend',
      previewMode: 'site',
      frameworkTarget: 'static',
      generationStrategy: 'remote-agent-result-site-bundle',
      ...(restoredPiiMembers.length > 0 ? {
        piiCleansing: {
          enabled: true,
          restoredCount: restoredPiiCount,
          restoredInGeneratedArtifact: true,
          affectedSiteMembers: restoredPiiMembers.map((member) => member.path),
        },
      } : {}),
      artifactQuality: buildSiteArtifactQualityMetadata(artifactQuality, siteBundlePlan),
      siteBundle: {
        entry: siteBundlePlan.entry,
        frameworkTarget: 'static',
        routing: 'multipage',
        fileCount: files.length,
        htmlPageCount: files.filter((file) => /\.html?$/i.test(file.path)).length,
        files,
      },
      remoteAgentHandoff: buildRemoteAgentLineage({
        handoff,
        normalized,
        runResult,
        componentArtifactIds,
      }),
    },
    vectorize: false,
  });
}

async function persistRemoteAgentResultArtifacts({
  resultFiles = null,
  handoff = null,
  artifactService = null,
  context = {},
  runResult = {},
} = {}) {
  const normalized = normalizeRemoteAgentResultFiles(resultFiles, handoff);
  const sourceArtifactQuality = {
    ...validateResultArtifactSet({
      files: normalized.files,
      filesDirectory: handoff?.output?.filesDirectory || '',
    }),
    basis: 'normalized-result-set',
  };
  if (sourceArtifactQuality.status !== 'passed') {
    throw createArtifactQualityError(sourceArtifactQuality, 'normalized-result-set');
  }
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

  const siteBundlePlan = buildRemoteAgentSiteBundlePlan(normalized.files, handoff);
  if (typeof artifactService.getArtifact !== 'function'
    || typeof artifactService.deleteArtifact !== 'function') {
    throw createSiteBundleError(
      siteBundlePlan
        ? 'Artifact storage cannot atomically assemble and roll back a returned site bundle.'
        : 'Artifact storage cannot reload and atomically roll back remote agent result files.',
      siteBundlePlan
        ? 'REMOTE_AGENT_SITE_BUNDLE_STORE_UNAVAILABLE'
        : 'REMOTE_AGENT_RESULT_ARTIFACT_STORE_UNAVAILABLE',
    );
  }
  const storedArtifacts = [];
  try {
    for (let index = 0; index < normalized.files.length; index += 1) {
      const file = normalized.files[index];
      const buffer = Buffer.from(file.contentBase64, 'base64');
      const remoteRelativePath = resolveRemoteRelativeResultPath(file, handoff);
      const storedFilename = buildStoredResultFilename(file, handoff);
      const extension = path.extname(storedFilename).slice(1).toLowerCase() || 'bin';
      const preview = buildArtifactPreview(file, buffer);
      const stored = await artifactService.createStoredArtifact({
        sessionId,
        session: context?.session || null,
        ownerId: context?.ownerId || null,
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
          artifactQuality: buildFileArtifactQualityMetadata(sourceArtifactQuality, index, {
            basis: 'normalized-result-set',
            sha256: file.sha256,
          }),
          ...(siteBundlePlan?.memberIndexes.has(index) ? {
            hiddenFromArtifactList: true,
            siteBundleComponent: {
              operationId: handoff.operationId,
              role: file.role,
              sourceRelativePath: remoteRelativePath,
            },
          } : {}),
          remoteAgentHandoff: buildRemoteAgentLineage({ handoff, normalized, runResult }),
        },
        vectorize: false,
      });
      storedArtifacts.push(stored);
    }

    let persistedArtifacts = await loadStoredResultArtifacts(
      normalized.files,
      storedArtifacts,
      artifactService,
    );
    const artifactQuality = {
      ...validateResultArtifactSet({
        files: buildPersistedValidationFiles(persistedArtifacts),
        filesDirectory: handoff?.output?.filesDirectory || '',
      }),
      basis: 'persisted-result-set',
    };
    if (artifactQuality.status !== 'passed') {
      throw createArtifactQualityError(artifactQuality, 'persisted-result-set');
    }
    persistedArtifacts = attachPersistedQualityMetadata({
      persistedArtifacts,
      storedArtifacts,
      sourceArtifactQuality,
      artifactQuality,
    });

    if (siteBundlePlan) {
      const siteBundleArtifact = await createRemoteAgentSiteBundleArtifact({
        siteBundlePlan,
        artifactQuality,
        persistedArtifacts,
        artifactService,
        sessionId,
        context,
        handoff,
        normalized,
        runResult,
      });
      storedArtifacts.push(siteBundleArtifact);
    }

    const artifacts = storedArtifacts.map((stored) => (
      typeof artifactService.serializeArtifact === 'function'
        ? artifactService.serializeArtifact(stored)
        : stored
    ));
    if (artifacts.some((artifact) => !artifact)) {
      throw createSiteBundleError(
        'A stored remote agent artifact could not be serialized.',
        'REMOTE_AGENT_RESULT_ARTIFACT_SERIALIZATION_FAILED',
      );
    }
    const siteBundleArtifact = siteBundlePlan ? artifacts[normalized.files.length] : null;
    return {
      resultFilesManifest: normalized.manifestPath,
      resultFiles: normalized.files.map(({ contentBase64, ...file }, index) => ({
        ...file,
        relativePath: resolveRemoteRelativeResultPath(file, handoff),
        storedFilename: artifacts[index]?.filename || storedArtifacts[index]?.filename || null,
        artifactId: artifacts[index]?.id || storedArtifacts[index]?.id || null,
        persistedSizeBytes: persistedArtifacts[index].buffer.length,
        persistedSha256: persistedArtifacts[index].sha256,
        sourceArtifactQuality: persistedArtifacts[index].sourceArtifactQuality,
        artifactQuality: persistedArtifacts[index].artifactQuality,
      })),
      artifacts,
      artifactIds: artifacts.map((artifact) => artifact.id).filter(Boolean),
      artifactQuality,
      sourceArtifactQuality,
      ...(siteBundleArtifact ? {
        siteBundleArtifact,
        siteBundleArtifactId: siteBundleArtifact.id,
      } : {}),
    };
  } catch (error) {
    if (typeof artifactService.deleteArtifact === 'function') {
      for (const stored of [...storedArtifacts].reverse()) {
        await Promise.resolve(artifactService.deleteArtifact(stored?.id)).catch(() => null);
      }
    }
    throw error;
  }
}

module.exports = {
  buildRemoteAgentSiteBundlePlan,
  buildStoredResultFilename,
  buildArtifactPreview,
  isTextResultFile,
  persistRemoteAgentResultArtifacts,
  resolveRemoteRelativeResultPath,
};

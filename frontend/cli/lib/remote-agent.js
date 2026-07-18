'use strict';

const MAX_ARTIFACT_ID_LENGTH = 300;
const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,299}$/i;
const SENSITIVE_QUERY_KEYS = new Set([
  'access-token',
  'api-key',
  'auth',
  'authorization',
  'client-secret',
  'cookie',
  'credential',
  'credentials',
  'id-token',
  'key',
  'password',
  'private-key',
  'refresh-token',
  'secret',
  'security-token',
  'session-token',
  'sig',
  'signature',
  'token',
]);

function readCommandToken(source, cursor = 0) {
  let start = Math.max(0, Number(cursor) || 0);
  while (start < source.length && /\s/.test(source[start])) {
    start += 1;
  }
  if (start >= source.length) {
    return null;
  }

  let end = start;
  while (end < source.length && !/\s/.test(source[end])) {
    end += 1;
  }
  return {
    value: source.slice(start, end),
    start,
    end,
  };
}

function isValidArtifactId(value = '') {
  const normalized = String(value || '').trim();
  return normalized.length <= MAX_ARTIFACT_ID_LENGTH
    && ARTIFACT_ID_PATTERN.test(normalized);
}

function requireArtifactId(value = '') {
  const normalized = String(value || '').trim();
  if (!isValidArtifactId(normalized)) {
    throw new Error('--artifact requires a full artifact ID.');
  }
  return normalized;
}

function parseRemoteAgentCommand(input = '') {
  const source = String(input || '').trim();
  const artifactIds = [];
  let collectResultFiles;
  let cursor = 0;
  let taskStart = source.length;

  while (cursor < source.length) {
    const token = readCommandToken(source, cursor);
    if (!token) {
      break;
    }

    if (token.value === '--') {
      const firstTaskToken = readCommandToken(source, token.end);
      taskStart = firstTaskToken ? firstTaskToken.start : source.length;
      break;
    }

    if (token.value === '--collect') {
      collectResultFiles = true;
      cursor = token.end;
      continue;
    }

    if (token.value === '--artifact') {
      const artifactToken = readCommandToken(source, token.end);
      if (!artifactToken) {
        throw new Error('--artifact requires a full artifact ID.');
      }
      artifactIds.push(requireArtifactId(artifactToken.value));
      cursor = artifactToken.end;
      continue;
    }

    if (token.value.startsWith('--artifact=')) {
      artifactIds.push(requireArtifactId(token.value.slice('--artifact='.length)));
      cursor = token.end;
      continue;
    }

    taskStart = token.start;
    break;
  }

  return {
    task: source.slice(taskStart).trim(),
    artifactIds: Array.from(new Set(artifactIds)),
    ...(collectResultFiles !== undefined ? { collectResultFiles } : {}),
  };
}

function sanitizeRemoteAgentUrlSubstring(value = '') {
  const raw = String(value || '');
  const trailing = raw.match(/[),.;!?]+$/)?.[0] || '';
  const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return `[redacted-url]${trailing}`;
    }
    parsed.username = '';
    parsed.password = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveQueryKey(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    return `${parsed.toString()}${trailing}`;
  } catch (_error) {
    return `[redacted-url]${trailing}`;
  }
}

function sanitizeRemoteAgentText(value = '') {
  return String(value ?? '')
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, sanitizeRemoteAgentUrlSubstring)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /(\b(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|refresh[-_ ]?token|session[-_ ]?token|security[-_ ]?token|id[-_ ]?token|authorization|credentials?|cookie|key|password|secret|signature|sig|token)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&#}\]]+)/gi,
      '$1[redacted]',
    );
}

function normalizeTerminalLine(value = '', maxLength = 2048) {
  const normalized = sanitizeRemoteAgentText(value)
    .replace(/\r?\n/g, ' ')
    .trim();
  const limit = Math.max(1, Number(maxLength) || 2048);
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(1, limit - 3))}...`
    : normalized;
}

function formatRemoteAgentTextOutput(value = '', maxLength = 20000) {
  const normalized = sanitizeRemoteAgentText(value).trim();
  const limit = Math.max(1, Number(maxLength) || 20000);
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(1, limit - 3))}...`
    : normalized;
}

function isSensitiveQueryKey(value = '') {
  let decoded = String(value || '').trim();
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, '%20'));
      if (next === decoded) break;
      decoded = next;
    } catch (_error) {
      break;
    }
  }
  const components = decoded.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (components.length === 0) {
    return false;
  }
  const normalized = components.join('-');
  if (SENSITIVE_QUERY_KEYS.has(normalized)) {
    return true;
  }
  const suffix = components.slice(-2).join('-');
  if (['access-token', 'api-key', 'security-token'].includes(suffix)) {
    return true;
  }
  if (components[0] === 'x' && ['amz', 'goog'].includes(components[1])) {
    const providerField = components.slice(2).join('-');
    return ['credential', 'security-token', 'signature'].includes(providerField);
  }
  return false;
}

function buildArtifactRoute(artifactId, action) {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/${action}`;
}

function normalizeArtifactRouteUrl(value, artifactId, action, options = {}) {
  const fallback = options.fallback === true ? buildArtifactRoute(artifactId, action) : '';
  const raw = String(value ?? '').trim();
  if (!raw) {
    return fallback;
  }
  if (/[\u0000-\u001F\u007F]/.test(raw) || !raw.startsWith('/') || raw.startsWith('//')) {
    return fallback;
  }

  try {
    const safeOrigin = 'https://kimibuilt.invalid';
    const parsed = new URL(raw, safeOrigin);
    if (parsed.origin !== safeOrigin) {
      return fallback;
    }
    const pathMatch = parsed.pathname.match(/^\/api\/artifacts\/([^/]+)\/([^/]+)$/);
    if (!pathMatch
      || decodeURIComponent(pathMatch[1]) !== artifactId
      || pathMatch[2] !== action) {
      return fallback;
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveQueryKey(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch (_error) {
    return fallback;
  }
}

function normalizeArtifactDescriptor(candidate = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const id = normalizeTerminalLine(
    candidate.id || candidate.artifactId || candidate.artifact_id || '',
    MAX_ARTIFACT_ID_LENGTH,
  );
  if (!isValidArtifactId(id)) {
    return null;
  }

  const downloadCandidate = candidate.downloadUrl || candidate.download_url || '';
  const previewCandidate = candidate.previewUrl || candidate.preview_url || '';
  const sandboxCandidate = candidate.sandboxUrl || candidate.sandbox_url || '';
  const bundleCandidate = candidate.bundleDownloadUrl
    || candidate.bundle_download_url
    || candidate.bundle_download
    || '';

  return {
    id,
    filename: normalizeTerminalLine(
      candidate.filename
      || candidate.storedFilename
      || candidate.stored_filename
      || candidate.name
      || '',
      500,
    ),
    downloadUrl: normalizeArtifactRouteUrl(downloadCandidate, id, 'download', { fallback: true }),
    previewUrl: normalizeArtifactRouteUrl(previewCandidate, id, 'preview', {
      fallback: Boolean(previewCandidate),
    }),
    sandboxUrl: normalizeArtifactRouteUrl(sandboxCandidate, id, 'sandbox', {
      fallback: Boolean(sandboxCandidate),
    }),
    bundleDownloadUrl: normalizeArtifactRouteUrl(bundleCandidate, id, 'bundle', {
      fallback: Boolean(bundleCandidate),
    }),
  };
}

function mergeArtifactDescriptor(existing = null, candidate = null) {
  if (!candidate) {
    return existing;
  }
  if (!existing) {
    return candidate;
  }

  return Object.fromEntries(Object.entries({
    ...existing,
    ...candidate,
  }).map(([key, value]) => [key, value || existing[key] || '']));
}

function collectRemoteAgentArtifacts(result = {}) {
  const descriptors = new Map();
  const add = (candidate) => {
    const normalized = normalizeArtifactDescriptor(candidate);
    if (!normalized) {
      return;
    }
    descriptors.set(
      normalized.id,
      mergeArtifactDescriptor(descriptors.get(normalized.id), normalized),
    );
  };

  (Array.isArray(result.artifactIds) ? result.artifactIds : []).forEach((artifactId) => {
    add({ artifactId });
  });
  (Array.isArray(result.resultFiles) ? result.resultFiles : []).forEach(add);
  add(result.siteBundleArtifact);
  (Array.isArray(result.artifacts) ? result.artifacts : []).forEach(add);

  const siteBundleArtifactId = String(
    result.siteBundleArtifactId
    || result.siteBundleArtifact?.id
    || result.siteBundleArtifact?.artifactId
    || result.siteBundleArtifact?.artifact_id
    || '',
  ).trim();
  if (isValidArtifactId(siteBundleArtifactId)) {
    const existing = descriptors.get(siteBundleArtifactId) || normalizeArtifactDescriptor({
      artifactId: siteBundleArtifactId,
    });
    descriptors.set(siteBundleArtifactId, {
      ...existing,
      filename: existing.filename || 'Website bundle.zip',
      previewUrl: existing.previewUrl || buildArtifactRoute(siteBundleArtifactId, 'preview'),
      bundleDownloadUrl: existing.bundleDownloadUrl || buildArtifactRoute(siteBundleArtifactId, 'bundle'),
    });
  }

  const normalizedSiteBundleArtifactId = isValidArtifactId(siteBundleArtifactId)
    ? siteBundleArtifactId
    : '';

  return {
    siteBundle: normalizedSiteBundleArtifactId
      ? descriptors.get(normalizedSiteBundleArtifactId) || null
      : null,
    artifacts: Array.from(descriptors.values()).filter(
      (artifact) => artifact.id !== normalizedSiteBundleArtifactId,
    ),
  };
}

function formatArtifactLines(artifact, indent = '  ') {
  if (!artifact) {
    return [];
  }

  return [
    `${indent}ID: ${artifact.id}`,
    `${indent}Filename: ${artifact.filename || '(not provided)'}`,
    `${indent}Download: ${artifact.downloadUrl}`,
    ...(artifact.previewUrl ? [`${indent}Preview: ${artifact.previewUrl}`] : []),
    ...(artifact.sandboxUrl ? [`${indent}Sandbox: ${artifact.sandboxUrl}`] : []),
    ...(artifact.bundleDownloadUrl ? [`${indent}Bundle: ${artifact.bundleDownloadUrl}`] : []),
  ];
}

function formatRemoteAgentArtifactOutput(result = {}) {
  const { artifacts, siteBundle } = collectRemoteAgentArtifacts(result);
  const lines = [];

  if (siteBundle) {
    lines.push('Site bundle:');
    lines.push(...formatArtifactLines(siteBundle));
  }

  if (artifacts.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Returned artifacts:');
    artifacts.forEach((artifact, index) => {
      if (index > 0) {
        lines.push('');
      }
      lines.push(...formatArtifactLines(artifact));
    });
  }

  return lines;
}

function formatRemoteAgentStatusOutput(result = {}) {
  const completionStatus = normalizeTerminalLine(result.completionStatus || result.status || '', 120);
  const blocker = normalizeTerminalLine(result.blocker || '', 1200);
  const resultFilesError = normalizeTerminalLine(result.resultFilesError || '', 1200);
  return [
    ...(completionStatus ? [`Status: ${completionStatus}`] : []),
    ...(blocker ? [`Blocker: ${blocker}`] : []),
    ...(resultFilesError ? [`Result files: ${resultFilesError}`] : []),
  ];
}

function formatSessionArtifactLine(artifact = {}) {
  const id = normalizeTerminalLine(artifact.id || artifact.artifactId || artifact.artifact_id || '', 300);
  const filename = normalizeTerminalLine(artifact.filename || artifact.name || '', 500);
  const format = normalizeTerminalLine(artifact.format || artifact.extension || artifact.type || '', 80);
  return `  ${id}  ${filename}  [${format}]`;
}

module.exports = {
  collectRemoteAgentArtifacts,
  formatRemoteAgentArtifactOutput,
  formatRemoteAgentStatusOutput,
  formatRemoteAgentTextOutput,
  formatSessionArtifactLine,
  parseRemoteAgentCommand,
};

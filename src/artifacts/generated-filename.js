const GENERATED_MIME_TYPE_EXTENSIONS = Object.freeze({
  'application/octet-stream': 'bin',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/html': 'html',
  'text/markdown': 'md',
  'video/mp4': 'mp4',
});

function normalizeGeneratedExtension(extension = 'bin') {
  const normalized = String(extension || 'bin')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .split(';', 1)[0]
    .trim();
  if (Object.hasOwn(GENERATED_MIME_TYPE_EXTENSIONS, normalized)) {
    return GENERATED_MIME_TYPE_EXTENSIONS[normalized];
  }
  if (normalized.length <= 32 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(normalized)) {
    return normalized;
  }
  return 'bin';
}

function sanitizeGeneratedFilename(filename = '', extension = 'bin') {
  const normalizedExtension = normalizeGeneratedExtension(extension);
  const extensionSuffix = `.${normalizedExtension}`;
  const fallback = `generated-artifact.${normalizedExtension}`;
  const cleaned = String(filename || fallback)
    .trim()
    .replace(/["\r\n]/g, '')
    .replace(/[\\/:*?<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  const candidate = cleaned || fallback;
  const filenameBase = candidate.toLowerCase().endsWith(extensionSuffix)
    ? candidate.slice(0, -extensionSuffix.length)
    : candidate.replace(/\.[a-z0-9]+$/i, '');
  const maxBaseLength = Math.max(1, 160 - extensionSuffix.length);
  const boundedBase = filenameBase.slice(0, maxBaseLength).replace(/[. ]+$/, '').trim()
    || 'generated-artifact';
  return `${boundedBase}${extensionSuffix}`;
}

module.exports = {
  normalizeGeneratedExtension,
  sanitizeGeneratedFilename,
};

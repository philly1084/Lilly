function normalizeGeneratedExtension(extension = 'bin') {
  return String(extension || 'bin').trim().toLowerCase().replace(/^\./, '') || 'bin';
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
  sanitizeGeneratedFilename,
};

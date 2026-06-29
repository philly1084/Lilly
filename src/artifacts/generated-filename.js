function normalizeGeneratedExtension(extension = 'bin') {
  return String(extension || 'bin').trim().toLowerCase().replace(/^\./, '') || 'bin';
}

function sanitizeGeneratedFilename(filename = '', extension = 'bin') {
  const normalizedExtension = normalizeGeneratedExtension(extension);
  const fallback = `generated-artifact.${normalizedExtension}`;
  const cleaned = String(filename || fallback)
    .trim()
    .replace(/["\r\n]/g, '')
    .replace(/[\\/:*?<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 160)
    .trim();
  const candidate = cleaned || fallback;
  return /\.[a-z0-9]+$/i.test(candidate)
    ? candidate
    : `${candidate}.${normalizedExtension}`;
}

module.exports = {
  sanitizeGeneratedFilename,
};

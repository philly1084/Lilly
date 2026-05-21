function truncateToCharacterLimit(content = '', limit = 0, label = 'content') {
  const source = String(content || '');
  const originalCharacterCount = source.length;
  const safeLimit = Number(limit);

  if (!Number.isFinite(safeLimit) || safeLimit <= 0 || originalCharacterCount <= safeLimit) {
    return {
      content: source,
      truncated: false,
      originalCharacterCount,
    };
  }

  const notice = `\n\n[${label} exceeded ${safeLimit} characters and was truncated from ${originalCharacterCount} characters at runtime. Save a shorter version to remove this notice.]\n`;
  const prefixLength = Math.max(0, safeLimit - notice.length);
  const truncated = `${source.slice(0, prefixLength).trimEnd()}${notice}`;

  return {
    content: truncated.length <= safeLimit ? truncated : truncated.slice(0, safeLimit),
    truncated: true,
    originalCharacterCount,
  };
}

module.exports = {
  truncateToCharacterLimit,
};

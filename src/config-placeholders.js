'use strict';

function normalizeConfigValue(value = '') {
  return String(value || '').trim();
}

function isPlaceholderConfigValue(value = '') {
  const normalized = normalizeConfigValue(value);
  if (!normalized) {
    return false;
  }

  const lowered = normalized.toLowerCase();
  return [
    'change-me',
    'replace-me',
    'replace-after-gitlab-boot',
    'replace-after-gitea-boot',
    'set_via_kubectl_create_secret',
    'optional_set_via_kubectl_create_secret',
  ].includes(lowered)
    || /^(?:replace[_-]?with|set[_-]?via|optional[_-]?set[_-]?via|your[_-])/i.test(normalized);
}

function sanitizeConfigValue(value = '') {
  const normalized = normalizeConfigValue(value);
  return isPlaceholderConfigValue(normalized) ? '' : normalized;
}

function firstConfiguredValue(...values) {
  for (const value of values) {
    const normalized = sanitizeConfigValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

module.exports = {
  firstConfiguredValue,
  isPlaceholderConfigValue,
  normalizeConfigValue,
  sanitizeConfigValue,
};

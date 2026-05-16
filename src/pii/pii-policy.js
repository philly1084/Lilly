const settingsController = require('../routes/admin/settings.controller');
const { postgres } = require('../postgres');

const DEFAULT_PRIVACY_PII_SETTINGS = {
  enabled: false,
  webChatEnabled: true,
  highlightRestored: true,
  allowUserOverride: false,
  placeholderMode: 'typed-random',
  failClosed: true,
  detectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress'],
  customPatterns: [],
  dictionary: [],
  enablePersonNames: false,
};

function normalizePlaceholderMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['opaque', 'opaque-random', 'random'].includes(normalized)) return 'opaque-random';
  if (['stable', 'stable-per-value', 'same-placeholder'].includes(normalized)) return 'stable-per-value';
  if (['typed', 'typed-random', 'type-random'].includes(normalized)) return 'typed-random';
  return 'typed-random';
}

function normalizePrivacyPiiSettings(value = {}, fallback = DEFAULT_PRIVACY_PII_SETTINGS) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...fallback,
    ...source,
    enabled: source.enabled !== undefined ? Boolean(source.enabled) : Boolean(fallback.enabled),
    webChatEnabled: source.webChatEnabled !== undefined ? Boolean(source.webChatEnabled) : fallback.webChatEnabled !== false,
    highlightRestored: source.highlightRestored !== undefined ? Boolean(source.highlightRestored) : fallback.highlightRestored !== false,
    allowUserOverride: source.allowUserOverride === true,
    failClosed: source.failClosed !== undefined ? Boolean(source.failClosed) : fallback.failClosed !== false,
    placeholderMode: normalizePlaceholderMode(source.placeholderMode || fallback.placeholderMode),
    detectors: Array.isArray(source.detectors) && source.detectors.length > 0
      ? source.detectors.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [...fallback.detectors],
    customPatterns: Array.isArray(source.customPatterns) ? source.customPatterns.slice(0, 50) : [],
    dictionary: Array.isArray(source.dictionary) ? source.dictionary.slice(0, 200) : [],
    enablePersonNames: source.enablePersonNames === true,
  };
}

function getConfiguredPrivacyPiiSettings() {
  if (typeof settingsController.getEffectivePrivacyPiiConfig === 'function') {
    return settingsController.getEffectivePrivacyPiiConfig();
  }
  return normalizePrivacyPiiSettings(settingsController.settings?.privacyPii || {});
}

function resolvePiiPolicy({ metadata = {}, clientSurface = '', route = '' } = {}) {
  const settings = getConfiguredPrivacyPiiSettings();
  const surface = String(clientSurface || metadata?.clientSurface || metadata?.client_surface || '').trim();
  const routeText = String(route || '').trim();
  const requestedEnable = metadata?.piiCleansingEnabled ?? metadata?.pii_cleansing_enabled;
  const requestedDisable = metadata?.piiCleansingDisabled ?? metadata?.pii_cleansing_disabled;
  let enabled = settings.enabled === true;

  if (surface === 'web-chat' && settings.webChatEnabled === false) {
    enabled = false;
  }
  if (settings.allowUserOverride && requestedEnable === true) {
    enabled = true;
  }
  if (settings.allowUserOverride && requestedDisable === true) {
    enabled = false;
  }

  return {
    ...settings,
    enabled,
    clientSurface: surface,
    route: routeText,
    storageReady: Boolean(postgres?.getStatus?.().initialized),
    hasMasterKey: Boolean(String(process.env.KIMIBUILT_PII_MASTER_KEY || '').trim()),
  };
}

function assertPiiReady(policy = {}) {
  if (!policy.enabled) return;
  if (!policy.hasMasterKey) {
    const error = new Error('PII cleansing is enabled but KIMIBUILT_PII_MASTER_KEY is not configured.');
    error.statusCode = 503;
    error.code = 'pii_master_key_missing';
    throw error;
  }
  if (!policy.storageReady) {
    const error = new Error('PII cleansing is enabled but Postgres vault storage is unavailable.');
    error.statusCode = 503;
    error.code = 'pii_vault_unavailable';
    throw error;
  }
}

module.exports = {
  DEFAULT_PRIVACY_PII_SETTINGS,
  normalizePrivacyPiiSettings,
  normalizePlaceholderMode,
  getConfiguredPrivacyPiiSettings,
  resolvePiiPolicy,
  assertPiiReady,
};

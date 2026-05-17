const settingsController = require('../routes/admin/settings.controller');
const { postgres } = require('../postgres');

const DEFAULT_PRIVACY_PII_SETTINGS = {
  defaultsVersion: 3,
  enabled: true,
  webChatEnabled: true,
  highlightRestored: true,
  allowUserOverride: false,
  placeholderMode: 'opaque-random',
  reintroductionMode: 'trusted-view',
  failClosed: true,
  detectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress', 'personName', 'organization'],
  detectorActions: {},
  customPatterns: [],
  dictionary: [],
  enablePersonNames: true,
  auditProfile: 'strict',
  auditCriteria: {
    requiredDetectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress', 'personName', 'organization'],
    requireVaultKey: true,
    requireFailClosed: true,
    requireRestoreHighlight: true,
  },
};

const PRIVACY_PII_ACTIONS = new Set(['vault-placeholder', 'mask', 'remove', 'ignore']);
const PRIVACY_PII_AUDIT_PROFILES = {
  baseline: {
    requiredDetectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress'],
    requireVaultKey: true,
    requireFailClosed: true,
    requireRestoreHighlight: true,
  },
  strict: {
    requiredDetectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress', 'personName', 'organization'],
    requireVaultKey: true,
    requireFailClosed: true,
    requireRestoreHighlight: true,
  },
  custom: {
    requiredDetectors: [],
    requireVaultKey: false,
    requireFailClosed: false,
    requireRestoreHighlight: false,
  },
};

function normalizePlaceholderMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['opaque', 'opaque-random', 'random'].includes(normalized)) return 'opaque-random';
  if (['stable', 'stable-per-value', 'same-placeholder'].includes(normalized)) return 'stable-per-value';
  if (['typed', 'typed-random', 'type-random'].includes(normalized)) return 'typed-random';
  return 'opaque-random';
}

function normalizeReintroductionMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['never', 'disabled', 'off', 'no-restore'].includes(normalized)) return 'never';
  if (['admin-only', 'admin'].includes(normalized)) return 'admin-only';
  return 'trusted-view';
}

function normalizeDetectorActions(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallbackSource = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  return Object.entries({ ...fallbackSource, ...source })
    .map(([type, action]) => [
      String(type || '').trim(),
      String(action || '').trim(),
    ])
    .filter(([type]) => Boolean(type))
    .reduce((acc, [type, action]) => {
      acc[type] = PRIVACY_PII_ACTIONS.has(action) ? action : 'vault-placeholder';
      return acc;
    }, {});
}

function normalizeDictionary(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (typeof entry === 'string') {
        const value = entry.trim();
        return value ? { type: 'custom', value } : null;
      }
      if (!entry || typeof entry !== 'object') return null;
      const type = String(entry.type || entry.label || 'custom').trim() || 'custom';
      const value = String(entry.value || '').trim();
      if (!value) return null;
      const action = String(entry.action || '').trim();
      return {
        type,
        value,
        ...(PRIVACY_PII_ACTIONS.has(action) ? { action } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 200);
}

function normalizeCustomPatterns(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const type = String(entry.type || entry.label || 'custom').trim() || 'custom';
      const pattern = String(entry.pattern || '').trim();
      if (!pattern) return null;
      const flags = String(entry.flags || 'gi').trim() || 'gi';
      const action = String(entry.action || '').trim();
      return {
        type,
        pattern,
        flags,
        ...(PRIVACY_PII_ACTIONS.has(action) ? { action } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 50);
}

function normalizeAuditCriteria(value = {}, fallback = {}, profile = 'baseline') {
  const profileCriteria = PRIVACY_PII_AUDIT_PROFILES[profile] || PRIVACY_PII_AUDIT_PROFILES.baseline;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallbackSource = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  const merged = { ...profileCriteria, ...fallbackSource, ...source };
  return {
    requiredDetectors: Array.isArray(merged.requiredDetectors)
      ? merged.requiredDetectors.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 50)
      : [...profileCriteria.requiredDetectors],
    requireVaultKey: merged.requireVaultKey !== false,
    requireFailClosed: merged.requireFailClosed !== false,
    requireRestoreHighlight: merged.requireRestoreHighlight !== false,
  };
}

function normalizePrivacyPiiSettings(value = {}, fallback = DEFAULT_PRIVACY_PII_SETTINGS) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceDetectors = Array.isArray(source.detectors)
    ? source.detectors.map((entry) => String(entry || '').trim()).filter(Boolean)
    : null;
  const auditProfile = ['baseline', 'strict', 'custom'].includes(String(source.auditProfile || fallback.auditProfile || '').trim())
    ? String(source.auditProfile || fallback.auditProfile)
    : 'baseline';
  return {
    ...fallback,
    ...source,
    defaultsVersion: 2,
    enabled: source.enabled !== undefined ? Boolean(source.enabled) : Boolean(fallback.enabled),
    webChatEnabled: source.webChatEnabled !== undefined ? Boolean(source.webChatEnabled) : fallback.webChatEnabled !== false,
    highlightRestored: source.highlightRestored !== undefined ? Boolean(source.highlightRestored) : fallback.highlightRestored !== false,
    allowUserOverride: source.allowUserOverride === true,
    failClosed: source.failClosed !== undefined ? Boolean(source.failClosed) : fallback.failClosed !== false,
    placeholderMode: normalizePlaceholderMode(source.placeholderMode || fallback.placeholderMode),
    reintroductionMode: normalizeReintroductionMode(source.reintroductionMode || fallback.reintroductionMode),
    detectors: sourceDetectors
      ? sourceDetectors
      : [...fallback.detectors],
    detectorActions: normalizeDetectorActions(source.detectorActions, fallback.detectorActions),
    customPatterns: normalizeCustomPatterns(source.customPatterns),
    dictionary: normalizeDictionary(source.dictionary),
    enablePersonNames: source.enablePersonNames !== undefined
      ? source.enablePersonNames === true
      : sourceDetectors
        ? sourceDetectors.includes('personName')
        : fallback.enablePersonNames === true,
    auditProfile,
    auditCriteria: normalizeAuditCriteria(source.auditCriteria, fallback.auditCriteria, auditProfile),
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
  normalizeReintroductionMode,
  getConfiguredPrivacyPiiSettings,
  resolvePiiPolicy,
  assertPiiReady,
};

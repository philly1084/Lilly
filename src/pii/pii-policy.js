const settingsController = require('../routes/admin/settings.controller');
const { postgres } = require('../postgres');
const { normalizeDetectorId } = require('./pii-detectors');

const DEFAULT_PRIVACY_PII_SETTINGS = {
  defaultsVersion: 6,
  enabled: true,
  webChatEnabled: true,
  highlightRestored: true,
  allowUserOverride: false,
  placeholderMode: 'opaque-random',
  reintroductionMode: 'trusted-view',
  failClosed: true,
  detectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress', 'postalCode', 'personName', 'organization', 'medicalRecordNumber', 'patientIdentifier', 'healthCardNumber', 'socialInsuranceNumber'],
  detectorActions: {},
  customPatterns: [],
  dictionary: [],
  enablePersonNames: true,
  auditProfile: 'strict',
  auditCriteria: {
    requiredDetectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress', 'postalCode', 'personName', 'organization', 'medicalRecordNumber', 'patientIdentifier', 'healthCardNumber', 'socialInsuranceNumber'],
    requireVaultKey: true,
    requireFailClosed: true,
    requireRestoreHighlight: true,
  },
  relationshipCalculations: {
    enabled: true,
    autoDetect: true,
    allowExplicitRequest: true,
    maxRows: 1000,
    maxCells: 20000,
    maxOperations: 25,
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
    requiredDetectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress', 'postalCode', 'personName', 'organization', 'medicalRecordNumber', 'patientIdentifier', 'healthCardNumber', 'socialInsuranceNumber'],
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

function normalizePrivacyType(value = '', fallback = 'custom') {
  const normalized = normalizeDetectorId(String(value || '').trim());
  return normalized || fallback;
}

function normalizePrivacyAction(value = '', fallback = 'vault-placeholder') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (['vault', 'placeholder', 'vault-placeholder', 'vaulted', 'tokenize', 'tokenise'].includes(normalized)) {
    return 'vault-placeholder';
  }
  if (['mask', 'masked', 'redact', 'redacted', 'redaction'].includes(normalized)) {
    return 'mask';
  }
  if (['remove', 'removed', 'delete', 'drop', 'strip'].includes(normalized)) {
    return 'remove';
  }
  if (['ignore', 'ignored', 'skip', 'none', 'off'].includes(normalized)) {
    return 'ignore';
  }
  return PRIVACY_PII_ACTIONS.has(fallback) ? fallback : 'vault-placeholder';
}

function normalizeRegexFlags(value = 'gi') {
  const raw = String(value || 'gi').trim().toLowerCase() || 'gi';
  const flags = Array.from(new Set(`${raw}gi`.split('').filter((flag) => 'dgimsuy'.includes(flag)))).join('');
  return flags || 'gi';
}

function isValidRegex(pattern = '', flags = 'gi') {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch (_error) {
    return false;
  }
}

function parseBoundedPositiveInteger(value, fallback, max) {
  const raw = String(value ?? '').trim();
  const numeric = raw
    ? Number(raw.replace(/[,\s]+/g, ''))
    : Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : parseInt(raw.replace(/,/g, ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

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
      acc[normalizePrivacyType(type)] = normalizePrivacyAction(action);
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
      const type = normalizePrivacyType(entry.type || entry.label || 'custom');
      const value = String(entry.value || '').trim();
      if (!value) return null;
      const action = normalizePrivacyAction(entry.action || '');
      return {
        type,
        value,
        ...(entry.action !== undefined ? { action } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 200);
}

function normalizeCustomPatterns(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const type = normalizePrivacyType(entry.type || entry.label || 'custom');
      const pattern = String(entry.pattern || '').trim();
      if (!pattern) return null;
      const flags = normalizeRegexFlags(entry.flags || 'gi');
      if (!isValidRegex(pattern, flags)) return null;
      const action = normalizePrivacyAction(entry.action || '');
      return {
        type,
        pattern,
        flags,
        ...(entry.action !== undefined ? { action } : {}),
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
      ? Array.from(new Set(merged.requiredDetectors.map((entry) => normalizePrivacyType(entry, '')).filter(Boolean))).slice(0, 50)
      : [...profileCriteria.requiredDetectors],
    requireVaultKey: merged.requireVaultKey !== false,
    requireFailClosed: merged.requireFailClosed !== false,
    requireRestoreHighlight: merged.requireRestoreHighlight !== false,
  };
}

function normalizeRelationshipCalculations(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallbackSource = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  const maxRows = parseBoundedPositiveInteger(source.maxRows ?? fallbackSource.maxRows ?? 1000, 1000, 100000);
  const maxCells = parseBoundedPositiveInteger(source.maxCells ?? fallbackSource.maxCells ?? 20000, 20000, 1000000);
  const maxOperations = parseBoundedPositiveInteger(source.maxOperations ?? fallbackSource.maxOperations ?? 25, 1, 100);
  return {
    enabled: source.enabled !== undefined ? Boolean(source.enabled) : fallbackSource.enabled !== false,
    autoDetect: source.autoDetect !== undefined ? Boolean(source.autoDetect) : fallbackSource.autoDetect !== false,
    allowExplicitRequest: source.allowExplicitRequest !== undefined
      ? Boolean(source.allowExplicitRequest)
      : fallbackSource.allowExplicitRequest !== false,
    maxRows,
    maxCells,
    maxOperations,
  };
}

function normalizeRelationshipCalculationOverride(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['force', 'on', 'enabled', 'true', 'required'].includes(normalized)) return 'force';
  if (['off', 'disabled', 'false', 'none'].includes(normalized)) return 'off';
  return 'auto';
}

function hasRelationshipCalculationIntent(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  const hasTableCue = /\b(xlsx|excel|spreadsheet|workbook|sheet|worksheet|csv|table|rows?|columns?|cells?)\b/.test(normalized);
  const hasMathCue = /\b(sum|sums|total|totals|subtotal|aggregate|add up|count|average|mean|rank|ranking|top|bottom|largest|smallest|highest|lowest|greater|lesser|compare|comparison|group|grouped|by retailer|by customer|by client|by account)\b/.test(normalized);
  return hasTableCue && hasMathCue;
}

function resolveRelationshipCalculationPolicy(policy = {}, {
  text = '',
  metadata = {},
} = {}) {
  const settings = normalizeRelationshipCalculations(
    policy.relationshipCalculations,
    DEFAULT_PRIVACY_PII_SETTINGS.relationshipCalculations,
  );
  const override = normalizeRelationshipCalculationOverride(
    metadata?.piiRelationshipCalculations
      ?? metadata?.pii_relationship_calculations
      ?? metadata?.relationshipCalculations
      ?? metadata?.relationship_calculations,
  );
  const callerActive = policy.relationshipCalculations?.active === true
    || metadata?.piiCleansing?.relationshipCalculations?.active === true;
  const explicitActive = callerActive || (settings.allowExplicitRequest && override === 'force');
  const disabled = !settings.enabled || override === 'off';
  const autoActive = !disabled && settings.autoDetect && hasRelationshipCalculationIntent(text);
  const active = policy.enabled === true && !disabled && (explicitActive || autoActive);
  return {
    ...settings,
    override,
    active,
    reason: active
      ? (explicitActive ? 'explicit' : 'auto-detected')
      : (disabled ? 'disabled' : 'not-detected'),
  };
}

function normalizePrivacyPiiSettings(value = {}, fallback = DEFAULT_PRIVACY_PII_SETTINGS) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceDetectors = Array.isArray(source.detectors)
    ? Array.from(new Set(source.detectors.map((entry) => normalizePrivacyType(entry, '')).filter(Boolean)))
    : null;
  const auditProfile = ['baseline', 'strict', 'custom'].includes(String(source.auditProfile || fallback.auditProfile || '').trim())
    ? String(source.auditProfile || fallback.auditProfile)
    : 'baseline';
  return {
    ...fallback,
    ...source,
    defaultsVersion: 6,
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
    relationshipCalculations: normalizeRelationshipCalculations(
      source.relationshipCalculations,
      fallback.relationshipCalculations,
    ),
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
  normalizeRelationshipCalculations,
  normalizeRelationshipCalculationOverride,
  hasRelationshipCalculationIntent,
  resolveRelationshipCalculationPolicy,
  getConfiguredPrivacyPiiSettings,
  resolvePiiPolicy,
  assertPiiReady,
};

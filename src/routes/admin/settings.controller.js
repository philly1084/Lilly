/**
 * Settings Controller
 * Manages system settings and configuration
 */

const fs = require('fs').promises;
const path = require('path');
const { config } = require('../../config');
const { postgres } = require('../../postgres');
const {
  getEffectiveSoulConfig,
  resetSoulFile,
  writeSoulFile,
} = require('../../agent-soul');
const {
  getEffectiveAgentNotesConfig,
  resetAgentNotesFile,
  writeAgentNotesFile,
} = require('../../agent-notes');
const { detectPii, normalizeDetectorId } = require('../../pii/pii-detectors');
const { resolvePreferredWritableFile } = require('../../runtime-state-paths');
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
  },
};

const PRIVACY_PII_ACTIONS = new Set(['vault-placeholder', 'mask', 'remove', 'ignore']);
const NON_RESTORABLE_IDENTITY_TYPES = new Set([
  'personName',
  'organization',
  'orgName',
  'employer',
  'workplace',
  'business',
  'businessName',
  'company',
  'clientName',
  'teamName',
  'vendor',
  'brand',
  'brandName',
  'product',
  'productName',
  'service',
  'serviceName',
  'medicalRecordNumber',
  'patientIdentifier',
  'healthCardNumber',
  'socialInsuranceNumber',
]);
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

function assertValidPrivacyRegex(pattern = '', flags = 'gi') {
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    const validationError = new Error(`Invalid PII custom regex "${String(pattern || '').slice(0, 80)}": ${error.message}`);
    validationError.statusCode = 400;
    validationError.code = 'invalid_pii_custom_regex';
    throw validationError;
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

function normalizePrivacyPlaceholderMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['opaque', 'opaque-random', 'random'].includes(normalized)) return 'opaque-random';
  if (['stable', 'stable-per-value', 'same-placeholder'].includes(normalized)) return 'stable-per-value';
  if (['typed', 'typed-random', 'type-random'].includes(normalized)) return 'typed-random';
  return 'opaque-random';
}

function normalizePrivacyReintroductionMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['never', 'disabled', 'off', 'no-restore'].includes(normalized)) return 'never';
  if (['admin-only', 'admin'].includes(normalized)) return 'admin-only';
  return 'trusted-view';
}

function normalizePrivacyDetectorActions(value = {}, fallback = {}) {
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

function normalizePrivacyDictionary(entries = []) {
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

function normalizePrivacyCustomPatterns(entries = [], { strict = false } = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const type = normalizePrivacyType(entry.type || entry.label || 'custom');
      const pattern = String(entry.pattern || '').trim();
      if (!pattern) return null;
      const flags = normalizeRegexFlags(entry.flags || 'gi');
      try {
        assertValidPrivacyRegex(pattern, flags);
      } catch (error) {
        if (strict) throw error;
        return null;
      }
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

function normalizePrivacyAuditCriteria(value = {}, fallback = {}, profile = 'baseline') {
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

function normalizePrivacyRelationshipCalculations(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallbackSource = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  const maxRows = parseBoundedPositiveInteger(source.maxRows ?? fallbackSource.maxRows ?? 1000, 1000, 100000);
  const maxCells = parseBoundedPositiveInteger(source.maxCells ?? fallbackSource.maxCells ?? 20000, 20000, 1000000);
  return {
    enabled: source.enabled !== undefined ? Boolean(source.enabled) : fallbackSource.enabled !== false,
    autoDetect: source.autoDetect !== undefined ? Boolean(source.autoDetect) : fallbackSource.autoDetect !== false,
    allowExplicitRequest: source.allowExplicitRequest !== undefined
      ? Boolean(source.allowExplicitRequest)
      : fallbackSource.allowExplicitRequest !== false,
    maxRows,
    maxCells,
  };
}

function normalizePrivacyPiiSettings(value = {}, fallback = DEFAULT_PRIVACY_PII_SETTINGS, options = {}) {
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
    placeholderMode: normalizePrivacyPlaceholderMode(source.placeholderMode || fallback.placeholderMode),
    reintroductionMode: normalizePrivacyReintroductionMode(source.reintroductionMode || fallback.reintroductionMode),
    failClosed: source.failClosed !== undefined ? Boolean(source.failClosed) : fallback.failClosed !== false,
    detectors: sourceDetectors
      ? sourceDetectors
      : [...fallback.detectors],
    detectorActions: normalizePrivacyDetectorActions(source.detectorActions, fallback.detectorActions),
    customPatterns: normalizePrivacyCustomPatterns(source.customPatterns, { strict: options.strictCustomPatterns === true }),
    dictionary: normalizePrivacyDictionary(source.dictionary),
    enablePersonNames: source.enablePersonNames !== undefined
      ? source.enablePersonNames === true
      : sourceDetectors
        ? sourceDetectors.includes('personName')
        : fallback.enablePersonNames === true,
    auditProfile,
    auditCriteria: normalizePrivacyAuditCriteria(source.auditCriteria, fallback.auditCriteria, auditProfile),
    relationshipCalculations: normalizePrivacyRelationshipCalculations(
      source.relationshipCalculations,
      fallback.relationshipCalculations,
    ),
  };
}

function resolvePrivacyAction(type = '', settings = {}) {
  const actions = settings.detectorActions && typeof settings.detectorActions === 'object' && !Array.isArray(settings.detectorActions)
    ? settings.detectorActions
    : {};
  const canonicalType = normalizePrivacyType(type, '');
  const defaultAction = NON_RESTORABLE_IDENTITY_TYPES.has(canonicalType) ? 'mask' : 'vault-placeholder';
  return normalizePrivacyAction(actions[canonicalType] || actions[type] || actions.default || defaultAction, defaultAction);
}

function resolvePrivacyMatchAction(match = {}, settings = {}) {
  if (match.action !== undefined) return normalizePrivacyAction(match.action);
  return resolvePrivacyAction(match.type, settings);
}

function buildPreviewPlaceholder(type = '', action = 'vault-placeholder', index = 0, settings = {}) {
  if (settings.placeholderMode !== 'typed-random') {
    return `[[PII:PREVIEW_${index + 1}]]`;
  }
  const token = String(type || 'PII').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'PII';
  if (action === 'remove') return `[[PII:${token}:REMOVED]]`;
  if (action === 'mask') return `[[PII:${token}:MASKED]]`;
  return `[[PII:${token}:PREVIEW_${index + 1}]]`;
}

function buildPrivacyAuditStatus(settings = {}) {
  const criteria = normalizePrivacyAuditCriteria(settings.auditCriteria, DEFAULT_PRIVACY_PII_SETTINGS.auditCriteria, settings.auditProfile || 'baseline');
  const detectors = new Set((Array.isArray(settings.detectors) ? settings.detectors : []).map((entry) => normalizePrivacyType(entry, '')).filter(Boolean));
  if (settings.enablePersonNames === true) {
    detectors.add('personName');
  }

  const missingRequiredDetectors = criteria.requiredDetectors.filter((detector) => {
    if (!detectors.has(detector)) return true;
    return resolvePrivacyAction(detector, settings) === 'ignore';
  });
  const vaultConfigured = Boolean(String(process.env.KIMIBUILT_PII_MASTER_KEY || '').trim());
  const checks = {
    requiredDetectors: missingRequiredDetectors.length === 0,
    vaultKey: !criteria.requireVaultKey || vaultConfigured,
    failClosed: !criteria.requireFailClosed || settings.failClosed !== false,
    restoreHighlight: !criteria.requireRestoreHighlight || settings.highlightRestored !== false,
  };

  return {
    profile: settings.auditProfile || 'baseline',
    pass: Object.values(checks).every(Boolean),
    checks,
    missingRequiredDetectors,
    criteria,
  };
}

function normalizeManagedAppDeployTarget(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['runner', 'remote-runner', 'remote_runner', 'agent-runner', 'agent_runner'].includes(normalized)) {
    return 'runner';
  }
  if (['ssh', 'remote', 'remote-ssh', 'remote_ssh'].includes(normalized)) {
    return 'ssh';
  }
  if (['in-cluster', 'in_cluster', 'cluster', 'local-cluster', 'local_cluster'].includes(normalized)) {
    return 'ssh';
  }
  return '';
}

function hasUsableSshDefaults(ssh = {}) {
  return Boolean(
    ssh?.enabled !== false
    && ssh?.host
    && ssh?.username
    && (ssh?.password || ssh?.privateKeyPath),
  );
}

function resolvePreferredManagedAppDeployTarget({ storedTarget = '', configuredTarget = '', ssh = {} } = {}) {
  const stored = normalizeManagedAppDeployTarget(storedTarget);
  if (stored) {
    return stored;
  }
  const configured = normalizeManagedAppDeployTarget(configuredTarget);
  if (configured) {
    return configured;
  }
  return 'ssh';
}

class SettingsController {
  constructor() {
    this.settings = {
      general: {
        appName: 'LillyBuilt Agent SDK',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateFormat: 'YYYY-MM-DD HH:mm:ss',
        dataRetention: 30, // days
        maxTasks: 10000,
        maxStorage: '1GB'
      },
      features: {
        enableTracing: true,
        enableSkills: true,
        enableDebug: false,
        autoSave: true,
        realTimeUpdates: true
      },
      api: {
        baseURL: process.env.API_BASE_URL || 'http://localhost:3000',
        timeout: 30000,
        maxRetries: 3,
        retryDelay: 1000,
        enableCORS: true,
        allowedOrigins: ['http://localhost:3000', 'http://localhost:8080']
      },
      models: {
        defaultModel: 'gpt-4o',
        fallbackModel: '',
        maxTokens: 4096,
        temperature: 0.7
      },
      orchestration: {
        enabled: true,
        defaultModel: 'gpt-5.5',
        fallbackModels: ['gemini-3.1-pro', 'groq-compound'],
        plannerModel: 'gpt-5.5',
        synthesisModel: 'gpt-5.5',
        repairModel: 'gpt-5.5',
        evaluatorModel: 'gpt-5.5',
        plannerReasoningEffort: 'high',
        synthesisReasoningEffort: 'medium',
        repairReasoningEffort: 'high',
        evaluatorReasoningEffort: 'medium',
        enableAlignmentEvaluator: true,
        applyAlignmentGuidance: true,
      },
      personality: {
        enabled: true,
        displayName: 'Agent Soul'
      },
      agentNotes: {
        enabled: true,
        displayName: 'Carryover Notes'
      },
      audioProcessing: {
        podcastIntroPath: config.audioProcessing?.podcastIntroPath || '',
        podcastOutroPath: config.audioProcessing?.podcastOutroPath || '',
        podcastMusicBedPath: config.audioProcessing?.podcastMusicBedPath || '',
        podcastAssets: {},
      },
      notifications: {
        enableEmail: false,
        enableWebhook: false,
        webhookURL: '',
        emailRecipients: [],
        notifyOnError: true,
        notifyOnSuccess: false
      },
      security: {
        requireAuth: false,
        apiKeyRequired: false,
        rateLimiting: true,
        rateLimit: 100, // requests per minute
        allowedIPs: []
      },
      privacyPii: {
        ...DEFAULT_PRIVACY_PII_SETTINGS,
      },
      integrations: {
        ssh: {
          enabled: false,
          host: '',
          port: 22,
          username: '',
          password: '',
          privateKeyPath: '',
        },
        deploy: {
          repositoryUrl: config.deploy.defaultRepositoryUrl || '',
          targetDirectory: config.deploy.defaultTargetDirectory || '',
          manifestsPath: config.deploy.defaultManifestsPath || 'k8s',
          namespace: config.deploy.defaultNamespace || 'kimibuilt',
          deployment: config.deploy.defaultDeployment || 'backend',
          container: config.deploy.defaultContainer || 'backend',
          branch: config.deploy.defaultBranch || 'master',
          publicDomain: config.deploy.defaultPublicDomain || 'demoserver2.buzz',
          ingressClassName: config.deploy.defaultIngressClassName || 'traefik',
          tlsClusterIssuer: config.deploy.defaultTlsClusterIssuer || 'letsencrypt-prod',
        },
        gitea: {
          enabled: config.gitea.enabled !== false,
          baseURL: config.gitea.baseURL || '',
          token: config.gitea.token || '',
          webhookSecret: config.gitea.webhookSecret || '',
          org: config.gitea.org || 'agent-apps',
          registryHost: config.gitea.registryHost || '',
          registryUsername: config.gitea.registryUsername || '',
          registryPassword: config.gitea.registryPassword || '',
        },
        gitlab: {
          enabled: config.gitlab?.enabled !== false,
          baseURL: config.gitlab?.baseURL || '',
          token: config.gitlab?.token || '',
          webhookSecret: config.gitlab?.webhookSecret || '',
          org: config.gitlab?.org || 'agent-apps',
          registryHost: config.gitlab?.registryHost || 'registry.gitlab.demoserver2.buzz',
          registryUsername: config.gitlab?.registryUsername || '',
          registryPassword: config.gitlab?.registryPassword || '',
          runnerToken: config.gitlab?.runnerToken || '',
        },
        managedApps: {
          enabled: config.managedApps.enabled !== false,
          deployTarget: config.managedApps.deployTarget || 'ssh',
          appBaseDomain: config.managedApps.appBaseDomain || 'demoserver2.buzz',
          namespacePrefix: config.managedApps.namespacePrefix || 'app-',
          platformNamespace: config.managedApps.platformNamespace || 'agent-platform',
          platformRuntimeSecretName: config.managedApps.platformRuntimeSecretName || 'agent-platform-runtime',
          defaultBranch: config.managedApps.defaultBranch || 'main',
          defaultContainerPort: config.managedApps.defaultContainerPort || 80,
          registryPullSecretName: config.managedApps.registryPullSecretName || 'gitlab-registry-credentials',
          webhookEndpointPath: config.managedApps.webhookEndpointPath || '/api/integrations/gitlab/build-events',
        }
      }
    };

    this.loadSettings().catch((error) => {
      console.warn('[Settings] Using default dashboard settings:', error.message);
    });
  }

  /**
   * Get all settings
   */
  async getAll(req, res) {
    try {
      res.json({
        success: true,
        data: this.getPublicSettings()
      });
    } catch (error) {
      console.error('Error getting settings:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Update settings
   */
  async update(req, res) {
    try {
      const updates = JSON.parse(JSON.stringify(req.body || {}));
      this.applyPersonalityUpdate(updates);
      this.applyAgentNotesUpdate(updates);
      const normalizedUpdates = this.normalizeIncomingSettings(updates);

      // Deep merge settings
      this.settings = this.deepMerge(this.settings, normalizedUpdates);
      if (this.settings?.integrations?.opencode) {
        delete this.settings.integrations.opencode;
      }

      // Save to file (optional persistence)
      await this.saveSettings();
      this.applyAudioProcessingSettingsToRuntime();

      res.json({
        success: true,
        data: this.getPublicSettings(),
        message: 'Settings updated successfully'
      });
    } catch (error) {
      console.error('Error updating settings:', error);
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  previewPrivacyPii(req, res) {
    try {
      const sampleText = String(req.body?.sampleText || req.body?.text || '').slice(0, 20000);
      const baseSettings = this.getEffectivePrivacyPiiConfig();
      const candidateSettings = normalizePrivacyPiiSettings(req.body?.settings || baseSettings, baseSettings, {
        strictCustomPatterns: true,
      });
      const matches = detectPii(sampleText, candidateSettings)
        .map((match, index) => {
          const action = resolvePrivacyMatchAction(match, candidateSettings);
          return {
            type: match.type,
            source: match.source || 'builtin',
            start: match.start,
            end: match.end,
            length: Math.max(0, Number(match.end || 0) - Number(match.start || 0)),
            action,
            restorable: action === 'vault-placeholder',
            placeholder: buildPreviewPlaceholder(match.type, action, index, candidateSettings),
          };
        })
        .filter((match) => match.action !== 'ignore');

      let sanitizedText = sampleText;
      [...matches].reverse().forEach((match) => {
        sanitizedText = `${sanitizedText.slice(0, match.start)}${match.placeholder}${sanitizedText.slice(match.end)}`;
      });

      const countsByType = matches.reduce((acc, match) => {
        acc[match.type] = (acc[match.type] || 0) + 1;
        return acc;
      }, {});
      const countsByAction = matches.reduce((acc, match) => {
        acc[match.action] = (acc[match.action] || 0) + 1;
        return acc;
      }, {});

      res.json({
        success: true,
        data: {
          sanitizedText,
          changed: sanitizedText !== sampleText,
          matchCount: matches.length,
          placeholderMode: candidateSettings.placeholderMode,
          exposesTypeContext: candidateSettings.placeholderMode === 'typed-random',
          matches,
          countsByType,
          countsByAction,
          auditStatus: buildPrivacyAuditStatus(candidateSettings),
        },
      });
    } catch (error) {
      console.error('Error previewing PII policy:', error);
      res.status(400).json({ success: false, error: error.message });
    }
  }

  /**
   * Reset settings to defaults
   */
  async reset(req, res) {
    try {
      const { section } = req.body;

      if (section && this.settings[section]) {
        // Reset specific section
        this.settings[section] = this.getDefaultSettings()[section];
        if (section === 'personality') {
          resetSoulFile();
        }
        if (section === 'agentNotes') {
          resetAgentNotesFile();
        }
      } else {
        // Reset all
        this.settings = this.getDefaultSettings();
        resetSoulFile();
        resetAgentNotesFile();
      }

      await this.saveSettings();

      res.json({
        success: true,
        data: this.getPublicSettings(),
        message: section ? `${section} settings reset` : 'All settings reset'
      });
    } catch (error) {
      console.error('Error resetting settings:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Clear system cache
   */
  async clearCache(req, res) {
    try {
      // Clear various caches
      const cleared = {
        tasks: 0,
        sessions: 0,
        logs: 0,
        traces: 0
      };

      // This would integrate with actual cache clearing logic
      // For now, just return success

      res.json({
        success: true,
        data: {
          cleared,
          timestamp: new Date().toISOString()
        },
        message: 'Cache cleared successfully'
      });
    } catch (error) {
      console.error('Error clearing cache:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Deep merge objects
   */
  deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
          result[key] = this.deepMerge(result[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }

    return result;
  }

  upgradeStoredSettingsDefaults(stored = {}) {
    const next = JSON.parse(JSON.stringify(stored || {}));
    const privacyPii = next.privacyPii;
    if (!privacyPii || typeof privacyPii !== 'object' || Array.isArray(privacyPii)) {
      return next;
    }

    const defaultsVersion = Number(privacyPii.defaultsVersion || 0);
    if (defaultsVersion >= 6) {
      return next;
    }

    const existingDetectors = Array.isArray(privacyPii.detectors)
      ? privacyPii.detectors.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [...DEFAULT_PRIVACY_PII_SETTINGS.detectors];
    const detectorSet = new Set(existingDetectors);
    detectorSet.add('personName');
    detectorSet.add('organization');
    detectorSet.add('medicalRecordNumber');
    detectorSet.add('patientIdentifier');
    detectorSet.add('healthCardNumber');
    detectorSet.add('socialInsuranceNumber');
    detectorSet.add('postalCode');
    const existingRequired = Array.isArray(privacyPii.auditCriteria?.requiredDetectors)
      ? privacyPii.auditCriteria.requiredDetectors.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [...DEFAULT_PRIVACY_PII_SETTINGS.auditCriteria.requiredDetectors];
    const requiredSet = new Set(existingRequired);
    requiredSet.add('personName');
    requiredSet.add('organization');
    requiredSet.add('medicalRecordNumber');
    requiredSet.add('patientIdentifier');
    requiredSet.add('healthCardNumber');
    requiredSet.add('socialInsuranceNumber');
    requiredSet.add('postalCode');

    next.privacyPii = {
      ...privacyPii,
      defaultsVersion: 6,
      enabled: true,
      placeholderMode: privacyPii.placeholderMode === 'stable-per-value'
        ? 'stable-per-value'
        : 'opaque-random',
      detectors: Array.from(detectorSet),
      enablePersonNames: true,
      auditProfile: privacyPii.auditProfile === 'custom' ? 'custom' : 'strict',
      auditCriteria: {
        ...(privacyPii.auditCriteria && typeof privacyPii.auditCriteria === 'object' && !Array.isArray(privacyPii.auditCriteria)
          ? privacyPii.auditCriteria
          : {}),
        requiredDetectors: Array.from(requiredSet),
      },
      relationshipCalculations: normalizePrivacyRelationshipCalculations(
        privacyPii.relationshipCalculations,
        DEFAULT_PRIVACY_PII_SETTINGS.relationshipCalculations,
      ),
    };
    return next;
  }

  /**
   * Save settings to file
   */
  async saveSettings() {
    if (this.canUsePostgresSettings()) {
      try {
        await postgres.query(
          `
            INSERT INTO app_settings (key, value, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (key)
            DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          `,
          ['dashboard', JSON.stringify(this.settings)],
        );
        return;
      } catch (error) {
        console.warn('[Settings] Failed to save dashboard settings to Postgres, falling back to file:', error.message);
      }
    }

    try {
      const settingsPath = this.getSettingsPath();
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  /**
   * Load settings from file
   */
  async loadSettings() {
    if (this.canUsePostgresSettings()) {
      try {
        const result = await postgres.query('SELECT value FROM app_settings WHERE key = $1', ['dashboard']);
        const stored = result.rows?.[0]?.value;
        if (stored && typeof stored === 'object') {
          this.settings = this.deepMerge(this.getDefaultSettings(), this.upgradeStoredSettingsDefaults(stored));
          if (this.settings?.integrations?.opencode) {
            delete this.settings.integrations.opencode;
          }
          this.applyAudioProcessingSettingsToRuntime();
          return;
        }
      } catch (error) {
        console.warn('[Settings] Failed to load dashboard settings from Postgres, falling back to file:', error.message);
      }
    }

    try {
      const settingsPath = this.getSettingsPath();
      const data = await fs.readFile(settingsPath, 'utf8');
      this.settings = this.deepMerge(this.getDefaultSettings(), this.upgradeStoredSettingsDefaults(JSON.parse(data)));
      if (this.settings?.integrations?.opencode) {
        delete this.settings.integrations.opencode;
      }
      this.applyAudioProcessingSettingsToRuntime();
    } catch (error) {
      // Use defaults if file doesn't exist
      if (process.env.NODE_ENV !== 'test' && process.env.KIMIBUILT_SUPPRESS_SETTINGS_LOG !== 'true') {
        console.log('Using default settings');
      }
    }
  }

  canUsePostgresSettings() {
    return Boolean(postgres?.getStatus?.().initialized);
  }

  normalizeIncomingSettings(updates = {}) {
    const normalized = JSON.parse(JSON.stringify(updates || {}));
    if (normalized.integrations?.opencode) {
      delete normalized.integrations.opencode;
    }
    const personalityUpdate = normalized.personality;

    if (personalityUpdate && typeof personalityUpdate === 'object') {
      const currentPersonality = this.settings?.personality || {};
      const nextPersonality = {
        ...personalityUpdate,
      };

      if (nextPersonality.enabled !== undefined) {
        nextPersonality.enabled = Boolean(nextPersonality.enabled);
      }

      if (nextPersonality.displayName !== undefined) {
        nextPersonality.displayName = String(nextPersonality.displayName || '').trim()
          || currentPersonality.displayName
          || 'Agent Soul';
      }

      delete nextPersonality.content;
      delete nextPersonality.defaultContent;
      delete nextPersonality.filePath;
      delete nextPersonality.absoluteFilePath;
      delete nextPersonality.updatedAt;
      delete nextPersonality.source;

      if (Object.keys(nextPersonality).length === 0) {
        delete normalized.personality;
      } else {
        normalized.personality = nextPersonality;
      }
    }
    const agentNotesUpdate = normalized.agentNotes;

    if (agentNotesUpdate && typeof agentNotesUpdate === 'object') {
      const currentAgentNotes = this.settings?.agentNotes || {};
      const nextAgentNotes = {
        ...agentNotesUpdate,
      };

      if (nextAgentNotes.enabled !== undefined) {
        nextAgentNotes.enabled = Boolean(nextAgentNotes.enabled);
      }

      if (nextAgentNotes.displayName !== undefined) {
        nextAgentNotes.displayName = String(nextAgentNotes.displayName || '').trim()
          || currentAgentNotes.displayName
          || 'Carryover Notes';
      }

      delete nextAgentNotes.content;
      delete nextAgentNotes.defaultContent;
      delete nextAgentNotes.filePath;
      delete nextAgentNotes.absoluteFilePath;
      delete nextAgentNotes.updatedAt;
      delete nextAgentNotes.source;
      delete nextAgentNotes.characterLimit;
      delete nextAgentNotes.characterCount;

      if (Object.keys(nextAgentNotes).length === 0) {
        delete normalized.agentNotes;
      } else {
        normalized.agentNotes = nextAgentNotes;
      }
    }
    const sshUpdate = normalized.integrations?.ssh;

    if (sshUpdate) {
      const currentSsh = this.settings?.integrations?.ssh || {};
      const nextSsh = {
        ...sshUpdate,
      };

      if (nextSsh.host !== undefined) {
        nextSsh.host = String(nextSsh.host || '').trim();
      }

      if (nextSsh.username !== undefined) {
        nextSsh.username = String(nextSsh.username || '').trim();
      }

      if (nextSsh.privateKeyPath !== undefined) {
        nextSsh.privateKeyPath = String(nextSsh.privateKeyPath || '').trim();
      }

      if (nextSsh.port !== undefined) {
        const parsedPort = parseInt(nextSsh.port, 10);
        nextSsh.port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : (currentSsh.port || 22);
      }

      if (nextSsh.enabled !== undefined) {
        nextSsh.enabled = Boolean(nextSsh.enabled);
      }

      const clearPassword = Boolean(nextSsh.clearPassword);
      delete nextSsh.clearPassword;
      delete nextSsh.hasPassword;
      delete nextSsh.source;
      delete nextSsh.configured;

      if (clearPassword) {
        nextSsh.password = '';
      } else if (nextSsh.password === undefined || nextSsh.password === null || nextSsh.password === '') {
        nextSsh.password = currentSsh.password || '';
      } else {
        nextSsh.password = String(nextSsh.password);
      }

      normalized.integrations = {
        ...(normalized.integrations || {}),
        ssh: nextSsh,
      };
    }

    const deployUpdate = normalized.integrations?.deploy;
    const giteaUpdate = normalized.integrations?.gitea;
    const gitlabUpdate = normalized.integrations?.gitlab;
    const managedAppsUpdate = normalized.integrations?.managedApps;
    const orchestrationUpdate = normalized.orchestration;
    const privacyPiiUpdate = normalized.privacyPii;
    if (orchestrationUpdate && typeof orchestrationUpdate === 'object') {
      normalized.orchestration = this.normalizeOrchestrationSettings(orchestrationUpdate);
    }
    if (privacyPiiUpdate && typeof privacyPiiUpdate === 'object') {
      normalized.privacyPii = normalizePrivacyPiiSettings(
        privacyPiiUpdate,
        this.settings?.privacyPii || DEFAULT_PRIVACY_PII_SETTINGS,
        { strictCustomPatterns: true },
      );
    }

    if (deployUpdate) {
      const currentDeploy = this.settings?.integrations?.deploy || {};
      const nextDeploy = {
        ...deployUpdate,
      };

      [
        'repositoryUrl',
        'targetDirectory',
        'manifestsPath',
        'namespace',
        'deployment',
        'container',
        'branch',
        'publicDomain',
        'ingressClassName',
        'tlsClusterIssuer',
      ].forEach((key) => {
        if (nextDeploy[key] !== undefined) {
          nextDeploy[key] = String(nextDeploy[key] || '').trim();
        }
      });

      normalized.integrations = {
        ...(normalized.integrations || {}),
        deploy: {
          ...currentDeploy,
          ...nextDeploy,
        },
      };
    }

    if (giteaUpdate) {
      const currentGitea = this.settings?.integrations?.gitea || {};
      const nextGitea = {
        ...giteaUpdate,
      };

      [
        'baseURL',
        'token',
        'webhookSecret',
        'org',
        'registryHost',
        'registryUsername',
        'registryPassword',
      ].forEach((key) => {
        if (nextGitea[key] !== undefined) {
          nextGitea[key] = String(nextGitea[key] || '').trim();
        }
      });

      if (nextGitea.enabled !== undefined) {
        nextGitea.enabled = Boolean(nextGitea.enabled);
      }

      normalized.integrations = {
        ...(normalized.integrations || {}),
        gitea: {
          ...currentGitea,
          ...nextGitea,
        },
      };
    }

    if (gitlabUpdate) {
      const currentGitlab = this.settings?.integrations?.gitlab || {};
      const nextGitlab = {
        ...gitlabUpdate,
      };

      [
        'baseURL',
        'token',
        'webhookSecret',
        'org',
        'registryHost',
        'registryUsername',
        'registryPassword',
        'runnerToken',
      ].forEach((key) => {
        if (nextGitlab[key] !== undefined) {
          nextGitlab[key] = String(nextGitlab[key] || '').trim();
        }
      });

      if (nextGitlab.enabled !== undefined) {
        nextGitlab.enabled = Boolean(nextGitlab.enabled);
      }

      normalized.integrations = {
        ...(normalized.integrations || {}),
        gitlab: {
          ...currentGitlab,
          ...nextGitlab,
        },
      };
    }

    if (managedAppsUpdate) {
      const currentManagedApps = this.settings?.integrations?.managedApps || {};
      const nextManagedApps = {
        ...managedAppsUpdate,
      };

      [
        'deployTarget',
        'appBaseDomain',
        'namespacePrefix',
        'platformNamespace',
        'platformRuntimeSecretName',
        'defaultBranch',
        'registryPullSecretName',
        'webhookEndpointPath',
      ].forEach((key) => {
        if (nextManagedApps[key] !== undefined) {
          nextManagedApps[key] = String(nextManagedApps[key] || '').trim();
        }
      });

      if (nextManagedApps.deployTarget !== undefined) {
        nextManagedApps.deployTarget = normalizeManagedAppDeployTarget(nextManagedApps.deployTarget) || 'ssh';
      }

      if (nextManagedApps.enabled !== undefined) {
        nextManagedApps.enabled = Boolean(nextManagedApps.enabled);
      }
      if (nextManagedApps.defaultContainerPort !== undefined) {
        const parsedPort = parseInt(nextManagedApps.defaultContainerPort, 10);
        nextManagedApps.defaultContainerPort = Number.isFinite(parsedPort) && parsedPort > 0
          ? parsedPort
          : (currentManagedApps.defaultContainerPort || 80);
      }

      normalized.integrations = {
        ...(normalized.integrations || {}),
        managedApps: {
          ...currentManagedApps,
          ...nextManagedApps,
        },
      };
    }

    return normalized;
  }

  normalizeOrchestrationSettings(value = {}) {
    const current = this.settings?.orchestration || this.getDefaultSettings().orchestration;
    const next = {
      ...current,
      ...value,
    };

    next.enabled = value.enabled !== undefined ? Boolean(value.enabled) : current.enabled !== false;
    [
      'defaultModel',
      'plannerModel',
      'synthesisModel',
      'repairModel',
      'evaluatorModel',
      'plannerReasoningEffort',
      'synthesisReasoningEffort',
      'repairReasoningEffort',
      'evaluatorReasoningEffort',
    ].forEach((key) => {
      if (next[key] !== undefined) {
        next[key] = String(next[key] || '').trim();
      }
    });
    next.enableAlignmentEvaluator = value.enableAlignmentEvaluator !== undefined
      ? Boolean(value.enableAlignmentEvaluator)
      : current.enableAlignmentEvaluator !== false;
    next.applyAlignmentGuidance = value.applyAlignmentGuidance !== undefined
      ? Boolean(value.applyAlignmentGuidance)
      : current.applyAlignmentGuidance !== false;

    next.fallbackModels = this.normalizeStringArray(
      value.fallbackModels ?? value.fallbackModelList ?? next.fallbackModels,
      current.fallbackModels || [],
    );

    return next;
  }

  getPublicSettings() {
    const publicSettings = JSON.parse(JSON.stringify(this.settings));
    const ssh = publicSettings.integrations?.ssh;
    const authEnabled = Boolean(config.auth.username && config.auth.password && config.auth.jwtSecret);
    publicSettings.personality = this.getEffectivePersonalityConfig();
    publicSettings.agentNotes = this.getEffectiveAgentNotesConfig();
    publicSettings.audioProcessing = this.getPublicAudioProcessingConfig();

    if (ssh) {
      const effective = this.getEffectiveSshConfig();
      delete ssh.password;
      ssh.enabled = Boolean(effective.enabled);
      ssh.hasPassword = Boolean(effective.password);
      ssh.configured = Boolean(effective.enabled && effective.host && effective.username && (effective.password || effective.privateKeyPath));
      ssh.source = effective.source;
      ssh.privateKeyPath = effective.privateKeyPath || '';
      ssh.host = effective.host || '';
      ssh.port = effective.port || 22;
      ssh.username = effective.username || '';
    }

    if (publicSettings.integrations?.deploy) {
      publicSettings.integrations.deploy = this.getEffectiveDeployConfig();
    }

    if (publicSettings.integrations?.gitea) {
      publicSettings.integrations.gitea = this.getPublicGiteaConfig();
    }

    if (publicSettings.integrations?.gitlab) {
      publicSettings.integrations.gitlab = this.getPublicGitLabConfig();
    }

    if (publicSettings.integrations?.managedApps) {
      publicSettings.integrations.managedApps = this.getEffectiveManagedAppsConfig();
    }

    if (publicSettings.security) {
      publicSettings.security.requireAuth = authEnabled;
    }
    publicSettings.orchestration = this.getEffectiveOrchestrationConfig();
    publicSettings.privacyPii = this.getEffectivePrivacyPiiConfig();
    if (publicSettings.integrations?.opencode) {
      delete publicSettings.integrations.opencode;
    }

    return publicSettings;
  }

  applyAudioProcessingSettingsToRuntime() {
    try {
      const { audioProcessingService } = require('../../audio/audio-processing-service');
      const audioSettings = this.settings?.audioProcessing || {};
      audioProcessingService.updateConfig?.({
        podcastIntroPath: audioSettings.podcastIntroPath || config.audioProcessing?.podcastIntroPath || '',
        podcastOutroPath: audioSettings.podcastOutroPath || config.audioProcessing?.podcastOutroPath || '',
        podcastMusicBedPath: audioSettings.podcastMusicBedPath || config.audioProcessing?.podcastMusicBedPath || '',
      });
    } catch (error) {
      console.warn('[Settings] Failed to apply audio processing settings:', error.message);
    }
  }

  getPublicAudioProcessingConfig() {
    const audioSettings = this.settings?.audioProcessing || {};
    return {
      podcastIntroPath: audioSettings.podcastIntroPath || '',
      podcastOutroPath: audioSettings.podcastOutroPath || '',
      podcastMusicBedPath: audioSettings.podcastMusicBedPath || '',
      podcastAssets: audioSettings.podcastAssets || {},
    };
  }

  getSettingsPath() {
    const configured = String(process.env.KIMIBUILT_SETTINGS_PATH || '').trim();
    if (configured) {
      return path.resolve(path.join(__dirname, '../../..'), configured);
    }

    return resolvePreferredWritableFile(
      path.join(__dirname, '../../../config/dashboard-settings.json'),
      ['dashboard-settings.json'],
    );
  }

  getEffectivePersonalityConfig() {
    return getEffectiveSoulConfig(this.settings?.personality || {});
  }

  getEffectiveAgentNotesConfig() {
    return getEffectiveAgentNotesConfig(this.settings?.agentNotes || {});
  }

  applyPersonalityUpdate(updates = {}) {
    const personalityUpdate = updates?.personality;
    if (!personalityUpdate || typeof personalityUpdate !== 'object') {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(personalityUpdate, 'content')) {
      writeSoulFile(personalityUpdate.content);
    }
  }

  applyAgentNotesUpdate(updates = {}) {
    const agentNotesUpdate = updates?.agentNotes;
    if (!agentNotesUpdate || typeof agentNotesUpdate !== 'object') {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(agentNotesUpdate, 'content')) {
      writeAgentNotesFile(agentNotesUpdate.content);
    }
  }

  getEffectiveSshConfig() {
    const stored = this.settings?.integrations?.ssh || {};
    const envHost = process.env.KIMIBUILT_SSH_HOST || process.env.SSH_HOST || '';
    const envPort = parseInt(process.env.KIMIBUILT_SSH_PORT || process.env.SSH_PORT || '', 10);
    const envUsername = process.env.KIMIBUILT_SSH_USERNAME || process.env.SSH_USERNAME || '';
    const envPassword = process.env.KIMIBUILT_SSH_PASSWORD || process.env.SSH_PASSWORD || '';
    const envPrivateKeyPath = process.env.KIMIBUILT_SSH_KEY_PATH || process.env.SSH_KEY_PATH || '';

    const host = envHost || stored.host || '';
    const username = envUsername || stored.username || '';
    const port = Number.isFinite(envPort) && envPort > 0 ? envPort : (stored.port || 22);
    const password = envPassword || stored.password || '';
    const privateKeyPath = envPrivateKeyPath || stored.privateKeyPath || '';
    const enabled = Boolean(stored.enabled || envHost || envUsername || envPassword || envPrivateKeyPath);
    const source = envHost || envUsername || envPassword || envPrivateKeyPath ? 'cluster-secret' : 'dashboard';

    return {
      enabled,
      host,
      port,
      username,
      password,
      privateKeyPath,
      source,
    };
  }

  getEffectiveOpencodeConfig() {
    return {
      enabled: false,
      binaryPath: '',
      defaultAgent: '',
      defaultModel: '',
      allowedWorkspaceRoots: [],
      remoteDefaultWorkspace: '',
      providerEnvAllowlist: [],
      remoteAutoInstall: false,
    };
  }

  getEffectiveDeployConfig() {
    const stored = this.settings?.integrations?.deploy || {};

    return {
      repositoryUrl: String(stored.repositoryUrl || config.deploy.defaultRepositoryUrl || '').trim(),
      targetDirectory: String(stored.targetDirectory || config.deploy.defaultTargetDirectory || '').trim(),
      manifestsPath: String(stored.manifestsPath || config.deploy.defaultManifestsPath || 'k8s').trim() || 'k8s',
      namespace: String(stored.namespace || config.deploy.defaultNamespace || 'kimibuilt').trim() || 'kimibuilt',
      deployment: String(stored.deployment || config.deploy.defaultDeployment || 'backend').trim() || 'backend',
      container: String(stored.container || config.deploy.defaultContainer || 'backend').trim() || 'backend',
      branch: String(stored.branch || config.deploy.defaultBranch || 'master').trim() || 'master',
      publicDomain: String(stored.publicDomain || config.deploy.defaultPublicDomain || 'demoserver2.buzz').trim() || 'demoserver2.buzz',
      ingressClassName: String(stored.ingressClassName || config.deploy.defaultIngressClassName || 'traefik').trim() || 'traefik',
      tlsClusterIssuer: String(stored.tlsClusterIssuer || config.deploy.defaultTlsClusterIssuer || 'letsencrypt-prod').trim() || 'letsencrypt-prod',
    };
  }

  getEffectiveGiteaConfig() {
    const stored = this.settings?.integrations?.gitea || {};

    return {
      enabled: stored.enabled !== false && config.gitea.enabled !== false,
      baseURL: String(stored.baseURL || config.gitea.baseURL || '').trim(),
      token: String(stored.token || config.gitea.token || '').trim(),
      webhookSecret: String(stored.webhookSecret || config.gitea.webhookSecret || '').trim(),
      org: String(stored.org || config.gitea.org || 'agent-apps').trim() || 'agent-apps',
      registryHost: String(stored.registryHost || config.gitea.registryHost || '').trim(),
      registryUsername: String(stored.registryUsername || config.gitea.registryUsername || '').trim(),
      registryPassword: String(stored.registryPassword || config.gitea.registryPassword || config.gitea.token || '').trim(),
    };
  }

  getEffectiveGitLabConfig() {
    const stored = this.settings?.integrations?.gitlab || {};
    const defaults = config.gitlab || {};

    return {
      provider: 'gitlab',
      enabled: stored.enabled !== false && defaults.enabled !== false,
      baseURL: String(stored.baseURL || defaults.baseURL || '').trim(),
      token: String(stored.token || defaults.token || '').trim(),
      webhookSecret: String(stored.webhookSecret || defaults.webhookSecret || '').trim(),
      org: String(stored.org || defaults.org || 'agent-apps').trim() || 'agent-apps',
      registryHost: String(stored.registryHost || defaults.registryHost || 'registry.gitlab.demoserver2.buzz').trim() || 'registry.gitlab.demoserver2.buzz',
      registryUsername: String(stored.registryUsername || defaults.registryUsername || '').trim(),
      registryPassword: String(stored.registryPassword || defaults.registryPassword || defaults.token || '').trim(),
      runnerToken: String(stored.runnerToken || defaults.runnerToken || '').trim(),
    };
  }

  getEffectiveGitProviderConfig() {
    const gitlab = this.getEffectiveGitLabConfig();
    if (gitlab.enabled !== false && (gitlab.baseURL || gitlab.token || gitlab.registryHost)) {
      return gitlab;
    }

    const gitea = this.getEffectiveGiteaConfig();
    return {
      ...gitea,
      provider: 'gitea',
    };
  }

  getPublicGiteaConfig() {
    const effective = this.getEffectiveGiteaConfig();
    return {
      enabled: effective.enabled,
      configured: Boolean(effective.enabled && effective.baseURL && effective.token),
      hasToken: Boolean(effective.token),
      hasWebhookSecret: Boolean(effective.webhookSecret),
      hasRegistryPassword: Boolean(effective.registryPassword),
      baseURL: effective.baseURL,
      org: effective.org,
      registryHost: effective.registryHost,
      registryUsername: effective.registryUsername,
    };
  }

  getPublicGitLabConfig() {
    const effective = this.getEffectiveGitLabConfig();
    return {
      enabled: effective.enabled,
      configured: Boolean(effective.enabled && effective.baseURL && effective.token),
      hasToken: Boolean(effective.token),
      hasWebhookSecret: Boolean(effective.webhookSecret),
      hasRegistryPassword: Boolean(effective.registryPassword),
      hasRunnerToken: Boolean(effective.runnerToken),
      baseURL: effective.baseURL,
      org: effective.org,
      registryHost: effective.registryHost,
      registryUsername: effective.registryUsername,
    };
  }

  getEffectiveManagedAppsConfig() {
    const stored = this.settings?.integrations?.managedApps || {};
    const ssh = this.getEffectiveSshConfig();

    return {
      enabled: stored.enabled !== false && config.managedApps.enabled !== false,
      deployTarget: resolvePreferredManagedAppDeployTarget({
        storedTarget: stored.deployTarget,
        configuredTarget: config.managedApps.deployTarget,
      }),
      appBaseDomain: String(stored.appBaseDomain || config.managedApps.appBaseDomain || 'demoserver2.buzz').trim() || 'demoserver2.buzz',
      namespacePrefix: String(stored.namespacePrefix || config.managedApps.namespacePrefix || 'app-').trim() || 'app-',
      platformNamespace: String(stored.platformNamespace || config.managedApps.platformNamespace || 'agent-platform').trim() || 'agent-platform',
      platformRuntimeSecretName: String(stored.platformRuntimeSecretName || config.managedApps.platformRuntimeSecretName || 'agent-platform-runtime').trim() || 'agent-platform-runtime',
      defaultBranch: String(stored.defaultBranch || config.managedApps.defaultBranch || 'main').trim() || 'main',
      defaultContainerPort: Number.isFinite(Number(stored.defaultContainerPort))
        ? Math.max(1, Number(stored.defaultContainerPort))
        : Math.max(1, Number(config.managedApps.defaultContainerPort || 80)),
      registryPullSecretName: String(stored.registryPullSecretName || config.managedApps.registryPullSecretName || 'gitlab-registry-credentials').trim() || 'gitlab-registry-credentials',
      webhookEndpointPath: String(stored.webhookEndpointPath || config.managedApps.webhookEndpointPath || '/api/integrations/gitlab/build-events').trim() || '/api/integrations/gitlab/build-events',
    };
  }

  normalizeStringArray(value, fallback = []) {
    const source = Array.isArray(value)
      ? value
      : String(value || '')
        .split(',');
    const normalized = source
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);

    return normalized.length > 0 ? Array.from(new Set(normalized)) : [...fallback];
  }

  getEffectiveOrchestrationConfig() {
    const defaults = this.getDefaultSettings().orchestration;
    const stored = this.settings?.orchestration || {};
    const merged = this.normalizeOrchestrationSettings({
      ...defaults,
      ...stored,
    });

    const envPlanner = String(config.runtime?.plannerModel || '').trim();
    const envSynthesis = String(config.runtime?.synthesisModel || '').trim();
    const envRepair = String(config.runtime?.repairModel || '').trim();
    const envEvaluator = String(config.runtime?.evaluatorModel || '').trim();
    const envPlannerReasoning = String(config.runtime?.plannerReasoningEffort || '').trim();
    const envSynthesisReasoning = String(config.runtime?.synthesisReasoningEffort || '').trim();
    const envRepairReasoning = String(config.runtime?.repairReasoningEffort || '').trim();
    const envEvaluatorReasoning = String(config.runtime?.evaluatorReasoningEffort || '').trim();

    return {
      ...merged,
      plannerModel: envPlanner || merged.plannerModel || merged.defaultModel,
      synthesisModel: envSynthesis || merged.synthesisModel || merged.defaultModel,
      repairModel: envRepair || merged.repairModel || merged.defaultModel,
      evaluatorModel: envEvaluator || merged.evaluatorModel || merged.defaultModel,
      plannerReasoningEffort: envPlannerReasoning || merged.plannerReasoningEffort || 'high',
      synthesisReasoningEffort: envSynthesisReasoning || merged.synthesisReasoningEffort || 'medium',
      repairReasoningEffort: envRepairReasoning || merged.repairReasoningEffort || 'high',
      evaluatorReasoningEffort: envEvaluatorReasoning || merged.evaluatorReasoningEffort || 'medium',
      enableAlignmentEvaluator: merged.enableAlignmentEvaluator !== false,
      applyAlignmentGuidance: merged.applyAlignmentGuidance !== false,
      fallbackModels: this.normalizeStringArray(merged.fallbackModels, defaults.fallbackModels),
      source: this.canUsePostgresSettings() ? 'postgres' : 'file',
    };
  }

  getEffectivePrivacyPiiConfig() {
    const stored = this.settings?.privacyPii || {};
    const settings = {
      ...normalizePrivacyPiiSettings(stored, DEFAULT_PRIVACY_PII_SETTINGS),
      source: this.canUsePostgresSettings() ? 'postgres' : 'file',
      vaultConfigured: Boolean(String(process.env.KIMIBUILT_PII_MASTER_KEY || '').trim()),
    };
    settings.auditStatus = buildPrivacyAuditStatus(settings);
    return settings;
  }

  /**
   * Get default settings
   */
  getDefaultSettings() {
    return {
      general: {
        appName: 'LillyBuilt Agent SDK',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateFormat: 'YYYY-MM-DD HH:mm:ss',
        dataRetention: 30,
        maxTasks: 10000,
        maxStorage: '1GB'
      },
      features: {
        enableTracing: true,
        enableSkills: true,
        enableDebug: false,
        autoSave: true,
        realTimeUpdates: true
      },
      api: {
        baseURL: 'http://localhost:3000',
        timeout: 30000,
        maxRetries: 3,
        retryDelay: 1000,
        enableCORS: true,
        allowedOrigins: ['http://localhost:3000']
      },
      models: {
        defaultModel: 'gpt-4o',
        fallbackModel: '',
        maxTokens: 4096,
        temperature: 0.7
      },
      orchestration: {
        enabled: true,
        defaultModel: 'gpt-5.5',
        fallbackModels: ['gemini-3.1-pro', 'groq-compound'],
        plannerModel: 'gpt-5.5',
        synthesisModel: 'gpt-5.5',
        repairModel: 'gpt-5.5',
        evaluatorModel: 'gpt-5.5',
        plannerReasoningEffort: 'high',
        synthesisReasoningEffort: 'medium',
        repairReasoningEffort: 'high',
        evaluatorReasoningEffort: 'medium',
        enableAlignmentEvaluator: true,
        applyAlignmentGuidance: true,
      },
      personality: {
        enabled: true,
        displayName: 'Agent Soul'
      },
      agentNotes: {
        enabled: true,
        displayName: 'Carryover Notes'
      },
      audioProcessing: {
        podcastIntroPath: config.audioProcessing?.podcastIntroPath || '',
        podcastOutroPath: config.audioProcessing?.podcastOutroPath || '',
        podcastMusicBedPath: config.audioProcessing?.podcastMusicBedPath || '',
        podcastAssets: {},
      },
      notifications: {
        enableEmail: false,
        enableWebhook: false,
        webhookURL: '',
        emailRecipients: [],
        notifyOnError: true,
        notifyOnSuccess: false
      },
      security: {
        requireAuth: false,
        apiKeyRequired: false,
        rateLimiting: true,
        rateLimit: 100,
        allowedIPs: []
      },
      privacyPii: {
        ...DEFAULT_PRIVACY_PII_SETTINGS,
      },
      integrations: {
        ssh: {
          enabled: false,
          host: '',
          port: 22,
          username: '',
          password: '',
          privateKeyPath: '',
        },
        deploy: {
          repositoryUrl: config.deploy.defaultRepositoryUrl || '',
          targetDirectory: config.deploy.defaultTargetDirectory || '',
          manifestsPath: config.deploy.defaultManifestsPath || 'k8s',
          namespace: config.deploy.defaultNamespace || 'kimibuilt',
          deployment: config.deploy.defaultDeployment || 'backend',
          container: config.deploy.defaultContainer || 'backend',
          branch: config.deploy.defaultBranch || 'master',
          publicDomain: config.deploy.defaultPublicDomain || 'demoserver2.buzz',
          ingressClassName: config.deploy.defaultIngressClassName || 'traefik',
          tlsClusterIssuer: config.deploy.defaultTlsClusterIssuer || 'letsencrypt-prod',
        },
        gitea: {
          enabled: config.gitea.enabled !== false,
          baseURL: config.gitea.baseURL || '',
          token: config.gitea.token || '',
          webhookSecret: config.gitea.webhookSecret || '',
          org: config.gitea.org || 'agent-apps',
          registryHost: config.gitea.registryHost || '',
          registryUsername: config.gitea.registryUsername || '',
          registryPassword: config.gitea.registryPassword || '',
        },
        gitlab: {
          enabled: config.gitlab?.enabled !== false,
          baseURL: config.gitlab?.baseURL || '',
          token: config.gitlab?.token || '',
          webhookSecret: config.gitlab?.webhookSecret || '',
          org: config.gitlab?.org || 'agent-apps',
          registryHost: config.gitlab?.registryHost || 'registry.gitlab.demoserver2.buzz',
          registryUsername: config.gitlab?.registryUsername || '',
          registryPassword: config.gitlab?.registryPassword || '',
          runnerToken: config.gitlab?.runnerToken || '',
        },
        managedApps: {
          enabled: config.managedApps.enabled !== false,
          deployTarget: config.managedApps.deployTarget || 'ssh',
          appBaseDomain: config.managedApps.appBaseDomain || 'demoserver2.buzz',
          namespacePrefix: config.managedApps.namespacePrefix || 'app-',
          platformNamespace: config.managedApps.platformNamespace || 'agent-platform',
          platformRuntimeSecretName: config.managedApps.platformRuntimeSecretName || 'agent-platform-runtime',
          defaultBranch: config.managedApps.defaultBranch || 'main',
          defaultContainerPort: config.managedApps.defaultContainerPort || 80,
          registryPullSecretName: config.managedApps.registryPullSecretName || 'gitlab-registry-credentials',
          webhookEndpointPath: config.managedApps.webhookEndpointPath || '/api/integrations/gitlab/build-events',
        }
      }
    };
  }
}

module.exports = new SettingsController();

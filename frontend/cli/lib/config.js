const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.kimibuilt');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  apiBaseUrl: process.env.KIMIBUILT_API_URL || 'http://localhost:3000/v1',
  defaultMode: 'chat',
  defaultModel: 'auto',
  theme: 'default',
  autoSave: true,
  showTimestamps: false,
  streamResponses: true,
  maxHistory: 100,
  confirmQuit: false,
  highlightCode: true,
  imageOutputDir: './images',
  workbenchTarget: 'remote',
  remoteCwd: '',
  remoteDefaultCwd: '',
  lastRepoRoot: '',
  lastCommandResult: null,
  confirmDangerousRemoteCommands: true,
};

const VALID_MODES = ['chat', 'canvas', 'notation'];
const VALID_THEMES = ['default', 'minimal', 'colorful', 'dark'];

const DEFAULT_MODELS = [
  { id: 'auto', name: 'Auto', provider: 'KimiBuilt Router' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'OpenAI' },
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'OpenAI' },
  { id: 'gpt-5.3-instant', name: 'GPT-5.3 Instant', provider: 'OpenAI' },
  { id: 'gpt-5.3', name: 'GPT-5.3', provider: 'OpenAI' },
];

/**
 * Validate a configuration object.
 * @param {Object} config - Configuration to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validate(config) {
  const errors = [];

  if (config.apiBaseUrl) {
    try {
      const url = new URL(config.apiBaseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push('API URL must use http or https protocol');
      }
    } catch {
      errors.push('Invalid API URL format');
    }
  }

  if (config.defaultMode && !VALID_MODES.includes(config.defaultMode)) {
    errors.push(`Invalid mode: ${config.defaultMode}. Must be one of: ${VALID_MODES.join(', ')}`);
  }

  if (config.theme && !VALID_THEMES.includes(config.theme)) {
    errors.push(`Invalid theme: ${config.theme}. Must be one of: ${VALID_THEMES.join(', ')}`);
  }

  if (config.maxHistory !== undefined && (typeof config.maxHistory !== 'number' || config.maxHistory < 1)) {
    errors.push('maxHistory must be a positive number');
  }

  if (config.workbenchTarget && !['remote'].includes(config.workbenchTarget)) {
    errors.push('workbenchTarget must be remote');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Ensure the config directory exists with proper permissions.
 */
function ensureConfigDir() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
  } catch (err) {
    console.error('[Config] Error creating config directory:', err.message);
  }
}

/**
 * Load configuration from file or return defaults.
 * @returns {Object} Configuration object
 */
function load() {
  ensureConfigDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(data);
      const merged = { ...DEFAULT_CONFIG, ...parsed };
      
      // Override with environment variable if set
      if (process.env.KIMIBUILT_API_URL) {
        merged.apiBaseUrl = process.env.KIMIBUILT_API_URL;
      }
      
      return merged;
    }
  } catch (err) {
    console.error('[Config] Error loading config:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save configuration to file.
 * @param {Object} config - Configuration to save
 * @returns {boolean} Success status
 */
function save(config) {
  ensureConfigDir();
  try {
    const validation = validate(config);
    if (!validation.valid) {
      console.error('[Config] Validation errors:', validation.errors.join(', '));
      return false;
    }
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    console.error('[Config] Error saving config:', err.message);
    return false;
  }
}

/**
 * Get a configuration value.
 * @param {string} key - Configuration key
 * @param {*} defaultValue - Default value if not found
 * @returns {*} Configuration value
 */
function get(key, defaultValue = undefined) {
  const config = load();
  return config[key] !== undefined ? config[key] : defaultValue;
}

/**
 * Set a configuration value.
 * @param {string} key - Configuration key
 * @param {*} value - Value to set
 * @returns {boolean} Success status
 */
function set(key, value) {
  const config = load();
  config[key] = value;
  return save(config);
}

/**
 * Reset configuration to defaults.
 * @returns {boolean} Success status
 */
function reset() {
  return save({ ...DEFAULT_CONFIG });
}

/**
 * Get the API base URL.
 * @returns {string} API base URL
 */
function getApiBaseUrl() {
  return get('apiBaseUrl');
}

/**
 * Set the API base URL.
 * @param {string} url - New API base URL
 * @returns {boolean} Success status
 */
function setApiBaseUrl(url) {
  return set('apiBaseUrl', url);
}

/**
 * Get the default mode.
 * @returns {string} Default mode
 */
function getDefaultMode() {
  return get('defaultMode');
}

/**
 * Set the default mode.
 * @param {string} mode - New default mode
 * @returns {boolean} Success status
 */
function setDefaultMode(mode) {
  return set('defaultMode', mode);
}

/**
 * Get the default model.
 * @returns {string|null} Default model ID
 */
function getDefaultModel() {
  return get('defaultModel');
}

/**
 * Set the default model.
 * @param {string} modelId - Model ID
 * @returns {boolean} Success status
 */
function setDefaultModel(modelId) {
  return set('defaultModel', modelId);
}

/**
 * Get the current theme.
 * @returns {string} Theme name
 */
function getTheme() {
  return get('theme');
}

/**
 * Set the theme.
 * @param {string} theme - Theme name
 * @returns {boolean} Success status
 */
function setTheme(theme) {
  return set('theme', theme);
}

/**
 * Get the image output directory.
 * @returns {string} Image output directory
 */
function getImageOutputDir() {
  return get('imageOutputDir', './images');
}

/**
 * Set the image output directory.
 * @param {string} dir - Directory path
 * @returns {boolean} Success status
 */
function setImageOutputDir(dir) {
  return set('imageOutputDir', dir);
}

/**
 * List all configuration options.
 * @returns {Object} All configuration options
 */
function list() {
  return load();
}

module.exports = {
  load,
  save,
  get,
  set,
  reset,
  validate,
  list,
  getApiBaseUrl,
  setApiBaseUrl,
  getDefaultMode,
  setDefaultMode,
  getDefaultModel,
  setDefaultModel,
  getTheme,
  setTheme,
  getImageOutputDir,
  setImageOutputDir,
  CONFIG_DIR,
  VALID_MODES,
  VALID_THEMES,
  DEFAULT_CONFIG,
  DEFAULT_MODELS,
};

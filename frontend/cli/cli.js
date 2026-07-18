#!/usr/bin/env node

const readline = require('readline');
const { marked } = require('marked');
const MarkedTerminal = require('marked-terminal');
const chalk = require('chalk');
const ora = require('ora');
const figlet = require('figlet');
const gradient = require('gradient-string');
const boxen = require('cli-boxes');
const minimist = require('minimist');
const fs = require('fs');
const path = require('path');

const TerminalRenderer = MarkedTerminal.default || MarkedTerminal;
const config = require('./lib/config');
const session = require('./lib/session');
const api = require('./lib/api');
const workbench = require('./lib/workbench');
const {
  formatRemoteAgentArtifactOutput,
  formatRemoteAgentStatusOutput,
  formatRemoteAgentTextOutput,
  formatSessionArtifactLine,
  parseRemoteAgentCommand,
} = require('./lib/remote-agent');
const modelOutputParser = require('../shared/model-output-parser');

// CLI metadata
const CLI_VERSION = '2.2.0';
const CLI_NAME = 'LillyBuilt CLI';

// Gradient presets
const titleGradient = gradient(['#FF6B6B', '#4ECDC4', '#45B7D1']);
const aiGradient = gradient(['#667eea', '#764ba2']);

// State
let currentMode = config.getDefaultMode();
let currentSessionId = session.getCurrent();
let currentModel = null;
let isProcessing = false;
let accumulatedResponse = '';
let shouldShowTimestamps = config.get('showTimestamps', false);
let commandHistory = [];
let historyIndex = -1;
let availableModels = [];
let availableImageModels = [];
let lastImageUrls = [];
let providerCapabilities = [];
let activeProviderSession = null;
let providerStreamAbortController = null;
let providerStreamTask = null;
let readlineInterface = null;
let remoteToolContext = null;

// Command definitions for auto-completion
const COMMANDS = [
  '/new', '/mode', '/history', '/reasoning', '/sessions', '/clear', '/help', '/quit', '/exit',
  '/url', '/config', '/theme', '/export', '/import', '/rename', '/delete',
  '/copy', '/paste', '/undo', '/redo', '/search', '/settings', '/download-image',
  '/models', '/model', '/image', '/img', '/imgmodels', '/providers', '/attach',
  '/podcast', '/video-podcast',
  '/provider-status', '/remote', '/skills', '/skill', '/skill-create', '/skill-update',
  '/.help', '/.status', '/.interrupt', '/.detach'
];

const MODES = ['chat', 'canvas', 'notation'];
const THEMES = ['default', 'minimal', 'colorful', 'dark'];
const DEFAULT_PROMPT = chalk.green.bold('You> ');
const PROVIDER_LOCAL_COMMAND_PREFIX = '/.';
const REMOTE_BUILD_EXECUTION_PROFILE = 'remote-build';
const PROVIDER_ALIASES = {
  codex: 'codex-cli',
  gemini: 'gemini-cli',
  kimi: 'kimi-cli',
};

// Configure marked for terminal output
marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.cyan,
    blockquote: chalk.gray.italic,
    html: chalk.gray,
    heading: chalk.green.bold,
    firstHeading: chalk.magenta.underline.bold,
    hr: chalk.reset,
    listitem: chalk.reset,
    table: chalk.reset,
    paragraph: chalk.reset,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.cyan,
    del: chalk.dim.gray.strikethrough,
    link: chalk.blue.underline,
    href: chalk.blue.underline,
    ref: chalk.gray,
  }),
  gfm: true,
  breaks: true,
});

function normalizeTerminalPresentationMarkdown(text = '') {
  const normalized = modelOutputParser.normalizeModelOutputMarkdown(text);
  return String(normalized || '')
    .split(/(```[\s\S]*?```)/g)
    .map((segment) => {
      if (/^```[\s\S]*```$/.test(segment)) {
        return segment;
      }

      return segment
        .replace(/<mark class="kb-highlight">([\s\S]*?)<\/mark>/g, '**$1**')
        .replace(/<span class="kb-tone kb-tone--(?:accent|success|warning|danger|info|muted)">([\s\S]*?)<\/span>/g, '**$1**')
        .replace(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|SUCCESS|DANGER|INFO)\]\s*(.*)$/gim, (_match, type, title) => {
          const label = String(type || 'note').toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
          const suffix = String(title || '').trim();
          return `> **${label}${suffix ? `: ${suffix}` : ''}**`;
        });
    })
    .join('');
}

/**
 * Print a fancy ASCII banner.
 */
function printBanner() {
  try {
    const asciiTitle = figlet.textSync('LillyBuilt', {
      font: 'Small',
      horizontalLayout: 'default',
    });
    console.log(titleGradient(asciiTitle));
  } catch {
    // Fallback if figlet fails
    console.log(chalk.magenta.bold('\n╔════════════════════════════════════════╗'));
    console.log(chalk.magenta.bold('║         LillyBuilt CLI v2.2.0        ║'));
    console.log(chalk.magenta.bold('╚════════════════════════════════════════╝'));
  }
  
  console.log(chalk.gray(`  Version: ${CLI_VERSION}`));
  console.log(chalk.gray(`  API: ${config.getApiBaseUrl()}`));
  console.log(chalk.gray(`  Mode: ${chalk.cyan(currentMode)}`));
  console.log(chalk.gray(`  Workbench: ${chalk.cyan(config.get('workbenchTarget', 'remote'))} ${chalk.white(config.get('remoteCwd', '') || config.get('remoteDefaultCwd', '') || '/workspace')}`));
  if (currentModel) {
    console.log(chalk.gray(`  Model: ${chalk.cyan(currentModel)}`));
  }
  console.log(chalk.gray(`  Session: ${currentSessionId ? chalk.green(currentSessionId.slice(0, 16) + '...') : chalk.yellow('none (will auto-create)')}`));
  console.log(chalk.gray('\n  Type /help for available commands\n'));
}

/**
 * Print the help message with formatting.
 */
function printHelp() {
  const boxStyle = {
    topLeft: '╔', topRight: '╗', bottomLeft: '╚', bottomRight: '╝',
    horizontal: '═', vertical: '║',
  };
  
  console.log(chalk.cyan.bold('\n┌─ Available Commands ──────────────────┐'));
  
  const commands = [
    ['Command', 'Description'],
    ['/new', 'Create a new session'],
    ['/mode <type>', 'Switch mode (chat|canvas|notation)'],
    ['/models', 'List available chat models'],
    ['/model <id>', 'Set default model'],
    ['/image <prompt>', 'Generate an image'],
    ['/podcast <topic> [--music] [--audio]', 'Create a basic audio podcast'],
    ['/video-podcast <topic> [--music] [--audio]', 'Create a basic video podcast'],
    ['/download-image <url|index> [file]', 'Download an image from URL or last response'],
    ['/imgmodels', 'List image generation models'],
    ['/upload <file>', 'Upload an artifact to the current session'],
    ['/artifacts', 'List session artifacts'],
    ['/download-artifact <id> [file]', 'Download an artifact by ID'],
    ['/makefile <format> <prompt>', 'Generate a file artifact from a prompt'],
    ['/history', 'Show current session ID'],
    ['/reasoning [all]', 'Show saved reasoning summaries for this session'],
    ['/sessions', 'List all sessions'],
    ['/clear', 'Clear the screen'],
    ['/url <url>', 'Set API base URL'],
    ['/config', 'Show current configuration'],
    ['/providers', 'List session-capable backend CLI providers'],
    ['/attach <provider> [cwd]', 'Attach to codex-cli, gemini-cli, or kimi-cli'],
    ['/provider-status', 'Show the active backend CLI session'],
    ['/remote <cmd>', 'Remote CLI status, tools, plan, run, agent, or verify'],
    ['/skills [search]', 'List registered low-context skills'],
    ['/skill <id>', 'Show one registered skill'],
    ['/skill-create <json>', 'Create a reusable skill chain'],
    ['/skill-update <id> <json>', 'Update a reusable skill chain'],
    ['/theme <name>', 'Set theme (default|minimal|colorful|dark)'],
    ['/export <file>', 'Export current session to file'],
    ['/import <file>', 'Import session from file'],
    ['/rename <name>', 'Rename current session'],
    ['/delete <id>', 'Delete a session'],
    ['/copy', 'Copy last AI response to clipboard'],
    ['/settings', 'Interactive settings editor'],
    ['/help', 'Show this help message'],
    ['/quit, /exit', 'Exit the CLI'],
  ];
  
  commands.forEach(([cmd, desc], i) => {
    if (i === 0) {
      console.log(chalk.yellow.bold(`  ${cmd.padEnd(20)} ${desc}`));
      console.log(chalk.gray('  ' + '─'.repeat(37)));
    } else {
      console.log(chalk.gray(`  ${chalk.cyan(cmd.padEnd(20))} ${desc}`));
    }
  });
  
  console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
  console.log(chalk.cyan.bold('Workbench Commands'));
  console.log(chalk.gray('  pwd, cd <dir>, ls [path], tree [path], cat <file>, open <file>'));
  console.log(chalk.gray('  repo, files [path], search <pattern> [path], changes, git status, git diff'));
  console.log(chalk.gray('  install, test, build, run <cmd>'));
  console.log(chalk.cyan.bold('\nDeploy Commands'));
  console.log(chalk.gray('  deploy, rollout, logs, verify [host], status\n'));
  console.log(chalk.gray('Attached backend CLI sessions pass input through verbatim.'));
  console.log(chalk.gray('Use /.help for local escape commands while attached.\n'));
}

/**
 * Print current configuration.
 */
function printConfig() {
  const cfg = config.list();
  console.log(chalk.cyan.bold('\n┌─ Configuration ───────────────────────┐'));
  Object.entries(cfg).forEach(([key, value]) => {
    const normalizedValue = key.toLowerCase().includes('key') && value
      ? `${String(value).slice(0, 4)}••••${String(value).slice(-2)}`
      : value;
    const displayValue = typeof value === 'boolean' 
      ? (value ? chalk.green('true') : chalk.red('false'))
      : chalk.yellow(String(normalizedValue));
    console.log(chalk.gray(`  ${key.padEnd(20)}: ${displayValue}`));
  });
  console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
}

function getPromptValue() {
  return activeProviderSession ? '' : DEFAULT_PROMPT;
}

function updatePrompt() {
  if (!readlineInterface) {
    return;
  }

  readlineInterface.setPrompt(getPromptValue());
}

function redrawPrompt() {
  if (!readlineInterface) {
    return;
  }

  readlineInterface.prompt(true);
}

function writeAsyncOutput(text) {
  const content = String(text || '');
  if (!content) {
    return;
  }

  if (!readlineInterface) {
    process.stdout.write(content);
    return;
  }

  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(content);
  redrawPrompt();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProviderId(providerId) {
  const normalized = String(providerId || '').trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] || normalized;
}

/**
 * Print a spinner message for async operations.
 * @param {string} message - Message to display
 * @returns {Object} Ora spinner instance
 */
function createSpinner(message) {
  return ora({
    text: chalk.yellow(message),
    spinner: 'dots',
    color: 'cyan',
  });
}

/**
 * Fetch available models on startup.
 */
async function fetchModels() {
  try {
    availableModels = await api.getModels();
    if (availableModels.length > 0) {
      console.log(chalk.gray(`[Model] Loaded ${availableModels.length} models from API`));
    }
  } catch (err) {
    // Use defaults silently
    availableModels = config.DEFAULT_MODELS.map(m => ({
      id: m.id,
      object: 'model',
      created: Date.now(),
      owned_by: m.provider,
    }));
  }
  
  // Load default model from config
  const savedModel = config.getDefaultModel();
  if (['gpt-5.4-mini', 'gpt-4o', 'openrouter/auto'].includes(savedModel)) {
    currentModel = config.DEFAULT_CONFIG.defaultModel;
    config.setDefaultModel(currentModel);
  } else if (savedModel === 'auto' || (savedModel && availableModels.some((model) => model.id === savedModel))) {
    currentModel = savedModel;
  } else {
    currentModel = config.DEFAULT_CONFIG.defaultModel || availableModels[0]?.id || config.DEFAULT_MODELS[0]?.id || currentModel;
    if (currentModel) {
      config.setDefaultModel(currentModel);
    }
  }
}

/**
 * Fetch available image models.
 */
async function fetchImageModels() {
  try {
    availableImageModels = await api.getImageModels();
  } catch (err) {
    // Use defaults
    availableImageModels = [
      {
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        description: 'State-of-the-art OpenAI image generation',
        sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
        qualities: ['auto', 'low', 'medium', 'high'],
        styles: [],
        maxImages: 5,
      },
      {
        id: 'gpt-image-1.5',
        name: 'GPT Image 1.5',
        description: 'Previous OpenAI GPT Image release',
        sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
        qualities: ['auto', 'low', 'medium', 'high'],
        styles: [],
        maxImages: 5,
      },
    ];
  }
}

/**
 * Handle the /new command.
 */
async function handleNew() {
  const spinner = createSpinner('Creating new session...');
  spinner.start();
  
  try {
    const newSession = await api.createSession({ mode: currentMode, model: currentModel });
    currentSessionId = newSession.id;
    session.setCurrent(currentSessionId, { mode: currentMode, name: `Session ${new Date().toLocaleDateString()}`, model: currentModel });
    spinner.succeed(chalk.green(`Created new session: ${currentSessionId.slice(0, 16)}...`));
  } catch (err) {
    spinner.fail(chalk.red(`Failed to create session: ${err.message}`));
  }
}

/**
 * Handle the /mode command.
 * @param {string} mode - Mode to switch to
 */
function handleMode(mode) {
  const validModes = config.VALID_MODES;
  if (!validModes.includes(mode)) {
    console.error(chalk.red(`❌ Invalid mode: ${mode}. Use: ${validModes.join(', ')}`));
    return;
  }
  currentMode = mode;
  config.setDefaultMode(mode);
  console.log(chalk.green(`✓ Switched to ${chalk.bold(mode)} mode`));
}

/**
 * Handle the /theme command.
 * @param {string} themeName - Theme to set
 */
function handleTheme(themeName) {
  const validThemes = config.VALID_THEMES;
  if (!themeName) {
    console.log(chalk.cyan(`Current theme: ${chalk.bold(config.getTheme())}`));
    console.log(chalk.gray(`Available: ${validThemes.join(', ')}`));
    return;
  }
  
  if (!validThemes.includes(themeName)) {
    console.error(chalk.red(`❌ Invalid theme: ${themeName}. Use: ${validThemes.join(', ')}`));
    return;
  }
  
  config.setTheme(themeName);
  console.log(chalk.green(`✓ Theme set to ${chalk.bold(themeName)}`));
}

/**
 * Handle the /history command.
 */
function handleHistory() {
  if (currentSessionId) {
    console.log(chalk.cyan('\n┌─ Session Information ─────────────────┐'));
    console.log(chalk.gray(`  ID:        ${chalk.white(currentSessionId)}`));
    console.log(chalk.gray(`  Mode:      ${chalk.cyan(currentMode)}`));
    if (currentModel) {
      console.log(chalk.gray(`  Model:     ${chalk.cyan(currentModel)}`));
    }
    console.log(chalk.gray(`  Short ID:  ${chalk.white(currentSessionId.slice(0, 8))}`));
    console.log(chalk.cyan('└───────────────────────────────────────┘\n'));
  } else {
    console.log(chalk.yellow('⚠ No active session'));
  }
}

function handleReasoningHistory(args = '') {
  if (!currentSessionId) {
    console.log(chalk.yellow('No active session'));
    return;
  }

  const entries = session.getReasoningHistory(currentSessionId);
  if (entries.length === 0) {
    console.log(chalk.yellow('\nNo reasoning summaries saved for this session yet.\n'));
    return;
  }

  const showAll = String(args || '').trim().toLowerCase() === 'all';
  const visibleEntries = showAll ? entries : entries.slice(0, 1);
  console.log(chalk.cyan.bold('\nReasoning History'));
  visibleEntries.forEach((entry, index) => {
    const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'unknown time';
    const prompt = String(entry.prompt || '').replace(/\s+/g, ' ').trim();
    console.log(chalk.gray(`\n[${index + 1}] ${timestamp}${entry.model ? ` | ${entry.model}` : ''}`));
    if (prompt) {
      console.log(chalk.gray(`Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}`));
    }
    console.log(chalk.blueBright(String(entry.text || '').trim()));
  });

  if (!showAll && entries.length > 1) {
    console.log(chalk.gray(`\n${entries.length - 1} older reasoning summar${entries.length - 1 === 1 ? 'y' : 'ies'} hidden. Use /reasoning all to show them.`));
  }
  console.log('');
}

/**
 * Handle the /sessions command.
 */
async function handleSessions() {
  const spinner = createSpinner('Loading sessions...');
  spinner.start();
  
  try {
    const history = session.getHistory();
    spinner.stop();
    
    if (history.length === 0) {
      console.log(chalk.yellow('\nNo sessions found. Create one with /new\n'));
      return;
    }
    
    console.log(chalk.cyan.bold('\n┌─ Session History ─────────────────────┐'));
    history.slice(0, 10).forEach((s, i) => {
      const isCurrent = s.id === currentSessionId;
      const prefix = isCurrent ? chalk.green('●') : chalk.gray('○');
      const name = s.name || `Session ${s.id.slice(0, 8)}`;
      const mode = chalk.gray(`[${s.mode || 'chat'}]`);
      const model = s.model ? chalk.gray(`(${s.model})`) : '';
      const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : 'unknown';
      console.log(chalk.gray(`  ${prefix} ${name.padEnd(20)} ${mode} ${model} ${chalk.gray(date)}`));
      if (isCurrent) {
        console.log(chalk.gray(`    ${chalk.dim(s.id)}`));
      }
    });
    
    if (history.length > 10) {
      console.log(chalk.gray(`  ... and ${history.length - 10} more`));
    }
    console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
  } catch (err) {
    spinner.fail(chalk.red(`Failed to load sessions: ${err.message}`));
  }
}

/**
 * Handle the /clear command.
 */
function handleClear() {
  console.clear();
  printBanner();
}

/**
 * Handle the /url command.
 * @param {string} url - New API URL
 */
function handleUrl(url) {
  if (!url) {
    console.log(chalk.cyan(`Current API URL: ${chalk.bold(config.getApiBaseUrl())}`));
    console.log(chalk.gray('Set with: /url <url>'));
    return;
  }
  
  config.setApiBaseUrl(url);
  console.log(chalk.green(`✓ API URL set to: ${chalk.bold(url)}`));
}

/**
 * Handle the /models command.
 */
function handleModels() {
  if (availableModels.length === 0) {
    console.log(chalk.yellow('⚠ No models available'));
    return;
  }
  
  console.log(chalk.cyan.bold('\n┌─ Available Models ────────────────────┐'));
  availableModels.forEach((model, i) => {
    const isCurrent = currentModel === model.id;
    const prefix = isCurrent ? chalk.green('●') : chalk.gray(`${i + 1}.`);
    const name = chalk.white(model.id);
    const provider = model.owned_by ? chalk.gray(`(${model.owned_by})`) : '';
    console.log(chalk.gray(`  ${prefix} ${name} ${provider}`));
  });
  console.log(chalk.gray('\n  Use /model <id> to select a model'));
  console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
}

/**
 * Handle the /model command.
 * @param {string} modelId - Model ID to set
 */
function handleModel(modelId) {
  if (!modelId) {
    if (currentModel) {
      console.log(chalk.cyan(`Current model: ${chalk.bold(currentModel)}`));
    } else {
      console.log(chalk.yellow('⚠ No model selected. Using server default.'));
    }
    console.log(chalk.gray('Use /models to list available models'));
    return;
  }
  
  // Validate model exists
  const modelExists = availableModels.some(m => m.id === modelId);
  if (!modelExists && availableModels.length > 0) {
    console.error(chalk.red(`❌ Unknown model: ${modelId}`));
    console.log(chalk.gray('Use /models to list available models'));
    return;
  }
  
  currentModel = modelId;
  config.setDefaultModel(modelId);
  console.log(chalk.green(`✓ Model set to: ${chalk.bold(modelId)}`));
}

/**
 * Handle the /imgmodels command.
 */
function handleImgModels() {
  if (availableImageModels.length === 0) {
    console.log(chalk.yellow('⚠ No image models available'));
    return;
  }
  
  console.log(chalk.cyan.bold('\n┌─ Image Generation Models ─────────────┐'));
  availableImageModels.forEach((model, i) => {
    const name = chalk.white(model.name || model.id);
    const description = model.description ? chalk.gray(`- ${model.description}`) : '';
    console.log(chalk.gray(`  ${i + 1}. ${name} ${description}`));
    if (Array.isArray(model.sizes) && model.sizes.length > 0) {
      console.log(chalk.gray(`     Sizes: ${model.sizes.join(', ')}`));
    }
    if (Array.isArray(model.qualities) && model.qualities.length > 0) {
      console.log(chalk.gray(`     Qualities: ${model.qualities.join(', ')}`));
    }
    if (Array.isArray(model.styles) && model.styles.length > 0) {
      console.log(chalk.gray(`     Styles: ${model.styles.join(', ')}`));
    }
  });
  console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
}

/**
 * Parse image generation options from arguments.
 * @param {string[]} args - Command arguments
 * @returns {Object} Parsed options
 */
function parseImageOptions(args) {
  const options = {
    model: null,
    size: 'auto',
    quality: null,
    style: null,
    n: 1,
    output_format: null,
    output_compression: null,
    background: null,
    moderation: null,
    output: null,
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--model':
      case '-m':
        options.model = args[++i];
        break;
      case '--size':
      case '-s':
        options.size = args[++i];
        break;
      case '--quality':
      case '-q':
        options.quality = args[++i];
        break;
      case '--style':
        options.style = args[++i];
        break;
      case '--format':
      case '--output-format':
        options.output_format = args[++i];
        break;
      case '--compression':
        options.output_compression = parseInt(args[++i], 10);
        break;
      case '--background':
        options.background = args[++i];
        break;
      case '--moderation':
        options.moderation = args[++i];
        break;
      case '--n':
      case '-n':
        options.n = parseInt(args[++i], 10) || 1;
        break;
      case '--output':
      case '-o':
        options.output = args[++i];
        break;
    }
  }
  
  return options;
}

function formatImageDiagnostics(diagnostics = null) {
  const imageDiagnostics = diagnostics?.imageGeneration || diagnostics;
  if (!imageDiagnostics || typeof imageDiagnostics !== 'object') {
    return '';
  }

  const counts = imageDiagnostics.counts || {};
  const flags = imageDiagnostics.flags || {};
  const provider = imageDiagnostics.provider || {};
  const transport = imageDiagnostics.transport || {};
  const artifactPersistence = imageDiagnostics.artifactPersistence || {};
  const parts = [
    imageDiagnostics.code || 'image_diagnostics',
    imageDiagnostics.stage ? `stage=${imageDiagnostics.stage}` : '',
    provider.source ? `provider=${provider.source}` : '',
    provider.status ? `providerStatus=${provider.status}` : '',
    transport.category ? `transport=${transport.category}` : '',
    artifactPersistence.primaryReason ? `artifactPersistence=${artifactPersistence.primaryReason}` : '',
    `parsed=${Number(counts.parsedImageRecords || 0)}`,
    `returned=${Number(counts.returnedImageRecords || 0)}`,
    `usable=${Number(counts.usableReturnedImageRecords || 0)}`,
    `artifacts=${Number(counts.artifacts || 0)}`,
  ].filter(Boolean);
  const usableCount = Number(counts.usableReturnedImageRecords || 0);
  const artifactCount = Number(counts.artifacts || 0);
  const likely = (flags.likelyArtifactPersistenceIssue || (usableCount > 0 && artifactCount === 0))
    ? 'Backend parsed usable image data, but no reusable artifact was persisted; inspect artifact persistence/image validation path.'
    : flags.providerSocketClosedByPeer
      ? 'Provider/router closed the socket before an HTTP response completed; inspect gateway logs, upstream connectivity, and proxy timeouts.'
      : flags.likelyFrontendReceiveOrParserIssue
        ? 'Backend sent usable persisted image data; inspect the CLI receive/parser path.'
        : (imageDiagnostics.likelyCause || '');

  return `${parts.join(' | ')}${likely ? ` | ${likely}` : ''}`;
}

function parseImageUrlsFromText(text) {
  const source = String(text || '');
  const urls = new Set();
  const patterns = [
    /<img[^>]+src="([^"]+)"/gi,
    /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi,
    /\bhttps?:\/\/[^\s<>"')]+/gi,
  ];

  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const value = match[1] || match[0];
      if (!value) continue;
      if (/^https?:\/\//i.test(value) && /(?:images\.unsplash\.com|plus\.unsplash\.com|images\.openai\.com|blob\.core\.windows\.net|\.(?:png|jpe?g|webp|gif)(?:\?|$))/i.test(value)) {
        urls.add(value);
      }
    }
  });

  return Array.from(urls);
}

function inferImageExtension(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return '.jpg';
    if (pathname.endsWith('.webp')) return '.webp';
    if (pathname.endsWith('.gif')) return '.gif';
    return '.png';
  } catch {
    return '.png';
  }
}

async function handleDownloadImageCommand(args) {
  const parts = args.split(' ').filter(Boolean);
  const target = parts[0];
  const explicitPath = parts[1];

  if (!target) {
    console.log(chalk.yellow('Usage: /download-image <url|index> [output-file]'));
    return true;
  }

  const combinedCandidates = [...lastImageUrls, ...parseImageUrlsFromText(accumulatedResponse)]
    .filter((value, index, array) => value && array.indexOf(value) === index);

  let imageUrl = target;
  if (/^\d+$/.test(target)) {
    imageUrl = combinedCandidates[Number(target) - 1];
    if (!imageUrl) {
      console.log(chalk.yellow(`No image URL found for index ${target}.`));
      return true;
    }
  }

  if (!/^https?:\/\//i.test(imageUrl)) {
    console.log(chalk.yellow('Please provide a direct image URL or an index from the last image response.'));
    return true;
  }

  const outputPath = explicitPath || `image-${Date.now()}${inferImageExtension(imageUrl)}`;
  const spinner = createSpinner('Downloading image...');
  spinner.start();
  try {
    await api.downloadImage(imageUrl, outputPath);
    spinner.succeed(chalk.green(`Saved to ${outputPath}`));
  } catch (err) {
    spinner.fail(chalk.red(`Image download failed: ${err.message}`));
  }
  return true;
}

/**
 * Handle the /image command.
 * @param {string} args - Command arguments
 */
async function handleImage(args) {
  if (!args.trim()) {
    console.log(chalk.yellow('⚠ Usage: /image <prompt> [--model model-id] [--size auto] [--quality auto|low|medium|high] [--format png|jpeg|webp]'));
    return;
  }
  
  // Extract prompt and options
  const parts = args.split(' ');
  let prompt = '';
  const options = [];
  
  // Simple parsing - look for quoted prompt or treat everything before first -- as prompt
  if (args.startsWith('"')) {
    const endQuote = args.indexOf('"', 1);
    if (endQuote > 0) {
      prompt = args.slice(1, endQuote);
      const remaining = args.slice(endQuote + 1).trim();
      if (remaining) {
        options.push(...remaining.split(' '));
      }
    } else {
      prompt = args;
    }
  } else {
    // Find first option starting with --
    const firstOption = parts.findIndex(p => p.startsWith('--'));
    if (firstOption >= 0) {
      prompt = parts.slice(0, firstOption).join(' ');
      options.push(...parts.slice(firstOption));
    } else {
      prompt = args;
    }
  }
  
  if (!prompt.trim()) {
    console.log(chalk.yellow('⚠ Please provide a prompt for image generation'));
    return;
  }
  
  const imageOptions = parseImageOptions(options);
  
  const spinner = createSpinner('Generating image...');
  spinner.start();
  
  try {
    const result = await api.generateImage(prompt, {
      ...imageOptions,
      sessionId: currentSessionId,
    });
    
    spinner.stop();
    
    // Update session if returned
    if (result.sessionId && result.sessionId !== currentSessionId) {
      currentSessionId = result.sessionId;
      session.setCurrent(currentSessionId);
    }

    console.log(chalk.cyan.bold('\n┌─ Image Generated ─────────────────────┐'));
    console.log(chalk.gray(`  Model: ${chalk.cyan(result.model || imageOptions.model)}`));
    console.log(chalk.gray(`  Size: ${chalk.cyan(result.size || imageOptions.size)}`));
    if (result.quality || imageOptions.quality) {
      console.log(chalk.gray(`  Quality: ${chalk.cyan(result.quality || imageOptions.quality)}`));
    }
    if (result.style || imageOptions.style) {
      console.log(chalk.gray(`  Style: ${chalk.cyan(result.style || imageOptions.style)}`));
    }
    
    let usableImages = 0;
    if (result.data && result.data.length > 0) {
      lastImageUrls = [];
      for (let i = 0; i < result.data.length; i++) {
        const img = result.data[i];
        console.log(chalk.cyan.bold(`\n  Image ${i + 1}:`));
        
        if (img.revised_prompt) {
          console.log(chalk.gray(`  Revised prompt: ${img.revised_prompt}`));
        }
        
        // Save image if URL or base64 is provided
        if (img.url || img.b64_json) {
          usableImages += 1;
          const outputDir = config.getImageOutputDir();
          
          // Ensure output directory exists
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          
          const filename = imageOptions.output || `img_${Date.now()}_${i + 1}.png`;
          const outputPath = path.resolve(outputDir, filename);
          
          if (img.b64_json) {
            // Save base64 image
            const buffer = Buffer.from(img.b64_json, 'base64');
            fs.writeFileSync(outputPath, buffer);
            console.log(chalk.green(`  ✓ Saved to: ${outputPath}`));
          }
          
          if (img.url) {
            lastImageUrls.push(img.url);
            console.log(chalk.gray(`  URL: ${chalk.blue.underline(img.url)}`));
          }
        }
      }
    }

    if (!result.data || result.data.length === 0 || usableImages === 0) {
      const diagnostics = formatImageDiagnostics(result.diagnostics);
      console.log(chalk.red('\n  No usable image data received from API.'));
      if (diagnostics) {
        console.log(chalk.gray(`  Diagnostics: ${diagnostics}`));
      }
    }

    console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
  } catch (err) {
    spinner.fail(chalk.red(`Image generation failed: ${err.message}`));
  }
}

async function handlePodcastCommand(args = '', includeVideo = false) {
  const parsed = minimist(String(args || '').split(/\s+/).filter(Boolean), {
    boolean: ['music', 'audio', 'intro', 'outro', 'unsplash'],
    string: ['system', 'brief', 'aspect'],
    alias: {
      m: 'music',
      a: 'audio',
    },
    default: {
      aspect: includeVideo ? '16:9' : '',
    },
  });
  const topic = parsed._.join(' ').trim();
  if (!topic) {
    console.log(chalk.yellow(`Usage: /${includeVideo ? 'video-podcast' : 'podcast'} <topic> [--music] [--audio] [--system "extra prompt"]`));
    return;
  }

  const includeMusicBed = parsed.music === true || parsed.audio === true;
  const includeIntro = parsed.intro === true || parsed.audio === true;
  const includeOutro = parsed.outro === true || parsed.audio === true;
  const productionType = includeVideo ? 'video-podcast' : 'podcast';
  const message = `Create a ${includeVideo ? 'video podcast' : 'podcast'} about ${topic}`;

  await sendChatMessage(message, {
    metadata: {
      podcastOptions: {
        enabled: true,
        productionType,
        includeVideo,
        voiceOnlyAudio: !(includeMusicBed || includeIntro || includeOutro),
        includeMusicBed,
        includeIntro,
        includeOutro,
        videoAspectRatio: String(parsed.aspect || '16:9'),
        videoRenderMode: includeVideo ? 'storyboard' : undefined,
        videoImageMode: parsed.unsplash === true ? 'unsplash' : 'generated',
        videoGenerateImages: includeVideo && parsed.unsplash !== true,
        directContentRequest: String(parsed.brief || '').trim(),
        systemPrompt: String(parsed.system || '').trim(),
      },
    },
  });
}

/**
 * Handle the /export command.
 * @param {string} filename - Output filename
 */
async function handleExport(filename) {
  if (!currentSessionId) {
    console.log(chalk.yellow('⚠ No active session to export'));
    return;
  }
  
  const outputPath = filename || `session-${currentSessionId.slice(0, 8)}.json`;
  const spinner = createSpinner('Exporting session...');
  spinner.start();
  
  try {
    const success = session.export(currentSessionId, outputPath);
    if (success) {
      spinner.succeed(chalk.green(`Exported to: ${outputPath}`));
    } else {
      spinner.fail(chalk.red('Export failed'));
    }
  } catch (err) {
    spinner.fail(chalk.red(`Export error: ${err.message}`));
  }
}

/**
 * Handle the /import command.
 * @param {string} filename - Input filename
 */
async function handleImport(filename) {
  if (!filename) {
    console.log(chalk.yellow('⚠ Usage: /import <filename>'));
    return;
  }
  
  const spinner = createSpinner('Importing session...');
  spinner.start();
  
  try {
    const imported = session.import(filename);
    if (imported) {
      currentSessionId = imported.id;
      session.setCurrent(currentSessionId, imported);
      if (imported.model) {
        currentModel = imported.model;
      }
      spinner.succeed(chalk.green(`Imported session: ${imported.name || imported.id.slice(0, 16)}`));
    } else {
      spinner.fail(chalk.red('Import failed. Check file format.'));
    }
  } catch (err) {
    spinner.fail(chalk.red(`Import error: ${err.message}`));
  }
}

/**
 * Handle the /rename command.
 * @param {string} name - New session name
 */
function handleRename(name) {
  if (!currentSessionId) {
    console.log(chalk.yellow('⚠ No active session to rename'));
    return;
  }
  
  if (!name) {
    console.log(chalk.yellow('⚠ Usage: /rename <new-name>'));
    return;
  }
  
  const success = session.rename(currentSessionId, name);
  if (success) {
    console.log(chalk.green(`✓ Renamed session to: ${chalk.bold(name)}`));
  } else {
    console.log(chalk.red('❌ Rename failed'));
  }
}

/**
 * Handle the /delete command.
 * @param {string} sessionId - Session ID to delete
 */
async function handleDelete(sessionId) {
  const targetId = sessionId || currentSessionId;
  
  if (!targetId) {
    console.log(chalk.yellow('⚠ No session specified'));
    return;
  }
  
  const spinner = createSpinner('Deleting session...');
  spinner.start();
  
  try {
    const success = session.remove(targetId);
    if (success) {
      if (targetId === currentSessionId) {
        currentSessionId = null;
      }
      spinner.succeed(chalk.green('Session deleted'));
    } else {
      spinner.fail(chalk.red('Delete failed'));
    }
  } catch (err) {
    spinner.fail(chalk.red(`Delete error: ${err.message}`));
  }
}

async function getSessionCapableProviders(forceReload = false) {
  if (!forceReload && providerCapabilities.length > 0) {
    return providerCapabilities.filter((provider) => provider.supportsSessions === true);
  }

  providerCapabilities = await api.getProviderCapabilities();
  return providerCapabilities.filter((provider) => provider.supportsSessions === true);
}

function printAttachedProviderHelp() {
  console.log(chalk.cyan.bold('\n┌─ Attached Provider Session ───────────┐'));
  console.log(chalk.gray(`  ${chalk.cyan('/.status'.padEnd(16))} Show session details`));
  console.log(chalk.gray(`  ${chalk.cyan('/.interrupt'.padEnd(16))} Send SIGINT to the backend CLI`));
  console.log(chalk.gray(`  ${chalk.cyan('/.detach'.padEnd(16))} Close the backend CLI session`));
  console.log(chalk.gray(`  ${chalk.cyan('/.help'.padEnd(16))} Show these local escape commands`));
  console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
}

function printProviderSessionStatus() {
  if (!activeProviderSession) {
    console.log(chalk.yellow('⚠ No backend CLI session is attached'));
    return;
  }

  console.log(chalk.cyan.bold('\n┌─ Backend CLI Session ─────────────────┐'));
  console.log(chalk.gray(`  Provider:  ${chalk.cyan(activeProviderSession.providerId)}`));
  console.log(chalk.gray(`  Status:    ${chalk.cyan(activeProviderSession.status || 'unknown')}`));
  console.log(chalk.gray(`  CWD:       ${chalk.white(activeProviderSession.cwd || process.cwd())}`));
  console.log(chalk.gray(`  Session:   ${chalk.white(activeProviderSession.id)}`));
  console.log(chalk.gray(`  Cursor:    ${chalk.white(String(activeProviderSession.lastCursor || 0))}`));
  console.log(chalk.gray(`  Resize:    ${activeProviderSession.supportsResize ? chalk.green('supported') : chalk.yellow('not wired')}`));
  console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
}

async function handleProviders() {
  const spinner = createSpinner('Loading provider capabilities...');
  spinner.start();

  try {
    const providers = await getSessionCapableProviders(true);
    spinner.stop();

    if (providers.length === 0) {
      console.log(chalk.yellow('\nNo session-capable backend CLI providers are available.\n'));
      return;
    }

    console.log(chalk.cyan.bold('\n┌─ Backend CLI Providers ───────────────┐'));
    providers.forEach((provider, index) => {
      const providerId = provider.providerId || provider.id || `provider-${index + 1}`;
      const resizeLabel = provider.supportsResize ? 'resize' : 'fixed-size';
      const modelLabel = provider.supportsModelSelection ? 'model-selectable' : 'default-model';
      console.log(chalk.gray(`  ${index + 1}. ${chalk.cyan(providerId)} ${chalk.gray(`(${resizeLabel}, ${modelLabel})`)}`));
    });
    console.log(chalk.gray('\n  Use /attach <providerId> [cwd] to open a backend CLI session.'));
    console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
  } catch (err) {
    spinner.fail(chalk.red(`Failed to load provider capabilities: ${err.message}`));
  }
}

async function detachProviderSession(options = {}) {
  const existingSession = activeProviderSession;
  if (!existingSession) {
    if (!options.silent) {
      console.log(chalk.yellow('⚠ No backend CLI session is attached'));
    }
    return;
  }

  activeProviderSession = null;
  const abortController = providerStreamAbortController;
  providerStreamAbortController = null;
  providerStreamTask = null;
  if (abortController) {
    abortController.abort();
  }
  updatePrompt();

  if (options.deleteRemote !== false) {
    try {
      await api.deleteProviderSession(existingSession.id);
    } catch (err) {
      if (!options.silent) {
        console.log(chalk.yellow(`⚠ Backend session cleanup returned: ${err.message}`));
      }
    }
  }

  if (!options.silent) {
    console.log(chalk.green(`Detached from ${existingSession.providerId}`));
  }
  redrawPrompt();
}

function startProviderSessionStream(sessionRecord) {
  const streamAbortController = new AbortController();
  providerStreamAbortController = streamAbortController;

  providerStreamTask = (async () => {
    let reconnectAttempts = 0;

    while (
      activeProviderSession
      && activeProviderSession.id === sessionRecord.id
      && !streamAbortController.signal.aborted
    ) {
      try {
        const afterCursor = activeProviderSession.lastCursor || undefined;

        for await (const event of api.streamProviderSession(sessionRecord.streamUrl, {
          after: afterCursor,
          signal: streamAbortController.signal,
        })) {
          if (
            !activeProviderSession
            || activeProviderSession.id !== sessionRecord.id
            || streamAbortController.signal.aborted
          ) {
            return;
          }

          if (Number.isFinite(Number(event.cursor))) {
            activeProviderSession.lastCursor = Number(event.cursor);
          }

          if (event.type === 'output' && typeof event.data === 'string') {
            writeAsyncOutput(event.data);
            reconnectAttempts = 0;
            continue;
          }

          if (event.type === 'status') {
            activeProviderSession.status = event.status || activeProviderSession.status;
            if (event.message || event.status) {
              writeAsyncOutput(chalk.gray(`\n[${activeProviderSession.providerId}] ${event.status || 'status'}${event.message ? `: ${event.message}` : ''}\n`));
            }
            reconnectAttempts = 0;
            continue;
          }

          if (event.type === 'exit') {
            activeProviderSession.status = 'exited';
            writeAsyncOutput(chalk.yellow(`\n[${activeProviderSession.providerId}] exited with code ${event.exitCode ?? 'unknown'}\n`));
            await detachProviderSession({ deleteRemote: false, silent: true });
            return;
          }
        }

        if (!activeProviderSession || activeProviderSession.id !== sessionRecord.id || streamAbortController.signal.aborted) {
          return;
        }

        reconnectAttempts += 1;
        if (reconnectAttempts > 3) {
          writeAsyncOutput(chalk.red(`\n[${sessionRecord.providerId}] stream disconnected and could not be resumed.\n`));
          await detachProviderSession({ deleteRemote: false, silent: true });
          return;
        }

        writeAsyncOutput(chalk.gray(`\n[${sessionRecord.providerId}] reconnecting from cursor ${activeProviderSession.lastCursor || 0}...\n`));
        await delay(Math.min(1000 * reconnectAttempts, 3000));
      } catch (err) {
        if (streamAbortController.signal.aborted) {
          return;
        }

        reconnectAttempts += 1;
        if (reconnectAttempts > 3) {
          writeAsyncOutput(chalk.red(`\n[${sessionRecord.providerId}] stream failed: ${err.message}\n`));
          await detachProviderSession({ deleteRemote: false, silent: true });
          return;
        }

        writeAsyncOutput(chalk.gray(`\n[${sessionRecord.providerId}] stream error: ${err.message}. Reconnecting...\n`));
        await delay(Math.min(1000 * reconnectAttempts, 3000));
      }
    }
  })();

  providerStreamTask.catch((err) => {
    if (!streamAbortController.signal.aborted) {
      writeAsyncOutput(chalk.red(`\n[${sessionRecord.providerId}] unexpected stream failure: ${err.message}\n`));
    }
  });
}

async function handleAttach(argString) {
  if (activeProviderSession) {
    console.log(chalk.yellow(`⚠ Already attached to ${activeProviderSession.providerId}. Use /.detach first.`));
    return;
  }

  const match = String(argString || '').trim().match(/^(\S+)(?:\s+(.+))?$/);
  if (!match) {
    console.log(chalk.yellow('Usage: /attach <providerId> [cwd]'));
    console.log(chalk.gray('Examples: /attach codex-cli'));
    console.log(chalk.gray('          /attach gemini-cli /workspace/my-app'));
    return;
  }

  const requestedProviderId = normalizeProviderId(match[1]);
  const requestedCwd = String(match[2] || '').trim();
  const spinner = createSpinner(`Opening ${requestedProviderId} session...`);
  spinner.start();

  try {
    const providers = await getSessionCapableProviders(providerCapabilities.length === 0);
    const selectedProvider = providers.find((provider) => normalizeProviderId(provider.providerId || provider.id) === requestedProviderId);
    if (!selectedProvider) {
      throw new Error(`Provider "${requestedProviderId}" is not available for provider sessions`);
    }

    const created = await api.createProviderSession({
      providerId: selectedProvider.providerId || requestedProviderId,
      ...(requestedCwd ? { cwd: requestedCwd } : {}),
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
    });
    if (!created?.session?.id || !created?.streamUrl) {
      throw new Error('The gateway did not return a provider session id and stream URL');
    }

    activeProviderSession = {
      ...(created.session || {}),
      id: created.session?.id,
      providerId: created.session?.providerId || selectedProvider.providerId || requestedProviderId,
      cwd: created.session?.cwd || requestedCwd || '',
      status: created.session?.status || 'starting',
      streamUrl: created.streamUrl,
      lastCursor: 0,
      supportsResize: created.session?.supportsResize === true,
    };

    updatePrompt();
    spinner.succeed(chalk.green(`Attached to ${activeProviderSession.providerId}${activeProviderSession.cwd ? ` in ${activeProviderSession.cwd}` : ''}`));
    console.log(chalk.gray('Backend CLI input is now passthrough. Use /.help for local escape commands.\n'));
    startProviderSessionStream(activeProviderSession);
  } catch (err) {
    spinner.fail(chalk.red(`Failed to attach provider session: ${err.message}`));
  }
}

async function handleProviderSignal(signalName = 'SIGINT') {
  if (!activeProviderSession) {
    console.log(chalk.yellow('⚠ No backend CLI session is attached'));
    return;
  }

  try {
    await api.sendProviderSessionSignal(activeProviderSession.id, signalName);
    console.log(chalk.gray(`[${activeProviderSession.providerId}] sent ${signalName}`));
  } catch (err) {
    console.log(chalk.red(`Failed to send ${signalName}: ${err.message}`));
  }
}

async function handleAttachedProviderCommand(input) {
  const trimmed = String(input || '').trim().toLowerCase();

  switch (trimmed) {
    case '/.help':
      printAttachedProviderHelp();
      return true;
    case '/.status':
      printProviderSessionStatus();
      return true;
    case '/.interrupt':
      await handleProviderSignal('SIGINT');
      return true;
    case '/.detach':
      await detachProviderSession();
      return true;
    default:
      console.log(chalk.yellow(`Unknown local provider command: ${input}`));
      console.log(chalk.gray('Use /.help to list local escape commands.'));
      return true;
  }
}

async function sendInputToProviderSession(input) {
  if (!activeProviderSession) {
    return;
  }

  try {
    await api.sendProviderSessionInput(activeProviderSession.id, `${input}\n`);
  } catch (err) {
    console.log(chalk.red(`Failed to send provider input: ${err.message}`));
  }
}

/**
 * Send a message in chat mode.
 * @param {string} message - Message to send
 */
function inferRequestedOutputFormat(message) {
  const text = String(message || '').toLowerCase();
  const checks = [
    ['power-query', /\b(power\s*query|\.(pq|m)\b)/],
    ['xlsx', /\b(xlsx|spreadsheet|excel|workbook)\b/],
    ['pdf', /\bpdf\b/],
    ['docx', /\b(docx|word document)\b/],
    ['xml', /\bxml\b/],
    ['mermaid', /\bmermaid\b/],
    ['html', /\bhtml\b/],
  ];

  return checks.find(([, pattern]) => pattern.test(text))?.[0] || null;
}
async function sendChatMessage(message, options = {}) {
  if (isProcessing) {
    console.log(chalk.yellow('⚠ Please wait for the current response...'));
    return;
  }
  
  isProcessing = true;
  accumulatedResponse = '';
  
  const timestamp = shouldShowTimestamps 
    ? chalk.gray(`[${new Date().toLocaleTimeString()}] `) 
    : '';
  const spinner = createSpinner('Thinking...');
  const pendingArtifacts = [];
  
  try {
    let hasReceivedContent = false;
    let reasoningSummary = '';
    const startTime = Date.now();
    const appendReasoning = (delta, metadata = {}) => {
      const content = String(delta || '');
      if (!content) {
        return;
      }

      reasoningSummary = String(metadata.summary || `${reasoningSummary}${content}` || '').trim();
      const preview = content.replace(/\s+/g, ' ').trim();
      if (preview) {
        spinner.text = chalk.yellow(`Working through it: ${preview.slice(0, 80)}${preview.length > 80 ? '...' : ''}`);
      }
    };
    
    spinner.start();
    const outputFormat = inferRequestedOutputFormat(message);
    const result = await api.chat(
      message,
      currentSessionId,
      (delta) => {
        hasReceivedContent = true;
        accumulatedResponse += delta;
        spinner.text = chalk.yellow('Writing the reply...');
      },
      (done) => {
        if (done.sessionId && done.sessionId !== currentSessionId) {
          currentSessionId = done.sessionId;
          session.setCurrent(currentSessionId);
        }
        if (Array.isArray(done.artifacts) && done.artifacts.length > 0) {
          pendingArtifacts.push(...done.artifacts);
        }
      },
      currentModel,
      outputFormat,
      appendReasoning,
      options
    );
    
    if (result.sessionId && result.sessionId !== currentSessionId) {
      currentSessionId = result.sessionId;
      session.setCurrent(currentSessionId);
    }

    const finalReasoningSummary = String(
      result.assistantMetadata?.reasoningSummary
      || result.assistantMetadata?.reasoning_summary
      || reasoningSummary
      || ''
    ).trim();
    
    const duration = Date.now() - startTime;
    spinner.stop();
    const renderedResponse = accumulatedResponse.trim()
      ? marked(normalizeTerminalPresentationMarkdown(accumulatedResponse.trim())).trimEnd()
      : chalk.gray(hasReceivedContent ? '' : 'No assistant text was returned.');
    console.log('\n' + timestamp + aiGradient.bold('AI: '));
    if (renderedResponse) {
      console.log(renderedResponse);
    }
    if (finalReasoningSummary) {
      session.addReasoningEntry(currentSessionId, {
        prompt: message,
        text: finalReasoningSummary,
        model: currentModel,
        mode: currentMode,
      });
      const preview = finalReasoningSummary.replace(/\s+/g, ' ').slice(0, 180);
      console.log(chalk.cyan.bold('\nReasoning summary'));
      console.log(chalk.blueBright(`${preview}${finalReasoningSummary.length > 180 ? '...' : ''}`));
      console.log(chalk.gray('Use /reasoning to read the saved history for this session.'));
    }
    if (pendingArtifacts.length > 0) {
      pendingArtifacts.forEach((artifact) => {
        console.log(chalk.cyan(`\n   File: ${artifact.filename}`));
        console.log(chalk.gray(`   Download: ${artifact.downloadUrl}`));
      });
    }
    console.log(chalk.gray(`\n  (${duration}ms)`));
    console.log('');
  } catch (err) {
    spinner.stop();
    console.error(chalk.red(`\n\n❌ Error: ${err.message}`));
    if (err.statusCode) {
      console.error(chalk.gray(`   Status: ${err.statusCode}`));
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * Send a message in canvas mode.
 * @param {string} message - Message to send
 */
async function sendCanvasMessage(message) {
  if (isProcessing) {
    console.log(chalk.yellow('⚠ Please wait for the current response...'));
    return;
  }
  
  isProcessing = true;
  const spinner = createSpinner('Generating canvas content...');
  spinner.start();
  
  const startTime = Date.now();
  
  try {
    const result = await api.canvas(message, currentSessionId, 'document', '', currentModel);
    spinner.stop();
    
    if (result.sessionId && result.sessionId !== currentSessionId) {
      currentSessionId = result.sessionId;
      session.setCurrent(currentSessionId);
    }

    const duration = Date.now() - startTime;
    
    console.log(chalk.cyan.bold('\n┌─ Canvas Result ───────────────────────┐'));
    console.log(chalk.gray(`  Type: ${chalk.cyan(result.canvasType || 'document')}`));
    console.log(chalk.gray(`  Time: ${duration}ms`));
    if (result.metadata) {
      console.log(chalk.gray(`  Meta: ${JSON.stringify(result.metadata)}`));
    }
    console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
    
    // Render the content as markdown
    if (result.content) {
      console.log(marked(normalizeTerminalPresentationMarkdown(result.content)));
    }
    
    if (result.suggestions && result.suggestions.length > 0) {
      console.log(chalk.yellow.bold('\n💡 Suggestions:'));
      result.suggestions.forEach((s, i) => {
        console.log(chalk.gray(`  ${i + 1}. ${s}`));
      });
    }
    console.log('');
  } catch (err) {
    spinner.fail(chalk.red(`Canvas error: ${err.message}`));
  } finally {
    isProcessing = false;
  }
}

/**
 * Send a notation in notation mode.
 * @param {string} notationText - Notation to process
 */
async function sendNotation(notationText) {
  if (isProcessing) {
    console.log(chalk.yellow('⚠ Please wait for the current response...'));
    return;
  }
  
  isProcessing = true;
  const spinner = createSpinner('Processing notation...');
  spinner.start();
  
  const startTime = Date.now();
  
  try {
    const result = await api.notation(notationText, currentSessionId, 'expand', '', currentModel);
    spinner.stop();
    
    if (result.sessionId && result.sessionId !== currentSessionId) {
      currentSessionId = result.sessionId;
      session.setCurrent(currentSessionId);
    }

    const reasoningSummary = String(
      result.assistantMetadata?.reasoningSummary
      || result.assistantMetadata?.reasoning_summary
      || ''
    ).trim();
    
    const duration = Date.now() - startTime;
    
    console.log(chalk.cyan.bold('\n┌─ Notation Result ─────────────────────┐'));
    console.log(chalk.gray(`  Mode: ${chalk.cyan(result.helperMode || 'expand')}`));
    console.log(chalk.gray(`  Time: ${duration}ms`));
    console.log(chalk.cyan.bold('└───────────────────────────────────────┘\n'));
    
    // Render the result as markdown
    if (result.result) {
      console.log(marked(normalizeTerminalPresentationMarkdown(result.result)));
    }

    if (reasoningSummary) {
      session.addReasoningEntry(currentSessionId, {
        prompt: notationText,
        text: reasoningSummary,
        model: currentModel,
        mode: 'notation',
      });
      console.log(chalk.cyan.bold('\nReasoning summary'));
      console.log(chalk.blueBright(`${reasoningSummary.replace(/\s+/g, ' ').slice(0, 180)}${reasoningSummary.length > 180 ? '...' : ''}`));
      console.log(chalk.gray('Use /reasoning to read the saved history for this session.'));
    }
    
    if (result.annotations && result.annotations.length > 0) {
      console.log(chalk.yellow.bold('\n📝 Annotations:'));
      result.annotations.forEach((a) => {
        console.log(chalk.gray(`  Line ${chalk.cyan(a.line)}: ${a.note}`));
      });
    }
    
    if (result.suggestions && result.suggestions.length > 0) {
      console.log(chalk.yellow.bold('\n💡 Suggestions:'));
      result.suggestions.forEach((s, i) => {
        console.log(chalk.gray(`  ${i + 1}. ${s}`));
      });
    }
    console.log('');
  } catch (err) {
    spinner.fail(chalk.red(`Notation error: ${err.message}`));
  } finally {
    isProcessing = false;
  }
}

/**
 * Auto-complete a command.
 * @param {string} line - Current input line
 * @returns {Array} [completions, original]
 */
function completer(line) {
  const hits = COMMANDS.filter((c) => c.startsWith(line));
  return [hits.length ? hits : COMMANDS, line];
}

async function loadRemoteToolCatalog() {
  const response = await api.getAvailableTools({
    category: 'ssh',
    taskType: 'chat',
    clientSurface: 'cli',
    executionProfile: REMOTE_BUILD_EXECUTION_PROFILE,
    sessionId: currentSessionId && !String(currentSessionId).startsWith('local_')
      ? currentSessionId
      : null,
    timeout: 10000,
  });
  const tools = response.data || [];
  const remoteTool = tools.find((tool) => tool.id === 'remote-command')
    || tools.find((tool) => Array.isArray(tool.runtime?.commandCatalog));
  const remoteAgentTool = tools.find((tool) => tool.id === 'remote-cli-agent') || null;

  return {
    tools,
    runtime: response.meta?.runtime || null,
    remoteTool,
    remoteAgentTool,
    catalog: remoteTool?.runtime?.commandCatalog || [],
  };
}

async function loadWorkbenchToolContext(forceReload = false) {
  if (!forceReload && remoteToolContext) {
    return remoteToolContext;
  }

  remoteToolContext = await loadRemoteToolCatalog();
  const defaultCwd = workbench.resolveDefaultRemoteCwd(remoteToolContext, {
    remoteDefaultCwd: config.get('remoteDefaultCwd', ''),
  });

  if (defaultCwd && defaultCwd !== config.get('remoteDefaultCwd', '')) {
    config.set('remoteDefaultCwd', defaultCwd);
  }
  if (!config.get('remoteCwd', '')) {
    config.set('remoteCwd', defaultCwd);
  }

  return remoteToolContext;
}

function getWorkbenchCwd(toolContext = remoteToolContext) {
  return workbench.resolveActiveRemoteCwd(toolContext || {}, {
    remoteCwd: config.get('remoteCwd', ''),
    remoteDefaultCwd: config.get('remoteDefaultCwd', ''),
  });
}

function printRemotePlan() {
  console.log(chalk.cyan.bold('\nRemote CLI Plan\n'));
  console.log(chalk.gray('  1. /remote status - confirm remote runner health and fallback target.'));
  console.log(chalk.gray('  2. /remote tools - choose a catalog command.'));
  console.log(chalk.gray('  3. /remote <tool-id> - run a catalog entry such as baseline, kubectl-inspect, logs, rollout, build, or test.'));
  console.log(chalk.gray('  4. /remote run <command> - execute one purposeful inspect, fix, or verify batch.'));
  console.log(chalk.gray('  5. /remote agent [--artifact <full-id>] [--collect] <task> - hand a full coding/build/deploy loop to the backend remote CLI agent.'));
  console.log(chalk.gray('  6. Continue normal build/test failures while the next step is still on plan.'));
  console.log(chalk.gray('  7. Stop for sudo/package installs, secrets, destructive deletes, force push, repeated failures, missing credentials, or unclear recovery.\n'));
  console.log(chalk.gray('Raw expert access: /remote run hostname && whoami && uname -m\n'));
}

function printRemoteResult(result = {}) {
  const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 'unknown';
  const stdout = String(result.stdout || result.output || '').trim();
  const stderr = String(result.stderr || '').trim();

  console.log(chalk.cyan.bold('\nRemote CLI Result'));
  console.log(chalk.gray(`Exit code: ${exitCode}`));
  if (result.transport || result.source || result.runnerId) {
    console.log(chalk.gray(`Transport: ${result.transport || result.source || 'remote'}${result.runnerId ? `:${result.runnerId}` : ''}`));
  }
  if (result.cwd || result.workspacePath) {
    console.log(chalk.gray(`Workspace: ${result.cwd || result.workspacePath}`));
  }
  if (stdout) {
    console.log(chalk.green('\nSTDOUT'));
    console.log(stdout);
  }
  if (stderr) {
    console.log(chalk.yellow('\nSTDERR'));
    console.log(stderr);
  }
  if (!stdout && !stderr) {
    console.log(JSON.stringify(result, null, 2));
  }
  console.log('');
}

function printRemoteAgentResult(result = {}) {
  const output = formatRemoteAgentTextOutput(result.finalOutput || result.output);
  const statusLines = formatRemoteAgentStatusOutput(result);
  const artifactLines = formatRemoteAgentArtifactOutput(result);
  const safeField = (value, maxLength = 500) => formatRemoteAgentTextOutput(
    String(value ?? '').replace(/\r?\n/g, ' '),
    maxLength,
  );

  console.log(chalk.cyan.bold('\nRemote CLI Agent Result'));
  if (result.targetId) {
    console.log(chalk.gray(`Target: ${safeField(result.targetId)}`));
  }
  if (result.cwd) {
    console.log(chalk.gray(`Workspace: ${safeField(result.cwd, 1200)}`));
  }
  if (result.sessionId) {
    console.log(chalk.gray(`Remote session: ${safeField(result.sessionId)}`));
  }
  if (result.mcpSessionId) {
    console.log(chalk.gray(`MCP session: ${safeField(result.mcpSessionId)}`));
  }
  if (result.provider || result.providerId) {
    console.log(chalk.gray(`Provider: ${safeField(result.provider || result.providerId)}`));
  }
  if (result.providerModel || result.model) {
    console.log(chalk.gray(`Model: ${safeField(result.providerModel || result.model)}`));
  }
  if (statusLines.length > 0) {
    console.log('');
    statusLines.forEach((line) => console.log(chalk.yellow(line)));
  }
  if (output) {
    console.log('');
    console.log(output);
  } else if (statusLines.length === 0 && artifactLines.length === 0) {
    console.log(chalk.gray('No terminal text or artifact metadata was returned.'));
  }
  if (artifactLines.length > 0) {
    console.log('');
    artifactLines.forEach((line) => console.log(chalk.gray(line)));
  }
  console.log('');
}

async function invokeRemoteCommand(command, options = {}) {
  const response = await api.runRemoteCommand(command, {
    profile: options.profile || 'build',
    workflowAction: options.workflowAction || 'remote-cli-manual-run',
    timeout: options.timeout || 120000,
    workingDirectory: options.workingDirectory || getWorkbenchCwd(),
    environment: options.environment,
    approval: options.approval,
    sessionId: currentSessionId,
    taskType: 'chat',
    clientSurface: 'cli',
    executionProfile: REMOTE_BUILD_EXECUTION_PROFILE,
    model: currentModel || null,
  });

  if (response.sessionId) {
    currentSessionId = response.sessionId;
    session.setCurrent(currentSessionId);
  }

  const envelope = response.data || {};
  return envelope.data || envelope.result || envelope;
}

function extractRemoteCliAgentContinuation(sessionRecord = {}) {
  const metadata = sessionRecord.metadata && typeof sessionRecord.metadata === 'object'
    ? sessionRecord.metadata
    : {};
  const controlState = sessionRecord.controlState && typeof sessionRecord.controlState === 'object'
    ? sessionRecord.controlState
    : {};
  const metadataControlState = metadata.controlState && typeof metadata.controlState === 'object'
    ? metadata.controlState
    : {};

  return {
    ...(metadata.remoteCliAgent && typeof metadata.remoteCliAgent === 'object' ? metadata.remoteCliAgent : {}),
    ...(metadataControlState.remoteCliAgent && typeof metadataControlState.remoteCliAgent === 'object' ? metadataControlState.remoteCliAgent : {}),
    ...(controlState.remoteCliAgent && typeof controlState.remoteCliAgent === 'object' ? controlState.remoteCliAgent : {}),
  };
}

async function loadRemoteCliAgentContinuation() {
  if (!currentSessionId || String(currentSessionId).startsWith('local_')) {
    return {};
  }

  try {
    const sessionRecord = await api.getSession(currentSessionId);
    return extractRemoteCliAgentContinuation(sessionRecord);
  } catch {
    return {};
  }
}

async function invokeRemoteCliAgent(task, options = {}) {
  const continuation = await loadRemoteCliAgentContinuation();
  const response = await api.runRemoteCliAgent(task, {
    backendSessionId: currentSessionId,
    cwd: options.cwd || continuation.cwd || getWorkbenchCwd(),
    targetId: options.targetId || continuation.targetId,
    sessionId: options.sessionId || continuation.sessionId,
    mcpSessionId: options.mcpSessionId || continuation.mcpSessionId,
    waitMs: options.waitMs || 30000,
    maxTurns: options.maxTurns || 30,
    taskType: 'chat',
    clientSurface: 'cli',
    executionProfile: REMOTE_BUILD_EXECUTION_PROFILE,
    model: currentModel || null,
    artifactIds: options.artifactIds,
    contextFiles: options.contextFiles,
    resultFileGlobs: options.resultFileGlobs,
    collectResultFiles: options.collectResultFiles,
  });

  if (response.sessionId) {
    currentSessionId = response.sessionId;
    session.setCurrent(currentSessionId);
  }

  const envelope = response.data || {};
  return envelope.data || envelope.result || envelope;
}

function buildHttpsVerifyCommand(host) {
  const normalized = String(host || '').trim() || 'demoserver2.buzz';
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(normalized)) {
    throw new Error('Host must be a domain, IP address, or host:port without shell characters.');
  }

  return `host=${JSON.stringify(normalized)}
getent ahosts "$host" || true
curl -fsSIL --max-time 20 "https://$host"`;
}

function unwrapToolResponse(response = {}) {
  const envelope = response.data || {};
  return envelope.data || envelope.result || envelope;
}

function rememberWorkbenchResult(result = {}, cwd = '') {
  config.set('lastCommandResult', {
    exitCode: Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : null,
    cwd: cwd || result.cwd || result.workspacePath || '',
    duration: Number.isFinite(Number(result.duration)) ? Number(result.duration) : null,
    updatedAt: new Date().toISOString(),
  });
}

function updateSessionFromToolResponse(response = {}) {
  if (response.sessionId) {
    currentSessionId = response.sessionId;
    session.setCurrent(currentSessionId);
  }
}

function maybeRememberRepoRoot(result = {}) {
  const lines = String(result.stdout || result.output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const taggedRoot = lines.find((line) => line.startsWith('repoRoot: '));
  const repoRoot = taggedRoot
    ? taggedRoot.replace(/^repoRoot:\s*/, '').trim()
    : lines.find((line) => /^(?:[A-Za-z]:[\\/]|\/).+/.test(line));
  if (repoRoot) {
    config.set('lastRepoRoot', repoRoot);
  }
}

function printWorkbenchStatus(toolContext = {}) {
  const runtime = toolContext.runtime || {};
  const runner = runtime.remoteRunner || {};
  const deploy = runtime.deployDefaults || {};
  console.log(chalk.cyan.bold('\nWorkbench Status'));
  console.log(chalk.gray(`Target: remote`));
  console.log(chalk.gray(`CWD: ${getWorkbenchCwd(toolContext)}`));
  console.log(chalk.gray(`Runner: ${runner.healthy ? 'healthy' : 'not healthy'}${runner.defaultRunnerId ? ` (${runner.defaultRunnerId})` : ''}`));
  console.log(chalk.gray(`Shell: ${runner.shell || 'unknown'}`));
  console.log(chalk.gray(`Tools: ${(runner.availableCliTools || []).join(', ') || 'unknown'}`));
  console.log(chalk.gray(`Deploy: namespace=${deploy.namespace || 'unset'}, deployment=${deploy.deployment || 'unset'}, domain=${deploy.publicDomain || 'unset'}`));
  console.log(chalk.gray(`Last repo root: ${config.get('lastRepoRoot', '') || 'none'}\n`));
}

async function runK3sDeployStep(step = {}) {
  const response = await api.runK3sDeploy(step.params || {}, {
    sessionId: currentSessionId,
    taskType: 'chat',
    clientSurface: 'cli',
    executionProfile: REMOTE_BUILD_EXECUTION_PROFILE,
    model: currentModel || null,
    timeout: step.timeout || 180000,
  });
  updateSessionFromToolResponse(response);
  return unwrapToolResponse(response);
}

async function handleWorkbenchAlias(input = '') {
  const alias = workbench.parseWorkbenchAlias(input);
  if (!alias) {
    return false;
  }

  const toolContext = await loadWorkbenchToolContext();
  if (alias.command === 'status') {
    printWorkbenchStatus(toolContext);
    return true;
  }

  if (alias.command === 'deploy') {
    const steps = workbench.buildDeploySequence(toolContext);
    for (const step of steps) {
      const spinner = createSpinner(`Deploy ${step.label}...`);
      spinner.start();
      try {
        let result;
        if (step.type === 'k3s-deploy') {
          result = await runK3sDeployStep(step);
        } else {
          result = await invokeRemoteCommand(step.command, {
            profile: step.profile,
            workflowAction: step.workflowAction,
            timeout: step.timeout,
            workingDirectory: getWorkbenchCwd(toolContext),
          });
        }
        spinner.stop();
        printRemoteResult(result);
        rememberWorkbenchResult(result, getWorkbenchCwd(toolContext));
      } catch (err) {
        spinner.fail(chalk.red(`Deploy ${step.label} failed: ${err.message}`));
        return true;
      }
    }
    return true;
  }

  let remoteCommand;
  try {
    remoteCommand = workbench.buildRemoteWorkbenchCommand(alias, toolContext);
  } catch (err) {
    console.log(chalk.yellow(err.message));
    return true;
  }
  if (!remoteCommand) {
    return false;
  }

  const spinner = createSpinner(`${alias.command}...`);
  spinner.start();
  try {
    const cwd = getWorkbenchCwd(toolContext);
    const result = await invokeRemoteCommand(remoteCommand.command, {
      profile: remoteCommand.profile,
      workflowAction: remoteCommand.workflowAction,
      timeout: remoteCommand.timeout || 120000,
      workingDirectory: cwd,
    });
    spinner.stop();

    if (remoteCommand.updateCwdFromStdout) {
      const nextCwd = String(result.stdout || result.output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      if (nextCwd) {
        config.set('remoteCwd', nextCwd);
      }
    }

    if (alias.command === 'repo') {
      maybeRememberRepoRoot(result);
    }

    printRemoteResult(result);
    rememberWorkbenchResult(result, getWorkbenchCwd(toolContext));
  } catch (err) {
    spinner.fail(chalk.red(`${alias.command} failed: ${err.message}`));
  }

  return true;
}

function resolveCatalogEntry(catalog = [], subcommand = '') {
  const normalized = String(subcommand || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return (Array.isArray(catalog) ? catalog : []).find((entry) => {
    const id = String(entry?.id || '').trim().toLowerCase();
    const label = String(entry?.label || '').trim().toLowerCase().replace(/\s+/g, '-');
    return id === normalized || label === normalized;
  }) || null;
}

async function handleRemote(argString = '') {
  const [rawSubcommand, ...restParts] = String(argString || '').trim().split(/\s+/).filter(Boolean);
  const subcommand = String(rawSubcommand || 'plan').toLowerCase();
  const rest = restParts.join(' ').trim();

  if (subcommand === 'plan' || subcommand === 'help' || subcommand === '?') {
    printRemotePlan();
    return;
  }

  const spinner = ora(`Remote ${subcommand}...`).start();
  try {
    if (subcommand === 'status') {
      const { runtime, remoteTool, remoteAgentTool } = await loadRemoteToolCatalog();
      spinner.stop();
      const runner = runtime?.remoteRunner || {};
      const ssh = runtime?.sshDefaults || {};
      const deploy = runtime?.deployDefaults || {};
      console.log(chalk.cyan.bold('\nRemote CLI Status'));
      console.log(chalk.gray(`Remote runner: ${runner.healthy ? 'healthy' : 'not healthy'} (enabled=${runner.enabled ? 'yes' : 'no'}, preferred=${runner.preferred ? 'yes' : 'no'})`));
      console.log(chalk.gray(`Remote-command: ${remoteTool?.runtime?.configured ? 'configured' : 'not configured'} via ${remoteTool?.runtime?.source || 'unknown'}`));
      console.log(chalk.gray(`Remote-cli-agent: ${remoteAgentTool?.runtime?.configured ? 'configured' : 'not configured'}${remoteAgentTool?.runtime?.defaultTargetId ? ` target=${remoteAgentTool.runtime.defaultTargetId}` : ''}`));
      console.log(chalk.gray(`Default target: ${remoteTool?.runtime?.defaultTarget || 'none'}`));
      console.log(chalk.gray(`SSH fallback: ${ssh.configured ? `${ssh.username || 'unknown'}@${ssh.host}:${ssh.port || 22}` : 'not configured'}`));
      console.log(chalk.gray(`Deploy defaults: namespace=${deploy.namespace || 'unset'}, deployment=${deploy.deployment || 'unset'}, domain=${deploy.publicDomain || 'unset'}\n`));
      return;
    }

    if (subcommand === 'tools') {
      const { catalog } = await loadRemoteToolCatalog();
      spinner.stop();
      console.log(chalk.cyan.bold('\nRemote CLI Tools'));
      if (!catalog.length) {
        console.log(chalk.gray('No remote CLI command catalog is available.\n'));
        return;
      }
      catalog.forEach((entry) => {
        console.log(chalk.gray(`  ${chalk.cyan(String(entry.id || '').padEnd(16))} ${(entry.profile || 'inspect').padEnd(8)} ${entry.description || entry.purpose || 'Remote command pattern.'}`));
      });
      console.log('');
      return;
    }

    const { catalog } = await loadRemoteToolCatalog();
    const catalogEntry = resolveCatalogEntry(catalog, subcommand);
    if (catalogEntry) {
      const command = String(catalogEntry.command || '').trim();
      if (!command) {
        spinner.fail(`Remote catalog entry '${catalogEntry.id}' has no command.`);
        return;
      }

      const result = await invokeRemoteCommand(command, {
        profile: catalogEntry.profile || 'inspect',
        workflowAction: `remote-cli-${catalogEntry.id || subcommand}`,
        timeout: 120000,
      });
      spinner.stop();
      printRemoteResult(result);
      return;
    }

    if (subcommand === 'run') {
      if (!rest) {
        spinner.fail('Usage: /remote run <command>');
        return;
      }
      const result = await invokeRemoteCommand(rest, {
        profile: 'build',
        workflowAction: 'remote-cli-manual-run',
        timeout: 120000,
      });
      spinner.stop();
      printRemoteResult(result);
      return;
    }

    if (subcommand === 'agent') {
      const agentCommand = parseRemoteAgentCommand(rest);
      if (!agentCommand.task) {
        spinner.fail('Usage: /remote agent [--artifact <full-id>] [--collect] <coding/build/deploy task>');
        return;
      }
      const result = await invokeRemoteCliAgent(agentCommand.task, {
        cwd: getWorkbenchCwd(),
        waitMs: 30000,
        maxTurns: 30,
        ...(agentCommand.artifactIds.length > 0 ? { artifactIds: agentCommand.artifactIds } : {}),
        ...(agentCommand.collectResultFiles !== undefined
          ? { collectResultFiles: agentCommand.collectResultFiles }
          : {}),
      });
      spinner.stop();
      printRemoteAgentResult(result);
      return;
    }

    if (subcommand === 'verify') {
      const result = await invokeRemoteCommand(buildHttpsVerifyCommand(rest), {
        profile: 'inspect',
        workflowAction: 'remote-cli-https-verify',
        timeout: 60000,
      });
      spinner.stop();
      printRemoteResult(result);
      return;
    }

    spinner.fail('Usage: /remote status | /remote tools | /remote plan | /remote <catalog-id> | /remote run <command> | /remote agent [--artifact <full-id>] [--collect] <task> | /remote verify [host]');
  } catch (err) {
    spinner.fail(chalk.red(`Remote ${subcommand} failed: ${err.message}`));
  }
}

async function handleSkills(argString = '') {
  const spinner = ora('Loading skills...').start();
  try {
    const response = await api.listSkills({ search: String(argString || '').trim() });
    const skills = response.data || [];
    spinner.stop();

    console.log(chalk.cyan.bold('\nRegistered Skills'));
    if (response.meta?.root) {
      console.log(chalk.gray(`Location: ${response.meta.root}\n`));
    }
    if (!skills.length) {
      console.log(chalk.gray('No registered skills found.\n'));
      return;
    }
    skills.forEach((skill) => {
      console.log(chalk.gray(`  ${chalk.cyan(String(skill.id || '').padEnd(24))} ${skill.description || skill.name || 'Reusable skill.'}`));
      if (Array.isArray(skill.tools) && skill.tools.length > 0) {
        console.log(chalk.gray(`  ${' '.repeat(24)} tools: ${skill.tools.join(', ')}`));
      }
    });
    console.log('');
  } catch (err) {
    spinner.fail(chalk.red(`Skills failed: ${err.message}`));
  }
}

async function handleSkillRead(argString = '') {
  const skillId = String(argString || '').trim();
  if (!skillId) {
    console.error(chalk.red('Usage: /skill <id>'));
    return;
  }

  const spinner = ora(`Loading ${skillId}...`).start();
  try {
    const response = await api.getSkill(skillId);
    const skill = response.data || response;
    spinner.stop();
    console.log(marked(`## Skill: \`${skill.id}\`\n\n${skill.description || 'No description provided.'}\n\nTools: ${(skill.tools || []).map((tool) => `\`${tool}\``).join(', ') || 'none'}\n\nTriggers: ${(skill.triggerPatterns || []).map((trigger) => `\`${trigger}\``).join(', ') || 'none'}\n\n\`\`\`markdown\n${skill.body || ''}\n\`\`\``));
  } catch (err) {
    spinner.fail(chalk.red(`Skill read failed: ${err.message}`));
  }
}

async function handleSkillCreate(argString = '') {
  const rawPayload = String(argString || '').trim();
  if (!rawPayload) {
    console.error(chalk.red('Usage: /skill-create {"name":"...","description":"...","body":"...","tools":["image-generate"]}'));
    return;
  }

  const spinner = ora('Creating skill...').start();
  try {
    const response = await api.createSkill(JSON.parse(rawPayload));
    spinner.succeed(chalk.green(`Registered ${response.data?.id || 'skill'} in ${response.meta?.root || 'data/skills'}`));
  } catch (err) {
    spinner.fail(chalk.red(`Skill create failed: ${err.message}`));
  }
}

async function handleSkillUpdate(argString = '') {
  const match = String(argString || '').trim().match(/^([^\s]+)\s+([\s\S]+)$/);
  if (!match) {
    console.error(chalk.red('Usage: /skill-update <id> {"description":"...","body":"..."}'));
    return;
  }

  const spinner = ora(`Updating ${match[1]}...`).start();
  try {
    const response = await api.updateSkill(match[1], JSON.parse(match[2]));
    spinner.succeed(chalk.green(`Updated ${response.data?.id || match[1]} in ${response.meta?.root || 'data/skills'}`));
  } catch (err) {
    spinner.fail(chalk.red(`Skill update failed: ${err.message}`));
  }
}

/**
 * Print version information.
 */
function printVersion() {
  console.log(`${CLI_NAME} v${CLI_VERSION}`);
}

/**
 * Process user input.
 * @param {string} input - User input
 * @returns {boolean} Whether to continue
 */
async function processInput(input) {
  const rawInput = String(input || '');
  const trimmed = rawInput.trim();

  if (activeProviderSession) {
    if (trimmed.startsWith(PROVIDER_LOCAL_COMMAND_PREFIX)) {
      return handleAttachedProviderCommand(trimmed);
    }

    await sendInputToProviderSession(rawInput);
    return true;
  }

  if (!trimmed) {
    return true;
  }

  if (trimmed && !commandHistory.includes(trimmed)) {
    commandHistory.push(trimmed);
    if (commandHistory.length > 100) {
      commandHistory.shift();
    }
  }
  
  // Handle commands
  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');
    
    switch (command) {
      case 'new':
        await handleNew();
        return true;
      case 'mode':
        if (!args) {
          console.log(chalk.cyan(`Current mode: ${chalk.bold(currentMode)}`));
        } else {
          handleMode(args.trim());
        }
        return true;
      case 'theme':
        handleTheme(args.trim() || null);
        return true;
      case 'history':
        handleHistory();
        return true;
      case 'reasoning':
        handleReasoningHistory(args);
        return true;
      case 'sessions':
        await handleSessions();
        return true;
      case 'clear':
        handleClear();
        return true;
      case 'config':
        printConfig();
        return true;
      case 'providers':
        await handleProviders();
        return true;
      case 'attach':
        await handleAttach(args.trim());
        return true;
      case 'provider-status':
        printProviderSessionStatus();
        return true;
      case 'remote':
        await handleRemote(args.trim());
        return true;
      case 'skills':
        await handleSkills(args.trim());
        return true;
      case 'skill':
        await handleSkillRead(args.trim());
        return true;
      case 'skill-create':
        await handleSkillCreate(args.trim());
        return true;
      case 'skill-update':
        await handleSkillUpdate(args.trim());
        return true;
      case 'export':
        await handleExport(args.trim() || null);
        return true;
      case 'import':
        await handleImport(args.trim());
        return true;
      case 'rename':
        handleRename(args.trim());
        return true;
      case 'delete':
        await handleDelete(args.trim() || null);
        return true;
      case 'url':
        handleUrl(args.trim() || null);
        return true;
      case 'models':
        handleModels();
        return true;
      case 'model':
        handleModel(args.trim() || null);
        return true;
      case 'imgmodels':
        handleImgModels();
        return true;
      case 'image':
      case 'img':
        await handleImage(args);
        return true;
      case 'podcast':
        await handlePodcastCommand(args, false);
        return true;
      case 'video-podcast':
        await handlePodcastCommand(args, true);
        return true;
      case 'download-image':
        await handleDownloadImageCommand(args);
        return true;
      case 'help':
      case '?':
        printHelp();
        return true;
      case 'version':
      case 'v':
        printVersion();
        return true;
      case 'quit':
      case 'exit':
      case 'q':
        console.log(chalk.green('\n👋 Goodbye!\n'));
        return false;
      default:
        console.error(chalk.red(`❌ Unknown command: /${command}. Type /help for available commands.`));
        return true;
    }
  }

  if (await handleWorkbenchAlias(trimmed)) {
    return true;
  }
  
  // Handle messages based on mode
  switch (currentMode) {
    case 'chat':
      await sendChatMessage(trimmed);
      break;
    case 'canvas':
      await sendCanvasMessage(trimmed);
      break;
    case 'notation':
      await sendNotation(trimmed);
      break;
    default:
      console.error(chalk.red(`❌ Unknown mode: ${currentMode}`));
  }
  
  return true;
}

/**
 * Start the interactive REPL.
 */
function startREPL() {
  printBanner();
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPromptValue(),
    completer: completer,
    history: commandHistory,
    historySize: 100,
  });
  readlineInterface = rl;
  updatePrompt();
  
  // Custom key handling for better UX
  rl.input.on('keypress', (char, key) => {
    if (key && key.ctrl && key.name === 'c') {
      if (activeProviderSession) {
        void handleProviderSignal('SIGINT');
        redrawPrompt();
        return;
      }

      if (isProcessing) {
        console.log(chalk.yellow('\n\n⚠ Cancelling... (press Ctrl+C again to exit)'));
        isProcessing = false;
        redrawPrompt();
      } else {
        console.log(chalk.green('\n👋 Goodbye!\n'));
        process.exit(0);
      }
    }
    if (key && key.ctrl && key.name === 'l') {
      handleClear();
      redrawPrompt();
    }
  });
  
  rl.prompt();
  
  rl.on('line', async (input) => {
    const shouldContinue = await processInput(input);
    if (shouldContinue) {
      redrawPrompt();
    } else {
      rl.close();
      process.exit(0);
    }
  });
  
  rl.on('close', () => {
    if (activeProviderSession) {
      void detachProviderSession({ silent: true });
    }
    console.log(chalk.green('\n👋 Goodbye!\n'));
    process.exit(0);
  });
  
  // Handle resize
  process.stdout.on('resize', () => {
    if (!activeProviderSession) {
      return;
    }

    void api.resizeProviderSession(
      activeProviderSession.id,
      process.stdout.columns || 120,
      process.stdout.rows || 40,
    ).catch(() => {
      // The backend reports whether resize actually applied; ignore unsupported responses.
    });
  });
}

/**
 * Handle piped input.
 * @param {string} input - Piped input
 */
async function handlePipedInput(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    console.error(chalk.red('❌ No input provided'));
    process.exit(1);
  }
  
  try {
    const result = await api.chatNonStreaming(trimmed, currentSessionId, currentModel);
    
    if (result.sessionId) {
      session.setCurrent(result.sessionId);
    }
    
    // Render as markdown
    console.log(marked(normalizeTerminalPresentationMarkdown(result.message || result.content || '')));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Print usage information.
 */
function printUsage() {
  console.log(`
${CLI_NAME} v${CLI_VERSION}

Usage:
  kimibuilt [options]           Start interactive mode
  echo "text" | kimibuilt       Pipe mode (non-interactive)
  kimibuilt [options] < file    Read from file

Options:
  -v, --version                 Show version
  -h, --help                    Show this help
  --api-url <url>               Set API base URL
  --mode <mode>                 Set mode (chat|canvas|notation)
  --model <model>               Set model ID
  --no-stream                   Disable streaming responses
  --theme <theme>               Set theme (default|minimal|colorful|dark)

Environment Variables:
  KIMIBUILT_API_URL             Override API base URL
  KIMIBUILT_FRONTEND_API_KEY    Auth for /v1, /api, and /admin/provider-sessions when backend auth is enabled
  FRONTEND_API_KEY              Alternate auth env var for the frontend token

Provider Session Commands:
  /providers                    List codex-cli, gemini-cli, kimi-cli when enabled
  /attach <provider> [cwd]      Open a backend CLI session in the chosen cwd
  /.help                        Local escape commands while attached

Remote CLI Commands:
  /remote status                Show remote runner and fallback target state
  /remote tools                 Show the remote command catalog
  /remote plan                  Show the remote CLI build loop
  /remote baseline              Run a catalog command by ID
  /remote run <command>         Execute a curated remote-command call
  /remote agent [options] <task> Delegate a coding/build/deploy loop to the remote CLI agent
    --artifact <full-id>         Attach a session artifact; repeat for multiple files
    --collect                    Persist returned files and a site bundle in this session
  /remote verify [host]         Verify DNS and HTTPS from the remote host

Examples:
  kimibuilt
  kimibuilt --api-url http://localhost:3000
  kimibuilt --model gpt-5.4-mini
  echo "Hello AI" | kimibuilt
  /attach codex-cli
  /remote status
`);
}

/**
 * Parse command line arguments.
 * @returns {Object} Parsed arguments
 */
function parseArgs() {
  const argv = minimist(process.argv.slice(2), {
    alias: {
      v: 'version',
      h: 'help',
    },
    boolean: ['version', 'help', 'stream'],
    default: {
      stream: true,
    },
  });
  return argv;
}

/**
 * Main entry point.
 */
async function main() {
  const argv = parseArgs();
  
  // Handle --version
  if (argv.version) {
    printVersion();
    return;
  }
  
  // Handle --help
  if (argv.help) {
    printUsage();
    return;
  }
  
  // Handle --api-url
  if (argv['api-url']) {
    config.setApiBaseUrl(argv['api-url']);
    currentMode = config.getDefaultMode();
  }
  
  // Handle --mode
  if (argv.mode) {
    if (config.VALID_MODES.includes(argv.mode)) {
      currentMode = argv.mode;
    } else {
      console.error(chalk.red(`❌ Invalid mode: ${argv.mode}`));
      process.exit(1);
    }
  }
  
  // Handle --model
  if (argv.model) {
    currentModel = argv.model;
    config.setDefaultModel(currentModel);
  } else {
    currentModel = config.getDefaultModel();
  }
  
  // Handle --theme
  if (argv.theme) {
    if (config.VALID_THEMES.includes(argv.theme)) {
      config.setTheme(argv.theme);
    } else {
      console.error(chalk.red(`❌ Invalid theme: ${argv.theme}`));
      process.exit(1);
    }
  }
  
  // Check for piped input
  if (!process.stdin.isTTY) {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', async () => {
      await handlePipedInput(data);
    });
    return;
  }
  
  // Check API health before starting
  const spinner = createSpinner('Connecting to API...');
  spinner.start();
  
  try {
    const isHealthy = await api.healthCheck();
    spinner.stop();
    
    if (!isHealthy) {
      console.log(chalk.yellow('\n⚠ Warning: Could not connect to API at ' + config.getApiBaseUrl()));
      console.log(chalk.gray('   The CLI will still start, but commands may fail.\n'));
    }
  } catch {
    spinner.stop();
    console.log(chalk.yellow('\n⚠ Warning: API health check failed'));
    console.log(chalk.gray('   The CLI will still start, but commands may fail.\n'));
  }
  
  // Fetch available models
  await fetchModels();
  await fetchImageModels();
  
  // Start interactive REPL
  startREPL();
}

COMMANDS.push('/upload', '/artifacts', '/download-artifact', '/download-image', '/makefile');

async function handleArtifactUploadCommand(filePath) {
  if (!filePath) {
    console.log(chalk.yellow('Usage: /upload <file-path>'));
    return true;
  }
  if (!currentSessionId) {
    await handleNew();
  }
  const spinner = createSpinner('Uploading artifact...');
  spinner.start();
  try {
    const artifact = await api.uploadArtifact(filePath, currentSessionId, currentMode);
    spinner.succeed(chalk.green(`Uploaded: ${artifact.filename}`));
  } catch (err) {
    spinner.fail(chalk.red(`Upload failed: ${err.message}`));
  }
  return true;
}

async function handleArtifactListCommand() {
  if (!currentSessionId) {
    console.log(chalk.yellow('No active session'));
    return true;
  }
  const spinner = createSpinner('Loading artifacts...');
  spinner.start();
  try {
    const result = await api.listArtifacts(currentSessionId);
    spinner.stop();
    const artifacts = result.artifacts || [];
    if (artifacts.length === 0) {
      console.log(chalk.yellow('\nNo artifacts for this session\n'));
      return true;
    }
    console.log(chalk.cyan.bold('\nArtifacts:'));
    artifacts.forEach((artifact) => {
      console.log(chalk.gray(formatSessionArtifactLine(artifact)));
    });
    console.log('');
  } catch (err) {
    spinner.fail(chalk.red(`Failed to list artifacts: ${err.message}`));
  }
  return true;
}

async function handleArtifactDownloadCommand(args) {
  const [artifactId, outputPath] = args.split(' ').filter(Boolean);
  if (!artifactId) {
    console.log(chalk.yellow('Usage: /download-artifact <artifact-id> [output-file]'));
    return true;
  }
  const spinner = createSpinner('Downloading artifact...');
  spinner.start();
  try {
    const target = outputPath || `artifact-${artifactId.slice(0, 8)}`;
    await api.downloadArtifact(artifactId, target);
    spinner.succeed(chalk.green(`Saved to ${target}`));
  } catch (err) {
    spinner.fail(chalk.red(`Download failed: ${err.message}`));
  }
  return true;
}

async function handleMakeFileCommand(args) {
  const [format, ...promptParts] = args.split(' ');
  const prompt = promptParts.join(' ').trim();
  if (!format || !prompt) {
    console.log(chalk.yellow('Usage: /makefile <format> <prompt>'));
    return true;
  }
  if (!currentSessionId) {
    await handleNew();
  }
  const spinner = createSpinner(`Generating ${format} artifact...`);
  spinner.start();
  try {
    const result = await api.generateArtifact({
      sessionId: currentSessionId,
      mode: currentMode,
      prompt,
      format,
    });
    spinner.succeed(chalk.green(`Generated: ${result.artifact.filename}`));
    console.log(chalk.gray(`Download: ${result.artifact.downloadUrl}`));
  } catch (err) {
    spinner.fail(chalk.red(`Artifact generation failed: ${err.message}`));
  }
  return true;
}

const originalProcessInput = processInput;
processInput = async function(input) {
  const trimmed = String(input || '').trim();
  if (activeProviderSession) {
    return originalProcessInput(input);
  }
  if (trimmed.startsWith('/upload')) {
    return handleArtifactUploadCommand(trimmed.replace('/upload', '').trim());
  }
  if (trimmed === '/artifacts') {
    return handleArtifactListCommand();
  }
  if (trimmed.startsWith('/download-artifact')) {
    return handleArtifactDownloadCommand(trimmed.replace('/download-artifact', '').trim());
  }
  if (trimmed.startsWith('/download-image')) {
    return handleDownloadImageCommand(trimmed.replace('/download-image', '').trim());
  }
  if (trimmed.startsWith('/makefile')) {
    return handleMakeFileCommand(trimmed.replace('/makefile', '').trim());
  }
  return originalProcessInput(input);
};

// Run main
main().catch((err) => {
  console.error(chalk.red(`❌ Fatal error: ${err.message}`));
  process.exit(1);
});















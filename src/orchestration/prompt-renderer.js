const { normalizeIssue } = require('./symphony');

const DEFAULT_PROMPT = 'You are working on an issue from Linear.';
const ALLOWED_FILTERS = new Set(['default', 'json']);
const REQUIRED_PROMPT_SURFACE_IDS = Object.freeze([
  'chat-continuity',
  'conversation-planner',
  'canvas-generation',
  'notation-helper',
  'notes-page-editor',
  'remote-cli-agent',
  'tool-doc-guidance',
  'skill-guidance',
]);

const PROMPT_SURFACE_INVENTORY = Object.freeze([
  {
    id: 'agent-soul',
    name: 'Agent Soul',
    promptFamily: 'runtime',
    ownerSurface: 'shared session instructions',
    sourceFile: 'soul.md',
    expectedTests: ['src/routes/admin/prompts.controller.test.js'],
    exposure: 'universal',
  },
  {
    id: 'agent-notes',
    name: 'Carryover Notes',
    promptFamily: 'runtime',
    ownerSurface: 'shared carryover memory',
    sourceFile: 'agent-notes.md',
    expectedTests: ['src/routes/admin/prompts.controller.test.js'],
    exposure: 'universal',
  },
  {
    id: 'agent-user-profile',
    name: 'User Profile',
    promptFamily: 'runtime',
    ownerSurface: 'shared Hermes USER.md memory',
    sourceFile: 'user.md',
    expectedTests: ['src/routes/admin/prompts.controller.test.js', 'src/session-instructions.test.js'],
    exposure: 'universal',
  },
  {
    id: 'chat-continuity',
    name: 'Chat Continuity Instructions',
    promptFamily: 'runtime',
    ownerSurface: '/api/chat and OpenAI-compatible routes',
    sourceFile: 'src/runtime-prompts.js',
    expectedTests: ['src/openai-client.test.js', 'src/runtime-execution.test.js'],
    exposure: 'universal',
  },
  {
    id: 'conversation-planner',
    name: 'Conversation Tool Planner',
    promptFamily: 'planner',
    ownerSurface: 'conversation orchestrator',
    sourceFile: 'src/conversation-orchestrator.js',
    expectedTests: ['src/conversation-orchestrator.test.js'],
    exposure: 'conditional',
    condition: 'Tool planning is enabled and candidate tools are available.',
  },
  {
    id: 'canvas-generation',
    name: 'Canvas Generation Instructions',
    promptFamily: 'canvas',
    ownerSurface: '/api/canvas',
    sourceFile: 'src/routes/canvas.js',
    expectedTests: ['src/routes/canvas.test.js'],
    exposure: 'conditional',
    condition: 'Canvas requests build a type-specific prompt for code, document, diagram, or frontend output.',
  },
  {
    id: 'notation-helper',
    name: 'Notation Helper Instructions',
    promptFamily: 'notation',
    ownerSurface: '/api/notation',
    sourceFile: 'src/routes/notation.js',
    expectedTests: ['src/routes/notation.test.js'],
    exposure: 'conditional',
    condition: 'Notation requests build mode-specific expand, explain, or validate instructions.',
  },
  {
    id: 'notes-page-editor',
    name: 'Notes Page Editor Prompt',
    promptFamily: 'notes',
    ownerSurface: 'notes app',
    sourceFile: 'frontend/notes-notion/js/agent.js',
    expectedTests: ['frontend/notes-notion/js/agent.parse.test.js', 'src/routes/notes.test.js'],
    exposure: 'conditional',
    condition: 'Notes mode is active and page-editing intent is detected.',
  },
  {
    id: 'remote-cli-agent',
    name: 'Remote CLI Agent Instructions',
    promptFamily: 'remote-cli',
    ownerSurface: 'remote-cli-agent tool',
    sourceFile: 'src/remote-cli/agents-sdk-runner.js',
    expectedTests: ['src/remote-cli/agents-sdk-runner.test.js'],
    exposure: 'conditional',
    condition: 'Remote software creation, update, deployment, or verification is delegated to remote-cli-agent.',
  },
  {
    id: 'tool-doc-guidance',
    name: 'Tool Doc Guidance',
    promptFamily: 'tool-docs',
    ownerSurface: 'tool-doc-read and tool execution planning',
    sourceFile: 'src/agent-sdk/tool-docs',
    expectedTests: ['src/routes/tools.test.js', 'src/agent-sdk/tools/index.test.js'],
    exposure: 'conditional',
    condition: 'A tool has long-form docs or the planner requests tool-doc-read; includes self-reflection-update guidance for bounded durable learning updates.',
  },
  {
    id: 'skill-guidance',
    name: 'Skill Guidance',
    promptFamily: 'skills',
    ownerSurface: 'natural context and skill tree instructions',
    sourceFile: 'src/natural-context.js',
    expectedTests: ['src/natural-context.test.js'],
    exposure: 'conditional',
    condition: 'Registered skills are relevant to the current client surface or task type.',
  },
  {
    id: 'artifact-html-plan',
    name: 'Artifact Plan Pass',
    promptFamily: 'artifacts',
    ownerSurface: 'artifact pipeline',
    sourceFile: 'src/artifacts/artifact-service.js',
    expectedTests: ['src/artifacts/artifact-service.test.js'],
    exposure: 'conditional',
    condition: 'Multi-pass HTML artifact generation is active.',
  },
  {
    id: 'artifact-html-expand',
    name: 'Artifact Expand Pass',
    promptFamily: 'artifacts',
    ownerSurface: 'artifact pipeline',
    sourceFile: 'src/artifacts/artifact-service.js',
    expectedTests: ['src/artifacts/artifact-service.test.js'],
    exposure: 'conditional',
    condition: 'Multi-pass HTML artifact generation is active.',
  },
  {
    id: 'artifact-html-compose',
    name: 'Artifact Compose Pass',
    promptFamily: 'artifacts',
    ownerSurface: 'artifact pipeline',
    sourceFile: 'src/artifacts/artifact-service.js',
    expectedTests: ['src/artifacts/artifact-service.test.js'],
    exposure: 'conditional',
    condition: 'Multi-pass HTML artifact generation is active.',
  },
]);

function getPromptSurfaceInventory() {
  return PROMPT_SURFACE_INVENTORY.map((entry) => ({
    ...entry,
    expectedTests: [...entry.expectedTests],
  }));
}

function getRequiredPromptSurfaceIds() {
  return [...REQUIRED_PROMPT_SURFACE_IDS];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolvePath(context = {}, expression = '') {
  const parts = String(expression || '').trim().split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throwTemplateError('template_render_error', 'Empty template expression.');
  }
  let current = context;
  for (const part of parts) {
    if (!isPlainObject(current) && !Array.isArray(current)) {
      throwTemplateError('template_render_error', `Unknown template variable: ${expression}`);
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      throwTemplateError('template_render_error', `Unknown template variable: ${expression}`);
    }
    current = current[part];
  }
  return current;
}

function parseFilter(rawFilter = '') {
  const trimmed = String(rawFilter || '').trim();
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(?::\s*(.*))?$/);
  if (!match) {
    throwTemplateError('template_parse_error', `Invalid template filter: ${rawFilter}`);
  }
  const [, name, rawArg = ''] = match;
  if (!ALLOWED_FILTERS.has(name)) {
    throwTemplateError('template_render_error', `Unknown template filter: ${name}`);
  }
  return {
    name,
    arg: parseFilterArg(rawArg),
  };
}

function parseFilterArg(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return undefined;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'null') {
    return null;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function applyFilter(value, filter = {}) {
  if (filter.name === 'default') {
    return value == null || value === '' ? filter.arg : value;
  }
  if (filter.name === 'json') {
    return JSON.stringify(value);
  }
  throwTemplateError('template_render_error', `Unknown template filter: ${filter.name}`);
}

function stringifyTemplateValue(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function throwTemplateError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function renderPromptTemplate(template = '', {
  issue = {},
  attempt = null,
} = {}) {
  const source = String(template || '').trim() || DEFAULT_PROMPT;
  const context = {
    issue: normalizeIssue(issue),
    attempt,
  };

  return source.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, expression) => {
    const segments = String(expression || '').split('|').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) {
      throwTemplateError('template_parse_error', 'Empty template expression.');
    }
    let value = resolvePath(context, segments[0]);
    for (const rawFilter of segments.slice(1)) {
      value = applyFilter(value, parseFilter(rawFilter));
    }
    return stringifyTemplateValue(value);
  });
}

module.exports = {
  DEFAULT_PROMPT,
  getPromptSurfaceInventory,
  getRequiredPromptSurfaceIds,
  renderPromptTemplate,
};

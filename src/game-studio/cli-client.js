'use strict';

const fs = require('fs/promises');

const DEFAULT_BASE_URL = 'http://localhost:3000';

function normalizeBaseUrl(value = '') {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function parseArgs(argv = []) {
  const values = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (!argument.startsWith('--')) {
      values._.push(argument);
      continue;
    }
    const separator = argument.indexOf('=');
    const key = argument.slice(2, separator > 0 ? separator : undefined);
    if (!key) continue;
    if (separator > 0) {
      values[key] = argument.slice(separator + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      values[key] = String(next);
      index += 1;
    } else {
      values[key] = true;
    }
  }
  return values;
}

function required(options, key, command) {
  const value = String(options[key] || '').trim();
  if (!value) throw Object.assign(new Error(`${command} requires --${key}`), { code: 'CLI_ARGUMENT_REQUIRED' });
  return value;
}

function integer(options, key, command) {
  const value = Number(required(options, key, command));
  if (!Number.isInteger(value) || value < 1) throw Object.assign(new Error(`${command} --${key} must be a positive integer`), { code: 'CLI_ARGUMENT_INVALID' });
  return value;
}

class StudioCliClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = String(options.token || '').trim();
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new Error('Lilly Game CLI requires the Node.js fetch API');
  }

  async request(route, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    let payload = null;
    try { payload = await response.json(); } catch (_error) {}
    if (!response.ok) {
      const error = Object.assign(new Error(payload?.error?.message || `Game Studio API request failed (${response.status})`), {
        code: payload?.error?.code || 'GAME_STUDIO_API_FAILED',
        status: response.status,
        payload,
      });
      throw error;
    }
    return payload;
  }
}

function helpText() {
  return `Lilly Game CLI — headless project, playtest, build, and publishing workflow

Usage:
  lilly-game templates
  lilly-game list
  lilly-game create --name NAME [--template ID] [--prompt TEXT] [--seed VALUE]
  lilly-game inspect --project ID
  lilly-game validate --project ID
  lilly-game validate-file --file PROJECT.json
  lilly-game compile --project ID --revision N
  lilly-game test --project ID
  lilly-game ai --project ID --base-revision N --prompt TEXT [--mode edit|level|asset] [--model ID]
  lilly-game ai --project ID --base-revision N --mode asset --recipe model.json
  lilly-game ai-apply --project ID --run ID
  lilly-game apply --project ID --base-revision N --commands commands.json
  lilly-game data-list --project ID
  lilly-game data-set --project ID --base-revision N --file data-asset.json
  lilly-game data-delete --project ID --base-revision N --data-asset ID
  lilly-game profiles --project ID
  lilly-game profile-set --project ID --base-revision N --file build-profile.json
  lilly-game profile-use --project ID --base-revision N --profile ID
  lilly-game prefab-add --project ID --base-revision N --scene ID --path FILE --instance ID [--config overrides.json]
  lilly-game prefab-refresh --project ID --base-revision N --scene ID --instance ID
  lilly-game prefab-unpack --project ID --base-revision N --scene ID --instance ID
  lilly-game build --project ID --revision N [--profile ID]
  lilly-game publish --build ID [--host game.demoserver2.buzz]
  lilly-game rollback --project ID --revision N

Connection:
  --url URL       Defaults to LILLY_GAME_STUDIO_URL, KIMIBUILT_BACKEND_URL, or http://localhost:3000
  --token TOKEN   Defaults to LILLY_API_TOKEN or KIMIBUILT_FRONTEND_API_KEY
  --compact       Emit compact JSON for agent pipelines

Examples:
  lilly-game create --name "Signal Field" --template third-person-explorer
  lilly-game compile --project PROJECT_ID --revision 1
  lilly-game test --project PROJECT_ID
  lilly-game build --project PROJECT_ID --revision 1`;
}

async function validateLocalFile(filePath) {
  const core = require('../../packages/lilly-engine/dist/core/src');
  const modules = require('../../packages/lilly-engine/dist/modules/src');
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const project = core.upgradeProject(parsed);
  const projectIssues = core.validateProject(project);
  const moduleBundle = modules.compileModuleBundle(project.files || []);
  const moduleIssues = moduleBundle.diagnostics;
  return {
    schema: 'LillyCliValidation/v1',
    file: filePath,
    engineVersion: core.ENGINE_VERSION,
    runtimeProfile: project.settings.runtimeProfile,
    valid: !projectIssues.some((issue) => issue.severity === 'error') && !moduleIssues.some((issue) => issue.severity === 'error'),
    projectIssues,
    moduleIssues,
    moduleSummary: {
      sourceHash: moduleBundle.sourceHash,
      modules: moduleBundle.modules.length,
      systems: moduleBundle.systems.length,
      tests: moduleBundle.tests.length,
    },
  };
}

async function executeCommand(client, command, options) {
  if (command === 'templates') {
    const contracts = await client.request('/api/game-studio/contracts');
    return { schema: contracts.schema, engineVersion: contracts.engineVersion, templates: contracts.projectTemplates || [] };
  }
  if (command === 'list') return client.request('/api/game-studio/projects');
  if (command === 'create') return client.request('/api/game-studio/projects', {
    method: 'POST',
    body: {
      name: required(options, 'name', command),
      ...(options.template ? { template: options.template } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.seed ? { seed: options.seed } : {}),
      ...(options.slug ? { slug: options.slug } : {}),
    },
  });
  if (command === 'validate-file') return validateLocalFile(required(options, 'file', command));
  if (command === 'inspect' || command === 'validate') {
    const result = await client.request(`/api/game-studio/projects/${encodeURIComponent(required(options, 'project', command))}`);
    return command === 'inspect' ? result : {
      schema: 'LillyCliValidation/v1',
      projectId: result.project.id,
      revision: result.project.revision,
      engineVersion: result.project.engineVersion,
      runtimeProfile: result.project.settings.runtimeProfile,
      ...result.validation,
    };
  }
  if (command === 'compile') {
    const projectId = required(options, 'project', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/compile`, { method: 'POST', body: { revision: integer(options, 'revision', command) } });
  }
  if (command === 'test') {
    const projectId = required(options, 'project', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/playtests`, { method: 'POST', body: {} });
  }
  if (command === 'ai') {
    const projectId = required(options, 'project', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/ai-runs`, {
      method: 'POST',
      body: {
        baseRevision: integer(options, 'base-revision', command),
        prompt: options.recipe ? String(options.prompt || 'Authored model recipe') : required(options, 'prompt', command),
        mode: ['level', 'asset'].includes(options.mode) ? options.mode : 'edit',
        ...(options.recipe ? { recipe: JSON.parse(await fs.readFile(String(options.recipe), 'utf8')) } : {}),
        ...(options.model ? { model: String(options.model), requireAi: true } : {}),
        ...(options.seed ? { seed: options.seed } : {}),
      },
    });
  }
  if (command === 'ai-apply') {
    return client.request(`/api/game-studio/projects/${encodeURIComponent(required(options, 'project', command))}/ai-runs/${encodeURIComponent(required(options, 'run', command))}/apply`, { method: 'POST', body: {} });
  }
  if (command === 'apply') {
    const projectId = required(options, 'project', command);
    const parsed = JSON.parse(await fs.readFile(required(options, 'commands', command), 'utf8'));
    const commands = Array.isArray(parsed) ? parsed : parsed.commands;
    if (!Array.isArray(commands)) throw Object.assign(new Error('apply command file must contain a JSON array or {"commands": [...]}'), { code: 'CLI_COMMAND_BATCH_INVALID' });
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/commands`, {
      method: 'POST',
      body: { baseRevision: integer(options, 'base-revision', command), commands, source: 'lilly-game-cli' },
    });
  }
  if (command === 'data-list') {
    const projectId = required(options, 'project', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/data-assets`);
  }
  if (command === 'data-set') {
    const projectId = required(options, 'project', command);
    const dataAsset = JSON.parse(await fs.readFile(required(options, 'file', command), 'utf8'));
    const dataAssetId = String(dataAsset.id || required(options, 'data-asset', command));
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/data-assets/${encodeURIComponent(dataAssetId)}`, { method: 'PUT', body: { baseRevision: integer(options, 'base-revision', command), dataAsset } });
  }
  if (command === 'data-delete') {
    const projectId = required(options, 'project', command);
    const dataAssetId = required(options, 'data-asset', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/data-assets/${encodeURIComponent(dataAssetId)}`, { method: 'DELETE', body: { baseRevision: integer(options, 'base-revision', command) } });
  }
  if (command === 'profiles') {
    const projectId = required(options, 'project', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/build-profiles`);
  }
  if (command === 'profile-set') {
    const projectId = required(options, 'project', command);
    const buildProfile = JSON.parse(await fs.readFile(required(options, 'file', command), 'utf8'));
    const buildProfileId = String(buildProfile.id || required(options, 'profile', command));
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/build-profiles/${encodeURIComponent(buildProfileId)}`, { method: 'PUT', body: { baseRevision: integer(options, 'base-revision', command), buildProfile } });
  }
  if (command === 'profile-use') {
    const projectId = required(options, 'project', command);
    const buildProfileId = required(options, 'profile', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/build-profiles/${encodeURIComponent(buildProfileId)}/activate`, { method: 'POST', body: { baseRevision: integer(options, 'base-revision', command) } });
  }
  if (command === 'prefab-add') {
    const projectId = required(options, 'project', command);
    const config = options.config ? JSON.parse(await fs.readFile(String(options.config), 'utf8')) : {};
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/prefab-instances`, { method: 'POST', body: { baseRevision: integer(options, 'base-revision', command), sceneId: required(options, 'scene', command), path: required(options, 'path', command), instanceId: required(options, 'instance', command), ...(options.parent ? { parentId: options.parent } : {}), config } });
  }
  if (command === 'prefab-refresh' || command === 'prefab-unpack') {
    const projectId = required(options, 'project', command);
    const action = command === 'prefab-refresh' ? 'refresh' : 'unpack';
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/prefab-instances/${encodeURIComponent(required(options, 'instance', command))}/${action}`, { method: 'POST', body: { baseRevision: integer(options, 'base-revision', command), sceneId: required(options, 'scene', command) } });
  }
  if (command === 'build') {
    const projectId = required(options, 'project', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/builds`, { method: 'POST', body: { projectRevision: integer(options, 'revision', command), ...(options.profile ? { buildProfileId: options.profile } : {}) } });
  }
  if (command === 'publish') return client.request(`/api/game-studio/builds/${encodeURIComponent(required(options, 'build', command))}/publish`, {
    method: 'POST',
    body: options.host ? { publicHost: options.host } : {},
  });
  if (command === 'rollback') {
    const projectId = required(options, 'project', command);
    return client.request(`/api/game-studio/projects/${encodeURIComponent(projectId)}/rollback`, { method: 'POST', body: { revision: integer(options, 'revision', command) } });
  }
  throw Object.assign(new Error(`Unknown command ${command || '<missing>'}`), { code: 'CLI_COMMAND_UNKNOWN' });
}

async function runCli(argv = [], environment = process.env, io = {}, fetchImplementation = globalThis.fetch) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const options = parseArgs(argv);
  const command = String(options._[0] || 'help').toLowerCase();
  if (command === 'help' || options.help) {
    stdout.write(`${helpText()}\n`);
    return 0;
  }
  try {
    const client = new StudioCliClient({
      baseUrl: options.url || environment.LILLY_GAME_STUDIO_URL || environment.KIMIBUILT_BACKEND_URL || DEFAULT_BASE_URL,
      token: options.token || environment.LILLY_API_TOKEN || environment.KIMIBUILT_FRONTEND_API_KEY || '',
      fetch: fetchImplementation,
    });
    const result = await executeCommand(client, command, options);
    stdout.write(`${JSON.stringify(result, null, options.compact ? 0 : 2)}\n`);
    if (result?.valid === false || result?.status === 'failed') return 2;
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ error: { code: error.code || 'LILLY_GAME_CLI_FAILED', message: error.message, status: error.status || null } })}\n`);
    return 1;
  }
}

module.exports = {
  StudioCliClient,
  executeCommand,
  helpText,
  normalizeBaseUrl,
  parseArgs,
  runCli,
  validateLocalFile,
};

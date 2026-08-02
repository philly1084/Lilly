'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const { config } = require('../config');
const { postgres } = require('../postgres');
const { SANDBOX_ROOT } = require('../sandbox-workspace-storage');
const { parseLenientJson } = require('../utils/lenient-json');
const { normalizeFrontendBundle } = require('../frontend-bundles');
const {
  BLUEPRINT_SCHEMA,
  BUILD_SCHEMA,
  COMMAND_SCHEMA,
  PROJECT_SCHEMA,
  applyCommandBatch,
  createArenaProject,
  createBlankProject,
  createLevelRecipeFromPrompt,
  deepClone,
  generateLevel,
  getScene,
  upgradeProject,
  validateGeneratedLevel,
  validateLevelRecipe,
  validateProject,
} = require('../../packages/lilly-engine/dist/core/src');
const {
  compileBlueprint,
  validateBlueprint,
} = require('../../packages/lilly-engine/dist/blueprints/src');
const { GameplaySimulation } = require('../../packages/lilly-engine/dist/gameplay/src');
const {
  assertModuleBundleValid,
  compileModuleBundle,
} = require('../../packages/lilly-engine/dist/modules/src');
const { PLAYER_RUNTIME_HASH, writeImmutableBuild } = require('./player-bundle');
const { runMechanicTests } = require('./module-runner');

const INDEX_SCHEMA = 'LillyGameStudioIndex/v1';
const AI_RUN_SCHEMA = 'LillyAiRun/v1';
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_FILES = 80;
const ALLOWED_ASSET_TYPES = new Set([
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'image/jpeg',
  'image/png',
  'image/webp',
  'model/gltf-binary',
  'model/gltf+json',
  'application/octet-stream',
]);

function slugify(value = '') {
  return String(value || 'game')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 50) || 'game';
}

function safeFileName(value = '') {
  const extension = path.extname(String(value || '')).toLowerCase().slice(0, 12);
  const stem = path.basename(String(value || 'asset'), path.extname(String(value || '')))
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'asset';
  return `${stem}${extension}`;
}

function now() {
  return new Date().toISOString();
}

function serializeError(error) {
  return {
    code: String(error?.code || 'GAME_STUDIO_ERROR'),
    message: String(error?.message || 'Game Studio operation failed'),
    ...(error?.issues ? { issues: error.issues } : {}),
  };
}

function normalizeImportBundle(input = null) {
  if (!input || typeof input !== 'object') return null;
  const bundle = normalizeFrontendBundle(input, '');
  if (!bundle.files.length) throw Object.assign(new Error('Import bundle has no readable files'), { statusCode: 400, code: 'IMPORT_BUNDLE_EMPTY' });
  if (bundle.files.length > MAX_IMPORT_FILES) throw Object.assign(new Error(`Import bundles are limited to ${MAX_IMPORT_FILES} files`), { statusCode: 413, code: 'IMPORT_FILE_LIMIT' });
  const files = bundle.files.map((file) => ({ path: file.path, content: file.contentBuffer || Buffer.from(String(file.content || ''), 'utf8') }));
  const totalBytes = files.reduce((total, file) => total + file.content.length, 0);
  if (totalBytes > MAX_IMPORT_BYTES) throw Object.assign(new Error(`Import bundles are limited to ${MAX_IMPORT_BYTES} bytes`), { statusCode: 413, code: 'IMPORT_SIZE_LIMIT' });
  const entry = files.find((file) => file.path === bundle.entry) || files.find((file) => /\.html?$/i.test(file.path));
  if (!entry || !/(?:three(?:\.js)?|webgl|<canvas\b)/i.test(entry.content.toString('utf8'))) {
    throw Object.assign(new Error('Import requires a compatible HTML, Three.js, WebGL, or canvas bundle'), { statusCode: 400, code: 'IMPORT_BUNDLE_INCOMPATIBLE' });
  }
  return { entry: entry.path, frameworkTarget: bundle.frameworkTarget, files, totalBytes };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

class GameStudioService {
  constructor(options = {}) {
    this.root = path.resolve(options.root || path.join(config.persistence.dataDir, 'game-studio'));
    this.buildRoot = path.resolve(options.buildRoot || SANDBOX_ROOT);
    this.postgres = options.postgres || postgres;
    this.complete = options.complete || null;
    this.managedAppService = options.managedAppService || null;
    this.events = new EventEmitter();
    this.events.setMaxListeners(200);
    this.locks = new Map();
    this.initialized = false;
  }

  isEnabled() {
    return config.gameStudio?.enabled === true || process.env.NODE_ENV === 'test';
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(this.buildRoot, { recursive: true });
    if (!await pathExists(this.indexPath())) {
      await this.writeIndex({ schema: INDEX_SCHEMA, projects: [], builds: [], aiRuns: [], updatedAt: now() });
    }
    this.initialized = true;
    return this;
  }

  indexPath() { return path.join(this.root, 'index.json'); }
  projectDirectory(projectId) { return path.join(this.root, 'projects', projectId); }
  revisionPath(projectId, revision) { return path.join(this.projectDirectory(projectId), 'revisions', `${revision}.json`); }
  currentPath(projectId) { return path.join(this.projectDirectory(projectId), 'current.json'); }

  async ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }

  async readIndex() {
    await this.ensureInitialized();
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath(), 'utf8'));
      if (parsed?.schema === INDEX_SCHEMA) return parsed;
    } catch (_error) {}
    return { schema: INDEX_SCHEMA, projects: [], builds: [], aiRuns: [], updatedAt: now() };
  }

  async writeIndex(index) {
    await fs.mkdir(this.root, { recursive: true });
    const targetPath = this.indexPath();
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify({ ...index, schema: INDEX_SCHEMA, updatedAt: now() }, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, targetPath);
  }

  async withProjectLock(projectId, operation) {
    const previous = this.locks.get(projectId) || null;
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    this.locks.set(projectId, turn);
    if (previous) await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(projectId) === turn) this.locks.delete(projectId);
    }
  }

  async writeJsonAtomic(targetPath, value) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, targetPath);
  }

  async readProjectFile(targetPath) {
    return upgradeProject(JSON.parse(await fs.readFile(targetPath, 'utf8')));
  }

  async persistSnapshot(project, audit = {}) {
    await this.writeJsonAtomic(this.revisionPath(project.id, project.revision), project);
    await this.writeJsonAtomic(this.currentPath(project.id), project);
    await this.persistPostgresRevision(project, audit);
  }

  async persistPostgresRevision(project, audit = {}) {
    if (!this.postgres?.enabled) return;
    try {
      await this.postgres.query(`
        INSERT INTO game_studio_projects (id, owner_id, name, slug, current_revision, engine_version, metadata, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          name = EXCLUDED.name,
          slug = EXCLUDED.slug,
          current_revision = EXCLUDED.current_revision,
          engine_version = EXCLUDED.engine_version,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, [project.id, audit.ownerId, project.name, project.slug, project.revision, project.engineVersion, JSON.stringify(audit.metadata || {})]);
      await this.postgres.query(`
        INSERT INTO game_studio_revisions (project_id, revision, owner_id, snapshot, commands, inverse_commands, source, created_at)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, NOW())
        ON CONFLICT (project_id, revision) DO NOTHING
      `, [project.id, project.revision, audit.ownerId, JSON.stringify(project), JSON.stringify(audit.commands || []), JSON.stringify(audit.inverses || []), audit.source || 'editor']);
    } catch (error) {
      console.warn(`[GameStudio] PostgreSQL revision mirror failed: ${error.message}`);
    }
  }

  async emit(projectId, type, payload = {}) {
    const event = { id: randomUUID(), schema: 'LillyGameStudioEvent/v1', projectId, type, payload, createdAt: now() };
    const eventPath = path.join(this.projectDirectory(projectId), 'events.ndjson');
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8');
    this.events.emit(projectId, event);
    if (this.postgres?.enabled) {
      try {
        await this.postgres.query('INSERT INTO game_studio_events (id, project_id, event_type, payload) VALUES ($1, $2, $3, $4::jsonb)', [event.id, projectId, type, JSON.stringify(payload)]);
      } catch (error) {
        console.warn(`[GameStudio] PostgreSQL event mirror failed: ${error.message}`);
      }
    }
    return event;
  }

  subscribe(projectId, listener) {
    this.events.on(projectId, listener);
    return () => this.events.off(projectId, listener);
  }

  async createProject(input = {}, ownerId = '') {
    await this.ensureInitialized();
    if (!ownerId) throw Object.assign(new Error('Project creation requires an authenticated owner'), { statusCode: 401, code: 'OWNER_REQUIRED' });
    const id = randomUUID();
    const name = String(input.name || input.project?.name || 'My Lilly Game').trim().slice(0, 100) || 'My Lilly Game';
    const slug = slugify(input.slug || name);
    const imported = input.project?.schema === PROJECT_SCHEMA ? upgradeProject(deepClone(input.project)) : null;
    const importedBundle = normalizeImportBundle(input.importBundle);
    const template = input.template === 'blank' ? 'blank' : 'expedition';
    const project = upgradeProject(imported || (template === 'blank'
      ? createBlankProject({ id, name, slug })
      : createArenaProject({ id, name, slug, prompt: input.prompt, seed: input.seed })));
    project.id = id;
    project.name = name;
    project.slug = slug;
    project.revision = 1;
    if (importedBundle && !imported) {
      project.settings.legacyImport = { status: 'archived-needs-mapping', entry: importedBundle.entry, manualMappingRequired: true };
      project.assets.push({
        id: 'legacy-source-bundle',
        name: 'Imported web game source',
        type: 'application/x-lilly-legacy-game-bundle',
        uri: `imports/original/${importedBundle.entry}`,
        metadata: { fileCount: importedBundle.files.length, sizeBytes: importedBundle.totalBytes, conversion: 'manual' },
      });
    }
    const issues = validateProject(project).filter((issue) => issue.severity === 'error');
    if (issues.length) throw Object.assign(new Error('Imported project is invalid'), { statusCode: 400, code: 'INVALID_PROJECT', issues });
    const createdAt = now();
    const metadata = {
      id,
      ownerId,
      name,
      slug,
      revision: project.revision,
      engineVersion: project.engineVersion,
      createdAt,
      updatedAt: createdAt,
      source: imported ? 'import:lilly-project' : (importedBundle ? 'import:compatible-web-bundle' : `template:${template === 'blank' ? 'blank-agent-project' : 'ai-procedural-expedition'}`),
      importedBundle: importedBundle ? {
        schema: 'LillyImportedBundle/v1',
        entry: importedBundle.entry,
        fileCount: importedBundle.files.length,
        sizeBytes: importedBundle.totalBytes,
        status: 'archived-needs-mapping',
      } : null,
    };
    if (importedBundle) {
      const importRoot = path.join(this.projectDirectory(id), 'imports', 'original');
      for (const file of importedBundle.files) {
        const target = path.resolve(importRoot, file.path);
        const relative = path.relative(importRoot, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('Import path escaped the project workspace'), { statusCode: 400, code: 'IMPORT_PATH_INVALID' });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content, { flag: 'wx' });
      }
      await this.writeJsonAtomic(path.join(importRoot, 'lilly-import.json'), metadata.importedBundle);
    }
    await this.persistSnapshot(project, { ownerId, source: metadata.source, metadata });
    const index = await this.readIndex();
    index.projects.push(metadata);
    await this.writeIndex(index);
    await this.emit(id, 'project.created', { revision: project.revision, name });
    return this.describeProject(metadata, project, index);
  }

  async listProjects(ownerId) {
    const index = await this.readIndex();
    return index.projects
      .filter((project) => project.ownerId === ownerId)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((project) => ({ ...project, latestBuild: index.builds.find((build) => build.projectId === project.id && build.status !== 'failed') || null }));
  }

  async getMetadata(projectId, ownerId) {
    const index = await this.readIndex();
    const metadata = index.projects.find((project) => project.id === projectId && project.ownerId === ownerId);
    return { metadata: metadata || null, index };
  }

  async getProject(projectId, ownerId) {
    const { metadata, index } = await this.getMetadata(projectId, ownerId);
    if (!metadata) return null;
    const project = await this.readProjectFile(this.currentPath(projectId));
    return this.describeProject(metadata, project, index);
  }

  describeProject(metadata, project, index) {
    const blueprintIssues = project.blueprints.flatMap((graph) => validateBlueprint(graph).map((issue) => ({ ...issue, graphId: graph.id })));
    const moduleBundle = compileModuleBundle(project.files || []);
    const moduleIssues = moduleBundle.diagnostics;
    return {
      metadata,
      project,
      validation: {
        valid: !validateProject(project).some((issue) => issue.severity === 'error')
          && !blueprintIssues.some((issue) => issue.severity === 'error')
          && !moduleIssues.some((issue) => issue.severity === 'error'),
        projectIssues: validateProject(project),
        blueprintIssues,
        moduleIssues,
      },
      moduleSummary: {
        schema: moduleBundle.schema,
        sourceHash: moduleBundle.sourceHash,
        loadOrder: moduleBundle.loadOrder,
        modules: moduleBundle.modules.map((module) => ({ id: module.id, name: module.name, version: module.version, sourcePath: module.sourcePath, capabilities: module.capabilities })),
        systems: moduleBundle.systems.map((system) => ({ moduleId: system.moduleId, path: system.path, sourceHash: system.sourceHash })),
        mechanics: moduleBundle.mechanics.map((mechanic) => ({ id: mechanic.id, moduleId: mechanic.moduleId, name: mechanic.name, sourcePath: mechanic.sourcePath, inputs: mechanic.inputs, events: mechanic.events })),
        prefabs: moduleBundle.prefabs.map((prefab) => ({ id: prefab.id, moduleId: prefab.moduleId, name: prefab.name, sourcePath: prefab.sourcePath })),
        tests: moduleBundle.tests.map((test) => ({ id: test.id, moduleId: test.moduleId, name: test.name, sourcePath: test.sourcePath })),
      },
      builds: index.builds.filter((build) => build.projectId === project.id).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
      aiRuns: index.aiRuns.filter((run) => run.projectId === project.id).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 20),
    };
  }

  normalizeCommands(project, commands = [], baseRevision = project.revision) {
    if (!Array.isArray(commands) || commands.length === 0) throw Object.assign(new Error('At least one LillyCommand/v1 command is required'), { statusCode: 400, code: 'COMMANDS_REQUIRED' });
    return commands.map((raw) => ({
      schema: COMMAND_SCHEMA,
      commandId: String(raw.commandId || randomUUID()),
      projectId: project.id,
      baseRevision,
      operation: raw.operation,
      target: raw.target && typeof raw.target === 'object' ? raw.target : {},
      payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
    }));
  }

  async applyCommands(projectId, input = {}, ownerId = '') {
    return this.withProjectLock(projectId, async () => {
      const { metadata, index } = await this.getMetadata(projectId, ownerId);
      if (!metadata) return null;
      const project = await this.readProjectFile(this.currentPath(projectId));
      const baseRevision = Number(input.baseRevision);
      if (!Number.isInteger(baseRevision)) throw Object.assign(new Error('baseRevision is required'), { statusCode: 400, code: 'BASE_REVISION_REQUIRED' });
      const commands = this.normalizeCommands(project, input.commands, baseRevision);
      let applied;
      try {
        applied = applyCommandBatch(project, commands, baseRevision);
      } catch (error) {
        if (error.code === 'REVISION_CONFLICT') error.statusCode = 409;
        else error.statusCode ||= 400;
        throw error;
      }
      await this.persistSnapshot(applied.project, { ownerId, source: input.source || 'editor', commands, inverses: applied.inverses, metadata });
      Object.assign(metadata, { revision: applied.project.revision, updatedAt: now() });
      const aiRunId = String(input.source || '').startsWith('ai-run:') ? String(input.source).slice('ai-run:'.length) : '';
      if (aiRunId) {
        const aiRun = index.aiRuns.find((run) => run.id === aiRunId && run.projectId === projectId && run.ownerId === ownerId);
        if (aiRun) Object.assign(aiRun, { status: 'applied', appliedRevision: applied.project.revision, appliedAt: now() });
      }
      await this.writeIndex(index);
      await this.emit(projectId, 'commands.applied', { baseRevision, revision: applied.project.revision, commandIds: commands.map((command) => command.commandId), source: input.source || 'editor' });
      return { ...this.describeProject(metadata, applied.project, index), commandBatch: { schema: 'LillyCommandBatch/v1', baseRevision, revision: applied.project.revision, commands, inverses: applied.inverses } };
    });
  }

  async listSourceFiles(projectId, ownerId = '') {
    const result = await this.getProject(projectId, ownerId);
    if (!result) return null;
    return {
      schema: 'LillySourceTree/v1',
      projectId,
      revision: result.project.revision,
      files: result.project.files.map((file) => ({
        schema: file.schema,
        path: file.path,
        kind: file.kind,
        language: file.language,
        enabled: file.enabled,
        sizeBytes: Buffer.byteLength(file.content, 'utf8'),
      })),
      moduleSummary: result.moduleSummary,
      diagnostics: result.validation.moduleIssues,
    };
  }

  async readSourceFile(projectId, filePath, ownerId = '') {
    const result = await this.getProject(projectId, ownerId);
    if (!result) return null;
    const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const file = result.project.files.find((entry) => entry.path === normalized);
    if (!file) throw Object.assign(new Error(`Source file ${normalized} was not found`), { statusCode: 404, code: 'SOURCE_FILE_NOT_FOUND' });
    return { schema: 'LillySourceFileRead/v1', projectId, revision: result.project.revision, file };
  }

  async writeSourceFiles(projectId, input = {}, ownerId = '') {
    const files = Array.isArray(input.files) ? input.files : [];
    if (files.length === 0) throw Object.assign(new Error('write-files requires at least one source file'), { statusCode: 400, code: 'SOURCE_FILES_REQUIRED' });
    if (files.length > 100) throw Object.assign(new Error('A source mutation batch is limited to 100 files'), { statusCode: 400, code: 'SOURCE_FILE_BATCH_LIMIT' });
    return this.applyCommands(projectId, {
      baseRevision: input.baseRevision,
      source: input.source || 'game-studio-file-api',
      commands: files.map((file) => ({ operation: 'file.upsert', target: { path: file.path }, payload: { file } })),
    }, ownerId);
  }

  async deleteSourceFiles(projectId, input = {}, ownerId = '') {
    const paths = Array.isArray(input.paths) ? input.paths : (input.path ? [input.path] : []);
    if (paths.length === 0) throw Object.assign(new Error('delete-files requires at least one source path'), { statusCode: 400, code: 'SOURCE_PATHS_REQUIRED' });
    return this.applyCommands(projectId, {
      baseRevision: input.baseRevision,
      source: input.source || 'game-studio-file-api',
      commands: paths.map((filePath) => ({ operation: 'file.delete', target: { path: filePath }, payload: {} })),
    }, ownerId);
  }

  async compileProjectModules(projectId, input = {}, ownerId = '') {
    const result = await this.getProject(projectId, ownerId);
    if (!result) return null;
    if (input.revision != null && Number(input.revision) !== result.project.revision) {
      throw Object.assign(new Error('Compile revision no longer matches the saved project revision'), { statusCode: 409, code: 'COMPILE_REVISION_CONFLICT', currentRevision: result.project.revision });
    }
    const bundle = compileModuleBundle(result.project.files || []);
    return {
      schema: bundle.schema,
      projectId,
      projectRevision: result.project.revision,
      sourceHash: bundle.sourceHash,
      valid: !bundle.diagnostics.some((entry) => entry.severity === 'error'),
      loadOrder: bundle.loadOrder,
      modules: bundle.modules.map((module) => ({ id: module.id, name: module.name, version: module.version, sourcePath: module.sourcePath, capabilities: module.capabilities, dependencies: module.dependencies })),
      systems: bundle.systems.map((system) => ({ moduleId: system.moduleId, path: system.path, sourceHash: system.sourceHash })),
      mechanics: bundle.mechanics.map((mechanic) => ({ id: mechanic.id, moduleId: mechanic.moduleId, name: mechanic.name, sourcePath: mechanic.sourcePath, inputs: mechanic.inputs, events: mechanic.events })),
      prefabs: bundle.prefabs.map((prefab) => ({ id: prefab.id, moduleId: prefab.moduleId, name: prefab.name, sourcePath: prefab.sourcePath, entityCount: prefab.entities.length })),
      tests: bundle.tests.map((test) => ({ id: test.id, moduleId: test.moduleId, name: test.name, sourcePath: test.sourcePath, assertionCount: test.assertions.length })),
      diagnostics: bundle.diagnostics,
    };
  }

  async runMechanicTestSuite(projectId, input = {}, ownerId = '') {
    const result = await this.getProject(projectId, ownerId);
    if (!result) return null;
    if (input.revision != null && Number(input.revision) !== result.project.revision) {
      throw Object.assign(new Error('Mechanic test revision no longer matches the saved project revision'), { statusCode: 409, code: 'MECHANIC_TEST_REVISION_CONFLICT', currentRevision: result.project.revision });
    }
    const bundle = compileModuleBundle(result.project.files || []);
    try { assertModuleBundleValid(bundle); }
    catch (error) { error.statusCode = 422; throw error; }
    const run = runMechanicTests(bundle, { testIds: input.testIds, executionBudgetMs: input.executionBudgetMs });
    const report = { ...run, projectId, projectRevision: result.project.revision, createdAt: now() };
    await this.writeJsonAtomic(path.join(this.projectDirectory(projectId), 'mechanic-tests', `${randomUUID()}.json`), report);
    await this.emit(projectId, 'mechanic-tests.completed', { status: report.status, passed: report.passed, failed: report.failed, sourceHash: report.sourceHash });
    return report;
  }

  async instantiatePrefab(projectId, input = {}, ownerId = '') {
    return this.applyCommands(projectId, {
      baseRevision: input.baseRevision,
      source: input.source || 'game-studio-prefab-api',
      commands: [{
        operation: 'prefab.instantiate',
        target: { sceneId: input.sceneId, path: input.path, prefabId: input.prefabId, instanceId: input.instanceId },
        payload: { path: input.path, instanceId: input.instanceId, parentId: input.parentId || null, config: input.config || {} },
      }],
    }, ownerId);
  }

  async rollback(projectId, input = {}, ownerId = '') {
    return this.withProjectLock(projectId, async () => {
      const { metadata, index } = await this.getMetadata(projectId, ownerId);
      if (!metadata) return null;
      const current = await this.readProjectFile(this.currentPath(projectId));
      const targetRevision = Number(input.revision);
      if (!Number.isInteger(targetRevision) || targetRevision < 1 || targetRevision >= current.revision) throw Object.assign(new Error('rollback revision must be an earlier saved revision'), { statusCode: 400, code: 'INVALID_ROLLBACK_REVISION' });
      const target = await this.readProjectFile(this.revisionPath(projectId, targetRevision));
      target.revision = current.revision + 1;
      await this.persistSnapshot(target, { ownerId, source: 'rollback', metadata: { ...metadata, rollbackFrom: current.revision, rollbackTarget: targetRevision } });
      Object.assign(metadata, { revision: target.revision, updatedAt: now() });
      await this.writeIndex(index);
      await this.emit(projectId, 'project.rolled-back', { fromRevision: current.revision, targetRevision, revision: target.revision });
      return this.describeProject(metadata, target, index);
    });
  }

  async saveAsset(projectId, input = {}, ownerId = '') {
    return this.withProjectLock(projectId, async () => {
      const { metadata, index } = await this.getMetadata(projectId, ownerId);
      if (!metadata) return null;
      const mimeType = String(input.mimeType || 'application/octet-stream').toLowerCase();
      if (!ALLOWED_ASSET_TYPES.has(mimeType)) throw Object.assign(new Error(`Asset type ${mimeType} is not allowed`), { statusCode: 415, code: 'ASSET_TYPE_NOT_ALLOWED' });
      let buffer;
      try { buffer = Buffer.from(String(input.contentBase64 || ''), 'base64'); } catch (_error) { buffer = Buffer.alloc(0); }
      if (buffer.length === 0 || buffer.length > MAX_ASSET_BYTES) throw Object.assign(new Error(`Assets must be between 1 byte and ${MAX_ASSET_BYTES} bytes`), { statusCode: 413, code: 'ASSET_SIZE_INVALID' });
      const id = randomUUID();
      const filename = `${id}-${safeFileName(input.filename)}`;
      const directory = path.join(this.projectDirectory(projectId), 'assets');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, filename), buffer, { flag: 'wx' });
      const asset = { id, name: String(input.name || input.filename || 'Asset').slice(0, 100), type: mimeType, uri: `assets/${filename}`, metadata: { sizeBytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') } };
      const project = await this.readProjectFile(this.currentPath(projectId));
      project.assets.push(asset);
      project.revision += 1;
      await this.persistSnapshot(project, { ownerId, source: 'asset-upload', metadata });
      Object.assign(metadata, { revision: project.revision, updatedAt: now() });
      await this.writeIndex(index);
      await this.emit(projectId, 'asset.created', { asset, revision: project.revision });
      return { asset, project };
    });
  }

  async runPlaytest(projectId, input = {}, ownerId = '') {
    const result = await this.getProject(projectId, ownerId);
    if (!result) return null;
    const project = result.project;
    const tests = [];
    const fixedSteps = Math.max(1, Math.min(Number(input.fixedSteps) || 120, 3600));
    const projectIssues = validateProject(project).filter((issue) => issue.severity === 'error');
    tests.push({ name: 'Project schema and components', status: projectIssues.length ? 'failed' : 'passed', details: projectIssues.map((issue) => issue.message).join('; ') });
    const blueprintIssues = project.blueprints.flatMap((graph) => validateBlueprint(graph).filter((issue) => issue.severity === 'error'));
    tests.push({ name: 'Blueprint validation', status: blueprintIssues.length ? 'failed' : 'passed', details: blueprintIssues.map((issue) => issue.message).join('; ') });
    const compiledGraphs = [];
    if (!blueprintIssues.length) project.blueprints.forEach((graph) => compiledGraphs.push(compileBlueprint(graph)));
    tests.push({ name: 'Blueprint compilation', status: compiledGraphs.length === project.blueprints.length ? 'passed' : 'failed', details: `${compiledGraphs.length}/${project.blueprints.length} graphs compiled` });
    const compiledModules = compileModuleBundle(project.files || []);
    const moduleErrors = compiledModules.diagnostics.filter((issue) => issue.severity === 'error');
    tests.push({
      name: 'Agent module compilation and capability policy',
      status: moduleErrors.length ? 'failed' : 'passed',
      details: moduleErrors.length
        ? moduleErrors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
        : `${compiledModules.modules.length} modules, ${compiledModules.systems.length} typed systems, ${compiledModules.mechanics.length} mechanics, ${compiledModules.prefabs.length} prefabs`,
    });
    let mechanicTestRun = { schema: 'LillyMechanicTestRun/v1', sourceHash: compiledModules.sourceHash, status: 'passed', tests: [], passed: 0, failed: 0 };
    if (!moduleErrors.length) mechanicTestRun = runMechanicTests(compiledModules, { executionBudgetMs: input.executionBudgetMs });
    tests.push({
      name: 'Agent-authored mechanic specifications',
      status: mechanicTestRun.status,
      details: compiledModules.tests.length
        ? `${mechanicTestRun.passed}/${compiledModules.tests.length} deterministic mechanic tests passed`
        : 'No mechanic specifications authored; module runtime remains optional',
    });
    const scene = getScene(project);
    const levelIssues = [];
    const deterministicFailures = [];
    for (const recipe of project.levelRecipes || []) {
      levelIssues.push(...validateLevelRecipe(recipe));
      const design = (project.generatedLevels || []).find((entry) => entry.recipeId === recipe.id && entry.sceneId === recipe.sceneId);
      if (!design) {
        levelIssues.push({ code: 'GENERATED_LEVEL_MISSING', message: `Recipe ${recipe.id} has no generated topology`, severity: 'error' });
        continue;
      }
      levelIssues.push(...validateGeneratedLevel(design, recipe));
      const firstReplay = generateLevel(recipe, { parentId: 'world' });
      const secondReplay = generateLevel(recipe, { parentId: 'world' });
      if (firstReplay.design.checksum !== design.checksum || JSON.stringify(firstReplay.entities) !== JSON.stringify(secondReplay.entities)) {
        deterministicFailures.push(recipe.id);
      }
    }
    const levelErrors = levelIssues.filter((issue) => issue.severity === 'error');
    tests.push({
      name: 'Procedural level topology',
      status: levelErrors.length ? 'failed' : 'passed',
      details: project.levelRecipes?.length
        ? (levelErrors.length ? levelErrors.map((issue) => issue.message).join('; ') : `${project.generatedLevels.length} seeded level connects spawn to goal`)
        : 'Hand-authored scene; procedural topology is optional',
    });
    tests.push({
      name: 'Deterministic level replay',
      status: deterministicFailures.length ? 'failed' : 'passed',
      details: deterministicFailures.length ? `Checksum mismatch: ${deterministicFailures.join(', ')}` : `${project.levelRecipes?.length || 0} level recipes replay identically`,
    });
    const player = scene.entities.find((entity) => entity.tags.includes('player'));
    const camera = scene.entities.find((entity) => entity.components.some((component) => component.type === 'Camera' && component.data.primary === true));
    tests.push({ name: 'Automated control contract', status: player && camera ? 'passed' : 'failed', details: player && camera ? 'Player and primary camera are available to the control harness' : 'A player and primary camera are required' });
    const moveBinding = project.inputMap.find((binding) => binding.action === 'Move' && binding.kind === 'axis2d');
    const attackBinding = project.inputMap.find((binding) => binding.action === 'Attack' && binding.kind === 'button');
    const encounterCount = (project.generatedLevels || []).reduce((total, design) => total + (design.encounters?.length || 0), 0);
    tests.push({
      name: 'Combat encounter grammar',
      status: encounterCount === 0 || attackBinding ? 'passed' : 'failed',
      details: encounterCount === 0
        ? 'Combat encounters are optional for this project'
        : attackBinding
          ? `${encounterCount} room encounter${encounterCount === 1 ? '' : 's'} own enemies, gates, checkpoints, and an Attack action`
          : 'Combat levels require an action-mapped Attack button',
    });
    if (encounterCount > 0) {
      const runCombatScript = () => {
        const simulation = new GameplaySimulation(project);
        const design = project.generatedLevels.find((entry) => entry.sceneId === project.entryScene && entry.encounters?.length);
        const encounter = design?.encounters?.[0];
        const room = encounter ? design.rooms.find((entry) => entry.id === encounter.roomId) : null;
        if (!encounter || !room) return { passed: false, reason: 'Encounter room is missing' };
        simulation.step(1 / 60, { playerPosition: room.position });
        let state = simulation.getState();
        const started = state.activeEncounterId === encounter.id && encounter.gateIds.every((id) => state.gates[id] === true);
        for (let step = 0; step < fixedSteps && !state.encounters.find((entry) => entry.id === encounter.id)?.cleared; step += 1) {
          const enemy = state.enemies.find((entry) => entry.encounterId === encounter.id && entry.health > 0);
          if (!enemy) break;
          const position = step % 5 === 0
            ? { x: enemy.position.x + Math.max(0.2, state.player.attackRange - 0.08), y: room.position.y, z: enemy.position.z }
            : { x: room.position.x + 500, y: room.position.y, z: room.position.z + 500 };
          state = simulation.step(0.1, { playerPosition: position, attackPressed: step % 5 === 0 });
        }
        const cleared = state.encounters.find((entry) => entry.id === encounter.id)?.cleared === true;
        const checkpoint = state.checkpoint.id === encounter.checkpointId;
        const gatesOpen = encounter.gateIds.every((id) => state.gates[id] === false);
        const save = simulation.serialize();
        const restored = new GameplaySimulation(project);
        const saveRestored = restored.restore(save) && JSON.stringify(restored.serialize()) === JSON.stringify(save);
        return { passed: started && cleared && checkpoint && gatesOpen && saveRestored, started, cleared, checkpoint, gatesOpen, saveRestored, state };
      };
      const firstCombat = runCombatScript();
      const secondCombat = runCombatScript();
      const deterministicCombat = firstCombat.passed && secondCombat.passed && JSON.stringify(firstCombat.state) === JSON.stringify(secondCombat.state);
      tests.push({
        name: 'Deterministic combat, gates, checkpoint, and save replay',
        status: deterministicCombat ? 'passed' : 'failed',
        details: deterministicCombat
          ? `Cleared the first encounter and restored its stable-ID save in ${fixedSteps} or fewer fixed steps`
          : `Combat replay failed: ${JSON.stringify({ first: firstCombat, second: secondCombat }).slice(0, 1200)}`,
      });
    } else {
      tests.push({ name: 'Deterministic combat, gates, checkpoint, and save replay', status: 'passed', details: 'No combat encounter requested; shared simulation initialized without gameplay actors' });
    }
    const mobileAuthoring = project.settings.mobileMode === 'author-play' || !(project.levelRecipes || []).length;
    tests.push({
      name: 'Phone creation and touch input contract',
      status: moveBinding && mobileAuthoring && (encounterCount === 0 || attackBinding) ? 'passed' : 'failed',
      details: moveBinding && mobileAuthoring && (encounterCount === 0 || attackBinding) ? 'Mobile authoring mode and action-mapped movement/attack are enabled' : 'author-play mode, a Move axis, and combat Attack action are required',
    });
    const missingAssets = [];
    for (const asset of project.assets) {
      if (String(asset.uri || '').startsWith('assets/') && !await pathExists(path.join(this.projectDirectory(projectId), asset.uri))) missingAssets.push(asset.name);
    }
    tests.push({ name: 'Asset references', status: missingAssets.length ? 'failed' : 'passed', details: missingAssets.length ? `Missing: ${missingAssets.join(', ')}` : `${project.assets.length} asset references resolved` });
    const playtest = {
      schema: 'LillyPlaytest/v1',
      id: randomUUID(),
      projectId,
      projectRevision: project.revision,
      status: tests.every((test) => test.status === 'passed') ? 'passed' : 'failed',
      tests,
      compiledGraphs,
      compiledModules,
      mechanicTestRun,
      fixedSteps,
      createdAt: now(),
    };
    await this.writeJsonAtomic(path.join(this.projectDirectory(projectId), 'playtests', `${playtest.id}.json`), playtest);
    await this.emit(projectId, 'playtest.completed', { id: playtest.id, status: playtest.status, tests });
    return playtest;
  }

  async createBuild(projectId, input = {}, ownerId = '') {
    return this.withProjectLock(projectId, async () => {
      const { metadata, index } = await this.getMetadata(projectId, ownerId);
      if (!metadata) return null;
      const project = await this.readProjectFile(this.currentPath(projectId));
      if (input.projectRevision != null && Number(input.projectRevision) !== project.revision) throw Object.assign(new Error('Build revision no longer matches the saved project revision'), { statusCode: 409, code: 'BUILD_REVISION_CONFLICT' });
      const playtest = await this.runPlaytest(projectId, input, ownerId);
      if (playtest.status !== 'passed') throw Object.assign(new Error('Build blocked by failed project or Blueprint validation'), { statusCode: 422, code: 'PLAYTEST_FAILED', tests: playtest.tests });
      const id = randomUUID();
      const workspaceId = `game-studio-${slugify(project.slug)}-r${project.revision}-${id.slice(0, 8)}`;
      const directory = path.join(this.buildRoot, workspaceId);
      const files = await writeImmutableBuild({
        directory,
        project,
        graphIr: playtest.compiledGraphs,
        moduleBundle: playtest.compiledModules,
        projectDirectory: this.projectDirectory(projectId),
      });
      const build = {
        schema: BUILD_SCHEMA,
        id,
        projectId,
        ownerId,
        projectRevision: project.revision,
        engineVersion: project.engineVersion,
        status: 'success',
        tests: playtest.tests,
        files,
        workspaceId,
        previewUrl: `/api/sandbox-workspaces/${encodeURIComponent(workspaceId)}/sandbox`,
        createdAt: now(),
        publishedAt: null,
        publicUrl: '',
        managedApp: null,
      };
      index.builds.unshift(build);
      await this.writeIndex(index);
      await this.writeJsonAtomic(path.join(this.projectDirectory(projectId), 'builds', `${id}.json`), build);
      if (this.postgres?.enabled) {
        try {
          await this.postgres.query(`INSERT INTO game_studio_builds (id, project_id, owner_id, project_revision, status, tests, files, preview_url, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb)`, [id, projectId, ownerId, project.revision, build.status, JSON.stringify(build.tests), JSON.stringify(build.files), build.previewUrl, JSON.stringify({ workspaceId })]);
        } catch (error) { console.warn(`[GameStudio] PostgreSQL build mirror failed: ${error.message}`); }
      }
      await this.emit(projectId, 'build.completed', { id, status: build.status, revision: project.revision, previewUrl: build.previewUrl });
      return build;
    });
  }

  async createEditorPreview(projectId, input = {}, ownerId = '') {
    return this.withProjectLock(projectId, async () => {
      const result = await this.getProject(projectId, ownerId);
      if (!result) return null;
      const { project } = result;
      if (input.projectRevision != null && Number(input.projectRevision) !== project.revision) {
        throw Object.assign(new Error('Editor preview revision no longer matches the saved project revision'), { statusCode: 409, code: 'EDITOR_PREVIEW_REVISION_CONFLICT', currentRevision: project.revision });
      }
      const playtest = await this.runPlaytest(projectId, input, ownerId);
      if (playtest.status !== 'passed') {
        throw Object.assign(new Error('Editor Play is blocked by failed project, module, Blueprint, or mechanic validation'), { statusCode: 422, code: 'EDITOR_PREVIEW_PLAYTEST_FAILED', tests: playtest.tests });
      }
      const sourceHash = playtest.compiledModules?.sourceHash || '00000000';
      const workspaceId = `game-studio-editor-${project.id}-r${project.revision}-${sourceHash}-${PLAYER_RUNTIME_HASH}`;
      const directory = path.join(this.buildRoot, workspaceId);
      const manifestPath = path.join(directory, 'build-manifest.json');
      let cached = false;
      if (await pathExists(manifestPath)) {
        try {
          const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
          cached = manifest?.schema === 'LillyPlayerBundle/v2'
            && manifest.projectId === project.id
            && Number(manifest.revision) === project.revision
            && String(manifest.moduleSourceHash || '00000000') === sourceHash
            && manifest.playerRuntimeHash === PLAYER_RUNTIME_HASH;
        } catch (_error) {
          cached = false;
        }
      }
      if (!cached) {
        if (await pathExists(directory)) {
          const relative = path.relative(this.buildRoot, directory);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('Editor preview workspace escaped the build root'), { code: 'EDITOR_PREVIEW_PATH_INVALID' });
          await fs.rm(directory, { recursive: true, force: true });
        }
        await writeImmutableBuild({
          directory,
          project,
          graphIr: playtest.compiledGraphs,
          moduleBundle: playtest.compiledModules,
          projectDirectory: this.projectDirectory(projectId),
        });
      }
      const preview = {
        schema: 'LillyEditorPreview/v1',
        projectId,
        projectRevision: project.revision,
        moduleSourceHash: sourceHash,
        playerRuntimeHash: PLAYER_RUNTIME_HASH,
        workspaceId,
        previewUrl: `/api/sandbox-workspaces/${encodeURIComponent(workspaceId)}/preview/`,
        sandboxUrl: `/api/sandbox-workspaces/${encodeURIComponent(workspaceId)}/sandbox`,
        cached,
        tests: playtest.tests,
        createdAt: now(),
      };
      await this.emit(projectId, 'editor-preview.ready', { revision: project.revision, sourceHash, workspaceId, cached });
      return preview;
    });
  }

  async getBuild(buildId, ownerId) {
    const index = await this.readIndex();
    return { build: index.builds.find((entry) => entry.id === buildId && entry.ownerId === ownerId) || null, index };
  }

  async publishBuild(buildId, input = {}, ownerId = '', managedAppService = null) {
    const { build, index } = await this.getBuild(buildId, ownerId);
    if (!build) return null;
    if (build.status !== 'success' && build.status !== 'published') throw Object.assign(new Error('Only successful immutable builds can be published'), { statusCode: 409, code: 'BUILD_NOT_PUBLISHABLE' });
    const projectResult = await this.getProject(build.projectId, ownerId);
    if (!projectResult || projectResult.project.revision !== build.projectRevision) {
      throw Object.assign(new Error('Publishing requires the tested build revision; create a new build after later edits'), { statusCode: 409, code: 'PUBLISH_REVISION_MISMATCH' });
    }
    const deployer = managedAppService || this.managedAppService;
    if (!deployer?.isAvailable?.()) throw Object.assign(new Error('Publishing requires the configured PostgreSQL and managed-app/GitLab deployment lane'), { statusCode: 503, code: 'PUBLISH_LANE_UNAVAILABLE', previewUrl: build.previewUrl });
    const files = await Promise.all(build.files.map(async (file) => ({
      path: `public/${String(file.path).replace(/^public\//, '')}`,
      content: await fs.readFile(path.join(this.buildRoot, build.workspaceId, file.path), 'utf8'),
    })));
    const publicHost = String(input.publicHost || `${projectResult.project.slug}.demoserver2.buzz`).trim().toLowerCase();
    if (!/^[a-z0-9-]+\.demoserver2\.buzz$/.test(publicHost)) throw Object.assign(new Error('Game Studio publishes to a concrete *.demoserver2.buzz host'), { statusCode: 400, code: 'INVALID_PUBLIC_HOST' });
    const managedResult = await deployer.createApp({
      appName: projectResult.project.name,
      slug: projectResult.project.slug,
      publicHost,
      prompt: `Publish immutable Lilly Game Studio build ${build.id} from project revision ${build.projectRevision}.`,
      sourcePrompt: `Lilly Game Studio project ${projectResult.project.name}`,
      files,
      requestedAction: 'publish',
      deployRequested: true,
      metadata: {
        lillyGameStudio: { schema: 'LillyGameStudioPublish/v1', projectId: build.projectId, projectRevision: build.projectRevision, buildId: build.id, previewUrl: build.previewUrl },
      },
    }, ownerId, { sessionId: input.sessionId || null, model: input.model || '' });
    build.status = 'published';
    build.publicUrl = `https://${publicHost}`;
    build.publishedAt = now();
    build.managedApp = { appId: managedResult.app?.id || null, buildRunId: managedResult.buildRun?.id || null, status: managedResult.app?.status || 'building' };
    await this.writeIndex(index);
    await this.writeJsonAtomic(path.join(this.projectDirectory(build.projectId), 'builds', `${build.id}.json`), build);
    await this.emit(build.projectId, 'publish.queued', { buildId, publicUrl: build.publicUrl, managedApp: build.managedApp, previewUrl: build.previewUrl });
    return { build, managedApp: managedResult, previewPreservedUntilHttpsVerified: true };
  }

  deterministicProposal(project, prompt = '', input = {}) {
    const normalized = String(prompt || '').toLowerCase();
    const scene = getScene(project);
    if (input.mode === 'level') {
      const previous = project.levelRecipes.find((recipe) => recipe.sceneId === scene.id) || null;
      const recipe = createLevelRecipeFromPrompt({
        projectId: project.id,
        sceneId: scene.id,
        prompt,
        seed: input.seed,
        previous,
      });
      if (Number.isInteger(Number(input.difficulty))) recipe.gameplay.difficulty = Math.max(1, Math.min(5, Number(input.difficulty)));
      return [{ operation: 'level.generate', target: { sceneId: scene.id }, payload: { recipe } }];
    }
    const commands = [];
    if (/light|brighter|rim|glow/.test(normalized)) {
      const lightId = `ai-light-${randomUUID().slice(0, 6)}`;
      commands.push({ operation: 'entity.create', target: { sceneId: scene.id }, payload: { entity: { schema: 'LillyEntity/v1', id: lightId, name: 'AI Rim Light', parentId: 'world', enabled: true, tags: ['lighting', 'ai-created'], components: [
        { type: 'Transform', enabled: true, data: { position: { x: -5, y: 5, z: -3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
        { type: 'Light', enabled: true, data: { kind: 'point', color: '#a78bfa', intensity: 18, range: 18, castShadow: true } },
      ] } } });
    }
    if (/pickup|shard|collectible|color/.test(normalized)) {
      scene.entities.filter((entity) => entity.tags.includes('pickup')).forEach((entity, index) => {
        const mesh = entity.components.find((component) => component.type === 'MeshRenderer');
        if (mesh) commands.push({ operation: 'component.set', target: { sceneId: scene.id, entityId: entity.id, componentType: 'MeshRenderer' }, payload: { data: { ...mesh.data, material: { ...(mesh.data.material || {}), color: index % 2 ? '#fbbf24' : '#c084fc', emissive: '#6d28d9', emissiveIntensity: 0.55 } } } });
      });
    }
    if (commands.length === 0) {
      commands.push({ operation: 'scene.set-environment', target: { sceneId: scene.id }, payload: { background: '#07131d', ambientIntensity: 0.7 } });
    }
    return commands;
  }

  async createAiRun(projectId, input = {}, ownerId = '') {
    const { metadata, index } = await this.getMetadata(projectId, ownerId);
    if (!metadata) return null;
    const project = await this.readProjectFile(this.currentPath(projectId));
    const baseRevision = Number.isInteger(Number(input.baseRevision)) ? Number(input.baseRevision) : project.revision;
    if (baseRevision !== project.revision) throw Object.assign(new Error('AI proposal is based on a stale project revision'), { statusCode: 409, code: 'REVISION_CONFLICT', currentRevision: project.revision });
    const mode = input.mode === 'level' ? 'level' : 'edit';
    const scene = getScene(project);
    const previousRecipe = project.levelRecipes.find((recipe) => recipe.sceneId === scene.id) || null;
    const fallbackRecipe = mode === 'level' ? createLevelRecipeFromPrompt({
      projectId: project.id,
      sceneId: scene.id,
      prompt: String(input.prompt || ''),
      seed: input.seed,
      previous: previousRecipe,
    }) : null;
    let proposed = Array.isArray(input.commands) ? input.commands : null;
    if (!proposed && this.complete && String(input.prompt || '').trim()) {
      try {
        const prompt = mode === 'level'
          ? `You are Lilly's game director. Return JSON only as {"recipe": LillyLevelRecipe/v1}. Keep the stable id ${JSON.stringify(previousRecipe?.id || 'main-level')} and sceneId ${JSON.stringify(scene.id)}. Choose a theme from neon-ruins, verdant-temple, ember-foundry, frost-vault; objective from collect-and-exit, reach-exit, or secure-and-exit; roomCount 3-16; roomSize 6-14; roomSpacing at least roomSize+2 and at most 26; pathWidth 2.4 through roomSize-2; verticality 0-1; difficulty 1-5; pickupCount 1-20; hazardCount 0-30; encounterCount 0-4; enemyCount 0-4. Combat encounters must fit non-spawn/non-goal rooms, enemyCount must be at least encounterCount, and zero encounters require zero enemies. Use this deterministic fallback as a structurally valid starting point: ${JSON.stringify(fallbackRecipe)}. Player request: ${String(input.prompt).slice(0, 2000)}`
          : `Return JSON only with a commands array. Every mutation must be a LillyCommand/v1 operation using one of scene.create, scene.delete, scene.rename, entity.create, entity.delete, entity.rename, entity.reparent, entity.set-enabled, entity.set-locked, component.set, component.remove, scene.set-environment, blueprint.replace, blueprint.delete, file.upsert, file.delete, prefab.instantiate, input.replace, project.set-entry-scene, project.set-settings, level.generate. For original mechanics, prefer small versioned .module.json, .mechanic.json, .system.ts, .prefab.json, and .spec.json files through file.upsert rather than hiding behavior in scene data. Project summary: ${JSON.stringify({ id: project.id, revision: project.revision, entryScene: project.entryScene, sceneIds: project.scenes.map((entry) => entry.id), entityCount: scene.entities.length, sourcePaths: project.files.map((file) => file.path), blueprintIds: project.blueprints.map((graph) => graph.id), levelRecipes: project.levelRecipes })}. Request: ${String(input.prompt).slice(0, 2000)}`;
        const response = await this.complete(prompt);
        const parsed = parseLenientJson(String(response || ''));
        if (mode === 'level' && parsed?.recipe) {
          const candidateRecipe = {
            ...parsed.recipe,
            id: previousRecipe?.id || fallbackRecipe.id,
            sceneId: scene.id,
            gameplay: {
              ...parsed.recipe?.gameplay,
              encounterCount: parsed.recipe?.gameplay?.encounterCount ?? fallbackRecipe.gameplay.encounterCount,
              enemyCount: parsed.recipe?.gameplay?.enemyCount ?? fallbackRecipe.gameplay.enemyCount,
            },
          };
          proposed = validateLevelRecipe(candidateRecipe).some((issue) => issue.severity === 'error')
            ? null
            : [{ operation: 'level.generate', target: { sceneId: scene.id }, payload: { recipe: candidateRecipe } }];
        } else {
          proposed = parsed?.commands || (Array.isArray(parsed) ? parsed : null);
        }
        if (mode === 'level' && !proposed?.some((command) => command?.operation === 'level.generate')) proposed = null;
      } catch (error) {
        console.warn(`[GameStudio] AI proposal fallback: ${error.message}`);
      }
    }
    proposed ||= this.deterministicProposal(project, input.prompt, { mode, seed: input.seed, difficulty: input.difficulty });
    const commands = this.normalizeCommands(project, proposed, baseRevision);
    if (commands.some((command) => command.operation === 'level.restore')) {
      throw Object.assign(new Error('AI proposals cannot restore opaque level snapshots'), { statusCode: 422, code: 'AI_OPERATION_DENIED' });
    }
    let preview;
    try { preview = applyCommandBatch(project, commands, baseRevision); }
    catch (error) { error.statusCode ||= 422; throw error; }
    const affected = commands.map((command) => ({ operation: command.operation, sceneId: command.target.sceneId || null, entityId: command.target.entityId || command.payload.entity?.id || null, graphId: command.target.graphId || null, recipeId: command.payload.recipe?.id || null, path: command.target.path || command.payload.file?.path || null }));
    const previewLevel = preview.project.generatedLevels.find((design) => design.sceneId === scene.id) || null;
    const previewRecipe = previewLevel ? preview.project.levelRecipes.find((recipe) => recipe.id === previewLevel.recipeId) || null : null;
    const run = {
      schema: AI_RUN_SCHEMA,
      id: randomUUID(),
      projectId,
      ownerId,
      baseRevision,
      prompt: String(input.prompt || ''),
      mode,
      status: 'proposed',
      commands,
      affected,
      preview: {
        revision: preview.project.revision,
        validation: { projectIssues: validateProject(preview.project), blueprintIssues: preview.project.blueprints.flatMap(validateBlueprint) },
        level: previewLevel && previewRecipe ? {
          recipeId: previewRecipe.id,
          name: previewRecipe.name,
          theme: previewRecipe.theme,
          seed: previewRecipe.seed,
          objective: previewRecipe.objective,
          difficulty: previewRecipe.gameplay.difficulty,
          checksum: previewLevel.checksum,
          metrics: previewLevel.metrics,
        } : null,
      },
      createdAt: now(),
    };
    index.aiRuns.unshift(run);
    await this.writeIndex(index);
    if (this.postgres?.enabled) {
      try { await this.postgres.query('INSERT INTO game_studio_ai_runs (id, project_id, owner_id, base_revision, prompt, status, commands, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)', [run.id, projectId, ownerId, baseRevision, run.prompt, run.status, JSON.stringify(commands), JSON.stringify({ affected })]); }
      catch (error) { console.warn(`[GameStudio] PostgreSQL AI run mirror failed: ${error.message}`); }
    }
    await this.emit(projectId, 'ai-run.proposed', { id: run.id, baseRevision, affected });
    return run;
  }

  async inspectScene(projectId, sceneId, ownerId) {
    const result = await this.getProject(projectId, ownerId);
    if (!result) return null;
    const scene = getScene(result.project, sceneId || result.project.entryScene);
    return { projectId, revision: result.project.revision, scene, validation: result.validation };
  }

  async executeToolAction(action, params = {}, context = {}) {
    const ownerId = String(context.userId || context.ownerId || '').trim();
    switch (action) {
      case 'create-project': return this.createProject(params, ownerId);
      case 'list-projects': return { projects: await this.listProjects(ownerId) };
      case 'inspect-project': return this.getProject(params.projectId, ownerId);
      case 'inspect-scene': return this.inspectScene(params.projectId, params.sceneId, ownerId);
      case 'list-files': return this.listSourceFiles(params.projectId, ownerId);
      case 'read-file': return this.readSourceFile(params.projectId, params.path, ownerId);
      case 'write-files': return this.writeSourceFiles(params.projectId, { ...params, source: 'game-studio-tool' }, ownerId);
      case 'delete-files': return this.deleteSourceFiles(params.projectId, { ...params, source: 'game-studio-tool' }, ownerId);
      case 'compile-project': return this.compileProjectModules(params.projectId, params, ownerId);
      case 'run-mechanic-tests': return this.runMechanicTestSuite(params.projectId, params, ownerId);
      case 'instantiate-prefab': return this.instantiatePrefab(params.projectId, { ...params, source: 'game-studio-tool' }, ownerId);
      case 'generate-level': return this.createAiRun(params.projectId, { ...params, mode: 'level' }, ownerId);
      case 'apply-commands': return this.applyCommands(params.projectId, params, ownerId);
      case 'edit-blueprint': {
        const result = await this.getProject(params.projectId, ownerId);
        if (!result) return null;
        const graph = params.graph;
        if (!graph || graph.schema !== BLUEPRINT_SCHEMA) throw Object.assign(new Error('edit-blueprint requires LillyBlueprint/v1 graph'), { statusCode: 400 });
        return this.applyCommands(params.projectId, { baseRevision: params.baseRevision, source: 'game-studio-tool', commands: [{ operation: 'blueprint.replace', target: { graphId: graph.id }, payload: { graph } }] }, ownerId);
      }
      case 'run-playtest': return this.runPlaytest(params.projectId, params, ownerId);
      case 'build': return this.createBuild(params.projectId, params, ownerId);
      case 'publish': return this.publishBuild(params.buildId, params, ownerId, context.managedAppService);
      case 'rollback': return this.rollback(params.projectId, params, ownerId);
      default: throw Object.assign(new Error(`Unsupported game-studio action ${action}`), { statusCode: 400, code: 'INVALID_GAME_STUDIO_ACTION' });
    }
  }
}

module.exports = {
  AI_RUN_SCHEMA,
  GameStudioService,
  INDEX_SCHEMA,
  MAX_ASSET_BYTES,
  serializeError,
  slugify,
};

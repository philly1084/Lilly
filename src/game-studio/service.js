'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const { config } = require('../config');
const { postgres } = require('../postgres');
const { parseLenientJson } = require('../utils/lenient-json');
const { normalizeFrontendBundle } = require('../frontend-bundles');
const {
  BLUEPRINT_SCHEMA,
  BUILD_SCHEMA,
  COMMAND_SCHEMA,
  PROJECT_SCHEMA,
  applyCommandBatch,
  createArenaProject,
  deepClone,
  getScene,
  validateProject,
} = require('../../packages/lilly-engine/dist/core/src');
const {
  compileBlueprint,
  validateBlueprint,
} = require('../../packages/lilly-engine/dist/blueprints/src');
const { writeImmutableBuild } = require('./player-bundle');

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
    this.buildRoot = path.resolve(options.buildRoot || path.join(process.cwd(), 'output', 'sandboxes'));
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
    const name = String(input.name || input.project?.name || 'Neon Arena').trim().slice(0, 100) || 'Neon Arena';
    const slug = slugify(input.slug || name);
    const imported = input.project?.schema === PROJECT_SCHEMA ? deepClone(input.project) : null;
    const importedBundle = normalizeImportBundle(input.importBundle);
    const project = imported || createArenaProject({ id, name, slug });
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
      source: imported ? 'import:lilly-project' : (importedBundle ? 'import:compatible-web-bundle' : 'template:third-person-arena'),
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
    const project = JSON.parse(await fs.readFile(this.currentPath(projectId), 'utf8'));
    return this.describeProject(metadata, project, index);
  }

  describeProject(metadata, project, index) {
    const blueprintIssues = project.blueprints.flatMap((graph) => validateBlueprint(graph).map((issue) => ({ ...issue, graphId: graph.id })));
    return {
      metadata,
      project,
      validation: {
        valid: !validateProject(project).some((issue) => issue.severity === 'error') && !blueprintIssues.some((issue) => issue.severity === 'error'),
        projectIssues: validateProject(project),
        blueprintIssues,
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
      const project = JSON.parse(await fs.readFile(this.currentPath(projectId), 'utf8'));
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
      await this.writeIndex(index);
      await this.emit(projectId, 'commands.applied', { baseRevision, revision: applied.project.revision, commandIds: commands.map((command) => command.commandId), source: input.source || 'editor' });
      return { ...this.describeProject(metadata, applied.project, index), commandBatch: { schema: 'LillyCommandBatch/v1', baseRevision, revision: applied.project.revision, commands, inverses: applied.inverses } };
    });
  }

  async rollback(projectId, input = {}, ownerId = '') {
    return this.withProjectLock(projectId, async () => {
      const { metadata, index } = await this.getMetadata(projectId, ownerId);
      if (!metadata) return null;
      const current = JSON.parse(await fs.readFile(this.currentPath(projectId), 'utf8'));
      const targetRevision = Number(input.revision);
      if (!Number.isInteger(targetRevision) || targetRevision < 1 || targetRevision >= current.revision) throw Object.assign(new Error('rollback revision must be an earlier saved revision'), { statusCode: 400, code: 'INVALID_ROLLBACK_REVISION' });
      const target = JSON.parse(await fs.readFile(this.revisionPath(projectId, targetRevision), 'utf8'));
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
      const project = JSON.parse(await fs.readFile(this.currentPath(projectId), 'utf8'));
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
    const projectIssues = validateProject(project).filter((issue) => issue.severity === 'error');
    tests.push({ name: 'Project schema and components', status: projectIssues.length ? 'failed' : 'passed', details: projectIssues.map((issue) => issue.message).join('; ') });
    const blueprintIssues = project.blueprints.flatMap((graph) => validateBlueprint(graph).filter((issue) => issue.severity === 'error'));
    tests.push({ name: 'Blueprint validation', status: blueprintIssues.length ? 'failed' : 'passed', details: blueprintIssues.map((issue) => issue.message).join('; ') });
    const compiledGraphs = [];
    if (!blueprintIssues.length) project.blueprints.forEach((graph) => compiledGraphs.push(compileBlueprint(graph)));
    tests.push({ name: 'Blueprint compilation', status: compiledGraphs.length === project.blueprints.length ? 'passed' : 'failed', details: `${compiledGraphs.length}/${project.blueprints.length} graphs compiled` });
    const scene = getScene(project);
    const player = scene.entities.find((entity) => entity.tags.includes('player'));
    const camera = scene.entities.find((entity) => entity.components.some((component) => component.type === 'Camera' && component.data.primary === true));
    tests.push({ name: 'Automated control contract', status: player && camera ? 'passed' : 'failed', details: player && camera ? 'Player and primary camera are available to the control harness' : 'A player and primary camera are required' });
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
      fixedSteps: Math.max(1, Math.min(Number(input.fixedSteps) || 120, 3600)),
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
      const project = JSON.parse(await fs.readFile(this.currentPath(projectId), 'utf8'));
      if (input.projectRevision != null && Number(input.projectRevision) !== project.revision) throw Object.assign(new Error('Build revision no longer matches the saved project revision'), { statusCode: 409, code: 'BUILD_REVISION_CONFLICT' });
      const playtest = await this.runPlaytest(projectId, input, ownerId);
      if (playtest.status !== 'passed') throw Object.assign(new Error('Build blocked by failed project or Blueprint validation'), { statusCode: 422, code: 'PLAYTEST_FAILED', tests: playtest.tests });
      const id = randomUUID();
      const workspaceId = `game-studio-${slugify(project.slug)}-r${project.revision}-${id.slice(0, 8)}`;
      const directory = path.join(this.buildRoot, workspaceId);
      const files = await writeImmutableBuild({ directory, project, graphIr: playtest.compiledGraphs });
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

  deterministicProposal(project, prompt = '') {
    const normalized = String(prompt || '').toLowerCase();
    const scene = getScene(project);
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
    const project = JSON.parse(await fs.readFile(this.currentPath(projectId), 'utf8'));
    const baseRevision = Number.isInteger(Number(input.baseRevision)) ? Number(input.baseRevision) : project.revision;
    if (baseRevision !== project.revision) throw Object.assign(new Error('AI proposal is based on a stale project revision'), { statusCode: 409, code: 'REVISION_CONFLICT', currentRevision: project.revision });
    let proposed = Array.isArray(input.commands) ? input.commands : null;
    if (!proposed && this.complete && String(input.prompt || '').trim()) {
      try {
        const response = await this.complete(`Return JSON only with a commands array. Every mutation must be a LillyCommand/v1 operation using one of entity.create, entity.delete, entity.rename, entity.reparent, entity.set-enabled, entity.set-locked, component.set, component.remove, scene.set-environment, blueprint.replace, project.set-settings. Project: ${JSON.stringify(project)}. Request: ${String(input.prompt).slice(0, 2000)}`);
        const parsed = parseLenientJson(String(response || ''));
        proposed = parsed?.commands || (Array.isArray(parsed) ? parsed : null);
      } catch (error) {
        console.warn(`[GameStudio] AI proposal fallback: ${error.message}`);
      }
    }
    proposed ||= this.deterministicProposal(project, input.prompt);
    const commands = this.normalizeCommands(project, proposed, baseRevision);
    let preview;
    try { preview = applyCommandBatch(project, commands, baseRevision); }
    catch (error) { error.statusCode ||= 422; throw error; }
    const affected = commands.map((command) => ({ operation: command.operation, sceneId: command.target.sceneId || null, entityId: command.target.entityId || command.payload.entity?.id || null, graphId: command.target.graphId || null }));
    const run = {
      schema: AI_RUN_SCHEMA,
      id: randomUUID(),
      projectId,
      ownerId,
      baseRevision,
      prompt: String(input.prompt || ''),
      status: 'proposed',
      commands,
      affected,
      preview: { revision: preview.project.revision, validation: { projectIssues: validateProject(preview.project), blueprintIssues: preview.project.blueprints.flatMap(validateBlueprint) } },
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
      case 'inspect-project': return this.getProject(params.projectId, ownerId);
      case 'inspect-scene': return this.inspectScene(params.projectId, params.sceneId, ownerId);
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

'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { COMMAND_SCHEMA } = require('../../packages/lilly-engine/dist/core/src');
const { GameStudioService } = require('./service');
const { dashModuleFiles } = require('./test-fixtures/agent-module');

describe('GameStudioService', () => {
  let tempRoot;
  let service;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-game-studio-'));
    service = new GameStudioService({
      root: path.join(tempRoot, 'data'),
      buildRoot: path.join(tempRoot, 'sandboxes'),
      postgres: { enabled: false },
    });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('creates a durable versioned canary project', async () => {
    const registry = await service.executeToolAction('list-templates', {}, { userId: 'phil' });
    expect(registry).toMatchObject({
      schema: 'LillyProjectTemplateRegistry/v1',
      engineVersion: '0.7.0',
      templates: expect.arrayContaining([expect.objectContaining({ id: 'third-person-explorer' }), expect.objectContaining({ id: 'top-down-action' })]),
    });
    const result = await service.createProject({ name: 'Canary Arena', prompt: 'A frozen vault with seven rooms and three relics', seed: 'canary-seed' }, 'phil');
    expect(result.project.schema).toBe('LillyProject/v1');
    expect(result.project.revision).toBe(1);
    expect(result.project.engineVersion).toBe('0.7.0');
    expect(result.project.blueprints).toHaveLength(2);
    expect(result.project.levelRecipes).toEqual([expect.objectContaining({ schema: 'LillyLevelRecipe/v1', seed: 'canary-seed', theme: 'frost-vault' })]);
    expect(result.project.generatedLevels).toEqual([expect.objectContaining({ schema: 'LillyGeneratedLevel/v1', metrics: expect.objectContaining({ roomCount: 7 }) })]);
    expect(result.metadata.source).toBe('template:ai-procedural-expedition');
    expect(result.validation.valid).toBe(true);
    await expect(fs.access(service.revisionPath(result.project.id, 1))).resolves.toBeUndefined();
  });

  test.each(['third-person-explorer', 'top-down-action'])('creates, tests, and packages the %s game kit', async (template) => {
    const created = await service.createProject({ name: `${template} canary`, template }, 'phil');
    expect(created.project.settings.runtimeProfile).toBe('module-driven');
    expect(created.project.levelRecipes).toEqual([]);
    expect(created.project.files).toHaveLength(4);
    expect(created.validation.valid).toBe(true);
    const compiled = await service.compileProjectModules(created.project.id, { revision: 1 }, 'phil');
    expect(compiled).toMatchObject({ valid: true, modules: [expect.any(Object)], tests: [expect.any(Object)] });
    const playtest = await service.runPlaytest(created.project.id, {}, 'phil');
    expect(playtest.status).toBe('passed');
    expect(playtest.tests).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Agent-authored mechanic specifications', status: 'passed' }),
      expect.objectContaining({ name: 'Procedural level topology', status: 'passed' }),
    ]));
    const build = await service.createBuild(created.project.id, { projectRevision: 1 }, 'phil');
    expect(build).toMatchObject({ status: 'success', engineVersion: '0.7.0', buildProfileId: 'release' });
    const html = await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'index.html'), 'utf8');
    const manifest = JSON.parse(await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'build-manifest.json'), 'utf8'));
    expect(html).toContain('Lilly module-driven runtime');
    expect(html).not.toContain('Lilly generated expedition');
    expect(manifest).toMatchObject({ engineVersion: '0.7.0', buildProfileId: 'release', moduleCount: 1, systemCount: 1, mechanicTestCount: 1 });
  }, 20_000);

  test('honors an authored build profile in the immutable manifest and player project', async () => {
    const created = await service.createProject({ name: 'Profiled Player', template: 'third-person-explorer' }, 'phil');
    const buildProfile = { schema: 'LillyBuildProfile/v1', id: 'lean-canary', name: 'Lean canary', target: 'browser', mode: 'development', entryScene: 'open-field', renderer: 'webgl2', quality: 'performance', debugOverlay: true, mobileControls: false };
    const updated = await service.upsertBuildProfile(created.project.id, { baseRevision: 1, buildProfile }, 'phil');
    const build = await service.createBuild(created.project.id, { projectRevision: updated.project.revision, buildProfileId: buildProfile.id }, 'phil');
    expect(build).toMatchObject({ buildProfileId: 'lean-canary', buildProfile: { quality: 'performance', mobileControls: false } });
    const directory = path.join(service.buildRoot, build.workspaceId);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'build-manifest.json'), 'utf8'));
    const packagedProject = JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8'));
    const html = await fs.readFile(path.join(directory, 'index.html'), 'utf8');
    expect(manifest).toMatchObject({ buildProfileId: 'lean-canary', buildProfile: { mode: 'development', quality: 'performance' } });
    expect(packagedProject.settings.buildProfile).toEqual(buildProfile);
    expect(html).toContain('Lean canary');
    expect(html).toContain('class="touch-controls" aria-label="Touch movement controls" hidden');
  }, 20_000);

  test('bounds every immutable build workspace and file below the shared sandbox root', () => {
    expect(service.buildWorkspaceDirectory('game-studio-safe-r1-12345678')).toBe(
      path.join(service.buildRoot, 'game-studio-safe-r1-12345678'),
    );
    expect(() => service.buildWorkspaceDirectory('..')).toThrow(
      expect.objectContaining({ code: 'BUILD_WORKSPACE_PATH_INVALID' }),
    );
    expect(() => service.buildWorkspaceFilePath('game-studio-safe-r1-12345678', '../index.html')).toThrow(
      expect.objectContaining({ code: 'BUILD_FILE_PATH_INVALID' }),
    );
  });

  test('imports a compatible web bundle explicitly without silently converting it', async () => {
    const result = await service.createProject({
      name: 'Imported Three Game',
      importBundle: {
        entry: 'index.html',
        files: [
          { path: 'index.html', content: '<!doctype html><canvas id="game"></canvas><script type="module" src="./game.js"></script>' },
          { path: 'game.js', content: "import * as THREE from 'three'; console.log(THREE);" },
        ],
      },
    }, 'phil');

    expect(result.metadata.source).toBe('import:compatible-web-bundle');
    expect(result.metadata.importedBundle).toMatchObject({ status: 'archived-needs-mapping', fileCount: 2 });
    expect(result.project.settings.legacyImport).toMatchObject({ manualMappingRequired: true });
    expect(result.project.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'legacy-source-bundle' })]));
    await expect(fs.readFile(path.join(service.projectDirectory(result.project.id), 'imports', 'original', 'game.js'), 'utf8')).resolves.toContain('THREE');
  });

  test('applies audited commands and refuses a stale batch', async () => {
    const created = await service.createProject({ name: 'Commands' }, 'phil');
    const projectId = created.project.id;
    const command = {
      schema: COMMAND_SCHEMA,
      commandId: 'rename-player',
      projectId,
      baseRevision: 1,
      operation: 'entity.rename',
      target: { sceneId: 'arena', entityId: 'player' },
      payload: { name: 'Runner' },
    };
    const updated = await service.applyCommands(projectId, { baseRevision: 1, commands: [command] }, 'phil');
    expect(updated.project.revision).toBe(2);
    expect(updated.project.scenes[0].entities.find((entity) => entity.id === 'player').name).toBe('Runner');
    await expect(service.applyCommands(projectId, { baseRevision: 1, commands: [command] }, 'phil')).rejects.toMatchObject({ code: 'REVISION_CONFLICT', statusCode: 409 });
  });

  test('lets an outside agent build a runnable game from blank versioned parts', async () => {
    const created = await service.executeToolAction('create-project', { name: 'Agent Built Dash', template: 'blank' }, { userId: 'phil' });
    const projectId = created.project.id;
    expect(created.metadata.source).toBe('template:blank-agent-project');
    expect(created.project.files).toEqual([]);

    const composed = await service.executeToolAction('apply-commands', {
      projectId,
      baseRevision: 1,
      commands: [
        {
          operation: 'entity.create',
          target: { sceneId: 'main' },
          payload: {
            entity: {
              schema: 'LillyEntity/v1',
              id: 'player',
              name: 'Agent Player',
              parentId: 'world',
              enabled: true,
              tags: ['player'],
              components: [
                { type: 'Transform', enabled: true, data: { position: { x: 0, y: 0.65, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'MeshRenderer', enabled: true, data: { geometry: 'capsule', material: { color: '#38bdf8' } } },
              ],
            },
          },
        },
        {
          operation: 'entity.create',
          target: { sceneId: 'main' },
          payload: {
            entity: {
              schema: 'LillyEntity/v1',
              id: 'camera',
              name: 'Agent Camera',
              parentId: 'world',
              enabled: true,
              tags: ['camera'],
              components: [
                { type: 'Transform', enabled: true, data: { position: { x: 7, y: 7, z: 11 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'Camera', enabled: true, data: { primary: true, fov: 58, near: 0.1, far: 1000 } },
              ],
            },
          },
        },
        {
          operation: 'input.replace',
          target: {},
          payload: { inputMap: [
            { action: 'Move', kind: 'axis2d', keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD'] },
            { action: 'Dash', kind: 'button', keys: ['ShiftLeft', 'ShiftRight'] },
          ] },
        },
      ],
    }, { userId: 'phil' });
    expect(composed.project.revision).toBe(2);

    const written = await service.executeToolAction('write-files', {
      projectId,
      baseRevision: 2,
      files: dashModuleFiles(),
    }, { userId: 'phil' });
    expect(written.project.revision).toBe(3);
    expect(written.project.files).toHaveLength(5);

    const sourceTree = await service.executeToolAction('list-files', { projectId }, { userId: 'phil' });
    expect(sourceTree).toMatchObject({ schema: 'LillySourceTree/v1', revision: 3 });
    expect(sourceTree.files.map((file) => file.kind)).toEqual(expect.arrayContaining(['module-manifest', 'mechanic', 'system', 'prefab', 'test']));
    const systemFile = await service.executeToolAction('read-file', { projectId, path: 'modules/traversal/dash.system.ts' }, { userId: 'phil' });
    expect(systemFile.file.content).toContain("from '@lilly/engine-runtime'");

    const compile = await service.executeToolAction('compile-project', { projectId, revision: 3 }, { userId: 'phil' });
    expect(compile).toMatchObject({ schema: 'LillyModuleBundle/v1', valid: true, loadOrder: ['player-dash'] });
    expect(compile.diagnostics).toEqual([]);
    const mechanicTests = await service.executeToolAction('run-mechanic-tests', { projectId, revision: 3 }, { userId: 'phil' });
    expect(mechanicTests).toMatchObject({ schema: 'LillyMechanicTestRun/v1', status: 'passed', passed: 1, failed: 0 });

    const instantiated = await service.executeToolAction('instantiate-prefab', {
      projectId,
      baseRevision: 3,
      sceneId: 'main',
      path: 'modules/traversal/dash-trail.prefab.json',
      prefabId: 'dash-trail',
      instanceId: 'authored-dash-trail',
      parentId: 'world',
      config: {
        position: { x: 3, y: 0, z: -2 },
        entities: { trail: { name: 'Player Dash Trail', components: { MeshRenderer: { material: { color: '#ff4fd8' } } } } },
      },
    }, { userId: 'phil' });
    expect(instantiated.project.scenes[0].entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'authored-dash-trail:trail', name: 'Player Dash Trail', tags: expect.arrayContaining(['prefab:dash-trail']) }),
    ]));
    const dashTrail = instantiated.project.scenes[0].entities.find((entry) => entry.id === 'authored-dash-trail:trail');
    expect(dashTrail.components.find((entry) => entry.type === 'Transform').data.position).toEqual({ x: 3, y: 0.5, z: -2 });
    expect(dashTrail.components.find((entry) => entry.type === 'MeshRenderer').data.material).toMatchObject({ color: '#ff4fd8', emissive: '#0891b2' });

    const editorPreview = await service.createEditorPreview(projectId, { projectRevision: 4 }, 'phil');
    expect(editorPreview).toMatchObject({ schema: 'LillyEditorPreview/v1', projectRevision: 4, moduleSourceHash: compile.sourceHash, cached: false });
    expect(editorPreview.previewUrl).toBe(`/api/sandbox-workspaces/${encodeURIComponent(editorPreview.workspaceId)}/preview/`);
    await expect(fs.access(path.join(service.buildRoot, editorPreview.workspaceId, 'module-sandbox.html'))).resolves.toBeUndefined();
    const cachedEditorPreview = await service.createEditorPreview(projectId, { projectRevision: 4 }, 'phil');
    expect(cachedEditorPreview).toMatchObject({ workspaceId: editorPreview.workspaceId, cached: true });
    expect((await service.readIndex()).builds).toHaveLength(0);

    const build = await service.executeToolAction('build', { projectId, projectRevision: 4 }, { userId: 'phil' });
    expect(build.status).toBe('success');
    expect(build.tests).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Agent module compilation and capability policy', status: 'passed' }),
      expect.objectContaining({ name: 'Agent-authored mechanic specifications', status: 'passed' }),
    ]));
    expect(build.files.map((file) => file.path)).toEqual(expect.arrayContaining(['modules.json', 'module-sandbox.html']));
    const moduleBundle = JSON.parse(await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'modules.json'), 'utf8'));
    expect(moduleBundle).toMatchObject({ schema: 'LillyModuleBundle/v1', sourceHash: compile.sourceHash, loadOrder: ['player-dash'] });
    const moduleSandbox = await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'module-sandbox.html'), 'utf8');
    expect(moduleSandbox).toContain("worker-src blob:");
    expect(moduleSandbox).toContain('LillyModuleSandboxResult/v1');
    expect(moduleSandbox).toContain("worker.postMessage({ ...message, schema: 'LillyModuleWorkerMessage/v1' });");
    const manifest = JSON.parse(await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'build-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ schema: 'LillyPlayerBundle/v2', moduleSourceHash: compile.sourceHash, moduleCount: 1, systemCount: 1, mechanicTestCount: 1 });
  }, 20_000);

  test('authors, validates, previews, and packages a complete world resource layer', async () => {
    const created = await service.createProject({ name: 'World Authoring Canary', seed: 'world-authoring' }, 'phil');
    const uploaded = await service.saveAsset(created.project.id, {
      filename: 'landmark.glb',
      name: 'Landmark Model',
      mimeType: 'model/gltf-binary',
      contentBase64: Buffer.from('bounded-glb-fixture').toString('base64'),
      metadata: { upAxis: 'Y', unitsPerMeter: 1 },
    }, 'phil');
    expect(uploaded.asset.metadata).toMatchObject({ kind: 'model', upAxis: 'Y', unitsPerMeter: 1, sizeBytes: 19 });
    const read = await service.readAssetContent(created.project.id, uploaded.asset.id, 'phil');
    expect(read.asset.id).toBe(uploaded.asset.id);
    expect(read.content.toString('utf8')).toBe('bounded-glb-fixture');

    const moduleId = 'world-authoring';
    const resolution = 3;
    const heights = [0, 0.12, 0, 0.1, 0.5, 0.1, 0, 0.12, 0];
    const sourceFiles = [
      { path: 'world/canary/canary.module.json', content: JSON.stringify({ schema: 'LillyGameModule/v1', id: moduleId, name: 'World Authoring', version: '1.0.0', dependencies: [], capabilities: [], systems: [], mechanics: [], prefabs: ['./landmark.prefab.json'], tests: [], materials: ['./surface.material.json'], assets: ['./landmark.asset.json'], animations: ['./landmark.animation.json'], terrains: ['./arena.terrain.json'] }) },
      { path: 'world/canary/surface.material.json', content: JSON.stringify({ schema: 'LillyMaterial/v1', id: 'canary-surface', moduleId, name: 'Canary Surface', shading: 'physical', color: '#28635c', emissive: '#082f34', emissiveIntensity: 0.2, roughness: 0.76, metalness: 0.08, clearcoat: 0.12 }) },
      { path: 'world/canary/landmark.asset.json', content: JSON.stringify({ schema: 'LillyAssetMetadata/v1', id: 'canary-landmark-model', moduleId, assetId: uploaded.asset.id, name: 'Canary Landmark Model', kind: 'model', scale: { x: 1, y: 1, z: 1 }, pivot: { x: 0, y: 0, z: 0 }, castShadow: true, receiveShadow: true, collision: { shape: 'box', size: { x: 1.5, y: 2.5, z: 1.5 }, center: { x: 0, y: 1.25, z: 0 } }, lods: [], animations: [] }) },
      { path: 'world/canary/landmark.animation.json', content: JSON.stringify({ schema: 'LillyAnimationController/v1', id: 'canary-landmark-motion', moduleId, name: 'Canary Landmark Motion', defaultState: 'float', states: [{ id: 'float', mode: 'float', amplitude: 0.22, frequency: 0.4 }, { id: 'spin', mode: 'spin', axis: 'y', speed: 0.75 }] }) },
      { path: 'world/canary/arena.terrain.json', content: JSON.stringify({ schema: 'LillyTerrain/v1', id: 'canary-terrain', moduleId, name: 'Canary Terrain', size: { x: 24, y: 24 }, resolution, heights, heightScale: 3.5, materialId: 'canary-surface', collision: true, walkable: true }) },
      { path: 'world/canary/landmark.prefab.json', content: JSON.stringify({ schema: 'LillyPrefab/v1', id: 'canary-landmark', moduleId, name: 'Canary Landmark', rootEntityId: 'landmark', entities: [{ schema: 'LillyEntity/v1', id: 'landmark', name: 'Floating Landmark', parentId: null, enabled: true, tags: ['landmark'], components: [{ type: 'Transform', enabled: true, data: { position: { x: 0, y: 2.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }, { type: 'MeshRenderer', enabled: true, data: { geometry: 'octahedron', materialId: 'canary-surface', material: { emissive: '#22d3ee', emissiveIntensity: 0.8 } } }, { type: 'Animator', enabled: true, data: { controllerId: 'canary-landmark-motion', state: 'float', speed: 1, autoplay: true } }] }], variants: [{ id: 'sentinel', entities: { landmark: { name: 'Sentinel Landmark', components: { Animator: { state: 'spin', speed: 1.2 }, MeshRenderer: { material: { color: '#7c3aed', emissive: '#c084fc' } } } } } }] }) },
    ];
    const written = await service.writeSourceFiles(created.project.id, { baseRevision: 2, files: sourceFiles }, 'phil');
    expect(written.project.revision).toBe(3);
    expect(written.moduleSummary).toMatchObject({ prefabs: [{ id: 'canary-landmark', variants: [{ id: 'sentinel', name: 'sentinel' }] }], materials: [{ id: 'canary-surface' }], assets: [{ id: 'canary-landmark-model' }], animations: [{ id: 'canary-landmark-motion' }], terrains: [{ id: 'canary-terrain' }] });
    expect(written.validation.worldIssues).toEqual([]);

    const composed = await service.applyCommands(created.project.id, { baseRevision: 3, commands: [{ operation: 'entity.create', target: { sceneId: 'arena' }, payload: { entity: { schema: 'LillyEntity/v1', id: 'authored-terrain', name: 'Authored Terrain', parentId: 'world', enabled: true, tags: ['ground', 'terrain'], components: [{ type: 'Transform', enabled: true, data: { position: { x: 0, y: -0.4, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }, { type: 'Terrain', enabled: true, data: { terrainId: 'canary-terrain', walkable: true, collision: true } }] } } }] }, 'phil');
    const instantiated = await service.instantiatePrefab(created.project.id, { baseRevision: composed.project.revision, sceneId: 'arena', path: 'world/canary/landmark.prefab.json', prefabId: 'canary-landmark', instanceId: 'sentinel-one', parentId: 'world', config: { variant: 'sentinel', position: { x: 4, y: 0, z: -3 } } }, 'phil');
    const sentinel = instantiated.project.scenes[0].entities.find((entity) => entity.id === 'sentinel-one:landmark');
    expect(sentinel).toMatchObject({ name: 'Sentinel Landmark' });
    expect(sentinel.components.find((entry) => entry.type === 'Animator').data).toMatchObject({ state: 'spin', speed: 1.2 });

    const compile = await service.compileProjectModules(created.project.id, { revision: instantiated.project.revision }, 'phil');
    expect(compile).toMatchObject({ valid: true, prefabs: [{ id: 'canary-landmark', variants: [{ id: 'sentinel', name: 'sentinel' }] }], materials: [{ id: 'canary-surface' }], assets: [{ assetId: uploaded.asset.id }], animations: [{ id: 'canary-landmark-motion' }], terrains: [{ id: 'canary-terrain' }], worldIssues: [] });
    const playtest = await service.runPlaytest(created.project.id, {}, 'phil');
    expect(playtest.status).toBe('passed');
    expect(playtest.tests).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'World resources and authored asset metadata', status: 'passed' })]));
    const build = await service.createBuild(created.project.id, { projectRevision: instantiated.project.revision }, 'phil');
    const manifest = JSON.parse(await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'build-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ materialCount: 1, assetMetadataCount: 1, animationControllerCount: 1, terrainCount: 1 });
    const moduleBundle = JSON.parse(await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'modules.json'), 'utf8'));
    expect(moduleBundle.terrains[0]).toMatchObject({ id: 'canary-terrain', heights });
    await expect(fs.readFile(path.join(service.buildRoot, build.workspaceId, uploaded.asset.uri), 'utf8')).resolves.toBe('bounded-glb-fixture');
  }, 20_000);

  test('proposes validated AI commands without mutating the saved revision', async () => {
    const created = await service.createProject({ name: 'AI Review' }, 'phil');
    const run = await service.createAiRun(created.project.id, { prompt: 'Make the shards glow and add a violet rim light' }, 'phil');
    expect(run.schema).toBe('LillyAiRun/v1');
    expect(run.commands.length).toBeGreaterThan(1);
    expect(run.preview.validation.projectIssues).toEqual([]);
    const reloaded = await service.getProject(created.project.id, 'phil');
    expect(reloaded.project.revision).toBe(1);
  });

  test('proposes and atomically applies a seeded AI level without mutating during review', async () => {
    const created = await service.createProject({ name: 'Level Director', seed: 'original-seed' }, 'phil');
    const originalChecksum = created.project.generatedLevels[0].checksum;
    const run = await service.createAiRun(created.project.id, {
      mode: 'level',
      prompt: 'A hard ember foundry with 9 rooms, 5 cores, and 7 traps',
      seed: 'reviewed-level-seed',
    }, 'phil');

    expect(run.mode).toBe('level');
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]).toMatchObject({ operation: 'level.generate', target: { sceneId: 'arena' } });
    expect(run.preview.level).toMatchObject({ theme: 'ember-foundry', seed: 'reviewed-level-seed', difficulty: 4, metrics: { roomCount: 9, pickupCount: 5, hazardCount: 7 } });
    expect(run.preview.level.checksum).not.toBe(originalChecksum);
    expect((await service.getProject(created.project.id, 'phil')).project.revision).toBe(1);

    const applied = await service.applyCommands(created.project.id, { baseRevision: 1, source: 'ai', aiRunId: run.id, commands: run.commands }, 'phil');
    expect(applied.project.revision).toBe(2);
    expect(applied.project.generatedLevels[0].checksum).toBe(run.preview.level.checksum);
    expect(applied.commandBatch.inverses[0].operation).toBe('level.restore');
  });

  test('falls back to the deterministic architect when a model returns a malformed recipe', async () => {
    service.complete = jest.fn(async () => JSON.stringify({ recipe: { schema: 'Wrong/v1', layout: { roomCount: 999 } } }));
    const created = await service.createProject({ name: 'Safe AI Fallback' }, 'phil');
    const run = await service.createAiRun(created.project.id, {
      mode: 'level',
      prompt: 'A calm frost vault with 6 rooms and 3 cores',
      seed: 'fallback-seed',
    }, 'phil');

    expect(service.complete).toHaveBeenCalledTimes(1);
    expect(run.commands).toHaveLength(1);
    expect(run.preview.validation.projectIssues).toEqual([]);
    expect(run.preview.level).toMatchObject({ theme: 'frost-vault', seed: 'fallback-seed', metrics: { roomCount: 6, pickupCount: 3 } });
  });

  test('playtests and creates an immutable runnable build', async () => {
    const created = await service.createProject({ name: 'Build Arena' }, 'phil');
    const playtest = await service.runPlaytest(created.project.id, { fixedSteps: 180 }, 'phil');
    expect(playtest.status).toBe('passed');
    expect(playtest.tests.every((test) => test.status === 'passed')).toBe(true);
    const uploaded = await service.saveAsset(created.project.id, {
      filename: 'canary.glb',
      name: 'Canary GLB',
      mimeType: 'model/gltf-binary',
      contentBase64: Buffer.from('glTF-canary').toString('base64'),
    }, 'phil');
    const build = await service.createBuild(created.project.id, { projectRevision: uploaded.project.revision }, 'phil');
    expect(build.schema).toBe('LillyBuild/v1');
    expect(build.status).toBe('success');
    expect(build.previewUrl).toContain('/api/sandbox-workspaces/');
    expect(build.files.map((file) => file.path)).toEqual(expect.arrayContaining(['index.html', 'player.js', 'gameplay.js', 'module-sandbox.html', 'modules.json', 'vendor/three.module.js', 'vendor/three.core.js', 'vendor/addons/loaders/GLTFLoader.js', uploaded.asset.uri, 'project.json', 'blueprints.json']));
    const playerSource = await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'player.js'), 'utf8');
    expect(playerSource).toContain("from './vendor/three.module.js'");
    expect(playerSource).toContain("from './gameplay.js'");
    expect(playerSource).toContain("from 'three/addons/loaders/GLTFLoader.js'");
    expect(playerSource).toContain('let fixedStep = 1 / 60');
    expect(playerSource).toContain('__LILLY_GAME__');
    expect(playerSource).toContain('LillyPlayerDebug/v3');
    expect(playerSource).toContain("const message = String(action.text || action.options?.status || 'Mechanic');");
    expect(playerSource).toContain("setStatus(String(action.options?.status || message), action.options?.state || 'playing');");
    const playerHtml = await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'index.html'), 'utf8');
    expect(playerHtml).toContain('class="touch-controls"');
    expect(playerHtml).toContain('id="level-name"');
    const manifest = JSON.parse(await fs.readFile(path.join(service.buildRoot, build.workspaceId, 'build-manifest.json'), 'utf8'));
    expect(manifest.levelChecksum).toBe(uploaded.project.generatedLevels[0].checksum);
    await expect(fs.readFile(path.join(service.buildRoot, build.workspaceId, uploaded.asset.uri), 'utf8')).resolves.toBe('glTF-canary');
    expect(playtest.tests.map((test) => test.name)).toEqual(expect.arrayContaining(['Procedural level topology', 'Deterministic level replay', 'Combat encounter grammar', 'Deterministic combat, gates, checkpoint, and save replay', 'Phone creation and touch input contract']));
    const threeModuleStat = await fs.stat(path.join(service.buildRoot, build.workspaceId, 'vendor', 'three.module.js'));
    expect(threeModuleStat.size).toBeGreaterThan(500000);
    const threeCoreStat = await fs.stat(path.join(service.buildRoot, build.workspaceId, 'vendor', 'three.core.js'));
    expect(threeCoreStat.size).toBeGreaterThan(1000000);
    await expect(fs.writeFile(path.join(service.buildRoot, build.workspaceId, 'index.html'), 'overwrite', { flag: 'wx' })).rejects.toMatchObject({ code: 'EEXIST' });

    const restartedService = new GameStudioService({
      root: service.root,
      buildRoot: service.buildRoot,
      postgres: { enabled: false },
    });
    await restartedService.initialize();
    const restored = await restartedService.getBuild(build.id, 'phil');
    expect(restored.build).toMatchObject({
      id: build.id,
      projectRevision: uploaded.project.revision,
      workspaceId: build.workspaceId,
      status: 'success',
    });
    const restoredManifest = JSON.parse(await fs.readFile(
      path.join(restartedService.buildRoot, restored.build.workspaceId, 'build-manifest.json'),
      'utf8',
    ));
    expect(restoredManifest).toMatchObject({
      schema: 'LillyPlayerBundle/v2',
      projectId: created.project.id,
      revision: uploaded.project.revision,
    });
  });

  test('publishes immutable player files under the managed-app public root', async () => {
    const created = await service.createProject({ name: 'Published Arena', slug: 'published-arena' }, 'phil');
    const binaryFixture = Buffer.from([0, 255, 17, 128, 64, 1]);
    const uploaded = await service.saveAsset(created.project.id, { filename: 'published.glb', name: 'Published GLB', mimeType: 'model/gltf-binary', contentBase64: binaryFixture.toString('base64') }, 'phil');
    const build = await service.createBuild(created.project.id, { projectRevision: uploaded.project.revision }, 'phil');
    const createApp = jest.fn(async () => ({
      app: { id: 'managed-app-1', slug: 'published-arena', status: 'building' },
      buildRun: { id: 'build-run-1' },
    }));
    const managedAppService = { isAvailable: () => true, createApp };

    const published = await service.publishBuild(build.id, {
      publicHost: 'published-arena.demoserver2.buzz',
    }, 'phil', managedAppService);

    const input = createApp.mock.calls[0][0];
    expect(input.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'public/index.html',
      'public/player.js',
      'public/vendor/three.module.js',
      'public/vendor/three.core.js',
      'public/project.json',
      'public/blueprints.json',
      'public/build-manifest.json',
    ]));
    expect(input.files).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'index.html' })]));
    expect(input.files.find((file) => file.path === 'public/index.html').content).toContain('id="game-canvas"');
    expect(input.files.find((file) => file.path === `public/${uploaded.asset.uri}`)).toMatchObject({ encoding: 'base64', content: binaryFixture.toString('base64') });
    expect(published).toMatchObject({
      build: { status: 'published', publicUrl: 'https://published-arena.demoserver2.buzz' },
      previewPreservedUntilHttpsVerified: true,
    });
  });

  test('rolls an earlier snapshot forward as a new revision', async () => {
    const created = await service.createProject({ name: 'Rollback' }, 'phil');
    await service.applyCommands(created.project.id, {
      baseRevision: 1,
      commands: [{ operation: 'entity.rename', target: { sceneId: 'arena', entityId: 'player' }, payload: { name: 'Changed' } }],
    }, 'phil');
    const rolledBack = await service.rollback(created.project.id, { revision: 1 }, 'phil');
    expect(rolledBack.project.revision).toBe(3);
    expect(rolledBack.project.scenes[0].entities.find((entity) => entity.id === 'player').name).toBe('Player');
  });
});

const {
  COMPONENT_DEFINITIONS,
  COMMAND_SCHEMA,
  ENTITY_SCHEMA,
  PROJECT_SCHEMA,
  SCENE_SCHEMA,
  SOURCE_FILE_SCHEMA,
  MATERIAL_SCHEMA,
  ASSET_METADATA_SCHEMA,
  ANIMATION_CONTROLLER_SCHEMA,
  TERRAIN_SCHEMA,
  FixedStepClock,
  CommandHistory,
  applyCommandBatch,
  createArenaProject,
  createBlankProject,
  createProjectFromTemplate,
  createLevelRecipeFromPrompt,
  detectSourceFileKind,
  generateLevel,
  upgradeProject,
  validateGeneratedLevel,
  validateAnimationControllerDefinition,
  validateAssetMetadataDefinition,
  validateMaterialDefinition,
  validateProject,
  validateTerrainDefinition,
} = require('../../dist/core/src');

test('camera projection and clipping reject invalid lenses while keeping legacy perspective defaults', () => {
  const camera = COMPONENT_DEFINITIONS.Camera;
  expect(camera.validate({ ...camera.defaults, projection: 'orthographic', orthographicHeight: 24, near: 0 })).toEqual([]);
  expect(camera.validate({ fov: 60 })).toEqual([]);
  expect(camera.validate({ ...camera.defaults, projection: 'fish-eye' })).toContain('projection must be perspective or orthographic');
  expect(camera.validate({ ...camera.defaults, orthographicHeight: 0 })).not.toEqual([]);
  expect(camera.validate({ ...camera.defaults, near: 20, far: 10 })).not.toEqual([]);
  expect(camera.validate({ ...camera.defaults, near: 0 })).toContain('Perspective camera near clipping must be greater than zero');
});

function command(project, operation, target, payload = {}) {
  return {
    schema: COMMAND_SCHEMA,
    commandId: `command-${operation}`,
    projectId: project.id,
    baseRevision: project.revision,
    operation,
    target,
    payload,
  };
}

describe('Lilly engine core contracts', () => {
  test('serializes a versioned arena project without Three.js objects', () => {
    const project = createArenaProject({ id: 'arena-test' });
    const serialized = JSON.stringify(project);
    expect(project.schema).toBe(PROJECT_SCHEMA);
    expect(project.scenes[0].schema).toBe(SCENE_SCHEMA);
    expect(project.scenes[0].entities[0].schema).toBe(ENTITY_SCHEMA);
    expect(serialized).not.toMatch(/Object3D|WebGLRenderer|THREE\./);
    expect(validateProject(project)).toEqual([]);
  });

  test('creates a blank project that agents can build from scratch in versioned files', () => {
    const project = createBlankProject({ id: 'blank-agent-game', name: 'Agent Game' });
    expect(project.engineVersion).toBe('0.7.0');
    expect(project.buildProfiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'development' }), expect.objectContaining({ id: 'release' })]));
    expect(project.settings.runtimeProfile).toBe('module-driven');
    expect(project.files).toEqual([]);
    expect(project.levelRecipes).toEqual([]);
    expect(project.scenes).toEqual([expect.objectContaining({ id: 'main', entities: [expect.objectContaining({ id: 'world' })] })]);
    expect(validateProject(project)).toEqual([]);
  });

  test('offers validated multi-genre kits without procedural room topology', () => {
    const explorer = createProjectFromTemplate({ id: 'explorer-kit', name: 'Explorer Kit', template: 'third-person-explorer' });
    const action = createProjectFromTemplate({ id: 'action-kit', name: 'Action Kit', template: 'top-down-action' });
    for (const project of [explorer, action]) {
      expect(project.settings.runtimeProfile).toBe('module-driven');
      expect(project.levelRecipes).toEqual([]);
      expect(project.generatedLevels).toEqual([]);
      expect(project.scenes[0].entities.some((entity) => entity.tags.includes('room') || entity.tags.includes('wall'))).toBe(false);
      expect(project.scenes[0].entities.find((entity) => entity.tags.includes('player')).components).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'CharacterController' }),
      ]));
      expect(project.files.map((file) => file.kind)).toEqual(expect.arrayContaining(['module-manifest', 'system', 'mechanic', 'test']));
      expect(validateProject(project)).toEqual([]);
    }
    expect(explorer.scenes[0].entities.filter((entity) => entity.tags.includes('landmark'))).toHaveLength(3);
    expect(action.inputMap).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'Fire', kind: 'button' })]));
  });

  test('upgrades legacy projects into the compatible runtime profile', () => {
    const expedition = createArenaProject({ id: 'legacy-expedition-profile' });
    const authored = createBlankProject({ id: 'legacy-authored-profile' });
    delete expedition.settings.runtimeProfile;
    delete authored.settings.runtimeProfile;
    expect(upgradeProject(expedition).settings.runtimeProfile).toBe('expedition');
    expect(upgradeProject(authored).settings.runtimeProfile).toBe('module-driven');
  });

  test('validates Lilly-owned world resources and detects their source contracts', () => {
    const material = { schema: MATERIAL_SCHEMA, id: 'world-stone', moduleId: 'world-kit', name: 'World Stone', shading: 'physical', color: '#335c57', roughness: 0.82, metalness: 0.06, clearcoat: 0.1 };
    const asset = { schema: ASSET_METADATA_SCHEMA, id: 'arch-model', moduleId: 'world-kit', assetId: 'asset-glb', name: 'Arch Model', kind: 'model', scale: { x: 1, y: 1, z: 1 }, pivot: { x: 0, y: 0, z: 0 }, collision: { shape: 'box', size: { x: 2, y: 3, z: 1 } }, lods: [{ assetId: 'asset-glb-low', maxDistance: 30 }], animations: [{ name: 'idle', clip: 'Idle', loop: true, speed: 1 }] };
    const animation = { schema: ANIMATION_CONTROLLER_SCHEMA, id: 'arch-motion', moduleId: 'world-kit', name: 'Arch Motion', defaultState: 'float', states: [{ id: 'float', mode: 'float', amplitude: 0.2, frequency: 0.5 }, { id: 'turn', mode: 'spin', axis: 'y', speed: 0.8 }] };
    const terrain = { schema: TERRAIN_SCHEMA, id: 'courtyard', moduleId: 'world-kit', name: 'Courtyard', size: { x: 20, y: 20 }, resolution: 3, heights: [0, 0.1, 0, 0.1, 0.4, 0.1, 0, 0.1, 0], heightScale: 4, materialId: material.id, collision: true, walkable: true };
    expect(validateMaterialDefinition(material)).toEqual([]);
    expect(validateAssetMetadataDefinition(asset)).toEqual([]);
    expect(validateAnimationControllerDefinition(animation)).toEqual([]);
    expect(validateTerrainDefinition(terrain)).toEqual([]);
    expect(['surface.material.json', 'arch.asset.json', 'arch.animation.json', 'courtyard.terrain.json'].map(detectSourceFileKind)).toEqual(['material', 'asset-metadata', 'animation-controller', 'terrain']);
    expect(validateTerrainDefinition({ ...terrain, heights: [0] })).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_TERRAIN_HEIGHTS' })]));
    expect(validateAnimationControllerDefinition({ ...animation, defaultState: 'missing' })).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ANIMATION_DEFAULT_STATE_MISSING' })]));
  });

  test('applies a command batch transactionally and advances one revision', () => {
    const project = createArenaProject({ id: 'commands' });
    const result = applyCommandBatch(project, [
      command(project, 'entity.rename', { sceneId: 'arena', entityId: 'player' }, { name: 'Pilot' }),
      command(project, 'component.set', { sceneId: 'arena', entityId: 'player', componentType: 'Transform' }, {
        data: { position: { x: 2, y: 1, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      }),
    ], project.revision);
    expect(result.project.revision).toBe(2);
    expect(result.project.scenes[0].entities.find((entity) => entity.id === 'player').name).toBe('Pilot');
    expect(project.revision).toBe(1);
    expect(result.inverses).toHaveLength(2);
  });

  test('writes and deletes module source files transactionally with undo data', () => {
    const project = createBlankProject({ id: 'source-commands' });
    const file = {
      schema: SOURCE_FILE_SCHEMA,
      path: 'modules/traversal/dash.system.ts',
      kind: 'system',
      language: 'typescript',
      content: "import { defineSystem } from '@lilly/engine-runtime'; export default defineSystem({ id: 'dash' });",
      enabled: true,
    };
    const written = applyCommandBatch(project, [command(project, 'file.upsert', { path: file.path }, { file })], project.revision);
    expect(written.project.files).toEqual([file]);
    expect(written.inverses[0]).toMatchObject({ operation: 'file.delete', target: { path: file.path } });
    const deleted = applyCommandBatch(written.project, [command(written.project, 'file.delete', { path: file.path })], written.project.revision);
    expect(deleted.project.files).toEqual([]);
    expect(deleted.inverses[0]).toMatchObject({ operation: 'file.upsert', payload: { file } });
  });

  test('creates scenes, replaces input actions, and instantiates a source prefab as stable entities', () => {
    const project = createBlankProject({ id: 'composition' });
    const prefab = {
      schema: SOURCE_FILE_SCHEMA,
      path: 'modules/combat/projectile.prefab.json',
      kind: 'prefab',
      language: 'json',
      enabled: true,
      content: JSON.stringify({
        schema: 'LillyPrefab/v1',
        id: 'projectile',
        moduleId: 'combat',
        name: 'Projectile',
        rootEntityId: 'root',
        entities: [
          { schema: ENTITY_SCHEMA, id: 'root', name: 'Projectile', parentId: null, enabled: true, tags: ['projectile'], components: [
            { type: 'Transform', enabled: true, data: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
            { type: 'MeshRenderer', enabled: true, data: { geometry: 'sphere', material: { color: '#ffffff', roughness: 0.35 } } },
          ] },
          { schema: ENTITY_SCHEMA, id: 'trail', name: 'Trail', parentId: 'root', enabled: true, tags: ['fx'], components: [] },
        ],
        variants: [{ id: 'charged', name: 'Charged', entities: { root: { components: { MeshRenderer: { material: { emissive: '#ff0088', emissiveIntensity: 0.9 } } } } } }],
      }),
    };
    const scene = { schema: SCENE_SCHEMA, id: 'arena-two', name: 'Arena Two', environment: { background: '#000', ambientIntensity: 1 }, entities: [{ schema: ENTITY_SCHEMA, id: 'root-two', name: 'Root', parentId: null, enabled: true, tags: ['root'], components: [] }], blueprintGraphIds: [] };
    const result = applyCommandBatch(project, [
      command(project, 'file.upsert', { path: prefab.path }, { file: prefab }),
      command(project, 'scene.create', {}, { scene }),
      command(project, 'input.replace', {}, { inputMap: [{ action: 'Fire', kind: 'button', keys: ['Mouse0'] }] }),
      command(project, 'prefab.instantiate', { sceneId: 'main', path: prefab.path, prefabId: 'projectile', instanceId: 'shot-1' }, {
        parentId: 'world',
        config: {
          variant: 'charged',
          position: { x: 4, y: -1, z: -5 },
          entities: {
            root: { name: 'Charged Shot', tags: ['projectile', 'charged'], components: { MeshRenderer: { material: { color: '#ff33aa' } } } },
            trail: { enabled: false },
          },
        },
      }),
    ], project.revision);
    expect(result.project.scenes.map((entry) => entry.id)).toEqual(['main', 'arena-two']);
    expect(result.project.inputMap).toEqual([{ action: 'Fire', kind: 'button', keys: ['Mouse0'] }]);
    expect(result.project.scenes[0].entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'shot-1:root', name: 'Charged Shot', parentId: 'world', tags: expect.arrayContaining(['charged', 'prefab:projectile', 'instance:shot-1']) }),
      expect.objectContaining({ id: 'shot-1:trail', parentId: 'shot-1:root', enabled: false }),
    ]));
    const root = result.project.scenes[0].entities.find((entry) => entry.id === 'shot-1:root');
    expect(root.components.find((entry) => entry.type === 'Transform').data.position).toEqual({ x: 5, y: 1, z: -2 });
    expect(root.components.find((entry) => entry.type === 'MeshRenderer').data.material).toEqual({ color: '#ff33aa', roughness: 0.35, emissive: '#ff0088', emissiveIntensity: 0.9 });
    expect(validateProject(result.project)).toEqual([]);
  });

  test('rejects ambiguous, unknown, invalid, and unsafe prefab instance overrides', () => {
    const project = createBlankProject({ id: 'prefab-config-guards' });
    const file = {
      schema: SOURCE_FILE_SCHEMA,
      path: 'modules/world/marker.prefab.json',
      kind: 'prefab',
      language: 'json',
      enabled: true,
      content: JSON.stringify({
        schema: 'LillyPrefab/v1',
        id: 'marker',
        moduleId: 'world',
        name: 'Marker',
        rootEntityId: 'root',
        entities: [{
          schema: ENTITY_SCHEMA,
          id: 'root',
          name: 'Marker',
          parentId: null,
          enabled: true,
          tags: ['marker'],
          components: [{ type: 'Transform', enabled: true, data: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
        }],
      }),
    };
    const written = applyCommandBatch(project, [command(project, 'file.upsert', { path: file.path }, { file })], project.revision).project;
    let instanceSequence = 0;
    const instantiate = (target, config) => applyCommandBatch(written, [command(written, 'prefab.instantiate', {
      sceneId: 'main',
      path: file.path,
      instanceId: `guard-${instanceSequence += 1}`,
      ...target,
    }, { parentId: 'world', config })], written.revision);

    expect(() => instantiate({ prefabId: 'not-marker' }, {})).toThrow(/does not match source id/);
    expect(() => instantiate({}, { variant: 'missing' })).toThrow(/variant missing was not found/);
    expect(() => instantiate({}, { entities: { missing: { name: 'Nope' } } })).toThrow(/unknown entity missing/);
    expect(() => instantiate({}, { entities: { root: { components: { MeshRenderer: { material: { color: '#fff' } } } } } })).toThrow(/does not contain component MeshRenderer/);
    expect(() => instantiate({}, { entities: { root: { components: { Transform: { scale: { x: 0, y: 1, z: 1 } } } } } })).toThrow(/non-zero finite Vector3/);
    const unsafe = JSON.parse('{"entities":{"root":{"components":{"Transform":{"__proto__":{"polluted":true}}}}}}');
    expect(() => instantiate({}, unsafe)).toThrow(/__proto__ is not allowed/);
    expect({}.polluted).toBeUndefined();
  });

  test('keeps prefab instances linked to source updates while preserving and undoing local overrides', () => {
    const project = createBlankProject({ id: 'linked-prefab' });
    const definition = {
      schema: 'LillyPrefab/v1',
      id: 'signal-tower',
      moduleId: 'world',
      name: 'Signal Tower',
      rootEntityId: 'root',
      entities: [
        { schema: ENTITY_SCHEMA, id: 'root', name: 'Tower', parentId: null, enabled: true, tags: ['tower'], components: [
          { type: 'Transform', enabled: true, data: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
          { type: 'MeshRenderer', enabled: true, data: { geometry: 'box', material: { color: '#225577', roughness: 0.6 } } },
        ] },
        { schema: ENTITY_SCHEMA, id: 'beacon', name: 'Beacon v1', parentId: 'root', enabled: true, tags: ['beacon'], components: [] },
      ],
    };
    const file = { schema: SOURCE_FILE_SCHEMA, path: 'world/signal-tower.prefab.json', kind: 'prefab', language: 'json', content: JSON.stringify(definition), enabled: true };
    const written = applyCommandBatch(project, [command(project, 'file.upsert', { path: file.path }, { file })], project.revision).project;
    const placed = applyCommandBatch(written, [command(written, 'prefab.instantiate', { sceneId: 'main', path: file.path, instanceId: 'tower-a' }, { parentId: 'world', config: {} })], written.revision).project;
    expect(placed.scenes[0].prefabInstances).toEqual([expect.objectContaining({ instanceId: 'tower-a', prefabPath: file.path, status: 'linked' })]);

    const rename = command(placed, 'entity.rename', { sceneId: 'main', entityId: 'tower-a:root' }, { name: 'Player Tower' });
    const renamed = applyCommandBatch(placed, [rename], placed.revision);
    const history = new CommandHistory();
    history.record([rename], renamed.inverses);
    const undoRename = history.undo(renamed.project);
    expect(undoRename.scenes[0].entities.find((entity) => entity.id === 'tower-a:root').name).toBe('Tower');
    expect(undoRename.scenes[0].prefabInstances[0].overrides.entities).toBeUndefined();

    const local = applyCommandBatch(undoRename, [command(undoRename, 'entity.rename', { sceneId: 'main', entityId: 'tower-a:root' }, { name: 'Player Tower' })], undoRename.revision).project;
    const rootBeforeOverride = local.scenes[0].entities.find((entity) => entity.id === 'tower-a:root');
    const meshBeforeOverride = rootBeforeOverride.components.find((entry) => entry.type === 'MeshRenderer');
    const overridden = applyCommandBatch(local, [command(local, 'component.set', { sceneId: 'main', entityId: rootBeforeOverride.id, componentType: 'MeshRenderer' }, { enabled: true, data: { ...meshBeforeOverride.data, material: { ...meshBeforeOverride.data.material, roughness: 0.2 } } })], local.revision).project;
    const nextDefinition = JSON.parse(JSON.stringify(definition));
    nextDefinition.entities[0].name = 'Tower from source v2';
    nextDefinition.entities[0].components[1].data.material.color = '#ff8800';
    nextDefinition.entities[0].components[1].data.material.roughness = 0.9;
    nextDefinition.entities[1].name = 'Beacon v2';
    const refreshed = applyCommandBatch(overridden, [command(overridden, 'file.upsert', { path: file.path }, { file: { ...file, content: JSON.stringify(nextDefinition) } })], overridden.revision).project;
    expect(refreshed.scenes[0].entities.find((entity) => entity.id === 'tower-a:root')).toMatchObject({ name: 'Player Tower' });
    expect(refreshed.scenes[0].entities.find((entity) => entity.id === 'tower-a:root').components.find((entry) => entry.type === 'MeshRenderer').data.material.color).toBe('#ff8800');
    expect(refreshed.scenes[0].entities.find((entity) => entity.id === 'tower-a:root').components.find((entry) => entry.type === 'MeshRenderer').data.material.roughness).toBe(0.2);
    expect(refreshed.scenes[0].prefabInstances[0].overrides.entities.root.components.MeshRenderer).toEqual({ material: { roughness: 0.2 } });
    expect(refreshed.scenes[0].entities.find((entity) => entity.id === 'tower-a:beacon').name).toBe('Beacon v2');
    expect(() => applyCommandBatch(refreshed, [command(refreshed, 'file.delete', { path: file.path })], refreshed.revision)).toThrow(/still used by linked instances/);

    const unpacked = applyCommandBatch(refreshed, [command(refreshed, 'prefab.unpack', { sceneId: 'main', instanceId: 'tower-a' })], refreshed.revision).project;
    expect(unpacked.scenes[0].prefabInstances).toEqual([]);
    expect(unpacked.scenes[0].entities.find((entity) => entity.id === 'tower-a:root').tags).not.toContain('instance:tower-a');
    expect(validateProject(unpacked)).toEqual([]);
  });

  test('authors shared data and versioned build profiles transactionally with reference guards', () => {
    const project = createBlankProject({ id: 'data-and-profiles' });
    const dataAsset = { schema: 'LillyDataAsset/v1', id: 'player-balance', name: 'Player balance', type: 'stats', tags: ['gameplay'], data: { speed: 7.5, jumpHeight: 2.4 } };
    const profile = { schema: 'LillyBuildProfile/v1', id: 'performance-canary', name: 'Performance canary', target: 'browser', mode: 'development', entryScene: 'main', renderer: 'webgl2', quality: 'performance', debugOverlay: true, mobileControls: false };
    const commands = [
      command(project, 'data-asset.upsert', { dataAssetId: dataAsset.id }, { dataAsset }),
      command(project, 'component.set', { sceneId: 'main', entityId: 'world', componentType: 'DataReference' }, { data: { assetId: dataAsset.id, alias: 'balance' } }),
      command(project, 'build-profile.upsert', { buildProfileId: profile.id }, { buildProfile: profile }),
      command(project, 'project.set-active-build-profile', { buildProfileId: profile.id }, { buildProfileId: profile.id }),
    ];
    const applied = applyCommandBatch(project, commands, project.revision);
    expect(applied.project.dataAssets).toEqual([dataAsset]);
    expect(applied.project.activeBuildProfileId).toBe(profile.id);
    expect(applied.project.buildProfiles).toEqual(expect.arrayContaining([profile]));
    expect(validateProject(applied.project)).toEqual([]);
    expect(() => applyCommandBatch(applied.project, [command(applied.project, 'data-asset.delete', { dataAssetId: dataAsset.id })], applied.project.revision)).toThrow(/still referenced/);

    const history = new CommandHistory();
    history.record(commands, applied.inverses);
    const undone = history.undo(applied.project);
    expect(undone.dataAssets).toEqual([]);
    expect(undone.activeBuildProfileId).toBe('release');
    expect(undone.buildProfiles.some((entry) => entry.id === profile.id)).toBe(false);
    expect(validateProject(undone)).toEqual([]);
  });

  test('upgrades older projects with prefab link, data asset, and build profile collections', () => {
    const legacy = JSON.parse(JSON.stringify(createBlankProject({ id: 'legacy-v06-project' })));
    delete legacy.scenes[0].prefabInstances;
    delete legacy.dataAssets;
    delete legacy.buildProfiles;
    delete legacy.activeBuildProfileId;
    legacy.engineVersion = '0.6.0';
    const upgraded = upgradeProject(legacy);
    expect(upgraded).toMatchObject({ engineVersion: '0.7.0', dataAssets: [], activeBuildProfileId: 'release' });
    expect(upgraded.scenes[0].prefabInstances).toEqual([]);
    expect(upgraded.buildProfiles).toHaveLength(2);
    expect(validateProject(upgraded)).toEqual([]);
  });

  test('rejects stale revisions before modifying project state', () => {
    const project = createArenaProject({ id: 'stale' });
    expect(() => applyCommandBatch(project, [], 0)).toThrow(/Revision conflict/);
    expect(project.revision).toBe(1);
  });

  test('rejects recursive parenting', () => {
    const project = createArenaProject({ id: 'hierarchy' });
    const result = applyCommandBatch(project, [
      command(project, 'entity.create', { sceneId: 'arena' }, {
        entity: { schema: ENTITY_SCHEMA, id: 'child', name: 'Child', parentId: 'player', enabled: true, tags: [], components: [] },
      }),
    ], project.revision);
    const recursive = command(result.project, 'entity.reparent', { sceneId: 'arena', entityId: 'player' }, { parentId: 'child' });
    expect(() => applyCommandBatch(result.project, [recursive], result.project.revision)).toThrow(/Recursive parenting/);
  });

  test('fixed-step clock produces stable simulation counts', () => {
    const clock = new FixedStepClock(60);
    clock.reset(1);
    let steps = 0;
    clock.advance(1 + (1 / 30), () => { steps += 1; });
    expect(steps).toBe(2);
  });

  test('generates a connected level deterministically from a saved recipe', () => {
    const recipe = createLevelRecipeFromPrompt({
      projectId: 'seeded',
      sceneId: 'arena',
      prompt: 'A difficult frozen vault with nine rooms, traps, and a final exit',
      seed: 'same-world-every-time',
    });
    const first = generateLevel(recipe, { parentId: 'world' });
    const replay = generateLevel(recipe, { parentId: 'world' });
    const alternate = generateLevel({ ...recipe, seed: 'another-world' }, { parentId: 'world' });

    expect(first.design.checksum).toBe(replay.design.checksum);
    expect(first.entities).toEqual(replay.entities);
    expect(first.design.checksum).not.toBe(alternate.design.checksum);
    expect(validateGeneratedLevel(first.design, recipe)).toEqual([]);
    expect(first.design.metrics.roomCount).toBeGreaterThanOrEqual(3);
    expect(first.design.metrics.roomCount).toBe(9);
    expect(first.design.connections).toHaveLength(first.design.rooms.length - 1);
  });

  test('generates validated room combat with stable enemies, gates, and checkpoints', () => {
    const project = createArenaProject({
      id: 'combat-contract',
      prompt: 'A compact neon ruin with two combat encounters and four guardians',
      seed: 'combat-contract-seed',
    });
    const design = project.generatedLevels[0];
    const scene = project.scenes[0];
    expect(design.metrics).toMatchObject({ encounterCount: 2, enemyCount: 4, checkpointCount: 2 });
    expect(design.encounters).toHaveLength(2);
    expect(validateProject(project)).toEqual([]);
    for (const encounter of design.encounters) {
      expect(encounter.enemyIds.length).toBeGreaterThan(0);
      expect(encounter.gateIds.length).toBeGreaterThan(0);
      expect(scene.entities.find((entity) => entity.id === encounter.checkpointId)?.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'Checkpoint', data: expect.objectContaining({ encounterId: encounter.id }) }),
      ]));
      encounter.enemyIds.forEach((id) => expect(scene.entities.find((entity) => entity.id === id)?.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'Health' }),
        expect.objectContaining({ type: 'Combatant' }),
        expect.objectContaining({ type: 'EnemyBrain' }),
      ])));
    }
  });

  test('does not mistake the guardian adjective in an encounter count for the enemy count', () => {
    const recipe = createLevelRecipeFromPrompt({
      projectId: 'combat-language',
      sceneId: 'arena',
      prompt: 'A temple with one guardian encounter and two enemies',
      seed: 'combat-language-seed',
    });
    expect(recipe.gameplay).toMatchObject({ encounterCount: 1, enemyCount: 2 });
  });

  test('upgrades pre-encounter generated topology without invalidating peaceful projects', () => {
    const project = createArenaProject({ id: 'legacy-topology', prompt: 'A peaceful frost vault with no enemies', seed: 'legacy-topology-seed' });
    const legacy = JSON.parse(JSON.stringify(project));
    delete legacy.generatedLevels[0].encounters;
    delete legacy.generatedLevels[0].metrics.encounterCount;
    delete legacy.generatedLevels[0].metrics.enemyCount;
    delete legacy.generatedLevels[0].metrics.checkpointCount;
    const upgraded = upgradeProject(legacy);
    expect(upgraded.generatedLevels[0].encounters).toEqual([]);
    expect(upgraded.generatedLevels[0].metrics).toMatchObject({ encounterCount: 0, enemyCount: 0, checkpointCount: 0 });
    expect(validateProject(upgraded)).toEqual([]);
  });

  test('connects a branched room to the actual adjacent parent when the latest room is trapped', () => {
    const recipe = createLevelRecipeFromPrompt({
      projectId: 'branched-path',
      sceneId: 'arena',
      prompt: 'A sprawling level with sixteen rooms',
      seed: '110',
    });
    recipe.layout.roomCount = 16;
    const generated = generateLevel(recipe, { parentId: 'world' });
    const rooms = new Map(generated.design.rooms.map((room) => [room.id, room]));

    for (const connection of generated.design.connections) {
      const from = rooms.get(connection.fromRoomId);
      const to = rooms.get(connection.toRoomId);
      expect(Math.abs(from.grid.x - to.grid.x) + Math.abs(from.grid.z - to.grid.z)).toBe(1);
    }
    expect(validateGeneratedLevel(generated.design, recipe)).toEqual([]);

    const disconnected = JSON.parse(JSON.stringify(generated.design));
    disconnected.connections[10].fromRoomId = disconnected.rooms[10].id;
    expect(validateGeneratedLevel(disconnected, recipe)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GENERATED_LEVEL_CONNECTION_NOT_ADJACENT' }),
    ]));
  });

  test('level generation is one undoable command and restores the previous world', () => {
    const project = createArenaProject({ id: 'level-undo', seed: 'first-seed' });
    const previousChecksum = project.generatedLevels[0].checksum;
    const previousPlayer = project.scenes[0].entities.find((entity) => entity.id === 'player').components.find((entry) => entry.type === 'Transform').data.position;
    const recipe = createLevelRecipeFromPrompt({
      projectId: project.id,
      sceneId: project.entryScene,
      prompt: 'An ember foundry with twelve rooms and many hazards',
      seed: 'second-seed',
      previous: project.levelRecipes[0],
    });
    const forward = command(project, 'level.generate', { sceneId: project.entryScene }, { recipe });
    const applied = applyCommandBatch(project, [forward], project.revision);
    const history = new CommandHistory();
    history.record([forward], applied.inverses);

    expect(applied.project.generatedLevels[0].checksum).not.toBe(previousChecksum);
    expect(applied.project.engineVersion).toBe('0.7.0');
    const undone = history.undo(applied.project);
    expect(undone.generatedLevels[0].checksum).toBe(previousChecksum);
    expect(undone.scenes[0].entities.find((entity) => entity.id === 'player').components.find((entry) => entry.type === 'Transform').data.position).toEqual(previousPlayer);
    expect(validateProject(undone)).toEqual([]);
  });

  test('rejects malformed level recipes without changing the source project', () => {
    const project = createArenaProject({ id: 'invalid-level' });
    const snapshot = JSON.stringify(project);
    const badRecipe = { ...project.levelRecipes[0], layout: { ...project.levelRecipes[0].layout, roomCount: 999 } };
    expect(() => applyCommandBatch(project, [command(project, 'level.generate', { sceneId: 'arena' }, { recipe: badRecipe })], project.revision)).toThrow(/roomCount/i);
    expect(JSON.stringify(project)).toBe(snapshot);
  });

  test('migrates the known legacy arena pieces without touching other authored entities and can undo', () => {
    const project = createArenaProject({ id: 'legacy-upgrade' });
    const scene = project.scenes[0];
    const legacyFloor = JSON.parse(JSON.stringify(scene.entities.find((entity) => entity.tags.includes('room'))));
    legacyFloor.id = 'arena-floor';
    legacyFloor.name = 'Arena Floor';
    legacyFloor.tags = ['ground'];
    const legacyPickup = JSON.parse(JSON.stringify(scene.entities.find((entity) => entity.tags.includes('pickup'))));
    legacyPickup.id = 'pickup-1';
    legacyPickup.name = 'Energy Shard 1';
    legacyPickup.tags = ['pickup'];
    const authored = { schema: ENTITY_SCHEMA, id: 'authored-statue', name: 'Authored Statue', parentId: 'world', enabled: true, tags: ['scenery'], components: [] };
    scene.entities = [...scene.entities.filter((entity) => !entity.tags.includes('generated')), legacyFloor, legacyPickup, authored];
    project.levelRecipes = [];
    project.generatedLevels = [];
    project.engineVersion = '0.1.0';
    const recipe = createLevelRecipeFromPrompt({ projectId: project.id, sceneId: scene.id, prompt: 'A compact verdant temple', seed: 'migrated-seed' });
    const forward = command(project, 'level.generate', { sceneId: scene.id }, { recipe });
    const applied = applyCommandBatch(project, [forward], project.revision);
    const history = new CommandHistory();
    history.record([forward], applied.inverses);

    expect(applied.project.scenes[0].entities.some((entity) => entity.id === 'arena-floor' || entity.id === 'pickup-1')).toBe(false);
    expect(applied.project.scenes[0].entities.some((entity) => entity.id === authored.id)).toBe(true);
    const undone = history.undo(applied.project);
    expect(undone.scenes[0].entities.map((entity) => entity.id)).toEqual(expect.arrayContaining(['arena-floor', 'pickup-1', authored.id]));
    expect(undone.scenes[0].entities.some((entity) => entity.tags.includes('generated'))).toBe(false);
  });
});

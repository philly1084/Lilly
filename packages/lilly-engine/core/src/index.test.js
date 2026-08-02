const {
  COMMAND_SCHEMA,
  ENTITY_SCHEMA,
  PROJECT_SCHEMA,
  SCENE_SCHEMA,
  FixedStepClock,
  CommandHistory,
  applyCommandBatch,
  createArenaProject,
  createLevelRecipeFromPrompt,
  generateLevel,
  upgradeProject,
  validateGeneratedLevel,
  validateProject,
} = require('../../dist/core/src');

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
    expect(applied.project.engineVersion).toBe('0.3.0');
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

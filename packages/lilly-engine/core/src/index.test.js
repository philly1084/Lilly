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
    expect(applied.project.engineVersion).toBe('0.2.0');
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

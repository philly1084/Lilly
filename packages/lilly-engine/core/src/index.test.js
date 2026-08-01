const {
  COMMAND_SCHEMA,
  ENTITY_SCHEMA,
  PROJECT_SCHEMA,
  SCENE_SCHEMA,
  FixedStepClock,
  applyCommandBatch,
  createArenaProject,
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
});

const {
  GAME_MODULE_SCHEMA,
  MECHANIC_SCHEMA,
  MECHANIC_TEST_SCHEMA,
  PREFAB_SCHEMA,
  SOURCE_FILE_SCHEMA,
} = require('../../dist/core/src');
const {
  MODULE_BUNDLE_SCHEMA,
  compileModuleBundle,
} = require('../../dist/modules/src');
const { runMechanicTests } = require('../../../../src/game-studio/module-runner');

function source(path, content) {
  const kind = path.endsWith('.module.json') ? 'module-manifest'
    : path.endsWith('.mechanic.json') ? 'mechanic'
      : path.endsWith('.system.ts') ? 'system'
        : path.endsWith('.prefab.json') ? 'prefab'
          : path.endsWith('.spec.json') ? 'test'
            : 'data';
  return {
    schema: SOURCE_FILE_SCHEMA,
    path,
    kind,
    language: kind === 'system' ? 'typescript' : 'json',
    content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    enabled: true,
  };
}

function dashModuleFiles() {
  return [
    source('modules/dash/dash.module.json', {
      schema: GAME_MODULE_SCHEMA,
      id: 'player-dash',
      name: 'Player Dash',
      version: '1.0.0',
      dependencies: [],
      capabilities: ['input.read', 'physics.impulse', 'events.emit', 'hud.write'],
      systems: ['./dash.system.ts'],
      mechanics: ['./dash.mechanic.json'],
      prefabs: ['./dash-trail.prefab.json'],
      tests: ['./dash.spec.json'],
    }),
    source('modules/dash/dash.mechanic.json', {
      schema: MECHANIC_SCHEMA,
      id: 'player-dash',
      moduleId: 'player-dash',
      name: 'Player Dash',
      systems: ['./dash.system.ts'],
      inputs: ['Dash', 'Move'],
      events: ['dash.performed'],
      components: [{ id: 'dash-state', fields: [{ name: 'cooldown', type: 'number', defaultValue: 0 }] }],
    }),
    source('modules/dash/dash.system.ts', `import { defineSystem } from '@lilly/engine-runtime';

export default defineSystem({
  id: 'player-dash',
  state: { cooldown: 0 },
  onFixedUpdate(ctx) {
    ctx.state.cooldown = Math.max(0, ctx.state.cooldown - ctx.delta);
    if (!ctx.input.button('Dash') || ctx.state.cooldown > 0) return;
    const move = ctx.input.axis2d('Move');
    ctx.physics.impulse(ctx.world.playerId, { x: move.x * 8, y: 0, z: move.y * 8 });
    ctx.events.emit('dash.performed', { entityId: ctx.world.playerId });
    ctx.hud.message('Dash ready');
    ctx.state.cooldown = 0.75;
  },
});`),
    source('modules/dash/dash-trail.prefab.json', {
      schema: PREFAB_SCHEMA,
      id: 'dash-trail',
      moduleId: 'player-dash',
      name: 'Dash Trail',
      rootEntityId: 'trail',
      entities: [{ schema: 'LillyEntity/v1', id: 'trail', name: 'Dash Trail', parentId: null, enabled: true, tags: ['fx'], components: [] }],
    }),
    source('modules/dash/dash.spec.json', {
      schema: MECHANIC_TEST_SCHEMA,
      id: 'dash-fires-on-input',
      moduleId: 'player-dash',
      name: 'Dash fires once and starts cooldown',
      seed: 42,
      steps: [{ event: 'fixed-update', delta: 1 / 60, input: { buttons: { Dash: true }, axes: { Move: { x: 1, y: 0 } } }, world: { playerId: 'player', entities: [{ id: 'player', tags: ['player'] }] } }],
      assertions: [
        { path: 'actions[0].type', operator: 'equals', value: 'physics.impulse' },
        { path: 'actions[1].type', operator: 'equals', value: 'events.emit' },
        { path: 'systems.player-dash.state.cooldown', operator: 'equals', value: 0.75 },
      ],
    }),
  ];
}

describe('Lilly agent-authored module architecture', () => {
  test('compiles a typed multi-file mechanic package and resolves its dependency graph', () => {
    const bundle = compileModuleBundle(dashModuleFiles());
    expect(bundle.schema).toBe(MODULE_BUNDLE_SCHEMA);
    expect(bundle.diagnostics).toEqual([]);
    expect(bundle.loadOrder).toEqual(['player-dash']);
    expect(bundle.systems).toEqual([expect.objectContaining({ moduleId: 'player-dash', path: 'modules/dash/dash.system.ts' })]);
    expect(bundle.systems[0].code).toContain('globalThis.Lilly.registerSystem');
    expect(bundle.mechanics[0]).toMatchObject({ id: 'player-dash', inputs: ['Dash', 'Move'] });
    expect(bundle.prefabs[0]).toMatchObject({ id: 'dash-trail', rootEntityId: 'trail' });
  });

  test('registers and executes independently authored modules in dependency order', () => {
    const files = dashModuleFiles();
    const dashManifestFile = files.find((file) => file.kind === 'module-manifest');
    const dashManifest = JSON.parse(dashManifestFile.content);
    dashManifest.dependencies = ['event-observer'];
    dashManifestFile.content = JSON.stringify(dashManifest);
    files.push(
      source('modules/z-observer/observer.module.json', {
        schema: GAME_MODULE_SCHEMA,
        id: 'event-observer',
        name: 'Event Observer',
        version: '1.0.0',
        dependencies: [],
        capabilities: ['hud.write'],
        systems: ['./observer.system.ts'],
        mechanics: [],
        prefabs: [],
        tests: [],
      }),
      source('modules/z-observer/observer.system.ts', `import { defineSystem } from '@lilly/engine-runtime';
export default defineSystem({
  id: 'event-observer',
  onEvent(ctx) {
    if (ctx.event.name === 'dash.performed') ctx.hud.message('Observer saw the dash');
  },
});`),
    );
    const bundle = compileModuleBundle(files);
    expect(bundle.diagnostics).toEqual([]);
    expect(bundle.loadOrder).toEqual(['event-observer', 'player-dash']);
    expect(bundle.modules.map((module) => module.id)).toEqual(bundle.loadOrder);
    expect(bundle.systems.map((system) => system.moduleId)).toEqual(['event-observer', 'player-dash']);
    const run = runMechanicTests(bundle);
    expect(run.status).toBe('passed');
    expect(run.tests[0].result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'hud.message', moduleId: 'event-observer', text: 'Observer saw the dash' }),
    ]));
  });

  test('executes authored lifecycle code through declared capabilities and deterministic tests', () => {
    const bundle = compileModuleBundle(dashModuleFiles());
    const run = runMechanicTests(bundle);
    expect(run.status).toBe('passed');
    expect(run).toMatchObject({ passed: 1, failed: 0, tests: [{ id: 'dash-fires-on-input', status: 'passed' }] });
    expect(run.tests[0].result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'physics.impulse', entityId: 'player', value: { x: 8, y: 0, z: 0 } }),
      expect.objectContaining({ type: 'events.emit', name: 'dash.performed' }),
    ]));
  });

  test('rejects browser, network, nondeterministic random, and undeclared TypeScript APIs', () => {
    const files = dashModuleFiles();
    const system = files.find((file) => file.kind === 'system');
    system.content = `import { defineSystem } from '@lilly/engine-runtime';
export default defineSystem({
  id: 'unsafe',
  onStart() { fetch('/secret'); document.body.textContent = String(Math.random()); },
});`;
    const bundle = compileModuleBundle(files);
    expect(bundle.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GLOBAL_NOT_ALLOWED', path: system.path, severity: 'error' }),
      expect.objectContaining({ code: 'NONDETERMINISTIC_RANDOM', path: system.path, severity: 'error' }),
    ]));
    expect(bundle.systems).toHaveLength(0);
  });

  test('rejects computed and destructured prototype escape paths', () => {
    const files = dashModuleFiles();
    const system = files.find((file) => file.kind === 'system');
    system.content = `import { defineSystem } from '@lilly/engine-runtime';
export default defineSystem({
  id: 'unsafe-prototype',
  onStart(ctx) {
    const direct = ctx.state['constructor'];
    const { constructor: extracted } = function sample() {};
    ctx.state.value = Boolean(direct || extracted);
  },
});`;
    const bundle = compileModuleBundle(files);
    expect(bundle.systems).toHaveLength(0);
    expect(bundle.diagnostics.filter((entry) => entry.code === 'PROTOTYPE_ACCESS_NOT_ALLOWED')).toHaveLength(2);
  });

  test('fails a module that references missing files or dependencies', () => {
    const files = dashModuleFiles();
    const manifestFile = files.find((file) => file.kind === 'module-manifest');
    const manifest = JSON.parse(manifestFile.content);
    manifest.dependencies = ['inventory-core'];
    manifest.systems.push('./missing.system.ts');
    manifestFile.content = JSON.stringify(manifest);
    const bundle = compileModuleBundle(files);
    expect(bundle.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MODULE_DEPENDENCY_MISSING' }),
      expect.objectContaining({ code: 'MODULE_FILE_MISSING' }),
    ]));
  });

  test('enforces capability declarations while executing a mechanic test', () => {
    const files = dashModuleFiles();
    const manifestFile = files.find((file) => file.kind === 'module-manifest');
    const manifest = JSON.parse(manifestFile.content);
    manifest.capabilities = ['input.read', 'events.emit', 'hud.write'];
    manifestFile.content = JSON.stringify(manifest);
    const run = runMechanicTests(compileModuleBundle(files));
    expect(run.status).toBe('failed');
    expect(run.tests[0].error).toMatchObject({ code: 'SCRIPT_CAPABILITY_DENIED' });
  });

  test('terminates a mechanic handler that exceeds its execution budget', () => {
    const files = dashModuleFiles();
    const system = files.find((file) => file.kind === 'system');
    system.content = `import { defineSystem } from '@lilly/engine-runtime';
export default defineSystem({ id: 'runaway', onFixedUpdate() { while (true) {} } });`;
    const run = runMechanicTests(compileModuleBundle(files), { executionBudgetMs: 5 });
    expect(run.status).toBe('failed');
    expect(run.tests[0].error).toMatchObject({ code: 'SCRIPT_EXECUTION_TIMEOUT' });
  });
});

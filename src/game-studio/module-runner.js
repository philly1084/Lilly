'use strict';

const vm = require('node:vm');

const HANDLER_BY_EVENT = Object.freeze({
  start: 'onStart',
  'fixed-update': 'onFixedUpdate',
  input: 'onInput',
  event: 'onEvent',
  collision: 'onCollision',
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function seededRandom(seed = 1) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function createLoadedRuntime(bundle, options = {}) {
  const registrations = [];
  const logs = [];
  const sandbox = vm.createContext({
    Lilly: Object.freeze({
      defineSystem(definition) {
        if (!definition || typeof definition !== 'object' || typeof definition.id !== 'string') throw new Error('defineSystem requires a stable string id');
        return definition;
      },
      registerSystem(registration) {
        registrations.push(registration);
      },
    }),
    console: Object.freeze({
      log: (...values) => logs.push({ level: 'log', values: clone(values) }),
      warn: (...values) => logs.push({ level: 'warn', values: clone(values) }),
      error: (...values) => logs.push({ level: 'error', values: clone(values) }),
    }),
  }, {
    name: 'LillyMechanicTestSandbox',
    codeGeneration: { strings: false, wasm: false },
  });
  for (const system of bundle.systems || []) {
    const script = new vm.Script(system.code, { filename: system.path, displayErrors: true });
    script.runInContext(sandbox, { timeout: options.compileBudgetMs || 40, displayErrors: true });
  }
  const manifests = new Map((bundle.modules || []).map((module) => [module.id, module]));
  const systems = registrations.map((registration) => {
    const manifest = manifests.get(registration.moduleId);
    if (!manifest) throw Object.assign(new Error(`System ${registration.path} registered unknown module ${registration.moduleId}`), { code: 'MODULE_REGISTRATION_INVALID' });
    return {
      moduleId: registration.moduleId,
      path: registration.path,
      definition: registration.definition,
      capabilities: new Set(manifest.capabilities || []),
      state: clone(registration.definition.state || {}),
    };
  });
  return { sandbox, systems, logs };
}

function worldEntities(world) {
  return Array.isArray(world?.entities) ? world.entities : [];
}

function createSystemContext(runtime, system, step, frame, elapsed, actions, saves, random) {
  const requireCapability = (capability) => {
    if (!system.capabilities.has(capability)) {
      const error = new Error(`System ${system.definition.id} requires undeclared capability ${capability}`);
      error.code = 'SCRIPT_CAPABILITY_DENIED';
      throw error;
    }
  };
  const action = (capability, type, payload = {}) => {
    requireCapability(capability);
    actions.push({ type, systemId: system.definition.id, moduleId: system.moduleId, ...clone(payload) });
  };
  const world = clone(step.world || { playerId: 'player', entities: [] });
  if (!world.playerId) world.playerId = 'player';
  if (!Array.isArray(world.entities)) world.entities = [];
  const context = {
    delta: Number(step.delta || 0),
    frame,
    elapsed,
    state: system.state,
    world,
    input: {
      button(name) { requireCapability('input.read'); return step.input?.buttons?.[name] === true; },
      axis2d(name) { requireCapability('input.read'); return clone(step.input?.axes?.[name] || { x: 0, y: 0 }); },
    },
    random() { requireCapability('random.read'); return random(); },
    entities: {
      query(tag) { requireCapability('entity.query'); return worldEntities(world).filter((entity) => entity.tags?.includes(tag)).map((entity) => entity.id); },
      read(entityId) { requireCapability('entity.read'); return clone(worldEntities(world).find((entity) => entity.id === entityId) || null); },
      patch(entityId, component, values) { action('entity.write', 'entity.patch', { entityId, component, values }); },
      spawn(prefabId, spawnOptions = {}) { action('entity.spawn', 'entity.spawn', { prefabId, options: spawnOptions }); },
      destroy(entityId) { action('entity.destroy', 'entity.destroy', { entityId }); },
    },
    physics: {
      force(entityId, value) { action('physics.force', 'physics.force', { entityId, value }); },
      impulse(entityId, value) { action('physics.impulse', 'physics.impulse', { entityId, value }); },
      raycast(origin, direction, maxDistance) { action('physics.raycast', 'physics.raycast', { origin, direction, maxDistance }); },
    },
    events: { emit(name, payload = {}) { action('events.emit', 'events.emit', { name, payload }); } },
    hud: { message(text, messageOptions = {}) { action('hud.write', 'hud.message', { text: String(text), options: messageOptions }); } },
    audio: { play(assetId, audioOptions = {}) { action('audio.play', 'audio.play', { assetId, options: audioOptions }); } },
    particles: { emit(effectId, entityId = '') { action('particles.emit', 'particles.emit', { effectId, entityId }); } },
    save: {
      get(key) { requireCapability('save.read'); return clone(saves.get(String(key))); },
      set(key, value) { requireCapability('save.write'); saves.set(String(key), clone(value)); actions.push({ type: 'save.set', systemId: system.definition.id, moduleId: system.moduleId, key: String(key), value: clone(value) }); },
    },
  };
  if (step.event === 'event') context.event = clone(step.payload || {});
  if (step.event === 'collision') context.collision = clone(step.payload || {});
  return context;
}

function invokeHandler(runtime, handler, context, timeoutMs) {
  runtime.sandbox.__lillyHandler = handler;
  runtime.sandbox.__lillyContext = context;
  try {
    try {
      new vm.Script('__lillyHandler(__lillyContext)', { filename: 'lilly-system-dispatch.js' })
        .runInContext(runtime.sandbox, { timeout: timeoutMs, displayErrors: true });
    } catch (error) {
      if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') error.code = 'SCRIPT_EXECUTION_TIMEOUT';
      throw error;
    }
  } finally {
    delete runtime.sandbox.__lillyHandler;
    delete runtime.sandbox.__lillyContext;
  }
}

function getPath(value, path) {
  const segments = String(path || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  return segments.reduce((current, segment) => current == null ? undefined : current[segment], value);
}

function evaluateAssertion(result, assertion) {
  const actual = getPath(result, assertion.path);
  switch (assertion.operator) {
    case 'equals': return JSON.stringify(actual) === JSON.stringify(assertion.value);
    case 'not-equals': return JSON.stringify(actual) !== JSON.stringify(assertion.value);
    case 'truthy': return Boolean(actual);
    case 'falsy': return !actual;
    case 'gte': return Number(actual) >= Number(assertion.value);
    case 'lte': return Number(actual) <= Number(assertion.value);
    case 'includes': return typeof actual?.includes === 'function' && actual.includes(assertion.value);
    case 'length': return Number(actual?.length) === Number(assertion.value);
    default: return false;
  }
}

function runSingleTest(bundle, test, options = {}) {
  const runtime = createLoadedRuntime(bundle, options);
  const actions = [];
  const saves = new Map();
  const random = seededRandom(test.seed || 1);
  const timeoutMs = Math.max(1, Math.min(Number(options.executionBudgetMs) || 20, 100));
  let frame = 0;
  let elapsed = 0;
  try {
    for (const rawStep of test.steps || []) {
      const step = clone(rawStep);
      const handlerName = HANDLER_BY_EVENT[step.event];
      if (!handlerName) throw new Error(`Unknown mechanic test event ${step.event}`);
      frame += step.event === 'fixed-update' ? 1 : 0;
      elapsed += Number(step.delta || 0);
      const actionStart = actions.length;
      for (const system of runtime.systems) {
        const handler = system.definition[handlerName];
        if (typeof handler !== 'function') continue;
        const context = createSystemContext(runtime, system, step, frame, elapsed, actions, saves, random);
        invokeHandler(runtime, handler, context, timeoutMs);
      }
      let eventCursor = actionStart;
      let emitted = 0;
      while (eventCursor < actions.length && emitted < 64) {
        const emittedAction = actions[eventCursor];
        eventCursor += 1;
        if (emittedAction.type !== 'events.emit') continue;
        emitted += 1;
        const eventStep = { ...step, event: 'event', payload: { name: emittedAction.name, payload: emittedAction.payload } };
        for (const system of runtime.systems) {
          if (typeof system.definition.onEvent !== 'function') continue;
          const context = createSystemContext(runtime, system, eventStep, frame, elapsed, actions, saves, random);
          invokeHandler(runtime, system.definition.onEvent, context, timeoutMs);
        }
      }
      if (emitted >= 64) throw Object.assign(new Error('Mechanic event recursion exceeded 64 events'), { code: 'MECHANIC_EVENT_RECURSION' });
    }
    const result = {
      actions: clone(actions),
      systems: Object.fromEntries(runtime.systems.map((system) => [system.definition.id, { moduleId: system.moduleId, state: clone(system.state) }])),
      saves: Object.fromEntries([...saves.entries()]),
      logs: clone(runtime.logs),
      frame,
      elapsed,
    };
    const assertions = (test.assertions || []).map((assertion) => {
      const actual = clone(getPath(result, assertion.path));
      return { ...assertion, actual, passed: evaluateAssertion(result, assertion) };
    });
    return {
      id: test.id,
      name: test.name,
      moduleId: test.moduleId,
      status: assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed',
      assertions,
      result,
    };
  } catch (error) {
    return {
      id: test.id,
      name: test.name,
      moduleId: test.moduleId,
      status: 'failed',
      assertions: [],
      error: { code: error.code || 'MECHANIC_TEST_ERROR', message: error.message },
      result: { actions: clone(actions), frame, elapsed },
    };
  }
}

function runMechanicTests(bundle, options = {}) {
  const selected = new Set(Array.isArray(options.testIds) ? options.testIds : []);
  const tests = (bundle.tests || []).filter((test) => selected.size === 0 || selected.has(test.id));
  const results = tests.map((test) => runSingleTest(bundle, test, options));
  return {
    schema: 'LillyMechanicTestRun/v1',
    sourceHash: bundle.sourceHash,
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    tests: results,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
  };
}

module.exports = {
  createLoadedRuntime,
  runMechanicTests,
  runSingleTest,
};

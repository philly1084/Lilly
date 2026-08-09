'use strict';

(function startLillyModuleSandbox() {
  const bundle = globalThis.__LILLY_MODULE_BUNDLE__;
  const parentOrigin = '*';
  const executionBudgetMs = 200;
  const pending = new Map();
  let ready = false;

  function workerPrepare(runtimeBundle) {
    'use strict';
    const functionPrototype = Object.getPrototypeOf(function lillySandboxFunction() {});
    try { Object.defineProperty(functionPrototype, 'constructor', { value: undefined, configurable: false, writable: false }); } catch (_error) {}
    const denied = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'caches', 'indexedDB', 'WebAssembly', 'Reflect', 'Proxy', 'Function', 'eval'];
    for (const name of denied) {
      try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch (_error) {}
    }
    globalThis.__lillyBundle = runtimeBundle;
    globalThis.__lillyRegistrations = [];
    globalThis.Lilly = Object.freeze({
      defineSystem(definition) {
        if (!definition || typeof definition !== 'object' || typeof definition.id !== 'string') throw new Error('defineSystem requires a stable string id');
        return definition;
      },
      registerSystem(registration) {
        globalThis.__lillyRegistrations.push(registration);
      },
    });
  }

  function workerStart() {
    'use strict';
    const runtimeBundle = globalThis.__lillyBundle;
    const manifests = new Map((runtimeBundle.modules || []).map((module) => [module.id, module]));
    const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    let frame = 0;
    let elapsed = 0;
    let randomState = 1;
    const saves = new Map();
    const systems = globalThis.__lillyRegistrations.map((registration) => {
      const manifest = manifests.get(registration.moduleId);
      if (!manifest) throw new Error(`System ${registration.path} registered missing module ${registration.moduleId}`);
      const initialState = clone(registration.definition.state || {});
      return {
        moduleId: registration.moduleId,
        path: registration.path,
        definition: registration.definition,
        capabilities: new Set(manifest.capabilities || []),
        initialState,
        state: clone(initialState),
      };
    });
    delete globalThis.__lillyBundle;
    delete globalThis.__lillyRegistrations;
    delete globalThis.Lilly;

    function random() {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 0x100000000;
    }

    function makeContext(system, message, actions) {
      const payload = message.payload || {};
      const world = clone(payload.world || { playerId: 'player', entities: [] });
      if (!Array.isArray(world.entities)) world.entities = [];
      if (!Array.isArray(world.dataAssets)) world.dataAssets = [];
      const input = payload.input || {};
      const requireCapability = (capability) => {
        if (!system.capabilities.has(capability)) {
          const error = new Error(`System ${system.definition.id} requires undeclared capability ${capability}`);
          error.code = 'SCRIPT_CAPABILITY_DENIED';
          throw error;
        }
      };
      const action = (capability, type, values = {}) => {
        requireCapability(capability);
        if (actions.length >= 512) throw new Error('A module dispatch is limited to 512 capability actions');
        actions.push({ type, systemId: system.definition.id, moduleId: system.moduleId, ...clone(values) });
      };
      const context = {
        delta: Number(payload.delta || 0),
        frame,
        elapsed,
        state: system.state,
        world,
        input: {
          button(name) { requireCapability('input.read'); return input.buttons?.[name] === true; },
          axis2d(name) { requireCapability('input.read'); return clone(input.axes?.[name] || { x: 0, y: 0 }); },
        },
        data: {
          get(assetId) {
            requireCapability('data.read');
            return clone(world.dataAssets.find((asset) => asset.id === String(assetId))?.data || null);
          },
        },
        random() { requireCapability('random.read'); return random(); },
        entities: {
          query(tag) { requireCapability('entity.query'); return (world.entities || []).filter((entity) => entity.tags?.includes(tag)).map((entity) => entity.id); },
          read(entityId) { requireCapability('entity.read'); return clone((world.entities || []).find((entity) => entity.id === entityId) || null); },
          patch(entityId, component, values) { action('entity.write', 'entity.patch', { entityId, component, values }); },
          spawn(prefabId, options = {}) { action('entity.spawn', 'entity.spawn', { prefabId, options }); },
          destroy(entityId) { action('entity.destroy', 'entity.destroy', { entityId }); },
        },
        physics: {
          force(entityId, value) { action('physics.force', 'physics.force', { entityId, value }); },
          impulse(entityId, value) { action('physics.impulse', 'physics.impulse', { entityId, value }); },
          raycast(origin, direction, maxDistance) { action('physics.raycast', 'physics.raycast', { origin, direction, maxDistance }); },
        },
        events: { emit(name, eventPayload = {}) { action('events.emit', 'events.emit', { name, payload: eventPayload }); } },
        hud: { message(text, options = {}) { action('hud.write', 'hud.message', { text: String(text), options }); } },
        audio: { play(assetId, options = {}) { action('audio.play', 'audio.play', { assetId, options }); } },
        particles: { emit(effectId, entityId = '') { action('particles.emit', 'particles.emit', { effectId, entityId }); } },
        save: {
          get(key) { requireCapability('save.read'); return clone(saves.get(String(key))); },
          set(key, value) { requireCapability('save.write'); saves.set(String(key), clone(value)); actions.push({ type: 'save.set', systemId: system.definition.id, moduleId: system.moduleId, key: String(key), value: clone(value) }); },
        },
      };
      if (message.event === 'event') context.event = clone(payload.event || {});
      if (message.event === 'collision') context.collision = clone(payload.collision || {});
      return context;
    }

    function dispatch(message) {
      const handlers = { start: 'onStart', 'fixed-update': 'onFixedUpdate', input: 'onInput', event: 'onEvent', collision: 'onCollision' };
      const handlerName = handlers[message.event];
      if (!handlerName) throw new Error(`Unknown module event ${message.event}`);
      const delta = Number(message.payload?.delta || 0);
      if (message.event === 'fixed-update') frame += 1;
      elapsed += delta;
      const actions = [];
      for (const system of systems) {
        const handler = system.definition[handlerName];
        if (typeof handler === 'function') handler(makeContext(system, message, actions));
      }
      let cursor = 0;
      let emitted = 0;
      while (cursor < actions.length && emitted < 64) {
        const action = actions[cursor++];
        if (action.type !== 'events.emit') continue;
        emitted += 1;
        for (const system of systems) {
          if (typeof system.definition.onEvent !== 'function') continue;
          system.definition.onEvent(makeContext(system, {
            ...message,
            event: 'event',
            payload: { ...message.payload, event: { name: action.name, payload: action.payload } },
          }, actions));
        }
      }
      if (emitted >= 64) throw new Error('Module event recursion exceeded 64 events');
      return {
        actions,
        frame,
        elapsed,
        states: Object.fromEntries(systems.map((system) => [system.definition.id, clone(system.state)])),
        saves: Object.fromEntries(saves.entries()),
      };
    }

    self.onmessage = (event) => {
      const message = event.data;
      if (!message || message.schema !== 'LillyModuleWorkerMessage/v1') return;
      try {
        if (message.type === 'reset') {
          for (const system of systems) system.state = clone(system.initialState);
          saves.clear();
          frame = 0;
          elapsed = 0;
          randomState = 1;
          self.postMessage({ schema: 'LillyModuleWorkerResult/v1', type: 'result', requestId: message.requestId, result: { actions: [], frame, elapsed, states: Object.fromEntries(systems.map((system) => [system.definition.id, clone(system.state)])), saves: {} } });
          return;
        }
        if (message.type === 'restore') {
          for (const system of systems) if (message.states?.[system.definition.id]) system.state = clone(message.states[system.definition.id]);
          for (const [key, value] of Object.entries(message.saves || {})) saves.set(key, clone(value));
          self.postMessage({ schema: 'LillyModuleWorkerResult/v1', type: 'result', requestId: message.requestId, result: { actions: [], frame, elapsed, states: clone(message.states || {}), saves: clone(message.saves || {}) } });
          return;
        }
        const result = dispatch(message);
        self.postMessage({ schema: 'LillyModuleWorkerResult/v1', type: 'result', requestId: message.requestId, result });
      } catch (error) {
        self.postMessage({ schema: 'LillyModuleWorkerResult/v1', type: 'error', requestId: message.requestId, error: { code: error.code || 'MODULE_RUNTIME_ERROR', message: error.message, stack: String(error.stack || '').slice(0, 4000) } });
      }
    };
    self.postMessage({ schema: 'LillyModuleWorkerResult/v1', type: 'ready', systems: systems.map((system) => ({ moduleId: system.moduleId, id: system.definition.id, path: system.path })) });
  }

  if (!bundle || bundle.schema !== 'LillyModuleBundle/v1') {
    parent.postMessage({ schema: 'LillyModuleSandboxResult/v1', type: 'error', error: { code: 'MODULE_BUNDLE_MISSING', message: 'The immutable build has no valid module bundle' } }, parentOrigin);
    return;
  }
  const runtimeBundle = { ...bundle, systems: (bundle.systems || []).map(({ code, ...system }) => system) };
  const workerSource = [
    `(${workerPrepare.toString()})(${JSON.stringify(runtimeBundle)});`,
    ...(bundle.systems || []).map((system) => system.code),
    `(${workerStart.toString()})();`,
  ].join('\n');
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl, { name: 'lilly-game-modules' });
  const initializationTimeout = setTimeout(() => {
    worker.terminate();
    parent.postMessage({ schema: 'LillyModuleSandboxResult/v1', type: 'error', error: { code: 'MODULE_INITIALIZATION_TIMEOUT', message: 'Agent modules exceeded the initialization budget' } }, parentOrigin);
  }, 500);

  worker.onmessage = (event) => {
    const message = event.data;
    if (!message || message.schema !== 'LillyModuleWorkerResult/v1') return;
    if (message.type === 'ready') {
      ready = true;
      clearTimeout(initializationTimeout);
      URL.revokeObjectURL(workerUrl);
      parent.postMessage({ schema: 'LillyModuleSandboxResult/v1', type: 'ready', systems: message.systems, sourceHash: bundle.sourceHash }, parentOrigin);
      return;
    }
    const timer = pending.get(message.requestId);
    if (timer) clearTimeout(timer);
    pending.delete(message.requestId);
    parent.postMessage({ ...message, schema: 'LillyModuleSandboxResult/v1' }, parentOrigin);
  };
  worker.onerror = (event) => {
    clearTimeout(initializationTimeout);
    parent.postMessage({ schema: 'LillyModuleSandboxResult/v1', type: 'error', error: { code: 'MODULE_WORKER_ERROR', message: event.message || 'Agent module worker failed' } }, parentOrigin);
  };

  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!ready || !message || message.schema !== 'LillyModuleSandboxMessage/v1') return;
    const requestId = String(message.requestId || '');
    const timer = setTimeout(() => {
      pending.delete(requestId);
      worker.terminate();
      ready = false;
      parent.postMessage({ schema: 'LillyModuleSandboxResult/v1', type: 'error', requestId, error: { code: 'MODULE_EXECUTION_TIMEOUT', message: `Agent module dispatch exceeded the ${executionBudgetMs} ms safety budget and was terminated` } }, parentOrigin);
    }, executionBudgetMs);
    pending.set(requestId, timer);
    worker.postMessage({ ...message, schema: 'LillyModuleWorkerMessage/v1' });
  });
})();

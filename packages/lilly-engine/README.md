# Lilly Engine

Lilly Engine is the browser-native game runtime used by Lilly Game Studio. Three.js is a rendering adapter; saved projects contain only versioned Lilly data. Rapier is a physics adapter; Blueprint graphs compile to Lilly Graph IR before execution.

Package boundaries:

- `core` owns entities, components, hierarchy, commands, fixed-step simulation, input, history, and serialization.
- `renderer-three` projects Lilly scene data into transient Three.js objects.
- `physics-rapier` synchronizes Lilly physics components through a fixed-step Rapier world.
- `blueprints` validates typed graphs and compiles them to `LillyGraphIR/v1`.
- `gameplay` owns deterministic combat encounters, enemy state machines, gates, checkpoints, respawn, and stable-ID save replay. The editor and exported player compile this same source.
- `modules` owns the agent programming architecture: versioned source files, module manifests, typed system compilation, dependency resolution, mechanic/prefab/spec contracts, capability validation, and deterministic source hashes.
- `runtime` coordinates simulation, rendering, physics, saves, HUD events, and error reporting.

Agent-authored gameplay is split into focused files rather than one generated script. `.system.ts` files execute in a disposable Worker inside an opaque-origin iframe. They can use only capabilities declared by their owning `.module.json`; browser globals, network, DOM, storage, dynamic imports, async work, unseeded random, and wall-clock time are rejected before a build. `.spec.json` files execute the same lifecycle API inside a bounded Node VM during playtests.

Build with `npm run build:lilly-engine` from the repository root. The build emits CommonJS engine modules for Lilly's backend tests plus a dependency-free ESM gameplay module for immutable browser builds.

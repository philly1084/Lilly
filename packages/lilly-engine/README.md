# Lilly Engine

Lilly Engine is the browser-native game runtime used by Lilly Game Studio. Three.js is a rendering adapter; saved projects contain only versioned Lilly data. Rapier is a physics adapter; Blueprint graphs compile to Lilly Graph IR before execution.

Package boundaries:

- `core` owns entities, components, hierarchy, commands, fixed-step simulation, input, history, and serialization.
- `renderer-three` projects Lilly scene data into transient Three.js objects.
- `physics-rapier` synchronizes Lilly physics components through a fixed-step Rapier world.
- `blueprints` validates typed graphs and compiles them to `LillyGraphIR/v1`.
- `runtime` coordinates simulation, rendering, physics, saves, HUD events, and error reporting.

Build with `npm run build:lilly-engine` from the repository root.

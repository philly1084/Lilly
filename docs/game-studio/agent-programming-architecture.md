# Lilly Game Studio agent programming architecture

Lilly projects are programs, not generated level presets. An outside agent builds a game by composing versioned data contracts and typed systems through revision-safe APIs. Three.js is a renderer adapter and never becomes project state.

## Source tree

```text
modules/
  traversal/
    traversal.module.json       LillyGameModule/v1
    dash.mechanic.json          LillyMechanic/v1
    dash.system.ts              defineSystem lifecycle code
    dash-trail.prefab.json      LillyPrefab/v1
    dash.spec.json              LillyMechanicTest/v1
  inventory/
    inventory.module.json
    inventory.mechanic.json
    inventory.system.ts
    pickup.prefab.json
    inventory.spec.json
scenes/
  main.scene.json               LillyScene/v1 interchange
blueprints/
  win-condition.blueprint.json  LillyBlueprint/v1 interchange
data/
  balance.json                  game-owned JSON data
```

One module should own one cohesive gameplay domain: traversal, combat, inventory, quests, dialogue, camera, abilities, spawning, scoring, or a similarly reviewable slice. Dependencies are module ids, never arbitrary npm packages.

## Module manifest

```json
{
  "schema": "LillyGameModule/v1",
  "id": "player-traversal",
  "name": "Player Traversal",
  "version": "1.0.0",
  "dependencies": [],
  "capabilities": ["input.read", "physics.impulse", "events.emit"],
  "systems": ["./dash.system.ts"],
  "mechanics": ["./dash.mechanic.json"],
  "prefabs": ["./dash-trail.prefab.json"],
  "tests": ["./dash.spec.json"]
}
```

The compiler resolves dependencies as a directed acyclic graph. Missing modules, missing files, dependency cycles, duplicate ids, unsupported versions, and undeclared capabilities block a build.

## Typed systems

```ts
import { defineSystem } from '@lilly/engine-runtime';

export default defineSystem({
  id: 'player-dash',
  state: { cooldown: 0 },
  onFixedUpdate(ctx) {
    ctx.state.cooldown = Math.max(0, ctx.state.cooldown - ctx.delta);
    if (!ctx.input.button('Dash') || ctx.state.cooldown > 0) return;
    const move = ctx.input.axis2d('Move');
    ctx.physics.impulse(ctx.world.playerId, { x: move.x * 8, y: 0, z: move.y * 8 });
    ctx.events.emit('dash.performed', { entityId: ctx.world.playerId });
    ctx.state.cooldown = 0.75;
  },
});
```

Supported lifecycle hooks are `onStart`, `onFixedUpdate`, `onInput`, `onEvent`, and `onCollision`. Systems may use normal synchronous TypeScript, local functions, loops, typed state, deterministic random, entity queries, and capability calls.

`onCollision` receives the actual fixed-step world transition, not a UI approximation: `{ type: "collision" | "trigger", phase: "start" | "end", entityA, entityB, tagsA, tagsB, positionA, positionB }`. The immutable browser player tracks active pairs so start/end edges fire once, preserves collision events while a sandbox dispatch is in flight, and routes sensor pairs as triggers. The Rapier adapter exposes the same collision-versus-trigger distinction.

System files import only `@lilly/engine-runtime`. The compiler rejects browser globals, DOM, network, direct storage, dynamic imports, async work, prototype escape paths, `Date`, `performance`, `crypto`, timers, and `Math.random`. Use `ctx.random()` and fixed-step time for replay-safe behavior.

At runtime, compiled systems execute in a disposable Worker created inside an opaque-origin sandboxed iframe. A strict content security policy denies network and external resources. A dispatch that does not return within a 200 ms wall-clock safety budget terminates the Worker; normal deterministic specs use a tighter configurable CPU budget. The parent applies only validated capability actions.

## Mechanics, prefabs, and tests

`LillyMechanic/v1` describes the public shape of a game feature: its player verbs, input actions, emitted events, composing systems, and custom state field schemas. This makes a mechanic inspectable without reading its implementation.

`LillyPrefab/v1` stores a reusable Lilly entity hierarchy. Agents instantiate it through `prefab.instantiate`; Lilly prefixes stable entity ids with the requested instance id and records one undoable command. The optional instance config is intentionally narrow: `position` translates the root `Transform`, and `entities[sourceEntityId]` may replace `name`, `enabled`, or `tags` and deeply merge data into an existing component. Lilly rejects unknown source ids, undeclared components, invalid component results, hierarchy defects, ambiguous prefab ids/paths, and prototype escape keys before modifying a scene.

```json
{
  "position": { "x": 4, "y": 0, "z": -2 },
  "entities": {
    "trail": {
      "name": "Player Dash Trail",
      "components": {
        "MeshRenderer": { "material": { "color": "#ff4fd8" } }
      }
    }
  }
}
```

`LillyMechanicTest/v1` sends deterministic lifecycle events and asserts against capability actions or system state:

```json
{
  "schema": "LillyMechanicTest/v1",
  "id": "dash-fires-on-input",
  "moduleId": "player-traversal",
  "name": "Dash fires once and starts cooldown",
  "seed": 42,
  "steps": [
    {
      "event": "fixed-update",
      "delta": 0.0166666667,
      "input": { "buttons": { "Dash": true }, "axes": { "Move": { "x": 1, "y": 0 } } },
      "world": { "playerId": "player", "entities": [{ "id": "player", "tags": ["player"] }] }
    }
  ],
  "assertions": [
    { "path": "actions[0].type", "operator": "equals", "value": "physics.impulse" },
    { "path": "systems.player-dash.state.cooldown", "operator": "equals", "value": 0.75 }
  ]
}
```

Specifications run in a bounded Node VM before immutable builds and use the same lifecycle/capability semantics as browser players.

## Outside-agent workflow

The unified `game-studio` tool exposes the entire authoring loop:

1. `create-project` with `template: "blank"`.
2. `list-files` and `inspect-project` to establish the current revision.
3. `write-files` with one atomic source batch and `baseRevision`.
4. `compile-project`; repair every error diagnostic.
5. `run-mechanic-tests`; repair failed specifications.
6. Use `apply-commands` for scenes, entities, components, Blueprints, input maps, and entry-scene selection.
7. Use `instantiate-prefab` for reusable entity composition.
8. `run-playtest`, `build`, and `publish` the exact tested revision.

Available source APIs mirror the tool at `/api/game-studio/projects/:id/files`, `/compile`, `/mechanic-tests`, and `/prefab-instances`. Every mutation participates in `LillyCommand/v1` auditing, revision conflicts, undo, rollback, and event streaming.

The editor requests `/api/game-studio/projects/:id/editor-preview` when entering Play. Lilly compiles and tests the exact saved revision, caches a revision-and-source-hash-addressed player workspace, and mounts its direct preview in a sandboxed opaque-origin iframe. Pause and Step are parent-to-player control messages; Step consumes exactly one fixed tick and stays paused. Source mutations invalidate the preview. This keeps editor Play behavior equal to private builds while durable builds remain immutable release records.

## Capability boundary

Capabilities are intentionally narrow and auditable:

- deterministic context: `clock.read`, `random.read`, `input.read`
- world data: `entity.query`, `entity.read`, `entity.write`, `entity.spawn`, `entity.destroy`
- simulation: `physics.force`, `physics.impulse`, `physics.raycast`
- orchestration: `events.emit`
- presentation: `hud.write`, `audio.play`, `particles.emit`
- persistence bridge: `save.read`, `save.write`

Adding a capability is an engine API change. Games cannot install build plugins, npm dependencies, filesystem adapters, or unrestricted browser APIs.

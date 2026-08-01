# Lilly Game Studio architecture

Lilly Game Studio is a browser-native game authoring system owned by Lilly. Three.js is a rendering dependency, Rapier is a physics dependency, and React Flow is an editor dependency; none of their object models are the saved project contract.

## Runtime boundaries

- `packages/lilly-engine/core` owns versioned projects, scenes, entities, components, fixed-step time, input actions, transactional commands, history, validation, and serialization.
- `packages/lilly-engine/blueprints` owns the typed node registry, connection rules, graph validation, `LillyGraphIR/v1` compilation, and bounded execution.
- `packages/lilly-engine/renderer-three` maps Lilly components into transient Three.js objects. Three objects are never serialized into project files.
- `packages/lilly-engine/physics-rapier` owns the deterministic Rapier WASM world and fixed-step physics adapter.
- `packages/lilly-engine/runtime` coordinates simulation, render, physics, graph execution, player errors, and the opaque-origin script policy.
- `src/game-studio` owns persistence, revision locks, API operations, playtests, immutable player bundles, and managed-app publication handoff.
- `frontend/game-studio` owns the desktop editor and narrow-screen play/review surface at `/game-studio`.

## Stable contracts

The first release persists `LillyProject/v1`, `LillyScene/v1`, `LillyEntity/v1`, `LillyBlueprint/v1`, `LillyCommand/v1`, and `LillyBuild/v1`. Blueprints compile to `LillyGraphIR/v1`; the player does not interpret React Flow state. Mutations are command batches applied atomically against `baseRevision`. A stale revision returns HTTP 409 and cannot overwrite a newer project.

The component registry starts with Transform, Camera, MeshRenderer, Light, RigidBody, Collider, AudioSource, Animator, Blueprint, Script, ParticleEmitter, and UIAnchor. Component validation and hierarchy-cycle checks run before a revision is committed.

## Persistence

Project source and immutable build files live below `${KIMIBUILT_DATA_DIR}/game-studio` on the existing persistent volume. PostgreSQL mirrors projects, revisions, builds, AI runs, and events when configured. The file-backed store remains a durable development fallback; production publishing requires PostgreSQL plus the managed-app/GitLab lane.

## Isolation

Draft builds run through the existing sandbox workspace route in nested iframes without `allow-same-origin`. Player scripts cannot access the Lilly DOM, cookies, credentials, filesystem, or unrestricted parent APIs. Static sandbox preview and sandbox-library reads allow the opaque `Origin: null`; all mutation and credential-bearing API routes continue to reject it.

Private player save/load uses the bounded `LillyPlayerStorage/v1` message contract. The parent accepts only the open project ID and a maximum 64 KiB JSON state. Published players use their own origin storage directly.

## Backend API and tool

Authenticated routes are mounted below `/api/game-studio` for projects, commands, AI runs, events, assets, playtests, builds, publish, and rollback. The unified `game-studio` tool exposes `inspect-project`, `inspect-scene`, `apply-commands`, `edit-blueprint`, `run-playtest`, `build`, `publish`, and `rollback`.

Durable game requests route to `game-studio`. Explicit disposable or throwaway prototypes remain on `code-sandbox`.

## V1 limits

V1 targets single-player 3D browser games on WebGL2. WebGPU is experimental and disabled by default. Networking, collaborative editing, 2D tilemaps, terrain sculpting, skeletal authoring, and arbitrary npm dependencies are intentionally outside this release.

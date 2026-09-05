# game-studio

Refinement: `generate-model` with `assetId` uses a saved generated model recipe as context. Preview the proposal, then `apply-ai-run` updates its scene instances to a new GLB while keeping the previous asset. Entity transforms and material overrides are retained; source prefab definitions remain unchanged. Missing source is an explicit error.

Environment creation: `generate-environment` accepts a prompt and connected model or an authored `LillyEnvironmentRecipe/v1`. It previews real scenery GLBs and native terrain, then `apply-ai-run` saves the models and replaces prior Lilly scenery with undo support. Read `docs/game-studio/environment-creator.md` for the recipe contract and limits.

3D creation: `generate-model` accepts `projectId`, `baseRevision`, `prompt`, and optional connected `model` (such as `gpt-6-astra`). Codex can instead supply an authored `LillyModelRecipe/v1` in `recipe` without a nested model request. The recipe compiles named primitive or custom triangle-mesh parts to a real GLB preview. Use `apply-ai-run` with `projectId` and returned `runId` to save the GLB, editable source and scene object after review; the original revision must still match. Then run playtest and build. This path creates static stylized geometry, not rigged or sculpted characters. See `docs/agent-grep/game-creator.md` for CLI and recipe details.

Use this tool for durable browser-game projects owned by Lilly Game Studio. Keep disposable sketches and one-off prototypes on `code-sandbox`.

Actions:

- `create-project` creates either a truly `blank` project for agent-led architecture or an `expedition` starter. `list-projects` discovers durable projects owned by the caller.
- `inspect-project` and `inspect-scene` read the saved Lilly contracts and validation state.
- `list-files` returns the project source tree and module diagnostics. `read-file` returns one exact source file.
- `list-assets` inventories uploaded project assets. `upload-asset` accepts one bounded canonical-Base64 GLB, glTF, texture, or audio file plus optional up-axis and unit metadata; binary content remains in the project asset workspace rather than source JSON. The AI tool JSON lane caps Base64 at 9,500,000 characters (about 6.8 MiB decoded) so it stays below the platform 10 MiB request envelope; the browser editor streams raw binary through its separate 8 MiB route.
- `write-files` transactionally upserts up to 100 project files against `baseRevision`; `delete-files` removes paths the same way. A stale revision never overwrites another agent's work.
- `compile-project` resolves module dependencies, validates JSON contracts, type-checks `.system.ts`, enforces the capability policy, and produces `LillyModuleBundle/v1` metadata.
- `run-mechanic-tests` executes project `.spec.json` files in a bounded Node VM using the same lifecycle and capability semantics as the player sandbox.
- `instantiate-prefab` expands a `.prefab.json` entity hierarchy into a scene with stable instance-prefixed IDs as one undoable command. Optional `config.variant` applies an authored prefab variant first, `config.position` translates the root, and `config.entities[sourceId]` can then override `name`, `enabled`, `tags`, or deeply merge data into existing components. Unknown variants/entities/components, invalid values, and unsafe structured keys are rejected.
- `generate-level` takes `projectId`, `baseRevision`, a plain-language `prompt`, and optional `seed`/`difficulty`. It returns a validated deterministic `LillyLevelRecipe/v1` proposal as a `level.generate` command without mutating the saved revision; review it, then use `apply-commands`.
- `apply-commands` requires `projectId`, `baseRevision`, and a `LillyCommand/v1` batch. A stale base revision fails; it never overwrites newer edits.
- `edit-blueprint` replaces one validated `LillyBlueprint/v1` graph.
- `run-playtest` validates the project, uploaded asset files, material/asset/animation/terrain references, control contract, Blueprint typing/Graph IR, module dependency graph, system compilation, capability policy, and every agent-authored mechanic specification.
- `build` creates an immutable tested browser-player artifact for the current revision.
- `publish` requires a successful `buildId` and promotes its exact files through the managed-app GitLab/k3s lane.
- `rollback` restores an earlier saved revision as a new auditable revision.

`level.generate` replaces the generated geometry for one scene transactionally while preserving hand-authored entities. The saved recipe produces deterministic rooms, paths, walls, hazards, pickups, landmarks, spawn, goal, reachability metadata, and a checksum; undo restores the prior generated level snapshot.

The tool does not accept Three.js objects as project state. Rendering objects are always transient. TypeScript components run only in opaque-origin player sandboxes with the Lilly capability allowlist.

Editor Play uses a revision-addressed `LillyEditorPreview/v1` generated by `POST /api/game-studio/projects/:id/editor-preview`. It is the exact browser player and module bundle—not a parallel React simulation—and stays inside a sandboxed iframe. The editor sends only bounded `play`, `pause`, and one-fixed-tick `step` control envelopes. A durable build remains a separate immutable, publishable artifact.

## Agent project architecture

Use multiple focused files instead of one generated script:

- `*.module.json` — `LillyGameModule/v1`; package id/version, dependencies, capability allowlist, and exported file paths.
- `*.mechanic.json` — `LillyMechanic/v1`; a player verb or game rule, its inputs/events, custom state schemas, and composing systems.
- `*.system.ts` — typed `defineSystem({...})` lifecycle code importing only `@lilly/engine-runtime`.
- `*.prefab.json` — `LillyPrefab/v1`; reusable entity hierarchies that can be instantiated transactionally.
- `*.spec.json` — `LillyMechanicTest/v1`; deterministic events and assertions executed before a build.
- `*.material.json` — `LillyMaterial/v1`; reusable standard, physical, toon, or unlit parameters plus uploaded texture slots.
- `*.asset.json` — `LillyAssetMetadata/v1`; explicit scale, pivot, shadows, collision proxy, LOD, and GLB animation aliases for an uploaded asset id.
- `*.animation.json` — `LillyAnimationController/v1`; named GLB clip states or deterministic spin, float, and pulse states.
- `*.terrain.json` — `LillyTerrain/v1`; a bounded normalized heightfield, size, resolution, height scale, material reference, and collision/walkable intent.
- `*.blueprint.json` and `*.scene.json` — visual-graph and scene interchange sources.

System code can calculate arbitrary gameplay rules using normal synchronous TypeScript, loops, functions, local state, entity queries, inputs, deterministic random, and capability calls. Browser globals, network, DOM, storage, dynamic imports, async work, `Date`, and `Math.random` are rejected. Declare every required engine capability in the owning module manifest.

Recommended outside-agent loop:

1. `create-project` with `template: "blank"`, or inspect an existing project.
2. `list-files` and `list-assets`, upload needed binaries, then author one module manifest plus focused mechanic/system/prefab/spec and world-resource files with `write-files`.
3. `compile-project`; fix every error diagnostic.
4. `run-mechanic-tests`; fix failed assertions.
5. Compose scenes/entities/input maps through `apply-commands` and `instantiate-prefab`.
6. `run-playtest`, `build`, then `publish` the tested immutable revision.

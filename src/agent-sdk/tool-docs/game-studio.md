# game-studio

Use this tool for durable browser-game projects owned by Lilly Game Studio. Keep disposable sketches and one-off prototypes on `code-sandbox`.

Actions:

- `inspect-project` and `inspect-scene` read the saved Lilly contracts and validation state.
- `generate-level` takes `projectId`, `baseRevision`, a plain-language `prompt`, and optional `seed`/`difficulty`. It returns a validated deterministic `LillyLevelRecipe/v1` proposal as a `level.generate` command without mutating the saved revision; review it, then use `apply-commands`.
- `apply-commands` requires `projectId`, `baseRevision`, and a `LillyCommand/v1` batch. A stale base revision fails; it never overwrites newer edits.
- `edit-blueprint` replaces one validated `LillyBlueprint/v1` graph.
- `run-playtest` validates the project, assets, control contract, Blueprint typing, and Graph IR compilation.
- `build` creates an immutable tested browser-player artifact for the current revision.
- `publish` requires a successful `buildId` and promotes its exact files through the managed-app GitLab/k3s lane.
- `rollback` restores an earlier saved revision as a new auditable revision.

`level.generate` replaces the generated geometry for one scene transactionally while preserving hand-authored entities. The saved recipe produces deterministic rooms, paths, walls, hazards, pickups, landmarks, spawn, goal, reachability metadata, and a checksum; undo restores the prior generated level snapshot.

The tool does not accept Three.js objects as project state. Rendering objects are always transient. TypeScript components run only in opaque-origin player sandboxes with the Lilly capability allowlist.

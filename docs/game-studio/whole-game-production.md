# Whole-game production

Lilly turns a brief into a reviewed game plan and an editable, tested browser game. In an empty studio, use **Design my game**. In an existing project, use **Create → Whole game**, or open `/game-studio/?create=game` directly. Opening the creator does not start model work. Each production creates a new project; it does not replace the game currently open in the editor.

There are two foundations. **Authored** starts with an empty project: agents create the world, camera, controllable player, input bindings and complete game rules in sandboxed TypeScript. **Expedition** uses connected rooms, checkpoints, hazards, optional guardians and an exit, adding generated art and custom mechanics. The director should preserve the requested genre and choose the fitting foundation. Current browser movement uses the native CharacterController; arbitrary engines, audio generation, multiplayer services and generated skeletal rigs are outside this release. This is not Unity feature parity or a promise to produce every genre.

## Design and build

The director produces `LillyGamePlan/v1`: player fantasy, art direction, core loop, win/loss, controls, acceptance checklist, deferred features, level/environment/gameplay briefs and up to six asset jobs. Review and edit the design before selecting **Build this game**. Deferred requests remain visible. The original brief and reviewed plan are durable; the plan is also saved in the game at `design/game-plan.json`.

Invalid director output receives one correction attempt before review. Scene and gameplay corrections name the rejected shape, operation or file path. Their latest generated responses are retained in the production directory, bounded to 256,000 characters, for diagnosis. Invalid commands are never applied. During building, active workers and the primary controls appear before the collapsed game design; the design opens for review.

The model team is selected from the connected model catalog. The director, level builder, scenery builder, model builders and gameplay programmer can use different model IDs. After design, expand **Choose a model for each asset** to assign specialists to individual models. No provider or generation name is required by the production protocol. Choose one to four parallel workers; the default is two. This controls concurrent art authors, not CPU threads or simultaneous scene writers. It may increase provider usage.

Execution dependencies are deliberately explicit:

1. The scene builder authors the original scene and controls from empty state, or the expedition level builder authors validated topology. Original scenes require a visible controlled player, primary camera, movement bindings and any planned asset placeholders. Invalid scenes receive one repair attempt.
2. Scenery and individual GLB model workers run concurrently against that saved world. Set `environmentPrompt: null` to omit outdoor scenery.
3. Assembly recompiles saved outputs against the current revision, applies them sequentially, and binds explicit `targetEntityId` placeholders, pickup/player meshes or landmarks. Missing explicit targets fail instead of silently placing the asset elsewhere.
4. The gameplay worker authors typed source, module manifests, input bindings and deterministic tests. Authored games require three distinct executable tests mapped by `coverage.win`, `coverage.loss` and `coverage.reset`; the module owns the full game loop and HUD. Compilation and tests must pass before application. It gets one repair attempt. These checks verify executable assertions, not whether self-authored tests fully capture the player's intent.
5. Project validation, mechanic tests and the engine playtest gate an immutable build. **Ready** means a saved player passed these automated checks. The human acceptance checklist remains visible; it is not marked passed by model prose.

## Durable work and ownership

`LillyGameProduction/v1` saves task states, attempts, model assignments, proposal IDs, original worker outputs, application checkpoints and sequenced activity. Polling the production endpoint provides independent worker progress; these are task activity streams, not private reasoning or token streams. The browser reconnects to saved state after closing or reloading.

Only the authenticated owner can inspect or control a production. A revision is required to start/resume the reviewed plan. The design is locked when building begins. Stop prevents new stages after active provider calls settle; it does not claim to cancel already submitted provider work. Retry retains completed outputs and can use a replacement model for unfinished work. Scene changes are guarded by the project revision. If someone edits the generated game during a build, automatic assembly stops and preserves those edits.

Worker leases use the shared production filesystem, a heartbeat, and fencing checks. A crashed worker is reported interrupted after 90 seconds and needs explicit resume. Deployments should retain the existing single backend writer and persistent data volume. The existing Game Studio project index is not a distributed transactional database; scaling backend replicas requires moving the index and leases into a transactional shared store first. Model concurrency does not require increasing backend replicas.

## Agent tools and CLI

The `game-studio` tool provides `production-capabilities`, `design-game`, `list-game-productions`, `inspect-game-production`, `start-game-production`, `resume-game-production`, and `stop-game-production`. Calls return immediately with a durable ID. Inspect until design review, start using the current production revision, and inspect until ready or attention is required. Starting production authorizes generation and assembly in its new project. Publishing remains a separate existing tool action.

```sh
lilly-game production-capabilities
lilly-game design-game --brief "A woodland treasure hunt with a magical dash" --models models.json --workers 3
lilly-game production --run PRODUCTION_ID
lilly-game production-start --run PRODUCTION_ID --revision N
lilly-game production-resume --run PRODUCTION_ID --revision N --models replacement-models.json
lilly-game production-stop --run PRODUCTION_ID
```

`models.json` maps `director`, `level`, `environment`, `asset`, and `gameplay` to connected IDs; empty IDs use the configured default. Codex or another external agent can submit a complete `LillyGamePlan/v1` with `--plan` instead of invoking the director. Existing model/environment recipe, file, prefab, command, test and build tools remain available for detailed follow-up work.

`--task-models task-models.json` overrides individual workers, for example `{"asset-beacon":"connected-artist-id","gameplay":"connected-programmer-id"}`. Allowed keys are `level`, `environment`, `gameplay` and `asset-<planned asset id>`. Omitting a key inherits the role model; an empty string explicitly uses the configured default. Overrides apply to unfinished work on resume. Earlier plans without `foundation` retain the expedition behavior.

`authored-game.test.js` exercises an original ordered-plate puzzle from a blank project, a real GLB bound to a named placeholder, win/loss/reset/timeout specs and an immutable browser build. Its deterministic author is a test fixture, not evidence of real-model generation. Live provider and public deployment validation must be recorded separately.

REST mirrors the tools at `/api/game-studio/production-capabilities`, `/productions`, `/productions/:id`, and `/productions/:id/start|resume|stop`. The capability manifest is versioned separately from plans and outputs. Future workers should add validated output adapters and advertise them there; do not infer support from a model's name, bypass revision checks, or substitute prose for an asset or passing test.

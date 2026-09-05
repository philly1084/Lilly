# Whole-game production

Lilly turns a brief into a reviewed game plan and an editable, tested browser game. In an empty studio, use **Design my game**. In an existing project, use **Create → Whole game**. Each production creates a new project; it does not replace the game currently open in the editor.

The current automated track is a third-person browser game with connected rooms, an objective, checkpoints, hazards, optional guardians, generated GLB art, terrain, and an original sandboxed TypeScript mechanic. It uses Lilly's tested player/camera/input scaffold. This is a practical game-building track, not Unity feature parity or a promise to produce every genre. Audio generation, multiplayer services and generated skeletal rigs are outside this release.

## Design and build

The director produces `LillyGamePlan/v1`: player fantasy, art direction, core loop, win/loss, controls, acceptance checklist, deferred features, level/environment/gameplay briefs and up to six asset jobs. Review and edit the design before selecting **Build this game**. Deferred requests remain visible. The original brief and reviewed plan are durable; the plan is also saved in the game at `design/game-plan.json`.

The model team is selected from the connected model catalog. The director, level builder, scenery builder, model builders and gameplay programmer can use different model IDs. No provider or generation name is required by the production protocol. Choose one to four parallel workers; the default is two. This controls concurrent art authors, not CPU threads or simultaneous scene writers. It may increase provider usage.

Execution dependencies are deliberately explicit:

1. The level builder authors validated topology using the shared design.
2. Scenery and individual GLB model workers run concurrently against that saved level.
3. Assembly recompiles saved outputs against the current revision, applies them sequentially, and binds planned pickup/player meshes or places landmarks.
4. The gameplay worker authors typed source, module manifests, input bindings and deterministic tests. Compilation and tests must pass before application. It gets one repair attempt.
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

REST mirrors the tools at `/api/game-studio/production-capabilities`, `/productions`, `/productions/:id`, and `/productions/:id/start|resume|stop`. The capability manifest is versioned separately from plans and outputs. Future workers should add validated output adapters and advertise them there; do not infer support from a model's name, bypass revision checks, or substitute prose for an asset or passing test.

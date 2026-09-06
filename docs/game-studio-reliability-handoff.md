# Game Studio reliability handoff — 2026-09-06

Purpose: correct the frontend review against live evidence and make temporary throttling recoverable without duplicating game or agent operations.

## Verified baseline

Production image at inspection: `ghcr.io/philly1084/lilly:sha-87f233a`.
Authenticated browser QA opened `/game-studio/` and `/agent-ops/` at desktop and mobile sizes. Both reports passed with no reported issues. Game Studio loaded Orbit Relay revision 8 with a scene hierarchy, 3D viewport, inspector, model assets, tests, and build controls. Authenticated APIs returned six projects and two productions. Unauthenticated page requests redirected to login. Health and readiness returned 200.

The reported 429 was not reproduced. The global application limiter covers `/api`, not HTML navigation. Agent Ops can poll an overview and four workspaces every 4.5 seconds, so multiple tabs can consume significant shared request capacity. This is a plausible contributor, not a proven diagnosis. A tool invocation count does not measure direct editor API use.

Baseline reports and screenshots are retained locally under `local/tmp/studio-reliability/ui-checks/reliability/studio-reliability-review/`; they are evidence of the inspected deployment, not proof that this patch is deployed.

## Changes

- Game Studio respects numeric and HTTP-date `Retry-After`, with a conservative 60-second fallback for missing or malformed values. A shared client cooldown suppresses further API calls until the retry window ends; errors preserve the loaded editor state and explain when to retry. Production polling waits for that window before reconnecting.
- Agent Ops pauses polling and repeated manual requests during the server retry window, retaining the last recorded workroom. Partial workspace throttling also displays a paused sync state.
- Build, publish, apply, and agent actions are never automatically replayed. Cooldowns are per browser page; this patch does not introduce a distributed queue or coordinate all tabs.
- Application 429 responses include a generated request ID, limiter scope, and retry delay. The same ID is returned in `X-Request-ID` and is available on Game Studio errors.
- Web Chat's menu, chat API, and artifact helpers require a saved explicit opt-in for automatic remote steps. Missing preferences and storage failures default off. Existing explicit opt-ins and direct user requests for remote tools remain supported.

## Validation

- 78 tests passed across security middleware, Game Studio API recovery, game production, Agent Ops, Web Chat API, and UI helpers.
- Web Chat index regression suite passed (included in an earlier 55-test run with Agent Ops).
- Game Studio TypeScript check passed.
- Engine server/browser TypeScript builds passed.
- Game Studio Vite production build passed; existing large-bundle warning remains (approximately 1.65 MB before gzip).
- Controlled 429 tests verify suppression, expiry and recovery, numeric/date/malformed headers, saved-state retention, correlation metadata, and no automatic mutation replay.

## Release and next work

This handoff accompanies a source patch. Production promotion still requires the normal build/publish and coordinated deployment workflow, followed by authenticated read-back and desktop/mobile checks of the resulting image. No live agent work or model benchmark was started for this review.

Use the existing Orbit Relay project as the starting demonstration instead of creating a duplicate app. The next product slice should explain the first-run path: design, review plan, select workers, start, inspect artifacts, playtest, then publish. Model comparisons should use the current runtime registry and measured latency, correctness, and usage; do not invent cost badges or assume the review's model names are available. A campus-style sample or mocked operations simulator can follow after this reliability patch is promoted.

# Prompt Optimization Hourly Backlog

This is a repo-local list for hourly automation passes. Each item is intended to be small enough for one local run: inspect the listed files, make one coherent improvement, run the focused checks, and leave a concise handoff.

## Automation Prompt

Use this as the recurring local automation prompt:

```text
Work through docs/prompt-optimization-hourly-backlog.md one unchecked item at a time.

For the first unchecked item:
1. Read the listed files and nearby tests.
2. Make the smallest repo-consistent prompt or prompt-routing improvement that satisfies the item.
3. Add or update focused tests when behavior is parseable or routeable.
4. Run the listed checks, or the closest focused checks available in this checkout.
5. Update this backlog item with status, files changed, checks run, and any blocker.

Do not do broad prompt rewrites. Do not start a second item in the same run unless the first item is complete and the second is a tiny documentation-only follow-up.
```

## Hourly Items

### [x] P1-001 Split Planner Prompt Into Policy Packs

Goal: Reduce instruction dilution in the application-owned planner by moving large topic-specific rules into composable policy packs.

Primary files:
- `src/conversation-orchestrator.js`
- `src/orchestration/agent-roles.js`
- `src/conversation-orchestrator.test.js`

Suggested shape:
- Add a helper such as `buildPlannerPolicyPacks({ toolPolicy, objective, instructions, executionProfile })`.
- Inject only relevant packs: `remote`, `frontend`, `document`, `notes`, `workload`, `research`, `asset-reuse`.
- Preserve existing behavior for candidate tool selection and hard safety rules.

Acceptance checks:
- Planner prompt still includes workload rules only when `agent-workload` is relevant.
- Remote/k3s/GitLab rules appear only for remote-capable plans.
- Frontend QA rules appear for website, dashboard, game, sandbox, or document-workflow frontend builds.

Focused checks:
- `npm test -- --runTestsByPath src/conversation-orchestrator.test.js`
- Add a small unit test for pack inclusion/exclusion if no existing assertion is close enough.

### [x] P1-002 Make Canvas Frontend Output Contract Smaller And More Reliable

Goal: Improve canvas frontend prompt framing so the model treats `metadata.bundle.files` as the source of truth and avoids duplicated giant HTML in multiple fields.

Primary files:
- `src/routes/canvas.js`
- `src/routes/canvas.test.js`
- `src/frontend-bundles.test.js`

Suggested shape:
- Keep the required JSON shape, but explicitly say `content` may be a short preview summary when `metadata.bundle.files` contains the complete project.
- Require `metadata.handoff.qaPlan` for frontend outputs.
- Keep artifact-family routing and impressive frontend guidance.

Acceptance checks:
- Existing canvas frontend parsing still succeeds.
- Bundle extraction still finds `index.html`, CSS, and JS from `metadata.bundle.files`.
- The prompt no longer encourages duplicating a full multi-file project inside one `content` string.

Focused checks:
- `npm test -- --runTestsByPath src/routes/canvas.test.js src/frontend-bundles.test.js`

Status:
- Done 2026-05-09 20:59.
- Files changed: `src/routes/canvas.js`, `src/routes/canvas.test.js`, `src/frontend-bundles.js`, `src/frontend-bundles.test.js`, `docs/prompt-optimization-hourly-backlog.md`.
- Checks run: `node .\node_modules\jest\bin\jest.js --coverage --runTestsByPath src/routes/canvas.test.js src/frontend-bundles.test.js`.
- Notes: Canvas frontend instructions now make `metadata.bundle.files` authoritative, allow short `content` summaries when the runnable project is in the bundle, require `metadata.handoff.qaPlan`, and normalize a default QA plan for compatibility.

### [x] P2-003 Strengthen Notation Helper Mode Contracts

Goal: Make notation responses more useful and parseable by adding mode-specific fields without breaking older clients.

Primary files:
- `src/routes/notation.js`
- `src/routes/notation.test.js` if added
- `frontend/notation/js/output.js`
- `frontend/notation/js/annotations.js`

Suggested shape:
- Preserve `result`, `annotations`, and `suggestions`.
- Add optional fields: `structure`, `assumptions`, `ambiguities`, `issues`, and `correctedNotation`.
- For validate mode, require `issues[]` with `severity`, `line`, `message`, and `fix` when problems exist.

Acceptance checks:
- Older clients still work when only the original fields are present.
- Validate mode can surface corrected notation and structured issues.
- Expand/explain modes do not overproduce validation-only fields unless useful.

Focused checks:
- Add route/parser tests if missing.
- Run the notation frontend parser/output tests if present, otherwise run the route test slice.

Status:
- Done 2026-05-09 21:05.
- Files changed: `src/routes/notation.js`, `src/routes/notation.test.js`, `src/ws/handler.js`, `frontend/notation/js/output.js`, `frontend/notation/css/styles.css`, `docs/prompt-optimization-hourly-backlog.md`.
- Checks run: `node .\node_modules\jest\bin\jest.js --coverage --runTestsByPath src/routes/notation.test.js`; `node --check .\frontend\notation\js\output.js`; `node --check .\src\ws\handler.js`; `node --check .\src\routes\notation.js`; `node -e "require('./src/ws/handler'); console.log('ws handler require ok')"`.
- Notes: Notation prompts now keep the legacy response shape while advertising optional mode-specific fields, validate mode requires structured `issues[]`, parser output preserves those fields, issue rows are mirrored into annotations for older UI flows, and the WebSocket notation path reuses the same prompt/parser contract.

### [ ] P2-004 Move Remote And k3s Details Out Of Universal Continuity Prompt

Goal: Keep the universal continuity prompt compact and move remote/k3s/GitLab specifics behind remote intent or remote tool availability.

Primary files:
- `src/runtime-prompts.js`
- `src/openai-client.js`
- `src/conversation-orchestrator.js`
- `src/runtime-execution.test.js`
- `src/openai-client.test.js`

Suggested shape:
- Keep universal rules for continuity, memory boundaries, verification, directness, and tool truth.
- Create a remote guidance helper that is injected only when remote tools or remote intent are active.
- Do not weaken the proven remote build behavior; only change when it is surfaced.

Acceptance checks:
- Non-remote chats receive a shorter general prompt.
- Remote build/deploy/debug prompts still receive GitLab, k3s, SSH, and visual QA guidance.
- Existing prompt-state reuse remains stable.

Focused checks:
- `npm test -- --runTestsByPath src/openai-client.test.js src/runtime-execution.test.js`

### [ ] P2-005 Add Remote CLI Completion Proof Contract

Goal: Make remote-cli-agent final outputs easier for the outer runtime to classify as complete, blocked, or partially verified.

Primary files:
- `src/remote-cli/agents-sdk-runner.js`
- `src/remote-cli/agents-sdk-runner.test.js`
- `src/agent-sdk/tool-docs/remote-cli-agent.md`
- `src/agent-sdk/tool-docs/managed-app.md`

Suggested shape:
- Add required final marker guidance: `WHAT_CHANGED`, `VERIFY_COMMANDS`, `VERIFY_RESULTS`, `PUBLIC_URL`, and `BLOCKER`.
- Preserve existing continuity markers: `REMOTE_CLI_SESSION_ID`, `WORKSPACE`, `GIT_REPO`, `GIT_COMMIT`, `DEPLOYMENT`, `PUBLIC_HOST`, `UI_CHECK_REPORT`, `UI_SCREENSHOTS`.
- Teach parser support only if downstream code needs to consume the new markers immediately.

Acceptance checks:
- Remote-cli prompt includes proof markers.
- Existing metadata extraction still works.
- Managed-app remote-cli evidence remains compatible.

Focused checks:
- `npm test -- --runTestsByPath src/remote-cli/agents-sdk-runner.test.js`

### [ ] P3-006 Make Agent Role Pipeline The Source Of Frontend Standards

Goal: Reduce duplicated frontend quality-bar wording by making `agent-roles.js` the canonical source and formatting it into planner/runtime prompts.

Primary files:
- `src/orchestration/agent-roles.js`
- `src/conversation-orchestrator.js`
- `src/routes/canvas.js`
- `data/skills/impressive-frontend-websites/SKILL.md`
- `src/orchestration/agent-roles.test.js`

Suggested shape:
- Export reusable prompt text or a formatter for the frontend quality bar.
- Replace duplicated partial lists where safe.
- Keep canvas-specific JSON contract details in canvas; keep general quality standards in the role/skill source.

Acceptance checks:
- Website/dashboard/game planning still receives the full frontend quality bar.
- Canvas frontend generation still has artifact-family and bundle instructions.
- Tests pin the quality bar for first viewport, real controls/states, relevant assets, responsive QA, and refinement pass.

Focused checks:
- `npm test -- --runTestsByPath src/orchestration/agent-roles.test.js src/conversation-orchestrator.test.js`

### [ ] P3-007 Add Prompt Surface Inventory Test Or Script

Goal: Give future hourly passes a deterministic way to find prompt surfaces and detect accidental drift.

Primary files:
- `src/orchestration/prompt-renderer.js`
- `src/orchestration/prompt-renderer.test.js`
- `src/runtime-prompts.js`
- `src/routes/admin/prompts.controller.js`

Suggested shape:
- Add a small registry or script that lists known prompt builders and owning files.
- Include prompt family, owner surface, expected tests, and whether it is universal or conditional.
- Use it for admin visibility if there is already a prompt admin surface.

Acceptance checks:
- The inventory includes runtime continuity, planner, canvas, notation, notes, remote-cli, tool-doc guidance, and skills.
- A focused test fails if a required surface is removed from the inventory.

Focused checks:
- `npm test -- --runTestsByPath src/orchestration/prompt-renderer.test.js src/routes/admin/prompts.controller.test.js`

## Run Log

Append newest entries at the top.

```text
2026-05-09 21:05 - P2-003 - done - src/routes/notation.js; src/routes/notation.test.js; src/ws/handler.js; frontend/notation/js/output.js; frontend/notation/css/styles.css; docs/prompt-optimization-hourly-backlog.md - node .\node_modules\jest\bin\jest.js --coverage --runTestsByPath src/routes/notation.test.js; node --check .\frontend\notation\js\output.js; node --check .\src\ws\handler.js; node --check .\src\routes\notation.js; node -e "require('./src/ws/handler'); console.log('ws handler require ok')" - Added additive notation mode fields, validate issues/correctedNotation handling, issue-to-annotation compatibility, and shared HTTP/WS notation contracts.
2026-05-09 20:59 - P1-002 - done - src/routes/canvas.js; src/routes/canvas.test.js; src/frontend-bundles.js; src/frontend-bundles.test.js; docs/prompt-optimization-hourly-backlog.md - node .\node_modules\jest\bin\jest.js --coverage --runTestsByPath src/routes/canvas.test.js src/frontend-bundles.test.js - Made canvas frontend outputs bundle-first, added handoff qaPlan normalization, and pinned short-content bundle behavior.
2026-05-09 20:53 - P1-001 - done - src/conversation-orchestrator.js; src/conversation-orchestrator.test.js; src/workloads/natural-language.js; docs/prompt-optimization-hourly-backlog.md - npm test -- --runTestsByPath src/conversation-orchestrator.test.js - Added planner policy packs (workload/remote/frontend) with focused gating + tests.
YYYY-MM-DD HH:mm - ITEM-ID - status - files changed - checks run - notes/blockers
```

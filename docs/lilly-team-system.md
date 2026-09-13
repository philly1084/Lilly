# Lilly computer and team system

Goal: deliver the full persistent teammate, private computer, collaboration,
memory, skills, routines and parallel execution experience in Lilly. Grok Build
is an optional source-built worker, not the owner of Lilly's permissions or
team scheduler. This document is an acceptance ledger, not a completion claim.

## Required proof

### Live execution repair checkpoint (2026-09-07)

The isolated Grok worker now successfully opens sandboxed Chromium and sends a
private frame to the live model. A typed-stream adapter fixes the gateway's
legacy completed-chunk envelope; a corrected test tracer preserves tool call
IDs and cancellation. This is not yet a passing team scenario: the writer ended
after promising to save a draft, without writing or contacting its peer. See
`docs/lilly-expanded-live-test-2026-09-07.md` for the exact live proof records.

Local completion handling now permits at most two same-session follow-ups under
the original model/tool/deadline budgets. Assignments can pin `requiredArtifacts`
as distinct portable filenames (up to 20); for example `['draft.md', 'final.md']`.
The worker checks byte-verified outputs and the authoritative result recorder
independently rejects a success result missing any required filename. These
requirements are stored with the task and included in its workroom projection
and worker assignment. Existing tasks without the field retain their behavior.
Owner-created routines also retain required filenames and an independent
reviewer for each occurrence; both are validated before the routine is stored.
Routines remain disabled by default. Their task-generation and validation checks
pass locally; no live routine was enabled as part of this change.
An explicitly reviewed task still requires at least one artifact at the worker
boundary. Filenames alone do not prove factual correctness, collaboration or
semantic task completion; independent review and scenario checks remain required.

These latest repairs and completion gates are not deployed globally. The
completion gates have unit/integration proof but still need fresh live proof.

### Current installed checkpoint (2026-09-07)

The node service, backend mTLS connection, and 72-file backend/workroom release
are installed on primary. Historical uninstalled statements below apply only to
their dated proof checkpoints. The shared model gateway has been recovered from
its verified cached image; registry access itself still needs a durable repair.

An authenticated public check matched all five workroom entry/CSS/JS assets to
the running image, read the team list, and confirmed runtime execution, vision
and Grok are disabled. This is HTTP/source verification, not visual browser QA.
The one-agent live Kimi test saved and verified a 36-byte artifact in isolated
PostgreSQL/filesystem adapters and shut down cleanly; see
`docs/lilly-scoped-live-test-2026-09-07.md`. It does not prove production artifact
delivery, private-browser execution or a live multi-agent Grok team.

Remaining: authenticated visual QA, production artifact delivery, real isolated
Grok/browser/parallel-team tests, owner-binding and recovery integration,
certificate rotation and stable network/image availability. Global activation
has not been authorized by a scoped test.

### Backend startup identity connection (2026-09-07 UTC)

Added a separate read-only `bindExecutionOwner` node RPC, explicit per-node backend
Pod allowlists, restricted Kubernetes GET routing/RBAC rendering, native-service
composition and opt-in backend startup wiring. The runner acquires the bound
identity before claiming tasks. Configuration or observation failure cannot
silently fall back to an unbound owner. Browser RPCs retain their task-lease
contract; this is not a model tool, shell endpoint or fabricated browser lease.
See `docs/lilly-node-rpc.md` for the configuration and rollout boundary.

Local real-mTLS tests connect the node adapter, execution-owner resolver and
runner's immutable startup identity; API/CRI/kernel inputs in that test are
synthetic. The separate read-only native diagnostic sampled PID 1 of existing
`backend-56cbbc96bc-ffz67` on primary and matched the new scoped adapter to direct
API/CRI/kernel/cgroup observations. Receipt:
`local/lilly-node-owner-native-proof.json`, proof
`9fdb6502-f6fd-416e-8eb1-da4bb9524cba`; all six recorded source hashes match.
The diagnostic first stopped at a missing module before any Pod inspection; only
its four missing native-reader dependencies were then copied to the isolated
source directory. No live task claim, stop, takeover, model, credential update
or Kubernetes mutation occurred. This does not prove the installed private RPC
network path or crash recovery. The node service and its new policy remain
uninstalled; `observeQuiescence` still needs an authoritative deployment adapter.

**27 new tests; 1,312 tests / 72 suites pass**, recorded in
`local/lilly-owner-binding-jest.json`. Prior full-workflow/image receipts remain
historical checkpoints, not proof of this newly changed startup path.

### Rendered real-worker workroom and in-flight drafts (2026-09-07 UTC)

The actual three-worker scripted integration now renders the authenticated
workroom during writer/peer overlap and after independent review. **26 checks
pass**, including repository UI checks at desktop 1440x960 and mobile 390x844.
All four screenshots were visually inspected: writer waiting, peer running,
shared request/reply and memory, then the completed writer task and four files.
The peer and verifier tasks correctly remain `needs_review`.

This exposed and fixed a real projection gap: previously, a saved draft stayed
invisible until the writer returned its final task result. The shelf now includes
settled `artifact_write` receipts as **unreviewed** files during execution. It
exposes only matching artifact IDs/hashes, never private operation fields; unknown
writes remain hidden. Final results deduplicate the draft entry and carry the
actual review status. An output omitted from a completed result stays unreviewed.
Eight new regressions cover these boundaries. **1,285 tests / 71 suites pass**
(`local/lilly-live-draft-jest.json`).

Receipt: `local/lilly-rendered-workroom-proof.json`, proof
`ebb4483f-adc0-4a5d-b233-3dd5f8c9e313`; all **269 recorded source/dependency hashes**
match this checkpoint. Database receipt:
`local/lilly-rendered-workroom-database-proof.json`, proof
`76644356-8446-4bf8-9b59-20463d793fa8`. Screenshots and the two zero-issue UI reports:
`output/playwright/real-grok-workroom/{overlap,reviewed}/`.

Use `--full-services --independent-review --render-workroom` on the isolated
driver to request this check. The test serves the real frontend, blocks UI team
mutations, and gives the existing UI checker only a short-lived fixture token.
Snap Chromium is the operator-page QA browser; it is not the separately sandboxed
private agent browser. The cached host Chromium failed for a missing library;
the first Snap run then exposed the missing draft link. Those failed receipts
remain in `local/lilly-render-workroom-{first,diagnostic,snap}-proof.json`.
UI inspection is no longer retried through scripted inference, and teardown
awaits the same inspection promise before closing HTTP/SQL and saving its receipt.
All four runs' exact worker/browser/database containers and checker processes
were independently confirmed absent. Synthetic outputs and receipts remain.

This is real worker execution and rendered UI with **fixed scripted inference**,
not live model perception or judgment. Authenticated downloads verify all four
files, but no manual file-link click was tested. Production, native-node recovery
and live-provider activation remain unverified and unchanged.

### Independent review completion checkpoint (2026-09-07 UTC)

The connected integration now includes an opt-in `--independent-review` scenario
(after `--full-services`). **24 checks pass** with three real source-built Grok
containers, a private sandboxed browser and disposable PostgreSQL. The writer
and peer still overlap and exchange a request/reply. Once the writer records its
result, Lilly automatically queues the assigned third teammate's independent
review. That verifier uses normal `team_task`, `artifact_read`, `artifact_write`
and `team_command review_task` calls through ACP/MCP.

A deliberate test probe attempts approval before file reads and receives
`team_evidence_required`; the writer remains `needs_review`. After reading both
writer outputs completely, the verifier saves `independent-review.md` and records
approval. The writer becomes `completed`, the authenticated workroom API reports
completed artifact statuses, and a fresh service/connection pool reloads the
same verdict, complete read hashes and three distinct saved agent sessions.
All four artifacts are independently read from SQL and authenticated downloads.
The peer and verifier's own tasks remain `needs_review`; their completion is not
silently assumed or recursively auto-approved.

Receipt: `local/lilly-team-independent-review-proof.json`, proof
`488a36e6-9b22-4b91-92ae-1c2df12b75eb`. All **260 recorded source/dependency hashes**
match current local files. Database receipt:
`local/lilly-team-independent-review-database-proof.json`, proof
`6fdd1854-bbb7-4b01-8f20-24aeb0dfa71c`. The three workers, browser and database
were removed and absence independently checked. Private fixture mounts were
removed; synthetic exports and nonsecret receipts remain in the proof directory.

This uses Node 24.18.1, fixed scripted inference and no external model calls.
The negative approval attempt is an explicit harness probe, not model behavior.
It proves execution, authorization, read-back and durable review transitions,
not an independent model's assessment quality. It uses the test browser adapter,
not deployed Kubernetes/native-node recovery, and does not render the live UI.
Only the test driver changed; **70 tests in three affected suites**, syntax and
whitespace checks pass. No deployed configuration or real task was changed.

### Workroom refresh responsiveness (2026-09-07 UTC)

The operator workroom no longer waits for every artifact metadata response before
rendering current agent activity. `team-client.js` now returns the activity
snapshot immediately and exposes a separate, bounded metadata enrichment pass.
Verified files appear independently; unmatched/missing metadata never acquires
a link. Concurrent refreshes share the same pending file request keyed by
team/artifact/hash, so a slow read can finish instead of being cancelled forever
by the 4.5-second polling cadence. Switching rooms cancels pending file reads.
Old snapshot callbacks cannot overwrite a newer room/activity view.

Only the artifact shelf and selected file list update when metadata arrives;
stations, messages and the operator's input are not rebuilt by that update.
Five new regressions cover immediate activity, independent file arrival,
cancelled-room replies, shared slow reads, preserved draft/focus and stale-view
protection (related assertions share tests). **1,277 tests / 71 suites** pass:
`local/lilly-workroom-enrichment-jest.json`.

The connected in-app browser showed the workroom and quick file while the
eight-second file request was outstanding, then showed both filenames after
the slow reply. The first implementation cancelled that request every refresh;
the rendered check exposed the starvation and the shared-request fix above
resolved it. An unsent message survived manual/automatic refreshes. Desktop
1280px and mobile 390px checks found no page-level horizontal overflow, no
iframes and no captured console errors. Screenshots were inspected in the turn.

The repository UI checker also passed both viewports with **zero issues**;
saved screenshots and its report are in
`output/playwright/workroom-enrichment/`. These show an explicitly authored,
local no-worker fixture, enabled with `TEAM_UI_ARTIFACT_FIXTURE=true`; its
file records are not real delivered artifacts or completion evidence. No task
was submitted and no live worker, provider or production deployment was used.
The temporary browser tab was closed, viewport restored and fixture stopped.

### Current connected-workflow refresh (2026-09-07 UTC)

The current-source scripted integration passes **21 checks** on primary ARM64,
Node **24.18.1**, with two real Grok containers, one sandboxed Chromium container
and disposable PostgreSQL **16.15**. Receipt:
`local/lilly-team-current-services-proof.json`, ID
`72495cae-ec81-42f8-8261-b1f2b5e10180`. All **260 recorded source/dependency hashes**
match the workspace. The separate database lifecycle receipt is
`local/lilly-team-current-services-database-proof.json`.

The writer and reviewer overlap while the writer waits without model polling.
A request wakes the peer once; its reply does not create a reply storm. The peer
reads the actual draft, records shared memory and writes a review. Three outputs
(`draft.md`, `review.md`, `final.md`) are saved through the real ArtifactService,
read independently from SQL and downloaded through authenticated product routes
with matching hashes. Fresh SessionStore/TeamService instances reload owned
sessions, messages, memory and settled browser operations; foreign access fails.
The authenticated workroom API sees both workers and the wait activity. Browser
pixels reach only the scripted model path, not serialized team state.

This run uses **fixed scripted inference**, not live provider intelligence or
visual reasoning. Browser interaction uses the test-only stdio adapter, not the
deployed Kubernetes/native-node recovery chain. It does not render the operator
UI. Tasks remain `needs_review`; a review artifact and reply are not an independent
approval verdict. Production flags, Kubernetes resources and real tasks were
not changed. All worker/browser/database containers were removed; independent
container queries confirmed absence. Private worker mounts were removed.

The previous integration snapshot had eight changed source files. The relay now
mounts the proof process's verified Node executable instead of the host's older
default; its version and binary hash are recorded. Existing server source was
checked against 251 earlier recorded hashes before a **20-file source delta** was
applied to `/tmp/lilly-grok-team-source.S1e9IB`. The rejected broad transfer was
not uploaded. The first run failed before worker launch because that fresh
source-only directory was mode 0700; changing only that directory to 0755 allowed
the non-root browser to read its entrypoint. Failed-run receipt:
`local/lilly-team-current-failure.json`; its exact fixtures were also removed.

The separate current-source transactional proof passes **36 real PostgreSQL
checks**, with all **28 recorded source hashes** matching:
`local/lilly-team-current-postgres-proof.json`, ID
`7ddd529e-f339-459a-b823-6b1620a227e1`. It verifies cross-pool row locks, admission,
skill revision pinning, lost-reply read-back, immutable receipts and next-task
profile identity. Kernel/CRI/Kubernetes observations in this SQL test are
fixtures; it is not live mounted recovery. Its disposable database was removed.

Local proof-related regression: **37 tests / three suites**, plus syntax and
whitespace checks. The previous broader checkpoint remains **1,272 tests / 71
suites**; only proof code changed during this refresh, not production runtime.

The private browser now has a production channel/runtime adapter and an isolated
seven-check real-container transport proof. See `docs/lilly-computer-transport.md`.
Kubernetes browser acquisition/profile ownership is implemented in isolated
components but its deployed combined path remains unverified;
the existing in-process path is still the default.

| Requirement | Required evidence | Current status |
| --- | --- | --- |
| Persistent personas and teams | Create, reload, duplicate without copying private memories; owner isolation | In implementation |
| Messages and handoffs | A sends a request to B; B wakes once, acknowledges and replies; no reply storms | Two real Grok containers complete request/wait/read-back/reply with PostgreSQL state and fresh-service reload; live-model proof missing |
| Parallel tasks | Independent workers overlap, conflicting writes serialize; dependencies wait | Real Grok containers overlap during team_wait; transaction tests cover conflicting claims; combined production proof missing |
| Private computers | Model receives screenshot pixels and acts on the same live browser; operator does not receive pixels | Matched browser passes six 16-check scripted runs and a 20-check real-service/authenticated-HTTP run; workroom omits pixels. Earlier stock-browser timeout is retained. Real perception, rendered live operator UI, deployed isolation/policy and long-run reliability remain unverified |
| Resume and stop | Same identity/computer after rest; cancellation and crash recovery without duplicated side effects | Recovery leases/controller and immutable stop-record replay pass isolated PostgreSQL proof; real terminal capture, deployed quiescence and browser takeover missing |
| Memories | Private/team boundaries, provenance, edit and forget, reload on later work | In implementation |
| Skills and task templates | Versioned draft, explicit approval, invocation with no permission escalation | In implementation |
| Routines | Due-time wake, rest, bounded retries, disabled routines stay disabled | Opt-in scheduler connected; no automatic retries; live proof missing |
| Adaptive team growth | Coordinator creates specialists within team budget; persisted identity reused | Scoped coordinator commands implemented; live proof missing |
| Grok worker | Pinned source ARM64 build, ACP handshake, custom model and MCP tool round trip | Real source image, ACP, scripted tool loop, two-worker collaboration and same-session container replacement pass; live provider inference and production recovery missing |
| Unified frontend | Real streamed actions, communication, whiteboard and artifact shelf; desktop/mobile QA | Authenticated desktop/mobile screenshots now show actual scripted Grok workers overlapping, waiting, communicating, saving a draft and completing review. Management flows have separate local fixture coverage; live-model and production proof remain |
| Completed outcome | Artifact written and independently read back, reviewer verdict, final link | Three real Grok workers complete the scripted writer/peer/independent-verifier scenario; four authenticated downloads match recorded hashes and writer approval survives fresh SQL reload. Premature approval is refused. The rendered shelf now shows draft and completed outputs. Live-model judgment, manual link-click verification and production proof remain missing |
| Production | Commit/image/rollout/public authenticated scenario proof | Not deployed |

## Boundaries

### Recorded private-computer UI checkpoint (2026-09-07 UTC)

The Browser signals panel now projects the selected agent's allowlisted
`computer_open`, `computer_observe` and `computer_act` started/finished/failed
events. It shows at most 24 checkpoints, newest first, using fixed labels and
timestamps only. It never takes page titles, URLs, pixels, arguments or tool
results from the events, and explicitly distinguishes history from browser
liveness. Switching teammates clears the previous history. Successful refreshes
also settle the header from Syncing to the recorded sync time; errors remain errors.

This is wired to the existing authenticated workroom projection, not a second
event API. The six focused suites pass 60 tests. The authored no-worker display
fixture passes desktop 1440px and mobile 390px browser checks, including 7.86:1
minimum checkpoint text contrast; screenshots and
report are in `output/playwright/computer-checkpoints/`. The repository UI checker
also reported zero issues for the fixture's default view. No production deployment
or live agent activation occurred. A rendered workroom backed by actual live
workers remains a separate acceptance gate, not established by this fixture.

### Authority and privacy

- Lilly is the authoritative coordinator and identity/permissions store.
- Owner and agent identities come from authenticated execution context, never
  from model-selected sender fields. A persona or skill is not a permission.
- Message delivery is durable; requests enqueue work, informational replies do
  not automatically wake everyone. Idempotency applies before any execution.
- A stale observation is not a terminal job. Reconcile the existing worker
  handle; never start a replacement merely because a poll timed out.
- Browser login state and screenshots are private capabilities, not artifacts
  automatically distributed to the group or operator frontend.
- A model's completion report enters review. Recorded files and read-back are
  needed before a verified completion claim.
- Keep the existing Admin mission, schedules and artifacts. No automatic live
  agent activation while assembling this feature.

## Source references (verified 2026-09-06)

- https://docs.x.ai/grok-bot/chat-and-collaboration
- https://docs.x.ai/grok-bot/create-and-manage-bots
- https://docs.x.ai/grok-bot/skills-routines-and-automations
- https://docs.x.ai/build/cli/headless-scripting
- https://docs.x.ai/build/features/mcp-servers
- https://github.com/xai-org/grok-build

## Implementation checkpoint (2026-09-06)

Implemented, with focused fixture tests (not production completion proof):

- `src/agent-teams/`: Postgres row-locked team state; stable persona/session/
  computer identity; owner and fenced worker command paths; idempotent work
  requests; private/shared memories, corrections and forgetting; approved skill
  revisions pinned into tasks; bounded parallel admission and path conflicts;
  dependency gates; rest and cancellation requests; opt-in interval routines;
  artifact verification callback and independent reviewer read-before-approval
  gate. A successful writer can enqueue its assigned reviewer automatically.
- `/api/agent-teams`: authenticated owner CRUD/command surface and `/runtime`
  availability. An opt-in scheduler now claims tasks and connects stable owned
  sessions to the native Responses tool loop. Both process and team execution
  gates default off. A stopped scheduler cannot launch an in-flight admission.
- `worker.js`: scoped team commands, artifact writes with independent hash
  read-back, chunked artifact reads and private browser tools. Only trusted
  browser frames become image content on the next model round. Operator events
  contain bounded tool names and call IDs, not arguments, output or screenshots.
- `runtime.js`: global and per-team tool grants intersect. Default passthrough
  permits only `web-search`; `web-fetch` needs a scoped adapter because it also
  supports writes and internal artifact reads. Browser origins and side-effect
  permission are rechecked; no generic remote-shell or filesystem bypass exists.
- Native worker cancellation is signalled to model and tools. An uncertain
  executor outcome becomes `reconciling`, retains capacity, and is not retried.
  A stale-worker reconciliation/resume controller is still required.
- `src/grok-build/`: ACP transport and pinned source-build container definition.
  Protocol fixtures pass. No actual Grok binary or model call verified yet.
- `src/agent-computer/`: isolated resident computer runtime; 18 fixture tests
  cover identity, leases, frame freshness, action policy, sandbox settings and
  private model image payloads. Secure-default live canary remains unverified:
  local Chrome fails with Windows GPU process permissions when sandbox enabled.
  No fallback disables the sandbox.

Next integration requirements remain open: prove the supervised isolated
Grok worker and its restricted network path on the cluster, reconcile interrupted workers,
wire the existing workroom to these identities/events, finish the ARM64 source
build, and execute the full two-specialist/reviewer/resume scenario with real
model, browser, Postgres and artifact read-back evidence. Unit/HTTP fixtures do
not establish those live gates.

### Execution configuration (not activated)

- `LILLY_TEAMS_ENABLED=true` opts the process into scheduling. An owner must also
  use `configure_execution` with `enabled: true` on a team.
- `LILLY_TEAMS_ENGINE` defaults to `lilly`. `grok-build` requires a trusted
  `grokWorkerFactory` deployment adapter, now supplied by the Kubernetes
  supervisor when `LILLY_TEAMS_GROK_IMAGE` is an immutable `@sha256` reference
  and Downward API owner-Pod identity is supplied (see below).
  Without a supervisor, runtime status reports
  `grok_supervisor_unavailable`, claims are not started, and no fallback runs.
- Required broker identity environment: `LILLY_TEAMS_BROKER_POD_IP` from
  `status.podIP`, `LILLY_TEAMS_BROKER_POD_UID` from `metadata.uid`,
  `LILLY_TEAMS_BROKER_POD_NAME` from `metadata.name`, and
  `LILLY_TEAMS_BROKER_POD_NAMESPACE` from `metadata.namespace` (kimibuilt).
  IPv4 must match a local non-loopback interface. Keep backend host networking
  disabled. Old ClusterIP/base-URL settings are rejected; a shared Service
  cannot correctly route process-local worker leases across replicas.
- `LILLY_TEAMS_VISION_ENABLED=true` additionally requires a sandbox-capable
  browser and owner-configured exact `origins`. Browser actions also require
  `allowSideEffects: true`. No private screens are rendered in operator routes.
- `LILLY_TEAMS_TOOL_ALLOWLIST` intersects owner-configured `toolIds`; persona,
  memory, skill instructions and model arguments cannot expand it.
- `grok-loop.js` is the shared worker-loop adapter. It supplies task tools via
  authenticated MCP, checks image capability, resumes the recorded ACP session,
  saves the session before prompting, and requires supervisor shutdown before
  accepting the final report. The deployment adapter must enforce isolation,
  scoped model configuration, persistent state and child-process reaping.
- The task MCP bridge uses real authenticated HTTP SDK transport. It serializes
  tools, supplies private images only to the task token holder, and reports
  pending dispatches when closed. Unsettled Lilly tool calls prevent accepting
  even a successful Grok report. The cross-container broker now forwards only
  that task's authenticated requests to its private loopback bridge. A scripted
  connected-path test covers actual HTTP transport, model routing, artifact
  write/read-back, session save and shutdown; worker/model/storage are fixtures.
- Worker traffic uses a dedicated internal TCP 3001 listener with no ordinary
  API, login or artifact routes. Pods have no upstream provider keys or cluster
  credentials, no DNS/internet egress, broker host aliases pinned to their owning
  backend Pod IP (no shared Service), scoped state
  PVCs and digest-checked images. Exact Pod/Secret UIDs and sessions are recorded;
  uncertain cleanup retains reconciliation. PVCs are retained, not deleted.
- Browser WebSockets are opt-in through `LILLY_TEAMS_WEBSOCKETS_ENABLED=true`
  plus owner `allowWebSockets` and `allowSideEffects`. Connections and each frame
  recheck policy with bounded queues/cancellation. The live authenticated Web
  Chat scenario remains unverified; Playwright has no delivery acknowledgement. The
  native worker carries explicit memories, inbox, own result summaries and a
  shared artifact catalog across wakes, not an entire replayed chat transcript.

Read-only live baseline: primary ARM64 node Ready; current backend image
`ghcr.io/philly1084/lilly:sha-f477148` (1/1 Ready). Local Docker daemon is not
running. Primary has Podman 4.9.3/Buildah 1.33.7 and 52 GiB free disk.

Candidate source build (not deployment): `/tmp/lilly-grok-source.SAIy9f` on
primary. Attempt 1 exited 125 because Podman rejected unqualified image names;
Dockerfile corrected to `docker.io/library/...`. Build uses 6 GiB memory,
two CPUs and a 40-minute timeout. Inspect `build.pid`, `build.exit` and the actual
process before drawing conclusions; a missing observation is not completion.
No live agent or existing workload was launched.

Attempt 2 exited 101: DotSlash 0.5.9 was unavailable through Cargo. Its terminal
logs and definition were preserved as `attempt-2.*`. Attempt 3 uses official
DotSlash release assets with verified SHA-256. Attempt 3 reached its 40-minute
limit and exited **124**, with no Cargo process remaining. Retained builder
`0b919e0b5c195a3744217642a1ec66d692236b451965a2f4d3466e95b1e4a51a`
held the correct source and 5.6 GiB compile cache. It was preserved as
`localhost/lilly-grok-build-cache:resume-0b919e0b5c19`, not deleted or replaced.
The scoped `resume-candidate.sh`/`Resume.Dockerfile` verifies source and clean
tracked files, then resumes Cargo with the same 6 GiB/two-CPU/40-minute compile
limits. Original logs remain intact. Wrapper **138761**, Podman **140858** and
Cargo **141045** were confirmed live. Inspect `resume.pid`, `resume.exit`,
`resume.log` and actual processes before proceeding; do not restart on missing
observations. That resume is now terminal: **101**, with kernel evidence of a
compiler memory-cgroup OOM at 23:19:36 UTC. No source compilation error was
reported. Inspection also found upstream target CPU `neoverse-v2` but host CPU
`Neoverse-N1`; simply raising the memory cap would leave an incompatible target.

Current scoped recovery: `recover-candidate.sh` + `Recovery.Dockerfile`, running
as systemd unit `lilly-grok-recovery-72a6125.service`, initial MainPID **173866**,
Podman **173892**, Cargo **174133**. Inspect this exact unit, `recovery.pid`,
`recovery.exit`, `recovery.log` and actual child processes; never launch a duplicate
on an observation timeout. New target:
`localhost/lilly-grok-build:source-72a6125-generic`. It uses one Cargo job,
generic CPU flags with unwind tables, 10 GiB/two CPUs, a two-hour deadline,
free-memory/disk preflight and an exclusive recovery lock. All old logs and
caches remain. The normal clean Dockerfile uses the same CPU/job settings and
records them in provenance. No finished image or model session is claimed.

Earlier combined frontend/backend focused/regression checkpoint: 270 tests in 25 suites passed,
including actual local HTTP MCP client tests and existing server/Agent Ops
checks. One initial server readiness test hit its 20-second timeout; the isolated
rerun and the subsequent full selected run passed without changing its timeout.
This does not cover a real Grok/model session, production Postgres concurrency,
secure live browser vision, frontend integration or deployment. No source-to-
public completion claim is made.

Foundation inventory: the worker namespace and broker Service did not exist.
Primary context `default` accepted `kubectl apply --dry-run=client --validate=true`
for `k8s/lilly-team-workers.yaml`; no resources were created. Skill helper CLIs
`secure-codex`/`k3s-codex` are unavailable locally. Focused policy tests and schema
validation do not substitute for live CNI/PVC/process proof.

Workroom integration checkpoint: authenticated `GET /api/agent-teams/:teamId/workroom`
uses an explicit presentation allowlist, excludes private memories, worker claims,
leases, ACP sessions and raw tool/browser content, and distinguishes queued,
waiting, stopped, stopping, reconciling and review states. It serves shared notes
separately from tasks and exposes artifact hashes with their actual review state.
The existing raw owner-management route remains separate. Owner approval now
performs fresh artifact read-back and compares recorded hashes under the state
lock; changed bytes/result references cannot be silently approved. Successful
approval receipts remain retryable without repeating the transition.
Keyed team creation
uses an owner-scoped stable ID and Postgres conflict-do-nothing: uncertain retries
cannot overwrite existing work or create a second team.

Actual PostgreSQL proof passed seven checks using the then-current source, two
connection pools, and PostgreSQL 16.15 in an isolated ARM64 container: 20-way
keyed creation/owner isolation, retry preservation and conflicts, rollback,
held row-lock blocking across pools, 32 concurrent updates without loss,
20-way admission respecting concurrency three, and 16-way admission preserving
same-agent and overlapping-write exclusion. Report:
`local/lilly-team-postgres-proof-success.json`; its recorded hashes identify that
checkpoint. Later profile/skill/recovery changes require a fresh PostgreSQL run
before claiming that report covers the current source. The image was pinned to
`docker.io/library/postgres@sha256:b0743658432ade5ff808dc51f94da7ee99ed2a40e354a9f89fa0c42022fee3c0`.
Limits: 512 MiB, one CPU, network none, tmpfs data, private Unix socket, no host
ports. Initial fixture socket/readiness guards needed correction before SQL
checks ran; all five exact owned containers are confirmed removed. No production
database or model was accessed. This proves store concurrency/transactions,
not live Grok execution, full browser behavior or a production migration.

The revised no-Service worker foundation also passed Kubernetes client dry-run
and schema validation on context `default` (nine objects, nothing applied).

### Persistent workroom UI checkpoint

`frontend/agent-ops` now has a separate owner-scoped team client and selects a
persistent room with `?team=<id>`. The existing Admin/company project and artifact
paths are retained; returning to company projects does not activate or wake a
different mission. Users can create paused teams, save personas/jobs, queue tasks
or explicit teammate requests, configure execution, stop/resume, add shared notes,
inspect safe activity/result summaries and review artifact-backed outcomes.
The UI uses stable keys across uncertain creation/command retries, preserves
drafts on errors and guards stale team-switch responses. Activity is not labelled
as raw PTY output. Queued, stopping, reconciling and needs-review states are not
presented as working or complete. No private browser images are rendered.

Local browser verification used the actual team service/routes with explicit
in-memory TestStore, no scheduler/model/credentials, at port 3196. Sandboxed
Chrome covered 12 desktop (1440x1000)/mobile (390x844) states: room plus teammate,
execution, task, team and note dialogs. No page errors, broken images or page
horizontal overflow were reported. Screenshots are under
`output/playwright/persistent-teams/`. Independent Edge inspection caught and
verified fixes for an oversized toolbar, rail overflow and phone icon labels;
the temporary viewport override was reset. Tall dialogs now scroll internally
with their action footer in view. 31 frontend tests cover keyed retries, private
projection, stale switches, review failures and artifact metadata mismatch.

### Team library and recovery-prerequisite checkpoint

The team library now edits teammate names/personas/responsibilities while retaining
identity, sessions, role and execution state. Skills can be drafted, revised and
explicitly approved; task/routine selectors show approved revisions only. Routines
are created paused, with a separate confirmation before enabling. Existing routine
definitions remain immutable. The owner can create/edit/forget shared or private
memories through `GET /api/agent-teams/:teamId/memories` and existing commands.
That view is owner-authenticated and noncached, and private content is fetched only
when the Memories section opens, then cleared on leave/close/team switch. Command
receipt storage keys are SHA-256 fingerprints, not raw private-memory text; clients
without Web Crypto keep retry keys only in memory.

Approved skill acceptance checks are now pinned with each task, included in both
native and Grok worker input, and carried into the independent reviewer assignment.
The scoped `team_task` tool retrieves the complete assignment and pinned skill
without worker claims or private execution state; a long outcome is not available
only as the truncated reviewer prompt excerpt.

Local no-worker fixture at port 3197 passed actual browser skill create/approve,
routine create/enable/pause and private memory create/update/forget flows with
service read-back. Team execution stayed paused and created routines ended paused.
Sandboxed Chrome verified desktop 1440x1000 and mobile 390x844; management screenshots
are under `output/playwright/persistent-teams/`. Independent Edge inspection checked
the owner-only memory view and phone layout. A refinement widened the desktop
dialog to 880px while preserving its phone layout and scrolling action controls.
Combined current verification: **312 tests across 27 suites passed**, including
41 frontend tests across four suites, plus `git diff --check`.

`TeamRunner.drain({ timeoutMs })` now waits for actual tick/admission/execution/result
promises, reports unknown IDs and uncertain admission, and blocks its own restart
after an unsettled drain. `TeamStore.listUnsettled()` inventories disabled as well
as enabled teams. These are prerequisites, not an automatic restart reconciler or
proof that external work has stopped. Runtime shutdown integration was added in
the checkpoint below; durable ownership/dispatch/browser reconciliation remains
necessary. See
`docs/lilly-team-recovery.md` for the full required contract.

Still required for the full UI goal: dependency editing, populated reviewed-artifact
browser proof, and integration with actual running workers. Current screenshots
are explicitly local test state, not a production or model-execution claim.

### Claim-bound browser and shutdown checkpoint

Runtime shutdown now integrates bounded runner drain with broker/browser cleanup,
keeps the same pending cleanup across observation timeouts, and reports unsettled
shutdown without exposing task IDs in its status response. It rejects restart of
the disposed instance and late broker acquisition cannot start its scheduler.
Browser storage identity remains stable, but policy identity now includes the
exact task claim. Background requests/WS checks deny cancelled or old claims even
after teammate resume. A new claim must close the old context before reopening
its profile; old frames cannot be reused, and hung closure retains the lease.
These are tested prerequisites, not automatic crash recovery or a real browser
worker demonstration.

Historical PostgreSQL checkpoint: `local/lilly-team-postgres-proof-current.json`,
10 checks passed on the same pinned PostgreSQL 16.15 image with network disabled,
512 MiB/one CPU/tmpfs. Added 20-way idempotent profile edits, pinned acceptance
across approved revisions, and disabled/enabled unsettled-team inventory. All four
recorded source hashes were independently matched to local files. Exact owned
container `lilly-team-pg-proof-e7976919` was removed; production DB was untouched.
That combined focused/regression checkpoint had **320 tests in 27 suites passed**
and `git diff --check` passed. Source build remained active under the same systemd
unit, Cargo PID 174133, at the latest 53-minute observation; no image/startup or
authenticated model-backed worker proof is claimed yet.

### Durable operation journal checkpoint

Artifact writes, generic Lilly tools and private browser open/actions now reserve
bounded operation records before dispatch. Records contain request fingerprints,
call/operation identity, lifecycle timestamps and verified artifact ID/hash, not
private arguments, browser pixels or full tool output. Exact claim checks and
PostgreSQL row locks fence both dispatch and late settlement. Unknown outcomes
prevent new effects and final results without releasing the agent or write target.
New call IDs cannot duplicate an identical started effect; canonical effective
argument hashing also prevents JSON field-order changes from bypassing this fence.
Distinct pending requests can remain parallel and settled work can intentionally
repeat with a new call ID. This is not semantic deduplication of arbitrary tools.

Cancellation is checked again after reservation and awaited heartbeat. A browser
stale-frame failure is treated as no-dispatch only when the browser adapter proves
it occurred before the action boundary. The same code after a click stays unknown.
Generic job handles require an authoritative settlement adapter; the default
search observer accepts only successful, nonpending results without error or job
handles. There is no automatic reconciliation controller or artifact-write retry.
Reserved-ID read-back recovery was added in the checkpoint below.

Historical journal PostgreSQL evidence: `local/lilly-team-postgres-proof-journal.json`,
proof `5ecbc285-fc71-49fc-b69e-da78ba88cf24`, **12 checks passed** on PostgreSQL
16.15 with no network, 512 MiB/one CPU/tmpfs. It includes 20-way same/changed-call-ID
reservation races across two pools and unknown-effect fences after a service
restart. All four recorded source hashes match local files; the service hash is
`c5c819f9d3ad2f025e113629d0f6fc89e94a5565bc2bc95ef39c0574c5edd43f`.
The exact disposable container was removed and absence verified. Older reports
are historical; no production database or model was used.

That combined verification checkpoint had **402 tests across 29 suites passed**, covering
the new runtime, browser, journal, Grok transport/supervisor, frontend, existing
Agent Ops and server readiness. `git diff --check` passed. These local checks and
the isolated database proof do not establish live Grok or production readiness.

The same Grok recovery build was still compiling at the 72-minute observation,
under unit `lilly-grok-recovery-72a6125.service` and Cargo PID 174133. No finished
image, real ACP startup, model-backed session or deployment is claimed.

### Reserved artifact recovery checkpoint

Each team artifact write now passes the already-reserved operation UUID to
ArtifactService as its durable artifact ID. Its scope and request fingerprint
are bound to the owner/team/agent/session. The team-only path preserves PII
preparation, then performs a single artifact INSERT, without later processing
updates, vectorization/index writes, upsert or local-storage fallback. Ordinary
artifact callers retain their existing behavior. Team artifacts remain readable
through the artifact API and task result shelf; broader asset indexing is not
part of this reserved-write path.

If the write response is lost, the worker reads the exact reserved ID and checks
owner/team/agent/task, operation/fingerprint, stored hash and actual bytes. A
positive read recovers the result without invoking the write again. A missing,
foreign, mismatched or corrupted artifact stays unresolved; this does not resume
an old worker or prove browser/remote job quiescence after process loss.

Historical artifact database checkpoint: `local/lilly-team-postgres-proof-artifacts.json`, proof
`3d3b02a6-d5f2-4123-a3e5-5f7a2929485d`: **14 checks passed** on isolated PostgreSQL
16.15. Actual ArtifactStore queries use the checked-in production artifact-table
DDL and two separate pools. The proof verifies read-back after a deliberately
lost INSERT response and 20 rejected duplicate INSERTs without changed bytes or
scope. All nine recorded source hashes match the local worktree. The higher-level
ArtifactService preparation path is unit-tested, not a real model-worker proof.
The exact disposable container was removed and its absence independently checked;
production DB and running workloads were not touched.

That selected verification checkpoint had **609 tests across 37 suites passed**, including
existing artifact service/routes, Agent Ops and server readiness; `git diff --check`
passed. No frontend changes were made in this artifact-recovery checkpoint.

The same source build remained active at the 87-minute observation, Cargo PID
174133, under its existing bounded recovery unit. No image or deployment claim.

### Durable execution ownership checkpoint

TeamRunner now observes and caches one immutable owner before admission. The
owner is stored with the claim under the PostgreSQL row lock, before dispatch.
It records a fresh runtime boot UUID, PID/startup timestamp and, on Linux, kernel
boot UUID, process start ticks, PID namespace and mount namespace. Same PID or
same host does not imply the same runtime. Missing/invalid observations stop
admission; late acquisition after shutdown cannot open a broker or scheduler.
Concurrent preparation shares the same promise and frozen identity. Owner data
is excluded from model context and the operator workroom projection.

Cluster releases must supply the existing Downward API Pod name/namespace/UID
variables for either worker engine; `LILLY_TEAMS_CONTAINER_NAME` defaults to
`backend`. A detected Kubernetes environment with incomplete Pod context fails
closed. These declared Pod fields are not verified CRI identity or proof that an
old process has stopped. Current backend cgroup visibility is only `0::/`; a
read-only Node diagnostic inside it confirmed the required kernel observations
are available, without writing container files or starting a model/browser/agent.
Non-Linux and legacy ownership-free claims do not gain invented recovery proof.

Current database evidence: `local/lilly-team-postgres-proof-ownership.json`, proof
`045f4661-3114-4b53-94da-9f6e3f145a8e`, **15 checks passed**. The new check races
20 admissions through two actual PostgreSQL pools with distinct runtime owners,
verifies exactly one matching owner/claim after service reconstruction, and
rejects malformed ownership without changing state. All ten recorded source
hashes match the worktree. The exact disposable container was removed and its
absence independently checked. Earlier database reports are historical.

Independent read-only review found no concrete defect and prompted additional
tests for concurrent owner acquisition and startup rejection before broker bind.
That ownership checkpoint passed **638 tests across 38 suites**, plus all
15 isolated PostgreSQL checks and `git diff --check`. Kernel collection was also
observed in a short-lived read-only diagnostic inside the existing backend
container; no live agent task or deployed source change was involved.
At that checkpoint the automatic reconciler, authoritative process/container
quiescence adapter, browser profile takeover and live team scenario remained
open. The Grok build was still active at 102 minutes; the newer source-image
checkpoint below supersedes that build status.

### Source-image and recovery controller checkpoint

The existing Grok build has now completed with exit 0. Its immutable local image
is `sha256:e238d45932f634fc822928426ae4af96a26539f324c553cbfc3db29aa971d87c`.
Real provenance, binary hash, version and ACP initialize checks pass without
network, credentials or model/session creation. See
`local/lilly-grok-image-proof.json` and `docs/grok-build-runtime.md`.
The source runtime advertises HTTP MCP and session loading but not image prompt
attachments; the later MCP-image checkpoint below distinguishes those paths.

The new recovery controller fences old claims using database-timed leases,
recovers positively verified reserved artifacts, and releases interrupted work
as failed/cancelled only after all operations settle and the configured observer
confirms quiescence. It neither replays the interrupted assignment nor enables
execution. Its production observer and browser profile takeover are still
missing. Opt-in runtime wiring was added in the later checkpoint below;
`docs/lilly-team-recovery.md` records the exact boundaries.

Real PostgreSQL proof now passes **18 checks**, including a two-pool lease race,
expiry/stale-investigator rejection, concurrent completion receipt replay and
controller recovery of saved bytes without a repeated INSERT. All eleven source
hashes match. The test exposed and fixed a JSONB receipt-order bug. Disposable
proof containers were removed; no production database or workload was changed.

Current selected verification: **666 tests across 39 suites passed**, the
**18 real PostgreSQL checks** passed, and `git diff --check` passed. These are
local/probe results, not a deployment or live model-team completion claim.

### Private-image transport checkpoint

The actual source-built Grok binary now completes a scripted turn through Lilly's
real broker and MCP bridge: discovers tools, receives a private synthetic image,
passes its exact pixels as typed model input, writes a fixed file and reads its
bytes back, then returns `end_turn`. No external model, browser profile or user
data was involved. `local/lilly-grok-loop-proof.json` records source hashes,
image/file hashes, sanitized events and confirmed container removal.

The Grok loop's prior prompt-image gate was incorrect for MCP result images. It
now requires HTTP MCP, while ACP prompts remain text-only and live vision remains
explicit opt-in. This is based on the actual binary's observed transport and
pinned source, not an invented capability override. Full private browser
perception/action, live model authorization and production team proof remain
open. This isolated write is not a persistent ArtifactService deliverable.

### Tool-catalog startup checkpoint

The production Grok task loop now waits for the task bridge to serve an
authenticated, SDK-validated tools/list response before sending an assignment.
Session creation alone is insufficient: Grok loads the catalog asynchronously.
The wait is bounded by 30 seconds and the original task deadline, rejects on
cancellation/close, and applies to saved-session loading too. It observes a
served response, not a client acknowledgement of ingestion. No polling delay or
model prompt is used to invent readiness.

The actual source-built binary passes the scripted image/write/read-back turn
using that production barrier and task-bound allow-once permissions: proof
`4b45168b-24ee-479c-b34e-7b5e2940624b` in `local/lilly-grok-loop-proof.json`.
All six source hashes match; the exact temporary container was removed and the
labelled inventory independently checked empty. **690 tests across 40 suites
pass**, including delayed discovery, denied/malformed requests, timeout,
cancellation, saved-session ordering and real SDK HTTP integration. Saved-session
ordering in a test is not proof of real binary restart/resume. No external model,
production data, agent activation or deployment was involved.

### Real saved-session continuity checkpoint

The pinned Grok binary now resumes across a complete isolated container
replacement. The first turn writes one fixture file; its broker token is revoked
and its container removed before a second container mounts the same temporary
state/workspace. The second turn loads the exact session ID, retains the first
prompt's continuity marker and tool receipt in model input, and verifies the
existing file through a replacement read-only MCP catalog. No duplicate write
runs. Both turns complete with `end_turn` using synthetic Responses input only.

`local/lilly-grok-resume-proof.json`, proof
`deb4889c-4b06-4a3d-93b5-0714a5908a9c`, records both stages and six matching source
hashes. **691 tests across 40 suites pass.** Both containers and their exact
generated state directories were removed and absence independently checked.
The first same-container signal-based test failed closed; whole-container
replacement succeeded without increased privileges. Production Kubernetes/PVC
recovery, authoritative reconciliation, browser takeover and live teamwork
remain incomplete. This checkpoint neither enables nor deploys the team runtime.

### Model-free teammate waiting and handoff checkpoint

Both worker engines now receive `team_wait`. It observes inbox replies, up to
eight specified tasks, and optionally shared-whiteboard changes for at most 30
seconds. Waiting uses bounded database reads (up to once per second), not new
model requests. It rechecks the exact active worker claim on every observation
and stops on cancellation or lost authorization. No task, wake, browser action
or completion verdict is created by waiting.

Pass the sent request's `id` as `afterMessageId` and its returned `taskIds` to
include replies that arrived before the wait began. Omit the cursor to observe
only future messages. Only the caller's inbox is returned; cursors from another
inbox are denied. Results are bounded below the native loop's 20k JSON limit,
and pagination advances only across messages actually delivered. Private memory
changes do not trigger a shared-whiteboard wake.

Waiting retains the worker's claim and concurrency slot. If watched work is
queued and all team capacity is occupied, `capacity_blocked` returns immediately
with guidance to finish the turn or do independent work. The same applies to
queued work assigned to the waiting agent, even if another team slot is free:
one agent cannot run two assignments against its workspace at once. It does not secretly
exceed the team budget. Cyclic running-agent waits still expire; a timeout is
neither task success nor permission to retry side effects.

The real runner/model-loop fixture overlaps two teammates: writer saves draft,
requests review, waits quietly; reviewer reads the saved bytes, saves its review,
updates shared memory and replies; writer saves a final artifact. Both slots are
observed active, unchanged waiting makes no extra writer model calls, only two
tasks exist and the reply creates no storm. Three artifact contents are stored
and verified through the scoped artifact adapter. This uses scripted inference
and in-memory storage, not real Grok processes, live models or production storage.

The broad regression checkpoint passed 703 tests across 41 suites. The final
same-agent-slot guard then passed the affected 48 worker/wait tests, including
its new regression. Syntax and whitespace checks pass. No live agent or
deployment was started for these tests.

### Recovery scheduling and fair inventory checkpoint

The shared runtime now schedules the existing reconciliation controller when
`LILLY_TEAMS_RECOVERY_ENABLED=true` and a trusted deployment-supplied
`observeQuiescence` adapter are both present. Recovery can inspect disabled teams
with execution off, without starting models, workers or browsers. Missing
observation support is reported explicitly; no timeout-based takeover exists.
Runtime shutdown retains and awaits an in-flight investigation across repeated
observation deadlines, including already-dispatched database transactions.

Stable-ID pagination and a within-team cursor replace repeated inspection of
the first limited batch. Tests cover progression past healthy/unknown tasks and
beyond 100 teams. The full selected regression run passes **718 tests in 41
suites**. The real isolated PostgreSQL verifier passes **19 checks**, including
105 additional inventory-only teams and cross-pool pagination while timestamps
change. Report: `local/lilly-team-postgres-proof-scheduler.json`, proof
`ddb70916-2667-4343-af0c-0b87d62f04fc`; all 12 source hashes match this checkpoint.
The exact disposable database container was removed and independently confirmed
absent. The production observer, browser-profile takeover and live worker
recovery remain unverified. No production rollout or model-backed canary ran.
See `docs/lilly-team-recovery.md` for the lifecycle and evidence boundaries.

### Exact container ownership checkpoint

Version-2 execution ownership can now include a verified containerd-to-process
binding from a trusted deployment callback. The resolver refuses mismatched or
failed bindings, and the runner freezes and stores the binding atomically with
its claim before dispatch. Model context and workroom projections exclude it.
The read-only node adapter verifies Pod UID/container ID, host kernel identity,
PID/mount namespaces and process start ticks twice to reject replacement races.

The binding mechanism was exercised against the existing primary backend without
changing its Pod or starting a team worker. Report:
`local/lilly-container-binding-proof.json`. Separately, 20 isolated PostgreSQL
checks verify the record's transaction behavior using synthetic binding evidence;
report: `local/lilly-team-postgres-proof-binding.json`. The selected regression
run passes **766 tests across 43 suites**. Source hashes match both checkpoints,
and the disposable database container is independently confirmed absent.

This is not production activation: authenticated node-side transport, deployment
injection, authoritative termination observation and private profile takeover
remain open. No model-backed canary or rollout ran. A bound running container
does not establish that an interrupted agent has stopped.

### Whole process-tree observation checkpoint

The private container binding now optionally includes an exact cgroup-v2
identity. This lets the read-only node adapter inspect the entire process tree,
including nested browser/sandbox processes. A container-stop observation requires
two exact CRI exit reports and positive empty-tree reads of the same bound group;
missing or replaced records remain unknown. This is intentionally not yet the
whole-team recovery receipt or an automatic takeover path.

Real primary verification bound the running backend's cgroup without stopping
it. A separate owned test process proved recursive populated/empty transitions
on the Linux kernel; its group and process were removed and independently absent.
Twenty real isolated PostgreSQL checks preserved the cgroup-bearing identity
with its winning claim. The full selected regression run passes **797 tests
across 45 suites**. Reports are linked in `docs/lilly-team-recovery.md`.

Still required: capture terminal evidence before runtime teardown can remove
the cgroup, connect authenticated node-side observation to all relevant worker
and browser lifecycles, restore private profiles safely, and run the live team
scenario. No production rollout or model-backed agent was activated.

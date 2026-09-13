# Grok Build worker runtime

## Current integration checkpoint: 2026-09-07

An extended **24-check** scripted run now proves automatic independent review:
a third real Grok worker reads both writer outputs, saves its own review, and
records approval through Lilly tools. Approval before read-back is refused;
writer completion and artifact verdicts appear through the authenticated API
and survive fresh SQL reload. All four outputs are downloaded and hash-checked.
Receipt: `local/lilly-team-independent-review-proof.json`. All 260 recorded
hashes match and exact fixture containers are removed. This is model-free
execution/authorization evidence, not live assessment quality or deployment.
The earlier 21-check scenario below intentionally leaves all tasks in review.

Current source now passes the refreshed **21-check** scripted two-Grok-worker /
private-browser / real-product-storage integration, plus **36 real PostgreSQL
transaction checks**. All 260 integration and 28 SQL recorded hashes match;
temporary containers were removed. This uses Node 24.18.1 and fixed inference,
not a live model or the deployed Kubernetes computer path. Tasks remain in review.
Receipts and exact limitations: `docs/lilly-team-system.md`.

The missing dedicated host-service Kubernetes identity now has an offline RBAC
renderer, with separate per-node accounts and explicit named-volume GET grants.
It emits no credentials or workloads and has not been applied. **1,272 tests /
71 suites** pass in `local/lilly-node-rbac-jest.json`. Credential provisioning,
API-server authorization/admission and combined recovery remain unverified.
See `docs/lilly-node-rpc.md` for the permissions and deployment limitations.

The current ARM64 recovery helper has been rebuilt and passes nine real isolated
container checks with matching source hashes and verified container cleanup.
It remains undeployed; this refresh makes no model calls and does not establish
the combined live Kubernetes handoff. See `docs/lilly-computer-transport.md` for
the candidate manifest digest, distinct config image ID and proof limitations.

Latest source fix: a lost graceful browser shutdown reply no longer permanently
occupies an already recovered workspace when fresh durable evidence confirms
exact closure. The read-back is private and read-only; uncertain cleanup still
blocks, and no agent/model/tool operation is replayed. **1,254 tests / 70 suites**
pass in `local/lilly-confirmed-cleanup-jest.json`, including the composed
task-result handoff. These new cases use simulated cluster inputs and are not
deployed. Details: `docs/lilly-team-recovery.md`.

Grok Build runs as a private execution worker beside Lilly, not as a second
public chat application. Lilly owns the public frontend, task/tool authorization,
durable team state and artifact read-back. The source-built Grok runtime connects
through ACP and the task-scoped MCP bridge; private browser pixels stay on the
agent path rather than becoming an operator screen stream.

The native node-service entrypoint and an uninstalled systemd template now join
the existing authenticated transport. **1,234 tests / 69 suites** pass in
`local/lilly-node-systemd-jest.json`. An eight-check transient systemd proof passes
on Node 24.18.1 with real restricted PostgreSQL access, enforced capabilities and
resource limits, mutual TLS and clean shutdown (`local/lilly-node-systemd-proof.json`).
It exposed and fixed missing `AF_NETLINK` support for startup interface discovery.
The host's older default Node was also discovered; the template requires a
dedicated runtime. This does not establish boot-time installation, real recovery
operations under these limits or real-model production operation. No deployed feature flag
has changed. See `docs/lilly-node-rpc.md` for the service contract and remaining
acceptance checks. Earlier counts and image proofs below are historical
checkpoints, not current end-to-end deployment proof.

The removed-cgroup recovery prerequisite also passes four real k3s checks in
the explicitly approved async-lab fixture (`local/lilly-retired-owner-k3s-proof.json`).
The node reader rejected the live owner and then confirmed exact CRI exit plus
independent kernel retirement. The temporary Pod/network policy were removed;
no model ran and no project files were mounted. Combined browser profile recovery
and production team execution remain unverified.

## Earlier implementation checkpoints

Status: ACP adapter, Kubernetes supervisor and task broker implemented and
fixture-tested. The pinned ARM64 source image now builds and passes a real
networkless version/provenance/ACP-initialize probe. A second real-binary probe
now completes a scripted broker/MCP image and file-write round trip. A further
probe loads the same session and reads the existing file after replacing the
entire isolated container. Two real Grok worker containers also complete a
scripted Lilly request/wait/review/reply flow with PostgreSQL-backed team state
and artifacts reloaded through fresh services. Real
model inference/perception, production team execution, Kubernetes recovery and
deployment remain unverified.

The authenticated node connection is now source-wired: backend-only mutual-TLS
credentials, pinned node routes and an explicit `kubernetes` computer transport
setting connect the existing supervisors. Default execution remains inactive;
no public endpoint or worker credential is added. **1,205 tests / 67 suites**
pass, with real local TLS and simulated node/database work. Host-service
deployment, current image proofs and the combined live scenario remain unverified.
See `docs/lilly-node-rpc.md`.

The latest source checkpoint connects browser shutdown to the node recovery
operations: an exact stop receipt is persisted and read back before browser Pod
deletion, then mounted profile recovery must be acknowledged before release.
**1,158 tests / 65 suites** pass, including composed real adapter/service logic
with simulated Kubernetes/kernel inputs. `createNodeComputerOperations` provides
the four private supervisor callbacks without activating resources. Authenticated
node transport and combined real-cluster recovery remain unverified; this does
not establish live Grok perception or production readiness.

Current recovery composition: `src/agent-computer/recovery-runtime.js` now joins
the helper launcher, mounted controller, exact node stop request and durable stop
archive behind one inactive `recover` entrypoint. **1,147 tests / 65 suites** pass,
including a composed lost-stop-reply/restart flow. The installed node CLI interface
was inspected read-only; the new lifecycle scenarios still use simulated cluster,
kernel and database inputs. Authenticated node routing, real combined recovery,
browser termination ordering and deployment remain outstanding. Historical image
and source-hash claims below apply to their recorded checkpoints, not automatically
to current source. See the latest node recovery checkpoint in the transport doc.

Latest private-computer integration: the Kubernetes browser factory now composes
with Lilly's durable task ownership, and the packaged ARM64 browser worker passes
fourteen real networkless checks, including standalone CLI EOF/SIGTERM shutdown,
same-worker close/reopen, retained ownership for independent recovery and profile
reuse by a fresh worker process with a new lease UUID.
The factory itself has only simulated Kubernetes
API/observer proof; node-side profile cleanup, network policy and deployment remain
unverified. See `docs/lilly-computer-transport.md` for the source/image provenance,
1,097-test regression, retained PID-limit failure and exact-container cleanup evidence.
The browser supervisor additionally requires a durable node/kernel/cgroup binding
before private exec, and a durable positive stop receipt before closing that lease.
Its node reads remain simulated; the real isolated SQL proof passes 36 checks,
including immutable stop/profile-recovery receipt persistence and read-back after
observer reconstruction. Node-bound terminal leases now require both receipts.
The filesystem recovery component also passes six real non-root Linux checks for
exclusive directory locking, atomic retirement and preserved profile bytes. Its
stop evidence is synthetic; verified PVC mounting and helper transport remain
unwired. Durable recovery acknowledgment is implemented but its live observer
inputs and deployed end-to-end path are not yet proven.
The node-local PVC/PV-to-directory verifier is now implemented with two-sample
API/kernel/filesystem checks and six real Linux fixture checks. Its metadata
contract follows read-only inspection of the live storage layout; the recovery
helper launcher and actual worker-volume acceptance remain unverified.
An additional read-only mount observer now checks the helper's opened directory
against its kernel mount ID and process identity; seven real isolated container
checks pass. Durable helper reservation, Pod/CRI binding and positive stop
observation are now implemented and fixture-tested; the SQL proof includes
single-winner helper ownership, lost launch acknowledgment and a stop-before-release
gate. The helper lifecycle factory now connects launch, mounted recovery and
archived-stop-before-deletion handling with simulated Kubernetes/node callbacks.
Its live node adapters and deployed mounted recovery remain unverified, so this
is not live automatic recovery.
The private recovery command now has its own pinned ARM64 image and nine real
networkless container checks: exact locked retirement, preserved profile bytes,
an open-stdin framed request and a fresh read-back-only command for lost replies.
The mounted recovery controller now composes verified mount observations,
single-dispatch SQL intent, the private command and durable receipt read-back;
its combined observation inputs remain simulated. Live helper provisioning,
stop archival/termination and deployment remain unverified. See the latest transport
checkpoint for current image/proof IDs and the distinction between proof scopes.

## Terminal browser shutdown checkpoint (2026-09-07 UTC)

The actual browser runtime now fences future and queued requests when disposed,
reauthorizes its lifecycle after pending policy calls, and retains pending profile
acquisition through timeout/cleanup. Late captures cannot recreate observations.
Repeated disposal uses the same cleanup promise; failed closure retains its lease.
This fixes in-process shutdown races, not missing node-level crash observation.

The expanded real-services run passes **21 checks**, including rejection of a
browser reopen after real context cleanup. Report
`local/lilly-grok-team-shutdown-proof.json` is proof
`a33b2dfc-b25b-4315-866d-894d2de3c58c`; database report
`local/lilly-grok-team-shutdown-database.json` is proof
`e751b9df-94e0-4214-9bef-28c4d50afb48`. All 251 recorded loaded source/dependency
hashes independently match the checkout, including runtime SHA256
`5515777789398b98239cc2122a8f319fb9b28bba4dba0902bb121762a2a9bfb0`.
The same pinned Grok and matched browser images were used with current runtime
source mounted read-only. One browser click, three authenticated artifact
downloads, zero external model calls and closed product connections were verified.

The exact worker label, browser name and database name inventories were empty
after teardown. The host seccomp baseline hash remains unchanged. Synthetic
artifacts and reports remain in the disposable proof directory; worker private
mounts and all test containers were removed. Focused regression: **820 tests in
44 suites**, including six controlled-delay lifecycle cases. No deployment or
live agent activation occurred. Production supervisor transport, node-level
quiescence, full-server/live visual proof and live inference remain unverified.

## Real Lilly services and authenticated HTTP checkpoint (2026-09-07 UTC)

The isolated combined run now passes **20 checks** with the actual SessionStore,
ArtifactService, PostgreSQL schema initialization, authentication/login middleware,
artifact routes and team workroom routes. `bin/lilly-team-services-proof.js` boots
these existing modules in a dedicated fixture process; it does not substitute a
production database or start the full application server. Enable this variant by
appending `--full-services` to the combined browser/team proof command.

- Team report: `local/lilly-grok-team-full-services-proof.json`, proof
  `cd743204-a9bd-4e8b-9a50-989ccbc7fbc3`.
- Database report: `local/lilly-grok-team-full-services-database.json`, proof
  `ef4b7739-ee87-4a31-b2a0-3330c609504b`.
- All 251 recorded loaded source/dependency hashes independently match the
  checkout. The source-built Grok and matched browser image digests are unchanged.
- Two actual workers overlap while the writer waits for its reviewer without
  model polling. An authenticated workroom HTTP read observes that live state.
- A fresh real SessionStore reloads both owned agent sessions and rejects a
  foreign owner. Three real ArtifactService outputs are downloaded through the
  normal authenticated routes and matched to their recorded lengths and hashes.
- Anonymous and invalid authentication are rejected; foreign-owner artifact and
  workroom reads return 404. Workroom responses are no-store and omit image data.
- Exported synthetic artifacts in `local/lilly-grok-team-full-services-artifacts/`
  were separately retrieved and all three byte lengths and SHA256 hashes checked.
- The process permits only its exact disposable PostgreSQL socket and its own
  registered loopback listeners. Zero external model calls, production database
  access or unexpected network attempts were recorded. Product connections closed.
- Exact worker label, browser name and database name inventories were independently
  checked after teardown: all empty. Reports and synthetic exports remain.

The first bootstrap attempt lacked the host's `qrcode` dependency and stopped
before workers launched. Repository-installed qrcode 1.5.4, pngjs 5.0.0 and
dijkstrajs 1.0.3 were copied only into the disposable source directory; shared
dependencies were not changed. Initialization failure now closes the product pool.
The focused regression passes **811 tests in 44 suites**, using isolated session
test data. Earlier session-test writes to the default user directory were denied;
the isolated rerun passed. A broad test pattern also selected archived local source
copies and was stopped; the reported result uses explicit current-checkout paths.

This proves composed real-service HTTP integration, not full-server startup,
rendered live operator UI, live model reasoning/perception, deployed private-browser
transport, long-run reliability or Kubernetes recovery. No deployment or live-model
activation occurred. The next release still needs those production acceptance gates.

## Matched browser-engine candidate (2026-09-07 UTC)

The screenshot timeout is now located after the actual click: report
`local/lilly-grok-team-browser-phase-failure.json`, proof
`d20c72f1-d1ab-4f43-b8a4-64bc74f69a6d`, records `computer_timeout` in the
`screenshot` phase with exactly one fixture POST. The preceding two unchanged
runs passed; repetition alone was not a fix. A bounded test-only protocol
recorder now keeps fixed command names, completion states and timings, never
arguments, page results, URLs, credentials or pixels. Its internal driver hook
is explicitly limited to Playwright 1.53; newer drivers report that protocol
tracing is unavailable rather than presenting an empty trace as proof.

The old fixture used Playwright 1.53.0 (manifest Chromium 138.0.7204.15) with
stock Chromium 152.0.7977.75. That pairing is not guaranteed by Playwright:
https://playwright.dev/docs/api/class-browsertype#browser-type-launch
This is a verified compatibility risk, not a proven single cause of the stall.

A separate browser-only ARM64 candidate now builds from
`src/agent-computer/browser-engine.Dockerfile`. It pins the cached Node base by
digest, verifies the Playwright 1.63.0 package archive against its npm SHA512,
and installs that driver's bundled Chromium. The running browser version is
asserted against the driver's browser manifest, not just an image label.
Upstream release: https://github.com/microsoft/playwright/releases/tag/v1.63.0

- Image: `sha256:0c2ef934968082931d5dbb1023a3a285771028ef8430bb861bfe4feb91c99a39`
- Local tag: `localhost/lilly-browser-engine:playwright-1.63.0`
- Actual driver/browser: Playwright 1.63.0 / Chromium 153.0.8010.12
- Build source: `/tmp/lilly-browser-engine-source.ha1D2v`
- Dockerfile SHA256: `6b2d463e6ca0cc669a75c894c1de13d27bc6bef8aa95557fbe26b0af7b30bcf8`
- Installer SHA256: `5fc68d7beb41fcde9e1618d4ec9906fecbd1a0b7cecbc013719be01493234bf4`

Both build source hashes independently match the local files. This component
image has no model, provider credentials, user workspace or self-starting
agent. Its default command refuses to impersonate a complete service; a
private supervisor transport is still required. Dependency/browser downloads
occur only during the build. The image is 1,290,857,160 bytes and runs as
10001:10001. It is neither pushed nor deployed, and the main package lock and
running Lilly browser dependencies are unchanged.

The candidate passes **six consecutive 16-check combined runs** under the
same sandbox/resource constraints with real Grok workers and isolated SQL.
The first report is `local/lilly-grok-team-matched-browser-proof.json`
(`91047b95-1dc8-4a03-a170-b6aacce2b557`); the five additional reports are
`local/lilly-grok-team-matched-repeat-{1..5}.json`, with IDs:

1. `1b6127e3-3333-4ace-84f6-4d7e2d06335e`
2. `f630f79a-2022-4c66-8dd8-719cb1b9e79b`
3. `bf775352-ac4c-4d35-964e-9f0b869f11a6`
4. `406febca-b8b5-4d5a-bc38-6087cfcffc5e`
5. `7af6ae49-740f-417a-9633-8ef4d885d9a2`

Each report's 27 source hashes match the checkout. Each records one click,
three independently SQL-read artifacts, zero external model calls and the
actual paired browser version. The first run's exported artifact bytes were
retrieved into `local/lilly-grok-team-matched-browser-artifacts/` and their
lengths/hashes independently verified. Selected regression: **843 tests in
49 suites**, plus syntax and diff whitespace checks.

The first run and all five repeats had their exact worker-label, browser-name
and database-name container inventories independently checked after teardown;
all were empty. Database repeat reports are retained as
`local/lilly-matched-browser-db-repeat-{1..5}.json`. The host seccomp hash is
unchanged, and `backend-56cbbc96bc-ffz67` remains 1/1 Running with zero restarts.
Disposable containers/private tmpfs are removed; exported artifacts and reports
remain available. The pre-existing stopped/error pods were not modified.

The previous screenshot failure is not erased or claimed fully explained.
Six successes support selecting this matched candidate for the next integration
stage; they do not prove long-run reliability, perception, authenticated
operator/workroom delivery, production browser transport or crash recovery.

## Two Grok workers, a separate browser and durable SQL (2026-09-07 UTC)

The opt-in `--browser-image` mode of `bin/lilly-grok-team-proof.js` now combines
the real source-built workers with a third, separately sandboxed browser
container and isolated PostgreSQL. Report
`local/lilly-grok-team-browser-proof.json`, proof
`1da5b017-8475-4322-a366-4cb056094a98`, passes **16 checks**. All 27 recorded
source hashes match the tested checkout. The three SQL-read artifact exports
were retrieved into `local/lilly-grok-team-browser-artifacts/`; their byte
lengths and SHA256 values independently match the report.

The writer receives actual private Chromium frames through the production
team worker, ACP and task MCP path, clicks once, writes a draft and waits
without model polling while the second real Grok worker reads and reviews it.
Shared memory, request/reply messages, two ACP session IDs, three artifact
rows and settled browser operation journals survive fresh SQL service reload.
Both workers and the browser have independently checked distinct PID
namespaces. Browser profiles are not mounted into either worker, and image
bytes are absent from durable team state. Reusing the stale original frame
is rejected without another click.

`bin/lilly-team-browser-proof.js` is a bounded test-only stdio transport, not
a production browser service. The browser keeps Chromium sandboxing, zero
capabilities, enforced AppArmor, scoped seccomp and network isolation. All
four exact disposable containers were independently confirmed absent after
the proof. The existing production backend remained 1/1 with zero restarts;
no deployment or external model calls occurred.

Reliability remains unresolved: an earlier 14-check combined run passed, but
another repeat timed out in `computer_act` after the page had received its
single click. That failure is retained in
`local/lilly-grok-team-browser-repeat-failure.json`. The fixture now stops
scripted model requests after its first dispatch failure and records bounded
click/screenshot phase diagnostics; it never retries an uncertain action.
The latest 16-check success does not identify or fix the intermittent timeout.

Limits: inference and selectors are scripted (12 writer and 8 reviewer model
requests, zero external calls). Session persistence still uses the minimal
SQL parent-row adapter, not full SessionStore/ArtifactService/authenticated
operator HTTP. Real model perception, workroom end-to-end integration,
production Kubernetes lifecycle and crash recovery remain unverified. This
is an integration checkpoint, not a deployed unified service.

## Actual Grok and actual sandboxed browser (2026-09-07 UTC)

`local/lilly-grok-browser-proof.json`, proof
`42c8f7cc-b70c-4f89-805d-bc3464cb6d5f`, connects the pinned source-built Grok
binary to the production `AgentComputerRuntime`, ACP client, worker broker and
task MCP bridge. It passes the seven real browser checks plus five connected
Grok checks. Eight source hashes independently match the tested checkout.
The selected regression passes **839 tests across 49 suites**; syntax and diff
whitespace checks also pass. Nothing from this checkpoint has been deployed.

The real Grok process discovers the fixture's two browser tools through its
native `search_tool`/`use_tool` path. The observation tool supplies the actual
Chromium PNG; the next model request is checked for identical typed image bytes
and the current frame ID. A scripted response then calls the action tool with
that ID. The actual page receives exactly one POST, and the changed screenshot
arrives in the subsequent Grok model request. Grok returns `end_turn`. The stale
original frame cannot trigger a second click. Operator activity contains only
bounded tool lifecycle events, not image bytes. Revoking the worker lease is
verified with HTTP 401. Five scripted model requests, zero external calls.

The helper `bin/lilly-grok-browser-proof.js` is an explicit mode of the existing
private-browser proof, not a new production runtime. A stopped container is
used solely to copy `/opt/grok/bin/xai-grok-pager` from the immutable Grok image;
its binary SHA256 is checked against the earlier source build before execution.
That extraction container is removed without ever being started. The binary is
mounted read-only into the browser fixture image. This integration container
has network `none`, UID 10001, read-only root, zero capabilities,
no-new-privileges, enforced default AppArmor, scoped setns/chroot seccomp,
1536 MiB/two CPUs, private IPC and a 90-second hard lifetime. Worker home,
workspace and browser profiles are private tmpfs. No provider keys are present.

Both exact containers are independently confirmed absent before accepting the
result; ACP closure alone is not considered process termination. The original
host seccomp hash is unchanged and the live backend remains 1/1 with no restarts.
An earlier successful connected run, proof
`b12b53c4-85e3-4f69-b149-cdf7ef621aa1`, is retained in
`local/lilly-grok-browser-proof-initial.json`. Its top-level `modelCalls: 0`
counter was inherited from the browser-only test; the nested record correctly
shows five scripted requests. The new report fixes that accounting ambiguity.

Limits: inference and selector choice are scripted, so this is not evidence of
visual understanding. Browser and worker share a disposable container here;
this does not prove production OS-level isolation between them. Runtime
ownership checks are exercised, but this fixture does not run `TeamRunner`,
`TeamService`, durable stores, artifacts, authenticated operator HTTP/UI,
Kubernetes supervision or crash recovery. The earlier selector timeouts remain
recorded in `docs/lilly-private-computer-proof.md`; two connected successes are
not long-run reliability proof. Next combine this path with durable team/output
flows and prove production lifecycle before a separately approved live-model run.

## Two Grok workers with durable SQL state (2026-09-07 UTC)

The team proof now uses the production `TeamStore` and `ArtifactStore` against
an isolated PostgreSQL 16.15 container. It no longer uses `TestStore` or files as
the backing store for team/artifact operations. The existing database proof's
fixed, network-none setup is shared through a trusted callback; neither script
accepts a database URL or production credentials. The default standalone entry
still runs its original transaction/recovery checks.

The actual Grok writer and reviewer complete the same request, bounded wait,
independent draft read, shared memory, reply and final-write sequence. After
both exact worker containers are removed, new store/service instances using a
second database pool reload the identical team state, messages, memories and
two saved ACP IDs. They reject a different owner and read exactly three artifact
rows. Every byte is compared against the expected draft, review or final content
and its SHA256. These SQL-read bytes are then exported solely to retain proof
outputs after the disposable database is removed.

Evidence:

- `local/lilly-grok-team-postgres-proof.json`, proof
  `61d72ef6-e0af-4266-b0c9-ece6a46c8446`: ten connected-path checks, 24 matching
  source hashes. Writer and reviewer each made eight scripted model requests.
- `local/lilly-grok-team-postgres-container-proof.json`, proof
  `2ef00005-923c-454d-aa5c-0f8c96f04530`: the same run's isolated database image,
  resource limits and confirmed removal; 15 matching source hashes.
- `local/lilly-team-postgres-proof-shared-runner.json`, proof
  `a33ecc89-df62-4dc0-8b46-36437c64b613`: standalone regression after the setup
  extraction, all 23 checks pass; 15 matching source hashes.
- `local/lilly-grok-team-postgres-artifacts/` contains the three UUID-named
  exported files. Their hashes were independently matched after retrieval.

All four disposable containers (two workers and two sequential databases) and
worker private mounts were independently confirmed absent. Production storage
was never accessed; backend stayed 1/1 Running with zero restarts. The selected
regression run passes **816 tests across 47 suites**. No release, live-model
canary or existing agent was activated.

This proves fresh-service SQL reload, not a full host/database restart or ACP
resumption in this particular run (the separate container-resume proof remains
historical evidence). Session parent rows use a minimal SQL adapter, and artifact
creation maps the worker input directly to production `ArtifactStore`; the full
`SessionStore`, `ArtifactService`, authenticated HTTP routes and UI are not part
of this proof. Tasks remain `needs_review`, not automatically approved. Scripted
inference, lack of a real browser, test-only Podman supervision and missing
Kubernetes crash recovery remain explicit limits. Next prove the private browser
path and deployed lifecycle, then perform a separately approved live-model run.

## Two real worker containers and Lilly teamwork (2026-09-07 UTC)

The initial `bin/lilly-grok-team-proof.js` checkpoint ran the pinned source image twice through
the production ACP client, `TeamRunner`, `createTeamWorker`, Grok task loop,
task-bound MCP policy and authenticated worker broker. This is no longer a
simulated Grok process: each agent has a separate container, PID namespace,
home/workspace mount and saved ACP session. Both containers were observed
running concurrently with distinct host PIDs.

Report `local/lilly-grok-team-proof.json`, proof
`c706d059-7486-47e3-830d-a13c916e258e`, passes seven connected-path checks:

1. Writer saves `draft.md`, sends one request and calls `team_wait`.
2. Lilly admits one reviewer task while the writer is waiting. The writer makes
   no additional model request during an observed 400-ms quiet interval.
3. Reviewer reads the actual draft bytes through `artifact_read`, saves
   `review.md`, posts a shared team memory and sends an informational reply.
4. Writer receives that reply through the waiting tool and saves `final.md`.
5. The reply creates no additional task; there are exactly two assignments and
   two different saved ACP sessions.
6. The proof supervisor revokes each lease and stops/removes its exact labelled
   container before the production Grok task loop accepts its report. Closing
   ACP alone is not considered termination.
7. All three files are independently read back and hashed. Both task results
   remain `needs_review`; this is not a fabricated owner approval.

Writer used eight scripted model requests and reviewer used nine, including
native discovery/auxiliary requests. Twenty source hashes match the local
checkout. The selected regression run passes **816 tests across 47 suites**.
The first setup attempt exited before creating workers because two imported
modules were absent from the copied source bundle; the corrected bundle includes
them and the successful report hashes them.

Each nonroot, read-only, capability-dropped container has network mode `none`,
512 MiB/one CPU and a hard container lifetime limit. A fixed Unix-socket relay
exposes only the fixture's authenticated broker to a worker-local loopback port;
it cannot forward to arbitrary hosts. No upstream provider credentials or
production mounts enter a worker. The shared socket directory contains only
the socket; private launch tokens live in separate worker mounts and are revoked
and removed after confirmed whole-container cleanup. Both exact containers and
their private directories were independently confirmed absent. Source, reports
and synthetic artifact files are retained in their isolated proof directories.

Limits: inference is scripted; team/session transactions use an in-memory test
adapter; artifact storage is an isolated file adapter, not ArtifactService or
PostgreSQL. There is no actual browser, visual perception, Kubernetes supervisor,
PVC recovery, crash reconciliation or production operator UI in this proof. The
private relay/Podman entrypoint is test infrastructure, not a deployment adapter.
Next combine this connected two-worker path with real isolated durable stores,
then verify production lifecycle/browser behavior before a separately approved
model-backed canary. No production release or live-model agent was activated.

## Real source-image checkpoint (2026-09-07 UTC)

The existing bounded recovery completed with exit 0; compilation took 112m39s.
No duplicate compiler or production rollout was started. Immutable local image:
`sha256:e238d45932f634fc822928426ae4af96a26539f324c553cbfc3db29aa971d87c`.
Binary SHA256: `16d8494a4b43e377d2b3afb3993982f2683ba2e434bf5769a3b625b27922d0fc`.
Version: `grok 1.0.16 (72a61251fcff)`.

`local/lilly-grok-image-proof.json` records actual protocol version 1,
`loadSession: true`, HTTP MCP support, and **image input not advertised**.
That initialize-only observation does not prove a private screenshot reaches
the model. The subsequent MCP-image transport proof below now establishes the
transport path, but not real model perception.
Session loading has now been exercised across isolated containers as recorded
below; production Pod/PVC recovery remains unverified.

The first probe failed because Podman 4.9 rejected uid/gid tmpfs mount options.
The corrected probe uses container-private sticky tmpfs directories, remains
UID 10001 with a read-only root, drops capabilities, and has no host mounts,
credentials or network. It creates no ACP session and makes no model call.
All labelled probe containers were removed and absence checked independently.

## Real Grok and Lilly tool-loop checkpoint

`local/lilly-grok-loop-proof.json`, proof
`4b45168b-24ee-479c-b34e-7b5e2940624b`, runs the actual pinned binary with the
production Lilly ACP client, model configuration generator, worker broker and
MCP bridge. A synthetic Responses endpoint runs in the same network-none
container; it uses no provider key and makes zero external model calls.

Observed flow: initialize, API-key method with a local ephemeral broker token,
session/new, MCP initialize/tools/list, native `search_tool` discovery, native
`use_tool` invocation of the private image tool, then a second MCP tool that
writes a fixed file and independently reads its bytes. A 64x64 synthetic PNG
arrives byte-for-byte as typed `input_image` in the subsequent model request.
Only bounded tool events, not image bytes, reach the activity sink. The ACP turn
ends with `end_turn`; five bounded scripted model requests were observed.
An attempted `grok-4.6` request was rejected by the broker's exact-model policy;
it did not invoke an external provider or bypass the configured route.

This checkpoint uses the production task-bound MCP permission policy, not a
permissive fixture handler. Lilly binds the exact server and tool names before
session creation. Only matching `UseTool` requests in the active session can
select an offered `allow_once` option; native tools, other servers/tools,
malformed requests and persistent approval are denied by this policy. The tool
dispatcher still enforces task ownership, schemas and authorization separately.
The focused regression run passes 690 tests across 40 suites. This is not proof
that every native operation requires an ACP permission request or is sandboxed.

The first scripted attempt ran before Grok's asynchronously loaded MCP catalog
was ready. The production bridge now provides an abortable `waitForCatalog`:
only an authenticated, SDK-validated tools/list request whose HTTP response
finishes successfully releases it. Initialize, denied requests and malformed
requests do not count. Closing the bridge revokes readiness, including previously
served catalogs. This observes server-side delivery, not client-side ingestion.
The production Grok task loop waits after persisting its session and before
prompting (also when loading an existing session), for at most 30 seconds within
the original task deadline. Missing readiness, timeout or cancellation prevents
the prompt and follows normal supervised cleanup. The real-binary proof now uses
this same production barrier, not its earlier polling workaround. Grok discovers
tools lazily rather than advertising every MCP function
in its initial model tool list. These are real runtime behaviors, not mock-client
assumptions. A fixture subprocess also outlived ACP close; container-level
termination and independent absence checks, not transport close alone, bound
this proof's lifecycle. Production supervisor cancellation/resume still needs
its own real-cluster proof.

The pinned source explains the apparent capability mismatch:
`xai-grok-shell/src/agent/mvp_agent/acp_agent.rs` advertises embedded context but
omits image prompt support. `xai-grok-mcp/src/servers.rs` converts MCP image blocks
to data URIs; `xai-grok-shell/src/session/acp_session_impl/tool_calls.rs` extracts
them into image content for the next model request. Per the
[ACP initialization contract](https://agentclientprotocol.com/protocol/v1/initialization),
`promptCapabilities.image` applies to `session/prompt` attachments, not MCP tool
results. The Lilly Grok loop now gates private computer tools on HTTP MCP support
instead. ACP prompts remain text-only; vision execution remains opt-in.

The isolated file is a transport fixture in tmpfs, not a persistent Lilly
ArtifactService/team result. This proof does not establish real model visual
understanding, browser action accuracy, production authorization, live teamwork,
or production saved-session recovery. The runtime uses installed MCP SDK 1.29.0;
verify again after dependency upgrades. Its six hashes identify that checkpoint's
tested source; the newer resume report records the extended probe source.
The container was nonroot/read-only with bounded tmpfs, no network, and only
read-only mounts for these proof sources, Node and the installed dependency tree.
No user workspace, credentials or browser profile was mounted. Test containers
were removed and the labelled inventory was independently empty.

## Real container-restart and session-continuity checkpoint

`local/lilly-grok-resume-proof.json`, proof
`deb4889c-4b06-4a3d-93b5-0714a5908a9c`, runs two sequential containers from the
same pinned image. Stage one writes the fixture once, persists its ACP session
and verifies the revoked broker token receives HTTP 401. Only after the first
container is confirmed absent does stage two mount the same temporary state and
workspace. Its new broker lease and MCP catalog offer only `lilly_probe_read`.

The real binary loads the exact saved session ID, discovers the replacement
catalog and completes another turn. Its first resumed model request contains a
random continuity marker from the original prompt and the original tool-result
file hash; neither is supplied in the resumed prompt. The read tool verifies
the original file hash and no second write tool runs. Stage one uses five
scripted model requests; stage two uses four. Both return `end_turn`.

An earlier same-container restart approach failed with `EACCES` on both group
and individual process signaling. Those failed reports remain in the isolated
remote proof directory. The test did not add privileges or ignore the failure:
it now uses whole-container termination and absence checks. ACP `close()` alone
still does not prove descendant termination.

The two fixture directories start empty, are UID-10001-owned and mode 0700, and
contain no user data or provider credentials. Containers have no network, a
read-only root, dropped capabilities and bounded resources. After both exact
containers are gone, only those verified, generated directories are deleted.
Independent checks confirm no labelled containers or either fixture directory
remain. The report retains six matching source hashes; 691 tests across 40
suites pass. No production service was changed or model-backed task activated.

This proves isolated real-binary session continuity and read-back, not live
model understanding, browser-profile takeover, in-flight cancellation semantics,
Kubernetes supervisor deletion, PVC attachment, controller reconciliation or
automatic retry safety. Those remain separate acceptance gates.

## Ownership and isolation

Lilly remains the coordinator for teams, identities, memory, task dependencies,
budgets, permissions, lifecycle, and durable artifacts. Grok Build is a worker
engine, not another independent company scheduler. One adapter instance owns one
process and one session; parallel workers require separate instances and isolated
workspaces/homes. The adapter is wired through the explicitly opt-in team runtime,
not to an unguarded shared route or automatic agent startup.

Use a non-root Linux container per trust boundary with only its assigned workspace
and dedicated state volume mounted. Do not mount the host home, Docker socket,
Kubernetes service-account credentials, broad shared project directories, or Lilly
secrets. Set resource limits and a restricted network policy. The process must be
supervised so child processes are reaped on timeout or cancellation failure.

ACP client permission rejection is **not a filesystem or shell sandbox**. Grok's
own built-in tools can operate without client terminal/file capabilities. Audit
the pinned runtime's sandbox and tool policies before allowing real jobs. MCP
configuration is trusted operator configuration, never model-generated data:
stdio server commands themselves execute programs, and HTTP endpoints need
project-scoped credentials and an explicit destination allowlist.

Container isolation alone is not network or tool authorization: enforce egress
destinations, MCP per-tool/per-project permissions, budgets, and approval gates
outside the container. A non-root worker still has whatever access its mounted
files and credentials grant. Do not add privileged mode to make a sandbox test
pass; prove kernel sandbox support and fail closed if it cannot be enforced.

## Verified upstream contract

The [Grok headless integration documentation](https://docs.x.ai/build/cli/headless-scripting)
specifies `grok agent stdio`, newline-delimited JSON-RPC, version-1 initialization,
authentication, session creation, prompting, and streamed session updates. Its
documented update-disable flag is included so source-pinned workers do not update
themselves. Authentication is explicitly selected, never silently initiated by
the adapter.

[ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
defines capability-gated loading of an existing session and MCP connection
parameters. [ACP prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn)
define cancellation as a notification, with completion acknowledged through the
pending prompt response. [ACP permission requests](https://agentclientprotocol.com/protocol/v1/tool-calls)
define selected option IDs and cancelled outcomes.

The local adapter:

- Implements initialize, optional authenticate, session/new or capability-gated
  session/load, session/prompt, session/update, and session/cancel.
- Accepts only text ACP prompts. Private images travel through MCP tool results;
  the real-binary synthetic transport proof above verifies that path. A real
  browser-vision loop still requires a separately verified model/perception path.
- Advertises no client filesystem or terminal capability; unsupported incoming
  methods receive JSON-RPC method-not-found responses.
- Defaults permission requests to cancelled. The Lilly team loop installs the
  task-bound MCP allow-once policy above before session creation; a standalone
  caller must explicitly configure its policy. Cancellation, handler failure,
  and timeout deny the request; late approvals are ignored and the handler
  receives an abort signal.
- Bounds frames, pending requests, per-turn streamed output, deadlines, and stdin
  backpressure. Fatal protocol/timeout/exit errors reject outstanding requests.
- Does not accumulate response text. Consumers subscribe to private `update`
  events; `prompt()` returns completion metadata. Streamed content is untrusted
  and may include secrets, images, or reasoning; do not broadcast it wholesale.
- Discards stderr content and replaces upstream error messages with stable local
  codes. Events are not automatically logged or published. Lifecycle events are
  observations, not proof that an artifact was written or that cancellation has
  terminated all subprocesses.

## Calling the adapter

```js
const { GrokBuildAcpClient } = require('../src/grok-build/acp-client');

const worker = new GrokBuildAcpClient({
  executable: '/opt/grok/bin/xai-grok-pager',
  cwd: '/workspace/assignment',
  home: '/state/worker-identity',
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', XAI_API_KEY: scopedWorkerKey },
});
worker.on('update', update => privateSessionEventSink(update));
worker.on('lifecycle', event => executionLedger(event));
try {
  await worker.start({ authMethodId: 'xai.api_key' });
  const { sessionId } = await worker.openSession({ mcpServers: approvedProjectMcpServers });
  // Persist sessionId with Lilly owner/project/worker identity before assigning work.
  const result = await worker.prompt('Complete the bounded assignment.');
  // result.stopReason is not artifact proof: read back and validate actual outputs.
} finally {
  worker.close();
}
```

The caller provides existing absolute workspace and private-home paths. The
adapter never creates directories. It passes no inherited environment. Only
allowlisted explicitly provided environment variables are accepted. For a
configured Lilly model endpoint, `LILLY_MODEL_API_KEY` is an explicit supported
key name; its inclusion does not itself configure a model or establish gateway
compatibility. HOME, USERPROFILE and XDG directories are derived from the private
home, and GROK_HOME is forced to `<private home>/.grok`. Neither host GROK_HOME nor
a caller environment override is inherited. After process
restart, create a new adapter with the same isolated state and call
`openSession({ sessionId, mcpServers })`. Resume succeeds only if the runtime
advertises `loadSession`; otherwise stop and report the missing capability rather
than creating a replacement session and pretending continuity.

## Pinned source and ARM64 build feasibility

Inspected 2026-09-06. Candidate public source revision:
[`72a61251fcffb464bcc687aeb5a998e5a98ec0c9`](https://github.com/xai-org/grok-build/commit/72a61251fcffb464bcc687aeb5a998e5a98ec0c9).
The separately recorded upstream monorepo `SOURCE_REV` was
`a549186d9d39311f2d3ee4208db62af8c65aa476`; that is not the public checkout SHA.

The [source README](https://github.com/xai-org/grok-build) names Rust and DotSlash
as prerequisites and macOS/Linux as supported build hosts; Windows source builds
are best-effort. Its documented release package is `xai-grok-pager-bin`, producing
`target/release/xai-grok-pager`.

The [Rust toolchain manifest](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/rust-toolchain.toml)
pins Rust 1.94.0 and includes `aarch64-unknown-linux-gnu`. The
[DotSlash protoc manifest](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/bin/protoc)
contains a Linux aarch64 protobuf 29.3 archive with a SHA-256 checksum. These make
native ARM64 compilation plausible, not proven. The
[shell crate manifest](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/Cargo.toml)
includes ACP, vendored libgit2, and other native-build dependencies. A working
C/C++ compiler/linker and Cargo dependency access will be needed; exact Linux
system packages and memory requirements must be established by a clean build.

Proposed commands in an isolated native ARM64 build environment (not run here):

```sh
git clone https://github.com/xai-org/grok-build.git
cd grok-build
git checkout --detach 72a61251fcffb464bcc687aeb5a998e5a98ec0c9
git rev-parse HEAD
rustup show
# Install the checksum-verified DotSlash release as defined in the Dockerfile.
/usr/bin/env dotslash --help
bin/protoc --version
CARGO_BUILD_JOBS=1 RUSTFLAGS='-C target-cpu=generic -C force-unwind-tables=yes' cargo build --locked -p xai-grok-pager-bin --release
target/release/xai-grok-pager --version
```

For reproducible production builds, additionally pin the builder image and
DotSlash version, retain Cargo.lock, capture dependency/SBOM/license notices, and
record the resulting executable and container digests. First-party upstream code
uses Apache-2.0; vendored code retains its own notices. No upstream source was
copied into Lilly by this change.

## Source-build container definition

`src/grok-build/Dockerfile` uses the fixed public source revision, a versioned
`rust:1.94.0-bookworm` builder, DotSlash 0.5.9, and a `debian:bookworm-slim` runtime.
The [official DotSlash v0.5.9 release](https://github.com/facebook/dotslash/releases/tag/v0.5.9)
publishes the executable assets. Cargo registry installation of this version
failed in the real primary candidate build, so the Dockerfile now downloads the
official musl release archive and verifies its published SHA-256 before extraction.
The release API was checked from the primary host on 2026-09-06:

- Linux ARM64 `dotslash-linux-musl.aarch64.tar.gz`:
  `11323ef72fac5885d7c54bff70d666486bd800a8d908d0acd3bd838fd8a9b0db`.
- Linux x86_64 `dotslash-linux-musl.x86_64.tar.gz`:
  `5cefa0f258e0a58ae53c7a9a5be3890574ddd33d57c66bc9c143cb411012d72a`.

These hashes identify the unversioned asset filenames inside the versioned
v0.5.9 release path; the separately named `*.v0.5.9.tar.gz` assets have different
hashes and must not be substituted.
The builder retains the upstream default `sandbox-enforce` feature, documented in
the [binary crate](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager-bin/Cargo.toml).
It verifies both public and monorepo revisions before compiling.

The runtime is UID/GID 10001 with separate `/workspace/assignment` and
`/state/worker`. The executable is `/opt/grok/bin/xai-grok-pager`; it is not wired
to a server entrypoint. The default command only prints its version with updates
disabled. The source archive, complete in-tree licenses/notices, top-level
license/third-party notices, Cargo.lock, source revisions, binary hash and linked
libraries are retained under `/usr/share/doc/grok-build/`. No keys are build
arguments or baked environment variables. The tiny build context excludes all
Lilly source, auth state and other local files.

Native build packages include the C/C++ toolchain, pkg-config, CMake, Clang and
headers for conservative native dependency support. Runtime packages provide CA
roots, git, libgcc, libstdc++, zlib and OpenSSL. Source manifests prove native
dependencies exist, not the exact dynamic-link closure; the image's `ldd` gate
fails if any linked library is missing. No audio recorder/device or browser is
included. The upstream [Linux voice dependency declaration](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-voice/Cargo.toml)
avoids linking the non-Linux cpal/ALSA path; audio is outside this worker scope.

Equivalent Docker build command (primary verification uses resource-limited
Podman instead):

```sh
docker buildx build --platform linux/arm64 --load -t lilly-grok-worker:72a6125 src/grok-build
```

Versioned base-image tags are not immutable digest pins; resolve and pin both
base manifests and archive exact package versions before production promotion.
The Dockerfile and static contract tests are not evidence of a successful image
build. The primary candidate attempt 2 reached Cargo installation and exited
101 because DotSlash 0.5.9 was not available through the configured registry.
Attempt 3 uses the verified release asset and was started in the same isolated
directory after archiving the terminal attempt; it exited 124 at 40 minutes.
The first cache resume exited 101: the kernel recorded a compiler cgroup OOM
at the 6 GiB cap. Inspection also found upstream GNU ARM flags target Neoverse
V2 while the primary host reports N1. Both the clean recipe and the new
`Recovery.Dockerfile` explicitly set generic CPU flags (retaining unwind tables)
and one Cargo job. The changed flags intentionally invalidate incompatible
objects. Build settings are recorded with the binary provenance.
The current recovery has a 10 GiB cap, two CPU equivalents and a two-hour
deadline; it neither deploys, pushes an image, nor launches a model-backed agent.

A fresh mounted state volume may mask the bundled update configuration,
so every actual worker launch must preserve the adapter's `--no-auto-update`.
The definition intentionally exposes no port: a separate container needs a
supervised stdio bridge, or the adapter must run in that worker container. Merely
starting this image alongside Lilly does not integrate the two services.

## Required live acceptance gates

The supervisor uses verified in-cluster TLS and Kubernetes v4 exec channels,
not an unscoped host shell. It checks the requested image digest against the
actual Pod before ACP startup, persists resource intent/UIDs, retains per-agent
PVCs, and deletes only its exact Pod/Secret UID on close. A lost create/cleanup
observation requires reconciliation, never a replacement job.

The private broker alias is
`http://lilly-worker-broker.kimibuilt.svc.cluster.local:3001`; this listener serves
only authenticated task routes, not the ordinary Lilly API. Workers receive a
short-lived broker token, not upstream provider keys. DNS is disabled and a
validated host alias points directly at the owning backend Pod IP. There is no
shared broker Service: process-local task leases cannot be load-balanced across
replicas. Downward API identity is validated against the process network
interfaces before scheduling. A different broker rejects the token.
The unapplied foundation in `k8s/lilly-team-workers.yaml` restricts egress to this
port, grants namespace-scoped supervision and no PVC deletion. The revised
no-Service manifest passed client dry-run/schema validation on context `default`
(nine objects, no resources applied). CNI enforcement is not proven.

See `docs/lilly-team-system.md` for source-build recovery handles, runtime
configuration and remaining UI/live-proof gaps. `Resume.Dockerfile` preserves
the first failed recovery definition; `Recovery.Dockerfile` is the current scoped
candidate recovery from the verified cache, not the clean-build recipe.

1. Clean pinned ARM64 source build and ACP initialize/authenticate without TUI.
2. Approved model-gateway route actually completes a prompt without unapproved
   fallback; configurable endpoints alone do not establish compatibility.
3. A project-scoped Lilly MCP tool performs a bounded recorded write, followed by
   authenticated independent artifact read-back.
4. Denied access is enforced by the process sandbox and MCP authorization, not
   only the adapter's approval response.
5. Prompt cancellation acknowledges `cancelled`; supervisor proves no abandoned
   processes. Restart loads the same persisted session and workspace.
6. Two isolated workers collaborate through Lilly messages and produce reviewed
   artifacts while budget/concurrency gates hold. No duplicate team scheduler.
7. Private browser content is supplied to an image-capable worker and acted on;
   only sanitized activity and permitted artifacts reach the operator frontend.

Local protocol checks:

```sh
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/grok-build/acp-client.test.js
node --check src/grok-build/acp-client.js
```

After a candidate image actually exists, inspect its immutable local image ID
and run `node bin/lilly-grok-image-probe.js --initialize-only --image sha256:<id>`
on the Linux build host. The probe checks source labels and binary read-back,
runs version and ACP initialize with no network/host mounts, and cleans only its
labelled temporary containers. It creates no session and makes no model call.
The real source-image probe now passes as recorded above. This covers initialize
only, not the authenticated acceptance gates listed here.

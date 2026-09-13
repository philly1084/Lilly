# Lilly team recovery contract

Status: recovery controller, transactional leases and opt-in runtime scheduling
implemented and tested with fixture quiescence evidence and real isolated
PostgreSQL. The deployed authoritative observer is still missing; automatic
production crash recovery is not shipped or verified.

## Current recovery verification checkpoint: 2026-09-07

The current-source transactional recovery proof has been refreshed: **36 real
PostgreSQL checks** pass in `local/lilly-team-current-postgres-proof.json`, with
28 matching recorded source hashes and the disposable database removed. This
covers concurrent ownership, immutable receipts, lost-reply recovery and
preserved profile identity for the next task; kernel/CRI inputs remain fixtures.
The separate two-worker/browser integration also passes 21 scripted checks with
real storage and authenticated artifact downloads. See `docs/lilly-team-system.md`.

The current-source ARM64 recovery helper now passes nine real, networkless
container checks, including locked profile retirement and non-replaying receipt
read-back. All 15 recorded source hashes match; the test container was removed.
It is an undeployed host-local candidate, and browser-stop/Kubernetes inputs in
that proof remain synthetic. Image identities and exact scope are recorded in
`docs/lilly-computer-transport.md`; receipt:
`local/lilly-recovery-current-worker-proof.json`.

The supervised runtime now avoids a false permanent workspace hold after a
failed graceful browser shutdown reply. Previously it retained the RPC error
even when the independent node supervisor successfully stopped the exact worker,
retired the profile and closed the durable lease. That could discard a completed
task's return path and leave it unobserved while the broker remained alive.

The Kubernetes lease now exposes a private, read-only `confirmClosed` callback.
It reloads the exact team/task/claim/boot/lease, verifies both durable stop and
profile recovery receipts, requires any recovery helper closed, and checks Pod
absence. Only a successful independent `close` plus this positive read-back can
override a graceful-reply failure. Legacy factories without that callback and
all unknown/mismatched/unavailable evidence retain their conservative hold.
No model, browser action, provisioning or artifact write is replayed.

**1,254 tests / 70 suites** pass in `local/lilly-confirmed-cleanup-jest.json`.
The composed regression reaches task review after a rejected graceful response,
with one exec/open and the profile retained. Seven read-back rejection cases
cover missing receipts, changed claim/lease, a remaining Pod, an unfinished
helper and API failure. These new handoff scenarios use simulated Kubernetes
and in-memory transactional state; this patch is not deployed or live-verified.
It does not add automatic retries for genuinely failed supervisor cleanup or
resolve unknown tool outcomes while the broker is alive.

Native node startup now passes eight real transient-systemd checks, with
**1,234 tests / 69 suites** at that checkpoint. The template's missing netlink
socket family was corrected; capabilities, resource limits, mutual TLS and clean
shutdown were observed. This is not proof of recovery operations under those
limits. See `docs/lilly-node-rpc.md` and `local/lilly-node-systemd-proof.json`.

`bin/lilly-retired-owner-proof.js` now provides a bounded real-kernel/CRI test for
the removed-cgroup fallback. Following explicit approval, it **passed four real
checks on primary k3s** at approximately 11:34 UTC on 2026-09-07.
Seven new fixture/admission tests and the related reader/binding suites pass:
**59 tests in four focused suites**. Syntax and whitespace checks also pass.

The test targets only `kimibuilt-async-lab` on the selected host. It uses one
uniquely labelled Pod running `/bin/sleep`, a digest-pinned cached image with
`imagePullPolicy: Never`, UID 10001, read-only root, no capabilities, no service
account token, no environment injection, no project volume, and a label-scoped
deny-all network policy. Limits are 100m CPU, 64 MiB memory and a 180-second Pod
deadline; no model or browser runs. The runner does server dry-runs before
creating resources and verifies resource UIDs/labels before stop and cleanup.
It never deletes a namespace or touches existing lab workloads.

The intended observations are actual private PID 1 and cgroup binding; rejection
of retirement while that init is alive; two exact CRI EXITED observations plus
the real retired-kernel-owner witness after stopping the fixed process; and
wrong-boot rejection. This does not exercise browser profile writes or replace
the required combined mounted-recovery acceptance test.

Report: `local/lilly-retired-owner-k3s-proof.json`, proof
`496d26f6-79a7-48d7-9da4-5619ebfe4c12`. All five recorded source hashes match.
The live binding recorded private init PID 1174159, Pod UID
`ad0731a9-ea66-4560-b0f5-286ed4ca56d4`, and container
`259b700bd461f69199b3abad1cdc02409254c0bfdcd042873e3370daeb9e1146`.
The real reader rejected retirement while the init was alive, then twice
confirmed the exact CRI container EXITED plus the same-boot retired-kernel-owner
witness after stopping it. No mocked kernel or CRI input was supplied.

The exact fixture Pod and network policy were removed. An independent label
query returned no resources, and the eight pre-existing lab Pods retained their
previous names, states and restart counts. No models started, no project files
were mounted, and no deployed application configuration changed. Nonsecret
source and proof reports remain in temporary directories for provenance.

Cluster inventory confirmed the primary host `ubuntu-32gb-fsn1-1`, local control
plane `https://127.0.0.1:6443`, and the existing `kimibuilt-async-lab` runtime-surface
label. Existing lab workloads are running and must be preserved. The
`k3s-codex` helper and context-classification map are absent on the server. The
cluster-map workflow initially held execution read-only; the user explicitly
approved this single bounded sandbox test and removal of its own Pod/network
policy. That approval is not a general cluster classification change, production
deployment approval, or authorization to activate live agents.

Rendering is mutation-free:

```text
node bin/lilly-retired-owner-proof.js --render kimibuilt-async-lab <cached-lilly-image-at-sha256> ubuntu-32gb-fsn1-1
```

Actual execution additionally requires explicit sandbox approval and
`SAFE_APPLY=1`. Do not infer that approval from this document, a passing unit
test, the active goal, or previous deployment authorization.

## Implemented prerequisites

- Mutual-TLS node RPC and opt-in backend transport selection are implemented.
  Task/lease ownership is reloaded at the node, receipt results require stored
  evidence, and deadlines do not release active ownership. **1,205 tests / 67
  suites** pass, including real local TLS with simulated database/node work.
  The native node service is not deployed; private networking, scoped credentials
  and combined cluster proof remain. Contract: `docs/lilly-node-rpc.md`.
- The browser supervisor now archives exact stop evidence before Pod deletion,
  closing the source-level CRI garbage-collection ordering gap. The private node
  computer operations connect browser binding/stop/archive with the mounted
  recovery runtime and final helper closure checks. **1,158 tests / 65 suites**
  pass, including real service/adapter logic with simulated node/API responses.
  Report `local/lilly-browser-stop-order-jest.json`. Authenticated node transport,
  current-image proofs and real mounted cluster recovery remain outstanding.
- The inactive node recovery runtime now composes the mounted controller and
  helper lifecycle with an exact-CID stop adapter and durable receipt read-back.
  It reads authoritative task ownership rather than trusting a caller's lease,
  never treats signal success as stopped, and resumes a lost stop reply without
  rerunning profile retirement. **1,147 tests in 65 suites** pass; new cluster,
  kernel and persistence inputs are simulated. Current report:
  `local/lilly-recovery-node-jest.json`. Real combined cluster recovery,
  authenticated node transport and deployed wiring remain required. Earlier
  source-hash/image/SQL checkpoints below are historical and need refresh.
- The recovery-helper supervisor now composes launch admission, exact Pod/PVC
  checks, sandbox/image validation, node binding, mounted recovery and archived
  stop evidence before exact-UID deletion. Lost creation/deletion replies resume
  the recorded identity rather than creating replacements. **1,097 tests / 36
  real SQL checks** pass; the 15 lifecycle cases use simulated Kubernetes/node
  callbacks. All 28 SQL-report hashes match; its isolated container is removed.
  Live node stop/capture adapters, a combined cluster proof and production wiring
  remain incomplete. The worker namespace is still absent in live inventory.
- A ready helper can now be driven by the mounted recovery controller, which
  checks PVC/PV/opened-mount identity before and after execution, reserves one
  durable write dispatch and reads back the final acknowledgment. Replays and
  lost replies use inspection only. The private exec adapter uses newline
  framing to preserve Kubernetes v4 output while stdin stays open. **1,081 tests,
  35 real SQL checks and nine real helper checks** pass; combined controller
  node inputs remain simulated. Both exact fixture containers are removed.
  Helper provisioning and termination/stop archival still need wiring; this
  does not establish a deployed end-to-end recovery path.
- A packaged private recovery helper now accepts a bounded stdin request and
  executes only fixed-root locked retirement or inspection. Inspection can fsync
  and read back an existing retirement but cannot create directories or initiate
  a rename. Expected-root mismatch rejects before writes. **1,058 tests / eight
  real helper-container checks** pass; all 15 recorded source hashes match and
  the fixture container is removed. Browser-stop/PVC/CRI fields remain synthetic
  in that proof. The ARM64 candidate is not deployed: controller launch,
  single-dispatch intent, live mount composition and cleanup still need wiring.
- Recovery helpers now have one durable reservation per original browser lease,
  immutable launch/process identity, and a positive-stop gate before profile
  admission can reopen. Two-sample Pod/CRI/kernel/cgroup binding and stop observers
  reject changed or missing runtime identities. **1,040 tests / 34 real SQL
  checks** pass, including lost launch acknowledgments and observer-to-SQL stop
  receipt persistence with synthetic node inputs. The 26 latest source hashes
  match; the isolated database is removed. Helper launch, live mount/write
  composition and production observer deployment remain incomplete. See the
  current checkpoint in `docs/lilly-computer-transport.md`.
- The trusted node reader now observes the helper's actual `/profiles` mount
  through a verified init-process identity, matching an opened directory's
  device/inode and fdinfo mount ID with the process mount table. **997 tests /
  seven real isolated container checks** pass, including wrong/read-only mounts
  and removed processes. Durable helper binding is now available, but launcher
  lifecycle and write-path revalidation remain to be connected; this is not live recovery.
- Node-local volume binding now validates the exact PVC/PV claim mapping,
  owned annotation, node/boot identity, local storage path and two stable
  filesystem generations. **968 tests / six real Linux fixture checks** pass.
  Read-only live inventory confirms the local-volume layout and root-protected
  parent; it also confirms the new worker namespace is not deployed. This is
  the node-side binding only: the helper's mounted `/profiles` and deployed
  recovery path still need verification. No storage permissions were changed.
- Durable profile recovery receipts now bind the exact archived stop evidence,
  profile/owner filesystem generations, PVC and node/boot identity under the
  team-row lock. Recording a receipt does not free ownership; node-bound close
  and subsequent task admission require it to validate. The supervisor archives
  it before closing, and a lost reply remains reconcilable by fresh read-back.
  **944 tests / 31 real SQL checks** pass with synthetic mount observations.
  Trusted live mount verification/helper transport remains missing; validation
  of a receipt is not independent proof that its stated PVC was mounted.
- Graceful supervised shutdown now retires its original ownership marker into
  the same archive that stopped-container recovery reads. Explicit/idle closes
  retain task ownership for same-worker reopen; final disposal fences admission
  and retires only after every owned context closes. The rebuilt ARM64 worker
  passes fourteen real networkless browser checks. The durable acknowledgment
  gate above is implemented; no new production claim is authorized by this proof.
- The filesystem recovery component now requires a kernel-confirmed exclusive
  directory flock, retires the exact stopped owner's lock by atomic rename,
  preserves the profile and resumes from its retained marker after interruption.
  Six real non-root Linux checks verify locking, process-death release and file
  preservation with synthetic stop evidence. Verified PVC mounting and deployed
  recovery acknowledgment inputs are still missing; this is not automatic production
  takeover. See the current checkpoint in `docs/lilly-computer-transport.md`.
- Browser stop evidence is now archived in the exact task lease under its row
  lock. The first validated node/kernel/cgroup-bound receipt cannot be replaced;
  observer reconstruction can read it after runtime records disappear. It does
  not release the profile. Node-bound close and new-claim admission reject old
  boolean-only acknowledgements without this receipt. The 895-test/29-SQL-check
  checkpoint is in `docs/lilly-computer-transport.md`. Live node capture before
  garbage collection and exclusive profile release remain unimplemented.
- The private browser supervisor now requires and persists a double-sampled
  Pod/CRI/kernel/cgroup owner before exec. The separate browser node reader is
  scoped to `lilly-team-workers` and does not broaden backend owner identities.
  Its read-only stop check requires exited CRI plus the exact empty cgroup twice;
  it does not release a profile. Node-side transport and stop-evidence archival
  remain unwired. Real PostgreSQL proves immutable JSONB persistence, not node
  termination. See `docs/lilly-computer-transport.md` for the 876-test/27-SQL-check
  checkpoint and the remaining production recovery boundaries.
- Browser disposal is now a terminal admission barrier. Future and already-queued
  computer requests cannot reopen it; delayed authorization is checked again
  after it resolves. Late page-title completion cannot recreate an observation
  after closure. Calls already past dispatch never receive false no-effect proof.
- Disposal retains one cleanup promise, drains admitted requests, and waits for
  in-flight profile acquisition even when that request has already timed out.
  The exact acquired lease is released only through tracked cleanup. A failed or
  hung context close does not become a successful second stop. Six regression
  cases cover these orderings with controlled delays.
- Bounded `TeamRunner.drain()` plus unsettled-team inventory, including disabled
  teams. Drain reports unknown work without releasing durable occupancy.
- Runtime shutdown invokes drain and awaits the same broker/browser cleanup
  promises across timeouts. It does not restart a disposed instance. A listener
  still being acquired keeps shutdown unconfirmed until late acquisition and
  cleanup settle; it cannot start the scheduler after stop.
- Private-browser authorization carries the exact task/worker/claim. Every
  intercepted background HTTP request and WebSocket policy check uses that claim.
  Stopping and resuming a teammate does not authorize its old page. A new claim
  closes the previous context before reopening the same credential profile;
  unknown or hung closure retains the old lease and cannot relabel old frames.
- Real isolated PostgreSQL proof covers profile retry races, pinned skill
  acceptance and disabled-team inventory in addition to transaction/admission
  checks. This is not evidence of full external operation reconciliation.
- A bounded durable operation journal reserves artifact writes, generic tools
  and browser open/actions before dispatch. Exact claims fence reservations and
  late settlement; row locks prevent concurrent duplicate reservations. Unknown
  outcomes block new effects and task completion, retaining occupancy. Changed
  call IDs cannot replay an identical started effect. Effective argument hashes
  ignore JSON property order and unused outer fields; private arguments/results
  are not journaled. Atomic team commands retain their existing receipts.
- Cancellation is rechecked after reservation and after the awaited heartbeat.
  Browser validation failures settle as no-effect only with trusted pre-dispatch
  provenance; an identical error code after an action is not sufficient. Generic
  tool job acceptance or a timeout is not proof of settlement.
- Team artifact writes now use their reserved operation UUID as the artifact ID.
  The durable path inserts once, never upserts, never falls back to another local
  ID, and performs no later processing mutation. A still-running worker can
  recover a lost write response by reading that exact ID and verifying its scope,
  request fingerprint and actual byte hash. It does not repeat the write.
- TeamRunner acquires one immutable execution-owner record and persists it in
  the same transaction as each claim, before launching work. The record has a
  fresh runtime boot UUID, PID and startup time; Linux adds observed kernel boot
  UUID, process start ticks, PID namespace and mount namespace. Declared Pod
  namespace/name/UID/container-name are bounded release context, not CRI proof.
  Failure cannot downgrade identity or select a new owner silently; shutdown
  during acquisition cannot start the broker or scheduler later. Owner records
  remain outside model context and workroom projections.

- `TeamReconciler` requires a configured observer; it has no default timeout/PID
  inference. Positive owner/worker/browser quiescence is checked before fencing
  and again before completion. One database-timed investigation lease wins under
  the team row lock. Expired investigators cannot release capacity or replace
  the current lease. This controller launches no worker. Opt-in runtime scheduling
  now requires a separately supplied authoritative observer (see below).
- With an exact reserved artifact ID, the controller performs a positive scoped
  hash read-back, settles that journal entry, then independently reads artifacts
  again before ending the interrupted task. Unknown external effects retain
  occupancy. Release records failed/cancelled, never successful, and does not
  enqueue a retry. Existing agent/session identity and saved outputs remain.
- Concurrent completion receipts are idempotent under the final row lock,
  including after PostgreSQL JSONB changes key order. Stop during an awaited
  observer/artifact read prevents late recovery work from proceeding.

Still missing: deployed process-to-CRI-container binding transport, authoritative
quiescence observation and nonce-bound profile
lock takeover after proven quiescence. The checks below remain gates.

The actual backend container exposes `/proc/self/cgroup` as `0::/`, not a
container ID. A read-only streamed Node diagnostic verified kernel identity
collection inside that container without writing files or starting an agent.
Do not infer CRI identity from Pod name, status or a missing cgroup path. Non-Linux
owners explicitly have no kernel proof. Legacy direct claims without ownership
also remain unrecoverable by inference. The future controller must verify old
owner quiescence through an authoritative adapter before using these records.

## Required outcome

After interruption, the same team retains its identities, assignments, saved
profiles, sessions and artifacts. New work may start only when the previous
execution can no longer act and every already-dispatched operation is settled.
An unknown outcome remains visible as reconciling, with its agent and overlapping
write targets occupied. No timeout, missing heartbeat, model statement or worker
Pod deletion is by itself proof of completion or safe retry.

## Protocol to implement

1. Persist execution ownership before launch: boot UUID, runner identity,
   backend namespace/Pod UID/name, container identity and claim epoch. Use database
   time for recovery deadlines. Inventory unsettled tasks even in disabled teams.
2. Reserve each operation under the current claim before dispatch. Persist a
   bounded operation ID, request fingerprint, operation class and resource
   identity; never raw private arguments, screenshots or credentials. Dispatch
   outside the row lock. Commit settlement only after the adapter settles.
3. Fence new dispatch when recovery starts, preserving the old claim solely for
   validating late settlement receipts. A compare-and-swap reconciliation lease
   may change investigators, never authorize a second executor.
4. Revoke the owning broker and drain actual tool promises. Inspect recorded
   process/container ownership, not just Pod name/IP, to distinguish restart and
   reuse. Worker cleanup requires exact ownership and UID checks and must retain
   persistent volumes. Uncertain create requests remain unresolved until their
   outcome is reconciled; a single 404 is insufficient.
5. Recover browser profiles only after matching durable ownership and verified
   old-owner quiescence. Record a private lock nonce and storage/process identity;
   fence every background HTTP/WebSocket action to the execution epoch. An empty
legacy lock stays quarantined. Never take it over based on age or PID alone.
6. Release capacity exactly once after worker, browser and operation evidence all
   agree. Lost output is not success. An explicitly requested continuation uses
   a new claim and preserved context, not a silent replay of side effects.

Team-command receipts can be committed atomically with their existing mutation.
Artifact writes now have reserved identities and authenticated hash read-back;
recovery after real process loss still needs authoritative observation and runtime
wiring. Other external tools need their own reconciliation adapters;
unsupported unknown side effects must retain occupancy.

Current artifact writes also record the request fingerprint in stored metadata.
A positive read can recover a lost write response within the current execution;
missing rows, unavailable storage, mismatched scope/fingerprint and corrupted
bytes remain unknown. The journal has no public settlement command and no
automatic production restart resolver. A browser snapshot is
not proof that a remote website has finished processing a submitted action.

`local/lilly-team-postgres-proof-artifacts.json` records 14 passing real PostgreSQL
checks, including a committed artifact with a deliberately lost response read
through a second pool, plus 20 duplicate INSERT attempts denied by the production
table's primary key. The proof runs actual ArtifactStore queries and reserved
read-back validation, with a fixture caller; the full ArtifactService preparation
path has local unit coverage, not a live worker proof. No production DB was used.

The newer `local/lilly-team-postgres-proof-ownership.json` retains those checks
and adds a 20-way, two-pool ownership/admission race: exactly one claim and its
matching owner commit together, survive service reconstruction, and remain out
of agent context. Invalid ownership leaves the state unchanged. All 15 checks
passed using actual Linux observations in the isolated proof process. This does
not prove stale-owner termination or automatic takeover.

## Verification still required

- Real process/browser observation combined with PostgreSQL recovery races.
- Crash before and after dispatch, resource creation and result persistence.
- Worker absence while a tool remains active; delayed Kubernetes creation after
  a timed-out request; Pod name/IP reuse and same-Pod container restart.
- Disabled-team inventory, fenced old-owner requests and bounded drain timeout.
- Browser lock replacement, shared-storage contention and hung browser close.
- Exactly-once release after all evidence, with preserved artifacts/session on
  an explicitly authorized continuation.

Required RBAC expansion is read-only backend Pod inspection in `kimibuilt`, not
backend deletion, Secret reads or cluster-wide roles. Existing worker-namespace
cleanup permissions remain scoped. No owner API may accept caller-provided
claims that work has settled as trusted execution evidence.

## Recovery transaction checkpoint

`local/lilly-team-postgres-proof-reconciliation.json` records **18 passing real
PostgreSQL checks**, proof `a78f3a20-6f01-4673-af9c-b3233cd29c98`. New checks race
20 investigations through two pools with deliberately skewed application clocks,
reject an expired investigator after replacement, replay concurrent exact
completion receipts, and run the controller against a committed reserved
artifact in a disabled team. The second pool reads original bytes; no write is
repeated and the task is cancelled, not completed. All eleven source hashes
identify that historical checkpoint; the exact proof container was removed and its
absence independently checked. No production database was accessed.

The first real run exposed JSONB key-order sensitivity in receipt comparison;
semantic field comparison fixed it and has a regression test. Its failed report
is retained separately. Quiescence is explicitly fixture evidence in these
checks: no worker was launched, and this does not prove real process termination.

## Runtime investigation scheduling checkpoint

`LILLY_TEAMS_RECOVERY_ENABLED=true` requests the investigation loop independently
of execution admission. `createTeamRuntime` must also receive a trusted
`observeQuiescence` function from deployment code. There is no default observer,
environment-provided receipt, owner-command override or heartbeat-based fallback.
Without the adapter, runtime status reports `quiescence_observer_unavailable`
and no investigation runs. No deployed adapter was added by this checkpoint.

When available, `runtime.start()` schedules a nonoverlapping investigation every
three seconds. A recovery-only runtime can inspect disabled teams without
preparing an execution owner, starting the runner, opening a broker or launching
a model/browser. Repeated starts retain the same timer. An execution-startup
failure cannot leave a newly started recovery timer behind.

Inventory uses parameterized, stable-ID keyset pagination with at most 100
identity-only rows cached. The controller retains its within-team task cursor
across the 16-task per-tick budget, traverses later pages and wraps after an
empty page. Healthy/unknown tasks at the front no longer permanently starve
later tasks. Unreadable teams are retried on the next sweep, not treated as
stopped. A still-pending observation remains the same investigation; pagination
does not bypass it or manufacture a second observer.

Shutdown stops the timer and prevents late fencing after an awaited observation.
It also waits for the exact in-flight investigation, including a database
transaction already dispatched before stop. An observation deadline leaves
`resourcesClosed` and `settled` false; repeated stop calls keep watching the same
promise. A stopped controller cannot restart. Status exposes availability and a
pending boolean, not private claims, owner records or observer errors.

Verification: **718 tests across 41 suites passed**. New lifecycle tests cover
recovery-only scheduling, duplicate starts, missing observer, inventory failure,
pending observation and transaction shutdown, task-budget fairness and more than
100 teams. These use explicitly synthetic quiescence evidence, not real workers.

`local/lilly-team-postgres-proof-scheduler.json` records **19 real PostgreSQL
checks**, proof `ddb70916-2667-4343-af0c-0b87d62f04fc`, with 12 tested source hashes.
The new check inserts 105 inventory-only fixture teams, reads pages through a
second connection pool while timestamps change, and confirms the production
controller reaches all fixture teams without changing their running states.
Existing lease races and reserved artifact read-back checks also pass.
PostgreSQL 16.15 ran network-disabled with 512 MiB/one CPU in an owned disposable
container. Container removal was independently verified; the report and copied
proof sources remain. No production DB, model-backed worker or deployment was
changed. This proves scheduling/storage behavior, not authoritative quiescence
or automatic production recovery.

## Container-to-process binding checkpoint (2026-09-07 UTC)

The owner record now supports version 2 with an exact, private container binding.
`createTeamRuntime({ bindExecutionContainer })` passes the trusted deployment
callback to the execution-owner resolver. It supplies the observed version-1
owner; the callback must return a verified binding. The resolver validates the
Pod UID, host boot UUID, containerd ID, node, host PIDs, start ticks, namespaces
and observation time against that owner. Binding failure cannot downgrade to
version 1. The runner freezes and persists the full record with the claim before
dispatch. Existing unbound records remain readable, not retroactively verified.
No environment variable or owner/model command can supply this evidence.

`container-binding.js` implements the acquisition check using trusted Pod, CRI
and host-kernel readers. It reads all three twice and rejects changed Pod UID,
node, container, init PID/start time or owner process. It rejects host/shared PID
namespace Pods. `node-container-reader.js` is a fixed, host-side **read-only**
adapter for k3s/containerd: exact-container `crictl inspect`, fixed runtime socket,
local-node check, bounded process inventory and `/proc` identity reads. Raw CRI
output may contain secrets and is never returned or printed. Non-init owner PIDs
are matched only within the container's PID and mount namespaces, with init
identity rechecked after the scan. The adapter has no stop/delete/exec action.
Do not expose it as a model tool or mount the runtime socket into an agent.

The actual primary backend was inspected read-only at 03:07 UTC. Report
`local/lilly-container-binding-proof.json`, proof
`f7a7931f-2bef-4492-838d-3df05dcb0b77`, matches four source hashes. The diagnostic
sampled existing container PID 1 and matched it to containerd and the host
kernel, twice. It does **not** bind a live Lilly team claim or prove termination.
The backend remained 1/1 Running with zero restarts; no existing Pod was changed.

`local/lilly-team-postgres-proof-binding.json`, proof
`e0cf71a6-0c2e-4e28-a7b4-0e1570ce0edd`, records **20 passing isolated PostgreSQL
checks** with 12 source hashes. The new check races 20 claims across two pools,
persists one version-2 binding with its winning claim, reads it through a new
service, and confirms it is absent from model context. That binding is explicitly
synthetic transaction evidence, not the live diagnostic. The exact network-none
database container was removed and its absence independently checked.
The selected regression run passes **766 tests across 43 suites**.

The node-side transport/authentication and deployment injection remain unwired.
There is still no authoritative `observeQuiescence` implementation or browser
profile takeover. A positive running-process binding is a prerequisite, not a
stopped-process receipt. Do not infer termination from Kubernetes object absence:
forced deletion does not wait for node termination confirmation.

Primary documentation checked on 2026-09-07:

- [Kubernetes CRI diagnostics](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Kubernetes Pod lifecycle and forced deletion](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)

## Whole process-tree observation checkpoint (2026-09-07 UTC)

Container bindings can now use binding version 2, adding a private cgroup-v2
identity (container-root path, filesystem device and inode). The owner envelope
remains version 2. The binder samples the populated group twice, checks exact
Pod/container path ownership and host process membership, and rejects a changed
group or failed observation. The runner freezes the nested identity and commits
it with the worker claim; old bindings without this identity remain readable but
cannot authorize this new stop observation.

`cgroup-reader.js` verifies the real cgroup-v2 filesystem, non-symlink paths,
domain type, stable device/inode and strict kernel `cgroup.events` data. It uses
the recursive `populated` bit, never an empty `cgroup.procs` list as proof. Owner
processes may reside in child groups only within the exact container root.
`node-container-reader.js` exposes these read-only observations at the existing
trusted node-adapter boundary; it adds no write, kill, migration or model tool.

`observeContainerStop` requires two exact CRI `CONTAINER_EXITED` observations
interleaved with two positive empty-tree observations of the bound cgroup on
the same host boot. Running/restarted containers, live descendants, changed
identity, missing/removed/garbage-collected records and read failures return
unknown. It proves only that container's tree, not other workers or outstanding
external effects, and cannot produce the whole-team reconciler receipt.

Important remaining lifecycle gap: containerd can remove a cgroup before a
later observer reads its empty state. This implementation deliberately does not
treat disappearance as emptiness. Capturing an authenticated terminal observation
before teardown, combining all worker/browser evidence, and safely restoring a
private profile remain necessary before automatic recovery can ship.

Three current proof reports retain matching source hashes:

- `local/lilly-container-cgroup-binding-proof.json`, proof
  `2ecf5ed7-dce2-4de8-89b6-34e38ebb3249`: read-only primary backend binding,
  including the actual populated cgroup; five source hashes. This sampled PID 1,
  not a live team claim, and did not stop the backend.
- `local/lilly-cgroup-proof.json`, proof
  `10c09835-b10b-4ded-a164-3de7f7f17a6b`: real kernel empty/populated/empty
  transitions for an owned UUID-named group and one fixed test process in a
  nested subgroup. The parent correctly reported populated while its direct
  process list was empty. Both groups and the process were removed; absence was
  independently checked. Two source hashes. No production process was moved.
- `local/lilly-team-postgres-proof-cgroup.json`, proof
  `4129bbae-65b7-404d-8517-27da2194af97`: 20 isolated PostgreSQL checks, now
  persisting the cgroup-bearing binding under a 20-way, two-pool claim race.
  Binding evidence here is synthetic transaction data; 13 source hashes. The
  exact network-none database container was removed and independently absent.

The selected regression run passes **797 tests across 45 suites**. It covers
path ownership, filesystem mismatch, process migration, group replacement,
legacy records, nested processes, restart/repopulation races and private-state
projection. The backend remained 1/1 Running with zero restarts. No rollout or
model-backed agent canary ran. Kernel mechanics and transaction checks are real;
the complete CRI-exit plus retained-empty-cgroup path still needs a controlled
container lifecycle proof before becoming trusted deployment evidence.

Research verified 2026-09-07:
[Linux cgroup-v2 populated notification](https://docs.kernel.org/admin-guide/cgroup-v2.html#un-populated-notification)
defines recursive live-process observation across the group and its descendants.

## Retained terminal-observation checkpoint (2026-09-07 UTC)

`container-stop-archive.js` now retains a positive `observeContainerStop` result
in an internal PostgreSQL table. The key is a canonical SHA256 of the complete
normalized execution owner, including runtime boot, kernel identity, Pod,
container binding and cgroup generation. JSONB object-key reordering does not
change the key. Records contain only the bound IDs, observation time and source;
private paths and raw CRI data are not copied into them.

The store uses `INSERT ... ON CONFLICT DO NOTHING`, never an overwrite or expiry.
Capture independently reads the persisted receipt back. Concurrent requests for
one identity share the same pending promise; a stopped observer retains any
already dispatched write rather than pretending cancellation undid its commit.
A lost database acknowledgement may fail that call, but a reconstructed observer
can read the committed receipt without repeating the observation. Invalid saved
records fail closed; an old record cannot authorize a different owner boot or
cgroup generation. There is no model/owner route to write this table, implicit
production connection, runtime wiring or automatic recovery activation. Deploy
the writer only inside the trusted observation boundary with protected database
credentials; a database record alone is not cryptographic evidence of its source.

Report `local/lilly-team-postgres-proof-stop-archive.json`, proof
`09eb79ac-50f9-4f27-8985-53cc7dd8a050`, passes **23 real PostgreSQL checks** with
15 source hashes independently matched to the local checkout. New checks cover
20 captures across two pools with one immutable receipt, reconstruction after
runtime resources are unavailable, and a committed INSERT with a simulated lost
reply. CRI/cgroup readers in this database proof are explicitly synthetic; the
database operations and production archive/observation code are real.

The exact network-none, 512-MiB/one-CPU PostgreSQL 16.15 fixture was removed and
its absence independently checked. Production storage was not accessed. The
selected regression run passes **814 tests across 46 suites**, including 17
archive cases. The existing backend remained 1/1 Running with zero restarts.
No model-backed agent or production deployment ran.

This closes the persistence/replay gap only. It does not solve capturing the
positive terminal observation before containerd removes the cgroup, prove that
a container cannot restart after that observation, settle another worker's
browser/external effects, or permit browser-profile takeover. A historical stop
record is not the reconciler's full quiescence receipt. Authenticated node-side
capture, lifecycle fencing and complete worker/browser settlement still need
their own connected-path proof before automatic recovery can ship.

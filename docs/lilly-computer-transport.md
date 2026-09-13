# Lilly supervised private-computer transport

Status: private channel, runtime adapter, scoped worker entrypoint, durable
ownership registry, lazy claim-scoped runtime and Kubernetes lease factory
implemented. The packaged ARM64 worker passes fourteen checks with a real
networkless Chromium container; ownership persistence is verified against
isolated PostgreSQL. Kubernetes API/observer responses remain fixture-tested,
not live-cluster proof. The node-side termination/profile-release observer,
network policy and production wiring are still required. The backend still
defaults to its existing in-process browser.

## Current recovery helper image checkpoint (2026-09-07 UTC)

The recovery helper was rebuilt from current source on primary ARM64 using the
Dockerfile's minimal source allowlist, with no build network and no base-image
pull. It remains a host-local Podman candidate: **not pushed, imported into k3s,
deployed, or activated by a live agent**. Older helper image receipts below are
historical and must not be used as current-source proof.

- Candidate tag: `localhost/lilly-recovery-worker:current-pwoddt`.
- OCI manifest digest: `sha256:8efbd814ce1b1efd0dd4da22a8c2eecdbe24d340d54b5e2d1017af60dbebe0bf`.
- Local config image ID: `sha256:71efaf7c56b5151d2d52a62f4900a787b24e516b33c2de748ccbbdf36d447df3`.
- Pinned base: `docker.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
- Build source: `/tmp/lilly-recovery-current-source.pWoDdT` on primary.
- Proof: `local/lilly-recovery-current-worker-proof.json`, ID `c791f3b1-45a3-4076-9566-b1521b714f9b`.

The config image ID is not a registry manifest pin. Any future publication must
verify the registry's resulting manifest digest before deployment.

**Nine real helper checks pass**: embedded source equality; non-root, networkless,
read-only-root operation; refusal without the lock; read-only inspection; wrong
root generation and oversized input rejection; newline framing with open stdin;
exact profile retirement under real `flock`; fresh receipt read-back without
replaying the write; and preservation of profile bytes. Related assertions are
grouped into nine checks in the report. All 15 recorded source hashes match the
workspace; nine describe files baked into the image. The exact test container
was removed and its absence independently checked.

The helper's kernel/process identity, lock, filesystem retirement and read-back
are real. Browser-stop and Kubernetes/PVC/CRI inputs are synthetic in this proof.
There were zero model calls and no production-data access. This does not prove
the combined Kubernetes browser-stop/profile handoff or live team operation.
The latest broader source checkpoint remains **1,254 tests / 70 suites** in
`local/lilly-confirmed-cleanup-jest.json`; those tests were not rerun for this
image-only refresh.

## Authenticated node connection checkpoint (2026-09-07 UTC)

The private mutual-TLS node server/client and explicit backend transport selection
are now implemented. Nodes reload authoritative task ownership rather than accept
caller-provided container details; both peers validate certificates, and configured
fingerprints restrict node/client identities. Request/reply sizes, deadlines,
admission, replay-window checks and output fields are bounded. No retry or
in-process fallback is introduced. Runtime selection remains inactive by default.

**1,205 tests in 67 suites** pass, including a 36-check real local TLS/protocol
suite with simulated database/node operations. Temporary TLS fixtures were
removed and listeners closed. No node service or live agent was deployed.
See `docs/lilly-node-rpc.md` for the exact deployment contract and remaining
host-service, credential, networking and combined real-cluster proof requirements.

## Browser stop-before-deletion checkpoint (2026-09-07 UTC)

The browser Kubernetes supervisor now requires separate trusted `requestStop`
and `captureStop` callbacks alongside binding and profile-recovery observation.
For a node-bound browser, it persists `closing`, requests exact-container shutdown,
validates a positive stop receipt, records it and reads it back from TeamService
**before** issuing the exact-UID Pod DELETE. Pod deletion must not garbage-collect
the only CRI evidence before the node observer captures it. Missing/foreign
receipts, failed writes, changed ownership and observation deadlines retain the
Pod and unresolved lease; they do not invoke profile recovery. A lost committed
stop acknowledgment is recovered by fresh read-back. Late results after the
deadline cannot authorize archival or deletion.

`browser-node-adapter.js` supplies the private host implementation: fresh task
ownership, fixed node/boot identity, double-sampled Pod/CRI/kernel/cgroup binding,
the exact bounded shell-free stop command, BrowserStopArchive capture, and
mounted recovery with final stored receipts and helper-closure verification.
`createNodeComputerOperations` composes these four callbacks with the existing
node recovery runtime. Construction performs no resource or agent activation.
The startup path before any node-bound browser exec still permits exact owned
Pod cleanup; no browser profile has been opened by that path.

Verification: **1,158 tests in 65 suites**, report
`local/lilly-browser-stop-order-jest.json`. Eleven new checks cover deletion
ordering, missing/foreign/uncommitted receipts, stop failure, bounded timeout,
late observations, lost acknowledgment, changed process identity and node
composition. Two scenarios execute the real browser node adapter, binder,
BrowserStopArchive, TeamService and supervisor against simulated kernel/CRI/API
responses and an in-memory store; mounted recovery is a synthetic callback.
These are not live-container, real-SQL or deployed recovery proofs. Syntax checks
and `git diff --check` pass. No live agent or production resource was activated.

Source wiring now connects browser stop archival to recovery. Authenticated
node transport, current image/SQL proof refresh, real kernel fallback, mounted
Kubernetes recovery, egress/sandbox deployment and live perception/operator UI
remain release gates. Earlier checkpoints below retain historical proof scope.

## Node recovery integration checkpoint (2026-09-07 UTC)

`recovery-runtime.js` is now the single inactive node-side composition root for
the helper supervisor, mounted recovery controller, Pod/PVC/PV readers, process
binder and stop/archive adapter. It exposes only `recover(identity, { signal })`.
It requires a private TeamService and Kubernetes client; it is not an authenticated
network service and is not wired into the deployed backend yet.

`recovery-node-adapter.js` resolves the task's recorded helper from authoritative
team/worker/claim/boot ownership. After profile recovery is durably recorded and
the helper is closing, it rechecks Pod/CRI/kernel/cgroup identity, rereads task
ownership and uses a fixed, shell-free `crictl stop` command for the full exact
container ID. The request uses bounded time/output, a minimal environment and
the fixed k3s runtime socket. It does not delete a container record, Pod or PVC.
Command success returns only `requested`; it is never a termination receipt.

Independent capture observes the exact stopped owner, persists the receipt through
TeamService and reads it back before returning. Lost write acknowledgments are
recovered by read-back. Missing CRI metadata without an archived receipt remains
unknown. An already exited container proceeds to independent observation without
another signal. A lost stop reply followed by reconstruction does not rerun
profile recovery or create a replacement helper; deletion still follows archival.

The separate retired-owner reader supports an EXITED container whose cgroup has
already been removed: it requires the original private namespace-init process to
be gone, the same host boot, and two stable absence observations under the verified
cgroup-v2 hierarchy. This fallback currently has fixture tests, not a real-kernel
acceptance run. Missing CRI metadata by itself remains rejected.

Verification: **1,147 tests in 65 suites**, report
`local/lilly-recovery-node-jest.json`. New coverage includes 22 node adapter cases,
two composed supervisor/adapter lifecycle cases (including a lost stop reply),
and nine composition/read-wrapper checks. Kubernetes, CRI, filesystem and SQL
responses in these new tests are simulated; the real binder, receipt validators
and lifecycle functions execute. Syntax checks and `git diff --check` pass.

Read-only primary baseline at 09:43 UTC confirms ARM64 k3s 1.34.9+k3s1/containerd
2.2.5-k3s2. The installed `crictl stop --help` confirms the exact-ID and grace-time
interface used here. No stop command, namespace creation, agent activation,
production database access or deployment was performed in this checkpoint.

Earlier image/SQL/source-hash checkpoints below are historical, not assertions
that their hashes still match this checkout. The helper image and isolated SQL
proof must be refreshed with current validators. Remaining release gates include
real kernel fallback verification, authenticated node routing, combined mounted
cluster recovery, browser stop-before-GC wiring, egress/sandbox policy and live
model/operator-UI proof with explicit activation approval.

## Recovery-helper lifecycle checkpoint (2026-09-07 UTC)

`recovery-supervisor.js` now connects durable helper reservation, single-winner
launch admission, exact Pod/PVC ownership, sandbox/image verification, node
binding, mounted recovery, stop archival and exact-UID deletion. It creates no
resources until its trusted `recover` method is invoked. The helper has no token,
model credential, public port or host namespace, and mounts only its existing
profile PVC plus bounded temporary memory. No PVC is created, replaced or deleted.

`beginComputerRecoveryHelperLaunch` is an atomic database transition. Reading
`reserved` followed by an ordinary phase update was not sufficient: concurrent
controllers could otherwise both POST. Only the transaction winning this new
transition may create the Pod. A lost launch reply or an intent without an
observed object does not grant another POST. A delayed original object can be
reconnected using the same recorded helper identity.

The supervisor keeps profile admission fenced through recovery and requires
positive node termination evidence to be archived before deleting the exact Pod
UID. A successful stop request is not death evidence. Missing evidence, changed
objects, observer deadlines or interrupted transport remain unknown. Repeated
cleanup can use a saved stop receipt after a lost deletion reply; it does not
repeat recovery. Late node reads cannot mark a timed-out helper ready.

**1,097 tests in 62 suites** pass, including 15 lifecycle cases with simulated
Kubernetes/node callbacks. **36 real isolated PostgreSQL checks** pass, including
one launch winner across 20 cross-pool requests and fresh-service retry denial.
Report `local/lilly-recovery-launch-postgres-proof.json`, proof
`4909e3fa-b441-4b54-89bb-944be0946248`, source
`/tmp/lilly-recovery-launch-source.QvNS2d`, fixture
`/tmp/lilly-team-pg-proof.KJUn4w`. All 28 source hashes match the checkout. The
network-none database was removed and independently absent; fixture files and
reports remain. Read-only inventory still finds no `lilly-team-workers` namespace.

This implements the lifecycle factory, not a deployed node service. It requires
trusted `bindContainer`, `requestStop` and `captureStop` adapters; the live
stop/capture path must preserve positive evidence before runtime garbage
collection. The helper supervisor, mounted controller, real helper and SQL store
still need one combined cluster proof and production wiring. No live agent,
production database or browser profile was used, and no image was deployed.

## Mounted recovery controller checkpoint (2026-09-07 UTC)

`recovery-controller.js` now composes a ready helper's exact Pod/process binding,
PVC/PV verification and opened profile-mount identity before and after private
execution. It records a durable write intent before dispatch and verifies the
final receipt through a fresh service read. It does not provision a helper,
release the browser lease or claim that the helper has stopped.

`reserveComputerRecoveryWrite` uses the task's database row lock: only the insert
returns permission to dispatch. Every retry, including the same operation UUID,
returns inspection-only. The intent pins the helper fingerprint, root generation,
mount ID and PV UID. Lost intent/command replies cannot authorize another write.
A lost final acknowledgment is read back from the existing receipt. Unknown
outcomes retain ownership, even if an intent was reserved but never dispatched.

The new private exec adapter fixes a concrete transport mismatch: Kubernetes v4
exec closes the whole channel when stdin ends. The helper now accepts one bounded
newline-framed JSON request (EOF remains supported), and the adapter keeps stdin
open until an authoritative successful exit. Disconnects, nonzero exit, timeout,
invalid output and cancellation remain unknown outcomes, not successful recovery.

Verification:

- **1,081 tests in 61 suites**, including competing controllers, lost replies,
  mount changes, mismatched roots, missing acknowledgments and transport failure.
- **35 real isolated PostgreSQL checks**; 20 concurrent requests across two pools
  produce exactly one write-dispatch winner. Fresh services return inspection-only.
  Report `local/lilly-recovery-dispatch-postgres-proof.json`, proof
  `dcfe2a8c-63b2-4b96-8151-75fb0fd632c4`, fixture
  `/tmp/lilly-team-pg-proof.IjBrls`; all 27 recorded source hashes match.
- **Nine real packaged-helper checks**, including successful execution while
  private stdin stays open, exact retirement and independent fresh read-back.
  Report `local/lilly-recovery-framed-worker-proof.json`, proof
  `74a48fcf-824b-444b-a2a4-d2d40834769f`, fixture
  `/tmp/lilly-recovery-worker.z3OrBr`; all 15 recorded source hashes match.
- Current helper image:
  `sha256:f92c33b7f068875b243d7f357b82a0a8e2f15282322778eac4d5eb7e556ac502`,
  tag `localhost/lilly-recovery-worker:framed-ccztkh`, source
  `/tmp/lilly-recovery-control-source.CcZtKh`. Both exact proof containers were
  removed and independently absent. Disposable files/reports/images remain.

The mounted controller uses simulated node/volume inputs in its integration
tests; the real helper and SQL proofs are separate, not a deployed combined
controller scenario. The helper launcher, positive-stop archival/termination
composition, production node-observer service and live end-to-end acceptance
remain incomplete. No production data, model call or live agent was used.

## Packaged recovery command checkpoint (2026-09-07 UTC)

The new `recovery-worker.js` is a private one-request stdin/EOF command, not a
model tool or HTTP endpoint. It accepts at most 64 KiB and only the fixed
`--recover` or `--inspect` operation chosen by its supervisor. Both use the fixed
`/profiles` root, exact agent/claim/helper scope, saved helper PID/mount namespace
and boot identity, UID/GID 10001, and the expected directory generation. Run it
under `/usr/bin/flock --exclusive --nonblock --no-fork /profiles`; the filesystem
implementation independently checks that this exact process owns the lock.

`--recover` retires the original owner marker without deleting profile data.
`--inspect` only accepts an already-retired exact owner: it cannot create archive
directories or initiate a rename. It fsyncs and reads back the existing retirement,
allowing a lost write reply to be reconciled without replaying that write. A
mismatched mounted root is rejected before any archive directory is created.

The dedicated ARM64 image builds from the pinned Node base with nine bundled
source files and a SHA256 manifest. It contains no browser, model, credentials or
exposed service; its default command refuses unsupervised operation.

- Image: `sha256:4bde69ed6b8109ce6a94fa61306beb280b26f3fb98d3343d4c2e13356c4541d1`
- Local server tag: `localhost/lilly-recovery-worker:private-n7vbbm`
- Source: `/tmp/lilly-recovery-worker-source.n7vBbM`
- Report: `local/lilly-recovery-worker-proof.json`
- Proof: `26d9436f-8626-4919-b9fc-a35f4a2a2906`
- Fixture: `/tmp/lilly-recovery-worker.jWmYee`

**1,058 tests in 59 suites** and **eight real packaged-container checks** pass.
The latter verify packaged-source hashes, nonroot/networkless/read-only-root
configuration, rejection of unlocked execution/read-back-before-retirement/wrong
root/oversized input, actual locked retirement, fresh exact read-back and preserved
profile bytes. All 15 report source hashes match the checkout. The helper ran
with 128 MiB, one CPU and 64 PIDs; its exact container was removed and independently
absent by label inventory. Source, image, report and disposable profile remain.

Original browser stop, PVC and CRI/cgroup metadata are synthetic in this proof;
helper kernel namespaces, flock, mounted filesystem and packaged execution are
real. No live agent, model request, production profile or database was used. The
image is not pushed, imported into k3s or deployed. The controller still needs
single-dispatch write intent, helper launch, verified PVC/opened-mount composition,
durable receipt acknowledgment and stop/cleanup wiring before live recovery.

## Durable recovery-helper ownership checkpoint (2026-09-07 UTC)

`recovery-helper.js` and the private TeamService methods now reserve one helper
under the original task's database row lock. The helper retains its own immutable
UUID, image, Pod/container identity, original browser-stop fingerprint and profile
scope. A lost reservation or launch-intent reply reloads this record; a new UUID
cannot replace it. Only a never-launched reservation can close without independent
process-stop evidence. Browser closure and subsequent task admission remain fenced
while a launched helper could still access the profile, even if profile retirement
has already been acknowledged.

`recovery-helper-observer.js` binds the actual helper through two matching
Pod/CRI/process/cgroup samples. It checks the pinned image, recovery annotations,
single non-restarting container, private namespaces and declared profile volume.
It rejects changed or reused PIDs after a binding is saved. Its stop observer
requires the exact exited container plus the same empty descendant cgroup twice;
missing runtime records are unknown, not proof of death. The observer-to-durable
stop-receipt path is exercised in the SQL proof with synthetic node inputs.

Verification: **1,040 tests in 58 suites** and **34 real isolated PostgreSQL
checks** pass. Latest report `local/lilly-helper-observer-postgres-proof.json`,
proof `a5541369-c02e-46d0-a226-3d1b6e1d436f`, source
`/tmp/lilly-helper-observer-source.zFQPxf`, fixture
`/tmp/lilly-team-pg-proof.FGskad`. All 26 recorded source hashes match the checkout.
The network-none database used 512 MiB/one CPU; its exact container was removed
and independently absent by label inventory. Reports and synthetic fixture files
remain. No production database, live agent or deployment was activated.

This is not the completed recovery transport. The helper launcher must still
compose durable intent, node binding, independently verified PVC/PV and opened
mount identity, exclusive recovery write, durable acknowledgment and helper stop.
The production node observer must capture stop evidence before CRI/cgroup garbage
collection. No private helper identity or browser pixels enter the workroom.

## Opened helper-mount identity checkpoint (2026-09-07 UTC)

`profile-mount.js` adds `observeProfileMount` to the trusted node container
reader. Given the exact helper init-process identity and verified volume root
generation, it checks the process boot/start time and PID/mount namespaces,
namespace PID 1, UID/GID 10001, no effective capabilities and no-new-privileges.
It parses the helper's bounded kernel mount table, requiring one writable
`/profiles` mount with no hidden child mounts.

The observer opens only `/proc/<checked-pid>/root/profiles` as an ordinary
read-only directory handle with no-follow. It matches that handle's device/inode
to the verified root and its kernel `fdinfo` mount ID/inode to the helper's
mount table. A second mount table and process-identity check reject replacement
or remount during observation. Handles close on success, failure and
cancellation. Returned evidence contains only bounded identities, not raw
mount-table paths, source names, profile contents or process configuration.

This is a read-only mount observation component, **not** a recovery authorization
or completed helper transport. Deployment must derive the helper process from
an exact durable helper Pod/CRI binding, connect the root identity from the
PVC/PV verifier, revalidate around the write, and hold task admission through
durable recovery acknowledgment. That launcher/write-path composition is still
missing. No model or owner command exposes this observer.

Verification:

- **997 tests in 56 suites**, with 29 new mount/reader cases for mount-table
  ambiguity, read-only/nested mounts, inode/device/mount-ID mismatches, process
  reuse, permissions, cancellation and handle cleanup.
- **Seven real Linux container checks**, using the existing pinned ARM64 image
  only as a Node fixture process, not as an agent or browser. A writable profile
  mount matches its opened handle and kernel ID; a fresh observer reads the same
  result; wrong root/process generations are rejected; a read-only mount is
  rejected; removed helpers cannot produce evidence; fixture bytes are unchanged.
- Report: `local/lilly-profile-mount-proof.json`
- Proof: `e6ba98b6-050c-4ffe-b31f-9480467518e3`
- Source: `/tmp/lilly-profile-mount-source.jXmHxa`
- Fixture/report directory: `/tmp/lilly-profile-mount.z8ewqy`
- Both helpers used UID/GID 10001, network-none, read-only root filesystems,
  no-new-privileges, no capabilities, 128 MiB, one CPU and 64 PIDs. Identity came
  from exact disposable Podman container inspection plus real kernel reads;
  this is not Kubernetes helper provisioning or live PVC acceptance proof.
- Both exact fixture containers were removed; independent label inventory was
  empty. Source/report/profile fixture data remain. All five recorded source
  hashes match the checkout. The earlier volume, SQL and browser proof reports
  still match all five, 24 and seven recorded hashes respectively.
- No production volume access, model calls, image rebuild, deployment or live
  agent activation. Host seccomp and production backend readiness/restarts are
  unchanged.

Research verified 2026-09-07: [Linux proc mountinfo and fdinfo](https://docs.kernel.org/filesystems/proc.html)
document the kernel mount ID, device and opened-file inode relationships used
by this observer. Real behavior was verified above, not inferred from docs alone.

## Node-local volume binding checkpoint (2026-09-07 UTC)

Read-only primary-cluster inspection confirms `local-path` uses provisioner
`rancher.io/local-path`, `WaitForFirstConsumer`, local volumes and the default
`<PVName>_<PVCNamespace>_<PVCName>` directory layout beneath
`/var/lib/rancher/k3s/storage`. An existing backend-state PV has the matching
claim UID and single-node hostname affinity. The storage provisioner's setup
keeps the parent directory root-only. No permissions were changed and no volume
contents were inspected. The `lilly-team-workers` namespace is still absent.

`local-profile-volume.js` now provides the trusted node-side, read-only half of
mount verification. It requires the exact closing/reconciliation browser lease
and archived positive stop evidence, then takes two independent API/kernel/file
metadata samples. Each verifies:

- Exact PVC namespace/name/UID, owned identity annotation, Bound state,
  Filesystem/ReadWriteOnce mode, storage class and bound PV name.
- The PV's own UID, reciprocal claim UID/name/namespace, provisioner and selected
  node annotations, exact single-node affinity and literal expected local path.
- The node hostname/boot and observer PID/mount namespaces against process 1.
- Real nonsymlink storage-parent/profile-root directories and stable device/inode
  generations across both samples. No profile contents are enumerated or read.

Changed/deleting/unbound resources, another node or boot, ambiguous affinity,
unexpected volume drivers, different paths, symlinks and replacement generations
remain unknown. The verifier supports the observed local-volume configuration;
there is no permissive fallback for hostPath/CSI/custom storage layouts.

The result contains a private PV/directory binding, **not** `profileReleased`,
and it does not construct a recovery receipt. The newer opened-mount observer
above supplies the next comparison component. The helper launcher must still
connect them, revalidate around retirement and retain the durable acknowledgment
gate. No node observer service or production recovery flow was deployed here.

Verification:

- **968 tests in 55 suites**, including 24 new volume-binding cases.
- **Six real Linux metadata/filesystem checks** in a new disposable directory:
  kernel node namespaces/boot observation; exact real directory generation
  beneath synthetic PVC/PV metadata; fresh observer read-back; foreign claim
  rejection; real directory replacement between samples; real symlink rejection.
  Original fixture bytes are retained. API and stopped-container records are
  explicitly synthetic, not a live worker volume acceptance run.
- Report: `local/lilly-profile-volume-proof.json`
- Proof: `01a747bf-3bb3-4c6d-b93c-b9e6cd6b4f2b`
- Source: `/tmp/lilly-profile-volume-source.LxAKdf`
- Fixture/report directory: `/tmp/lilly-profile-volume.vlIF6h`
- All five recorded source hashes independently match the checkout. This
  host-observer proof ran as UID 0 to inspect host namespace metadata; it did
  not elevate a model/browser worker or change storage permissions. Its process
  exited successfully and a separate process inventory was empty. Temporary
  source, fixture directories and report remain; no user data was removed.
- The 31-check PostgreSQL and 14-check browser reports still match all 24 and
  seven recorded source hashes respectively. Host seccomp and production backend
  readiness/restarts are unchanged. No containers, images, Kubernetes resources,
  model calls or live agent activations were created in this pass.

Research verified 2026-09-07:
[Kubernetes PVC/PV bindings](https://kubernetes.io/docs/concepts/storage/persistent-volumes/),
[Rancher local-path naming and affinity](https://raw.githubusercontent.com/rancher/local-path-provisioner/master/README.md),
and [Linux proc mount metadata](https://docs.kernel.org/filesystems/proc.html).

## Durable profile recovery acknowledgment checkpoint (2026-09-07 UTC)

`TeamService.recordComputerRecovery` now commits an immutable recovery receipt
under the same team-row lock as browser ownership. The receipt binds the
reserved stable profile key, exact lease, archived stop fingerprint, PVC
namespace/name/UID, node/boot identity, and the filesystem retirement's original
root/profile/owner directory/marker generations. Extra fields, changed owners,
different volumes/nodes, invalid generations and evidence predating the stop
receipt are rejected. The receipt remains private to trusted deployment APIs;
neither model commands nor owner commands can submit it.

This is a receipt validator and persistence gate, **not a live mount verifier**.
Only a trusted observer that has verified the PVC mount may construct this
contract around the filesystem recovery result. `recoverProfile` alone does
not prove a PVC mapping. That observer/helper transport remains unwired.

The first receipt is retained through concurrent acknowledgments and lost
replies. Later calls may read it back with a newer observation time but cannot
replace its volume or filesystem generation. Recording it does not close the
lease or release task capacity. The subsequent closing transaction independently
reads and validates the stored stop and recovery evidence before accepting a
node-bound terminal lease. A corrupt/missing receipt behind a `closed` label
also blocks admission of a later task. Non-node-bound provisioning failures
retain the existing separate cleanup contract.

The Kubernetes factory now records both receipts before closing. A lost
acknowledgment leaves its cached cleanup promise rejected and ownership in
reconciliation, while a fresh service can read the committed receipt without
rerunning the filesystem operation. Tests exercise this supervisor path with
synthetic Kubernetes/mount observations, not a deployed observer.

Verification:

- **944 tests in 54 suites**, including 21 new receipt/supervisor cases for
  concurrency, privacy, claim/volume/generation conflicts, lost replies,
  JSONB key ordering and next-task fencing.
- **31 real isolated PostgreSQL checks**. Two pools run twenty concurrent
  receipt acknowledgments; fresh services read the same immutable result.
  Changed marker identity is rejected without overwriting the row, and the
  final cleanup/admission flow preserves the profile PVC for the next task.
  Mount and filesystem evidence in this SQL proof is explicitly synthetic.
- Report: `local/lilly-profile-ack-postgres-proof.json`
- Proof: `b8e7a383-1a90-4e2d-837a-54f36379970d`
- Source: `/tmp/lilly-profile-ack-source.SyLKf5`
- Proof directory: `/tmp/lilly-team-pg-proof.c7OVYq`
- All 24 recorded source hashes independently match the checkout. PostgreSQL
  16.15 used no network, 512 MiB/one CPU and a private Unix socket. The exact
  disposable database container was removed and independent inventory was empty.
  Reports/source remain; no production database access, deployment or agent wake.
- The fourteen-check packaged browser proof immediately below still matches
  all seven recorded source hashes. No browser image change was needed this turn.

Remaining: trusted live helper-mount verification and transport, live node
capture before runtime garbage collection, deployment, real inference and live
workroom acceptance. Durable receipt storage is now implemented; those live
inputs and end-to-end recovery are not yet proven.

## Graceful retirement and same-worker reopen checkpoint (2026-09-07 UTC)

Supervised profile ownership now lasts for the worker lifetime, not one browser
context. Explicit close and idle cleanup close Chromium but retain the exact
owned lock. The same runtime and execution claim may reopen after verifying the
original owner marker and filesystem generations. A different worker cannot
take that lock; a different claim cannot inherit the cached profile. Failed or
hung closure leaves ownership unresolved and blocks reuse.

Final disposal fences admission, drains pending acquisition/operations and
closes all contexts before atomically moving the owned lock to
`.lilly-retired/<leaseId>/<key>.lease`. The original marker and directory
generations remain available to the independent recovery path. Retirement
checks exact ownership, refuses an existing target or unexpected contents,
syncs its directory parents on Linux, and reads the retained marker back.
The old lease UUID is terminal; a new worker needs a new lease UUID. This
does not bypass the supervisor's durable admission and stop-evidence gates.

This replaces the earlier graceful marker deletion described in the historical
CLI checkpoint below. It also avoids creating multiple retirement generations
when an agent closes and reopens its browser during one task.

Verification:

- **923 tests in 53 suites**. New cases cover explicit/idle reopen, competing
  workers and claims, terminal UUID rejection, marker replacement, retirement
  conflicts, and independent recovery reading a gracefully retired marker,
  including interruption after rename but before acknowledgment.
- **14 real packaged Chromium checks**, including two standalone CLI processes
  that each close and reopen before EOF/SIGTERM shutdown. Each reopen retains
  the original owner generation; each process exits zero and leaves that
  generation in its retirement directory. A fresh process with a new lease
  preserves the fixture's saved profile bytes.
- Report: `local/lilly-worker-retirement-proof.json`
- Proof: `8f9381e1-c346-4245-b4b0-f83acc70597d`
- Image: `sha256:b8d9cb2c9a851c8cb0cbca1be72b8ba569471fffb22ed63b14a8cea26e0b8ba0`
- Tag: `localhost/lilly-browser-worker:retirement-eyfu3r`
- Build source: `/tmp/lilly-browser-retirement-source.EYfu3r`
- Proof source: `/tmp/lilly-grok-team-source.W1Jxqc`
- Proof directory: `/tmp/lilly-computer-transport.UwXBd8`
- ARM64, UID/GID 10001, image size 1,290,977,925 bytes. All seven reported source
  hashes independently match the checkout; the proof also checks the five
  baked worker files against that source. No external model calls were made.
- The networkless, read-only, resource-limited test container was removed;
  independent exact-name inventory was empty. Its disposable profiles were
  temporary; no user profile was removed. Reports, source and candidate image
  remain. Host seccomp hash and production backend readiness/restarts are
  unchanged. No image push, Kubernetes deployment or live-agent activation.

Still missing: verified PVC mount/helper transport, deployed positive node-stop observation, live inference and
end-to-end operator UI proof. This checkpoint does not prove those paths.
Durable recovery acknowledgment was added in the newer checkpoint above.

## Exclusive filesystem recovery checkpoint (2026-09-07 UTC)

`profile-recovery.js` implements the filesystem component of recovery. Given a
trusted stopped-container receipt and the exact owned closing/reconciliation
lease, it validates agent/profile identity and retires the old `<key>.lease`
directory to `.lilly-retired/<leaseId>/<key>.lease`. It preserves the owner marker
and its filesystem generation, the browser profile directory, and all profile
data. No recursive deletion, overwrite or age-based takeover occurs.

`directory-lock.js` requires Linux and independently checks `/proc/locks` for
an exclusive whole-directory FLOCK owned by the current process and matching
the exact root device/inode. Run the recovery process under
`flock --exclusive --nonblock --no-fork <verified-profile-root> node ...`.
Shared, blocked, foreign-process, wrong-inode and non-FLOCK records do not count.
No caller-supplied boolean asserts that the lock is held. The lock is on the
directory itself, so no stale recovery lock file must later be deleted.

The routine verifies real nonsymlink directories, requires one matching owner
marker and rejects unknown extra lock contents. Both active and retired paths,
or neither path, remain unknown. Atomic rename preserves the old record if the
helper dies. A fresh helper can read that retired record and settle directory
sync/read-back without another rename. A newer active lock blocks replay of the
old recovery. The profile and root generations are checked again before return.

This routine returns a filesystem retirement receipt, **not** `profileReleased`
or Kubernetes/PVC identity proof. Deployment must first verify the mounted PVC
UID and placement, obtain stop evidence from the trusted archive, keep task
admission fenced through durable acknowledgment, and provide an isolated helper
transport. The OS lock coordinates recovery helpers; the database fence is still
required to prevent a newly admitted browser from racing cleanup. Those end-to-end
deployment pieces are not yet wired. Graceful cleanup now produces the same
retained owner layout, as verified in the newer checkpoint above.

Verification:

- **913 tests in 53 suites**. Eighteen new tests cover lock-record recognition,
  retirement/read-back, interruption after rename, conflicting/missing ownership,
  cancellation and preservation of profile bytes. Windows unit tests mock the
  Linux lock check and directory sync; they are not kernel-lock proof.
- **Six real Linux checks**, executed as UID/GID 10001 in a newly created
  disposable directory: direct unlocked invocation rejected; concurrent helper
  rejected by kernel flock; exact lock-holder death releases the lock; atomic
  retirement preserves owner generation and saved bytes; fresh-process read-back
  returns the same receipt; an old recovery cannot replace a newer active owner.
- Report: `local/lilly-profile-recovery-proof.json`
- Proof: `6714c48a-2bfb-4f63-a736-d8c84be4646b`
- Source: `/tmp/lilly-profile-recovery-source.ehiF97`
- Fixture/report directory: `/tmp/lilly-profile-recovery.jXZe6y`
- All eight recorded source hashes independently match the checkout.
- All six exact child processes reached terminal state; a separate process
  inventory found no matching proof child. One deliberately held fixture process
  was killed to verify kernel lock release. Synthetic profiles and reports remain;
  no user profile or production data was removed.

The proof uses **synthetic browser stop evidence**: it launches no browser/model
and performs no production database, Kubernetes mutation, image build or deployment.
It proves real OS locking and filesystem behavior, not live browser-death evidence,
PVC remount behavior, power-loss durability or complete automatic recovery.

Research verified 2026-09-07: the official
[util-linux flock manual](https://raw.githubusercontent.com/util-linux/util-linux/master/sys-utils/flock.1.adoc)
documents directory locking and `--no-fork` lock retention across exec; the
[Linux proc documentation](https://docs.kernel.org/filesystems/proc.html)
describes the kernel observation interface. Live deployment must still verify
filesystem/namespace support rather than assume these mechanisms work on any PVC.

## Durable browser stop evidence checkpoint (2026-09-07 UTC)

`BrowserStopArchive` now preserves a positively observed browser-container stop
in `computerLease.stopEvidence`, using the existing TeamService row lock rather
than a second database or a public endpoint. The receipt includes the exact lease,
claim, runtime boot, Pod/PVC/container IDs and observation source/time. A fingerprint
binds it to the canonical node/kernel/cgroup record, including its filesystem
generation. Receipt validation is stable across PostgreSQL JSONB key ordering.
Raw cgroup paths, kernel process data and browser pixels are not in the receipt.

`recordComputerStop(identity, evidence)` is a trusted observer API only. It
validates the current claim and binding, preserves the first receipt, and neither
changes the lease phase nor releases task capacity. Invalid replacement evidence
is rejected before considering an existing receipt. There is no team/owner/model
command for this method. The receipt remains outside workroom and agent context.

The archive reloads authoritative task ownership before observation, coalesces
concurrent captures, bounds pending work and does not write after cancellation
during observation. A write already dispatched remains tracked through stop and
independent read-back. A committed write whose reply is lost can be recovered
by reading the original receipt; it is not replaced with a later timestamp.
After observer reconstruction, an existing valid receipt can be read without
re-querying garbage-collected runtime records. No prior receipt means missing
runtime evidence remains unknown.

The Kubernetes supervisor now requires `recordComputerStop` and persists the
observer's `stopEvidence` before closing a node-bound lease. Close, subsequent
reservations, task result settlement and new-claim admission all reject a
node-bound closed label missing valid evidence, even if both old boolean flags
say true. Profile release still requires separate evidence; the archive itself
never removes a lock or reports `profileReleased`.

Verification:

- **895 tests in 51 suites**, including 18 archive/receipt cases and a supervisor
  case rejecting matching boolean acknowledgements without a receipt.
- **29 real isolated PostgreSQL checks**, including concurrent captures across
  two pools, immutable first-receipt read-back, unchanged occupancy, private
  projections and restart recovery with unavailable synthetic runtime readers.
- Report: `local/lilly-browser-stop-postgres-proof.json`
- Proof: `dc87df62-f2e4-410e-be2c-271f3673ac04`
- Source: `/tmp/lilly-browser-stop-source.dKXdfl`
- Report directory: `/tmp/lilly-team-pg-proof.KGRWsg`
- All 19 recorded source hashes independently match the checkout.
- PostgreSQL 16.15, network-none, private Unix socket, 512 MiB and one CPU.
- Exact proof-label inventory independently empty after cleanup; report/source
  remain, disposable database/container removed. Production database untouched.
- Existing backend remained 1/1 Running with zero restarts; host seccomp SHA256
  remains `cc374cf23846ce1f62f4dc807a8e2b8673c783c6f56cb475467621035d281e6c`.

Node observations in these tests are synthetic. This proves archive persistence
and supervisor enforcement, not that a live node watcher captures evidence before
CRI/cgroup garbage collection. The authenticated node transport/watch lifecycle,
exclusive profile-recovery coordination and deployed acceptance remain missing.
No model calls, image changes, deployment or live agent activation occurred.
Syntax and tracked-diff whitespace checks pass. The packaged browser evidence
below remains unchanged; no new UI or full-server proof is claimed.

## Browser node ownership checkpoint (2026-09-07 UTC)

`src/agent-computer/node-binding.js` now binds a browser lease to its owning
node, kernel boot, container init PID/start ticks, PID/mount namespaces and
exact cgroup-v2 filesystem generation. It independently reads Pod identity,
CRI container labels, kernel process identity and populated cgroup membership
twice. A mixed Pod, node, container, kernel boot, PID or cgroup generation cannot
produce an ownership record. The namespace is explicitly `lilly-team-workers`;
it does not widen the existing backend-only execution-owner contract.

The Kubernetes browser factory now requires a trusted `bindContainer` callback
in addition to `observeTermination`. After validating the running sandbox, it
obtains this binding, saves it under the exact task claim and rechecks Pod/node
identity before the first private exec. An absent, malformed, foreign, stalled
or unsaved binding cannot launch the CLI. Binding is bounded by the remaining
readiness deadline and propagates cancellation to the reader; it is not retried.

`bindBrowserContainer({ lease, readPod, reader, signal })` accepts an authenticated
Pod reader and the existing `createNodeContainerReader()` adapter, running on
the owning node. No CRI socket or node filesystem access belongs in the browser
worker, model tool bridge or public API. Production transport/authentication for
these readers is still not wired. The factory tests supply synthetic callbacks.

`observeBrowserContainerStop({ lease, reader, signal })` consumes the persisted
binding. It requires two matching `CONTAINER_EXITED` CRI observations plus an
empty exact cgroup and unchanged kernel boot before returning `podStopped`.
Missing/deleted/garbage-collected resources remain unknown. It never deletes a
resource, frees a profile, or returns `profileReleased`. A node-side archive is
still needed to preserve positive stop evidence before runtime garbage collection;
the two-read helper by itself is not a complete production recovery observer.

`computerLease.nodeBinding` is immutable under the TeamService row lock, remains
outside workroom/model context, and survives PostgreSQL JSONB key reordering.
The real isolated database proof passes **27 checks**, including fresh-service
read-back, idempotent same-binding updates, cross-pool conflict rollback and
private-context checks for this new record. Browser/node identities in that SQL
proof are synthetic; it does not start a browser or prove process termination.

- Report: `local/lilly-browser-node-binding-postgres-proof.json`
- Proof: `b85697f2-8682-46be-b26b-f8ad5425e23e`
- Source: `/tmp/lilly-node-binding-source.fOKYjz`
- Report directory: `/tmp/lilly-team-pg-proof.HcG8so`
- All 17 recorded source hashes independently match the checkout.
- PostgreSQL 16.15, private Unix socket, network-none, 512 MiB and one CPU.
- Exact proof-label container inventory independently empty after cleanup.
- Existing backend remained 1/1 Running with zero restarts; host seccomp unchanged.

Focused regression: **876 tests in 50 suites**, including 18 node-binding/stop
cases and six supervisor persistence/cancellation cases. Syntax and tracked-diff
whitespace checks pass. No model calls, image rebuild, deployment or live agent
activation occurred. The twelve-check packaged CLI/browser proof below remains
the latest real browser evidence; this checkpoint changes the supervisor and
durable ownership path, not those five baked browser-worker files.

## Task-owned profiles and standalone CLI checkpoint (2026-09-07 UTC)

Supervised profiles now carry an exclusive `owner.json` record containing the
lease UUID and stable agent profile key. Creation writes and syncs the marker,
then independently reads it back. Cleanup checks the exact directory and marker
device/inode generations, rejects symlinks, hard links, oversized records and
unexpected contents, and removes only the owned lock after browser closure.
The actual profile directory and its data are retained. Failed marker persistence
or browser closure retains the cleanup obligation. Legacy empty locks are unknown;
there is no age-based takeover or recursive profile deletion.

The standalone worker requires `LILLY_PROFILE_LEASE_ID`, supplied by the private
Kubernetes supervisor. Its shutdown handler now handles stdin EOF/close/error,
stdout errors and SIGTERM through one cached cleanup promise. After cleanup
settles it releases stdin and reports success or failure through the exit code.
A hung browser close remains pending for external supervision, not declared
successful on a timer. Eight new unit cases exercise these lifecycle paths.

Current local-only image:

- Tag: `localhost/lilly-browser-worker:lifecycle-34yr9p`
- Image ID: `sha256:6d8fee0a556dcb7a11ff97eb49b8363a63db790da70c555d05cb48d4eaca2f8e`
- ARM64, UID/GID 10001, 1,290,968,710 bytes; unchanged matched browser engine.
- Build source: `/tmp/lilly-browser-lifecycle-source.34yR9P`
- Dockerfile SHA256: `b8fcf6a5279d188b1b7eae0cc56201126c47dce5faed2127b798ab8bf780d2d9`
- Context allowlist SHA256: `2356962d83f9376bf64e5a62329cf1b393c067359a5010cd664982b2ca9cf46f`

The five baked worker files now include `profile-lease.js`. The build reused
cached engine layers, with a five-minute deadline, 2-GiB memory cap and two-CPU
CFS quota. The local image ID is not a registry manifest digest. No image push,
k3s import, deployment or live agent activation occurred.

`local/lilly-worker-lifecycle-proof.json`, proof
`8a8a839e-f450-4131-a0ad-3002c7bc594e`, passes **12 checks**. Test source is
`/tmp/lilly-grok-team-source.zcMror`; report directory is
`/tmp/lilly-computer-transport.UAqGIU`. All seven source hashes match the checkout.
The fixture verifies all five baked file hashes, launches the actual `--serve`
CLI twice, opens real Chromium, reads each task-owned lock, terminates through
EOF and SIGTERM, and requires exit code zero with no kill signal. The second
process reuses retained profile data with a different verified lease UUID.
Afterwards, the ordinary private transport checks verify model-only PNGs, one
click, stale-frame rejection, fresh permission revocation and terminal disposal.
There are no external model calls. This is real-process/container proof, not a
live Kubernetes exec, node-crash recovery or full application deployment test.

The expanded fixture initially hit its **128-PID cgroup cap**: retained report
`local/lilly-worker-lifecycle-pid-limit-failure.json`, proof
`92a1d93c-cb88-49f4-bb24-49414bb56cdc`, records nine PID-limit events and zero OOM
kills while opening the first CLI browser. Chromium threads count against that
cap. The extra fixture supervisor/CLI pair now uses a bounded 256-PID allowance;
the passing run explicitly checks zero PID-limit and OOM-kill events after both
CLI lifecycles. Production limits and the 768-MiB/one-CPU fixture bounds were not
changed. Earlier failures are retained in `local/lilly-worker-lifecycle-*-failure.json`.
Fixed-name phases and resource counters contain no raw browser diagnostics.

The earlier task-owned module-only run also passed nine checks, report
`local/lilly-owned-profile-browser-proof.json`, proof
`d107da36-dd00-4d9e-985a-b0236db58736`, image
`sha256:e9b3ce2a1d871b862cf578bde71fec56fa11bf809217c37f613c75b5ab0afef4`.
That checkpoint predates the CLI shutdown fix; its source hashes are historical.

Exact label inventories for every run were independently empty after teardown.
Disposable containers and private tmpfs were removed; reports, isolated source
directories and images remain. Host seccomp SHA256 stayed
`cc374cf23846ce1f62f4dc807a8e2b8673c783c6f56cb475467621035d281e6c`;
`backend-56cbbc96bc-ffz67` remained 1/1 Running with zero restarts.
Focused regression: **852 tests in 49 suites**, with isolated session-test data.
Syntax and tracked-diff whitespace checks pass. No frontend rendering changed.

**Still required:** a trusted node observer proving process/cgroup termination,
exclusive cross-process recovery coordination, production browser egress policy,
supervisor wiring and deployed end-to-end proof. A filesystem ownership receipt
does not prove process death. Do not expose this helper as a model tool or call
it from concurrent recovery observers without an exclusive fence. Automatic
stale-lock takeover remains disabled.

## Kubernetes factory and packaged worker checkpoint (2026-09-07 UTC)

`src/agent-computer/kubernetes-supervisor.js` composes the durable TeamService,
lazy adapter and private RPC transport. It reserves intent before provisioning,
inventories the exact names, binds immutable Pod/PVC/container identities and
checks the running image and profile again before its single exec attempt.
Lost create responses are inspected by exact identity, never replayed. Missing
previously bound storage is not silently replaced. No PVC is deleted.

The generated browser Pod uses UID/GID 10001, no service-account token, no
provider key or Secret, a read-only root, zero added capabilities, bounded
CPU/memory/tmpfs and a required `Localhost` seccomp profile under `lilly/`.
There is no public port or browser Service. The profile mounts only at
`/profiles`; stderr is discarded and stdout is exclusively the private RPC.
The existing Kubernetes exec adapter now accepts an explicit maximum of 16 MiB
for image frames; ordinary ACP keeps its existing 1-MiB default.

Historical ordering (superseded by the stop-before-deletion checkpoint above):
close issued an exact-UID Pod deletion and required a separate trusted
`observeTermination` result matching lease, claim, owner boot, Pod, profile and
container identities, with `podStopped` and `profileReleased` true. The callback
must independently verify termination and settle the exact profile lock; it
cannot infer either from the supplied Pod snapshot. A bounded observation
timeout cancels its signal, retains reconciliation and never repeats the close
operation. API absence alone cannot release a previously created browser owner.

`createKubernetesComputerRuntime` is the composition entrypoint. Deployment can
inject it via the existing `computerFactory`, which now receives the same
internal TeamService along with the normal authorization callback. Construction
is lazy and does not provision a Pod. No environment setting enables this new
factory automatically, and no active failure falls back to an in-process browser.

Packaging evidence:

- Local-only image: `localhost/lilly-browser-worker:stdio-v1-tgccoj`
- Image ID: `sha256:b649695de182f509f1193329b7b491db02065ec05d92377eb7e1b8f8f30bcfe7`
- ARM64, UID 10001:10001, 1,290,956,404 bytes; unchanged matched Playwright/Chromium engine.
- Build source: `/tmp/lilly-browser-worker-source.TgCcoJ`
- Dockerfile SHA256: `4e234a4cd48195eb04644ea5f15bc45acd4f74f6b322c76eb717d7d3eba2f0e3`
- Context allowlist SHA256: `138654a3ed54fe07d391bb40ef164bfcea5c52d5bf07d3835ada91760ca96960`

The image contains only four private-worker JS files, their source hash manifest
and the browser engine; supervisor/team/provider code is excluded by the context
allowlist. Its default command still refuses to act as an unsupervised service.
The initial build invocation rejected the unsupported `--cpus` flag before
starting. The successful build used a five-minute deadline, 2-GiB cap and
two-CPU CFS quota, reusing all matched-engine installation layers. It has not
been pushed, imported into k3s or deployed. A local image ID is not a registry
manifest digest and must not be substituted as one during promotion.

`local/lilly-packaged-browser-proof.json`, proof
`1e362b5e-1f8b-49e0-95eb-1f2afccb1e8e`, passes **eight checks**. Source directory
`/tmp/lilly-grok-team-source.jpigVQ`; report directory
`/tmp/lilly-computer-transport.zgKRXg`. All six report hashes match the checkout,
and the container independently matched all four baked runtime files before
loading the packaged `startWorker`. Real private PNGs, one click changing the
page, stale-frame rejection without replay, fresh host permission revocation,
terminal disposal and exact container removal pass. No model inference ran.
This invokes the packaged worker module inside the fixture bootstrap; it is not
a live Kubernetes exec or standalone CLI lifecycle test.

The first run failed before browser startup because the disposable source root
was mode 0700 and unreadable by UID 10001. Its report is retained at
`local/lilly-packaged-browser-proof-startup-failure.json`, proof
`28051de3-3a22-4c56-8933-8edb922efcd5`. That exact container was independently
absent before the corrected run. Both proof containers are removed; source,
reports and image remain. Host seccomp SHA256 is unchanged; the existing backend
remained 1/1 Running with zero restarts. Production data and live agents were not
accessed. No frontend rendering changed.

Research verified 2026-09-07: Kubernetes documents
[Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/),
[node-local seccomp profiles](https://kubernetes.io/docs/tutorials/security/seccomp/)
and [persistent-volume access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/).
These are design constraints, not proof of this cluster's enforcement. The
app-scaffold skill's template directory and `secure-codex`/`k3s-codex` commands
were unavailable; generated-spec unit checks are not a substitute for the pending
live schema, sandbox and network-policy acceptance checks.

Current focused regression: **833 tests in 47 suites**. This includes 21 new
browser-supervisor cases, the image-context contract, explicit exec-frame bounds,
the composed task/lease/private-channel lifecycle and existing team, Grok,
artifact, authentication and session behavior. Tests reject modified sandbox,
host-network, sidecar and profile-mount specs before exec. Syntax and tracked-diff
whitespace checks pass. These simulated API tests are intentionally distinct
from the eight-check real packaged-browser proof above.

## Durable ownership checkpoint (2026-09-07 UTC)

`src/agent-teams/computer-lease.js` reserves a browser owner through TeamStore's
row-lock transaction before a supervisor may provision resources. The reservation
binds the task claim, executor boot identity, pinned image, exact Pod name and
stable per-agent profile. Observed Pod/PVC/container identities are immutable.
The stable profile binding is separate from agent/model/workroom projections.
Reservation retries read the existing intent; they never authorize reprovisioning.

Task completion and recovery both require a closed browser lease with explicit
process-stop and profile-release acknowledgement. Unknown cleanup blocks the
next claim, including a legacy terminal task missing cleanup evidence. The
acknowledgements are trusted supervisor inputs, not proof derived from a Pod
disappearing or a timer expiring. No owner/model command may write them. The
production observer that supplies real evidence is still required.

`src/agent-computer/supervised-runtime.js` supplies the synchronous lazy adapter
required by `computerFactory`. It checks authority before acquisition, permits
only one acquisition per agent/claim and counts pending acquisitions toward its
capacity. Shutdown fences late authorization/acquisition; task cleanup waits for
the exact browser and supervisor. Unknown acquisition or cleanup remains occupied
without automatic retry. Confirmed pre-dispatch rejection is distinguished from
an uncertain factory failure through the private error registry. Task workers
await `releaseClaim` before returning either successful or failed model outcomes.

Database report: `local/lilly-computer-lease-postgres-proof.json`, proof
`b405e489-6fe7-49f7-b074-b18ac1a145a3`, source directory
`/tmp/lilly-computer-lease-source.9eeCka`, report directory
`/tmp/lilly-team-pg-proof.zNQDUT`. All **26 checks** pass and all **16 source hashes**
independently match the checkout. Three added checks cover 20 competing browser
reservations over two pools with database-clock timestamps, rollback/privacy of
immutable resource bindings, and profile continuity after exact task cleanup.
These browser identities and cleanup acknowledgements are synthetic; SQL,
transactions and service reconstruction are real. No browser/model was launched.

The exact network-none PostgreSQL container was independently confirmed absent
after cleanup. The existing backend remained 1/1 Running with zero restarts.
Production data was not accessed. This checkpoint does not establish node-level
browser quiescence, profile-lock recovery, deployed transport or a live team run.
The selected current-checkout regression passes **810 tests in 45 suites**,
including 10 lease-registry cases, eight supervised-runtime cases, task cleanup
ordering, private projection, artifact/auth/session routes and existing Grok
adapters. Session tests use a new isolated local data directory. Syntax and
tracked-diff whitespace checks pass. No frontend rendering changed in this pass.

## Authority and data flow

Lilly calls `connectComputer` with private stdin/stdout pipes owned by its trusted
supervisor, its normal browser authorization function, and an exact-container
termination function. `serveComputer` hosts the existing AgentComputerRuntime in
the browser process. Every page/navigation/action/model-input authorization call
returns to Lilly over the same bidirectional channel; no model/provider client,
operator token or Kubernetes credentials belong in the browser process.

The production worker entrypoint is `src/agent-computer/stdio-worker.js --serve`.
It requires Linux UID 10001, the bundled Playwright installation, `/profiles`, and
a supervisor-provided `LILLY_COMPUTER_IDENTITY` JSON object containing ownerId,
teamId and agentId. Browser authorization binds to those three fields and still
sends the exact current task claim back to Lilly. One computer is permitted per
worker. WebSockets remain disabled in this worker until their deployed policy is
verified. The entrypoint is now baked into the local-only candidate above at
`/opt/lilly-browser/worker/stdio-worker.js`; it has not been deployed.

The team runtime accepts an optional trusted `computerFactory(computerOptions)`.
Its authorization callback preserves the existing fresh team/claim/origin checks.
The factory is invoked only with global execution, engine availability and vision
opted in. There is no model-selected transport, image, command or filesystem path.
The factory must return a synchronous runtime adapter; deployment must own any
asynchronous container acquisition separately or through a lazy proxy.

## Channel contract

- Versioned newline-delimited JSON over supervised process pipes, not a public API.
- Methods: open, observe, act, model_input, tabs, close, dispose; authorize callbacks
  travel in the opposite direction. Unknown methods fail closed.
- Each direction has monotonically increasing request IDs. Completed IDs cannot
  be replayed. There is no reconnect, retry, or stdin replay on timeout or EOF.
- At most 16 pending/outstanding handler calls by default, bounded message/output
  buffering up to 16 MiB, and a bounded request deadline. UTF-8 split across pipe
  chunks is preserved. Incoming arbitrary diagnostics are never emitted in errors.
- Timeout, cancellation, malformed framing, unknown responses or stream failure
  fence the channel. The supervisor retains responsibility for terminating the
  exact process/container; a pipe closing is not process quiescence evidence.
- Ordinary observation serialization omits non-enumerable pixels, page titles
  and URLs. Only explicit model-input calls carry private image/text content.
  Never log or forward the raw channel to the operator terminal or artifact store.
- Pre-dispatch provenance crosses only this trusted channel from the runtime's
  private error registry. A matching error code alone is not no-effect evidence.
- Disposal is terminal and retains the same promise. It attempts browser cleanup
  and exact supervised termination; failed termination remains rejected on later
  disposal calls. The injected termination function must reject when removal is
  unconfirmed and must preserve persistent profiles rather than delete user data.

## Verified checkpoint: 2026-09-07 UTC

`bin/lilly-computer-transport-proof.js` starts a local authored page inside a
networkless browser container using the production startWorker, transport and
AgentComputerRuntime. Host-side policy authorizes only the fixture identity and
origin. No model inference or production service is involved.

Report: `local/lilly-computer-transport-proof.json`

- Proof ID: `9a72cf60-5214-445d-aa01-f033a45d58ed`
- Remote source: `/tmp/lilly-grok-team-source.tw0NSw`
- Report directory: `/tmp/lilly-computer-transport.Cj4vcG`
- Browser image: `sha256:0c2ef934968082931d5dbb1023a3a285771028ef8430bb861bfe4feb91c99a39`
- All six recorded source hashes independently match the checkout.
- All seven checks pass: real browser transport, model-only pixels, one real click
  changing pixels, stale-frame provenance/no replay, fresh permission revocation,
  exact container cleanup, and terminal adapter disposal.
- UID 10001, Chromium sandbox enabled, no effective capabilities, no-new-privileges,
  enforced AppArmor and scoped seccomp; read-only root, network none, 768 MiB/1 CPU,
  128 PIDs, temporary profiles and a 120-second container lifetime limit.
- Exact proof-label inventory was independently empty after removal. Host seccomp
  SHA256 remains `cc374cf23846ce1f62f4dc807a8e2b8673c783c6f56cb475467621035d281e6c`.
- Regression: 833 tests in 46 focused suites. These include in-memory bidirectional
  callbacks, duplicate IDs, timeout/abort, malformed/oversized frames, error privacy,
  UTF-8 framing, real runtime serialization and runtime factory opt-in.

## Remaining integration gates

1. Promote the tested worker image to a pinned registry manifest, retaining build
   provenance; do not rebuild or silently substitute an unmatched browser pair.
2. Implement and verify the authenticated node-side termination/profile-lock
   observer; reconcile retained startup/cleanup intents after executor loss.
3. Wire the tested factory into the deployed service without claiming a missing
   observer is ready or switching transports when an active supervisor fails.
4. Establish egress policy and deployed Chromium sandbox support, then test actual
   team workers, private browser and authenticated operator UI together.
5. Obtain explicit approval before live-model activation; prove actual perception,
   collaboration, durable outputs, resume/cancel and source-to-public deployment.

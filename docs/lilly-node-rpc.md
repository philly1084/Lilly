# Lilly private node connection

## Backend connection checkpoint — 2026-09-07 16:24 UTC

Backend `backend-85b47d8f9c-bqg6t` successfully rolled out on the unchanged
`ghcr.io/philly1084/lilly:sha-0fad485` image. The dedicated immutable client Secret
is mounted read-only in the backend, and the node network policy permits its exact
Pod IP. An in-backend HTTPS probe verified mutual TLS and the node certificate
fingerprint; backend health is healthy. Evidence:
`local/lilly-node-backend-connection-proof.json`.

Execution, vision, recovery and owner-binding flags are explicitly false. This
proves transport wiring, not team-runtime activation or a successful agent task.
Backend Pod replacement requires a deliberate network allowlist refresh. Existing
node backend-name/PV allowlists remain empty. The prior deployment snapshot is
root-only at `/etc/lilly-node/backend-before-connection.json`; do not blindly
replace a later deployment with that snapshot. No public DNS/TLS route changed.

Status (2026-09-07 16:14 UTC): private native service installed and enabled on
primary at `/opt/lilly-node`, listening on `10.42.0.1:9447`. Dedicated root-only
credentials live under `/etc/lilly-node`. Backend integration and live agent
execution remain disabled. Historical verification sections below describe their
original checkpoints, not the current installation status.

Installed proof: `/opt/lilly-node/install-proof.json` verifies 38 source hashes,
active systemd service, authenticated TLS, missing-client-certificate rejection,
unapproved source-address rejection, and verified database TLS. Limits are 512 MiB,
64 tasks, no-new-privileges and the template's two capabilities. The service's
network allowlist contains loopback, its private interface, the database Service
and exact database Pod IP. **Database Pod replacement requires updating that
allowlist**; backend Pod access has deliberately not been granted yet.

The dedicated database role can read and update team state but cannot insert,
delete or create tables. The empty team schema exists. Node ServiceAccount/RBAC
and a dedicated service-account token exist in `lilly-team-workers`; backend Pod
and PV allowlists are empty. No recovery helper or model has been launched.
The recovery image remains a configured digest, not a verified installed worker.
Certificate expiry/rotation, backend credential delivery, backend access policy,
and combined recovery execution remain follow-up requirements.

To stop the new service without affecting PostgreSQL or the backend:
`systemctl disable --now lilly-node.service`. Preserve credentials and team data
for investigation; do not rerun the create-only installer over existing state.

## Responsibility boundary

The protocol binds **browser containers for existing task leases**, plus a
separate opt-in backend startup identity operation. `bindExecutionOwner` accepts
an unbound Linux execution-owner record, not a fabricated browser lease. It
requires an explicitly configured backend Pod name and matches API, CRI, process
namespaces and populated cgroup twice on the owning node. It does not read or
mutate task rows, stop processes, or declare quiescence.

Normal server startup can select this binder through
`LILLY_TEAMS_BIND_EXECUTION_OWNER=true` when teams are enabled. The runner acquires
and freezes the returned identity before admission. Missing config, unknown node
or failed binding does not downgrade to an unbound claim. There is still no
configured `observeQuiescence` implementation: startup identity alone is not
end-to-end crash recovery or permission to replay an interrupted action.

Lilly's backend owns task identity, permissions, admission and the public UI. The
host service owns node-local process observations, exact container stop requests
and mounted recovery. Model/browser workers receive neither its credentials nor
its Kubernetes/runtime access. This connection carries no browser frames, tool
commands, model credentials or arbitrary filesystem paths.

`createNodeRpcServer` returns an unbound HTTPS server. Supply the private
TeamService backed by the same authoritative database, the exact host node name,
`createNodeComputerOperations(...)`, and reviewed TLS material. The native node
readers require the actual host's process/mount view; running them in the ordinary
backend container does not establish that view. Native startup and scoped database
access now pass isolated Linux verification. Reviewed deployment credentials and
installed service verification remain outstanding.

Do not mount the root runtime socket into an agent Pod or expose this server
through Lilly's public Express app/Ingress. Deployment must choose a private bind
address and restrict ingress to the backend. Give each node a distinct leaf
certificate/private key; only configured backend client fingerprints are admitted.

## Protocol

Only `POST /internal/lilly-computer/v1`, JSON, is accepted. The exact request keys
are `version: 1`, UUID `id`, allowlisted `method`, `identity`, UUID `leaseId` and
`nodeName`. Identity consists of `ownerId`, `teamId`, `agentId`, `taskId` and the
original `{ taskId, workerId, claimId }` claim. Requests cannot supply a lease,
container ID, shell command, Pod spec, image, URL to execute or secret.

Methods are `bindContainer`, `requestStop`, `captureStop`, `observeTermination`.
The node reloads the authoritative lease, checks worker/claim/boot/node/phase
before dispatch and checks again before replying. Stop and profile receipts must
also exist in the store; helper closure gates profile release. Replies are
allowlisted and bound to the request ID, lease ID and node. Failures expose only
`node_operation_unconfirmed`, never internal exception text.

The fifth method, `bindExecutionOwner`, uses an independent exact envelope:
`{ version: 1, id, method, owner, nodeName }`. The owner must be version 1, Linux,
namespace `kimibuilt`, container `backend`; supplied container bindings, task
claims, lease IDs and extra fields are rejected. The reply is bound to request
ID, node and owner boot ID and contains a validated version-2 container binding
including cgroup identity. The same mTLS, replay, size, deadline and admission
limits apply. It is unavailable unless the native service has a nonempty
`backendPodNames` allowlist. Names are configuration, never taken from the request
as permission to inspect an arbitrary Pod.

- TLS 1.3 minimum, mandatory client certificate validation and fingerprint pins.
- Client verifies normal CA/hostname identity AND the configured node fingerprint.
- No redirects, automatic retries, insecure TLS switch or endpoint discovery.
- 8 KiB request / 16 KiB reply, 16 active operations by default, bounded headers
  and a maximum 60-second operation deadline.
- Disconnect/deadline aborts the underlying operation's signal. Its admission
  slot stays occupied until the actual promise settles; a timed-out response is
  not termination evidence and cannot release durable workspace ownership.
- Up to 4,096 recent request IDs are denied replay for ten minutes in that
  server process. This is not a durable exactly-once guarantee. Existing SQL
  launch/write intents and immutable receipts provide cross-restart fencing.

## Backend selection

`createTeamRuntime` accepts `LILLY_TEAMS_COMPUTER_TRANSPORT=in-process` (existing
default) or `kubernetes`. With `kubernetes`, `LILLY_TEAMS_ENABLED=true` and
`LILLY_TEAMS_VISION_ENABLED=true`, it loads:

| Setting | Required value |
| --- | --- |
| `LILLY_TEAMS_NODE_RPC_CONFIG` | Absolute path to a backend-only JSON configuration |
| `LILLY_TEAMS_BROWSER_IMAGE` | Promoted browser image pinned with `@sha256:` |
| `LILLY_TEAMS_BROWSER_SECCOMP_PROFILE` | Reviewed installed profile such as `lilly/chromium-v1.json` |

The JSON configuration has exactly `version: 1`, `nodes` and `tlsFiles`.
Each node specifies `{ name, url, fingerprint }`; URL is a fixed HTTPS origin
without credentials, query, fragment or custom path. `tlsFiles` specifies absolute
`key`, `cert` and `ca` file paths. Files are bounded to 64 KiB, kept in backend
memory and never copied into worker environments. Certificates must cover each
configured hostname/IP and pass the pins. Paths/endpoints belong to reviewed
deployment configuration, not agent/task input.

Global execution/vision opt-out does not read these files or create a computer.
Invalid configuration fails construction; opted-in transport never falls back to
in-process on an error. An injected custom computer factory cannot override an
explicit `kubernetes` setting. No flag has been changed in the deployed service.

## Native service entrypoint

`bin/lilly-node-service.js --config /etc/lilly-node/service.json --check`
validates local configuration, host context, the configured database role and
existing team schema without binding a listener or launching a worker. Without
`--check`, it starts the private mutual-TLS listener. Importing the module starts
nothing. `deploy/lilly-node/lilly-node.service` is a deployment template only.

The root-owned configuration and referenced credential files must be regular,
non-symlink Linux files, inaccessible to group/other users and at most 64 KiB.
The exact configuration sections are `version: 1`, `nodeName`, `listen`,
`tlsFiles`, `clientFingerprints`, `database`, `kubernetes` and `recovery`:

- `listen`: explicit locally assigned private IPv4 `host` and `port` (1024–65535).
- `tlsFiles`: absolute `key`, `cert`, `ca` paths; approved client pins are supplied
  separately in `clientFingerprints`.
- `database`: `host`, `port`, `database`, `user`, `passwordFile`, `caFile`.
  User names start with `lilly_node_`. TCP requires a validating CA; Unix sockets
  use `caFile: null`. No inline password or connection-string setting is accepted.
- `kubernetes`: HTTPS-origin `server`, absolute `tokenPath` and `caPath`. Only the
  node client opts into exact-name, GET-only profile PersistentVolume lookup;
  ordinary worker clients retain their namespace restriction.
- `recovery`: digest-pinned `image` and absolute `storageRoot`.
- Optional root `backendPodNames`: at most 32 unique exact Pod names. Omitted or
  empty disables startup binding. This also configures the Kubernetes adapter's
  exact-name GET allowlist in `kimibuilt`; it grants no list, exec, logs or writes.

For backend startup binding, additionally supply
`LILLY_TEAMS_BROKER_NODE_NAME` from Downward API `spec.nodeName`, alongside the
existing Pod name/namespace/UID values, and the backend-only
`LILLY_TEAMS_NODE_RPC_CONFIG` TLS configuration. The node must have a route in that
configuration. Browser vision need not be enabled just to bind execution identity.
Do not set the opt-in flag until reviewed node policy, credentials and RBAC are
ready. New backend Pod names from a rollout require a deliberate allowlist update.

Startup requires Node 24 or newer, native Linux root, matching node name, matching PID/mount
namespace views and cgroup v2. It rejects configured model-provider keys and
`KUBECONFIG`. Database startup checks reject privileged roles, schema-creation,
insert and delete permissions, and require team reads plus state/timestamp
updates. The store checks the existing table without issuing schema DDL.

SIGTERM/SIGINT stop admission and abort pending operations, then wait for their
actual completion before closing database connections. A failed drain exits
unsuccessfully rather than treating a timeout as proof of worker termination.

## Node Kubernetes identity rendering: 2026-09-07

`bin/lilly-node-rbac.js --config <absolute-reviewed-json-path>` renders a JSON
Kubernetes List to stdout; it does not contact the cluster or create credentials.
The input requires `nodeName` and `profileVolumeNames`, with optional
`backendPodNames` as above. The volume list is an
explicit list of up to 32 approved `pvc-<UUID>` PersistentVolume names, obtained
from operator-verified Lilly PVC/PV/node ownership, not from model input. Empty
lists grant no volume access. The pure renderer is `node-rbac.js`.

The renderer now emits seven objects, including a `kimibuilt` Role/RoleBinding
that grants only GET of the named backend Pods to the same node service account.
An absent or empty backend list emits empty Role rules, so a deliberately applied
manifest revokes earlier bootstrap reads instead of silently retaining them.

Each node gets a stable, distinct ServiceAccount in `lilly-team-workers` with
automatic token mounting disabled. Its Role grants only Pod get/create/delete,
Pod exec get/create and PVC get in that namespace. A separate ClusterRole grants
only GET on the exact supplied PersistentVolume names. Bindings name only that
node account; neither the backend supervisor nor worker account inherits them.
There are no Secret API permissions, PVC writes, list/watch verbs, token issuance,
RBAC modification, node access, or wildcard grants. An empty list still emits
the same ClusterRole with `rules: []`, so a reviewed later apply can revoke old
volume grants instead of silently leaving them behind.

These are trusted host-service privileges, not safe model-worker privileges.
Pod creation/exec remains namespace-wide: RBAC does not restrict these grants to
our recovery Pod template or prevent a compromised host service from mounting
namespace data. The namespace must remain isolated; application identity checks
are additional controls, not a substitute for API-server admission policy. New
profile volumes require a reviewed allowlist update before mounted recovery can
work. Do not grant unrestricted PV access just to unblock recovery.

The renderer emits no namespace, workload, token Secret, certificate, runtime
flag or network policy. Apply only after target inventory and release approval.
Credential provisioning/rotation and an actual API-server authorization check
for allowed and denied operations remain deployment requirements. Never reuse
the backend token or a host admin kubeconfig in this service. The existing native
client rereads its configured token file for each operation.

Focused verification: **67 tests in three suites** pass, including 18 new renderer
and CLI checks for exact grants, identity separation, empty-list revocation,
invalid/broad input rejection and bounded, non-leaking CLI input. This is local
manifest verification, not deployed RBAC or admission proof. `secure-codex` is
not installed here; its manifest scanner was unavailable. No cluster resources
or credentials changed. The broader regression passes **1,272 tests / 71 suites**
in `local/lilly-node-rbac-jest.json`. JavaScript syntax and whitespace checks pass.

The permission design follows Kubernetes' documented `resourceNames` semantics
and the limitation on restricting create requests by name:
[Kubernetes RBAC reference](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
(reviewed 2026-09-07).

## Verification checkpoint: 2026-09-07

Current regression: `local/lilly-node-systemd-jest.json` — **1,234 tests in 69 suites**.
The latest native systemd proof below passes eight real checks. Three additional
unit tests ensure the transient proof preserves every service-limit property,
rejects unexpected template changes and rejects ambiguous command paths.

Earlier report: `local/lilly-node-service-jest.json` — **1,231 tests in 68 suites**.
This includes 23 native-service/configuration tests, existing-schema checks,
restricted volume reads and a real mutual-TLS shutdown/drain test. Native host,
database-role and startup tests in this Jest report use injected fixtures. The
separate Linux proof below exercises the actual CLI and database. The installed
systemd unit and production connection remain unverified.

### Transient systemd proof

`bin/lilly-node-service-proof.js --run-isolated --systemd` passes **eight real
checks** on systemd 255, Ubuntu 24.04 ARM64, Node 24.18.1 and disposable PostgreSQL
16.15. Report: `local/lilly-node-systemd-proof.json`, proof
`9fed7626-b28d-4798-88b5-4a216e09cc4d`. The 32 recorded source hashes and service
template hash match the workspace at this checkpoint.

The proof copies service properties from the checked-in template, changing only
the executable/configuration/working-directory paths for the isolated fixture.
It adds a 45-second maximum runtime and uses a uniquely named transient unit;
it does not install a unit or enable anything at boot. Both `ExecStartPre` and
the listener run through systemd. Live properties and `/proc` confirm the two
allowed capabilities, no-new-privileges, 512 MiB memory, 64 tasks and 100% CPU.
Mutual TLS, unsupported-route refusal and database disconnection pass under
these restrictions. The exact transient unit was collected and the disposable
database and credentials were removed.

This revealed a real template defect: omitting `AF_NETLINK` made Node's
`os.networkInterfaces()` fail with `ERR_SYSTEM_ERROR`, preventing startup.
Two short transient diagnostics reproduced failure without that family and
success with it. The template now allows `AF_NETLINK` for interface discovery;
no `CAP_NET_ADMIN` permission was added. The original failed proof is retained
in `local/lilly-node-systemd-failure.json` (its unit and database were cleaned).

This establishes startup and normal shutdown under systemd limits, not actual
container-stop/recovery operations under those limits, automatic restart recovery,
production credentials, cross-host routing or boot-time installation.
Workflow reference reviewed 2026-09-07:
[systemd transient service documentation](https://github.com/systemd/systemd/blob/main/man/systemd-run.xml).

### Native Linux proof

`bin/lilly-node-service-proof.js --run-isolated` passes **six real checks** on
Ubuntu 24.04 ARM64, Node **24.18.1**, and a disposable network-disabled PostgreSQL
**16.15** container. Report: `local/lilly-node-service-node24-proof.json`, proof
`bd15259c-74ee-4272-a433-f1dede7d2443`. All 32 recorded source hashes match the
workspace at this checkpoint.

The checks exercise existing-schema setup with a dedicated restricted role;
actual CLI preflight; SQL denial of schema creation/inserts/deletes with allowed
state-column updates; startup refusal after granting excess privileges; a real
loopback mutual-TLS connection rejecting an unsupported route; and SIGTERM
exit with zero remaining service database sessions. No Kubernetes operation,
model, browser or agent starts. The exact database container and temporary
credentials were removed; nonsecret reports/source fixtures remain under `/tmp`.

The first run exposed host Node **20.20.2** at `/usr/local/bin/node`. Its report
is retained as `local/lilly-node-service-linux-proof.json`, not accepted as the
target-runtime proof. Startup now rejects Node versions below 24. The systemd
template uses `/opt/lilly-node/runtime/bin/node`; installing a reviewed dedicated
runtime is required and must not replace the host Node installation. The proof
binary came from cached image digest
`sha256:19cd848a0e073d34bd8cd5545a1b6b4d28489b3e3b607366621ced442bd5f6b4`;
binary SHA-256 is
`a990a8ae388fc285ddbce280e63fca48cfd7695f632b66aec6ed581566eace99`.
The binary-extraction container was never started and was removed afterward.

After the runtime correction, **95 tests in four directly affected suites** pass.
This proof does not validate the unit's installed capability limits, private
cross-host networking, real mounted recovery, or production access.

### Earlier transport checkpoint

Report: `local/lilly-node-rpc-jest.json` — **1,205 tests in 67 focused suites**.
The 36-check RPC suite uses actual local HTTPS/mutual-TLS connections on Node
24.19.0, with disposable one-day EC certificates from OpenSSL 3.2.4. It covers
all four methods, unapproved/missing client certificates, wrong CA/server pin,
stale ownership, unsupported input, replay, missing stored evidence, unfinished
helper, deadlines/admission retention, disconnect, reply binding, oversized
replies and refusal to follow redirects. Node operations and database responses
are simulated in this transport suite; this is not real cluster recovery.

Eight configuration-loader and three team-runtime checks cover backend-only
file wiring, inactive defaults, authorization/service continuity and no fallback.
Temporary certificate/key files were removed and all test listeners closed.
Syntax checks and `git diff --check` pass. No production credentials were read
or changed, and no remote resources or models were activated.

Reviewed primary documentation:
[Node TLS certificate authentication](https://nodejs.org/api/tls.html) and
[Node HTTPS certificate pinning](https://nodejs.org/api/https.html).

The removed-cgroup fallback separately passes four real k3s/CRI/kernel checks
after explicit approval, using a fixed sleep process rather than a model or
browser (`local/lilly-retired-owner-k3s-proof.json`). Its exact Pod and network
policy were removed. This does not prove the full browser/helper recovery chain
or those observations under the native service's capability limits.

Remaining acceptance: installed systemd verification and scoped credentials, private
network/firewall proof, current helper image/SQL refresh,
combined mounted Kubernetes recovery, and approved real-model/operator-UI testing.

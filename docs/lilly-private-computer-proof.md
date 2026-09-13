# Private computer runtime acceptance

## Current result (2026-09-07 UTC)

The production private channel/runtime adapter also passes seven real-container
checks independently of the older fixture-specific transport. Permission callbacks
return to the host, model-only pixels cross the private pipe, a click changes the
image once, stale frames cannot replay it, and termination removes the exact
container. `docs/lilly-computer-transport.md` records evidence and the still-missing
Kubernetes browser supervisor/profile ownership wiring.

The next run passes 21 checks after terminal-disposal and profile-acquisition
shutdown fixes. It verifies that the actual disposed browser runtime rejects
reopening after context cleanup. Six controlled-delay tests cover queued opens,
late authorization/title results, pending/timed-out profile acquisition and
retained failed cleanup. See `local/lilly-grok-team-shutdown-proof.json` and the
terminal-shutdown section of `docs/grok-build-runtime.md`. This is not deployed
crash-recovery or private-browser-supervisor proof.

The expanded combined test now passes 20 checks using real Lilly session/artifact
services and authentication routes. An authenticated workroom HTTP read observes
both workers running and the writer waiting, without exposing browser pixels.
Three artifact downloads pass exact byte/hash and owner-isolation checks. This is
composed service integration, not rendered live UI or full-server/deployment proof.
See `local/lilly-grok-team-full-services-proof.json` and the real-services section
of `docs/grok-build-runtime.md` for evidence and remaining gates.

The latest combined team candidate pairs Playwright 1.63.0 with its own
Chromium 153.0.8010.12 in a separate source-defined browser image. Six
consecutive two-Grok-worker/browser/SQL runs pass all 16 checks with sandboxing
enabled and one actual click each. The old stock-browser pairing's timeout
was captured specifically in the post-click screenshot phase; the matched
candidate avoids that failure in these six runs, without establishing its
single root cause or long-run reliability. See the matched browser-engine
section in `docs/grok-build-runtime.md` for exact images, reports and limits.

The standalone and earlier connected checkpoints below are historical:

The real browser prerequisite probe now passes **all seven checks in two
consecutive disposable containers**. Chromium's sandbox stays enabled, with
the default AppArmor container profile enforced, zero effective capabilities,
no-new-privileges and seccomp filtering. The subsequent connected Grok proof
also verifies actual browser pixels in the Grok model request, a current-frame
tool action and changed pixels in the next request. Inference is scripted.
This is an isolated Podman candidate result, not proof of
the running Kubernetes deployment's browser behavior or production reliability.

`bin/lilly-computer-proof.js` now defines the connected browser checks: launch
with `chromiumSandbox: true`, capture private PNG model input, reject a foreign
agent's frame access, click the current frame on a synthetic page, reject replay
of an old frame, verify a changed screenshot, keep pixels/URLs/titles out of
ordinary observation serialization, and close before releasing the profile
lease. These assertions now execute successfully against the real browser.

The test uses UID 10001, a read-only root, dropped capabilities, no-new-privileges,
network `none`, private IPC, 768 MiB/one CPU and a 45-second container limit.
Profiles are container-private tmpfs. Only copied test code and installed
dependency code are mounted read-only. The page is generated inside the test;
there is no real website, login, provider key or model call. Node/npm tooling
was checked inside the actual container (`npxAvailable: true`); it was absent
from the host PATH but is not the browser blocker.

## Evidence and implementation

### Connected Grok/browser result

`local/lilly-grok-browser-proof.json`, proof
`42c8f7cc-b70c-4f89-805d-bc3464cb6d5f`, passes all seven browser checks and five
additional real-Grok transport/action/privacy/lease checks. It makes five
scripted model requests and zero external calls. Eight source hashes match;
the extraction and integration containers are independently confirmed absent.
See `docs/grok-build-runtime.md` for the exact isolation, accounting and scope
limits. This does not prove live model perception, durable team execution or
worker/browser OS separation in production.

### Sandboxed browser and real frame/action checkpoint

Reports `local/lilly-computer-proof-sandbox-pass.json` (proof
`89ebc1cb-3b4f-4f21-9cf0-089545104457`) and
`local/lilly-computer-proof-sandbox-repeat.json` (proof
`6a32b0d4-49c2-4b6b-9317-48a9fdbe27a4`) each establish:

1. Sandboxed Chromium 152.0.7977.75 launches through the production runtime.
2. A private PNG is returned only as model input, not ordinary observation JSON.
3. A foreign agent cannot retrieve that frame.
4. A real selector click targets the current browser frame and causes exactly
   one fixture POST.
5. Replaying the old frame is rejected without another POST.
6. A fresh screenshot has a different hash after the page changes.
7. Closing the context releases its profile lease and removes the runtime entry.

Both reports' three source hashes independently match the checkout. Their exact
container IDs were independently confirmed absent. No production or external
model request, real website, login, screenshot publication, or deployment occurs.

The candidate requires the installed `runc` launcher and an explicit test-only
seccomp derivation permitting `setns` and `chroot`. The original host policy's
SHA256 remains `cc374cf23846ce1f62f4dc807a8e2b8673c783c6f56cb475467621035d281e6c`.
No host policy/runtime default or container capability was changed. The helper
validates exact known rule shapes before changing them, with six additional
tests for the opt-in chroot change and rejection cases.

The concrete startup assertion was `sys_chroot(...) == 0`, preserved with the
path redacted in `local/lilly-computer-proof-chroot-assertion.json`, proof
`5a3d3696-d1b4-4dd6-97a7-541a3bdd8956`. Current upstream
[sandbox credentials source](https://raw.githubusercontent.com/chromium/chromium/main/sandbox/linux/services/credentials.cc)
corroborates that operation (inspected 2026-09-07); the exact version's credentials
file could not be fetched. The runtime assertion and inspected host policy,
not a guessed source line, identify the blocked operation. The prior diagnostic's first
zygote source line alone did not identify this failed assertion. The installed
seccomp policy conditionally denied `chroot` when the container lacked
`CAP_SYS_CHROOT`. Allowing the syscall permits Chromium's namespace-local
sandbox setup; it does not grant host/container capabilities.

Reliability limit: `local/lilly-computer-proof-chroot-launch.json` (proof
`d7dc23f5-d5cd-414e-bc91-fad7eb950599`) and
`local/lilly-computer-proof-visible-button-timeout.json` (proof
`b3d31082-1c3b-4724-908a-13ad3151eeef`) launched but timed out on the action.
The latter confirmed the correct fixture title and one visible button. The
passing diagnostic revision sets the fixture page's Playwright timeout to five
seconds, shorter than the production fifteen-second operation bound. This is
not a proven fix for the earlier timeouts and has not changed the production
runtime's default. Two successes establish exercised behavior, not long-run
reliability. Retain these failures and investigate recurrence in the connected
Grok/browser loop; do not extend deadlines or replay uncertain actions blindly.

All seven containers from this diagnostic pass were removed and their exact
names independently checked. The backend remained 1/1 Running, zero restarts;
the older unrelated Error Pod was left untouched.
The current selected regression passes **837 tests across 48 suites**.

### Namespace and OCI-launcher isolation (2026-09-07 UTC)

These earlier checkpoints failed before the subsequent chroot adjustment:

- `local/lilly-computer-proof-user-namespace.json`, proof
  `f839d2a6-71a4-42f3-a451-f5416c830d44`: a real user-namespace child exits 0
  under the default policy, zero effective capabilities and no-new-privileges.
  A blanket prohibition on user namespaces is not supported by this evidence.
- `local/lilly-computer-proof-setns-policy.json`, proof
  `c7cf3a0e-0978-43d1-844e-20bf99e56c48`: removing only the inspected default
  policy's capability-dependent `setns` denial does not fix Chromium startup.
- `local/lilly-computer-proof-namespace-matrix.json`, proof
  `23fc701a-5461-47df-90ca-1c6c110a34fb`: user+PID, network, IPC and UTS
  namespace children succeed; user+mount is permission-denied. The process has
  AppArmor label `containers-default-0.57.4-apparmor1//&crun (mixed)`.
  Chromium reports a failed check with permission denied, not the explicit
  "No usable sandbox" or "Failed to move to new namespace" messages. Kernel
  records at this checkpoint contain Chromium ptrace and signal peer denials.
- `local/lilly-computer-proof-runc.json`, proof
  `377b6cd7-6fb0-4f9b-b6ad-1caa01d1302b`: using the already-installed
  `/usr/sbin/runc` only for the disposable container removes the stacked label;
  the default container AppArmor profile is still **enforced**. Chromium still
  fails, now without the permission-denied signal, at a check reported from
  `zygote_host_impl_linux.cc:237`. The namespace matrix remains the same.

The last report's three source hashes match the tested checkout. Earlier report
hashes identify their historical diagnostic versions. These are diagnostic
results, not seven passing browser checks: every report has an empty `checks`
array and no frame/action/model result. The mount denial and AppArmor records
must not be asserted as the remaining root cause without isolating that cause.

`bin/lilly-browser-seccomp.js` is a test-only, fail-closed derivation. It accepts
only the known baseline rule shape, preserves the original policy and every
other syscall restriction, and writes a private per-proof policy file. Seven
tests check the exact diff and unsupported-policy rejection. The probe also
records fixed launch facts instead of leaking raw browser diagnostics. Explicit
`--browser-namespace-profile` and `--runc` flags affect only a fresh disposable
container. Neither is production configuration or an automatic fallback.

All four exact containers were independently confirmed absent. The live backend
remained 1/1 Running with zero restarts; the existing older Error Pod was left
untouched. No host default policy/runtime, production Pod, model or live agent
was changed. Only the disposable container used the derived seccomp profile.
The selected current regression passes **831 tests across 48 suites**. This
does not convert the failed real-browser prerequisite into a passing result.

- `local/lilly-computer-proof-source-permission.json`, proof
  `f539cddf-4c1e-41b3-8650-2627cf4ae23c`: initial setup failed before an inner
  report because the copied source root was mode 0700. Only that non-secret
  source directory was made readable, and copied files were restricted to 0644.
- `local/lilly-computer-proof-sandbox-denied.json`, proof
  `1b690cb3-b04e-4518-8191-d5f2693dea59`: prerequisite check succeeds, then
  sandboxed launch fails. This precedes the launch-error sanitization patch.
- `local/lilly-computer-proof-sanitized-sandbox.json`, proof
  `23adb238-5550-4bac-8ba4-1167d227271e`: same real failure through the current
  sanitized error path; both source hashes independently match the checkout.

Candidate image ID:
`sha256:ecf581aa328e59dd4d32a6a082d480c79f416bd31b94820a446e1e4681c15dbd`.
All exact test containers were removed and absence independently confirmed.
No host sysctl, default seccomp/AppArmor policy, production Pod or live agent
was changed; the later comparison uses its own container-only seccomp file.

The production `AgentComputerRuntime` now converts browser launch diagnostics
into bounded error categories for sandbox, missing executable, missing system
dependencies and other startup failures. It never forwards raw launch commands,
profile paths or diagnostic causes. It does not retry automatically or set
`noSandbox`. Failed launches preserve cleanup/lease handling. Five new runtime
tests cover error redaction and cleanup; three proof tests cover classification.
The selected regression run passes **824 tests across 48 suites**. This source
change has not been deployed.

## Next distinct step

Combine the now-passing actual-browser/Grok path with the durable team and
artifact flow, then the authenticated workroom. Keep previously observed action
timeouts visible. Validate deployment-specific browser policy, worker/browser
separation and lifecycle; this test-only policy must not be silently installed
in production. No sandbox-disabling fallback is permitted.

[Playwright's Docker guidance](https://playwright.dev/docs/docker) recommends a
nonroot browser user and a namespace-capable seccomp profile for sandboxed
Chromium. Its documented example is not permission to disable host protections
or grant broad admin capabilities. A host-wide policy relaxation requires a
separate explicit decision; prefer a dedicated browser-only configuration.
The frame/action assertions and connected Grok transport now pass. Scripted
transport proof still must not be called real model perception.

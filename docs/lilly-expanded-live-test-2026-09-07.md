# Expanded live Grok team test — 2026-09-07

## Local continuation: per-worker model cancellation — 2026-09-08

Source inspection found that `startLiveModelClient.responses.create` ignored
the per-request AbortSignal supplied by the shared budget adapter. Worker
cancellation could therefore leave inference running until global relay expiry.
The local client now sends an ID-scoped cancel message, settles that request,
removes its listener, and ignores late replies. The relay joins each request's
controller with its global controller and aborts only the requested call.
Cancellation never refunds the model-call budget or launches another request.
Relay shutdown also clears its readiness timer and identifies transport closure.

Eleven focused tests passed across three suites, including two simultaneous
requests, pre-cancelled admission, late replies, malformed input, pinned model
selection, and shared-adapter cancellation. These client/relay repairs remain
local: no live model call, source transfer, production activation or deployment
was performed in this continuation. Full swarm acceptance remains outstanding.

## Offline blocker reproduction at 21:21–21:25 UTC

No live model or agent was invoked. Remote Ops baseline confirmed primary Ready.
A synthetic public-schema fixture (`local/grok-parser-blocker-probe.rs`) was
compiled against the actual cached Grok `async_openai` release library in image
`8e7ce117615cac65509520da4f2a1a16ffc4ef22b58e42ab87596649b21d7e39`.
The disposable diagnostic container used no network, a read-only root, dropped
capabilities, one CPU and 1 GiB memory; its executable lived only in tmpfs.

Parser results (exit 0, all expected outcomes asserted):

```text
totals_only: missing field `input_tokens_details`
null_usage: PASS
complete_usage: PASS
```

The running gateway pod `n8n-openai-cli-gateway-5db7458b94-n9wz6`, image
`localhost/lilly-gateway-recovery:82e849f73104`, was inspected read-only.
Its `/app/dist/utils/usage.js` confirms `buildResponsesUsage` omits breakdowns
when not provided, while still emitting a usage object. The isolated adapter
still has the pre-usage-fix hash `9d210ff7385bf11efc981f878a2c6be8a92f5df4e1eb0aecd856773222ff69dc`.

This proves a gateway-to-Grok protocol blocker and verifies the null-usage
compatibility approach against the real parser. It does not retrospectively
prove the exact rejected field of the Astra run: that run discarded raw response
bodies/errors. Its diagnostic whitelist also omitted usage-field names, explaining
why this particular missing-field error would only appear as a generic schema
hint. No production code was changed and no further live test was started.

## Approved native-stream test and parser investigation

The user approved the one-file transfer and isolated test. The transferred
`response-stream.js` matched SHA-256
`9d210ff7385bf11efc981f878a2c6be8a92f5df4e1eb0aecd856773222ff69dc`.
Astra proof `8926b205-6173-4919-adab-dc41fa4a87fa` retained its report under
`/tmp/lilly-grok-team-proof.KNz0h7/report.json`: failed after 23.376 seconds,
one model call, completed provider stream, schema hint, no tools or artifacts.
Worker/browser/private mounts and isolated PostgreSQL were cleaned up; logical
task drain remained unsettled. No production deployment or activation occurred.

Read-only inspection of the pinned Grok image's Cargo.lock identified
`async-openai` 0.33.1 at revision
`95b52ebdedf42143083cf3d6f0e0be7c84e9c808`. Its
[ResponseUsage source](https://github.com/our-forks/async-openai/blob/95b52ebdedf42143083cf3d6f0e0be7c84e9c808/async-openai/src/types/shared/response_usage.rs)
requires both token breakdowns whenever optional usage is present. The local
gateway's `buildResponsesUsage` can omit those breakdowns. This is a concrete
compatibility defect, but the sanitized failed-run report does not establish
that it was the particular field Astra rejected.

The subsequent local adapter repair emits null for incomplete optional usage,
preserves complete real counts, and never substitutes invented zero counts.
Diagnostics now recognize fixed usage-field names without retaining raw errors.
These subsequent changes have not been transferred or tested against a live
model. The full parallel swarm scenario remains unproven.

## Native-stream lifecycle repair

`src/grok-build/response-stream.js` now reconstructs the Grok event lifecycle
from a native stream's authoritative completed response, as well as supporting
legacy completed chunks. It preserves actual output IDs, arguments and text;
rejects empty, incomplete, failed, duplicated or interrupted responses; and
waits for clean EOF before emitting tool calls. This addresses the gateway's
incomplete native lifecycle but does not yet prove Astra compatibility live.
563 tests passed across 38 Grok/team suites after this change.

An initial upload was denied and no workaround was attempted. Following the
user's explicit approval, this one source file was transferred into the existing
isolated `/tmp/lilly-grok-team-source.S1e9IB/` workspace on `168.119.176.121`.
The failed test above supersedes the earlier awaiting-approval status.

## Requested alternative-model comparison at 19:32–19:37 UTC

The authenticated live gateway catalog exposes `gpt-6-astra`,
`deepseek-v4-flash`, and `deepseek-v4-pro`; no separate Astra-light model ID
was listed. A scoped test selector now pins these alternatives without changing
the global model. Astra requests explicitly use reasoning effort `low`.
Seven selector/adapter tests passed; gateway application of reasoning effort
was not independently inspected.

- Astra proof `0b39a6be-bbd7-4f60-b577-7ccbee3bec81`,
  `/tmp/lilly-grok-team-proof.6qEF4u/report.json`, local
  `local/lilly-live-astra-test.json`: one model request, 24.588 seconds.
  The provider stream reached `response.completed`, but Grok rejected its schema
  before tool dispatch. This was not a test deadline or recorded rate-limit failure.
- DeepSeek V4 Flash proof `b0b9c7a3-3b39-481f-8865-13c0be61038f`,
  `/tmp/lilly-grok-team-proof.MdyMFg/report.json`, local
  `local/lilly-live-deepseek-test.json`: six model requests, 252.658 seconds
  including cleanup, stopped at its 250-second execution deadline. `team_context`
  and `team_task` succeeded; no browser action, artifact write, or peer work
  occurred. Some requests failed without a retained provider status; cause unknown.

Both tests removed their worker/browser/private mounts and isolated database.
Neither passed the swarm scenario; neither was promoted to production. Combined
model requests: seven. DeepSeek V4 Pro is selectable but was not exercised.

## Fresh approved run at 19:17 UTC

Proof `789a68b5-6d2a-4d64-add6-e49202048c07`, report
`/tmp/lilly-grok-team-proof.Y82sUe/report.json` (local copy:
`local/lilly-live-approved-test.json`). This run included the bounded continuation,
required draft/final filenames, and stream EOF validation fixes.

- Failed after 98.787 seconds and five admitted model requests (limit 20).
- Real `computer_open` and `computer_observe` succeeded. Three model requests
  included private image input. No artifact write or peer dispatch occurred.
- Grok reported an RPC error with a sanitized `rate_limit` hint. No numeric
  provider status was retained, so an upstream HTTP 429 is not established.
- Only one worker ran; parallel collaboration and independent review remain
  unproven. Completion checks did not turn this into a successful task.
- Worker, browser, private mounts and isolated PostgreSQL were removed. The
  task remains logically unobserved/reconciling, so runner drain is unsettled
  despite confirmed physical resource cleanup.
- No production deployment or global activation was performed. No automatic
  retry was started after the terminal failure.

## Latest checkpoint: private browser transport works; task continuation is incomplete

Follow-up proof `1a6cbaf7-3d15-43ca-91ae-b3755e965b08` under
`/tmp/lilly-grok-team-proof.tfk9AO/` successfully dispatched `computer_open` in
2.51 seconds, started sandboxed Chromium `153.0.8010.12`, and passed its real
private frame into the next live model request. Local report and task-state
copies are `local/lilly-live-grok-browser-fix.json` and
`local/lilly-live-grok-browser-state.json`.

The agent then ended with a promise to save the draft, but wrote no artifact
and sent no peer request. The scenario correctly failed its 150-second deadline.
This proves browser tool and image transport, **not independent visual perception
or successful team collaboration**. It used three model calls. Runner drain
settled, all exact test containers were removed, and private mounts were removed.

Earlier diagnostic proof `49a94cd9-727b-488f-b87f-bb0779460815` identified missing
`type` in the first live stream envelope. The gateway's legacy non-native-stream
path emits one completed `response.chunk`. `response-stream.js` now converts
that actual output into typed Responses events, preserving call IDs, names,
arguments and text, and supplying empty legacy annotations/summary metadata.
This is transport conversion, not scripted inference. Proof
`537edcf2-6294-4ea1-842d-9638482902a3` got past that failure and exposed a separate
test trace wrapper bug: it dropped dispatch metadata. `live-tool-trace.js` now
preserves the exact call ID and signal; the latest live browser proof confirms
the corrected path.

The four expanded-test attempts used 1 + 1 + 4 + 3 = **9 model calls**. Recorded
test execution/cleanup times total about 274 seconds, excluding fixture setup.
No further live inference was run after this checkpoint.

The latest **local-only** completion change allows at most two follow-up prompts
in the same Grok worker/session when an explicitly reviewed deliverable has no
recorded artifact. It retains the existing deadline, broker call budget and tool
lease, and fails if evidence remains absent. It does not auto-reschedule failed
tasks or broaden permissions. This continuation change still needs live proof;
one recorded draft also does not prove that every assignment requirement is met.

A subsequent local change adds pinned `requiredArtifacts` to assignments and
checks every named deliverable at both the worker and authoritative result
recording boundary. The live scenario now pins `draft.md` and `final.md`, so a
draft alone cannot satisfy its continuation gate. This change has not been run
against a live model. Peer messages, memory and independent review remain
separate scenario assertions, not consequences inferred from file existence.

Before the continuation change, 1,114 tests passed in 68 suites. Afterwards,
56 focused worker/Grok-loop tests passed, including bounded continuation and
rejection of prose-only reviewed deliverables. These fixes remain undeployed.

## Initial run

Outcome: **failed before the first tool dispatch; not a completed swarm proof.**

The approved isolated run used real Grok and private-browser containers, actual
isolated PostgreSQL stores, and the existing backend's configured live model
(`kimi-for-coding`). Provider credentials stayed inside the backend. The test
relay buffered actual provider streaming events; it did not script inference.

## Recorded evidence

- Live proof: `5d07e214-9dee-444d-9cfe-f1af8490acc6`.
- Remote evidence: `/tmp/lilly-grok-team-proof.9byyaa/report.json` and
  `team-state.json`; local copy: `local/lilly-live-grok-team-test.json`.
- Database proof: `855eeed5-844c-4ce2-8b71-7d4e0657fd09`, report under
  `/tmp/lilly-team-pg-proof.XfYcuV/`.
- Limits: three agents, 20 total model calls, five minutes. Actual: one admitted
  model request, one Grok worker, 20.742 seconds including cleanup.
- Failure: Grok ACP `rpc_error`; task retained as unconfirmed/reconciling.
- No tool dispatch, browser frame sent to the model, collaboration, or artifact
  creation was observed. The browser container initialized but Chromium was not
  opened. Its successful startup is not perception proof.
- Worker, browser, and disposable PostgreSQL containers were removed. Exact
  proof-label inventory independently confirmed absence. Credential-bearing
  private worker mounts were removed only after confirming worker removal.
- Runner drain remained logically unsettled because the failed task was marked
  unobserved; physical container cleanup does not turn that task into success.

## Diagnosis boundary

The failure is now reproduced across the real Grok-to-live-model path, whereas
the earlier scripted model fixture passed. No provider HTTP exception was
recorded by this run. ACP currently reduces any upstream RPC error to
`rpc_error`, so the evidence does **not** yet distinguish response-schema,
stream-event, or another engine error. Raw upstream diagnostics are deliberately
discarded because they can contain prompts or credentials. A safe, bounded
protocol diagnostic is needed before attributing a root cause or retrying.

The scenario's duplicate peer scheduling was corrected before this run: a
request message itself enqueues peer work, so no separate peer assignment is
created. This did not explain the observed RPC failure, which occurred earlier.

## Regression checks and deployment

1,102 tests passed in 65 suites across agent teams, Grok runtime, private
computer/recovery, and the workroom. These are regression checks, not a passing
live swarm test. The focused subset also passed 74 tests in five suites.

Test code transfer SHA-256:
`e78b5607994a968c352a5f5fbb72cb214827c38172dda60e29527df9cc7070be`.
Primary backend image remained
`localhost/lilly-team-release:8e3e42246bcbbd7f`; no deployment, global scheduler
activation, provider route change, or existing project modification was made.
The newly added test adapters and scenario changes are not a production release.

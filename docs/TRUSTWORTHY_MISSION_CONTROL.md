# Trustworthy Mission Control

This release consolidates KimiBuilt's customer-facing agent work around one inspectable story:

> Choose an outcome, watch Lilly work, steer at checkpoints, inspect the result, verify the proof, then replay or fork the run.

## Canonical contracts

- `AgentRun/v1` is the durable run record. Its legal states are `created`, `planning`, `executing`, `verifying`, `waiting_for_approval`, `blocked`, `completed`, `failed`, and `cancelled`.
- `ToolInvocation/v2` records the run and tool identity, tool version, input hash, action-aware risk, approval receipt, idempotency metadata, expected postconditions, side effects, compensation metadata, result, and typed evidence.
- `EvidenceAttestation/v1` is the only evidence type accepted by authoritative quality gates. Its digest is checked before a gate can consume it.
- `EvalCase/v1` and `EvalRun/v1` describe the deterministic flagship evaluation corpus and persisted results.
- `ArtifactLineage/v1` connects Chat, Notes, and Canvas work through `missionId`, `parentArtifactId`, `revision`, and provenance.

The AgentRun service uses the existing Async Lab event/checkpoint store. Events and snapshots are redacted and bounded before persistence. The service stores no raw credentials or unrestricted command output for replay.

## Public AgentRun API

All routes sit behind the existing KimiBuilt authentication middleware.

| Request | Purpose |
| --- | --- |
| `POST /api/agent-runs` | Create an idempotent canonical run. |
| `GET /api/agent-runs/:id` | Read current run state and its Proof Pack. |
| `GET /api/agent-runs/:id/events?after=<cursor>` | Read ordered events after a cursor. Use `Accept: text/event-stream` or `stream=true` for an SSE replay response. |
| `POST /api/agent-runs/:id/actions` | Perform `pause`, `resume`, `cancel`, `retry-step`, or `fork`. |

Creation and mutating actions accept `idempotencyKey` in the body or `X-Idempotency-Key`. SSE reconnects may send `Last-Event-ID`; an explicit `after` query takes precedence.

Existing Chat, OpenAI compatibility, WebSocket, workload, Agent Company, and remote-runner paths remain compatible. They shadow-capture canonical run state and return `agentRunId`; where `runId` was already part of the legacy contract, it remains unchanged.

## Approval and retry policy

The ToolInvocation policy is action-aware:

- Read-only inspection is automatically allowed.
- Workspace-bounded writes are allowed only in declared sandbox mode.
- Pushes, public deployments, destructive changes, secrets access, and external communication require a matching scoped `ApprovalReceipt/v1`.
- A write may be retried only when its invocation explicitly declares safe idempotency and supplies an idempotency key.

Policy enforcement can remain in shadow mode per tool context during migration. Typed invocation records and approval decisions are still returned for inspection.

## Proof Packs

Every serialized AgentRun includes a derived Proof Pack. It reports artifacts, changed files, evidence-backed checks, screenshots, live URLs, approvals, cost, duration, blockers, missing gates, and an overall verdict.

Success prose is not evidence. Test, browser, TLS, render, deployment, Git, and approval claims must arrive as valid `EvidenceAttestation/v1` records produced from their underlying receipts. Missing or invalid evidence leaves the Proof Pack incomplete.

The remote CLI now returns `RemoteCliResult/v2` with `structuredResult` and `humanSummary`. Marker parsing remains a labeled `legacy-marker-adapter`; its text-derived claims are not promoted to authoritative typed evidence.

## Mission Mode

The root route opens the Lilly outcome launchpad with four starts: Build and launch, Research and publish, Create and refine, and Run an agent company. Web Chat is the primary mission workspace and uses conversation, live work, and result/proof regions. Tool details stay expandable, while real status, checkpoints, artifacts, and missing proof remain visible.

Mission artifacts carry lineage across Chat, Notes, and Canvas. Exact-text Notes edits and exact-object Canvas edits create a new revision instead of silently replacing the original.

Admin Traces includes the persisted eval scoreboard. Unavailable operational data renders as unavailable; recorded runs are labeled as replay and never presented as live execution.

## Replay, evals, and demo gates

```powershell
npm run replay:agent-runs
npm run eval:agent-runs
npm run demo:preflight:offline
npm run demo:preflight
npm run demo:smoke
```

- Replay archives are read-only, digest recorded tool outputs, and cannot execute live tools.
- The initial corpus contains 30 cases: five each for continuity and memory, research and citations, document rendering, website building, remote recovery, and approvals and isolation.
- Deterministic validators run before subjective model judging.
- Model auto-routing is shadow-only; its proposal and the current production route are recorded for comparison.
- `demo:preflight` checks health, models, route assets, tool readiness, preview authorization, sandbox and remote-runner boundaries, and the golden-mission contract.
- `demo:smoke` exercises the canonical API, ordered event replay, pause/resume, and fork lineage.

## Rollout and remaining production qualification

The compatibility bridge is the rollback boundary: legacy APIs continue operating while canonical run capture is observed. Do not remove the legacy completion fields or marker adapter until shadow comparisons show agreement for completion state, tool events, artifacts, and usage.

The following release qualifications require the warmed deployment and cannot be proven by an offline checkout:

- a real process termination after a durable write, followed by one resume with no duplicate external side effect;
- cross-replica serialization and recovery against the production Postgres/Valkey configuration;
- three consecutive browser-verified public golden missions within the preview and deployment latency targets;
- nightly live sandbox evaluations, production p95/cost comparisons, and release-threshold history;
- promotion of remote structured receipts after every remote tool stops relying on the migration marker adapter.


# KimiBuilt Operationalization Hardening Backlog

This backlog turns the PMI-style operationalization plan into KimiBuilt-specific work. It is written for repeated automation or manual implementation passes: each run should take the first unchecked item, make one bounded improvement, verify it, and update the log.

## Operationalization Framing

KimiBuilt is operationalized as a multi-interface AI workbench and agent platform. The model is accessed through web chat, web CLI, notes/canvas/document tools, admin surfaces, API routes, and WebSocket/SSE flows. The runtime is deployed as a secured Node/Express backend on k3s with Postgres-backed sessions/artifacts, Qdrant/Ollama-backed memory, OpenAI-compatible model routing, Kubernetes ingress/TLS, health probes, and CI/CD image publishing.

The remaining work is not to add an unrelated CRM or order-management use case. The remaining work is to make this platform whole for project paperwork and production operations: scaling evidence, release gates, monitoring and alerting, Canadian privacy/data governance, support runbooks, and a repeatable improvement loop.

## Automation Prompt

Use this as the recurring local automation prompt:

```text
Work through docs/operationalization-hardening-backlog.md one unchecked item at a time.

For the first unchecked item:
1. Read the listed files and nearby tests/docs.
2. Make the smallest repo-consistent operationalization improvement that satisfies the item.
3. Add or update focused tests when behavior changes.
4. Run the listed checks, or the closest focused checks available in this checkout.
5. Update the item with status, files changed, checks run, evidence, and any blocker.

Keep the scope to one item per run unless the next item is documentation-only and directly depends on the first. Do not invent CRM/order integrations. Keep privacy language Canadian-first and practical, not California-specific.
```

## Current Assessment

KimiBuilt is already strong as an engineering-operationalized AI platform:

- Multi-interface application surfaces exist: web chat, web CLI, notes/canvas, notation, documents, podcast/video, admin dashboard, and OpenAI-compatible API routes.
- The deployment path exists: Docker image build/publish, k3s manifests, Traefik ingress, TLS/cert-manager configuration, and rollout verification.
- Runtime foundations exist: Postgres session/artifact persistence, Qdrant/Ollama memory, health/readiness/liveness endpoints, auth, CORS, rate limiting, and admin telemetry.
- Test coverage is broad, with focused Jest tests across routes, memory, sessions, orchestration, tools, documents, and frontend helpers.

The platform still needs operational hardening evidence:

- Backend autoscaling is not formalized.
- Load/performance testing is not a named release gate.
- Alerting/SLO ownership is not fully documented or deployed.
- Canadian privacy/data governance is not captured as a concrete operations artifact.
- Human support and incident runbooks need to be explicit.
- The model/prompt/tool improvement loop needs a documented eval and release process.

## Hardening Items

### [ ] OP-001 Add Production Scaling Plan And HPA Baseline

Goal: Make the k3s deployment credible for 24/7 operation beyond a single backend pod.

Primary files:
- `k8s/backend-deployment.yaml`
- `k8s/performance-profile-16c32g.md`
- `k8s/DEPLOYMENT.md`
- `docs/operationalization-hardening-backlog.md`

Suggested shape:
- Add a documented HPA manifest or a deployment note explaining why HPA is deferred for the current single-node environment.
- Capture target metrics such as CPU utilization, memory pressure, p95 response time, and active WebSocket connections.
- Preserve current resource requests/limits and readiness/liveness probes.
- If HPA is not applied because the cluster is single-node or metrics-server is absent, document the blocker and exact enablement path.

Acceptance checks:
- A reviewer can answer how the backend scales, what triggers scaling, and what must be installed/enabled first.
- The current single-replica behavior is either intentionally justified or replaced with a safe autoscaling baseline.
- Kubernetes YAML validates with the repo's existing validation path when YAML changes are made.

Focused checks:
- `python validate_k8s.py`
- `kubectl apply --dry-run=client -f k8s/` when kubectl is available

Status:
- Pending.

### [ ] OP-002 Add Load And Stress Test Release Gate

Goal: Prove the platform can handle expected interactive use and make performance checks repeatable.

Primary files:
- `package.json`
- `scripts/`
- `docs/operationalization-hardening-backlog.md`
- `k8s/DEPLOYMENT.md`

Suggested shape:
- Add a lightweight load test script for `/health`, `/api/chat`, and one static frontend route.
- Prefer a Node-based script using built-in modules or existing dependencies to avoid adding a large toolchain unless needed.
- Include configurable target URL, concurrency, duration, and max p95 latency thresholds.
- Document how to run locally against `localhost:3000` and against the deployed host.

Acceptance checks:
- A release operator can run one command and get pass/fail output for basic load readiness.
- The check does not require real user secrets in logs.
- The script fails clearly on high error rate, unreachable host, or latency over threshold.

Focused checks:
- `node scripts/<new-load-test-script>.js --url http://localhost:3000 --smoke`
- `npm test -- --runTestsByPath <related-test-file>` if a unit-testable helper is added

Status:
- Pending.

### [ ] OP-003 Formalize Monitoring, Alerts, And SLO Runbook

Goal: Convert existing health/admin telemetry into an operations-ready monitoring story.

Primary files:
- `src/observability/health-report.js`
- `src/admin/runtime-monitor.js`
- `frontend/agent-dashboard/README.md`
- `docs/operationalization-hardening-backlog.md`
- `k8s/DEPLOYMENT.md`

Suggested shape:
- Document health signals: `/health`, `/ready`, `/live`, admin dashboard, startup state, dependency health, remote runner state, and memory/session store status.
- Define SLO-style thresholds for uptime, p95 response time, failed requests, failed tool runs, and unhealthy dependencies.
- Add alerting guidance for whichever stack is actually available: Rancher/Kubernetes events first, then Prometheus/Grafana/Alertmanager if installed later.
- Include an escalation path: inspect health, pods, events, logs, rollout status, and last deploy.

Acceptance checks:
- A maintainer can tell what is monitored, what alert states matter, and what to do first when the platform is degraded.
- Alerting is documented without claiming Prometheus/Grafana is live unless it is actually deployed.
- The runbook maps to existing KimiBuilt endpoints and k3s commands.

Focused checks:
- `npm test -- --runTestsByPath src/observability/health-report.js` if behavior changes
- Manual read-through of `/health` shape if docs-only

Status:
- Pending.

### [ ] OP-004 Create Canadian Privacy And Data Governance Packet

Goal: Replace generic CCPA/GDPR language with a Canadian-first governance artifact for KimiBuilt's actual data flows.

Primary files:
- `docs/`
- `src/session-store.js`
- `src/memory/memory-service.js`
- `src/routes/sessions.js`
- `src/routes/artifacts.js`
- `src/routes/notes.js`

Suggested shape:
- Add a concise `docs/privacy-data-governance.md`.
- Describe data categories: chat messages, notes/canvas content, generated artifacts, uploads, logs, model/tool metadata, vector memory, auth/session data.
- Document retention, deletion, export, access control, secrets handling, and backup expectations.
- Use Canadian privacy language such as PIPEDA and applicable provincial or sector obligations, while avoiding legal overclaiming.
- Identify gaps separately from implemented controls.

Acceptance checks:
- A project reviewer can understand what data is collected, why, where it is stored, who can access it, and how it can be deleted/exported.
- The document does not claim compliance beyond implemented controls.
- California-specific CCPA language is removed from this operationalization plan unless explicitly needed for a future jurisdiction.

Focused checks:
- Docs-only review.
- Add focused route tests only if deletion/export behavior is changed.

Status:
- Pending.

### [ ] OP-005 Add Human Operations And Incident Runbook

Goal: Make support, maintenance, deployment, and incident response concrete enough for handoff.

Primary files:
- `docs/`
- `k8s/K3S_RANCHER_PLAYBOOK.md`
- `k8s/DEPLOYMENT.md`
- `docs/CODEX_DESKTOP_REMOTE_TUNNELS.md`

Suggested shape:
- Add or expand an operations runbook covering daily checks, release checks, incident triage, rollback, failed model/tool requests, memory/artifact cleanup, and user-reported bad outputs.
- Include the common k3s flow: get pods, describe, logs, rollout status, health endpoint, ingress check.
- Include who owns prompt/model updates, deployment verification, and privacy/data deletion requests.
- Keep secret handling explicit: never paste or commit secrets; use Kubernetes/GitHub Actions secret paths.

Acceptance checks:
- A maintainer can follow the runbook without needing the original developer in the room.
- The runbook has a first-15-minutes incident checklist.
- Rollback or recovery steps are documented with concrete commands or Rancher UI guidance.

Focused checks:
- Docs-only review.
- Optional smoke: `kubectl get pods -n kimibuilt` when live cluster access is available.

Status:
- Pending.

### [ ] OP-006 Define Model, Prompt, Tool, And Memory Improvement Loop

Goal: Replace vague "model retraining" language with the improvement process KimiBuilt actually uses.

Primary files:
- `docs/`
- `src/perceived-intelligence-harness.js`
- `src/orchestration/run-harness.js`
- `src/conversation-orchestrator.js`
- `docs/prompt-optimization-hourly-backlog.md`

Suggested shape:
- Document a continuous improvement loop: collect feedback, select examples, update prompts/tools/routing, run focused evals/tests, deploy, monitor, and log results.
- Clarify that this iteration uses prompt/tool/model routing and memory improvements rather than fine-tuning unless a future item explicitly adds fine-tune data governance.
- Link the loop to existing harnesses and prompt optimization backlog practices.
- Add an example run-log entry format.

Acceptance checks:
- The paperwork can explain how the AI system improves without promising unsupported retraining.
- The process has gates for regression tests, source evidence, and deployment verification.
- Feedback and bad-output reports have a path into future changes.

Focused checks:
- `npm test -- --runTestsByPath src/perceived-intelligence-harness.test.js src/conversation-orchestrator.test.js` if behavior changes
- Docs-only review otherwise

Status:
- Pending.

### [ ] OP-007 Create Operationalization Evidence Summary

Goal: Produce the final paperwork-friendly summary after the hardening items are complete or intentionally deferred.

Primary files:
- `docs/operationalization-evidence-summary.md`
- `docs/operationalization-hardening-backlog.md`
- `README.md`
- `agents.md`

Suggested shape:
- Summarize operational mode, locations, infrastructure, interfaces, security controls, testing, monitoring, privacy, maintenance, and continuous improvement.
- Include a "Implemented now" section and a "Deferred with rationale" section.
- Cite repo files and commands as evidence.
- Keep it written for project-management paperwork, not only engineers.

Acceptance checks:
- The summary can be pasted into a PMI-style deliverable with minimal editing.
- It accurately reflects implemented controls and does not overclaim autoscaling, alerting, compliance, or retraining.
- It points to the backlog/run log for traceability.

Focused checks:
- Docs-only review.

Status:
- Pending.

## Run Log

Add one entry after each pass:

```text
YYYY-MM-DD HH:mm - OP-XXX - status - files changed - checks run - evidence/blockers
```


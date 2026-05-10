# KimiBuilt Operationalization Evidence Summary

This summary describes how KimiBuilt is operationalized today and where the remaining production hardening is intentionally deferred. It is written for project-management paperwork and should be read with `docs/operationalization-hardening-backlog.md`, which contains item-by-item traceability and the run log.

## Operational Mode

KimiBuilt is a multi-interface AI workbench and agent platform. Users interact through web chat, web CLI, notes/canvas/document tools, admin surfaces, API routes, and WebSocket/SSE flows. The backend is a Node.js/Express service with OpenAI-compatible model routing, Postgres-backed sessions/artifacts, Qdrant/Ollama-backed memory, health probes, authenticated admin surfaces, and k3s deployment manifests.

Evidence:

- `README.md` describes the backend, primary routes, local startup, and k3s deployment entry point.
- `agents.md` describes the four interaction modes, runtime stack, document generation guardrails, build/test commands, security considerations, frontend specifications, and remote operating notes.
- `src/server.js` exposes `/health`, `/live`, `/ready`, auth, rate limiting, CORS, API routes, frontend routes, and WebSocket setup.

## Implemented Now

### Interfaces And Application Scope

Implemented user-facing surfaces include chat, web chat, canvas, notation, documents/artifacts, admin dashboard, OpenAI-compatible API routes, and WebSocket/SSE transport. The operationalization scope is the AI platform itself, not unrelated business-system integration.

Evidence:

- `README.md` lists `/api/chat`, `/api/canvas`, `/api/notation`, `/api/artifacts/*`, `/api/sessions`, and `/ws`.
- `agents.md` documents CLI, Web Chat, Canvas, and Notation Helper modes.
- `docs/operationalization-hardening-backlog.md` records that the hardening work is for the AI workbench and agent platform.

### Infrastructure And Deployment

KimiBuilt has a k3s deployment path with backend, Qdrant, Ollama, ConfigMap, Secret, service, ingress, Traefik/cert-manager guidance, Docker image build/push scripts, and rollout verification. The deployment guide includes concrete kubectl checks and recovery steps.

Evidence:

- `k8s/DEPLOYMENT.md` documents namespace, secrets, ConfigMap, dependencies, backend deployment, ingress, verification, troubleshooting, scaling, monitoring, and load-test release gate commands.
- `k8s/K3S_RANCHER_PLAYBOOK.md` documents Rancher/k3s operating paths.
- `package.json` includes `docker:build`, `docker:push`, `k8s:apply`, `k8s:delete`, and `test:load`.

### Scaling And Capacity

The current production baseline is intentionally single-replica backend operation with vertical scaling and health probes. HPA is not applied today because the backend still uses a shared `backend-state` PVC and `Recreate` strategy, and WebSocket/SSE clients need explicit reconnect acceptance before scale-down automation.

Evidence:

- `k8s/scaling-plan.md` records the OP-001 decision, current scaling runbook, target metrics, HPA blockers, and enablement path.
- `k8s/DEPLOYMENT.md` warns operators not to raise replicas or apply HPA until replica-safety prerequisites are complete.
- `docs/operationalization-hardening-backlog.md` records `py -3.12-64 validate_k8s.py` as passed for OP-001 and notes that live kubectl dry-run was blocked by kubeconfig/API discovery in the local sandbox.

### Load And Release Gate

The repo includes a dependency-free Node load release gate for basic production readiness. It exercises `/health`, `/web-chat/`, and `/api/chat` with configurable target URL, concurrency, duration, p95 latency threshold, error-rate threshold, timeout, and bearer token source.

Evidence:

- `scripts/load-release-gate.js` implements the release gate.
- `scripts/load-release-gate.test.js` covers the load gate helper behaviour.
- `package.json` exposes `npm run test:load`.
- `k8s/DEPLOYMENT.md` documents local and deployed load-gate commands using `KIMIBUILT_LOAD_TEST_TOKEN`.

### Monitoring, Alerts, And SLOs

KimiBuilt has a Rancher/Kubernetes-first monitoring runbook using `/live`, `/ready`, `/health`, `/api/admin/health`, the admin dashboard, runtime task activity, dependency health, remote runner health, pod state, events, logs, and rollout status. SLO-style thresholds are documented as operational targets, not legal guarantees.

Evidence:

- `docs/monitoring-alerting-slo-runbook.md` defines health signals, SLO targets, alert conditions, first-15-minutes triage, and future Prometheus/Grafana/Alertmanager guidance without claiming that stack is live.
- `src/observability/health-report.js` builds the system health report.
- `src/admin/runtime-monitor.js` feeds runtime task activity into admin/operator views.
- `frontend/agent-dashboard/README.md` points operators to dashboard monitoring views.

### Security Controls

The current runtime includes HTTP hardening, CORS controls, JSON size limits, login/tool rate limiting, owner-scoped session/artifact access, HTTP-only auth cookies, Kubernetes Secret usage, and non-root container expectations. These are implemented controls, not a complete security certification.

Evidence:

- `src/server.js` uses Helmet, CORS, JSON size limits, auth routing, rate limits, and health endpoints.
- `src/middleware/security.js` implements CORS and rate-limit helpers.
- `src/auth/service.js` implements auth token handling and authenticated user checks.
- `docs/privacy-data-governance.md` documents access control and secrets handling.
- `docs/human-operations-incident-runbook.md` documents secret rotation, safe run logs, and production recovery cautions.

### Data Governance And Privacy

KimiBuilt has a Canadian-first privacy/data governance packet for its actual data flows: chats, notes/canvas content, artifacts, uploads, vector memory, auth/session data, logs/telemetry, workloads, and managed app metadata. The packet documents collection/use, access control, retention, export, deletion, backups, secrets, and gaps without claiming statutory compliance.

Evidence:

- `docs/privacy-data-governance.md` references PIPEDA and applicable Canadian provincial/sector obligations as review inputs, not as a compliance claim.
- `src/routes/sessions.js`, `src/routes/artifacts.js`, and `src/routes/notes.js` provide owner-scoped session, artifact, and notes deletion/export paths.
- `src/memory/memory-service.js` and Qdrant are documented as derived vector memory surfaces that need cleanup verification when dependencies fail.

### Human Operations And Incident Response

KimiBuilt now has a human operations runbook covering daily checks, release checks, first-15-minutes triage, rollback and recovery, failed model/tool requests, memory/artifact cleanup, user-reported bad outputs, privacy requests, secret handling, remote access, and incident logging.

Evidence:

- `docs/human-operations-incident-runbook.md` gives concrete commands and Rancher UI guidance.
- `k8s/DEPLOYMENT.md` links the runbook from the deployment guide.
- `docs/monitoring-alerting-slo-runbook.md` supplies health/SLO context for incident decisions.
- `docs/privacy-data-governance.md` supplies the data-request path.

### Continuous Improvement

The AI system improves through prompt, tool, model-routing, harness, feedback, and memory changes rather than unsupported retraining claims. The loop includes evidence capture, lane classification, example selection, focused changes, eval/test gates, deployment proof, monitoring, and run-log records.

Evidence:

- `docs/model-prompt-tool-memory-improvement-loop.md` defines the improvement loop and fine-tuning boundary.
- `src/perceived-intelligence-harness.js` scores continuity, planner discipline, recovery, completion discipline, source discipline, sandbox verification, isolation, and surface discipline.
- `src/orchestration/run-harness.js` records harness evidence, blockers, diagnostics, failed tool events, retry counts, token counts, and grading payloads.
- `src/alignment/evaluator-service.js` turns feedback into route, tool, source, memory, and regression-fixture guidance.
- `docs/prompt-optimization-hourly-backlog.md` records the recurring small-change prompt hardening process.

## Deferred With Rationale

| Deferred item | Rationale | Enablement path |
| --- | --- | --- |
| Horizontal Pod Autoscaler for backend | Unsafe while backend uses a shared `backend-state` PVC, `Recreate` update strategy, and long-lived WebSocket/SSE traffic without accepted reconnect behaviour | Make backend replica-safe, switch to rolling-compatible updates, verify metrics-server, then apply the baseline HPA shape in `k8s/scaling-plan.md` |
| Prometheus/Grafana/Alertmanager alerts | Not deployed in the current evidence set; claiming it as live would overstate operations maturity | Start with Rancher/Kubernetes events now; add probes/exporters and alerts from `docs/monitoring-alerting-slo-runbook.md` when the stack exists |
| Statutory privacy compliance certification | The repo has an operational evidence map, not a legal certification | Validate PIPEDA, provincial, sector, contractual, processor, and backup obligations for the target deployment |
| Universal owner-wide data export/delete endpoint | Current routes are session/artifact/notes/admin-cleanup oriented, not a single account-wide workflow | Add a governed user-wide privacy workflow spanning sessions, notes, artifacts, workloads, managed apps, local files, vector memory, and backups |
| Fine-tuning or retraining process | Current improvement uses prompt/tool/routing/memory changes; fine-tuning needs separate data governance | Create a future governed fine-tuning item covering consent/authority, data minimization, retention, deletion, evaluation, rollback, and model provenance |
| Full live-cluster verification from this repo run | Some checks depend on kubeconfig, live cluster access, secrets, or production token availability | Run the deployment guide checks and load gate from the authorized operator environment before a production release |

## Evidence Commands

Use these commands as the repeatable operational evidence set:

```bash
py -3.12-64 validate_k8s.py
kubectl apply --dry-run=client -f k8s/
kubectl get pods -n kimibuilt -o wide
kubectl get events -n kimibuilt --sort-by=.lastTimestamp
kubectl rollout status deployment/backend -n kimibuilt --timeout=180s
curl -fsS https://lilly.secdevsolutions.help/live
curl -fsS https://lilly.secdevsolutions.help/ready
curl -fsS https://lilly.secdevsolutions.help/health
KIMIBUILT_LOAD_TEST_TOKEN="$FRONTEND_API_KEY" npm run test:load -- --url https://lilly.secdevsolutions.help --duration 60 --concurrency 4 --max-p95 2500 --max-error-rate 0.02
```

For local docs-only review, use:

```bash
git diff --check -- docs/operationalization-evidence-summary.md docs/operationalization-hardening-backlog.md README.md
```

## Traceability

The source of truth for this operationalization pass is `docs/operationalization-hardening-backlog.md`. It records OP-001 through OP-007, files changed, checks run, evidence, blockers, and run-log entries. This summary is the final paperwork-friendly rollup, not a replacement for the detailed run log.

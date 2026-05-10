# KimiBuilt Monitoring, Alerts, And SLO Runbook

This runbook describes the monitoring story that exists today for KimiBuilt and the alerting path to add later. It is Kubernetes/Rancher-first and does not assume Prometheus, Grafana, or Alertmanager are installed.

## Health Signals

Use these signals together; no single endpoint tells the whole story.

| Signal | Path or command | Healthy state | Degraded state |
| --- | --- | --- | --- |
| Liveness | `GET /live` | HTTP 200 with `status: live` | Non-200 or no response means the process or route is not serving |
| Readiness | `GET /ready` | HTTP 200 with `status: ready` | HTTP 503 with `starting` or `degraded`; check startup error first |
| System health | `GET /health` | HTTP 200 with overall `healthy` | HTTP 503 with required components `degraded` or `unhealthy` |
| Admin health | `GET /api/admin/health` | `success: true` and health payload | Admin route error or unhealthy component state |
| Admin dashboard | `/admin/` | Stats, activity, logs, traces, and health cards load | Missing data, failed tasks spike, or logs/traces stop updating |
| Runtime tasks | `src/admin/runtime-monitor.js` into dashboard activity | Failed task rate remains within SLO | Failed model/tool/runtime tasks trend upward |
| Sessions | `/health` component `sessionStore` | Postgres `healthy` or documented memory mode | Postgres unhealthy, unavailable, or unexpected memory-only mode |
| Memory | `/health` components `memory`, `qdrant`, `ollama` | Memory diagnostics present; Qdrant/Ollama healthy or known optional state | Vector search/embed dependency unhealthy when memory is expected |
| Remote runner | `/health` component `remoteRunner` | Disabled intentionally or at least one healthy runner | Enabled but no healthy runner, repeated remote task failures |
| Kubernetes | `kubectl get pods -n kimibuilt -o wide` | Backend ready and restarts stable | CrashLoopBackOff, ImagePullBackOff, pending pods, restart loops |

The `/health` payload is built by `src/observability/health-report.js`. Required components include boot state, server, session store, SDK, and LLM client. Optional components such as Qdrant, Ollama, TTS, audio processing, podcast video, auth, WebSocket, and remote runner still matter for feature-specific incidents.

## SLO Targets

These are operational targets for production review, not legal guarantees.

| Area | Target | Page when |
| --- | --- | --- |
| Public app availability | 99.5% monthly availability for `/live` and ingress reachability | `/live` fails for 2 consecutive minutes |
| Readiness | `/ready` returns 200 within 2 minutes after deploy | `/ready` remains 503 after rollout completes |
| Interactive latency | p95 `/api/chat` first response under 2.5s in the load release gate | `npm run test:load` fails p95 threshold |
| Static UI latency | p95 authenticated `/web-chat/` under 1s in the load release gate | Static route p95 exceeds 1s or returns 401/403 unexpectedly |
| Request failures | Error rate under 2% during the load release gate | Error rate exceeds 2% outside known auth test failures |
| Runtime task failures | Fewer than 5 failed tasks in 15 minutes, excluding user-cancelled work | Admin stats/activity shows a sudden failure cluster |
| Tool failures | No repeated failure of the same tool class for 10 minutes | Same tool fails 3 times with the same root error |
| Dependencies | Required `/health` components stay healthy | `sessionStore`, `sdk`, or `llmClient` is degraded/unhealthy |
| Memory dependencies | Optional memory components stay healthy when memory features are enabled | Qdrant/Ollama unhealthy and memory features are user-facing |
| Remote runners | At least one healthy runner when remote runner mode is enabled | Remote runner enabled with zero connected healthy runners |

## Alerting Path

### Available Now

Use Rancher and Kubernetes events as the first alerting layer:

```bash
kubectl get pods -n kimibuilt -o wide
kubectl get events -n kimibuilt --sort-by=.lastTimestamp
kubectl describe deployment/backend -n kimibuilt
kubectl logs -l app=backend -n kimibuilt --tail=200
kubectl rollout status deployment/backend -n kimibuilt
```

Trigger manual attention when any of these appear:

- Backend pod is not ready, restarting repeatedly, or waiting on image pull.
- `/ready` stays 503 after rollout completion.
- `/health` reports an unhealthy required component.
- Admin dashboard activity shows repeated runtime failures.
- Load release gate fails outside an expected local-auth setup.
- Remote runner is enabled but has no healthy runner.

### Later, If Prometheus/Grafana/Alertmanager Are Installed

Do not mark these live until the stack exists. When installed, add probes or exporters for:

- HTTP uptime and latency for `/live`, `/ready`, `/health`, `/web-chat/`, and `/api/chat`.
- Kubernetes pod restarts, readiness, CPU, and memory pressure.
- Admin task failure rate and tool failure rate, either through structured logs or a future metrics endpoint.
- Dependency health extracted from `/health.components`.

Recommended starting alerts:

- `KimiBuiltBackendDown`: `/live` fails for 2 minutes.
- `KimiBuiltNotReady`: `/ready` fails for 5 minutes after deploy.
- `KimiBuiltRequiredDependencyUnhealthy`: `sessionStore`, `sdk`, or `llmClient` unhealthy for 2 minutes.
- `KimiBuiltRuntimeFailureSpike`: 5 failed runtime tasks in 15 minutes.
- `KimiBuiltRemoteRunnerUnavailable`: remote runner enabled with no healthy runner for 5 minutes.

## First 15 Minutes Of Triage

1. Confirm scope:

```bash
curl -fsS https://lilly.secdevsolutions.help/live
curl -fsS https://lilly.secdevsolutions.help/ready
curl -fsS https://lilly.secdevsolutions.help/health
```

2. Check pods and events:

```bash
kubectl get pods -n kimibuilt -o wide
kubectl get events -n kimibuilt --sort-by=.lastTimestamp
```

3. Inspect backend state:

```bash
kubectl describe deployment/backend -n kimibuilt
kubectl logs -l app=backend -n kimibuilt --tail=200
kubectl logs -l app=backend -n kimibuilt --previous --tail=200
```

4. Verify rollout and last deploy:

```bash
kubectl rollout status deployment/backend -n kimibuilt
kubectl rollout history deployment/backend -n kimibuilt
kubectl describe pod -l app=backend -n kimibuilt
```

5. Use the admin dashboard when HTTP auth is working:

- Open `/admin/`.
- Check Overview for success rate and average response time.
- Check Logs for repeated route/model/tool errors.
- Check Traces for the failing task path.
- Check Health for degraded dependency names.

6. Decide the recovery lane:

- Startup/readiness failure: inspect `/ready.error`, backend logs, config, and secrets.
- Model failures: verify `OPENAI_BASE_URL`, `OPENAI_API_KEY`, gateway health, and recent model config changes.
- Session failures: inspect Postgres/session store health and recent persistence changes.
- Memory failures: inspect Qdrant/Ollama pod health and `/health.components.qdrant` or `/health.components.ollama`.
- Remote runner failures: inspect runner registration, token configuration, and `/health.components.remoteRunner`.
- New release regression: use rollout history and the deployment guide rollback path.

## Evidence To Record

For every incident or release-health review, record:

- Start/end time and affected user-facing surface.
- Failing endpoints or dashboard panels.
- Pod/event/log evidence.
- Last deploy or config change.
- Whether required `/health` components were unhealthy.
- Commands run and their result.
- Recovery action and follow-up backlog item.

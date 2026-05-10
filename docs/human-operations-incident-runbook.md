# KimiBuilt Human Operations And Incident Runbook

This runbook is the handoff path for people operating KimiBuilt in production. It covers routine checks, releases, incidents, recovery, bad outputs, data requests, and cleanup using the controls that exist in this repo today.

It complements:

- `docs/monitoring-alerting-slo-runbook.md` for health signals, SLO targets, and alert thresholds.
- `docs/privacy-data-governance.md` for Canadian-first data handling, export, deletion, and retention practices.
- `k8s/K3S_RANCHER_PLAYBOOK.md` for k3s, Rancher, ingress, TLS, and remote command details.
- `docs/CODEX_DESKTOP_REMOTE_TUNNELS.md` for local Codex Desktop SSH tunnel setup and safety notes.

## Operator Roles

| Area | Primary owner | Handoff evidence |
| --- | --- | --- |
| Production health and incidents | On-call maintainer or deployment operator | Incident log entry with endpoints, pod/events/log evidence, and recovery action |
| Releases and rollback | Release operator | Image/tag, manifest diff, release gate result, rollout status, and public endpoint checks |
| Prompt, model, tool, and routing updates | AI platform maintainer | Prompt/tool change summary, focused eval/test result, deployment verification, and monitoring follow-up |
| Privacy, export, and deletion requests | Privacy/data operator | Request verification, owner/session/artifact scope, actions taken, and backup follow-up |
| Secret rotation | Deployment operator with secret-store access | Secret path used, rotation time, restart/rollout evidence, and affected surfaces checked |

Do not process operational decisions from chat context alone when the action affects production data, secrets, or public availability. Confirm the target environment, owner, and requested scope first.

## Daily Checks

Run these checks at the start of a maintenance window or daily during active production use:

```bash
curl -fsS https://lilly.secdevsolutions.help/live
curl -fsS https://lilly.secdevsolutions.help/ready
curl -fsS https://lilly.secdevsolutions.help/health

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get pods -n kimibuilt -o wide
kubectl get events -n kimibuilt --sort-by=.lastTimestamp | tail -n 50
kubectl rollout status deployment/backend -n kimibuilt --timeout=180s
```

Open `/admin/` when authenticated access is available and check:

- Health cards for degraded components.
- Logs for repeated route, model, tool, memory, artifact, or auth errors.
- Traces or activity for repeated failed runtime tasks.
- Storage summaries before any cleanup decision.

Record abnormal findings with time, surface, command output summary, and next action. Do not paste secrets or full user content into the log.

## Release Checks

Before deploying:

1. Confirm the target host and namespace.
2. Review the changed files and image tag.
3. Run focused unit tests for changed behavior.
4. Run the load release gate when the backend or frontend route behavior changed:

```bash
KIMIBUILT_LOAD_TEST_TOKEN="$FRONTEND_API_KEY" npm run test:load -- --url https://lilly.secdevsolutions.help --duration 60 --concurrency 4 --max-p95 2500 --max-error-rate 0.02
```

5. Apply manifests or update the image through the normal release lane.
6. Verify rollout and public endpoints:

```bash
kubectl rollout status deployment/backend -n kimibuilt --timeout=180s
kubectl get pods -n kimibuilt -o wide
curl -fsS https://lilly.secdevsolutions.help/live
curl -fsS https://lilly.secdevsolutions.help/ready
curl -fsS https://lilly.secdevsolutions.help/health
```

Use GitHub/GitLab Actions secrets, Kubernetes Secrets, or the deployment secret manager for credentials. Never paste live secrets into manifests, docs, chat, issue comments, screenshots, or run logs.

## First 15 Minutes Of An Incident

1. Confirm user-facing scope:

```bash
curl -fsS https://lilly.secdevsolutions.help/live
curl -fsS https://lilly.secdevsolutions.help/ready
curl -fsS https://lilly.secdevsolutions.help/health
curl -fsSIL --max-time 20 https://lilly.secdevsolutions.help/
```

2. Check pods, events, rollout, and ingress:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get pods -n kimibuilt -o wide
kubectl get events -n kimibuilt --sort-by=.lastTimestamp | tail -n 50
kubectl describe deployment/backend -n kimibuilt
kubectl rollout status deployment/backend -n kimibuilt --timeout=180s
kubectl get svc,ingress -n kimibuilt -o wide
```

3. Inspect logs:

```bash
kubectl logs -l app=backend -n kimibuilt --tail=200
kubectl logs -l app=backend -n kimibuilt --previous --tail=200
```

4. Decide the lane:

- Pod not ready or restarting: inspect image pull, env/config, probes, CPU/memory pressure, and recent deploy.
- Public HTTPS failure: inspect ingress, certificate, Traefik, DNS, and service endpoints.
- Model/tool request failure: inspect `OPENAI_BASE_URL`, gateway health, model selection, tool logs, and recent prompt/tool changes.
- Memory failure: inspect Qdrant/Ollama pods, `/health.components`, and recent cleanup or embedding changes.
- Artifact failure: inspect artifact storage health, generated file paths, preview/download routes, and admin storage summaries.
- User-reported bad output: preserve the session id, prompt, output, model/tool metadata, and source artifacts; route it into the improvement loop rather than editing production data blindly.

5. Record evidence:

- Start time, affected surface, and reported symptom.
- Last deploy/config change.
- Endpoint results.
- Pod/event/log evidence.
- Recovery action or rollback decision.
- Follow-up owner and backlog item.

## Rollback And Recovery

Prefer fixing configuration mistakes directly when the root cause is obvious and small, such as a missing secret key or wrong ConfigMap value. Use rollback when a new image or manifest is the likely regression and the current service is degraded.

Check rollout history:

```bash
kubectl rollout history deployment/backend -n kimibuilt
kubectl describe deployment/backend -n kimibuilt
```

Rollback to the previous ReplicaSet:

```bash
kubectl rollout undo deployment/backend -n kimibuilt
kubectl rollout status deployment/backend -n kimibuilt --timeout=180s
```

Or restore a known image explicitly:

```bash
kubectl set image deployment/backend backend=ghcr.io/philly1084/kimibuilt:<known-good-tag> -n kimibuilt
kubectl rollout status deployment/backend -n kimibuilt --timeout=180s
```

Rancher UI path:

1. Cluster Management -> Explore -> Workloads.
2. Open namespace `kimibuilt`, workload `backend`.
3. Review the current image, recent events, and revision history.
4. Use Rollback only when the target previous revision is known.
5. Re-check `/live`, `/ready`, `/health`, logs, and the original failing user path.

Do not delete PVCs or Postgres/Qdrant volumes during rollback unless losing saved sessions, artifacts, or memory is explicitly approved.

## Common Recovery Paths

### Failed Model Or Tool Requests

- Check `/health` for `llmClient`, `sdk`, gateway, and remote runner components.
- Confirm `OPENAI_BASE_URL`, model config, and gateway service health.
- Check admin logs/traces for repeated tool class failures.
- If a model, prompt, or tool change caused the regression, revert that change or restore the previous model route, then run focused evals/tests.

### Memory Or Embedding Problems

- Check Qdrant and Ollama pods:

```bash
kubectl get pods -n kimibuilt -l app=qdrant -o wide
kubectl get pods -n kimibuilt -l app=ollama -o wide
kubectl logs -l app=qdrant -n kimibuilt --tail=100
kubectl logs -l app=ollama -n kimibuilt --tail=100
```

- If memory cleanup failed after deletion, re-run or manually verify the equivalent session cleanup when Qdrant is healthy.
- Treat vector memory as derived user content; follow `docs/privacy-data-governance.md` for owner-scoped deletion and backup follow-up.

### Artifact And Storage Cleanup

- Use admin storage cleanup in dry-run mode before deleting.
- Confirm whether the artifact is Postgres-backed or local generated-file fallback.
- Delete owner-scoped artifacts through `DELETE /api/artifacts/:id` where possible.
- For stale generated files, record the dry-run counts and deletion counts.
- Do not remove active project evidence, open support artifacts, or legal/business hold material.

### User-Reported Bad Outputs

Capture the minimum evidence needed for improvement:

- Session id, owner/scope when available, timestamp, model, tool path, and affected interface.
- User prompt and assistant output excerpt, trimmed to the relevant issue.
- Source artifacts or retrieved context ids if they influenced the answer.
- Whether the problem is factuality, safety, tone, formatting, routing, missing source evidence, or tool failure.

Then create a follow-up for prompt/tool/model routing or memory correction. Do not describe this as "retraining" unless a future governed fine-tuning process exists.

## Privacy And Data Requests

Use `docs/privacy-data-governance.md` as the source of truth. Minimum steps:

1. Confirm the requester controls the authenticated owner account or use an approved identity verification path.
2. Define the request: access, export, correction, deletion, or sensitive-data incident.
3. Identify affected sessions, notes, artifacts, workloads, managed apps, memory scopes, local generated files, and backups.
4. Use owner-scoped routes when possible.
5. Record the request, actions taken, unavailable dependencies, and backup-retention follow-up.

If secrets or sensitive personal information were pasted into chat, notes, uploads, artifacts, logs, or screenshots, rotate credentials immediately where relevant. Deletion alone is not enough for exposed secrets.

## Secret Handling

- Keep `.env`, kubeconfigs, API keys, passwords, JWT secrets, registry tokens, SSH keys, and webhook secrets out of commits and run logs.
- Store production secrets in Kubernetes Secrets, GitHub/GitLab Actions secrets, external-secrets, Vault, or the deployment's approved secret manager.
- Rotate exposed credentials before or alongside deleting affected content.
- When updating Kubernetes Secrets, restart or roll out affected deployments and verify `/health`.

Example secret update pattern:

```bash
kubectl create secret generic kimibuilt-secrets \
  --from-literal=OPENAI_API_KEY="$OPENAI_API_KEY" \
  -n kimibuilt \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/backend -n kimibuilt
kubectl rollout status deployment/backend -n kimibuilt --timeout=180s
```

## Remote Access

Use remote access only for bounded inspection, recovery, and deploy verification. Start with a baseline:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline
```

For one-off checks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action run -Server primary -Command "kubectl get pods -A -o wide"
```

Keep batches small: baseline, inspect, fix, verify. Prefer GitLab-observable release paths for real deployments, then use tunnels for live checks and recovery evidence.

## Incident Log Template

```text
YYYY-MM-DD HH:mm TZ - Incident/maintenance title
Owner:
Affected surface:
User impact:
Last deploy/config change:
Checks run:
Evidence:
Recovery action:
Verification:
Privacy or secret impact:
Follow-up:
```

## Handoff Checklist

- The operator knows the canonical public host and namespace.
- `/live`, `/ready`, `/health`, admin dashboard, pods, events, logs, rollout, and ingress checks are understood.
- Release and rollback commands are available.
- Secret update paths avoid commits and pasted values.
- Privacy/export/deletion requests follow Canadian-first governance.
- Prompt/model/tool changes have an owner, eval/test gate, and monitoring follow-up.
- Every incident or release-health review leaves a concise evidence entry.

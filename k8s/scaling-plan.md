# KimiBuilt Backend Scaling Plan (k3s)

This document explains how the `backend` scales today, what blocks safe horizontal scaling, and the smallest credible path to a baseline HorizontalPodAutoscaler (HPA).

## OP-001 scaling decision

**Decision:** do not ship or apply a live HPA manifest for `backend` yet. The production baseline for the current single-node k3s cluster is intentional single-replica operation with vertical scaling, readiness/liveness probes, and capacity checks from `k8s/performance-profile-16c32g.md`.

An HPA becomes allowed only after the backend is replica-safe: shared runtime state is removed from the single `backend-state` PVC or converted to per-replica storage, the workload uses rolling-compatible update semantics, metrics-server is verified, and WebSocket/SSE reconnect behavior is accepted by operators. Until then, `spec.replicas: 1` is a safety control, not a missing production setting.

## Current state (as of 2026-05-10)

- **Replica count:** `backend` is deployed as a single replica (`spec.replicas: 1`) in `k8s/backend-deployment.yaml`.
- **Pod strategy:** `Recreate` (safe for single replica; not appropriate for multi-replica).
- **Stateful mount:** the pod mounts `backend-state` via a single PersistentVolumeClaim:
  - `volumeMounts[].mountPath: /home/kimibuilt/.kimibuilt`
  - `volumes[].persistentVolumeClaim.claimName: backend-state`
- **Concurrency budget:** tuned for a 16 core / 32GB ARM64 node in `k8s/performance-profile-16c32g.md`.
- **Health gates:** readiness `/ready` and liveness `/live` probes exist in the deployment manifest.

## Why HPA is deferred right now

Kubernetes can scale the number of pods even on a single node, but **this backend cannot safely run more than one replica today** because:

1. **The mounted `backend-state` PVC is a single claim and is expected to be `ReadWriteOnce` in most storage classes.**
   - Multiple pods mounting the same RWO volume will fail to schedule or will behave unpredictably.
2. **The deployment uses `strategy: Recreate`, which is incompatible with horizontally scaling a deployment.**
3. **Interactive traffic includes long-lived WebSocket/SSE connections.**
   - HPA scale-down will terminate pods and drop connected clients; this is acceptable only if the client reconnect path is reliable and operators understand the behaviour.

Because of (1) and (2), applying an HPA now would encourage unsafe scaling. Instead, we document the enablement path below and keep the single replica as an intentional safety choice.

## What “scaling” means for KimiBuilt

KimiBuilt backend scaling has two layers:

- **Vertical scaling (now):** increase CPU/memory requests/limits for the single backend pod based on measured usage.
- **Horizontal scaling (future, after prerequisites):** run 2+ backend replicas and optionally apply HPA based on CPU/memory (and later custom metrics such as active WebSocket connections or p95 response time).

## Scaling triggers and target metrics (baseline)

These targets are a starting point for a production-ish baseline and must be tuned from real traffic:

- **CPU utilization:** target ~70% average utilization (per pod) for scaling out.
- **Memory:** keep steady-state below ~75% of the pod memory limit; treat OOMKills as a release blocker.
- **Latency:** track p95 for `/api/chat` (and any heavy endpoints like document/PDF work) in logs/metrics before enabling aggressive scale-down.
- **Active WebSocket connections:** track current/peak connections per pod to understand disruption during scale events.

## Current k3s scaling runbook

Use this path while `backend` remains single-replica:

1. Confirm the current request and limit budget in `k8s/performance-profile-16c32g.md`.
2. Check current pressure:
   - `kubectl top pods -n kimibuilt`
   - `kubectl describe pod -l app=backend -n kimibuilt`
   - `kubectl logs -l app=backend -n kimibuilt --tail=100`
3. If CPU is consistently saturated but memory is stable, raise the backend CPU limit in `k8s/backend-deployment.yaml` by a small step that still leaves host headroom.
4. If memory is consistently above 75 percent of the 6Gi limit or OOMKills appear, raise the memory limit by 1-2Gi and adjust `NODE_OPTIONS=--max-old-space-size=...` below the container limit.
5. Apply and verify:
   - `kubectl apply -f k8s/backend-deployment.yaml`
   - `kubectl -n kimibuilt rollout status deployment/backend`
   - `curl -fsS https://kimibuilt.secdevsolutions.help/health`

Do not change `replicas` above `1` as an operational shortcut. That is a horizontal-scaling change and requires the prerequisites below.

## Enablement path (smallest safe sequence)

### 1) Make the backend replica-safe

Pick one approach and document it in `k8s/backend-deployment.yaml` history once chosen:

- **Preferred:** remove the shared PVC dependency by moving backend runtime state to:
  - Postgres (sessions/artifacts), and/or
  - per-request artifact storage, and/or
  - an object store, and/or
  - per-pod ephemeral storage (`emptyDir`) for caches only.
- **Alternative:** convert the backend to a `StatefulSet` with `volumeClaimTemplates` so each replica gets its own PVC (safe if the app is designed for per-replica state).

### 2) Change update strategy

- Switch from `Recreate` to `RollingUpdate` (or use `StatefulSet` rolling semantics), ensuring readiness gates prevent traffic to unready pods.

### 3) Ensure metrics are available

HPA requires metrics:

- Install **metrics-server** in the cluster.
- Verify with:
  - `kubectl top nodes`
  - `kubectl top pods -n kimibuilt`

### 4) Add an HPA baseline (CPU + memory)

Once prerequisites are met, an initial HPA shape is:

- minReplicas: `2`
- maxReplicas: `4` (or based on node capacity)
- cpu averageUtilization: `70`
- memory averageUtilization: `75`

Example (do not apply until prerequisites are satisfied):

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: backend
  namespace: kimibuilt
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: backend
  minReplicas: 2
  maxReplicas: 4
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 75
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
```

## Operator note: WebSocket/SSE disruption during scaling

- Expect **connections to drop** when a pod is terminated during scale down or rolling updates.
- Ensure clients reconnect and resume correctly before enabling scale-down automation.
- Prefer conservative `scaleDown.stabilizationWindowSeconds` and reasonable `terminationGracePeriodSeconds` once multi-replica is enabled.

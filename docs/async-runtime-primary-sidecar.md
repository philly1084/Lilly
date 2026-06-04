# Async Runtime Primary Sidecar

This lane prepares the message-based async runtime on the primary
`lilly.secdevsolutions.help` deployment without replacing the existing chat,
tool, SSH, or model-selection paths.

## Default State

- The backend mounts `/api/async-lab` and `/async-lab`, but queue actions stay
  inactive until the admin dashboard requests the lane.
- `ASYNC_RUNTIME_ENABLED=false` keeps boot in standby.
- `ASYNC_RUNTIME_ADMIN_TOGGLE_ALLOWED=true` lets the admin dashboard activate
  or deactivate the lane after Valkey is present.
- `ASYNC_LAB_ALLOW_LIVE_REMOTE=false` keeps copied SSH/tool/remote events in
  dry-run mode unless a later deployment explicitly changes the environment.

## Primary Valkey Prep

```bash
kubectl apply -f k8s/primary-async-runtime.yaml --dry-run=server
kubectl apply -f k8s/primary-async-runtime.yaml
kubectl -n kimibuilt rollout status deploy/valkey-async-runtime
```

After applying `k8s/configmap.yaml` and restarting the backend, the admin
dashboard can toggle the lane from **Settings -> Orchestration -> Async Valkey
lane**.

## Side-By-Side Check

- Existing web chat stays at `/web-chat/app.html`.
- Parallel async comparison stays at `/async-lab/`.
- `/api/async-lab/status` reports standby, requested, Valkey, and remote mode
  state without requiring the queue endpoints to be active.

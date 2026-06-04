# Async Lab Deployment

This directory is an adjacent runtime lab. It does not change the production
`kimibuilt/backend` Deployment, Service, Ingress, or web-chat routes.
The lab has its own Valkey and Postgres Deployments/PVCs inside
`kimibuilt-async-lab` so live queues, leases, and durable event checkpoints do
not share production runtime state.

## Local Overlay

```bash
docker compose -f docker-compose.yml -f docker-compose.async.yml up -d valkey-async-lab backend-async-lab
```

The lab backend is exposed on `http://localhost:3001/async-lab/` by default.

The GitHub Actions workflow `Async Lab Adjacent Build` validates this path with
focused unit tests, a live Valkey integration test, compose overlay validation,
and a multi-arch `lite` Docker build. Branch pushes publish only the adjacent
`ghcr.io/philly1084/lilly:async-lab` image tag; production image tags and
deployments stay untouched.
Remote adapters stay dry-run unless `ASYNC_LAB_ALLOW_LIVE_REMOTE=true`.

## k3s Lab

Before applying the backend Deployment, create `backend-async-lab-secrets`
in `kimibuilt-async-lab`. Use `secret.example.yaml` as a local template only;
do not commit real values.

```bash
kubectl apply -f k8s/async-lab/async-lab.yaml --dry-run=server
kubectl apply -f k8s/async-lab/secret.example.yaml --dry-run=client
kubectl apply -f k8s/async-lab/async-lab.yaml
kubectl -n kimibuilt-async-lab rollout status deploy/postgres-async-lab
kubectl -n kimibuilt-async-lab rollout status deploy/valkey-async-lab
kubectl -n kimibuilt-async-lab rollout status deploy/backend-async-lab
```

Expected public host:

```text
https://async-lab.demoserver2.buzz/async-lab/
```

Promotion to production is intentionally not part of this manifest.

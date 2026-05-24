# KimiBuilt 16-core / 32GB performance profile

This profile is tuned for a single ARM64 k3s node with 16 CPU cores and 32GB RAM. It is intentionally performance-biased without pinning the whole machine, so k3s, Traefik, cert-manager, the gateway, and short build spikes still have room.

## Runtime budget

| Workload | Request | Limit | Notes |
| --- | ---: | ---: | --- |
| backend | 1 CPU / 2Gi | 4 CPU / 6Gi | Raises Node heap to 4Gi, gives libuv 16 worker threads, and allows modest image/TTS parallelism. |
| ollama | 2 CPU / 3Gi | 6 CPU / 8Gi | Keeps the embedding model warm, allows four parallel embedding requests, and caps loaded models at one. |
| postgres | 1 CPU / 2Gi | 3 CPU / 6Gi | Uses a 1.5Gi shared buffer and 12GB effective cache estimate for the host. |
| qdrant | 1 CPU / 2Gi | 4 CPU / 5Gi | Allows four search workers and two optimizer threads for vector recall without taking the whole node. |
| kokoro-tts | 1 CPU / 1Gi per replica | 4 CPU / 5Gi per replica | Four isolated replicas reserve 4 CPU total for snappy realtime TTS while keeping one Kokoro synthesis lane per process. |
| frontend nginx | 0.1 CPU / 128Mi | 0.5 CPU / 512Mi | Only applies to the Rancher bundle that serves static frontend files through a separate nginx pod. |

Steady-state requests total about 9 CPU and 13Gi RAM with four Kokoro replicas. That still leaves meaningful headroom on a 16-core / 32GB node for OS/k3s overhead, ingress, gateway services, transient jobs, page rendering, and traffic spikes.

## Why these settings

- Node gets more heap and libuv workers because document, artifact, zip, PDF, audio, and frontend bundle workflows can use native worker-pool tasks.
- Ollama is treated as an embedding service first. `OLLAMA_NUM_PARALLEL=4` improves concurrent memory/RAG requests, while `OLLAMA_MAX_LOADED_MODELS=1` prevents model sprawl.
- Postgres receives enough cache-aware tuning to avoid the old tiny 1Gi cap bottleneck without pretending this is a dedicated database host.
- Qdrant gets explicit search and optimizer thread limits so vector search benefits from the larger server but leaves CPU for generation and API work.
- Frontend assets are normally served by the backend. The Rancher stack also has a small nginx frontend pod, so it gets a modest cache/connection headroom bump instead of a large allocation.

## Apply and verify

```bash
kubectl apply -f k8s/
kubectl -n kimibuilt rollout status deployment/postgres
kubectl -n kimibuilt rollout status deployment/qdrant
kubectl -n kimibuilt rollout status deployment/ollama
kubectl -n kimibuilt rollout status deployment/kokoro-tts
kubectl -n kimibuilt rollout status deployment/backend
kubectl top pods -n kimibuilt
curl -fsS https://kimibuilt.secdevsolutions.help/health
```

After a few real chat, memory, document, image, and podcast requests, check `kubectl top pods -n kimibuilt`. If a pod is consistently above 80 percent of its memory limit, raise that one limit by 1-2Gi instead of widening everything.

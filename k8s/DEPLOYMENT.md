# KimiBuilt k3s Deployment Guide

This guide covers deploying KimiBuilt to a k3s cluster with the n8n-openai-cli-gateway as the OpenAI API provider.

## Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                           k3s Cluster                                    â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”             â”‚
â”‚  â”‚   Ingress    â”‚â”€â”€â”€â”€â–¶â”‚   KimiBuilt  â”‚â”€â”€â”€â”€â–¶â”‚    Qdrant    â”‚             â”‚
â”‚  â”‚  (Traefik)   â”‚     â”‚    Backend   â”‚     â”‚  (Vectors)   â”‚             â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜             â”‚
â”‚                              â”‚                                          â”‚
â”‚                              â–¼                                          â”‚
â”‚                       â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”             â”‚
â”‚                       â”‚    Ollama    â”‚     â”‚  n8n-openai  â”‚             â”‚
â”‚                       â”‚ (Embeddings) â”‚     â”‚   gateway    â”‚             â”‚
â”‚                       â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜             â”‚
â”‚                                                   â”‚                     â”‚
â”‚                              â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜                     â”‚
â”‚                              â–¼                                          â”‚
â”‚                       â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”                                  â”‚
â”‚                       â”‚   OpenAI     â”‚                                  â”‚
â”‚                       â”‚    API       â”‚                                  â”‚
â”‚                       â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜                                  â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

## Prerequisites

### 1. n8n-openai-cli-gateway Must Be Running

Ensure your gateway is deployed and accessible in the `n8n-openai-gateway` namespace:

```bash
kubectl get svc -n n8n-openai-gateway

# Should show:
# NAME                       TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)
# n8n-openai-cli-gateway     ClusterIP   10.43.x.x       <none>        80/TCP
```

### 2. k3s Cluster Access

```bash
# Verify cluster access
kubectl cluster-info
kubectl get nodes
```

### 3. Container Image

Build and push the KimiBuilt image to your registry:

```bash
# Build for ARM64 (typical for k3s on Raspberry Pi)
docker buildx build --platform linux/arm64 -t your-registry/kimibuilt:latest --push .

# Or load locally if using local registry
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml
```

## Deployment Steps

### Step 1: Create Namespace

```bash
kubectl apply -f k8s/namespace.yaml
```

### Step 2: Create the API Key Secret

The gateway provides an API key that KimiBuilt will use. Create the secret:

```bash
# Option 1: Direct command (recommended)
kubectl create secret generic kimibuilt-secrets \
  --from-literal=OPENAI_API_KEY='your-gateway-api-key-here' \
  -n kimibuilt

# Option 2: From file
echo -n 'your-gateway-api-key-here' > /tmp/api-key.txt
kubectl create secret generic kimibuilt-secrets \
  --from-file=OPENAI_API_KEY=/tmp/api-key.txt \
  -n kimibuilt
rm /tmp/api-key.txt

# Option 3: If using external secret management (external-secrets, vault, etc.)
# The secret should be created in the kimibuilt namespace with key OPENAI_API_KEY
```

### Step 3: Apply ConfigMap

The ConfigMap is already configured to point to the n8n gateway:

```bash
kubectl apply -f k8s/configmap.yaml
```

Verify the configuration:

```bash
kubectl get configmap kimibuilt-config -n kimibuilt -o yaml
# Should show:
# OPENAI_BASE_URL: http://n8n-openai-cli-gateway.n8n-openai-gateway.svc.cluster.local/v1
```

### Step 4: Deploy Dependencies

```bash
# Deploy Qdrant (vector database)
kubectl apply -f k8s/qdrant-deployment.yaml

# Deploy Ollama (embeddings)
kubectl apply -f k8s/ollama-deployment.yaml

# Wait for dependencies to be ready
kubectl wait --for=condition=ready pod -l app=qdrant -n kimibuilt --timeout=120s
kubectl wait --for=condition=ready pod -l app=ollama -n kimibuilt --timeout=120s
```

### Step 5: Deploy KimiBuilt Backend

```bash
# Update the image in backend-deployment.yaml if needed
# Then apply:
kubectl apply -f k8s/backend-deployment.yaml

# Wait for deployment
kubectl wait --for=condition=ready pod -l app=backend -n kimibuilt --timeout=120s
```

### Step 6: Configure Ingress

```bash
kubectl apply -f k8s/ingress.yaml
```

## Verification

### Check All Resources

```bash
# Pods
kubectl get pods -n kimibuilt

# Services
kubectl get svc -n kimibuilt

# Ingress
kubectl get ingress -n kimibuilt
```

### Test the Health Endpoint

```bash
# Port-forward to test locally
kubectl port-forward svc/backend 3000:3000 -n kimibuilt

# Test health
curl http://localhost:3000/health

# Should return:
# {
#   "status": "healthy",
#   "services": {
#     "qdrant": "connected",
#     "ollama": "connected"
#   }
# }
```

### Test API via Gateway

```bash
# Test chat endpoint through the gateway
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from k3s!"}'
```

## Troubleshooting

### Backend Pod Failing

```bash
# Check logs
kubectl logs -l app=backend -n kimibuilt --tail=50

# Common issues:
# 1. Cannot connect to n8n-openai-cli-gateway
#    - Verify the gateway service exists:
kubectl get svc -n n8n-openai-gateway

# 2. Invalid API key
#    - Recreate the secret:
kubectl delete secret kimibuilt-secrets -n kimibuilt
kubectl create secret generic kimibuilt-secrets \
  --from-literal=OPENAI_API_KEY='correct-key' \
  -n kimibuilt

# 3. DNS resolution issues
#    - Test from within the pod:
kubectl exec -it deploy/backend -n kimibuilt -- sh
wget -qO- http://n8n-openai-cli-gateway.n8n-openai-gateway.svc.cluster.local/health
```

### Qdrant Connection Issues

```bash
# Check Qdrant logs
kubectl logs -l app=qdrant -n kimibuilt

# Verify network connectivity
kubectl exec -it deploy/backend -n kimibuilt -- sh
wget -qO- http://qdrant:6333/healthz
```

### Ollama Connection Issues

```bash
# Check Ollama logs
kubectl logs -l app=ollama -n kimibuilt

# Test embeddings endpoint
kubectl exec -it deploy/ollama -n kimibuilt -- sh
wget -qO- http://localhost:11434/api/tags
```

## Updating the Deployment

### Update API Key

```bash
# Update the secret
kubectl create secret generic kimibuilt-secrets \
  --from-literal=OPENAI_API_KEY='new-api-key' \
  -n kimibuilt \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart deployment to pick up new secret
kubectl rollout restart deployment/backend -n kimibuilt
```

### Update Config

```bash
# Edit ConfigMap
kubectl edit configmap kimibuilt-config -n kimibuilt

# Or apply updated file
kubectl apply -f k8s/configmap.yaml

# Restart to apply changes
kubectl rollout restart deployment/backend -n kimibuilt
```

### Update Image

```bash
# Set new image
kubectl set image deployment/backend \
  backend=your-registry/kimibuilt:v2.0 \
  -n kimibuilt

# Monitor rollout
kubectl rollout status deployment/backend -n kimibuilt
```

## Uninstall

```bash
kubectl delete -f k8s/
```

## Advanced Configuration

### Using External Secrets (Recommended for Production)

If using external-secrets operator:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: kimibuilt-secrets
  namespace: kimibuilt
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  target:
    name: kimibuilt-secrets
    creationPolicy: Owner
  data:
    - secretKey: OPENAI_API_KEY
      remoteRef:
        key: kimibuilt/openai
        property: api-key
```

### Network Policies

Restrict network access:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kimibuilt-network-policy
  namespace: kimibuilt
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
    - Egress
  egress:
    # Allow access to n8n gateway
    - to:
        - namespaceSelector:
            matchLabels:
              name: n8n-openai-gateway
      ports:
        - protocol: TCP
          port: 80
    # Allow access to Qdrant and Ollama within namespace
    - to:
        - podSelector: {}
      ports:
        - protocol: TCP
          port: 6333
        - protocol: TCP
          port: 11434
```

## Monitoring

### Prometheus Metrics

If you have Prometheus installed:

```bash
# Check metrics endpoint
kubectl port-forward svc/backend 3000:3000 -n kimibuilt
curl http://localhost:3000/metrics
```

## Scaling

The backend is intentionally deployed as **a single replica** by default. Before enabling multi-replica or HPA, review:

- `k8s/scaling-plan.md` (OP-001 decision, current vertical scaling runbook, why HPA is deferred today, and the enablement path)
- `k8s/backend-deployment.yaml` (shared `backend-state` PVC + `Recreate` strategy)

Do not apply an HPA manifest or raise `spec.replicas` above `1` until the backend no longer depends on the shared `backend-state` PVC and the update strategy is compatible with multiple live pods. For the current k3s-sized production baseline, scale vertically in small CPU/memory steps, verify with `kubectl top pods -n kimibuilt`, `kubectl describe pod -l app=backend -n kimibuilt`, rollout status, and `/health`, then record the observed pressure that justified the change.

### Logs Aggregation

```bash
# Stream logs
kubectl logs -l app=backend -n kimibuilt -f

# Logs from all components
kubectl logs -n kimibuilt -f --all-containers
```

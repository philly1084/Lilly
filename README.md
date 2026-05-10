# KimiBuilt

Multi-interface AI backend with contextual memory. Four ways to interact with the same AI engine: CLI, Web Chat, Canvas, and Notation Helper.

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your OPENAI_API_KEY

# 3. Start dependencies (Postgres + Qdrant + Ollama)
docker compose up -d postgres qdrant ollama

# 4. Run the backend
npm run dev
```

The server will be available at `http://localhost:3000`. Check health at `/health`.

Artifacts, uploads, generated files, and session persistence require Postgres. PDF rendering uses headless Chromium in the production image.

Docker-backed agent tools:
- `docker-exec` and `code-sandbox` need a reachable Docker daemon.
- If you run the backend on the host with `npm run dev`, start Docker Desktop first.
- If you run the backend with `docker compose up`, the stack now includes a `docker-proxy` service so the backend container can reach Docker through `DOCKER_HOST=tcp://docker-proxy:2375`.
- Public language images work without Docker Hub login. If you hit pull limits or need private images, sign in locally with `docker login`.

## Deploy to k3s

```bash
# Update the secret with your API key
echo -n 'sk-your-key' | base64
# Paste into k8s/secret.yaml

# Deploy
kubectl apply -f k8s/
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (server + Postgres + Qdrant + Ollama) |
| `/api/chat` | POST | Chat with SSE streaming |
| `/api/canvas` | POST | Structured content generation |
| `/api/notation` | POST | Notation helper (expand/explain/validate) |
| `/api/artifacts/upload` | POST | Multipart artifact upload |
| `/api/artifacts/generate` | POST | Business artifact generation |
| `/api/sessions` | CRUD | Session management |
| `/api/sessions/:id/artifacts` | GET | List artifacts for a session |
| `/ws` | WS | WebSocket for all modes |

See [agents.md](agents.md) for full documentation.

## Operationalization Evidence

For project-management handoff and production-readiness traceability, see [docs/operationalization-evidence-summary.md](docs/operationalization-evidence-summary.md) and the itemized run log in [docs/operationalization-hardening-backlog.md](docs/operationalization-hardening-backlog.md).

## License

MIT

# KimiBuilt — AI Agent Platform

## Project Overview

KimiBuilt is a multi-interface AI backend that provides **four distinct ways** to interact with the same underlying AI engine:

| Mode | Description | Endpoint | Transport |
|------|-------------|----------|-----------|
| **CLI** | Terminal-based chat | `POST /api/chat` | HTTP (SSE) |
| **Web Chat** | Browser-based conversational UI | `POST /api/chat` + `/ws` | HTTP (SSE) / WebSocket |
| **Canvas** | Structured content editor (code, docs, diagrams) | `POST /api/canvas` | HTTP / WebSocket |
| **Notation Helper** | Shorthand notation processor (expand/explain/validate) | `POST /api/notation` | HTTP / WebSocket |

### Architecture

```
Clients (CLI / Web Chat / Canvas / Notation)
            │
     ┌──────▼──────┐
     │  Express +   │  REST (SSE) + WebSocket
     │  Backend API │  Port 3000
     └──┬────┬────┬─┘
        │    │    │
   ┌────▼┐ ┌─▼────▼───┐
   │OpenAI│ │  Memory   │
   │ Resp │ │  Service  │
   │ API  │ └──┬─────┬──┘
   └──────┘    │     │
         ┌─────▼┐ ┌──▼─────┐
         │Ollama│ │ Qdrant │
         │embed │ │ Vector │
         └──────┘ └────────┘
```

### Stack

- **Runtime:** Node.js 20 + Express
- **AI Generation:** OpenAI Response API (configurable base URL)
- **Embeddings:** Ollama with `nomic-embed-text:latest` (768-dim vectors)
- **Vector DB:** Qdrant for contextual memory / RAG
- **Deployment:** ARM64 k3s cluster with Traefik ingress

## Research Defaults

- For routine public web research, start with Perplexity-backed `web-search`
- For daily news, article roundups, source-backed briefings, and gathered research data, use Perplexity `pro-search` or expanded `web-search` extraction budgets so source context is not reduced to headlines/snippets
- Keep user intake minimal; unless the user explicitly constrains the source list, the agent should choose candidate sites and domains itself
- Verify selected pages with `web-fetch` first; use `web-scrape` only for explicit extraction requests, JS-rendered pages, or structured field capture

---

## Agent Grep Docs

When an agent needs a small workflow doc instead of the full project instructions, start with `docs/agent-grep/`.

```bash
rg -n "AGENT_DOC|GREP_QUICKSTART|TOOL_USE_RHYTHM|TOOL_LOOKUP|ADDING_TOOLS|DESIGN_RESEARCH|SKILL_AUTHORING|BUILD_VERIFY" docs/agent-grep src/agent-sdk/tool-docs data/skills
```

Use these compact docs to find copyable grep commands, the tool-use rhythm, tool lookup paths, new-tool update checklist, design research steps, skill authoring rules, and build/verify proof loops before loading longer runbooks.

---

## Generated HTML and Document Design Guardrails

When an agent or program creates HTML, PDF-oriented HTML, DOCX, slide decks, dashboards, reports, or other visual artifacts:

- Decide the delivery format first: editable DOCX, fixed-layout PDF, responsive HTML, Markdown source, PPTX, or a sandbox preview. Do not rename HTML as DOCX/PDF; use the document generator/export path for real office formats.
- Current KimiBuilt document generation supports HTML, PDF, PPTX, XLSX, and Markdown. DOCX/Word requests currently normalize to HTML unless a separate external/export path is explicitly provided, so do not promise native DOCX as a finished runtime output.
- Ask for or infer the minimum document context before writing: audience, purpose, format, length, tone, required sections, source material, brand/style constraints, images/data/tables, and delivery deadline. If details are missing, choose conservative professional defaults and state them in the artifact metadata or handoff note.
- Build from structured content. Use headings, sections, tables, callouts, figures, captions, page breaks, and references as explicit blocks instead of one long prose blob.
- Treat readability as a release requirement, not polish. Never ship white or near-white text on white, transparent, or pale backgrounds; never ship dark text on dark backgrounds.
- Define explicit color pairs for each surface: page background, cards, panels, dark bands, image overlays, buttons, links, muted text, tables, callouts, and captions.
- Target WCAG AA contrast: 4.5:1 for normal body text and 3:1 for large or bold display text. If unsure, make the contrast stronger.
- For text over images, use a solid or strongly translucent overlay/panel and set both `color` and `background-color`; do not rely on the image staying dark enough.
- Avoid one-note palettes. Use a small set of named design tokens such as `--text`, `--muted`, `--surface`, `--panel`, `--accent`, `--border`, and verify every token is readable where used.
- Check responsive layout for clipped labels, text spilling out of buttons/cards, overlapping sections, horizontal overflow, and sticky elements covering content.
- For print/PDF output, include print-safe styles with dark text on light backgrounds unless a dark printed panel is explicitly defined. Decide the PDF page geometry before designing the layout, declare it in source HTML with an explicit rule such as `@page { size: 11.33in 14.67in portrait; margin: 0.72in 0.65in 0.68in; }`, and compose sections, tables, figures, and page breaks around that page. The source HTML or agent design-plan geometry is authoritative; fall back to portrait `11.33in x 14.67in` with comfortable border room only when no page geometry is specified. Avoid viewport-only sizing, prevent orphan headings where practical, and ensure table rows, figures, and callouts do not split awkwardly.
- For generated HTML previews, run `node bin/kimibuilt-ui-check.js <url-or-file-url> --out ui-checks/<name>` before delivery when a browser is available. Treat `low-contrast-text`, `horizontal-overflow`, `empty-body-text`, broken images, and page errors as blockers to fix.
- For generated DOCX/PDF/PPTX, render or preview the artifact and do a visual pass before delivery. Confirm title pages, headers/footers, captions, tables, callouts, page breaks, and exported images remain readable after export, not just in source HTML.
- For data-heavy documents, generate chart/diagram assets separately and embed them as files with alt text/captions. Prefer reusable SVG/PNG artifacts from graph/diagram tooling over screenshots when the output must survive DOCX/PDF export.
- Preserve source and output together: keep the editable source, generated artifact, and any render/QA report connected in the session or handoff note so another agent can continue without guessing the pipeline.
- If a user gives a broken example, fix the design tokens and surface-level CSS first, then re-check the artifact instead of only rewriting prose.

---

## Document Agent Workflow

When an agent is asked to create or improve a document:

- Start with a compact document brief: `format`, `audience`, `purpose`, `sections`, `tone`, `length`, `inputs`, `visual assets`, `constraints`, and `acceptance checks`.
- Prefer KimiBuilt document templates and services for PDF/PPTX/XLSX/Markdown outputs when available. Use sandbox HTML for fast preview and iteration, but convert through a real export/render path before calling the document finished. Treat DOCX as external conversion work unless native support is added.
- If using sandbox HTML as the source, make it static-safe: one `index.html` plus local `styles.css`/assets or clearly linked static files, relative paths, no build-only classes left uncompiled, and print CSS for PDF-oriented documents.
- Make document structure machine-readable enough for follow-up agents: stable section IDs, predictable class names, figure/table numbering, and comments only where they explain non-obvious layout or export decisions.
- Verify in the target medium, not only in the editor. HTML needs browser QA; PDF needs page render review; PPTX/XLSX should be opened or rendered when tooling is available.
- Handoff must include what was generated, where the source lives, where the final artifact lives, which checks ran, and any remaining assumptions.

---

## Sandbox HTML Library Defaults

When agents build previewable sandbox projects or generated HTML documents:

- Prefer local sandbox browser library routes under `/api/sandbox-libraries/` before external CDNs when the runtime has the packages installed. Check `/api/sandbox-libraries/catalog.json` for availability.
- Good chart and graph choices: Chart.js (`/api/sandbox-libraries/chartjs/chart.umd.js`), D3 (`/api/sandbox-libraries/d3/d3.min.js`), Mermaid (use the local route only when the catalog reports it available; otherwise use jsDelivr), Cytoscape (`/api/sandbox-libraries/cytoscape/cytoscape.min.js`), Plotly (`/api/sandbox-libraries/plotly/plotly.min.js`), ECharts (`/api/sandbox-libraries/echarts/echarts.min.js`), vis-network (`/api/sandbox-libraries/vis-network/vis-network.min.js`), Force Graph (`/api/sandbox-libraries/force-graph/force-graph.min.js`), and 3D Force Graph (`/api/sandbox-libraries/force-graph-3d/3d-force-graph.min.js`).
- Good 3D/design choices: Three.js (`/api/sandbox-libraries/three/three.module.js` plus `/api/sandbox-libraries/three/addons/` import-map support), GSAP (`/api/sandbox-libraries/gsap/gsap.min.js`), Matter.js (`/api/sandbox-libraries/matter/matter.min.js`), p5.js (`/api/sandbox-libraries/p5/p5.min.js`), and Rough.js (`/api/sandbox-libraries/rough/rough.js`).
- For Three.js, use an import map: `<script type="importmap">{"imports":{"three":"/api/sandbox-libraries/three/three.module.js","three/addons/":"/api/sandbox-libraries/three/addons/"}}</script>`, then import from `"three"` in a module script.
- Keep sandbox previews static-safe and browser-runnable without a build step. If a local route is unavailable in development, fall back to the matching jsDelivr CDN package path.

---

## Build and Test Commands

```bash
# Install dependencies
npm install

# Development (auto-reload)
npm run dev

# Production
npm start

# Tests
npm test                  # Run all tests with coverage
npm run test:watch        # Watch mode

# Docker (ARM64)
npm run docker:build      # Build image for linux/arm64
npm run docker:push       # Build and push

# Docker Compose (local dev with Qdrant + Ollama)
docker compose up -d      # Start all services
docker compose logs -f    # Follow logs
docker compose down       # Stop all services

# k3s Deployment
kubectl apply -f k8s/     # Deploy to cluster
kubectl delete -f k8s/    # Remove from cluster
```

---

## Code Style Guidelines

- **Language:** JavaScript (CommonJS modules)
- **Formatting:** 2-space indentation, single quotes, trailing commas
- **Naming:**
  - Files: `kebab-case.js`
  - Functions/variables: `camelCase`
  - Classes: `PascalCase`
  - Constants: `UPPER_SNAKE_CASE`
- **Error handling:** Always use try/catch in async routes, pass errors to `next(err)`
- **Logging:** Use `console.log/warn/error` with `[Module]` prefix tags
- **No external linter config yet** — add ESLint if you want stricter enforcement

---

## Testing Instructions

### Unit Tests

Tests live in `__tests__/` directories alongside the code they test. Use Jest:

```bash
npm test
```

**What to test:**
- `session-store.js` — CRUD operations, `recordResponse()` updates
- `memory/embedder.js` — Mock Ollama fetch, verify embedding calls
- `memory/vector-store.js` — Mock Qdrant client, verify store/search/delete
- `memory/memory-service.js` — Integration of embed + store + recall
- `routes/*.js` — Use `supertest` to test each route handler
- `middleware/validate.js` — Schema validation edge cases

### Integration Tests

Requires running Qdrant + Ollama (use `docker compose up qdrant ollama`):

```bash
# Set env vars for local services
QDRANT_URL=http://localhost:6333 \
OLLAMA_BASE_URL=http://localhost:11434 \
npm test -- --testPathPattern=integration
```

### Manual Testing

```bash
# Health check
curl http://localhost:3000/health

# Chat (streamed)
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, who are you?"}'

# Canvas (code generation)
curl -X POST http://localhost:3000/api/canvas \
  -H "Content-Type: application/json" \
  -d '{"message": "Write a Python Fibonacci function", "canvasType": "code"}'

# Notation (expand mode)
curl -X POST http://localhost:3000/api/notation \
  -H "Content-Type: application/json" \
  -d '{"notation": "user -> auth -> dashboard", "helperMode": "expand"}'

# WebSocket (use wscat)
npx wscat -c ws://localhost:3000/ws
> {"type":"chat","payload":{"message":"Hello via WebSocket"}}
```

---

## Security Considerations

### API Key Management
- **Never commit `.env` files** — `.gitignore` excludes them
- In k3s, the OpenAI API key lives in a Kubernetes Secret (`k8s/secret.yaml`)
- Rotate keys regularly; the backend reads from env vars on each request

### Network Security
- **Helmet.js** sets security headers (XSS protection, HSTS, etc.)
- **CORS** is enabled — restrict `origin` in production
- Qdrant and Ollama use **ClusterIP** services (not exposed externally)
- Only the backend is exposed via Traefik Ingress

### Input Validation
- All routes validate request bodies via `middleware/validate.js`
- JSON body size is limited to 10MB (`express.json({ limit: '10mb' })`)

### Container Security
- Backend runs as **non-root** user (`kimibuilt:1001`)
- Multi-stage Docker build minimizes attack surface
- Production image contains only runtime dependencies

### Future Considerations
- [ ] Add API key authentication for the backend endpoints
- [ ] Rate limiting per client/session
- [ ] TLS termination at Traefik (cert-manager)
- [ ] Qdrant authentication (API key)
- [ ] Audit logging for all API calls

---

## Remote Server Operating Notes

The common remote operations target for this project is an Ubuntu Linux ARM64 server running k3s.

When agents are using SSH or remote command tools:
- Prefer `remote-cli-agent` for most remote software creation, update, and deployment work where an app, website, service, dashboard, or frontend must be changed and put live. Use `adminMode: true` for these scoped deployment loops so the remote agent can use the configured admin-capable CLI runner lane.
- Prefer `k3s-deploy` for standard deploy operations: repo sync, manifest apply, image update, and rollout checks.
- Prefer `remote-command` for kubectl inspection, logs, service status, network checks, package installs, one-off fixes, and post-deploy verification.
- If `remote-cli-agent` asks for user input or emits `USER_INPUT_REQUIRED`, forward that concise decision to the user and continue the same remote CLI session with the answer. If it repeats the same blocked command or root error twice without a materially changed strategy, stop that loop and report the blocker plus the next distinct recovery path.
- Default public web domain is `demoserver2.buzz` unless Admin deploy settings override it.
- Wildcard DNS is in front of `demoserver2.buzz`; create concrete host routes such as `app.demoserver2.buzz`, not wildcard Ingress rules.
- Use `node bin/kimibuilt-ingress.js` for Traefik/cert-manager/Let's Encrypt Ingress route setup or changes. It defaults to ingress class `traefik`, ClusterIssuer `letsencrypt-prod`, and ACME email `philly1084@gmail.com`, refuses accidental nginx ingress, and records `KIMIBUILT_INGRESS_EVENT` updates in the cluster registry.
- Start with a short baseline command when reconnecting:

```bash
hostname && whoami && uname -m && (test -f /etc/os-release && sed -n '1,6p' /etc/os-release || true) && uptime
```

- Assume `kubectl` should point at k3s. If cluster access is unclear, prefer `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml` or `k3s kubectl`.
- On the host, do not assume `rg`, `docker-compose`, `ifconfig`, or `netstat` exist. Prefer `find` and `grep -R`, `docker compose`, `ip addr`, and `ss -tulpn`.
- For k3s triage, use a get -> describe -> logs -> rollout -> systemd/journal flow:
  - `kubectl get pods -A -o wide`
  - `kubectl describe ...`
  - `kubectl logs ... --previous`
  - `kubectl rollout status ...`
  - `systemctl status k3s` / `journalctl -u k3s --no-pager -n 200`
- For remote website/dashboard builds, run UI/UX self-checks with Playwright/Chromium when a preview or public URL exists. Prefer `node /app/bin/kimibuilt-ui-check.js <url> --out ui-checks` on the runner and use backend `web-scrape` with `browser: true`, `captureScreenshot: true`, and desktop/mobile `viewport` values to persist screenshot artifacts.
- Keep remote command batches small and purposeful: baseline -> inspect -> fix -> verify.
- Avoid interactive commands and editors unless the user explicitly asks for that style of access.
- See `src/agent-sdk/tool-docs/remote-command.md` for the reusable command catalog.
- See `k8s/K3S_RANCHER_PLAYBOOK.md` for the repo-local k3s/Rancher deployment and TLS/DNS playbook.

---

## Frontend Specifications

Below are the specifications for each of the four frontend interaction modes. These share the same backend but present different UX paradigms.

---

### 1. CLI Client

**Purpose:** Terminal-based chat for developers and power users.

**Proposed Tech:** Node.js CLI using `readline` or `commander` + `node-fetch` for SSE streaming.

**Features to build:**
- Interactive REPL with streaming response display
- Session persistence (store session ID locally in `~/.kimibuilt/session`)
- Command support: `/new` (new session), `/mode canvas|notation` (switch modes), `/history`, `/clear`
- Markdown rendering in terminal (via `marked-terminal`)
- Pipe support: `echo "explain this" | kimi`
- Config file for default model, base URL, etc.

**API Usage:**
- `POST /api/chat` with `stream: true` — parse SSE events
- `POST /api/canvas` — display structured JSON
- `POST /api/notation` — display annotated results

---

### 2. Web Chat UI

**Purpose:** Browser-based conversational interface, similar to ChatGPT.

**Proposed Tech:** Vanilla HTML/CSS/JS or lightweight framework (Lit, Preact).

**Features to build:**
- Message thread with user/assistant bubbles
- Real-time streaming via WebSocket (`/ws`)
- Session sidebar (create, switch, delete sessions)
- Markdown rendering with syntax highlighting (Prism.js or Highlight.js)
- Dark/light theme toggle
- Message input with keyboard shortcuts (Shift+Enter for newline, Enter to send)
- Connection status indicator (WS connected/disconnected)
- Mobile responsive layout

**API Usage:**
- WebSocket at `ws://host:3000/ws` — send `{ type: "chat", payload: { message } }`
- `GET /api/sessions` — populate sidebar
- `DELETE /api/sessions/:id` — delete session

---

### 3. Canvas UI

**Purpose:** Side-by-side editor + AI assistant for structured content creation.

**Proposed Tech:** HTML/CSS/JS with a code editor component (CodeMirror or Monaco).

**Features to build:**
- Split-pane layout: prompt panel (left) + canvas/editor (right)
- Canvas type selector: Code / Document / Diagram
- For **Code:** Syntax-highlighted editor with language detection
- For **Document:** Rich markdown preview
- For **Diagram:** Mermaid.js rendering
- AI suggestions panel below the canvas
- "Apply" button to update canvas with AI output
- Notes/canvas agents must support exact text-range edits: highlight selected or named text and replace specific words, phrases, sentences, or small parts of any text-like block without requiring a full block/page rewrite.
- Chat should surface available reasoning summaries, and visible page updates should be staged over a few seconds for section moves/replacements so the user can see the agent working through steps.
- Version history / undo stack for canvas content
- Export: copy to clipboard, download as file

**API Usage:**
- `POST /api/canvas` with `{ message, canvasType, existingContent }`
- Response: `{ content, metadata, suggestions }`

---

### 4. Notation Helper UI

**Purpose:** Shorthand notation → full output with annotations and suggestions.

**Proposed Tech:** HTML/CSS/JS with a dual-pane layout.

**Features to build:**
- Input pane: notation editor with syntax hints
- Output pane: rendered result with inline annotations
- Mode selector: Expand / Explain / Validate
- Annotation sidebar: clickable notes linked to output sections
- Suggestions panel with one-click apply
- Notation templates / examples library
- Optional context input field (extra information for the AI)
- History of notation → result pairs

**API Usage:**
- `POST /api/notation` with `{ notation, helperMode, context }`
- Response: `{ result, annotations[], suggestions[] }`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | *(required)* | OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL (custom endpoint support) |
| `OPENAI_MODEL` | `gpt-4o` | Model for generation |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama service URL |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text:latest` | Embedding model |
| `QDRANT_URL` | `http://qdrant:6333` | Qdrant service URL |
| `QDRANT_COLLECTION` | `conversations` | Vector collection name |
| `DOCKER_HOST` | *(optional)* | Docker daemon endpoint for `docker-exec` / `code-sandbox` when the backend is containerized or using a remote daemon |
| `PORT` | `3000` | Backend server port |
| `NODE_ENV` | `development` | Environment mode |

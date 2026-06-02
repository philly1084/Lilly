const fs = require('fs/promises');
const path = require('path');
const { getRuntimeSupport } = require('./runtime-support');

const TOOL_DOCS_DIR = path.join(__dirname);

function buildHttpsAvailabilityProbeCommand() {
  return [
    'kimibuilt_insecure_tls=false',
    'if strict_tls_output=$(curl -fsSIL --max-time 20 "https://$host" 2>&1); then',
    '  printf "%s\\n" "$strict_tls_output"',
    '  echo "__KIMIBUILT_TLS_TRUSTED__=true"',
    '  echo "__KIMIBUILT_PUBLIC_HTTPS__=true"',
    'else',
    '  strict_tls_status=$?',
    '  echo "__KIMIBUILT_TLS_TRUSTED__=false"',
    '  echo "__KIMIBUILT_STRICT_HTTPS_EXIT__=${strict_tls_status}"',
    '  echo "__KIMIBUILT_STRICT_HTTPS_ERROR__=$(printf "%s" "$strict_tls_output" | tr "\\n" " " | sed "s/[[:space:]][[:space:]]*/ /g" | cut -c1-500)"',
    '  if [ "$strict_tls_status" -ne 60 ]; then exit "$strict_tls_status"; fi',
    '  echo "Strict HTTPS certificate verification failed; retrying with --insecure to verify route and UI reachability only."',
    '  if insecure_tls_output=$(curl -k -fsSIL --max-time 20 "https://$host" 2>&1); then',
    '    printf "%s\\n" "$insecure_tls_output"',
    '    echo "__KIMIBUILT_PUBLIC_HTTPS__=insecure"',
    '    kimibuilt_insecure_tls=true',
    '  else',
    '    insecure_tls_status=$?',
    '    echo "__KIMIBUILT_INSECURE_HTTPS_EXIT__=${insecure_tls_status}"',
    '    echo "__KIMIBUILT_INSECURE_HTTPS_ERROR__=$(printf "%s" "$insecure_tls_output" | tr "\\n" " " | sed "s/[[:space:]][[:space:]]*/ /g" | cut -c1-500)"',
    '    exit "$insecure_tls_status"',
    '  fi',
    'fi',
    'body_file="$(mktemp)"',
    'trap \'rm -f "$body_file"\' EXIT',
    'body_curl_args="-fsSL"',
    'if [ "$kimibuilt_insecure_tls" = "true" ]; then body_curl_args="-k -fsSL"; fi',
    'if body_output=$(curl $body_curl_args --max-time 20 "https://$host" -o "$body_file" 2>&1); then',
    '  body_bytes=$(wc -c < "$body_file" | tr -d " ")',
    '  echo "__KIMIBUILT_UI_BODY_BYTES__=${body_bytes}"',
    '  echo "__KIMIBUILT_UI_BODY_PREVIEW__=$(head -c 300 "$body_file" | tr "\\n" " " | sed "s/[[:space:]][[:space:]]*/ /g")"',
    '  test "${body_bytes:-0}" -gt 0',
    'else',
    '  body_status=$?',
    '  echo "__KIMIBUILT_UI_BODY_ERROR__=$(printf "%s" "$body_output" | tr "\\n" " " | sed "s/[[:space:]][[:space:]]*/ /g" | cut -c1-500)"',
    '  exit "$body_status"',
    'fi',
  ].join('\n');
}

const REMOTE_CLI_COMMAND_CATALOG = Object.freeze([
  {
    id: 'baseline',
    label: 'Remote baseline',
    profile: 'inspect',
    description: 'Confirm host identity, user, CPU architecture, OS, and uptime.',
    command: 'hostname && whoami && uname -m && (test -f /etc/os-release && sed -n "1,6p" /etc/os-release || true) && uptime',
  },
  {
    id: 'repo-inspect',
    label: 'Repository inspect',
    profile: 'inspect',
    description: 'Inspect the current workspace, nearby files, package scripts, and git status.',
    command: 'pwd && find . -maxdepth 2 -type f | sort | head -n 120 && (test -d .git && git status --short --branch || true)',
  },
  {
    id: 'repo-map',
    label: 'Repository map',
    profile: 'inspect',
    description: 'Build a compact project map from manifests, package scripts, Dockerfiles, k8s manifests, and top-level docs without reading the whole repo.',
    command: 'pwd && find . -maxdepth 3 \\( -name package.json -o -name Dockerfile -o -name docker-compose.yml -o -name "*.yaml" -o -name "*.yml" -o -name README.md -o -name AGENTS.md -o -name agents.md \\) -not -path "*/node_modules/*" -not -path "*/.git/*" | sort | head -n 160 && (test -f package.json && node -e "const p=require(\'./package.json\'); console.log(JSON.stringify({name:p.name,scripts:p.scripts,dependencies:Object.keys(p.dependencies||{}).slice(0,40),devDependencies:Object.keys(p.devDependencies||{}).slice(0,40)}, null, 2))" || true)',
  },
  {
    id: 'changed-files',
    label: 'Changed files',
    profile: 'inspect',
    description: 'Show only git changes and names so agents can review the active work without scanning unrelated code.',
    command: 'if [ -d .git ]; then git status --short --branch && git diff --name-status && git diff --stat; else echo "No .git directory in current workspace"; fi',
  },
  {
    id: 'git-prepare',
    label: 'Prepare Git run',
    profile: 'build',
    description: 'Initialize or reuse the remote workspace repository, establish a baseline commit when needed, and check out an agent branch with base/head markers.',
    command: 'remote-workbench generated command; pass action=git-prepare and optional branch',
  },
  {
    id: 'git-snapshot',
    label: 'Snapshot Git diff',
    profile: 'inspect',
    description: 'Emit branch, base/head commit, status, changed files, diff stat, and patch evidence for the current remote workspace.',
    command: 'remote-workbench generated command; pass action=git-snapshot and optional baseCommit',
  },
  {
    id: 'git-commit',
    label: 'Commit Git run',
    profile: 'build',
    description: 'Stage all remote workspace changes and create a local commit with a KimiBuilt-visible commit marker.',
    command: 'remote-workbench generated command; pass action=git-commit and commitMessage',
  },
  {
    id: 'git-revert',
    label: 'Revert Git run',
    profile: 'build',
    description: 'Create a revert commit for a prior AI change so source rollback is visible and reviewable.',
    command: 'remote-workbench generated command; pass action=git-revert and optional revertCommit',
  },
  {
    id: 'file-search',
    label: 'File search',
    profile: 'inspect',
    description: 'Search remote files with portable find/grep patterns; do not assume rg exists.',
    command: 'find . -maxdepth 4 -type f | sort | head -n 200',
  },
  {
    id: 'targeted-grep',
    label: 'Targeted grep',
    profile: 'inspect',
    description: 'Search for a symbol or route using grep on likely source files; set NEEDLE before running.',
    command: 'needle="${NEEDLE:-TODO}"; find . -maxdepth 6 -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" -o -name "*.json" -o -name "*.md" -o -name "*.yaml" -o -name "*.yml" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -print0 | xargs -0 grep -n -- "$needle" | head -n 200',
  },
  {
    id: 'dependency-check',
    label: 'Dependency check',
    profile: 'inspect',
    description: 'Inspect package manager state, lockfiles, outdated packages, and audit summary before update work.',
    command: 'set -e; node --version 2>/dev/null || true; npm --version 2>/dev/null || true; find . -maxdepth 2 \\( -name package.json -o -name package-lock.json -o -name pnpm-lock.yaml -o -name yarn.lock \\) -not -path "*/node_modules/*" | sort; if [ -f package.json ]; then npm outdated --depth=0 || true; npm audit --omit=dev || true; fi',
  },
  {
    id: 'k8s-manifest-summary',
    label: 'K8s manifest summary',
    profile: 'inspect',
    description: 'Summarize Kubernetes manifest kinds, names, images, hosts, and namespaces from repo files.',
    command: 'manifest_dir="${MANIFEST_DIR:-k8s}"; if [ -d "$manifest_dir" ]; then find "$manifest_dir" -maxdepth 2 -type f \\( -name "*.yaml" -o -name "*.yml" \\) | sort | while read -r f; do echo "### $f"; grep -nE "^(kind:|  name:|  namespace:|        image:|      - host:|  host:|  ingressClassName:|    cert-manager.io/cluster-issuer:)" "$f" || true; done; else echo "No manifest directory at $manifest_dir"; fi',
  },
  {
    id: 'build',
    label: 'Build project',
    profile: 'build',
    description: 'Run the project build command discovered from the repository.',
    command: 'if [ -f package.json ]; then npm install && npm run build; else echo "No package.json build target found"; fi',
  },
  {
    id: 'test',
    label: 'Run tests',
    profile: 'build',
    description: 'Run the focused or project test command discovered from the repository.',
    command: 'if [ -f package.json ]; then npm test; else echo "No package.json test target found"; fi',
  },
  {
    id: 'focused-test',
    label: 'Focused tests',
    profile: 'build',
    description: 'Run a focused Jest test path or pattern; set TEST_PATH to avoid running the full suite while iterating.',
    command: 'if [ -f package.json ]; then test_path="${TEST_PATH:-}"; if [ -n "$test_path" ]; then npx jest --runInBand "$test_path"; else npm test -- --runInBand; fi; else echo "No package.json test target found"; fi',
  },
  {
    id: 'buildkit',
    label: 'BuildKit checks',
    profile: 'inspect',
    description: 'Check buildctl and the configured BuildKit endpoint before remote image build work.',
    command: 'command -v buildctl || true; test -n "$BUILDKIT_HOST" && buildctl --addr "$BUILDKIT_HOST" debug workers || true',
  },
  {
    id: 'direct-image-build',
    label: 'Direct image build',
    profile: 'build',
    description: 'Build and push an image from the remote workspace through the direct BuildKit runner.',
    command: 'image="${DIRECT_CLI_IMAGE_PREFIX:-ghcr.io/philly1084}/app:$(date +%Y%m%d%H%M%S)"; buildctl --addr "$BUILDKIT_HOST" build --frontend dockerfile.v0 --local context=. --local dockerfile=. --output type=image,name="$image",push=true && printf "IMAGE=%s\\n" "$image"',
  },
  {
    id: 'kubectl-inspect',
    label: 'Kubernetes inspect',
    profile: 'inspect',
    description: 'Inspect k3s nodes, workloads, services, ingress, and pods.',
    command: 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl get nodes -o wide && kubectl get pods -A -o wide',
  },
  {
    id: 'k8s-app-inventory',
    label: 'K8s app inventory',
    profile: 'inspect',
    description: 'List namespaced deployments, services, ingresses, images, and recent events for a target namespace.',
    command: 'set -e; ns="${NAMESPACE:-kimibuilt}"; export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl get deploy,sts,svc,ingress,certificate -n "$ns" -o wide || true; kubectl get deploy -n "$ns" -o jsonpath="{range .items[*]}{.metadata.name}{\"\\t\"}{range .spec.template.spec.containers[*]}{.name}{\"=\"}{.image}{\" \"}{end}{\"\\n\"}{end}" || true; kubectl get events -n "$ns" --sort-by=.lastTimestamp | tail -n 60 || true',
  },
  {
    id: 'logs',
    label: 'Deployment logs',
    profile: 'inspect',
    description: 'Read Kubernetes logs for the target workload.',
    command: 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl logs deployment/backend -n kimibuilt --all-containers=true --tail=200',
  },
  {
    id: 'pod-debug',
    label: 'Pod debug',
    profile: 'inspect',
    description: 'Describe pods and fetch current plus previous logs for a deployment in the target namespace.',
    command: 'set -e; ns="${NAMESPACE:-kimibuilt}"; app="${DEPLOYMENT:-backend}"; export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl describe deployment/"$app" -n "$ns"; kubectl get pods -n "$ns" -l app="$app" -o wide || true; kubectl logs deployment/"$app" -n "$ns" --all-containers=true --tail=200 || true; kubectl logs deployment/"$app" -n "$ns" --all-containers=true --previous --tail=200 || true',
  },
  {
    id: 'rollout',
    label: 'Rollout status',
    profile: 'deploy',
    description: 'Check rollout and availability conditions for a deployment.',
    command: 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl rollout status deployment/backend -n kimibuilt --timeout=180s',
  },
  {
    id: 'https-verify',
    label: 'HTTPS verify',
    profile: 'inspect',
    description: 'Verify DNS and public HTTPS for the deployed domain.',
    command: `host=demoserver2.buzz; getent ahosts "$host" || true; ${buildHttpsAvailabilityProbeCommand()}`,
  },
  {
    id: 'deploy-verify',
    label: 'Deploy verify',
    profile: 'deploy',
    description: 'Verify rollout, service, ingress, TLS certificate objects, DNS, and public HTTPS for a deployed app.',
    command: `set -e; ns="\${NAMESPACE:-kimibuilt}"; app="\${DEPLOYMENT:-backend}"; host="\${PUBLIC_HOST:-demoserver2.buzz}"; export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl rollout status deployment/"$app" -n "$ns" --timeout=180s; kubectl wait --for=condition=available deployment/"$app" -n "$ns" --timeout=180s; kubectl get deploy,svc,ingress,certificate -n "$ns" -o wide || true; getent ahosts "$host" || true; ${buildHttpsAvailabilityProbeCommand()}`,
  },
  {
    id: 'ui-visual-check',
    label: 'UI visual check',
    profile: 'inspect',
    description: 'Run the Playwright/Chromium UI self-check helper against PUBLIC_URL or PUBLIC_HOST and capture desktop/mobile screenshots plus a JSON report.',
    command: 'set -e; url="${PUBLIC_URL:-}"; if [ -z "$url" ] && [ -n "${PUBLIC_HOST:-}" ]; then url="https://$PUBLIC_HOST"; fi; if [ -z "$url" ]; then echo "PUBLIC_URL or PUBLIC_HOST is required" >&2; exit 2; fi; if [ ! -f /app/bin/kimibuilt-ui-check.js ]; then echo "kimibuilt-ui-check helper is not installed in this runner image" >&2; exit 2; fi; node /app/bin/kimibuilt-ui-check.js "$url" --out "${UI_CHECK_DIR:-ui-checks}"',
  },
  {
    id: 'ingress-plan',
    label: 'Ingress plan',
    profile: 'inspect',
    description: 'Validate a guarded Traefik/cert-manager route plan with kimibuilt-ingress. Requires NAMESPACE, INGRESS_NAME, SERVICE_NAME, SERVICE_PORT, and PUBLIC_HOST or SUBDOMAIN.',
    command: 'set -e; ns="${NAMESPACE:?NAMESPACE required}"; ingress="${INGRESS_NAME:?INGRESS_NAME required}"; service="${SERVICE_NAME:?SERVICE_NAME required}"; port="${SERVICE_PORT:?SERVICE_PORT required}"; set -- --namespace "$ns" --ingress "$ingress"; if [ -n "${PUBLIC_HOST:-}" ]; then set -- "$@" --host "$PUBLIC_HOST"; elif [ -n "${SUBDOMAIN:-}" ]; then set -- "$@" --subdomain "$SUBDOMAIN"; else echo "PUBLIC_HOST or SUBDOMAIN required" >&2; exit 2; fi; set -- "$@" --service "$service" --service-port "$port"; node bin/kimibuilt-ingress.js plan "$@"',
  },
  {
    id: 'ingress-apply',
    label: 'Ingress apply',
    profile: 'deploy',
    description: 'Safely upsert one Traefik/cert-manager Ingress host/path route and emit a KIMIBUILT_INGRESS_EVENT registry marker.',
    command: 'set -e; export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; ns="${NAMESPACE:?NAMESPACE required}"; ingress="${INGRESS_NAME:?INGRESS_NAME required}"; service="${SERVICE_NAME:?SERVICE_NAME required}"; port="${SERVICE_PORT:?SERVICE_PORT required}"; set -- --namespace "$ns" --ingress "$ingress"; if [ -n "${PUBLIC_HOST:-}" ]; then set -- "$@" --host "$PUBLIC_HOST"; elif [ -n "${SUBDOMAIN:-}" ]; then set -- "$@" --subdomain "$SUBDOMAIN"; else echo "PUBLIC_HOST or SUBDOMAIN required" >&2; exit 2; fi; set -- "$@" --service "$service" --service-port "$port"; if [ -n "${EXPECT_CURRENT_SERVICE:-}" ]; then set -- "$@" --expect-current-service "$EXPECT_CURRENT_SERVICE"; fi; if [ -n "${EXPECT_CURRENT_SERVICE_PORT:-}" ]; then set -- "$@" --expect-current-service-port "$EXPECT_CURRENT_SERVICE_PORT"; fi; node bin/kimibuilt-ingress.js apply "$@"',
  },
  {
    id: 'ingress-verify',
    label: 'Ingress verify',
    profile: 'deploy',
    description: 'Verify a kimibuilt-ingress route, TLS secret/certificate, and public HTTPS.',
    command: 'set -e; export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; ns="${NAMESPACE:?NAMESPACE required}"; ingress="${INGRESS_NAME:?INGRESS_NAME required}"; service="${SERVICE_NAME:?SERVICE_NAME required}"; port="${SERVICE_PORT:?SERVICE_PORT required}"; set -- --namespace "$ns" --ingress "$ingress"; if [ -n "${PUBLIC_HOST:-}" ]; then set -- "$@" --host "$PUBLIC_HOST"; elif [ -n "${SUBDOMAIN:-}" ]; then set -- "$@" --subdomain "$SUBDOMAIN"; else echo "PUBLIC_HOST or SUBDOMAIN required" >&2; exit 2; fi; set -- "$@" --service "$service" --service-port "$port"; node bin/kimibuilt-ingress.js verify "$@"',
  },
]);

const TOOL_SUPPORT = {
  'web-fetch': { status: 'stable', notes: ['Static HTTP/HTTPS fetch with retries and caching.'] },
  'web-search': { status: 'stable', notes: ['Perplexity-backed raw Search, Sonar grounded answers/media, and Agent preset research modes are implemented.', 'Requires PERPLEXITY_API_KEY in the backend environment.'] },
  'web-scrape': { status: 'stable', notes: ['Supports static fetch and backend Chromium rendering for dynamic pages.', 'Can persist Playwright screenshot artifacts with desktop/mobile viewport overrides.'] },
  'news-scraper': { status: 'stable', notes: ['Uses Perplexity pro-search for article discovery, then fetches source pages and extracts readable article text, byline, date, lead image, and source metadata.', 'Returns a static news-site HTML payload plus JSON injection data for news and weather widgets; public site output defaults to excerpts unless content rights allow full-text republication.'] },
  'security-scan': { status: 'stable', notes: ['Pattern-based source scanning for secrets and common issues.'] },
  'schema-generate': { status: 'stable', notes: ['Generates DDL, ORM schemas, and ER diagrams from entity specs.'] },
  'migration-create': { status: 'stable', notes: ['Builds SQL and framework migration output from schema diffs.'] },
  'architecture-design': { status: 'stable', notes: ['Design/planning output generator.'] },
  'uml-generate': { status: 'stable', notes: ['Mermaid/PlantUML output generator.'] },
  'api-design': { status: 'stable', notes: ['API contract/design output generator.'] },
  'graph-diagram': { status: 'stable', notes: ['Batch graph/diagram utility with native graph JSON, Mermaid, DOT, SVG, HTML, and persisted SVG image artifacts.', 'When GPT-5.5 or newer is the caller model, prefer direct SVG output for custom document visuals.'] },
  'design-resource-search': { status: 'stable', notes: ['Curated safe design-resource index for backgrounds, fonts, CSS styling, icons, and website/document creation assets.', 'Returns web-fetch-ready fetch plans and approved source domains.'] },
  'image-generate': {
    status: 'stable',
    notes: [
      'Uses the current gateway-first OpenAI-compatible image generation path and falls back to the official OpenAI media provider when configured.',
      'Persists generated outputs as reusable image artifacts for chat, website, HTML, document, and presentation builders.',
      'Image builds can take longer than text/tool calls; callers should wait for completion and verify usableCount/artifacts/markdownImages before embedding results.',
    ],
  },
  'ssh-execute': { status: 'requires_setup', notes: ['Requires SSH target credentials or cluster secret configuration.'] },
  'remote-tools': { status: 'stable', notes: ['Compact lane picker for remote-cli-agent, remote-command, remote-workbench, k3s-deploy, the default /api/codex-agent run/events contract, and the MCP remote_code_run/status compatibility contract.'] },
  'remote-command': { status: 'requires_setup', notes: ['Requires SSH target credentials or cluster secret configuration.', 'Optimized for Ubuntu/Linux host and k3s cluster operations in this project.', 'Includes a Playwright/Chromium UI visual-check catalog entry when the runner image exposes the helper.', 'Runner profile admin is available only for explicitly approved privileged operations.'] },
  'remote-workbench': { status: 'requires_setup', notes: ['Structured remote runner actions for repo inspection, guarded file reads/writes, patch application, build/test, logs, rollout, deployment verification, and UI visual checks.', 'Uses inspect/build/deploy runner profiles instead of sending every operation through the deploy lane.'] },
  'remote-cli-agent': {
    status: 'requires_setup',
    notes: [
      'Server-side remote coding agent integration using the default gateway /api/codex-agent/run plus /events SSE contract, with MCP remote_code_run/status retained as compatibility fallback.',
      'Default setup uses REMOTE_CLI_AGENT_TRANSPORT=codex-agent plus REMOTE_CLI_CODEX_AGENT_BASE_URL or GATEWAY_URL, REMOTE_CLI_CODEX_AGENT_MODEL, and a trusted bearer key; the legacy MCP lane uses REMOTE_CLI_MCP_URL plus REMOTE_CLI_MCP_BEARER_TOKEN or N8N_API_KEY.',
      'Prefer for remote software author/build/deploy/verify loops; pass adminMode:true for scoped real deployment changes on the configured admin-capable runner lane.',
      'Git visibility is required for remote deployments: inspect git status/remotes first, create or reuse a git-backed workspace, commit before deploy, report GIT_BRANCH, GIT_BASE_COMMIT, GIT_COMMIT, and CHANGED_FILES, and use git revert plus redeploy for rollback.',
      'Completion proof should include WHAT_CHANGED, VERIFY_COMMANDS, VERIFY_RESULTS, PUBLIC_URL, BLOCKER, deployment/public-host markers, and Playwright/Chromium UI screenshot checks for website or dashboard work.',
    ],
  },
  'k3s-deploy': { status: 'requires_setup', notes: ['Requires SSH target credentials and kubectl/git on the remote host.'] },
  'docker-exec': { status: 'requires_setup', notes: ['Requires explicit Docker CLI/socket access in the backend runtime; not part of the default remote host lane.'] },
  'code-sandbox': { status: 'requires_setup', notes: ['Execute mode requires Docker image pull/run capability in the backend runtime.', 'Project mode can persist previewable frontend bundles without Docker.', 'Sandbox HTML previews can load installed browser libraries from /api/sandbox-libraries; the catalog documents local availability plus CDN fallbacks for Three.js, Chart.js, D3, Mermaid, Cytoscape, Plotly, ECharts, vis-network, GSAP, Matter.js, p5.js, Rough.js, Force Graph, 3D Force Graph, CodeMirror, highlight.js, Marked, PDF.js, Mammoth, and docx.js.'] },
  'git-safe': { status: 'requires_setup', notes: ['Requires a git repository in the backend-accessible filesystem and working git credentials for push.'] },
  'tool-doc-read': { status: 'stable', notes: ['Reads detailed tool documentation from the backend docs directory on demand.'] },
  'self-reflection-update': {
    status: 'stable',
    notes: [
      'Applies bounded durable updates to Hermes-style soul/user files, carryover notes, registered skills, and model-card audit notes.',
      'Accepts at most four actions per call and rejects recursive calls, secrets, credential-bearing content, and prompt-injection text.',
      'Use dryRun:true or apply:false to validate proposed soul/user, notes, or skill edits before writing durable guidance.',
    ],
  },
  'document-workflow': {
    status: 'stable',
    notes: [
      'Recommends, plans, generates, assembles, and bundles document outputs.',
      'Supports training/manual packages through the training-manual blueprint and PDF/HTML/XLSX/Markdown suite generation.',
      'Applies built-in strategy, background design, evidence, accessibility, and final polish quality passes for AI-backed generation.',
    ],
  },
  'research-bucket-list': { status: 'stable', notes: ['Lists metadata from the shared durable research bucket without loading full file contents.'] },
  'research-bucket-search': { status: 'stable', notes: ['Searches bucket metadata and supported text files with grep-style matching.'] },
  'research-bucket-read': { status: 'stable', notes: ['Reads selected bucket files with byte limits; binary files require explicit base64 mode.'] },
  'research-bucket-write': { status: 'stable', notes: ['Creates or updates guarded files inside the shared research bucket and indexes supported assets.'] },
  'research-bucket-mkdir': { status: 'stable', notes: ['Creates guarded subfolders inside the shared research bucket.'] },
  'public-source-list': { status: 'stable', notes: ['Lists indexed public APIs, dashboards, news feeds, data portals, RSS feeds, downloads, and public web sources.'] },
  'public-source-search': { status: 'stable', notes: ['Searches the durable public source catalog by topic, domain, format, source kind, and notes.'] },
  'public-source-get': { status: 'stable', notes: ['Reads one public source catalog entry with endpoint, auth, freshness, and verification metadata.'] },
  'public-source-add': { status: 'stable', notes: ['Creates or updates public source catalog entries for later agent use.'] },
  'public-source-refresh': { status: 'stable', notes: ['Performs a lightweight URL verification and updates status, HTTP, content type, and inferred format metadata.'] },
  'podcast': {
    status: 'stable',
    notes: [
      'Runs researched two-host podcast generation with local Kokoro/Piper TTS synthesis and WAV stitching.',
      'Supports optional ffmpeg-backed MP3 export plus intro/outro/music-bed mixing when audio processing is configured.',
      'Supports host voice pools (`hostAVoiceIds`, `hostBVoiceIds`) with automatic cycling through each host’s configured voices.',
      'Requires an active chat session plus working OpenAI, local TTS, and web research configuration.',
    ],
  },
};

function getToolDocPath(toolId) {
  const normalizedToolId = String(toolId || '').trim();
  if (normalizedToolId.startsWith('research-bucket-')) {
    return path.join(TOOL_DOCS_DIR, 'research-bucket.md');
  }
  if (normalizedToolId.startsWith('public-source-')) {
    return path.join(TOOL_DOCS_DIR, 'public-source-index.md');
  }
  return path.join(TOOL_DOCS_DIR, `${normalizedToolId}.md`);
}

async function hasToolDoc(toolId) {
  try {
    await fs.access(getToolDocPath(toolId));
    return true;
  } catch {
    return false;
  }
}

async function readToolDoc(toolId) {
  const docPath = getToolDocPath(toolId);
  const content = await fs.readFile(docPath, 'utf8');
  return {
    toolId,
    path: docPath,
    content,
  };
}

async function getToolDocMetadata(toolId) {
  const staticSupport = TOOL_SUPPORT[toolId] || { status: 'unknown', notes: [] };
  const runtimeSupport = await getRuntimeSupport(toolId);
  const staticNotes = Array.isArray(staticSupport.notes) ? staticSupport.notes : [];
  const runtimeNotes = Array.isArray(runtimeSupport?.notes) ? runtimeSupport.notes : [];
  const setupOnlyStaticNotes = runtimeSupport?.status
    && runtimeSupport.status !== 'requires_setup'
    && staticSupport.status === 'requires_setup';
  const notes = setupOnlyStaticNotes
    ? [...new Set([
        ...staticNotes.filter((note) => !/^\s*(requires|needs|default setup uses)\b/i.test(String(note || ''))),
        ...runtimeNotes,
      ])]
    : [...new Set([...staticNotes, ...runtimeNotes])];
  const support = runtimeSupport
    ? {
        status: runtimeSupport.status,
        notes,
        runtime: runtimeSupport.runtime || null,
      }
    : staticSupport;
  const docAvailable = await hasToolDoc(toolId);
  return {
    toolId,
    docAvailable,
    support,
  };
}

module.exports = {
  REMOTE_CLI_COMMAND_CATALOG,
  TOOL_SUPPORT,
  getToolDocPath,
  hasToolDoc,
  readToolDoc,
  getToolDocMetadata,
};

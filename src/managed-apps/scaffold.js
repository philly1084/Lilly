'use strict';

function normalizeText(value = '') {
    return String(value || '').trim();
}

function escapeHtml(value = '') {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const DEFAULT_SOURCE_FILE_PATHS = Object.freeze([
    'public/index.html',
    'public/styles.css',
    'public/app.js',
]);

function buildGitLabCiYaml({
    appName = '',
    slug = '',
    gitProviderOrg = '',
    imageRepo = '',
    registryHost = '',
    buildEventsUrl = '',
} = {}) {
    return `stages:
  - build

variables:
  APP_NAME: ${appName}
  APP_SLUG: ${slug}
  GIT_PROVIDER_ORG: ${gitProviderOrg}
  IMAGE_REPO: ${imageRepo}
  REGISTRY_HOST: ${registryHost}
  BUILD_EVENTS_URL: ${buildEventsUrl}
  DEFAULT_TARGET_PLATFORMS: linux/arm64

build-and-publish:
  stage: build
  image: alpine:3.20
  tags:
    - kimibuilt
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
  before_script:
    - apk add --no-cache bash curl wget tar git ca-certificates coreutils jq
  script:
    - |
      bash <<'BASH'
      set -euo pipefail

      build_status="failed"
      IMAGE_DIGEST=""
      notify_kimibuilt() {
        local exit_code="$1"
        if [ "$exit_code" = "0" ]; then
          build_status="success"
        else
          build_status="failed"
        fi

        target_url="\${KIMIBUILT_BUILD_EVENTS_URL:-$BUILD_EVENTS_URL}"
        if [ -z "\${target_url:-}" ]; then
          echo "No KimiBuilt build events URL configured; cannot notify the managed app control plane." >&2
          return "$exit_code"
        fi
        case "$target_url" in
          https://*) ;;
          *)
            echo "KimiBuilt build events URL must use HTTPS." >&2
            if [ "$exit_code" = "0" ]; then
              return 1
            fi
            return "$exit_code"
            ;;
        esac

        payload_file="$(mktemp)"
        cat > "$payload_file" <<EOF
      {"repoOwner":"$GIT_PROVIDER_ORG","repoName":"$APP_SLUG","slug":"$APP_SLUG","commitSha":"\${CI_COMMIT_SHA:-}","imageTag":"\${IMAGE_TAG:-}","imageDigest":"\${IMAGE_DIGEST:-}","imageRepo":"$IMAGE_REPO","buildStatus":"$build_status","requestedAction":"deploy","deployRequested":true,"runId":"\${CI_PIPELINE_ID:-}","runUrl":"\${CI_PIPELINE_URL:-}","platforms":"\${TARGET_PLATFORMS:-}"}
      EOF

        header_secret="\${KIMIBUILT_BUILD_EVENTS_SECRET:-}"
        curl_flags=(-sS -X POST -H "Content-Type: application/json" --data-binary "@$payload_file")
        if [ -n "\${header_secret:-}" ]; then
          curl_flags+=(-H "X-KimiBuilt-Webhook-Secret: $header_secret")
        fi
        if [ "\${KIMIBUILT_BUILD_EVENTS_INSECURE:-0}" = "1" ] || [ "\${KIMIBUILT_BUILD_EVENTS_INSECURE:-0}" = "true" ]; then
          curl_flags+=(-k)
        fi

        response_file="$(mktemp)"
        http_status=""
        if http_status="$(curl "\${curl_flags[@]}" --output "$response_file" --write-out '%{http_code}' "$target_url")"; then
          if printf '%s' "$http_status" | grep -Eq '^2[0-9]{2}$'; then
            return "$exit_code"
          fi
          echo "KimiBuilt notification returned HTTP $http_status; expected a direct 2xx response and redirects are not accepted." >&2
        else
          echo "KimiBuilt notification via curl failed." >&2
        fi

        if [ "$exit_code" = "0" ]; then
          return 1
        fi
        return "$exit_code"
      }
      trap 'rc=$?; notify_kimibuilt "$rc"; exit $?' EXIT

      test -f Dockerfile
      SHORT_SHA="$(printf '%s' "\${CI_COMMIT_SHA:-}" | cut -c1-12)"
      IMAGE_TAG="sha-$SHORT_SHA"
      TARGET_PLATFORMS="\${TARGET_PLATFORMS:-$DEFAULT_TARGET_PLATFORMS}"
      if [ -z "\${IMAGE_REPO:-}" ] && [ -n "\${CI_REGISTRY_IMAGE:-}" ]; then
        IMAGE_REPO="$CI_REGISTRY_IMAGE"
      fi

      download() {
        url="$1"
        if command -v curl >/dev/null 2>&1; then
          curl -fsSL "$url"
          return
        fi
        if command -v wget >/dev/null 2>&1; then
          wget -qO- "$url"
          return
        fi
        echo "curl or wget is required on the runner image" >&2
        exit 1
      }

      ARCH="$(uname -m)"
      case "$ARCH" in
        x86_64|amd64) BUILDKIT_ARCH=amd64 ;;
        aarch64|arm64) BUILDKIT_ARCH=arm64 ;;
        *)
          echo "Unsupported architecture: $ARCH" >&2
          exit 1
          ;;
      esac
      BUILDKIT_VERSION="\${BUILDKIT_VERSION:-v0.17.2}"
      install_dir="$(mktemp -d)"
      download "https://github.com/moby/buildkit/releases/download/$BUILDKIT_VERSION/buildkit-$BUILDKIT_VERSION.linux-$BUILDKIT_ARCH.tar.gz" \\
        | tar -xz --strip-components=1 -C "$install_dir" bin/buildctl
      chmod +x "$install_dir/buildctl"
      export PATH="$install_dir:$PATH"

      registry_user="\${GITLAB_REGISTRY_USERNAME:-\${CI_REGISTRY_USER:-}}"
      registry_password="\${GITLAB_REGISTRY_PASSWORD:-\${CI_REGISTRY_PASSWORD:-}}"
      target_registry_host="\${GITLAB_REGISTRY_HOST:-\${CI_REGISTRY:-$REGISTRY_HOST}}"
      test -n "$registry_user"
      test -n "$registry_password"
      test -n "$target_registry_host"
      mkdir -p "$HOME/.docker"
      AUTH="$(printf '%s' "$registry_user:$registry_password" | base64 | tr -d '\\n')"
      cat > "$HOME/.docker/config.json" <<EOF
      {"auths":{"$target_registry_host":{"username":"$registry_user","password":"$registry_password","auth":"$AUTH"}}}
      EOF

      test -n "$IMAGE_REPO"
      test -n "$TARGET_PLATFORMS"
      case "$IMAGE_REPO" in
        */*/*) ;;
        *)
          echo "IMAGE_REPO must look like <registry>/<owner>/<repo>; got $IMAGE_REPO" >&2
          exit 1
          ;;
      esac
      case "/$IMAGE_REPO/" in
        *"/undefined/"*)
          echo "Invalid IMAGE_REPO=$IMAGE_REPO" >&2
          exit 1
          ;;
      esac

      BUILDKIT_ADDR="\${BUILDKIT_HOST:-tcp://buildkitd.agent-platform.svc.cluster.local:1234}"
      build_metadata_file="$(mktemp)"
      buildctl --addr "$BUILDKIT_ADDR" build \\
        --frontend dockerfile.v0 \\
        --local context=. \\
        --local dockerfile=. \\
        --opt platform="$TARGET_PLATFORMS" \\
        --output "type=image,name=$IMAGE_REPO:$IMAGE_TAG,push=true" \\
        --export-cache type=inline \\
        --import-cache "type=registry,ref=$IMAGE_REPO:latest" \\
        --metadata-file "$build_metadata_file"
      IMAGE_DIGEST="$(jq -er '."containerimage.digest" | select(type == "string")' "$build_metadata_file")"
      if ! printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
        echo "BuildKit did not report a canonical pushed OCI image digest." >&2
        exit 1
      fi
      BASH
`;
}

function buildDockerfile() {
    return `FROM nginx:1.27-alpine

COPY public/ /usr/share/nginx/html/

EXPOSE 80
`;
}

function buildKubernetesReference({
    slug = '',
    namespace = '',
    publicHost = '',
    imageRepo = '',
    imageTag = 'latest',
} = {}) {
    return `# Reference manifest only.
# KimiBuilt deploys this managed app through the managed-app control plane over SSH/kubectl.
# Do not treat this file as the deployment source of truth.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${slug}
  namespace: ${namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${slug}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${slug}
    spec:
      containers:
        - name: app
          image: ${imageRepo}:${imageTag}
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: ${slug}
  namespace: ${namespace}
spec:
  selector:
    app.kubernetes.io/name: ${slug}
  ports:
    - name: http
      port: 80
      targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${slug}
  namespace: ${namespace}
spec:
  rules:
    - host: ${publicHost}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${slug}
                port:
                  number: 80
`;
}

function buildDefaultScaffoldFiles({
    appName = '',
    slug = '',
    publicHost = '',
    namespace = '',
    sourcePrompt = '',
    giteaOrg = '',
    gitProviderOrg = '',
    imageRepo = '',
    registryHost = '',
    buildEventsUrl = '',
} = {}) {
    return [
        ...buildManagedAppInfrastructureFiles({
            appName,
            slug,
            publicHost,
            namespace,
            sourcePrompt,
            gitProviderOrg: gitProviderOrg || giteaOrg,
            imageRepo,
            registryHost,
            buildEventsUrl,
        }),
        ...buildDefaultManagedAppSourceFiles({
            appName,
            slug,
            sourcePrompt,
        }),
    ];
}

function buildManagedAppInfrastructureFiles({
    appName = '',
    slug = '',
    publicHost = '',
    namespace = '',
    sourcePrompt = '',
    giteaOrg = '',
    gitProviderOrg = '',
    imageRepo = '',
    registryHost = '',
    buildEventsUrl = '',
} = {}) {
    const safePrompt = escapeHtml(sourcePrompt || 'Describe the application you want here.');

    return [
        {
            path: 'README.md',
            content: `# ${appName}

Managed by KimiBuilt.

- App slug: \`${slug}\`
- Public host: \`${publicHost}\`
- Namespace: \`${namespace}\`
- Image repo: \`${imageRepo}\`

Original request:

> ${sourcePrompt || 'No original prompt was recorded.'}

This repository is wired for GitLab CI image publishing and KimiBuilt deployment orchestration.
`,
        },
        {
            path: '.dockerignore',
            content: `.git
node_modules
npm-debug.log
Dockerfile*
deploy
README.md
`,
        },
        {
            path: 'Dockerfile',
            content: buildDockerfile(),
        },
        {
            path: 'deploy/k8s/reference.yaml',
            content: buildKubernetesReference({
                slug,
                namespace,
                publicHost,
                imageRepo,
                imageTag: 'latest',
            }),
        },
        {
            path: '.gitlab-ci.yml',
            content: buildGitLabCiYaml({
                appName,
                slug,
                gitProviderOrg: gitProviderOrg || giteaOrg,
                imageRepo,
                registryHost,
                buildEventsUrl,
            }),
        },
    ];
}

function buildDefaultManagedAppSourceFiles({
    appName = '',
    slug = '',
    sourcePrompt = '',
} = {}) {
    const safePrompt = escapeHtml(sourcePrompt || 'Describe the application you want here.');

    return [
        {
            path: 'public/index.html',
            content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(appName)}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="shell">
    <p class="eyebrow">Managed App</p>
    <h1>${escapeHtml(appName)}</h1>
    <p class="lede">This app was provisioned through the KimiBuilt managed app control plane.</p>
    <section class="panel">
      <h2>Original prompt</h2>
      <p>${safePrompt}</p>
    </section>
    <section class="panel">
      <h2>Next step</h2>
      <p>Replace the placeholder frontend in <code>public/</code> with the generated application.</p>
    </section>
  </main>
  <script src="./app.js"></script>
</body>
</html>
`,
        },
        {
            path: 'public/styles.css',
            content: `:root {
  color-scheme: light;
  --bg: #f2eee5;
  --ink: #1f1c17;
  --accent: #bb5a2a;
  --panel: rgba(255, 255, 255, 0.75);
  --line: rgba(31, 28, 23, 0.12);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  font-family: Georgia, "Times New Roman", serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(187, 90, 42, 0.18), transparent 32%),
    linear-gradient(135deg, #f9f6ef 0%, var(--bg) 100%);
}

.shell {
  width: min(760px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 72px 0 96px;
}

.eyebrow {
  margin: 0 0 12px;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--accent);
  font-size: 0.78rem;
}

h1 {
  margin: 0;
  font-size: clamp(2.8rem, 6vw, 4.8rem);
  line-height: 0.95;
}

.lede {
  max-width: 44rem;
  font-size: 1.15rem;
}

.panel {
  margin-top: 24px;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: 24px;
  background: var(--panel);
  backdrop-filter: blur(12px);
}

code {
  font-family: "Courier New", monospace;
}
`,
        },
        {
            path: 'public/app.js',
            content: `console.log('KimiBuilt managed app scaffold ready for ${slug}.');\n`,
        },
    ];
}

function buildManagedAppAuthoringPrompt({
    appName = '',
    slug = '',
    publicHost = '',
    namespace = '',
    sourcePrompt = '',
} = {}) {
    return [
        'Generate a compact production-ready static web app for a managed deployment repository.',
        'Return only JSON with this shape: {"files":[{"path":"public/index.html","content":"..."},{"path":"public/styles.css","content":"..."},{"path":"public/app.js","content":"..."}]}.',
        'Rules:',
        '- Only include the three public/* files listed above.',
        '- No markdown fences, no explanations, no extra keys.',
        '- Use plain HTML, CSS, and browser JavaScript only.',
        '- Do not use frameworks, build tools, npm dependencies, images, or remote assets.',
        '- Make it responsive and visually intentional.',
        '- The page should feel complete, not like a placeholder.',
        '- Keep JavaScript small and focused on progressive enhancement.',
        `App name: ${appName}`,
        `App slug: ${slug}`,
        `Public host: ${publicHost}`,
        `Kubernetes namespace: ${namespace}`,
        `User request: ${sourcePrompt || 'Create a polished web app.'}`,
    ].join('\n');
}

function normalizeGeneratedManagedAppSourceFiles(files = []) {
    const entries = Array.isArray(files) ? files : [];
    const allowedPaths = new Set(DEFAULT_SOURCE_FILE_PATHS);

    return entries
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => ({
            path: normalizeText(entry.path),
            content: String(entry.content || ''),
        }))
        .filter((entry) => allowedPaths.has(entry.path) && entry.content.trim());
}

module.exports = {
    buildGitLabCiYaml,
    buildDefaultScaffoldFiles,
    buildDefaultManagedAppSourceFiles,
    buildManagedAppAuthoringPrompt,
    buildManagedAppInfrastructureFiles,
    normalizeGeneratedManagedAppSourceFiles,
};

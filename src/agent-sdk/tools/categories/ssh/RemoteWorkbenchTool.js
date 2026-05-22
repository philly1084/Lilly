'use strict';

const { ToolBase } = require('../../ToolBase');
const { SSHExecuteTool } = require('./SSHExecuteTool');
const { REMOTE_CLI_COMMAND_CATALOG } = require('../../../tool-docs');

const ACTION_ALIASES = Object.freeze({
  status: 'changed-files',
  search: 'grep',
  'targeted-grep': 'grep',
  cat: 'read-file',
  read: 'read-file',
  write: 'write-file',
  patch: 'apply-patch',
  verify: 'deploy-verify',
  'https-verify': 'deploy-verify',
});

const ALLOWED_ACTIONS = Object.freeze([
  'baseline',
  'repo-inspect',
  'repo-map',
  'changed-files',
  'git-prepare',
  'git-snapshot',
  'git-commit',
  'git-revert',
  'file-search',
  'dependency-check',
  'grep',
  'read-file',
  'write-file',
  'apply-patch',
  'build',
  'test',
  'focused-test',
  'buildkit',
  'direct-image-build',
  'ui-visual-check',
  'kubectl-inspect',
  'k8s-app-inventory',
  'logs',
  'pod-debug',
  'rollout',
  'deploy-verify',
]);

const CATALOG_ACTION_IDS = Object.freeze({
  baseline: 'baseline',
  'repo-inspect': 'repo-inspect',
  'repo-map': 'repo-map',
  'changed-files': 'changed-files',
  'file-search': 'file-search',
  'dependency-check': 'dependency-check',
  build: 'build',
  test: 'test',
  'focused-test': 'focused-test',
  buildkit: 'buildkit',
  'direct-image-build': 'direct-image-build',
  'ui-visual-check': 'ui-visual-check',
  'kubectl-inspect': 'kubectl-inspect',
  'k8s-app-inventory': 'k8s-app-inventory',
  'pod-debug': 'pod-debug',
});

function normalizeAction(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return ACTION_ALIASES[normalized] || normalized;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function shQuote(value = '') {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildHttpsAvailabilityProbeLines() {
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
  ];
}

function normalizeRemotePath(value = '', fieldName = 'path') {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  if (/[\0\r\n]/.test(trimmed)) {
    throw new Error(`${fieldName} must be a single remote path`);
  }
  if (trimmed.includes('\\')) {
    throw new Error(`${fieldName} must use remote Linux-style forward slashes`);
  }
  if (/^~(?:\/|$)/.test(trimmed)) {
    throw new Error(`${fieldName} must be explicit; home-relative paths are not allowed`);
  }
  if (trimmed.split('/').filter(Boolean).includes('..')) {
    throw new Error(`${fieldName} must not contain .. path traversal`);
  }
  if (/^-/.test(trimmed)) {
    throw new Error(`${fieldName} must not start with -`);
  }
  return trimmed;
}

function normalizeGitRef(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  if (/[\0\r\n\s~^:?*\\]/.test(trimmed)
    || trimmed.includes('[')
    || trimmed.includes(']')
    || trimmed.includes('..')
    || trimmed.startsWith('-')
    || trimmed.endsWith('.')) {
    throw new Error('branch must be a safe git branch name');
  }
  return trimmed.replace(/^\/+|\/+$/g, '');
}

function buildEnvironment(params = {}, overrides = {}) {
  const environment = {
    ...(params.environment && typeof params.environment === 'object' ? params.environment : {}),
    ...overrides,
  };

  [
    ['namespace', 'NAMESPACE'],
    ['deployment', 'DEPLOYMENT'],
    ['publicHost', 'PUBLIC_HOST'],
    ['publicUrl', 'PUBLIC_URL'],
    ['uiCheckDir', 'UI_CHECK_DIR'],
    ['testPath', 'TEST_PATH'],
    ['manifestDir', 'MANIFEST_DIR'],
    ['needle', 'NEEDLE'],
  ].forEach(([paramName, envName]) => {
    const value = params[paramName];
    if (value !== undefined && value !== null && String(value).trim()) {
      environment[envName] = String(value).trim();
    }
  });

  return environment;
}

class RemoteWorkbenchTool extends ToolBase {
  constructor(options = {}) {
    super({
      id: options.id || 'remote-workbench',
      name: options.name || 'Remote Workbench',
      description: options.description || 'Run structured remote repo, file, build, test, log, rollout, and verification actions through the remote runner or SSH fallback.',
      category: 'ssh',
      version: '1.0.0',
      backend: {
        sideEffects: ['network', 'execute', 'write'],
        sandbox: { network: true },
        timeout: 180000,
      },
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ALLOWED_ACTIONS,
            description: 'Structured remote action to execute.',
          },
          cwd: {
            type: 'string',
            description: 'Remote working directory. Defaults to the runner or SSH target workspace.',
          },
          workingDirectory: {
            type: 'string',
            description: 'Alias for cwd.',
          },
          path: {
            type: 'string',
            description: 'Remote path for read-file, write-file, or grep search scope.',
          },
          content: {
            type: 'string',
            description: 'File contents for write-file.',
          },
          contentBase64: {
            type: 'string',
            description: 'Base64 file contents for write-file.',
          },
          patch: {
            type: 'string',
            description: 'Unified diff for apply-patch.',
          },
          needle: {
            type: 'string',
            description: 'Search needle for grep.',
          },
          startLine: {
            type: 'integer',
            description: 'First line for read-file. Defaults to 1.',
          },
          lineCount: {
            type: 'integer',
            description: 'Number of lines for read-file. Defaults to 200.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum result lines for grep. Defaults to 200.',
          },
          branch: {
            type: 'string',
            description: 'Git branch name for git-prepare. Defaults to agent/<timestamp>.',
          },
          commitMessage: {
            type: 'string',
            description: 'Commit message for git-commit or git-revert.',
          },
          baseCommit: {
            type: 'string',
            description: 'Expected base commit for git-snapshot or git-revert evidence.',
          },
          revertCommit: {
            type: 'string',
            description: 'Commit SHA to revert with git-revert. Defaults to HEAD.',
          },
          maxDepth: {
            type: 'integer',
            description: 'Maximum find depth for grep. Defaults to 6.',
          },
          namespace: {
            type: 'string',
            description: 'Kubernetes namespace for logs, pod-debug, rollout, and deploy-verify.',
          },
          deployment: {
            type: 'string',
            description: 'Kubernetes deployment for logs, pod-debug, rollout, and deploy-verify.',
          },
          publicHost: {
            type: 'string',
            description: 'Public host for deploy-verify.',
          },
          publicUrl: {
            type: 'string',
            description: 'Public URL for ui-visual-check. If omitted, publicHost is used as https://publicHost.',
          },
          uiCheckDir: {
            type: 'string',
            description: 'Remote output directory for ui-visual-check screenshots and report.',
          },
          testPath: {
            type: 'string',
            description: 'Focused test path or Jest pattern.',
          },
          timeout: {
            type: 'integer',
            description: 'Command timeout in milliseconds.',
          },
          preferRunner: {
            type: 'boolean',
            default: true,
            description: 'Prefer the online remote runner.',
          },
          requireRunner: {
            type: 'boolean',
            default: false,
            description: 'Require the online remote runner and do not fall back to SSH.',
          },
          sudo: {
            type: 'boolean',
            default: false,
            description: 'Request sudo execution through the selected transport. Requires explicit approval and runner/SSH policy support.',
          },
          approval: {
            type: 'object',
            description: 'Explicit approval metadata for runner-gated privileged commands. Use only for user-approved admin operations.',
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          profile: { type: 'string' },
          command: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: 'integer' },
          host: { type: 'string' },
          duration: { type: 'integer' },
        },
      },
    });

    this.remoteCommand = options.remoteCommand || new SSHExecuteTool({
      id: 'remote-command',
      name: 'Remote Command',
      description: 'Internal remote command helper for structured remote workbench actions',
    });
  }

  async handler(params = {}, context = {}, tracker = null) {
    const plan = this.buildPlan(params);
    const workingDirectory = String(params.cwd || params.workingDirectory || '').trim();
    const commandParams = {
      host: params.host,
      port: params.port,
      username: params.username,
      command: plan.command,
      timeout: params.timeout || plan.timeout || 120000,
      workingDirectory: workingDirectory || undefined,
      environment: plan.environment || buildEnvironment(params),
      contextFiles: plan.contextFiles || [],
      contextDirectory: params.contextDirectory || '.kimibuilt/context',
      profile: plan.profile,
      preferRunner: params.preferRunner !== false,
      requireRunner: params.requireRunner === true,
      sudo: params.sudo === true,
      workflowAction: `remote-workbench-${plan.action}`,
      approval: params.approval || {},
    };

    tracker?.recordExecution?.(`remote-workbench ${plan.action}`, {
      profile: plan.profile,
      command: plan.command,
    });

    const result = await this.remoteCommand.handler(commandParams, {
      ...context,
      toolId: 'remote-workbench',
    }, tracker);

    return {
      action: plan.action,
      profile: plan.profile,
      command: plan.command,
      workingDirectory,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 0,
      host: result.host || '',
      duration: result.duration || 0,
      catalogId: plan.catalogId || '',
      stagedFiles: (plan.contextFiles || []).map((file) => file.filename),
    };
  }

  buildPlan(params = {}) {
    const action = normalizeAction(params.action || params.commandId || '');
    if (!ALLOWED_ACTIONS.includes(action)) {
      throw new Error(`Unsupported remote-workbench action '${params.action || ''}'`);
    }

    if (action === 'grep') {
      return this.buildGrepPlan(params);
    }
    if (action === 'read-file') {
      return this.buildReadFilePlan(params);
    }
    if (action === 'write-file') {
      return this.buildWriteFilePlan(params);
    }
    if (action === 'apply-patch') {
      return this.buildApplyPatchPlan(params);
    }
    if (action === 'git-prepare') {
      return this.buildGitPreparePlan(params);
    }
    if (action === 'git-snapshot') {
      return this.buildGitSnapshotPlan(params);
    }
    if (action === 'git-commit') {
      return this.buildGitCommitPlan(params);
    }
    if (action === 'git-revert') {
      return this.buildGitRevertPlan(params);
    }
    if (action === 'logs') {
      return this.buildLogsPlan(params);
    }
    if (action === 'rollout') {
      return this.buildRolloutPlan(params);
    }
    if (action === 'deploy-verify') {
      return this.buildDeployVerifyPlan(params);
    }

    const catalogId = action === 'test' && params.testPath ? 'focused-test' : CATALOG_ACTION_IDS[action];
    const entry = REMOTE_CLI_COMMAND_CATALOG.find((item) => item.id === catalogId);
    if (!entry) {
      throw new Error(`No command catalog entry for remote-workbench action '${action}'`);
    }

    return {
      action,
      catalogId,
      command: entry.command,
      profile: entry.profile || 'inspect',
      environment: buildEnvironment(params),
      timeout: entry.profile === 'build' ? 180000 : 120000,
    };
  }

  buildGrepPlan(params = {}) {
    const needle = String(params.needle || '').trim();
    if (!needle) {
      throw new Error('needle is required for remote-workbench grep');
    }
    const searchPath = normalizeRemotePath(params.path || params.searchPath || '.', 'path');
    const maxDepth = clampInteger(params.maxDepth, 6, 1, 12);
    const limit = clampInteger(params.limit, 200, 1, 1000);

    return {
      action: 'grep',
      command: [
        'needle="${NEEDLE:-}"',
        'search_path="${SEARCH_PATH:-.}"',
        'if [ -z "$needle" ]; then echo "NEEDLE is required" >&2; exit 2; fi',
        `find "$search_path" -maxdepth ${maxDepth} -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" -o -name "*.json" -o -name "*.md" -o -name "*.yaml" -o -name "*.yml" -o -name "*.css" -o -name "*.html" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -print0 | xargs -0 grep -n -- "$needle" | head -n ${limit} || true`,
      ].join('\n'),
      profile: 'inspect',
      environment: buildEnvironment(params, {
        NEEDLE: needle,
        SEARCH_PATH: searchPath,
      }),
    };
  }

  buildReadFilePlan(params = {}) {
    const target = normalizeRemotePath(params.path, 'path');
    const startLine = clampInteger(params.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
    const lineCount = clampInteger(params.lineCount || params.limit, 200, 1, 2000);
    const endLine = startLine + lineCount - 1;

    return {
      action: 'read-file',
      command: [
        `target=${shQuote(target)}`,
        'if [ ! -f "$target" ]; then echo "File not found: $target" >&2; exit 2; fi',
        `sed -n '${startLine},${endLine}p' -- "$target"`,
      ].join('\n'),
      profile: 'inspect',
      environment: buildEnvironment(params),
    };
  }

  buildWriteFilePlan(params = {}) {
    const target = normalizeRemotePath(params.path, 'path');
    if (params.content === undefined && params.contentBase64 === undefined) {
      throw new Error('content or contentBase64 is required for remote-workbench write-file');
    }

    const filename = 'remote-workbench-write.txt';
    const contextFile = {
      filename,
      mimeType: params.mimeType || 'text/plain',
      source: 'remote-workbench',
      description: `remote-workbench write-file ${target}`,
      ...(params.contentBase64 !== undefined
        ? { contentBase64: String(params.contentBase64 || '') }
        : { content: String(params.content ?? '') }),
    };

    return {
      action: 'write-file',
      command: [
        `target=${shQuote(target)}`,
        `source_file="$KIMIBUILT_CONTEXT_DIR/${filename}"`,
        'mkdir -p -- "$(dirname -- "$target")"',
        'if [ -e "$target" ]; then cp -- "$target" "$target.bak.$(date +%Y%m%d%H%M%S)" || true; fi',
        'cp -- "$source_file" "$target"',
        params.executable === true ? 'chmod +x -- "$target"' : '',
        'printf "wrote %s\\n" "$target"',
      ].filter(Boolean).join('\n'),
      profile: 'build',
      environment: buildEnvironment(params),
      contextFiles: [contextFile],
      timeout: 120000,
    };
  }

  buildApplyPatchPlan(params = {}) {
    const patch = String(params.patch || params.diff || '').trim();
    if (!patch) {
      throw new Error('patch is required for remote-workbench apply-patch');
    }

    const filename = 'remote-workbench.patch';
    return {
      action: 'apply-patch',
      command: [
        `patch_file="$KIMIBUILT_CONTEXT_DIR/${filename}"`,
        'if [ ! -d .git ]; then echo "apply-patch requires a git workspace" >&2; exit 2; fi',
        'git apply --check "$patch_file"',
        'git apply "$patch_file"',
        'git status --short',
      ].join('\n'),
      profile: 'build',
      environment: buildEnvironment(params),
      contextFiles: [{
        filename,
        mimeType: 'text/x-diff',
        source: 'remote-workbench',
        description: 'remote-workbench apply-patch',
        content: patch.endsWith('\n') ? patch : `${patch}\n`,
      }],
      timeout: 120000,
    };
  }

  buildGitPreparePlan(params = {}) {
    const branch = normalizeGitRef(params.branch || params.gitBranch || '');
    return {
      action: 'git-prepare',
      command: [
        'set -e',
        'branch="${GIT_BRANCH:-agent/$(date +%Y%m%d%H%M%S)}"',
        'if [ ! -d .git ]; then',
        '  git init -b main >/dev/null 2>&1 || git init >/dev/null',
        'fi',
        'if ! git config user.name >/dev/null; then git config user.name "KimiBuilt Remote Agent"; fi',
        'if ! git config user.email >/dev/null; then git config user.email "agent@kimibuilt.local"; fi',
        'if ! git rev-parse --verify HEAD >/dev/null 2>&1; then',
        '  git add -A',
        '  if git diff --cached --quiet; then',
        '    git commit --allow-empty -m "chore: establish KimiBuilt remote baseline" >/dev/null',
        '  else',
        '    git commit -m "chore: establish KimiBuilt remote baseline" >/dev/null',
        '  fi',
        'fi',
        'base_commit="$(git rev-parse HEAD)"',
        'if git show-ref --verify --quiet "refs/heads/$branch"; then',
        '  git checkout "$branch" >/dev/null',
        'else',
        '  git checkout -b "$branch" >/dev/null',
        'fi',
        'echo "__KIMIBUILT_GIT_WORKSPACE__=$(pwd)"',
        'echo "__KIMIBUILT_GIT_BRANCH__=$branch"',
        'echo "__KIMIBUILT_GIT_BASE_COMMIT__=$base_commit"',
        'echo "__KIMIBUILT_GIT_HEAD__=$(git rev-parse HEAD)"',
        'git status --short --branch',
      ].join('\n'),
      profile: 'build',
      environment: buildEnvironment(params, {
        ...(branch ? { GIT_BRANCH: branch } : {}),
      }),
      timeout: 120000,
    };
  }

  buildGitSnapshotPlan(params = {}) {
    return {
      action: 'git-snapshot',
      command: [
        'set -e',
        'if [ ! -d .git ]; then echo "git-snapshot requires a git workspace" >&2; exit 2; fi',
        'base="${GIT_BASE_COMMIT:-}"',
        'head_commit="$(git rev-parse HEAD)"',
        'echo "__KIMIBUILT_GIT_WORKSPACE__=$(pwd)"',
        'echo "__KIMIBUILT_GIT_BRANCH__=$(git branch --show-current || true)"',
        'echo "__KIMIBUILT_GIT_BASE_COMMIT__=${base:-unknown}"',
        'echo "__KIMIBUILT_GIT_HEAD__=$head_commit"',
        'echo "__KIMIBUILT_GIT_STATUS__"',
        'git status --short --branch',
        'echo "__KIMIBUILT_GIT_CHANGED_FILES__"',
        'git diff --name-status "${base:-HEAD}" 2>/dev/null || git diff --name-status',
        'git diff --cached --name-status',
        'echo "__KIMIBUILT_GIT_DIFF_STAT__"',
        'git diff --stat "${base:-HEAD}" 2>/dev/null || git diff --stat',
        'git diff --cached --stat',
        'echo "__KIMIBUILT_GIT_DIFF_PATCH__"',
        'git diff --no-ext-diff --binary "${base:-HEAD}" 2>/dev/null || git diff --no-ext-diff --binary',
        'git diff --cached --no-ext-diff --binary',
      ].join('\n'),
      profile: 'inspect',
      environment: buildEnvironment(params, {
        ...(params.baseCommit ? { GIT_BASE_COMMIT: String(params.baseCommit).trim() } : {}),
      }),
      timeout: 120000,
    };
  }

  buildGitCommitPlan(params = {}) {
    const message = String(params.commitMessage || params.message || 'chore: save KimiBuilt remote agent changes').trim();
    return {
      action: 'git-commit',
      command: [
        'set -e',
        'if [ ! -d .git ]; then echo "git-commit requires a git workspace" >&2; exit 2; fi',
        'if ! git config user.name >/dev/null; then git config user.name "KimiBuilt Remote Agent"; fi',
        'if ! git config user.email >/dev/null; then git config user.email "agent@kimibuilt.local"; fi',
        'git add -A',
        'if git diff --cached --quiet; then',
        '  echo "__KIMIBUILT_GIT_COMMIT__=none"',
        '  echo "__KIMIBUILT_GIT_COMMIT_STATUS__=clean"',
        'else',
        '  git commit -m "$GIT_COMMIT_MESSAGE" >/dev/null',
        '  echo "__KIMIBUILT_GIT_COMMIT__=$(git rev-parse HEAD)"',
        '  echo "__KIMIBUILT_GIT_COMMIT_STATUS__=committed"',
        'fi',
        'echo "__KIMIBUILT_GIT_BRANCH__=$(git branch --show-current || true)"',
        'git status --short --branch',
      ].join('\n'),
      profile: 'build',
      environment: buildEnvironment(params, {
        GIT_COMMIT_MESSAGE: message,
      }),
      timeout: 120000,
    };
  }

  buildGitRevertPlan(params = {}) {
    const revertCommit = String(params.revertCommit || params.commit || 'HEAD').trim();
    const message = String(params.commitMessage || params.message || '').trim();
    return {
      action: 'git-revert',
      command: [
        'set -e',
        'if [ ! -d .git ]; then echo "git-revert requires a git workspace" >&2; exit 2; fi',
        'target="${GIT_REVERT_COMMIT:-HEAD}"',
        'before="$(git rev-parse HEAD)"',
        'git revert --no-edit "$target"',
        'if [ -n "${GIT_COMMIT_MESSAGE:-}" ]; then',
        '  git commit --amend -m "$GIT_COMMIT_MESSAGE" >/dev/null',
        'fi',
        'echo "__KIMIBUILT_GIT_REVERTED_COMMIT__=$target"',
        'echo "__KIMIBUILT_GIT_REVERT_BASE__=$before"',
        'echo "__KIMIBUILT_GIT_COMMIT__=$(git rev-parse HEAD)"',
        'echo "__KIMIBUILT_GIT_BRANCH__=$(git branch --show-current || true)"',
        'git status --short --branch',
      ].join('\n'),
      profile: 'build',
      environment: buildEnvironment(params, {
        GIT_REVERT_COMMIT: revertCommit,
        ...(message ? { GIT_COMMIT_MESSAGE: message } : {}),
      }),
      timeout: 120000,
    };
  }

  buildLogsPlan(params = {}) {
    return {
      action: 'logs',
      command: [
        'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml',
        'ns="${NAMESPACE:-kimibuilt}"',
        'app="${DEPLOYMENT:-backend}"',
        'kubectl logs deployment/"$app" -n "$ns" --all-containers=true --tail=200',
      ].join('\n'),
      profile: 'inspect',
      environment: buildEnvironment(params),
      timeout: 120000,
    };
  }

  buildRolloutPlan(params = {}) {
    return {
      action: 'rollout',
      command: [
        'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml',
        'ns="${NAMESPACE:-kimibuilt}"',
        'app="${DEPLOYMENT:-backend}"',
        'kubectl rollout status deployment/"$app" -n "$ns" --timeout=180s',
      ].join('\n'),
      profile: 'deploy',
      environment: buildEnvironment(params),
      timeout: 240000,
    };
  }

  buildDeployVerifyPlan(params = {}) {
    return {
      action: 'deploy-verify',
      command: [
        'set -e',
        'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml',
        'ns="${NAMESPACE:-kimibuilt}"',
        'app="${DEPLOYMENT:-backend}"',
        'host="${PUBLIC_HOST:-demoserver2.buzz}"',
        'kubectl rollout status deployment/"$app" -n "$ns" --timeout=180s',
        'kubectl wait --for=condition=available deployment/"$app" -n "$ns" --timeout=180s',
        'kubectl get deploy,svc,ingress,certificate -n "$ns" -o wide || true',
        'getent ahosts "$host" || true',
        ...buildHttpsAvailabilityProbeLines(),
      ].join('\n'),
      profile: 'deploy',
      environment: buildEnvironment(params),
      timeout: 300000,
    };
  }
}

module.exports = {
  RemoteWorkbenchTool,
  normalizeAction,
};

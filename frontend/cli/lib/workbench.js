const WORKBENCH_COMMANDS = new Set([
  'pwd',
  'cd',
  'ls',
  'tree',
  'cat',
  'repo',
  'files',
  'search',
  'open',
  'changes',
  'install',
  'test',
  'build',
  'run',
  'deploy',
  'rollout',
  'logs',
  'verify',
  'status',
]);

const REMOTE_BUILD_EXECUTION_PROFILE = 'remote-build';

function quoteShellArg(value = '') {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

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

function splitFirstToken(input = '') {
  const normalized = normalizeText(input);
  if (!normalized) {
    return { command: '', args: '' };
  }

  const match = normalized.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    command: String(match?.[1] || '').toLowerCase(),
    args: normalizeText(match?.[2] || ''),
  };
}

function parseWorkbenchAlias(input = '') {
  const parsed = splitFirstToken(input);
  if (!parsed.command) {
    return null;
  }

  if (parsed.command === 'git') {
    const gitParsed = splitFirstToken(parsed.args);
    if (gitParsed.command === 'status') {
      return { command: 'git-status', args: gitParsed.args, raw: normalizeText(input) };
    }
    if (gitParsed.command === 'diff') {
      return { command: 'git-diff', args: gitParsed.args, raw: normalizeText(input) };
    }
    return null;
  }

  if (!WORKBENCH_COMMANDS.has(parsed.command)) {
    return null;
  }

  return {
    ...parsed,
    raw: normalizeText(input),
  };
}

function hasRunnerCliTool(toolContext = {}, toolName = '') {
  const expected = normalizeText(toolName).toLowerCase();
  const tools = [
    ...(toolContext?.remoteTool?.runtime?.cliTools || []),
    ...(toolContext?.runtime?.remoteRunner?.cliTools || []),
  ];
  const availableNames = [
    ...(toolContext?.remoteTool?.runtime?.availableCliTools || []),
    ...(toolContext?.runtime?.remoteRunner?.availableCliTools || []),
  ];

  return tools.some((tool) => (
    normalizeText(tool?.name).toLowerCase() === expected && tool.available !== false
  )) || availableNames.some((name) => normalizeText(name).toLowerCase() === expected);
}

function resolveDefaultRemoteCwd(toolContext = {}, configValues = {}) {
  return normalizeText(
    configValues.remoteDefaultCwd
    || toolContext?.remoteTool?.runtime?.defaultWorkspace
    || toolContext?.runtime?.remoteRunner?.defaultWorkspace
    || toolContext?.runtime?.remoteRunner?.workspace
    || '/workspace',
  ) || '/workspace';
}

function resolveActiveRemoteCwd(toolContext = {}, configValues = {}) {
  return normalizeText(configValues.remoteCwd) || resolveDefaultRemoteCwd(toolContext, configValues);
}

function buildCdCommand(target = '') {
  const requested = normalizeText(target) || '.';
  return [
    `target=${quoteShellArg(requested)}`,
    'test -d "$target"',
    'cd "$target"',
    'pwd',
  ].join('\n');
}

function buildHttpsVerifyCommand(host = '') {
  const normalized = normalizeText(host) || 'demoserver2.buzz';
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(normalized)) {
    throw new Error('Host must be a domain, IP address, or host:port without shell characters.');
  }

  return [
    `host=${quoteShellArg(normalized)}`,
    'getent ahosts "$host" || true',
    buildHttpsAvailabilityProbeCommand(),
  ].join('\n');
}

function buildSearchCommand(args = '', toolContext = {}) {
  const [pattern, ...pathParts] = normalizeText(args).split(/\s+/).filter(Boolean);
  if (!pattern) {
    throw new Error('Usage: search <pattern> [path]');
  }

  const targetPath = pathParts.join(' ') || '.';
  if (hasRunnerCliTool(toolContext, 'rg')) {
    return `rg --line-number --hidden --glob '!node_modules' --glob '!.git' -- ${quoteShellArg(pattern)} ${quoteShellArg(targetPath)}`;
  }

  return `grep -R --line-number --exclude-dir=.git --exclude-dir=node_modules -- ${quoteShellArg(pattern)} ${quoteShellArg(targetPath)}`;
}

function buildRemoteWorkbenchCommand(alias = {}, toolContext = {}) {
  const command = normalizeText(alias.command).toLowerCase();
  const args = normalizeText(alias.args);

  switch (command) {
    case 'pwd':
      return { command: 'pwd', profile: 'inspect', workflowAction: 'cli-workbench-pwd' };
    case 'cd':
      return { command: buildCdCommand(args), profile: 'inspect', workflowAction: 'cli-workbench-cd', updateCwdFromStdout: true };
    case 'ls':
      return { command: `ls -la -- ${quoteShellArg(args || '.')}`, profile: 'inspect', workflowAction: 'cli-workbench-ls' };
    case 'tree':
      return { command: `find ${quoteShellArg(args || '.')} -maxdepth 3 -print | sort | sed -n '1,240p'`, profile: 'inspect', workflowAction: 'cli-workbench-tree' };
    case 'cat':
    case 'open':
      if (!args) {
        throw new Error(`Usage: ${command} <file>`);
      }
      return { command: `test -f ${quoteShellArg(args)} && sed -n '1,240p' -- ${quoteShellArg(args)}`, profile: 'inspect', workflowAction: `cli-workbench-${command}` };
    case 'repo':
      return {
        command: [
          'repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)',
          'printf "repoRoot: %s\\n" "$repo_root"',
          'pwd',
          '(git status --short --branch && git remote -v) || true',
          'find . -maxdepth 2 -type f | sort | sed -n "1,120p"',
        ].join('\n'),
        profile: 'inspect',
        workflowAction: 'cli-workbench-repo',
      };
    case 'files':
      return { command: `find ${quoteShellArg(args || '.')} -maxdepth 4 -type f | sort | sed -n '1,240p'`, profile: 'inspect', workflowAction: 'cli-workbench-files' };
    case 'search':
      return { command: buildSearchCommand(args, toolContext), profile: 'inspect', workflowAction: 'cli-workbench-search' };
    case 'changes':
    case 'git-status':
      return { command: 'git status --short --branch && git diff --stat', profile: 'inspect', workflowAction: 'cli-workbench-git-status' };
    case 'git-diff':
      return { command: args ? `git diff -- ${quoteShellArg(args)}` : 'git diff', profile: 'inspect', workflowAction: 'cli-workbench-git-diff' };
    case 'install':
      return { command: 'if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; else echo "No package.json found"; fi', profile: 'build', workflowAction: 'cli-workbench-install', timeout: 300000 };
    case 'test':
      return { command: 'if [ -f package.json ]; then npm test; else echo "No package.json found"; fi', profile: 'build', workflowAction: 'cli-workbench-test', timeout: 300000 };
    case 'build':
      return { command: 'if [ -f package.json ]; then npm run build; else echo "No package.json found"; fi', profile: 'build', workflowAction: 'cli-workbench-build', timeout: 300000 };
    case 'run':
      if (!args) {
        throw new Error('Usage: run <command>');
      }
      return { command: args, profile: 'build', workflowAction: 'cli-workbench-run', timeout: 300000 };
    case 'rollout':
      return { command: 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl rollout status deployment/backend -n kimibuilt --timeout=180s', profile: 'deploy', workflowAction: 'cli-workbench-rollout', timeout: 180000 };
    case 'logs':
      return { command: 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl logs deployment/backend -n kimibuilt --all-containers=true --tail=200', profile: 'inspect', workflowAction: 'cli-workbench-logs' };
    case 'verify':
      return { command: buildHttpsVerifyCommand(args), profile: 'inspect', workflowAction: 'cli-workbench-verify', timeout: 60000 };
    default:
      return null;
  }
}

function normalizeDeployDefaults(defaults = {}) {
  return {
    repositoryUrl: normalizeText(defaults.repositoryUrl || defaults.defaultRepositoryUrl),
    targetDirectory: normalizeText(defaults.targetDirectory || defaults.defaultTargetDirectory),
    manifestsPath: normalizeText(defaults.manifestsPath || defaults.defaultManifestsPath),
    namespace: normalizeText(defaults.namespace || defaults.defaultNamespace),
    deployment: normalizeText(defaults.deployment || defaults.defaultDeployment),
    container: normalizeText(defaults.container || defaults.defaultContainer),
    branch: normalizeText(defaults.branch || defaults.defaultBranch),
    publicDomain: normalizeText(defaults.publicDomain || defaults.defaultPublicDomain) || 'demoserver2.buzz',
    ingressClassName: normalizeText(defaults.ingressClassName || defaults.defaultIngressClassName),
    tlsClusterIssuer: normalizeText(defaults.tlsClusterIssuer || defaults.defaultTlsClusterIssuer),
  };
}

function buildK3sDeployParams(action = '', deployDefaults = {}) {
  const defaults = normalizeDeployDefaults(deployDefaults);
  return {
    action,
    ...(defaults.repositoryUrl ? { repositoryUrl: defaults.repositoryUrl } : {}),
    ...(defaults.branch ? { ref: defaults.branch, branch: defaults.branch } : {}),
    ...(defaults.targetDirectory ? { targetDirectory: defaults.targetDirectory } : {}),
    ...(defaults.manifestsPath ? { manifestsPath: defaults.manifestsPath } : {}),
    ...(defaults.namespace ? { namespace: defaults.namespace } : {}),
    ...(defaults.deployment ? { deployment: defaults.deployment } : {}),
    ...(defaults.container ? { container: defaults.container } : {}),
    ...(defaults.publicDomain ? { publicDomain: defaults.publicDomain } : {}),
    ...(defaults.ingressClassName ? { ingressClassName: defaults.ingressClassName } : {}),
    ...(defaults.tlsClusterIssuer ? { tlsClusterIssuer: defaults.tlsClusterIssuer } : {}),
  };
}

function buildDeploySequence(toolContext = {}) {
  const deployDefaults = normalizeDeployDefaults(toolContext?.runtime?.deployDefaults || {});
  return [
    {
      label: 'sync-and-apply',
      type: 'k3s-deploy',
      params: buildK3sDeployParams('sync-and-apply', deployDefaults),
      timeout: 300000,
    },
    {
      label: 'rollout-status',
      type: 'k3s-deploy',
      params: buildK3sDeployParams('rollout-status', deployDefaults),
      timeout: 180000,
    },
    {
      label: 'https-verify',
      type: 'remote-command',
      command: buildHttpsVerifyCommand(deployDefaults.publicDomain),
      profile: 'inspect',
      workflowAction: 'cli-workbench-deploy-verify',
      timeout: 60000,
    },
  ];
}

module.exports = {
  REMOTE_BUILD_EXECUTION_PROFILE,
  buildDeploySequence,
  buildHttpsVerifyCommand,
  buildK3sDeployParams,
  buildRemoteWorkbenchCommand,
  hasRunnerCliTool,
  parseWorkbenchAlias,
  quoteShellArg,
  resolveActiveRemoteCwd,
  resolveDefaultRemoteCwd,
};

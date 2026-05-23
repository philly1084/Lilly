param(
  [string]$Namespace = "",
  [string]$Deployment = "backend",
  [string]$SecretName = "kimibuilt-secrets",
  [string]$ConfigMapName = "kimibuilt-config",
  [string]$RemoteCliMcpUrl = $env:REMOTE_CLI_MCP_URL,
  [string]$GatewayUrl = $env:GATEWAY_URL,
  [string]$RemoteCliBearerToken = $env:REMOTE_CLI_MCP_BEARER_TOKEN,
  [string]$N8nApiKey = $env:N8N_API_KEY,
  [string]$DockerHost = $env:DOCKER_HOST,
  [string]$DockerApiVersion = $env:DOCKER_API_VERSION,
  [string]$DefaultTargetId = $env:REMOTE_CLI_DEFAULT_TARGET_ID,
  [string]$DefaultCwd = $env:REMOTE_CLI_DEFAULT_CWD,
  [switch]$NoRestart,
  [switch]$CreateNamespace
)

$ErrorActionPreference = "Stop"

function Invoke-Kubectl {
  $kubectlArgs = $args
  $output = & kubectl @kubectlArgs 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    throw "kubectl $($kubectlArgs -join ' ') failed:`n$output"
  }
  return $output
}

function Test-Kubectl {
  $kubectlArgs = $args
  try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $null = & kubectl @kubectlArgs 2>&1
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Read-DotEnv {
  $envPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".env"
  if (!(Test-Path $envPath)) {
    return
  }

  Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#") -or !$line.Contains("=")) {
      return
    }

    $key, $value = $line.Split("=", 2)
    $key = $key.Trim()
    $value = $value.Trim().Trim('"').Trim("'")
    if ($key -and !(Test-Path "env:$key")) {
      Set-Item -Path "env:$key" -Value $value
    }
  }
}

function Resolve-Namespace {
  if ($Namespace) {
    return $Namespace
  }

  if (Test-Kubectl get namespace kimibuilt) {
    return "kimibuilt"
  }

  $deployments = [string](Invoke-Kubectl get deployments -A -o jsonpath="{range .items[?(@.metadata.name=='backend')]}{.metadata.namespace}{'\n'}{end}")
  $candidate = ($deployments -split "`n" | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1)
  $candidate = if ($candidate) { $candidate.Trim() } else { "" }
  if ($candidate) {
    return $candidate
  }

  $configMaps = [string](Invoke-Kubectl get configmaps -A -o jsonpath="{range .items[?(@.metadata.name=='kimibuilt-config')]}{.metadata.namespace}{'\n'}{end}")
  $candidate = ($configMaps -split "`n" | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1)
  $candidate = if ($candidate) { $candidate.Trim() } else { "" }
  if ($candidate) {
    return $candidate
  }

  if ($CreateNamespace) {
    Invoke-Kubectl create namespace kimibuilt | Out-Null
    return "kimibuilt"
  }

  $context = (Invoke-Kubectl config current-context).Trim()
  throw "Could not find a KimiBuilt namespace in kube context '$context'. Pass -Namespace <name> or rerun with -CreateNamespace after confirming this is the target cluster."
}

Read-DotEnv

if (!$RemoteCliMcpUrl -and $env:REMOTE_CLI_MCP_URL) { $RemoteCliMcpUrl = $env:REMOTE_CLI_MCP_URL }
if (!$GatewayUrl -and $env:GATEWAY_URL) { $GatewayUrl = $env:GATEWAY_URL }
if (!$RemoteCliBearerToken -and $env:REMOTE_CLI_MCP_BEARER_TOKEN) { $RemoteCliBearerToken = $env:REMOTE_CLI_MCP_BEARER_TOKEN }
if (!$N8nApiKey -and $env:N8N_API_KEY) { $N8nApiKey = $env:N8N_API_KEY }
if (!$DockerHost -and $env:DOCKER_HOST) { $DockerHost = $env:DOCKER_HOST }
if (!$DockerApiVersion -and $env:DOCKER_API_VERSION) { $DockerApiVersion = $env:DOCKER_API_VERSION }
if (!$DefaultTargetId -and $env:REMOTE_CLI_DEFAULT_TARGET_ID) { $DefaultTargetId = $env:REMOTE_CLI_DEFAULT_TARGET_ID }
if (!$DefaultCwd -and $env:REMOTE_CLI_DEFAULT_CWD) { $DefaultCwd = $env:REMOTE_CLI_DEFAULT_CWD }

if (!$RemoteCliMcpUrl -and $GatewayUrl) {
  $RemoteCliMcpUrl = $GatewayUrl.TrimEnd("/") + "/mcp"
}

if (!$RemoteCliMcpUrl) {
  $RemoteCliMcpUrl = "http://n8n-openai-cli-gateway.n8n-openai-gateway.svc.cluster.local/mcp"
}

$resolvedNamespace = Resolve-Namespace

if (!(Test-Kubectl get configmap $ConfigMapName -n $resolvedNamespace)) {
  Invoke-Kubectl create configmap $ConfigMapName -n $resolvedNamespace | Out-Null
}

Invoke-Kubectl patch configmap $ConfigMapName -n $resolvedNamespace --type merge -p (@{
  data = @{
    REMOTE_CLI_MCP_URL = $RemoteCliMcpUrl
    REMOTE_CLI_MCP_NAME = "remote-cli"
    REMOTE_CLI_DEFAULT_TARGET_ID = $(if ($DefaultTargetId) { $DefaultTargetId } else { "prod" })
    REMOTE_CLI_AGENT_OPENAI_API_MODE = "chat"
    REMOTE_CLI_AGENT_MAX_TURNS = "20"
  }
} | ConvertTo-Json -Compress) | Out-Null

if ($DefaultCwd) {
  Invoke-Kubectl patch configmap $ConfigMapName -n $resolvedNamespace --type merge -p (@{
    data = @{
      REMOTE_CLI_DEFAULT_CWD = $DefaultCwd
    }
  } | ConvertTo-Json -Compress) | Out-Null
}

if (!(Test-Kubectl get secret $SecretName -n $resolvedNamespace)) {
  Invoke-Kubectl create secret generic $SecretName -n $resolvedNamespace | Out-Null
}

$secretArgs = @(
  "create", "secret", "generic", $SecretName,
  "-n", $resolvedNamespace,
  "--from-literal=REMOTE_CLI_MCP_URL=$RemoteCliMcpUrl"
)

if ($RemoteCliBearerToken) {
  $secretArgs += "--from-literal=REMOTE_CLI_MCP_BEARER_TOKEN=$RemoteCliBearerToken"
} elseif ($N8nApiKey) {
  $secretArgs += "--from-literal=N8N_API_KEY=$N8nApiKey"
} else {
  Write-Warning "No REMOTE_CLI_MCP_BEARER_TOKEN or N8N_API_KEY was found in the environment or .env. Secret was created/kept, but Remote CLI Agent still needs one of those keys."
}

if ($DockerHost) {
  $secretArgs += "--from-literal=DOCKER_HOST=$DockerHost"
}

if ($DockerApiVersion) {
  $secretArgs += "--from-literal=DOCKER_API_VERSION=$DockerApiVersion"
}

$secretArgs += @("--dry-run=client", "-o", "yaml")
$secretYaml = & kubectl @secretArgs
if ($LASTEXITCODE -ne 0) {
  throw "kubectl $($secretArgs -join ' ') failed."
}

$secretYaml | kubectl apply -f - | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "kubectl apply secret failed."
}

$secretKeys = (Invoke-Kubectl get secret $SecretName -n $resolvedNamespace -o jsonpath="{.data}" | ConvertFrom-Json).PSObject.Properties.Name
$hasRemoteToken = $secretKeys -contains "REMOTE_CLI_MCP_BEARER_TOKEN" -or $secretKeys -contains "N8N_API_KEY"

if (!$NoRestart -and (Test-Kubectl get deployment $Deployment -n $resolvedNamespace)) {
  Invoke-Kubectl rollout restart deployment/$Deployment -n $resolvedNamespace | Out-Null
  Invoke-Kubectl rollout status deployment/$Deployment -n $resolvedNamespace --timeout=180s | Out-Null
}

Write-Host "Remote CLI Agent cluster setup checked."
Write-Host "Namespace: $resolvedNamespace"
Write-Host "ConfigMap: $ConfigMapName"
Write-Host "Secret: $SecretName"
Write-Host "REMOTE_CLI_MCP_URL: $RemoteCliMcpUrl"
Write-Host "Remote CLI token present: $hasRemoteToken"
Write-Host "Backend restarted: $(!$NoRestart)"

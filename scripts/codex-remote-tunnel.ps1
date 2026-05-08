param(
  [ValidateSet('init', 'list', 'baseline', 'run', 'tunnel', 'status', 'stop')]
  [string]$Action = 'list',

  [string]$Server = 'all',

  [string]$Config = 'local/remote-tunnels.local.json',

  [string]$Command = '',

  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$defaultConfig = Join-Path $repoRoot $Config
$exampleConfig = Join-Path $repoRoot 'config/remote-tunnels.example.json'
$stateDir = Join-Path $repoRoot 'local/remote-tunnels'

function Resolve-ConfigPath {
  param([string]$Path)
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }
  return (Join-Path $repoRoot $Path)
}

function Read-TunnelConfig {
  param([string]$Path)
  $resolved = Resolve-ConfigPath $Path
  if (!(Test-Path $resolved)) {
    throw "Missing tunnel config: $resolved. Run: powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action init"
  }
  return Get-Content $resolved -Raw | ConvertFrom-Json
}

function Get-ServerNames {
  param($TunnelConfig, [string]$Name)
  $names = @($TunnelConfig.servers.PSObject.Properties.Name)
  if ($Name -eq 'all') {
    return $names
  }
  if ($names -notcontains $Name) {
    throw "Unknown server '$Name'. Known servers: $($names -join ', ')"
  }
  return @($Name)
}

function Get-SshBaseArgs {
  param($Profile)
  $args = @(
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3'
  )
  if ($Profile.strictHostKeyChecking) {
    $args += @('-o', "StrictHostKeyChecking=$($Profile.strictHostKeyChecking)")
  }
  if ($Profile.identityFile) {
    $identityPath = $Profile.identityFile
    if (![System.IO.Path]::IsPathRooted($identityPath)) {
      $identityPath = Join-Path $repoRoot $identityPath
    }
    $args += @('-i', $identityPath)
  }
  return $args
}

function Get-PidPath {
  param([string]$ServerName, [string]$ForwardName)
  $safeName = "$ServerName-$ForwardName" -replace '[^A-Za-z0-9_.-]', '_'
  return Join-Path $stateDir "$safeName.pid"
}

function Test-PidAlive {
  param([string]$PidPath)
  if (!(Test-Path $PidPath)) {
    return $false
  }
  $pidText = (Get-Content $PidPath -Raw).Trim()
  if (!$pidText) {
    return $false
  }
  $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
  return [bool]$proc
}

function Invoke-RemoteCommand {
  param([string]$ServerName, $Profile, [string]$RemoteCommand)
  if (!$Profile.sshTarget -or $Profile.sshTarget -match 'REPLACE_WITH') {
    throw "Server '$ServerName' does not have a usable sshTarget yet."
  }
  $sshArgs = Get-SshBaseArgs $Profile
  $sshArgs += @($Profile.sshTarget, $RemoteCommand)
  Write-Host "[codex-remote] $ServerName -> ssh $($Profile.sshTarget) $RemoteCommand"
  if ($DryRun) {
    return
  }
  & ssh.exe @sshArgs
  if ($LASTEXITCODE -ne 0) {
    throw "SSH command failed for server '$ServerName' with exit code $LASTEXITCODE."
  }
}

if ($Action -eq 'init') {
  if (!(Test-Path (Join-Path $repoRoot 'local'))) {
    New-Item -ItemType Directory -Path (Join-Path $repoRoot 'local') | Out-Null
  }
  if (Test-Path $defaultConfig) {
    Write-Host "[codex-remote] Local config already exists: $defaultConfig"
  } else {
    Copy-Item $exampleConfig $defaultConfig
    Write-Host "[codex-remote] Created local config: $defaultConfig"
    Write-Host "[codex-remote] Edit sshTarget/identityFile for each server before opening tunnels."
  }
  exit 0
}

$tunnelConfig = Read-TunnelConfig $Config
$serverNames = Get-ServerNames $tunnelConfig $Server

if ($Action -eq 'list') {
  foreach ($name in $serverNames) {
    $profile = $tunnelConfig.servers.$name
    Write-Host "$name`t$($profile.sshTarget)"
    foreach ($forward in @($profile.forwards)) {
      Write-Host "  $($forward.name): localhost:$($forward.localPort) -> $($forward.remoteHost):$($forward.remotePort)"
    }
  }
  exit 0
}

if ($Action -eq 'baseline') {
  $baseline = 'hostname && whoami && uname -m && (test -f /etc/os-release && sed -n ''1,6p'' /etc/os-release || true) && uptime && (command -v kubectl >/dev/null 2>&1 && kubectl get nodes -o wide || sudo k3s kubectl get nodes -o wide || true)'
  foreach ($name in $serverNames) {
    Invoke-RemoteCommand $name $tunnelConfig.servers.$name $baseline
  }
  exit 0
}

if ($Action -eq 'run') {
  if (!$Command) {
    throw '-Command is required for -Action run.'
  }
  foreach ($name in $serverNames) {
    Invoke-RemoteCommand $name $tunnelConfig.servers.$name $Command
  }
  exit 0
}

if ($Action -eq 'tunnel') {
  if (!(Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir | Out-Null
  }
  foreach ($name in $serverNames) {
    $profile = $tunnelConfig.servers.$name
    if (!$profile.sshTarget -or $profile.sshTarget -match 'REPLACE_WITH') {
      throw "Server '$name' does not have a usable sshTarget yet."
    }
    foreach ($forward in @($profile.forwards)) {
      $pidPath = Get-PidPath $name $forward.name
      if (Test-PidAlive $pidPath) {
        $pidText = (Get-Content $pidPath -Raw).Trim()
        Write-Host "[codex-remote] $name/$($forward.name) already running as pid $pidText"
        continue
      }
      $sshArgs = Get-SshBaseArgs $profile
      $sshArgs += @(
        '-N',
        '-L', "$($forward.localPort):$($forward.remoteHost):$($forward.remotePort)",
        $profile.sshTarget
      )
      Write-Host "[codex-remote] opening $name/$($forward.name): localhost:$($forward.localPort) -> $($forward.remoteHost):$($forward.remotePort)"
      if ($DryRun) {
        Write-Host "ssh $($sshArgs -join ' ')"
        continue
      }
      $proc = Start-Process -FilePath 'ssh.exe' -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
      Set-Content -Path $pidPath -Value $proc.Id
    }
  }
  exit 0
}

if ($Action -eq 'status') {
  foreach ($name in $serverNames) {
    $profile = $tunnelConfig.servers.$name
    foreach ($forward in @($profile.forwards)) {
      $pidPath = Get-PidPath $name $forward.name
      if (Test-PidAlive $pidPath) {
        $pidText = (Get-Content $pidPath -Raw).Trim()
        Write-Host "[codex-remote] $name/$($forward.name) running pid=$pidText localhost:$($forward.localPort)"
      } else {
        Write-Host "[codex-remote] $name/$($forward.name) stopped localhost:$($forward.localPort)"
      }
    }
  }
  exit 0
}

if ($Action -eq 'stop') {
  foreach ($name in $serverNames) {
    $profile = $tunnelConfig.servers.$name
    foreach ($forward in @($profile.forwards)) {
      $pidPath = Get-PidPath $name $forward.name
      if (Test-PidAlive $pidPath) {
        $pidText = (Get-Content $pidPath -Raw).Trim()
        Write-Host "[codex-remote] stopping $name/$($forward.name) pid=$pidText"
        if (!$DryRun) {
          Stop-Process -Id ([int]$pidText)
          Remove-Item $pidPath -Force
        }
      } elseif (Test-Path $pidPath) {
        Remove-Item $pidPath -Force
      }
    }
  }
  exit 0
}

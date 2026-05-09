param(
  [ValidateSet('ssh-key', 'tailscale')]
  [string]$Mode = 'ssh-key',

  [string]$KeyPath = "$HOME\.ssh\codex_desktop_remote_ed25519",

  [string]$User = 'root',

  [string]$TailscaleAuthKey = '',

  [string]$TailscaleHostnamePrefix = 'kimibuilt',

  [string]$OnboardPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bootstrapPath = Join-Path $repoRoot 'scripts/codex-remote-server-bootstrap.sh'

if (!(Test-Path "$KeyPath.pub")) {
  powershell -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts/codex-remote-key-bootstrap.ps1') | Out-Host
}

$publicKey = (Get-Content "$KeyPath.pub" -Raw).Trim()
$publicIp = ''
try {
  $publicIp = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 8).Trim()
} catch {
  Write-Warning "Could not detect this computer's public IP automatically. You can still use VPN mode or fill CODEX_ALLOW_IP manually."
}

$encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content $bootstrapPath -Raw)))
$encodedKey = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($publicKey))
if (!$OnboardPhrase) {
  $randomBytes = New-Object byte[] 9
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($randomBytes)
  } finally {
    $rng.Dispose()
  }
  $OnboardPhrase = 'codex-onboard-' + ([BitConverter]::ToString($randomBytes) -replace '-', '').ToLowerInvariant()
}

Write-Host ""
Write-Host "[codex-access] Public key:"
Write-Host $publicKey
if ($publicIp) {
  Write-Host ""
  Write-Host "[codex-access] This computer's current public IP:"
  Write-Host $publicIp
}

Write-Host ""
Write-Host "[codex-access] Server bootstrap command template."
Write-Host "Run once on each server, or paste into your Git/cloud-init deployment step:"
Write-Host ""

if ($Mode -eq 'tailscale') {
  if (!$TailscaleAuthKey) {
    Write-Host "TAILSCALE_AUTH_KEY='tskey-auth-REPLACE_ME' \"
  } else {
    Write-Host "TAILSCALE_AUTH_KEY='$TailscaleAuthKey' \"
  }
  Write-Host "TAILSCALE_HOSTNAME='$TailscaleHostnamePrefix-REPLACE_WITH_SERVER_NAME' \"
} elseif ($publicIp) {
  Write-Host "CODEX_ALLOW_IP='$publicIp' \"
}

Write-Host "CODEX_ONBOARD_PHRASE='$OnboardPhrase' \"
Write-Host "CODEX_USER='$User' \"
Write-Host "CODEX_PUBLIC_KEY=`$(printf '%s' '$encodedKey' | base64 -d) \"
Write-Host "sh -c `"`$(printf '%s' '$encodedScript' | base64 -d)`""

Write-Host ""
Write-Host "[codex-access] Onboard phrase to verify later:"
Write-Host $OnboardPhrase
Write-Host ""
Write-Host "[codex-access] After both servers run it, test from Codex Desktop:"
Write-Host "powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline"

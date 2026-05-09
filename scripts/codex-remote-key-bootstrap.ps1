param(
  [string]$KeyPath = "$HOME\.ssh\codex_desktop_remote_ed25519",
  [string]$Comment = "codex-desktop-remote"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sshDir = Split-Path -Parent $KeyPath
if (!(Test-Path $sshDir)) {
  New-Item -ItemType Directory -Path $sshDir | Out-Null
}

if (!(Test-Path $KeyPath)) {
  $escapedKeyPath = $KeyPath.Replace('"', '\"')
  $escapedComment = $Comment.Replace('"', '\"')
  cmd.exe /c "ssh-keygen.exe -t ed25519 -f `"$escapedKeyPath`" -C `"$escapedComment`" -N `"`""
  if ($LASTEXITCODE -ne 0) {
    throw "ssh-keygen failed with exit code $LASTEXITCODE"
  }
} else {
  Write-Host "[codex-key] Key already exists: $KeyPath"
}

$publicKeyPath = "$KeyPath.pub"
if (!(Test-Path $publicKeyPath)) {
  throw "Public key was not created: $publicKeyPath"
}

$publicKey = (Get-Content $publicKeyPath -Raw).Trim()

Write-Host ""
Write-Host "[codex-key] Public key:"
Write-Host $publicKey
Write-Host ""
Write-Host "[codex-key] On each remote server, log in once with the password and run:"
Write-Host "mkdir -p ~/.ssh && chmod 700 ~/.ssh"
Write-Host "printf '%s\n' '$publicKey' >> ~/.ssh/authorized_keys"
Write-Host "chmod 600 ~/.ssh/authorized_keys"
Write-Host ""
Write-Host "[codex-key] Then set each server profile in local/remote-tunnels.local.json:"
Write-Host '"identityFile": "C:\\Users\\phill\\.ssh\\codex_desktop_remote_ed25519"'
Write-Host ""
Write-Host "[codex-key] Test after both servers are updated:"
Write-Host "powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline"

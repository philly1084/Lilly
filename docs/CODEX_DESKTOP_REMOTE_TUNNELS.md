# Codex Desktop Remote Tunnels

This repo includes a small local-only helper for Codex Desktop sessions that need SSH-backed access to the two KimiBuilt remote servers while programming locally.

The helper does not store passwords, kubeconfigs, or tokens. It expects Windows OpenSSH to use your normal SSH agent, key files, or existing host aliases.

## One-time setup

Create the ignored local config:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action init
```

Create a permanent local Codex Desktop SSH key:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-key-bootstrap.ps1
```

The script prints one public key and the exact three remote commands to run after you log in to each server once with a password. After both servers trust the key, this bootstrap script is no longer needed and can be deleted in a cleanup update.

For the lowest-effort remote bootstrap, generate a one-shot server command instead:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-access-pack.ps1 -Mode ssh-key -User root
```

That prints this computer's current public IP when available and a base64-packed server bootstrap command. You can run that command once on each server, or place it in a Git/cloud-init/deploy step that executes on the server.
It also prints a disposable onboard phrase and writes it to `~/.ssh/codex_onboard_phrase` on the server so Codex can verify that the expected bootstrap ran.

For VPN mode, create a reusable Tailscale auth key in the Tailscale admin console, then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-access-pack.ps1 -Mode tailscale -User root -TailscaleAuthKey "tskey-auth-..."
```

VPN mode is the cleanest long-term option because it avoids depending on this computer's changing public IP and lets the servers join a private network with stable Tailscale names.

Edit `local/remote-tunnels.local.json`:

- Set `servers.primary.sshTarget` to the first server, such as `root@168.119.176.121` or an SSH config alias.
- Set `servers.secondary.sshTarget` to the second server.
- Set `identityFile` to `C:\\Users\\phill\\.ssh\\codex_desktop_remote_ed25519` unless the normal SSH agent/config is enough.
- Adjust local ports if they collide with another process.

The local config is gitignored. Keep secrets out of it.

## Baseline both servers

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline
```

This runs the standard KimiBuilt host baseline and a read-only k3s node check where available.

If this fails with `Permission denied (publickey,password)`, load or install a key that the remote server already trusts. If it fails with `invalid format`, the file is probably not an OpenSSH private key and should be converted or replaced rather than committed or pasted here.

## Run a bounded command

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action run -Server primary -Command "kubectl get pods -A -o wide"
```

Use this for SSH-like testing from Codex without opening an interactive shell.

## Open local forwards

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action tunnel -Server all
```

Default example forwards:

| Server | Local URL | Remote target |
| --- | --- | --- |
| primary | `http://localhost:33001` | `kimibuilt/backend:3000` |
| primary | `http://localhost:33080` | `kimibuilt/frontend:80` |
| secondary | `http://localhost:33002` | `kimibuilt/backend:3000` |
| secondary | `http://localhost:33082` | `kimibuilt/frontend:80` |
| secondary | `http://localhost:33083` | `agent-platform/gitlab-http:80` |

Check or stop tunnels:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action status
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action stop -Server all
```

## Safety notes

- Use `baseline` first when switching servers.
- Do not place passwords, API keys, kubeconfigs, or GitLab tokens in the tunnel config.
- Prefer GitLab-observable deploy paths for real releases, then use these tunnels for live checks and recovery.
- Treat public endpoint checks plus local tunnel checks as separate evidence.

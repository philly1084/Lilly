# Codex Desktop Remote Tunnels

This repo includes a small local-only helper for Codex Desktop sessions that need SSH-backed access to the two KimiBuilt remote servers while programming locally.

The helper does not store passwords, kubeconfigs, or tokens. It expects Windows OpenSSH to use your normal SSH agent, key files, or existing host aliases.

## One-time setup

Create the ignored local config:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action init
```

Edit `local/remote-tunnels.local.json`:

- Set `servers.primary.sshTarget` to the first server, such as `root@168.119.176.121` or an SSH config alias.
- Set `servers.secondary.sshTarget` to the second server.
- Set `identityFile` only if the normal SSH agent/config is not enough.
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
| primary | `http://localhost:33001` | `127.0.0.1:3000` |
| primary | `http://localhost:33081` | `127.0.0.1:80` |
| secondary | `http://localhost:33002` | `127.0.0.1:3000` |

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

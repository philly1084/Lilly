# KimiBuilt Remote Ops

Codex Desktop workflow plugin for the two KimiBuilt remote k3s servers.

This plugin intentionally does not store secrets. It uses the repo-level scripts:

- `scripts/codex-remote-tunnel.ps1`
- `scripts/codex-remote-access-pack.ps1`
- `scripts/codex-remote-server-bootstrap.sh`

The private server config stays in `local/remote-tunnels.local.json`, which is gitignored.

## Current Targets

| Name | SSH target | Default local forwards |
| --- | --- | --- |
| `primary` | `root@168.119.176.121` | `localhost:33001 -> kimibuilt/backend:3000`, `localhost:33080 -> kimibuilt/frontend:80` |
| `secondary` | `root@162.55.163.199` | `localhost:33002 -> kimibuilt/backend:3000`, `localhost:33082 -> kimibuilt/frontend:80`, `localhost:33083 -> agent-platform/gitlab-http:80` |

## Quick Checks

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action tunnel -Server all
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action status
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action stop
```

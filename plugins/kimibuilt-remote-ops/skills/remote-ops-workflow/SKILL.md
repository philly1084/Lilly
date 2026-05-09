---
name: remote-ops-workflow
description: Use the proven Codex Desktop SSH tunnel and k3s workflow for the two KimiBuilt remote servers, including baseline checks, local forwards, live endpoint testing, rollout verification, and onboarding cleanup.
---

Use this skill when the user asks Codex to work with, test, deploy to, SSH into, tunnel to, or inspect the two KimiBuilt remote servers from Codex Desktop.

## Server Targets

The repo-local tunnel config is `local/remote-tunnels.local.json`.

Default targets:

- `primary`: `root@168.119.176.121`
- `secondary`: `root@162.55.163.199`

Do not assume these are current if the user gives fresh IPs. Update the ignored local config and the checked-in example only when the target set is meant to become the new default.

## First Move

Always run a read-only baseline before changing anything:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline
```

If only one server matters, scope it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline -Server primary
```

## Remote Commands

Use bounded non-interactive commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action run -Server primary -Command "kubectl get pods -A -o wide"
```

Prefer small command batches: baseline, inspect, fix, verify.

## Tunnels

Open local forwards:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action tunnel -Server all
```

Check/stop them:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action status
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action stop -Server all
```

Default local URLs:

- primary backend: `http://localhost:33001`
- primary frontend: `http://localhost:33080`
- secondary backend: `http://localhost:33002`
- secondary frontend: `http://localhost:33082`
- secondary GitLab HTTP: `http://localhost:33083`

Use browser or Playwright checks against local tunnel URLs when testing UI behavior from Codex Desktop.

The forwards target current k3s ClusterIP services. If a service is recreated or the tunnel stops reaching it, refresh the IPs with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action run -Server primary -Command "kubectl get svc -A -o wide | grep -E 'kimibuilt|gitlab|traefik|NAME'"
```

## Live k3s Proof

For deploy verification, do not stop at "pods are ready." Gather the source-to-public chain:

1. Git state or commit being deployed.
2. Build or image tag/digest evidence.
3. k3s rollout and pod image evidence.
4. In-cluster probe when useful.
5. Public endpoint or tunneled endpoint response.

Useful commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action run -Server primary -Command "kubectl get pods -A -o wide"
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action run -Server primary -Command "kubectl get deploy -A -o wide"
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action run -Server primary -Command "kubectl get events -A --sort-by=.lastTimestamp | tail -80"
```

## Onboarding Cleanup

If the temporary Rancher/kubectl onboarding DaemonSet was used, remove it after SSH is proven:

```bash
kubectl delete namespace codex-onboard
```

To verify the disposable phrase through SSH before cleanup:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action run -Server all -Command "cat ~/.ssh/codex_onboard_phrase"
```

The permanent key is `C:\Users\phill\.ssh\codex_desktop_remote_ed25519`; do not print or commit the private key.

## Safety

- Never put passwords, API keys, kubeconfigs, or GitLab tokens in plugin files or tunnel config.
- Ask before destructive actions such as deleting namespaces, pruning images, mutating secrets, or force-restarting shared services.
- Treat primary and secondary as separate servers. Re-baseline when switching targets.
- Prefer GitLab-observable deploy paths when the user cares about webpage/CI observability.

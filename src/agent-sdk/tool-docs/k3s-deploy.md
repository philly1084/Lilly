# k3s-deploy

Purpose: run restricted k3s deployment actions through the remote runner when available, falling back to SSH against the configured server.

Lane boundary: `k3s-deploy` is the deploy-only lane in the remote operations system. Use `remote-cli-agent` for GitLab-backed source/build/deploy loops and remote authoring/build/test/deploy/verify loops, `managed-app` only for explicit managed-app control-plane actions, `remote-workbench` for structured remote repo/file/build/test/log/rollout actions, and `remote-command` for direct inspection, `kubectl describe`, logs, and HTTPS verification. Use `git-safe` for repository save/push work and `k3s-deploy` only when deployment is the next planned step.

Short picker: read `src/agent-sdk/tool-docs/remote-tools.md` when choosing between `managed-app`, `remote-cli-agent`, `remote-command`, `remote-workbench`, and `k3s-deploy`.

Repository sync supports GitHub clone URLs and the configured Git provider host. For generated k3s websites/apps, prefer the configured GitLab repository as the editable source of truth; at minimum, deploy from a git-backed remote workspace and commit changes before running this tool.

Allowed actions:
- `sync-repo`
- `apply-manifests`
- `set-image`
- `rollout-status`
- `sync-and-apply`

If `action` is omitted and the other params clearly imply a deploy shape, the tool infers a safe default:
- `image` -> `set-image`
- repo/ref/target directory -> `sync-and-apply`
- manifests path only -> `apply-manifests`
- deployment/namespace only -> `rollout-status`
- otherwise -> `sync-and-apply`

Admin-backed defaults:
- repository URL
- branch
- remote target directory
- manifests path
- namespace
- deployment
- container
- public domain
- ingress class
- TLS `ClusterIssuer`

If no public domain is configured in Admin Settings, the backend falls back to `demoserver2.buzz`.

## When to use it

Use `k3s-deploy` for the standard deploy lane:
1. sync the repo checkout onto the remote host
2. apply Kubernetes manifests from the repo
3. optionally set a new image tag
4. check rollout status

Use `remote-command` instead when you need:
- `kubectl describe`
- `kubectl logs`
- host networking checks
- DNS or TLS verification
- package installs
- one-off server fixes

## Main flow

Preferred GitOps-style sequence:

1. Author or update code locally or through the remote CLI lane.
2. Create or update Dockerfile and manifests in the repo if the app is not deployable yet.
3. Push code or image changes through the normal repo flow.
4. Run `k3s-deploy sync-and-apply`.
5. Run `remote-command` to verify ingress, TLS, DNS, and public HTTPS.

For route creation or route changes, use `node bin/kimibuilt-ingress.js` through `remote-command` after the workload Service exists. It is the guarded path for this cluster's Traefik, cert-manager, Let's Encrypt, and `demoserver2.buzz` wildcard DNS setup. It emits registry events so later agents know which host/path points to which Service.

## What this tool does not do

- It does not build container images.
- It does not invent manifests for an app that has none yet.
- It does not configure your DNS registrar.
- It does not replace `kubectl describe` or `kubectl logs` for incident debugging.

If the app still needs containerization, create the Dockerfile and Kubernetes manifests first, then deploy them with this tool.

## Typical actions

Sync repo and apply manifests:

```json
{
  "action": "sync-and-apply",
  "repositoryUrl": "https://github.com/philly1084/KimiBuilt.git",
  "ref": "master",
  "targetDirectory": "/opt/kimibuilt",
  "manifestsPath": "k8s",
  "namespace": "kimibuilt",
  "deployment": "backend"
}
```

Roll a new image tag:

```json
{
  "action": "set-image",
  "namespace": "kimibuilt",
  "deployment": "backend",
  "container": "backend",
  "image": "ghcr.io/philly1084/kimibuilt:sha-1234567"
}
```

Check rollout only:

```json
{
  "action": "rollout-status",
  "namespace": "kimibuilt",
  "deployment": "backend"
}
```

## Good operating rules

- Prefer a healthy remote runner for deploy operations; keep SSH as the fallback and recovery path.
- Prefer repo-managed manifests over ad hoc live-cluster mutation.
- Do not deploy one-off website files that are not committed somewhere. If the workspace is missing git history, initialize or clone the repository before rollout.
- Treat the Admin deploy defaults as fallbacks, not proof that the cluster currently matches them.
- The runtime keeps a persistent cluster registry from verified remote tool runs. Use it as durable context for host names, domains, deployment names, and previously discovered paths, but still re-verify before claiming the site is live.
- Use `kimibuilt-ingress` for Ingress/TLS route changes. Do not hand-write nginx Ingress manifests for this k3s cluster.
- After a failed deploy, switch to `remote-command` for `kubectl describe`, `kubectl logs`, or host-level investigation.
- If `kubectl` context looks wrong on the host, try `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml` or `k3s kubectl`.
- For public website deploys, do not claim success until rollout, ingress, TLS, and external HTTPS all verify.

## Related docs

- Remote command catalog: `src/agent-sdk/tool-docs/remote-command.md`
- Project playbook: `k8s/K3S_RANCHER_PLAYBOOK.md`

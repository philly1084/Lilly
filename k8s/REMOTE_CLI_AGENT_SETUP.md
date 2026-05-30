# Remote CLI Agent Setup

The backend reads Remote CLI Agent settings from:

- ConfigMap: `kimibuilt-config`
- Secret: `kimibuilt-secrets`
- Namespace: normally `kimibuilt`

The default transport is the legacy MCP `remote_code_run/status` lane:

- ConfigMap: `REMOTE_CLI_AGENT_TRANSPORT=mcp`
- ConfigMap: `REMOTE_CLI_MCP_URL` with the gateway MCP URL ending in `/mcp`
- Secret: `REMOTE_CLI_MCP_BEARER_TOKEN` or `N8N_API_KEY`

The `nuts` Codex-agent SSE API remains available for explicit opt-in:

- ConfigMap: `REMOTE_CLI_AGENT_TRANSPORT=codex-agent`
- ConfigMap: `REMOTE_CLI_CODEX_AGENT_BASE_URL` with the gateway base URL, without `/mcp`
- ConfigMap: `REMOTE_CLI_CODEX_AGENT_WORKSPACE_PATH` with the allowed workspace path
- Secret: `REMOTE_CLI_CODEX_AGENT_BEARER_TOKEN`, `FRONTEND_API_KEY`, or a compatible gateway key

## One-command setup

From this repository:

```powershell
npm run k8s:setup-remote-cli-agent
```

The script:

- detects the KimiBuilt namespace from the active kube context
- creates or patches `kimibuilt-config`
- creates or patches `kimibuilt-secrets`
- restarts `deployment/backend`
- waits for rollout unless `-NoRestart` is passed

It reads values from the current process environment first, then `.env`.

Useful overrides:

```powershell
powershell -ExecutionPolicy Bypass -File k8s/setup-remote-cli-agent.ps1 `
  -Namespace kimibuilt `
  -RemoteCliAgentTransport "mcp" `
  -RemoteCliCodexAgentBaseUrl "http://n8n-openai-cli-gateway.n8n-openai-gateway.svc.cluster.local" `
  -RemoteCliCodexAgentWorkspacePath "/srv/apps/my-app" `
  -RemoteCliCodexAgentBearerToken $env:FRONTEND_API_KEY
```

If no KimiBuilt namespace is found, the script stops instead of creating
resources in the wrong cluster. Pass `-CreateNamespace` only after confirming the
current kube context is the target cluster.

## Admin Deployment Mode

For remote software deployments that should really change and deploy an app,
configure the gateway with the admin scope:

```bash
REMOTE_CLI_TOOL_AUTH_SCOPES=n8n,frontend,admin
```

KimiBuilt will pass `adminMode: true` to `remote-cli-agent` for scoped
app/site/service authoring and deployment loops. The remote agent may then use
the configured admin-capable CLI runner or target for repo edits, builds, image
pushes, Kubernetes rollout, ingress/TLS, and verification. This is still bounded:
do not grant broad root access when narrow runner permissions or sudoers rules
are enough, and blocked privileged commands should be reported instead of
retried repeatedly.

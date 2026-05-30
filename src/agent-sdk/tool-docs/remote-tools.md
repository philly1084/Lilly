# remote tools

Purpose: choose the correct remote execution lane without confusing the outer KimiBuilt tools with transport internals.

Use this first when a task mentions remote servers, remote CLI, remote agents, k3s, Kubernetes, deployment, public URLs, or live website/app changes.

## Remote Tool Decision Map

| User intent | Use | Do not use |
|-------------|-----|------------|
| "Use the remote cli agent", "remote coding agent", "assisted cli", `remote_code_run`, or a remote app/site/service needs source changes plus build/deploy/verify | `remote-cli-agent` | `remote-command` as the main authoring loop |
| Quick host or cluster inspection: baseline, `kubectl get/describe/logs`, service status, DNS/TLS check, one-off repair, post-deploy verification | `remote-command` | local shell, code sandbox, raw legacy SSH first |
| Structured remote repo/file/build/test/log/rollout action exists | `remote-workbench` | hand-written shell that duplicates the structured action |
| Standard deploy from an existing repo/manifests/image: sync repo, apply manifests, set image, rollout status | `k3s-deploy` | `k3s-deploy` for image builds, authoring new manifests, logs, or HTTPS checks |
| Local preview or generated artifact before it is deployed | `code-sandbox` or `document-workflow` sandbox mode | remote tools unless the user asks to publish/promote/live-deploy |

## Call Shape Cheat Sheet

Outer KimiBuilt tool call for the remote coding agent:

```json
{
  "tool": "remote-cli-agent",
  "params": {
    "task": "Build/fix/deploy the app and verify the public URL.",
    "adminMode": true,
    "targetId": "prod",
    "cwd": "/srv/apps/my-app",
    "workspacePath": "/srv/apps/my-app",
    "transport": "mcp",
    "waitMs": 30000,
    "sessionId": "optional prior remote coding session",
    "threadId": "optional prior Codex thread",
    "mcpSessionId": "optional prior MCP session"
  }
}
```

Outer KimiBuilt tool call for direct remote inspection:

```json
{
  "tool": "remote-command",
  "params": {
    "command": "hostname && whoami && uname -m && uptime",
    "profile": "inspect"
  }
}
```

Preferred gateway transport used by `remote-cli-agent`:

```text
POST /api/codex-agent/run
GET /api/codex-agent/runs/:runId/events
```

Legacy MCP calls used by `remote-cli-agent` only:

```text
remote_code_run({ "targetId": "prod", "cwd": "/srv/apps/my-app", "task": "clear task", "waitMs": 30000 })
remote_code_status({ "jobId": "returned job id only" })
```

Important boundary:
- The planner calls `remote-cli-agent`; it does not call transport internals directly.
- The default runner transport calls `remote_code_run` through MCP and then `remote_code_status`.
- The codex-agent opt-in transport calls `/api/codex-agent/run` and streams `/events` SSE.
- Never put `command`, `args`, `executable`, or `shell` in `remote-cli-agent` params.
- Never put `targetId`, `cwd`, `sessionId`, or `waitMs` in `remote_code_status`; it accepts `jobId` only.

## Failure Rules

- If `remote-cli-agent` emits `USER_INPUT_REQUIRED=<question/options>`, forward that exact concise choice to the user and continue the same `sessionId`/`mcpSessionId` after the answer.
- If the same blocked command, sudo/root policy error, credential error, or missing runner capability happens twice without a changed strategy, stop the loop and report the blocker plus the next distinct recovery path.
- If a raw MCP fallback returns `status=running`, poll `remote_code_status` with the returned job id until terminal or until the configured poll limit is reached.
- If a remote build needs GitLab observability but credentials/API access are missing, report the missing automation piece instead of silently pretending direct BuildKit/kubectl is the same lane.
- For k3s YAML failures such as strict decoding errors or `unknown flag: --add`, switch to repo manifests, `kubectl create ... --dry-run=client -o yaml | kubectl apply -f -`, `kubectl set volume --add`, or the documented ingress helper.

## Completion Proof

Remote software work is incomplete until the report includes proof markers:

```text
WHAT_CHANGED=<source/config/deploy summary>
VERIFY_COMMANDS=<command or check>
VERIFY_RESULTS=<pass/fail/blocked result>
PUBLIC_URL=<https URL or not_available>
BLOCKER=<none or exact blocker>
```

Continuity markers should be included when known:

```text
REMOTE_CLI_SESSION_ID=...
WORKSPACE=...
GIT_REPO=...
GIT_BRANCH=...
GIT_BASE_COMMIT=...
GIT_COMMIT=...
CHANGED_FILES=...
DEPLOYMENT=...
PUBLIC_HOST=...
UI_CHECK_REPORT=...
UI_SCREENSHOTS=...
```

## Good References

- `src/agent-sdk/tool-docs/remote-cli-agent.md`
- `src/agent-sdk/tool-docs/remote-command.md`
- `src/agent-sdk/tool-docs/remote-workbench.md`
- `src/agent-sdk/tool-docs/k3s-deploy.md`
- `k8s/K3S_RANCHER_PLAYBOOK.md`

# remote tools

Purpose: choose the correct lane in the unified remote operations system without confusing the outer KimiBuilt tools with transport internals.

Use this first when a task mentions remote servers, remote CLI, remote agents, k3s, Kubernetes, deployment, public URLs, or live website/app changes.

## Remote Tool Decision Map

Think of KimiBuilt remote access as one tool family with five lanes: `managed-app`, `remote-cli-agent`, `remote-command`, `remote-workbench`, and `k3s-deploy`. The planner should choose the lane by intent, while `remote-cli-agent` itself chooses the transport: Codex-agent `/run` + `/events` whenever configured, MCP `remote_code_*` only for explicit legacy transport requests.

| User intent | Use | Do not use |
|-------------|-----|------------|
| Create, edit, build, deploy, or verify a GitLab-backed managed app or public app/site on `demoserver2.buzz` | `managed-app create` or `managed-app iterate`; use `executor: "remote-cli-agent"` only as the worker for complex repo/CLI work | standalone `remote-cli-agent`, `remote-command`, or direct k3s edits as the product loop |
| "Use the remote cli agent", "remote coding agent", "assisted cli", `remote_code_run`, or a remote app/site/service needs source changes plus build/deploy/verify | `remote-cli-agent` | `remote-command` as the main authoring loop |
| "Ask Codex for help", "Codex help", or "use Codex for this" for deeper document creation, synthesis, or build work on the main KimiBuilt server | `remote-cli-agent` with the configured Codex-agent defaults, normally `targetId: "k3s-prod"` and `cwd: "/opt/kimibuilt"` | direct `remote-command`, local sandbox-only generation, or the secondary/demo-server lane unless explicitly requested |
| Quick host or cluster inspection: baseline, `kubectl get/describe/logs`, service status, DNS/TLS check, one-off repair, post-deploy verification | `remote-command` | local shell, code sandbox, raw legacy SSH first |
| Structured remote repo/file/build/test/log/rollout action exists | `remote-workbench` | hand-written shell that duplicates the structured action |
| Standard deploy from an existing repo/manifests/image: sync repo, apply manifests, set image, rollout status | `k3s-deploy` | `k3s-deploy` for image builds, authoring new manifests, logs, or HTTPS checks |
| Local preview or generated artifact before it is deployed | `code-sandbox` or `document-workflow` sandbox mode | remote tools unless the user asks to publish/promote/live-deploy |

Registered skill: `remote-operations-system` is the compact skill-style version of this lane picker. When matched, preserve its inventory gate, lane boundaries, proof loop, and failure handling while selecting concrete tool calls.

## Pre-Create Inventory Gate

Before creating a remote website, app, dashboard, service, GitLab project, namespace, or public host, check whether it already exists. Inspect managed-app records, configured GitLab projects, continuity/project registry facts, and live k3s namespaces/services/ingresses for matching name, slug, repo, namespace, domain, or purpose.

Reuse or iterate an existing match. Ask the user when the match is ambiguous. Create a new project only after the inventory shows no match or the user explicitly asks for a separate new project.

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
    "transport": "codex-agent",
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

Router implementation shape, as used by the `nuts` gateway:
- `/api/codex-agent/run` validates bearer or API-key auth, validates `workspacePath` against `CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS`, starts `codex app-server --listen stdio://`, and starts a turn in that workspace.
- `/api/codex-agent/runs/:runId/events` is the live communication channel. It streams `session_started`, `output`, and exactly one terminal event: `turn_completed`, `turn_failed`, `turn_cancelled`, or `turn_input_required`.
- The returned `threadId` is the durable continuation handle for future Codex-agent turns. Preserve it as `threadId`/`REMOTE_CLI_SESSION_ID` instead of inventing a separate polling session.
- If the CLI agent returns `SUPPORT_AGENT_REQUIRED` plus `SUPPORT_AGENT_CONTEXT`, run or ask a support agent for that bounded help request, then continue `remote-cli-agent` with the same `threadId` and `supportAgentResponse`. Do not turn support-agent requests into user questions unless the support request itself needs user-only information.
- In this lane, `localhost` and `127.0.0.1` are loopback inside the remote gateway runner, not the user's desktop and not the public app. Verify live remote work through the named public host, Kubernetes service DNS, or `kubectl` in the target namespace unless the task explicitly asks for a local dev-server check.
- Approval and user-input prompts are denied and converted into `turn_input_required`, so the outer KimiBuilt agent can ask the user once and continue the same run/thread.

Legacy MCP calls used by `remote-cli-agent` only:

```text
remote_code_run({ "targetId": "prod", "cwd": "/srv/apps/my-app", "task": "clear task", "waitMs": 30000 })
remote_code_status({ "jobId": "returned job id only" })
```

Important boundary:
- Managed-app is the owner for GitLab-backed app source/build/deploy loops. When it needs deeper CLI help, call `managed-app iterate` with `executor: "remote-cli-agent"` so GitLab commits, pipeline/image evidence, rollout evidence, and public verification stay attached to the managed-app run.
- The planner calls `remote-cli-agent`; it does not call transport internals directly.
- The default runner transport calls `/api/codex-agent/run` and streams `/events` SSE.
- The MCP compatibility transport calls `remote_code_run` through MCP and then `remote_code_status`.
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

## Continuity Registry

- The remote tool family records reusable project facts in the cluster continuity registry when proof markers are returned: repo, workspace, deployment, public host, commit, changed files, verification results, and UI check artifacts.
- `remote-cli-agent` receives a bounded continuity brief before each run. Treat it as candidate context and match by explicit repo, workspace, deployment, namespace, domain, or target before editing.
- Same-session `REMOTE_CLI_SESSION_ID` and workspace reuse is for continuation tasks only. If the user names a different domain, repo, or workspace, inspect that project instead of carrying over the old one.

## Good References

- `data/skills/remote-operations-system/SKILL.md`
- `src/agent-sdk/tool-docs/managed-app.md`
- `src/agent-sdk/tool-docs/remote-cli-agent.md`
- `src/agent-sdk/tool-docs/remote-command.md`
- `src/agent-sdk/tool-docs/remote-workbench.md`
- `src/agent-sdk/tool-docs/k3s-deploy.md`
- `k8s/K3S_RANCHER_PLAYBOOK.md`

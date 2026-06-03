# Remote Tools

GREP_HANDLES: AGENT_DOC REMOTE_TOOLS REMOTE_CLI_AGENT REMOTE_COMMAND REMOTE_WORKBENCH K3S_DEPLOY REMOTE_CODE_RUN USER_INPUT_REQUIRED DEPLOY_PROOF

Use when:
- A user asks for remote CLI, remote agents, server work, k3s, deployment, a public URL, or live app/site changes.
- The planner is about to choose between `remote-cli-agent`, `remote-command`, `remote-workbench`, and `k3s-deploy`.
- An orchestrated agent leaked a transport-specific runner call, stalled polling, or turned a remote blocker into a questionnaire.

Small decision map:
- `managed-app`: GitLab-observable app/source/build/deploy loop. Use `managed-app create` for new managed apps and `managed-app iterate` for existing app changes; when deeper CLI work is needed, pass `executor:"remote-cli-agent"` so remote-cli-agent is a worker inside the managed-app evidence loop.
- `remote-cli-agent`: remote software author/build/deploy/verify loop. Use for app, website, service, dashboard, frontend, or game changes that must go live. Params use `task`, usually `adminMode:true`, plus optional `targetId`, `cwd` or `workspacePath`, `sessionId` or `threadId`, `mcpSessionId`, `waitMs`, and `transport`.
- `remote-command`: one direct remote command for inspect, logs, kubectl, network, DNS/TLS, one-off repair, or post-deploy verification. Params use `command`.
- `remote-workbench`: structured remote repo/file/build/test/log/rollout actions when a matching action exists.
- `k3s-deploy`: standard deploy-only lane for repo sync, manifest apply, image update, and rollout status after source/image/manifests already exist.

Boundary:
- Managed-app owns GitLab-backed app/product changes. Do not use standalone `remote-cli-agent`, `remote-command`, or direct k3s edits as the normal product loop when a managed app exists.
- The KimiBuilt planner calls `remote-cli-agent`; it does not call transport internals directly.
- Default transport: KimiBuilt calls `POST /api/codex-agent/run` and streams `GET /api/codex-agent/runs/:runId/events` from the `nuts` gateway when `REMOTE_CLI_AGENT_TRANSPORT=codex-agent`.
- MCP compatibility transport: the runner can still call `remote_code_run({ targetId, cwd, task, model?, sessionId?, waitMs? })` through MCP and poll `remote_code_status({ jobId })` with the job id only.
- Do not put raw shell fields like `command`, `args`, `shell`, or `executable` in `remote-cli-agent`.
- Do not collapse the explicit phrase "remote cli agent" into `remote-command`.

Remote completion proof:
- Require `WHAT_CHANGED`, `VERIFY_COMMANDS`, `VERIFY_RESULTS`, `PUBLIC_URL`, and `BLOCKER`.
- Keep continuity markers when known: `REMOTE_CLI_SESSION_ID`, `WORKSPACE`, `GIT_REPO`, `GIT_BRANCH`, `GIT_BASE_COMMIT`, `GIT_COMMIT`, `CHANGED_FILES`, `DEPLOYMENT`, `PUBLIC_HOST`, `UI_CHECK_REPORT`, `UI_SCREENSHOTS`.
- Forward `USER_INPUT_REQUIRED=<question/options>` to the user and continue the same session after the answer.
- Stop repeated blocked-command loops after two materially identical failures.

Continuity:
- Remote tool results are recorded in the cluster continuity registry with repo, workspace, deployment, public host, commit, changed files, and verification markers when tools return them.
- `remote-cli-agent` receives a bounded continuity brief on each run. Treat those facts as candidates, not permission to mutate the nearest old project: match by explicit repo, workspace, deployment, namespace, domain, or target before editing.
- Same-session `REMOTE_CLI_SESSION_ID`/workspace reuse is for continuation tasks only. If the user names a different domain, repo, or workspace, inspect that project instead of carrying over the old one.

Longer docs:
- `src/agent-sdk/tool-docs/remote-tools.md`
- `src/agent-sdk/tool-docs/remote-cli-agent.md`
- `src/agent-sdk/tool-docs/remote-command.md`
- `src/agent-sdk/tool-docs/k3s-deploy.md`

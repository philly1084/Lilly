# Remote Tools

GREP_HANDLES: AGENT_DOC REMOTE_TOOLS REMOTE_CLI_AGENT REMOTE_COMMAND REMOTE_WORKBENCH K3S_DEPLOY REMOTE_CODE_RUN USER_INPUT_REQUIRED DEPLOY_PROOF

Use when:
- A user asks for remote CLI, remote agents, server work, k3s, deployment, a public URL, or live app/site changes.
- The planner is about to choose between `remote-cli-agent`, `remote-command`, `remote-workbench`, and `k3s-deploy`.
- An orchestrated agent leaked a transport-specific runner call, stalled polling, or turned a remote blocker into a questionnaire.

Small decision map:
- `remote-cli-agent`: remote software author/build/deploy/verify loop. Use for app, website, service, dashboard, frontend, or game changes that must go live. Params use `task`, usually `adminMode:true`, plus optional `targetId`, `cwd` or `workspacePath`, `sessionId` or `threadId`, `mcpSessionId`, `waitMs`, and `transport`.
- `remote-command`: one direct remote command for inspect, logs, kubectl, network, DNS/TLS, one-off repair, or post-deploy verification. Params use `command`.
- `remote-workbench`: structured remote repo/file/build/test/log/rollout actions when a matching action exists.
- `k3s-deploy`: standard deploy-only lane for repo sync, manifest apply, image update, and rollout status after source/image/manifests already exist.

Boundary:
- The KimiBuilt planner calls `remote-cli-agent`; it does not call transport internals directly.
- Preferred transport: KimiBuilt calls `POST /api/codex-agent/run` and streams `GET /api/codex-agent/runs/:runId/events` SSE from the `nuts` gateway.
- Legacy MCP fallback: the runner calls `remote_code_run({ targetId, cwd, task, model?, sessionId?, waitMs? })` and polls `remote_code_status({ jobId })` with the job id only.
- Do not put raw shell fields like `command`, `args`, `shell`, or `executable` in `remote-cli-agent`.
- Do not collapse the explicit phrase "remote cli agent" into `remote-command`.

Remote completion proof:
- Require `WHAT_CHANGED`, `VERIFY_COMMANDS`, `VERIFY_RESULTS`, `PUBLIC_URL`, and `BLOCKER`.
- Keep continuity markers when known: `REMOTE_CLI_SESSION_ID`, `WORKSPACE`, `GIT_REPO`, `GIT_BRANCH`, `GIT_BASE_COMMIT`, `GIT_COMMIT`, `CHANGED_FILES`, `DEPLOYMENT`, `PUBLIC_HOST`, `UI_CHECK_REPORT`, `UI_SCREENSHOTS`.
- Forward `USER_INPUT_REQUIRED=<question/options>` to the user and continue the same session after the answer.
- Stop repeated blocked-command loops after two materially identical failures.

Longer docs:
- `src/agent-sdk/tool-docs/remote-tools.md`
- `src/agent-sdk/tool-docs/remote-cli-agent.md`
- `src/agent-sdk/tool-docs/remote-command.md`
- `src/agent-sdk/tool-docs/k3s-deploy.md`

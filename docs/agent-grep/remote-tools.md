# Remote Tools

GREP_HANDLES: AGENT_DOC REMOTE_TOOLS REMOTE_CLI_AGENT REMOTE_COMMAND REMOTE_WORKBENCH K3S_DEPLOY REMOTE_CODE_RUN USER_INPUT_REQUIRED DEPLOY_PROOF

Use when:
- A user asks for remote CLI, remote agents, server work, k3s, deployment, a public URL, or live app/site changes.
- The planner is about to choose between `managed-app`, `remote-cli-agent`, `remote-command`, `remote-workbench`, and `k3s-deploy`.
- An orchestrated agent leaked a transport-specific runner call, stalled polling, or turned a remote blocker into a questionnaire.

Small decision map:
- Unified remote-access model: treat these as one remote operations system with five lanes. Prefer the stateful Codex-agent SSE lane through `remote-cli-agent` for GitLab-backed source/build/deploy work and remote coding/build/deploy work, use `managed-app` only for explicit managed-app control-plane actions, use direct command/workbench/deploy lanes for narrow operations, and keep MCP `remote_code_*` only as compatibility transport inside `remote-cli-agent`.
- `managed-app`: explicit managed-app catalog/control-plane lane. Use `managed-app create`, `managed-app iterate`, `doctor`, or `reconcile` only when the user asks for managed-app operations; when deeper CLI work is needed, pass `executor:"remote-cli-agent"` so remote-cli-agent is a worker inside the managed-app evidence loop.
- `remote-cli-agent`: remote software author/build/deploy/verify loop. Use for app, website, service, dashboard, frontend, game, GitLab repo, pipeline, or registry-backed changes that must go live. Params use `task`, usually `adminMode:true`, plus optional `targetId`, `cwd` or `workspacePath`, `sessionId` or `threadId`, `waitMs`, `transport`, `artifactIds`/`contextFiles`, and `collectResultFiles`.
- `remote-command`: one direct remote command for inspect, logs, kubectl, network, DNS/TLS, one-off repair, or post-deploy verification. Params use `command`.
- `remote-workbench`: structured remote repo/file/build/test/log/rollout actions when a matching action exists.
- `k3s-deploy`: standard deploy-only lane for repo sync, manifest apply, image update, and rollout status after source/image/manifests already exist.
- Registered skill: `remote-operations-system` carries this lane picker as a reusable workflow contract. If it is matched, preserve its inventory gate, lane boundaries, and proof loop while choosing concrete tools.

Baseline-first:
- From Codex Desktop, use the KimiBuilt Remote Ops tunnel workflow before changing a remote server: `powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline`, scoped with `-Server primary` or `-Server secondary` when only one server matters.
- Keep `primary` and `secondary` evidence separate. Re-baseline when switching targets, label the server/namespace/deployment/public host in notes, and never use proof from one server as proof for the other.
- After a change, verify through the public host or a named KimiBuilt tunnel endpoint, not only through pod readiness or runner-local `localhost`.

Boundary:
- `remote-cli-agent` owns GitLab-backed app/product changes by default. Do not route to `managed-app` merely because the user mentioned GitLab, pipeline, registry, or runner; use `managed-app` only for explicit managed-app catalog/control-plane work.
- Before creating a new remote website/app/dashboard/service, GitLab project, namespace, or public host, inventory managed apps, GitLab projects, continuity/project registry facts, and live k3s namespaces/services/ingresses. Reuse/iterate a match, ask on ambiguity, and create only after no match is found or the user explicitly wants a separate new project.
- The KimiBuilt planner calls `remote-cli-agent`; it does not call transport internals directly.
- Default transport: KimiBuilt calls authenticated `POST /admin/remote-agent-tasks`, streams the returned same-origin task URL, and collects gateway-verified result files when `REMOTE_CLI_AGENT_TRANSPORT=provider-agent`. The active delivery router maps OpenAI/Codex and Kimi model families to their bounded CLI providers, stages operation-scoped handoff files, preserves supported provider `sessionId` values, and keeps the privileged task route cluster-internal. Grok compatibility is dormant and is not a delivery or acceptance lane.
- Direct Codex compatibility transport: explicitly setting `transport: "codex-agent"` uses `POST /api/codex-agent/run` plus its `/events` SSE route for environments that can safely run Codex app-server in the gateway pod.
- In Codex-agent transport, `localhost` and `127.0.0.1` are loopback inside the remote gateway runner, not the user's desktop and not the public app. Verify live remote work through the named public host, Kubernetes service DNS, or `kubectl` in the target namespace unless the task explicitly asks for a local dev-server check.
- MCP compatibility transport: the runner can still call `remote_code_run({ targetId, cwd, task, model?, sessionId?, waitMs? })` through MCP and poll `remote_code_status({ jobId })` with the job id only.
- Do not put raw shell fields like `command`, `args`, `shell`, or `executable` in `remote-cli-agent`.
- Do not collapse the explicit phrase "remote cli agent" into `remote-command`.
- For sandbox/design/document handoff, KimiBuilt owns session artifacts and lineage; `nuts` stages/collects the versioned files for Codex and Kimi. Use `RemoteAgentHandoff/v1`, require the router acknowledgment, and persist only authenticated `RemoteAgentResultFiles/v1` output. Do not build provider-specific frontend transfer tools.
- Handoff directories are operation-scoped under `.kimibuilt/agent-runs/<operationId>/`. V1 caps are 12 files, 4 MiB each, 6 MiB decoded total. Read-only/no-file calls must not dirty the workspace; MCP must reject file handoffs.

Remote completion proof:
- Require `WHAT_CHANGED`, `VERIFY_COMMANDS`, `VERIFY_RESULTS`, `PUBLIC_URL`, and `BLOCKER`.
- Keep continuity markers when known: `REMOTE_CLI_SESSION_ID`, `WORKSPACE`, `GIT_REPO`, `GIT_BRANCH`, `GIT_BASE_COMMIT`, `GIT_COMMIT`, `CHANGED_FILES`, `DEPLOYMENT`, `PUBLIC_HOST`, `UI_CHECK_REPORT`, `UI_SCREENSHOTS`, `RESULT_FILES_MANIFEST`, `SUPPORT_AGENT_REQUIRED`, `SUPPORT_AGENT_CONTEXT`.
- If the work touches web-chat, managed-app previews, generated HTML artifacts, TTS, document rendering, websites, dashboards, or frontend UI, success requires browser/Playwright proof or `kimibuilt-ui-check` evidence. If the proof cannot run, mark that as the blocker instead of claiming ready.
- If `SUPPORT_AGENT_REQUIRED=<request>` appears, get bounded support-agent help, then resume `remote-cli-agent` with the same provider `sessionId` (or direct-Codex `threadId`) and `supportAgentResponse`. This is not a user decision by default.
- Forward `USER_INPUT_REQUIRED=<question/options>` to the user and continue the same session after the answer.
- Stop repeated blocked-command loops after two materially identical failures.

Continuity:
- Remote tool results are recorded in the cluster continuity registry with repo, workspace, deployment, public host, commit, changed files, and verification markers when tools return them.
- `remote-cli-agent` receives a bounded continuity brief on each run. Treat those facts as candidates, not permission to mutate the nearest old project: match by explicit repo, workspace, deployment, namespace, domain, or target before editing.
- Same-session `REMOTE_CLI_SESSION_ID`/workspace reuse is for continuation tasks only. If the user names a different domain, repo, or workspace, inspect that project instead of carrying over the old one.

Longer docs:
- `data/skills/remote-operations-system/SKILL.md`
- `src/agent-sdk/tool-docs/managed-app.md`
- `src/agent-sdk/tool-docs/remote-tools.md`
- `src/agent-sdk/tool-docs/remote-cli-agent.md`
- `src/agent-sdk/tool-docs/remote-command.md`
- `src/agent-sdk/tool-docs/remote-workbench.md`
- `src/agent-sdk/tool-docs/k3s-deploy.md`

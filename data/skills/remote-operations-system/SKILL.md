Use this skill when a user asks about remote tools, remote server work, live app/site deployment, k3s, managed apps, remote CLI agents, remote workbench actions, public route proof, or when the planner must choose between the remote lanes.

Operating model:
- Treat `managed-app`, `remote-cli-agent`, `remote-command`, `remote-workbench`, and `k3s-deploy` as one remote operations system with lanes.
- Choose the lane by the task shape, then call only the concrete tool needed for the next effect.
- Keep transport internals hidden from the outer planner: the planner calls `remote-cli-agent`; `remote-cli-agent` chooses Codex-agent `/run` + `/events` or MCP `remote_code_run` / `remote_code_status` compatibility.
- Before creating a remote app, site, service, dashboard, GitLab project, namespace, or host, inventory managed-app records, GitLab projects, continuity registry facts, and live k3s resources. Reuse or iterate a match unless the user explicitly wants a separate new project.

Lane picker:
- `managed-app`: explicit managed-app catalog/control-plane lane. Use `create`, `iterate`, `doctor`, or `reconcile` only when the user asks for managed-app operations. For complex CLI work inside an explicitly selected managed app, call `iterate` with `executor: "remote-cli-agent"`.
- `remote-cli-agent`: remote software author/build/test/deploy/verify loop when a coding agent should work inside the remote workspace. This is also the default owner for GitLab repo, pipeline, registry, app/site/service, frontend, and live deploy work unless the user explicitly asks for managed-app control-plane operations. Params use `task`, usually `adminMode: true`, plus optional `targetId`, `cwd` or `workspacePath`, `sessionId` or `threadId`, `mcpSessionId`, `waitMs`, and `transport`.
- Codex help lane: phrases such as "ask Codex for help", "Codex help", or "use Codex for this" mean `remote-cli-agent` for deeper document creation, synthesis, or build work on the configured main Codex-agent workspace, normally `targetId: "k3s-prod"` and `cwd: "/opt/kimibuilt"`.
- `remote-workbench`: structured remote repo/file/build/test/log/rollout actions when a matching action exists, such as git snapshot, apply patch, file read/write, build, test, logs, rollout, or verify.
- `remote-command`: one direct non-interactive remote command for baseline, inspection, logs, kubectl, service status, network, DNS/TLS, one-off repair, or post-deploy verification.
- `k3s-deploy`: standard deploy-only lane for repo sync, manifest apply, image update, and rollout status after the repo/manifests/image/deployment target are known.

Boundaries:
- Do not put `command`, `args`, `shell`, or `executable` in `remote-cli-agent` params.
- Do not use `remote-command` as the main authoring loop for app/site/service changes that need source edits plus build/deploy/verify.
- Do not use `k3s-deploy` to author new manifests, build images, inspect logs, or create HTTPS routes; use the appropriate remote lane first.
- Do not route to managed-app merely because GitLab, pipeline, registry, or runner is mentioned. Use managed-app only for explicit managed-app control-plane work; otherwise let remote-cli-agent use GitLab as part of its source/build/deploy loop.

Proof loop:
1. Resolve the owning app/repo/workspace/domain/namespace from session state, managed-app catalog, artifact metadata, cluster registry, or explicit user text.
2. Inspect before mutating. Confirm what already exists and what source of truth owns it.
3. Apply changes in the source repo/workspace whenever possible, not only the live cluster.
4. Build/test/deploy through the selected lane.
5. Verify rollout, public host, TLS trust or route reachability, and browser/UI behavior for frontend work.
6. Return proof markers: `WHAT_CHANGED`, `VERIFY_COMMANDS`, `VERIFY_RESULTS`, `PUBLIC_URL`, and `BLOCKER`. Preserve continuity markers such as `REMOTE_CLI_SESSION_ID`, `WORKSPACE`, `GIT_REPO`, `GIT_COMMIT`, `CHANGED_FILES`, `DEPLOYMENT`, `PUBLIC_HOST`, `UI_CHECK_REPORT`, and `UI_SCREENSHOTS` when known.

Failure handling:
- If `remote-cli-agent` returns `USER_INPUT_REQUIRED`, forward the concise choice to the user and continue the same remote session after the answer.
- If the same blocked command, root/sudo issue, credential failure, or missing runner capability repeats twice without a changed strategy, stop and report the blocker plus the next distinct recovery path.
- Treat live incidents as incomplete until the exact runtime surface or public route is reproved green.

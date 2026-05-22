# Remote Workbench

`remote-workbench` is the structured remote CLI lane for agents. It wraps `remote-command`, keeps the same runner or SSH fallback, and exposes action names so the planner does not have to invent shell for routine repo and deployment work.

## Actions

- `baseline`, `repo-inspect`, `repo-map`, `changed-files`, `file-search`, `dependency-check`
- `git-prepare`, `git-snapshot`, `git-commit`, `git-revert` for local remote-workspace Git visibility and rollback
- `grep` with `needle` and optional `path`
- `read-file` with `path`, `startLine`, and `lineCount`
- `write-file` with `path` and `content` or `contentBase64`
- `apply-patch` with a unified diff in `patch`
- `build`, `test`, `focused-test`, `buildkit`, `direct-image-build`
- `ui-visual-check` with `publicUrl` or `publicHost` to capture Playwright desktop/mobile screenshots and a JSON report
- `kubectl-inspect`, `k8s-app-inventory`, `logs`, `pod-debug`, `rollout`, `deploy-verify`

## Profiles

- `inspect`: baseline, repo/file search, read-only Kubernetes inspection, logs, UI visual checks
- `build`: file writes, patch application, build and test commands
- `deploy`: rollout and deployment verification

Use `remote-command` for expert one-off shell that does not fit one of these actions. Use `remote-cli-agent` when the remote coding agent should own a longer build/deploy loop.

For k3s website/app edits, use a git-backed remote workspace as the editable source of truth. Inspect `git status` and current files before editing, set repo-local git identity if needed, commit deployable changes, and then verify rollout. Prefer configured GitLab origins when available; treat live ConfigMaps or pod-mounted HTML as recovery evidence, not as the long-term source to keep editing.

For direct runner or local remote-server deployments where GitLab/Gitea is unavailable or too heavy, use the local Git run sequence:

1. `git-prepare` with a branch such as `agent/<run-id>` before edits.
2. Edit with `apply-patch`, `write-file`, or `remote-cli-agent` in the same workspace.
3. `git-snapshot` to capture changed files, diff stat, and patch evidence.
4. `git-commit` before build/deploy so `GIT_COMMIT` can be tied to the image tag and rollout.
5. `git-revert` to undo an AI change with a visible rollback commit, then rebuild/redeploy from that reverted source.

For website/dashboard QA, run `ui-visual-check` after the route or preview URL is reachable. Use the emitted `UI_CHECK_REPORT` and `UI_SCREENSHOT` paths to review desktop/mobile rendering, horizontal overflow, browser errors, and broken images before claiming the build is complete.

## Examples

```json
{"action":"repo-map","cwd":"/srv/apps/kimibuilt"}
```

```json
{"action":"grep","cwd":"/srv/apps/kimibuilt","needle":"REMOTE_CLI_MCP_BEARER_TOKEN","path":"src"}
```

```json
{"action":"apply-patch","cwd":"/srv/apps/kimibuilt","patch":"diff --git a/file.js b/file.js\n..."}
```

# remote-cli-agent

Purpose: run a server-side remote coding agent through the default MCP `remote_code_run/status` contract, with the gateway's `/api/codex-agent/run` plus `/events` SSE contract available as explicit opt-in.

Use this tool when the user asks for backend CLI agents behind the router to work on a remote/server workspace, especially coding/build/deploy tasks where KimiBuilt should stream progress while the remote agent owns the implementation loop.

For most remote software deployments, prefer `remote-cli-agent` over one-shot `remote-command`: if an app, website, service, dashboard, frontend, or game needs to be created or changed and put live, let the remote CLI agent own the author -> build/test -> deploy -> verify loop.

Layer boundary:
- `remote-cli-agent` is the outer KimiBuilt tool. Call it with `task`, optional `cwd` or `workspacePath`, `threadId`, `sessionId`, `waitMs`, `transport`, and `adminMode`.
- The default transport is `mcp`: KimiBuilt calls `remote_code_run`, then polls `remote_code_status`.
- The `codex-agent` transport is available as opt-in: KimiBuilt calls `POST /api/codex-agent/run`, then consumes `GET /api/codex-agent/runs/:runId/events` as SSE.
- Do not send raw shell fields such as `command`, `args`, `executable`, or `shell` to `remote-cli-agent`. Use `remote-command` for one direct command.
- Do not collapse the explicit phrase "remote cli agent" into `remote-command`.

Outer tool call shape:

```json
{
  "task": "Build/fix/deploy the app and verify the public URL.",
  "adminMode": true,
  "cwd": "/srv/apps/my-app",
  "transport": "mcp",
  "waitMs": 30000,
  "threadId": "optional prior Codex thread id for codex-agent transport"
}
```

For the short lane picker, read `src/agent-sdk/tool-docs/remote-tools.md`.

Server-side configuration:

```bash
REMOTE_CLI_AGENT_TRANSPORT=mcp
REMOTE_CLI_MCP_URL=https://gateway.example.com/mcp
# Or set GATEWAY_URL=https://gateway.example.com and the backend will append /mcp.
N8N_API_KEY=server-side-admin-or-n8n-key
REMOTE_CLI_DEFAULT_TARGET_ID=prod
REMOTE_CLI_DEFAULT_CWD=/srv/apps/my-app

# Codex-agent SSE opt-in:
REMOTE_CLI_CODEX_AGENT_BASE_URL=https://gateway.example.com
REMOTE_CLI_CODEX_AGENT_BEARER_TOKEN=server-side-frontend-or-admin-key
REMOTE_CLI_CODEX_AGENT_WORKSPACE_PATH=/srv/apps/my-app
REMOTE_CLI_CODEX_AGENT_APPROVAL_POLICY=never
REMOTE_CLI_CODEX_AGENT_THREAD_SANDBOX=workspace-write

# Optional; leave unset to use the gateway target default.
REMOTE_CLI_REMOTE_CODE_MODEL=
REMOTE_CLI_AGENT_MAX_STATUS_POLLS=90
REMOTE_CLI_AGENT_STATUS_POLL_INTERVAL_MS=2000
```

Gateway-side requirements:

```bash
CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS=/srv/apps
FRONTEND_API_KEY=<server-side key accepted by /api/codex-agent/*>
REMOTE_CLI_TOOL_AUTH_SCOPES=n8n,frontend,admin
```

Codex-agent gateway contract:

- `POST /api/codex-agent/run` with `{ workspacePath, prompt, continuation?, threadId?, config? }`.
- `GET /api/codex-agent/runs/:runId/events` returns SSE frames with named events.
- Expected stream events are `session_started`, `output`, and one terminal event: `turn_completed`, `turn_failed`, `turn_cancelled`, or `turn_input_required`.
- KimiBuilt forwards these events through its own chat SSE progress payloads so the browser sees live throughput instead of waiting for the final answer.
- Use `threadId` for continuation when a prior Codex thread id is known.

Legacy MCP gateway contract:

- The backend connects to `POST /mcp` with bearer auth. This is JSON-RPC request/response plus polling, not SSE.
- Coding work must call `remote_code_run({ targetId, cwd, task, model?, sessionId?, waitMs? })`; omit `model` unless the configured gateway target supports the override.
- Long-running work must then call `remote_code_status({ jobId })`.
- Do not send raw command execution fields such as `command`, `args`, `executable`, or `shell`; the gateway rejects them.
- Do not include `targetId`, `cwd`, `sessionId`, or `waitMs` in `remote_code_status`; it accepts the job id only.

Admin runner mode:

- Pass `adminMode: true` when the task is a real remote software change/deploy request and the user has asked to make it live.
- Admin mode means the agent may use the configured admin-capable CLI runner or target for scoped repo edits, builds, image pushes, Kubernetes apply/rollout, ingress/TLS, and verification required by the task.
- It is not a blanket root shell. The agent must stay inside the owning workspace, namespace, domain, and deployment path.
- Do not mutate Kubernetes Secrets, wipe data, force-push, perform broad package upgrades, or change unrelated host services unless the user explicitly approved that exact action.
- If a runner/sudo policy blocks a command, do not retry the same blocked command. Switch to a non-privileged supported path or stop and report the exact approval, runner capability, credential, or sudoers change needed.

Provider target example:

```yaml
remoteCliTargets:
  - targetId: prod
    host: prod.example.com
    user: deploy
    allowedCwds:
      - /srv/apps
    defaultCwd: /srv/apps/my-app
    defaultModel: gpt-5.4
    opencodeExecutable: opencode
```

Behavior:
- The bearer key is used only by backend Node.js code. Do not expose it to browser JavaScript.
- The Codex agent receives instructions to work inside `workspacePath`, emit proof markers, and avoid waiting forever on approval or user input.
- The backend stores returned session/thread metadata in the conversation control state, so follow-up requests can continue the same remote workbench session when possible.
- For k3s website/app creation or edits, the remote CLI agent must use a git-backed workspace as the editable source of truth. Prefer an existing configured GitLab origin; if none exists, check configured GitLab context and non-interactive credentials before asking the user to do manual programming or repo setup.
- For retry requests like "the deployed address did not work, try again", do not patch the live cluster first. Re-open the owning git workspace or managed-app repo, inspect the current tree and manifests, make the durable change there, then rebuild/deploy through GitLab or the documented fallback path.
- GitLab source-control skill:
  1. Inspect `git status`, `git remote -v`, recent commits, and deploy manifests before editing.
  2. If the current origin host matches the configured GitLab host, keep it as the source of truth and commit deployable changes there.
  3. If GitLab is configured but the workspace has no matching origin, create or use a repo under the configured group when credentials/API access are available; prefer token/askpass HTTPS over SSH prompts.
  4. If repo creation is blocked by missing credentials or API capability, commit locally, report the exact missing piece, and leave the workspace ready to attach to GitLab.
  5. If GitLab is not configured or reachable, use the direct BuildKit/kubectl path from a local git repo and clearly mark GitLab as the missing automation layer.
- Because this is the most-used remote deployment tool, Git visibility is required even when the fallback is only local Git: create or reuse a repo in the workspace, work on an `agent/<run-id>` branch when practical, capture base commit and changed files, commit before deploy, and use `git revert` plus redeploy for rollback.
- Source-to-public completion requires evidence in this order when available: changed files, commit SHA, GitLab pipeline/build event, image tag or digest, k3s rollout, ingress/TLS/HTTPS verification, and browser screenshot for UI work. A healthy pod by itself is not enough.
- Before first commit in a fresh remote workspace, set repo-local `git config user.name` and `git config user.email` if they are missing.
- For follow-up edits, inspect `git status`, recent commits, and current source first. Use live Kubernetes resources, ConfigMaps, or mounted files only as diagnostics or recovery input, then persist the change back to git before redeploying.
- Track repeated failures. After the same command shape or root error fails twice without a materially different fix, stop that loop, summarize the blocker, and name the next distinct recovery option.
- If the remote CLI agent needs a user choice to finish, emit `USER_INPUT_REQUIRED=<question/options>` and stop. The KimiBuilt-side agent should forward the request to the user and continue the same remote CLI session after the answer.
- For website/dashboard/frontend work, run Playwright/Chromium visual QA when a local preview or public URL exists. Prefer `node /app/bin/kimibuilt-ui-check.js <url> --out ui-checks` when the helper is present.
- For website, dashboard, app workspace, landing-page, frontend demo, HTML prototype, or UI mockup work, apply the Impressive Frontend Websites standard: infer a compact brief, make the first viewport specific to the product/workflow/offer/audience, use relevant visual assets, build real controls/states/interactions, verify desktop/mobile plus opened UI states, and perform a refinement pass after the first render for non-trivial UI before deploy/final.
- Avoid generic templates, one-note palettes, decorative blobs, nested cards, clipped labels, horizontal overflow, broken image paths, and unreadable dropdown/menu/popover/dialog/tooltip states.
- The final output must include completion proof markers so the outer runtime can classify the run:
  - `WHAT_CHANGED=<short summary of source/config/deploy changes>`
  - `VERIFY_COMMANDS=<command or check run; repeat the marker for multiple checks>`
  - `VERIFY_RESULTS=<pass/fail/blocked result; repeat the marker for multiple checks>`
  - `PUBLIC_URL=<https URL or not_available>`
  - `BLOCKER=<none or exact blocker>`
- The final output should also include continuity markers when known: `REMOTE_CLI_SESSION_ID=...`, `WORKSPACE=...`, `GIT_REPO=...`, `GIT_BRANCH=...`, `GIT_BASE_COMMIT=...`, `GIT_COMMIT=...`, `CHANGED_FILES=...`, `DEPLOYMENT=...`, `PUBLIC_HOST=...`, `UI_CHECK_REPORT=...`, and `UI_SCREENSHOTS=...`.
- Prefer `waitMs: 30000` for long coding tasks.
- Pass `sessionId` when continuing a previous remote coding session.
- Pass `threadId` when continuing a previous `/api/codex-agent/run` Codex thread.
- Pass `mcpSessionId` only when using the legacy `mcp` transport.
- Frontends expose `/remote agent <task>` for handing a full coding, build, deploy, and verification loop to this tool.

Use `remote-command` instead for quick non-interactive host inspection, one-off repairs, or small kubectl/log checks. Use `remote-cli-agent` when the remote code agent should own the coding and deployment loop.

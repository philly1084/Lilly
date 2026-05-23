# remote-cli-agent

Purpose: run a server-side OpenAI Agents SDK coding agent with the remote-cli Streamable HTTP MCP gateway attached.

Use this tool when the user asks for backend CLI agents behind the router to work on a remote server, especially coding/build/deploy tasks that should go through the gateway's `remote_code_run` and `remote_code_status` tool schema.

For most remote software deployments, prefer `remote-cli-agent` over one-shot `remote-command`: if an app, website, service, dashboard, frontend, or game needs to be created or changed and put live, let the remote CLI agent own the author -> build/test -> deploy -> verify loop.

Server-side configuration:

```bash
REMOTE_CLI_MCP_URL=https://gateway.example.com/mcp
# Or set GATEWAY_URL=https://gateway.example.com and the backend will append /mcp.
N8N_API_KEY=server-side-admin-or-n8n-key
REMOTE_CLI_DEFAULT_TARGET_ID=prod
REMOTE_CLI_DEFAULT_CWD=/srv/apps/my-app
REMOTE_CLI_AGENT_MODEL=gpt-5.5
REMOTE_CLI_AGENT_MAX_STATUS_POLLS=3
```

`REMOTE_CLI_AGENT_MODEL` must be an OpenAI tool-calling chat model. Do not let this lane inherit `OPENAI_MODEL=kimi-for-coding`; Kimi can answer normal chat prompts, but it has produced malformed MCP status calls for `remote_code_status`.

Gateway-side requirements:

```bash
REMOTE_CLI_TOOL_AUTH_SCOPES=n8n,frontend,admin
```

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
    defaultModel: openai/gpt-5.4
    opencodeExecutable: opencode
```

Behavior:
- The bearer key is used only by backend Node.js code. Do not expose it to browser JavaScript.
- The inner agent receives instructions to use `remote_code_run`, poll `remote_code_status` when jobs are still running, and reuse returned session IDs for continuation.
- The backend stores returned `sessionId` and `mcpSessionId` in the conversation control state, so follow-up requests can continue the same remote workbench session.
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
- Keep `maxStatusPolls` low by default. If the compatibility fallback starts a remote job that is still running, it should return `REMOTE_CLI_JOB_ID` and `REMOTE_CLI_SESSION_ID` quickly enough for the caller to continue rather than holding the user-facing event open for many minutes.
- Pass `sessionId` when continuing a previous remote coding session.
- Pass `mcpSessionId` when continuing a previous Streamable HTTP MCP session.
- Frontends expose `/remote agent <task>` for handing a full coding, build, deploy, and verification loop to this tool.

Use `remote-command` instead for quick non-interactive host inspection, one-off repairs, or small kubectl/log checks. Use `remote-cli-agent` when the remote code agent should own the coding and deployment loop.

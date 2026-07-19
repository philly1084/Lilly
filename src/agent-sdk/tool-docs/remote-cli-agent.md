# remote-cli-agent

Purpose: run Codex or Kimi as a server-side remote coding agent through the gateway's authenticated `/admin/remote-agent-tasks` contract, with direct in-pod Codex and MCP retained only as explicit compatibility transports.

Use this tool when the user asks for backend CLI agents behind the router to work on a remote/server workspace, especially coding/build/deploy tasks where KimiBuilt should stream progress while the remote agent owns the implementation loop.

Also use this tool when the user asks to "ask Codex for help", "use Codex for this", or get "Codex help" for deeper document creation, synthesis, or build work. In this project, that phrase means the main Codex-agent lane on the primary KimiBuilt server, using the configured defaults, normally `targetId: "k3s-prod"` and `cwd: "/opt/kimibuilt"`.

For most remote software deployments, prefer `remote-cli-agent` over one-shot `remote-command`: if an app, website, service, dashboard, frontend, or game needs to be created or changed and put live, let the remote CLI agent own the author -> build/test -> deploy -> verify loop.

Layer boundary:
- `remote-cli-agent` is the outer KimiBuilt tool. Call it with `task`, optional `cwd` or `workspacePath`, `threadId`, `sessionId`, `waitMs`, `transport`, and `adminMode`. Use `artifactIds`/`contextFiles` for inbound files and `collectResultFiles:true` when generated files must return to the active KimiBuilt session.
- The production default is `provider-agent`: KimiBuilt calls `POST /admin/remote-agent-tasks`, streams the returned same-origin task URL, and collects gateway-verified result files. The selected model maps to `codex-cli` or `kimi-code-cli`.
- The `codex-agent` transport remains available explicitly for compatible environments that can safely run the Codex app-server bridge in the gateway pod.
- The `mcp` transport remains available for compatibility: KimiBuilt calls `remote_code_run`, then polls `remote_code_status`.
- Do not send raw shell fields such as `command`, `args`, `executable`, or `shell` to `remote-cli-agent`. Use `remote-command` for one direct command.
- Do not collapse the explicit phrase "remote cli agent" into `remote-command`.

Outer tool call shape:

```json
{
  "task": "Build/fix/deploy the app and verify the public URL.",
  "adminMode": true,
  "cwd": "/srv/apps/my-app",
  "transport": "provider-agent",
  "waitMs": 30000,
  "sessionId": "optional prior provider session id for Codex continuation",
  "supportAgentResponse": "optional answer from a support agent for a resumed CLI thread",
  "artifactIds": ["session-owned-sandbox-or-document-artifact-id"],
  "contextFiles": [
    {
      "filename": "design-brief.xml",
      "mimeType": "application/xml",
      "content": "<brief>...</brief>"
    }
  ],
  "collectResultFiles": true,
  "resultFileGlobs": ["dist/*.html", "artifacts/*.svg"]
}
```

Artifact handoff contract:

- KimiBuilt owns artifacts, session authorization, lineage, and final download/preview URLs. The `nuts` router owns secure staging and collection at the CLI execution boundary. The frontend renders one job; it does not mirror Codex/Kimi transport tools.
- Selected artifacts are loaded only after their `sessionId` matches the active session. Inline and stored files are strict-base64/checksum normalized. `manifest.json` is reserved for gateway metadata.
- Each invocation gets an isolated `.kimibuilt/agent-runs/<operationId>/` directory. Inputs live under `input/`; returnable files must be copied under `output/files/`; the agent writes `output/manifest.json` using `RemoteAgentResultFiles/v1`.
- The bounded v1 envelope accepts at most 12 files, 4 MiB per file, and 6 MiB decoded total. This remains below the router's 10 MiB JSON request limit after base64 expansion. Larger bundles should use a future scoped object-store URL rather than increasing the JSON body without an explicit gateway limit change.
- `nuts` must acknowledge `RemoteAgentHandoff/v1`, the `operationId`, and the exact isolated paths before the CLI turn begins. KimiBuilt fails closed when a rolling deployment ignores or mismatches the contract.
- After a terminal turn, KimiBuilt pulls `GET /api/codex-agent/runs/:runId/result-files` or `GET /admin/remote-agent-tasks/:taskId/result-files` with server-side bearer auth. The router returns only gateway-verified regular, non-symlink files from the isolated output directory, with computed sizes, SHA-256 hashes, and base64.
- KimiBuilt verifies the envelope, stores each file as a generated `remote-cli-agent` artifact, reloads the final persisted bytes after privacy restoration, and reruns structural validation before returning anything to the browser. An invalid post-storage JSON/XML/SVG/HTML rewrite rolls back the whole result set. Source artifact IDs and remote run metadata remain attached, while base64 is stripped from the tool result.
- To return a complete website, keep all deployable site files under one directory, mark exactly one `index.html` as `role: "site-entry"`, and mark every other site member `role: "site-file"`. Keep QA reports, editable source that is not part of the preview, and unrelated XML/SVG deliverables on their normal roles.
- A valid role-marked multi-file website is also assembled from the stored component bytes into one native ZIP artifact with `metadata.siteBundle`. The entry directory is removed so the archive opens at `index.html`; component artifacts retain source-path/checksum lineage but are hidden from the default artifact list. Tool results expose the bundle as `siteBundleArtifact` and `siteBundleArtifactId`, and the existing preview, Bundle Zip, and Push to Web actions work without provider-specific frontend controls.
- Site roles fail closed: a missing or duplicate entry, a non-`index.html` entry, a member outside the entry directory, an unavailable stored component, or a missing local site reference blocks result persistence and rolls back every artifact created for that result envelope. The native ZIP is built only from the reloaded bytes that passed the final gate.
- Read-only calls without inputs or `collectResultFiles` create no handoff directory. The legacy MCP transport rejects any file-handoff request because it cannot preserve these staging/collection guarantees.

For the short lane picker, read `src/agent-sdk/tool-docs/remote-tools.md`.

Server-side configuration:

```bash
REMOTE_CLI_AGENT_TRANSPORT=provider-agent
REMOTE_CLI_CODEX_AGENT_BASE_URL=https://gateway.example.com
REMOTE_CLI_CODEX_AGENT_BEARER_TOKEN=server-side-frontend-or-admin-key
REMOTE_CLI_CODEX_AGENT_WORKSPACE_PATH=/srv/apps/my-app
REMOTE_CLI_CODEX_AGENT_MODEL=gpt-5.6-sol
REMOTE_CLI_CODEX_AGENT_APPROVAL_POLICY=never
REMOTE_CLI_CODEX_AGENT_THREAD_SANDBOX=workspace-write
REMOTE_CLI_DEFAULT_TARGET_ID=prod
REMOTE_CLI_DEFAULT_CWD=/srv/apps/my-app

# MCP compatibility lane:
REMOTE_CLI_MCP_URL=https://gateway.example.com/mcp
N8N_API_KEY=server-side-admin-or-n8n-key
REMOTE_CLI_REMOTE_CODE_MODEL=gpt-5.4
REMOTE_CLI_AGENT_MAX_STATUS_POLLS=90
REMOTE_CLI_AGENT_STATUS_POLL_INTERVAL_MS=2000
```

Gateway-side requirements:

```bash
FRONTEND_API_KEY=<server-side key accepted by /admin/remote-agent-tasks>
REMOTE_CLI_TOOL_AUTH_SCOPES=n8n,frontend,admin
# Keep /admin/remote-agent-tasks cluster-internal; public ingress need not expose it.
```

Headless Codex operating model:

- KimiBuilt's preferred remote CLI agent path is not raw TTY automation. It uses the router's provider-session task bridge so Codex and Kimi share authentication, isolated file staging, progress streaming, and verified result collection.
- This maps to the current Codex headless guidance better than driving the interactive TUI. One-shot automation can use `codex exec --json`, but multi-turn orchestration should keep a durable conversation handle. In the provider-task contract that handle is `sessionId` when the selected CLI supports continuation; direct Codex compatibility uses `threadId`.
- The remote agent should emit short milestone messages during inspect/edit/build/deploy/verify phases so the outer web-chat stream has real progress. Do not leave the user with only a start card and final result.
- Treat `turn_input_required` as a controlled pause: forward the concise decision to the user, then resume with the same `sessionId` or direct-Codex `threadId` when possible.
- Support-agent back-and-forth is supported without switching transports: when the CLI agent needs a second opinion or decomposition help, it should finish that turn with `SUPPORT_AGENT_REQUIRED=<precise help request>` and `SUPPORT_AGENT_CONTEXT=<facts/files/commands/blocker>`. The outer KimiBuilt agent can run a support agent, then call `remote-cli-agent` again with the same `sessionId` (or direct-Codex `threadId`) plus `supportAgentResponse` to continue the CLI thread.
- Use `SUPPORT_AGENT_REQUIRED` only for internal agent help. Use `USER_INPUT_REQUIRED` for user choices, credentials, approvals, or product direction.

Explicit direct Codex-agent compatibility contract:

- `POST /api/codex-agent/run` with `{ workspacePath, prompt, continuation?, threadId?, config?, handoff? }`.
- `GET /api/codex-agent/runs/:runId/events` returns SSE frames with named events.
- Expected stream events are `session_started`, `output`, and one terminal event: `turn_completed`, `turn_failed`, `turn_cancelled`, or `turn_input_required`.
- KimiBuilt forwards these events through its own chat SSE progress payloads so the browser sees live throughput instead of waiting for the final answer.
- Use `threadId` for continuation when a prior Codex thread id is known.
- A handoff start response includes `{ handoff: { accepted, version, operationId, inputManifestPath, resultManifestPath? }, resultFilesUrl? }`. Never treat the caller's requested version as proof that staging happened.

Legacy MCP gateway contract:

- The backend connects to `POST /mcp` with bearer auth. This is JSON-RPC request/response plus polling, not SSE.
- Coding work must call `remote_code_run({ targetId, cwd, task, model?, sessionId?, waitMs? })`; include the configured `REMOTE_CLI_REMOTE_CODE_MODEL` when set.
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
- The Codex-agent process runs inside the remote gateway/container. `localhost` and `127.0.0.1` mean that runner container only; they are not the user's desktop, the KimiBuilt backend pod, or proof of the public remote app. For live verification, use the public URL, Kubernetes service DNS, or `kubectl` in the target namespace unless the user explicitly asks for a local dev-server check.
- From Codex Desktop, the outer agent should use the KimiBuilt Remote Ops tunnel baseline before remote mutation: `powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline`, scoped with `-Server primary` or `-Server secondary` when only one server matters.
- Keep primary and secondary server evidence separate. Re-baseline when switching targets, label the server/namespace/deployment/public host, and never use proof from one server as proof for the other.
- The backend stores returned session/thread metadata in the conversation control state and records project facts in the cluster continuity registry, so follow-up requests can continue the same remote workbench session when the task matches the same repo/workspace/deployment/domain.
- The continuity registry is shared across the remote tool family and captures repo, workspace, deployment, ingress/public host, commit, changed files, verification markers, UI check artifacts, and recent activity when tools return those markers.
- Treat registry facts as candidate context. Match by explicit repo, workspace, deployment, namespace, domain, or target before editing, and inspect first when the user names a different project.
- For k3s website/app creation or edits, the remote CLI agent must use a git-backed workspace as the editable source of truth. Prefer an existing configured GitLab origin; if none exists, check configured GitLab context and non-interactive credentials before asking the user to do manual programming or repo setup.
- Before creating a new remote website, app, dashboard, service, GitLab repo, namespace, or public host, inventory existing managed-app records, configured GitLab projects, continuity/project registry facts, and live k3s namespaces/services/ingresses for matching name, slug, repo, namespace, domain, or purpose. Reuse or iterate a match, ask on ambiguous matches, and create only after no match is found or the user explicitly asked for a separate new project.
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
- For web-chat, managed-app previews, generated HTML artifacts, TTS, document rendering, website/dashboard/frontend work, run Playwright/Chromium visual QA when a local preview, public URL, or KimiBuilt tunnel endpoint exists. Prefer `node /app/bin/kimibuilt-ui-check.js <url> --out ui-checks` when the helper is present.
- For website, dashboard, app workspace, landing-page, frontend demo, HTML prototype, or UI mockup work, apply the Impressive Frontend Websites standard: infer a compact brief, make the first viewport specific to the product/workflow/offer/audience, use relevant visual assets, build real controls/states/interactions, verify desktop/mobile plus opened UI states, and perform a refinement pass after the first render for non-trivial UI before deploy/final.
- Avoid generic templates, one-note palettes, decorative blobs, nested cards, clipped labels, horizontal overflow, broken image paths, and unreadable dropdown/menu/popover/dialog/tooltip states.
- The final output must include completion proof markers so the outer runtime can classify the run:
  - `WHAT_CHANGED=<short summary of source/config/deploy changes>`
  - `VERIFY_COMMANDS=<command or check run; repeat the marker for multiple checks>`
  - `VERIFY_RESULTS=<pass/fail/blocked result; repeat the marker for multiple checks>`
  - `PUBLIC_URL=<https URL or not_available>`
  - `BLOCKER=<none or exact blocker>`
- The final output should also include continuity markers when known: `REMOTE_CLI_SESSION_ID=...`, `WORKSPACE=...`, `GIT_REPO=...`, `GIT_BRANCH=...`, `GIT_BASE_COMMIT=...`, `GIT_COMMIT=...`, `CHANGED_FILES=...`, `DEPLOYMENT=...`, `PUBLIC_HOST=...`, `UI_CHECK_REPORT=...`, and `UI_SCREENSHOTS=...`.
- When returned files were requested, include `RESULT_FILES_MANIFEST=<the exact operation-scoped output/manifest.json path>`. This marker is descriptive; the authenticated router result-files endpoint remains authoritative.
- Prefer `waitMs: 30000` for long coding tasks.
- Pass `sessionId` when continuing a previous remote coding session.
- Pass `threadId` when continuing a previous `/api/codex-agent/run` Codex thread.
- Pass `mcpSessionId` only when using the legacy `mcp` transport.
- Frontends expose `/remote agent <task>` for handing a full coding, build, deploy, and verification loop to this tool.

Use `remote-command` instead for quick non-interactive host inspection, one-off repairs, or small kubectl/log checks. Use `remote-cli-agent` when the remote code agent should own the coding and deployment loop.

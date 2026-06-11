# Build And Verify

GREP_HANDLES: AGENT_DOC BUILD_VERIFY LOCAL_BUILD REMOTE_BUILD REMOTE_CLI_AGENT UI_CHECK DEPLOY_PROOF

Use when:
- The user asks to build, fix, deploy, publish, or prove a UI/backend change.
- A result needs visible proof rather than only code reasoning.
- You need to decide between local, sandbox, remote, and k3s paths.

Local path:
- Inspect changed files: `git status --short`
- Find code quickly: `rg -n "route|symbol|error text" src frontend docs`
- Run focused tests first: `node .\node_modules\jest\bin\jest.js --runTestsByPath <test-file>`
- Syntax check edited JS when useful: `node --check <file>`
- For generated HTML/UI: `node bin/kimibuilt-ui-check.js <url-or-file-url> --out ui-checks/<name>`

Sandbox path:
- Use `code-sandbox` for static preview bundles or runnable snippets.
- For browser libraries, prefer `/api/sandbox-libraries/catalog.json` and local `/api/sandbox-libraries/...` routes before CDNs. Use chart/graph/3D libraries for visual experiences and CodeMirror, highlight.js, Marked, PDF.js, Mammoth, or docx.js for code/document viewer sandboxes.
- Keep preview bundles static-safe: one `index.html`, local CSS/assets, no uncompiled build-only classes.
- For reusable frontend follow-ups, prefer the IDE loop before rebuilding: `file-search` or grep -> targeted `file-read` -> smallest source edit -> focused syntax/test -> browser or `kimibuilt-ui-check` proof. Do not regenerate a whole HTML/CSS/JS bundle when existing source can be patched.

Remote path:
- Prefer `remote-cli-agent` for scoped remote software creation, update, deploy, and verification loops. Its params use `task`, not `command`.
- Prefer `remote-command` for one-off kubectl, logs, service checks, network checks, and status inspection. Its params use `command`.
- Prefer `k3s-deploy` for standard repo sync, manifest apply, image update, and rollout checks after source/image/manifests already exist.
- Read `docs/agent-grep/remote-tools.md` when the remote lane is not obvious.
- Start remote reconnects with the KimiBuilt Remote Ops baseline: `powershell -ExecutionPolicy Bypass -File scripts/codex-remote-tunnel.ps1 -Action baseline`, scoped with `-Server primary` or `-Server secondary` when appropriate.
- Keep primary and secondary server evidence separate, and re-baseline when switching targets.
- Verify deployed UI through the public URL or a named KimiBuilt tunnel endpoint.
- Remote agents should report `WHAT_CHANGED`, `VERIFY_COMMANDS`, `VERIFY_RESULTS`, `PUBLIC_URL`, and `BLOCKER` when relevant.

Proof checklist:
- Code changed in the intended files only.
- Focused tests or syntax checks passed.
- UI/browser checks ran when the result touches web-chat, managed-app previews, generated HTML artifacts, TTS, document rendering, or any frontend/website surface.
- Remote rollout, ingress, TLS, and public URL were checked for deployed work.
- Any blocker is reported plainly with the next distinct recovery path.

Good grep targets:
- `docs/agent-grep/remote-tools.md`
- `src/agent-sdk/tool-docs/remote-cli-agent.md`
- `src/agent-sdk/tool-docs/remote-command.md`
- `src/agent-sdk/tool-docs/k3s-deploy.md`
- `src/agent-sdk/tool-docs/file-search.md`
- `src/agent-sdk/tool-docs/file-read.md`
- `src/agent-sdk/tool-docs/file-write.md`
- `k8s/K3S_RANCHER_PLAYBOOK.md`
- `bin/kimibuilt-ui-check.js`

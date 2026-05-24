# Tool Lookup

GREP_HANDLES: AGENT_DOC TOOL_LOOKUP TOOL_DISCOVERY TOOL_READINESS TOOL_DOC_READ SKILL_CONTEXT TOOL_CATALOG

Use when:
- You need to know which KimiBuilt tool exists for a task.
- A tool might be hidden, unavailable, degraded, or profile-gated.
- You need the exact parameter shape before calling a tool.
- You are designing a skill and need real tool ids.

Primary surfaces:
- Runtime catalog: `GET /api/tools/available?includeAll=true`
- One tool detail: `GET /api/tools/:id`
- Tool docs: `GET /api/tools/docs/:id`
- Tool doc tool: `tool-doc-read`
- Registered skill context: `skill-context`
- Skill list/read tools: `skill-list`, `skill-read`

Quick flow:
1. Search names first: `rg -n "tool-id|feature phrase" src/agent-sdk/tool-docs src/agent-sdk/tools data/skills`.
2. If running in the app, call `/api/tools/available?includeAll=true` to get live catalog, readiness, support notes, and runtime config.
3. For any non-obvious tool, read `src/agent-sdk/tool-docs/<tool-id>.md` or call `tool-doc-read`.
4. For workflow shape, call `skill-context` with the user request plus likely `toolIds`.
5. Prefer a small chain of real tools over inventing a new tool.

Common tool ids:
- `web-search`, `web-fetch`, `web-scrape`: research and page verification.
- `design-resource-search`: safe visual/design source lookup.
- `image-generate`: generated visuals for HTML, PDFs, documents, slides, and websites.
- `code-sandbox`: static preview bundles and sandbox execution when available.
- `document-workflow`: document, deck, PDF, XLSX, Markdown, and bundle generation.
- `remote-cli-agent`: remote software build/deploy/verify loops.
- `remote-command`, `remote-workbench`, `k3s-deploy`: remote inspection, structured remote work, and k3s deploy checks.
- `skill-list`, `skill-read`, `skill-context`, `skill-create`, `skill-update`: registered skill lifecycle.
- `self-reflection-update`: approval-gated durable notes and skill patches.

Checks before use:
- Is the tool in the current execution profile?
- Is readiness `ready` or only `requires_setup`?
- Does the tool write, execute, deploy, or need approval?
- Does a matching registered skill already encode the workflow?
- If the tool is new or undocumented, update `docs/agent-grep/adding-tools.md` requirements before relying on it.

Longer docs:
- `src/agent-sdk/tool-docs/remote-tools.md`
- `src/agent-sdk/tool-docs/tool-doc-read.md`
- `src/agent-sdk/tool-docs/remote-cli-agent.md`
- `src/agent-sdk/tool-docs/remote-command.md`
- `src/agent-sdk/tool-docs/design-resource-search.md`

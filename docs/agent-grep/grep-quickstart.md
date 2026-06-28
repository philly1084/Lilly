# Grep Quickstart

GREP_HANDLES: AGENT_DOC GREP_QUICKSTART RG_COMMANDS FIND_GREP_REMOTE DISCOVERABLE_DOCS AGENT_CAN_GREP

Use when:
- An agent needs to find the right small doc, tool, skill, route, test, or failing string quickly.
- You want proof that the agent docs are discoverable by grep.
- The environment may be local Windows/PowerShell or a remote Linux host.

Local Windows/PowerShell:

```powershell
rg -n "AGENT_DOC|GREP_QUICKSTART|TOOL_USE_RHYTHM|TOOL_LOOKUP|REMOTE_TOOLS|ADDING_TOOLS|DESIGN_RESEARCH|SKILL_AUTHORING|BUILD_VERIFY|NOTES_DATABASES" docs/agent-grep AGENTS.md frontend/notes-notion/docs
rg -n "tool-id|route-name|error text|user phrase" src frontend docs data/skills
rg --files | rg "docs/agent-grep|src/agent-sdk/tool-docs|data/skills|AGENTS.md"
```

Local repo map:

```powershell
rg --files src frontend docs data/skills | Select-Object -First 200
rg -n "class ToolManager|registerDesignTools|TOOL_SUPPORT|PROFILE_TOOL_ALLOWLISTS|skillStore" src
```

Remote Linux fallback:

```bash
find docs/agent-grep src/agent-sdk/tool-docs data/skills -type f | sort | head -n 200
grep -RIn "AGENT_DOC\|GREP_QUICKSTART\|TOOL_USE_RHYTHM\|TOOL_LOOKUP\|REMOTE_TOOLS\|ADDING_TOOLS\|DESIGN_RESEARCH\|SKILL_AUTHORING\|BUILD_VERIFY" docs/agent-grep AGENTS.md
grep -RIn "tool-id\|route-name\|error text\|user phrase" src frontend docs data/skills
```

Exact complaint flow:
1. Search the user phrase exactly.
2. Search the route, DOM id, tool id, or log phrase separately.
3. Read the smallest matching files.
4. Only then patch or call tools.

Reusable frontend / IDE loop:
- Search first: `rg -n "symbol|route|button-id|css-class" frontend src docs`
- Read the smallest matching files or slices.
- Patch targeted source instead of regenerating the whole frontend artifact.
- Verify with focused tests plus browser, `web-scrape`, or `bin/kimibuilt-ui-check.js`.

Agent-doc proof:

```powershell
rg -n "GREP_HANDLES:" docs/agent-grep
```

Expected result: every small doc in `docs/agent-grep/` has a `GREP_HANDLES:` line with stable uppercase handles.

Keep grepable docs grepable:
- Put handles near the top of each doc.
- Use exact tool ids like `design-resource-search`, `tool-doc-read`, and `remote-cli-agent`.
- Use exact route paths like `GET /api/tools/available?includeAll=true`.
- Use exact file paths like `src/agent-sdk/tool-docs/index.js`.
- Avoid clever synonyms when a future agent will grep for the literal phrase.

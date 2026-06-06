# Agent Grep Docs

GREP_HANDLES: AGENT_DOC AGENT_GREP GREP_INDEX GREP_QUICKSTART TOOL_USE_RHYTHM TOOL_LOOKUP REMOTE_TOOLS ADDING_TOOLS DESIGN_RESEARCH SKILL_AUTHORING BUILD_VERIFY

Purpose: small, grepable docs for agents that need to choose the right KimiBuilt workflow without loading long planning files.

Start here when:
- The task mentions tools, skills, design, frontend work, document generation, remote build, deploy, or verification.
- You are an incoming agent and need the smallest useful orientation.
- Existing prompt context feels too large, stale, or generic.

Fast grep:

```bash
rg -n "AGENT_DOC|GREP_QUICKSTART|TOOL_USE_RHYTHM|TOOL_LOOKUP|REMOTE_TOOLS|ADDING_TOOLS|DESIGN_RESEARCH|SKILL_AUTHORING|BUILD_VERIFY" docs/agent-grep src/agent-sdk/tool-docs data/skills
```

Docs:
- `grep-quickstart.md`: copyable local and remote grep commands.
- `tool-use-rhythm.md`: how to work the tools in the same careful order Codex uses.
- `tool-lookup.md`: find live tools, readiness, docs, and matching skills.
- `remote-tools.md`: pick the right remote operations lane and avoid `managed-app`/`remote-cli-agent`/`remote-command`/`remote-workbench`/`k3s-deploy` call-shape mistakes.
- `adding-tools.md`: required docs, registry, profile, and test updates for new tools.
- `design-research.md`: gather visual/design sources before building artifacts.
- `skill-authoring.md`: create or update compact file-backed skills.
- `build-and-verify.md`: pick the build path and prove the result.

Rules for these docs:
- Keep each doc short enough to read in one tool result.
- Put exact tool ids, route names, and file paths in plain text for grep.
- Prefer checklist steps over prose.
- Link to longer docs only when needed.

# AI Harness Architect

AI Harness Architect is a local Codex plugin for designing and optimizing AI harnesses with repo-aware context, research routing, sandbox design loops, and explicit regression decisions.

It is intentionally different from a one-time review plugin. The skill requires the agent to understand the repository, identify the real harness surfaces, choose research sources deliberately, prototype or simulate risky design choices when useful, and verify progress before reporting completion.

## Contents

- `skills/harness-design-optimization/SKILL.md` - the operating workflow.
- `scripts/collect-harness-context.js` - a repo scanner that emits a compact JSON map of likely harness files, tests, skills, tools, scripts, and UI surfaces.

## Typical Use

```powershell
node plugins/ai-harness-architect/scripts/collect-harness-context.js --root .
```

Generate a Markdown architecture brief when the agent needs a readable decision starter:

```powershell
node plugins/ai-harness-architect/scripts/collect-harness-context.js --root . --format markdown
```

Then use the generated context to drive architecture decisions, sandbox prototypes, focused tests, and follow-up plans.

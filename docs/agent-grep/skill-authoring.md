# Skill Authoring

GREP_HANDLES: AGENT_DOC SKILL_AUTHORING SKILL_CREATE SKILL_UPDATE SKILL_CONTEXT SKILL_WIZARD REGISTERED_SKILLS

Use when:
- A reusable workflow should be available to future agents.
- A task pattern keeps recurring and should not be stuffed into global instructions.
- The user asks to make, update, register, or refine a skill.

Registered skill location:
- Root: `data/skills/<skill-id>/`
- Manifest: `data/skills/<skill-id>/skill.json`
- Instructions: `data/skills/<skill-id>/SKILL.md`
- Backend store: `src/skills/skill-store.js`
- API routes: `src/routes/skills.js`

Primary tools:
- `skill-list`: list registered skills.
- `skill-read`: read one registered skill.
- `skill-context`: return compact matching skill context for a request.
- `skill-create`: create a file-backed skill.
- `skill-update`: update an existing skill.
- `agent-delegate`: isolate bounded creator-agent work when the user asks for a skill creator agent or multi-pass skill building without main-chat clutter.
- `self-reflection-update`: dry-run and approval-gated skill patches.
- `tool-doc-read`: inspect tool docs before encoding tool chains.

Skill shape:
- `id`: short kebab-case id.
- `name`: human readable title.
- `description`: one sentence about when to use it.
- `tools`: exact tool ids only.
- `triggerPatterns`: short phrases future agents can match.
- `chain`: small ordered steps with tool ids where useful.
- `contextPolicy.maxChars`: usually 1200 to 2200.
- `SKILL.md`: compact workflow instructions, not a long essay.

Quick flow:
1. Search existing skills first: `rg -n "trigger phrase|tool-id" data/skills`.
2. Use `tool-lookup.md` or `tool-doc-read` to confirm exact tool ids and parameter needs.
3. Draft the smallest reusable workflow with clear triggers and tool affinities.
4. If updating, patch the exact sentence or section instead of rewriting the whole skill.
5. Use `skill-context` with a sample request to confirm the right skill is selected.
6. Run focused tests when skill-store or route behavior changes.

Creator-agent lane:
- Use `data/skills/skill-creator-agent/` when the user wants a separate skill-building agent, recursive skill builder, or tool-chain-to-skill workflow.
- The main chat owns the brief, delegation, review, and compact handoff; the delegated creator task owns inspection, drafting, create/update, and proof notes.
- Prove the result with `skill-context` sample prompts before treating a new skill as usable.

Acceptance checks:
- The skill complements tools; it does not duplicate a tool implementation.
- It is specific enough to trigger correctly and small enough to expose safely.
- It names the real verification path.
- It does not store secrets, credentials, or environment-specific tokens.

Longer docs:
- `AI_SKILL_DESIGN_RESEARCH.md`
- `docs/model-prompt-tool-memory-improvement-loop.md`
- `src/agent-sdk/tool-docs/self-reflection-update.md`

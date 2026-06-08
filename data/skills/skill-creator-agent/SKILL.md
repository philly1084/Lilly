Use this skill when the user wants a separate skill-creator agent, skill-building worker, recursive skill builder, or a reusable workflow that chains and combines tools without flooding the main chat with authoring details.

Operating model:
- Treat skills as freedom contracts for future agents: compact workflow, exact tool affinities, boundaries, verification, and recovery.
- Keep skill creation isolated when the user asks for a creator agent or when the workflow needs multiple artifact passes. The requesting chat should receive the brief, decisions, changed files, and proof, not every draft note.
- Prefer updating an existing skill when the request is a refinement. Create a new skill only for a distinct reusable capability.
- A skill may intentionally call tools once or twice against the same artifact when the second pass adds new context, validates a prior pass, or repairs a precise weakness.
- Do not let sub-agents create more sub-agents. The main agent owns delegation, review, and final handoff.

Main-thread workflow:
1. Build a capability brief
   - Capture the user goal, expected future trigger language, affected artifact or repo area, needed tool families, side-effect limits, and acceptance checks.
   - Search registered skills first with `skill-context` or `skill-list`. If a close skill exists, plan an update instead of a duplicate.
   - Inspect exact tool ids and schemas with `tool-doc-read` when a tool chain is non-obvious.

2. Delegate the authoring lane
   - Use `agent-delegate` with one bounded creator task.
   - Pass only the capability brief, relevant existing skill ids, tool ids/docs to inspect, allowed write targets, and proof requirements.
   - Set distinct `writeTargets` for `data/skills/<id>/skill.json`, `data/skills/<id>/SKILL.md`, and any focused tests.
   - Tell the creator agent to return `SKILL_PLAN`, `FILES_CHANGED`, `SAMPLE_PROMPTS`, `PROOF`, and `RISKS`.

3. Creator-agent workflow
   - Read matching skills and tool docs before writing.
   - Decide create vs update.
   - Encode:
     - `description` with when-to-use trigger context.
     - `tools` with exact ids only.
     - `triggerPatterns` from likely user language.
     - `chain` with small ordered steps and tool ids where useful.
     - `contextPolicy` sized to the complexity.
     - `SKILL.md` with terse operating rules, proof loop, and failure handling.
   - For long-form or multi-artifact workflows, define the repeated-pass contract: first pass builds or gathers context; second pass verifies, patches, or synthesizes.
   - Avoid broad global instructions, secrets, raw logs, and one-off notes.

4. Review the artifact with more context
   - Read the created or updated skill back with `skill-read`.
   - Check for duplicate triggers, missing tools, vague steps, unsupported claims, excessive context, and missing proof.
   - Use `skill-update` for precise corrections instead of rewriting unrelated sections.

5. Prove selection and hand off
   - Use `skill-context` with at least two sample prompts:
     - one close to the user's phrase
     - one realistic future task phrase
   - Run focused tests if code, selector behavior, tool allowlists, or routing changed.
   - Return a compact handoff to the requesting chat: skill ids, what changed, sample prompts that select it, checks run, and remaining setup boundaries.

Failure handling:
- If exact tool docs or schemas are missing, search the runtime tool registry before writing the skill.
- If `agent-delegate` is unavailable, do the authoring in the main lane but keep a compact local scratch plan and return only the handoff.
- If the skill does not trigger through `skill-context`, fix trigger patterns or description before calling the work complete.
- If two skills match strongly, keep both only when they express different reusable procedures; otherwise merge into the older or more specific skill.

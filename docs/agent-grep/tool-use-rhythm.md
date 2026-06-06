# Tool Use Rhythm

GREP_HANDLES: AGENT_DOC TOOL_USE_RHYTHM CODEX_TOOL_STYLE EXACT_PATH FIRST_READ_THEN_EDIT VERIFY_SURFACE

Use when:
- An agent needs to work like a careful coding partner, not a generic chatbot.
- The task is vague, multi-step, or touches code, tools, skills, UI, docs, deploys, or live proof.
- You need a reliable order of operations before acting.

Default rhythm:
1. Orient with cheap facts: `git status --short`, `rg --files`, and targeted `rg -n "exact phrase|symbol|route"`.
2. Read the smallest relevant slices before deciding. Prefer files, tests, and tool docs over memory or guesses.
3. Separate the exact user complaint from nearby noise. Reproduce or trace that path first.
4. Pick the narrowest tool chain that can finish the job.
5. Before edits, know the ownership surface and nearby patterns.
6. Edit with `apply_patch` for manual code/docs changes.
7. Run focused checks tied to the changed surface.
8. For visual work, run browser or `kimibuilt-ui-check` proof.
9. For remote/deployed work, prove rollout, runtime logs, public URL, and UI when relevant.
10. Finish with changed files, checks run, and any real blocker.

Tool habits:
- Use `rg` before broad reads.
- Use parallel reads for independent files.
- Use `tool-doc-read` before calling an unfamiliar tool.
- Use `design-resource-search` before design-sensitive artifacts.
- Use `skill-context` before inventing new instructions.
- Use `managed-app` for GitLab-observable app/source/build/deploy loops.
- Use `remote-cli-agent` for remote build/deploy loops, not ad hoc local guesses.
- Use `remote-command` for one-off remote status, logs, kubectl, and network checks.
- Use `docs/agent-grep/remote-tools.md` before mixing `managed-app`, `remote-cli-agent`, `remote-command`, `remote-workbench`, and `k3s-deploy`.
- Use `self-reflection-update` only for bounded durable updates and dry-run first when unsure.

Do not:
- Do not rewrite unrelated files.
- Do not trust static docs over runtime catalog/readiness.
- Do not claim live/browser proof from repo-only evidence.
- Do not ask the user for choices when a safe default and verification path exist.
- Do not bury blockers in a questionnaire.

Good final answer shape:
- What changed.
- Where it changed.
- What proof ran.
- What is still blocked, if anything.

Good grep targets:
- `docs/agent-grep/grep-quickstart.md`
- `docs/agent-grep/tool-lookup.md`
- `docs/agent-grep/remote-tools.md`
- `docs/agent-grep/build-and-verify.md`
- `src/agent-sdk/tool-docs/tool-doc-read.md`
- `src/agent-sdk/tool-docs/remote-cli-agent.md`

# Adding Tools

GREP_HANDLES: AGENT_DOC ADDING_TOOLS NEW_TOOL TOOL_DOC_UPDATE TOOL_REGISTRY TOOL_SUPPORT TOOL_PROFILE

Use when:
- Adding a new backend tool.
- Changing a tool id, parameter contract, readiness, category, or frontend exposure.
- A tool exists in code but agents cannot discover or use it reliably.

Minimum update set:
1. Register the tool in the live registry path.
   - Class tools usually live under `src/agent-sdk/tools/categories/<category>/`.
   - Registration usually lands in `src/agent-sdk/tools/categories/<category>/index.js` or `src/agent-sdk/tools/index.js`.
2. Add or update tool docs.
   - Create `src/agent-sdk/tool-docs/<tool-id>.md`.
   - Keep it short: purpose, use when, key params, examples, failure modes.
3. Add support/readiness metadata.
   - Update `TOOL_SUPPORT` in `src/agent-sdk/tool-docs/index.js`.
   - Add runtime support in `src/agent-sdk/tool-docs/runtime-support.js` when setup or live runtime matters.
4. Add execution profile visibility.
   - Update `src/tool-execution-profiles.js` if the tool should be available to chat, remote build, podcast, notes, or other profiles.
5. Add focused tests.
   - Registry/execution: `src/agent-sdk/tools/index.test.js`.
   - Route/catalog exposure: `src/routes/tools.test.js` when frontend/admin discovery changes.
   - Tool-specific file tests near the implementation when logic is non-trivial.
6. Update grep docs only when the tool changes workflow guidance.
   - `docs/agent-grep/tool-lookup.md` for broadly useful tool ids.
   - `docs/agent-grep/design-research.md` for design or visual tools.
   - `docs/agent-grep/build-and-verify.md` for build, deploy, or proof tools.
   - `docs/agent-grep/skill-authoring.md` for skill lifecycle tools.

Tool doc template:

```markdown
# <tool-id>

Purpose: one sentence.

Use when:
- Short trigger case.
- Short trigger case.

Key params:
- `param`: what it controls.

Example:
```json
{"param":"value"}
```

Failure modes:
- Missing setup.
- Bad input shape.
- Runtime unavailable.

Verification:
- Focused test or route to check.
```

Do not:
- Do not add a tool without a grepable doc if another agent will need to discover it.
- Do not rely on `TOOLS_COMPLETE.md` as the source of truth.
- Do not expose write/deploy tools to every execution profile by default.
- Do not invent trigger phrases that hide the exact tool id.

Acceptance checks:
- `GET /api/tools/available?includeAll=true` shows the tool when expected.
- `GET /api/tools/docs/<tool-id>` returns the doc.
- `tool-doc-read` can load the doc.
- Focused tests cover registration and a success or failure path.

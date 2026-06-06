Use this skill when the user asks to create, update, register, test, or improve Lilly skills, or asks for agents that can build and use recursive skills.

Operating model:
- Skills complement tools. A skill is the low-context workflow contract; a tool performs the concrete effect.
- Search existing skills first. Update the closest skill when the workflow is a refinement; create a new skill only for a distinct reusable procedure.
- Keep skills compact, actionable, and honest about runtime boundaries.
- Trigger phrases must match likely user language, not only internal labels.

Workflow:
1. Search existing registered skills by user phrase, domain, and tool ids.
2. Decide:
   - update existing skill
   - create new skill
   - no durable skill needed
3. Draft the skill with:
   - id
   - name
   - description
   - tools
   - triggerPatterns
   - chain steps
   - operating model
   - proof loop
   - failure handling
4. Create or patch exactly one compact skill unless the user asked for a bundle.
5. Verify with `skill-context` sample prompts and, when code changed, focused tests.
6. Report selected skill ids and why they match.

Do not use self-reflection or durable writes for vague preferences, secrets, raw logs, or one-off task notes.

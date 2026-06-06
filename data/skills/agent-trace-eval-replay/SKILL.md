Use this skill when the user asks to replay a session, grade agent behavior, debug tool choice, create evals, compare prompts, inspect alignment feedback, or turn a failure into a regression fixture.

Operating model:
- Evidence comes from the actual trace/session/fixture/test output, not from memory of what should have happened.
- Grade the whole loop: prompt framing, tool availability, tool selection, params, progress events, user checkpoints, final answer, and proof quality.
- Do not write durable lessons for one-off noise. Store only stable, reusable lessons.

Workflow:
1. Locate the relevant session id, trace file, regression fixture, feedback item, or failing test.
2. Extract the minimal evidence window: user request, route decision, selected skills, planned tools, actual tool calls, tool outputs, errors, verification evidence, and final answer.
3. Classify:
   - correct route or wrong route
   - expected tools versus actual tools
   - missing or misused tools
   - evidence sufficient, weak, missing, or contradicted
   - safety/secret/privacy issues
   - completion discipline
4. If patching is requested, update the smallest prompt, route, tool, skill, or test seam that makes the desired final state more true.
5. Add or update a focused regression fixture when the failure is reusable.
6. Run focused tests or eval scripts and report pass/fail evidence.

Return:
- `TRACE_SOURCE`
- `EXPECTED_ROUTE`
- `ACTUAL_ROUTE`
- `EXPECTED_TOOLS`
- `ACTUAL_TOOLS`
- `FINDINGS`
- `PATCH`
- `EVALS_OR_TESTS`
- `LESSON`

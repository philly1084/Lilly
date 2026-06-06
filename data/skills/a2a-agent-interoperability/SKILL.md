Use this skill when the user asks for A2A, Agent2Agent, agent cards, agent discovery, external agent delegation, cross-agent streaming, or making Lilly interoperable with other agent systems.

Operating model:
- A2A is for agent-to-agent task contracts. MCP is for tools/data/workflows. Keep those roles separate unless the user explicitly asks for both.
- Design around agent discovery, task state, streaming updates, artifacts, auth, cancellation, and error handling.
- Treat external agents as untrusted until identity, auth, capability, and data scope are verified.

Workflow:
1. Determine direction: expose Lilly, consume another agent, or broker between agents.
2. Identify the agent card fields: provider, capabilities, skills, interfaces, auth schemes, documentation URL, and supported modalities.
3. Define task semantics: send message, stream message, get task, list tasks, cancel task, subscribe, artifacts, and push notifications if needed.
4. Add security rules: identity verification, least-privilege credentials, per-task authorization, audit logging, and user approval for high-impact actions.
5. If building code, generate schemas and route contracts before implementation.
6. Verify with at least one discovery/card check and one task lifecycle smoke test.

Return:
- `A2A_ROLE`: expose, consume, or broker
- `AGENT_CARD`
- `SKILLS`
- `AUTH`
- `TASK_FLOW`
- `ARTIFACTS`
- `STREAMING`
- `SECURITY`
- `VERIFICATION`

Do not claim live A2A support until an agent card and task smoke test are reachable from the intended client.

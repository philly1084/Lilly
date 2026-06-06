Use this skill when a user asks to connect Lilly to an MCP server, expose external data/tools through MCP, review an MCP server, or add a connector-style capability.

Operating model:
- Treat MCP as a connector protocol, not as a magic permission bypass. The agent still needs explicit auth, tool scope, data boundaries, and approval rules.
- Prefer official MCP server docs, repository manifests, and vendor setup pages over blog summaries.
- Separate discovery from installation. First identify the server, its transport, auth, tools, resources, prompts, and side effects; only then install or configure it.
- Never paste secrets into chat, manifests, skill bodies, screenshots, or docs. Use configured secret stores or environment variables.

Workflow:
1. Name the target system and candidate MCP server. If no server is known, search current official sources and list two or three candidates with provenance.
2. Fetch source docs and record transport, package/install command, config fields, auth method, tool list, resource list, prompt list, and expected smoke test.
3. Classify risk: read-only, writes local files, writes remote systems, executes code, deploys, sends messages, or exposes private data.
4. Define approval gates for high-impact tools and credential-bearing flows.
5. If implementation is requested, use the appropriate remote or local build lane. Keep config files reviewable and route secrets through environment/secret references.
6. Verify with a deterministic tool-list or smoke action and return a connector card:
   - `MCP_SERVER`
   - `TRANSPORT`
   - `TOOLS`
   - `RESOURCES`
   - `PROMPTS`
   - `AUTH`
   - `RISKS`
   - `SETUP`
   - `SMOKE_TEST`
   - `ROLLBACK`

Do not claim Lilly can use an MCP connector until the server is installed/configured and a tool-list or smoke test proves it.

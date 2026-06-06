Use this skill when the user asks for Gmail, Google Calendar, Slack, Jira, Linear, Notion, Drive, GitHub/GitLab workflow connectors, CRM/admin tools, or other daily-work app integrations.

Operating model:
- Start with the workflow, not the API. Clarify whether the user wants search/read, summarize, draft, create, update, send, schedule, or delete.
- Treat message sending, calendar edits, ticket creation, repo changes, and CRM/customer updates as high-impact writes requiring confirmation.
- Use least-privilege auth scopes and never store or reveal tokens in generated docs, chat, screenshots, or code.
- If the connector is not installed/configured, produce a connector card and setup path rather than pretending the action ran.

Workflow:
1. Identify app, action, target account/workspace, data class, and write impact.
2. Check existing tools, configured connectors, public-source catalog, or official docs.
3. Define auth scopes, secrets path, audit events, retention rules, and approval gates.
4. For read workflows, constrain queries and summarize with source links or item ids.
5. For write workflows, draft the exact action first, ask for approval, then execute through the configured connector.
6. Return proof: item id, URL, timestamp, actor, changed fields, and rollback/cancel path where available.

Connector card fields:
- `APP`
- `WORKFLOW`
- `AUTH_SCOPES`
- `READS`
- `WRITES`
- `APPROVALS`
- `SETUP`
- `SMOKE_TEST`
- `AUDIT`
- `ROLLBACK`

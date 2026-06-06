# Modern Agent Capability Map

Read-only tool for checking Lilly's modern agent capability lanes.

Use this when the user asks what modern AI tools or skills Lilly has, what she is missing, or how to route work involving:

- MCP connector bridges
- A2A agent interoperability
- computer or browser use
- trace replay and agent evals
- daily-work app connectors
- native office document round trips
- agent tool security governance
- skill authoring

## Inputs

```json
{
  "capability": "optional search string",
  "includeBody": false
}
```

Aliases: `id` and `query` behave like `capability`.

## Output

Returns:

- `capabilities[]`: capability id, label, status, runtime boundary, proof requirement, registered skill metadata, and trigger phrases.
- `count`: number of returned capability lanes.
- `registry`: skill registry summary.

## Rules

- This tool is a catalog and routing aid. It does not install connectors, expose A2A endpoints, control a desktop, or run external app actions by itself.
- Treat `status:"skill_registered"` as workflow coverage, not proof that the external integration is live.
- To claim a capability is live, run the proof described in the returned `proof` field.

# Private task MCP bridge

`createTaskMcpBridge` exposes only the trusted Responses function definitions and
dispatcher passed by the Lilly worker. It is a library: construction opens one
ephemeral loopback HTTP listener but never starts a Grok process, model call, or
automatic agent task. Close the bridge at the end of each task.

```js
const { createTaskMcpBridge } = require('./task-mcp-bridge');
const bridge = await createTaskMcpBridge({
  tools, // [{ type: 'function', name, description, parameters: JSONSchema }]
  dispatch, // async (name, args, { callId, signal }) => result
  signal: taskAbortSignal,
  onEvent: safeActivitySink,
  maxCalls: 32,
  deadlineMs: 120000,
});
try {
  // This descriptor contains a secret bearer token; only pass it to the worker.
  await grok.openSession({ mcpServers: [bridge.mcpServer] });
} finally {
  await bridge.close();
}
```

Dispatcher results have `{ publicResult, privateModelContent? }`. Public results
must be bounded JSON and cannot contain image URLs, binary buffers, or private
model content. Private model content accepts a bounded Responses `input_text`
and exactly one `input_image` containing a canonical PNG/JPEG/WebP base64 data
URL. The bridge converts that frame to an MCP image block in the authenticated
tool response. It does not fetch image URLs or publish screenshots into events.
The caller remains responsible for frame provenance and current task ownership.

`mcpServer` follows ACP's HTTP MCP descriptor (`type`, `name`, `url`, `headers`).
It must not be logged, saved as an artifact, or sent to the operator frontend.
The 256-bit bearer token is unique to this endpoint and is revoked when it
closes. Incoming caller identity/permission context is never passed to dispatch;
that callback receives only generated `callId` and an abort signal. Top-level
identity/permission argument names are rejected, and tool JSON schemas are
validated before dispatch. Nested command/resource identifiers are ordinary
tool data, not authority; the bound dispatcher must enforce its own scope.

All browser Origin headers are denied, Host must match the bound listener, no
CORS policy is opened, and nonloopback bind addresses are rejected. The default
request body is 64 KiB; configurable result budget defaults to 8 MiB. Bodies,
connections, request count, tool calls, and task lifetime are bounded. Dispatch
is serialized through actual promise settlement, with unique server-generated
call IDs. Abort or close prevents queued work from starting. Closing revokes
the HTTP endpoint immediately and signals in-flight work but cannot undo a
completed side effect or forcibly stop a dispatcher that ignores cancellation.
The supervisor must handle that case and preserve idempotency at its durable
write boundary.

`getStatus()` returns only `{ closed, pendingCalls, calls }`. Pending calls count
queue admission through actual operation settlement, including a dispatcher that
ignores abort. `close()` returns `{ settled: boolean }` after closing network
access; `false` requires task reconciliation, not a completed-turn claim. A later
`getStatus()` or repeated `close()` reflects actual settlement. Closing the Grok
process does not prove that an external Lilly dispatcher has stopped.

Events contain only fixed event types, trusted `tool` name, generated call ID and
status. No arguments, results, private content, tokens or raw errors are emitted.
Tool start and finish events are awaited checkpoints bounded by the task deadline
and `eventTimeoutMs` (default 5 seconds, maximum 30 seconds). A failed checkpoint
revokes the endpoint; the abort guard is rechecked before dispatch so an expired
claim cannot race its heartbeat. Lifecycle notifications remain best-effort.
Tool exceptions become generic MCP error results. There is no resource service,
sampling, or model capability.

## SDK and verification

Implementation was based on the installed SDK's `server/streamableHttp.d.ts`,
`server/index.d.ts`, `validation/ajv-provider.js`, and
`examples/server/simpleStatelessStreamableHttp.js`. It uses the SDK's stateless
Streamable HTTP transport and low-level Server API to preserve supplied JSON
Schema definitions without inventing a wire format. Every HTTP request creates
its own SDK transport/server; task authorization and serialization belong to
the enclosing bridge. Tests connect the installed SDK's actual HTTP client to
the local listener, not a mocked transport.

The inspected installed SDK reports **1.29.0**, while Lilly's package manifest
requests `^1.30.0`. These local tests establish the installed version's behavior;
run the same tests after a clean dependency install before release.

```sh
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/grok-build/task-mcp-bridge.test.js
```

## Container boundary

A loopback address in Lilly's container is not reachable through another
container's loopback. Run the bridge and Grok in the same isolation boundary,
or introduce a separately reviewed, authenticated bridge with controlled
network routing. Do not change the bind address to `0.0.0.0` or publish this
ephemeral endpoint to the internet as a shortcut. Network isolation does not
replace task ownership, per-tool permissions, budgets, or approval checks.

Grok's built-in shell/filesystem tools remain separate from this MCP allowlist.
Their sandbox and policy must be independently enforced. Passing only Lilly
MCP tools does not disable other capabilities of the Grok runtime.

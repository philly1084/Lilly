# Agent Company execution contract

`AGENT_DOC: COMPANY_EXECUTION`

Company runs receive `AgentCompanyExecution/v1` as framework instructions, with
the registered tool navigation map, model/effort, workload/run/goal identity and
the actual side-effect policy. Generic operating rules are not the user objective:
example domains and deployment guidance must not redirect a research goal.

1. Inspect the current goal, existing projects and relevant whiteboard evidence.
2. Read `tool-doc-read` for an unfamiliar tool's exact parameters.
3. Use `remote-cli-agent` for stateful implementation, `remote-command` for a
   bounded command, and `remote-workbench` for structured repository operations.
   Only the inner CLI uses `remote_code_run` and `remote_code_status`.
4. Let the gateway select the target's default cwd. Supply an absolute Linux
   path only after verifying it on that target. Never reuse terminal output as
   a path, or carry job/session identity to a different target.
5. Preserve returned job/session IDs and poll running work. The framework stores
   the cursor on the workload, scoped to its goal, rather than inheriting another
   role's shared-session cursor. Record goal, owner,
   target, cwd, job, changes, checks, blockers and next owner/action in the
   existing shared whiteboard. Backend file tools and remote filesystems are
   different; verify read-back at the intended surface.
   An interrupted stream or status timeout is an observation failure, not a
   cancelled job. When `observationStatus: unavailable` is returned, retain the
   same cursor and recheck it; do not launch duplicate work.
   Persist the original `remoteAgentHandoff` snapshot with that job, without
   inline file content. Polls reuse its isolated result manifest; they must not
   create another operation ID or re-export inputs. Missing inputless
   continuations require recovery or a newly approved handoff.
   Codex's native `thread.started` ID is the coding session used for a later
   resume; `gatewaySessionId` identifies only the gateway transport. Keep both
   separate and use the current job ID for polling unfinished work.
6. A failed/blocked terminal outcome fails the company run even if the model
   claims success. Two identical failures stop automatic long-agent continuation.
   Diagnose a changed recovery path or request the missing user-owned decision.
7. Deliver a normal user-facing reply with clickable links, verified changes,
   checks and unfinished work. An HTML status brief is not implementation proof.
8. Distinguish requested effort from applied effort. Only an authenticated
   gateway `reasoningEffortReceipt` with `status: applied` and
   `appliedTo: cli-invocation` proves which effort reached the CLI; a forwarded
   request or a model's text is not confirmation. Codex effort settings must not
   leak into Kimi or other provider requests.

Implementation: `src/agent-ops/execution-contract.js`,
`src/remote-cli/workspace-contract.js`, `src/workloads/service.js`.

Regression check:

```sh
node node_modules/jest/bin/jest.js --runInBand --coverage=false src/agent-ops/execution-contract.test.js src/remote-cli/workspace-contract.test.js src/remote-cli/agents-sdk-runner.test.js src/workloads/service.test.js src/conversation-orchestrator.test.js
```

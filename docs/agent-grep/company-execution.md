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
5. Preserve returned job/session IDs and poll running work. Record goal, owner,
   target, cwd, job, changes, checks, blockers and next owner/action in the
   existing shared whiteboard. Backend file tools and remote filesystems are
   different; verify read-back at the intended surface.
6. A failed/blocked terminal outcome fails the company run even if the model
   claims success. Two identical failures stop automatic long-agent continuation.
   Diagnose a changed recovery path or request the missing user-owned decision.
7. Deliver a normal user-facing reply with clickable links, verified changes,
   checks and unfinished work. An HTML status brief is not implementation proof.

Implementation: `src/agent-ops/execution-contract.js`,
`src/remote-cli/workspace-contract.js`, `src/workloads/service.js`.

Regression check:

```sh
node node_modules/jest/bin/jest.js --runInBand --coverage=false src/agent-ops/execution-contract.test.js src/remote-cli/workspace-contract.test.js src/remote-cli/agents-sdk-runner.test.js src/workloads/service.test.js src/conversation-orchestrator.test.js
```

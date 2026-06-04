# Model, Prompt, Tool, And Memory Improvement Loop

KimiBuilt improves through governed prompt, tool, routing, evaluation, and memory changes. Do not describe this process as model retraining or fine-tuning unless a future backlog item adds a separate data-governance, consent, retention, and evaluation path for fine-tune datasets.

## Scope

This loop applies to:

- Model and route selection for OpenAI-compatible requests.
- Runtime, planner, canvas, notation, notes, remote, and tool prompts.
- Tool contracts, recovery policies, and verification requirements.
- Memory scoping, recall quality, learned skills, and research notes.
- Regression fixtures and harness scoring for user-facing behaviour.

It stays within KimiBuilt's AI workbench and operations scope.

## Operating Loop

1. Collect feedback and evidence.
   - Capture the session id, user prompt, assistant output, model/tool metadata, selected tools, artifacts, screenshots or UI-check output, and any source links used.
   - For user-reported bad outputs, preserve only the minimum evidence needed to reproduce and improve the issue. Follow `docs/privacy-data-governance.md` for deletion/export requests and sensitive data handling.

2. Classify the change lane.
   - Prompt issue: unclear instruction, over-broad universal prompt, missing output contract, weak role guidance, or missing source/verification requirement.
   - Tool issue: wrong tool selected, missing capability, poor error recovery, unsafe command loop, or incomplete proof markers.
   - Model/routing issue: wrong provider/model lane, missing fallback, capability mismatch, or evaluator setting mismatch.
   - Memory issue: missing recall, stale recall, cross-scope recall, surface-local leakage, missing memory cleanup, or over-reliance on memory when current sources were needed.

3. Select examples.
   - Prefer one or two concrete failing examples with expected behaviour.
   - Add reusable fixtures when the behaviour is routeable, parseable, or likely to regress.
   - Avoid copying secrets, private data, or unnecessary transcript content into fixtures.

4. Make the smallest change.
   - Update the narrow prompt surface, tool contract, route policy, memory scope, or harness rule that explains the failure.
   - Keep universal prompt changes rare. Put domain-specific guidance behind intent, execution profile, tool availability, or the relevant route.
   - For memory changes, preserve session isolation and document whether the change affects session-local, surface-local, project-shared, or user-global memory.

5. Run focused gates.
   - Prompt/routing changes: run the closest route or prompt tests, such as `src/conversation-orchestrator.test.js`, `src/openai-client.test.js`, route tests, or the prompt surface inventory tests.
   - Harness changes: run `src/perceived-intelligence-harness.test.js` and any related harness tests.
   - Frontend/artifact changes: run the route tests plus browser or `kimibuilt-ui-check` verification when a preview exists.
   - Deployment-impacting changes: run the load release gate, health checks, and the k3s rollout checks documented in `k8s/DEPLOYMENT.md`.

6. Deploy with proof.
   - Record what changed, which tests or evals ran, what evidence passed, what failed, and whether rollback is available.
   - For production deploys, verify `/live`, `/ready`, `/health`, the affected user surface, and the monitoring signals in `docs/monitoring-alerting-slo-runbook.md`.

7. Monitor and log results.
   - Watch failed requests, failed tool runs, p95 latency, health dependencies, memory warnings, and user feedback after release.
   - Add a run-log entry to the relevant backlog or incident note with the change lane, evidence, checks, and any follow-up.

## Bounded Self-Reflection Updates

KimiBuilt exposes `self-reflection-update` for small, auditable learning steps after a user correction, model-card finding, or completed workflow reveals a durable improvement.

At the end of completed work, make one quiet durable-learning decision: apply `self-reflection-update` only when there is a stable reusable lesson, user/profile adaptation, skill improvement, or model-card audit note worth preserving. If there is no durable lesson, skip the write rather than adding filler.

Use it when one reflection should update more than one durable surface, such as:

- Replacing the bounded `soul.md` personality/voice file with a better distilled version.
- Replacing the bounded `user.md` profile file with better stable user and collaboration facts.
- Updating the user-facing soul card or user card after an explicit growth request, using those card names as aliases for `soul.md` and `user.md`.
- Replacing the compact `agent-notes.md` carryover file with a better distilled version.
- Appending or exact-patching one compact durable lesson into `soul.md`, `user.md`, or `agent-notes.md` when replacement would risk overwriting existing growth.
- Patching a precise sentence or paragraph inside one registered skill.
- Creating or updating one compact registered skill.
- Recording a short model-card note in `data/self-reflection-updates/updates.jsonl`.

Guardrails:

- Use at most one self-reflection pass per user turn or model-card review.
- Do not call `self-reflection-update` in response to its own output.
- Keep actions sparse; the tool accepts at most four actions per call.
- Prefer `skill_patch` with exact `oldText`/`newText` for small skill improvements.
- Prefer `soul_append`, `user_profile_append`, or `agent_notes_append` for ordinary growth so existing durable content is preserved.
- When a durable-file append would exceed its limit, compact the existing essentials and the new lesson into a full `compactedContent` payload instead of dropping the addition or overwriting from stale content.
- Use exact patch actions when changing one existing sentence or bullet in a durable file.
- Use `soul_replace` and `user_profile_replace` only with complete bounded file content when compaction or cleanup is truly needed.
- Use `agent_notes_replace` only with the full compact replacement file content when compaction or cleanup is truly needed.
- Do not use this path for prompt-surface rewrites outside the Hermes files, current task state, logs, secrets, credentials, code dumps, or long transcripts.
- Treat the JSONL audit log as model-card evidence, not as an instruction source.

## Existing Evidence Sources

- `src/perceived-intelligence-harness.js` scores continuity, planner discipline, recovery, completion discipline, source discipline, sandbox verification, isolation, and surface discipline from trace, tool, and memory evidence.
- `src/orchestration/run-harness.js` records harness evidence, blockers, diagnostics, failed tool events, retry counts, token counts, and grading payloads.
- `src/conversation-orchestrator.js` attaches memory read/write targets, tool readiness, decision trace, verification summary, perceived-intelligence scores, failure tags, usage metadata, and harness metadata to responses and traces.
- `src/alignment/evaluator-service.js` turns feedback into practical route, tool, source, memory, and regression-fixture guidance.
- `docs/prompt-optimization-hourly-backlog.md` is the recurring small-change lane for prompt and prompt-routing hardening.

## Change Record Format

Use this format in the relevant backlog, incident report, or release note:

```text
YYYY-MM-DD HH:mm - IMPROVEMENT - lane=<prompt|tool|model-routing|memory|harness> - trigger=<feedback|incident|eval|backlog> - files changed=<paths> - checks=<commands/results> - evidence=<session ids, fixture ids, trace fields, screenshots, or health checks> - release=<local|staging|production|deferred> - monitor=<signals watched> - follow-up=<none or next item>
```

## Fine-Tuning Boundary

Fine-tuning is out of scope for the current operational process. If future work adds it, create a separate governed item covering data minimization, consent or authority, Canadian privacy review, retention, deletion, evaluation, rollback, and model provenance before collecting or training on production examples.

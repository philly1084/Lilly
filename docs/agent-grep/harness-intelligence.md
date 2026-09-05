# Harness outcome verification and learning

Completion means the requested state has been observed. Missing tests, missing schemas,
missing embeddings, command names, remote-agent prose and artifact creation are not validation.

## Completion criteria

Criteria accept `text`, `target`, `expectedState`, `verificationMethod` and `evidenceTypes`.
Use the exact artifact ID/path or deployment identity as `target`. Evidence must match all
specified fields. Validation criteria accept validation evidence, not creation evidence.
Restored checkpoints recompute completion from evidence rather than trusting old status flags.

Runtime-signed `EvidenceAttestation/v1` records map to typed completion evidence. Remote command
exit codes and fetched source content are converted at the runtime boundary. Remote-agent
completion prose remains an observation until independent evidence is available.

The SDK verifier accepts matching test attestations or invokes a registered `test-run` tool.
That tool must return an integer `exitCode`; unavailable execution is unverified. Similarity
uses the configured embedder's cosine similarity and fails closed when embeddings are unavailable.

## Learning

A reusable workflow requires satisfied criteria linked to passing attestations. Failed attempts
remain failure history; a later verified recovery can be learned with the failed attempt labeled.
Workflow records retain evidence IDs, source run, verification time and a 30-day revalidation date.
Expired or older unverified workflow summaries are excluded from automatic skill recall.

## Context and evaluations

Intent classification distinguishes explanation from action and preserves explicit negations.
Ambiguous follow-ups use bounded recent context and validated structured model output, with a
deterministic fallback. Model classification cannot introduce delegation or scheduling authority.
The SDK planner receives runtime instructions and bounded recent messages before planning.

Run repeated model-backed filesystem tasks inside isolated workspaces:

```sh
node scripts/harness-task-trials.js src/agent-evals/outcome-cases.json src/agent-evals/sandbox-adapter.js /tmp/harness-evals/report.json
```

The runner tests artifact revision, source preservation, transient failure recovery and checkpoint
continuation. It independently reads final files, records every trial, and measures verified and
false completion. Unknown model cost remains unknown. Existing broader agent evals remain the
release framework for research, browser, deployments and isolation.

Daily feedback runs baseline and candidate trials before applying a safe note. Promotion requires
matching task sets, at least three trials, measurable improvement and no outcome regression.
Repeated lessons are deduplicated. Trial artifacts and comparisons live under the runtime state
directory's `harness-trials/`. A rejected candidate stays unapplied.

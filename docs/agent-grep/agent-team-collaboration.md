# Lilly teammates and direct collaboration

GREP_HANDLES: AGENT_DOC TEAM_COLLABORATION GROK_BOT SHARED_CONTEXT

Purpose: make the Admin command centre carry useful work between persistent teammates through Lilly's existing runtime.

## Research basis (checked September 5, 2026)

Grok Bot describes persistent named agents sharing a user-scoped computer, files and browser logins, with separate screens. Agents exchange messages and context, and hand ownership to one another. Connectors/MCP serve applications with APIs; computer use covers the remainder. These are published product behaviors, not a disclosure of the internal scheduler implementation. Source: https://docs.x.ai/grok-bot/overview

The launch article describes a lead agent coordinating specialists, direct messages and group conversations, and routines learned from demonstrations. The useful model for Lilly is a lead teammate owning the outcome while specialists perform bounded work and return results. Source: https://x.ai/news/introducing-grok-bot

Grok Build describes explicit phases, focused worker contexts, independent verification, persisted progress, and synthesis into one result. Lilly should adopt those controls for finite projects without assuming that simply increasing the agent count improves quality. Source: https://x.ai/news/workflows

## Current evidence and repair

- The Admin project observed in the browser is Function Before Form. Its current mission asks for a testable way to make $1,000/day online. The visible Strategy Lead run was cancelled, Handoffs was empty, and 16 prior artifacts remained. This is a snapshot, not evidence that those artifacts satisfy the mission.
- Company workloads already call `ConversationRunService.runChatTurn`, which invokes the conversation runtime. A browser relay through Web Chat is therefore unnecessary for execution itself.
- Company execution disables recent/context message loading and resets the provider response cursor to prevent cross-workload CLI state contamination. Shared notes are stored in the project transcript, but were not explicitly passed into those isolated turns.
- `agent-ops/collaboration-context.js` now supplies a bounded packet of relevant operator notes and recent run observations from the same project and goal. The packet includes artifact links and preserves pending status. It does not transfer execution cursors. New notes carry the goal hash. Legacy notes without a goal hash remain project scoped; they cannot be reliably attributed to an earlier goal.
- The packet reads the latest 120 messages, at most 12 matching workloads and three runs per workload; it includes at most eight notes and six handoffs within a 16,000-character JSON budget. It is recent coordination context, not an exhaustive durable knowledge store. Storage failures propagate instead of silently running without the context.
- The command centre now opens with a conversation showing actual messages and result links. Run logs remain available in a collapsed details panel. Drafts are retained per project and agent across polling and selection; they are not persisted across a page reload.

## How to use the current flow

Open Admin > Agent Command Center, retain the existing project, and message the lead with one concrete outcome and acceptance criteria. Use a shared-board note for a correction that applies to the crew. Select an individual teammate for a task-specific continuation. Review the actual linked file or site when the agent reports completion.

Example continuation for this project's existing work: "Read the existing project artifacts. Identify the strongest documented experiment and the evidence it still lacks. Hand the reviewer a specific artifact and a bounded verification task. Preserve existing deliverables. Return the artifact link, what was checked, the blocker, and the next owner. Do not represent projected revenue as achieved income."

The conversation and packet repair do not yet implement a complete Grok Bot equivalent. Do not advertise a fully autonomous team solely from these changes.

## Next integration gates

1. A lead-owned task creates explicit dependency edges and assigns bounded work, with a single writer for each file or deployment target.
2. Completion events immediately make dependent work runnable. Heartbeats provide recovery and liveness rather than being the only handoff trigger.
3. Named role sessions retain their own conversation and target-bound execution state, while project messages and artifact references are shared deliberately. Project browser sessions and remote files need explicit access and location contracts; two cluster hosts are not one filesystem.
4. The lead consumes worker results, requests independent verification, and returns one usable answer. No goal completes based only on prose, an artifact count, or a finished polling run.
5. Compare the same bounded task through the current successful browser workflow and the direct flow. Record result quality, file read-back, verification, elapsed time and usage before claiming improvement.

Acceptance proof must include a real current-project instruction, persisted handoff, receiving worker context, an independently readable result, and visible Admin read-back after deployment. Local fixtures and passing UI checks do not establish that live proof.

# User

## Phil
- Works with KimiBuilt as a hands-on implementation, debugging, live-ops, and product-building partner.
- Prefers concrete evidence, exact files/routes/commands, and verification of the real user-facing or deployed path.
- Wants the assistant to feel like a capable personal agent and collaborative partner while staying grounded and useful.
- Steers with short, concrete corrections and expects the agent to adapt quickly.

## Collaboration Defaults
- Reproduce concrete failures before theorizing when a failing prompt, route, browser symptom, pod log, endpoint, or rendered output is provided.
- Preserve known-good baselines while isolating regressions.
- Continue through implementation and verification when the request implies action.
- Keep updates warm, concise, and evidence-backed.
- Separate root cause from nearby noise instead of flattening adjacent issues together.
- For live or deployed work, prefer live browser, endpoint, cluster, or remote proof over local-only reassurance.

## Memory Boundaries
- Store durable user-wide preferences and collaboration patterns here.
- Keep project mechanics, commands, and operational defaults in `agent-notes.md`.
- Do not store secrets, credentials, raw logs, transcripts, sensitive personal data, or one-off task state.

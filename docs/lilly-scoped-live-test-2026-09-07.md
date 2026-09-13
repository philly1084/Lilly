# Scoped live test and gateway recovery — 2026-09-07

The initial test could not reach the configured model gateway: DNS resolved,
but TCP returned ECONNREFUSED because the Service had no ready endpoints.
Its init containers were stuck pulling an unavailable GHCR tag (403).

Recovery used the locally cached main image whose RepoDigests included the
deployed digest `sha256:479c0cff09d0c3fc1264c5e6c9301abf9f3162f245069ede3f342993fee1a6d0`.
It was imported into k3s as `localhost/lilly-gateway-recovery:82e849f73104` and
used for the main and init containers. The guarded patch verified that all
non-image deployment settings were preserved. Root-only rollback snapshot:
`/root/lilly-gateway-recovery.OPBd1b/deployment-before.json`.
The rollout completed and Lilly's authenticated `/v1/models` request returned 200.
Registry access itself is not repaired: this recovery depends on the cached image.

## Approved retest

- Proof: `8f672f1b-65ad-4fa3-8f6a-ecf8230d53e2`.
- One agent, one task, three model calls, 60-second task budget.
- Model: `kimi-for-coding`; no browser, external tools or deployment tools.
- Real deployed TeamRunner/worker, isolated PostgreSQL schema and filesystem
  artifact adapter; session metadata used a scoped adapter.
- Saved artifact: `99608746-4b59-4073-a7b0-7d2a6c5115c4`, 36 bytes.
- SHA-256: `f2099f6922c1e6e13a774567b4489e738ef0dab123dbff1e4a2e42c9d2503e04`.
- Independent file read-back matched the expected marker and hash.
- Task status `needs_review`, not falsely marked reviewed/complete.
- Shutdown settled, no pending tasks; global scheduler remained disabled.
- Report and artifact retained under the backend data directory
  `/home/kimibuilt/.kimibuilt/lilly-live-test-qOdHj8`.

This proves the bounded Lilly model/tool/artifact path, not Grok execution,
private-browser operation, multi-agent collaboration or production artifact UI.
The first failed test remains retained and disabled; it was not replayed.
Safe exception-category recording was fixed and tested locally but has not been
included in the deployed backend image yet.

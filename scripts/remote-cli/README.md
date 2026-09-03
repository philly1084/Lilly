# Codex remote wrapper

`codex-remote-run.sh` is the source of the `/usr/local/bin/codex-remote-run`
adapter installed on the primary and secondary agent hosts. The nuts gateway's
remote session bridge invokes it over SSH; it is not a second model router.

The adapter preserves model, target-selected sandbox, provider session and exact
prompt text. An optional validated `--reasoning-effort high` becomes the Codex
config argument `-c model_reasoning_effort=high` for new and resumed sessions.
Omission leaves Codex defaults unchanged. The standalone acknowledgement line
`GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=high` reports the CLI invocation only;
it does not prove hidden model behavior or successful task completion.

Stdout streams immediately. Codex's actual nonzero status is retained, including
after one bounded stale-auth retry. No auth retry occurs after an observed
completed tool item. Existing `codex-sync-auth-from-gateway` remains responsible
for credential synchronization; credentials are never stored in this script.

Run on Linux with Node and Bash:

```sh
bash -n scripts/remote-cli/codex-remote-run.sh
node --test scripts/remote-cli/codex-remote-run.test.cjs
```

Tests use a mock Codex executable and temporary files, not a paid model call.
For production updates, baseline each host separately, verify the current wrapper
hash, retain a timestamped backup, validate the new script and use an atomic
replacement. Verify a real gateway new/resumed session afterwards. Changing the
gateway image alone does not update this host-owned executable.

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

## Host CLI release check

The current verified Astra baseline is Codex **0.153.4** on Linux ARM64.
Check **both** SSH hosts with `codex-remote-run --version` after every CLI
upgrade. The wrapper rejects Astra requests on older or unrecognized versions
before launching the agent. `CODEX_EXECUTABLE` can select an explicit versioned
installation; otherwise the host's `codex` on PATH is used.

Install approved CLI packages into a versioned directory such as
`/opt/codex-releases/0.153.4/`, verify the package archive checksum and run
`node_modules/.bin/codex --version` there before changing the host symlink.
Retain the previous `/usr/local/bin/codex` symlink and wrapper, then replace each
atomically. Do not copy the gateway HOME or authentication files as part of a CLI
release. Existing processes can finish using their already-started executable.

Verify a bounded Astra command/result round trip through each nuts target
(`k3s-primary` and `k3s-secondary`), including a resumed session. A successful
gateway-container version check alone is insufficient. Cloudflare MCP OAuth
errors are a separate credential issue and must not trigger credential resets
as part of a Codex binary upgrade.

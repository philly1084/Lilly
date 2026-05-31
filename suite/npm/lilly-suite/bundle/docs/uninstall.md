# Lilly Suite Uninstall

This page documents the tester uninstall path for the compose-based Lilly Suite install.

The uninstall script is intentionally conservative:

- It runs in dry-run mode unless `--yes` is supplied.
- It stops the configured Docker Compose project before removing installed compose files.
- It removes only known compose/env files under the configured install root.
- It keeps state/data by default.
- It wipes state/data only when both `--wipe-data` and `--yes` are supplied.
- It refuses unsafe roots such as the filesystem root, the user's home directory, or the repository working directory.

## Roots

Pass roots explicitly when testing:

```bash
node suite/scripts/uninstall-compose.mjs \
  --install-root /opt/lilly-suite \
  --state-root /var/lib/lilly-suite
```

The script also reads these environment variables:

| Purpose | Preferred | Compatibility |
| --- | --- | --- |
| Install root | `LILLY_SUITE_INSTALL_ROOT` | `KIMI_SUITE_INSTALL_ROOT` |
| State/data root | `LILLY_SUITE_STATE_ROOT` | `KIMI_SUITE_STATE_ROOT` |
| Compose project | `LILLY_SUITE_COMPOSE_PROJECT` | `KIMI_SUITE_COMPOSE_PROJECT` |

If no root is supplied, the script uses `/opt/lilly-suite` for installed compose files and `/var/lib/lilly-suite` for state/data on Linux. On Windows it uses `C:\ProgramData\lilly-suite` and `C:\ProgramData\lilly-suite\state`.

## Dry Run

Dry run is the default. This is the safe first command for a tester machine:

```bash
node suite/scripts/uninstall-compose.mjs \
  --install-root /opt/lilly-suite \
  --state-root /var/lib/lilly-suite \
  --dry-run
```

The output lists the `docker compose down` command that would run and each file or directory that would be removed.

## Remove Installed Compose Files

To stop the compose stack and remove installed compose files and env files:

```bash
node suite/scripts/uninstall-compose.mjs \
  --install-root /opt/lilly-suite \
  --state-root /var/lib/lilly-suite \
  --yes
```

The script looks for these files under the install root:

- `compose.yml`
- `compose.yaml`
- `docker-compose.yml`
- `docker-compose.yaml`
- `release.env`
- `.env`
- `.env.local`

The install root directory is removed only if it is empty after those files are removed. Any other files left in the install root are preserved.

## Wipe Data

State/data removal is destructive and must be explicit:

```bash
node suite/scripts/uninstall-compose.mjs \
  --install-root /opt/lilly-suite \
  --state-root /var/lib/lilly-suite \
  --wipe-data \
  --yes
```

Without `--wipe-data`, the state root is preserved. With `--wipe-data` but without `--yes`, the script exits with an error instead of deleting data.

## Test-Machine Reset Checklist

1. Run the dry run and confirm the install and state roots are exactly the tester install paths.
2. Run uninstall with `--yes` to stop compose and remove installed compose files.
3. Confirm any expected preserved state still exists.
4. Only for a full reset, rerun with `--wipe-data --yes`.
5. Re-run the dry run. It should report no compose files and no state root, or only preserved non-install files.

# Lilly Suite npm Package

This package installs the `lilly-suite` command as a compatibility wrapper for
the KimiBuilt Suite no-source compose bundle.

The npm package is only a CLI wrapper plus the release bundle copied into
`bundle/` before packing. It does not start containers during `npm install`,
and it does not include the backend application source tree.

## Commands

```bash
lilly-suite help
lilly-suite doctor
lilly-suite bundle-path
lilly-suite env-example
lilly-suite install [install-compose args...]
lilly-suite install --dry-run
lilly-suite uninstall --install-root /opt/lilly-suite --state-root /var/lib/lilly-suite --dry-run
```

`install` delegates to `bundle/install-compose.sh` on Unix-like systems, or `bundle/install-compose.cmd` on Windows when present. `install --dry-run` prints the planned command and is safe for CI.

`uninstall` is conservative by default. Without `--yes`, it runs as a dry run. It stops the configured Docker Compose project only when installed compose files are found and execution is explicitly confirmed with `--yes`. State/data is preserved unless both `--wipe-data` and `--yes` are supplied.

## Pack Layout

Before running `npm pack`, the package directory should contain:

```text
suite/npm/lilly-suite/
  package.json
  README.md
  bin/lilly-suite.js
  lib/cli.js
  bundle/
    install-compose.sh
    templates/release.env.example
    ...
```

Only `README.md`, `bin/`, `lib/`, and `bundle/` are included by the package `files` allowlist.

## Build And Pack

From this directory:

```bash
npm test
npm pack --dry-run
npm pack
```

The dry-run test does not require Docker or a populated bundle:

```bash
npm test
```

Run `lilly-suite doctor` only after the release bundle has been copied into `bundle/` and Docker Compose v2 is available.

## Publish Inputs

Before publishing, the release lead should provide:

- Final npm package version.
- Final package `homepage`, repository metadata if desired, and license confirmation.
- The no-source compose bundle contents copied into `bundle/`.
- A release-machine `npm pack --dry-run` file list review.
- A trial install from the packed tarball with `lilly-suite doctor`, `lilly-suite install --dry-run`, and `lilly-suite uninstall --dry-run`.

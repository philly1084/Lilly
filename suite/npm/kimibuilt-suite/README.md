# KimiBuilt Suite npm Package

This package installs the `kimibuilt-suite` command for the KimiBuilt online
compose bundle. It is a CLI wrapper plus the generated release bundle copied
into `bundle/` before packing.

It does not start containers during `npm install`, and it does not include the
backend application source tree.

## Commands

```bash
kimibuilt-suite help
kimibuilt-suite setup-guide
kimibuilt-suite doctor
kimibuilt-suite bundle-path
kimibuilt-suite env-example
kimibuilt-suite install [install-compose args...]
kimibuilt-suite install --dry-run
kimibuilt-suite uninstall --install-root /opt/kimibuilt-suite --state-root /var/lib/kimibuilt-suite --dry-run
```

`install` delegates to `bundle/install-compose.sh` on Unix-like systems, or
`bundle/install-compose.cmd` on Windows when present. The installer generates
passwords for `GENERATE_ME_*` placeholders in `release.env`.

`uninstall` is conservative. It delegates to the bundled uninstaller and remains
a dry run unless `--yes` is supplied. State/data is preserved unless both
`--wipe-data` and `--yes` are supplied.

## First Online Install

```bash
npm install -g kimibuilt-suite
kimibuilt-suite install --no-start --print-secrets
$EDITOR /opt/kimibuilt-suite/release.env
kimibuilt-suite install --yes
```

For non-root trials:

```bash
kimibuilt-suite install \
  --install-root "$HOME/kimibuilt-suite" \
  --state-root "$HOME/.local/state/kimibuilt-suite" \
  --no-start \
  --print-secrets
```

## Pack Layout

Before running `npm pack`, the package directory should contain:

```text
suite/npm/kimibuilt-suite/
  package.json
  README.md
  bin/kimibuilt-suite.js
  lib/cli.js
  bundle/
    install-compose.sh
    templates/release.env.example
    templates/release-compose.yaml
    docs/online-setup.md
    scripts/uninstall-compose.mjs
```

Build that payload from the repository root:

```bash
npm run release:bundle
npm run release:gate
```

## Publish Inputs

Before publishing, the release lead should provide:

- Final npm package version.
- Final image tag in the compose bundle.
- A successful `npm run release:gate`.
- A release-machine `npm pack --dry-run` file list review.
- A trial install from the packed tarball.

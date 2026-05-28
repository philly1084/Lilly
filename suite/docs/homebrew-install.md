# Lilly Suite Homebrew Trial Install

This document describes the private tap trial path for installing Lilly Suite from the no-source compose release bundle. The Homebrew formula installs the bundle under Homebrew `libexec` and exposes a small `lilly-suite` wrapper.

The wrapper does not delete containers, volumes, databases, or user data. Cleanup remains a manual operator action.

## Publish Inputs

Before a tap trial, the lead must fill in these formula fields in `suite/homebrew/Formula/lilly-suite.rb`:

| Field | Trial value to provide |
| --- | --- |
| `homepage` | Repository, release, or internal product page URL |
| `url` | Release tarball URL for `lilly-suite-compose-bundle-<version>.tar.gz` |
| `sha256` | SHA-256 checksum for the release tarball |

The release tarball is expected to contain the existing compose bundle layout, including:

- `install-compose.sh`
- `templates/release.env.example`
- Any compose files, scripts, templates, or docs required by `install-compose.sh`

## Tap Layout

For a private tap, copy or publish the formula as:

```text
homebrew-lilly-suite/
  Formula/
    lilly-suite.rb
```

The source file in this repository lives at:

```text
suite/homebrew/Formula/lilly-suite.rb
```

## Trial Commands

After the formula URL and checksum are filled in and pushed to the private tap:

```bash
brew tap OWNER/lilly-suite git@github.com:OWNER/homebrew-lilly-suite.git
brew install lilly-suite
lilly-suite doctor
mkdir -p ~/lilly-suite
cd ~/lilly-suite
lilly-suite env-example > .env
$EDITOR .env
lilly-suite install
```

For a one-off local formula trial before publishing the tap:

```bash
brew install --build-from-source ./suite/homebrew/Formula/lilly-suite.rb
lilly-suite doctor
```

If Homebrew reports a checksum mismatch, regenerate the release tarball checksum and update the formula before retrying.

## Installed Commands

The formula installs one executable:

```bash
lilly-suite
```

Supported wrapper commands:

| Command | Behavior |
| --- | --- |
| `lilly-suite help` | Prints wrapper usage |
| `lilly-suite doctor` | Verifies Docker, Docker Compose v2, and bundled installer presence |
| `lilly-suite env-example` | Prints the bundled `templates/release.env.example` |
| `lilly-suite bundle-path` | Prints the Homebrew `libexec` bundle path |
| `lilly-suite install [args...]` | Delegates to bundled `install-compose.sh` with the provided arguments |

## Caveats For Testers

- Docker Engine or Docker Desktop must be installed and running before `lilly-suite install`.
- Docker Compose v2 must be available as `docker compose`.
- Review `.env` before starting services.
- The formula intentionally does not install a background service, start containers automatically, or remove existing data.
- The formula is a no-source bundle installer. Application source code is not compiled by Homebrew.

## Maintainer Checklist

1. Build the release compose bundle with the existing bundle script.
2. Compute and record the tarball SHA-256.
3. Replace the placeholder formula `homepage`, `url`, and `sha256`.
4. Run `brew audit --strict --online lilly-suite` from the tap when network access is available.
5. Run `brew install lilly-suite` on a fresh macOS or Linuxbrew test machine.
6. Run `lilly-suite doctor`.
7. Run the documented `.env` and `lilly-suite install` flow.

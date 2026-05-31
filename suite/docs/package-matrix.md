# KimiBuilt Suite Package Matrix

KimiBuilt now has one source release bundle and several wrappers around it.
The wrappers should not contain application source; they carry the compose
bundle, setup templates, and the installer.

| Package | Path | Purpose | Contains secrets |
| --- | --- | --- | --- |
| Compose bundle | `dist/release/kimibuilt-suite-compose-<version>.tar.gz` | Server-ready no-source install payload | No |
| npm primary | `suite/npm/kimibuilt-suite` | First-class CLI wrapper for Node users | No |
| npm compatibility | `suite/npm/lilly-suite` | Backward-compatible Lilly CLI name | No |
| Homebrew primary | `suite/homebrew/Formula/kimibuilt-suite.rb` | Tap formula for macOS/Linuxbrew trials | No |
| Container image | `ghcr.io/philly1084/kimibuilt:<version>` | Runtime backend image referenced by compose | No |

## Build Commands

```bash
npm run release:bundle
npm run release:gate
```

`release:bundle` copies the compose bundle into each npm package under
`bundle/`. Those generated payload folders are ignored by git and should be
rebuilt in CI or on the release machine.

## Release Checklist

1. Set the root `package.json` version to the release version.
2. Build and publish the matching container image tag.
3. Run `npm run release:bundle -- --image ghcr.io/philly1084/kimibuilt:<version>`.
4. Run `npm run release:gate`.
5. Run `npm pack --dry-run` in `suite/npm/kimibuilt-suite`.
6. Install from the packed tarball on a clean machine and run `kimibuilt-suite doctor`.
7. Run `kimibuilt-suite install --no-start --print-secrets` and inspect the generated `release.env`.
8. Start the stack with `kimibuilt-suite install --yes`.
9. Verify `/health`, `/ready`, login, chat, and one tool call.

## Secrets Policy

Published packages contain placeholders only. Runtime secrets are either:

- Generated on the install host for local service and login credentials.
- Supplied by the operator for provider and gateway credentials.

No package, tarball, Homebrew formula, or CI artifact should contain live API
keys, passwords, Kubernetes secrets, or SSH credentials.

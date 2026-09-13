# Lilly release storage admission

## Installed image-retention repair — 2026-09-08 20:26 UTC

The current backend release is now retained in K3s's native pre-import directory:
`/var/lib/rancher/k3s/agent/images/lilly-team-release-8e3e42246bcbbd7f.tar`.
The root-only archive was copied from the verified release export, compared
byte-for-byte, and published by a same-filesystem rename. Archive SHA-256:
`1fcb5d0d2eb6efc14b006f4b1b78033d7e094a6630db80720d19f2437723378b`.

K3s journal confirmed automatic import at 20:26:32 UTC. CRI inspection changed
from `pinned: false` to `pinned: true` for image config
`3b559dd97aa816fe63cb992c119fb635cb710f6b69c2ab02a2387010116e67de`.
Both tag and digest references carry K3s and CRI pinned labels; manifest digest:
`10761de4d6e39d599ea6e5343a96e39c837a25471a4523430c60d6929100cd68`.
Public health remained healthy. No deployment mutation, restart, model call,
registry setup, secret change, or agent activation was performed.

This uses [K3s pre-import](https://docs.k3s.io/add-ons/import-images), not a
one-time manual containerd import. It protects this release from normal image
garbage collection and retains a source for startup import. Host/disk loss,
explicit deletion, disk exhaustion, and future releases remain separate risks.
No destructive eviction/reboot test was performed. Future releases must install
their own verified archive or use a durable registry; the older build script
below still performs only a one-time import and must not be assumed sufficient.

## Local-only build admission

The local team release builder now imports `scripts/lilly-release-storage-preflight.js`.
Transfer both scripts together when preparing an approved remote release.
Before allocating a temporary build directory or exporting the base image, it
reads the base image size through `k3s crictl inspecti` and filesystem capacity
through `statfs`. Missing or invalid measurements fail closed.

Admission reserves the larger of 16 GiB or 15% of filesystem capacity, plus
three times the reported image size for release operations. This is a conservative
admission heuristic, not a disk quota or a guarantee against concurrent writes;
image unpacking and growing source layers can exceed the reported image size.
The preflight currently checks `/tmp`; separately mounted container storage needs
its own capacity check before deployment.

Nine offline tests verify thresholds, invalid measurements, and that a rejected
build makes no export/build calls or temporary directories. This change remains
local and does not repair the recurring production image availability failure.

Outstanding operational requirements:

- Preserve persistent image retention for subsequent releases and verify it
  independently; the current release's installed evidence is recorded above.
- Obtain fresh approval for bounded live team testing after service recovery.

Do not treat storage admission, local regression tests, or service recovery as
proof of the complete computer-and-team workflow.

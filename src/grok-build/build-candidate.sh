#!/bin/sh
# Run only inside the uniquely-created candidate build directory. The output
# remains a local image; this script never pushes or updates a deployment.
set -eu
build_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$build_dir" in /tmp/lilly-grok-source.*) ;; *) echo 'Unexpected build directory' >&2; exit 2 ;; esac
cd "$build_dir"
printf '%s\n' "$$" > build.pid
set +e
timeout --signal=TERM --kill-after=30s 2400s podman build \
  --memory=6g --cpu-period=100000 --cpu-quota=200000 \
  --tag localhost/lilly-grok-build:source-72a6125 \
  --file Dockerfile .
result=$?
set -e
printf '%s\n' "$result" > build.exit
exit "$result"

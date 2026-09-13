#!/bin/sh
# Single guarded compile recovery, not a deploy or model-backed agent launch.
set -eu
build_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test "$build_dir" = /tmp/lilly-grok-source.SAIy9f
cd "$build_dir"
test "$(cat resume.exit)" = 101
test ! -e recovery.pid
test ! -e recovery.exit
test -f Recovery.Dockerfile
podman image exists localhost/lilly-grok-build-cache:resume-0b919e0b5c19
# Enough space for target-CPU cache invalidation; never prune existing images.
test "$(df -Pk . | awk 'NR==2 {print $4}')" -ge 25165824
test "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -ge 12582912
# Exclusive directory survives failure: subsequent runs require inspection,
# not a stale PID heuristic that might launch a duplicate compiler.
mkdir recovery.lock
printf '%s\n' "$$" > recovery.pid
exec > recovery.log 2>&1
set +e
timeout --signal=TERM --kill-after=30s 7200s podman build \
  --memory=10g --cpu-period=100000 --cpu-quota=200000 \
  --tag localhost/lilly-grok-build:source-72a6125-generic \
  --file Recovery.Dockerfile .
result=$?
set -e
printf '%s\n' "$result" > recovery.exit
exit "$result"

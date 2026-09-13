#!/bin/sh
# One scoped recovery of the terminal, timed-out attempt 3. No deployment,
# push, removal, existing-build restart or model-backed agent launch.
set -eu
build_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test "$build_dir" = /tmp/lilly-grok-source.SAIy9f
cd "$build_dir"
test "$(cat build.exit)" = 124
test ! -e resume.pid
builder=0b919e0b5c195a3744217642a1ec66d692236b451965a2f4d3466e95b1e4a51a
cache=localhost/lilly-grok-build-cache:resume-0b919e0b5c19
if podman image exists "$cache"; then echo 'Cache image already exists; inspect instead of replacing.' >&2; exit 2; fi
buildah run "$builder" -- sh -c 'test "$(git -C /build/grok-build rev-parse HEAD)" = 72a61251fcffb464bcc687aeb5a998e5a98ec0c9 && git -C /build/grok-build diff --quiet HEAD'
printf '%s\n' "$$" > resume.pid
set +e
timeout --signal=TERM --kill-after=30s 900s buildah commit --format oci "$builder" "$cache"
result=$?
if test "$result" = 0; then
  timeout --signal=TERM --kill-after=30s 2400s podman build \
    --memory=6g --cpu-period=100000 --cpu-quota=200000 \
    --tag localhost/lilly-grok-build:source-72a6125 \
    --file Resume.Dockerfile .
  result=$?
fi
set -e
printf '%s\n' "$result" > resume.exit
exit "$result"

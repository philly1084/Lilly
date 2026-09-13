# Scoped recovery after the resumed candidate exited 101 with a verified
# compiler cgroup OOM. This cache contains pinned source, not a finished binary.
FROM localhost/lilly-grok-build-cache:resume-0b919e0b5c19 AS builder
WORKDIR /build/grok-build
# Avoid upstream Neoverse V2 instructions on the verified N1 build/runtime host.
# Changed flags intentionally invalidate incompatible compiler artifacts.
ENV CARGO_BUILD_JOBS=1 \
    RUSTFLAGS="-C target-cpu=generic -C force-unwind-tables=yes"
RUN test "$(git rev-parse HEAD)" = 72a61251fcffb464bcc687aeb5a998e5a98ec0c9 \
    && test "$(cat SOURCE_REV)" = a549186d9d39311f2d3ee4208db62af8c65aa476 \
    && git diff --quiet HEAD \
    && cargo build --locked -p xai-grok-pager-bin --release
RUN mkdir -p /out/bin /out/provenance \
    && install -m 0755 target/release/xai-grok-pager /out/bin/xai-grok-pager \
    && cp LICENSE THIRD-PARTY-NOTICES SOURCE_REV Cargo.lock rust-toolchain.toml /out/provenance/ \
    && git rev-parse HEAD > /out/provenance/PUBLIC_SOURCE_REV \
    && git archive --format=tar.gz HEAD > /out/provenance/upstream-source.tar.gz \
    && printf 'CARGO_BUILD_JOBS=%s\nRUSTFLAGS=%s\n' "$CARGO_BUILD_JOBS" "$RUSTFLAGS" > /out/provenance/build-settings.txt \
    && sha256sum /out/bin/xai-grok-pager > /out/provenance/binary.sha256

FROM docker.io/library/debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Lilly Grok Build isolated worker" \
    org.opencontainers.image.source="https://github.com/xai-org/grok-build" \
    org.opencontainers.image.revision="72a61251fcffb464bcc687aeb5a998e5a98ec0c9" \
    org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-Upstream-Third-Party"
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git libgcc-s1 libssl3 libstdc++6 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 grok \
    && useradd --uid 10001 --gid 10001 --home-dir /state/worker --no-create-home --shell /usr/sbin/nologin grok \
    && mkdir -p /workspace/assignment /state/worker/.grok \
    && chown -R 10001:10001 /workspace/assignment /state/worker
COPY --from=builder /out/bin/xai-grok-pager /opt/grok/bin/xai-grok-pager
COPY --from=builder /out/provenance/ /usr/share/doc/grok-build/
COPY --chown=10001:10001 worker-config.toml /state/worker/.grok/config.toml
RUN ldd /opt/grok/bin/xai-grok-pager > /usr/share/doc/grok-build/linked-libraries.txt \
    && ! grep -q 'not found' /usr/share/doc/grok-build/linked-libraries.txt
ENV HOME=/state/worker \
    GROK_HOME=/state/worker/.grok \
    XDG_CONFIG_HOME=/state/worker/.config \
    XDG_DATA_HOME=/state/worker/.local/share \
    XDG_CACHE_HOME=/state/worker/.cache
WORKDIR /workspace/assignment
USER 10001:10001
CMD ["/opt/grok/bin/xai-grok-pager", "--no-auto-update", "--version"]

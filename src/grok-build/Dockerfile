# syntax=docker/dockerfile:1
# Build context: src/grok-build only. No Lilly source, credentials or state copied.
# Native target-platform build; no BUILDPLATFORM override or disabled sandbox features.
FROM docker.io/library/rust:1.94.0-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates clang cmake curl git libclang-dev libssl-dev \
    perl pkg-config zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# v0.5.9 is published as GitHub release assets, not available through the Cargo
# registry used by the build. Asset digests verified against the release API.
RUN set -eu; \
    case "$(uname -m)" in \
      aarch64) dotslash_arch=aarch64; dotslash_sha=11323ef72fac5885d7c54bff70d666486bd800a8d908d0acd3bd838fd8a9b0db ;; \
      x86_64) dotslash_arch=x86_64; dotslash_sha=5cefa0f258e0a58ae53c7a9a5be3890574ddd33d57c66bc9c143cb411012d72a ;; \
      *) echo 'Unsupported DotSlash build architecture' >&2; exit 2 ;; \
    esac; \
    curl --fail --location --retry 3 --max-time 120 \
      "https://github.com/facebook/dotslash/releases/download/v0.5.9/dotslash-linux-musl.${dotslash_arch}.tar.gz" \
      --output /tmp/dotslash.tar.gz; \
    printf '%s  %s\n' "$dotslash_sha" /tmp/dotslash.tar.gz | sha256sum --check --strict; \
    tar -xzf /tmp/dotslash.tar.gz -C /usr/local/bin dotslash; \
    chmod 0755 /usr/local/bin/dotslash; \
    rm /tmp/dotslash.tar.gz; \
    /usr/local/bin/dotslash --version
WORKDIR /build/grok-build
RUN git init . \
    && git remote add origin https://github.com/xai-org/grok-build.git \
    && git fetch --depth=1 origin 72a61251fcffb464bcc687aeb5a998e5a98ec0c9 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 72a61251fcffb464bcc687aeb5a998e5a98ec0c9 \
    && test "$(cat SOURCE_REV)" = a549186d9d39311f2d3ee4208db62af8c65aa476

# The upstream DotSlash manifest verifies the architecture-specific protoc archive.
# Keep default jemalloc and sandbox-enforce features enabled.
# Upstream GNU ARM config targets Neoverse V2; our verified build host is N1.
# Explicit RUSTFLAGS override that config without altering pinned source. A
# single Cargo job bounds concurrent compiler memory, not sandbox capability.
ENV CARGO_BUILD_JOBS=1 \
    RUSTFLAGS="-C target-cpu=generic -C force-unwind-tables=yes"
RUN bin/protoc --version \
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

# Conservative GNU runtime closure. The ldd gate below fails the build if another
# shared library is required; this list is not claimed as live-verified yet.
# Git is an explicit worker tool, not a permission grant to arbitrary repositories.
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
# No startup agent/session/heartbeat and no default network listener.
CMD ["/opt/grok/bin/xai-grok-pager", "--no-auto-update", "--version"]

# ================================
# Stage 1: Install dependencies
# ================================
FROM node:24-bookworm-slim AS deps

WORKDIR /app

ARG INSTALL_NPM_OPTIONAL=false

COPY package.json package-lock.json* .npmrc ./
RUN set -eux; \
  if [ "${INSTALL_NPM_OPTIONAL}" = "true" ]; then \
    npm ci --omit=dev; \
  else \
    npm ci --omit=dev --omit=optional; \
  fi; \
  npm cache clean --force

# ================================
# Stage 2: Lilly Engine and editor build
# ================================
FROM node:24-bookworm-slim AS game-studio-builder

WORKDIR /app

COPY package.json package-lock.json* .npmrc ./
# Vite/Rollup ships its platform binary as an optional dependency. The build
# stage must retain optional packages even though the runtime stage omits them.
RUN npm ci
COPY packages/ ./packages/
COPY frontend/game-studio/ ./frontend/game-studio/
RUN npm run build:game-studio:all

# ================================
# Stage 3: BuildKit client
# ================================
FROM docker.io/moby/buildkit:v0.17.2 AS buildkit

# ================================
# Stage 3: Kokoro G2P runtime
# ================================
FROM node:24-bookworm-slim AS kokoro-g2p

WORKDIR /app

ARG KOKORO_TTS_MODEL_ID=onnx-community/Kokoro-82M-v1.0-ONNX
ARG KOKORO_TTS_DEVICE=cpu
ARG KOKORO_TTS_DTYPE=q8
ARG KOKORO_TTS_DEFAULT_VOICE_ID=af_heart
ARG KOKORO_TTS_CACHE_DIR=/app/data/kokoro/cache
ARG KOKORO_TTS_PORT=3001

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    python3-venv; \
  rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  python3 -m venv /opt/kimibuilt-g2p; \
  /opt/kimibuilt-g2p/bin/pip install --no-cache-dir kokorog2p==0.6.7

# ================================
# Stage 4: Kokoro model and voice cache
# ================================
FROM kokoro-g2p AS kokoro-cache

ARG KOKORO_TTS_MODEL_ID=onnx-community/Kokoro-82M-v1.0-ONNX
ARG KOKORO_TTS_DEVICE=cpu
ARG KOKORO_TTS_DTYPE=q8
ARG KOKORO_TTS_DEFAULT_VOICE_ID=af_heart
ARG KOKORO_TTS_CACHE_DIR=/app/data/kokoro/cache

COPY --from=deps /app/node_modules ./node_modules
COPY bin/kimibuilt-verify-tts-build.js ./bin/kimibuilt-verify-tts-build.js
COPY scripts/kokoro_g2p_bridge.py ./scripts/kokoro_g2p_bridge.py
COPY src/tts/kokoro-g2p-bridge.js ./src/tts/kokoro-g2p-bridge.js
COPY src/tts/kokoro-transformers-runtime.js ./src/tts/kokoro-transformers-runtime.js
COPY data/kokoro/voices/manifest.json ./data/kokoro/voices/manifest.json
COPY package-lock.json* ./

RUN --mount=type=cache,id=kimibuilt-kokoro-cache,target=/var/cache/kimibuilt-kokoro,sharing=locked \
  --mount=type=secret,id=hf_token,required=false \
  set -eu; \
  if [ -s /run/secrets/hf_token ]; then \
    HF_TOKEN="$(cat /run/secrets/hf_token)"; \
    export HF_TOKEN; \
  fi; \
  mkdir -p "${KOKORO_TTS_CACHE_DIR}" /var/cache/kimibuilt-kokoro; \
  KOKORO_TTS_MODEL_ID="${KOKORO_TTS_MODEL_ID}" \
  KOKORO_TTS_DEVICE="${KOKORO_TTS_DEVICE}" \
  KOKORO_TTS_DTYPE="${KOKORO_TTS_DTYPE}" \
  KOKORO_TTS_DEFAULT_VOICE_ID="${KOKORO_TTS_DEFAULT_VOICE_ID}" \
  KOKORO_TTS_CACHE_DIR=/var/cache/kimibuilt-kokoro \
  KOKORO_TTS_ALLOW_REMOTE_MODELS=true \
  KOKORO_TTS_BUILD_SYNTHESIS_MODE=none \
  KOKORO_TTS_BUILD_RETRY_ATTEMPTS=8 \
  KOKORO_TTS_BUILD_RETRY_DELAY_MS=10000 \
  KOKORO_G2P_COMMAND=/opt/kimibuilt-g2p/bin/python \
  KOKORO_G2P_SCRIPT_PATH=/app/scripts/kokoro_g2p_bridge.py \
  KOKORO_G2P_TIMEOUT_MS=30000 \
  KOKORO_G2P_REQUIRED=true \
  node bin/kimibuilt-verify-tts-build.js; \
  cp -a /var/cache/kimibuilt-kokoro/. "${KOKORO_TTS_CACHE_DIR}/"

# ================================
# Stage 5: Shared app filesystem
# ================================
FROM node:24-bookworm-slim AS app-base

WORKDIR /app

ARG KIMIBUILT_SOURCE_REV=unknown
ARG KOKORO_TTS_MODEL_ID=onnx-community/Kokoro-82M-v1.0-ONNX
ARG KOKORO_TTS_DEVICE=cpu
ARG KOKORO_TTS_DTYPE=q8
ARG KOKORO_TTS_DEFAULT_VOICE_ID=af_heart
ARG KOKORO_TTS_CACHE_DIR=/app/data/kokoro/cache
ARG KOKORO_TTS_PORT=3001

# Security: run as non-root
RUN groupadd --gid 1001 kimibuilt && \
  useradd --uid 1001 --gid 1001 --create-home --shell /usr/sbin/nologin kimibuilt

COPY --from=deps /app/node_modules ./node_modules
COPY bin/ ./bin/
COPY scripts/canary-remote-agent-artifact-loop.js ./scripts/canary-remote-agent-artifact-loop.js
COPY scripts/canary-sandbox-agent-attach.js ./scripts/canary-sandbox-agent-attach.js
COPY scripts/kokoro_g2p_bridge.py ./scripts/kokoro_g2p_bridge.py
COPY src/ ./src/
COPY packages/ ./packages/
COPY --from=game-studio-builder /app/packages/lilly-engine/dist ./packages/lilly-engine/dist
COPY --from=game-studio-builder /app/packages/lilly-engine/browser-dist ./packages/lilly-engine/browser-dist
# Keep remote CLI runner code on a distinct layer; stale copies produce misleading timeout text.
COPY src/remote-cli/ ./src/remote-cli/
COPY frontend/ ./frontend/
COPY --from=game-studio-builder /app/frontend/game-studio/dist ./frontend/game-studio/dist
COPY data/skills/ ./data/skills/
COPY data/kokoro/voices/manifest.json ./data/kokoro/voices/manifest.json
COPY data/piper/voices/manifest.json ./data/piper/voices/manifest.json
COPY package.json ./
COPY package-lock.json* ./
COPY .npmrc ./

RUN printf '%s\n' "${KIMIBUILT_SOURCE_REV}" > /app/.kimibuilt-source-revision && \
  mkdir -p /home/kimibuilt/.kimibuilt && \
  chmod 0755 /app/bin/kimibuilt-ingress.js /app/bin/kimibuilt-runner.js /app/bin/kimibuilt-ui-check.js /app/bin/kimibuilt-verify-tts-build.js && \
  chown -R kimibuilt:kimibuilt /home/kimibuilt /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PATH=/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV KIMIBUILT_DATA_DIR=/home/kimibuilt/.kimibuilt
ENV KIMIBUILT_STATE_DIR=/home/kimibuilt/.kimibuilt
ENV KOKORO_TTS_MODEL_ID=${KOKORO_TTS_MODEL_ID}
ENV KOKORO_TTS_DEVICE=${KOKORO_TTS_DEVICE}
ENV KOKORO_TTS_DTYPE=${KOKORO_TTS_DTYPE}
ENV KOKORO_TTS_VOICES_PATH=/app/data/kokoro/voices/manifest.json
ENV KOKORO_TTS_DEFAULT_VOICE_ID=${KOKORO_TTS_DEFAULT_VOICE_ID}
ENV KOKORO_TTS_CACHE_DIR=${KOKORO_TTS_CACHE_DIR}
ENV KOKORO_TTS_ALLOW_REMOTE_MODELS=false
ENV KOKORO_TTS_PORT=${KOKORO_TTS_PORT}
ENV KOKORO_G2P_ENABLED=true
ENV KOKORO_G2P_REQUIRED=false
ENV KOKORO_G2P_COMMAND=/opt/kimibuilt-g2p/bin/python
ENV KOKORO_G2P_SCRIPT_PATH=/app/scripts/kokoro_g2p_bridge.py
ENV KOKORO_G2P_TIMEOUT_MS=15000
ENV PIPER_TTS_VOICES_PATH=/app/data/piper/voices/manifest.json
ENV OPENCODE_ENABLED=false

# ================================
# Stage 6: Opt-in media image
# ================================
FROM app-base AS media

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    curl \
    openssh-client \
    ffmpeg \
    fonts-liberation \
    python3 \
    python3-venv; \
  rm -rf /var/lib/apt/lists/*

COPY --from=kokoro-g2p /opt/kimibuilt-g2p /opt/kimibuilt-g2p
COPY --from=kokoro-cache /app/data/kokoro/cache ./data/kokoro/cache

RUN set -eux; \
  chown -R kimibuilt:kimibuilt /opt/kimibuilt-g2p

RUN mkdir -p "${KOKORO_TTS_CACHE_DIR}" && \
  KOKORO_TTS_MODEL_ID="${KOKORO_TTS_MODEL_ID}" \
  KOKORO_TTS_DEVICE="${KOKORO_TTS_DEVICE}" \
  KOKORO_TTS_DTYPE="${KOKORO_TTS_DTYPE}" \
  KOKORO_TTS_DEFAULT_VOICE_ID="${KOKORO_TTS_DEFAULT_VOICE_ID}" \
  KOKORO_TTS_CACHE_DIR="${KOKORO_TTS_CACHE_DIR}" \
  KOKORO_TTS_ALLOW_REMOTE_MODELS=false \
  KOKORO_TTS_BUILD_SYNTHESIS_MODE=default \
  KOKORO_G2P_TIMEOUT_MS=30000 \
  KOKORO_G2P_REQUIRED=true \
  node bin/kimibuilt-verify-tts-build.js && \
  chown -R kimibuilt:kimibuilt /app/data

ENV KIMIBUILT_IMAGE_PROFILE=media
ENV ARTIFACT_BROWSER_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium
ENV TTS_PROVIDER=kokoro
ENV TTS_FALLBACK_PROVIDER=none
ENV KOKORO_TTS_ENABLED=true
ENV KOKORO_G2P_REQUIRED=true
ENV PIPER_TTS_ENABLED=false
ENV PIPER_TTS_BINARY_PATH=

USER kimibuilt

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]

# ================================
# Stage 5: Opt-in full builder/operator image
# ================================
FROM media AS full

COPY --from=buildkit /usr/bin/buildctl /usr/local/bin/buildctl

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends docker.io git openssh-client; \
  rm -rf /var/lib/apt/lists/*

ENV KIMIBUILT_IMAGE_PROFILE=full

USER kimibuilt

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]

# ================================
# Stage 6: Default lite image
# ================================
FROM app-base AS lite

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends bash ca-certificates curl openssh-client; \
  rm -rf /var/lib/apt/lists/*

ENV KIMIBUILT_IMAGE_PROFILE=lite
ENV ARTIFACT_BROWSER_PATH=
ENV PLAYWRIGHT_EXECUTABLE_PATH=
ENV TTS_PROVIDER=none
ENV TTS_FALLBACK_PROVIDER=none
ENV KOKORO_TTS_ENABLED=false
ENV PIPER_TTS_ENABLED=false
ENV PIPER_TTS_BINARY_PATH=

USER kimibuilt

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]

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
# Stage 2: BuildKit client
# ================================
FROM docker.io/moby/buildkit:v0.17.2 AS buildkit

# ================================
# Stage 3: Shared app filesystem
# ================================
FROM node:24-bookworm-slim AS app-base

WORKDIR /app

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
COPY src/ ./src/
COPY frontend/ ./frontend/
COPY data/kokoro/voices/manifest.json ./data/kokoro/voices/manifest.json
COPY data/piper/voices/manifest.json ./data/piper/voices/manifest.json
COPY package.json ./
COPY package-lock.json* ./
COPY .npmrc ./

RUN mkdir -p /home/kimibuilt/.kimibuilt && \
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
ENV PIPER_TTS_VOICES_PATH=/app/data/piper/voices/manifest.json
ENV OPENCODE_ENABLED=false

# ================================
# Stage 4: Opt-in media image
# ================================
FROM app-base AS media

ARG PIPER_TTS_VERSION=1.4.2
ARG PIPER_VOICES_REF=v1.0.0
ARG PIPER_VOICES_BASE_URL=https://huggingface.co/rhasspy/piper-voices/resolve

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    curl \
    ffmpeg \
    fonts-liberation \
    python3 \
    python3-pip; \
  python3 -m pip install --break-system-packages --no-cache-dir "piper-tts==${PIPER_TTS_VERSION}"; \
  command -v piper >/dev/null; \
  rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data/piper/voices && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/amy/medium/en_US-amy-medium.onnx" \
    --output /app/data/piper/voices/en_US-amy-medium.onnx && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/amy/medium/en_US-amy-medium.onnx.json" \
    --output /app/data/piper/voices/en_US-amy-medium.onnx.json && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx" \
    --output /app/data/piper/voices/en_US-hfc_female-medium.onnx && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json" \
    --output /app/data/piper/voices/en_US-hfc_female-medium.onnx.json && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/kathleen/low/en_US-kathleen-low.onnx" \
    --output /app/data/piper/voices/en_US-kathleen-low.onnx && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/kathleen/low/en_US-kathleen-low.onnx.json" \
    --output /app/data/piper/voices/en_US-kathleen-low.onnx.json && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/lessac/high/en_US-lessac-high.onnx" \
    --output /app/data/piper/voices/en_US-lessac-high.onnx && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/lessac/high/en_US-lessac-high.onnx.json" \
    --output /app/data/piper/voices/en_US-lessac-high.onnx.json && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/ljspeech/high/en_US-ljspeech-high.onnx" \
    --output /app/data/piper/voices/en_US-ljspeech-high.onnx && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_US/ljspeech/high/en_US-ljspeech-high.onnx.json" \
    --output /app/data/piper/voices/en_US-ljspeech-high.onnx.json && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_GB/cori/high/en_GB-cori-high.onnx" \
    --output /app/data/piper/voices/en_GB-cori-high.onnx && \
  curl --fail --show-error --silent --location --retry 3 \
    "${PIPER_VOICES_BASE_URL}/${PIPER_VOICES_REF}/en/en_GB/cori/high/en_GB-cori-high.onnx.json" \
    --output /app/data/piper/voices/en_GB-cori-high.onnx.json

RUN printf 'KimiBuilt Piper build check.\n' | piper \
    --model /app/data/piper/voices/en_US-hfc_female-medium.onnx \
    --config /app/data/piper/voices/en_US-hfc_female-medium.onnx.json \
    --output_file /tmp/piper-check.wav \
    --length_scale 1 \
    --noise_scale 0.4 \
    --noise_w 0.68 \
    --sentence_silence 0.28 && \
  test -s /tmp/piper-check.wav && \
  rm -f /tmp/piper-check.wav

RUN mkdir -p "${KOKORO_TTS_CACHE_DIR}" && \
  KOKORO_TTS_MODEL_ID="${KOKORO_TTS_MODEL_ID}" \
  KOKORO_TTS_DEVICE="${KOKORO_TTS_DEVICE}" \
  KOKORO_TTS_DTYPE="${KOKORO_TTS_DTYPE}" \
  KOKORO_TTS_DEFAULT_VOICE_ID="${KOKORO_TTS_DEFAULT_VOICE_ID}" \
  KOKORO_TTS_CACHE_DIR="${KOKORO_TTS_CACHE_DIR}" \
  node bin/kimibuilt-verify-tts-build.js && \
  chown -R kimibuilt:kimibuilt /app/data

ENV KIMIBUILT_IMAGE_PROFILE=media
ENV ARTIFACT_BROWSER_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium
ENV TTS_PROVIDER=kokoro
ENV TTS_FALLBACK_PROVIDER=piper
ENV KOKORO_TTS_ENABLED=true
ENV PIPER_TTS_ENABLED=true
ENV PIPER_TTS_BINARY_PATH=/usr/local/bin/piper

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
  apt-get install -y --no-install-recommends bash ca-certificates curl; \
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

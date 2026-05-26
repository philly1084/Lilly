# Realtime TTS System

KimiBuilt web-chat, web-cli, and Notes TTS share a layered realtime path rather than a single long synthesis request.

## Layers

1. Browser chunk planner
   - Starts with one short sentence for fast first audio.
   - Cuts later text around sentence and clause boundaries with `TTS_REALTIME_CHUNK_TARGET_CHARS`.
   - Groups follow-up sentences into narration-sized chunks so playback is easier to digest after the first fast start.
   - Splits oversized sentences before they can monopolize playback.

2. Browser synthesis scheduler
   - Keeps multiple chunks in flight with `TTS_REALTIME_SYNTHESIS_LANES`.
   - Keeps a larger prepared window with `TTS_REALTIME_SYNTHESIS_LOOKAHEAD`.
   - Starts playback after the first chunk, while later chunks continue building.

3. High-quality realtime generation
   - Sends the primary chunk to the configured provider, normally Kokoro.
   - Kokoro pods use the Apache-licensed `kokorog2p` bridge for Kokoro-compatible English G2P with eSpeak fallback disabled.
   - The old pure-JS `phonemize` path remains only as a local/dev fallback when `KOKORO_G2P_REQUIRED` is not true.
   - Realtime chunks do not fall back to Piper by default. `TTS_REALTIME_EMERGENCY_PROVIDER=kokoro` is treated as Kokoro-only and avoids lower-quality mid-response voice changes.
   - Uses short per-chunk timeouts so one bad synthesis cannot consume the full backend TTS timeout.
   - Browser realtime playback disables backend provider fallback per chunk. This keeps a slow Piper fallback from becoming the visible error when Kokoro was the primary request.

4. Playback stall protection
   - Playback remains ordered by default.
   - Stalled chunks are not skipped by default; the reader may pause briefly, but it should not silently drop content.
   - `TTS_REALTIME_SKIP_STALLED_CHUNKS=true` restores the older skip behavior for demos that value nonstop motion over completeness.

5. Presentation smoothing
   - The browser trims tiny leading/trailing silence from decoded chunks with `TTS_REALTIME_TRIM_EDGE_SECONDS` and `TTS_REALTIME_TRIM_THRESHOLD`.
   - The scheduler adds a small controlled pause with `TTS_REALTIME_CHUNK_PAUSE_SECONDS` so chunks feel like sentences, not disconnected clips.

6. Backend provider routing
   - `/api/tts/synthesize` accepts `provider`, `timeoutMs`, and `allowProviderFallback`.
   - Backend synthesis can still support Kokoro-to-Piper fallback for non-realtime callers, but realtime frontends request Kokoro-only chunks.
   - Incompatible voice ids are cleared when a request targets a provider that does not own the selected voice.
   - If fallback also fails, backend errors keep primary and fallback context instead of replacing the whole failure with the fallback provider's raw timeout.

7. k3s capacity
   - Keep `KOKORO_TTS_SYNTHESIS_CONCURRENCY=1` on ARM64 because in-process Kokoro fanout has previously crashed onnxruntime.
   - Scale `kokoro-tts` replicas for real parallelism.
   - Current manifests request four Kokoro replicas and four browser scheduler lanes.
   - The frontend scheduler keeps enough Kokoro chunks prepared that a slow second sentence does not wait for the full primary-provider timeout.

## Primary Knobs

- `TTS_REALTIME_SYNTHESIS_LANES`
- `TTS_REALTIME_SYNTHESIS_LOOKAHEAD`
- `TTS_REALTIME_CHUNK_TARGET_CHARS`
- `TTS_REALTIME_PRIMARY_TIMEOUT_MS`
- `TTS_REALTIME_FALLBACK_TIMEOUT_MS`
- `TTS_REALTIME_HEDGE_DELAY_MS`
- `TTS_REALTIME_CHUNK_STALL_MS`
- `TTS_REALTIME_CHUNK_PAUSE_SECONDS`
- `TTS_REALTIME_TRIM_EDGE_SECONDS`
- `TTS_REALTIME_TRIM_THRESHOLD`
- `TTS_REALTIME_SKIP_STALLED_CHUNKS`
- `TTS_REALTIME_EMERGENCY_PROVIDER`

For quality, raise chunk target, initial-buffer, and stall budgets. For speed, lower chunk target and per-chunk timeouts, then add Kokoro replicas instead of increasing in-process Kokoro concurrency. If sentence two pauses, verify the live ConfigMap still has four lanes, six chunks of lookahead, a `TTS_REALTIME_CHUNK_TARGET_CHARS` value near `360`, `TTS_REALTIME_EMERGENCY_PROVIDER=kokoro`, chunk skipping disabled, and four ready `kokoro-tts` pods.

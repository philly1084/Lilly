# Podcast

`podcast` runs a multi-step workflow for a user-aligned podcast episode:

1. Research the topic with `web-search`
2. Verify and extract source material with `web-fetch`
3. Generate a scripted solo-host or two-host episode with the configured model
4. Synthesize each host with the configured local TTS provider using separate voices
5. Optionally mix in intro/outro/music-bed audio with ffmpeg
6. Optionally export MP3 with ffmpeg
7. Save the final audio artifacts into the active session
8. Optionally render an MP4 podcast video from the saved audio and transcript

Required input:

- `topic`

Useful optional inputs:

- `durationMinutes`
- `requestBrief` (full user creative/content brief; do not reduce this to a headline)
- `audience`
- `tone`
- `hostCount` / `speakerCount` (`1` for solo/one-speaker, `2` for two-host)
- `hostAName`, `hostBName`
- `hostAVoiceId`, `hostBVoiceId`
- `hostAVoiceIds`, `hostBVoiceIds` (ordered lists to cycle voices)
- `cycleHostVoices` (default: false for audio-only, true for video podcasts)
- `allowVoiceFallback` (default: true, lets a host fall through to the next curated voice on TTS failures)
- `enhanceSpeech` (defaults to `true` when ffmpeg is available; set `false` only when you need the raw TTS WAV)
- `hostAPersona`, `hostBPersona`
- `sourceUrls`
- `searchDomains`
- `includeIntro`, `includeOutro`, `includeMusicBed`
- `enhanceSpeech`
- `introPath`, `outroPath`, `musicBedPath`
- `exportMp3`, `outputFormat`, `mp3BitrateKbps`
- `ttsTimeoutMs`, `ttsChunkMaxChars`
- `ttsConcurrency`, `researchConcurrency`
- `includeVideo` (set `true` to render an MP4 after audio generation)
- `videoAspectRatio` (`16:9`, `9:16`, or `1:1`)
- `videoImageMode` (`mixed`, `web`, `unsplash`, `generated`, or `fallback`)
- `videoGenerateImages` (set `true` to allow generated images for scenes)
- `videoEnhanceAudio` (defaults to `false`; set `true` only when you explicitly want ffmpeg repair/mastering)
- `videoVisualEffects` (defaults to `true`; set `false` for static background images)
- `videoSceneCount`
- `videoVisualStyle` (optional creative direction; useful for requesting infographic-heavy scene slides)

Notes:

- The tool requires an active session because it persists the final audio artifact.
- Keep `topic` concise for research, but pass the full original request in `requestBrief` whenever the user gives format, angle, facts, style, title, or exclusions. The script generator treats the request brief as binding editorial direction so it does not collapse detailed requests into generic topic explainers.
- Honor explicit solo, one-speaker, one-host, or single-narrator requests with `hostCount: 1`. Do not create a co-host unless the user asks for one or leaves the format unspecified.
- For "video podcast" or "podcast video" requests, pass `includeVideo: true`, `videoRenderMode: "storyboard"`, `videoImageMode: "mixed"`, and `videoGenerateImages: true` unless the user explicitly asks for waveform-only or no generated imagery. Use waveform-card for plain MP4/audio-visualizer requests.
- Research quality depends on `web-search` availability and source accessibility.
- Speech stitching is native PCM WAV concatenation, so the selected TTS voices must emit compatible WAV output.
- Podcast renders use the curated high-quality female voice pool by default: Kokoro `af_bella`, `af_heart`, and `bf_emma`, with female Piper fallback aliases such as `ljspeech-high`, `lessac-high`, and `cori-high` mapped during rollout.
- Long-form episodes use podcast-specific TTS chunking and timeout controls; override them with `ttsChunkMaxChars` or `ttsTimeoutMs` if a machine is unusually slow.
- Each host keeps a stable primary voice unless you set `cycleHostVoices: true` or request a video podcast; when a TTS render fails, the tool falls through to the next voice in that host's pool by default.
- Source verification still uses bounded parallelism by default. Podcast TTS concurrency is conservative by default; only raise `ttsConcurrency` if you need speed more than render stability.
- MP3 export and intro/outro/music-bed mixing require ffmpeg audio processing to be configured.
- MP4 podcast video rendering also requires ffmpeg. The `waveform-card` render is a deterministic audio waveform card encoded as H.264/AVC MP4 (`avc1`, yuv420p) with AAC audio for broad PC/browser compatibility. Use it only when the user wants a simple audio visualizer; content-focused video podcasts should use `videoRenderMode: "storyboard"`.
- Video podcast renders keep speech audio clean by default without repair/mastering filters. Keep MP4 unless the user has a platform-specific reason to request another container.
- Use `videoRenderMode: "static-card"` only when the user explicitly wants one key visual for the full episode. The storyboard pipeline plans timestamped show segments from the transcript, tries direct/provided images, web-search page image extraction, Unsplash, generated images when allowed, and deterministic fallback infographic frames.
- For higher-quality visual podcasts, ask for or infer a mix of infographic slide types such as hook card, timeline, comparison board, process flow, risk/impact map, evidence dashboard, myth-vs-fact panel, and takeaway card. Generated slide prompts should favor clear visual hierarchy, icons, charts, metric tiles, content reads/writes, and generous margins over plain stock-photo scenes. Storyboard/static-card renders include a small corner waveform overlay so the audio remains visibly alive without dominating the frame.
- Long video renders use adaptive ffmpeg budgets. Override with `videoFfmpegTimeoutMs`, `videoSegmentTimeoutMs`, or `videoMuxTimeoutMs` only when the host is known to need more time.
- Only use music beds you are licensed to use. Provide a legal audio file path or upload; do not source copyrighted music without permission.
- Check `/api/tts/voices` for the exact `hostA` / `hostB` voice IDs supported in your current deployment before passing custom `hostAVoiceIds` and `hostBVoiceIds`.
- Example: `hostAVoiceIds: ["af_bella", "af_heart"]` and `hostBVoiceIds: ["bf_emma", "af_heart"]` lets the same host cycle through the highest-quality bundled female Kokoro voices per turn.

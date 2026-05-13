const { Router } = require('express');
const { validate } = require('../middleware/validate');
const { sessionStore } = require('../session-store');
const { buildScopedSessionMetadata, resolveClientSurface } = require('../session-scope');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const { ttsService } = require('../tts/tts-service');
const { audioProcessingService } = require('../audio/audio-processing-service');
const { getPodcastScriptDesignOptions, podcastService } = require('../podcast/podcast-service');
const {
  hasExplicitPodcastIntent,
  hasExplicitPodcastVideoIntent,
  extractExplicitPodcastTopic,
  extractPodcastRequestBrief,
  inferPodcastHostCount,
  inferPodcastAudioAssetOptions,
  inferPodcastVideoOptions,
} = require('../podcast/podcast-intent');
const { podcastVideoService } = require('../video/podcast-video-service');
const { parseMultipartRequest } = require('../utils/multipart');
const { config } = require('../config');

const router = Router();

const generateSchema = {
  topic: { required: true, type: 'string' },
  prompt: { required: false, type: 'string' },
  subject: { required: false, type: 'string' },
  requestBrief: { required: false, type: 'string' },
  originalPrompt: { required: false, type: 'string' },
  hostCount: { required: false, type: 'number' },
  speakerCount: { required: false, type: 'number' },
  sessionId: { required: false, type: 'string' },
  durationMinutes: { required: false, type: 'number' },
  audience: { required: false, type: 'string' },
  tone: { required: false, type: 'string' },
  detailLevel: { required: false, type: 'string' },
  scriptDesign: { required: false, type: 'string' },
  scriptStyle: { required: false, type: 'string' },
  presentationDesign: { required: false, type: 'string' },
  scriptDesignExample: { required: false, type: 'string' },
  presentationExample: { required: false, type: 'string' },
  hostAName: { required: false, type: 'string' },
  hostARole: { required: false, type: 'string' },
  hostAPersona: { required: false, type: 'string' },
  hostBName: { required: false, type: 'string' },
  hostBRole: { required: false, type: 'string' },
  hostBPersona: { required: false, type: 'string' },
  hostAVoiceId: { required: false, type: 'string' },
  hostAVoiceIds: { required: false, type: 'array', items: { type: 'string' } },
  hostBVoiceId: { required: false, type: 'string' },
  hostBVoiceIds: { required: false, type: 'array', items: { type: 'string' } },
  cycleHostVoices: { required: false, type: 'boolean' },
  allowVoiceFallback: { required: false, type: 'boolean' },
  allowProviderFallback: { required: false, type: 'boolean' },
  allowTtsProviderFallback: { required: false, type: 'boolean' },
  artifactIds: { required: false, type: 'array', items: { type: 'string' } },
  sourceArtifactIds: { required: false, type: 'array', items: { type: 'string' } },
  sourceDocuments: { required: false, type: 'array', items: { type: 'object' } },
  sourceUrls: { required: false, type: 'array', items: { type: 'string' } },
  searchDomains: { required: false, type: 'array', items: { type: 'string' } },
  maxSources: { required: false, type: 'number' },
  pauseMs: { required: false, type: 'number' },
  voiceOnlyAudio: { required: false, type: 'boolean' },
  speakerOnlyAudio: { required: false, type: 'boolean' },
  voiceOnly: { required: false, type: 'boolean' },
  includeIntro: { required: false, type: 'boolean' },
  includeOutro: { required: false, type: 'boolean' },
  includeMusicBed: { required: false, type: 'boolean' },
  enhanceSpeech: { required: false, type: 'boolean' },
  introPath: { required: false, type: 'string' },
  outroPath: { required: false, type: 'string' },
  musicBedPath: { required: false, type: 'string' },
  speechVolume: { required: false, type: 'number' },
  musicVolume: { required: false, type: 'number' },
  introVolume: { required: false, type: 'number' },
  outroVolume: { required: false, type: 'number' },
  exportMp3: { required: false, type: 'boolean' },
  outputFormat: { required: false, type: 'string' },
  mp3BitrateKbps: { required: false, type: 'number' },
  model: { required: false, type: 'string' },
  reasoningEffort: { required: false, type: 'string' },
  scriptTimeoutMs: { required: false, type: 'number' },
  ttsTimeoutMs: { required: false, type: 'number' },
  ttsChunkMaxChars: { required: false, type: 'number' },
  ttsConcurrency: { required: false, type: 'number' },
  researchConcurrency: { required: false, type: 'number' },
  includeVideo: { required: false, type: 'boolean' },
  video: { required: false, type: 'object' },
  videoAspectRatio: { required: false, type: 'string' },
  videoImageMode: { required: false, type: 'string' },
  videoGenerateImages: { required: false, type: 'boolean' },
  videoEnhanceAudio: { required: false, type: 'boolean' },
  videoVisualEffects: { required: false, type: 'boolean' },
  visualEffects: { required: false, type: 'boolean' },
  videoSceneCount: { required: false, type: 'number' },
  videoGeneratedImageRatio: { required: false, type: 'number' },
  videoRenderMode: { required: false, type: 'string' },
  renderMode: { required: false, type: 'string' },
  videoVisualStyle: { required: false, type: 'string' },
  videoImageModel: { required: false, type: 'string' },
  videoModel: { required: false, type: 'string' },
  videoReasoningEffort: { required: false, type: 'string' },
  videoFfmpegTimeoutMs: { required: false, type: 'number' },
  videoSegmentTimeoutMs: { required: false, type: 'number' },
  videoMuxTimeoutMs: { required: false, type: 'number' },
};

function parseJsonField(value, fallback = null) {
  if (value == null || value === '') {
    return fallback;
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch (_error) {
    return fallback;
  }
}

function parseBooleanField(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolveBooleanOption(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

function resolveNumberOption(...values) {
  for (const value of values) {
    if (value != null && value !== '') {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
  }
  return undefined;
}

function buildPodcastVideoOptions(input = {}, context = {}) {
  const nested = input.video && typeof input.video === 'object' ? input.video : {};
  const imageMode = input.videoImageMode || input.imageMode || nested.imageMode || 'generated';
  const contextModel = String(context?.model || context?.toolContext?.model || '').trim();
  return {
    topic: input.topic || input.prompt || input.subject || nested.topic || '',
    aspectRatio: input.videoAspectRatio || input.aspectRatio || nested.aspectRatio || '16:9',
    imageMode,
    generateImages: resolveBooleanOption(input.videoGenerateImages, input.generateImages, nested.generateImages),
    enhanceAudio: resolveBooleanOption(input.videoEnhanceAudio, input.enhanceAudio, nested.enhanceAudio),
    visualEffects: resolveBooleanOption(input.videoVisualEffects, input.visualEffects, nested.visualEffects),
    sceneCount: Number(input.videoSceneCount || input.sceneCount || nested.sceneCount) || undefined,
    generatedImageRatio: resolveNumberOption(input.videoGeneratedImageRatio, input.generatedImageRatio, nested.generatedImageRatio),
    renderMode: input.videoRenderMode || input.renderMode || nested.renderMode || undefined,
    visualStyle: input.videoVisualStyle || input.visualStyle || nested.visualStyle || '',
    imageModel: input.videoImageModel || input.imageModel || nested.imageModel || null,
    model: contextModel || input.videoModel || input.model || nested.model || null,
    reasoningEffort: input.videoReasoningEffort || input.reasoningEffort || nested.reasoningEffort || null,
    ffmpegTimeoutMs: Number(input.videoFfmpegTimeoutMs || input.ffmpegTimeoutMs || nested.ffmpegTimeoutMs) || undefined,
    segmentTimeoutMs: Number(input.videoSegmentTimeoutMs || input.segmentTimeoutMs || nested.segmentTimeoutMs) || undefined,
    muxTimeoutMs: Number(input.videoMuxTimeoutMs || input.muxTimeoutMs || nested.muxTimeoutMs) || undefined,
    useModel: nested.useModel === false || input.useModel === false ? false : undefined,
    scenes: Array.isArray(input.scenes) ? input.scenes : Array.isArray(nested.scenes) ? nested.scenes : undefined,
    toolManager: context.toolManager || null,
    toolContext: context.toolContext || {},
  };
}

function buildPodcastVideoContext(req, toolManager, sessionId) {
  const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
  const model = String(req.body?.model || metadata.model || metadata.selectedModel || '').trim() || null;
  return {
    sessionId,
    route: req.originalUrl || req.path || '/api/podcast/video',
    transport: 'http',
    executionProfile: 'podcast-video',
    clientSurface: 'podcast-video',
    taskType: 'podcast-video',
    userId: req.user?.id || req.user?.username || null,
    ownerId: getRequestOwnerId(req),
    model,
    toolManager,
  };
}

function normalizePodcastGenerateRequest(req, _res, next) {
  if (!req.body || typeof req.body !== 'object') {
    return next();
  }

  if (typeof req.body.topic !== 'string' || !req.body.topic.trim()) {
    const fallbackText = String(req.body.prompt || req.body.subject || '').trim();
    const fallbackTopic = hasExplicitPodcastIntent(fallbackText)
      ? extractExplicitPodcastTopic(fallbackText)
      : fallbackText;
    if (fallbackTopic) {
      req.body.topic = fallbackTopic;
    }
  }

  const requestText = [req.body.prompt, req.body.topic, req.body.subject]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!String(req.body.requestBrief || '').trim()) {
    const brief = extractPodcastRequestBrief(req.body.prompt || req.body.subject || requestText);
    if (brief) {
      req.body.requestBrief = brief;
    }
  }
  if (req.body.hostCount == null && req.body.speakerCount == null) {
    const inferredHostCount = inferPodcastHostCount(requestText);
    if (inferredHostCount) {
      req.body.hostCount = inferredHostCount;
    }
  }
  if (hasExplicitPodcastVideoIntent(requestText)) {
    const inferredVideoOptions = inferPodcastVideoOptions(requestText);
    for (const [key, value] of Object.entries(inferredVideoOptions)) {
      if (req.body[key] == null) {
        req.body[key] = value;
      }
    }
  }
  const inferredAudioAssetOptions = inferPodcastAudioAssetOptions(requestText);
  for (const [key, value] of Object.entries(inferredAudioAssetOptions)) {
    if (req.body[key] == null) {
      req.body[key] = value;
    }
  }

  return next();
}

function getRequestOwnerId(req) {
  return String(req.user?.username || req.user?.id || '').trim() || null;
}

async function resolvePodcastSessionId(req, requestedSessionId = null) {
  const ownerId = getRequestOwnerId(req);
  const normalized = typeof requestedSessionId === 'string' ? requestedSessionId.trim() : '';
  const body = req.body || {};
  const sessionMetadata = buildScopedSessionMetadata({
    mode: 'podcast',
    taskType: 'podcast',
    clientSurface: resolveClientSurface(body, null, 'podcast'),
    memoryScope: body.memoryScope || body.memory_scope || '',
  });

  if (ownerId) {
    const session = await sessionStore.resolveOwnedSession(
      normalized && !normalized.startsWith('local_') ? normalized : null,
      sessionMetadata,
      ownerId,
    );
    return session?.id || null;
  }

  if (normalized && !normalized.startsWith('local_')) {
    const session = await sessionStore.getOrCreate(normalized, sessionMetadata);
    return session?.id || normalized;
  }

  const session = await sessionStore.create(sessionMetadata);
  return session.id;
}

function buildPodcastContext(req, toolManager, sessionId) {
  const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
  const timezone = String(metadata.timezone || metadata.timeZone || req.get('x-timezone') || '').trim() || null;
  const model = String(req.body?.model || metadata.model || metadata.selectedModel || '').trim() || null;
  return {
    sessionId,
    userId: req.user?.id || req.user?.username || null,
    timestamp: new Date().toISOString(),
    route: req.originalUrl || req.path || '/api/podcast/generate',
    transport: 'http',
    executionProfile: 'podcast',
    timezone,
    model,
    clientSurface: 'podcast',
    taskType: 'podcast',
    toolManager,
    podcastService: req.app.locals?.podcastService || podcastService,
  };
}

router.get('/runtime', (_req, res) => {
  res.json({
    tts: ttsService.getPublicConfig(),
    audioProcessing: audioProcessingService.getPublicConfig(),
    video: podcastVideoService.getPublicConfig(),
    scriptDesigns: getPodcastScriptDesignOptions(),
  });
});

router.post('/generate', normalizePodcastGenerateRequest, validate(generateSchema), async (req, res, next) => {
  try {
    const toolManager = await ensureRuntimeToolManager(req.app);
    const sessionId = await resolvePodcastSessionId(req, req.body.sessionId);
    const podcastData = await (req.app.locals?.podcastService || podcastService).createPodcast(
      req.body || {},
      buildPodcastContext(req, toolManager, sessionId),
    );
    let videoData = null;
    if (req.body.includeVideo === true) {
      videoData = await (req.app.locals?.podcastVideoService || podcastVideoService).createVideoFromPodcast(
        podcastData,
        {
          sessionId,
          options: buildPodcastVideoOptions(req.body || {}, {
            toolManager,
            toolContext: buildPodcastVideoContext(req, toolManager, sessionId),
          }),
        },
      );
    }

    res.json({
      sessionId,
      ...podcastData,
      ...(videoData ? { video: videoData.video, videoArtifact: videoData.artifact, storyboard: videoData.storyboard } : {}),
    });
  } catch (error) {
    console.error('[PodcastRoute] Podcast generation failed', {
      stage: error?.podcastStage || error?.podcastDiagnostics?.stage || 'route',
      code: error?.code || null,
      statusCode: error?.statusCode || error?.status || null,
      message: error?.message || String(error),
      sessionId: req.body?.sessionId || null,
      topic: req.body?.topic || req.body?.prompt || req.body?.subject || '',
    });
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        error: {
          type: error.code || 'podcast_error',
          message: error.message,
          ...(error.podcastStage ? { stage: error.podcastStage } : {}),
          ...(error.podcastDiagnostics ? { diagnostics: error.podcastDiagnostics } : {}),
        },
      });
    }

    return next(error);
  }
});

router.post('/video/storyboard', async (req, res, next) => {
  try {
    const sessionId = await resolvePodcastSessionId(req, req.body?.sessionId);
    const storyboard = await (req.app.locals?.podcastVideoService || podcastVideoService).planStoryboard({
      title: req.body?.title || req.body?.topic || 'Podcast video',
      transcript: req.body?.transcript || req.body?.script?.transcript || '',
      turns: req.body?.turns || req.body?.script?.turns || [],
      durationSeconds: req.body?.durationSeconds,
      sceneCount: req.body?.sceneCount,
      visualStyle: req.body?.visualStyle,
      model: req.body?.model,
      reasoningEffort: req.body?.reasoningEffort,
      useModel: req.body?.useModel,
    });

    res.json({
      sessionId,
      ...storyboard,
    });
  } catch (error) {
    console.error('[PodcastRoute] Podcast storyboard failed', {
      stage: error?.podcastStage || error?.podcastDiagnostics?.stage || 'storyboard',
      code: error?.code || null,
      statusCode: error?.statusCode || error?.status || null,
      message: error?.message || String(error),
      sessionId: req.body?.sessionId || null,
      topic: req.body?.title || req.body?.topic || '',
    });
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        error: {
          type: error.code || 'podcast_video_error',
          message: error.message,
          ...(error.podcastStage ? { stage: error.podcastStage } : {}),
          ...(error.podcastDiagnostics ? { diagnostics: error.podcastDiagnostics } : {}),
        },
      });
    }
    return next(error);
  }
});

router.post('/video/render', async (req, res, next) => {
  try {
    const isMultipart = String(req.headers['content-type'] || '').toLowerCase().includes('multipart/form-data');
    const toolManager = await ensureRuntimeToolManager(req.app);

    if (isMultipart) {
      const { fields, file } = await parseMultipartRequest(req, {
        maxBytes: Math.max(config.audio.maxUploadBytes, 50 * 1024 * 1024),
      });
      const scenes = parseJsonField(fields.scenes, undefined);
      const sessionId = await resolvePodcastSessionId(req, fields.sessionId);
      const result = await (req.app.locals?.podcastVideoService || podcastVideoService).createVideoFromAudioUpload({
        sessionId,
        file,
        fields: {
          ...fields,
          scenes,
          generateImages: parseBooleanField(fields.generateImages, true),
          enhanceAudio: parseBooleanField(fields.enhanceAudio, false),
          visualEffects: parseBooleanField(fields.visualEffects, true),
          toolManager,
          toolContext: buildPodcastVideoContext(req, toolManager, sessionId),
        },
      });

      return res.status(201).json({
        sessionId,
        ...result,
      });
    }

    const body = req.body || {};
    const sessionId = await resolvePodcastSessionId(req, body.sessionId);
    const result = await (req.app.locals?.podcastVideoService || podcastVideoService).createVideoFromAudioArtifact({
      sessionId,
      audioArtifactId: body.audioArtifactId,
      title: body.title || body.topic || 'Podcast video',
      transcript: body.transcript || '',
      turns: body.turns || body.script?.turns || [],
      options: buildPodcastVideoOptions(body, {
        toolManager,
        toolContext: buildPodcastVideoContext(req, toolManager, sessionId),
      }),
    });

    return res.status(201).json({
      sessionId,
      ...result,
    });
  } catch (error) {
    console.error('[PodcastRoute] Podcast video render failed', {
      stage: error?.podcastStage || error?.podcastDiagnostics?.stage || 'video-render',
      code: error?.code || null,
      statusCode: error?.statusCode || error?.status || null,
      message: error?.message || String(error),
      sessionId: req.body?.sessionId || null,
      topic: req.body?.title || req.body?.topic || '',
    });
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        error: {
          type: error.code || 'podcast_video_error',
          message: error.message,
          ...(error.podcastStage ? { stage: error.podcastStage } : {}),
          ...(error.podcastDiagnostics ? { diagnostics: error.podcastDiagnostics } : {}),
        },
      });
    }
    return next(error);
  }
});

module.exports = router;

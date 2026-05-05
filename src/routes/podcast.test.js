const express = require('express');
const request = require('supertest');

jest.mock('../middleware/validate', () => ({
  validate: () => (_req, _res, next) => next(),
}));

jest.mock('../session-store', () => ({
  sessionStore: {
    resolveOwnedSession: jest.fn(),
    getOrCreate: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock('../tts/tts-service', () => ({
  ttsService: {
    getPublicConfig: jest.fn(() => ({
      configured: true,
      provider: 'piper',
      voices: [{ id: 'hfc-female-rich', label: 'HFC Rich' }],
    })),
  },
}));

jest.mock('../audio/audio-processing-service', () => ({
  audioProcessingService: {
    getPublicConfig: jest.fn(() => ({
      configured: true,
      provider: 'ffmpeg',
      supportsMp3: true,
      supportsMixing: true,
    })),
  },
}));

jest.mock('../podcast/podcast-service', () => ({
  getPodcastScriptDesignOptions: jest.fn(() => ([
    {
      id: 'classic-explainer',
      label: 'Classic Explainer',
      summary: 'Hook, context, three clear learning beats, practical wrap-up.',
      guidance: 'Use a clean teaching arc.',
    },
  ])),
  podcastService: {
    createPodcast: jest.fn(),
  },
}));

jest.mock('../video/podcast-video-service', () => ({
  podcastVideoService: {
    getPublicConfig: jest.fn(() => ({
      configured: true,
      provider: 'ffmpeg',
      supportsMp4: true,
    })),
    planStoryboard: jest.fn(),
    createVideoFromPodcast: jest.fn(),
    createVideoFromAudioArtifact: jest.fn(),
    createVideoFromAudioUpload: jest.fn(),
  },
}));

const { sessionStore } = require('../session-store');
const { podcastService } = require('../podcast/podcast-service');
const { podcastVideoService } = require('../video/podcast-video-service');
const podcastRouter = require('./podcast');

describe('/api/podcast', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStore.resolveOwnedSession.mockResolvedValue({ id: 'session-1' });
    sessionStore.create.mockResolvedValue({ id: 'session-created' });
  });

  test('returns podcast runtime capabilities', async () => {
    const app = express();
    app.use('/api/podcast', podcastRouter);

    const response = await request(app).get('/api/podcast/runtime');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      tts: expect.objectContaining({
        provider: 'piper',
      }),
      audioProcessing: expect.objectContaining({
        provider: 'ffmpeg',
        supportsMp3: true,
      }),
      video: expect.objectContaining({
        provider: 'ffmpeg',
        supportsMp4: true,
      }),
      scriptDesigns: [
        expect.objectContaining({
          id: 'classic-explainer',
          label: 'Classic Explainer',
        }),
      ],
    });
  });

  test('generates a podcast with a resolved session', async () => {
    podcastService.createPodcast.mockResolvedValue({
      title: 'Battery Breakdown',
      audio: { artifactId: 'artifact-podcast-1' },
      artifacts: [],
      artifactIds: [],
      script: { turns: [] },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { username: 'phill' };
      next();
    });
    app.locals.toolManager = { executeTool: jest.fn() };
    app.use('/api/podcast', podcastRouter);

    const response = await request(app)
      .post('/api/podcast/generate')
      .send({
        topic: 'How batteries work',
        sessionId: 'session-1',
        exportMp3: true,
        model: 'gpt-4o',
        detailLevel: 'rich',
        scriptDesign: 'documentary-narrative',
        scriptDesignExample: 'Cold open, then evidence beats, then a practical closing takeaway.',
      });

    expect(response.status).toBe(200);
    expect(sessionStore.resolveOwnedSession).toHaveBeenCalled();
    expect(podcastService.createPodcast).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'How batteries work',
      exportMp3: true,
      model: 'gpt-4o',
      detailLevel: 'rich',
      scriptDesign: 'documentary-narrative',
      scriptDesignExample: 'Cold open, then evidence beats, then a practical closing takeaway.',
    }), expect.objectContaining({
      sessionId: 'session-1',
      clientSurface: 'podcast',
      model: 'gpt-4o',
    }));
    expect(response.body).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      title: 'Battery Breakdown',
      audio: { artifactId: 'artifact-podcast-1' },
    }));
  });

  test('accepts prompt as a topic alias for podcast generation', async () => {
    podcastService.createPodcast.mockResolvedValue({
      title: 'Battery Breakdown',
      audio: { artifactId: 'artifact-podcast-1' },
      artifacts: [],
      artifactIds: [],
      script: { turns: [] },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { username: 'phill' };
      next();
    });
    app.locals.toolManager = { executeTool: jest.fn() };
    app.use('/api/podcast', podcastRouter);

    const response = await request(app)
      .post('/api/podcast/generate')
      .send({
        prompt: 'How batteries work',
      });

    expect(response.status).toBe(200);
    expect(podcastService.createPodcast).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'How batteries work',
      prompt: 'How batteries work',
    }), expect.any(Object));
  });

  test('maps known podcast errors to JSON responses', async () => {
    const error = new Error('ffmpeg is unavailable.');
    error.statusCode = 503;
    error.code = 'audio_processing_unavailable';
    podcastService.createPodcast.mockRejectedValue(error);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { username: 'phill' };
      next();
    });
    app.locals.toolManager = { executeTool: jest.fn() };
    app.use('/api/podcast', podcastRouter);

    const response = await request(app)
      .post('/api/podcast/generate')
      .send({
        topic: 'How batteries work',
      });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        type: 'audio_processing_unavailable',
        message: 'ffmpeg is unavailable.',
      },
    });
  });

  test('can render a video after podcast generation when requested', async () => {
    podcastService.createPodcast.mockResolvedValue({
      title: 'Battery Breakdown',
      audio: { artifactId: 'artifact-podcast-1' },
      artifacts: [],
      artifactIds: [],
      script: {
        transcript: 'Maya: Batteries store energy.',
        turns: [{ speaker: 'Maya', text: 'Batteries store energy.' }],
      },
    });
    podcastVideoService.createVideoFromPodcast.mockResolvedValue({
      video: { artifactId: 'artifact-video-1' },
      artifact: { id: 'artifact-video-1' },
      storyboard: { scenes: [{ id: 'scene-01' }] },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { username: 'phill' };
      next();
    });
    app.locals.toolManager = { executeTool: jest.fn() };
    app.use('/api/podcast', podcastRouter);

    const response = await request(app)
      .post('/api/podcast/generate')
      .send({
        topic: 'How batteries work',
        includeVideo: true,
        videoAspectRatio: '9:16',
        videoImageMode: 'mixed',
        videoGenerateImages: true,
        videoGeneratedImageRatio: 4,
        model: 'gpt-4o',
        videoModel: 'gpt-4o-mini',
      });

    expect(response.status).toBe(200);
    expect(podcastVideoService.createVideoFromPodcast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Battery Breakdown',
    }), expect.objectContaining({
      sessionId: 'session-1',
      options: expect.objectContaining({
        aspectRatio: '9:16',
        imageMode: 'mixed',
        generateImages: true,
        generatedImageRatio: 4,
        model: 'gpt-4o',
      }),
    }));
    expect(response.body.video).toEqual({ artifactId: 'artifact-video-1' });
    expect(response.body.storyboard).toEqual({ scenes: [{ id: 'scene-01' }] });
  });

  test('infers video rendering for video podcast prompt aliases', async () => {
    podcastService.createPodcast.mockResolvedValue({
      title: 'Battery Breakdown',
      audio: { artifactId: 'artifact-podcast-1' },
      artifacts: [],
      artifactIds: [],
      script: {
        transcript: 'Maya: Batteries store energy.',
        turns: [{ speaker: 'Maya', text: 'Batteries store energy.' }],
      },
    });
    podcastVideoService.createVideoFromPodcast.mockResolvedValue({
      video: { artifactId: 'artifact-video-1' },
      artifact: { id: 'artifact-video-1' },
      storyboard: { scenes: [{ id: 'scene-01' }] },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { username: 'phill' };
      next();
    });
    app.locals.toolManager = { executeTool: jest.fn() };
    app.use('/api/podcast', podcastRouter);

    const response = await request(app)
      .post('/api/podcast/generate')
      .send({
        prompt: 'Make a vertical video podcast about battery storage with generated images.',
      });

    expect(response.status).toBe(200);
    expect(podcastService.createPodcast).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'battery storage',
      includeVideo: true,
      videoAspectRatio: '9:16',
      videoRenderMode: 'storyboard',
      videoImageMode: 'generated',
      videoGenerateImages: true,
    }), expect.any(Object));
    expect(podcastVideoService.createVideoFromPodcast).toHaveBeenCalled();
    expect(response.body.video).toEqual({ artifactId: 'artifact-video-1' });
  });

  test('plans a podcast video storyboard', async () => {
    podcastVideoService.planStoryboard.mockResolvedValue({
      title: 'Storyboard',
      durationSeconds: 60,
      scenes: [{ id: 'scene-01', start: 0, end: 8 }],
      planning: { provider: 'local' },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { username: 'phill' };
      next();
    });
    app.use('/api/podcast', podcastRouter);

    const response = await request(app)
      .post('/api/podcast/video/storyboard')
      .send({
        title: 'Episode',
        transcript: 'This is the transcript.',
        durationSeconds: 60,
      });

    expect(response.status).toBe(200);
    expect(podcastVideoService.planStoryboard).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Episode',
      transcript: 'This is the transcript.',
      durationSeconds: 60,
    }));
    expect(response.body.scenes).toEqual([{ id: 'scene-01', start: 0, end: 8 }]);
  });
});

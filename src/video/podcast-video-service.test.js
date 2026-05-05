const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  PodcastVideoService,
  buildFallbackStoryboard,
  buildSceneImagePrompt,
} = require('./podcast-video-service');

describe('PodcastVideoService', () => {
  function ppmDataUrl(width, height, pixels) {
    const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
    return `data:image/x-portable-pixmap;base64,${Buffer.concat([header, Buffer.from(pixels)]).toString('base64')}`;
  }

  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('builds a local timed storyboard from transcript text', () => {
    const scenes = buildFallbackStoryboard({
      title: 'Battery storage',
      transcript: 'Batteries store energy. They release it when demand rises. Grid operators use them for flexibility.',
      durationSeconds: 24,
      sceneCount: 3,
    });

    expect(scenes).toHaveLength(3);
    expect(scenes[0]).toEqual(expect.objectContaining({
      id: 'scene-01',
      start: 0,
      visualPrompt: expect.stringContaining('Battery storage'),
    }));
    expect(scenes[2].end).toBeCloseTo(24);
  });

  test('uses fourteen rotating visuals by default when scene count is not provided', async () => {
    const service = new PodcastVideoService({
      createResponse: jest.fn(),
    });

    const result = await service.planStoryboard({
      title: 'Particle physics news',
      transcript: 'A new result changes the discussion. Researchers explain what it means. The next experiment will narrow the uncertainty.',
      durationSeconds: 280,
      useModel: false,
    });

    expect(result.scenes).toHaveLength(14);
    expect(service.getPublicConfig().defaults.sceneCount).toBe(14);
  });

  test('uses local planning when model planning is disabled', async () => {
    const service = new PodcastVideoService({
      createResponse: jest.fn(),
    });

    const result = await service.planStoryboard({
      title: 'Episode',
      transcript: 'A short transcript for a video plan.',
      durationSeconds: 12,
      sceneCount: 2,
      useModel: false,
    });

    expect(result.planning.provider).toBe('local');
    expect(result.scenes).toHaveLength(2);
  });

  test('builds creative infographic prompts for generated scene slides', () => {
    const prompt = buildSceneImagePrompt({
      id: 'scene-04',
      summary: 'Heat pumps lower winter electricity costs',
      caption: 'The hosts compare installation costs against winter energy savings.',
      slideType: 'evidence-dashboard',
      keyFacts: ['Lower operating costs during winter peaks', 'Installation cost is paid back over time'],
      contentReads: ['Transcript segment on heat pump economics'],
      contentWrites: ['Show a metric tile for savings and a payback timeline'],
      visualPrompt: 'home energy savings explainer',
    }, {
      orientation: 'landscape',
    });

    expect(prompt).toContain('premium widescreen image slide');
    expect(prompt).toContain('long-form sandbox infographic page');
    expect(prompt).toMatch(/timeline|comparison|process-flow|priority matrix|radial impact map|editorial dashboard/);
    expect(prompt).toContain('Heat pumps lower winter electricity costs');
    expect(prompt).toContain('Facts to visually encode');
    expect(prompt).toContain('Content to write into the slide');
    expect(prompt).toContain('no watermarks');
  });

  test('uses adaptive ffmpeg timeouts and fast x264 settings when rendering', async () => {
    const service = new PodcastVideoService({
      audioProcessingService: {
        assertConfigured: jest.fn(),
        getEffectiveBinaryPath: () => 'ffmpeg',
      },
      isUnsplashConfigured: () => false,
    });
    const ffmpegCalls = [];
    jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args, options) => {
      ffmpegCalls.push({ args, options });
      await fs.writeFile(args[args.length - 1], Buffer.from('mp4'));
      return { stdout: '', stderr: '' };
    });

    const result = await service.renderMp4({
      audioBuffer: Buffer.from('audio'),
      audioMimeType: 'audio/wav',
      title: 'Longer render',
      imageMode: 'fallback',
      scenes: [{
        start: 0,
        end: 90,
        summary: 'Particle physics update',
        visualPrompt: 'particle detector newsroom still',
      }],
      segmentTimeoutMs: 90000,
      muxTimeoutMs: 100000,
      maxFfmpegTimeoutMs: 300000,
      x264Preset: 'ultrafast',
      x264Crf: 28,
      renderMode: 'storyboard',
    });

    expect(result.buffer).toEqual(Buffer.from('mp4'));
    expect(ffmpegCalls).toHaveLength(2);
    expect(ffmpegCalls[0].args).toEqual(expect.arrayContaining([
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
    ]));
    expect(ffmpegCalls[0].options).toEqual(expect.objectContaining({
      timeoutMs: 240000,
      stage: 'scene 1/1',
    }));
    expect(ffmpegCalls[1].options).toEqual(expect.objectContaining({
      timeoutMs: 246000,
      stage: 'final mux',
    }));
    expect(ffmpegCalls[1].args).toEqual(expect.arrayContaining([
      '-filter_complex',
      '-map', '[v]',
      '-c:v', 'libx264',
    ]));
    expect(ffmpegCalls[1].args.join(' ')).toContain('showwaves');
    expect(ffmpegCalls[1].args.join(' ')).not.toContain('-c:v copy');
    expect(result.audioWaveformOverlayEnabled).toBe(true);
  });

  test('defaults to a deterministic waveform-card H.264 AVC render for compatibility', async () => {
    const service = new PodcastVideoService({
      audioProcessingService: {
        assertConfigured: jest.fn(),
        getEffectiveBinaryPath: () => 'ffmpeg',
      },
      isUnsplashConfigured: () => false,
    });
    const ffmpegCalls = [];
    jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args, options) => {
      ffmpegCalls.push({ args, options });
      await fs.writeFile(args[args.length - 1], Buffer.from('mp4'));
      return { stdout: '', stderr: '' };
    });

    const result = await service.renderMp4({
      audioBuffer: Buffer.from('audio'),
      title: 'Particle physics news',
      imageMode: 'fallback',
      scenes: [
        {
          start: 0,
          end: 30,
          summary: 'Collider result update',
          visualPrompt: 'particle detector show card',
        },
        {
          start: 30,
          end: 60,
          summary: 'Why it matters',
          visualPrompt: 'science news studio monitor wall',
        },
      ],
      muxTimeoutMs: 100000,
      maxFfmpegTimeoutMs: 300000,
    });

    expect(result.renderMode).toBe('waveform-card');
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0].args).toEqual(expect.arrayContaining([
      '-loop', '1',
      '-filter_complex',
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level:v', '4.1',
      '-pix_fmt', 'yuv420p',
      '-tag:v', 'avc1',
      '-c:a', 'aac',
      '-ac', '2',
      '-ar', '48000',
    ]));
    expect(ffmpegCalls[0].args.join(' ')).toContain('showwaves');
    expect(ffmpegCalls[0].options).toEqual(expect.objectContaining({
      timeoutMs: 180000,
      stage: 'waveform-card render',
    }));
    expect(result.scenes[0].image).toEqual(expect.objectContaining({
      source: 'waveform-card',
    }));
  }, 10000);

  test('keeps video podcast audio clean by default without repair filters', async () => {
    const service = new PodcastVideoService({
      audioProcessingService: {
        assertConfigured: jest.fn(),
        getEffectiveBinaryPath: () => 'ffmpeg',
        buildPodcastMasteringFilter: jest.fn(() => 'repair-filter'),
      },
      isUnsplashConfigured: () => false,
    });
    const ffmpegCalls = [];
    jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args, options) => {
      ffmpegCalls.push({ args, options });
      await fs.writeFile(args[args.length - 1], Buffer.from('mp4'));
      return { stdout: '', stderr: '' };
    });

    await service.renderMp4({
      audioBuffer: Buffer.from('audio'),
      title: 'Clean video audio',
      imageMode: 'fallback',
      scenes: [{
        start: 0,
        end: 12,
        summary: 'Audio cleanup',
        visualPrompt: 'podcast studio visual',
      }],
    });

    const muxArgs = ffmpegCalls[0].args;
    expect(muxArgs).not.toEqual(expect.arrayContaining([
      '-af', 'repair-filter',
    ]));
    expect(muxArgs).toEqual(expect.arrayContaining([
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-ar', '48000',
    ]));
  });

  test('applies podcast audio repair when explicitly requested', async () => {
    const service = new PodcastVideoService({
      audioProcessingService: {
        assertConfigured: jest.fn(),
        getEffectiveBinaryPath: () => 'ffmpeg',
        buildPodcastMasteringFilter: jest.fn(() => 'repair-filter'),
      },
      isUnsplashConfigured: () => false,
    });
    const ffmpegCalls = [];
    jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args, options) => {
      ffmpegCalls.push({ args, options });
      await fs.writeFile(args[args.length - 1], Buffer.from('mp4'));
      return { stdout: '', stderr: '' };
    });

    await service.renderMp4({
      audioBuffer: Buffer.from('audio'),
      title: 'Clean video audio',
      imageMode: 'fallback',
      enhanceAudio: true,
      scenes: [{
        start: 0,
        end: 12,
        summary: 'Audio cleanup',
        visualPrompt: 'podcast studio visual',
      }],
    });

    const muxArgs = ffmpegCalls[0].args;
    expect(muxArgs).toEqual(expect.arrayContaining([
      '-af', 'repair-filter',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-ar', '48000',
    ]));
  });

  test('can render the default waveform card from an upload without transcript transcription', async () => {
    const transcriptionService = {
      transcribe: jest.fn(),
    };
    const service = new PodcastVideoService({
      transcriptionService,
      isUnsplashConfigured: () => false,
    });
    jest.spyOn(service, 'getAudioDurationSeconds').mockResolvedValue(8);
    jest.spyOn(service, 'renderMp4').mockResolvedValue({
      buffer: Buffer.from('mp4'),
      scenes: [{
        id: 'scene-01',
        image: { source: 'waveform-card' },
      }],
      dimensions: { width: 1280, height: 720 },
      renderMode: 'waveform-card',
      audioRepairEnabled: false,
      visualEffectsEnabled: false,
    });
    jest.spyOn(service, 'persistVideo').mockResolvedValue({
      artifact: { id: 'artifact-video-1' },
      video: { artifactId: 'artifact-video-1' },
    });

    const result = await service.createVideoFromAudioUpload({
      sessionId: 'session-1',
      file: {
        buffer: Buffer.from('audio'),
        filename: 'episode.wav',
        mimeType: 'audio/wav',
      },
      fields: {
        title: 'Episode',
      },
    });

    expect(transcriptionService.transcribe).not.toHaveBeenCalled();
    expect(service.renderMp4).toHaveBeenCalledWith(expect.objectContaining({
      renderMode: 'waveform-card',
    }));
    expect(result.video).toEqual({ artifactId: 'artifact-video-1' });
  });

  test('supports explicit single static-card mode when requested', async () => {
    const service = new PodcastVideoService({
      audioProcessingService: {
        assertConfigured: jest.fn(),
        getEffectiveBinaryPath: () => 'ffmpeg',
      },
      isUnsplashConfigured: () => false,
    });
    const ffmpegCalls = [];
    jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args, options) => {
      ffmpegCalls.push({ args, options });
      await fs.writeFile(args[args.length - 1], Buffer.from('mp4'));
      return { stdout: '', stderr: '' };
    });

    const result = await service.renderMp4({
      audioBuffer: Buffer.from('audio'),
      title: 'Particle physics news',
      imageMode: 'fallback',
      scenes: [{
        start: 0,
        end: 60,
        summary: 'Collider result update',
        visualPrompt: 'particle detector show card',
      }],
      renderMode: 'static-card',
      muxTimeoutMs: 100000,
      maxFfmpegTimeoutMs: 300000,
    });

    expect(result.renderMode).toBe('static-card');
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0].args).toEqual(expect.arrayContaining([
      '-loop', '1',
      '-filter_complex',
      '-map', '[v]',
      '-c:v', 'libx264',
      '-tag:v', 'avc1',
      '-c:a', 'aac',
    ]));
    expect(ffmpegCalls[0].args.join(' ')).toContain('showwaves');
    expect(ffmpegCalls[0].options).toEqual(expect.objectContaining({
      timeoutMs: 180000,
      stage: 'static show-card render',
    }));
    expect(result.audioWaveformOverlayEnabled).toBe(true);
  });

  test('can harvest an image from a web-search result via web-fetch', async () => {
    const imageBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 8),
    ]);
    global.fetch = jest.fn(async (url) => {
      if (url === 'https://cdn.example.com/story.jpg') {
        return {
          ok: true,
          headers: {
            get: () => 'image/jpeg',
          },
          arrayBuffer: async () => imageBytes,
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          data: {
            results: [{ title: 'Story page', url: 'https://example.com/story', source: 'example.com' }],
          },
        };
      }
      if (toolId === 'web-fetch') {
        return {
          data: {
            url: 'https://example.com/story',
            body: '<html><head><meta property="og:image" content="https://cdn.example.com/story.jpg"></head></html>',
          },
        };
      }
      throw new Error(`unexpected tool ${toolId}`);
    });
    const service = new PodcastVideoService({
      isUnsplashConfigured: () => false,
      searchImages: jest.fn(),
      generateImageBatch: jest.fn(),
    });

    const image = await service.resolveSceneImage({
      id: 'scene-01',
      summary: 'Grid batteries',
      visualQuery: 'grid battery storage',
    }, {
      imageMode: 'web',
      toolManager: { executeTool },
      toolContext: { sessionId: 'session-1' },
    });

    expect(executeTool).toHaveBeenCalledWith('web-search', expect.objectContaining({
      query: 'grid battery storage photo image',
    }), expect.any(Object));
    expect(executeTool).toHaveBeenCalledWith('web-fetch', expect.objectContaining({
      url: 'https://example.com/story',
    }), expect.any(Object));
    expect(image).toEqual(expect.objectContaining({
      source: 'web-search',
      url: 'https://cdn.example.com/story.jpg',
      extension: 'jpg',
      buffer: imageBytes,
    }));
  });

  test('prefers generated images for four out of five mixed storyboard scenes', async () => {
    const generatedSlide = ppmDataUrl(16, 16, Array.from({ length: 16 * 16 * 3 }, (_value, index) => (
      [20, 90, 160, 230, 210, 120][index % 6]
    )));
    const executeTool = jest.fn(async () => ({
      data: {
        results: [{ title: 'Stock page', url: 'https://example.com/stock' }],
      },
    }));
    const generateImageBatch = jest.fn(async () => ({
      data: [{ url: generatedSlide, revised_prompt: 'generated storyboard slide' }],
    }));
    const searchImages = jest.fn();
    const service = new PodcastVideoService({
      isUnsplashConfigured: () => true,
      searchImages,
      generateImageBatch,
    });

    const image = await service.resolveSceneImage({
      id: 'scene-01',
      summary: 'Grid batteries',
      visualPrompt: 'grid battery infographic',
    }, {
      imageMode: 'mixed',
      generateImages: true,
      generatedImageRatio: 4,
      toolManager: { executeTool },
      toolContext: { sessionId: 'session-1' },
    });

    expect(generateImageBatch).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(searchImages).not.toHaveBeenCalled();
    expect(image).toEqual(expect.objectContaining({
      source: 'generated',
      revisedPrompt: 'generated storyboard slide',
    }));
  });

  test('keeps one mixed storyboard slot for web or Unsplash variety', async () => {
    const stockSlide = ppmDataUrl(16, 16, Array.from({ length: 16 * 16 * 3 }, (_value, index) => (
      [230, 220, 180, 40, 120, 170][index % 6]
    )));
    const generateImageBatch = jest.fn();
    const searchImages = jest.fn(async () => ({
      results: [{
        urls: { regular: stockSlide },
        author: { name: 'Example Photographer', username: 'example', link: 'https://unsplash.example/u/example' },
        links: { html: 'https://unsplash.example/photo' },
      }],
    }));
    const service = new PodcastVideoService({
      isUnsplashConfigured: () => true,
      searchImages,
      generateImageBatch,
    });

    const image = await service.resolveSceneImage({
      id: 'scene-05',
      summary: 'Grid batteries',
      visualQuery: 'grid battery storage',
    }, {
      imageMode: 'mixed',
      generateImages: true,
      generatedImageRatio: 4,
    });

    expect(searchImages).toHaveBeenCalledWith('grid battery storage', expect.objectContaining({
      perPage: 1,
    }));
    expect(generateImageBatch).not.toHaveBeenCalled();
    expect(image).toEqual(expect.objectContaining({
      source: 'unsplash',
      url: stockSlide,
    }));
  });

  test('retries generated scene images that look like solid blue or pink placeholders', async () => {
    const badPink = ppmDataUrl(16, 16, Array.from({ length: 16 * 16 * 3 }, (_value, index) => (
      [255, 80, 210][index % 3]
    )));
    const usable = ppmDataUrl(2, 2, [
      10, 20, 30, 240, 220, 180,
      80, 120, 60, 20, 180, 210,
    ]);
    const generateImageBatch = jest.fn()
      .mockResolvedValueOnce({ data: [{ url: badPink }] })
      .mockResolvedValueOnce({ data: [{ url: usable, revised_prompt: 'usable visual' }] });
    const service = new PodcastVideoService({
      isUnsplashConfigured: () => false,
      searchImages: jest.fn(),
      generateImageBatch,
    });

    const image = await service.resolveSceneImage({
      id: 'scene-02',
      summary: 'Access control room',
      visualPrompt: 'A realistic access control room with no text.',
    }, {
      imageMode: 'generated',
      generateImages: true,
      imageRetryAttempts: 2,
    });

    expect(generateImageBatch).toHaveBeenCalledTimes(2);
    expect(generateImageBatch.mock.calls[0][0].prompt).toContain('premium');
    expect(generateImageBatch.mock.calls[0][0].prompt).toContain('infographic');
    expect(image).toEqual(expect.objectContaining({
      source: 'generated',
      revisedPrompt: 'usable visual',
      retryCount: 1,
    }));
  });

  test('replaces downloaded scene images that validate as black frames', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-image-validate-test-'));
    const blackPreview = Buffer.concat([
      Buffer.from('P6\n64 36\n255\n', 'ascii'),
      Buffer.alloc(64 * 36 * 3, 0),
    ]);
    const service = new PodcastVideoService({
      isUnsplashConfigured: () => false,
    });
    jest.spyOn(service, 'resolveSceneImage').mockResolvedValue({
      buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0)]),
      mimeType: 'image/jpeg',
      extension: 'jpg',
      source: 'generated',
      url: 'https://example.com/black.jpg',
    });
    jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args) => {
      await fs.writeFile(args[args.length - 1], blackPreview);
      return { stdout: '', stderr: '' };
    });

    try {
      const assets = await service.prepareSceneImages([{
        id: 'scene-01',
        summary: 'Opening',
        visualPrompt: 'opening visual',
      }], {
        tempDir,
        width: 1280,
        height: 720,
        imageMode: 'generated',
        generateImages: true,
      });

      expect(assets[0]).toEqual(expect.objectContaining({
        source: 'fallback',
        replacedSource: 'generated',
        extension: 'ppm',
      }));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

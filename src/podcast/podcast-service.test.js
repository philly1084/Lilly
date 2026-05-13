jest.mock('../openai-client', () => ({
  createResponse: jest.fn(),
}));

jest.mock('../tts/tts-service', () => ({
  ttsService: {
    getPublicConfig: jest.fn(() => ({
      configured: true,
      provider: 'kokoro',
      maxTextChars: 2400,
      timeoutMs: 45000,
      podcastTimeoutMs: 210000,
      podcastChunkChars: 760,
      defaultVoiceId: 'af_heart',
      voices: [
        { id: 'af_heart', label: 'Heart Studio', provider: 'kokoro', aliases: ['lessac-high'] },
        { id: 'af_bella', label: 'Bella Expressive', provider: 'kokoro', aliases: ['ljspeech-high'] },
        { id: 'af_nicole', label: 'Nicole Clear', provider: 'kokoro' },
        { id: 'am_adam', label: 'Adam Narrator', provider: 'kokoro', aliases: ['ryan-high'] },
        { id: 'am_michael', label: 'Michael Casual', provider: 'kokoro' },
        { id: 'bf_emma', label: 'Emma Editorial', provider: 'kokoro', aliases: ['cori-high'] },
        { id: 'bm_george', label: 'George Classic', provider: 'kokoro' },
        { id: 'lessac-high', label: 'Lessac Studio', provider: 'piper' },
        { id: 'lessac-bright', label: 'Lessac Bright', provider: 'piper' },
        { id: 'ljspeech-high', label: 'LJ Narrator', provider: 'piper' },
        { id: 'ryan-high', label: 'Ryan Deep', provider: 'piper' },
        { id: 'ryan-direct', label: 'Ryan Direct', provider: 'piper' },
        { id: 'cori-high', label: 'Cori British', provider: 'piper' },
        { id: 'hfc-female-rich', label: 'HFC Rich', provider: 'piper' },
        { id: 'hfc-female-medium', label: 'HFC Warm', provider: 'piper' },
        { id: 'kathleen-low', label: 'Kathleen Gentle', provider: 'piper' },
        { id: 'amy-expressive', label: 'Amy Expressive', provider: 'piper' },
        { id: 'amy-broadcast', label: 'Amy Broadcast', provider: 'piper' },
        { id: 'amy-medium', label: 'Amy Medium', provider: 'piper' },
      ],
    })),
    synthesize: jest.fn(),
  },
  normalizeTextForSpeech: jest.fn((text) => text),
}));

jest.mock('../tts/speech-text', () => ({
  normalizeTextForSpeech: jest.fn((text) => text),
}));

jest.mock('../generated-audio-artifacts', () => ({
  persistGeneratedAudio: jest.fn(),
  updateGeneratedAudioSessionState: jest.fn(),
}));

jest.mock('../audio/audio-processing-service', () => ({
  audioProcessingService: {
    getPublicConfig: jest.fn(() => ({
      configured: true,
      provider: 'ffmpeg',
      supportsMp3: true,
      supportsMixing: true,
      defaults: {
        masteringEnabled: true,
        musicBedPathConfigured: false,
        mp3BitrateKbps: 192,
      },
      diagnostics: {
        status: 'ready',
      },
    })),
    composePodcastAudio: jest.fn(async ({ speechWavBuffer }) => speechWavBuffer),
    transcodeWavToMp3: jest.fn(async () => Buffer.from('mp3-bytes')),
  },
}));

jest.mock('../artifacts/artifact-service', () => ({
  artifactService: {
    buildPromptContext: jest.fn(),
  },
}));

const { createResponse } = require('../openai-client');
const { ttsService } = require('../tts/tts-service');
const { persistGeneratedAudio, updateGeneratedAudioSessionState } = require('../generated-audio-artifacts');
const { audioProcessingService } = require('../audio/audio-processing-service');
const { artifactService } = require('../artifacts/artifact-service');
const settingsController = require('../routes/admin/settings.controller');
const { parseWavBuffer, writeWavBuffer } = require('../audio/wav-utils');
const { PodcastService, getPodcastScriptDesignOptions } = require('./podcast-service');

function createTestWav(bytes) {
  return writeWavBuffer({
    sampleRate: 22050,
    bitsPerSample: 16,
    numChannels: 1,
    data: Buffer.from(bytes),
  });
}

describe('PodcastService', () => {
  let originalModelSettings;

  beforeEach(() => {
    jest.clearAllMocks();
    originalModelSettings = {
      ...(settingsController.settings?.models || {}),
    };
    settingsController.settings.models = {
      ...(settingsController.settings?.models || {}),
      defaultModel: 'gpt-4o',
      fallbackModel: 'gpt-4o-mini',
    };
    createResponse.mockResolvedValue({
      output_text: JSON.stringify({
        title: 'The Battery Breakdown',
        summary: 'A practical conversation about how battery storage works.',
        turns: [
          { speaker: 'Maya', text: 'Welcome in. Today we are unpacking grid batteries and why they matter.' },
          { speaker: 'June', text: 'The core idea is simple: they store energy when supply is abundant and release it when demand rises.' },
          { speaker: 'Maya', text: 'That flexibility helps balance solar and wind output instead of wasting it.' },
          { speaker: 'June', text: 'It also supports the grid during short spikes, which is where response speed matters.' },
          { speaker: 'Maya', text: 'Different chemistries have different strengths, and lithium-ion is only one piece of the picture.' },
          { speaker: 'June', text: 'Exactly, and project economics depend on cycle life, safety, and the duration the system needs to cover.' },
          { speaker: 'Maya', text: 'So the interesting question is less whether batteries matter and more where they fit best.' },
          { speaker: 'June', text: 'And that is where careful system design and policy choices start to shape outcomes.' },
        ],
      }),
    });
    ttsService.synthesize.mockResolvedValue({
      audioBuffer: createTestWav([1, 2, 3, 4]),
      voice: { provider: 'piper' },
      contentType: 'audio/wav',
      text: 'segment',
    });
    artifactService.buildPromptContext.mockResolvedValue('');
    persistGeneratedAudio.mockResolvedValue({
      artifact: { id: 'artifact-podcast-1', filename: 'battery-breakdown.wav' },
      artifactIds: ['artifact-podcast-1'],
      audio: { artifactId: 'artifact-podcast-1', downloadUrl: '/api/artifacts/artifact-podcast-1/download' },
    });
    updateGeneratedAudioSessionState.mockResolvedValue({});
  });

  afterEach(() => {
    settingsController.settings.models = originalModelSettings;
  });

  test('exposes twenty podcast script presentation design examples', () => {
    const designs = getPodcastScriptDesignOptions();

    expect(designs).toHaveLength(20);
    expect(designs.map((design) => design.id)).toEqual(expect.arrayContaining([
      'classic-explainer',
      'documentary-narrative',
      'technical-deep-dive',
      'human-impact',
    ]));
  });

  test('creates a researched two-host podcast and persists the final audio', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Grid battery guide', url: 'https://example.com/batteries', snippet: 'Battery storage helps balance power systems.' },
              { title: 'Storage economics', url: 'https://example.com/economics', snippet: 'Costs vary by chemistry and duration.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><h1>Battery storage</h1><p>Battery systems absorb excess power and discharge it later.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
      durationMinutes: 10,
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(executeTool).toHaveBeenCalledWith('web-search', expect.objectContaining({
      query: expect.stringContaining('How grid batteries work'),
    }), expect.any(Object));
    expect(createResponse).toHaveBeenCalled();
    expect(ttsService.synthesize).toHaveBeenCalled();
    expect(audioProcessingService.composePodcastAudio).not.toHaveBeenCalled();
    expect(persistGeneratedAudio).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      mimeType: 'audio/wav',
      metadata: expect.objectContaining({
        generatedBy: 'podcast',
        topic: 'How grid batteries work',
        processing: expect.objectContaining({
          voiceOnlyAudio: true,
          packaging: 'native-wav',
          allowProviderFallback: false,
        }),
        actualTurnVoices: expect.arrayContaining([
          expect.objectContaining({
            requestedProvider: 'kokoro',
            providerFallbackAllowed: false,
          }),
        ]),
        ttsSegments: expect.any(Array),
      }),
    }));
    expect(result.audio).toEqual(expect.objectContaining({
      artifactId: 'artifact-podcast-1',
    }));
    expect(result.script.turns).toHaveLength(8);
    expect(result.hosts).toHaveLength(2);
    expect(result.hosts[0].voiceId).not.toBe(result.hosts[1].voiceId);
    expect(result.processing.enhanced).toBe(false);
    expect(result.processing.voiceOnlyAudio).toBe(true);
    expect(result.processing.packaging).toBe('native-wav');
  });

  test('keeps detailed solo creative briefs in the script prompt', async () => {
    createResponse.mockResolvedValueOnce({
      output_text: JSON.stringify({
        title: 'NASA After Dark: Real Space Facts for a Sci-Fi Night',
        summary: 'A solo sci-fi night episode grounded in NASA facts.',
        turns: [
          { speaker: 'Maya', text: 'Tonight starts with Voyager, a real spacecraft carrying human traces into interstellar space.' },
          { speaker: 'Maya', text: 'From there, the ISS becomes the nearest version of science fiction we already live with.' },
          { speaker: 'Maya', text: 'Mars rovers and the Deep Space Network turn distant machines into something almost intimate.' },
          { speaker: 'Maya', text: 'And Parker Solar Probe, JWST, and Apollo moon dust make the night feel stranger because they are real.' },
        ],
      }),
    });
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'NASA facts', url: 'https://example.com/nasa', snippet: 'NASA missions include Voyager, the ISS, Mars rovers, and JWST.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Voyager, the International Space Station, Mars rovers, the Deep Space Network, Parker Solar Probe, JWST, and Apollo lunar samples are NASA-related facts.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });
    const requestBrief = 'Title: NASA After Dark: Real Space Facts for a Sci-Fi Night. Format: one host. Angle: cinematic but grounded, using Voyager, the ISS, Mars rovers, the Deep Space Network, Parker Solar Probe, JWST, and Apollo moon dust as launch points for sci-fi imagination.';

    const result = await service.createPodcast({
      topic: 'NASA facts for a sci-fi night',
      requestBrief,
      hostCount: 1,
      hostAName: 'Maya',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    const prompt = createResponse.mock.calls[0][0].input;
    expect(prompt).toContain('Create a scripted solo-host, one-speaker podcast episode');
    expect(prompt).toContain('User request brief: Title: NASA After Dark');
    expect(prompt).toContain('Treat the user request brief as binding editorial direction');
    expect(prompt).toContain('Treat explicitly named facts in the request brief as user-provided source material');
    expect(prompt).toContain('Do not introduce a co-host');
    expect(prompt).not.toContain('Host 2:');
    expect(result.hosts).toHaveLength(1);
    expect(new Set(result.script.turns.map((turn) => turn.speaker))).toEqual(new Set(['Maya']));
  });

  test('applies selected script presentation designs and anti-meta-language guardrails', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Grid battery guide', url: 'https://example.com/batteries', snippet: 'Battery storage helps balance power systems.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Battery systems absorb excess power and discharge it later.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
      detailLevel: 'rich',
      scriptDesign: 'documentary-narrative',
      scriptDesignExample: 'Cold open, then stakes, then sourced evidence, then a concise takeaway.',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    const prompt = createResponse.mock.calls[0][0].input;
    expect(prompt).toContain('Script presentation design:');
    expect(prompt).toContain('Detail level: rich');
    expect(prompt).toContain('- selected: Documentary Narrative');
    expect(prompt).toContain('User-provided presentation example:');
    expect(prompt).toContain('Do not overuse self-referential process language');
    expect(prompt).toContain('Prefer proper full scripts over short outline-like exchanges');
    expect(result.script.design).toEqual(expect.objectContaining({
      id: 'documentary-narrative',
      label: 'Documentary Narrative',
    }));
    expect(persistGeneratedAudio).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        scriptDesign: 'documentary-narrative',
        scriptDesignLabel: 'Documentary Narrative',
        detailLevel: 'rich',
        scriptDesignExample: 'Cold open, then stakes, then sourced evidence, then a concise takeaway.',
      }),
    }));
  });

  test('annotates and logs the failing podcast stage', async () => {
    const service = new PodcastService();
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const executeTool = jest.fn(async () => {
      const error = new Error('Search backend unavailable');
      error.code = 'web_search_unavailable';
      throw error;
    });

    await expect(service.createPodcast({
      topic: 'How grid batteries work',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    })).rejects.toMatchObject({
      message: 'Search backend unavailable',
      podcastStage: 'research',
      podcastDiagnostics: expect.objectContaining({
        stage: 'research',
        sessionId: 'session-1',
        topic: 'How grid batteries work',
      }),
    });

    expect(logSpy).toHaveBeenCalledWith('[PodcastService] Stage failed: research', expect.objectContaining({
      code: 'web_search_unavailable',
      message: 'Search backend unavailable',
      sessionId: 'session-1',
      topic: 'How grid batteries work',
    }));

    logSpy.mockRestore();
  });

  test('does not create a synthetic music bed when music is requested but no bed asset exists', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return { success: true, data: { results: [{ title: 'A', url: 'https://example.com/a', snippet: 'A' }] } };
      }
      if (toolId === 'web-fetch') {
        return { success: true, data: { headers: { 'content-type': 'text/html' }, body: '<p>Battery systems store energy.</p>' } };
      }
      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
      includeMusicBed: true,
      includeVideo: true,
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(audioProcessingService.composePodcastAudio).not.toHaveBeenCalled();
    expect(result.processing.voiceOnlyAudio).toBe(true);
    expect(result.processing.musicBedApplied).toBe(false);
  });

  test('strips non-speaker audio cues before TTS and transcript persistence', async () => {
    createResponse.mockResolvedValueOnce({
      output_text: JSON.stringify({
        title: 'Cue Cleanup',
        summary: 'A cue cleanup check.',
        turns: [
          { speaker: 'Maya', text: '[music fades] Welcome to the actual episode.' },
          { speaker: 'June', text: 'SFX: soft chime\nThe real point is the spoken line.' },
          { speaker: 'Maya', text: 'That means the packaged WAV should stay voice only.' },
          { speaker: 'June', text: '(applause) Exactly, just the two speakers.' },
        ],
      }),
    });
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return { success: true, data: { results: [{ title: 'A', url: 'https://example.com/a', snippet: 'A' }] } };
      }
      if (toolId === 'web-fetch') {
        return { success: true, data: { headers: { 'content-type': 'text/html' }, body: '<p>Podcast audio should be clean.</p>' } };
      }
      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How to keep podcast audio clean',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    const synthesizedText = ttsService.synthesize.mock.calls.map(([call]) => call.text).join('\n');
    expect(synthesizedText).not.toMatch(/music|SFX|applause/i);
    expect(result.script.transcript).not.toMatch(/music|SFX|applause/i);
    expect(result.processing.packaging).toBe('native-wav');
  });

  test('repairs sparse host-labeled script output instead of blocking video podcast generation', async () => {
    createResponse.mockResolvedValueOnce({
      output_text: JSON.stringify({
        title: 'Halifax Dating Weekend',
        summary: 'A short video podcast script about dating in Halifax.',
        turns: [
          {
            speaker: 'Host A',
            text: 'Dating in Halifax this weekend starts with being realistic about the city scale. People often cross paths through familiar neighborhoods, events, and friend groups. That can make first dates feel more personal, but it also rewards clear plans and a little tact.',
          },
          {
            speaker: 'Host B',
            text: 'A good plan is simple: pick a public spot, leave room for conversation, and avoid overbuilding the date. Coffee, a waterfront walk, a market stop, or a small live event can work because the focus stays on whether the connection feels easy.',
          },
        ],
      }),
    });

    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Halifax events', url: 'https://example.com/halifax-events', snippet: 'Weekend events and date ideas in Halifax.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Halifax has waterfront walks, cafes, markets, and local events that can work for casual dates.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'dating in Halifax this weekend',
      includeVideo: true,
      hostAName: 'Nora',
      hostBName: 'Sam',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(result.script.turns).toHaveLength(4);
    expect(new Set(result.script.turns.map((turn) => turn.speaker))).toEqual(new Set(['Nora', 'Sam']));
    expect(ttsService.synthesize).toHaveBeenCalled();
  });

  test('uses the active chat model for podcast script generation when no podcast-specific model is provided', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Grid battery guide', url: 'https://example.com/batteries', snippet: 'Battery storage helps balance power systems.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Battery systems absorb excess power and discharge it later.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    await service.createPodcast({
      topic: 'How grid batteries work',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      model: 'gemini-3.1-pro-preview',
      toolManager: { executeTool },
    });

    expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.1-pro-preview',
      requestTimeoutMs: 300000,
      requestMaxRetries: 0,
    }));
  });

  test('uses the active chat model instead of a conflicting tool model', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Grid battery guide', url: 'https://example.com/batteries', snippet: 'Battery storage helps balance power systems.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Battery systems absorb excess power and discharge it later.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    await service.createPodcast({
      topic: 'How grid batteries work',
      model: 'gpt-5.4',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      model: 'gemini-3.1-pro-preview',
      toolManager: { executeTool },
    });

    expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.1-pro-preview',
      requestTimeoutMs: 300000,
      requestMaxRetries: 0,
    }));
  });

  test('uses the action model from tool context metadata when present', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Grid battery guide', url: 'https://example.com/batteries', snippet: 'Battery storage helps balance power systems.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Battery systems absorb excess power and discharge it later.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    await service.createPodcast({
      topic: 'How grid batteries work',
      model: 'gpt-4o',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolContext: { model: 'gpt-5.3-instant' },
      toolManager: { executeTool },
    });

    expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.3-instant',
      requestTimeoutMs: 300000,
      requestMaxRetries: 0,
    }));
  });

  test('uses the active chat model instead of an unsafe generated mini model', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Boss traits', url: 'https://example.com/bosses', snippet: 'Good bosses communicate clearly.' },
            ],
          },
        };
      }
      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Good bosses set expectations, listen, and coach people through tradeoffs.</p></article>',
          },
        };
      }
      throw new Error(`Unexpected tool: ${toolId}`);
    });

    await service.createPodcast({
      topic: 'What makes a good boss',
      model: 'gpt-4o-mini',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      model: 'gpt-4o',
      toolManager: { executeTool },
    });

    const usedModels = createResponse.mock.calls.map(([call]) => call.model);
    expect(usedModels).toEqual(['gpt-4o']);
  });

  test('allows longer podcast script request budgets to be overridden per run', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Penguin field guide', url: 'https://example.com/penguins', snippet: 'Penguin ecology changes across species and latitudes.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Penguin populations respond differently to changing sea ice, prey shifts, and warming waters.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    await service.createPodcast({
      topic: 'Penguin biology and climate change',
      durationMinutes: 20,
      scriptTimeoutMs: 420000,
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
      requestTimeoutMs: 420000,
      requestMaxRetries: 0,
    }));
  });

  test('falls back to provided source urls when web search is unavailable', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: false,
          error: 'Search is temporarily unavailable.',
          errorCode: 'web_search_unavailable',
          statusCode: 400,
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Battery storage shifts energy from low-demand periods to high-demand periods.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
      sourceUrls: ['https://example.com/seed-source'],
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(executeTool).toHaveBeenCalledWith('web-search', expect.any(Object), expect.any(Object));
    expect(executeTool).toHaveBeenCalledWith('web-fetch', expect.objectContaining({
      url: 'https://example.com/seed-source',
    }), expect.any(Object));
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'https://example.com/seed-source',
      }),
    ]));
  });

  test('uses selected uploaded artifacts as podcast source material', async () => {
    artifactService.buildPromptContext.mockResolvedValue([
      '[Session artifacts]',
      '- kubota-loader.pdf (pdf, selected, 12000 bytes)',
      '',
      '[Selected artifact details]',
      'File: kubota-loader.pdf',
      'Type: pdf',
      'Summary:',
      'Kubota loader maintenance intervals and hydraulic safety checks.',
    ].join('\n'));
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: false,
          error: 'Search is temporarily unavailable.',
          errorCode: 'web_search_unavailable',
          statusCode: 400,
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'Kubota loader maintenance',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      artifactIds: ['artifact-kubota-1'],
      toolManager: { executeTool },
    });

    expect(artifactService.buildPromptContext).toHaveBeenCalledWith('session-1', ['artifact-kubota-1']);
    expect(executeTool).toHaveBeenCalledWith('web-search', expect.any(Object), expect.any(Object));
    expect(executeTool).not.toHaveBeenCalledWith('web-fetch', expect.any(Object), expect.any(Object));
    expect(createResponse.mock.calls[0][0].input).toContain('Kubota loader maintenance intervals');
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'session-artifacts://artifact-kubota-1',
      }),
    ]));
  });

  test('caps source text and drops access-denied fetch bodies before script generation', async () => {
    const service = new PodcastService();
    const longSnippet = 'Good managers set clear expectations and coach people through tradeoffs. '.repeat(80);
    const deniedBody = `
      <html><body>
        <h1>Access Denied</h1>
        <p>You don't have permission to access this page on this server.</p>
        <p>Reference #18.abc errors.edgesuite.net</p>
      </body></html>
    `;
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Manager research', url: 'https://example.com/managers', snippet: longSnippet },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: deniedBody,
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    await service.createPodcast({
      topic: 'What makes a good manager',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    const [{ input: prompt }] = createResponse.mock.calls[0];
    expect(prompt).toContain('Good managers set clear expectations');
    expect(prompt).not.toContain(longSnippet);
    expect(prompt).not.toContain("You don't have permission");
    expect(prompt).not.toContain('errors.edgesuite.net');
  });

  test('exports mp3 and applies optional audio mixing when requested', async () => {
    persistGeneratedAudio
      .mockResolvedValueOnce({
        artifact: { id: 'artifact-podcast-wav', filename: 'battery-breakdown.wav' },
        artifactIds: ['artifact-podcast-wav'],
        audio: { artifactId: 'artifact-podcast-wav', downloadUrl: '/api/artifacts/artifact-podcast-wav/download' },
      })
      .mockResolvedValueOnce({
        artifact: { id: 'artifact-podcast-mp3', filename: 'battery-breakdown.mp3' },
        artifactIds: ['artifact-podcast-mp3'],
        audio: { artifactId: 'artifact-podcast-mp3', downloadUrl: '/api/artifacts/artifact-podcast-mp3/download' },
      });

    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return { success: true, data: { results: [{ title: 'A', url: 'https://example.com/a', snippet: 'A' }] } };
      }
      if (toolId === 'web-fetch') {
        return { success: true, data: { headers: { 'content-type': 'text/html' }, body: '<p>Battery systems store energy.</p>' } };
      }
      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
      exportMp3: true,
      voiceOnlyAudio: false,
      enhanceSpeech: true,
      includeIntro: true,
      includeMusicBed: true,
      musicBedPath: 'C:\\audio\\bed.wav',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(audioProcessingService.composePodcastAudio).toHaveBeenCalledWith(expect.objectContaining({
      includeIntro: true,
      includeMusicBed: true,
      enhanceSpeech: true,
      musicBedPath: 'C:\\audio\\bed.wav',
    }));
    expect(audioProcessingService.transcodeWavToMp3).toHaveBeenCalled();
    expect(updateGeneratedAudioSessionState).toHaveBeenCalledWith('session-1', [
      expect.objectContaining({ id: 'artifact-podcast-wav' }),
      expect.objectContaining({ id: 'artifact-podcast-mp3' }),
    ]);
    expect(result.audio).toEqual(expect.objectContaining({
      artifactId: 'artifact-podcast-mp3',
    }));
    expect(result.audioVariants).toHaveLength(2);
    expect(result.processing.mp3Exported).toBe(true);
    expect(result.processing.mixed).toBe(true);
    expect(result.processing.enhanced).toBe(true);
  });

  test('uses configured admin music bed automatically at podcast generation time', async () => {
    audioProcessingService.getPublicConfig.mockReturnValue({
      configured: true,
      provider: 'ffmpeg',
      supportsMp3: true,
      supportsMixing: true,
      defaults: {
        masteringEnabled: true,
        musicBedPathConfigured: true,
        mp3BitrateKbps: 192,
      },
      diagnostics: {
        status: 'ready',
      },
    });
    persistGeneratedAudio.mockResolvedValueOnce({
      artifact: { id: 'artifact-podcast-wav', filename: 'battery-breakdown.wav' },
      artifactIds: ['artifact-podcast-wav'],
      audio: { artifactId: 'artifact-podcast-wav', downloadUrl: '/api/artifacts/artifact-podcast-wav/download' },
    });

    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return { success: true, data: { results: [{ title: 'A', url: 'https://example.com/a', snippet: 'A' }] } };
      }
      if (toolId === 'web-fetch') {
        return { success: true, data: { headers: { 'content-type': 'text/html' }, body: '<p>Battery systems store energy.</p>' } };
      }
      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
      voiceOnlyAudio: false,
      includeMusicBed: true,
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(audioProcessingService.composePodcastAudio).toHaveBeenCalledWith(expect.objectContaining({
      includeMusicBed: true,
      musicBedPath: '',
      musicVolume: undefined,
    }));
    expect(result.processing.musicBedApplied).toBe(true);
  });

  test('retries transient ffmpeg post-processing failures once for podcast mastering and mp3 export', async () => {
    const audioTimeout = new Error('ffmpeg timed out while processing audio.');
    audioTimeout.statusCode = 504;
    audioTimeout.code = 'audio_processing_timeout';

    persistGeneratedAudio
      .mockResolvedValueOnce({
        artifact: { id: 'artifact-podcast-wav', filename: 'battery-breakdown.wav' },
        artifactIds: ['artifact-podcast-wav'],
        audio: { artifactId: 'artifact-podcast-wav', downloadUrl: '/api/artifacts/artifact-podcast-wav/download' },
      })
      .mockResolvedValueOnce({
        artifact: { id: 'artifact-podcast-mp3', filename: 'battery-breakdown.mp3' },
        artifactIds: ['artifact-podcast-mp3'],
        audio: { artifactId: 'artifact-podcast-mp3', downloadUrl: '/api/artifacts/artifact-podcast-mp3/download' },
      });
    audioProcessingService.composePodcastAudio
      .mockRejectedValueOnce(audioTimeout)
      .mockResolvedValueOnce(createTestWav([9, 10, 11, 12]));
    audioProcessingService.transcodeWavToMp3
      .mockRejectedValueOnce(audioTimeout)
      .mockResolvedValueOnce(Buffer.from('mp3-bytes-retry'));

    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return { success: true, data: { results: [{ title: 'A', url: 'https://example.com/a', snippet: 'A' }] } };
      }
      if (toolId === 'web-fetch') {
        return { success: true, data: { headers: { 'content-type': 'text/html' }, body: '<p>Battery systems store energy.</p>' } };
      }
      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
      exportMp3: true,
      voiceOnlyAudio: false,
      enhanceSpeech: true,
      includeIntro: true,
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(audioProcessingService.composePodcastAudio).toHaveBeenCalledTimes(2);
    expect(audioProcessingService.transcodeWavToMp3).toHaveBeenCalledTimes(2);
    expect(result.audio).toEqual(expect.objectContaining({
      artifactId: 'artifact-podcast-mp3',
    }));
  });

  test('synthesizes turn audio with bounded parallelism and keeps the final episode order stable', async () => {
    const service = new PodcastService();
    const firstText = 'This is the first Maya line.';
    const secondText = 'This is the second Maya line.';
    const thirdText = 'This is the third Maya line.';
    const audioByText = new Map([
      [firstText, createTestWav([1, 2, 3, 4])],
      [secondText, createTestWav([5, 6, 7, 8])],
      [thirdText, createTestWav([9, 10, 11, 12])],
    ]);
    let active = 0;
    let maxActive = 0;

    ttsService.synthesize.mockImplementation(async ({ text }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);

      const delayMs = text === firstText
        ? 50
        : text === secondText
          ? 10
          : 25;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;

      return {
        audioBuffer: audioByText.get(text),
        voice: { provider: 'piper' },
        contentType: 'audio/wav',
        text,
      };
    });

    const result = await service.synthesizeTurns(
      [
        { speaker: 'Maya', text: firstText },
        { speaker: 'Maya', text: secondText },
        { speaker: 'Maya', text: thirdText },
      ],
      [{
        name: 'Maya',
        voiceId: 'hfc-female-rich',
      }],
      {
        silenceMs: 100,
        chunkMaxChars: 1600,
        ttsConcurrency: 2,
      },
    );

    const parsedEpisode = parseWavBuffer(result);
    const firstSegmentIndex = parsedEpisode.data.indexOf(parseWavBuffer(audioByText.get(firstText)).data);
    const secondSegmentIndex = parsedEpisode.data.indexOf(parseWavBuffer(audioByText.get(secondText)).data);
    const thirdSegmentIndex = parsedEpisode.data.indexOf(parseWavBuffer(audioByText.get(thirdText)).data);

    expect(maxActive).toBe(2);
    expect(firstSegmentIndex).toBeGreaterThanOrEqual(0);
    expect(secondSegmentIndex).toBeGreaterThan(firstSegmentIndex);
    expect(thirdSegmentIndex).toBeGreaterThan(secondSegmentIndex);
  });

  test('keeps a final silence tail so the last spoken words are not clipped', async () => {
    const service = new PodcastService();
    const result = await service.synthesizeTurns(
      [{ speaker: 'Maya', text: 'The final words need room to finish.' }],
      [{
        name: 'Maya',
        voiceId: 'af_heart',
      }],
      {
        silenceMs: 250,
        chunkMaxChars: 1600,
      },
    );

    const parsed = parseWavBuffer(result);
    let trailingZeroBytes = 0;
    for (let index = parsed.data.length - 1; index >= 0; index -= 1) {
      if (parsed.data[index] !== 0) {
        break;
      }
      trailingZeroBytes += 1;
    }

    const expectedTailBytes = Math.round(parsed.sampleRate * 0.65) * parsed.numChannels * (parsed.bitsPerSample / 8);
    expect(trailingZeroBytes).toBeGreaterThanOrEqual(expectedTailBytes);
  });

  test('records actual TTS provider and voice diagnostics for synthesized podcast segments', async () => {
    ttsService.synthesize.mockResolvedValueOnce({
      provider: 'kokoro',
      audioBuffer: createTestWav([1, 2, 3, 4]),
      voice: { id: 'af_bella', provider: 'kokoro' },
      contentType: 'audio/wav',
      text: 'segment',
    });

    const service = new PodcastService();
    const result = await service.synthesizeTurns(
      [{ speaker: 'June', text: 'This is June speaking with the second host voice.' }],
      [{ name: 'June', voiceId: 'af_bella' }],
      {
        silenceMs: 250,
        chunkMaxChars: 1600,
        returnDiagnostics: true,
      },
    );

    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
    expect(ttsService.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      voiceId: 'af_bella',
      allowProviderFallback: false,
    }));
    expect(result.synthesisDiagnostics).toEqual([
      expect.objectContaining({
        speaker: 'June',
        requestedProvider: 'kokoro',
        requestedVoiceId: 'af_bella',
        actualProvider: 'kokoro',
        actualVoiceId: 'af_bella',
        providerFallback: false,
        providerFallbackAllowed: false,
      }),
    ]);
  });

  test('passes podcast-specific Piper timeout settings into synthesis and retries timed out chunks with smaller splits', async () => {
    const timeoutError = new Error('Piper TTS timed out before audio generation completed.');
    timeoutError.statusCode = 504;
    timeoutError.code = 'tts_timeout';

    ttsService.synthesize
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValue({
        audioBuffer: createTestWav([1, 2, 3, 4]),
        voice: { provider: 'piper' },
        contentType: 'audio/wav',
        text: 'segment',
      });

    const service = new PodcastService();
    const longTurn = 'Battery storage helps the grid absorb extra power. '.repeat(30).trim();
    const result = await service.synthesizeTurns(
      [{ speaker: 'Maya', text: longTurn }],
      [{ name: 'Maya', voiceId: 'hfc-female-rich' }],
      {
        silenceMs: 250,
        chunkMaxChars: 1600,
        ttsTimeoutMs: 180000,
        allowVoiceFallback: true,
      },
    );

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(ttsService.synthesize).toHaveBeenCalledTimes(3);
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      text: longTurn,
      voiceId: 'hfc-female-rich',
      timeoutMs: 180000,
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      voiceId: 'hfc-female-rich',
      timeoutMs: 180000,
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(3, expect.objectContaining({
      voiceId: 'hfc-female-rich',
      timeoutMs: 180000,
    }));
    expect(ttsService.synthesize.mock.calls[1][0].text.length).toBeLessThan(longTurn.length);
    expect(ttsService.synthesize.mock.calls[2][0].text.length).toBeLessThan(longTurn.length);
  });

  test('retries unexpected Piper failures by splitting podcast chunks into smaller renders', async () => {
    const failedError = new Error('Piper TTS failed to generate audio.');
    failedError.statusCode = 502;
    failedError.code = 'tts_failed';

    ttsService.synthesize
      .mockRejectedValueOnce(failedError)
      .mockResolvedValue({
        audioBuffer: createTestWav([1, 2, 3, 4]),
        voice: { provider: 'piper' },
        contentType: 'audio/wav',
        text: 'segment',
      });

    const service = new PodcastService();
    const longTurn = 'Battery storage helps the grid absorb extra power and deliver it later. '.repeat(30).trim();
    const result = await service.synthesizeTurns(
      [{ speaker: 'Maya', text: longTurn }],
      [{ name: 'Maya', voiceId: 'hfc-female-rich' }],
      {
        silenceMs: 250,
        chunkMaxChars: 1600,
        ttsTimeoutMs: 180000,
        allowVoiceFallback: true,
      },
    );

    expect(Buffer.isBuffer(result)).toBe(true);
    const [initialAttempt] = ttsService.synthesize.mock.calls[0];
    expect(ttsService.synthesize.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      voiceId: 'hfc-female-rich',
      timeoutMs: 180000,
    }));
    expect(initialAttempt.text.length).toBeLessThanOrEqual(1600);
    ttsService.synthesize.mock.calls.slice(1).forEach(([call]) => {
      expect(call.text.length).toBeLessThan(initialAttempt.text.length);
    });
  });

  test('falls back to the next configured host voice before splitting podcast chunks on timeout', async () => {
    const timeoutError = new Error('Piper TTS timed out before audio generation completed.');
    timeoutError.statusCode = 504;
    timeoutError.code = 'tts_timeout';

    ttsService.synthesize
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({
        audioBuffer: createTestWav([1, 2, 3, 4]),
        voice: { provider: 'piper' },
        contentType: 'audio/wav',
        text: 'segment',
      });

    const service = new PodcastService();
    const result = await service.synthesizeTurns(
      [{ speaker: 'Maya', text: 'Battery storage helps the grid absorb extra power without wasting generation.' }],
      [{
        name: 'Maya',
        voiceId: 'hfc-female-rich',
        voiceIds: ['hfc-female-rich', 'amy-expressive'],
      }],
      {
        silenceMs: 250,
        chunkMaxChars: 1600,
        ttsTimeoutMs: 180000,
        allowVoiceFallback: true,
      },
    );

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(ttsService.synthesize).toHaveBeenCalledTimes(2);
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      voiceId: 'hfc-female-rich',
      timeoutMs: 180000,
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      voiceId: 'amy-expressive',
      timeoutMs: 180000,
    }));
  });

  test('falls back to the next configured host voice after non-timeout Piper failures', async () => {
    const failedError = new Error('Piper TTS failed to generate audio.');
    failedError.statusCode = 502;
    failedError.code = 'tts_failed';

    ttsService.synthesize
      .mockRejectedValueOnce(failedError)
      .mockResolvedValueOnce({
        audioBuffer: createTestWav([1, 2, 3, 4]),
        voice: { provider: 'piper' },
        contentType: 'audio/wav',
        text: 'segment',
      });

    const service = new PodcastService();
    const result = await service.synthesizeTurns(
      [{ speaker: 'Maya', text: 'Battery storage helps the grid absorb extra power without wasting generation.' }],
      [{
        name: 'Maya',
        voiceId: 'hfc-female-rich',
        voiceIds: ['hfc-female-rich', 'amy-expressive'],
      }],
      {
        silenceMs: 250,
        chunkMaxChars: 1600,
        ttsTimeoutMs: 180000,
        allowVoiceFallback: true,
      },
    );

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(ttsService.synthesize).toHaveBeenCalledTimes(2);
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      voiceId: 'hfc-female-rich',
      timeoutMs: 180000,
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      voiceId: 'amy-expressive',
      timeoutMs: 180000,
    }));
  });

  test('cycles host voices across repeated turns from the same speaker', async () => {
    const service = new PodcastService();
    const result = await service.synthesizeTurns(
      [
        { speaker: 'Maya', text: 'This is the first Maya line.' },
        { speaker: 'Maya', text: 'This is the second Maya line.' },
        { speaker: 'Maya', text: 'This is the third Maya line.' },
      ],
      [{
        name: 'Maya',
        voiceId: 'hfc-female-rich',
        voiceIds: ['hfc-female-rich', 'amy-expressive'],
      }],
      {
        silenceMs: 250,
        chunkMaxChars: 1600,
        cycleHostVoices: true,
      },
    );

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(ttsService.synthesize).toHaveBeenCalledTimes(3);
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      voiceId: 'hfc-female-rich',
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      voiceId: 'amy-expressive',
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(3, expect.objectContaining({
      voiceId: 'hfc-female-rich',
    }));
  });

  test('normalizes mixed voice wav formats before concatenating the episode audio', async () => {
    ttsService.synthesize
      .mockResolvedValueOnce({
        audioBuffer: createTestWav([1, 2, 3, 4]),
        voice: { provider: 'piper' },
        contentType: 'audio/wav',
        text: 'segment-a',
      })
      .mockResolvedValueOnce({
        audioBuffer: writeWavBuffer({
          sampleRate: 16000,
          bitsPerSample: 16,
          numChannels: 1,
          data: Buffer.from([5, 6, 7, 8]),
        }),
        voice: { provider: 'piper' },
        contentType: 'audio/wav',
        text: 'segment-b',
      });

    const service = new PodcastService();
    const result = await service.synthesizeTurns(
      [
        { speaker: 'Maya', text: 'This is Maya.' },
        { speaker: 'June', text: 'This is June.' },
      ],
      [
        { name: 'Maya', voiceId: 'hfc-female-rich' },
        { name: 'June', voiceId: 'kathleen-low' },
      ],
      {
        silenceMs: 250,
        chunkMaxChars: 1600,
      },
    );

    const parsed = parseWavBuffer(result);
    expect(parsed.sampleRate).toBe(22050);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.numChannels).toBe(1);
  });

  test('applies per-host voice cycling for both hosts through createPodcast turn planning', async () => {
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Dual host podcast', url: 'https://example.com/podcast', snippet: 'Podcast style examples.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<p>Reliable examples make a better show.</p>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    createResponse.mockResolvedValueOnce({
      output_text: JSON.stringify({
        title: 'Pet Behavior and Boundaries',
        summary: 'A practical dialogue on coexistence.',
        turns: [
          { speaker: 'Maya', text: 'Let us start with the high-level principle first.' },
          { speaker: 'June', text: 'That principle is useful when stress is the trigger.' },
          { speaker: 'Maya', text: 'Second, pace and routines usually help most.' },
          { speaker: 'June', text: 'And structure makes escalation less likely.' },
        ],
      }),
    });

    const service = new PodcastService();
    await service.createPodcast({
      topic: 'How to reduce stress in multi-pet homes',
      cycleHostVoices: true,
      hostAVoiceIds: ['hfc-female-rich', 'amy-expressive', 'amy-medium'],
      hostBVoiceIds: ['kathleen-low', 'hfc-female-medium', 'hfc-female-rich'],
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(ttsService.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      voiceId: 'hfc-female-rich',
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      voiceId: 'kathleen-low',
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(3, expect.objectContaining({
      voiceId: 'amy-expressive',
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(4, expect.objectContaining({
      voiceId: 'hfc-female-medium',
    }));
  });

  test('uses the curated high-quality host pools when cycling is enabled without explicit voice ids', async () => {
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Podcast pacing', url: 'https://example.com/pacing', snippet: 'Conversational pacing matters.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<p>Alternating tones can keep a long conversation feeling fresh.</p>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    createResponse.mockResolvedValueOnce({
      output_text: JSON.stringify({
        title: 'Podcast Pacing',
        summary: 'A short conversation on cadence.',
        turns: [
          { speaker: 'Maya', text: 'A strong opener should feel steady and easy to follow.' },
          { speaker: 'June', text: 'Then you can sharpen the pace without making it feel clipped.' },
          { speaker: 'Maya', text: 'That second beat is where a warmer follow-up voice helps.' },
          { speaker: 'June', text: 'And the next reply can feel slightly tighter without sounding robotic.' },
        ],
      }),
    });

    const service = new PodcastService();
    await service.createPodcast({
      topic: 'How to pace a conversational podcast',
      cycleHostVoices: true,
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    const usedVoiceIds = ttsService.synthesize.mock.calls.map(([call]) => call.voiceId);
    expect(usedVoiceIds).toHaveLength(4);
    expect(new Set(usedVoiceIds).size).toBeGreaterThanOrEqual(2);
    usedVoiceIds.forEach((voiceId) => {
      expect([
        'af_nicole',
        'af_bella',
        'af_heart',
        'bf_emma',
      ]).toContain(voiceId);
    });
  });

  test('filters male voices out of default and explicit podcast host pools', async () => {
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Voice defaults', url: 'https://example.com/voices', snippet: 'Podcast voices should stay consistent.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<p>Clear voices help listeners follow the episode.</p>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    createResponse.mockResolvedValueOnce({
      output_text: JSON.stringify({
        title: 'Female Voice Defaults',
        summary: 'A short conversation on podcast voice selection.',
        turns: [
          { speaker: 'Maya', text: 'The default host voice should stay warm and natural.' },
          { speaker: 'June', text: 'And the co-host should stay clear without using the old male voice pool.' },
          { speaker: 'Maya', text: 'That keeps the selection focused and predictable.' },
          { speaker: 'June', text: 'Exactly, all configured fallbacks should stay in the female set.' },
        ],
      }),
    });

    const service = new PodcastService();
    const result = await service.createPodcast({
      topic: 'podcast voice selection',
      hostBVoiceIds: ['am_adam', 'ryan-high', 'bf_emma'],
      cycleHostVoices: true,
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    const usedVoiceIds = ttsService.synthesize.mock.calls.map(([call]) => call.voiceId);
    expect(result.hosts.map((host) => host.name)).not.toContain('Ryan');
    expect(usedVoiceIds).not.toEqual(expect.arrayContaining(['am_adam', 'am_michael', 'bm_george', 'ryan-high', 'ryan-direct']));
    usedVoiceIds.forEach((voiceId) => {
      expect([
        'af_bella',
        'af_heart',
        'af_nicole',
        'bf_emma',
        'ljspeech-high',
        'lessac-high',
        'cori-high',
        'hfc-female-rich',
        'amy-broadcast',
        'amy-expressive',
        'hfc-female-medium',
        'kathleen-low',
        'amy-medium',
      ]).toContain(voiceId);
    });
  });

  test('keeps one voice per host when cycleHostVoices is disabled', async () => {
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Pet behavior guide', url: 'https://example.com/pets', snippet: 'Behavior conflicts can be managed.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<p>Resource control and routines reduce dog-cat escalation.</p>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const service = new PodcastService();
    await service.createPodcast({
      topic: 'cats and dogs fighting in the house',
      cycleHostVoices: false,
      hostAVoiceIds: ['hfc-female-rich', 'amy-expressive'],
      hostBVoiceIds: ['kathleen-low', 'hfc-female-medium'],
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(ttsService.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      voiceId: 'hfc-female-rich',
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      voiceId: 'kathleen-low',
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(3, expect.objectContaining({
      voiceId: 'hfc-female-rich',
    }));
    expect(ttsService.synthesize).toHaveBeenNthCalledWith(4, expect.objectContaining({
      voiceId: 'kathleen-low',
    }));
  });

  test('retries transient script-generation connection failures before succeeding', async () => {
    const transientError = new Error('Connection terminated unexpectedly.');
    createResponse
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          title: 'Pets at Home',
          summary: 'A calmer take on pets clashing indoors.',
          turns: [
            { speaker: 'Maya', text: 'Today we are talking about what is really happening when cats and dogs clash in the house.' },
            { speaker: 'June', text: 'A lot of the time it is not pure aggression. It is stress, guarding, confusion, or over-arousal.' },
            { speaker: 'Maya', text: 'That matters because the fix depends on the trigger, not just the noise level of the conflict.' },
            { speaker: 'June', text: 'Owners often miss the early warning signs, like staring, blocking, stalking, or crowding around food and rest spots.' },
            { speaker: 'Maya', text: 'Management usually starts with creating distance and predictable routines so neither animal feels trapped.' },
            { speaker: 'June', text: 'Then you work on controlled exposure, reward calm behavior, and reduce the situations that keep setting them off.' },
            { speaker: 'Maya', text: 'The main takeaway is that coexistence gets better when the environment gets clearer and safer.' },
            { speaker: 'June', text: 'And if the fights are intense or escalating, that is the point to bring in a qualified behavior professional.' },
          ],
        }),
      });

    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Pet behavior guide', url: 'https://example.com/pets', snippet: 'Behavior conflicts often come from stress and guarding.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Stress, resource guarding, and poor introductions can trigger conflict between household pets.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'cats and dogs fighting in the house',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(result.script.turns).toHaveLength(8);
  });

  test('falls back to the configured fallback model after repeated transient script-generation failures', async () => {
    settingsController.settings.models = {
      ...(settingsController.settings?.models || {}),
      fallbackModel: 'gpt-5.4-mini',
    };
    const transientError = new Error('Connection terminated unexpectedly.');
    createResponse
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          title: 'Battery Backstop',
          summary: 'Fallback-model generation succeeded.',
          turns: [
            { speaker: 'Maya', text: 'Battery systems help shift energy in time.' },
            { speaker: 'June', text: 'That makes them useful when demand spikes or solar production drops.' },
            { speaker: 'Maya', text: 'They also give operators a faster way to stabilize parts of the grid.' },
            { speaker: 'June', text: 'And the economics depend on duration, cycle life, and local market rules.' },
          ],
        }),
      });

    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              { title: 'Grid battery guide', url: 'https://example.com/batteries', snippet: 'Battery storage helps balance power systems.' },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: '<article><p>Battery systems absorb excess power and discharge it later.</p></article>',
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      model: 'gemini-3.1-pro-preview',
      toolManager: { executeTool },
    });

    expect(createResponse).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: 'gemini-3.1-pro-preview',
    }));
    expect(createResponse).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: 'gemini-3.1-pro-preview',
    }));
    expect(createResponse).toHaveBeenNthCalledWith(3, expect.objectContaining({
      model: 'gpt-4o',
    }));
    expect(createResponse).toHaveBeenNthCalledWith(4, expect.objectContaining({
      model: 'gpt-4o',
    }));
    expect(createResponse).toHaveBeenNthCalledWith(5, expect.objectContaining({
      model: 'gpt-5.4-mini',
    }));
    expect(result.script.summary).toBe('Fallback-model generation succeeded.');
  });

  test('sanitizes malformed unicode from topics and fetched source text before script generation', async () => {
    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return {
          success: true,
          data: {
            results: [
              {
                title: `Pet conflicts \uD800 at home`,
                url: 'https://example.com/pets',
                snippet: `Stress signals can spike \uD800 before a fight.`,
              },
            ],
          },
        };
      }

      if (toolId === 'web-fetch') {
        return {
          success: true,
          data: {
            headers: { 'content-type': 'text/html' },
            body: `<article><p>Watch for crowding\uD800, blocking, and guarding around food.</p></article>`,
          },
        };
      }

      throw new Error(`Unexpected tool: ${toolId}`);
    });

    await service.createPodcast({
      topic: `cats and dogs fighting \uD800 in the house`,
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    const requestInput = createResponse.mock.calls[0][0].input;
    expect(requestInput).toContain('cats and dogs fighting in the house');
    expect(requestInput).not.toContain('\uD800');
  });
  test('tolerates malformed voice entries when resolving host voice pools', async () => {
    ttsService.getPublicConfig.mockReturnValueOnce({
      configured: true,
      provider: 'kokoro',
      maxTextChars: 2400,
      timeoutMs: 45000,
      podcastTimeoutMs: 210000,
      podcastChunkChars: 760,
      defaultVoiceId: 'af_heart',
      voices: [null, undefined, { id: 'af_heart', provider: 'kokoro' }, { id: 'bf_emma', provider: 'kokoro' }],
    });

    const service = new PodcastService();
    const executeTool = jest.fn(async (toolId) => {
      if (toolId === 'web-search') {
        return { success: true, data: { results: [{ title: 'A', url: 'https://example.com/a', snippet: 'A' }] } };
      }
      if (toolId === 'web-fetch') {
        return { success: true, data: { headers: { 'content-type': 'text/html' }, body: '<p>Battery systems store energy.</p>' } };
      }
      throw new Error(`Unexpected tool: ${toolId}`);
    });

    const result = await service.createPodcast({
      topic: 'How grid batteries work',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      toolManager: { executeTool },
    });

    expect(result.hosts).toHaveLength(2);
    expect(ttsService.synthesize).toHaveBeenCalled();
  });

});

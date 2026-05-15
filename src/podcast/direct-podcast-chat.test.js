const {
  buildDirectPodcastParams,
} = require('./direct-podcast-chat');

describe('direct podcast chat intent', () => {
  test('preserves the full creative brief and infers a solo host request', () => {
    const request = [
      'Please make a one-speaker podcast.',
      'Title: NASA After Dark: Real Space Facts for a Sci-Fi Night.',
      'Use real NASA facts as launch points: Voyager, the ISS, Mars rovers, Deep Space Network, Parker Solar Probe, JWST, and Apollo moon dust.',
      'Keep it cinematic but grounded.',
    ].join(' ');

    const params = buildDirectPodcastParams({ text: request });

    expect(params).toEqual(expect.objectContaining({
      hostCount: 1,
      requestBrief: request,
    }));
    expect(params.topic).toContain('Title: NASA After Dark');
    expect(params.requestBrief).toContain('one-speaker podcast');
    expect(params.requestBrief).toContain('Voyager');
    expect(params.requestBrief).toContain('cinematic but grounded');
  });

  test.each([
    ['make a proper full podcast on battery recycling', 'proper full'],
    ['create a longer detailed podcast about local food systems', 'longer detailed'],
    ['generate a non-short podcast covering AI safety tradeoffs', 'non-short'],
    ['make an in-depth comprehensive podcast on Mars rovers', 'in-depth comprehensive'],
  ])('infers longer richer parameters from qualitative script request: %s', (request, expectedBriefText) => {
    const params = buildDirectPodcastParams({ text: request });

    expect(params).toEqual(expect.objectContaining({
      durationMinutes: 12,
      detailLevel: 'rich',
      requestBrief: request,
    }));
    expect(params.requestBrief).toContain(expectedBriefText);
  });

  test('preserves explicit duration over qualitative longer wording', () => {
    const params = buildDirectPodcastParams({
      text: 'make a proper full 7 minute podcast on adaptive reuse architecture',
    });

    expect(params).toEqual(expect.objectContaining({
      durationMinutes: 7,
      detailLevel: 'rich',
    }));
  });

  test('infers the training podcast style as a calm solo technical lesson', () => {
    const params = buildDirectPodcastParams({
      text: 'Create a training podcast from my technical data about Kubernetes ingress debugging.',
      artifactIds: ['artifact-ingress-notes'],
    });

    expect(params).toEqual(expect.objectContaining({
      topic: 'Kubernetes ingress debugging',
      scriptDesign: 'training-podcast',
      hostCount: 1,
      durationMinutes: 30,
      detailLevel: 'rich',
      audience: 'technical learner',
      tone: 'calm, calculated, structured, human, instructional',
      artifactIds: ['artifact-ingress-notes'],
      sourceMode: 'uploaded-files-only',
      useOnlineResearch: false,
    }));
  });

  test('keeps selected uploaded files source-only and treats teaching podcasts as solo lessons', () => {
    const params = buildDirectPodcastParams({
      text: 'Create a teaching podcast from the uploaded Genetec and CCure files.',
      artifactIds: ['artifact-genetec', 'artifact-ccure'],
    });

    expect(params).toEqual(expect.objectContaining({
      topic: 'Create a teaching podcast from the uploaded Genetec and CCure files',
      artifactIds: ['artifact-genetec', 'artifact-ccure'],
      scriptDesign: 'training-podcast',
      hostCount: 1,
      durationMinutes: 30,
      detailLevel: 'rich',
      sourceMode: 'uploaded-files-only',
      useOnlineResearch: false,
    }));
  });

  test('allows lesson-style podcast durations up to forty minutes', () => {
    const params = buildDirectPodcastParams({
      text: 'Create a 40 minute teaching podcast from the uploaded Genetec and CCure files.',
      artifactIds: ['artifact-genetec', 'artifact-ccure'],
    });

    expect(params).toEqual(expect.objectContaining({
      scriptDesign: 'training-podcast',
      hostCount: 1,
      durationMinutes: 40,
      detailLevel: 'rich',
    }));
  });

  test('keeps named artifacts source-only for training podcasts', () => {
    const params = buildDirectPodcastParams({
      text: 'Create a training podcast from the Genetec and CCure artifacts I named.',
      artifactIds: ['artifact-genetec', 'artifact-ccure'],
    });

    expect(params).toEqual(expect.objectContaining({
      artifactIds: ['artifact-genetec', 'artifact-ccure'],
      scriptDesign: 'training-podcast',
      sourceMode: 'uploaded-files-only',
      useOnlineResearch: false,
    }));
  });

  test('does not shrink longer technical class podcasts to the generic longer episode default', () => {
    const params = buildDirectPodcastParams({
      text: 'Create a longer teaching podcast as a technical class on access control integrations.',
      artifactIds: ['artifact-access-control'],
    });

    expect(params).toEqual(expect.objectContaining({
      scriptDesign: 'training-podcast',
      hostCount: 1,
      durationMinutes: 30,
      detailLevel: 'rich',
      audience: 'technical learner',
    }));
  });

  test('allows explicit online enrichment for selected uploaded files', () => {
    const params = buildDirectPodcastParams({
      text: 'Create a teaching podcast from the uploaded Genetec and CCure files and enrich it with current online sources.',
      artifactIds: ['artifact-genetec', 'artifact-ccure'],
    });

    expect(params).toEqual(expect.objectContaining({
      artifactIds: ['artifact-genetec', 'artifact-ccure'],
    }));
    expect(params.sourceMode).toBeUndefined();
    expect(params.useOnlineResearch).toBeUndefined();
  });

  test('turns requested admin audio sources on for video podcast generation', () => {
    const params = buildDirectPodcastParams({
      text: 'make a vertical video podcast about grid batteries with generated images and use the admin audio sources',
    });

    expect(params).toEqual(expect.objectContaining({
      topic: 'grid batteries',
      includeVideo: true,
      videoAspectRatio: '9:16',
      voiceOnlyAudio: false,
      includeIntro: true,
      includeOutro: true,
      includeMusicBed: true,
    }));
  });

  test('treats requested soundtrack as a music bed without polluting the topic', () => {
    const params = buildDirectPodcastParams({
      text: 'make a video podcast about grid batteries with a subtle background soundtrack',
    });

    expect(params).toEqual(expect.objectContaining({
      topic: 'grid batteries',
      includeVideo: true,
      voiceOnlyAudio: false,
      includeMusicBed: true,
    }));
  });

  test('lets structured production controls override text inference', () => {
    const params = buildDirectPodcastParams({
      text: 'make a podcast about grid batteries',
      podcastOptions: {
        includeVideo: true,
        includeMusicBed: true,
        includeIntro: true,
        cycleHostVoices: false,
        allowVoiceFallback: false,
        videoAspectRatio: '9:16',
        videoRenderMode: 'storyboard',
        videoImageMode: 'unsplash',
        directContentRequest: 'Focus on practical homeowner decisions.',
        systemPrompt: 'Keep the hosts concrete and avoid generic framing.',
      },
    });

    expect(params).toEqual(expect.objectContaining({
      topic: 'grid batteries',
      includeVideo: true,
      voiceOnlyAudio: false,
      includeMusicBed: true,
      includeIntro: true,
      cycleHostVoices: false,
      allowVoiceFallback: false,
      videoAspectRatio: '9:16',
      videoRenderMode: 'storyboard',
      videoImageMode: 'unsplash',
      systemPrompt: 'Keep the hosts concrete and avoid generic framing.',
    }));
    expect(params.requestBrief).toContain('Direct content request:');
    expect(params.requestBrief).toContain('practical homeowner decisions');
  });

  test('uses structured menu metadata to treat plain prompt text as a podcast topic', () => {
    const params = buildDirectPodcastParams({
      text: 'best time to fish this week in nova scotia',
      podcastOptions: {
        enabled: true,
        productionType: 'podcast',
        voiceOnlyAudio: false,
        includeIntro: true,
        includeMusicBed: true,
      },
    });

    expect(params).toEqual(expect.objectContaining({
      topic: 'best time to fish this week in nova scotia',
      voiceOnlyAudio: false,
      includeIntro: true,
      includeMusicBed: true,
    }));
  });

  test('keeps explicitly clean video podcast audio speaker-only', () => {
    const params = buildDirectPodcastParams({
      text: 'make a video podcast about grid batteries with clean audio and no music',
    });

    expect(params).toEqual(expect.objectContaining({
      includeVideo: true,
      voiceOnlyAudio: true,
      includeIntro: false,
      includeOutro: false,
      includeMusicBed: false,
    }));
  });

  test('defaults video podcast backdrops to generated images', () => {
    const params = buildDirectPodcastParams({
      text: 'make a video podcast about grid batteries',
    });

    expect(params).toEqual(expect.objectContaining({
      includeVideo: true,
      videoRenderMode: 'storyboard',
      videoImageMode: 'generated',
      videoGenerateImages: true,
    }));
  });
});

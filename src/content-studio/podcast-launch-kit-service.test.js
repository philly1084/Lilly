const { PodcastLaunchKitService } = require('./podcast-launch-kit-service');

function createMemoryStore() {
  const brands = new Map();
  const campaigns = new Map();
  let counter = 0;
  return {
    getBrandKit: jest.fn(async (_owner, id) => brands.get(id)),
    saveBrandKit: async (_owner, brand) => { brands.set(brand.id, brand); return brand; },
    getCampaign: jest.fn(async (_owner, id) => campaigns.get(id)),
    saveCampaign: jest.fn(async (_owner, campaign) => {
      const record = JSON.parse(JSON.stringify({ ...campaign, id: campaign.id || `campaign-${++counter}` }));
      campaigns.set(record.id, record);
      return record;
    }),
    brands,
    campaigns,
  };
}

describe('PodcastLaunchKitService', () => {
  let memoryStore;
  let podcast;
  let video;
  let service;
  let context;

  beforeEach(() => {
    memoryStore = createMemoryStore();
    memoryStore.brands.set('brand-1', {
      id: 'brand-1',
      name: 'Signal Studio',
      palette: ['#091426', '#37c6ff'],
      tone: 'direct and optimistic',
      visualStyle: 'editorial photography',
      hostVoices: ['af_heart', 'af_sky'],
    });
    podcast = {
      researchTopic: jest.fn(async () => [{ title: 'Primary source', url: 'https://example.test/source', content: 'Verified facts.' }]),
      generateScript: jest.fn(async ({ hosts }) => ({
        title: 'Grid Batteries, Clearly',
        summary: 'A concise explanation of grid batteries.',
        turns: Array.from({ length: 8 }, (_, index) => ({
          speaker: hosts[index % hosts.length].name,
          text: `Turn ${index + 1} explains a useful battery insight with enough words for timing.`,
        })),
      })),
      createPodcast: jest.fn(async (params) => ({
        title: params.approvedScript.title,
        script: params.approvedScript,
        audio: { artifactId: 'audio-1' },
        artifact: { id: 'audio-1', filename: 'episode.mp3', downloadUrl: '/api/artifacts/audio-1/download' },
        artifacts: [{ id: 'audio-1', filename: 'episode.mp3', downloadUrl: '/api/artifacts/audio-1/download' }],
      })),
    };
    video = {
      planStoryboard: jest.fn(async () => ({ scenes: [{ id: 'scene-1', caption: 'Opening' }] })),
      suggestStockSources: jest.fn(async () => [{
        sceneId: 'scene-1',
        source: 'unsplash',
        imageUrl: 'https://images.example.test/grid.jpg',
        attribution: { name: 'Example Photographer', sourceUrl: 'https://unsplash.example/photo' },
      }]),
      createVideoFromPodcast: jest.fn(async () => ({ artifact: { id: 'video-1', filename: 'episode.mp4', downloadUrl: '/video-1' }, storyboard: { scenes: [] } })),
      createPromoClipFromPodcast: jest.fn(async (_podcast, { clip }) => ({ artifact: { id: `video-${clip.id}`, filename: `${clip.id}.mp4`, downloadUrl: `/${clip.id}` }, storyboard: { scenes: [] } })),
    };
    service = new PodcastLaunchKitService({
      store: memoryStore,
      podcastService: podcast,
      videoService: video,
      persistArtifact: jest.fn(async () => ({ id: 'bundle-1', filename: 'launch-kit.zip', downloadUrl: '/bundle-1' })),
    });
    context = {
      ownerId: 'phill',
      sessionId: 'session-1',
      model: 'gpt-test',
      toolManager: {
        executeTool: jest.fn(async () => ({
          success: true,
          data: { image: { artifactId: 'cover-1', filename: 'cover.png', downloadUrl: '/cover-1' } },
        })),
      },
      toolContext: { sessionId: 'session-1' },
    };
  });

  test('creates an editable two-host plan with sources and three promo moments', async () => {
    const campaign = await service.createPlan({
      brief: { topic: 'Grid batteries', audience: 'operators', durationMinutes: 5, callToAction: 'Read the field guide' },
      episodeFormat: 'two-host',
      brandKitId: 'brand-1',
      includeFullVideo: true,
    }, context);

    expect(campaign.status).toBe('planned');
    expect(campaign.plan.hosts).toHaveLength(2);
    expect(campaign.plan.promoClips).toHaveLength(3);
    expect(campaign.plan.showNotes).toContain('https://example.test/source');
    expect(campaign.plan.storyboard.stockSources).toHaveLength(1);
    expect(campaign.plan.storyboard.scenes[0]).toEqual(expect.objectContaining({ imageSource: 'unsplash' }));
    expect(campaign.render.stages.fullVideo.status).toBe('pending');
  });

  test('requires approval of the current plan revision', async () => {
    const campaign = await service.createPlan({ brief: { topic: 'Grid batteries' } }, context);
    await expect(service.approveAndRender('phill', campaign.id, { planRevision: 9 }, context))
      .rejects.toMatchObject({ code: 'campaign_plan_revision_mismatch', statusCode: 409 });
    expect(podcast.createPodcast).not.toHaveBeenCalled();
  });

  test('renders the approved script, cover, three clips, and credits package', async () => {
    const campaign = await service.createPlan({
      brief: { topic: 'Grid batteries' },
      episodeFormat: 'two-host',
      brandKitId: 'brand-1',
      includeFullVideo: true,
    }, context);
    const rendered = await service.approveAndRender('phill', campaign.id, { planRevision: campaign.plan.revision }, context);

    expect(podcast.createPodcast).toHaveBeenCalledWith(expect.objectContaining({
      approvedScript: campaign.plan.script,
      approvedSources: campaign.plan.sources,
    }), expect.any(Object));
    expect(video.createPromoClipFromPodcast).toHaveBeenCalledTimes(3);
    expect(rendered.status).toBe('complete');
    expect(rendered.render.package).toEqual(expect.objectContaining({ id: 'bundle-1' }));
    expect(rendered.render.credits).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ai-audio' }), expect.objectContaining({ type: 'ai-image' })]));
  });

  test('regenerates one promo asset and refreshes the package manifest', async () => {
    const campaign = await service.createPlan({ brief: { topic: 'Grid batteries' }, brandKitId: 'brand-1' }, context);
    const rendered = await service.approveAndRender('phill', campaign.id, { planRevision: campaign.plan.revision }, context);
    video.createPromoClipFromPodcast.mockClear();

    const refreshed = await service.regenerateAsset('phill', campaign.id, 'promo', 1, context);

    expect(video.createPromoClipFromPodcast).toHaveBeenCalledTimes(1);
    expect(video.createPromoClipFromPodcast).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      clip: expect.objectContaining({ id: 'clip-2' }),
    }));
    expect(refreshed.render.package).toEqual(expect.objectContaining({ id: 'bundle-1' }));
    expect(refreshed.render.promoClips).toHaveLength(rendered.render.promoClips.length);
  });
});

const JSZip = require('jszip');
const { persistGeneratedArtifactLocally } = require('../generated-file-artifacts');
const { podcastService } = require('../podcast/podcast-service');
const { podcastVideoService } = require('../video/podcast-video-service');
const store = require('./store');

function clean(value = '', max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function normalizeBrief(input = {}) {
  const topic = clean(input.topic, 500);
  if (!topic) {
    const error = new Error('A podcast topic is required.');
    error.statusCode = 400;
    error.code = 'podcast_launch_topic_required';
    throw error;
  }
  return {
    topic,
    audience: clean(input.audience, 300) || 'general audience',
    callToAction: clean(input.callToAction, 500) || 'Listen to the full episode',
    durationMinutes: clamp(input.durationMinutes, 3, 10, 5),
    tone: clean(input.tone, 300) || 'confident, conversational, clear',
    sourceUrls: Array.isArray(input.sourceUrls) ? input.sourceUrls.map((url) => clean(url, 1000)).filter(Boolean).slice(0, 6) : [],
    useOnlineResearch: input.useOnlineResearch !== false,
  };
}

function normalizeEpisodeFormat(value = '') {
  return String(value || '').trim() === 'two-host' ? 'two-host' : 'single-host';
}

function resolveHosts(episodeFormat, brandKit, input = {}) {
  const voices = Array.isArray(brandKit?.hostVoices) ? brandKit.hostVoices : [];
  const requested = Array.isArray(input.hosts) ? input.hosts : [];
  const first = requested[0] || {};
  const second = requested[1] || {};
  const hosts = [{
    name: clean(first.name, 80) || 'Maya',
    role: clean(first.role, 120) || 'Lead host',
    persona: clean(first.persona, 300) || clean(brandKit?.tone, 300) || 'Warm, credible guide',
    voiceId: clean(first.voiceId, 120) || clean(voices[0], 120) || 'af_heart',
  }];
  if (episodeFormat === 'two-host') {
    hosts.push({
      name: clean(second.name, 80) || 'June',
      role: clean(second.role, 120) || 'Co-host',
      persona: clean(second.persona, 300) || 'Curious, concise counterpoint',
      voiceId: clean(second.voiceId, 120) || clean(voices[1], 120) || 'af_sky',
    });
  }
  return hosts;
}

function transcriptFromTurns(turns = []) {
  return turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n\n');
}

function proposeClips(turns = [], durationMinutes = 5, callToAction = '') {
  const totalWords = Math.max(1, turns.reduce((sum, turn) => sum + clean(turn.text).split(/\s+/).filter(Boolean).length, 0));
  const totalSeconds = durationMinutes * 60;
  const targets = [0.12, 0.46, 0.78];
  let runningWords = 0;
  const timedTurns = turns.map((turn, index) => {
    const words = clean(turn.text).split(/\s+/).filter(Boolean).length;
    const start = (runningWords / totalWords) * totalSeconds;
    runningWords += words;
    return { ...turn, index, start, end: (runningWords / totalWords) * totalSeconds };
  });
  return targets.map((target, index) => {
    const selected = timedTurns.find((turn) => turn.end / totalSeconds >= target) || timedTurns[timedTurns.length - 1];
    const next = timedTurns[Math.min((selected?.index || 0) + 1, timedTurns.length - 1)];
    const transcript = [selected, next]
      .filter(Boolean)
      .map((turn) => clean(turn.text, 600))
      .join(' ')
      .split(/\s+/)
      .slice(0, 70)
      .join(' ');
    const start = Math.max(0, Number(selected?.start || 0) - 2);
    return {
      id: `clip-${index + 1}`,
      title: index === 0 ? 'The hook' : index === 1 ? 'The insight' : 'The takeaway',
      startSeconds: Math.round(start * 10) / 10,
      endSeconds: Math.round(Math.min(totalSeconds, start + 24) * 10) / 10,
      transcript,
      caption: transcript,
      callToAction,
      approved: true,
    };
  });
}

function showNotesFor(plan) {
  const sourceLines = plan.sources.map((source) => `- [${clean(source.title, 180) || source.url}](${source.url})`);
  return [
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    '## In this episode',
    '',
    ...plan.outline.map((item) => `- ${item}`),
    '',
    '## Sources',
    '',
    ...(sourceLines.length ? sourceLines : ['- No external sources were attached to this plan.']),
    '',
    `**Next step:** ${plan.brief.callToAction}`,
  ].join('\n');
}

function stageRecord(status = 'pending', detail = '') {
  return { status, detail, updatedAt: new Date().toISOString(), error: null };
}

function buildCredits(campaign) {
  const credits = [{ type: 'ai-audio', label: 'Synthetic podcast narration', provider: 'KimiBuilt TTS' }];
  if (campaign.render?.coverArt) credits.push({ type: 'ai-image', label: 'AI-generated cover art', artifactId: campaign.render.coverArt.artifactId || null });
  (campaign.plan?.sources || []).forEach((source) => {
    if (source?.url) credits.push({ type: 'research-source', label: source.title || source.url, url: source.url });
  });
  const brand = campaign.plan?.brandKit || {};
  if (brand.logoArtifactId) credits.push({ type: 'user-asset', label: 'Brand logo reference', artifactId: brand.logoArtifactId });
  (brand.referenceArtifactIds || []).forEach((artifactId) => credits.push({ type: 'user-asset', label: 'Brand reference asset', artifactId }));
  const storyboards = [campaign.render?.fullVideo?.storyboard, ...(campaign.render?.promoClips || []).map((clip) => clip.storyboard)];
  storyboards.forEach((storyboard) => {
    (storyboard?.scenes || []).forEach((scene) => {
      const attribution = scene?.image?.attribution;
      if (attribution?.name || attribution?.url || attribution?.link) {
        credits.push({
          type: 'stock-image',
          label: attribution.name || 'Unsplash contributor',
          url: attribution.url || attribution.link || null,
          source: 'Unsplash',
        });
      }
    });
  });
  return credits.filter((entry, index, items) => index === items.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)));
}

class PodcastLaunchKitService {
  constructor(dependencies = {}) {
    this.store = dependencies.store || store;
    this.podcastService = dependencies.podcastService || podcastService;
    this.videoService = dependencies.videoService || podcastVideoService;
    this.persistArtifact = dependencies.persistArtifact || persistGeneratedArtifactLocally;
  }

  async createPlan(input = {}, context = {}) {
    const ownerId = context.ownerId;
    const brief = normalizeBrief(input.brief || input);
    const episodeFormat = normalizeEpisodeFormat(input.episodeFormat);
    const brandKit = input.brandKitId ? await this.store.getBrandKit(ownerId, input.brandKitId) : null;
    const hosts = resolveHosts(episodeFormat, brandKit, input);
    const sourceDocuments = Array.isArray(input.sourceDocuments) ? input.sourceDocuments : [];
    const sources = await this.podcastService.researchTopic({
      topic: brief.topic,
      sourceUrls: brief.sourceUrls,
      sourceDocuments,
      useOnlineResearch: brief.useOnlineResearch,
      maxSources: 5,
    }, {
      executeTool: context.toolManager?.executeTool?.bind(context.toolManager),
      toolContext: context.toolContext || context,
    });
    const script = await this.podcastService.generateScript({
      topic: brief.topic,
      requestBrief: clean(input.campaignOverrides?.contentRequest, 3000),
      audience: brief.audience,
      tone: [brief.tone, brandKit?.tone, input.campaignOverrides?.tone].filter(Boolean).join(', '),
      detailLevel: 'rich',
      durationMinutes: brief.durationMinutes,
      hosts,
      sources,
      models: [context.model].filter(Boolean),
      reasoningEffort: context.reasoningEffort,
      videoFormat: input.includeFullVideo === true,
      systemPrompt: clean(input.campaignOverrides?.systemPrompt, 3000),
    });
    const transcript = transcriptFromTurns(script.turns);
    const storyboard = await this.videoService.planStoryboard({
      title: script.title,
      transcript,
      turns: script.turns,
      durationSeconds: brief.durationMinutes * 60,
      sceneCount: clamp(input.sceneCount, 4, 12, 7),
      visualStyle: [brandKit?.visualStyle, input.campaignOverrides?.visualStyle].filter(Boolean).join('. '),
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      toolManager: context.toolManager,
      toolContext: context.toolContext || context,
    });
    const stockSources = await this.videoService.suggestStockSources(storyboard?.scenes || [], {
      orientation: 'landscape',
    });
    const stockByScene = new Map(stockSources.map((source) => [source.sceneId, source]));
    const reviewedStoryboard = {
      ...storyboard,
      stockSources,
      scenes: (storyboard?.scenes || []).map((scene) => {
        const source = stockByScene.get(scene.id);
        return source
          ? { ...scene, imageUrl: source.imageUrl, imageSource: source.source, attribution: source.attribution }
          : scene;
      }),
    };
    const plan = {
      revision: 1,
      title: script.title,
      summary: script.summary,
      brief,
      episodeFormat,
      includeFullVideo: input.includeFullVideo === true,
      hosts,
      sources,
      outline: script.turns.slice(0, 6).map((turn) => clean(turn.text, 180)),
      script: { ...script, transcript },
      coverConcept: {
        prompt: `Editorial podcast cover art for "${script.title}". ${brandKit?.visualStyle || 'Premium, modern, high-contrast composition'}. Palette: ${(brandKit?.palette || []).join(', ') || 'deep navy, electric blue, warm accent'}. No logos, watermarks, or small text.`,
        alt: `Cover art for ${script.title}`,
      },
      storyboard: reviewedStoryboard,
      promoClips: proposeClips(script.turns, brief.durationMinutes, brief.callToAction),
      showNotes: '',
      campaignOverrides: input.campaignOverrides || {},
      brandKitId: brandKit?.id || null,
      brandKit: brandKit ? { ...brandKit } : null,
    };
    plan.showNotes = showNotesFor(plan);
    return this.store.saveCampaign(ownerId, {
      sessionId: context.sessionId,
      status: 'planned',
      approvedAt: null,
      plan,
      render: {
        stages: {
          episode: stageRecord(),
          cover: stageRecord(),
          fullVideo: stageRecord(plan.includeFullVideo ? 'pending' : 'skipped'),
          promoClips: stageRecord(),
          package: stageRecord(),
        },
        podcast: null,
        coverArt: null,
        fullVideo: null,
        promoClips: [],
        artifacts: [],
        credits: [],
      },
    });
  }

  async revisePlan(ownerId, campaignId, planPatch = {}) {
    const campaign = await this.store.getCampaign(ownerId, campaignId);
    if (campaign.status === 'rendering') {
      const error = new Error('A campaign cannot be revised while it is rendering.');
      error.statusCode = 409;
      error.code = 'campaign_render_in_progress';
      throw error;
    }
    const plan = { ...campaign.plan, ...planPatch, revision: Number(campaign.plan?.revision || 1) + 1 };
    plan.promoClips = (Array.isArray(planPatch.promoClips) ? planPatch.promoClips : campaign.plan.promoClips)
      .slice(0, 3)
      .map((clip, index) => ({ ...clip, id: clip.id || `clip-${index + 1}`, approved: clip.approved !== false }));
    plan.showNotes = clean(planPatch.showNotes, 20000) || showNotesFor(plan);
    return this.store.saveCampaign(ownerId, { ...campaign, status: 'planned', approvedAt: null, plan });
  }

  async approveAndRender(ownerId, campaignId, input = {}, context = {}) {
    let campaign = await this.store.getCampaign(ownerId, campaignId);
    if (Number(input.planRevision) !== Number(campaign.plan?.revision)) {
      const error = new Error('The campaign plan changed. Review the latest revision before rendering.');
      error.statusCode = 409;
      error.code = 'campaign_plan_revision_mismatch';
      throw error;
    }
    campaign.status = 'rendering';
    campaign.approvedAt = new Date().toISOString();
    campaign = await this.store.saveCampaign(ownerId, campaign);
    return this.renderCampaign(campaign, context);
  }

  async retryStage(ownerId, campaignId, stage, context = {}) {
    const allowed = new Set(['episode', 'cover', 'fullVideo', 'promoClips', 'package']);
    if (!allowed.has(stage)) {
      const error = new Error('Unknown campaign stage.');
      error.statusCode = 400;
      error.code = 'campaign_stage_invalid';
      throw error;
    }
    const campaign = await this.store.getCampaign(ownerId, campaignId);
    campaign.status = 'rendering';
    campaign.render.stages[stage] = stageRecord('pending');
    await this.store.saveCampaign(ownerId, campaign);
    return this.renderCampaign(campaign, context, stage === 'package' ? [stage] : [stage, 'package']);
  }

  async regenerateAsset(ownerId, campaignId, assetType, index, context = {}) {
    if (assetType !== 'promo') {
      const stage = assetType === 'cover' ? 'cover' : assetType === 'fullVideo' ? 'fullVideo' : null;
      if (!stage) {
        const error = new Error('Unknown campaign asset.');
        error.statusCode = 400;
        error.code = 'campaign_asset_invalid';
        throw error;
      }
      return this.retryStage(ownerId, campaignId, stage, context);
    }
    const campaign = await this.store.getCampaign(ownerId, campaignId);
    const clipIndex = Number(index);
    const clip = campaign.plan?.promoClips?.[clipIndex];
    if (!clip || !campaign.render?.podcast?.audio?.artifactId) {
      const error = new Error('The selected promo clip or episode audio is unavailable.');
      error.statusCode = 409;
      error.code = 'campaign_promo_clip_unavailable';
      throw error;
    }
    const brand = campaign.plan.brandKit || (campaign.plan.brandKitId ? await this.store.getBrandKit(ownerId, campaign.plan.brandKitId) : null);
    const renderedClip = await this.videoService.createPromoClipFromPodcast(campaign.render.podcast, {
      sessionId: campaign.sessionId,
      clip,
      brand,
      options: {
        aspectRatio: '9:16',
        imageMode: 'generated',
        generateImages: false,
        visualStyle: campaign.plan.campaignOverrides?.visualStyle,
        toolManager: context.toolManager,
        toolContext: context.toolContext,
      },
    });
    campaign.render.promoClips[clipIndex] = renderedClip;
    campaign.render.stages.promoClips = stageRecord('complete', `Regenerated promo clip ${clipIndex + 1}`);
    campaign.render.credits = buildCredits(campaign);
    campaign.render.package = await this.createPackage({ ...campaign, ownerId });
    campaign.status = 'complete';
    return this.store.saveCampaign(ownerId, campaign);
  }

  async runStage(campaign, stage, operation) {
    campaign.render.stages[stage] = stageRecord('running');
    await this.persistCampaign(campaign);
    try {
      const result = await operation();
      campaign.render.stages[stage] = stageRecord('complete');
      await this.persistCampaign(campaign);
      return result;
    } catch (error) {
      campaign.render.stages[stage] = { ...stageRecord('failed'), error: { code: error.code || 'render_failed', message: error.message } };
      campaign.status = 'partial';
      await this.persistCampaign(campaign);
      throw error;
    }
  }

  persistCampaign(campaign) {
    const { ownerId, ...record } = campaign;
    return this.store.saveCampaign(ownerId, record);
  }

  async renderCampaign(inputCampaign, context = {}, onlyStages = null) {
    const campaign = { ...inputCampaign, ownerId: context.ownerId || inputCampaign.ownerId };
    const plan = campaign.plan;
    const stages = onlyStages ? new Set(onlyStages) : null;
    const shouldRun = (stage) => !stages || stages.has(stage);

    if (shouldRun('episode')) {
      campaign.render.podcast = await this.runStage(campaign, 'episode', () => this.podcastService.createPodcast({
        topic: plan.brief.topic,
        title: plan.title,
        audience: plan.brief.audience,
        tone: plan.brief.tone,
        durationMinutes: plan.brief.durationMinutes,
        hostCount: plan.hosts.length,
        hostAName: plan.hosts[0]?.name,
        hostARole: plan.hosts[0]?.role,
        hostAPersona: plan.hosts[0]?.persona,
        hostAVoiceId: plan.hosts[0]?.voiceId,
        hostBName: plan.hosts[1]?.name,
        hostBRole: plan.hosts[1]?.role,
        hostBPersona: plan.hosts[1]?.persona,
        hostBVoiceId: plan.hosts[1]?.voiceId,
        approvedScript: plan.script,
        approvedSources: plan.sources,
        includeMusicBed: true,
        includeIntro: true,
        includeOutro: true,
        exportMp3: true,
      }, {
        sessionId: campaign.sessionId,
        clientSurface: 'web-chat-content-studio',
        taskType: 'podcast-launch-kit',
        model: context.model,
        toolManager: context.toolManager,
      }));
    }
    const podcast = campaign.render.podcast;
    if (!podcast?.audio?.artifactId && ['fullVideo', 'promoClips'].some(shouldRun)) {
      const error = new Error('Render the episode audio before rendering video assets.');
      error.statusCode = 409;
      error.code = 'campaign_episode_required';
      throw error;
    }

    if (shouldRun('cover')) {
      campaign.render.coverArt = await this.runStage(campaign, 'cover', async () => {
        const result = await context.toolManager.executeTool('image-generate', {
          prompt: plan.coverConcept.prompt,
          alt: plan.coverConcept.alt,
          size: '1024x1024',
          quality: 'high',
          n: 1,
        }, { ...context.toolContext, sessionId: campaign.sessionId });
        if (!result?.success || !result.data?.image) throw new Error(result?.error || 'Cover image generation failed.');
        return result.data.image;
      });
    }

    if (shouldRun('fullVideo') && plan.includeFullVideo) {
      campaign.render.fullVideo = await this.runStage(campaign, 'fullVideo', () => this.videoService.createVideoFromPodcast(podcast, {
        sessionId: campaign.sessionId,
        options: {
          aspectRatio: '16:9',
          imageMode: plan.storyboard?.stockSources?.length ? 'unsplash' : 'generated',
          generateImages: !plan.storyboard?.stockSources?.length,
          scenes: plan.storyboard?.scenes,
          visualStyle: plan.campaignOverrides?.visualStyle,
          toolManager: context.toolManager,
          toolContext: context.toolContext,
        },
      }));
    }

    if (shouldRun('promoClips')) {
      campaign.render.promoClips = await this.runStage(campaign, 'promoClips', async () => {
        const clips = plan.promoClips.filter((clip) => clip.approved !== false).slice(0, 3);
        const brand = plan.brandKit || (plan.brandKitId ? await this.store.getBrandKit(campaign.ownerId, plan.brandKitId) : null);
        return Promise.all(clips.map((clip) => this.videoService.createPromoClipFromPodcast(podcast, {
          sessionId: campaign.sessionId,
          clip,
          brand,
          options: {
            aspectRatio: '9:16',
            imageMode: 'generated',
            generateImages: false,
            visualStyle: plan.campaignOverrides?.visualStyle,
            toolManager: context.toolManager,
            toolContext: context.toolContext,
          },
        })));
      });
    }

    campaign.render.credits = buildCredits(campaign);
    if (shouldRun('package')) {
      campaign.render.package = await this.runStage(campaign, 'package', () => this.createPackage(campaign));
    }
    campaign.render.artifacts = [
      ...(podcast?.artifacts || []),
      campaign.render.coverArt,
      campaign.render.fullVideo?.artifact,
      ...(campaign.render.promoClips || []).map((entry) => entry.artifact),
      campaign.render.package,
    ].filter(Boolean);
    const hasFailure = Object.values(campaign.render.stages).some((stage) => stage.status === 'failed');
    campaign.status = hasFailure ? 'partial' : 'complete';
    delete campaign.ownerId;
    return this.store.saveCampaign(context.ownerId, campaign);
  }

  async createPackage(campaign) {
    const creditsMarkdown = [
      '# Credits and usage notes',
      '',
      'This package contains AI-generated media. Review platform disclosure requirements before publishing.',
      '',
      ...campaign.render.credits.map((entry) => `- **${entry.type}**: ${entry.label}${entry.url ? ` — ${entry.url}` : ''}`),
    ].join('\n');
    const zip = new JSZip();
    zip.file('README.md', `# ${campaign.plan.title}\n\n${campaign.plan.summary}\n`);
    zip.file('SHOW-NOTES.md', campaign.plan.showNotes);
    zip.file('TRANSCRIPT.md', `# Transcript\n\n${campaign.plan.script.transcript}\n`);
    zip.file('CREDITS.md', creditsMarkdown);
    zip.file('campaign-manifest.json', JSON.stringify({ ...campaign, ownerId: undefined }, null, 2));
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return this.persistArtifact({
      sessionId: campaign.sessionId,
      sourceMode: 'podcast-launch-kit',
      filename: `${clean(campaign.plan.title, 80).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'podcast'}-launch-kit.zip`,
      extension: 'zip',
      mimeType: 'application/zip',
      buffer,
      extractedText: `${campaign.plan.title}\n${campaign.plan.summary}\n${creditsMarkdown}`,
      metadata: { generatedBy: 'podcast-launch-kit', campaignId: campaign.id, includesCredits: true },
    });
  }
}

module.exports = {
  PodcastLaunchKitService,
  buildCredits,
  normalizeBrief,
  podcastLaunchKitService: new PodcastLaunchKitService(),
  proposeClips,
};

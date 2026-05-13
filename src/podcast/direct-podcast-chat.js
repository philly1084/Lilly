const {
  extractExplicitPodcastTopic,
  extractPodcastRequestBrief,
  hasExplicitPodcastIntent,
  hasExplicitPodcastVideoIntent,
  inferPodcastHostCount,
  inferPodcastAudioAssetOptions,
  inferPodcastVideoOptions,
} = require('./podcast-intent');

function extractRequestedPodcastDurationMinutes(text = '') {
  const source = String(text || '').trim();
  if (!source) {
    return null;
  }

  const match = source.match(/\b(\d{1,2})\s*(?:minute|min)\b/i);
  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes)) {
    return null;
  }

  return Math.max(3, Math.min(30, Math.round(minutes)));
}

function inferQualitativePodcastDurationMinutes(text = '') {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) {
    return null;
  }

  if (/\b(?:not|non)[- ]short\b/.test(normalized)
    || /\b(?:do not|don't)\s+(?:make|keep)\s+it\s+short\b/.test(normalized)
    || /\b(?:longer|full[- ]length|proper|complete|deep[- ]dive|in[- ]depth|comprehensive|detailed|rich(?:er)?)\b/.test(normalized)) {
    return 12;
  }

  return null;
}

function inferPodcastDetailLevel(text = '') {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) {
    return null;
  }

  if (/\b(?:not|non)[- ]short\b/.test(normalized)
    || /\b(?:do not|don't)\s+(?:make|keep)\s+it\s+short\b/.test(normalized)
    || /\b(?:detailed|rich(?:er)?|in[- ]depth|deep[- ]dive|comprehensive|thorough|complete|proper|full)\b/.test(normalized)) {
    return 'rich';
  }

  return null;
}

function shouldUseDirectPodcastChat(text = '') {
  return hasExplicitPodcastIntent(text);
}

function normalizeBooleanOption(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizePodcastOptions(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const normalized = {};
  [
    'includeVideo',
    'voiceOnlyAudio',
    'includeIntro',
    'includeOutro',
    'includeMusicBed',
    'videoGenerateImages',
    'cycleHostVoices',
    'allowVoiceFallback',
    'allowProviderFallback',
    'allowTtsProviderFallback',
  ].forEach((key) => {
    const value = normalizeBooleanOption(source[key]);
    if (value !== null) {
      normalized[key] = value;
    }
  });

  [
    'videoAspectRatio',
    'videoRenderMode',
    'videoImageMode',
    'scriptDesign',
    'scriptDesignExample',
    'systemPrompt',
    'additionalSystemPrompt',
    'directContentRequest',
    'outputFormat',
  ].forEach((key) => {
    const value = String(source[key] || '').trim();
    if (value) {
      normalized[key] = value;
    }
  });

  const durationMinutes = Number(source.durationMinutes);
  if (Number.isFinite(durationMinutes)) {
    normalized.durationMinutes = Math.max(3, Math.min(30, Math.round(durationMinutes)));
  }

  if (normalized.voiceOnlyAudio !== true && (
    normalized.includeIntro === true
    || normalized.includeOutro === true
    || normalized.includeMusicBed === true
  )) {
    normalized.voiceOnlyAudio = false;
  }

  return normalized;
}

function buildDirectPodcastParams({
  text = '',
  artifactIds = [],
  model = null,
  reasoningEffort = null,
  podcastOptions = null,
} = {}) {
  const structuredOptions = normalizePodcastOptions(podcastOptions);
  const hasStructuredPodcastOptions = structuredOptions.enabled === true
    || structuredOptions.includeVideo === true
    || structuredOptions.productionType === 'podcast'
    || structuredOptions.productionType === 'video-podcast';
  const fallbackTopic = hasStructuredPodcastOptions
    ? String(text || '')
      .replace(/^(?:please\s+)?(?:make|create|generate|produce)\s+(?:a|an)?\s*(?:video\s+)?podcast(?:\s+(?:about|on|for))?\s*/i, '')
      .trim()
    : '';
  const topic = extractExplicitPodcastTopic(text) || fallbackTopic;
  if (!topic) {
    return null;
  }

  const selectedArtifactIds = (Array.isArray(artifactIds) ? artifactIds : [])
    .map((artifactId) => String(artifactId || '').trim())
    .filter(Boolean);
  const durationMinutes = extractRequestedPodcastDurationMinutes(text)
    || inferQualitativePodcastDurationMinutes(text);
  const requestBrief = extractPodcastRequestBrief(text);
  const hostCount = inferPodcastHostCount(text);
  const detailLevel = inferPodcastDetailLevel(text);
  const videoOptions = hasExplicitPodcastVideoIntent(text)
    ? inferPodcastVideoOptions(text)
    : {};
  const audioAssetOptions = inferPodcastAudioAssetOptions(text);
  const directContentRequest = String(structuredOptions.directContentRequest || '').trim();
  const additionalBrief = directContentRequest
    ? `\n\nDirect content request:\n${directContentRequest}`
    : '';
  delete structuredOptions.directContentRequest;

  return {
    topic,
    ...(requestBrief || additionalBrief ? { requestBrief: `${requestBrief}${additionalBrief}`.trim() } : {}),
    ...(hostCount ? { hostCount } : {}),
    ...(selectedArtifactIds.length > 0 ? { artifactIds: selectedArtifactIds } : {}),
    ...(durationMinutes ? { durationMinutes } : {}),
    ...(detailLevel ? { detailLevel } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...audioAssetOptions,
    ...videoOptions,
    ...structuredOptions,
  };
}

function buildDirectPodcastAssistantMessage(podcast = {}) {
  const title = String(podcast?.title || podcast?.metadata?.title || 'Podcast').trim() || 'Podcast';
  const summary = String(podcast?.summary || podcast?.metadata?.summary || '').trim();
  const artifacts = Array.isArray(podcast?.artifacts) ? podcast.artifacts : [];
  const artifactNames = artifacts
    .map((artifact) => String(artifact?.filename || artifact?.name || '').trim())
    .filter(Boolean);

  return [
    `The podcast has been created: "${title}".`,
    summary,
    artifactNames.length > 0
      ? `Artifacts: ${artifactNames.join(', ')}.`
      : '',
    'The podcast workflow completed successfully.',
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  buildDirectPodcastAssistantMessage,
  buildDirectPodcastParams,
  shouldUseDirectPodcastChat,
};

const { config } = require('../config');
const { createResponse } = require('../openai-client');
const { artifactService } = require('../artifacts/artifact-service');
const { ttsService } = require('../tts/tts-service');
const { normalizeTextForSpeech } = require('../tts/speech-text');
const { persistGeneratedAudio, updateGeneratedAudioSessionState } = require('../generated-audio-artifacts');
const { audioProcessingService } = require('../audio/audio-processing-service');
const settingsController = require('../routes/admin/settings.controller');
const {
  concatWavBuffers,
  createSilenceWavBuffer,
  applyWavEdgeFade,
  normalizeWavBufferFormat,
  parseWavBuffer,
  wavFormatsMatch,
} = require('../audio/wav-utils');
const { chunkText, normalizeWhitespace, stripHtml, stripNullCharacters } = require('../utils/text');
const { parseLenientJson } = require('../utils/lenient-json');
const {
  getPodcastScriptDesignOptions,
  resolvePodcastScriptDesign,
} = require('./script-designs');

const DEFAULT_DURATION_MINUTES = 10;
const DEFAULT_TARGET_WPM = 145;
const DEFAULT_MAX_SOURCES = 4;
const DEFAULT_SILENCE_MS = 325;
const DEFAULT_FINAL_TAIL_SILENCE_MS = 650;
const DEFAULT_MINIMUM_VALID_TURNS = 4;
const DEFAULT_PODCAST_SEARCH_TIMEOUT_MS = 45000;
const MAX_PODCAST_SOURCE_SNIPPET_CHARS = 800;
const MAX_PODCAST_SOURCE_EXCERPT_CHARS = 1400;
const MAX_PODCAST_ARTIFACT_SOURCE_CHARS = 6000;
const DEFAULT_PODCAST_SCRIPT_REQUEST_TIMEOUT_MS = Math.max(
  30000,
  Number(config?.podcast?.scriptRequestTimeoutMs) || (5 * 60 * 1000),
);
const DEFAULT_PODCAST_SCRIPT_RETRY_ATTEMPTS = Math.max(
  0,
  Number(config?.podcast?.scriptRetryAttempts) || 1,
);
const DEFAULT_TRANSIENT_RETRY_ATTEMPTS = 2;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 1200;
const DEFAULT_AUDIO_PROCESSING_RETRY_ATTEMPTS = 1;
const DEFAULT_PODCAST_RESEARCH_CONCURRENCY = Math.max(
  1,
  Math.min(12, Number(config?.podcast?.researchConcurrency) || 2),
);
const DEFAULT_PODCAST_TTS_CONCURRENCY = Math.max(
  1,
  Math.min(24, Number(config?.podcast?.ttsConcurrency) || 2),
);
const MAX_PODCAST_RESEARCH_CONCURRENCY = 12;
const MAX_PODCAST_TTS_CONCURRENCY = 24;
const PODCAST_HIGH_QUALITY_VOICE_IDS = Object.freeze([
  'af_heart',
  'af_bella',
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
]);
const PODCAST_FEMALE_VOICE_IDS = new Set([
  ...PODCAST_HIGH_QUALITY_VOICE_IDS,
  'af_alloy',
  'af_aoede',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'bf_alice',
  'bf_isabella',
]);
const DEFAULT_MAX_VOICE_FALLBACK_ATTEMPTS = 2;
const MAX_PODCAST_TTS_SPLIT_DEPTH = 3;
const PODCAST_STAGE_DETAILS_ALLOWLIST = new Set([
  'sessionId',
  'topic',
  'durationMinutes',
  'model',
  'includeVideo',
  'sourceCount',
  'turnCount',
  'hostCount',
  'ttsProvider',
  'ttsConcurrency',
  'ttsTimeoutMs',
  'ttsChunkMaxChars',
  'researchConcurrency',
  'mixed',
  'enhanced',
  'musicBedApplied',
  'mp3Exported',
]);
const UNSAFE_IMPLICIT_PODCAST_SCRIPT_MODELS = new Set([
  'gpt-4o-mini',
]);
const DEFAULT_HOST_ROSTER = Object.freeze([
  {
    key: 'hostA',
    name: 'Maya',
    role: 'Lead host',
    persona: 'Warm, curious, and good at guiding the listener through the big picture.',
    preferredVoiceIds: ['af_heart', 'af_bella'],
  },
  {
    key: 'hostB',
    name: 'June',
    role: 'Co-host',
    persona: 'Grounded, calm, and precise when unpacking details, tradeoffs, and practical consequences.',
    preferredVoiceIds: ['af_bella', 'af_nicole', 'bf_emma'],
  },
  {
    key: 'hostC',
    name: 'June',
    role: 'Co-host',
    persona: 'Sharper, more analytical, and slightly playful when unpacking details and tradeoffs.',
    preferredVoiceIds: ['af_bella', 'af_nicole', 'bf_emma'],
  },
  {
    key: 'hostD',
    name: 'Claire',
    role: 'Lead host',
    persona: 'Measured, thoughtful, and good at turning technical material into clear narrative beats.',
    preferredVoiceIds: ['af_heart', 'af_bella'],
  },
]);
const LEGACY_DEFAULT_HOSTS = Object.freeze([
  {
    key: 'hostA',
    name: 'Maya',
    role: 'Lead host',
    persona: 'Warm, curious, and good at guiding the listener through the big picture.',
    preferredVoiceIds: ['af_bella', 'af_heart', 'ljspeech-high', 'lessac-high'],
  },
  {
    key: 'hostB',
    name: 'June',
    role: 'Co-host',
    persona: 'Sharper, more analytical, and slightly playful when unpacking details and tradeoffs.',
    preferredVoiceIds: ['bf_emma', 'af_heart', 'cori-high', 'lessac-high'],
  },
]);

function isPodcastFemaleVoiceId(value = '') {
  const voiceId = String(value || '').trim();
  if (!voiceId) {
    return false;
  }
  if (/^(?:af|bf)_/i.test(voiceId)) {
    return true;
  }
  if (/^(?:am|bm)_/i.test(voiceId)) {
    return false;
  }
  return PODCAST_FEMALE_VOICE_IDS.has(voiceId);
}

function isPodcastFemaleVoice(voice = {}) {
  const voiceId = String(voice?.id || voice?.voiceId || '').trim();
  if (isPodcastFemaleVoiceId(voiceId)) {
    return true;
  }

  return Array.isArray(voice?.aliases)
    && voice.aliases.some((alias) => isPodcastFemaleVoiceId(alias));
}

function resolveHighQualityVoicePool(availableVoiceIds = new Set(), preferredVoiceIds = []) {
  const preferred = uniqueOrdered(preferredVoiceIds)
    .filter((voiceId) => isPodcastFemaleVoiceId(voiceId))
    .filter((voiceId) => availableVoiceIds.has(voiceId));

  if (preferred.length > 0) {
    return preferred;
  }

  const curated = uniqueOrdered(
    PODCAST_HIGH_QUALITY_VOICE_IDS.filter((voiceId) => availableVoiceIds.has(voiceId)),
  );

  if (curated.length > 0) {
    return curated;
  }

  return uniqueOrdered(Array.from(availableVoiceIds))
    .filter((voiceId) => isPodcastFemaleVoiceId(voiceId));
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function stripUnpairedSurrogates(value = '') {
  const input = String(value || '');
  let output = '';

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = input.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
        output += input[index] + input[index + 1];
        index += 1;
      }
      continue;
    }

    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      continue;
    }

    output += input[index];
  }

  return output;
}

function stripMalformedUnicodeEscapes(value = '') {
  return String(value || '')
    .replace(/\\u(?![0-9a-fA-F]{4})/g, '')
    .replace(/\\u[0-9a-fA-F]{1,3}(?![0-9a-fA-F])/g, '')
    .replace(/\\x(?![0-9a-fA-F]{2})/g, '')
    .replace(/\\x[0-9a-fA-F](?![0-9a-fA-F])/g, '')
    .replace(/\\u\{[0-9a-fA-F]+\}(?![0-9a-fA-F])/g, '');
}

function sanitizePodcastTextForSpeech(value = '') {
  return stripMalformedUnicodeEscapes(stripUnpairedSurrogates(stripNullCharacters(value || '')))
    .replace(/\u200B/g, ' ')
    .replace(/[^\x20-\x7E\n\r\t]+/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizePodcastTextChunkForSpeech(value = '', maxTextChars = 2400) {
  const sanitized = sanitizePodcastTextForSpeech(value);
  if (!sanitized) {
    return '';
  }

  try {
    return normalizeTextForSpeech(sanitized, maxTextChars);
  } catch (error) {
    if (error?.code === 'empty_text') {
      return '';
    }
    throw error;
  }
}

function normalizeStringList(value = []) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function uniqueOrdered(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .filter((value) => {
      const id = String(value || '').trim();
      if (!id || seen.has(id)) {
        return false;
      }

      seen.add(id);
      return true;
    });
}

function stableIndexFromText(value = '', modulo = 1) {
  const limit = Math.max(1, Number(modulo) || 1);
  const input = String(value || '');
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash * 31) + input.charCodeAt(index)) >>> 0;
  }
  return hash % limit;
}

function sanitizePodcastLogDetails(details = {}) {
  const output = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (!PODCAST_STAGE_DETAILS_ALLOWLIST.has(key)) {
      continue;
    }
    if (value == null) {
      continue;
    }
    if (typeof value === 'string') {
      output[key] = value.length > 240 ? `${value.slice(0, 237)}...` : value;
      continue;
    }
    if (['number', 'boolean'].includes(typeof value)) {
      output[key] = value;
    }
  }
  return output;
}

function annotatePodcastError(error, stage, details = {}) {
  if (error && typeof error === 'object') {
    error.podcastStage = error.podcastStage || stage;
    error.podcastDiagnostics = {
      ...(error.podcastDiagnostics || {}),
      stage,
      ...sanitizePodcastLogDetails(details),
    };
  }
  return error;
}

function logPodcastStageFailure(stage, error = {}, details = {}) {
  const safeDetails = sanitizePodcastLogDetails(details);
  const code = String(error?.code || error?.statusCode || error?.status || '').trim();
  const message = String(error?.message || error || 'Unknown podcast failure').trim();
  console.error(`[PodcastService] Stage failed: ${stage}`, {
    ...(code ? { code } : {}),
    message,
    ...safeDetails,
  });
}

function summarizeTtsError(error = {}) {
  if (!error || typeof error !== 'object') {
    return null;
  }

  return {
    code: String(error.code || '').trim() || null,
    statusCode: Number(error.statusCode || error.status) || null,
    message: String(error.message || '').trim() || null,
  };
}

function annotatePodcastSynthesis(synthesis = {}, details = {}) {
  const actualProvider = String(synthesis.provider || synthesis.voice?.provider || '').trim() || null;
  const actualVoiceId = String(synthesis.voice?.id || '').trim() || null;
  const requestedProvider = String(details.requestedProvider || '').trim() || null;
  const requestedVoiceId = String(details.requestedVoiceId || '').trim() || null;
  const providerFallback = synthesis.fallback?.providerFallback === true
    || Boolean(requestedProvider && actualProvider && actualProvider !== requestedProvider);

  return {
    ...synthesis,
    podcastSynthesis: {
      speaker: String(details.speaker || '').trim() || null,
      requestedProvider,
      requestedVoiceId,
      actualProvider,
      actualVoiceId,
      providerFallback,
      providerFallbackAllowed: details.providerFallbackAllowed === true,
      fallbackReason: synthesis.fallback?.reason || null,
      voiceFallback: details.voiceFallback === true,
      voiceFallbackReason: details.voiceFallbackReason || null,
      splitDepth: Number(details.splitDepth) || 0,
      textLength: Number(details.textLength) || 0,
    },
  };
}

function hasExplicitHostConfig(params = {}) {
  return ['A', 'B'].some((suffix) => (
    String(params[`host${suffix}Name`] || '').trim()
    || String(params[`host${suffix}Role`] || '').trim()
    || String(params[`host${suffix}Persona`] || '').trim()
    || String(params[`host${suffix}VoiceId`] || '').trim()
    || normalizeStringList(params[`host${suffix}VoiceIds`]).length > 0
  ));
}

function selectDefaultHostTemplates(params = {}) {
  if (hasExplicitHostConfig(params)) {
    return LEGACY_DEFAULT_HOSTS;
  }

  const leadHosts = DEFAULT_HOST_ROSTER.filter((host) => host.role === 'Lead host');
  const coHosts = DEFAULT_HOST_ROSTER.filter((host) => host.role !== 'Lead host');
  if (leadHosts.length === 0 || coHosts.length === 0) {
    return DEFAULT_HOST_ROSTER.slice(0, 2);
  }

  const seed = [
    params.topic,
    params.prompt,
    params.subject,
    params.audience,
    params.tone,
    Date.now(),
  ].filter(Boolean).join('|');
  const firstIndex = stableIndexFromText(seed, leadHosts.length);
  const secondIndex = stableIndexFromText(`${seed}|cohost`, coHosts.length);

  return [leadHosts[firstIndex], coHosts[secondIndex]];
}

function buildHostVoicePool(availableVoices = [], preferredVoiceIds = [], explicitVoiceIds = [], forcedVoiceId = '') {
  const availableVoiceIds = new Set(
    (Array.isArray(availableVoices) ? availableVoices : [])
      .filter((voice) => isPodcastFemaleVoice(voice))
      .map((voice) => (voice && typeof voice === 'object' ? String(voice.id || '').trim() : ''))
      .filter(Boolean),
  );
  if (availableVoiceIds.size === 0) {
    return [];
  }

  const forced = String(forcedVoiceId || '').trim();
  const preferred = uniqueOrdered(preferredVoiceIds);
  const explicit = uniqueOrdered(normalizeStringList(explicitVoiceIds));
  const requested = uniqueOrdered([
    forced,
    ...explicit,
    ...preferred,
  ]).filter(Boolean);

  const validRequested = requested
    .filter((voiceId) => isPodcastFemaleVoiceId(voiceId))
    .filter((voiceId) => availableVoiceIds.has(voiceId));
  if (validRequested.length > 0) {
    return validRequested;
  }

  return resolveHighQualityVoicePool(availableVoiceIds, preferredVoiceIds);
}

function sanitizePodcastText(value = '', { preserveNewlines = false } = {}) {
  const base = stripUnpairedSurrogates(stripNullCharacters(value || ''))
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');

  let normalized = '';
  try {
    normalized = base.normalize('NFKC');
  } catch (_error) {
    normalized = base;
  }

  const whitespaceNormalized = preserveNewlines
    ? normalizeWhitespace(normalized).replace(/\n{3,}/g, '\n\n')
    : normalized.replace(/\s+/g, ' ').trim();

  return whitespaceNormalized.trim();
}

function truncatePodcastSourceText(value = '', maxChars = MAX_PODCAST_SOURCE_EXCERPT_CHARS) {
  const limit = Math.max(80, Number(maxChars) || MAX_PODCAST_SOURCE_EXCERPT_CHARS);
  const normalized = sanitizePodcastText(value, { preserveNewlines: true });
  if (normalized.length <= limit) {
    return normalized;
  }

  const truncated = normalized
    .slice(0, limit)
    .replace(/\s+\S*$/, '')
    .trim();
  return `${truncated} ...`;
}

function looksLikeAccessDeniedContent(value = '') {
  const normalized = sanitizePodcastText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return false;
  }

  return normalized.includes('access denied')
    && (
      normalized.includes("you don't have permission to access")
      || normalized.includes('you do not have permission to access')
      || normalized.includes('reference #')
      || normalized.includes('errors.edgesuite.net')
    );
}

function estimateWordBudget(durationMinutes = DEFAULT_DURATION_MINUTES) {
  return Math.round(durationMinutes * DEFAULT_TARGET_WPM);
}

function estimateTurnCount(durationMinutes = DEFAULT_DURATION_MINUTES) {
  return Math.max(12, Math.min(22, Math.round(durationMinutes * 1.7)));
}

function normalizeVariantFilename(filename = '', extension = 'wav') {
  const normalizedFilename = String(filename || '').trim();
  const normalizedExtension = String(extension || '').trim().replace(/^\./, '').toLowerCase() || 'wav';
  if (!normalizedFilename) {
    return '';
  }

  if (/\.[a-z0-9]+$/i.test(normalizedFilename)) {
    return normalizedFilename.replace(/\.[a-z0-9]+$/i, `.${normalizedExtension}`);
  }

  return `${normalizedFilename}.${normalizedExtension}`;
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function createConcurrencyLimiter(maxConcurrency = 1) {
  const limit = Math.max(1, Number(maxConcurrency) || 1);
  const queue = [];
  let active = 0;

  async function acquire() {
    if (active < limit) {
      active += 1;
      return;
    }

    await new Promise((resolve) => queue.push(resolve));
  }

  function release() {
    if (queue.length > 0) {
      const next = queue.shift();
      next();
      return;
    }

    active = Math.max(0, active - 1);
  }

  return {
    async run(task) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

async function mapWithConcurrency(items = [], maxConcurrency = 1, mapper = async (value) => value) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return [];
  }

  const concurrency = Math.max(1, Math.min(list.length, Number(maxConcurrency) || 1));
  const results = new Array(list.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= list.length) {
        return;
      }

      results[currentIndex] = await mapper(list[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function prefersMp3(params = {}) {
  if (params.exportMp3 === true) {
    return true;
  }

  const outputFormat = String(params.outputFormat || params.format || '').trim().toLowerCase();
  return outputFormat === 'mp3';
}

function requestedMixing(params = {}) {
  return params.includeIntro === true
    || params.includeOutro === true
    || params.includeMusicBed === true
    || Boolean(String(params.introPath || '').trim())
    || Boolean(String(params.outroPath || '').trim())
    || Boolean(String(params.musicBedPath || '').trim());
}

function shouldUsePodcastMusicBed(params = {}, audioProcessingConfig = null) {
  if (params.includeMusicBed === false) {
    return false;
  }

  return params.includeMusicBed === true
    && (
      Boolean(String(params.musicBedPath || '').trim())
      || audioProcessingConfig?.defaults?.musicBedPathConfigured === true
      || audioProcessingConfig?.configured === true
    );
}

function shouldUseVoiceOnlyAudio(params = {}) {
  if (params.voiceOnlyAudio === false
    || params.speakerOnlyAudio === false
    || params.voiceOnly === false) {
    return false;
  }

  return true;
}

function uniqueUrls(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const url = String(item?.url || '').trim();
    if (!url || seen.has(url)) {
      return false;
    }
    seen.add(url);
    return true;
  });
}

function normalizePodcastSourceDocuments(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((source, index) => {
      const content = sanitizePodcastText(source?.content || source?.text || source?.excerpt || '', { preserveNewlines: true });
      const snippet = truncatePodcastSourceText(source?.snippet || source?.summary || content, MAX_PODCAST_SOURCE_SNIPPET_CHARS);
      const title = sanitizePodcastText(source?.title || source?.filename || `Uploaded source ${index + 1}`);
      const url = sanitizePodcastText(source?.url || source?.artifactId || `uploaded-source-${index + 1}`);
      if (!content && !snippet) {
        return null;
      }

      return {
        title: title || `Uploaded source ${index + 1}`,
        url: url.startsWith('artifact:') || url.startsWith('session-artifacts:') || /^https?:\/\//i.test(url)
          ? url
          : `artifact:${url}`,
        snippet,
        content,
        excerptMaxChars: MAX_PODCAST_ARTIFACT_SOURCE_CHARS,
      };
    })
    .filter(Boolean);
}

function normalizePodcastArtifactIds(params = {}, context = {}) {
  return uniqueOrdered([
    ...(Array.isArray(params.artifactIds) ? params.artifactIds : []),
    ...(Array.isArray(params.sourceArtifactIds) ? params.sourceArtifactIds : []),
    ...(Array.isArray(context.artifactIds) ? context.artifactIds : []),
  ].map((artifactId) => String(artifactId || '').trim()).filter(Boolean));
}

function resolvePodcastScriptModelCandidates(params = {}, context = {}) {
  const requestedModel = String(params?.model || '').trim();
  const actionModel = String(
    context?.model
    || context?.toolContext?.model
    || context?.metadata?.model
    || '',
  ).trim();
  const defaultModel = String(settingsController?.settings?.models?.defaultModel || '').trim();
  const fallbackModel = String(settingsController?.settings?.models?.fallbackModel || '').trim();
  const configuredModel = String(config.openai?.model || '').trim();
  const normalizedRequestedModel = requestedModel.toLowerCase();
  const normalizedContextModel = actionModel.toLowerCase();
  const shouldIgnoreRequestedModel = Boolean(
    actionModel
      && requestedModel
      && normalizedRequestedModel !== normalizedContextModel,
  );

  return uniqueOrdered([
    actionModel,
    shouldIgnoreRequestedModel ? '' : requestedModel,
    defaultModel,
    configuredModel,
    fallbackModel,
  ].filter((model) => {
    const normalized = String(model || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (!UNSAFE_IMPLICIT_PODCAST_SCRIPT_MODELS.has(normalized)) {
      return true;
    }

    return requestedModel && !actionModel && normalized === normalizedRequestedModel;
  }));
}

function isTransientPodcastError(error = {}) {
  const message = String(error?.message || '').trim().toLowerCase();
  const code = String(error?.code || '').trim().toLowerCase();
  const statusCode = Number(error?.statusCode || error?.status || 0);

  if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
    return false;
  }

  if (statusCode >= 500 || statusCode === 408 || statusCode === 429) {
    return true;
  }

  return [
    'connection terminated unexpectedly',
    'terminated',
    'socket hang up',
    'fetch failed',
    'econnreset',
    'etimedout',
    'timed out',
    'eai_again',
    'temporarily unavailable',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
  ].some((pattern) => message.includes(pattern) || code.includes(pattern));
}

function isRetryablePodcastAudioError(error = {}) {
  const message = String(error?.message || '').trim().toLowerCase();
  const code = String(error?.code || '').trim().toLowerCase();
  const statusCode = Number(error?.statusCode || error?.status || 0);

  if (statusCode >= 400 && statusCode < 500) {
    return false;
  }

  if (['audio_asset_missing', 'audio_processing_invalid_input'].includes(code)) {
    return false;
  }

  if ([
    'no ffmpeg binary path is configured',
    'ffmpeg is missing at',
    'audio post-processing is unavailable',
    'podcast intro audio was not found at',
    'podcast outro audio was not found at',
    'podcast music bed audio was not found at',
  ].some((pattern) => message.includes(pattern))) {
    return false;
  }

  if (['audio_processing_timeout', 'audio_processing_unavailable'].includes(code)) {
    return true;
  }

  return [
    'timed out',
    'timeout',
    'resource temporarily unavailable',
    'temporarily unavailable',
    'device or resource busy',
    'connection reset',
    'broken pipe',
    'could not be started',
  ].some((pattern) => message.includes(pattern) || code.includes(pattern));
}

function isRetryablePodcastTtsError(error = {}) {
  const message = String(error?.message || '').trim().toLowerCase();
  const code = String(error?.code || '').trim().toLowerCase();
  const statusCode = Number(error?.statusCode || error?.status || 0);

  if (['empty_text', 'tts_unavailable', 'tts_binary_missing'].includes(code)) {
    return false;
  }

  if (statusCode >= 400 && statusCode < 500 && ![408, 429].includes(statusCode)) {
    return false;
  }

  if (['tts_timeout', 'tts_failed', 'tts_empty_audio'].includes(code)) {
    return true;
  }

  if (statusCode >= 500 || statusCode === 408 || statusCode === 429) {
    return true;
  }

  return [
    'timed out',
    'timeout',
    'terminated unexpectedly',
    'failed to generate audio',
    'returned an empty audio file',
    'resource temporarily unavailable',
    'temporarily unavailable',
    'device or resource busy',
    'connection reset',
    'broken pipe',
    'could not be started',
  ].some((pattern) => message.includes(pattern) || code.includes(pattern));
}

function canRetryPodcastTtsWithAnotherVoice(error = {}) {
  const code = String(error?.code || '').trim().toLowerCase();

  if (['empty_text', 'tts_unavailable', 'tts_binary_missing'].includes(code)) {
    return false;
  }

  return true;
}

function getResponseText(response = {}) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      const text = chunk?.text || chunk?.output_text || '';
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }
    }
  }

  return '';
}

function extractFetchedText(fetchData = {}, maxChars = MAX_PODCAST_SOURCE_EXCERPT_CHARS) {
  const body = sanitizePodcastText(fetchData?.body || '', { preserveNewlines: true });
  if (!body) {
    return '';
  }

  const contentType = String(fetchData?.headers?.['content-type'] || fetchData?.headers?.['Content-Type'] || '').toLowerCase();
  const plain = contentType.includes('html') ? stripHtml(body) : body;
  const normalized = sanitizePodcastText(plain, { preserveNewlines: true }).replace(/\n{2,}/g, '\n');
  if (looksLikeAccessDeniedContent(normalized)) {
    return '';
  }
  return truncatePodcastSourceText(normalized, maxChars);
}

function buildTranscript(turns = []) {
  return (Array.isArray(turns) ? turns : [])
    .map((turn) => `${sanitizePodcastText(turn.speaker)}: ${sanitizePodcastText(turn.text)}`)
    .join('\n\n')
    .trim();
}

function stripPodcastAudioCues(value = '') {
  return sanitizePodcastText(value, { preserveNewlines: true })
    .replace(/\[(?:music|theme|intro|outro|sfx|sound effects?|transition|stinger|applause|laughter|laughs|chuckles?|sighs?|pause|beat|ad break)[^\]]*\]/gi, ' ')
    .replace(/\((?:music|theme|intro|outro|sfx|sound effects?|transition|stinger|applause|laughter|laughs|chuckles?|sighs?|pause|beat|ad break)[^)]*\)/gi, ' ')
    .replace(/^\s*(?:music|theme|intro|outro|sfx|sound effects?|transition|stinger|applause|laughter|laughs|chuckles?|sighs?|pause|beat|ad break)\s*:.*$/gim, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeTurn(turn = {}, allowedSpeakers = new Set(), speakerAliases = new Map()) {
  const speaker = sanitizePodcastSpeakerLabel(turn?.speaker || '');
  const text = stripPodcastAudioCues(turn?.text || '');
  const resolvedSpeaker = resolvePodcastSpeaker(speaker, allowedSpeakers, speakerAliases);
  if (!resolvedSpeaker || !text || !allowedSpeakers.has(resolvedSpeaker)) {
    return null;
  }

  return { speaker: resolvedSpeaker, text };
}

function sanitizePodcastSpeakerLabel(value = '') {
  return sanitizePodcastText(value)
    .replace(/^\s*(?:speaker|host)\s*[:#-]\s*/i, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s*[:：]\s*$/g, '')
    .trim();
}

function normalizeSpeakerLookupKey(value = '') {
  return sanitizePodcastSpeakerLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolvePodcastSpeaker(speaker = '', allowedSpeakers = new Set(), speakerAliases = new Map()) {
  if (!speaker) {
    return '';
  }
  if (allowedSpeakers.has(speaker)) {
    return speaker;
  }

  const lookupKey = normalizeSpeakerLookupKey(speaker);
  for (const allowedSpeaker of allowedSpeakers) {
    if (normalizeSpeakerLookupKey(allowedSpeaker) === lookupKey) {
      return allowedSpeaker;
    }
  }

  return speakerAliases.get(speaker)
    || speakerAliases.get(lookupKey)
    || '';
}

function splitPodcastTurnText(text = '', targetPieces = 2) {
  const normalized = stripPodcastAudioCues(text);
  if (!normalized) {
    return [];
  }

  const sentenceParts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => sanitizePodcastText(part))
    .filter(Boolean);
  if (sentenceParts.length < 2 || targetPieces <= 1) {
    return [normalized];
  }

  const pieces = [];
  const chunkSize = Math.max(1, Math.ceil(sentenceParts.length / Math.max(1, targetPieces)));
  for (let index = 0; index < sentenceParts.length; index += chunkSize) {
    pieces.push(sentenceParts.slice(index, index + chunkSize).join(' ').trim());
  }

  return pieces.filter(Boolean);
}

function repairShortPodcastScriptTurns(turns = [], hosts = [], minimumTurns = DEFAULT_MINIMUM_VALID_TURNS) {
  const validTurns = (Array.isArray(turns) ? turns : []).filter((turn) => turn?.speaker && turn?.text);
  if (validTurns.length === 0) {
    return [];
  }

  const hostNames = hosts.map((host) => host.name).filter(Boolean);
  const representedSpeakers = new Set(validTurns.map((turn) => turn.speaker));
  if (!hostNames.every((hostName) => representedSpeakers.has(hostName))) {
    return validTurns;
  }

  const targetPieces = Math.max(1, Math.ceil(minimumTurns / Math.max(1, validTurns.length)));
  const repaired = validTurns.flatMap((turn) => (
    splitPodcastTurnText(turn.text, targetPieces).map((text) => ({
      speaker: turn.speaker,
      text,
    }))
  ));

  return repaired.length >= validTurns.length ? repaired : validTurns;
}

function pickPrimaryHostVoice(voiceIds = [], usedVoiceIds = new Set()) {
  const candidates = uniqueOrdered(
    (Array.isArray(voiceIds) ? voiceIds : [])
      .map((voiceId) => String(voiceId || '').trim())
      .filter(Boolean),
  );

  if (candidates.length === 0) {
    return '';
  }

  const firstUnused = candidates.find((voiceId) => !usedVoiceIds.has(voiceId));
  const selected = firstUnused || candidates[0];
  usedVoiceIds.add(selected);
  return selected;
}

function resolveHostVoiceForTurn(host = {}, turnIndex = 0, cycleHostVoices = true) {
  const voicePool = uniqueOrdered(
    [...(Array.isArray(host?.voiceIds) ? host.voiceIds : []), host?.voiceId]
      .map((voiceId) => String(voiceId || '').trim())
      .filter(Boolean),
  );

  if (!cycleHostVoices || voicePool.length <= 1) {
    return voicePool[0] || '';
  }

  return voicePool[turnIndex % voicePool.length];
}

function resolveTurnVoicePlan(turns = [], hosts = [], options = {}) {
  const cycleHostVoices = options?.cycleHostVoices === true;
  const hostByName = new Map((Array.isArray(hosts) ? hosts : []).map((host) => [host.name, host]));
  const hostTurnCounts = new Map();
  const turnPlans = [];

  for (const turn of Array.isArray(turns) ? turns : []) {
    const host = hostByName.get(turn.speaker);
    if (!host) {
      throw new Error(`No TTS voice is configured for speaker "${turn.speaker}".`);
    }

    const turnIndex = Number(hostTurnCounts.get(turn.speaker) || 0);
    const requestedTurnVoiceId = String(turn?.voiceId || '').trim();
    const voiceId = requestedTurnVoiceId || resolveHostVoiceForTurn(host, turnIndex, cycleHostVoices);
    hostTurnCounts.set(turn.speaker, turnIndex + 1);

    turnPlans.push({
      speaker: turn.speaker,
      text: turn.text,
      voiceId,
      host,
      voiceIds: Array.isArray(host?.voiceIds) ? host.voiceIds.slice() : [],
    });
  }

  return {
    plans: turnPlans,
  };
}

function resolvePodcastHostCount(params = {}) {
  const requested = Number(params.hostCount || params.speakerCount || params.hosts || params.speakers || 0);
  if (Number.isFinite(requested) && requested >= 1) {
    return Math.max(1, Math.min(2, Math.round(requested)));
  }
  return 2;
}

function resolveHosts(params = {}, voiceConfig = {}) {
  const availableVoices = Array.isArray(voiceConfig?.voices) ? voiceConfig.voices : [];
  const usedVoiceIds = new Set();
  const hostTemplates = selectDefaultHostTemplates(params);
  const hostCount = resolvePodcastHostCount(params);
  const explicitARequested = Boolean(
    String(params.hostAVoiceId || '').trim() || params.hostAVoiceIds?.length,
  );
  const explicitBRequested = Boolean(
    String(params.hostBVoiceId || '').trim() || params.hostBVoiceIds?.length,
  );

  const hosts = hostTemplates.slice(0, hostCount).map((defaultHost, index) => {
    const suffix = index === 0 ? 'A' : 'B';
    const providedVoiceId = String(params[`host${suffix}VoiceId`] || '').trim();
    const requestedVoiceIds = normalizeStringList(params[`host${suffix}VoiceIds`]);
    const voiceIds = buildHostVoicePool(
      availableVoices,
      defaultHost.preferredVoiceIds,
      requestedVoiceIds,
      providedVoiceId,
    );

    const configuredVoiceIds = uniqueOrdered([
      ...voiceIds,
      ...(voiceIds.length === 0 ? [
        String(providedVoiceId || '').trim(),
        String(voiceConfig?.defaultVoiceId || '').trim(),
      ] : []),
    ])
      .filter(Boolean)
      .filter((voiceId) => isPodcastFemaleVoiceId(voiceId));
    const voiceId = pickPrimaryHostVoice(configuredVoiceIds, usedVoiceIds);

    const fullVoicePool = uniqueOrdered(
      [voiceId, ...configuredVoiceIds]
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    );

    return {
      name: sanitizePodcastText(params[`host${suffix}Name`] || defaultHost.name) || defaultHost.name,
      role: sanitizePodcastText(params[`host${suffix}Role`] || (hostCount === 1 ? 'Solo host' : defaultHost.role))
        || (hostCount === 1 ? 'Solo host' : defaultHost.role),
      persona: sanitizePodcastText(params[`host${suffix}Persona`] || defaultHost.persona) || defaultHost.persona,
      voiceIds: fullVoicePool,
      voiceId,
    };
  });

  if (!explicitARequested && !explicitBRequested && hosts.length >= 2) {
    const hostAVoices = hosts[0].voiceIds;
    const hostBVoices = hosts[1].voiceIds;
    if (hostAVoices.length > 1 && hostBVoices.length > 1
      && hostAVoices.join('|') === hostBVoices.join('|')) {
      hosts[1].voiceIds = hostBVoices.slice(1).concat(hostBVoices.slice(0, 1));
    }
  }

  return hosts;
}

function resolvePodcastTtsTimeoutMs(params = {}, voiceConfig = {}) {
  const configuredTimeoutMs = Math.max(
    1000,
    Number(voiceConfig?.podcastTimeoutMs)
      || Number(voiceConfig?.timeoutMs)
      || 45000,
  );

  return clampNumber(params.ttsTimeoutMs, 1000, 15 * 60 * 1000, configuredTimeoutMs);
}

function resolvePodcastChunkMaxChars(params = {}, voiceConfig = {}) {
  const maxTextChars = Math.max(200, Number(voiceConfig?.maxTextChars) || 2400);
  const safeMaxChunkChars = Math.max(250, maxTextChars - 160);
  const configuredChunkChars = clampNumber(
    voiceConfig?.podcastChunkChars,
    250,
    safeMaxChunkChars,
    Math.min(900, safeMaxChunkChars),
  );

  return clampNumber(params.ttsChunkMaxChars, 250, safeMaxChunkChars, configuredChunkChars);
}

function resolvePodcastScriptRequestTimeoutMs(params = {}) {
  return clampNumber(
    params.scriptTimeoutMs,
    30000,
    900000,
    DEFAULT_PODCAST_SCRIPT_REQUEST_TIMEOUT_MS,
  );
}

function resolvePodcastResearchConcurrency(params = {}) {
  return clampNumber(
    params.researchConcurrency,
    1,
    MAX_PODCAST_RESEARCH_CONCURRENCY,
    DEFAULT_PODCAST_RESEARCH_CONCURRENCY,
  );
}

function resolvePodcastTtsConcurrency(params = {}) {
  return clampNumber(
    params.ttsConcurrency,
    1,
    MAX_PODCAST_TTS_CONCURRENCY,
    DEFAULT_PODCAST_TTS_CONCURRENCY,
  );
}

function buildResearchPrompt({
  topic,
  requestBrief,
  audience,
  tone,
  detailLevel = '',
  scriptDesign = null,
  scriptDesignExample = '',
  durationMinutes,
  hosts,
  sources,
  videoFormat = false,
}) {
  const wordBudget = estimateWordBudget(durationMinutes);
  const turnCount = estimateTurnCount(durationMinutes);
  const hostList = Array.isArray(hosts) ? hosts.filter(Boolean) : [];
  const isSoloHost = hostList.length === 1;
  const hostSections = hostList.map((host, index) => [
    `Host ${index + 1}:`,
    `- name: ${sanitizePodcastText(host.name)}`,
    `- role: ${sanitizePodcastText(host.role)}`,
    `- persona: ${sanitizePodcastText(host.persona)}`,
  ].join('\n')).join('\n\n');
  const exampleTurns = hostList.map((host) => (
    `    { "speaker": "${sanitizePodcastText(host.name)}", "text": "string" }`
  )).join(',\n');
  const design = scriptDesign && typeof scriptDesign === 'object' ? scriptDesign : null;
  const designSection = design ? [
    'Script presentation design:',
    `- selected: ${sanitizePodcastText(design.label || design.id || 'Custom')}`,
    `- shape: ${sanitizePodcastText(design.summary || '')}`,
    `- guidance: ${sanitizePodcastText(design.guidance || '')}`,
  ].filter(Boolean).join('\n') : '';
  const exampleSection = scriptDesignExample
    ? [
      'User-provided presentation example:',
      sanitizePodcastText(scriptDesignExample, { preserveNewlines: true }),
      'Use this as structural inspiration only. Do not copy its topic, facts, names, or repeated phrasing unless the user explicitly asked for that content.',
    ].join('\n')
    : '';

  const sourceText = sources.map((source, index) => [
    `Source ${index + 1}: ${sanitizePodcastText(source.title || 'Untitled source')}`,
    `URL: ${sanitizePodcastText(source.url)}`,
    source.snippet ? `Snippet: ${truncatePodcastSourceText(source.snippet, MAX_PODCAST_SOURCE_SNIPPET_CHARS)}` : '',
    source.content ? `Excerpt: ${truncatePodcastSourceText(
      source.content,
      Math.max(MAX_PODCAST_SOURCE_EXCERPT_CHARS, Number(source.excerptMaxChars) || MAX_PODCAST_SOURCE_EXCERPT_CHARS),
    )}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');

  return `
Create a scripted ${isSoloHost ? 'solo-host, one-speaker' : 'two-host'} podcast episode as strict JSON.

Topic: ${sanitizePodcastText(topic)}
${requestBrief ? `User request brief: ${sanitizePodcastText(requestBrief, { preserveNewlines: true })}` : ''}
Audience: ${sanitizePodcastText(audience)}
Tone: ${sanitizePodcastText(tone)}
${detailLevel ? `Detail level: ${sanitizePodcastText(detailLevel)}` : ''}
${designSection}
${exampleSection}
Target duration minutes: ${durationMinutes}
Approximate total word budget: ${wordBudget}
Target turn count: ${turnCount}

${hostSections}

Treat the user request brief as binding editorial direction, not just a search headline.
Preserve explicit format constraints, speaker count, angle, tone, named facts, required title or framing, and exclusions from the request brief.
Treat explicitly named facts in the request brief as user-provided source material and cover them as required beats; use fetched sources to verify and enrich them, not to replace them.
Use the topic mainly as a research query. Do not replace a detailed request with a generic beginner explainer unless the user asked for one.
Use only the sourced information below. Do not invent facts. If a point is uncertain, phrase it carefully.
${isSoloHost
    ? 'Write as a single host speaking directly to the listener. Do not introduce a co-host, second speaker, interview guest, or alternating dialogue.'
    : 'Write like a real podcast: light rapport, clean transitions, informative explanations, occasional reactions, but no filler overload.'}
Keep each turn to one paragraph. No stage directions. No markdown. No URLs in spoken text.
Open with a strong hook and end with a concise wrap-up.
${videoFormat ? 'Structure the episode like a YouTube information show: cold open hook, quick setup, evidence beats, why-it-matters sections, and a concrete final takeaway. Keep it conversational, but make each segment feel intentional and paced for viewers.' : ''}
Write for speech delivery, not for reading: use contractions, shorter sentences, and natural hand-offs.
Avoid stacked statistics, semicolons, parenthetical asides, and phrasing that sounds like a report being read aloud.
Spell out or rephrase awkward abbreviations and symbols so local TTS can read them smoothly.
Do not overuse self-referential process language. Avoid repeated phrases about dissecting, unpacking, breaking down, zooming out, weaving together, cadence, human rhythm, or why the hosts are talking a certain way.
Do not make the hosts explain their own conversational design, emotional stress point, or presentation strategy. Let the structure feel natural through the content.
Avoid repeating the same framing idea across multiple turns with only slightly different wording. Every turn must add a new fact, implication, question, contrast, or example.
Prefer proper full scripts over short outline-like exchanges: write enough complete turns to meet the word budget and make the episode feel finished.

Return exactly this JSON shape:
{
  "title": "string",
  "summary": "string",
  "turns": [
${exampleTurns}
  ]
}

Research:
${sourceText}
  `.trim();
}

function buildPodcastScriptInstructions(params = {}) {
  const baseInstructions = 'You write polished, factual, natural-sounding podcast scripts and must return valid JSON only.';
  const additionalSystemPrompt = sanitizePodcastText(
    params.systemPrompt || params.additionalSystemPrompt || params.customSystemPrompt || '',
    { preserveNewlines: true },
  );

  if (!additionalSystemPrompt) {
    return baseInstructions;
  }

  return [
    baseInstructions,
    'Additional user production instructions:',
    additionalSystemPrompt,
  ].join('\n\n');
}

class PodcastService {
  constructor(dependencies = {}) {
    this.createResponse = dependencies.createResponse || createResponse;
    this.ttsService = dependencies.ttsService || ttsService;
    this.persistGeneratedAudio = dependencies.persistGeneratedAudio || persistGeneratedAudio;
    this.updateGeneratedAudioSessionState = dependencies.updateGeneratedAudioSessionState || updateGeneratedAudioSessionState;
    this.audioProcessingService = dependencies.audioProcessingService || audioProcessingService;
    this.artifactService = dependencies.artifactService || artifactService;
  }

  async retryTransientOperation(operation, {
    label = 'podcast operation',
    retries = DEFAULT_TRANSIENT_RETRY_ATTEMPTS,
    retryDelayMs = DEFAULT_TRANSIENT_RETRY_DELAY_MS,
    shouldRetry = isTransientPodcastError,
  } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (typeof shouldRetry !== 'function' || !shouldRetry(error) || attempt >= retries) {
          throw error;
        }

        console.warn(`[PodcastService] Retrying ${label} after transient failure: ${error.message}`);
        await wait(Math.max(0, Number(retryDelayMs) || 0) * (attempt + 1));
      }
    }

    throw lastError || new Error(`${label} failed.`);
  }

  async runPodcastStage(stage, operation, details = {}) {
    try {
      return await operation();
    } catch (error) {
      logPodcastStageFailure(stage, error, details);
      throw annotatePodcastError(error, stage, details);
    }
  }

  async runTool(executeTool, toolId, params, context) {
    return this.retryTransientOperation(async () => {
      const result = await executeTool(toolId, params, context);
      if (!result?.success) {
        const error = new Error(result?.error || `${toolId} failed.`);
        if (result?.errorCode) {
          error.code = result.errorCode;
        }
        if (Number.isFinite(Number(result?.statusCode))) {
          error.statusCode = Number(result.statusCode);
        }
        throw error;
      }
      return result.data;
    }, {
      label: toolId,
    });
  }

  async researchTopic({
    topic,
    searchDomains = [],
    sourceUrls = [],
    sourceDocuments = [],
    maxSources = DEFAULT_MAX_SOURCES,
    concurrency = DEFAULT_PODCAST_RESEARCH_CONCURRENCY,
  }, context = {}) {
    const documentSources = normalizePodcastSourceDocuments(sourceDocuments);
    if (typeof context?.executeTool !== 'function') {
      if (documentSources.length > 0) {
        return documentSources.slice(0, maxSources);
      }
      throw new Error('Podcast research requires tool execution support.');
    }

    const seededSources = (Array.isArray(sourceUrls) ? sourceUrls : [])
      .map((url) => ({
        title: url,
        url: String(url || '').trim(),
        snippet: '',
      }))
      .filter((entry) => entry.url);

    let searchData = null;
    let searchError = null;
    try {
      searchData = await this.runTool(context.executeTool, 'web-search', {
        query: `${topic} explainer key facts overview`,
        engine: 'perplexity',
        researchMode: 'search',
        limit: Math.max(maxSources * 2, 6),
        timeout: DEFAULT_PODCAST_SEARCH_TIMEOUT_MS,
        includeSnippets: true,
        includeUrls: true,
        domains: searchDomains,
        region: 'us-en',
        timeRange: 'all',
      }, context.toolContext);
    } catch (error) {
      searchError = error;
      if (seededSources.length === 0 && documentSources.length === 0) {
        throw error;
      }
    }

    const candidates = uniqueUrls([
      ...seededSources,
      ...(Array.isArray(searchData?.verifiedPages) ? searchData.verifiedPages : []),
      ...(Array.isArray(searchData?.results) ? searchData.results : []),
      ...(Array.isArray(searchData?.citations) ? searchData.citations : []),
    ]).slice(0, maxSources);

    if (candidates.length === 0) {
      if (documentSources.length > 0) {
        return documentSources.slice(0, maxSources);
      }
      throw searchError || new Error('Podcast research did not return any usable sources.');
    }

    const verifiedSources = (await mapWithConcurrency(candidates, concurrency, async (candidate) => {
      const url = String(candidate?.url || '').trim();
      if (!url) {
        return null;
      }

      try {
        const fetched = await this.runTool(context.executeTool, 'web-fetch', {
          url,
          timeout: 20000,
          cache: true,
        }, context.toolContext);

        return {
          title: String(candidate?.title || url).trim() || url,
          url,
          snippet: truncatePodcastSourceText(candidate?.snippet || '', MAX_PODCAST_SOURCE_SNIPPET_CHARS),
          content: extractFetchedText(fetched),
        };
      } catch (_error) {
        return {
          title: String(candidate?.title || url).trim() || url,
          url,
          snippet: truncatePodcastSourceText(candidate?.snippet || '', MAX_PODCAST_SOURCE_SNIPPET_CHARS),
          content: '',
        };
      }
    })).filter(Boolean);

    if (verifiedSources.length === 0) {
      if (documentSources.length > 0) {
        return documentSources.slice(0, maxSources);
      }
      if (searchError) {
        throw searchError;
      }
      throw new Error('Podcast research did not return any usable sources.');
    }

    return uniqueUrls([
      ...documentSources,
      ...verifiedSources,
    ]).slice(0, maxSources);
  }

  async resolveArtifactSourceDocuments(params = {}, context = {}) {
    const sessionId = String(context?.sessionId || '').trim();
    const artifactIds = normalizePodcastArtifactIds(params, context);
    if (!sessionId || artifactIds.length === 0 || typeof this.artifactService?.buildPromptContext !== 'function') {
      return [];
    }

    try {
      const promptContext = await this.artifactService.buildPromptContext(sessionId, artifactIds);
      const content = sanitizePodcastText(promptContext, { preserveNewlines: true });
      if (!content) {
        return [];
      }

      return [{
        title: artifactIds.length === 1
          ? 'Selected uploaded file'
          : `Selected uploaded files (${artifactIds.length})`,
        url: `session-artifacts://${artifactIds.join(',')}`,
        snippet: 'User-selected uploaded files from this session.',
        content,
        excerptMaxChars: MAX_PODCAST_ARTIFACT_SOURCE_CHARS,
      }];
    } catch (error) {
      console.warn(`[PodcastService] Failed to load selected artifact context: ${error.message}`);
      return [];
    }
  }

  async generateScript({
    topic,
    requestBrief,
    audience,
    tone,
    detailLevel,
    scriptDesign,
    scriptDesignExample,
    durationMinutes,
    hosts,
    sources,
    models = [],
    reasoningEffort,
    requestTimeoutMs = DEFAULT_PODCAST_SCRIPT_REQUEST_TIMEOUT_MS,
    videoFormat = false,
    systemPrompt = '',
  }) {
    const modelCandidates = uniqueOrdered(Array.isArray(models) ? models : [models]);
    const prompt = buildResearchPrompt({
      topic,
      requestBrief,
      audience,
      tone,
      detailLevel,
      scriptDesign,
      scriptDesignExample,
      durationMinutes,
      hosts,
      sources,
      videoFormat,
    });
    const allowedSpeakers = new Set(hosts.map((host) => host.name));
    const speakerAliases = new Map([
      ['Maya', hosts[0]?.name],
      ['June', hosts[1]?.name],
      ['Host 1', hosts[0]?.name],
      ['Host 2', hosts[1]?.name],
      ['Host One', hosts[0]?.name],
      ['Host Two', hosts[1]?.name],
      ['Host A', hosts[0]?.name],
      ['Host B', hosts[1]?.name],
      ['Speaker 1', hosts[0]?.name],
      ['Speaker 2', hosts[1]?.name],
      ['Speaker A', hosts[0]?.name],
      ['Speaker B', hosts[1]?.name],
      ['Lead host', hosts[0]?.name],
      ['Co-host', hosts[1]?.name],
      ['Cohost', hosts[1]?.name],
    ].flatMap(([alias, mapped]) => (
      allowedSpeakers.has(mapped)
        ? [[alias, mapped], [normalizeSpeakerLookupKey(alias), mapped]]
        : []
    )));
    let lastError = null;

    for (const modelCandidate of (modelCandidates.length > 0 ? modelCandidates : [''])) {
      try {
        const response = await this.retryTransientOperation(() => this.createResponse({
          input: prompt,
          instructions: buildPodcastScriptInstructions({ systemPrompt }),
          stream: false,
          model: modelCandidate || undefined,
          reasoningEffort,
          enableAutomaticToolCalls: false,
          requestTimeoutMs,
          requestMaxRetries: 0,
        }), {
          label: 'podcast script generation',
          retries: DEFAULT_PODCAST_SCRIPT_RETRY_ATTEMPTS,
        });

        const parsed = parseLenientJson(getResponseText(response));
        let turns = (Array.isArray(parsed?.turns) ? parsed.turns : [])
          .map((turn) => normalizeTurn(turn, allowedSpeakers, speakerAliases))
          .filter(Boolean);
        turns = repairShortPodcastScriptTurns(turns, hosts, DEFAULT_MINIMUM_VALID_TURNS);
        const representedSpeakers = new Set(turns.map((turn) => turn.speaker));

        if (turns.length < DEFAULT_MINIMUM_VALID_TURNS || representedSpeakers.size < allowedSpeakers.size) {
          throw new Error('Podcast script generation returned too few valid turns.');
        }

        return {
          title: String(parsed?.title || `${topic} Podcast`).trim() || `${topic} Podcast`,
          summary: String(parsed?.summary || '').trim(),
          turns,
        };
      } catch (error) {
        lastError = error;
        if (modelCandidate && modelCandidates[modelCandidates.length - 1] !== modelCandidate) {
          console.warn(`[PodcastService] Falling back podcast script generation from model "${modelCandidate}" after: ${error.message}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error('Podcast script generation failed.');
  }

  async synthesizeChunkBuffer(text = '', host = {}, options = {}, splitDepth = 0) {
    const timeoutMs = Math.max(1000, Number(options.ttsTimeoutMs) || 45000);
    const minimumChunkChars = Math.max(250, Number(options.minimumChunkChars) || 350);
    const maxTextChars = Math.max(
      200,
      Number(options.maxTextChars)
        || Number(this.ttsService?.getPublicConfig?.().maxTextChars)
        || 2400,
    );
    const runSynthesis = typeof options.runSynthesis === 'function'
      ? options.runSynthesis
      : async (task) => task();
    const normalizedText = normalizePodcastTextChunkForSpeech(text, maxTextChars);
    if (!normalizedText) {
      return [];
    }
    const allowVoiceFallback = options.allowVoiceFallback === true;
    const allowProviderFallback = options.allowProviderFallback === true;
    const requestedProvider = String(options.requestedProvider || '').trim() || null;
    const candidateVoices = uniqueOrdered([
      options.voiceId,
      host?.voiceId,
      ...(allowVoiceFallback ? (Array.isArray(options.voiceIds) ? options.voiceIds : []) : []),
      ...(allowVoiceFallback ? (Array.isArray(host?.voiceIds) ? host.voiceIds : []) : []),
    ].filter(Boolean));
    const resolvedHostName = String(host?.name || '').trim() || 'podcast host';
    if (candidateVoices.length === 0) {
      throw new Error(`No TTS voice is configured for speaker "${resolvedHostName}".`);
    }

    const maxVoiceAttempts = Math.max(
      1,
      Math.min(candidateVoices.length, DEFAULT_MAX_VOICE_FALLBACK_ATTEMPTS),
    );
    const preferredVoiceOffset = Math.max(0, Number(options.voiceAttemptOffset) || 0);
    let lastError = null;

    for (let attempt = 0; attempt < maxVoiceAttempts; attempt += 1) {
      const voiceId = candidateVoices[(preferredVoiceOffset + attempt) % candidateVoices.length];
      try {
        const synthesis = await runSynthesis(() => this.ttsService.synthesize({
          text: normalizedText,
          voiceId,
          timeoutMs,
          allowProviderFallback,
        }));
        return [annotatePodcastSynthesis(synthesis, {
          speaker: resolvedHostName,
          requestedProvider,
          requestedVoiceId: voiceId,
          providerFallbackAllowed: allowProviderFallback,
          voiceFallback: attempt > 0,
          voiceFallbackReason: attempt > 0 ? summarizeTtsError(lastError) : null,
          splitDepth,
          textLength: normalizedText.length,
        })];
      } catch (error) {
        lastError = error;
        const hasMoreVoiceFallbacks = attempt < (maxVoiceAttempts - 1);
        if (hasMoreVoiceFallbacks && canRetryPodcastTtsWithAnotherVoice(error)) {
          continue;
        }
        break;
      }
    }

    if (!lastError) {
      throw new Error('Podcast TTS failed before audio generation could start.');
    }

    if (!isRetryablePodcastTtsError(lastError)
      || splitDepth >= MAX_PODCAST_TTS_SPLIT_DEPTH
      || normalizedText.length <= minimumChunkChars) {
      throw lastError;
    }

    const nextChunkSize = Math.max(minimumChunkChars, Math.floor(normalizedText.length / 2));
    if (nextChunkSize >= normalizedText.length) {
      throw lastError;
    }

    const retryChunks = chunkText(normalizedText, nextChunkSize)
      .map((retryChunk) => normalizePodcastTextChunkForSpeech(retryChunk, maxTextChars))
      .filter(Boolean);
    if (retryChunks.length <= 1) {
      throw lastError;
    }

    const fallbackOffset = (preferredVoiceOffset + 1) % candidateVoices.length;
    const nestedSyntheses = await mapWithConcurrency(
      retryChunks,
      retryChunks.length,
      async (retryChunk) => this.synthesizeChunkBuffer(
        retryChunk,
        host,
        {
          ...options,
          voiceAttemptOffset: fallbackOffset,
          voiceIds: candidateVoices,
          allowVoiceFallback,
          allowProviderFallback,
          requestedProvider,
          maxTextChars,
          minimumChunkChars,
        },
        splitDepth + 1,
      ),
    );

    return nestedSyntheses.flat();
  }

  buildSynthesisSegments(turns = [], hosts = [], options = {}) {
    const maxTextChars = Math.max(200, Number(this.ttsService?.getPublicConfig?.().maxTextChars) || 2400);
    const cycleHostVoices = options?.cycleHostVoices === true;
    const chunkMaxChars = clampNumber(
      options.chunkMaxChars,
      250,
      Math.max(250, maxTextChars - 160),
      Math.min(900, Math.max(250, maxTextChars - 160)),
    );
    const minimumChunkChars = clampNumber(
      options.minimumChunkChars,
      250,
      chunkMaxChars,
      Math.max(350, Math.floor(chunkMaxChars / 2)),
    );
    const hostByName = new Map(hosts.map((host) => [host.name, host]));
    const hostTurnCounts = new Map();
    const segments = [];

    for (const turn of turns) {
      const host = hostByName.get(turn.speaker);
      const turnVoiceId = String(turn?.voiceId || '').trim();
      const turnIndex = Number(hostTurnCounts.get(turn.speaker) || 0);
      const resolvedVoiceId = turnVoiceId
        || resolveHostVoiceForTurn(host, turnIndex, cycleHostVoices)
        || host?.voiceId
        || '';
      hostTurnCounts.set(turn.speaker, turnIndex + 1);

      if (!resolvedVoiceId) {
        throw new Error(`No TTS voice is configured for speaker "${turn.speaker}".`);
      }

      const hostForTurn = {
        ...(host || {}),
        voiceId: resolvedVoiceId,
      };
      const chunks = chunkText(turn.text, chunkMaxChars);
      for (const chunk of chunks) {
        const normalizedChunk = normalizePodcastTextChunkForSpeech(chunk, maxTextChars);
        if (!normalizedChunk) {
          continue;
        }
        segments.push({
          speaker: turn.speaker,
          text: normalizedChunk,
          host: hostForTurn,
          voiceId: resolvedVoiceId,
          voiceIds: Array.isArray(hostForTurn.voiceIds) ? hostForTurn.voiceIds : [],
          minimumChunkChars,
        });
      }
    }

    return segments;
  }

  async synthesizeTurns(turns = [], hosts = [], options = {}) {
    const silenceMs = clampNumber(options.silenceMs, 100, 1200, DEFAULT_SILENCE_MS);
    const ttsConcurrency = clampNumber(
      options.ttsConcurrency,
      1,
      MAX_PODCAST_TTS_CONCURRENCY,
      DEFAULT_PODCAST_TTS_CONCURRENCY,
    );
    const synthesisSegments = this.buildSynthesisSegments(turns, hosts, options);
    const requestedProvider = String(this.ttsService?.getPublicConfig?.().provider || '').trim() || null;
    const limiter = createConcurrencyLimiter(ttsConcurrency);
    const synthesizedSegments = await mapWithConcurrency(
      synthesisSegments,
      ttsConcurrency,
      async (segment) => this.synthesizeChunkBuffer(segment.text, segment.host, {
        voiceId: segment.voiceId,
        voiceIds: segment.voiceIds,
        ttsTimeoutMs: options.ttsTimeoutMs,
        allowVoiceFallback: options.allowVoiceFallback === true,
        allowProviderFallback: options.allowProviderFallback === true,
        requestedProvider,
        maxTextChars: Number(this.ttsService?.getPublicConfig?.().maxTextChars) || 2400,
        minimumChunkChars: segment.minimumChunkChars,
        runSynthesis: (task) => limiter.run(task),
      }),
    );

    const orderedSyntheses = synthesizedSegments.flat();
    if (orderedSyntheses.length === 0) {
      throw new Error('Podcast script did not produce any speakable audio.');
    }

    let outputFormat = null;
    const wavBuffers = [];
    orderedSyntheses.forEach((synthesis, index) => {
      const parsedSynthesisBuffer = parseWavBuffer(synthesis.audioBuffer, { allowNonPcm: true });
      if (!outputFormat) {
        outputFormat = {
          ...parsedSynthesisBuffer,
          audioFormat: 1,
          bitsPerSample: 16,
        };
      }

      const normalizedAudioBuffer = wavFormatsMatch(parsedSynthesisBuffer, outputFormat)
        ? synthesis.audioBuffer
        : normalizeWavBufferFormat(synthesis.audioBuffer, outputFormat);

      wavBuffers.push(applyWavEdgeFade(normalizedAudioBuffer, 8, { fadeOut: false }));
      if (index < orderedSyntheses.length - 1) {
        wavBuffers.push(createSilenceWavBuffer(outputFormat, silenceMs));
      }
    });

    wavBuffers.push(createSilenceWavBuffer(outputFormat, DEFAULT_FINAL_TAIL_SILENCE_MS));

    const audioBuffer = concatWavBuffers(wavBuffers);
    if (options.returnDiagnostics === true) {
      return {
        audioBuffer,
        synthesisDiagnostics: orderedSyntheses.map((synthesis, index) => ({
          segmentIndex: index,
          ...(synthesis.podcastSynthesis || {}),
        })),
      };
    }

    return audioBuffer;
  }

  async createPodcast(params = {}, context = {}) {
    const sessionId = String(context?.sessionId || '').trim();
    if (!sessionId) {
      throw new Error('podcast requires an active session so the audio can be saved.');
    }

    const topic = String(params.topic || params.prompt || params.subject || '').trim();
    const normalizedTopic = sanitizePodcastText(topic);
    if (!normalizedTopic) {
      throw new Error('podcast requires a topic, prompt, or subject.');
    }
    const requestBrief = sanitizePodcastText(
      params.requestBrief || params.originalPrompt || params.prompt || '',
      { preserveNewlines: true },
    );

    const durationMinutes = clampNumber(params.durationMinutes, 3, 30, DEFAULT_DURATION_MINUTES);
    const audience = sanitizePodcastText(params.audience || 'general') || 'general';
    const tone = sanitizePodcastText(params.tone || 'informative, conversational') || 'informative, conversational';
    const detailLevel = sanitizePodcastText(params.detailLevel || '') || '';
    const scriptDesign = resolvePodcastScriptDesign(params.scriptDesign || params.scriptStyle || params.presentationDesign);
    const scriptDesignExample = sanitizePodcastText(
      params.scriptDesignExample || params.presentationExample || '',
      { preserveNewlines: true },
    );
    const maxSources = clampNumber(params.maxSources, 2, 6, DEFAULT_MAX_SOURCES);
    const voiceConfig = this.ttsService.getPublicConfig();
    const synthesisProvider = String(voiceConfig.provider || 'tts').trim() || 'tts';
    const hosts = resolveHosts(params, voiceConfig);
    const podcastTtsTimeoutMs = resolvePodcastTtsTimeoutMs(params, voiceConfig);
    const podcastChunkMaxChars = resolvePodcastChunkMaxChars(params, voiceConfig);
    const podcastScriptRequestTimeoutMs = resolvePodcastScriptRequestTimeoutMs(params);
    const podcastResearchConcurrency = resolvePodcastResearchConcurrency(params);
    const podcastTtsConcurrency = resolvePodcastTtsConcurrency(params);
    const executeTool = typeof context?.toolManager?.executeTool === 'function'
      ? context.toolManager.executeTool.bind(context.toolManager)
      : null;
    const sourceDocuments = [
      ...normalizePodcastSourceDocuments(params.sourceDocuments || params.sources || []),
      ...await this.runPodcastStage('artifact-context', () => this.resolveArtifactSourceDocuments(params, context), {
        sessionId,
        topic: normalizedTopic,
      }),
    ];
    const sources = await this.runPodcastStage('research', () => this.researchTopic({
      topic: normalizedTopic,
      searchDomains: params.searchDomains || params.domains || [],
      sourceUrls: params.sourceUrls || params.urls || [],
      sourceDocuments,
      maxSources,
      concurrency: podcastResearchConcurrency,
    }, {
      executeTool,
      toolContext: context,
    }), {
      sessionId,
      topic: normalizedTopic,
      researchConcurrency: podcastResearchConcurrency,
      sourceCount: sourceDocuments.length,
    });

    const script = await this.runPodcastStage('script-generation', () => this.generateScript({
      topic: normalizedTopic,
      requestBrief,
      audience,
      tone,
      detailLevel,
      scriptDesign,
      scriptDesignExample,
      durationMinutes,
      hosts,
      sources,
      models: resolvePodcastScriptModelCandidates(params, context),
      reasoningEffort: params.reasoningEffort || context.reasoningEffort || undefined,
      requestTimeoutMs: podcastScriptRequestTimeoutMs,
      videoFormat: params.includeVideo === true,
      systemPrompt: params.systemPrompt || params.additionalSystemPrompt || params.customSystemPrompt || '',
    }), {
      sessionId,
      topic: normalizedTopic,
      durationMinutes,
      includeVideo: params.includeVideo === true,
      sourceCount: sources.length,
      hostCount: hosts.length,
      model: resolvePodcastScriptModelCandidates(params, context)[0] || '',
    });
    const turnVoicePlan = resolveTurnVoicePlan(script.turns, hosts, {
      cycleHostVoices: params.cycleHostVoices === true,
    });
    const transcript = buildTranscript(script.turns);
    const wantsMp3 = prefersMp3(params);
    const audioProcessingConfig = this.audioProcessingService?.getPublicConfig?.() || null;
    const voiceOnlyAudio = shouldUseVoiceOnlyAudio(params);
    const useMusicBed = !voiceOnlyAudio && shouldUsePodcastMusicBed(params, audioProcessingConfig);
    const wantsMixing = !voiceOnlyAudio && (requestedMixing(params) || useMusicBed);
    const defaultEnhanceSpeech = false;
    const wantsEnhancement = params.enhanceSpeech === false
      ? false
      : params.enhanceSpeech === true
        ? audioProcessingConfig?.configured === true
        : (!voiceOnlyAudio && defaultEnhanceSpeech);

    // Validate TTS compatibility before starting the full run.
    script.turns.forEach((turn) => {
      normalizeTextForSpeech(turn.text, Math.max(200, Number(voiceConfig.maxTextChars) || 2400));
    });

    const cycleHostVoices = params.cycleHostVoices === true || (
      params.includeVideo === true && params.cycleHostVoices !== false
    );
    const allowVoiceFallback = params.allowVoiceFallback !== false;
    const allowProviderFallback = params.allowProviderFallback === true
      || params.allowTtsProviderFallback === true;
    const speechSynthesisResult = await this.runPodcastStage('tts-synthesis', () => this.synthesizeTurns(
      turnVoicePlan.plans,
      hosts,
      {
        silenceMs: clampNumber(params.pauseMs, 100, 1200, DEFAULT_SILENCE_MS),
        ttsTimeoutMs: podcastTtsTimeoutMs,
        chunkMaxChars: podcastChunkMaxChars,
        ttsConcurrency: podcastTtsConcurrency,
        cycleHostVoices,
        allowVoiceFallback,
        allowProviderFallback,
        returnDiagnostics: true,
      },
    ), {
      sessionId,
      topic: normalizedTopic,
      turnCount: turnVoicePlan.plans.length,
      hostCount: hosts.length,
      ttsProvider: synthesisProvider,
      ttsConcurrency: podcastTtsConcurrency,
      ttsTimeoutMs: podcastTtsTimeoutMs,
      ttsChunkMaxChars: podcastChunkMaxChars,
    });
    const speechWavBuffer = speechSynthesisResult.audioBuffer;
    const synthesisDiagnostics = Array.isArray(speechSynthesisResult.synthesisDiagnostics)
      ? speechSynthesisResult.synthesisDiagnostics
      : [];
    const actualTurnVoices = synthesisDiagnostics.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      speaker: segment.speaker,
      requestedProvider: segment.requestedProvider,
      requestedVoiceId: segment.requestedVoiceId,
      actualProvider: segment.actualProvider,
      actualVoiceId: segment.actualVoiceId,
      providerFallback: segment.providerFallback,
      providerFallbackAllowed: segment.providerFallbackAllowed,
      voiceFallback: segment.voiceFallback,
      fallbackReason: segment.fallbackReason,
    }));
    const finalAudioBuffer = (wantsMixing || wantsEnhancement)
      ? await this.runPodcastStage('audio-post-processing', () => this.retryTransientOperation(
        () => this.audioProcessingService.composePodcastAudio({
          speechWavBuffer,
          includeIntro: params.includeIntro === true,
          includeOutro: params.includeOutro === true,
          includeMusicBed: useMusicBed,
          enhanceSpeech: wantsEnhancement,
          introPath: params.introPath || '',
          outroPath: params.outroPath || '',
          musicBedPath: params.musicBedPath || '',
          speechVolume: params.speechVolume,
          musicVolume: params.musicVolume,
          introVolume: params.introVolume,
          outroVolume: params.outroVolume,
        }),
        {
          label: 'podcast audio post-processing',
          retries: DEFAULT_AUDIO_PROCESSING_RETRY_ATTEMPTS,
          retryDelayMs: 900,
          shouldRetry: isRetryablePodcastAudioError,
        },
      ), {
        sessionId,
        topic: normalizedTopic,
        mixed: wantsMixing,
        enhanced: wantsEnhancement,
        musicBedApplied: useMusicBed,
      })
      : speechWavBuffer;
    const episodeTitle = sanitizePodcastText(params.title || script.title || `${normalizedTopic} Podcast`);
    const persistedArtifacts = [];
    const audioVariants = [];

    const persistedWav = await this.runPodcastStage('persist-wav', () => this.persistGeneratedAudio({
      sessionId,
      sourceMode: String(context?.clientSurface || context?.taskType || 'chat').trim() || 'chat',
      text: transcript,
      title: episodeTitle,
      filename: normalizeVariantFilename(params.filename || '', 'wav'),
      provider: synthesisProvider,
      voice: {
        provider: synthesisProvider,
        episodeVoices: hosts.map((host) => ({
          speaker: host.name,
          voiceId: host.voiceId,
        })),
      },
      audioBuffer: finalAudioBuffer,
      mimeType: 'audio/wav',
      metadata: {
        createdByAgentTool: true,
        generatedBy: 'podcast',
        topic: normalizedTopic,
        durationMinutes,
        audience,
        tone,
        detailLevel,
        scriptDesign: scriptDesign ? scriptDesign.id : null,
        scriptDesignLabel: scriptDesign ? scriptDesign.label : null,
        scriptDesignExample,
        requestBrief,
        turnVoices: turnVoicePlan.plans.map((turn) => ({
          speaker: turn.speaker,
          voiceId: turn.voiceId,
        })),
        actualTurnVoices,
        ttsSegments: synthesisDiagnostics,
        hosts,
        sources,
        summary: script.summary,
        turnCount: script.turns.length,
        processing: {
          voiceOnlyAudio,
          packaging: wantsMixing || wantsEnhancement ? 'ffmpeg-post-process' : 'native-wav',
          mixed: wantsMixing,
          enhanced: wantsEnhancement,
          musicBedApplied: useMusicBed,
          mp3Exported: wantsMp3,
          allowVoiceFallback,
          allowProviderFallback,
          ttsProvider: synthesisProvider,
          scriptRequestTimeoutMs: podcastScriptRequestTimeoutMs,
          researchConcurrency: podcastResearchConcurrency,
          ttsConcurrency: podcastTtsConcurrency,
          ttsTimeoutMs: podcastTtsTimeoutMs,
          ttsChunkMaxChars: podcastChunkMaxChars,
        },
      },
    }), {
      sessionId,
      topic: normalizedTopic,
      ttsProvider: synthesisProvider,
    });
    if (persistedWav.artifact) {
      persistedArtifacts.push(persistedWav.artifact);
    }
    if (persistedWav.audio) {
      audioVariants.push({
        format: 'wav',
        ...persistedWav.audio,
      });
    }

    let persistedMp3 = null;
    if (wantsMp3) {
      const mp3Buffer = await this.runPodcastStage('mp3-export', () => this.retryTransientOperation(
        () => this.audioProcessingService.transcodeWavToMp3({
          wavBuffer: finalAudioBuffer,
          bitrateKbps: params.mp3BitrateKbps,
        }),
        {
          label: 'podcast mp3 export',
          retries: DEFAULT_AUDIO_PROCESSING_RETRY_ATTEMPTS,
          retryDelayMs: 900,
          shouldRetry: isRetryablePodcastAudioError,
        },
      ), {
        sessionId,
        topic: normalizedTopic,
        mp3Exported: true,
      });
      persistedMp3 = await this.runPodcastStage('persist-mp3', () => this.persistGeneratedAudio({
        sessionId,
        sourceMode: String(context?.clientSurface || context?.taskType || 'chat').trim() || 'chat',
        text: transcript,
        title: episodeTitle,
        filename: normalizeVariantFilename(params.filename || '', 'mp3'),
        provider: 'ffmpeg',
        voice: {
          provider: 'ffmpeg',
          episodeVoices: hosts.map((host) => ({
            speaker: host.name,
            voiceId: host.voiceId,
          })),
        },
        audioBuffer: mp3Buffer,
        mimeType: 'audio/mpeg',
        metadata: {
          createdByAgentTool: true,
          generatedBy: 'podcast',
          topic: normalizedTopic,
          durationMinutes,
          audience,
          tone,
          detailLevel,
          scriptDesign: scriptDesign ? scriptDesign.id : null,
          scriptDesignLabel: scriptDesign ? scriptDesign.label : null,
          scriptDesignExample,
          requestBrief,
          turnVoices: turnVoicePlan.plans.map((turn) => ({
            speaker: turn.speaker,
            voiceId: turn.voiceId,
          })),
          actualTurnVoices,
          ttsSegments: synthesisDiagnostics,
          hosts,
          sources,
          summary: script.summary,
          turnCount: script.turns.length,
          processing: {
            voiceOnlyAudio,
            packaging: wantsMixing || wantsEnhancement ? 'ffmpeg-post-process' : 'native-wav',
            mixed: wantsMixing,
            enhanced: wantsEnhancement,
            musicBedApplied: useMusicBed,
            mp3Exported: true,
            allowVoiceFallback,
            allowProviderFallback,
            ttsProvider: synthesisProvider,
            researchConcurrency: podcastResearchConcurrency,
            ttsConcurrency: podcastTtsConcurrency,
            ttsTimeoutMs: podcastTtsTimeoutMs,
            ttsChunkMaxChars: podcastChunkMaxChars,
          },
        },
      }), {
        sessionId,
        topic: normalizedTopic,
        mp3Exported: true,
      });
      if (persistedMp3.artifact) {
        persistedArtifacts.push(persistedMp3.artifact);
      }
      if (persistedMp3.audio) {
        audioVariants.push({
          format: 'mp3',
          ...persistedMp3.audio,
        });
      }
    }

    if (persistedArtifacts.length > 0) {
      await this.runPodcastStage('session-audio-state', () => this.updateGeneratedAudioSessionState(sessionId, persistedArtifacts), {
        sessionId,
        topic: normalizedTopic,
      });
    }
    const primaryAudio = persistedMp3?.audio || persistedWav.audio || null;
    const primaryArtifact = persistedMp3?.artifact || persistedWav.artifact || null;

    return {
      title: sanitizePodcastText(script.title),
      summary: script.summary,
      durationMinutes,
      estimatedWordCount: transcript.split(/\s+/).filter(Boolean).length,
      hosts,
      sources,
      script: {
        title: script.title,
        summary: script.summary,
        turns: script.turns,
        transcript,
        design: scriptDesign ? {
          id: scriptDesign.id,
          label: scriptDesign.label,
          summary: scriptDesign.summary,
        } : null,
      },
      processing: {
        voiceOnlyAudio,
        packaging: wantsMixing || wantsEnhancement ? 'ffmpeg-post-process' : 'native-wav',
        mixed: wantsMixing,
        enhanced: wantsEnhancement,
        musicBedApplied: useMusicBed,
        mp3Exported: wantsMp3,
        allowVoiceFallback,
        allowProviderFallback,
        researchConcurrency: podcastResearchConcurrency,
        ttsConcurrency: podcastTtsConcurrency,
        ttsTimeoutMs: podcastTtsTimeoutMs,
        ttsChunkMaxChars: podcastChunkMaxChars,
        audioProcessing: audioProcessingConfig,
        ttsProvider: synthesisProvider,
      },
      artifact: primaryArtifact,
      artifacts: persistedArtifacts,
      artifactIds: persistedArtifacts.map((artifact) => artifact.id).filter(Boolean),
      audio: primaryAudio,
      audioVariants,
    };
  }
}

const podcastService = new PodcastService();

module.exports = {
  PodcastService,
  getPodcastScriptDesignOptions,
  podcastService,
};

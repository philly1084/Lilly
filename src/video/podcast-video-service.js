const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const sharp = require('sharp');
const { config } = require('../config');
const { createResponse, generateImageBatch } = require('../openai-client');
const { parseLenientJson } = require('../utils/lenient-json');
const { normalizeWhitespace, stripNullCharacters } = require('../utils/text');
const { transcriptionService } = require('../audio/transcription-service');
const { audioProcessingService } = require('../audio/audio-processing-service');
const { parseWavBuffer } = require('../audio/wav-utils');
const { artifactService } = require('../artifacts/artifact-service');
const { artifactStore } = require('../artifacts/artifact-store');
const {
  getLocalGeneratedAudioArtifact,
  isLocalGeneratedAudioArtifactId,
} = require('../generated-audio-artifacts');
const {
  buildArtifactDownloadPath,
  buildArtifactInlinePath,
  toAbsoluteInternalUrl,
} = require('../generated-image-artifacts');
const {
  normalizeGeneratedVideoRecord,
  persistGeneratedVideoLocally,
  updateGeneratedVideoSessionState,
} = require('../generated-video-artifacts');
const {
  isConfigured: isUnsplashConfigured,
  searchImages,
} = require('../unsplash-client');

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;
const DEFAULT_SCENE_SECONDS = 8;
const DEFAULT_STORYBOARD_SCENE_COUNT = 14;
const MIN_SCENE_SECONDS = 4;
const MAX_SCENES = 36;
const DEFAULT_SEGMENT_TIMEOUT_MS = 240000;
const DEFAULT_MUX_TIMEOUT_MS = 900000;
const DEFAULT_MAX_FFMPEG_TIMEOUT_MS = 1800000;
const DEFAULT_MIXED_GENERATED_IMAGE_RATIO = 4;
const DEFAULT_X264_PRESET = 'veryfast';
const DEFAULT_X264_CRF = 23;
const DEFAULT_RENDER_MODE = 'waveform-card';
const X264_PRESETS = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
]);
const RENDER_MODES = new Set(['waveform-card', 'static-card', 'storyboard']);

function createServiceError(statusCode, message, code = 'podcast_video_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function escapeSvgText(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapPromoText(value = '', maxChars = 30, maxLines = 6) {
  const words = sanitizeText(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

async function buildPromoCardBuffer({ title = '', caption = '', callToAction = '', brand = {}, endCard = false } = {}) {
  const width = 1080;
  const height = 1920;
  const palette = Array.isArray(brand?.palette) ? brand.palette.filter((color) => /^#[0-9a-f]{6}$/i.test(color)) : [];
  const background = palette[0] || '#091426';
  const accent = palette[1] || '#37c6ff';
  const secondary = palette[2] || '#8b5cf6';
  const lines = wrapPromoText(endCard ? callToAction : caption, endCard ? 24 : 31, endCard ? 4 : 7);
  const startY = endCard ? 760 : Math.max(560, 960 - (lines.length * 62));
  const text = lines.map((line, index) => (
    `<text x="90" y="${startY + (index * 82)}" fill="#ffffff" font-size="${endCard ? 66 : 54}" font-weight="700">${escapeSvgText(line)}</text>`
  )).join('');
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="#050817"/></linearGradient></defs>
      <rect width="1080" height="1920" fill="url(#bg)"/>
      <circle cx="930" cy="240" r="320" fill="${accent}" opacity="0.14"/>
      <circle cx="160" cy="1710" r="380" fill="${secondary}" opacity="0.12"/>
      <rect x="70" y="92" width="940" height="10" rx="5" fill="${accent}"/>
      <text x="90" y="190" fill="${accent}" font-size="30" font-weight="700" letter-spacing="4">PODCAST CLIP</text>
      <text x="90" y="280" fill="#dbeafe" font-size="38" font-weight="600">${escapeSvgText(cleanTitle(title))}</text>
      ${text}
      <rect x="90" y="1600" width="900" height="1" fill="#ffffff" opacity="0.25"/>
      <text x="90" y="1675" fill="#a8b8ce" font-size="28">${endCard ? 'Continue the conversation' : 'AI-generated audio • Branded launch asset'}</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function cleanTitle(value = '') {
  return sanitizeText(value).slice(0, 46);
}

function sanitizeText(value = '') {
  return normalizeWhitespace(stripNullCharacters(String(value || ''))).trim();
}

function slugify(value = '', fallback = 'podcast-video') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || fallback;
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, numeric));
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function normalizeRenderMode(value = DEFAULT_RENDER_MODE) {
  const normalized = String(value || DEFAULT_RENDER_MODE).trim().toLowerCase();
  if ([
    'wave',
    'waves',
    'waveform',
    'waveform-video',
    'wave-card',
    'podcast-wave',
    'audio-wave',
    'audio-visualizer',
    'visualizer',
    'visualiser',
  ].includes(normalized)) {
    return 'waveform-card';
  }
  if (normalized === 'single-image' || normalized === 'single-picture' || normalized === 'static') {
    return 'static-card';
  }
  if (normalized === 'scenes' || normalized === 'multi-scene') {
    return 'storyboard';
  }
  return RENDER_MODES.has(normalized) ? normalized : DEFAULT_RENDER_MODE;
}

function resolveDefaultStoryboardSceneCount() {
  return clampNumber(
    config.podcastVideo?.defaultSceneCount,
    1,
    MAX_SCENES,
    DEFAULT_STORYBOARD_SCENE_COUNT,
  );
}

function resolveStoryboardSceneCount(sceneCount) {
  return Number.isFinite(Number(sceneCount)) && Number(sceneCount) > 0
    ? clampNumber(sceneCount, 1, MAX_SCENES, resolveDefaultStoryboardSceneCount())
    : resolveDefaultStoryboardSceneCount();
}

function resolvePodcastVideoRuntimeOptions(options = {}) {
  const configured = config.podcastVideo || {};
  const maxFfmpegTimeoutMs = normalizePositiveInteger(
    options.maxFfmpegTimeoutMs,
    normalizePositiveInteger(configured.maxFfmpegTimeoutMs, DEFAULT_MAX_FFMPEG_TIMEOUT_MS),
  );
  const sharedTimeoutMs = normalizePositiveInteger(options.ffmpegTimeoutMs || options.timeoutMs, null);
  const segmentTimeoutMs = normalizePositiveInteger(
    options.segmentTimeoutMs,
    sharedTimeoutMs || normalizePositiveInteger(configured.segmentTimeoutMs, DEFAULT_SEGMENT_TIMEOUT_MS),
  );
  const muxTimeoutMs = normalizePositiveInteger(
    options.muxTimeoutMs,
    sharedTimeoutMs || normalizePositiveInteger(configured.muxTimeoutMs, DEFAULT_MUX_TIMEOUT_MS),
  );
  const configuredPreset = String(configured.x264Preset || DEFAULT_X264_PRESET).trim().toLowerCase();
  const requestedPreset = String(options.x264Preset || '').trim().toLowerCase();
  const x264Preset = X264_PRESETS.has(requestedPreset)
    ? requestedPreset
    : X264_PRESETS.has(configuredPreset)
      ? configuredPreset
      : DEFAULT_X264_PRESET;
  const x264Crf = clampNumber(options.x264Crf ?? configured.x264Crf, 18, 32, DEFAULT_X264_CRF);
  const x264Profile = String(options.x264Profile || configured.x264Profile || 'main').trim().toLowerCase() || 'main';
  const x264Level = String(options.x264Level || configured.x264Level || '4.1').trim() || '4.1';
  const codecTag = String(options.codecTag || configured.codecTag || 'avc1').trim().toLowerCase() || 'avc1';
  const renderMode = normalizeRenderMode(options.renderMode || configured.renderMode || DEFAULT_RENDER_MODE);

  return {
    maxFfmpegTimeoutMs,
    segmentTimeoutMs: Math.min(maxFfmpegTimeoutMs, segmentTimeoutMs),
    muxTimeoutMs: Math.min(maxFfmpegTimeoutMs, muxTimeoutMs),
    x264Preset,
    x264Crf,
    x264Profile,
    x264Level,
    codecTag,
    renderMode,
  };
}

function resolveAdaptiveFfmpegTimeoutMs(baseTimeoutMs, durationSeconds, {
  fixedMs = 60000,
  perSecondMs = 1000,
  maxTimeoutMs = DEFAULT_MAX_FFMPEG_TIMEOUT_MS,
} = {}) {
  const durationMs = Math.max(0, Number(durationSeconds) || 0) * Math.max(0, perSecondMs);
  const adaptiveTimeoutMs = Math.ceil(Math.max(0, fixedMs) + durationMs);
  return Math.min(
    normalizePositiveInteger(maxTimeoutMs, DEFAULT_MAX_FFMPEG_TIMEOUT_MS),
    Math.max(normalizePositiveInteger(baseTimeoutMs, 1000), adaptiveTimeoutMs),
  );
}

function buildCompatibleH264VideoArgs(runtime = {}) {
  return [
    '-c:v', 'libx264',
    '-preset', runtime.x264Preset || DEFAULT_X264_PRESET,
    '-crf', String(runtime.x264Crf || DEFAULT_X264_CRF),
    '-profile:v', runtime.x264Profile || 'main',
    '-level:v', runtime.x264Level || '4.1',
    '-pix_fmt', 'yuv420p',
    '-tag:v', runtime.codecTag || 'avc1',
  ];
}

function uniqueOrdered(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
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

function splitTranscriptSegments(transcript = '') {
  const normalized = sanitizeText(transcript);
  if (!normalized) {
    return [];
  }

  const sentenceSegments = normalized
    .split(/(?<=[.!?])\s+/)
    .map((segment) => sanitizeText(segment))
    .filter(Boolean);

  if (sentenceSegments.length > 0) {
    return sentenceSegments;
  }

  return normalized
    .split(/\n+/)
    .map((segment) => sanitizeText(segment))
    .filter(Boolean);
}

function wordCount(value = '') {
  return sanitizeText(value).split(/\s+/).filter(Boolean).length;
}

function normalizeAspectRatio(aspectRatio = '16:9') {
  const normalized = String(aspectRatio || '').trim();
  if (normalized === '9:16') {
    return { aspectRatio: '9:16', width: 1080, height: 1920, orientation: 'portrait' };
  }
  if (normalized === '1:1') {
    return { aspectRatio: '1:1', width: 1080, height: 1080, orientation: 'squarish' };
  }
  return { aspectRatio: '16:9', width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, orientation: 'landscape' };
}

function normalizeImageMode(value = 'mixed') {
  const normalized = String(value || 'mixed').trim().toLowerCase();
  if (['provided', 'web', 'unsplash', 'generated', 'mixed', 'fallback'].includes(normalized)) {
    return normalized;
  }
  return 'mixed';
}

function normalizeBooleanOption(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value == null || value === '') {
    return fallback;
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

function normalizeGeneratedImageRatio(value, fallback = DEFAULT_MIXED_GENERATED_IMAGE_RATIO) {
  if (typeof value === 'string') {
    const ratioMatch = value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*1$/);
    if (ratioMatch) {
      return clampNumber(ratioMatch[1], 0, 20, fallback);
    }
  }

  return clampNumber(value, 0, 20, fallback);
}

function resolveMixedGeneratedImageRatio(options = {}) {
  return normalizeGeneratedImageRatio(
    options.generatedImageRatio
      ?? options.generatedImageWeight
      ?? config.podcastVideo?.generatedImageRatio,
    DEFAULT_MIXED_GENERATED_IMAGE_RATIO,
  );
}

function resolveSceneIndex(scene = {}, fallback = 0) {
  const numericIndex = Number(scene.index);
  if (Number.isFinite(numericIndex) && numericIndex >= 0) {
    return Math.floor(numericIndex);
  }

  const idMatch = String(scene.id || '').match(/(\d+)/);
  if (idMatch) {
    return Math.max(0, Number(idMatch[1]) - 1);
  }

  return Math.max(0, Math.floor(Number(fallback) || 0));
}

function shouldPreferGeneratedInMixedMode(scene = {}, options = {}) {
  const ratio = resolveMixedGeneratedImageRatio(options);
  if (ratio <= 0) {
    return false;
  }

  const cycle = ratio + 1;
  return resolveSceneIndex(scene) % cycle < ratio;
}

function normalizeVideoAudioRepair(value) {
  return normalizeBooleanOption(value, config.podcastVideo?.audioRepairEnabled === true);
}

function normalizeVisualEffects(value) {
  return normalizeBooleanOption(value, config.podcastVideo?.visualEffectsEnabled !== false);
}

function buildBackgroundVideoFilter(dimensions = {}, scene = {}, index = 0, visualEffects = true) {
  const width = Math.max(1, Number(dimensions.width) || DEFAULT_WIDTH);
  const height = Math.max(1, Number(dimensions.height) || DEFAULT_HEIGHT);
  const duration = Math.max(MIN_SCENE_SECONDS, Number(scene.duration) || DEFAULT_SCENE_SECONDS);
  const base = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
  ];

  if (visualEffects) {
    const zoomMax = index % 2 === 0 ? 1.035 : 1.025;
    const fadeOutStart = Math.max(0, duration - 0.55);
    base.push(
      `zoompan=z='min(zoom+0.00045,${zoomMax})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${DEFAULT_FPS}`,
      'eq=contrast=1.035:saturation=1.045',
      'fade=t=in:st=0:d=0.35',
      `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.55`,
    );
  }

  base.push('format=yuv420p');
  return base.join(',');
}

function normalizeScene(scene = {}, index = 0) {
  const start = Math.max(0, Number(scene.start ?? scene.startSeconds ?? 0) || 0);
  const end = Math.max(start + MIN_SCENE_SECONDS, Number(scene.end ?? scene.endSeconds ?? (start + DEFAULT_SCENE_SECONDS)) || (start + DEFAULT_SCENE_SECONDS));
  const summary = sanitizeText(scene.summary || scene.title || scene.caption || `Scene ${index + 1}`);
  const narration = sanitizeText(scene.narration || scene.text || scene.caption || summary);
  const visualQuery = sanitizeText(scene.visualQuery || scene.query || summary);
  const visualPrompt = sanitizeText(scene.visualPrompt || scene.prompt || visualQuery || summary);
  const keyFacts = uniqueOrdered(Array.isArray(scene.keyFacts) ? scene.keyFacts : []);
  const contentReads = uniqueOrdered(Array.isArray(scene.contentReads) ? scene.contentReads : []);
  const contentWrites = uniqueOrdered(Array.isArray(scene.contentWrites) ? scene.contentWrites : []);

  return {
    id: scene.id || `scene-${String(index + 1).padStart(2, '0')}`,
    index,
    start,
    end,
    duration: Math.max(MIN_SCENE_SECONDS, end - start),
    summary,
    narration,
    caption: sanitizeText(scene.caption || narration || summary).slice(0, 180),
    visualQuery,
    visualPrompt,
    slideType: sanitizeText(scene.slideType || scene.visualType || scene.layout || ''),
    keyFacts,
    contentReads,
    contentWrites,
    imageUrl: String(scene.imageUrl || scene.image_url || '').trim() || null,
    imageSource: String(scene.imageSource || scene.image_source || '').trim() || null,
    attribution: scene.attribution || null,
  };
}

function retimeScenesToDuration(scenes = [], durationSeconds = 0) {
  const normalizedScenes = (Array.isArray(scenes) ? scenes : [])
    .map((scene, index) => normalizeScene(scene, index));
  const targetDuration = Math.max(0, Number(durationSeconds) || 0);
  if (normalizedScenes.length === 0 || targetDuration <= 0) {
    return normalizedScenes;
  }

  const minimumDuration = normalizedScenes.length * MIN_SCENE_SECONDS;
  const resolvedDuration = Math.max(targetDuration, minimumDuration);
  const sourceDuration = normalizedScenes.reduce(
    (sum, scene) => sum + Math.max(MIN_SCENE_SECONDS, Number(scene.duration) || 0),
    0,
  ) || minimumDuration;
  let cursor = 0;

  return normalizedScenes.map((scene, index) => {
    const remainingScenes = normalizedScenes.length - index - 1;
    const remainingMinimum = remainingScenes * MIN_SCENE_SECONDS;
    const scaledDuration = index === normalizedScenes.length - 1
      ? Math.max(MIN_SCENE_SECONDS, resolvedDuration - cursor)
      : Math.max(MIN_SCENE_SECONDS, (Math.max(MIN_SCENE_SECONDS, scene.duration) / sourceDuration) * resolvedDuration);
    const duration = index === normalizedScenes.length - 1
      ? scaledDuration
      : Math.min(scaledDuration, Math.max(MIN_SCENE_SECONDS, resolvedDuration - cursor - remainingMinimum));
    const start = cursor;
    const end = index === normalizedScenes.length - 1
      ? resolvedDuration
      : Math.min(resolvedDuration, start + duration);
    cursor = end;

    return {
      ...scene,
      start,
      end,
      duration: Math.max(MIN_SCENE_SECONDS, end - start),
    };
  });
}

function buildFallbackStoryboard({ title = '', transcript = '', turns = [], durationSeconds = 0, sceneCount = null } = {}) {
  const normalizedTurns = (Array.isArray(turns) ? turns : [])
    .map((turn) => ({
      speaker: sanitizeText(turn?.speaker || ''),
      text: sanitizeText(turn?.text || ''),
    }))
    .filter((turn) => turn.text);
  const segments = normalizedTurns.length > 0
    ? normalizedTurns.map((turn) => `${turn.speaker ? `${turn.speaker}: ` : ''}${turn.text}`)
    : splitTranscriptSegments(transcript);
  const totalWords = Math.max(1, segments.reduce((sum, segment) => sum + wordCount(segment), 0));
  const desiredSceneCount = clampNumber(
    resolveStoryboardSceneCount(sceneCount),
    1,
    MAX_SCENES,
    DEFAULT_STORYBOARD_SCENE_COUNT,
  );
  const grouped = [];

  if (segments.length > 0 && segments.length <= desiredSceneCount) {
    const words = segments.join(' ').split(/\s+/).filter(Boolean);
    const wordsPerScene = Math.max(1, Math.ceil(words.length / desiredSceneCount));
    for (let index = 0; index < desiredSceneCount; index += 1) {
      const fallbackStart = Math.max(0, words.length - wordsPerScene);
      const start = Math.min(index * wordsPerScene, fallbackStart);
      const chunk = words.slice(start, start + wordsPerScene).join(' ');
      grouped[index] = [chunk || sanitizeText(title) || `Visual ${index + 1}`];
    }
  } else {
    let assignedWords = 0;
    for (const segment of segments) {
      const targetIndex = Math.min(
        desiredSceneCount - 1,
        Math.floor((assignedWords / totalWords) * desiredSceneCount),
      );
      if (!grouped[targetIndex]) {
        grouped[targetIndex] = [];
      }
      grouped[targetIndex].push(segment);
      assignedWords += wordCount(segment);
    }
  }

  const fallbackText = sanitizeText(segments.join(' ') || title) || 'Podcast episode';
  for (let index = 0; index < desiredSceneCount; index += 1) {
    if (!Array.isArray(grouped[index]) || grouped[index].length === 0) {
      grouped[index] = [`${fallbackText} visual ${index + 1}`];
    }
  }

  const compactGroups = grouped.slice(0, desiredSceneCount).filter((group) => Array.isArray(group) && group.length > 0);
  if (compactGroups.length === 0) {
    compactGroups.push([sanitizeText(title) || 'Podcast episode']);
  }

  const resolvedDuration = Math.max(
    compactGroups.length * MIN_SCENE_SECONDS,
    Number(durationSeconds) || (compactGroups.length * DEFAULT_SCENE_SECONDS),
  );
  let cursor = 0;

  return compactGroups.map((group, index) => {
    const narration = group.join(' ');
    const groupWords = Math.max(1, wordCount(narration));
    const remainingGroups = compactGroups.length - index;
    const proportionalDuration = index === compactGroups.length - 1
      ? Math.max(MIN_SCENE_SECONDS, resolvedDuration - cursor)
      : Math.max(MIN_SCENE_SECONDS, (groupWords / totalWords) * resolvedDuration);
    const boundedDuration = index === compactGroups.length - 1
      ? proportionalDuration
      : Math.min(
        Math.max(MIN_SCENE_SECONDS, proportionalDuration),
        Math.max(MIN_SCENE_SECONDS, resolvedDuration - cursor - ((remainingGroups - 1) * MIN_SCENE_SECONDS)),
      );
    const start = cursor;
    const end = Math.min(resolvedDuration, start + boundedDuration);
    cursor = end;

    const words = narration.split(/\s+/).filter(Boolean);
    const summary = words.slice(0, 14).join(' ');
    const keyFacts = uniqueOrdered([
      words.slice(0, 8).join(' '),
      words.slice(8, 16).join(' '),
    ]).filter((fact) => fact.length > 8);
    const slideType = chooseInfographicKind(`${title} ${summary} ${index}`);
    return normalizeScene({
      start,
      end,
      summary: summary || `${sanitizeText(title) || 'Podcast'} scene ${index + 1}`,
      narration,
      caption: words.slice(0, 22).join(' '),
      visualQuery: summary || sanitizeText(title),
      slideType,
      keyFacts,
      contentReads: [
        `Transcript segment ${index + 1}`,
      ],
      contentWrites: [
        'Show the main idea as a cinematic editorial picture, not a text slide.',
        'Use people, places, objects, atmosphere, and visual metaphor to match this segment.',
      ],
      visualPrompt: [
        'Premium cinematic editorial still for a video podcast backdrop, high production value.',
        'Normal picture quality: realistic materials, natural depth, expressive lighting, believable environment, detailed subject, strong photographic composition.',
        'No readable text, no labels, no charts, no UI, no logos, no watermarks, no typography.',
        `Topic: ${sanitizeText(title) || 'Podcast episode'}.`,
        `Moment: ${summary || narration.slice(0, 120)}.`,
      ].join(' '),
    }, index);
  });
}

function buildShowCardScene({
  title = '',
  transcript = '',
  scenes = [],
  durationSeconds = 0,
} = {}) {
  const normalizedTitle = sanitizeText(title) || 'Podcast video';
  const sceneSummaries = (Array.isArray(scenes) ? scenes : [])
    .map((scene) => sanitizeText(scene?.summary || scene?.caption || scene?.visualQuery || ''))
    .filter(Boolean)
    .slice(0, 5);
  const transcriptSummary = splitTranscriptSegments(transcript)
    .slice(0, 3)
    .join(' ')
    .slice(0, 240);
  const showBeats = uniqueOrdered([
    ...sceneSummaries,
    transcriptSummary,
  ]).join(' | ');
  const firstScene = Array.isArray(scenes) ? scenes.find((scene) => scene?.imageUrl) : null;

  return normalizeScene({
    start: 0,
    end: Math.max(MIN_SCENE_SECONDS, Number(durationSeconds) || DEFAULT_SCENE_SECONDS),
    summary: normalizedTitle,
    caption: sceneSummaries[0] || transcriptSummary || normalizedTitle,
    visualQuery: `${normalizedTitle} science news explainer show studio`,
    visualPrompt: [
      'Single static key visual for a polished YouTube science news information show.',
      'Modern cinematic editorial studio still, presenter desk, monitor wall with abstract shapes only, cinematic lighting, high production value.',
      'Compose it like premium cover photography: clear subject, natural depth of field, realistic surfaces, strong foreground and background separation, generous margins.',
      'Use one stable composition suitable for a full podcast episode background.',
      'No readable text, no logos, no watermarks, no paragraphs, no distorted typography.',
      `Topic: ${normalizedTitle}.`,
      showBeats ? `Episode beats: ${showBeats}.` : '',
    ].filter(Boolean).join(' '),
    imageUrl: firstScene?.imageUrl || null,
    imageSource: firstScene?.imageSource || null,
    attribution: firstScene?.attribution || null,
  }, 0);
}

function buildStoryboardPrompt({
  title = '',
  transcript = '',
  turns = [],
  durationSeconds = 0,
  sceneCount = 0,
  visualStyle = '',
} = {}) {
  const targetSceneCount = clampNumber(
    resolveStoryboardSceneCount(sceneCount),
    1,
    MAX_SCENES,
    DEFAULT_STORYBOARD_SCENE_COUNT,
  );
  const turnTranscript = (Array.isArray(turns) ? turns : [])
    .map((turn) => `${sanitizeText(turn?.speaker)}: ${sanitizeText(turn?.text)}`)
    .filter((line) => line.replace(/^:\s*/, '').trim())
    .join('\n');

  return [
    'Create a timestamped YouTube information-show rundown and visual storyboard for a podcast video.',
    `Title: ${sanitizeText(title) || 'Podcast episode'}`,
    `Duration seconds: ${Math.max(0, Number(durationSeconds) || 0) || 'unknown'}`,
    `Target scenes: ${targetSceneCount}`,
    `Visual style: ${sanitizeText(visualStyle) || 'cinematic editorial photo backdrops for a YouTube science/news explainer show, polished pacing, strong hook, evidence beats, viewer takeaway, no readable text in images'}`,
    '',
    'Return valid JSON only with this shape:',
    '{"scenes":[{"start":0,"end":8,"summary":"...","caption":"...","slideType":"hook-card|timeline|comparison|process-flow|risk-map|evidence-dashboard|myth-vs-fact|takeaway","keyFacts":["..."],"contentReads":["..."],"contentWrites":["..."],"visualQuery":"...","visualPrompt":"..."}]}',
    '',
    'Rules:',
    '- Scene times must cover the whole episode in order without overlaps.',
    '- Treat scenes as show segments: hook, context, evidence, stakes, implications, and takeaway.',
    '- Mix picture concepts across the episode: people, places, objects, close-ups, environmental detail, symbolic scenes, cinematic studio moments, documentary-style stills, and atmospheric cover images.',
    '- For each scene, read the transcript/source beats into contentReads, then write the visual payload into contentWrites: subject, setting, mood, foreground object, background environment, camera angle, light, and color.',
    '- Each visual should feel like a finished cinematic photograph or premium editorial image, not a diagram, not a text slide, and not a basic abstract background.',
    '- visualQuery should be short and useful for Unsplash search.',
    '- visualPrompt should be specific enough for image generation and should describe picture qualities: subject, setting, lens/camera feel, lighting, materials, atmosphere, realism, color palette, and composition.',
    '- Generated images should contain no readable text. Avoid labels, numbers, UI, charts, slides, captions, small paragraphs, logos, watermarks, and typography.',
    '- Captions should be concise excerpts aligned to the audio segment.',
    '',
    'Transcript:',
    (turnTranscript || sanitizeText(transcript)).slice(0, 18000),
  ].join('\n');
}

function decodeDataUrl(value = '') {
  const match = String(value || '').trim().match(/^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=]+)$/i);
  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  const extension = mimeType.includes('jpeg') ? 'jpg' : (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]+/g, '');
  return {
    buffer: Buffer.from(match[2], 'base64'),
    mimeType,
    extension: extension || 'png',
  };
}

function inferImageExtension(contentType = '', url = '') {
  const normalizedType = String(contentType || '').toLowerCase();
  const normalizedUrl = String(url || '').toLowerCase();
  if (normalizedType.includes('jpeg') || /\.jpe?g(?:[?#]|$)/.test(normalizedUrl)) return 'jpg';
  if (normalizedType.includes('webp') || /\.webp(?:[?#]|$)/.test(normalizedUrl)) return 'webp';
  if (normalizedType.includes('gif') || /\.gif(?:[?#]|$)/.test(normalizedUrl)) return 'gif';
  if (normalizedType.includes('svg') || /\.svg(?:[?#]|$)/.test(normalizedUrl)) return 'svg';
  return 'png';
}

function isLikelyImageUrl(url = '') {
  const normalized = String(url || '').trim();
  return /^https?:\/\//i.test(normalized)
    && /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(normalized);
}

function resolveUrl(candidate = '', baseUrl = '') {
  const raw = String(candidate || '').trim();
  if (!raw) {
    return '';
  }

  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch (_error) {
    return '';
  }
}

function extractImageUrlsFromHtml(html = '', baseUrl = '') {
  const urls = [];
  const seen = new Set();
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/gi,
    /<img[^>]+src=["']([^"']+)["'][^>]*>/gi,
    /<source[^>]+srcset=["']([^"']+)["'][^>]*>/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(html);
    while (match) {
      const rawValue = String(match[1] || '').split(',')[0].trim().split(/\s+/)[0];
      const resolved = resolveUrl(rawValue, baseUrl);
      if (resolved && !seen.has(resolved) && isLikelyImageUrl(resolved)) {
        seen.add(resolved);
        urls.push(resolved);
      }
      match = pattern.exec(html);
    }
  }

  return urls;
}

function hashString(value = '') {
  const text = String(value || 'podcast-video');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function chooseInfographicKind(seed = '') {
  const kinds = ['timeline', 'comparison', 'flow', 'matrix', 'radar', 'metrics'];
  return kinds[hashString(seed) % kinds.length];
}

function buildSceneImagePrompt(scene = {}, options = {}) {
  const summary = sanitizeText(scene.summary || scene.caption || scene.visualQuery || 'Podcast scene');
  const caption = sanitizeText(scene.caption || scene.narration || '').slice(0, 220);
  const requested = sanitizeText(scene.visualPrompt || scene.visualQuery || summary);
  const explicitKind = sanitizeText(scene.slideType || '').toLowerCase();
  const kindAliases = {
    'hook-card': 'metrics',
    hook: 'metrics',
    timeline: 'timeline',
    comparison: 'comparison',
    'comparison-board': 'comparison',
    'process-flow': 'flow',
    flow: 'flow',
    'risk-map': 'radar',
    'impact-map': 'radar',
    radar: 'radar',
    'evidence-dashboard': 'metrics',
    dashboard: 'metrics',
    'myth-vs-fact': 'comparison',
    takeaway: 'matrix',
  };
  const kind = kindAliases[explicitKind] || chooseInfographicKind(`${summary} ${caption} ${scene.id || ''}`);
  const orientation = options.orientation === 'portrait'
    ? 'vertical'
    : options.orientation === 'squarish'
      ? 'square'
      : 'widescreen';
  const keyFacts = uniqueOrdered(scene.keyFacts || []).slice(0, 4);
  const contentReads = uniqueOrdered(scene.contentReads || []).slice(0, 3);
  const contentWrites = uniqueOrdered(scene.contentWrites || []).slice(0, 4);
  const pictureBriefs = {
    timeline: 'a documentary-style scene that suggests time passing through layered objects, archival textures, changing light, and a clear visual journey',
    comparison: 'a cinematic contrast scene with two clearly different environments or objects in natural space, divided by composition rather than text',
    flow: 'a realistic process scene with visible cause-and-effect through action, tools, hands, materials, paths, or machinery',
    matrix: 'a premium editorial still with several meaningful objects arranged in depth, showing tradeoffs through placement, scale, and lighting',
    radar: 'an atmospheric impact scene with a central subject and surrounding environmental cues that imply pressure, reach, or consequence',
    metrics: 'a polished photo-real editorial scene with strong subject focus, premium lighting, subtle abstract data shapes only in the background, and no readable text',
  };

  return [
    `Create a premium ${orientation} cinematic image backdrop for a video podcast.`,
    `Use ${pictureBriefs[kind] || pictureBriefs.metrics}.`,
    'Normal picture qualities: realistic subject, believable environment, strong photographic composition, natural depth of field, expressive cinematic light, rich texture, clean color grading, high-resolution detail.',
    'Style: documentary editorial photography, premium magazine cover still, tasteful cinematic realism, subject-specific visual metaphor, polished but natural.',
    'Avoid basic abstract backgrounds. Avoid flat cards, UI panels, slide layouts, diagrams, charts, labels, numbers, readable text, logos, watermarks, and malformed typography.',
    'The image should be almost entirely visual; if the model tries to add words, replace them with objects, lighting, color, symbols, or environmental detail.',
    `Topic moment: ${summary}.`,
    caption ? `Audio-aligned context: ${caption}.` : '',
    keyFacts.length ? `Facts to imply visually without text: ${keyFacts.join(' | ')}.` : '',
    contentReads.length ? `Context used for the scene: ${contentReads.join(' | ')}.` : '',
    contentWrites.length ? `Picture direction, not words in the image: ${contentWrites.join(' | ')}.` : '',
    `Original visual direction: ${requested}.`,
  ].filter(Boolean).join(' ');
}

function buildPlaceholderFrameBuffer(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, seed = '') {
  const hashed = hashString(seed);
  const kind = chooseInfographicKind(seed);
  const palettes = [
    [[18, 24, 31], [238, 244, 239], [46, 120, 112], [222, 156, 73]],
    [[22, 27, 34], [245, 240, 229], [71, 96, 181], [211, 92, 92]],
    [[20, 31, 30], [239, 247, 244], [64, 139, 107], [190, 143, 61]],
    [[31, 26, 29], [246, 239, 233], [151, 86, 121], [78, 132, 158]],
    [[19, 28, 38], [239, 244, 248], [37, 119, 151], [218, 174, 83]],
  ];
  const [ink, paper, accent, warm] = palettes[hashed % palettes.length];
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
  const pixels = Buffer.alloc(width * height * 3);
  const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
  const mix = (a, b, t) => [
    a[0] + ((b[0] - a[0]) * t),
    a[1] + ((b[1] - a[1]) * t),
    a[2] + ((b[2] - a[2]) * t),
  ];
  const inBox = (nx, ny, x1, y1, x2, y2) => nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2;
  const boxEdge = (nx, ny, x1, y1, x2, y2, stroke = 0.006) => inBox(nx, ny, x1, y1, x2, y2)
    && (nx < x1 + stroke || nx > x2 - stroke || ny < y1 + stroke || ny > y2 - stroke);
  const lineDistance = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = (dx * dx) + (dy * dy) || 1;
    const t = Math.max(0, Math.min(1, (((px - ax) * dx) + ((py - ay) * dy)) / lengthSq));
    return Math.hypot(px - (ax + (t * dx)), py - (ay + (t * dy)));
  };
  const circle = (nx, ny, cx, cy, radius) => Math.hypot(nx - cx, ny - cy) <= radius;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const normalizedX = x / Math.max(1, width - 1);
      const normalizedY = y / Math.max(1, height - 1);
      const t = (normalizedX * 0.35) + (normalizedY * 0.65);
      const base = mix(paper, ink, 0.09 + (t * 0.08));
      const vignette = Math.hypot(normalizedX - 0.5, normalizedY - 0.5) * 18;
      const grid = ((x + (hashed & 63)) % Math.max(48, Math.round(width * 0.075)) < 1
        || (y + ((hashed >> 8) & 63)) % Math.max(48, Math.round(height * 0.105)) < 1) ? 1 : 0;
      const spotlight = Math.max(0, 1 - Math.hypot(normalizedX - 0.78, normalizedY - 0.18) * 2.3);
      const offset = (y * width + x) * 3;
      let r = base[0] + (grid * 8) + (spotlight * 20) - vignette;
      let g = base[1] + (grid * 8) + (spotlight * 18) - vignette;
      let b = base[2] + (grid * 8) + (spotlight * 14) - vignette;

      const add = (color, alpha = 1) => {
        r = (r * (1 - alpha)) + (color[0] * alpha);
        g = (g * (1 - alpha)) + (color[1] * alpha);
        b = (b * (1 - alpha)) + (color[2] * alpha);
      };

      if (inBox(normalizedX, normalizedY, 0.07, 0.09, 0.93, 0.88)) {
        add(mix(paper, ink, 0.045), 0.52);
      }
      if (boxEdge(normalizedX, normalizedY, 0.07, 0.09, 0.93, 0.88, 0.004)) {
        add(mix(accent, paper, 0.25), 0.75);
      }
      if (inBox(normalizedX, normalizedY, 0.11, 0.14, 0.32, 0.21)
        || inBox(normalizedX, normalizedY, 0.11, 0.235, 0.25, 0.262)) {
        add(ink, 0.5);
      }
      if (inBox(normalizedX, normalizedY, 0.77, 0.13, 0.87, 0.18)) {
        add(warm, 0.58);
      }

      if (kind === 'timeline') {
        const yLine = 0.55;
        if (Math.abs(normalizedY - yLine) < 0.006 && normalizedX > 0.16 && normalizedX < 0.86) add(accent, 0.72);
        [0.2, 0.38, 0.58, 0.78].forEach((cx, index) => {
          if (circle(normalizedX, normalizedY, cx, yLine, index === 2 ? 0.045 : 0.034)) add(index === 2 ? warm : accent, 0.8);
          if (inBox(normalizedX, normalizedY, cx - 0.065, yLine + 0.075, cx + 0.065, yLine + 0.145)) add(mix(paper, ink, 0.11), 0.7);
        });
      } else if (kind === 'comparison') {
        if (inBox(normalizedX, normalizedY, 0.14, 0.32, 0.45, 0.76)) add(mix(accent, paper, 0.77), 0.62);
        if (inBox(normalizedX, normalizedY, 0.55, 0.32, 0.86, 0.76)) add(mix(warm, paper, 0.77), 0.62);
        if (Math.abs(normalizedX - 0.5) < 0.006 && normalizedY > 0.28 && normalizedY < 0.8) add(ink, 0.38);
        [0.42, 0.52, 0.62, 0.72].forEach((barY, index) => {
          if (inBox(normalizedX, normalizedY, 0.18, barY, 0.28 + (index * 0.035), barY + 0.018)) add(accent, 0.75);
          if (inBox(normalizedX, normalizedY, 0.59, barY, 0.81 - (index * 0.027), barY + 0.018)) add(warm, 0.75);
        });
      } else if (kind === 'flow') {
        const nodes = [[0.18, 0.45], [0.38, 0.35], [0.6, 0.52], [0.82, 0.41]];
        nodes.forEach(([cx, cy], index) => {
          if (inBox(normalizedX, normalizedY, cx - 0.07, cy - 0.055, cx + 0.07, cy + 0.055)) add(index === 2 ? warm : mix(accent, paper, 0.2), 0.72);
        });
        for (let index = 0; index < nodes.length - 1; index += 1) {
          if (lineDistance(normalizedX, normalizedY, nodes[index][0] + 0.07, nodes[index][1], nodes[index + 1][0] - 0.07, nodes[index + 1][1]) < 0.008) add(ink, 0.5);
        }
      } else if (kind === 'matrix') {
        if (Math.abs(normalizedX - 0.5) < 0.005 && normalizedY > 0.3 && normalizedY < 0.8) add(ink, 0.4);
        if (Math.abs(normalizedY - 0.55) < 0.005 && normalizedX > 0.18 && normalizedX < 0.84) add(ink, 0.4);
        [[0.3, 0.4], [0.68, 0.41], [0.34, 0.69], [0.72, 0.68]].forEach(([cx, cy], index) => {
          if (circle(normalizedX, normalizedY, cx, cy, index === 1 ? 0.042 : 0.028)) add(index === 1 ? warm : accent, 0.82);
        });
      } else if (kind === 'radar') {
        [0.11, 0.18, 0.25].forEach((radius) => {
          if (Math.abs(Math.hypot(normalizedX - 0.5, normalizedY - 0.56) - radius) < 0.004) add(mix(accent, ink, 0.18), 0.55);
        });
        for (let index = 0; index < 6; index += 1) {
          const angle = (Math.PI * 2 * index) / 6;
          const endX = 0.5 + Math.cos(angle) * 0.28;
          const endY = 0.56 + Math.sin(angle) * 0.28;
          if (lineDistance(normalizedX, normalizedY, 0.5, 0.56, endX, endY) < 0.004) add(ink, 0.28);
          if (circle(normalizedX, normalizedY, endX, endY, 0.026)) add(index % 2 ? warm : accent, 0.72);
        }
      } else {
        [[0.15, 0.35, 0.31, 0.55], [0.36, 0.35, 0.52, 0.55], [0.57, 0.35, 0.73, 0.55], [0.16, 0.64, 0.84, 0.70]].forEach((box, index) => {
          if (inBox(normalizedX, normalizedY, ...box)) add(index === 1 ? warm : mix(accent, paper, 0.28), 0.68);
          if (boxEdge(normalizedX, normalizedY, ...box, 0.004)) add(ink, 0.45);
        });
        if (lineDistance(normalizedX, normalizedY, 0.2, 0.78, 0.38, 0.72) < 0.006
          || lineDistance(normalizedX, normalizedY, 0.38, 0.72, 0.56, 0.76) < 0.006
          || lineDistance(normalizedX, normalizedY, 0.56, 0.76, 0.78, 0.66) < 0.006) add(warm, 0.85);
      }

      pixels[offset] = clampByte(r);
      pixels[offset + 1] = clampByte(g);
      pixels[offset + 2] = clampByte(b);
    }
  }

  return Buffer.concat([header, pixels]);
}

function buildWaveformCardFrameBuffer(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, seed = '') {
  const hash = Buffer.from(String(seed || 'podcast-wave'));
  const palettes = [
    [[15, 18, 22], [26, 39, 42], [116, 217, 159]],
    [[17, 19, 24], [38, 40, 57], [116, 183, 255]],
    [[18, 20, 23], [45, 39, 34], [239, 189, 106]],
    [[13, 21, 23], [25, 50, 54], [128, 205, 193]],
  ];
  const [startColor, endColor, accentColor] = palettes[(hash[0] || 0) % palettes.length];
  const [r1, g1, b1] = startColor;
  const [r2, g2, b2] = endColor;
  const [ar, ag, ab] = accentColor;
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
  const pixels = Buffer.alloc(width * height * 3);
  const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
  const waveLeft = 0.12;
  const waveRight = 0.88;
  const waveTop = 0.47;
  const waveBottom = 0.72;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const normalizedX = x / Math.max(1, width - 1);
      const normalizedY = y / Math.max(1, height - 1);
      const t = (normalizedX * 0.55) + (normalizedY * 0.45);
      const centerGlow = Math.max(0, 1 - Math.hypot(normalizedX - 0.5, normalizedY - 0.52) * 1.45);
      const topGlow = Math.max(0, 1 - Math.hypot(normalizedX - 0.25, normalizedY - 0.16) * 2.1);
      const diagonal = Math.max(0, 1 - Math.abs(normalizedY - (0.16 + (normalizedX * 0.14))) / 0.01);
      const grid = ((x + (hash[1] || 0)) % 80 < 2 || (y + (hash[2] || 0)) % 80 < 2) ? 1 : 0;
      const inWavePanel = normalizedX >= waveLeft && normalizedX <= waveRight && normalizedY >= waveTop && normalizedY <= waveBottom;
      const wavePanelEdge = inWavePanel && (
        normalizedX < waveLeft + 0.004
        || normalizedX > waveRight - 0.004
        || normalizedY < waveTop + 0.006
        || normalizedY > waveBottom - 0.006
      );
      const lowerBand = normalizedY > 0.80 ? 1 : 0;
      const vignette = Math.hypot(normalizedX - 0.5, normalizedY - 0.5) * 30;
      const offset = (y * width + x) * 3;

      pixels[offset] = clampByte(
        r1 + ((r2 - r1) * t) + (centerGlow * 14) + (topGlow * 16) + (grid * 7)
        + (diagonal * ar * 0.24) + (wavePanelEdge ? ar * 0.36 : 0) - (inWavePanel ? 10 : 0)
        - (lowerBand * 4) - vignette,
      );
      pixels[offset + 1] = clampByte(
        g1 + ((g2 - g1) * t) + (centerGlow * 17) + (topGlow * 14) + (grid * 7)
        + (diagonal * ag * 0.24) + (wavePanelEdge ? ag * 0.36 : 0) - (inWavePanel ? 10 : 0)
        - (lowerBand * 4) - vignette,
      );
      pixels[offset + 2] = clampByte(
        b1 + ((b2 - b1) * t) + (centerGlow * 16) + (topGlow * 18) + (grid * 7)
        + (diagonal * ab * 0.24) + (wavePanelEdge ? ab * 0.36 : 0) - (inWavePanel ? 8 : 0)
        - (lowerBand * 4) - vignette,
      );
    }
  }

  return Buffer.concat([header, pixels]);
}

function buildWaveformFilterGraph(dimensions = {}) {
  const width = Math.max(1, Number(dimensions.width) || DEFAULT_WIDTH);
  const height = Math.max(1, Number(dimensions.height) || DEFAULT_HEIGHT);
  const waveWidth = Math.max(320, Math.round(width * 0.76));
  const waveHeight = Math.max(96, Math.round(height * 0.22));
  const waveX = Math.round((width - waveWidth) / 2);
  const waveY = Math.round(height * 0.485);

  return [
    `[1:a]aformat=channel_layouts=mono,showwaves=s=${waveWidth}x${waveHeight}:mode=line:rate=${DEFAULT_FPS}:colors=0x74D99F,format=rgba[wave]`,
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[bg]`,
    `[bg][wave]overlay=x=${waveX}:y=${waveY}:shortest=1,format=yuv420p[v]`,
  ].join(';');
}

function buildCornerWaveformOverlayGraph(dimensions = {}, {
  videoInput = '0:v',
  audioInput = '1:a',
  output = 'v',
} = {}) {
  const width = Math.max(1, Number(dimensions.width) || DEFAULT_WIDTH);
  const height = Math.max(1, Number(dimensions.height) || DEFAULT_HEIGHT);
  const isPortrait = height > width;
  const margin = Math.max(24, Math.round(Math.min(width, height) * 0.035));
  const padding = Math.max(10, Math.round(Math.min(width, height) * 0.014));
  const waveWidth = Math.max(isPortrait ? 250 : 230, Math.round(width * (isPortrait ? 0.34 : 0.22)));
  const waveHeight = Math.max(52, Math.round(height * (isPortrait ? 0.038 : 0.07)));
  const panelWidth = waveWidth + (padding * 2);
  const panelHeight = waveHeight + (padding * 2);
  const panelX = Math.max(margin, width - panelWidth - margin);
  const panelY = Math.max(margin, height - panelHeight - margin);
  const waveX = panelX + padding;
  const waveY = panelY + padding;

  return [
    `[${videoInput}]drawbox=x=${panelX}:y=${panelY}:w=${panelWidth}:h=${panelHeight}:color=white@0.72:t=fill,drawbox=x=${panelX}:y=${panelY}:w=${panelWidth}:h=${panelHeight}:color=0x17202A@0.24:t=3[wavebase]`,
    `[${audioInput}]aformat=channel_layouts=mono,showwaves=s=${waveWidth}x${waveHeight}:mode=line:rate=${DEFAULT_FPS}:colors=0x167A66,format=rgba[cornerwave]`,
    `[wavebase][cornerwave]overlay=x=${waveX}:y=${waveY}:shortest=1,format=yuv420p[${output}]`,
  ].join(';');
}

function analyzePpmImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32 || buffer.slice(0, 2).toString('ascii') !== 'P6') {
    return null;
  }

  const headerEnd = buffer.indexOf(Buffer.from('\n255\n', 'ascii'));
  if (headerEnd < 0) {
    return null;
  }

  const header = buffer.slice(0, headerEnd + 5).toString('ascii');
  const match = header.match(/^P6\s+(\d+)\s+(\d+)\s+255\s/s);
  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixelData = buffer.slice(headerEnd + 5);
  const pixelCount = Math.floor(pixelData.length / 3);
  if (!width || !height || pixelCount <= 0) {
    return null;
  }

  const stride = Math.max(1, Math.floor(pixelCount / 512));
  let samples = 0;
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += stride) {
    const offset = pixelIndex * 3;
    const r = pixelData[offset];
    const g = pixelData[offset + 1];
    const b = pixelData[offset + 2];
    minR = Math.min(minR, r);
    minG = Math.min(minG, g);
    minB = Math.min(minB, b);
    maxR = Math.max(maxR, r);
    maxG = Math.max(maxG, g);
    maxB = Math.max(maxB, b);
    sumR += r;
    sumG += g;
    sumB += b;
    samples += 1;
  }

  return {
    width,
    height,
    range: Math.max(maxR - minR, maxG - minG, maxB - minB),
    avgR: sumR / samples,
    avgG: sumG / samples,
    avgB: sumB / samples,
  };
}

function isLikelyBadSceneImage(image = {}) {
  const buffer = image?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return true;
  }

  const head = buffer.slice(0, Math.min(buffer.length, 256)).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<title>error')) {
    return true;
  }

  const ppm = analyzePpmImage(buffer);
  if (!ppm) {
    return false;
  }

  return isLikelyBadPpmImage(ppm);
}

function isLikelyBadPpmImage(ppm = {}) {
  if (!ppm || Number(ppm.width) <= 8 || Number(ppm.height) <= 8) {
    return true;
  }

  const avgLuma = ((Number(ppm.avgR) || 0) + (Number(ppm.avgG) || 0) + (Number(ppm.avgB) || 0)) / 3;
  const mostlyBlue = ppm.avgB > 150 && ppm.avgR < 110 && ppm.avgG < 160;
  const mostlyPink = ppm.avgR > 180 && ppm.avgB > 140 && ppm.avgG < 150;
  const mostlyDark = avgLuma < 30 || (avgLuma < 45 && ppm.range < 28);
  return ppm.range < 12 || mostlyDark || (ppm.range < 28 && (mostlyBlue || mostlyPink));
}

function isUsableSceneImage(image = {}) {
  return Boolean(image?.buffer?.length) && !isLikelyBadSceneImage(image);
}

function escapeConcatPath(filePath = '') {
  return String(filePath || '').replace(/\\/g, '/').replace(/'/g, "'\\''");
}

class PodcastVideoService {
  constructor(dependencies = {}) {
    this.createResponse = dependencies.createResponse || createResponse;
    this.generateImageBatch = dependencies.generateImageBatch || generateImageBatch;
    this.transcriptionService = dependencies.transcriptionService || transcriptionService;
    this.audioProcessingService = dependencies.audioProcessingService || audioProcessingService;
    this.artifactService = dependencies.artifactService || artifactService;
    this.artifactStore = dependencies.artifactStore || artifactStore;
    this.searchImages = dependencies.searchImages || searchImages;
    this.isUnsplashConfigured = dependencies.isUnsplashConfigured || isUnsplashConfigured;
    this.spawn = dependencies.spawn || spawn;
    this.spawnSync = dependencies.spawnSync || spawnSync;
  }

  getEffectiveFfmpegPath() {
    if (typeof this.audioProcessingService?.getEffectiveBinaryPath === 'function') {
      return this.audioProcessingService.getEffectiveBinaryPath();
    }
    return config.audioProcessing?.ffmpegBinaryPath || 'ffmpeg';
  }

  getPublicConfig() {
    const diagnostics = this.audioProcessingService?.getPublicConfig?.() || {};
    const ffmpegReady = diagnostics?.configured === true;
    const runtime = resolvePodcastVideoRuntimeOptions();
    return {
      configured: ffmpegReady,
      provider: 'ffmpeg',
      supportsMp4: ffmpegReady,
      supportsUnsplash: this.isUnsplashConfigured(),
      supportsGeneratedImages: Boolean(config.openai?.apiKey || config.media?.apiKey),
      defaults: {
        aspectRatio: '16:9',
        fps: DEFAULT_FPS,
        sceneSeconds: DEFAULT_SCENE_SECONDS,
        sceneCount: resolveDefaultStoryboardSceneCount(),
        maxScenes: MAX_SCENES,
        renderMode: runtime.renderMode,
        mixedGeneratedImageRatio: resolveMixedGeneratedImageRatio(),
        audioRepairEnabled: config.podcastVideo?.audioRepairEnabled === true,
        visualEffectsEnabled: config.podcastVideo?.visualEffectsEnabled !== false,
      },
      timeouts: {
        segmentMs: runtime.segmentTimeoutMs,
        muxMs: runtime.muxTimeoutMs,
        maxFfmpegMs: runtime.maxFfmpegTimeoutMs,
      },
      encoder: {
        container: 'mp4',
        videoCodec: 'h264-avc',
        codecTag: runtime.codecTag,
        profile: runtime.x264Profile,
        level: runtime.x264Level,
        preset: runtime.x264Preset,
        crf: runtime.x264Crf,
        pixelFormat: 'yuv420p',
        audioCodec: 'aac',
      },
      diagnostics: diagnostics?.diagnostics || diagnostics,
    };
  }

  assertFfmpegReady() {
    if (typeof this.audioProcessingService?.assertConfigured === 'function') {
      this.audioProcessingService.assertConfigured();
      return;
    }

    const result = this.spawnSync(this.getEffectiveFfmpegPath(), ['-version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (result?.error || result?.status !== 0) {
      throw createServiceError(503, result?.error?.message || 'ffmpeg is not reachable.', 'video_processing_unavailable');
    }
  }

  async runFfmpeg(args = [], options = {}) {
    this.assertFfmpegReady();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || Number(config.audioProcessing?.timeoutMs) || 120000);
    const binaryPath = this.getEffectiveFfmpegPath();
    const stage = sanitizeText(options.stage || 'rendering podcast video') || 'rendering podcast video';

    return new Promise((resolve, reject) => {
      const stderr = [];
      const stdout = [];
      let settled = false;
      const rejectOnce = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const resolveOnce = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const child = this.spawn(binaryPath, args, {
        windowsHide: true,
      });
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_error) {
          // The process may have exited between the timer firing and kill.
        }
        rejectOnce(createServiceError(
          504,
          `ffmpeg timed out while rendering podcast video (${stage}, ${timeoutMs}ms).`,
          'video_processing_timeout',
        ));
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
      child.on('error', (error) => {
        clearTimeout(timeout);
        rejectOnce(createServiceError(503, error.message || 'ffmpeg could not be started.', 'video_processing_unavailable'));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolveOnce({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
          return;
        }

        rejectOnce(createServiceError(
          502,
          `ffmpeg failed to render podcast video. ${Buffer.concat(stderr).toString('utf8').trim()}`.trim(),
          'video_processing_failed',
        ));
      });
    });
  }

  buildPodcastVideoAudioArgs({ enhanceAudio = false } = {}) {
    const args = [];
    if (normalizeVideoAudioRepair(enhanceAudio)
      && typeof this.audioProcessingService?.buildPodcastMasteringFilter === 'function') {
      args.push('-af', this.audioProcessingService.buildPodcastMasteringFilter({ sampleRate: 48000 }));
    }

    args.push(
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-ar', '48000',
    );

    return args;
  }

  async readAudioArtifact(artifactId = '') {
    const normalizedId = String(artifactId || '').trim();
    if (!normalizedId) {
      throw createServiceError(400, 'An audioArtifactId is required.', 'audio_artifact_required');
    }

    if (isLocalGeneratedAudioArtifactId(normalizedId)) {
      const localArtifact = await getLocalGeneratedAudioArtifact(normalizedId, { includeContent: true });
      if (!localArtifact?.contentBuffer?.length) {
        throw createServiceError(404, 'Audio artifact not found.', 'audio_artifact_not_found');
      }
      return localArtifact;
    }

    const artifact = await this.artifactStore.get(normalizedId, { includeContent: true });
    if (!artifact?.contentBuffer?.length) {
      throw createServiceError(404, 'Audio artifact not found.', 'audio_artifact_not_found');
    }

    return artifact;
  }

  getAudioDurationFromWavBuffer(audioBuffer) {
    try {
      const parsed = parseWavBuffer(audioBuffer);
      const bytesPerSampleFrame = (parsed.bitsPerSample / 8) * parsed.numChannels;
      if (!bytesPerSampleFrame || !parsed.sampleRate) {
        return 0;
      }
      return parsed.data.length / bytesPerSampleFrame / parsed.sampleRate;
    } catch (_error) {
      return 0;
    }
  }

  async getAudioDurationSeconds(audioBuffer, mimeType = 'audio/wav') {
    const wavDuration = this.getAudioDurationFromWavBuffer(audioBuffer);
    if (wavDuration > 0) {
      return wavDuration;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-audio-duration-'));
    const extension = String(mimeType || '').toLowerCase().includes('mpeg') ? 'mp3' : 'audio';
    const inputPath = path.join(tempDir, `input.${extension}`);

    try {
      await fs.writeFile(inputPath, audioBuffer);
      const result = await this.runFfmpeg(['-i', inputPath, '-f', 'null', '-'], {
        timeoutMs: 30000,
      }).catch((error) => {
        const stderr = String(error?.message || '');
        const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
        if (!match) {
          throw error;
        }
        return { stderr };
      });
      const match = String(result?.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      if (!match) {
        return 0;
      }
      return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async planStoryboard(params = {}) {
    const title = sanitizeText(params.title || params.topic || 'Podcast video');
    const transcript = sanitizeText(params.transcript || params.script?.transcript || '');
    const turns = Array.isArray(params.turns)
      ? params.turns
      : Array.isArray(params.script?.turns)
        ? params.script.turns
        : [];
    const durationSeconds = Math.max(0, Number(params.durationSeconds || params.duration_seconds || 0) || 0);
    const sceneCount = Number.isFinite(Number(params.sceneCount)) && Number(params.sceneCount) > 0
      ? clampNumber(params.sceneCount, 1, MAX_SCENES, resolveDefaultStoryboardSceneCount())
      : undefined;
    const visualStyle = sanitizeText(params.visualStyle || params.style || '');

    if (!transcript && turns.length === 0) {
      throw createServiceError(400, 'A transcript or script turns are required to plan a podcast video.', 'podcast_video_transcript_required');
    }

    if (params.useModel === false) {
      return {
        title,
        durationSeconds,
        scenes: retimeScenesToDuration(
          buildFallbackStoryboard({ title, transcript, turns, durationSeconds, sceneCount }),
          durationSeconds,
        ),
        planning: {
          provider: 'local',
          model: null,
        },
      };
    }

    try {
      const response = await this.createResponse({
        input: buildStoryboardPrompt({
          title,
          transcript,
          turns,
          durationSeconds,
          sceneCount,
          visualStyle,
        }),
        instructions: 'You create practical podcast video storyboards and return valid JSON only.',
        stream: false,
        model: params.model || undefined,
        reasoningEffort: params.reasoningEffort || undefined,
        enableAutomaticToolCalls: false,
        requestTimeoutMs: Math.max(30000, Number(params.planTimeoutMs) || 90000),
        requestMaxRetries: 0,
      });
      const parsed = parseLenientJson(getResponseText(response));
      const scenes = (Array.isArray(parsed?.scenes) ? parsed.scenes : [])
        .slice(0, MAX_SCENES)
        .map((scene, index) => normalizeScene(scene, index));

      if (scenes.length > 0) {
        return {
          title: sanitizeText(parsed?.title || title) || title,
          durationSeconds,
          scenes: retimeScenesToDuration(scenes, durationSeconds),
          planning: {
            provider: 'model',
            model: response?.model || params.model || null,
          },
        };
      }
    } catch (error) {
      console.warn(`[PodcastVideo] Falling back to local storyboard planning: ${error.message}`);
    }

    return {
      title,
      durationSeconds,
      scenes: retimeScenesToDuration(
        buildFallbackStoryboard({ title, transcript, turns, durationSeconds, sceneCount }),
        durationSeconds,
      ),
      planning: {
        provider: 'local-fallback',
        model: null,
      },
    };
  }

  async suggestStockSources(scenes = [], { orientation = 'landscape' } = {}) {
    if (!this.isUnsplashConfigured()) return [];
    const suggestions = [];
    for (const scene of (Array.isArray(scenes) ? scenes : []).slice(0, 12)) {
      const query = sanitizeText(scene.visualQuery || scene.summary || scene.caption || '').slice(0, 180);
      if (!query) continue;
      try {
        const results = await this.searchImages(query, { page: 1, perPage: 1, orientation });
        const image = results?.results?.[0];
        const imageUrl = image?.urls?.regular || image?.urls?.full || image?.urls?.small || '';
        if (!imageUrl) continue;
        suggestions.push({
          sceneId: scene.id,
          query,
          source: 'unsplash',
          imageUrl,
          thumbnailUrl: image?.urls?.small || imageUrl,
          alt: image?.altDescription || image?.description || scene.summary || '',
          attribution: image?.author ? {
            name: image.author.name,
            username: image.author.username,
            link: image.author.link,
            sourceUrl: image.links?.html || null,
          } : null,
        });
      } catch (error) {
        console.warn(`[PodcastVideo] Unsplash source suggestion failed for ${scene.id || 'scene'}: ${error.message}`);
      }
    }
    return suggestions;
  }

  async downloadImage(url = '') {
    const decoded = decodeDataUrl(url);
    if (decoded) {
      return decoded;
    }

    const normalizedUrl = String(url || '').trim();
    if (!/^https?:\/\//i.test(normalizedUrl) || typeof fetch !== 'function') {
      return null;
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 20000) : null;
    try {
      const response = await fetch(normalizedUrl, {
        headers: { Accept: 'image/*' },
        signal: controller?.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        mimeType: contentType.split(';')[0] || 'image/jpeg',
        extension: inferImageExtension(contentType, normalizedUrl),
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async resolveWebSearchImage(scene = {}, options = {}) {
    const executeTool = typeof options.toolManager?.executeTool === 'function'
      ? options.toolManager.executeTool.bind(options.toolManager)
      : null;
    if (!executeTool) {
      return null;
    }

    try {
      const search = await executeTool('web-search', {
        query: `${scene.visualQuery || scene.summary} photo image`,
        researchMode: 'search',
        limit: 4,
        safeSearch: true,
        includeSnippets: true,
        includeUrls: true,
      }, options.toolContext || {});
      const results = Array.isArray(search?.data?.results)
        ? search.data.results
        : Array.isArray(search?.results)
          ? search.results
          : [];

      for (const result of results.slice(0, 4)) {
        const resultUrl = String(result?.url || '').trim();
        if (!resultUrl) {
          continue;
        }

        if (isLikelyImageUrl(resultUrl)) {
          const direct = await this.downloadImage(resultUrl).catch(() => null);
          if (isUsableSceneImage(direct)) {
            return {
              ...direct,
              source: 'web-search',
              url: resultUrl,
              attribution: {
                name: result?.source || result?.title || '',
                sourceUrl: resultUrl,
              },
            };
          }
        }

        const fetched = await executeTool('web-fetch', {
          url: resultUrl,
          timeout: 12000,
          retries: 1,
          cache: true,
        }, options.toolContext || {}).catch(() => null);
        const body = String(fetched?.data?.body || fetched?.body || '');
        const pageUrl = String(fetched?.data?.url || fetched?.url || resultUrl);
        const imageUrls = extractImageUrlsFromHtml(body, pageUrl);

        for (const imageUrl of imageUrls.slice(0, 4)) {
          const downloaded = await this.downloadImage(imageUrl).catch(() => null);
          if (isUsableSceneImage(downloaded)) {
            return {
              ...downloaded,
              source: 'web-search',
              url: imageUrl,
              attribution: {
                name: result?.source || result?.title || '',
                sourceUrl: resultUrl,
              },
            };
          }
        }
      }
    } catch (error) {
      console.warn(`[PodcastVideo] Web-search image lookup failed for scene ${scene.id}: ${error.message}`);
    }

    return null;
  }

  async resolveSceneImage(scene = {}, options = {}) {
    const imageMode = normalizeImageMode(options.imageMode);
    const orientation = options.orientation || 'landscape';

    if (Buffer.isBuffer(scene.imageBuffer) && scene.imageBuffer.length > 0) {
      return {
        buffer: scene.imageBuffer,
        mimeType: scene.imageMimeType || 'image/png',
        extension: scene.imageExtension || 'png',
        source: scene.imageSource || 'provided',
        url: null,
        attribution: scene.attribution || null,
      };
    }

    if (scene.imageUrl) {
      const downloaded = await this.downloadImage(scene.imageUrl).catch(() => null);
      if (isUsableSceneImage(downloaded)) {
        return {
          ...downloaded,
          source: scene.imageSource || 'provided',
          url: scene.imageUrl,
          attribution: scene.attribution || null,
        };
      }
    }

    const resolveWebOrStockImage = async () => {
      const allowWebSearch = ['mixed', 'web'].includes(imageMode);
      if (allowWebSearch) {
        const webImage = await this.resolveWebSearchImage(scene, options);
        if (isUsableSceneImage(webImage)) {
          return webImage;
        }
      }

      const allowUnsplash = ['mixed', 'unsplash'].includes(imageMode);
      if (!allowUnsplash || !this.isUnsplashConfigured()) {
        return null;
      }

      try {
        const results = await this.searchImages(scene.visualQuery || scene.summary, {
          page: 1,
          perPage: 1,
          orientation,
        });
        const image = results?.results?.[0] || null;
        const imageUrl = image?.urls?.regular || image?.urls?.full || image?.urls?.small || '';
        const downloaded = await this.downloadImage(imageUrl);
        if (isUsableSceneImage(downloaded)) {
          return {
            ...downloaded,
            source: 'unsplash',
            url: imageUrl,
            attribution: image?.author ? {
              name: image.author.name,
              username: image.author.username,
              link: image.author.link,
              sourceUrl: image.links?.html || null,
            } : null,
            unsplash: image,
          };
        }
      } catch (error) {
        console.warn(`[PodcastVideo] Unsplash image lookup failed for scene ${scene.id}: ${error.message}`);
      }

      return null;
    };

    const resolveGeneratedImage = async () => {
      const allowGenerated = ['mixed', 'generated'].includes(imageMode) && options.generateImages === true;
      if (!allowGenerated) {
        return null;
      }

      try {
        const maxAttempts = Math.max(1, Math.min(3, Number(options.imageRetryAttempts) || 3));
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const response = await this.generateImageBatch({
            prompt: buildSceneImagePrompt(scene, {
              orientation,
            }),
            model: options.imageModel || null,
            size: options.imageSize || (orientation === 'portrait' ? '1024x1536' : '1536x1024'),
            quality: options.imageQuality || 'auto',
            background: 'opaque',
            n: 1,
          });
          const generatedImage = response?.data?.[0] || null;
          const downloaded = await this.downloadImage(generatedImage?.url || '');
          if (isUsableSceneImage(downloaded)) {
            return {
              ...downloaded,
              source: 'generated',
              url: generatedImage?.url || null,
              attribution: null,
              revisedPrompt: generatedImage?.revised_prompt || null,
              retryCount: attempt,
            };
          }
          console.warn(`[PodcastVideo] Rejected low-quality generated image for scene ${scene.id}; retry ${attempt + 1}/${maxAttempts}.`);
        }
      } catch (error) {
        console.warn(`[PodcastVideo] Generated image failed for scene ${scene.id}: ${error.message}`);
      }

      return null;
    };

    const preferGenerated = imageMode === 'generated'
      || (imageMode === 'mixed' && options.generateImages === true && shouldPreferGeneratedInMixedMode(scene, options));
    if (preferGenerated) {
      const generatedImage = await resolveGeneratedImage();
      if (isUsableSceneImage(generatedImage)) {
        return generatedImage;
      }
    }

    const webOrStockImage = await resolveWebOrStockImage();
    if (isUsableSceneImage(webOrStockImage)) {
      return webOrStockImage;
    }

    if (!preferGenerated) {
      const generatedImage = await resolveGeneratedImage();
      if (isUsableSceneImage(generatedImage)) {
        return generatedImage;
      }
    }

    return {
      buffer: buildPlaceholderFrameBuffer(options.width, options.height, scene.visualPrompt || scene.summary),
      mimeType: 'image/x-portable-pixmap',
      extension: 'ppm',
      source: 'fallback',
      url: null,
      attribution: null,
    };
  }

  async prepareSceneImages(scenes = [], options = {}) {
    const assets = [];
    let lastUsableAsset = null;
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      const image = await this.resolveSceneImage(scene, options);
      const filePath = path.join(options.tempDir, `scene-${String(index + 1).padStart(3, '0')}.${image.extension || 'png'}`);
      await fs.writeFile(filePath, image.buffer);

      const usableVisual = await this.validateSceneImageFile(filePath, image, scene, {
        ...options,
        index,
      });
      if ((!usableVisual.usable || image.source === 'fallback') && lastUsableAsset) {
        assets.push({
          ...lastUsableAsset,
          source: lastUsableAsset.source === 'fallback' ? 'fallback' : `${lastUsableAsset.source || 'visual'}-reused`,
          reusedFromScene: lastUsableAsset.sceneId || null,
          replacedSource: image.source || 'unknown',
        });
        continue;
      }

      if (!usableVisual.usable) {
        const fallbackImage = {
          buffer: buildPlaceholderFrameBuffer(options.width, options.height, scene.visualPrompt || scene.summary),
          mimeType: 'image/x-portable-pixmap',
          extension: 'ppm',
          source: 'fallback',
          url: null,
          attribution: null,
          replacedSource: image.source || 'unknown',
        };
        const fallbackPath = path.join(options.tempDir, `scene-${String(index + 1).padStart(3, '0')}-fallback.ppm`);
        await fs.writeFile(fallbackPath, fallbackImage.buffer);
        assets.push({
          ...fallbackImage,
          path: fallbackPath,
        });
        continue;
      }

      assets.push({
        ...image,
        path: filePath,
      });
      if (image.source !== 'fallback') {
        lastUsableAsset = {
          ...image,
          path: filePath,
          sceneId: scene.id || null,
        };
      }
    }
    return assets;
  }

  async validateSceneImageFile(filePath = '', image = {}, scene = {}, options = {}) {
    if (image.extension === 'ppm') {
      return { usable: isUsableSceneImage(image), reason: 'ppm-analysis' };
    }

    if (!options.tempDir) {
      return { usable: true, reason: 'no-temp-dir' };
    }

    const previewPath = path.join(
      options.tempDir,
      `scene-${String((Number(options.index) || 0) + 1).padStart(3, '0')}-preview.ppm`,
    );
    try {
      await this.runFfmpeg([
        '-y',
        '-i', filePath,
        '-frames:v', '1',
        '-vf', 'scale=64:36:force_original_aspect_ratio=decrease,pad=64:36:(ow-iw)/2:(oh-ih)/2',
        previewPath,
      ], {
        timeoutMs: 30000,
        stage: `scene ${Number(options.index) + 1 || 1} image validation`,
      });

      const previewBuffer = await fs.readFile(previewPath);
      const ppm = analyzePpmImage(previewBuffer);
      if (ppm && isLikelyBadPpmImage(ppm)) {
        console.warn(`[PodcastVideo] Replacing unusable scene image for ${scene.id || 'scene'} (${image.source || 'unknown'}).`);
        return { usable: false, reason: 'dark-or-solid-image', analysis: ppm };
      }
    } catch (error) {
      console.warn(`[PodcastVideo] Scene image validation failed for ${scene.id || 'scene'}: ${error.message}`);
    }

    return { usable: true, reason: 'validated' };
  }

  async renderStaticCardMp4({
    audioPath,
    outputPath,
    tempDir,
    scenes = [],
    title = 'Podcast video',
    transcript = '',
    durationSeconds = 0,
    dimensions,
    imageMode = 'mixed',
    generateImages = false,
    imageModel = null,
    generatedImageRatio = null,
    enhanceAudio = false,
    visualEffects = true,
    runtime,
    toolManager = null,
    toolContext = {},
  } = {}) {
    const showCardScene = buildShowCardScene({
      title,
      transcript,
      scenes,
      durationSeconds,
    });
    const image = await this.resolveSceneImage(showCardScene, {
      tempDir,
      width: dimensions.width,
      height: dimensions.height,
      orientation: dimensions.orientation,
      imageMode,
      generateImages,
      imageModel,
      generatedImageRatio,
      toolManager,
      toolContext,
    });
    const imagePath = path.join(tempDir, `show-card.${image.extension || 'png'}`);
    await fs.writeFile(imagePath, image.buffer);
    const validation = await this.validateSceneImageFile(imagePath, image, showCardScene, {
      tempDir,
      width: dimensions.width,
      height: dimensions.height,
      index: 0,
    });
    const finalImage = validation.usable ? image : {
      buffer: buildPlaceholderFrameBuffer(dimensions.width, dimensions.height, showCardScene.visualPrompt || showCardScene.summary),
      mimeType: 'image/x-portable-pixmap',
      extension: 'ppm',
      source: 'fallback',
      url: null,
      attribution: null,
      replacedSource: image.source || 'unknown',
    };
    const finalImagePath = validation.usable
      ? imagePath
      : path.join(tempDir, 'show-card-fallback.ppm');
    if (!validation.usable) {
      await fs.writeFile(finalImagePath, finalImage.buffer);
    }
    const slideFilter = `[0:v]${buildBackgroundVideoFilter(dimensions, { duration: durationSeconds }, 0, visualEffects)}[slide]`;
    const overlayFilter = buildCornerWaveformOverlayGraph(dimensions, {
      videoInput: 'slide',
      audioInput: '1:a',
      output: 'v',
    });

    await this.runFfmpeg([
      '-y',
      '-loop', '1',
      '-framerate', String(DEFAULT_FPS),
      '-i', finalImagePath,
      '-i', audioPath,
      '-filter_complex', `${slideFilter};${overlayFilter}`,
      '-map', '[v]',
      '-map', '1:a:0',
      '-shortest',
      '-r', String(DEFAULT_FPS),
      ...buildCompatibleH264VideoArgs(runtime),
      ...this.buildPodcastVideoAudioArgs({ enhanceAudio }),
      '-movflags', '+faststart',
      outputPath,
    ], {
      timeoutMs: resolveAdaptiveFfmpegTimeoutMs(runtime.muxTimeoutMs, durationSeconds, {
        fixedMs: 120000,
        perSecondMs: 1000,
        maxTimeoutMs: runtime.maxFfmpegTimeoutMs,
      }),
      stage: 'static show-card render',
    });

    return {
      source: finalImage.source || 'fallback',
      url: finalImage.url || null,
      attribution: finalImage.attribution || null,
      revisedPrompt: finalImage.revisedPrompt || null,
    };
  }

  async renderWaveformCardMp4({
    audioPath,
    outputPath,
    tempDir,
    title = 'Podcast video',
    durationSeconds = 0,
    dimensions,
    enhanceAudio = false,
    runtime,
  } = {}) {
    const cardPath = path.join(tempDir, 'waveform-card.ppm');
    await fs.writeFile(cardPath, buildWaveformCardFrameBuffer(
      dimensions.width,
      dimensions.height,
      title,
    ));

    await this.runFfmpeg([
      '-y',
      '-loop', '1',
      '-framerate', String(DEFAULT_FPS),
      '-i', cardPath,
      '-i', audioPath,
      '-filter_complex', buildWaveformFilterGraph(dimensions),
      '-map', '[v]',
      '-map', '1:a:0',
      '-shortest',
      '-r', String(DEFAULT_FPS),
      ...buildCompatibleH264VideoArgs(runtime),
      ...this.buildPodcastVideoAudioArgs({ enhanceAudio }),
      '-movflags', '+faststart',
      outputPath,
    ], {
      timeoutMs: resolveAdaptiveFfmpegTimeoutMs(runtime.muxTimeoutMs, durationSeconds, {
        fixedMs: 120000,
        perSecondMs: 1000,
        maxTimeoutMs: runtime.maxFfmpegTimeoutMs,
      }),
      stage: 'waveform-card render',
    });

    return {
      source: 'waveform-card',
      url: null,
      attribution: null,
    };
  }

  async renderMp4({
    audioBuffer,
    audioMimeType = 'audio/wav',
    scenes = [],
    title = 'Podcast video',
    aspectRatio = '16:9',
    imageMode = 'mixed',
    generateImages = false,
    imageModel = null,
    generatedImageRatio = null,
    ffmpegTimeoutMs = null,
    segmentTimeoutMs = null,
    muxTimeoutMs = null,
    maxFfmpegTimeoutMs = null,
    x264Preset = null,
    x264Crf = null,
    renderMode = null,
    enhanceAudio = false,
    visualEffects = true,
    toolManager = null,
    toolContext = {},
  } = {}) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      throw createServiceError(400, 'An audio buffer is required to render podcast video.', 'podcast_video_audio_required');
    }
    const normalizedScenes = (Array.isArray(scenes) ? scenes : [])
      .slice(0, MAX_SCENES)
      .map((scene, index) => normalizeScene(scene, index));
    if (normalizedScenes.length === 0) {
      throw createServiceError(400, 'At least one storyboard scene is required to render podcast video.', 'podcast_video_scenes_required');
    }

    const dimensions = normalizeAspectRatio(aspectRatio);
    const runtime = resolvePodcastVideoRuntimeOptions({
      ffmpegTimeoutMs,
      segmentTimeoutMs,
      muxTimeoutMs,
      maxFfmpegTimeoutMs,
      x264Preset,
      x264Crf,
      renderMode,
    });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-podcast-video-'));
    const audioExtension = String(audioMimeType || '').toLowerCase().includes('mpeg') ? 'mp3' : 'wav';
    const audioPath = path.join(tempDir, `podcast-audio.${audioExtension}`);
    const concatPath = path.join(tempDir, 'segments.txt');
    const outputPath = path.join(tempDir, `${slugify(title)}.mp4`);

    try {
      await fs.writeFile(audioPath, audioBuffer);
      const totalDurationSeconds = normalizedScenes.reduce(
        (sum, scene) => sum + Math.max(MIN_SCENE_SECONDS, Number(scene.duration) || 0),
        0,
      );

      if (runtime.renderMode === 'waveform-card') {
        const image = await this.renderWaveformCardMp4({
          audioPath,
          outputPath,
          tempDir,
          title,
          durationSeconds: totalDurationSeconds,
          dimensions,
          enhanceAudio,
          runtime,
        });

        return {
          buffer: await fs.readFile(outputPath),
          scenes: normalizedScenes.map((scene) => ({
            ...scene,
            image,
          })),
          dimensions,
          renderMode: runtime.renderMode,
          audioRepairEnabled: normalizeVideoAudioRepair(enhanceAudio),
          visualEffectsEnabled: false,
        };
      }

      if (runtime.renderMode === 'static-card') {
        const image = await this.renderStaticCardMp4({
          audioPath,
          outputPath,
          tempDir,
          scenes: normalizedScenes,
          title,
          transcript: normalizedScenes.map((scene) => scene.narration || scene.caption || '').join(' '),
          durationSeconds: totalDurationSeconds,
          dimensions,
          imageMode,
          generateImages,
          imageModel,
          generatedImageRatio,
          enhanceAudio,
          visualEffects: normalizeVisualEffects(visualEffects),
          runtime,
          toolManager,
          toolContext,
        });

        return {
          buffer: await fs.readFile(outputPath),
          scenes: normalizedScenes.map((scene) => ({
            ...scene,
            image,
          })),
          dimensions,
          renderMode: runtime.renderMode,
          audioRepairEnabled: normalizeVideoAudioRepair(enhanceAudio),
          visualEffectsEnabled: normalizeVisualEffects(visualEffects),
          audioWaveformOverlayEnabled: true,
        };
      }

      const imageAssets = await this.prepareSceneImages(normalizedScenes, {
        tempDir,
        width: dimensions.width,
        height: dimensions.height,
        orientation: dimensions.orientation,
        imageMode,
        generateImages,
        imageModel,
        generatedImageRatio,
        toolManager,
        toolContext,
      });
      const applyVisualEffects = normalizeVisualEffects(visualEffects);
      const segmentPaths = [];
      for (let index = 0; index < normalizedScenes.length; index += 1) {
        const scene = normalizedScenes[index];
        const asset = imageAssets[index];
        const segmentPath = path.join(tempDir, `segment-${String(index + 1).padStart(3, '0')}.mp4`);
        segmentPaths.push(segmentPath);
        await this.runFfmpeg([
          '-y',
          '-loop', '1',
          '-framerate', String(DEFAULT_FPS),
          '-t', String(Math.max(MIN_SCENE_SECONDS, scene.duration).toFixed(3)),
          '-i', asset.path,
          '-vf', buildBackgroundVideoFilter(dimensions, scene, index, applyVisualEffects),
          '-r', String(DEFAULT_FPS),
          '-an',
          ...buildCompatibleH264VideoArgs(runtime),
          segmentPath,
        ], {
          timeoutMs: resolveAdaptiveFfmpegTimeoutMs(runtime.segmentTimeoutMs, scene.duration, {
            fixedMs: 60000,
            perSecondMs: 2000,
            maxTimeoutMs: runtime.maxFfmpegTimeoutMs,
          }),
          stage: `scene ${index + 1}/${normalizedScenes.length}`,
        });
      }

      await fs.writeFile(
        concatPath,
        segmentPaths.map((segmentPath) => `file '${escapeConcatPath(segmentPath)}'`).join('\n'),
        'utf8',
      );
      await this.runFfmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatPath,
        '-i', audioPath,
        '-filter_complex', buildCornerWaveformOverlayGraph(dimensions, {
          videoInput: '0:v',
          audioInput: '1:a',
          output: 'v',
        }),
        '-map', '[v]',
        '-map', '1:a:0',
        '-shortest',
        '-r', String(DEFAULT_FPS),
        ...buildCompatibleH264VideoArgs(runtime),
        ...this.buildPodcastVideoAudioArgs({ enhanceAudio }),
        '-movflags', '+faststart',
        outputPath,
      ], {
        timeoutMs: resolveAdaptiveFfmpegTimeoutMs(
          runtime.muxTimeoutMs,
          totalDurationSeconds,
          {
            fixedMs: 120000,
            perSecondMs: 1400,
            maxTimeoutMs: runtime.maxFfmpegTimeoutMs,
          },
        ),
        stage: 'final mux',
      });

      return {
        buffer: await fs.readFile(outputPath),
        scenes: normalizedScenes.map((scene, index) => ({
          ...scene,
          image: {
            source: imageAssets[index]?.source || 'fallback',
            url: imageAssets[index]?.url || null,
            attribution: imageAssets[index]?.attribution || null,
            revisedPrompt: imageAssets[index]?.revisedPrompt || null,
          },
        })),
        dimensions,
        renderMode: runtime.renderMode,
        audioRepairEnabled: normalizeVideoAudioRepair(enhanceAudio),
        visualEffectsEnabled: applyVisualEffects,
        audioWaveformOverlayEnabled: true,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async persistVideo({
    sessionId,
    title = 'Podcast video',
    videoBuffer,
    transcript = '',
    storyboard = null,
    metadata = {},
  } = {}) {
    if (!sessionId) {
      throw createServiceError(400, 'A sessionId is required to save podcast video.', 'session_required');
    }
    if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) {
      throw createServiceError(500, 'Podcast video render returned no bytes.', 'video_render_empty');
    }

    const filename = `${slugify(title)}.mp4`;
    let artifact = null;
    try {
      const stored = await this.artifactService.createStoredArtifact({
        sessionId,
        direction: 'generated',
        sourceMode: 'podcast-video',
        filename,
        extension: 'mp4',
        mimeType: 'video/mp4',
        buffer: videoBuffer,
        extractedText: transcript,
        previewHtml: '',
        metadata: {
          generatedBy: 'podcast-video',
          title,
          storyboard,
          ...metadata,
        },
        vectorize: Boolean(transcript),
      });
      artifact = this.artifactService.serializeArtifact(stored);
    } catch (error) {
      console.warn('[PodcastVideo] Artifact storage unavailable; saving generated video locally:', error.message);
      artifact = await persistGeneratedVideoLocally({
        sessionId,
        sourceMode: 'podcast-video',
        title,
        filename,
        videoBuffer,
        extractedText: transcript,
        metadata: {
          storyboard,
          ...metadata,
        },
      });
    }

    await updateGeneratedVideoSessionState(sessionId, [artifact]);
    const normalizedVideo = normalizeGeneratedVideoRecord(artifact);
    return {
      artifact,
      video: normalizedVideo || {
        artifactId: artifact.id,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        format: artifact.format,
        downloadUrl: buildArtifactDownloadPath(artifact.id),
        inlinePath: buildArtifactInlinePath(artifact.id),
        absoluteUrl: toAbsoluteInternalUrl(buildArtifactDownloadPath(artifact.id)),
        absoluteInlineUrl: toAbsoluteInternalUrl(buildArtifactInlinePath(artifact.id)),
      },
    };
  }

  async createVideo({
    sessionId,
    title = '',
    transcript = '',
    turns = [],
    audioBuffer,
    audioMimeType = 'audio/wav',
    options = {},
  } = {}) {
    const requestedRenderMode = normalizeRenderMode(
      options.renderMode || options.videoRenderMode || config.podcastVideo?.renderMode || DEFAULT_RENDER_MODE,
    );
    const resolvedTranscript = sanitizeText(transcript)
      || (Array.isArray(turns) ? turns.map((turn) => `${sanitizeText(turn?.speaker)}: ${sanitizeText(turn?.text)}`).join('\n') : '');
    if (!resolvedTranscript && requestedRenderMode !== 'waveform-card') {
      throw createServiceError(400, 'A transcript or script turns are required to create a podcast video.', 'podcast_video_transcript_required');
    }

    const durationSeconds = Number(options.durationSeconds)
      || await this.getAudioDurationSeconds(audioBuffer, audioMimeType)
      || 0;
    const imageMode = requestedRenderMode === 'waveform-card'
      ? 'fallback'
      : normalizeImageMode(options.imageMode || 'generated');
    const generateImages = requestedRenderMode === 'waveform-card'
      ? false
      : normalizeBooleanOption(
        options.generateImages,
        ['mixed', 'generated'].includes(imageMode),
      );
    const storyboard = Array.isArray(options.scenes) && options.scenes.length > 0
      ? {
        title: sanitizeText(title) || 'Podcast video',
        durationSeconds,
        scenes: retimeScenesToDuration(options.scenes, durationSeconds),
        planning: { provider: 'provided', model: null },
      }
      : requestedRenderMode === 'waveform-card'
        ? {
          title: sanitizeText(title) || 'Podcast wave',
          durationSeconds,
          scenes: buildFallbackStoryboard({
            title: sanitizeText(title) || 'Podcast wave',
            transcript: resolvedTranscript || sanitizeText(title) || 'Podcast audio waveform',
            durationSeconds,
            sceneCount: 1,
          }),
          planning: { provider: 'waveform-card', model: null },
        }
      : await this.planStoryboard({
        title,
        transcript: resolvedTranscript,
        turns,
        durationSeconds,
        sceneCount: options.sceneCount,
        visualStyle: options.visualStyle,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        useModel: options.useModel,
        planTimeoutMs: options.planTimeoutMs,
      });
    const rendered = await this.renderMp4({
      audioBuffer,
      audioMimeType,
      scenes: storyboard.scenes,
      title: storyboard.title || title,
      aspectRatio: options.aspectRatio || '16:9',
      imageMode,
      generateImages,
      imageModel: options.imageModel || null,
      generatedImageRatio: options.generatedImageRatio,
      ffmpegTimeoutMs: options.ffmpegTimeoutMs || options.videoFfmpegTimeoutMs || options.timeoutMs || null,
      segmentTimeoutMs: options.segmentTimeoutMs || options.videoSegmentTimeoutMs || null,
      muxTimeoutMs: options.muxTimeoutMs || options.videoMuxTimeoutMs || null,
      maxFfmpegTimeoutMs: options.maxFfmpegTimeoutMs || options.videoMaxFfmpegTimeoutMs || null,
      x264Preset: options.x264Preset || options.videoX264Preset || null,
      x264Crf: options.x264Crf || options.videoX264Crf || null,
      renderMode: requestedRenderMode,
      enhanceAudio: options.enhanceAudio ?? options.videoEnhanceAudio ?? options.repairAudio ?? options.cleanAudio,
      visualEffects: options.visualEffects ?? options.videoVisualEffects,
      toolManager: options.toolManager || null,
      toolContext: options.toolContext || {},
    });
    const persisted = await this.persistVideo({
      sessionId,
      title: storyboard.title || title,
      videoBuffer: rendered.buffer,
      transcript: resolvedTranscript,
      storyboard: {
        ...storyboard,
        scenes: rendered.scenes,
      },
      metadata: {
        topic: sanitizeText(options.topic || title),
        durationSeconds,
        dimensions: rendered.dimensions,
        renderMode: rendered.renderMode,
        audioRepairEnabled: rendered.audioRepairEnabled,
        visualEffectsEnabled: rendered.visualEffectsEnabled,
        audioWaveformOverlayEnabled: rendered.audioWaveformOverlayEnabled === true,
        imageMode,
        generatedImagesEnabled: generateImages,
        mixedGeneratedImageRatio: imageMode === 'mixed' && generateImages ? resolveMixedGeneratedImageRatio(options) : null,
      },
    });

    return {
      title: storyboard.title || title,
      durationSeconds,
      storyboard: {
        ...storyboard,
        scenes: rendered.scenes,
      },
      artifact: persisted.artifact,
      video: persisted.video,
    };
  }

  async createVideoFromAudioUpload({
    sessionId,
    file,
    fields = {},
  } = {}) {
    if (!file?.buffer?.length) {
      throw createServiceError(400, 'An audio file upload is required.', 'audio_upload_required');
    }

    let transcript = sanitizeText(fields.transcript || '');
    let transcription = null;
    const requestedRenderMode = normalizeRenderMode(
      fields.renderMode || fields.videoRenderMode || config.podcastVideo?.renderMode || DEFAULT_RENDER_MODE,
    );
    if (!transcript && requestedRenderMode !== 'waveform-card') {
      transcription = await this.transcriptionService.transcribe({
        audioBuffer: file.buffer,
        filename: file.filename || 'podcast-audio.wav',
        mimeType: file.mimeType || 'audio/wav',
        language: fields.language || '',
        prompt: fields.prompt || fields.topic || '',
        model: fields.transcriptionModel || '',
      });
      transcript = sanitizeText(transcription.text || '');
    }

    const hasGenerateImagesField = fields.generateImages != null && fields.generateImages !== '';
    return this.createVideo({
      sessionId,
      title: fields.title || fields.topic || file.filename || 'Podcast video',
      transcript,
      audioBuffer: file.buffer,
      audioMimeType: file.mimeType || 'audio/wav',
      options: {
        ...fields,
        renderMode: requestedRenderMode,
        transcription,
        sceneCount: Number(fields.sceneCount) || undefined,
        ...(hasGenerateImagesField ? { generateImages: normalizeBooleanOption(fields.generateImages, false) } : {}),
      },
    });
  }

  async createVideoFromAudioArtifact({
    sessionId,
    audioArtifactId,
    title = '',
    transcript = '',
    turns = [],
    options = {},
  } = {}) {
    const audioArtifact = await this.readAudioArtifact(audioArtifactId);
    if (sessionId && audioArtifact.sessionId && String(audioArtifact.sessionId) !== String(sessionId)) {
      throw createServiceError(404, 'Audio artifact not found for this session.', 'audio_artifact_not_found');
    }
    return this.createVideo({
      sessionId,
      title: title || audioArtifact.metadata?.title || audioArtifact.filename || 'Podcast video',
      transcript: transcript || audioArtifact.metadata?.transcript || audioArtifact.extractedText || '',
      turns,
      audioBuffer: audioArtifact.contentBuffer,
      audioMimeType: audioArtifact.mimeType || 'audio/wav',
      options: {
        ...options,
        audioArtifactId,
      },
    });
  }

  async createVideoFromPodcast(podcast = {}, { sessionId, options = {} } = {}) {
    const audioArtifactId = String(podcast?.audio?.artifactId || podcast?.artifact?.id || '').trim();
    if (!audioArtifactId) {
      throw createServiceError(400, 'The podcast result does not include a saved audio artifact.', 'podcast_audio_artifact_required');
    }

    return this.createVideoFromAudioArtifact({
      sessionId,
      audioArtifactId,
      title: podcast.title || podcast.script?.title || 'Podcast video',
      transcript: podcast.script?.transcript || '',
      turns: podcast.script?.turns || [],
      options: {
        topic: podcast.title || '',
        ...options,
      },
    });
  }

  async createPromoClipFromPodcast(podcast = {}, {
    sessionId,
    clip = {},
    brand = null,
    options = {},
  } = {}) {
    const audioArtifactId = String(podcast?.audio?.artifactId || podcast?.artifact?.id || '').trim();
    if (!audioArtifactId) {
      throw createServiceError(400, 'The podcast result does not include a saved audio artifact.', 'podcast_audio_artifact_required');
    }
    const audioArtifact = await this.readAudioArtifact(audioArtifactId);
    if (sessionId && audioArtifact.sessionId && String(audioArtifact.sessionId) !== String(sessionId)) {
      throw createServiceError(404, 'Audio artifact not found for this session.', 'audio_artifact_not_found');
    }
    const startSeconds = Math.max(0, Number(clip.startSeconds) || 0);
    const requestedDuration = Math.max(10, Math.min(30, (Number(clip.endSeconds) || (startSeconds + 24)) - startSeconds));
    const resolvedBrand = brand && typeof brand.then === 'function' ? await brand : (brand || {});
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-promo-clip-'));
    const inputExtension = String(audioArtifact.mimeType || '').includes('mpeg') ? 'mp3' : 'wav';
    const inputPath = path.join(tempDir, `episode.${inputExtension}`);
    const clipPath = path.join(tempDir, 'clip.wav');
    try {
      await fs.writeFile(inputPath, audioArtifact.contentBuffer);
      await this.runFfmpeg([
        '-y',
        '-ss', startSeconds.toFixed(3),
        '-t', requestedDuration.toFixed(3),
        '-i', inputPath,
        '-ar', '48000',
        '-ac', '2',
        clipPath,
      ], {
        timeoutMs: 120000,
        stage: `promo clip audio ${clip.id || ''}`.trim(),
      });
      const clipAudioBuffer = await fs.readFile(clipPath);
      const endCardSeconds = Math.min(3, Math.max(2, requestedDuration * 0.15));
      const captionCard = await buildPromoCardBuffer({
        title: podcast.title || podcast.script?.title || 'Podcast',
        caption: clip.caption || clip.transcript || '',
        callToAction: clip.callToAction || 'Listen to the full episode',
        brand: resolvedBrand,
      });
      const endCard = await buildPromoCardBuffer({
        title: podcast.title || podcast.script?.title || 'Podcast',
        caption: clip.caption || '',
        callToAction: clip.callToAction || 'Listen to the full episode',
        brand: resolvedBrand,
        endCard: true,
      });
      const scenes = [
        {
          id: `${clip.id || 'promo'}-caption`,
          start: 0,
          end: requestedDuration - endCardSeconds,
          duration: requestedDuration - endCardSeconds,
          summary: clip.title || 'Podcast highlight',
          caption: clip.caption || clip.transcript || '',
          imageBuffer: captionCard,
          imageSource: 'branded-caption-card',
        },
        {
          id: `${clip.id || 'promo'}-cta`,
          start: requestedDuration - endCardSeconds,
          end: requestedDuration,
          duration: endCardSeconds,
          summary: clip.callToAction || 'Listen to the full episode',
          caption: clip.callToAction || 'Listen to the full episode',
          imageBuffer: endCard,
          imageSource: 'branded-end-card',
        },
      ];
      const rendered = await this.renderMp4({
        audioBuffer: clipAudioBuffer,
        audioMimeType: 'audio/wav',
        scenes,
        title: `${podcast.title || 'Podcast'} ${clip.title || clip.id || 'promo clip'}`,
        aspectRatio: '9:16',
        imageMode: options.imageMode || 'mixed',
        generateImages: options.generateImages === true,
        renderMode: 'storyboard',
        enhanceAudio: options.enhanceAudio === true,
        visualEffects: options.visualEffects !== false,
        toolManager: options.toolManager,
        toolContext: options.toolContext || {},
      });
      const persisted = await this.persistVideo({
        sessionId,
        title: `${podcast.title || 'Podcast'} ${clip.title || clip.id || 'promo clip'}`,
        videoBuffer: rendered.buffer,
        transcript: clip.transcript || clip.caption || '',
        storyboard: { title: clip.title || 'Promo clip', durationSeconds: requestedDuration, scenes: rendered.scenes },
        metadata: {
          generatedBy: 'podcast-launch-kit-promo',
          clipId: clip.id || null,
          startSeconds,
          endSeconds: startSeconds + requestedDuration,
          burnedInCaptions: true,
          brandedEndCard: true,
          callToAction: clip.callToAction || '',
        },
      });
      return {
        clip: { ...clip, startSeconds, endSeconds: startSeconds + requestedDuration },
        storyboard: { title: clip.title || 'Promo clip', durationSeconds: requestedDuration, scenes: rendered.scenes },
        artifact: persisted.artifact,
        video: persisted.video,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

const podcastVideoService = new PodcastVideoService();

module.exports = {
  PodcastVideoService,
  podcastVideoService,
  buildFallbackStoryboard,
  buildSceneImagePrompt,
  normalizeScene,
  retimeScenesToDuration,
};
